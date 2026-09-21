/**
 * IP-1 / D2：未决 Operation Intent 的对账结论（Owner: `m1-recover-execution`）。
 *
 * 这里是「对账之后能得出什么」的唯一领域词汇：已接受、已拒绝、未决三值。本模块是纯逻辑——不读时钟、
 * 不碰存储、不调用后端，因此恢复期的三值判定可以脱离 Orca 与 SQLite 测试。
 *
 * 拒绝的证明门槛是本模块的核心约束：只读对账（Orca `request-show`）**永远推不出**「未产生副作用」。
 * `absent`、`pending`、缺失 receipt 与传输故障都只说明「不知道」，不是「没发生」。因此 `rejected`
 * 只能来自调用方显式给出的已证实事实（`ProvenNoSideEffect`），用于覆盖「用户补充了使该 lane 可判定的
 * 新事实」这条路径；自动对账路径不得产出它。
 *
 * 依赖方向：只依赖本层类型与 `application/dto` 的既有值类型（IC-01/IC-03），不依赖 LangGraph、
 * Orca、Ink、进程或数据库。
 */

import type { OperationId } from '../../application/dto/identity.js';
import type { IntentState, OperationIntent } from '../../application/dto/operation-intent.js';
import type { ReconcileBlockReason, ReconcileResult } from '../../application/dto/operation-outcome.js';

/**
 * 对账结论。
 *
 * `accepted` 只表示外部系统记录了确定结果（含确定失败），不表示 Worker 完成或项目可交付；
 * `unknown` 携带原始阻塞原因，使「为什么还没结论」成为可持久化、可观测的事实。
 */
export type ReconciliationConclusion =
  | { readonly kind: 'accepted'; readonly operationId: OperationId; readonly statement: string }
  | { readonly kind: 'rejected'; readonly operationId: OperationId; readonly code: string; readonly message: string }
  | { readonly kind: 'unknown'; readonly operationId: OperationId; readonly reason: ReconcileBlockReason };

/** 需要进入对账的意图状态：未决与阻塞都还没有确定结论。 */
export const UNRESOLVED_INTENT_STATES = ['pending', 'blocked'] as const satisfies readonly IntentState[];

export function isUnresolvedIntentState(state: IntentState): boolean {
  return state === 'pending' || state === 'blocked';
}

/**
 * 把一次只读对账结果归类成结论。
 *
 * `settled` 表示后端已记录确定结果，因此是 `accepted`；其余一切都保持 `unknown`。这个函数在任何输入
 * 下都不会返回 `rejected`：`absent` 不是未发生的证明，推断「没发生」是禁止的。
 *
 * 对账结果若不是针对本 intent 的 OperationId，则不构成关于它的证明，同样保持未决。
 */
export function concludeReconciliation(
  intent: OperationIntent,
  reconciled: ReconcileResult,
): ReconciliationConclusion {
  if (reconciled.operation.operationId !== intent.operationId) {
    return { kind: 'unknown', operationId: intent.operationId, reason: 'unrecognized' };
  }
  if (reconciled.kind === 'settled') {
    return { kind: 'accepted', operationId: intent.operationId, statement: reconciled.statement };
  }
  return { kind: 'unknown', operationId: intent.operationId, reason: reconciled.reason };
}

/**
 * 调用方显式给出的「已证明未产生副作用」事实。
 *
 * 它必须由能证明请求未离开 transport 的证据支撑（例如发送前失败、本地拒绝）。缺失响应、缺失 receipt
 * 或传输故障都不满足这个门槛，不得用它换取一个 `rejected`。`operationId` 必须与被判定的 intent 相同。
 */
export type ProvenNoSideEffect = {
  readonly operationId: OperationId;
  readonly code: string;
  readonly message: string;
};

/** 只有 fact 与被判定的 intent 是同一个 OperationId 时才成立 `rejected`，否则保持未决。 */
export function concludeFromProvenNoSideEffect(
  intent: OperationIntent,
  fact: ProvenNoSideEffect,
): ReconciliationConclusion {
  if (fact.operationId !== intent.operationId) {
    return { kind: 'unknown', operationId: intent.operationId, reason: 'unrecognized' };
  }
  return { kind: 'rejected', operationId: intent.operationId, code: fact.code, message: fact.message };
}

/** 解除 lane 阻塞前必须重新校验的四类事实；只有调用方能提供，域函数只做判定。 */
export type LaneUnblockFacts = {
  readonly scopeMatches: boolean;
  readonly ownershipValid: boolean;
  readonly revisionMatches: boolean;
  readonly budgetAvailable: boolean;
};

export const LANE_UNBLOCK_BLOCK_REASONS = [
  'inconclusive',
  'scope_mismatch',
  'ownership_invalid',
  'stale_revision',
  'budget_exhausted',
] as const;

export type LaneUnblockBlockReason = (typeof LANE_UNBLOCK_BLOCK_REASONS)[number];

export type LaneUnblockDecision =
  | { readonly kind: 'clearable' }
  | { readonly kind: 'remains_blocked'; readonly reasons: readonly LaneUnblockBlockReason[] };

/**
 * 判定某条 mutation lane 是否可以被解除阻塞。
 *
 * 两个条件同时成立才允许：对账已经给出确定结论（`accepted` 或 `rejected`），且 scope、ownership、
 * revision 与预算四项事实都通过重新校验。结论仍未决，或任一项校验失败，都保持阻塞并给出结构化原因。
 */
export function decideLaneUnblock(
  conclusion: ReconciliationConclusion,
  facts: LaneUnblockFacts,
): LaneUnblockDecision {
  const reasons: LaneUnblockBlockReason[] = [];
  if (conclusion.kind === 'unknown') {
    reasons.push('inconclusive');
  }
  if (!facts.scopeMatches) {
    reasons.push('scope_mismatch');
  }
  if (!facts.ownershipValid) {
    reasons.push('ownership_invalid');
  }
  if (!facts.revisionMatches) {
    reasons.push('stale_revision');
  }
  if (!facts.budgetAvailable) {
    reasons.push('budget_exhausted');
  }
  return reasons.length === 0 ? { kind: 'clearable' } : { kind: 'remains_blocked', reasons };
}
