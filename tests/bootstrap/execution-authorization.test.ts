/**
 * IP-01：规划 → 执行的授权切换（Requirement「授权切换由当前规划事实驱动」）。
 *
 * 覆盖 Scenario：
 * - 批准后进入执行：候选图由正式 Implementation Plan 编译并绑定空 Run，完整 Manifest 通过用户批准
 *   后，Scope 原子进入 `execution_coordination` 并取得唯一的 Execution Coordination Lease；
 * - 规划引用过期：审阅之后规划事实变化、或批准用户看到的是另一份内容时，批准被拒绝且零写入；
 * - 未批准不执行：只有审阅、没有批准时 Mode 不变、没有执行租约，整个过程中唯一的 Orca mutation 是
 *   建立空 Run。
 *
 * 事实层全部走真实路径（`startGraphGeneration` → `compileExecutionGraph` → `recordInitialGraph` →
 * `proposeManifest` → `recordApproval` → `transitionToExecution`），只有 Orca 后端与 tracker 是 fake。
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
  EntityRef,
  OperationId,
  PlanningCycleId,
  RuntimeIncarnationId,
} from '../../src/application/dto/identity.js';
import type {
  CoordinationWriter,
  ScopeRecord,
} from '../../src/application/ports/branch-coordination-store.js';
import type {
  ExecutionBackend,
  ExecutionMutation,
  ExecutionQuery,
} from '../../src/application/ports/execution-backend.js';
import { initializeCoordinationScope } from '../../src/application/planning/initialize-scope.js';
import {
  updateRouteMapSection,
  type IssueTrackerGateway,
  type TrackerReadOutcome,
  type TrackerWriteOutcome,
} from '../../src/application/planning/route-map-service.js';
import { routeMapSnapshot } from '../../src/domain/planning/route-map.js';
import { DEFAULT_EXECUTION_LIMITS } from '../../src/domain/planning/budget-policy.js';
import {
  CODEX_FULL_ACCESS_RISK,
  type ProjectExecutionConfiguration,
} from '../../src/bootstrap/project-config.js';
import {
  approveExecutionAuthorization,
  proposeExecutionGraph,
  reviewExecutionAuthorization,
  type ExecutionAuthorizationFacts,
} from '../../src/bootstrap/execution-runtime.js';

const SCOPE = 'scope-authorization' as CoordinationScopeId;
const SESSION = 'session-authorization' as CoordinatorSessionId;
const INCARNATION = 'incarnation-authorization' as RuntimeIncarnationId;
const CYCLE = 'cycle-authorization' as PlanningCycleId;
const MAP_VERSION = 0;

let directory = '';
let store: CoordinationStore;
let writer: CoordinationWriter;

const clock = (): number => 1_000;

/** 一份结构合法的 Implementation Plan：两个 Work Package，后者依赖前者。 */
function plan(): unknown {
  return {
    planRevision: 1,
    destinationRef: { kind: 'destination', id: 'destination-1', version: 1 },
    workPackages: [
      {
        key: 'wp-a',
        title: '第一个工作包',
        dependsOn: [],
        scopeEnvelope: { include: ['src/a.ts'], exclude: [] },
      },
      {
        key: 'wp-b',
        title: '第二个工作包',
        dependsOn: ['wp-a'],
        scopeEnvelope: { include: ['src/b.ts'], exclude: [] },
      },
    ],
  };
}

function policy(overrides: Partial<ProjectExecutionConfiguration> = {}): ProjectExecutionConfiguration {
  return {
    harness: 'codex',
    workerModel: 'minimax-cn/MiniMax-M3',
    codexSandbox: 'workspace-write',
    permissions: {
      planner: true,
      implementation: true,
      validator: true,
      finalizer: true,
      gitIntegration: true,
      dependencyChanges: false,
    },
    limits: DEFAULT_EXECUTION_LIMITS,
    git: { remotes: ['origin'], refs: ['refs/heads/main'] },
    dependency: { allowDependencyChanges: false, registry: null },
    acceptedRisks: [],
    ...overrides,
  };
}

/** 只登记 Run 相关的两个操作；其它调用一律视为未登记，避免测试替真实路径兜底。 */
function fakeBackend(): {
  readonly backend: ExecutionBackend;
  readonly mutations: readonly ExecutionMutation[];
  readonly scopeAuthorities: readonly string[];
} {
  const mutations: ExecutionMutation[] = [];
  const scopeAuthorities: string[] = [];
  const backend: ExecutionBackend = {
    query: (input: ExecutionQuery) => {
      if (input.operation === 'run-current') {
        return Promise.resolve({ kind: 'accepted', value: { run: { runId: 'run-1' } } });
      }
      return Promise.resolve({ kind: 'rejected', code: 'unregistered_fake_query', message: input.operation });
    },
    mutate: (input: ExecutionMutation, scope) => {
      mutations.push(input);
      scopeAuthorities.push(scope.authority.kind);
      if (input.operation === 'run-create') {
        return Promise.resolve({
          kind: 'accepted',
          operation: { operationId: scope.operationId, target: scope.target },
          value: { run: { runId: 'run-1' } },
        });
      }
      return Promise.resolve({
        kind: 'rejected',
        code: 'unregistered_fake_mutation',
        message: input.operation,
      });
    },
  };
  return { backend, mutations, scopeAuthorities };
}

function scopeRecord(): ScopeRecord {
  const read = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  if (read.kind !== 'scope' || read.scope === null) {
    throw new Error('Scope 不存在');
  }
  return read.scope;
}

function unreleasedExecutionLeases(): number {
  const leases = store.query({ kind: 'leases', coordinationScopeId: SCOPE });
  return leases.kind !== 'leases'
    ? 0
    : leases.leases.filter((lease) => lease.kind === 'execution_coordination' && lease.releasedAt === null).length;
}

function authorizations(): number {
  const read = store.query({ kind: 'authorizations', coordinationScopeId: SCOPE });
  return read.kind === 'authorizations' ? read.authorizations.length : 0;
}

function facts(input?: {
  readonly mapBody?: string;
  readonly policy?: ProjectExecutionConfiguration;
}): ExecutionAuthorizationFacts {
  return {
    store,
    coordinationScopeId: SCOPE,
    policy: input?.policy ?? policy(),
    workspace: { canonicalWorktreePath: '/tmp/canonical', canonicalBranch: 'main' },
    routeMapRef: { kind: 'route-map', id: '42', version: MAP_VERSION },
    routeMap: routeMapSnapshot(
      { kind: 'route-map', id: '42', version: MAP_VERSION },
      CYCLE,
      input?.mapBody ?? ['## Destination', '', '交付一条闭环', '', '## Fog', '', ''].join('\n'),
    ),
  };
}

/** 只承载地图正文的 tracker fake：写入路径与读回核验都走真实用例。 */
class FakeMapTracker implements IssueTrackerGateway {
  private body: string;

  constructor(body: string) {
    this.body = body;
  }

  readIssue(ref: EntityRef<string>): Promise<TrackerReadOutcome> {
    return Promise.resolve({
      kind: 'read',
      issue: { ref, title: 'Route Map', body: this.body, state: 'open', assignees: [] },
    });
  }

  updateIssueBody(input: { readonly ref: EntityRef<string>; readonly body: string }): Promise<TrackerWriteOutcome> {
    void input.ref;
    this.body = input.body;
    return Promise.resolve({ kind: 'accepted' });
  }

  assignIssue(): Promise<TrackerWriteOutcome> {
    return Promise.resolve({ kind: 'accepted' });
  }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-authorization-'));
  const opened = openCoordinationStore({ databasePath: join(directory, 'coordination.sqlite'), clock });
  if (opened.kind !== 'opened') {
    throw new Error(`无法打开 coordination store：${opened.message}`);
  }
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
  if (acquired.kind !== 'acquired') {
    throw new Error('无法取得 Runtime Lease');
  }
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

/** 走真实编译路径记录候选图，返回 backend 记录以便断言副作用集合。 */
async function recordCandidate() {
  const backend = fakeBackend();
  const recorded = await proposeExecutionGraph({
    store,
    backend: backend.backend,
    coordinationScopeId: SCOPE,
    writer,
    backendIdentityRef: 'identity-ref',
    timeoutMs: 1_000,
    authority: { kind: 'route_planning' },
    plan: plan(),
    limits: DEFAULT_EXECUTION_LIMITS,
    baselineHead: 'head-1',
    objective: 'compile candidate',
  });
  if (recorded.kind !== 'recorded') {
    throw new Error(`无法记录候选图：${JSON.stringify(recorded)}`);
  }
  return { recorded, backend };
}

test('批准后进入执行：候选图绑定空 Run，批准后 Scope 原子切换并取得唯一执行租约', async () => {
  const { recorded, backend } = await recordCandidate();
  expect(recorded.candidate).toMatchObject({
    graphId: `${SCOPE}#g1`,
    generation: 1,
    version: 1,
    planRevision: 1,
    orcaRunId: 'run-1',
    baselineHead: 'head-1',
    workPackageCount: 2,
  });
  // 空 Run 是这次编译唯一的 Orca 副作用，且在规划模式下签发。
  expect(backend.mutations).toEqual([{ operation: 'run-create', objective: 'compile candidate' }]);
  expect(backend.scopeAuthorities).toEqual(['route_planning']);

  const reviewed = reviewExecutionAuthorization(facts());
  if (reviewed.kind !== 'review') {
    throw new Error(`审阅失败：${JSON.stringify(reviewed)}`);
  }
  // 完整 Manifest：Worker Profile 覆盖四个角色，上限与策略逐项来自项目配置。
  expect(reviewed.review.manifest.workerProfiles.map((profile) => profile.role)).toEqual([
    'planner',
    'implementation',
    'validator',
    'finalizer',
  ]);
  expect(reviewed.review.manifest.limits).toEqual(DEFAULT_EXECUTION_LIMITS);
  expect(reviewed.review.manifest.gitPolicy).toMatchObject({
    canonicalBranch: 'main',
    remotes: ['origin'],
    refs: ['refs/heads/main'],
    allowForcePush: false,
  });
  expect(reviewed.review.manifest.baselineHead).toBe('head-1');
  expect(reviewed.review.manifest.orcaRunId).toBe('run-1');
  // 批准要消除的正是「尚无授权」这一项，因此审阅里的门禁在这条记录等价成立时通过。
  expect(reviewed.review.gate).toEqual({ kind: 'allowed' });

  // 未批准前：Mode 不变、没有执行租约、没有授权记录。
  expect(scopeRecord().mode).toBe('route_planning');
  expect(unreleasedExecutionLeases()).toBe(0);

  const approved = approveExecutionAuthorization({
    ...facts(),
    writer,
    fingerprint: reviewed.review.fingerprint,
    expectedRevision: reviewed.review.scopeRevision,
  });
  expect(approved.kind).toBe('approved');
  const scope = scopeRecord();
  expect(scope.mode).toBe('execution_coordination');
  expect(scope.graphId).toBe(recorded.candidate.graphId);
  expect(scope.graphVersion).toBe(1);
  expect(scope.planningCycleId).toBe(CYCLE);
  expect(unreleasedExecutionLeases()).toBe(1);
  expect(authorizations()).toBe(1);
  // 批准与切换都不产生新的 Orca 副作用。
  expect(backend.mutations).toHaveLength(1);
});

test('规划引用过期：指纹不符或 expected revision 过期时零写入，旧批准不触发派发', async () => {
  const { recorded, backend } = await recordCandidate();
  const reviewed = reviewExecutionAuthorization(facts());
  if (reviewed.kind !== 'review') {
    throw new Error('审阅失败');
  }

  // 1. 指纹不符：用户在审阅之后规划引用已经变化。
  const staleFingerprint = approveExecutionAuthorization({
    ...facts(),
    writer,
    fingerprint: 'fingerprint-of-another-manifest',
    expectedRevision: reviewed.review.scopeRevision,
  });
  expect(staleFingerprint).toMatchObject({ kind: 'rejected', code: 'manifest_changed' });
  expect(authorizations()).toBe(0);
  expect(scopeRecord().mode).toBe('route_planning');

  // 2. expected revision 过期：另一次写入之后，用户基于旧 revision 的批准不再成立。
  const bumped = store.transact({
    kind: 'update-session-model-configuration',
    coordinationScopeId: SCOPE,
    expectedRevision: scopeRecord().revision,
    writer,
    coordinatorSessionId: SESSION,
    coordinatorModelConfigurationRef: 'config-2',
  });
  expect(bumped.kind).toBe('committed');
  const staleRevision = approveExecutionAuthorization({
    ...facts(),
    writer,
    fingerprint: reviewed.review.fingerprint,
    expectedRevision: reviewed.review.scopeRevision,
  });
  expect(staleRevision).toMatchObject({ kind: 'rejected', code: 'stale_revision' });
  expect(authorizations()).toBe(0);
  expect(unreleasedExecutionLeases()).toBe(0);

  // 3. 规划引用确实前进：走真实的 Route Map 写入路径推进地图 revision，旧指纹因此再也无法复现。
  const tracker = new FakeMapTracker(['## Destination', '', '交付一条闭环'].join('\n'));
  const written = await updateRouteMapSection({
    store,
    coordinationScopeId: SCOPE,
    writer,
    operationId: 'op-map-section' as OperationId,
    expectedRevision: scopeRecord().revision,
    routeMapRef: { kind: 'route-map', id: '42', version: scopeRecord().mapRevision },
    planningCycleId: CYCLE,
    tracker,
    section: 'destination',
    content: '交付一条更窄的闭环',
  });
  expect(written.kind).toBe('accepted');
  expect(scopeRecord().mapRevision).toBe(MAP_VERSION + 1);

  const afterMapChange = reviewExecutionAuthorization({
    ...facts(),
    routeMapRef: { kind: 'route-map', id: '42', version: scopeRecord().mapRevision },
  });
  expect(afterMapChange.kind === 'review' && afterMapChange.review.fingerprint).not.toBe(
    reviewed.review.fingerprint,
  );
  // 旧指纹的批准在规划引用前进后必然被拒绝，且不写任何授权记录：候选图绑定的地图 revision 已经不是
  // 当前地图，批准连组装都不会成功。
  const afterDrift = approveExecutionAuthorization({
    ...facts(),
    routeMapRef: { kind: 'route-map', id: '42', version: scopeRecord().mapRevision },
    writer,
    fingerprint: reviewed.review.fingerprint,
    expectedRevision: scopeRecord().revision,
  });
  expect(afterDrift).toMatchObject({ kind: 'rejected', code: 'candidate_mismatch' });
  expect(authorizations()).toBe(0);
  expect(recorded.candidate.version).toBe(1);
  expect(backend.mutations).toHaveLength(1);
});

test('放宽 Worker 沙箱必须显式接受风险：未接受时不产生可批准的 Manifest', async () => {
  await recordCandidate();
  const relaxed = policy({ codexSandbox: 'danger-full-access' });
  const reviewed = reviewExecutionAuthorization(facts({ policy: relaxed }));
  expect(reviewed).toMatchObject({ kind: 'blocked' });
  if (reviewed.kind === 'blocked') {
    expect(reviewed.blockers.map((blocker) => blocker.code)).toContain('codex_sandbox_risk_not_accepted');
  }
  // 未接受的放宽不产生任何授权记录，也不做任何外部 mutation。
  expect(authorizations()).toBe(0);
  expect(fakeBackend().mutations).toHaveLength(0);

  // 显式接受该风险后才是可批准的完整 Manifest，且风险条目逐字出现在 Manifest 里。
  const accepted = reviewExecutionAuthorization(
    facts({ policy: policy({ codexSandbox: 'danger-full-access', acceptedRisks: [CODEX_FULL_ACCESS_RISK] }) }),
  );
  expect(accepted.kind).toBe('review');
  if (accepted.kind === 'review') {
    expect(accepted.review.manifest.acceptedRisks).toEqual([CODEX_FULL_ACCESS_RISK]);
  }
});

test('门禁未通过时批准被拒绝：开放票据与 fog 会同时出现在审阅里', async () => {
  await recordCandidate();
  const blockedFacts = facts({
    mapBody: [
      '## Destination',
      '',
      '交付一条闭环',
      '',
      '## Open Decision Tickets',
      '',
      '- #7 决定集成策略',
      '',
      '## Fog',
      '',
      '还不清楚备份策略',
    ].join('\n'),
  });
  const reviewed = reviewExecutionAuthorization(blockedFacts);
  if (reviewed.kind !== 'review') {
    throw new Error(`审阅失败：${JSON.stringify(reviewed)}`);
  }
  expect(reviewed.review.gate.kind).toBe('blocked');
  const codes = reviewed.review.gate.kind === 'blocked' ? reviewed.review.gate.blockers.map((b) => b.code) : [];
  expect(codes).toContain('open_decision_tickets');
  expect(codes).toContain('fog_present');

  const approved = approveExecutionAuthorization({
    ...blockedFacts,
    writer,
    fingerprint: reviewed.review.fingerprint,
    expectedRevision: reviewed.review.scopeRevision,
  });
  // 授权记录可以落盘（用户对完整 Manifest 的决定成立），但 Mode 不变，因此旧批准不触发派发。
  expect(approved).toMatchObject({ kind: 'blocked' });
  expect(authorizations()).toBe(1);
  expect(scopeRecord().mode).toBe('route_planning');
  expect(unreleasedExecutionLeases()).toBe(0);
});
