/**
 * IC-05：模式切换与 Execution Coordination Lease 的行为测试
 * （Requirement「Handoff gate, mode transition and execution lease」）。
 *
 * 覆盖 Scenario：
 * - 存在开放票据 / 编译未通过 / 缺少批准时不切换：`transitionToExecution` 返回 `blocked`，
 *   Scope 保持 `route_planning`，不产生执行租约，也不建立 worktree；
 * - 只有一个 Session 持有 Lease：切换后恰好一条未释放的执行租约，其他 Session 既不能再次切换，
 *   也不能消费共享预算（`constraint`），只能观察；
 * - 切换成功同批生效：模式、候选图、授权引用与 Planning Cycle 一起落到 Scope 上；
 * - 已在执行模式时再次切换被显式拒绝，且不产生第二条执行租约；
 * - Lease 持有者退出后可恢复：显式释放或越过 TTL 后，同一 Session 以更大 generation 重新取得
 *   Runtime Lease，执行租约不自动转移；
 * - Lease 过期不释放其他所有权：Ticket Claim 与已记录预算保持不变。
 *
 * 候选图与授权都走真实路径（`recordInitialGraph` + `proposeManifest` + `recordApproval`），
 * 因此这里验证的是持久事实之间的交接，而不是内存对象。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { openCoordinationStore, type CoordinationStore } from '../../src/adapters/storage/coordination-store.js';
import {
  DEFAULT_RUNTIME_LEASE_TTL_MS,
  acquireRuntimeLease,
} from '../../src/application/coordination/lease-service.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  GraphGeneration,
  GraphId,
  PlanningCycleId,
  RuntimeIncarnationId,
} from '../../src/application/dto/identity.js';
import type {
  CoordinationSnapshot,
  CoordinationWriter,
  LeaseRecord,
  ScopeRecord,
} from '../../src/application/ports/branch-coordination-store.js';
import { recordApproval, proposeManifest } from '../../src/application/planning/authorization-service.js';
import { recordInitialGraph } from '../../src/application/planning/graph-history.js';
import type { HandoffGateFacts } from '../../src/application/planning/handoff-gate.js';
import { initializeCoordinationScope } from '../../src/application/planning/initialize-scope.js';
import { transitionToExecution } from '../../src/application/planning/lease-handoff.js';
import { WORKER_ROLES, type ExecutionAuthorizationRecord } from '../../src/domain/planning/execution-authorization.js';
import type { ExecutionGraph, GraphVersionRecord } from '../../src/domain/planning/execution-graph.js';

const SCOPE = 'scope-1' as CoordinationScopeId;
const SESSION_A = 'session-a' as CoordinatorSessionId;
const SESSION_B = 'session-b' as CoordinatorSessionId;
const INC_A = 'inc-a' as RuntimeIncarnationId;
const INC_B = 'inc-b' as RuntimeIncarnationId;
const CYCLE = 'cycle-1' as PlanningCycleId;
const NEXT_CYCLE = 'cycle-2' as PlanningCycleId;
const GRAPH_ID = 'graph-1' as GraphId;
const PLAN_REVISION = 1;
const BUDGET_KEY = 'coordinator_model_calls';

let directory = '';
let store: CoordinationStore;
let writerA: CoordinationWriter;
let writerB: CoordinationWriter;
let now = 1_000;

const clock = (): number => now;

function emptyGraph(): ExecutionGraph {
  return { graphId: GRAPH_ID, generation: 1 as GraphGeneration, concurrencyLimit: 1, workPackages: [] };
}

function scopeRecord(): ScopeRecord {
  const scope = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  if (scope.kind !== 'scope' || scope.scope === null) {
    throw new Error('Scope 不存在');
  }
  return scope.scope;
}

function currentRevision(): number {
  return scopeRecord().revision;
}

function snapshotOf(): CoordinationSnapshot {
  const snapshot = store.query({ kind: 'snapshot', coordinationScopeId: SCOPE });
  if (snapshot.kind !== 'snapshot') {
    throw new Error('无法读取 snapshot');
  }
  return snapshot.snapshot;
}

function leasesOf(): readonly LeaseRecord[] {
  const leases = store.query({ kind: 'leases', coordinationScopeId: SCOPE });
  if (leases.kind !== 'leases') {
    throw new Error('无法读取 leases');
  }
  return leases.leases;
}

function unreleasedExecutionLeases(): readonly LeaseRecord[] {
  return leasesOf().filter((lease) => lease.kind === 'execution_coordination' && lease.releasedAt === null);
}

function runtimeLeaseFor(sessionId: CoordinatorSessionId): LeaseRecord | null {
  return (
    leasesOf().find(
      (lease) => lease.kind === 'runtime' && lease.coordinatorSessionId === sessionId && lease.releasedAt === null,
    ) ?? null
  );
}

function consumedOf(budgetKey: string): number {
  const counters = store.query({ kind: 'budget-counters', coordinationScopeId: SCOPE });
  if (counters.kind !== 'budget-counters') {
    throw new Error('无法读取预算计数');
  }
  return counters.counters.find((counter) => counter.budgetKey === budgetKey)?.consumed ?? 0;
}

function registerAndLease(sessionId: CoordinatorSessionId, incarnation: RuntimeIncarnationId): CoordinationWriter {
  const registered = store.transact({
    kind: 'register-session',
    coordinationScopeId: SCOPE,
    expectedRevision: currentRevision(),
    writer: writerA,
    coordinatorSessionId: sessionId,
    coordinatorModelConfigurationRef: `model-config-${sessionId}`,
    lifecycleState: 'registered',
  });
  if (registered.kind !== 'committed') {
    throw new Error(`无法注册 ${sessionId}：${registered.message}`);
  }
  const acquired = acquireRuntimeLease(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: sessionId,
    runtimeIncarnationId: incarnation,
    fencingGeneration: 0,
  });
  if (acquired.kind !== 'acquired') {
    throw new Error(`${sessionId} 无法取得 Runtime Lease`);
  }
  return {
    coordinatorSessionId: sessionId,
    runtimeIncarnationId: incarnation,
    fencingGeneration: acquired.lease.fencingGeneration,
  };
}

/** 走真实编译记录路径产出候选图：初始版本绑定当前地图 revision 与给定计划 revision。 */
function recordCandidate(): GraphVersionRecord {
  const recorded = recordInitialGraph({
    store,
    coordinationScopeId: SCOPE,
    writer: writerA,
    graph: emptyGraph(),
    mapRevision: scopeRecord().mapRevision,
    planRevision: PLAN_REVISION,
    orcaRunId: 'run-1',
  });
  if (recorded.kind !== 'recorded') {
    throw new Error(`无法记录候选图：${recorded.failure.code} ${recorded.failure.message}`);
  }
  return recorded.version;
}

/** 走真实批准路径产出版权记录：Manifest 必须逐项绑定该候选图。 */
function recordAuthorization(candidate: GraphVersionRecord): ExecutionAuthorizationRecord {
  const proposed = proposeManifest({
    store,
    coordinationScopeId: SCOPE,
    candidate,
    currentPlanRevision: candidate.planRevision,
    rawManifest: {
      coordinationScopeId: SCOPE,
      planningCycleId: CYCLE,
      destinationRef: { kind: 'destination', id: 'destination-1', version: 1 },
      routeMapRef: { kind: 'route-map', id: 'map-1', version: candidate.mapRevision },
      implementationPlanRef: {
        kind: 'implementation-plan',
        id: 'plan-1',
        version: candidate.planRevision,
      },
      graph: { graphId: candidate.graphId, generation: candidate.generation, version: candidate.version },
      baselineHead: 'head-1',
      orcaRunId: 'run-1',
      workerProfiles: WORKER_ROLES.map((role) => ({
        profileRef: { kind: 'worker-profile', id: `profile-${role}` },
        role,
        harness: 'codex',
      })),
      permissions: {
        planner: true,
        implementation: true,
        validator: true,
        finalizer: true,
        gitIntegration: false,
        dependencyChanges: false,
      },
      // 预算上限留空对象由组装阶段补默认值；`limits` 整体缺失仍按「缺字段不提交批准」被拒绝。
      limits: {},
      workspacePolicy: { canonicalWorktree: '/tmp/worktree', worktreeIsolation: 'per_work_package' },
      gitPolicy: {
        canonicalBranch: 'main',
        remotes: ['origin'],
        refs: ['refs/heads/main'],
        allowForcePush: false,
      },
      dependencyPolicy: { allowDependencyChanges: false, registry: null },
      acceptedRisks: ['risk-1'],
    },
  });
  if (proposed.kind !== 'proposed') {
    throw new Error(`无法组装 Manifest：${proposed.failure.code} ${proposed.failure.message}`);
  }
  const recorded = recordApproval({
    store,
    coordinationScopeId: SCOPE,
    writer: writerA,
    authorizationId: 'authorization-1',
    manifest: proposed.manifest,
    currentPlanRevision: candidate.planRevision,
    approvalRef: 'approval-1',
  });
  if (recorded.kind !== 'recorded') {
    throw new Error(`无法记录批准：${recorded.failure.code} ${recorded.failure.message}`);
  }
  return recorded.authorization;
}

function gateFactsFor(
  candidate: GraphVersionRecord | null,
  authorization: ExecutionAuthorizationRecord | null,
): HandoffGateFacts {
  return {
    openDecisionTickets: 0,
    fogPresent: false,
    unresolvedInteractions: 0,
    unresolvedMutations: 0,
    currentMapRevision: candidate?.mapRevision ?? 0,
    currentPlanRevision: candidate?.planRevision ?? PLAN_REVISION,
    candidate,
    authorization,
  };
}

function transition(
  writer: CoordinationWriter,
  candidate: GraphVersionRecord | null,
  authorization: ExecutionAuthorizationRecord | null,
  planningCycleId: PlanningCycleId | null = CYCLE,
) {
  return transitionToExecution({
    store,
    coordinationScopeId: SCOPE,
    planningCycleId,
    writer,
    gateFacts: gateFactsFor(candidate, authorization),
  });
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-lease-handoff-'));
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
    coordinatorModelConfigurationRef: 'model-config-a',
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
    runtimeIncarnationId: INC_A,
    fencingGeneration: 0,
  });
  if (acquired.kind !== 'acquired') {
    throw new Error('无法取得 Runtime Lease');
  }
  writerA = {
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: INC_A,
    fencingGeneration: acquired.lease.fencingGeneration,
  };
  writerB = registerAndLease(SESSION_B, INC_B);
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test('编译未通过时不切换，Scope 仍是 route_planning 且没有执行租约', () => {
  const result = transition(writerA, null, null);

  expect(result.kind).toBe('blocked');
  if (result.kind === 'blocked') {
    expect(result.blockers.map((entry) => entry.code)).toContain('compilation_not_accepted');
  }
  expect(scopeRecord().mode).toBe('route_planning');
  expect(scopeRecord().graphId).toBeNull();
  expect(unreleasedExecutionLeases()).toHaveLength(0);
  expect(snapshotOf().executionLease).toBeNull();
});

test('切换成功同批生效：模式、候选图、授权引用与 Planning Cycle 一起落到 Scope 上', () => {
  const candidate = recordCandidate();
  const authorization = recordAuthorization(candidate);
  const before = currentRevision();

  const result = transition(writerA, candidate, authorization, NEXT_CYCLE);

  expect(result.kind).toBe('transitioned');
  if (result.kind !== 'transitioned') {
    return;
  }
  expect(result.revision).toBeGreaterThan(before);
  expect(result.authorization.authorizationId).toBe(authorization.authorizationId);

  const scope = scopeRecord();
  expect(scope.mode).toBe('execution_coordination');
  expect(scope.graphId).toBe(candidate.graphId);
  expect(scope.graphVersion).toBe(candidate.version);
  expect(scope.authorizationId).toBe(authorization.authorizationId);
  expect(scope.authorizationVersion).toBe(authorization.authorizationVersion);
  expect(scope.planningCycleId).toBe(NEXT_CYCLE);
});

test('切换后只有一个 Session 持有执行租约，其他 Session 只能观察', () => {
  const candidate = recordCandidate();
  const authorization = recordAuthorization(candidate);
  expect(transition(writerA, candidate, authorization).kind).toBe('transitioned');

  const held = unreleasedExecutionLeases();
  expect(held).toHaveLength(1);
  expect(held[0]?.coordinatorSessionId).toBe(SESSION_A);

  // 第二个 Session 的重复切换既不成功，也不产生第二条执行租约。
  const again = transition(writerB, candidate, authorization);
  expect(again.kind).toBe('rejected');
  if (again.kind === 'rejected') {
    expect(again.code).toBe('invalid_state');
  }
  const stillHeld = unreleasedExecutionLeases();
  expect(stillHeld).toHaveLength(1);
  expect(stillHeld[0]?.coordinatorSessionId).toBe(SESSION_A);

  // 非持有者连共享预算都不能花：它只能读。
  const spent = store.transact({
    kind: 'consume-budget',
    coordinationScopeId: SCOPE,
    expectedRevision: currentRevision(),
    writer: writerB,
    budgetKey: BUDGET_KEY,
    approvedLimitRef: 'approval-1',
    amount: 1,
  });
  expect(spent.kind).toBe('rejected');
  if (spent.kind === 'rejected') {
    expect(spent.code).toBe('constraint');
  }
  expect(consumedOf(BUDGET_KEY)).toBe(0);
});

test('已在执行模式时再次切换被拒绝，且不产生第二条执行租约', () => {
  const candidate = recordCandidate();
  const authorization = recordAuthorization(candidate);
  expect(transition(writerA, candidate, authorization).kind).toBe('transitioned');

  const again = transition(writerA, candidate, authorization);
  expect(again.kind).toBe('rejected');
  if (again.kind === 'rejected') {
    expect(again.code).toBe('invalid_state');
  }
  expect(scopeRecord().mode).toBe('execution_coordination');
  expect(unreleasedExecutionLeases()).toHaveLength(1);
});

test('Lease 持有者退出后可重新取得租约，模式与执行租约归属不变', () => {
  const candidate = recordCandidate();
  const authorization = recordAuthorization(candidate);
  expect(transition(writerA, candidate, authorization).kind).toBe('transitioned');

  // 显式释放 Runtime Lease：执行租约不属于该释放路径。
  const released = store.transact({
    kind: 'release-runtime-lease',
    coordinationScopeId: SCOPE,
    expectedRevision: currentRevision(),
    writer: writerA,
  });
  expect(released.kind).toBe('committed');

  const recovered = acquireRuntimeLease(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: 'inc-a2' as RuntimeIncarnationId,
    fencingGeneration: writerA.fencingGeneration + 1,
  });
  expect(recovered.kind).toBe('acquired');
  if (recovered.kind !== 'acquired') {
    return;
  }
  expect(recovered.lease.fencingGeneration).toBe(writerA.fencingGeneration + 1);
  expect(runtimeLeaseFor(SESSION_A)?.runtimeIncarnationId).toBe('inc-a2');

  expect(scopeRecord().mode).toBe('execution_coordination');
  expect(unreleasedExecutionLeases().map((lease) => lease.coordinatorSessionId)).toEqual([SESSION_A]);

  // 越过 TTL 后同一 Session 再次取得：执行租约仍不自动转移。
  now += DEFAULT_RUNTIME_LEASE_TTL_MS + 1;
  const afterExpiry = acquireRuntimeLease(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: 'inc-a3' as RuntimeIncarnationId,
    fencingGeneration: recovered.lease.fencingGeneration + 1,
  });
  expect(afterExpiry.kind).toBe('acquired');
  if (afterExpiry.kind === 'acquired') {
    expect(afterExpiry.lease.fencingGeneration).toBe(recovered.lease.fencingGeneration + 1);
  }
  expect(scopeRecord().mode).toBe('execution_coordination');
  expect(unreleasedExecutionLeases().map((lease) => lease.coordinatorSessionId)).toEqual([SESSION_A]);
});

test('Runtime Lease 过期不释放 Ticket Claim 与已记录预算', () => {
  const candidate = recordCandidate();
  const authorization = recordAuthorization(candidate);

  const claimed = store.transact({
    kind: 'record-ticket-claim',
    coordinationScopeId: SCOPE,
    expectedRevision: currentRevision(),
    writer: writerA,
    ticketRef: { kind: 'decision-ticket', id: 'ticket-1' },
  });
  expect(claimed.kind).toBe('committed');
  expect(transition(writerA, candidate, authorization).kind).toBe('transitioned');

  const spent = store.transact({
    kind: 'consume-budget',
    coordinationScopeId: SCOPE,
    expectedRevision: currentRevision(),
    writer: writerA,
    budgetKey: BUDGET_KEY,
    approvedLimitRef: 'approval-1',
    amount: 3,
  });
  expect(spent.kind).toBe('committed');
  expect(consumedOf(BUDGET_KEY)).toBe(3);

  now += DEFAULT_RUNTIME_LEASE_TTL_MS + 1;

  const snapshot = snapshotOf();
  expect(snapshot.ticketClaims.map((claim) => claim.ticketRef.id)).toEqual(['ticket-1']);
  expect(snapshot.ticketClaims.every((claim) => claim.state === 'active')).toBe(true);
  expect(snapshot.ticketClaims[0]?.coordinatorSessionId).toBe(SESSION_A);
  expect(consumedOf(BUDGET_KEY)).toBe(3);
  expect(unreleasedExecutionLeases().map((lease) => lease.coordinatorSessionId)).toEqual([SESSION_A]);
});
