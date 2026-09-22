/**
 * `m1-evolve-execution-graph` 的行为测试：修订额度与 Baseline Reconciliation（IC-10 / IP-6）。
 *
 * 覆盖 `execution/specification-revision` 的第三个 Requirement：上限来自已批准 Manifest 且默认各 2、
 * 重启后不重置、基线落后必须由独立 Planner-profile 任务补救，四项核验缺一不可。
 */

import { afterEach, beforeEach, expect, test } from 'vitest';

import type { WorkPackageId } from '../../src/application/dto/identity.js';
import { DEFAULT_EXECUTION_LIMITS } from '../../src/domain/planning/budget-policy.js';
import {
  evaluateRevisionRequest,
  revisionAllowance,
  revisionLimitOf,
} from '../../src/domain/execution/revision-budget.js';
import {
  baselineObservations,
  openBaselineReconciliation,
  planBaselineReconciliation,
  reconciliationIdFor,
  recordBaselineReconciliation,
  settleBaselineReconciliation,
} from '../../src/application/execution/baseline-reconciliation.js';
import {
  createExecutionScopeHarness,
  recordAcceptedPlannerResult,
  type ExecutionScopeHarness,
} from '../support/execution-harness.js';

const WP_B = 'wp-b' as WorkPackageId;

let harness: ExecutionScopeHarness;

beforeEach(() => {
  harness = createExecutionScopeHarness();
});

afterEach(() => {
  harness.close();
});

function plan(requiredBaselineHead = 'base-2', worktreeBaseHead = 'head-1', relation: 'behind' | 'ahead' | 'diverged' | 'equal' = 'behind') {
  const planned = planBaselineReconciliation({
    workPackageId: WP_B,
    requiredBaselineHead,
    worktreeBaseHead,
    relation,
  });
  if (planned.kind !== 'required') {
    throw new Error('测试前置失败：预期基线落后');
  }
  return planned.plan;
}

test('修订上限只从已批准 Manifest 读取，默认各 2', () => {
  const manifest = harness.authorization().manifest;
  expect(revisionLimitOf(manifest, 'graphRevisions')).toBe(2);
  expect(revisionLimitOf(manifest, 'specificationRevisions')).toBe(2);
  expect(DEFAULT_EXECUTION_LIMITS.graphRevisions).toBe(2);
  expect(DEFAULT_EXECUTION_LIMITS.specificationRevisions).toBe(2);
});

test('额度判定读取已消耗计数，缺计数按 0 且非法上限收紧为已用尽', () => {
  const manifest = harness.authorization().manifest;
  const allowed = evaluateRevisionRequest({
    manifest,
    consumption: [],
    workPackageId: WP_B,
    field: 'graphRevisions',
  });
  expect(allowed.kind).toBe('allowed');
  if (allowed.kind === 'allowed') {
    expect(allowed.allowance.remaining).toBe(2);
  }

  const exhausted = evaluateRevisionRequest({
    manifest,
    consumption: [{ workPackageId: WP_B, field: 'graphRevisions', consumed: 2 }],
    workPackageId: WP_B,
    field: 'graphRevisions',
  });
  expect(exhausted.kind).toBe('exhausted');

  // 重启后计数从已消耗值继续；非法上限不会被读成「不受限制」。
  expect(revisionAllowance({ workPackageId: WP_B, field: 'graphRevisions', limit: 2, consumed: 1 }).remaining).toBe(1);
  expect(revisionAllowance({ workPackageId: WP_B, field: 'graphRevisions', limit: 0, consumed: 0 }).exhausted).toBe(true);
  expect(revisionAllowance({ workPackageId: WP_B, field: 'graphRevisions', limit: Number.NaN, consumed: 0 }).exhausted).toBe(true);
});

test('基线相等或已领先时无需补救，落后或分叉时给出独立 Planner-profile 任务', () => {
  expect(
    planBaselineReconciliation({
      workPackageId: WP_B,
      requiredBaselineHead: 'head-1',
      worktreeBaseHead: 'head-1',
      relation: 'equal',
    }).kind,
  ).toBe('not_required');
  // base 已包含所需基线：这不是 D9 说的「落后」，不建立补救任务。
  expect(
    planBaselineReconciliation({
      workPackageId: WP_B,
      requiredBaselineHead: 'head-1',
      worktreeBaseHead: 'head-2',
      relation: 'ahead',
    }).kind,
  ).toBe('not_required');
  expect(
    planBaselineReconciliation({
      workPackageId: WP_B,
      requiredBaselineHead: 'head-1',
      worktreeBaseHead: 'head-2',
      relation: 'diverged',
    }).kind,
  ).toBe('required');

  const planned = plan();
  expect(planned.reconciliationId).toBe(reconciliationIdFor(WP_B, 'base-2'));
  expect(planned.role).toBe('planner');
  expect(planned.independentFromImplementation).toBe(true);
  expect(planned.observedBaseHead).toBe('head-1');
});

test('登记补救需求是幂等的：同一 Work Package 至多一个未收尾需求', () => {
  const first = recordBaselineReconciliation({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    plan: plan(),
  });
  expect(first.kind).toBe('recorded');
  const second = recordBaselineReconciliation({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    plan: plan(),
  });
  expect(second.kind).toBe('already_required');

  expect(openBaselineReconciliation(harness.store, harness.scopeId, WP_B)?.state).toBe('required');
  const records = harness.store.query({ kind: 'baseline-reconciliations', coordinationScopeId: harness.scopeId });
  expect(records.kind === 'baseline-reconciliations' ? records.reconciliations.length : -1).toBe(1);
});

test('四项核验全部通过才写入 verified', () => {
  recordBaselineReconciliation({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    plan: plan(),
  });
  const observations = baselineObservations({
    envelope: { include: ['src'], exclude: [] },
    requiredBaselineHead: 'base-2',
    git: {
      observedHead: 'base-2',
      descendantOfRequiredBaseline: true,
      dirtyPaths: ['src/a.ts'],
    },
  });
  expect(observations).toEqual({
    observedHead: 'base-2',
    ancestryVerified: true,
    targetHeadVerified: true,
    dirtyPathsReconciled: true,
    scopeReconciled: true,
  });

  const withoutPlannerResult = settleBaselineReconciliation({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    reconciliationId: plan().reconciliationId,
    observations,
  });
  expect(withoutPlannerResult.kind).toBe('rejected');
  recordAcceptedPlannerResult(harness, plan().reconciliationId);

  const settled = settleBaselineReconciliation({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    reconciliationId: plan().reconciliationId,
    observations,
  });
  expect(settled.kind).toBe('verified');
  const records = harness.store.query({ kind: 'baseline-reconciliations', coordinationScopeId: harness.scopeId });
  expect(records.kind === 'baseline-reconciliations' ? records.reconciliations[0]?.state : null).toBe('verified');
  expect(openBaselineReconciliation(harness.store, harness.scopeId, WP_B)).toBeNull();
});

test('任一核验不通过都写 blocked 并给出未对账项', () => {
  recordBaselineReconciliation({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    plan: plan(),
  });
  const observations = baselineObservations({
    envelope: { include: ['src'], exclude: [] },
    requiredBaselineHead: 'base-2',
    git: {
      observedHead: 'base-3',
      descendantOfRequiredBaseline: false,
      dirtyPaths: ['docs/readme.md'],
    },
  });
  expect(observations.ancestryVerified).toBe(false);
  expect(observations.targetHeadVerified).toBe(false);
  expect(observations.scopeReconciled).toBe(false);

  const settled = settleBaselineReconciliation({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    reconciliationId: plan().reconciliationId,
    observations,
  });
  expect(settled.kind).toBe('blocked');
  const records = harness.store.query({ kind: 'baseline-reconciliations', coordinationScopeId: harness.scopeId });
  const record = records.kind === 'baseline-reconciliations' ? records.reconciliations[0] : undefined;
  expect(record?.state).toBe('blocked');
  expect(record?.blockerRef).toContain('祖先关系');
});

test('dirty path 不是 worktree 内相对路径时单独阻塞', () => {
  const observations = baselineObservations({
    envelope: { include: ['src'], exclude: [] },
    requiredBaselineHead: 'base-2',
    git: {
      observedHead: 'base-2',
      descendantOfRequiredBaseline: true,
      dirtyPaths: ['/abs/path.ts'],
    },
  });
  expect(observations.dirtyPathsReconciled).toBe(false);
  expect(observations.scopeReconciled).toBe(false);
});
