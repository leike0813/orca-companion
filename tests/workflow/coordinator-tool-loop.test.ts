/**
 * IC-04 / D5：受控工具执行与逐 call 结果持久化
 * （Owner: `m1-wire-foreground-planning-runtime`）。
 *
 * 覆盖 Requirement「受控 tool call 由 tools 节点处理」的全部四个场景：工具回合被实际执行、响应提交
 * 后崩溃的补齐、连续 100 个不同调用不被固定 step 上限提前终止，以及无法受控执行的调用必须 blocked
 * 且保留已提交历史。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { projectActionableWork, type ProjectedActionableWorkItem, type SourceObservation } from '../../src/application/coordinator/actionable-work.js';
import type { TranscriptStreamEvent } from '../../src/application/coordinator/history.js';
import type { FencingAssertion } from '../../src/application/coordinator/runtime-guard.js';
import type { HistoryToolObservation } from '../../src/application/coordinator/history-inspection.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  OperationId,
} from '../../src/application/dto/identity.js';
import type { PlanningHandoffResult } from '../../src/application/planning/planning-handoff.js';
import type { PlanningMutationResult } from '../../src/application/planning/route-map-service.js';
import { openCheckpointStore, type CheckpointStore } from '../../src/adapters/storage/checkpoint-store.js';
import {
  COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
  toolOperationId,
  userEntryId,
  type CommittedMessageEntry,
  type CoordinatorSessionState,
  type WakeBatch,
} from '../../src/domain/coordinator/session-state.js';
import { fromDurableMessage } from '../../src/workflow/coordinator/context.js';
import {
  buildCoordinatorGraph,
  routeAfterModel,
  routeAfterTools,
  routeAtStart,
} from '../../src/workflow/coordinator/graph.js';
import {
  planningToolset,
  type PlanningToolDefinition,
  type PlanningToolFacts,
  type PlanningToolServices,
} from '../../src/workflow/coordinator/planning-tools.js';
import { COORDINATOR_INVOKE_DEFAULTS, pendingToolCallsIn, type CoordinatorGraphState } from '../../src/workflow/coordinator/state.js';
import { MODEL_NODE } from '../../src/workflow/coordinator/nodes.js';
import { createToolsNode, TOOLS_NODE } from '../../src/workflow/coordinator/tool-node.js';
import { userQuestionTool } from '../../src/workflow/coordinator/interaction-tools.js';
import { FakeToolModel, type FakeToolModelTurn } from '../support/fake-tool-model.js';
import { ScriptedStreamingChatModel } from '../support/fake-chat-model.js';

const SESSION = 'session-a' as CoordinatorSessionId;
const SCOPE = 'scope-tools' as CoordinationScopeId;

let directory = '';
let store: CheckpointStore;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-tool-loop-'));
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

function baseState(): CoordinatorSessionState {
  return {
    schemaVersion: COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
    coordinatorSessionId: SESSION,
    committedMessages: [],
    graphPosition: 'start',
    committedModelSteps: [],
    wakeBatches: [],
    lastCompactionOutcome: null,
  };
}

function save(state: CoordinatorSessionState): void {
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

function facts(remainingMutations = 1_000): PlanningToolFacts {
  return {
    mode: 'route_planning',
    controlState: 'active',
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION,
    scopeRevision: 7,
    activation: { kind: 'active', coordinatorSessionId: SESSION },
    permissions: { allowPlanningWrites: true },
    budget: { remainingMutations },
  };
}

/** 工具 handler 实际收到的调用：身份必须来自持久化的 call，而不是模型输入。 */
type RecordedCall = {
  readonly name: string;
  readonly operationId: OperationId;
  readonly mapOperationId: OperationId | null;
};

function accepted(): PlanningMutationResult {
  return { kind: 'accepted', revision: 8, mapRevision: 2 };
}

function notUsed(): PlanningHandoffResult {
  return { kind: 'rejected', failure: { code: 'not_used', message: '本测试不发起交接' } };
}

function recordingServices(current: PlanningToolFacts, mutation: PlanningMutationResult = accepted()) {
  const executed: RecordedCall[] = [];
  const record = (name: string, operationId: OperationId, mapOperationId: OperationId | null): void => {
    executed.push({ name, operationId, mapOperationId });
  };
  const services: PlanningToolServices = {
    readFacts: () => current,
    readRouteMap: () => Promise.resolve({ kind: 'ok', value: { sections: {} } }),
    readFrontier: () => Promise.resolve({ kind: 'ok', value: [] }),
    updateRouteMapSection: (input) => {
      record('update_route_map_section', input.operationId, null);
      return Promise.resolve(mutation);
    },
    claimTicket: (input) => {
      record('claim_ticket', input.operationId, null);
      return Promise.resolve(mutation);
    },
    releaseTicket: (input) => {
      record('release_ticket', input.operationId, null);
      return Promise.resolve(mutation);
    },
    resolveTicket: (input) => {
      record('resolve_ticket', input.operationId, input.mapOperationId);
      return Promise.resolve(mutation);
    },
    preparePlanningHandoff: (input) => {
      record('prepare_planning_handoff', input.operationId, null);
      return Promise.resolve(notUsed());
    },
    reviewPlanningHandoff: (input) => {
      record('review_planning_handoff', input.operationId, null);
      return Promise.resolve(notUsed());
    },
  };
  return { executed, services };
}

/**
 * 模型输入按已提交历史组装：走的正是 `fromDurableMessage` 的还原路径，因此「配对结果是否出现在
 * 下一次请求里」是对持久化历史的断言，不是对节点内部变量的断言。
 */
function modelInput(currentWork: { readonly source: { readonly sourceId: string } } | null): readonly unknown[] {
  const read = store.loadCheckpoint(SESSION);
  const history =
    read.kind === 'recovered' ? read.state.committedMessages.map((entry) => fromDurableMessage(entry)) : [];
  return [
    new SystemMessage('你是 Coordinator'),
    ...history,
    ...(currentWork === null ? [] : [new HumanMessage(`[待处理 Actionable Work] ${currentWork.source.sourceId}`)]),
  ];
}

function graphWith(input: {
  readonly model: unknown;
  readonly tools: readonly PlanningToolDefinition[];
  readonly sessionTools?: readonly PlanningToolDefinition[];
  readonly assertFencing?: () => FencingAssertion;
  readonly seenWork?: (string | null)[];
  readonly streamObserver?: (event: TranscriptStreamEvent) => void;
  readonly maxResponseBytes?: number;
}) {
  // step 身份必须跨重启唯一：entry 与 operation 身份都由它派生，重启后重号会与已提交历史冲突。
  const read = store.loadCheckpoint(SESSION);
  let step = read.kind === 'recovered' ? read.state.committedModelSteps.length : 0;
  return buildCoordinatorGraph({
    model: input.model as never,
    checkpointer: store.checkpointer,
    sessionRecords: store,
    planningTools: input.tools,
    ...(input.sessionTools === undefined ? {} : { sessionTools: input.sessionTools }),
    assertFencing: input.assertFencing ?? (() => ({ kind: 'valid', lease: {} as never })),
    newStepId: () => `step-${String((step += 1))}`,
    sleep: () => Promise.resolve(),
    ...(input.streamObserver === undefined ? {} : { streamObserver: input.streamObserver }),
    ...(input.maxResponseBytes === undefined ? {} : { maxResponseBytes: input.maxResponseBytes }),
    buildMessages: (_state, currentWork) => {
      input.seenWork?.push(currentWork === null ? null : currentWork.source.sourceId);
      return Promise.resolve({ messages: modelInput(currentWork), note: '有界输入' });
    },
  });
}

async function runGraph(
  graph: ReturnType<typeof graphWith>,
  input: {
    readonly remainingWork: readonly ProjectedActionableWorkItem[];
    readonly pendingToolCalls?: number;
    readonly thread?: string;
  },
) {
  return await graph.invoke(
    {
      coordinatorSessionId: SESSION,
      remainingWork: input.remainingWork,
      deferredWork: 0,
      pendingToolCalls: input.pendingToolCalls ?? 0,
    },
    { configurable: { thread_id: input.thread ?? 'thread-loop' }, ...COORDINATOR_INVOKE_DEFAULTS },
  );
}

function loadState(): CoordinatorSessionState {
  const read = store.loadCheckpoint(SESSION);
  if (read.kind !== 'recovered') {
    throw new Error(`会话记录不可恢复：${read.kind}`);
  }
  return read.state;
}

function graphState(pendingToolCalls: number): CoordinatorGraphState {
  return {
    coordinatorSessionId: SESSION,
    graphPosition: 'model',
    status: 'running',
    remainingWork: work(1).items,
    deferredWork: 0,
    pendingToolCalls,
    note: '',
  };
}

/** 手工构造「模型响应已提交、结果还没写」的崩溃点状态。 */
function seedPendingCalls(
  calls: readonly { readonly callId: string; readonly name: string; readonly args: Record<string, unknown> }[],
): void {
  const entry: CommittedMessageEntry = {
    entryId: 'entry:assistant:step-1',
    stepId: 'step-1',
    role: 'assistant',
    content: '请求调用',
    toolCalls: calls.map((call) => ({
      callId: call.callId,
      name: call.name,
      args: call.args,
      operationId: toolOperationId('step-1', call.callId),
      mapOperationId: null,
    })),
  };
  save({
    ...baseState(),
    committedMessages: [entry],
    committedModelSteps: [
      { stepId: 'step-1', entryId: entry.entryId, committedAt: 1, messages: [entry], toolCalls: entry.toolCalls ?? [], usage: null },
    ],
  });
}

function toolMessages(messages: readonly unknown[]): readonly ToolMessage[] {
  return messages.filter((message): message is ToolMessage => message instanceof ToolMessage);
}

/** 真实 store 负责全部权威写入，这个端口只接住 unknown 观测；failure 制造观测写不下来的情形。 */
function observingRecords(failure: string | null) {
  const observations: HistoryToolObservation[] = [];
  return {
    observations,
    records: {
      ...store,
      recordToolObservation: (observation: HistoryToolObservation) => {
        if (failure !== null) {
          return { kind: 'failed' as const, message: failure };
        }
        observations.push(observation);
        return { kind: 'saved' as const };
      },
    },
  };
}

test('模型请求的受控工具被实际执行，配对结果进入后续模型输入与已提交历史', async () => {
  save(baseState());
  const toolFacts = facts();
  const harness = recordingServices(toolFacts);
  const tools = planningToolset(toolFacts, harness.services);
  const args = { ticketId: 'ticket-1', expectedRevision: toolFacts.scopeRevision };
  const model = new FakeToolModel([
    { kind: 'tool_calls', calls: [{ callId: 'call-1', name: 'claim_ticket', args }] },
    { kind: 'text', content: '已认领，准备下一步' },
  ]);

  const result = await runGraph(graphWith({ model, tools }), { remainingWork: work(1).items });

  expect(result.status).toBe('suspended');
  expect(model.received).toHaveLength(2);
  // 工具真的被调用了一次，而且用的是从持久化 call 派生的身份。
  expect(harness.executed).toEqual([
    { name: 'claim_ticket', operationId: 'op:step-1:call-1', mapOperationId: null },
  ]);

  const state = loadState();
  expect(state.committedModelSteps.map((step) => step.toolCalls.length)).toEqual([1, 0]);
  const assistant = state.committedMessages[0];
  expect(assistant).toEqual({
    entryId: 'entry:assistant:step-1',
    stepId: 'step-1',
    role: 'assistant',
    content: '',
    toolCalls: [
      {
        callId: 'call-1',
        name: 'claim_ticket',
        args,
        operationId: 'op:step-1:call-1',
        mapOperationId: null,
        activityKind: 'action',
      },
    ],
  });
  const toolResult = state.committedMessages[1];
  expect(toolResult?.entryId).toBe('entry:tool:step-1:call-1');
  expect(toolResult?.role).toBe('tool');
  expect(toolResult?.toolCallId).toBe('call-1');
  expect(toolResult?.toolName).toBe('claim_ticket');
  expect(toolResult?.content).toContain('"kind":"ok"');

  // 下一次模型输入里出现真正的 ToolMessage，配对身份来自持久化记录而不是推断。
  const second = model.received[1] ?? [];
  const assistantMessage = second.find((message) => message instanceof AIMessage);
  expect(assistantMessage?.tool_calls).toEqual([{ id: 'call-1', name: 'claim_ticket', args, type: 'tool_call' }]);
  const paired = toolMessages(second);
  expect(paired).toHaveLength(1);
  expect(paired[0]?.tool_call_id).toBe('call-1');
  expect(paired[0]?.name).toBe('claim_ticket');
  expect(paired[0]?.content).toContain('"kind":"ok"');

  // 只有没有未决调用的最终响应才消费工作。
  expect(result.remainingWork).toEqual([]);
  expect(result.pendingToolCalls).toBe(0);
});

test('活动分类只由注册定义的 mutating 决定：模型在参数里自称什么都不改变它', async () => {
  save(baseState());
  const toolFacts = facts();
  const harness = recordingServices(toolFacts);
  // 这个工具接受任意参数，因此模型可以在 args 里自称分类；已提交 call 的分类不受影响。
  const probe: PlanningToolDefinition = {
    name: 'probe_tool',
    description: '测试工具：接受任意参数',
    mutating: false,
    inputSchema: { type: 'object' },
    invoke: () => Promise.resolve({ kind: 'ok', value: { ok: true } }),
  };
  const tools = [...planningToolset(toolFacts, harness.services), probe];
  const model = new FakeToolModel([
    { kind: 'tool_calls', calls: [
      { callId: 'call-read', name: 'read_frontier', args: {} },
      { callId: 'call-write', name: 'claim_ticket', args: { ticketId: 'ticket-1', expectedRevision: 7 } },
      { callId: 'call-probe', name: 'probe_tool', args: { activityKind: 'action' } },
    ] },
    { kind: 'text', content: '读过、认领过' },
  ]);

  const result = await runGraph(graphWith({ model, tools }), { remainingWork: work(1).items });

  expect(result.status).toBe('suspended');
  expect(loadState().committedModelSteps[0]?.toolCalls.map((call) => [call.name, call.activityKind])).toEqual([
    ['read_frontier', 'query'],
    ['claim_ticket', 'action'],
    ['probe_tool', 'query'],
  ]);
});

test('已受理的单次工具动作提交完成源并结束本条工作；拒绝不消费', async () => {
  save(baseState());
  const pending = work(2).items;
  const completionTool: PlanningToolDefinition = {
    name: 'request_graph_patch', description: '提交图补丁', mutating: true,
    completesWorkOnSuccess: true, inputSchema: { type: 'object' },
    invoke: () => Promise.resolve({ kind: 'ok', value: { graphVersion: 2 } }),
  };
  const model = new FakeToolModel([{ kind: 'tool_calls', calls: [
    { callId: 'patch-1', name: 'request_graph_patch', args: {} },
  ] }]);
  const result = await runGraph(graphWith({ model, tools: [completionTool] }), { remainingWork: pending });
  expect(result.status).toBe('work_completed');
  expect(result.remainingWork).toEqual(pending.slice(1));
  expect(model.received).toHaveLength(1);
  expect(loadState().committedMessages.at(-1)?.completedWorkSource).toEqual(pending[0]?.source);

  store.close();
  const fresh = openCheckpointStore({ databasePath: join(directory, 'rejected.sqlite') });
  if (fresh.kind !== 'opened') throw new Error(fresh.message);
  store = fresh.store;
  save(baseState());
  seedPendingCalls([{ callId: 'patch-2', name: 'request_graph_patch', args: {} }]);
  const rejected = await createToolsNode({
    sessionRecords: store, assertFencing: () => ({ kind: 'valid', lease: {} as never }),
    tools: [{ ...completionTool, invoke: () => Promise.resolve({ kind: 'rejected', code: 'busy', message: '稍后重试' }) }],
  })(graphState(1));
  expect(rejected.status).toBe('running');
  expect(rejected.remainingWork).toEqual(work(1).items);
  expect(loadState().committedMessages.at(-1)?.completedWorkSource).toBeUndefined();
});

test('ask_user 在没有规划工具的图中恢复原调用，并继续处理下一次提问', async () => {
  const recoveredId = 'ask-recovered';
  seedPendingCalls([{ callId: recoveredId, name: 'ask_user', args: { question: '恢复问题' } }]);
  const calls: { question: unknown; operationId: OperationId }[] = [];
  const ask = userQuestionTool((question, context) => {
    calls.push({ question, operationId: context.operationId });
    return { kind: 'ok', value: { interactionId: context.operationId } };
  });
  const model = new FakeToolModel([
    { kind: 'tool_calls', calls: [{ callId: 'ask-new', name: 'ask_user', args: { question: '新的问题' } }] },
    { kind: 'text', content: '问题已创建' },
  ]);
  const result = await runGraph(graphWith({ model, tools: [], sessionTools: [ask] }), {
    remainingWork: work(1).items, pendingToolCalls: 1,
  });
  expect(result.status).toBe('suspended');
  expect(calls).toEqual([
    { question: { text: '恢复问题', options: [] }, operationId: toolOperationId('step-1', recoveredId) },
    { question: { text: '新的问题', options: [] }, operationId: toolOperationId('step-2', 'ask-new') },
  ]);
  expect(toolMessages(model.received[0] ?? []).map((message) => message.tool_call_id)).toEqual([recoveredId]);
  expect(pendingToolCallsIn(loadState())).toBe(0);
});

test('响应提交后崩溃：恢复沿用原 call 与同一 operationId 补齐结果，且不重复执行已执行的调用', async () => {
  save(baseState());
  const toolFacts = facts();
  const harness = recordingServices(toolFacts);
  const tools = planningToolset(toolFacts, harness.services);
  const model = new FakeToolModel([
    {
      kind: 'tool_calls',
      calls: [
        { callId: 'call-1', name: 'claim_ticket', args: { ticketId: 'ticket-1', expectedRevision: 7 } },
        { callId: 'call-2', name: 'claim_ticket', args: { ticketId: 'ticket-2', expectedRevision: 7 } },
      ],
    },
    { kind: 'text', content: '两个都完成' },
  ]);

  // 崩溃窗口由事实触发：第一个配对结果落盘之后，这个 incarnation 就失去写入权。这样测试不依赖
  // 「fencing 一共被检查了几次」这种实现细节——节点多检查一次或少检查一次，断点都一样。
  const interrupted = graphWith({
    model,
    tools,
    assertFencing: () =>
      loadState().committedMessages.some((entry) => entry.toolCallId === 'call-1')
        ? { kind: 'fenced', code: 'stale_generation' }
        : { kind: 'valid', lease: {} as never },
  });
  const first = await runGraph(interrupted, { remainingWork: work(1).items });

  expect(first.status).toBe('blocked');
  expect(harness.executed.map((call) => call.operationId)).toEqual(['op:step-1:call-1']);
  const crashed = loadState();
  expect(crashed.committedModelSteps).toHaveLength(1);
  expect(crashed.committedMessages.map((entry) => entry.entryId)).toEqual([
    'entry:assistant:step-1',
    'entry:tool:step-1:call-1',
  ]);
  // 宿主重启后据此先跑 tools 节点。
  expect(pendingToolCallsIn(crashed)).toBe(1);

  const resumed = graphWith({ model, tools });
  const second = await runGraph(resumed, { remainingWork: work(1).items, pendingToolCalls: 1 });

  expect(second.status).toBe('suspended');
  // call-1 没有第二次执行：两次记录分别是崩溃前与恢复后的两个不同 call。
  expect(harness.executed).toEqual([
    { name: 'claim_ticket', operationId: 'op:step-1:call-1', mapOperationId: null },
    { name: 'claim_ticket', operationId: 'op:step-1:call-2', mapOperationId: null },
  ]);
  const recovered = loadState();
  expect(recovered.committedMessages.map((entry) => entry.entryId)).toEqual([
    'entry:assistant:step-1',
    'entry:tool:step-1:call-1',
    'entry:tool:step-1:call-2',
    'entry:assistant:step-2',
  ]);
  expect(recovered.committedModelSteps.map((step) => step.stepId)).toEqual(['step-1', 'step-2']);
  expect(pendingToolCallsIn(recovered)).toBe(0);
  // 恢复时模型看到的是两个已配对的结果。
  const finalInput = model.received[1] ?? [];
  expect(toolMessages(finalInput).map((message) => message.tool_call_id)).toEqual(['call-1', 'call-2']);
});

test('连续 100 个互不相同的受控调用完整执行，工作只被最终响应消费一次', async () => {
  save(baseState());
  const toolFacts = facts();
  const harness = recordingServices(toolFacts);
  const tools = planningToolset(toolFacts, harness.services);
  const turns: FakeToolModelTurn[] = Array.from({ length: 100 }, (_value, index) => ({
    kind: 'tool_calls' as const,
    calls: [
      {
        callId: `call-${String(index)}`,
        name: 'claim_ticket' as const,
        args: { ticketId: `ticket-${String(index)}`, expectedRevision: toolFacts.scopeRevision },
      },
    ],
  }));
  turns.push({ kind: 'text', content: '第一条完成' }, { kind: 'text', content: '第二条完成' });
  const model = new FakeToolModel(turns);
  const seenWork: (string | null)[] = [];

  const result = await runGraph(graphWith({ model, tools, seenWork }), { remainingWork: work(2).items });

  expect(result.status).toBe('suspended');
  expect(result.pendingToolCalls).toBe(0);
  expect(result.remainingWork).toEqual([]);
  expect(harness.executed).toHaveLength(100);
  expect(new Set(harness.executed.map((call) => call.operationId)).size).toBe(100);
  const state = loadState();
  expect(state.committedModelSteps).toHaveLength(102);
  expect(state.committedMessages.filter((entry) => entry.role === 'tool')).toHaveLength(100);
  // 100 次工具回合都没有消费 Actionable Work：前 101 次模型调用问的都是同一条工作，只有最终响应
  // 才消费它，随后才轮到第二条。
  expect(seenWork.filter((sourceId) => sourceId === 'dispatch-0')).toHaveLength(101);
  expect(seenWork.filter((sourceId) => sourceId === 'dispatch-1')).toHaveLength(1);
  expect(toolMessages(model.received[100] ?? [])).toHaveLength(100);
});

test('未注册的已提交 call 停止执行，保留原身份等待核验', async () => {
  seedPendingCalls([{ callId: 'call-1', name: 'ghost_tool', args: {} }]);
  const toolFacts = facts();
  const harness = recordingServices(toolFacts);
  const tools = planningToolset(toolFacts, harness.services);
  const model = new FakeToolModel([{ kind: 'text', content: '不应调用' }]);

  const result = await runGraph(graphWith({ model, tools }), {
    remainingWork: work(1).items,
    pendingToolCalls: pendingToolCallsIn(loadState()),
  });

  expect(result.status).toBe('blocked');
  expect(harness.executed).toEqual([]);
  const entry = loadState().committedMessages.find((candidate) => candidate.role === 'tool');
  expect(entry).toBeUndefined();
  expect(pendingToolCallsIn(loadState())).toBe(1);
  expect(model.received).toEqual([]);
});

test('未注册的 call 留下绑定原身份的 unknown 观测，权威历史仍是不完整配对', async () => {
  seedPendingCalls([{ callId: 'call-1', name: 'ghost_tool', args: {} }]);
  const { observations, records } = observingRecords(null);
  const node = createToolsNode({
    sessionRecords: records,
    assertFencing: () => ({ kind: 'valid', lease: {} as never }),
    tools: [],
  });

  const update = await node(graphState(1));

  expect(update.status).toBe('blocked');
  expect(update.note).toContain('ghost_tool(call-1)');
  // 观测绑定原 assistant entry 与原 OperationId：它是这次结果的记录，不是新的一次尝试。
  expect(observations).toHaveLength(1);
  expect(observations[0]).toMatchObject({
    coordinatorSessionId: SESSION,
    entryId: 'entry:assistant:step-1',
    stepId: 'step-1',
    callId: 'call-1',
    operationId: 'op:step-1:call-1',
    kind: 'unknown',
  });
  expect(observations[0]?.reason).toContain('ghost_tool');
  // 观测不冒充结果：没有配对的 tool 条目，调用仍待原 OperationId 对账。
  const state = loadState();
  expect(state.committedMessages.filter((entry) => entry.role === 'tool')).toEqual([]);
  expect(state.committedMessages.map((entry) => entry.entryId)).toEqual(['entry:assistant:step-1']);
  expect(pendingToolCallsIn(state)).toBe(1);
});

test('unknown 观测写不下来时 fail closed：按写不成功阻塞，且不补配对结果', async () => {
  seedPendingCalls([{ callId: 'call-1', name: 'claim_ticket', args: { ticketId: 'ticket-1', expectedRevision: 7 } }]);
  const toolFacts = facts();
  const harness = recordingServices(toolFacts, { kind: 'unknown', reason: 'tracker 丢响应' });
  const { observations, records } = observingRecords('checkpoint 只读');
  const node = createToolsNode({
    sessionRecords: records,
    assertFencing: () => ({ kind: 'valid', lease: {} as never }),
    tools: planningToolset(toolFacts, harness.services),
  });

  const update = await node(graphState(1));

  expect(update.status).toBe('blocked');
  expect(update.note).toContain('call-1');
  expect(observations).toEqual([]);
  expect(loadState().committedMessages.filter((entry) => entry.role === 'tool')).toEqual([]);
  expect(pendingToolCallsIn(loadState())).toBe(1);
});

test('unknown 停止后续调用；恢复先用原 OperationId 对账，再处理剩余 call', async () => {
  seedPendingCalls([
    { callId: 'call-1', name: 'claim_ticket', args: { ticketId: 'ticket-1', expectedRevision: 7 } },
    { callId: 'call-2', name: 'claim_ticket', args: { ticketId: 'ticket-2', expectedRevision: 7 } },
  ]);
  const toolFacts = facts();
  const harness = recordingServices(toolFacts, { kind: 'unknown', reason: 'tracker 丢响应' });
  const node = createToolsNode({
    sessionRecords: store,
    assertFencing: () => ({ kind: 'valid', lease: {} as never }),
    tools: planningToolset(toolFacts, harness.services),
  });

  const update = await node(graphState(2));

  expect(update.status).toBe('blocked');
  expect(JSON.stringify(update.note)).toContain('tracker 丢响应');
  expect(harness.executed.map((call) => call.operationId)).toEqual(['op:step-1:call-1']);
  expect(pendingToolCallsIn(loadState())).toBe(2);
  expect(loadState().committedMessages.filter((entry) => entry.role === 'tool')).toEqual([]);

  const resumedServices = recordingServices(facts(0)).services;
  const resumed = createToolsNode({
    sessionRecords: store,
    assertFencing: () => ({ kind: 'valid', lease: {} as never }),
    tools: planningToolset(toolFacts, {
      ...resumedServices,
      readFacts: () => facts(0),
      replayMutation: (operationId) => operationId === 'op:step-1:call-1' ? accepted() : null,
    }),
  });
  const result = await resumed(graphState(2));
  expect(result.status).toBe('running');
  expect(pendingToolCallsIn(loadState())).toBe(0);
  expect(harness.executed).toHaveLength(1);
  expect(loadState().committedMessages.find((entry) => entry.toolCallId === 'call-1')?.content).toContain('"kind":"ok"');
  expect(loadState().committedMessages.find((entry) => entry.toolCallId === 'call-2')?.content).toContain('budget_exhausted');
});

test('工具调用期间失去 lease 时不写配对结果，保留原 call 供新 incarnation 对账', async () => {
  seedPendingCalls([{ callId: 'call-1', name: 'claim_ticket', args: { ticketId: 'ticket-1', expectedRevision: 7 } }]);
  const toolFacts = facts();
  const harness = recordingServices(toolFacts);
  let checks = 0;
  const node = createToolsNode({
    sessionRecords: store,
    assertFencing: () => ++checks === 1
      ? { kind: 'valid', lease: {} as never }
      : { kind: 'fenced', code: 'stale_generation' },
    tools: planningToolset(toolFacts, harness.services),
  });

  const result = await node(graphState(1));
  expect(result.status).toBe('blocked');
  expect(harness.executed).toHaveLength(1);
  expect(loadState().committedMessages.filter((entry) => entry.role === 'tool')).toEqual([]);
  expect(pendingToolCallsIn(loadState())).toBe(1);
});

test('无法受控执行的 tool call 先提交响应，再以 blocked 结束并说明原因', async () => {
  const scenarios: readonly { readonly label: string; readonly raw: Record<string, unknown>; readonly reason: string }[] =
    [
      { label: '未注册的工具名', raw: { id: 'call-1', name: 'delete_everything', args: {} }, reason: '未注册的工具' },
      { label: '缺少 callId', raw: { name: 'claim_ticket', args: {} }, reason: '缺少非空 callId' },
      { label: 'args 不是对象', raw: { id: 'call-1', name: 'claim_ticket', args: 'oops' }, reason: 'args 不是对象' },
    ];

  for (const [index, scenario] of scenarios.entries()) {
    store.close();
    const fresh = openCheckpointStore({ databasePath: join(directory, `invalid-${index}.sqlite`) });
    if (fresh.kind !== 'opened') throw new Error(fresh.message);
    store = fresh.store;
    save(baseState());
    const toolFacts = facts();
    const harness = recordingServices(toolFacts);
    const tools = planningToolset(toolFacts, harness.services);
    const model = new ScriptedStreamingChatModel([
      { kind: 'raw_tool_calls', content: `想执行 ${scenario.label}`, toolCalls: [scenario.raw] },
    ]);

    const result = await runGraph(graphWith({ model, tools }), {
      remainingWork: work(1).items,
      thread: `thread-invalid-${String(index)}`,
    });

    expect(result.status).toBe('blocked');
    expect(result.note).toContain('无法受控执行');
    expect(result.note).toContain(scenario.reason);
    expect(harness.executed).toEqual([]);
    const state = loadState();
    // 响应本身是完整的，因此它进入历史；被拒绝的是「执行」，不是「提交」。
    expect(state.committedModelSteps).toHaveLength(1);
    expect(state.committedModelSteps[0]?.toolCalls).toEqual([]);
    expect(state.committedMessages).toEqual([
      {
        entryId: 'entry:assistant:step-1',
        stepId: 'step-1',
        role: 'assistant',
        content: `想执行 ${scenario.label}`,
      },
    ]);
  }
});

test('路由：有未决 tool call 时（含重启后的第一次 invoke）先进 tools 节点', () => {
  const pending: CoordinatorGraphState = {
    coordinatorSessionId: SESSION,
    graphPosition: 'model',
    status: 'running',
    remainingWork: work(1).items,
    deferredWork: 0,
    pendingToolCalls: 2,
    note: '',
  };
  expect(routeAtStart(pending)).toBe(TOOLS_NODE);
  expect(routeAfterModel(pending)).toBe(TOOLS_NODE);
  expect(routeAfterTools(pending)).toBe(MODEL_NODE);

  const done: CoordinatorGraphState = { ...pending, pendingToolCalls: 0 };
  expect(routeAtStart(done)).toBe(MODEL_NODE);
  expect(routeAfterModel(done)).toBe(MODEL_NODE);
  // fenced 的 tools 节点以 blocked 结束：不得再回到模型，也不得挂起。
  expect(routeAfterTools({ ...done, status: 'blocked' })).toBe('__end__');
});

test('工具执行期间受理的新用户消息不被旧快照覆盖，且未完成的工作保持待处理', async () => {
  save(baseState());
  seedPendingCalls([{ callId: 'call-1', name: 'claim_ticket', args: { ticketId: 'ticket-1' } }]);
  const busyBatch: WakeBatch = {
    wakeBatchId: 'wake:user:submission-busy',
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION,
    sourceRevisions: [{ sourceKind: 'user-message', sourceId: 'submission-busy', revision: 1 }],
    actionableWork: [{ workKind: 'user_message', workId: 'submission-busy', summary: 'B' }],
  };
  // 这个工具在「执行中」模拟另一路受理了一条新用户消息（busy B）。
  const concurrentTool: PlanningToolDefinition = {
    name: 'claim_ticket',
    description: '测试工具：执行期间受理一条新用户消息',
    mutating: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    invoke: () => {
      const committed = store.commitUserMessage({
        coordinatorSessionId: SESSION,
        submissionId: 'submission-busy',
        content: '等待期间的新消息 B',
        wakeBatch: busyBatch,
      });
      if (committed.kind !== 'committed') {
        throw new Error(`busy B 未能落盘：${committed.kind}`);
      }
      return Promise.resolve({ kind: 'ok', value: accepted() });
    },
  };

  const node = createToolsNode({
    sessionRecords: store,
    assertFencing: () => ({ kind: 'valid', lease: {} as never }),
    tools: [concurrentTool],
  });
  const update = await node(graphState(1));

  expect(update.status).toBe('running');
  const state = loadState();
  // busy B 仍在已提交历史里：工具的写入基于最新状态，没有把新消息覆盖掉。
  expect(state.committedMessages.some((entry) => entry.entryId === userEntryId('submission-busy'))).toBe(
    true,
  );
  expect(state.committedMessages.find((entry) => entry.toolCallId === 'call-1')?.content).toContain(
    '"kind":"ok"',
  );
  // 该工具不完成当前工作：原 Actionable Work 保持待处理，后续轮次再消费。
  expect(update.remainingWork).toEqual(work(1).items);
});

test('tool call 参数跨多个 chunk 到达时，身份只来自完整响应，chunk 与预览都不参与执行', async () => {
  save(baseState());
  const toolFacts = facts();
  const harness = recordingServices(toolFacts);
  const tools = planningToolset(toolFacts, harness.services);
  const args = { ticketId: 'ticket-split', expectedRevision: toolFacts.scopeRevision };
  const model = new ScriptedStreamingChatModel([
    { kind: 'tool_calls', calls: [{ callId: 'call-split', name: 'claim_ticket', args }], splitArgs: true },
    { kind: 'text', text: '参数是分片到达的', chunkSize: 4 },
  ]);
  const previews: TranscriptStreamEvent[] = [];
  const graph = graphWith({ model, tools, streamObserver: (event) => previews.push(event) });

  const result = await runGraph(graph, { remainingWork: work(1).items });

  expect(result.status).toBe('suspended');
  // 响应确实被切成多段下发：每个参数片段都是一个独立 chunk。
  expect(model.producedChunks).toBeGreaterThan(3);
  // 工具只被执行一次，且用的是完整响应聚合后派生的可信身份。
  expect(harness.executed).toEqual([
    { name: 'claim_ticket', operationId: 'op:step-1:call-split', mapOperationId: null },
  ]);
  const state = loadState();
  expect(state.committedMessages[0]).toEqual({
    entryId: 'entry:assistant:step-1',
    stepId: 'step-1',
    role: 'assistant',
    content: '',
    toolCalls: [
      {
        callId: 'call-split',
        name: 'claim_ticket',
        args,
        operationId: 'op:step-1:call-split',
        mapOperationId: null,
        activityKind: 'action',
      },
    ],
  });
  expect(state.committedMessages[1]?.toolCallId).toBe('call-split');
  // 工具参数 chunk 不含可见文本，因此预览对这次调用没有可显示内容——但工具照常被正确执行。
  expect(previews.filter((event) => event.kind === 'delta' && event.previewId === 'preview:step-1:attempt-1')).toEqual([]);
  expect(previews.find((event) => event.kind === 'committed')).toMatchObject({
    kind: 'committed',
    previewId: 'preview:step-1:attempt-1',
    entryId: 'entry:assistant:step-1',
  });
});

test('分片工具参数在输出预算里只计一次：原始片段与解析结果不会把同一份参数算两次', async () => {
  save(baseState());
  const toolFacts = facts();
  const harness = recordingServices(toolFacts);
  const tools = planningToolset(toolFacts, harness.services);
  // args 足够大：一旦被计两次就越限，被计一次刚好装得下，因此这个预算是行为事实而不是实现细节。
  const args = { ticketId: `ticket-${'x'.repeat(2048)}`, expectedRevision: toolFacts.scopeRevision };
  const argBytes = Buffer.byteLength(JSON.stringify(args), 'utf8');
  const model = new ScriptedStreamingChatModel([
    { kind: 'tool_calls', calls: [{ callId: 'call-big', name: 'claim_ticket', args }], splitArgs: true },
    { kind: 'text', text: '参数刚好装得下' },
  ]);
  const events: TranscriptStreamEvent[] = [];

  const result = await runGraph(
    graphWith({ model, tools, maxResponseBytes: argBytes, streamObserver: (event) => events.push(event) }),
    { remainingWork: work(1).items },
  );

  expect(result.status).toBe('suspended');
  expect(events.some((event) => event.kind === 'interrupted')).toBe(false);
  expect(harness.executed).toEqual([
    { name: 'claim_ticket', operationId: 'op:step-1:call-big', mapOperationId: null },
  ]);
  expect(loadState().committedMessages[0]?.toolCalls).toEqual([
    {
      callId: 'call-big',
      name: 'claim_ticket',
      args,
      operationId: 'op:step-1:call-big',
      mapOperationId: null,
      activityKind: 'action',
    },
  ]);
});
