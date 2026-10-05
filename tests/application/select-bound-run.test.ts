import { expect, test } from 'vitest';
import { selectBoundRun } from '../../src/application/execution/select-bound-run.js';
import type { OperationId } from '../../src/application/dto/identity.js';
import type { ExecutionBackend } from '../../src/application/ports/execution-backend.js';
import { createExecutionScopeHarness } from '../support/execution-harness.js';

test.each(['accepted', 'unknown_proven', 'unknown_unproven', 'definite_failure'] as const)(
  '恢复原 Run 的 %s 保持同一个选择意图，不重复副作用', async (scenario) => {
    const harness = createExecutionScopeHarness();
    let currentRun = 'candidate-run';
    const operations: string[] = [];
    const backend: ExecutionBackend = {
      query: () => Promise.resolve({ kind: 'accepted', value: { run: { runId: currentRun, consumerGeneration: 1 } } }),
      mutate: (_request, scope) => {
        operations.push(scope.operationId);
        if (scenario === 'accepted' || scenario === 'unknown_proven') currentRun = 'original-run';
        if (scenario === 'unknown_proven' || scenario === 'unknown_unproven')
          return Promise.resolve({ kind: 'unknown', operation: { operationId: scope.operationId, target: scope.target, backendRequestId: 'request-run-use' }, reason: 'response lost' });
        return Promise.resolve({ kind: 'accepted', operation: { operationId: scope.operationId, target: scope.target }, value: { ok: scenario !== 'definite_failure' } });
      },
    };
    const input = { store: harness.store, backend, writer: harness.writer, coordinationScopeId: harness.scopeId,
      backendIdentityRef: 'coordinator', runId: 'original-run', operationId: 'select-original-run' as OperationId,
      authority: { kind: 'route_planning' as const }, timeoutMs: 1_000 };
    try {
      const first = await selectBoundRun(input);
      if (scenario === 'unknown_unproven') {
        expect(first.kind).toBe('blocked');
        expect((await selectBoundRun(input)).kind).toBe('blocked');
        currentRun = 'original-run';
        expect((await selectBoundRun(input)).kind).toBe('selected');
      } else {
        expect(first.kind).toBe(scenario === 'definite_failure' ? 'blocked' : 'selected');
        expect((await selectBoundRun(input)).kind).toBe(first.kind);
      }
      expect(operations).toEqual(['select-original-run']);
      const intent = harness.store.query({ kind: 'intent', coordinationScopeId: harness.scopeId, operationId: input.operationId });
      expect(intent.kind === 'intent' && intent.intent).toMatchObject({ state: 'settled',
        outcomeClass: scenario === 'definite_failure' ? 'rejected' : 'accepted' });
    } finally { harness.close(); }
  });
