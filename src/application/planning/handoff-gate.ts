/**
 * IC-05：进入 Execution Coordination 的门禁（Owner: `m1-plan-and-authorize-execution`）。
 *
 * 门禁是 Controller 的论断，不是模型的宣告（D11）：每个条件都从持久事实与 tracker 正文投影出来，
 * 模型无法通过「认为自己准备好了」满足其中任何一条。判定本身是纯函数，输入是已经读好的事实，
 * 因此同一条门禁在真实运行与故障注入测试里走的是同一段代码。
 */

import {
  manifestCandidateMismatches,
  type ExecutionAuthorizationRecord,
} from '../../domain/planning/execution-authorization.js';
import type { GraphVersionRecord } from '../../domain/planning/execution-graph.js';
import type { DecisionTicket, RouteMapSnapshot } from '../../domain/planning/route-map.js';
import type { CoordinationSnapshot } from '../ports/branch-coordination-store.js';

export const HANDOFF_BLOCKER_CODES = [
  'open_decision_tickets',
  'fog_present',
  'pending_interactions',
  'unfinished_mutations',
  'plan_not_bound_to_current_map',
  'compilation_not_accepted',
  'authorization_missing',
] as const;

export type HandoffBlockerCode = (typeof HANDOFF_BLOCKER_CODES)[number];

export type HandoffBlocker = {
  readonly code: HandoffBlockerCode;
  readonly message: string;
};

export type HandoffGateFacts = {
  readonly openDecisionTickets: number;
  readonly fogPresent: boolean;
  readonly unresolvedInteractions: number;
  readonly unresolvedMutations: number;
  readonly currentMapRevision: number;
  readonly currentPlanRevision: number;
  readonly candidate: GraphVersionRecord | null;
  readonly authorization: ExecutionAuthorizationRecord | null;
};

export type HandoffGateResult =
  | { readonly kind: 'allowed' }
  | { readonly kind: 'blocked'; readonly blockers: readonly HandoffBlocker[] };

export type HandoffGateFactInput = {
  readonly snapshot: CoordinationSnapshot;
  readonly tickets: readonly DecisionTicket[];
  readonly routeMap: RouteMapSnapshot;
  readonly currentPlanRevision: number;
  readonly candidate: GraphVersionRecord | null;
  readonly authorization: ExecutionAuthorizationRecord | null;
};

/**
 * 把只读快照、tracker 票据与候选图投影成门禁事实。
 *
 * 门禁统计全部开放票据，不复用 Frontier：已认领或被依赖阻塞的票据仍然是开放票据，必须继续阻塞切换。
 */
export function handoffGateFacts(input: HandoffGateFactInput): HandoffGateFacts {
  return {
    openDecisionTickets: input.tickets.filter((ticket) => ticket.state === 'open').length,
    fogPresent: input.routeMap.sections.fog.trim().length > 0,
    unresolvedInteractions: input.snapshot.pendingInteractions.filter((entry) => entry.state === 'open').length,
    unresolvedMutations: input.snapshot.unresolvedIntents.length,
    currentMapRevision: input.snapshot.scope.mapRevision,
    currentPlanRevision: input.currentPlanRevision,
    candidate: input.candidate,
    authorization: input.authorization,
  };
}

function blocker(code: HandoffBlockerCode, message: string): HandoffBlocker {
  return { code, message };
}

/**
 * 判定是否允许从 `route_planning` 切换到 `execution_coordination`。
 *
 * 条件之间没有优先级：只要还有一条不满足就整体拒绝，并把全部阻塞项一起报出——用户需要知道的是
 * 「还差什么」，而不是被逐个条件来回挡。
 */
export function evaluateHandoffGate(facts: HandoffGateFacts): HandoffGateResult {
  const blockers: HandoffBlocker[] = [];
  if (facts.openDecisionTickets > 0) {
    blockers.push(
      blocker('open_decision_tickets', `仍有 ${facts.openDecisionTickets} 张开放 Decision Ticket`),
    );
  }
  if (facts.fogPresent) {
    blockers.push(blocker('fog_present', 'Route Map 的 fog 章节尚未清空'));
  }
  if (facts.unresolvedInteractions > 0) {
    blockers.push(
      blocker('pending_interactions', `仍有 ${facts.unresolvedInteractions} 个未决 Pending Interaction`),
    );
  }
  if (facts.unresolvedMutations > 0) {
    blockers.push(blocker('unfinished_mutations', `仍有 ${facts.unresolvedMutations} 个未完成 mutation 意图`));
  }

  const candidate = facts.candidate;
  if (candidate === null) {
    blockers.push(blocker('compilation_not_accepted', '尚未存在被接受的候选 Execution Graph'));
  } else if (candidate.planRevision !== facts.currentPlanRevision) {
    blockers.push(blocker('plan_not_bound_to_current_map', '候选图绑定的计划 revision 已不是当前计划'));
  } else if (candidate.mapRevision !== facts.currentMapRevision) {
    blockers.push(
      blocker(
        'plan_not_bound_to_current_map',
        `候选图绑定地图 revision ${candidate.mapRevision}，当前为 ${facts.currentMapRevision}`,
      ),
    );
  }

  const authorization = facts.authorization;
  if (authorization === null) {
    blockers.push(blocker('authorization_missing', '用户尚未批准完整 Execution Authorization Manifest'));
  } else if (
    candidate !== null &&
    manifestCandidateMismatches(authorization.manifest, candidate).length > 0
  ) {
    blockers.push(
      blocker('authorization_missing', '已批准的 Manifest 绑定的是另一版候选图，需要重新批准'),
    );
  }

  return blockers.length === 0 ? { kind: 'allowed' } : { kind: 'blocked', blockers };
}
