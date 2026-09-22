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
