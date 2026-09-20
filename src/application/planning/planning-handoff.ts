/**
 * IC-05：Route Planning 责任的三阶段交接
 * （Owner: `m1-plan-and-authorize-execution`）。
 *
 * 规划责任决定「谁能改 Route Map」，所以它的转移必须是显式的、可复核的、可恢复的：prepare 只产出
 * 提案并保持原责任方，review 由接收 Session 独立复核提案引用的事实，cutover 才把责任落盘转移
 * （D12）。任何阶段未完成时责任仍在原 Session，且 store 的部分唯一索引保证同一 Scope 最多只有一个
 * 未终结提案、`planning_responsibility` 最多只有一行。
 *
 * 交接的作用域只有 Route Planning 责任：它不释放、不停止、不重新归属 Execution Coordination 下
 * 已在途的 Worker、Dispatch、Task，也不改变 Execution Coordination Lease 的持有者（D13）。因此本
 * 模块不读写 lease，也不触碰任何 Worker 事实。
 *
 * 交接提案只承载「Route Planning 责任」这一项责任集合：Source/Target 与 cutover 阶段就是它的完整
 * 表达，因此不为一个恒定集合增加字段。
 */

import type { GraphVersionRecord } from '../../domain/planning/execution-graph.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  GraphId,
  GraphVersion,
  Revision,
} from '../dto/identity.js';
import type {
  BranchCoordinationStore,
  CoordinationWriter,
  PlanningHandoffPhase,
  PlanningHandoffRecord,
  PlanningResponsibilityRecord,
} from '../ports/branch-coordination-store.js';
import { readScope, type ScopeReadResult } from './scope-read.js';

export type PlanningHandoffProposal = PlanningHandoffRecord;

export type PlanningHandoffFailure = {
  readonly code: string;
  readonly message: string;
};

export type PlanningHandoffResult =
  | {
      readonly kind: 'prepared' | 'reviewed' | 'cutover' | 'cancelled';
      readonly proposal: PlanningHandoffProposal;
    }
  | { readonly kind: 'rejected'; readonly failure: PlanningHandoffFailure };

type ScopeRevisionRead =
  | { readonly kind: 'read'; readonly revision: Revision }
  | { readonly kind: 'rejected'; readonly failure: PlanningHandoffFailure };

function readScopeRevision(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
): ScopeRevisionRead {
  const scope: ScopeReadResult = readScope(store, coordinationScopeId);
  return scope.kind === 'rejected'
    ? { kind: 'rejected', failure: { code: scope.code, message: scope.message } }
    : { kind: 'read', revision: scope.scope.revision };
}

function readProposal(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
  proposalId: string,
): { readonly kind: 'read'; readonly proposal: PlanningHandoffProposal | null } | { readonly kind: 'rejected'; readonly failure: PlanningHandoffFailure } {
  const result = store.query({ kind: 'planning-handoff', coordinationScopeId, proposalId });
  if (result.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: result.code, message: result.message } };
  }
  if (result.kind !== 'planning-handoff') {
    return { kind: 'rejected', failure: { code: 'invalid_state', message: '无法读取交接提案' } };
  }
  return { kind: 'read', proposal: result.handoff };
}

function readResponsibility(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
): PlanningResponsibilityRecord | null {
  const result = store.query({ kind: 'planning-responsibility', coordinationScopeId });
  return result.kind === 'planning-responsibility' ? result.responsibility : null;
}

export type PreparePlanningHandoffInput = {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly writer: CoordinationWriter;
  readonly proposalId: string;
  readonly targetCoordinatorSessionId: CoordinatorSessionId;
  readonly mapRevision: Revision;
  readonly planRevision: Revision;
  readonly graphId: GraphId | null;
  readonly graphVersion: GraphVersion | null;
  /** 可移植 Coordinator Context Capsule 的引用；本库不保存 Capsule 内容。 */
  readonly capsuleRef: string | null;
};

/**
 * prepare 阶段：落盘提案，责任仍归原 Session。
 *
 * 只有当前规划责任方可以发起交接：一个已经失去责任的 Session 不能再把责任转交出去。
 */
export function preparePlanningHandoff(input: PreparePlanningHandoffInput): PlanningHandoffResult {
  if ((input.graphId === null) !== (input.graphVersion === null)) {
    return {
      kind: 'rejected',
      failure: { code: 'invalid_argument', message: 'graphId 与 graphVersion 必须同时存在或同时为空' },
    };
  }
  const responsibility = readResponsibility(input.store, input.coordinationScopeId);
  if (
    responsibility !== null &&
    responsibility.coordinatorSessionId !== input.writer.coordinatorSessionId
  ) {
    return {
      kind: 'rejected',
      failure: {
        code: 'not_planning_owner',
        message: `当前规划责任方是 ${responsibility.coordinatorSessionId}，不能发起交接`,
      },
    };
  }
  if (input.targetCoordinatorSessionId === input.writer.coordinatorSessionId) {
    return {
      kind: 'rejected',
      failure: { code: 'invalid_argument', message: '交接的 Source 与 Target 不能是同一个 Session' },
    };
  }
  const scope = readScopeRevision(input.store, input.coordinationScopeId);
  if (scope.kind === 'rejected') {
    return { kind: 'rejected', failure: scope.failure };
  }
  const created = input.store.transact({
    kind: 'record-planning-handoff',
    coordinationScopeId: input.coordinationScopeId,
    expectedRevision: scope.revision,
    writer: input.writer,
    proposalId: input.proposalId,
    sourceCoordinatorSessionId: input.writer.coordinatorSessionId,
    targetCoordinatorSessionId: input.targetCoordinatorSessionId,
    phase: 'prepared',
    mapRevision: input.mapRevision,
    planRevision: input.planRevision,
    graphId: input.graphId,
    graphVersion: input.graphVersion,
    capsuleRef: input.capsuleRef,
    expectedProposalRevision: null,
  });
  if (created.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: created.code, message: created.message } };
  }
  return readBack(input.store, input.coordinationScopeId, input.proposalId, 'prepared');
}

function readBack(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
  proposalId: string,
  expectedKind: 'prepared' | 'reviewed' | 'cutover' | 'cancelled',
): PlanningHandoffResult {
  const read = readProposal(store, coordinationScopeId, proposalId);
  if (read.kind === 'rejected') {
    return { kind: 'rejected', failure: read.failure };
  }
  if (read.proposal === null) {
    return {
      kind: 'rejected',
      failure: { code: 'invalid_state', message: '交接提案写入后无法读回' },
    };
  }
  return { kind: expectedKind, proposal: read.proposal };
}

export type HandoffReviewFacts = {
  readonly currentMapRevision: Revision;
  readonly currentPlanRevision: Revision;
  readonly openDecisionTickets: number;
  readonly candidate: GraphVersionRecord | null;
};

export type ReviewPlanningHandoffInput = {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly writer: CoordinationWriter;
  readonly proposalId: string;
  readonly facts: HandoffReviewFacts;
};

/**
 * review 阶段：接收 Session 独立复核提案引用的事实。
 *
 * 复核失败时保持原责任方并说明原因——复核是接收方拒绝接手的正式出口，而不是走过场。
 */
export function reviewPlanningHandoff(input: ReviewPlanningHandoffInput): PlanningHandoffResult {
  const read = readProposal(input.store, input.coordinationScopeId, input.proposalId);
  if (read.kind === 'rejected') {
    return { kind: 'rejected', failure: read.failure };
  }
  const proposal = read.proposal;
  if (proposal === null) {
    return { kind: 'rejected', failure: { code: 'not_found', message: `交接提案 ${input.proposalId} 不存在` } };
  }
  if (proposal.targetCoordinatorSessionId !== input.writer.coordinatorSessionId) {
    return {
      kind: 'rejected',
      failure: { code: 'not_reviewer', message: '只有提案的接收 Session 可以复核它' },
    };
  }
  if (proposal.phase !== 'prepared') {
    return {
      kind: 'rejected',
      failure: { code: 'invalid_state', message: `提案处于 ${proposal.phase}，不能复核` },
    };
  }
  const staleReason = reviewFailureReason(proposal, input.facts);
  if (staleReason !== null) {
    return { kind: 'rejected', failure: { code: 'review_failed', message: staleReason } };
  }
  return applyPhase(input.store, input.coordinationScopeId, input.writer, proposal, 'reviewed', 'reviewed');
}

function reviewFailureReason(proposal: PlanningHandoffProposal, facts: HandoffReviewFacts): string | null {
  if (proposal.mapRevision !== facts.currentMapRevision) {
    return `提案引用地图 revision ${proposal.mapRevision}，当前为 ${facts.currentMapRevision}`;
  }
  if (proposal.planRevision !== facts.currentPlanRevision) {
    return `提案引用计划 revision ${proposal.planRevision}，当前为 ${facts.currentPlanRevision}`;
  }
  if (facts.openDecisionTickets > 0) {
    return `仍有 ${facts.openDecisionTickets} 张开放 Decision Ticket`;
  }
  if (proposal.graphId !== null) {
    if (facts.candidate === null) {
      return '提案引用的候选图已不存在';
    }
    if (facts.candidate.graphId !== proposal.graphId || facts.candidate.version !== proposal.graphVersion) {
      return '提案引用的候选图已被替换';
    }
  } else if (facts.candidate !== null) {
    return '候选图状态已变化';
  }
  return null;
}

function applyPhase(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
  writer: CoordinationWriter,
  proposal: PlanningHandoffProposal,
  phase: PlanningHandoffPhase,
  expectedKind: 'prepared' | 'reviewed' | 'cutover',
): PlanningHandoffResult {
  const scope = readScopeRevision(store, coordinationScopeId);
  if (scope.kind === 'rejected') {
    return { kind: 'rejected', failure: scope.failure };
  }
  const updated = store.transact({
    kind: 'record-planning-handoff',
    coordinationScopeId,
    expectedRevision: scope.revision,
    writer,
    proposalId: proposal.proposalId,
    sourceCoordinatorSessionId: proposal.sourceCoordinatorSessionId,
    targetCoordinatorSessionId: proposal.targetCoordinatorSessionId,
    phase,
    mapRevision: proposal.mapRevision,
    planRevision: proposal.planRevision,
    graphId: proposal.graphId,
    graphVersion: proposal.graphVersion,
    capsuleRef: proposal.capsuleRef,
    expectedProposalRevision: proposal.proposalRevision,
  });
  if (updated.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: updated.code, message: updated.message } };
  }
  return readBack(store, coordinationScopeId, proposal.proposalId, expectedKind);
}

export type CutoverPlanningHandoffInput = {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly writer: CoordinationWriter;
  readonly proposalId: string;
  readonly facts: Omit<HandoffReviewFacts, 'openDecisionTickets'>;
};

/**
 * cutover 阶段：把 Route Planning 责任落盘转移给接收 Session。
 *
 * 只有原责任方可以完成交接，并且必须重新核对提案引用的事实仍然成立：过期提案一律要求重新 prepare，
 * 绝不以一份已经不描述当前规划状态的提案转移责任。
 */
export function cutoverPlanningHandoff(input: CutoverPlanningHandoffInput): PlanningHandoffResult {
  const read = readProposal(input.store, input.coordinationScopeId, input.proposalId);
  if (read.kind === 'rejected') {
    return { kind: 'rejected', failure: read.failure };
  }
  const proposal = read.proposal;
  if (proposal === null) {
    return { kind: 'rejected', failure: { code: 'not_found', message: `交接提案 ${input.proposalId} 不存在` } };
  }
  if (proposal.sourceCoordinatorSessionId !== input.writer.coordinatorSessionId) {
    return {
      kind: 'rejected',
      failure: { code: 'not_source', message: '只有提案的原责任方可以完成 cutover' },
    };
  }
  if (proposal.phase !== 'reviewed') {
    return {
      kind: 'rejected',
      failure: { code: 'invalid_state', message: `提案处于 ${proposal.phase}，不能 cutover` },
    };
  }
  if (isProposalStale(proposal, input.facts)) {
    return {
      kind: 'rejected',
      failure: { code: 'proposal_stale', message: '提案引用的事实已变化，必须重新 prepare' },
    };
  }
  return applyPhase(input.store, input.coordinationScopeId, input.writer, proposal, 'cutover', 'cutover');
}

export type CancelPlanningHandoffInput = {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly writer: CoordinationWriter;
  readonly proposalId: string;
};

/**
 * cutover 之前取消交接：责任保持或回到原 Session，提案标记为已取消，不留下半转移状态。
 *
 * 取消可以由原责任方或接收方发起（用户决定可能发生在任意一方），但责任归属始终回到 Source。
 */
export function cancelPlanningHandoff(input: CancelPlanningHandoffInput): PlanningHandoffResult {
  const read = readProposal(input.store, input.coordinationScopeId, input.proposalId);
  if (read.kind === 'rejected') {
    return { kind: 'rejected', failure: read.failure };
  }
  const proposal = read.proposal;
  if (proposal === null) {
    return { kind: 'rejected', failure: { code: 'not_found', message: `交接提案 ${input.proposalId} 不存在` } };
  }
  const caller = input.writer.coordinatorSessionId;
  if (caller !== proposal.sourceCoordinatorSessionId && caller !== proposal.targetCoordinatorSessionId) {
    return {
      kind: 'rejected',
      failure: { code: 'not_participant', message: '只有交接的参与方可以取消它' },
    };
  }
  if (proposal.phase !== 'prepared' && proposal.phase !== 'reviewed') {
    return {
      kind: 'rejected',
      failure: { code: 'invalid_state', message: `提案处于 ${proposal.phase}，不能取消` },
    };
  }
  const scope = readScopeRevision(input.store, input.coordinationScopeId);
  if (scope.kind === 'rejected') {
    return { kind: 'rejected', failure: scope.failure };
  }
  const cancelled = input.store.transact({
    kind: 'record-planning-handoff',
    coordinationScopeId: input.coordinationScopeId,
    expectedRevision: scope.revision,
    writer: input.writer,
    proposalId: proposal.proposalId,
    sourceCoordinatorSessionId: proposal.sourceCoordinatorSessionId,
    targetCoordinatorSessionId: proposal.targetCoordinatorSessionId,
    phase: 'cancelled',
    mapRevision: proposal.mapRevision,
    planRevision: proposal.planRevision,
    graphId: proposal.graphId,
    graphVersion: proposal.graphVersion,
    capsuleRef: proposal.capsuleRef,
    expectedProposalRevision: proposal.proposalRevision,
  });
  if (cancelled.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: cancelled.code, message: cancelled.message } };
  }
  return readBack(input.store, input.coordinationScopeId, proposal.proposalId, 'cancelled');
}

/** 提案引用的事实是否已经变化；变化后必须重新 prepare，不能继续 cutover。 */
export function isProposalStale(
  proposal: PlanningHandoffProposal,
  current: Omit<HandoffReviewFacts, 'openDecisionTickets'>,
): boolean {
  if (proposal.mapRevision !== current.currentMapRevision) {
    return true;
  }
  if (proposal.planRevision !== current.currentPlanRevision) {
    return true;
  }
  if (proposal.graphId === null) {
    return current.candidate !== null;
  }
  return (
    current.candidate === null ||
    current.candidate.graphId !== proposal.graphId ||
    current.candidate.version !== proposal.graphVersion
  );
}

export type PlanningHandoffResume =
  | { readonly kind: 'none' }
  | { readonly kind: 'awaiting_review'; readonly proposal: PlanningHandoffProposal }
  | { readonly kind: 'awaiting_cutover'; readonly proposal: PlanningHandoffProposal }
  | { readonly kind: 'cutover_done'; readonly proposal: PlanningHandoffProposal }
  | { readonly kind: 'cancelled'; readonly proposal: PlanningHandoffProposal }
  | { readonly kind: 'rejected'; readonly failure: PlanningHandoffFailure };

/**
 * 按持久阶段确定恢复后的状态。
 *
 * 阶段是唯一依据：prepared 未完成则回到原责任方，reviewed 而 cutover 未完成则等待明确的 cutover
 * 决定，已 cutover 则保持接收 Session 为责任方。这里不猜测责任归属，也不自动推进阶段。
 */
export function resumePlanningHandoff(input: {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
}): PlanningHandoffResume {
  const result = input.store.query({
    kind: 'planning-handoffs',
    coordinationScopeId: input.coordinationScopeId,
  });
  if (result.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: result.code, message: result.message } };
  }
  if (result.kind !== 'planning-handoffs') {
    return { kind: 'rejected', failure: { code: 'invalid_state', message: '无法读取交接提案历史' } };
  }
  const latest = result.handoffs.at(-1);
  if (latest === undefined) {
    return { kind: 'none' };
  }
  switch (latest.phase) {
    case 'prepared':
      return { kind: 'awaiting_review', proposal: latest };
    case 'reviewed':
      return { kind: 'awaiting_cutover', proposal: latest };
    case 'cutover':
      return { kind: 'cutover_done', proposal: latest };
    case 'cancelled':
      return { kind: 'cancelled', proposal: latest };
  }
}

export type HandoffActivation =
  | { readonly kind: 'active'; readonly coordinatorSessionId: CoordinatorSessionId }
  | {
      readonly kind: 'handoff_review';
      readonly coordinatorSessionId: CoordinatorSessionId;
      readonly proposalId: string;
    }
  | {
      readonly kind: 'awaiting_user_prompt';
      readonly proposalId: string;
      readonly reason: string;
    }
  | { readonly kind: 'not_planning_owner'; readonly ownerCoordinatorSessionId: CoordinatorSessionId };

/**
 * `awaiting_user_prompt` 激活门。
 *
 * 未决交接期间接收方不得推进规划：它既没有责任，也没有用户确认。已 cancelled 的提案不构成门禁，
 * 此时按持久化的责任方判断。
 */
export function activationGate(input: {
  readonly proposal: PlanningHandoffProposal | null;
  readonly responsibility: PlanningResponsibilityRecord | null;
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly awaitingUserPromptSatisfied?: boolean;
}): HandoffActivation {
  const proposal = input.proposal;
  if (proposal !== null && (proposal.phase === 'prepared' || proposal.phase === 'reviewed')) {
    if (proposal.targetCoordinatorSessionId === input.coordinatorSessionId) {
      if (input.awaitingUserPromptSatisfied === true) {
        return {
          kind: 'handoff_review',
          coordinatorSessionId: input.coordinatorSessionId,
          proposalId: proposal.proposalId,
        };
      }
      return {
        kind: 'awaiting_user_prompt',
        proposalId: proposal.proposalId,
        reason:
          proposal.phase === 'prepared'
            ? '交接提案尚未复核'
            : '交接已复核，等待明确的 cutover 决定',
      };
    }
    if (proposal.sourceCoordinatorSessionId === input.coordinatorSessionId) {
      return { kind: 'active', coordinatorSessionId: input.coordinatorSessionId };
    }
    return {
      kind: 'not_planning_owner',
      ownerCoordinatorSessionId: proposal.sourceCoordinatorSessionId,
    };
  }
  if (proposal !== null && proposal.phase === 'cutover') {
    return proposal.targetCoordinatorSessionId === input.coordinatorSessionId
      ? { kind: 'active', coordinatorSessionId: input.coordinatorSessionId }
      : { kind: 'not_planning_owner', ownerCoordinatorSessionId: proposal.targetCoordinatorSessionId };
  }
  const responsibility = input.responsibility;
  if (responsibility === null || responsibility.coordinatorSessionId === input.coordinatorSessionId) {
    return { kind: 'active', coordinatorSessionId: input.coordinatorSessionId };
  }
  return {
    kind: 'not_planning_owner',
    ownerCoordinatorSessionId: responsibility.coordinatorSessionId,
  };
}
