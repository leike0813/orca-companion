/**
 * `m1-evolve-execution-graph` 的行为测试：来源证据与唯一提交点（IC-10 / IP-3）。
 *
 * 覆盖 `execution/graph-patching` 的第三个 Requirement：Planner 结果只是不可变来源证据，唯一提交点是
 * `ExecutionGraphHistory.appendAcceptedRevision`；提交携带 expected version、补丁标识与 Controller
 * 签发的 OperationId，写入后回读确认，历史只追加且被 retire 的节点不计入完成。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { openCoordinationStore, type CoordinationStore } from '../../src/adapters/storage/coordination-store.js';
import { acquireExecutionLease, acquireRuntimeLease } from '../../src/application/coordination/lease-service.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  GraphGeneration,
  GraphId,
  GraphVersion,
  OperationId,
  PlanningCycleId,
  RuntimeIncarnationId,
  WorkPackageId,
} from '../../src/application/dto/identity.js';
import type { CoordinationWriter } from '../../src/application/ports/branch-coordination-store.js';
import { initializeCoordinationScope } from '../../src/application/planning/initialize-scope.js';
import { graphIdFor } from '../../src/application/planning/graph-generation.js';
import { appendAcceptedRevision, loadCurrentGraph, recordInitialGraph } from '../../src/application/planning/graph-history.js';
import {
  DEFAULT_EXECUTION_LIMITS,
  budgetFromLimits,
} from '../../src/domain/planning/budget-policy.js';
import type { ExecutionGraph, GraphVersionRecord } from '../../src/domain/planning/execution-graph.js';
import type { ExecutionAuthorizationManifest } from '../../src/domain/planning/execution-authorization.js';
import {
  admitGraphRevision,
  applyGraphRevision,
  applyGraphRevisionWithBaseline,
  graphRevisionDraftFromEvidence,
  type AdmittedGraphRevision,
} from '../../src/application/execution/graph-patch-service.js';
import type { GraphPatchPlannerEvidence } from '../../src/application/execution/graph-patch-planner.js';

const SCOPE = 'scope-1' as CoordinationScopeId;
const SESSION = 'session-a' as CoordinatorSessionId;
const CYCLE = 'cycle-1' as PlanningCycleId;
const GENERATION = 1 as GraphGeneration;
const MAP_REVISION = 2;
const PLAN_REVISION = 3;
const RUN_ID = 'run-1';

let directory = '';
let store: CoordinationStore;
let writer: CoordinationWriter;
let graphId: GraphId;
let now = 1_000;

const clock = (): number => now;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-graph-patch-'));
  now = 1_000;
  const opened = openCoordinationStore({ databasePath: join(directory, 'coordination.sqlite'), clock });
  if (opened.kind !== 'opened') {
    throw new Error(opened.message);
  }
  store = opened.store;

  const initialized = initializeCoordinationScope({
    store,
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION,
    coordinatorModelConfigurationRef: 'model-config-1',
    planningCycleId: CYCLE,
  });
  if (initialized.kind !== 'initialized') {
    throw new Error('无法创建测试 Scope');
  }
  const acquired = acquireRuntimeLease(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION,
    runtimeIncarnationId: 'inc-a' as RuntimeIncarnationId,
    fencingGeneration: 0,
  });
  if (acquired.kind !== 'acquired') {
    throw new Error('无法取得 Runtime Lease');
  }
  writer = {
    coordinatorSessionId: SESSION,
    runtimeIncarnationId: 'inc-a' as RuntimeIncarnationId,
    fencingGeneration: acquired.lease.fencingGeneration,
  };

  graphId = graphIdFor(SCOPE, GENERATION);
  const recorded = recordInitialGraph({
    store,
    coordinationScopeId: SCOPE,
    writer,
    graph: initialGraph(),
    mapRevision: MAP_REVISION,
    planRevision: PLAN_REVISION,
    orcaRunId: RUN_ID,
  });
  if (recorded.kind !== 'recorded') {
    throw new Error('无法记录初始图');
  }
  const revision = scopeRevision();
  const authorized = store.transact({
    kind: 'record-authorization',
    coordinationScopeId: SCOPE,
    expectedRevision: revision,
    writer,
    authorizationId: 'auth-1',
    authorizationVersion: 1,
    manifestVersion: 1,
    fingerprint: 'fingerprint-1',
    approvalRef: 'approval-1',
    manifest: manifest(),
  });
  if (authorized.kind !== 'committed') {
    throw new Error(`无法记录授权: ${authorized.message}`);
  }
  // 已接受的图修订只能由 Execution Coordination Lease 持有者推进，测试基座因此进入执行协调态。
  const entered = acquireExecutionLease(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION,
    runtimeIncarnationId: 'inc-a' as RuntimeIncarnationId,
    fencingGeneration: writer.fencingGeneration,
  });
  if (entered.kind === 'rejected') {
    throw new Error(`无法取得 Execution Coordination Lease: ${entered.rejection.message}`);
  }
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

function scopeRevision(): number {
  const scope = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  if (scope.kind !== 'scope' || scope.scope === null) {
    throw new Error('无法读取 Scope');
  }
  return scope.scope.revision;
}

function workPackage(id: string, dependsOn: readonly string[]) {
  return {
    workPackageId: id as WorkPackageId,
    title: id,
    dependsOn: dependsOn as readonly WorkPackageId[],
    scopeEnvelope: { include: ['src'], exclude: [] },
    budget: budgetFromLimits(DEFAULT_EXECUTION_LIMITS),
  };
}

/** A → B → C，另有只依赖 A 的 D。 */
function initialGraph(): ExecutionGraph {
  return {
    graphId,
    generation: GENERATION,
    concurrencyLimit: 1,
    workPackages: [workPackage('wp-a', []), workPackage('wp-b', ['wp-a']), workPackage('wp-c', ['wp-b']), workPackage('wp-d', ['wp-a'])],
  };
}

function manifest(): ExecutionAuthorizationManifest {
  return {
    manifestVersion: 1,
    coordinationScopeId: SCOPE,
    planningCycleId: CYCLE,
    destinationRef: { kind: 'destination', id: 'dest-1', version: 1 },
    routeMapRef: { kind: 'route-map', id: 'map-1', version: MAP_REVISION },
    implementationPlanRef: { kind: 'implementation-plan', id: 'plan-1', version: PLAN_REVISION },
    graph: { graphId, generation: GENERATION, version: 1 as GraphVersion },
    baselineHead: 'head-1',
    orcaRunId: RUN_ID,
    workerProfiles: [
      { profileRef: { kind: 'worker-profile', id: 'p-planner' }, role: 'planner', harness: 'codex' },
      { profileRef: { kind: 'worker-profile', id: 'p-impl' }, role: 'implementation', harness: 'codex' },
      { profileRef: { kind: 'worker-profile', id: 'p-val' }, role: 'validator', harness: 'codex' },
      { profileRef: { kind: 'worker-profile', id: 'p-fin' }, role: 'finalizer', harness: 'codex' },
    ],
    permissions: {
      planner: true,
      implementation: true,
      validator: true,
      finalizer: true,
      gitIntegration: false,
      dependencyChanges: false,
    },
    limits: DEFAULT_EXECUTION_LIMITS,
    workspacePolicy: { canonicalWorktree: '/work', worktreeIsolation: 'per_work_package' },
    gitPolicy: { canonicalBranch: 'main', remotes: [], refs: [], allowForcePush: false },
    dependencyPolicy: { allowDependencyChanges: false, registry: null },
    acceptedRisks: [],
  };
}

function authorization() {
  const result = store.query({ kind: 'authorization', coordinationScopeId: SCOPE, authorizationId: 'auth-1' });
  if (result.kind !== 'authorization' || result.authorization === null) {
    throw new Error('无法读取授权');
  }
  return result.authorization;
}

function current(): GraphVersionRecord {
  const loaded = loadCurrentGraph({ store, coordinationScopeId: SCOPE, graphId });
  if (loaded.kind !== 'loaded') {
    throw new Error('无法读取当前图');
  }
  return loaded.version;
}

function patchPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    baseGraphVersion: current().version,
    patchId: 'patch-1',
    operationId: 'op-from-payload',
    add: [
      {
        key: 'prep',
        title: '前置工作',
        dependsOn: [{ kind: 'existing', workPackageId: 'wp-a' }],
        scopeEnvelope: { include: ['src/prep'], exclude: [] },
      },
    ],
    revise: [
      {
        workPackageId: 'wp-b',
        title: 'B 修订',
        dependsOn: [{ kind: 'added', key: 'prep' }],
        scopeEnvelope: { include: ['src'], exclude: [] },
      },
    ],
    retire: [],
    descendants: [{ workPackageId: 'wp-c', disposition: 'unchanged' }],
    takesOver: [],
    ...overrides,
  };
}

function admit(payload: unknown, operationId = 'op-trusted') {
  return admitGraphRevision({
    draft: { payload, operationId: operationId as OperationId, patchId: 'patch-1' },
    current: current(),
    limits: DEFAULT_EXECUTION_LIMITS,
    authorization: authorization(),
    acceptedWorkPackageIds: ['wp-a' as WorkPackageId],
    dispatchedWorkPackageIds: [],
  });
}

function applied(
  revision: AdmittedGraphRevision,
  baselines: Map<WorkPackageId, {
    requiredBaselineHead: string;
    worktreeBaseHead: string;
    relation: 'behind' | 'ahead' | 'diverged' | 'equal';
  } | null> = new Map([...revision.revisedWorkPackageIds, ...revision.specificationRevisionRequiredWorkPackageIds].map((id) => [id, null])),
) {
  return applyGraphRevision({
    store,
    coordinationScopeId: SCOPE,
    writer,
    revision,
    current: current(),
    authorizationId: 'auth-1',
    baselines,
  });
}

function versionCount(): number {
  const versions = store.query({ kind: 'graph-versions', coordinationScopeId: SCOPE, graphId });
  return versions.kind === 'graph-versions' ? versions.versions.length : -1;
}

test('Admission 归一化后经唯一提交点追加，历史只追加且回读确认', () => {
  const admitted = admit(patchPayload());
  expect(admitted.kind).toBe('admitted');
  if (admitted.kind !== 'admitted') {
    return;
  }
  // Admission 之前没有任何图被改写。
  expect(versionCount()).toBe(1);

  const result = applied(admitted.revision);
  expect(result.kind, JSON.stringify(result)).toBe('applied');
  if (result.kind !== 'applied') {
    return;
  }
  expect(result.version.version).toBe(2);
  expect(result.version.recordKind).toBe('accepted_revision');
  expect(result.version.parentVersion).toBe(1);
  expect(result.version.patchId).toBe('patch-1');
  expect(result.version.graph.workPackages.map((entry) => entry.workPackageId).sort()).toEqual(
    ['wp-a', 'wp-b', 'wp-c', 'wp-d', `${graphId}:patch-1:prep`].sort(),
  );

  // 历史只追加：旧版本仍然可读且内容不变。
  const first = store.query({ kind: 'graph-version', coordinationScopeId: SCOPE, graphId, graphVersion: 1 as GraphVersion });
  expect(first.kind === 'graph-version' ? first.version?.graph.workPackages.length : null).toBe(4);
  expect(versionCount()).toBe(2);

  // 补丁元数据可读：后代处置与新增/重定义/退休集合都被持久化。
  const record = store.query({
    kind: 'graph-patch-record',
    coordinationScopeId: SCOPE,
    graphId,
    graphVersion: 2 as GraphVersion,
  });
  expect(record.kind === 'graph-patch-record' ? record.record?.descendants : null).toEqual([
    { workPackageId: 'wp-c', disposition: 'unchanged' },
  ]);
  expect(record.kind === 'graph-patch-record' ? record.record?.revised : null).toEqual(['wp-b']);
});

test('进入 Replanning Transition 后即使 Lease 尚未释放也不能追加图修订', () => {
  const admitted = admit(patchPayload());
  if (admitted.kind !== 'admitted') throw new Error('测试前置失败');
  const stopped = store.transact({
    kind: 'record-control-state',
    coordinationScopeId: SCOPE,
    expectedRevision: scopeRevision(),
    writer,
    controlState: 'replanning_transition',
  });
  expect(stopped.kind).toBe('committed');
  const result = applied(admitted.revision);
  expect(result.kind === 'rejected' ? result.failure.code : null).toBe('invalid_state');
  expect(versionCount()).toBe(1);
});

test('图修订原子登记落后基线并立即调用独立补救 driver，缺少观察时不提交', async () => {
  const admitted = admit(patchPayload());
  if (admitted.kind !== 'admitted') throw new Error('测试前置失败');
  const absent = applied(admitted.revision, new Map());
  expect(absent.kind === 'rejected' ? absent.failure.code : null).toBe('baseline_unverified');
  expect(versionCount()).toBe(1);

  const baselines: Map<WorkPackageId, { requiredBaselineHead: string; worktreeBaseHead: string; relation: 'behind' } | null> =
    new Map([...admitted.revision.revisedWorkPackageIds, ...admitted.revision.specificationRevisionRequiredWorkPackageIds].map((id) => [id, null]));
  baselines.set('wp-b' as WorkPackageId, {
    requiredBaselineHead: 'head-2',
    worktreeBaseHead: 'head-1',
    relation: 'behind',
  });
  const driven: string[] = [];
  const result = await applyGraphRevisionWithBaseline({
    store,
    coordinationScopeId: SCOPE,
    writer,
    revision: admitted.revision,
    current: current(),
    authorizationId: 'auth-1',
    baselines,
    baselineReconciliation: (plan) => {
      driven.push(plan.reconciliationId);
      return Promise.resolve({ kind: 'dispatched' });
    },
  });
  expect(result.kind, JSON.stringify(result)).toBe('applied');
  expect(driven).toEqual(['baseline-reconciliation:wp-b:head-2']);
  expect(result.baselineProgress).toEqual([
    {
      reconciliationId: 'baseline-reconciliation:wp-b:head-2',
      progress: { kind: 'dispatched' },
    },
  ]);
  const records = store.query({ kind: 'baseline-reconciliations', coordinationScopeId: SCOPE, workPackageId: 'wp-b' as WorkPackageId });
  expect(records.kind === 'baseline-reconciliations' ? records.reconciliations.map((entry) => entry.state) : null).toEqual(['required']);
});

test('提交使用 Controller 签发的 OperationId，载荷里的同名字段被丢弃', () => {
  const admitted = admit(patchPayload({ operationId: 'op-model-supplied' }), 'op-trusted');
  expect(admitted.kind).toBe('admitted');
  if (admitted.kind !== 'admitted') {
    return;
  }
  expect(admitted.revision.operationId).toBe('op-trusted');
  const result = applied(admitted.revision);
  expect(result.kind).toBe('applied');
  const record = store.query({
    kind: 'graph-patch-record',
    coordinationScopeId: SCOPE,
    graphId,
    graphVersion: 2 as GraphVersion,
  });
  expect(record.kind === 'graph-patch-record' ? record.record?.operationId : null).toBe('op-trusted');
});

test('修订额度与图变化原子记账，且单调递增', () => {
  const admitted = admit(patchPayload());
  if (admitted.kind !== 'admitted') {
    throw new Error('Admission 未通过');
  }
  expect(applied(admitted.revision).kind).toBe('applied');

  const counters = store.query({ kind: 'budget-counters', coordinationScopeId: SCOPE });
  const consumed =
    counters.kind === 'budget-counters'
      ? counters.counters.find((counter) => counter.budgetKey === `work-package:wp-b:graphRevisions`)
      : undefined;
  expect(consumed?.consumed).toBe(1);
  expect(consumed?.approvedLimitRef).toBe('auth-1');
});

test('达到已批准上限后拒绝进一步修订', () => {
  const exhausted = admitGraphRevision({
    draft: { payload: patchPayload(), operationId: 'op-2' as OperationId, patchId: 'patch-1' },
    current: current(),
    limits: DEFAULT_EXECUTION_LIMITS,
    authorization: authorization(),
    acceptedWorkPackageIds: ['wp-a' as WorkPackageId],
    dispatchedWorkPackageIds: [],
    consumedRevisions: [{ workPackageId: 'wp-b' as WorkPackageId, field: 'graphRevisions', consumed: 2 }],
  });
  expect(exhausted.kind).toBe('rejected');
  if (exhausted.kind === 'rejected') {
    expect(exhausted.errors.map((entry) => entry.code)).toContain('revision_budget_exhausted');
  }
  expect(versionCount()).toBe(1);
});

test('版本漂移时拒绝提交，不产生新 GraphVersion', () => {
  const admitted = admit(patchPayload());
  if (admitted.kind !== 'admitted') {
    throw new Error('Admission 未通过');
  }
  // 在提交之前，图 head 被另一次追加推进（此处用同一补丁的第二次提交模拟）。
  const first = applied(admitted.revision);
  expect(first.kind).toBe('applied');
  const stale = applied(admitted.revision);
  expect(stale.kind).toBe('rejected');
  if (stale.kind === 'rejected') {
    expect(stale.failure.code).toBe('base_version_mismatch');
  }
  expect(versionCount()).toBe(2);
});

test('同一补丁重放不写出第二份图', () => {
  const admitted = admit(patchPayload());
  if (admitted.kind !== 'admitted') {
    throw new Error('Admission 未通过');
  }
  const result = applied(admitted.revision);
  expect(result.kind).toBe('applied');
  if (result.kind !== 'applied') {
    return;
  }
  const replay = appendAcceptedRevision({
    store,
    coordinationScopeId: SCOPE,
    writer,
    graphId,
    expectedVersion: result.version.version,
    generation: GENERATION,
    mapRevision: MAP_REVISION,
    planRevision: PLAN_REVISION,
    orcaRunId: RUN_ID,
    graph: result.version.graph,
    patch: {
      patchId: 'patch-1',
      operationId: 'op-trusted' as OperationId,
      baseGraphVersion: result.version.version,
      added: [],
      revised: [],
      retired: [],
      descendants: [],
      takesOver: [],
      revisionPendingWorkPackageIds: [],
    },
  });
  expect(replay.kind).toBe('rejected');
  if (replay.kind === 'rejected') {
    expect(replay.failure.code).toBe('patch_already_applied');
  }
  expect(versionCount()).toBe(2);
});

test('已派发的修订节点在同一次追加里进入 revision pending', () => {
  const admitted = admitGraphRevision({
    draft: { payload: patchPayload(), operationId: 'op-3' as OperationId, patchId: 'patch-1' },
    current: current(),
    limits: DEFAULT_EXECUTION_LIMITS,
    authorization: authorization(),
    acceptedWorkPackageIds: ['wp-a' as WorkPackageId],
    dispatchedWorkPackageIds: ['wp-b' as WorkPackageId],
  });
  expect(admitted.kind).toBe('admitted');
  if (admitted.kind !== 'admitted') {
    return;
  }
  const result = applied(admitted.revision);
  expect(result.kind).toBe('applied');
  if (result.kind !== 'applied') {
    return;
  }
  expect(result.revisionPendingWorkPackageIds).toEqual(['wp-b']);
  const holds = store.query({ kind: 'revision-holds', coordinationScopeId: SCOPE });
  expect(holds.kind === 'revision-holds' ? holds.holds : null).toEqual([
    expect.objectContaining({ workPackageId: 'wp-b', source: 'graph_patch', state: 'pending' }),
  ]);
});

test('Planner 证据只是证据：不提交就没有新 GraphVersion', () => {
  const evidence: GraphPatchPlannerEvidence = {
    kind: 'planner-evidence',
    patchId: 'patch-1',
    operationId: 'op-trusted' as OperationId,
    baseGraphVersion: 1 as GraphVersion,
    draftRef: 'result-1',
    payload: patchPayload(),
    committed: false,
  };
  const draft = graphRevisionDraftFromEvidence(evidence);
  expect(versionCount()).toBe(1);
  const admitted = admit(draft.payload, draft.operationId);
  expect(admitted.kind).toBe('admitted');
  if (admitted.kind !== 'admitted') {
    return;
  }
  expect(applied(admitted.revision).kind).toBe('applied');
  expect(versionCount()).toBe(2);
});

test('未授权时 Admission 拒绝，且不写入任何图版本', () => {
  const rejected = admitGraphRevision({
    draft: { payload: patchPayload(), operationId: 'op-4' as OperationId, patchId: 'patch-1' },
    current: current(),
    limits: DEFAULT_EXECUTION_LIMITS,
    authorization: null,
    acceptedWorkPackageIds: ['wp-a' as WorkPackageId],
    dispatchedWorkPackageIds: [],
  });
  expect(rejected.kind).toBe('rejected');
  if (rejected.kind === 'rejected') {
    expect(rejected.errors.map((entry) => entry.code)).toContain('not_authorized');
  }
  expect(versionCount()).toBe(1);
});

test('补丁基线必须精确等于当前版本', () => {
  const rejected = admit(patchPayload({ baseGraphVersion: (current().version + 1) }));
  expect(rejected.kind).toBe('rejected');
  if (rejected.kind === 'rejected') {
    expect(rejected.errors.map((entry) => entry.code)).toContain('base_version_mismatch');
  }
});
