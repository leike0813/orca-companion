/**
 * IC-06 / IP-A1：Dispatch Candidate 的物化前置判定（Owner: `m1-admit-work-package-specifications`）。
 *
 * 这是一个纯函数：它不读 Git、不读 Orca、不碰文件系统、不写存储，因此「为什么这次没有物化」永远
 * 可以在不产生副作用的前提下复算。判定顺序固定为控制状态 → 授权 → 预算 → 生命周期 → 图依赖，
 * 每一步失败都给出确定的拒绝原因，调用方据此记录依据而不是猜测。
 *
 * 判定通过只表示「可以开始物化」；它不表示 Worker 完成、任务通过或项目可交付，也不消耗任何预算。
 */

import type { WorkPackageId } from '../application/dto/identity.js';
import type { ScopeEnvelope, WorkPackageBudget } from './planning/execution-graph.js';
import {
  WORKER_ROLES,
  type RoleAuthorities,
  type WorkerRole,
} from './planning/execution-authorization.js';

export type { WorkerRole };
export { WORKER_ROLES };

/** Work Package 在图上的当前生命周期。只有 `frontier` 才可能成为可物化候选。 */
export const WORK_PACKAGE_LIFECYCLE_STAGES = [
  'pending',
  'frontier',
  'specifying',
  'implementing',
  'validating',
  'accepted',
  'retired',
] as const;

export type WorkPackageLifecycleStage = (typeof WORK_PACKAGE_LIFECYCLE_STAGES)[number];

/** WorkPackageBudget 的每个预算字段对应一个稳定的计数键后缀。 */
export type WorkPackageBudgetField = keyof WorkPackageBudget;

export const WORK_PACKAGE_BUDGET_FIELDS = [
  'implementationAttempts',
  'validatorRepairs',
  'graphRevisions',
  'specificationRevisions',
  'maxRecoveriesPerWorkerAttempt',
] as const satisfies readonly WorkPackageBudgetField[];

/** 共享预算计数键：同一个 Work Package 的同一预算项在 Scope 内只有一个计数。 */
export function workPackageBudgetKey(
  workPackageId: WorkPackageId,
  field: WorkPackageBudgetField,
): string {
  return `work-package:${workPackageId}:${field}`;
}

export type BudgetConsumption = {
  readonly workPackageId: WorkPackageId;
  readonly field: WorkPackageBudgetField;
  readonly consumed: number;
};

/** 授权只可能来自当前有效的 Execution Authorization；`valid` 由应用层从 store 事实推导。 */
export type DispatchAuthorizationState = {
  readonly valid: boolean;
  readonly authorizationId: string | null;
  readonly authorizationVersion: number | null;
  readonly reason: string | null;
};

export type DispatchCandidateFacts = {
  readonly candidateWorkPackageId: WorkPackageId;
  readonly candidateRole: WorkerRole;
  readonly lifecycleStage: WorkPackageLifecycleStage;
  /** 选为当前 Dispatch Candidate 的 Work Package；`null` 表示这一轮没有选中任何候选。 */
  readonly selectedCandidateId: WorkPackageId | null;
  /** 图依赖已通过的 Work Package 集合。 */
  readonly dependenciesSatisfied: readonly WorkPackageId[];
  readonly controlState: string;
  readonly authorization: DispatchAuthorizationState;
  /** 当前 Authorization Manifest 中的角色权限。 */
  readonly authority: RoleAuthorities;
  readonly budget: WorkPackageBudget;
  readonly consumed: readonly BudgetConsumption[];
  /** 本次派发实际消费的预算；不相关的零额度不能阻止当前角色工作。 */
  readonly requiredBudgetField: WorkPackageBudgetField | null;
  readonly scopeEnvelope: ScopeEnvelope;
};

export type DispatchRejectionCode =
  | 'control_state_not_active'
  | 'not_selected_candidate'
  | 'lifecycle_not_frontier'
  | 'graph_dependency_unsatisfied'
  | 'authorization_invalid'
  | 'role_not_authorized'
  | 'budget_exhausted';

export type DispatchCandidateRejection = {
  readonly code: DispatchRejectionCode;
  readonly message: string;
  /** 预算耗尽时给出确切计数键；其它原因下为 `null`。 */
  readonly budgetKey: string | null;
};

export type DispatchCandidateDecision =
  | {
      readonly kind: 'materializable';
      readonly workPackageId: WorkPackageId;
      readonly role: WorkerRole;
      readonly scopeEnvelope: ScopeEnvelope;
    }
  | { readonly kind: 'rejected'; readonly rejection: DispatchCandidateRejection };

function rejection(
  code: DispatchRejectionCode,
  message: string,
  budgetKey: string | null = null,
): DispatchCandidateDecision {
  return { kind: 'rejected', rejection: { code, message, budgetKey } };
}

/** 只有 `active` 允许开始新的物化；暂停、阻塞、取消与重规划转换都不是。 */
function controlStateReason(controlState: string): string | null {
  return controlState === 'active' ? null : `控制状态为 ${controlState}，不接受新的物化`;
}

function consumedOf(
  facts: Pick<DispatchCandidateFacts, 'candidateWorkPackageId' | 'consumed'>,
  field: WorkPackageBudgetField,
): number {
  const record = facts.consumed.find(
    (entry) => entry.workPackageId === facts.candidateWorkPackageId && entry.field === field,
  );
  return record === undefined ? 0 : record.consumed;
}

/** 单个预算项的耗尽判定：已消耗达到上限即耗尽。上限为 0 表示该项没有可用额度。 */
export function budgetFieldExhausted(limit: number, consumed: number): boolean {
  return consumed >= limit;
}

/**
 * 找出第一个已耗尽的预算项。
 *
 * 逐项比较上限与已消耗计数；缺计数的项按 0 处理，因此「没有记录」不会被读成「已经用完」或
 * 「不受限制」。返回第一个耗尽项，保证拒绝原因稳定可复现。
 */
export function exhaustedBudgetField(
  facts: Pick<DispatchCandidateFacts, 'candidateWorkPackageId' | 'budget' | 'consumed'>,
): WorkPackageBudgetField | null {
  for (const field of WORK_PACKAGE_BUDGET_FIELDS) {
    if (budgetFieldExhausted(facts.budget[field], consumedOf(facts, field))) {
      return field;
    }
  }
  return null;
}

/**
 * 判定一个 Dispatch Candidate 是否可以进入物化。
 *
 * 判定不产生任何副作用：被拒绝时调用方只记录原因与依据，Execution Graph 与 worktree 保持原样。
 */
export function evaluateDispatchCandidate(facts: DispatchCandidateFacts): DispatchCandidateDecision {
  const control = controlStateReason(facts.controlState);
  if (control !== null) {
    return rejection('control_state_not_active', control);
  }
  if (facts.selectedCandidateId === null || facts.selectedCandidateId !== facts.candidateWorkPackageId) {
    return rejection(
      'not_selected_candidate',
      `Work Package ${facts.candidateWorkPackageId} 不是当前选中的 Dispatch Candidate`,
    );
  }
  if (facts.lifecycleStage !== 'frontier') {
    return rejection(
      'lifecycle_not_frontier',
      `Work Package ${facts.candidateWorkPackageId} 的生命周期阶段为 ${facts.lifecycleStage}，不在 Execution Frontier`,
    );
  }
  if (!facts.dependenciesSatisfied.includes(facts.candidateWorkPackageId)) {
    return rejection(
      'graph_dependency_unsatisfied',
      `Work Package ${facts.candidateWorkPackageId} 的图依赖尚未全部通过`,
    );
  }
  if (!facts.authorization.valid) {
    return rejection(
      'authorization_invalid',
      facts.authorization.reason ?? `Graph Generation 没有有效的 Execution Authorization`,
    );
  }
  if (!facts.authority[facts.candidateRole]) {
    return rejection(
      'role_not_authorized',
      `Execution Authorization 不允许 ${facts.candidateRole} 角色派发`,
    );
  }
  const budgetField = facts.requiredBudgetField;
  if (
    budgetField !== null &&
    budgetFieldExhausted(facts.budget[budgetField], consumedOf(facts, budgetField))
  ) {
    const budgetKey = workPackageBudgetKey(facts.candidateWorkPackageId, budgetField);
    return rejection(
      'budget_exhausted',
      `Work Package ${facts.candidateWorkPackageId} 的 ${budgetField} 预算已耗尽`,
      budgetKey,
    );
  }
  return {
    kind: 'materializable',
    workPackageId: facts.candidateWorkPackageId,
    role: facts.candidateRole,
    scopeEnvelope: facts.scopeEnvelope,
  };
}
