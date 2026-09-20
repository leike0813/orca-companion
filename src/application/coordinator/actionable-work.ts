/**
 * IC-04 的 Actionable Work 投影
 * （Owner: `m1-run-coordinator-sessions`）。
 *
 * Actionable Work 是一个**投影**，不是队列，也不是通用 inbox（`CONTEXT.md`「Actionable Work」）。
 * 它只回答一个问题：当前这些 owner-scoped 的 source 变化里，哪些需要 Coordinator Agent 判断或
 * 模型可见动作。普通进度、keepalive、长轮询超时与无变化对账一律不产生工作，因此它们永远不会
 * 唤醒模型。
 *
 * 投影是有界的：超出上限的条目保留在输入里交给下一次投影，不丢弃、不截断语义。
 */

import type { ControlState } from '../../domain/coordination/mode.js';
import type { SourceRevisionRef } from '../../domain/coordinator/session-state.js';
import type { CoordinatorSessionId } from '../dto/identity.js';
import { admissionKeyFor } from './wake-admission.js';
import type { WakeAdmissionRecord } from '../ports/branch-coordination-store.js';

/**
 * 一条 source 变化的分类。
 *
 * 需要一个 Coordinator 判断或模型可见动作的取值是有限集合；其余都是确定性事实，
 * 由 Controller 自行结清。新增取值时必须显式决定它属于哪一侧。
 */
export const SOURCE_OBSERVATION_CLASSES = [
  'worker_question',
  'worker_escalation',
  'pending_interaction',
  'unattributed_drift',
  'routine_progress',
  'keepalive',
  'long_poll_timeout',
  'unchanged_reconciliation',
  'deterministic_transition',
] as const;

export type SourceObservationClass = (typeof SOURCE_OBSERVATION_CLASSES)[number];

const ACTIONABLE_OBSERVATION_CLASSES: ReadonlySet<SourceObservationClass> = new Set([
  'worker_question',
  'worker_escalation',
  'pending_interaction',
  'unattributed_drift',
]);

export function isActionableObservationClass(value: SourceObservationClass): boolean {
  return ACTIONABLE_OBSERVATION_CLASSES.has(value);
}

/** Controller 观察到的一条 source 变化；`source` 是稳定引用，不复制外部正文。 */
export type SourceObservation = {
  readonly source: SourceRevisionRef;
  readonly classification: SourceObservationClass;
  readonly summary: string;
  /** 该事实归属的 Coordinator Session；`null` 表示 Scope 级事实，对每个 Session 都可见。 */
  readonly ownerCoordinatorSessionId: CoordinatorSessionId | null;
};

export type ProjectedActionableWorkItem = {
  readonly source: SourceRevisionRef;
  readonly workKind: SourceObservationClass;
  readonly summary: string;
};

/** 单次投影的条目上限；超出的部分留到下一次，不丢事实。 */
export const ACTIONABLE_WORK_LIMIT = 32;

/** 暂停、取消与 Replanning Transition 期间不恢复模型（`AGENTS.md` 第 9 节）。 */
const NO_WAKE_CONTROL_STATES: ReadonlySet<ControlState> = new Set([
  'paused',
  'cancelling',
  'cancelled',
]);

export type ActionableWorkProjection = {
  /** 有界、稳定排序的待处理工作；空数组表示模型无需恢复。 */
  readonly items: readonly ProjectedActionableWorkItem[];
  /** 因超出上限而未纳入本次投影的条目数，留给下一次投影。 */
  readonly deferredCount: number;
  /** 因控制状态或超出上限而暂不唤醒的原因；`items` 非空时为 `null`。 */
  readonly suppressedBy: 'control_state' | 'limit' | null;
};

export type ProjectActionableWorkInput = {
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly controlState: ControlState;
  readonly observations: readonly SourceObservation[];
  readonly admitted: readonly WakeAdmissionRecord[];
  readonly limit?: number;
};

function compareItems(left: ProjectedActionableWorkItem, right: ProjectedActionableWorkItem): number {
  if (left.source.sourceKind !== right.source.sourceKind) {
    return left.source.sourceKind < right.source.sourceKind ? -1 : 1;
  }
  if (left.source.sourceId !== right.source.sourceId) {
    return left.source.sourceId < right.source.sourceId ? -1 : 1;
  }
  return left.source.revision - right.source.revision;
}

/**
 * 把 owner-scoped 观察投影成有界 Actionable Work。
 *
 * 过滤顺序固定：控制状态 → owner → 分类 → 已准入去重 → 有界截断。控制状态最先判定，
 * 因为暂停或取消期间任何工作都不应导致模型恢复。
 */
export function projectActionableWork(input: ProjectActionableWorkInput): ActionableWorkProjection {
  const limit = input.limit ?? ACTIONABLE_WORK_LIMIT;
  const admittedKeys = new Set(
    input.admitted.flatMap((record) => record.sourceRevisions.map((source) => admissionKeyFor(source))),
  );
  const ownerScoped = input.observations.filter(
    (observation) =>
      observation.ownerCoordinatorSessionId === null ||
      observation.ownerCoordinatorSessionId === input.coordinatorSessionId,
  );
  const actionable = ownerScoped
    .filter((observation) => isActionableObservationClass(observation.classification))
    .filter((observation) => !admittedKeys.has(admissionKeyFor(observation.source)));

  if (NO_WAKE_CONTROL_STATES.has(input.controlState)) {
    return { items: [], deferredCount: 0, suppressedBy: 'control_state' };
  }

  const ordered = actionable
    .map<ProjectedActionableWorkItem>((observation) => ({
      source: observation.source,
      workKind: observation.classification,
      summary: observation.summary,
    }))
    .sort(compareItems);

  const items = ordered.slice(0, limit);
  const deferredCount = ordered.length - items.length;
  return {
    items,
    deferredCount,
    suppressedBy: items.length === 0 && deferredCount > 0 ? 'limit' : null,
  };
}
