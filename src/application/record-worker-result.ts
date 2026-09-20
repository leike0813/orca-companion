/**
 * IC-08 / IP-B1：候选 Worker 结果的核验结论与 Retry Attempt 判定
 * （Owner: `m1-execute-and-validate-work-packages`）。
 *
 * 这个用例只回答三个问题：这份报告是不是当前代际的、结论性失败/中断之后能不能按正常 Retry
 * Attempt 重开、以及「需要改契约」是否必须走修订路径。它**不**记录 Accepted Worker Result
 * （那是 `delivery/process-delivery.ts` 的唯一职责），也**不**做任何恢复：不生成 Capsule、
 * 不记录也不消耗 Recovery Budget、不把新 session 当作原 Attempt 的继续。
 *
 * 重开的语义是「新的 Dispatch + 新的 Attempt，沿用同一个 WorkerTask、Task Contract 与
 * Specification Revision」：本模块因此返回一份计划（数据），Dispatch/Attempt 身份仍由 Controller
 * 签发，实际派发沿用既有的 `worker-start --retry-of` 通道，不在这里复制物化流水线。
 */

import type { DispatchId, WorkerTaskId } from './dto/identity.js';
import type { BudgetConsumption } from '../domain/dispatch-candidate.js';
import type { TaskContract, SpecBinding, WorkerBudget } from '../domain/task-contract.js';
import {
  verifyWorkerResult,
  type ClaimedResultAttribution,
  type ResultVerificationRejectionCode,
  type TrustedExecutionFacts,
  type WorkerResultVerification,
} from '../domain/worker-result-verification.js';

/** 一次尝试的结局；`session_lost` 表示 harness session 已不可继续。 */
export const WORKER_ATTEMPT_OUTCOMES = [
  'completed',
  'conclusive_failure',
  'interrupted',
  'session_lost',
] as const;

export type WorkerAttemptOutcome = (typeof WORKER_ATTEMPT_OUTCOMES)[number];

/**
 * 新尝试的计划。
 *
 * `taskContract` 与 `specBinding` 逐字沿用原值，`consumedBudgets` 原样带上：重开不重置任何已消耗
 * 的实现尝试或修复预算。类型里刻意没有 Capsule、Recovery Budget 或 Session Segment 字段——
 * 本 change 没有这些能力，新尝试必须是独立尝试。
 */
export type RetryAttemptPlan = {
  readonly workerTaskId: WorkerTaskId;
  readonly newDispatchId: DispatchId;
  readonly newAttemptId: string;
  readonly retryOfDispatchId: DispatchId;
  readonly taskContract: TaskContract;
  readonly specBinding: SpecBinding;
  readonly budget: WorkerBudget;
  readonly consumedBudgets: readonly BudgetConsumption[];
  /** 新尝试独立于原 session：不伪装成原 Attempt 的继续。 */
  readonly independentFromPreviousSession: true;
};

export type WorkerResultRecording =
  /** 当前代际的报告：允许写入 Accepted Worker Result 并推进生命周期。 */
  | { readonly kind: 'recorded'; readonly verification: WorkerResultVerification }
  /** 旧代际或旧尝试：只允许补充历史与确认。 */
  | { readonly kind: 'history_only'; readonly verification: WorkerResultVerification }
  /** 核验不通过：不得记录、不得推进。 */
  | { readonly kind: 'rejected'; readonly verification: WorkerResultVerification }
  | { readonly kind: 'retry'; readonly plan: RetryAttemptPlan }
  | { readonly kind: 'blocked'; readonly reason: string; readonly blockerRef: string }
  | { readonly kind: 'contract_revision_required'; readonly reason: string };

export type RetryFacts = {
  /** 正常 Retry Attempt 条件是否成立；由调用方从 liveness、终态与生命周期事实推导。 */
  readonly allowed: boolean;
  /** 条件不成立时阻塞原因，成立时为该尝试的说明。 */
  readonly reason: string;
  readonly newDispatchId: DispatchId;
  readonly newAttemptId: string;
  readonly retryOfDispatchId: DispatchId;
};

export type RecordWorkerResultInput = {
  readonly claimed: ClaimedResultAttribution;
  readonly trusted: TrustedExecutionFacts;
  readonly attemptOutcome: WorkerAttemptOutcome;
  /** 继续执行是否必须改变 WorkerTask 的 contract 或其 Specification Revision。 */
  readonly contractChange: { readonly required: boolean; readonly reason: string } | null;
  readonly retry: RetryFacts;
  readonly taskContract: TaskContract;
  readonly specBinding: SpecBinding;
  readonly budget: WorkerBudget;
  readonly consumedBudgets: readonly BudgetConsumption[];
};

function planFor(input: RecordWorkerResultInput): RetryAttemptPlan {
  return {
    workerTaskId: input.trusted.workerTaskId,
    newDispatchId: input.retry.newDispatchId,
    newAttemptId: input.retry.newAttemptId,
    retryOfDispatchId: input.retry.retryOfDispatchId,
    taskContract: input.taskContract,
    specBinding: input.specBinding,
    budget: input.budget,
    consumedBudgets: input.consumedBudgets,
    independentFromPreviousSession: true,
  };
}

/**
 * 判定一份候选结果的处置方式。
 *
 * 判定顺序是安全优先的固定顺序：先处理 session 丢失（报告此刻已不可信），再处理契约修订需求，
 * 再做代际核验，最后才看尝试结局。任何一条路径都不会归零预算，也不会产生恢复产物。
 */
export function decideWorkerResultRecording(input: RecordWorkerResultInput): WorkerResultRecording {
  if (input.attemptOutcome === 'session_lost') {
    if (input.contractChange?.required === true) {
      return { kind: 'contract_revision_required', reason: input.contractChange.reason };
    }
    if (!input.retry.allowed) {
      return {
        kind: 'blocked',
        reason: input.retry.reason,
        blockerRef: `session-lost:${input.trusted.dispatchId}:${input.trusted.attemptId}`,
      };
    }
    return { kind: 'retry', plan: planFor(input) };
  }

  const verification = verifyWorkerResult(input.claimed, input.trusted);
  if (verification.kind === 'stale_generation' || verification.kind === 'stale_attempt') {
    return { kind: 'history_only', verification };
  }
  if (verification.kind === 'rejected') {
    return { kind: 'rejected', verification };
  }
  if (input.attemptOutcome === 'completed') {
    return { kind: 'recorded', verification };
  }

  if (input.contractChange?.required === true) {
    return { kind: 'contract_revision_required', reason: input.contractChange.reason };
  }
  if (!input.retry.allowed) {
    return {
      kind: 'blocked',
      reason: input.retry.reason,
      blockerRef: `${input.attemptOutcome}:${input.trusted.dispatchId}:${input.trusted.attemptId}`,
    };
  }
  return { kind: 'retry', plan: planFor(input) };
}

/** 结论是否允许写入 Accepted Worker Result；其余结论一律不写。 */
export function allowsAcceptedResult(recording: WorkerResultRecording): boolean {
  return recording.kind === 'recorded';
}

/** 供断言与投影使用：计划里绝不出现恢复产物或预算重置。 */
export function retryPlanCarriesRecoveryArtifacts(plan: RetryAttemptPlan): boolean {
  return (
    Object.hasOwn(plan, 'capsuleRef') ||
    Object.hasOwn(plan, 'recoveryBudget') ||
    Object.hasOwn(plan, 'sessionSegment')
  );
}

/** 失败项的类型别名，便于调用方在日志与投影里复用同一闭集。 */
export type { ResultVerificationRejectionCode };
