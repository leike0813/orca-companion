/**
 * 集成复验的原 Validator 会话续接测试（change: restore-configurable-execution-concurrency，IP-03）。
 *
 * 覆盖续接判定与 runner 的「必须落在同一条 provider session 上」准入：原 terminal 可复用则复用，已退出
 * 才以精确 UUID resume；缺身份不猜测，结论带回不同 session 时按 session_lost 处理。
 */

import { expect, test } from 'vitest';

import {
  createIntegrationReconciliationRunner,
  decideValidatorSessionContinuity,
  sessionBindingSameProviderSession,
} from '../../../src/adapters/agents/validator-runner.js';
import type {
  IntegrationReconciliationOutcome,
  IntegrationReconciliationRequest,
} from '../../../src/application/integration-reconciliation.js';
import type { SessionBinding } from '../../../src/domain/task-contract.js';

const BINDING: SessionBinding = {
  harness: 'codex',
  role: 'validator',
  workerTaskId: 'task-1',
  dispatchId: 'dispatch-1',
  attemptId: 'validation-attempt-1',
  providerSessionId: 'provider-session-1',
  transcriptRef: '/tmp/transcript.jsonl',
  observedAt: '2026-01-01T00:00:00.000Z',
} as unknown as SessionBinding;

const REQUEST: IntegrationReconciliationRequest = {
  workPackageId: 'wp-1',
  round: 1,
  reconciliationId: 'reconcile-1',
  validationAttemptId: 'validation-attempt-1',
  sourceAcceptedResultRef: 'orca-task-1#abc',
  sessionBinding: BINDING,
  targetHead: 'canonical-head',
  conflictPaths: [],
  worktreePath: '/tmp/wp-1',
  continuation: {
    attemptId: 'attempt',
    taskOperationId: 'task-op' as never,
    existingTaskId: null,
    existingDispatchId: null,
  },
} as unknown as IntegrationReconciliationRequest;

test('原 terminal 可核验则复用，否则以精确 UUID 在原 CODEX_HOME resume', () => {
  expect(
    decideValidatorSessionContinuity({
      liveTerminalVerified: true,
      providerSessionId: 'uuid-1',
      originalCodexHome: '/home/x/.codex',
    }),
  ).toEqual({ kind: 'reuse_live_terminal' });
  expect(
    decideValidatorSessionContinuity({
      liveTerminalVerified: false,
      providerSessionId: 'uuid-1',
      originalCodexHome: '/home/x/.codex',
    }),
  ).toEqual({ kind: 'resume_session', sessionId: 'uuid-1' });
});

test('缺少 provider session 或 CODEX_HOME 时不可续接，不猜测', () => {
  expect(
    decideValidatorSessionContinuity({ liveTerminalVerified: false, providerSessionId: null, originalCodexHome: '/x' }),
  ).toMatchObject({ kind: 'unavailable', code: 'session_not_reported' });
  expect(
    decideValidatorSessionContinuity({ liveTerminalVerified: false, providerSessionId: 'uuid-1', originalCodexHome: null }),
  ).toMatchObject({ kind: 'unavailable', code: 'codex_home_missing' });
});

test('provider session 比较只看 harness 与 providerSessionId，不要求 Dispatch 身份相同', () => {
  expect(sessionBindingSameProviderSession(BINDING, { ...BINDING, dispatchId: 'dispatch-2' as never })).toBe(true);
  expect(
    sessionBindingSameProviderSession(BINDING, { ...BINDING, providerSessionId: 'other' }),
  ).toBe(false);
  expect(sessionBindingSameProviderSession(BINDING, { ...BINDING, harness: 'other' })).toBe(false);
});

test('runner 在可证明 session 读不到时按 session_lost 处理，不继续复验', async () => {
  let channelCalls = 0;
  const runner = createIntegrationReconciliationRunner({
    bindSession: () => Promise.resolve({ kind: 'unavailable', code: 'session_not_reported', message: '无 session' }),
    channel: {
      revalidate: () => {
        channelCalls += 1;
        return Promise.resolve({ kind: 'rejected', reason: '不应到达' });
      },
    },
  });
  await expect(runner(REQUEST)).resolves.toMatchObject({ kind: 'session_lost' });
  expect(channelCalls).toBe(0);
});

test('runner 在观察到的 provider session 与原 session 不同时按 session_lost 处理', async () => {
  let channelCalls = 0;
  const runner = createIntegrationReconciliationRunner({
    bindSession: () => Promise.resolve({ ...BINDING, providerSessionId: 'different' }),
    channel: {
      revalidate: () => {
        channelCalls += 1;
        return Promise.resolve({ kind: 'rejected', reason: '不应到达' });
      },
    },
  });
  await expect(runner(REQUEST)).resolves.toMatchObject({ kind: 'session_lost' });
  expect(channelCalls).toBe(0);
});

test('runner 放行同一 provider session 的复验结论，并拒绝结论里的异 session', async () => {
  const validated: IntegrationReconciliationOutcome = {
    kind: 'validated',
    evidence: [],
    sessionBinding: BINDING,
    orcaTaskId: 'orca-task-9',
    dispatchId: null,
    treeRef: 'a'.repeat(40),
    filesModified: [],
    deliveryId: null,
    deliveryRunId: null,
  };
  const runner = createIntegrationReconciliationRunner({
    bindSession: () => Promise.resolve(BINDING),
    channel: { revalidate: () => Promise.resolve(validated) },
  });
  await expect(runner(REQUEST)).resolves.toEqual(validated);

  const mismatched = createIntegrationReconciliationRunner({
    bindSession: () => Promise.resolve(BINDING),
    channel: {
      revalidate: () =>
        Promise.resolve({ ...validated, sessionBinding: { ...BINDING, providerSessionId: 'other' } }),
    },
  });
  await expect(mismatched(REQUEST)).resolves.toMatchObject({ kind: 'session_lost' });
});

test('runner 把通道异常封成 step_failed 而不是验证通过', async () => {
  const runner = createIntegrationReconciliationRunner({
    bindSession: () => Promise.resolve(BINDING),
    channel: { revalidate: () => Promise.reject(new Error('terminal closed')) },
  });
  await expect(runner(REQUEST)).resolves.toMatchObject({ kind: 'step_failed', code: 'session_channel_failed' });
});
