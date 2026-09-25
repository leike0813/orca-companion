import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { createBaselineReconciliationDriver } from '../../src/bootstrap/baseline-reconciliation-runtime.js';
import { recordBaselineReconciliation, planBaselineReconciliation } from '../../src/application/execution/baseline-reconciliation.js';
import { workPackageComment } from '../../src/application/materialize-work-package.js';
import type { DispatchId, WorkPackageId } from '../../src/application/dto/identity.js';
import type { ExecutionBackend } from '../../src/application/ports/execution-backend.js';
import { createExecutionScopeHarness, EXECUTION_AUTHORIZATION_ID, EXECUTION_RUN_ID } from '../support/execution-harness.js';

test('独立基线 Planner 的 Delivery 先结算再解除补救门禁，重放不重新派发', async () => {
  const harness = createExecutionScopeHarness();
  const directory = mkdtempSync(join(tmpdir(), 'baseline-runtime-'));
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.name', 'Verification');
    git('config', 'user.email', 'verification@example.invalid');
    mkdirSync(join(directory, 'src'));
    writeFileSync(join(directory, 'src', 'feature.ts'), 'export const value = 1;\n');
    git('add', '.');
    git('commit', '-qm', 'baseline');
    const head = git('rev-parse', 'HEAD');
    const workPackageId = 'wp-b' as WorkPackageId;
    const planned = planBaselineReconciliation({
      workPackageId, requiredBaselineHead: head, worktreeBaseHead: 'old-head', relation: 'behind',
    });
    if (planned.kind !== 'required') throw new Error('测试前置：需要基线补救');
    const plan = planned.plan;
    expect(recordBaselineReconciliation({
      store: harness.store, coordinationScopeId: harness.scopeId, writer: harness.writer, plan,
    }).kind).toBe('recorded');
    const bound = harness.store.transact({
      kind: 'bind-baseline-reconciliation-task', coordinationScopeId: harness.scopeId,
      expectedRevision: harness.revision(), writer: harness.writer,
      reconciliationId: plan.reconciliationId,
      orcaTaskId: 'task-baseline', dispatchId: 'dispatch-baseline' as DispatchId,
    });
    expect(bound.kind).toBe('committed');
    const worktree = {
      worktreeId: 'wt-baseline', path: directory, branch: 'baseline', head,
      displayName: 'baseline', comment: workPackageComment(workPackageId), isMainWorktree: false,
    };
    let taskResult: unknown = null;
    let acknowledged = false;
    const mutations: string[] = [];
    const backend: ExecutionBackend = {
      query: (query) => {
        if (query.operation === 'worktree-list') return Promise.resolve({ kind: 'accepted', value: {
          worktrees: [worktree], totalCount: 1, truncated: false,
          hostScope: { hostIds: ['local'], omittedHostIds: [] },
        } });
        if (query.operation === 'delivery-read') return Promise.resolve({ kind: 'accepted', value: acknowledged
          ? { delivery: null, messages: [], timedOut: false, cancelled: false }
          : { delivery: { deliveryId: 'delivery-baseline', runId: EXECUTION_RUN_ID }, messages: [{
              messageId: 'message-baseline', runId: EXECUTION_RUN_ID, deliveryContract: 'current_delivery',
              fromHandle: 'worker', toHandle: 'coordinator', type: 'worker_done', subject: null,
              priority: null, body: 'baseline reconciled',
              payload: JSON.stringify({ taskId: 'task-baseline', dispatchId: 'dispatch-baseline', outcome: 'succeeded', filesModified: [] }),
            }], timedOut: false, cancelled: false } });
        if (query.operation === 'task-list') return Promise.resolve({ kind: 'accepted', value: {
          tasks: [{ id: 'task-baseline', status: taskResult === null ? 'in_progress' : 'completed', result: taskResult }],
        } });
        return Promise.resolve({ kind: 'rejected', code: 'unexpected_query', message: query.operation });
      },
      mutate: (mutation, scope) => {
        mutations.push(mutation.operation);
        if (mutation.operation === 'task-update') taskResult = mutation.result;
        if (mutation.operation === 'delivery-ack') acknowledged = true;
        return Promise.resolve({ kind: 'accepted', operation: { operationId: scope.operationId, target: scope.target }, value: {} });
      },
    };
    const driver = createBaselineReconciliationDriver({
      store: harness.store, backend, writer: harness.writer, coordinationScopeId: harness.scopeId,
      execution: {
        backendIdentityRef: 'coordinator', graphGeneration: 1,
        authorizationId: EXECUTION_AUTHORIZATION_ID, runId: EXECUTION_RUN_ID,
        consumerGeneration: 1, timeoutMs: 1_000,
      },
      canonicalWorktreePath: '/work', repoSelector: 'path:/work',
      worktreePaths: new Map([[workPackageId, directory]]), workerModel: 'test-model',
      codexSandboxMode: 'danger-full-access', companionStateRoot: join(directory, '.git', 'companion'), bindingWindowMs: 1_000,
    });
    expect(await driver(plan)).toEqual({ kind: 'verified' });
    expect(mutations).toEqual(['task-update', 'delivery-ack']);
    expect(acknowledged).toBe(true);
    expect((await driver(plan)).kind).toBe('verified');
    expect(mutations).toEqual(['task-update', 'delivery-ack']);
  } finally {
    harness.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
