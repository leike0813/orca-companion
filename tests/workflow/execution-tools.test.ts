/**
 * IP-03：执行态受控工具集的暴露与调用期重验测试
 * （change: `m2-wire-execution-runtime`，Owner: IP-03）。
 *
 * 覆盖三件事：
 * - 工具按模式暴露：非 `execution_coordination` 模式没有任何执行工具，`route_planning` 模式因此也
 *   拿不到 `advance_execution` 与 `request_graph_patch`；
 * - handler 每次调用都重验模式、Scope/Session 身份、控制状态、Execution Lease、授权、写权限、预算与
 *   revision，模型填不出身份也绕不过准入；
 * - 图挂载与恢复执行：已提交的 `advance_execution` 调用由受控 tools 节点按持久化身份执行一次，结果
 *   逐 call 落盘（与规划工具同一协议）。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HumanMessage } from '@langchain/core/messages';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { projectActionableWork, type SourceObservation } from '../../src/application/coordinator/actionable-work.js';
import type { FencingAssertion } from '../../src/application/coordinator/runtime-guard.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  OperationId,
  WorkPackageId,
} from '../../src/application/dto/identity.js';
import { openCheckpointStore, type CheckpointStore } from '../../src/adapters/storage/checkpoint-store.js';
import {
  COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
  toolResultEntryId,
  type CoordinatorSessionState,
} from '../../src/domain/coordinator/session-state.js';
import { buildCoordinatorGraph } from '../../src/workflow/coordinator/graph.js';
import { COORDINATOR_INVOKE_DEFAULTS } from '../../src/workflow/coordinator/state.js';
import {
  EXECUTION_TOOL_NAMES,
  executionToolset,
  executionToolsForMode,
  isExecutionToolName,
  type ExecutionToolFacts,
  type ExecutionToolOutcome,
  type ExecutionToolServices,
} from '../../src/workflow/coordinator/execution-tools.js';
import { PLANNING_TOOL_NAMES } from '../../src/workflow/coordinator/planning-tools.js';
import type { GraphChangeRequest } from '../../src/domain/execution/change-routing.js';
import { FakeToolModel } from '../support/fake-tool-model.js';

const SCOPE = 'scope-execution-tools' as CoordinationScopeId;
const SESSION = 'session-a' as CoordinatorSessionId;

/** 宿主在提交模型响应时分配的可信身份；工具 handler 只能转发它，模型不能填写。 */
const CALL_CONTEXT = {
  operationId: 'op:step-1:call-1' as OperationId,
  mapOperationId: null,
};

function baseFacts(overrides: Partial<ExecutionToolFacts> = {}): ExecutionToolFacts {
  return {
    mode: 'execution_coordination',
    controlState: 'active',
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION,
    scopeRevision: 7,
    planningResponsible: true,
    authorization: { authorizationId: 'auth-1', authorizationVersion: 1 },
    executionLeaseHeld: true,
    permissions: { allowExecutionWrites: true },
    budget: { remainingMutations: 3 },
    ...overrides,
  };
}

type Forwarded = {
  readonly name: string;
  readonly operationId: OperationId;
  readonly plan?: unknown;
  readonly request?: GraphChangeRequest;
};

function fakeServices(facts: ExecutionToolFacts) {
  const calls = { readExecutionStatus: 0, advanceExecution: 0, requestGraphPatch: 0, proposeExecutionGraph: 0 };
  const forwarded: Forwarded[] = [];
  let current = facts;
  const services: ExecutionToolServices = {
    readFacts: () => current,
    readExecutionStatus: () => {
      calls.readExecutionStatus += 1;
      return Promise.resolve({
        kind: 'ok',
        value: { generation: 1, frontier: [], workers: [], blockers: [] },
      } as ExecutionToolOutcome);
    },
    advanceExecution: (input) => {
      calls.advanceExecution += 1;
      forwarded.push({ name: 'advance_execution', operationId: input.operationId });
      return Promise.resolve({
        kind: 'ok',
        value: { kind: 'idle', reason: '测试用例不推进', blockers: [] },
      } as ExecutionToolOutcome);
    },
    proposeExecutionGraph: (input) => {
      calls.proposeExecutionGraph += 1;
      forwarded.push({ name: 'propose_execution_graph', operationId: input.operationId, plan: input.plan });
      return Promise.resolve({ kind: 'ok', value: { graphId: 'graph-2' } } as ExecutionToolOutcome);
    },
    requestGraphPatch: (input) => {
      calls.requestGraphPatch += 1;
      forwarded.push({ name: 'request_graph_patch', operationId: input.operationId, request: input.request });
      return Promise.resolve({ kind: 'ok', value: { kind: 'routed', route: 'graph_patch' } } as ExecutionToolOutcome);
    },
  };
  return {
    calls,
    forwarded,
    services,
    setFacts: (next: ExecutionToolFacts) => {
      current = next;
    },
  };
}

function toolNames(facts: ExecutionToolFacts): readonly string[] {
  return executionToolset(facts, fakeServices(facts).services).map((definition) => definition.name);
}

async function invoke(
  facts: ExecutionToolFacts,
  name: (typeof EXECUTION_TOOL_NAMES)[number],
  input: Record<string, unknown>,
  configure?: (harness: ReturnType<typeof fakeServices>) => void,
): Promise<{ readonly outcome: ExecutionToolOutcome; readonly harness: ReturnType<typeof fakeServices> }> {
  const harness = fakeServices(facts);
  // 工具在「被创建时的事实」下组装；`configure` 之后才调用，因此可以观察调用期的事实变化。
  const definition = executionToolset(facts, harness.services).find((candidate) => candidate.name === name);
  if (definition === undefined) {
    throw new Error(`工具 ${name} 在当前事实下不可见`);
  }
  configure?.(harness);
  return { outcome: await definition.invoke(input, CALL_CONTEXT), harness };
}

/** 一个完整的九字段变化声明；测试只改其中一两个字段来观察行为的差别。 */
function changeRequest(overrides: Partial<GraphChangeRequest> = {}): GraphChangeRequest {
  return {
    workPackageId: 'wp-a' as WorkPackageId,
    infrastructureFailure: 'no',
    changesDependencies: 'yes',
    changesScopeEnvelope: 'no',
    changesObjective: 'no',
    contractContentOnly: 'no',
    goalOrGlobalConstraintChanged: 'no',
    userRequestedReplanning: 'no',
    requiresUserChoice: 'no',
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* 暴露                                                                        */
/* -------------------------------------------------------------------------- */

test('规划模式暴露候选图工具，执行模式暴露状态与推进工具', () => {
  expect(toolNames(baseFacts())).toEqual([
    'read_execution_status',
    'advance_execution',
    'request_graph_patch',
  ]);
  // 暂停、缺授权或预算耗尽都不改变可见性：可见性与事实解耦，准入在每次调用时判定。
  for (const facts of [
    baseFacts({ controlState: 'paused' }),
    baseFacts({ executionLeaseHeld: false }),
    baseFacts({ authorization: { authorizationId: null, authorizationVersion: null } }),
    baseFacts({ permissions: { allowExecutionWrites: false } }),
    baseFacts({ budget: { remainingMutations: 0 } }),
  ]) {
    expect(toolNames(facts)).toEqual(['read_execution_status', 'advance_execution', 'request_graph_patch']);
  }
  expect(toolNames(baseFacts({ mode: 'route_planning' }))).toEqual(['propose_execution_graph']);
  expect(executionToolsForMode({ mode: 'route_planning', facts: baseFacts(), services: fakeServices(baseFacts()).services }).map((definition) => definition.name)).toEqual(['propose_execution_graph']);
  expect(
    executionToolsForMode({
      mode: 'execution_coordination',
      facts: baseFacts(),
      services: fakeServices(baseFacts()).services,
    }).map((definition) => definition.name),
  ).toEqual(['read_execution_status', 'advance_execution', 'request_graph_patch']);
  expect(isExecutionToolName('advance_execution')).toBe(true);
  expect(isExecutionToolName('request_graph_patch')).toBe(true);
  expect(isExecutionToolName('update_route_map_section')).toBe(false);
});

test('执行工具与规划工具同形，且身份不进入输入 schema', () => {
  const facts = baseFacts();
  const execution = executionToolset(facts, fakeServices(facts).services);
  const executionNames = execution.map((definition) => definition.name);

  for (const definition of execution) {
    expect(definition.description.length).toBeGreaterThan(0);
    expect(definition.inputSchema['type']).toBe('object');
    expect(definition.inputSchema['additionalProperties']).toBe(false);
    const properties = definition.inputSchema['properties'] as Record<string, unknown>;
    // 身份来自持久化 call，模型填不出，也不该看到这个字段。
    expect(Object.keys(properties)).not.toContain('operationId');
  }
  // 两个族的名字不相交：注册表可以安全地取并集。
  for (const name of executionNames) {
    expect(PLANNING_TOOL_NAMES as readonly string[]).not.toContain(name);
  }
  const byName = new Map([...execution, ...executionToolset(baseFacts({ mode: 'route_planning' }), fakeServices(baseFacts()).services)].map((definition) => [definition.name, definition] as const));
  expect(byName.get('read_execution_status')?.mutating).toBe(false);
  expect(byName.get('advance_execution')?.mutating).toBe(true);
  expect(byName.get('request_graph_patch')?.mutating).toBe(true);
  expect(byName.get('propose_execution_graph')?.mutating).toBe(true);
  expect(byName.get('advance_execution')?.inputSchema['required']).toEqual([]);
  expect(byName.get('request_graph_patch')?.inputSchema['required']).toEqual(['request']);
  expect(byName.get('propose_execution_graph')?.inputSchema['required']).toEqual(['plan']);
});

/* -------------------------------------------------------------------------- */
/* 准入重验                                                                    */
/* -------------------------------------------------------------------------- */

test('只读工具在暂停时仍可用，且不消耗写入预算', async () => {
  const { outcome, harness } = await invoke(
    baseFacts({ controlState: 'paused', budget: { remainingMutations: 0 } }),
    'read_execution_status',
    {},
  );
  expect(outcome.kind).toBe('ok');
  expect(harness.calls.readExecutionStatus).toBe(1);
});

test('受控工具每次调用都重验模式、控制状态、租约、权限、预算与授权', async () => {
  const scenarios: readonly {
    readonly facts: Partial<ExecutionToolFacts>;
    readonly code: string;
  }[] = [
    { facts: { controlState: 'paused' }, code: 'control_state' },
    { facts: { controlState: 'cancelling' }, code: 'control_state' },
    { facts: { executionLeaseHeld: false }, code: 'not_lease_holder' },
    { facts: { permissions: { allowExecutionWrites: false } }, code: 'not_permitted' },
    { facts: { budget: { remainingMutations: 0 } }, code: 'budget_exhausted' },
    { facts: { authorization: { authorizationId: null, authorizationVersion: null } }, code: 'authorization_missing' },
  ];

  for (const scenario of scenarios) {
    const { outcome, harness } = await invoke(
      baseFacts(scenario.facts),
      'advance_execution',
      {},
    );
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') {
      expect(outcome.code).toBe(scenario.code);
    }
    // 准入失败不触达执行驱动。
    expect(harness.forwarded).toHaveLength(0);
    expect(harness.calls.advanceExecution).toBe(0);
  }
});

test('调用时的身份与模式变化会被拒绝，且不触达用例', async () => {
  const mismatch = await invoke(baseFacts(), 'advance_execution', {}, (harness) => {
    harness.setFacts(baseFacts({ coordinatorSessionId: 'session-b' as CoordinatorSessionId }));
  });
  expect(mismatch.outcome.kind).toBe('rejected');
  if (mismatch.outcome.kind === 'rejected') {
    expect(mismatch.outcome.code).toBe('scope_mismatch');
  }

  const modeChanged = await invoke(baseFacts({ mode: 'route_planning' }), 'propose_execution_graph', {
    plan: { planRevision: 1, workPackages: [] },
  }, (harness) => {
    harness.setFacts(baseFacts({ mode: 'execution_coordination' }));
  });
  expect(modeChanged.outcome.kind).toBe('rejected');
  if (modeChanged.outcome.kind === 'rejected') {
    expect(modeChanged.outcome.code).toBe('wrong_mode');
  }
});

test('advance_execution 只转发持久化 call 的身份，模型输入填不出身份', async () => {
  const { outcome, harness } = await invoke(baseFacts(), 'advance_execution', {
    operationId: 'model-supplied',
  });
  expect(outcome.kind).toBe('ok');
  expect(harness.forwarded).toEqual([{ name: 'advance_execution', operationId: CALL_CONTEXT.operationId }]);
  expect(harness.calls.advanceExecution).toBe(1);
});

test('advance_execution 由宿主读取 revision，模型无需填写', async () => {
  const { outcome, harness } = await invoke(baseFacts(), 'advance_execution', {});
  expect(outcome.kind).toBe('ok');
  expect(harness.calls.advanceExecution).toBe(1);
});

test('propose_execution_graph 只做 schema 与准入，编译交给宿主回调', async () => {
  const plan = { planRevision: 1, workPackages: [{ key: 'wp-a' }] };
  const accepted = await invoke(baseFacts({ mode: 'route_planning' }), 'propose_execution_graph', { plan });
  expect(accepted.outcome.kind).toBe('ok');
  expect(accepted.harness.forwarded).toEqual([
    { name: 'propose_execution_graph', operationId: CALL_CONTEXT.operationId, plan },
  ]);

  const notAnObject = await invoke(baseFacts({ mode: 'route_planning' }), 'propose_execution_graph', { plan: '整体计划', expectedRevision: 7 });
  expect(notAnObject.outcome.kind).toBe('rejected');
  if (notAnObject.outcome.kind === 'rejected') {
    expect(notAnObject.outcome.code).toBe('invalid_argument');
  }
  expect(notAnObject.harness.calls.proposeExecutionGraph).toBe(0);
});

/* -------------------------------------------------------------------------- */
/* 图变化请求                                                                  */
/* -------------------------------------------------------------------------- */

test('request_graph_patch 重验写入准入，但不以 advance 预算拒绝对图变化的请求', async () => {
  const scenarios: readonly {
    readonly facts: Partial<ExecutionToolFacts>;
    readonly code: string;
  }[] = [
    { facts: { controlState: 'paused' }, code: 'control_state' },
    { facts: { executionLeaseHeld: false }, code: 'not_lease_holder' },
    { facts: { permissions: { allowExecutionWrites: false } }, code: 'not_permitted' },
    { facts: { authorization: { authorizationId: null, authorizationVersion: null } }, code: 'authorization_missing' },
  ];

  for (const scenario of scenarios) {
    const { outcome, harness } = await invoke(baseFacts(scenario.facts), 'request_graph_patch', {
      request: changeRequest(),
    });
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') {
      expect(outcome.code).toBe(scenario.code);
    }
    expect(harness.forwarded).toHaveLength(0);
  }

  // 全部 Work Package 验收后推进预算归零，但图变化请求仍可能合法：图修订额度由应用用例判定。
  const noAdvanceBudget = await invoke(
    baseFacts({ budget: { remainingMutations: 0 } }),
    'request_graph_patch',
    { request: changeRequest() },
  );
  expect(noAdvanceBudget.outcome.kind).toBe('ok');
  expect(noAdvanceBudget.harness.calls.requestGraphPatch).toBe(1);

  // 而 advance_execution 在同一事实下仍然被预算挡住。
  const advance = await invoke(baseFacts({ budget: { remainingMutations: 0 } }), 'advance_execution', {});
  expect(advance.outcome.kind).toBe('rejected');
  if (advance.outcome.kind === 'rejected') {
    expect(advance.outcome.code).toBe('budget_exhausted');
  }
});

test('request_graph_patch 只转发持久化 call 身份与九个声明字段', async () => {
  const request = changeRequest({ workPackageId: null, changesObjective: 'unknown' });
  const { outcome, harness } = await invoke(baseFacts(), 'request_graph_patch', {
    request,
    operationId: 'model-supplied',
    baseGraphVersion: 99,
    patchId: 'model-supplied',
  });
  expect(outcome.kind).toBe('ok');
  expect(harness.forwarded).toEqual([
    { name: 'request_graph_patch', operationId: CALL_CONTEXT.operationId, request },
  ]);
});

test('request_graph_patch 拒绝不完整或越界的变化声明，且不触达用例', async () => {
  const invalid: readonly unknown[] = [
    '整体变化',
    null,
    [],
    {}, // 缺字段
    { ...changeRequest(), extra: 'yes' }, // 未登记字段
    { ...changeRequest(), workPackageId: '' },
    { ...changeRequest(), workPackageId: 7 },
    { ...changeRequest(), changesDependencies: 'maybe' },
    { ...changeRequest(), changesObjective: true },
  ];

  for (const request of invalid) {
    const { outcome, harness } = await invoke(baseFacts(), 'request_graph_patch', { request });
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') {
      expect(outcome.code).toBe('invalid_argument');
    }
    expect(harness.calls.requestGraphPatch).toBe(0);
  }

  const missingRequest = await invoke(baseFacts(), 'request_graph_patch', {});
  expect(missingRequest.outcome.kind).toBe('rejected');
  expect(missingRequest.harness.calls.requestGraphPatch).toBe(0);
});

test('request_graph_patch 的 schema 只暴露九个声明字段，不含图身份', () => {
  const facts = baseFacts();
  const definition = executionToolset(facts, fakeServices(facts).services).find(
    (candidate) => candidate.name === 'request_graph_patch',
  );
  expect(definition).toBeDefined();
  const properties = definition?.inputSchema['properties'] as Record<string, unknown>;
  expect(Object.keys(properties)).toEqual(['request']);
  const request = properties['request'] as Record<string, unknown>;
  expect(request['additionalProperties']).toBe(false);
  const requestFields = Object.keys(request['properties'] as Record<string, unknown>);
  expect(requestFields).toEqual([
    'workPackageId',
    'infrastructureFailure',
    'changesDependencies',
    'changesScopeEnvelope',
    'changesObjective',
    'contractContentOnly',
    'goalOrGlobalConstraintChanged',
    'userRequestedReplanning',
    'requiresUserChoice',
  ]);
  for (const forbidden of ['operationId', 'graphId', 'graphVersion', 'baseGraphVersion', 'patchId', 'coordinationScopeId']) {
    expect(requestFields).not.toContain(forbidden);
  }
});

/* -------------------------------------------------------------------------- */
/* 图挂载与已提交调用恢复                                                      */
/* -------------------------------------------------------------------------- */

let directory = '';
let checkpointStore: CheckpointStore;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-execution-tools-'));
  const opened = openCheckpointStore({ databasePath: join(directory, 'checkpoints.sqlite') });
  if (opened.kind !== 'opened') {
    throw new Error(opened.message);
  }
  checkpointStore = opened.store;
});

afterEach(() => {
  checkpointStore.close();
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

/** 一条有界 Actionable Work：没有它，本次 invoke 会直接挂起，不会走到模型与 tools 节点。 */
function actionableWork() {
  const observations: SourceObservation[] = [
    {
      source: { sourceKind: 'delivery', sourceId: 'dispatch-1', revision: 1 },
      classification: 'worker_question',
      summary: '推进一个阶段',
      ownerCoordinatorSessionId: SESSION,
    },
  ];
  return projectActionableWork({
    coordinatorSessionId: SESSION,
    controlState: 'active',
    observations,
    admitted: [],
  });
}

test('执行工具被注册进图：已提交调用由 tools 节点按持久化身份执行一次并落盘', async () => {
  const saved = checkpointStore.saveCheckpoint(baseState());
  expect(saved.kind).toBe('saved');

  const harness = fakeServices(baseFacts());
  const executionTools = executionToolset(harness.services.readFacts(), harness.services);
  expect(executionTools.map((definition) => definition.name)).toEqual([
    'read_execution_status',
    'advance_execution',
    'request_graph_patch',
  ]);

  const model = new FakeToolModel([
    {
      kind: 'tool_calls',
      calls: [{ callId: 'call-1', name: 'advance_execution', args: {} }],
    },
    { kind: 'text', content: '本轮推进完成' },
  ]);
  let step = 0;
  const graph = buildCoordinatorGraph({
    model,
    checkpointer: checkpointStore.checkpointer,
    sessionRecords: checkpointStore,
    planningTools: [],
    executionTools,
    assertFencing: () => ({ kind: 'valid', lease: {} as never } satisfies FencingAssertion),
    newStepId: () => `step-${String((step += 1))}`,
    sleep: () => Promise.resolve(),
    buildMessages: () =>
      Promise.resolve({ messages: [new HumanMessage('推进执行')], note: '有界输入' }),
  });

  await graph.invoke(
    {
      coordinatorSessionId: SESSION,
      remainingWork: actionableWork().items,
      deferredWork: 0,
      pendingToolCalls: 0,
    },
    { configurable: { thread_id: 'thread-execution-tools' }, ...COORDINATOR_INVOKE_DEFAULTS },
  );

  // 身份来自持久化的 step 与 call，而不是模型输入或本次进程内的随机值。
  expect(harness.forwarded).toEqual([{ name: 'advance_execution', operationId: 'op:step-1:call-1' }]);
  expect(harness.calls.advanceExecution).toBe(1);

  const read = checkpointStore.loadCheckpoint(SESSION);
  expect(read.kind).toBe('recovered');
  if (read.kind !== 'recovered') {
    return;
  }
  const entry = read.state.committedMessages.find((message) => message.role === 'tool');
  expect(entry?.toolName).toBe('advance_execution');
  expect(entry?.entryId).toBe(toolResultEntryId('step-1', 'call-1'));
  expect(entry?.content).toContain('测试用例不推进');
});
