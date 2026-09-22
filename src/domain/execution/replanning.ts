/**
 * IC-10 / IP-7、IP-8：Replanning Transition 与 Generation Cutover 的纯规则
 * （Owner: `m1-evolve-execution-graph`，D10）。
 *
 * 重规划是**受控过渡**，不是第三种模式：它复用 Scope 的正交控制状态（`replanning_transition`），按固定
 * 顺序停派发、结清在途工作、释放 Execution Coordination Lease，然后才开始新的 Planning Cycle。
 *
 * 这里只有判定与闭集：不读时钟、不碰存储、不释放任何东西。三条边界写进了返回类型：
 * - 收尾方式只有 drain 与用户显式的 cancel-and-reconcile 两种，二者都把结果记在被挂起的代际上；
 * - 停止结果未被确认时不伪造「已停止」；
 * - Cutover 的引用集合要么整体切换，要么全部不变，因此逐项校验后只可能得到 `ready` 或 `blocked`。
 */

import type { GraphGeneration, GraphId, GraphVersion, PlanningCycleId, Revision } from '../../application/dto/identity.js';
import type { ControlState } from '../coordination/mode.js';

/**
 * Graph Generation 的状态闭集。
 *
 * `candidate` 是尚未授权的候选代际，`active` 是 Scope 当前指向的代际，`suspended` 是重规划过渡期间被
 * 挂起、仍可取消恢复的前代，`frozen` 是 Cutover 之后不可恢复的不可变历史。
 */
export const GRAPH_GENERATION_STATUSES = ['candidate', 'active', 'suspended', 'frozen'] as const;

export type GraphGenerationStatus = (typeof GRAPH_GENERATION_STATUSES)[number];

/** 允许的代际状态迁移；未列出的迁移在 store 边界被拒绝，终态不再接受推进。 */
export const GRAPH_GENERATION_TRANSITIONS: Readonly<
  Record<GraphGenerationStatus, readonly GraphGenerationStatus[]>
> = {
  // 当前图进入重规划过渡时，它的代际记录可能还是刚登记的 `candidate`（例如前驱链没有显式标记
  // active），因此挂起允许从 `candidate` 直接发生；`frozen` 仍是终态。
  candidate: ['active', 'suspended', 'frozen'],
  active: ['suspended', 'frozen'],
  suspended: ['active', 'frozen'],
  frozen: [],
};

/** 过渡的固定步骤顺序；调用方按此顺序落盘，不得跳过或重排。 */
export const REPLANNING_TRANSITION_ORDER = [
  'record-intent',
  'stop-new-dispatch-and-patches',
  'settle-in-flight-work',
  'release-execution-lease',
  'suspend-predecessor-generation',
  'start-planning-cycle',
] as const;

export type ReplanningTransitionStep = (typeof REPLANNING_TRANSITION_ORDER)[number];

export const REPLANNING_CLOSURE_MODES = ['drain', 'cancel_and_reconcile'] as const;

export type ReplanningClosureMode = (typeof REPLANNING_CLOSURE_MODES)[number];

export type TransitionStartFacts = {
  readonly controlState: ControlState;
  readonly goalOrGlobalConstraintChanged: boolean;
  readonly userRequestedReplanning: boolean;
  readonly graphRevisionsExhausted: boolean;
  /** 该 Scope 是否已经处于未完成的重规划过渡中。 */
  readonly transitionAlreadyActive: boolean;
};

export type TransitionStartDecision =
  | { readonly kind: 'start'; readonly reason: string }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

/**
 * 过渡能否开始。
 *
 * 触发条件必须显式：目标或全局约束变化、用户明确要求，或图已无法在修订额度内表达变化。已经处于过渡中
 * 时重复进入被拒绝，因为那会产出两个新 Planning Cycle。
 */
export function planReplanningTransition(facts: TransitionStartFacts): TransitionStartDecision {
  if (facts.transitionAlreadyActive || facts.controlState === 'replanning_transition') {
    return {
      kind: 'rejected',
      code: 'already_in_transition',
      message: '该 Scope 已处于 Replanning Transition 中',
    };
  }
  if (facts.controlState === 'cancelled' || facts.controlState === 'unverifiable') {
    return {
      kind: 'rejected',
      code: 'control_state_blocks',
      message: `控制状态为 ${facts.controlState}，不能开始重规划过渡`,
    };
  }
  if (facts.userRequestedReplanning) {
    return { kind: 'start', reason: '用户明确要求重规划' };
  }
  if (facts.goalOrGlobalConstraintChanged) {
    return { kind: 'start', reason: '目标或全局约束发生变化' };
  }
  if (facts.graphRevisionsExhausted) {
    return { kind: 'start', reason: '图无法在修订额度内表达变化' };
  }
  return { kind: 'rejected', code: 'not_requested', message: '没有明确的重规划触发条件' };
}

export type ClosureVerdict = {
  readonly mode: ReplanningClosureMode;
  readonly stopsNewDispatch: true;
  readonly stopsGraphPatches: true;
  readonly waitsForDrain: boolean;
  readonly requestsWorkerStop: boolean;
  readonly reconciliationRequired: boolean;
  /** 恒为 `true`：两种收尾方式下结果都只记在被挂起的代际上。 */
  readonly recordsAgainstSuspendedGeneration: true;
  /** 恒为 `false`：停止未被确认时绝不报告为已停止。 */
  readonly fabricatesStopped: false;
};

/** 收尾方式翻译成「等不等 drain、请求不请求停止、要不要对账」。 */
export function replanningClosure(mode: ReplanningClosureMode): ClosureVerdict {
  return mode === 'drain'
    ? {
        mode,
        stopsNewDispatch: true,
        stopsGraphPatches: true,
        waitsForDrain: true,
        requestsWorkerStop: false,
        reconciliationRequired: false,
        recordsAgainstSuspendedGeneration: true,
        fabricatesStopped: false,
      }
    : {
        mode,
        stopsNewDispatch: true,
        stopsGraphPatches: true,
        waitsForDrain: false,
        requestsWorkerStop: true,
        reconciliationRequired: true,
        recordsAgainstSuspendedGeneration: true,
        fabricatesStopped: false,
      };
}

export type SettlementFacts = {
  readonly inFlightWorkers: number;
  readonly pendingDeliveries: number;
  readonly openInteractions: number;
  readonly unresolvedIntents: number;
};

/** 尚未结清的项；空表示可以释放 Lease 并建立新 Planning Cycle。 */
export function settlementGaps(facts: SettlementFacts): readonly string[] {
  const gaps: string[] = [];
  if (facts.inFlightWorkers > 0) gaps.push(`在途 Worker ${facts.inFlightWorkers} 个`);
  if (facts.pendingDeliveries > 0) gaps.push(`未结算 Delivery ${facts.pendingDeliveries} 个`);
  if (facts.openInteractions > 0) gaps.push(`未决交互 ${facts.openInteractions} 个`);
  if (facts.unresolvedIntents > 0) gaps.push(`未决 Operation Intent ${facts.unresolvedIntents} 个`);
  return gaps;
}

export function settlementComplete(facts: SettlementFacts): boolean {
  return settlementGaps(facts).length === 0;
}

/**
 * Cutover 的引用集合。
 *
 * 这些引用一起改变或全部不变：前代图、候选图与世代、候选 Run、授权、基线与当时的 execution 态
 * revision。任何一项缺失或自相矛盾（候选等于前代）都让切换整体被拒绝，因此不存在「只换了一半」的代际。
 */
export type CandidateGenerationRefs = {
  readonly predecessorGraphId: GraphId;
  readonly candidateGraphId: GraphId;
  readonly candidateGeneration: GraphGeneration;
  /** 候选图要被激活的确切 GraphVersion；必须等于候选图的 head。 */
  readonly candidateGraphVersion: GraphVersion;
  readonly candidateRunId: string;
  readonly planningCycleId: PlanningCycleId;
  readonly authorizationId: string;
  readonly authorizationVersion: Revision;
  readonly baselineHead: string;
  readonly expectedRevision: Revision;
};

export type CutoverRefValidation =
  | { readonly kind: 'ready' }
  | { readonly kind: 'blocked'; readonly reason: string };

export function validateCutoverRefs(refs: CandidateGenerationRefs): CutoverRefValidation {
  if (refs.candidateGraphId === refs.predecessorGraphId) {
    return { kind: 'blocked', reason: '候选代际与前代是同一张图，Cutover 不会产生新代际' };
  }
  const required: readonly (readonly [string, unknown])[] = [
    ['candidateRunId', refs.candidateRunId],
    ['planningCycleId', refs.planningCycleId],
    ['authorizationId', refs.authorizationId],
    ['baselineHead', refs.baselineHead],
  ];
  for (const [field, value] of required) {
    if (typeof value !== 'string' || value.length === 0) {
      return { kind: 'blocked', reason: `${field} 缺失：引用集合只能整体切换` };
    }
  }
  if (!Number.isSafeInteger(refs.candidateGraphVersion) || refs.candidateGraphVersion <= 0) {
    return { kind: 'blocked', reason: 'candidateGraphVersion 必须是正的安全整数' };
  }
  if (!Number.isSafeInteger(refs.authorizationVersion) || refs.authorizationVersion <= 0) {
    return { kind: 'blocked', reason: 'authorizationVersion 必须是正的安全整数' };
  }
  if (!Number.isSafeInteger(refs.candidateGeneration) || refs.candidateGeneration <= 0) {
    return { kind: 'blocked', reason: 'candidateGeneration 必须是正的安全整数' };
  }
  if (!Number.isSafeInteger(refs.expectedRevision) || refs.expectedRevision < 0) {
    return { kind: 'blocked', reason: 'expectedRevision 必须是非负整数' };
  }
  return { kind: 'ready' };
}

/**
 * 事件属于当前代际还是前代历史。
 *
 * Cutover 之后前代 Run 的迟到事件只用于补全它的历史，MUST NOT 影响当前代际。
 */
export function classifyGenerationEvent(input: {
  readonly eventGraphId: GraphId;
  readonly activeGraphId: GraphId;
}): 'current_generation' | 'predecessor_history' {
  return input.eventGraphId === input.activeGraphId ? 'current_generation' : 'predecessor_history';
}

/** `frozen` 之后前代成为不可恢复的不可变历史：不能被恢复、取消或再次激活。 */
export function isGenerationRecoverable(status: GraphGenerationStatus): boolean {
  return status !== 'frozen';
}

export type CancellationFacts = {
  /** 基线、预算、Worker 结果与未决操作是否已重验完成。 */
  readonly reconciliationResolved: boolean;
  /** 是否已记录刷新后的 Execution Authorization。 */
  readonly authorizationRefreshed: boolean;
};

export type CancellationDecision =
  | { readonly kind: 'cancel' }
  | { readonly kind: 'blocked'; readonly reason: string };

/**
 * 切换前取消重规划的判定。
 *
 * 两项都对账完成才可以恢复被挂起的代际；任一未完成时执行保持暂停，而不是先把代际恢复回来再补对账。
 */
export function planReplanningCancellation(facts: CancellationFacts): CancellationDecision {
  if (!facts.reconciliationResolved) {
    return { kind: 'blocked', reason: '基线、预算、Worker 结果与未决操作尚未完成重验，执行保持暂停' };
  }
  if (!facts.authorizationRefreshed) {
    return { kind: 'blocked', reason: '尚未记录刷新后的 Execution Authorization' };
  }
  return { kind: 'cancel' };
}
