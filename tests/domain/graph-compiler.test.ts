/**
 * Execution Graph 确定性编译领域行为测试（change: `m1-plan-and-authorize-execution`，Owner: IP-5）。
 *
 * 覆盖 Requirement「Deterministic compilation from the Implementation Plan」下的 Scenario：
 * - 同一计划编译出相同拓扑：两次编译、以及计划内书写顺序倒置，都得到相同的 Work Package 与依赖。
 * - 编译失败即拒绝候选图：schema、重复 key、悬空/自引用、环路、Scope Envelope 与预算超限逐项失败，
 *   且失败结果没有 `graph` 字段。
 * 以及 Requirement「Compilation carries budget caps and scope envelopes」：编译产物的预算来自 limits，
 * 并发上限随图固定。另覆盖 `parseImplementationPlan` 的边界（缺省 `requestedBudget` 不落字段、负数拒绝）。
 */

import { expect, test } from 'vitest';

import type { GraphGeneration, GraphId } from '../../src/application/dto/identity.js';
import { DEFAULT_EXECUTION_LIMITS, budgetFromLimits, type ExecutionLimits } from '../../src/domain/planning/budget-policy.js';
import type { ExecutionGraph } from '../../src/domain/planning/execution-graph.js';
import {
  compileExecutionGraph,
  parseImplementationPlan,
  workPackageIdFor,
  type CompilationErrorCode,
  type CompilationResult,
} from '../../src/domain/planning/graph-compiler.js';

const GRAPH_ID = 'graph-1' as GraphId;
const GENERATION = 1 as GraphGeneration;
const LIMITS: ExecutionLimits = { ...DEFAULT_EXECUTION_LIMITS };

function workPackage(key: string, dependsOn: readonly string[] = []): Record<string, unknown> {
  return {
    key,
    title: `${key} 的标题`,
    dependsOn,
    scopeEnvelope: { include: ['src'], exclude: [] },
  };
}

function withEnvelope(
  key: string,
  include: readonly string[],
  dependsOn: readonly string[] = [],
): Record<string, unknown> {
  return { ...workPackage(key, dependsOn), scopeEnvelope: { include, exclude: [] } };
}

function plan(workPackages: readonly unknown[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    planRevision: 3,
    destinationRef: { kind: 'destination', id: 'dest-1', version: 1 },
    workPackages,
    ...overrides,
  };
}

function compile(rawPlan: unknown, limits: ExecutionLimits = LIMITS): CompilationResult {
  return compileExecutionGraph({ plan: rawPlan, limits, graphId: GRAPH_ID, generation: GENERATION });
}

function compileGraph(rawPlan: unknown, limits: ExecutionLimits = LIMITS): ExecutionGraph {
  const result = compile(rawPlan, limits);
  if (!result.ok) {
    throw new Error(`预期编译成功，实际失败：${result.errors.map((issue) => issue.code).join(',')}`);
  }
  return result.graph;
}

test('同一份计划编译两次得到相同 Work Package 与依赖拓扑', () => {
  const rawPlan = plan([workPackage('a'), workPackage('b', ['a']), workPackage('c', ['a', 'b'])]);

  const first = compileGraph(rawPlan);
  const second = compileGraph(structuredClone(rawPlan));

  expect(JSON.stringify(second.workPackages)).toBe(JSON.stringify(first.workPackages));
  expect(second.graphId).toBe(first.graphId);
  expect(second.generation).toBe(first.generation);
});

test('计划内 Work Package 的书写顺序不影响编译结果', () => {
  const forward = plan([workPackage('a'), workPackage('b', ['a']), workPackage('c', ['a', 'b'])]);
  const backward = plan([workPackage('c', ['a', 'b']), workPackage('b', ['a']), workPackage('a')]);

  expect(JSON.stringify(compileGraph(backward).workPackages)).toBe(
    JSON.stringify(compileGraph(forward).workPackages),
  );
});

test('WorkPackageId 由 GraphId 与 key 派生，依赖指向对应 id', () => {
  expect(workPackageIdFor(GRAPH_ID, 'a')).toBe(`${GRAPH_ID}:a`);

  const graph = compileGraph(plan([workPackage('a'), workPackage('b', ['a'])]));

  expect(graph.workPackages.map((item) => item.workPackageId)).toEqual([
    workPackageIdFor(GRAPH_ID, 'a'),
    workPackageIdFor(GRAPH_ID, 'b'),
  ]);

  const dependency = graph.workPackages.find(
    (item) => item.workPackageId === workPackageIdFor(GRAPH_ID, 'b'),
  );
  expect(dependency?.dependsOn).toEqual([workPackageIdFor(GRAPH_ID, 'a')]);
});

test('依赖按 key 升序排列，与计划内的书写顺序无关', () => {
  const graph = compileGraph(
    plan([workPackage('a'), workPackage('b'), workPackage('c'), workPackage('d', ['b', 'a', 'c'])]),
  );

  const node = graph.workPackages.find((item) => item.workPackageId === workPackageIdFor(GRAPH_ID, 'd'));
  expect(node?.dependsOn).toEqual(['a', 'b', 'c'].map((key) => workPackageIdFor(GRAPH_ID, key)));
});

type ErrorCase = {
  readonly name: string;
  readonly plan: unknown;
  readonly limits?: ExecutionLimits;
  readonly code: CompilationErrorCode;
};

const ERROR_CASES: readonly ErrorCase[] = [
  { name: '计划不是对象', plan: null, code: 'invalid_schema' },
  { name: '计划是数组', plan: [], code: 'invalid_schema' },
  {
    name: '计划缺少 planRevision',
    plan: { destinationRef: { kind: 'destination', id: 'dest-1', version: 1 }, workPackages: [workPackage('a')] },
    code: 'invalid_schema',
  },
  {
    name: '计划缺少 workPackages',
    plan: { planRevision: 1, destinationRef: { kind: 'destination', id: 'dest-1', version: 1 } },
    code: 'invalid_schema',
  },
  { name: '计划不含任何 Work Package', plan: plan([]), code: 'empty_plan' },
  { name: 'Work Package key 重复', plan: plan([workPackage('a'), workPackage('a')]), code: 'duplicate_key' },
  { name: '依赖引用不存在的 key', plan: plan([workPackage('a', ['zzz'])]), code: 'unknown_dependency' },
  { name: '依赖自身', plan: plan([workPackage('a', ['a'])]), code: 'self_dependency' },
  {
    name: '依赖成环 a→b→c→a',
    plan: plan([workPackage('a', ['b']), workPackage('b', ['c']), workPackage('c', ['a'])]),
    code: 'cycle',
  },
  { name: 'Scope Envelope 的 include 为空', plan: plan([withEnvelope('a', [])]), code: 'invalid_scope_envelope' },
  { name: 'Scope Envelope 含绝对路径', plan: plan([withEnvelope('a', ['/abs'])]), code: 'invalid_scope_envelope' },
  { name: 'Scope Envelope 越出上级目录', plan: plan([withEnvelope('a', ['../x'])]), code: 'invalid_scope_envelope' },
  { name: 'Scope Envelope 中间含 ..', plan: plan([withEnvelope('a', ['a/../b'])]), code: 'invalid_scope_envelope' },
  { name: 'Scope Envelope 以斜杠结尾', plan: plan([withEnvelope('a', ['a/'])]), code: 'invalid_scope_envelope' },
  {
    name: 'Scope Envelope 含反斜杠',
    plan: plan([withEnvelope('a', ['a\\b'])]),
    code: 'invalid_scope_envelope',
  },
  {
    name: 'Work Package 数量超过上限',
    plan: plan(Array.from({ length: 9 }, (_value, index) => workPackage(`wp-${String(index)}`))),
    code: 'budget_exceeded',
  },
];

test.each(ERROR_CASES)('编译失败即拒绝候选图：$name', ({ plan: rawPlan, limits: caseLimits, code }) => {
  const result = compile(rawPlan, caseLimits ?? LIMITS);

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.code).toBe(code);
  }
  expect(Object.hasOwn(result, 'graph')).toBe(false);
});

test('Scope Envelope 里的空字符串路径在 schema 层即被拒绝', () => {
  const result = compile(plan([withEnvelope('a', ['', 'src'])]));

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.errors[0]?.code).toBe('invalid_schema');
    expect(result.errors[0]?.message).toContain('include[0]');
  }
});

test('编译成功时每个 Work Package 带有限预算，并发上限随图固定', () => {
  const limits: ExecutionLimits = { ...DEFAULT_EXECUTION_LIMITS, concurrencyLimit: 1 };

  const graph = compileGraph(plan([workPackage('a'), workPackage('b', ['a'])]), limits);

  expect(graph.concurrencyLimit).toBe(limits.concurrencyLimit);
  for (const item of graph.workPackages) {
    expect(item.budget).toEqual(budgetFromLimits(limits));
    expect(item.budget.maxRecoveriesPerWorkerAttempt).toBe(limits.maxRecoveriesPerWorkerAttempt);
  }
});

test('parseImplementationPlan 接受字段完整的计划', () => {
  const parsed = parseImplementationPlan(plan([workPackage('a')]));

  expect(parsed.ok).toBe(true);
  if (parsed.ok) {
    expect(parsed.value.planRevision).toBe(3);
    expect(parsed.value.destinationRef).toEqual({ kind: 'destination', id: 'dest-1', version: 1 });
    expect(parsed.value.workPackages.map((item) => item.key)).toEqual(['a']);
  }
});

test('缺省 requestedBudget 时结果对象里不出现该字段', () => {
  const withoutBudget = parseImplementationPlan(plan([workPackage('a')]));
  expect(withoutBudget.ok).toBe(true);
  if (withoutBudget.ok) {
    expect(Object.keys(withoutBudget.value.workPackages[0] ?? {})).not.toContain('requestedBudget');
  }

  const withBudget = parseImplementationPlan(
    plan([{ ...workPackage('a'), requestedBudget: { implementationAttempts: 1 } }]),
  );
  expect(withBudget.ok).toBe(true);
  if (withBudget.ok) {
    expect(Object.keys(withBudget.value.workPackages[0] ?? {})).toContain('requestedBudget');
  }
});

test('requestedBudget 出现负数即拒绝', () => {
  const parsed = parseImplementationPlan(
    plan([{ ...workPackage('a'), requestedBudget: { implementationAttempts: -1 } }]),
  );

  expect(parsed.ok).toBe(false);
  if (!parsed.ok) {
    expect(parsed.field).toContain('requestedBudget');
  }
});
