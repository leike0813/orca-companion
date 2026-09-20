/**
 * 执行预算上限领域行为测试（change: `m1-plan-and-authorize-execution`，Owner: IP-5）。
 *
 * 覆盖 Requirement「Compilation carries budget caps and scope envelopes」下的 Scenario：
 * - 超限计划不产出可授权候选图：`assertWithinCaps` 逐项报告超限且不静默截断。
 * - 并发上限随图一并固定：默认并发上限是有限正整数。
 * 另外覆盖 `AGENTS.md` 第 7 节的有限默认值（design D6/D7/D8）、`parseExecutionLimits` 的
 * 字段闭集校验，以及 `applyLimitDefaults` 只在组装阶段补缺失字段。
 */

import { expect, test } from 'vitest';

import {
  DEFAULT_EXECUTION_LIMITS,
  applyLimitDefaults,
  assertWithinCaps,
  parseExecutionLimits,
  type ExecutionLimits,
} from '../../src/domain/planning/budget-policy.js';
import type { PlannedWorkPackage, WorkPackageBudget } from '../../src/domain/planning/execution-graph.js';

const DEFAULT_VALUES = {
  maxActiveWorkPackages: 8,
  concurrencyLimit: 1,
  implementationAttempts: 2,
  validatorRepairs: 2,
  graphRevisions: 2,
  specificationRevisions: 2,
  maxRecoveriesPerWorkerAttempt: 1,
} as const;

function limits(overrides: Partial<ExecutionLimits> = {}): ExecutionLimits {
  return { ...DEFAULT_EXECUTION_LIMITS, ...overrides };
}

function planned(key: string, requestedBudget?: Partial<WorkPackageBudget>): PlannedWorkPackage {
  return {
    key,
    title: `${key} 的标题`,
    dependsOn: [],
    scopeEnvelope: { include: ['src'], exclude: [] },
    ...(requestedBudget === undefined ? {} : { requestedBudget }),
  };
}

test('默认执行上限是有限正整数，取值与 AGENTS.md 第 7 节一致', () => {
  expect(Number.isSafeInteger(DEFAULT_EXECUTION_LIMITS.concurrencyLimit)).toBe(true);
  expect(DEFAULT_EXECUTION_LIMITS.concurrencyLimit).toBeGreaterThan(0);
  for (const value of Object.values(DEFAULT_EXECUTION_LIMITS)) {
    expect(Number.isSafeInteger(value)).toBe(true);
    expect(value).toBeGreaterThan(0);
  }
  expect(DEFAULT_EXECUTION_LIMITS).toEqual(DEFAULT_VALUES);
});

test('完整且全为正整数的上限对象通过解析', () => {
  const parsed = parseExecutionLimits(DEFAULT_VALUES, 'limits');
  expect(parsed.ok).toBe(true);
  if (parsed.ok) {
    expect(parsed.value).toEqual(DEFAULT_EXECUTION_LIMITS);
  }
});

test('缺失任一上限字段即拒绝，并指向该字段', () => {
  for (const key of Object.keys(DEFAULT_VALUES) as (keyof ExecutionLimits)[]) {
    const incomplete: Record<string, unknown> = { ...DEFAULT_VALUES };
    delete incomplete[key];

    const parsed = parseExecutionLimits(incomplete, 'limits');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.field).toContain(key);
    }
  }
});

test('零、负数、小数、Infinity、NaN 与 null 都不是合法上限', () => {
  const rejected: readonly unknown[] = [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN, null, '2'];

  for (const value of rejected) {
    const parsed = parseExecutionLimits({ ...DEFAULT_VALUES, concurrencyLimit: value }, 'limits');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.field).toContain('concurrencyLimit');
    }
  }
});

test('组装阶段只补缺失的上限，已给出的值不被覆盖', () => {
  const raw = { concurrencyLimit: 4, maxRecoveriesPerWorkerAttempt: 3 };
  const snapshot = { ...raw };

  const filled = applyLimitDefaults(raw);

  expect(filled).toEqual({
    ...DEFAULT_EXECUTION_LIMITS,
    concurrencyLimit: 4,
    maxRecoveriesPerWorkerAttempt: 3,
  });
  expect(raw).toEqual(snapshot);
});

test('非对象输入原样返回，不伪造上限对象', () => {
  for (const value of [null, 42, 'limits', undefined]) {
    expect(applyLimitDefaults(value)).toBe(value);
  }
});

test('超过 active Work Package 上限的计划被判为超限', () => {
  const violations = assertWithinCaps({
    limits: limits({ maxActiveWorkPackages: 2 }),
    workPackages: [planned('a'), planned('b'), planned('c')],
  });

  expect(violations.map((violation) => violation.code)).toEqual(['active_work_packages_exceeded']);
  expect(violations[0]?.workPackageKey).toBeNull();
});

test('声明超过上限的包预算被判为超限并指向该包', () => {
  const violations = assertWithinCaps({
    limits: limits({ implementationAttempts: 2 }),
    workPackages: [planned('a'), planned('b', { implementationAttempts: 5 })],
  });

  expect(violations).toHaveLength(1);
  expect(violations[0]?.code).toBe('work_package_budget_exceeded');
  expect(violations[0]?.workPackageKey).toBe('b');
  expect(violations[0]?.message).toContain('implementationAttempts');
});

test('未声明 requestedBudget 的包不产生预算违规，也不会被读成无限', () => {
  const violations = assertWithinCaps({
    limits: limits(),
    workPackages: [planned('a'), planned('b')],
  });

  expect(violations).toEqual([]);
});

test('超限逐项列出且不截断，也不修改输入', () => {
  const workPackages = [
    planned('a', { implementationAttempts: 9 }),
    planned('b', { validatorRepairs: 9 }),
    planned('c'),
  ];
  const input = { limits: limits(), workPackages };
  const snapshot = JSON.stringify(input);

  const violations = assertWithinCaps(input);

  expect(violations.map((violation) => violation.workPackageKey).sort()).toEqual(['a', 'b']);
  expect(JSON.stringify(input)).toBe(snapshot);
});

test('同一个包的多个超限项各自成条，不被合并', () => {
  const violations = assertWithinCaps({
    limits: limits(),
    workPackages: [planned('a', { implementationAttempts: 5, graphRevisions: 5 })],
  });

  expect(violations).toHaveLength(2);
  expect(
    violations.every(
      (violation) => violation.code === 'work_package_budget_exceeded' && violation.workPackageKey === 'a',
    ),
  ).toBe(true);
});
