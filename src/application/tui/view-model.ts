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
import type {
  ControllerBlockerEntry,
  ControllerBudgetView,
  ControllerCompactionView,
  ControllerFrontierEntry,
  ControllerGraphReadinessView,
  ControllerInteractionView,
  ControllerMaintenanceView,
  ControllerPlanningHandoffView,
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

export type GraphNodeView = {
  readonly workPackageId: string;
  readonly title: string;
  readonly dependsOn: readonly string[];
  readonly scopeEnvelope: { readonly include: readonly string[]; readonly exclude: readonly string[] };
  /** 该节点在 Execution Frontier 上的状态；不在 frontier 时为 `null`。 */
  readonly frontierStatus: string | null;
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
  readonly workers: readonly WorkerView[];
  readonly blockers: readonly BlockerView[];
  readonly interactions: readonly InteractionView[];
  readonly maintenance: MaintenanceView | null;
  readonly compaction: CompactionView | null;
  readonly planningHandoffs: readonly ControllerPlanningHandoffView[];
};

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
 * 当前 Scope 指向的图的拓扑投影。
 *
 * 调用方没有提供该 GraphVersion 记录（例如记录不可读）时返回 `null`，界面显示 blocker，而不是
 * 展示一张看起来完整但内容为空的白图。
 */
export function projectGraphView(snapshot: ControllerSnapshot): GraphView | null {
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
  const frontierStatus = new Map(snapshot.frontier.map((entry) => [entry.workPackageId, entry.status]));
  return {
    graphId: topology.graphId,
    graphVersion: topology.graphVersion,
    generation: snapshot.graph.generation,
    nodes: topology.nodes.map<GraphNodeView>((node) => ({
      ...node,
      frontierStatus: frontierStatus.get(node.workPackageId) ?? null,
    })),
    readiness: topology.readiness,
    frontier: snapshot.frontier,
  };
}

export function projectWorkerView(worker: ControllerWorkerEntry): WorkerView {
  return { ...worker };
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
};

export function projectTuiViewModel(input: TuiViewModelInput): TuiViewModel {
  const { snapshot } = input;
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
    graph: projectGraphView(snapshot),
    workers: snapshot.workers.map(projectWorkerView),
    blockers: snapshot.blockers.map((blocker) => ({ ...blocker })),
    interactions: snapshot.interactions.map(projectInteractionView),
    maintenance: snapshot.maintenance === null ? null : { ...snapshot.maintenance },
    compaction: snapshot.compaction === null ? null : { ...snapshot.compaction },
    planningHandoffs: snapshot.planningHandoffs.map(projectPlanningHandoffView),
  };
}
