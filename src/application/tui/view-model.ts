/**
 * IC-12：Presentation projection（Owner: `m0-orca-control-baseline`；
 * planning 分区由 `m2-deliver-planning-tui` 在 Extend 维度实现）。
 *
 * 这里只有纯函数与展示 DTO：输入是 IC-11 的 `ControllerSnapshot` 与已加载的 transcript 页，
 * 输出是界面可以直接渲染的视图模型。它不读 store、不订阅事件、不提交命令，也不保存任何状态——
 * 选中 Session、滚动位置、草稿与 Sidebar 密度都在 `src/interfaces/tui/state.ts` 的进程内展示态里。
 *
 * CLI 的 `status --json` 复用同一组字段投影规则（`projectScopeView`、`projectSessionSummaryView`、
 * `projectGraphPointerView`），但保持自己独立的版本化 machine DTO 形状。
 */

import type { ControlState, CoordinationMode } from '../../domain/coordination/mode.js';
import type { WorkerRole } from '../../domain/planning/execution-authorization.js';
import type { WorkerLiveness } from '../../domain/worker-liveness.js';
import {
  controlHazards,
  isActiveWorkPackageState,
  type ControlHazardsView,
  type ExecutionReconciliationGateView,
  type FinalizerView,
  type IntegrationView,
  type ReconciliationSeverity,
  type ValidationView,
  type WorkPackageExecutionState,
} from '../execution/execution-view.js';
import type {
  ControllerBlockerEntry,
  ControllerBudgetView,
  ControllerCompactionView,
  ControllerFrontierEntry,
  ControllerGraphReadinessView,
  ControllerHandoffView,
  ControllerInteractionView,
  ControllerMaintenanceView,
  ControllerPlanningHandoffView,
  ControllerRecoveryView,
  ControllerSessionSummary,
  ControllerSnapshot,
  ControllerTranscriptPage,
  ControllerWorkerEntry,
} from '../controller-service.js';

/* -------------------------------------------------------------------------- */
/* 展示 DTO                                                                    */
/* -------------------------------------------------------------------------- */

export type AuthorizationView = {
  readonly authorizationId: string;
  readonly version: number;
};

export type ScopeView = {
  readonly coordinationScopeId: string;
  readonly revision: number;
  readonly mode: CoordinationMode;
  readonly controlState: ControlState;
  readonly planningCycleId: string | null;
  readonly mapRevision: number;
  readonly authorization: AuthorizationView | null;
  readonly executionLeaseHolderSessionId: string | null;
};

export type SessionSummaryView = {
  readonly coordinatorSessionId: string;
  readonly coordinatorModelConfigurationRef: string;
  readonly lifecycleState: string;
  readonly holdsRuntimeLease: boolean;
  readonly holdsExecutionLease: boolean;
  readonly planningResponsible: boolean;
  readonly openInteractionCount: number;
  /** 展示态：该 Session 是否有未读或待处理标记。 */
  readonly unread: boolean;
  /** 展示态：是否为当前选中的 Session。 */
  readonly selected: boolean;
};

export type BudgetView = ControllerBudgetView;

/**
 * 执行图上单个 Work Package 节点。
 *
 * 节点位置由**编译后的稳定拓扑**给出（`position`），状态变化只更新标识，绝不重排；`hidden` 只由过滤
 * 决定，被隐藏的节点仍保留原位置，因此「过滤只隐藏节点」是结构性的。
 *
 * 生命周期阶段（`state`）与 Worker liveness（`liveness`）是两个字段：不可核验的 Worker 不得被读成
 * 已退出，因此不能把它们合并成一个取值。
 */
export type WorkPackageNodeView = {
  readonly workPackageId: string;
  readonly title: string;
  readonly dependsOn: readonly string[];
  readonly scopeEnvelope: { readonly include: readonly string[]; readonly exclude: readonly string[] };
  /** 稳定拓扑位置：编译顺序的索引，与状态无关。 */
  readonly position: number;
  /** 是否被当前过滤条件隐藏；隐藏不改变 `position`。 */
  readonly hidden: boolean;
  /** 紧凑态使用的短 key。 */
  readonly shortKey: string;
  readonly state: WorkPackageExecutionState;
  /** 是否持有当前 Execution Frontier 位置（并发上限 1，因此最多一个节点为 `true`）。 */
  readonly active: boolean;
  readonly role: WorkerRole | null;
  readonly attemptId: string | null;
  readonly liveness: WorkerLiveness | null;
  readonly worktreePath: string | null;
  readonly baselineHead: string | null;
  readonly validation: ValidationView | null;
  readonly integration: IntegrationView | null;
  readonly revisionHold: { readonly source: string } | null;
  readonly reconciliation: {
    readonly severity: ReconciliationSeverity;
    readonly requiredBaselineHead: string;
    readonly observedHead: string | null;
    readonly blockerRef: string | null;
  } | null;
  readonly blockerRefs: readonly string[];
  /** 推出该状态所依据的持久事实引用；用于把「未知」与「推断」区分开。 */
  readonly derivedFrom: readonly string[];
};

/** 兼容既有调用点的别名：图节点现在就是执行投影。 */
export type GraphNodeView = WorkPackageNodeView;

/** 串行 integration queue 的一项；`position` 是队列顺序（拓扑顺序），不是图位置。 */
export type IntegrationQueueEntryView = {
  readonly workPackageId: string;
  readonly position: number;
  /** 当前正在集成的那一项；任一时刻最多一个。 */
  readonly integrating: boolean;
};

/** 执行阶段整体投影：active 计数、串行 integration queue、Finalizer 与对账门。 */
export type ExecutionProjectionView = {
  readonly activeWorkPackageId: string | null;
  /** 并发上限固定为 1，因此取值只可能是 0 或 1。 */
  readonly activeWorkPackageCount: number;
  readonly integrationQueue: readonly IntegrationQueueEntryView[];
  readonly finalizer: FinalizerView;
  readonly reconciliation: ExecutionReconciliationGateView;
  readonly hazards: ControlHazardsView;
  readonly recoveries: readonly ControllerRecoveryView[];
  /** Execution Handoff 记录（与 Route Planning Handoff 分开）。 */
  readonly handoffs: readonly ControllerHandoffView[];
};

export type GraphReadinessView = ControllerGraphReadinessView;

export type GraphView = {
  readonly graphId: string;
  readonly graphVersion: number;
  readonly generation: number | null;
  readonly nodes: readonly GraphNodeView[];
  readonly readiness: GraphReadinessView;
  readonly frontier: readonly ControllerFrontierEntry[];
};

export type WorkerView = ControllerWorkerEntry;

export type BlockerView = ControllerBlockerEntry;

export type InteractionView = ControllerInteractionView;

export type MaintenanceView = ControllerMaintenanceView;

export type CompactionView = ControllerCompactionView;

/**
 * transcript 条目。
 *
 * 只有用户消息、Agent 回复与工具调用记录三种；system 消息与诊断噪声不进入时间线，因此投影函数
 * 直接过滤它们，界面没有「是否显示 system」的开关。
 */
export type TranscriptEntry =
  | { readonly kind: 'user'; readonly id: string; readonly text: string }
  | { readonly kind: 'agent'; readonly id: string; readonly text: string }
  | { readonly kind: 'tool'; readonly id: string; readonly name: string; readonly detail: string };

export type TranscriptView = {
  readonly coordinatorSessionId: string | null;
  readonly entries: readonly TranscriptEntry[];
  readonly nextCursor: string | null;
  /** 滚动位置（进程内展示态）。 */
  readonly scrollOffset: number;
  /** Source transcript 在 Handoff cutover 后转为只读。 */
  readonly readOnly: boolean;
};

export type TuiViewModel = {
  readonly scope: ScopeView;
  readonly sessions: readonly SessionSummaryView[];
  readonly selectedSessionId: string | null;
  readonly transcript: TranscriptView;
  readonly budgets: readonly BudgetView[];
  readonly graph: GraphView | null;
  readonly execution: ExecutionProjectionView;
  readonly workers: readonly WorkerView[];
  readonly blockers: readonly BlockerView[];
  readonly interactions: readonly InteractionView[];
  readonly maintenance: MaintenanceView | null;
  readonly compaction: CompactionView | null;
  readonly planningHandoffs: readonly ControllerPlanningHandoffView[];
};

/** 节点过滤条件：空集合表示不过滤；过滤只隐藏节点，不改变顺序或位置。 */
export type ExecutionFilter = readonly WorkPackageExecutionState[];

/* -------------------------------------------------------------------------- */
/* 纯投影                                                                      */
/* -------------------------------------------------------------------------- */

export function projectScopeView(snapshot: ControllerSnapshot): ScopeView {
  return {
    coordinationScopeId: snapshot.coordinationScopeId,
    revision: snapshot.revision,
    mode: snapshot.mode,
    controlState: snapshot.controlState,
    planningCycleId: snapshot.planningCycleId,
    mapRevision: snapshot.mapRevision,
    authorization: snapshot.authorization,
    executionLeaseHolderSessionId: snapshot.executionLeaseHolderSessionId,
  };
}

export function projectSessionSummaryView(
  session: ControllerSessionSummary,
  state: { readonly selectedSessionId: string | null; readonly unreadSessionIds: readonly string[] },
): SessionSummaryView {
  return {
    coordinatorSessionId: session.coordinatorSessionId,
    coordinatorModelConfigurationRef: session.coordinatorModelConfigurationRef,
    lifecycleState: session.lifecycleState,
    holdsRuntimeLease: session.holdsRuntimeLease,
    holdsExecutionLease: session.holdsExecutionLease,
    planningResponsible: session.planningResponsible,
    openInteractionCount: session.openInteractionCount,
    unread: state.unreadSessionIds.includes(session.coordinatorSessionId),
    selected: state.selectedSessionId === session.coordinatorSessionId,
  };
}

export function projectBudgetView(budget: ControllerBudgetView): BudgetView {
  return { budgetKey: budget.budgetKey, approvedLimitRef: budget.approvedLimitRef, consumed: budget.consumed };
}

export function projectInteractionView(interaction: ControllerInteractionView): InteractionView {
  return { ...interaction };
}

export type GraphPointerView = { readonly id: string; readonly version: number };

/** CLI 的 machine DTO 只需要图指针；这里复用同一份判空与命名字段。 */
export function projectGraphPointerView(snapshot: ControllerSnapshot): GraphPointerView | null {
  if (snapshot.graph === null) {
    return null;
  }
  return { id: snapshot.graph.graphId, version: snapshot.graph.graphVersion };
}

/**
 * Work Package 节点的短 key。
 *
 * 只做展示压缩：相同前缀的 Work Package 必须仍能区分，因此保留尾部（编号或哈希后缀都在尾部）。
 */
export function workPackageShortKey(workPackageId: string): string {
  const trimmed = workPackageId.replace(/^work-package[:-]/u, '');
  return trimmed.length <= 8 ? trimmed : `…${trimmed.slice(-7)}`;
}

/** 该节点的过滤可见性；`filter` 为空表示不过滤。 */
export function nodeVisible(state: WorkPackageExecutionState, filter: ExecutionFilter): boolean {
  return filter.length === 0 || filter.includes(state);
}

/**
 * 当前 Scope 指向的图的拓扑投影。
 *
 * 节点位置直接用**编译顺序的索引**：状态变化不改变 `position`，`hidden` 只表达过滤结果。调用方没有
 * 提供该 GraphVersion 记录（例如记录不可读）时返回 `null`，界面显示 blocker，而不是展示一张看起来
 * 完整但内容为空的白图。
 */
export function projectGraphView(
  snapshot: ControllerSnapshot,
  filter: ExecutionFilter = [],
): GraphView | null {
  if (snapshot.graph === null) {
    return null;
  }
  const topology = snapshot.graphTopologies.find(
    (entry) =>
      entry.graphId === snapshot.graph?.graphId && entry.graphVersion === snapshot.graph.graphVersion,
  );
  if (topology === undefined) {
    return null;
  }
  const execution = new Map(
    snapshot.frontier.map((entry) => [entry.workPackageId, entry] as const),
  );
  const holds = new Map(
    snapshot.graphEvolution.revisionHolds
      .filter((hold) => hold.state === 'pending')
      .map((hold) => [hold.workPackageId, hold] as const),
  );
  const reconciliations = new Map(
    snapshot.graphEvolution.reconciliations.map(
      (reconciliation) => [reconciliation.workPackageId, reconciliation] as const,
    ),
  );

  return {
    graphId: topology.graphId,
    graphVersion: topology.graphVersion,
    generation: snapshot.graph.generation,
    nodes: topology.nodes.map<WorkPackageNodeView>((node, position) => {
      const entry = execution.get(node.workPackageId) ?? null;
      const reconciliation = reconciliations.get(node.workPackageId) ?? null;
      const hold = holds.get(node.workPackageId) ?? null;
      const state: WorkPackageExecutionState = entry?.state ?? 'unknown';
      return {
        ...node,
        position,
        hidden: !nodeVisible(state, filter),
        shortKey: workPackageShortKey(node.workPackageId),
        state,
        active: entry !== null && isActiveWorkPackageState(entry.state),
        role: entry?.role ?? null,
        attemptId: entry?.attemptId ?? null,
        liveness: entry?.liveness ?? null,
        worktreePath: entry?.worktreePath ?? null,
        baselineHead: entry?.baselineHead ?? null,
        validation: entry?.validation ?? null,
        integration: entry?.integration ?? null,
        revisionHold: hold === null ? null : { source: hold.source },
        reconciliation:
          reconciliation === null
            ? null
            : {
                severity: reconciliation.severity,
                requiredBaselineHead: reconciliation.requiredBaselineHead,
                observedHead: reconciliation.observedHead,
                blockerRef: reconciliation.blockerRef,
              },
        blockerRefs: entry?.blockerRefs ?? [],
        derivedFrom: entry?.derivedFrom ?? [],
      };
    }),
    readiness: topology.readiness,
    frontier: snapshot.frontier,
  };
}

/**
 * active Work Package 与串行 integration queue。
 *
 * 并发上限固定为 1：即使上游给出了多个 active 节点，计数也只取 0 或 1（`activeWorkPackageId` 取拓扑顺序
 * 最早的一个）；多余的 active 仍会以各自状态出现在图里，因此契约违规是可见的，而不是被悄悄抹平。
 */
export function projectExecutionProjection(
  snapshot: ControllerSnapshot,
  graph: GraphView | null,
): ExecutionProjectionView {
  const nodes = graph?.nodes ?? [];
  const activeWorkPackageId = nodes.find((node) => node.active)?.workPackageId ?? null;
  const integrationQueue = nodes
    .filter(
      (node) =>
        node.state === 'waiting_integration' ||
        (node.integration !== null && node.integration.state === 'integrating'),
    )
    .map<IntegrationQueueEntryView>((node, position) => ({
      workPackageId: node.workPackageId,
      position,
      integrating: node.integration !== null && node.integration.state === 'integrating',
    }));

  return {
    activeWorkPackageId,
    activeWorkPackageCount: activeWorkPackageId === null ? 0 : 1,
    integrationQueue,
    finalizer: snapshot.finalizer,
    reconciliation: snapshot.executionReconciliation,
    hazards: controlHazards({
      frontier: snapshot.frontier,
      openInteractionCount: snapshot.interactions.filter(
        (interaction) => interaction.state === 'open',
      ).length,
      unresolvedIntentCount: snapshot.executionReconciliation.unresolvedIntentCount,
    }),
    recoveries: snapshot.recoveries.map((recovery) => ({ ...recovery })),
    handoffs: snapshot.handoffs.map((handoff) => ({ ...handoff })),
  };
}

export function projectWorkerView(worker: ControllerWorkerEntry): WorkerView {
  return { ...worker };
}

/** Execution Frontier 的原始条目；供需要状态与派生依据的调用方（CLI machine DTO）复用。 */
export function projectFrontierEntry(entry: ControllerFrontierEntry): ControllerFrontierEntry {
  return { ...entry, derivedFrom: [...entry.derivedFrom], blockerRefs: [...entry.blockerRefs] };
}

export function projectPlanningHandoffView(
  handoff: ControllerPlanningHandoffView,
): ControllerPlanningHandoffView {
  return { ...handoff };
}

/** 当前持有规划责任的 Session；即一次 Route Planning Handoff 要转移的责任来源。 */
export function planningResponsibleSessionId(viewModel: TuiViewModel): string | null {
  return viewModel.sessions.find((session) => session.planningResponsible)?.coordinatorSessionId ?? null;
}

/** 上游把 Agent 回复与工具调用都记成普通消息；这里按角色分区，system 与未知角色不进入时间线。 */
export function projectTranscriptEntry(
  message: { readonly role: string; readonly content: string; readonly stepId: string | null },
  index: number,
): TranscriptEntry | null {
  const role = message.role.toLowerCase();
  if (role === 'system') {
    return null;
  }
  const id = message.stepId ?? `${role}-${String(index)}`;
  if (role === 'human' || role === 'user') {
    return { kind: 'user', id, text: message.content };
  }
  if (role === 'tool' || role === 'function' || role === 'tool_result') {
    const separator = message.content.indexOf('\n');
    const name = separator === -1 ? message.content : message.content.slice(0, separator);
    return { kind: 'tool', id, name: name.length === 0 ? role : name, detail: message.content };
  }
  return { kind: 'agent', id, text: message.content };
}

export function projectTranscriptPage(
  page: ControllerTranscriptPage | null,
  state: {
    readonly coordinatorSessionId: string | null;
    readonly scrollOffset?: number;
    readonly readOnly?: boolean;
  },
): TranscriptView {
  const messages = page?.messages ?? [];
  const entries: TranscriptEntry[] = [];
  messages.forEach((message, index) => {
    const entry = projectTranscriptEntry(message, index);
    if (entry !== null) {
      entries.push(entry);
    }
  });
  return {
    coordinatorSessionId: page?.coordinatorSessionId ?? state.coordinatorSessionId,
    entries,
    nextCursor: page?.nextCursor ?? null,
    scrollOffset: state.scrollOffset ?? 0,
    readOnly: state.readOnly ?? false,
  };
}

export type TuiViewModelInput = {
  readonly snapshot: ControllerSnapshot;
  readonly transcript: TranscriptView;
  readonly selectedSessionId: string | null;
  readonly unreadSessionIds: readonly string[];
  /** 执行图过滤条件（进程内展示态）；只隐藏节点。 */
  readonly executionFilter?: ExecutionFilter;
};

export function projectTuiViewModel(input: TuiViewModelInput): TuiViewModel {
  const { snapshot } = input;
  const graph = projectGraphView(snapshot, input.executionFilter ?? []);
  return {
    scope: projectScopeView(snapshot),
    sessions: snapshot.sessions.map((session) =>
      projectSessionSummaryView(session, {
        selectedSessionId: input.selectedSessionId,
        unreadSessionIds: input.unreadSessionIds,
      }),
    ),
    selectedSessionId: input.selectedSessionId,
    transcript: input.transcript,
    budgets: snapshot.budgets.map(projectBudgetView),
    graph,
    execution: projectExecutionProjection(snapshot, graph),
    workers: snapshot.workers.map(projectWorkerView),
    blockers: snapshot.blockers.map((blocker) => ({ ...blocker })),
    interactions: snapshot.interactions.map(projectInteractionView),
    maintenance: snapshot.maintenance === null ? null : { ...snapshot.maintenance },
    compaction: snapshot.compaction === null ? null : { ...snapshot.compaction },
    planningHandoffs: snapshot.planningHandoffs.map(projectPlanningHandoffView),
  };
}
