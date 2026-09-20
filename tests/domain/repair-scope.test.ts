/**
 * 修复范围与预算判定测试
 * （change: `m1-execute-and-validate-work-packages`，Owner: IP-B3/B4）。
 *
 * 覆盖 Requirement「修复限定在授权范围与修复预算内，且证据与预算归属不被掩盖」的边界部分：
 * 范围内改动被允许、越界改动要求 Escalation、预算耗尽阻塞。
 */

import { expect, test } from 'vitest';

import type { RoleAuthorities } from '../../src/domain/planning/execution-authorization.js';
import type { ScopeEnvelope } from '../../src/domain/planning/execution-graph.js';
import {
  evaluateRepairScope,
  pathInsideScopeEnvelope,
  pathsOutsideScopeEnvelope,
} from '../../src/domain/repair-scope.js';

const ENVELOPE: ScopeEnvelope = { include: ['src/domain'], exclude: ['src/domain/generated'] };

const AUTHORITY: RoleAuthorities = {
  planner: false,
  implementation: true,
  validator: true,
  finalizer: true,
  gitIntegration: false,
  dependencyChanges: false,
};

function facts(overrides: Partial<Parameters<typeof evaluateRepairScope>[0]> = {}) {
  return {
    changedPaths: ['src/domain/a.ts'],
    scopeEnvelope: ENVELOPE,
    authority: AUTHORITY,
    requiresDesignChange: false,
    requiresDependencyChange: false,
    repairBudget: { limit: 2, consumed: 0 },
    ...overrides,
  };
}

test('exclude 优先于 include，include 为空表示没有可改路径', () => {
  expect(pathInsideScopeEnvelope(ENVELOPE, 'src/domain/a.ts')).toBe(true);
  expect(pathInsideScopeEnvelope(ENVELOPE, 'src/domain/generated/x.ts')).toBe(false);
  expect(pathInsideScopeEnvelope(ENVELOPE, 'src/application/a.ts')).toBe(false);
  expect(pathInsideScopeEnvelope({ include: [], exclude: [] }, 'src/a.ts')).toBe(false);
  expect(pathsOutsideScopeEnvelope(ENVELOPE, ['src/domain/a.ts', 'docs/x.md'])).toEqual(['docs/x.md']);
});

test('范围内的修复被允许并保留剩余预算', () => {
  expect(evaluateRepairScope(facts({ repairBudget: { limit: 2, consumed: 1 } }))).toEqual({
    kind: 'allowed',
    changedPaths: ['src/domain/a.ts'],
    remainingRepairs: 1,
  });
});

test('越界修复被拒绝并要求 Worker Escalation', () => {
  const decision = evaluateRepairScope(facts({ changedPaths: ['src/domain/a.ts', 'docs/x.md'] }));

  expect(decision).toMatchObject({ kind: 'requires_escalation', reason: 'scope' });
  expect(decision.kind === 'requires_escalation' ? decision.offendingPaths : []).toEqual(['docs/x.md']);
});

test('需要设计变更时要求 Escalation', () => {
  expect(evaluateRepairScope(facts({ requiresDesignChange: true }))).toMatchObject({
    kind: 'requires_escalation',
    reason: 'design',
  });
});

test('依赖变更未获授权时要求 Escalation，获授权时放行', () => {
  expect(evaluateRepairScope(facts({ requiresDependencyChange: true }))).toMatchObject({
    kind: 'requires_escalation',
    reason: 'dependency',
  });
  expect(
    evaluateRepairScope(
      facts({ requiresDependencyChange: true, authority: { ...AUTHORITY, dependencyChanges: true } }),
    ).kind,
  ).toBe('allowed');
});

test('validator 角色未获授权时要求 Escalation', () => {
  expect(evaluateRepairScope(facts({ authority: { ...AUTHORITY, validator: false } }))).toMatchObject({
    kind: 'requires_escalation',
    reason: 'authority',
  });
});

test('修复预算耗尽即阻塞，不因改动很小而放行', () => {
  expect(
    evaluateRepairScope(facts({ changedPaths: ['src/domain/a.ts'], repairBudget: { limit: 1, consumed: 1 } })),
  ).toMatchObject({ kind: 'budget_exhausted', limit: 1, consumed: 1 });
});
