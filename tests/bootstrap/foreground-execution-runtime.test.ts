/**
 * IP-02 的行为测试（change: `m2-wire-execution-runtime`）。
 *
 * 前台宿主在**同一个** Runtime Incarnation 上执行一次启动对账序列，并且只在这之后才恢复模型与派发。
 * 这里用临时 Git 仓库 + 真实两个 SQLite store + 注入的 fake Orca 后端，固定四类可观察事实：
 *
 * - 「重启前有活跃 Worker」时，首次新派发之前对账状态已经可见；同一个 Task/Dispatch/Attempt 不被重复
 *   创建（零 `worker-start`）；
 * - Resume 先对账再恢复调度；对账仍不确定的那条 lane 依然被拦住、原因可见，未知**不**被报成已退出
 *   （intent 不落任何终态）；
 * - 整个启动与 Resume 过程只出现一条未释放的 Runtime Lease（store 事实）；
 * - Scope 控制走真实路径（Orca `worker-list` 与 `reconcileOperations`），不再有占位实现。
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import type { IssueTrackerGateway, TrackerIssue, TrackerReadOutcome, TrackerWriteOutcome } from '../../src/application/planning/route-map-service.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  OperationId,
  PlanningCycleId,
  RuntimeIncarnationId,
  WorkerTaskId,
  WorkPackageId,
} from '../../src/application/dto/identity.js';
import type { CoordinationWriter, MaterializationBindingRecord } from '../../src/application/ports/branch-coordination-store.js';
import type {
  CoordinationSnapshot,
  DeliverySettlementRecord,
  RecoveryRecord,
  SessionSegmentRecord,
  WakeAdmissionRecord,
} from '../../src/application/ports/branch-coordination-store.js';
import type { LeaseRecord } from '../../src/application/ports/branch-coordination-store.js';
import type { ExecutionObservationFacts } from '../../src/application/execution/execution-view.js';
import type {
  ExecutionBackend,
  ExecutionMutation,
  ExecutionQuery,
  WorktreeSummary,
} from '../../src/application/ports/execution-backend.js';
import type { DoctorProbe } from '../../src/bootstrap/doctor.js';
import type {
  GraphGeneration,
  GraphVersion,
} from '../../src/application/dto/identity.js';
import { graphIdFor } from '../../src/application/planning/graph-generation.js';
import { recordInitialGraph } from '../../src/application/planning/graph-history.js';
import { ensureGraphGenerationRecord } from '../../src/application/execution/replanning-service.js';
import { workPackageComment } from '../../src/application/materialize-work-package.js';
import { DEFAULT_EXECUTION_LIMITS } from '../../src/domain/planning/budget-policy.js';
import { MANIFEST_VERSION } from '../../src/domain/planning/execution-authorization.js';
import type { ExecutionAuthorizationManifest } from '../../src/domain/planning/execution-authorization.js';
import { EXECUTION_AUTHORIZATION_ID, executionWorkerProfiles } from '../support/execution-harness.js';
import { implementationPlanFor } from '../support/graph-plan-fixture.js';
import { projectConnectionsFixture, projectExecutionProfilesFixture } from '../support/model-configurations.js';
import { recoveryUtilityProfileFixture } from '../support/model-configurations.js';
import type { ExecutionGraph } from '../../src/domain/planning/execution-graph.js';
import type { SnapshotLoad } from '../../src/interfaces/tui/ports.js';
import { beginIntent, settleIntent } from '../../src/application/coordination/intent-service.js';
import { acquireRuntimeLease } from '../../src/application/coordination/lease-service.js';
import { initializeCoordinationScope } from '../../src/application/planning/initialize-scope.js';
import { openCoordinationStore, type CoordinationStore } from '../../src/adapters/storage/coordination-store.js';
import { openCheckpointStore } from '../../src/adapters/storage/checkpoint-store.js';
import { checkpointDatabasePath } from '../../src/bootstrap/coordinator-runtime.js';
import { COORDINATOR_SESSION_STATE_SCHEMA_VERSION } from '../../src/domain/coordinator/session-state.js';
import { canonicalPath, coordinationDatabasePath } from '../../src/bootstrap/composition.js';
import {
  createForegroundPlanningHost,
  integrationSourceBranchOf,
  interruptedSegmentOf,
  sessionBindingFromStartReport,
  unboundRoleDispatches,
} from '../../src/bootstrap/foreground-planning-runtime.js';
import { CapableChatModel } from '../support/fake-chat-model.js';

const ROUTE_MAP_BODY = [
  '## Destination',
  '把项目推进到目的地 A。',
  '## Resolved Decisions',
  '',
  '## Open Decision Tickets',
  '- ticket-1：先决定地图结构',
  '## Dependencies',
  '',
  '## Fog',
  '尚未厘清的部分。',
  '## Scope Boundaries',
  '',
].join('\n');

const SCOPE = 'scope-foreground-exec' as CoordinationScopeId;
const SESSION = 'session-foreground-exec' as CoordinatorSessionId;
const CYCLE = 'cycle-foreground-exec' as PlanningCycleId;
const WORKER_TASK = 'task-before-restart' as WorkerTaskId;
const DISPATCH_OPERATION = 'op-worker-dispatch-before-restart' as OperationId;
const BACKEND_REQUEST = 'request-before-restart';
const PREVIOUS_INCARNATION = 'inc-before-restart' as RuntimeIncarnationId;

let clockMs = 1_000;
const clock = (): number => clockMs;

/* -------------------------------------------------------------------------- */
/* fake Orca：只读查询 + 记录型 mutation                                        */
/* -------------------------------------------------------------------------- */

type FakeHostBackend = {
  readonly backend: ExecutionBackend;
  readonly mutations: readonly ExecutionMutation[];
  readonly queries: readonly ExecutionQuery[];
  /** `request-show` 的结论：默认 `pending`（副作用是否发生无法证明）。 */
  readonly requestState: { value: string };
};

function fakeHostBackend(): FakeHostBackend {
  const mutations: ExecutionMutation[] = [];
  const queries: ExecutionQuery[] = [];
  const requestState = { value: 'pending' };
  return {
    mutations,
    queries,
    requestState,
    backend: {
      query: (input: ExecutionQuery) => {
        queries.push(input);
        switch (input.operation) {
          case 'request-show':
            return Promise.resolve({
              kind: 'accepted' as const,
              value: { requestId: input.requestId, state: requestState.value },
            });
          case 'run-current':
            return Promise.resolve({ kind: 'accepted' as const, value: { run: null } });
          case 'worktree-list':
            return Promise.resolve({
              kind: 'accepted' as const,
              value: { worktrees: [], totalCount: 0, truncated: false, hostScope: null },
            });
          case 'worker-list':
            return Promise.resolve({ kind: 'accepted' as const, value: { workers: [] } });
          case 'delivery-read':
            return Promise.resolve({
              kind: 'accepted' as const,
              value: { delivery: null, messages: [], timedOut: false, cancelled: false },
            });
          default:
            return Promise.resolve({ kind: 'accepted' as const, value: {} });
        }
      },
      mutate: (input: ExecutionMutation, scope) => {
        mutations.push(input);
        return Promise.resolve({
          kind: 'accepted' as const,
          operation: {
            operationId: scope.operationId,
            backendRequestId: `request-${scope.operationId}`,
            target: scope.target,
          },
          value: {},
        });
      },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* 装置                                                                        */
/* -------------------------------------------------------------------------- */

type Harness = {
  readonly repository: string;
  readonly directory: string;
  readonly host: Awaited<ReturnType<typeof createForegroundPlanningHost>>;
  readonly backend: FakeHostBackend;
  readonly dispose: () => void;
};

const created: Harness[] = [];

afterEach(() => {
  for (const harness of created.splice(0)) {
    harness.dispose();
    rmSync(harness.directory, { recursive: true, force: true });
  }
  clockMs = 1_000;
});

function initializeRepository(root: string): string {
  const repository = join(root, 'repo');
  mkdirSync(repository);
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Verification');
  git('config', 'user.email', 'verification@example.invalid');
  writeFileSync(join(repository, 'README.md'), '# repo\n');
  git('add', '.');
  git('commit', '-qm', 'initial');
  return repository;
}

function writeProjectConfig(repository: string): void {
  writeFileSync(
    join(repository, 'orca-companion.json'),
    JSON.stringify({
      schemaVersion: 4,
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
    }),
    'utf8',
  );
}

function fakeProbe(): DoctorProbe {
  return {
    readOrcaVersion: () => Promise.resolve({ ok: true, value: '1.4.198' }),
    readRuntime: () =>
      Promise.resolve({ ok: true, value: { state: 'running', reachable: true, capabilities: [] } }),
    readHosts: () => Promise.resolve({ ok: true, value: [] }),
    readCoordinatorIdentity: () => Promise.resolve({ ok: true, value: 'coordinator@test' }),
    readPublicCommands: () => Promise.resolve({ ok: true, value: [] }),
  };
}

function fakeTracker(): IssueTrackerGateway {
  const issue: TrackerIssue = {
    ref: { kind: 'route-map', id: '7' },
    title: 'Route Map',
    body: ROUTE_MAP_BODY,
    state: 'open',
    assignees: [],
  };
  return {
    readIssue: (): Promise<TrackerReadOutcome> => Promise.resolve({ kind: 'read', issue }),
    updateIssueBody: (): Promise<TrackerWriteOutcome> => Promise.resolve({ kind: 'accepted' }),
    assignIssue: (): Promise<TrackerWriteOutcome> => Promise.resolve({ kind: 'accepted' }),
  };
}

/** 重启前的现场：Scope 已登记，并且有一条「已发出 mutation、结果未知」的 Worker 派发意图。 */
function prepareRestartState(repository: string): void {
  const opened = openCoordinationStore({
    databasePath: coordinationDatabasePath(join(repository, '.git')),
    clock,
  });
  if (opened.kind !== 'opened') {
    throw new Error(opened.message);
  }
  const previous: CoordinationStore = opened.store;
  const initialized = initializeCoordinationScope({
    store: previous,
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION,
    coordinatorModelConfigurationRef: 'planning-default',
    planningCycleId: CYCLE,
    fullBranchRef: 'refs/heads/main',
    canonicalWorktreePath: canonicalPath(repository),
  });
  if (initialized.kind !== 'initialized') {
    throw new Error(`无法初始化 Scope: ${initialized.message}`);
  }
  const leased = acquireRuntimeLease(previous, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION,
    runtimeIncarnationId: PREVIOUS_INCARNATION,
    fencingGeneration: 0,
  });
  if (leased.kind !== 'acquired') {
    throw new Error('无法取得重启前的 Runtime Lease');
  }
  const previousWriter: CoordinationWriter = {
    coordinatorSessionId: SESSION,
    runtimeIncarnationId: PREVIOUS_INCARNATION,
    fencingGeneration: leased.lease.fencingGeneration,
  };
  const revision = (): number => {
    const read = previous.query({ kind: 'scope', coordinationScopeId: SCOPE });
    if (read.kind !== 'scope' || read.scope === null) {
      throw new Error('Scope 不存在');
    }
    return read.scope.revision;
  };
  const begun = beginIntent(previous, {
    coordinationScopeId: SCOPE,
    operationId: DISPATCH_OPERATION,
    target: { kind: 'worker-task', id: WORKER_TASK },
    operationCategory: 'worker-dispatch',
    writer: previousWriter,
    expectedRevision: revision(),
  });
  if (begun.kind !== 'registered') {
    throw new Error(`无法登记派发意图: ${begun.kind}`);
  }
  const retained = settleIntent(previous, {
    coordinationScopeId: SCOPE,
    operationId: DISPATCH_OPERATION,
    writer: previousWriter,
    expectedRevision: revision(),
    outcome: {
      kind: 'unknown',
      operation: {
        operationId: DISPATCH_OPERATION,
        backendRequestId: BACKEND_REQUEST,
        target: { kind: 'worker-task', id: WORKER_TASK },
      },
      reason: 'response_lost',
    },
  });
  if (retained.kind !== 'retained') {
    throw new Error(`派发意图未能保持未决: ${retained.kind}`);
  }
  // 「重启前这个 Session 运行过」：历史存在，因此 checkpoint 必须可读回。
  const checkpoint = openCheckpointStore({ databasePath: checkpointDatabasePath(join(repository, '.git')), clock });
  if (checkpoint.kind !== 'opened') {
    throw new Error(checkpoint.message);
  }
  const saved = checkpoint.store.saveCheckpoint({
    schemaVersion: COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
    coordinatorSessionId: SESSION,
    committedMessages: [],
    graphPosition: 'suspend',
    committedModelSteps: [],
    wakeBatches: [],
    lastCompactionOutcome: null,
  });
  checkpoint.store.close();
  if (saved.kind !== 'saved') {
    throw new Error('无法写入重启前的 checkpoint');
  }

  // 进程结束：释放租约，让下一次启动取得新的 incarnation。
  const released = previous.transact({
    kind: 'release-runtime-lease',
    coordinationScopeId: SCOPE,
    expectedRevision: revision(),
    writer: previousWriter,
  });
  if (released.kind === 'rejected') {
    throw new Error(`无法释放 Runtime Lease: ${released.message}`);
  }
  previous.close();
}

async function openHarness(): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), 'orca-foreground-exec-'));
  const repository = initializeRepository(directory);
  writeProjectConfig(repository);
  prepareRestartState(repository);

  const backend = fakeHostBackend();
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
    orcaProbe: fakeProbe(),
    trackerFactory: fakeTracker,
    loadIntegration: () => Promise.resolve({ CapableChatModel }),
    executionBackend: backend.backend,
  });
  // Home 解析选中 Scope（真实路径）：所有测试都在同一个选中 Scope 上执行。
  expect(await host.ports.scopeSetup.resolveHome()).toEqual({
    kind: 'restore',
    coordinationScopeId: SCOPE,
  });
  let disposed = false;
  const harness: Harness = {
    repository,
    directory,
    host,
    backend,
    dispose: () => {
      if (!disposed) {
        disposed = true;
        host.close();
      }
    },
  };
  created.push(harness);
  return harness;
}

/* -------------------------------------------------------------------------- */
/* store 事实的只读读取                                                        */
/* -------------------------------------------------------------------------- */

function readOnlyStore(repository: string): CoordinationStore {
  const opened = openCoordinationStore({
    databasePath: coordinationDatabasePath(join(repository, '.git')),
    clock,
    readOnly: true,
  });
  if (opened.kind !== 'opened') {
    throw new Error(opened.message);
  }
  return opened.store;
}

function runtimeLeases(store: CoordinationStore): readonly LeaseRecord[] {
  const read = store.query({ kind: 'leases', coordinationScopeId: SCOPE });
  return read.kind === 'leases' ? read.leases.filter((lease) => lease.kind === 'runtime') : [];
}

function intentOf(store: CoordinationStore): {
  readonly state: string;
  readonly outcomeClass: string | null;
  readonly blockingReason: string | null;
  readonly laneKey: string;
} | null {
  const read = store.query({ kind: 'intent', coordinationScopeId: SCOPE, operationId: DISPATCH_OPERATION });
  if (read.kind !== 'intent' || read.intent === null) {
    return null;
  }
  return {
    state: read.intent.state,
    outcomeClass: read.intent.outcomeClass,
    blockingReason: read.intent.blockingReason,
    laneKey: read.intent.laneKey,
  };
}

async function openSession(harness: Harness): Promise<void> {
  const accepted = await harness.host.ports.execute({
    kind: 'send-session-message',
    submissionId: globalThis.crypto.randomUUID(),
    coordinatorSessionId: SESSION,
    content: '重启后继续处理',
  });
  expect(accepted.kind).toBe('accepted');
}

/* -------------------------------------------------------------------------- */
/* 测试                                                                        */
/* -------------------------------------------------------------------------- */

test('活跃 Worker 后重启：首次新派发之前对账状态可见，同一 Task/Dispatch/Attempt 不被重复创建', async () => {
  const harness = await openHarness();
  await openSession(harness);

  // 对账用的还是原 OperationId 的 backend request，绝不换 ID。
  const requestShows = harness.backend.queries
    .filter((query) => query.operation === 'request-show')
    .map((query) => (query.operation === 'request-show' ? query.requestId : null));
  expect(requestShows).toContain(BACKEND_REQUEST);

  // 对账结论可见：lane 与启动对账两个来源的 blocker 都在快照里，且带原因。
  const snapshot = await harness.host.ports.snapshot(SESSION);
  expect(snapshot.kind).toBe('snapshot');
  if (snapshot.kind !== 'snapshot') {
    return;
  }
  const blockers = snapshot.snapshot.blockers;
  expect(blockers.some((blocker) => blocker.source === 'mutation_lane' && blocker.message.includes(DISPATCH_OPERATION))).toBe(true);
  expect(blockers.map((blocker) => `${blocker.source}|${blocker.code}|${blocker.message}`)).toContainEqual(
    expect.stringContaining('启动对账'),
  );

  // 启动序列一个 Scope 只执行一次：再次打开同一个 Session 不会再对账一遍。
  const showsAfterStartup = harness.backend.queries.filter((query) => query.operation === 'request-show').length;
  await openSession(harness);
  await harness.host.ports.snapshot(SESSION);
  expect(harness.backend.queries.filter((query) => query.operation === 'request-show')).toHaveLength(
    showsAfterStartup,
  );

  // 首次新派发之前：零 worker-start，也没有新的派发意图或物化绑定。
  expect(harness.backend.mutations.filter((mutation) => mutation.operation === 'worker-start')).toEqual([]);
  const store = readOnlyStore(harness.repository);
  try {
    const intents = store.query({ kind: 'intents', coordinationScopeId: SCOPE });
    expect(intents.kind === 'intents' ? intents.intents : []).toHaveLength(1);
    const bindings = store.query({ kind: 'materialization-bindings', coordinationScopeId: SCOPE });
    expect(bindings.kind === 'materialization-bindings' ? bindings.bindings : []).toEqual([]);
  } finally {
    store.close();
  }
});

test('Resume 先对账再恢复调度；对账不确定的 lane 仍被拦住，未知不被报为已退出', async () => {
  const harness = await openHarness();
  await openSession(harness);

  const paused = await harness.host.ports.execute({ kind: 'scope-control', action: 'pause' });
  expect(paused.kind).toBe('accepted');

  const requestShowsBefore = harness.backend.queries.filter((query) => query.operation === 'request-show').length;
  const resumed = await harness.host.ports.execute({ kind: 'scope-control', action: 'resume' });
  expect(resumed.kind).toBe('accepted');
  // 旧的占位实现会以 `scope_control_unavailable` / `reconciliation_unavailable` 拒绝 Resume。
  expect([paused, resumed].map((result) => (result.kind === 'rejected' ? result.code : null))).not.toContain(
    'reconciliation_unavailable',
  );
  const requestShowsAfter = harness.backend.queries.filter((query) => query.operation === 'request-show').length;
  // Resume 真的重新对账，而不是只改控制状态。
  expect(requestShowsAfter).toBeGreaterThan(requestShowsBefore);

  const store = readOnlyStore(harness.repository);
  try {
    const scope = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
    expect(scope.kind === 'scope' ? scope.scope?.controlState : null).toBe('active');

    // 对账仍不确定：结论是「阻塞」而不是任何终态，未知也没有被读成「worker 已退出」。
    const intent = intentOf(store);
    expect(intent?.state).toBe('blocked');
    expect(intent?.outcomeClass).toBeNull();
    expect(intent?.blockingReason ?? '').toContain(DISPATCH_OPERATION);
  } finally {
    store.close();
  }

  // 恢复调度之后那条 lane 依然不可派发：blocker 仍在，且没有任何新的派发。
  const snapshot = await harness.host.ports.snapshot(SESSION);
  if (snapshot.kind !== 'snapshot') {
    throw new Error('快照应当可读');
  }
  expect(snapshot.snapshot.blockers.some((blocker) => blocker.message.includes(DISPATCH_OPERATION))).toBe(true);
  expect(harness.backend.mutations.filter((mutation) => mutation.operation === 'worker-start')).toEqual([]);
});

test('整个启动与 Resume 过程只出现一条未释放的 Runtime Lease', async () => {
  const harness = await openHarness();

  // 只读路径不取租约：重启前的租约已经释放，此时没有任何未释放的 Runtime Lease。
  const before = readOnlyStore(harness.repository);
  try {
    expect(runtimeLeases(before).filter((lease) => lease.releasedAt === null)).toEqual([]);
  } finally {
    before.close();
  }
  await harness.host.ports.snapshot(SESSION);
  const afterSnapshot = readOnlyStore(harness.repository);
  try {
    expect(runtimeLeases(afterSnapshot).filter((lease) => lease.releasedAt === null)).toEqual([]);
  } finally {
    afterSnapshot.close();
  }

  await openSession(harness);
  await harness.host.ports.execute({ kind: 'scope-control', action: 'resume' });

  const store = readOnlyStore(harness.repository);
  try {
    const held = runtimeLeases(store).filter((lease) => lease.releasedAt === null);
    expect(held).toHaveLength(1);
    // 启动序列与 Resume 都在这条租约上完成：没有再取第二份。
    expect(held[0]?.coordinatorSessionId).toBe(SESSION);
    // 只有这一次启动留下了租约记录：释放过的旧租约不会残留成第二行。
    expect(runtimeLeases(store)).toHaveLength(1);
  } finally {
    store.close();
  }
});


/* -------------------------------------------------------------------------- */
/* IP-03：授权后宿主真的推进一次 Frontier                                       */
/* -------------------------------------------------------------------------- */

const EXEC_SCOPE = 'scope-advance' as CoordinationScopeId;
const EXEC_SESSION = 'session-advance' as CoordinatorSessionId;
const EXEC_CYCLE = 'cycle-advance' as PlanningCycleId;
const EXEC_INCARNATION = 'incarnation-advance' as RuntimeIncarnationId;
const EXEC_GENERATION = 1 as GraphGeneration;
const EXEC_GRAPH = graphIdFor(EXEC_SCOPE, EXEC_GENERATION);
const EXEC_RUN = 'run-advance';
const EXEC_AUTH = 'auth-advance';
const EXEC_WP_A = 'wp-a' as WorkPackageId;
const EXEC_WP_B = 'wp-b' as WorkPackageId;
/** 执行交接门测试的 Target：与 Source 同 Scope 的独立 Session。 */
const EXEC_TARGET = 'session-advance-target' as CoordinatorSessionId;
/** 等待触发点结论的时间上界；fake backend 全同步，这里只防「什么都没发生」。 */
const ADVANCE_WAIT_MS = 3_000;
const ADVANCE_TIMEOUT_MS = 20_000;

type AdvanceFake = {
  readonly backend: ExecutionBackend;
  readonly mutations: readonly ExecutionMutation[];
};

/** 记录型 fake Orca：worktree / terminal / worker 三类资源都可读回，worker-start 可按需未知。 */
function fakeAdvanceOrca(options: {
  readonly unknownWorkerStart?: boolean;
  readonly worktreeRoot: string;
  /** 物化会按实时事实核验 worktree 的 HEAD 是否就是授权 baseline。 */
  readonly baselineHead: string;
}): AdvanceFake {
  const mutations: ExecutionMutation[] = [];
  const worktrees: WorktreeSummary[] = [];
  const terminals: { handle: string; title: string }[] = [];
  const workers: { dispatchId: string; taskId: string }[] = [];
  let dispatchSeq = 0;
  return {
    mutations,
    backend: {
      query: (input: ExecutionQuery) => {
        switch (input.operation) {
          case 'run-current':
            return Promise.resolve({
              kind: 'accepted' as const,
              value: { run: { runId: EXEC_RUN, consumerGeneration: 1 } },
            });
          case 'worktree-list':
            return Promise.resolve({
              kind: 'accepted' as const,
              value: {
                worktrees,
                totalCount: worktrees.length,
                truncated: false,
                hostScope: { hostIds: ['local'], omittedHostIds: [] },
              },
            });
          case 'worker-list':
            return Promise.resolve({
              kind: 'accepted' as const,
              value: {
                workers: workers.map((worker) => ({
                  dispatchId: worker.dispatchId,
                  taskId: worker.taskId,
                  workerState: 'running',
                  terminalState: null,
                })),
              },
            });
          case 'request-show':
            return Promise.resolve({
              kind: 'accepted' as const,
              value: { requestId: input.requestId, state: 'pending' },
            });
          case 'delivery-read':
            return Promise.resolve({
              kind: 'accepted' as const,
              value: { delivery: null, messages: [], timedOut: false, cancelled: false },
            });
          case 'terminal-list':
            return Promise.resolve({
              kind: 'accepted' as const,
              value: {
                terminals: terminals.map((terminal) => ({
                  handle: terminal.handle,
                  connected: true,
                  writable: true,
                  title: terminal.title,
                })),
                omittedHostIds: [],
                truncated: false,
              },
            });
          case 'terminal-wait':
            return Promise.resolve({ kind: 'accepted' as const, value: { terminal: { state: 'idle' } } });
          case 'terminal-read':
            return Promise.resolve({ kind: 'accepted' as const, value: { terminal: { draft: '' } } });
          case 'worker-show':
            return Promise.resolve({
              kind: 'accepted' as const,
              value: { exactWorker: true, agentTerminalHandle: terminals[0]?.handle ?? null },
            });
          default:
            return Promise.resolve({
              kind: 'rejected' as const,
              code: 'unregistered_fake_query',
              message: input.operation,
            });
        }
      },
      mutate: (input: ExecutionMutation, scope) => {
        mutations.push(input);
        const accepted = (value: unknown) =>
          Promise.resolve({
            kind: 'accepted' as const,
            operation: { operationId: scope.operationId, target: scope.target },
            value,
          });
        if (input.operation === 'worktree-create') {
          // worktree 必须真实存在：Codex 启动策略会在它下面写自己的状态根。
          const path = join(options.worktreeRoot, input.name ?? 'worktree');
          mkdirSync(path, { recursive: true });
          worktrees.push({
            worktreeId: `wt-${String(worktrees.length + 1)}`,
            path,
            branch: `refs/heads/${input.name ?? 'worktree'}`,
            head: options.baselineHead,
            displayName: input.name ?? 'worktree',
            comment: input.comment ?? null,
            isMainWorktree: false,
          });
          return accepted({ worktreeId: worktrees[worktrees.length - 1]?.worktreeId ?? 'wt-1' });
        }
        if (input.operation === 'task-create') {
          return accepted({ id: `orca-task-${String(mutations.length)}`, spec: input.spec ?? '' });
        }
        if (input.operation === 'terminal-create') {
          terminals.push({ handle: `terminal-${String(terminals.length + 1)}`, title: input.title ?? '' });
          return accepted({ handle: terminals[terminals.length - 1]?.handle ?? 'terminal-1' });
        }
        if (input.operation === 'worker-start') {
          if (options.unknownWorkerStart === true) {
            return Promise.resolve({
              kind: 'unknown' as const,
              operation: { operationId: scope.operationId, target: scope.target },
              reason: '传输超时，无法核验 worker-start 是否发生',
            });
          }
          dispatchSeq += 1;
          const dispatchId = `dispatch-${String(dispatchSeq)}`;
          workers.push({ dispatchId, taskId: input.taskId });
          return accepted({ taskId: input.taskId, dispatchId, state: 'ready' });
        }
        return accepted(null);
      },
    },
  };
}

/** 现场：两个互相独立的 Work Package（因此有两个候选），授权已批准且已进入执行协调态。 */
function prepareAdvanceState(repository: string, head: string): void {
  const opened = openCoordinationStore({
    databasePath: coordinationDatabasePath(join(repository, '.git')),
    clock,
  });
  if (opened.kind !== 'opened') {
    throw new Error(opened.message);
  }
  const store: CoordinationStore = opened.store;
  try {
    const initialized = initializeCoordinationScope({
      store,
      coordinationScopeId: EXEC_SCOPE,
      coordinatorSessionId: EXEC_SESSION,
      coordinatorModelConfigurationRef: 'planning-default',
      planningCycleId: EXEC_CYCLE,
      fullBranchRef: 'refs/heads/main',
      canonicalWorktreePath: canonicalPath(repository),
    });
    if (initialized.kind !== 'initialized') {
      throw new Error(`无法初始化 Scope：${initialized.message}`);
    }
    const acquired = acquireRuntimeLease(store, {
      coordinationScopeId: EXEC_SCOPE,
      coordinatorSessionId: EXEC_SESSION,
      runtimeIncarnationId: EXEC_INCARNATION,
      fencingGeneration: 0,
    });
    if (acquired.kind !== 'acquired') {
      throw new Error('无法取得 Runtime Lease');
    }
    const writer: CoordinationWriter = {
      coordinatorSessionId: EXEC_SESSION,
      runtimeIncarnationId: EXEC_INCARNATION,
      fencingGeneration: acquired.lease.fencingGeneration,
    };
    const budget = {
      implementationAttempts: DEFAULT_EXECUTION_LIMITS.implementationAttempts,
      validatorRepairs: DEFAULT_EXECUTION_LIMITS.validatorRepairs,
      graphRevisions: DEFAULT_EXECUTION_LIMITS.graphRevisions,
      specificationRevisions: DEFAULT_EXECUTION_LIMITS.specificationRevisions,
      integrationReconciliations: DEFAULT_EXECUTION_LIMITS.integrationReconciliations,
      maxRecoveriesPerWorkerAttempt: DEFAULT_EXECUTION_LIMITS.maxRecoveriesPerWorkerAttempt,
    };
    const graph: ExecutionGraph = {
      graphId: EXEC_GRAPH,
      generation: EXEC_GENERATION,
      workPackages: [
        { workPackageId: EXEC_WP_A, title: '第一个工作包', dependsOn: [], scopeEnvelope: { include: ['src'], exclude: [] }, budget },
        { workPackageId: EXEC_WP_B, title: '第二个工作包', dependsOn: [], scopeEnvelope: { include: ['src'], exclude: [] }, budget },
      ],
    };
    const recorded = recordInitialGraph({
      store,
      coordinationScopeId: EXEC_SCOPE,
      writer,
      graph,
      initialPlan: implementationPlanFor(graph, 1),
      mapRevision: 1,
      planRevision: 1,
      orcaRunId: EXEC_RUN,
    });
    if (recorded.kind !== 'recorded') {
      throw new Error(`无法记录初始图：${recorded.failure.message}`);
    }
    const ensured = ensureGraphGenerationRecord({
      store,
      coordinationScopeId: EXEC_SCOPE,
      writer,
      graphId: EXEC_GRAPH,
      generation: EXEC_GENERATION,
      planningCycleId: EXEC_CYCLE,
      orcaRunId: EXEC_RUN,
      predecessorGraphId: null,
      baselineHead: head,
    });
    if (ensured.kind !== 'recorded') {
      throw new Error('无法记录世代');
    }
    const revision = (): number => {
      const read = store.query({ kind: 'scope', coordinationScopeId: EXEC_SCOPE });
      if (read.kind !== 'scope' || read.scope === null) {
        throw new Error('Scope 不存在');
      }
      return read.scope.revision;
    };
    const manifest: ExecutionAuthorizationManifest = {
      // 与下面 `record-authorization` 写入的版本一致：Manifest2 起模型绑定与 Recovery Utility 都是必填。
      manifestVersion: MANIFEST_VERSION,
      coordinationScopeId: EXEC_SCOPE,
      planningCycleId: EXEC_CYCLE,
      destinationRef: { kind: 'destination', id: 'dest-1', version: 1 },
      routeMapRef: { kind: 'route-map', id: '7', version: 1 },
      implementationPlanRef: { kind: 'implementation-plan', id: 'plan-1', version: 1 },
      graph: { graphId: EXEC_GRAPH, generation: EXEC_GENERATION, version: 1 as GraphVersion },
      baselineHead: head,
      orcaRunId: EXEC_RUN,
      workerProfiles: executionWorkerProfiles(),
      recoveryUtilityProfile: recoveryUtilityProfileFixture(),
      permissions: {
        planner: true,
        implementation: true,
        validator: true,
        finalizer: true,
        gitIntegration: true,
        dependencyChanges: false,
      },
      limits: DEFAULT_EXECUTION_LIMITS,
      workspacePolicy: { canonicalWorktree: canonicalPath(repository), worktreeIsolation: 'per_work_package' },
      gitPolicy: { canonicalBranch: 'main', remotes: ['origin'], refs: ['refs/heads/main'], allowForcePush: false },
      dependencyPolicy: { allowDependencyChanges: false, registry: null },
      acceptedRisks: [],
    };
    const authorized = store.transact({
      kind: 'record-authorization',
      coordinationScopeId: EXEC_SCOPE,
      expectedRevision: revision(),
      writer,
      authorizationId: EXEC_AUTH,
      authorizationVersion: 1,
      manifestVersion: 4,
      fingerprint: 'fingerprint-advance',
      approvalRef: 'approval-advance',
      manifest,
    });
    if (authorized.kind === 'rejected') {
      throw new Error(`无法记录授权：${authorized.message}`);
    }
    const transitioned = store.transact({
      kind: 'transition-to-execution',
      coordinationScopeId: EXEC_SCOPE,
      expectedRevision: revision(),
      writer,
      planningCycleId: EXEC_CYCLE,
      graphId: EXEC_GRAPH,
      graphVersion: 1 as GraphVersion,
      authorizationId: EXEC_AUTH,
      authorizationVersion: 1,
    });
    if (transitioned.kind === 'rejected') {
      throw new Error(`无法进入执行协调态：${transitioned.message}`);
    }
    const checkpoints = openCheckpointStore({
      databasePath: checkpointDatabasePath(join(repository, '.git')),
      clock,
    });
    if (checkpoints.kind !== 'opened') {
      throw new Error(checkpoints.message);
    }
    const saved = checkpoints.store.saveCheckpoint({
      schemaVersion: COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
      coordinatorSessionId: EXEC_SESSION,
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
    const released = store.transact({
      kind: 'release-runtime-lease',
      coordinationScopeId: EXEC_SCOPE,
      expectedRevision: revision(),
      writer,
    });
    if (released.kind === 'rejected') {
      throw new Error(`无法释放 Runtime Lease：${released.message}`);
    }
  } finally {
    store.close();
  }
}

type AdvanceHarness = {
  readonly repository: string;
  readonly directory: string;
  readonly host: Awaited<ReturnType<typeof createForegroundPlanningHost>>;
  readonly fake: AdvanceFake;
  readonly dispose: () => void;
};

const advanceHarnesses: AdvanceHarness[] = [];
/** 绑定签发测试用到的临时目录；与 harness 目录分开回收。 */
const bindingDirectories: string[] = [];

afterEach(() => {
  for (const directory of bindingDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  for (const harness of advanceHarnesses.splice(0)) {
    harness.dispose();
    rmSync(harness.directory, { recursive: true, force: true });
  }
});

async function openAdvanceHarness(options?: { readonly unknownWorkerStart?: boolean }): Promise<AdvanceHarness> {
  const directory = mkdtempSync(join(tmpdir(), 'orca-advance-'));
  const repository = join(directory, 'repo');
  mkdirSync(repository);
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Verification');
  git('config', 'user.email', 'verification@example.invalid');
  writeFileSync(join(repository, 'README.md'), '# repo\n');
  writeFileSync(
    join(repository, 'orca-companion.json'),
    JSON.stringify({
      schemaVersion: 4,
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
      ...projectConnectionsFixture(),
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
  const change = join(repository, 'openspec', 'changes', 'demo');
  mkdirSync(change, { recursive: true });
  writeFileSync(join(change, 'proposal.md'), '# Proposal\n\n## Impact\n\n- `src/a.ts`\n');
  writeFileSync(join(change, 'tasks.md'), '- [ ] 1.1 做点事\n');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  const head = git('rev-parse', 'HEAD');
  prepareAdvanceState(repository, head);

  const worktreeRoot = join(directory, 'worktrees');
  mkdirSync(worktreeRoot, { recursive: true });
  const fake = fakeAdvanceOrca({
    worktreeRoot,
    baselineHead: head,
    ...(options?.unknownWorkerStart === undefined ? {} : { unknownWorkerStart: options.unknownWorkerStart }),
  });
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
    orcaProbe: fakeProbe(),
    trackerFactory: fakeTracker,
    loadIntegration: () => Promise.resolve({ CapableChatModel }),
    executionBackend: fake.backend,
  });
  expect(await host.ports.scopeSetup.resolveHome()).toEqual({
    kind: 'restore',
    coordinationScopeId: EXEC_SCOPE,
  });
  let disposed = false;
  const harness: AdvanceHarness = {
    repository,
    directory,
    host,
    fake,
    dispose: () => {
      if (!disposed) {
        disposed = true;
        host.close();
      }
    },
  };
  advanceHarnesses.push(harness);
  return harness;
}

async function sendAdvanceMessage(harness: AdvanceHarness, content: string): Promise<void> {
  const result = await harness.host.ports.execute({
    kind: 'send-session-message',
    submissionId: globalThis.crypto.randomUUID(),
    coordinatorSessionId: EXEC_SESSION,
    content,
  });
  if (result.kind !== 'accepted') {
    throw new Error(`send-session-message 被拒绝：${JSON.stringify(result)}`);
  }
}

function mutationCount(harness: AdvanceHarness, operation: string): number {
  return harness.fake.mutations.filter((mutation) => mutation.operation === operation).length;
}

function readAdvanceStore(repository: string): CoordinationStore {
  const opened = openCoordinationStore({
    databasePath: coordinationDatabasePath(join(repository, '.git')),
    clock,
    readOnly: true,
  });
  if (opened.kind !== 'opened') {
    throw new Error(opened.message);
  }
  return opened.store;
}

test('授权后宿主真的推进一次 Frontier：一个候选获得隔离 worktree 与角色 Task，且只推进一个 Work Package', { timeout: ADVANCE_TIMEOUT_MS }, async () => {
  const harness = await openAdvanceHarness();
  await sendAdvanceMessage(harness, '开始执行');
  await vi.waitFor(() => {
    expect(mutationCount(harness, 'worker-start')).toBe(1);
  }, { timeout: ADVANCE_WAIT_MS, interval: 25 });

  // 一次完整的物化序列，且只针对第一个候选。
  const created = harness.fake.mutations.find((mutation) => mutation.operation === 'worktree-create');
  expect(created?.operation === 'worktree-create' ? created.comment : null).toBe(workPackageComment(EXEC_WP_A));
  expect(mutationCount(harness, 'worktree-create')).toBe(1);
  expect(mutationCount(harness, 'task-create')).toBe(1);
  expect(mutationCount(harness, 'worker-start')).toBe(1);

  const store = readAdvanceStore(harness.repository);
  try {
    const bindings = store.query({ kind: 'materialization-bindings', coordinationScopeId: EXEC_SCOPE });
    expect(bindings.kind === 'materialization-bindings' ? bindings.bindings : []).toHaveLength(1);
    expect(bindings.kind === 'materialization-bindings' ? bindings.bindings[0]?.workPackageId : null).toBe(EXEC_WP_A);
    // 物化绑定必须记下这次派发的 launch 身份：错过的 Session Binding 只能靠它补记（schema 12）。
    expect(bindings.kind === 'materialization-bindings' ? bindings.bindings[0]?.launchId : null).toMatch(/^worker-launch:/);
  } finally {
    store.close();
  }

  // Planner 的 Task Envelope 必须把产出纪律写成面向 Worker 的正文：位置、结构、不得归档。
  const taskCreate = harness.fake.mutations.find((mutation) => mutation.operation === 'task-create');
  const spec =
    taskCreate?.operation === 'task-create'
      ? (JSON.parse(taskCreate.spec) as { instructions?: readonly string[]; specificationUnitPath?: string })
      : null;
  expect(spec?.specificationUnitPath).toContain(EXEC_WP_A);
  expect(spec?.instructions?.length).toBeGreaterThan(0);
  expect(spec?.instructions?.some((line) => line.includes(spec.specificationUnitPath ?? ''))).toBe(true);
  expect(spec?.instructions?.some((line) => line.includes('archive'))).toBe(true);

  // 第二次触发点：Worker 仍在运行（worker-list 已列举），因此不再物化第二个候选。
  await sendAdvanceMessage(harness, '继续');
  await sendAdvanceMessage(harness, '再继续');
  await vi.waitFor(async () => {
    const loaded: SnapshotLoad = await harness.host.ports.snapshot(EXEC_SESSION);
    expect(loaded.kind).toBe('snapshot');
  }, { timeout: ADVANCE_WAIT_MS, interval: 25 });
  expect(mutationCount(harness, 'worktree-create')).toBe(1);
  expect(mutationCount(harness, 'task-create')).toBe(1);
  expect(mutationCount(harness, 'worker-start')).toBe(1);
});

test('派发结果未知：保留原 OperationId，且不产生第二个 Task 或 Dispatch', { timeout: ADVANCE_TIMEOUT_MS }, async () => {
  const harness = await openAdvanceHarness({ unknownWorkerStart: true });
  await sendAdvanceMessage(harness, '开始执行');
  await vi.waitFor(() => {
    expect(mutationCount(harness, 'worker-start')).toBe(1);
  }, { timeout: ADVANCE_WAIT_MS, interval: 25 });

  const before = readAdvanceStore(harness.repository);
  let blockedOperationId: string | null = null;
  try {
    const intents = before.query({ kind: 'intents', coordinationScopeId: EXEC_SCOPE });
    const blocked = (intents.kind === 'intents' ? intents.intents : []).filter(
      (intent) => intent.operationCategory === 'materialize-worker-start',
    );
    expect(blocked).toHaveLength(1);
    blockedOperationId = blocked[0]?.operationId ?? null;
    expect(blocked[0]?.state).toBe('blocked');
  } finally {
    before.close();
  }

  await sendAdvanceMessage(harness, '继续');
  let loaded: SnapshotLoad | null = null;
  await vi.waitFor(async () => {
    loaded = await harness.host.ports.snapshot(EXEC_SESSION);
    const codes = loaded.kind === 'snapshot' ? loaded.snapshot.blockers.map((blocker) => blocker.message) : [];
    expect(codes.some((message) => message.includes(String(blockedOperationId)))).toBe(true);
  }, { timeout: ADVANCE_WAIT_MS, interval: 25 });

  // 原身份没有被换掉，也没有第二次 Task/Dispatch。
  const after = readAdvanceStore(harness.repository);
  try {
    const intents = after.query({ kind: 'intents', coordinationScopeId: EXEC_SCOPE });
    const starts = (intents.kind === 'intents' ? intents.intents : []).filter(
      (intent) => intent.operationCategory === 'materialize-worker-start',
    );
    expect(starts.map((intent) => intent.operationId)).toEqual([blockedOperationId]);
  } finally {
    after.close();
  }
  expect(mutationCount(harness, 'task-create')).toBe(1);
  expect(mutationCount(harness, 'worker-start')).toBe(1);
  expect(mutationCount(harness, 'worktree-create')).toBe(1);
});

/* -------------------------------------------------------------------------- */
/* 执行交接激活门（IP-11）：cutover 后 Target 只由下一条普通 Prompt 激活           */
/* -------------------------------------------------------------------------- */

function waitTick(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 读取活动租约构造可信 writer：这些写入必须由当前 Execution Coordination Lease 持有者承担。 */
function liveAdvanceWriter(store: CoordinationStore): CoordinationWriter {
  const read = store.query({ kind: 'leases', coordinationScopeId: EXEC_SCOPE });
  const leases = read.kind === 'leases' ? read.leases : [];
  const lease =
    leases.find((entry) => entry.kind === 'execution_coordination' && entry.releasedAt === null) ??
    leases.find(
      (entry) => entry.kind === 'runtime' && entry.coordinatorSessionId === EXEC_SESSION && entry.releasedAt === null,
    );
  if (lease === undefined) {
    throw new Error('找不到活动租约：无法注册或推进交接');
  }
  return {
    coordinatorSessionId: lease.coordinatorSessionId,
    runtimeIncarnationId: lease.runtimeIncarnationId,
    fencingGeneration: lease.fencingGeneration,
  };
}

/**
 * 同一测试内注册 Target，并在它的 checkpoint 播一条未回答的历史 user 消息。
 *
 * 这条历史消息是断言的关键：没有激活门时，Target 一旦被拉起就会把它当作待处理工作并写入模型
 * step；有门则必须等到用户的下一条普通 Prompt。
 */
function seedHandoffTarget(repository: string): void {
  const coordination = openCoordinationStore({
    databasePath: coordinationDatabasePath(join(repository, '.git')),
    clock,
  });
  if (coordination.kind !== 'opened') {
    throw new Error(coordination.message);
  }
  try {
    const store = coordination.store;
    const scope = store.query({ kind: 'scope', coordinationScopeId: EXEC_SCOPE });
    if (scope.kind !== 'scope' || scope.scope === null) {
      throw new Error('Scope 不存在：无法注册交接 Target');
    }
    const registered = store.transact({
      kind: 'register-session',
      coordinationScopeId: EXEC_SCOPE,
      expectedRevision: scope.scope.revision,
      writer: liveAdvanceWriter(store),
      coordinatorSessionId: EXEC_TARGET,
      coordinatorModelConfigurationRef: 'planning-default',
      lifecycleState: 'active',
    });
    if (registered.kind === 'rejected') {
      throw new Error(`无法注册交接 Target：${registered.message}`);
    }
  } finally {
    coordination.store.close();
  }

  const checkpoints = openCheckpointStore({
    databasePath: checkpointDatabasePath(join(repository, '.git')),
    clock,
  });
  if (checkpoints.kind !== 'opened') {
    throw new Error(checkpoints.message);
  }
  try {
    const saved = checkpoints.store.saveCheckpoint({
      schemaVersion: COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
      coordinatorSessionId: EXEC_TARGET,
      committedMessages: [
        { entryId: 'hist-user-1', stepId: 'hist-user-1', role: 'user', content: '交接前的历史消息' },
      ],
      graphPosition: 'suspend',
      committedModelSteps: [],
      wakeBatches: [],
      lastCompactionOutcome: null,
    });
    if (saved.kind !== 'saved') {
      throw new Error('无法写入交接 Target 的 checkpoint');
    }
  } finally {
    checkpoints.store.close();
  }
}

/** Target 的激活来源准入：只有 `execution-handoff-activation` 这一条才代表激活门被满足。 */
function targetActivationAdmissions(repository: string): number {
  const store = readAdvanceStore(repository);
  try {
    const read = store.query({
      kind: 'wake-admissions',
      coordinationScopeId: EXEC_SCOPE,
      coordinatorSessionId: EXEC_TARGET,
    });
    const admissions: readonly WakeAdmissionRecord[] = read.kind === 'wake-admissions' ? read.admissions : [];
    return admissions.filter((record) =>
      record.sourceRevisions.some((source) => source.sourceKind === 'execution-handoff-activation'),
    ).length;
  } finally {
    store.close();
  }
}

/** Target checkpoint 里已接受的模型 step 数量。 */
function targetModelSteps(repository: string): number {
  const opened = openCheckpointStore({
    databasePath: checkpointDatabasePath(join(repository, '.git')),
    clock,
  });
  if (opened.kind !== 'opened') {
    throw new Error(opened.message);
  }
  try {
    const read = opened.store.loadCheckpoint(EXEC_TARGET, 'full');
    return read.kind === 'recovered' ? read.state.committedModelSteps.length : 0;
  } finally {
    opened.store.close();
  }
}

test(
  '执行交接 cutover 后 Target 处于 awaiting_user_prompt：历史消息与定时对账都不启动模型，只有下一条普通消息才激活',
  { timeout: ADVANCE_TIMEOUT_MS },
  async () => {
    const harness = await openAdvanceHarness();
    // Source 先成为活动 Session，并让首个派发落定：之后 Scope 静默，交接不会被并发写入打断。
    await sendAdvanceMessage(harness, '准备交接');
    await vi.waitFor(
      () => {
        expect(mutationCount(harness, 'worker-start')).toBe(1);
      },
      { timeout: ADVANCE_WAIT_MS, interval: 25 },
    );

    seedHandoffTarget(harness.repository);

    // prepare → review → cutover 全部走生产宿主端口：review 由 Source 复核并拉起 Target，cutover 由
    // Source 单次 CAS 转移责任。Target 在门被满足前一直处于 awaiting_user_prompt。
    const prepared = await harness.host.ports.executionHandoff.prepare(EXEC_TARGET);
    expect(prepared.kind).toBe('accepted');
    const preparedRef = prepared.kind === 'accepted' ? prepared.resultRef : undefined;
    if (preparedRef === undefined || preparedRef.kind !== 'execution-handoff') {
      throw new Error('prepare 未返回 Execution Handoff 引用');
    }
    const reviewed = await harness.host.ports.executionHandoff.review(preparedRef.handoffId);
    expect(reviewed.kind).toBe('accepted');
    const reviewedRef = reviewed.kind === 'accepted' ? reviewed.resultRef : undefined;
    if (reviewedRef === undefined || reviewedRef.kind !== 'execution-handoff') {
      throw new Error('review 未返回 Execution Handoff 引用');
    }
    const cutover = await harness.host.ports.executionHandoff.cutover(
      preparedRef.handoffId,
      reviewedRef.revision,
    );
    expect(cutover.kind).toBe('accepted');

    const workerStartsAfterCutover = mutationCount(harness, 'worker-start');
    // 两个定时对账 tick：Target 仍未被激活，历史消息未被消费；确定性触发点也不得在 cutover 后新建
    // 派发（Delivery 已发生时的结算仍可照常运行）。
    await waitTick(2_200);
    expect(mutationCount(harness, 'worker-start')).toBe(workerStartsAfterCutover);
    expect(targetActivationAdmissions(harness.repository)).toBe(0);
    expect(targetModelSteps(harness.repository)).toBe(0);

    // 只有下一条普通 Prompt 才满足激活门。
    const sent = await harness.host.ports.execute({
      kind: 'send-session-message',
      submissionId: globalThis.crypto.randomUUID(),
      coordinatorSessionId: EXEC_TARGET,
      content: '开始执行',
    });
    expect(sent.kind).toBe('accepted');
    await vi.waitFor(
      () => {
        expect(targetActivationAdmissions(harness.repository)).toBeGreaterThan(0);
        expect(targetModelSteps(harness.repository)).toBeGreaterThan(0);
      },
      { timeout: ADVANCE_WAIT_MS, interval: 25 },
    );

    // 重开同一仓库：已消费的激活不得被重复注入，模型也不得重复处理同一条工作。
    const admissionsBeforeReopen = targetActivationAdmissions(harness.repository);
    const stepsBeforeReopen = targetModelSteps(harness.repository);
    harness.host.close();
    // 现有 harness 不能重开（每次新建临时目录），host.close 也不幂等，因此这里自行接管清理、
    // 不再让 afterEach 走 harness.dispose。
    advanceHarnesses.splice(advanceHarnesses.indexOf(harness), 1);
    try {
      const reopened = await createForegroundPlanningHost({
        repositoryPath: harness.repository,
        env: process.env as Record<string, string>,
        clock,
        newId: (() => {
          let counter = 0;
          return () => `reopen-${String((counter += 1))}`;
        })(),
        heartbeatIntervalMs: 1_000,
        leaseTtlMs: 60_000,
        orcaProbe: fakeProbe(),
        trackerFactory: fakeTracker,
        loadIntegration: () => Promise.resolve({ CapableChatModel }),
        executionBackend: harness.fake.backend,
      });
      try {
        expect(await reopened.ports.scopeSetup.resolveHome()).toEqual({
          kind: 'restore',
          coordinationScopeId: EXEC_SCOPE,
        });
        // 让重启后的宿主重新拉起 Target Session（phase 已是 cutover，端口只产生 liveness）。
        await reopened.ports.executionHandoff.review(preparedRef.handoffId);
        await waitTick(2_200);
        expect(targetActivationAdmissions(harness.repository)).toBe(admissionsBeforeReopen);
        expect(targetModelSteps(harness.repository)).toBe(stepsBeforeReopen);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(harness.directory, { recursive: true, force: true });
    }
  },
);

/* -------------------------------------------------------------------------- */
/* 中断 Segment 的选择规则（IP-04）：未确认的 Delivery 不是「会话丢失」            */
/* -------------------------------------------------------------------------- */

function segment(overrides: Partial<SessionSegmentRecord> = {}): SessionSegmentRecord {
  return {
    coordinationScopeId: EXEC_SCOPE,
    segmentId: 'segment-1' as SessionSegmentRecord['segmentId'],
    workPackageId: EXEC_WP_A,
    role: 'planner',
    workerTaskId: 'worker-task-1' as WorkerTaskId,
    dispatchId: 'dispatch-1' as SessionSegmentRecord['dispatchId'],
    attemptId: 'attempt-1',
    sessionBindingId: 'binding-1',
    lastTranscriptRef: 'transcript:1',
    terminalReceiptRef: null,
    transcriptReferenceable: true,
    verifiable: true,
    recordedAt: 1,
    ...overrides,
  };
}

function snapshotWith(input: {
  readonly segments: readonly SessionSegmentRecord[];
  readonly settlements?: readonly DeliverySettlementRecord[];
  readonly recoveries?: readonly RecoveryRecord[];
}): CoordinationSnapshot {
  return {
    scope: {
      coordinationScopeId: EXEC_SCOPE,
      fullBranchRef: null,
      canonicalWorktreePath: null,
      mode: 'execution_coordination',
      controlState: 'active',
      planningCycleId: null,
      mapRevision: 0,
      graphId: EXEC_GRAPH,
      graphVersion: 1 as GraphVersion,
      authorizationId: EXEC_AUTH,
      authorizationVersion: 1,
      revision: 1,
    },
    sessions: [],
    leases: [],
    executionLease: null,
    ticketClaims: [],
    pendingInteractions: [],
    unresolvedIntents: [],
    settledGitIntegrationIntents: [],
    planningHandoffs: [],
    planningResponsibility: null,
    sessionSegments: [...input.segments],
    materializationBindings: [],
    deliverySettlements: [...(input.settlements ?? [])],
    deliveryVerdicts: [],
    recoveries: [...(input.recoveries ?? [])],
    executionHandoffs: [],
    graphGenerations: [],
    revisionHolds: [],
    baselineReconciliations: [],
    workPackageLineages: [],
    baselineAdoptions: [],
    mutationLanes: [],
    laneReservations: [],
  };
}

function exitedObservations(dispatchId: string): ExecutionObservationFacts {
  return {
    workersEnumerated: true,
    workers: [{ dispatchId, taskId: null, workerState: 'succeeded', terminalState: 'exited' }],
    worktreePaths: new Map(),
    unavailableReasons: [],
    finalizer: null,
  };
}

const INTERRUPT_GRAPH: ExecutionGraph = {
  graphId: EXEC_GRAPH,
  generation: EXEC_GENERATION,
  workPackages: [
    {
      workPackageId: EXEC_WP_A,
      title: 'wp',
      dependsOn: [],
      scopeEnvelope: { include: ['README.md'], exclude: [] },
      budget: {
        implementationAttempts: 1,
        validatorRepairs: 1,
        specificationRevisions: 1,
        graphRevisions: 1,
        integrationReconciliations: 1,
        maxRecoveriesPerWorkerAttempt: 1,
      },
    },
  ],
};

test('已退出且结果未确认的 Worker 不算丢失会话：不触发 Recovery', () => {
  const worker = segment();
  const observations = exitedObservations('dispatch-1');

  // 结果还挂在未确认的 Delivery 上：会话没有丢，结算那条 Delivery 才是正确路径。
  expect(
    interruptedSegmentOf({
      snapshot: snapshotWith({ segments: [worker] }),
      observations,
      graph: INTERRUPT_GRAPH,
      pendingDeliveryDispatchIds: ['dispatch-1'],
    }),
  ).toBeNull();

  // 同一 Segment 在 Delivery 已确认（没有未确认项）时才成为中断候选。
  expect(
    interruptedSegmentOf({
      snapshot: snapshotWith({ segments: [worker] }),
      observations,
      graph: INTERRUPT_GRAPH,
      pendingDeliveryDispatchIds: [],
    })?.segmentId,
  ).toBe('segment-1');
});

/* -------------------------------------------------------------------------- */
/* 已派发但未绑定：补记 Session Binding 的选择规则与签发 helper                    */
/* -------------------------------------------------------------------------- */

function binding(overrides: Partial<MaterializationBindingRecord> = {}): MaterializationBindingRecord {
  return {
    coordinationScopeId: EXEC_SCOPE,
    workPackageId: EXEC_WP_A,
    identity: 'issued',
    role: 'planner',
    recoveryUtilityRole: null,
    workerTaskId: 'worker-task-1' as WorkerTaskId,
    dispatchId: 'dispatch-1' as NonNullable<MaterializationBindingRecord['dispatchId']>,
    attemptId: 'attempt-1',
    worktreeId: 'worktree-1',
    specBinding: null,
    specificationUnitPath: `openspec/changes/${EXEC_WP_A}`,
    authorizationId: EXECUTION_AUTHORIZATION_ID,
    authorizationVersion: 1,
    workerProfileRef: { kind: 'worker-profile', id: 'codex:planner' },
    orcaTaskId: 'task-1',
    launchId: 'worker-launch-1',
    creationOperationId: 'op-1' as OperationId,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

function observedDispatch(input: {
  readonly dispatchId: string;
  readonly taskId: string | null;
  readonly worktreePath?: string;
}): ExecutionObservationFacts {
  return {
    workersEnumerated: true,
    workers: [{ dispatchId: input.dispatchId, taskId: input.taskId, workerState: 'succeeded', terminalState: 'exited' }],
    worktreePaths: new Map(input.worktreePath === undefined ? [] : [[EXEC_WP_A, input.worktreePath]]),
    unavailableReasons: [],
    finalizer: null,
  };
}

test('已派发但未绑定的角色按 Task 匹配 Orca Dispatch，并只在缺 Segment 时入选', () => {
  const segmentIdOf = (orcaDispatchId: string, attemptId: string): string => `segment:${orcaDispatchId}:${attemptId}`;
  const input = {
    graph: INTERRUPT_GRAPH,
    bindings: [binding()],
    observations: observedDispatch({ dispatchId: 'ctx-1', taskId: 'task-1', worktreePath: '/tmp/wt' }),
    segmentIdOf,
  };

  const selected = unboundRoleDispatches({ ...input, segments: [] });
  expect(selected.map((entry) => [entry.orcaDispatchId, entry.segmentId, entry.worktreePath])).toEqual([
    ['ctx-1', 'segment:ctx-1:attempt-1', '/tmp/wt'],
  ]);

  // 已经有 Segment：不再补记。
  expect(
    unboundRoleDispatches({ ...input, segments: [segment({ segmentId: 'segment:ctx-1:attempt-1' as never })] }),
  ).toEqual([]);
  // Recovery 使用独立 Segment ID；真实运行身份已绑定时不重复签发原报告。
  expect(unboundRoleDispatches({
    ...input,
    segments: [segment({ segmentId: 'recovery:replacement-segment' as never, dispatchId: 'ctx-1' as never })],
  })).toEqual([]);
  // 原 Task 的已知 Session 与新观察不一致，不能把原 launch 报告签给替代 Dispatch。
  expect(unboundRoleDispatches({
    ...input,
    observations: observedDispatch({ dispatchId: 'ctx-replacement', taskId: 'task-1', worktreePath: '/tmp/wt' }),
    segments: [segment({ dispatchId: 'ctx-original' as never })],
  })).toEqual([]);
  // 多派发属于同一 Task 时，单个物化 launch 不足以选定实际派发。
  expect(unboundRoleDispatches({
    ...input,
    observations: {
      ...input.observations,
      workers: [...input.observations.workers, {
        dispatchId: 'ctx-replacement', taskId: 'task-1', workerState: 'succeeded', terminalState: 'exited',
      }],
    },
    segments: [],
  })).toEqual([]);
  // 旧行没有 launchId 这项事实：不猜，不补记。
  expect(unboundRoleDispatches({ ...input, bindings: [binding({ launchId: null })], segments: [] })).toEqual([]);
  // Orca 找不到这个 Task（或没列举出 worktree）：等下一次触发，不猜 Dispatch。
  expect(
    unboundRoleDispatches({
      ...input,
      observations: observedDispatch({ dispatchId: 'ctx-2', taskId: 'task-other', worktreePath: '/tmp/wt' }),
      segments: [],
    }),
  ).toEqual([]);
});

test('SessionStart 报告签发 helper：缺报告与缺 transcript 都给出结构化原因，凭有效报告才签发', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-role-binding-'));
  bindingDirectories.push(root);
  const workspace = join(root, 'workspace');
  const codexHome = join(workspace, '.codex');
  const sessions = join(codexHome, 'sessions', '2026', '09', '24');
  mkdirSync(sessions, { recursive: true });
  const sessionId = '01a0d266-a7b6-7e13-b5ab-6a079e6ea564';
  const transcriptPath = join(sessions, `rollout-2026-09-24T15-52-18-${sessionId}.jsonl`);
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: workspace } })}\n`,
    'utf8',
  );
  const reportPath = join(root, 'start-report.jsonl');
  const report = {
    sessionId,
    transcriptPath,
    codexHome,
    cwd: workspace,
    observedAt: '2026-09-24T07:52:20.000Z',
  };
  const facts = {
    harness: 'codex',
    role: 'planner' as const,
    workerTaskId: 'worker-task-1' as WorkerTaskId,
    dispatchId: 'ctx-1' as NonNullable<MaterializationBindingRecord['dispatchId']>,
    attemptId: 'attempt-1',
    workspace,
    expectedCodexHome: codexHome,
    dispatchStartedAt: '2026-09-24T07:52:00.000Z',
  };

  // 报告还没落盘：不阻塞、不猜测。
  expect(await sessionBindingFromStartReport({ reportPath, waitMs: 0, ...facts })).toMatchObject({
    kind: 'unbound',
    code: 'report_absent',
  });

  // 报告在、transcript 不在：结论是 transcript_unavailable，而不是签发一条无法核验的绑定。
  writeFileSync(reportPath, `${JSON.stringify({ ...report, transcriptPath: join(sessions, 'missing.jsonl') })}\n`, 'utf8');
  expect(await sessionBindingFromStartReport({ reportPath, waitMs: 0, ...facts })).toMatchObject({
    kind: 'unbound',
    code: 'transcript_unavailable',
  });

  // 完整事实：签发并给出 provider session 与 transcript 引用。
  writeFileSync(reportPath, `${JSON.stringify(report)}\n`, 'utf8');
  const bound = await sessionBindingFromStartReport({ reportPath, waitMs: 0, ...facts });
  expect(bound).toMatchObject({ kind: 'bound' });
  expect(bound.kind === 'bound' ? bound.binding.providerSessionId : null).toBe(sessionId);
  expect(bound.kind === 'bound' ? bound.binding.transcriptRef : null).toBe(transcriptPath);
});

test('集成源分支取自 Work Package 自己的 worktree，而不是 canonical 分支', () => {
  const worktrees = [
    {
      worktreeId: 'canonical',
      path: '/tmp/canonical',
      branch: 'refs/heads/main',
      head: null,
      displayName: null,
      comment: null,
      isMainWorktree: true,
    },
    {
      worktreeId: 'wp',
      path: '/tmp/wp-a',
      branch: `refs/heads/wp-${EXEC_WP_A}`,
      head: null,
      displayName: null,
      comment: workPackageComment(EXEC_WP_A),
      isMainWorktree: false,
    },
  ];

  // 把 canonical 分支当源分支会让 merge --ff-only 变成自我合并（静默 no-op），因此这里必须取 WP 分支。
  expect(integrationSourceBranchOf(worktrees, EXEC_WP_A)).toBe(`wp-${EXEC_WP_A}`);
  expect(integrationSourceBranchOf([worktrees[0]!], EXEC_WP_A)).toBeNull();
});
