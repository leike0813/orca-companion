/**
 * IC-09 / IP-5：Worker Session Recovery 的生命周期判定（Owner: `m1-recover-execution`）。
 *
 * Worker Session Recovery 是 Worker Harness session 中断后的**唯一**恢复生命周期，覆盖
 * Specification Planner、Implementation、Validator 与 Finalizer 四类角色。Coordinator Session 的
 * 恢复按其自身 checkpoint 与启动对账处理，因此 `decideRecoveryEntry` 对 Coordinator 主体只返回
 * `not_worker_recovery`，调用方据此**不创建** RecoveryId、Session Segment 或 Recovery Capsule。
 *
 * 第一次尝试固定为「按精确 Session Binding 恢复原会话」；只有确认原会话不可恢复（存活证据为
 * `exited`）时才创建替代 Session。存活或身份证据不充分时判定 `unverifiable` 并保持未决，绝不据此
 * 推断会话已退出、已失败或需要重新派发。
 *
 * 阶段词汇（`observed|verified|unverifiable|recovering|replaced|completed|superseded|failed`）只是
 * 本层内部的推导结论，**不落盘为第二套状态**：持久化只写 IC-09 的 RecoveryState 闭集，映射为：
 *
 * | 内部阶段     | 持久化 RecoveryState | 附加事实                                                    |
 * | ------------ | -------------------- | ----------------------------------------------------------- |
 * | observed     | pending              | 中断已观察到，尚未核验                                      |
 * | verified     | pending              | 精确绑定已核验，接下来尝试精确恢复                          |
 * | unverifiable | pending              | 保持未决：不推断退出、不派发                                |
 * | recovering   | recovering           | 恢复进行中；只有此阶段允许创建替代 Session                  |
 * | replaced     | recovered            | terminalOutcome = replaced                                  |
 * | completed    | recovered            | terminalOutcome = source_completed                          |
 * | superseded   | recovered            | terminalOutcome = source_completed 且 supersededSegmentId 已写 |
 * | failed       | blocked              | terminalOutcome = failed                                    |
 *
 * 纯函数：不读时钟、不碰存储、不调用 Orca，也不生成 Capsule 或消耗 Recovery Budget。
 */

import type { DispatchId, WorkerTaskId } from '../../application/dto/identity.js';
import type { WorkerRole } from '../planning/execution-authorization.js';
import { decideLiveness, type LivenessDecision, type TerminalLivenessFacts } from '../worker-liveness.js';

/** 中断主体：只有 Worker Harness session 走本生命周期。 */
export const RECOVERY_SUBJECTS = ['worker_session', 'coordinator_session'] as const;

export type WorkerSessionRecoverySubject = (typeof RECOVERY_SUBJECTS)[number];

export const RECOVERY_LIFECYCLE_PHASES = [
  'observed',
  'verified',
  'unverifiable',
  'recovering',
  'replaced',
  'completed',
  'superseded',
  'failed',
] as const;

export type RecoveryLifecyclePhase = (typeof RECOVERY_LIFECYCLE_PHASES)[number];

/**
 * 允许的内部阶段迁移。
 *
 * `failed` 对应持久化的 `blocked`，因此它保留一条回到核验阶段的通路（调用方补足事实后按同一
 * RecoveryId 续办），而不是被当成不可逆终态。
 */
export const RECOVERY_LIFECYCLE_TRANSITIONS: Readonly<
  Record<RecoveryLifecyclePhase, readonly RecoveryLifecyclePhase[]>
> = {
  observed: ['verified', 'unverifiable', 'failed'],
  verified: ['recovering', 'completed', 'superseded', 'failed'],
  unverifiable: ['verified', 'failed'],
  recovering: ['replaced', 'completed', 'superseded', 'failed'],
  replaced: ['completed', 'superseded', 'failed'],
  completed: [],
  superseded: [],
  failed: ['verified', 'unverifiable'],
};

export function recoveryLifecycleAllows(from: RecoveryLifecyclePhase, to: RecoveryLifecyclePhase): boolean {
  return RECOVERY_LIFECYCLE_TRANSITIONS[from].includes(to);
}

/** 推导阶段是否是终态；终态不再接受推进，只保留历史。 */
export function isTerminalRecoveryPhase(phase: RecoveryLifecyclePhase): boolean {
  return RECOVERY_LIFECYCLE_TRANSITIONS[phase].length === 0;
}

/** 一次中断里能观察到的 harness 绑定；缺字段即无法证明归属。 */
export type RecoveryBindingObservation = {
  readonly sessionBindingId: string | null;
  /** provider 报告的 session 身份；Session Segment 记录里没有它时为 `null`。 */
  readonly providerSessionId: string | null;
  readonly identityChanged: boolean;
};

export type RecoveryBindingFacts = {
  readonly role: WorkerRole;
  readonly workerTaskId: WorkerTaskId;
  readonly dispatchId: DispatchId;
  readonly attemptId: string;
  /** 中断 Session Segment 记录的绑定。 */
  readonly recorded: RecoveryBindingObservation;
  /** 当前观察到的绑定。 */
  readonly observed: RecoveryBindingObservation;
};

export type ExactBindingVerdict =
  | { readonly kind: 'exact'; readonly sessionBindingId: string; readonly providerSessionId: string }
  | { readonly kind: 'incomplete'; readonly missing: readonly string[] }
  | { readonly kind: 'mismatch'; readonly mismatch: readonly string[] };

/**
 * 核验「这次中断就是记录里那次会话」。
 *
 * 任何一项不成立都只返回 `incomplete` 或 `mismatch`，不做「最接近的那条」匹配，也不退回工作目录、
 * mtime 或最近一次输出。
 */
export function verifyExactSessionBinding(facts: RecoveryBindingFacts): ExactBindingVerdict {
  const recordedId = facts.recorded.sessionBindingId;
  const observedId = facts.observed.sessionBindingId;
  const observedSessionId = facts.observed.providerSessionId;
  const missing: string[] = [];
  if (recordedId === null || recordedId.length === 0) {
    missing.push('recordedSessionBindingId');
  }
  if (observedId === null || observedId.length === 0) {
    missing.push('observedSessionBindingId');
  }
  if (observedSessionId === null || observedSessionId.length === 0) {
    missing.push('observedProviderSessionId');
  }
  if (recordedId === null || observedId === null || observedSessionId === null) {
    return { kind: 'incomplete', missing };
  }
  if (facts.observed.identityChanged) {
    return { kind: 'mismatch', mismatch: ['identityChanged'] };
  }
  if (recordedId !== observedId) {
    return { kind: 'mismatch', mismatch: ['sessionBindingId'] };
  }
  // 只有走到这里才可能把观察归到记录中的那条会话。
  return { kind: 'exact', sessionBindingId: observedId, providerSessionId: observedSessionId };
}

export type RecoveryObservationFacts = {
  readonly subject: WorkerSessionRecoverySubject;
  readonly role: WorkerRole;
  readonly binding: RecoveryBindingFacts;
  /** 复用 IC-07 的三值存活事实；本模块调用 `decideLiveness`，不另造存活词表。 */
  readonly liveness: TerminalLivenessFacts;
};

/**
 * 恢复入口判定。
 *
 * 判定顺序固定：主体 → 精确绑定 → 存活。绑定不精确时连存活结论都不采用，因为那已经不是同一条
 * 会话的证据；存活为 `unverifiable` 时保持未决，绝不推断退出。
 */
export type RecoveryEntryDecision =
  | { readonly kind: 'not_worker_recovery'; readonly subject: 'coordinator_session'; readonly reason: string }
  | { readonly kind: 'unverifiable'; readonly phase: 'unverifiable'; readonly reason: string; readonly holdsDispatch: true }
  | {
      readonly kind: 'exact_recovery';
      readonly phase: 'verified';
      readonly sessionBindingId: string;
      readonly providerSessionId: string;
      readonly reason: string;
    }
  | { readonly kind: 'alternate_required'; readonly phase: 'verified'; readonly reason: string };

export function decideRecoveryEntry(facts: RecoveryObservationFacts): RecoveryEntryDecision {
  if (facts.subject === 'coordinator_session') {
    return {
      kind: 'not_worker_recovery',
      subject: 'coordinator_session',
      reason: 'Coordinator Session 按其自身 checkpoint 与启动对账处理，不进入 Worker Session Recovery',
    };
  }
  const verdict = verifyExactSessionBinding(facts.binding);
  if (verdict.kind !== 'exact') {
    const detail = verdict.kind === 'incomplete' ? `缺少 ${verdict.missing.join('、')}` : `不匹配 ${verdict.mismatch.join('、')}`;
    return {
      kind: 'unverifiable',
      phase: 'unverifiable',
      reason: `无法按精确 Session Binding 证明该中断的归属（${detail}）`,
      holdsDispatch: true,
    };
  }
  const liveness: LivenessDecision = decideLiveness(facts.liveness);
  if (liveness.liveness === 'live') {
    return {
      kind: 'exact_recovery',
      phase: 'verified',
      sessionBindingId: verdict.sessionBindingId,
      providerSessionId: verdict.providerSessionId,
      reason: liveness.reason,
    };
  }
  if (liveness.liveness === 'exited') {
    return { kind: 'alternate_required', phase: 'verified', reason: liveness.reason };
  }
  return { kind: 'unverifiable', phase: 'unverifiable', reason: liveness.reason, holdsDispatch: true };
}
