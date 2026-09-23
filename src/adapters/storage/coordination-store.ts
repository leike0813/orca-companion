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
import { projectMutationLanes } from '../../domain/coordination/mutation-lane.js';
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
import type { DeliveryVerdict } from '../../domain/delivery-verdict.js';
import {
  DESCENDANT_DISPOSITIONS,
  type PatchDescendantDisposition,
  type PatchResponsibilityTakeover,
} from '../../domain/execution/graph-patch.js';
import { INHERITABLE_BUDGET_FIELDS } from '../../domain/execution/work-package-lineage.js';
import type {
  ExecutionGraph,
  GraphVersionRecord,
  ScopeEnvelope,
  WorkPackage,
  WorkPackageBudget,
} from '../../domain/planning/execution-graph.js';
import { GRAPH_VERSION_RECORD_KINDS, isGraphVersionRecordKind } from '../../domain/planning/execution-graph.js';
import {
  parseManifest,
  WORKER_ROLES,
  type ExecutionAuthorizationManifest,
  type ExecutionAuthorizationRecord,
  type WorkerRole,
} from '../../domain/planning/execution-authorization.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  DispatchId,
  EntityRef,
  GraphGeneration,
  GraphId,
  GraphVersion,
  InteractionId,
  OperationId,
  PlanningCycleId,
  RecoveryId,
  RuntimeIncarnationId,
  SessionSegmentId,
  WorkerTaskId,
  WorkPackageId,
} from '../../application/dto/identity.js';
import {
  BASELINE_ADOPTION_KINDS,
  BASELINE_ADOPTION_STATES,
  BASELINE_RECONCILIATION_STATES,
  GRAPH_GENERATION_STATUSES,
  GRAPH_GENERATION_TRANSITIONS,
  PENDING_INTERACTION_STATES,
  PLANNING_HANDOFF_PHASES,
  PLANNING_HANDOFF_TRANSITIONS,
  EXECUTION_HANDOFF_PHASES,
  EXECUTION_HANDOFF_TRANSITIONS,
  HANDOFF_RESPONSIBILITIES,
  RECOVERY_STATES,
  RECOVERY_TERMINAL_OUTCOMES,
  RECOVERY_TRANSITIONS,
  REVISION_HOLD_SOURCES,
  REVISION_HOLD_STATES,
  SESSION_LIFECYCLE_STATES,
  TICKET_CLAIM_STATES,
  WAKE_ADMISSION_STATES,
  type BaselineAdoptionRecord,
  type BaselineReconciliationRecord,
  type BranchCoordinationStore,
  type BudgetConsumptionInput,
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
  type DeliverySettlementRecord,
  type DeliveryVerdictRecord,
  type ExecutionHandoffPhase,
  type ExecutionHandoffRecord,
  type GraphGenerationRecord,
  type GraphPatchRecord,
  type GraphVersionPatchInput,
  type HandoffResponsibility,
  type InheritedBudgetEntry,
  type MaterializationBindingRecord,
  type PendingInteractionRecord,
  type PendingInteractionState,
  type PlanningHandoffPhase,
  type PlanningHandoffRecord,
  type PlanningResponsibilityRecord,
  type RecoveryRecord,
  type RecoveryState,
  type RecoveryTerminalOutcome,
  type ReplacementSegmentInput,
  type RevisionHoldRecord,
  type ScopeRecord,
  type SessionLifecycleState,
  type SessionSegmentRecord,
  type TicketClaimRecord,
  type TicketClaimState,
  type WakeAdmissionRecord,
  type WakeAdmissionState,
  type WorkPackageLineageRecord,
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

function requireStringArray(raw: unknown, field: string): Decoded<readonly string[]> {
  if (!Array.isArray(raw)) {
    return fail(`${field} 必须是数组`);
  }
  const values: string[] = [];
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== 'string' || entry.length === 0) {
      return fail(`${field}.${index} 必须是非空字符串`);
    }
    values.push(entry);
  }
  return ok(values);
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

/**
 * 可选补丁字段的三态：`undefined` 表示保持原值，`null` 表示清空，给出值表示覆盖。
 *
 * `requireNullableString` 把 undefined 与 null 都读成清空，无法表达「保持原值」，因此这里单独建模。
 */
type OptionalPatch<T> = { readonly present: boolean; readonly value: T | null };

function decodeStringPatch(raw: unknown, field: string): Decoded<OptionalPatch<string>> {
  if (raw === undefined) {
    return ok({ present: false, value: null });
  }
  if (raw === null) {
    return ok({ present: true, value: null });
  }
  const parsed = requireString(raw, field);
  return parsed.ok ? ok({ present: true, value: parsed.value }) : parsed;
}

function decodeEnumPatch<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  field: string,
): Decoded<OptionalPatch<T>> {
  if (raw === undefined) {
    return ok({ present: false, value: null });
  }
  if (raw === null) {
    return ok({ present: true, value: null });
  }
  const parsed = requireEnum(raw, allowed, field);
  return parsed.ok ? ok({ present: true, value: parsed.value }) : parsed;
}

/**
 * 替代 Session Segment 的边界校验：字段与 `record-session-segment` 完全一致，因此沿用同一套规则
 * （`sessionBindingId` 必须给出字符串，空字符串表示无法证明身份这一事实本身）。
 */
function decodeReplacementSegment(raw: unknown, field: string): Decoded<ReplacementSegmentInput | null> {
  if (raw === undefined || raw === null) {
    return ok(null);
  }
  if (!isRecord(raw)) {
    return fail(`${field} 必须是对象`);
  }
  const segmentId = requireString(raw['segmentId'], `${field}.segmentId`);
  if (!segmentId.ok) {
    return segmentId;
  }
  const workPackageId = requireString(raw['workPackageId'], `${field}.workPackageId`);
  if (!workPackageId.ok) {
    return workPackageId;
  }
  const role = requireEnum(raw['role'], WORKER_ROLES, `${field}.role`);
  if (!role.ok) {
    return role;
  }
  const workerTaskId = requireString(raw['workerTaskId'], `${field}.workerTaskId`);
  if (!workerTaskId.ok) {
    return workerTaskId;
  }
  const dispatchId = requireString(raw['dispatchId'], `${field}.dispatchId`);
  if (!dispatchId.ok) {
    return dispatchId;
  }
  const attemptId = requireString(raw['attemptId'], `${field}.attemptId`);
  if (!attemptId.ok) {
    return attemptId;
  }
  const sessionBindingId = requireNullableString(raw['sessionBindingId'], `${field}.sessionBindingId`);
  if (!sessionBindingId.ok || sessionBindingId.value === null) {
    return fail(`${field}.sessionBindingId 必须是字符串（空字符串表示无法证明身份）`);
  }
  const lastTranscriptRef = requireNullableString(raw['lastTranscriptRef'], `${field}.lastTranscriptRef`);
  if (!lastTranscriptRef.ok) {
    return lastTranscriptRef;
  }
  const terminalReceiptRef = requireNullableString(raw['terminalReceiptRef'], `${field}.terminalReceiptRef`);
  if (!terminalReceiptRef.ok) {
    return terminalReceiptRef;
  }
  if (typeof raw['transcriptReferenceable'] !== 'boolean') {
    return fail(`${field}.transcriptReferenceable 必须是布尔值`);
  }
  if (typeof raw['verifiable'] !== 'boolean') {
    return fail(`${field}.verifiable 必须是布尔值`);
  }
  return ok({
    segmentId: segmentId.value as SessionSegmentId,
    workPackageId: workPackageId.value as WorkPackageId,
    role: role.value,
    workerTaskId: workerTaskId.value as WorkerTaskId,
    dispatchId: dispatchId.value as DispatchId,
    attemptId: attemptId.value,
    sessionBindingId: sessionBindingId.value,
    lastTranscriptRef: lastTranscriptRef.value,
    terminalReceiptRef: terminalReceiptRef.value,
    transcriptReferenceable: raw['transcriptReferenceable'],
    verifiable: raw['verifiable'],
  });
}

/** cutover 责任集合的边界校验：闭集取值、非空，未知取值 fail closed。 */
function decodeHandoffResponsibilitySet(
  raw: unknown,
  field: string,
): Decoded<readonly HandoffResponsibility[]> {
  if (!Array.isArray(raw)) {
    return fail(`${field} 必须是数组`);
  }
  if (raw.length === 0) {
    return fail(`${field} 不得为空`);
  }
  const values: HandoffResponsibility[] = [];
  for (const [index, entry] of raw.entries()) {
    const parsed = requireEnum(entry, HANDOFF_RESPONSIBILITIES, `${field}.${index}`);
    if (!parsed.ok) {
      return parsed;
    }
    values.push(parsed.value);
  }
  return ok(values);
}

/**
 * Execution Graph 的读写边界校验。
 *
 * 图在写入前已经过一次同样的校验，读取时再校验一次不是冗余：JSON 负载可能在旧实现、外部工具或
 * 手工修复下变形，而「读出一个字段缺失的图」比直接失败危险得多。
 */
function requireBoolean(raw: unknown, field: string): Decoded<boolean> {
  if (typeof raw !== 'boolean') {
    return fail(`${field} 必须是布尔值`);
  }
  return ok(raw);
}

function decodeDescendantDispositions(
  raw: unknown,
  field: string,
): Decoded<readonly PatchDescendantDisposition[]> {
  if (!Array.isArray(raw)) {
    return fail(`${field} 必须是数组`);
  }
  const values: PatchDescendantDisposition[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry)) {
      return fail(`${field}.${index} 必须是对象`);
    }
    const workPackageId = requireString(entry['workPackageId'], `${field}.${index}.workPackageId`);
    if (!workPackageId.ok) {
      return workPackageId;
    }
    const disposition = requireEnum(
      entry['disposition'],
      DESCENDANT_DISPOSITIONS,
      `${field}.${index}.disposition`,
    );
    if (!disposition.ok) {
      return disposition;
    }
    values.push({ workPackageId: workPackageId.value as WorkPackageId, disposition: disposition.value });
  }
  return ok(values);
}

function decodeTakeovers(raw: unknown, field: string): Decoded<readonly PatchResponsibilityTakeover[]> {
  if (!Array.isArray(raw)) {
    return fail(`${field} 必须是数组`);
  }
  const values: PatchResponsibilityTakeover[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry)) {
      return fail(`${field}.${index} 必须是对象`);
    }
    const workPackageId = requireString(entry['workPackageId'], `${field}.${index}.workPackageId`);
    if (!workPackageId.ok) {
      return workPackageId;
    }
    const takesOverByKey = requireString(entry['takesOverByKey'], `${field}.${index}.takesOverByKey`);
    if (!takesOverByKey.ok) {
      return takesOverByKey;
    }
    values.push({
      workPackageId: workPackageId.value as WorkPackageId,
      takesOverByKey: takesOverByKey.value,
    });
  }
  return ok(values);
}

function decodeInheritedBudget(raw: unknown, field: string): Decoded<readonly InheritedBudgetEntry[]> {
  if (!Array.isArray(raw)) {
    return fail(`${field} 必须是数组`);
  }
  const values: InheritedBudgetEntry[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry)) {
      return fail(`${field}.${index} 必须是对象`);
    }
    const fieldName = requireEnum(entry['field'], INHERITABLE_BUDGET_FIELDS, `${field}.${index}.field`);
    if (!fieldName.ok) {
      return fieldName;
    }
    if (seen.has(fieldName.value)) {
      return fail(`${field} 中的 ${fieldName.value} 重复`);
    }
    seen.add(fieldName.value);
    const consumed = requireCount(entry['consumed'], `${field}.${index}.consumed`);
    if (!consumed.ok) {
      return consumed;
    }
    values.push({ field: fieldName.value, consumed: consumed.value });
  }
  return ok(values);
}

/** 补丁元数据负载：图体不在其中，因此读取它不会产生第二份图。 */
function decodeGraphPatchPayload(
  raw: unknown,
  field: string,
): Decoded<Omit<GraphPatchRecord, 'coordinationScopeId' | 'graphId' | 'graphVersion'>> {
  if (!isRecord(raw)) {
    return fail(`${field} 必须是对象`);
  }
  const patchId = requireString(raw['patchId'], `${field}.patchId`);
  if (!patchId.ok) {
    return patchId;
  }
  const operationId = requireString(raw['operationId'], `${field}.operationId`);
  if (!operationId.ok) {
    return operationId;
  }
  const baseGraphVersion = requireCount(raw['baseGraphVersion'], `${field}.baseGraphVersion`);
  if (!baseGraphVersion.ok) {
    return baseGraphVersion;
  }
  const added = requireStringArray(raw['added'], `${field}.added`);
  if (!added.ok) {
    return added;
  }
  const revised = requireStringArray(raw['revised'], `${field}.revised`);
  if (!revised.ok) {
    return revised;
  }
  const retired = requireStringArray(raw['retired'], `${field}.retired`);
  if (!retired.ok) {
    return retired;
  }
  const descendants = decodeDescendantDispositions(raw['descendants'], `${field}.descendants`);
  if (!descendants.ok) {
    return descendants;
  }
  const takesOver = decodeTakeovers(raw['takesOver'], `${field}.takesOver`);
  if (!takesOver.ok) {
    return takesOver;
  }
  return ok({
    patchId: patchId.value,
    operationId: operationId.value as OperationId,
    baseGraphVersion: baseGraphVersion.value as GraphVersion,
    added: added.value.map((id) => id as WorkPackageId),
    revised: revised.value.map((id) => id as WorkPackageId),
    retired: retired.value.map((id) => id as WorkPackageId),
    descendants: descendants.value,
    takesOver: takesOver.value,
  });
}

/** 写入前的补丁元数据校验：`initial` 不带补丁，`accepted_revision` 必须完整。 */
function decodeGraphVersionPatchInput(raw: unknown, field: string): Decoded<GraphVersionPatchInput | null> {
  if (raw === null || raw === undefined) {
    return ok(null);
  }
  const payload = decodeGraphPatchPayload(raw, field);
  if (!payload.ok) {
    return payload;
  }
  const pending = requireStringArray(
    isRecord(raw) ? raw['revisionPendingWorkPackageIds'] : undefined,
    `${field}.revisionPendingWorkPackageIds`,
  );
  if (!pending.ok) {
    return pending;
  }
  return ok({
    ...payload.value,
    revisionPendingWorkPackageIds: pending.value.map((id) => id as WorkPackageId),
  });
}

/** 与追加同事务写入的预算扣减载荷；省略即不消耗。 */
function decodeBudgetConsumptionInput(
  raw: unknown,
  field: string,
): Decoded<readonly BudgetConsumptionInput[] | undefined> {
  if (raw === undefined) {
    return ok(undefined);
  }
  if (!Array.isArray(raw)) {
    return fail(`${field} 必须是数组`);
  }
  const values: BudgetConsumptionInput[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry)) {
      return fail(`${field}.${index} 必须是对象`);
    }
    const budgetKey = requireString(entry['budgetKey'], `${field}.${index}.budgetKey`);
    if (!budgetKey.ok) {
      return budgetKey;
    }
    const approvedLimitRef = requireString(entry['approvedLimitRef'], `${field}.${index}.approvedLimitRef`);
    if (!approvedLimitRef.ok) {
      return approvedLimitRef;
    }
    const amount = requireCount(entry['amount'], `${field}.${index}.amount`);
    if (!amount.ok) {
      return amount;
    }
    if (amount.value === 0) {
      return fail(`${field}.${index}.amount 必须大于 0`);
    }
    values.push({ budgetKey: budgetKey.value, approvedLimitRef: approvedLimitRef.value, amount: amount.value });
  }
  return ok(values);
}

function decodeScopeEnvelope(raw: unknown, field: string): Decoded<ScopeEnvelope> {
  if (!isRecord(raw)) {
    return fail(`${field} 必须是对象`);
  }
  const include = requireStringArray(raw['include'], `${field}.include`);
  if (!include.ok) {
    return include;
  }
  const exclude = requireStringArray(raw['exclude'], `${field}.exclude`);
  if (!exclude.ok) {
    return exclude;
  }
  return ok({ include: include.value, exclude: exclude.value });
}

function decodeWorkPackageBudget(raw: unknown, field: string): Decoded<WorkPackageBudget> {
  if (!isRecord(raw)) {
    return fail(`${field} 必须是对象`);
  }
  const keys = [
    'implementationAttempts',
    'validatorRepairs',
    'graphRevisions',
    'specificationRevisions',
    'maxRecoveriesPerWorkerAttempt',
  ] as const;
  const values: Record<string, number> = {};
  for (const key of keys) {
    const parsed = requireCount(raw[key], `${field}.${key}`);
    if (!parsed.ok) {
      return parsed;
    }
    values[key] = parsed.value;
  }
  return ok({
    implementationAttempts: values['implementationAttempts'] ?? 0,
    validatorRepairs: values['validatorRepairs'] ?? 0,
    graphRevisions: values['graphRevisions'] ?? 0,
    specificationRevisions: values['specificationRevisions'] ?? 0,
    maxRecoveriesPerWorkerAttempt: values['maxRecoveriesPerWorkerAttempt'] ?? 0,
  });
}

function decodeWorkPackage(raw: unknown, field: string): Decoded<WorkPackage> {
  if (!isRecord(raw)) {
    return fail(`${field} 必须是对象`);
  }
  const workPackageId = requireString(raw['workPackageId'], `${field}.workPackageId`);
  if (!workPackageId.ok) {
    return workPackageId;
  }
  const title = requireString(raw['title'], `${field}.title`);
  if (!title.ok) {
    return title;
  }
  const dependsOn = requireStringArray(raw['dependsOn'], `${field}.dependsOn`);
  if (!dependsOn.ok) {
    return dependsOn;
  }
  const scopeEnvelope = decodeScopeEnvelope(raw['scopeEnvelope'], `${field}.scopeEnvelope`);
  if (!scopeEnvelope.ok) {
    return scopeEnvelope;
  }
  const budget = decodeWorkPackageBudget(raw['budget'], `${field}.budget`);
  if (!budget.ok) {
    return budget;
  }
  return ok({
    workPackageId: workPackageId.value as WorkPackageId,
    title: title.value,
    dependsOn: dependsOn.value.map((value) => value as WorkPackageId),
    scopeEnvelope: scopeEnvelope.value,
    budget: budget.value,
  });
}

function decodeExecutionGraph(raw: unknown, field: string): Decoded<ExecutionGraph> {
  if (!isRecord(raw)) {
    return fail(`${field} 必须是对象`);
  }
  const graphId = requireString(raw['graphId'], `${field}.graphId`);
  if (!graphId.ok) {
    return graphId;
  }
  const generation = requireCount(raw['generation'], `${field}.generation`);
  if (!generation.ok) {
    return generation;
  }
  const concurrencyLimit = requireCount(raw['concurrencyLimit'], `${field}.concurrencyLimit`);
  if (!concurrencyLimit.ok) {
    return concurrencyLimit;
  }
  const rawWorkPackages = raw['workPackages'];
  if (!Array.isArray(rawWorkPackages)) {
    return fail(`${field}.workPackages 必须是数组`);
  }
  const workPackages: WorkPackage[] = [];
  for (const [index, entry] of rawWorkPackages.entries()) {
    const decoded = decodeWorkPackage(entry, `${field}.workPackages.${index}`);
    if (!decoded.ok) {
      return decoded;
    }
    workPackages.push(decoded.value);
  }
  return ok({
    graphId: graphId.value as GraphId,
    generation: generation.value as GraphGeneration,
    concurrencyLimit: concurrencyLimit.value,
    workPackages,
  });
}

function decodeManifestInput(raw: unknown, field: string): Decoded<ExecutionAuthorizationManifest> {
  const parsed = parseManifest(raw, field);
  return parsed.ok ? ok(parsed.value) : fail(`${parsed.field}: ${parsed.message}`);
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
      const fullBranchRef = requireString(command['fullBranchRef'], 'fullBranchRef');
      if (!fullBranchRef.ok) {
        return fullBranchRef;
      }
      const canonicalWorktreePath = requireString(command['canonicalWorktreePath'], 'canonicalWorktreePath');
      if (!canonicalWorktreePath.ok) {
        return canonicalWorktreePath;
      }
      return ok({
        ...base,
        kind: 'create-scope',
        mode: mode.value,
        controlState: control.value,
        planningCycleId: cycle.value as PlanningCycleId | null,
        fullBranchRef: fullBranchRef.value,
        canonicalWorktreePath: canonicalWorktreePath.value,
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
    case 'update-session-model-configuration': {
      const sessionId = requireString(command['coordinatorSessionId'], 'coordinatorSessionId');
      if (!sessionId.ok) {
        return sessionId;
      }
      const configurationRef = requireString(
        command['coordinatorModelConfigurationRef'],
        'coordinatorModelConfigurationRef',
      );
      if (!configurationRef.ok) {
        return configurationRef;
      }
      return ok({
        ...base,
        kind: 'update-session-model-configuration',
        coordinatorSessionId: sessionId.value as CoordinatorSessionId,
        coordinatorModelConfigurationRef: configurationRef.value,
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
      const answerText = requireNullableString(command['answerText'], 'answerText');
      if (!answerText.ok) {
        return answerText;
      }
      return ok({
        ...base,
        kind: 'resolve-pending-interaction',
        interactionId: interactionId.value as InteractionId,
        state: state.value,
        answerRef: answerRef.value,
        answerText: answerText.value,
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
      const expectedHead = requireNullableString(command['expectedHead'], 'expectedHead');
      if (!expectedHead.ok) {
        return expectedHead;
      }
      return ok({
        ...base,
        kind: 'begin-intent',
        operationId: operationId.value as OperationId,
        target: target.value,
        operationCategory: category.value,
        ...(expectedHead.value === null ? {} : { expectedHead: expectedHead.value }),
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
    case 'initialize-scope': {
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
      const sessionId = requireString(command['coordinatorSessionId'], 'coordinatorSessionId');
      if (!sessionId.ok) {
        return sessionId;
      }
      const configurationRef = requireString(
        command['coordinatorModelConfigurationRef'],
        'coordinatorModelConfigurationRef',
      );
      if (!configurationRef.ok) {
        return configurationRef;
      }
      const fullBranchRef = requireString(command['fullBranchRef'], 'fullBranchRef');
      if (!fullBranchRef.ok) {
        return fullBranchRef;
      }
      const canonicalWorktreePath = requireString(command['canonicalWorktreePath'], 'canonicalWorktreePath');
      if (!canonicalWorktreePath.ok) {
        return canonicalWorktreePath;
      }
      return ok({
        ...base,
        kind: 'initialize-scope',
        mode: mode.value,
        controlState: control.value,
        planningCycleId: cycle.value as PlanningCycleId | null,
        coordinatorSessionId: sessionId.value as CoordinatorSessionId,
        coordinatorModelConfigurationRef: configurationRef.value,
        fullBranchRef: fullBranchRef.value,
        canonicalWorktreePath: canonicalWorktreePath.value,
      });
    }
    case 'bind-scope-identity': {
      const fullBranchRef = requireString(command['fullBranchRef'], 'fullBranchRef');
      if (!fullBranchRef.ok) {
        return fullBranchRef;
      }
      const canonicalWorktreePath = requireString(command['canonicalWorktreePath'], 'canonicalWorktreePath');
      if (!canonicalWorktreePath.ok) {
        return canonicalWorktreePath;
      }
      return ok({
        ...base,
        kind: 'bind-scope-identity',
        fullBranchRef: fullBranchRef.value,
        canonicalWorktreePath: canonicalWorktreePath.value,
      });
    }
    case 'record-graph-version': {
      const graphId = requireString(command['graphId'], 'graphId');
      if (!graphId.ok) {
        return graphId;
      }
      const generation = requireCount(command['generation'], 'generation');
      if (!generation.ok) {
        return generation;
      }
      const graphVersion = requireCount(command['graphVersion'], 'graphVersion');
      if (!graphVersion.ok || graphVersion.value === 0) {
        return fail('graphVersion 必须是正的安全整数');
      }
      const recordKind = requireEnum(command['recordKind'], GRAPH_VERSION_RECORD_KINDS, 'recordKind');
      if (!recordKind.ok) {
        return recordKind;
      }
      const parentVersion = requireNullableCount(command['parentVersion'], 'parentVersion');
      if (!parentVersion.ok) {
        return parentVersion;
      }
      const mapRevision = requireCount(command['mapRevision'], 'mapRevision');
      if (!mapRevision.ok) {
        return mapRevision;
      }
      const planRevision = requireCount(command['planRevision'], 'planRevision');
      if (!planRevision.ok) {
        return planRevision;
      }
      const orcaRunId = requireString(command['orcaRunId'], 'orcaRunId');
      if (!orcaRunId.ok) {
        return orcaRunId;
      }
      const graph = decodeExecutionGraph(command['graph'], 'graph');
      if (!graph.ok) {
        return graph;
      }
      if (graph.value.graphId !== graphId.value || graph.value.generation !== generation.value) {
        return fail('graph 负载与 graphId/generation 不一致');
      }
      const patch = decodeGraphVersionPatchInput(command['patch'], 'patch');
      if (!patch.ok) {
        return patch;
      }
      if (recordKind.value === 'initial' && patch.value !== null) {
        return fail('initial GraphVersion 不得携带补丁元数据');
      }
      if (recordKind.value === 'accepted_revision' && patch.value === null) {
        return fail('accepted_revision 必须携带补丁元数据');
      }
      const budgetConsumption = decodeBudgetConsumptionInput(command['budgetConsumption'], 'budgetConsumption');
      if (!budgetConsumption.ok) {
        return budgetConsumption;
      }
      const baselineRaw = command['baselineReconciliations'];
      if (baselineRaw !== undefined && !Array.isArray(baselineRaw)) {
        return fail('baselineReconciliations 必须是数组');
      }
      const baselineReconciliations: { reconciliationId: string; workPackageId: WorkPackageId; requiredBaselineHead: string }[] = [];
      for (const entry of (baselineRaw as readonly unknown[] | undefined) ?? []) {
        if (!isRecord(entry)) return fail('baselineReconciliations 项必须是对象');
        const reconciliationId = requireString(entry['reconciliationId'], 'baselineReconciliations.reconciliationId');
        const workPackageId = requireString(entry['workPackageId'], 'baselineReconciliations.workPackageId');
        const requiredBaselineHead = requireString(entry['requiredBaselineHead'], 'baselineReconciliations.requiredBaselineHead');
        if (!reconciliationId.ok) return reconciliationId;
        if (!workPackageId.ok) return workPackageId;
        if (!requiredBaselineHead.ok) return requiredBaselineHead;
        baselineReconciliations.push({ reconciliationId: reconciliationId.value, workPackageId: workPackageId.value as WorkPackageId, requiredBaselineHead: requiredBaselineHead.value });
      }
      if (recordKind.value === 'initial' && baselineReconciliations.length > 0) {
        return fail('initial GraphVersion 不得携带基线补救需求');
      }
      if (patch.value !== null && baselineReconciliations.some((entry) =>
        !patch.value?.revisionPendingWorkPackageIds.includes(entry.workPackageId)
      )) {
        return fail('基线补救需求必须属于本次 revision pending 节点');
      }
      return ok({
        ...base,
        kind: 'record-graph-version',
        graphId: graphId.value as GraphId,
        generation: generation.value as GraphGeneration,
        graphVersion: graphVersion.value as GraphVersion,
        recordKind: recordKind.value,
        parentVersion: parentVersion.value === null ? null : (parentVersion.value as GraphVersion),
        mapRevision: mapRevision.value,
        planRevision: planRevision.value,
        orcaRunId: orcaRunId.value,
        graph: graph.value,
        patch: patch.value,
        baselineReconciliations,
        ...(budgetConsumption.value === undefined ? {} : { budgetConsumption: budgetConsumption.value }),
      });
    }
    case 'record-authorization': {
      const authorizationId = requireString(command['authorizationId'], 'authorizationId');
      if (!authorizationId.ok) {
        return authorizationId;
      }
      const authorizationVersion = requireCount(command['authorizationVersion'], 'authorizationVersion');
      if (!authorizationVersion.ok || authorizationVersion.value === 0) {
        return fail('authorizationVersion 必须是正的安全整数');
      }
      const manifestVersion = requireCount(command['manifestVersion'], 'manifestVersion');
      if (!manifestVersion.ok) {
        return manifestVersion;
      }
      const fingerprint = requireString(command['fingerprint'], 'fingerprint');
      if (!fingerprint.ok) {
        return fingerprint;
      }
      const approvalRef = requireString(command['approvalRef'], 'approvalRef');
      if (!approvalRef.ok) {
        return approvalRef;
      }
      const manifest = decodeManifestInput(command['manifest'], 'manifest');
      if (!manifest.ok) {
        return manifest;
      }
      if (manifest.value.manifestVersion !== manifestVersion.value) {
        return fail('manifest 正文的 manifestVersion 与记录字段不一致');
      }
      return ok({
        ...base,
        kind: 'record-authorization',
        authorizationId: authorizationId.value,
        authorizationVersion: authorizationVersion.value,
        manifestVersion: manifestVersion.value,
        fingerprint: fingerprint.value,
        approvalRef: approvalRef.value,
        manifest: manifest.value,
      });
    }
    case 'record-planning-handoff': {
      const proposalId = requireString(command['proposalId'], 'proposalId');
      if (!proposalId.ok) {
        return proposalId;
      }
      const sourceSessionId = requireString(
        command['sourceCoordinatorSessionId'],
        'sourceCoordinatorSessionId',
      );
      if (!sourceSessionId.ok) {
        return sourceSessionId;
      }
      const targetSessionId = requireString(
        command['targetCoordinatorSessionId'],
        'targetCoordinatorSessionId',
      );
      if (!targetSessionId.ok) {
        return targetSessionId;
      }
      const phase = requireEnum(command['phase'], PLANNING_HANDOFF_PHASES, 'phase');
      if (!phase.ok) {
        return phase;
      }
      const mapRevision = requireCount(command['mapRevision'], 'mapRevision');
      if (!mapRevision.ok) {
        return mapRevision;
      }
      const planRevision = requireCount(command['planRevision'], 'planRevision');
      if (!planRevision.ok) {
        return planRevision;
      }
      const graphId = requireNullableString(command['graphId'], 'graphId');
      if (!graphId.ok) {
        return graphId;
      }
      const graphVersion = requireNullableCount(command['graphVersion'], 'graphVersion');
      if (!graphVersion.ok) {
        return graphVersion;
      }
      if ((graphId.value === null) !== (graphVersion.value === null)) {
        return fail('graphId 与 graphVersion 必须同时存在或同时为空');
      }
      const capsuleRef = requireNullableString(command['capsuleRef'], 'capsuleRef');
      if (!capsuleRef.ok) {
        return capsuleRef;
      }
      const expectedProposalRevision = requireNullableCount(
        command['expectedProposalRevision'],
        'expectedProposalRevision',
      );
      if (!expectedProposalRevision.ok) {
        return expectedProposalRevision;
      }
      return ok({
        ...base,
        kind: 'record-planning-handoff',
        proposalId: proposalId.value,
        sourceCoordinatorSessionId: sourceSessionId.value as CoordinatorSessionId,
        targetCoordinatorSessionId: targetSessionId.value as CoordinatorSessionId,
        phase: phase.value,
        mapRevision: mapRevision.value,
        planRevision: planRevision.value,
        graphId: graphId.value as GraphId | null,
        graphVersion: graphVersion.value === null ? null : (graphVersion.value as GraphVersion),
        capsuleRef: capsuleRef.value,
        expectedProposalRevision: expectedProposalRevision.value,
      });
    }
    case 'transition-to-execution': {
      const cycle = requireNullableString(command['planningCycleId'], 'planningCycleId');
      if (!cycle.ok) {
        return cycle;
      }
      const graphId = requireString(command['graphId'], 'graphId');
      if (!graphId.ok) {
        return graphId;
      }
      const graphVersion = requireCount(command['graphVersion'], 'graphVersion');
      if (!graphVersion.ok || graphVersion.value === 0) {
        return fail('graphVersion 必须是正的安全整数');
      }
      const authorizationId = requireString(command['authorizationId'], 'authorizationId');
      if (!authorizationId.ok) {
        return authorizationId;
      }
      const authorizationVersion = requireCount(command['authorizationVersion'], 'authorizationVersion');
      if (!authorizationVersion.ok || authorizationVersion.value === 0) {
        return fail('authorizationVersion 必须是正的安全整数');
      }
      return ok({
        ...base,
        kind: 'transition-to-execution',
        planningCycleId: cycle.value as PlanningCycleId | null,
        graphId: graphId.value as GraphId,
        graphVersion: graphVersion.value as GraphVersion,
        authorizationId: authorizationId.value,
        authorizationVersion: authorizationVersion.value,
      });
    }
    case 'advance-map-revision': {
      const mapRevision = requireCount(command['mapRevision'], 'mapRevision');
      if (!mapRevision.ok || mapRevision.value === 0) {
        return fail('mapRevision 必须是正的安全整数');
      }
      return ok({ ...base, kind: 'advance-map-revision', mapRevision: mapRevision.value });
    }
    case 'record-session-segment': {
      const segmentId = requireString(command['segmentId'], 'segmentId');
      if (!segmentId.ok) {
        return segmentId;
      }
      const workPackageId = requireString(command['workPackageId'], 'workPackageId');
      if (!workPackageId.ok) {
        return workPackageId;
      }
      const role = requireEnum(command['role'], WORKER_ROLES, 'role');
      if (!role.ok) {
        return role;
      }
      const workerTaskId = requireString(command['workerTaskId'], 'workerTaskId');
      if (!workerTaskId.ok) {
        return workerTaskId;
      }
      const dispatchId = requireString(command['dispatchId'], 'dispatchId');
      if (!dispatchId.ok) {
        return dispatchId;
      }
      const attemptId = requireString(command['attemptId'], 'attemptId');
      if (!attemptId.ok) {
        return attemptId;
      }
      // 空 Session Binding 是「无法证明身份」这一事实本身，必须原样落盘而不是被拒绝。
      const sessionBindingId = requireNullableString(command['sessionBindingId'], 'sessionBindingId');
      if (!sessionBindingId.ok || sessionBindingId.value === null) {
        return fail('sessionBindingId 必须是字符串（空字符串表示无法证明身份）');
      }
      const lastTranscriptRef = requireNullableString(command['lastTranscriptRef'], 'lastTranscriptRef');
      if (!lastTranscriptRef.ok) {
        return lastTranscriptRef;
      }
      const terminalReceiptRef = requireNullableString(command['terminalReceiptRef'], 'terminalReceiptRef');
      if (!terminalReceiptRef.ok) {
        return terminalReceiptRef;
      }
      const transcriptReferenceable = command['transcriptReferenceable'];
      if (typeof transcriptReferenceable !== 'boolean') {
        return fail('transcriptReferenceable 必须是布尔值');
      }
      const verifiable = command['verifiable'];
      if (typeof verifiable !== 'boolean') {
        return fail('verifiable 必须是布尔值');
      }
      return ok({
        ...base,
        kind: 'record-session-segment',
        segmentId: segmentId.value as SessionSegmentId,
        workPackageId: workPackageId.value as WorkPackageId,
        role: role.value,
        workerTaskId: workerTaskId.value as WorkerTaskId,
        dispatchId: dispatchId.value as DispatchId,
        attemptId: attemptId.value,
        sessionBindingId: sessionBindingId.value,
        lastTranscriptRef: lastTranscriptRef.value,
        terminalReceiptRef: terminalReceiptRef.value,
        transcriptReferenceable,
        verifiable,
      });
    }
    case 'record-materialization-binding': {
      const workPackageId = requireString(command['workPackageId'], 'workPackageId');
      if (!workPackageId.ok) {
        return workPackageId;
      }
      const orcaTaskId = requireString(command['orcaTaskId'], 'orcaTaskId');
      if (!orcaTaskId.ok) {
        return orcaTaskId;
      }
      const creationOperationId = requireString(command['creationOperationId'], 'creationOperationId');
      if (!creationOperationId.ok) {
        return creationOperationId;
      }
      return ok({
        ...base,
        kind: 'record-materialization-binding',
        workPackageId: workPackageId.value as WorkPackageId,
        orcaTaskId: orcaTaskId.value,
        creationOperationId: creationOperationId.value as OperationId,
      });
    }
    case 'record-delivery-settlement': {
      const dedupeKey = requireString(command['dedupeKey'], 'dedupeKey');
      if (!dedupeKey.ok) {
        return dedupeKey;
      }
      const deliveryId = requireString(command['deliveryId'], 'deliveryId');
      if (!deliveryId.ok) {
        return deliveryId;
      }
      const runId = requireString(command['runId'], 'runId');
      if (!runId.ok) {
        return runId;
      }
      const consumerGeneration = requireCount(command['consumerGeneration'], 'consumerGeneration');
      if (!consumerGeneration.ok) {
        return consumerGeneration;
      }
      const workerTaskId = requireString(command['workerTaskId'], 'workerTaskId');
      if (!workerTaskId.ok) {
        return workerTaskId;
      }
      const dispatchId = requireString(command['dispatchId'], 'dispatchId');
      if (!dispatchId.ok) {
        return dispatchId;
      }
      const attemptId = requireString(command['attemptId'], 'attemptId');
      if (!attemptId.ok) {
        return attemptId;
      }
      const role = requireEnum(command['role'], WORKER_ROLES, 'role');
      if (!role.ok) {
        return role;
      }
      const contractRevision = requireCount(command['contractRevision'], 'contractRevision');
      if (!contractRevision.ok) {
        return contractRevision;
      }
      const orcaResultRef = requireString(command['orcaResultRef'], 'orcaResultRef');
      if (!orcaResultRef.ok) {
        return orcaResultRef;
      }
      return ok({
        ...base,
        kind: 'record-delivery-settlement',
        dedupeKey: dedupeKey.value,
        deliveryId: deliveryId.value,
        runId: runId.value,
        consumerGeneration: consumerGeneration.value,
        workerTaskId: workerTaskId.value as WorkerTaskId,
        dispatchId: dispatchId.value as DispatchId,
        attemptId: attemptId.value,
        role: role.value,
        contractRevision: contractRevision.value,
        orcaResultRef: orcaResultRef.value,
      });
    }
    case 'record-delivery-verdict': {
      const verdictId = requireString(command['verdictId'], 'verdictId');
      if (!verdictId.ok) {
        return verdictId;
      }
      const verdict = decodeDeliveryVerdict(command['verdict']);
      if (!verdict.ok) {
        return verdict;
      }
      if (command['finalizerRole'] !== 'finalizer') {
        return fail('finalizerRole 必须是 finalizer');
      }
      const sessionBindingRef = requireString(command['sessionBindingRef'], 'sessionBindingRef');
      if (!sessionBindingRef.ok) {
        return sessionBindingRef;
      }
      return ok({
        ...base,
        kind: 'record-delivery-verdict',
        verdictId: verdictId.value,
        verdict: verdict.value,
        finalizerRole: 'finalizer',
        sessionBindingRef: sessionBindingRef.value,
      });
    }
    case 'record-recovery': {
      const recoveryId = requireString(command['recoveryId'], 'recoveryId');
      if (!recoveryId.ok) {
        return recoveryId;
      }
      const role = requireEnum(command['role'], WORKER_ROLES, 'role');
      if (!role.ok) {
        return role;
      }
      const workPackageId = requireString(command['workPackageId'], 'workPackageId');
      if (!workPackageId.ok) {
        return workPackageId;
      }
      const workerTaskId = requireString(command['workerTaskId'], 'workerTaskId');
      if (!workerTaskId.ok) {
        return workerTaskId;
      }
      const businessAttemptId = requireString(command['businessAttemptId'], 'businessAttemptId');
      if (!businessAttemptId.ok) {
        return businessAttemptId;
      }
      const sourceSegmentId = requireString(command['sourceSegmentId'], 'sourceSegmentId');
      if (!sourceSegmentId.ok) {
        return sourceSegmentId;
      }
      const sourceDispatchId = requireString(command['sourceDispatchId'], 'sourceDispatchId');
      if (!sourceDispatchId.ok) {
        return sourceDispatchId;
      }
      return ok({
        ...base,
        kind: 'record-recovery',
        recoveryId: recoveryId.value as RecoveryId,
        role: role.value,
        workPackageId: workPackageId.value as WorkPackageId,
        workerTaskId: workerTaskId.value as WorkerTaskId,
        businessAttemptId: businessAttemptId.value,
        sourceSegmentId: sourceSegmentId.value as SessionSegmentId,
        sourceDispatchId: sourceDispatchId.value as DispatchId,
      });
    }
    case 'advance-recovery': {
      const recoveryId = requireString(command['recoveryId'], 'recoveryId');
      if (!recoveryId.ok) {
        return recoveryId;
      }
      const status = requireEnum(command['status'], RECOVERY_STATES, 'status');
      if (!status.ok) {
        return status;
      }
      const replacementDispatchId = requireNullableString(
        command['replacementDispatchId'],
        'replacementDispatchId',
      );
      if (!replacementDispatchId.ok) {
        return replacementDispatchId;
      }
      const replacementSegmentId = requireNullableString(
        command['replacementSegmentId'],
        'replacementSegmentId',
      );
      if (!replacementSegmentId.ok) {
        return replacementSegmentId;
      }
      const replacementSessionBindingId = requireNullableString(
        command['replacementSessionBindingId'],
        'replacementSessionBindingId',
      );
      if (!replacementSessionBindingId.ok) {
        return replacementSessionBindingId;
      }
      const supersededSegmentId = requireNullableString(
        command['supersededSegmentId'],
        'supersededSegmentId',
      );
      if (!supersededSegmentId.ok) {
        return supersededSegmentId;
      }
      const capsuleRef = requireNullableString(command['capsuleRef'], 'capsuleRef');
      if (!capsuleRef.ok) {
        return capsuleRef;
      }
      const prewriteOperationId = requireNullableString(
        command['prewriteOperationId'],
        'prewriteOperationId',
      );
      if (!prewriteOperationId.ok) {
        return prewriteOperationId;
      }
      const terminalOutcome = decodeEnumPatch(
        command['terminalOutcome'],
        RECOVERY_TERMINAL_OUTCOMES,
        'terminalOutcome',
      );
      if (!terminalOutcome.ok) {
        return terminalOutcome;
      }
      const blockingReason = decodeStringPatch(command['blockingReason'], 'blockingReason');
      if (!blockingReason.ok) {
        return blockingReason;
      }
      const consumedBudget = requireNullableCount(command['consumedBudget'], 'consumedBudget');
      if (!consumedBudget.ok) {
        return consumedBudget;
      }
      const replacementSegment = decodeReplacementSegment(command['replacementSegment'], 'replacementSegment');
      if (!replacementSegment.ok) {
        return replacementSegment;
      }
      // 替代 Segment 与 Recovery 收尾必须是同一次提交：只允许与 recovered 一起给出。
      let effectiveReplacementSegmentId = replacementSegmentId.value;
      if (replacementSegment.value !== null) {
        if (status.value !== 'recovered') {
          return fail('replacementSegment 只能与 recovered 状态在同一笔提交里给出');
        }
        if (
          effectiveReplacementSegmentId !== null &&
          effectiveReplacementSegmentId !== replacementSegment.value.segmentId
        ) {
          return fail('replacementSegmentId 与 replacementSegment.segmentId 不一致');
        }
        effectiveReplacementSegmentId = replacementSegment.value.segmentId;
      }
      return ok({
        ...base,
        kind: 'advance-recovery',
        recoveryId: recoveryId.value as RecoveryId,
        status: status.value,
        ...(replacementDispatchId.value === null ? {} : { replacementDispatchId: replacementDispatchId.value }),
        ...(effectiveReplacementSegmentId === null
          ? {}
          : { replacementSegmentId: effectiveReplacementSegmentId as SessionSegmentId }),
        ...(replacementSessionBindingId.value === null
          ? {}
          : { replacementSessionBindingId: replacementSessionBindingId.value }),
        ...(supersededSegmentId.value === null
          ? {}
          : { supersededSegmentId: supersededSegmentId.value as SessionSegmentId }),
        ...(capsuleRef.value === null ? {} : { capsuleRef: capsuleRef.value }),
        ...(prewriteOperationId.value === null
          ? {}
          : { prewriteOperationId: prewriteOperationId.value as OperationId }),
        // 省略与显式 null 的语义不同：省略表示保持原值，null 表示清空。
        ...(terminalOutcome.value.present ? { terminalOutcome: terminalOutcome.value.value } : {}),
        ...(blockingReason.value.present ? { blockingReason: blockingReason.value.value } : {}),
        ...(consumedBudget.value === null ? {} : { consumedBudget: consumedBudget.value }),
        ...(replacementSegment.value === null ? {} : { replacementSegment: replacementSegment.value }),
      });
    }
    case 'record-execution-handoff': {
      const handoffId = requireString(command['handoffId'], 'handoffId');
      if (!handoffId.ok) {
        return handoffId;
      }
      const sourceSessionId = requireString(command['sourceSessionId'], 'sourceSessionId');
      if (!sourceSessionId.ok) {
        return sourceSessionId;
      }
      const targetSessionId = requireString(command['targetSessionId'], 'targetSessionId');
      if (!targetSessionId.ok) {
        return targetSessionId;
      }
      const graphGeneration = requireCount(command['graphGeneration'], 'graphGeneration');
      if (!graphGeneration.ok) {
        return graphGeneration;
      }
      const responsibilitySet = decodeHandoffResponsibilitySet(
        command['responsibilitySet'],
        'responsibilitySet',
      );
      if (!responsibilitySet.ok) {
        return responsibilitySet;
      }
      const phase = requireEnum(command['phase'], EXECUTION_HANDOFF_PHASES, 'phase');
      if (!phase.ok) {
        return phase;
      }
      const capsuleRef = decodeStringPatch(
        command['coordinatorContextCapsuleRef'],
        'coordinatorContextCapsuleRef',
      );
      if (!capsuleRef.ok) {
        return capsuleRef;
      }
      const blockingReason = decodeStringPatch(command['blockingReason'], 'blockingReason');
      if (!blockingReason.ok) {
        return blockingReason;
      }
      const expectedHandoffRevision = requireNullableCount(
        command['expectedHandoffRevision'],
        'expectedHandoffRevision',
      );
      if (!expectedHandoffRevision.ok) {
        return expectedHandoffRevision;
      }
      return ok({
        ...base,
        kind: 'record-execution-handoff',
        handoffId: handoffId.value,
        sourceSessionId: sourceSessionId.value as CoordinatorSessionId,
        targetSessionId: targetSessionId.value as CoordinatorSessionId,
        graphGeneration: graphGeneration.value as GraphGeneration,
        responsibilitySet: responsibilitySet.value,
        phase: phase.value,
        ...(capsuleRef.value.present
          ? { coordinatorContextCapsuleRef: capsuleRef.value.value }
          : {}),
        ...(blockingReason.value.present ? { blockingReason: blockingReason.value.value } : {}),
        expectedHandoffRevision: expectedHandoffRevision.value,
      });
    }
    case 'advance-execution-handoff': {
      const handoffId = requireString(command['handoffId'], 'handoffId');
      if (!handoffId.ok) {
        return handoffId;
      }
      const phase = requireEnum(command['phase'], EXECUTION_HANDOFF_PHASES, 'phase');
      if (!phase.ok) {
        return phase;
      }
      const expectedHandoffRevision = requireCount(
        command['expectedHandoffRevision'],
        'expectedHandoffRevision',
      );
      if (!expectedHandoffRevision.ok) {
        return expectedHandoffRevision;
      }
      const blockingReason = decodeStringPatch(command['blockingReason'], 'blockingReason');
      if (!blockingReason.ok) {
        return blockingReason;
      }
      return ok({
        ...base,
        kind: 'advance-execution-handoff',
        handoffId: handoffId.value,
        phase: phase.value,
        expectedHandoffRevision: expectedHandoffRevision.value,
        ...(blockingReason.value.present ? { blockingReason: blockingReason.value.value } : {}),
      });
    }
    case 'record-graph-generation': {
      const graphId = requireString(command['graphId'], 'graphId');
      if (!graphId.ok) {
        return graphId;
      }
      const generation = requireCount(command['generation'], 'generation');
      if (!generation.ok) {
        return generation;
      }
      const planningCycleId = requireString(command['planningCycleId'], 'planningCycleId');
      if (!planningCycleId.ok) {
        return planningCycleId;
      }
      const orcaRunId = requireString(command['orcaRunId'], 'orcaRunId');
      if (!orcaRunId.ok) {
        return orcaRunId;
      }
      const predecessorGraphId = requireNullableString(command['predecessorGraphId'], 'predecessorGraphId');
      if (!predecessorGraphId.ok) {
        return predecessorGraphId;
      }
      const baselineHead = requireString(command['baselineHead'], 'baselineHead');
      if (!baselineHead.ok) {
        return baselineHead;
      }
      return ok({
        ...base,
        kind: 'record-graph-generation',
        graphId: graphId.value as GraphId,
        generation: generation.value as GraphGeneration,
        planningCycleId: planningCycleId.value as PlanningCycleId,
        orcaRunId: orcaRunId.value,
        predecessorGraphId: predecessorGraphId.value === null ? null : (predecessorGraphId.value as GraphId),
        baselineHead: baselineHead.value,
      });
    }
    case 'advance-graph-generation': {
      const graphId = requireString(command['graphId'], 'graphId');
      if (!graphId.ok) {
        return graphId;
      }
      const status = requireEnum(command['status'], GRAPH_GENERATION_STATUSES, 'status');
      if (!status.ok) {
        return status;
      }
      return ok({
        ...base,
        kind: 'advance-graph-generation',
        graphId: graphId.value as GraphId,
        status: status.value,
      });
    }
    case 'record-revision-hold': {
      const workPackageId = requireString(command['workPackageId'], 'workPackageId');
      if (!workPackageId.ok) {
        return workPackageId;
      }
      const source = requireEnum(command['source'], REVISION_HOLD_SOURCES, 'source');
      if (!source.ok) {
        return source;
      }
      const sourceRef = requireString(command['sourceRef'], 'sourceRef');
      if (!sourceRef.ok) {
        return sourceRef;
      }
      return ok({
        ...base,
        kind: 'record-revision-hold',
        workPackageId: workPackageId.value as WorkPackageId,
        source: source.value,
        sourceRef: sourceRef.value,
      });
    }
    case 'release-revision-hold': {
      const workPackageId = requireString(command['workPackageId'], 'workPackageId');
      if (!workPackageId.ok) {
        return workPackageId;
      }
      const reason = requireString(command['reason'], 'reason');
      if (!reason.ok) {
        return reason;
      }
      const budgetConsumption = decodeBudgetConsumptionInput(command['budgetConsumption'], 'budgetConsumption');
      if (!budgetConsumption.ok) {
        return budgetConsumption;
      }
      const expectedSourceRef = decodeStringPatch(command['expectedSourceRef'], 'expectedSourceRef');
      if (!expectedSourceRef.ok) {
        return expectedSourceRef;
      }
      const sourceRef = expectedSourceRef.value.value;
      return ok({
        ...base,
        kind: 'release-revision-hold',
        workPackageId: workPackageId.value as WorkPackageId,
        reason: reason.value,
        ...(sourceRef === null ? {} : { expectedSourceRef: sourceRef }),
        ...(budgetConsumption.value === undefined ? {} : { budgetConsumption: budgetConsumption.value }),
      });
    }
    case 'record-baseline-reconciliation': {
      const reconciliationId = requireString(command['reconciliationId'], 'reconciliationId');
      if (!reconciliationId.ok) {
        return reconciliationId;
      }
      const workPackageId = requireString(command['workPackageId'], 'workPackageId');
      if (!workPackageId.ok) {
        return workPackageId;
      }
      const requiredBaselineHead = requireString(command['requiredBaselineHead'], 'requiredBaselineHead');
      if (!requiredBaselineHead.ok) {
        return requiredBaselineHead;
      }
      return ok({
        ...base,
        kind: 'record-baseline-reconciliation',
        reconciliationId: reconciliationId.value,
        workPackageId: workPackageId.value as WorkPackageId,
        requiredBaselineHead: requiredBaselineHead.value,
      });
    }
    case 'bind-baseline-reconciliation-task': {
      const reconciliationId = requireString(command['reconciliationId'], 'reconciliationId');
      if (!reconciliationId.ok) return reconciliationId;
      const orcaTaskId = requireString(command['orcaTaskId'], 'orcaTaskId');
      if (!orcaTaskId.ok) return orcaTaskId;
      const dispatchId = command['dispatchId'] === undefined
        ? null
        : requireString(command['dispatchId'], 'dispatchId');
      if (dispatchId !== null && !dispatchId.ok) return dispatchId;
      return ok({
        ...base,
        kind: 'bind-baseline-reconciliation-task',
        reconciliationId: reconciliationId.value,
        orcaTaskId: orcaTaskId.value,
        ...(dispatchId === null ? {} : { dispatchId: dispatchId.value as DispatchId }),
      });
    }
    case 'advance-baseline-reconciliation': {
      const reconciliationId = requireString(command['reconciliationId'], 'reconciliationId');
      if (!reconciliationId.ok) {
        return reconciliationId;
      }
      const state = requireEnum(
        command['state'],
        ['verified', 'blocked'] as const,
        'state',
      );
      if (!state.ok) {
        return state;
      }
      const observedHead = decodeStringPatch(command['observedHead'], 'observedHead');
      if (!observedHead.ok) {
        return observedHead;
      }
      const blockerRef = decodeStringPatch(command['blockerRef'], 'blockerRef');
      if (!blockerRef.ok) {
        return blockerRef;
      }
      const flags: Record<string, boolean> = {};
      for (const key of [
        'ancestryVerified',
        'targetHeadVerified',
        'dirtyPathsReconciled',
        'scopeReconciled',
      ] as const) {
        const raw = command[key];
        if (raw === undefined) {
          continue;
        }
        const parsed = requireBoolean(raw, key);
        if (!parsed.ok) {
          return parsed;
        }
        flags[key] = parsed.value;
      }
      return ok({
        ...base,
        kind: 'advance-baseline-reconciliation',
        reconciliationId: reconciliationId.value,
        state: state.value,
        ...(observedHead.value.present ? { observedHead: observedHead.value.value } : {}),
        ...(flags['ancestryVerified'] === undefined ? {} : { ancestryVerified: flags['ancestryVerified'] }),
        ...(flags['targetHeadVerified'] === undefined ? {} : { targetHeadVerified: flags['targetHeadVerified'] }),
        ...(flags['dirtyPathsReconciled'] === undefined
          ? {}
          : { dirtyPathsReconciled: flags['dirtyPathsReconciled'] }),
        ...(flags['scopeReconciled'] === undefined ? {} : { scopeReconciled: flags['scopeReconciled'] }),
        ...(blockerRef.value.present ? { blockerRef: blockerRef.value.value } : {}),
      });
    }
    case 'record-work-package-lineage': {
      const workPackageId = requireString(command['workPackageId'], 'workPackageId');
      if (!workPackageId.ok) {
        return workPackageId;
      }
      const priorWorkPackageId = requireString(command['priorWorkPackageId'], 'priorWorkPackageId');
      if (!priorWorkPackageId.ok) {
        return priorWorkPackageId;
      }
      const priorGraphId = requireString(command['priorGraphId'], 'priorGraphId');
      if (!priorGraphId.ok) {
        return priorGraphId;
      }
      if (workPackageId.value === priorWorkPackageId.value) {
        return fail('Work Package 不能延续自身');
      }
      const inherited = decodeInheritedBudget(command['inherited'], 'inherited');
      if (!inherited.ok) {
        return inherited;
      }
      return ok({
        ...base,
        kind: 'record-work-package-lineage',
        workPackageId: workPackageId.value as WorkPackageId,
        priorWorkPackageId: priorWorkPackageId.value as WorkPackageId,
        priorGraphId: priorGraphId.value as GraphId,
        inherited: inherited.value,
      });
    }
    case 'record-baseline-adoption': {
      const adoptionId = requireString(command['adoptionId'], 'adoptionId');
      if (!adoptionId.ok) {
        return adoptionId;
      }
      const workPackageId = requireString(command['workPackageId'], 'workPackageId');
      if (!workPackageId.ok) {
        return workPackageId;
      }
      const adoptionKind = requireEnum(command['adoptionKind'], BASELINE_ADOPTION_KINDS, 'adoptionKind');
      if (!adoptionKind.ok) {
        return adoptionKind;
      }
      const adoptedResultRef = requireString(command['adoptedResultRef'], 'adoptedResultRef');
      if (!adoptedResultRef.ok) {
        return adoptedResultRef;
      }
      const baselineHead = requireString(command['baselineHead'], 'baselineHead');
      if (!baselineHead.ok) {
        return baselineHead;
      }
      const integrationRef = requireNullableString(command['integrationRef'], 'integrationRef');
      if (!integrationRef.ok) {
        return integrationRef;
      }
      const evidenceRefs = requireStringArray(command['evidenceRefs'], 'evidenceRefs');
      if (!evidenceRefs.ok) {
        return evidenceRefs;
      }
      const state = requireEnum(command['state'], BASELINE_ADOPTION_STATES, 'state');
      if (!state.ok) {
        return state;
      }
      const blockingReason = requireNullableString(command['blockingReason'], 'blockingReason');
      if (!blockingReason.ok) {
        return blockingReason;
      }
      return ok({
        ...base,
        kind: 'record-baseline-adoption',
        adoptionId: adoptionId.value,
        workPackageId: workPackageId.value as WorkPackageId,
        adoptionKind: adoptionKind.value,
        adoptedResultRef: adoptedResultRef.value,
        baselineHead: baselineHead.value,
        integrationRef: integrationRef.value,
        evidenceRefs: evidenceRefs.value,
        state: state.value,
        blockingReason: blockingReason.value,
      });
    }
    case 'commit-generation-cutover': {
      const candidateGraphId = requireString(command['candidateGraphId'], 'candidateGraphId');
      if (!candidateGraphId.ok) {
        return candidateGraphId;
      }
      const candidateGraphVersion = requireCount(command['candidateGraphVersion'], 'candidateGraphVersion');
      if (!candidateGraphVersion.ok || candidateGraphVersion.value === 0) {
        return fail('candidateGraphVersion 必须是正的安全整数');
      }
      const planningCycleId = requireString(command['planningCycleId'], 'planningCycleId');
      if (!planningCycleId.ok) {
        return planningCycleId;
      }
      const authorizationId = requireString(command['authorizationId'], 'authorizationId');
      if (!authorizationId.ok) {
        return authorizationId;
      }
      const authorizationVersion = requireCount(command['authorizationVersion'], 'authorizationVersion');
      if (!authorizationVersion.ok || authorizationVersion.value === 0) {
        return fail('authorizationVersion 必须是正的安全整数');
      }
      const predecessorGraphId = requireNullableString(command['predecessorGraphId'], 'predecessorGraphId');
      if (!predecessorGraphId.ok) {
        return predecessorGraphId;
      }
      const candidateRunId = requireString(command['candidateRunId'], 'candidateRunId');
      if (!candidateRunId.ok) {
        return candidateRunId;
      }
      const baselineHead = requireString(command['baselineHead'], 'baselineHead');
      if (!baselineHead.ok) {
        return baselineHead;
      }
      return ok({
        ...base,
        kind: 'commit-generation-cutover',
        candidateGraphId: candidateGraphId.value as GraphId,
        candidateGraphVersion: candidateGraphVersion.value as GraphVersion,
        planningCycleId: planningCycleId.value as PlanningCycleId,
        authorizationId: authorizationId.value,
        authorizationVersion: authorizationVersion.value,
        predecessorGraphId: predecessorGraphId.value === null ? null : (predecessorGraphId.value as GraphId),
        candidateRunId: candidateRunId.value,
        baselineHead: baselineHead.value,
      });
    }
    default:
      return fail(`未登记的 command variant: ${kind.value}`);
  }
}

/**
 * 交付结论的边界解析：引用列表必须是非空字符串数组，空列表本身不是错误——「没有阻塞项」或
 * 「没有证据」的语义判断属于领域层，边界只拒绝形状不合法的载荷。
 */
function decodeDeliveryVerdict(raw: unknown): Decoded<DeliveryVerdict> {
  if (!isRecord(raw)) {
    return fail('verdict 必须是对象');
  }
  const kind = raw['kind'];
  const refsField = kind === 'deliverable' ? 'evidenceRefs' : kind === 'blocked' ? 'blockerRefs' : null;
  if (refsField === null) {
    return fail(`verdict.kind 取值不受支持: ${String(kind)}`);
  }
  const refs = requireStringArray(raw[refsField], `verdict.${refsField}`);
  if (!refs.ok) {
    return refs;
  }
  return kind === 'deliverable'
    ? ok({ kind: 'deliverable', evidenceRefs: refs.value })
    : ok({ kind: 'blocked', blockerRefs: refs.value });
}

type ScopeRow = {
  readonly coordination_scope_id: string;
  readonly full_branch_ref: string | null;
  readonly canonical_worktree_path: string | null;
  readonly mode: string;
  readonly control_state: string;
  readonly planning_cycle_id: string | null;
  readonly map_revision: number;
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
  readonly answer_text: string | null;
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
  readonly expected_head: string | null;
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

type GraphVersionRow = {
  readonly coordination_scope_id: string;
  readonly graph_id: string;
  readonly graph_version: number;
  readonly graph_generation: number;
  readonly record_kind: string;
  readonly parent_version: number | null;
  readonly map_revision: number;
  readonly plan_revision: number;
  readonly orca_run_id: string;
  readonly graph_json: string;
  readonly patch_id: string | null;
  readonly patch_json: string | null;
  readonly recorded_at: number;
};

type GraphGenerationRow = {
  readonly coordination_scope_id: string;
  readonly graph_id: string;
  readonly graph_generation: number;
  readonly planning_cycle_id: string;
  readonly orca_run_id: string;
  readonly predecessor_graph_id: string | null;
  readonly baseline_head: string;
  readonly status: string;
  readonly created_at: number;
  readonly updated_at: number;
};

type RevisionHoldRow = {
  readonly coordination_scope_id: string;
  readonly work_package_id: string;
  readonly source: string;
  readonly source_ref: string;
  readonly state: string;
  readonly created_at: number;
  readonly released_at: number | null;
  readonly release_reason: string | null;
};

type BaselineReconciliationRow = {
  readonly coordination_scope_id: string;
  readonly reconciliation_id: string;
  readonly work_package_id: string;
  readonly role: string;
  readonly required_baseline_head: string;
  readonly orca_task_id: string | null;
  readonly dispatch_id: string | null;
  readonly observed_head: string | null;
  readonly ancestry_verified: number;
  readonly target_head_verified: number;
  readonly dirty_paths_reconciled: number;
  readonly scope_reconciled: number;
  readonly state: string;
  readonly blocker_ref: string | null;
  readonly created_at: number;
  readonly updated_at: number;
};

type WorkPackageLineageRow = {
  readonly coordination_scope_id: string;
  readonly work_package_id: string;
  readonly prior_work_package_id: string;
  readonly prior_graph_id: string;
  readonly inherited_json: string;
  readonly recorded_at: number;
};

type BaselineAdoptionRow = {
  readonly coordination_scope_id: string;
  readonly adoption_id: string;
  readonly work_package_id: string;
  readonly adoption_kind: string;
  readonly adopted_result_ref: string;
  readonly baseline_head: string;
  readonly integration_ref: string | null;
  readonly evidence_refs: string;
  readonly state: string;
  readonly blocking_reason: string | null;
  readonly recorded_at: number;
};

type AuthorizationRow = {
  readonly coordination_scope_id: string;
  readonly authorization_id: string;
  readonly authorization_version: number;
  readonly manifest_version: number;
  readonly fingerprint: string;
  readonly approval_ref: string;
  readonly manifest_json: string;
  readonly approved_at: number;
};

type PlanningHandoffRow = {
  readonly coordination_scope_id: string;
  readonly proposal_id: string;
  readonly source_coordinator_session_id: string;
  readonly target_coordinator_session_id: string;
  readonly phase: string;
  readonly map_revision: number;
  readonly plan_revision: number;
  readonly graph_id: string | null;
  readonly graph_version: number | null;
  readonly capsule_ref: string | null;
  readonly proposal_revision: number;
  readonly created_at: number;
  readonly updated_at: number;
};

type PlanningResponsibilityRow = {
  readonly coordination_scope_id: string;
  readonly coordinator_session_id: string;
  readonly source_proposal_id: string | null;
  readonly assigned_at: number;
};

type SessionSegmentRow = {
  readonly coordination_scope_id: string;
  readonly segment_id: string;
  readonly work_package_id: string;
  readonly role: string;
  readonly worker_task_id: string;
  readonly dispatch_id: string;
  readonly attempt_id: string;
  readonly session_binding_id: string;
  readonly last_transcript_ref: string | null;
  readonly terminal_receipt_ref: string | null;
  readonly transcript_referenceable: number;
  readonly verifiable: number;
  readonly recorded_at: number;
};

type MaterializationBindingRow = {
  readonly coordination_scope_id: string;
  readonly work_package_id: string;
  readonly orca_task_id: string;
  readonly creation_operation_id: string;
  readonly created_at: number;
};

type DeliverySettlementRow = {
  readonly coordination_scope_id: string;
  readonly dedupe_key: string;
  readonly delivery_id: string;
  readonly run_id: string;
  readonly consumer_generation: number;
  readonly worker_task_id: string;
  readonly dispatch_id: string;
  readonly attempt_id: string;
  readonly role: string;
  readonly contract_revision: number;
  readonly orca_result_ref: string;
  readonly accepted_at: number;
};

type DeliveryVerdictRow = {
  readonly coordination_scope_id: string;
  readonly verdict_id: string;
  readonly verdict_sequence: number;
  readonly verdict_kind: string;
  readonly verdict_refs: string;
  readonly finalizer_role: string;
  readonly session_binding_ref: string;
  readonly recorded_at: number;
};

type RecoveryRow = {
  readonly coordination_scope_id: string;
  readonly recovery_id: string;
  readonly role: string;
  readonly work_package_id: string;
  readonly worker_task_id: string;
  readonly business_attempt_id: string;
  readonly source_segment_id: string;
  readonly source_dispatch_id: string;
  readonly replacement_dispatch_id: string | null;
  readonly replacement_segment_id: string | null;
  readonly replacement_session_binding_id: string | null;
  readonly superseded_segment_id: string | null;
  readonly status: string;
  readonly consumed_budget: number;
  readonly capsule_ref: string | null;
  readonly prewrite_operation_id: string | null;
  readonly terminal_outcome: string | null;
  readonly blocking_reason: string | null;
  readonly created_at: number;
  readonly updated_at: number;
};

type ExecutionHandoffRow = {
  readonly coordination_scope_id: string;
  readonly handoff_id: string;
  readonly source_session_id: string;
  readonly target_session_id: string;
  readonly graph_generation: number;
  readonly responsibility_set: string;
  readonly phase: string;
  readonly expected_revision: number;
  readonly coordinator_context_capsule_ref: string | null;
  readonly handoff_revision: number;
  readonly blocking_reason: string | null;
  readonly created_at: number;
  readonly updated_at: number;
};

function decodeGraphVersionRow(row: GraphVersionRow): Decoded<GraphVersionRecord> {
  if (!isGraphVersionRecordKind(row.record_kind)) {
    return fail(`graph_versions.record_kind 取值不受支持: ${row.record_kind}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(row.graph_json);
  } catch (error) {
    return fail(`graph_versions.graph_json 不是合法 JSON: ${describeError(error)}`);
  }
  const graph = decodeExecutionGraph(raw, 'graph_versions.graph_json');
  if (!graph.ok) {
    return graph;
  }
  if (graph.value.graphId !== row.graph_id || graph.value.generation !== row.graph_generation) {
    return fail('graph_versions 的索引列与 JSON 负载不一致');
  }
  return ok({
    graphId: row.graph_id as GraphId,
    generation: row.graph_generation as GraphGeneration,
    version: row.graph_version as GraphVersion,
    recordKind: row.record_kind,
    parentVersion: row.parent_version === null ? null : (row.parent_version as GraphVersion),
    patchId: row.patch_id,
    mapRevision: row.map_revision,
    planRevision: row.plan_revision,
    orcaRunId: row.orca_run_id,
    graph: graph.value,
    recordedAt: row.recorded_at,
  });
}

function decodeGraphGenerationRow(row: GraphGenerationRow): Decoded<GraphGenerationRecord> {
  const status = requireEnum(row.status, GRAPH_GENERATION_STATUSES, 'graph_generations.status');
  if (!status.ok) {
    return status;
  }
  return ok({
    coordinationScopeId: row.coordination_scope_id as CoordinationScopeId,
    graphId: row.graph_id as GraphId,
    generation: row.graph_generation as GraphGeneration,
    planningCycleId: row.planning_cycle_id as PlanningCycleId,
    orcaRunId: row.orca_run_id,
    predecessorGraphId: row.predecessor_graph_id === null ? null : (row.predecessor_graph_id as GraphId),
    baselineHead: row.baseline_head,
    status: status.value,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function decodeRevisionHoldRow(row: RevisionHoldRow): Decoded<RevisionHoldRecord> {
  const source = requireEnum(row.source, REVISION_HOLD_SOURCES, 'revision_holds.source');
  if (!source.ok) {
    return source;
  }
  const state = requireEnum(row.state, REVISION_HOLD_STATES, 'revision_holds.state');
  if (!state.ok) {
    return state;
  }
  return ok({
    coordinationScopeId: row.coordination_scope_id as CoordinationScopeId,
    workPackageId: row.work_package_id as WorkPackageId,
    source: source.value,
    sourceRef: row.source_ref,
    state: state.value,
    createdAt: row.created_at,
    releasedAt: row.released_at,
    releaseReason: row.release_reason,
  });
}

function decodeBaselineReconciliationRow(row: BaselineReconciliationRow): Decoded<BaselineReconciliationRecord> {
  const state = requireEnum(row.state, BASELINE_RECONCILIATION_STATES, 'baseline_reconciliations.state');
  if (!state.ok) {
    return state;
  }
  if (row.role !== 'planner') {
    return fail(`baseline_reconciliations.role 取值不受支持: ${row.role}`);
  }
  return ok({
    coordinationScopeId: row.coordination_scope_id as CoordinationScopeId,
    reconciliationId: row.reconciliation_id,
    workPackageId: row.work_package_id as WorkPackageId,
    role: 'planner',
    requiredBaselineHead: row.required_baseline_head,
    orcaTaskId: row.orca_task_id,
    dispatchId: row.dispatch_id as DispatchId | null,
    observedHead: row.observed_head,
    ancestryVerified: row.ancestry_verified === 1,
    targetHeadVerified: row.target_head_verified === 1,
    dirtyPathsReconciled: row.dirty_paths_reconciled === 1,
    scopeReconciled: row.scope_reconciled === 1,
    state: state.value,
    blockerRef: row.blocker_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function decodeWorkPackageLineageRow(row: WorkPackageLineageRow): Decoded<WorkPackageLineageRecord> {
  let raw: unknown;
  try {
    raw = JSON.parse(row.inherited_json);
  } catch (error) {
    return fail(`work_package_lineages.inherited_json 不是合法 JSON: ${describeError(error)}`);
  }
  const inherited = decodeInheritedBudget(raw, 'work_package_lineages.inherited_json');
  if (!inherited.ok) {
    return inherited;
  }
  return ok({
    coordinationScopeId: row.coordination_scope_id as CoordinationScopeId,
    workPackageId: row.work_package_id as WorkPackageId,
    priorWorkPackageId: row.prior_work_package_id as WorkPackageId,
    priorGraphId: row.prior_graph_id as GraphId,
    inherited: inherited.value,
    recordedAt: row.recorded_at,
  });
}

function decodeBaselineAdoptionRow(row: BaselineAdoptionRow): Decoded<BaselineAdoptionRecord> {
  const kind = requireEnum(row.adoption_kind, BASELINE_ADOPTION_KINDS, 'baseline_adoptions.adoption_kind');
  if (!kind.ok) {
    return kind;
  }
  const state = requireEnum(row.state, BASELINE_ADOPTION_STATES, 'baseline_adoptions.state');
  if (!state.ok) {
    return state;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(row.evidence_refs);
  } catch (error) {
    return fail(`baseline_adoptions.evidence_refs 不是合法 JSON: ${describeError(error)}`);
  }
  const evidenceRefs = requireStringArray(raw, 'baseline_adoptions.evidence_refs');
  if (!evidenceRefs.ok) {
    return evidenceRefs;
  }
  return ok({
    coordinationScopeId: row.coordination_scope_id as CoordinationScopeId,
    adoptionId: row.adoption_id,
    workPackageId: row.work_package_id as WorkPackageId,
    kind: kind.value,
    adoptedResultRef: row.adopted_result_ref,
    baselineHead: row.baseline_head,
    integrationRef: row.integration_ref,
    evidenceRefs: evidenceRefs.value,
    state: state.value,
    blockingReason: row.blocking_reason,
    recordedAt: row.recorded_at,
  });
}

function decodeAuthorizationRow(row: AuthorizationRow): Decoded<ExecutionAuthorizationRecord> {
  let raw: unknown;
  try {
    raw = JSON.parse(row.manifest_json);
  } catch (error) {
    return fail(`execution_authorizations.manifest_json 不是合法 JSON: ${describeError(error)}`);
  }
  const manifest = decodeManifestInput(raw, 'execution_authorizations.manifest_json');
  if (!manifest.ok) {
    return manifest;
  }
  return ok({
    coordinationScopeId: row.coordination_scope_id as CoordinationScopeId,
    authorizationId: row.authorization_id,
    authorizationVersion: row.authorization_version,
    manifestVersion: row.manifest_version,
    fingerprint: row.fingerprint,
    manifest: manifest.value,
    approvedAt: row.approved_at,
    approvalRef: row.approval_ref,
  });
}

function decodePlanningHandoffRow(row: PlanningHandoffRow): Decoded<PlanningHandoffRecord> {
  if (!(PLANNING_HANDOFF_PHASES as readonly string[]).includes(row.phase)) {
    return fail(`planning_handoffs.phase 取值不受支持: ${row.phase}`);
  }
  return ok({
    coordinationScopeId: row.coordination_scope_id as CoordinationScopeId,
    proposalId: row.proposal_id,
    sourceCoordinatorSessionId: row.source_coordinator_session_id as CoordinatorSessionId,
    targetCoordinatorSessionId: row.target_coordinator_session_id as CoordinatorSessionId,
    phase: row.phase as PlanningHandoffPhase,
    mapRevision: row.map_revision,
    planRevision: row.plan_revision,
    graphId: row.graph_id as GraphId | null,
    graphVersion: row.graph_version === null ? null : (row.graph_version as GraphVersion),
    capsuleRef: row.capsule_ref,
    proposalRevision: row.proposal_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function decodePlanningResponsibilityRow(row: PlanningResponsibilityRow): PlanningResponsibilityRecord {
  return {
    coordinationScopeId: row.coordination_scope_id as CoordinationScopeId,
    coordinatorSessionId: row.coordinator_session_id as CoordinatorSessionId,
    sourceProposalId: row.source_proposal_id,
    assignedAt: row.assigned_at,
  };
}

function decodeWorkerRole(raw: string): WorkerRole | null {
  return (WORKER_ROLES as readonly string[]).includes(raw) ? (raw as WorkerRole) : null;
}

function decodeSessionSegmentRow(row: SessionSegmentRow): Decoded<SessionSegmentRecord> {
  const role = decodeWorkerRole(row.role);
  if (role === null) {
    return fail(`session_segments.role 取值不受支持: ${row.role}`);
  }
  return ok({
    coordinationScopeId: row.coordination_scope_id as CoordinationScopeId,
    segmentId: row.segment_id as SessionSegmentId,
    workPackageId: row.work_package_id as WorkPackageId,
    role,
    workerTaskId: row.worker_task_id as WorkerTaskId,
    dispatchId: row.dispatch_id as DispatchId,
    attemptId: row.attempt_id,
    sessionBindingId: row.session_binding_id,
    lastTranscriptRef: row.last_transcript_ref,
    terminalReceiptRef: row.terminal_receipt_ref,
    transcriptReferenceable: row.transcript_referenceable === 1,
    verifiable: row.verifiable === 1,
    recordedAt: row.recorded_at,
  });
}

function decodeMaterializationBindingRow(row: MaterializationBindingRow): MaterializationBindingRecord {
  return {
    coordinationScopeId: row.coordination_scope_id as CoordinationScopeId,
    workPackageId: row.work_package_id as WorkPackageId,
    orcaTaskId: row.orca_task_id,
    creationOperationId: row.creation_operation_id as OperationId,
    createdAt: row.created_at,
  };
}

function decodeDeliverySettlementRow(row: DeliverySettlementRow): Decoded<DeliverySettlementRecord> {
  const role = decodeWorkerRole(row.role);
  if (role === null) {
    return fail(`delivery_settlements.role 取值不受支持: ${row.role}`);
  }
  return ok({
    coordinationScopeId: row.coordination_scope_id as CoordinationScopeId,
    dedupeKey: row.dedupe_key,
    deliveryId: row.delivery_id,
    runId: row.run_id,
    consumerGeneration: row.consumer_generation,
    workerTaskId: row.worker_task_id as WorkerTaskId,
    dispatchId: row.dispatch_id as DispatchId,
    attemptId: row.attempt_id,
    role,
    contractRevision: row.contract_revision,
    orcaResultRef: row.orca_result_ref,
    acceptedAt: row.accepted_at,
  });
}

function decodeDeliveryVerdictRow(row: DeliveryVerdictRow): Decoded<DeliveryVerdictRecord> {
  const role = decodeWorkerRole(row.finalizer_role);
  if (role !== 'finalizer') {
    return fail(`delivery_verdicts.finalizer_role 必须是 finalizer: ${row.finalizer_role}`);
  }
  const refs = decodeStringArrayColumn(row.verdict_refs);
  if (refs === null) {
    return fail('delivery_verdicts.verdict_refs 不是字符串数组');
  }
  let verdict: DeliveryVerdict;
  if (row.verdict_kind === 'deliverable') {
    verdict = { kind: 'deliverable', evidenceRefs: refs };
  } else if (row.verdict_kind === 'blocked') {
    verdict = { kind: 'blocked', blockerRefs: refs };
  } else {
    return fail(`delivery_verdicts.verdict_kind 取值不受支持: ${row.verdict_kind}`);
  }
  return ok({
    coordinationScopeId: row.coordination_scope_id as CoordinationScopeId,
    verdictId: row.verdict_id,
    verdictSequence: row.verdict_sequence,
    verdict,
    finalizerRole: 'finalizer',
    sessionBindingRef: row.session_binding_ref,
    recordedAt: row.recorded_at,
  });
}

function decodeRecoveryRow(row: RecoveryRow): Decoded<RecoveryRecord> {
  const role = decodeWorkerRole(row.role);
  if (role === null) {
    return fail(`recoveries.role 取值不受支持: ${row.role}`);
  }
  if (!(RECOVERY_STATES as readonly string[]).includes(row.status)) {
    return fail(`recoveries.status 取值不受支持: ${row.status}`);
  }
  let terminalOutcome: RecoveryTerminalOutcome | null = null;
  if (row.terminal_outcome !== null) {
    if (!(RECOVERY_TERMINAL_OUTCOMES as readonly string[]).includes(row.terminal_outcome)) {
      return fail(`recoveries.terminal_outcome 取值不受支持: ${row.terminal_outcome}`);
    }
    terminalOutcome = row.terminal_outcome as RecoveryTerminalOutcome;
  }
  return ok({
    coordinationScopeId: row.coordination_scope_id as CoordinationScopeId,
    recoveryId: row.recovery_id as RecoveryId,
    role,
    workPackageId: row.work_package_id as WorkPackageId,
    workerTaskId: row.worker_task_id as WorkerTaskId,
    businessAttemptId: row.business_attempt_id,
    sourceSegmentId: row.source_segment_id as SessionSegmentId,
    sourceDispatchId: row.source_dispatch_id as DispatchId,
    replacementDispatchId: row.replacement_dispatch_id,
    replacementSegmentId: row.replacement_segment_id as SessionSegmentId | null,
    replacementSessionBindingId: row.replacement_session_binding_id,
    supersededSegmentId: row.superseded_segment_id as SessionSegmentId | null,
    status: row.status as RecoveryState,
    consumedBudget: row.consumed_budget,
    capsuleRef: row.capsule_ref,
    prewriteOperationId: row.prewrite_operation_id as OperationId | null,
    terminalOutcome,
    blockingReason: row.blocking_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function decodeExecutionHandoffRow(row: ExecutionHandoffRow): Decoded<ExecutionHandoffRecord> {
  if (!(EXECUTION_HANDOFF_PHASES as readonly string[]).includes(row.phase)) {
    return fail(`execution_handoffs.phase 取值不受支持: ${row.phase}`);
  }
  const responsibilities = decodeStringArrayColumn(row.responsibility_set);
  if (responsibilities === null) {
    return fail('execution_handoffs.responsibility_set 不是字符串数组');
  }
  for (const value of responsibilities) {
    if (!(HANDOFF_RESPONSIBILITIES as readonly string[]).includes(value)) {
      return fail(`execution_handoffs.responsibility_set 取值不受支持: ${value}`);
    }
  }
  return ok({
    coordinationScopeId: row.coordination_scope_id as CoordinationScopeId,
    handoffId: row.handoff_id,
    sourceSessionId: row.source_session_id as CoordinatorSessionId,
    targetSessionId: row.target_session_id as CoordinatorSessionId,
    graphGeneration: row.graph_generation as GraphGeneration,
    responsibilitySet: responsibilities as readonly HandoffResponsibility[],
    phase: row.phase as ExecutionHandoffPhase,
    expectedRevision: row.expected_revision,
    coordinatorContextCapsuleRef: row.coordinator_context_capsule_ref,
    handoffRevision: row.handoff_revision,
    blockingReason: row.blocking_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/** JSON 文本列的解码；形状不合法时返回 `null`，由调用方转成结构化拒绝。 */
function decodeStringArrayColumn(raw: string): readonly string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string' || item.length === 0)) {
    return null;
  }
  return parsed as readonly string[];
}

function decodeScopeRow(row: ScopeRow): Decoded<ScopeRecord> {
  if (!isCoordinationMode(row.mode)) {
    return fail(`scope.mode 取值不受支持: ${row.mode}`);
  }
  if (!isControlState(row.control_state)) {
    return fail(`scope.control_state 取值不受支持: ${row.control_state}`);
  }
  return ok({
    coordinationScopeId: row.coordination_scope_id as CoordinationScopeId,
    fullBranchRef: row.full_branch_ref,
    canonicalWorktreePath: row.canonical_worktree_path,
    mode: row.mode,
    controlState: row.control_state,
    planningCycleId: row.planning_cycle_id as PlanningCycleId | null,
    mapRevision: row.map_revision,
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
    answerText: row.answer_text,
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
    expectedHead: row.expected_head,
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

/** Recovery 的终态不变量：终态结果与状态一一对应，避免「已恢复但没有结果」这类不可读记录。 */
function recoveryTerminalViolation(
  status: RecoveryState,
  terminalOutcome: RecoveryTerminalOutcome | null,
): string | null {
  if (status === 'recovered') {
    return terminalOutcome === 'replaced' || terminalOutcome === 'source_completed'
      ? null
      : 'recovered 必须以 replaced 或 source_completed 终结';
  }
  if (status === 'blocked') {
    return terminalOutcome === null || terminalOutcome === 'failed'
      ? null
      : 'blocked 只能以 failed 终结或保持未终结';
  }
  return terminalOutcome === null ? null : `${status} 不得带 terminalOutcome`;
}

/** 责任集合按集合语义比较，避免调用方仅因顺序不同被拒绝。 */
function sameResponsibilitySet(
  left: readonly HandoffResponsibility[],
  right: readonly HandoffResponsibility[],
): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

/**
 * handoff 的 blockingReason 解析：显式给出时以它为准；否则 blocked 阶段保持原值，离开 blocked
 * 时自动清空，避免旧的失败原因挂在一个已经推进的提案上。
 */
function resolveHandoffBlockingReason(
  phase: ExecutionHandoffPhase,
  provided: string | null | undefined,
  current: string | null,
): string | null {
  if (provided !== undefined) {
    return provided;
  }
  return phase === 'blocked' ? current : null;
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

  const readGraphVersionRows = (scopeId: string, graphId: string): readonly GraphVersionRow[] =>
    many<GraphVersionRow>(
      db.prepare(
        `SELECT * FROM graph_versions
         WHERE coordination_scope_id = ? AND graph_id = ?
         ORDER BY graph_version`,
      ),
      scopeId,
      graphId,
    );

  const readGraphVersionRow = (
    scopeId: string,
    graphId: string,
    graphVersion: number,
  ): GraphVersionRow | undefined =>
    one<GraphVersionRow>(
      db.prepare(
        `SELECT * FROM graph_versions
         WHERE coordination_scope_id = ? AND graph_id = ? AND graph_version = ?`,
      ),
      scopeId,
      graphId,
      graphVersion,
    );

  const readGraphGenerationRows = (scopeId: string): readonly GraphGenerationRow[] =>
    many<GraphGenerationRow>(
      db.prepare(
        'SELECT * FROM graph_generations WHERE coordination_scope_id = ? ORDER BY graph_generation, graph_id',
      ),
      scopeId,
    );

  const readGraphGenerationRow = (scopeId: string, graphId: string): GraphGenerationRow | undefined =>
    one<GraphGenerationRow>(
      db.prepare('SELECT * FROM graph_generations WHERE coordination_scope_id = ? AND graph_id = ?'),
      scopeId,
      graphId,
    );

  const readRevisionHoldRows = (scopeId: string, workPackageId?: string): readonly RevisionHoldRow[] =>
    workPackageId === undefined
      ? many<RevisionHoldRow>(
          db.prepare(
            'SELECT * FROM revision_holds WHERE coordination_scope_id = ? ORDER BY work_package_id',
          ),
          scopeId,
        )
      : many<RevisionHoldRow>(
          db.prepare(
            'SELECT * FROM revision_holds WHERE coordination_scope_id = ? AND work_package_id = ?',
          ),
          scopeId,
          workPackageId,
        );

  const readBaselineReconciliationRows = (
    scopeId: string,
    workPackageId?: string,
  ): readonly BaselineReconciliationRow[] =>
    workPackageId === undefined
      ? many<BaselineReconciliationRow>(
          db.prepare(
            `SELECT * FROM baseline_reconciliations
             WHERE coordination_scope_id = ? ORDER BY created_at, reconciliation_id`,
          ),
          scopeId,
        )
      : many<BaselineReconciliationRow>(
          db.prepare(
            `SELECT * FROM baseline_reconciliations
             WHERE coordination_scope_id = ? AND work_package_id = ? ORDER BY created_at, reconciliation_id`,
          ),
          scopeId,
          workPackageId,
        );

  const readWorkPackageLineageRows = (
    scopeId: string,
    workPackageId?: string,
  ): readonly WorkPackageLineageRow[] =>
    workPackageId === undefined
      ? many<WorkPackageLineageRow>(
          db.prepare(
            'SELECT * FROM work_package_lineages WHERE coordination_scope_id = ? ORDER BY work_package_id',
          ),
          scopeId,
        )
      : many<WorkPackageLineageRow>(
          db.prepare(
            'SELECT * FROM work_package_lineages WHERE coordination_scope_id = ? AND work_package_id = ?',
          ),
          scopeId,
          workPackageId,
        );

  const readBaselineAdoptionRows = (scopeId: string, workPackageId?: string): readonly BaselineAdoptionRow[] =>
    workPackageId === undefined
      ? many<BaselineAdoptionRow>(
          db.prepare(
            'SELECT * FROM baseline_adoptions WHERE coordination_scope_id = ? ORDER BY recorded_at, adoption_id',
          ),
          scopeId,
        )
      : many<BaselineAdoptionRow>(
          db.prepare(
            `SELECT * FROM baseline_adoptions
             WHERE coordination_scope_id = ? AND work_package_id = ? ORDER BY recorded_at, adoption_id`,
          ),
          scopeId,
          workPackageId,
        );

  const readAuthorizationRows = (scopeId: string): readonly AuthorizationRow[] =>
    many<AuthorizationRow>(
      db.prepare(
        `SELECT * FROM execution_authorizations
         WHERE coordination_scope_id = ? ORDER BY authorization_version`,
      ),
      scopeId,
    );

  const readAuthorizationRow = (scopeId: string, authorizationId: string): AuthorizationRow | undefined =>
    one<AuthorizationRow>(
      db.prepare(
        'SELECT * FROM execution_authorizations WHERE coordination_scope_id = ? AND authorization_id = ?',
      ),
      scopeId,
      authorizationId,
    );

  const readPlanningHandoffRows = (scopeId: string): readonly PlanningHandoffRow[] =>
    many<PlanningHandoffRow>(
      db.prepare(
        `SELECT * FROM planning_handoffs
         WHERE coordination_scope_id = ? ORDER BY created_at, proposal_id`,
      ),
      scopeId,
    );

  const readPlanningHandoffRow = (scopeId: string, proposalId: string): PlanningHandoffRow | undefined =>
    one<PlanningHandoffRow>(
      db.prepare('SELECT * FROM planning_handoffs WHERE coordination_scope_id = ? AND proposal_id = ?'),
      scopeId,
      proposalId,
    );

  const readPlanningResponsibilityRow = (scopeId: string): PlanningResponsibilityRow | undefined =>
    one<PlanningResponsibilityRow>(
      db.prepare('SELECT * FROM planning_responsibility WHERE coordination_scope_id = ?'),
      scopeId,
    );

  const readSessionSegmentRows = (
    scopeId: string,
    workPackageId: string | undefined,
  ): readonly SessionSegmentRow[] =>
    workPackageId === undefined
      ? many<SessionSegmentRow>(
          db.prepare(
            `SELECT * FROM session_segments
             WHERE coordination_scope_id = ? ORDER BY recorded_at, segment_id`,
          ),
          scopeId,
        )
      : many<SessionSegmentRow>(
          db.prepare(
            `SELECT * FROM session_segments
             WHERE coordination_scope_id = ? AND work_package_id = ? ORDER BY recorded_at, segment_id`,
          ),
          scopeId,
          workPackageId,
        );

  const readMaterializationBindingRows = (
    scopeId: string,
    workPackageId: string | undefined,
  ): readonly MaterializationBindingRow[] =>
    workPackageId === undefined
      ? many<MaterializationBindingRow>(
          db.prepare(
            `SELECT * FROM materialization_bindings
             WHERE coordination_scope_id = ? ORDER BY created_at, work_package_id`,
          ),
          scopeId,
        )
      : many<MaterializationBindingRow>(
          db.prepare(
            `SELECT * FROM materialization_bindings
             WHERE coordination_scope_id = ? AND work_package_id = ?`,
          ),
          scopeId,
          workPackageId,
        );

  const readDeliverySettlementRows = (
    scopeId: string,
    dedupeKey: string | undefined,
  ): readonly DeliverySettlementRow[] =>
    dedupeKey === undefined
      ? many<DeliverySettlementRow>(
          db.prepare(
            `SELECT * FROM delivery_settlements
             WHERE coordination_scope_id = ? ORDER BY accepted_at, dedupe_key`,
          ),
          scopeId,
        )
      : many<DeliverySettlementRow>(
          db.prepare(
            'SELECT * FROM delivery_settlements WHERE coordination_scope_id = ? AND dedupe_key = ?',
          ),
          scopeId,
          dedupeKey,
        );

  const readDeliveryVerdictRows = (scopeId: string): readonly DeliveryVerdictRow[] =>
    many<DeliveryVerdictRow>(
      db.prepare(
        `SELECT * FROM delivery_verdicts
         WHERE coordination_scope_id = ? ORDER BY verdict_sequence`,
      ),
      scopeId,
    );

  const readRecoveryRows = (
    scopeId: string,
    businessAttemptId: string | undefined,
  ): readonly RecoveryRow[] =>
    businessAttemptId === undefined
      ? many<RecoveryRow>(
          db.prepare(
            `SELECT * FROM recoveries
             WHERE coordination_scope_id = ? ORDER BY created_at, recovery_id`,
          ),
          scopeId,
        )
      : many<RecoveryRow>(
          db.prepare(
            `SELECT * FROM recoveries
             WHERE coordination_scope_id = ? AND business_attempt_id = ?
             ORDER BY created_at, recovery_id`,
          ),
          scopeId,
          businessAttemptId,
        );

  const readRecoveryRow = (scopeId: string, recoveryId: string): RecoveryRow | undefined =>
    one<RecoveryRow>(
      db.prepare('SELECT * FROM recoveries WHERE coordination_scope_id = ? AND recovery_id = ?'),
      scopeId,
      recoveryId,
    );

  const readExecutionHandoffRows = (scopeId: string): readonly ExecutionHandoffRow[] =>
    many<ExecutionHandoffRow>(
      db.prepare(
        `SELECT * FROM execution_handoffs
         WHERE coordination_scope_id = ? ORDER BY created_at, handoff_id`,
      ),
      scopeId,
    );

  const readExecutionHandoffRow = (scopeId: string, handoffId: string): ExecutionHandoffRow | undefined =>
    one<ExecutionHandoffRow>(
      db.prepare('SELECT * FROM execution_handoffs WHERE coordination_scope_id = ? AND handoff_id = ?'),
      scopeId,
      handoffId,
    );

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
    const handoffs = decodeRows(readPlanningHandoffRows(scopeId), decodePlanningHandoffRow);
    if (!handoffs.ok) {
      return handoffs;
    }
    const responsibilityRow = readPlanningResponsibilityRow(scopeId);
    const segments = decodeRows(readSessionSegmentRows(scopeId, undefined), decodeSessionSegmentRow);
    if (!segments.ok) {
      return segments;
    }
    const settlements = decodeRows(
      readDeliverySettlementRows(scopeId, undefined),
      decodeDeliverySettlementRow,
    );
    if (!settlements.ok) {
      return settlements;
    }
    const verdicts = decodeRows(readDeliveryVerdictRows(scopeId), decodeDeliveryVerdictRow);
    if (!verdicts.ok) {
      return verdicts;
    }
    const recoveries = decodeRows(readRecoveryRows(scopeId, undefined), decodeRecoveryRow);
    if (!recoveries.ok) {
      return recoveries;
    }
    const executionHandoffs = decodeRows(readExecutionHandoffRows(scopeId), decodeExecutionHandoffRow);
    if (!executionHandoffs.ok) {
      return executionHandoffs;
    }
    const graphGenerations = decodeRows(readGraphGenerationRows(scopeId), decodeGraphGenerationRow);
    if (!graphGenerations.ok) {
      return graphGenerations;
    }
    const revisionHolds = decodeRows(readRevisionHoldRows(scopeId, undefined), decodeRevisionHoldRow);
    if (!revisionHolds.ok) {
      return revisionHolds;
    }
    const baselineReconciliations = decodeRows(
      readBaselineReconciliationRows(scopeId, undefined),
      decodeBaselineReconciliationRow,
    );
    if (!baselineReconciliations.ok) {
      return baselineReconciliations;
    }
    const workPackageLineages = decodeRows(
      readWorkPackageLineageRows(scopeId, undefined),
      decodeWorkPackageLineageRow,
    );
    if (!workPackageLineages.ok) {
      return workPackageLineages;
    }
    const baselineAdoptions = decodeRows(readBaselineAdoptionRows(scopeId, undefined), decodeBaselineAdoptionRow);
    if (!baselineAdoptions.ok) {
      return baselineAdoptions;
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
      planningHandoffs: handoffs.value,
      planningResponsibility:
        responsibilityRow === undefined ? null : decodePlanningResponsibilityRow(responsibilityRow),
      sessionSegments: segments.value,
      materializationBindings: readMaterializationBindingRows(scopeId, undefined).map(
        decodeMaterializationBindingRow,
      ),
      deliverySettlements: settlements.value,
      deliveryVerdicts: verdicts.value,
      recoveries: recoveries.value,
      executionHandoffs: executionHandoffs.value,
      graphGenerations: graphGenerations.value,
      revisionHolds: revisionHolds.value,
      baselineReconciliations: baselineReconciliations.value,
      workPackageLineages: workPackageLineages.value,
      baselineAdoptions: baselineAdoptions.value,
      // lane 阻塞由未决 intent 派生：只覆盖确有未决 intent 的 lane，不构成全局锁。
      mutationLanes: projectMutationLanes(intents.value),
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
        case 'graph-versions': {
          const versions = decodeRows(readGraphVersionRows(scopeId, input.graphId), decodeGraphVersionRow);
          if (!versions.ok) {
            return { kind: 'rejected', code: 'unreadable', message: versions.message };
          }
          return { kind: 'graph-versions', versions: versions.value };
        }
        case 'graph-version': {
          const row = readGraphVersionRow(scopeId, input.graphId, input.graphVersion);
          if (row === undefined) {
            return { kind: 'graph-version', version: null };
          }
          const version = decodeGraphVersionRow(row);
          if (!version.ok) {
            return { kind: 'rejected', code: 'unreadable', message: version.message };
          }
          return { kind: 'graph-version', version: version.value };
        }
        case 'authorizations': {
          const authorizations = decodeRows(readAuthorizationRows(scopeId), decodeAuthorizationRow);
          if (!authorizations.ok) {
            return { kind: 'rejected', code: 'unreadable', message: authorizations.message };
          }
          return { kind: 'authorizations', authorizations: authorizations.value };
        }
        case 'authorization': {
          const row = readAuthorizationRow(scopeId, input.authorizationId);
          if (row === undefined) {
            return { kind: 'authorization', authorization: null };
          }
          const authorization = decodeAuthorizationRow(row);
          if (!authorization.ok) {
            return { kind: 'rejected', code: 'unreadable', message: authorization.message };
          }
          return { kind: 'authorization', authorization: authorization.value };
        }
        case 'planning-handoffs': {
          const handoffs = decodeRows(readPlanningHandoffRows(scopeId), decodePlanningHandoffRow);
          if (!handoffs.ok) {
            return { kind: 'rejected', code: 'unreadable', message: handoffs.message };
          }
          return { kind: 'planning-handoffs', handoffs: handoffs.value };
        }
        case 'planning-handoff': {
          const row = readPlanningHandoffRow(scopeId, input.proposalId);
          if (row === undefined) {
            return { kind: 'planning-handoff', handoff: null };
          }
          const handoff = decodePlanningHandoffRow(row);
          if (!handoff.ok) {
            return { kind: 'rejected', code: 'unreadable', message: handoff.message };
          }
          return { kind: 'planning-handoff', handoff: handoff.value };
        }
        case 'planning-responsibility': {
          const row = readPlanningResponsibilityRow(scopeId);
          return {
            kind: 'planning-responsibility',
            responsibility: row === undefined ? null : decodePlanningResponsibilityRow(row),
          };
        }
        case 'session-segments': {
          const segments = decodeRows(
            readSessionSegmentRows(scopeId, input.workPackageId),
            decodeSessionSegmentRow,
          );
          if (!segments.ok) {
            return { kind: 'rejected', code: 'unreadable', message: segments.message };
          }
          return { kind: 'session-segments', segments: segments.value };
        }
        case 'materialization-bindings':
          return {
            kind: 'materialization-bindings',
            bindings: readMaterializationBindingRows(scopeId, input.workPackageId).map(
              decodeMaterializationBindingRow,
            ),
          };
        case 'delivery-settlements': {
          const settlements = decodeRows(
            readDeliverySettlementRows(scopeId, input.dedupeKey),
            decodeDeliverySettlementRow,
          );
          if (!settlements.ok) {
            return { kind: 'rejected', code: 'unreadable', message: settlements.message };
          }
          return { kind: 'delivery-settlements', settlements: settlements.value };
        }
        case 'delivery-verdicts': {
          const verdicts = decodeRows(readDeliveryVerdictRows(scopeId), decodeDeliveryVerdictRow);
          if (!verdicts.ok) {
            return { kind: 'rejected', code: 'unreadable', message: verdicts.message };
          }
          return { kind: 'delivery-verdicts', verdicts: verdicts.value };
        }
        case 'recoveries': {
          const recoveries = decodeRows(
            readRecoveryRows(scopeId, input.businessAttemptId),
            decodeRecoveryRow,
          );
          if (!recoveries.ok) {
            return { kind: 'rejected', code: 'unreadable', message: recoveries.message };
          }
          return { kind: 'recoveries', recoveries: recoveries.value };
        }
        case 'recovery': {
          const row = readRecoveryRow(scopeId, input.recoveryId);
          if (row === undefined) {
            return { kind: 'recovery', recovery: null };
          }
          const recovery = decodeRecoveryRow(row);
          if (!recovery.ok) {
            return { kind: 'rejected', code: 'unreadable', message: recovery.message };
          }
          return { kind: 'recovery', recovery: recovery.value };
        }
        case 'execution-handoffs': {
          const handoffs = decodeRows(readExecutionHandoffRows(scopeId), decodeExecutionHandoffRow);
          if (!handoffs.ok) {
            return { kind: 'rejected', code: 'unreadable', message: handoffs.message };
          }
          return { kind: 'execution-handoffs', handoffs: handoffs.value };
        }
        case 'execution-handoff': {
          const row = readExecutionHandoffRow(scopeId, input.handoffId);
          if (row === undefined) {
            return { kind: 'execution-handoff', handoff: null };
          }
          const handoff = decodeExecutionHandoffRow(row);
          if (!handoff.ok) {
            return { kind: 'rejected', code: 'unreadable', message: handoff.message };
          }
          return { kind: 'execution-handoff', handoff: handoff.value };
        }
        case 'graph-generations': {
          const generations = decodeRows(readGraphGenerationRows(scopeId), decodeGraphGenerationRow);
          if (!generations.ok) {
            return { kind: 'rejected', code: 'unreadable', message: generations.message };
          }
          return { kind: 'graph-generations', generations: generations.value };
        }
        case 'graph-generation': {
          const row = readGraphGenerationRow(scopeId, input.graphId);
          if (row === undefined) {
            return { kind: 'graph-generation', generation: null };
          }
          const generation = decodeGraphGenerationRow(row);
          if (!generation.ok) {
            return { kind: 'rejected', code: 'unreadable', message: generation.message };
          }
          return { kind: 'graph-generation', generation: generation.value };
        }
        case 'graph-patch-record': {
          const row = readGraphVersionRow(scopeId, input.graphId, input.graphVersion);
          if (row === undefined || row.patch_json === null) {
            return { kind: 'graph-patch-record', record: null };
          }
          let raw: unknown;
          try {
            raw = JSON.parse(row.patch_json);
          } catch (error) {
            return {
              kind: 'rejected',
              code: 'unreadable',
              message: `graph_versions.patch_json 不是合法 JSON: ${describeError(error)}`,
            };
          }
          const payload = decodeGraphPatchPayload(raw, 'graph_versions.patch_json');
          if (!payload.ok) {
            return { kind: 'rejected', code: 'unreadable', message: payload.message };
          }
          return {
            kind: 'graph-patch-record',
            record: {
              coordinationScopeId: scopeId,
              graphId: input.graphId,
              graphVersion: input.graphVersion,
              ...payload.value,
            },
          };
        }
        case 'revision-holds': {
          const holds = decodeRows(readRevisionHoldRows(scopeId, input.workPackageId), decodeRevisionHoldRow);
          if (!holds.ok) {
            return { kind: 'rejected', code: 'unreadable', message: holds.message };
          }
          return { kind: 'revision-holds', holds: holds.value };
        }
        case 'baseline-reconciliations': {
          const reconciliations = decodeRows(
            readBaselineReconciliationRows(scopeId, input.workPackageId),
            decodeBaselineReconciliationRow,
          );
          if (!reconciliations.ok) {
            return { kind: 'rejected', code: 'unreadable', message: reconciliations.message };
          }
          return { kind: 'baseline-reconciliations', reconciliations: reconciliations.value };
        }
        case 'work-package-lineages': {
          const lineages = decodeRows(
            readWorkPackageLineageRows(scopeId, input.workPackageId),
            decodeWorkPackageLineageRow,
          );
          if (!lineages.ok) {
            return { kind: 'rejected', code: 'unreadable', message: lineages.message };
          }
          return { kind: 'work-package-lineages', lineages: lineages.value };
        }
        case 'baseline-adoptions': {
          const adoptions = decodeRows(
            readBaselineAdoptionRows(scopeId, input.workPackageId),
            decodeBaselineAdoptionRow,
          );
          if (!adoptions.ok) {
            return { kind: 'rejected', code: 'unreadable', message: adoptions.message };
          }
          return { kind: 'baseline-adoptions', adoptions: adoptions.value };
        }
        default:
          return { kind: 'rejected', code: 'invalid_query', message: '未登记的 query variant' };
      }
    } catch (error) {
      return { kind: 'rejected', code: 'unreadable', message: describeError(error) };
    }
  };

  /**
   * 把 Execution Coordination Lease 交给给定写入者。
   *
   * 调用方负责先做「没有别的持有者」这一守卫；这里只做写入：释放该 Scope 下仍活跃的执行租约，再以
   * 递增 fencing generation 为写入者建立租约。Transition 与 Generation Cutover 共用它，因此两条
   * 路径不可能对「谁持有执行责任」给出不同的结果。
   */
  const handExecutionLease = (scopeId: string, writer: CoordinationCommand['writer'], now: number): void => {
    db.prepare(
      `UPDATE leases SET released_at = ?
       WHERE coordination_scope_id = ? AND lease_kind = 'execution_coordination' AND released_at IS NULL`,
    ).run(now, scopeId);
    const maxRow = db
      .prepare(
        `SELECT MAX(fencing_generation) AS generation FROM leases
         WHERE coordination_scope_id = ? AND lease_kind = 'execution_coordination'`,
      )
      .get(scopeId) as { readonly generation: number | null } | undefined;
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
      scopeId,
      writer.coordinatorSessionId,
      writer.runtimeIncarnationId,
      nextFencingGeneration(maxRow?.generation ?? null),
      now,
    );
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

  /**
   * 与 Recovery 收尾同事务地写入替代 Session Segment。
   *
   * 幂等策略是刻意选择的：`segmentId` 已存在且**全部字段一致**时跳过插入、让推进继续（崩溃窗口
   * 「Segment 已落盘、Recovery 未收尾」重启后必须能收尾）；已存在但内容不一致时按 `constraint`
   * 拒绝，由调用方整笔回滚，不覆盖既有 Segment。
   *
   * 插入字段与 `record-session-segment` 完全一致：这是同一种事实，只是写入时机必须与预算消耗绑定。
   */
  const ensureReplacementSegment = (
    scopeId: string,
    segment: ReplacementSegmentInput,
    now: number,
  ): Decoded<null> => {
    const existing = one<SessionSegmentRow>(
      db.prepare(`SELECT * FROM session_segments WHERE coordination_scope_id = ? AND segment_id = ?`),
      scopeId,
      segment.segmentId,
    );
    if (existing !== undefined) {
      const identical =
        existing.work_package_id === segment.workPackageId &&
        existing.role === segment.role &&
        existing.worker_task_id === segment.workerTaskId &&
        existing.dispatch_id === segment.dispatchId &&
        existing.attempt_id === segment.attemptId &&
        existing.session_binding_id === segment.sessionBindingId &&
        existing.last_transcript_ref === segment.lastTranscriptRef &&
        existing.terminal_receipt_ref === segment.terminalReceiptRef &&
        (existing.transcript_referenceable === 1) === segment.transcriptReferenceable &&
        (existing.verifiable === 1) === segment.verifiable;
      return identical
        ? ok(null)
        : fail(`Session Segment ${segment.segmentId} 已存在但内容不一致，拒绝覆盖`, 'constraint');
    }
    db.prepare(
      `INSERT INTO session_segments (
         coordination_scope_id, segment_id, work_package_id, role, worker_task_id, dispatch_id,
         attempt_id, session_binding_id, last_transcript_ref, terminal_receipt_ref,
         transcript_referenceable, verifiable, recorded_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      scopeId,
      segment.segmentId,
      segment.workPackageId,
      segment.role,
      segment.workerTaskId,
      segment.dispatchId,
      segment.attemptId,
      segment.sessionBindingId,
      segment.lastTranscriptRef,
      segment.terminalReceiptRef,
      segment.transcriptReferenceable ? 1 : 0,
      segment.verifiable ? 1 : 0,
      now,
    );
    return ok(null);
  };

  /**
   * cutover：在同一事务内把 Execution Coordination 责任从 Source 转给 Target。
   *
   * 调用者必须已经按**转移前**的状态确认写入者仍是 Source（见 `advance-execution-handoff`）：
   * 这个函数一执行，租约就已经不在 Source 名下了，事后无法再判定它曾经是 holder。
   *
   * 责任对应关系：执行期「当前 Graph Generation 后续 Worker 生命周期事件责任」的承载者就是
   * Execution Coordination Lease holder（Worker 事件只有 holder 能推进），因此释放 + 取得租约
   * 这两行 lease 已经覆盖它，不需要第二份责任记录，也不复制任何 Run/Task/Dispatch 身份。
   *
   * `runtime_incarnation_id` 在执行租约上只作诊断（全仓判定只比较 `coordinator_session_id`）：
   * Target 此刻尚未持有 Runtime Incarnation，因此这里保留执行转移的那次 incarnation。
   *
   * 顺序不可调换：`leases_single_execution_lease` 要求同一 Scope 同时至多一个未释放执行租约，
   * 必须先释放 Source 再为 Target 取得；两者同事务，外部看不到中间态。
   */
  const transferExecutionResponsibility = (
    scopeId: string,
    fromSessionId: string,
    toSessionId: string,
    incarnationId: string,
    now: number,
  ): Decoded<null> => {
    const released = db
      .prepare(
        `UPDATE leases SET released_at = ?
         WHERE coordination_scope_id = ? AND lease_kind = 'execution_coordination'
           AND coordinator_session_id = ? AND released_at IS NULL`,
      )
      .run(now, scopeId, fromSessionId);
    if (Number(released.changes) === 0) {
      return fail('Source 没有可转移的 Execution Coordination Lease', 'constraint');
    }

    const maxRow = db
      .prepare(
        `SELECT MAX(fencing_generation) AS generation FROM leases
         WHERE coordination_scope_id = ? AND lease_kind = 'execution_coordination'`,
      )
      .get(scopeId) as { readonly generation: number | null } | undefined;
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
    ).run(scopeId, toSessionId, incarnationId, nextFencingGeneration(maxRow?.generation ?? null), now);

    // 相关 Pending Interaction 的责任随执行责任一起转移；已回答/已取消的历史不动。
    db.prepare(
      `UPDATE pending_interactions SET owner_coordinator_session_id = ?
       WHERE coordination_scope_id = ? AND owner_coordinator_session_id = ? AND state = 'open'`,
    ).run(toSessionId, scopeId, fromSessionId);
    return ok(null);
  };

  const applyCommand = (
    cmd: CoordinationCommand,
    now: number,
    currentRevision: number,
    nextRevision: number,
  ): Decoded<null> => {
    switch (cmd.kind) {
      case 'initialize-scope': {
        db.prepare(
          `INSERT INTO scope (
             coordination_scope_id, full_branch_ref, canonical_worktree_path,
             mode, control_state, planning_cycle_id,
             graph_id, graph_version, authorization_id, authorization_version, revision, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
        ).run(
          cmd.coordinationScopeId,
          cmd.fullBranchRef,
          cmd.canonicalWorktreePath,
          cmd.mode,
          cmd.controlState,
          cmd.planningCycleId,
          nextRevision,
          now,
        );
        db.prepare(
          `INSERT INTO session_registry (
             coordination_scope_id, coordinator_session_id, coordinator_model_configuration_ref,
             lifecycle_state, registered_at
           ) VALUES (?, ?, ?, 'registered', ?)`,
        ).run(cmd.coordinationScopeId, cmd.coordinatorSessionId, cmd.coordinatorModelConfigurationRef, now);
        db.prepare(
          `INSERT INTO planning_responsibility (
             coordination_scope_id, coordinator_session_id, source_proposal_id, assigned_at
           ) VALUES (?, ?, NULL, ?)`,
        ).run(cmd.coordinationScopeId, cmd.coordinatorSessionId, now);
        return ok(null);
      }
      case 'record-graph-version': {
        /**
         * 已接受的图修订只能由 Execution Coordination Lease 持有者推进。
         *
         * `initial` 不需要这道守卫：候选图在规划期内就该被记录（那时还没有执行租约）。修订则不同——
         * 它改变正在执行的拓扑，必须来自当前唯一有权推进执行事实的那个 Session。
         */
        if (cmd.recordKind === 'accepted_revision') {
          const holder = executionHolderViolation(cmd.coordinationScopeId, cmd.writer);
          if (!holder.ok) {
            return holder;
          }
          const scope = readScopeRow(cmd.coordinationScopeId);
          if (scope?.control_state !== 'active' || scope.graph_id !== cmd.graphId) {
            return fail('当前图不在可修订的执行状态', 'invalid_state');
          }
        }
        const head = db
          .prepare(
            `SELECT MAX(graph_version) AS head FROM graph_versions
             WHERE coordination_scope_id = ? AND graph_id = ?`,
          )
          .get(cmd.coordinationScopeId, cmd.graphId) as { readonly head: number | null } | undefined;
        const headVersion = head?.head ?? null;
        if (cmd.recordKind === 'initial') {
          if (headVersion !== null) {
            return fail('该 GraphId 已有 GraphVersion，initial 只能追加一次', 'constraint');
          }
          if (cmd.graphVersion !== 1) {
            return fail('initial GraphVersion 必须为 1', 'constraint');
          }
          if (cmd.parentVersion !== null) {
            return fail('initial GraphVersion 不得带 parentVersion', 'constraint');
          }
        } else {
          if (cmd.patch === null) {
            return fail('accepted_revision 必须携带补丁元数据', 'constraint');
          }
          if (headVersion === null) {
            return fail('accepted_revision 必须基于已存在的 GraphVersion', 'constraint');
          }
          if (cmd.parentVersion !== headVersion) {
            return fail(`parentVersion 必须等于当前 head ${headVersion}`, 'constraint');
          }
          if (cmd.graphVersion !== headVersion + 1) {
            return fail(`GraphVersion 必须连续追加，下一个为 ${headVersion + 1}`, 'constraint');
          }
          if (cmd.patch.baseGraphVersion !== headVersion) {
            return fail(`补丁的 baseGraphVersion 必须等于当前 head ${headVersion}`, 'constraint');
          }
        }
        db.prepare(
          `INSERT INTO graph_versions (
             coordination_scope_id, graph_id, graph_version, graph_generation, record_kind, parent_version,
             map_revision, plan_revision, orca_run_id, graph_json, patch_id, patch_json, recorded_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          cmd.coordinationScopeId,
          cmd.graphId,
          cmd.graphVersion,
          cmd.generation,
          cmd.recordKind,
          cmd.parentVersion,
          cmd.mapRevision,
          cmd.planRevision,
          cmd.orcaRunId,
          JSON.stringify(cmd.graph),
          cmd.patch === null ? null : cmd.patch.patchId,
          cmd.patch === null
            ? null
            : JSON.stringify({
                patchId: cmd.patch.patchId,
                operationId: cmd.patch.operationId,
                baseGraphVersion: cmd.patch.baseGraphVersion,
                added: cmd.patch.added,
                revised: cmd.patch.revised,
                retired: cmd.patch.retired,
                descendants: cmd.patch.descendants,
                takesOver: cmd.patch.takesOver,
              }),
          now,
        );
        // revision pending 与图版本同事务：不存在「图已经改了，但该冻结的节点仍可派发」的窗口。
        for (const workPackageId of cmd.patch?.revisionPendingWorkPackageIds ?? []) {
          db.prepare(
            `INSERT INTO revision_holds (
               coordination_scope_id, work_package_id, source, source_ref, state,
               created_at, released_at, release_reason
             ) VALUES (?, ?, 'graph_patch', ?, 'pending', ?, NULL, NULL)
             ON CONFLICT (coordination_scope_id, work_package_id) DO UPDATE SET
               source = excluded.source,
               source_ref = excluded.source_ref,
               state = 'pending',
               released_at = NULL,
               release_reason = NULL`,
          ).run(cmd.coordinationScopeId, workPackageId, cmd.patch?.patchId ?? '', now);
        }
        for (const reconciliation of cmd.baselineReconciliations ?? []) {
          const open = one<BaselineReconciliationRow>(
            db.prepare(`SELECT * FROM baseline_reconciliations WHERE coordination_scope_id = ? AND work_package_id = ? AND state != 'verified'`),
            cmd.coordinationScopeId,
            reconciliation.workPackageId,
          );
          if (open !== undefined) return fail(`Work Package ${reconciliation.workPackageId} 已有未完成的基线补救`, 'constraint');
          db.prepare(
            `INSERT INTO baseline_reconciliations (
               coordination_scope_id, reconciliation_id, work_package_id, role, required_baseline_head,
               observed_head, ancestry_verified, target_head_verified, dirty_paths_reconciled,
               scope_reconciled, state, blocker_ref, created_at, updated_at
             ) VALUES (?, ?, ?, 'planner', ?, NULL, 0, 0, 0, 0, 'required', NULL, ?, ?)`,
          ).run(cmd.coordinationScopeId, reconciliation.reconciliationId, reconciliation.workPackageId, reconciliation.requiredBaselineHead, now, now);
        }
        // 追加与「当前图」指针在同一事务里推进：图体永远只有一条权威记录，指针不可能指到不存在的版本。
        const scope = readScopeRow(cmd.coordinationScopeId);
        if (cmd.recordKind === 'accepted_revision' || scope?.graph_id === null) {
          db.prepare(
            'UPDATE scope SET graph_id = ?, graph_version = ?, updated_at = ? WHERE coordination_scope_id = ?',
          ).run(cmd.graphId, cmd.graphVersion, now, cmd.coordinationScopeId);
        }
        // 修订额度与图变化原子记账：读—改—写都在这一笔事务内，因此不可能只发生一半。
        for (const consumption of cmd.budgetConsumption ?? []) {
          const existing = db
            .prepare('SELECT * FROM budget_counters WHERE coordination_scope_id = ? AND budget_key = ?')
            .get(cmd.coordinationScopeId, consumption.budgetKey) as BudgetRow | undefined;
          if (existing !== undefined && existing.approved_limit_ref !== consumption.approvedLimitRef) {
            return fail('已登记的预算授权上限引用与本次不一致，拒绝在同一计数上叠加', 'constraint');
          }
          db.prepare(
            `INSERT INTO budget_counters (coordination_scope_id, budget_key, approved_limit_ref, consumed)
             VALUES (?, ?, ?, ?)
             ON CONFLICT (coordination_scope_id, budget_key) DO UPDATE SET consumed = consumed + excluded.consumed`,
          ).run(
            cmd.coordinationScopeId,
            consumption.budgetKey,
            consumption.approvedLimitRef,
            consumption.amount,
          );
        }
        return ok(null);
      }
      case 'record-authorization': {
        const head = db
          .prepare(
            `SELECT MAX(authorization_version) AS head FROM execution_authorizations
             WHERE coordination_scope_id = ?`,
          )
          .get(cmd.coordinationScopeId) as { readonly head: number | null } | undefined;
        const expected = (head?.head ?? 0) + 1;
        if (cmd.authorizationVersion !== expected) {
          return fail(`authorizationVersion 必须为 ${expected}`, 'constraint');
        }
        db.prepare(
          `INSERT INTO execution_authorizations (
             coordination_scope_id, authorization_id, authorization_version, manifest_version,
             fingerprint, approval_ref, manifest_json, approved_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          cmd.coordinationScopeId,
          cmd.authorizationId,
          cmd.authorizationVersion,
          cmd.manifestVersion,
          cmd.fingerprint,
          cmd.approvalRef,
          JSON.stringify(cmd.manifest),
          now,
        );
        // 授权记录与 Scope 指针同批推进：不存在「指针指向某份授权，而该授权不在历史里」的中间态。
        const scope = readScopeRow(cmd.coordinationScopeId);
        if (scope?.graph_id === cmd.manifest.graph.graphId) {
          db.prepare(
            `UPDATE scope SET authorization_id = ?, authorization_version = ?, updated_at = ?
             WHERE coordination_scope_id = ?`,
          ).run(cmd.authorizationId, cmd.authorizationVersion, now, cmd.coordinationScopeId);
        }
        return ok(null);
      }
      case 'record-planning-handoff': {
        const existing = readPlanningHandoffRow(cmd.coordinationScopeId, cmd.proposalId);
        if (cmd.expectedProposalRevision === null) {
          if (existing !== undefined) {
            return fail(`交接提案 ${cmd.proposalId} 已存在`, 'constraint');
          }
          if (cmd.phase !== 'prepared') {
            return fail('新提案必须以 prepared 阶段创建', 'invalid_state');
          }
          db.prepare(
            `INSERT INTO planning_handoffs (
               coordination_scope_id, proposal_id, source_coordinator_session_id, target_coordinator_session_id,
               phase, map_revision, plan_revision, graph_id, graph_version, capsule_ref,
               proposal_revision, created_at, updated_at
             ) VALUES (?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?, 1, ?, ?)`,
          ).run(
            cmd.coordinationScopeId,
            cmd.proposalId,
            cmd.sourceCoordinatorSessionId,
            cmd.targetCoordinatorSessionId,
            cmd.mapRevision,
            cmd.planRevision,
            cmd.graphId,
            cmd.graphVersion,
            cmd.capsuleRef,
            now,
            now,
          );
          return ok(null);
        }
        if (existing === undefined) {
          return fail(`交接提案 ${cmd.proposalId} 不存在`, 'invalid_state');
        }
        const current = decodePlanningHandoffRow(existing);
        if (!current.ok) {
          return current;
        }
        if (existing.proposal_revision !== cmd.expectedProposalRevision) {
          return fail(
            `交接提案 revision ${cmd.expectedProposalRevision} 已过期，当前为 ${existing.proposal_revision}`,
            'constraint',
          );
        }
        if (
          cmd.sourceCoordinatorSessionId !== current.value.sourceCoordinatorSessionId ||
          cmd.targetCoordinatorSessionId !== current.value.targetCoordinatorSessionId
        ) {
          return fail('交接提案的 Source/Target 在创建后不可更改', 'constraint');
        }
        if (!PLANNING_HANDOFF_TRANSITIONS[current.value.phase].includes(cmd.phase)) {
          return fail(`不允许从 ${current.value.phase} 迁移到 ${cmd.phase}`, 'invalid_state');
        }
        db.prepare(
          `UPDATE planning_handoffs SET
             phase = ?, map_revision = ?, plan_revision = ?, graph_id = ?, graph_version = ?,
             capsule_ref = ?, proposal_revision = proposal_revision + 1, updated_at = ?
           WHERE coordination_scope_id = ? AND proposal_id = ?`,
        ).run(
          cmd.phase,
          cmd.mapRevision,
          cmd.planRevision,
          cmd.graphId,
          cmd.graphVersion,
          cmd.capsuleRef,
          now,
          cmd.coordinationScopeId,
          cmd.proposalId,
        );
        if (cmd.phase === 'cutover') {
          db.prepare(
            `INSERT INTO planning_responsibility (
               coordination_scope_id, coordinator_session_id, source_proposal_id, assigned_at
             ) VALUES (?, ?, ?, ?)
             ON CONFLICT (coordination_scope_id) DO UPDATE SET
               coordinator_session_id = excluded.coordinator_session_id,
               source_proposal_id = excluded.source_proposal_id,
               assigned_at = excluded.assigned_at`,
          ).run(cmd.coordinationScopeId, cmd.targetCoordinatorSessionId, cmd.proposalId, now);
        }
        return ok(null);
      }
      case 'transition-to-execution': {
        const active = db
          .prepare(
            `SELECT * FROM leases
             WHERE coordination_scope_id = ? AND lease_kind = 'execution_coordination' AND released_at IS NULL`,
          )
          .get(cmd.coordinationScopeId) as LeaseRow | undefined;
        if (active !== undefined && active.coordinator_session_id !== cmd.writer.coordinatorSessionId) {
          return fail('Execution Coordination Lease 已由其它 Coordinator Session 持有', 'constraint');
        }
        db.prepare(
          `UPDATE scope SET
             mode = 'execution_coordination', planning_cycle_id = ?, graph_id = ?, graph_version = ?,
             authorization_id = ?, authorization_version = ?, updated_at = ?
           WHERE coordination_scope_id = ?`,
        ).run(
          cmd.planningCycleId,
          cmd.graphId,
          cmd.graphVersion,
          cmd.authorizationId,
          cmd.authorizationVersion,
          now,
          cmd.coordinationScopeId,
        );
        handExecutionLease(cmd.coordinationScopeId, cmd.writer, now);
        return ok(null);
      }
      case 'advance-map-revision': {
        const current = readScopeRow(cmd.coordinationScopeId)?.map_revision ?? 0;
        if (cmd.mapRevision !== current + 1) {
          return fail(`mapRevision 必须连续推进，下一个为 ${current + 1}`, 'constraint');
        }
        db.prepare('UPDATE scope SET map_revision = ?, updated_at = ? WHERE coordination_scope_id = ?').run(
          cmd.mapRevision,
          now,
          cmd.coordinationScopeId,
        );
        return ok(null);
      }
      case 'record-session-segment': {
        const holder = executionHolderViolation(cmd.coordinationScopeId, cmd.writer);
        if (!holder.ok) {
          return holder;
        }
        const existing = one<SessionSegmentRow>(
          db.prepare(
            `SELECT * FROM session_segments WHERE coordination_scope_id = ? AND segment_id = ?`,
          ),
          cmd.coordinationScopeId,
          cmd.segmentId,
        );
        if (existing !== undefined) {
          return fail(`Session Segment ${cmd.segmentId} 已存在`, 'constraint');
        }
        db.prepare(
          `INSERT INTO session_segments (
             coordination_scope_id, segment_id, work_package_id, role, worker_task_id, dispatch_id,
             attempt_id, session_binding_id, last_transcript_ref, terminal_receipt_ref,
             transcript_referenceable, verifiable, recorded_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          cmd.coordinationScopeId,
          cmd.segmentId,
          cmd.workPackageId,
          cmd.role,
          cmd.workerTaskId,
          cmd.dispatchId,
          cmd.attemptId,
          cmd.sessionBindingId,
          cmd.lastTranscriptRef,
          cmd.terminalReceiptRef,
          cmd.transcriptReferenceable ? 1 : 0,
          cmd.verifiable ? 1 : 0,
          now,
        );
        return ok(null);
      }
      case 'record-materialization-binding': {
        const holder = executionHolderViolation(cmd.coordinationScopeId, cmd.writer);
        if (!holder.ok) {
          return holder;
        }
        db.prepare(
          `INSERT INTO materialization_bindings (
             coordination_scope_id, work_package_id, orca_task_id, creation_operation_id, created_at
           ) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (coordination_scope_id, work_package_id) DO UPDATE SET
             orca_task_id = excluded.orca_task_id,
             creation_operation_id = excluded.creation_operation_id,
             created_at = excluded.created_at`,
        ).run(
          cmd.coordinationScopeId,
          cmd.workPackageId,
          cmd.orcaTaskId,
          cmd.creationOperationId,
          now,
        );
        return ok(null);
      }
      case 'record-delivery-settlement': {
        const holder = executionHolderViolation(cmd.coordinationScopeId, cmd.writer);
        if (!holder.ok) {
          return holder;
        }
        // 主键或 Delivery 身份冲突一律由约束路径转成结构化拒绝：调用方回读既有记录再决定是否确认，
        // 绝不在这里覆盖已登记的 Orca 结果引用。
        db.prepare(
          `INSERT INTO delivery_settlements (
             coordination_scope_id, dedupe_key, delivery_id, run_id, consumer_generation, worker_task_id,
             dispatch_id, attempt_id, role, contract_revision, orca_result_ref, accepted_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          cmd.coordinationScopeId,
          cmd.dedupeKey,
          cmd.deliveryId,
          cmd.runId,
          cmd.consumerGeneration,
          cmd.workerTaskId,
          cmd.dispatchId,
          cmd.attemptId,
          cmd.role,
          cmd.contractRevision,
          cmd.orcaResultRef,
          now,
        );
        return ok(null);
      }
      case 'record-delivery-verdict': {
        const holder = executionHolderViolation(cmd.coordinationScopeId, cmd.writer);
        if (!holder.ok) {
          return holder;
        }
        const nextSequenceRow = db
          .prepare(
            `SELECT COALESCE(MAX(verdict_sequence), 0) + 1 AS next_sequence
             FROM delivery_verdicts WHERE coordination_scope_id = ?`,
          )
          .get(cmd.coordinationScopeId) as { readonly next_sequence: number };
        const refs =
          cmd.verdict.kind === 'deliverable' ? cmd.verdict.evidenceRefs : cmd.verdict.blockerRefs;
        db.prepare(
          `INSERT INTO delivery_verdicts (
             coordination_scope_id, verdict_id, verdict_sequence, verdict_kind, verdict_refs,
             finalizer_role, session_binding_ref, recorded_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          cmd.coordinationScopeId,
          cmd.verdictId,
          nextSequenceRow.next_sequence,
          cmd.verdict.kind,
          JSON.stringify(refs),
          cmd.finalizerRole,
          cmd.sessionBindingRef,
          now,
        );
        return ok(null);
      }
      case 'record-recovery': {
        const holder = executionHolderViolation(cmd.coordinationScopeId, cmd.writer);
        if (!holder.ok) {
          return holder;
        }
        // 主键与 source segment 冲突都走通用约束路径：调用方回读既有记录，绝不产生第二行。
        db.prepare(
          `INSERT INTO recoveries (
             coordination_scope_id, recovery_id, role, work_package_id, worker_task_id, business_attempt_id,
             source_segment_id, source_dispatch_id, replacement_dispatch_id, replacement_segment_id,
             replacement_session_binding_id, superseded_segment_id, status, consumed_budget, capsule_ref,
             prewrite_operation_id, terminal_outcome, blocking_reason, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 'pending', 0, NULL, NULL, NULL, NULL, ?, ?)`,
        ).run(
          cmd.coordinationScopeId,
          cmd.recoveryId,
          cmd.role,
          cmd.workPackageId,
          cmd.workerTaskId,
          cmd.businessAttemptId,
          cmd.sourceSegmentId,
          cmd.sourceDispatchId,
          now,
          now,
        );
        return ok(null);
      }
      case 'advance-recovery': {
        const holder = executionHolderViolation(cmd.coordinationScopeId, cmd.writer);
        if (!holder.ok) {
          return holder;
        }
        const row = readRecoveryRow(cmd.coordinationScopeId, cmd.recoveryId);
        if (row === undefined) {
          return fail(`未登记的 RecoveryId ${cmd.recoveryId}`);
        }
        const current = decodeRecoveryRow(row);
        if (!current.ok) {
          return current;
        }
        if (!RECOVERY_TRANSITIONS[current.value.status].includes(cmd.status)) {
          return fail(`不允许从 ${current.value.status} 迁移到 ${cmd.status}`, 'invalid_state');
        }
        // 离开 blocked 表示上一次失败结论已被取代：未显式给出时清空终态结果与阻塞原因，避免
        // 把旧的 failed 挂在一个正在继续的 Recovery 上。
        const leavingBlocked = current.value.status === 'blocked' && cmd.status !== 'blocked';
        const terminalOutcome =
          cmd.terminalOutcome === undefined
            ? leavingBlocked
              ? null
              : current.value.terminalOutcome
            : cmd.terminalOutcome;
        const terminalViolation = recoveryTerminalViolation(cmd.status, terminalOutcome);
        if (terminalViolation !== null) {
          return fail(terminalViolation, 'invalid_state');
        }
        const blockingReason =
          cmd.blockingReason === undefined
            ? leavingBlocked
              ? null
              : current.value.blockingReason
            : cmd.blockingReason;
        // 替代 Session Segment 与预算消耗必须落在同一事务：崩溃不允许留下「Segment 已落盘、
        // consumedBudget 仍为 0」的半记录状态，否则按 Worker Attempt 求和会低估已消耗额度，
        // 从而放行超出 maxRecoveriesPerWorkerAttempt 的又一次替代派发。
        if (cmd.replacementSegment !== undefined) {
          const segment = ensureReplacementSegment(cmd.coordinationScopeId, cmd.replacementSegment, now);
          if (!segment.ok) {
            return segment;
          }
        }
        // 可选字段用 COALESCE 保持原值：省略即不覆盖，给出的值覆盖，绝不把未提供读成清空。
        // `consumed_budget` 例外：它单调不减（MAX(已消耗, 传入值)），重放同值幂等，任何更小的值都
        // 无法把已消耗的 Recovery Budget 调回去——与 consume-budget 的结构单调同向，但不累加，
        // 因此续办同一 Recovery 不会重复消耗额度。
        db.prepare(
          `UPDATE recoveries SET
             status = ?,
             replacement_dispatch_id = COALESCE(?, replacement_dispatch_id),
             replacement_segment_id = COALESCE(?, replacement_segment_id),
             replacement_session_binding_id = COALESCE(?, replacement_session_binding_id),
             superseded_segment_id = COALESCE(?, superseded_segment_id),
             capsule_ref = COALESCE(?, capsule_ref),
             prewrite_operation_id = COALESCE(?, prewrite_operation_id),
             terminal_outcome = ?,
             blocking_reason = ?,
             consumed_budget = MAX(consumed_budget, COALESCE(?, consumed_budget)),
             updated_at = ?
           WHERE coordination_scope_id = ? AND recovery_id = ?`,
        ).run(
          cmd.status,
          cmd.replacementDispatchId ?? null,
          cmd.replacementSegmentId ?? null,
          cmd.replacementSessionBindingId ?? null,
          cmd.supersededSegmentId ?? null,
          cmd.capsuleRef ?? null,
          cmd.prewriteOperationId ?? null,
          terminalOutcome,
          blockingReason,
          cmd.consumedBudget ?? null,
          now,
          cmd.coordinationScopeId,
          cmd.recoveryId,
        );
        return ok(null);
      }
      case 'record-execution-handoff': {
        const holder = executionHolderViolation(cmd.coordinationScopeId, cmd.writer);
        if (!holder.ok) {
          return holder;
        }
        // cutover 必须走 `advance-execution-handoff`：只有那条路径会在同一事务内转移执行责任。
        // 从这里写入 cutover 会得到一个「阶段说已转移、租约还在 Source」的假象。
        if (cmd.phase === 'cutover') {
          return fail('cutover 必须通过 advance-execution-handoff 的单次 CAS 完成', 'invalid_state');
        }
        const existing = readExecutionHandoffRow(cmd.coordinationScopeId, cmd.handoffId);
        if (cmd.expectedHandoffRevision === null) {
          if (existing !== undefined) {
            return fail(`Execution Handoff ${cmd.handoffId} 已存在`, 'constraint');
          }
          if (cmd.phase !== 'prepared') {
            return fail('新 Execution Handoff 必须以 prepared 阶段创建', 'invalid_state');
          }
          if (cmd.blockingReason !== undefined && cmd.blockingReason !== null) {
            return fail('prepared 阶段不得带 blockingReason', 'invalid_state');
          }
          db.prepare(
            `INSERT INTO execution_handoffs (
               coordination_scope_id, handoff_id, source_session_id, target_session_id, graph_generation,
               responsibility_set, phase, expected_revision, coordinator_context_capsule_ref,
               handoff_revision, blocking_reason, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?, ?, 1, NULL, ?, ?)`,
          ).run(
            cmd.coordinationScopeId,
            cmd.handoffId,
            cmd.sourceSessionId,
            cmd.targetSessionId,
            cmd.graphGeneration,
            JSON.stringify(cmd.responsibilitySet),
            // 记录写下之后生效的执行态 revision，用于 cutover 的「review 之后没有其它写入」守卫。
            nextRevision,
            cmd.coordinatorContextCapsuleRef ?? null,
            now,
            now,
          );
          return ok(null);
        }
        if (existing === undefined) {
          return fail(`Execution Handoff ${cmd.handoffId} 不存在`, 'invalid_state');
        }
        const current = decodeExecutionHandoffRow(existing);
        if (!current.ok) {
          return current;
        }
        if (existing.handoff_revision !== cmd.expectedHandoffRevision) {
          return fail(
            `Execution Handoff revision ${cmd.expectedHandoffRevision} 已过期，当前为 ${existing.handoff_revision}`,
            'constraint',
          );
        }
        if (
          cmd.sourceSessionId !== current.value.sourceSessionId ||
          cmd.targetSessionId !== current.value.targetSessionId
        ) {
          return fail('Execution Handoff 的 Source/Target 在创建后不可更改', 'constraint');
        }
        if (cmd.graphGeneration !== current.value.graphGeneration) {
          return fail('Execution Handoff 的 graphGeneration 在创建后不可更改', 'constraint');
        }
        if (!sameResponsibilitySet(cmd.responsibilitySet, current.value.responsibilitySet)) {
          return fail('Execution Handoff 的 responsibilitySet 在创建后不可更改', 'constraint');
        }
        if (!EXECUTION_HANDOFF_TRANSITIONS[current.value.phase].includes(cmd.phase)) {
          return fail(`不允许从 ${current.value.phase} 迁移到 ${cmd.phase}`, 'invalid_state');
        }
        const capsuleRef =
          cmd.coordinatorContextCapsuleRef === undefined
            ? current.value.coordinatorContextCapsuleRef
            : cmd.coordinatorContextCapsuleRef;
        const blockingReason = resolveHandoffBlockingReason(
          cmd.phase,
          cmd.blockingReason,
          current.value.blockingReason,
        );
        if (cmd.phase === 'blocked' && (blockingReason === null || blockingReason.length === 0)) {
          return fail('blocked 阶段必须给出 blockingReason', 'invalid_state');
        }
        db.prepare(
          `UPDATE execution_handoffs SET
             phase = ?, expected_revision = ?, coordinator_context_capsule_ref = ?, blocking_reason = ?,
             handoff_revision = handoff_revision + 1, updated_at = ?
           WHERE coordination_scope_id = ? AND handoff_id = ?`,
        ).run(
          cmd.phase,
          nextRevision,
          capsuleRef,
          blockingReason,
          now,
          cmd.coordinationScopeId,
          cmd.handoffId,
        );
        return ok(null);
      }
      case 'advance-execution-handoff': {
        // holder 校验按**转移前**的状态判定：此刻写入者仍是 Source，也就是当前 Execution
        // Coordination Lease holder。下面的 cutover 转移会把租约从它名下释放，因此这一步必须在
        // 转移之前完成，否则会把正在交接的 Source 误判成非 holder。
        const holder = executionHolderViolation(cmd.coordinationScopeId, cmd.writer);
        if (!holder.ok) {
          return holder;
        }
        const row = readExecutionHandoffRow(cmd.coordinationScopeId, cmd.handoffId);
        if (row === undefined) {
          return fail(`Execution Handoff ${cmd.handoffId} 不存在`, 'invalid_state');
        }
        const current = decodeExecutionHandoffRow(row);
        if (!current.ok) {
          return current;
        }
        if (row.handoff_revision !== cmd.expectedHandoffRevision) {
          return fail(
            `Execution Handoff revision ${cmd.expectedHandoffRevision} 已过期，当前为 ${row.handoff_revision}`,
            'constraint',
          );
        }
        // 只有 reviewed → cutover 是合法迁移（EXECUTION_HANDOFF_TRANSITIONS 已表达这一点）。
        if (!EXECUTION_HANDOFF_TRANSITIONS[current.value.phase].includes(cmd.phase)) {
          return fail(`不允许从 ${current.value.phase} 迁移到 ${cmd.phase}`, 'invalid_state');
        }
        const blockingReason = resolveHandoffBlockingReason(
          cmd.phase,
          cmd.blockingReason,
          current.value.blockingReason,
        );
        if (cmd.phase === 'blocked' && (blockingReason === null || blockingReason.length === 0)) {
          return fail('blocked 阶段必须给出 blockingReason', 'invalid_state');
        }
        if (cmd.phase === 'cutover') {
          // 单次 CAS：守卫是「该记录最后一次写入之后，Scope 没有别的写入」。不变量是
          // `expected_revision` 恒等于写入该记录后生效的 scope.revision（record/advance 两条路径
          // 都同步它），因此这里比较它就等价于比较「最后一次交接写入之后的当前 revision」。
          // 基础 CAS 只保证「调用方读到的 revision 没过期」，这一条才拦住 review 与 cutover 之间的
          // 任何写入。
          if (current.value.expectedRevision !== currentRevision) {
            return fail(
              `Execution Handoff expectedRevision ${current.value.expectedRevision} 与当前 revision ${currentRevision} 不一致`,
              'constraint',
            );
          }
          // 只转移 Source 自己持有的执行责任：写入者与提案 Source 必须一致。
          if (current.value.sourceSessionId !== cmd.writer.coordinatorSessionId) {
            return fail('只有 Execution Handoff 的 Source Session 可以执行 cutover', 'constraint');
          }
          const transferred = transferExecutionResponsibility(
            cmd.coordinationScopeId,
            current.value.sourceSessionId,
            current.value.targetSessionId,
            cmd.writer.runtimeIncarnationId,
            now,
          );
          if (!transferred.ok) {
            return transferred;
          }
        }
        db.prepare(
          `UPDATE execution_handoffs SET phase = ?, expected_revision = ?, blocking_reason = ?,
             handoff_revision = handoff_revision + 1, updated_at = ?
           WHERE coordination_scope_id = ? AND handoff_id = ?`,
        ).run(cmd.phase, nextRevision, blockingReason, now, cmd.coordinationScopeId, cmd.handoffId);
        return ok(null);
      }
      case 'create-scope': {
        db.prepare(
          `INSERT INTO scope (
             coordination_scope_id, full_branch_ref, canonical_worktree_path,
             mode, control_state, planning_cycle_id,
             graph_id, graph_version, authorization_id, authorization_version, revision, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
        ).run(
          cmd.coordinationScopeId,
          cmd.fullBranchRef,
          cmd.canonicalWorktreePath,
          cmd.mode,
          cmd.controlState,
          cmd.planningCycleId,
          nextRevision,
          now,
        );
        return ok(null);
      }
      /**
       * 一次性身份补齐：只在当前绑定为空、且该 Scope 没有任何 Runtime Lease 行时成立。
       *
       * 「没有 lease 行」是硬条件而不是提示：一旦某个 incarnation 曾为该 Scope 取得过租约，它就可能
       * 持有 checkpoint 与未决意图，此时改写身份绑定会把后续恢复接到错误的 Scope 上。
       */
      case 'bind-scope-identity': {
        const existing = readScopeRow(cmd.coordinationScopeId);
        if (existing === undefined) {
          return fail(`Scope ${cmd.coordinationScopeId} 尚未创建`);
        }
        if (existing.full_branch_ref !== null || existing.canonical_worktree_path !== null) {
          return fail('Scope 注册绑定已存在，不可原地改写', 'constraint');
        }
        if (readLeaseRows(cmd.coordinationScopeId).length > 0) {
          return fail('该 Scope 已经使用过 Runtime Lease，不能补齐身份绑定', 'constraint');
        }
        db.prepare(
          `UPDATE scope SET full_branch_ref = ?, canonical_worktree_path = ?, updated_at = ?
           WHERE coordination_scope_id = ?`,
        ).run(cmd.fullBranchRef, cmd.canonicalWorktreePath, now, cmd.coordinationScopeId);
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
      case 'update-session-model-configuration': {
        const info = db
          .prepare(
            `UPDATE session_registry SET coordinator_model_configuration_ref = ?
             WHERE coordination_scope_id = ? AND coordinator_session_id = ?`,
          )
          .run(cmd.coordinatorModelConfigurationRef, cmd.coordinationScopeId, cmd.coordinatorSessionId);
        if (Number(info.changes) === 0) {
          return fail(`Session ${cmd.coordinatorSessionId} 未注册到本 Scope`);
        }
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
            `UPDATE pending_interactions SET state = ?, answer_kind = ?, answer_id = ?, answer_text = ?, resolved_at = ?
             WHERE coordination_scope_id = ? AND interaction_id = ? AND state = 'open'`,
          )
          .run(
            cmd.state,
            cmd.answerRef === null ? null : cmd.answerRef.kind,
            cmd.answerRef === null ? null : cmd.answerRef.id,
            cmd.answerText,
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
             initiated_by_session_id, initiated_by_incarnation_id, expected_revision, expected_head, state,
             outcome_class, backend_request_id, blocking_reason, created_at, settled_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, NULL)`,
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
          cmd.expectedHead ?? null,
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
      case 'record-graph-generation': {
        const existing = readGraphGenerationRow(cmd.coordinationScopeId, cmd.graphId);
        if (existing !== undefined) {
          return fail(`Graph ${cmd.graphId} 的世代记录已存在`, 'constraint');
        }
        db.prepare(
          `INSERT INTO graph_generations (
             coordination_scope_id, graph_id, graph_generation, planning_cycle_id, orca_run_id,
             predecessor_graph_id, baseline_head, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?)`,
        ).run(
          cmd.coordinationScopeId,
          cmd.graphId,
          cmd.generation,
          cmd.planningCycleId,
          cmd.orcaRunId,
          cmd.predecessorGraphId,
          cmd.baselineHead,
          now,
          now,
        );
        return ok(null);
      }
      case 'advance-graph-generation': {
        const row = readGraphGenerationRow(cmd.coordinationScopeId, cmd.graphId);
        if (row === undefined) {
          return fail(`Graph ${cmd.graphId} 还没有世代记录`);
        }
        if (row.status === cmd.status) {
          return ok(null);
        }
        const current = requireEnum(row.status, GRAPH_GENERATION_STATUSES, 'graph_generations.status');
        if (!current.ok) {
          return current;
        }
        if (!GRAPH_GENERATION_TRANSITIONS[current.value].includes(cmd.status)) {
          return fail(`不允许把代际从 ${current.value} 迁移到 ${cmd.status}`);
        }
        db.prepare(
          'UPDATE graph_generations SET status = ?, updated_at = ? WHERE coordination_scope_id = ? AND graph_id = ?',
        ).run(cmd.status, now, cmd.coordinationScopeId, cmd.graphId);
        return ok(null);
      }
      case 'record-revision-hold': {
        db.prepare(
          `INSERT INTO revision_holds (
             coordination_scope_id, work_package_id, source, source_ref, state,
             created_at, released_at, release_reason
           ) VALUES (?, ?, ?, ?, 'pending', ?, NULL, NULL)
           ON CONFLICT (coordination_scope_id, work_package_id) DO UPDATE SET
             source = excluded.source,
             source_ref = excluded.source_ref,
             state = 'pending',
             released_at = NULL,
             release_reason = NULL`,
        ).run(cmd.coordinationScopeId, cmd.workPackageId, cmd.source, cmd.sourceRef, now);
        return ok(null);
      }
      case 'release-revision-hold': {
        const existing = one<RevisionHoldRow>(
          db.prepare('SELECT * FROM revision_holds WHERE coordination_scope_id = ? AND work_package_id = ?'),
          cmd.coordinationScopeId,
          cmd.workPackageId,
        );
        if (existing === undefined) {
          return fail(`Work Package ${cmd.workPackageId} 没有 revision pending 持有`, 'constraint');
        }
        if (existing.state === 'released') {
          return ok(null);
        }
        if (cmd.expectedSourceRef !== undefined && existing.source_ref !== cmd.expectedSourceRef) {
          return fail(
            `Work Package ${cmd.workPackageId} 的持有来自 ${existing.source_ref}，与本次收尾的 ${cmd.expectedSourceRef} 不一致`,
            'constraint',
          );
        }
        db.prepare(
          `UPDATE revision_holds SET state = 'released', released_at = ?, release_reason = ?
           WHERE coordination_scope_id = ? AND work_package_id = ?`,
        ).run(now, cmd.reason, cmd.coordinationScopeId, cmd.workPackageId);
        // 修订额度与解除持有同事务：重放已释放的持有在上面直接返回，因此不会重复扣减。
        for (const consumption of cmd.budgetConsumption ?? []) {
          const counter = db
            .prepare('SELECT * FROM budget_counters WHERE coordination_scope_id = ? AND budget_key = ?')
            .get(cmd.coordinationScopeId, consumption.budgetKey) as BudgetRow | undefined;
          if (counter !== undefined && counter.approved_limit_ref !== consumption.approvedLimitRef) {
            return fail('已登记的预算授权上限引用与本次不一致，拒绝在同一计数上叠加', 'constraint');
          }
          db.prepare(
            `INSERT INTO budget_counters (coordination_scope_id, budget_key, approved_limit_ref, consumed)
             VALUES (?, ?, ?, ?)
             ON CONFLICT (coordination_scope_id, budget_key) DO UPDATE SET consumed = consumed + excluded.consumed`,
          ).run(
            cmd.coordinationScopeId,
            consumption.budgetKey,
            consumption.approvedLimitRef,
            consumption.amount,
          );
        }
        return ok(null);
      }
      case 'record-baseline-reconciliation': {
        const existing = one<BaselineReconciliationRow>(
          db.prepare(
            'SELECT * FROM baseline_reconciliations WHERE coordination_scope_id = ? AND reconciliation_id = ?',
          ),
          cmd.coordinationScopeId,
          cmd.reconciliationId,
        );
        if (existing !== undefined) {
          return fail(`Baseline Reconciliation ${cmd.reconciliationId} 已存在`, 'constraint');
        }
        db.prepare(
          `INSERT INTO baseline_reconciliations (
             coordination_scope_id, reconciliation_id, work_package_id, role, required_baseline_head,
             observed_head, ancestry_verified, target_head_verified, dirty_paths_reconciled,
             scope_reconciled, state, blocker_ref, created_at, updated_at
           ) VALUES (?, ?, ?, 'planner', ?, NULL, 0, 0, 0, 0, 'required', NULL, ?, ?)`,
        ).run(cmd.coordinationScopeId, cmd.reconciliationId, cmd.workPackageId, cmd.requiredBaselineHead, now, now);
        return ok(null);
      }
      case 'bind-baseline-reconciliation-task': {
        const existing = one<BaselineReconciliationRow>(
          db.prepare('SELECT * FROM baseline_reconciliations WHERE coordination_scope_id = ? AND reconciliation_id = ?'),
          cmd.coordinationScopeId,
          cmd.reconciliationId,
        );
        if (existing === undefined || existing.state !== 'required') {
          return fail('Baseline Reconciliation 不存在或已收尾');
        }
        if (existing.orca_task_id !== null && existing.orca_task_id !== cmd.orcaTaskId) {
          return fail('Baseline Reconciliation 已绑定另一 Orca Task');
        }
        if (cmd.dispatchId !== undefined && existing.dispatch_id !== null && existing.dispatch_id !== cmd.dispatchId) {
          return fail('Baseline Reconciliation 已绑定另一 Dispatch');
        }
        db.prepare(
          `UPDATE baseline_reconciliations SET orca_task_id = ?, dispatch_id = COALESCE(?, dispatch_id), updated_at = ?
           WHERE coordination_scope_id = ? AND reconciliation_id = ?`,
        ).run(cmd.orcaTaskId, cmd.dispatchId ?? null, now, cmd.coordinationScopeId, cmd.reconciliationId);
        return ok(null);
      }
      case 'advance-baseline-reconciliation': {
        const existing = one<BaselineReconciliationRow>(
          db.prepare(
            'SELECT * FROM baseline_reconciliations WHERE coordination_scope_id = ? AND reconciliation_id = ?',
          ),
          cmd.coordinationScopeId,
          cmd.reconciliationId,
        );
        if (existing === undefined) {
          return fail(`Baseline Reconciliation ${cmd.reconciliationId} 不存在`);
        }
        if (existing.state !== 'required') {
          return fail(`Baseline Reconciliation ${cmd.reconciliationId} 已处于 ${existing.state}`);
        }
        const observedHead = cmd.observedHead ?? null;
        if (cmd.state === 'verified') {
          const flags = {
            ancestryVerified: cmd.ancestryVerified === true,
            targetHeadVerified: cmd.targetHeadVerified === true,
            dirtyPathsReconciled: cmd.dirtyPathsReconciled === true,
            scopeReconciled: cmd.scopeReconciled === true,
          };
          if (observedHead === null || observedHead.length === 0) {
            return fail('verified 必须给出实际观察到的 HEAD');
          }
          if (observedHead !== existing.required_baseline_head) {
            return fail('verified 的 HEAD 与目标基线不一致');
          }
          if (!Object.values(flags).every((flag) => flag)) {
            return fail('verified 要求祖先关系、目标 HEAD、dirty paths 与 scope 全部核验通过');
          }
          if (existing.orca_task_id === null || existing.dispatch_id === null) {
            return fail('verified 必须绑定独立 Planner Task 与 Dispatch');
          }
          const plannerResult = one<DeliverySettlementRow>(
            db.prepare(
              `SELECT * FROM delivery_settlements
               WHERE coordination_scope_id = ? AND worker_task_id = ? AND dispatch_id = ?
                 AND role = 'planner'
               ORDER BY accepted_at DESC LIMIT 1`,
            ),
            cmd.coordinationScopeId,
            cmd.reconciliationId,
            existing.dispatch_id,
          );
          if (plannerResult === undefined || !plannerResult.orca_result_ref.startsWith(`${existing.orca_task_id}#`)) {
            return fail('verified 必须关联独立 Planner Task 的 Accepted Worker Result');
          }
          db.prepare(
            `UPDATE baseline_reconciliations SET
               observed_head = ?, ancestry_verified = 1, target_head_verified = 1,
               dirty_paths_reconciled = 1, scope_reconciled = 1, state = 'verified', blocker_ref = NULL,
               updated_at = ?
             WHERE coordination_scope_id = ? AND reconciliation_id = ?`,
          ).run(observedHead, now, cmd.coordinationScopeId, cmd.reconciliationId);
          return ok(null);
        }
        const blockerRef = cmd.blockerRef ?? null;
        if (blockerRef === null || blockerRef.length === 0) {
          return fail('blocked 必须给出阻塞引用');
        }
        db.prepare(
          `UPDATE baseline_reconciliations SET
             observed_head = ?, state = 'blocked', blocker_ref = ?, updated_at = ?
           WHERE coordination_scope_id = ? AND reconciliation_id = ?`,
        ).run(observedHead, blockerRef, now, cmd.coordinationScopeId, cmd.reconciliationId);
        return ok(null);
      }
      case 'record-work-package-lineage': {
        const existing = one<WorkPackageLineageRow>(
          db.prepare('SELECT * FROM work_package_lineages WHERE coordination_scope_id = ? AND work_package_id = ?'),
          cmd.coordinationScopeId,
          cmd.workPackageId,
        );
        if (existing !== undefined) {
          return fail(`Work Package ${cmd.workPackageId} 已记录 lineage`, 'constraint');
        }
        db.prepare(
          `INSERT INTO work_package_lineages (
             coordination_scope_id, work_package_id, prior_work_package_id, prior_graph_id,
             inherited_json, recorded_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          cmd.coordinationScopeId,
          cmd.workPackageId,
          cmd.priorWorkPackageId,
          cmd.priorGraphId,
          JSON.stringify(cmd.inherited),
          now,
        );
        return ok(null);
      }
      case 'record-baseline-adoption': {
        const existing = one<BaselineAdoptionRow>(
          db.prepare('SELECT * FROM baseline_adoptions WHERE coordination_scope_id = ? AND adoption_id = ?'),
          cmd.coordinationScopeId,
          cmd.adoptionId,
        );
        if (existing !== undefined) {
          return fail(`Baseline Adoption ${cmd.adoptionId} 已存在`, 'constraint');
        }
        if (cmd.state === 'recorded' && cmd.evidenceRefs.length === 0) {
          return fail('recorded 采用必须给出仍然适用的证据引用', 'constraint');
        }
        if (cmd.state === 'recorded' && cmd.blockingReason !== null) {
          return fail('recorded 采用不得携带阻塞原因', 'constraint');
        }
        if (cmd.state === 'blocked' && (cmd.blockingReason === null || cmd.blockingReason.length === 0)) {
          return fail('blocked 采用必须给出矛盾事实', 'constraint');
        }
        db.prepare(
          `INSERT INTO baseline_adoptions (
             coordination_scope_id, adoption_id, work_package_id, adoption_kind, adopted_result_ref,
             baseline_head, integration_ref, evidence_refs, state, blocking_reason, recorded_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          cmd.coordinationScopeId,
          cmd.adoptionId,
          cmd.workPackageId,
          cmd.adoptionKind,
          cmd.adoptedResultRef,
          cmd.baselineHead,
          cmd.integrationRef,
          JSON.stringify(cmd.evidenceRefs),
          cmd.state,
          cmd.blockingReason,
          now,
        );
        return ok(null);
      }
      case 'commit-generation-cutover': {
        const scopeRow = readScopeRow(cmd.coordinationScopeId);
        if (scopeRow === undefined) {
          return fail(`Scope ${cmd.coordinationScopeId} 尚未创建`);
        }
        const candidate = readGraphGenerationRow(cmd.coordinationScopeId, cmd.candidateGraphId);
        if (candidate === undefined) {
          return fail(`候选代际 ${cmd.candidateGraphId} 未登记`);
        }
        // 幂等：候选代际已经是 active 时重复提交是成功空操作，不产生第二份代际事实。
        // 不能用 Scope 的 graph 指针判定：候选图在规划期内就会被记录，而那时它还不是活动代际。
        if (candidate.status === 'active') {
          return scopeRow.graph_id === cmd.candidateGraphId &&
            scopeRow.authorization_id === cmd.authorizationId &&
            scopeRow.planning_cycle_id === cmd.planningCycleId
            ? ok(null)
            : fail('候选代际标记为 active，但 Scope 引用不一致', 'constraint');
        }
        if (candidate.status !== 'candidate') {
          return fail(`候选代际 ${cmd.candidateGraphId} 的状态为 ${candidate.status}，只有 candidate 可以 cutover`);
        }
        if (scopeRow.mode !== 'route_planning' || scopeRow.control_state !== 'active') {
          return fail('只有结清后的 Route Planning Scope 可以 cutover', 'invalid_state');
        }
        if (scopeRow.graph_id !== cmd.predecessorGraphId || candidate.predecessor_graph_id !== cmd.predecessorGraphId) {
          return fail('候选代际的前代与当前 Scope 不一致', 'constraint');
        }
        if (candidate.planning_cycle_id !== cmd.planningCycleId) {
          return fail('候选代际绑定的 Planning Cycle 与命令不一致', 'constraint');
        }
        // Run 与基线属于被整体切换的引用集合：它们必须与候选代际记录逐字相符，而不是另行生效。
        if (candidate.orca_run_id !== cmd.candidateRunId) {
          return fail(
            `候选代际绑定的 Run 是 ${candidate.orca_run_id}，与命令声明的 ${cmd.candidateRunId} 不一致`,
            'constraint',
          );
        }
        if (candidate.baseline_head !== cmd.baselineHead) {
          return fail(
            `候选代际绑定的基线是 ${candidate.baseline_head}，与命令声明的 ${cmd.baselineHead} 不一致`,
            'constraint',
          );
        }
        const head = db
          .prepare(
            `SELECT MAX(graph_version) AS head FROM graph_versions
             WHERE coordination_scope_id = ? AND graph_id = ?`,
          )
          .get(cmd.coordinationScopeId, cmd.candidateGraphId) as { readonly head: number | null } | undefined;
        if ((head?.head ?? null) !== cmd.candidateGraphVersion) {
          return fail(
            `候选图 head 为 ${String(head?.head ?? null)}，与命令声明的 ${cmd.candidateGraphVersion} 不一致`,
            'constraint',
          );
        }
        const candidateVersionRow = readGraphVersionRow(cmd.coordinationScopeId, cmd.candidateGraphId, cmd.candidateGraphVersion);
        if (candidateVersionRow === undefined) {
          return fail('候选图版本不存在', 'constraint');
        }
        const candidateVersion = decodeGraphVersionRow(candidateVersionRow);
        if (!candidateVersion.ok) {
          return candidateVersion;
        }
        if (candidateVersion.value.generation !== candidate.graph_generation || candidateVersion.value.orcaRunId !== candidate.orca_run_id) {
          return fail('候选图版本与代际身份不一致', 'constraint');
        }
        const priorGenerations = readGraphGenerationRows(cmd.coordinationScopeId)
          .filter((generation) => generation.graph_id !== candidate.graph_id);
        if (priorGenerations.some((generation) =>
          generation.graph_generation >= candidate.graph_generation || generation.orca_run_id === candidate.orca_run_id
        )) {
          return fail('新代际必须使用更高世代与全新 Run', 'constraint');
        }
        const priorWorkPackageIds = new Set<string>();
        for (const generation of priorGenerations) {
          for (const versionRow of readGraphVersionRows(cmd.coordinationScopeId, generation.graph_id)) {
            const version = decodeGraphVersionRow(versionRow);
            if (!version.ok) return version;
            for (const workPackage of version.value.graph.workPackages) {
              priorWorkPackageIds.add(workPackage.workPackageId);
            }
          }
        }
        if (candidateVersion.value.graph.workPackages.some((workPackage) => priorWorkPackageIds.has(workPackage.workPackageId))) {
          return fail('新代际不得复用前代 WorkPackageId', 'constraint');
        }
        const authorizationRow = readAuthorizationRow(cmd.coordinationScopeId, cmd.authorizationId);
        if (authorizationRow === undefined) {
          return fail(`Execution Authorization ${cmd.authorizationId} 不存在`);
        }
        if (authorizationRow.authorization_version !== cmd.authorizationVersion) {
          return fail(
            `授权版本 ${cmd.authorizationVersion} 已过期，当前为 ${authorizationRow.authorization_version}`,
            'constraint',
          );
        }
        const authorization = decodeAuthorizationRow(authorizationRow);
        if (!authorization.ok) {
          return authorization;
        }
        if (
          authorization.value.manifest.graph.graphId !== cmd.candidateGraphId ||
          authorization.value.manifest.graph.generation !== candidate.graph_generation ||
          authorization.value.manifest.graph.version !== cmd.candidateGraphVersion ||
          authorization.value.manifest.orcaRunId !== cmd.candidateRunId ||
          authorization.value.manifest.baselineHead !== cmd.baselineHead ||
          authorization.value.manifest.planningCycleId !== cmd.planningCycleId
        ) {
          return fail('Execution Authorization 绑定的不是候选代际', 'constraint');
        }
        const predecessorGraphId = cmd.predecessorGraphId ?? scopeRow.graph_id;
        if (predecessorGraphId !== null && predecessorGraphId !== cmd.candidateGraphId) {
          const predecessor = readGraphGenerationRow(cmd.coordinationScopeId, predecessorGraphId);
          if (predecessor === undefined) {
            return fail(`前代代际 ${predecessorGraphId} 未登记`);
          }
          // Cutover 替换的是**被挂起的**代际：前代仍处于 active 说明 Replanning Transition 尚未结清，
          // 直接冻结会绕过结清与 Lease 释放。
          if (predecessor.status !== 'frozen' && predecessor.status !== 'suspended') {
            return fail(
              `前代代际 ${predecessorGraphId} 的状态为 ${predecessor.status}，只有 suspended 的前代可以 cutover`,
            );
          }
          if (predecessor.status === 'suspended') {
            db.prepare(
              `UPDATE graph_generations SET status = 'frozen', updated_at = ?
               WHERE coordination_scope_id = ? AND graph_id = ?`,
            ).run(now, cmd.coordinationScopeId, predecessorGraphId);
          }
        }
        const activeLease = db
          .prepare(
            `SELECT * FROM leases
             WHERE coordination_scope_id = ? AND lease_kind = 'execution_coordination' AND released_at IS NULL`,
          )
          .get(cmd.coordinationScopeId) as LeaseRow | undefined;
        if (activeLease !== undefined && activeLease.coordinator_session_id !== cmd.writer.coordinatorSessionId) {
          return fail('Execution Coordination Lease 已由其它 Coordinator Session 持有', 'constraint');
        }
        db.prepare(
          `UPDATE graph_generations SET status = 'active', updated_at = ?
           WHERE coordination_scope_id = ? AND graph_id = ?`,
        ).run(now, cmd.coordinationScopeId, cmd.candidateGraphId);
        handExecutionLease(cmd.coordinationScopeId, cmd.writer, now);
        // 引用集合整体切换：不存在「新图配旧 Run」或「新 Run 配旧图」的中间态。
        db.prepare(
          `UPDATE scope SET
             mode = 'execution_coordination', planning_cycle_id = ?, graph_id = ?, graph_version = ?,
             authorization_id = ?, authorization_version = ?, updated_at = ?
           WHERE coordination_scope_id = ?`,
        ).run(
          cmd.planningCycleId,
          cmd.candidateGraphId,
          cmd.candidateGraphVersion,
          cmd.authorizationId,
          cmd.authorizationVersion,
          now,
          cmd.coordinationScopeId,
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

      if (cmd.kind === 'create-scope' || cmd.kind === 'initialize-scope') {
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
          // 一次性身份补齐同样只能在「该 Scope 从未使用过 Runtime Lease」时发生；那时不存在任何
          // 活跃 incarnation 可以派发这个写入，因此它和初始化一样由 bootstrap 写入者执行。
          const bootstrapScopeBinding = cmd.kind === 'bind-scope-identity';
          if (runtimeLeaseRow === undefined && !bootstrapRegistration && !bootstrapScopeBinding) {
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
      const applied = applyCommand(cmd, now, currentRevision, nextRevision);
      if (!applied.ok) {
        rollback();
        return rejected(applied.code, applied.message);
      }
      if (advancesRevision && cmd.kind !== 'create-scope' && cmd.kind !== 'initialize-scope') {
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
