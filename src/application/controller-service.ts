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
  CoordinationScopeId,
  CoordinatorSessionId,
  EntityRef,
  InteractionId,
  Revision,
} from './dto/identity.js';
import type {
  BudgetCounterRecord,
  CoordinationSnapshot,
  CoordinationWriter,
  ExecutionHandoffPhase,
  ExecutionHandoffRecord,
  HandoffResponsibility,
  PendingInteractionRecord,
  PendingInteractionState,
  RecoveryRecord,
  RecoveryState,
  SessionLifecycleState,
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
  readonly maintenance: ControllerMaintenanceView | null;
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

export type ControllerCommand =
  | SendSessionMessageCommand
  | CompactSessionCommand
  | SwitchModelConfigurationCommand
  | PlanningHandoffCommand
  | ScopeControlCommand
  | AnswerPendingInteractionCommand
  | ExecutionHandoffCommand
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
    maintenance: facts.maintenance,
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
