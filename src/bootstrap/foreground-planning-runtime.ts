/**
 * MOD-07：前台规划进程的宿主装配
 * （Owner: `m1-wire-foreground-planning-runtime`，D3）。
 *
 * 这里是**唯一**的生产装配点：读取版本化项目配置、核验 Git/Orca/tracker/模型、打开可写的
 * Branch Coordination State 与会话 checkpoint、按需为一个 Coordinator Session 取得 Runtime Lease
 * 并续约，然后把用户消息、会话维护、模型切换与规划交接接到既有的应用用例上。界面只经它拿到
 * `TuiPorts`，永远看不到 store、backend 或 writer 身份。
 *
 * 三条硬边界：
 * - **写入者身份来自 lease**：每个命令与每个图节点在写入前都回读 Runtime Lease 并核验 fencing；
 *   续约失败即停止本 Session 的新模型调用与写入并发布 blocker，绝不以新身份偷偷续跑；
 * - **模型输入由当前配置组装**：instructions、tool schema、最新权威事实与上下文预算都来自当前
 *   项目配置与当前 Scope 事实，不缓存旧副本；
 * - **退出不改变业务状态**：`close()` 只清理本进程资源（timer、checkpoint 句柄、订阅），不隐式
 *   Pause/Cancel 任何 Scope 或 Session。
 */

import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  InteractionId,
  OperationId,
  PlanningCycleId,
  RuntimeIncarnationId,
  WorkPackageId,
} from '../application/dto/identity.js';
import type { ProjectedActionableWorkItem } from '../application/coordinator/actionable-work.js';
import { answerPendingInteraction } from '../application/coordination/pending-interaction.js';
import { requestSessionCompaction } from '../application/coordinator/compact-session.js';
import {
  assertSwitchable,
  switchModelConfiguration,
  type CoordinatorModelConfiguration,
} from '../application/coordinator/model-config-switch.js';
import {
  assertFencingGeneration,
  writerFor,
  type CoordinatorIncarnation,
} from '../application/coordinator/runtime-guard.js';
import { submitUserMessage } from '../application/coordinator/user-message.js';
import { renewRuntimeLease } from '../application/coordination/lease-service.js';
import { bindScopeIdentity, initializeCoordinationScope } from '../application/planning/initialize-scope.js';
import {
  activationGate,
  cancelPlanningHandoff,
  cutoverPlanningHandoff,
  preparePlanningHandoff,
  resumePlanningHandoff,
  reviewPlanningHandoff,
} from '../application/planning/planning-handoff.js';
import {
  claimTicket,
  readRouteMap,
  releaseTicket,
  resolveTicket,
  updateRouteMapSection,
  writeResolvedTicketMap,
  type IssueTrackerGateway,
  type PlanningMutationResult,
} from '../application/planning/route-map-service.js';
import {
  deriveExecutionFacts,
  deriveWorkerEntries,
  noExecutionObservations,
  type ExecutionObservationFacts,
  type WorkerEntryView,
  type WorkerObservation,
} from '../application/execution/execution-view.js';
import {
  cancelExecutionHandoff,
  cutoverExecutionHandoff,
  prepareExecutionHandoff,
  reviewExecutionHandoff,
  type ExecutionHandoffResult,
  type ExecutionHandoffReviewFacts,
} from '../application/handoff/execution-handoff.js';

/**
 * 交接用例的结构化失败原因。
 *
 * 用例返回的是完整结果联合，因此这里只回答「失败原因是什么」：成功分支返回 `null`，调用方据此走
 * 成功路径，而不是在联合类型上猜测属性存在。
 */
function executionHandoffFailure(
  result: ExecutionHandoffResult,
): { readonly code: string; readonly message: string } | null {
  return result.kind === 'blocked' || result.kind === 'rejected' ? result.failure : null;
}
import {
  createScopeControlService,
  type ActiveWorkerListResult,
  type ScopeControlResult,
} from '../application/coordination/scope-control-service.js';
import type { WorkerStopOutcome } from '../domain/coordination/scope-control.js';
import { createControllerService,
  projectControllerSnapshot,
  toSemanticEvent,
  type ControllerCommandResult,
  type ControllerCompactionView,
  type ControllerEventSource,
  type ControllerNotification,
  type ControllerNotificationMessage,
  type ControllerService,
  type ControllerSnapshot,
  type ControllerTranscriptMessage,
  type ControllerTranscriptPage,
  type SemanticEvent,
  type Unsubscribe,
} from '../application/controller-service.js';
import type { GraphVersionRecord } from '../domain/planning/execution-graph.js';
import type { ClaimProjection } from '../domain/planning/ticket-claim.js';
import type {
  CommittedMessageEntry,
  CoordinatorSessionState,
} from '../domain/coordinator/session-state.js';
import { threadIdFor } from '../domain/coordinator/session-state.js';
import type {
  BranchCoordinationStore,
  CoordinationSnapshot,
  CoordinationWriter,
  PendingInteractionRecord,
  ScopeRecord,
} from '../application/ports/branch-coordination-store.js';
import type { ExecutionBackend } from '../application/ports/execution-backend.js';
import type { RoleAuthorities } from '../domain/planning/execution-authorization.js';
import type {
  ExecutionHandoffIntentPort,
  HomeResolution,
  ModelCatalog,
  ScopeSetupPort,
  SnapshotLoad,
  TranscriptLoad,
  TuiIntent,
  TuiPorts,
  WizardCheck,
  WizardProposal,
} from '../interfaces/tui/ports.js';
import { openCheckpointStore, type CheckpointStore } from '../adapters/storage/checkpoint-store.js';
import { createOrcaExecutionBackend } from '../adapters/orca-cli/orca-backend.js';
import type { WorkerListResult } from '../adapters/orca-cli/operation-catalog.js';
import { workPackageComment } from '../application/materialize-work-package.js';
import { createGhTracker } from '../adapters/tracker/gh-tracker.js';
import {
  createModuleIntegrationResolverAsync,
  resolveChatModel,
} from '../adapters/agents/chat-model-factory.js';
import {
  buildBoundedModelInput,
  deriveContextCapsule,
  type ToolSchemaEntry,
} from '../workflow/coordinator/context.js';
import { buildCoordinatorGraph, registerPlanningTools } from '../workflow/coordinator/graph.js';
import { planningRecoveryToolset } from '../workflow/coordinator/planning-tools.js';
import {
  COORDINATOR_INVOKE_DEFAULTS,
  pendingToolCallsIn,
  type HistorySegment,
} from '../workflow/coordinator/state.js';
import type {
  PlanningToolDefinition,
  PlanningToolFacts,
  PlanningToolServices,
} from '../workflow/coordinator/planning-tools.js';
import {
  canonicalPath,
  createCoordinationStore,
  resolveGitCommonDir,
  resolveGitScopeIdentity,
} from './composition.js';
import { checkpointDatabasePath, startCoordinatorRuntime } from './coordinator-runtime.js';
import { createOrcaDoctorProbe } from './doctor.js';
import {
  PROJECT_CONFIG_FILENAME,
  configurationByRef,
  loadProjectConfig,
  type ProjectConfig,
} from './project-config.js';
import type { TuiEntryEnvironment } from './tui-entry.js';

/** Runtime Lease 的续约节奏与 TTL；心跳远小于 TTL，因此一次丢包不会立刻失去租约。 */
export const RUNTIME_HEARTBEAT_INTERVAL_MS = 10_000;
export const RUNTIME_LEASE_TTL_MS = 30_000;

/**
 * Coordinator 的固定指令。
 *
 * 它只描述职责与边界：不实现代码、不发明事实、需要用户决定时用 Pending Interaction、写地图与票据
 * 只经受控工具。工具契约本身来自 tool schema，不在这里重复。
 */
export const FOREGROUND_COORDINATOR_INSTRUCTIONS: readonly string[] = [
  '你是 Orca Companion 的 Coordinator Agent，只做规划与协调，不实现代码。',
  'Route Map 与 Decision Ticket 的权威是 issue tracker；Scope 状态、租约与图引用的权威在 Companion 自己的记录里。',
  '不要臆造事实：需要现有信息时先用只读工具读取，再据此行动。',
  '需要用户决定时发起 Pending Interaction 并停止等待，不要替用户做决定。',
  '写入地图、认领或解决票据都只通过受控工具调用，且同一 revision 下不要并发写入。',
];

const TRANSCRIPT_WINDOW = 200;

const PLANNING_MUTATION_CATEGORIES: ReadonlySet<string> = new Set([
  'route-map-section-update',
  'ticket-claim',
  'ticket-release',
]);

export type ForegroundPlanningFailureCode =
  | 'repository_unresolved'
  | 'detached_head'
  | 'worktree_not_canonical'
  | 'config_unavailable'
  | 'store_unavailable'
  | 'scope_unavailable'
  | 'tracker_unavailable'
  | 'model_unavailable'
  | 'session_unavailable'
  | 'fencing_lost';

export type ForegroundPlanningBlocker = {
  readonly code: ForegroundPlanningFailureCode;
  readonly message: string;
};

export type ForegroundPlanningHostOptions = {
  readonly repositoryPath: string;
  readonly env: Readonly<Record<string, string>>;
  readonly clock?: () => number;
  /** 新身份生成器（Session、Planning Cycle、Proposal、Event）；测试可注入确定性实现。 */
  readonly newId?: () => string;
  readonly heartbeatIntervalMs?: number;
  readonly leaseTtlMs?: number;
  readonly probeTimeoutMs?: number;
  /** 测试注入点：项目配置文件的读取实现。 */
  readonly readFile?: (path: string) => string;
  /** 测试注入点：provider 集成的加载实现。 */
  readonly loadIntegration?: (specifier: string) => Promise<unknown>;
  /** 测试注入点：Orca 能力与身份探测。 */
  readonly orcaProbe?: ReturnType<typeof createOrcaDoctorProbe>;
  /** 测试注入点：tracker gateway。 */
  readonly trackerFactory?: (options: { readonly cwd: string; readonly env: Readonly<Record<string, string>> }) => IssueTrackerGateway;
  /** 外部通知源（例如后台对账）；省略表示只有宿主自己发布的事件。 */
  readonly events?: ControllerEventSource;
};

export type ForegroundPlanningHost = {
  readonly ports: TuiPorts;
  readonly controller: ControllerService;
  /** 当前进程解析到的仓库与配置事实；未就绪时为 `null`。 */
  readonly readiness: () => ForegroundPlanningHostReadiness;
  readonly close: () => void;
};

export type ForegroundPlanningHostReadiness = {
  readonly canonicalWorktreePath: string | null;
  readonly fullBranchRef: string | null;
  readonly configPath: string | null;
  readonly blocker: ForegroundPlanningBlocker | null;
};

/** 一个存活 Session 的进程内装配：模型、图、checkpoint 与 lease 身份。 */
type LiveSession = {
  readonly coordinatorSessionId: CoordinatorSessionId;
  incarnation: CoordinatorIncarnation;
  configuration: CoordinatorModelConfiguration;
  model: BaseChatModel;
  checkpoints: CheckpointStore;
  readonly graph: ReturnType<typeof buildCoordinatorGraph> | null;
  heartbeat: ReturnType<typeof setInterval> | null;
  fencingLost: boolean;
  loopRunning: boolean;
  pendingWake: ProjectedActionableWorkItem[] | null;
  inFlightModelOperations: number;
};

export async function createForegroundPlanningHost(
  options: ForegroundPlanningHostOptions,
): Promise<ForegroundPlanningHost> {
  const clock = options.clock ?? (() => Date.now());
  const newId = options.newId ?? (() => randomUUID());
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? RUNTIME_HEARTBEAT_INTERVAL_MS;
  const leaseTtlMs = options.leaseTtlMs ?? RUNTIME_LEASE_TTL_MS;
  const trackerFactory =
    options.trackerFactory ??
    ((trackerOptions: { readonly cwd: string; readonly env: Readonly<Record<string, string>> }) =>
      createGhTracker(trackerOptions));

  const listeners = new Set<(event: SemanticEvent) => void>();
  const liveSessions = new Map<string, LiveSession>();
  let closed = false;

  const publish = (
    coordinatorSessionId: string | null,
    notification: ControllerNotification,
  ): void => {
    const message: ControllerNotificationMessage = {
      envelope: { eventId: newId(), coordinatorSessionId },
      notification,
    };
    const event = toSemanticEvent(message);
    if (event === null) {
      return;
    }
    for (const listener of [...listeners]) {
      listener(event);
    }
  };

  // ---------------------------------------------------------------------
  // 仓库与配置事实
  // ---------------------------------------------------------------------

  let blocker: ForegroundPlanningBlocker | null = null;
  const commonDir = await resolveGitCommonDir({
    repositoryPath: options.repositoryPath,
    env: options.env,
  });
  let commonDirPath: string | null = commonDir.kind === 'resolved' ? commonDir.path : null;
  if (commonDir.kind === 'failed') {
    blocker = { code: 'repository_unresolved', message: commonDir.message };
  }

  let fullBranchRef: string | null = null;
  let canonicalWorktreePath: string | null = null;
  if (blocker === null) {
    const identity = await resolveGitScopeIdentity({
      repositoryPath: options.repositoryPath,
      env: options.env,
    });
    if (identity.kind === 'detached') {
      blocker = {
        code: 'detached_head',
        message: '当前 HEAD 处于 detached 状态：没有可登记的完整 branch ref',
      };
    } else if (identity.kind === 'failed') {
      blocker = { code: 'repository_unresolved', message: identity.message };
    } else if (identity.worktreeKind === 'linked') {
      // Scope 身份是「repository + ref + canonical worktree」的组合：从 Worker worktree 恢复会拿到
      // 另一个身份，因此这里拒绝而不是把链接 worktree 当成主 worktree。
      blocker = {
        code: 'worktree_not_canonical',
        message: `当前目录是链接 worktree（${identity.canonicalWorktreePath}）：Scope 身份绑定在 canonical worktree 上，请从主工作区启动`,
      };
    } else {
      fullBranchRef = identity.fullBranchRef;
      canonicalWorktreePath = identity.canonicalWorktreePath;
      commonDirPath = commonDirPath ?? identity.canonicalWorktreePath;
    }
  }

  let configPath: string | null = null;
  let config: ProjectConfig | null = null;
  if (blocker === null && canonicalWorktreePath !== null) {
    const loaded = loadProjectConfig({
      worktreePath: canonicalWorktreePath,
      ...(options.readFile === undefined ? {} : { readFile: options.readFile }),
    });
    if (loaded.kind === 'failed') {
      blocker = {
        code: 'config_unavailable',
        message: `${loaded.message}（期望文件 ${join(canonicalWorktreePath, PROJECT_CONFIG_FILENAME)}）`,
      };
    } else {
      configPath = loaded.path;
      config = loaded.config;
    }
  }

  const storeOpened =
    commonDirPath === null
      ? null
      : createCoordinationStore({ gitCommonDir: commonDirPath, clock });
  if (storeOpened !== null && storeOpened.kind === 'failed' && blocker === null) {
    blocker = { code: 'store_unavailable', message: storeOpened.message };
  }
  const store: BranchCoordinationStore | null = storeOpened !== null && storeOpened.kind === 'opened' ? storeOpened.store : null;

  let selectedScopeId: CoordinationScopeId | null = null;
  let scopeCheckpointStore: CheckpointStore | null = null;

  const requireStore = (): BranchCoordinationStore | null => (closed ? null : store);

  const checkpointStoreForScope = (): CheckpointStore | null => {
    if (scopeCheckpointStore !== null) {
      return scopeCheckpointStore;
    }
    if (commonDirPath === null) {
      return null;
    }
    const opened = openCheckpointStore({ databasePath: checkpointDatabasePath(commonDirPath), clock });
    if (opened.kind === 'failed') {
      return null;
    }
    scopeCheckpointStore = opened.store;
    return scopeCheckpointStore;
  };

  const scopeRecord = (scopeId: CoordinationScopeId): ScopeRecord | null => {
    const current = requireStore();
    if (current === null) {
      return null;
    }
    const result = current.query({ kind: 'scope', coordinationScopeId: scopeId });
    return result.kind === 'scope' ? result.scope : null;
  };

  /**
   * 从某个 Session 的已提交历史派生（或复用）可移植 Coordinator Context Capsule。
   *
   * 没有可派生历史、历史无法安全归类或落盘失败都是**拒绝交接**的理由：交接必须携带可移植的上下文，
   * 凭空给一个空引用会让 Target 接到的是一份来历不明的责任。规划交接与执行交接共用这一份语义。
   */
  const ensurePortableCapsule = (
    coordinatorSessionId: CoordinatorSessionId,
  ):
    | { readonly kind: 'ok'; readonly capsuleId: string }
    | { readonly kind: 'failed'; readonly reason: string } => {
    const checkpoints = checkpointStoreForScope();
    if (checkpoints === null) {
      return { kind: 'failed', reason: 'checkpoint store 不可用，无法读取源 Session 的历史' };
    }
    const existing = checkpoints.loadPortableCapsule(coordinatorSessionId);
    if (existing !== null) {
      return { kind: 'ok', capsuleId: existing.capsuleId };
    }
    const read = checkpoints.loadCheckpoint(coordinatorSessionId);
    if (read.kind !== 'recovered') {
      return {
        kind: 'failed',
        reason:
          read.kind === 'absent'
            ? '源 Session 还没有可恢复的会话记录，无法派生可移植 Capsule'
            : `源 Session 的会话记录不可恢复：${read.reason}`,
      };
    }
    const first = read.state.committedModelSteps[0];
    const last = read.state.committedModelSteps[read.state.committedModelSteps.length - 1];
    if (first === undefined || last === undefined) {
      return { kind: 'failed', reason: '源 Session 还没有可派生的已提交历史' };
    }
    try {
      const capsule = deriveContextCapsule({
        fromStepId: first.stepId,
        toStepId: last.stepId,
        steps: read.state.committedModelSteps.map((step) => ({
          stepId: step.stepId,
          messages: step.messages,
        })),
      });
      const saved = checkpoints.savePortableCapsule(coordinatorSessionId, capsule);
      if (saved.kind === 'failed') {
        return { kind: 'failed', reason: `无法持久化派生的 Context Capsule：${saved.message}` };
      }
      return { kind: 'ok', capsuleId: capsule.capsuleId };
    } catch (error) {
      return {
        kind: 'failed',
        reason: `源 Session 的已提交历史无法生成可移植 Capsule：${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  };

  /**
   * Home 解析：以 Git common dir 找到 store，再以**当前完整 ref 与登记的 canonical worktree**精确匹配。
   * 没有匹配就进入向导；缺少绑定的旧记录要求用户先确认一次性迁移，绝不按数量推断身份。
   */
  const resolveHome = (): HomeResolution => {
    if (blocker !== null) {
      return { kind: 'failed', code: blocker.code, message: blocker.message };
    }
    const current = requireStore();
    if (current === null) {
      return { kind: 'failed', code: 'store_unavailable', message: 'Branch Coordination State 不可用' };
    }
    if (fullBranchRef === null || canonicalWorktreePath === null) {
      // 没有可核验的 Git 身份时不做任何匹配：拿空值去比对等于猜身份。
      return { kind: 'failed', code: 'repository_unresolved', message: '缺少可核验的 Git 身份' };
    }
    const scopes = current.query({ kind: 'scopes' });
    if (scopes.kind !== 'scopes') {
      return {
        kind: 'failed',
        code: scopes.kind === 'rejected' ? scopes.code : 'invalid_state',
        message: scopes.kind === 'rejected' ? scopes.message : '无法读取 Coordination Scope 列表',
      };
    }
    const currentWorktree = canonicalPath(canonicalWorktreePath);
    const matches = scopes.scopes.filter(
      (scope) =>
        scope.fullBranchRef !== null &&
        scope.canonicalWorktreePath !== null &&
        scope.fullBranchRef === fullBranchRef &&
        canonicalPath(scope.canonicalWorktreePath) === currentWorktree,
    );
    const matched = matches[0];
    if (matched !== undefined) {
      selectedScopeId = matched.coordinationScopeId;
      return { kind: 'restore', coordinationScopeId: matched.coordinationScopeId };
    }
    const unbound = scopes.scopes.filter((scope) => scope.fullBranchRef === null);
    if (unbound.length > 0) {
      // 旧记录缺少绑定：只列出候选并要求用户在 Review 里确认一次性迁移，这里不进入任何 Scope。
      return {
        kind: 'legacy',
        candidates: unbound.map((scope) => ({
          coordinationScopeId: scope.coordinationScopeId,
          mode: scope.mode,
          controlState: scope.controlState,
        })),
        binding: { fullBranchRef, canonicalWorktreePath },
      };
    }
    return { kind: 'wizard' };
  };

  // ---------------------------------------------------------------------
  // 模型与 tracker
  // ---------------------------------------------------------------------

  const loadIntegration =
    options.loadIntegration ?? ((specifier: string) => import(specifier) as Promise<unknown>);
  const integrationResolver = createModuleIntegrationResolverAsync({
    load: (specifier) => loadIntegration(specifier),
  });

  const modelFor = async (
    configuration: CoordinatorModelConfiguration,
  ): Promise<
    | { readonly kind: 'resolved'; readonly model: BaseChatModel }
    | { readonly kind: 'failed'; readonly message: string }
  > => {
    const integration = await integrationResolver(configuration.providerIntegration);
    if (integration === null) {
      return {
        kind: 'failed',
        message: `provider 集成不可用：${configuration.providerIntegration}`,
      };
    }
    const resolved = resolveChatModel(configuration, () => integration);
    return resolved.kind === 'resolved'
      ? { kind: 'resolved', model: resolved.model }
      : { kind: 'failed', message: resolved.message };
  };

  const orcaProbe =
    options.orcaProbe ??
    createOrcaDoctorProbe({
      cwd: options.repositoryPath,
      env: options.env,
      identityWorktreePath: canonicalWorktreePath ?? options.repositoryPath,
    });

  const trackerFor = (): IssueTrackerGateway | null =>
    trackerFactory({ cwd: canonicalWorktreePath ?? options.repositoryPath, env: options.env });

  const routeMapRef = (): { readonly kind: 'route-map'; readonly id: string; readonly version: number } | null => {
    const scope = selectedScopeId === null ? null : scopeRecord(selectedScopeId);
    if (scope === null || config === null) {
      return null;
    }
    return {
      kind: 'route-map',
      id: String(config.tracker.routeMapIssueNumber),
      version: scope.mapRevision,
    };
  };

  // ---------------------------------------------------------------------
  // Session 装配
  // ---------------------------------------------------------------------

  const sessionConfiguration = (
    coordinatorSessionId: CoordinatorSessionId,
  ): CoordinatorModelConfiguration | null => {
    const current = requireStore();
    if (current === null || selectedScopeId === null || config === null) {
      return null;
    }
    const sessions = current.query({ kind: 'sessions', coordinationScopeId: selectedScopeId });
    if (sessions.kind !== 'sessions') {
      return null;
    }
    const registration = sessions.sessions.find(
      (session) => session.coordinatorSessionId === coordinatorSessionId,
    );
    if (registration === undefined) {
      return null;
    }
    return configurationByRef(config, registration.coordinatorModelConfigurationRef);
  };

  const planningMutationUsage = (scopeId: CoordinationScopeId): number | null => {
    const current = requireStore();
    if (current === null) {
      return null;
    }
    const intents = current.query({ kind: 'intents', coordinationScopeId: scopeId });
    if (intents.kind !== 'intents') {
      return null;
    }
    const ids = new Set(
      intents.intents
        .filter((intent) => PLANNING_MUTATION_CATEGORIES.has(intent.operationCategory))
        .map((intent) => intent.operationId),
    );
    return ids.size;
  };

  const planningFacts = (
    coordinatorSessionId: CoordinatorSessionId,
  ): PlanningToolFacts | null => {
    const current = requireStore();
    const scopeId = selectedScopeId;
    if (current === null || scopeId === null || config === null) {
      return null;
    }
    const scope = scopeRecord(scopeId);
    if (scope === null) {
      return null;
    }
    const handoffs = current.query({ kind: 'planning-handoffs', coordinationScopeId: scopeId });
    const responsibility = current.query({ kind: 'planning-responsibility', coordinationScopeId: scopeId });
    const used = planningMutationUsage(scopeId);
    if (handoffs.kind !== 'planning-handoffs' || responsibility.kind !== 'planning-responsibility' || used === null) {
      return null;
    }
    const pending =
      handoffs.handoffs.find((handoff) => handoff.phase === 'prepared' || handoff.phase === 'reviewed') ?? null;
    return {
      mode: scope.mode,
      controlState: scope.controlState,
      coordinationScopeId: scopeId,
      coordinatorSessionId,
      scopeRevision: scope.revision,
      activation: activationGate({
        proposal: pending,
        responsibility: responsibility.responsibility,
        coordinatorSessionId,
      }),
      permissions: { allowPlanningWrites: config.planning.maxMutations > 0 },
      budget: { remainingMutations: Math.max(0, config.planning.maxMutations - used) },
    };
  };

  /** 已收尾过的 operation 不再执行外部副作用，只按原身份核验结果。 */
  const replayOutcome = (
    scopeId: CoordinationScopeId,
    operationId: string,
  ): PlanningMutationResult | null => {
    const current = requireStore();
    if (current === null) {
      return null;
    }
    const intent = current.query({ kind: 'intent', coordinationScopeId: scopeId, operationId: operationId as never });
    if (intent.kind !== 'intent') {
      return { kind: 'unknown', reason: `无法对账 OperationId ${operationId} 的 Intent` };
    }
    if (intent.intent === null) {
      return null;
    }
    const record = intent.intent;
    if (record.state !== 'settled') {
      return {
        kind: 'unknown',
        reason: `OperationId ${operationId} 尚未收尾（${record.state}${record.blockingReason === null ? '' : `：${record.blockingReason}`}），不重复发起副作用`,
      };
    }
    const scope = scopeRecord(scopeId);
    if (scope === null) {
      return { kind: 'unknown', reason: `无法读取 Scope ${scopeId} 的当前 revision` };
    }
    return record.outcomeClass === 'accepted'
      ? { kind: 'accepted', revision: scope.revision, mapRevision: scope.mapRevision }
      : {
          kind: 'rejected',
          code: 'already_settled',
          message: `OperationId ${operationId} 已收尾为 rejected，不重复发起副作用`,
        };
  };

  const planningServices = (coordinatorSessionId: CoordinatorSessionId): PlanningToolServices | null => {
    const current = requireStore();
    const requestedScopeId = selectedScopeId;
    if (current === null || requestedScopeId === null) {
      return null;
    }
    // 本函数内所有引用都指向这一次读取到的非空 Scope，因此不再反复处理 nullable。
    const scopeId: CoordinationScopeId = requestedScopeId;
    const activeStore: BranchCoordinationStore = current;
    const factsOrNull = (): PlanningToolFacts => {
      const facts = planningFacts(coordinatorSessionId);
      if (facts === null) {
        throw new Error('无法读取当前规划事实');
      }
      return facts;
    };
    const liveSession = (): LiveSession | null => {
      const session = liveSessions.get(coordinatorSessionId);
      return session === undefined || session.fencingLost ? null : session;
    };
    const writerOf = (): CoordinationWriter | null => {
      const session = liveSession();
      return session === null ? null : writerFor(session.incarnation);
    };
    const tracker = trackerFor();
    const mutationContext = (
      operationId: string,
      expectedRevision: number,
    ): { readonly ok: true; readonly writer: CoordinationWriter; readonly mapRevision: number; readonly context: {
      readonly store: BranchCoordinationStore;
      readonly coordinationScopeId: CoordinationScopeId;
      readonly writer: CoordinationWriter;
      readonly operationId: OperationId;
      readonly expectedRevision: number;
      readonly routeMapRef: { readonly kind: 'route-map'; readonly id: string; readonly version: number };
      readonly planningCycleId: PlanningCycleId;
    } } | { readonly ok: false; readonly result: PlanningMutationResult } => {
      const writer = writerOf();
      const map = routeMapRef();
      const scope = scopeRecord(scopeId);
      if (writer === null) {
        return { ok: false, result: { kind: 'unknown', reason: '当前 Session 没有有效的写入身份' } };
      }
      if (map === null || scope === null || scope.planningCycleId === null) {
        return { ok: false, result: { kind: 'rejected', code: 'invalid_state', message: '缺少 Route Map 引用或 Planning Cycle' } };
      }
      return {
        ok: true,
        writer,
        mapRevision: scope.mapRevision,
        context: {
          store: current,
          coordinationScopeId: scopeId,
          writer,
          operationId: operationId as never,
          expectedRevision,
          routeMapRef: map,
          planningCycleId: scope.planningCycleId,
        },
      };
    };

    return {
      readFacts: factsOrNull,
      replayMutation: (operationId) => replayOutcome(scopeId, operationId),
      readRouteMap: async () => {
        const map = routeMapRef();
        const scope = scopeRecord(scopeId);
        if (map === null || scope === null || scope.planningCycleId === null || tracker === null) {
          return { kind: 'rejected', code: 'invalid_state', message: '缺少 Route Map 引用或 tracker' };
        }
        const read = await readRouteMap({ tracker, routeMapRef: map, planningCycleId: scope.planningCycleId });
        return read.kind === 'read'
          ? { kind: 'ok', value: read.snapshot }
          : read.kind === 'not_found'
            ? { kind: 'rejected', code: 'not_found', message: `Route Map issue ${map.id} 不存在` }
            : read.kind === 'unavailable'
              ? { kind: 'rejected', code: 'unavailable', message: read.message }
              : { kind: 'unknown', reason: read.reason };
      },
      readFrontier: async () => {
        const map = routeMapRef();
        const scope = scopeRecord(scopeId);
        if (map === null || scope === null || scope.planningCycleId === null || tracker === null) {
          return { kind: 'rejected', code: 'invalid_state', message: '缺少 Route Map 引用或 tracker' };
        }
        const read = await readRouteMap({ tracker, routeMapRef: map, planningCycleId: scope.planningCycleId });
        if (read.kind !== 'read') {
          return read.kind === 'not_found'
            ? { kind: 'rejected', code: 'not_found', message: `Route Map issue ${map.id} 不存在` }
            : read.kind === 'unavailable'
              ? { kind: 'rejected', code: 'unavailable', message: read.message }
              : { kind: 'unknown', reason: read.reason };
        }
        const snapshot = current.query({ kind: 'snapshot', coordinationScopeId: scopeId });
        const claims: readonly ClaimProjection[] =
          snapshot.kind === 'snapshot' ? snapshot.snapshot.ticketClaims : [];
        const openTicketLines = read.snapshot.sections.open_decision_tickets
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        return {
          kind: 'ok',
          value: {
            routeMapRef: map,
            planningCycleId: scope.planningCycleId,
            // 开放票据行来自 tracker 的权威章节；Frontier 的结构化解析（票据 id / 依赖 / assignee）
            // 需要一份尚未登记的票据语法，因此这里如实给出原文与本地 claim 事实，不发明格式。
            openDecisionTickets: openTicketLines,
            activeClaims: claims
              .filter((claim) => claim.state === 'active')
              .map((claim) => ({ ticketRef: claim.ticketRef, coordinatorSessionId: claim.coordinatorSessionId })),
          },
        };
      },
      updateRouteMapSection: async (input) => {
        const replay = replayOutcome(scopeId, input.operationId);
        if (replay !== null) {
          return replay;
        }
        const built = mutationContext(input.operationId, input.expectedRevision);
        if (!built.ok) {
          return built.result;
        }
        if (tracker === null) {
          return { kind: 'rejected', code: 'unavailable', message: 'tracker 不可用' };
        }
        return await updateRouteMapSection({
          ...built.context,
          tracker,
          section: input.section,
          content: input.content,
        });
      },
      claimTicket: async (input) => {
        const replay = replayOutcome(scopeId, input.operationId);
        if (replay !== null) {
          return replay;
        }
        const built = mutationContext(input.operationId, input.expectedRevision);
        if (!built.ok) {
          return built.result;
        }
        if (tracker === null) {
          return { kind: 'rejected', code: 'unavailable', message: 'tracker 不可用' };
        }
        const identity = await orcaProbe.readCoordinatorIdentity();
        return await claimTicket({
          ...built.context,
          tracker,
          ticketRef: { ...input.ticketRef, version: built.mapRevision },
          trackerAssignee: identity.ok ? identity.value : 'orca-companion',
        });
      },
      releaseTicket: async (input) => {
        const replay = replayOutcome(scopeId, input.operationId);
        if (replay !== null) {
          return replay;
        }
        const built = mutationContext(input.operationId, input.expectedRevision);
        if (!built.ok) {
          return built.result;
        }
        if (tracker === null) {
          return { kind: 'rejected', code: 'unavailable', message: 'tracker 不可用' };
        }
        return await releaseTicket({
          ...built.context,
          tracker,
          ticketRef: { ...input.ticketRef, version: built.mapRevision },
        });
      },
      resolveTicket: async (input) => {
        const mapOperationId = input.mapOperationId;
        if (mapOperationId === null) {
          return { kind: 'rejected', code: 'invalid_state', message: 'resolve_ticket 缺少地图写入的 OperationId' };
        }
        const replay = replayOutcome(scopeId, input.operationId);
        if (replay !== null) {
          if (replay.kind !== 'accepted') {
            return replay;
          }
          const snapshot = activeStore.query({ kind: 'snapshot', coordinationScopeId: scopeId });
          const completedClaim = snapshot.kind === 'snapshot' && snapshot.snapshot.ticketClaims.some(
            (claim) => claim.ticketRef.kind === input.ticketRef.kind &&
              claim.ticketRef.id === input.ticketRef.id &&
              claim.coordinatorSessionId === coordinatorSessionId && claim.state === 'completed',
          );
          if (!completedClaim) {
            return { kind: 'unknown', reason: `票据 ${input.ticketRef.id} 的释放意图已接受，但本地 completed claim 尚未核验` };
          }
          const mapReplay = replayOutcome(scopeId, mapOperationId);
          if (mapReplay !== null) {
            return mapReplay;
          }
          const scope = scopeRecord(scopeId);
          if (scope === null) {
            return { kind: 'unknown', reason: `无法读取 Scope ${scopeId}，地图阶段未启动` };
          }
          const continuation = mutationContext(mapOperationId, scope.revision);
          if (!continuation.ok) {
            return continuation.result;
          }
          if (tracker === null) {
            return { kind: 'rejected', code: 'unavailable', message: 'tracker 不可用' };
          }
          return await writeResolvedTicketMap({
            ...continuation.context,
            operationId: input.operationId,
            tracker,
            ticketRef: { ...input.ticketRef, version: continuation.mapRevision },
            resolution: input.resolution,
            mapOperationId,
          }, continuation.context.expectedRevision);
        }
        const built = mutationContext(input.operationId, input.expectedRevision);
        if (!built.ok) {
          return built.result;
        }
        if (tracker === null) {
          return { kind: 'rejected', code: 'unavailable', message: 'tracker 不可用' };
        }
        return await resolveTicket({
          ...built.context,
          tracker,
          ticketRef: { ...input.ticketRef, version: built.mapRevision },
          resolution: input.resolution,
          mapOperationId,
        });
      },
      preparePlanningHandoff: async (input) => {
        const built = await handoffFacts();
        if (built.kind !== 'ok') {
          return { kind: 'rejected', failure: built.failure };
        }
        // Capsule 引用由宿主从源 Session 的已提交历史派生：模型不能提供自己的引用，因此这里不使用
        // 工具参数里的 `capsuleRef`。派生失败即拒绝 prepare，责任仍留在源 Session。
        const capsule = ensureCapsule();
        if (capsule.kind === 'failed') {
          return { kind: 'rejected', failure: { code: 'capsule_unavailable', message: capsule.reason } };
        }
        return preparePlanningHandoff({
          store: activeStore,
          coordinationScopeId: scopeId,
          writer: built.writer,
          proposalId: input.proposalId,
          targetCoordinatorSessionId: input.targetCoordinatorSessionId,
          mapRevision: built.facts.currentMapRevision,
          planRevision: built.facts.currentPlanRevision,
          graphId: built.facts.candidate?.graphId ?? null,
          graphVersion: built.facts.candidate?.version ?? null,
          capsuleRef: capsule.capsuleId,
        });
      },
      reviewPlanningHandoff: async (input) => {
        const built = await handoffFacts();
        if (built.kind !== 'ok') {
          return { kind: 'rejected', failure: built.failure };
        }
        return reviewPlanningHandoff({
          store: current,
          coordinationScopeId: scopeId,
          writer: built.writer,
          proposalId: input.proposalId,
          facts: built.facts,
        });
      },
    };

    async function handoffFacts(): Promise<
      | {
          readonly kind: 'ok';
          readonly writer: CoordinationWriter;
          readonly facts: {
            readonly currentMapRevision: number;
            readonly currentPlanRevision: number;
            readonly openDecisionTickets: number;
            readonly candidate: GraphVersionRecord | null;
          };
        }
      | {
          readonly kind: 'failed';
          readonly failure: { readonly code: string; readonly message: string };
        }
    > {
      const writer = writerOf();
      const scope = scopeRecord(scopeId);
      if (writer === null || scope === null) {
        return {
          kind: 'failed',
          failure: { code: 'invalid_state', message: '当前 Session 没有有效的写入身份' },
        };
      }
      const graphId = scope.graphId;
      const versions = graphId === null ? null : activeStore.query({ kind: 'graph-versions', coordinationScopeId: scopeId, graphId });
      const candidateVersion = scope.graphVersion;
      const candidate =
        versions !== null && versions.kind === 'graph-versions' && candidateVersion !== null
          ? (versions.versions.find((version) => version.version === candidateVersion) ?? null)
          : null;
      return {
        kind: 'ok',
        writer,
        facts: {
          currentMapRevision: scope.mapRevision,
          currentPlanRevision: candidate === null ? 0 : candidate.version,
          openDecisionTickets: await countOpenDecisionTickets(),
          candidate,
        },
      };
    }

    async function countOpenDecisionTickets(): Promise<number> {
      const map = routeMapRef();
      const scope = scopeRecord(scopeId);
      if (map === null || scope === null || scope.planningCycleId === null || tracker === null) {
        return 0;
      }
      const read = await readRouteMap({ tracker, routeMapRef: map, planningCycleId: scope.planningCycleId });
      if (read.kind !== 'read') {
        return 0;
      }
      return read.snapshot.sections.open_decision_tickets
        .split('\n')
        .filter((line) => line.trim().length > 0).length;
    }

    /**
     * 源 Session 的可移植 Capsule：已有则复用，否则从已提交历史派生并先落盘。
     *
     * 没有可派生历史、历史无法安全归类或落盘失败都是**拒绝 prepare** 的理由：交接必须携带可移植的
     * 上下文，凭空给一个空引用会让 Target 接到的是一份来历不明的责任。
     */
    function ensureCapsule():
      | { readonly kind: 'ok'; readonly capsuleId: string }
      | { readonly kind: 'failed'; readonly reason: string } {
      return ensurePortableCapsule(coordinatorSessionId);
    }
  };

  // ---------------------------------------------------------------------
  // 模型输入与压缩
  // ---------------------------------------------------------------------

  /** 已提交条目按 step 分组形成片段；已有 Capsule 覆盖的区间不再逐字进入输入。 */
  const segmentsFromState = (state: CoordinatorSessionState): readonly HistorySegment[] => {
    const capsule = state.contextMaterial?.capsule ?? null;
    const native = state.contextMaterial?.nativeWindowOwner ?? null;
    if (native !== null) {
      return [{ kind: 'native-window', ownerRef: native.ownerRef, items: native.items }];
    }
    const covered = new Set<string>();
    if (capsule !== null) {
      const from = state.committedMessages.findIndex((entry) => entry.stepId === capsule.replacedFromStepId);
      const to = state.committedMessages.findLastIndex((entry) => entry.stepId === capsule.replacedToStepId);
      if (from >= 0 && to >= from) {
        for (const entry of state.committedMessages.slice(from, to + 1)) {
          covered.add(entry.entryId);
        }
      }
    }
    const grouped: HistorySegment[] = [];
    if (capsule !== null) {
      grouped.push({
        kind: 'capsule',
        capsuleId: capsule.capsuleId,
        text: capsule.text,
        replacedFromStepId: capsule.replacedFromStepId,
        replacedToStepId: capsule.replacedToStepId,
      });
    }
    let current: { kind: 'messages'; stepId: string; messages: CommittedMessageEntry[] } | null = null;
    for (const entry of state.committedMessages) {
      if (covered.has(entry.entryId)) {
        continue;
      }
      if (current === null || current.stepId !== entry.stepId) {
        current = { kind: 'messages', stepId: entry.stepId, messages: [] };
        grouped.push(current);
      }
      current.messages.push(entry);
    }
    return grouped;
  };

  const estimateTokens = (segments: readonly HistorySegment[]): number =>
    segments.reduce((total, segment) => {
      if (segment.kind === 'capsule') {
        return total + Math.ceil(segment.text.length / 4);
      }
      if (segment.kind === 'native-window') {
        return total;
      }
      return (
        total +
        segment.messages.reduce<number>((sum, message) => {
          const content = (message as { readonly content?: unknown }).content;
          return sum + (typeof content === 'string' ? Math.ceil((content.length + 16) / 4) : 0);
        }, 0)
      );
    }, 0);

  const estimatorInput = (segments: readonly HistorySegment[]): number => estimateTokens(segments);

  const persistCompaction = (
    coordinatorSessionId: CoordinatorSessionId,
    state: CoordinatorSessionState,
    input: ReturnType<typeof buildBoundedModelInput>,
  ): CoordinatorSessionState => {
    const checkpoints = checkpointStoreForScope();
    if (checkpoints === null) {
      return state;
    }
    if (input.compaction.kind === 'not_needed' && state.lastCompactionOutcome?.kind === 'not_needed') {
      return state;
    }
    const capsuleSegment = input.segments.find((segment) => segment.kind === 'capsule');
    const nativeSegment = input.segments.find((segment) => segment.kind === 'native-window');
    const next: CoordinatorSessionState = { ...state, lastCompactionOutcome: input.compaction };
    const saved = checkpoints.saveCheckpoint(next);
    if (saved.kind === 'failed') {
      throw new Error(`无法持久化压缩结论：${saved.message}`);
    }
    if (capsuleSegment !== undefined && capsuleSegment.kind === 'capsule') {
      checkpoints.savePortableCapsule(coordinatorSessionId, {
        kind: 'derived_context_capsule',
        capsuleId: capsuleSegment.capsuleId,
        replacedFromStepId: capsuleSegment.replacedFromStepId,
        replacedToStepId: capsuleSegment.replacedToStepId,
        text: capsuleSegment.text,
      });
    }
    if (nativeSegment !== undefined && nativeSegment.kind === 'native-window') {
      checkpoints.saveNativeWindowOwner(coordinatorSessionId, {
        ownerRef: nativeSegment.ownerRef,
        items: [...nativeSegment.items],
      });
    }
    return next;
  };

  const compactionViewOf = (state: CoordinatorSessionState | null): ControllerCompactionView | null => {
    const outcome = state?.lastCompactionOutcome ?? null;
    if (outcome === null) {
      return null;
    }
    switch (outcome.kind) {
      case 'not_needed':
        return { status: 'not_needed', path: outcome.path, reason: null, stillOverBudget: null };
      case 'compacted':
        return { status: 'compacted', path: outcome.path, reason: null, stillOverBudget: null };
      case 'compaction_degraded':
        return { status: 'compaction_degraded', path: outcome.path, reason: outcome.reason, stillOverBudget: null };
      default:
        return {
          status: 'context_exhausted',
          path: null,
          reason: outcome.reason,
          stillOverBudget: outcome.stillOverBudget,
        };
    }
  };

  const buildMessagesFor = (session: LiveSession) => (
    _state: unknown,
    currentWork: ProjectedActionableWorkItem | null,
  ): Promise<{ readonly messages: readonly unknown[]; readonly note: string }> => {
    const checkpoints = session.checkpoints;
    const read = checkpoints.loadCheckpoint(session.coordinatorSessionId);
    if (read.kind !== 'recovered') {
      throw new Error(
        read.kind === 'absent' ? '该 Session 还没有可恢复的会话记录' : `会话记录不可恢复：${read.reason}`,
      );
    }
    const tools = registeredToolsFor(session);
    const input = buildBoundedModelInput({
      segments: segmentsFromState(read.state),
      estimate: estimatorInput,
      fixedOverhead: toolSchemaTokens(tools),
      budgetTokens: config?.context.maxInputTokens ?? 100_000,
      native: { kind: 'unavailable', reason: 'provider 原生压缩未在本 change 接线' },
      shaken: false,
      instructions: FOREGROUND_COORDINATOR_INSTRUCTIONS,
      toolSchema: toolSchemaOf(tools),
      authoritativeFacts: authoritativeFactsFor(session),
      currentWork,
    });
    persistCompaction(session.coordinatorSessionId, read.state, input);
    if (input.compaction.kind === 'context_exhausted') {
      throw new Error(`上下文已耗尽：${input.compaction.reason}`);
    }
    if (input.compaction.kind === 'compaction_degraded') {
      throw new Error(`上下文压缩未取得进展：${input.compaction.reason}`);
    }
    return Promise.resolve({ messages: input.messages, note: input.compaction.kind });
  };

  const toolSchemaOf = (tools: readonly PlanningToolDefinition[]): readonly ToolSchemaEntry[] =>
    tools.map((definition) => ({
      name: definition.name,
      description: definition.description,
      schema: definition.inputSchema,
    }));

  const toolSchemaTokens = (tools: readonly PlanningToolDefinition[]): number =>
    Math.ceil(JSON.stringify(toolSchemaOf(tools)).length / 4);

  const authoritativeFactsFor = (session: LiveSession): readonly string[] => {
    const scope = selectedScopeId === null ? null : scopeRecord(selectedScopeId);
    if (scope === null) {
      return ['当前无法读取 Scope 事实；不要据此行动'];
    }
    return [
      `scope=${scope.coordinationScopeId} mode=${scope.mode} control=${scope.controlState} revision=${String(scope.revision)}`,
      `mapRevision=${String(scope.mapRevision)} graph=${scope.graphId ?? 'none'}@${String(scope.graphVersion ?? 0)}`,
      `session=${session.coordinatorSessionId} model=${session.configuration.configurationRef}`,
    ];
  };

  const registeredToolsFor = (session: LiveSession): readonly PlanningToolDefinition[] => {
    const facts = planningFacts(session.coordinatorSessionId);
    const services = planningServices(session.coordinatorSessionId);
    if (facts === null || services === null) {
      return [];
    }
    return registerPlanningTools({ mode: facts.mode, facts, services });
  };

  const recoveryToolsFor = (session: LiveSession): readonly PlanningToolDefinition[] => {
    const facts = planningFacts(session.coordinatorSessionId);
    const services = planningServices(session.coordinatorSessionId);
    return facts === null || services === null ? [] : planningRecoveryToolset(facts, services);
  };

  // ---------------------------------------------------------------------
  // Live Session 生命周期
  // ---------------------------------------------------------------------

  const stopHeartbeat = (session: LiveSession): void => {
    if (session.heartbeat !== null) {
      clearInterval(session.heartbeat);
      session.heartbeat = null;
    }
  };

  const startHeartbeat = (session: LiveSession): void => {
    stopHeartbeat(session);
    session.heartbeat = setInterval(() => {
      if (closed || session.fencingLost) {
        return;
      }
      const renewed = renewRuntimeLease(requiredStore(), {
        coordinationScopeId: session.incarnation.coordinationScopeId,
        coordinatorSessionId: session.coordinatorSessionId,
        runtimeIncarnationId: session.incarnation.runtimeIncarnationId,
        fencingGeneration: session.incarnation.fencingGeneration,
        ttlMs: leaseTtlMs,
      });
      if (renewed.kind === 'rejected') {
        session.fencingLost = true;
        stopHeartbeat(session);
        publish(session.coordinatorSessionId, {
          kind: 'blocked',
          coordinationScopeId: session.incarnation.coordinationScopeId,
          code: 'fencing_lost',
          message: `Runtime Lease 续约失败：${renewed.rejection.message}；本进程已停止该 Session 的模型调用与写入`,
        });
      }
    }, heartbeatIntervalMs);
  };

  const requiredStore = (): BranchCoordinationStore => {
    if (store === null) {
      throw new Error('Branch Coordination State 不可用');
    }
    return store;
  };

  type EnsureSessionResult =
    | { readonly kind: 'live'; readonly session: LiveSession }
    | { readonly kind: 'failed'; readonly code: ForegroundPlanningFailureCode; readonly message: string };

  const ensureLiveSession = async (
    coordinatorSessionId: CoordinatorSessionId,
  ): Promise<EnsureSessionResult> => {
    const existing = liveSessions.get(coordinatorSessionId);
    if (existing !== undefined) {
      return existing.fencingLost
        ? {
            kind: 'failed',
            code: 'fencing_lost',
            message: '该 Session 的 Runtime Lease 续约已失败：请重启前台进程后重新核验',
          }
        : { kind: 'live', session: existing };
    }
    if (blocker !== null) {
      return { kind: 'failed', code: blocker.code, message: blocker.message };
    }
    if (selectedScopeId === null) {
      return { kind: 'failed', code: 'scope_unavailable', message: '当前没有选中的 Coordination Scope' };
    }
    const configuration = sessionConfiguration(coordinatorSessionId);
    if (configuration === null) {
      return {
        kind: 'failed',
        code: 'model_unavailable',
        message: `Session ${coordinatorSessionId} 登记的 Coordinator Model Configuration 不在项目配置中`,
      };
    }
    if (commonDirPath === null) {
      return { kind: 'failed', code: 'repository_unresolved', message: '无法解析 Git common dir' };
    }
    const started = await startCoordinatorRuntime({
      coordinationScopeId: selectedScopeId,
      coordinatorSessionId,
      runtimeIncarnationId: `${coordinatorSessionId}:${newId()}` as RuntimeIncarnationId,
      configuration,
      resolveModel: async () => await modelFor(configuration),
      gitCommonDir: commonDirPath,
      coordinationStore: requiredStore(),
      ttlMs: leaseTtlMs,
      clock,
      ...(options.probeTimeoutMs === undefined ? {} : { probeTimeoutMs: options.probeTimeoutMs }),
    });
    if (started.kind === 'rejected') {
      return {
        kind: 'failed',
        code: started.code === 'model_resolution_failed' ? 'model_unavailable' : 'session_unavailable',
        message: started.message,
      };
    }
    const session: LiveSession = {
      coordinatorSessionId,
      incarnation: started.incarnation,
      configuration,
      model: started.model,
      checkpoints: started.checkpoints,
      graph: null,
      heartbeat: null,
      fencingLost: false,
      loopRunning: false,
      pendingWake: null,
      inFlightModelOperations: 0,
    };
    const withGraph: LiveSession = {
      ...session,
      graph: buildCoordinatorGraph({
        model: started.model,
        checkpointer: started.checkpointer,
        sessionRecords: started.checkpoints,
        assertFencing: () => assertFencingGeneration(requiredStore(), started.incarnation, { clock }),
        buildMessages: buildMessagesFor(session),
        newStepId: () => `${coordinatorSessionId}:step:${newId()}`,
        clock,
        planningTools: registeredToolsFor(session),
        recoveryTools: recoveryToolsFor(session),
      }),
    };
    liveSessions.set(coordinatorSessionId, withGraph);
    startHeartbeat(withGraph);
    // 「提交后崩溃」的恢复路径：会话历史里还有未被回答的用户消息时，Session 一被打开就恢复模型，
    // 而不是等用户再发一条消息。没有待处理工作时这一次调用会立刻返回。
    void runModelLoop(withGraph);
    return { kind: 'live', session: withGraph };
  };

  const liveStateOf = (session: LiveSession): CoordinatorSessionState | null => {
    const read = session.checkpoints.loadCheckpoint(session.coordinatorSessionId);
    return read.kind === 'recovered' ? read.state : null;
  };

  /**
   * 最后一个已提交 model step 里尚未配对的 tool call 数。
   *
   * 重启后据此让图先进 tools 节点补齐结果，再回到模型：配对身份来自 step 自身，因此补齐不会
   * 换 operation 身份，也不会重复发起已接受的副作用。派生规则由 workflow 拥有（`pendingToolCallsIn`），
   * 这里只做转发，避免出现第二份「什么算已配对」的判断。
   */
  const pendingToolCallsOf = (state: CoordinatorSessionState): number => pendingToolCallsIn(state);

  const answerEntryId = (interactionId: InteractionId): string => `entry:interaction-answer:${interactionId}`;

  const answeredInteractionsFor = (session: LiveSession): readonly PendingInteractionRecord[] => {
    const snapshot = requiredStore().query({
      kind: 'snapshot', coordinationScopeId: session.incarnation.coordinationScopeId,
    });
    if (snapshot.kind !== 'snapshot') {
      throw new Error('无法读取已回答的 Pending Interaction');
    }
    const answers = snapshot.snapshot.pendingInteractions.filter(
      (interaction) => interaction.ownerCoordinatorSessionId === session.coordinatorSessionId &&
        interaction.state === 'answered',
    );
    if (answers.some((interaction) => interaction.answerText === null)) {
      throw new Error('已回答的 Pending Interaction 缺少正文');
    }
    return answers;
  };

  /** Branch 回答是权威；checkpoint 只记录稳定引用，使崩溃后仍可识别未处理工作。 */
  const syncAnsweredInteractions = (session: LiveSession): void => {
    const answers = answeredInteractionsFor(session);
    const state = liveStateOf(session);
    if (state === null) throw new Error('无法读回 Session checkpoint');
    const existing = new Set(state.committedMessages.map((entry) => entry.entryId));
    const missing = answers.filter((answer) => !existing.has(answerEntryId(answer.interactionId)));
    if (missing.length === 0) return;
    const fencing = assertFencingGeneration(requiredStore(), session.incarnation, { clock });
    if (fencing.kind === 'fenced') throw new Error(`写入回答引用前失去 Runtime Lease：${fencing.code}`);
    const written = session.checkpoints.saveCheckpoint({
      ...state,
      committedMessages: [
        ...state.committedMessages,
        ...missing.sort((left, right) => (left.resolvedAt ?? 0) - (right.resolvedAt ?? 0)).map((answer) => ({
          entryId: answerEntryId(answer.interactionId),
          stepId: `interaction-answer:${answer.interactionId}`,
          role: 'system' as const,
          content: `Pending Interaction ${answer.interactionId} 的回答引用`,
        })),
      ],
    });
    if (written.kind === 'failed') throw new Error(`无法保存回答引用：${written.message}`);
  };

  // ---------------------------------------------------------------------
  // Actionable Work 与模型循环
  // ---------------------------------------------------------------------

  /**
   * 当前需要模型处理的有界工作。
   *
   * 用户消息与 Branch 中已回答交互的稳定引用按历史顺序排队；最终 assistant 响应消费队首。
   */
  const pendingWorkFor = (session: LiveSession): readonly ProjectedActionableWorkItem[] => {
    const state = liveStateOf(session);
    if (state === null) {
      return [];
    }
    const answers = new Map(answeredInteractionsFor(session).map((answer) => [answerEntryId(answer.interactionId), answer]));
    const historyItems: ProjectedActionableWorkItem[] = [];
    for (const entry of state.committedMessages) {
      if (entry.role === 'assistant' && (entry.toolCalls?.length ?? 0) === 0) {
        historyItems.shift();
        continue;
      }
      if (entry.role === 'user') {
        const submissionId = entry.entryId.replace(/^entry:user:/u, '');
        historyItems.push({
          source: { sourceKind: 'user-message', sourceId: submissionId, revision: 1 },
          workKind: 'user_message',
          summary: entry.content.slice(0, 240),
        });
        continue;
      }
      const answer = answers.get(entry.entryId);
      if (answer !== undefined) {
        historyItems.push({
          source: { sourceKind: 'interaction-answer', sourceId: answer.interactionId, revision: 1 },
          workKind: 'pending_interaction',
          summary: `Pending Interaction ${answer.interactionId} 已被回答：${answer.answerText ?? ''}`,
        });
      }
    }
    return historyItems;
  };

  const runModelLoop = async (session: LiveSession): Promise<void> => {
    if (session.fencingLost) {
      return;
    }
    // Pause/Cancel 期间不恢复模型：消息可以落盘，但模型只在 Resume 对账后处理。
    const controlState = scopeRecord(session.incarnation.coordinationScopeId)?.controlState ?? 'active';
    if (controlState !== 'active') {
      return;
    }
    if (session.loopRunning) {
      session.pendingWake = [];
      return;
    }
    session.loopRunning = true;
    session.inFlightModelOperations += 1;
    try {
      syncAnsweredInteractions(session);
      let work = pendingWorkFor(session);
      while (work.length > 0 && !session.fencingLost && session.graph !== null) {
        const scope = selectedScopeId === null ? null : scopeRecord(selectedScopeId);
        const state = liveStateOf(session);
        if (scope === null || state === null) {
          return;
        }
        if (state.lastCompactionOutcome?.kind === 'context_exhausted') {
          publish(session.coordinatorSessionId, {
            kind: 'blocked',
            coordinationScopeId: scope.coordinationScopeId,
            code: 'context_exhausted',
            message: '上下文已耗尽：请先手动压缩或交接该 Session',
          });
          return;
        }
        const result = (await session.graph.invoke(
          {
            coordinatorSessionId: session.coordinatorSessionId,
            remainingWork: work,
            deferredWork: 0,
            pendingToolCalls: pendingToolCallsOf(state),
          },
          { configurable: { thread_id: threadIdFor(session.coordinatorSessionId) }, ...COORDINATOR_INVOKE_DEFAULTS },
        )) as {
          readonly status: string;
          readonly note: string;
          readonly remainingWork: readonly ProjectedActionableWorkItem[];
        };
        publish(session.coordinatorSessionId, {
          kind: 'state-changed',
          coordinationScopeId: session.incarnation.coordinationScopeId,
          revision: scope.revision,
          reason: `model:${result.status}:${result.note}`,
        });
        if (result.status !== 'running') {
          return;
        }
        work = result.remainingWork.length > 0 ? result.remainingWork : pendingWorkFor(session);
      }
    } catch (error) {
      publish(session.coordinatorSessionId, {
        kind: 'blocked',
        coordinationScopeId: session.incarnation.coordinationScopeId,
        code: 'model_loop_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      session.inFlightModelOperations -= 1;
      session.loopRunning = false;
      const queued = session.pendingWake;
      session.pendingWake = null;
      if (queued !== null && !session.fencingLost) {
        void runModelLoop(session);
      }
    }
  };

  // ---------------------------------------------------------------------
  // Controller 端口
  // ---------------------------------------------------------------------

  const accepted = (summary: string, revision: number | null = null): ControllerCommandResult => ({
    kind: 'accepted',
    revision,
    summary,
  });

  const rejected = (code: string, message: string): ControllerCommandResult => ({
    kind: 'rejected',
    code,
    message,
  });

  const sessionMessages = async (input: {
    readonly coordinatorSessionId: CoordinatorSessionId;
    readonly submissionId: string;
    readonly content: string;
  }): Promise<ControllerCommandResult> => {
    const ensured = await ensureLiveSession(input.coordinatorSessionId);
    if (ensured.kind === 'failed') {
      return rejected(ensured.code, ensured.message);
    }
    const session = ensured.session;
    const result = submitUserMessage({
      store: requiredStore(),
      checkpoints: session.checkpoints,
      incarnation: session.incarnation,
      coordinatorSessionId: input.coordinatorSessionId,
      submissionId: input.submissionId,
      content: input.content,
      clock,
    });
    switch (result.kind) {
      case 'rejected':
        return rejected(result.code, result.message);
      case 'blocked':
        return rejected('checkpoint_unrecoverable', result.reason);
      default: {
        publish(session.coordinatorSessionId, {
          kind: 'state-changed',
          coordinationScopeId: session.incarnation.coordinationScopeId,
          revision: result.state.graphPosition.length,
          reason: `user-message:${result.submissionId}`,
        });
        if (result.wakeModel) {
          void runModelLoop(session);
        }
        return accepted(`已提交用户消息 ${result.submissionId}`);
      }
    }
  };

  const compaction = async (input: {
    readonly coordinatorSessionId: CoordinatorSessionId;
    readonly reason: string;
  }): Promise<ControllerCommandResult> => {
    const ensured = await ensureLiveSession(input.coordinatorSessionId);
    if (ensured.kind === 'failed') {
      return rejected(ensured.code, ensured.message);
    }
    const session = ensured.session;
    const result = requestSessionCompaction({
      store: requiredStore(),
      checkpoints: session.checkpoints,
      incarnation: session.incarnation,
      coordinatorSessionId: input.coordinatorSessionId,
      reason: input.reason,
      inFlightModelOperations: session.inFlightModelOperations,
      clock,
      compact: (state) => {
        const tools = registeredToolsFor(session);
        const built = buildBoundedModelInput({
          segments: segmentsFromState(state),
          estimate: estimatorInput,
          fixedOverhead: toolSchemaTokens(tools),
          budgetTokens: config?.context.maxInputTokens ?? 100_000,
          native: { kind: 'unavailable', reason: 'provider 原生压缩未在本 change 接线' },
          shaken: false,
          instructions: FOREGROUND_COORDINATOR_INSTRUCTIONS,
          toolSchema: toolSchemaOf(tools),
          authoritativeFacts: authoritativeFactsFor(session),
          currentWork: null,
        });
        const capsuleSegment = built.segments.find((segment) => segment.kind === 'capsule');
        const nativeSegment = built.segments.find((segment) => segment.kind === 'native-window');
        return {
          outcome: built.compaction,
          capsule:
            capsuleSegment === undefined || capsuleSegment.kind !== 'capsule'
              ? null
              : {
                  kind: 'derived_context_capsule' as const,
                  capsuleId: capsuleSegment.capsuleId,
                  replacedFromStepId: capsuleSegment.replacedFromStepId,
                  replacedToStepId: capsuleSegment.replacedToStepId,
                  text: capsuleSegment.text,
                },
          nativeWindowOwner:
            nativeSegment === undefined || nativeSegment.kind !== 'native-window'
              ? null
              : { ownerRef: nativeSegment.ownerRef, items: [...nativeSegment.items] },
        };
      },
    });
    if (result.kind === 'rejected') {
      return rejected(result.code, result.message);
    }
    if (result.kind === 'blocked') {
      return rejected('compaction_blocked', result.reason);
    }
    publish(session.coordinatorSessionId, {
      kind: 'state-changed',
      coordinationScopeId: session.incarnation.coordinationScopeId,
      revision: 0,
      reason: `compaction:${result.outcome.kind}`,
    });
    return accepted(`压缩结论：${result.outcome.kind}`);
  };

  const modelConfiguration = async (input: {
    readonly coordinatorSessionId: CoordinatorSessionId;
    readonly nextConfigurationRef: string;
  }): Promise<ControllerCommandResult> => {
    if (config === null) {
      return rejected('config_unavailable', '项目配置不可用');
    }
    const next = configurationByRef(config, input.nextConfigurationRef);
    if (next === null) {
      return rejected('unknown_configuration', `配置 ${input.nextConfigurationRef} 不在项目配置中`);
    }
    const ensured = await ensureLiveSession(input.coordinatorSessionId);
    if (ensured.kind === 'failed') {
      return rejected(ensured.code, ensured.message);
    }
    const session = ensured.session;
    const state = liveStateOf(session);
    const result = await switchModelConfiguration({
      coordinatorSessionId: input.coordinatorSessionId,
      current: session.configuration,
      next,
      switchability: {
        suspension:
          state !== null && state.graphPosition === 'suspend'
            ? {
                kind: 'suspended',
                coordinationScopeId: session.incarnation.coordinationScopeId,
                coordinatorSessionId: input.coordinatorSessionId,
                graphPosition: state.graphPosition,
                suspendedAt: clock(),
                reason: 'no_actionable_work',
                deferredActionableWork: 0,
              }
            : null,
        inFlightModelOperations: session.inFlightModelOperations,
      },
      sessionRecords: session.checkpoints,
      nativeWindows: session.checkpoints,
      deriveCapsule: (capsuleInput) => deriveContextCapsule(capsuleInput),
      verify: async (candidate) => {
        const resolved = await modelFor(candidate);
        return resolved.kind === 'resolved'
          ? { kind: 'verified' }
          : { kind: 'rejected', message: resolved.message };
      },
      persistConfiguration: (candidate) => {
        const written = requiredStore().transact({
          kind: 'update-session-model-configuration',
          coordinationScopeId: session.incarnation.coordinationScopeId,
          expectedRevision: scopeRecord(session.incarnation.coordinationScopeId)?.revision ?? 0,
          writer: writerFor(session.incarnation),
          coordinatorSessionId: input.coordinatorSessionId,
          coordinatorModelConfigurationRef: candidate.configurationRef,
        });
        return written.kind === 'committed'
          ? { kind: 'saved' }
          : { kind: 'failed', message: written.message };
      },
      clearDerivedCaches: () => {
        session.pendingWake = null;
        return 0;
      },
    });
    if (result.kind === 'rejected') {
      return rejected(result.code, result.message);
    }
    const resolved = await modelFor(result.configuration);
    if (resolved.kind === 'failed') {
      return rejected('model_unavailable', resolved.message);
    }
    const replacement: LiveSession = {
      ...session,
      configuration: result.configuration,
      model: resolved.model,
      graph: buildCoordinatorGraph({
        model: resolved.model,
        checkpointer: session.checkpoints.checkpointer,
        sessionRecords: session.checkpoints,
        assertFencing: () => assertFencingGeneration(requiredStore(), session.incarnation, { clock }),
        buildMessages: buildMessagesFor({ ...session, configuration: result.configuration }),
        newStepId: () => `${input.coordinatorSessionId}:step:${newId()}`,
        clock,
        planningTools: registeredToolsFor({ ...session, configuration: result.configuration }),
        recoveryTools: recoveryToolsFor({ ...session, configuration: result.configuration }),
      }),
    };
    liveSessions.set(input.coordinatorSessionId, replacement);
    publish(input.coordinatorSessionId, {
      kind: 'state-changed',
      coordinationScopeId: session.incarnation.coordinationScopeId,
      revision: 0,
      reason: `model-configuration:${result.configuration.configurationRef}`,
    });
    return accepted(`已切换到 ${result.configuration.configurationRef}`);
  };

  const pendingInteractionAnswer = async (input: {
    readonly interactionId: InteractionId;
    readonly expectedRevision: number;
    readonly answer: string;
    readonly ownerCoordinatorSessionId: CoordinatorSessionId;
  }): Promise<ControllerCommandResult> => {
    const ensured = await ensureLiveSession(input.ownerCoordinatorSessionId);
    if (ensured.kind === 'failed') {
      return rejected(ensured.code, ensured.message);
    }
    const session = ensured.session;
    const result = answerPendingInteraction({
      store: requiredStore(),
      coordinationScopeId: session.incarnation.coordinationScopeId,
      writer: writerFor(session.incarnation),
      interactionId: input.interactionId,
      expectedRevision: input.expectedRevision,
      answer: input.answer,
    });
    if (result.kind === 'rejected') {
      return rejected(result.code, result.message);
    }
    publish(session.coordinatorSessionId, {
      kind: 'interaction-resolved',
      coordinationScopeId: session.incarnation.coordinationScopeId,
      interactionId: input.interactionId,
    });
    void runModelLoop(session);
    return accepted(`已回答 Pending Interaction ${input.interactionId}`, result.revision);
  };

  // ---------------------------------------------------------------------
  // 投影（snapshot / transcript）
  // ---------------------------------------------------------------------

  const readSnapshot = async (selectedSessionId: string | null): Promise<SnapshotLoad> => {
    if (blocker !== null) {
      return { kind: 'failed', code: blocker.code, message: blocker.message };
    }
    const current = requireStore();
    if (current === null || selectedScopeId === null) {
      return { kind: 'failed', code: 'scope_unavailable', message: '当前没有可读取的 Coordination Scope' };
    }
    const snapshot = current.query({ kind: 'snapshot', coordinationScopeId: selectedScopeId });
    if (snapshot.kind !== 'snapshot') {
      return {
        kind: 'failed',
        code: snapshot.kind === 'rejected' ? snapshot.code : 'invalid_state',
        message: snapshot.kind === 'rejected' ? snapshot.message : 'snapshot 查询返回了非预期结果',
      };
    }
    const counters = current.query({ kind: 'budget-counters', coordinationScopeId: selectedScopeId });
    const graphId = snapshot.snapshot.scope.graphId;
    const versions =
      graphId === null
        ? ({ kind: 'graph-versions', versions: [] } as const)
        : current.query({ kind: 'graph-versions', coordinationScopeId: selectedScopeId, graphId });
    const authorizations = current.query({ kind: 'authorizations', coordinationScopeId: selectedScopeId });
    const authorization =
      authorizations.kind === 'authorizations'
        ? authorizations.authorizations.find(
            (entry) => entry.authorizationId === snapshot.snapshot.scope.authorizationId,
          )
        : undefined;
    const selectedState =
      selectedSessionId === null
        ? null
        : (checkpointStoreForScope()?.loadCheckpoint(selectedSessionId as CoordinatorSessionId) ?? null);
    const graphVersions = versions.kind === 'graph-versions' ? versions.versions : [];
    const currentVersion =
      graphId === null
        ? null
        : (graphVersions.find((version) => version.version === snapshot.snapshot.scope.graphVersion) ??
          graphVersions.at(-1) ??
          null);
    const generation =
      snapshot.snapshot.graphGenerations.find((entry) => entry.graphId === graphId) ?? null;
    const nodes =
      currentVersion === null
        ? []
        : currentVersion.graph.workPackages.map((workPackage) => ({
            workPackageId: workPackage.workPackageId,
            dependsOn: [...workPackage.dependsOn],
          }));
    const observations = await executionObservations(snapshot.snapshot.scope, nodes);
    const derived = executionDerivation({
      snapshot: snapshot.snapshot,
      scope: snapshot.snapshot.scope,
      observations,
      nodes,
      baselineHead: generation?.baselineHead ?? null,
      authority: authorization?.manifest.permissions ?? null,
      recoveryBudgetLimit: authorization?.manifest.limits.maxRecoveriesPerWorkerAttempt ?? null,
    });
    const projected: ControllerSnapshot = projectControllerSnapshot({
      snapshot: snapshot.snapshot,
      budgets: counters.kind === 'budget-counters' ? counters.counters : [],
      graphGeneration: generation?.generation ?? null,
      frontier: derived.execution.frontier,
      workers: derived.workers,
      execution: derived.execution,
      recoveryBudgetLimit: authorization?.manifest.limits.maxRecoveriesPerWorkerAttempt ?? null,
      extraBlockers: [],
      maintenance: null,
      selectedSessionId: selectedSessionId as CoordinatorSessionId | null,
      graphVersions,
      authorizationGraphRef:
        authorization === undefined
          ? null
          : {
              graphId: authorization.manifest.graph.graphId,
              graphVersion: authorization.manifest.graph.version,
            },
      compaction:
        selectedState !== null && selectedState.kind === 'recovered'
          ? compactionViewOf(selectedState.state)
          : null,
    });
    return { kind: 'snapshot', snapshot: projected };
  };

  const readTranscript = (coordinatorSessionId: string): TranscriptLoad => {
    const checkpoints = checkpointStoreForScope();
    if (checkpoints === null) {
      return { kind: 'failed', code: 'checkpoint_store_unavailable', message: 'checkpoint store 不可读' };
    }
    const read = checkpoints.loadCheckpoint(coordinatorSessionId as CoordinatorSessionId);
    if (read.kind !== 'recovered') {
      return {
        kind: 'failed',
        code: read.kind,
        message: `Session ${coordinatorSessionId} 没有可恢复的会话记录`,
      };
    }
    const entries = read.state.committedMessages.filter((entry) => entry.role !== 'system').slice(-TRANSCRIPT_WINDOW);
    const messages: ControllerTranscriptMessage[] = entries.map((entry) =>
      entry.role === 'tool'
        ? {
            role: 'tool',
            content: `${entry.toolName ?? 'tool'}\n${entry.content}`,
            stepId: entry.entryId,
          }
        : { role: entry.role, content: entry.content, stepId: entry.stepId },
    );
    const page: ControllerTranscriptPage = {
      coordinatorSessionId,
      messages,
      nextCursor: null,
    };
    return { kind: 'transcript', transcript: page };
  };

  // ---------------------------------------------------------------------
  // 向导
  // ---------------------------------------------------------------------

  const wizardProposal = (): WizardProposal => ({
    coordinationScopeId: newId(),
    coordinatorSessionId: newId(),
    coordinatorModelConfigurationRef: config?.defaultCoordinatorModelRef ?? '',
    planningCycleId: newId(),
    repositoryPath: options.repositoryPath,
    canonicalWorktree: canonicalWorktreePath ?? options.repositoryPath,
    trackerRef: config === null ? '' : `github#${String(config.tracker.routeMapIssueNumber)}`,
  });

  const scopeSetup: ScopeSetupPort = {
    resolveHome: () => Promise.resolve(resolveHome()),
    verify: async (): Promise<readonly WizardCheck[]> => {
      const checks: WizardCheck[] = [];
      checks.push({
        id: 'repository',
        ok: blocker === null || blocker.code !== 'repository_unresolved',
        detail:
          fullBranchRef === null || canonicalWorktreePath === null
            ? (blocker?.message ?? '无法读取当前 Git 身份')
            : `${canonicalWorktreePath} @ ${fullBranchRef}`,
      });
      const orcaVersion = await orcaProbe.readOrcaVersion();
      const runtime = await orcaProbe.readRuntime();
      const identity = await orcaProbe.readCoordinatorIdentity();
      checks.push({
        id: 'orca',
        ok: orcaVersion.ok && runtime.ok && runtime.value.reachable,
        detail: orcaVersion.ok
          ? runtime.ok
            ? `version ${orcaVersion.value} · runtime ${runtime.value.state}`
            : runtime.detail
          : orcaVersion.detail,
      });
      checks.push({
        id: 'identity',
        ok: identity.ok,
        detail: identity.ok ? identity.value : identity.detail,
      });
      checks.push({
        id: 'model',
        ok: false,
        detail: '待核验',
      });
      if (config === null) {
        checks[3] = { id: 'model', ok: false, detail: blocker?.message ?? '项目配置不可用' };
        checks.push({ id: 'tracker', ok: false, detail: '项目配置不可用：无法确定 tracker 地图' });
        return checks;
      }
      const resolved = await modelFor(config.defaultCoordinatorModelRef === '' ? config.coordinatorModels[0]! : configurationByRef(config, config.defaultCoordinatorModelRef) ?? config.coordinatorModels[0]!);
      checks[3] = {
        id: 'model',
        ok: resolved.kind === 'resolved',
        detail: resolved.kind === 'resolved' ? config.defaultCoordinatorModelRef : resolved.message,
      };
      const tracker = trackerFor();
      const mapRef = { kind: 'route-map' as const, id: String(config.tracker.routeMapIssueNumber), version: 0 };
      const mapRead = tracker === null ? null : await tracker.readIssue(mapRef);
      checks.push({
        id: 'tracker',
        ok: mapRead !== null && mapRead.kind === 'read',
        detail:
          mapRead === null
            ? 'tracker 不可用'
            : mapRead.kind === 'read'
              ? `${PROJECT_CONFIG_FILENAME}: github#${String(config.tracker.routeMapIssueNumber)}`
              : mapRead.kind === 'not_found'
                ? `Route Map issue ${String(config.tracker.routeMapIssueNumber)} 不存在`
                : mapRead.kind === 'unavailable'
                  ? mapRead.message
                  : mapRead.reason,
      });
      return checks;
    },
    proposal: () => Promise.resolve(wizardProposal()),
    initialize: (proposal): Promise<ControllerCommandResult> => Promise.resolve(initializeScope(proposal)),
    bindLegacyIdentity: (coordinationScopeId): Promise<ControllerCommandResult> =>
      Promise.resolve(bindLegacyIdentity(coordinationScopeId)),
  };

  /**
   * 旧 Scope 的一次性身份绑定。
   *
   * 只在用户于 Home 的 Review 里明确确认后调用：写入的绑定就是当前 Git 身份，`expectedRevision` 是刚读到的
   * Scope revision，与库内不一致即按 stale 拒绝，不从 cwd 猜值。绑定成功后本进程才把该 Scope 登记为当前
   * Scope——在这之前 Home 不会进入它。
   */
  const bindLegacyIdentity = (coordinationScopeId: string): ControllerCommandResult => {
    if (blocker !== null) {
      return rejected(blocker.code, blocker.message);
    }
    if (fullBranchRef === null || canonicalWorktreePath === null) {
      return rejected('scope_unavailable', '缺少可核验的 Git 身份');
    }
    const current = requiredStore();
    const scope = scopeRecord(coordinationScopeId as CoordinationScopeId);
    if (scope === null) {
      return rejected('not_found', `Coordination Scope ${coordinationScopeId} 不存在`);
    }
    const sessions = current.query({ kind: 'sessions', coordinationScopeId: scope.coordinationScopeId });
    const session = sessions.kind === 'sessions' ? sessions.sessions[0] : undefined;
    if (session === undefined) {
      return rejected('invalid_state', `Coordination Scope ${coordinationScopeId} 没有可用的 Coordinator Session`);
    }
    const bound = bindScopeIdentity({
      store: current,
      coordinationScopeId: scope.coordinationScopeId,
      coordinatorSessionId: session.coordinatorSessionId,
      expectedRevision: scope.revision,
      fullBranchRef,
      canonicalWorktreePath,
    });
    if (bound.kind === 'rejected') {
      return rejected(bound.code, bound.message);
    }
    selectedScopeId = scope.coordinationScopeId;
    publish(null, {
      kind: 'state-changed',
      coordinationScopeId: scope.coordinationScopeId,
      revision: bound.revision,
      reason: 'scope-identity-bound',
    });
    return accepted(`已为旧记录 ${coordinationScopeId} 补齐身份绑定`, bound.revision);
  };

  /**
   * 向导确认后的单次初始化。
   *
   * 登记的是**当前 Git 身份**：调用方提交的 proposal 必须与本次核验到的 canonical worktree 一致，
   * 否则拒绝——不允许把一个路径的提案落到另一个路径的仓库上。
   */
  const initializeScope = (proposal: WizardProposal): ControllerCommandResult => {
      if (blocker !== null) {
        return rejected(blocker.code, blocker.message);
      }
      if (fullBranchRef === null || canonicalWorktreePath === null || config === null) {
        return rejected('config_unavailable', '缺少可核验的 Git 身份或项目配置');
      }
      if (proposal.canonicalWorktree !== canonicalWorktreePath || proposal.repositoryPath !== options.repositoryPath) {
        return rejected(
          'binding_mismatch',
          `登记的 canonical worktree ${proposal.canonicalWorktree} 与当前 ${canonicalWorktreePath} 不一致`,
        );
      }
      const current = requiredStore();
      const initialized = initializeCoordinationScope({
        store: current,
        coordinationScopeId: proposal.coordinationScopeId as CoordinationScopeId,
        coordinatorSessionId: proposal.coordinatorSessionId as CoordinatorSessionId,
        coordinatorModelConfigurationRef: proposal.coordinatorModelConfigurationRef,
        planningCycleId: proposal.planningCycleId as never,
        fullBranchRef,
        canonicalWorktreePath,
      });
      if (initialized.kind === 'rejected') {
        return rejected(initialized.code, initialized.message);
      }
      selectedScopeId = proposal.coordinationScopeId as CoordinationScopeId;
      publish(null, {
        kind: 'state-changed',
        coordinationScopeId: proposal.coordinationScopeId,
        revision: initialized.revision,
        reason: 'scope-initialized',
      });
      return accepted(`已创建 Coordination Scope ${proposal.coordinationScopeId}`, initialized.revision);
  };

  const modelCatalog = (): ModelCatalog => {
    const options_ =
      config === null
        ? []
        : config.coordinatorModels.map((entry) => ({
            configurationRef: entry.configurationRef,
            model: entry.model,
          }));
    const selected = selectedSessionOf(selectedScopeRecord());
    const currentRef = selected === null ? null : selected.coordinatorModelConfigurationRef;
    const session = selected === null ? null : (liveSessions.get(selected.coordinatorSessionId) ?? null);
    const state = session === null ? null : liveStateOf(session);
    const switchable = assertSwitchable({
      suspension:
        state !== null && state.graphPosition === 'suspend'
          ? {
              kind: 'suspended',
              coordinationScopeId: session!.incarnation.coordinationScopeId,
              coordinatorSessionId: session!.coordinatorSessionId,
              graphPosition: state.graphPosition,
              suspendedAt: clock(),
              reason: 'no_actionable_work',
              deferredActionableWork: 0,
            }
          : null,
      inFlightModelOperations: session?.inFlightModelOperations ?? 0,
    });
    return {
      options: options_,
      currentConfigurationRef: currentRef,
      switchable: switchable.kind === 'switchable',
      switchBlockReason: switchable.kind === 'switchable' ? null : switchable.message,
    };
  };

  const selectedScopeRecord = (): ScopeRecord | null => (selectedScopeId === null ? null : scopeRecord(selectedScopeId));

  const selectedSessionOf = (
    scope: ScopeRecord | null,
  ): { readonly coordinatorSessionId: CoordinatorSessionId; readonly coordinatorModelConfigurationRef: string } | null => {
    const current = requireStore();
    if (current === null || scope === null) {
      return null;
    }
    const sessions = current.query({ kind: 'sessions', coordinationScopeId: scope.coordinationScopeId });
    if (sessions.kind !== 'sessions') {
      return null;
    }
    const responsible = current.query({
      kind: 'planning-responsibility',
      coordinationScopeId: scope.coordinationScopeId,
    });
    const responsibility =
      responsible.kind === 'planning-responsibility' ? responsible.responsibility : null;
    const preferred =
      responsibility === null
        ? sessions.sessions[0]
        : sessions.sessions.find(
            (session) => session.coordinatorSessionId === responsibility.coordinatorSessionId,
          );
    const chosen = preferred ?? sessions.sessions[0];
    return chosen === undefined
      ? null
      : {
          coordinatorSessionId: chosen.coordinatorSessionId,
          coordinatorModelConfigurationRef: chosen.coordinatorModelConfigurationRef,
        };
  };

  // ---------------------------------------------------------------------
  // 组装
  // ---------------------------------------------------------------------

  const execute = async (intent: TuiIntent): Promise<ControllerCommandResult> => {
    switch (intent.kind) {
      case 'send-session-message':
        return await sessionMessages({
          coordinatorSessionId: intent.coordinatorSessionId as CoordinatorSessionId,
          submissionId: newId(),
          content: intent.content,
        });
      case 'answer-pending-interaction': {
        const owner = interactionOwner(intent.interactionId);
        if (owner === null) {
          return rejected('not_found', `Pending Interaction ${intent.interactionId} 不在当前 Scope`);
        }
        return await pendingInteractionAnswer({
          interactionId: intent.interactionId as InteractionId,
          expectedRevision: intent.expectedRevision,
          answer: intent.answer,
          ownerCoordinatorSessionId: owner,
        });
      }
      case 'compact-session':
        return await compaction({
          coordinatorSessionId: intent.coordinatorSessionId as CoordinatorSessionId,
          reason: intent.reason,
        });
      case 'switch-model-configuration':
        return await modelConfiguration({
          coordinatorSessionId: intent.coordinatorSessionId as CoordinatorSessionId,
          nextConfigurationRef: intent.nextConfigurationRef,
        });
      case 'scope-control':
        return rejected(
          'scope_control_unavailable',
          'Scope 级 Pause/Resume/Cancel 需要前台对账 runner 与 Worker 停止端口，属于 m2-deliver-execution-tui',
        );
    }
  };

  const interactionOwner = (interactionId: string): CoordinatorSessionId | null => {
    const current = requireStore();
    if (current === null || selectedScopeId === null) {
      return null;
    }
    const snapshot = current.query({ kind: 'snapshot', coordinationScopeId: selectedScopeId });
    if (snapshot.kind !== 'snapshot') {
      return null;
    }
    const interaction = snapshot.snapshot.pendingInteractions.find(
      (entry) => entry.interactionId === interactionId,
    );
    return interaction === undefined ? null : interaction.ownerCoordinatorSessionId;
  };

  const handoff = {
    prepareProposal: async (targetCoordinatorSessionId: string): Promise<ControllerCommandResult> => {
      const ensured = await ensureLiveSession(targetCoordinatorSessionId as CoordinatorSessionId);
      if (ensured.kind === 'failed') {
        return rejected(ensured.code, ensured.message);
      }
      const source = selectedSessionOf(selectedScopeRecord());
      if (source === null) {
        return rejected('scope_unavailable', '当前 Scope 没有可交接的 Session');
      }
      const started = await ensureLiveSession(source.coordinatorSessionId);
      if (started.kind === 'failed') {
        return rejected(started.code, started.message);
      }
      const services = planningServices(source.coordinatorSessionId);
      if (services === null) {
        return rejected('scope_unavailable', '无法读取规划事实');
      }
      const proposalId = `handoff:${newId()}`;
      const result = await services.preparePlanningHandoff({
        proposalId,
        targetCoordinatorSessionId: targetCoordinatorSessionId as CoordinatorSessionId,
        capsuleRef: null,
        // prepare 只做 IC-03 的 CAS 写入，不产生外部副作用；这里的身份由提案身份派生，
        // 与模型工具调用路径无关（那条路径用的是持久化在 model step 里的 OperationId）。
        operationId: `handoff:${proposalId}:prepare` as OperationId,
      });
      return result.kind === 'rejected'
        ? rejected(result.failure.code, result.failure.message)
        : accepted(`交接提案 ${proposalId} 已 prepare`);
    },
    cutover: async (proposalId: string): Promise<ControllerCommandResult> => {
      const current = requireStore();
      if (current === null || selectedScopeId === null) {
        return rejected('scope_unavailable', '当前没有可用的 Coordination Scope');
      }
      const proposal = current.query({ kind: 'planning-handoff', coordinationScopeId: selectedScopeId, proposalId });
      if (proposal.kind !== 'planning-handoff' || proposal.handoff === null) {
        return rejected('not_found', `交接提案 ${proposalId} 不存在`);
      }
      const reserved = resumePlanningHandoff({ store: current, coordinationScopeId: selectedScopeId });
      if (reserved.kind === 'rejected') {
        return rejected(reserved.failure.code, reserved.failure.message);
      }
      if (proposal.handoff.phase === 'prepared') {
        // 接收方复核是交接的独立阶段：用户在这次确认里表达的正是「接收方接受提案」。
        const target = await ensureLiveSession(proposal.handoff.targetCoordinatorSessionId);
        if (target.kind === 'failed') {
          return rejected(target.code, target.message);
        }
        const targetServices = planningServices(proposal.handoff.targetCoordinatorSessionId);
        if (targetServices === null) {
          return rejected('scope_unavailable', '无法读取规划事实');
        }
        const reviewed = await targetServices.reviewPlanningHandoff({
          proposalId,
          operationId: `handoff:${proposalId}:review` as OperationId,
        });
        if (reviewed.kind === 'rejected') {
          return rejected(reviewed.failure.code, reviewed.failure.message);
        }
      }
      const source = await ensureLiveSession(proposal.handoff.sourceCoordinatorSessionId);
      if (source.kind === 'failed') {
        return rejected(source.code, source.message);
      }
      const writer = writerFor(source.session.incarnation);
      const factsRead = reviewFactsFor(source.session);
      if (factsRead === null) {
        return rejected('scope_unavailable', '无法读取当前 map/plan 事实');
      }
      const cutover = cutoverPlanningHandoff({
        store: current,
        coordinationScopeId: selectedScopeId,
        writer,
        proposalId,
        facts: factsRead,
      });
      if (cutover.kind === 'rejected') {
        return rejected(cutover.failure.code, cutover.failure.message);
      }
      publish(proposal.handoff.targetCoordinatorSessionId, {
        kind: 'handoff-phase-changed',
        coordinationScopeId: selectedScopeId,
        handoffId: proposalId,
        phase: 'cutover',
      });
      return accepted(`已完成 cutover：${proposalId}`);
    },
    cancel: async (proposalId: string): Promise<ControllerCommandResult> => {
      const current = requireStore();
      if (current === null || selectedScopeId === null) {
        return rejected('scope_unavailable', '当前没有可用的 Coordination Scope');
      }
      const proposal = current.query({ kind: 'planning-handoff', coordinationScopeId: selectedScopeId, proposalId });
      if (proposal.kind !== 'planning-handoff' || proposal.handoff === null) {
        return rejected('not_found', `交接提案 ${proposalId} 不存在`);
      }
      const ensured = await ensureLiveSession(proposal.handoff.sourceCoordinatorSessionId);
      if (ensured.kind === 'failed') {
        return rejected(ensured.code, ensured.message);
      }
      const cancelled = cancelPlanningHandoff({
        store: current,
        coordinationScopeId: selectedScopeId,
        writer: writerFor(ensured.session.incarnation),
        proposalId,
      });
      return cancelled.kind === 'rejected'
        ? rejected(cancelled.failure.code, cancelled.failure.message)
        : accepted(`已取消交接提案 ${proposalId}`);
    },
  };

  const reviewFactsFor = (
    session: LiveSession,
  ):
    | {
        readonly currentMapRevision: number;
        readonly currentPlanRevision: number;
        readonly candidate: GraphVersionRecord | null;
      }
    | null => {
    const current = requireStore();
    const scope = selectedScopeId === null ? null : scopeRecord(selectedScopeId);
    if (current === null || scope === null) {
      return null;
    }
    const versions =
      scope.graphId === null
        ? null
        : current.query({ kind: 'graph-versions', coordinationScopeId: scope.coordinationScopeId, graphId: scope.graphId });
    const candidateVersion = scope.graphVersion;
    const candidate =
      versions !== null && versions.kind === 'graph-versions' && candidateVersion !== null
        ? (versions.versions.find((version) => version.version === candidateVersion) ?? null)
        : null;
    void session;
    return {
      currentMapRevision: scope.mapRevision,
      currentPlanRevision: candidate === null ? 0 : candidate.version,
      candidate,
    };
  };

  // ---------------------------------------------------------------------
  // 执行阶段（MOD-07 Extend，Owner: `m2-deliver-execution-tui`）
  //
  // 这一段只做两件事：把**读到的**执行事实交给自己已有的投影函数，以及把 Scope 级控制与 Execution
  // Handoff 意图接到既有用例上。它不派发 Worker、不实现对账、不写执行状态——那些属于执行运行时。
  // ---------------------------------------------------------------------

  /** 只读执行查询使用的 Orca backend；按需创建，且只提交 `identity: 'none'` 的查询。 */
  let executionBackend: ExecutionBackend | null = null;
  const backendForExecution = (): ExecutionBackend | null => {
    if (canonicalWorktreePath === null) {
      return null;
    }
    executionBackend ??= createOrcaExecutionBackend({
      cwd: canonicalWorktreePath,
      env: options.env,
    });
    return executionBackend;
  };

  /**
   * 执行阶段的外部观察。
   *
   * 只在 Execution Coordination 模式下读取，且只提交两个只读查询：`worktree-list`（按归属标记定位每个
   * Work Package 的隔离 worktree）与 `worker-list`（当前 Graph Generation 的 Run）。任何一项不可用时
   * 只记录原因，不把它读成「没有 Worker 在运行」。
   */
  const executionObservations = async (
    scope: ScopeRecord,
    nodes: readonly { readonly workPackageId: string }[],
  ): Promise<ExecutionObservationFacts> => {
    if (scope.mode !== 'execution_coordination') {
      return noExecutionObservations('mode-not-execution');
    }
    const backend = backendForExecution();
    if (backend === null) {
      return noExecutionObservations('canonical-worktree-unresolved');
    }
    const unavailableReasons: string[] = [];
    const worktreePaths = new Map<string, string>();

    const listed = await backend.query({
      operation: 'worktree-list',
      repo: `path:${canonicalWorktreePath ?? options.repositoryPath}`,
      limit: 1_000,
    });
    if (listed.kind === 'accepted') {
      const value = listed.value as { readonly worktrees: readonly { readonly path: string; readonly comment: string | null }[] };
      for (const node of nodes) {
        const match = value.worktrees.find(
          (worktree) => worktree.comment === workPackageComment(node.workPackageId as WorkPackageId),
        );
        if (match !== undefined) {
          worktreePaths.set(node.workPackageId, match.path);
        }
      }
    } else {
      unavailableReasons.push(`worktree-list:${listed.code}`);
    }

    const snapshot = requireStore()?.query({
      kind: 'snapshot',
      coordinationScopeId: scope.coordinationScopeId,
    });
    const generation =
      snapshot !== undefined && snapshot.kind === 'snapshot'
        ? (snapshot.snapshot.graphGenerations.find((entry) => entry.graphId === scope.graphId) ?? null)
        : null;
    let workers: readonly WorkerObservation[] = [];
    let workersEnumerated = false;
    if (generation === null) {
      unavailableReasons.push('no-graph-generation');
    } else {
      const workerList = await backend.query({ operation: 'worker-list', runId: generation.orcaRunId });
      if (workerList.kind === 'accepted') {
        const value = workerList.value as WorkerListResult;
        workers = value.workers.map((worker) => ({
          dispatchId: worker.dispatchId ?? '',
          taskId: worker.taskId,
          workerState: worker.workerState,
          terminalState: worker.terminalState,
        }));
        workersEnumerated = true;
      } else {
        unavailableReasons.push(`worker-list:${workerList.code}`);
      }
    }

    return {
      workersEnumerated,
      workers,
      worktreePaths,
      unavailableReasons,
      finalizer: {
        // Finalizer 的只读 Profile 核验与运行前后工作区没有生产者：如实标为未核验/未记录。
        readOnlyProfile: 'unverified',
        integrationFrozen: 'unknown',
        worktreePath: canonicalWorktreePath,
        workspace: null,
        evidenceRefs: [],
      },
    };
  };

  const executionDerivation = (input: {
    readonly snapshot: CoordinationSnapshot;
    readonly scope: ScopeRecord;
    readonly observations: ExecutionObservationFacts;
    readonly nodes: readonly { readonly workPackageId: string; readonly dependsOn: readonly string[] }[];
    readonly baselineHead: string | null;
    readonly authority: RoleAuthorities | null;
    readonly recoveryBudgetLimit: number | null;
  }): {
    readonly execution: ReturnType<typeof deriveExecutionFacts>;
    readonly workers: readonly WorkerEntryView[];
  } => ({
    execution: deriveExecutionFacts({
      snapshot: input.snapshot,
      nodes: input.nodes,
      baselineHead: input.baselineHead,
      authority: input.authority,
      observations: input.observations,
    }),
    workers: deriveWorkerEntries({ snapshot: input.snapshot, observations: input.observations }),
  });

  /**
   * Scope 级控制的写入者。
   *
   * 控制事实必须由持有 Runtime Lease 的真实 Incarnation 写入，因此这里选择身份的顺序是固定的：
   * Execution Coordination Lease 持有者 → 规划责任方 → 唯一的已登记 Session。身份、fencing 与租约
   * 都由 store 判定，界面与模型都填不了它们。
   */
  const scopeControlSessionId = (): CoordinatorSessionId | null => {
    const current = requireStore();
    const scopeId = selectedScopeId;
    if (current === null || scopeId === null) {
      return null;
    }
    const snapshot = current.query({ kind: 'snapshot', coordinationScopeId: scopeId });
    if (snapshot.kind !== 'snapshot') {
      return null;
    }
    const executionLease = snapshot.snapshot.leases.find(
      (lease) => lease.kind === 'execution_coordination' && lease.releasedAt === null,
    );
    if (executionLease !== undefined) {
      return executionLease.coordinatorSessionId;
    }
    const responsible = snapshot.snapshot.planningResponsibility?.coordinatorSessionId ?? null;
    if (responsible !== null) {
      return responsible;
    }
    return snapshot.snapshot.sessions[0]?.coordinatorSessionId ?? null;
  };

  /** Scope 级控制：Pause 直接落盘；Resume 先对账（对账未接线即拒绝）；Cancel 先落盘再请求停止。 */
  const scopeControlService = () => {
    const current = requiredStore();
    return createScopeControlService({
      store: current,
      reconciliation: () =>
        Promise.resolve({
          kind: 'rejected' as const,
          code: 'reconciliation_unavailable',
          message: '执行期对账尚未接线（属于执行运行时 change）：Resume 不会在没有对账的情况下恢复调度',
        }),
      workers: {
        listActiveDispatches: (): Promise<ActiveWorkerListResult> =>
          Promise.resolve({
            kind: 'unavailable',
            reason: 'Worker 停止请求尚未接线（属于执行运行时 change）：停止结果只能如实报告为不可核验',
          }),
        requestStop: (): Promise<WorkerStopOutcome> => Promise.resolve('unverifiable'),
      },
    });
  };

  const runScopeControl = async (
    action: 'pause' | 'resume' | 'cancel' | 'exit',
  ): Promise<ControllerCommandResult> => {
    if (action === 'exit') {
      // Exit 只结束前台进程：它不写控制状态，因此不接受经由控制通道提交。
      return rejected(
        'exit_is_foreground_lifecycle',
        'Exit 只结束前台进程，不写 Scope 控制状态；请使用前台退出路径',
      );
    }
    const current = requireStore();
    const scopeId = selectedScopeId;
    if (current === null || scopeId === null) {
      return rejected('scope_unavailable', '当前没有可用的 Coordination Scope');
    }
    const sessionId = scopeControlSessionId();
    if (sessionId === null) {
      return rejected('no_active_incarnation', '当前没有可以写入控制状态的 Coordinator Session');
    }
    const ensured = await ensureLiveSession(sessionId);
    if (ensured.kind === 'failed') {
      return rejected(ensured.code, ensured.message);
    }
    const service = scopeControlService();
    const request = {
      coordinationScopeId: scopeId,
      writer: writerFor(ensured.session.incarnation),
    };
    const result: ScopeControlResult =
      action === 'pause' ? service.pause(request) : action === 'resume' ? await service.resume(request) : await service.cancel(request);

    if (result.kind === 'rejected') {
      return rejected(result.code, result.message);
    }
    if (result.kind === 'unchanged') {
      return accepted(result.reason);
    }
    publish(null, {
      kind: 'scope-control-changed',
      coordinationScopeId: scopeId,
      controlState: result.controlState,
    });
    return accepted(`Scope 控制状态：${result.controlState}`, null);
  };

  /** Execution Handoff：只投影并推进 `ExecutionHandoffState`，不改动任何运行身份。 */
  const executionHandoffPort: ExecutionHandoffIntentPort = {
    prepare: async (targetCoordinatorSessionId) => {
      const current = requireStore();
      const scopeId = selectedScopeId;
      if (current === null || scopeId === null) {
        return rejected('scope_unavailable', '当前没有可用的 Coordination Scope');
      }
      const scope = scopeRecord(scopeId);
      if (scope === null) {
        return rejected('scope_unavailable', `无法读取 Scope ${scopeId}`);
      }
      const snapshot = current.query({ kind: 'snapshot', coordinationScopeId: scopeId });
      if (snapshot.kind !== 'snapshot') {
        return rejected('invalid_state', 'snapshot 查询返回了非预期结果');
      }
      const generation = snapshot.snapshot.graphGenerations.find((entry) => entry.graphId === scope.graphId) ?? null;
      if (generation === null) {
        return rejected('invalid_state', '当前 Graph Generation 不存在：执行交接没有可绑定的代际');
      }
      const sourceId = scopeControlSessionId();
      if (sourceId === null) {
        return rejected('no_active_incarnation', '当前没有可以发起交接的 Session');
      }
      const ensured = await ensureLiveSession(sourceId);
      if (ensured.kind === 'failed') {
        return rejected(ensured.code, ensured.message);
      }
      const capsule = ensurePortableCapsule(sourceId);
      if (capsule.kind === 'failed') {
        return rejected('capsule_unavailable', capsule.reason);
      }
      const result = prepareExecutionHandoff({
        store: current,
        coordinationScopeId: scopeId,
        writer: writerFor(ensured.session.incarnation),
        handoffId: `execution-handoff:${newId()}`,
        targetSessionId: targetCoordinatorSessionId as CoordinatorSessionId,
        graphGeneration: generation.generation,
        capsuleRef: capsule.capsuleId,
      });
      if (result.kind === 'prepared') {
        return accepted(`已创建执行交接 ${result.record.handoffId}`);
      }
      const failure = executionHandoffFailure(result);
      return failure === null
        ? rejected('invalid_state', `执行交接 prepare 返回了非预期结果：${result.kind}`)
        : rejected(failure.code, failure.message);
    },
    review: async (handoffId) => {
      const current = requireStore();
      const scopeId = selectedScopeId;
      if (current === null || scopeId === null) {
        return rejected('scope_unavailable', '当前没有可用的 Coordination Scope');
      }
      const scope = scopeRecord(scopeId);
      const handoffRead = current.query({
        kind: 'execution-handoff',
        coordinationScopeId: scopeId,
        handoffId,
      });
      if (scope === null || handoffRead.kind !== 'execution-handoff' || handoffRead.handoff === null) {
        return rejected('not_found', `执行交接 ${handoffId} 不存在`);
      }
      const handoff = handoffRead.handoff;
      const ensured = await ensureLiveSession(handoff.targetSessionId);
      if (ensured.kind === 'failed') {
        return rejected(ensured.code, ensured.message);
      }
      const snapshot = current.query({ kind: 'snapshot', coordinationScopeId: scopeId });
      const generation =
        snapshot.kind === 'snapshot'
          ? (snapshot.snapshot.graphGenerations.find((entry) => entry.graphId === scope.graphId) ?? null)
          : null;
      const checkpoints = checkpointStoreForScope();
      const sourceRead = checkpoints?.loadCheckpoint(handoff.sourceSessionId) ?? null;
      const sourceCheckpoint: ExecutionHandoffReviewFacts['sourceCheckpoint'] =
        sourceRead === null
          ? 'unrecoverable'
          : sourceRead.kind === 'recovered'
            ? 'recoverable'
            : sourceRead.kind === 'absent'
              ? 'absent'
              : 'unrecoverable';
      const facts: ExecutionHandoffReviewFacts = {
        scopeRevision: scope.revision,
        currentGraphGeneration: generation?.generation ?? null,
        targetLifecycleState:
          snapshot.kind === 'snapshot'
            ? (snapshot.snapshot.sessions.find(
                (session) => session.coordinatorSessionId === handoff.targetSessionId,
              )?.lifecycleState ?? null)
            : null,
        sourceCheckpoint,
        capsulePortable:
          handoff.coordinatorContextCapsuleRef !== null &&
          checkpoints?.loadPortableCapsule(handoff.sourceSessionId) !== null,
      };
      const result = reviewExecutionHandoff({
        store: current,
        coordinationScopeId: scopeId,
        writer: writerFor(ensured.session.incarnation),
        handoffId,
        facts,
      });
      if (result.kind === 'reviewed') {
        return accepted(`已复核执行交接 ${handoffId}`);
      }
      const failure = executionHandoffFailure(result);
      return failure === null
        ? rejected('invalid_state', `执行交接 review 返回了非预期结果：${result.kind}`)
        : rejected(failure.code, failure.message);
    },
    cutover: async (handoffId) => {
      const current = requireStore();
      const scopeId = selectedScopeId;
      if (current === null || scopeId === null) {
        return rejected('scope_unavailable', '当前没有可用的 Coordination Scope');
      }
      const handoffRead = current.query({
        kind: 'execution-handoff',
        coordinationScopeId: scopeId,
        handoffId,
      });
      if (handoffRead.kind !== 'execution-handoff' || handoffRead.handoff === null) {
        return rejected('not_found', `执行交接 ${handoffId} 不存在`);
      }
      const ensured = await ensureLiveSession(handoffRead.handoff.targetSessionId);
      if (ensured.kind === 'failed') {
        return rejected(ensured.code, ensured.message);
      }
      const result = cutoverExecutionHandoff({
        store: current,
        coordinationScopeId: scopeId,
        writer: writerFor(ensured.session.incarnation),
        handoffId,
      });
      if (result.kind !== 'cutover') {
        const failure = executionHandoffFailure(result);
        return failure === null
          ? rejected('invalid_state', `执行交接 cutover 返回了非预期结果：${result.kind}`)
          : rejected(failure.code, failure.message);
      }
      publish(result.record.targetSessionId, {
        kind: 'handoff-phase-changed',
        coordinationScopeId: scopeId,
        handoffId,
        phase: 'cutover',
      });
      return accepted(`已完成执行交接 cutover：${handoffId}`);
    },
    cancel: async (handoffId) => {
      const current = requireStore();
      const scopeId = selectedScopeId;
      if (current === null || scopeId === null) {
        return rejected('scope_unavailable', '当前没有可用的 Coordination Scope');
      }
      const handoffRead = current.query({
        kind: 'execution-handoff',
        coordinationScopeId: scopeId,
        handoffId,
      });
      if (handoffRead.kind !== 'execution-handoff' || handoffRead.handoff === null) {
        return rejected('not_found', `执行交接 ${handoffId} 不存在`);
      }
      const ensured = await ensureLiveSession(handoffRead.handoff.sourceSessionId);
      if (ensured.kind === 'failed') {
        return rejected(ensured.code, ensured.message);
      }
      const result = cancelExecutionHandoff({
        store: current,
        coordinationScopeId: scopeId,
        writer: writerFor(ensured.session.incarnation),
        handoffId,
      });
      if (result.kind === 'cancelled') {
        return accepted(`已取消执行交接 ${handoffId}`);
      }
      const failure = executionHandoffFailure(result);
      return failure === null
        ? rejected('invalid_state', `执行交接 cancel 返回了非预期结果：${result.kind}`)
        : rejected(failure.code, failure.message);
    },
  };

  const controller = createControllerService({
    snapshots: async ({ coordinationScopeId, selectedSessionId }) => {
      void coordinationScopeId;
      const loaded = await readSnapshot(selectedSessionId);
      if (loaded.kind !== 'snapshot') {
        throw new Error(loaded.message);
      }
      return loaded.snapshot;
    },
    transcript: ({ coordinatorSessionId }) => {
      const loaded = readTranscript(coordinatorSessionId);
      if (loaded.kind !== 'transcript') {
        throw new Error(loaded.message);
      }
      return loaded.transcript;
    },
    sessionMessages: async (input) =>
      await sessionMessages({
        coordinatorSessionId: input.coordinatorSessionId,
        submissionId: input.submissionId,
        content: input.content,
      }),
    compaction: async (input) => await compaction(input),
    modelConfiguration: async (input) => await modelConfiguration(input),
    planningHandoff: async (input) => {
      if (input.action === 'prepare') {
        return await handoff.prepareProposal(input.targetCoordinatorSessionId);
      }
      if (input.action === 'cutover') {
        return await handoff.cutover(input.proposalId);
      }
      if (input.action === 'cancel') {
        return await handoff.cancel(input.proposalId);
      }
      const current = requireStore();
      if (current === null || selectedScopeId === null) {
        return rejected('scope_unavailable', '当前没有可用的 Coordination Scope');
      }
      const proposal = current.query({
        kind: 'planning-handoff',
        coordinationScopeId: selectedScopeId,
        proposalId: input.proposalId,
      });
      if (proposal.kind !== 'planning-handoff' || proposal.handoff === null) {
        return rejected('not_found', `交接提案 ${input.proposalId} 不存在`);
      }
      // 复核只由接收方 Session 执行：它才是这次接手是否成立的判断者。
      const ensured = await ensureLiveSession(proposal.handoff.targetCoordinatorSessionId);
      if (ensured.kind === 'failed') {
        return rejected(ensured.code, ensured.message);
      }
      const reviewed = reviewPlanningHandoff({
        store: current,
        coordinationScopeId: selectedScopeId,
        writer: writerFor(ensured.session.incarnation),
        proposalId: input.proposalId,
        facts: input.facts,
      });
      return reviewed.kind === 'rejected'
        ? rejected(reviewed.failure.code, reviewed.failure.message)
        : accepted(`已复核交接提案 ${input.proposalId}`);
    },
    scopeControl: async (input) => await runScopeControl(input.action),
    pendingInteractions: async (input) => {
      const owner = interactionOwner(input.interactionId);
      if (owner === null) {
        return rejected('not_found', `Pending Interaction ${input.interactionId} 不在当前 Scope`);
      }
      return await pendingInteractionAnswer({
        interactionId: input.interactionId,
        expectedRevision: input.expectedRevision,
        answer: input.answer,
        ownerCoordinatorSessionId: owner,
      });
    },
    executionHandoff: async (input) => {
      switch (input.action) {
        case 'prepare':
          return await executionHandoffPort.prepare(input.targetSessionId);
        case 'review':
          return await executionHandoffPort.review(input.handoffId);
        case 'cutover':
          return await executionHandoffPort.cutover(input.handoffId);
        case 'cancel':
          return await executionHandoffPort.cancel(input.handoffId);
      }
    },
    graphEvolution: () =>
      Promise.resolve(
        rejected(
          'graph_evolution_unavailable',
          '图演进意图（begin/complete/cancel replanning 与 confirm cutover）没有界面入口：本 change 只交付执行阶段的投影与控制意图',
        ),
      ),
    scopeInitialization: async (input) =>
      await scopeSetup.initialize({
        coordinationScopeId: input.coordinationScopeId,
        coordinatorSessionId: input.coordinatorSessionId,
        coordinatorModelConfigurationRef: input.coordinatorModelConfigurationRef,
        planningCycleId: input.planningCycleId,
        repositoryPath: options.repositoryPath,
        canonicalWorktree: canonicalWorktreePath ?? options.repositoryPath,
        trackerRef: config === null ? '' : `github#${String(config.tracker.routeMapIssueNumber)}`,
      }),
    ...(options.events === undefined ? {} : { events: options.events }),
  });

  const ports: TuiPorts = {
    snapshot: async (selectedSessionId) => await readSnapshot(selectedSessionId),
    transcript: (coordinatorSessionId) => Promise.resolve(readTranscript(coordinatorSessionId)),
    execute: async (intent) => await execute(intent),
    subscribe: (listener): Unsubscribe => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    scopeSetup,
    modelCatalog: { load: () => Promise.resolve(modelCatalog()) },
    handoff,
    executionHandoff: executionHandoffPort,
  };

  return {
    ports,
    controller,
    readiness: () => ({
      canonicalWorktreePath,
      fullBranchRef,
      configPath,
      blocker,
    }),
    close: () => {
      closed = true;
      for (const session of liveSessions.values()) {
        stopHeartbeat(session);
        session.checkpoints.close();
      }
      liveSessions.clear();
      listeners.clear();
      scopeCheckpointStore?.close();
      if (storeOpened !== null && storeOpened.kind === 'opened') {
        storeOpened.close();
      }
    },
  };

}

export function createForegroundPlanningPorts(
  environment: TuiEntryEnvironment,
): Promise<TuiPorts> {
  return createForegroundPlanningHost({
    repositoryPath: environment.cwd,
    env: environment.env,
  }).then((host) => host.ports);
}
