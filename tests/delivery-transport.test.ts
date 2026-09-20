import { expect, test } from 'vitest';

import type {
  DeliveryBatch,
  DeliveryIdentity,
  ExecutionQueryResult,
  OperationOutcome,
} from '../src/application/dto/operation-outcome.js';
import type {
  ExecutionBackend,
  ExecutionMutation,
  ExecutionQuery,
  ExecutionScope,
} from '../src/application/ports/execution-backend.js';
import { ackDelivery, readDeliveryBatch } from '../src/adapters/orca-cli/delivery-reader.js';
import { isDeliveryBatch, parseDeliveryBatch } from '../src/adapters/orca-cli/operation-catalog.js';

type RecordedMutation = { readonly input: ExecutionMutation; readonly scope: ExecutionScope };

type FakeBackend = {
  readonly backend: ExecutionBackend;
  readonly queries: ExecutionQuery[];
  readonly mutations: RecordedMutation[];
};

function fakeBackend(handlers: {
  readonly query?: (input: ExecutionQuery) => ExecutionQueryResult;
  readonly mutate?: (input: ExecutionMutation, scope: ExecutionScope) => OperationOutcome<unknown>;
}): FakeBackend {
  const queries: ExecutionQuery[] = [];
  const mutations: RecordedMutation[] = [];
  const backend: ExecutionBackend = {
    query: (input) => {
      queries.push(input);
      return Promise.resolve(
        handlers.query?.(input) ?? { kind: 'rejected', code: 'unexpected', message: 'no query handler' },
      );
    },
    mutate: (input, scope) => {
      mutations.push({ input, scope });
      return Promise.resolve(
        handlers.mutate?.(input, scope) ?? { kind: 'rejected', code: 'unexpected', message: 'no mutate handler' },
      );
    },
  };
  return { backend, queries, mutations };
}

const workerDonePayload = JSON.stringify({
  taskId: 'task_1',
  dispatchId: 'dispatch_1',
  attemptId: 'attempt_1',
  outcome: 'succeeded',
});

/** 真实 `orca orchestration check --json` 的原始载荷（snake_case，字段名来自公开 CLI）。 */
const rawCheckPayload = {
  runId: 'run_1',
  deliveryId: 'delivery_1',
  count: 1,
  messages: [
    {
      id: 'msg_1',
      run_id: 'run_1',
      delivery_contract: 'current_delivery',
      from_handle: 'term_worker',
      to_handle: 'run:run_1',
      type: 'worker_done',
      subject: 'done',
      priority: 'normal',
      body: 'worker finished',
      payload: workerDonePayload,
    },
  ],
};

/** adapter 的登记 parser 把原始载荷归一化成 backend 交给上层的形状。 */
function parsedBatch(): DeliveryBatch {
  const parsed = parseDeliveryBatch(rawCheckPayload);
  if (!parsed.ok) {
    throw new Error(`fixture 解析失败: ${parsed.message}`);
  }
  return parsed.value;
}

function executionScope(): ExecutionScope {
  return {
    coordinationScopeId: 'scope-1',
    coordinatorSessionId: 'session-1',
    runtimeIncarnationId: 'incarnation-1',
    fencingGeneration: 1,
    backendIdentityRef: 'identity-ref',
    operationId: 'operation-1',
    target: { kind: 'delivery', id: 'delivery_1' },
    expectedRevision: 1,
    timeoutMs: 5_000,
    authority: { kind: 'route_planning' },
  };
}

test('adapter parser 把原始 check 载荷归一化为稳定 Delivery identity', () => {
  const batch = parsedBatch();

  expect(batch.delivery).toEqual({ deliveryId: 'delivery_1', runId: 'run_1' });
  expect(batch.timedOut).toBe(false);
  expect(batch.cancelled).toBe(false);
  expect(batch.messages).toHaveLength(1);
  expect(batch.messages[0]).toMatchObject({
    messageId: 'msg_1',
    runId: 'run_1',
    deliveryContract: 'current_delivery',
    fromHandle: 'term_worker',
    toHandle: 'run:run_1',
    type: 'worker_done',
    body: 'worker finished',
  });
  // payload 是 task/dispatch/attempt 归属的唯一来源，必须逐字保留。
  expect(batch.messages[0]?.payload).toBe(workerDonePayload);
  expect(JSON.parse(batch.messages[0]?.payload ?? '{}')).toEqual({
    taskId: 'task_1',
    dispatchId: 'dispatch_1',
    attemptId: 'attempt_1',
    outcome: 'succeeded',
  });
});

test('结构确认只接受归一化后的批次，拒绝把原始载荷当成交付结果', () => {
  expect(isDeliveryBatch(parsedBatch())).toBe(true);
  // 原始 snake_case 载荷不是上层看到的形状；这里回归的是「二次解析已归一化的值」这一类缺陷。
  expect(isDeliveryBatch(rawCheckPayload)).toBe(false);
  expect(isDeliveryBatch({ delivery: { deliveryId: 'delivery_1' }, messages: [{ messageId: 'm' }] })).toBe(false);
  expect(isDeliveryBatch({ delivery: null, messages: [] })).toBe(true);
});

test('读取返回稳定 Delivery identity，且不隐式确认', async () => {
  const { backend, queries, mutations } = fakeBackend({
    query: () => ({ kind: 'accepted', value: parsedBatch() }),
  });

  const result = await readDeliveryBatch(backend, {
    backendIdentityRef: 'identity-ref',
    runId: 'run_1',
    readMode: 'peek',
  });

  expect(result.kind).toBe('accepted');
  if (result.kind !== 'accepted') {
    return;
  }
  expect(result.value.delivery).toEqual({ deliveryId: 'delivery_1', runId: 'run_1' });
  expect(queries).toHaveLength(1);
  expect(queries[0]?.operation).toBe('delivery-read');
  // 读取本身绝不发起确认。
  expect(mutations).toHaveLength(0);
});

test('读取结果结构不完整时 fail closed', async () => {
  const { backend } = fakeBackend({
    query: () => ({ kind: 'accepted', value: { delivery: { deliveryId: 'delivery_1' }, messages: [{}] } }),
  });

  const result = await readDeliveryBatch(backend, { backendIdentityRef: 'identity-ref' });

  expect(result.kind).toBe('rejected');
  if (result.kind === 'rejected') {
    expect(result.code).toBe('invalid_response');
  }
});

test('读取失败时原样返回拒绝，不伪造身份', async () => {
  const { backend } = fakeBackend({
    query: () => ({ kind: 'rejected', code: 'run_not_found', message: 'no such run' }),
  });

  const result = await readDeliveryBatch(backend, { backendIdentityRef: 'identity-ref' });

  expect(result).toEqual({ kind: 'rejected', code: 'run_not_found', message: 'no such run' });
});

test('确认是独立 mutation，只确认目标 identity 且不重新读取', async () => {
  const { backend, queries, mutations } = fakeBackend({
    mutate: (_input, scope): OperationOutcome<unknown> => ({
      kind: 'accepted',
      operation: { operationId: scope.operationId, backendRequestId: 'req-ack-1', target: scope.target },
      value: { state: 'released' },
    }),
  });
  const identity: DeliveryIdentity = { deliveryId: 'delivery_1', runId: 'run_1' };

  const result = await ackDelivery(backend, executionScope(), identity);

  expect(result.kind).toBe('accepted');
  if (result.kind === 'accepted') {
    expect(result.value).toEqual({ deliveryId: 'delivery_1', runId: 'run_1' });
    expect(result.operation.backendRequestId).toBe('req-ack-1');
  }
  expect(queries).toHaveLength(0);
  expect(mutations).toHaveLength(1);
  expect(mutations[0]?.input).toEqual({ operation: 'delivery-ack', deliveryId: 'delivery_1', runId: 'run_1' });
  expect(mutations[0]?.scope.operationId).toBe('operation-1');
});

test('确认沿用 OperationOutcome 三值语义', async () => {
  const operationRef = {
    operationId: 'operation-1',
    backendRequestId: 'req-ack-1',
    target: { kind: 'delivery', id: 'delivery_1' },
  };
  const identity: DeliveryIdentity = { deliveryId: 'delivery_1', runId: null };

  const unknownBackend = fakeBackend({
    mutate: () => ({ kind: 'unknown', operation: operationRef, reason: 'release_pending' }),
  });
  const unknown = await ackDelivery(unknownBackend.backend, executionScope(), identity);
  expect(unknown).toEqual({ kind: 'unknown', operation: operationRef, reason: 'release_pending' });
  // runId 未知时不下发 --run，也不臆造值。
  expect(unknownBackend.mutations[0]?.input).toEqual({ operation: 'delivery-ack', deliveryId: 'delivery_1' });

  const rejectedBackend = fakeBackend({
    mutate: () => ({ kind: 'rejected', code: 'consumer_fenced', message: 'fenced' }),
  });
  const rejected = await ackDelivery(rejectedBackend.backend, executionScope(), identity);
  expect(rejected).toEqual({ kind: 'rejected', code: 'consumer_fenced', message: 'fenced' });
});
