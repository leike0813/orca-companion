import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AIMessage, AIMessageChunk } from '@langchain/core/messages';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { projectActionableWork, type SourceObservation } from '../../src/application/coordinator/actionable-work.js';
import type { TranscriptStreamEvent } from '../../src/application/coordinator/history.js';
import type { FencingAssertion } from '../../src/application/coordinator/runtime-guard.js';
import type { CoordinatorSessionId } from '../../src/application/dto/identity.js';
import { openCheckpointStore, type CheckpointStore } from '../../src/adapters/storage/checkpoint-store.js';
import { ScriptedStreamingChatModel } from '../support/fake-chat-model.js';
import {
  COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
  type CoordinatorSessionState,
} from '../../src/domain/coordinator/session-state.js';
import { buildCoordinatorGraph, routeAfterModel, routeAtStart } from '../../src/workflow/coordinator/graph.js';
import { streamModelCall } from '../../src/workflow/coordinator/model-call.js';
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
  readonly streamObserver?: (event: TranscriptStreamEvent) => void;
  readonly maxResponseBytes?: number;
  readonly sessionRecords?: unknown;
} = {}) {
  let step = 0;
  return buildCoordinatorGraph({
    model: model as never,
    configurationRef: 'test-configuration',
    checkpointer: store.checkpointer,
    sessionRecords: (overrides.sessionRecords as never) ?? store,
    assertFencing: overrides.assertFencing ?? (() => ({ kind: 'valid', lease: {} as never })),
    newStepId: () => `step-${String((step += 1))}`,
    sleep: () => Promise.resolve(),
    ...(overrides.streamObserver === undefined ? {} : { streamObserver: overrides.streamObserver }),
    ...(overrides.maxResponseBytes === undefined ? {} : { maxResponseBytes: overrides.maxResponseBytes }),
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
  const failing = new ScriptedStreamingChatModel([
    { kind: 'error' },
    { kind: 'error' },
    { kind: 'error' },
  ]);
  const interrupted = graphWith(failing);

  const result = await interrupted.invoke(
    { coordinatorSessionId: SESSION, remainingWork: work(1).items, deferredWork: 0 },
    { configurable: { thread_id: 'thread-1' }, ...COORDINATOR_INVOKE_DEFAULTS },
  );

  expect(result.status).toBe('stalled');
  // D15：重试次数由 model node 的策略封顶，而不是无限重试；每次尝试都是一次完整的流式消费。
  expect(failing.received).toHaveLength(MODEL_NODE_MAX_ATTEMPTS);

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

/**
 * 以下用例走的是生产模型节点的**真实流式消费**（`.stream()` + SDK `handleLLMEnd` 聚合），
 * 因此断言的是可观察结果：已提交历史、调用次数与预览事件，而不是 chunk 内部实现。
 */
function committedSteps(): CoordinatorSessionState['committedModelSteps'] {
  const read = store.loadCheckpoint(SESSION);
  if (read.kind !== 'recovered') {
    throw new Error('会话记录不可恢复');
  }
  return read.state.committedModelSteps;
}

test('逐 chunk 产生的响应只在完整返回后被接受，预览按 started→delta→committed 推进', async () => {
  seedSession();
  const model = new ScriptedStreamingChatModel([
    { kind: 'text', text: '先读地图再派发', chunkSize: 3, usage: [{ input_tokens: 7, output_tokens: 4, total_tokens: 11 }] },
  ]);
  const events: TranscriptStreamEvent[] = [];
  const graph = graphWith(model, { streamObserver: (event) => events.push(event) });

  const result = await graph.invoke(
    { coordinatorSessionId: SESSION, remainingWork: work(1).items, deferredWork: 0 },
    { configurable: { thread_id: 'thread-stream' }, ...COORDINATOR_INVOKE_DEFAULTS },
  );

  expect(result.status).toBe('suspended');
  // 末尾那个只带 usage 的空 chunk 不会污染正文。
  expect(committedSteps()[0]?.messages).toEqual([
    { entryId: 'entry:assistant:step-1', stepId: 'step-1', role: 'assistant', content: '先读地图再派发' },
  ]);
  // 单一完整 usage 报告被保存：这是 provider 实际给出的数字。
  expect(committedSteps()[0]?.usage).toEqual({ inputTokens: 7, outputTokens: 4, totalTokens: 11 });

  expect(model.producedChunks).toBeGreaterThan(1);
  expect(events[0]).toEqual({
    coordinatorSessionId: SESSION,
    previewId: 'preview:step-1:attempt-1',
    kind: 'started',
  });
  const deltas = events.filter((event) => event.kind === 'delta').map((event) => event.text);
  expect(deltas.join('')).toBe('先读地图再派发');
  expect(events.at(-1)).toEqual({
    coordinatorSessionId: SESSION,
    previewId: 'preview:step-1:attempt-1',
    kind: 'committed',
    entryId: 'entry:assistant:step-1',
  });
  // 预览身份由可信 step 与 attempt 派生：模型无法影响它。
  expect(events.every((event) => event.previewId === 'preview:step-1:attempt-1')).toBe(true);
});

test('未完整返回的响应不进入历史，也不发布 committed', async () => {
  seedSession();
  const model = new ScriptedStreamingChatModel([
    { kind: 'incomplete', text: '半句话就没了', chunkSize: 2 },
    { kind: 'incomplete', text: '还是没说完', chunkSize: 2 },
    { kind: 'incomplete', text: '依然断掉', chunkSize: 2 },
  ]);
  const events: TranscriptStreamEvent[] = [];
  const graph = graphWith(model, { streamObserver: (event) => events.push(event) });

  const result = await graph.invoke(
    { coordinatorSessionId: SESSION, remainingWork: work(1).items, deferredWork: 0 },
    { configurable: { thread_id: 'thread-partial' }, ...COORDINATOR_INVOKE_DEFAULTS },
  );

  expect(result.status).toBe('stalled');
  expect(committedSteps()).toEqual([]);
  expect(store.loadCheckpoint(SESSION)).toMatchObject({ kind: 'recovered', state: { committedMessages: [] } });
  expect(events.some((event) => event.kind === 'committed')).toBe(false);
  // 普通模型故障仍按既有策略有限重试，每次尝试用同一个 step 派生不同预览身份。
  expect(model.received).toHaveLength(MODEL_NODE_MAX_ATTEMPTS);
  expect(events.filter((event) => event.kind === 'interrupted')).toHaveLength(MODEL_NODE_MAX_ATTEMPTS);
});

test('一次失败后重试成功：只有一个 step，且身份沿用同一个可信 stepId', async () => {
  seedSession();
  const model = new ScriptedStreamingChatModel([
    { kind: 'error' },
    { kind: 'text', text: '恢复后的响应', chunkSize: 2 },
  ]);
  const events: TranscriptStreamEvent[] = [];
  const graph = graphWith(model, { streamObserver: (event) => events.push(event) });

  const result = await graph.invoke(
    { coordinatorSessionId: SESSION, remainingWork: work(1).items, deferredWork: 0 },
    { configurable: { thread_id: 'thread-retry' }, ...COORDINATOR_INVOKE_DEFAULTS },
  );

  expect(result.status).toBe('suspended');
  expect(model.received).toHaveLength(2);
  const steps = committedSteps();
  expect(steps.map((step) => step.stepId)).toEqual(['step-1']);
  expect(steps[0]?.messages).toEqual([
    { entryId: 'entry:assistant:step-1', stepId: 'step-1', role: 'assistant', content: '恢复后的响应' },
  ]);
  // 第一次尝试的预览被中断，接受的是第二次尝试的预览。
  expect(events.filter((event) => event.kind === 'interrupted')).toHaveLength(1);
  expect(events.at(-1)).toMatchObject({ kind: 'committed', previewId: 'preview:step-1:attempt-2' });
});

test('输出超限时实际终止这次调用，不重试也不提交部分响应', async () => {
  seedSession();
  const model = new ScriptedStreamingChatModel([{ kind: 'text', text: 'x'.repeat(4096), chunkSize: 512 }]);
  const events: TranscriptStreamEvent[] = [];
  const graph = graphWith(model, {
    maxResponseBytes: 1024,
    streamObserver: (event) => events.push(event),
  });

  const result = await graph.invoke(
    { coordinatorSessionId: SESSION, remainingWork: work(1).items, deferredWork: 0 },
    { configurable: { thread_id: 'thread-limit' }, ...COORDINATOR_INVOKE_DEFAULTS },
  );

  expect(result.status).toBe('stalled');
  expect(model.received).toHaveLength(1);
  expect(committedSteps()).toEqual([]);
  expect(events.filter((event) => event.kind === 'interrupted')).toHaveLength(1);
});

test('调用期间 Scope 取消时停止活跃调用且不重试', async () => {
  seedSession();
  const model = new ScriptedStreamingChatModel([{ kind: 'text', text: '一段很长的回答'.repeat(200), chunkSize: 8 }]);
  const controller = new AbortController();
  const events: TranscriptStreamEvent[] = [];
  const graph = graphWith(model, {
    streamObserver: (event) => {
      events.push(event);
      if (event.kind === 'delta') {
        controller.abort();
      }
    },
  });

  // 取消会同时终止整个 invoke：节点能保证的是「不留部分响应、不重复调用」。
  await expect(
    graph.invoke(
      { coordinatorSessionId: SESSION, remainingWork: work(1).items, deferredWork: 0 },
      { configurable: { thread_id: 'thread-cancel' }, signal: controller.signal, ...COORDINATOR_INVOKE_DEFAULTS },
    ),
  ).rejects.toThrow();

  expect(model.received).toHaveLength(1);
  expect(committedSteps()).toEqual([]);
  expect(events.some((event) => event.kind === 'committed')).toBe(false);
});

test('流中失去 fencing 时停止调用、以 blocked 结束，且不重试', async () => {
  seedSession();
  const model = new ScriptedStreamingChatModel([{ kind: 'text', text: '迟到响应', chunkSize: 2 }]);
  let checks = 0;
  const graph = graphWith(model, {
    assertFencing: () =>
      (checks += 1) === 1 ? { kind: 'valid', lease: {} as never } : { kind: 'fenced', code: 'stale_generation' },
  });

  const result = await graph.invoke(
    { coordinatorSessionId: SESSION, remainingWork: work(1).items, deferredWork: 0 },
    { configurable: { thread_id: 'thread-stream-fenced' }, ...COORDINATOR_INVOKE_DEFAULTS },
  );

  expect(result.status).toBe('blocked');
  expect(model.received).toHaveLength(1);
  expect(committedSteps()).toEqual([]);
});

test('预览观察者故障只让预览不可用，不重复模型调用', async () => {
  seedSession();
  const model = new ScriptedStreamingChatModel([{ kind: 'text', text: '完整响应', chunkSize: 2 }]);
  const graph = graphWith(model, {
    streamObserver: () => {
      throw new Error('预览存储已满');
    },
  });

  const result = await graph.invoke(
    { coordinatorSessionId: SESSION, remainingWork: work(1).items, deferredWork: 0 },
    { configurable: { thread_id: 'thread-preview-fault' }, ...COORDINATOR_INVOKE_DEFAULTS },
  );

  expect(result.status).toBe('suspended');
  expect(model.received).toHaveLength(1);
  expect(committedSteps()[0]?.messages).toEqual([
    { entryId: 'entry:assistant:step-1', stepId: 'step-1', role: 'assistant', content: '完整响应' },
  ]);
});

test('只有单个完整 usage 报告才被保存：不完整或多片段一律留空', async () => {
  seedSession();
  const scenarios = [
    { label: '单个完整报告', usage: [{ input_tokens: 5, output_tokens: 6, total_tokens: 11 }], expected: { inputTokens: 5, outputTokens: 6, totalTokens: 11 } },
    {
      label: '两个非空片段',
      usage: [
        { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
        { input_tokens: 0, output_tokens: 2, total_tokens: 2 },
      ],
      expected: null,
    },
    {
      // 片段多于两个时结论不变：计数是饱和的，内存里也不会为一次调用留一份无界数组。
      label: '四个非空片段',
      usage: [
        { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      ],
      expected: null,
    },
    {
      // 只报了一个数字的报告不是可确认的完整报告：提交它就是把「没拿到」写成「是 0」。
      label: '单个部分报告',
      usage: [{ input_tokens: 7 }],
      expected: null,
    },
    {
      // 部分报告同样算一次观察：否则「部分 + 完整」会被当成只有一次，部分那份被静默忽略。
      label: '部分加完整两个片段',
      usage: [{ input_tokens: 7 }, { input_tokens: 5, output_tokens: 6, total_tokens: 11 }],
      expected: null,
    },
  ] as const;

  for (const [index, scenario] of scenarios.entries()) {
    store.close();
    const fresh = openCheckpointStore({ databasePath: join(directory, `usage-${String(index)}.sqlite`) });
    if (fresh.kind !== 'opened') {
      throw new Error(fresh.message);
    }
    store = fresh.store;
    seedSession();
    const model = new ScriptedStreamingChatModel([{ kind: 'text', text: `回答 ${String(index)}`, usage: scenario.usage }]);
    const graph = graphWith(model);

    const result = await graph.invoke(
      { coordinatorSessionId: SESSION, remainingWork: work(1).items, deferredWork: 0 },
      { configurable: { thread_id: `thread-usage-${String(index)}` }, ...COORDINATOR_INVOKE_DEFAULTS },
    );

    expect(result.status).toBe('suspended');
    expect(committedSteps()[0]?.usage).toEqual(scenario.expected);
  }
});

test('内容块里的 null 与非对象项不会让整次调用崩掉', async () => {
  seedSession();
  const model = new ScriptedStreamingChatModel([
    {
      kind: 'raw_chunks',
      chunks: [
        new AIMessageChunk([null, { type: 'text', text: '只有这一段可见' }] as never),
        new AIMessageChunk([42, { type: 'text', text: '后面还有' }] as never),
      ],
    },
  ]);
  const deltas: string[] = [];
  const graph = graphWith(model, { streamObserver: (event) => { if (event.kind === 'delta') deltas.push(event.text); } });

  const result = await graph.invoke(
    { coordinatorSessionId: SESSION, remainingWork: work(1).items, deferredWork: 0 },
    { configurable: { thread_id: 'thread-odd-blocks' }, ...COORDINATOR_INVOKE_DEFAULTS },
  );

  expect(result.status).toBe('suspended');
  expect(model.received).toHaveLength(1);
  expect(deltas.join('')).toBe('只有这一段可见后面还有');
  expect(committedSteps()).toHaveLength(1);
});

test('调用开始前已取消时不发起模型调用，预览直接以 interrupted 收尾', async () => {
  const model = new ScriptedStreamingChatModel([{ kind: 'text', text: '不该被调用' }]);
  const events: TranscriptStreamEvent[] = [];
  const controller = new AbortController();
  controller.abort();

  // 直接打这条接缝：图层在信号已取消时根本不会调度节点，这一层必须自己拒绝发起调用。
  const outcome = await streamModelCall({
    model,
    messages: [new AIMessage('输入')],
    signal: controller.signal,
    assertFencing: () => ({ kind: 'valid', lease: {} as never }),
    streamObserver: (event) => events.push(event),
    coordinatorSessionId: SESSION,
    previewId: 'preview:step-1:attempt-1',
  });

  expect(outcome).toMatchObject({ kind: 'failed', reason: 'cancelled' });
  // 已经被取消的调用不会再发一次请求，也就没有任何 provider 侧事实产生。
  expect(model.received).toEqual([]);
  // 临时源不会因为「没有 started 也没有终态」而永远停在 streaming。
  expect(events.map((event) => event.kind)).toEqual(['interrupted']);
});

test('响应无法落盘时不提交历史，并让这次预览以 interrupted 结束', async () => {
  seedSession();
  const model = new ScriptedStreamingChatModel([{ kind: 'text', text: '写不进去的响应', chunkSize: 2 }]);
  const events: TranscriptStreamEvent[] = [];
  const refusing = new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'appendModelStep') {
        return (): { readonly kind: 'failed'; readonly message: string } => ({
          kind: 'failed',
          message: '存储不可写',
        });
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? (value.bind(target) as unknown) : value;
    },
  });
  const graph = graphWith(model, { sessionRecords: refusing, streamObserver: (event) => events.push(event) });

  const result = await graph.invoke(
    { coordinatorSessionId: SESSION, remainingWork: work(1).items, deferredWork: 0 },
    { configurable: { thread_id: 'thread-refused' }, ...COORDINATOR_INVOKE_DEFAULTS },
  );

  expect(result.status).toBe('blocked');
  expect(committedSteps()).toEqual([]);
  expect(events.some((event) => event.kind === 'committed')).toBe(false);
  expect(events.at(-1)?.kind).toBe('interrupted');
});
