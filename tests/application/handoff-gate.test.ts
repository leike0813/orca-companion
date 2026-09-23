/**
 * IC-05：Handoff Gate 的行为测试
 * （Requirement「Handoff gate, mode transition and execution lease」）。
 *
 * 覆盖 Scenario：
 * - 存在开放票据时不切换：`openDecisionTickets > 0` 报 `open_decision_tickets`，为 0 时不报；
 * - fog 未清空时不切换：`fog_present`；
 * - 未决交互与未完成 mutation 时不切换：`pending_interactions`、`unfinished_mutations`；
 * - 编译未通过时不切换：`compilation_not_accepted`；
 * - 计划未绑定当前地图（或计划已变化）时不切换：`plan_not_bound_to_current_map`；
 * - 缺少批准、或批准绑定的是另一版候选图时不切换：`authorization_missing`；
 * - 全部门禁事实满足时放行，多项同时不满足时一次报出全部 blockers；
 * - `handoffGateFacts` 的投影：全部开放票据、fog 章节、未决交互与未完成 intent 计数。
 *
 * 门禁判定本身是纯函数，因此这里同时覆盖「给定事实」与「从持久事实投影」两条路径。
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
  InteractionId,
  OperationId,
  PlanningCycleId,
  RuntimeIncarnationId,
} from '../../src/application/dto/identity.js';
import type { CoordinationWriter } from '../../src/application/ports/branch-coordination-store.js';
import {
  HANDOFF_BLOCKER_CODES,
  evaluateHandoffGate,
  handoffGateFacts,
  type HandoffGateFacts,
  type HandoffGateResult,
} from '../../src/application/planning/handoff-gate.js';
import { initializeCoordinationScope } from '../../src/application/planning/initialize-scope.js';
import { DEFAULT_EXECUTION_LIMITS } from '../../src/domain/planning/budget-policy.js';
import {
  MANIFEST_VERSION,
  WORKER_ROLES,
  type ExecutionAuthorizationRecord,
} from '../../src/domain/planning/execution-authorization.js';
import type { ExecutionGraph, GraphVersionRecord } from '../../src/domain/planning/execution-graph.js';
import type { DecisionTicket, RouteMapSnapshot } from '../../src/domain/planning/route-map.js';

const SCOPE = 'scope-1' as CoordinationScopeId;
const SESSION_A = 'session-a' as CoordinatorSessionId;
const INC_A = 'inc-a' as RuntimeIncarnationId;
const CYCLE = 'cycle-1' as PlanningCycleId;
const GRAPH_ID = 'graph-1' as GraphId;
const MAP_REVISION = 3;
const PLAN_REVISION = 2;

let directory = '';
let store: CoordinationStore;
let writerA: CoordinationWriter;
let now = 1_000;

const clock = (): number => now;

function emptyGraph(): ExecutionGraph {
  return {
    graphId: GRAPH_ID,
    generation: 1 as GraphGeneration,
    concurrencyLimit: 1,
    workPackages: [],
  };
}

/** 候选图记录：默认绑定当前地图与计划 revision，便于用 overrides 制造「未绑定」的偏差。 */
function candidateFor(
  version: number,
  overrides: { mapRevision?: number; planRevision?: number } = {},
): GraphVersionRecord {
  return {
    graphId: GRAPH_ID,
    generation: 1 as GraphGeneration,
    version: version as GraphVersion,
    recordKind: 'initial',
    parentVersion: null,
    patchId: null,
    mapRevision: overrides.mapRevision ?? MAP_REVISION,
    planRevision: overrides.planRevision ?? PLAN_REVISION,
    orcaRunId: 'run-1',
    graph: emptyGraph(),
    recordedAt: 1,
  };
}

/** 授权记录：manifest 的 `graph` 指向给定候选图，其余字段对本门禁只需结构合法。 */
function authorizationFor(candidate: GraphVersionRecord, authorizationVersion = 1): ExecutionAuthorizationRecord {
  return {
    coordinationScopeId: SCOPE,
    authorizationId: `authorization-${authorizationVersion}`,
    authorizationVersion,
    manifestVersion: MANIFEST_VERSION,
    fingerprint: `fingerprint-${authorizationVersion}`,
    manifest: {
      manifestVersion: MANIFEST_VERSION,
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

/** 默认全部门禁事实满足；用 overrides 只打破需要考察的那一条。 */
function factsFor(overrides: Partial<HandoffGateFacts> = {}): HandoffGateFacts {
  const candidate = overrides.candidate === undefined ? candidateFor(1) : overrides.candidate;
  const authorization =
    overrides.authorization === undefined
      ? candidate === null
        ? null
        : authorizationFor(candidate)
      : overrides.authorization;
  return {
    openDecisionTickets: overrides.openDecisionTickets ?? 0,
    fogPresent: overrides.fogPresent ?? false,
    unresolvedInteractions: overrides.unresolvedInteractions ?? 0,
    unresolvedMutations: overrides.unresolvedMutations ?? 0,
    currentMapRevision: overrides.currentMapRevision ?? MAP_REVISION,
    currentPlanRevision: overrides.currentPlanRevision ?? PLAN_REVISION,
    candidate,
    authorization,
  };
}

function blockerCodes(result: HandoffGateResult): readonly string[] {
  return result.kind === 'blocked' ? result.blockers.map((entry) => entry.code) : [];
}

function currentRevision(): number {
  const scope = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  if (scope.kind !== 'scope' || scope.scope === null) {
    throw new Error('Scope 不存在');
  }
  return scope.scope.revision;
}

function snapshotOf() {
  const snapshot = store.query({ kind: 'snapshot', coordinationScopeId: SCOPE });
  if (snapshot.kind !== 'snapshot') {
    throw new Error('无法读取 snapshot');
  }
  return snapshot.snapshot;
}

function openTicket(id: string): DecisionTicket {
  return {
    ticketRef: { kind: 'decision-ticket', id, version: 1 },
    state: 'open',
    blockedBy: [],
    assignee: null,
  };
}

function routeMapWithFog(fog: string): RouteMapSnapshot {
  return {
    routeMapRef: { kind: 'route-map', id: 'map-1', version: MAP_REVISION },
    planningCycleId: CYCLE,
    sections: {
      destination: '发布可用的协调闭环',
      resolved_decisions: '',
      open_decision_tickets: '',
      dependencies: '',
      fog,
      scope_boundaries: '',
    },
  };
}

/** 从真实 snapshot（无 claim、无交互、无未完成 intent）投影门禁事实。 */
function projection(
  input: { tickets?: readonly DecisionTicket[]; routeMap?: RouteMapSnapshot } = {},
): HandoffGateFacts {
  return handoffGateFacts({
    snapshot: snapshotOf(),
    tickets: input.tickets ?? [],
    routeMap: input.routeMap ?? routeMapWithFog(''),
    currentPlanRevision: PLAN_REVISION,
    candidate: candidateFor(1),
    authorization: null,
  });
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-handoff-gate-'));
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

test('存在开放票据时门禁阻塞，清空后不再报 open_decision_tickets', () => {
  const blocked = evaluateHandoffGate(factsFor({ openDecisionTickets: 1 }));
  expect(blocked.kind).toBe('blocked');
  expect(blockerCodes(blocked)).toContain('open_decision_tickets');

  const cleared = evaluateHandoffGate(factsFor({ openDecisionTickets: 0 }));
  expect(cleared.kind).toBe('allowed');
  expect(blockerCodes(cleared)).not.toContain('open_decision_tickets');
});

test('fog 未清空时门禁报 fog_present', () => {
  const blocked = evaluateHandoffGate(factsFor({ fogPresent: true }));
  expect(blocked.kind).toBe('blocked');
  expect(blockerCodes(blocked)).toEqual(['fog_present']);

  expect(evaluateHandoffGate(factsFor({ fogPresent: false })).kind).toBe('allowed');
});

test('未决交互与未完成 mutation 分别阻塞门禁', () => {
  const interactions = evaluateHandoffGate(factsFor({ unresolvedInteractions: 1 }));
  expect(blockerCodes(interactions)).toContain('pending_interactions');

  const mutations = evaluateHandoffGate(factsFor({ unresolvedMutations: 1 }));
  expect(blockerCodes(mutations)).toContain('unfinished_mutations');
});

test('编译未通过（没有候选图）时门禁报 compilation_not_accepted', () => {
  const result = evaluateHandoffGate(factsFor({ candidate: null, authorization: null }));
  expect(result.kind).toBe('blocked');
  expect(blockerCodes(result)).toContain('compilation_not_accepted');
});

test('候选图未绑定当前地图或计划 revision 时报 plan_not_bound_to_current_map', () => {
  const staleMap = evaluateHandoffGate(factsFor({ candidate: candidateFor(1, { mapRevision: MAP_REVISION + 1 }) }));
  expect(staleMap.kind).toBe('blocked');
  expect(blockerCodes(staleMap)).toContain('plan_not_bound_to_current_map');

  const stalePlan = evaluateHandoffGate(
    factsFor({ candidate: candidateFor(1, { planRevision: PLAN_REVISION + 1 }) }),
  );
  expect(blockerCodes(stalePlan)).toContain('plan_not_bound_to_current_map');
});

test('缺少批准、或批准绑定另一版候选图时门禁报 authorization_missing', () => {
  const missing = evaluateHandoffGate(factsFor({ authorization: null }));
  expect(missing.kind).toBe('blocked');
  expect(blockerCodes(missing)).toEqual(['authorization_missing']);

  const otherCandidate = authorizationFor(candidateFor(2));
  const mismatched = evaluateHandoffGate(factsFor({ authorization: otherCandidate }));
  expect(mismatched.kind).toBe('blocked');
  expect(blockerCodes(mismatched)).toContain('authorization_missing');

  const sameGraphWrongRun = authorizationFor(candidateFor(1));
  const wrongRun = evaluateHandoffGate(
    factsFor({
      authorization: {
        ...sameGraphWrongRun,
        manifest: { ...sameGraphWrongRun.manifest, orcaRunId: 'run-other' },
      },
    }),
  );
  expect(blockerCodes(wrongRun)).toContain('authorization_missing');
});

test('全部门禁事实满足时放行', () => {
  expect(evaluateHandoffGate(factsFor())).toEqual({ kind: 'allowed' });
});

test('多项同时不满足时一次报出全部 blockers', () => {
  const result = evaluateHandoffGate(
    factsFor({
      openDecisionTickets: 2,
      fogPresent: true,
      unresolvedInteractions: 1,
      unresolvedMutations: 1,
      candidate: null,
      authorization: null,
    }),
  );

  const codes = blockerCodes(result);
  expect([...codes].sort()).toEqual(
    [
      'authorization_missing',
      'compilation_not_accepted',
      'fog_present',
      'open_decision_tickets',
      'pending_interactions',
      'unfinished_mutations',
    ].sort(),
  );
  for (const code of codes) {
    expect(HANDOFF_BLOCKER_CODES as readonly string[]).toContain(code);
  }
});

test('handoffGateFacts 统计全部开放票据，认领不解除执行门禁', () => {
  const ticket = openTicket('ticket-1');
  const before = projection({ tickets: [ticket] });
  expect(before.openDecisionTickets).toBe(1);
  expect(before.fogPresent).toBe(false);
  expect(before.currentMapRevision).toBe(0);
  expect(before.unresolvedInteractions).toBe(0);
  expect(before.unresolvedMutations).toBe(0);
  expect(evaluateHandoffGate(before).kind).toBe('blocked');

  const claimed = store.transact({
    kind: 'record-ticket-claim',
    coordinationScopeId: SCOPE,
    expectedRevision: currentRevision(),
    writer: writerA,
    ticketRef: { kind: 'decision-ticket', id: 'ticket-1' },
  });
  expect(claimed.kind).toBe('committed');

  expect(projection({ tickets: [ticket] }).openDecisionTickets).toBe(1);
});

test('handoffGateFacts 只把非空白 fog 章节判为 fogPresent', () => {
  expect(projection({ routeMap: routeMapWithFog('') }).fogPresent).toBe(false);
  expect(projection({ routeMap: routeMapWithFog('   ') }).fogPresent).toBe(false);
  expect(projection({ routeMap: routeMapWithFog('尚未决定 worktree 的切分方式') }).fogPresent).toBe(true);
});

test('handoffGateFacts 只计入 open 交互，并把未完成 intent 计为 mutation', () => {
  const recorded = store.transact({
    kind: 'record-pending-interaction',
    coordinationScopeId: SCOPE,
    expectedRevision: currentRevision(),
    writer: writerA,
    interactionId: 'interaction-1' as InteractionId,
    ownerCoordinatorSessionId: SESSION_A,
    subjectRef: { kind: 'decision-ticket', id: 'ticket-1' },
  });
  expect(recorded.kind).toBe('committed');
  expect(projection().unresolvedInteractions).toBe(1);

  const answered = store.transact({
    kind: 'resolve-pending-interaction',
    coordinationScopeId: SCOPE,
    expectedRevision: currentRevision(),
    writer: writerA,
    interactionId: 'interaction-1' as InteractionId,
    state: 'answered',
    answerRef: { kind: 'decision-ticket', id: 'ticket-1' },
    answerText: '按 A 方案推进',
  });
  expect(answered.kind).toBe('committed');
  expect(projection().unresolvedInteractions).toBe(0);

  const intent = store.transact({
    kind: 'begin-intent',
    coordinationScopeId: SCOPE,
    expectedRevision: currentRevision(),
    writer: writerA,
    operationId: 'operation-1' as OperationId,
    target: { kind: 'worker-task', id: 'task-1' },
    operationCategory: 'task-create',
  });
  expect(intent.kind).toBe('committed');

  const withIntent = projection();
  expect(withIntent.unresolvedMutations).toBe(1);
  expect(blockerCodes(evaluateHandoffGate(withIntent))).toContain('unfinished_mutations');
});
