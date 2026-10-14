import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { driveBaselineWorker } from '../../src/adapters/agents/baseline-worker.js';
import { workPackageComment } from '../../src/application/materialize-work-package.js';
import { planBaselineReconciliation, recordBaselineReconciliation } from '../../src/application/execution/baseline-reconciliation.js';
import type { DispatchId, OperationId, WorkerTaskId, WorkPackageId } from '../../src/application/dto/identity.js';
import type { ExecutionBackend, ExecutionMutation } from '../../src/application/ports/execution-backend.js';
import { createExecutionScopeHarness, EXECUTION_AUTHORIZATION_ID, EXECUTION_RUN_ID, type ExecutionScopeHarness } from '../support/execution-harness.js';

const workPackageId = 'wp-b' as WorkPackageId;
let harness: ExecutionScopeHarness;
let directory = '';

beforeEach(() => { harness = createExecutionScopeHarness(); });
afterEach(() => {
  harness.close();
  if (directory.length > 0) rmSync(directory, { recursive: true, force: true });
  directory = '';
});

test('落后基线派发独立 Planner Task，重放不重复派发；Accepted Result 与现场 Git 均通过后才解除门禁', async () => {
  directory = mkdtempSync(join(tmpdir(), 'baseline-worker-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Verification');
  git('config', 'user.email', 'verification@example.invalid');
  mkdirSync(join(directory, 'src'));
  writeFileSync(join(directory, 'src', 'feature.ts'), 'export const value = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'baseline');
  const requiredBaselineHead = git('rev-parse', 'HEAD');
  const planned = planBaselineReconciliation({ workPackageId, requiredBaselineHead, worktreeBaseHead: 'base-1', relation: 'behind' });
  if (planned.kind !== 'required') throw new Error('测试基线未落后');
  const plan = planned.plan;
  expect(recordBaselineReconciliation({ store: harness.store, coordinationScopeId: harness.scopeId, writer: harness.writer, plan }).kind).toBe('recorded');
  const mutations: ExecutionMutation[] = [];
  const backend: ExecutionBackend = {
    query: (query) => Promise.resolve(query.operation === 'worktree-list'
      ? { kind: 'accepted' as const, value: { worktrees: [{
        worktreeId: 'wt-wp-b', path: directory, branch: 'wp-b', head: requiredBaselineHead,
        displayName: 'wp-b', comment: workPackageComment(workPackageId), isMainWorktree: false,
      }], totalCount: 1, truncated: false, hostScope: { hostIds: ['local'], omittedHostIds: [] } } }
      : { kind: 'rejected' as const, code: 'unexpected_query', message: query.operation }),
    mutate: (mutation, scope) => {
      mutations.push(mutation);
      return Promise.resolve({ kind: 'accepted' as const, operation: { operationId: scope.operationId, target: scope.target },
        value: mutation.operation === 'task-create' ? { id: 'orca-baseline-task' }
          : mutation.operation === 'worker-start' ? { dispatchId: 'baseline-dispatch' } : null });
    },
  };
  const input = {
    store: harness.store, backend, writer: harness.writer, coordinationScopeId: harness.scopeId,
    plan,
    repoSelector: 'path:/work', canonicalWorktree: '/work', worktree: 'wt-wp-b',
    execution: { backendIdentityRef: 'coordinator', graphGeneration: 1, authorizationId: EXECUTION_AUTHORIZATION_ID,
      runId: EXECUTION_RUN_ID, consumerGeneration: 1, timeoutMs: 30_000 },
    workerLaunch: { kind: 'orca_managed' as const, agent: 'codex' },
    operationIds: { task: 'baseline-task' as OperationId, workerPrepare: 'baseline-prepare' as OperationId,
      workerStart: 'baseline-start' as OperationId, workerActivate: 'baseline-activate' as OperationId },
    observeSession: (dispatchId: string) => Promise.resolve({
      harness: 'codex', role: 'planner' as const, workerTaskId: plan.reconciliationId as WorkerTaskId,
      dispatchId: dispatchId as DispatchId, attemptId: 'attempt-1', providerSessionId: 'codex-session-1',
      transcriptRef: 'transcript-1', observedAt: new Date().toISOString(),
    }),
  };
  const dispatched = await driveBaselineWorker(input);
  expect(dispatched.kind).toBe('dispatched');
  expect(mutations.map((entry) => entry.operation)).toEqual(['task-create', 'worker-start']);
  const record = harness.store.query({ kind: 'baseline-reconciliations', coordinationScopeId: harness.scopeId, workPackageId });
  expect(record.kind === 'baseline-reconciliations' ? record.reconciliations[0]?.orcaTaskId : null).toBe('orca-baseline-task');
  expect(record.kind === 'baseline-reconciliations' ? record.reconciliations[0]?.dispatchId : null).toBe('baseline-dispatch');
  expect((await driveBaselineWorker(input)).kind).toBe('waiting');
  expect(mutations).toHaveLength(2);
  const scope = harness.store.query({ kind: 'scope', coordinationScopeId: harness.scopeId });
  if (scope.kind !== 'scope' || scope.scope === null) throw new Error('Scope 缺失');
  const accepted = harness.store.transact({
    kind: 'record-delivery-settlement', coordinationScopeId: harness.scopeId,
    expectedRevision: scope.scope.revision, writer: harness.writer,
    dedupeKey: 'baseline-delivery', deliveryId: 'delivery-baseline', runId: EXECUTION_RUN_ID,
    consumerGeneration: 1, workerTaskId: plan.reconciliationId as WorkerTaskId,
    dispatchId: 'baseline-dispatch' as DispatchId, attemptId: 'attempt-1', role: 'planner',
    contractRevision: 1, orcaResultRef: 'orca-baseline-task#accepted',
  });
  expect(accepted.kind).toBe('committed');
  expect((await driveBaselineWorker(input)).kind).toBe('verified');
});

test('v5 basic 的非 Codex Planner：按授权 profile 的 harness 派发，只用 Orca 归属不要求原生 Session', async () => {
  directory = mkdtempSync(join(tmpdir(), 'baseline-worker-basic-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Verification');
  git('config', 'user.email', 'verification@example.invalid');
  writeFileSync(join(directory, 'README.md'), '# basic\n');
  git('add', '.');
  git('commit', '-qm', 'baseline');
  const requiredBaselineHead = git('rev-parse', 'HEAD');
  const planned = planBaselineReconciliation({ workPackageId, requiredBaselineHead, worktreeBaseHead: 'base-1', relation: 'behind' });
  if (planned.kind !== 'required') throw new Error('测试基线未落后');
  const plan = planned.plan;
  expect(recordBaselineReconciliation({ store: harness.store, coordinationScopeId: harness.scopeId, writer: harness.writer, plan }).kind).toBe('recorded');

  // 已批准 profile 是 basic 的非 Codex harness：原授权决定身份模式，调用方不能自行降级。
  const approval = harness.authorization();
  const scopeBefore = harness.store.query({ kind: 'scope', coordinationScopeId: harness.scopeId });
  if (scopeBefore.kind !== 'scope' || scopeBefore.scope === null) throw new Error('Scope 缺失');
  const recorded = harness.store.transact({
    kind: 'record-authorization', coordinationScopeId: harness.scopeId, expectedRevision: scopeBefore.scope.revision,
    writer: harness.writer, authorizationId: 'auth-basic', authorizationVersion: 2,
    manifestVersion: approval.manifest.manifestVersion, fingerprint: 'fingerprint-basic', approvalRef: 'approval-basic',
    manifest: {
      ...approval.manifest,
      workerProfiles: approval.manifest.workerProfiles.map((profile) => profile.role === 'planner'
        ? { ...profile, harness: 'claude', supportLevel: 'basic' as const, qualificationRef: 'fixture:basic' }
        : profile),
    },
  });
  expect(recorded.kind).toBe('committed');
  const scopeAfter = harness.store.query({ kind: 'scope', coordinationScopeId: harness.scopeId });
  const activeAuthorizationId = scopeAfter.kind === 'scope' && scopeAfter.scope !== null ? scopeAfter.scope.authorizationId : null;
  if (activeAuthorizationId !== 'auth-basic') throw new Error('测试前置：新授权未成为当前授权');

  let sessionObservations = 0;
  const backend: ExecutionBackend = {
    query: (query) => {
      if (query.operation === 'worktree-list') {
        return Promise.resolve({ kind: 'accepted' as const, value: { worktrees: [{
          worktreeId: 'wt-wp-b', path: directory, branch: 'wp-b', head: requiredBaselineHead,
          displayName: 'wp-b', comment: workPackageComment(workPackageId), isMainWorktree: false,
        }], totalCount: 1, truncated: false, hostScope: { hostIds: ['local'], omittedHostIds: [] } } });
      }
      if (query.operation === 'terminal-list') {
        return Promise.resolve({ kind: 'accepted' as const, value: { terminals: [{ handle: 'term-basic', connected: true, writable: true, title: 'basic-title' }], hostIds: ['local'], omittedHostIds: [], totalCount: 1, truncated: false } });
      }
      if (query.operation === 'terminal-wait') {
        return Promise.resolve({ kind: 'accepted' as const, value: { wait: { handle: query.terminal, condition: 'tui-idle', status: 'running', satisfied: true } } });
      }
      if (query.operation === 'terminal-read') {
        return Promise.resolve({ kind: 'accepted' as const, value: { terminal: { draft: '[Pasted Content]' } } });
      }
      if (query.operation === 'worker-show') {
        return Promise.resolve({ kind: 'accepted' as const, value: {
          dispatchId: 'baseline-dispatch', taskId: 'orca-baseline-task', exactWorker: true, agentTerminalHandle: 'term-basic',
        } });
      }
      return Promise.resolve({ kind: 'rejected' as const, code: 'unexpected_query', message: query.operation });
    },
    mutate: (mutation, scope) => {
      const value = mutation.operation === 'task-create' ? { id: 'orca-baseline-task' }
        : mutation.operation === 'terminal-create' ? { handle: 'term-basic' }
          : mutation.operation === 'worker-start' ? { dispatchId: 'baseline-dispatch' }
            : null;
      return Promise.resolve({ kind: 'accepted' as const, operation: { operationId: scope.operationId, target: scope.target }, value });
    },
  };
  const input = {
    store: harness.store, backend, writer: harness.writer, coordinationScopeId: harness.scopeId,
    plan, repoSelector: 'path:/work', canonicalWorktree: '/work', worktree: 'wt-wp-b',
    execution: { backendIdentityRef: 'coordinator', graphGeneration: 1, authorizationId: 'auth-basic',
      runId: EXECUTION_RUN_ID, consumerGeneration: 1, timeoutMs: 30_000 },
    workerLaunch: { kind: 'prepared_terminal' as const, harness: 'claude', activation: 'submit_draft' as const,
      title: 'basic-title', prepare: () => Promise.resolve({ title: 'basic-title', command: 'claude-launch' }) },
    operationIds: { task: 'basic-task' as OperationId, workerPrepare: 'basic-prepare' as OperationId,
      workerStart: 'basic-start' as OperationId, workerActivate: 'basic-activate' as OperationId },
    observeSession: () => { sessionObservations += 1; return Promise.resolve(null); },
  };
  const dispatched = await driveBaselineWorker(input);
  expect(dispatched.kind).toBe('dispatched');
  expect(sessionObservations).toBe(0);
  const record = harness.store.query({ kind: 'baseline-reconciliations', coordinationScopeId: harness.scopeId, workPackageId });
  const row = record.kind === 'baseline-reconciliations' ? record.reconciliations[0] : undefined;
  expect(row?.orcaTaskId).toBe('orca-baseline-task');
  expect(row?.dispatchId).toBe('baseline-dispatch');
});
