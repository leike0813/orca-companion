/**
 * `m1-plan-and-authorize-execution` 的行为测试：Execution Authorization 的组装、批准与读取（IC-05）。
 *
 * 覆盖 `planning/execution-authorization` 的 Requirement「Manifest completeness and atomic
 * approval」全部 Scenario：缺字段不提交批准、Manifest 与候选图严格对应、单次决定覆盖整份
 * Manifest、未获批准时不产生可执行授权、恢复上限显式绑定且取默认值、改变恢复上限需要重新授权；
 * 以及 Requirement「Authorization authorizes bounded operations」的
 * Scenario「策略内操作不再逐次审批」与「越界操作需要单独授权」。
 *
 * 另外固定「授权本身不切换 Coordination 模式」与「候选图缺失时批准被拒绝」两条边界。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { openCoordinationStore, type CoordinationStore } from '../../src/adapters/storage/coordination-store.js';
import { acquireRuntimeLease } from '../../src/application/coordination/lease-service.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  GraphGeneration,
  GraphId,
  PlanningCycleId,
  RuntimeIncarnationId,
  WorkPackageId,
} from '../../src/application/dto/identity.js';
import {
  activeAuthorization,
  assertAuthorized,
  executionPolicyIsAbsent,
  maxRecoveriesFor,
  proposeManifest,
  recordApproval,
  recoveryAllowance,
} from '../../src/application/planning/authorization-service.js';
import { recordInitialGraph } from '../../src/application/planning/graph-history.js';
import { initializeCoordinationScope } from '../../src/application/planning/initialize-scope.js';
import type { CoordinationWriter, ScopeRecord } from '../../src/application/ports/branch-coordination-store.js';
import type {
  ExecutionAuthorizationManifest,
  ExecutionAuthorizationRecord,
} from '../../src/domain/planning/execution-authorization.js';
import type { ExecutionGraph, GraphVersionRecord } from '../../src/domain/planning/execution-graph.js';

const SCOPE = 'scope-1' as CoordinationScopeId;
const SESSION_A = 'session-a' as CoordinatorSessionId;
const CYCLE = 'cycle-1' as PlanningCycleId;

let directory = '';
let store: CoordinationStore;
let writer: CoordinationWriter;
let candidate: GraphVersionRecord;
let now = 1_000;

const clock = (): number => now;
const generation = (value: number): GraphGeneration => value as GraphGeneration;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-planning-auth-'));
  now = 1_000;
  const opened = openCoordinationStore({ databasePath: join(directory, 'coordination.sqlite'), clock });
  if (opened.kind !== 'opened') {
    throw new Error(opened.message);
  }
  store = opened.store;

  const initialized = initializeCoordinationScope({
    store,
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    coordinatorModelConfigurationRef: 'model-config-1',
    planningCycleId: CYCLE,
    fullBranchRef: 'refs/heads/main',
    canonicalWorktreePath: '/tmp/orca-test-worktree',
  });
  if (initialized.kind !== 'initialized') {
    throw new Error('无法创建测试 Scope');
  }
  const acquired = acquireRuntimeLease(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: 'inc-a' as RuntimeIncarnationId,
    fencingGeneration: 0,
  });
  if (acquired.kind !== 'acquired') {
    throw new Error('无法取得 Runtime Lease');
  }
  writer = {
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: 'inc-a' as RuntimeIncarnationId,
    fencingGeneration: acquired.lease.fencingGeneration,
  };

  const graph = graphFor(graphIdForScope());
  const recorded = recordInitialGraph({
    store,
    coordinationScopeId: SCOPE,
    writer,
    graph,
    mapRevision: 0,
    planRevision: 1,
    orcaRunId: 'run_x',
  });
  if (recorded.kind !== 'recorded') {
    throw new Error('无法记录初始 GraphVersion');
  }
  candidate = recorded.version;
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 输入构造
// ---------------------------------------------------------------------------

function graphIdForScope(): GraphId {
  return `${SCOPE}#g1` as GraphId;
}

function graphFor(graphId: GraphId): ExecutionGraph {
  return {
    graphId,
    generation: generation(1),
    concurrencyLimit: 1,
    workPackages: [
      {
        workPackageId: 'wp-1' as WorkPackageId,
        title: '首个工作包',
        dependsOn: [],
        scopeEnvelope: { include: ['src'], exclude: [] },
        budget: {
          implementationAttempts: 2,
          validatorRepairs: 2,
          graphRevisions: 2,
          specificationRevisions: 2,
          maxRecoveriesPerWorkerAttempt: 1,
        },
      },
    ],
  };
}

/** 合法 raw Manifest；`limits` 缺省表示只测试默认值路径。 */
type RawManifest = {
  manifestVersion: number;
  coordinationScopeId: string;
  planningCycleId: string;
  destinationRef: { kind: string; id: string; version: number };
  routeMapRef: { kind: string; id: string; version: number };
  implementationPlanRef: { kind: string; id: string; version: number };
  graph: { graphId: string; generation: number; version: number };
  baselineHead: string;
  orcaRunId: string;
  workerProfiles: { profileRef: { kind: string; id: string }; role: string; harness: string }[];
  permissions: Record<string, boolean>;
  limits?: Record<string, number>;
  workspacePolicy: { canonicalWorktree: string; worktreeIsolation: string };
  gitPolicy: { canonicalBranch: string; remotes: string[]; refs: string[]; allowForcePush: boolean };
  dependencyPolicy: { allowDependencyChanges: boolean; registry: string | null };
  acceptedRisks: string[];
};

function manifestFor(record: GraphVersionRecord, limits?: Record<string, number>): RawManifest {
  const base: RawManifest = {
    manifestVersion: 1,
    coordinationScopeId: SCOPE,
    planningCycleId: CYCLE,
    destinationRef: { kind: 'destination', id: 'd', version: 1 },
    routeMapRef: { kind: 'route-map', id: 'map', version: record.mapRevision },
    implementationPlanRef: { kind: 'implementation-plan', id: 'plan', version: record.planRevision },
    graph: { graphId: record.graphId, generation: record.generation, version: record.version },
    baselineHead: 'abc123',
    orcaRunId: 'run_x',
    workerProfiles: [
      { profileRef: { kind: 'worker-profile', id: 'p-planner' }, role: 'planner', harness: 'codex' },
      { profileRef: { kind: 'worker-profile', id: 'p-implementation' }, role: 'implementation', harness: 'codex' },
      { profileRef: { kind: 'worker-profile', id: 'p-validator' }, role: 'validator', harness: 'codex' },
      { profileRef: { kind: 'worker-profile', id: 'p-finalizer' }, role: 'finalizer', harness: 'codex' },
    ],
    permissions: {
      planner: true,
      implementation: true,
      validator: true,
      finalizer: true,
      gitIntegration: true,
      dependencyChanges: true,
    },
    workspacePolicy: { canonicalWorktree: '/tmp/wt', worktreeIsolation: 'per_work_package' },
    gitPolicy: { canonicalBranch: 'main', remotes: ['origin'], refs: ['main'], allowForcePush: false },
    dependencyPolicy: { allowDependencyChanges: false, registry: null },
    acceptedRisks: [],
  };
  return limits === undefined ? base : { ...base, limits };
}

/** 除 maxRecoveriesPerWorkerAttempt 以外的全部上限，用来验证缺省即取默认值 1。 */
function limitsWithoutRecoveries(): Record<string, number> {
  return {
    maxActiveWorkPackages: 8,
    concurrencyLimit: 1,
    implementationAttempts: 2,
    validatorRepairs: 2,
    graphRevisions: 2,
    specificationRevisions: 2,
  };
}

function limitsWithRecoveries(value: number): Record<string, number> {
  return { ...limitsWithoutRecoveries(), maxRecoveriesPerWorkerAttempt: value };
}

/** 一份字段齐全的合法 raw Manifest（恢复上限留空以走默认值路径）。 */
function validManifest(record: GraphVersionRecord): RawManifest {
  return manifestFor(record, limitsWithoutRecoveries());
}

function withoutKey(raw: RawManifest, key: keyof RawManifest): unknown {
  const record: Record<string, unknown> = { ...raw };
  delete record[key];
  return record;
}

// ---------------------------------------------------------------------------
// store 读回与调用辅助
// ---------------------------------------------------------------------------

function scopeRecord(): ScopeRecord {
  const result = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  if (result.kind !== 'scope' || result.scope === null) {
    throw new Error('Scope 不存在');
  }
  return result.scope;
}

function propose(raw: unknown) {
  return proposeManifest({
    store,
    coordinationScopeId: SCOPE,
    rawManifest: raw,
    candidate,
    currentPlanRevision: candidate.planRevision,
  });
}

function approveManifest(
  authorizationId: string,
  manifest: ExecutionAuthorizationManifest,
): ExecutionAuthorizationRecord {
  const recorded = recordApproval({
    store,
    coordinationScopeId: SCOPE,
    writer,
    authorizationId,
    manifest,
    currentPlanRevision: candidate.planRevision,
    approvalRef: `approval-${authorizationId}`,
  });
  if (recorded.kind !== 'recorded') {
    throw new Error(`记录批准失败: ${recorded.failure.code}`);
  }
  return recorded.authorization;
}

function proposeAndApprove(authorizationId: string, raw: unknown): ExecutionAuthorizationRecord {
  const proposed = propose(raw);
  if (proposed.kind !== 'proposed') {
    throw new Error(`组装 Manifest 失败: ${proposed.failure.code}`);
  }
  return approveManifest(authorizationId, proposed.manifest);
}

function authorizations(): readonly ExecutionAuthorizationRecord[] {
  const result = store.query({ kind: 'authorizations', coordinationScopeId: SCOPE });
  if (result.kind !== 'authorizations') {
    throw new Error('无法读取授权记录');
  }
  return result.authorizations;
}

// ---------------------------------------------------------------------------
// Manifest 完整性
// ---------------------------------------------------------------------------

test('缺少 limits 或 baseline HEAD 时在提交批准之前就被拒绝', () => {
  const missingLimits = propose(withoutKey(manifestFor(candidate), 'limits'));
  expect(missingLimits.kind).toBe('rejected');
  if (missingLimits.kind === 'rejected') {
    expect(missingLimits.failure.code.length).toBeGreaterThan(0);
  }

  const missingHead = propose(withoutKey(validManifest(candidate), 'baselineHead'));
  expect(missingHead.kind).toBe('rejected');
  if (missingHead.kind === 'rejected') {
    expect(missingHead.failure.code.length).toBeGreaterThan(0);
  }

  // 失败发生在写入之前：没有产生任何授权记录。
  expect(authorizations()).toEqual([]);
  expect(scopeRecord().authorizationId).toBeNull();
});

test('Manifest 与候选图不一致时以 candidate_mismatch 拒绝并指出字段', () => {
  const wrongGraphVersion = validManifest(candidate);
  wrongGraphVersion.graph.version = candidate.version + 1;
  const graphMismatch = propose(wrongGraphVersion);
  expect(graphMismatch.kind).toBe('rejected');
  if (graphMismatch.kind === 'rejected') {
    expect(graphMismatch.failure.code).toBe('candidate_mismatch');
    expect(graphMismatch.failure.message).toContain('graphVersion');
  }

  const wrongMapVersion = validManifest(candidate);
  wrongMapVersion.routeMapRef.version = candidate.mapRevision + 1;
  const mapMismatch = propose(wrongMapVersion);
  expect(mapMismatch.kind).toBe('rejected');
  if (mapMismatch.kind === 'rejected') {
    expect(mapMismatch.failure.code).toBe('candidate_mismatch');
    expect(mapMismatch.failure.message).toContain('routeMapRevision');
  }

  const wrongRun = validManifest(candidate);
  wrongRun.orcaRunId = 'run-other';
  const runMismatch = propose(wrongRun);
  expect(runMismatch.kind).toBe('rejected');
  if (runMismatch.kind === 'rejected') expect(runMismatch.failure.message).toContain('orcaRunId');
});

test('未获批准时不产生可执行授权，恢复额度也视为未授权', () => {
  const read = activeAuthorization(store, SCOPE);
  expect(read.kind).toBe('read');
  if (read.kind === 'read') {
    expect(read.authorization).toBeNull();
  }
  expect(maxRecoveriesFor(null)).toBeNull();
  expect(recoveryAllowance({ authorization: null, usedRecoveries: 0 }).kind).toBe('not_authorized');
  expect(executionPolicyIsAbsent({ store, coordinationScopeId: SCOPE })).toBe(true);
});

// ---------------------------------------------------------------------------
// 批准
// ---------------------------------------------------------------------------

test('单次决定覆盖整份 Manifest，并一起推进 Scope 的授权指针', () => {
  const proposed = propose(validManifest(candidate));
  expect(proposed.kind).toBe('proposed');
  if (proposed.kind !== 'proposed') {
    return;
  }

  const recorded = recordApproval({
    store,
    coordinationScopeId: SCOPE,
    writer,
    authorizationId: 'auth-1',
    manifest: proposed.manifest,
    currentPlanRevision: candidate.planRevision,
    approvalRef: 'interaction-1',
  });
  expect(recorded.kind).toBe('recorded');
  if (recorded.kind !== 'recorded') {
    return;
  }

  const authorization = recorded.authorization;
  expect(authorization.manifestVersion).toBe(proposed.manifest.manifestVersion);
  expect(authorization.fingerprint).toBe(proposed.fingerprint);
  expect(authorization.authorizationVersion).toBe(1);
  expect(authorization.approvalRef).toBe('interaction-1');
  // 整份 Manifest 生效，不只是被检查过的几个引用字段。
  expect(authorization.manifest).toEqual(proposed.manifest);
  expect(authorization.manifest.workerProfiles).toHaveLength(4);
  expect(authorization.manifest.permissions).toEqual(proposed.manifest.permissions);

  const scope = scopeRecord();
  expect(scope.authorizationId).toBe('auth-1');
  expect(scope.authorizationVersion).toBe(1);

  const active = activeAuthorization(store, SCOPE);
  expect(active.kind).toBe('read');
  if (active.kind === 'read') {
    expect(active.authorization?.authorizationId).toBe('auth-1');
  }
});

test('恢复上限缺省时被显式写入默认值 1，并按它判定剩余次数', () => {
  const proposed = propose(manifestFor(candidate, limitsWithoutRecoveries()));
  expect(proposed.kind).toBe('proposed');
  if (proposed.kind !== 'proposed') {
    return;
  }
  expect(proposed.manifest.limits.maxRecoveriesPerWorkerAttempt).toBe(1);

  const authorization = approveManifest('auth-1', proposed.manifest);
  expect(maxRecoveriesFor(authorization)).toBe(1);
  expect(recoveryAllowance({ authorization, usedRecoveries: 0 })).toEqual({
    kind: 'available',
    remaining: 1,
  });
  expect(recoveryAllowance({ authorization, usedRecoveries: 1 })).toEqual({
    kind: 'exhausted',
    limit: 1,
  });
});

test('改变恢复上限需要重新授权：产生新版本与不同指纹，旧记录仍在历史里', () => {
  const first = proposeAndApprove('auth-1', manifestFor(candidate, limitsWithoutRecoveries()));
  expect(first.authorizationVersion).toBe(1);
  expect(maxRecoveriesFor(first)).toBe(1);

  const proposed = propose(manifestFor(candidate, limitsWithRecoveries(2)));
  expect(proposed.kind).toBe('proposed');
  if (proposed.kind !== 'proposed') {
    return;
  }
  expect(proposed.fingerprint).not.toBe(first.fingerprint);

  const second = approveManifest('auth-2', proposed.manifest);
  expect(second.authorizationVersion).toBe(2);
  expect(maxRecoveriesFor(second)).toBe(2);

  const history = authorizations();
  expect(history.map((record) => record.authorizationId)).toEqual(['auth-1', 'auth-2']);
  expect(history[0]?.manifest.limits.maxRecoveriesPerWorkerAttempt).toBe(1);
  expect(history[0]?.fingerprint).toBe(first.fingerprint);
});

test('批准落盘前地图或计划已变化时拒绝旧 Manifest', () => {
  const proposed = propose(validManifest(candidate));
  expect(proposed.kind).toBe('proposed');
  if (proposed.kind !== 'proposed') return;

  const advanced = store.transact({
    kind: 'advance-map-revision',
    coordinationScopeId: SCOPE,
    expectedRevision: scopeRecord().revision,
    writer,
    mapRevision: scopeRecord().mapRevision + 1,
  });
  expect(advanced.kind).toBe('committed');

  const staleMap = recordApproval({
    store,
    coordinationScopeId: SCOPE,
    writer,
    authorizationId: 'auth-stale-map',
    manifest: proposed.manifest,
    currentPlanRevision: candidate.planRevision,
    approvalRef: 'approval-stale-map',
  });
  expect(staleMap.kind).toBe('rejected');

  const stalePlan = recordApproval({
    store,
    coordinationScopeId: SCOPE,
    writer,
    authorizationId: 'auth-stale-plan',
    manifest: { ...proposed.manifest, routeMapRef: { ...proposed.manifest.routeMapRef, version: scopeRecord().mapRevision } },
    currentPlanRevision: candidate.planRevision + 1,
    approvalRef: 'approval-stale-plan',
  });
  expect(stalePlan.kind).toBe('rejected');
  expect(authorizations()).toEqual([]);
});

// ---------------------------------------------------------------------------
// 授权边界
// ---------------------------------------------------------------------------

test('策略内操作直接放行，发布与部署仍需要单独授权', () => {
  proposeAndApprove('auth-1', manifestFor(candidate, limitsWithoutRecoveries()));

  const dispatch = assertAuthorized({
    store,
    coordinationScopeId: SCOPE,
    category: 'worker-dispatch',
    role: 'implementation',
  });
  expect(dispatch.kind).toBe('read');
  if (dispatch.kind === 'read') {
    expect(dispatch.decision.kind).toBe('authorized');
  }

  for (const category of ['publish', 'deploy']) {
    const decision = assertAuthorized({ store, coordinationScopeId: SCOPE, category });
    expect(decision.kind).toBe('read');
    if (decision.kind === 'read') {
      expect(decision.decision.kind).toBe('requires_separate_authorization');
    }
  }
});

test('批准 Execution Authorization 不切换 Coordination 模式', () => {
  proposeAndApprove('auth-1', manifestFor(candidate, limitsWithoutRecoveries()));
  expect(scopeRecord().mode).toBe('route_planning');
});

test('候选图缺失时批准被拒绝', () => {
  const otherScope = 'scope-2' as CoordinationScopeId;
  const otherSession = 'session-2' as CoordinatorSessionId;
  const initialized = initializeCoordinationScope({
    store,
    coordinationScopeId: otherScope,
    coordinatorSessionId: otherSession,
    coordinatorModelConfigurationRef: 'model-config-2',
    planningCycleId: 'cycle-2' as PlanningCycleId,
    fullBranchRef: 'refs/heads/other',
    canonicalWorktreePath: '/tmp/orca-test-worktree-other',
  });
  expect(initialized.kind).toBe('initialized');

  const proposed = propose(manifestFor(candidate, limitsWithoutRecoveries()));
  expect(proposed.kind).toBe('proposed');
  if (proposed.kind !== 'proposed') {
    return;
  }

  const result = recordApproval({
    store,
    coordinationScopeId: otherScope,
    writer,
    authorizationId: 'auth-other',
    manifest: proposed.manifest,
    currentPlanRevision: candidate.planRevision,
    approvalRef: 'approval-other',
  });

  expect(result.kind).toBe('rejected');
  if (result.kind === 'rejected') {
    expect(result.failure.code).toBe('candidate_missing');
  }
  expect(authorizations()).toEqual([]);
});
