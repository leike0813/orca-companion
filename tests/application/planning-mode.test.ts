/**
 * IC-05：Coordination Scope 的模式与控制状态行为测试
 * （Requirement「Handoff gate, mode transition and execution lease」）。
 *
 * 覆盖 Scenario：
 * - 模式随 Scope 而非 Session 变化：注册、标记取消第二个 Coordinator Session 都不改变 Scope 的
 *   模式，也不产生 Session 级的第二份模式；
 * - 控制状态不伪装成模式：`paused` / `blocked` / `cancelling` / `cancelled` /
 *   `replanning_transition` 都只改变 `controlState`，模式保持 `route_planning`；
 * - 规划用例复用既有的 `CoordinationMode` / `ControlState` 闭集：读回的取值属于
 *   `COORDINATION_MODES` / `CONTROL_STATES`，且 `isCoordinationMode('planning')` 为假；
 * - 切换成功后模式记录在 Scope 上（`execution_coordination`），仍来自同一闭集。
 *
 * 本文件关注模式与控制状态的正交性，因此候选图与授权用最小合法对象表示；完整的编译与批准路径
 * 由 `lease-handoff.test.ts` 覆盖。
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
  GraphVersion,
  PlanningCycleId,
  RuntimeIncarnationId,
} from '../../src/application/dto/identity.js';
import type {
  CoordinationWriter,
  ScopeRecord,
  SessionLifecycleState,
} from '../../src/application/ports/branch-coordination-store.js';
import { initializeCoordinationScope } from '../../src/application/planning/initialize-scope.js';
import { transitionToExecution } from '../../src/application/planning/lease-handoff.js';
import { DEFAULT_EXECUTION_LIMITS } from '../../src/domain/planning/budget-policy.js';
import { CONTROL_STATES, COORDINATION_MODES, isControlState, isCoordinationMode, type ControlState } from '../../src/domain/coordination/mode.js';
import {
  MANIFEST_VERSION,
  WORKER_ROLES,
  type ExecutionAuthorizationRecord,
} from '../../src/domain/planning/execution-authorization.js';
import type { ExecutionGraph, GraphVersionRecord } from '../../src/domain/planning/execution-graph.js';

const SCOPE = 'scope-1' as CoordinationScopeId;
const SESSION_A = 'session-a' as CoordinatorSessionId;
const SESSION_B = 'session-b' as CoordinatorSessionId;
const INC_A = 'inc-a' as RuntimeIncarnationId;
const CYCLE = 'cycle-1' as PlanningCycleId;
const GRAPH_ID = 'graph-1' as GraphId;
const MAP_REVISION = 1;
const PLAN_REVISION = 1;

/** 与 Requirement 的点名一致：暂停、阻塞、取消与 Replanning Transition。 */
const CONTROL_STATES_UNDER_TEST: readonly ControlState[] = [
  'paused',
  'blocked',
  'cancelling',
  'cancelled',
  'replanning_transition',
];

let directory = '';
let store: CoordinationStore;
let writerA: CoordinationWriter;
let now = 1_000;

const clock = (): number => now;

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

function sessionLifecycleOf(sessionId: CoordinatorSessionId): SessionLifecycleState | null {
  const sessions = store.query({ kind: 'sessions', coordinationScopeId: SCOPE });
  if (sessions.kind !== 'sessions') {
    throw new Error('无法读取 Session registry');
  }
  return sessions.sessions.find((entry) => entry.coordinatorSessionId === sessionId)?.lifecycleState ?? null;
}

function registerSession(
  sessionId: CoordinatorSessionId,
  lifecycleState: SessionLifecycleState,
): ReturnType<CoordinationStore['transact']> {
  return store.transact({
    kind: 'register-session',
    coordinationScopeId: SCOPE,
    expectedRevision: currentRevision(),
    writer: writerA,
    coordinatorSessionId: sessionId,
    coordinatorModelConfigurationRef: `model-config-${sessionId}`,
    lifecycleState,
  });
}

function emptyGraph(): ExecutionGraph {
  return { graphId: GRAPH_ID, generation: 1 as GraphGeneration, concurrencyLimit: 1, workPackages: [] };
}

/** 最小合法候选图：所有 Work Package 都未开始（空图）。 */
function candidateFixture(): GraphVersionRecord {
  return {
    graphId: GRAPH_ID,
    generation: 1 as GraphGeneration,
    version: 1 as GraphVersion,
    recordKind: 'initial',
    parentVersion: null,
    mapRevision: MAP_REVISION,
    planRevision: PLAN_REVISION,
    orcaRunId: 'run-1',
    graph: emptyGraph(),
    recordedAt: 1,
  };
}

function authorizationFixture(candidate: GraphVersionRecord): ExecutionAuthorizationRecord {
  return {
    coordinationScopeId: SCOPE,
    authorizationId: 'authorization-1',
    authorizationVersion: 1,
    manifestVersion: MANIFEST_VERSION,
    fingerprint: 'fingerprint-1',
    manifest: {
      manifestVersion: MANIFEST_VERSION,
      coordinationScopeId: SCOPE,
      planningCycleId: CYCLE,
      destinationRef: { kind: 'destination', id: 'destination-1', version: 1 },
      routeMapRef: { kind: 'route-map', id: 'map-1', version: candidate.mapRevision },
      implementationPlanRef: { kind: 'implementation-plan', id: 'plan-1', version: candidate.planRevision },
      graph: { graphId: candidate.graphId, generation: candidate.generation, version: candidate.version },
      baselineHead: 'head-1',
      orcaRunId: 'run-1',
      workerProfiles: WORKER_ROLES.map((role) => ({
        profileRef: { kind: 'worker-profile' as const, id: `profile-${role}` },
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
      limits: DEFAULT_EXECUTION_LIMITS,
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
    approvedAt: 1,
    approvalRef: 'approval-1',
  };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-planning-mode-'));
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
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test('模式随 Scope 而非 Session 变化：注册与取消第二个 Session 都不改变它', () => {
  expect(scopeRecord().mode).toBe('route_planning');

  expect(registerSession(SESSION_B, 'registered').kind).toBe('committed');
  expect(sessionLifecycleOf(SESSION_B)).toBe('registered');
  expect(scopeRecord().mode).toBe('route_planning');

  expect(registerSession(SESSION_B, 'cancelled').kind).toBe('committed');
  expect(sessionLifecycleOf(SESSION_B)).toBe('cancelled');
  expect(scopeRecord().mode).toBe('route_planning');

  // 第二个 Session 的注册与取消都没有在 Scope 上留下第二种模式。
  expect(COORDINATION_MODES).toContain(scopeRecord().mode);
  expect(isCoordinationMode(scopeRecord().mode)).toBe(true);
});

test.each(CONTROL_STATES_UNDER_TEST)('控制状态 %s 不伪装成模式', (controlState) => {
  const recorded = store.transact({
    kind: 'record-control-state',
    coordinationScopeId: SCOPE,
    expectedRevision: currentRevision(),
    writer: writerA,
    controlState,
  });
  expect(recorded.kind).toBe('committed');

  const scope = scopeRecord();
  expect(scope.controlState).toBe(controlState);
  expect(scope.mode).toBe('route_planning');
});

test('模式与控制状态只有一套闭集取值，不存在第二套模式', () => {
  const scope = scopeRecord();

  expect(COORDINATION_MODES).toContain(scope.mode);
  expect(isCoordinationMode(scope.mode)).toBe(true);
  expect(CONTROL_STATES).toContain(scope.controlState);
  expect(isControlState(scope.controlState)).toBe(true);

  expect(isCoordinationMode('execution_coordination')).toBe(true);
  expect(isCoordinationMode('planning')).toBe(false);
  expect(isCoordinationMode('paused')).toBe(false);
  expect(isControlState('paused')).toBe(true);
  expect(isControlState('route_planning')).toBe(false);
  expect((COORDINATION_MODES as readonly string[]).includes('paused')).toBe(false);
});

test('切换成功后模式记录在 Scope 上，而不是某个 Session 上', () => {
  const candidate = candidateFixture();
  const authorization = authorizationFixture(candidate);

  const result = transitionToExecution({
    store,
    coordinationScopeId: SCOPE,
    planningCycleId: CYCLE,
    writer: writerA,
    gateFacts: {
      openDecisionTickets: 0,
      fogPresent: false,
      unresolvedInteractions: 0,
      unresolvedMutations: 0,
      currentMapRevision: candidate.mapRevision,
      currentPlanRevision: candidate.planRevision,
      candidate,
      authorization,
    },
  });
  expect(result.kind).toBe('transitioned');

  const scope = scopeRecord();
  expect(scope.mode).toBe('execution_coordination');
  expect(COORDINATION_MODES).toContain(scope.mode);
  expect(isCoordinationMode(scope.mode)).toBe(true);

  // 切换之后再注册（并取消）一个 Session，Scope 的模式保持不变。
  expect(registerSession(SESSION_B, 'cancelled').kind).toBe('committed');
  expect(scopeRecord().mode).toBe('execution_coordination');
});
