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
  settleRetiredRevision,
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
      integrationReconciliations: 2,
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
    request: {
      kind: 'planned_content_revision',
      plan: decision.plan,
      revisionId: 'revision-1',
      priorContractRevision: 1,
    },
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
    request: {
      kind: 'planned_content_revision',
      plan: decision.plan,
      revisionId: 'revision-1',
      priorContractRevision: 1,
    },
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
    request: {
      kind: 'planned_content_revision',
      plan: decision.plan,
      revisionId: 'revision-1',
      priorContractRevision: 1,
    },
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
    request: {
      kind: 'planned_content_revision',
      plan: decision.plan,
      revisionId: 'revision-1',
      priorContractRevision: 1,
    },
    manifest: harness.authorization().manifest,
    consumption: [],
    baseline: null,
  });
  expect(begun.kind).toBe('started');

  const settled = settleSpecificationRevision({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    workPackageId: decision.plan.workPackageId,
    sourceRef: 'revision-1',
    admittedContractRevision: decision.plan.contractRevision,
    authorizationId: EXECUTION_AUTHORIZATION_ID,
    approvedLimit: harness.authorization().manifest.limits.specificationRevisions,
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
    workPackageId: decision.plan.workPackageId,
    sourceRef: 'revision-1',
    admittedContractRevision: decision.plan.contractRevision,
    authorizationId: EXECUTION_AUTHORIZATION_ID,
    approvedLimit: harness.authorization().manifest.limits.specificationRevisions,
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
    request: {
      kind: 'planned_content_revision',
      plan: decision.plan,
      revisionId: 'revision-1',
      priorContractRevision: 1,
    },
    manifest: harness.authorization().manifest,
    consumption: [],
    baseline: null,
  });
  const settled = settleSpecificationRevision({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    workPackageId: decision.plan.workPackageId,
    sourceRef: 'revision-1',
    admittedContractRevision: decision.plan.contractRevision,
    authorizationId: EXECUTION_AUTHORIZATION_ID,
    approvedLimit: harness.authorization().manifest.limits.specificationRevisions,
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
    request: {
      kind: 'planned_content_revision',
      plan: decision.plan,
      revisionId: 'revision-1',
      priorContractRevision: 1,
    },
    manifest: harness.authorization().manifest,
    consumption: [],
    baseline: null,
  });

  const mismatched = settleSpecificationRevision({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    workPackageId: decision.plan.workPackageId,
    sourceRef: 'revision-2',
    admittedContractRevision: decision.plan.contractRevision,
    authorizationId: EXECUTION_AUTHORIZATION_ID,
    approvedLimit: harness.authorization().manifest.limits.specificationRevisions,
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
    request: {
      kind: 'planned_content_revision',
      plan: decision.plan,
      revisionId: 'revision-2',
      priorContractRevision: 2,
    },
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

test('退休结算：节点已退场即释放持有，仍在图里则保持 pending', () => {
  const recorded = harness.store.transact({
    kind: 'record-revision-hold',
    coordinationScopeId: harness.scopeId,
    expectedRevision: harness.revision(),
    writer: harness.writer,
    workPackageId: WP_A,
    source: 'graph_patch',
    sourceRef: 'graph-patch:test',
  });
  expect(recorded.kind).toBe('committed');
  const holds = () => {
    const queried = harness.store.query({ kind: 'revision-holds', coordinationScopeId: harness.scopeId });
    return queried.kind === 'revision-holds' ? queried.holds : [];
  };
  expect(holds()).toEqual([expect.objectContaining({ workPackageId: WP_A, state: 'pending' })]);

  const settle = (workPackageIds: readonly WorkPackageId[]) =>
    settleRetiredRevision({
      store: harness.store,
      coordinationScopeId: harness.scopeId,
      writer: harness.writer,
      workPackageId: WP_A,
      currentGraphWorkPackageIds: workPackageIds,
    });

  // 仍在图里的节点不属于退休：保持持有，等规格重新准入解除。
  expect(settle([WP_A, WP_B]).kind).toBe('kept_pending');
  expect(holds()).toEqual([expect.objectContaining({ workPackageId: WP_A, state: 'pending' })]);

  // 节点已退场：退休已生效，释放持有（兜底修复历史遗留行，不消耗修订额度）。
  expect(settle([WP_B]).kind).toBe('released');
  expect(holds()).toEqual([expect.objectContaining({ workPackageId: WP_A, state: 'released' })]);
});

/* -------------------------------------------------------------------------- */
/* 在途 Graph Patch 修订：续办、准备旧内容版本与按补丁身份结算                    */
/* -------------------------------------------------------------------------- */

/** 一条与图版本同事务写下的补丁持有：续办路径的对象。 */
function recordPatchHold(sourceRef = 'patch-1'): void {
  const recorded = harness.store.transact({
    kind: 'record-revision-hold',
    coordinationScopeId: harness.scopeId,
    expectedRevision: harness.revision(),
    writer: harness.writer,
    workPackageId: WP_B,
    source: 'graph_patch',
    sourceRef,
  });
  expect(recorded.kind).toBe('committed');
}

function beginInFlight(sourceRef = 'patch-1', priorContractRevision: number | null = 2) {
  return beginSpecificationRevision({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    request: {
      kind: 'in_flight_graph_patch',
      workPackageId: WP_B,
      sourceRef,
      priorContractRevision,
    },
    manifest: harness.authorization().manifest,
    consumption: [],
    baseline: null,
  });
}

function pendingHold() {
  const holds = harness.store.query({ kind: 'revision-holds', coordinationScopeId: harness.scopeId });
  return holds.kind === 'revision-holds' ? holds.holds[0] : undefined;
}

test('在途补丁修订：准备被替换的内容版本，持有保持 pending 且额度不变', () => {
  recordPatchHold();
  const begun = beginInFlight();

  expect(begun.kind).toBe('started');
  if (begun.kind !== 'started') {
    return;
  }
  expect(begun.taskPlan.role).toBe('planner');
  expect(begun.taskPlan.revisionId).toBe('patch-1');
  expect(begun.taskPlan.priorContractRevision).toBe(2);
  expect(begun.allowance.remaining).toBe(2);
  // 准备不是结算：持有仍冻结该节点，额度也还没有被消耗。
  expect(pendingHold()).toMatchObject({
    source: 'graph_patch',
    sourceRef: 'patch-1',
    state: 'pending',
    priorContractRevision: 2,
    admittedContractRevision: null,
  });
  const counters = harness.store.query({ kind: 'budget-counters', coordinationScopeId: harness.scopeId });
  expect(counters.kind === 'budget-counters' ? counters.counters : null).toEqual([]);
});

test('在途分支只认匹配的补丁持有：没有持有或来源不符都阻塞', () => {
  const absent = beginInFlight();
  expect(absent.kind === 'rejected' ? absent.code : null).toBe('revision_hold_absent');

  recordPatchHold('patch-1');
  const mismatched = beginInFlight('patch-2');
  expect(mismatched.kind === 'rejected' ? mismatched.code : null).toBe('revision_hold_mismatch');
  expect(pendingHold()?.priorContractRevision).toBeNull();
});

test('已准备的旧内容版本是 durable 事实：重新读到的值不同即阻塞，相同则幂等', () => {
  recordPatchHold();
  expect(beginInFlight('patch-1', 2).kind).toBe('started');

  const drifted = beginInFlight('patch-1', 5);
  expect(drifted.kind === 'rejected' ? drifted.code : null).toBe('revision_prior_conflict');
  expect(pendingHold()?.priorContractRevision).toBe(2);

  const replay = beginInFlight('patch-1', 2);
  expect(replay.kind).toBe('started');
  if (replay.kind === 'started') {
    // 重放读回记录里的同一个值，而不是调用方给的那一份。
    expect(replay.taskPlan.priorContractRevision).toBe(2);
  }
});

test('在途修订的结算按补丁身份释放持有、记录接纳版本并恰计一次额度', () => {
  recordPatchHold();
  expect(beginInFlight('patch-1', 2).kind).toBe('started');
  const settle = (sourceRef: string, admittedContractRevision: number) =>
    settleSpecificationRevision({
      store: harness.store,
      coordinationScopeId: harness.scopeId,
      writer: harness.writer,
      workPackageId: WP_B,
      sourceRef,
      admittedContractRevision,
      authorizationId: EXECUTION_AUTHORIZATION_ID,
      approvedLimit: harness.authorization().manifest.limits.specificationRevisions,
      admission: { kind: 'admitted' },
    });

  const settled = settle('patch-1', 3);
  expect(settled.kind).toBe('accepted');
  expect(pendingHold()).toMatchObject({
    state: 'released',
    priorContractRevision: 2,
    admittedContractRevision: 3,
  });
  const consumed = () => {
    const counters = harness.store.query({ kind: 'budget-counters', coordinationScopeId: harness.scopeId });
    return counters.kind === 'budget-counters'
      ? counters.counters.find((counter) => counter.budgetKey.endsWith(':specificationRevisions'))?.consumed
      : undefined;
  };
  expect(consumed()).toBe(1);

  // 重放同一次重新准入：幂等，额度不再增加。
  expect(settle('patch-1', 3).kind).toBe('accepted');
  expect(consumed()).toBe(1);
  // 另一次修订的收尾不能释放本次持有，也不能改写接纳版本。
  expect(settle('patch-2', 4).kind).toBe('rejected');
  expect(pendingHold()?.admittedContractRevision).toBe(3);
});

test('在途修订的准入未通过时持有保持 pending 且零写入', () => {
  recordPatchHold();
  expect(beginInFlight('patch-1', 2).kind).toBe('started');
  const kept = settleSpecificationRevision({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    workPackageId: WP_B,
    sourceRef: 'patch-1',
    admittedContractRevision: 3,
    authorizationId: EXECUTION_AUTHORIZATION_ID,
    approvedLimit: harness.authorization().manifest.limits.specificationRevisions,
    admission: { kind: 'rejected', message: 'scope envelope 越界' },
  });
  expect(kept.kind).toBe('kept_pending');
  expect(pendingHold()).toMatchObject({ state: 'pending', admittedContractRevision: null });
  const counters = harness.store.query({ kind: 'budget-counters', coordinationScopeId: harness.scopeId });
  expect(counters.kind === 'budget-counters' ? counters.counters : null).toEqual([]);
});
