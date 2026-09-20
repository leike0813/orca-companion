/**
 * IC-05：Ticket Claim 与 Frontier 的纯判定（Owner: `m1-plan-and-authorize-execution`）。
 *
 * Claim 由 tracker assignee（可见部分）与该 Session 的本地记录（权威部分）共同表达（D3）。
 * 这里只做投影：一个开放、未阻塞、未被任何 Session 认领的票据才出现在 Frontier。Claim 不随
 * Runtime Incarnation 退出而释放——本模块因此没有「按存活时间过期」的路径。
 */

import type { CoordinatorSessionId, EntityRef } from '../../application/dto/identity.js';
import type { DecisionTicket } from './route-map.js';

export const TICKET_CLAIM_STATES = ['active', 'completed', 'released'] as const;

export type TicketClaimState = (typeof TICKET_CLAIM_STATES)[number];

/**
 * Claim 的最小投影形状。
 *
 * 本地持久化记录与领域值共享这个形状：投影只需要「谁、认领了哪张票、是否仍然活跃」，因此调用方
 * 不必为了算一次 Frontier 而构造另一份记录类型。
 */
export type ClaimProjection = {
  readonly ticketRef: EntityRef<string>;
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly state: TicketClaimState;
};

export type TicketClaim = ClaimProjection & {
  readonly claimedAt: number;
};

/** 只有 active claim 阻止其他 Session 认领同一票据。 */
export function activeClaimFor(
  claims: readonly ClaimProjection[],
  ticketRef: EntityRef<string>,
): ClaimProjection | null {
  return (
    claims.find(
      (claim) => claim.state === 'active' && claim.ticketRef.kind === ticketRef.kind && claim.ticketRef.id === ticketRef.id,
    ) ?? null
  );
}

/** 一个票据是否还能被某个 Session 认领；`null` 表示可以。 */
export function claimBlocker(
  claims: readonly ClaimProjection[],
  ticketRef: EntityRef<string>,
): { readonly kind: 'claimed'; readonly claim: ClaimProjection } | null {
  const claim = activeClaimFor(claims, ticketRef);
  return claim === null ? null : { kind: 'claimed', claim };
}

/**
 * Frontier 投影：开放、无未解决阻塞、且未被认领的票据。
 *
 * 已认领的票据对任何 Session 都不再出现在 Frontier —— 认领方自己也不再需要它，而未认领方
 * 必须看不到它，这正是「已认领票据不出现在其他 Session 的 Frontier 中」的可观察形式。
 */
export function projectFrontier(input: {
  readonly tickets: readonly DecisionTicket[];
  readonly claims: readonly ClaimProjection[];
}): readonly DecisionTicket[] {
  return input.tickets.filter(
    (ticket) =>
      ticket.state === 'open' &&
      ticket.blockedBy.length === 0 &&
      activeClaimFor(input.claims, ticket.ticketRef) === null,
  );
}

/** 某个 Session 当前持有的活跃票据。 */
export function claimedTickets(
  claims: readonly ClaimProjection[],
  coordinatorSessionId: CoordinatorSessionId,
): readonly EntityRef<string>[] {
  return claims
    .filter((claim) => claim.state === 'active' && claim.coordinatorSessionId === coordinatorSessionId)
    .map((claim) => claim.ticketRef);
}

/** 存在开放票据或 fog 时不得进入 Execution Coordination；两者都是门禁输入。 */
export function hasOpenPlanningWork(input: {
  readonly frontier: readonly DecisionTicket[];
  readonly fog: string;
}): boolean {
  return input.frontier.length > 0 || input.fog.trim().length > 0;
}
