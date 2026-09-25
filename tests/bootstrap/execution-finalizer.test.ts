/**
 * IP-06 的行为测试（change: `m2-wire-execution-runtime`）。
 *
 * 前台宿主在**全部 Work Package 集成完成**后派发一个项目级只读 Finalizer，并在运行前后各读一次
 * canonical 工作区的 Git 事实。这里用临时 Git 仓库 + 真实两个 SQLite store + 注入的 fake Orca
 * 后端固定四类可观察事实：
 *
 * - 门禁满足时：以**新的只读 Codex Session**在 canonical worktree 中派发（状态根与 SessionStart
 *   报告都在 Git common dir 的 Companion 私有目录里），运行前后工作区被比较并进入投影，结论被接受；
 * - 只读无法证明（SessionStart 无法证明）时：只报 blocker，不呈现 deliverable；
 * - 运行期间工作区发生变化时：不接受任何结论，交付保持 blocker；
 * - Finalizer 的结论读不回时：停在 blocker，同样派发一次、不重复派发。
 *
 * 事实层全部走真实路径（真实 store、真实 Git 读取、真实 `finalizeProject`），只有 Orca 后端、
 * tracker 与 provider 集成是 fake。
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  DispatchId,
  GraphGeneration,
  GraphVersion,
  OperationId,
  PlanningCycleId,
  RuntimeIncarnationId,
  WorkerTaskId,
  WorkPackageId,
} from '../../src/application/dto/identity.js';
import type {
  ExecutionBackend,
  ExecutionMutation,
  ExecutionQuery,
} from '../../src/application/ports/execution-backend.js';
import type { SnapshotLoad } from '../../src/interfaces/tui/ports.js';
import type { CoordinationWriter } from '../../src/application/ports/branch-coordination-store.js';
import { beginIntent, settleIntent } from '../../src/application/coordination/intent-service.js';
import { acquireRuntimeLease } from '../../src/application/coordination/lease-service.js';
import { ensureGraphGenerationRecord } from '../../src/application/execution/replanning-service.js';
import { graphIdFor } from '../../src/application/planning/graph-generation.js';
import { recordInitialGraph } from '../../src/application/planning/graph-history.js';
import { initializeCoordinationScope } from '../../src/application/planning/initialize-scope.js';
import type {
  IssueTrackerGateway,
  TrackerReadOutcome,
  TrackerWriteOutcome,
} from '../../src/application/planning/route-map-service.js';
import { openCoordinationStore, type CoordinationStore } from '../../src/adapters/storage/coordination-store.js';
import { openCheckpointStore } from '../../src/adapters/storage/checkpoint-store.js';
import { checkpointDatabasePath } from '../../src/bootstrap/coordinator-runtime.js';
import { canonicalPath, coordinationDatabasePath } from '../../src/bootstrap/composition.js';
import { COORDINATOR_SESSION_STATE_SCHEMA_VERSION } from '../../src/domain/coordinator/session-state.js';
import type { DoctorProbe } from '../../src/bootstrap/doctor.js';
import { createForegroundPlanningHost } from '../../src/bootstrap/foreground-planning-runtime.js';
import { DEFAULT_EXECUTION_LIMITS } from '../../src/domain/planning/budget-policy.js';
import type { ExecutionAuthorizationManifest } from '../../src/domain/planning/execution-authorization.js';
import type { ExecutionGraph } from '../../src/domain/planning/execution-graph.js';
import { CapableChatModel } from '../support/fake-chat-model.js';

const SCOPE = 'scope-finalizer' as CoordinationScopeId;
const SESSION = 'session-finalizer' as CoordinatorSessionId;
const CYCLE = 'cycle-finalizer' as PlanningCycleId;
const INCARNATION = 'incarnation-finalizer' as RuntimeIncarnationId;
const GENERATION = 1 as GraphGeneration;
const GRAPH_ID = graphIdFor(SCOPE, GENERATION);
const RUN_ID = 'run-finalizer';
const AUTH_ID = 'auth-finalizer';
const WP = 'wp-a' as WorkPackageId;
const WORKER_TASK = 'orca-task-finalizer' as WorkerTaskId;
const FINALIZER_TASK = 'finalizer-task-1';
/** 等待触发点结论的时间上界；fake backend 全同步，这里只防「什么都没发生」。 */
const TEST_WAIT_MS = 3_000;
const TEST_TIMEOUT_MS = 20_000;
/** 与生产一致：Finalizer 的 Codex 状态根与 SessionStart 报告都在 Git common dir 的私有目录里。 */
const COMPANION_STATE_DIRECTORY = 'orca-companion';
/** 与生产一致的可接受结论：证据引用必须落在既有权威结果里。 */
const DELIVERABLE_VERDICT = {
  coveredWorkPackageIds: [WP],
  verdict: { kind: 'deliverable', evidenceRefs: ['orca-result:validator'] },
};

/* -------------------------------------------------------------------------- */
/* fake Orca：只读查询 + 记录型 mutation                                        */
/* -------------------------------------------------------------------------- */

type FakeOrca = {
  readonly backend: ExecutionBackend;
  readonly mutations: readonly ExecutionMutation[];
  /** Finalizer 的结论载荷；`null` 表示读不回（未产生或不可读）。 */
  readonly verdict: { value: unknown };
};

function fakeOrca(options?: { readonly workerStartUnknown?: boolean | undefined }): FakeOrca {
  const mutations: ExecutionMutation[] = [];
  const verdict = { value: null as unknown };
  const dispatchId = 'dispatch-finalizer';
  const terminals: { handle: string; title: string }[] = [];
  /** 从 task-create 的 spec 里读回 Controller 签发的身份：结论载荷按它配对。 */
  const envelope = { workerTaskId: '' };
  return {
    mutations,
    verdict,
    backend: {
      query: (input: ExecutionQuery) => {
        switch (input.operation) {
          case 'run-current':
            return Promise.resolve({
              kind: 'accepted' as const,
              value: { run: { runId: RUN_ID, consumerGeneration: 1 } },
            });
          case 'worktree-list':
            return Promise.resolve({
              kind: 'accepted' as const,
              value: { worktrees: [], totalCount: 0, truncated: false, hostScope: null },
            });
          case 'worker-list':
            // worker-start 结果未知时，Orca 的列举事实是唯一能证明副作用的来源。
            return Promise.resolve({
              kind: 'accepted' as const,
              value: {
                workers:
                  options?.workerStartUnknown === true
                    ? [{ taskId: FINALIZER_TASK, dispatchId, state: 'live' }]
                    : [],
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
              value:
                verdict.value === null
                  ? { delivery: null, messages: [], timedOut: false, cancelled: false }
                  : {
                      delivery: { deliveryId: 'delivery-finalizer', runId: RUN_ID },
                      messages: [
                        {
                          messageId: 'message-finalizer',
                          fromHandle: dispatchId,
                          runId: null,
                          payload: JSON.stringify({
                            workerTaskId: envelope.workerTaskId,
                            result: verdict.value,
                          }),
                        },
                      ],
                      timedOut: false,
                      cancelled: false,
                    },
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
        if (input.operation === 'task-create') {
          const parsed = JSON.parse(input.spec ?? '{}') as { readonly workerTaskId?: unknown };
          envelope.workerTaskId = typeof parsed.workerTaskId === 'string' ? parsed.workerTaskId : '';
          return accepted({ id: FINALIZER_TASK, spec: input.spec ?? '' });
        }
        if (input.operation === 'terminal-create') {
          terminals.push({ handle: 'terminal-finalizer', title: input.title ?? '' });
          return accepted({ handle: 'terminal-finalizer' });
        }
        if (input.operation === 'worker-start') {
          if (options?.workerStartUnknown === true) {
            // 传输失败：没有回执，只能靠事实对账。
            return Promise.resolve({
              kind: 'unknown' as const,
              operation: { operationId: scope.operationId, target: scope.target },
              reason: 'worker-start 响应丢失',
            });
          }
          return accepted({ taskId: input.taskId, dispatchId, state: 'ready' });
        }
        return accepted(null);
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
  readonly fake: FakeOrca;
  readonly dispose: () => void;
};

const created: Harness[] = [];

afterEach(() => {
  for (const harness of created.splice(0)) {
    harness.dispose();
    rmSync(harness.directory, { recursive: true, force: true });
  }
});

/** 一份可核验的 fixture：项目配置、唯一的 active OpenSpec change 与干净的工作区。 */
function prepareRepository(directory: string): { readonly repository: string; readonly head: string } {
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
      schemaVersion: 1,
      coordinatorModels: [
        {
          configurationRef: 'planning-default',
          providerIntegration: '@fake/provider#CapableChatModel',
          model: 'fake-coordinator',
          modelOptions: {},
          credentialRefs: ['fake'],
          nativeWindowOwnerRef: null,
        },
      ],
      defaultCoordinatorModelRef: 'planning-default',
      tracker: { kind: 'github', routeMapIssueNumber: 7 },
      planning: { maxMutations: 2 },
      context: { maxInputTokens: 20_000 },
      execution: {
        harness: 'codex',
        workerModel: 'minimax-cn/MiniMax-M3',
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
  mkdirSync(join(change, 'specs', 'demo'), { recursive: true });
  writeFileSync(join(change, 'proposal.md'), '# Proposal\n\n## Impact\n\n- `src/a.ts`\n');
  writeFileSync(join(change, 'tasks.md'), '- [ ] 1.1 做点事\n');
  writeFileSync(join(change, 'design.md'), '# Design\n');
  writeFileSync(join(change, 'specs', 'demo', 'spec.md'), '### Requirement: 甲\n');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  return { repository, head: git('rev-parse', 'HEAD') };
}

function manifestFor(head: string, repository: string): ExecutionAuthorizationManifest {
  return {
    manifestVersion: 1,
    coordinationScopeId: SCOPE,
    planningCycleId: CYCLE,
    destinationRef: { kind: 'destination', id: 'dest-1', version: 1 },
    routeMapRef: { kind: 'route-map', id: '7', version: 1 },
    implementationPlanRef: { kind: 'implementation-plan', id: 'plan-1', version: 1 },
    graph: { graphId: GRAPH_ID, generation: GENERATION, version: 1 as GraphVersion },
    baselineHead: head,
    orcaRunId: RUN_ID,
    workerProfiles: [
      { profileRef: { kind: 'worker-profile', id: 'codex:planner' }, role: 'planner', harness: 'codex' },
      { profileRef: { kind: 'worker-profile', id: 'codex:implementation' }, role: 'implementation', harness: 'codex' },
      { profileRef: { kind: 'worker-profile', id: 'codex:validator' }, role: 'validator', harness: 'codex' },
      { profileRef: { kind: 'worker-profile', id: 'codex:finalizer' }, role: 'finalizer', harness: 'codex' },
    ],
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
}

/**
 * 现场：图、世代与 Run 已绑定，授权已批准，Scope 已进入执行协调态，且 wp-a 的三角色结果与集成
 * Operation 都已接受——Finalizer 门禁因此满足。
 */
function prepareExecutionState(repository: string, head: string): void {
  const opened = openCoordinationStore({
    databasePath: coordinationDatabasePath(join(repository, '.git')),
    clock: () => 1_000,
  });
  if (opened.kind !== 'opened') {
    throw new Error(opened.message);
  }
  const store: CoordinationStore = opened.store;
  try {
    const initialized = initializeCoordinationScope({
      store,
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
    const acquired = acquireRuntimeLease(store, {
      coordinationScopeId: SCOPE,
      coordinatorSessionId: SESSION,
      runtimeIncarnationId: INCARNATION,
      fencingGeneration: 0,
    });
    if (acquired.kind !== 'acquired') {
      throw new Error('无法取得 Runtime Lease');
    }
    const writer: CoordinationWriter = {
      coordinatorSessionId: SESSION,
      runtimeIncarnationId: INCARNATION,
      fencingGeneration: acquired.lease.fencingGeneration,
    };
    const graph: ExecutionGraph = {
      graphId: GRAPH_ID,
      generation: GENERATION,
      concurrencyLimit: DEFAULT_EXECUTION_LIMITS.concurrencyLimit,
      workPackages: [
        {
          workPackageId: WP,
          title: '唯一的工作包',
          dependsOn: [],
          scopeEnvelope: { include: ['src'], exclude: [] },
          budget: {
            implementationAttempts: DEFAULT_EXECUTION_LIMITS.implementationAttempts,
            validatorRepairs: DEFAULT_EXECUTION_LIMITS.validatorRepairs,
            graphRevisions: DEFAULT_EXECUTION_LIMITS.graphRevisions,
            specificationRevisions: DEFAULT_EXECUTION_LIMITS.specificationRevisions,
            maxRecoveriesPerWorkerAttempt: DEFAULT_EXECUTION_LIMITS.maxRecoveriesPerWorkerAttempt,
          },
        },
      ],
    };
    const recorded = recordInitialGraph({
      store,
      coordinationScopeId: SCOPE,
      writer,
      graph,
      mapRevision: 1,
      planRevision: 1,
      orcaRunId: RUN_ID,
    });
    if (recorded.kind !== 'recorded') {
      throw new Error(`无法记录初始图：${recorded.failure.message}`);
    }
    const ensured = ensureGraphGenerationRecord({
      store,
      coordinationScopeId: SCOPE,
      writer,
      graphId: GRAPH_ID,
      generation: GENERATION,
      planningCycleId: CYCLE,
      orcaRunId: RUN_ID,
      predecessorGraphId: null,
      baselineHead: head,
    });
    if (ensured.kind !== 'recorded') {
      throw new Error('无法记录世代');
    }
    const revision = (): number => {
      const read = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
      if (read.kind !== 'scope' || read.scope === null) {
        throw new Error('Scope 不存在');
      }
      return read.scope.revision;
    };
    const authorized = store.transact({
      kind: 'record-authorization',
      coordinationScopeId: SCOPE,
      expectedRevision: revision(),
      writer,
      authorizationId: AUTH_ID,
      authorizationVersion: 1,
      manifestVersion: 1,
      fingerprint: 'fingerprint-finalizer',
      approvalRef: 'approval-finalizer',
      manifest: manifestFor(head, repository),
    });
    if (authorized.kind === 'rejected') {
      throw new Error(`无法记录授权：${authorized.message}`);
    }
    const transitioned = store.transact({
      kind: 'transition-to-execution',
      coordinationScopeId: SCOPE,
      expectedRevision: revision(),
      writer,
      planningCycleId: CYCLE,
      graphId: GRAPH_ID,
      graphVersion: 1 as GraphVersion,
      authorizationId: AUTH_ID,
      authorizationVersion: 1,
    });
    if (transitioned.kind === 'rejected') {
      throw new Error(`无法进入执行协调态：${transitioned.message}`);
    }
    for (const role of ['planner', 'implementation', 'validator'] as const) {
      const settled = store.transact({
        kind: 'record-delivery-settlement',
        coordinationScopeId: SCOPE,
        expectedRevision: revision(),
        writer,
        dedupeKey: `${role}:${WORKER_TASK}`,
        deliveryId: `delivery:${role}`,
        runId: RUN_ID,
        consumerGeneration: 1,
        workerTaskId: WORKER_TASK,
        dispatchId: `dispatch:${role}` as DispatchId,
        attemptId: `attempt:${role}`,
        role,
        contractRevision: 1,
        orcaResultRef: `orca-result:${role}`,
      });
      if (settled.kind === 'rejected') {
        throw new Error(`无法记录 ${role} 结算：${settled.message}`);
      }
    }
    const bound = store.transact({
      kind: 'record-materialization-binding',
      coordinationScopeId: SCOPE,
      expectedRevision: revision(),
      writer,
      workPackageId: WP,
      role: 'validator',
      workerTaskId: WORKER_TASK,
      dispatchId: `dispatch:validator` as DispatchId,
      attemptId: `attempt:validator`,
      worktreeId: 'worktree-finalizer',
      specBinding: {
        provider: 'openspec',
        relativePath: 'openspec/changes/demo',
        contentDigest: 'digest-finalizer',
        providerVersion: '0.4.0',
        contractRevision: 1,
        trackingRevision: 1,
      },
      specificationUnitPath: null,
      orcaTaskId: WORKER_TASK,
      creationOperationId: 'op:materialize-task' as OperationId,
      launchId: 'launch-finalizer',
    });
    if (bound.kind === 'rejected') {
      throw new Error(`无法记录物化绑定：${bound.message}`);
    }
    // 已完成的集成 Operation：Finalizer 的前置事实是「全部 Work Package 已完成集成」。
    const integrationOperationId = 'op:integration-push' as OperationId;
    const begun = beginIntent(store, {
      coordinationScopeId: SCOPE,
      operationId: integrationOperationId,
      target: { kind: 'work-package', id: WP },
      operationCategory: 'git-integration',
      expectedHead: head,
      writer,
      expectedRevision: revision(),
    });
    if (begun.kind !== 'registered') {
      throw new Error(`无法登记集成意图：${begun.kind}`);
    }
    const integrationSettled = settleIntent(store, {
      coordinationScopeId: SCOPE,
      operationId: integrationOperationId,
      writer,
      expectedRevision: revision(),
      outcome: {
        kind: 'accepted',
        operation: { operationId: integrationOperationId, target: { kind: 'work-package', id: WP } },
        value: { kind: 'pushed' },
      },
    });
    if (integrationSettled.kind !== 'settled') {
      throw new Error(`无法收尾集成意图：${integrationSettled.kind}`);
    }
    // 现场准备完毕后结束上一个 incarnation：宿主会取得自己的 Runtime Lease。
    // 「这个 Session 运行过」因此需要一份可读回的 checkpoint，否则会话不可恢复。
    const checkpoints = openCheckpointStore({
      databasePath: checkpointDatabasePath(join(repository, '.git')),
      clock: () => 1_000,
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
    const released = store.transact({
      kind: 'release-runtime-lease',
      coordinationScopeId: SCOPE,
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
  return {
    readIssue: (): Promise<TrackerReadOutcome> =>
      Promise.resolve({
        kind: 'read',
        issue: {
          ref: { kind: 'route-map', id: '7' },
          title: 'Route Map',
          body: '## Destination\n目的地\n## Open Decision Tickets\n## Fog\n',
          state: 'open',
          assignees: [],
        },
      }),
    updateIssueBody: (): Promise<TrackerWriteOutcome> => Promise.resolve({ kind: 'accepted' }),
    assignIssue: (): Promise<TrackerWriteOutcome> => Promise.resolve({ kind: 'accepted' }),
  };
}

/**
 * 按生产路径写出 SessionStart 报告：Codex 的状态根在 Git common dir 的 Companion 私有目录里，
 * 报告指向该状态根下 sessions 目录中的 rollout 文件，首条记录是 `session_meta`。
 */
function writeSessionStartReport(repository: string): void {
  const root = join(repository, '.git', COMPANION_STATE_DIRECTORY, 'codex');
  const stateRoot = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .sort()[0];
  if (stateRoot === undefined) {
    throw new Error('Finalizer 的 Codex 状态根不存在');
  }
  const sessionId = 'session-finalizer-codex';
  const sessionsDir = join(stateRoot, 'sessions', '2026', '09', '23');
  mkdirSync(sessionsDir, { recursive: true });
  const transcriptPath = join(sessionsDir, `rollout-2026-09-23T00-00-00-${sessionId}.jsonl`);
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: canonicalPath(repository) } })}\n`,
    'utf8',
  );
  writeFileSync(
    join(root, 'session-start.jsonl'),
    `${JSON.stringify({
      sessionId,
      transcriptPath,
      codexHome: stateRoot,
      cwd: canonicalPath(repository),
      observedAt: new Date().toISOString(),
    })}\n`,
    'utf8',
  );
}

async function openHarness(options?: {
  readonly reportSessionStart?: boolean;
  readonly verdict?: unknown;
  readonly driftOnDispatch?: (repository: string) => void;
  readonly sessionBindingWindowMs?: number;
  /** 让 worker-start 只返回 unknown，验证宿主用 Orca 事实而不是回执完成对账。 */
  readonly workerStartUnknown?: boolean | undefined;
}): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), 'orca-finalizer-'));
  const { repository, head } = prepareRepository(directory);
  prepareExecutionState(repository, head);
  const fake = fakeOrca({ workerStartUnknown: options?.workerStartUnknown });
  const verdict = options?.verdict;
  const drift = options?.driftOnDispatch;
  const reportSessionStart = options?.reportSessionStart ?? true;
  const raw = fake.backend.mutate.bind(fake.backend);
  fake.backend.mutate = (input, scope) => {
    // 副作用发生在 Finalizer 的 Session 启动之后：报告、结论与（可能注入的）工作区变化都在这里产生。
    if (input.operation === 'worker-start') {
      if (reportSessionStart) {
        writeSessionStartReport(repository);
      }
      if (verdict !== undefined) {
        fake.verdict.value = verdict;
      }
      drift?.(repository);
    }
    return raw(input, scope);
  };
  const host = await createForegroundPlanningHost({
    repositoryPath: repository,
    env: process.env as Record<string, string>,
    clock: () => 1_000,
    newId: (() => {
      let counter = 0;
      return () => `id-${String((counter += 1))}`;
    })(),
    heartbeatIntervalMs: 1_000,
    leaseTtlMs: 60_000,
    sessionBindingWindowMs: options?.sessionBindingWindowMs ?? 200,
    orcaProbe: fakeProbe(),
    trackerFactory: fakeTracker,
    loadIntegration: () => Promise.resolve({ CapableChatModel }),
    executionBackend: fake.backend,
  });
  expect(await host.ports.scopeSetup.resolveHome()).toEqual({ kind: 'restore', coordinationScopeId: SCOPE });
  let disposed = false;
  const harness: Harness = {
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
  created.push(harness);
  return harness;
}

/** 一条用户消息就是一次宿主命令：它触发一次执行推进（同一个 Session 上串行）。 */
async function sendMessage(harness: Harness, content: string): Promise<void> {
  const result = await harness.host.ports.execute({
    kind: 'send-session-message',
    coordinatorSessionId: SESSION,
    content,
  });
  if (result.kind !== 'accepted') {
    throw new Error(`send-session-message 被拒绝：${JSON.stringify(result)}`);
  }
}

/** 等一次触发点把它的结论落到可观察状态上；等待真实信号，不猜时长。 */
async function waitFor(assertion: () => void): Promise<void> {
  await vi.waitFor(assertion, { timeout: TEST_WAIT_MS, interval: 25 });
}

function workerStarts(harness: Harness): number {
  return harness.fake.mutations.filter((mutation) => mutation.operation === 'worker-start').length;
}

/* -------------------------------------------------------------------------- */
/* 测试                                                                        */
/* -------------------------------------------------------------------------- */

/** 读快照并等到断言成立；断言失败时把当时的事实一起抛出来，避免只剩一句超时。 */
async function waitForSnapshot(
  harness: Harness,
  assertion: (snapshot: SnapshotLoad) => void,
): Promise<SnapshotLoad> {
  const state: { value: SnapshotLoad | null } = { value: null };
  try {
    await vi.waitFor(async () => {
      const read = await harness.host.ports.snapshot(SESSION);
      state.value = read;
      assertion(read);
    }, { timeout: TEST_WAIT_MS, interval: 25 });
  } catch (error) {
    const seen = state.value;
    if (seen !== null && seen.kind === 'snapshot') {
      // 失败时把当时的事实一并抛出：断言之外的信息（blocker、Finalizer 观察）比一句超时有用。
      throw new Error(
        `${String(error)}；当时的事实：${JSON.stringify({
          blockers: seen.snapshot.blockers,
          finalizer: seen.snapshot.finalizer,
        })}`,
        { cause: error },
      );
    }
    throw error;
  }
  const loaded = state.value;
  if (loaded === null) {
    throw new Error('快照应当可读');
  }
  return loaded;
}

test('worker-start 结果未知时：按 Orca 列举事实对账并继续，不把 lane 永久阻塞', { timeout: TEST_TIMEOUT_MS }, async () => {
  // 回执丢失时，Orca 的 worker-list 事实是唯一能证明副作用发生的来源；对账成功就不该留下 blocker。
  const harness = await openHarness({ verdict: DELIVERABLE_VERDICT, workerStartUnknown: true });
  await sendMessage(harness, '开始收尾');
  await waitFor(() => expect(workerStarts(harness)).toBe(1));
  await sendMessage(harness, '继续');

  const snapshot = await waitForSnapshot(harness, (loaded) => {
    expect(loaded.kind === 'snapshot' ? loaded.snapshot.finalizer.verdict?.kind : null).toBe('deliverable');
  });
  if (snapshot.kind !== 'snapshot') {
    throw new Error('快照应当可读');
  }
  expect(snapshot.snapshot.blockers.map((blocker) => blocker.code)).not.toContain('blocked');
});

test('门禁满足时：以新的只读 Session 在 canonical worktree 派发，并比较运行前后的工作区', { timeout: TEST_TIMEOUT_MS }, async () => {
  const harness = await openHarness({ verdict: DELIVERABLE_VERDICT });
  await sendMessage(harness, '开始收尾');
  await waitFor(() => expect(workerStarts(harness)).toBe(1));

  const created = harness.fake.mutations.find((mutation) => mutation.operation === 'task-create');
  const spec = created?.operation === 'task-create' ? (created.spec ?? '') : '';
  expect(spec.includes('workspaceBefore')).toBe(true);
  const terminal = harness.fake.mutations.find((mutation) => mutation.operation === 'terminal-create');
  const command = terminal?.operation === 'terminal-create' ? (terminal.command ?? '') : '';
  // 只读语义由 profile 保证（继承 `:read-only`），后端用 landlock 以便本机控制通道可用。
  expect(command.includes('--profile utility-readonly-local-control')).toBe(true);
  expect(command.includes('--enable use_legacy_landlock')).toBe(true);

  // 完成路径由下一个触发点接上：读回结论 → 读运行后工作区 → 比较 → 接受 verdict。
  await sendMessage(harness, '继续');
  const snapshot = await waitForSnapshot(harness, (loaded) => {
    expect(loaded.kind === 'snapshot' ? loaded.snapshot.finalizer.verdict?.kind : null).toBe('deliverable');
  });
  if (snapshot.kind !== 'snapshot') {
    throw new Error('快照应当可读');
  }
  const finalizer = snapshot.snapshot.finalizer;
  expect(finalizer.readOnlyProfile).toBe('enforced');
  expect(finalizer.gate.ready).toBe(true);
  expect(finalizer.workspace).toEqual({
    before: finalizer.workspace?.after,
    after: finalizer.workspace?.after,
  });
  // 只派发一次：第二个触发点只读回结论，不产生第二次 Task。
  expect(harness.fake.mutations.filter((mutation) => mutation.operation === 'task-create')).toHaveLength(1);
});

test('只读无法证明：停在 blocker，不呈现 deliverable', { timeout: TEST_TIMEOUT_MS }, async () => {
  const harness = await openHarness({ reportSessionStart: false, verdict: DELIVERABLE_VERDICT });
  await sendMessage(harness, '开始收尾');
  await waitFor(() =>
    expect(harness.fake.mutations.some((mutation) => mutation.operation === 'worker-start')).toBe(true),
  );
  await sendMessage(harness, '继续');

  const snapshot = await waitForSnapshot(harness, (loaded) => {
    expect(
      loaded.kind === 'snapshot' ? loaded.snapshot.blockers.map((blocker) => blocker.code) : [],
    ).toContain('finalizer_read_only_unverifiable');
  });
  if (snapshot.kind !== 'snapshot') {
    throw new Error('快照应当可读');
  }
  expect(snapshot.snapshot.finalizer.verdict).toBeNull();
  expect(snapshot.snapshot.finalizer.readOnlyProfile).not.toBe('enforced');
});

test('运行期间工作区发生变化：不接受结论，交付保持 blocker', { timeout: TEST_TIMEOUT_MS }, async () => {
  const harness = await openHarness({
    verdict: DELIVERABLE_VERDICT,
    driftOnDispatch: (repository) => {
      writeFileSync(join(repository, 'drift.txt'), 'changed during finalizer run\n');
    },
  });
  await sendMessage(harness, '开始收尾');
  await waitFor(() => expect(workerStarts(harness)).toBe(1));
  await sendMessage(harness, '继续');

  const snapshot = await waitForSnapshot(harness, (loaded) => {
    expect(
      loaded.kind === 'snapshot' ? loaded.snapshot.blockers.map((blocker) => blocker.code) : [],
    ).toContain('finalizer_workspace_changed');
  });
  if (snapshot.kind !== 'snapshot') {
    throw new Error('快照应当可读');
  }
  expect(snapshot.snapshot.finalizer.verdict).toBeNull();
  expect(snapshot.snapshot.finalizer.workspace).not.toBeNull();
  expect(snapshot.snapshot.finalizer.workspace?.before).not.toEqual(snapshot.snapshot.finalizer.workspace?.after);
});

test('Finalizer 结论读不回：停在 blocker，且不重复派发', { timeout: TEST_TIMEOUT_MS }, async () => {
  const harness = await openHarness({});
  await sendMessage(harness, '开始收尾');
  await waitFor(() => expect(workerStarts(harness)).toBe(1));
  await sendMessage(harness, '继续');
  await sendMessage(harness, '再继续');

  const snapshot = await waitForSnapshot(harness, () => {
    expect(harness.fake.mutations.filter((mutation) => mutation.operation === 'worker-start')).toHaveLength(1);
  });
  if (snapshot.kind !== 'snapshot') {
    throw new Error('快照应当可读');
  }
  expect(snapshot.snapshot.finalizer.verdict).toBeNull();
});
