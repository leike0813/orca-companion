/**
 * `m1-evolve-execution-graph` 验收层：九个限定审计标签的断言索引。
 *
 * 每个标签一条断言，直接用生产路径验证那条不变量，而不是复述实现细节：
 *
 * 1. `gate.append-only-graph-history`：图历史只追加；
 * 2. `gate.patch-base-version-exact`：补丁基线必须精确匹配；
 * 3. `gate.patch-descendants-enumerated`：未接受后代逐一处置；
 * 4. `gate.planner-result-not-committed`：Planner 结果不得直接提交；
 * 5. `gate.revision-not-retry`：三类修订与重试分离；
 * 6. `gate.hold-scope-limited`：revision_pending 只冻结受影响子图；
 * 7. `gate.cutover-atomic-refs`：代际引用整体切换；
 * 8. `gate.no-completion-copy-on-replan`：重规划不复制完成状态；
 * 9. `gate.lineage-inherits-consumed-budget`：lineage 继承已消耗额度。
 */

import { afterEach, beforeEach, expect, test } from 'vitest';

import type {
  DispatchId,
  GraphGeneration,
  GraphId,
  GraphVersion,
  OperationId,
  PlanningCycleId,
  WorkerTaskId,
  WorkPackageId,
} from '../../../src/application/dto/identity.js';
import type { BudgetConsumption } from '../../../src/domain/dispatch-candidate.js';
import { planSpecificationRevision } from '../../../src/domain/execution/specification-revision.js';
import { projectRevisionPending } from '../../../src/domain/execution/revision-pending.js';
import { validateCutoverRefs, type CandidateGenerationRefs } from '../../../src/domain/execution/replanning.js';
import {
  effectiveConsumption,
  inheritancePreservesConsumed,
  planLineage,
} from '../../../src/domain/execution/work-package-lineage.js';
import { decideWorkerResultRecording } from '../../../src/application/record-worker-result.js';
import {
  admitGraphRevision,
  applyGraphRevision,
  graphRevisionDraftFromEvidence,
} from '../../../src/application/execution/graph-patch-service.js';
import { evaluateAdoptionRequest, adoptionRecords, recordBaselineAdoption } from '../../../src/application/execution/baseline-adoption.js';
import type { GraphPatchPlannerEvidence } from '../../../src/application/execution/graph-patch-planner.js';
import { ensureGraphGenerationRecord } from '../../../src/application/execution/replanning-service.js';
import { createExecutionScopeHarness, executionWorkPackage, type ExecutionScopeHarness } from '../../support/execution-harness.js';

const WP_A = 'wp-a' as WorkPackageId;
const WP_B = 'wp-b' as WorkPackageId;
const WP_C = 'wp-c' as WorkPackageId;
const WP_D = 'wp-d' as WorkPackageId;

let harness: ExecutionScopeHarness;

beforeEach(() => {
  harness = createExecutionScopeHarness();
});

afterEach(() => {
  harness.close();
});

function patch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    baseGraphVersion: harness.currentGraph().version,
    patchId: 'patch-gate',
    operationId: 'op-gate',
    add: [],
    revise: [],
    retire: [],
    descendants: [],
    takesOver: [],
    ...overrides,
  };
}

function admit(payload: unknown) {
  return admitGraphRevision({
    draft: { payload, operationId: 'op-trusted' as OperationId, patchId: 'patch-gate' },
    current: harness.currentGraph(),
    limits: harness.limits,
    authorization: harness.authorization(),
    acceptedWorkPackageIds: [WP_A],
    dispatchedWorkPackageIds: [],
  });
}

function applyAdmitted(admitted: ReturnType<typeof admit>) {
  if (admitted.kind !== 'admitted') {
    throw new Error('测试前置失败：Admission 未通过');
  }
  return applyGraphRevision({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    revision: admitted.revision,
    current: harness.currentGraph(),
    authorizationId: 'auth-1',
    baselines: new Map([...admitted.revision.revisedWorkPackageIds, ...admitted.revision.specificationRevisionRequiredWorkPackageIds].map((id) => [id, null])),
  });
}

function reviseB(): Record<string, unknown> {
  return patch({
    revise: [
      {
        workPackageId: WP_B,
        title: 'B 修订',
        dependsOn: [{ kind: 'existing', workPackageId: WP_A }],
        scopeEnvelope: { include: ['src'], exclude: [] },
      },
    ],
    descendants: [{ workPackageId: WP_C, disposition: 'unchanged' }],
  });
}

test('gate.append-only-graph-history：追加修订不改写既有 GraphVersion', () => {
  const before = harness.currentGraph();
  applyAdmitted(admit(reviseB()));

  const versions = harness.store.query({
    kind: 'graph-versions',
    coordinationScopeId: harness.scopeId,
    graphId: harness.graphId,
  });
  if (versions.kind !== 'graph-versions') {
    throw new Error('无法读取图历史');
  }
  expect(versions.versions).toHaveLength(2);
  expect(versions.versions[0]).toEqual(before);
  expect(versions.versions[1]?.version).toBe(2 as GraphVersion);
  expect(versions.versions[1]?.parentVersion).toBe(before.version);
});

test('gate.patch-base-version-exact：基线不匹配即拒绝且不产生新版本', () => {
  const stalePayload = reviseB();
  const result = admit(stalePayload);
  expect(result.kind).toBe('admitted');
  applyAdmitted(result);

  const stale = admit(stalePayload);
  expect(stale.kind).toBe('rejected');
  if (stale.kind === 'rejected') {
    expect(stale.errors.map((entry) => entry.code)).toEqual(['base_version_mismatch']);
  }
  expect(harness.versionCount()).toBe(2);
});

test('gate.patch-descendants-enumerated：未列出的未接受后代导致补丁被拒绝', () => {
  const missing = admit(
    patch({
      revise: [
        {
          workPackageId: WP_B,
          title: 'B 修订',
          dependsOn: [{ kind: 'existing', workPackageId: WP_A }],
          scopeEnvelope: { include: ['src'], exclude: [] },
        },
      ],
    }),
  );
  expect(missing.kind).toBe('rejected');
  if (missing.kind === 'rejected') {
    expect(missing.errors.map((entry) => entry.code)).toContain('undisposed_descendant');
  }
  expect(harness.versionCount()).toBe(1);
});

test('gate.planner-result-not-committed：Planner 证据本身不构成图，模型填写的身份被丢弃', () => {
  const evidence: GraphPatchPlannerEvidence = {
    kind: 'planner-evidence',
    patchId: 'patch-gate',
    operationId: 'op-trusted' as OperationId,
    baseGraphVersion: harness.currentGraph().version,
    draftRef: 'result-gate',
    payload: reviseB(),
    committed: false,
  };
  expect(evidence.committed).toBe(false);
  expect(harness.versionCount()).toBe(1);

  const draft = graphRevisionDraftFromEvidence(evidence);
  const admitted = admit(draft.payload);
  // 证据本身不足以推进任何状态：只有 Admission 产出的修订才可提交。
  expect(harness.versionCount()).toBe(1);
  applyAdmitted(admitted);
  expect(harness.versionCount()).toBe(2);

  // 载荷自称的 operationId 与 patchId 从未进入提交：记录里是 Controller 签发的那一对。
  const record = harness.store.query({
    kind: 'graph-patch-record',
    coordinationScopeId: harness.scopeId,
    graphId: harness.graphId,
    graphVersion: 2 as GraphVersion,
  });
  expect(record.kind === 'graph-patch-record' ? record.record?.operationId : null).toBe('op-trusted');
  expect(record.kind === 'graph-patch-record' ? record.record?.patchId : null).toBe('patch-gate');
  expect(record.kind === 'graph-patch-record' ? record.record?.operationId : null).not.toBe('op-gate');
});

test('gate.revision-not-retry：规格修订要求重新准入，重试不改 contract', () => {
  const plan = planSpecificationRevision({
    request: {
      contractRevision: 2,
      changesRequirements: true,
      changesDesign: false,
      changesAcceptance: false,
      changesDependencies: false,
      changesScopeEnvelope: false,
      changesObjective: false,
    },
    workPackage: executionWorkPackage('wp-b', ['wp-a']),
    accepted: false,
    currentContractRevision: 1,
    authority: harness.authorization().manifest.permissions,
  });
  expect(plan.kind).toBe('planned');
  if (plan.kind === 'planned') {
    expect(plan.plan.reAdmissionRequired).toBe(true);
    expect(plan.plan.rerunFromRole).toBe('planner');
  }

  const specBinding = {
    provider: 'openspec',
    relativePath: 'spec.md',
    contentDigest: 'digest',
    providerVersion: '1',
    contractRevision: 1,
    trackingRevision: 1,
  };
  const taskContract = {
    schemaVersion: 1,
    workPackageId: WP_B,
    graphGeneration: harness.generation,
    dependencies: [WP_A],
    scopeEnvelope: { include: ['src'], exclude: [] },
    baselineHead: 'head-1',
    authority: harness.authorization().manifest.permissions,
    budget: {
      implementationAttempts: 2,
      validatorRepairs: 2,
      graphRevisions: 2,
      specificationRevisions: 2,
      maxRecoveriesPerWorkerAttempt: 1,
    },
    acceptanceEvidence: [],
    resultSchemaVersion: 1,
  };
  const retry = decideWorkerResultRecording({
    claimed: {
      runId: null,
      consumerGeneration: null,
      graphGeneration: null,
      authorizationId: null,
      workerTaskId: null,
      dispatchId: null,
      attemptId: null,
      role: null,
      specBinding: null,
      worktreeId: null,
    },
    trusted: {
      runId: 'run-1',
      consumerGeneration: 1,
      graphGeneration: harness.generation,
      authorizationId: 'auth-1',
      workerTaskId: 'task-1' as WorkerTaskId,
      dispatchId: 'dispatch-1' as DispatchId,
      attemptId: 'attempt-1',
      role: 'implementation',
      specBinding,
      worktreeId: 'wt-1',
      authority: harness.authorization().manifest.permissions,
      scopeEnvelope: { include: ['src'], exclude: [] },
      changedPaths: [],
    },
    attemptOutcome: 'session_lost',
    contractChange: null,
    retry: {
      allowed: true,
      reason: '基础设施原因',
      newDispatchId: 'dispatch-2' as DispatchId,
      newAttemptId: 'attempt-2',
      retryOfDispatchId: 'dispatch-1' as DispatchId,
    },
    taskContract,
    specBinding,
    budget: { implementationAttempts: 2, validatorRepairs: 2, recoveries: 1 },
    consumedBudgets: [],
  });
  expect(retry.kind).toBe('retry');
  if (retry.kind === 'retry') {
    expect(retry.plan.taskContract).toEqual(taskContract);
    expect(retry.plan.specBinding.contractRevision).toBe(1);
    expect(Object.hasOwn(retry.plan, 'reAdmissionRequired')).toBe(false);
  }
});

test('gate.hold-scope-limited：持有只冻结受影响节点与其未接受后代', () => {
  applyAdmitted(admit(reviseB()));
  const holds = harness.store.query({ kind: 'revision-holds', coordinationScopeId: harness.scopeId });
  expect(holds.kind === 'revision-holds' ? holds.holds : null).toEqual([]);
  const projection = projectRevisionPending({
    graph: harness.currentGraph().graph,
    holds: [{ workPackageId: WP_B, source: 'specification_revision', sourceRef: 'revision-gate' }],
    accepted: [WP_A],
    dependenciesSatisfied: [WP_B, WP_C, WP_D],
  });
  expect(projection.frozen).toEqual([WP_B, WP_C].sort());
  expect(projection.admissible).toEqual([WP_D]);
});

test('gate.cutover-atomic-refs：Run/基线声明与候选代际不符时整体阻断', () => {
  const refs: CandidateGenerationRefs = {
    predecessorGraphId: harness.graphId,
    candidateGraphId: 'scope-1#g9' as GraphId,
    candidateGeneration: 9 as GraphGeneration,
    candidateGraphVersion: 1 as GraphVersion,
    candidateRunId: '',
    planningCycleId: 'cycle-9' as PlanningCycleId,
    authorizationId: 'auth-9',
    authorizationVersion: 1,
    baselineHead: 'head-9',
    expectedRevision: 1,
  };
  expect(validateCutoverRefs(refs).kind).toBe('blocked');
  expect(validateCutoverRefs({ ...refs, candidateRunId: 'run-9' }).kind).toBe('ready');

  // store 侧同样拒绝：候选代际登记的是 run-candidate，声明另一个 Run 不能让切换发生。
  const candidateGraphId = 'scope-1#g9' as GraphId;
  const ensured = ensureGraphGenerationRecord({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    graphId: candidateGraphId,
    generation: 9 as GraphGeneration,
    planningCycleId: 'cycle-9' as PlanningCycleId,
    orcaRunId: 'run-candidate',
    predecessorGraphId: harness.graphId,
    baselineHead: 'head-9',
  });
  expect(ensured.kind).toBe('recorded');

  const rejected = harness.store.transact({
    kind: 'commit-generation-cutover',
    coordinationScopeId: harness.scopeId,
    expectedRevision: harness.revision(),
    writer: harness.writer,
    candidateGraphId,
    candidateGraphVersion: 1 as GraphVersion,
    planningCycleId: 'cycle-9' as PlanningCycleId,
    authorizationId: 'auth-9',
    authorizationVersion: 1,
    predecessorGraphId: harness.graphId,
    candidateRunId: 'run-other',
    baselineHead: 'head-9',
  });
  expect(rejected.kind).toBe('rejected');

  const generations = harness.store.query({
    kind: 'graph-generations',
    coordinationScopeId: harness.scopeId,
  });
  const statuses =
    generations.kind === 'graph-generations'
      ? generations.generations.map((entry) => `${entry.graphId}:${entry.status}`)
      : [];
  expect(statuses).toContain(`${candidateGraphId}:candidate`);
  expect(statuses).not.toContain(`${harness.graphId}:frozen`);
  expect(harness.currentGraph().graphId).toBe(harness.graphId);
});

test('gate.no-completion-copy-on-replan：采用旧成果不改变当前图，也不写完成状态', () => {
  const before = harness.currentGraph();
  for (const kind of ['baseline_adoption', 'migration_material', 'planning_reference'] as const) {
    const request = {
      workPackageId: WP_B,
      kind,
      adoptedResultRef: 'result-1',
      baselineHead: 'head-1',
      integrationRef: 'commit-1',
      acceptedResultRecorded: true,
      evidenceRefs: ['evidence-1'],
      evidenceStillApplicable: true,
      conflictingFacts: [],
      materialReadOnly: true,
      newWorktreeBasedOnBaseline: true,
    };
    const decision = evaluateAdoptionRequest(request);
    expect(decision.kind).toBe('adoptable');
    if (decision.kind !== 'adoptable') {
      continue;
    }
    expect(decision.plan.copiesCompletionState).toBe(false);
    expect(decision.plan.satisfiesNewWorkPackage).toBe(false);

    const recorded = recordBaselineAdoption({
      store: harness.store,
      coordinationScopeId: harness.scopeId,
      writer: harness.writer,
      adoptionId: `adoption-${kind}`,
      decision,
      request,
    });
    expect(recorded.kind, kind).toBe('recorded');
  }
  // 可观察不变量：采用只留下引用记录，当前图与图历史都没有因为「采用」而增加完成节点。
  expect(harness.currentGraph()).toEqual(before);
  expect(harness.versionCount()).toBe(1);
  const adoptions = adoptionRecords(harness.store, harness.scopeId);
  expect(adoptions.map((record) => record.state)).toEqual(['recorded', 'recorded', 'recorded']);
});

test('gate.lineage-inherits-consumed-budget：继承不重置已消耗额度', () => {
  const prior: readonly BudgetConsumption[] = [
    { workPackageId: 'wp-old' as WorkPackageId, field: 'implementationAttempts', consumed: 2 },
    { workPackageId: 'wp-old' as WorkPackageId, field: 'specificationRevisions', consumed: 1 },
  ];
  const planned = planLineage({
    workPackageId: WP_B,
    priorWorkPackageId: 'wp-old' as WorkPackageId,
    priorGraphId: 'graph-old' as GraphId,
    priorConsumed: prior,
  });
  expect(planned.kind).toBe('planned');
  if (planned.kind !== 'planned') {
    return;
  }
  expect(inheritancePreservesConsumed(planned.lineage.inherited, prior)).toBe(true);
  const effective = effectiveConsumption({
    workPackageId: WP_B,
    own: [{ workPackageId: WP_B, field: 'implementationAttempts', consumed: 1 }],
    lineage: planned.lineage,
  });
  // 可观察不变量：继承之后每个可继承字段的已消耗量都不低于旧责任的已消耗量。
  for (const entry of prior) {
    const merged = effective.find((candidate) => candidate.field === entry.field)?.consumed ?? 0;
    expect(merged, entry.field).toBeGreaterThanOrEqual(entry.consumed);
  }
  expect(effective.find((entry) => entry.field === 'implementationAttempts')?.consumed).toBe(3);
});
