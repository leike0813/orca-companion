/**
 * IP-5 行为测试：Worker Session Recovery 先尝试精确恢复，且不得凭不完整信息推断退出
 * （change: `m1-recover-execution`）。
 *
 * 覆盖 Requirement「Worker Session Recovery 先尝试精确恢复且不得凭不完整信息推断退出」的三个
 * Scenario：可精确绑定的中断先尝试精确恢复原会话；存活不可判定时保持未决、不推断退出也不重复派发；
 * Coordinator Session 中断不产生 RecoveryId、Session Segment 或 Recovery Capsule。
 *
 * 断言落在稳定语义上：恢复结论、Recovery 记录状态、替代身份是否出现、后端是否收到派发。
 */

import { afterEach, expect, test } from 'vitest';

import { RECOVERY_WORKER_TASK, createRecoveryHarness, type RecoveryHarness } from '../support/recovery-harness.js';
import type { DispatchId, SessionSegmentId } from '../../src/application/dto/identity.js';
import type { TerminalLivenessFacts } from '../../src/domain/worker-liveness.js';
import type { RoleAuthorities } from '../../src/domain/planning/execution-authorization.js';
import type { SpecBinding } from '../../src/domain/task-contract.js';
import {
  verifyWorkerResult,
  resultAdvancesLifecycle,
  type ClaimedResultAttribution,
  type TrustedExecutionFacts,
} from '../../src/domain/worker-result-verification.js';
import {
  RECOVERY_LIFECYCLE_TRANSITIONS,
  decideRecoveryEntry,
  recoveryLifecycleAllows,
} from '../../src/domain/recovery/worker-session-recovery.js';
import { recoverWorkerSession } from '../../src/application/recovery/worker-session-recovery-service.js';

const SOURCE_DISPATCH = 'dispatch-source-1' as DispatchId;
const SOURCE_SEGMENT = 'segment-source-1' as SessionSegmentId;
const SOURCE_BINDING = 'binding-source-1';

const AUTHORITY: RoleAuthorities = {
  planner: true,
  implementation: true,
  validator: true,
  finalizer: true,
  gitIntegration: false,
  dependencyChanges: false,
};

const SPEC_BINDING: SpecBinding = {
  provider: 'openspec',
  relativePath: 'openspec/changes/c/specs/spec.md',
  contentDigest: 'digest-1',
  providerVersion: '0.4.0',
  contractRevision: 1,
  trackingRevision: 1,
};

function trustedFacts(): TrustedExecutionFacts {
  return {
    runId: 'run-recovery',
    consumerGeneration: 1,
    graphGeneration: 1,
    authorizationId: 'auth-recovery',
    workerTaskId: RECOVERY_WORKER_TASK,
    dispatchId: SOURCE_DISPATCH,
    attemptId: 'attempt-1',
    role: 'validator',
    specBinding: SPEC_BINDING,
    worktreeId: 'worktree-recovery-1',
    authority: AUTHORITY,
    scopeEnvelope: { include: ['src'], exclude: [] },
    changedPaths: [],
  };
}

let harness: RecoveryHarness | null = null;

afterEach(() => {
  harness?.close();
  harness = null;
});

function liveFacts(): TerminalLivenessFacts {
  return {
    dispatchId: SOURCE_DISPATCH,
    workerRunning: true,
    terminalHandle: 'terminal-1',
    host: { kind: 'enumerated', terminalHandles: ['terminal-1'] },
  };
}

function unverifiableFacts(): TerminalLivenessFacts {
  return {
    dispatchId: SOURCE_DISPATCH,
    workerRunning: false,
    terminalHandle: 'terminal-1',
    host: { kind: 'not-enumerated' },
  };
}

function recordSource(h: RecoveryHarness, attemptId = 'attempt-1'): void {
  h.recordSourceSegment({
    segmentId: SOURCE_SEGMENT,
    dispatchId: SOURCE_DISPATCH,
    attemptId,
    sessionBindingId: SOURCE_BINDING,
  });
}

test('可精确绑定的中断先尝试精确恢复原会话，不创建替代 Session，也不消耗 Recovery Budget', async () => {
  harness = createRecoveryHarness();
  recordSource(harness);
  const resumeRequests: string[] = [];

  const result = await recoverWorkerSession(
    harness.input({
      sourceSegmentId: SOURCE_SEGMENT,
      sourceDispatchId: SOURCE_DISPATCH,
      observation: {
        sessionBindingId: SOURCE_BINDING,
        providerSessionId: 'provider-session-1',
        identityChanged: false,
      },
      liveness: liveFacts(),
      resumeExact: (request) => {
        resumeRequests.push(request.sessionBindingId);
        return Promise.resolve({ kind: 'resumed', sessionBindingId: request.sessionBindingId });
      },
    }),
  );

  expect(result.kind).toBe('exact_recovery');
  // 第一次尝试就是精确恢复：先核验绑定，再尝试恢复原会话。
  expect(resumeRequests).toEqual([SOURCE_BINDING]);
  const recorded = harness.recoveries();
  expect(recorded).toHaveLength(1);
  expect(recorded[0]?.status).toBe('pending');
  expect(recorded[0]?.replacementDispatchId).toBeNull();
  expect(recorded[0]?.consumedBudget).toBe(0);
  // 没有创建任何替代派发。
  expect(harness.backend.mutations()).toEqual([]);
});

test('存活不可判定时保持未决：不推断退出、不重新派发，重启续办仍用同一 RecoveryId', async () => {
  harness = createRecoveryHarness();
  recordSource(harness);
  let resumeCalls = 0;
  const observation = {
    sessionBindingId: SOURCE_BINDING,
    providerSessionId: 'provider-session-1',
    identityChanged: false,
  };

  const first = await recoverWorkerSession(
    harness.input({
      sourceSegmentId: SOURCE_SEGMENT,
      sourceDispatchId: SOURCE_DISPATCH,
      observation,
      liveness: unverifiableFacts(),
      resumeExact: () => {
        resumeCalls += 1;
        return Promise.resolve({ kind: 'resumed', sessionBindingId: SOURCE_BINDING });
      },
    }),
  );

  expect(first.kind).toBe('unverifiable_hold');
  // 证据不足时不尝试恢复、不推断退出、不派发。
  expect(resumeCalls).toBe(0);
  expect(harness.backend.mutations()).toEqual([]);
  const held = harness.recoveries();
  expect(held).toHaveLength(1);
  expect(held[0]?.status).toBe('pending');
  expect(held[0]?.terminalOutcome).toBeNull();
  expect(held[0]?.replacementDispatchId).toBeNull();

  // 重启后以同一条未完成 Recovery 续办：同一 RecoveryId、同一行、仍不派发。
  harness.reopen();
  const second = await recoverWorkerSession(
    harness.input({
      sourceSegmentId: SOURCE_SEGMENT,
      sourceDispatchId: SOURCE_DISPATCH,
      observation,
      liveness: unverifiableFacts(),
    }),
  );
  expect(second.kind).toBe('unverifiable_hold');
  if (first.kind === 'unverifiable_hold' && second.kind === 'unverifiable_hold') {
    expect(second.recoveryId).toBe(first.recoveryId);
  }
  expect(harness.recoveries()).toHaveLength(1);
  expect(harness.backend.mutations()).toEqual([]);
});

test('Coordinator Session 中断不产生 RecoveryId、Session Segment 或 Recovery Capsule', async () => {
  harness = createRecoveryHarness();
  recordSource(harness);
  const segmentsBefore = harness.segments().length;

  const result = await recoverWorkerSession(
    harness.input({
      subject: 'coordinator_session',
      sourceSegmentId: SOURCE_SEGMENT,
      sourceDispatchId: SOURCE_DISPATCH,
      observation: {
        sessionBindingId: SOURCE_BINDING,
        providerSessionId: 'provider-session-1',
        identityChanged: false,
      },
      liveness: liveFacts(),
    }),
  );

  expect(result.kind).toBe('not_worker_recovery');
  expect(harness.recoveries()).toEqual([]);
  // 不新增 Session Segment，也没有任何派发或 Capsule 提取。
  expect(harness.segments()).toHaveLength(segmentsBefore);
  expect(harness.backend.mutations()).toEqual([]);
});

test('Session Binding 不精确时同样保持未决，不采用存活结论', () => {
  const decision = decideRecoveryEntry({
    subject: 'worker_session',
    role: 'validator',
    binding: {
      role: 'validator',
      workerTaskId: RECOVERY_WORKER_TASK,
      dispatchId: SOURCE_DISPATCH,
      attemptId: 'attempt-1',
      recorded: { sessionBindingId: SOURCE_BINDING, providerSessionId: null, identityChanged: false },
      observed: {
        sessionBindingId: 'binding-other',
        providerSessionId: 'provider-session-1',
        identityChanged: false,
      },
    },
    liveness: {
      dispatchId: SOURCE_DISPATCH,
      workerRunning: false,
      terminalHandle: 'terminal-1',
      host: { kind: 'enumerated', terminalHandles: [] },
    },
  });

  // 即便宿主报告终态，绑定不精确也只能是 unverifiable：那已经不是同一条会话的证据。
  expect(decision.kind).toBe('unverifiable');
  if (decision.kind === 'unverifiable') {
    expect(decision.holdsDispatch).toBe(true);
    expect(decision.phase).toBe('unverifiable');
  }
});

test('内部阶段迁移表只接受登记的迁移，且终态不再推进', () => {
  expect(recoveryLifecycleAllows('observed', 'verified')).toBe(true);
  expect(recoveryLifecycleAllows('verified', 'recovering')).toBe(true);
  expect(recoveryLifecycleAllows('completed', 'recovering')).toBe(false);
  expect(RECOVERY_LIFECYCLE_TRANSITIONS.completed).toEqual([]);
  // failed 对应持久化的 blocked，保留一条补足事实后继续的通路。
  expect(recoveryLifecycleAllows('failed', 'verified')).toBe(true);
});

/**
 * 原 Segment 的迟到结果不是由恢复生命周期自己分类的：它走正常 Delivery，由
 * `verifyWorkerResult` 按 Dispatch 身份判为 `stale_attempt`，因此只补历史。这里断言的就是
 * 那条真实判定，而不是恢复模块里的本地分类器。
 */
test('原 Dispatch 的迟到结果在身份核验处被判为 stale_attempt（只补历史）', () => {
  const trusted: TrustedExecutionFacts = {
    ...trustedFacts(),
    dispatchId: 'dispatch-replacement-1' as DispatchId,
  };
  const claimed: ClaimedResultAttribution = {
    runId: trusted.runId,
    consumerGeneration: trusted.consumerGeneration,
    graphGeneration: trusted.graphGeneration,
    authorizationId: trusted.authorizationId,
    workerTaskId: trusted.workerTaskId,
    // 迟到结果仍自报原 Dispatch / 原 Attempt。
    dispatchId: SOURCE_DISPATCH,
    attemptId: 'attempt-1',
    role: trusted.role,
    specBinding: trusted.specBinding,
    worktreeId: trusted.worktreeId,
  };

  const verification = verifyWorkerResult(claimed, trusted);
  expect(verification.kind).toBe('stale_attempt');
  expect(resultAdvancesLifecycle(verification)).toBe(false);
});
