/**
 * IC-11 / IP-03：单步 Execution Frontier / 角色物化驱动（Owner: `m2-wire-execution-runtime`）。
 *
 * 一次调用只做一件事：从**已接受的角色结果 + 图依赖 + 持有 + 预算/门禁**推出当前候选的下一步角色，
 * 给它签发稳定 OperationId，然后交给既有的 `materializeWorkPackage` 执行。因此这里没有第二份生命
 * 周期状态机、没有第二张图、不预建整图：阶段来自只读投影，准入来自前驱的纯判定，副作用来自前驱的
 * 物化用例。
 *
 * 四条不可让步的边界：
 * - **一次一个阶段**：至多一次 `materializeWorkPackage`；某包已有 `live` 或无法核验
 *   （`unverifiable`）的 Worker 时等待该包，独立包继续按批准额度准入；
 * - **身份稳定**：OperationId 由 Scope、Graph Generation、Work Package、角色、Task Contract
 *   Revision、Attempt 与步骤派生，同一 lane 上已有未决意图时优先复用它的 ID。不读时钟、不用随机数；
 * - **不换 ID 重试**：`unknown` 以原 OperationId 返回、lane 留给对账；只有 store 里确实存在的 lane
 *   阻塞才返回 `blocked`，纯判定（授权、预算、控制状态、持有）的拒绝一律是 `idle` 加拒绝码；
 * - **不猜事实**：读不到快照、图版本、授权记录、预算计数或未决意图时一律停在 blocker，而不是用默认
 *   值继续。
 *
 * 在途修订节点是这四条之上的一条受控例外：持有不因旧 Worker 结算而释放，但当一个节点满足
 * `revisionPlannerFacts` 列出的全部条件时，它的一次 Specification Planner 派发被允许（见 D1/D2）。
 */

import type {
  CoordinationScopeId,
  GraphId,
  GraphVersion,
  OperationId,
  Revision,
  WorkPackageId,
} from '../dto/identity.js';
import { laneKeyOf, type OperationIntent } from '../dto/operation-intent.js';
import type { ExecutionBackend } from '../ports/execution-backend.js';
import type {
  BranchCoordinationStore,
  CoordinationSnapshot,
  CoordinationWriter,
  ScopeRecord,
} from '../ports/branch-coordination-store.js';
import type {
  BudgetConsumption,
  DispatchAuthorizationState,
  DispatchCandidateFacts,
  RevisionPlannerPermit,
  WorkPackageBudgetField,
  WorkPackageLifecycleStage,
} from '../../domain/dispatch-candidate.js';
import { WORK_PACKAGE_BUDGET_FIELDS, workPackageBudgetKey, budgetFieldExhausted } from '../../domain/dispatch-candidate.js';
import { frozenWorkPackageIds } from '../../domain/execution/revision-pending.js';
import { acceptedResultMatchesTask } from '../../domain/worker-result-verification.js';
import type { CanonicalHeadFacts } from '../../domain/git-integration-policy.js';
import type { ExecutionGraph, WorkPackage } from '../../domain/planning/execution-graph.js';
import { graphVersionChain } from '../../domain/planning/execution-graph.js';
import type {
  ExecutionAuthorizationRecord,
  WorkerRole,
} from '../../domain/planning/execution-authorization.js';
import type { TaskEnvelope } from '../../domain/task-contract.js';
import { activeAuthorization } from '../planning/authorization-service.js';
import { readScope } from '../planning/scope-read.js';
import { guardDispatchCandidate } from '../dispatch-guard.js';
import {
  materializeWorkPackage,
  type MaterializeOperationIds,
  type MaterializeWorkPackageResult,
} from '../materialize-work-package.js';
import type { WorkerLaunchStrategy } from '../worker-launch.js';
import { effectiveBudgetConsumption } from './baseline-adoption.js';
import {
  deriveExecutionFacts,
  workerStateLiveness,
  type ExecutionNodeFacts,
  type ExecutionObservationFacts,
  type WorkPackageExecutionEntry,
  type WorkPackageExecutionState,
} from './execution-view.js';

/* -------------------------------------------------------------------------- */
/* 结果闭集                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 一次推进的结论。
 *
 * `progressed` 只表示「这一步的副作用已确认落地」；`idle` 表示本轮没有可推进的候选或候选被判定拒绝
 * （附拒绝码与说明）；`blocked` 表示某个 mutation lane 在 store 里被阻塞；`unknown` 表示副作用是否
 * 发生无法核验，必须以同一个 OperationId 对账。
 */
export type AdvanceExecutionResult =
  | {
      readonly kind: 'progressed';
      readonly workPackageId: WorkPackageId;
      readonly role: WorkerRole;
      readonly orcaTaskId: string;
      readonly dispatchId: string | null;
    }
  | { readonly kind: 'idle'; readonly reason: string; readonly blockers: readonly string[] }
  | { readonly kind: 'blocked'; readonly laneKey: string; readonly code: string; readonly message: string }
  | { readonly kind: 'unknown'; readonly operationId: OperationId; readonly reason: string };

/* -------------------------------------------------------------------------- */
/* 公开输入                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 一个角色的派发装配。
 *
 * 这些事实都属于 Controller 与可信 bootstrap：Task Envelope 由 Controller 从授权、图记录与 Scope
 * 派生，启动策略由 Manifest 的 Worker Profile 选定。执行驱动只把它们装进物化用例，不生成也不改写
 * 其中的 Orca 身份。
 */
export type AdvanceRoleDispatch = {
  /** 该角色的 Task Envelope 骨架；`workspace.worktreeId` 由物化阶段绑定。 */
  readonly taskEnvelope: TaskEnvelope;
  /** 可信 bootstrap 选择的封闭启动策略；prepared launcher 只能由 Harness Adapter 生成。 */
  readonly workerLaunch: WorkerLaunchStrategy;
  /** 与 `workerLaunch` 同源的 launch 身份；物化绑定据此补记 Session Binding。 */
  readonly launchId: string;
  readonly authorizationId: string;
  readonly authorizationVersion: number;
  readonly workerProfileRef: string;
  readonly consumerGeneration: number;
  readonly backendIdentityRef: string;
  readonly timeoutMs: number;
  /** 本次派发实际消费的预算项；`null` 表示该角色派发不消耗预算。 */
  readonly requiredBudgetField: WorkPackageBudgetField | null;
  readonly taskTitle?: string;
  readonly displayName?: string;
  readonly taskDependencies?: readonly string[];
};

export type AdvanceExecutionInput = {
  readonly store: BranchCoordinationStore;
  readonly backend: ExecutionBackend;
  readonly coordinationScopeId: CoordinationScopeId;
  /**
   * 本 Session 的协调身份。
   *
   * Execution Coordination Lease 的唯一性在这里再判一次（非持有者连一次外部 mutation 都不发起）；
   * scope revision、fencing 与 lane 的唯一性由 store 的写入路径判定，本用例不复制那些规则。
   */
  readonly writer: CoordinationWriter;
  /** 调用方读到的 Scope revision；已过期即停在 blocker，而不是用刚读到的值替它猜。 */
  readonly expectedRevision: Revision;
  /** 派发前的 canonical HEAD 归属事实；由 Controller 从 Git 读入（本用例不读 Git）。 */
  readonly canonicalHead: CanonicalHeadFacts;
  /** Orca 只读观察；未列举时用 `noExecutionObservations`，不把「没观察到」读成「没在跑」。 */
  readonly observations: ExecutionObservationFacts;
  /** 角色级派发装配；缺少当前候选所需角色时不派发。 */
  readonly roles: Partial<Record<WorkerRole, AdvanceRoleDispatch>>;
  /** 宿主已完成角色装配的包；仍重新核验其准入，不替其他包派发。 */
  readonly selectedWorkPackageId?: WorkPackageId;
};

/* -------------------------------------------------------------------------- */
/* 稳定身份                                                                    */
/* -------------------------------------------------------------------------- */

const ADVANCE_STEPS = ['worktree', 'task', 'workerPrepare', 'workerStart', 'workerActivate'] as const;

type AdvanceStep = (typeof ADVANCE_STEPS)[number];

/**
 * 每个步骤在物化用例里的 mutation lane（目标 + 操作类别）。
 *
 * 必须与 `materializeWorkPackage` 的 `runMutation` 完全一致，否则「复用未决 lane 的原 OperationId」
 * 会指向一条不存在的 lane，反而换出一个新身份。测试用真实物化产生的 intent laneKey 反证这一点。
 */
const STEP_LANE: Readonly<Record<AdvanceStep, { readonly kind: string; readonly category: string }>> = {
  worktree: { kind: 'worktree', category: 'materialize-worktree' },
  task: { kind: 'task', category: 'materialize-task' },
  workerPrepare: { kind: 'worker-task', category: 'materialize-worker-terminal' },
  workerStart: { kind: 'worker-task', category: 'materialize-worker-start' },
  workerActivate: { kind: 'worker-task', category: 'materialize-worker-activate' },
};

/**
 * 一次物化的稳定分步骤 OperationId。
 *
 * 身份只由已提交的候选事实组成，不含时钟、随机数与进程内计数：同一候选（同一 Scope、Generation、
 * Work Package、角色、契约 revision 与 Attempt）重启后必须得到同一组 ID，否则一个可能已经发生的
 * 副作用会被当成新操作重发。分段做 URI 编码，避免拼接键在分段边界上碰撞。
 *
 * `unresolvedIntents` 里同一 lane 上已有未决（或已阻塞）意图时，沿用它的 OperationId：那是「这次
 * 副作用可能已经发生」的唯一本地证据，对账只能按原身份进行。
 */
export function materializeOperationIdsFor(input: {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly graphId: GraphId;
  readonly graphGeneration: number;
  readonly workPackageId: WorkPackageId;
  readonly role: WorkerRole;
  readonly contractRevision: number;
  readonly attemptId: string;
  readonly unresolvedIntents?: readonly OperationIntent[];
  readonly settledRejectedIntents?: readonly OperationIntent[];
}): MaterializeOperationIds {
  const prefix = [
    input.coordinationScopeId,
    input.graphId,
    String(input.graphGeneration),
    input.workPackageId,
    input.role,
    String(input.contractRevision),
    input.attemptId,
  ]
    .map((segment) => encodeURIComponent(segment))
    .join(':');

  const onLane = new Map<string, OperationId>();
  for (const intent of input.unresolvedIntents ?? []) {
    if (intent.state !== 'settled') {
      onLane.set(intent.laneKey, intent.operationId);
    }
  }

  const identify = (step: AdvanceStep): OperationId => {
    const lane = STEP_LANE[step];
    const base = `${prefix}:${step}`;
    const rejected = (input.settledRejectedIntents ?? []).filter((intent) =>
      intent.state === 'settled' && intent.outcomeClass === 'rejected' &&
      (intent.operationId === base || intent.operationId.startsWith(`${base}:retry:`)),
    ).length;
    return (
      onLane.get(laneKeyOf({ kind: lane.kind, id: input.workPackageId }, lane.category)) ??
      ((rejected === 0 ? base : `${base}:retry:${rejected}`) as OperationId)
    );
  };

  return {
    worktree: identify('worktree'),
    task: identify('task'),
    workerPrepare: identify('workerPrepare'),
    workerStart: identify('workerStart'),
    workerActivate: identify('workerActivate'),
  };
}

/* -------------------------------------------------------------------------- */
/* 派生辅助                                                                    */
/* -------------------------------------------------------------------------- */

function idle(reason: string, blockers: readonly string[]): AdvanceExecutionResult {
  return { kind: 'idle', reason, blockers };
}

function blocked(laneKey: string, code: string, message: string): AdvanceExecutionResult {
  return { kind: 'blocked', laneKey, code, message };
}

/**
 * 下一步该派发哪个角色；`null` 表示这个 Work Package 此刻没有可推进的角色。
 *
 * 只读投影已经把「走到哪一步」定死了，这里只做一次角色序映射，不重新推导生命周期：
 * - `revision_pending` 且带匹配的受限 Planner 许可：在途修订节点从 Specification Planner 重跑；
 * - `admitting`：依赖已满足且没有任何执行事实 → 第一个角色 planner；
 * - `implementing` 且当前角色仍是 planner：planner 结果已被接受 → implementation；
 * - `validating` 且当前角色是 implementation：实现结果已被接受 → validator。
 *
 * 其余阶段都不在这里推进：`specifying`、`unknown` 属于 Recovery 的范围；`reconciling`、
 * 没有许可的 `revision_pending`、`blocked`、`repairing` 是 blocker；`waiting` 是依赖未满足；
 * `waiting_integration`、`accepted` 的角色工作已经结束。
 *
 * 这是唯一一份角色序判定：宿主装配候选与执行驱动都调用它，因此「界面上的候选」与「实际派发的候选」
 * 不可能出现两种说法。
 */
export function nextAdvanceRoleOf(entry: {
  readonly state: WorkPackageExecutionState;
  readonly role: WorkerRole | null;
  readonly revisionPlanner: RevisionPlannerPermit | null;
}): WorkerRole | null {
  if (entry.revisionPlanner !== null) {
    return 'planner';
  }
  switch (entry.state) {
    case 'admitting':
      return 'planner';
    case 'implementing':
      return entry.role === 'planner' ? 'implementation' : null;
    case 'validating':
      return entry.role === 'implementation' ? 'validator' : null;
    default:
      return null;
  }
}

/** 没有可推进的候选时，把 Frontier 的现状作为 blocker 如实列出，而不是只说一句「没有候选」。 */
export function frontierBlockersOf(frontier: readonly WorkPackageExecutionEntry[]): readonly string[] {
  return frontier.map(
    (entry) =>
      `frontier:${entry.workPackageId}:${entry.state}${entry.role === null ? '' : `:${entry.role}`}`,
  );
}

/** 调度与宿主装配共用的候选选择；包级阻塞不遮住独立 lane。 */
export function selectAdvanceCandidate(input: {
  readonly graph: ExecutionGraph;
  readonly snapshot: CoordinationSnapshot;
  readonly frontier: readonly WorkPackageExecutionEntry[];
  readonly observations: ExecutionObservationFacts;
  readonly materializationIntents: readonly OperationIntent[];
  readonly maxActiveWorkPackages: number;
  readonly excludedWorkPackageIds?: ReadonlySet<string>;
  readonly selectedWorkPackageId?: WorkPackageId;
  readonly consumptionOf: (workPackageId: WorkPackageId) => readonly BudgetConsumption[] | null;
}): {
  readonly candidate: { readonly entry: WorkPackageExecutionEntry; readonly role: Exclude<WorkerRole, 'finalizer'>;
    readonly revisionPlannerPermit: RevisionPlannerPermit | null } | null;
  readonly blockers: readonly string[];
} {
  const revisions = revisionPlannerFacts(input);
  const blockers = revisions.denials.map(item => `revision-planner:${item.workPackageId}:${item.reason}`);
  if (!input.observations.workersEnumerated) return { candidate: null, blockers: ['worker-list:unverifiable'] };
  const lanes = input.snapshot.laneReservations.filter(item => item.graphId === input.graph.graphId &&
    item.generation === input.graph.generation && item.releasedAt === null);
  const occupied = new Set(lanes.map(item => item.workPackageId as string));
  // 生命周期事实仍覆盖尚未完成预约回读的同一调度事务。
  for (const entry of input.frontier) {
    if (entry.role !== null && !['accepted', 'retired', 'cancelled'].includes(entry.state)) occupied.add(entry.workPackageId);
  }
  for (const entry of input.frontier) {
    if (input.excludedWorkPackageIds?.has(entry.workPackageId) ||
      (input.selectedWorkPackageId !== undefined && entry.workPackageId !== input.selectedWorkPackageId)) continue;
    const permit = revisions.permits.find(item => item.workPackageId === entry.workPackageId) ?? null;
    const role = nextAdvanceRoleOf({ state: entry.state, role: entry.role, revisionPlanner: permit });
    if (role === null || role === 'finalizer') continue;
    if (entry.liveness === 'live' || entry.liveness === 'unverifiable') {
      blockers.push(`worker:${entry.workPackageId}:${entry.liveness}`);
      continue;
    }
    if (!occupied.has(entry.workPackageId) && occupied.size >= input.maxActiveWorkPackages) {
      blockers.push('capacity:full');
      continue;
    }
    const pending = input.snapshot.unresolvedIntents.find(item => item.target.id === entry.workPackageId);
    if (pending !== undefined) {
      blockers.push(`lane:${entry.workPackageId}:${pending.operationId}`);
      continue;
    }
    const started = input.snapshot.materializationBindings.some(binding => {
      if (binding.workPackageId !== entry.workPackageId || binding.identity !== 'issued' ||
        binding.role === null || binding.attemptId === null || input.snapshot.deliverySettlements.some(settlement =>
          acceptedResultMatchesTask(binding, settlement))) return false;
      const ids = materializeOperationIdsFor({ coordinationScopeId: input.snapshot.scope.coordinationScopeId,
        graphId: input.graph.graphId, graphGeneration: input.graph.generation,
        workPackageId: binding.workPackageId, role: binding.role,
        contractRevision: binding.specBinding?.contractRevision ?? 0, attemptId: binding.attemptId,
        unresolvedIntents: input.materializationIntents, settledRejectedIntents: input.materializationIntents });
      return input.materializationIntents.some(intent => intent.operationId === ids.workerStart);
    });
    if (started) {
      blockers.push(`worker-start:${entry.workPackageId}:awaiting-observation`);
      continue;
    }
    const workPackage = input.graph.workPackages.find(item => item.workPackageId === entry.workPackageId);
    if (workPackage === undefined) continue;
    const consumed = input.consumptionOf(workPackage.workPackageId);
    if (consumed === null) {
      blockers.push(`budget:${entry.workPackageId}:unreadable`);
      continue;
    }
    if (role === 'implementation' && budgetFieldExhausted(workPackage.budget.implementationAttempts,
      consumed.find(item => item.field === 'implementationAttempts')?.consumed ?? 0)) {
      blockers.push(`budget-exhausted:${workPackageBudgetKey(workPackage.workPackageId, 'implementationAttempts')}`);
      continue;
    }
    return { candidate: { entry, role, revisionPlannerPermit: permit }, blockers };
  }
  return { candidate: null, blockers: [...blockers, ...frontierBlockersOf(input.frontier)] };
}

/**
 * 执行阶段投影 → 物化用例的 Work Package 生命周期阶段。
 *
 * 只映射语义相同的取值：尚未进入 Frontier 的是 `pending`，角色工作已完成的是 `accepted`，已退役或
 * 取消的是 `retired`；其余（在 Frontier 中推进或受阻的）映射为 `frontier`，由候选判定的细分规则给
 * 出确定拒绝原因，而不是在这里猜。
 */
function lifecycleStageOf(state: WorkPackageExecutionState): WorkPackageLifecycleStage {
  switch (state) {
    case 'waiting':
      return 'pending';
    case 'accepted':
    case 'waiting_integration':
      return 'accepted';
    case 'retired':
    case 'cancelled':
      return 'retired';
    default:
      return 'frontier';
  }
}

/**
 * 依赖已通过的 Work Package 集合。
 *
 * 规则与只读投影同一份：只有前驱节点已被接受，依赖才算通过。这里只把投影的结论表达成集合，因此
 * 候选判定的「图依赖」检查与 Frontier 的显示不会出现两种说法。
 */
function dependenciesSatisfiedOf(
  graph: ExecutionGraph,
  frontier: readonly WorkPackageExecutionEntry[],
): readonly WorkPackageId[] {
  const stateOf = new Map(frontier.map((entry) => [entry.workPackageId, entry.state] as const));
  return graph.workPackages
    .filter((workPackage) => workPackage.dependsOn.every((dependency) => stateOf.get(dependency) === 'accepted'))
    .map((workPackage) => workPackage.workPackageId);
}

/** 受持有影响的节点与其未接受后代：由前驱的有界持有投影算出，不在这里重写拓扑规则。 */
function revisionPendingOf(
  graph: ExecutionGraph,
  snapshot: CoordinationSnapshot,
  frontier: readonly WorkPackageExecutionEntry[],
): readonly WorkPackageId[] {
  return frozenWorkPackageIds({
    graph,
    holds: snapshot.revisionHolds
      .filter((hold) => hold.state === 'pending')
      .map((hold) => ({
        workPackageId: hold.workPackageId,
        source: hold.source,
        sourceRef: hold.sourceRef,
      })),
    accepted: graph.workPackages
      .filter((workPackage) =>
        frontier.some(
          (entry) => entry.workPackageId === workPackage.workPackageId && entry.state === 'accepted',
        ),
      )
      .map((workPackage) => workPackage.workPackageId),
  });
}

/**
 * 受限修订 Planner 许可的派生结果。
 *
 * `denials` 只用于如实报告「被持有冻住的节点为什么还不能重跑 Planner」；判定本身只看 `permits`。
 */
export type RevisionPlannerFacts = {
  readonly permits: readonly RevisionPlannerPermit[];
  readonly denials: readonly { readonly workPackageId: WorkPackageId; readonly reason: string }[];
};

/**
 * 派生在途修订节点的受限 Planner 许可。
 *
 * 持有不因旧 Worker 结算而释放；这里回答的是**另一个**问题：什么条件下允许该节点重新跑一次
 * Specification Planner。条件是穷尽的：所有已签发绑定都有可核验结算、执行主机列举完整且该节点没有
 * live 或不可核验的 Worker、没有未核验的基线补救、修订额度未耗尽。任一项读不到或读不回来都拒绝并给出
 * 结构化原因，而不是用默认值继续。
 *
 * 判定只读事实，不产生副作用，也不改动持有；它由执行驱动与宿主候选装配共用，因此两侧拿到同一份结论。
 * 依赖、后代、其它角色、旧结果与 Git 集成继续被持有挡住——这里不放开任何别的口子。
 */
export function revisionPlannerFacts(input: {
  readonly graph: ExecutionGraph;
  readonly snapshot: CoordinationSnapshot;
  readonly observations: ExecutionObservationFacts;
  readonly consumptionOf: (workPackageId: WorkPackageId) => readonly BudgetConsumption[] | null;
}): RevisionPlannerFacts {
  const permits: RevisionPlannerPermit[] = [];
  const denials: { readonly workPackageId: WorkPackageId; readonly reason: string }[] = [];
  for (const hold of input.snapshot.revisionHolds.filter((entry) => entry.state === 'pending')) {
    const deny = (reason: string): void => {
      denials.push({ workPackageId: hold.workPackageId, reason });
    };
    if (hold.source !== 'graph_patch') {
      continue;
    }
    const workPackage = input.graph.workPackages.find(
      (entry) => entry.workPackageId === hold.workPackageId,
    );
    if (workPackage === undefined) {
      // 退场节点由退休路径释放持有，不由这里续办。
      continue;
    }
    if (!input.observations.workersEnumerated) {
      deny('worker-list:unverifiable');
      continue;
    }
    const bindings = input.snapshot.materializationBindings.filter(
      (binding) => binding.workPackageId === hold.workPackageId && binding.identity === 'issued',
    );
    const unsettled = bindings.find(
      (binding) =>
        !input.snapshot.deliverySettlements.some(
          (settlement) =>
            settlement.workerTaskId === binding.workerTaskId && settlement.role === binding.role,
        ),
    );
    if (unsettled !== undefined) {
      // 旧派发必须运行至可核验终态：结算本身就是那个终态的持久证据，不靠 Worker 列举推断。
      deny(`dispatch-unsettled:${unsettled.workerTaskId}`);
      continue;
    }
    const notExited = input.observations.workers.find(
      (worker) =>
        bindings.some((binding) => binding.orcaTaskId === worker.taskId) &&
        workerStateLiveness(worker.workerState) !== 'exited',
    );
    if (notExited !== undefined) {
      deny(`worker-not-exited:${notExited.dispatchId}`);
      continue;
    }
    if (
      input.snapshot.baselineReconciliations.some(
        (reconciliation) =>
          reconciliation.workPackageId === hold.workPackageId && reconciliation.state !== 'verified',
      )
    ) {
      deny('baseline-reconciliation:pending');
      continue;
    }
    const consumed = input.consumptionOf(hold.workPackageId);
    if (consumed === null) {
      deny('budget:unreadable');
      continue;
    }
    /**
     * 修订 Planner 只派发一次：持有登记之后已经有**已结算**的 Planner 交付时，缺的是持有结算
     * （与重新准入同一事务），不是再派一个 Planner。少了这条判定，宿主会在持有尚未结算的那一轮里
     * 再派一次修订 Planner；那一次一旦会话丢失，旧派发结算判定与持有结算判定会互相锁死，整条链路
     * 永久停在 `revision_pending`（真实运行 `orca-companion-e2e56` 实测）。
     */
    if (plannerDeliveryAfterHold(input.snapshot, hold) !== null) {
      deny('revision-already-delivered');
      continue;
    }
    const spent = consumed.find((entry) => entry.field === 'specificationRevisions')?.consumed ?? 0;
    if (budgetFieldExhausted(workPackage.budget.specificationRevisions, spent)) {
      deny(`budget-exhausted:${workPackageBudgetKey(hold.workPackageId, 'specificationRevisions')}`);
      continue;
    }
    permits.push({
      workPackageId: hold.workPackageId,
      sourceRef: hold.sourceRef,
      priorContractRevision: hold.priorContractRevision,
    });
  }
  return { permits, denials };
}

/**
 * 持有登记**之后**派发、且已经结算的 Planner 交付（没有则返回 `null`）。
 *
 * 「修订 Planner 已经交付」与「修订 Planner 还没派」是两件不同的事：前者要求结算持有（与重新准入
 * 同事务），后者才要派发。判定按持有自己的 `createdAt` 划界——被替换版本的 Planner 派发一定早于持有
 * （持有由随后的补丁登记），修订 Planner 一定晚于它——因此既不靠内容版本比较，也不靠时间戳猜历史。
 *
 * 只看已结算的交付：一次后发的、可能已经丢失会话（因而永远没有结算）的派发遮不掉先前那次。
 *
 * 宿主与派发门禁共用它：派发门禁据此拒绝重复派发，持有结算据此取接纳版本。
 */
export function plannerDeliveryAfterHold(
  snapshot: CoordinationSnapshot,
  hold: {
    readonly workPackageId: WorkPackageId;
    readonly createdAt: number;
  },
): CoordinationSnapshot['deliverySettlements'][number] | null {
  let newest: {
    readonly createdAt: number;
    readonly settlement: CoordinationSnapshot['deliverySettlements'][number];
  } | null = null;
  for (const binding of snapshot.materializationBindings) {
    if (
      binding.workPackageId !== hold.workPackageId ||
      binding.role !== 'planner' ||
      binding.identity !== 'issued' ||
      binding.createdAt <= hold.createdAt
    ) {
      continue;
    }
    const settlement = snapshot.deliverySettlements.find(
      (candidate) => candidate.role === 'planner' && candidate.workerTaskId === binding.workerTaskId,
    );
    if (settlement === undefined) {
      continue;
    }
    if (newest === null || binding.createdAt > newest.createdAt) {
      newest = { createdAt: binding.createdAt, settlement };
    }
  }
  return newest?.settlement ?? null;
}

/**
 * 实际已消耗额度：本代预算计数与 lineage 继承合并（继承由既有用例负责，不在这里重算）。
 *
 * 预算计数读不回来时返回 `null`：没有消耗事实就不能派发，否则「已经用完的额度」会被读成「还没用」。
 * 执行驱动与宿主候选装配共用它，因此两侧看到的是同一份消耗事实。
 */
export function consumedBudgetForWorkPackage(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
  workPackageId: WorkPackageId,
): readonly BudgetConsumption[] | null {
  const counters = store.query({ kind: 'budget-counters', coordinationScopeId });
  if (counters.kind !== 'budget-counters') {
    return null;
  }
  const own: BudgetConsumption[] = WORK_PACKAGE_BUDGET_FIELDS.map((field) => ({
    workPackageId,
    field,
    consumed:
      counters.counters.find((counter) => counter.budgetKey === workPackageBudgetKey(workPackageId, field))
        ?.consumed ?? 0,
  }));
  return effectiveBudgetConsumption({ store, coordinationScopeId, workPackageId, own });
}

/** 该 Scope 的意图；查询失败返回 `null`，由调用方 fail closed。 */
function intentsOf(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
): readonly OperationIntent[] | null {
  const result = store.query({ kind: 'intents', coordinationScopeId });
  return result.kind === 'intents' ? result.intents : null;
}

/**
 * 授权只可能来自当前有效的 Execution Authorization。
 *
 * 四个事实必须同时成立：Scope 的授权引用与记录版本一致、绑定的 GraphId 与 Generation 是当前图、
 * 且绑定时刻的 GraphVersion **仍在当前图的追加链上**。
 *
 * 刻意**不要求**绑定版本等于当前版本：Manifest 绑定的是批准时刻的图，而图会随 accepted revision 前移
 * （图补丁路径的同一规则见 `request-graph-patch.ts`）。要求两者相等会让「修订之后」的所有派发都不成立，
 * 等于把每一次合法的图修订变成必须重新审批的死锁。
 */
function dispatchAuthorization(input: {
  readonly scope: ScopeRecord;
  readonly authorization: ExecutionAuthorizationRecord;
  readonly graph: ExecutionGraph;
  readonly graphVersionChain: ReadonlySet<GraphVersion>;
}): DispatchAuthorizationState {
  const { authorization } = input;
  const pointerId = input.scope.authorizationId;
  const pointerVersion = input.scope.authorizationVersion;
  if (pointerId === null || pointerVersion === null) {
    return {
      valid: false,
      authorizationId: authorization.authorizationId,
      authorizationVersion: authorization.authorizationVersion,
      reason: 'Scope 尚未绑定任何 Execution Authorization',
    };
  }
  const bound = authorization.manifest.graph;
  if (
    authorization.authorizationId !== pointerId ||
    authorization.authorizationVersion !== pointerVersion ||
    bound.graphId !== input.graph.graphId ||
    bound.generation !== input.graph.generation ||
    !input.graphVersionChain.has(bound.version)
  ) {
    return {
      valid: false,
      authorizationId: authorization.authorizationId,
      authorizationVersion: authorization.authorizationVersion,
      reason: `Execution Authorization ${authorization.authorizationId}#${String(authorization.authorizationVersion)} 绑定的图与当前 Graph Generation 或版本链不一致`,
    };
  }
  return { valid: true, authorizationId: pointerId, authorizationVersion: pointerVersion, reason: null };
}

/** 物化结论 → 推进结论。 */
function advanceResultOf(
  result: MaterializeWorkPackageResult,
  workPackageId: WorkPackageId,
  role: WorkerRole,
): AdvanceExecutionResult {
  switch (result.kind) {
    case 'materialized':
      return {
        kind: 'progressed',
        workPackageId,
        role,
        orcaTaskId: result.orcaTaskId,
        dispatchId: result.dispatchId,
      };
    case 'rejected':
      return idle(result.failure.message, [`rejection:${result.failure.code}`]);
    case 'unknown':
      return { kind: 'unknown', operationId: result.operationId, reason: result.reason };
    case 'blocked':
      return blocked(result.laneKey, 'lane_blocked', result.reason);
  }
}

/* -------------------------------------------------------------------------- */
/* 入口                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 推进一个需要外部副作用的阶段。
 *
 * 顺序固定：读当前事实 → 推出候选与下一步角色 → 预算/门禁判定（复用 `guardDispatchCandidate`）→
 * 签发稳定 ID → 一次 `materializeWorkPackage`。任何一步读不到权威事实都停在 blocker，不产生副作用。
 */
export async function advanceExecution(input: AdvanceExecutionInput): Promise<AdvanceExecutionResult> {
  const scopeRead = readScope(input.store, input.coordinationScopeId);
  if (scopeRead.kind === 'rejected') {
    return blocked(input.coordinationScopeId, scopeRead.code, scopeRead.message);
  }
  const scope = scopeRead.scope;
  if (scope.mode !== 'execution_coordination') {
    return idle(`Scope 当前模式为 ${scope.mode}，执行驱动只推进 Execution Coordination`, []);
  }
  if (scope.revision !== input.expectedRevision) {
    return blocked(
      input.coordinationScopeId,
      'stale_revision',
      `调用方基于 revision ${String(input.expectedRevision)} 行动，当前为 ${scope.revision}`,
    );
  }

  const snapshotRead = input.store.query({ kind: 'snapshot', coordinationScopeId: input.coordinationScopeId });
  if (snapshotRead.kind !== 'snapshot') {
    return blocked(input.coordinationScopeId, 'invalid_state', '无法读取协调快照');
  }
  const snapshot = snapshotRead.snapshot;

  // 推进权属于 Execution Coordination Lease 的持有者：非持有者在这里就停住，不去触碰 Orca。
  const lease = snapshot.executionLease;
  if (lease === null) {
    return idle('Scope 当前没有 Execution Coordination Lease，没有推进者', ['execution-lease:absent']);
  }
  if (lease.coordinatorSessionId !== input.writer.coordinatorSessionId) {
    return idle(
      `Execution Coordination Lease 由 ${lease.coordinatorSessionId} 持有，本 Session 不推进 Execution Frontier`,
      ['execution-lease:not-holder'],
    );
  }

  const authorizationRead = activeAuthorization(input.store, input.coordinationScopeId);
  if (authorizationRead.kind === 'rejected') {
    return blocked(input.coordinationScopeId, authorizationRead.failure.code, authorizationRead.failure.message);
  }
  const authorization = authorizationRead.authorization;

  if (scope.graphId === null || scope.graphVersion === null) {
    return idle('Scope 还没有已记录的 Graph Version，没有可推进的 Execution Frontier', []);
  }
  const graphRead = input.store.query({
    kind: 'graph-version',
    coordinationScopeId: input.coordinationScopeId,
    graphId: scope.graphId,
    graphVersion: scope.graphVersion,
  });
  if (graphRead.kind !== 'graph-version' || graphRead.version === null) {
    return blocked(
      input.coordinationScopeId,
      'invalid_state',
      `无法读取 Graph Version ${String(scope.graphVersion)}`,
    );
  }
  const graph = graphRead.version.graph;
  // 授权的版本判定需要追加链：绑定时刻的版本只要仍在链上就仍然有效（图会随 accepted revision 前移）。
  const historyRead = input.store.query({
    kind: 'graph-versions',
    coordinationScopeId: input.coordinationScopeId,
    graphId: graph.graphId,
  });
  if (historyRead.kind !== 'graph-versions') {
    return blocked(input.coordinationScopeId, 'invalid_state', `无法读取 Graph ${graph.graphId} 的版本链`);
  }
  const authorizedVersions = graphVersionChain(historyRead.versions, graphRead.version);

  if (authorization === null) {
    return idle('Scope 尚无有效的 Execution Authorization，不能签发派发身份', ['authorization:missing']);
  }
  const authorizationFacts = dispatchAuthorization({
    scope,
    authorization,
    graph,
    graphVersionChain: authorizedVersions,
  });
  if (!authorizationFacts.valid) {
    return idle(authorizationFacts.reason ?? '当前 Graph Generation 没有有效的 Execution Authorization', [
      'authorization:invalid',
    ]);
  }

  if (!input.observations.workersEnumerated) {
    return idle('Worker 列举不可用，无法排除已有 Dispatch', ['worker-list:unverifiable']);
  }

  const nodes: readonly ExecutionNodeFacts[] = graph.workPackages.map((workPackage) => ({
    workPackageId: workPackage.workPackageId,
    dependsOn: workPackage.dependsOn,
  }));
  const derived = deriveExecutionFacts({
    snapshot,
    nodes,
    baselineHead: authorization.manifest.baselineHead,
    authority: authorization.manifest.permissions,
    observations: input.observations,
  });

  const intents = intentsOf(input.store, input.coordinationScopeId);
  if (intents === null) return blocked(input.coordinationScopeId, 'invalid_state', '无法读取派发意图');
  const selection = selectAdvanceCandidate({ graph, snapshot, frontier: derived.frontier, materializationIntents: intents,
    observations: input.observations, maxActiveWorkPackages: authorization.manifest.limits.maxActiveWorkPackages,
    ...(input.selectedWorkPackageId === undefined ? {} : { selectedWorkPackageId: input.selectedWorkPackageId }),
    consumptionOf: workPackageId => consumedBudgetForWorkPackage(input.store, input.coordinationScopeId, workPackageId),
  });
  if (selection.candidate === null) return idle('没有可推进且已获准入的 Work Package', selection.blockers);
  const { entry: candidate, role, revisionPlannerPermit } = selection.candidate;

  const dispatch = input.roles[role];
  if (dispatch === undefined) {
    return idle(`缺少 ${role} 角色的派发装配，无法为 Work Package ${candidate.workPackageId} 派发`, [
      `dispatch-missing:${role}`,
    ]);
  }
  if (
    dispatch.taskEnvelope.role !== role ||
    dispatch.taskEnvelope.taskContract.workPackageId !== candidate.workPackageId
  ) {
    return idle('派发装配的 Task Envelope 与候选角色或 Work Package 不一致', [
      `dispatch-mismatch:${candidate.workPackageId}:${role}`,
    ]);
  }
  // 身份取图自己的值：投影把 Work Package 标识摊平成字符串供多个显示入口共用，这里是本用例第一次
  // 真正把它当身份使用，因此回到图的权威取值，而不是在本地把字符串重新断言成一个身份。
  const workPackage: WorkPackage | undefined = graph.workPackages.find(
    (entry) => entry.workPackageId === candidate.workPackageId,
  );
  if (workPackage === undefined) {
    return blocked(
      input.coordinationScopeId,
      'invalid_state',
      `Graph Version ${String(scope.graphVersion)} 不含 Work Package ${candidate.workPackageId}`,
    );
  }
  const consumed = consumedBudgetForWorkPackage(input.store, input.coordinationScopeId, workPackage.workPackageId);
  if (consumed === null) {
    return blocked(input.coordinationScopeId, 'invalid_state', '无法读取预算计数，不能在没有消耗事实的情况下派发');
  }

  let dispatchAuthorizationFacts = authorizationFacts;
  let dispatchPermissions = authorization.manifest.permissions;
  if (dispatch.authorizationId !== authorization.authorizationId || dispatch.authorizationVersion !== authorization.authorizationVersion) {
    const bindings = input.store.query({ kind: 'materialization-bindings', coordinationScopeId: input.coordinationScopeId });
    const pinned = bindings.kind === 'materialization-bindings' ? bindings.bindings.find((binding) =>
      binding.workerTaskId === dispatch.taskEnvelope.workerTaskId && binding.role === role &&
      binding.authorizationId === dispatch.authorizationId && binding.authorizationVersion === dispatch.authorizationVersion &&
      binding.workerProfileRef?.id === dispatch.workerProfileRef) : undefined;
    const original = input.store.query({ kind: 'authorization', coordinationScopeId: input.coordinationScopeId, authorizationId: dispatch.authorizationId });
    if (pinned === undefined || original.kind !== 'authorization' || original.authorization === null ||
      original.authorization.authorizationVersion !== dispatch.authorizationVersion ||
      original.authorization.manifest.graph.graphId !== graph.graphId || original.authorization.manifest.graph.generation !== graph.generation ||
      original.authorization.manifest.orcaRunId !== authorization.manifest.orcaRunId) {
      return blocked(input.coordinationScopeId, 'model_binding_unverifiable', '原 Task 的模型授权绑定无法核验');
    }
    dispatchAuthorizationFacts = { valid: true, authorizationId: dispatch.authorizationId, authorizationVersion: dispatch.authorizationVersion, reason: null };
    dispatchPermissions = original.authorization.manifest.permissions;
  }

  const facts: Omit<
    DispatchCandidateFacts,
    'candidateWorkPackageId' | 'candidateRole' | 'scopeEnvelope' | 'budget'
  > = {
    lifecycleStage: lifecycleStageOf(candidate.state),
    selectedCandidateId: workPackage.workPackageId,
    revisionPending: revisionPendingOf(graph, snapshot, derived.frontier),
    revisionPlanner: revisionPlannerPermit,
    dependenciesSatisfied: dependenciesSatisfiedOf(graph, derived.frontier),
    controlState: scope.controlState,
    authorization: dispatchAuthorizationFacts,
    authority: dispatchPermissions,
    consumed,
    requiredBudgetField: dispatch.requiredBudgetField,
  };

  const decision = guardDispatchCandidate({
    guard: input.canonicalHead,
    candidate: {
      ...facts,
      candidateWorkPackageId: workPackage.workPackageId,
      candidateRole: role,
      scopeEnvelope: workPackage.scopeEnvelope,
      budget: workPackage.budget,
    },
  });
  if (decision.kind === 'paused') {
    return idle(`派发已暂停：${decision.reason}`, ['dispatch-paused:unattributed_drift']);
  }
  if (decision.kind === 'rejected') {
    const { rejection } = decision;
    return idle(rejection.message, [
      `rejection:${rejection.code}`,
      ...(rejection.budgetKey === null ? [] : [rejection.budgetKey]),
    ]);
  }

  const operationIds = materializeOperationIdsFor({
    coordinationScopeId: input.coordinationScopeId,
    graphId: graph.graphId,
    graphGeneration: graph.generation,
    workPackageId: workPackage.workPackageId,
    role,
    contractRevision: dispatch.taskEnvelope.specBinding?.contractRevision ?? 0,
    attemptId: dispatch.taskEnvelope.attemptId,
    unresolvedIntents: intents,
    settledRejectedIntents: intents,
  });
  if (intents.some((intent) =>
    intent.operationId === operationIds.workerStart && intent.state === 'settled' && intent.outcomeClass === 'accepted',
  )) {
    return idle('Worker 启动已被 Orca 接受，等待可核验的 Worker 或 Delivery 事实', [
      `worker-start:${workPackage.workPackageId}:awaiting-observation`,
    ]);
  }

  /**
   * 未决 lane 阻止新的派发，即使它属于本次正要推进的同一个候选。
   *
   * 判定用刚签发的五个分步骤身份反过来查：任何一个仍是未决或阻塞，就说明那次副作用的结果尚未核验，
   * 重发可能产生第二个资源（store 会把同 ID 的再次提交当成恢复重放，因此这里的闸门是唯一的拦截点）。
   * 这时只把原身份与 lane 交给调用方，留给对账；下一次推进仍会派生出同一组 ID。
   */
  const stepIds: readonly OperationId[] = ADVANCE_STEPS.map((step) => operationIds[step]);
  const obstructing = intents.find((intent) => intent.state !== 'settled' && stepIds.includes(intent.operationId));
  if (obstructing !== undefined) {
    return blocked(
      obstructing.laneKey,
      obstructing.state === 'blocked' ? 'lane_blocked' : 'lane_pending',
      `${obstructing.operationId} 的结果尚未核验（${obstructing.state}），lane 保持阻塞，重启后只按原身份对账`,
    );
  }

  const lane = snapshot.laneReservations.find(item => item.graphId === graph.graphId &&
    item.generation === graph.generation && item.workPackageId === workPackage.workPackageId && item.releasedAt === null);
  const baselineHead = lane?.baselineHead ?? input.canonicalHead.canonicalHead;
  const afterRegistration = readScope(input.store, input.coordinationScopeId);
  if (afterRegistration.kind === 'rejected') {
    return blocked(input.coordinationScopeId, afterRegistration.code, afterRegistration.message);
  }

  const canonicalWorktree = authorization.manifest.workspacePolicy.canonicalWorktree;
  const materialized = await materializeWorkPackage({
    store: input.store,
    backend: input.backend,
    coordinationScopeId: input.coordinationScopeId,
    workPackageId: workPackage.workPackageId,
    context: {
      candidate: {
        coordinationScopeId: input.coordinationScopeId,
        writer: input.writer,
        role,
        graphGeneration: graph.generation,
        authorizationId: dispatch.authorizationId,
        authorizationVersion: dispatch.authorizationVersion,
        workerProfileRef: dispatch.workerProfileRef,
        runId: authorization.manifest.orcaRunId,
        consumerGeneration: dispatch.consumerGeneration,
        backendIdentityRef: dispatch.backendIdentityRef,
        taskEnvelope: dispatch.taskEnvelope,
        ...(dispatch.taskDependencies === undefined ? {} : { taskDependencies: dispatch.taskDependencies }),
        ...(dispatch.taskTitle === undefined ? {} : { taskTitle: dispatch.taskTitle }),
        ...(dispatch.displayName === undefined ? {} : { displayName: dispatch.displayName }),
        workerLaunch: dispatch.workerLaunch,
        launchId: dispatch.launchId,
        timeoutMs: dispatch.timeoutMs,
      },
      paths: {
        repoSelector: `path:${canonicalWorktree}`,
        canonicalWorktree,
        baselineHead,
      },
      operationIds,
      workPackage: { scopeEnvelope: workPackage.scopeEnvelope, budget: workPackage.budget },
    },
    facts,
    // 物化用例自己会再读一次 revision；这里给的是同一同步块里读到的值（本用例在此之前没有任何写入）。
    expectedRevision: afterRegistration.scope.revision,
  });

  return advanceResultOf(materialized, workPackage.workPackageId, role);
}
