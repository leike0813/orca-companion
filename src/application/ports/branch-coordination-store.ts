/**
 * IC-03：Branch Coordination Store 的封闭 query / command seam
 * （Owner: `m1-persist-coordination-state`；后继 change 通过版本化 migration 扩展最少记录与 variant）。
 *
 * 这个 store 是共享协调事实的唯一写入点：它只保存无法从 issue tracker、项目配置、Git 与 Orca
 * 重建的事实。Route Map 正文、Git HEAD、worktree 路径与 Orca Task 状态都不属于这里，调用方必须
 * 回到原始权威源读取。
 *
 * 调用约定：
 * - 每次写入携带调用方读到的 `expectedRevision`；新 revision 只能由 store 在同一事务内推进；
 * - `writer` 的身份与 fencing 由 Controller 从当前 lease 派生，模型与 Worker 不可填写；
 * - 事务保持短小，不使用跨调用的长期写者锁；
 * - 未知 command variant 在边界 fail closed，不猜测、不降级。
 */

import type { ControlState, CoordinationMode } from '../../domain/coordination/mode.js';
import { MAX_USER_MESSAGE_CHARS } from '../coordinator/user-message.js';
import type { MutationLaneRecord } from '../../domain/coordination/mutation-lane.js';
import type {
  BindIntegrationContinuationInput,
  IntegrationReconciliationRecord,
  RegisterIntegrationReconciliationInput,
  SettleIntegrationReconciliationInput,
} from '../integration-reconciliation.js';
import type { LeaseKind, LeaseRecord } from '../../domain/coordination/leases.js';
import type { SourceRevisionRef } from '../../domain/coordinator/session-state.js';
import type { DeliveryVerdict } from '../../domain/delivery-verdict.js';
import type { InheritedBudgetUse } from '../../domain/execution/work-package-lineage.js';
import type { SpecBinding } from '../../domain/task-contract.js';
import type {
  PatchDescendantDisposition,
  PatchResponsibilityTakeover,
} from '../../domain/execution/graph-patch.js';
import {
  GRAPH_GENERATION_STATUSES,
  GRAPH_GENERATION_TRANSITIONS,
  type GraphGenerationStatus,
} from '../../domain/execution/replanning.js';
import type { ExecutionGraph, GraphVersionRecord, GraphVersionRecordKind, ImplementationPlan } from '../../domain/planning/execution-graph.js';
import type { ExecutionAuthorizationManifest, ExecutionAuthorizationRecord, WorkerRole } from '../../domain/planning/execution-authorization.js';
import { TICKET_CLAIM_STATES, type TicketClaimState } from '../../domain/planning/ticket-claim.js';
import type { IntentState, OperationIntent } from '../dto/operation-intent.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  DispatchId,
  GraphGeneration,
  GraphId,
  GraphVersion,
  InteractionId,
  OperationId,
  PlanningCycleId,
  RecoveryId,
  Revision,
  RuntimeIncarnationId,
  SessionSegmentId,
  StableId,
  EntityRef,
  WorkerTaskId,
  WorkPackageId,
} from '../dto/identity.js';

export type { LeaseKind, LeaseRecord };
export { TICKET_CLAIM_STATES };
export type { TicketClaimState };

export const SESSION_LIFECYCLE_STATES = ['registered', 'active', 'blocked', 'cancelled'] as const;

export type SessionLifecycleState = (typeof SESSION_LIFECYCLE_STATES)[number];

/**
 * Session 持久阻塞的结构化原因。
 *
 * `code` 是稳定的机器可读分类（例如 checkpoint 损坏、上下文耗尽、共享 checkpoint 不可恢复），`message`
 * 是人类可读的说明。持久化的是「为什么被阻塞」这一事实本身；清除阻塞只能经显式 `update-session-lifecycle`，
 * 启动时不自动清除。
 */
export type SessionBlockingReason = {
  readonly code: string;
  readonly message: string;
};

export const PENDING_INTERACTION_STATES = ['open', 'answered', 'cancelled'] as const;

export type PendingInteractionState = (typeof PENDING_INTERACTION_STATES)[number];

export type ScopeRecord = {
  readonly coordinationScopeId: CoordinationScopeId;
  /**
   * 用户登记的完整 branch ref 与 canonical worktree 绑定。
   *
   * 它是**不可原地改写**的注册事实，不是 Git 当前状态的镜像：Git 仍然提供实时 HEAD 与 worktree，
   * 这里只保存「用户当初确认过哪一个」。旧记录可能尚未绑定，此时为 `null`，只可经一次性受控绑定补齐。
   */
  readonly fullBranchRef: string | null;
  readonly canonicalWorktreePath: string | null;
  readonly mode: CoordinationMode;
  readonly controlState: ControlState;
  readonly planningCycleId: PlanningCycleId | null;
  /** 当前 Route Map revision；候选图与未决交接提案据此判定过期。 */
  readonly mapRevision: Revision;
  readonly graphId: GraphId | null;
  readonly graphVersion: GraphVersion | null;
  readonly authorizationId: StableId | null;
  readonly authorizationVersion: Revision | null;
  readonly revision: Revision;
};

export type CoordinatorSessionRegistration = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly coordinatorModelConfigurationRef: string;
  readonly lifecycleState: SessionLifecycleState;
  /** `blocked` 时必有结构化原因；其它状态一律为 `null`。 */
  readonly blockedReason: SessionBlockingReason | null;
  readonly registeredAt: number;
};

export type TicketClaimRecord = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly ticketRef: EntityRef<string>;
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly state: TicketClaimState;
  readonly claimedAt: number;
};

export type PendingInteractionRecord = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly interactionId: InteractionId;
  readonly ownerCoordinatorSessionId: CoordinatorSessionId;
  readonly subjectRef: EntityRef<string>;
  readonly expectedRevision: Revision;
  readonly state: PendingInteractionState;
  readonly answerRef: EntityRef<string> | null;
  /** 受控回答正文；与解决状态在同一 CAS 事务写入，`null` 表示没有正文。 */
  readonly answerText: string | null;
  readonly createdAt: number;
  readonly resolvedAt: number | null;
};

export type UserQuestion = {
  readonly text: string;
  readonly options: readonly { readonly label: string; readonly description?: string }[];
};
export type PendingInteractionDetail = PendingInteractionRecord & { readonly question: UserQuestion | null };
export type InteractionPageCursor = { readonly createdAt: number; readonly interactionId: string };
export type InteractionIdentity = Omit<PendingInteractionRecord, 'answerText'>;
export type InteractionSummary = InteractionIdentity & {
  readonly questionPreview: string;
  readonly answerPreview: string;
  readonly questionByteLength: number;
  readonly answerByteLength: number;
};
export type InteractionOverview = {
  readonly openCount: number;
  readonly sessionCounts: readonly { readonly coordinatorSessionId: string; readonly openCount: number }[];
  readonly items: readonly InteractionSummary[];
};

/** 工具与存储共用的问题边界，不接受模型填写身份。 */
export function isUserQuestion(value: unknown): value is UserQuestion {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some((key) => key !== 'text' && key !== 'options') ||
    typeof data['text'] !== 'string' || !data['text'].trim() || !Array.isArray(data['options']) || data['options'].length > 8) return false;
  const labels = new Set<string>();
  let length = data['text'].length;
  for (const option of data['options']) {
    if (typeof option !== 'object' || option === null || Array.isArray(option)) return false;
    const item = option as Record<string, unknown>;
    if (Object.keys(item).some((key) => key !== 'label' && key !== 'description') ||
      typeof item['label'] !== 'string' || !item['label'].trim() || labels.has(item['label'].trim()) ||
      (item['description'] !== undefined && typeof item['description'] !== 'string')) return false;
    labels.add(item['label'].trim());
    length += item['label'].length + (typeof item['description'] === 'string' ? item['description'].length : 0);
  }
  return length <= MAX_USER_MESSAGE_CHARS;
}

export type BudgetCounterRecord = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly budgetKey: string;
  readonly approvedLimitRef: string;
  readonly consumed: number;
};

/**
 * 一条持久准入的 Validator 修复步骤（schema 20）。
 *
 * 它是「这次修复是否已经扣过预算」的唯一本地证据：`stepId` 稳定，重放读取既有行即可判定，不需要
 * 时钟或再次扣减。这里不保存修复内容或证据——那些归 Worker 结果与 Orca。
 */
export type ValidationStepAdmissionRecord = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly stepId: string;
  readonly workPackageId: WorkPackageId;
  readonly workerTaskId: WorkerTaskId;
  readonly dispatchId: DispatchId;
  readonly validationAttemptId: string;
  readonly repairOrdinal: number;
  readonly budgetKey: string;
  readonly approvedLimitRef: string;
  readonly admittedAt: number;
};

/**
 * 一条 Validator Validation Attempt 的有界游标记录（schema 20）。
 *
 * 它是「这条验证链已经消费了多少修复额度、已经回读过哪些 message」的最小持久事实：不含任何消息正文或
 * 第二份验证状态机。`initialRepairConsumed` 在首次写入后不可变，`messageIds` 只允许按序追加（最多 20 项），
 * `terminalQuestionMessageId` 只在拿到 finish/refuse 许可后一次性记录。`providerSessionId` 是固定的
 * session 身份，与物化绑定、Session Segment 的 session binding 一致。
 */
export type ValidationAttemptRecord = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly validationAttemptId: string;
  readonly workPackageId: WorkPackageId;
  readonly workerTaskId: WorkerTaskId;
  readonly dispatchId: DispatchId;
  readonly providerSessionId: string;
  readonly initialRepairConsumed: number;
  readonly messageIds: readonly string[];
  readonly terminalQuestionMessageId: string | null;
  readonly updatedAt: number;
};

/**
 * Wake Batch 的 source admission 状态。
 *
 * `admitted` 是正常路径：checkpoint 已写入该 batch，随后按 source revision 记下准入。
 * `repaired` 是跨库补齐路径：进程在「已写 checkpoint、未记 admission」之间中断，重启时以同一
 * batch ID 回读 checkpoint 发现该 batch 已在历史里，于是补记准入而不是再次注入。
 */
export const WAKE_ADMISSION_STATES = ['admitted', 'repaired'] as const;

export type WakeAdmissionState = (typeof WAKE_ADMISSION_STATES)[number];

export type WakeAdmissionRecord = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly wakeBatchId: string;
  readonly admissionState: WakeAdmissionState;
  readonly sourceRevisions: readonly SourceRevisionRef[];
  readonly admittedAt: number;
};

/**
 * Route Planning 责任交接的阶段（IC-05 Extend）。
 *
 * 阶段是持久事实：`prepared` 只产出提案，`reviewed` 表示接收方已独立复核，`cutover` 才把责任转移，
 * `cancelled` 是终态。崩溃后从阶段确定性恢复，不猜测责任归属。
 */
export const PLANNING_HANDOFF_PHASES = ['prepared', 'reviewed', 'cutover', 'cancelled'] as const;

export type PlanningHandoffPhase = (typeof PLANNING_HANDOFF_PHASES)[number];

/** 允许的阶段迁移；未列出的迁移在 store 边界被拒绝。 */
export const PLANNING_HANDOFF_TRANSITIONS: Readonly<Record<PlanningHandoffPhase, readonly PlanningHandoffPhase[]>> =
  {
    prepared: ['reviewed', 'cancelled'],
    reviewed: ['cutover', 'cancelled'],
    cutover: [],
    cancelled: [],
  };

export type PlanningHandoffRecord = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly proposalId: string;
  readonly sourceCoordinatorSessionId: CoordinatorSessionId;
  readonly targetCoordinatorSessionId: CoordinatorSessionId;
  readonly phase: PlanningHandoffPhase;
  readonly mapRevision: Revision;
  readonly planRevision: Revision;
  readonly graphId: GraphId | null;
  readonly graphVersion: GraphVersion | null;
  /** 可移植 Coordinator Context Capsule 的引用；本库不保存 Capsule 内容。 */
  readonly capsuleRef: string | null;
  /** 提案级 CAS revision；与 Scope revision 分离，避免交接提交强迫 Scope 全局串行。 */
  readonly proposalRevision: Revision;
  readonly createdAt: number;
  readonly updatedAt: number;
};

/** 当前 Route Planning 责任方；一个 Scope 最多一行，因此不可能同时存在两个责任方。 */
export type PlanningResponsibilityRecord = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly sourceProposalId: string | null;
  readonly assignedAt: number;
};

/**
 * 一次 Worker Harness 会话中断的显式 Segment 前置事实（IC-07 Extend）。
 *
 * 它只记录中断时能核验的事实，供后续 change 判断与恢复；本记录不含 Recovery Budget 计数、Capsule
 * 内容或替代 Session，因此不可能被读成「已经恢复」。
 */
export type SessionSegmentRecord = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly segmentId: SessionSegmentId;
  readonly workPackageId: WorkPackageId;
  readonly role: WorkerRole;
  readonly workerTaskId: WorkerTaskId;
  readonly dispatchId: DispatchId;
  readonly attemptId: string;
  readonly sessionBindingId: string;
  /** 最后可引用的 transcript 位置；`null` 表示 transcript 已无法引用。 */
  readonly lastTranscriptRef: string | null;
  /** 中断时可核验的终态收据引用；核验不了时为 `null`。 */
  readonly terminalReceiptRef: string | null;
  /** `false` 时后继路径只能阻塞，不得假装原 session 继续。 */
  readonly transcriptReferenceable: boolean;
  readonly verifiable: boolean;
  readonly recordedAt: number;
};


/**
 * 一条物化绑定的身份完整度。
 *
 * `issued` 是 schema 11 起由受控命令写入的行：Task Envelope 身份、worktree 与 Spec Binding 都在。
 * `legacy` 是 schema 11 之前的旧行：那时每个 Work Package 只保存一个 Orca Task 指针，没有任何可以
 * 证明角色或 Attempt 的事实。旧行的身份字段一律为 `null`，读取方必须显式阻塞，不得推断角色。
 */
export const MATERIALIZATION_BINDING_IDENTITIES = ['issued', 'legacy'] as const;

export type MaterializationBindingIdentity = (typeof MATERIALIZATION_BINDING_IDENTITIES)[number];

/**
 * 一次角色级派发的物化绑定（IC-03 Extend；schema 11）。
 *
 * 一行回答「某个 Work Package 的某个角色的第几次 Attempt 被派发成了哪个 Orca Task」。因为按
 * role + attempt 保存，同一 Work Package 可以有多行历史；它不是「当前指针」，也不是 Orca Task 状态的
 * 副本。`worktreeId` 只保存 Orca 不透明身份，绝对路径与 Git HEAD 仍归 Git 与 Orca。
 *
 * `dispatchId` 是**逻辑** Task Envelope 的派发身份，与 Orca `worker-start` 回执里的 dispatch 不是
 * 同一件事。`attemptId` 在同一 Work Package 与角色内必须唯一，唯一约束据此阻止重复派发。
 */
export type MaterializationBindingRecord = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly workPackageId: WorkPackageId;
  readonly identity: MaterializationBindingIdentity;
  /** `legacy` 行为 `null`；`issued` 行由主角色或 `recoveryUtilityRole` 证明身份。 */
  readonly role: WorkerRole | null;
  /**
   * Recovery Utility 派发身份（IC-03 Extend；schema 16）。
   *
   * 它与 `role` 互斥且恰好一列非空：Utility Task 不属于领域四主角色，却同样需要固定授权与 profile，
   * 否则替代 Session 的模型配置只能从「当前授权」现读。
   */
  readonly recoveryUtilityRole: 'recovery_utility' | null;
  readonly workerTaskId: WorkerTaskId | null;
  /** 逻辑 Task Envelope 的派发身份；`legacy` 行为 `null`。 */
  readonly dispatchId: DispatchId | null;
  readonly attemptId: string | null;
  readonly worktreeId: string | null;
  /** Planner 首次创建规格时为 `null`；其它角色必须是已接纳的内容绑定。 */
  readonly specBinding: SpecBinding | null;
  /** Planner 的固定目标路径；其它角色与 `legacy` 行为 `null`。 */
  readonly specificationUnitPath: string | null;
  /**
   * 这次派发固定使用的授权身份（IC-05；schema 16）。
   *
   * Worker 重新授权只对新的物化 Task 生效，因此 Task 的运行依据必须在派发时钉住：`null` 表示 schema 16
   * 之前的历史行——当时没有这项事实，读取方按不可证明阻塞，不回退到「当前授权」。
   */
  readonly authorizationId: string | null;
  readonly authorizationVersion: number | null;
  readonly workerProfileRef: EntityRef<'worker-profile'> | null;
  readonly orcaTaskId: string;
  readonly creationOperationId: OperationId;
  /**
   * 这次派发使用的 Worker launch 身份（IC-07）。
   *
   * 它是补记 Session Binding 的唯一定位事实：报告文件按 launchId 派生。`legacy` 行与 schema 11 之前
   * 写入的行没有它（`null`），读取方在需要补记时按不可补记处之，不重建派生编码。
   */
  readonly launchId: string | null;
  readonly createdAt: number;
};

/**
 * 一条已结算的 Delivery（IC-08 Extend）。
 *
 * 一行同时是稳定去重键与 `AcceptedWorkerResultRef`：去重键是主键，结果是 Orca 的结果引用。
 * 它**不**保存 Accepted Worker Result 正文，也不复制 Orca 的 Task/Dispatch 状态。
 */
/** Worker 结果的规范化成败。 */
export const DELIVERY_SETTLEMENT_OUTCOMES = ['succeeded', 'failed'] as const;

export type DeliverySettlementOutcome = (typeof DELIVERY_SETTLEMENT_OUTCOMES)[number];

/** Validator 的规范化验证结论。 */
export const DELIVERY_VALIDATION_VERDICTS = ['passed', 'failed'] as const;

export type DeliveryValidationVerdict = (typeof DELIVERY_VALIDATION_VERDICTS)[number];

export type DeliverySettlementRecord = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly dedupeKey: string;
  readonly deliveryId: string;
  readonly runId: string;
  readonly consumerGeneration: number;
  readonly workerTaskId: WorkerTaskId;
  readonly dispatchId: DispatchId;
  readonly attemptId: string;
  readonly role: WorkerRole;
  readonly contractRevision: number;
  readonly orcaResultRef: string;
  /**
   * Worker 结果的规范化成败；`null` 表示本行没有这项事实（schema 20 之前的旧行），读取方必须精确复核，
   * 不得把缺失当成成功。
   */
  readonly outcome: DeliverySettlementOutcome | null;
  /** Validator 结论；非 validator 角色与旧行均为 `null`。 */
  readonly validationVerdict: DeliveryValidationVerdict | null;
  readonly acceptedAt: number;
};

/**
 * 一条分支级 Delivery Verdict 记录（IC-08 Extend）。
 *
 * 追加写入，不就地改写：`verdictSequence` 单调递增，因此「最新结论」有确定顺序；结论本身只引用
 * 既有权威事实，不携带任何可以覆盖它们的字段。
 */
export type DeliveryVerdictRecord = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly verdictId: string;
  readonly verdictSequence: number;
  readonly verdict: DeliveryVerdict;
  readonly finalizerRole: 'finalizer';
  readonly sessionBindingRef: string;
  readonly recordedAt: number;
};

/**
 * IC-09 的 Worker Session Recovery 状态闭集。
 *
 * 这是合同取值，不在这里增删：`superseded` 由 `supersededSegmentId` 表达为「哪条 Segment 已被
 * 取代」的事实，而不是 Recovery 的第三种状态。
 */
export const RECOVERY_STATES = ['pending', 'recovering', 'recovered', 'blocked', 'cancelled'] as const;

export type RecoveryState = (typeof RECOVERY_STATES)[number];

/** 允许的状态迁移；未列出的迁移在 store 边界被拒绝。终态不再接受推进。 */
export const RECOVERY_TRANSITIONS: Readonly<Record<RecoveryState, readonly RecoveryState[]>> = {
  pending: ['recovering', 'blocked', 'cancelled'],
  recovering: ['recovered', 'blocked', 'cancelled'],
  blocked: ['recovering', 'cancelled'],
  recovered: [],
  cancelled: [],
};

/** Recovery 的终结结果闭集；`null` 表示尚未终结。 */
export const RECOVERY_TERMINAL_OUTCOMES = ['replaced', 'source_completed', 'failed'] as const;

export type RecoveryTerminalOutcome = (typeof RECOVERY_TERMINAL_OUTCOMES)[number];

/**
 * 一次 Worker Session Recovery 的最小持久记录（IC-09 `RecoveryState` 加持久化必需字段）。
 *
 * 它只保存无法从 Orca、Git 或 transcript 重建的共享事实：这次 Recovery 针对哪条中断 Segment、
 * 用了哪次替代派发、消耗了多少 Recovery Budget。Capsule 正文与 transcript 内容都不在这里，
 * `capsuleRef` 只是引用。
 *
 * `consumedBudget` 是**这一条 Recovery** 的消耗量；某个 `businessAttemptId` 的已消耗额度等于该
 * attempt 全部 Recovery 记录之和，因此重启、恢复、Patch 与重规划都不可能通过覆盖一行来重置它。
 */
export type RecoveryRecord = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly recoveryId: RecoveryId;
  readonly role: WorkerRole;
  readonly workPackageId: WorkPackageId;
  readonly workerTaskId: WorkerTaskId;
  /** 业务 Attempt 身份；Recovery 沿用原 Attempt，不新建业务尝试。 */
  readonly businessAttemptId: string;
  readonly sourceSegmentId: SessionSegmentId;
  readonly sourceDispatchId: DispatchId;
  readonly replacementDispatchId: string | null;
  readonly replacementSegmentId: SessionSegmentId | null;
  readonly replacementSessionBindingId: string | null;
  /** 被替代的原 Segment；表达 supersede 事实而不引入第三个状态取值。 */
  readonly supersededSegmentId: SessionSegmentId | null;
  readonly status: RecoveryState;
  readonly consumedBudget: number;
  readonly capsuleRef: string | null;
  /** 替代 Session 副作用之前预写的 Operation Intent。 */
  readonly prewriteOperationId: OperationId | null;
  readonly terminalOutcome: RecoveryTerminalOutcome | null;
  readonly blockingReason: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
};

/**
 * 与 Recovery 收尾同事务写入的替代 Session Segment（IP-3 Extend）。
 *
 * 字段与独立 command `record-session-segment` 一一对应，因为它是同一种事实；区别只在写入时机：
 * 创建替代 Segment 必须在**创建它的同一事务内**消耗 Recovery Budget，否则崩溃会留下「Segment 已
 * 落盘、Recovery 未收尾、consumedBudget 仍为 0」的半记录状态，使后续按 Worker Attempt 求和低估
 * 已消耗额度，从而突破 `maxRecoveriesPerWorkerAttempt`。
 */
export type ReplacementSegmentInput = {
  readonly segmentId: SessionSegmentId;
  readonly workPackageId: WorkPackageId;
  readonly role: WorkerRole;
  readonly workerTaskId: WorkerTaskId;
  readonly dispatchId: DispatchId;
  readonly attemptId: string;
  readonly sessionBindingId: string;
  readonly lastTranscriptRef: string | null;
  readonly terminalReceiptRef: string | null;
  readonly transcriptReferenceable: boolean;
  readonly verifiable: boolean;
};

/**
 * IC-09 的 Execution Handoff 阶段闭集与允许迁移。
 *
 * `prepared` 与 `reviewed` 都不转移责任，`cutover` 才以一次 CAS 转移；`blocked` 表示失败后 Source
 * 仍是唯一 owner，等待用户补充事实后再走 `reviewed` 或取消。
 */
export const EXECUTION_HANDOFF_PHASES = ['prepared', 'reviewed', 'cutover', 'cancelled', 'blocked'] as const;

export type ExecutionHandoffPhase = (typeof EXECUTION_HANDOFF_PHASES)[number];

export const EXECUTION_HANDOFF_TRANSITIONS: Readonly<
  Record<ExecutionHandoffPhase, readonly ExecutionHandoffPhase[]>
> = {
  prepared: ['reviewed', 'cancelled', 'blocked'],
  reviewed: ['cutover', 'cancelled', 'blocked'],
  cutover: [],
  cancelled: [],
  blocked: ['prepared', 'reviewed', 'cancelled'],
};

/** cutover 一次性转移的责任闭集（IC-09 `HandoffResponsibility`）。 */
export const HANDOFF_RESPONSIBILITIES = [
  'execution_coordination_lease',
  'pending_interactions',
  'worker_lifecycle_events',
] as const;

export type HandoffResponsibility = (typeof HANDOFF_RESPONSIBILITIES)[number];

/**
 * Execution Coordination 责任转移的记录（IC-09 `ExecutionHandoffState`）。
 *
 * 它与 `PlanningHandoffRecord` 分属执行、规划两种转移，禁止合并、也禁止互相复用 revision：
 * `handoffRevision` 是提案级 CAS 计数，与 Scope revision 分离，避免交接提交强迫 Scope 全局串行。
 * Run、Task、Dispatch、Attempt、Worker、worktree、图、授权与预算身份都不在这里——它们保持原样。
 */
export type ExecutionHandoffRecord = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly handoffId: string;
  readonly sourceSessionId: CoordinatorSessionId;
  readonly targetSessionId: CoordinatorSessionId;
  readonly graphGeneration: GraphGeneration;
  readonly responsibilitySet: readonly HandoffResponsibility[];
  readonly phase: ExecutionHandoffPhase;
  /**
   * 该提案写下之后生效的执行态 revision，也就是那次写入提交后的 `scope.revision`。
   *
   * 两条写入路径（`record-execution-handoff` 与 `advance-execution-handoff`）都把它同步为同一次
   * 写入后的 revision，因此不变量是「它恒等于该记录最后一次写入之后的 `scope.revision`」。
   * cutover 要求它仍等于当时的 `scope.revision`：基础 CAS 只保证「调用方读到的 revision 没过期」，
   * 这一条才拦住 review 与 cutover 之间的任何写入。它不是提案级 CAS——那是 `handoffRevision`。
   */
  readonly expectedRevision: Revision;
  readonly coordinatorContextCapsuleRef: string | null;
  readonly handoffRevision: Revision;
  readonly blockingReason: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
};

/**
 * 一条 accepted revision 的补丁元数据（IC-10 Extend）。
 *
 * 它记录「这次补丁做了什么」，不复制图体（图体在 `GraphVersionRecord` 里）：新增/重定义/退休的
 * WorkPackageId、后代处置与责任接管关系。`patchId` 是幂等键：同一 `(graphId, patchId)` 只允许一条
 * 记录，因此重放不会写出第二份图。
 */
export type GraphPatchRecord = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly graphId: GraphId;
  readonly graphVersion: GraphVersion;
  readonly patchId: string;
  readonly operationId: OperationId;
  readonly baseGraphVersion: GraphVersion;
  readonly added: readonly WorkPackageId[];
  readonly revised: readonly WorkPackageId[];
  readonly retired: readonly WorkPackageId[];
  readonly descendants: readonly PatchDescendantDisposition[];
  readonly takesOver: readonly PatchResponsibilityTakeover[];
};

/** 提交一次 accepted revision 时随图一起写入的补丁元数据（写入前还没有 graphVersion）。 */
export type GraphVersionPatchInput = Omit<GraphPatchRecord, 'coordinationScopeId' | 'graphId' | 'graphVersion'> & {
  /** 应用后必须进入 revision pending 的 Work Package；与图版本在同一事务内写为持有。 */
  readonly revisionPendingWorkPackageIds: readonly WorkPackageId[];
};

/**
 * 一次与追加同事务完成的预算扣减。
 *
 * 修订额度（Graph Revision / Specification Revision）的「读—改—写」因此是原子的：不会出现图已经变了、
 * 额度却没扣，或额度扣了、图没变的中间态。计数单调递增，任何更小的值都无法把已消耗量调回去。
 */
export type BudgetConsumptionInput = {
  readonly budgetKey: string;
  readonly approvedLimitRef: string;
  readonly amount: number;
};

/**
 * Graph Generation 的状态闭集与迁移。
 *
 * 词汇的 owner 是领域层（`domain/execution/replanning.ts`）；这里只把它并入 store 的读取投影，
 * 避免出现第二份状态取值。
 */
export { GRAPH_GENERATION_STATUSES, GRAPH_GENERATION_TRANSITIONS };
export type { GraphGenerationStatus };

export type GraphGenerationRecord = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly graphId: GraphId;
  readonly generation: GraphGeneration;
  readonly planningCycleId: PlanningCycleId;
  readonly orcaRunId: string;
  readonly predecessorGraphId: GraphId | null;
  readonly baselineHead: string;
  readonly status: GraphGenerationStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
};

/**
 * revision pending 持有的来源闭集（IC-10 Extend）。
 *
 * 持有是调度事实，不是 Worker 取消：当前 Worker 仍运行至可核验终态，只是其后不再派发角色或依赖工作。
 */
export const REVISION_HOLD_SOURCES = ['graph_patch', 'specification_revision', 'retirement'] as const;

export type RevisionHoldSource = (typeof REVISION_HOLD_SOURCES)[number];

export const REVISION_HOLD_STATES = ['pending', 'released'] as const;

export type RevisionHoldState = (typeof REVISION_HOLD_STATES)[number];

export type RevisionHoldRecord = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly workPackageId: WorkPackageId;
  readonly source: RevisionHoldSource;
  /** 触发这次持有的稳定引用（补丁标识或修订标识）。 */
  readonly sourceRef: string;
  readonly state: RevisionHoldState;
  /**
   * 本次修订替换掉的契约内容版本；`null` 表示还没有记录版本边界（尚未准备，或旧行）。
   *
   * 没有既有 Specification Unit 的节点记 0：它与任何被接纳的内容版本都不同，因此「版本确实变了」仍可判定。
   */
  readonly priorContractRevision: number | null;
  /** 重新准入时接纳的契约内容版本；`null` 表示尚未结算。它是该节点当前有效角色结果的版本边界。 */
  readonly admittedContractRevision: number | null;
  readonly createdAt: number;
  readonly releasedAt: number | null;
  readonly releaseReason: string | null;
};

/**
 * Baseline Reconciliation 的状态闭集（IC-10 Extend）。
 *
 * `required` 表示基线落后、必须由独立 Planner-profile 任务核验；`verified` 只能在祖先关系、目标
 * HEAD、dirty paths 与 scope 全部核验通过后写入；`blocked` 表示核验失败并给出阻塞引用。
 */
export const BASELINE_RECONCILIATION_STATES = ['required', 'verified', 'blocked'] as const;

export type BaselineReconciliationState = (typeof BASELINE_RECONCILIATION_STATES)[number];

export type BaselineReconciliationRecord = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly reconciliationId: string;
  readonly workPackageId: WorkPackageId;
  /** 该任务的角色；Baseline Reconciliation 固定为 Planner-profile。 */
  readonly role: 'planner';
  readonly requiredBaselineHead: string;
  readonly orcaTaskId: string | null;
  readonly dispatchId: DispatchId | null;
  readonly observedHead: string | null;
  readonly ancestryVerified: boolean;
  readonly targetHeadVerified: boolean;
  readonly dirtyPathsReconciled: boolean;
  readonly scopeReconciled: boolean;
  readonly state: BaselineReconciliationState;
  readonly blockerRef: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
};

/** 一条被 lineage 继承的已消耗额度；形状与领域层的 `InheritedBudgetUse` 相同，只有一个事实源。 */
export type InheritedBudgetEntry = InheritedBudgetUse;

/**
 * Work Package Lineage（IC-10 Extend）。
 *
 * 一个 Work Package 至多一条：当它明确延续一个未完成的旧责任时，旧责任已消耗的实现、修复、Graph
 * Revision 与 Specification Revision 额度在这里被显式继承，而不是被重置为新值。
 */
export type WorkPackageLineageRecord = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly workPackageId: WorkPackageId;
  readonly priorWorkPackageId: WorkPackageId;
  readonly priorGraphId: GraphId;
  readonly inherited: readonly InheritedBudgetEntry[];
  readonly recordedAt: number;
};

/** 旧成果进入新规划的三种采用方式（IC-10 Extend）；`planning_reference` 只作为规划输入。 */
export const BASELINE_ADOPTION_KINDS = ['baseline_adoption', 'migration_material', 'planning_reference'] as const;

export type BaselineAdoptionKind = (typeof BASELINE_ADOPTION_KINDS)[number];

export const BASELINE_ADOPTION_STATES = ['recorded', 'blocked'] as const;

export type BaselineAdoptionState = (typeof BASELINE_ADOPTION_STATES)[number];

export type BaselineAdoptionRecord = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly adoptionId: string;
  readonly workPackageId: WorkPackageId;
  readonly kind: BaselineAdoptionKind;
  /** 被引用的旧代际 Accepted Worker Result 引用；正文留在 Orca。 */
  readonly adoptedResultRef: string;
  readonly baselineHead: string;
  /** 集成状态引用；未集成时为 `null`。 */
  readonly integrationRef: string | null;
  readonly evidenceRefs: readonly string[];
  readonly state: BaselineAdoptionState;
  readonly blockingReason: string | null;
  readonly recordedAt: number;
};

/** `status` 与启动对账用的单次只读投影；不触发续约、对账或任何写入。 */
export type WorkPackageLaneReservation = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly graphId: GraphId;
  readonly generation: GraphGeneration;
  readonly workPackageId: WorkPackageId;
  readonly operationId: OperationId;
  readonly authorizationId: string;
  readonly authorizationVersion: number;
  readonly baselineHead: string;
  readonly reservedAt: number;
  readonly releasedAt: number | null;
};

export type CoordinationSnapshot = {
  readonly laneReservations: readonly WorkPackageLaneReservation[];
  readonly scope: ScopeRecord;
  readonly sessions: readonly CoordinatorSessionRegistration[];
  readonly leases: readonly LeaseRecord[];
  readonly executionLease: LeaseRecord | null;
  readonly ticketClaims: readonly TicketClaimRecord[];
  readonly pendingInteractions: readonly PendingInteractionRecord[];
  readonly unresolvedIntents: readonly OperationIntent[];
  /** 当前 Scope 已确定接受的 Git 步骤；完整集成还需匹配当前世代的 push 身份。 */
  readonly settledGitIntegrationIntents: readonly OperationIntent[];
  readonly planningHandoffs: readonly PlanningHandoffRecord[];
  readonly planningResponsibility: PlanningResponsibilityRecord | null;
  readonly sessionSegments: readonly SessionSegmentRecord[];
  readonly materializationBindings: readonly MaterializationBindingRecord[];
  readonly deliverySettlements: readonly DeliverySettlementRecord[];
  readonly deliveryVerdicts: readonly DeliveryVerdictRecord[];
  readonly recoveries: readonly RecoveryRecord[];
  readonly executionHandoffs: readonly ExecutionHandoffRecord[];
  readonly graphGenerations: readonly GraphGenerationRecord[];
  readonly revisionHolds: readonly RevisionHoldRecord[];
  readonly baselineReconciliations: readonly BaselineReconciliationRecord[];
  readonly workPackageLineages: readonly WorkPackageLineageRecord[];
  readonly baselineAdoptions: readonly BaselineAdoptionRecord[];
  /** 由未决 intent 派生的 lane 阻塞投影：阻塞对用户与 Coordinator Agent 可观测。 */
  readonly mutationLanes: readonly MutationLaneRecord[];
};

/** 展示读取与完整业务读取具有不同类型，分页不会改变业务准入事实。 */
export type CoordinationPresentationSnapshot = Omit<CoordinationSnapshot, 'pendingInteractions'> & {
  readonly interactionOverview: InteractionOverview;
};
export type CoordinationReadSnapshot = CoordinationSnapshot | CoordinationPresentationSnapshot;
export function openInteractionCount(snapshot: CoordinationReadSnapshot): number {
  return 'interactionOverview' in snapshot ? snapshot.interactionOverview.openCount
    : snapshot.pendingInteractions.filter(item => item.state === 'open').length;
}

/**
 * 图版本目录的 keyset 游标（IC-03 Extend / IC-11；schema 17）。
 *
 * 排序键是 `(generation, graphId, version)` 倒序，因此同代际内先按 GraphId 再按版本稳定排列，翻页
 * 不依赖 offset：追加新版本只影响它自己那一页，已翻过的页不会因为前面多了行而重复或漏项。
 */
export type GraphVersionIndexCursor = {
  readonly generation: number;
  readonly graphId: string;
  readonly version: number;
};

/**
 * 图版本元数据：目录、成员校验与历史详情共用的**唯一**轻量形状。
 *
 * 刻意不含 `graph`（拓扑正文）。历史目录要跨全部代际列出，若每项都带上编译结果，读一页就等于把
 * 整个 Scope 的图历史反序列化一遍；拓扑按选中的那一条精确读取（`graph-version` / `graph-head`）。
 */
export type GraphVersionMetadata = {
  readonly graphId: GraphId;
  readonly generation: GraphGeneration;
  readonly version: GraphVersion;
  readonly recordKind: GraphVersionRecordKind;
  readonly parentVersion: GraphVersion | null;
  readonly patchId: string | null;
  readonly mapRevision: Revision;
  readonly planRevision: Revision;
  readonly orcaRunId: string;
  readonly recordedAt: number;
  /**
   * 该版本所属代际的真实状态。
   *
   * `null` 表示这个代际没有登记状态行——此时按「未记录」呈现，不拿 Scope 指针或版本新旧推断成
   * `frozen`：同代际内的旧版本既不是「当前」也不因此就是冻结的。
   */
  readonly generationStatus: GraphGenerationStatus | null;
  /** 是否是 Scope 当前图指针所指 GraphId 的 head。历史图不因代际状态而冒充当前图。 */
  readonly current: boolean;
};

/**
 * 依据正文的可读来源（IC-11；schema 17）。
 *
 * 只包含本库拥有的不可变记录：编译计划、补丁、批准 Manifest。原生规格文件与 tracker 正文属于
 * 外部权威源，由各自的 adapter 读取，不在这里伪装成可读字段。
 *
 * 三个 variant 都以**精确身份**定位，没有 `latest` 之类的相对引用——记录一旦写入不再改写，因此
 * 同一身份的内容永不变化，续读不会因为 Scope 又追加了版本而变成 stale。
 */
export type GraphBasisSourceRef =
  | {
      readonly kind: 'initial_plan';
      readonly graphId: GraphId;
      readonly generation: GraphGeneration;
      readonly version: GraphVersion;
    }
  | {
      readonly kind: 'graph_patch';
      readonly graphId: GraphId;
      readonly generation: GraphGeneration;
      readonly version: GraphVersion;
    }
  | {
      readonly kind: 'authorization';
      readonly authorizationId: string;
      readonly authorizationVersion: number;
    };

/** 保留派发记录的 keyset 游标；与写入顺序一致，且 `orcaTaskId` 在同一 `createdAt` 内唯一。 */
export type GraphBasisBindingCursor = {
  readonly createdAt: number;
  readonly orcaTaskId: string;
};

/**
 * 批准授权的目录项（IC-03 Extend；IC-11）。
 *
 * `graphVersion` 是**批准时刻**的图版本，不是所选历史版本的状态：一条授权只证明「它当时批准的是图的
 * 哪一版」。把两者混为一谈会让重规划后的旧授权看起来像是给新版本签过字。
 */
export type GraphAuthorizationRef = {
  readonly authorizationId: string;
  readonly authorizationVersion: number;
  readonly graphVersion: GraphVersion;
};

export type GraphAuthorizationCursor = {
  readonly authorizationId: string;
  readonly authorizationVersion: number;
};

export type CoordinationQuery =
  | { readonly kind: 'work-package-lanes'; readonly coordinationScopeId: CoordinationScopeId }
  | { readonly kind: 'integration-reconciliations'; readonly coordinationScopeId: CoordinationScopeId; readonly workPackageId: WorkPackageId }
  | { readonly kind: 'pending-interaction'; readonly coordinationScopeId: CoordinationScopeId; readonly interactionId: InteractionId; readonly coordinatorSessionId?: CoordinatorSessionId }
  | { readonly kind: 'pending-interactions'; readonly coordinationScopeId: CoordinationScopeId; readonly coordinatorSessionId?: CoordinatorSessionId; readonly after?: InteractionPageCursor }
  | { readonly kind: 'interaction-summaries'; readonly coordinationScopeId: CoordinationScopeId; readonly coordinatorSessionId: CoordinatorSessionId; readonly interactionIds: readonly InteractionId[] }
  | { readonly kind: 'pending-interaction-identities'; readonly coordinationScopeId: CoordinationScopeId }
  | { readonly kind: 'interaction-body'; readonly coordinationScopeId: CoordinationScopeId; readonly coordinatorSessionId: CoordinatorSessionId; readonly interactionId: InteractionId; readonly part: 'question' | 'answer'; readonly contentRevision: string; readonly offset: number; readonly maxBytes: number }
  | { readonly kind: 'scopes' }
  | { readonly kind: 'scope'; readonly coordinationScopeId: CoordinationScopeId }
  | { readonly kind: 'project-detail-session'; readonly coordinationScopeId: CoordinationScopeId; readonly coordinatorSessionId: CoordinatorSessionId }
  | { readonly kind: 'project-detail-json-field'; readonly coordinationScopeId: CoordinationScopeId; readonly source: 'budget' | 'work'; readonly sourceId: string; readonly sourceVersion: number; readonly workPackageId?: WorkPackageId; readonly fieldIndex: number; readonly offset: number; readonly maxBytes: number }
  | { readonly kind: 'snapshot'; readonly coordinationScopeId: CoordinationScopeId }
  | { readonly kind: 'presentation-snapshot'; readonly coordinationScopeId: CoordinationScopeId; readonly coordinatorSessionId?: CoordinatorSessionId }
  | { readonly kind: 'sessions'; readonly coordinationScopeId: CoordinationScopeId }
  | { readonly kind: 'leases'; readonly coordinationScopeId: CoordinationScopeId }
  | {
      readonly kind: 'intents';
      readonly coordinationScopeId: CoordinationScopeId;
      readonly intentState?: IntentState;
    }
  | { readonly kind: 'intent'; readonly coordinationScopeId: CoordinationScopeId; readonly operationId: OperationId }
  | { readonly kind: 'budget-counters'; readonly coordinationScopeId: CoordinationScopeId; readonly approvedLimitRef?: string }
  | {
      readonly kind: 'validation-step-admission';
      readonly coordinationScopeId: CoordinationScopeId;
      readonly stepId: string;
    }
  | {
      readonly kind: 'validation-attempt';
      readonly coordinationScopeId: CoordinationScopeId;
      readonly dispatchId: DispatchId;
    }
  | {
      readonly kind: 'wake-admissions';
      readonly coordinationScopeId: CoordinationScopeId;
      readonly coordinatorSessionId?: CoordinatorSessionId;
    }
  | {
      readonly kind: 'graph-versions';
      readonly coordinationScopeId: CoordinationScopeId;
      readonly graphId: GraphId;
    }
  | {
      readonly kind: 'graph-version';
      readonly coordinationScopeId: CoordinationScopeId;
      readonly graphId: GraphId;
      readonly graphVersion: GraphVersion;
    }
  /**
   * 跨全部代际的图版本目录（IC-03 Extend；schema 17）。每页最多 20 项，只读元数据。
   *
   * 代际不是过滤条件而是排序维度：历史目录必须能看到冻结代际，但「当前」只由 Scope 指针判定，
   * 因此 `current` 逐项计算而不是用 `generationStatus` 反推。
   */
  | {
      readonly kind: 'graph-version-index';
      readonly coordinationScopeId: CoordinationScopeId;
      readonly after?: GraphVersionIndexCursor;
    }
  /** 指定 GraphId 的 head（当前接受拓扑），只读这一条的完整图体。 */
  | {
      readonly kind: 'graph-head';
      readonly coordinationScopeId: CoordinationScopeId;
      readonly graphId: GraphId;
    }
  /**
   * 追加链成员校验（IC-03 Extend；schema 17）。
   *
   * 回答「这些版本是否都还在这条图的追加链上」，只沿 `parent_version` 递归走元数据列，不加载任何
   * `graph_json`。链上出现缺口（版本缺失或 `parentVersion` 与前一条对不上）即拒绝，不返回部分结果。
   */
  | {
      readonly kind: 'graph-version-membership';
      readonly coordinationScopeId: CoordinationScopeId;
      readonly graphId: GraphId;
      /** 调用方读到的 head；与实际 head 不一致即拒绝，避免用过期 head 判定成员。 */
      readonly head: GraphVersion;
      readonly versions: readonly GraphVersion[];
    }
  /** 依据正文的 UTF-8 字节范围读取，每次至多 64 KiB。 */
  | {
      readonly kind: 'graph-basis-range';
      readonly coordinationScopeId: CoordinationScopeId;
      readonly source: GraphBasisSourceRef;
      readonly offset: number;
      readonly maxBytes: number;
    }
  /**
   * 单个 Work Package 的保留派发记录（IC-03 Extend；schema 17）。
   *
   * 按 package 精确分页，每页最多 20 条。历史详情要展示原 Task/Dispatch/Attempt、原授权与规格绑定，
   * 但这些是 **Work Package 级**保留记录，不是所选图版本的事实——按包分页才能避免为了看一个节点
   * 而全读 Scope 的物化绑定。
   */
  | {
      readonly kind: 'graph-basis-bindings';
      readonly coordinationScopeId: CoordinationScopeId;
      readonly workPackageId: WorkPackageId;
      readonly after?: GraphBasisBindingCursor;
    }
  /**
   * 精确读取一条保留派发记录（IC-03 Extend；schema 17）。
   *
   * 目录页只给出 20 条身份，要展开其中某一条的授权/规格正文时按 `(workPackageId, orcaTaskId)` 精确取，
   * 不为一条记录重读整页，更不退化成 Scope 全量 snapshot。
   */
  | {
      readonly kind: 'graph-basis-binding';
      readonly coordinationScopeId: CoordinationScopeId;
      readonly workPackageId: WorkPackageId;
      readonly orcaTaskId: string;
    }
  /**
   * 某个图（`graphId` + 代际）的批准授权目录（IC-03 Extend；schema 17）。每页最多 20 项，只读元数据。
   *
   * Work Package 的保留派发记录能带出它当年的原授权，但**没有工作包的图版本**（如纯候选代际）因此拿不到
   * 任何批准依据。这一项补上这条路径：按 manifest 里的图指针把该图的历次批准列出来，正文再按
   * `(authorizationId, authorizationVersion)` 精确范围读取。
   */
  | {
      readonly kind: 'graph-basis-authorizations';
      readonly coordinationScopeId: CoordinationScopeId;
      readonly graphId: GraphId;
      readonly generation: GraphGeneration;
      readonly after?: GraphAuthorizationCursor;
    }
  | { readonly kind: 'authorizations'; readonly coordinationScopeId: CoordinationScopeId }
  | {
      readonly kind: 'authorization';
      readonly coordinationScopeId: CoordinationScopeId;
      readonly authorizationId: string;
    }
  | { readonly kind: 'planning-handoffs'; readonly coordinationScopeId: CoordinationScopeId }
  | {
      readonly kind: 'planning-handoff';
      readonly coordinationScopeId: CoordinationScopeId;
      readonly proposalId: string;
    }
  | { readonly kind: 'planning-responsibility'; readonly coordinationScopeId: CoordinationScopeId }
  | {
      readonly kind: 'session-segments';
      readonly coordinationScopeId: CoordinationScopeId;
      readonly workPackageId?: WorkPackageId;
    }
  | {
      readonly kind: 'materialization-bindings';
      readonly coordinationScopeId: CoordinationScopeId;
      readonly workPackageId?: WorkPackageId;
    }
  | {
      readonly kind: 'delivery-settlements';
      readonly coordinationScopeId: CoordinationScopeId;
      /** 给出去重键时只返回该条；否则返回该 Scope 的全部结算记录。 */
      readonly dedupeKey?: string;
      /** 项目详情按 Work Package 的物化 WorkerTask 精确投影结算。 */
      readonly workPackageId?: WorkPackageId;
    }
  | { readonly kind: 'delivery-verdicts'; readonly coordinationScopeId: CoordinationScopeId }
  | {
      readonly kind: 'recoveries';
      readonly coordinationScopeId: CoordinationScopeId;
      /** 给定时只返回该 Worker Attempt 的 Recovery，用于按 attempt 求和的预算读取。 */
      readonly businessAttemptId?: string;
    }
  | { readonly kind: 'recovery'; readonly coordinationScopeId: CoordinationScopeId; readonly recoveryId: RecoveryId }
  | { readonly kind: 'execution-handoffs'; readonly coordinationScopeId: CoordinationScopeId }
  | {
      readonly kind: 'execution-handoff';
      readonly coordinationScopeId: CoordinationScopeId;
      readonly handoffId: string;
    }
  | { readonly kind: 'graph-generations'; readonly coordinationScopeId: CoordinationScopeId }
  | {
      readonly kind: 'graph-generation';
      readonly coordinationScopeId: CoordinationScopeId;
      readonly graphId: GraphId;
    }
  | {
      readonly kind: 'graph-patch-record';
      readonly coordinationScopeId: CoordinationScopeId;
      readonly graphId: GraphId;
      readonly graphVersion: GraphVersion;
    }
  | {
      readonly kind: 'revision-holds';
      readonly coordinationScopeId: CoordinationScopeId;
      readonly workPackageId?: WorkPackageId;
    }
  | {
      readonly kind: 'baseline-reconciliations';
      readonly coordinationScopeId: CoordinationScopeId;
      readonly workPackageId?: WorkPackageId;
    }
  | {
      readonly kind: 'work-package-lineages';
      readonly coordinationScopeId: CoordinationScopeId;
      readonly workPackageId?: WorkPackageId;
    }
  | {
      readonly kind: 'baseline-adoptions';
      readonly coordinationScopeId: CoordinationScopeId;
      readonly workPackageId?: WorkPackageId;
    };

export type CoordinationQueryRejectionCode = 'unreadable' | 'invalid_query' | 'invalid_utf8_offset';

/**
 * 结果与查询同判别：调用方只需 narrowing 一次，不需要对 `value` 做类型断言。
 * `*| null` 表示「记录确实不存在」，与拒绝区分开。
 */
export type CoordinationQueryResult =
  | { readonly kind: 'work-package-lanes'; readonly reservations: readonly WorkPackageLaneReservation[] }
  | { readonly kind: 'integration-reconciliations'; readonly records: readonly IntegrationReconciliationRecord[] }
  | { readonly kind: 'pending-interaction'; readonly interaction: PendingInteractionDetail | null }
  | { readonly kind: 'pending-interactions'; readonly interactions: readonly InteractionSummary[]; readonly nextCursor: InteractionPageCursor | null }
  | { readonly kind: 'interaction-summaries'; readonly interactions: readonly InteractionSummary[] }
  | { readonly kind: 'pending-interaction-identities'; readonly interactions: readonly InteractionIdentity[] }
  | { readonly kind: 'interaction-body'; readonly body: { readonly text: string; readonly offset: number; readonly end: number; readonly byteLength: number } | null }
  | { readonly kind: 'scopes'; readonly scopes: readonly ScopeRecord[] }
  | { readonly kind: 'scope'; readonly scope: ScopeRecord | null }
  | { readonly kind: 'project-detail-session'; readonly registration: CoordinatorSessionRegistration | null; readonly activeClaim: TicketClaimRecord | null; readonly executionLease: LeaseRecord | null }
  | { readonly kind: 'project-detail-json-field'; readonly sourceFound: boolean; readonly objectFound: boolean; readonly field: { readonly key: string; readonly label: string; readonly value: string; readonly offset: number; readonly end: number; readonly byteLength: number } | null; readonly hasNext: boolean }
  | { readonly kind: 'snapshot'; readonly snapshot: CoordinationSnapshot }
  | { readonly kind: 'presentation-snapshot'; readonly snapshot: CoordinationPresentationSnapshot }
  | { readonly kind: 'sessions'; readonly sessions: readonly CoordinatorSessionRegistration[] }
  | { readonly kind: 'leases'; readonly leases: readonly LeaseRecord[] }
  | { readonly kind: 'intents'; readonly intents: readonly OperationIntent[] }
  | { readonly kind: 'intent'; readonly intent: OperationIntent | null }
  | { readonly kind: 'budget-counters'; readonly counters: readonly BudgetCounterRecord[] }
  | {
      readonly kind: 'validation-step-admission';
      readonly admission: ValidationStepAdmissionRecord | null;
    }
  | {
      readonly kind: 'validation-attempt';
      readonly attempt: ValidationAttemptRecord | null;
    }
  | { readonly kind: 'wake-admissions'; readonly admissions: readonly WakeAdmissionRecord[] }
  | { readonly kind: 'graph-versions'; readonly versions: readonly GraphVersionRecord[] }
  | { readonly kind: 'graph-version'; readonly version: GraphVersionRecord | null }
  | {
      readonly kind: 'graph-version-index';
      readonly items: readonly GraphVersionMetadata[];
      readonly nextCursor: GraphVersionIndexCursor | null;
    }
  | { readonly kind: 'graph-head'; readonly version: GraphVersionRecord | null }
  | { readonly kind: 'graph-version-membership'; readonly members: readonly GraphVersionMetadata[] }
  /**
   * `found: false` 表示这条依据正文不可读：记录不存在，或旧行从未保留正文（schema 17 之前没有这项
   * 事实）。两种情况都按缺失呈现，调用方不得据此推断「内容为空」。
   */
  | {
      readonly kind: 'graph-basis-range';
      readonly found: boolean;
      readonly text: string | null;
      readonly byteLength: number;
      readonly end: number;
    }
  | {
      readonly kind: 'graph-basis-bindings';
      readonly bindings: readonly MaterializationBindingRecord[];
      readonly nextCursor: GraphBasisBindingCursor | null;
    }
  | { readonly kind: 'graph-basis-binding'; readonly binding: MaterializationBindingRecord | null }
  | {
      readonly kind: 'graph-basis-authorizations';
      readonly items: readonly GraphAuthorizationRef[];
      readonly nextCursor: GraphAuthorizationCursor | null;
    }
  | { readonly kind: 'authorizations'; readonly authorizations: readonly ExecutionAuthorizationRecord[] }
  | { readonly kind: 'authorization'; readonly authorization: ExecutionAuthorizationRecord | null }
  | { readonly kind: 'planning-handoffs'; readonly handoffs: readonly PlanningHandoffRecord[] }
  | { readonly kind: 'planning-handoff'; readonly handoff: PlanningHandoffRecord | null }
  | { readonly kind: 'planning-responsibility'; readonly responsibility: PlanningResponsibilityRecord | null }
  | { readonly kind: 'session-segments'; readonly segments: readonly SessionSegmentRecord[] }
  | { readonly kind: 'materialization-bindings'; readonly bindings: readonly MaterializationBindingRecord[] }
  | { readonly kind: 'delivery-settlements'; readonly settlements: readonly DeliverySettlementRecord[] }
  | { readonly kind: 'delivery-verdicts'; readonly verdicts: readonly DeliveryVerdictRecord[] }
  | { readonly kind: 'recoveries'; readonly recoveries: readonly RecoveryRecord[] }
  | { readonly kind: 'recovery'; readonly recovery: RecoveryRecord | null }
  | { readonly kind: 'execution-handoffs'; readonly handoffs: readonly ExecutionHandoffRecord[] }
  | { readonly kind: 'execution-handoff'; readonly handoff: ExecutionHandoffRecord | null }
  | { readonly kind: 'graph-generations'; readonly generations: readonly GraphGenerationRecord[] }
  | { readonly kind: 'graph-generation'; readonly generation: GraphGenerationRecord | null }
  | { readonly kind: 'graph-patch-record'; readonly record: GraphPatchRecord | null }
  | { readonly kind: 'revision-holds'; readonly holds: readonly RevisionHoldRecord[] }
  | {
      readonly kind: 'baseline-reconciliations';
      readonly reconciliations: readonly BaselineReconciliationRecord[];
    }
  | { readonly kind: 'work-package-lineages'; readonly lineages: readonly WorkPackageLineageRecord[] }
  | { readonly kind: 'baseline-adoptions'; readonly adoptions: readonly BaselineAdoptionRecord[] }
  | {
      readonly kind: 'rejected';
      readonly code: CoordinationQueryRejectionCode;
      readonly message: string;
    };

export type CoordinationWriter = {
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly runtimeIncarnationId: RuntimeIncarnationId;
  readonly fencingGeneration: number;
};

/** IC-03 固定的写入前导：scope、expected revision 与可信写入者。 */
export type CoordinationCommandBase = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly expectedRevision: Revision;
  readonly writer: CoordinationWriter;
};

export type CoordinationCommand =
  | (RegisterIntegrationReconciliationInput & { readonly kind: 'register-integration-reconciliation' })
  | (SettleIntegrationReconciliationInput & { readonly kind: 'settle-integration-reconciliation' })
  | (BindIntegrationContinuationInput & { readonly kind: 'bind-integration-continuation' })
  | (CoordinationCommandBase & {
      readonly kind: 'reserve-work-package-lane';
      readonly graphId: GraphId;
      readonly generation: GraphGeneration;
      readonly workPackageId: WorkPackageId;
      readonly operationId: OperationId;
      readonly authorizationId: string;
      readonly authorizationVersion: number;
      readonly baselineHead: string;
    })
  | (CoordinationCommandBase & {
      readonly kind: 'release-work-package-lane';
      readonly graphId: GraphId;
      readonly generation: GraphGeneration;
      readonly workPackageId: WorkPackageId;
      /** 已接受 push、已确认停止或确定未发生副作用的意图；不能由模型填写。 */
      readonly proofOperationId: OperationId;
    })
  | (CoordinationCommandBase & {
      readonly kind: 'create-scope';
      readonly mode: CoordinationMode;
      readonly controlState: ControlState;
      readonly planningCycleId: PlanningCycleId | null;
      /** 新 Scope 必须带上用户登记的完整 branch ref 与 canonical worktree。 */
      readonly fullBranchRef: string;
      readonly canonicalWorktreePath: string;
    })
  | (CoordinationCommandBase & {
      readonly kind: 'update-scope-mode';
      readonly mode: CoordinationMode;
      readonly planningCycleId: PlanningCycleId | null;
    })
  | (CoordinationCommandBase & {
      readonly kind: 'update-scope-refs';
      readonly graphId: GraphId | null;
      readonly graphVersion: GraphVersion | null;
      readonly authorizationId: StableId | null;
      readonly authorizationVersion: Revision | null;
    })
  | (CoordinationCommandBase & {
      readonly kind: 'record-control-state';
      readonly controlState: ControlState;
    })
  | (CoordinationCommandBase & {
      readonly kind: 'register-session';
      readonly coordinatorSessionId: CoordinatorSessionId;
      readonly coordinatorModelConfigurationRef: string;
      readonly lifecycleState: SessionLifecycleState;
    })
  | (CoordinationCommandBase & {
      readonly kind: 'update-session-model-configuration';
      readonly coordinatorSessionId: CoordinatorSessionId;
      /** 目标配置引用；必须已由调用方用项目配置核验过存在与可用。 */
      readonly coordinatorModelConfigurationRef: string;
    })
  | (CoordinationCommandBase & {
      /**
       * 持久推进一个 Session 的生命周期状态。
       *
       * `blocked` 必须携带结构化 `blockingReason`（非空 `code` 与 `message`）；其它状态必须省略原因，
       * 写入即清除既有阻塞事实。启动流程绝不自动解除阻塞：恢复必须先重新核验原因。
       */
      readonly kind: 'update-session-lifecycle';
      readonly coordinatorSessionId: CoordinatorSessionId;
      readonly lifecycleState: SessionLifecycleState;
      readonly blockingReason?: SessionBlockingReason | null;
    })
  | (CoordinationCommandBase & { readonly kind: 'record-ticket-claim'; readonly ticketRef: EntityRef<string> })
  | (CoordinationCommandBase & {
      readonly kind: 'release-ticket-claim';
      readonly ticketRef: EntityRef<string>;
      readonly finalState: Exclude<TicketClaimState, 'active'>;
    })
  | (CoordinationCommandBase & {
      readonly kind: 'record-pending-interaction';
      readonly interactionId: InteractionId;
      readonly ownerCoordinatorSessionId: CoordinatorSessionId;
      readonly subjectRef: EntityRef<string>;
      readonly question?: UserQuestion;
    })
  | (CoordinationCommandBase & {
      readonly kind: 'resolve-pending-interaction';
      readonly interactionId: InteractionId;
      readonly state: Exclude<PendingInteractionState, 'open'>;
      readonly answerRef: EntityRef<string> | null;
      /** 受控回答正文；与状态在同一事务写入，普通 Session 消息不经过这里。 */
      readonly answerText: string | null;
    })
  | (CoordinationCommandBase & {
      readonly kind: 'begin-intent';
      readonly operationId: OperationId;
      readonly target: EntityRef<string>;
      readonly operationCategory: string;
      readonly expectedHead?: string;
    })
  | (CoordinationCommandBase & {
      readonly kind: 'settle-intent';
      readonly operationId: OperationId;
      readonly outcomeClass: 'accepted' | 'rejected' | 'unknown';
      readonly backendRequestId?: string;
      /**
       * terminal 创建/准备类意图的精确资源引用。
       *
       * 只在 `operationCategory` 为 `materialize-worker-terminal` / `worker-terminal-prepare` 且
       * `outcomeClass === 'accepted'` 时允许写入；缺失按 null，已写入不可改写（同值幂等、异值拒绝）。
       */
      readonly terminalHandle?: string;
    })
  | (CoordinationCommandBase & {
      readonly kind: 'block-intent';
      readonly operationId: OperationId;
      readonly reason: string;
    })
  | (CoordinationCommandBase & {
      readonly kind: 'resolve-intent';
      readonly operationId: OperationId;
      readonly outcomeClass: 'accepted' | 'rejected';
      readonly backendRequestId?: string;
    })
  | (CoordinationCommandBase & { readonly kind: 'acquire-runtime-lease'; readonly ttlMs: number })
  | (CoordinationCommandBase & { readonly kind: 'renew-runtime-lease'; readonly ttlMs: number })
  | (CoordinationCommandBase & { readonly kind: 'acquire-execution-lease' })
  | (CoordinationCommandBase & { readonly kind: 'release-execution-lease' })
  | (CoordinationCommandBase & { readonly kind: 'release-runtime-lease' })
  | (CoordinationCommandBase & {
      readonly kind: 'consume-budget';
      readonly budgetKey: string;
      readonly approvedLimitRef: string;
      readonly amount: number;
    })
  | (CoordinationCommandBase & {
      /**
       * Validator 修复步骤的持久准入：以稳定 `stepId` 记录一次修复步骤，并在同一事务里扣减
       * `validatorRepairs`。
       *
       * 重放同一个 `stepId` 是幂等成功，绝不重复扣减；`approvedLimitRef` 是授权 id，`approvedLimit` 是
       * `min(Work Package 预算, Manifest 上限)`，由调用方从已批准事实读出。越界消费按 `constraint` 拒绝，
       * 因此「修复前扣减」与「可证明没有接纳」是同一个原子事实。
       */
      readonly kind: 'admit-validation-step';
      readonly stepId: string;
      readonly workPackageId: WorkPackageId;
      readonly workerTaskId: WorkerTaskId;
      readonly dispatchId: DispatchId;
      readonly validationAttemptId: string;
      /** 1 基绝对修复序号；只用于核对 stepId 的来源，不参与幂等键。 */
      readonly repairOrdinal: number;
      readonly approvedLimitRef: string;
      readonly approvedLimit: number;
    })
  | (CoordinationCommandBase & {
      /**
       * 写入一条 Validation Attempt 的有界游标。
       *
       * 身份（Task/Dispatch/Attempt/Work Package/固定 provider session）首次写入后不可变；`messageIds` 是
       * 整列覆盖式写入的有序列表，必须保留既有前缀、最多 20 项且无重复；`terminalQuestionMessageId` 只在
       * 拿到 finish/refuse 许可后从 `null` 写一次，之后不可改写。写入者必须是 Execution Coordination Lease
       * 持有者并被 fence，且物化绑定与 Session Segment 必须能证明这条绑定。
       */
      readonly kind: 'record-validation-attempt';
      readonly validationAttemptId: string;
      readonly workPackageId: WorkPackageId;
      readonly workerTaskId: WorkerTaskId;
      readonly dispatchId: DispatchId;
      readonly providerSessionId: string;
      readonly initialRepairConsumed: number;
      readonly messageIds: readonly string[];
      /** 省略表示不改写既有值；给出值只在既有值为 `null` 时被接纳。 */
      readonly terminalQuestionMessageId?: string | null;
    })
  | (CoordinationCommandBase & {
      readonly kind: 'record-wake-admission';
      readonly wakeBatchId: string;
      readonly admissionState: WakeAdmissionState;
      readonly sourceRevisions: readonly SourceRevisionRef[];
    })
  | (CoordinationCommandBase & {
      readonly kind: 'initialize-scope';
      readonly mode: CoordinationMode;
      readonly controlState: ControlState;
      readonly planningCycleId: PlanningCycleId | null;
      readonly coordinatorSessionId: CoordinatorSessionId;
      readonly coordinatorModelConfigurationRef: string;
      readonly fullBranchRef: string;
      readonly canonicalWorktreePath: string;
    })
  | (CoordinationCommandBase & {
      /**
       * 为缺少绑定的既有 Scope 补齐一次不可变注册绑定。
       *
       * 这是**受控一次性**命令：只在当前绑定为空且该 Scope 没有任何 Runtime Lease 行时被接受，
       * 因此它不可能被用来改写已有绑定，也不可能在运行时抢占一个正在被使用的 Scope。它不推进
       * mode、control state 或图引用，只补齐身份。
       */
      readonly kind: 'bind-scope-identity';
      readonly fullBranchRef: string;
      readonly canonicalWorktreePath: string;
    })
  | (CoordinationCommandBase & {
      readonly kind: 'record-graph-version';
      readonly graphId: GraphId;
      readonly generation: GraphGeneration;
      readonly graphVersion: GraphVersion;
      readonly recordKind: GraphVersionRecordKind;
      readonly parentVersion: GraphVersion | null;
      readonly mapRevision: Revision;
      readonly planRevision: Revision;
      readonly orcaRunId: string;
      readonly graph: ExecutionGraph;
      /**
       * `initial` 必须为 `null`；`accepted_revision` 必须给出完整补丁元数据。
       *
       * 元数据与图版本、revision pending 持有在**同一事务**内写入：因此不存在「图已经变了，但没人
       * 记得为什么变、也没人记得该冻结谁」的中间态。
       */
      readonly patch: GraphVersionPatchInput | null;
      /**
       * 归一化后的原 Implementation Plan（IC-03 Extend；schema 17）。
       *
       * `initial` **必填**且必须与 `planRevision` 一致：编译依据与编译结果同事务落盘，之后才能按原样
       * 回读。`accepted_revision` **必须为 `null`**——修订不重写原计划，同图的后续版本要读原计划时
       * 沿 `graphId` 回到 v1 读。
       */
      readonly initialPlan: ImplementationPlan | null;
      /** 与 Graph Revision 同事务登记的独立基线补救需求。 */
      readonly baselineReconciliations?: readonly {
        readonly reconciliationId: string;
        readonly workPackageId: WorkPackageId;
        readonly requiredBaselineHead: string;
      }[];
      /**
       * 与追加同事务完成的预算扣减；省略表示本次追加不消耗预算。
       *
       * 修订额度必须与产生它的那次图变化原子地记账，否则崩溃窗口会留下「图已改、额度未扣」的欠账。
       */
      readonly budgetConsumption?: readonly BudgetConsumptionInput[];
    })
  | (CoordinationCommandBase & {
      readonly kind: 'record-authorization';
      readonly authorizationId: string;
      readonly authorizationVersion: Revision;
      readonly manifestVersion: number;
      readonly fingerprint: string;
      readonly approvalRef: string;
      readonly manifest: ExecutionAuthorizationManifest;
    })
  | (CoordinationCommandBase & {
      readonly kind: 'record-planning-handoff';
      readonly proposalId: string;
      readonly sourceCoordinatorSessionId: CoordinatorSessionId;
      readonly targetCoordinatorSessionId: CoordinatorSessionId;
      readonly phase: PlanningHandoffPhase;
      readonly mapRevision: Revision;
      readonly planRevision: Revision;
      readonly graphId: GraphId | null;
      readonly graphVersion: GraphVersion | null;
      readonly capsuleRef: string | null;
      /** `null` 表示创建提案；否则必须与当前 proposalRevision 精确相等。 */
      readonly expectedProposalRevision: Revision | null;
    })
  | (CoordinationCommandBase & {
      readonly kind: 'transition-to-execution';
      readonly planningCycleId: PlanningCycleId | null;
      readonly graphId: GraphId;
      readonly graphVersion: GraphVersion;
      readonly authorizationId: string;
      readonly authorizationVersion: Revision;
    })
  | (CoordinationCommandBase & {
      readonly kind: 'advance-map-revision';
      /** 新地图 revision；必须恰好是当前值 + 1，不能跳号或回退。 */
      readonly mapRevision: Revision;
    })
  | (CoordinationCommandBase & {
      readonly kind: 'record-session-segment';
      readonly segmentId: SessionSegmentId;
      readonly workPackageId: WorkPackageId;
      readonly role: WorkerRole;
      readonly workerTaskId: WorkerTaskId;
      readonly dispatchId: DispatchId;
      readonly attemptId: string;
      readonly sessionBindingId: string;
      readonly lastTranscriptRef: string | null;
      readonly terminalReceiptRef: string | null;
      readonly transcriptReferenceable: boolean;
      readonly verifiable: boolean;
    })
  | (CoordinationCommandBase & {
      readonly kind: 'record-materialization-binding';
      readonly workPackageId: WorkPackageId;
      /** 四主角色派发；与 `recoveryUtilityRole` 互斥。 */
      readonly role: WorkerRole | null;
      /** Recovery Utility 派发；与 `role` 互斥。 */
      readonly recoveryUtilityRole?: 'recovery_utility';
      readonly workerTaskId: WorkerTaskId;
      /** 逻辑 Task Envelope 的派发身份；不是 Orca `worker-start` 回执里的 dispatch。 */
      readonly dispatchId: DispatchId;
      readonly attemptId: string;
      readonly worktreeId: string;
      /** Implementation/Validator 用已接纳的绑定；Planner 为 `null`。 */
      readonly specBinding: SpecBinding | null;
      /** 必须与角色匹配：Planner 必填固定目标路径，其它角色必须为 `null`。 */
      readonly specificationUnitPath: string | null;
      /** 本次派发固定使用的授权身份与 profile；缺失即拒绝写入，不留下无运行依据的新行。 */
      readonly authorizationId: string;
      readonly authorizationVersion: Revision;
      /** 不透明的 profile 身份；写入时按 `worker-profile` 引用落库。 */
      readonly workerProfileRef: string;
      readonly orcaTaskId: string;
      /** 本次派发使用的 Worker launch 身份；补记 Session Binding 时据此定位报告。 */
      readonly launchId: string;
      readonly creationOperationId: OperationId;
    })
  | (CoordinationCommandBase & {
      readonly kind: 'record-delivery-settlement';
      readonly dedupeKey: string;
      readonly deliveryId: string;
      readonly runId: string;
      readonly consumerGeneration: number;
      readonly workerTaskId: WorkerTaskId;
      readonly dispatchId: DispatchId;
      readonly attemptId: string;
      readonly role: WorkerRole;
      readonly contractRevision: number;
      /** Orca 侧结果引用；本地不保存结果正文。 */
      readonly orcaResultRef: string;
      /** Worker 结果的规范化成败；省略或 `null` 表示本行没有这项结论。 */
      readonly outcome?: DeliverySettlementOutcome | null;
      /** Validator 结论；只有 validator 角色的结算应给出，其它角色省略。 */
      readonly validationVerdict?: DeliveryValidationVerdict | null;
    })
  | (CoordinationCommandBase & {
      readonly kind: 'record-delivery-verdict';
      readonly verdictId: string;
      readonly verdict: DeliveryVerdict;
      readonly finalizerRole: 'finalizer';
      readonly sessionBindingRef: string;
    })
  | (CoordinationCommandBase & {
      /**
       * 创建一次 Recovery；初始状态固定为 `pending`、`consumedBudget` 为 0。
       *
       * `(coordinationScopeId, sourceSegmentId)` 唯一：同一条中断 Segment 重复写入被约束拒绝，
       * 调用方回读既有记录，绝不产生第二行。
       */
      readonly kind: 'record-recovery';
      readonly recoveryId: RecoveryId;
      readonly role: WorkerRole;
      readonly workPackageId: WorkPackageId;
      readonly workerTaskId: WorkerTaskId;
      readonly businessAttemptId: string;
      readonly sourceSegmentId: SessionSegmentId;
      readonly sourceDispatchId: DispatchId;
    })
  | (CoordinationCommandBase & {
      /**
       * 推进 Recovery。身份字段不在命令里，因此结构上不可改写；非法状态迁移在 store 边界拒绝。
       *
       * 可选字段的语义：省略表示保持原值，`null`（仅 `blockingReason`）表示清空，给出值表示覆盖。
       * `consumedBudget` 单调不减（`MAX(已消耗, 传入值)`）：重放同值仍然幂等，任何更小的值都无法
       * 把已消耗的 Recovery Budget 调回去，因此重启、恢复、Patch 与重规划不可能重置额度。
       */
      readonly kind: 'advance-recovery';
      readonly recoveryId: RecoveryId;
      readonly status: RecoveryState;
      readonly replacementDispatchId?: string;
      readonly replacementSegmentId?: SessionSegmentId;
      readonly replacementSessionBindingId?: string;
      readonly supersededSegmentId?: SessionSegmentId;
      readonly capsuleRef?: string;
      readonly prewriteOperationId?: OperationId;
      /** 省略保持原值；给出终态结果时覆盖，`null` 表示清空。 */
      readonly terminalOutcome?: RecoveryTerminalOutcome | null;
      readonly blockingReason?: string | null;
      readonly consumedBudget?: number;
      /**
       * 与本次推进**同事务**写入的替代 Session Segment。
       *
       * 只在 `status === 'recovered'` 时允许，否则整笔按 `invalid_state` 拒绝。给出该载荷时，
       * Recovery 的 `replacementSegmentId` 取 `replacementSegment.segmentId`；两者同时给出必须相等。
       *
       * 幂等策略（重启续办依赖它）：该 `segmentId` 已存在且**全部字段一致**时跳过插入，仍照常推进
       * Recovery —— 否则「Segment 已落盘、Recovery 未收尾」的崩溃窗口重启后永远无法收尾；已存在但
       * 内容不一致时按 `constraint` 拒绝并整笔回滚，不覆盖既有 Segment。已收尾的 Recovery 再收到同
       * 一条命令会因 `RECOVERY_TRANSITIONS` 已无迁移而按 `invalid_state` 拒绝，同样零副作用。
       */
      readonly replacementSegment?: ReplacementSegmentInput;
    })
  | (CoordinationCommandBase & {
      /**
       * 创建或按 CAS 更新 handoff 提案。
       *
       * `expectedHandoffRevision === null` 表示创建（`phase` 必须是 `prepared`）；否则必须与当前
       * `handoffRevision` 精确相等。Source/Target、graphGeneration 与 responsibilitySet 创建后不可更改。
       * 记录中的 `expectedRevision` 由 store 写成该次写入提交后的 Scope revision；cutover 要求它仍等于
       * 当前 `scope.revision`，因此 review 之后的任何写入都会让 cutover 的 CAS 失败。
       *
       * `cutover` 不允许从这里写入：只有 `advance-execution-handoff` 会在同一事务内转移执行责任。
       */
      readonly kind: 'record-execution-handoff';
      readonly handoffId: string;
      readonly sourceSessionId: CoordinatorSessionId;
      readonly targetSessionId: CoordinatorSessionId;
      readonly graphGeneration: GraphGeneration;
      readonly responsibilitySet: readonly HandoffResponsibility[];
      readonly phase: ExecutionHandoffPhase;
      readonly coordinatorContextCapsuleRef?: string | null;
      readonly blockingReason?: string | null;
      readonly expectedHandoffRevision: Revision | null;
    })
  | (CoordinationCommandBase & {
      /**
       * 只推进 phase 与提案级 CAS，不改写描述性字段。
       *
       * `phase === 'cutover'` 是唯一的责任转移路径，在**同一事务内**完成：释放 Source 的
       * Execution Coordination Lease、为 Target 取得、把 `open` 的 Pending Interaction 责任转给
       * Target，然后才把 phase 写成 `cutover`。任一守卫或步骤失败即整笔回滚，Source 保持唯一 owner。
       * 写入者必须是当前（转移前）的 Execution Coordination Lease holder，且是提案的 Source Session。
       */
      readonly kind: 'advance-execution-handoff';
      readonly handoffId: string;
      readonly phase: ExecutionHandoffPhase;
      readonly expectedHandoffRevision: Revision;
      readonly blockingReason?: string | null;
    })
  | (CoordinationCommandBase & {
    /**
     * 登记一个新 Graph Generation 的候选身份。
     *
     * 插入时状态固定为 `candidate`；同一 `graphId` 只允许一行，重复登记按约束拒绝，调用方回读既有记录。
     */
    readonly kind: 'record-graph-generation';
    readonly graphId: GraphId;
    readonly generation: GraphGeneration;
    readonly planningCycleId: PlanningCycleId;
    readonly orcaRunId: string;
    readonly predecessorGraphId: GraphId | null;
    readonly baselineHead: string;
  })
  | (CoordinationCommandBase & {
    /**
     * 推进 Graph Generation 状态。非法迁移在 store 边界拒绝；`frozen` 是终态。
     *
     * 这是代际级事实，不改变 Scope 指针：Scope 指向哪个代际只在 cutover 与取消路径上整体切换。
     */
    readonly kind: 'advance-graph-generation';
    readonly graphId: GraphId;
    readonly status: GraphGenerationStatus;
  })
  | (CoordinationCommandBase & {
    /**
     * 置入或重新置入一个 revision pending 持有。
     *
     * 幂等语义：重复置入不会产生第二行，而是把来源更新为最新的那一次需求；已释放的持有被重新打开。
     * 持有只冻结该 Work Package 与未接受后代，当前 Worker 仍运行至可核验终态。
     *
     * 重新置入同时清空内容版本边界：新来源替换掉的是哪个内容版本、以及它后来接纳了什么，都还没有事实。
     */
    readonly kind: 'record-revision-hold';
    readonly workPackageId: WorkPackageId;
    readonly source: RevisionHoldSource;
    readonly sourceRef: string;
  })
  | (CoordinationCommandBase & {
    /**
     * 在匹配来源的 pending 持有上记下被替换的契约内容版本。
     *
     * 这是「这次修订替换掉的是哪一版内容」的唯一 durable 记录；只有在写完之后，本次修订的 Planner 才能
     * 被派发（派发许可要求持有已准备）。重复准备同一来源是幂等成功，值不同则拒绝：版本边界不因重放而漂移。
     */
    readonly kind: 'prepare-revision-hold';
    readonly workPackageId: WorkPackageId;
    readonly sourceRef: string;
    /** 被替换的内容版本；`null` 表示该节点还没有既有 Specification Unit，按 0 记录。 */
    readonly priorContractRevision: number | null;
  })
  | (CoordinationCommandBase & {
    /**
     * 释放持有；已释放时重复调用是幂等成功，没有持有记录时按约束拒绝。
     *
     * 可选的 `budgetConsumption` 与本次释放**同事务**记账：一次修订的「接受并消耗额度」与「解除持有」
     * 因此是一个原子事实，重放已释放的持有不会把额度再扣一次。
     *
     * 给出 `expectedSourceRef` 时，只释放来源引用相符的持有：否则修订 A 的收尾会释放修订 B 的持有并把
     * 额度记到它头上。
     *
     * 给出 `admittedContractRevision` 时（重新准入结算），同一事务还要求：来源确实相符、该持有已准备好
     * 被替换的版本，并把接纳版本记为持有的事实。接纳版本与被替换版本**允许相同**：只改契约（例如依赖）
     * 的修订、或 Planner 原样交付同一份内容，都不改变「角色链必须重跑」这件事，新旧结果的边界由持有
     * 登记时刻与绑定签发时刻的先后给出。已释放的重放只在来源与版本都一致时幂等成功——否则「同一来源」
     * 的另一次结算会悄悄改写记录。
     *
     * `approvedLimit` 与 `budgetConsumption` 成对给出：它来自已批准的 Manifest，store 据此拒绝越界消费，
     * 避免准入判定与结算之间的竞争把额度记过上限。
     */
    readonly kind: 'release-revision-hold';
    readonly workPackageId: WorkPackageId;
    readonly reason: string;
    readonly expectedSourceRef?: string;
    readonly admittedContractRevision?: number;
    readonly budgetConsumption?: readonly BudgetConsumptionInput[];
    readonly approvedLimit?: number;
  })
  | (CoordinationCommandBase & {
    /** 建立一个独立的 Baseline Reconciliation 需求；插入时状态为 `required`。 */
    readonly kind: 'record-baseline-reconciliation';
    readonly reconciliationId: string;
    readonly workPackageId: WorkPackageId;
    readonly requiredBaselineHead: string;
  })
  | (CoordinationCommandBase & {
    readonly kind: 'bind-baseline-reconciliation-task';
    readonly reconciliationId: string;
    readonly orcaTaskId: string;
    readonly dispatchId?: DispatchId;
  })
  | (CoordinationCommandBase & {
    /**
     * 收尾一次 Baseline Reconciliation。
     *
     * `verified` 只在祖先关系、目标 HEAD、dirty paths 与 scope 全部核验为真时被接受，因此「核验过了」
     * 不可能由一次不完整的观察写入；`blocked` 必须给出阻塞引用。
     */
    readonly kind: 'advance-baseline-reconciliation';
    readonly reconciliationId: string;
    readonly state: Exclude<BaselineReconciliationState, 'required'>;
    readonly observedHead?: string | null;
    readonly ancestryVerified?: boolean;
    readonly targetHeadVerified?: boolean;
    readonly dirtyPathsReconciled?: boolean;
    readonly scopeReconciled?: boolean;
    readonly blockerRef?: string | null;
  })
  | (CoordinationCommandBase & {
    /** 记录一条 Work Package Lineage；一个 Work Package 至多一条。 */
    readonly kind: 'record-work-package-lineage';
    readonly workPackageId: WorkPackageId;
    readonly priorWorkPackageId: WorkPackageId;
    readonly priorGraphId: GraphId;
    readonly inherited: readonly InheritedBudgetEntry[];
  })
  | (CoordinationCommandBase & {
    /**
     * 记录一次旧成果采用。
     *
     * `recorded` 只描述「被引用的接受记录、集成状态、版本与证据都仍在」，不复制旧完成状态；
     * `blocked` 表示 Git、Orca 与旧图给出相互矛盾的结论，必须给出阻塞原因。
     */
    readonly kind: 'record-baseline-adoption';
    readonly adoptionId: string;
    readonly workPackageId: WorkPackageId;
    readonly adoptionKind: BaselineAdoptionKind;
    readonly adoptedResultRef: string;
    readonly baselineHead: string;
    readonly integrationRef: string | null;
    readonly evidenceRefs: readonly string[];
    readonly state: BaselineAdoptionState;
    readonly blockingReason: string | null;
  })
  | (CoordinationCommandBase & {
    /**
     * Generation Cutover：一次写入把当前代际换成候选代际。
     *
     * 同一事务内完成四件事：候选代际转为 `active`、前代转为 `frozen`、Scope 的 Planning Cycle /
     * Graph / Authorization 引用切到候选、Execution Coordination Lease 交给当前写入者。任一守卫失败
     * 即整笔回滚，因此不存在「只换了一半引用」的代际。以目标 `graphId` 幂等：Scope 已指向候选时重复
     * 提交是成功空操作。
     */
    readonly kind: 'commit-generation-cutover';
    readonly candidateGraphId: GraphId;
    readonly candidateGraphVersion: GraphVersion;
    readonly planningCycleId: PlanningCycleId;
    readonly authorizationId: string;
    readonly authorizationVersion: Revision;
    readonly predecessorGraphId: GraphId | null;
    /**
     * 候选代际绑定的 Orca Run 与基线。
     *
     * 它们必须与候选代际记录逐字相符：Cutover 的语义是「引用集合一起切换」，因此 Run 与基线不能只靠
     * 登记时的写入生效，而要在这一笔事务里被核对。
     */
    readonly candidateRunId: string;
    readonly baselineHead: string;
  });

export type CoordinationRejectionCode =
  | 'stale_revision'
  | 'fenced'
  | 'constraint'
  | 'invalid_state';

export type CoordinationCommandRejection = {
  readonly kind: 'rejected';
  readonly code: CoordinationRejectionCode;
  readonly message: string;
  /** 仅在 `stale_revision` 时给出，供调用方重新读取；不构成自动重试。 */
  readonly currentRevision?: number;
};

export type CoordinationCommandResult =
  | { readonly kind: 'committed'; readonly revision: number }
  | CoordinationCommandRejection;

export interface BranchCoordinationStore {
  query(input: CoordinationQuery): CoordinationQueryResult;
  transact(input: CoordinationCommand): CoordinationCommandResult;
}
