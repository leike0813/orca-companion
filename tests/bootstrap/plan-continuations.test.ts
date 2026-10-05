/**
 * 生产事实读取器与 propose 预检的接线测试（`m1-evolve-execution-graph` Extend / MOD-07）。
 *
 * 事实层走真实路径：真实 Coordination Store、真实候选图编译与落盘、真实的采用/lineage 记录；只有
 * Orca backend、只读 Git 与 tracker 是替身。断言的重点是「事实绝不伪造」：被引用的接受记录必须能被
 * Orca 回读核验、证据必须仍然适用、旧责任额度必须原样继承，任一不可证明都不产生外部副作用。
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { openCoordinationStore, type CoordinationStore } from '../../src/adapters/storage/coordination-store.js';
import { acquireExecutionLease, acquireRuntimeLease } from '../../src/application/coordination/lease-service.js';
import { initializeCoordinationScope } from '../../src/application/planning/initialize-scope.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  DispatchId,
  GraphGeneration,
  GraphId,
  OperationId,
  PlanningCycleId,
  RuntimeIncarnationId,
  WorkerTaskId,
  WorkPackageId,
} from '../../src/application/dto/identity.js';
import type {
  CoordinationCommand,
  CoordinationCommandResult,
  CoordinationWriter,
} from '../../src/application/ports/branch-coordination-store.js';
import type {
  ExecutionBackend,
  ExecutionMutation,
  ExecutionQuery,
} from '../../src/application/ports/execution-backend.js';
import { resultDigest } from '../../src/application/delivery/process-delivery.js';
import { integrationOperationIdsFor } from '../../src/application/integrate-work-package.js';
import {
  adoptionRecords,
  effectiveBudgetConsumption,
  loadLineage,
  preflightPlanContinuations,
} from '../../src/application/execution/baseline-adoption.js';
import { DEFAULT_EXECUTION_LIMITS } from '../../src/domain/planning/budget-policy.js';
import type { ExecutionGraph, ImplementationPlan, PlannedAdoption } from '../../src/domain/planning/execution-graph.js';
import { graphIdFor } from '../../src/application/planning/graph-generation.js';
import { workPackageIdFor } from '../../src/domain/planning/graph-compiler.js';
import { proposeExecutionGraph } from '../../src/bootstrap/execution-runtime.js';
import {
  createPlanContinuationFactReader,
  createPlanContinuationGitPort,
  type PlanContinuationGitPort,
  type PlanContinuationFactReaderFactory,
} from '../../src/bootstrap/plan-continuations.js';

const SCOPE = 'scope-continuations' as CoordinationScopeId;
const SESSION = 'session-continuations' as CoordinatorSessionId;
const INCARNATION = 'incarnation-continuations' as RuntimeIncarnationId;
const CYCLE = 'cycle-continuations' as PlanningCycleId;
const BASELINE = 'head-1';
const PUSH_INTENT = integrationOperationIdsFor({
  scopeId: SCOPE,
  graphId: graphIdFor(SCOPE, 1 as GraphGeneration),
  generation: 1,
  workPackageId: workPackageIdFor(graphIdFor(SCOPE, 1 as GraphGeneration), 'wp-a'),
}).push;

let directory = '';
let store: CoordinationStore;
let writer: CoordinationWriter;

const clock = (): number => 1_000;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-continuations-'));
  const opened = openCoordinationStore({ databasePath: join(directory, 'coordination.sqlite'), clock });
  if (opened.kind !== 'opened') throw new Error(`无法打开 store：${opened.message}`);
  store = opened.store;
  const initialized = initializeCoordinationScope({
    store,
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION,
    coordinatorModelConfigurationRef: 'config-1',
    planningCycleId: CYCLE,
    fullBranchRef: 'refs/heads/main',
    canonicalWorktreePath: '/tmp/canonical',
  });
  if (initialized.kind !== 'initialized') {
    throw new Error(`无法初始化 Scope：${initialized.code} ${initialized.message}`);
  }
  const acquired = acquireRuntimeLease(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION,
    runtimeIncarnationId: INCARNATION,
    fencingGeneration: 0,
  });
  if (acquired.kind !== 'acquired') throw new Error('无法取得 Runtime Lease');
  writer = {
    coordinatorSessionId: SESSION,
    runtimeIncarnationId: INCARNATION,
    fencingGeneration: acquired.lease.fencingGeneration,
  };
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

function scopeRevision(): number {
  const read = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  if (read.kind !== 'scope' || read.scope === null) throw new Error('Scope 不存在');
  return read.scope.revision;
}

function transact(build: (expectedRevision: number) => CoordinationCommand): CoordinationCommandResult {
  return store.transact(build(scopeRevision()));
}

/** 结算记录只能由 Execution Coordination Lease 持有者写入；这里取得同一 Session 的租约。 */
function acquireExecutionLeaseForTest(): void {
  const acquired = acquireExecutionLease(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION,
    runtimeIncarnationId: INCARNATION,
    fencingGeneration: writer.fencingGeneration,
  });
  if (acquired.kind !== 'acquired') throw new Error(`无法取得 Execution Lease：${JSON.stringify(acquired)}`);
}

function plan(planRevision: number, workPackages: readonly Record<string, unknown>[]): unknown {
  return {
    planRevision,
    destinationRef: { kind: 'destination', id: 'destination-1', version: 1 },
    workPackages: workPackages.map((workPackage, index) => ({
      key: typeof workPackage['key'] === 'string' ? workPackage['key'] : `wp-${String(index + 1)}`,
      title: '工作包',
      dependsOn: [],
      scopeEnvelope: { include: ['src'], exclude: [] },
      ...workPackage,
    })),
  };
}

function fakeBackend(tasks: readonly { readonly id: string; readonly status: string; readonly result: unknown }[] = []): {
  readonly backend: ExecutionBackend;
  readonly mutations: readonly ExecutionMutation[];
} {
  const mutations: ExecutionMutation[] = [];
  let currentRun = '';
  let runCounter = 0;
  const backend: ExecutionBackend = {
    query: (input: ExecutionQuery) => {
      if (input.operation === 'run-current') {
        return Promise.resolve({ kind: 'accepted', value: { run: { runId: currentRun } } });
      }
      if (input.operation === 'task-list') {
        return Promise.resolve({ kind: 'accepted', value: { tasks: [...tasks] } });
      }
      return Promise.resolve({ kind: 'rejected', code: 'unregistered_fake_query', message: input.operation });
    },
    mutate: (input: ExecutionMutation, scope) => {
      mutations.push(input);
      if (input.operation === 'run-create') {
        runCounter += 1;
        currentRun = `run-${String(runCounter)}`;
        return Promise.resolve({
          kind: 'accepted',
          operation: { operationId: scope.operationId, target: scope.target },
          value: { run: { runId: currentRun } },
        });
      }
      return Promise.resolve({ kind: 'rejected', code: 'unregistered_fake_mutation', message: input.operation });
    },
  };
  return { backend, mutations };
}

/** 只读 Git 替身：`paths` 省略表示读旧集成 commit 改动的路径，给出时表示比较该路径集。 */
function fakeGit(input: { readonly touched: readonly string[]; readonly since: readonly string[] }): PlanContinuationGitPort {
  return {
    isAncestor: () => Promise.resolve({ kind: 'ancestor' as const }),
    changedPaths: ({ paths }) =>
      Promise.resolve({ kind: 'listed' as const, paths: paths === undefined ? input.touched : input.since }),
  };
}

async function propose(
  target: ReturnType<typeof fakeBackend>,
  body: unknown,
  extra: {
    readonly planContinuationFacts?: PlanContinuationFactReaderFactory;
    readonly canonicalWorktreePath?: string;
  } = {},
): Promise<Awaited<ReturnType<typeof proposeExecutionGraph>>> {
  return proposeExecutionGraph({
    store,
    backend: target.backend,
    coordinationScopeId: SCOPE,
    writer,
    backendIdentityRef: 'identity-ref',
    timeoutMs: 1_000,
    authority: { kind: 'route_planning' },
    plan: body,
    limits: DEFAULT_EXECUTION_LIMITS,
    baselineHead: BASELINE,
    objective: 'compile candidate',
    ...(extra.canonicalWorktreePath === undefined ? {} : { canonicalWorktreePath: extra.canonicalWorktreePath }),
    ...(extra.planContinuationFacts === undefined ? {} : { planContinuationFacts: extra.planContinuationFacts }),
  });
}

function generationOneWorkPackageId(key: string): WorkPackageId {
  return workPackageIdFor(graphIdFor(SCOPE, 1 as GraphGeneration), key);
}

function recordOriginalBinding(suffix: string, workPackageId = generationOneWorkPackageId('wp-a')): void {
  const result = transact((expectedRevision) => ({
    kind: 'record-materialization-binding',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer,
    workPackageId,
    role: 'validator',
    workerTaskId: `task-${suffix}` as WorkerTaskId,
    dispatchId: `envelope-dispatch-${suffix}` as DispatchId,
    attemptId: `attempt-${suffix}`,
    worktreeId: 'worktree-old',
    specBinding: {
      provider: 'openspec', relativePath: 'openspec/changes/old', contentDigest: 'spec-digest',
      providerVersion: '1', contractRevision: 1, trackingRevision: 1,
    },
    specificationUnitPath: null,
    authorizationId: 'auth-old',
    authorizationVersion: 1,
    workerProfileRef: 'profile-validator',
    orcaTaskId: `task-${suffix}`,
    launchId: `launch-${suffix}`,
    creationOperationId: `create-${suffix}` as OperationId,
  }));
  expect(result.kind).toBe('committed');
  const segment = transact(expectedRevision => ({ kind: 'record-session-segment', coordinationScopeId: SCOPE,
    expectedRevision, writer, segmentId: `segment-${suffix}` as never, workPackageId, role: 'validator',
    workerTaskId: `task-${suffix}` as WorkerTaskId, dispatchId: `dispatch-${suffix}` as DispatchId,
    attemptId: `attempt-${suffix}`, sessionBindingId: `session-${suffix}`, lastTranscriptRef: `transcript-${suffix}`,
    terminalReceiptRef: null, transcriptReferenceable: true, verifiable: true }));
  expect(segment.kind).toBe('committed');
}

/** 记录一版不含采用/延续声明的图，作为旧代际。 */
async function proposeInitialGraph(keys: readonly string[] = ['wp-a']): Promise<void> {
  const backend = fakeBackend();
  const recorded = await propose(backend, plan(1, keys.map((key) => ({ key }))));
  if (recorded.kind !== 'recorded') throw new Error(`初始候选图未记录：${JSON.stringify(recorded)}`);
  expect(backend.mutations.map((mutation) => mutation.operation)).toEqual(['run-create']);
}

test('Baseline Adoption：接受记录经 Orca 回读核验、push 意图证据仍适用才可采用', async () => {
  await proposeInitialGraph();
  const acceptedValue = { summary: 'done' };
  acquireExecutionLeaseForTest();
  recordOriginalBinding('old');
  const digestPrefix = resultDigest(acceptedValue).slice(0, 13);
  const resultRef = `task-old#${digestPrefix}`;
  expect(
    transact((expectedRevision) => ({
      kind: 'record-delivery-settlement',
      coordinationScopeId: SCOPE,
      expectedRevision,
      writer,
      dedupeKey: 'settle-old',
      deliveryId: 'delivery-old',
      runId: 'run-1',
      consumerGeneration: 1,
      workerTaskId: 'task-old' as WorkerTaskId,
      dispatchId: 'dispatch-old' as DispatchId,
      attemptId: 'attempt-old',
      role: 'validator',
      contractRevision: 1,
      orcaResultRef: resultRef,
      outcome: 'succeeded',
    })).kind,
  ).toBe('committed');
  expect(
    transact((expectedRevision) => ({
      kind: 'begin-intent',
      coordinationScopeId: SCOPE,
      expectedRevision,
      writer,
      operationId: PUSH_INTENT,
      target: { kind: 'work-package', id: generationOneWorkPackageId('wp-a') },
      operationCategory: 'git-integration',
      expectedHead: 'old-commit',
    })).kind,
  ).toBe('committed');
  expect(
    transact((expectedRevision) => ({
      kind: 'settle-intent',
      coordinationScopeId: SCOPE,
      expectedRevision,
      writer,
      operationId: PUSH_INTENT,
      outcomeClass: 'accepted',
    })).kind,
  ).toBe('committed');

  const adoption: PlannedAdoption = {
    kind: 'baseline_adoption',
    adoptedResultRef: resultRef,
    baselineHead: BASELINE,
    integrationRef: PUSH_INTENT,
    evidenceRefs: ['evidence-1'],
  };
  const graph: ExecutionGraph = { graphId: graphIdFor(SCOPE, 2 as GraphGeneration), generation: 2 as GraphGeneration, workPackages: [] };
  const readerPlan: ImplementationPlan = {
    planRevision: 2,
    destinationRef: { kind: 'destination', id: 'destination-1', version: 1 },
    workPackages: [
      { key: 'wp-a', title: 'a', dependsOn: [], scopeEnvelope: { include: ['src/a.ts'], exclude: [] }, adoption },
    ],
  };
  const workPackageId = workPackageIdFor(graph.graphId, 'wp-a');
  const read = (since: readonly string[]) =>
    createPlanContinuationFactReader({
      store,
      backend: fakeBackend([{ id: 'task-old', status: 'completed', result: acceptedValue }]).backend,
      coordinationScopeId: SCOPE,
      backendIdentityRef: 'identity-ref',
      baselineHead: BASELINE,
      plan: readerPlan,
      graph,
      canonicalWorktreePath: '/tmp/canonical',
      git: fakeGit({ touched: ['src/a.ts'], since }),
    })(workPackageId);

  const applicable = await read([]);
  expect(applicable).toMatchObject({
    acceptedResultRecorded: true,
    evidenceStillApplicable: true,
    conflictingFacts: [],
  });

  // 旧集成 commit 改动的路径在当前基线上被改动：证据不再适用，但这不是矛盾。
  const stale = await read(['src/a.ts']);
  expect(stale).toMatchObject({ acceptedResultRecorded: true, evidenceStillApplicable: false, conflictingFacts: [] });
});

test('Baseline Adoption：Orca 回读结果与接受记录不一致时按矛盾事实阻塞', async () => {
  await proposeInitialGraph();
  acquireExecutionLeaseForTest();
  recordOriginalBinding('old');
  const resultRef = `task-old#${resultDigest({ summary: 'expected' }).slice(0, 13)}`;
  transact((expectedRevision) => ({
    kind: 'record-delivery-settlement',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer,
    dedupeKey: 'settle-conflict',
    deliveryId: 'delivery-conflict',
    runId: 'run-1',
    consumerGeneration: 1,
    workerTaskId: 'task-old' as WorkerTaskId,
    dispatchId: 'dispatch-old' as DispatchId,
    attemptId: 'attempt-old',
    role: 'validator',
    contractRevision: 1,
    orcaResultRef: resultRef,
    outcome: 'succeeded',
  }));
  const graph: ExecutionGraph = { graphId: graphIdFor(SCOPE, 2 as GraphGeneration), generation: 2 as GraphGeneration, workPackages: [] };
  const readerPlan: ImplementationPlan = {
    planRevision: 2,
    destinationRef: { kind: 'destination', id: 'destination-1', version: 1 },
    workPackages: [
      {
        key: 'wp-a',
        title: 'a',
        dependsOn: [],
        scopeEnvelope: { include: ['src/a.ts'], exclude: [] },
        adoption: { kind: 'baseline_adoption', adoptedResultRef: resultRef, baselineHead: BASELINE, evidenceRefs: ['e'] },
      },
    ],
  };
  const facts = await createPlanContinuationFactReader({
    store,
    backend: fakeBackend([{ id: 'task-old', status: 'completed', result: { summary: 'different' } }]).backend,
    coordinationScopeId: SCOPE,
    backendIdentityRef: 'identity-ref',
    baselineHead: BASELINE,
    plan: readerPlan,
    graph,
    canonicalWorktreePath: '/tmp/canonical',
    git: fakeGit({ touched: ['src/a.ts'], since: [] }),
  })(workPackageIdFor(graph.graphId, 'wp-a'));
  expect(facts?.acceptedResultRecorded).toBe(false);
  expect(facts?.conflictingFacts.join('|')).toContain('回读结果摘要');
});

test('Lineage：旧责任额度经 effectiveConsumption 继承，propose 落盘后不重置', async () => {
  await proposeInitialGraph();
  const priorWorkPackageId = generationOneWorkPackageId('wp-a');
  // 旧责任自身已通过更早的 lineage 继承 1 次实现尝试：读取端必须把「自身计数 + 继承」一起给出。
  expect(
    transact((expectedRevision) => ({
      kind: 'record-work-package-lineage',
      coordinationScopeId: SCOPE,
      expectedRevision,
      writer,
      workPackageId: priorWorkPackageId,
      priorWorkPackageId: 'legacy-wp' as WorkPackageId,
      priorGraphId: 'legacy-graph' as GraphId,
      inherited: [{ field: 'implementationAttempts', consumed: 1 }],
    })).kind,
  ).toBe('committed');

  const backend = fakeBackend();
  const recorded = await propose(
    backend,
    plan(2, [
      {
        key: 'wp-b',
        lineage: { priorWorkPackageId, priorGraphId: graphIdFor(SCOPE, 1 as GraphGeneration) },
      },
    ]),
  );
  if (recorded.kind !== 'recorded') throw new Error(`lineage 候选图未记录：${JSON.stringify(recorded)}`);
  expect(backend.mutations.map((mutation) => mutation.operation)).toEqual(['run-create']);

  const newWorkPackageId = workPackageIdFor(recorded.candidate.graphId as GraphId, 'wp-b');
  const lineage = loadLineage(store, SCOPE, newWorkPackageId);
  expect(lineage?.priorWorkPackageId).toBe(priorWorkPackageId);
  const inheritedAttempts = lineage?.inherited.find((entry) => entry.field === 'implementationAttempts')?.consumed;
  expect(inheritedAttempts).toBe(1);

  const effective = effectiveBudgetConsumption({
    store,
    coordinationScopeId: SCOPE,
    workPackageId: newWorkPackageId,
    own: [{ workPackageId: newWorkPackageId, field: 'implementationAttempts', consumed: 1 }],
  });
  // 本代 1 + 继承 1：延续旧责任不会拿到一份新额度。
  expect(effective.find((entry) => entry.field === 'implementationAttempts')?.consumed).toBe(2);
});

test.each(['missing_graph', 'wrong_member'] as const)('纯 lineage 的 %s 矛盾在零消耗时也阻止创建 Run', async (scenario) => {
  await proposeInitialGraph();
  const priorGraphId = scenario === 'missing_graph' ? 'missing-graph' : graphIdFor(SCOPE, 1 as GraphGeneration);
  const priorWorkPackageId = scenario === 'wrong_member' ? 'non-member' : generationOneWorkPackageId('wp-a');
  const readerPlan: ImplementationPlan = {
    planRevision: 2,
    destinationRef: { kind: 'destination', id: 'destination-1', version: 1 },
    workPackages: [{
      key: 'wp-b', title: 'b', dependsOn: [], scopeEnvelope: { include: ['src'], exclude: [] },
      lineage: { priorGraphId, priorWorkPackageId },
    }],
  };
  const graph: ExecutionGraph = {
    graphId: graphIdFor(SCOPE, 2 as GraphGeneration), generation: 2 as GraphGeneration, workPackages: [],
  };
  const backend = fakeBackend();
  const facts = await createPlanContinuationFactReader({
    store, backend: backend.backend, coordinationScopeId: SCOPE, backendIdentityRef: 'identity-ref',
    baselineHead: BASELINE, plan: readerPlan, graph, canonicalWorktreePath: null,
  })(workPackageIdFor(graph.graphId, 'wp-b'));
  expect(facts?.conflictingFacts.length).toBeGreaterThan(0);
  if (facts === null) throw new Error('lineage 事实不可读');
  expect(facts.priorConsumed.every((entry) => entry.consumed === 0)).toBe(true);
  expect(preflightPlanContinuations({
    graph, plan: readerPlan, factsFor: () => ({ ...facts, priorConsumed: [] }),
  }).kind).toBe('blocked');
  const result = await propose(backend, readerPlan);
  expect(result).toMatchObject({ kind: 'rejected', code: 'continuation_conflict' });
  expect(backend.mutations).toEqual([]);
  expect(loadLineage(store, SCOPE, workPackageIdFor(graph.graphId, 'wp-b'))).toBeNull();
  expect(store.query({ kind: 'graph-versions', coordinationScopeId: SCOPE, graphId: graph.graphId }))
    .toMatchObject({ kind: 'graph-versions', versions: [] });
});

test.each(['other_work_package', 'wrong_generation', 'missing_binding'] as const)(
  'Baseline Adoption 拒绝 %s 的 push 证据且不创建 Run',
  async (scenario) => {
    await proposeInitialGraph(['wp-a', 'wp-other']);
    acquireExecutionLeaseForTest();
    if (scenario !== 'missing_binding') recordOriginalBinding('old');
    const acceptedValue = { summary: 'accepted' };
    const resultRef = `task-old#${resultDigest(acceptedValue).slice(0, 13)}`;
    expect(transact((expectedRevision) => ({
      kind: 'record-delivery-settlement', coordinationScopeId: SCOPE, expectedRevision, writer,
      dedupeKey: 'settle-proof', deliveryId: 'delivery-proof', runId: 'run-1', consumerGeneration: 1,
      workerTaskId: 'task-old' as WorkerTaskId, dispatchId: 'dispatch-old' as DispatchId,
      attemptId: 'attempt-old', role: 'validator', contractRevision: 1,
      orcaResultRef: resultRef, outcome: 'succeeded', validationVerdict: 'passed',
    })).kind).toBe('committed');
    const targetWorkPackageId = scenario === 'other_work_package' ? generationOneWorkPackageId('wp-other') : generationOneWorkPackageId('wp-a');
    const integrationRef = integrationOperationIdsFor({
      scopeId: SCOPE,
      graphId: graphIdFor(SCOPE, (scenario === 'wrong_generation' ? 9 : 1) as GraphGeneration),
      generation: scenario === 'wrong_generation' ? 9 : 1,
      workPackageId: targetWorkPackageId,
    }).push;
    expect(transact((expectedRevision) => ({
      kind: 'begin-intent', coordinationScopeId: SCOPE, expectedRevision, writer,
      operationId: integrationRef, target: { kind: 'work-package', id: targetWorkPackageId },
      operationCategory: 'git-integration', expectedHead: 'old-commit',
    })).kind).toBe('committed');
    expect(transact((expectedRevision) => ({
      kind: 'settle-intent', coordinationScopeId: SCOPE, expectedRevision, writer,
      operationId: integrationRef, outcomeClass: 'accepted',
    })).kind).toBe('committed');
    const backend = fakeBackend([{ id: 'task-old', status: 'completed', result: acceptedValue }]);
    const result = await propose(backend, plan(2, [{
      key: 'wp-b',
      adoption: {
        kind: 'baseline_adoption', adoptedResultRef: resultRef, baselineHead: BASELINE,
        integrationRef, evidenceRefs: ['evidence-1'],
      },
    }]), {
      canonicalWorktreePath: '/tmp/canonical',
      planContinuationFacts: (context) => createPlanContinuationFactReader({
        ...context, git: fakeGit({ touched: ['src/a.ts'], since: [] }),
      }),
    });
    expect(result).toMatchObject({ kind: 'rejected', code: 'continuation_conflict' });
    expect(backend.mutations).toEqual([]);
    expect(adoptionRecords(store, SCOPE)).toEqual([]);
    expect(store.query({
      kind: 'graph-versions', coordinationScopeId: SCOPE, graphId: graphIdFor(SCOPE, 2 as GraphGeneration),
    })).toMatchObject({ kind: 'graph-versions', versions: [] });
  },
);

test('propose 预检失败时不建立任何 Run，也不写采用记录', async () => {
  await proposeInitialGraph();
  const backend = fakeBackend();
  const recorded = await propose(
    backend,
    plan(2, [
      {
        key: 'wp-b',
        adoption: {
          kind: 'baseline_adoption',
          adoptedResultRef: 'task-missing#0000000000000',
          baselineHead: BASELINE,
          evidenceRefs: ['evidence-1'],
        },
      },
    ]),
  );
  expect(recorded.kind).toBe('rejected');
  expect(recorded.kind === 'rejected' ? recorded.code : null).toBe('accepted_result_missing');
  expect(backend.mutations).toEqual([]);
  expect(adoptionRecords(store, SCOPE)).toEqual([]);
});

test('propose 声明采用时，预检通过后与图记录一起落盘采用记录', async () => {
  await proposeInitialGraph();
  const acceptedValue = { summary: 'feature' };
  acquireExecutionLeaseForTest();
  recordOriginalBinding('old');
  const resultRef = `task-old#${resultDigest(acceptedValue).slice(0, 13)}`;
  transact((expectedRevision) => ({
    kind: 'record-delivery-settlement',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer,
    dedupeKey: 'settle-ok',
    deliveryId: 'delivery-ok',
    runId: 'run-1',
    consumerGeneration: 1,
    workerTaskId: 'task-old' as WorkerTaskId,
    dispatchId: 'dispatch-old' as DispatchId,
    attemptId: 'attempt-old',
    role: 'validator',
    contractRevision: 1,
    orcaResultRef: resultRef,
    outcome: 'succeeded',
  }));
  transact((expectedRevision) => ({
    kind: 'begin-intent',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer,
    operationId: PUSH_INTENT,
    target: { kind: 'work-package', id: generationOneWorkPackageId('wp-a') },
    operationCategory: 'git-integration',
    expectedHead: 'old-commit',
  }));
  transact((expectedRevision) => ({
    kind: 'settle-intent',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer,
    operationId: PUSH_INTENT,
    outcomeClass: 'accepted',
  }));

  const backend = fakeBackend([{ id: 'task-old', status: 'completed', result: acceptedValue }]);
  const recorded = await propose(
    backend,
    plan(2, [
      {
        key: 'wp-b',
        adoption: {
          kind: 'baseline_adoption',
          adoptedResultRef: resultRef,
          baselineHead: BASELINE,
          integrationRef: PUSH_INTENT,
          evidenceRefs: ['evidence-1'],
        },
      },
    ]),
    {
      canonicalWorktreePath: '/tmp/canonical',
      planContinuationFacts: (context) =>
        createPlanContinuationFactReader({
          ...context,
          git: fakeGit({ touched: ['src/a.ts'], since: [] }),
        }),
    },
  );
  if (recorded.kind !== 'recorded') throw new Error(`采用候选图未记录：${JSON.stringify(recorded)}`);
  const newWorkPackageId = workPackageIdFor(recorded.candidate.graphId as GraphId, 'wp-b');
  const records = adoptionRecords(store, SCOPE, newWorkPackageId);
  expect(records).toEqual([
    expect.objectContaining({ kind: 'baseline_adoption', state: 'recorded', adoptedResultRef: resultRef }),
  ]);
});

test('无采用/延续声明时不触碰 Orca 的 task-list', async () => {
  // 只登记 run-create 与 run-current 的 backend 会在 task-list 上拒绝；这条路径不应查询它。
  const backend = fakeBackend();
  const recorded = await propose(backend, plan(1, [{ key: 'wp-a' }]));
  expect(recorded.kind).toBe('recorded');
  expect(backend.mutations.map((mutation) => mutation.operation)).toEqual(['run-create']);
});

/** 真实 Git 仓库上验证证据算法：默认端口用参数数组调用 git，不走 shell。 */
function gitIn(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' });
}

test('Baseline 证据用真实 Git 判定：旧集成改动路径在当前基线被改动即证据失效', async () => {
  const repo = join(directory, 'repo');
  mkdirSync(repo);
  gitIn(repo, ['init', '-q']);
  const commit = (message: string): string => {
    gitIn(repo, ['add', '-A']);
    gitIn(repo, ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', message]);
    return gitIn(repo, ['rev-parse', 'HEAD']).trim();
  };
  writeFileSync(join(repo, 'README.md'), 'root\n');
  commit('root');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  const oldCommit = commit('integrate feature');
  writeFileSync(join(repo, 'src', 'other.ts'), 'export const other = 1;\n');
  const baseline = commit('baseline advance');

  await proposeInitialGraph();
  acquireExecutionLeaseForTest();
  recordOriginalBinding('git');
  const acceptedValue = { summary: 'integrated' };
  const resultRef = `task-git#${resultDigest(acceptedValue).slice(0, 13)}`;
  transact((expectedRevision) => ({
    kind: 'record-delivery-settlement',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer,
    dedupeKey: 'settle-git',
    deliveryId: 'delivery-git',
    runId: 'run-1',
    consumerGeneration: 1,
    workerTaskId: 'task-git' as WorkerTaskId,
    dispatchId: 'dispatch-git' as DispatchId,
    attemptId: 'attempt-git',
    role: 'validator',
    contractRevision: 1,
    orcaResultRef: resultRef,
    outcome: 'succeeded',
  }));
  transact((expectedRevision) => ({
    kind: 'begin-intent',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer,
    operationId: PUSH_INTENT,
    target: { kind: 'work-package', id: generationOneWorkPackageId('wp-a') },
    operationCategory: 'git-integration',
    expectedHead: oldCommit,
  }));
  transact((expectedRevision) => ({
    kind: 'settle-intent',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer,
    operationId: PUSH_INTENT,
    outcomeClass: 'accepted',
  }));

  const graph: ExecutionGraph = { graphId: graphIdFor(SCOPE, 2 as GraphGeneration), generation: 2 as GraphGeneration, workPackages: [] };
  const read = (baselineHead: string) =>
    createPlanContinuationFactReader({
      store,
      backend: fakeBackend([{ id: 'task-git', status: 'completed', result: acceptedValue }]).backend,
      coordinationScopeId: SCOPE,
      backendIdentityRef: 'identity-ref',
      baselineHead,
      plan: {
        planRevision: 2,
        destinationRef: { kind: 'destination', id: 'destination-1', version: 1 },
        workPackages: [
          {
            key: 'wp-a',
            title: 'a',
            dependsOn: [],
            scopeEnvelope: { include: ['src/a.ts'], exclude: [] },
            adoption: { kind: 'baseline_adoption', adoptedResultRef: resultRef, baselineHead, integrationRef: PUSH_INTENT, evidenceRefs: ['e'] },
          },
        ],
      },
      graph,
      canonicalWorktreePath: repo,
      git: createPlanContinuationGitPort(),
    })(workPackageIdFor(graph.graphId, 'wp-a'));

  const applied = await read(baseline);
  expect(applied).toMatchObject({ acceptedResultRecorded: true, evidenceStillApplicable: true, conflictingFacts: [] });

  // 当前基线改动了旧集成 commit 触碰过的路径：证据不再适用（不是矛盾，故可不阻塞）。
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 2;\n');
  const advancedBaseline = commit('touch integrated path');
  const stale = await read(advancedBaseline);
  expect(stale).toMatchObject({ acceptedResultRecorded: true, evidenceStillApplicable: false, conflictingFacts: [] });
});
