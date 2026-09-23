/**
 * IC-11 / IP-9c：ControllerService —— 界面层的唯一应用 façade
 * （Owner: `m1-recover-execution`，D11）。
 *
 * CLI 与 TUI 只通过这里读快照、提交意图、订阅语义事件。它**只委派**：不打开 SQLite、不调用 Orca
 * adapter、不拥有状态转换，也不复制任何既有用例的规则。Scope 初始化仍然走既有的
 * `initializeCoordinationScope`，本模块不重写创建规则。
 *
 * 三条硬边界：
 * - Pending Interaction 回答同时绑定 interaction ID 与 expected revision，且普通 Session 消息不经过
 *   回答用例，因此聊天不可能满足一个待答问题；
 * - `SemanticEvent` 是 UI 可投影的封闭联合：keepalive、stderr、poll timeout、无变化对账与诊断日志
 *   一律不发布；订阅取消只移除 listener；
 * - 快照只携带已验证的领域/控制投影与外部事实引用，不含 receipt、Accepted Worker Result 正文、
 *   provider 对象、credential 或任意 adapter handle。
 *
 * 普通挂起与唤醒继续由 `coordinator/actionable-work.ts`、`suspension.ts` 与 `wake-admission.ts`
 * 原样拥有；本模块既不包装它们，也不新增调用层。
 */

import type { ControlState, CoordinationMode } from '../domain/coordination/mode.js';
import type { WorkerRole } from '../domain/planning/execution-authorization.js';
import type { WorkerLiveness } from '../domain/worker-liveness.js';
import type { ScopeControlAction } from '../domain/coordination/scope-control.js';
import type {
  CandidateGenerationRefs,
  GraphGenerationStatus,
  ReplanningClosureMode,
  SettlementFacts,
} from '../domain/execution/replanning.js';
import type { GraphVersionRecord } from '../domain/planning/execution-graph.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  EntityRef,
  InteractionId,
  Revision,
} from './dto/identity.js';
import type {
  BaselineAdoptionKind,
  BaselineAdoptionState,
  BaselineReconciliationState,
  BudgetCounterRecord,
  CoordinationSnapshot,
  CoordinationWriter,
  ExecutionHandoffPhase,
  ExecutionHandoffRecord,
  GraphGenerationRecord,
  HandoffResponsibility,
  InheritedBudgetEntry,
  PendingInteractionRecord,
  PendingInteractionState,
  PlanningHandoffPhase,
  PlanningHandoffRecord,
  RecoveryRecord,
  RecoveryState,
  RevisionHoldRecord,
  RevisionHoldSource,
  RevisionHoldState,
  SessionLifecycleState,
  WorkPackageLineageRecord,
  BaselineAdoptionRecord,
  BaselineReconciliationRecord,
} from './ports/branch-coordination-store.js';
import type { ExecutionHandoffReviewFacts } from './handoff/execution-handoff.js';
import type { HandoffReviewFacts } from './planning/planning-handoff.js';

/* -------------------------------------------------------------------------- */
/* 查询：只读快照与 transcript                                                 */
/* -------------------------------------------------------------------------- */

export type ControllerGraphView = {
  readonly graphId: string;
  readonly graphVersion: number;
  /** 当前图的 Graph Generation；调用方从 GraphVersion 历史读好后传入。 */
  readonly generation: number | null;
};

export type ControllerSessionSummary = {
  readonly coordinatorSessionId: string;
  readonly coordinatorModelConfigurationRef: string;
  readonly lifecycleState: SessionLifecycleState;
  readonly holdsRuntimeLease: boolean;
  readonly holdsExecutionLease: boolean;
  readonly planningResponsible: boolean;
  readonly openInteractionCount: number;
};

export type ControllerBudgetView = {
  readonly budgetKey: string;
  readonly approvedLimitRef: string;
  readonly consumed: number;
};

export type ControllerFrontierEntry = {
  readonly workPackageId: string;
  readonly status: string;
};

export type ControllerWorkerEntry = {
  readonly dispatchId: string;
  readonly workerTaskId: string;
  readonly workPackageId: string;
  readonly role: WorkerRole;
  readonly liveness: WorkerLiveness;
};

export const CONTROLLER_BLOCKER_SOURCES = [
  'mutation_lane',
  'handoff',
  'recovery',
  'revision_pending',
  'baseline_reconciliation',
  'injected',
] as const;

export type ControllerBlockerSource = (typeof CONTROLLER_BLOCKER_SOURCES)[number];

export type ControllerBlockerEntry = {
  readonly source: ControllerBlockerSource;
  readonly code: string;
  readonly message: string;
};

export type ControllerInteractionView = {
  readonly interactionId: string;
  readonly ownerCoordinatorSessionId: string;
  readonly subjectRef: EntityRef<string>;
  readonly expectedRevision: Revision;
  readonly state: PendingInteractionState;
};

export type ControllerHandoffView = {
  readonly handoffId: string;
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly graphGeneration: number;
  readonly phase: ExecutionHandoffPhase;
  readonly expectedRevision: Revision;
  readonly responsibilitySet: readonly HandoffResponsibility[];
};

export type ControllerRecoveryView = {
  readonly recoveryId: string;
  readonly workerTaskId: string;
  readonly role: WorkerRole;
  readonly status: RecoveryState;
  readonly consumedBudget: number;
};

export type ControllerMaintenanceView = {
  readonly stopped: boolean;
  readonly cyclesRun: number;
  readonly stopReason: string | null;
};

/* -------------------------------------------------------------------------- */
/* planning TUI 只读投影（IC-11 Extend，Owner: `m2-deliver-planning-tui`）      */
/* -------------------------------------------------------------------------- */

/**
 * 候选图的一个 Work Package 节点。
 *
 * Inspector 只读展示节点、依赖与 Scope Envelope；这里不投影预算，避免把执行策略带进规划界面。
 */
export type ControllerGraphNodeView = {
  readonly workPackageId: string;
  readonly title: string;
  readonly dependsOn: readonly string[];
  readonly scopeEnvelope: { readonly include: readonly string[]; readonly exclude: readonly string[] };
};

/** admission/authorization readiness：代际状态与「授权是否恰好绑定这张图」。 */
export type ControllerGraphReadinessView = {
  readonly generationStatus: GraphGenerationStatus | null;
  readonly authorizationBound: boolean;
};

export type ControllerGraphTopologyView = {
  readonly graphId: string;
  readonly graphVersion: number;
  readonly generation: number;
  readonly nodes: readonly ControllerGraphNodeView[];
  readonly readiness: ControllerGraphReadinessView;
};

/**
 * 压缩结论的展示投影。
 *
 * 它是 Runtime 观察到的 `CompactionOutcome` 的扁平化视图，不是新的权威：本模块既不执行压缩，也不
 * 持久化它；从未观察到时为 `null`，界面据此显示 blocker 而不是假设「未降级」。
 */
export type ControllerCompactionView = {
  readonly status: 'not_needed' | 'compacted' | 'compaction_degraded' | 'context_exhausted';
  readonly path: string | null;
  readonly reason: string | null;
  readonly stillOverBudget: number | null;
};

/**
 * Route Planning Handoff 提案的展示投影。
 *
 * 提案的准入、CAS 与激活门都由应用用例拥有；界面只展示它、提交确认或取消。
 */
export type ControllerPlanningHandoffView = {
  readonly proposalId: string;
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly phase: PlanningHandoffPhase;
  readonly mapRevision: number;
  readonly planRevision: number;
  /** 可移植 Coordinator Context Capsule 的引用；`null` 表示尚未生成，界面据此显示 blocker。 */
  readonly capsuleRef: string | null;
  readonly proposalRevision: number;
};

/* -------------------------------------------------------------------------- */
/* 图演进投影                                                                  */
/* -------------------------------------------------------------------------- */

export type ControllerGraphGenerationView = {
  readonly graphId: string;
  readonly generation: number;
  readonly status: GraphGenerationStatus;
  readonly planningCycleId: string;
  readonly orcaRunId: string;
  readonly predecessorGraphId: string | null;
  readonly baselineHead: string;
};

export type ControllerRevisionHoldView = {
  readonly workPackageId: string;
  readonly source: RevisionHoldSource;
  readonly state: RevisionHoldState;
};

export type ControllerReconciliationView = {
  readonly reconciliationId: string;
  readonly workPackageId: string;
  readonly state: BaselineReconciliationState;
};

export type ControllerLineageView = {
  readonly workPackageId: string;
  readonly priorWorkPackageId: string;
  readonly inherited: readonly InheritedBudgetEntry[];
};

export type ControllerAdoptionView = {
  readonly adoptionId: string;
  readonly workPackageId: string;
  readonly kind: BaselineAdoptionKind;
  readonly state: BaselineAdoptionState;
};

/**
 * 图演进的只读投影。
 *
 * 界面据此展示当前代际、revision pending、基线补救与 lineage，而不需要（也不允许）直接读 store。
 */
export type ControllerGraphEvolutionView = {
  readonly generations: readonly ControllerGraphGenerationView[];
  readonly revisionHolds: readonly ControllerRevisionHoldView[];
  readonly reconciliations: readonly ControllerReconciliationView[];
  readonly lineages: readonly ControllerLineageView[];
  readonly adoptions: readonly ControllerAdoptionView[];
};

/**
 * 只读快照。
 *
 * 字段都是已验证的领域/控制投影或外部事实引用；这里没有 receipt、结果正文、provider 对象、
 * credential 与 adapter handle，投影函数只从白名单字段构造，未来也不会因为上游记录变宽而泄漏。
 */
export type ControllerSnapshot = {
  readonly coordinationScopeId: string;
  readonly revision: Revision;
  readonly mode: CoordinationMode;
  readonly controlState: ControlState;
  readonly planningCycleId: string | null;
  readonly mapRevision: Revision;
  readonly graph: ControllerGraphView | null;
  readonly authorization: { readonly authorizationId: string; readonly version: Revision } | null;
  readonly executionLeaseHolderSessionId: string | null;
  readonly selectedSessionId: string | null;
  readonly sessions: readonly ControllerSessionSummary[];
  readonly budgets: readonly ControllerBudgetView[];
  readonly frontier: readonly ControllerFrontierEntry[];
  readonly workers: readonly ControllerWorkerEntry[];
  readonly blockers: readonly ControllerBlockerEntry[];
  readonly interactions: readonly ControllerInteractionView[];
  readonly handoffs: readonly ControllerHandoffView[];
  readonly recoveries: readonly ControllerRecoveryView[];
  readonly graphEvolution: ControllerGraphEvolutionView;
  readonly maintenance: ControllerMaintenanceView | null;
  /** 调用方读到的 GraphVersion 记录投影；未提供记录时为空数组。 */
  readonly graphTopologies: readonly ControllerGraphTopologyView[];
  /** Runtime 最近一次观察到并交给调用方的压缩结论；从未观察到时为 `null`。 */
  readonly compaction: ControllerCompactionView | null;
  /** Route Planning Handoff 提案；界面据此展示 Review 与 cutover 入口。 */
  readonly planningHandoffs: readonly ControllerPlanningHandoffView[];
};

export type ControllerTranscriptMessage = {
  readonly role: string;
  readonly content: string;
  readonly stepId: string | null;
};

export type ControllerTranscriptPage = {
  readonly coordinatorSessionId: string;
  readonly messages: readonly ControllerTranscriptMessage[];
  readonly nextCursor: string | null;
};

export type ControllerQuery =
  | {
      readonly kind: 'snapshot';
      readonly coordinationScopeId: CoordinationScopeId;
      readonly selectedSessionId?: CoordinatorSessionId;
    }
  | {
      readonly kind: 'session-transcript';
      readonly coordinatorSessionId: CoordinatorSessionId;
      readonly cursor?: string;
    };

export type ControllerQueryResult =
  | { readonly kind: 'snapshot'; readonly snapshot: ControllerSnapshot }
  | { readonly kind: 'session-transcript'; readonly transcript: ControllerTranscriptPage }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

/* -------------------------------------------------------------------------- */
/* 命令                                                                        */
/* -------------------------------------------------------------------------- */

export type ControllerScopeFields = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly writer: CoordinationWriter;
};

export type SendSessionMessageCommand = ControllerScopeFields & {
  readonly kind: 'send-session-message';
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly content: string;
};

export type CompactSessionCommand = ControllerScopeFields & {
  readonly kind: 'compact-session';
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly reason: string;
};

export type SwitchModelConfigurationCommand = ControllerScopeFields & {
  readonly kind: 'switch-model-configuration';
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly nextConfigurationRef: string;
};

export type PlanningHandoffCommand = ControllerScopeFields &
  (
    | {
        readonly kind: 'planning-handoff';
        readonly action: 'prepare';
        readonly proposalId: string;
        readonly targetCoordinatorSessionId: CoordinatorSessionId;
        readonly mapRevision: Revision;
        readonly planRevision: Revision;
        readonly graphId: string | null;
        readonly graphVersion: number | null;
        readonly capsuleRef: string | null;
      }
    | {
        readonly kind: 'planning-handoff';
        readonly action: 'review';
        readonly proposalId: string;
        readonly facts: HandoffReviewFacts;
      }
    | {
        readonly kind: 'planning-handoff';
        readonly action: 'cutover';
        readonly proposalId: string;
        readonly facts: Omit<HandoffReviewFacts, 'openDecisionTickets'>;
      }
    | {
        readonly kind: 'planning-handoff';
        readonly action: 'cancel';
        readonly proposalId: string;
      }
  );

export type ScopeControlCommand = ControllerScopeFields & {
  readonly kind: 'scope-control';
  readonly action: ScopeControlAction;
};

/**
 * Pending Interaction 回答。
 *
 * `interactionId` 与 `expectedRevision` 都是必填：revision 过期即拒绝且零副作用。普通 Session 消息
 * 没有这两个字段，因此结构上不可能被当成回答。
 */
export type AnswerPendingInteractionCommand = ControllerScopeFields & {
  readonly kind: 'answer-pending-interaction';
  readonly interactionId: InteractionId;
  readonly expectedRevision: Revision;
  readonly answerRef: EntityRef<string>;
};

export type ExecutionHandoffCommand = ControllerScopeFields &
  (
    | {
        readonly kind: 'execution-handoff';
        readonly action: 'prepare';
        readonly handoffId: string;
        readonly targetSessionId: CoordinatorSessionId;
        readonly graphGeneration: number;
        readonly capsuleRef: string | null;
      }
    | {
        readonly kind: 'execution-handoff';
        readonly action: 'review';
        readonly handoffId: string;
        readonly facts: ExecutionHandoffReviewFacts;
      }
    | {
        readonly kind: 'execution-handoff';
        readonly action: 'cutover' | 'cancel';
        readonly handoffId: string;
      }
  );

export type InitializeScopeCommand = {
  readonly kind: 'initialize-scope';
  readonly coordinationScopeId: CoordinationScopeId;
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly coordinatorModelConfigurationRef: string;
  readonly planningCycleId: string;
  readonly writer: CoordinationWriter;
};

/**
 * 图演进意图。
 *
 * 界面只提交「开始/收尾/取消重规划」与「确认 Cutover」这些用户决定；引用集合、结清事实与对账结论都由
 * 调用方从权威来源读好后随意图带上，façade 不推断也不补全它们。
 */
export type GraphEvolutionCommand = ControllerScopeFields &
  (
    | {
        readonly kind: 'graph-evolution';
        readonly action: 'begin-replanning';
        readonly userRequestedReplanning: boolean;
        readonly goalOrGlobalConstraintChanged: boolean;
        readonly graphRevisionsExhausted: boolean;
      }
    | {
        readonly kind: 'graph-evolution';
        readonly action: 'complete-replanning';
        readonly closure: ReplanningClosureMode;
        readonly settlement: SettlementFacts;
        readonly workerStopsConfirmed?: boolean;
        readonly newPlanningCycleId: string;
      }
    | {
        readonly kind: 'graph-evolution';
        readonly action: 'cancel-replanning';
        readonly suspendedGraphId: string;
        readonly authorizationId: string;
        readonly authorizationVersion: Revision;
        readonly reconciliationResolved: boolean;
      }
    | {
        readonly kind: 'graph-evolution';
        readonly action: 'confirm-cutover';
        readonly refs: CandidateGenerationRefs;
      }
  );

export type ControllerCommand =
  | SendSessionMessageCommand
  | CompactSessionCommand
  | SwitchModelConfigurationCommand
  | PlanningHandoffCommand
  | ScopeControlCommand
  | AnswerPendingInteractionCommand
  | ExecutionHandoffCommand
  | GraphEvolutionCommand
  | InitializeScopeCommand;

export type ControllerCommandResult =
  | { readonly kind: 'accepted'; readonly revision: Revision | null; readonly summary: string }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string }
  | { readonly kind: 'unknown'; readonly code: string; readonly message: string };

/* -------------------------------------------------------------------------- */
/* 语义事件                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * store / backend 侧上报的通知。
 *
 * 这里包含噪声是刻意的：过滤发生在 façade，界面事件流因此结构上不可能收到 keepalive 或诊断。
 */
export type ControllerNotification =
  | {
      readonly kind: 'state-changed';
      readonly coordinationScopeId: string;
      readonly revision: Revision;
      readonly reason: string;
    }
  | {
      readonly kind: 'interaction-opened';
      readonly coordinationScopeId: string;
      readonly interactionId: string;
      readonly expectedRevision: Revision;
    }
  | {
      readonly kind: 'interaction-resolved';
      readonly coordinationScopeId: string;
      readonly interactionId: string;
    }
  | {
      readonly kind: 'handoff-phase-changed';
      readonly coordinationScopeId: string;
      readonly handoffId: string;
      readonly phase: ExecutionHandoffPhase;
    }
  | {
      readonly kind: 'worker-liveness-changed';
      readonly coordinationScopeId: string;
      readonly dispatchId: string;
      readonly liveness: WorkerLiveness;
    }
  | {
      readonly kind: 'recovery-status-changed';
      readonly coordinationScopeId: string;
      readonly recoveryId: string;
      readonly status: RecoveryState;
    }
  | {
      readonly kind: 'scope-control-changed';
      readonly coordinationScopeId: string;
      readonly controlState: ControlState;
    }
  | {
      readonly kind: 'graph-version-appended';
      readonly coordinationScopeId: string;
      readonly graphId: string;
      readonly graphVersion: number;
      readonly patchId: string | null;
    }
  | {
      readonly kind: 'revision-hold-changed';
      readonly coordinationScopeId: string;
      readonly workPackageId: string;
      readonly state: RevisionHoldState;
    }
  | {
      readonly kind: 'generation-status-changed';
      readonly coordinationScopeId: string;
      readonly graphId: string;
      readonly status: GraphGenerationStatus;
    }
  | {
      readonly kind: 'generation-cutover-committed';
      readonly coordinationScopeId: string;
      readonly predecessorGraphId: string;
      readonly candidateGraphId: string;
    }
  | {
      readonly kind: 'blocked';
      readonly coordinationScopeId: string;
      readonly code: string;
      readonly message: string;
    }
  | { readonly kind: 'keepalive'; readonly at: number }
  | { readonly kind: 'stderr'; readonly line: string }
  | { readonly kind: 'poll-timeout'; readonly source: string }
  | { readonly kind: 'unchanged-reconciliation'; readonly at: number }
  | { readonly kind: 'diagnostic'; readonly message: string };

type ControllerNoiseKind = 'keepalive' | 'stderr' | 'poll-timeout' | 'unchanged-reconciliation' | 'diagnostic';

/** UI 可投影的语义事件；噪声在 `toSemanticEvent` 里被丢弃。 */
export type SemanticEvent = Exclude<ControllerNotification, { readonly kind: ControllerNoiseKind }>;

export function toSemanticEvent(notification: ControllerNotification): SemanticEvent | null {
  switch (notification.kind) {
    case 'keepalive':
    case 'stderr':
    case 'poll-timeout':
    case 'unchanged-reconciliation':
    case 'diagnostic':
      return null;
    default:
      return notification;
  }
}

export type Unsubscribe = () => void;

export type ControllerEventSource = {
  readonly subscribe: (listener: (notification: ControllerNotification) => void) => Unsubscribe;
};

/* -------------------------------------------------------------------------- */
/* 委派 seam                                                                   */
/* -------------------------------------------------------------------------- */

/** 委派结果：accepted / rejected / unknown 三值，与 IC-02 的 mutation 三值语义一致。 */
export type DelegatedOutcome = ControllerCommandResult;

export type ControllerSnapshotReaderInput = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly selectedSessionId: CoordinatorSessionId | null;
};

export type ControllerSnapshotReader = (
  input: ControllerSnapshotReaderInput,
) => Promise<ControllerSnapshot> | ControllerSnapshot;

export type ControllerTranscriptReaderInput = {
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly cursor: string | null;
};

export type ControllerTranscriptReader = (
  input: ControllerTranscriptReaderInput,
) => Promise<ControllerTranscriptPage> | ControllerTranscriptPage;

/**
 * 各入口的委派 port。
 *
 * 实现由 bootstrap 注入（例如 Execution Handoff port 直接调用
 * `src/application/handoff/execution-handoff.ts` 的四个用例），因此 façade 不需要、也无法直接接触
 * store 或 Orca adapter。
 */
export type SessionMessagePort = (input: SendSessionMessageCommand) => Promise<DelegatedOutcome>;
export type CompactionPort = (input: CompactSessionCommand) => Promise<DelegatedOutcome>;
export type ModelConfigurationPort = (input: SwitchModelConfigurationCommand) => Promise<DelegatedOutcome>;
export type PlanningHandoffPort = (input: PlanningHandoffCommand) => Promise<DelegatedOutcome>;
export type ScopeControlPort = (input: ScopeControlCommand) => Promise<DelegatedOutcome>;
export type PendingInteractionPort = (input: AnswerPendingInteractionCommand) => Promise<DelegatedOutcome>;
export type ExecutionHandoffPort = (input: ExecutionHandoffCommand) => Promise<DelegatedOutcome>;
export type GraphEvolutionPort = (input: GraphEvolutionCommand) => Promise<DelegatedOutcome>;
export type ScopeInitializationPort = (input: InitializeScopeCommand) => Promise<DelegatedOutcome>;

export type ControllerServiceDependencies = {
  readonly snapshots: ControllerSnapshotReader;
  readonly transcript: ControllerTranscriptReader;
  readonly sessionMessages: SessionMessagePort;
  readonly compaction: CompactionPort;
  readonly modelConfiguration: ModelConfigurationPort;
  readonly planningHandoff: PlanningHandoffPort;
  readonly scopeControl: ScopeControlPort;
  readonly pendingInteractions: PendingInteractionPort;
  readonly executionHandoff: ExecutionHandoffPort;
  readonly graphEvolution: GraphEvolutionPort;
  readonly scopeInitialization: ScopeInitializationPort;
  /** store / backend 侧通知源；省略时不发布事件。 */
  readonly events?: ControllerEventSource;
};

export interface ControllerService {
  query(input: ControllerQuery): Promise<ControllerQueryResult>;
  execute(input: ControllerCommand): Promise<ControllerCommandResult>;
  subscribe(listener: (event: SemanticEvent) => void): Unsubscribe;
}

/* -------------------------------------------------------------------------- */
/* 快照投影                                                                    */
/* -------------------------------------------------------------------------- */

export type ControllerSnapshotFacts = {
  /** IC-03 的只读投影；本函数只从中取白名单字段。 */
  readonly snapshot: CoordinationSnapshot;
  /** Scope 的共享预算计数；来自 IC-03 的 `budget-counters` 查询。 */
  readonly budgets: readonly BudgetCounterRecord[];
  readonly graphGeneration: number | null;
  readonly frontier: readonly ControllerFrontierEntry[];
  readonly workers: readonly ControllerWorkerEntry[];
  /** 来自调用方的额外 blocker（例如 Scope 控制与服务层判定）。 */
  readonly extraBlockers: readonly ControllerBlockerEntry[];
  readonly maintenance: ControllerMaintenanceView | null;
  readonly selectedSessionId: CoordinatorSessionId | null;
  /**
   * 调用方读到的 GraphVersion 记录（IC-11 Extend）。
   *
   * 只读投影，不由本模块读取：记录不可读时调用方显式传空数组，界面显示 blocker 而不是猜测图内容。
   */
  readonly graphVersions: readonly GraphVersionRecord[];
  /**
   * 已批准 Execution Authorization 绑定的图引用（IC-11 Extend）。
   *
   * 仅用于判定 readiness；没有授权时为 `null`。
   */
  readonly authorizationGraphRef: { readonly graphId: string; readonly graphVersion: number } | null;
  /** Runtime 观察到的最近一次压缩结论（IC-11 Extend）；从未观察到时为 `null`。 */
  readonly compaction: ControllerCompactionView | null;
};

function projectInteraction(interaction: PendingInteractionRecord): ControllerInteractionView {
  return {
    interactionId: interaction.interactionId,
    ownerCoordinatorSessionId: interaction.ownerCoordinatorSessionId,
    subjectRef: interaction.subjectRef,
    expectedRevision: interaction.expectedRevision,
    state: interaction.state,
  };
}

function projectHandoff(handoff: ExecutionHandoffRecord): ControllerHandoffView {
  return {
    handoffId: handoff.handoffId,
    sourceSessionId: handoff.sourceSessionId,
    targetSessionId: handoff.targetSessionId,
    graphGeneration: handoff.graphGeneration,
    phase: handoff.phase,
    expectedRevision: handoff.expectedRevision,
    responsibilitySet: handoff.responsibilitySet,
  };
}

function projectRecovery(recovery: RecoveryRecord): ControllerRecoveryView {
  return {
    recoveryId: recovery.recoveryId,
    workerTaskId: recovery.workerTaskId,
    role: recovery.role,
    status: recovery.status,
    consumedBudget: recovery.consumedBudget,
  };
}

function projectBudget(budget: BudgetCounterRecord): ControllerBudgetView {
  return {
    budgetKey: budget.budgetKey,
    approvedLimitRef: budget.approvedLimitRef,
    consumed: budget.consumed,
  };
}

function projectGeneration(generation: GraphGenerationRecord): ControllerGraphGenerationView {
  return {
    graphId: generation.graphId,
    generation: generation.generation,
    status: generation.status,
    planningCycleId: generation.planningCycleId,
    orcaRunId: generation.orcaRunId,
    predecessorGraphId: generation.predecessorGraphId,
    baselineHead: generation.baselineHead,
  };
}

function projectRevisionHold(hold: RevisionHoldRecord): ControllerRevisionHoldView {
  return { workPackageId: hold.workPackageId, source: hold.source, state: hold.state };
}

function projectReconciliation(reconciliation: BaselineReconciliationRecord): ControllerReconciliationView {
  return {
    reconciliationId: reconciliation.reconciliationId,
    workPackageId: reconciliation.workPackageId,
    state: reconciliation.state,
  };
}

function projectLineage(lineage: WorkPackageLineageRecord): ControllerLineageView {
  return {
    workPackageId: lineage.workPackageId,
    priorWorkPackageId: lineage.priorWorkPackageId,
    inherited: lineage.inherited,
  };
}

function projectAdoption(adoption: BaselineAdoptionRecord): ControllerAdoptionView {
  return {
    adoptionId: adoption.adoptionId,
    workPackageId: adoption.workPackageId,
    kind: adoption.kind,
    state: adoption.state,
  };
}

function projectPlanningHandoff(handoff: PlanningHandoffRecord): ControllerPlanningHandoffView {
  return {
    proposalId: handoff.proposalId,
    sourceSessionId: handoff.sourceCoordinatorSessionId,
    targetSessionId: handoff.targetCoordinatorSessionId,
    phase: handoff.phase,
    mapRevision: handoff.mapRevision,
    planRevision: handoff.planRevision,
    capsuleRef: handoff.capsuleRef,
    proposalRevision: handoff.proposalRevision,
  };
}

function projectGraphTopology(
  version: GraphVersionRecord,
  facts: ControllerSnapshotFacts,
): ControllerGraphTopologyView {
  const generation = facts.snapshot.graphGenerations.find((entry) => entry.graphId === version.graphId);
  return {
    graphId: version.graphId,
    graphVersion: version.version,
    generation: version.generation,
    nodes: version.graph.workPackages.map<ControllerGraphNodeView>((workPackage) => ({
      workPackageId: workPackage.workPackageId,
      title: workPackage.title,
      dependsOn: [...workPackage.dependsOn],
      scopeEnvelope: {
        include: [...workPackage.scopeEnvelope.include],
        exclude: [...workPackage.scopeEnvelope.exclude],
      },
    })),
    readiness: {
      generationStatus: generation?.status ?? null,
      authorizationBound:
        facts.authorizationGraphRef !== null &&
        facts.authorizationGraphRef.graphId === version.graphId &&
        facts.authorizationGraphRef.graphVersion === version.version,
    },
  };
}

/**
 * 把 IC-03 快照与调用方注入的外部事实投影成 ControllerSnapshot。
 *
 * 纯函数、字段白名单：输出只由这里显式列出的字段组成，因此上游记录变宽也不会把 receipt、结果正文
 * 或 adapter handle 带进界面。
 */
export function projectControllerSnapshot(facts: ControllerSnapshotFacts): ControllerSnapshot {
  const { scope, sessions, leases, executionLease, pendingInteractions, mutationLanes } = facts.snapshot;
  const executionLeaseHolderSessionId = executionLease === null ? null : executionLease.coordinatorSessionId;
  const runtimeLeaseHolders = new Set(
    leases.filter((lease) => lease.kind === 'runtime' && lease.releasedAt === null).map((lease) => lease.coordinatorSessionId),
  );
  const planningResponsible = facts.snapshot.planningResponsibility?.coordinatorSessionId ?? null;
  const pendingHolds = facts.snapshot.revisionHolds.filter((hold) => hold.state === 'pending');
  const blockedReconciliations = facts.snapshot.baselineReconciliations.filter(
    (reconciliation) => reconciliation.state === 'blocked',
  );

  const blockers: ControllerBlockerEntry[] = [
    ...mutationLanes.map<ControllerBlockerEntry>((lane) => ({
      source: 'mutation_lane',
      code: lane.cause,
      message: `${lane.laneKey}: ${lane.reason}`,
    })),
    ...facts.snapshot.executionHandoffs
      .filter((handoff) => handoff.phase === 'blocked' || handoff.blockingReason !== null)
      .map<ControllerBlockerEntry>((handoff) => ({
        source: 'handoff',
        code: handoff.phase,
        message: handoff.blockingReason ?? `Execution Handoff ${handoff.handoffId} 处于 ${handoff.phase}`,
      })),
    ...facts.snapshot.recoveries
      .filter((recovery) => recovery.status === 'blocked')
      .map<ControllerBlockerEntry>((recovery) => ({
        source: 'recovery',
        code: recovery.status,
        message: recovery.blockingReason ?? `Recovery ${recovery.recoveryId} 已阻塞`,
      })),
    ...pendingHolds.map<ControllerBlockerEntry>((hold) => ({
      source: 'revision_pending',
      code: hold.source,
      message: `${hold.workPackageId} 处于 revision pending（来源 ${hold.sourceRef}）`,
    })),
    ...blockedReconciliations.map<ControllerBlockerEntry>((reconciliation) => ({
      source: 'baseline_reconciliation',
      code: reconciliation.state,
      message: `Work Package ${reconciliation.workPackageId} 的基线核验未通过（${reconciliation.blockerRef ?? '未给出原因'}）`,
    })),
    ...facts.extraBlockers,
  ];

  return {
    coordinationScopeId: scope.coordinationScopeId,
    revision: scope.revision,
    mode: scope.mode,
    controlState: scope.controlState,
    planningCycleId: scope.planningCycleId,
    mapRevision: scope.mapRevision,
    graph:
      scope.graphId === null || scope.graphVersion === null
        ? null
        : { graphId: scope.graphId, graphVersion: scope.graphVersion, generation: facts.graphGeneration },
    authorization:
      scope.authorizationId === null || scope.authorizationVersion === null
        ? null
        : { authorizationId: scope.authorizationId, version: scope.authorizationVersion },
    executionLeaseHolderSessionId,
    selectedSessionId: facts.selectedSessionId,
    sessions: sessions.map<ControllerSessionSummary>((session) => ({
      coordinatorSessionId: session.coordinatorSessionId,
      coordinatorModelConfigurationRef: session.coordinatorModelConfigurationRef,
      lifecycleState: session.lifecycleState,
      holdsRuntimeLease: runtimeLeaseHolders.has(session.coordinatorSessionId),
      holdsExecutionLease: executionLeaseHolderSessionId === session.coordinatorSessionId,
      planningResponsible: planningResponsible === session.coordinatorSessionId,
      openInteractionCount: pendingInteractions.filter(
        (interaction) =>
          interaction.state === 'open' &&
          interaction.ownerCoordinatorSessionId === session.coordinatorSessionId,
      ).length,
    })),
    budgets: facts.budgets.map(projectBudget),
    frontier: facts.frontier.map((entry) => ({ ...entry })),
    workers: facts.workers.map((worker) => ({ ...worker })),
    blockers,
    interactions: pendingInteractions.map(projectInteraction),
    handoffs: facts.snapshot.executionHandoffs.map(projectHandoff),
    recoveries: facts.snapshot.recoveries.map(projectRecovery),
    graphEvolution: {
      generations: facts.snapshot.graphGenerations.map(projectGeneration),
      revisionHolds: facts.snapshot.revisionHolds.map(projectRevisionHold),
      reconciliations: facts.snapshot.baselineReconciliations.map(projectReconciliation),
      lineages: facts.snapshot.workPackageLineages.map(projectLineage),
      adoptions: facts.snapshot.baselineAdoptions.map(projectAdoption),
    },
    maintenance: facts.maintenance,
    graphTopologies: facts.graphVersions.map((version) => projectGraphTopology(version, facts)),
    compaction: facts.compaction,
    planningHandoffs: facts.snapshot.planningHandoffs.map(projectPlanningHandoff),
  };
}

/* -------------------------------------------------------------------------- */
/* façade                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 组装 ControllerService。
 *
 * 每个 command / query variant 只调用对应的那个 port 一次；事件只做过滤与转发。整个实现里没有任何
 * store、SQLite 或 adapter import，因此「façade 不直连 store/backend」是结构性的，而不是纪律。
 */
export function createControllerService(dependencies: ControllerServiceDependencies): ControllerService {
  const listeners = new Set<(event: SemanticEvent) => void>();

  if (dependencies.events !== undefined) {
    dependencies.events.subscribe((notification) => {
      const event = toSemanticEvent(notification);
      if (event === null) {
        return;
      }
      for (const listener of [...listeners]) {
        listener(event);
      }
    });
  }

  const query = async (input: ControllerQuery): Promise<ControllerQueryResult> => {
    switch (input.kind) {
      case 'snapshot': {
        const snapshot = await dependencies.snapshots({
          coordinationScopeId: input.coordinationScopeId,
          selectedSessionId: input.selectedSessionId ?? null,
        });
        return { kind: 'snapshot', snapshot };
      }
      case 'session-transcript': {
        const transcript = await dependencies.transcript({
          coordinatorSessionId: input.coordinatorSessionId,
          cursor: input.cursor ?? null,
        });
        return { kind: 'session-transcript', transcript };
      }
    }
  };

  const execute = async (input: ControllerCommand): Promise<ControllerCommandResult> => {
    switch (input.kind) {
      case 'send-session-message':
        return dependencies.sessionMessages(input);
      case 'compact-session':
        return dependencies.compaction(input);
      case 'switch-model-configuration':
        return dependencies.modelConfiguration(input);
      case 'planning-handoff':
        return dependencies.planningHandoff(input);
      case 'scope-control':
        return dependencies.scopeControl(input);
      case 'answer-pending-interaction':
        return dependencies.pendingInteractions(input);
      case 'execution-handoff':
        return dependencies.executionHandoff(input);
      case 'graph-evolution':
        return dependencies.graphEvolution(input);
      case 'initialize-scope':
        return dependencies.scopeInitialization(input);
    }
  };

  const subscribe = (listener: (event: SemanticEvent) => void): Unsubscribe => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return { query, execute, subscribe };
}
