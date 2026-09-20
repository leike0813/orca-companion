/**
 * IC-02：三值操作结果、对账结果与 Delivery transport DTO
 * （Owner: `m0-orca-control-baseline`）。
 *
 * 这些类型是 Application 层与 Orca adapter 之间的公共字段合同。字段来源、信任与校验规则见
 * `docs/interface-contracts.md` 的 IC-02；本文件不复制 Orca 状态机，也不定义外部错误码词表。
 */

import type { EntityRef } from './identity.js';

/** 后端侧凭据，只用于对账；不替代 Companion 的 `operationId`。 */
export type OperationRef = {
  readonly operationId: string;
  readonly backendRequestId?: string;
  readonly target: EntityRef<string>;
};

/**
 * 三值结果。`accepted` 表示外部系统记录了确定结果（含确定失败），不表示 Worker 完成或项目可交付；
 * `rejected` 只在能证明请求未产生副作用时使用；其余为 `unknown`。
 */
export type OperationOutcome<T> =
  | { readonly kind: 'accepted'; readonly operation: OperationRef; readonly value: T }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string }
  | { readonly kind: 'unknown'; readonly operation: OperationRef; readonly reason: string };

/**
 * 查询没有副作用，因此不产生 `unknown` 处置：无法判定时仍是「可证明未产生副作用」的 `rejected`，
 * 失败类别由 adapter 的 `classifyOrcaFailure` 从错误码推导，不复制进这个 DTO。
 */
export type ExecutionQueryResult<T = unknown> =
  | { readonly kind: 'accepted'; readonly value: T }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

/** `absent` 与 `pending` 都不是「未发生」的证明，必须保留 mutation lane 并阻塞。 */
export type ReconcileBlockReason =
  | 'pending'
  | 'absent'
  | 'unavailable'
  | 'unrecognized'
  | 'no_backend_request_id';

export type ReconcileResult =
  | { readonly kind: 'settled'; readonly operation: OperationRef; readonly statement: string }
  | { readonly kind: 'blocked'; readonly operation: OperationRef; readonly reason: ReconcileBlockReason };

export type DeliveryContract = 'legacy_direct' | 'current_delivery' | 'audit_only';

/**
 * 一条投递消息。task / dispatch / attempt 归属由生命周期消息的 `payload` JSON 承载，
 * 因此原文保留 `payload`，不在这里猜测或补造字段。
 */
export type DeliveryMessage = {
  readonly messageId: string;
  readonly runId: string | null;
  readonly deliveryContract: DeliveryContract | null;
  readonly fromHandle: string;
  readonly toHandle: string | null;
  readonly type: string | null;
  readonly subject: string | null;
  readonly priority: string | null;
  readonly body: string | null;
  readonly payload: string | null;
};

/** 确认只接受这个稳定身份；确认与读取是两个独立调用。 */
export type DeliveryIdentity = {
  readonly deliveryId: string;
  /** 该批次所属 Run；Orca 未报告时为 null，不臆造。 */
  readonly runId: string | null;
};

export type DeliveryBatch = {
  /** `null` 表示本次读取没有未确认批次，不构成「没有新工作」的证明。 */
  readonly delivery: DeliveryIdentity | null;
  readonly messages: readonly DeliveryMessage[];
  readonly timedOut: boolean;
  readonly cancelled: boolean;
};

export type DeliveryAck = {
  readonly deliveryId: string;
  readonly runId: string | null;
};

export function isAccepted<T>(
  outcome: OperationOutcome<T>,
): outcome is Extract<OperationOutcome<T>, { kind: 'accepted' }> {
  return outcome.kind === 'accepted';
}

export function isUnknown<T>(
  outcome: OperationOutcome<T>,
): outcome is Extract<OperationOutcome<T>, { kind: 'unknown' }> {
  return outcome.kind === 'unknown';
}

export function isRejected<T>(
  outcome: OperationOutcome<T>,
): outcome is Extract<OperationOutcome<T>, { kind: 'rejected' }> {
  return outcome.kind === 'rejected';
}
