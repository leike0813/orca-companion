/**
 * `m1-evolve-execution-graph` 验收层：修订额度与 Baseline Reconciliation（IP-10，D14）。
 *
 * 覆盖三件事：默认上限各 2 且只来自已批准 Manifest、已消耗额度不会因为另一次读取或另一次收尾而重置、
 * 以及基线落后时建立独立的 Planner-profile 任务。
 *
 * 额度计数存在真实 `coordination.sqlite` 里，因此「重启后仍从已消耗值继续」用第二个连接读同一文件来
 * 证明，而不是靠内存里的变量。
 */

import { afterEach, beforeEach, expect, test } from 'vitest';

import type { WorkPackageId } from '../../../src/application/dto/identity.js';
import { openCoordinationStore } from '../../../src/adapters/storage/coordination-store.js';
import {
  evaluateRevisionRequest,
  revisionAllowance,
} from '../../../src/domain/execution/revision-budget.js';
import {
  beginSpecificationRevision,
  settleSpecificationRevision,
} from '../../../src/application/execution/revision-service.js';
import {
  baselineObservations,
  planBaselineReconciliation,
  recordBaselineReconciliation,
  settleBaselineReconciliation,
} from '../../../src/application/execution/baseline-reconciliation.js';
import { planSpecificationRevision } from '../../../src/domain/execution/specification-revision.js';
import {
  createExecutionScopeHarness,
  recordAcceptedPlannerResult,
  executionWorkPackage,
  EXECUTION_AUTHORIZATION_ID,
  type ExecutionScopeHarness,
} from '../../support/execution-harness.js';

const WP_B = 'wp-b' as WorkPackageId;

let harness: ExecutionScopeHarness;

beforeEach(() => {
  harness = createExecutionScopeHarness();
});

afterEach(() => {
  harness.close();
});

function revisionPlan(contractRevision = 2) {
  const decision = planSpecificationRevision({
    request: {
      contractRevision,
      changesRequirements: true,
      changesDesign: false,
      changesAcceptance: true,
      changesDependencies: false,
      changesScopeEnvelope: false,
      changesObjective: false,
    },
    workPackage: executionWorkPackage('wp-b', ['wp-a']),
    accepted: false,
    currentContractRevision: contractRevision - 1,
    authority: harness.authorization().manifest.permissions,
  });
  if (decision.kind !== 'planned') {
    throw new Error('测试前置失败：修订计划未通过');
  }
  return decision.plan;
}

function consumedFromStore(): readonly { readonly workPackageId: WorkPackageId; readonly field: 'specificationRevisions'; readonly consumed: number }[] {
  const counters = harness.store.query({ kind: 'budget-counters', coordinationScopeId: harness.scopeId });
  if (counters.kind !== 'budget-counters') {
    return [];
  }
  return counters.counters
    .filter((counter) => counter.budgetKey.endsWith(':specificationRevisions'))
    .map((counter) => ({
      workPackageId: WP_B,
      field: 'specificationRevisions' as const,
      consumed: counter.consumed,
    }));
}

test('默认上限各为 2，且只从已批准 Manifest 读取', () => {
  const manifest = harness.authorization().manifest;
  expect(manifest.limits.graphRevisions).toBe(2);
  expect(manifest.limits.specificationRevisions).toBe(2);

  const allowed = evaluateRevisionRequest({
    manifest,
    consumption: [],
    workPackageId: WP_B,
    field: 'specificationRevisions',
  });
  expect(allowed.kind === 'allowed' ? allowed.allowance.remaining : null).toBe(2);

  const atLimit = evaluateRevisionRequest({
    manifest,
    consumption: [{ workPackageId: WP_B, field: 'specificationRevisions', consumed: 2 }],
    workPackageId: WP_B,
    field: 'specificationRevisions',
  });
  expect(atLimit.kind).toBe('exhausted');
  expect(revisionAllowance({ workPackageId: WP_B, field: 'specificationRevisions', limit: 2, consumed: 3 }).exhausted).toBe(true);
});

test('已消耗额度持久化在 store 里，另一个连接读到的是同一个值', () => {
  const plan = revisionPlan();
  beginSpecificationRevision({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    plan,
    revisionId: 'revision-1',
    manifest: harness.authorization().manifest,
    consumption: [],
    baseline: null,
  });
  const settled = settleSpecificationRevision({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    plan,
    revisionId: 'revision-1',
    authorizationId: EXECUTION_AUTHORIZATION_ID,
    admission: { kind: 'admitted' },
  });
  expect(settled.kind).toBe('accepted');

  // 第二次连接（相当于重启后的另一个进程）读到相同的已消耗值：额度不可能被内存状态重置。
  const reopened = openCoordinationStore({ databasePath: harness.databasePath, readOnly: true });
  if (reopened.kind !== 'opened') {
    throw new Error(reopened.message);
  }
  try {
    const counters = reopened.store.query({ kind: 'budget-counters', coordinationScopeId: harness.scopeId });
    const consumed =
      counters.kind === 'budget-counters'
        ? counters.counters.find((counter) => counter.budgetKey.endsWith(':specificationRevisions'))?.consumed
        : undefined;
    expect(consumed).toBe(1);
  } finally {
    reopened.store.close();
  }

  // 重新开始下一次修订时以 store 里的已消耗值为准：剩余额度只剩 1。
  const second = beginSpecificationRevision({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    plan: revisionPlan(3),
    revisionId: 'revision-2',
    manifest: harness.authorization().manifest,
    consumption: consumedFromStore(),
    baseline: null,
  });
  expect(second.kind).toBe('started');
  if (second.kind === 'started') {
    expect(second.allowance.consumed).toBe(1);
    expect(second.allowance.remaining).toBe(1);
  }
});

test('基线落后时建立独立 Planner-profile 任务并核验 ancestry/HEAD/dirty/scope', () => {
  const planned = planBaselineReconciliation({
    workPackageId: WP_B,
    requiredBaselineHead: 'base-2',
    worktreeBaseHead: 'head-1',
    relation: 'behind',
  });
  expect(planned.kind).toBe('required');
  if (planned.kind !== 'required') {
    return;
  }
  expect(planned.plan.role).toBe('planner');
  expect(planned.plan.independentFromImplementation).toBe(true);

  const recorded = recordBaselineReconciliation({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    plan: planned.plan,
  });
  expect(recorded.kind).toBe('recorded');

  const observations = baselineObservations({
    envelope: { include: ['src'], exclude: [] },
    requiredBaselineHead: 'base-2',
    git: {
      observedHead: 'base-2',
      descendantOfRequiredBaseline: true,
      dirtyPaths: ['src/orca/feature.ts'],
    },
  });
  expect(observations).toEqual({
    observedHead: 'base-2',
    ancestryVerified: true,
    targetHeadVerified: true,
    dirtyPathsReconciled: true,
    scopeReconciled: true,
  });
  recordAcceptedPlannerResult(harness, planned.plan.reconciliationId);

  const settled = settleBaselineReconciliation({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    reconciliationId: planned.plan.reconciliationId,
    observations,
  });
  expect(settled.kind).toBe('verified');
});

test('核验不完整时阻塞而不是放行', () => {
  const planned = planBaselineReconciliation({
    workPackageId: WP_B,
    requiredBaselineHead: 'base-2',
    worktreeBaseHead: 'head-1',
    relation: 'behind',
  });
  if (planned.kind !== 'required') {
    throw new Error('测试前置失败：基线未落后');
  }
  recordBaselineReconciliation({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    plan: planned.plan,
  });
  const observations = baselineObservations({
    envelope: { include: ['src'], exclude: [] },
    requiredBaselineHead: 'base-2',
    git: {
      observedHead: 'head-1',
      descendantOfRequiredBaseline: false,
      dirtyPaths: ['docs/readme.md'],
    },
  });
  const settled = settleBaselineReconciliation({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    reconciliationId: planned.plan.reconciliationId,
    observations,
  });
  expect(settled.kind).toBe('blocked');
  const records = harness.store.query({ kind: 'baseline-reconciliations', coordinationScopeId: harness.scopeId });
  expect(records.kind === 'baseline-reconciliations' ? records.reconciliations[0]?.state : null).toBe('blocked');
});
