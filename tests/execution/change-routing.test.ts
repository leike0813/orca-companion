/**
 * `m1-evolve-execution-graph` 的行为测试：图变化的分类路由与 Graph Patch Planner 的派发边界（IC-10）。
 *
 * 覆盖 `execution/graph-patching` 的第一个 Requirement：七值路由正确、只有语义含糊的请求才派发
 * Graph Patch Planner、补丁草案必须携带 exact `baseGraphVersion`，以及 Planner 结果只是来源证据、
 * 从来不是当前图。
 */

import { expect, test } from 'vitest';

import type {
  CoordinationScopeId,
  GraphGeneration,
  GraphId,
  GraphVersion,
  OperationId,
  WorkPackageId,
} from '../../src/application/dto/identity.js';
import {
  routeGraphChange,
  type ChangeClaim,
  type GraphChangeRequest,
} from '../../src/domain/execution/change-routing.js';
import type { ExecutionGraph } from '../../src/domain/planning/execution-graph.js';
import {
  draftGraphPatch,
  graphPatchPlannerInstruction,
  type GraphPatchPlannerOutcome,
  type GraphPatchPlannerRequest,
} from '../../src/application/execution/graph-patch-planner.js';

const BASE_VERSION = 3 as GraphVersion;

function claims(overrides: Partial<Record<keyof GraphChangeRequest, ChangeClaim>>): GraphChangeRequest {
  const base: Record<string, ChangeClaim> = {
    infrastructureFailure: 'no',
    changesDependencies: 'no',
    changesScopeEnvelope: 'no',
    changesObjective: 'no',
    contractContentOnly: 'no',
    goalOrGlobalConstraintChanged: 'no',
    userRequestedReplanning: 'no',
    requiresUserChoice: 'no',
  };
  return { workPackageId: 'wp-a' as WorkPackageId, ...base, ...overrides } as GraphChangeRequest;
}

function route(overrides: Partial<Record<keyof GraphChangeRequest, ChangeClaim>>) {
  return routeGraphChange({ request: claims(overrides), baseGraphVersion: BASE_VERSION });
}

test.each([
  ['明确的重试请求', { infrastructureFailure: 'yes' }, 'retry_attempt'],
  ['只替换 contract 内容', { contractContentOnly: 'yes' }, 'specification_revision'],
  ['改变依赖', { changesDependencies: 'yes' }, 'graph_patch'],
  ['改变 Scope Envelope', { changesScopeEnvelope: 'yes' }, 'graph_patch'],
  ['改变 objective', { changesObjective: 'yes' }, 'graph_patch'],
  ['目标或全局约束变化', { goalOrGlobalConstraintChanged: 'yes' }, 'replanning_transition'],
  ['用户明确要求重规划', { userRequestedReplanning: 'yes' }, 'replanning_transition'],
  ['全部事实核验为不成立', {}, 'no_change'],
  ['需要用户裁决', { requiresUserChoice: 'yes' }, 'user_decision_required'],
  [
    '同时声明重试与语义变化',
    { infrastructureFailure: 'yes', contractContentOnly: 'yes' },
    'blocked',
  ],
  [
    '同时声明重试与图级变化',
    { infrastructureFailure: 'yes', changesDependencies: 'yes' },
    'blocked',
  ],
] as const)('%s → %s', (_name, overrides, expected) => {
  expect(route(overrides as Partial<Record<keyof GraphChangeRequest, ChangeClaim>>).route).toBe(expected);
});

test('只有声明事实不足以判定时才派发 Graph Patch Planner', () => {
  // 明确的结构变化由调用方直接给出补丁，不需要模型判断。
  expect(route({ changesDependencies: 'yes' }).dispatchGraphPatchPlanner).toBe(false);
  expect(route({ infrastructureFailure: 'yes' }).dispatchGraphPatchPlanner).toBe(false);
  expect(route({ contractContentOnly: 'yes' }).dispatchGraphPatchPlanner).toBe(false);
  expect(route({ goalOrGlobalConstraintChanged: 'yes' }).dispatchGraphPatchPlanner).toBe(false);

  // 无法核验的声明落入语义判断：路由仍是 graph_patch，但必须派 Planner。
  const ambiguous = route({ changesObjective: 'unknown' });
  expect(ambiguous.route).toBe('graph_patch');
  expect(ambiguous.dispatchGraphPatchPlanner).toBe(true);

  // 需要用户裁决与矛盾声明都不派 Planner：它们的下一步是问用户。
  expect(route({ requiresUserChoice: 'yes' }).dispatchGraphPatchPlanner).toBe(false);
  expect(route({ infrastructureFailure: 'yes', changesObjective: 'yes' }).dispatchGraphPatchPlanner).toBe(false);
});

test('每条路由结论都携带 exact baseGraphVersion', () => {
  for (const overrides of [
    { infrastructureFailure: 'yes' },
    { changesDependencies: 'yes' },
    { changesObjective: 'unknown' },
    {},
  ] as const) {
    expect(route(overrides).baseGraphVersion).toBe(BASE_VERSION);
  }
});

function plannerRequestOf(outcome: GraphPatchPlannerOutcome) {
  return (request: GraphPatchPlannerRequest): Promise<GraphPatchPlannerOutcome> => {
    void request;
    return Promise.resolve(outcome);
  };
}

function graphFixture(): ExecutionGraph {
  return {
    graphId: 'graph-1' as GraphId,
    generation: 1 as GraphGeneration,
    concurrencyLimit: 1,
    workPackages: [],
  };
}

function draftInput(plannerOutcome: GraphPatchPlannerOutcome) {
  return {
    routing: route({ changesObjective: 'unknown' }),
    planner: plannerRequestOf(plannerOutcome),
    coordinationScopeId: 'scope-1' as CoordinationScopeId,
    graphId: 'graph-1' as GraphId,
    patchId: 'patch-1',
    operationId: 'op-1' as OperationId,
    changeRequest: claims({ changesObjective: 'unknown' }),
    currentGraph: graphFixture(),
    affectedWorkPackageIds: ['wp-a' as WorkPackageId],
    unacceptedDescendantIds: [],
  };
}

test('Planner 请求固定携带 exact baseGraphVersion 与补丁身份', async () => {
  const seen: GraphPatchPlannerRequest[] = [];
  const result = await draftGraphPatch({
    ...draftInput({ kind: 'accepted', draftRef: 'result-1', payload: { any: 'draft' } }),
    planner: (request) => {
      seen.push(request);
      return Promise.resolve({ kind: 'accepted', draftRef: 'result-1', payload: { any: 'draft' } });
    },
  });

  expect(seen).toHaveLength(1);
  expect(seen[0]?.baseGraphVersion).toBe(BASE_VERSION);
  expect(seen[0]?.patchId).toBe('patch-1');
  expect(result.kind).toBe('drafted');
});

test('Planner 指令携带变化声明、当前图与直接受影响节点', () => {
  const input = draftInput({ kind: 'accepted', draftRef: 'result-1', payload: {} });
  const instruction = graphPatchPlannerInstruction({
    coordinationScopeId: input.coordinationScopeId,
    graphId: input.graphId,
    baseGraphVersion: input.routing.baseGraphVersion,
    patchId: input.patchId,
    operationId: input.operationId,
    changeRequest: input.changeRequest,
    affectedWorkPackageIds: input.affectedWorkPackageIds,
    unacceptedDescendantIds: input.unacceptedDescendantIds,
    currentGraph: input.currentGraph,
  });

  expect(instruction).toContain('"changesObjective":"unknown"');
  expect(instruction).toContain('"graphId":"graph-1"');
  expect(instruction).toContain('仅 add 不算处置');
});

test('Planner 结果只是来源证据，不构成当前图', async () => {
  const result = await draftGraphPatch(
    draftInput({ kind: 'accepted', draftRef: 'result-1', payload: { add: [], revise: [], retire: [] } }),
  );
  expect(result.kind).toBe('drafted');
  if (result.kind !== 'drafted') {
    return;
  }
  expect(result.evidence.committed).toBe(false);
  expect(result.evidence.draftRef).toBe('result-1');
  expect(result.evidence.baseGraphVersion).toBe(BASE_VERSION);
  // 证据类型里没有图：唯一提交点是 graph-patch-service 的 Admission 路径。
  expect(Object.hasOwn(result.evidence, 'graph')).toBe(false);
});

test('结果不可判定时保持 unknown，不伪造补丁', async () => {
  const result = await draftGraphPatch(draftInput({ kind: 'unknown', reason: 'orca 未确认' }));
  expect(result).toEqual({ kind: 'unknown', reason: 'orca 未确认' });
});

test('分类未要求派发时拒绝派发 Planner', async () => {
  const result = await draftGraphPatch({
    ...draftInput({ kind: 'accepted', draftRef: 'result-1', payload: {} }),
    routing: route({ infrastructureFailure: 'yes' }),
  });
  expect(result.kind).toBe('rejected');
  if (result.kind === 'rejected') {
    expect(result.code).toBe('planner_not_dispatched');
  }
});
