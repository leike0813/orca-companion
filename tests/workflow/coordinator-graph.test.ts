import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AIMessage } from '@langchain/core/messages';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { projectActionableWork, type SourceObservation } from '../../src/application/coordinator/actionable-work.js';
import type { FencingAssertion } from '../../src/application/coordinator/runtime-guard.js';
import type { CoordinatorSessionId } from '../../src/application/dto/identity.js';
import { openCheckpointStore, type CheckpointStore } from '../../src/adapters/storage/checkpoint-store.js';
import {
  COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
  type CoordinatorSessionState,
} from '../../src/domain/coordinator/session-state.js';
import { buildCoordinatorGraph, routeAfterModel, routeAtStart } from '../../src/workflow/coordinator/graph.js';
import { MODEL_NODE_MAX_ATTEMPTS, usageOf, isRetryableModelCall } from '../../src/workflow/coordinator/nodes.js';
import { COORDINATOR_INVOKE_DEFAULTS, type CoordinatorGraphState } from '../../src/workflow/coordinator/state.js';

const SESSION = 'session-a' as CoordinatorSessionId;

let directory = '';
let store: CheckpointStore;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-graph-'));
  const opened = openCheckpointStore({ databasePath: join(directory, 'checkpoints.sqlite') });
  if (opened.kind !== 'opened') {
    throw new Error(opened.message);
  }
  store = opened.store;
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

function seedSession(): void {
  const state: CoordinatorSessionState = {
    schemaVersion: COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
    coordinatorSessionId: SESSION,
    committedMessages: [],
    graphPosition: 'start',
    committedModelSteps: [],
    wakeBatches: [],
    lastCompactionOutcome: null,
  };
  const saved = store.saveCheckpoint(state);
  if (saved.kind !== 'saved') {
    throw new Error(saved.message);
  }
}

function work(count: number) {
  const observations: SourceObservation[] = Array.from({ length: count }, (_value, index) => ({
    source: { sourceKind: 'delivery', sourceId: `dispatch-${String(index)}`, revision: 1 },
    classification: 'worker_question',
    summary: `问题 ${String(index)}`,
    ownerCoordinatorSessionId: SESSION,
  }));
  return projectActionableWork({
    coordinatorSessionId: SESSION,
    controlState: 'active',
    observations,
    admitted: [],
  });
}

function graphWith(model: unknown, overrides: {
  readonly buildMessages?: unknown;
  readonly assertFencing?: () => FencingAssertion;
} = {}) {
  let step = 0;
  return buildCoordinatorGraph({
    model: model as never,
    checkpointer: store.checkpointer,
    sessionRecords: store,
    assertFencing: overrides.assertFencing ?? (() => ({ kind: 'valid', lease: {} as never })),
    newStepId: () => `step-${String((step += 1))}`,
    sleep: () => Promise.resolve(),
    buildMessages:
      (overrides.buildMessages as never) ??
      (() => Promise.resolve({ messages: [new AIMessage('占位输入')], note: '有界输入' })),
  });
}

test('模型响应被原子接受为 Committed Model Step，图位置前进到 model', async () => {
  seedSession();
  const graph = graphWith(new FakeListChatModel({ responses: ['先读地图'] }));

  const result = await graph.invoke(
    { coordinatorSessionId: SESSION, remainingWork: work(1).items, deferredWork: 0 },
    { configurable: { thread_id: 'thread-1' }, ...COORDINATOR_INVOKE_DEFAULTS },
  );

  expect(result.status).toBe('suspended');
  const read = store.loadCheckpoint(SESSION);
  expect(read.kind).toBe('recovered');
  if (read.kind === 'recovered') {
    expect(read.state.committedModelSteps).toHaveLength(1);
    expect(read.state.committedModelSteps[0]?.messages).toEqual([
      {
        entryId: 'entry:assistant:step-1',
        stepId: 'step-1',
        role: 'assistant',
        content: '先读地图',
      },
    ]);
    expect(read.state.committedMessages).toHaveLength(1);
    expect(read.state.committedModelSteps[0]?.toolCalls).toEqual([]);
    // 图停在挂起节点，而不是被记为完成或取消。
    expect(read.state.graphPosition).toBe('suspend');
  }
});

test('一次未完整提交的响应不进入历史，重启后从最后一个已提交 step 之后继续', async () => {
  seedSession();
  let attempts = 0;
  const failing = {
    invoke: (): Promise<never> => {
      attempts += 1;
      return Promise.reject(new Error('provider 连接中断'));
    },
  };
  const interrupted = graphWith(failing);

  const result = await interrupted.invoke(
    { coordinatorSessionId: SESSION, remainingWork: work(1).items, deferredWork: 0 },
    { configurable: { thread_id: 'thread-1' }, ...COORDINATOR_INVOKE_DEFAULTS },
  );

  expect(result.status).toBe('stalled');
  // D15：重试次数由 model node 的策略封顶，而不是无限重试。
  expect(attempts).toBe(MODEL_NODE_MAX_ATTEMPTS);

  const afterStall = store.loadCheckpoint(SESSION);
  expect(afterStall.kind).toBe('recovered');
  if (afterStall.kind === 'recovered') {
    expect(afterStall.state.committedModelSteps).toEqual([]);
    expect(afterStall.state.committedMessages).toEqual([]);
    expect(afterStall.state.graphPosition).toBe('start');
  }

  // 恢复：同一个 thread 上再跑一次，成功的那一步成为第一条已提交历史。
  const recovered = graphWith(new FakeListChatModel({ responses: ['继续'] }));
  const second = await recovered.invoke(
    { coordinatorSessionId: SESSION, remainingWork: work(1).items, deferredWork: 0 },
    { configurable: { thread_id: 'thread-1' }, ...COORDINATOR_INVOKE_DEFAULTS },
  );
  expect(second.status).toBe('suspended');
  const afterResume = store.loadCheckpoint(SESSION);
  if (afterResume.kind === 'recovered') {
    expect(afterResume.state.committedModelSteps.map((step) => step.stepId)).toEqual(['step-1']);
  }
});

test('有剩余 Actionable Work 时循环继续消费，没有剩余工作时才挂起', async () => {
  seedSession();
  const graph = graphWith(new FakeListChatModel({ responses: ['一', '二', '三'] }));

  const result = await graph.invoke(
    { coordinatorSessionId: SESSION, remainingWork: work(3).items, deferredWork: 0 },
    { configurable: { thread_id: 'thread-1' }, ...COORDINATOR_INVOKE_DEFAULTS },
  );

  expect(result.status).toBe('suspended');
  expect(result.remainingWork).toEqual([]);
  const read = store.loadCheckpoint(SESSION);
  if (read.kind === 'recovered') {
    expect(read.state.committedModelSteps).toHaveLength(3);
  }
});

test('模型输入拿到本次正要消费的那条 Actionable Work', async () => {
  seedSession();
  const seen: (string | null)[] = [];
  let step = 0;
  const graph = buildCoordinatorGraph({
    model: new FakeListChatModel({ responses: ['一', '二'] }),
    checkpointer: store.checkpointer,
    sessionRecords: store,
    newStepId: () => `step-${String((step += 1))}`,
    sleep: () => Promise.resolve(),
    assertFencing: () => ({ kind: 'valid', lease: {} as never }),
    buildMessages: (_state, currentWork) => {
      seen.push(currentWork === null ? null : currentWork.source.sourceId);
      return Promise.resolve({ messages: [new AIMessage('输入')], note: '' });
    },
  });

  await graph.invoke(
    { coordinatorSessionId: SESSION, remainingWork: work(2).items, deferredWork: 0 },
    { configurable: { thread_id: 'thread-1' }, ...COORDINATOR_INVOKE_DEFAULTS },
  );

  // 消费了工作就必须让模型知道是哪一条，否则历史为空时请求里只剩 system 消息，
  // 部分 provider 会直接以 `messages must not be empty` 拒绝。
  expect(seen).toEqual(['dispatch-0', 'dispatch-1']);
});

test('无 Actionable Work 时不调用模型，直接挂起', async () => {
  seedSession();
  let calls = 0;
  const counting = {
    invoke: (): Promise<AIMessage> => {
      calls += 1;
      return Promise.resolve(new AIMessage('不该被调用'));
    },
  };
  const graph = graphWith(counting);

  const result = await graph.invoke(
    { coordinatorSessionId: SESSION, remainingWork: [], deferredWork: 0 },
    { configurable: { thread_id: 'thread-1' }, ...COORDINATOR_INVOKE_DEFAULTS },
  );

  expect(calls).toBe(0);
  expect(result.status).toBe('suspended');
  const suspendedState: CoordinatorGraphState = {
    coordinatorSessionId: SESSION,
    graphPosition: 'suspend',
    status: 'suspended',
    remainingWork: [],
    deferredWork: 0,
    pendingToolCalls: 0,
    note: '',
  };
  expect(routeAtStart(suspendedState)).toBe('suspend');
  expect(routeAfterModel(suspendedState)).toBe('__end__');
});

test('模型调用期间丢失 fencing 时不提交响应', async () => {
  seedSession();
  let checks = 0;
  const graph = graphWith(new FakeListChatModel({ responses: ['迟到响应'] }), {
    assertFencing: () =>
      (checks += 1) === 1
        ? { kind: 'valid', lease: {} as never }
        : { kind: 'fenced', code: 'stale_generation' },
  });

  const result = await graph.invoke(
    { coordinatorSessionId: SESSION, remainingWork: work(1).items, deferredWork: 0 },
    { configurable: { thread_id: 'thread-fenced' }, ...COORDINATOR_INVOKE_DEFAULTS },
  );

  expect(result.status).toBe('blocked');
  const read = store.loadCheckpoint(SESSION);
  if (read.kind === 'recovered') {
    expect(read.state.committedModelSteps).toEqual([]);
    expect(read.state.committedMessages).toEqual([]);
  }
});

test('上下文维护失败时 fail closed：图标记 blocked 且不写历史', async () => {
  seedSession();
  const failing = (): Promise<never> => Promise.reject(new Error('Capsule 无法生成'));
  const graph = graphWith(new FakeListChatModel({ responses: ['不应被调用'] }), { buildMessages: failing });

  const result = await graph.invoke(
    { coordinatorSessionId: SESSION, remainingWork: work(1).items, deferredWork: 0 },
    { configurable: { thread_id: 'thread-1' }, ...COORDINATOR_INVOKE_DEFAULTS },
  );

  expect(result.status).toBe('blocked');
  expect(result.note).toContain('上下文维护失败');
  const read = store.loadCheckpoint(SESSION);
  if (read.kind === 'recovered') {
    expect(read.state.committedModelSteps).toEqual([]);
  }
});

test('缺少可恢复会话记录时不写任何东西', async () => {
  const graph = graphWith(new FakeListChatModel({ responses: ['x'] }));

  const result = await graph.invoke(
    { coordinatorSessionId: SESSION, remainingWork: [], deferredWork: 0 },
    { configurable: { thread_id: 'thread-1' }, ...COORDINATOR_INVOKE_DEFAULTS },
  );

  expect(result.status).toBe('blocked');
  expect(store.loadCheckpoint(SESSION)).toEqual({ kind: 'absent' });
});

test('D15：模型调用重试次数有限，取消不重试，recursionLimit 只作高位保险', () => {
  expect(MODEL_NODE_MAX_ATTEMPTS).toBeGreaterThan(1);
  expect(COORDINATOR_INVOKE_DEFAULTS.recursionLimit).toBeGreaterThanOrEqual(1_000);
  expect(COORDINATOR_INVOKE_DEFAULTS.durability).toBe('sync');

  expect(isRetryableModelCall(new Error('连接重置'))).toBe(true);
  const abort = new Error('已取消');
  abort.name = 'AbortError';
  expect(isRetryableModelCall(abort)).toBe(false);
});

test('usage 只报告 provider 实际给出的数字，缺失时保留 null', () => {
  expect(usageOf({ usage_metadata: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } })).toEqual({
    inputTokens: 10,
    outputTokens: 2,
    totalTokens: 12,
  });
  expect(usageOf({ usage_metadata: { input_tokens: 10 } })).toEqual({
    inputTokens: 10,
    outputTokens: null,
    totalTokens: null,
  });
  expect(usageOf({ usage_metadata: { input_tokens: -1 } })).toBeNull();
  expect(usageOf(new AIMessage('无 usage'))).toBeNull();
  expect(usageOf(undefined)).toBeNull();
});
