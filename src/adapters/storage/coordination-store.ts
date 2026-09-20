/**
 * IC-03：Branch Coordination Store 的 SQLite 实现
 * （Owner: `m1-persist-coordination-state`）。
 *
 * 这里只做持久化机制：短事务、CAS revision、唯一约束、fencing 与结构化拒绝。它不实现对账策略、
 * 不决定模式转换、不判断预算该不该扣，也不把 tracker / Git / Orca 的事实搬进本库。
 *
 * 全部写入使用立即事务以取得写者串行；读查询不开长期排他锁。`node:sqlite` 是实验性 API，
 * 因此访问集中在本文件，替换实现不影响应用层。
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

import {
  findFenceViolation,
  isLeaseActive,
  nextFencingGeneration,
  type LeaseRecord,
} from '../../domain/coordination/leases.js';
import {
  CONTROL_STATES,
  COORDINATION_MODES,
  isControlState,
  isCoordinationMode,
} from '../../domain/coordination/mode.js';
import {
  ABSENT_SCOPE_REVISION,
  advanceRevision,
  checkExpectedRevision,
} from '../../domain/coordination/revision.js';
import {
  INTENT_OUTCOME_CLASSES,
  INTENT_STATES,
  laneKeyOf,
  type IntentOutcomeClass,
  type IntentState,
  type OperationIntent,
} from '../../application/dto/operation-intent.js';
import type { SourceRevisionRef } from '../../domain/coordinator/session-state.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  EntityRef,
  GraphId,
  GraphVersion,
  InteractionId,
  OperationId,
  PlanningCycleId,
  RuntimeIncarnationId,
} from '../../application/dto/identity.js';
import {
  PENDING_INTERACTION_STATES,
  SESSION_LIFECYCLE_STATES,
  TICKET_CLAIM_STATES,
  WAKE_ADMISSION_STATES,
  type BranchCoordinationStore,
  type BudgetCounterRecord,
  type CoordinationCommand,
  type CoordinationCommandBase,
  type CoordinationCommandRejection,
  type CoordinationCommandResult,
  type CoordinationQuery,
  type CoordinationQueryResult,
  type CoordinationRejectionCode,
  type CoordinationSnapshot,
  type CoordinatorSessionRegistration,
  type PendingInteractionRecord,
  type PendingInteractionState,
  type ScopeRecord,
  type SessionLifecycleState,
  type TicketClaimRecord,
  type TicketClaimState,
  type WakeAdmissionRecord,
  type WakeAdmissionState,
} from '../../application/ports/branch-coordination-store.js';
import { SCHEMA_VERSION, describeError, migrate, readSchemaVersion } from './schema.js';

/** SQLite 主结果码：约束族（PRIMARY KEY / UNIQUE / NOT NULL / CHECK / FOREIGN KEY）。 */
const SQLITE_CONSTRAINT = 19;

const SETTLE_OUTCOME_CLASSES = [...INTENT_OUTCOME_CLASSES, 'unknown'] as const;

export type CoordinationStore = BranchCoordinationStore & { readonly close: () => void };

export type CoordinationStoreOpenFailureCode =
  | 'missing'
  | 'unreadable'
  | 'schema_version_unsupported'
  | 'migration_failed';

export type OpenCoordinationStoreResult =
  | { readonly kind: 'opened'; readonly store: CoordinationStore }
  | {
      readonly kind: 'failed';
      readonly code: CoordinationStoreOpenFailureCode;
      readonly message: string;
    };

export type OpenCoordinationStoreOptions = {
  readonly databasePath: string;
  /** 可注入时钟：领域层不读时钟，适配器也不隐藏真实时间来源。 */
  readonly clock?: () => number;
  /** 只读打开：用于 `status`，只允许 query，schema 版本必须精确匹配。 */
  readonly readOnly?: boolean;
};

type Decoded<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string; readonly code: CoordinationRejectionCode };

function ok<T>(value: T): Decoded<T> {
  return { ok: true, value };
}

function fail<T>(message: string, code: CoordinationRejectionCode = 'invalid_state'): Decoded<T> {
  return { ok: false, message, code };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(raw: unknown, field: string): Decoded<string> {
  if (typeof raw !== 'string' || raw.length === 0) {
    return fail(`${field} 必须是非空字符串`);
  }
  return ok(raw);
}

function requireNullableString(raw: unknown, field: string): Decoded<string | null> {
  if (raw === null || raw === undefined) {
    return ok(null);
  }
  return requireString(raw, field);
}

function requireCount(raw: unknown, field: string): Decoded<number> {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    return fail(`${field} 必须是非负整数`);
  }
  return ok(raw);
}

function requireNullableCount(raw: unknown, field: string): Decoded<number | null> {
  if (raw === null || raw === undefined) {
    return ok(null);
  }
  return requireCount(raw, field);
}

function requireEnum<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  field: string,
): Decoded<T> {
  if (typeof raw !== 'string' || !(allowed as readonly string[]).includes(raw)) {
    return fail(`${field} 取值不受支持`);
  }
  return ok(raw as T);
}

function requireEntityRef(raw: unknown, field: string): Decoded<EntityRef<string>> {
  if (!isRecord(raw)) {
    return fail(`${field} 必须是对象`);
  }
  const kind = requireString(raw['kind'], `${field}.kind`);
  if (!kind.ok) {
    return kind;
  }
  const id = requireString(raw['id'], `${field}.id`);
  if (!id.ok) {
    return id;
  }
  return ok({ kind: kind.value, id: id.value });
}

function decodeWriter(raw: unknown, field: string): Decoded<CoordinationCommand['writer']> {
  if (!isRecord(raw)) {
    return fail(`${field} 必须是对象`);
  }
  const sessionId = requireString(raw['coordinatorSessionId'], `${field}.coordinatorSessionId`);
  if (!sessionId.ok) {
    return sessionId;
  }
  const incarnationId = requireString(raw['runtimeIncarnationId'], `${field}.runtimeIncarnationId`);
  if (!incarnationId.ok) {
    return incarnationId;
  }
  const generation = requireCount(raw['fencingGeneration'], `${field}.fencingGeneration`);
  if (!generation.ok) {
    return generation;
  }
  return ok({
    coordinatorSessionId: sessionId.value as CoordinatorSessionId,
    runtimeIncarnationId: incarnationId.value as RuntimeIncarnationId,
    fencingGeneration: generation.value,
  });
}

/**
 * 边界校验：unknown variant、缺失字段与未声明枚举都在这里 fail closed。
 * 闭集的意义即在此——调用方无法用「再多一个字段」把可重建事实写进本库。
 */
function decodeSourceRevisionRef(raw: unknown, field: string): Decoded<SourceRevisionRef> {
  if (!isRecord(raw)) {
    return fail(`${field} 必须是对象`);
  }
  const sourceKind = requireString(raw['sourceKind'], `${field}.sourceKind`);
  if (!sourceKind.ok) {
    return sourceKind;
  }
  const sourceId = requireString(raw['sourceId'], `${field}.sourceId`);
  if (!sourceId.ok) {
    return sourceId;
  }
  const revision = requireCount(raw['revision'], `${field}.revision`);
  if (!revision.ok) {
    return revision;
  }
  return {
    ok: true,
    value: { sourceKind: sourceKind.value, sourceId: sourceId.value, revision: revision.value },
  };
}

function decodeSourceRevisionList(raw: unknown, field: string): Decoded<readonly SourceRevisionRef[]> {
  if (!Array.isArray(raw)) {
    return fail(`${field} 必须是数组`);
  }
  const values: SourceRevisionRef[] = [];
  for (const [index, entry] of raw.entries()) {
    const decoded = decodeSourceRevisionRef(entry, `${field}.${index}`);
    if (!decoded.ok) {
      return decoded;
    }
    values.push(decoded.value);
  }
  return ok(values);
}

function decodeCommand(command: unknown): Decoded<CoordinationCommand> {
  if (!isRecord(command)) {
    return fail('command 必须是对象');
  }
  const kind = requireString(command['kind'], 'command.kind');
  if (!kind.ok) {
    return kind;
  }
  const scopeId = requireString(command['coordinationScopeId'], 'command.coordinationScopeId');
  if (!scopeId.ok) {
    return scopeId;
  }
  const expectedRevision = requireCount(command['expectedRevision'], 'command.expectedRevision');
  if (!expectedRevision.ok) {
    return expectedRevision;
  }
  const writer = decodeWriter(command['writer'], 'command.writer');
  if (!writer.ok) {
    return writer;
  }
  const base: CoordinationCommandBase = {
    coordinationScopeId: scopeId.value as CoordinationScopeId,
    expectedRevision: expectedRevision.value,
    writer: writer.value,
  };

  switch (kind.value) {
    case 'create-scope': {
      const mode = requireEnum(command['mode'], COORDINATION_MODES, 'mode');
      if (!mode.ok) {
        return mode;
      }
      const control = requireEnum(command['controlState'], CONTROL_STATES, 'controlState');
      if (!control.ok) {
        return control;
      }
      const cycle = requireNullableString(command['planningCycleId'], 'planningCycleId');
      if (!cycle.ok) {
        return cycle;
      }
      return ok({
        ...base,
        kind: 'create-scope',
        mode: mode.value,
        controlState: control.value,
        planningCycleId: cycle.value as PlanningCycleId | null,
      });
    }
    case 'update-scope-mode': {
      const mode = requireEnum(command['mode'], COORDINATION_MODES, 'mode');
      if (!mode.ok) {
        return mode;
      }
      const cycle = requireNullableString(command['planningCycleId'], 'planningCycleId');
      if (!cycle.ok) {
        return cycle;
      }
      return ok({
        ...base,
        kind: 'update-scope-mode',
        mode: mode.value,
        planningCycleId: cycle.value as PlanningCycleId | null,
      });
    }
    case 'update-scope-refs': {
      const graphId = requireNullableString(command['graphId'], 'graphId');
      if (!graphId.ok) {
        return graphId;
      }
      const graphVersion = requireNullableCount(command['graphVersion'], 'graphVersion');
      if (!graphVersion.ok) {
        return graphVersion;
      }
      const authorizationId = requireNullableString(command['authorizationId'], 'authorizationId');
      if (!authorizationId.ok) {
        return authorizationId;
      }
      const authorizationVersion = requireNullableCount(command['authorizationVersion'], 'authorizationVersion');
      if (!authorizationVersion.ok) {
        return authorizationVersion;
      }
      if ((graphId.value === null) !== (graphVersion.value === null)) {
        return fail('graphId 与 graphVersion 必须同时存在或同时为空');
      }
      if ((authorizationId.value === null) !== (authorizationVersion.value === null)) {
        return fail('authorizationId 与 authorizationVersion 必须同时存在或同时为空');
      }
      return ok({
        ...base,
        kind: 'update-scope-refs',
        graphId: graphId.value as GraphId | null,
        graphVersion: graphVersion.value as GraphVersion | null,
        authorizationId: authorizationId.value,
        authorizationVersion: authorizationVersion.value,
      });
    }
    case 'record-control-state': {
      const control = requireEnum(command['controlState'], CONTROL_STATES, 'controlState');
      if (!control.ok) {
        return control;
      }
      return ok({ ...base, kind: 'record-control-state', controlState: control.value });
    }
    case 'register-session': {
      const sessionId = requireString(command['coordinatorSessionId'], 'coordinatorSessionId');
      if (!sessionId.ok) {
        return sessionId;
      }
      const profile = requireString(
        command['coordinatorModelConfigurationRef'],
        'coordinatorModelConfigurationRef',
      );
      if (!profile.ok) {
        return profile;
      }
      const lifecycle = requireEnum(command['lifecycleState'], SESSION_LIFECYCLE_STATES, 'lifecycleState');
      if (!lifecycle.ok) {
        return lifecycle;
      }
      return ok({
        ...base,
        kind: 'register-session',
        coordinatorSessionId: sessionId.value as CoordinatorSessionId,
        coordinatorModelConfigurationRef: profile.value,
        lifecycleState: lifecycle.value,
      });
    }
    case 'record-ticket-claim': {
      const ticketRef = requireEntityRef(command['ticketRef'], 'ticketRef');
      if (!ticketRef.ok) {
        return ticketRef;
      }
      return ok({ ...base, kind: 'record-ticket-claim', ticketRef: ticketRef.value });
    }
    case 'release-ticket-claim': {
      const ticketRef = requireEntityRef(command['ticketRef'], 'ticketRef');
      if (!ticketRef.ok) {
        return ticketRef;
      }
      const finalState = requireEnum(command['finalState'], ['completed', 'released'] as const, 'finalState');
      if (!finalState.ok) {
        return finalState;
      }
      return ok({ ...base, kind: 'release-ticket-claim', ticketRef: ticketRef.value, finalState: finalState.value });
    }
    case 'record-pending-interaction': {
      const interactionId = requireString(command['interactionId'], 'interactionId');
      if (!interactionId.ok) {
        return interactionId;
      }
      const owner = requireString(command['ownerCoordinatorSessionId'], 'ownerCoordinatorSessionId');
      if (!owner.ok) {
        return owner;
      }
      const subjectRef = requireEntityRef(command['subjectRef'], 'subjectRef');
      if (!subjectRef.ok) {
        return subjectRef;
      }
      return ok({
        ...base,
        kind: 'record-pending-interaction',
        interactionId: interactionId.value as InteractionId,
        ownerCoordinatorSessionId: owner.value as CoordinatorSessionId,
        subjectRef: subjectRef.value,
      });
    }
    case 'resolve-pending-interaction': {
      const interactionId = requireString(command['interactionId'], 'interactionId');
      if (!interactionId.ok) {
        return interactionId;
      }
      const state = requireEnum(command['state'], ['answered', 'cancelled'] as const, 'state');
      if (!state.ok) {
        return state;
      }
      const answerRef = command['answerRef'] === null || command['answerRef'] === undefined
        ? ok(null)
        : requireEntityRef(command['answerRef'], 'answerRef');
      if (!answerRef.ok) {
        return answerRef;
      }
      if (state.value === 'answered' && answerRef.value === null) {
        return fail('answered 状态必须给出 answerRef');
      }
      return ok({
        ...base,
        kind: 'resolve-pending-interaction',
        interactionId: interactionId.value as InteractionId,
        state: state.value,
        answerRef: answerRef.value,
      });
    }
    case 'begin-intent': {
      const operationId = requireString(command['operationId'], 'operationId');
      if (!operationId.ok) {
        return operationId;
      }
      const target = requireEntityRef(command['target'], 'target');
      if (!target.ok) {
        return target;
      }
      const category = requireString(command['operationCategory'], 'operationCategory');
      if (!category.ok) {
        return category;
      }
      return ok({
        ...base,
        kind: 'begin-intent',
        operationId: operationId.value as OperationId,
        target: target.value,
        operationCategory: category.value,
      });
    }
    case 'settle-intent': {
      const operationId = requireString(command['operationId'], 'operationId');
      if (!operationId.ok) {
        return operationId;
      }
      const outcomeClass = requireEnum(
        command['outcomeClass'],
        SETTLE_OUTCOME_CLASSES,
        'outcomeClass',
      );
      if (!outcomeClass.ok) {
        return outcomeClass;
      }
      const backendRequestId = requireNullableString(command['backendRequestId'], 'backendRequestId');
      if (!backendRequestId.ok) {
        return backendRequestId;
      }
      return ok({
        ...base,
        kind: 'settle-intent',
        operationId: operationId.value as OperationId,
        outcomeClass: outcomeClass.value,
        ...(backendRequestId.value === null ? {} : { backendRequestId: backendRequestId.value }),
      });
    }
    case 'block-intent': {
      const operationId = requireString(command['operationId'], 'operationId');
      if (!operationId.ok) {
        return operationId;
      }
      const reason = requireString(command['reason'], 'reason');
      if (!reason.ok) {
        return reason;
      }
      return ok({
        ...base,
        kind: 'block-intent',
        operationId: operationId.value as OperationId,
        reason: reason.value,
      });
    }
    case 'resolve-intent': {
      const operationId = requireString(command['operationId'], 'operationId');
      if (!operationId.ok) {
        return operationId;
      }
      const outcomeClass = requireEnum(command['outcomeClass'], INTENT_OUTCOME_CLASSES, 'outcomeClass');
      if (!outcomeClass.ok) {
        return outcomeClass;
      }
      const backendRequestId = requireNullableString(command['backendRequestId'], 'backendRequestId');
      if (!backendRequestId.ok) {
        return backendRequestId;
      }
      return ok({
        ...base,
        kind: 'resolve-intent',
        operationId: operationId.value as OperationId,
        outcomeClass: outcomeClass.value,
        ...(backendRequestId.value === null ? {} : { backendRequestId: backendRequestId.value }),
      });
    }
    case 'acquire-runtime-lease': {
      const ttlMs = requireCount(command['ttlMs'], 'ttlMs');
      if (!ttlMs.ok || ttlMs.value === 0) {
        return fail('ttlMs 必须是正的安全整数');
      }
      return ok({ ...base, kind: 'acquire-runtime-lease', ttlMs: ttlMs.value });
    }
    case 'renew-runtime-lease': {
      const ttlMs = requireCount(command['ttlMs'], 'ttlMs');
      if (!ttlMs.ok || ttlMs.value === 0) {
        return fail('ttlMs 必须是正的安全整数');
      }
      return ok({ ...base, kind: 'renew-runtime-lease', ttlMs: ttlMs.value });
    }
    case 'acquire-execution-lease':
      return ok({ ...base, kind: 'acquire-execution-lease' });
    case 'release-execution-lease':
      return ok({ ...base, kind: 'release-execution-lease' });
    case 'release-runtime-lease':
      return ok({ ...base, kind: 'release-runtime-lease' });
    case 'consume-budget': {
      const budgetKey = requireString(command['budgetKey'], 'budgetKey');
      if (!budgetKey.ok) {
        return budgetKey;
      }
      const approvedLimitRef = requireString(command['approvedLimitRef'], 'approvedLimitRef');
      if (!approvedLimitRef.ok) {
        return approvedLimitRef;
      }
      const amount = requireCount(command['amount'], 'amount');
      if (!amount.ok || amount.value === 0) {
        return fail('amount 必须是正的安全整数');
      }
      return ok({
        ...base,
        kind: 'consume-budget',
        budgetKey: budgetKey.value,
        approvedLimitRef: approvedLimitRef.value,
        amount: amount.value,
      });
    }
    case 'record-wake-admission': {
      const wakeBatchId = requireString(command['wakeBatchId'], 'wakeBatchId');
      if (!wakeBatchId.ok) {
        return wakeBatchId;
      }
      const admissionState = requireEnum(command['admissionState'], WAKE_ADMISSION_STATES, 'admissionState');
      if (!admissionState.ok) {
        return admissionState;
      }
      const sourceRevisions = decodeSourceRevisionList(command['sourceRevisions'], 'sourceRevisions');
      if (!sourceRevisions.ok) {
        return sourceRevisions;
      }
      return ok({
        ...base,
        kind: 'record-wake-admission',
        wakeBatchId: wakeBatchId.value,
        admissionState: admissionState.value,
        sourceRevisions: sourceRevisions.value,
      });
    }
    default:
      return fail(`未登记的 command variant: ${kind.value}`);
  }
}

type ScopeRow = {
  readonly coordination_scope_id: string;
  readonly mode: string;
  readonly control_state: string;
  readonly planning_cycle_id: string | null;
  readonly graph_id: string | null;
  readonly graph_version: number | null;
  readonly authorization_id: string | null;
  readonly authorization_version: number | null;
  readonly revision: number;
  readonly updated_at: number;
};

type LeaseRow = {
  readonly coordination_scope_id: string;
  readonly lease_kind: string;
  readonly coordinator_session_id: string;
  readonly runtime_incarnation_id: string;
  readonly fencing_generation: number;
  readonly acquired_at: number;
  readonly expires_at: number | null;
  readonly released_at: number | null;
};

type SessionRow = {
  readonly coordination_scope_id: string;
  readonly coordinator_session_id: string;
  readonly coordinator_model_configuration_ref: string;
  readonly lifecycle_state: string;
  readonly registered_at: number;
};

type TicketClaimRow = {
  readonly coordination_scope_id: string;
  readonly ticket_kind: string;
  readonly ticket_id: string;
  readonly coordinator_session_id: string;
  readonly state: string;
  readonly claimed_at: number;
};

type InteractionRow = {
  readonly coordination_scope_id: string;
  readonly interaction_id: string;
  readonly owner_coordinator_session_id: string;
  readonly subject_kind: string;
  readonly subject_id: string;
  readonly expected_revision: number;
  readonly state: string;
  readonly answer_kind: string | null;
  readonly answer_id: string | null;
  readonly created_at: number;
  readonly resolved_at: number | null;
};

type IntentRow = {
  readonly coordination_scope_id: string;
  readonly operation_id: string;
  readonly target_kind: string;
  readonly target_id: string;
  readonly operation_category: string;
  readonly lane_key: string;
  readonly initiated_by_session_id: string;
  readonly initiated_by_incarnation_id: string;
  readonly expected_revision: number;
  readonly state: string;
  readonly outcome_class: string | null;
  readonly backend_request_id: string | null;
  readonly blocking_reason: string | null;
  readonly created_at: number;
  readonly settled_at: number | null;
};

type BudgetRow = {
  readonly coordination_scope_id: string;
  readonly budget_key: string;
  readonly approved_limit_ref: string;
  readonly consumed: number;
};

type WakeAdmissionRow = {
  readonly coordination_scope_id: string;
  readonly coordinator_session_id: string;
  readonly wake_batch_id: string;
  readonly admission_state: string;
  readonly source_revisions: string;
  readonly admitted_at: number;
};

function decodeScopeRow(row: ScopeRow): Decoded<ScopeRecord> {
  if (!isCoordinationMode(row.mode)) {
    return fail(`scope.mode 取值不受支持: ${row.mode}`);
  }
  if (!isControlState(row.control_state)) {
    return fail(`scope.control_state 取值不受支持: ${row.control_state}`);
  }
  return ok({
    coordinationScopeId: row.coordination_scope_id as CoordinationScopeId,
    mode: row.mode,
    controlState: row.control_state,
    planningCycleId: row.planning_cycle_id as PlanningCycleId | null,
    graphId: row.graph_id as GraphId | null,
    graphVersion: row.graph_version as GraphVersion | null,
    authorizationId: row.authorization_id,
    authorizationVersion: row.authorization_version,
    revision: row.revision,
  });
}

function decodeLeaseRow(row: LeaseRow): Decoded<LeaseRecord> {
  if (row.lease_kind !== 'runtime' && row.lease_kind !== 'execution_coordination') {
    return fail(`leases.lease_kind 取值不受支持: ${row.lease_kind}`);
  }
  return ok({
    kind: row.lease_kind,
    coordinationScopeId: row.coordination_scope_id as CoordinationScopeId,
    coordinatorSessionId: row.coordinator_session_id as CoordinatorSessionId,
    runtimeIncarnationId: row.runtime_incarnation_id as RuntimeIncarnationId,
    fencingGeneration: row.fencing_generation,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    releasedAt: row.released_at,
  });
}

function decodeSessionRow(row: SessionRow): Decoded<CoordinatorSessionRegistration> {
  if (!(SESSION_LIFECYCLE_STATES as readonly string[]).includes(row.lifecycle_state)) {
    return fail(`session_registry.lifecycle_state 取值不受支持: ${row.lifecycle_state}`);
  }
  return ok({
    coordinationScopeId: row.coordination_scope_id as CoordinationScopeId,
    coordinatorSessionId: row.coordinator_session_id as CoordinatorSessionId,
    coordinatorModelConfigurationRef: row.coordinator_model_configuration_ref,
    lifecycleState: row.lifecycle_state as SessionLifecycleState,
    registeredAt: row.registered_at,
  });
}

function decodeTicketClaimRow(row: TicketClaimRow): Decoded<TicketClaimRecord> {
  if (!(TICKET_CLAIM_STATES as readonly string[]).includes(row.state)) {
    return fail(`ticket_claims.state 取值不受支持: ${row.state}`);
  }
  return ok({
    coordinationScopeId: row.coordination_scope_id as CoordinationScopeId,
    ticketRef: { kind: row.ticket_kind, id: row.ticket_id },
    coordinatorSessionId: row.coordinator_session_id as CoordinatorSessionId,
    state: row.state as TicketClaimState,
    claimedAt: row.claimed_at,
  });
}

function decodeInteractionRow(row: InteractionRow): Decoded<PendingInteractionRecord> {
  if (!(PENDING_INTERACTION_STATES as readonly string[]).includes(row.state)) {
    return fail(`pending_interactions.state 取值不受支持: ${row.state}`);
  }
  const answerRef =
    row.answer_kind === null || row.answer_id === null
      ? null
      : { kind: row.answer_kind, id: row.answer_id };
  return ok({
    coordinationScopeId: row.coordination_scope_id as CoordinationScopeId,
    interactionId: row.interaction_id as InteractionId,
    ownerCoordinatorSessionId: row.owner_coordinator_session_id as CoordinatorSessionId,
    subjectRef: { kind: row.subject_kind, id: row.subject_id },
    expectedRevision: row.expected_revision,
    state: row.state as PendingInteractionState,
    answerRef,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  });
}

function decodeIntentRow(row: IntentRow): Decoded<OperationIntent> {
  if (!(INTENT_STATES as readonly string[]).includes(row.state)) {
    return fail(`operation_intents.state 取值不受支持: ${row.state}`);
  }
  let outcomeClass: IntentOutcomeClass | null = null;
  if (row.outcome_class !== null) {
    if (!(INTENT_OUTCOME_CLASSES as readonly string[]).includes(row.outcome_class)) {
      return fail(`operation_intents.outcome_class 取值不受支持: ${row.outcome_class}`);
    }
    outcomeClass = row.outcome_class as IntentOutcomeClass;
  }
  return ok({
    coordinationScopeId: row.coordination_scope_id as CoordinationScopeId,
    operationId: row.operation_id as OperationId,
    target: { kind: row.target_kind, id: row.target_id },
    operationCategory: row.operation_category,
    laneKey: row.lane_key,
    expectedRevision: row.expected_revision,
    initiatedBy: {
      coordinatorSessionId: row.initiated_by_session_id as CoordinatorSessionId,
      runtimeIncarnationId: row.initiated_by_incarnation_id as RuntimeIncarnationId,
    },
    state: row.state as IntentState,
    outcomeClass,
    backendRequestId: row.backend_request_id,
    blockingReason: row.blocking_reason,
    createdAt: row.created_at,
    settledAt: row.settled_at,
  });
}

function decodeBudgetRow(row: BudgetRow): BudgetCounterRecord {
  return {
    coordinationScopeId: row.coordination_scope_id as CoordinationScopeId,
    budgetKey: row.budget_key,
    approvedLimitRef: row.approved_limit_ref,
    consumed: row.consumed,
  };
}

function decodeWakeAdmissionRow(row: WakeAdmissionRow): Decoded<WakeAdmissionRecord> {
  if (!(WAKE_ADMISSION_STATES as readonly string[]).includes(row.admission_state)) {
    return fail(`wake_admissions.admission_state 取值不受支持: ${row.admission_state}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(row.source_revisions);
  } catch (error) {
    return fail(`wake_admissions.source_revisions 不是合法 JSON: ${describeError(error)}`);
  }
  const sourceRevisions = decodeSourceRevisionList(raw, 'wake_admissions.source_revisions');
  if (!sourceRevisions.ok) {
    return sourceRevisions;
  }
  return ok({
    coordinationScopeId: row.coordination_scope_id as CoordinationScopeId,
    coordinatorSessionId: row.coordinator_session_id as CoordinatorSessionId,
    wakeBatchId: row.wake_batch_id,
    admissionState: row.admission_state as WakeAdmissionState,
    sourceRevisions: sourceRevisions.value,
    admittedAt: row.admitted_at,
  });
}

function decodeRows<R, T>(rows: readonly R[], decode: (row: R) => Decoded<T>): Decoded<readonly T[]> {
  const values: T[] = [];
  for (const row of rows) {
    const decoded = decode(row);
    if (!decoded.ok) {
      return fail(decoded.message);
    }
    values.push(decoded.value);
  }
  return ok(values);
}

function isConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as { readonly errcode?: unknown }).errcode;
  return typeof code === 'number' && (code & 0xff) === SQLITE_CONSTRAINT;
}

/**
 * `node:sqlite` 只把行描述为 `Record<string, SQLOutputValue>`；具体行形状由本文件的
 * decode* 函数逐字段校验，因此这里只做一次受控转换，不把 unknown 泄漏给领域类型。
 */
function one<T>(statement: StatementSync, ...params: SQLInputValue[]): T | undefined {
  return statement.get(...params) as unknown as T | undefined;
}

function many<T>(statement: StatementSync, ...params: SQLInputValue[]): readonly T[] {
  return statement.all(...params) as unknown as readonly T[];
}

function rejected(code: CoordinationCommandRejection['code'], message: string): CoordinationCommandRejection {
  return { kind: 'rejected', code, message };
}

/**
 * 打开（或只读打开）`coordination.sqlite`。
 *
 * 只读路径用于 `status`：它不做 migration，schema 版本必须精确匹配当前实现，否则拒绝启动——
 * 一个「看起来正常但什么都没读到」的快照比直接失败危险得多。
 */
export function openCoordinationStore(options: OpenCoordinationStoreOptions): OpenCoordinationStoreResult {
  const { databasePath } = options;
  const readOnly = options.readOnly ?? false;
  const clock = options.clock ?? (() => Date.now());

  let db: DatabaseSync;
  if (readOnly) {
    if (!existsSync(databasePath)) {
      return { kind: 'failed', code: 'missing', message: `未找到 ${databasePath}` };
    }
    try {
      db = new DatabaseSync(databasePath, { readOnly: true });
    } catch (error) {
      return { kind: 'failed', code: 'unreadable', message: describeError(error) };
    }
    try {
      db.exec('PRAGMA busy_timeout = 5000');
    } catch (error) {
      db.close();
      return { kind: 'failed', code: 'unreadable', message: describeError(error) };
    }
    let version: number | null;
    try {
      version = readSchemaVersion(db);
    } catch (error) {
      db.close();
      return { kind: 'failed', code: 'unreadable', message: describeError(error) };
    }
    if (version !== SCHEMA_VERSION) {
      db.close();
      return {
        kind: 'failed',
        code: 'schema_version_unsupported',
        message: `期望 schema 版本 ${SCHEMA_VERSION}，实际为 ${version === null ? '未知' : String(version)}；只读查询不做 migration`,
      };
    }
  } else {
    try {
      mkdirSync(dirname(databasePath), { recursive: true });
    } catch (error) {
      return { kind: 'failed', code: 'unreadable', message: describeError(error) };
    }
    try {
      db = new DatabaseSync(databasePath);
    } catch (error) {
      return { kind: 'failed', code: 'unreadable', message: describeError(error) };
    }
    try {
      db.exec('PRAGMA busy_timeout = 5000');
    } catch (error) {
      db.close();
      return { kind: 'failed', code: 'unreadable', message: describeError(error) };
    }
    const migration = migrate(db);
    if (migration.kind === 'unsupported') {
      db.close();
      return {
        kind: 'failed',
        code: 'schema_version_unsupported',
        message: `库内 schema 版本 ${migration.version} 高于当前实现的 ${SCHEMA_VERSION}`,
      };
    }
    if (migration.kind === 'failed') {
      db.close();
      return { kind: 'failed', code: 'migration_failed', message: migration.message };
    }
  }

  const readScopeRow = (scopeId: string): ScopeRow | undefined =>
    one<ScopeRow>(db.prepare('SELECT * FROM scope WHERE coordination_scope_id = ?'), scopeId);

  const readLeaseRows = (scopeId: string): readonly LeaseRow[] =>
    many<LeaseRow>(
      db.prepare('SELECT * FROM leases WHERE coordination_scope_id = ? ORDER BY lease_kind, coordinator_session_id'),
      scopeId,
    );

  const readRuntimeLeaseRow = (scopeId: string, sessionId: string): LeaseRow | undefined =>
    one<LeaseRow>(
      db.prepare(
        `SELECT * FROM leases
         WHERE coordination_scope_id = ? AND lease_kind = 'runtime' AND coordinator_session_id = ?`,
      ),
      scopeId,
      sessionId,
    );

  const readSessionRows = (scopeId: string): readonly SessionRow[] =>
    many<SessionRow>(
      db.prepare(
        'SELECT * FROM session_registry WHERE coordination_scope_id = ? ORDER BY registered_at, coordinator_session_id',
      ),
      scopeId,
    );

  const readTicketClaimRows = (scopeId: string): readonly TicketClaimRow[] =>
    many<TicketClaimRow>(
      db.prepare('SELECT * FROM ticket_claims WHERE coordination_scope_id = ? ORDER BY claimed_at, ticket_id'),
      scopeId,
    );

  const readInteractionRows = (scopeId: string): readonly InteractionRow[] =>
    many<InteractionRow>(
      db.prepare(
        'SELECT * FROM pending_interactions WHERE coordination_scope_id = ? ORDER BY created_at, interaction_id',
      ),
      scopeId,
    );

  const readIntentRows = (scopeId: string, state?: IntentState): readonly IntentRow[] =>
    state === undefined
      ? many<IntentRow>(
          db.prepare(
            'SELECT * FROM operation_intents WHERE coordination_scope_id = ? ORDER BY created_at, operation_id',
          ),
          scopeId,
        )
      : many<IntentRow>(
          db.prepare(
            'SELECT * FROM operation_intents WHERE coordination_scope_id = ? AND state = ? ORDER BY created_at, operation_id',
          ),
          scopeId,
          state,
        );

  const readIntentRow = (scopeId: string, operationId: string): IntentRow | undefined =>
    one<IntentRow>(
      db.prepare('SELECT * FROM operation_intents WHERE coordination_scope_id = ? AND operation_id = ?'),
      scopeId,
      operationId,
    );

  const readBudgetRows = (scopeId: string): readonly BudgetRow[] =>
    many<BudgetRow>(
      db.prepare('SELECT * FROM budget_counters WHERE coordination_scope_id = ? ORDER BY budget_key'),
      scopeId,
    );

  const readWakeAdmissionRows = (
    scopeId: string,
    sessionId: string | undefined,
  ): readonly WakeAdmissionRow[] =>
    sessionId === undefined
      ? many<WakeAdmissionRow>(
          db.prepare(
            'SELECT * FROM wake_admissions WHERE coordination_scope_id = ? ORDER BY admitted_at, wake_batch_id',
          ),
          scopeId,
        )
      : many<WakeAdmissionRow>(
          db.prepare(
            `SELECT * FROM wake_admissions
             WHERE coordination_scope_id = ? AND coordinator_session_id = ?
             ORDER BY admitted_at, wake_batch_id`,
          ),
          scopeId,
          sessionId,
        );

  const readLeases = (scopeId: string): Decoded<readonly LeaseRecord[]> =>
    decodeRows(readLeaseRows(scopeId), decodeLeaseRow);

  const buildSnapshot = (scopeId: string, scope: ScopeRecord): Decoded<CoordinationSnapshot> => {
    const leases = readLeases(scopeId);
    if (!leases.ok) {
      return leases;
    }
    const sessions = decodeRows(readSessionRows(scopeId), decodeSessionRow);
    if (!sessions.ok) {
      return sessions;
    }
    const claims = decodeRows(readTicketClaimRows(scopeId), decodeTicketClaimRow);
    if (!claims.ok) {
      return claims;
    }
    const interactions = decodeRows(readInteractionRows(scopeId), decodeInteractionRow);
    if (!interactions.ok) {
      return interactions;
    }
    const intents = decodeRows(
      readIntentRows(scopeId).filter((row) => row.state === 'pending' || row.state === 'blocked'),
      decodeIntentRow,
    );
    if (!intents.ok) {
      return intents;
    }
    return ok({
      scope,
      sessions: sessions.value,
      leases: leases.value,
      executionLease:
        leases.value.find((lease) => lease.kind === 'execution_coordination' && lease.releasedAt === null) ?? null,
      ticketClaims: claims.value,
      pendingInteractions: interactions.value,
      unresolvedIntents: intents.value,
    });
  };

  const query = (input: CoordinationQuery): CoordinationQueryResult => {
    if (input.kind === 'scopes') {
      try {
        const rows = many<ScopeRow>(db.prepare('SELECT * FROM scope ORDER BY coordination_scope_id'));
        const scopes = decodeRows(rows, decodeScopeRow);
        if (!scopes.ok) {
          return { kind: 'rejected', code: 'unreadable', message: scopes.message };
        }
        return { kind: 'scopes', scopes: scopes.value };
      } catch (error) {
        return { kind: 'rejected', code: 'unreadable', message: describeError(error) };
      }
    }
    const scopeId = input.coordinationScopeId;
    if (scopeId.length === 0) {
      return { kind: 'rejected', code: 'invalid_query', message: 'coordinationScopeId 必须是非空字符串' };
    }
    try {
      switch (input.kind) {
        case 'scope': {
          const row = readScopeRow(scopeId);
          if (row === undefined) {
            return { kind: 'scope', scope: null };
          }
          const scope = decodeScopeRow(row);
          if (!scope.ok) {
            return { kind: 'rejected', code: 'unreadable', message: scope.message };
          }
          return { kind: 'scope', scope: scope.value };
        }
        case 'snapshot': {
          const row = readScopeRow(scopeId);
          if (row === undefined) {
            return { kind: 'rejected', code: 'invalid_query', message: `Scope ${scopeId} 不存在` };
          }
          const scope = decodeScopeRow(row);
          if (!scope.ok) {
            return { kind: 'rejected', code: 'unreadable', message: scope.message };
          }
          const snapshot = buildSnapshot(scopeId, scope.value);
          if (!snapshot.ok) {
            return { kind: 'rejected', code: 'unreadable', message: snapshot.message };
          }
          return { kind: 'snapshot', snapshot: snapshot.value };
        }
        case 'sessions': {
          const sessions = decodeRows(readSessionRows(scopeId), decodeSessionRow);
          if (!sessions.ok) {
            return { kind: 'rejected', code: 'unreadable', message: sessions.message };
          }
          return { kind: 'sessions', sessions: sessions.value };
        }
        case 'leases': {
          const leases = readLeases(scopeId);
          if (!leases.ok) {
            return { kind: 'rejected', code: 'unreadable', message: leases.message };
          }
          return { kind: 'leases', leases: leases.value };
        }
        case 'intents': {
          const intents = decodeRows(readIntentRows(scopeId, input.intentState), decodeIntentRow);
          if (!intents.ok) {
            return { kind: 'rejected', code: 'unreadable', message: intents.message };
          }
          return { kind: 'intents', intents: intents.value };
        }
        case 'intent': {
          const row = readIntentRow(scopeId, input.operationId);
          if (row === undefined) {
            return { kind: 'intent', intent: null };
          }
          const intent = decodeIntentRow(row);
          if (!intent.ok) {
            return { kind: 'rejected', code: 'unreadable', message: intent.message };
          }
          return { kind: 'intent', intent: intent.value };
        }
        case 'budget-counters':
          return { kind: 'budget-counters', counters: readBudgetRows(scopeId).map(decodeBudgetRow) };
        case 'wake-admissions': {
          const admissions = decodeRows(
            readWakeAdmissionRows(scopeId, input.coordinatorSessionId),
            decodeWakeAdmissionRow,
          );
          if (!admissions.ok) {
            return { kind: 'rejected', code: 'unreadable', message: admissions.message };
          }
          return { kind: 'wake-admissions', admissions: admissions.value };
        }
        default:
          return { kind: 'rejected', code: 'invalid_query', message: '未登记的 query variant' };
      }
    } catch (error) {
      return { kind: 'rejected', code: 'unreadable', message: describeError(error) };
    }
  };

  /** 执行权威：只有未释放的 Execution Coordination Lease 持有者可以推进执行事实。 */
  const executionHolderViolation = (scopeId: string, writer: CoordinationCommand['writer']): Decoded<null> => {
    const row = db
      .prepare(
        `SELECT * FROM leases
         WHERE coordination_scope_id = ? AND lease_kind = 'execution_coordination' AND released_at IS NULL`,
      )
      .get(scopeId) as LeaseRow | undefined;
    if (row === undefined || row.coordinator_session_id !== writer.coordinatorSessionId) {
      return fail('当前 Session 不是本 Scope 的 Execution Coordination Lease 持有者', 'constraint');
    }
    return ok(null);
  };

  const applyCommand = (
    cmd: CoordinationCommand,
    now: number,
    nextRevision: number,
  ): Decoded<null> => {
    switch (cmd.kind) {
      case 'create-scope': {
        db.prepare(
          `INSERT INTO scope (
             coordination_scope_id, mode, control_state, planning_cycle_id,
             graph_id, graph_version, authorization_id, authorization_version, revision, updated_at
           ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
        ).run(cmd.coordinationScopeId, cmd.mode, cmd.controlState, cmd.planningCycleId, nextRevision, now);
        return ok(null);
      }
      case 'update-scope-mode': {
        db.prepare(
          'UPDATE scope SET mode = ?, planning_cycle_id = ?, updated_at = ? WHERE coordination_scope_id = ?',
        ).run(cmd.mode, cmd.planningCycleId, now, cmd.coordinationScopeId);
        return ok(null);
      }
      case 'update-scope-refs': {
        const holder = executionHolderViolation(cmd.coordinationScopeId, cmd.writer);
        if (!holder.ok) {
          return holder;
        }
        db.prepare(
          `UPDATE scope SET graph_id = ?, graph_version = ?, authorization_id = ?, authorization_version = ?,
             updated_at = ? WHERE coordination_scope_id = ?`,
        ).run(
          cmd.graphId,
          cmd.graphVersion,
          cmd.authorizationId,
          cmd.authorizationVersion,
          now,
          cmd.coordinationScopeId,
        );
        return ok(null);
      }
      case 'record-control-state': {
        db.prepare('UPDATE scope SET control_state = ?, updated_at = ? WHERE coordination_scope_id = ?').run(
          cmd.controlState,
          now,
          cmd.coordinationScopeId,
        );
        return ok(null);
      }
      case 'register-session': {
        db.prepare(
          `INSERT INTO session_registry (
             coordination_scope_id, coordinator_session_id, coordinator_model_configuration_ref,
             lifecycle_state, registered_at
           ) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (coordination_scope_id, coordinator_session_id) DO UPDATE SET
             coordinator_model_configuration_ref = excluded.coordinator_model_configuration_ref,
             lifecycle_state = excluded.lifecycle_state`,
        ).run(
          cmd.coordinationScopeId,
          cmd.coordinatorSessionId,
          cmd.coordinatorModelConfigurationRef,
          cmd.lifecycleState,
          now,
        );
        return ok(null);
      }
      case 'record-ticket-claim': {
        db.prepare(
          `INSERT INTO ticket_claims (
             coordination_scope_id, ticket_kind, ticket_id, coordinator_session_id, state, claimed_at
           ) VALUES (?, ?, ?, ?, 'active', ?)`,
        ).run(
          cmd.coordinationScopeId,
          cmd.ticketRef.kind,
          cmd.ticketRef.id,
          cmd.writer.coordinatorSessionId,
          now,
        );
        return ok(null);
      }
      case 'release-ticket-claim': {
        const info = db
          .prepare(
            `UPDATE ticket_claims SET state = ?
             WHERE coordination_scope_id = ? AND ticket_kind = ? AND ticket_id = ? AND state = 'active'`,
          )
          .run(cmd.finalState, cmd.coordinationScopeId, cmd.ticketRef.kind, cmd.ticketRef.id);
        if (Number(info.changes) === 0) {
          return fail('该 ticket 没有可释放的活跃 claim');
        }
        return ok(null);
      }
      case 'record-pending-interaction': {
        db.prepare(
          `INSERT INTO pending_interactions (
             coordination_scope_id, interaction_id, owner_coordinator_session_id,
             subject_kind, subject_id, expected_revision, state, answer_kind, answer_id, created_at, resolved_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'open', NULL, NULL, ?, NULL)`,
        ).run(
          cmd.coordinationScopeId,
          cmd.interactionId,
          cmd.ownerCoordinatorSessionId,
          cmd.subjectRef.kind,
          cmd.subjectRef.id,
          cmd.expectedRevision,
          now,
        );
        return ok(null);
      }
      case 'resolve-pending-interaction': {
        const info = db
          .prepare(
            `UPDATE pending_interactions SET state = ?, answer_kind = ?, answer_id = ?, resolved_at = ?
             WHERE coordination_scope_id = ? AND interaction_id = ? AND state = 'open'`,
          )
          .run(
            cmd.state,
            cmd.answerRef === null ? null : cmd.answerRef.kind,
            cmd.answerRef === null ? null : cmd.answerRef.id,
            now,
            cmd.coordinationScopeId,
            cmd.interactionId,
          );
        if (Number(info.changes) === 0) {
          return fail('该 Pending Interaction 不存在或已被回答');
        }
        return ok(null);
      }
      case 'begin-intent': {
        const laneKey = laneKeyOf(cmd.target, cmd.operationCategory);
        db.prepare(
          `INSERT INTO operation_intents (
             coordination_scope_id, operation_id, target_kind, target_id, operation_category, lane_key,
             initiated_by_session_id, initiated_by_incarnation_id, expected_revision, state,
             outcome_class, backend_request_id, blocking_reason, created_at, settled_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, NULL)`,
        ).run(
          cmd.coordinationScopeId,
          cmd.operationId,
          cmd.target.kind,
          cmd.target.id,
          cmd.operationCategory,
          laneKey,
          cmd.writer.coordinatorSessionId,
          cmd.writer.runtimeIncarnationId,
          cmd.expectedRevision,
          now,
        );
        return ok(null);
      }
      case 'settle-intent': {
        const row = readIntentRow(cmd.coordinationScopeId, cmd.operationId);
        if (row === undefined) {
          return fail(`未登记的 OperationId ${cmd.operationId}`);
        }
        if (row.state !== 'pending') {
          return fail(`OperationId ${cmd.operationId} 处于 ${row.state}，不能按确定结果收尾`);
        }
        const backendRequestId = cmd.backendRequestId ?? null;
        if (cmd.outcomeClass === 'unknown') {
          // 未知结果保留未决：只补记 backend request 引用，不改变状态。
          db.prepare(
            `UPDATE operation_intents SET backend_request_id = COALESCE(?, backend_request_id)
             WHERE coordination_scope_id = ? AND operation_id = ?`,
          ).run(backendRequestId, cmd.coordinationScopeId, cmd.operationId);
          return ok(null);
        }
        db.prepare(
          `UPDATE operation_intents SET state = 'settled', outcome_class = ?, backend_request_id = ?,
             settled_at = ? WHERE coordination_scope_id = ? AND operation_id = ?`,
        ).run(cmd.outcomeClass, backendRequestId, now, cmd.coordinationScopeId, cmd.operationId);
        return ok(null);
      }
      case 'block-intent': {
        const row = readIntentRow(cmd.coordinationScopeId, cmd.operationId);
        if (row === undefined) {
          return fail(`未登记的 OperationId ${cmd.operationId}`);
        }
        if (row.state !== 'pending') {
          return fail(`OperationId ${cmd.operationId} 处于 ${row.state}，不能标记为阻塞`);
        }
        db.prepare(
          `UPDATE operation_intents SET state = 'blocked', blocking_reason = ?
           WHERE coordination_scope_id = ? AND operation_id = ?`,
        ).run(cmd.reason, cmd.coordinationScopeId, cmd.operationId);
        return ok(null);
      }
      case 'resolve-intent': {
        const row = readIntentRow(cmd.coordinationScopeId, cmd.operationId);
        if (row === undefined) {
          return fail(`未登记的 OperationId ${cmd.operationId}`);
        }
        if (row.state !== 'blocked') {
          return fail(`OperationId ${cmd.operationId} 处于 ${row.state}，只有阻塞的意图需要对账收尾`);
        }
        db.prepare(
          `UPDATE operation_intents SET state = 'settled', outcome_class = ?, backend_request_id = ?,
             blocking_reason = NULL, settled_at = ? WHERE coordination_scope_id = ? AND operation_id = ?`,
        ).run(cmd.outcomeClass, cmd.backendRequestId ?? null, now, cmd.coordinationScopeId, cmd.operationId);
        return ok(null);
      }
      case 'acquire-runtime-lease': {
        const registered = db
          .prepare(
            `SELECT 1 FROM session_registry
             WHERE coordination_scope_id = ? AND coordinator_session_id = ?`,
          )
          .get(cmd.coordinationScopeId, cmd.writer.coordinatorSessionId);
        if (registered === undefined) {
          return fail('取得 Runtime Lease 前必须先注册 Coordinator Session', 'constraint');
        }
        const existing = readRuntimeLeaseRow(cmd.coordinationScopeId, cmd.writer.coordinatorSessionId);
        if (existing !== undefined) {
          const lease = decodeLeaseRow(existing);
          if (!lease.ok) {
            return lease;
          }
          if (isLeaseActive(lease.value, now)) {
            return fail('该 Session 的 Runtime Lease 仍由当前 incarnation 持有', 'constraint');
          }
        }
        db.prepare(
          `INSERT INTO leases (
             coordination_scope_id, lease_kind, coordinator_session_id, runtime_incarnation_id,
             fencing_generation, acquired_at, expires_at, released_at
           ) VALUES (?, 'runtime', ?, ?, ?, ?, ?, NULL)
           ON CONFLICT (coordination_scope_id, lease_kind, coordinator_session_id) DO UPDATE SET
             runtime_incarnation_id = excluded.runtime_incarnation_id,
             fencing_generation = excluded.fencing_generation,
             acquired_at = excluded.acquired_at,
             expires_at = excluded.expires_at,
             released_at = NULL`,
        ).run(
          cmd.coordinationScopeId,
          cmd.writer.coordinatorSessionId,
          cmd.writer.runtimeIncarnationId,
          nextFencingGeneration(existing?.fencing_generation ?? null),
          now,
          now + cmd.ttlMs,
        );
        return ok(null);
      }
      case 'renew-runtime-lease': {
        const existing = readRuntimeLeaseRow(cmd.coordinationScopeId, cmd.writer.coordinatorSessionId);
        if (existing === undefined) {
          return fail('该 Session 还没有 Runtime Lease，必须先取得');
        }
        db.prepare(
          `UPDATE leases SET expires_at = ?
           WHERE coordination_scope_id = ? AND lease_kind = 'runtime' AND coordinator_session_id = ?`,
        ).run(now + cmd.ttlMs, cmd.coordinationScopeId, cmd.writer.coordinatorSessionId);
        return ok(null);
      }
      case 'acquire-execution-lease': {
        const active = db
          .prepare(
            `SELECT * FROM leases
             WHERE coordination_scope_id = ? AND lease_kind = 'execution_coordination' AND released_at IS NULL`,
          )
          .get(cmd.coordinationScopeId) as LeaseRow | undefined;
        if (active !== undefined && active.coordinator_session_id !== cmd.writer.coordinatorSessionId) {
          return fail('Execution Coordination Lease 已由其它 Coordinator Session 持有', 'constraint');
        }
        const maxRow = db
          .prepare(
            `SELECT MAX(fencing_generation) AS generation FROM leases
             WHERE coordination_scope_id = ? AND lease_kind = 'execution_coordination'`,
          )
          .get(cmd.coordinationScopeId) as { readonly generation: number | null } | undefined;
        db.prepare(
          `INSERT INTO leases (
             coordination_scope_id, lease_kind, coordinator_session_id, runtime_incarnation_id,
             fencing_generation, acquired_at, expires_at, released_at
           ) VALUES (?, 'execution_coordination', ?, ?, ?, ?, NULL, NULL)
           ON CONFLICT (coordination_scope_id, lease_kind, coordinator_session_id) DO UPDATE SET
             runtime_incarnation_id = excluded.runtime_incarnation_id,
             fencing_generation = excluded.fencing_generation,
             acquired_at = excluded.acquired_at,
             expires_at = NULL,
             released_at = NULL`,
        ).run(
          cmd.coordinationScopeId,
          cmd.writer.coordinatorSessionId,
          cmd.writer.runtimeIncarnationId,
          nextFencingGeneration(maxRow?.generation ?? null),
          now,
        );
        return ok(null);
      }
      case 'release-execution-lease': {
        const active = db
          .prepare(
            `SELECT * FROM leases
             WHERE coordination_scope_id = ? AND lease_kind = 'execution_coordination' AND released_at IS NULL`,
          )
          .get(cmd.coordinationScopeId) as LeaseRow | undefined;
        if (active === undefined || active.coordinator_session_id !== cmd.writer.coordinatorSessionId) {
          return fail('只有当前 Execution Coordination Lease 持有者可以释放它', 'constraint');
        }
        db.prepare(
          `UPDATE leases SET released_at = ?
           WHERE coordination_scope_id = ? AND lease_kind = 'execution_coordination' AND coordinator_session_id = ?`,
        ).run(now, cmd.coordinationScopeId, cmd.writer.coordinatorSessionId);
        return ok(null);
      }
      case 'release-runtime-lease': {
        const existing = readRuntimeLeaseRow(cmd.coordinationScopeId, cmd.writer.coordinatorSessionId);
        if (existing === undefined) {
          return fail('该 Session 还没有 Runtime Lease');
        }
        // 只标记释放，不删行：删行会让作废的 generation 重新可用。
        db.prepare(
          `UPDATE leases SET released_at = ?
           WHERE coordination_scope_id = ? AND lease_kind = 'runtime' AND coordinator_session_id = ?`,
        ).run(now, cmd.coordinationScopeId, cmd.writer.coordinatorSessionId);
        return ok(null);
      }
      case 'consume-budget': {
        const holder = executionHolderViolation(cmd.coordinationScopeId, cmd.writer);
        if (!holder.ok) {
          return holder;
        }
        const existing = db
          .prepare('SELECT * FROM budget_counters WHERE coordination_scope_id = ? AND budget_key = ?')
          .get(cmd.coordinationScopeId, cmd.budgetKey) as BudgetRow | undefined;
        if (existing !== undefined && existing.approved_limit_ref !== cmd.approvedLimitRef) {
          return fail('已登记的预算授权上限引用与本次不一致，拒绝在同一计数上叠加');
        }
        db.prepare(
          `INSERT INTO budget_counters (coordination_scope_id, budget_key, approved_limit_ref, consumed)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (coordination_scope_id, budget_key) DO UPDATE SET consumed = consumed + excluded.consumed`,
        ).run(cmd.coordinationScopeId, cmd.budgetKey, cmd.approvedLimitRef, cmd.amount);
        return ok(null);
      }
      case 'record-wake-admission': {
        // 主键冲突由通用约束错误路径转成结构化拒绝；调用方按只读查询还原既有 admission。
        db.prepare(
          `INSERT INTO wake_admissions (
             coordination_scope_id, coordinator_session_id, wake_batch_id,
             admission_state, source_revisions, admitted_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          cmd.coordinationScopeId,
          cmd.writer.coordinatorSessionId,
          cmd.wakeBatchId,
          cmd.admissionState,
          JSON.stringify(cmd.sourceRevisions),
          now,
        );
        return ok(null);
      }
      default:
        return fail('未登记的 command variant');
    }
  };

  const transact = (input: CoordinationCommand): CoordinationCommandResult => {
    if (readOnly) {
      return rejected('invalid_state', '只读打开的 store 不执行写入');
    }
    const decoded = decodeCommand(input);
    if (!decoded.ok) {
      return rejected('invalid_state', decoded.message);
    }
    const cmd = decoded.value;
    const now = clock();

    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (error) {
      return rejected('invalid_state', describeError(error));
    }

    const rollback = (): void => {
      try {
        db.exec('ROLLBACK');
      } catch {
        // 事务已不可用；以原始拒绝原因为准。
      }
    };

    try {
      const scopeRow = readScopeRow(cmd.coordinationScopeId);
      const currentRevision = scopeRow?.revision ?? ABSENT_SCOPE_REVISION;
      const revisionCheck = checkExpectedRevision(cmd.expectedRevision, currentRevision);
      if (revisionCheck.kind === 'stale') {
        rollback();
        return {
          kind: 'rejected',
          code: 'stale_revision',
          message: `expected revision ${revisionCheck.expected} 已过期，当前为 ${revisionCheck.current}`,
          currentRevision: revisionCheck.current,
        };
      }

      if (cmd.kind === 'create-scope') {
        if (scopeRow !== undefined) {
          rollback();
          return rejected('constraint', `Scope ${cmd.coordinationScopeId} 已存在`);
        }
      } else {
        if (scopeRow === undefined) {
          rollback();
          return rejected('invalid_state', `Scope ${cmd.coordinationScopeId} 尚未创建`);
        }
        // Scope 创建、首个 Session 注册与首次取得 Runtime Lease 构成唯一 bootstrap 窗口。
        // 一旦 Scope 出现 Runtime Lease，所有其它共享写入都必须来自当前活跃 incarnation。
        if (cmd.kind !== 'acquire-runtime-lease') {
          const runtimeLeaseRow = readRuntimeLeaseRow(cmd.coordinationScopeId, cmd.writer.coordinatorSessionId);
          const bootstrapRegistration =
            cmd.kind === 'register-session' &&
            cmd.coordinatorSessionId === cmd.writer.coordinatorSessionId &&
            readLeaseRows(cmd.coordinationScopeId).every((row) => row.lease_kind !== 'runtime');
          if (runtimeLeaseRow === undefined && !bootstrapRegistration) {
            rollback();
            return rejected('fenced', '写入者没有活跃 Runtime Lease');
          }
          let runtimeLease: LeaseRecord | undefined;
          if (runtimeLeaseRow !== undefined) {
            const decodedLease = decodeLeaseRow(runtimeLeaseRow);
            if (!decodedLease.ok) {
              rollback();
              return rejected('invalid_state', decodedLease.message);
            }
            runtimeLease = decodedLease.value;
          }
          const violation = findFenceViolation(
            runtimeLease,
            {
              runtimeIncarnationId: cmd.writer.runtimeIncarnationId,
              fencingGeneration: cmd.writer.fencingGeneration,
            },
            now,
          );
          if (violation !== undefined) {
            rollback();
            return rejected('fenced', `写入者已被 fencing 拒绝（${violation.code}）`);
          }
        }
      }

      const advancesRevision = cmd.kind !== 'renew-runtime-lease';
      const nextRevision = advancesRevision ? advanceRevision(currentRevision) : currentRevision;
      const applied = applyCommand(cmd, now, nextRevision);
      if (!applied.ok) {
        rollback();
        return rejected(applied.code, applied.message);
      }
      if (advancesRevision && cmd.kind !== 'create-scope') {
        db.prepare('UPDATE scope SET revision = ?, updated_at = ? WHERE coordination_scope_id = ?').run(
          nextRevision,
          now,
          cmd.coordinationScopeId,
        );
      }
      db.exec('COMMIT');
      return { kind: 'committed', revision: nextRevision };
    } catch (error) {
      rollback();
      if (isConstraintError(error)) {
        return rejected('constraint', describeError(error));
      }
      return rejected('invalid_state', describeError(error));
    }
  };

  const store: CoordinationStore = {
    query,
    transact,
    close: () => {
      db.close();
    },
  };
  return { kind: 'opened', store };
}
