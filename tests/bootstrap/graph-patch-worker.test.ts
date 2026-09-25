import { expect, test } from 'vitest';

import { beginIntent } from '../../src/application/coordination/intent-service.js';
import type { OperationId } from '../../src/application/dto/identity.js';
import { runGraphPatchPlannerWorker } from '../../src/bootstrap/graph-patch-worker.js';
import { createExecutionScopeHarness, forbiddenExecutionBackend } from '../support/execution-harness.js';

test('Planner Task 意图未决时沿原身份阻塞，不创建第二个 Task', async () => {
  const harness = createExecutionScopeHarness();
  try {
    const operationId = 'op:graph-patch:test' as OperationId;
    const begun = beginIntent(harness.store, {
      coordinationScopeId: harness.scopeId,
      operationId: `${operationId}:task` as OperationId,
      target: { kind: 'work-package', id: 'patch-test' },
      operationCategory: 'task-create',
      writer: harness.writer,
      expectedRevision: harness.revision(),
    });
    expect(begun.kind).toBe('registered');
    const { backend, calls } = forbiddenExecutionBackend();
    const result = await runGraphPatchPlannerWorker({
      store: harness.store,
      backend,
      writer: harness.writer,
      request: {
        coordinationScopeId: harness.scopeId,
        graphId: harness.graphId,
        baseGraphVersion: harness.currentGraph().version,
        patchId: 'patch-test',
        operationId,
        changeRequest: {
          workPackageId: null,
          infrastructureFailure: 'unknown', changesDependencies: 'unknown', changesScopeEnvelope: 'unknown',
          changesObjective: 'unknown', contractContentOnly: 'unknown', goalOrGlobalConstraintChanged: 'no',
          userRequestedReplanning: 'no', requiresUserChoice: 'no',
        },
        currentGraph: harness.currentGraph().graph,
        affectedWorkPackageIds: [],
        unacceptedDescendantIds: [],
      },
      execution: {
        backendIdentityRef: 'dedicated-identity', graphGeneration: 1,
        authorizationId: harness.authorization().authorizationId,
        runId: 'run-1', consumerGeneration: 1, timeoutMs: 1_000,
      },
      canonicalWorktreePath: '/tmp/unused', companionStateRoot: '/tmp/unused',
      workerModel: 'test-model', bindingWindowMs: 1_000, reportTimeoutMs: 1_000,
    });
    expect(result.kind).toBe('unknown');
    expect(calls).toEqual({ query: 0, mutate: 0 });
  } finally {
    harness.close();
  }
});
