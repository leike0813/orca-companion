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
import { dirname, join } from 'node:path';

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
import { integrationOperationIdsFor } from '../../src/application/integrate-work-package.js';
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
import { CODEX_MODEL_LAUNCHER_FILENAME } from '../../src/adapters/agents/codex-model-launcher.js';
import { checkpointDatabasePath } from '../../src/bootstrap/coordinator-runtime.js';
import { executionWorkerProfiles } from '../support/execution-harness.js';
import { implementationPlanFor } from '../support/graph-plan-fixture.js';
import {
  coordinatorConfigurationFixture,
  credentialFixtureEnvironment,
  projectConnectionsFixture,
  projectExecutionProfilesFixture,
  recoveryUtilityProfileFixture,
} from '../support/model-configurations.js';
import { canonicalPath, coordinationDatabasePath } from '../../src/bootstrap/composition.js';
import { COORDINATOR_SESSION_STATE_SCHEMA_VERSION } from '../../src/domain/coordinator/session-state.js';
import type { DoctorProbe } from '../../src/bootstrap/doctor.js';
import { createForegroundPlanningHost } from '../../src/bootstrap/foreground-planning-runtime.js';
import { DEFAULT_EXECUTION_LIMITS } from '../../src/domain/planning/budget-policy.js';
import type { ExecutionAuthorizationManifest } from '../../src/domain/planning/execution-authorization.js';
import type { ExecutionGraph } from '../../src/domain/planning/execution-graph.js';
import { CapableChatModel } from '../support/fake-chat-model.js';
import {
  fixedReadOnlyWorkerProbe,
  READ_ONLY_WORKER_AVAILABLE,
  READ_ONLY_WORKER_UNAVAILABLE,
} from '../support/read-only-worker-probe.js';
import type { ReadOnlyWorkerProbe } from '../../src/adapters/agents/codex-read-only-probe.js';

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
// CPU 争用（并行跑整套测试时）下真实 Git/SQLite 装置会更慢：给足 30s 而不是刚好 20s。
const TEST_TIMEOUT_MS = 30_000;
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
  /** task-update 写入、task-list 回读的 Orca Task 记录。 */
  readonly task: { readonly status: string | null; readonly result: unknown };
  /** 真实建立的 Finalizer worktree（baseBranch 即准入基线，comment 是 `finalizerTaskId=<workerTaskId>`）。 */
  readonly worktrees: readonly {
    readonly worktreeId: string;
    readonly path: string;
    readonly branch: string;
    readonly comment: string | null;
  }[];
};

function fakeOrca(options: {
  readonly canonicalWorktreePath: string;
  /** 独立 worktree 的宿主目录；`git worktree add` 在这里建立真实工作树。 */
  readonly worktreeRoot: string;
  readonly workerStartUnknown?: boolean | undefined;
  readonly rejectedLifecycleFirst?: boolean | undefined;
}): FakeOrca {
  const mutations: ExecutionMutation[] = [];
  const verdict = { value: null as unknown };
  const dispatchId = 'dispatch-finalizer';
  const terminals: { handle: string; title: string }[] = [];
  /** task-update 写入的 Orca Task 记录；task-list 是它的回读事实。 */
  const task = { status: null as string | null, result: undefined as unknown };
  /** delivery-ack 之后未确认批次里不再有这条 Delivery。 */
  const acked = { value: false };
  const extraWorktrees: { worktreeId: string; path: string; branch: string; comment: string | null }[] = [];
  const headOf = (path: string): string | null => {
    try {
      return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path, encoding: 'utf8' }).trim();
    } catch {
      return null;
    }
  };
  return {
    mutations,
    verdict,
    task,
    worktrees: extraWorktrees,
    backend: {
      query: (input: ExecutionQuery) => {
        switch (input.operation) {
          case 'run-current':
            return Promise.resolve({
              kind: 'accepted' as const,
              value: { run: { runId: RUN_ID, consumerGeneration: 1 } },
            });
          case 'worktree-list':
            // canonical worktree 身份用于项目级 Finalizer 的物化绑定：必须真的列举出来，否则绑定不可核验。
            return Promise.resolve({
              kind: 'accepted' as const,
              value: {
                worktrees: [
                  {
                    worktreeId: 'worktree-canonical',
                    path: options.canonicalWorktreePath,
                    branch: 'main',
                    head: null,
                    displayName: null,
                    comment: null,
                    isMainWorktree: true,
                  },
                  ...extraWorktrees.map((worktree) => ({
                    worktreeId: worktree.worktreeId,
                    path: worktree.path,
                    branch: worktree.branch,
                    head: headOf(worktree.path),
                    displayName: null,
                    comment: worktree.comment,
                    isMainWorktree: false,
                  })),
                ],
                totalCount: 1 + extraWorktrees.length,
                truncated: false,
                hostScope: { hostIds: ['host-local'], omittedHostIds: [] },
              },
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
              value: (() => {
                if (verdict.value === null || acked.value) {
                  return { delivery: null, messages: [], timedOut: false, cancelled: false };
                }
                // 真实 Codex Worker 的 Orca 原生形状：payload 只有宿主可核验的 Task/Dispatch 传输身份，
                // 结论 JSON 在 body。发送者 handle 是该 Dispatch 的 terminal，由 worker-show 核验。
                const body = typeof verdict.value === 'string' ? verdict.value : JSON.stringify(verdict.value);
                return {
                  delivery: { deliveryId: 'delivery-finalizer', runId: RUN_ID },
                  messages: [
                    ...(options?.rejectedLifecycleFirst === true ? [{
                      messageId: 'message-finalizer-rejected',
                      type: 'worker_done',
                      fromHandle: 'terminal-finalizer',
                      runId: null,
                      payload: JSON.stringify({ taskId: FINALIZER_TASK, dispatchId, outcome: 'succeeded',
                        _orcaLifecycleRejection: { code: 'dispatch_capability_invalid', reason: 'wrong pane' } }),
                      body: 'Orca rejected this worker_done',
                    }] : []),
                    {
                      messageId: 'message-finalizer',
                      type: 'worker_done',
                      fromHandle: 'terminal-finalizer',
                      runId: null,
                      payload: JSON.stringify({ taskId: FINALIZER_TASK, dispatchId, outcome: 'succeeded' }),
                      body,
                    },
                  ],
                  timedOut: false,
                  cancelled: false,
                };
              })(),
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
            return Promise.resolve({ kind: 'accepted' as const, value: { wait: { handle: input.terminal, condition: 'tui-idle', status: 'running', satisfied: true } } });
          case 'terminal-read':
            return Promise.resolve({ kind: 'accepted' as const, value: { terminal: { draft: '' } } });
          case 'worker-show':
            return Promise.resolve({
              kind: 'accepted' as const,
              value: {
                exactWorker: true,
                dispatchId,
                taskId: FINALIZER_TASK,
                agentTerminalHandle: terminals[0]?.handle ?? null,
              },
            });
          case 'task-list':
            // Orca 记录结果后的回读事实：status=completed 且 result 与写入一致，结算才可被接受。
            return Promise.resolve({
              kind: 'accepted' as const,
              value: {
                tasks: task.status === null
                  ? []
                  : [{ id: FINALIZER_TASK, status: task.status, result: task.result }],
              },
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
          return accepted({ id: FINALIZER_TASK, spec: input.spec ?? '' });
        }
        if (input.operation === 'task-update') {
          task.status = input.status;
          task.result = input.result;
          return accepted({ ok: true });
        }
        if (input.operation === 'delivery-ack') {
          acked.value = true;
          return accepted({ ok: true });
        }
        if (input.operation === 'terminal-create') {
          terminals.push({ handle: 'terminal-finalizer', title: input.title ?? '' });
          return accepted({ handle: 'terminal-finalizer' });
        }
        if (input.operation === 'worktree-create') {
          // 真实建立工作树：可写 Finalizer 的修复提交与集成必须是真实的 Git 事实。
          const branch = input.name;
          const path = join(options.worktreeRoot, branch);
          execFileSync('git', ['worktree', 'add', '-q', '-b', branch, path, input.baseBranch ?? 'main'], {
            cwd: options.canonicalWorktreePath,
            encoding: 'utf8',
          });
          const worktreeId = `worktree-${branch}`;
          extraWorktrees.push({ worktreeId, path, branch: `refs/heads/${branch}`, comment: input.comment ?? null });
          return accepted({ worktreeId });
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

/**
 * 一份可核验的 fixture：项目配置、唯一的 active OpenSpec change、干净的 canonical 工作区，
 * 以及一个真实 bare `origin`（可写 Finalizer 的受控集成要真的 push 到它）。
 */
function prepareRepository(directory: string): { readonly repository: string; readonly head: string } {
  const repository = join(directory, 'repo');
  const origin = join(directory, 'origin.git');
  mkdirSync(repository);
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '--bare', origin], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Verification');
  git('config', 'user.email', 'verification@example.invalid');
  git('remote', 'add', 'origin', origin);
  // 复验会生成 ignored 测试产物：它必须真的落在 .gitignore 里，否则「干净工作区」核验会失败。
  writeFileSync(join(repository, '.gitignore'), 'coverage/\n');
  writeFileSync(join(repository, 'README.md'), '# repo\n');
  writeFileSync(
    join(repository, 'orca-companion.json'),
    JSON.stringify({
      schemaVersion: 5,
      coordinatorModels: [coordinatorConfigurationFixture('planning-default')],
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
  mkdirSync(join(change, 'specs', 'demo'), { recursive: true });
  writeFileSync(join(change, 'proposal.md'), '# Proposal\n\n## Impact\n\n- `src/a.ts`\n');
  writeFileSync(join(change, 'tasks.md'), '- [ ] 1.1 做点事\n');
  writeFileSync(join(change, 'design.md'), '# Design\n');
  writeFileSync(join(change, 'specs', 'demo', 'spec.md'), '### Requirement: 甲\n');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  git('push', '-q', '-u', 'origin', 'main');
  return { repository, head: git('rev-parse', 'HEAD') };
}

/** 可写 Finalizer 用显式 v5 `finalizerPolicy`：修复额度 1、权限模式 repair。 */
function manifestFor(
  head: string,
  repository: string,
  options?: { readonly repair?: boolean },
): ExecutionAuthorizationManifest {
  const repair = options?.repair === true;
  return {
    manifestVersion: repair ? 5 : 4,
    coordinationScopeId: SCOPE,
    planningCycleId: CYCLE,
    destinationRef: { kind: 'destination', id: 'dest-1', version: 1 },
    routeMapRef: { kind: 'route-map', id: '7', version: 1 },
    implementationPlanRef: { kind: 'implementation-plan', id: 'plan-1', version: 1 },
    graph: { graphId: GRAPH_ID, generation: GENERATION, version: 1 as GraphVersion },
    baselineHead: head,
    orcaRunId: RUN_ID,
    workerProfiles: [
      ...executionWorkerProfiles(),
    ],
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
    ...(repair ? { finalizerPolicy: { mode: 'repair' as const, repairLimit: 1 } } : {}),
  };
}

/**
 * 现场：图、世代与 Run 已绑定，授权已批准，Scope 已进入执行协调态，且 wp-a 的三角色结果与集成
 * Operation 都已接受——Finalizer 门禁因此满足。
 */
function prepareExecutionState(repository: string, head: string, options?: { readonly repair?: boolean }): void {
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
            integrationReconciliations: DEFAULT_EXECUTION_LIMITS.integrationReconciliations,
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
      initialPlan: implementationPlanFor(graph, 1),
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
      manifestVersion: options?.repair === true ? 5 : 4,
      fingerprint: 'fingerprint-finalizer',
      approvalRef: 'approval-finalizer',
      manifest: manifestFor(head, repository, options),
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
        // 成功 fixture：新契约下角色结论必须显式成功，才构成已接受角色成果。
        outcome: 'succeeded',
        ...(role === 'validator' ? { validationVerdict: 'passed' as const } : {}),
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
      authorizationId: 'auth-finalizer',
      authorizationVersion: 1,
      workerProfileRef: 'profile-validator',
      orcaTaskId: WORKER_TASK,
      creationOperationId: 'op:materialize-task' as OperationId,
      launchId: 'launch-finalizer',
    });
    if (bound.kind === 'rejected') {
      throw new Error(`无法记录物化绑定：${bound.message}`);
    }
    // 已完成的集成 Operation：Finalizer 的前置事实是「全部 Work Package 已完成集成」。
    const integrationOperationId = integrationOperationIdsFor({
      scopeId: SCOPE, graphId: GRAPH_ID, generation: GENERATION, workPackageId: WP,
    }).push;
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
 * 原生会话位于用户状态根；调用生产 reporter 写入 Companion 的精确启动报告。
 */
function writeSessionStartReport(repository: string, workspace: string = canonicalPath(repository)): void {
  const reporters = join(repository, '.git', COMPANION_STATE_DIRECTORY, 'codex', 'reporters');
  const candidates = readdirSync(reporters).filter((name) => name.endsWith('.mjs'));
  if (candidates.length !== 1) throw new Error('Finalizer 的精确 reporter 不唯一');
  const reporterPath = join(reporters, candidates[0]!);
  const stateRoot = join(dirname(repository), 'native-codex');
  const sessionId = 'session-finalizer-codex';
  const sessionsDir = join(stateRoot, 'sessions', '2026', '09', '23');
  mkdirSync(sessionsDir, { recursive: true });
  const transcriptPath = join(sessionsDir, `rollout-2026-09-23T00-00-00-${sessionId}.jsonl`);
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: workspace } })}\n`,
    'utf8',
  );
  execFileSync(process.execPath, [reporterPath], {
    cwd: workspace,
    env: { ...process.env, CODEX_HOME: stateRoot },
    input: JSON.stringify({ session_id: sessionId, transcript_path: transcriptPath, cwd: workspace }),
  });
}

/**
 * 模拟可写 Finalizer 的真实工作：在独立 worktree 里提交授权范围内的修复，跑一次真实 node 复验并生成
 * ignored 产物，然后返回 worker_done 正文里的结论 JSON（含最终 head/tree 与复验命令）。
 *
 * `broken` 制造三类真实失败：修复越出 Scope Envelope、报告旧 HEAD、复验命令失败。
 */
function performRepair(worktreePath: string, broken?: 'scope' | 'head' | 'commands'): Record<string, unknown> {
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: worktreePath, encoding: 'utf8' }).trim();
  const baseline = git('rev-parse', 'HEAD');
  const changedPaths: string[] = ['src/fix.ts'];
  mkdirSync(join(worktreePath, 'src'), { recursive: true });
  writeFileSync(join(worktreePath, 'src', 'fix.ts'), 'export const fixed = true;\n');
  if (broken === 'scope') {
    mkdirSync(join(worktreePath, 'docs'), { recursive: true });
    writeFileSync(join(worktreePath, 'docs', 'out-of-scope.ts'), 'export const outside = true;\n');
    changedPaths.push('docs/out-of-scope.ts');
  }
  git('add', '-A');
  git('commit', '-qm', 'finalizer repair');
  // 真实复验：node 检查修复内容并写入 ignored 的 coverage/ 产物。
  const check = "const fs=require('node:fs');fs.mkdirSync('coverage',{recursive:true});"
    + "const source=fs.readFileSync('src/fix.ts','utf8');"
    + "fs.writeFileSync('coverage/finalizer-check.txt',source.trim());"
    + "if(!source.includes('fixed'))process.exit(1);";
  if (broken === 'commands') {
    // 真正的失败复验：命令必须真的跑起来并非零退出，否则这条用例就没有测失败路径。
    let status = 0;
    try {
      execFileSync(process.execPath, ['-e', 'process.exit(1)'], { cwd: worktreePath, encoding: 'utf8' });
    } catch (error) {
      status = typeof (error as { status?: unknown }).status === 'number' ? (error as { status: number }).status : 1;
    }
    if (status !== 1) throw new Error(`失败复验命令未以 1 退出：${String(status)}`);
  } else {
    execFileSync(process.execPath, ['-e', check], { cwd: worktreePath, encoding: 'utf8' });
  }
  const head = git('rev-parse', 'HEAD');
  const tree = git('rev-parse', 'HEAD^{tree}');
  return {
    coveredWorkPackageIds: [WP],
    verdict: { kind: 'deliverable', evidenceRefs: ['orca-result:validator'] },
    verification: {
      head: broken === 'head' ? baseline : head,
      tree,
      commands: [{
        evidenceId: 'reverify-1',
        kind: 'command',
        coveredPaths: changedPaths,
        command: broken === 'commands' ? 'node -e "process.exit(1)"' : `node -e "${check}"`,
        summary: broken === 'commands' ? '真实复验失败' : '真实复验通过',
        outcome: broken === 'commands' ? 'failed' : 'passed',
      }],
    },
  };
}

async function openHarness(options?: {
  readonly reportSessionStart?: boolean;
  readonly verdict?: unknown;
  readonly driftOnDispatch?: (repository: string) => void;
  readonly sessionBindingWindowMs?: number;
  /** 让 worker-start 只返回 unknown，验证宿主用 Orca 事实而不是回执完成对账。 */
  readonly workerStartUnknown?: boolean | undefined;
  readonly rejectedLifecycleFirst?: boolean;
  /** 本机只读 Worker 能力；默认「可用」，与实际受限命令无关的用例因此不依赖主机沙箱。 */
  readonly readOnlyWorkerProbe?: ReadOnlyWorkerProbe;
  /** 可写 Finalizer（v5 显式 repair policy）；派发时真实提交修复、复验并生成 ignored 产物。 */
  readonly repair?: boolean;
  /** 制造一次真实核验失败：越界修复、报告旧 HEAD、或复验命令失败。 */
  readonly repairCase?: 'scope' | 'head' | 'commands';
}): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), 'orca-finalizer-'));
  const { repository, head } = prepareRepository(directory);
  prepareExecutionState(repository, head, { repair: options?.repair === true });
  const worktreeRoot = join(directory, 'worktrees');
  mkdirSync(worktreeRoot);
  const fake = fakeOrca({ canonicalWorktreePath: canonicalPath(repository), worktreeRoot,
    workerStartUnknown: options?.workerStartUnknown,
    rejectedLifecycleFirst: options?.rejectedLifecycleFirst });
  const verdict = options?.verdict;
  const drift = options?.driftOnDispatch;
  const reportSessionStart = options?.reportSessionStart ?? true;
  const raw = fake.backend.mutate.bind(fake.backend);
  fake.backend.mutate = (input, scope) => {
    // 副作用发生在 Finalizer 的 Session 启动之后：报告、结论与（可能注入的）工作区变化都在这里产生。
    if (input.operation === 'worker-start') {
      // 可写 Finalizer 的真实工作树是它自己的修复提交场所；报告 cwd 必须与之精确一致。
      const repairWorktree = fake.worktrees[0]?.path;
      if (reportSessionStart) {
        writeSessionStartReport(repository, repairWorktree ?? canonicalPath(repository));
      }
      if (options?.repair === true && repairWorktree !== undefined) {
        fake.verdict.value = JSON.stringify(performRepair(repairWorktree, options.repairCase));
      } else if (verdict !== undefined) {
        fake.verdict.value = verdict;
      }
      drift?.(repository);
    }
    return raw(input, scope);
  };
  const host = await createForegroundPlanningHost({
    repositoryPath: repository,
    env: credentialFixtureEnvironment(directory),
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
    loadIntegration: () => Promise.resolve({ ChatOpenAICompletions: CapableChatModel }),
    executionBackend: fake.backend,
    readOnlyWorkerProbe: options?.readOnlyWorkerProbe ?? fixedReadOnlyWorkerProbe(),
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
    submissionId: globalThis.crypto.randomUUID(),
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

/** 只读打开本 Scope 的 Coordination Store，读取耐久事实（不写、不迁移）。 */
function readStore(harness: Harness): CoordinationStore {
  const opened = openCoordinationStore({
    databasePath: coordinationDatabasePath(join(harness.repository, '.git')),
    clock: () => 1_000,
    readOnly: true,
  });
  if (opened.kind !== 'opened') {
    throw new Error(`无法只读打开 Coordination Store：${opened.message}`);
  }
  return opened.store;
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

test('Execution 授权批准重放：按原 fingerprint 只读回读，忽略过期 revision 且不触发派发', async () => {
  const harness = await openHarness();
  const mutationCountBefore = harness.fake.mutations.length;
  const replay = await harness.host.ports.execute({
    kind: 'authorization-approve',
    fingerprint: 'fingerprint-finalizer',
    expectedRevision: 0,
  });

  expect(replay.kind).toBe('accepted');
  expect(harness.fake.mutations).toHaveLength(mutationCountBefore);
});

test('门禁满足时：以新的只读 Session 在 canonical worktree 派发，并比较运行前后的工作区', { timeout: TEST_TIMEOUT_MS }, async () => {
  const harness = await openHarness({ verdict: DELIVERABLE_VERDICT });
  const catalog = await harness.host.ports.modelCatalog.load(SESSION);
  for (const role of catalog.roles ?? []) {
    if (role.current === null) continue;
    if (role.group === 'current') {
      const candidate = role.candidates.find((entry) => entry.candidateRef === role.current?.candidateRef);
      expect(candidate?.model).toBe(role.current.model);
      continue;
    }
    expect(role.current.model).toBe('MiniMax-M3');
    expect(role.candidates).toEqual([]);
    expect(role.availability.reason).toContain('原生模型目录尚未查询');
  }
  await sendMessage(harness, '开始收尾');
  await waitForSnapshot(harness, () => expect(workerStarts(harness)).toBe(1));

  const created = harness.fake.mutations.find((mutation) => mutation.operation === 'task-create');
  const spec = created?.operation === 'task-create' ? (created.spec ?? '') : '';
  expect(spec.includes('workspaceBefore')).toBe(true);
  const terminal = harness.fake.mutations.find((mutation) => mutation.operation === 'terminal-create');
  const command = terminal?.operation === 'terminal-create' ? (terminal.command ?? '') : '';
  // 只读语义由 profile 保证（继承 `:read-only`）；启动参数不再带任何沙箱后端开关。
  expect(command.includes(CODEX_MODEL_LAUNCHER_FILENAME)).toBe(true);
  expect(command.includes('use_legacy_landlock')).toBe(false);

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

  // Orca 侧确实记录了「已接受结果」：task-update 写成的 status=completed 与归一化结果可由 task-list 回读。
  expect(harness.fake.task.status).toBe('completed');
  expect(harness.fake.task.result).toEqual({
    verdict: DELIVERABLE_VERDICT.verdict,
    coveredWorkPackageIds: [WP],
  });

  const store = readStore(harness);
  try {
    // 耐久事实：项目级 Finalizer 的物化绑定与 Delivery 结算都必须落盘，且只在 Orca 结果被接受之后。
    // verdict 与 settlement 是两笔提交：先等结算可见，再断言其余字段，避免读到中间态。
    await waitFor(() => {
      const waitRead = store.query({ kind: 'snapshot', coordinationScopeId: SCOPE });
      expect(waitRead.kind === 'snapshot'
        ? waitRead.snapshot.deliverySettlements.some((entry) => entry.role === 'finalizer')
        : false).toBe(true);
    });
    const read = store.query({ kind: 'snapshot', coordinationScopeId: SCOPE });
    expect(read.kind).toBe('snapshot');
    if (read.kind !== 'snapshot') throw new Error('快照应当可读');
    const binding = read.snapshot.materializationBindings.find((entry) => entry.role === 'finalizer');
    expect(binding?.orcaTaskId).toBe(FINALIZER_TASK);
    expect(String(binding?.workPackageId)).toBe(String(SCOPE));
    expect(binding?.specBinding).toBeNull();
    expect(binding?.specificationUnitPath).toBeNull();
    expect(binding?.authorizationId).toBe(AUTH_ID);
    expect(binding?.workerProfileRef).not.toBeNull();
    const settlement = read.snapshot.deliverySettlements.find((entry) => entry.role === 'finalizer');
    expect(settlement?.dispatchId).toBe('dispatch-finalizer');
    expect(settlement?.outcome).toBe('succeeded');
    expect(settlement?.orcaResultRef.startsWith(`${FINALIZER_TASK}#`)).toBe(true);
    expect(read.snapshot.deliveryVerdicts.some((entry) => entry.verdict.kind === 'deliverable')).toBe(true);

    // ACK 只在结果被接受并结算之后发生：Orca 先收到 task-update，随后才是 delivery-ack。
    await waitFor(() => expect(harness.fake.mutations.some((mutation) => mutation.operation === 'delivery-ack')).toBe(true));
    const acceptIndex = harness.fake.mutations.findIndex((mutation) => mutation.operation === 'task-update');
    const ackIndex = harness.fake.mutations.findIndex((mutation) => mutation.operation === 'delivery-ack');
    expect(acceptIndex).toBeGreaterThanOrEqual(0);
    expect(ackIndex).toBeGreaterThan(acceptIndex);

    // 交付结论进入 Actionable Work：Wake Batch 只在结算完成后才准入。
    await waitFor(() => {
      const admissions = store.query({
        kind: 'wake-admissions',
        coordinationScopeId: SCOPE,
        coordinatorSessionId: SESSION,
      });
      expect(admissions.kind === 'wake-admissions' ? admissions.admissions.length : 0).toBeGreaterThan(0);
    });
  } finally {
    store.close();
  }
  harness.dispose();
  const restarted = await createForegroundPlanningHost({ repositoryPath: harness.repository,
    env: credentialFixtureEnvironment(harness.directory), clock: () => 62_000,
    heartbeatIntervalMs: 1_000, leaseTtlMs: 60_000, reconciliationIntervalMs: 20,
    orcaProbe: fakeProbe(), trackerFactory: fakeTracker, executionBackend: harness.fake.backend,
    loadIntegration: () => Promise.resolve({ ChatOpenAICompletions: CapableChatModel }),
    readOnlyWorkerProbe: fixedReadOnlyWorkerProbe(READ_ONLY_WORKER_UNAVAILABLE),
  });
  try {
    expect((await restarted.ports.scopeSetup.resolveHome()).kind).toBe('restore');
    const restored = { ...harness, host: restarted };
    await sendMessage(restored, '读取已有交付结论');
    await waitForSnapshot(restored, loaded => {
      expect(loaded.kind === 'snapshot' ? loaded.snapshot.finalizer.verdict?.kind : null).toBe('deliverable');
      if (loaded.kind === 'snapshot') expect(loaded.snapshot.blockers.some(entry => entry.code === 'finalizer_read_only_unprovable')).toBe(false);
    });
    expect(workerStarts(restored)).toBe(1);
  } finally {
    restarted.close();
  }
});

test.each([false, true])('真实 Orca 原生载荷：有效 JSON 结论被接受，先有拒绝诊断=%s', { timeout: TEST_TIMEOUT_MS }, async (rejectedLifecycleFirst) => {
  // 真实 Codex Worker 的 worker_done 只有传输身份，结论 JSON 在 body：宿主必须按宿主签发的
  // Orca Task/Dispatch 配对本体，而不是只看 Companion claimed 形状。
  const harness = await openHarness({ verdict: JSON.stringify(DELIVERABLE_VERDICT), rejectedLifecycleFirst });
  await sendMessage(harness, '开始收尾');
  await waitFor(() => expect(workerStarts(harness)).toBe(1));
  await sendMessage(harness, '继续');

  const snapshot = await waitForSnapshot(harness, (loaded) => {
    expect(loaded.kind === 'snapshot' ? loaded.snapshot.finalizer.verdict?.kind : null).toBe('deliverable');
  });
  if (snapshot.kind !== 'snapshot') {
    throw new Error('快照应当可读');
  }
  expect(snapshot.snapshot.blockers.map((blocker) => blocker.code)).not.toContain('finalizer_report_invalid');
});

test('真实 Orca 原生载荷：身份匹配但 body 不是 JSON 时报结论不可读，不静默 pending', { timeout: TEST_TIMEOUT_MS }, async () => {
  // 模型用叙述回报（例如 VERDICT ship）：身份成立但结论不可读，必须 fail closed 报 blocker，
  // 否则这条交付会永远停在 pending。
  const harness = await openHarness({ verdict: 'VERDICT: ship' });
  await sendMessage(harness, '开始收尾');
  await waitFor(() => expect(workerStarts(harness)).toBe(1));
  await sendMessage(harness, '继续');
  await sendMessage(harness, '再继续');

  const snapshot = await waitForSnapshot(harness, (loaded) => {
    expect(
      loaded.kind === 'snapshot' ? loaded.snapshot.blockers.map((blocker) => blocker.code) : [],
    ).toContain('finalizer_report_invalid');
  });
  if (snapshot.kind !== 'snapshot') {
    throw new Error('快照应当可读');
  }
  expect(snapshot.snapshot.finalizer.verdict).toBeNull();
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

test('只读 Worker 能力不可用：不派发 Finalizer、不呈现 deliverable，只留能力 blocker', { timeout: TEST_TIMEOUT_MS }, async () => {
  // 门禁满足但本机受限命令跑不起来：这正是交付拿不到结论的现实形态。
  const harness = await openHarness({
    verdict: DELIVERABLE_VERDICT,
    readOnlyWorkerProbe: () => Promise.resolve(READ_ONLY_WORKER_UNAVAILABLE),
  });
  await sendMessage(harness, '开始收尾');

  const snapshot = await waitForSnapshot(harness, (loaded) => {
    expect(
      loaded.kind === 'snapshot' ? loaded.snapshot.blockers.map((blocker) => blocker.code) : [],
    ).toContain('finalizer_read_only_unavailable');
  });
  // 零新派发：没有 Task、没有终端的只读会话，因此也不会有任何结论可被接受。
  expect(harness.fake.mutations.filter((mutation) => mutation.operation === 'worker-start')).toHaveLength(0);
  expect(harness.fake.mutations.filter((mutation) => mutation.operation === 'task-create')).toHaveLength(0);
  const blocker = snapshot.kind === 'snapshot'
    ? snapshot.snapshot.blockers.find((entry) => entry.code === 'finalizer_read_only_unavailable')
    : undefined;
  // 原因必须能诊断到阶段与真实失败，而不是一句「不可用」。
  expect(blocker?.message ?? '').toContain('sandbox-read');
  expect(blocker?.message ?? '').toContain('cannot establish app-server socket mount isolation');
  if (snapshot.kind !== 'snapshot') {
    throw new Error('快照应当可读');
  }
  expect(snapshot.snapshot.finalizer.verdict).toBeNull();
  expect(snapshot.snapshot.finalizer.readOnlyProfile).not.toBe('enforced');
});

test('能力变化不改写已派发的 Finalizer：环境随后不可用也不重复派发', { timeout: TEST_TIMEOUT_MS }, async () => {
  // 派发之后再让能力检查失败：既有派发按原身份对账，探针结论不能伪造第二次派发或失败结论。
  const capability = { value: READ_ONLY_WORKER_UNAVAILABLE };
  const harness = await openHarness({
    verdict: DELIVERABLE_VERDICT,
    readOnlyWorkerProbe: () => Promise.resolve(capability.value),
  });
  capability.value = READ_ONLY_WORKER_AVAILABLE;
  await sendMessage(harness, '开始收尾');
  await waitFor(() => expect(workerStarts(harness)).toBe(1));

  capability.value = READ_ONLY_WORKER_UNAVAILABLE;
  await sendMessage(harness, '继续');

  const snapshot = await waitForSnapshot(harness, (loaded) => {
    expect(loaded.kind === 'snapshot' ? loaded.snapshot.finalizer.verdict?.kind : null).toBe('deliverable');
  });
  expect(snapshot.kind === 'snapshot' ? snapshot.snapshot.finalizer.readOnlyProfile : null).toBe('enforced');
  expect(harness.fake.mutations.filter((mutation) => mutation.operation === 'worker-start')).toHaveLength(1);
});

/* -------------------------------------------------------------------------- */
/* IP-08：可写 Finalizer（v5 显式 repair policy）                                */
/* -------------------------------------------------------------------------- */

/** 修复派发建立的真实 worktree；未派发时为 undefined。 */
function repairWorktree(harness: Harness): string | undefined {
  return harness.fake.worktrees[0]?.path;
}

function gitOut(directory: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
}

/** 本 Scope 的项目级 Finalizer 预算键（与 store 的 `admit-finalizer` 同源）。 */
const FINALIZER_BUDGET_KEY = `finalizer:${GRAPH_ID}:${String(GENERATION)}`;

function finalizerBudgetConsumed(harness: Harness): number | null {
  const store = readStore(harness);
  try {
    const read = store.query({ kind: 'budget-counters', coordinationScopeId: SCOPE });
    return read.kind === 'budget-counters'
      ? (read.counters.find((entry) => entry.budgetKey === FINALIZER_BUDGET_KEY)?.consumed ?? 0)
      : null;
  } finally {
    store.close();
  }
}

/** 派发的同步绑定是否已落盘：`onTaskCreated`/`onDispatchStarted` 先写物化绑定再 settle 意图。 */
function finalizerBound(harness: Harness): boolean {
  const store = readStore(harness);
  try {
    const read = store.query({ kind: 'snapshot', coordinationScopeId: SCOPE });
    return read.kind === 'snapshot'
      && read.snapshot.materializationBindings.some((entry) => entry.role === 'finalizer');
  } finally {
    store.close();
  }
}

test('v5 修复授权：可写 Finalizer 提交修复 → 受控集成并推送 → 持久化最终 head/tree 与一次预算', { timeout: TEST_TIMEOUT_MS }, async () => {
  // 只读探针此时不可用：可写 Finalizer 的准入不依赖只读能力，首派发必须照常成功。
  const harness = await openHarness({ repair: true, readOnlyWorkerProbe: fixedReadOnlyWorkerProbe(READ_ONLY_WORKER_UNAVAILABLE) });
  await sendMessage(harness, '开始收尾');
  await waitFor(() => expect(workerStarts(harness)).toBe(1));
  const worktree = repairWorktree(harness);
  expect(worktree).toBeDefined();

  await sendMessage(harness, '继续');
  const snapshot = await waitForSnapshot(harness, (loaded) => {
    expect(loaded.kind === 'snapshot' ? loaded.snapshot.finalizer.verdict?.kind : null).toBe('deliverable');
  });
  if (snapshot.kind !== 'snapshot') {
    throw new Error('快照应当可读');
  }
  // 可写 Finalizer 不需要只读探测：交付投影明确是 not_required。
  expect(snapshot.snapshot.finalizer.readOnlyProfile).toBe('not_required');

  // 真实集成：canonical 停在修复后的最终提交（普通 ff 集成），并已推送到 bare origin。
  const canonical = canonicalPath(harness.repository);
  const canonicalHead = gitOut(canonical, 'rev-parse', 'HEAD');
  const canonicalTree = gitOut(canonical, 'rev-parse', 'HEAD^{tree}');
  const originHead = gitOut(join(harness.directory, 'origin.git'), 'rev-parse', 'refs/heads/main');
  expect(originHead).toBe(canonicalHead);
  expect(worktree).toBeDefined();
  expect(canonicalTree).toBe(gitOut(worktree!, 'rev-parse', 'HEAD^{tree}'));
  expect(gitOut(canonical, 'status', '--porcelain')).toBe('');

  const store = readStore(harness);
  try {
    const read = store.query({ kind: 'snapshot', coordinationScopeId: SCOPE });
    if (read.kind !== 'snapshot') throw new Error('快照应当可读');
    const verdict = read.snapshot.deliveryVerdicts.find((entry) => entry.verdict.kind === 'deliverable');
    // 交付版本绑定最终 HEAD/tree，不沿用修复前证据。
    expect(verdict?.verifiedHead).toBe(canonicalHead);
    expect(verdict?.verifiedTree).toBe(canonicalTree);
  } finally {
    store.close();
  }
  // 项目级 Finalizer 预算只扣一次。
  expect(finalizerBudgetConsumed(harness)).toBe(1);
  // 同一个 Turn 只派发一次：结论读回不产生第二个 Task。
  expect(harness.fake.mutations.filter((mutation) => mutation.operation === 'task-create')).toHaveLength(1);
});

test.each(['scope', 'head', 'commands'] as const)('v5 修复核验失败（%s）：报 finalizer_repair_unverified，不集成、不呈现 deliverable', { timeout: TEST_TIMEOUT_MS }, async (repairCase) => {
  const harness = await openHarness({ repair: true, repairCase });
  await sendMessage(harness, '开始收尾');
  await waitFor(() => expect(workerStarts(harness)).toBe(1));
  await sendMessage(harness, '继续');

  const snapshot = await waitForSnapshot(harness, (loaded) => {
    expect(
      loaded.kind === 'snapshot' ? loaded.snapshot.blockers.map((blocker) => blocker.code) : [],
    ).toContain('finalizer_repair_unverified');
  });
  if (snapshot.kind !== 'snapshot') {
    throw new Error('快照应当可读');
  }
  expect(snapshot.snapshot.finalizer.verdict).toBeNull();
  // 核验未通过就不集成：canonical 与 origin 都仍停在基线版本。
  const canonicalHead = gitOut(canonicalPath(harness.repository), 'rev-parse', 'HEAD');
  expect(gitOut(join(harness.directory, 'origin.git'), 'rev-parse', 'refs/heads/main')).toBe(canonicalHead);
});

test('重启沿原准入与 Task 复用：不重复 Task/Worker，预算沿用一次', { timeout: TEST_TIMEOUT_MS }, async () => {
  const harness = await openHarness({ repair: true });
  await sendMessage(harness, '开始收尾');
  await waitFor(() => expect(workerStarts(harness)).toBe(1));
  // 等同步绑定落盘再重启：真实 worker-start 已有副作用，但 onTaskCreated/onDispatchStarted 与
  // segment 可能还没写完；过早 dispose 会让重启读不到原 Task 身份。
  await waitFor(() => expect(finalizerBound(harness)).toBe(true));
  harness.dispose();

  const restarted = await createForegroundPlanningHost({
    repositoryPath: harness.repository,
    env: credentialFixtureEnvironment(harness.directory),
    clock: () => 62_000,
    heartbeatIntervalMs: 1_000,
    leaseTtlMs: 60_000,
    sessionBindingWindowMs: 200,
    orcaProbe: fakeProbe(),
    trackerFactory: fakeTracker,
    executionBackend: harness.fake.backend,
    loadIntegration: () => Promise.resolve({ ChatOpenAICompletions: CapableChatModel }),
    readOnlyWorkerProbe: fixedReadOnlyWorkerProbe(READ_ONLY_WORKER_UNAVAILABLE),
  });
  try {
    expect((await restarted.ports.scopeSetup.resolveHome()).kind).toBe('restore');
    const restored: Harness = { ...harness, host: restarted };
    await sendMessage(restored, '沿原 Task 继续');
    await waitForSnapshot(restored, (loaded) => {
      expect(loaded.kind === 'snapshot' ? loaded.snapshot.finalizer.verdict?.kind : null).toBe('deliverable');
    });
    // 原准入与物化绑定被复用：没有第二个 Task，没有第二次 Worker 启动。
    expect(harness.fake.mutations.filter((mutation) => mutation.operation === 'task-create')).toHaveLength(1);
    expect(workerStarts(restored)).toBe(1);
  } finally {
    restarted.close();
  }
  expect(finalizerBudgetConsumed(harness)).toBe(1);
});
