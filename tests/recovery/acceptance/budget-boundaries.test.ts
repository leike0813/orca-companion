/**
 * 6.1 验收层：Recovery Budget 的边界值（change: `m1-recover-execution`；spec
 * `recovery/worker-sessions` 的「Recovery 必须以稳定 RecoveryId 与预写 Operation Intent 启动且按
 * Worker Attempt 计数」）。
 *
 * 这里补的是**边界**，不是重复既有单测：
 *
 * - 上限取 `0`：0 不是「缺失」，必须在授权边界被拒绝（fail closed），因此不可能存在一条 0 额度授权，
 *   也就不可能消耗一次；若旧数据里真的出现 0 上限，预算判定必须直接判 exhausted 而不是放行一次。
 * - 上限取 `1` 与 `N`：恰好允许 `1` / `N` 次替代 Segment，第 `N+1` 次立即阻塞，且越界那条一次都
 *   没有消耗、没有产生第二个副作用，重复尝试仍是同样的阻塞。
 * - 达上限后经过**真实 Runtime 重启**（释放旧租约 + 新 Incarnation/新 fencing generation）：已消耗
 *   额度不被重置，也不产生第二次派发（限定审计标签 `gate.budget-not-reset-on-recovery`）。
 *
 * 「创建替代 Segment 即消耗」「按 Worker Attempt 独立计数」「workspace 丢失即失败」的单元级断言已在
 * `tests/recovery/recovery-budget.test.ts` 覆盖，这里不重复，只保留边界与重启语义。
 */

import { afterEach, expect, test } from 'vitest';

import { acquireRuntimeLease } from '../../../src/application/coordination/lease-service.js';
import type { DispatchId, RuntimeIncarnationId, SessionSegmentId } from '../../../src/application/dto/identity.js';
import type { CapsuleExtractionOutcome } from '../../../src/application/recovery/recovery-capsule.js';
import {
  recoverWorkerSession,
  type RecoverWorkerSessionInput,
} from '../../../src/application/recovery/worker-session-recovery-service.js';
import { recoveryAllowance } from '../../../src/application/planning/authorization-service.js';
import type { BranchCoordinationStore, CoordinationWriter } from '../../../src/application/ports/branch-coordination-store.js';
import { applyLimitDefaults } from '../../../src/domain/planning/budget-policy.js';
import {
  assembleManifest,
  type ExecutionAuthorizationRecord,
} from '../../../src/domain/planning/execution-authorization.js';
import { consumedRecoveryBudget } from '../../../src/domain/recovery/recovery-budget.js';
import type { TerminalLivenessFacts } from '../../../src/domain/worker-liveness.js';
import {
  RECOVERY_AUTHORIZATION,
  RECOVERY_SCOPE,
  RECOVERY_SESSION,
  RECOVERY_WORK_PACKAGE,
  createRecoveryHarness,
  type RecoveryHarness,
  type SourceSegmentInput,
} from '../../support/recovery-harness.js';

const ORCA_TASK = 'orca-task-recovery';
const ATTEMPT = 'attempt-1';
const RESTART_INCARNATION = 'inc-recovery-restart' as RuntimeIncarnationId;

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

/** 同一个 Worker Attempt 上的第 `index` 条中断 Segment。 */
function sourceSegment(index: number): SourceSegmentInput {
  return {
    segmentId: `segment-source-${String(index)}`,
    dispatchId: `dispatch-source-${String(index)}`,
    attemptId: ATTEMPT,
    sessionBindingId: `binding-source-${String(index)}`,
    lastTranscriptRef: `transcript:source-${String(index)}`,
  };
}

function inputFor(
  created: RecoveryHarness,
  segment: SourceSegmentInput,
  overrides: Partial<Parameters<RecoveryHarness['input']>[0]> = {},
): RecoverWorkerSessionInput {
  return created.input({
    sourceSegmentId: segment.segmentId as SessionSegmentId,
    sourceDispatchId: segment.dispatchId as DispatchId,
    businessAttemptId: segment.attemptId,
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

function workerStarts(created: RecoveryHarness): number {
  return created.backend.mutations().filter((mutation) => mutation.operation === 'worker-start').length;
}

function approvedAuthorization(
  store: BranchCoordinationStore,
  authorizationId: string,
): ExecutionAuthorizationRecord {
  const read = store.query({ kind: 'authorization', coordinationScopeId: RECOVERY_SCOPE, authorizationId });
  if (read.kind !== 'authorization' || read.authorization === null) {
    throw new Error('无法读取已批准的 Execution Authorization');
  }
  return read.authorization;
}

test(
  '[gate.budget-not-reset-on-recovery] 达上限后经过真实 Runtime 重启仍沿用已消耗额度，且不产生第二次派发',
  async () => {
    harness = createRecoveryHarness({ maxRecoveriesPerWorkerAttempt: 1 });
    harness.recordMaterializationBinding(RECOVERY_WORK_PACKAGE, ORCA_TASK);
    const first = sourceSegment(1);
    const second = sourceSegment(2);
    harness.recordSourceSegment(first);
    harness.recordSourceSegment(second);

    expect((await recoverWorkerSession(inputFor(harness, first))).kind).toBe('alternate_created');
    expect(consumedRecoveryBudget(harness.recoveries(), ATTEMPT)).toBe(1);
    const dispatchesBefore = workerStarts(harness);
    expect(dispatchesBefore).toBe(1);

    // 真实重启：重开同一个库、释放旧 Runtime Lease、以新的 Incarnation 重新取得租约。
    harness.reopen();
    harness.releaseRuntimeLease();
    const reacquired = acquireRuntimeLease(harness.store, {
      coordinationScopeId: RECOVERY_SCOPE,
      coordinatorSessionId: RECOVERY_SESSION,
      runtimeIncarnationId: RESTART_INCARNATION,
      fencingGeneration: 0,
    });
    expect(reacquired.kind).toBe('acquired');
    if (reacquired.kind !== 'acquired') {
      return;
    }
    // 新的 fencing generation 严格更大：重启确实换了一个 Runtime Incarnation。
    expect(reacquired.lease.fencingGeneration).toBeGreaterThan(harness.writer.fencingGeneration);
    const restartedWriter: CoordinationWriter = {
      coordinatorSessionId: RECOVERY_SESSION,
      runtimeIncarnationId: RESTART_INCARNATION,
      fencingGeneration: reacquired.lease.fencingGeneration,
    };

    const blocked = await recoverWorkerSession(inputFor(harness, second, { writer: restartedWriter }));

    expect(blocked.kind).toBe('blocked');
    if (blocked.kind === 'blocked') {
      expect(blocked.code).toBe('budget_exhausted');
    }
    // 额度不因重启重置：仍然只有 1，越界那条一次都没有消耗，也没有第二次替代派发。
    expect(consumedRecoveryBudget(harness.recoveries(), ATTEMPT)).toBe(1);
    const overflow = harness.recoveries().find((row) => row.sourceSegmentId === second.segmentId);
    expect(overflow?.consumedBudget).toBe(0);
    expect(overflow?.status).toBe('blocked');
    expect(workerStarts(harness)).toBe(dispatchesBefore);
  },
);

test.each([1, 3] as const)(
  '上限取 %i 时恰好允许同等次数的替代 Segment：第 N+1 次立即阻塞且一次都不再消耗',
  async (limit) => {
    harness = createRecoveryHarness({ maxRecoveriesPerWorkerAttempt: limit });
    harness.recordMaterializationBinding(RECOVERY_WORK_PACKAGE, ORCA_TASK);
    const segments = Array.from({ length: limit + 1 }, (_, index) => sourceSegment(index + 1));
    for (const segment of segments) {
      harness.recordSourceSegment(segment);
    }

    for (let index = 0; index < limit; index += 1) {
      const segment = segments[index];
      if (segment === undefined) {
        throw new Error('夹具缺少中断 Segment');
      }
      const created = await recoverWorkerSession(inputFor(harness, segment));
      expect(created.kind, `第 ${String(index + 1)} 次替代派发`).toBe('alternate_created');
    }
    // 边界之内全部成功，且计数恰好等于上限。
    expect(consumedRecoveryBudget(harness.recoveries(), ATTEMPT)).toBe(limit);
    expect(workerStarts(harness)).toBe(limit);

    const overflow = segments[limit];
    if (overflow === undefined) {
      throw new Error('夹具缺少越界 Segment');
    }
    const blocked = await recoverWorkerSession(inputFor(harness, overflow));
    expect(blocked.kind).toBe('blocked');
    if (blocked.kind === 'blocked') {
      expect(blocked.code).toBe('budget_exhausted');
    }

    // 越界那条：阻塞、零消耗、零副作用。
    const overflowRow = harness.recoveries().find((row) => row.sourceSegmentId === overflow.segmentId);
    expect(overflowRow?.status).toBe('blocked');
    expect(overflowRow?.consumedBudget).toBe(0);
    expect(consumedRecoveryBudget(harness.recoveries(), ATTEMPT)).toBe(limit);
    expect(workerStarts(harness)).toBe(limit);

    // 反复尝试仍是同样的阻塞：阻塞本身也不消耗额度。
    const again = await recoverWorkerSession(inputFor(harness, overflow));
    expect(again.kind).toBe('blocked');
    expect(consumedRecoveryBudget(harness.recoveries(), ATTEMPT)).toBe(limit);
    expect(workerStarts(harness)).toBe(limit);
  },
);

test('Manifest 上限取 0 在授权边界即被拒绝：不存在 0 额度授权，因此一次都不可能消耗', () => {
  harness = createRecoveryHarness({ maxRecoveriesPerWorkerAttempt: 1 });
  const authorization = approvedAuthorization(harness.store, RECOVERY_AUTHORIZATION);

  // 0 不是「缺失」：显式 0 必须被拒绝，而不是被默认值补成 1。
  const withZeroLimit = {
    ...authorization.manifest,
    limits: { ...authorization.manifest.limits, maxRecoveriesPerWorkerAttempt: 0 },
  };
  const assembled = assembleManifest(withZeroLimit);
  expect(assembled.ok).toBe(false);
  if (!assembled.ok) {
    expect(assembled.field).toContain('maxRecoveriesPerWorkerAttempt');
  }
  const defaulted = applyLimitDefaults({ maxRecoveriesPerWorkerAttempt: 0 }) as Record<string, unknown>;
  expect(defaulted['maxRecoveriesPerWorkerAttempt']).toBe(0);

  // 防御性边界：旧数据真的带 0 上限时，判定必须是「直接阻塞」，而不是放行一次。
  const zeroLimitAuthorization: ExecutionAuthorizationRecord = { ...authorization, manifest: withZeroLimit };
  expect(recoveryAllowance({ authorization: zeroLimitAuthorization, usedRecoveries: 0 })).toEqual({
    kind: 'exhausted',
    limit: 0,
  });

  // 已批准的真实下限是 1：恰好一次可用，用完即在边界处阻塞。
  expect(recoveryAllowance({ authorization, usedRecoveries: 0 })).toEqual({
    kind: 'available',
    remaining: 1,
  });
  expect(recoveryAllowance({ authorization, usedRecoveries: 1 })).toEqual({ kind: 'exhausted', limit: 1 });
});
