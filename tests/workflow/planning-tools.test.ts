/**
 * IC-05：规划工具集的动态暴露与调用期重验
 * （D17 / Requirement「Handoff gate, mode transition and execution lease」的可观察面）。
 *
 * 覆盖：工具按模式与事实动态暴露、非规划模式或未过激活门时只剩只读工具、handler 每次调用重验
 * scope/ownership/revision/权限/预算，以及 graph 组装处的模式门与绑定行为。
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

import { expect, test } from 'vitest';

import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  OperationId,
} from '../../src/application/dto/identity.js';
import type { HandoffActivation, PlanningHandoffResult } from '../../src/application/planning/planning-handoff.js';
import type { PlanningMutationResult } from '../../src/application/planning/route-map-service.js';
import {
  PLANNING_TOOL_NAMES,
  planningToolset,
  planningRecoveryToolset,
  planningToolsForMode,
  toBindableTools,
  type PlanningToolFacts,
  type PlanningToolOutcome,
  type PlanningToolServices,
} from '../../src/workflow/coordinator/planning-tools.js';
import {
  bindPlanningTools,
  registerPlanningTools,
} from '../../src/workflow/coordinator/graph.js';

const SCOPE = 'scope-tools' as CoordinationScopeId;
const SESSION_A = 'session-a' as CoordinatorSessionId;
const SESSION_B = 'session-b' as CoordinatorSessionId;

/** 宿主在提交模型响应时分配的可信身份；工具 handler 只能转发它，模型不能填写。 */
const CALL_CONTEXT = {
  operationId: 'op:step-1:call-1' as OperationId,
  mapOperationId: 'map:step-1:call-1' as OperationId,
};

const READ_TOOLS = ['read_route_map', 'read_frontier'] as const;

function baseFacts(overrides: Partial<PlanningToolFacts> = {}): PlanningToolFacts {
  return {
    mode: 'route_planning',
    controlState: 'active',
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    scopeRevision: 7,
    activation: { kind: 'active', coordinatorSessionId: SESSION_A },
    permissions: { allowPlanningWrites: true },
    budget: { remainingMutations: 3 },
    ...overrides,
  };
}

type Calls = {
  updateRouteMapSection: number;
  claimTicket: number;
  releaseTicket: number;
  resolveTicket: number;
  preparePlanningHandoff: number;
  reviewPlanningHandoff: number;
  readRouteMap: number;
  readFrontier: number;
};

/** handler 转发给用例的可信身份，按调用顺序记录。 */
type Forwarded = {
  readonly name: string;
  readonly operationId: OperationId;
  readonly mapOperationId: OperationId | null;
};

function fakeServices(facts: PlanningToolFacts, mutation: PlanningMutationResult = accepted()) {
  const calls: Calls = {
    updateRouteMapSection: 0,
    claimTicket: 0,
    releaseTicket: 0,
    resolveTicket: 0,
    preparePlanningHandoff: 0,
    reviewPlanningHandoff: 0,
    readRouteMap: 0,
    readFrontier: 0,
  };
  const forwarded: Forwarded[] = [];
  let current = facts;
  const services: PlanningToolServices = {
    readFacts: () => current,
    readRouteMap: () => {
      calls.readRouteMap += 1;
      return Promise.resolve({ kind: 'ok', value: { sections: {} } } as PlanningToolOutcome);
    },
    readFrontier: () => {
      calls.readFrontier += 1;
      return Promise.resolve({ kind: 'ok', value: [] } as PlanningToolOutcome);
    },
    updateRouteMapSection: (input) => {
      calls.updateRouteMapSection += 1;
      forwarded.push({ name: 'update_route_map_section', operationId: input.operationId, mapOperationId: null });
      return Promise.resolve(mutation);
    },
    claimTicket: (input) => {
      calls.claimTicket += 1;
      forwarded.push({ name: 'claim_ticket', operationId: input.operationId, mapOperationId: null });
      return Promise.resolve(mutation);
    },
    releaseTicket: (input) => {
      calls.releaseTicket += 1;
      forwarded.push({ name: 'release_ticket', operationId: input.operationId, mapOperationId: null });
      return Promise.resolve(mutation);
    },
    resolveTicket: (input) => {
      calls.resolveTicket += 1;
      forwarded.push({
        name: 'resolve_ticket',
        operationId: input.operationId,
        mapOperationId: input.mapOperationId,
      });
      return Promise.resolve(mutation);
    },
    preparePlanningHandoff: (input) => {
      calls.preparePlanningHandoff += 1;
      forwarded.push({
        name: 'prepare_planning_handoff',
        operationId: input.operationId,
        mapOperationId: null,
      });
      return Promise.resolve(handoffAccepted());
    },
    reviewPlanningHandoff: (input) => {
      calls.reviewPlanningHandoff += 1;
      forwarded.push({ name: 'review_planning_handoff', operationId: input.operationId, mapOperationId: null });
      return Promise.resolve(handoffAccepted());
    },
  };
  return {
    calls,
    forwarded,
    services,
    setFacts: (next: PlanningToolFacts) => {
      current = next;
    },
  };
}

function accepted(): PlanningMutationResult {
  return { kind: 'accepted', revision: 8, mapRevision: 2 };
}

function handoffAccepted(): PlanningHandoffResult {
  return {
    kind: 'prepared',
    proposal: {
      coordinationScopeId: SCOPE,
      proposalId: 'proposal-1',
      sourceCoordinatorSessionId: SESSION_A,
      targetCoordinatorSessionId: SESSION_B,
      phase: 'prepared',
      mapRevision: 1,
      planRevision: 1,
      graphId: null,
      graphVersion: null,
      capsuleRef: null,
      proposalRevision: 1,
      createdAt: 1,
      updatedAt: 1,
    },
  };
}

function toolNames(facts: PlanningToolFacts): readonly string[] {
  return planningToolset(facts, fakeServices(facts).services).map((definition) => definition.name);
}

async function invoke(
  facts: PlanningToolFacts,
  name: (typeof PLANNING_TOOL_NAMES)[number],
  input: Record<string, unknown>,
  configure?: (services: ReturnType<typeof fakeServices>) => void,
): Promise<PlanningToolOutcome> {
  const harness = fakeServices(facts);
  configure?.(harness);
  const definition = planningToolset(facts, harness.services).find((candidate) => candidate.name === name);
  if (definition === undefined) {
    throw new Error(`工具 ${name} 在当前事实下不可见`);
  }
  return await definition.invoke(input, CALL_CONTEXT);
}

test('规划模式与事实齐全时暴露完整的规划工具集', () => {
  expect(toolNames(baseFacts())).toEqual([
    'read_route_map',
    'read_frontier',
    'update_route_map_section',
    'claim_ticket',
    'release_ticket',
    'resolve_ticket',
    'prepare_planning_handoff',
    'review_planning_handoff',
  ]);
});

test('非规划模式、暂停、未过激活门、无权限或预算耗尽时不再暴露写入工具', () => {
  const cases: readonly PlanningToolFacts[] = [
    baseFacts({ mode: 'execution_coordination' }),
    baseFacts({ controlState: 'paused' }),
    baseFacts({ controlState: 'blocked' }),
    baseFacts({ activation: { kind: 'awaiting_user_prompt', proposalId: 'p', reason: '等待用户' } }),
    baseFacts({ activation: { kind: 'not_planning_owner', ownerCoordinatorSessionId: SESSION_B } }),
    baseFacts({ permissions: { allowPlanningWrites: false } }),
    baseFacts({ budget: { remainingMutations: 0 } }),
  ];
  for (const facts of cases) {
    const names = toolNames(facts);
    expect(names.length).toBeLessThanOrEqual(READ_TOOLS.length);
    expect(names).not.toContain('update_route_map_section');
    expect(names).not.toContain('claim_ticket');
    if (facts.mode !== 'route_planning') {
      expect(names).toEqual([]);
    } else {
      expect(names).toEqual([...READ_TOOLS]);
    }
  }
});

test('只读工具不需要 expectedRevision，也不消耗写入预算', async () => {
  const harness = fakeServices(baseFacts({ budget: { remainingMutations: 0 } }));
  const definition = planningToolset(harness.services.readFacts(), harness.services).find(
    (candidate) => candidate.name === 'read_route_map',
  );
  expect(definition).toBeDefined();
  const outcome = await definition?.invoke({}, CALL_CONTEXT);
  expect(outcome?.kind).toBe('ok');
  expect(harness.calls.readRouteMap).toBe(1);
});

test('写入工具在 expectedRevision 过期时拒绝，且不触达用例', async () => {
  const outcome = await invoke(
    baseFacts(),
    'update_route_map_section',
    { section: 'fog', content: '新内容', expectedRevision: 6 },
    (harness) => {
      harness.setFacts(baseFacts({ scopeRevision: 7 }));
    },
  );
  expect(outcome.kind).toBe('rejected');
  if (outcome.kind === 'rejected') {
    expect(outcome.code).toBe('stale_revision');
  }
});

test('写入工具在调用时重验模式、控制状态、激活门、权限与预算', async () => {
  const scenarios: readonly {
    readonly facts: PlanningToolFacts;
    readonly code: string;
  }[] = [
    { facts: baseFacts({ mode: 'execution_coordination' }), code: 'wrong_mode' },
    { facts: baseFacts({ controlState: 'cancelling' }), code: 'control_state' },
    {
      facts: baseFacts({
        activation: { kind: 'awaiting_user_prompt', proposalId: 'p', reason: '等待用户' },
      }),
      code: 'activation_gate',
    },
    {
      facts: baseFacts({ activation: { kind: 'not_planning_owner', ownerCoordinatorSessionId: SESSION_B } }),
      code: 'activation_gate',
    },
    { facts: baseFacts({ permissions: { allowPlanningWrites: false } }), code: 'not_permitted' },
    { facts: baseFacts({ budget: { remainingMutations: 0 } }), code: 'budget_exhausted' },
  ];
  for (const scenario of scenarios) {
    const outcome = await invoke(
      baseFacts(),
      'claim_ticket',
      { ticketId: 'ticket-1', expectedRevision: 7 },
      (harness) => {
        harness.setFacts(scenario.facts);
      },
    );
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') {
      expect(outcome.code).toBe(scenario.code);
    }
  }
});

test('工具绑定的 Scope 或 Session 变化时拒绝', async () => {
  const outcome = await invoke(
    baseFacts(),
    'claim_ticket',
    { ticketId: 'ticket-1', expectedRevision: 7 },
    (harness) => {
      harness.setFacts(baseFacts({ coordinatorSessionId: SESSION_B }));
    },
  );
  expect(outcome.kind).toBe('rejected');
  if (outcome.kind === 'rejected') {
    expect(outcome.code).toBe('scope_mismatch');
  }
});

test('参数非法时在触达用例之前拒绝', async () => {
  const missing = await invoke(baseFacts(), 'claim_ticket', { expectedRevision: 7 });
  expect(missing.kind).toBe('rejected');
  const notObject = await invoke(baseFacts(), 'resolve_ticket', { ticketId: 'ticket-1', expectedRevision: 7 });
  expect(notObject.kind).toBe('rejected');
});

test('写入成功时把用例结果归一化并带上新的 revision 与地图 revision', async () => {
  const harness = fakeServices(baseFacts());
  const definition = planningToolset(harness.services.readFacts(), harness.services).find(
    (candidate) => candidate.name === 'update_route_map_section',
  );
  const outcome = await definition?.invoke(
    {
      section: 'resolved_decisions',
      content: '- ticket-1: 采用方案 A',
      expectedRevision: 7,
    },
    CALL_CONTEXT,
  );
  expect(outcome).toEqual({ kind: 'ok', value: { scopeRevision: 8, mapRevision: 2 } });
  expect(harness.calls.updateRouteMapSection).toBe(1);
});

test('用例返回 unknown 时工具如实透传，不伪装成拒绝', async () => {
  const facts = baseFacts();
  const harness = fakeServices(facts, { kind: 'unknown', reason: 'tracker 丢响应' });
  const definition = planningToolset(facts, harness.services).find(
    (candidate) => candidate.name === 'resolve_ticket',
  );
  const outcome = await definition?.invoke(
    {
      ticketId: 'ticket-1',
      resolution: '采用方案 A',
      expectedRevision: 7,
    },
    CALL_CONTEXT,
  );
  expect(outcome?.kind).toBe('unknown');
});

test('prepare 与 review 交接工具走同一套准入并归一化阶段', async () => {
  const prepared = await invoke(baseFacts(), 'prepare_planning_handoff', {
    proposalId: 'proposal-1',
    targetCoordinatorSessionId: SESSION_B,
    capsuleRef: 'capsule-1',
    expectedRevision: 7,
  });
  expect(prepared.kind).toBe('ok');

  const reviewed = await invoke(baseFacts(), 'review_planning_handoff', {
    proposalId: 'proposal-1',
    expectedRevision: 7,
  });
  expect(reviewed.kind).toBe('ok');
});

test('写入工具把可信身份转发给用例：resolve_ticket 另带地图写入身份', async () => {
  const facts = baseFacts();
  const harness = fakeServices(facts);
  const definitions = planningToolset(facts, harness.services);
  await definitions
    .find((definition) => definition.name === 'claim_ticket')
    ?.invoke({ ticketId: 'ticket-1', expectedRevision: 7 }, CALL_CONTEXT);
  await definitions
    .find((definition) => definition.name === 'resolve_ticket')
    ?.invoke({ ticketId: 'ticket-1', resolution: '采用方案 A', expectedRevision: 7 }, CALL_CONTEXT);

  expect(harness.forwarded).toEqual([
    { name: 'claim_ticket', operationId: CALL_CONTEXT.operationId, mapOperationId: null },
    {
      name: 'resolve_ticket',
      operationId: CALL_CONTEXT.operationId,
      mapOperationId: CALL_CONTEXT.mapOperationId,
    },
  ]);
});

test('resolve_ticket 已完成释放阶段时仍沿用原地图身份完成剩余阶段', async () => {
  const current = { ...baseFacts(), scopeRevision: 9, budget: { remainingMutations: 0 } };
  const harness = fakeServices(current);
  const services = {
    ...harness.services,
    replayMutation: () => accepted(),
  };
  expect(planningToolset(current, services).some((definition) => definition.name === 'resolve_ticket')).toBe(false);
  const tool = planningRecoveryToolset(current, services).find((definition) => definition.name === 'resolve_ticket');
  if (tool === undefined) throw new Error('缺少 resolve_ticket');

  const result = await tool.invoke(
    { ticketId: 'ticket-1', resolution: '方案 A', expectedRevision: 7 },
    CALL_CONTEXT,
  );

  expect(result.kind).toBe('ok');
  expect(harness.calls.resolveTicket).toBe(1);
  expect(harness.forwarded.at(-1)).toMatchObject({
    operationId: CALL_CONTEXT.operationId,
    mapOperationId: CALL_CONTEXT.mapOperationId,
  });
});

test('绑定给模型的包装器只做 schema 广告，调用它不产生任何副作用', async () => {
  const facts = baseFacts();
  const harness = fakeServices(facts);
  const bindable = toBindableTools(planningToolset(facts, harness.services));
  const claim = bindable.find((entry) => entry.name === 'claim_ticket');
  if (claim === undefined) {
    throw new Error('claim_ticket 没有被绑定');
  }
  // 绑定的工具是 schema 广告：这里只关心「调用它会发生什么」，不关心它的载荷类型。
  const invokeBoundTool = claim as unknown as { invoke: (input: unknown) => Promise<unknown> };
  const outcome: unknown = JSON.parse(
    String(await invokeBoundTool.invoke({ ticketId: 'ticket-1', expectedRevision: 7 })),
  );

  expect(outcome).toEqual({
    kind: 'rejected',
    code: 'not_executable',
    message: '工具由受控 tools 节点执行，模型侧的绑定包装器不产生副作用',
  });
  expect(harness.calls.claimTicket).toBe(0);
  expect(harness.forwarded).toEqual([]);
});

test('planningToolsForMode 与 planningToolset 对同一事实给出相同工具集', () => {
  const facts = baseFacts();
  const services = fakeServices(facts).services;
  expect(planningToolsForMode({ facts, services }).map((definition) => definition.name)).toEqual(
    toolNames(facts),
  );
});

test('graph 组装处的模式门：非规划模式不注册任何规划工具', () => {
  const facts = baseFacts();
  const services = fakeServices(facts).services;
  expect(registerPlanningTools({ mode: 'execution_coordination', facts, services })).toEqual([]);
  expect(registerPlanningTools({ mode: 'route_planning', facts, services }).map((d) => d.name)).toEqual(
    toolNames(facts),
  );
});

test('bindPlanningTools 在无工具时保持原模型，在有工具时把工具交给模型绑定', () => {
  const bound: unknown[] = [];
  const model = {
    invoke: () => Promise.resolve({}),
    bindTools: (tools: readonly unknown[]) => {
      bound.push(tools);
      return { bound: true };
    },
  } as unknown as BaseChatModel;

  const definitions = planningToolset(baseFacts(), fakeServices(baseFacts()).services);
  expect(bindPlanningTools(model, [])).toBe(model);

  const result = bindPlanningTools(model, definitions);
  expect(bound).toHaveLength(1);
  expect(Array.isArray(bound[0]) ? (bound[0] as readonly unknown[]).length : 0).toBe(definitions.length);
  expect(result).not.toBe(model);
});

test('工具定义的输入 schema 与名称覆盖闭集，绑定的工具名与定义一致', () => {
  const definitions = planningToolset(baseFacts(), fakeServices(baseFacts()).services);
  expect(definitions.map((definition) => definition.name).sort()).toEqual(
    [...PLANNING_TOOL_NAMES].sort(),
  );
  for (const definition of definitions) {
    expect(definition.inputSchema['type']).toBe('object');
    expect(typeof definition.description).toBe('string');
  }
  const bindable = toBindableTools(definitions);
  expect(bindable.map((entry) => entry.name)).toEqual(definitions.map((definition) => definition.name));
});

test('激活门使用接收方身份时只暴露只读工具', () => {
  const facts = baseFacts({
    activation: { kind: 'awaiting_user_prompt', proposalId: 'p', reason: '等待用户' } satisfies HandoffActivation,
  });
  expect(toolNames(facts)).toEqual([...READ_TOOLS]);
});

test('用户提示满足后接收方只获得交接复核工具', async () => {
  const facts = baseFacts({
    activation: { kind: 'handoff_review', coordinatorSessionId: SESSION_A, proposalId: 'p' },
  });
  expect(toolNames(facts)).toEqual([...READ_TOOLS, 'review_planning_handoff']);
  expect(
    (await invoke(facts, 'review_planning_handoff', { proposalId: 'p', expectedRevision: 7 })).kind,
  ).toBe('ok');
});

test('handler 拒绝未知章节与空标识、空结论', async () => {
  expect(
    (await invoke(baseFacts(), 'update_route_map_section', {
      section: 'unknown',
      content: 'x',
      expectedRevision: 7,
    })).kind,
  ).toBe('rejected');
  expect(
    (await invoke(baseFacts(), 'resolve_ticket', { ticketId: 'ticket-1', resolution: ' ', expectedRevision: 7 })).kind,
  ).toBe('rejected');
  expect(
    (await invoke(baseFacts(), 'prepare_planning_handoff', {
      proposalId: '',
      targetCoordinatorSessionId: SESSION_B,
      expectedRevision: 7,
    })).kind,
  ).toBe('rejected');
});

test('工具定义不携带任何 scope/身份字段，调用方无法伪造写入者', () => {
  const definitions = planningToolset(baseFacts(), fakeServices(baseFacts()).services);
  const update = definitions.find((definition) => definition.name === 'update_route_map_section');
  const properties = update?.inputSchema['properties'] as Record<string, unknown>;
  expect(Object.keys(properties).sort()).toEqual(['content', 'expectedRevision', 'section']);
  expect(JSON.stringify(properties)).not.toContain('coordinatorSessionId');
});
