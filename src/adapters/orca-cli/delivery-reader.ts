/**
 * IP-4：Delivery transport 原语 —— 读取与确认必须分离。
 *
 * `readDeliveryBatch` 只读取：它不确认、不落盘、不推进生命周期、不建立持久化去重，也不替上层决定
 * 何时确认。`ackDelivery` 只确认调用方指定的稳定 Delivery identity，并沿用 OperationOutcome 三值语义。
 * 「先落盘、回读、再确认」的顺序由上层用例负责。
 */

import type {
  DeliveryAck,
  DeliveryBatch,
  DeliveryIdentity,
  ExecutionQueryResult,
  OperationOutcome,
} from '../../application/dto/operation-outcome.js';
import type { ExecutionBackend, ExecutionQuery, ExecutionScope } from '../../application/ports/execution-backend.js';
import { isDeliveryBatch } from './operation-catalog.js';

export type DeliveryReadInput = {
  readonly backendIdentityRef: string;
  readonly runId?: string;
  readonly types?: readonly string[];
  readonly wait?: boolean;
  readonly timeoutMs?: number;
  readonly readMode?: 'default' | 'peek' | 'all';
};

/**
 * 读取但不确认：返回的 `DeliveryIdentity` 是稳定的，只在调用方处理完消息后才应交给 `ackDelivery`。
 * 结果字段不完整时 fail closed，不把无 identity 的批次交给上层。
 *
 * 这里只做结构确认：`delivery-read` 的原始载荷解析属于 adapter 的登记 parser，此处不重复解析
 * （重复套用原始 parser 会把已经归一化的字段当成缺失）。
 */
export async function readDeliveryBatch(
  backend: ExecutionBackend,
  input: DeliveryReadInput,
): Promise<ExecutionQueryResult<DeliveryBatch>> {
  const query: ExecutionQuery = { operation: 'delivery-read', ...input };
  const result = await backend.query(query);
  if (result.kind !== 'accepted') {
    return result;
  }
  if (!isDeliveryBatch(result.value)) {
    return {
      kind: 'rejected',
      code: 'invalid_response',
      message: 'delivery-read 返回的不是结构完整的 DeliveryBatch',
    };
  }
  return { kind: 'accepted', value: result.value };
}

/**
 * 确认是独立 mutation：只接受稳定 identity，不重新读取批次，也不推断要确认什么。
 */
export async function ackDelivery(
  backend: ExecutionBackend,
  scope: ExecutionScope,
  identity: DeliveryIdentity,
): Promise<OperationOutcome<DeliveryAck>> {
  const outcome = await backend.mutate(
    {
      operation: 'delivery-ack',
      deliveryId: identity.deliveryId,
      ...(identity.runId === null ? {} : { runId: identity.runId }),
    },
    scope,
  );
  if (outcome.kind !== 'accepted') {
    return outcome;
  }
  return {
    kind: 'accepted',
    operation: outcome.operation,
    value: { deliveryId: identity.deliveryId, runId: identity.runId },
  };
}
