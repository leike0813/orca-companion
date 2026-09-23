/**
 * 执行图演进相关测试的共享基座。
 *
 * 它把「一个可写的 Coordination Scope + 一个初始 GraphVersion + 一份已批准授权」的重复搭建收敛到一处，
 * 让各测试文件只描述自己的行为差异。基座不隐藏任何业务判定：它是真实 store、真实 CAS 与真实 Manfiest
 * 解析，因此测试看到的是生产路径。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openCoordinationStore, type CoordinationStore } from '../../src/adapters/storage/coordination-store.js';
import { acquireRuntimeLease } from '../../src/application/coordination/lease-service.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  DispatchId,
  GraphGeneration,
  GraphId,
  GraphVersion,
  PlanningCycleId,
  RuntimeIncarnationId,
  WorkPackageId,
  WorkerTaskId,
} from '../../src/application/dto/identity.js';
import type { CoordinationWriter } from '../../src/application/ports/branch-coordination-store.js';
import type { ExecutionBackend } from '../../src/application/ports/execution-backend.js';
import { initializeCoordinationScope } from '../../src/application/planning/initialize-scope.js';
import { graphIdFor } from '../../src/application/planning/graph-generation.js';
import { loadCurrentGraph, recordInitialGraph } from '../../src/application/planning/graph-history.js';
import { DEFAULT_EXECUTION_LIMITS, budgetFromLimits } from '../../src/domain/planning/budget-policy.js';
import type { ExecutionGraph, GraphVersionRecord, WorkPackage } from '../../src/domain/planning/execution-graph.js';
import type { ExecutionAuthorizationManifest } from '../../src/domain/planning/execution-authorization.js';

export const EXECUTION_SCOPE = 'scope-1' as CoordinationScopeId;
export const EXECUTION_SESSION = 'session-a' as CoordinatorSessionId;
export const EXECUTION_CYCLE = 'cycle-1' as PlanningCycleId;
export const EXECUTION_GENERATION = 1 as GraphGeneration;
export const EXECUTION_MAP_REVISION = 2;
export const EXECUTION_PLAN_REVISION = 3;
export const EXECUTION_RUN_ID = 'run-1';
export const EXECUTION_AUTHORIZATION_ID = 'auth-1';
/** 默认图里唯一已接受的节点；其余节点都是未接受的可演进对象。 */
export const EXECUTION_ACCEPTED: readonly WorkPackageId[] = ['wp-a' as WorkPackageId];

/** 模拟已走完正常 Delivery 结算的独立 Planner Task，不伪造业务完成状态。 */
export function recordAcceptedPlannerResult(harness: ExecutionScopeHarness, workerTaskId: string): void {
  const scope = harness.store.query({ kind: 'scope', coordinationScopeId: harness.scopeId });
  if (scope.kind !== 'scope' || scope.scope === null) throw new Error('无法读取 Scope');
  const bound = harness.store.transact({
    kind: 'bind-baseline-reconciliation-task',
    coordinationScopeId: harness.scopeId,
    expectedRevision: scope.scope.revision,
    writer: harness.writer,
    reconciliationId: workerTaskId,
    orcaTaskId: `task:${workerTaskId}`,
    dispatchId: `dispatch:${workerTaskId}` as DispatchId,
  });
  if (bound.kind === 'rejected') throw new Error(bound.message);
  const boundScope = harness.store.query({ kind: 'scope', coordinationScopeId: harness.scopeId });
  if (boundScope.kind !== 'scope' || boundScope.scope === null) throw new Error('无法读取 Scope');
  const recorded = harness.store.transact({
    kind: 'record-delivery-settlement',
    coordinationScopeId: harness.scopeId,
    expectedRevision: boundScope.scope.revision,
    writer: harness.writer,
    dedupeKey: `planner:${workerTaskId}`,
    deliveryId: `delivery:${workerTaskId}`,
    runId: EXECUTION_RUN_ID,
    consumerGeneration: 1,
    workerTaskId: workerTaskId as WorkerTaskId,
    dispatchId: `dispatch:${workerTaskId}` as DispatchId,
    attemptId: `attempt:${workerTaskId}`,
    role: 'planner',
    contractRevision: 1,
    orcaResultRef: `task:${workerTaskId}#accepted`,
  });
  if (recorded.kind === 'rejected') throw new Error(recorded.message);
}

export function executionWorkPackage(id: string, dependsOn: readonly string[] = []): WorkPackage {
  return {
    workPackageId: id as WorkPackageId,
    title: id,
    dependsOn: dependsOn as readonly WorkPackageId[],
    scopeEnvelope: { include: ['src'], exclude: [] },
    budget: budgetFromLimits(DEFAULT_EXECUTION_LIMITS),
  };
}

/** 默认拓扑：A（已接受）→ B → C，另有只依赖 A 的 D。 */
export function defaultExecutionWorkPackages(): readonly WorkPackage[] {
  return [
    executionWorkPackage('wp-a'),
    executionWorkPackage('wp-b', ['wp-a']),
    executionWorkPackage('wp-c', ['wp-b']),
    executionWorkPackage('wp-d', ['wp-a']),
  ];
}

export function executionManifest(input: {
  readonly graphId: GraphId;
  readonly generation: GraphGeneration;
  readonly mapRevision?: number;
  readonly planRevision?: number;
  readonly orcaRunId?: string;
  readonly baselineHead?: string;
  readonly graphVersion?: number;
  readonly coordinationScopeId?: CoordinationScopeId;
  readonly planningCycleId?: PlanningCycleId;
  readonly limits?: ExecutionAuthorizationManifest['limits'];
}): ExecutionAuthorizationManifest {
  return {
    manifestVersion: 1,
    coordinationScopeId: input.coordinationScopeId ?? EXECUTION_SCOPE,
    planningCycleId: input.planningCycleId ?? EXECUTION_CYCLE,
    destinationRef: { kind: 'destination', id: 'dest-1', version: 1 },
    routeMapRef: { kind: 'route-map', id: 'map-1', version: input.mapRevision ?? EXECUTION_MAP_REVISION },
    implementationPlanRef: {
      kind: 'implementation-plan',
      id: 'plan-1',
      version: input.planRevision ?? EXECUTION_PLAN_REVISION,
    },
    graph: {
      graphId: input.graphId,
      generation: input.generation,
      version: (input.graphVersion ?? 1) as ExecutionAuthorizationManifest['graph']['version'],
    },
    baselineHead: input.baselineHead ?? 'head-1',
    orcaRunId: input.orcaRunId ?? EXECUTION_RUN_ID,
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
    limits: input.limits ?? DEFAULT_EXECUTION_LIMITS,
    workspacePolicy: { canonicalWorktree: '/work', worktreeIsolation: 'per_work_package' },
    gitPolicy: { canonicalBranch: 'main', remotes: [], refs: [], allowForcePush: false },
    dependencyPolicy: { allowDependencyChanges: false, registry: null },
    acceptedRisks: [],
  };
}

export type ExecutionScopeHarness = {
  readonly store: CoordinationStore;
  readonly writer: CoordinationWriter;
  readonly scopeId: CoordinationScopeId;
  readonly graphId: GraphId;
  readonly generation: GraphGeneration;
  readonly limits: ExecutionAuthorizationManifest['limits'];
  readonly databasePath: string;
  currentGraph(): GraphVersionRecord;
  revision(): number;
  authorization(): ExecutionAuthorizationRecordLike;
  versionCount(): number;
  close(): void;
};

type ExecutionAuthorizationRecordLike = ReturnType<typeof readAuthorization>;

function readAuthorization(store: CoordinationStore, scopeId: CoordinationScopeId) {
  const result = store.query({ kind: 'authorization', coordinationScopeId: scopeId, authorizationId: EXECUTION_AUTHORIZATION_ID });
  if (result.kind !== 'authorization' || result.authorization === null) {
    throw new Error('测试基座无法读取授权记录');
  }
  return result.authorization;
}

export function createExecutionScopeHarness(options?: {
  readonly workPackages?: readonly WorkPackage[];
  readonly limits?: ExecutionAuthorizationManifest['limits'];
}): ExecutionScopeHarness {
  const directory = mkdtempSync(join(tmpdir(), 'orca-execution-'));
  const databasePath = join(directory, 'coordination.sqlite');
  const opened = openCoordinationStore({ databasePath });
  if (opened.kind !== 'opened') {
    throw new Error(opened.message);
  }
  const store = opened.store;
  const generation = EXECUTION_GENERATION;
  const graphId = graphIdFor(EXECUTION_SCOPE, generation);

  const initialized = initializeCoordinationScope({
    store,
    coordinationScopeId: EXECUTION_SCOPE,
    coordinatorSessionId: EXECUTION_SESSION,
    coordinatorModelConfigurationRef: 'model-config-1',
    planningCycleId: EXECUTION_CYCLE,
    fullBranchRef: `refs/heads/${EXECUTION_SCOPE}`,
    canonicalWorktreePath: '/tmp/orca-execution-worktree',
  });
  if (initialized.kind !== 'initialized') {
    throw new Error('测试基座无法创建 Scope');
  }
  const acquired = acquireRuntimeLease(store, {
    coordinationScopeId: EXECUTION_SCOPE,
    coordinatorSessionId: EXECUTION_SESSION,
    runtimeIncarnationId: 'inc-a' as RuntimeIncarnationId,
    fencingGeneration: 0,
  });
  if (acquired.kind !== 'acquired') {
    throw new Error('测试基座无法取得 Runtime Lease');
  }
  const writer: CoordinationWriter = {
    coordinatorSessionId: EXECUTION_SESSION,
    runtimeIncarnationId: 'inc-a' as RuntimeIncarnationId,
    fencingGeneration: acquired.lease.fencingGeneration,
  };
  const limits = options?.limits ?? DEFAULT_EXECUTION_LIMITS;

  const graph: ExecutionGraph = {
    graphId,
    generation,
    concurrencyLimit: limits.concurrencyLimit,
    workPackages: options?.workPackages ?? defaultExecutionWorkPackages(),
  };
  const recorded = recordInitialGraph({
    store,
    coordinationScopeId: EXECUTION_SCOPE,
    writer,
    graph,
    mapRevision: EXECUTION_MAP_REVISION,
    planRevision: EXECUTION_PLAN_REVISION,
    orcaRunId: EXECUTION_RUN_ID,
  });
  if (recorded.kind !== 'recorded') {
    throw new Error('测试基座无法记录初始图');
  }

  const scopeState = store.query({ kind: 'scope', coordinationScopeId: EXECUTION_SCOPE });
  if (scopeState.kind !== 'scope' || scopeState.scope === null) {
    throw new Error('测试基座无法读取 Scope');
  }
  const authorized = store.transact({
    kind: 'record-authorization',
    coordinationScopeId: EXECUTION_SCOPE,
    expectedRevision: scopeState.scope.revision,
    writer,
    authorizationId: EXECUTION_AUTHORIZATION_ID,
    authorizationVersion: 1,
    manifestVersion: 1,
    fingerprint: 'fingerprint-1',
    approvalRef: 'approval-1',
    manifest: executionManifest({ graphId, generation, limits }),
  });
  if (authorized.kind === 'rejected') {
    throw new Error(`测试基座无法记录授权: ${authorized.message}`);
  }

  // 基座落在执行协调态：模式、图引用与 Execution Coordination Lease 同批生效，后继用例因此面对
  // 真实的前驱执行态，而不是一个还在规划的准备态。
  const entered = store.query({ kind: 'scope', coordinationScopeId: EXECUTION_SCOPE });
  if (entered.kind !== 'scope' || entered.scope === null) {
    throw new Error('测试基座无法读取 Scope');
  }
  const transitioned = store.transact({
    kind: 'transition-to-execution',
    coordinationScopeId: EXECUTION_SCOPE,
    expectedRevision: entered.scope.revision,
    writer,
    planningCycleId: EXECUTION_CYCLE,
    graphId,
    graphVersion: 1 as GraphVersion,
    authorizationId: EXECUTION_AUTHORIZATION_ID,
    authorizationVersion: 1,
  });
  if (transitioned.kind === 'rejected') {
    throw new Error(`测试基座无法进入执行协调态: ${transitioned.message}`);
  }

  const currentGraph = (): GraphVersionRecord => {
    const loaded = loadCurrentGraph({ store, coordinationScopeId: EXECUTION_SCOPE, graphId });
    if (loaded.kind !== 'loaded') {
      throw new Error('测试基座无法读取当前图');
    }
    return loaded.version;
  };

  return {
    store,
    writer,
    scopeId: EXECUTION_SCOPE,
    graphId,
    generation,
    limits,
    databasePath,
    currentGraph,
    revision: (): number => {
      const read = store.query({ kind: 'scope', coordinationScopeId: EXECUTION_SCOPE });
      if (read.kind !== 'scope' || read.scope === null) {
        throw new Error('测试基座无法读取 Scope revision');
      }
      return read.scope.revision;
    },
    authorization: () => readAuthorization(store, EXECUTION_SCOPE),
    versionCount: (): number => {
      const versions = store.query({ kind: 'graph-versions', coordinationScopeId: EXECUTION_SCOPE, graphId });
      return versions.kind === 'graph-versions' ? versions.versions.length : -1;
    },
    close: () => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/**
 * 禁止生效的 Execution Backend 替身。
 *
 * 被调用即抛错，因此「这条路径一次都没有触碰 Orca」是结构性断言，而不是靠计数核对。
 */
export function forbiddenExecutionBackend(): {
  readonly backend: ExecutionBackend;
  readonly calls: { query: number; mutate: number };
} {
  const calls = { query: 0, mutate: 0 };
  return {
    backend: {
      query: () => {
        calls.query += 1;
        return Promise.reject(new Error('该路径不得调用 Orca adapter'));
      },
      mutate: () => {
        calls.mutate += 1;
        return Promise.reject(new Error('该路径不得调用 Orca adapter'));
      },
    },
    calls,
  };
}
