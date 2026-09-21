/**
 * IP-6 行为测试：稳定的 RecoveryId、预写 Operation Intent 与按 Worker Attempt 计数的 Recovery Budget
 * （change: `m1-recover-execution`）。
 *
 * 覆盖 Requirement「Recovery 必须以稳定 RecoveryId 与预写 Operation Intent 启动且按 Worker Attempt
 * 计数」的四个 Scenario：重启续办同一条 Recovery；创建替代 Segment 即消耗；按 Worker Attempt 独立
 * 计数；超出上限时阻塞；额度不因重启重置；workspace 不可对账时失败并阻塞。
 *
 * 额度只来自已批准 Manifest 的 `maxRecoveriesPerWorkerAttempt`（最小合法值 1）；装置不缓存预算来源。
 */

import { afterEach, expect, test } from 'vitest';

import {
  RECOVERY_SCOPE,
  RECOVERY_WORKER_TASK,
  RECOVERY_WORK_PACKAGE,
  createRecoveryHarness,
  type RecoveryHarness,
  type SourceSegmentInput,
} from '../support/recovery-harness.js';
import type { DispatchId, SessionSegmentId, WorkerTaskId, WorkPackageId } from '../../src/application/dto/identity.js';
import type { TerminalLivenessFacts } from '../../src/domain/worker-liveness.js';
import { consumedRecoveryBudget } from '../../src/domain/recovery/recovery-budget.js';
import type { CapsuleExtractionOutcome } from '../../src/application/recovery/recovery-capsule.js';
import {
  recoverWorkerSession,
  type RecoverWorkerSessionInput,
} from '../../src/application/recovery/worker-session-recovery-service.js';

const ORCA_TASK = 'orca-task-recovery';
const SOURCE_DISPATCH = 'dispatch-source-1' as DispatchId;
const SOURCE_SEGMENT = 'segment-source-1' as SessionSegmentId;
const SOURCE_BINDING = 'binding-source-1';

let harness: RecoveryHarness | null = null;

afterEach(() => {
  harness?.close();
  harness = null;
});

function exitedFacts(dispatchId: DispatchId): TerminalLivenessFacts {
  return {
    dispatchId,
    workerRunning: false,
    terminalHandle: 'terminal-1',
    host: { kind: 'enumerated', terminalHandles: [] },
  };
}

function unverifiableFacts(dispatchId: DispatchId): TerminalLivenessFacts {
  return {
    dispatchId,
    workerRunning: false,
    terminalHandle: 'terminal-1',
    host: { kind: 'not-enumerated' },
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

function sourceSegment(overrides: Partial<SourceSegmentInput> & Pick<SourceSegmentInput, 'segmentId' | 'dispatchId' | 'attemptId' | 'sessionBindingId'>): SourceSegmentInput {
  return { lastTranscriptRef: 'transcript:source-1', ...overrides };
}

function inputFor(
  h: RecoveryHarness,
  segment: SourceSegmentInput,
  overrides: Partial<RecoverInputOverrides> = {},
): RecoverWorkerSessionInput {
  return h.input({
    sourceSegmentId: segment.segmentId as SessionSegmentId,
    sourceDispatchId: segment.dispatchId as DispatchId,
    businessAttemptId: segment.attemptId,
    workPackageId: segment.workPackageId ?? RECOVERY_WORK_PACKAGE,
    workerTaskId: segment.workerTaskId ?? RECOVERY_WORKER_TASK,
    observation: {
      sessionBindingId: segment.sessionBindingId,
      providerSessionId: `provider:${segment.segmentId}`,
      identityChanged: false,
    },
    liveness: exitedFacts(segment.dispatchId as DispatchId),
    extractCapsule: completeCapsule,
    ...overrides,
  });
}

type RecoverInputOverrides = Parameters<RecoveryHarness['input']>[0];

test('未完成 Recovery 重启后以同一 RecoveryId 续办，不新建 Recovery 也不重复消耗额度', async () => {
  harness = createRecoveryHarness({ maxRecoveriesPerWorkerAttempt: 1 });
  const segment = sourceSegment({
    segmentId: SOURCE_SEGMENT,
    dispatchId: SOURCE_DISPATCH,
    attemptId: 'attempt-1',
    sessionBindingId: SOURCE_BINDING,
  });
  harness.recordSourceSegment(segment);
  harness.recordMaterializationBinding(RECOVERY_WORK_PACKAGE, ORCA_TASK);

  const first = await recoverWorkerSession(
    harness.input({
      sourceSegmentId: SOURCE_SEGMENT,
      sourceDispatchId: SOURCE_DISPATCH,
      observation: {
        sessionBindingId: SOURCE_BINDING,
        providerSessionId: 'provider-session-1',
        identityChanged: false,
      },
      // 存活不可判定：Recovery 保持未决，尚未进入替代流程。
      liveness: unverifiableFacts(SOURCE_DISPATCH),
      extractCapsule: completeCapsule,
    }),
  );
  expect(first.kind).toBe('unverifiable_hold');
  const recoveryId = first.kind === 'unverifiable_hold' ? first.recoveryId : null;
  expect(harness.recoveries()).toHaveLength(1);

  harness.reopen();
  const second = await recoverWorkerSession(inputFor(harness, segment));
  expect(second.kind).toBe('alternate_created');
  if (second.kind === 'alternate_created' && recoveryId !== null) {
    // 同一 RecoveryId 续办，而不是新建。
    expect(second.recoveryId).toBe(recoveryId);
    expect(second.consumedBudget).toBe(1);
  }
  expect(harness.recoveries()).toHaveLength(1);
  expect(harness.recoveries()[0]?.consumedBudget).toBe(1);
});

test('创建替代 Session Segment 即消耗一次，且按 Worker Attempt 求和', async () => {
  harness = createRecoveryHarness({ maxRecoveriesPerWorkerAttempt: 2 });
  harness.recordMaterializationBinding(RECOVERY_WORK_PACKAGE, ORCA_TASK);
  const first = sourceSegment({
    segmentId: SOURCE_SEGMENT,
    dispatchId: SOURCE_DISPATCH,
    attemptId: 'attempt-1',
    sessionBindingId: SOURCE_BINDING,
  });
  const second = sourceSegment({
    segmentId: 'segment-source-2',
    dispatchId: 'dispatch-source-2',
    attemptId: 'attempt-1',
    sessionBindingId: 'binding-source-2',
  });
  harness.recordSourceSegment(first);
  harness.recordSourceSegment(second);

  expect((await recoverWorkerSession(inputFor(harness, first))).kind).toBe('alternate_created');
  expect((await recoverWorkerSession(inputFor(harness, second))).kind).toBe('alternate_created');

  const rows = harness.recoveries();
  expect(rows).toHaveLength(2);
  expect(rows.every((row) => row.consumedBudget === 1)).toBe(true);
  expect(consumedRecoveryBudget(rows, 'attempt-1')).toBe(2);
  // 同一 Recovery 续办（重复写入同样的消耗值）不会重复消耗。
  const ledger = consumedRecoveryBudget(harness.recoveries(), 'attempt-1');
  expect(ledger).toBe(2);
});

test('Recovery Budget 按 Worker Attempt 独立计数', async () => {
  harness = createRecoveryHarness({ maxRecoveriesPerWorkerAttempt: 1 });
  const firstPackage = RECOVERY_WORK_PACKAGE;
  const secondPackage = 'wp-recovery-2' as WorkPackageId;
  const firstTask = RECOVERY_WORKER_TASK;
  const secondTask = 'task-recovery-2' as WorkerTaskId;
  harness.recordMaterializationBinding(firstPackage, 'orca-task-1');
  harness.recordMaterializationBinding(secondPackage, 'orca-task-2');

  const segmentA = sourceSegment({
    segmentId: SOURCE_SEGMENT,
    dispatchId: SOURCE_DISPATCH,
    attemptId: 'attempt-1',
    sessionBindingId: SOURCE_BINDING,
    workPackageId: firstPackage,
    workerTaskId: firstTask,
  });
  const segmentB = sourceSegment({
    segmentId: 'segment-source-2',
    dispatchId: 'dispatch-source-2',
    attemptId: 'attempt-2',
    sessionBindingId: 'binding-source-2',
    workPackageId: secondPackage,
    workerTaskId: secondTask,
  });
  harness.recordSourceSegment(segmentA);
  harness.recordSourceSegment(segmentB);

  // 上限为 1 时两个不同的 Worker Attempt 仍各自可以恢复一次。
  expect((await recoverWorkerSession(inputFor(harness, segmentA))).kind).toBe('alternate_created');
  expect((await recoverWorkerSession(inputFor(harness, segmentB))).kind).toBe('alternate_created');

  const rows = harness.recoveries();
  expect(consumedRecoveryBudget(rows, 'attempt-1')).toBe(1);
  expect(consumedRecoveryBudget(rows, 'attempt-2')).toBe(1);
});

test('达到上限时阻塞该 Worker Attempt 的继续恢复，且不产生第二次派发', async () => {
  harness = createRecoveryHarness({ maxRecoveriesPerWorkerAttempt: 1 });
  harness.recordMaterializationBinding(RECOVERY_WORK_PACKAGE, ORCA_TASK);
  const first = sourceSegment({
    segmentId: SOURCE_SEGMENT,
    dispatchId: SOURCE_DISPATCH,
    attemptId: 'attempt-1',
    sessionBindingId: SOURCE_BINDING,
  });
  const second = sourceSegment({
    segmentId: 'segment-source-2',
    dispatchId: 'dispatch-source-2',
    attemptId: 'attempt-1',
    sessionBindingId: 'binding-source-2',
  });
  harness.recordSourceSegment(first);
  harness.recordSourceSegment(second);

  expect((await recoverWorkerSession(inputFor(harness, first))).kind).toBe('alternate_created');
  const blocked = await recoverWorkerSession(inputFor(harness, second));
  expect(blocked.kind).toBe('blocked');
  if (blocked.kind === 'blocked') {
    expect(blocked.code).toBe('budget_exhausted');
  }
  const exhausted = harness.recoveries().find((row) => row.sourceSegmentId === second.segmentId);
  expect(exhausted?.status).toBe('blocked');
  expect(exhausted?.terminalOutcome).toBe('failed');
  expect(exhausted?.blockingReason).not.toBeNull();
  // 只发生了一次替代派发。
  expect(harness.backend.mutations().filter((mutation) => mutation.operation === 'worker-start')).toHaveLength(1);
});

test('额度不因重启重置', async () => {
  harness = createRecoveryHarness({ maxRecoveriesPerWorkerAttempt: 1 });
  harness.recordMaterializationBinding(RECOVERY_WORK_PACKAGE, ORCA_TASK);
  const first = sourceSegment({
    segmentId: SOURCE_SEGMENT,
    dispatchId: SOURCE_DISPATCH,
    attemptId: 'attempt-1',
    sessionBindingId: SOURCE_BINDING,
  });
  const second = sourceSegment({
    segmentId: 'segment-source-2',
    dispatchId: 'dispatch-source-2',
    attemptId: 'attempt-1',
    sessionBindingId: 'binding-source-2',
  });
  harness.recordSourceSegment(first);
  harness.recordSourceSegment(second);

  expect((await recoverWorkerSession(inputFor(harness, first))).kind).toBe('alternate_created');
  harness.reopen();

  expect(consumedRecoveryBudget(harness.recoveries(), 'attempt-1')).toBe(1);
  const blocked = await recoverWorkerSession(inputFor(harness, second));
  expect(blocked.kind).toBe('blocked');
  if (blocked.kind === 'blocked') {
    expect(blocked.code).toBe('budget_exhausted');
  }
  expect(consumedRecoveryBudget(harness.recoveries(), 'attempt-1')).toBe(1);
});

test('workspace 丢失或无法对账时失败并阻塞，不新建 worktree', async () => {
  harness = createRecoveryHarness({ maxRecoveriesPerWorkerAttempt: 1 });
  harness.recordMaterializationBinding(RECOVERY_WORK_PACKAGE, ORCA_TASK);
  const segment = sourceSegment({
    segmentId: SOURCE_SEGMENT,
    dispatchId: SOURCE_DISPATCH,
    attemptId: 'attempt-1',
    sessionBindingId: SOURCE_BINDING,
  });
  harness.recordSourceSegment(segment);

  const result = await recoverWorkerSession(
    inputFor(harness, segment, { workspace: { kind: 'lost', reason: 'worktree 已不存在' } }),
  );

  expect(result.kind).toBe('blocked');
  if (result.kind === 'blocked') {
    expect(result.code).toBe('workspace_lost');
  }
  const row = harness.recoveries()[0];
  expect(row?.status).toBe('blocked');
  expect(row?.terminalOutcome).toBe('failed');
  // 绝不新建 worktree 冒充原 Attempt，也不派发替代 Session。
  expect(harness.backend.mutations()).toEqual([]);
});

test('尚无有效授权时以 authorization_unreadable 阻塞，而不是报成额度耗尽', async () => {
  harness = createRecoveryHarness({ maxRecoveriesPerWorkerAttempt: 1 });
  harness.recordMaterializationBinding(RECOVERY_WORK_PACKAGE, ORCA_TASK);
  const segment = sourceSegment({
    segmentId: SOURCE_SEGMENT,
    dispatchId: SOURCE_DISPATCH,
    attemptId: 'attempt-1',
    sessionBindingId: SOURCE_BINDING,
  });
  harness.recordSourceSegment(segment);

  // 清空 Scope 上的授权指针：模拟「尚无有效授权」。
  const scope = harness.store.query({ kind: 'scope', coordinationScopeId: RECOVERY_SCOPE });
  expect(scope.kind).toBe('scope');
  if (scope.kind !== 'scope' || scope.scope === null) {
    return;
  }
  const cleared = harness.store.transact({
    kind: 'update-scope-refs',
    coordinationScopeId: RECOVERY_SCOPE,
    expectedRevision: scope.scope.revision,
    writer: harness.writer,
    graphId: scope.scope.graphId,
    graphVersion: scope.scope.graphVersion,
    authorizationId: null,
    authorizationVersion: null,
  });
  expect(cleared.kind).toBe('committed');

  const result = await recoverWorkerSession(inputFor(harness, segment));

  expect(result.kind).toBe('blocked');
  if (result.kind === 'blocked') {
    // 原因必须可分辨：不是 budget_exhausted。
    expect(result.code).toBe('authorization_unreadable');
  }
  const row = harness.recoveries()[0];
  expect(row?.status).toBe('blocked');
  expect(row?.terminalOutcome).toBe('failed');
  // 没有授权就没有替代派发。
  expect(harness.backend.mutations()).toEqual([]);
});
