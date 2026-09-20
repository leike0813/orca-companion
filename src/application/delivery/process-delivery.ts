/**
 * IC-08 / IP-B2：正常 Delivery 结算流水线（Owner: `m1-execute-and-validate-work-packages`）。
 *
 * 这是正常 Delivery 顺序的唯一实现（FLOW-03），顺序固定且不可重排：
 *
 * 1. 读取 Delivery，**不**确认；
 * 2. 核验身份与当前代际（`verifyWorkerResult`）；
 * 3. 查稳定去重键；
 * 4. 通过 `ExecutionBackend` 的 `task-update` 在 Orca 记录 Accepted Worker Result 并回读；
 * 5. 在 Branch Coordination Store 持久化去重键与 `AcceptedWorkerResultRef` 并回读；
 * 6. 最后才确认 Delivery。
 *
 * Accepted Worker Result 正文只归 Orca：本库只保存去重键、结果引用、角色与契约 revision。任一步
 * 失败或结果仍为 `unknown` 时都不确认，并以原 OperationId 对账（`unknown` 绝不换 ID 重试）。
 * 后继 Recovery 只补启动重放与 unknown 对账，不重新实现这个顺序。
 */

import { createHash } from 'node:crypto';

import type {
  CoordinationScopeId,
  DispatchId,
  OperationId,
  WorkerTaskId,
} from '../dto/identity.js';
import type { DeliveryBatch } from '../dto/operation-outcome.js';
import type {
  BranchCoordinationStore,
  CoordinationWriter,
  DeliverySettlementRecord,
} from '../ports/branch-coordination-store.js';
import type { ExecutionBackend, ExecutionAuthority, ExecutionMutation } from '../ports/execution-backend.js';
import { buildExecutionScope, reconcileOperation } from '../ports/execution-backend.js';
import { beginIntent, blockLane, settleIntent } from '../coordination/intent-service.js';
import { readScope } from '../planning/scope-read.js';
import {
  verifyWorkerResult,
  type ClaimedResultAttribution,
  type TrustedExecutionFacts,
  type WorkerResultVerification,
} from '../../domain/worker-result-verification.js';

/**
 * 稳定去重键。
 *
 * 由 Delivery 身份与归属共同确定：同一个 Delivery 无论被重放多少次都必须算出同一个键。用 JSON 数组
 * 拼接而不是分隔符拼接，避免任何值里出现与分隔符同形的字符（也避免 NUL 进入 SQLite 文本）。
 */
export function deliveryDedupeKey(identity: {
  readonly deliveryId: string;
  readonly runId: string;
  readonly consumerGeneration: number;
  readonly workerTaskId: WorkerTaskId;
  readonly dispatchId: DispatchId;
  readonly attemptId: string;
}): string {
  return JSON.stringify([
    identity.deliveryId,
    identity.runId,
    identity.consumerGeneration,
    identity.workerTaskId,
    identity.dispatchId,
    identity.attemptId,
  ]);
}

/** 归一化结果的内容摘要：Orca 侧结果引用的可核验部分。 */
export function resultDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

/** Orca 可能把 `--result` 存成对象或 JSON 文本；两种形态都归一成同一个值再比较。 */
function normalizeResultValue(raw: unknown): unknown {
  if (typeof raw !== 'string') {
    return raw;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * `delivery-read` 返回值的窄结构确认。
 *
 * 只确认本流水线要用的字段（稳定 delivery identity 与消息数组）：原始载荷解析属于 adapter 的登记
 * parser，这里不重复解析，也不把无 identity 的批次拿来确认。
 */
export function isDeliveryBatchValue(value: unknown): value is DeliveryBatch {
  if (!isRecord(value)) {
    return false;
  }
  const delivery = value['delivery'];
  if (delivery !== null && delivery !== undefined) {
    if (!isRecord(delivery) || typeof delivery['deliveryId'] !== 'string') {
      return false;
    }
  }
  return Array.isArray(value['messages']);
}

/** 回读 Task 记录时只读这三个字段；形状不合法即 fail closed。 */
type OrcaTaskRecord = {
  readonly status: string | null;
  readonly result: unknown;
};

function readTaskRecord(value: unknown, taskId: string): OrcaTaskRecord | null {
  const rows = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value['tasks'])
      ? (value['tasks'] as readonly unknown[])
      : null;
  if (rows === null) {
    return null;
  }
  for (const row of rows) {
    if (!isRecord(row)) {
      continue;
    }
    const id = row['id'] ?? row['taskId'] ?? row['task_id'];
    if (id !== taskId) {
      continue;
    }
    const status = row['status'];
    return {
      status: typeof status === 'string' ? status : null,
      result: row['result'],
    };
  }
  return null;
}

export type SettlementOperationIds = {
  /** 在 Orca 记录 Accepted Worker Result。 */
  readonly acceptResult: OperationId;
  /** 确认 Delivery。 */
  readonly ack: OperationId;
};

export type SettleDeliveryInput = {
  readonly store: BranchCoordinationStore;
  readonly backend: ExecutionBackend;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly writer: CoordinationWriter;
  readonly expectedRevision: number;
  readonly backendIdentityRef: string;
  readonly graphGeneration: number;
  readonly authorizationId: string;
  readonly runId: string;
  readonly consumerGeneration: number;
  readonly timeoutMs: number;
  /** 当前角色级 Orca Task；Accepted Worker Result 记录在它上面。 */
  readonly orcaTaskId: string;
  readonly delivery: {
    readonly deliveryId: string;
    readonly claimed: ClaimedResultAttribution;
    /** 归一化后的 Accepted Worker Result 载荷；正文只写入 Orca。 */
    readonly acceptedResult: unknown;
  };
  readonly trusted: TrustedExecutionFacts;
  readonly operationIds: SettlementOperationIds;
};

export type SettleDeliveryFailure = {
  readonly code: string;
  readonly message: string;
};

export type SettleDeliveryResult =
  | {
      readonly kind: 'settled';
      readonly dedupeKey: string;
      readonly orcaResultRef: string;
      readonly verification: WorkerResultVerification;
    }
  /** 重放已结算的 Delivery：回读既有 Orca 结果后确认，不产生第二份正文或第二行记录。 */
  | { readonly kind: 'replayed'; readonly settlement: DeliverySettlementRecord }
  /** 旧代际或旧尝试：确认该 Delivery，但只作历史，不推进生命周期。 */
  | { readonly kind: 'history_only'; readonly verification: WorkerResultVerification }
  | { readonly kind: 'rejected'; readonly failure: SettleDeliveryFailure; readonly verification?: WorkerResultVerification }
  | { readonly kind: 'unknown'; readonly operationId: OperationId; readonly reason: string }
  | { readonly kind: 'blocked'; readonly laneKey: string; readonly reason: string };

function freshRevision(
  input: SettleDeliveryInput,
): number | SettleDeliveryFailure {
  const read = readScope(input.store, input.coordinationScopeId);
  return read.kind === 'rejected' ? { code: read.code, message: read.message } : read.scope.revision;
}

function executionScope(
  input: SettleDeliveryInput,
  operationId: OperationId,
  target: { readonly kind: string; readonly id: string },
  expectedRevision: number,
): ReturnType<typeof buildExecutionScope> {
  const authority: ExecutionAuthority = {
    kind: 'execution_coordination',
    graphGeneration: input.graphGeneration,
    authorizationId: input.authorizationId,
    runId: input.runId,
    consumerGeneration: input.consumerGeneration,
  };
  return buildExecutionScope({
    coordinationScopeId: input.coordinationScopeId,
    coordinatorSessionId: input.writer.coordinatorSessionId,
    runtimeIncarnationId: input.writer.runtimeIncarnationId,
    fencingGeneration: input.writer.fencingGeneration,
    backendIdentityRef: input.backendIdentityRef,
    operationId,
    target,
    expectedRevision,
    timeoutMs: input.timeoutMs,
    authority,
  });
}

/** 回读核验：Orca 必须能证明它记录了这份结果，否则不确认 Delivery。 */
async function verifyResultReadback(
  input: SettleDeliveryInput,
): Promise<{ readonly kind: 'verified'; readonly orcaResultRef: string } | SettleDeliveryFailure> {
  const listed = await input.backend.query({
    operation: 'task-list',
    backendIdentityRef: input.backendIdentityRef,
    runId: input.runId,
  });
  if (listed.kind !== 'accepted') {
    return { code: listed.code, message: `回读 Orca Task 失败：${listed.message}` };
  }
  const record = readTaskRecord(listed.value, input.orcaTaskId);
  if (record === null) {
    return { code: 'readback_missing', message: 'Orca 回读中找不到该 Task 记录' };
  }
  if (record.status !== 'completed') {
    return { code: 'readback_status', message: `Orca Task 回读状态为 ${String(record.status)}，不是 completed` };
  }
  if (record.result === null || record.result === undefined) {
    return { code: 'readback_missing_result', message: 'Orca Task 回读记录中没有结果' };
  }
  const expected = resultDigest(input.delivery.acceptedResult);
  const observed = resultDigest(normalizeResultValue(record.result));
  if (expected !== observed) {
    return { code: 'readback_mismatch', message: 'Orca 回读结果与本次归一化结果不一致' };
  }
  return { kind: 'verified', orcaResultRef: `${input.orcaTaskId}#${expected.slice(0, 13)}` };
}

/**
 * 一次受 Intent 保护的 mutation：begin → 调用 backend → settle/block。
 *
 * `unknown` 只做一次原 OperationId 对账，仍不确定就把该 lane 留在阻塞位置，绝不换 ID 重试。
 */
type MutationAttempt =
  | { readonly kind: 'accepted' }
  /**
   * 同一 OperationId 的意图已经存在且已收尾：这是恢复重放，副作用已经确定发生过，因此不再发起
   * 第二次 mutation；调用方按后续回读核验结果，而不是重新执行。
   */
  | { readonly kind: 'already_settled' }
  | { readonly kind: 'failed'; readonly result: SettleDeliveryResult };

async function runSettlementMutation(
  input: SettleDeliveryInput,
  operationId: OperationId,
  target: { readonly kind: string; readonly id: string },
  mutation: ExecutionMutation,
): Promise<MutationAttempt> {
  const revision = freshRevision(input);
  if (typeof revision !== 'number') {
    return { kind: 'failed', result: { kind: 'blocked', laneKey: target.id, reason: revision.message } };
  }
  const begun = beginIntent(input.store, {
    coordinationScopeId: input.coordinationScopeId,
    operationId,
    target,
    operationCategory: target.kind,
    writer: input.writer,
    expectedRevision: revision,
  });
  if (begun.kind === 'lane_blocked') {
    return {
      kind: 'failed',
      result: { kind: 'blocked', laneKey: begun.laneKey, reason: `lane 已被未决意图 ${begun.blockingIntent.operationId} 阻塞` },
    };
  }
  if (begun.kind === 'lane_busy') {
    return {
      kind: 'failed',
      result: { kind: 'blocked', laneKey: begun.laneKey, reason: `lane 上已有未决意图 ${begun.activeIntent.operationId}` },
    };
  }
  if (begun.kind === 'rejected') {
    return { kind: 'failed', result: { kind: 'blocked', laneKey: target.id, reason: begun.rejection.message } };
  }
  if (begun.kind === 'existing') {
    if (begun.intent.state !== 'settled' || begun.intent.outcomeClass !== 'accepted') {
      return {
        kind: 'failed',
        result: {
          kind: 'blocked',
          laneKey: begun.intent.laneKey,
          reason: `意图 ${operationId} 尚无已接受的确定结果（${begun.intent.state}）`,
        },
      };
    }
    return { kind: 'already_settled' };
  }

  const outcome = await input.backend.mutate(mutation, executionScope(input, operationId, target, revision));
  if (outcome.kind === 'unknown') {
    const reconciled = await reconcileOperation(input.backend, outcome.operation);
    const reconcileRevision = freshRevision(input);
    const reason =
      reconciled.kind === 'settled'
        ? `${reconciled.statement}；缺少可恢复的资源结果`
        : `对账结果 ${reconciled.reason} 不构成副作用是否发生的证明`;
    if (typeof reconcileRevision === 'number') {
      blockLane(input.store, {
        coordinationScopeId: input.coordinationScopeId,
        operationId,
        writer: input.writer,
        expectedRevision: reconcileRevision,
        reason,
      });
    }
    return {
      kind: 'failed',
      result: { kind: 'unknown', operationId, reason: `${reason}，lane 保持阻塞` },
    };
  }

  const settleRevision = freshRevision(input);
  if (typeof settleRevision !== 'number') {
    return { kind: 'failed', result: { kind: 'blocked', laneKey: target.id, reason: settleRevision.message } };
  }
  const settled = settleIntent(input.store, {
    coordinationScopeId: input.coordinationScopeId,
    operationId,
    writer: input.writer,
    expectedRevision: settleRevision,
    outcome,
  });
  if (settled.kind === 'rejected') {
    return { kind: 'failed', result: { kind: 'blocked', laneKey: target.id, reason: settled.rejection.message } };
  }
  if (outcome.kind === 'rejected') {
    return { kind: 'failed', result: { kind: 'rejected', failure: { code: outcome.code, message: outcome.message } } };
  }
  const value = outcome.value as { readonly ok?: unknown; readonly code?: unknown } | null;
  if (value?.ok === false) {
    const rawCode = value.code;
    const code = typeof rawCode === 'string' && rawCode.length > 0 ? rawCode : 'definite_failure';
    return {
      kind: 'failed',
      result: { kind: 'rejected', failure: { code, message: `Orca 记录了确定失败: ${code}` } },
    };
  }
  return { kind: 'accepted' };
}

/** 确认 Delivery；未确认是默认行为，只有这里能推进它。 */
async function confirmDelivery(
  input: SettleDeliveryInput,
  deliveryId: string,
  deliveryRunId: string | null,
): Promise<SettleDeliveryResult | null> {
  const ack = await runSettlementMutation(input, input.operationIds.ack, { kind: 'delivery', id: deliveryId }, {
    operation: 'delivery-ack',
    deliveryId,
    ...(deliveryRunId === null ? {} : { runId: deliveryRunId }),
  });
  return ack.kind === 'failed' ? ack.result : null;
}

function readSettlement(
  input: SettleDeliveryInput,
  dedupeKey: string,
): { readonly kind: 'read'; readonly settlement: DeliverySettlementRecord | null } | SettleDeliveryResult {
  const result = input.store.query({
    kind: 'delivery-settlements',
    coordinationScopeId: input.coordinationScopeId,
    dedupeKey,
  });
  if (result.kind === 'rejected') {
    return { kind: 'blocked', laneKey: input.orcaTaskId, reason: result.message };
  }
  if (result.kind !== 'delivery-settlements') {
    return { kind: 'blocked', laneKey: input.orcaTaskId, reason: 'Delivery 去重查询返回了错误的结果种类' };
  }
  if (result.settlements.length > 1) {
    return { kind: 'blocked', laneKey: input.orcaTaskId, reason: '同一去重键存在多条结算记录' };
  }
  return { kind: 'read', settlement: result.settlements[0] ?? null };
}

/**
 * 结算一条 Delivery。
 *
 * 调用方提供已经读好的可信事实与稳定 OperationId；用例自身不生成 ID、不读时钟、不换 ID 重试。
 */
export async function settleDelivery(input: SettleDeliveryInput): Promise<SettleDeliveryResult> {
  const current = readScope(input.store, input.coordinationScopeId);
  if (current.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: current.code, message: current.message } };
  }
  if (current.scope.revision !== input.expectedRevision) {
    return {
      kind: 'rejected',
      failure: {
        code: 'stale_revision',
        message: `expected revision ${input.expectedRevision} 已过期，当前为 ${current.scope.revision}`,
      },
    };
  }

  // 步骤 1：读取但不确认。
  const read = await input.backend.query({
    operation: 'delivery-read',
    backendIdentityRef: input.backendIdentityRef,
    runId: input.runId,
    types: ['worker_done'],
  });
  if (read.kind !== 'accepted') {
    return { kind: 'rejected', failure: { code: read.code, message: read.message } };
  }
  if (!isDeliveryBatchValue(read.value)) {
    return { kind: 'rejected', failure: { code: 'invalid_response', message: 'delivery-read 返回的不是结构完整的批次' } };
  }
  const batch = read.value;
  if (batch.delivery === null) {
    return {
      kind: 'rejected',
      failure: { code: 'no_delivery', message: '本次读取没有未确认批次，但这不构成「没有新工作」的证明' },
    };
  }
  if (batch.delivery.deliveryId !== input.delivery.deliveryId) {
    return {
      kind: 'rejected',
      failure: { code: 'delivery_mismatch', message: '读取到的 Delivery 与待结算的 Delivery 身份不一致' },
    };
  }
  const deliveryIdentity = batch.delivery;
  if (deliveryIdentity.runId !== null && deliveryIdentity.runId !== input.runId) {
    return {
      kind: 'rejected',
      failure: { code: 'delivery_run_mismatch', message: '读取到的 Delivery 不属于当前 Orca Run' },
    };
  }

  // 步骤 2：身份与代际核验。
  const verification = verifyWorkerResult(input.delivery.claimed, input.trusted);
  if (verification.kind === 'rejected') {
    return {
      kind: 'rejected',
      failure: { code: verification.code, message: verification.message },
      verification,
    };
  }

  const dedupeKey = deliveryDedupeKey({
    deliveryId: deliveryIdentity.deliveryId,
    runId: input.runId,
    consumerGeneration: input.consumerGeneration,
    workerTaskId: input.trusted.workerTaskId,
    dispatchId: input.trusted.dispatchId,
    attemptId: input.trusted.attemptId,
  });

  // 旧代际 / 旧尝试：确认该 Delivery，但只补历史，不写入结果引用。
  if (verification.kind === 'stale_generation' || verification.kind === 'stale_attempt') {
    const confirmed = await confirmDelivery(input, deliveryIdentity.deliveryId, deliveryIdentity.runId);
    return confirmed ?? { kind: 'history_only', verification };
  }

  // 步骤 3：稳定键去重。
  const existing = readSettlement(input, dedupeKey);
  if ('kind' in existing && existing.kind !== 'read') {
    return existing;
  }
  if (existing.kind === 'read' && existing.settlement !== null) {
    const readback = await verifyResultReadback(input);
    if ('code' in readback) {
      return { kind: 'blocked', laneKey: input.orcaTaskId, reason: readback.message };
    }
    const confirmed = await confirmDelivery(input, deliveryIdentity.deliveryId, deliveryIdentity.runId);
    return confirmed ?? { kind: 'replayed', settlement: existing.settlement };
  }

  // 步骤 4：在 Orca 记录 Accepted Worker Result。
  const accepted = await runSettlementMutation(
    input,
    input.operationIds.acceptResult,
    { kind: 'task', id: input.orcaTaskId },
    {
      operation: 'task-update',
      taskId: input.orcaTaskId,
      status: 'completed',
      result: input.delivery.acceptedResult,
    },
  );
  if (accepted.kind === 'failed') {
    return accepted.result;
  }
  const readback = await verifyResultReadback(input);
  if ('code' in readback) {
    return { kind: 'blocked', laneKey: input.orcaTaskId, reason: readback.message };
  }

  // 步骤 5：持久化去重键与结果引用并回读。本地只存引用，不存正文。
  const persistRevision = freshRevision(input);
  if (typeof persistRevision !== 'number') {
    return { kind: 'blocked', laneKey: input.orcaTaskId, reason: persistRevision.message };
  }
  const recorded = input.store.transact({
    kind: 'record-delivery-settlement',
    coordinationScopeId: input.coordinationScopeId,
    expectedRevision: persistRevision,
    writer: input.writer,
    dedupeKey,
    deliveryId: deliveryIdentity.deliveryId,
    runId: input.runId,
    consumerGeneration: input.consumerGeneration,
    workerTaskId: input.trusted.workerTaskId,
    dispatchId: input.trusted.dispatchId,
    attemptId: input.trusted.attemptId,
    role: verification.attribution.role,
    contractRevision: input.trusted.specBinding.contractRevision,
    orcaResultRef: readback.orcaResultRef,
  });
  if (recorded.kind === 'rejected') {
    return { kind: 'blocked', laneKey: input.orcaTaskId, reason: recorded.message };
  }
  const persisted = readSettlement(input, dedupeKey);
  if (!('kind' in persisted) || persisted.kind !== 'read' || persisted.settlement === null) {
    return {
      kind: 'blocked',
      laneKey: input.orcaTaskId,
      reason: '写入后无法回读 Delivery 去重键与结果引用',
    };
  }
  if (persisted.settlement.orcaResultRef !== readback.orcaResultRef) {
    return { kind: 'blocked', laneKey: input.orcaTaskId, reason: '回读的结果引用与写入值不一致' };
  }

  // 步骤 6：最后确认。
  const confirmed = await confirmDelivery(input, deliveryIdentity.deliveryId, deliveryIdentity.runId);
  if (confirmed !== null) {
    return confirmed;
  }
  return { kind: 'settled', dedupeKey, orcaResultRef: readback.orcaResultRef, verification };
}
