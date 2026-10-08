/**
 * IP-04 / IC-08 的 Validator 步骤通道**生产装配**行为测试（Owner: `m2-wire-execution-runtime`）。
 *
 * 与 `validation-runtime.test.ts` 的纯通道用例不同，这里走**真实前台宿主**：真实临时 Git 仓库、
 * 真实两个 SQLite store、真实 `runValidation` + `createValidatorStepRunner`、真实受控 reply 通道，
 * 以及宿主 pump（`replayPendingDeliveries` → `observeValidatorStep`）。只有 Orca 后端是 fake。
 *
 * 固定五类可观察事实：
 *
 * - 同一条真实 provider session 的「失败→修复合规→复验通过」链走完，宿主在**收到 accepted 的
 *   finish 许可之后**才写入 Validation Attempt 终态游标；
 * - 修复预算在 `admit-validation-step` 上按稳定 stepId 原子扣减，重放/重启不重复扣；
 * - Validator 的 typed 步骤问题**不**进入 Wake（不恢复模型），只由确定性步骤通道消费；
 * - finish 许可被拒绝时不得写入终态游标，也不得把链报告成完成；
 * - 重启后从游标固定的 `initialRepairConsumed` 续办：已放行的修复重放不二次扣预算、不重复答复。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { sessionBindingIdOf } from '../../src/adapters/agents/session-binding.js';
import { openCoordinationStore, type CoordinationStore } from '../../src/adapters/storage/coordination-store.js';
import { openCheckpointStore } from '../../src/adapters/storage/checkpoint-store.js';
import { consumedBudgetForWorkPackage } from '../../src/application/execution/advance-execution.js';
import { acquireRuntimeLease } from '../../src/application/coordination/lease-service.js';
import { beginIntent, settleIntent } from '../../src/application/coordination/intent-service.js';
import { replyOperationIdOf } from '../../src/application/coordination/reply-worker-question.js';
import { validationRepairStepId } from '../../src/application/run-validation.js';
import { ensureGraphGenerationRecord } from '../../src/application/execution/replanning-service.js';
import { graphIdFor } from '../../src/application/planning/graph-generation.js';
import { recordInitialGraph } from '../../src/application/planning/graph-history.js';
import { initializeCoordinationScope } from '../../src/application/planning/initialize-scope.js';
import { workPackageComment } from '../../src/application/materialize-work-package.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  DispatchId,
  GraphGeneration,
  GraphVersion,
  OperationId,
  PlanningCycleId,
  RuntimeIncarnationId,
  SessionSegmentId,
  WorkerTaskId,
  WorkPackageId,
} from '../../src/application/dto/identity.js';
import type { DeliveryMessage } from '../../src/application/dto/operation-outcome.js';
import type {
  CoordinationWriter,
} from '../../src/application/ports/branch-coordination-store.js';
import type {
  ExecutionBackend,
  ExecutionMutation,
  ExecutionQuery,
} from '../../src/application/ports/execution-backend.js';
import type { IssueTrackerGateway, TrackerReadOutcome, TrackerWriteOutcome } from '../../src/application/planning/route-map-service.js';
import type { DoctorProbe } from '../../src/bootstrap/doctor.js';
import { codexSessionPathsUnder } from '../../src/bootstrap/execution-runtime.js';
import { canonicalPath, coordinationDatabasePath } from '../../src/bootstrap/composition.js';
import { checkpointDatabasePath } from '../../src/bootstrap/coordinator-runtime.js';
import { createForegroundPlanningHost } from '../../src/bootstrap/foreground-planning-runtime.js';
import { DEFAULT_EXECUTION_LIMITS } from '../../src/domain/planning/budget-policy.js';
import type { ExecutionAuthorizationManifest } from '../../src/domain/planning/execution-authorization.js';
import type { ExecutionGraph } from '../../src/domain/planning/execution-graph.js';
import { COORDINATOR_SESSION_STATE_SCHEMA_VERSION } from '../../src/domain/coordinator/session-state.js';
import type { SnapshotLoad } from '../../src/interfaces/tui/ports.js';
import { executionWorkerProfiles } from '../support/execution-harness.js';
import { implementationPlanFor } from '../support/graph-plan-fixture.js';
import {
  coordinatorConfigurationFixture,
  projectConnectionsFixture,
  credentialFixtureEnvironment,
  projectExecutionProfilesFixture,
  recoveryUtilityProfileFixture,
} from '../support/model-configurations.js';
import { CapableChatModel } from '../support/fake-chat-model.js';

const SCOPE = 'scope-validator-runtime' as CoordinationScopeId;
const SESSION = 'session-validator-runtime' as CoordinatorSessionId;
const CYCLE = 'cycle-validator-runtime' as PlanningCycleId;
const INCARNATION = 'incarnation-validator-runtime' as RuntimeIncarnationId;
const GENERATION = 1 as GraphGeneration;
const GRAPH_ID = graphIdFor(SCOPE, GENERATION);
const RUN_ID = 'run-validator-runtime';
const AUTH_ID = 'auth-validator-runtime';
const WP = 'wp-validator-runtime' as WorkPackageId;

/** Orca 实际派发的 Dispatch 身份（Session Segment 的 owner）。 */
const ORCA_DISPATCH = 'dispatch-validator-runtime' as DispatchId;
/** Task Envelope 本地 alias（物化绑定里登记的 Dispatch 身份，typed 报告必须带它）。 */
const LOCAL_DISPATCH = 'local-dispatch-validator-runtime' as DispatchId;
const ATTEMPT = 'attempt-validator-runtime';
const WORKER_TASK = 'orca-task-validator-runtime' as WorkerTaskId;
const PROVIDER_SESSION = 'validator-provider-session';
const LAUNCH_ID = 'launch-validator-runtime';
const WORKTREE_ID = 'worktree-validator-runtime';
const TERMINAL_HANDLE = 'validator-terminal';

const COMPANION_STATE_DIRECTORY = 'orca-companion';
const TEST_WAIT_MS = 5_000;
const TEST_TIMEOUT_MS = 30_000;

const MSG_VERIFY_FAILED = 'validator-msg-verify-failed';
const MSG_REPAIR_APPLIED = 'validator-msg-repair-applied';
const MSG_VERIFY_PASSED = 'validator-msg-verify-passed';

const clock = (): number => 1_000;

/* -------------------------------------------------------------------------- */
/* fake Orca：delivery-read / message-inbox / worker-show / reply / delivery-ack */
/* -------------------------------------------------------------------------- */

type FakeValidatorOrca = {
  readonly backend: ExecutionBackend;
  readonly mutations: readonly ExecutionMutation[];
  /** 每次 reply mutation 的 action（从 reply 正文解析），用于证明没有重复副作用。 */
  readonly repliedActions: readonly string[];
  /** 把 finish 许可答复成确定失败（模拟 Orca 记录确定失败）。 */
  rejectFinish: boolean;
  hiddenRepair: 'untracked' | 'committed' | null;
  /** worktree-list 返回的 Work Package 隔离 worktree。 */
  readonly worktreePath: string;
};

function validatorMessages(): readonly DeliveryMessage[] {
  const identity = { schemaVersion: 1, kind: 'validator_step', workerTaskId: WORKER_TASK, dispatchId: LOCAL_DISPATCH, attemptId: ATTEMPT };
  return [
    message(MSG_VERIFY_FAILED, {
      ...identity,
      step: 'verify',
      outcome: 'failed',
      summary: '发现缺陷',
      evidence: [{ kind: 'command', coveredPaths: ['src/a.ts'], command: 'pnpm test', summary: '失败', outcome: 'failed' }],
      repairIntent: { changedPaths: ['src/a.ts'], requiresDesignChange: false, requiresDependencyChange: false },
    }),
    message(MSG_REPAIR_APPLIED, { ...identity, step: 'repair_applied', changedPaths: ['src/a.ts'], note: '已修复' }),
    message(MSG_VERIFY_PASSED, {
      ...identity,
      step: 'verify',
      outcome: 'passed',
      summary: '复验通过',
      evidence: [{ kind: 'command', coveredPaths: ['src/a.ts'], command: 'pnpm test', summary: 'ok', outcome: 'passed' }],
      repairIntent: null,
    }),
  ];
}

function message(messageId: string, body: unknown): DeliveryMessage {
  return {
    messageId,
    runId: RUN_ID,
    deliveryContract: 'current_delivery',
    fromHandle: TERMINAL_HANDLE,
    toHandle: `run:${RUN_ID}`,
    type: 'question',
    subject: 'validator step',
    priority: 'normal',
    body: JSON.stringify(body),
    payload: JSON.stringify({ taskId: WORKER_TASK, dispatchId: ORCA_DISPATCH }),
  };
}

function fakeValidatorOrca(worktreePath: string): FakeValidatorOrca {
  const mutations: ExecutionMutation[] = [];
  const repliedActions: string[] = [];
  const state: FakeValidatorOrca = {
    mutations,
    repliedActions,
    rejectFinish: false,
    hiddenRepair: null,
    worktreePath,
    backend: {
      query: (input: ExecutionQuery) => {
        switch (input.operation) {
          case 'run-current':
            return Promise.resolve({ kind: 'accepted' as const, value: { run: { runId: RUN_ID, consumerGeneration: 1 } } });
          case 'worktree-list':
            return Promise.resolve({
              kind: 'accepted' as const,
              value: {
                worktrees: [{
                  worktreeId: WORKTREE_ID,
                  path: worktreePath,
                  branch: 'refs/heads/validator-runtime',
                  head: 'fixture-head',
                  displayName: 'validator-runtime',
                  comment: workPackageComment(WP),
                  isMainWorktree: false,
                }],
                totalCount: 1,
                truncated: false,
                hostScope: { hostIds: ['local'], omittedHostIds: [] },
              },
            });
          case 'worker-list':
            return Promise.resolve({ kind: 'accepted' as const, value: { workers: [] } });
          case 'request-show':
            return Promise.resolve({ kind: 'accepted' as const, value: { requestId: input.requestId, state: 'pending' } });
          case 'delivery-read':
            return Promise.resolve({
              kind: 'accepted' as const,
              value: {
                delivery: { deliveryId: 'delivery-validator-runtime', runId: RUN_ID },
                messages: validatorMessages(),
                timedOut: false,
                cancelled: false,
              },
            });
          case 'message-inbox':
            return Promise.resolve({
              kind: 'accepted' as const,
              value: { messages: validatorMessages(), count: 3 },
            });
          case 'worker-show':
            return Promise.resolve({
              kind: 'accepted' as const,
              value: {
                exactWorker: true,
                dispatchId: ORCA_DISPATCH,
                taskId: WORKER_TASK,
                agentTerminalHandle: TERMINAL_HANDLE,
              },
            });
          case 'terminal-list':
            return Promise.resolve({
              kind: 'accepted' as const,
              value: { terminals: [{ handle: TERMINAL_HANDLE, connected: true, writable: true, title: 'validator' }], omittedHostIds: [], truncated: false },
            });
          case 'terminal-read':
            return Promise.resolve({ kind: 'accepted' as const, value: { terminal: { draft: '' } } });
          case 'terminal-wait':
            return Promise.resolve({ kind: 'accepted' as const, value: { terminal: { state: 'idle' } } });
          default:
            return Promise.resolve({ kind: 'accepted' as const, value: {} });
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
        if (input.operation === 'reply') {
          const parsed = JSON.parse(input.body) as { action?: string };
          const action = parsed.action ?? 'unknown';
          repliedActions.push(action);
          if (action === 'repair' && state.hiddenRepair !== null) {
            mkdirSync(join(worktreePath, 'src'), { recursive: true });
            writeFileSync(join(worktreePath, 'src', 'hidden.ts'), 'export const hidden = true;\n');
            if (state.hiddenRepair === 'committed') {
              execFileSync('git', ['-C', worktreePath, 'add', 'src/hidden.ts']);
              execFileSync('git', ['-C', worktreePath, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'hidden repair']);
            }
          }
          if (action === 'finish' && state.rejectFinish) {
            return Promise.resolve({
              kind: 'rejected' as const,
              code: 'orca_reply_rejected',
              message: 'Orca 记录了确定失败：finish 许可未生效',
            });
          }
          // 适配器的 `parseResult` 已把 ok 载荷归一化成 ReplyReceipt；这里直接给归一化形状。
          return accepted({
            messageId: `reply-${String(repliedActions.length)}`,
            questionMessageId: input.messageId,
            questionStatus: 'answered',
            duplicate: false,
          });
        }
        return accepted(null);
      },
    },
  };
  return state;
}

/* -------------------------------------------------------------------------- */
/* 现场                                                                        */
/* -------------------------------------------------------------------------- */

function prepareRepository(directory: string): { readonly repository: string; readonly head: string } {
  const repository = join(directory, 'repo');
  mkdirSync(repository);
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Verification');
  git('config', 'user.email', 'verification@example.invalid');
  writeFileSync(join(repository, 'README.md'), '# repo\n');
  writeFileSync(
    join(repository, 'orca-companion.json'),
    JSON.stringify({
      schemaVersion: 5,
      ...projectConnectionsFixture(),
      coordinatorModels: [{
        ...coordinatorConfigurationFixture('planning-default'),
      }],
      defaultCoordinatorModelRef: 'planning-default',
      tracker: { kind: 'github', routeMapIssueNumber: 7 },
      planning: { maxMutations: 2 },
      context: { maxInputTokens: 20_000 },
      ...projectConnectionsFixture(),
      execution: {
        harness: 'codex',
        ...projectExecutionProfilesFixture(),
        permissions: { planner: true, implementation: true, validator: true, finalizer: true, gitIntegration: true, dependencyChanges: false },
        git: { remotes: ['origin'], refs: ['refs/heads/main'] },
      },
    }),
    'utf8',
  );
  const change = join(repository, 'openspec', 'changes', 'demo');
  mkdirSync(join(change, 'specs', 'demo'), { recursive: true });
  writeFileSync(join(change, 'proposal.md'), '# Proposal\n\n## Impact\n\n- `src/a.ts`\n');
  writeFileSync(join(change, 'tasks.md'), '- [ ] 1.1 做点事\n');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  return { repository, head: git('rev-parse', 'HEAD') };
}

function manifestFor(head: string, repository: string): ExecutionAuthorizationManifest {
  return {
    manifestVersion: 4,
    coordinationScopeId: SCOPE,
    planningCycleId: CYCLE,
    destinationRef: { kind: 'destination', id: 'dest-1', version: 1 },
    routeMapRef: { kind: 'route-map', id: '7', version: 1 },
    implementationPlanRef: { kind: 'implementation-plan', id: 'plan-1', version: 1 },
    graph: { graphId: GRAPH_ID, generation: GENERATION, version: 1 as GraphVersion },
    baselineHead: head,
    orcaRunId: RUN_ID,
    workerProfiles: [...executionWorkerProfiles()],
    recoveryUtilityProfile: recoveryUtilityProfileFixture(),
    permissions: { planner: true, implementation: true, validator: true, finalizer: true, gitIntegration: true, dependencyChanges: false },
    limits: DEFAULT_EXECUTION_LIMITS,
    workspacePolicy: { canonicalWorktree: canonicalPath(repository), worktreeIsolation: 'per_work_package' },
    gitPolicy: { canonicalBranch: 'main', remotes: ['origin'], refs: ['refs/heads/main'], allowForcePush: false },
    dependencyPolicy: { allowDependencyChanges: false, registry: null },
    acceptedRisks: [],
  };
}

/**
 * 按生产路径写出该次派发自己的 Codex SessionStart 报告与 transcript：路径由 `launchId` 派生，
 * 报告里的 CODEX_HOME/transcript/cwd 必须逐项与绑定事实一致，`validatorStepBindingOf` 才认。
 */
function writeValidatorSessionArtifacts(repository: string, worktreePath: string): void {
  const paths = codexSessionPathsUnder(join(repository, '.git', COMPANION_STATE_DIRECTORY), LAUNCH_ID);
  const codexHome = join(paths.stateRoot, createHash('sha256').update(LAUNCH_ID).digest('hex').slice(0, 20));
  const sessionsDir = join(codexHome, 'sessions', '2026', '10', '05');
  mkdirSync(sessionsDir, { recursive: true });
  const transcriptPath = join(sessionsDir, `rollout-2026-10-05T00-00-00-${PROVIDER_SESSION}.jsonl`);
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({ type: 'session_meta', payload: { id: PROVIDER_SESSION, cwd: worktreePath } })}\n`,
    'utf8',
  );
  mkdirSync(join(paths.stateRoot, 'reporters'), { recursive: true });
  writeFileSync(
    paths.reportPath,
    `${JSON.stringify({
      sessionId: PROVIDER_SESSION,
      transcriptPath,
      codexHome,
      cwd: worktreePath,
      observedAt: new Date().toISOString(),
    })}\n`,
    'utf8',
  );
  TRANSCRIPT_PATH = transcriptPath;
}

let TRANSCRIPT_PATH = '';

function prepareValidatorState(repository: string, head: string, options?: { readonly seedAdmittedRepair?: boolean }): void {
  const opened = openCoordinationStore({ databasePath: coordinationDatabasePath(join(repository, '.git')), clock });
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
    const revision = (): number => {
      const read = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
      if (read.kind !== 'scope' || read.scope === null) {
        throw new Error('Scope 不存在');
      }
      return read.scope.revision;
    };
    const graph: ExecutionGraph = {
      graphId: GRAPH_ID,
      generation: GENERATION,
      workPackages: [{
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
      }],
    };
    const recorded = recordInitialGraph({
      store, coordinationScopeId: SCOPE, writer, graph,
      initialPlan: implementationPlanFor(graph, 1), mapRevision: 1, planRevision: 1, orcaRunId: RUN_ID,
    });
    if (recorded.kind !== 'recorded') {
      throw new Error(`无法记录初始图：${recorded.failure.message}`);
    }
    const ensured = ensureGraphGenerationRecord({
      store, coordinationScopeId: SCOPE, writer, graphId: GRAPH_ID, generation: GENERATION,
      planningCycleId: CYCLE, orcaRunId: RUN_ID, predecessorGraphId: null, baselineHead: head,
    });
    if (ensured.kind !== 'recorded') {
      throw new Error('无法记录世代');
    }
    const authorized = store.transact({
      kind: 'record-authorization', coordinationScopeId: SCOPE, expectedRevision: revision(), writer,
      authorizationId: AUTH_ID, authorizationVersion: 1, manifestVersion: 4,
      fingerprint: 'fingerprint-validator-runtime', approvalRef: 'approval-validator-runtime', manifest: manifestFor(head, repository),
    });
    if (authorized.kind === 'rejected') {
      throw new Error(`无法记录授权：${authorized.message}`);
    }
    const transitioned = store.transact({
      kind: 'transition-to-execution', coordinationScopeId: SCOPE, expectedRevision: revision(), writer,
      planningCycleId: CYCLE, graphId: GRAPH_ID, graphVersion: 1 as GraphVersion,
      authorizationId: AUTH_ID, authorizationVersion: 1,
    });
    if (transitioned.kind === 'rejected') {
      throw new Error(`无法进入执行协调态：${transitioned.message}`);
    }
    // 暂停整个 Scope：执行推进与模型恢复都停，只保留前台对账（Delivery pump / 步骤通道）继续工作。
    const paused = store.transact({
      kind: 'record-control-state', coordinationScopeId: SCOPE, expectedRevision: revision(), writer, controlState: 'paused',
    });
    if (paused.kind === 'rejected') {
      throw new Error(`无法暂停 Scope：${paused.message}`);
    }
    const bound = store.transact({
      kind: 'record-materialization-binding', coordinationScopeId: SCOPE, expectedRevision: revision(), writer,
      workPackageId: WP, role: 'validator', workerTaskId: WORKER_TASK, dispatchId: LOCAL_DISPATCH, attemptId: ATTEMPT,
      worktreeId: WORKTREE_ID,
      specBinding: {
        provider: 'openspec', relativePath: 'openspec/changes/demo', contentDigest: 'digest-validator-runtime',
        providerVersion: '0.4.0', contractRevision: 1, trackingRevision: 1,
      },
      specificationUnitPath: null, authorizationId: AUTH_ID, authorizationVersion: 1,
      workerProfileRef: 'profile-validator', orcaTaskId: WORKER_TASK,
      creationOperationId: 'op:materialize-validator-runtime' as OperationId, launchId: LAUNCH_ID,
    });
    if (bound.kind === 'rejected') {
      throw new Error(`无法记录物化绑定：${bound.message}`);
    }
    const segment = store.transact({
      kind: 'record-session-segment', coordinationScopeId: SCOPE, expectedRevision: revision(), writer,
      segmentId: 'segment-validator-runtime' as SessionSegmentId, workPackageId: WP, role: 'validator',
      workerTaskId: WORKER_TASK, dispatchId: ORCA_DISPATCH, attemptId: ATTEMPT,
      sessionBindingId: sessionBindingIdOf(ORCA_DISPATCH, PROVIDER_SESSION), lastTranscriptRef: TRANSCRIPT_PATH,
      terminalReceiptRef: null, transcriptReferenceable: true, verifiable: true,
    });
    if (segment.kind === 'rejected') {
      throw new Error(`无法记录 Session Segment：${segment.message}`);
    }
    if (options?.seedAdmittedRepair === true) {
      // 现场：上一个 Incarnation 已经在同一 Attempt 里放行过一次修复（预算已扣、游标首写、许可已答复），
      // 但链还没走到终态。重启后的新 Incarnation 必须按 `initialRepairConsumed` 续办，重放不二次扣减。
      const admitted = store.transact({
        kind: 'admit-validation-step', coordinationScopeId: SCOPE, expectedRevision: revision(), writer,
        stepId: validationRepairStepId({ dispatchId: ORCA_DISPATCH, validationAttemptId: ATTEMPT as never, repairOrdinal: 1 }),
        workPackageId: WP, workerTaskId: WORKER_TASK, dispatchId: ORCA_DISPATCH, validationAttemptId: ATTEMPT, repairOrdinal: 1,
        approvedLimitRef: AUTH_ID, approvedLimit: DEFAULT_EXECUTION_LIMITS.validatorRepairs,
      });
      if (admitted.kind === 'rejected') {
        throw new Error(`无法预置修复准入：${admitted.message}`);
      }
      const cursor = store.transact({
        kind: 'record-validation-attempt', coordinationScopeId: SCOPE, expectedRevision: revision(), writer,
        validationAttemptId: ATTEMPT, workPackageId: WP, workerTaskId: WORKER_TASK, dispatchId: ORCA_DISPATCH,
        providerSessionId: PROVIDER_SESSION, initialRepairConsumed: 0, messageIds: [MSG_VERIFY_FAILED],
      });
      if (cursor.kind === 'rejected') {
        throw new Error(`无法预置 Validation Attempt 游标：${cursor.message}`);
      }
      const replyOperationId = replyOperationIdOf(MSG_VERIFY_FAILED, 'repair');
      const target = { kind: 'worker-message' as const, id: MSG_VERIFY_FAILED };
      const begun = beginIntent(store, {
        coordinationScopeId: SCOPE, operationId: replyOperationId, target, operationCategory: 'worker-reply',
        writer, expectedRevision: revision(), expectedHead: head,
      });
      if (begun.kind !== 'registered') {
        throw new Error(`无法预置修复许可意图：${begun.kind}`);
      }
      const settled = settleIntent(store, {
        coordinationScopeId: SCOPE, operationId: replyOperationId, writer, expectedRevision: revision(),
        outcome: { kind: 'accepted', operation: { operationId: replyOperationId, target },
          value: { messageId: 'reply-seed', questionMessageId: MSG_VERIFY_FAILED, questionStatus: 'answered', duplicate: false } },
      });
      if (settled.kind !== 'settled') {
        throw new Error(`无法预置修复许可收尾：${settled.kind}`);
      }
    }
    const checkpoints = openCheckpointStore({ databasePath: checkpointDatabasePath(join(repository, '.git')), clock });
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
      kind: 'release-runtime-lease', coordinationScopeId: SCOPE, expectedRevision: revision(), writer,
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
    readRuntime: () => Promise.resolve({ ok: true, value: { state: 'running', reachable: true, capabilities: [] } }),
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
        issue: { ref: { kind: 'route-map', id: '7' }, title: 'Route Map', body: '## Destination\n目的地\n## Open Decision Tickets\n## Fog\n', state: 'open', assignees: [] },
      }),
    updateIssueBody: (): Promise<TrackerWriteOutcome> => Promise.resolve({ kind: 'accepted' }),
    assignIssue: (): Promise<TrackerWriteOutcome> => Promise.resolve({ kind: 'accepted' }),
  };
}

type Harness = {
  readonly repository: string;
  readonly directory: string;
  readonly host: Awaited<ReturnType<typeof createForegroundPlanningHost>>;
  readonly fake: FakeValidatorOrca;
  readonly dispose: () => void;
};

const created: Harness[] = [];

afterEach(() => {
  for (const harness of created.splice(0)) {
    harness.dispose();
    rmSync(harness.directory, { recursive: true, force: true });
  }
});

async function openHarness(options?: { readonly rejectFinish?: boolean; readonly seedAdmittedRepair?: boolean }): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), 'orca-validator-runtime-'));
  const { repository, head } = prepareRepository(directory);
  const worktreePath = join(directory, 'worktrees', 'validator-runtime');
  mkdirSync(join(directory, 'worktrees'), { recursive: true });
  execFileSync('git', ['-C', repository, 'worktree', 'add', '--detach', worktreePath, head], { stdio: 'pipe' });
  writeValidatorSessionArtifacts(repository, worktreePath);
  prepareValidatorState(repository, head, { ...(options?.seedAdmittedRepair === true ? { seedAdmittedRepair: true } : {}) });
  const fake = fakeValidatorOrca(worktreePath);
  fake.rejectFinish = options?.rejectFinish === true;
  const host = await createForegroundPlanningHost({
    repositoryPath: repository,
    env: credentialFixtureEnvironment(directory),
    clock,
    newId: (() => {
      let counter = 0;
      return () => `id-${String((counter += 1))}`;
    })(),
    heartbeatIntervalMs: 1_000,
    leaseTtlMs: 60_000,
    reconciliationIntervalMs: 20,
    orcaProbe: fakeProbe(),
    trackerFactory: fakeTracker,
    loadIntegration: () => Promise.resolve({ ChatOpenAICompletions: CapableChatModel }),
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

/** 一次用户消息＝一次宿主命令：它打开 Session 并启动前台对账（Delivery pump）。 */
async function openSession(harness: Harness): Promise<void> {
  const result = await harness.host.ports.execute({
    kind: 'send-session-message',
    submissionId: globalThis.crypto.randomUUID(),
    coordinatorSessionId: SESSION,
    content: '开始验证',
  });
  if (result.kind !== 'accepted') {
    throw new Error(`send-session-message 被拒绝：${JSON.stringify(result)}`);
  }
}

function readStore(repository: string): CoordinationStore {
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

function validatorRepairConsumed(repository: string): number {
  const store = readStore(repository);
  try {
    return consumedBudgetForWorkPackage(store, SCOPE, WP)?.find((entry) => entry.field === 'validatorRepairs')?.consumed ?? 0;
  } finally {
    store.close();
  }
}

function validationAttempt(repository: string): { readonly messageIds: readonly string[]; readonly terminal: string | null } | null {
  const store = readStore(repository);
  try {
    const read = store.query({ kind: 'validation-attempt', coordinationScopeId: SCOPE, dispatchId: ORCA_DISPATCH });
    return read.kind === 'validation-attempt' && read.attempt !== null
      ? { messageIds: read.attempt.messageIds, terminal: read.attempt.terminalQuestionMessageId }
      : null;
  } finally {
    store.close();
  }
}

/** 只统计由 Worker 消息准入的 Wake；用户消息的 Wake 与本行为无关。 */
function workerWakeAdmissions(repository: string): number {
  const store = readStore(repository);
  try {
    const read = store.query({ kind: 'wake-admissions', coordinationScopeId: SCOPE, coordinatorSessionId: SESSION });
    return read.kind === 'wake-admissions'
      ? read.admissions.filter((admission) => admission.wakeBatchId.startsWith('wake:worker:')).length
      : -1;
  } finally {
    store.close();
  }
}

async function waitFor(assertion: () => unknown): Promise<void> {
  await vi.waitFor(assertion, { timeout: TEST_WAIT_MS, interval: 25 });
}

/* -------------------------------------------------------------------------- */
/* 测试                                                                        */
/* -------------------------------------------------------------------------- */

test(
  '生产 pump 走完 Validator 同会话修复链：finish 才写终态游标，修复只扣一次预算，且不产生 Wake',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const harness = await openHarness();
    await openSession(harness);
    const repository = harness.repository;

    await waitFor(() => {
      const cursor = validationAttempt(repository);
      expect(cursor?.terminal).toBe(MSG_VERIFY_PASSED);
    });

    // 终态游标只在 finish 许可被 accepted 之后写入；修复链按原序回读了全部三条消息。
    const cursor = validationAttempt(repository);
    expect(cursor?.messageIds).toEqual([MSG_VERIFY_FAILED, MSG_REPAIR_APPLIED, MSG_VERIFY_PASSED]);
    // 修复预算恰好扣一次。
    await waitFor(() => expect(validatorRepairConsumed(repository)).toBe(1));
    expect(validatorRepairConsumed(repository)).toBe(1);

    // 内部 Validator 步骤问题走确定性通道，不恢复模型：没有由 worker 消息准入的 Wake。
    expect(workerWakeAdmissions(repository)).toBe(0);

    // 副作用序列：repair → verify → finish，且没有重复答复。
    const actions = harness.fake.repliedActions;
    expect(actions).toEqual(['repair', 'verify', 'finish']);

    // 继续跑几轮对账（重放同一未 ack 批次）：不得重复扣预算或重复答复。
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(validatorRepairConsumed(repository)).toBe(1);
    expect(harness.fake.repliedActions).toEqual(['repair', 'verify', 'finish']);
    expect(validationAttempt(repository)?.terminal).toBe(MSG_VERIFY_PASSED);
  },
);

test(
  'finish 许可被拒时：不写终态游标、不伪造完成，前台留下可区分的 Validator 链 blocker',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const harness = await openHarness({ rejectFinish: true });
    await openSession(harness);
    const repository = harness.repository;

    // 修复与复验都走到 finish；但 finish 被 Orca 确定拒绝，链不完成。
    await waitFor(() => expect(harness.fake.repliedActions).toContain('finish'));
    await waitFor(async () => {
      const loaded: SnapshotLoad = await harness.host.ports.snapshot(SESSION);
      expect(loaded.kind === 'snapshot' ? loaded.snapshot.blockers.map((blocker) => blocker.code) : []).toContain('validator_chain_failed');
    });
    // 没有终态游标：不把「许可被拒」读成完成。
    expect(validationAttempt(repository)?.terminal).toBeNull();
    // 预算仍按准入扣了一次（修复确实被放行过），但没有 finish。
    expect(validatorRepairConsumed(repository)).toBe(1);
  },
);

test(
  '重启后按 initialRepairConsumed 续办：已放行的修复重放不二次扣预算、不重复答复',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    // 现场里已经存在「上一次 Incarnation 放行过一次修复」的持久事实：预算 1、游标首写、许可已答复。
    const harness = await openHarness({ seedAdmittedRepair: true });
    await openSession(harness);
    const repository = harness.repository;

    await waitFor(() => expect(validationAttempt(repository)?.terminal).toBe(MSG_VERIFY_PASSED));

    // 重启续办从游标固定的 `initialRepairConsumed` 起算，重放同一个修复 stepId 不二次扣减。
    expect(validatorRepairConsumed(repository)).toBe(1);
    // 已经答复过的修复许可只按原 OperationId 重放（不再触发外部 mutation）。
    expect(harness.fake.repliedActions).toEqual(['verify', 'finish']);
    expect(workerWakeAdmissions(repository)).toBe(0);
  },
);

test.each(['untracked', 'committed'] as const)(
  'Worker 漏报 %s 修复路径时，Git 事实拒绝完成许可',
  { timeout: TEST_TIMEOUT_MS },
  async kind => {
    const harness = await openHarness();
    harness.fake.hiddenRepair = kind;
    await openSession(harness);
    await waitFor(() => expect(harness.fake.repliedActions).toContain('refuse'));
    expect(harness.fake.repliedActions).not.toContain('finish');
    expect(validatorRepairConsumed(harness.repository)).toBe(1);
    expect(validationAttempt(harness.repository)?.terminal).toBe(MSG_REPAIR_APPLIED);
  },
);
