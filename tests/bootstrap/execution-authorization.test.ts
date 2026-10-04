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

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';
import { projectExecutionProfilesFixture, projectConnectionsFixture } from '../support/model-configurations.js';
import { openCoordinationStore, type CoordinationStore } from '../../src/adapters/storage/coordination-store.js';
import { openCheckpointStore } from '../../src/adapters/storage/checkpoint-store.js';
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
import { canonicalPath, coordinationDatabasePath } from '../../src/bootstrap/composition.js';
import { checkpointDatabasePath } from '../../src/bootstrap/coordinator-runtime.js';
import { COORDINATOR_SESSION_STATE_SCHEMA_VERSION } from '../../src/domain/coordinator/session-state.js';
import { createForegroundPlanningHost } from '../../src/bootstrap/foreground-planning-runtime.js';
import type { DoctorProbe } from '../../src/bootstrap/doctor.js';
import type { ExecutionQueryResult } from '../../src/application/dto/operation-outcome.js';
import type { ReadOnlyWorkerProbeResult } from '../../src/adapters/agents/codex-read-only-probe.js';
import { CapableChatModel } from '../support/fake-chat-model.js';
import {
  READ_ONLY_WORKER_AVAILABLE,
  READ_ONLY_WORKER_UNAVAILABLE,
} from '../support/read-only-worker-probe.js';

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
    ...projectExecutionProfilesFixture(),
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

test('模型重新授权追加唯一记录并保持运行图、政策和已消耗预算', async () => {
  await recordCandidate();
  const initial = reviewExecutionAuthorization(facts());
  if (initial.kind !== 'review') throw new Error('initial review unavailable');
  const approved = approveExecutionAuthorization({ ...facts(), writer,
    fingerprint: initial.review.fingerprint, expectedRevision: initial.review.scopeRevision });
  expect(approved.kind).toBe('approved');
  const before = scopeRecord();
  const nextPolicy = policy();
  const changedPolicy = { ...nextPolicy, workerProfiles: nextPolicy.workerProfiles.map((profile) => ({
    ...profile, profileRef: profile.profileRef + '-new',
    modelConfiguration: { ...profile.modelConfiguration, model: 'changed-model' },
  })), workerProfileRefs: Object.fromEntries(Object.entries(nextPolicy.workerProfileRefs)
    .map(([role, ref]) => [role, ref + '-new'])) };
  const review = reviewExecutionAuthorization({ ...facts(), policy: changedPolicy });
  if (review.kind !== 'review') throw new Error('model review unavailable');
  expect(review.review.manifest.graph).toEqual(initial.review.manifest.graph);
  expect(review.review.manifest.permissions).toEqual(initial.review.manifest.permissions);
  expect(review.review.manifest.limits).toEqual(initial.review.manifest.limits);
  expect(review.review.fingerprint).not.toBe(initial.review.fingerprint);
  expect(approveExecutionAuthorization({ ...facts(), policy: changedPolicy, writer,
    fingerprint: review.review.fingerprint, expectedRevision: review.review.scopeRevision }).kind).toBe('approved');
  const after = scopeRecord();
  expect(after.authorizationId).not.toBe(before.authorizationId);
  expect(after.graphId).toBe(before.graphId);
  expect(after.graphVersion).toBe(before.graphVersion);
  expect(authorizations()).toBe(2);
});

test('重复批准同一次审阅回读原记录：指针不移动、不追加授权、不派发', async () => {
  const { backend } = await recordCandidate();
  const reviewed = reviewExecutionAuthorization(facts());
  if (reviewed.kind !== 'review') throw new Error('审阅失败');
  const first = approveExecutionAuthorization({ ...facts(), writer,
    fingerprint: reviewed.review.fingerprint, expectedRevision: reviewed.review.scopeRevision });
  expect(first.kind).toBe('approved');
  const afterFirst = scopeRecord();
  expect(authorizations()).toBe(1);
  const mutationsAfterFirst = backend.mutations.length;

  // 用户在同一个界面上再次提交：审阅时的 revision 已经因这次批准前进，但这不是「计划变了」。
  const replay = approveExecutionAuthorization({ ...facts(), writer,
    fingerprint: reviewed.review.fingerprint, expectedRevision: reviewed.review.scopeRevision });
  expect(replay).toMatchObject({ kind: 'approved', authorizationId: afterFirst.authorizationId });

  const afterReplay = scopeRecord();
  expect(afterReplay.revision).toBe(afterFirst.revision);
  expect(afterReplay.authorizationId).toBe(afterFirst.authorizationId);
  expect(afterReplay.authorizationVersion).toBe(afterFirst.authorizationVersion);
  expect(authorizations()).toBe(1);
  expect(backend.mutations).toHaveLength(mutationsAfterFirst);

  // 配置与控制状态都变了之后，同一次审阅的重放仍然回读原记录：它不是一次新决定。
  const paused = store.transact({
    kind: 'record-control-state',
    coordinationScopeId: SCOPE,
    expectedRevision: scopeRecord().revision,
    writer,
    controlState: 'cancelling',
  });
  expect(paused.kind).toBe('committed');
  const afterControlChange = scopeRecord();
  const replayedAfterChange = approveExecutionAuthorization({ ...facts(), writer,
    fingerprint: reviewed.review.fingerprint, expectedRevision: reviewed.review.scopeRevision });
  expect(replayedAfterChange).toMatchObject({ kind: 'approved', authorizationId: afterFirst.authorizationId });
  expect(scopeRecord().revision).toBe(afterControlChange.revision);
  expect(authorizations()).toBe(1);
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

/* -------------------------------------------------------------------------- */
/* 授权审阅的只读 Worker 能力（change: `m2-repair-read-only-worker-sandbox`）      */
/* -------------------------------------------------------------------------- */

/**
 * 授权依赖 Capsule Utility Worker 与只读 Finalizer 两个角色，因此宿主必须在审阅与批准两处核验本机
 * 只读 Worker 能力。这里用真实前台宿主验证这条接线：审阅显示两个角色的只读配置与本次探针结论，能力
 * 不可用时批准被拒且零授权写入，环境恢复后同一 Scope 可以重新审阅并继续。
 */

/** 只读受限命令跑不起来的本机现状；探针结论由用例在两次审阅之间切换。 */
type Capability = { value: ReadOnlyWorkerProbeResult };

/** 宿主启动与对账会发起多种只读查询；空事实也要是**合法形状**，否则投影会把它们读成可读错误。 */
function permissiveHostBackend(): ExecutionBackend {
  return {
    query: (input: ExecutionQuery): Promise<ExecutionQueryResult> => {
      switch (input.operation) {
        case 'run-current':
          return Promise.resolve({ kind: 'accepted', value: { run: { runId: 'run-1', consumerGeneration: 1 } } });
        case 'worktree-list':
          return Promise.resolve({
            kind: 'accepted',
            value: { worktrees: [], totalCount: 0, truncated: false, hostScope: null },
          });
        case 'worker-list':
          return Promise.resolve({ kind: 'accepted', value: { workers: [] } });
        case 'terminal-list':
          return Promise.resolve({
            kind: 'accepted',
            value: { terminals: [], omittedHostIds: [], truncated: false },
          });
        case 'delivery-read':
          return Promise.resolve({
            kind: 'accepted',
            value: { delivery: null, messages: [], timedOut: false, cancelled: false },
          });
        case 'request-show':
          return Promise.resolve({ kind: 'accepted', value: { requestId: input.requestId, state: 'pending' } });
        default:
          return Promise.resolve({ kind: 'accepted', value: {} });
      }
    },
    mutate: (input: ExecutionMutation, scope) => {
      if (input.operation === 'run-create') {
        return Promise.resolve({
          kind: 'accepted',
          operation: { operationId: scope.operationId, target: scope.target },
          value: { run: { runId: 'run-1' } },
        });
      }
      return Promise.resolve({ kind: 'rejected', code: 'unregistered_fake_mutation', message: input.operation });
    },
  };
}

function hostProbe(): DoctorProbe {
  return {
    readOrcaVersion: () => Promise.resolve({ ok: true, value: '1.4.198' }),
    readRuntime: () => Promise.resolve({ ok: true, value: { state: 'running', reachable: true, capabilities: [] } }),
    readHosts: () => Promise.resolve({ ok: true, value: [] }),
    readCoordinatorIdentity: () => Promise.resolve({ ok: true, value: 'coordinator@test' }),
    readPublicCommands: () => Promise.resolve({ ok: true, value: [] }),
  };
}

function hostTracker(): IssueTrackerGateway {
  return {
    readIssue: () =>
      Promise.resolve({
        kind: 'read',
        issue: {
          ref: { kind: 'route-map', id: '7' },
          title: 'Route Map',
          // Destination 与「无开放票据、无 fog」是门禁通过的地图事实。
          body: '## Destination\n目的地\n## Open Decision Tickets\n## Fog\n',
          state: 'open',
          assignees: [],
        },
      }),
    updateIssueBody: () => Promise.resolve({ kind: 'accepted' }),
    assignIssue: () => Promise.resolve({ kind: 'accepted' }),
  };
}

type AuthorizationHostHarness = {
  readonly host: Awaited<ReturnType<typeof createForegroundPlanningHost>>;
  readonly repository: string;
  readonly capability: Capability;
  readonly probeCalls: { value: number };
  readonly dispose: () => void;
};

/** 一次性仓库 + 未授权的 route_planning Scope（候选图与 Run 已绑定）。 */
async function openAuthorizationHost(directory: string): Promise<AuthorizationHostHarness> {
  const repository = join(directory, 'repo');
  mkdirSync(repository);
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Verification');
  git('config', 'user.email', 'verification@example.invalid');
  writeFileSync(join(repository, 'README.md'), '# repo\n', 'utf8');
  writeFileSync(
    join(repository, 'orca-companion.json'),
    JSON.stringify({
      schemaVersion: 2,
      revision: 0,
      ...projectConnectionsFixture(),
      coordinatorModels: [
        {
          configurationRef: 'planning-default',
          providerIntegration: '@fake/provider#CapableChatModel',
          model: 'fake-coordinator',
          modelOptions: {},
          credentialRefs: [],
          nativeWindowOwnerRef: null,
        },
      ],
      defaultCoordinatorModelRef: 'planning-default',
      tracker: { kind: 'github', routeMapIssueNumber: 7 },
      planning: { maxMutations: 2 },
      context: { maxInputTokens: 20_000 },
      execution: {
        harness: 'codex',
        ...projectExecutionProfilesFixture(),
        permissions: {
          planner: true,
          implementation: true,
          validator: true,
          finalizer: true,
          gitIntegration: true,
          dependencyChanges: false,
        },
        git: { remotes: ['origin'], refs: ['refs/heads/main'] },
      },
    }),
    'utf8',
  );
  git('add', '.');
  git('commit', '-qm', 'fixture');
  const head = git('rev-parse', 'HEAD');

  const opened = openCoordinationStore({ databasePath: coordinationDatabasePath(join(repository, '.git')), clock });
  if (opened.kind !== 'opened') {
    throw new Error(opened.message);
  }
  const seedStore: CoordinationStore = opened.store;
  try {
    const initialized = initializeCoordinationScope({
      store: seedStore,
      coordinationScopeId: SCOPE,
      coordinatorSessionId: SESSION,
      coordinatorModelConfigurationRef: 'planning-default',
      planningCycleId: CYCLE,
      fullBranchRef: 'refs/heads/main',
      canonicalWorktreePath: canonicalPath(repository),
    });
    if (initialized.kind !== 'initialized') {
      throw new Error(`无法初始化 Scope：${initialized.message}`);
    }
    const acquired = acquireRuntimeLease(seedStore, {
      coordinationScopeId: SCOPE,
      coordinatorSessionId: SESSION,
      runtimeIncarnationId: INCARNATION,
      fencingGeneration: 0,
    });
    if (acquired.kind !== 'acquired') {
      throw new Error('无法取得 Runtime Lease');
    }
    const seedWriter: CoordinationWriter = {
      coordinatorSessionId: SESSION,
      runtimeIncarnationId: INCARNATION,
      fencingGeneration: acquired.lease.fencingGeneration,
    };
    const recorded = await proposeExecutionGraph({
      store: seedStore,
      backend: permissiveHostBackend(),
      coordinationScopeId: SCOPE,
      writer: seedWriter,
      backendIdentityRef: 'identity-ref',
      timeoutMs: 1_000,
      authority: { kind: 'route_planning' },
      plan: plan(),
      limits: DEFAULT_EXECUTION_LIMITS,
      baselineHead: head,
      objective: 'compile candidate',
    });
    if (recorded.kind !== 'recorded') {
      throw new Error(`无法记录候选图：${JSON.stringify(recorded)}`);
    }
    const revision = (): number => {
      const read = seedStore.query({ kind: 'scope', coordinationScopeId: SCOPE });
      if (read.kind !== 'scope' || read.scope === null) {
        throw new Error('Scope 不存在');
      }
      return read.scope.revision;
    };
    // 上一个 Incarnation 结束：宿主会取得自己的 Runtime Lease；Session 可恢复需要一份 checkpoint。
    const checkpoints = openCheckpointStore({
      databasePath: checkpointDatabasePath(join(repository, '.git')),
      clock,
    });
    if (checkpoints.kind !== 'opened') {
      throw new Error(checkpoints.message);
    }
    const saved = checkpoints.store.saveCheckpoint({
      schemaVersion: COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
      coordinatorSessionId: SESSION,
      committedMessages: [],
      graphPosition: 'suspend',
      committedModelSteps: [],
      wakeBatches: [],
      lastCompactionOutcome: null,
    });
    checkpoints.store.close();
    if (saved.kind !== 'saved') {
      throw new Error('无法写入 Session checkpoint');
    }
    const released = seedStore.transact({
      kind: 'release-runtime-lease',
      coordinationScopeId: SCOPE,
      expectedRevision: revision(),
      writer: seedWriter,
    });
    if (released.kind === 'rejected') {
      throw new Error(`无法释放 Runtime Lease：${released.message}`);
    }
  } finally {
    seedStore.close();
  }

  const capability: Capability = { value: READ_ONLY_WORKER_AVAILABLE };
  const probeCalls = { value: 0 };
  const host = await createForegroundPlanningHost({
    repositoryPath: repository,
    env: process.env as Record<string, string>,
    clock,
    newId: (() => {
      let counter = 0;
      return () => `id-${String((counter += 1))}`;
    })(),
    heartbeatIntervalMs: 1_000,
    leaseTtlMs: 60_000,
    orcaProbe: hostProbe(),
    trackerFactory: hostTracker,
    loadIntegration: () => Promise.resolve({ CapableChatModel }),
    executionBackend: permissiveHostBackend(),
    readOnlyWorkerProbe: () => {
      probeCalls.value += 1;
      return Promise.resolve(capability.value);
    },
  });
  let disposed = false;
  return {
    host,
    repository,
    capability,
    probeCalls,
    dispose: () => {
      if (!disposed) {
        disposed = true;
        host.close();
      }
    },
  };
}

/** 读回真实持久化事实：授权条数与 Scope 模式都只从存储读取。 */
function persistedFacts(repository: string): { readonly authorizations: number; readonly mode: string } {
  const read = openCoordinationStore({
    databasePath: coordinationDatabasePath(join(repository, '.git')),
    clock,
    readOnly: true,
  });
  if (read.kind !== 'opened') {
    throw new Error(read.message);
  }
  try {
    const authorizations = read.store.query({ kind: 'authorizations', coordinationScopeId: SCOPE });
    const scope = read.store.query({ kind: 'scope', coordinationScopeId: SCOPE });
    return {
      authorizations: authorizations.kind === 'authorizations' ? authorizations.authorizations.length : 0,
      mode: scope.kind === 'scope' && scope.scope !== null ? scope.scope.mode : 'unreadable',
    };
  } finally {
    read.store.close();
  }
}

function manifestRow(
  load: Awaited<ReturnType<AuthorizationHostHarness['host']['ports']['executionAuthorization']['review']>>,
  label: string,
): string {
  if (load.kind !== 'review') {
    return '';
  }
  return load.review.manifestRows.find((row) => row.label === label)?.value ?? '';
}

test('审阅与批准各自核验只读 Worker 能力：不可用不写授权，环境恢复后可重审', { timeout: 60_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-authorization-host-'));
  const harness = await openAuthorizationHost(directory);
  try {
    expect(await harness.host.ports.scopeSetup.resolveHome()).toEqual({ kind: 'restore', coordinationScopeId: SCOPE });

    // 1. 本机只读受限命令跑不起来：审阅仍可读（Route Planning 不受影响），门禁不允许批准。
    harness.capability.value = READ_ONLY_WORKER_UNAVAILABLE;
    const blocked = await harness.host.ports.executionAuthorization.review();
    expect(blocked.kind).toBe('review');
    if (blocked.kind !== 'review') {
      return;
    }
    expect(blocked.review.gate.ready).toBe(false);
    expect(blocked.review.gate.blockers.join(' ')).toContain('read_only_worker_unavailable');
    // Capsule 与 Finalizer 的实际只读配置与本次结论都在审阅里可见。
    expect(manifestRow(blocked, 'Worker Sandbox')).toContain('capsule=utility-readonly-local-control');
    expect(manifestRow(blocked, 'Worker Sandbox')).toContain('finalizer=utility-readonly-local-control');
    expect(manifestRow(blocked, 'Read-only Workers')).toContain('sandbox-read');

    const refused = await harness.host.ports.executionAuthorization.approve({
      fingerprint: blocked.review.fingerprint,
      expectedRevision: blocked.review.scopeRevision,
    });
    expect(refused).toMatchObject({ kind: 'rejected', code: 'read_only_worker_unavailable' });
    expect(persistedFacts(harness.repository)).toEqual({ authorizations: 0, mode: 'route_planning' });

    // 2. 环境恢复后同一 Scope 重新审阅：之前的失败结论不锁死它，批准此时才落盘。
    harness.capability.value = READ_ONLY_WORKER_AVAILABLE;
    const ready = await harness.host.ports.executionAuthorization.review();
    expect(ready.kind).toBe('review');
    if (ready.kind !== 'review') {
      return;
    }
    expect(ready.review.gate.ready).toBe(true);
    expect(manifestRow(ready, 'Read-only Workers')).toContain('可用');
    const approved = await harness.host.ports.executionAuthorization.approve({
      fingerprint: ready.review.fingerprint,
      expectedRevision: ready.review.scopeRevision,
    });
    expect(approved.kind).toBe('accepted');
    expect(persistedFacts(harness.repository)).toEqual({ authorizations: 1, mode: 'execution_coordination' });
    // 审阅与批准各自探测：结论不缓存，旧成功不会替代本次检查。
    expect(harness.probeCalls.value).toBeGreaterThanOrEqual(3);
  } finally {
    harness.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
