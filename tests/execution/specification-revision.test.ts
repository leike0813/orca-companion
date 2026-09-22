/**
 * `m1-evolve-execution-graph` 的行为测试：Specification Revision（IC-10 / IP-4）。
 *
 * 覆盖 `execution/specification-revision` 的三个 Requirement：身份保留与重新准入后重跑完整角色链、
 * revision_pending 的有界持有，以及「修订不冒充重试」。
 */

import { afterEach, beforeEach, expect, test } from 'vitest';

import type { DispatchId, WorkerTaskId, WorkPackageId } from '../../src/application/dto/identity.js';
import { DEFAULT_EXECUTION_LIMITS } from '../../src/domain/planning/budget-policy.js';
import {
  planSpecificationRevision,
  planPreservesIdentity,
  specificationRevisionRoleChain,
  type SpecificationRevisionScope,
} from '../../src/domain/execution/specification-revision.js';
import { decideWorkerResultRecording } from '../../src/application/record-worker-result.js';
import {
  beginSpecificationRevision,
  settleSpecificationRevision,
} from '../../src/application/execution/revision-service.js';
import {
  createExecutionScopeHarness,
  executionWorkPackage,
  EXECUTION_ACCEPTED,
  EXECUTION_AUTHORIZATION_ID,
  type ExecutionScopeHarness,
} from '../support/execution-harness.js';

const WP_B = 'wp-b' as WorkPackageId;
const WP_A = 'wp-a' as WorkPackageId;

let harness: ExecutionScopeHarness;

beforeEach(() => {
  harness = createExecutionScopeHarness();
});

afterEach(() => {
  harness.close();
});

function request(overrides: Partial<SpecificationRevisionScope> = {}): SpecificationRevisionScope {
  return {
    contractRevision: 2,
    changesRequirements: true,
    changesDesign: false,
    changesAcceptance: true,
    changesDependencies: false,
    changesScopeEnvelope: false,
    changesObjective: false,
    ...overrides,
  };
}

function authority() {
  return harness.authorization().manifest.permissions;
}

test('只改契约内容时给出保留身份的修订计划', () => {
  const decision = planSpecificationRevision({
    request: request(),
    workPackage: executionWorkPackage('wp-b', ['wp-a']),
    accepted: false,
    currentContractRevision: 1,
    authority: authority(),
  });
  expect(decision.kind).toBe('planned');
  if (decision.kind !== 'planned') {
    return;
  }
  expect(decision.plan.workPackageId).toBe(WP_B);
  expect(decision.plan.preserveDependencies).toBe(true);
  expect(decision.plan.preserveScopeEnvelope).toBe(true);
  expect(decision.plan.reAdmissionRequired).toBe(true);
  expect(decision.plan.rerunFromRole).toBe('planner');
  expect(decision.plan.reuseWorktree).toBe(true);
  expect(planPreservesIdentity(decision.plan)).toBe(true);
  // 角色链从 Specification Planner 起：不是从 Implementation 重跑。
  expect(specificationRevisionRoleChain()[0]).toBe('planner');
});

test('需要改变依赖、Scope Envelope 或 objective 的请求必须走 Graph Revision', () => {
  for (const overrides of [
    { changesDependencies: true },
    { changesScopeEnvelope: true },
    { changesObjective: true },
  ] as const) {
    const decision = planSpecificationRevision({
      request: request(overrides),
      workPackage: executionWorkPackage('wp-b', ['wp-a']),
      accepted: false,
      currentContractRevision: 1,
      authority: authority(),
    });
    expect(decision.kind).toBe('requires_graph_revision');
  }
});

test('已接受节点、无内容变化与非法 revision 都被拒绝', () => {
  const accepted = planSpecificationRevision({
    request: request(),
    workPackage: executionWorkPackage('wp-a'),
    accepted: true,
    currentContractRevision: 1,
    authority: authority(),
  });
  expect(accepted.kind === 'rejected' ? accepted.code : null).toBe('already_accepted');

  const noChange = planSpecificationRevision({
    request: request({ changesRequirements: false, changesAcceptance: false }),
    workPackage: executionWorkPackage('wp-b'),
    accepted: false,
    currentContractRevision: 1,
    authority: authority(),
  });
  expect(noChange.kind === 'rejected' ? noChange.code : null).toBe('no_contract_change');

  const staleRevision = planSpecificationRevision({
    request: request({ contractRevision: 1 }),
    workPackage: executionWorkPackage('wp-b'),
    accepted: false,
    currentContractRevision: 1,
    authority: authority(),
  });
  expect(staleRevision.kind === 'rejected' ? staleRevision.code : null).toBe('invalid_contract_revision');

  const unauthorized = planSpecificationRevision({
    request: request(),
    workPackage: executionWorkPackage('wp-b'),
    accepted: false,
    currentContractRevision: 1,
    authority: { ...authority(), planner: false },
  });
  expect(unauthorized.kind === 'rejected' ? unauthorized.code : null).toBe('role_not_authorized');
});

test('修订不冒充重试：重试计划不携带 contract 变化', () => {
  const specPlan = planSpecificationRevision({
    request: request(),
    workPackage: executionWorkPackage('wp-b', ['wp-a']),
    accepted: false,
    currentContractRevision: 1,
    authority: authority(),
  });
  expect(specPlan.kind).toBe('planned');

  const specBinding = {
    provider: 'openspec',
    relativePath: 'spec.md',
    contentDigest: 'digest-1',
    providerVersion: '1.0.0',
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
    authority: authority(),
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
      authorizationId: EXECUTION_AUTHORIZATION_ID,
      workerTaskId: 'task-1' as WorkerTaskId,
      dispatchId: 'dispatch-1' as DispatchId,
      attemptId: 'attempt-1',
      role: 'implementation',
      specBinding,
      worktreeId: 'wt-1',
      authority: authority(),
      scopeEnvelope: { include: ['src'], exclude: [] },
      changedPaths: [],
    },
    attemptOutcome: 'session_lost',
    contractChange: null,
    retry: {
      allowed: true,
      reason: '基础设施原因确定失败',
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
  if (retry.kind !== 'retry') {
    return;
  }
  // 重试沿用原 contract 与 revision：没有重新准入，也没有角色链重跑。
  expect(retry.plan.taskContract).toEqual(taskContract);
  expect(retry.plan.specBinding.contractRevision).toBe(1);
  expect(retry.plan.independentFromPreviousSession).toBe(true);
  expect(Object.hasOwn(retry.plan, 'reAdmissionRequired')).toBe(false);
  expect(Object.hasOwn(retry.plan, 'rerunFromRole')).toBe(false);
});

test('开始修订时置入有界持有，并给出从 Specification Planner 起的任务计划', () => {
  const decision = planSpecificationRevision({
    request: request(),
    workPackage: executionWorkPackage('wp-b', ['wp-a']),
    accepted: false,
    currentContractRevision: 1,
    authority: authority(),
  });
  if (decision.kind !== 'planned') {
    throw new Error('测试前置失败');
  }
  const begun = beginSpecificationRevision({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    plan: decision.plan,
    revisionId: 'revision-1',
    manifest: harness.authorization().manifest,
    consumption: [],
    baseline: { requiredBaselineHead: 'head-1', worktreeBaseHead: 'head-1', relation: 'equal' },
  });
  expect(begun.kind).toBe('started');
  if (begun.kind !== 'started') {
    return;
  }
  expect(begun.taskPlan.role).toBe('planner');
  expect(begun.taskPlan.reAdmissionRequired).toBe(true);
  expect(begun.allowance.remaining).toBe(2);

  const holds = harness.store.query({ kind: 'revision-holds', coordinationScopeId: harness.scopeId });
  expect(holds.kind === 'revision-holds' ? holds.holds : null).toEqual([
    expect.objectContaining({ workPackageId: WP_B, source: 'specification_revision', state: 'pending' }),
  ]);
});

test('额度耗尽时阻塞修订', () => {
  const decision = planSpecificationRevision({
    request: request(),
    workPackage: executionWorkPackage('wp-b', ['wp-a']),
    accepted: false,
    currentContractRevision: 1,
    authority: authority(),
  });
  if (decision.kind !== 'planned') {
    throw new Error('测试前置失败');
  }
  const begun = beginSpecificationRevision({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    plan: decision.plan,
    revisionId: 'revision-1',
    manifest: harness.authorization().manifest,
    consumption: [{ workPackageId: WP_B, field: 'specificationRevisions', consumed: 2 }],
    baseline: null,
  });
  expect(begun.kind).toBe('exhausted');
  expect(harness.store.query({ kind: 'revision-holds', coordinationScopeId: harness.scopeId })).toMatchObject({
    holds: [],
  });
});

test('基线落后时先建立独立的 Baseline Reconciliation 任务', () => {
  const decision = planSpecificationRevision({
    request: request(),
    workPackage: executionWorkPackage('wp-b', ['wp-a']),
    accepted: false,
    currentContractRevision: 1,
    authority: authority(),
  });
  if (decision.kind !== 'planned') {
    throw new Error('测试前置失败');
  }
  const begun = beginSpecificationRevision({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    plan: decision.plan,
    revisionId: 'revision-1',
    manifest: harness.authorization().manifest,
    consumption: [],
    baseline: { requiredBaselineHead: 'base-2', worktreeBaseHead: 'head-1', relation: 'behind' },
  });
  expect(begun.kind).toBe('baseline_reconciliation_required');
  if (begun.kind !== 'baseline_reconciliation_required') {
    return;
  }
  expect(begun.reconciliation.role).toBe('planner');
  expect(begun.reconciliation.independentFromImplementation).toBe(true);
  expect(begun.reconciliation.requiredBaselineHead).toBe('base-2');

  const reconciliations = harness.store.query({
    kind: 'baseline-reconciliations',
    coordinationScopeId: harness.scopeId,
  });
  expect(reconciliations.kind === 'baseline-reconciliations' ? reconciliations.reconciliations : null).toEqual([
    expect.objectContaining({ workPackageId: WP_B, role: 'planner', state: 'required' }),
  ]);
});

test('重新准入通过才消耗额度并解除持有；同一次收尾重放不重复扣减', () => {
  const decision = planSpecificationRevision({
    request: request(),
    workPackage: executionWorkPackage('wp-b', ['wp-a']),
    accepted: false,
    currentContractRevision: 1,
    authority: authority(),
  });
  if (decision.kind !== 'planned') {
    throw new Error('测试前置失败');
  }
  const begun = beginSpecificationRevision({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    plan: decision.plan,
    revisionId: 'revision-1',
    manifest: harness.authorization().manifest,
    consumption: [],
    baseline: null,
  });
  expect(begun.kind).toBe('started');

  const settled = settleSpecificationRevision({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    plan: decision.plan,
    revisionId: 'revision-1',
    authorizationId: EXECUTION_AUTHORIZATION_ID,
    admission: { kind: 'admitted' },
  });
  expect(settled.kind).toBe('accepted');
  if (settled.kind !== 'accepted') {
    return;
  }
  expect(settled.nextRole).toBe('implementation');

  const counters = harness.store.query({ kind: 'budget-counters', coordinationScopeId: harness.scopeId });
  const consumed =
    counters.kind === 'budget-counters'
      ? counters.counters.find((counter) => counter.budgetKey.endsWith(':specificationRevisions'))
      : undefined;
  expect(consumed?.consumed).toBe(1);

  // 重放同一次收尾：持有已释放，额度不再变化。
  const replay = settleSpecificationRevision({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    plan: decision.plan,
    revisionId: 'revision-1',
    authorizationId: EXECUTION_AUTHORIZATION_ID,
    admission: { kind: 'admitted' },
  });
  expect(replay.kind).toBe('accepted');
  const after = harness.store.query({ kind: 'budget-counters', coordinationScopeId: harness.scopeId });
  const stillConsumed =
    after.kind === 'budget-counters'
      ? after.counters.find((counter) => counter.budgetKey.endsWith(':specificationRevisions'))
      : undefined;
  expect(stillConsumed?.consumed).toBe(1);
});

test('准入未通过时持有保持 pending 且不消耗额度', () => {
  const decision = planSpecificationRevision({
    request: request(),
    workPackage: executionWorkPackage('wp-b', ['wp-a']),
    accepted: false,
    currentContractRevision: 1,
    authority: authority(),
  });
  if (decision.kind !== 'planned') {
    throw new Error('测试前置失败');
  }
  beginSpecificationRevision({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    plan: decision.plan,
    revisionId: 'revision-1',
    manifest: harness.authorization().manifest,
    consumption: [],
    baseline: null,
  });
  const settled = settleSpecificationRevision({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    plan: decision.plan,
    revisionId: 'revision-1',
    authorizationId: EXECUTION_AUTHORIZATION_ID,
    admission: { kind: 'rejected', message: 'scope envelope 越界' },
  });
  expect(settled.kind).toBe('kept_pending');
  const holds = harness.store.query({ kind: 'revision-holds', coordinationScopeId: harness.scopeId });
  expect(holds.kind === 'revision-holds' ? holds.holds[0]?.state : null).toBe('pending');
  const counters = harness.store.query({ kind: 'budget-counters', coordinationScopeId: harness.scopeId });
  expect(counters.kind === 'budget-counters' ? counters.counters : null).toEqual([]);
});

test('收尾必须匹配持有来源：另一次修订的收尾不能释放别人的持有', () => {
  const decision = planSpecificationRevision({
    request: request(),
    workPackage: executionWorkPackage('wp-b', ['wp-a']),
    accepted: false,
    currentContractRevision: 1,
    authority: authority(),
  });
  if (decision.kind !== 'planned') {
    throw new Error('测试前置失败');
  }
  beginSpecificationRevision({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    plan: decision.plan,
    revisionId: 'revision-1',
    manifest: harness.authorization().manifest,
    consumption: [],
    baseline: null,
  });

  const mismatched = settleSpecificationRevision({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    plan: decision.plan,
    revisionId: 'revision-2',
    authorizationId: EXECUTION_AUTHORIZATION_ID,
    admission: { kind: 'admitted' },
  });
  expect(mismatched.kind).toBe('rejected');
  const holds = harness.store.query({ kind: 'revision-holds', coordinationScopeId: harness.scopeId });
  expect(holds.kind === 'revision-holds' ? holds.holds[0]?.state : null).toBe('pending');
  const counters = harness.store.query({ kind: 'budget-counters', coordinationScopeId: harness.scopeId });
  expect(counters.kind === 'budget-counters' ? counters.counters : null).toEqual([]);
});

test('重启后额度从已消耗值继续计数', () => {
  const consumption = [{ workPackageId: WP_B, field: 'specificationRevisions' as const, consumed: 1 }];
  const decision = planSpecificationRevision({
    request: request({ contractRevision: 3 }),
    workPackage: executionWorkPackage('wp-b', ['wp-a']),
    accepted: false,
    currentContractRevision: 2,
    authority: authority(),
  });
  if (decision.kind !== 'planned') {
    throw new Error('测试前置失败');
  }
  const begun = beginSpecificationRevision({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    plan: decision.plan,
    revisionId: 'revision-2',
    manifest: harness.authorization().manifest,
    consumption,
    baseline: null,
  });
  expect(begun.kind).toBe('started');
  if (begun.kind === 'started') {
    expect(begun.allowance.consumed).toBe(1);
    expect(begun.allowance.remaining).toBe(1);
  }
  expect(DEFAULT_EXECUTION_LIMITS.specificationRevisions).toBe(2);
  expect(EXECUTION_ACCEPTED).toEqual([WP_A]);
});
