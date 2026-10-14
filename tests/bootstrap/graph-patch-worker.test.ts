import { expect, test } from 'vitest';

import { beginIntent } from '../../src/application/coordination/intent-service.js';
import type { OperationId } from '../../src/application/dto/identity.js';
import { runGraphPatchPlannerWorker } from '../../src/bootstrap/graph-patch-worker.js';
import { createExecutionScopeHarness, executionModelConfiguration, forbiddenExecutionBackend } from '../support/execution-harness.js';

test.each(['pending_intent', 'basic_profile'] as const)('Graph Patch 准入 %s 时不创建第二个 Task', async (scenario) => {
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
      store: scenario === 'basic_profile' ? {
        transact: command => harness.store.transact(command),
        query: query => {
          const read = harness.store.query(query);
          return read.kind === 'authorization' && read.authorization !== null ? {
            ...read, authorization: { ...read.authorization, manifest: {
              ...read.authorization.manifest,
              workerProfiles: read.authorization.manifest.workerProfiles.map(profile =>
                profile.role === 'planner' ? { ...profile, supportLevel: 'basic' as const } : profile),
            } },
          } : read;
        },
      } : harness.store,
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
          changeInstruction: '移除不再需要的工作包',
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
      harness: 'codex',
      modelSelection: executionModelConfiguration({ model: 'test-model' }),
      bindingWindowMs: 1_000, reportTimeoutMs: 1_000,
    });
    expect(result.kind).toBe(scenario === 'basic_profile' ? 'rejected' : 'unknown');
    if (result.kind === 'rejected') expect(result.code).toBe('worker_support_insufficient');
    expect(calls).toEqual({ query: 0, mutate: 0 });
  } finally {
    harness.close();
  }
});
