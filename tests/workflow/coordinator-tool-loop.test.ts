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
import type { FencingAssertion } from '../../src/application/coordinator/runtime-guard.js';
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
  type CommittedMessageEntry,
  type CoordinatorSessionState,
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
import { FakeToolModel, type FakeToolModelTurn } from '../support/fake-tool-model.js';

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
  readonly assertFencing?: () => FencingAssertion;
  readonly seenWork?: (string | null)[];
}) {
  // step 身份必须跨重启唯一：entry 与 operation 身份都由它派生，重启后重号会与已提交历史冲突。
  const read = store.loadCheckpoint(SESSION);
  let step = read.kind === 'recovered' ? read.state.committedModelSteps.length : 0;
  return buildCoordinatorGraph({
    model: input.model as never,
    checkpointer: store.checkpointer,
    sessionRecords: store,
    planningTools: input.tools,
    assertFencing: input.assertFencing ?? (() => ({ kind: 'valid', lease: {} as never })),
    newStepId: () => `step-${String((step += 1))}`,
    sleep: () => Promise.resolve(),
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
    toolCalls: [{ callId: 'call-1', name: 'claim_ticket', args, operationId: 'op:step-1:call-1', mapOperationId: null }],
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

  // 前四次 fencing 检查有效（模型调用前、提交响应前、第一个 call 执行前及结果落盘前），随后进程中断。
  let checks = 0;
  const interrupted = graphWith({
    model,
    tools,
    assertFencing: () =>
      (checks += 1) <= 4 ? { kind: 'valid', lease: {} as never } : { kind: 'fenced', code: 'stale_generation' },
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
    save(baseState());
    const toolFacts = facts();
    const harness = recordingServices(toolFacts);
    const tools = planningToolset(toolFacts, harness.services);
    const model = {
      invoke: () =>
        Promise.resolve({ role: 'assistant', content: `想执行 ${scenario.label}`, tool_calls: [scenario.raw] }),
    };

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
