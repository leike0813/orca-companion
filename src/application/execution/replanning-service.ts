/**
 * IC-10 / IP-7、IP-8：Replanning Transition 与 Generation Cutover 的用例
 * （Owner: `m1-evolve-execution-graph`，D10）。
 *
 * 过渡按固定顺序落盘，每一步都先读当前事实再写，因此崩溃后重启可以确定性地从任意步骤继续：
 *
 * 1. 记录重规划意图（控制状态 `replanning_transition`，它同时停掉新派发与图补丁）；
 * 2. 挂起前代代际（`active → suspended`）；
 * 3. 等 drain 或按显式取消语义对账，直到在途 Worker、Delivery、交互与 Operation Intent 全部结清；
 * 4. 释放 Execution Coordination Lease，并把 Scope 切到新的 Planning Cycle。
 *
 * 释放之后候选代际仍未被激活：只有用户授权并通过完整授权门之后，`commitGenerationCutover` 才会在一次
 * 写入里把前代冻结、候选激活并把 Scope 引用整体切过去。切换前用户取消时走
 * `cancelReplanningTransition`，按对账结果恢复被挂起的代际。
 */

import type { CoordinationScopeId, GraphGeneration, GraphId, PlanningCycleId, Revision } from '../dto/identity.js';
import type { BranchCoordinationStore, CoordinationWriter } from '../ports/branch-coordination-store.js';
import type { ScopeRecord } from '../ports/branch-coordination-store.js';
import {
  planReplanningCancellation,
  planReplanningTransition,
  replanningClosure,
  settlementGaps,
  validateCutoverRefs,
  type CandidateGenerationRefs,
  type ReplanningClosureMode,
  type SettlementFacts,
  type TransitionStartFacts,
} from '../../domain/execution/replanning.js';
import { readScope } from '../planning/scope-read.js';

export type ReplanningFailure = {
  readonly code: string;
  readonly message: string;
};

function scopeOf(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
): { readonly ok: true; readonly scope: ScopeRecord } | { readonly ok: false; readonly failure: ReplanningFailure } {
  const read = readScope(store, coordinationScopeId);
  return read.kind === 'rejected'
    ? { ok: false, failure: { code: read.code, message: read.message } }
    : { ok: true, scope: read.scope };
}

function activeExecutionLease(store: BranchCoordinationStore, coordinationScopeId: CoordinationScopeId) {
  const leases = store.query({ kind: 'leases', coordinationScopeId });
  if (leases.kind !== 'leases') {
    return undefined;
  }
  return leases.leases.find((lease) => lease.kind === 'execution_coordination' && lease.releasedAt === null);
}

export type EnsureGraphGenerationResult =
  | { readonly kind: 'recorded' }
  | { readonly kind: 'already_recorded' }
  | { readonly kind: 'rejected'; readonly failure: ReplanningFailure };

/**
 * 登记一个 Graph Generation 的候选身份（若尚未登记）。
 *
 * 代际记录是「这一代用哪个 Graph、哪个 Run、哪条基线」的持久事实；过渡与 Cutover 都要求它存在，因此
 * 这里给出幂等的登记入口：同一 `graphId` 已登记时直接返回，不产生第二行。
 */
export function ensureGraphGenerationRecord(input: {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly writer: CoordinationWriter;
  readonly graphId: GraphId;
  readonly generation: GraphGeneration;
  readonly planningCycleId: PlanningCycleId;
  readonly orcaRunId: string;
  readonly predecessorGraphId: GraphId | null;
  readonly baselineHead: string;
}): EnsureGraphGenerationResult {
  const existing = input.store.query({
    kind: 'graph-generation',
    coordinationScopeId: input.coordinationScopeId,
    graphId: input.graphId,
  });
  if (existing.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: existing.code, message: existing.message } };
  }
  if (existing.kind === 'graph-generation' && existing.generation !== null) {
    return { kind: 'already_recorded' };
  }
  const scope = scopeOf(input.store, input.coordinationScopeId);
  if (!scope.ok) {
    return { kind: 'rejected', failure: scope.failure };
  }
  const recorded = input.store.transact({
    kind: 'record-graph-generation',
    coordinationScopeId: input.coordinationScopeId,
    expectedRevision: scope.scope.revision,
    writer: input.writer,
    graphId: input.graphId,
    generation: input.generation,
    planningCycleId: input.planningCycleId,
    orcaRunId: input.orcaRunId,
    predecessorGraphId: input.predecessorGraphId,
    baselineHead: input.baselineHead,
  });
  return recorded.kind === 'rejected'
    ? { kind: 'rejected', failure: { code: recorded.code, message: recorded.message } }
    : { kind: 'recorded' };
}

export type BeginReplanningTransitionResult =
  | {
      readonly kind: 'started';
      readonly predecessorGraphId: GraphId | null;
      readonly suspended: boolean;
    }
  | { readonly kind: 'rejected'; readonly failure: ReplanningFailure };

/**
 * 开始重规划过渡：记录意图并挂起前代代际。
 *
 * 控制状态先落盘，因此新的派发与图补丁在挂起写入之前就已经被停掉：不存在「还在派发新工作，同时已经
 * 开始结清」的窗口。前代代际记录若尚未登记，则按调用方给出的事实先登记再挂起——过渡不可能在「不知道
 * 挂起的是哪一代」的情况下继续。
 */
export function beginReplanningTransition(input: {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly writer: CoordinationWriter;
  readonly facts: Omit<TransitionStartFacts, 'controlState' | 'transitionAlreadyActive'>;
  /** 前代代际身份；Scope 尚无图时为 `null`。 */
  readonly predecessor: {
    readonly graphId: GraphId;
    readonly generation: GraphGeneration;
    readonly planningCycleId: PlanningCycleId;
    readonly orcaRunId: string;
    readonly baselineHead: string;
  } | null;
}): BeginReplanningTransitionResult {
  const scope = scopeOf(input.store, input.coordinationScopeId);
  if (!scope.ok) {
    return { kind: 'rejected', failure: scope.failure };
  }
  const decision = planReplanningTransition({
    controlState: scope.scope.controlState,
    transitionAlreadyActive: false,
    ...input.facts,
  });
  if (decision.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: decision.code, message: decision.message } };
  }

  // 前代身份先校验再落盘意图：否则一次身份不符的拒绝会把 Scope 永久留在 replanning_transition。
  const predecessorGraphId = scope.scope.graphId;
  if (predecessorGraphId !== null && (input.predecessor === null || input.predecessor.graphId !== predecessorGraphId)) {
    return {
      kind: 'rejected',
      failure: {
        code: 'invalid_state',
        message: `当前图 ${predecessorGraphId} 缺少代际身份，无法挂起`,
      },
    };
  }

  const intent = input.store.transact({
    kind: 'record-control-state',
    coordinationScopeId: input.coordinationScopeId,
    expectedRevision: scope.scope.revision,
    writer: input.writer,
    controlState: 'replanning_transition',
  });
  if (intent.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: intent.code, message: intent.message } };
  }

  if (predecessorGraphId === null) {
    return { kind: 'started', predecessorGraphId: null, suspended: false };
  }
  if (input.predecessor === null) {
    return {
      kind: 'rejected',
      failure: { code: 'invalid_state', message: `当前图 ${predecessorGraphId} 缺少代际身份，无法挂起` },
    };
  }
  const ensured = ensureGraphGenerationRecord({
    store: input.store,
    coordinationScopeId: input.coordinationScopeId,
    writer: input.writer,
    graphId: input.predecessor.graphId,
    generation: input.predecessor.generation,
    planningCycleId: input.predecessor.planningCycleId,
    orcaRunId: input.predecessor.orcaRunId,
    predecessorGraphId: null,
    baselineHead: input.predecessor.baselineHead,
  });
  if (ensured.kind === 'rejected') {
    return { kind: 'rejected', failure: ensured.failure };
  }

  const current = scopeOf(input.store, input.coordinationScopeId);
  if (!current.ok) {
    return { kind: 'rejected', failure: current.failure };
  }
  const suspended = input.store.transact({
    kind: 'advance-graph-generation',
    coordinationScopeId: input.coordinationScopeId,
    expectedRevision: current.scope.revision,
    writer: input.writer,
    graphId: predecessorGraphId,
    status: 'suspended',
  });
  if (suspended.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: suspended.code, message: suspended.message } };
  }
  return { kind: 'started', predecessorGraphId, suspended: true };
}

export type CompleteReplanningTransitionResult =
  | {
      readonly kind: 'released';
      readonly leaseReleased: boolean;
      readonly planningCycleId: PlanningCycleId;
    }
  | { readonly kind: 'waiting'; readonly gaps: readonly string[] }
  | { readonly kind: 'cancelling'; readonly reason: string }
  | { readonly kind: 'rejected'; readonly failure: ReplanningFailure };

/**
 * 收尾过渡：结清之后释放 Lease 并切到新的 Planning Cycle。
 *
 * drain 模式下尚未结清就返回 `waiting`（不伪造已停止）；cancel-and-reconcile 模式下停止未被确认时保持
 * `cancelling`，由后续对账继续确认。
 */
export function completeReplanningTransition(input: {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly writer: CoordinationWriter;
  readonly closure: ReplanningClosureMode;
  readonly settlement: SettlementFacts;
  /** cancel-and-reconcile 时，已经核验过的 Worker 停止结果。 */
  readonly workerStopsConfirmed?: boolean;
  readonly newPlanningCycleId: PlanningCycleId;
}): CompleteReplanningTransitionResult {
  const verdict = replanningClosure(input.closure);
  const gaps = settlementGaps(input.settlement);
  if (gaps.length > 0) {
    if (verdict.waitsForDrain) {
      return { kind: 'waiting', gaps };
    }
    if (input.workerStopsConfirmed !== true) {
      return { kind: 'cancelling', reason: `停止结果尚未确认：${gaps.join('、')}` };
    }
    return { kind: 'waiting', gaps };
  }

  const scope = scopeOf(input.store, input.coordinationScopeId);
  if (!scope.ok) {
    return { kind: 'rejected', failure: scope.failure };
  }
  const lease = activeExecutionLease(input.store, input.coordinationScopeId);
  let leaseReleased = false;
  if (lease !== undefined) {
    if (lease.coordinatorSessionId !== input.writer.coordinatorSessionId) {
      return {
        kind: 'rejected',
        failure: { code: 'constraint', message: 'Execution Coordination Lease 由其它 Coordinator Session 持有' },
      };
    }
    const released = input.store.transact({
      kind: 'release-execution-lease',
      coordinationScopeId: input.coordinationScopeId,
      expectedRevision: scope.scope.revision,
      writer: input.writer,
    });
    if (released.kind === 'rejected') {
      return { kind: 'rejected', failure: { code: released.code, message: released.message } };
    }
    leaseReleased = true;
  }

  const current = scopeOf(input.store, input.coordinationScopeId);
  if (!current.ok) {
    return { kind: 'rejected', failure: current.failure };
  }
  const mode = input.store.transact({
    kind: 'update-scope-mode',
    coordinationScopeId: input.coordinationScopeId,
    expectedRevision: current.scope.revision,
    writer: input.writer,
    mode: 'route_planning',
    planningCycleId: input.newPlanningCycleId,
  });
  if (mode.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: mode.code, message: mode.message } };
  }

  const active = scopeOf(input.store, input.coordinationScopeId);
  if (!active.ok) {
    return { kind: 'rejected', failure: active.failure };
  }
  const control = input.store.transact({
    kind: 'record-control-state',
    coordinationScopeId: input.coordinationScopeId,
    expectedRevision: active.scope.revision,
    writer: input.writer,
    controlState: 'active',
  });
  if (control.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: control.code, message: control.message } };
  }
  return { kind: 'released', leaseReleased, planningCycleId: input.newPlanningCycleId };
}

export type CommitGenerationCutoverResult =
  | { readonly kind: 'cutover'; readonly activeGraphId: GraphId; readonly frozenGraphId: GraphId | null }
  | { readonly kind: 'blocked'; readonly reason: string }
  | { readonly kind: 'rejected'; readonly failure: ReplanningFailure };

/**
 * 提交 Generation Cutover。
 *
 * 引用集合先整体校验再提交：任一引用缺失或自相矛盾时 `blocked`，不写入任何东西；store 侧再以单条
 * 事务切换前代、候选、Scope 引用与 Execution Coordination Lease。
 */
export function commitGenerationCutover(input: {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly writer: CoordinationWriter;
  readonly refs: CandidateGenerationRefs;
}): CommitGenerationCutoverResult {
  const validation = validateCutoverRefs(input.refs);
  if (validation.kind === 'blocked') {
    return { kind: 'blocked', reason: validation.reason };
  }
  const committed = input.store.transact({
    kind: 'commit-generation-cutover',
    coordinationScopeId: input.coordinationScopeId,
    expectedRevision: input.refs.expectedRevision,
    writer: input.writer,
    candidateGraphId: input.refs.candidateGraphId,
    candidateGraphVersion: input.refs.candidateGraphVersion,
    planningCycleId: input.refs.planningCycleId,
    authorizationId: input.refs.authorizationId,
    authorizationVersion: input.refs.authorizationVersion,
    predecessorGraphId: input.refs.predecessorGraphId,
    candidateRunId: input.refs.candidateRunId,
    baselineHead: input.refs.baselineHead,
  });
  if (committed.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: committed.code, message: committed.message } };
  }
  return {
    kind: 'cutover',
    activeGraphId: input.refs.candidateGraphId,
    frozenGraphId: input.refs.predecessorGraphId,
  };
}

export type CancelReplanningTransitionResult =
  | { readonly kind: 'cancelled'; readonly resumedGraphId: GraphId }
  | { readonly kind: 'blocked'; readonly reason: string }
  | { readonly kind: 'rejected'; readonly failure: ReplanningFailure };

/**
 * 切换前取消重规划：对账完成后恢复被挂起的代际，并重新取得 Execution Coordination Lease。
 *
 * 刷新后的 Execution Authorization 必须已经记录（规划期内由授权流程写入）；本用例只校验 Scope 指向的
 * 就是它，从而不会因为重放产生第二份授权记录。
 */
export function cancelReplanningTransition(input: {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly writer: CoordinationWriter;
  readonly suspendedGraphId: GraphId;
  readonly refreshedAuthorization: { readonly authorizationId: string; readonly authorizationVersion: Revision };
  readonly reconciliationResolved: boolean;
}): CancelReplanningTransitionResult {
  const scope = scopeOf(input.store, input.coordinationScopeId);
  if (!scope.ok) {
    return { kind: 'rejected', failure: scope.failure };
  }
  const decision = planReplanningCancellation({
    reconciliationResolved: input.reconciliationResolved,
    authorizationRefreshed:
      scope.scope.authorizationId === input.refreshedAuthorization.authorizationId &&
      scope.scope.authorizationVersion === input.refreshedAuthorization.authorizationVersion,
  });
  if (decision.kind === 'blocked') {
    return { kind: 'blocked', reason: decision.reason };
  }

  const resumed = input.store.transact({
    kind: 'advance-graph-generation',
    coordinationScopeId: input.coordinationScopeId,
    expectedRevision: scope.scope.revision,
    writer: input.writer,
    graphId: input.suspendedGraphId,
    status: 'active',
  });
  if (resumed.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: resumed.code, message: resumed.message } };
  }

  const current = scopeOf(input.store, input.coordinationScopeId);
  if (!current.ok) {
    return { kind: 'rejected', failure: current.failure };
  }
  const acquired = input.store.transact({
    kind: 'acquire-execution-lease',
    coordinationScopeId: input.coordinationScopeId,
    expectedRevision: current.scope.revision,
    writer: input.writer,
  });
  if (acquired.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: acquired.code, message: acquired.message } };
  }

  const active = scopeOf(input.store, input.coordinationScopeId);
  if (!active.ok) {
    return { kind: 'rejected', failure: active.failure };
  }
  const control = input.store.transact({
    kind: 'record-control-state',
    coordinationScopeId: input.coordinationScopeId,
    expectedRevision: active.scope.revision,
    writer: input.writer,
    controlState: 'active',
  });
  if (control.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: control.code, message: control.message } };
  }
  return { kind: 'cancelled', resumedGraphId: input.suspendedGraphId };
}
