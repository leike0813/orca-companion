/**
 * `m1-evolve-execution-graph` 的行为测试：旧成果采用与 Work Package Lineage（IC-10 / IP-9）。
 *
 * 覆盖 `execution/replanning` 的第三个 Requirement：三条采用规则都不复制完成状态、材料只读、lineage
 * 不重置已消耗额度，以及矛盾事实必须阻塞。
 */

import { afterEach, beforeEach, expect, test } from 'vitest';

import type { GraphId, WorkPackageId } from '../../src/application/dto/identity.js';
import type { BudgetConsumption } from '../../src/domain/dispatch-candidate.js';
import {
  effectiveConsumption,
  inheritancePreservesConsumed,
  planLineage,
} from '../../src/domain/execution/work-package-lineage.js';
import {
  adoptionRecords,
  effectiveBudgetConsumption,
  evaluateAdoptionRequest,
  loadLineage,
  recordBaselineAdoption,
  recordWorkPackageLineage,
  type AdoptionRequest,
} from '../../src/application/execution/baseline-adoption.js';
import {
  createExecutionScopeHarness,
  type ExecutionScopeHarness,
} from '../support/execution-harness.js';

const WP_NEW = 'wp-new' as WorkPackageId;
const WP_OLD = 'wp-old' as WorkPackageId;
const OLD_GRAPH = 'graph-old' as GraphId;

let harness: ExecutionScopeHarness;

beforeEach(() => {
  harness = createExecutionScopeHarness();
});

afterEach(() => {
  harness.close();
});

function request(overrides: Partial<AdoptionRequest> = {}): AdoptionRequest {
  return {
    workPackageId: WP_NEW,
    kind: 'baseline_adoption',
    adoptedResultRef: 'result-1',
    baselineHead: 'head-new',
    integrationRef: 'commit-1',
    acceptedResultRecorded: true,
    evidenceRefs: ['evidence-1'],
    evidenceStillApplicable: true,
    conflictingFacts: [],
    materialReadOnly: true,
    newWorktreeBasedOnBaseline: true,
    ...overrides,
  };
}

test('Baseline Adoption 让旧能力被视为既有代码，且不复制完成状态', () => {
  const decision = evaluateAdoptionRequest(request());
  expect(decision.kind).toBe('adoptable');
  if (decision.kind !== 'adoptable') {
    return;
  }
  expect(decision.plan.treatsCapabilityAsExistingCode).toBe(true);
  expect(decision.plan.copiesCompletionState).toBe(false);
  expect(decision.plan.satisfiesNewWorkPackage).toBe(false);
  expect(decision.plan.readOnlyMaterial).toBe(true);
  expect(decision.plan.requiresExplicitMigrationAndRevalidation).toBe(false);
});

test('Migration Material 必须只读、基于 Replanning Baseline 的新 worktree 并显式重新验证', () => {
  const adopted = evaluateAdoptionRequest(request({ kind: 'migration_material' }));
  expect(adopted.kind).toBe('adoptable');
  if (adopted.kind === 'adoptable') {
    expect(adopted.plan.requiresExplicitMigrationAndRevalidation).toBe(true);
    expect(adopted.plan.treatsCapabilityAsExistingCode).toBe(false);
    expect(adopted.plan.copiesCompletionState).toBe(false);
  }

  const mutable = evaluateAdoptionRequest(request({ kind: 'migration_material', materialReadOnly: false }));
  expect(mutable.kind === 'rejected' ? mutable.failure.code : null).toBe('material_mutable');

  const staleWorktree = evaluateAdoptionRequest(
    request({ kind: 'migration_material', newWorktreeBasedOnBaseline: false }),
  );
  expect(staleWorktree.kind === 'rejected' ? staleWorktree.failure.code : null).toBe('worktree_not_rebased');
});

test('Planning Reference 只作为规划输入，不构成已实现事实', () => {
  const decision = evaluateAdoptionRequest(request({ kind: 'planning_reference', integrationRef: null }));
  expect(decision.kind).toBe('adoptable');
  if (decision.kind === 'adoptable') {
    expect(decision.plan.treatsCapabilityAsExistingCode).toBe(false);
    expect(decision.plan.copiesCompletionState).toBe(false);
    expect(decision.plan.satisfiesNewWorkPackage).toBe(false);
  }
});

test('接受记录缺失、证据失效与缺少基线都被拒绝', () => {
  expect(
    evaluateAdoptionRequest(request({ acceptedResultRecorded: false })).kind === 'rejected',
  ).toBe(true);
  expect(
    evaluateAdoptionRequest(request({ evidenceStillApplicable: false })).kind === 'rejected',
  ).toBe(true);
  expect(evaluateAdoptionRequest(request({ baselineHead: '' })).kind === 'rejected').toBe(true);
});

test('矛盾事实阻塞采用，并把阻塞结论落盘', () => {
  const conflicting = request({ conflictingFacts: ['git:未集成', 'orca:结果缺失'] });
  const decision = evaluateAdoptionRequest(conflicting);
  expect(decision.kind).toBe('blocked');

  const recorded = recordBaselineAdoption({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    adoptionId: 'adoption-blocked',
    decision,
    request: conflicting,
  });
  expect(recorded).toEqual({ kind: 'recorded', state: 'blocked' });

  const records = adoptionRecords(harness.store, harness.scopeId, WP_NEW);
  expect(records).toEqual([
    expect.objectContaining({ adoptionId: 'adoption-blocked', state: 'blocked', kind: 'baseline_adoption' }),
  ]);
  expect(records[0]?.blockingReason).toContain('相互矛盾的结论');
});

test('被判定不可采用的请求不落盘任何记录', () => {
  const rejected = request({ acceptedResultRecorded: false });
  const decision = evaluateAdoptionRequest(rejected);
  expect(decision.kind).toBe('rejected');
  const recorded = recordBaselineAdoption({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    adoptionId: 'adoption-rejected',
    decision,
    request: rejected,
  });
  expect(recorded.kind).toBe('rejected');
  expect(adoptionRecords(harness.store, harness.scopeId, WP_NEW)).toEqual([]);
});

test('采用记录用稳定 id 幂等，不产生第二行', () => {
  const adoptable = request();
  const decision = evaluateAdoptionRequest(adoptable);
  const first = recordBaselineAdoption({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    adoptionId: 'adoption-1',
    decision,
    request: adoptable,
  });
  expect(first).toEqual({ kind: 'recorded', state: 'recorded' });
  const second = recordBaselineAdoption({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    adoptionId: 'adoption-1',
    decision,
    request: adoptable,
  });
  expect(second.kind).toBe('already_recorded');
  expect(adoptionRecords(harness.store, harness.scopeId, WP_NEW)).toHaveLength(1);
});

test('lineage 继承旧责任已消耗的额度，而不是重置为新值', () => {
  const priorConsumed: readonly BudgetConsumption[] = [
    { workPackageId: WP_OLD, field: 'implementationAttempts', consumed: 1 },
    { workPackageId: WP_OLD, field: 'graphRevisions', consumed: 2 },
  ];
  const planned = planLineage({
    workPackageId: WP_NEW,
    priorWorkPackageId: WP_OLD,
    priorGraphId: OLD_GRAPH,
    priorConsumed,
  });
  expect(planned.kind).toBe('planned');
  if (planned.kind !== 'planned') {
    return;
  }
  expect(inheritancePreservesConsumed(planned.lineage.inherited, priorConsumed)).toBe(true);
  const implementation = planned.lineage.inherited.find((entry) => entry.field === 'implementationAttempts');
  expect(implementation?.consumed).toBe(1);
  // 恢复次数不在继承范围：它按 Worker Attempt 计，不是 Work Package 级额度。
  expect(planned.lineage.inherited.map((entry) => entry.field)).not.toContain('maxRecoveriesPerWorkerAttempt');
});

test('lineage 拒绝自延续与非法已消耗值', () => {
  expect(
    planLineage({
      workPackageId: WP_OLD,
      priorWorkPackageId: WP_OLD,
      priorGraphId: OLD_GRAPH,
      priorConsumed: [],
    }),
  ).toMatchObject({ kind: 'rejected', code: 'self_lineage' });

  expect(
    planLineage({
      workPackageId: WP_NEW,
      priorWorkPackageId: WP_OLD,
      priorGraphId: OLD_GRAPH,
      priorConsumed: [{ workPackageId: WP_OLD, field: 'validatorRepairs', consumed: -1 }],
    }),
  ).toMatchObject({ kind: 'rejected', code: 'invalid_consumed' });
});

test('记录 lineage 后，调度侧读取的已消耗额度包含继承量', () => {
  const priorConsumed: readonly BudgetConsumption[] = [
    { workPackageId: WP_OLD, field: 'implementationAttempts', consumed: 1 },
    { workPackageId: WP_OLD, field: 'validatorRepairs', consumed: 1 },
  ];
  const recorded = recordWorkPackageLineage({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    workPackageId: WP_NEW,
    priorWorkPackageId: WP_OLD,
    priorGraphId: OLD_GRAPH,
    priorConsumed,
  });
  expect(recorded.kind).toBe('recorded');

  const lineage = loadLineage(harness.store, harness.scopeId, WP_NEW);
  expect(lineage?.priorWorkPackageId).toBe(WP_OLD);

  const own: readonly BudgetConsumption[] = [
    { workPackageId: WP_NEW, field: 'implementationAttempts', consumed: 1 },
  ];
  const effective = effectiveBudgetConsumption({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    workPackageId: WP_NEW,
    own,
  });
  const implementation = effective.find((entry) => entry.field === 'implementationAttempts');
  // 本代 1 + 继承 1 = 2：已消耗额度只增不减，因此「延续旧责任」不会拿到一份新额度。
  expect(implementation?.consumed).toBe(2);
  expect(effective.find((entry) => entry.field === 'validatorRepairs')?.consumed).toBe(1);
  expect(effectiveConsumption({ workPackageId: WP_NEW, own, lineage })).toEqual(effective);
});

test('重复记录 lineage 是幂等拒绝，不覆盖既有延续关系', () => {
  recordWorkPackageLineage({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    workPackageId: WP_NEW,
    priorWorkPackageId: WP_OLD,
    priorGraphId: OLD_GRAPH,
    priorConsumed: [{ workPackageId: WP_OLD, field: 'implementationAttempts', consumed: 1 }],
  });
  const second = recordWorkPackageLineage({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    workPackageId: WP_NEW,
    priorWorkPackageId: 'wp-other' as WorkPackageId,
    priorGraphId: OLD_GRAPH,
    priorConsumed: [],
  });
  expect(second.kind).toBe('already_recorded');
  expect(loadLineage(harness.store, harness.scopeId, WP_NEW)?.priorWorkPackageId).toBe(WP_OLD);
});
