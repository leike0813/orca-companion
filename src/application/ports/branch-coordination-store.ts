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
import type { LeaseKind, LeaseRecord } from '../../domain/coordination/leases.js';
import type { SourceRevisionRef } from '../../domain/coordinator/session-state.js';
import type { ExecutionGraph, GraphVersionRecord, GraphVersionRecordKind } from '../../domain/planning/execution-graph.js';
import type { ExecutionAuthorizationManifest, ExecutionAuthorizationRecord } from '../../domain/planning/execution-authorization.js';
import { TICKET_CLAIM_STATES, type TicketClaimState } from '../../domain/planning/ticket-claim.js';
import type { IntentState, OperationIntent } from '../dto/operation-intent.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  GraphGeneration,
  GraphId,
  GraphVersion,
  InteractionId,
  OperationId,
  PlanningCycleId,
  Revision,
  RuntimeIncarnationId,
  StableId,
  EntityRef,
} from '../dto/identity.js';

export type { LeaseKind, LeaseRecord };
export { TICKET_CLAIM_STATES };
export type { TicketClaimState };

export const SESSION_LIFECYCLE_STATES = ['registered', 'active', 'cancelled'] as const;

export type SessionLifecycleState = (typeof SESSION_LIFECYCLE_STATES)[number];

export const PENDING_INTERACTION_STATES = ['open', 'answered', 'cancelled'] as const;

export type PendingInteractionState = (typeof PENDING_INTERACTION_STATES)[number];

export type ScopeRecord = {
  readonly coordinationScopeId: CoordinationScopeId;
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
  readonly createdAt: number;
  readonly resolvedAt: number | null;
};

export type BudgetCounterRecord = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly budgetKey: string;
  readonly approvedLimitRef: string;
  readonly consumed: number;
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

/** `status` 与启动对账用的单次只读投影；不触发续约、对账或任何写入。 */
export type CoordinationSnapshot = {
  readonly scope: ScopeRecord;
  readonly sessions: readonly CoordinatorSessionRegistration[];
  readonly leases: readonly LeaseRecord[];
  readonly executionLease: LeaseRecord | null;
  readonly ticketClaims: readonly TicketClaimRecord[];
  readonly pendingInteractions: readonly PendingInteractionRecord[];
  readonly unresolvedIntents: readonly OperationIntent[];
  readonly planningHandoffs: readonly PlanningHandoffRecord[];
  readonly planningResponsibility: PlanningResponsibilityRecord | null;
};

export type CoordinationQuery =
  | { readonly kind: 'scopes' }
  | { readonly kind: 'scope'; readonly coordinationScopeId: CoordinationScopeId }
  | { readonly kind: 'snapshot'; readonly coordinationScopeId: CoordinationScopeId }
  | { readonly kind: 'sessions'; readonly coordinationScopeId: CoordinationScopeId }
  | { readonly kind: 'leases'; readonly coordinationScopeId: CoordinationScopeId }
  | {
      readonly kind: 'intents';
      readonly coordinationScopeId: CoordinationScopeId;
      readonly intentState?: IntentState;
    }
  | { readonly kind: 'intent'; readonly coordinationScopeId: CoordinationScopeId; readonly operationId: OperationId }
  | { readonly kind: 'budget-counters'; readonly coordinationScopeId: CoordinationScopeId }
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
  | { readonly kind: 'planning-responsibility'; readonly coordinationScopeId: CoordinationScopeId };

export type CoordinationQueryRejectionCode = 'unreadable' | 'invalid_query';

/**
 * 结果与查询同判别：调用方只需 narrowing 一次，不需要对 `value` 做类型断言。
 * `*| null` 表示「记录确实不存在」，与拒绝区分开。
 */
export type CoordinationQueryResult =
  | { readonly kind: 'scopes'; readonly scopes: readonly ScopeRecord[] }
  | { readonly kind: 'scope'; readonly scope: ScopeRecord | null }
  | { readonly kind: 'snapshot'; readonly snapshot: CoordinationSnapshot }
  | { readonly kind: 'sessions'; readonly sessions: readonly CoordinatorSessionRegistration[] }
  | { readonly kind: 'leases'; readonly leases: readonly LeaseRecord[] }
  | { readonly kind: 'intents'; readonly intents: readonly OperationIntent[] }
  | { readonly kind: 'intent'; readonly intent: OperationIntent | null }
  | { readonly kind: 'budget-counters'; readonly counters: readonly BudgetCounterRecord[] }
  | { readonly kind: 'wake-admissions'; readonly admissions: readonly WakeAdmissionRecord[] }
  | { readonly kind: 'graph-versions'; readonly versions: readonly GraphVersionRecord[] }
  | { readonly kind: 'graph-version'; readonly version: GraphVersionRecord | null }
  | { readonly kind: 'authorizations'; readonly authorizations: readonly ExecutionAuthorizationRecord[] }
  | { readonly kind: 'authorization'; readonly authorization: ExecutionAuthorizationRecord | null }
  | { readonly kind: 'planning-handoffs'; readonly handoffs: readonly PlanningHandoffRecord[] }
  | { readonly kind: 'planning-handoff'; readonly handoff: PlanningHandoffRecord | null }
  | { readonly kind: 'planning-responsibility'; readonly responsibility: PlanningResponsibilityRecord | null }
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
  | (CoordinationCommandBase & {
      readonly kind: 'create-scope';
      readonly mode: CoordinationMode;
      readonly controlState: ControlState;
      readonly planningCycleId: PlanningCycleId | null;
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
    })
  | (CoordinationCommandBase & {
      readonly kind: 'resolve-pending-interaction';
      readonly interactionId: InteractionId;
      readonly state: Exclude<PendingInteractionState, 'open'>;
      readonly answerRef: EntityRef<string> | null;
    })
  | (CoordinationCommandBase & {
      readonly kind: 'begin-intent';
      readonly operationId: OperationId;
      readonly target: EntityRef<string>;
      readonly operationCategory: string;
    })
  | (CoordinationCommandBase & {
      readonly kind: 'settle-intent';
      readonly operationId: OperationId;
      readonly outcomeClass: 'accepted' | 'rejected' | 'unknown';
      readonly backendRequestId?: string;
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
