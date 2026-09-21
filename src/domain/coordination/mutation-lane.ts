/**
 * D3：mutation lane 阻塞的派生投影与解除前置判定
 * （Owner: `m1-recover-execution`，IP-3）。
 *
 * lane 的持久化事实只有 Operation Intent（`src/application/dto/operation-intent.ts`）。这里不新建
 * 记录、不引入第二份状态权威：它只把「哪些未决 intent 让哪个 lane 未决」投影成可观测结果，并在
 * 解除前做纯判定。
 *
 * 两个边界：
 * - 阻塞以 lane 为粒度，不是全局锁。派生结果只覆盖确有未决 intent 的 lane；其它 lane 的读写与
 *   只读查询完全不经过这里，也不受影响。
 * - 判定是纯函数：不读时钟、不碰存储、不查权威源。scope、ownership、revision 与预算这四项事实
 *   由调用方从各自权威处读好后作为入参传入，这里只回答「能不能解除」和拒绝原因。
 */

import type { OperationId } from '../../application/dto/identity.js';
import type { OperationIntent } from '../../application/dto/operation-intent.js';

/** 未决的成因：已确认阻塞，或仍在等待对账结论。 */
export const MUTATION_LANE_UNRESOLVED_CAUSES = ['blocked', 'pending'] as const;

export type MutationLaneUnresolvedCause = (typeof MUTATION_LANE_UNRESOLVED_CAUSES)[number];

/**
 * `pending` 且未记录原因时的稳定占位语义。
 *
 * `pending` 表示「还没有结论」，占位值只回答「在等对账」，不能被读成阻塞原因已经判定。
 */
export const PENDING_LANE_REASON = 'awaiting_reconciliation';

/** `blocked` 但记录里没有原因时的稳定占位语义；正常路径由 `block-intent` 写入真实原因。 */
export const BLOCKED_LANE_REASON = 'blocked_without_recorded_reason';

export type MutationLaneRecord = {
  readonly laneKey: string;
  /** 让该 lane 未决的 OperationId；解除必须针对它得出结论。 */
  readonly operationId: OperationId;
  readonly cause: MutationLaneUnresolvedCause;
  /** 可观测的阻塞原因；来自 `blockingReason`，缺失时用上面的稳定占位值。 */
  readonly reason: string;
};

function causeRank(cause: MutationLaneUnresolvedCause): number {
  // 已确认的阻塞比「等待结论」更强：同一 lane 若同时存在两条未决记录，展示前者。
  return cause === 'blocked' ? 0 : 1;
}

/** 归一化比较：先比成因强度，再比创建时间，最后用 OperationId 保证顺序稳定。 */
function preferred(candidate: OperationIntent, current: OperationIntent): boolean {
  const candidateRank = causeRank(candidate.state === 'blocked' ? 'blocked' : 'pending');
  const currentRank = causeRank(current.state === 'blocked' ? 'blocked' : 'pending');
  if (candidateRank !== currentRank) {
    return candidateRank < currentRank;
  }
  if (candidate.createdAt !== current.createdAt) {
    return candidate.createdAt < current.createdAt;
  }
  return candidate.operationId < current.operationId;
}

function toRecord(intent: OperationIntent): MutationLaneRecord {
  const cause: MutationLaneUnresolvedCause = intent.state === 'blocked' ? 'blocked' : 'pending';
  const recorded = intent.blockingReason;
  const fallback = cause === 'blocked' ? BLOCKED_LANE_REASON : PENDING_LANE_REASON;
  return {
    laneKey: intent.laneKey,
    operationId: intent.operationId,
    cause,
    reason: recorded === null || recorded.length === 0 ? fallback : recorded,
  };
}

/**
 * 把一组 intent 投影成每个未决 lane 的一条记录。
 *
 * 只有 `pending` 与 `blocked` 是未决；`settled` 不产生 lane，也不会让任何 lane 变慢。真实存储上
 * `(coordination_scope_id, lane_key)` 的部分唯一索引保证每个 lane 至多一条未决 intent，这里仍按
 * 确定性规则归一化，避免依赖数据库不变式来决定展示内容。
 */
export function projectMutationLanes(intents: readonly OperationIntent[]): readonly MutationLaneRecord[] {
  const byLane = new Map<string, OperationIntent>();
  for (const intent of intents) {
    if (intent.state !== 'pending' && intent.state !== 'blocked') {
      continue;
    }
    const current = byLane.get(intent.laneKey);
    if (current === undefined || preferred(intent, current)) {
      byLane.set(intent.laneKey, intent);
    }
  }
  return [...byLane.values()]
    .map(toRecord)
    .sort((left, right) => (left.laneKey < right.laneKey ? -1 : left.laneKey > right.laneKey ? 1 : 0));
}

/** 该 lane 是否未决；其它 lane 的查询结果与它无关，阻塞因此不是全局开关。 */
export function findMutationLane(
  lanes: readonly MutationLaneRecord[],
  laneKey: string,
): MutationLaneRecord | null {
  return lanes.find((lane) => lane.laneKey === laneKey) ?? null;
}

export function isLaneBlocked(lanes: readonly MutationLaneRecord[], laneKey: string): boolean {
  return findMutationLane(lanes, laneKey) !== null;
}

/**
 * 解除阻塞的事实来源。
 *
 * 只有两种事实能让 lane 重新可判定：对账得出的确定结论，或用户显式补充的事实。`indeterminate`
 * 表示两者都没有，lane 必须保持阻塞。
 */
export const LANE_RESOLUTION_FACTS = [
  'reconciliation_conclusion',
  'user_supplied_fact',
  'indeterminate',
] as const;

export type LaneResolutionFact = (typeof LANE_RESOLUTION_FACTS)[number];

/**
 * 解除时必须重新校验的四项事实，由调用方从权威源读取后传入。
 *
 * 域层不查 Git、不读 lease、不算预算，因此这四项以布尔事实入参，而不是让域函数自己去取。
 */
export type LaneRevalidationFacts = {
  readonly scope: boolean;
  readonly ownership: boolean;
  readonly revision: boolean;
  readonly budget: boolean;
};

export const LANE_RELEASE_REJECTION_CODES = [
  'indeterminate',
  'scope_mismatch',
  'ownership_mismatch',
  'revision_mismatch',
  'budget_exhausted',
] as const;

export type LaneReleaseRejectionCode = (typeof LANE_RELEASE_REJECTION_CODES)[number];

export type LaneReleaseRequest = {
  readonly lane: MutationLaneRecord;
  readonly resolution: LaneResolutionFact;
  readonly revalidation: LaneRevalidationFacts;
};

export type LaneReleaseDecision =
  | { readonly kind: 'released'; readonly laneKey: string }
  | {
      readonly kind: 'rejected';
      readonly laneKey: string;
      readonly code: LaneReleaseRejectionCode;
      readonly message: string;
    };

/**
 * 解除前置判定。
 *
 * 顺序刻意固定：先要求确定结论或用户补充事实，再按 scope → ownership → revision → 预算重验。
 * 任一项不成立就拒绝，且拒绝不产生任何副作用——调用方拿到拒绝原因后仍保持 lane 阻塞。
 */
export function checkLaneRelease(request: LaneReleaseRequest): LaneReleaseDecision {
  const { lane, resolution, revalidation } = request;
  const reject = (code: LaneReleaseRejectionCode, message: string): LaneReleaseDecision => ({
    kind: 'rejected',
    laneKey: lane.laneKey,
    code,
    message,
  });

  if (resolution === 'indeterminate') {
    return reject('indeterminate', `lane ${lane.laneKey} 尚未得出确定结论，也没有用户补充的可判定事实`);
  }
  if (!revalidation.scope) {
    return reject('scope_mismatch', `lane ${lane.laneKey} 的事实不属于当前 Coordination Scope`);
  }
  if (!revalidation.ownership) {
    return reject('ownership_mismatch', `lane ${lane.laneKey} 的目标所有权已变化`);
  }
  if (!revalidation.revision) {
    return reject('revision_mismatch', `lane ${lane.laneKey} 的 revision 已过期`);
  }
  if (!revalidation.budget) {
    return reject('budget_exhausted', `lane ${lane.laneKey} 的预算不允许继续`);
  }
  return { kind: 'released', laneKey: lane.laneKey };
}
