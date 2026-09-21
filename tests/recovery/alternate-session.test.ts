/**
 * IP-7 行为测试：替代 Session 保留业务身份但创建新 Dispatch 与 Segment
 * （change: `m1-recover-execution`）。
 *
 * 覆盖 Requirement「替代 Session 保留业务身份但创建新 Dispatch 与 Segment」的三个 Scenario：替代
 * Session 完成时保留 Worker Task / contract / revision / 业务 Attempt；替代派发前原会话到达有效
 * 终态时以该终态结束并 supersede 原 Segment；superseded 原 Segment 的迟到结果只入历史。
 */

import { afterEach, expect, test } from 'vitest';

import {
  RECOVERY_AUTHORIZATION,
  RECOVERY_SCOPE,
  RECOVERY_WORKER_TASK,
  RECOVERY_WORK_PACKAGE,
  createRecoveryHarness,
  type RecoveryHarness,
} from '../support/recovery-harness.js';
import type { DispatchId, SessionSegmentId } from '../../src/application/dto/identity.js';
import type { TerminalLivenessFacts } from '../../src/domain/worker-liveness.js';
import type { RoleAuthorities } from '../../src/domain/planning/execution-authorization.js';
import type { SpecBinding } from '../../src/domain/task-contract.js';
import {
  resultAdvancesLifecycle,
  verifyWorkerResult,
  type TrustedExecutionFacts,
} from '../../src/domain/worker-result-verification.js';
import type { CapsuleExtractionOutcome } from '../../src/application/recovery/recovery-capsule.js';
import {
  concludeWorkerSessionRecovery,
  deriveReplacementSegmentId,
  recoverWorkerSession,
} from '../../src/application/recovery/worker-session-recovery-service.js';

const ORCA_TASK = 'orca-task-recovery';
const SOURCE_DISPATCH = 'dispatch-source-1' as DispatchId;
const SOURCE_SEGMENT = 'segment-source-1' as SessionSegmentId;
const SOURCE_BINDING = 'binding-source-1';
const ATTEMPT = 'attempt-1';

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
    authorizationId: RECOVERY_AUTHORIZATION,
    workerTaskId: RECOVERY_WORKER_TASK,
    dispatchId: SOURCE_DISPATCH,
    attemptId: ATTEMPT,
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

function exitedFacts(): TerminalLivenessFacts {
  return {
    dispatchId: SOURCE_DISPATCH,
    workerRunning: false,
    terminalHandle: 'terminal-1',
    host: { kind: 'enumerated', terminalHandles: [] },
  };
}

function completeCapsule(): Promise<CapsuleExtractionOutcome> {
  return Promise.resolve({
    kind: 'extracted',
    capsule: {
      coverage: 'complete',
      readableRange: { transcriptRef: 'transcript:source-1', fromEventRef: 'ev:1', toEventRef: 'ev:9' },
      gaps: [],
      lastCompleteEventRef: 'ev:9',
      openActions: [],
      sourceRefs: ['ev:9'],
      unknowns: [],
    },
  });
}

function setup(h: RecoveryHarness): void {
  h.recordSourceSegment({
    segmentId: SOURCE_SEGMENT,
    dispatchId: SOURCE_DISPATCH,
    attemptId: ATTEMPT,
    sessionBindingId: SOURCE_BINDING,
  });
  h.recordMaterializationBinding(RECOVERY_WORK_PACKAGE, ORCA_TASK);
}

function recoveryInput(
  h: RecoveryHarness,
  overrides: Partial<Parameters<RecoveryHarness['input']>[0]> = {},
): ReturnType<RecoveryHarness['input']> {
  return h.input({
    sourceSegmentId: SOURCE_SEGMENT,
    sourceDispatchId: SOURCE_DISPATCH,
    observation: {
      sessionBindingId: SOURCE_BINDING,
      providerSessionId: 'provider-session-1',
      identityChanged: false,
    },
    liveness: exitedFacts(),
    extractCapsule: completeCapsule,
    ...overrides,
  });
}

test('替代 Session 保留原 Worker Task、contract/revision 与业务 Attempt，只创建新的 Dispatch、Binding 与 Segment', async () => {
  harness = createRecoveryHarness();
  setup(harness);

  const result = await recoverWorkerSession(recoveryInput(harness));
  expect(result.kind).toBe('alternate_created');
  if (result.kind !== 'alternate_created') {
    return;
  }

  const row = harness.recovery(result.recoveryId);
  expect(row).not.toBeNull();
  // 业务身份逐字保留。
  expect(row?.workerTaskId).toBe(RECOVERY_WORKER_TASK);
  expect(row?.workPackageId).toBe(RECOVERY_WORK_PACKAGE);
  expect(row?.businessAttemptId).toBe(ATTEMPT);
  expect(row?.sourceDispatchId).toBe(SOURCE_DISPATCH);
  expect(row?.sourceSegmentId).toBe(SOURCE_SEGMENT);
  expect(row?.role).toBe('validator');
  // 替代身份是新的：不复用原 Dispatch、原 Segment 的绑定。
  expect(row?.replacementDispatchId).not.toBe(SOURCE_DISPATCH);
  expect(row?.replacementSessionBindingId).not.toBe(SOURCE_BINDING);
  expect(row?.replacementSegmentId).toBe(deriveReplacementSegmentId(result.recoveryId));
  expect(row?.replacementSegmentId).not.toBe(SOURCE_SEGMENT);

  // 新 Session Segment 存在，且业务 Attempt 不变。
  const replacement = harness
    .segments()
    .find((segment) => segment.segmentId === row?.replacementSegmentId);
  expect(replacement).toBeDefined();
  expect(replacement?.attemptId).toBe(ATTEMPT);
  expect(replacement?.dispatchId).toBe(row?.replacementDispatchId);
  expect(replacement?.sessionBindingId).toBe(row?.replacementSessionBindingId);
  expect(replacement?.workerTaskId).toBe(RECOVERY_WORKER_TASK);

  // 复用既有物化 Task 派发替代 Session：不创建第二个 Orca Task。
  const mutations = harness.backend.mutations();
  expect(mutations.map((mutation) => mutation.operation)).toEqual(['worker-start']);
  const started = mutations[0];
  expect(started?.operation === 'worker-start' ? started.taskId : null).toBe(ORCA_TASK);
});

test('替代派发前原会话到达有效终态时以该终态结束，并把原 Segment 标记为 superseded', async () => {
  harness = createRecoveryHarness();
  setup(harness);

  const result = await recoverWorkerSession(
    recoveryInput(harness, {
      sourceTerminal: { kind: 'reached', terminalReceiptRef: 'receipt:source-terminal' },
    }),
  );

  expect(result.kind).toBe('source_completed');
  if (result.kind !== 'source_completed') {
    return;
  }
  const row = harness.recovery(result.recoveryId);
  expect(row?.status).toBe('recovered');
  expect(row?.terminalOutcome).toBe('source_completed');
  expect(row?.supersededSegmentId).toBe(SOURCE_SEGMENT);
  // 未创建替代 Session，也未消耗 Recovery Budget。
  expect(row?.replacementDispatchId).toBeNull();
  expect(row?.consumedBudget).toBe(0);
  expect(harness.backend.mutations()).toEqual([]);
});

test('superseded 原 Segment 的迟到结果只入历史，不改变当前 Worker Attempt 状态', async () => {
  harness = createRecoveryHarness();
  setup(harness);
  const concluded = await recoverWorkerSession(
    recoveryInput(harness, {
      sourceTerminal: { kind: 'reached', terminalReceiptRef: 'receipt:source-terminal' },
    }),
  );
  expect(concluded.kind).toBe('source_completed');
  if (concluded.kind !== 'source_completed') {
    return;
  }

  const before = harness.recovery(concluded.recoveryId);
  // supersede 事实是持久化事实，不是测试自己拼的数组。
  expect(before?.supersededSegmentId).toBe(SOURCE_SEGMENT);
  const segmentsBefore = harness.segments().length;

  // 迟到结果仍自报原 Dispatch / 原 Attempt；身份核验把它判为已被取代的尝试，只补历史。
  const verification = verifyWorkerResult(
    {
      runId: 'run-recovery',
      consumerGeneration: 1,
      graphGeneration: 1,
      authorizationId: RECOVERY_AUTHORIZATION,
      workerTaskId: RECOVERY_WORKER_TASK,
      dispatchId: SOURCE_DISPATCH,
      attemptId: ATTEMPT,
      role: 'validator',
      specBinding: SPEC_BINDING,
      worktreeId: 'worktree-recovery-1',
    },
    { ...trustedFacts(), dispatchId: 'dispatch-replacement-1' as DispatchId },
  );
  expect(verification.kind).toBe('stale_attempt');
  expect(resultAdvancesLifecycle(verification)).toBe(false);

  // 迟到结果不推进任何状态：记录与 Segment 集合保持原样。
  const after = harness.recovery(concluded.recoveryId);
  expect(after).toEqual(before);
  expect(harness.segments()).toHaveLength(segmentsBefore);
  expect(harness.backend.mutations()).toEqual([]);
});

test('替代 Session 创建即完成 Recovery：recovered + replaced，且不再接受第二次派发', async () => {
  harness = createRecoveryHarness();
  setup(harness);
  const created = await recoverWorkerSession(recoveryInput(harness));
  expect(created.kind).toBe('alternate_created');
  if (created.kind !== 'alternate_created') {
    return;
  }

  const row = harness.recovery(created.recoveryId);
  expect(row?.status).toBe('recovered');
  expect(row?.terminalOutcome).toBe('replaced');
  expect(row?.consumedBudget).toBe(1);

  // 已终结的 Recovery 不会重复派发替代 Session。
  const again = await recoverWorkerSession(recoveryInput(harness));
  expect(again.kind).toBe('already_concluded');
  expect(harness.backend.mutations()).toHaveLength(1);
});

test('未完成 Recovery 可用 source_completed 结论终结并 supersede 原 Segment', async () => {
  harness = createRecoveryHarness();
  setup(harness);
  const held = await recoverWorkerSession(
    recoveryInput(harness, {
      liveness: {
        dispatchId: SOURCE_DISPATCH,
        workerRunning: false,
        terminalHandle: 'terminal-1',
        host: { kind: 'not-enumerated' },
      },
    }),
  );
  expect(held.kind).toBe('unverifiable_hold');
  if (held.kind !== 'unverifiable_hold') {
    return;
  }

  const concluded = concludeWorkerSessionRecovery({
    store: harness.store,
    writer: harness.writer,
    coordinationScopeId: RECOVERY_SCOPE,
    recoveryId: held.recoveryId,
    outcome: { kind: 'source_completed', terminalReceiptRef: 'receipt:source-terminal' },
  });

  expect(concluded.kind).toBe('concluded');
  if (concluded.kind === 'concluded') {
    expect(concluded.status).toBe('recovered');
    expect(concluded.terminalOutcome).toBe('source_completed');
    expect(concluded.supersededSegmentId).toBe(SOURCE_SEGMENT);
  }
  expect(harness.backend.mutations()).toEqual([]);
});

test('替代派发回执无法核验身份时阻塞，重试不重复派发', async () => {
  harness = createRecoveryHarness();
  setup(harness);
  const unverifiableReceipt = {
    profile: { kind: 'reuse', profileRef: 'profile-validator' } as const,
    workerLaunch: { kind: 'orca_managed' as const, agent: 'codex' },
    interpretReceipt: () => ({ failure: '回执缺少可核验的 Session Binding' }),
  };

  const first = await recoverWorkerSession(recoveryInput(harness, { replacement: unverifiableReceipt }));
  expect(first.kind).toBe('blocked');
  if (first.kind === 'blocked') {
    expect(first.code).toBe('dispatch_unconfirmed');
  }
  expect(harness.backend.mutations()).toHaveLength(1);

  // 预写意图已经收尾：重启续办不重复派发，也不猜测替代身份。
  const second = await recoverWorkerSession(recoveryInput(harness, { replacement: unverifiableReceipt }));
  expect(second.kind).toBe('blocked');
  if (second.kind === 'blocked') {
    expect(second.code).toBe('dispatch_identity_unknown');
  }
  expect(harness.backend.mutations()).toHaveLength(1);
});

test('原 Task 未物化时不准备 prepared terminal', async () => {
  harness = createRecoveryHarness();
  harness.recordSourceSegment({
    segmentId: SOURCE_SEGMENT,
    dispatchId: SOURCE_DISPATCH,
    attemptId: ATTEMPT,
    sessionBindingId: SOURCE_BINDING,
  });
  let prepareCalls = 0;

  const result = await recoverWorkerSession(
    recoveryInput(harness, {
      replacement: {
        profile: { kind: 'reuse', profileRef: 'profile-validator' },
        workerLaunch: {
          kind: 'prepared_terminal',
          harness: 'codex',
          activation: 'none',
          title: 'prepared-without-task',
          prepare: () => {
            prepareCalls += 1;
            return Promise.resolve({ title: 'prepared-without-task', command: 'codex' });
          },
        },
        interpretReceipt: () => ({ failure: '本用例不应派发' }),
      },
    }),
  );

  expect(result.kind).toBe('blocked');
  if (result.kind === 'blocked') {
    expect(result.code).toBe('task_not_materialized');
  }
  expect(prepareCalls).toBe(0);
  expect(harness.backend.mutations()).toEqual([]);
});

test('替代 Segment 的 ID 与原 Segment 不同', () => {
  const replacement = deriveReplacementSegmentId('recovery:scope:segment' as never);
  expect(replacement).not.toBe(SOURCE_SEGMENT);
});
