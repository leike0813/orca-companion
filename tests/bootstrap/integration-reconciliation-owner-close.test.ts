/**
 * owner-close 恢复行为最小回归（change: restore-configurable-execution-concurrency，IP-03）。
 *
 * 只通过 runner 的可观察结果与 mutation 计数验证：缺精确原 owner 证明时必须 fail closed，
 * 绝不在未释放原会话前 resume；不新增 production export。
 */

import { expect, test } from 'vitest';
import { dirname } from 'node:path';

import { createIntegrationReconciliationRuntime } from '../../src/bootstrap/integration-reconciliation-runtime.js';
import type { IntegrationReconciliationRequest } from '../../src/application/integration-reconciliation.js';
import { branchIntegrationReconciliationStore } from '../../src/application/integration-reconciliation.js';
import type {
  DispatchId,
  OperationId,
  WorkPackageId,
  WorkerTaskId,
} from '../../src/application/dto/identity.js';
import type { ExecutionBackend, ExecutionMutation } from '../../src/application/ports/execution-backend.js';
import type { SessionBinding } from '../../src/domain/task-contract.js';
import { createExecutionScopeHarness, EXECUTION_AUTHORIZATION_ID, EXECUTION_RUN_ID } from '../support/execution-harness.js';
import { credentialStoreFixture, modelConfigurationFixture } from '../support/model-configurations.js';

const BINDING: SessionBinding = {
  harness: 'codex',
  role: 'validator',
  workerTaskId: 'task-orig' as WorkerTaskId,
  dispatchId: 'ctx-orig' as DispatchId,
  attemptId: 'validation-1',
  providerSessionId: 'provider-1',
  transcriptRef: '/tmp/orig-transcript.jsonl',
  observedAt: '2026-10-05T08:00:00.000Z',
};

const REQUEST: IntegrationReconciliationRequest = {
  workPackageId: 'wp-1' as WorkPackageId,
  round: 1,
  reconciliationId: 'reconcile-1',
  validationAttemptId: 'validation-1',
  sourceAcceptedResultRef: 'orca-task-1#accepted',
  sessionBinding: BINDING,
  targetHead: 'a'.repeat(40),
  conflictPaths: [],
  worktreePath: '/tmp/wt',
  continuation: {
    attemptId: 'attempt-1',
    taskOperationId: 'op-task' as OperationId,
    existingTaskId: null,
    existingDispatchId: null,
  },
};

test.each([
  { name: '缺少原 owner', owner: false, workerState: 'succeeded', idle: true, unknown: false, closes: 0 },
  { name: 'Worker 仍运行，即使 Dispatch 完成', owner: true, workerState: 'running', idle: true, unknown: false, closes: 0 },
  { name: 'idle 等待未满足', owner: true, workerState: 'succeeded', idle: false, unknown: false, closes: 0 },
  { name: '已关闭后重放不重复关闭', owner: true, workerState: 'succeeded', idle: true, unknown: false, closes: 1 },
  { name: '响应丢失后按原意图对账', owner: true, workerState: 'succeeded', idle: true, unknown: true, closes: 1 },
])('$name', async (scenario) => {
  const harness = createExecutionScopeHarness();
  const mutations: ExecutionMutation[] = [];
  let closed = false;
  const backend: ExecutionBackend = {
    query: (query) => {
      if (query.operation === 'worker-show') return Promise.resolve({ kind: 'accepted', value: {
        dispatchId: 'ctx-orig', taskId: 'task-orig', agentTerminalHandle: 'term-orig',
        exactWorker: true, workerState: scenario.workerState, dispatchStatus: 'completed',
      } });
      if (query.operation === 'terminal-wait') return Promise.resolve({ kind: 'accepted', value: { wait: { satisfied: scenario.idle } } });
      if (query.operation === 'terminal-show') return Promise.resolve({ kind: 'accepted', value: {
        handle: 'term-orig', connected: !closed, writable: !closed,
      } });
      return Promise.resolve({ kind: 'rejected', code: 'unexpected_query', message: query.operation });
    },
    mutate: (mutation, scope) => {
      mutations.push(mutation);
      if (mutation.operation === 'terminal-close') {
        if (scenario.unknown) return Promise.resolve({ kind: 'unknown', operation: { operationId: scope.operationId, target: scope.target }, reason: 'response_lost' });
        closed = true;
        return Promise.resolve({ kind: 'accepted', operation: { operationId: scope.operationId, target: scope.target }, value: {} });
      }
      return Promise.resolve({ kind: 'rejected', code: 'acceptance_stop_after_close', message: mutation.operation });
    },
  };
  const runner = createIntegrationReconciliationRuntime({
    store: harness.store,
    backend,
    writer: harness.writer,
    coordinationScopeId: harness.scopeId,
    reconciliationStore: branchIntegrationReconciliationStore(harness.store),
    execution: {
      backendIdentityRef: 'coordinator',
      graphGeneration: harness.generation,
      authorizationId: EXECUTION_AUTHORIZATION_ID,
      runId: EXECUTION_RUN_ID,
      consumerGeneration: 1,
      timeoutMs: 5_000,
    },
    originalBinding: BINDING,
    ...(scenario.owner ? { originalOwner: { dispatchId: BINDING.dispatchId, terminalHandle: 'term-orig' } } : {}),
    originalCodexHome: '/tmp/orig-codex-home',
    modelConfiguration: modelConfigurationFixture(),
    credentialStore: credentialStoreFixture(),
    credentialStorePath: '/tmp/credentials.json',
    sandboxMode: 'danger-full-access',
    companionStateRoot: dirname(harness.databasePath),
    canonicalWorktreePath: '/tmp/canonical',
    originalMaterializationBinding: { launchId: 'orig-launch' },
    workPackage: { workPackageId: 'wp-1', scopeEnvelope: { include: ['src'], exclude: [] } },
    bindingWindowMs: 1_000,
    resultTimeoutMs: 1_000,
  });
  try {
    const first = await runner(REQUEST);
    expect(first.kind).toBe('step_failed');
    if (first.kind === 'step_failed') expect(first.code).toBe(
      scenario.closes === 0 || scenario.unknown ? 'owner_release_blocked' : 'acceptance_stop_after_close',
    );
    expect(mutations.filter(mutation => mutation.operation === 'terminal-close')).toHaveLength(scenario.closes);
    if (scenario.closes > 0) {
      closed = true;
      const replay = await runner(REQUEST);
      expect(replay.kind).toBe('step_failed');
      if (replay.kind === 'step_failed') expect(replay.code).not.toBe('owner_release_blocked');
      expect(mutations.filter(mutation => mutation.operation === 'terminal-close')).toHaveLength(1);
      const read = harness.store.query({ kind: 'intent', coordinationScopeId: harness.scopeId,
        operationId: 'integration-reconciliation-owner-close:reconcile-1' as OperationId });
      expect(read.kind === 'intent' ? read.intent : null).toMatchObject({ state: 'settled', outcomeClass: 'accepted' });
    } else expect(mutations).toHaveLength(0);
  } finally { harness.close(); }
});
