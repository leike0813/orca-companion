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

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  DispatchId,
  InteractionId,
  OperationId,
  PlanningCycleId,
  RuntimeIncarnationId,
  WorkerTaskId,
  WorkPackageId,
} from '../application/dto/identity.js';
import type { ProjectedActionableWorkItem } from '../application/coordinator/actionable-work.js';
import {
  advanceExecution,
  type AdvanceExecutionResult,
  type AdvanceRoleDispatch,
} from '../application/execution/advance-execution.js';
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
  workerStateLiveness,
  type ExecutionObservationFacts,
  type FinalizerObservationFacts,
  type FinalizerWorkspaceFacts,
  type WorkerEntryView,
  type WorkerObservation,
} from '../application/execution/execution-view.js';
import { activeAuthorization } from '../application/planning/authorization-service.js';
import { admitSpecification, type SpecificationAdmissionResult } from '../application/specification-admission.js';
import type { SpecificationProvider as SpecificationProviderPort } from '../application/ports/specification-provider.js';
import type { ScopeEnvelope as ScopeEnvelopeShape } from '../domain/planning/execution-graph.js';
import { planFinalizerDispatch, finalizeProject, type FinalizerGateFacts } from '../application/finalize-project.js';
import { integrateWorkPackage, type GitIntegrationPort } from '../application/integrate-work-package.js';
import type { OperationIntent } from '../application/dto/operation-intent.js';
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
import type {
  ScopeControlResult,
  ScopeControlService,
  WorkerStopPort,
} from '../application/coordination/scope-control-service.js';
import { createControllerService,
  projectControllerSnapshot,
  toSemanticEvent,
  type ControllerBlockerEntry,
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
import type { GraphVersionRecord, ExecutionGraph, WorkPackage } from '../domain/planning/execution-graph.js';
import { projectChangedPaths } from '../domain/worker-result-verification.js';
import type {
  ExecutionAuthorizationManifest,
  ExecutionAuthorizationRecord,
  WorkerRole,
} from '../domain/planning/execution-authorization.js';
import type { CanonicalHeadFacts } from '../domain/git-integration-policy.js';
import { workPackageBudgetKey, type WorkPackageBudgetField } from '../domain/dispatch-candidate.js';
import {
  TASK_CONTRACT_SCHEMA_VERSION,
  TASK_ENVELOPE_SCHEMA_VERSION,
  plannerSpecificationInstructions,
  specificationUnitPathFor,
  type SessionBinding,
  type EvidenceRequirement,
  type SpecBinding,
  type TaskEnvelope,
} from '../domain/task-contract.js';
import {
  initialWorkPackageStatus,
  withImplementationStatus,
  withValidationStatus,
  type WorkPackageStatus,
} from '../domain/work-package-status.js';
import type { DeliveryVerdict } from '../domain/delivery-verdict.js';
import type { ClaimProjection } from '../domain/planning/ticket-claim.js';
import type {
  CommittedMessageEntry,
  CoordinatorSessionState,
} from '../domain/coordinator/session-state.js';
import { COORDINATOR_SESSION_STATE_SCHEMA_VERSION, threadIdFor } from '../domain/coordinator/session-state.js';
import type {
  BranchCoordinationStore,
  CoordinationSnapshot,
  CoordinationWriter,
  GraphGenerationRecord,
  MaterializationBindingRecord,
  PendingInteractionRecord,
  ScopeRecord,
  SessionSegmentRecord,
} from '../application/ports/branch-coordination-store.js';
import type {
  ExecutionAuthority,
  ExecutionBackend,
  WorktreeListResult,
  WorktreeSummary,
} from '../application/ports/execution-backend.js';
import type { RoleAuthorities } from '../domain/planning/execution-authorization.js';
import type {
  ExecutionAuthorizationIntentPort,
  ExecutionAuthorizationLoad,
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
import {
  approveExecutionAuthorization,
  codexSessionPathsUnder,
  createExecutionRecoveryFacts,
  parseDeliveryClaimedPayload,
  proposeExecutionGraph,
  readPendingDeliveries,
  reviewExecutionAuthorization,
  type DeliveryWorktreeFactReader,
  type ExecutionAuthorizationFacts,
  type ExecutionAuthorizationReview,
} from './execution-runtime.js';
import {
  continueWorkerSessionRecovery,
  recoveryBlockerOf,
  startCompanionStartup,
  type StartedCompanionStartup,
  type StartupDeliveryFacts,
  type StartupStep,
} from './startup.js';
import { recoverySubjectOf } from '../application/recovery/worker-session-recovery-service.js';
import { createOrcaWorkerStopPort } from '../adapters/orca-cli/worker-stop.js';
import { createCodexWorkerLaunch, installCodexSessionStartReporter } from '../adapters/agents/codex-launch.js';
import { dispatchScopedWorker } from '../adapters/agents/utility-worker.js';
import { bindCodexSessionFromStartReport, sessionBindingIdOf } from '../adapters/agents/session-binding.js';
import type { CodexSessionStartReport } from '../adapters/agents/codex-transcript.js';
import type { HarnessSessionFacts } from '../adapters/agents/session-binding.js';
import { createGitIntegrationPort } from '../adapters/git/integration.js';
import {
  createOpenSpecProvider,
} from '../adapters/specification/openspec/provider.js';
import { openCheckpointStore, type CheckpointStore } from '../adapters/storage/checkpoint-store.js';
import { createOrcaExecutionBackend } from '../adapters/orca-cli/orca-backend.js';
import { readDeliveryBatch } from '../adapters/orca-cli/delivery-reader.js';
import { readWorkspaceFacts } from '../adapters/git/baseline-observer.js';
import type { RunSummary, WorkerListResult } from '../adapters/orca-cli/operation-catalog.js';
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
  executionToolsForMode,
  executionOutcomeOf,
  type ExecutionToolFacts,
  type ExecutionToolServices,
  type ExecutionToolOutcome,
} from '../workflow/coordinator/execution-tools.js';
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
  COMPANION_STATE_DIRECTORY,
  createCoordinationStore,
  resolveGitCommonDir,
  resolveGitScopeIdentity,
} from './composition.js';
import {
  checkpointDatabasePath,
  startCoordinatorRuntime,
  type StartedCoordinatorRuntime,
} from './coordinator-runtime.js';
import { createOrcaDoctorProbe } from './doctor.js';
import {
  PROJECT_CONFIG_FILENAME,
  configurationByRef,
  CODEX_FULL_ACCESS_RISK,
  DEFAULT_PROJECT_EXECUTION,
  loadProjectConfig,
  type CodexSandboxMode,
  type ProjectConfig,
} from './project-config.js';
import type { TuiEntryEnvironment } from './tui-entry.js';

/** Runtime Lease 的续约节奏与 TTL；心跳远小于 TTL，因此一次丢包不会立刻失去租约。 */
export const RUNTIME_HEARTBEAT_INTERVAL_MS = 10_000;
export const RUNTIME_LEASE_TTL_MS = 30_000;

/**
 * Resume 等待本进程在途执行推进收尾的上限。
 *
 * 它必须覆盖一次角色派发的全部外部 mutation（worktree/task/terminal/worker-start 的 60s 超时之和），
 * 否则 Resume 会在推进仍在跑时对账，把在途 intent 判成未决并阻塞 lane。
 */
export const RESUME_IN_FLIGHT_WAIT_MS = 300_000;

/** 单次受控 Orca mutation 的超时；它只限制一次调用，不构成重试策略。 */
const MUTATION_TIMEOUT_MS = 60_000;

/**
 * 等待 Codex SessionStart 报告的时间窗。
 *
 * 报告由被派发的 Codex 进程在自己的启动阶段写出，用的是墙上时钟，因此这段等待与协调时钟无关；
 * 超时只意味着「读不到」，由调用方按不可核验处理。
 */
const FINALIZER_BINDING_WINDOW_MS = 15_000;

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
  /**
   * 测试注入点：等待 Codex SessionStart 报告的窗口。
   *
   * 生产用它等待被派发的 Codex 进程上报 Session 身份；测试可以缩小它，从而不必真的等满窗口就能
   * 验证「读不到即不可核验」的结论。
   */
  readonly sessionBindingWindowMs?: number;
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
  /**
   * 测试注入点：Orca 执行后端。
   *
   * 省略时按需创建真实 adapter（`createOrcaExecutionBackend`）；注入时启动对账、Worker 停止与
   * Delivery 读取都走它，因此不启动真实 Orca 也能验证接线的行为。
   */
  readonly executionBackend?: ExecutionBackend;
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
  /** 这个 Session 的 Runtime Incarnation（含 lease/fencing 与 checkpoint store）。 */
  readonly started: StartedCoordinatorRuntime;
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

/**
 * 当前图中「已派发、已确认退出、且没有已接受结果」的中断 Session Segment。
 *
 * 判据全部来自权威事实：Segment 是派发时记录的，结算记录按角色 + 业务 Attempt 匹配（替代 Session
 * 沿用同一 Attempt，因此同一次尝试的第二次派发不会被误判成已完成），Worker 存活来自 Orca 列举。
 * 已经登记过 Recovery 的 Segment 不再触发：它的结论（含阻塞）由既有路径续办与呈现。
 *
 * **未确认的 Delivery 也排除在外**：Worker 退出但结果还在 Orca 的未确认 Delivery 里时，这条会话并没有
 * 丢失，它的正常完成路径是结算那条 Delivery，而不是另起一次 Recovery。
 */
export function interruptedSegmentOf(input: {
  readonly snapshot: CoordinationSnapshot;
  readonly observations: ExecutionObservationFacts;
  readonly graph: ExecutionGraph;
  readonly pendingDeliveryDispatchIds: readonly string[];
}): SessionSegmentRecord | null {
  const inGraph = new Set(input.graph.workPackages.map((workPackage) => workPackage.workPackageId));
  const candidates = input.snapshot.sessionSegments
    .filter((segment) => inGraph.has(segment.workPackageId))
    .filter((segment) => !input.pendingDeliveryDispatchIds.includes(segment.dispatchId))
    .filter(
      (segment) =>
        !input.snapshot.deliverySettlements.some(
          (settlement) => settlement.role === segment.role && settlement.attemptId === segment.attemptId,
        ),
    )
    .filter(
      (segment) =>
        !input.snapshot.recoveries.some((recovery) => recovery.sourceSegmentId === segment.segmentId),
    )
    .filter((segment) =>
      input.observations.workers.some(
        (worker) =>
          worker.dispatchId === segment.dispatchId && workerStateLiveness(worker.workerState) === 'exited',
      ),
    );
  return candidates.reduce<SessionSegmentRecord | null>(
    (latest, segment) => (latest === null || segment.recordedAt >= latest.recordedAt ? segment : latest),
    null,
  );
}

/**
 * 从一次派发对应的 Codex SessionStart 报告里签发精确 binding。
 *
 * 报告文件必须由**这次派发自己的 launchId** 派生（调用方给出 `reportPath`）；这里只按已记录的派发身份
 * 逐行校验：harness、角色、WorkerTask、Dispatch、Attempt、worktree 与 Codex 状态根都必须逐项一致，且
 * 报告必须落在这次派发的窗口内。任一不成立都返回结构化原因，绝不「挑一条最像的」。
 *
 * `waitMs > 0` 时在窗口内轮询等待报告出现（派发路径用）；`waitMs === 0` 时只读一次（补记路径用）。
 */
export async function sessionBindingFromStartReport(input: {
  readonly reportPath: string;
  readonly harness: string;
  readonly role: WorkerRole;
  readonly workerTaskId: WorkerTaskId;
  readonly dispatchId: DispatchId;
  readonly attemptId: string;
  readonly workspace: string;
  readonly expectedCodexHome: string;
  readonly dispatchStartedAt: string;
  readonly waitMs: number;
}): Promise<
  | { readonly kind: 'bound'; readonly binding: SessionBinding }
  | { readonly kind: 'unbound'; readonly code: string; readonly message: string }
> {
  const deadline = Date.now() + input.waitMs;
  for (;;) {
    const once = readBindingOnce(input);
    if (once.kind === 'bound') {
      return once;
    }
    if (Date.now() >= deadline) {
      return { kind: 'unbound', code: once.code, message: once.message };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
}

function readBindingOnce(input: {
  readonly reportPath: string;
  readonly harness: string;
  readonly role: WorkerRole;
  readonly workerTaskId: WorkerTaskId;
  readonly dispatchId: DispatchId;
  readonly attemptId: string;
  readonly workspace: string;
  readonly expectedCodexHome: string;
  readonly dispatchStartedAt: string;
}):
  | { readonly kind: 'bound'; readonly binding: SessionBinding }
  | { readonly kind: 'unbound'; readonly code: string; readonly message: string } {
  if (!existsSync(input.reportPath)) {
    return { kind: 'unbound', code: 'report_absent', message: `SessionStart 报告尚不可读：${input.reportPath}` };
  }
  let last: { readonly code: string; readonly message: string } | null = null;
  for (const line of readFileSync(input.reportPath, 'utf8').split('\n').filter(Boolean)) {
    let report: CodexSessionStartReport;
    try {
      report = JSON.parse(line) as CodexSessionStartReport;
    } catch {
      continue;
    }
    const proven = bindCodexSessionFromStartReport({
      facts: {
        harness: input.harness,
        role: input.role,
        workerTaskId: input.workerTaskId,
        dispatchId: input.dispatchId,
        attemptId: input.attemptId,
      },
      report,
      workspace: input.workspace,
      expectedCodexHome: input.expectedCodexHome,
      dispatchStartedAt: input.dispatchStartedAt,
      bindingDeadlineAt: new Date().toISOString(),
    });
    if (proven.kind === 'bound') {
      return proven;
    }
    last = { code: proven.code, message: proven.message };
  }
  return last === null
    ? { kind: 'unbound', code: 'report_unreadable', message: `SessionStart 报告没有可解析的行：${input.reportPath}` }
    : { kind: 'unbound', code: last.code, message: last.message };
}

/** 一条「已派发但未绑定」的角色派发；字段全部来自已记录事实与 Orca 列举。 */
export type UnboundRoleDispatch = {
  readonly workPackageId: WorkPackageId;
  readonly role: WorkerRole;
  readonly workerTaskId: WorkerTaskId;
  readonly attemptId: string;
  readonly orcaDispatchId: DispatchId;
  readonly launchId: string;
  readonly worktreePath: string;
  readonly observedDispatchId: string;
  readonly segmentId: SessionSegmentRecord['segmentId'];
  readonly createdAt: number;
};

/**
 * 需要补记 Session Binding 的角色派发。
 *
 * 「已派发」= 物化绑定是 `issued` 行且带着 launchId；「未绑定」= 图内还没有与这次 Orca Dispatch +
 * Attempt 对应的 Session Segment。Orca 的 Dispatch 身份只有 Orca 自己给出，因此按绑定的 Task 身份去
 * 列举事实里匹配；匹配不到就不猜（继续等下一次触发）。
 */
export function unboundRoleDispatches(input: {
  readonly graph: ExecutionGraph;
  readonly bindings: readonly MaterializationBindingRecord[];
  readonly segments: readonly SessionSegmentRecord[];
  readonly observations: ExecutionObservationFacts;
  readonly segmentIdOf: (orcaDispatchId: string, attemptId: string) => string;
}): readonly UnboundRoleDispatch[] {
  const inGraph = new Set(input.graph.workPackages.map((workPackage) => workPackage.workPackageId));
  const unbound: UnboundRoleDispatch[] = [];
  for (const binding of input.bindings) {
    if (
      binding.identity !== 'issued' ||
      binding.launchId === null ||
      binding.role === null ||
      binding.workerTaskId === null ||
      binding.attemptId === null ||
      !inGraph.has(binding.workPackageId)
    ) {
      continue;
    }
    const observation = input.observations.workers.find((worker) => worker.taskId === binding.orcaTaskId);
    const worktreePath = input.observations.worktreePaths.get(binding.workPackageId);
    if (observation === undefined || worktreePath === undefined) {
      continue;
    }
    const segmentId = input.segmentIdOf(observation.dispatchId, binding.attemptId);
    if (input.segments.some((segment) => segment.segmentId === segmentId)) {
      continue;
    }
    unbound.push({
      workPackageId: binding.workPackageId,
      role: binding.role,
      workerTaskId: binding.workerTaskId,
      attemptId: binding.attemptId,
      orcaDispatchId: observation.dispatchId as DispatchId,
      launchId: binding.launchId,
      worktreePath,
      observedDispatchId: observation.dispatchId,
      segmentId: segmentId as SessionSegmentRecord['segmentId'],
      createdAt: binding.createdAt,
    });
  }
  return unbound;
}

/**
 * 接纳 Planner 的 Specification Unit。
 *
 * 路径只是定位信息（单元身份是内容摘要）：以**当前规范路径**优先，物化绑定里记录的旧拼写兜底。规范
 * 路径命名方式变化（schema 12 的 slug）时，飞行中的派发仍然读得到同一个单元；两个候选都读不到才按
 * 规范路径的失败原因阻塞。
 */
async function admitPlannerUnit(input: {
  readonly provider: SpecificationProviderPort;
  readonly workPackageId: WorkPackageId;
  readonly worktreeId: string;
  readonly sessionBindingId: string;
  readonly scopeEnvelope: ScopeEnvelopeShape;
  readonly authority: RoleAuthorities;
  readonly consumedSpecificationRevisions: number;
  readonly specificationRevisionLimit: number;
  readonly recordedPath: string | null;
}): Promise<SpecificationAdmissionResult> {
  const canonicalPath = specificationUnitPathFor(input.workPackageId);
  const attempt = (relativePath: string): Promise<SpecificationAdmissionResult> =>
    admitSpecification({
      provider: input.provider,
      declaration: {
        role: 'planner',
        producer: { kind: 'worker', role: 'planner', sessionBindingId: input.sessionBindingId },
        workPackageId: input.workPackageId,
        worktreeId: input.worktreeId,
        relativePath,
        declaredVersion: TASK_CONTRACT_SCHEMA_VERSION,
      },
      worktreeId: input.worktreeId,
      workPackageId: input.workPackageId,
      scopeEnvelope: input.scopeEnvelope,
      authority: input.authority,
      contractSchemaVersion: TASK_CONTRACT_SCHEMA_VERSION,
      consumedSpecificationRevisions: input.consumedSpecificationRevisions,
      specificationRevisionLimit: input.specificationRevisionLimit,
    });
  const canonical = await attempt(canonicalPath);
  if (canonical.kind === 'admitted') {
    return canonical;
  }
  if (input.recordedPath === null || input.recordedPath === canonicalPath) {
    return canonical;
  }
  const recorded = await attempt(input.recordedPath);
  return recorded.kind === 'admitted' ? recorded : canonical;
}

/**
 * 集成要合并的**源**分支：Work Package 隔离 worktree 当前所在的分支。
 *
 * 它必须来自该 worktree 自己的事实：把 canonical 分支当源分支会让 `merge --ff-only` 变成自我合并、
 * 报告成功而什么都没集成（真实运行里出现过这种静默 no-op）。读不到就返回 `null`，由调用方阻塞。
 */
export function integrationSourceBranchOf(
  worktrees: readonly WorktreeSummary[],
  workPackageId: WorkPackageId,
): string | null {
  const match = worktrees.find(
    (entry) => entry.comment === workPackageComment(workPackageId) && !entry.isMainWorktree,
  );
  if (match === undefined || match.branch === null) {
    return null;
  }
  return match.branch.replace(/^refs\/heads\//, '');
}

export async function createForegroundPlanningHost(
  options: ForegroundPlanningHostOptions,
): Promise<ForegroundPlanningHost> {
  const clock = options.clock ?? (() => Date.now());
  const newId = options.newId ?? (() => randomUUID());
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? RUNTIME_HEARTBEAT_INTERVAL_MS;
  const bindingWindowMs = options.sessionBindingWindowMs ?? FINALIZER_BINDING_WINDOW_MS;
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

  /** 已完成交接的接收方可以从被引用的源 Capsule 恢复首个 checkpoint。 */
  const recoverCutoverCheckpoint = (coordinatorSessionId: CoordinatorSessionId): void => {
    const checkpoints = checkpointStoreForScope();
    const current = requireStore();
    if (checkpoints === null || current === null || selectedScopeId === null ||
        checkpoints.loadCheckpoint(coordinatorSessionId).kind !== 'absent') {
      return;
    }
    const responsibility = current.query({ kind: 'planning-responsibility', coordinationScopeId: selectedScopeId });
    const handoffs = current.query({ kind: 'planning-handoffs', coordinationScopeId: selectedScopeId });
    if (responsibility.kind !== 'planning-responsibility' ||
        responsibility.responsibility?.coordinatorSessionId !== coordinatorSessionId ||
        handoffs.kind !== 'planning-handoffs') {
      return;
    }
    const cutover = [...handoffs.handoffs].reverse().find((entry) =>
      entry.phase === 'cutover' && entry.targetCoordinatorSessionId === coordinatorSessionId,
    );
    if (cutover === undefined || cutover.capsuleRef === null) {
      return;
    }
    const capsule = checkpoints.loadPortableCapsule(cutover.sourceCoordinatorSessionId);
    if (capsule === null || capsule.capsuleId !== cutover.capsuleRef) {
      return;
    }
    const saved = checkpoints.saveCheckpoint({
      schemaVersion: COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
      coordinatorSessionId,
      graphPosition: 'model',
      committedMessages: [{
        entryId: 'handoff-capsule:' + capsule.capsuleId,
        stepId: 'handoff:' + cutover.proposalId,
        role: 'system',
        content: capsule.text,
      }],
      committedModelSteps: [],
      wakeBatches: [],
      lastCompactionOutcome: null,
    });
    if (saved.kind === 'failed') {
      throw new Error('无法恢复交接接收方的 checkpoint：' + saved.message);
    }
  };

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
    recoverCutoverCheckpoint(coordinatorSessionId);
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
      started,
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
        executionTools: executionToolsFor(coordinatorSessionId),
      }),
    };
    liveSessions.set(coordinatorSessionId, withGraph);
    startHeartbeat(withGraph);
    // 启动对账序列：复用刚刚取得的 Runtime Incarnation，一个 Scope 恰好一次。
    const startup = await runStartupForScope(withGraph);
    if (startup.kind === 'rejected') {
      publish(coordinatorSessionId, {
        kind: 'blocked',
        coordinationScopeId: withGraph.incarnation.coordinationScopeId,
        code: `startup_${startup.code}`,
        message: `启动对账序列未能完成（停在 ${startup.step}）：${startup.message}；本 Scope 不恢复模型，也不派发`,
      });
      return { kind: 'live', session: withGraph };
    }
    // 「提交后崩溃」的恢复路径：会话历史里还有未被回答的用户消息时，Session 一被打开就恢复模型，
    // 而不是等用户再发一条消息。没有待处理工作时这一次调用会立刻返回。
    // 语义事件只发布启动对账里已经落盘并读回的变化；执行推进按触发点在同一个 Session 上串行执行。
    publishStartupCommittedFacts(withGraph, startup.startup);
    triggerExecution(withGraph);
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
    // 启动序列完成之前不恢复模型：对账、lane 投影、Delivery 重放与 Recovery 续办都还没有结论时，
    // 模型调用可能触发新的派发。放行判定复用 `readiness.mayResumeModel`，控制状态仍然优先。
    if (!mayResumeModelFor(session.incarnation.coordinationScopeId)) {
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
        // 用户命令也是触发点：同一个 Session 上一次最多推进一个阶段（`triggerExecution` 串行化）。
        triggerExecution(session);
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
        executionTools: executionToolsFor(input.coordinatorSessionId),
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
      extraBlockers: [
        ...startupBlockersFor(snapshot.snapshot.scope.coordinationScopeId),
        ...executionBlockersFor(snapshot.snapshot.scope.coordinationScopeId),
      ],
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
      case 'authorization-review': {
        const loaded = await reviewAuthorizationForDisplay();
        return loaded.kind === 'review'
          ? accepted(`已读取完整 Manifest（fingerprint ${loaded.review.fingerprint}）`)
          : rejected(loaded.code, loaded.message);
      }
      case 'authorization-approve':
        return await approveAuthorization({
          fingerprint: intent.fingerprint,
          expectedRevision: intent.expectedRevision,
        });
      case 'scope-control':
        // Pause/Resume/Cancel 走启动序列接线后的真实服务：Resume 先对账再恢复调度。
        return await runScopeControl(intent.action);
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
    if (options.executionBackend !== undefined) {
      return options.executionBackend;
    }
    executionBackend ??= createOrcaExecutionBackend({
      cwd: canonicalWorktreePath,
      env: options.env,
      resolveIdentityHandle: async (ref) => {
        const identity = await orcaProbe.readCoordinatorIdentity();
        return identity.ok && identity.value === ref ? ref : undefined;
      },
    });
    return executionBackend;
  };

  // ---------------------------------------------------------------------
  // 启动对账序列（IP-02 / D4）：一个 Scope 恰好执行一次，复用已启动的 Runtime Incarnation
  //
  // 宿主只做两件事：用**已取过租约的那个** `StartedCoordinatorRuntime` 调用启动序列，以及把它的结论
  // （blocker、放行判决、Scope 控制）接到已有投影上。对账、lane 投影、Delivery 重放、Recovery 续办
  // 与放行判定全部由 `startup.ts` 拥有，这里不复制其中任何一条规则。
  // ---------------------------------------------------------------------

  type ScopeStartup =
    | { readonly kind: 'started'; readonly startup: StartedCompanionStartup }
    | { readonly kind: 'rejected'; readonly step: StartupStep; readonly code: string; readonly message: string };

  /** 每个 Coordination Scope 的启动结论；`null` 表示这个 Scope 还没有启动过。 */
  const scopeStartups = new Map<string, ScopeStartup>();

  /**
   * 执行推进/集成/Finalizer 留下的结构化阻塞。
   *
   * 与启动对账的 blocker 分开存放、一起呈现：两者都是「本进程刚读到的事实」，但来源不同——启动
   * 对账的结论按 Scope 缓存一次，执行阻塞每次都按最新一次调用重写。它只影响呈现，不影响任何判定。
   */
  const executionBlockers = new Map<string, Map<string, ControllerBlockerEntry>>();

  /**
   * 记下一次执行阻塞。
   *
   * 按「阶段」分开存放：集成、Finalizer 与 Frontier 推进各自只清除自己的结论，否则一次成功的推进
   * 会把另一阶段的阻塞悄悄抹掉。读取时与启动 blocker 一起呈现。
   */
  const recordExecutionBlocker = (scopeId: string, stage: string, code: string, message: string): void => {
    const forScope = executionBlockers.get(scopeId) ?? new Map<string, ControllerBlockerEntry>();
    forScope.set(stage, { source: 'injected', code, message });
    executionBlockers.set(scopeId, forScope);
  };

  const clearExecutionBlocker = (scopeId: string, stage: string): void => {
    executionBlockers.get(scopeId)?.delete(stage);
  };

  const startupOf = (coordinationScopeId: string): ScopeStartup | null =>
    scopeStartups.get(coordinationScopeId) ?? null;

  /**
   * 模型恢复门。
   *
   * 启动序列完成之前不恢复模型；失败时同样不恢复——序列的失败意味着「有没有未决副作用」还没有答案。
   */
  const mayResumeModelFor = (coordinationScopeId: string): boolean => {
    const startup = startupOf(coordinationScopeId);
    return startup !== null && startup.kind === 'started' && startup.startup.readiness.mayResumeModel;
  };

  /** 启动结论的只读投影：blocker 与不可读的感知都以既有 blocker 形状进入快照。 */
  const startupBlockersFor = (coordinationScopeId: string): readonly ControllerBlockerEntry[] => {
    const startup = startupOf(coordinationScopeId);
    if (startup === null) {
      return [];
    }
    if (startup.kind === 'rejected') {
      return [
        {
          source: 'injected',
          code: `startup_${startup.code}`,
          message: `启动对账序列未能完成（停在 ${startup.step}）：${startup.message}`,
        },
      ];
    }
    return startup.startup.blockers.map((blocker) => ({
      // Delivery 类阻塞在 Controller 的 blocker 词表里没有对应来源，按 injected 呈现。
      source: blocker.source === 'delivery' ? ('injected' as const) : blocker.source,
      code: blocker.code,
      // 带上来源：同一个 lane 的阻塞在启动序列与 store 投影里都会出现，界面上必须能区分两者。
      message: `${blocker.message}（启动对账${blocker.laneKey === null ? '' : `，lane ${blocker.laneKey}`}）`,
    }));
  };

  /** 当前 Graph Generation 的记录；Scope 没有图时为 `null`。 */
  const graphGenerationOf = (scope: ScopeRecord): GraphGenerationRecord | null => {
    const current = requireStore();
    if (current === null || scope.graphId === null) {
      return null;
    }
    const generations = current.query({ kind: 'graph-generations', coordinationScopeId: scope.coordinationScopeId });
    if (generations.kind !== 'graph-generations') {
      return null;
    }
    return generations.generations.find((entry) => entry.graphId === scope.graphId) ?? null;
  };

  /** Worktree 由 Orca 注释定位，Spec Binding 从该角色的可信物化记录读取。 */
  const readDeliveryWorktreeFacts: DeliveryWorktreeFactReader = async ({
    workPackageId, binding, segment, scopeEnvelope, authority, specificationRevisionLimit,
  }) => {
    const backend = backendForExecution();
    if (backend === null || canonicalWorktreePath === null) {
      return {
        kind: 'unavailable',
        code: 'worktree_unreadable',
        message: '没有可用的 Orca backend 或 canonical worktree：无法读取 Work Package 的 worktree 事实',
      };
    }
    const listed = await backend.query({
      operation: 'worktree-list',
      repo: `path:${canonicalWorktreePath}`,
      limit: 1_000,
    });
    if (listed.kind !== 'accepted') {
      return {
        kind: 'unavailable',
        code: 'worktree_list_unreadable',
        message: `worktree-list 不可用：${listed.code} ${listed.message}`,
      };
    }
    // adapter 的登记 parser（`parseWorktreeList`）已经校验过形状；这里只做一次带理由的窄化。
    const summaries = listed.value as WorktreeListResult;
    const comment = workPackageComment(workPackageId);
    const match = summaries.worktrees.find((worktree) => worktree.comment === comment);
    if (match === undefined) {
      return {
        kind: 'unavailable',
        code: 'worktree_not_found',
        message: `Work Package ${workPackageId} 没有可定位的隔离 worktree（归属注释 ${comment}）`,
      };
    }
    if (binding.worktreeId === null || match.worktreeId !== binding.worktreeId) {
      return {
        kind: 'unavailable',
        code: 'worktree_mismatch',
        message: '实时 worktree 与角色物化绑定不一致或旧绑定缺少身份',
      };
    }
    const observed = await readWorkspaceFacts({ worktreePath: match.path, env: options.env });
    if (observed.kind !== 'observed') {
      return {
        kind: 'unavailable',
        code: 'worktree_unreadable',
        message: `无法读取 ${match.path} 的 Git 事实：${observed.reason}`,
      };
    }
    let specBinding = binding.specBinding;
    if (segment.role === 'planner') {
      if (binding.specificationUnitPath === null || segment.sessionBindingId.length === 0) {
        return { kind: 'unavailable', code: 'planner_declaration_unreadable', message: 'Planner 的规格路径或 Session Binding 不可读' };
      }
      const counters = requiredStore().query({ kind: 'budget-counters', coordinationScopeId: segment.coordinationScopeId });
      if (counters.kind !== 'budget-counters') {
        return { kind: 'unavailable', code: 'budget_unreadable', message: '规格修订预算不可读' };
      }
      const admitted = await admitPlannerUnit({
        provider: createOpenSpecProvider({ resolveWorktreeRoot: (id) => id === match.worktreeId ? match.path : null }),
        workPackageId,
        worktreeId: match.worktreeId,
        sessionBindingId: segment.sessionBindingId,
        scopeEnvelope,
        authority,
        consumedSpecificationRevisions: counters.counters.find(
          (entry) => entry.budgetKey === workPackageBudgetKey(workPackageId, 'specificationRevisions'),
        )?.consumed ?? 0,
        specificationRevisionLimit,
        recordedPath: binding.specificationUnitPath,
      });
      if (admitted.kind === 'rejected') {
        return {
          kind: 'unavailable',
          code: admitted.failures[0]?.code ?? 'specification_rejected',
          message: admitted.failures.map((failure) => `${failure.code}: ${failure.message}`).join('；'),
        };
      }
      specBinding = admitted.specBinding;
    }
    if (specBinding === null) {
      return { kind: 'unavailable', code: 'spec_binding_unreadable', message: '角色物化绑定没有已接纳的 Spec Binding' };
    }
    return {
      kind: 'read',
      worktreeId: match.worktreeId,
      specBinding,
      changedPaths: observed.facts.dirtyPaths,
    };
  };

  /** 最近一次读到的 Run 事实；Worker 停止的 Execution Authority 需要 consumer generation。 */
  let observedRun: { readonly runId: string; readonly consumerGeneration: number } | null = null;

  /** 专用协调身份；读不到时为 `null`（身份不可读不是「没有身份」，因此不生成任何 mutation）。 */
  const readCoordinatorIdentityRef = async (): Promise<string | null> => {
    const identity = await orcaProbe.readCoordinatorIdentity();
    return identity.ok ? identity.value : null;
  };

  /**
   * 执行授权事实：只有图世代、授权与**已核验的 Run 事实**齐备时才成立。
   *
   * 缺少任一项即返回 `null`：调用方（Worker 停止端口）据此把结论报成 `unverifiable`，而不是发出一次
   * 身份不完整的 mutation。
   */
  const executionAuthorityFor = (scope: ScopeRecord | null): ExecutionAuthority | null => {
    if (scope === null || scope.authorizationId === null) {
      return null;
    }
    const generation = graphGenerationOf(scope);
    if (generation === null || observedRun === null || observedRun.runId !== generation.orcaRunId) {
      return null;
    }
    return {
      kind: 'execution_coordination',
      graphGeneration: generation.generation,
      authorizationId: scope.authorizationId,
      runId: observedRun.runId,
      consumerGeneration: observedRun.consumerGeneration,
    };
  };

  /**
   * 当前 Graph Generation 的 Run 读取范围。
   *
   * 三种结论严格区分：`no-run` 是「本 Scope 没有 Run」（读取范围为空，没有可读的 Delivery）；
   * `unreadable` 是「有 Run 但读不到」，调用方必须返回显式 `rejected`；`read` 才有可核验的 Run 事实。
   */
  type ScopeRunScope =
    | { readonly kind: 'no-run' }
    | { readonly kind: 'unreadable'; readonly code: string; readonly message: string }
    | { readonly kind: 'read'; readonly runId: string; readonly consumerGeneration: number };

  const readScopeRunScope = async (input: {
    readonly scope: ScopeRecord;
    readonly generation: GraphGenerationRecord | null;
    readonly backend: ExecutionBackend | null;
    readonly identity: string | null;
  }): Promise<ScopeRunScope> => {
    if (input.generation === null || input.scope.authorizationId === null) {
      return { kind: 'no-run' };
    }
    if (input.backend === null || input.identity === null) {
      return {
        kind: 'unreadable',
        code: 'delivery_read_unavailable',
        message:
          input.identity === null
            ? '缺少专用协调身份：无法按身份读取未确认 Delivery'
            : '无法建立 Orca ExecutionBackend：无法读取未确认 Delivery',
      };
    }
    if (input.scope.graphId === null || input.scope.graphVersion === null) {
      return {
        kind: 'unreadable',
        code: 'graph_version_missing',
        message: '当前 Scope 没有可读的 GraphVersion：Scope Envelope 与 Delivery 归属都无从核验',
      };
    }
    const runRead = await input.backend.query({
      operation: 'run-current',
      backendIdentityRef: input.identity,
    });
    if (runRead.kind !== 'accepted') {
      return { kind: 'unreadable', code: 'run_unreadable', message: `无法读取当前 Run：${runRead.code} ${runRead.message}` };
    }
    // adapter 的登记 parser（`parseRunShow`）已经校验过形状；这里只做一次带理由的窄化。
    const current = runRead.value as { readonly run?: RunSummary | null };
    const run = current.run ?? null;
    if (run === null) {
      return {
        kind: 'unreadable',
        code: 'run_missing',
        message: `当前没有可读的 Orca Run（世代记录绑定 ${input.generation.orcaRunId}）：无法读取未确认 Delivery`,
      };
    }
    if (run.runId !== input.generation.orcaRunId) {
      return {
        kind: 'unreadable',
        code: 'run_mismatch',
        message:
          `终端的当前 Run 是 ${run.runId}，不是当前世代绑定的 ${input.generation.orcaRunId}：` +
          '不越界读取其它 Run 的 Delivery',
      };
    }
    observedRun = { runId: run.runId, consumerGeneration: run.consumerGeneration };
    return { kind: 'read', runId: run.runId, consumerGeneration: run.consumerGeneration };
  };

  /**
   * 启动序列的 Delivery 事实。
   *
   * 读取范围是**当前 Graph Generation 的 Run**：`no-run` 时「没有未确认 Delivery」是对这个读取范围的
   * 忠实回答（不是推断）；`unreadable` 时 `readPending` 返回显式 `rejected`，绝不用空数组冒充。
   */
  const startupDeliveriesFor = (input: {
    readonly scope: ScopeRecord;
    readonly generation: GraphGenerationRecord | null;
    readonly backend: ExecutionBackend | null;
    readonly identity: string | null;
    readonly run: ScopeRunScope;
  }): StartupDeliveryFacts => {
    const base = {
      backendIdentityRef: input.identity ?? '',
      graphGeneration: input.generation === null ? 0 : input.generation.generation,
      authorizationId: input.scope.authorizationId ?? '',
      runId: input.generation === null ? '' : input.generation.orcaRunId,
      // `no-run` 时这些字段不参与任何判定（`readPending` 恒为空）；读取范围为空是读取事实，不是推断。
      consumerGeneration: input.run.kind === 'read' ? input.run.consumerGeneration : 0,
      timeoutMs: MUTATION_TIMEOUT_MS,
    };
    if (input.run.kind === 'no-run') {
      return { ...base, readPending: () => Promise.resolve({ kind: 'read', pending: [] }) };
    }
    if (input.run.kind === 'unreadable') {
      const { code, message } = input.run;
      return { ...base, readPending: () => Promise.resolve({ kind: 'rejected', code, message }) };
    }
    const backend = input.backend;
    const graphId = input.scope.graphId;
    const graphVersion = input.scope.graphVersion;
    if (backend === null || graphId === null || graphVersion === null) {
      return {
        ...base,
        readPending: () =>
          Promise.resolve({
            kind: 'rejected',
            code: 'delivery_read_unavailable',
            message: 'Run 事实可读，但 backend 或 GraphVersion 不可读：无法装配未确认 Delivery',
          }),
      };
    }
    const runId = input.run.runId;
    return {
      ...base,
      runId,
      readPending: () =>
        readPendingDeliveries({
          store: requiredStore(),
          backend,
          coordinationScopeId: input.scope.coordinationScopeId,
          backendIdentityRef: base.backendIdentityRef,
          graphId,
          graphVersion,
          graphGeneration: base.graphGeneration,
          authorizationId: base.authorizationId,
          runId,
          consumerGeneration: base.consumerGeneration,
          timeoutMs: base.timeoutMs,
          readWorktreeFacts: readDeliveryWorktreeFacts,
        }),
    };
  };

  /**
   * Worker 停止端口：按调用建立，身份与授权在调用时读取。
   *
   * 启动序列需要的是「一个可用的端口」，而不是「已经解析好的身份」，因此这里把身份/授权的读取推到
   * 真正请求停止的时候：那时读不到就如实报告 `unavailable` / `unverifiable`，不臆造身份。
   */
  const workerStopPortFor = (coordinationScopeId: CoordinationScopeId): WorkerStopPort => {
    const build = async (): Promise<WorkerStopPort | null> => {
      const current = requireStore();
      const backend = backendForExecution();
      if (current === null || backend === null) {
        return null;
      }
      const identity = await readCoordinatorIdentityRef();
      if (identity === null) {
        return null;
      }
      return createOrcaWorkerStopPort({
        backend,
        coordinationScopeId,
        backendIdentityRef: identity,
        timeoutMs: MUTATION_TIMEOUT_MS,
        activeRunId: () => {
          const scope = scopeRecord(coordinationScopeId);
          if (scope === null) {
            return null;
          }
          const generation = graphGenerationOf(scope);
          return generation === null ? null : generation.orcaRunId;
        },
        authority: () => executionAuthorityFor(scopeRecord(coordinationScopeId)),
        store: current,
        clock,
      });
    };
    return {
      listActiveDispatches: async (input) => {
        const port = await build();
        return port === null
          ? { kind: 'unavailable', reason: '缺少专用协调身份或 Orca backend：无法枚举活跃 Worker' }
          : await port.listActiveDispatches(input);
      },
      requestStop: async (input) => {
        const port = await build();
        // 停否无法核验时必须报 unverifiable，绝不报 stopped。
        return port === null ? 'unverifiable' : await port.requestStop(input);
      },
    };
  };

  /**
   * 一个 Coordination Scope 的启动对账序列：**恰好执行一次**，且复用已启动的 Runtime Incarnation。
   *
   * 结论按 Scope 缓存：正在启动或已经失败都不会第二次执行——第二次执行会在同一 lane 上产生第二次
   * 写入，而「启动序列已完成」本身就是放行判定的一部分。失败不抛出异常，而是记成可观察的结论：
   * 该 Scope 的模型不恢复、Scope 控制返回显式原因，直到进程重启（重启就是一个新的 Incarnation）。
   */
  const runStartupForScope = async (session: LiveSession): Promise<ScopeStartup> => {
    const scopeId = session.incarnation.coordinationScopeId;
    const existing = startupOf(scopeId);
    if (existing !== null) {
      return existing;
    }
    const current = requireStore();
    const scope = current === null ? null : scopeRecord(scopeId);
    const backend = backendForExecution();
    const canonicalWorktree = canonicalWorktreePath;
    const conclude = (conclusion: ScopeStartup): ScopeStartup => {
      scopeStartups.set(scopeId, conclusion);
      return conclusion;
    };
    if (current === null || scope === null) {
      return conclude({
        kind: 'rejected',
        step: 'runtime_started',
        code: 'scope_unavailable',
        message: `无法读取 Scope ${scopeId}：启动对账序列无从执行`,
      });
    }
    if (backend === null || canonicalWorktree === null) {
      return conclude({
        kind: 'rejected',
        step: 'runtime_started',
        code: 'backend_unavailable',
        message: '无法建立 Orca ExecutionBackend：启动对账序列无从执行',
      });
    }
    const generation = graphGenerationOf(scope);
    const identity = generation === null ? null : await readCoordinatorIdentityRef();
    const run = await readScopeRunScope({ scope, generation, backend, identity });
    const execution =
      generation === null || identity === null || scope.authorizationId === null || run.kind !== 'read'
        ? null
        : {
            backendIdentityRef: identity,
            graphGeneration: generation.generation,
            authorizationId: scope.authorizationId,
            runId: run.runId,
            consumerGeneration: run.consumerGeneration,
            timeoutMs: MUTATION_TIMEOUT_MS,
          };
    const startup = await startCompanionStartup({
      // 复用同一个 Incarnation：这是 D4 的「一个 Scope 一个 Runtime Lease」，不再取第二份租约。
      runtime: {
        kind: 'already-started',
        runtime: session.started,
        coordinationStore: current,
        coordinationScopeId: scopeId,
      },
      backend,
      clock,
      deliveries: startupDeliveriesFor({ scope, generation, backend, identity, run }),
      recovery: createExecutionRecoveryFacts({
        // store 懒取：与其它装配一样按需要读，避免把「已经关闭的 store」捕获进长期 seam。
        store: () => {
          const current = requireStore();
          if (current === null) {
            throw new Error('Branch Coordination State 不可用：无法读取 Recovery 事实');
          }
          return current;
        },
        backend,
        coordinationScopeId: scopeId,
        canonicalWorktree,
        execution,
        workerHarness: config?.execution.harness ?? null,
        workerModel: config?.execution.workerModel ?? null,
        codexSandbox: codexSandboxForDispatch(approvedRisksFor(scopeId)),
        companionStateRoot: commonDirPath === null ? null : join(commonDirPath, COMPANION_STATE_DIRECTORY),
        writer: writerFor(session.started.incarnation),
        env: options.env,
        clock,
        bindingWindowMs,
      }),
      workers: workerStopPortFor(scopeId),
    });
    return conclude(
      startup.kind === 'started'
        ? { kind: 'started', startup }
        : { kind: 'rejected', step: startup.step, code: startup.code, message: startup.message },
    );
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
      finalizer: finalizerObservations.get(scope.coordinationScopeId) ?? {
        // 本进程还没有读到 Finalizer 的只读证明与运行前后工作区：如实标为未核验/未记录。
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

  /* ------------------------------------------------------------------------ */
  /* 执行推进（IP-03）：角色派发装配与一次 Frontier 推进                        */
  //
  // 这一段只做「读事实 + 装配 + 一次委托」：候选选择、稳定 OperationId、lane 阻塞与物化顺序都在
  // `advanceExecution` 里，这里不复制任何一条规则。触发点固定为宿主命令与事件处理（启动对账完成、
  // 授权切换成功、Resume 成功、集成/Finalizer 结论落地），绝不来自 React render/effect/resize。
  /* ------------------------------------------------------------------------ */

  /** Worker Result 的结构版本；与 `worker-report-dto` 接受的值一致（它不导出该常量）。 */
  const WORKER_RESULT_SCHEMA_VERSION = 1;

  /** 执行推进可能的角色：Finalizer 不是 Frontier 角色，它由项目级只读派发拥有。 */
  type AdvanceRole = Exclude<WorkerRole, 'finalizer'>;

  /** 稳定派生的分段编码：同一组事实必须得到同一个身份，且不同分段不会在边界碰撞。 */
  const derivedKey = (prefix: string, segments: readonly string[]): string =>
    [prefix, ...segments.map((segment) => encodeURIComponent(segment))].join(':');

  /** 当前 Session 是否持有本 Scope 的 Execution Coordination Lease；非持有者连一次外部 mutation 都不发起。 */
  const holdsExecutionLease = (scopeId: CoordinationScopeId, sessionId: CoordinatorSessionId): boolean => {
    const current = requireStore();
    if (current === null) {
      return false;
    }
    const snapshot = current.query({ kind: 'snapshot', coordinationScopeId: scopeId });
    return (
      snapshot.kind === 'snapshot' &&
      snapshot.snapshot.executionLease !== null &&
      snapshot.snapshot.executionLease.coordinatorSessionId === sessionId
    );
  };

  /** 最近一条已完成（已收尾且被接受）的 Git Integration Operation 的 expected HEAD；没有记录时为 `null`。 */
  const lastIntegrationExpectedHeadOf = (scopeId: CoordinationScopeId): string | null => {
    const current = requireStore();
    if (current === null) {
      return null;
    }
    const intents = current.query({ kind: 'intents', coordinationScopeId: scopeId });
    if (intents.kind !== 'intents') {
      return null;
    }
    const completed = intents.intents.filter(
      (intent) =>
        intent.operationCategory === 'git-integration' &&
        intent.state === 'settled' &&
        intent.outcomeClass === 'accepted' &&
        intent.expectedHead !== null,
    );
    const latest = completed.reduce<OperationIntent | null>((latest, candidate) => {
      const latestAt = latest === null ? Number.NEGATIVE_INFINITY : (latest.settledAt ?? latest.createdAt);
      return (candidate.settledAt ?? candidate.createdAt) >= latestAt ? candidate : latest;
    }, null);
    return latest === null ? null : latest.expectedHead;
  };

  /** 读不到 canonical HEAD 归属事实时返回 `blocked`：没有归属就不能派发，也不许猜一个。 */
  const readCanonicalHeadFacts = async (input: {
    readonly scopeId: CoordinationScopeId;
    readonly baselineHead: string;
  }): Promise<
    | { readonly kind: 'read'; readonly facts: CanonicalHeadFacts }
    | { readonly kind: 'blocked'; readonly code: string; readonly message: string }
  > => {
    if (canonicalWorktreePath === null) {
      return { kind: 'blocked', code: 'repository_unresolved', message: '缺少可核验的 canonical worktree' };
    }
    const current = requireStore();
    if (current === null) {
      return { kind: 'blocked', code: 'store_unavailable', message: 'Branch Coordination State 不可用' };
    }
    const observed = await readWorkspaceFacts({ worktreePath: canonicalWorktreePath, env: options.env });
    if (observed.kind !== 'observed') {
      return {
        kind: 'blocked',
        code: 'canonical_head_unreadable',
        message: `无法读取 canonical 工作区的 Git 事实：${observed.reason}`,
      };
    }
    const intents = current.query({ kind: 'intents', coordinationScopeId: input.scopeId });
    if (intents.kind !== 'intents') {
      return {
        kind: 'blocked',
        code: 'integration_records_unreadable',
        message: '无法读取 Operation Intent 记录：canonical HEAD 的归属无从核验',
      };
    }
    return {
      kind: 'read',
      facts: {
        canonicalHead: observed.facts.head,
        authorizedBaselineHead: input.baselineHead,
        canonicalWorktreeDirty: projectChangedPaths(observed.facts.dirtyPaths).length > 0,
        lastIntegrationExpectedHead: lastIntegrationExpectedHeadOf(input.scopeId),
      },
    };
  };

  /** 每个角色派发实际消费的预算项；规划与验证不消耗实现额度（各自额度由对应用例判定）。 */
  const requiredBudgetFieldOf = (role: WorkerRole): WorkPackageBudgetField | null =>
    role === 'implementation' ? 'implementationAttempts' : null;

  /**
   * 同一 Work Package 的同一角色已接受的结算次数 + 1。
   *
   * Attempt 只由已提交的结算事实推出：同一候尊重启、重放都得到同一个序号，因此派发身份稳定；
   * 归属经物化绑定（Orca Task 身份）对齐，不接受调用方传入的计数。
   */
  const attemptIndexOf = (
    snapshot: CoordinationSnapshot,
    workPackageId: WorkPackageId,
    role: WorkerRole,
  ): number => {
    const bindings = snapshot.materializationBindings.filter(
      (entry) => entry.workPackageId === workPackageId && entry.role === role,
    );
    const accepted = snapshot.deliverySettlements.filter((settlement) =>
      settlement.role === role && bindings.some((binding) => binding.workerTaskId === settlement.workerTaskId),
    );
    return accepted.length + 1;
  };

  /** 一次角色派发的稳定身份（D9：Scope、Generation、Work Package、角色、契约 revision、Attempt）。 */
  const roleIdentityOf = (input: {
    readonly scopeId: CoordinationScopeId;
    readonly graphId: string;
    readonly generation: number;
    readonly workPackageId: WorkPackageId;
    readonly role: WorkerRole;
    readonly contractRevision: number;
    readonly attempt: number;
  }): {
    readonly attemptId: string;
    readonly workerTaskId: WorkerTaskId;
    readonly dispatchId: DispatchId;
    readonly launchId: string;
  } => {
    const segments = [
      input.scopeId,
      input.graphId,
      String(input.generation),
      input.workPackageId,
      input.role,
      String(input.contractRevision),
      String(input.attempt),
    ];
    return {
      attemptId: derivedKey('attempt', segments),
      workerTaskId: derivedKey('worker-task', segments) as WorkerTaskId,
      dispatchId: derivedKey('dispatch', segments) as DispatchId,
      launchId: derivedKey('worker-launch', segments),
    };
  };

  /**
   * 角色级派发实际使用的 Codex 沙箱模式。
   *
   * 放宽到 `danger-full-access` 需要两个事实同时成立：项目配置声明了该模式，且**已批准的 Manifest**
   * 在 `acceptedRisks` 里显式接受了对应风险。只看配置会让审批之后的一次配置改动悄悄改变实际沙箱，
   * 因此运行值由已批准的那份内容决定；缺少任一项都返回 `null`，调用方据此阻塞派发。
   */
  const codexSandboxForDispatch = (approvedRisks: readonly string[]): CodexSandboxMode | null => {
    const mode = config?.execution.codexSandbox ?? DEFAULT_PROJECT_EXECUTION.codexSandbox;
    return mode === 'danger-full-access' && !approvedRisks.includes(CODEX_FULL_ACCESS_RISK) ? null : mode;
  };

  /** 当前有效授权接受的具名风险；没有有效授权时为空，因此放宽沙箱不会被误当成已批准。 */
  const approvedRisksFor = (scopeId: CoordinationScopeId): readonly string[] => {
    const current = requireStore();
    if (current === null) {
      return [];
    }
    const active = activeAuthorization(current, scopeId);
    return active.kind === 'rejected' || active.authorization === null
      ? []
      : active.authorization.manifest.acceptedRisks;
  };

  type RoleDispatchAssembly =
    | {
        readonly kind: 'ready';
        readonly roles: Partial<Record<WorkerRole, AdvanceRoleDispatch>>;
        readonly reportPath: string;
        readonly expectedCodexHome: string;
      }
    | { readonly kind: 'blocked'; readonly code: string; readonly message: string };

  /**
   * 候选 Work Package 的三个角色级派发装配。
   *
   * 每一项都来自权威事实：图提供 Scope Envelope、依赖与预算；Manifest 提供 baseline HEAD、角色权限与
   * 上限；Spec Binding 从 canonical 工作区的唯一 active OpenSpec change 读出内容身份（Work Package 到
   * Specification Unit 的映射目前没有更细的权威来源，因此这里只读「当前唯一 active change」，读不到
   * 或存在多个时阻塞而不是猜一个）。Worker 身份与启动策略由本段稳定派生，模型与界面都填不了。
   */
  const roleDispatchesFor = async (input: {
    readonly scopeId: CoordinationScopeId;
    readonly graph: ExecutionGraph;
    readonly manifest: ExecutionAuthorizationManifest;
    readonly workPackage: WorkPackage;
    readonly role: AdvanceRole;
    readonly snapshot: CoordinationSnapshot;
    readonly run: { readonly runId: string; readonly consumerGeneration: number };
    readonly backendIdentityRef: string;
    readonly canonicalWorktree: string;
  }): Promise<RoleDispatchAssembly> => {
    if (config === null) {
      return { kind: 'blocked', code: 'config_unavailable', message: '项目配置不可用' };
    }
    if (config.execution.harness !== 'codex') {
      return {
        kind: 'blocked',
        code: 'worker_harness_unsupported',
        message: `Worker Profile 的 harness 为 ${config.execution.harness}，本进程只能派发 codex Worker`,
      };
    }
    const workerModel = config.execution.workerModel;
    if (workerModel === null) {
      return {
        kind: 'blocked',
        code: 'worker_model_unresolved',
        message: '项目配置没有给出 Worker 模型（execution.workerModel）：不伪造模型派发 Worker',
      };
    }
    const sandboxMode = codexSandboxForDispatch(input.manifest.acceptedRisks);
    if (sandboxMode === null) {
      return {
        kind: 'blocked',
        code: 'codex_sandbox_risk_not_accepted',
        message: `Worker 沙箱被设为 danger-full-access，但已批准的 Manifest 没有接受 ${CODEX_FULL_ACCESS_RISK}：先重新审阅并批准`,
      };
    }
    if (commonDirPath === null) {
      return { kind: 'blocked', code: 'state_root_unavailable', message: '无法定位 Companion 私有状态目录' };
    }
    const specificationUnitPath = specificationUnitPathFor(input.workPackage.workPackageId);
    let specBinding: SpecBinding | null = null;
    if (input.role !== 'planner') {
      if (input.role === 'validator') {
        specBinding = input.snapshot.materializationBindings.find(
          (entry) => entry.workPackageId === input.workPackage.workPackageId && entry.role === 'implementation',
        )?.specBinding ?? null;
        if (specBinding === null) {
          return { kind: 'blocked', code: 'spec_binding_missing', message: 'Implementation 的已接纳 Spec Binding 不可读' };
        }
      } else {
        const planner = [...input.snapshot.sessionSegments].reverse().find(
          (segment) => segment.workPackageId === input.workPackage.workPackageId && segment.role === 'planner' && segment.verifiable,
        );
        if (planner === undefined) {
          return { kind: 'blocked', code: 'planner_session_unbound', message: 'Planner 没有可核验的精确 Session Binding' };
        }
        const backend = backendForExecution();
        if (backend === null) {
          return { kind: 'blocked', code: 'backend_unavailable', message: '无法读取 Planner worktree' };
        }
        const listed = await backend.query({ operation: 'worktree-list', repo: `path:${input.canonicalWorktree}`, limit: 1_000 });
        if (listed.kind !== 'accepted') {
          return { kind: 'blocked', code: listed.code, message: listed.message };
        }
        const worktrees = listed.value as WorktreeListResult;
        if (worktrees.truncated || worktrees.hostScope === null || worktrees.hostScope.omittedHostIds.length > 0) {
          return { kind: 'blocked', code: 'worktree_scope_unverifiable', message: 'Planner worktree 列举不完整' };
        }
        const worktree = worktrees.worktrees.find((entry) => entry.comment === workPackageComment(input.workPackage.workPackageId));
        if (worktree === undefined) {
          return { kind: 'blocked', code: 'worktree_not_found', message: 'Planner 隔离 worktree 不可读' };
        }
        const provider = createOpenSpecProvider({ resolveWorktreeRoot: (id) => id === worktree.worktreeId ? worktree.path : null });
        const counters = requiredStore().query({ kind: 'budget-counters', coordinationScopeId: input.scopeId });
        if (counters.kind !== 'budget-counters') {
          return { kind: 'blocked', code: 'budget_unreadable', message: '规格修订预算不可读' };
        }
        const admission = await admitPlannerUnit({
          provider,
          workPackageId: input.workPackage.workPackageId,
          worktreeId: worktree.worktreeId,
          sessionBindingId: planner.sessionBindingId,
          scopeEnvelope: input.workPackage.scopeEnvelope,
          authority: input.manifest.permissions,
          consumedSpecificationRevisions: counters.counters.find(
            (counter) => counter.budgetKey === workPackageBudgetKey(input.workPackage.workPackageId, 'specificationRevisions'),
          )?.consumed ?? 0,
          specificationRevisionLimit: input.workPackage.budget.specificationRevisions,
          recordedPath:
            input.snapshot.materializationBindings.find(
              (entry) => entry.workPackageId === input.workPackage.workPackageId && entry.role === 'planner',
            )?.specificationUnitPath ?? null,
        });
        if (admission.kind === 'rejected') {
          return {
            kind: 'blocked',
            code: admission.failures[0]?.code ?? 'specification_rejected',
            message: admission.failures.map((failure) => `${failure.code}: ${failure.message}`).join('；'),
          };
        }
        specBinding = admission.specBinding;
      }
    }
    const evidence: readonly EvidenceRequirement[] = [
      { evidenceKind: 'command', coveredPaths: [...input.workPackage.scopeEnvelope.include] },
    ];
    const roles: Partial<Record<WorkerRole, AdvanceRoleDispatch>> = {};
    let reportPath = '';
    let expectedCodexHome = '';
    for (const role of [input.role]) {
      const identity = roleIdentityOf({
        scopeId: input.scopeId,
        graphId: input.graph.graphId,
        generation: input.graph.generation,
        workPackageId: input.workPackage.workPackageId,
        role,
        contractRevision: specBinding?.contractRevision ?? 0,
        attempt: attemptIndexOf(input.snapshot, input.workPackage.workPackageId, role),
      });
      const paths = codexSessionPaths(identity.launchId);
      if (paths === null) {
        return { kind: 'blocked', code: 'state_root_unavailable', message: '无法建立 Codex Session reporter' };
      }
      installCodexSessionStartReporter(paths);
      reportPath = paths.reportPath;
      expectedCodexHome = join(paths.stateRoot, createHash('sha256').update(identity.launchId).digest('hex').slice(0, 20));
      const taskEnvelope: TaskEnvelope = {
        schemaVersion: TASK_ENVELOPE_SCHEMA_VERSION,
        workerTaskId: identity.workerTaskId,
        dispatchId: identity.dispatchId,
        attemptId: identity.attemptId,
        role,
        taskContract: {
          schemaVersion: TASK_CONTRACT_SCHEMA_VERSION,
          workPackageId: input.workPackage.workPackageId,
          graphGeneration: input.graph.generation,
          dependencies: [...input.workPackage.dependsOn],
          scopeEnvelope: {
            include: [...input.workPackage.scopeEnvelope.include],
            exclude: [...input.workPackage.scopeEnvelope.exclude],
          },
          baselineHead: input.manifest.baselineHead,
          authority: input.manifest.permissions,
          budget: input.workPackage.budget,
          acceptanceEvidence: evidence,
          resultSchemaVersion: WORKER_RESULT_SCHEMA_VERSION,
        },
        specBinding,
        ...(role === 'planner' ? { specificationUnitPath } : {}),
        // 指令是宿主写出的正文：Planner 的产出位置与结构由 Envelope 说清，不留给 Worker 猜。
        instructions: role === 'planner' ? plannerSpecificationInstructions(specificationUnitPath) : [],
        // worktree 身份由物化阶段按实际建立的隔离 worktree 绑定，这里不预填路径。
        workspace: { worktreeId: 'unbound', canonicalWorktree: input.canonicalWorktree, relativePath: '.' },
        authority: input.manifest.permissions,
        budget: {
          implementationAttempts: input.manifest.limits.implementationAttempts,
          validatorRepairs: input.manifest.limits.validatorRepairs,
          recoveries: input.manifest.limits.maxRecoveriesPerWorkerAttempt,
        },
        expectedEvidence: evidence,
      };
      roles[role] = {
        taskEnvelope,
        workerLaunch: createCodexWorkerLaunch({
          launchId: identity.launchId,
          model: workerModel,
          // 沙箱模式来自已批准的 Manifest 所绑定的项目配置：放宽只有在授权审阅里显式接受风险时才生效。
          sandboxMode,
          stateRoot: paths.stateRoot,
          sessionStartReporterPath: paths.reporterPath,
        }),
        // launch 身份与 workerLaunch 同源：物化绑定把它记成事实，供错过的 Session Binding 补记。
        launchId: identity.launchId,
        consumerGeneration: input.run.consumerGeneration,
        backendIdentityRef: input.backendIdentityRef,
        timeoutMs: MUTATION_TIMEOUT_MS,
        requiredBudgetField: requiredBudgetFieldOf(role),
        taskTitle: `${input.workPackage.title}（${role}）`,
      };
    }
    return { kind: 'ready', roles, reportPath, expectedCodexHome };
  };

  /**
   * 下一个该推进的角色；`null` 表示此刻没有可推进的候选。
   *
   * 与 `advance-execution.ts` 的角色序映射同规则（那个函数不导出）：派生输入相同（同一图、同一观察
   * 事实），因此这里的候选与执行驱动的候选一致；不一致时执行驱动以 `dispatch-mismatch` 返回 idle，
   * 不产生任何副作用。
   */
  const nextAdvanceRole = (entry: {
    readonly state: string;
    readonly role: WorkerRole | null;
  }): AdvanceRole | null => {
    switch (entry.state) {
      case 'admitting':
        return 'planner';
      case 'implementing':
        return entry.role === 'planner' ? 'implementation' : null;
      case 'validating':
        return entry.role === 'implementation' ? 'validator' : null;
      default:
        return null;
    }
  };

  type AdvanceInputAssembly =
    | { readonly kind: 'ready'; readonly input: Parameters<typeof advanceExecution>[0]; readonly reportPath: string; readonly expectedCodexHome: string }
    | { readonly kind: 'idle'; readonly reason: string; readonly blockers: readonly string[] }
    | { readonly kind: 'blocked'; readonly code: string; readonly message: string };

  /**
   * 组装一次 `advanceExecution` 的全部输入。
   *
   * 顺序固定：先判「本 Session 是否有推进权」，再读图、授权、Run、观察与 Git 事实；任何一项读不回来
   * 都停在 blocker，绝不带默认值继续。roles 只装配当前候选的三个角色级派发。
   */
  const advanceInputFor = async (session: LiveSession): Promise<AdvanceInputAssembly> => {
    const scopeId = session.incarnation.coordinationScopeId;
    const current = requireStore();
    if (current === null) {
      return { kind: 'blocked', code: 'store_unavailable', message: 'Branch Coordination State 不可用' };
    }
    const scope = scopeRecord(scopeId);
    if (scope === null) {
      return { kind: 'blocked', code: 'scope_unavailable', message: `无法读取 Scope ${scopeId}` };
    }
    if (scope.mode !== 'execution_coordination') {
      return { kind: 'idle', reason: `Scope 当前模式为 ${scope.mode}`, blockers: [] };
    }
    if (!holdsExecutionLease(scopeId, session.coordinatorSessionId)) {
      return {
        kind: 'idle',
        reason: '本 Session 不持有 Execution Coordination Lease',
        blockers: ['execution-lease:not-holder'],
      };
    }
    const snapshotRead = current.query({ kind: 'snapshot', coordinationScopeId: scopeId });
    if (snapshotRead.kind !== 'snapshot') {
      return { kind: 'blocked', code: 'invalid_state', message: '无法读取协调快照' };
    }
    const snapshot = snapshotRead.snapshot;
    if (scope.graphId === null || scope.graphVersion === null) {
      return { kind: 'idle', reason: 'Scope 还没有已记录的 Graph Version', blockers: [] };
    }
    const graphRead = current.query({
      kind: 'graph-version',
      coordinationScopeId: scopeId,
      graphId: scope.graphId,
      graphVersion: scope.graphVersion,
    });
    if (graphRead.kind !== 'graph-version' || graphRead.version === null) {
      return {
        kind: 'blocked',
        code: 'invalid_state',
        message: `无法读取 Graph Version ${String(scope.graphVersion)}`,
      };
    }
    const graph = graphRead.version.graph;
    const authorizationRead = activeAuthorization(current, scopeId);
    if (authorizationRead.kind === 'rejected') {
      return {
        kind: 'blocked',
        code: authorizationRead.failure.code,
        message: authorizationRead.failure.message,
      };
    }
    const authorization: ExecutionAuthorizationRecord | null = authorizationRead.authorization;
    if (authorization === null) {
      return { kind: 'idle', reason: '尚无有效的 Execution Authorization', blockers: ['authorization:missing'] };
    }
    if (canonicalWorktreePath === null) {
      return { kind: 'blocked', code: 'repository_unresolved', message: '缺少可核验的 canonical worktree' };
    }
    const backend = backendForExecution();
    if (backend === null) {
      return { kind: 'blocked', code: 'backend_unavailable', message: '无法建立 Orca ExecutionBackend' };
    }
    const identity = await readCoordinatorIdentityRef();
    if (identity === null) {
      return { kind: 'blocked', code: 'identity_unavailable', message: '缺少专用协调身份' };
    }
    const run = await readScopeRunScope({
      scope,
      generation: graphGenerationOf(scope),
      backend,
      identity,
    });
    if (run.kind === 'no-run') {
      return { kind: 'idle', reason: '本 Scope 还没有与当前世代绑定的 Run', blockers: ['run:none'] };
    }
    if (run.kind === 'unreadable') {
      return { kind: 'blocked', code: run.code, message: run.message };
    }
    const nodes = graph.workPackages.map((workPackage) => ({
      workPackageId: workPackage.workPackageId,
      dependsOn: [...workPackage.dependsOn],
    }));
    const observations = await executionObservations(scope, nodes);
    const derived = executionDerivation({
      snapshot,
      scope,
      observations,
      nodes,
      baselineHead: authorization.manifest.baselineHead,
      authority: authorization.manifest.permissions,
      recoveryBudgetLimit: authorization.manifest.limits.maxRecoveriesPerWorkerAttempt,
    });
    publishLivenessChanges(scopeId, derived.workers);
    const entry = derived.execution.frontier.find((candidate) => nextAdvanceRole(candidate) !== null);
    if (entry === undefined) {
      return { kind: 'idle', reason: 'Frontier 中没有可推进的候选', blockers: [] };
    }
    const workPackage = graph.workPackages.find(
      (candidate) => candidate.workPackageId === entry.workPackageId,
    );
    if (workPackage === undefined) {
      return {
        kind: 'blocked',
        code: 'invalid_state',
        message: `Graph Version ${String(scope.graphVersion)} 不含 Work Package ${entry.workPackageId}`,
      };
    }
    const head = await readCanonicalHeadFacts({
      scopeId,
      baselineHead: authorization.manifest.baselineHead,
    });
    if (head.kind === 'blocked') {
      return head;
    }
    const dispatches = await roleDispatchesFor({
      scopeId,
      graph,
      manifest: authorization.manifest,
      workPackage,
      role: nextAdvanceRole(entry)!,
      snapshot,
      run,
      backendIdentityRef: identity,
      canonicalWorktree: canonicalWorktreePath,
    });
    if (dispatches.kind === 'blocked') {
      return dispatches;
    }
    return {
      kind: 'ready',
      reportPath: dispatches.reportPath,
      expectedCodexHome: dispatches.expectedCodexHome,
      input: {
        store: current,
        backend,
        coordinationScopeId: scopeId,
        writer: writerFor(session.incarnation),
        expectedRevision: scope.revision,
        canonicalHead: head.facts,
        observations,
        roles: dispatches.roles,
      },
    };
  };

  /**
   * 一次 Frontier 推进。
   *
   * `progressed` 才发布提交后事件并清掉上一次的执行阻塞；`blocked` / `unknown` 以结构化 blocker 进入
   * 快照，并保留原 OperationId 供对账——不换 ID 重试，也不在同一个触发点里再试第二次。
   */
  /** 把一次已签发的 Session Binding 落成 Session Segment；重复写入必须逐项一致。 */
  const recordRoleSegment = (input: {
    readonly session: LiveSession;
    readonly segmentId: string;
    readonly workPackageId: WorkPackageId;
    readonly role: WorkerRole;
    readonly workerTaskId: WorkerTaskId;
    readonly dispatchId: DispatchId;
    readonly attemptId: string;
    readonly binding: SessionBinding;
  }): { readonly code: string; readonly message: string } | null => {
    const scopeId = input.session.incarnation.coordinationScopeId;
    const current = requiredStore();
    const snapshot = current.query({ kind: 'snapshot', coordinationScopeId: scopeId });
    if (snapshot.kind !== 'snapshot') {
      return { code: 'store_unavailable', message: '无法读取派发后的协调快照' };
    }
    const sessionBindingId = sessionBindingIdOf(input.dispatchId, input.binding.providerSessionId);
    const existing = snapshot.snapshot.sessionSegments.find((entry) => entry.segmentId === input.segmentId);
    if (existing !== undefined) {
      return existing.sessionBindingId === sessionBindingId
        ? null
        : { code: 'session_binding_conflict', message: '同一 Dispatch 已记录不同的 Session Binding' };
    }
    const scope = scopeRecord(scopeId);
    if (scope === null) {
      return { code: 'scope_unavailable', message: '无法读取派发后的 Scope revision' };
    }
    const recorded = current.transact({
      kind: 'record-session-segment',
      coordinationScopeId: scopeId,
      expectedRevision: scope.revision,
      writer: writerFor(input.session.incarnation),
      segmentId: input.segmentId as never,
      workPackageId: input.workPackageId,
      role: input.role,
      workerTaskId: input.workerTaskId,
      dispatchId: input.dispatchId,
      attemptId: input.attemptId,
      sessionBindingId,
      lastTranscriptRef: input.binding.transcriptRef,
      terminalReceiptRef: null,
      transcriptReferenceable: true,
      verifiable: true,
    });
    return recorded.kind === 'committed' ? null : { code: recorded.code, message: recorded.message };
  };

  /**
   * 派发刚成功时建立 Session Binding（IP-04）。
   *
   * 报告路径与期望 Codex 状态根都来自这次派发自己的 launchId；窗口内读不到就返回结构化失败，由调用方
   * 落成 blocker。窗口错过之后的补记走 `reconcileUnboundRoleSessions`——两条路径共用同一个签发与写入
   * 实现，因此补记的结论与派发时完全一致。
   */
  const recordRoleSession = async (input: {
    readonly session: LiveSession;
    readonly assembled: Extract<AdvanceInputAssembly, { readonly kind: 'ready' }>;
    readonly result: Extract<AdvanceExecutionResult, { readonly kind: 'progressed' }>;
    readonly dispatchStartedAt: string;
  }): Promise<{ readonly code: string; readonly message: string } | null> => {
    const { session, assembled, result } = input;
    const dispatch = assembled.input.roles[result.role];
    if (dispatch === undefined || result.dispatchId === null) {
      return { code: 'dispatch_identity_unreadable', message: 'Worker 启动后没有可核验的角色或 Orca Dispatch 身份' };
    }
    const listed = await assembled.input.backend.query({
      operation: 'worktree-list',
      repo: `path:${dispatch.taskEnvelope.workspace.canonicalWorktree}`,
      limit: 1_000,
    });
    if (listed.kind !== 'accepted') {
      return { code: listed.code, message: listed.message };
    }
    const worktrees = listed.value as WorktreeListResult;
    if (worktrees.truncated || worktrees.hostScope === null || worktrees.hostScope.omittedHostIds.length > 0) {
      return { code: 'worktree_scope_unverifiable', message: '派发后的 worktree 列举不完整' };
    }
    const worktree = worktrees.worktrees.find((entry) =>
      entry.comment === workPackageComment(result.workPackageId) && !entry.isMainWorktree,
    );
    if (worktree === undefined) {
      return { code: 'worktree_not_found', message: '派发后的隔离 worktree 不可读' };
    }
    const proven = await sessionBindingFromStartReport({
      reportPath: assembled.reportPath,
      harness: 'codex',
      role: result.role,
      workerTaskId: dispatch.taskEnvelope.workerTaskId,
      dispatchId: result.dispatchId as DispatchId,
      attemptId: dispatch.taskEnvelope.attemptId,
      workspace: worktree.path,
      expectedCodexHome: assembled.expectedCodexHome,
      dispatchStartedAt: input.dispatchStartedAt,
      waitMs: bindingWindowMs,
    });
    if (proven.kind === 'unbound') {
      return { code: 'planner_session_unbound', message: `Codex SessionStart 报告不可达或无法精确绑定（${proven.code}：${proven.message}）` };
    }
    return recordRoleSegment({
      session,
      segmentId: derivedKey('segment', [session.incarnation.coordinationScopeId, result.dispatchId, dispatch.taskEnvelope.attemptId]),
      workPackageId: result.workPackageId,
      role: result.role,
      workerTaskId: dispatch.taskEnvelope.workerTaskId,
      dispatchId: result.dispatchId as DispatchId,
      attemptId: dispatch.taskEnvelope.attemptId,
      binding: proven.binding,
    });
  };

  /**
   * 补记「已派发但未绑定」的角色会话（IP-04）。
   *
   * 派发路径只在报告窗口内建立绑定；窗口错过之后这条派发的 Delivery 会因缺少 Session Segment 而无法
   * 归因（IC-08）。这里在每次触发时按物化绑定记下的 launchId 再读一次报告：读得到且逐项校验通过就补记
   * Segment，读不到就什么都不做（保持 fail-closed：结算路径会以 `dispatch_record_missing` 呈现）。
   * 不派发新 Worker、不改 Attempt、不消耗预算。
   */
  const reconcileUnboundRoleSessions = async (session: LiveSession): Promise<void> => {
    const scopeId = session.incarnation.coordinationScopeId;
    const current = requireStore();
    const scope = scopeRecord(scopeId);
    if (current === null || scope === null || scope.graphId === null || scope.graphVersion === null) {
      return;
    }
    if (scope.controlState !== 'active') {
      return;
    }
    const graphRead = current.query({
      kind: 'graph-version',
      coordinationScopeId: scopeId,
      graphId: scope.graphId,
      graphVersion: scope.graphVersion,
    });
    const snapshotRead = current.query({ kind: 'snapshot', coordinationScopeId: scopeId });
    if (graphRead.kind !== 'graph-version' || graphRead.version === null || snapshotRead.kind !== 'snapshot') {
      return;
    }
    const graph = graphRead.version.graph;
    const nodes = graph.workPackages.map((workPackage) => ({
      workPackageId: workPackage.workPackageId,
      dependsOn: [...workPackage.dependsOn],
    }));
    const observations = await executionObservations(scope, nodes);
    if (!observations.workersEnumerated) {
      return;
    }
    const bindings = graph.workPackages.flatMap((workPackage) => {
      const read = current.query({
        kind: 'materialization-bindings',
        coordinationScopeId: scopeId,
        workPackageId: workPackage.workPackageId,
      });
      return read.kind === 'materialization-bindings' ? read.bindings : [];
    });
    const unbound = unboundRoleDispatches({
      graph,
      bindings,
      segments: snapshotRead.snapshot.sessionSegments,
      observations,
      segmentIdOf: (orcaDispatchId, attemptId) => derivedKey('segment', [scopeId, orcaDispatchId, attemptId]),
    });
    for (const entry of unbound) {
      const paths = codexSessionPaths(entry.launchId);
      if (paths === null) {
        continue;
      }
      const proven = await sessionBindingFromStartReport({
        reportPath: paths.reportPath,
        harness: 'codex',
        role: entry.role,
        workerTaskId: entry.workerTaskId,
        dispatchId: entry.orcaDispatchId,
        attemptId: entry.attemptId,
        workspace: entry.worktreePath,
        expectedCodexHome: join(paths.stateRoot, createHash('sha256').update(entry.launchId).digest('hex').slice(0, 20)),
        dispatchStartedAt: new Date(entry.createdAt).toISOString(),
        waitMs: 0,
      });
      if (proven.kind === 'unbound') {
        continue;
      }
      const failure = recordRoleSegment({
        session,
        segmentId: entry.segmentId,
        workPackageId: entry.workPackageId,
        role: entry.role,
        workerTaskId: entry.workerTaskId,
        dispatchId: entry.orcaDispatchId,
        attemptId: entry.attemptId,
        binding: proven.binding,
      });
      if (failure === null) {
        publish(session.coordinatorSessionId, {
          kind: 'state-changed',
          coordinationScopeId: scopeId,
          revision: scopeRecord(scopeId)?.revision ?? 0,
          reason: `session-binding-reconciled:${entry.segmentId}`,
        });
      }
    }
  };

  const advanceExecutionOnce = async (session: LiveSession): Promise<AdvanceExecutionResult> => {
    const scopeId = session.incarnation.coordinationScopeId;
    const assembled = await advanceInputFor(session);
    if (assembled.kind === 'idle') {
      clearExecutionBlocker(scopeId, 'advance');
      return { kind: 'idle', reason: assembled.reason, blockers: assembled.blockers };
    }
    if (assembled.kind === 'blocked') {
      recordExecutionBlocker(scopeId, 'advance', assembled.code, `执行推进停在事实层：${assembled.message}`);
      return { kind: 'blocked', laneKey: scopeId, code: assembled.code, message: assembled.message };
    }
    const dispatchStartedAt = new Date().toISOString();
    const result = await advanceExecution(assembled.input);
    if (result.kind === 'progressed') {
      const sessionFailure = await recordRoleSession({ session, assembled, result, dispatchStartedAt });
      if (sessionFailure !== null) {
        recordExecutionBlocker(scopeId, 'advance', sessionFailure.code, sessionFailure.message);
        return { kind: 'blocked', laneKey: scopeId, code: sessionFailure.code, message: sessionFailure.message };
      }
      clearExecutionBlocker(scopeId, 'advance');
      publish(session.coordinatorSessionId, {
        kind: 'state-changed',
        coordinationScopeId: scopeId,
        revision: scopeRecord(scopeId)?.revision ?? 0,
        reason: `execution-advanced:${result.workPackageId}:${result.role}`,
      });
      return result;
    }
    if (result.kind === 'blocked') {
      recordExecutionBlocker(scopeId, 'advance', result.code, `${result.laneKey} 上的 lane 保持阻塞：${result.message}`);
    }
    if (result.kind === 'idle') {
      // 空闲也必须可观察：Scope 处于执行模式、授权与 Run 齐备时，「什么都没有发生」本身就是需要
      // 看见的事实——否则界面上只剩一片静止，谁也不知道是等 Worker、等依赖还是被门禁挡住。
      recordExecutionBlocker(
        scopeId,
        'advance',
        result.blockers.length > 0 ? result.blockers[0]! : 'advance_idle',
        result.reason,
      );
    }
    if (result.kind === 'unknown') {
      recordExecutionBlocker(
        scopeId,
        'advance',
        'dispatch_unknown',
        `${result.operationId} 的结果未知：${result.reason}；重启后只按该 OperationId 对账`,
      );
    }
    return result;
  };

  /**
   * 模型可申请的执行态工具。
   *
   * 事实在每次组装时重新读取（可见性只由模式决定，准入在每次调用里重验）；这里不缓存工具集，因此
   * 重启后注册表总能从同一份事实重建。
   */
  const executionFactsFor = (coordinatorSessionId: CoordinatorSessionId): ExecutionToolFacts | null => {
    const current = requireStore();
    const scopeId = selectedScopeId;
    if (current === null || scopeId === null) {
      return null;
    }
    const scope = scopeRecord(scopeId);
    if (scope === null) {
      return null;
    }
    const snapshot = current.query({ kind: 'snapshot', coordinationScopeId: scopeId });
    if (snapshot.kind !== 'snapshot') {
      return null;
    }
    const graphId = scope.graphId;
    const version =
      graphId === null || scope.graphVersion === null
        ? null
        : current.query({
            kind: 'graph-version',
            coordinationScopeId: scopeId,
            graphId,
            graphVersion: scope.graphVersion,
          });
    const graph = version !== null && version.kind === 'graph-version' ? version.version?.graph ?? null : null;
    // 工具可见的推进上界：还没有被验证接受的 Work Package 至多再消耗一次推进。它不是新预算，真正的
    // 准入由执行驱动的每次判定给出。
    const pending = graph === null ? [] : graph.workPackages.filter((workPackage) => {
      const bindings = snapshot.snapshot.materializationBindings.filter(
        (entry) => entry.workPackageId === workPackage.workPackageId && entry.role === 'validator',
      );
      return !snapshot.snapshot.deliverySettlements.some(
        (settlement) =>
          settlement.role === 'validator' && bindings.some((binding) => binding.workerTaskId === settlement.workerTaskId),
      );
    });
    return {
      mode: scope.mode,
      controlState: scope.controlState,
      coordinationScopeId: scopeId,
      coordinatorSessionId,
      scopeRevision: scope.revision,
      planningResponsible: planningFacts(coordinatorSessionId)?.activation.kind === 'active',
      authorization: {
        authorizationId: scope.authorizationId,
        authorizationVersion: scope.authorizationVersion,
      },
      executionLeaseHeld: holdsExecutionLease(scopeId, coordinatorSessionId),
      permissions: {
        // 执行写入权限来自项目配置与 Manifest：配置里的角色权限是长期策略，Manifest 是这一次的授权。
        allowExecutionWrites: config !== null && config.execution.permissions.implementation,
      },
      budget: { remainingMutations: pending.length },
    };
  };

  const executionServicesFor = (coordinatorSessionId: CoordinatorSessionId): ExecutionToolServices | null => {
    if (selectedScopeId === null) {
      return null;
    }
    const sessionOf = (): LiveSession | null => {
      const session = liveSessions.get(coordinatorSessionId);
      return session === undefined || session.fencingLost ? null : session;
    };
    return {
      readFacts: () => {
        const facts = executionFactsFor(coordinatorSessionId);
        if (facts === null) {
          throw new Error('无法读取当前执行事实');
        }
        return facts;
      },
      readExecutionStatus: async (): Promise<ExecutionToolOutcome> => {
        const scopeId = selectedScopeId;
        const current = requireStore();
        if (scopeId === null || current === null) {
          return { kind: 'rejected', code: 'scope_unavailable', message: '当前没有可用的 Coordination Scope' };
        }
        const scope = scopeRecord(scopeId);
        if (scope === null) {
          return { kind: 'rejected', code: 'scope_unavailable', message: `无法读取 Scope ${scopeId}` };
        }
        const snapshot = current.query({ kind: 'snapshot', coordinationScopeId: scopeId });
        if (snapshot.kind !== 'snapshot') {
          return { kind: 'rejected', code: 'invalid_state', message: '无法读取协调快照' };
        }
        const graphId = scope.graphId;
        const version =
          graphId === null || scope.graphVersion === null
            ? null
            : current.query({
                kind: 'graph-version',
                coordinationScopeId: scopeId,
                graphId,
                graphVersion: scope.graphVersion,
              });
        const graph = version !== null && version.kind === 'graph-version' ? version.version?.graph ?? null : null;
        if (graph === null) {
          return {
            kind: 'ok',
            value: { graphGeneration: null, frontier: [], blockers: executionBlockersFor(scopeId) },
          };
        }
        const nodes = graph.workPackages.map((workPackage) => ({
          workPackageId: workPackage.workPackageId,
          dependsOn: [...workPackage.dependsOn],
        }));
        const observations = await executionObservations(scope, nodes);
        const derived = executionDerivation({
          snapshot: snapshot.snapshot,
          scope,
          observations,
          nodes,
          baselineHead: graphGenerationOf(scope)?.baselineHead ?? null,
          authority: null,
          recoveryBudgetLimit: null,
        });
        return {
          kind: 'ok',
          value: {
            graphGeneration: graph.generation,
            frontier: derived.execution.frontier.map((entry) => ({
              workPackageId: entry.workPackageId,
              state: entry.state,
              role: entry.role,
              liveness: entry.liveness,
              nextRole: nextAdvanceRole(entry),
            })),
            blockers: executionBlockersFor(scopeId),
          },
        };
      },
      advanceExecution: async ({ operationId }) => {
        void operationId;
        const session = sessionOf();
        if (session === null) {
          return { kind: 'rejected', code: 'session_unavailable', message: '该 Session 不在本进程中运行' };
        }
        return executionOutcomeOf(await advanceExecutionOnce(session));
      },
      proposeExecutionGraph: async ({ plan }) => {
        // 编译入口是宿主已有的受控命令：模型只能提出计划正文，图身份与 Run 由宿主补齐。
        const result = await proposeGraph(plan);
        switch (result.kind) {
          case 'accepted':
            return { kind: 'ok', value: { summary: result.summary, revision: result.revision } };
          case 'unknown':
            return { kind: 'unknown', reason: `${result.code}：${result.message}` };
          default:
            return { kind: 'rejected', code: result.code, message: result.message };
        }
      },
    };
  };

  const executionToolsFor = (
    coordinatorSessionId: CoordinatorSessionId,
  ): readonly PlanningToolDefinition[] => {
    const facts = executionFactsFor(coordinatorSessionId);
    const services = executionServicesFor(coordinatorSessionId);
    return facts === null || services === null
      ? []
      : executionToolsForMode({ mode: facts.mode, facts, services });
  };

  const executionBlockersFor = (scopeId: string): readonly ControllerBlockerEntry[] => [
    ...(executionBlockers.get(scopeId)?.values() ?? []),
  ];

  /**
   * Worker 存活三值变化的事件源（IP-07）。
   *
   * 只在**已经列举**执行主机时比较：未列举时的 `unverifiable` 是「读不到」，每个触发点都会重复出现，
   * 把它发布成事件只会产生噪声。同一个 Dispatch 的同一取值只发布一次。
   */
  const observedLiveness = new Map<string, string>();
  const publishLivenessChanges = (scopeId: string, workers: readonly WorkerEntryView[]): void => {
    for (const worker of workers) {
      if (worker.liveness === null || worker.liveness === 'unverifiable') {
        continue;
      }
      const key = `${scopeId}:${worker.dispatchId}`;
      if (observedLiveness.get(key) === worker.liveness) {
        continue;
      }
      observedLiveness.set(key, worker.liveness);
      publish(null, {
        kind: 'worker-liveness-changed',
        coordinationScopeId: scopeId,
        dispatchId: worker.dispatchId,
        liveness: worker.liveness,
      });
    }
  };

  /* ------------------------------------------------------------------------ */
  /* 集成（IP-06）与项目级 Finalizer                                          */
  //
  // 集成只在 Validator 已接受、且本 Session 仍是 Execution Coordination Lease 持有者时进行；一次触发
  // 最多集成一个 Work Package，`unknown` 保持 lane 阻塞、不换 ID 重试、不继续下一个包。
  /* ------------------------------------------------------------------------ */

  /** Git 集成端口：按需创建并缓存；canonical worktree 在本进程内不变。 */
  let integrationPort: GitIntegrationPort | null = null;
  const integrationPortFor = (): GitIntegrationPort | null => {
    if (integrationPort !== null) {
      return integrationPort;
    }
    if (canonicalWorktreePath === null) {
      return null;
    }
    integrationPort = createGitIntegrationPort({ canonicalWorktreePath });
    return integrationPort;
  };

  /**
   * 一个 Work Package 的三个已确立事实。
   *
   * 与 `execution-view.ts` 的投影同源同规则（那个函数不导出）：结算按角色取最新一条，归属经物化绑定
   * 的 Orca Task 身份对齐。这里只回答「能不能集成」，因此不派生生命周期阶段。
   */
  const establishedStatusOf = (
    snapshot: CoordinationSnapshot,
    workPackageId: WorkPackageId,
  ): WorkPackageStatus => {
    let status = initialWorkPackageStatus(workPackageId);
    const bindings = snapshot.materializationBindings.filter((entry) => entry.workPackageId === workPackageId);
    if (bindings.length === 0) {
      return status;
    }
    const latestOf = (role: WorkerRole) =>
      snapshot.deliverySettlements
        .filter((settlement) => settlement.role === role && bindings.some((binding) =>
          binding.role === role && binding.workerTaskId === settlement.workerTaskId,
        ))
        .reduce<CoordinationSnapshot['deliverySettlements'][number] | null>(
          (latest, candidate) => (latest === null || candidate.acceptedAt >= latest.acceptedAt ? candidate : latest),
          null,
        );
    const implementation = latestOf('implementation');
    if (implementation !== null) {
      status = withImplementationStatus(status, {
        kind: 'implemented',
        attemptId: implementation.attemptId,
        acceptedResultRef: implementation.orcaResultRef,
      });
    }
    const validation = latestOf('validator');
    if (validation !== null) {
      status = withValidationStatus(status, {
        kind: 'validated',
        validationAttemptId: validation.attemptId,
        acceptedResultRef: validation.orcaResultRef,
      });
    }
    return status;
  };

  /** 该 Work Package 是否已经有已接受的 Git Integration Operation；判定只看已收尾的意图记录。 */
  const integrationCompletedFor = (scopeId: CoordinationScopeId, workPackageId: WorkPackageId): boolean => {
    const current = requireStore();
    if (current === null) {
      return false;
    }
    const intent = current.query({
      kind: 'intents',
      coordinationScopeId: scopeId,
    });
    return (
      intent.kind === 'intents' &&
      intent.intents.some(
        (record) =>
          record.operationCategory === 'git-integration' &&
          record.target.kind === 'work-package' &&
          record.target.id === workPackageId &&
          record.state === 'settled' &&
          record.outcomeClass === 'accepted',
      )
    );
  };

  /** 集成步骤的稳定 OperationId：同一 Work Package 在同一世代里只集成一次（D9）。 */
  const integrationOperationIdsFor = (input: {
    readonly scopeId: CoordinationScopeId;
    readonly graphId: string;
    readonly generation: number;
    readonly workPackageId: WorkPackageId;
  }): { readonly commit: OperationId; readonly integrate: OperationId; readonly push: OperationId } => {
    const segments = [input.scopeId, input.graphId, String(input.generation), input.workPackageId];
    return {
      commit: derivedKey('git-integration-commit', segments) as OperationId,
      integrate: derivedKey('git-integration-integrate', segments) as OperationId,
      push: derivedKey('git-integration-push', segments) as OperationId,
    };
  };

  /**
   * 集成一个 Validator 已接受的 Work Package。
   *
   * 事实按固定顺序读取：模式与租约 → 图与授权 → 观察（精确 worktree）→ 验证事实 → Git Policy。
   * 任一不可读或不可归属都停在 blocker，不做部分集成，也不以界面状态代替判定。
   */
  const integrateAcceptedWorkPackage = async (session: LiveSession): Promise<void> => {
    const scopeId = session.incarnation.coordinationScopeId;
    const current = requireStore();
    if (current === null) {
      return;
    }
    const scope = scopeRecord(scopeId);
    if (scope === null || scope.mode !== 'execution_coordination' || scope.controlState !== 'active') {
      return;
    }
    if (!holdsExecutionLease(scopeId, session.coordinatorSessionId)) {
      return;
    }
    if (scope.graphId === null || scope.graphVersion === null) {
      return;
    }
    const graphRead = current.query({
      kind: 'graph-version',
      coordinationScopeId: scopeId,
      graphId: scope.graphId,
      graphVersion: scope.graphVersion,
    });
    if (graphRead.kind !== 'graph-version' || graphRead.version === null) {
      return;
    }
    const graph = graphRead.version.graph;
    const authorizationRead = activeAuthorization(current, scopeId);
    if (authorizationRead.kind === 'rejected' || authorizationRead.authorization === null) {
      return;
    }
    const manifest = authorizationRead.authorization.manifest;
    if (canonicalWorktreePath === null || commonDirPath === null) {
      return;
    }
    const snapshotRead = current.query({ kind: 'snapshot', coordinationScopeId: scopeId });
    if (snapshotRead.kind !== 'snapshot') {
      return;
    }
    const snapshot = snapshotRead.snapshot;
    const candidate = graph.workPackages.find(
      (workPackage) =>
        establishedStatusOf(snapshot, workPackage.workPackageId).validation.kind === 'validated' &&
        !integrationCompletedFor(scopeId, workPackage.workPackageId),
    );
    if (candidate === undefined) {
      return;
    }
    const backend = backendForExecution();
    const port = integrationPortFor();
    if (backend === null || port === null) {
      recordExecutionBlocker(scopeId, 'integration', 'backend_unavailable', '无法建立 Orca ExecutionBackend 或受控 Git 端口');
      return;
    }
    const identity = await readCoordinatorIdentityRef();
    const generation = graphGenerationOf(scope);
    if (identity === null || generation === null) {
      return;
    }
    const nodes = graph.workPackages.map((workPackage) => ({
      workPackageId: workPackage.workPackageId,
      dependsOn: [...workPackage.dependsOn],
    }));
    const observations = await executionObservations(scope, nodes);
    const worktreePath = observations.worktreePaths.get(candidate.workPackageId);
    if (worktreePath === undefined) {
      recordExecutionBlocker(
        scopeId,
        'integration',
        'worktree_unresolved',
        `Work Package ${candidate.workPackageId} 没有可定位的隔离 worktree：无法核验提交来源`,
      );
      return;
    }
    const run = await readScopeRunScope({ scope, generation, backend, identity });
    if (run.kind === 'no-run') {
      return;
    }
    if (run.kind === 'unreadable') {
      recordExecutionBlocker(scopeId, 'integration', run.code, run.message);
      return;
    }
    // 唯一的获批 remote/ref：Manifest 列出多个时本进程不能替用户挑一个，因此停在 blocker。
    const approvedRemote = manifest.gitPolicy.remotes[0];
    const approvedRef = manifest.gitPolicy.refs[0];
    if (
      manifest.gitPolicy.remotes.length !== 1 ||
      manifest.gitPolicy.refs.length !== 1 ||
      approvedRemote === undefined ||
      approvedRef === undefined
    ) {
      recordExecutionBlocker(
        scopeId,
        'integration',
        'git_target_unapproved',
        'Manifest 没有恰好一个获批 remote 与一个获批 ref：集成目标只能来自用户批准的范围',
      );
      return;
    }
    // 源分支必须来自该 Work Package 的隔离 worktree：canonical 分支不是源，用它合并等于自我合并。
    const worktreeListing = await backend.query({
      operation: 'worktree-list',
      repo: `path:${canonicalWorktreePath}`,
      limit: 1_000,
    });
    if (worktreeListing.kind !== 'accepted') {
      recordExecutionBlocker(
        scopeId,
        'integration',
        'integration_source_unreadable',
        `无法列举 worktree 以定位集成源分支：${worktreeListing.code} ${worktreeListing.message}`,
      );
      return;
    }
    const sourceBranch = integrationSourceBranchOf(
      (worktreeListing.value as WorktreeListResult).worktrees,
      candidate.workPackageId,
    );
    if (sourceBranch === null) {
      recordExecutionBlocker(
        scopeId,
        'integration',
        'integration_source_unreadable',
        `Work Package ${candidate.workPackageId} 的隔离 worktree 没有可读分支：集成源无从核验`,
      );
      return;
    }
    const result = await integrateWorkPackage({
      port,
      store: current,
      coordinationScopeId: scopeId,
      writer: writerFor(session.incarnation),
      expectedRevision: scope.revision,
      backendIdentityRef: identity,
      graphGeneration: graph.generation,
      authorizationId: authorizationRead.authorization.authorizationId,
      runId: run.runId,
      consumerGeneration: run.consumerGeneration,
      timeoutMs: MUTATION_TIMEOUT_MS,
      workPackageId: candidate.workPackageId,
      status: establishedStatusOf(snapshot, candidate.workPackageId),
      executionLeaseHeldByCurrentSession: true,
      authority: manifest.permissions,
      policy: manifest.gitPolicy,
      request: {
        kind: 'integrate_canonical',
        remote: approvedRemote,
        ref: approvedRef,
        branch: manifest.gitPolicy.canonicalBranch,
        sourceBranch,
      },
      workspace: {
        canonicalWorktreePath,
        workPackageWorktreePath: worktreePath,
      },
      baselineHead: manifest.baselineHead,
      commitMessage: `${candidate.workPackageId}: ${candidate.title}`,
      operationIds: integrationOperationIdsFor({
        scopeId,
        graphId: graph.graphId,
        generation: graph.generation,
        workPackageId: candidate.workPackageId,
      }),
    });
    if (result.kind === 'integrated') {
      clearExecutionBlocker(scopeId, 'integration');
      publish(session.coordinatorSessionId, {
        kind: 'state-changed',
        coordinationScopeId: scopeId,
        revision: scopeRecord(scopeId)?.revision ?? 0,
        reason: `integration:${candidate.workPackageId}`,
      });
      return;
    }
    if (result.kind === 'unknown') {
      recordExecutionBlocker(
        scopeId,
        'integration',
        'integration_unknown',
        `${result.operationId} 的结果未知（${result.reason}）：lane 保持阻塞，重启后只按原 OperationId 对账`,
      );
      return;
    }
    const message = result.kind === 'rejected' ? `${result.failure.code}: ${result.failure.message}` : result.reason;
    recordExecutionBlocker(scopeId, 'integration', result.kind === 'rejected' ? result.failure.code : 'lane_blocked', message);
  };

  /* ------------------------------------------------------------------------ */
  /* 项目级 Finalizer                                                          */
  /* ------------------------------------------------------------------------ */

  /** Codex 状态根与 SessionStart 报告的 Companion 私有位置：绝不写进被只读检查的 canonical 工作区。 */
  const finalizerCompanionPaths = (): {
    readonly stateRoot: string;
    readonly reporterPath: string;
    readonly reportPath: string;
  } | null => {
    if (commonDirPath === null) {
      return null;
    }
    const stateRoot = join(commonDirPath, COMPANION_STATE_DIRECTORY, 'codex');
    return {
      stateRoot,
      reporterPath: join(stateRoot, 'session-start-reporter.mjs'),
      reportPath: join(stateRoot, 'session-start.jsonl'),
    };
  };

  /** 每次角色派发自己的报告文件，避免旧 SessionStart 行冒充本次启动。 */
  const codexSessionPaths = (launchId: string): {
    readonly stateRoot: string;
    readonly reporterPath: string;
    readonly reportPath: string;
  } | null => (commonDirPath === null ? null : codexSessionPathsUnder(join(commonDirPath, COMPANION_STATE_DIRECTORY), launchId));

  /** 本进程读到的 Finalizer 派发事实；重启后不存在，因此重启期间无法证明只读（见下）。 */
  type FinalizerRun = {
    readonly workerTaskId: WorkerTaskId;
    readonly dispatchId: string;
    readonly attemptId: string;
    readonly sessionBindingId: string;
    readonly before: FinalizerWorkspaceFacts;
  };
  const finalizerRuns = new Map<string, FinalizerRun>();

  /** 项目级 Finalizer 的稳定身份：同一 Scope 的同一世代只派发一个 Finalizer。 */
  const finalizerOperationIdsFor = (input: {
    readonly scopeId: CoordinationScopeId;
    readonly graphId: string;
    readonly generation: number;
  }): {
    readonly task: OperationId;
    readonly workerPrepare: OperationId;
    readonly workerStart: OperationId;
    readonly workerActivate: OperationId;
    readonly workerTaskId: WorkerTaskId;
    readonly dispatchId: DispatchId;
    readonly attemptId: string;
    readonly launchId: string;
  } => {
    const segments = [input.scopeId, input.graphId, String(input.generation), 'project-level-finalizer'];
    return {
      task: derivedKey('finalizer-task', segments) as OperationId,
      workerPrepare: derivedKey('finalizer-terminal', segments) as OperationId,
      workerStart: derivedKey('finalizer-worker-start', segments) as OperationId,
      workerActivate: derivedKey('finalizer-worker-activate', segments) as OperationId,
      workerTaskId: derivedKey('worker-task', segments) as WorkerTaskId,
      dispatchId: derivedKey('dispatch', segments) as DispatchId,
      attemptId: derivedKey('attempt', segments),
      launchId: derivedKey('worker-launch', segments),
    };
  };

  /**
   * 项目级收尾：门禁 → 运行前工作区事实 → 新的只读 Codex Session → 运行后工作区事实 → 独立 verdict。
   *
   * 三条不可让步的边界：
   * - 门禁未通过（任一 Work Package 未验证接受、有未决交互、有未结算 mutation、未授权 finalizer）或
   *   仍有 Work Package 尚未完成集成时，既不派发也不呈现 deliverable；
   * - 只读无法证明（Session Binding 读不回、或该派发发生在本进程之前的 Incarnation）时只报 blocker，
   *   绝不谎称只读；
   * - 运行前后 canonical 工作区发生变化时不接受任何 verdict，交付保持 blocker。
   */
  const runFinalizerForScope = async (session: LiveSession): Promise<void> => {
    const scopeId = session.incarnation.coordinationScopeId;
    const current = requireStore();
    if (current === null) {
      return;
    }
    const scope = scopeRecord(scopeId);
    if (scope === null || scope.mode !== 'execution_coordination' || scope.controlState !== 'active') {
      return;
    }
    if (!holdsExecutionLease(scopeId, session.coordinatorSessionId)) {
      return;
    }
    if (scope.graphId === null || scope.graphVersion === null) {
      return;
    }
    if (config === null || config.execution.harness !== 'codex' || config.execution.workerModel === null) {
      return;
    }
    const paths = finalizerCompanionPaths();
    if (paths === null || canonicalWorktreePath === null) {
      return;
    }
    const graphRead = current.query({
      kind: 'graph-version',
      coordinationScopeId: scopeId,
      graphId: scope.graphId,
      graphVersion: scope.graphVersion,
    });
    if (graphRead.kind !== 'graph-version' || graphRead.version === null) {
      return;
    }
    const graph = graphRead.version.graph;
    const authorizationRead = activeAuthorization(current, scopeId);
    if (authorizationRead.kind === 'rejected' || authorizationRead.authorization === null) {
      return;
    }
    const manifest = authorizationRead.authorization.manifest;
    const snapshotRead = current.query({ kind: 'snapshot', coordinationScopeId: scopeId });
    if (snapshotRead.kind !== 'snapshot') {
      return;
    }
    const snapshot = snapshotRead.snapshot;
    const statuses = graph.workPackages.map((workPackage) =>
      establishedStatusOf(snapshot, workPackage.workPackageId),
    );
    const gate: FinalizerGateFacts = {
      workPackageStatuses: statuses,
      pendingInteractionCount: snapshot.pendingInteractions.filter(
        (interaction) => interaction.state === 'open',
      ).length,
      unresolvedMutationCount: snapshot.unresolvedIntents.length,
      authority: manifest.permissions,
    };
    const dispatch = planFinalizerDispatch(gate);
    if (dispatch.kind === 'not_ready') {
      return;
    }
    // 集成完成是 Finalizer 的前置事实：只认已收尾且被接受的 Git Integration Operation。
    const unintegrated = graph.workPackages.filter(
      (workPackage) => !integrationCompletedFor(scopeId, workPackage.workPackageId),
    );
    if (unintegrated.length > 0) {
      return;
    }
    const identity = await readCoordinatorIdentityRef();
    const generation = graphGenerationOf(scope);
    const backend = backendForExecution();
    if (identity === null || generation === null || backend === null) {
      return;
    }
    const run = await readScopeRunScope({ scope, generation, backend, identity });
    if (run.kind !== 'read') {
      return;
    }
    const operationIds = finalizerOperationIdsFor({
      scopeId,
      graphId: graph.graphId,
      generation: graph.generation,
    });
    const existing = finalizerRuns.get(scopeId);
    const before = await readWorkspaceFacts({ worktreePath: canonicalWorktreePath, env: options.env });
    if (before.kind !== 'observed') {
      recordExecutionBlocker(
        scopeId,
        'finalizer',
        'finalizer_workspace_unreadable',
        `无法读取 canonical 工作区的运行前事实：${before.reason}`,
      );
      return;
    }
    if (existing === undefined) {
      // 本进程没有这次派发的记录：可能是上一个 Incarnation 派发的。settled intent 是它的证据，
      // 但只读约束只有本进程构造的启动策略能证明，因此这里只报 blocker，不伪称只读。
      const prior = current.query({ kind: 'intent', coordinationScopeId: scopeId, operationId: operationIds.task });
      if (prior.kind === 'intent' && prior.intent !== null) {
        recordExecutionBlocker(
          scopeId,
        'finalizer',
          'finalizer_read_only_unprovable',
          '该 Finalizer 派发发生在本进程之前：没有可核验的只读 Session 证明，交付保持 blocker',
        );
        return;
      }
    installCodexSessionStartReporter(paths);
      const dispatchStartedAt = new Date().toISOString();
      const dispatched = await dispatchScopedWorker({
        store: current,
        backend,
        writer: writerFor(session.incarnation),
        coordinationScopeId: scopeId,
        workPackageId: scopeId,
        spec: JSON.stringify({
          schemaVersion: TASK_ENVELOPE_SCHEMA_VERSION,
          // 项目级任务的稳定身份：结论读回时按它配对，不用 Finalizer 自报的身份。
          workerTaskId: operationIds.workerTaskId,
          dispatchId: operationIds.dispatchId,
          attemptId: operationIds.attemptId,
          role: 'finalizer',
          taskKind: 'project-delivery-verdict',
          readOnly: true,
          coversWorkPackageIds: [...dispatch.plan.coversWorkPackageIds],
          expectedWorkPackageIds: statuses.map((status) => status.workPackageId),
          // 运行前的工作区事实是这次 Finalizer 检查的固定输入：Worker 只能核对，不能改写。
          workspaceBefore: before.facts,
        }),
        execution: {
          backendIdentityRef: identity,
          graphGeneration: graph.generation,
          authorizationId: authorizationRead.authorization.authorizationId,
          runId: run.runId,
          consumerGeneration: run.consumerGeneration,
          timeoutMs: MUTATION_TIMEOUT_MS,
        },
        workerLaunch: createCodexWorkerLaunch({
          launchId: operationIds.launchId,
          model: config.execution.workerModel,
          // Finalizer 仍是只读（profile 继承 `:read-only`），但需要本机控制通道回报结论，且本机无法
          // 建立 bwrap 会话：用既有的 `read-only-local-control`（landlock 后端 + 控制通道网络）。
          sandboxMode: 'read-only-local-control',
          stateRoot: paths.stateRoot,
          sessionStartReporterPath: paths.reporterPath,
        }),
        worktree: `path:${canonicalWorktreePath}`,
        taskTitle: '项目级交付结论（只读 Finalizer）',
        operationIds: {
          task: operationIds.task,
          workerPrepare: operationIds.workerPrepare,
          workerStart: operationIds.workerStart,
          workerActivate: operationIds.workerActivate,
        },
        observeSession: async (dispatchId): Promise<HarnessSessionFacts | null> => {
          // SessionStart 由 Codex 进程在启动时写出；给一个短窗口再读，读不到就是读不到。
          const deadline = Date.now() + bindingWindowMs;
          while (Date.now() < deadline) {
            if (existsSync(paths.reportPath)) {
              const line = readFileSync(paths.reportPath, 'utf8').split('\n').find((entry) => entry.length > 0);
              if (line !== undefined) {
                let report: CodexSessionStartReport;
                try {
                  report = JSON.parse(line) as CodexSessionStartReport;
                } catch {
                  return null;
                }
                const bound = bindCodexSessionFromStartReport({
                  facts: {
                    harness: 'codex',
                    role: 'finalizer',
                    workerTaskId: operationIds.workerTaskId,
                    dispatchId: dispatchId as DispatchId,
                    attemptId: operationIds.attemptId,
                  },
                  report,
                  workspace: canonicalWorktreePath,
                  expectedCodexHome: join(paths.stateRoot, createHash('sha256').update(operationIds.launchId).digest('hex').slice(0, 20)),
                  dispatchStartedAt,
                  bindingDeadlineAt: new Date().toISOString(),
                });
                return bound.kind === 'bound'
                  ? {
                      harness: bound.binding.harness,
                      role: bound.binding.role,
                      workerTaskId: bound.binding.workerTaskId,
                      dispatchId: bound.binding.dispatchId,
                      attemptId: bound.binding.attemptId,
                      providerSessionId: bound.binding.providerSessionId,
                      transcriptRef: bound.binding.transcriptRef,
                      observedAt: bound.binding.observedAt,
                    }
                  : null;
              }
            }
            const { promise, resolve } = Promise.withResolvers<void>();
            setTimeout(resolve, 250);
            await promise;
          }
          return null;
        },
      });
      if (dispatched.kind === 'dispatched') {
        finalizerRuns.set(scopeId, {
          workerTaskId: operationIds.workerTaskId,
          dispatchId: dispatched.dispatchId,
          attemptId: operationIds.attemptId,
          sessionBindingId: dispatched.binding.providerSessionId,
          before: before.facts,
        });
        clearExecutionBlocker(scopeId, 'finalizer');
        publish(session.coordinatorSessionId, {
          kind: 'state-changed',
          coordinationScopeId: scopeId,
          revision: scopeRecord(scopeId)?.revision ?? 0,
          reason: 'finalizer-dispatched',
        });
        return;
      }
      const detail =
        dispatched.kind === 'unknown'
          ? `${dispatched.operationId} 的结果未知：${dispatched.reason}`
          : dispatched.kind === 'binding_unavailable'
            ? `无法证明新的只读 Session：${dispatched.code} ${dispatched.message}`
            : dispatched.kind === 'blocked'
              ? `${dispatched.laneKey} 上的 lane 保持阻塞：${dispatched.reason}`
              : `${dispatched.code}：${dispatched.message}`;
      recordExecutionBlocker(
        scopeId,
        'finalizer',
        dispatched.kind === 'binding_unavailable' ? 'finalizer_read_only_unverifiable' : `finalizer_${dispatched.kind}`,
        detail,
      );
      return;
    }
    // 完成路径：读回 Finalizer 的结论，再读运行后工作区并比较。
    const report = await readFinalizerReport({
      backend,
      backendIdentityRef: identity,
      runId: run.runId,
      workerTaskId: existing.workerTaskId,
    });
    if (report.kind === 'pending') {
      return;
    }
    if (report.kind === 'blocked') {
      recordExecutionBlocker(scopeId, 'finalizer', report.code, report.message);
      return;
    }
    const after = await readWorkspaceFacts({ worktreePath: canonicalWorktreePath, env: options.env });
    if (after.kind !== 'observed') {
      recordExecutionBlocker(
        scopeId,
        'finalizer',
        'finalizer_workspace_unreadable',
        `无法读取 canonical 工作区的运行后事实：${after.reason}`,
      );
      return;
    }
    const workspaceChanged =
      workspaceBeforeAfterChanged(existing.before, after.facts);
    if (workspaceChanged) {
      setFinalizerObservation(scopeId, {
        readOnlyProfile: 'enforced',
        integrationFrozen: 'frozen',
        worktreePath: canonicalWorktreePath,
        workspace: { before: existing.before, after: after.facts },
        evidenceRefs: [],
      });
      recordExecutionBlocker(
        scopeId,
        'finalizer',
        'finalizer_workspace_changed',
        'Finalizer 运行期间 canonical 工作区发生了变化：不接受交付结论，交付保持 blocker',
      );
      return;
    }
    // 写结论前的权威事实重读：门禁与 CAS 基准都取这一份，不用更早读到的快照。
    const freshRead = current.query({ kind: 'scope', coordinationScopeId: scopeId });
    const freshSnapshotRead = current.query({ kind: 'snapshot', coordinationScopeId: scopeId });
    if (freshRead.kind !== 'scope' || freshRead.scope === null || freshSnapshotRead.kind !== 'snapshot') {
      recordExecutionBlocker(scopeId, 'finalizer', 'invalid_state', '无法重读 Scope 事实：交付结论无从核验');
      return;
    }
    const freshGate: FinalizerGateFacts = {
      workPackageStatuses: graph.workPackages.map((workPackage) =>
        establishedStatusOf(freshSnapshotRead.snapshot, workPackage.workPackageId),
      ),
      pendingInteractionCount: freshSnapshotRead.snapshot.pendingInteractions.filter(
        (interaction) => interaction.state === 'open',
      ).length,
      unresolvedMutationCount: freshSnapshotRead.snapshot.unresolvedIntents.length,
      authority: manifest.permissions,
    };
    const fresh = { scope: freshRead.scope };
    const result = finalizeProject({
      store: current,
      coordinationScopeId: scopeId,
      writer: writerFor(session.incarnation),
      // 写结论前重读一次：从本函数开头到现在，同一个进程的其它命令（例如用户消息）可能已经推进了
      // revision，CAS 基准必须是刚读到的那个，而不是更早读到的值。
      expectedRevision: fresh.scope.revision,
      gate: freshGate,
      report: {
        role: 'finalizer',
        session: { kind: 'new_read_only', sessionBindingId: existing.sessionBindingId },
        readOnly: true,
        coveredWorkPackageIds: report.coveredWorkPackageIds as readonly WorkPackageId[],
        expectedWorkPackageIds: freshGate.workPackageStatuses.map((status) => status.workPackageId),
        verdict: report.verdict,
        authoritativeRefs: report.authoritativeRefs,
      },
      authoritativeRefs: report.authoritativeRefs,
      verdictId: derivedKey('delivery-verdict', [scopeId, graph.graphId, String(graph.generation)]),
    });
    setFinalizerObservation(scopeId, {
      readOnlyProfile: 'enforced',
      integrationFrozen: 'frozen',
      worktreePath: canonicalWorktreePath,
      workspace: { before: existing.before, after: after.facts },
      evidenceRefs: report.verdict.kind === 'deliverable' ? [...report.verdict.evidenceRefs] : [],
    });
    if (result.kind === 'accepted') {
      clearExecutionBlocker(scopeId, 'finalizer');
      publish(session.coordinatorSessionId, {
        kind: 'state-changed',
        coordinationScopeId: scopeId,
        revision: scopeRecord(scopeId)?.revision ?? 0,
        reason: `delivery-verdict:${result.record.verdictId}`,
      });
      return;
    }
    recordExecutionBlocker(
      scopeId,
        'finalizer',
      result.kind === 'not_ready' ? 'finalizer_not_ready' : result.code,
      result.kind === 'not_ready' ? result.blockers.join('；') : result.message,
    );
  };

  /** 运行前后工作区的唯一比较规则；调用方只提供两次读取的原始事实。 */
  const workspaceBeforeAfterChanged = (before: FinalizerWorkspaceFacts, after: FinalizerWorkspaceFacts): boolean => {
    if (before.head !== after.head || before.indexRevision !== after.indexRevision) {
      return true;
    }
    // 工具状态目录（Finalizer 自己的报告等）不算项目变化：只比较项目路径。
    const beforePaths = [...projectChangedPaths(before.dirtyPaths)].sort();
    const afterPaths = [...projectChangedPaths(after.dirtyPaths)].sort();
    return beforePaths.length !== afterPaths.length || beforePaths.some((path, index) => path !== afterPaths[index]);
  };

  /** 本进程读到并比较过的 Finalizer 观察；投影直接消费它，不再有第二份只读/工作区判定。 */
  const finalizerObservations = new Map<string, FinalizerObservationFacts>();
  const setFinalizerObservation = (scopeId: string, observation: FinalizerObservationFacts): void => {
    finalizerObservations.set(scopeId, observation);
  };

  /** 读回 Finalizer 的结论；读不到就是读不到，不用 Finalizer 自报以外的任何东西补位。 */
  const readFinalizerReport = async (input: {
    readonly backend: ExecutionBackend;
    readonly backendIdentityRef: string;
    readonly runId: string;
    readonly workerTaskId: WorkerTaskId;
  }): Promise<
    | { readonly kind: 'pending' }
    | { readonly kind: 'blocked'; readonly code: string; readonly message: string }
    | {
        readonly kind: 'read';
        readonly coveredWorkPackageIds: readonly string[];
        readonly verdict: DeliveryVerdict;
        readonly authoritativeRefs: readonly string[];
      }
  > => {
    const batch = await readDeliveryBatch(input.backend, {
      backendIdentityRef: input.backendIdentityRef,
      runId: input.runId,
      types: ['worker_done'],
      timeoutMs: MUTATION_TIMEOUT_MS,
    });
    if (batch.kind !== 'accepted') {
      return {
        kind: 'blocked',
        code: 'finalizer_report_unreadable',
        message: `无法读取 Finalizer 的 Delivery：${batch.code} ${batch.message}`,
      };
    }
    const message = batch.value.messages.find((entry) => {
      const parsed = parseDeliveryClaimedPayload(entry.payload);
      return parsed.kind === 'parsed' && parsed.payload.claimed.workerTaskId === input.workerTaskId;
    });
    if (message === undefined) {
      return { kind: 'pending' };
    }
    const parsed = parseDeliveryClaimedPayload(message.payload);
    if (parsed.kind === 'rejected') {
      return {
        kind: 'blocked',
        code: 'finalizer_report_unreadable',
        message: `Finalizer 的 Delivery 载荷无法解析：${parsed.code} ${parsed.message}`,
      };
    }
    const read = readFinalizerVerdict(parsed.payload.acceptedResult);
    if (read === null) {
      return {
        kind: 'blocked',
        code: 'finalizer_report_invalid',
        message: 'Finalizer 的结论结构不可读：缺少 verdict 或 coveredWorkPackageIds',
      };
    }
    const authoritativeRefs = authoritativeRefsForScope(input.runId);
    if (authoritativeRefs === null) {
      return {
        kind: 'blocked',
        code: 'authoritative_refs_unreadable',
        message: '无法读取既有权威结果引用：交付结论的证据无从核对',
      };
    }
    return {
      kind: 'read',
      coveredWorkPackageIds: read.coveredWorkPackageIds,
      verdict: read.verdict,
      authoritativeRefs,
    };
  };

  /**
   * Finalizer 结论的边界解析。
   *
   * 只接受登记的形状：`verdict` 与 `coveredWorkPackageIds` 缺一即返回 `null`，由调用方报 blocker，
   * 不补造结论、不把不可读读成可交付。
   */
  const readFinalizerVerdict = (
    raw: unknown,
  ): { readonly coveredWorkPackageIds: readonly string[]; readonly verdict: DeliveryVerdict } | null => {
    if (typeof raw !== 'object' || raw === null) {
      return null;
    }
    const record = raw as Record<string, unknown>;
    const covered = record['coveredWorkPackageIds'];
    if (!Array.isArray(covered) || covered.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
      return null;
    }
    const verdict = record['verdict'];
    if (typeof verdict !== 'object' || verdict === null) {
      return null;
    }
    const kind = (verdict as Record<string, unknown>)['kind'];
    const refs = (verdict as Record<string, unknown>)[kind === 'deliverable' ? 'evidenceRefs' : 'blockerRefs'];
    if ((kind !== 'deliverable' && kind !== 'blocked') || !Array.isArray(refs)) {
      return null;
    }
    const strings = refs.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
    if (strings.length !== refs.length) {
      return null;
    }
    return {
      coveredWorkPackageIds: covered as readonly string[],
      verdict: kind === 'deliverable' ? { kind: 'deliverable', evidenceRefs: strings } : { kind: 'blocked', blockerRefs: strings },
    };
  };

  /**
   * 既有权威结果的引用集合：已接受的 Worker Result 与已完成（已收尾且被接受）的 Integration Operation。
   *
   * Finalizer 的自报集合永远不参与这里，因此「自报一个不存在的证据」在结构上无法通过核对。
   */
  const authoritativeRefsForScope = (runId: string): readonly string[] | null => {
    const current = requireStore();
    const scopeId = selectedScopeId;
    if (current === null || scopeId === null) {
      return null;
    }
    const snapshot = current.query({ kind: 'snapshot', coordinationScopeId: scopeId });
    if (snapshot.kind !== 'snapshot') {
      return null;
    }
    const intents = current.query({ kind: 'intents', coordinationScopeId: scopeId });
    if (intents.kind !== 'intents') {
      return null;
    }
    void runId;
    return [
      ...snapshot.snapshot.deliverySettlements.map((settlement) => settlement.orcaResultRef),
      ...intents.intents
        .filter(
          (intent) =>
            intent.operationCategory === 'git-integration' &&
            intent.state === 'settled' &&
            intent.outcomeClass === 'accepted',
        )
        .map((intent) => intent.operationId),
    ];
  };

  /**
   * 已确认中断的 Worker Session → 一次 Recovery 续办（IP-04）。
   *
   * 触发条件严格：Orca 明确报告某个已派发 Dispatch 的 worker 已退出（`exited`），该角色同一次 Attempt
   * 没有任何已接受结果，且该 Segment 还没有登记过 Recovery。观察到 `unverifiable` 的 Worker 可能仍在
   * 运行，对它启动 Recovery 会引入重复派发风险，因此这里不触发——那种情形由「重启先对账」门呈现。
   *
   * 事实装配与 fail-closed 规则复用启动序列的唯一入口 `continueWorkerSessionRecovery`；本函数只负责
   * 「选哪条中断」与「把结论落成可观测事实」。
   */
  const recoverLostWorkerSession = async (session: LiveSession): Promise<boolean> => {
    const scopeId = session.incarnation.coordinationScopeId;
    const current = requireStore();
    const scope = scopeRecord(scopeId);
    if (current === null || scope === null || scope.mode !== 'execution_coordination') {
      return false;
    }
    if (!holdsExecutionLease(scopeId, session.coordinatorSessionId)) {
      return false;
    }
    // 控制状态优先：Pause / Cancel 期间不启动新的 Recovery。
    if (scope.controlState !== 'active') {
      return false;
    }
    if (scope.graphId === null || scope.graphVersion === null || scope.authorizationId === null) {
      return false;
    }
    const generation = graphGenerationOf(scope);
    const backend = backendForExecution();
    if (generation === null || backend === null || canonicalWorktreePath === null) {
      return false;
    }
    const identity = await readCoordinatorIdentityRef();
    if (identity === null) {
      return false;
    }
    const run = await readScopeRunScope({ scope, generation, backend, identity });
    if (run.kind !== 'read') {
      return false;
    }
    const graphRead = current.query({
      kind: 'graph-version',
      coordinationScopeId: scopeId,
      graphId: scope.graphId,
      graphVersion: scope.graphVersion,
    });
    const authorizationRead = activeAuthorization(current, scopeId);
    const snapshotRead = current.query({ kind: 'snapshot', coordinationScopeId: scopeId });
    if (
      graphRead.kind !== 'graph-version' ||
      graphRead.version === null ||
      authorizationRead.kind === 'rejected' ||
      authorizationRead.authorization === null ||
      snapshotRead.kind !== 'snapshot'
    ) {
      return false;
    }
    const graph = graphRead.version.graph;
    const snapshot = snapshotRead.snapshot;
    const nodes = graph.workPackages.map((workPackage) => ({
      workPackageId: workPackage.workPackageId,
      dependsOn: [...workPackage.dependsOn],
    }));
    const observations = await executionObservations(scope, nodes);
    if (!observations.workersEnumerated) {
      // 没有列举执行主机就没有「worker 已退出」这件事，绝不据此触发一次 Recovery。
      return false;
    }
    // 未确认的 Delivery 读不到时不能推断「这条会话没有结果」：那种情况下不启动 Recovery。
    const pendingRead = await startupDeliveriesFor({
      scope,
      generation,
      backend,
      identity,
      run,
    }).readPending();
    if (pendingRead.kind !== 'read') {
      return false;
    }
    const segment = interruptedSegmentOf({
      snapshot,
      observations,
      graph,
      pendingDeliveryDispatchIds: pendingRead.pending.flatMap((entry) =>
        entry.delivery.claimed.dispatchId === null ? [] : [entry.delivery.claimed.dispatchId],
      ),
    });
    if (segment === null) {
      return false;
    }
    const continuation = await continueWorkerSessionRecovery({
      store: current,
      backend,
      writer: writerFor(session.incarnation),
      coordinationScopeId: scopeId,
      subject: recoverySubjectOf(scopeId, segment),
      facts: createExecutionRecoveryFacts({
        store: () => {
          const store = requireStore();
          if (store === null) {
            throw new Error('Branch Coordination State 不可用：无法读取 Recovery 事实');
          }
          return store;
        },
        backend,
        coordinationScopeId: scopeId,
        canonicalWorktree: canonicalWorktreePath,
        execution: {
          backendIdentityRef: identity,
          graphGeneration: graph.generation,
          authorizationId: scope.authorizationId,
          runId: run.runId,
          consumerGeneration: run.consumerGeneration,
          timeoutMs: MUTATION_TIMEOUT_MS,
        },
        workerHarness: config?.execution.harness ?? null,
        workerModel: config?.execution.workerModel ?? null,
        codexSandbox: codexSandboxForDispatch(approvedRisksFor(scopeId)),
        companionStateRoot: commonDirPath === null ? null : join(commonDirPath, COMPANION_STATE_DIRECTORY),
        writer: writerFor(session.incarnation),
        env: options.env,
        clock,
        bindingWindowMs,
      }),
    });
    const blocker = recoveryBlockerOf(continuation);
    if (blocker === null) {
      clearExecutionBlocker(scopeId, 'recovery');
    } else {
      recordExecutionBlocker(
        scopeId,
        'recovery',
        blocker.code,
        `Recovery ${continuation.recoveryId}：${blocker.message}`,
      );
    }
    // Recovery 已经写入过权威事实：发布一次已提交变化，界面按快照读回。
    publish(session.coordinatorSessionId, {
      kind: 'state-changed',
      coordinationScopeId: scopeId,
      revision: scopeRecord(scopeId)?.revision ?? 0,
      reason: `recovery-continued:${segment.segmentId}:${continuation.result.kind}`,
    });
    return true;
  };

  /**
   * 一个触发点的一次执行推进。
   *
   * 触发点固定为宿主命令与事件处理：启动对账完成后、授权切换成功后、Resume 成功后，以及一次集成 /
   * Finalizer 结论落地后。这里**一次最多推进一个阶段**：`progressed` 意味着刚刚签发过一次外部
   * mutation，而 Worker 是否已经出现在 `worker-list` 里要到下一次触发点才重新读取，因此在同一个
   * 触发点里再推进一次有可能对同一个候选再发一次 `worker-start`。并发上限为 1 的判定在
   * `advanceExecution` 内部，本函数不复制它。
   */
  const runExecutionTrigger = async (session: LiveSession): Promise<void> => {
    if (closed || session.fencingLost) {
      return;
    }
    // 补记错过的 Session Binding：它是这条派发之后所有归属（Delivery、Recovery、Validator 结果）的前提。
    await reconcileUnboundRoleSessions(session);
    // 确认中断的 Session 先续办：它是「这个 Work Package 当前该做什么」的前提。
    if (await recoverLostWorkerSession(session)) {
      return;
    }
    await integrateAcceptedWorkPackage(session);
    await runFinalizerForScope(session);
    await advanceExecutionOnce(session);
  };

  /**
   * 触发点的串行化：同一个 Session 上同时在跑一次执行推进时，后来的一次直接跳过。
   *
   * 执行驱动自己的并发上限判定（读到的 Worker 观察 + store 的 lane 唯一性）仍然成立，这里只是不让
   * 两次推进互相穿插；跳过的那一次由下一个触发点接上，因此不会丢工作。
   */
  const executionTriggerInFlight = new Map<string, Promise<void>>();
  const triggerExecution = (session: LiveSession): void => {
    if (executionTriggerInFlight.has(session.coordinatorSessionId)) {
      return;
    }
    const running = runExecutionTrigger(session).finally(() => {
      executionTriggerInFlight.delete(session.coordinatorSessionId);
    });
    executionTriggerInFlight.set(session.coordinatorSessionId, running);
  };

  /**
   * 启动对账的已提交事实 → 语义事件（IP-07）。
   *
   * 只发布**已经落盘并读回**的变化：本次真正结算的 Delivery（不是重放、不是历史化、不是重复）与
   * 状态确实变化的 Recovery。keepalive、无变化对账与不可核验的观察都不在这里发布。
   */
  const publishStartupCommittedFacts = (session: LiveSession, started: StartedCompanionStartup): void => {
    const scopeId = session.incarnation.coordinationScopeId;
    for (const outcome of started.deliveries.outcomes) {
      if (outcome.kind !== 'settled') {
        continue;
      }
      publish(session.coordinatorSessionId, {
        kind: 'state-changed',
        coordinationScopeId: scopeId,
        revision: scopeRecord(scopeId)?.revision ?? 0,
        reason: `delivery-settled:${outcome.deliveryId}`,
      });
    }
    const current = requireStore();
    if (current === null) {
      return;
    }
    for (const continuation of started.recoveries) {
      const read = current.query({
        kind: 'recovery',
        coordinationScopeId: scopeId,
        recoveryId: continuation.recoveryId,
      });
      if (read.kind !== 'recovery' || read.recovery === null || read.recovery.status === continuation.previousStatus) {
        continue;
      }
      publish(session.coordinatorSessionId, {
        kind: 'recovery-status-changed',
        coordinationScopeId: scopeId,
        recoveryId: continuation.recoveryId,
        status: read.recovery.status,
      });
    }
  };

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

  /**
   * Scope 级控制：直接使用该 Scope 启动序列接线后的那个服务。
   *
   * 它的 `reconciliation` 是以**原 OperationId** 对账的 `reconcileOperations`，`workers` 是 Orca
   * `worker-stop` 的生产端口；Resume 因此天然「先对账、再恢复调度」，Exit 仍只结束进程。
   * 启动序列尚未完成（或已失败）时返回 `null`，由调用方给出显式原因——这里没有占位实现。
   */
  const scopeControlService = (): ScopeControlService | null => {
    const scopeId = selectedScopeId;
    if (scopeId === null) {
      return null;
    }
    const startup = startupOf(scopeId);
    return startup !== null && startup.kind === 'started' ? startup.startup.scopeControl : null;
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
    if (service === null) {
      const conclusion = startupOf(scopeId);
      if (conclusion !== null && conclusion.kind === 'rejected') {
        return rejected(
          `startup_${conclusion.code}`,
          `启动对账序列未能完成（停在 ${conclusion.step}）：${conclusion.message}`,
        );
      }
      return rejected('startup_not_completed', '启动对账序列尚未完成：拒绝在没有对账的情况下改变 Scope 控制状态');
    }
    const request = {
      coordinationScopeId: scopeId,
      writer: writerFor(ensured.session.incarnation),
    };
    // Resume 的语义是「先对账，再恢复调度」；对账不能与本进程**正在跑**的那次推进抢同一批 intent，
    // 否则一个在途 mutation 的 intent 会被自己的对账判成未决而阻塞整条 lane。因此先等在途推进收尾
    // （有界），再交给既有的对账用例。
    if (action === 'resume') {
      const inFlight = executionTriggerInFlight.get(ensured.session.coordinatorSessionId);
      if (inFlight !== undefined) {
        const { promise, resolve } = Promise.withResolvers<'settled' | 'timeout'>();
        const timer = setTimeout(() => resolve('timeout'), RESUME_IN_FLIGHT_WAIT_MS);
        void inFlight.finally(() => {
          clearTimeout(timer);
          resolve('settled');
        });
        const waited = await promise;
        if (waited === 'timeout') {
          return rejected(
            'execution_in_flight',
            `本进程正在推进执行且未在 ${String(RESUME_IN_FLIGHT_WAIT_MS)}ms 内收尾：不在此刻对账，避免把在途 mutation 判成未决`,
          );
        }
      }
    }
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
    // Resume 先对账再恢复调度：对账已在上面的用例里完成，这里按 D1 的触发点推进一次。
    if (action === 'resume') {
      triggerExecution(ensured.session);
    }
    return accepted(`Scope 控制状态：${result.controlState}`, null);
  };

  // ---------------------------------------------------------------------
  // 执行授权（IP-01）：规划事实 → 完整 Manifest 审阅 → 用户批准 → 原子切换
  //
  // 这里只**读**权威事实并把它们交给 `execution-runtime` 的用例；Manifest 组装、指纹、门禁判定与
  // 切换都由那些用例拥有。界面只拿到投影后的展示行与指纹，因此它既不能组装 Manifest，也不能改变
  // 批准对象。
  // ---------------------------------------------------------------------

  /** 审阅所需的权威事实：Scope、配置策略、Git 身份与 tracker 当前地图。 */
  const authorizationFacts = async (): Promise<
    | { readonly kind: 'ok'; readonly facts: ExecutionAuthorizationFacts }
    | { readonly kind: 'blocked'; readonly code: string; readonly message: string }
  > => {
    const current = requireStore();
    const scopeId = selectedScopeId;
    if (current === null || scopeId === null) {
      return { kind: 'blocked', code: 'scope_unavailable', message: '当前没有可用的 Coordination Scope' };
    }
    if (config === null) {
      return { kind: 'blocked', code: 'config_unavailable', message: '项目配置不可用' };
    }
    if (canonicalWorktreePath === null || fullBranchRef === null) {
      return { kind: 'blocked', code: 'repository_unresolved', message: '缺少可核验的 Git 身份' };
    }
    const scope = scopeRecord(scopeId);
    if (scope === null || scope.planningCycleId === null) {
      return { kind: 'blocked', code: 'invalid_state', message: '当前 Scope 没有 Planning Cycle' };
    }
    const tracker = trackerFor();
    if (tracker === null) {
      return { kind: 'blocked', code: 'tracker_unavailable', message: 'tracker 不可用' };
    }
    const map = routeMapRef();
    if (map === null) {
      return { kind: 'blocked', code: 'invalid_state', message: '缺少 Route Map 引用' };
    }
    const read = await readRouteMap({ tracker, routeMapRef: map, planningCycleId: scope.planningCycleId });
    if (read.kind !== 'read') {
      return {
        kind: 'blocked',
        code: read.kind === 'not_found' ? 'not_found' : read.kind === 'unavailable' ? 'unavailable' : 'unknown',
        message:
          read.kind === 'not_found'
            ? `Route Map issue ${map.id} 不存在`
            : read.kind === 'unavailable'
              ? read.message
              : read.reason,
      };
    }
    return {
      kind: 'ok',
      facts: {
        store: current,
        coordinationScopeId: scopeId,
        policy: config.execution,
        workspace: {
          canonicalWorktreePath,
          canonicalBranch: fullBranchRef.startsWith('refs/heads/')
            ? fullBranchRef.slice('refs/heads/'.length)
            : fullBranchRef,
        },
        routeMapRef: read.snapshot.routeMapRef,
        routeMap: read.snapshot,
      },
    };
  };

  /** 完整 Manifest 的展示投影；界面只消费这些行，因此领域字段不会流进组件。 */
  const authorizationManifestRows = (
    review: ExecutionAuthorizationReview,
  ): readonly { readonly label: string; readonly value: string }[] => {
    const manifest = review.manifest;
    const limits = manifest.limits;
    return [
      { label: 'Coordination Scope', value: manifest.coordinationScopeId },
      { label: 'Planning Cycle', value: manifest.planningCycleId },
      {
        label: 'Destination',
        value: `${manifest.destinationRef.id}@${String(manifest.destinationRef.version)}`,
      },
      { label: 'Route Map', value: `#${manifest.routeMapRef.id}@${String(manifest.routeMapRef.version)}` },
      {
        label: 'Implementation Plan',
        value: `${manifest.implementationPlanRef.id}@${String(manifest.implementationPlanRef.version)}`,
      },
      {
        label: 'Graph',
        value: `${manifest.graph.graphId} g${String(manifest.graph.generation)} v${String(manifest.graph.version)}`,
      },
      { label: 'baseline HEAD', value: manifest.baselineHead },
      { label: 'Orca Run', value: manifest.orcaRunId },
      {
        label: 'Worker Profiles',
        value: manifest.workerProfiles.map((profile) => `${profile.role}→${profile.harness}`).join(' '),
      },
      {
        // 沙箱模式必须在审阅里可见：它是「Worker 能写什么」的直接约束，放宽与否只能由用户看到后批准。
        label: 'Worker Sandbox',
        value: `codex=${config?.execution.codexSandbox ?? DEFAULT_PROJECT_EXECUTION.codexSandbox} finalizer=read-only`,
      },
      {
        label: 'Permissions',
        value: `planner=${String(manifest.permissions.planner)} implementation=${String(manifest.permissions.implementation)} validator=${String(manifest.permissions.validator)} finalizer=${String(manifest.permissions.finalizer)} git=${String(manifest.permissions.gitIntegration)} deps=${String(manifest.permissions.dependencyChanges)}`,
      },
      {
        label: 'Limits',
        value: `active≤${String(limits.maxActiveWorkPackages)} 并发=${String(limits.concurrencyLimit)} 实现×${String(limits.implementationAttempts)} 修复×${String(limits.validatorRepairs)} 图修订×${String(limits.graphRevisions)} 规格修订×${String(limits.specificationRevisions)} 恢复×${String(limits.maxRecoveriesPerWorkerAttempt)}`,
      },
      { label: 'Workspace', value: manifest.workspacePolicy.canonicalWorktree },
      {
        label: 'Git Policy',
        value: `${manifest.gitPolicy.canonicalBranch} remotes=[${manifest.gitPolicy.remotes.join(',')}] refs=[${manifest.gitPolicy.refs.join(',')}]`,
      },
      {
        label: 'Dependency Policy',
        value: `allowChanges=${String(manifest.dependencyPolicy.allowDependencyChanges)} registry=${manifest.dependencyPolicy.registry ?? 'none'}`,
      },
      {
        label: 'Accepted Risks',
        value: manifest.acceptedRisks.length === 0 ? 'none' : manifest.acceptedRisks.join(' | '),
      },
    ];
  };

  /** 一次只读审阅；调用方要么拿到可批准的完整 Manifest，要么拿到明确的阻塞原因。 */
  const reviewAuthorizationForDisplay = async (): Promise<ExecutionAuthorizationLoad> => {
    const read = await authorizationFacts();
    if (read.kind !== 'ok') {
      return { kind: 'blocked', code: read.code, message: read.message };
    }
    const reviewed = reviewExecutionAuthorization(read.facts);
    if (reviewed.kind === 'blocked') {
      return {
        kind: 'blocked',
        code: 'planning_facts_incomplete',
        message: reviewed.blockers.map((blocker) => `${blocker.code}: ${blocker.message}`).join('；'),
      };
    }
    if (reviewed.kind === 'rejected') {
      return { kind: 'rejected', code: reviewed.code, message: reviewed.message };
    }
    const gate = reviewed.review.gate;
    return {
      kind: 'review',
      review: {
        fingerprint: reviewed.review.fingerprint,
        scopeRevision: reviewed.review.scopeRevision,
        candidate: {
          graphId: reviewed.review.candidate.graphId,
          generation: reviewed.review.candidate.generation,
          version: reviewed.review.candidate.version,
          baselineHead: reviewed.review.candidate.baselineHead,
          workPackageCount: reviewed.review.candidate.workPackageCount,
        },
        manifestRows: authorizationManifestRows(reviewed.review),
        gate: {
          ready: gate.kind === 'allowed',
          blockers: gate.kind === 'allowed' ? [] : gate.blockers.map((blocker) => `${blocker.code}: ${blocker.message}`),
        },
      },
    };
  };

  /** 批准：宿主重读全部权威输入后才写入批准与切换，界面只能回传它看到的指纹与 revision。 */
  const approveAuthorization = async (input: {
    readonly fingerprint: string;
    readonly expectedRevision: number;
  }): Promise<ControllerCommandResult> => {
    const read = await authorizationFacts();
    if (read.kind !== 'ok') {
      return rejected(read.code, read.message);
    }
    const shown = reviewExecutionAuthorization(read.facts);
    if (shown.kind !== 'review') {
      return rejected(shown.kind === 'blocked' ? 'planning_facts_incomplete' : shown.code, '授权事实已变化，请重新审阅');
    }
    if (shown.review.scopeRevision !== input.expectedRevision) {
      return rejected('stale_revision', '授权审阅的 Scope revision 已过期');
    }
    const sessionId = scopeControlSessionId();
    if (sessionId === null) {
      return rejected('no_active_incarnation', '当前没有可以写入授权的 Coordinator Session');
    }
    const ensured = await ensureLiveSession(sessionId);
    if (ensured.kind === 'failed') {
      return rejected(ensured.code, ensured.message);
    }
    const refreshed = await authorizationFacts();
    if (refreshed.kind !== 'ok') {
      return rejected(refreshed.code, refreshed.message);
    }
    const revision = scopeRecord(refreshed.facts.coordinationScopeId)?.revision;
    if (revision === undefined) {
      return rejected('scope_unavailable', '无法读取授权提交前的 Scope revision');
    }
    const result = approveExecutionAuthorization({
      ...refreshed.facts,
      writer: writerFor(ensured.session.incarnation),
      fingerprint: input.fingerprint,
      expectedRevision: revision,
    });
    if (result.kind === 'rejected') {
      return rejected(result.code, result.message);
    }
    if (result.kind === 'blocked') {
      return rejected(
        'handoff_gate_blocked',
        `授权 ${result.authorizationId} 已记录，但门禁未通过：${result.blockers
          .map((blocker) => `${blocker.code}: ${blocker.message}`)
          .join('；')}`,
      );
    }
    publish(null, {
      kind: 'state-changed',
      coordinationScopeId: refreshed.facts.coordinationScopeId,
      revision: result.revision,
      reason: `execution-authorization:${result.authorizationId}`,
    });
    // 授权切换成功是 D1 的触发点之一：切换完成后立刻按新事实推进一次，而不是等用户再发一条消息。
    triggerExecution(ensured.session);
    return accepted(
      `已批准 ${result.authorizationId} v${String(result.authorizationVersion)}，Scope 进入 Execution Coordination`,
      result.revision,
    );
  };

  /**
   * 编译候选图：Coordinator 提出的 Implementation Plan 由宿主补齐全世代、Run 与 OperationId。
   *
   * 这条命令是模型侧唯一的编译入口：模型只能提供计划正文，图身份与 Run 都来自宿主读取的权威事实。
   */
  const proposeGraph = async (plan: unknown): Promise<ControllerCommandResult> => {
    const current = requireStore();
    const scopeId = selectedScopeId;
    if (current === null || scopeId === null) {
      return rejected('scope_unavailable', '当前没有可用的 Coordination Scope');
    }
    if (config === null) {
      return rejected('config_unavailable', '项目配置不可用');
    }
    if (canonicalWorktreePath === null) {
      return rejected('repository_unresolved', '缺少可核验的 canonical worktree');
    }
    const sessionId = scopeControlSessionId();
    if (sessionId === null) {
      return rejected('no_active_incarnation', '当前没有可以发起编译的 Coordinator Session');
    }
    const ensured = await ensureLiveSession(sessionId);
    if (ensured.kind === 'failed') {
      return rejected(ensured.code, ensured.message);
    }
    const scope = scopeRecord(scopeId);
    if (scope === null) {
      return rejected('scope_unavailable', `无法读取 Scope ${scopeId}`);
    }
    const identity = await orcaProbe.readCoordinatorIdentity();
    if (!identity.ok) {
      return rejected('identity_unavailable', `缺少专用协调身份：${identity.detail}`);
    }
    // baseline HEAD 是这次候选图的固定输入：它既是 Manifest 的字段，也是集成时的期望值。
    const baseline = await readWorkspaceFacts({ worktreePath: canonicalWorktreePath });
    if (baseline.kind !== 'observed') {
      return rejected('baseline_unreadable', `无法读取 canonical HEAD：${baseline.reason}`);
    }
    const backend = backendForExecution();
    if (backend === null) {
      return rejected('backend_unavailable', '无法建立 Orca ExecutionBackend');
    }
    const result = await proposeExecutionGraph({
      store: current,
      backend,
      coordinationScopeId: scopeId,
      writer: writerFor(ensured.session.incarnation),
      backendIdentityRef: identity.value,
      timeoutMs: MUTATION_TIMEOUT_MS,
      authority: { kind: 'route_planning' },
      plan,
      limits: config.execution.limits,
      baselineHead: baseline.facts.head,
      objective: `Orca Companion ${scopeId} graph generation`,
    });
    if (result.kind === 'recorded') {
      publish(null, {
        kind: 'state-changed',
        coordinationScopeId: scopeId,
        revision: scopeRecord(scopeId)?.revision ?? 0,
        reason: `candidate-graph:${result.candidate.graphId}`,
      });
      return accepted(
        `候选图 ${result.candidate.graphId} v${String(result.candidate.version)} 已记录（${String(result.candidate.workPackageCount)} 个 Work Package）`,
      );
    }
    if (result.kind === 'unknown') {
      return {
        kind: 'unknown',
        code: 'run_create_unsettled',
        message: `${result.reason}；按原 OperationId ${result.operationId} 对账`,
      };
    }
    return rejected(result.code, result.message);
  };

  const executionAuthorizationPort: ExecutionAuthorizationIntentPort = {
    review: async () => await reviewAuthorizationForDisplay(),
    approve: async (input) => await approveAuthorization(input),
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
    executionAuthorization: async (input) => {
      switch (input.action) {
        case 'propose-graph':
          return await proposeGraph(input.plan);
        case 'review': {
          const loaded = await reviewAuthorizationForDisplay();
          return loaded.kind === 'review'
            ? accepted(`已读取完整 Manifest（fingerprint ${loaded.review.fingerprint}）`)
            : rejected(loaded.code, loaded.message);
        }
        case 'approve':
          return await approveAuthorization({
            fingerprint: input.fingerprint,
            expectedRevision: input.expectedRevision,
          });
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
    executionAuthorization: executionAuthorizationPort,
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
