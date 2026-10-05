/**
 * 共享 Utility Worker 派发的恢复回归（change: restore-configurable-execution-concurrency，IP-03）。
 *
 * 覆盖「绑定晚到（observeSession 首次为 null）→ 重试复用已 accepted 的 exact terminal/Task ctx」：
 * 重放绝不重发 terminal-create / worker-start / terminal-submit，第二次真实 facts 就绪后按原身份 dispatched。
 */

import { expect, test } from 'vitest';

import { dispatchScopedWorker } from '../../../src/adapters/agents/utility-worker.js';
import type { HarnessSessionFacts } from '../../../src/adapters/agents/session-binding.js';
import type { DispatchId, OperationId, WorkPackageId, WorkerTaskId } from '../../../src/application/dto/identity.js';
import type { ExecutionBackend, ExecutionMutation, ExecutionQuery } from '../../../src/application/ports/execution-backend.js';
import { createExecutionScopeHarness, EXECUTION_AUTHORIZATION_ID, EXECUTION_RUN_ID } from '../../support/execution-harness.js';

type Call =
  | { readonly kind: 'query'; readonly operation: ExecutionQuery['operation'] }
  | { readonly kind: 'mutate'; readonly operation: ExecutionMutation };

test('绑定晚到后重试复用 exact terminal/Task：不重发 create/start/submit', async () => {
  const harness = createExecutionScopeHarness();
  const calls: Call[] = [];
  let terminalCreated = false;
  const mutates = (operation: ExecutionMutation['operation']): number =>
    calls.filter((call) => call.kind === 'mutate' && call.operation.operation === operation).length;

  const backend: ExecutionBackend = {
    query: (query: ExecutionQuery) => {
      calls.push({ kind: 'query', operation: query.operation });
      if (query.operation === 'terminal-list') {
        return Promise.resolve({ kind: 'accepted', value: {
          terminals: terminalCreated ? [{ handle: 'term-1', connected: true, writable: true, title: 'title-1' }] : [],
          hostIds: ['local'], omittedHostIds: [], totalCount: terminalCreated ? 1 : 0, truncated: false,
        } });
      }
      if (query.operation === 'terminal-wait') return Promise.resolve({ kind: 'accepted', value: { state: 'tui-idle' } });
      if (query.operation === 'terminal-read') return Promise.resolve({ kind: 'accepted', value: { terminal: { draft: '[Pasted Content]' } } });
      if (query.operation === 'worker-show') {
        return Promise.resolve({ kind: 'accepted', value: { dispatchId: 'disp-1', exactWorker: true, agentTerminalHandle: 'term-1' } });
      }
      if (query.operation === 'worker-list') {
        return Promise.resolve({ kind: 'accepted', value: { workers: [{ taskId: 'orca-task-1', dispatchId: 'disp-1', workerState: 'running' }] } });
      }
      return Promise.resolve({ kind: 'rejected', code: 'unregistered_query', message: query.operation });
    },
    mutate: (mutation: ExecutionMutation, scope) => {
      calls.push({ kind: 'mutate', operation: mutation });
      if (mutation.operation === 'terminal-create') terminalCreated = true;
      const value =
        mutation.operation === 'task-create' ? { id: 'orca-task-1' }
          : mutation.operation === 'terminal-create' ? { handle: 'term-1' }
            : mutation.operation === 'worker-start' ? { dispatchId: 'disp-1' }
              : null;
      return Promise.resolve({ kind: 'accepted', operation: { operationId: scope.operationId, target: scope.target }, value });
    },
  };

  const workerTaskId = 'sub:integration-reconciliation-attempt:round-1' as WorkerTaskId;
  const operationIds = {
    task: 'op-task' as OperationId,
    workerPrepare: 'op-prepare' as OperationId,
    workerStart: 'op-start' as OperationId,
    workerActivate: 'op-activate' as OperationId,
  };
  const baseInput = {
    store: harness.store,
    backend,
    writer: harness.writer,
    coordinationScopeId: harness.scopeId,
    execution: {
      backendIdentityRef: 'coordinator', graphGeneration: harness.generation,
      authorizationId: EXECUTION_AUTHORIZATION_ID, runId: EXECUTION_RUN_ID, consumerGeneration: 1, timeoutMs: 5_000,
    },
    workPackageId: 'wp-1' as WorkPackageId,
    spec: JSON.stringify({ schemaVersion: 1, kind: 'test' }),
    workerLaunch: {
      kind: 'prepared_terminal' as const,
      harness: 'codex',
      activation: 'submit_draft' as const,
      title: 'title-1',
      prepare: () => Promise.resolve({ title: 'title-1', command: 'codex-launch' }),
    },
    worktree: 'path:/tmp/wt',
    operationIds,
  };

  // 第一次：observeSession 为 null（绑定晚到）→ binding_unavailable；此前 create/start/submit 均已 accepted。
  const lateFacts: HarnessSessionFacts | null = null;
  const first = await dispatchScopedWorker({
    ...baseInput,
    observeSession: () => Promise.resolve(lateFacts),
  });
  expect(first.kind).toBe('binding_unavailable');
  expect(mutates('terminal-create')).toBe(1);
  expect(mutates('worker-start')).toBe(1);
  expect(mutates('terminal-submit')).toBe(1);

  // 第二次：Task 已绑定走 existingOrcaTaskId；facts 就绪 → 重放不重发任何 mutation，最终 dispatched。
  const realFacts: HarnessSessionFacts = {
    harness: 'codex',
    role: 'validator',
    workerTaskId,
    dispatchId: 'disp-1' as DispatchId,
    attemptId: 'attempt-1',
    providerSessionId: 'provider-1',
    transcriptRef: '/tmp/transcript.jsonl',
    observedAt: '2026-10-05T08:00:00.000Z',
  };
  const second = await dispatchScopedWorker({
    ...baseInput,
    existingOrcaTaskId: 'orca-task-1',
    observeSession: () => Promise.resolve(realFacts),
  });
  expect(second.kind).toBe('dispatched');
  expect(mutates('terminal-create')).toBe(1);
  expect(mutates('worker-start')).toBe(1);
  expect(mutates('terminal-submit')).toBe(1);

  harness.close();
});
