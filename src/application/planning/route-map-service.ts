/**
 * IC-05：Route Planning 的语义操作（Owner: `m1-plan-and-authorize-execution`）。
 *
 * 规划事实的唯一权威是 issue tracker：这个模块只做三件事——把地图正文按固定章节读写、把 Ticket
 * Claim 的可见部分写回 tracker assignee、并把每次外部写入纳入 Operation Intent 纪律
 * （先落盘意图，再调用 tracker，最后读回核验并收尾）。
 *
 * 它不保存地图或票据正文的副本，也不把 tracker 的错误码词表搬进 Companion：读取失败一律归为
 * `unavailable`（可证明没发生副作用）或 `unknown`（不能证明）。结果不明时意图保持未决、地图
 * revision 不推进，调用方必须用同一 OperationId 对账，而不是换一个 ID 重试（D1/D18）。
 */

import type { IntentOutcomeClass } from '../dto/operation-intent.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  EntityRef,
  OperationId,
  PlanningCycleId,
  Revision,
} from '../dto/identity.js';
import type {
  BranchCoordinationStore,
  CoordinationCommandRejection,
  CoordinationWriter,
} from '../ports/branch-coordination-store.js';
import { readScope, type ScopeReadResult } from './scope-read.js';
import {
  parseRouteMapSections,
  renderRouteMapSection,
  routeMapSnapshot,
  type DecisionTicketRef,
  type RouteMapRef,
  type RouteMapSection,
  type RouteMapSnapshot,
} from '../../domain/planning/route-map.js';

// ---------------------------------------------------------------------------
// Tracker seam
// ---------------------------------------------------------------------------

export type TrackerIssueState = 'open' | 'closed';

export type TrackerIssue = {
  readonly ref: EntityRef<string>;
  readonly title: string;
  readonly body: string;
  readonly state: TrackerIssueState;
  readonly assignees: readonly string[];
};

/**
 * 读取结果必须能区分「确实不存在」与「不能证明读到了」：前者允许调用方继续判断，后者只允许
 * 阻塞或对账。`unavailable` 表示没有取得任何 tracker 回应，`unknown` 表示回应不可判定。
 */
export type TrackerReadOutcome =
  | { readonly kind: 'read'; readonly issue: TrackerIssue }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unavailable'; readonly message: string }
  | { readonly kind: 'unknown'; readonly reason: string };

export type TrackerWriteOutcome =
  | { readonly kind: 'accepted'; readonly requestId?: string }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string }
  | { readonly kind: 'unknown'; readonly reason: string };

/** tracker 只能通过这个接缝访问；Companion 不接受任意 tracker 命令或凭据。 */
export interface IssueTrackerGateway {
  readIssue(ref: EntityRef<string>): Promise<TrackerReadOutcome>;
  updateIssueBody(input: { readonly ref: EntityRef<string>; readonly body: string }): Promise<TrackerWriteOutcome>;
  assignIssue(input: {
    readonly ref: EntityRef<string>;
    readonly assignee: string | null;
  }): Promise<TrackerWriteOutcome>;
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

export type RouteMapReadInput = {
  readonly tracker: IssueTrackerGateway;
  readonly routeMapRef: RouteMapRef;
  readonly planningCycleId: PlanningCycleId;
};

export type RouteMapReadResult =
  | { readonly kind: 'read'; readonly snapshot: RouteMapSnapshot }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unavailable'; readonly message: string }
  | { readonly kind: 'unknown'; readonly reason: string };

/** 读取当前 Route Map：正文来自 tracker，本地只补上引用与 Planning Cycle。 */
export async function readRouteMap(input: RouteMapReadInput): Promise<RouteMapReadResult> {
  const read = await input.tracker.readIssue(input.routeMapRef);
  switch (read.kind) {
    case 'read':
      return {
        kind: 'read',
        snapshot: routeMapSnapshot(input.routeMapRef, input.planningCycleId, read.issue.body),
      };
    case 'not_found':
      return { kind: 'not_found' };
    case 'unavailable':
      return { kind: 'unavailable', message: read.message };
    case 'unknown':
      return { kind: 'unknown', reason: read.reason };
  }
}

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

export type PlanningMutationContext = {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly writer: CoordinationWriter;
  /** 本次外部副作用自己的 OperationId；未决时对账必须沿用同一个。 */
  readonly operationId: OperationId;
  readonly expectedRevision: Revision;
  readonly routeMapRef: RouteMapRef;
  readonly planningCycleId: PlanningCycleId;
};

export type PlanningMutationResult =
  | {
      readonly kind: 'accepted';
      /** 写入完成后的 Scope revision。 */
      readonly revision: Revision;
      /** 写入完成后地图 revision 推进到的新值。 */
      readonly mapRevision: Revision;
    }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string }
  | { readonly kind: 'unknown'; readonly reason: string };

function scopeOf(context: PlanningMutationContext): ScopeReadResult {
  return readScope(context.store, context.coordinationScopeId);
}

function rejectionMessage(rejection: CoordinationCommandRejection): string {
  return rejection.message;
}

function fromReadFailure(failure: {
  readonly kind: 'not_found' | 'unavailable' | 'unknown';
  readonly message?: string;
  readonly reason?: string;
}, id: string): PlanningMutationResult {
  if (failure.kind === 'not_found') {
    return { kind: 'rejected', code: 'not_found', message: `票据 ${id} 不存在` };
  }
  if (failure.kind === 'unavailable') {
    return { kind: 'rejected', code: 'unavailable', message: failure.message ?? 'tracker 不可达' };
  }
  return { kind: 'unknown', reason: failure.reason ?? 'tracker 回应不可判定' };
}

/**
 * 一次 tracker 写入的完整纪律：落盘意图 → 外部写入 → 读回核验 → 收尾意图 → 推进地图 revision。
 *
 * 任一环节不能证明结果时保持意图未决并返回 `unknown`：地图 revision 不推进，因此「候选图是否
 * 过期」不会被一次结果不明的写入蒙混过去。
 */
async function runTrackerMutation(input: {
  readonly context: PlanningMutationContext;
  readonly target: EntityRef<string>;
  readonly operationCategory: string;
  readonly perform: () => Promise<TrackerWriteOutcome>;
  readonly verify: () => Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;
}): Promise<PlanningMutationResult> {
  const { context } = input;
  const begun = context.store.transact({
    kind: 'begin-intent',
    coordinationScopeId: context.coordinationScopeId,
    expectedRevision: context.expectedRevision,
    writer: context.writer,
    operationId: context.operationId,
    target: input.target,
    operationCategory: input.operationCategory,
  });
  if (begun.kind === 'rejected') {
    return { kind: 'rejected', code: begun.code, message: rejectionMessage(begun) };
  }

  const write = await input.perform();
  if (write.kind === 'unknown') {
    return { kind: 'unknown', reason: write.reason };
  }

  const settle = (outcomeClass: IntentOutcomeClass, backendRequestId?: string): string | null => {
    const current = scopeOf(context);
    if (current.kind === 'rejected') {
      return `${current.message}；意图 ${context.operationId} 未收尾`;
    }
    const settled = context.store.transact({
      kind: 'settle-intent',
      coordinationScopeId: context.coordinationScopeId,
      expectedRevision: current.scope.revision,
      writer: context.writer,
      operationId: context.operationId,
      outcomeClass,
      ...(backendRequestId === undefined ? {} : { backendRequestId }),
    });
    return settled.kind === 'rejected' ? `${rejectionMessage(settled)}；意图 ${context.operationId} 未收尾` : null;
  };

  if (write.kind === 'rejected') {
    const unsettled = settle('rejected');
    return unsettled === null
      ? { kind: 'rejected', code: write.code, message: write.message }
      : { kind: 'unknown', reason: unsettled };
  }

  const verified = await input.verify();
  if (!verified.ok) {
    return { kind: 'unknown', reason: `读回核验失败：${verified.reason}` };
  }

  const unsettled = settle('accepted', write.requestId);
  if (unsettled !== null) {
    return { kind: 'unknown', reason: unsettled };
  }

  const after = scopeOf(context);
  if (after.kind === 'rejected') {
    return { kind: 'unknown', reason: `${after.message}；地图 revision 未推进` };
  }
  const advanced = context.store.transact({
    kind: 'advance-map-revision',
    coordinationScopeId: context.coordinationScopeId,
    expectedRevision: after.scope.revision,
    writer: context.writer,
    mapRevision: after.scope.mapRevision + 1,
  });
  if (advanced.kind === 'rejected') {
    return { kind: 'unknown', reason: `${rejectionMessage(advanced)}；地图 revision 未推进` };
  }
  return { kind: 'accepted', revision: advanced.revision, mapRevision: after.scope.mapRevision + 1 };
}

async function readMapBody(
  tracker: IssueTrackerGateway,
  routeMapRef: RouteMapRef,
): Promise<{ readonly kind: 'body'; readonly body: string } | { readonly kind: 'failed'; readonly result: PlanningMutationResult }> {
  const read = await tracker.readIssue(routeMapRef);
  return read.kind === 'read'
    ? { kind: 'body', body: read.issue.body }
    : { kind: 'failed', result: fromReadFailure(read, routeMapRef.id) };
}

function readFailureAsWriteOutcome(result: PlanningMutationResult): TrackerWriteOutcome {
  if (result.kind === 'unknown') {
    return result;
  }
  return result.kind === 'rejected'
    ? { kind: 'rejected', code: result.code, message: result.message }
    : { kind: 'unknown', reason: '读取意外返回写入成功' };
}

export type UpdateRouteMapSectionInput = PlanningMutationContext & {
  readonly tracker: IssueTrackerGateway;
  readonly section: RouteMapSection;
  /** 目标章节的完整正文；只替换该章节，其它章节原样保留。 */
  readonly content: string;
};

/**
 * 按固定章节写入地图。
 *
 * 只替换目标章节的正文：其它章节的内容与顺序保持不变，因此「复述已解决决策」不会新增章节结构，
 * 也不会在 tracker 上产生第二份地图。
 */
export async function updateRouteMapSection(input: UpdateRouteMapSectionInput): Promise<PlanningMutationResult> {
  let nextBody: string | null = null;

  return await runTrackerMutation({
    context: input,
    target: input.routeMapRef,
    operationCategory: 'route-map-section-update',
    perform: async () => {
      const current = await readMapBody(input.tracker, input.routeMapRef);
      if (current.kind === 'failed') {
        return readFailureAsWriteOutcome(current.result);
      }
      nextBody = renderRouteMapSection(current.body, input.section, input.content);
      return await input.tracker.updateIssueBody({ ref: input.routeMapRef, body: nextBody });
    },
    verify: async () => {
      if (nextBody === null) {
        return { ok: false, reason: '写入正文尚未生成' };
      }
      const reread = await input.tracker.readIssue(input.routeMapRef);
      if (reread.kind !== 'read') {
        return { ok: false, reason: reread.kind };
      }
      return parseRouteMapSections(reread.issue.body)[input.section] ===
        parseRouteMapSections(nextBody)[input.section]
        ? { ok: true }
        : { ok: false, reason: `章节 ${input.section} 读回内容与写入不一致` };
    },
  });
}

// ---------------------------------------------------------------------------
// Ticket Claim
// ---------------------------------------------------------------------------

type ClaimLookup =
  | { readonly kind: 'free' }
  | { readonly kind: 'held'; readonly coordinatorSessionId: CoordinatorSessionId }
  | { readonly kind: 'rejected'; readonly message: string };

function activeClaimLookup(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
  ticket: EntityRef<string>,
): ClaimLookup {
  const snapshot = store.query({ kind: 'snapshot', coordinationScopeId });
  if (snapshot.kind === 'rejected') {
    return { kind: 'rejected', message: snapshot.message };
  }
  if (snapshot.kind !== 'snapshot') {
    return { kind: 'rejected', message: '无法读取 Ticket Claim 快照' };
  }
  const active = snapshot.snapshot.ticketClaims.find(
    (claim) => claim.state === 'active' && claim.ticketRef.kind === ticket.kind && claim.ticketRef.id === ticket.id,
  );
  return active === undefined ? { kind: 'free' } : { kind: 'held', coordinatorSessionId: active.coordinatorSessionId };
}

export type TicketMutationInput = PlanningMutationContext & {
  readonly tracker: IssueTrackerGateway;
  readonly ticketRef: DecisionTicketRef;
};

export type ClaimTicketInput = TicketMutationInput & {
  /** tracker 侧的可见认领标识（当前为项目配置的 tracker 身份）。 */
  readonly trackerAssignee: string;
};

/**
 * 认领一张 Decision Ticket：先取得 tracker assignee（可见部分），再写本地 Session 记录（权威部分）。
 *
 * 两者必须同时成立；本地已有他人活跃 claim 时直接拒绝，不会去改写别人的 assignee。
 */
export async function claimTicket(input: ClaimTicketInput): Promise<PlanningMutationResult> {
  const owner = activeClaimLookup(input.store, input.coordinationScopeId, input.ticketRef);
  if (owner.kind === 'rejected') {
    return { kind: 'rejected', code: 'invalid_state', message: owner.message };
  }
  if (owner.kind === 'held' && owner.coordinatorSessionId !== input.writer.coordinatorSessionId) {
    return {
      kind: 'rejected',
      code: 'claim_conflict',
      message: `票据 ${input.ticketRef.id} 已由 ${owner.coordinatorSessionId} 认领`,
    };
  }

  const claimed = await runTrackerMutation({
    context: input,
    target: input.ticketRef,
    operationCategory: 'ticket-claim',
    perform: async () => await input.tracker.assignIssue({ ref: input.ticketRef, assignee: input.trackerAssignee }),
    verify: async () => {
      const reread = await input.tracker.readIssue(input.ticketRef);
      if (reread.kind !== 'read') {
        return { ok: false, reason: reread.kind };
      }
      return reread.issue.assignees.includes(input.trackerAssignee)
        ? { ok: true }
        : { ok: false, reason: `assignee ${input.trackerAssignee} 未出现在票据上` };
    },
  });
  if (claimed.kind !== 'accepted') {
    return claimed;
  }

  const current = scopeOf(input);
  if (current.kind === 'rejected') {
    return { kind: 'unknown', reason: `${current.message}；assignee 已写入但本地 claim 未登记` };
  }
  const recorded = input.store.transact({
    kind: 'record-ticket-claim',
    coordinationScopeId: input.coordinationScopeId,
    expectedRevision: current.scope.revision,
    writer: input.writer,
    ticketRef: input.ticketRef,
  });
  if (recorded.kind === 'rejected') {
    return { kind: 'unknown', reason: `${rejectionMessage(recorded)}；assignee 已写入但本地 claim 未登记` };
  }
  return { ...claimed, revision: recorded.revision };
}

export type ReleaseTicketInput = TicketMutationInput;

/** 释放一张票据的认领：assignee 清空与本地记录收尾都发生，且顺序固定。 */
export async function releaseTicket(input: ReleaseTicketInput): Promise<PlanningMutationResult> {
  return await finishClaim(input, 'released');
}

async function finishClaim(
  input: TicketMutationInput,
  finalState: 'completed' | 'released',
): Promise<PlanningMutationResult> {
  const released = await runTrackerMutation({
    context: input,
    target: input.ticketRef,
    operationCategory: 'ticket-release',
    perform: async () => await input.tracker.assignIssue({ ref: input.ticketRef, assignee: null }),
    verify: async () => {
      const reread = await input.tracker.readIssue(input.ticketRef);
      if (reread.kind !== 'read') {
        return { ok: false, reason: reread.kind };
      }
      return reread.issue.assignees.length === 0 ? { ok: true } : { ok: false, reason: 'assignee 未被清空' };
    },
  });
  if (released.kind !== 'accepted') {
    return released;
  }

  const current = scopeOf(input);
  if (current.kind === 'rejected') {
    return { kind: 'unknown', reason: `${current.message}；assignee 已清空但本地 claim 未收尾` };
  }
  const finished = input.store.transact({
    kind: 'release-ticket-claim',
    coordinationScopeId: input.coordinationScopeId,
    expectedRevision: current.scope.revision,
    writer: input.writer,
    ticketRef: input.ticketRef,
    finalState,
  });
  if (finished.kind === 'rejected') {
    return { kind: 'unknown', reason: `${rejectionMessage(finished)}；assignee 已清空但本地 claim 未收尾` };
  }
  return { ...released, revision: finished.revision };
}

export type ResolveTicketInput = TicketMutationInput & {
  /** 已解决决策的结论；写入既有的 `resolved decisions` 章节。 */
  readonly resolution: string;
  /** 地图正文更新是一次独立副作用，因此有自己的 OperationId。 */
  readonly mapOperationId: OperationId;
};

function stripTicketLines(section: string, ticketId: string): string {
  return section
    .split('\n')
    .filter((line) => !line.includes(ticketId))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\s+$/, '');
}

/**
 * 解决一张 Decision Ticket：清空 assignee、把本地 claim 收尾为 completed，并把结论写进既有的
 * `resolved decisions` 章节、从 `open decision tickets` 移除该票据。
 *
 * 地图正文更新使用独立的 OperationId：它是一次独立的 tracker 副作用，未决时必须单独对账。
 */
export async function resolveTicket(input: ResolveTicketInput): Promise<PlanningMutationResult> {
  const releasedResult = await finishClaim(input, 'completed');
  if (releasedResult.kind !== 'accepted') {
    return releasedResult;
  }

  let nextBody: string | null = null;

  return await runTrackerMutation({
    context: { ...input, operationId: input.mapOperationId, expectedRevision: releasedResult.revision },
    target: input.routeMapRef,
    operationCategory: 'route-map-section-update',
    perform: async () => {
      const mapBody = await readMapBody(input.tracker, input.routeMapRef);
      if (mapBody.kind === 'failed') {
        return readFailureAsWriteOutcome(mapBody.result);
      }
      const sections = parseRouteMapSections(mapBody.body);
      const resolvedSection = [sections.resolved_decisions, `- ${input.ticketRef.id}: ${input.resolution}`]
        .filter((entry) => entry.trim().length > 0)
        .join('\n');
      const openSection = stripTicketLines(sections.open_decision_tickets, input.ticketRef.id);
      nextBody = renderRouteMapSection(
        renderRouteMapSection(mapBody.body, 'resolved_decisions', resolvedSection),
        'open_decision_tickets',
        openSection,
      );
      return await input.tracker.updateIssueBody({ ref: input.routeMapRef, body: nextBody });
    },
    verify: async () => {
      if (nextBody === null) {
        return { ok: false, reason: '写入正文尚未生成' };
      }
      const reread = await input.tracker.readIssue(input.routeMapRef);
      if (reread.kind !== 'read') {
        return { ok: false, reason: reread.kind };
      }
      const rereadSections = parseRouteMapSections(reread.issue.body);
      const expectedSections = parseRouteMapSections(nextBody);
      return rereadSections.resolved_decisions === expectedSections.resolved_decisions &&
        rereadSections.open_decision_tickets === expectedSections.open_decision_tickets
        ? { ok: true }
        : { ok: false, reason: 'resolved decisions 或 open decision tickets 读回内容与写入不一致' };
    },
  });
}
