/**
 * IC-11 Extend / IP-01、IP-02、IP-07：执行阶段只读投影
 * （Owner: `m2-deliver-execution-tui`，D2、D4、D6、D7）。
 *
 * 这是执行阶段界面唯一的**投影**入口：输入是 IC-03 的 `CoordinationSnapshot`、当前 GraphVersion 的
 * 节点集合与调用方读到的 Orca 只读观察；输出是 `ControllerSnapshot` 的执行分区。它是纯函数：不读
 * store、不调用 Orca、不写任何记录、不推进任何状态。
 *
 * 四条不可让步的边界：
 * - **不发明状态**：每个 Work Package 阶段都由 `derivedFrom` 列出的持久事实推出；推不出确定结论时
 *   停留在 `unknown`，绝不把「没有观察到」读成「没有发生」，也绝不把无法核验的 Worker 读成已退出（D6）；
 * - **不合并事实**：生命周期阶段（`WorkPackageExecutionState`）与 Worker liveness（`live` / `exited` /
 *   `unverifiable`）是两个字段，`liveness` 只在能核验时给出确定值；
 * - **不越权**：Finalizer 门禁只复述 `planFinalizerDispatch` 的判决与已接受的 Delivery Verdict；门禁
 *   不满足、只读无法强制或工作区在运行期间变化时只呈现 blocker，不呈现 deliverable（D7）；
 * - **不补齐**：执行运行时尚未接线，没有生产者的事实（Capsule coverage、worktree 路径、只读 Profile
 *   核验、运行前后工作区）一律显式留空，由界面如实呈现为未知，而不是编造一个看起来完整的执行视图。
 *
 * 阶段判定只使用「已接受的角色结果」与「仍在运行的 Worker」两类证据，且只沿角色顺序前进：
 * planner 已接受 → `implementing`，implementation 已接受 → `validating`，validator 已接受 → 集成阶段。
 * 更细的 `repairing`、`retired`、`cancelled` 与部分 `unknown` 由权威事实经同一 DTO 提供。
 */

import type { WorkerTaskId, WorkPackageId } from '../dto/identity.js';
import type { RoleAuthorities, WorkerRole } from '../../domain/planning/execution-authorization.js';
import type { WorkerLiveness } from '../../domain/worker-liveness.js';
import {
  initialWorkPackageStatus,
  withDeliveryStatus,
  withImplementationStatus,
  withValidationStatus,
  type WorkPackageStatus,
} from '../../domain/work-package-status.js';
import type {
  BaselineReconciliationState,
  CoordinationSnapshot,
  DeliverySettlementRecord,
} from '../ports/branch-coordination-store.js';
import { planFinalizerDispatch } from '../finalize-project.js';

/* -------------------------------------------------------------------------- */
/* 词汇                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Work Package 生命周期闭集（`tui/execution-monitoring`）。
 *
 * 依赖尚未满足的候选是 `waiting`；依赖已满足、可以成为当前 Dispatch Candidate 的是 `admitting`。
 * `unknown` 不是「没开始」，而是「执行已经开始但结论无法核验」。
 */
export const WORK_PACKAGE_EXECUTION_STATES = [
  'waiting',
  'admitting',
  'specifying',
  'implementing',
  'validating',
  'repairing',
  'waiting_integration',
  'reconciling',
  'revision_pending',
  'blocked',
  'unknown',
  'accepted',
  'retired',
  'cancelled',
] as const;

export type WorkPackageExecutionState = (typeof WORK_PACKAGE_EXECUTION_STATES)[number];

/**
 * 处于 active（持有 Execution Frontier 位置）的阶段。
 *
 * 并发上限固定为 1，因此任一时刻最多一个 Work Package 处于这些阶段；`waiting_integration` 不属于
 * active（角色工作已结束，只等串行集成）。
 */
export const ACTIVE_WORK_PACKAGE_STATES = [
  'admitting',
  'specifying',
  'implementing',
  'validating',
  'repairing',
  'reconciling',
] as const satisfies readonly WorkPackageExecutionState[];

export function isActiveWorkPackageState(state: WorkPackageExecutionState): boolean {
  return (ACTIVE_WORK_PACKAGE_STATES as readonly WorkPackageExecutionState[]).includes(state);
}

/** 角色推进顺序：只有它决定「已经走到哪个角色」，与时间戳无关。 */
export const WORKER_ROLE_ORDER = ['planner', 'implementation', 'validator'] as const;

/**
 * 「可能有角色级 Worker 仍然活着」的阶段。
 *
 * 只有这些阶段才在无法列举执行主机时给出 `unverifiable`：已经结束角色工作的阶段（`accepted`、
 * `waiting_integration`、`waiting`、`blocked`、`retired`、`cancelled`）没有可核验的 Worker 可言，
 * 把它们一律标成不可核验会让「重启先对账」与危险态永久为真。
 */
const WORKER_EXPECTED_STATES: ReadonlySet<WorkPackageExecutionState> = new Set([
  'admitting',
  'specifying',
  'implementing',
  'validating',
  'repairing',
  'reconciling',
  'revision_pending',
  'unknown',
]);

/** 角色对应的阶段。 */
const ROLE_PHASE: Readonly<Record<WorkerRole, WorkPackageExecutionState>> = {
  planner: 'specifying',
  implementation: 'implementing',
  validator: 'validating',
  finalizer: 'unknown',
};

/**
 * canonical 前进、轻微 reconciliation 与严重冲突升级的区分。
 *
 * 取值直接来自 `BaselineReconciliationRecord.state` 的闭集，不做推断：`verified` 表示基线已核验并
 * 前进，`required` 是仍需核验的轻微状态，`blocked` 是必须升级处理的严重冲突。
 */
export const RECONCILIATION_SEVERITIES = [
  'canonical_advance',
  'reconciliation_required',
  'conflict_escalated',
] as const;

export type ReconciliationSeverity = (typeof RECONCILIATION_SEVERITIES)[number];

export function reconciliationSeverity(
  state: 'required' | 'verified' | 'blocked',
): ReconciliationSeverity {
  switch (state) {
    case 'verified':
      return 'canonical_advance';
    case 'required':
      return 'reconciliation_required';
    case 'blocked':
      return 'conflict_escalated';
  }
}

/* -------------------------------------------------------------------------- */
/* 投影 DTO                                                                    */
/* -------------------------------------------------------------------------- */

export type ValidationView = {
  readonly state: 'validating' | 'validated' | 'rejected' | 'blocked' | 'unknown';
  readonly acceptedResultRef: string | null;
  /** 结论引用的证据；只保存引用，正文仍在 Orca。 */
  readonly evidenceRefs: readonly string[];
};

export type IntegrationView = {
  readonly state: 'waiting' | 'integrating' | 'integrated' | 'blocked' | 'unknown';
  readonly ref: string | null;
};

/** 一个 Work Package 的执行投影；生命周期与 liveness 是两个独立字段。 */
export type WorkPackageExecutionEntry = {
  readonly workPackageId: string;
  readonly state: WorkPackageExecutionState;
  readonly role: WorkerRole | null;
  readonly attemptId: string | null;
  /** 单独显示的 Worker 存活三值；没有可核验观察时为 `null`。 */
  readonly liveness: WorkerLiveness | null;
  readonly worktreePath: string | null;
  readonly baselineHead: string | null;
  readonly validation: ValidationView | null;
  readonly integration: IntegrationView | null;
  /** 推出该状态所依据的持久事实引用；空数组表示没有可用依据。 */
  readonly derivedFrom: readonly string[];
  readonly blockerRefs: readonly string[];
};

/**
 * 一次 Baseline Reconciliation 的投影。
 *
 * `state` 保持记录自身的闭集（既有字段语义不变），`severity` 是它在界面上的分类：canonical 前进、
 * 轻微核验与严重冲突必须可区分。
 */
export type ReconciliationView = {
  readonly reconciliationId: string;
  readonly workPackageId: string;
  readonly state: BaselineReconciliationState;
  readonly severity: ReconciliationSeverity;
  readonly requiredBaselineHead: string;
  readonly observedHead: string | null;
  readonly blockerRef: string | null;
};

/** 记录 → 投影的唯一映射；派生与快照投影共用它，避免两处各写一份严重性判定。 */
export function reconciliationEntry(
  record: CoordinationSnapshot['baselineReconciliations'][number],
): ReconciliationView {
  return {
    reconciliationId: record.reconciliationId,
    workPackageId: record.workPackageId,
    state: record.state,
    severity: reconciliationSeverity(record.state),
    requiredBaselineHead: record.requiredBaselineHead,
    observedHead: record.observedHead,
    blockerRef: record.blockerRef,
  };
}

export type FinalizerWorkspaceFacts = {
  readonly head: string;
  readonly indexRevision: string;
  readonly dirtyPaths: readonly string[];
};

export type FinalizerVerdictView = {
  readonly verdictId: string;
  readonly kind: 'deliverable' | 'blocked';
  readonly refs: readonly string[];
  readonly sessionBindingRef: string;
  readonly recordedAt: number;
};

/**
 * Finalizer 门禁与 Delivery Verdict 的投影。
 *
 * `workspace` 为 `null` 表示没有运行记录；`readOnlyProfile` 与 `integrationFrozen` 在无法核验时保持
 * `unverified` / `unknown`，界面据此只显示未知或 blocker，不显示交付结论。
 */
export type FinalizerView = {
  readonly gate: { readonly ready: boolean; readonly blockers: readonly string[] };
  readonly coversWorkPackageIds: readonly string[];
  readonly worktreePath: string | null;
  readonly readOnlyProfile: 'enforced' | 'unenforceable' | 'unverified';
  readonly integrationFrozen: 'frozen' | 'unknown';
  readonly workspace: {
    readonly before: FinalizerWorkspaceFacts;
    readonly after: FinalizerWorkspaceFacts;
  } | null;
  readonly evidenceRefs: readonly string[];
  readonly verdict: FinalizerVerdictView | null;
};

/**
 * 「重启先对账」的门（D4）。
 *
 * `pending` 表示存在尚未对账的执行事实（未决 Operation Intent 或可核验为仍在运行 / 不可核验的 Worker）；
 * 界面在它为 `true` 时显示 reconciling，并且不显示任何可推进的状态。
 */
export type ExecutionReconciliationGateView = {
  readonly pending: boolean;
  readonly unresolvedIntentCount: number;
  readonly activeWorkerCount: number;
  readonly reasons: readonly string[];
};

/**
 * 危险态判定（`tui/execution-control`）。
 *
 * Cancel 与 Exit 在 `hazardous` 时必须先确认；Pause 永不确认。`unverifiedWorkerCount` 计入 hazard：
 * 无法核验的 Worker 不得被读作已经停止。
 */
export type ControlHazardsView = {
  readonly activeWorkerCount: number;
  readonly unverifiedWorkerCount: number;
  readonly openInteractionCount: number;
  readonly unresolvedOperationCount: number;
  readonly hazardous: boolean;
};

/* -------------------------------------------------------------------------- */
/* 调用方读到的只读观察                                                        */
/* -------------------------------------------------------------------------- */

export type WorkerObservation = {
  readonly dispatchId: string;
  readonly taskId: string | null;
  /** Orca 报告的 worker 状态；`null` 表示未给出，不得读作已结束。 */
  readonly workerState: string | null;
  readonly terminalState: string | null;
};

export type FinalizerObservationFacts = {
  readonly readOnlyProfile: 'enforced' | 'unenforceable' | 'unverified';
  readonly integrationFrozen: 'frozen' | 'unknown';
  readonly worktreePath: string | null;
  readonly workspace: {
    readonly before: FinalizerWorkspaceFacts;
    readonly after: FinalizerWorkspaceFacts;
  } | null;
  readonly evidenceRefs: readonly string[];
};

/**
 * 执行阶段的外部观察。
 *
 * `workersEnumerated` 为 `false` 时 `workers` 必须被忽略：没有列举就不存在「没观察到 = 没在跑」这一步。
 */
export type ExecutionObservationFacts = {
  readonly workersEnumerated: boolean;
  readonly workers: readonly WorkerObservation[];
  /** Work Package → 隔离 worktree 路径；未解析到的 Work Package 不出现在这里。 */
  readonly worktreePaths: ReadonlyMap<string, string>;
  /** 无法取得的外部事实；只用于如实呈现，不用于推断。 */
  readonly unavailableReasons: readonly string[];
  /** Finalizer 运行条件的外部观察；没有生产者时为 `null`。 */
  readonly finalizer: FinalizerObservationFacts | null;
};

export function noExecutionObservations(reason: string): ExecutionObservationFacts {
  return {
    workersEnumerated: false,
    workers: [],
    worktreePaths: new Map(),
    unavailableReasons: [reason],
    finalizer: null,
  };
}

export type ExecutionNodeFacts = {
  readonly workPackageId: string;
  readonly dependsOn: readonly string[];
};

export type DeriveExecutionFactsInput = {
  readonly snapshot: CoordinationSnapshot;
  /** 当前 GraphVersion 的节点；传入顺序即稳定拓扑顺序。 */
  readonly nodes: readonly ExecutionNodeFacts[];
  /** 当前 Graph Generation 的基线 HEAD；没有生成时为 `null`。 */
  readonly baselineHead: string | null;
  /** 当前 Execution Authorization 的角色权限；没有授权时为 `null`。 */
  readonly authority: RoleAuthorities | null;
  readonly observations: ExecutionObservationFacts;
};

export type DerivedExecutionFacts = {
  readonly frontier: readonly WorkPackageExecutionEntry[];
  readonly reconciliations: readonly ReconciliationView[];
  readonly finalizer: FinalizerView;
  readonly executionReconciliation: ExecutionReconciliationGateView;
};

/* -------------------------------------------------------------------------- */
/* liveness                                                                    */
/* -------------------------------------------------------------------------- */

/** Orca worker 状态的可核验取值；未登记的状态一律不可核验（fail closed）。 */
const RUNNING_WORKER_STATES: ReadonlySet<string> = new Set(['running', 'active', 'working', 'in_progress']);

const EXITED_WORKER_STATES: ReadonlySet<string> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'canceled',
  'exited',
  'abandoned',
  'completed',
  'done',
  'timed_out',
]);

function livenessOf(observation: WorkerObservation): WorkerLiveness {
  if (observation.workerState !== null && RUNNING_WORKER_STATES.has(observation.workerState)) {
    return 'live';
  }
  if (observation.workerState !== null && EXITED_WORKER_STATES.has(observation.workerState)) {
    return 'exited';
  }
  return 'unverifiable';
}

/* -------------------------------------------------------------------------- */
/* 单个 Work Package 的阶段                                                    */
/* -------------------------------------------------------------------------- */

type WorkPackageWorkflowFacts = {
  readonly revisionHold: CoordinationSnapshot['revisionHolds'][number] | null;
  readonly reconciliation: CoordinationSnapshot['baselineReconciliations'][number] | null;
  readonly recoveries: readonly CoordinationSnapshot['recoveries'][number][];
  readonly adoption: CoordinationSnapshot['baselineAdoptions'][number] | null;
  readonly settlements: readonly DeliverySettlementRecord[];
  readonly segments: readonly CoordinationSnapshot['sessionSegments'][number][];
  readonly binding: CoordinationSnapshot['materializationBindings'][number] | null;
};

type Phase = {
  readonly state: WorkPackageExecutionState;
  readonly role: WorkerRole | null;
  readonly attemptId: string | null;
  readonly validation: ValidationView | null;
  readonly integration: IntegrationView | null;
  readonly derivedFrom: readonly string[];
  readonly blockerRefs: readonly string[];
};

function phase(
  state: WorkPackageExecutionState,
  fields: Partial<Omit<Phase, 'state'>> = {},
): Phase {
  return {
    state,
    role: fields.role ?? null,
    attemptId: fields.attemptId ?? null,
    validation: fields.validation ?? null,
    integration: fields.integration ?? null,
    derivedFrom: fields.derivedFrom ?? [],
    blockerRefs: fields.blockerRefs ?? [],
  };
}

/** 该 Work Package 已接受的最远角色；没有任何已接受结果时为 `null`。 */
function furthestAcceptedRole(settlements: readonly DeliverySettlementRecord[]): WorkerRole | null {
  let furthest: WorkerRole | null = null;
  for (const role of WORKER_ROLE_ORDER) {
    if (settlements.some((settlement) => settlement.role === role)) {
      furthest = role;
    }
  }
  return furthest;
}

function latestSettlementFor(
  settlements: readonly DeliverySettlementRecord[],
  role: WorkerRole,
): DeliverySettlementRecord | null {
  return settlements
    .filter((settlement) => settlement.role === role)
    .reduce<DeliverySettlementRecord | null>(
      (latest, current) => (latest === null || current.acceptedAt >= latest.acceptedAt ? current : latest),
      null,
    );
}

/**
 * 已派发过的 Dispatch 名单：只由持久记录构成，因此「没观察到 Worker」永远不会被当成「从未派发」。
 */
function knownDispatches(
  workflow: WorkPackageWorkflowFacts,
): ReadonlyMap<string, { readonly role: WorkerRole; readonly attemptId: string }> {
  const known = new Map<string, { readonly role: WorkerRole; readonly attemptId: string }>();
  for (const settlement of workflow.settlements) {
    known.set(settlement.dispatchId, { role: settlement.role, attemptId: settlement.attemptId });
  }
  for (const segment of workflow.segments) {
    known.set(segment.dispatchId, { role: segment.role, attemptId: segment.attemptId });
  }
  for (const recovery of workflow.recoveries) {
    if (recovery.replacementDispatchId !== null) {
      known.set(recovery.replacementDispatchId, {
        role: recovery.role,
        attemptId: recovery.businessAttemptId,
      });
    }
  }
  return known;
}

type DerivedItem = Phase & { readonly worktreePath: string | null; readonly liveness: WorkerLiveness | null };

function deriveWorkPackage(
  input: DeriveExecutionFactsInput,
  node: ExecutionNodeFacts,
  workflow: WorkPackageWorkflowFacts,
  dependenciesSatisfied: boolean,
): DerivedItem {
  const observations = input.observations;
  const worktreePath = observations.worktreePaths.get(node.workPackageId) ?? null;
  const known = knownDispatches(workflow);

  /** 可核验的 Worker 观察：只在列举过执行主机时才存在。 */
  const observed = observations.workersEnumerated
    ? observations.workers
        .filter((entry) => known.has(entry.dispatchId))
        .map((entry) => ({
          dispatch: known.get(entry.dispatchId) as { readonly role: WorkerRole; readonly attemptId: string },
          liveness: livenessOf(entry),
        }))
    : [];
  const running = observed.filter((entry) => entry.liveness === 'live');

  // 1. revision pending：持有是调度事实，它本身就是该 Work Package 的当前阶段。
  if (workflow.revisionHold !== null) {
    return {
      ...phase('revision_pending', {
        derivedFrom: [`revision-hold:${workflow.revisionHold.sourceRef}`],
      }),
      worktreePath,
      liveness: running.length > 0 ? 'live' : null,
    };
  }

  // 2. Baseline Reconciliation：核验中与冲突升级都呈现为 reconciling，严重性由 severity 单独表达。
  if (workflow.reconciliation !== null && workflow.reconciliation.state !== 'verified') {
    return {
      ...phase('reconciling', {
        role: 'planner',
        derivedFrom: [`reconciliation:${workflow.reconciliation.reconciliationId}`],
        blockerRefs:
          workflow.reconciliation.blockerRef === null
            ? []
            : [`reconciliation:${workflow.reconciliation.blockerRef}`],
      }),
      worktreePath,
      liveness: running.length > 0 ? 'live' : null,
    };
  }

  // 3. 阻塞的 Recovery / Baseline Adoption 是明确 blocker，不再猜阶段。
  const blockedRecovery = workflow.recoveries.find((recovery) => recovery.status === 'blocked');
  if (blockedRecovery !== undefined) {
    return {
      ...phase('blocked', {
        role: blockedRecovery.role,
        attemptId: blockedRecovery.businessAttemptId,
        derivedFrom: [`recovery:${blockedRecovery.recoveryId}`],
        blockerRefs: [blockedRecovery.blockingReason ?? `recovery:${blockedRecovery.recoveryId}`],
      }),
      worktreePath,
      liveness: running.length > 0 ? 'live' : null,
    };
  }
  if (workflow.adoption !== null && workflow.adoption.state === 'blocked') {
    return {
      ...phase('blocked', {
        derivedFrom: [`adoption:${workflow.adoption.adoptionId}`],
        blockerRefs: [workflow.adoption.blockingReason ?? `adoption:${workflow.adoption.adoptionId}`],
      }),
      worktreePath,
      liveness: running.length > 0 ? 'live' : null,
    };
  }

  // 4. 已接受的最远角色决定阶段。
  const furthest = furthestAcceptedRole(workflow.settlements);
  let current: Phase = phase('waiting');
  if (furthest === 'validator') {
    const settlement = latestSettlementFor(workflow.settlements, 'validator');
    const integrationRef = workflow.adoption?.integrationRef ?? null;
    current = phase(integrationRef === null ? 'waiting_integration' : 'accepted', {
      role: 'validator',
      attemptId: settlement?.attemptId ?? null,
      validation: {
        state: 'validated',
        acceptedResultRef: settlement?.orcaResultRef ?? null,
        evidenceRefs: settlement === null ? [] : [`orca-result:${settlement.orcaResultRef}`],
      },
      // 集成事实没有本地生产者：只表达「角色工作已完成、可以进入集成」，不声称集成正在进行或已完成。
      integration: integrationRef === null ? { state: 'waiting', ref: null } : { state: 'integrated', ref: integrationRef },
      derivedFrom:
        settlement === null ? [] : [`settlement:${settlement.dedupeKey}`, `attempt:${settlement.attemptId}`],
    });
    if (integrationRef !== null && workflow.adoption !== null) {
      current = { ...current, derivedFrom: [...current.derivedFrom, `adoption:${workflow.adoption.adoptionId}`] };
    }
  } else if (furthest === 'implementation') {
    const settlement = latestSettlementFor(workflow.settlements, 'implementation');
    current = phase('validating', {
      role: 'implementation',
      attemptId: settlement?.attemptId ?? null,
      // 实现已接受、验证尚未给出结论：这是验证阶段本身，不是「验证已通过」。
      validation: {
        state: 'validating',
        acceptedResultRef: settlement?.orcaResultRef ?? null,
        evidenceRefs: settlement === null ? [] : [`orca-result:${settlement.orcaResultRef}`],
      },
      derivedFrom:
        settlement === null ? [] : [`settlement:${settlement.dedupeKey}`, `attempt:${settlement.attemptId}`],
    });
  } else if (furthest === 'planner') {
    const settlement = latestSettlementFor(workflow.settlements, 'planner');
    current = phase('implementing', {
      role: 'planner',
      attemptId: settlement?.attemptId ?? null,
      derivedFrom:
        settlement === null ? [] : [`settlement:${settlement.dedupeKey}`, `attempt:${settlement.attemptId}`],
    });
  }

  // 5. 仍在运行的 Worker 把阶段推进到它的角色；没有列举执行主机时这里不推进，也不据此下结论。
  const runningEntry = running.at(-1) ?? null;
  if (runningEntry !== null) {
    current = {
      ...phase(ROLE_PHASE[runningEntry.dispatch.role], {
        role: runningEntry.dispatch.role,
        attemptId: runningEntry.dispatch.attemptId,
        derivedFrom: [`worker-live:${runningEntry.dispatch.attemptId}`],
      }),
      validation: current.validation,
      integration: current.integration,
    };
  }

  /**
   * 存活结论。
   *
   * 只在**最终阶段**上判定：阶段可能由后面的规则（物化绑定、依赖等待）继续修正，因此在阶段定型前
   * 计算会把「已结束角色工作的包」也标成不可核验，让对账门与危险态永久为真。
   */
  const livenessOfPhase = (state: WorkPackageExecutionState): WorkerLiveness | null =>
    runningEntry !== null
      ? 'live'
      : observed.length > 0
        ? (observed.at(-1)?.liveness ?? null)
        : WORKER_EXPECTED_STATES.has(state) &&
            (workflow.binding !== null || workflow.segments.length > 0)
          ? // 该阶段可能有角色级 Worker，但执行主机没有列举：唯一诚实的存活结论是不可核验。
            'unverifiable'
          : null;

  // 6. 有 Session Segment（会话中断）但没有可核验的继续事实：中断已记录、后续不可核验。
  if (current.state === 'waiting' && workflow.segments.length > 0) {
    const segment = workflow.segments.reduce((latest, item) =>
      item.recordedAt >= latest.recordedAt ? item : latest,
    );
    return {
      ...phase('unknown', {
        role: segment.role,
        attemptId: segment.attemptId,
        derivedFrom: [`session-segment:${segment.segmentId}`, `attempt:${segment.attemptId}`],
      }),
      worktreePath,
      // 中断已记录但后续不可核验：这里是「无法核验」，不是「已退出」。
      liveness: livenessOfPhase('unknown') ?? 'unverifiable',
    };
  }

  // 7. 已有角色级 Orca Task（物化绑定）但还没有任何已接受结果：规格阶段。
  if (current.state === 'waiting' && workflow.binding !== null) {
    current = phase('specifying', {
      derivedFrom: [`materialization:${workflow.binding.orcaTaskId}`],
    });
  }

  // 8. 依赖已满足、尚无任何执行事实：可以成为 Dispatch Candidate；否则仍在等待依赖。
  if (current.state === 'waiting') {
    current = phase(dependenciesSatisfied ? 'admitting' : 'waiting');
  }

  return { ...current, worktreePath, liveness: livenessOfPhase(current.state) };
}

/* -------------------------------------------------------------------------- */
/* 三个独立事实（实现完成 / 验证通过 / 项目可交付）                            */
/* -------------------------------------------------------------------------- */

function workPackageStatusOf(
  workPackageId: string,
  settlements: readonly DeliverySettlementRecord[],
  verdict: CoordinationSnapshot['deliveryVerdicts'][number] | null,
): WorkPackageStatus {
  let status = initialWorkPackageStatus(workPackageId as WorkPackageId);

  const implementation = latestSettlementFor(settlements, 'implementation');
  if (implementation !== null) {
    status = withImplementationStatus(status, {
      kind: 'implemented',
      attemptId: implementation.attemptId,
      acceptedResultRef: implementation.orcaResultRef,
    });
  }
  const validation = latestSettlementFor(settlements, 'validator');
  if (validation !== null) {
    status = withValidationStatus(status, {
      kind: 'validated',
      validationAttemptId: validation.attemptId,
      acceptedResultRef: validation.orcaResultRef,
    });
  }
  if (verdict !== null) {
    status = withDeliveryStatus(
      status,
      verdict.verdict.kind === 'deliverable'
        ? { kind: 'deliverable', verdictRef: verdict.verdictId }
        : { kind: 'blocked', verdictRef: verdict.verdictId, blockerRefs: verdict.verdict.blockerRefs },
    );
  }
  return status;
}

/* -------------------------------------------------------------------------- */
/* 派生入口                                                                    */
/* -------------------------------------------------------------------------- */

function latestVerdict(
  snapshot: CoordinationSnapshot,
): CoordinationSnapshot['deliveryVerdicts'][number] | null {
  return snapshot.deliveryVerdicts.reduce<CoordinationSnapshot['deliveryVerdicts'][number] | null>(
    (latest, current) =>
      latest === null || current.verdictSequence >= latest.verdictSequence ? current : latest,
    null,
  );
}

/** 只比较调用方读到的运行前后事实；没有运行记录时不判定「已变化」。 */
function workspaceChanged(workspace: {
  readonly before: FinalizerWorkspaceFacts;
  readonly after: FinalizerWorkspaceFacts;
}): boolean {
  const { before, after } = workspace;
  if (before.head !== after.head || before.indexRevision !== after.indexRevision) {
    return true;
  }
  const beforePaths = [...before.dirtyPaths].sort();
  const afterPaths = [...after.dirtyPaths].sort();
  return (
    beforePaths.length !== afterPaths.length ||
    beforePaths.some((path, index) => path !== afterPaths[index])
  );
}

/** 一个已结算 Delivery 是否属于该节点：两边都是 Orca Task 身份，经物化绑定对齐。 */
function settlementsFor(
  snapshot: CoordinationSnapshot,
  node: ExecutionNodeFacts,
): readonly DeliverySettlementRecord[] {
  const binding = snapshot.materializationBindings.find(
    (entry) => entry.workPackageId === node.workPackageId,
  );
  if (binding === undefined) {
    return [];
  }
  return snapshot.deliverySettlements.filter(
    (settlement) => settlement.workerTaskId === (binding.orcaTaskId as WorkerTaskId),
  );
}

/**
 * 派生执行阶段投影。
 *
 * `frontier` 覆盖当前 GraphVersion 的每个节点，顺序与传入的编译顺序一致；依赖是否满足只依据**已经
 * 派生出的前驱节点**是否为 `accepted`，因此不会把「前驱还没跑完」读成「可以派发」。
 */
export function deriveExecutionFacts(input: DeriveExecutionFactsInput): DerivedExecutionFacts {
  const { snapshot } = input;
  const derived = new Map<string, DerivedItem>();

  const frontier = input.nodes.map<WorkPackageExecutionEntry>((node) => {
    const settlements = settlementsFor(snapshot, node);
    const dependenciesSatisfied = node.dependsOn.every(
      (dependency) => derived.get(dependency)?.state === 'accepted',
    );
    const item = deriveWorkPackage(
      input,
      node,
      {
        revisionHold:
          snapshot.revisionHolds.find(
            (hold) => hold.workPackageId === node.workPackageId && hold.state === 'pending',
          ) ?? null,
        reconciliation:
          snapshot.baselineReconciliations
            .filter((reconciliation) => reconciliation.workPackageId === node.workPackageId)
            .reduce<CoordinationSnapshot['baselineReconciliations'][number] | null>(
              (latest, current) =>
                latest === null || current.updatedAt >= latest.updatedAt ? current : latest,
              null,
            ),
        recoveries: snapshot.recoveries.filter(
          (recovery) => recovery.workPackageId === node.workPackageId,
        ),
        adoption:
          snapshot.baselineAdoptions
            .filter((adoption) => adoption.workPackageId === node.workPackageId)
            .reduce<CoordinationSnapshot['baselineAdoptions'][number] | null>(
              (latest, current) =>
                latest === null || current.recordedAt >= latest.recordedAt ? current : latest,
              null,
            ),
        settlements,
        segments: snapshot.sessionSegments.filter(
          (segment) => segment.workPackageId === node.workPackageId,
        ),
        binding:
          snapshot.materializationBindings.find(
            (binding) => binding.workPackageId === node.workPackageId,
          ) ?? null,
      },
      dependenciesSatisfied,
    );
    derived.set(node.workPackageId, item);
    return {
      workPackageId: node.workPackageId,
      state: item.state,
      role: item.role,
      attemptId: item.attemptId,
      liveness: item.liveness,
      worktreePath: item.worktreePath,
      baselineHead: input.baselineHead,
      validation: item.validation,
      integration: item.integration,
      derivedFrom: item.derivedFrom,
      blockerRefs: item.blockerRefs,
    };
  });

  const reconciliations = snapshot.baselineReconciliations
    .map(reconciliationEntry)
    .sort((left, right) => left.reconciliationId.localeCompare(right.reconciliationId));

  const verdict = latestVerdict(snapshot);
  const dispatch = planFinalizerDispatch({
    workPackageStatuses: input.nodes.map((node) =>
      workPackageStatusOf(node.workPackageId, settlementsFor(snapshot, node), verdict),
    ),
    pendingInteractionCount: snapshot.pendingInteractions.filter(
      (interaction) => interaction.state === 'open',
    ).length,
    unresolvedMutationCount: snapshot.unresolvedIntents.length,
    authority:
      input.authority ?? {
        planner: false,
        implementation: false,
        validator: false,
        finalizer: false,
        gitIntegration: false,
        dependencyChanges: false,
      },
  });

  const observation = input.observations.finalizer;
  const workspace = observation?.workspace ?? null;
  const gateBlockers = dispatch.kind === 'not_ready' ? [...dispatch.blockers] : [];
  if (observation !== null && observation.readOnlyProfile === 'unenforceable') {
    gateBlockers.push('finalizer-read-only-not-enforceable');
  }
  if (workspace !== null && workspaceChanged(workspace)) {
    gateBlockers.push('finalizer-workspace-changed');
  }

  const activeWorkerCount = frontier.filter(
    (entry) => entry.liveness === 'live' || entry.liveness === 'unverifiable',
  ).length;
  const unresolvedIntentCount = snapshot.unresolvedIntents.length;
  const reasons: string[] = [];
  if (unresolvedIntentCount > 0) {
    reasons.push(`unresolved-intents:${String(unresolvedIntentCount)}`);
  }
  if (activeWorkerCount > 0) {
    reasons.push(`active-workers:${String(activeWorkerCount)}`);
  }
  reasons.push(...input.observations.unavailableReasons);

  return {
    frontier,
    reconciliations,
    finalizer: {
      gate: { ready: dispatch.kind === 'dispatch' && gateBlockers.length === 0, blockers: gateBlockers },
      coversWorkPackageIds: dispatch.kind === 'dispatch' ? [...dispatch.plan.coversWorkPackageIds] : [],
      worktreePath: observation?.worktreePath ?? null,
      readOnlyProfile: observation?.readOnlyProfile ?? 'unverified',
      integrationFrozen: observation?.integrationFrozen ?? 'unknown',
      workspace,
      evidenceRefs: observation?.evidenceRefs ?? [],
      verdict:
        verdict === null
          ? null
          : {
              verdictId: verdict.verdictId,
              kind: verdict.verdict.kind,
              refs:
                verdict.verdict.kind === 'deliverable'
                  ? [...verdict.verdict.evidenceRefs]
                  : [...verdict.verdict.blockerRefs],
              sessionBindingRef: verdict.sessionBindingRef,
              recordedAt: verdict.recordedAt,
            },
    },
    executionReconciliation: {
      pending: unresolvedIntentCount > 0 || activeWorkerCount > 0,
      unresolvedIntentCount,
      activeWorkerCount,
      reasons,
    },
  };
}

/** 一个已派发 Worker 的只读投影；`liveness` 只在能核验时不是 `unverifiable`。 */
export type WorkerEntryView = {
  readonly dispatchId: string;
  readonly workerTaskId: string;
  readonly workPackageId: string;
  readonly role: WorkerRole;
  readonly liveness: WorkerLiveness;
};

/**
 * Worker 投影。
 *
 * 名单只来自持久记录（Session Segment、已结算 Delivery 与 Recovery 的替代 Dispatch），因此界面不会
 * 显示一个本地没有依据的 Worker；没有列举执行主机时存活结论一律是 `unverifiable`，不假设已退出。
 */
export function deriveWorkerEntries(input: {
  readonly snapshot: CoordinationSnapshot;
  readonly observations: ExecutionObservationFacts;
}): readonly WorkerEntryView[] {
  const entries = new Map<string, Omit<WorkerEntryView, 'liveness'>>();
  for (const segment of input.snapshot.sessionSegments) {
    entries.set(segment.dispatchId, {
      dispatchId: segment.dispatchId,
      workerTaskId: segment.workerTaskId,
      workPackageId: segment.workPackageId,
      role: segment.role,
    });
  }
  for (const binding of input.snapshot.materializationBindings) {
    for (const settlement of input.snapshot.deliverySettlements) {
      if (settlement.workerTaskId !== (binding.orcaTaskId as WorkerTaskId)) {
        continue;
      }
      entries.set(settlement.dispatchId, {
        dispatchId: settlement.dispatchId,
        workerTaskId: settlement.workerTaskId,
        workPackageId: binding.workPackageId,
        role: settlement.role,
      });
    }
  }
  for (const recovery of input.snapshot.recoveries) {
    if (recovery.replacementDispatchId === null) {
      continue;
    }
    entries.set(recovery.replacementDispatchId, {
      dispatchId: recovery.replacementDispatchId,
      workerTaskId: recovery.workerTaskId,
      workPackageId: recovery.workPackageId,
      role: recovery.role,
    });
  }

  return [...entries.values()].map<WorkerEntryView>((entry) => {
    const observation = input.observations.workersEnumerated
      ? (input.observations.workers.find((candidate) => candidate.dispatchId === entry.dispatchId) ?? null)
      : null;
    return { ...entry, liveness: observation === null ? 'unverifiable' : livenessOf(observation) };
  });
}

/** 危险态判定：无法核验的 Worker 与仍在运行的 Worker 同等计入 hazard。 */
export function controlHazards(input: {
  readonly frontier: readonly WorkPackageExecutionEntry[];
  readonly openInteractionCount: number;
  readonly unresolvedIntentCount: number;
}): ControlHazardsView {
  const activeWorkerCount = input.frontier.filter((entry) => entry.liveness === 'live').length;
  const unverifiedWorkerCount = input.frontier.filter(
    (entry) => entry.liveness === 'unverifiable',
  ).length;
  return {
    activeWorkerCount,
    unverifiedWorkerCount,
    openInteractionCount: input.openInteractionCount,
    unresolvedOperationCount: input.unresolvedIntentCount,
    hazardous:
      activeWorkerCount > 0 ||
      unverifiedWorkerCount > 0 ||
      input.openInteractionCount > 0 ||
      input.unresolvedIntentCount > 0,
  };
}
