/**
 * MOD-07：前台执行运行时的装配（Owner: `m2-wire-execution-runtime`）。
 *
 * 这个模块只做**事实装配与用例编排**：把可信身份、当前规划产物与版本化项目配置组装成既有 IC-05
 * 用例要求的输入，再按固定顺序调用它们。执行图状态、预算、授权与切换都仍由那些用例与 store 拥有，
 * 这里不复制任何一条它们的规则，也不保存第二份执行状态。
 *
 * 三条硬边界：
 * - **身份来自可信宿主**：Scope、Session、Runtime Incarnation、Graph Generation、OperationId 都由
 *   调用方给出；模型与界面填不了它们（`AGENTS.md` §5）；
 * - **引用必须可重读**：Manifest 的每一项都能从 Scope、候选图记录、世代记录、Git 身份与项目配置
 *   重新读出，因此批准时的指纹比对证明的是「用户批准的就是当前这份内容」；
 * - **副作用先落意图**：建 Run 与后续派发都沿用 IC-03 的 Operation Intent；结果不可判定时以原
 *   OperationId 保留未决，不换 ID 重试。
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type {
  CoordinationScopeId,
  DispatchId,
  SessionSegmentId,
  GraphGeneration,
  GraphId,
  GraphVersion,
  OperationId,
  PlanningCycleId,
  VersionedRef,
  WorkPackageId,
  WorkerTaskId,
} from '../application/dto/identity.js';
import type {
  BranchCoordinationStore,
  CoordinationWriter,
  GraphGenerationRecord,
  MaterializationBindingRecord,
  SessionSegmentRecord,
} from '../application/ports/branch-coordination-store.js';
import { readDeliveryBatch } from '../adapters/orca-cli/delivery-reader.js';
import { ackConsumedDelivery } from '../application/delivery/process-delivery.js';
import {
  parseDeliveryClaimedPayload,
  parseOrcaWorkerDoneLocator,
  type DeliveryClaimedPayload,
  type DeliveryPayloadParse,
  type OrcaWorkerDoneLocator,
} from '../application/worker-report-dto.js';
import {
  capsuleRefOf,
  readRecoveryCapsuleBody,
  writeRecoveryCapsuleBody,
} from '../application/recovery/recovery-capsule.js';
import { deriveRecoveryId } from '../application/recovery/worker-session-recovery-service.js';
import type { DeliveryMessage } from '../application/dto/operation-outcome.js';
import {
  buildExecutionScope,
  type ExecutionAuthority,
  type ExecutionBackend,
  type WorktreeListResult,
} from '../application/ports/execution-backend.js';
import {
  type TerminalListResult,
  type WorkerListResult,
  type WorkerShowResult,
  type WorkerStartReceipt,
} from '../adapters/orca-cli/operation-catalog.js';
import { createCodexWorkerLaunch, installCodexSessionStartReporter } from '../adapters/agents/codex-launch.js';
import { JsonCredentialStore, credentialStorePath } from '../adapters/storage/credential-store.js';
import {
  readOnlyWorkerUnavailableReason,
  type ReadOnlyWorkerProbe,
} from '../adapters/agents/codex-read-only-probe.js';
import {
  buildUtilityWorkerEnvelope,
  dispatchCapsuleWorker,
  findDispatchedUtilityWorker,
  type UtilityWorkerDispatchInput,
} from '../adapters/agents/utility-worker.js';
import {
  inspectCodexTranscript,
  readCodexTranscriptIdentity,
  type CodexSessionStartReport,
} from '../adapters/agents/codex-transcript.js';
import { bindCodexSessionFromStartReport, sessionBindingIdOf } from '../adapters/agents/session-binding.js';
import { readWorkspaceFacts } from '../adapters/git/baseline-observer.js';
import { workerStateLiveness } from '../application/execution/execution-view.js';
import { workPackageComment } from '../application/materialize-work-package.js';
import { graphIdFor, startGraphGeneration, type EmptyRunAllocator } from '../application/planning/graph-generation.js';
import { recordInitialGraph } from '../application/planning/graph-history.js';
import { ensureGraphGenerationRecord } from '../application/execution/replanning-service.js';
import { readScope } from '../application/planning/scope-read.js';
import {
  activeAuthorization,
  proposeManifest,
  readAcceptedAuthorizationByFingerprint,
  recordApproval,
  recordModelReauthorization,
} from '../application/planning/authorization-service.js';
import { evaluateHandoffGate, handoffGateFacts, type HandoffGateFacts, type HandoffGateResult } from '../application/planning/handoff-gate.js';
import { transitionToExecution } from '../application/planning/lease-handoff.js';
import { acceptResultLaneKey, ackLaneKey } from '../application/delivery/process-delivery.js';
import type { PendingDelivery } from '../application/reconciliation/replay-deliveries.js';
import type {
  RecoveryExecutionContext,
  RecoveryFactSubject,
  WorkspaceReconciliation,
} from '../application/recovery/worker-session-recovery-service.js';
import type { ClaimedResultAttribution, TrustedExecutionFacts } from '../domain/worker-result-verification.js';
import type { TerminalLivenessFacts } from '../domain/worker-liveness.js';
import type { SpecBinding } from '../domain/task-contract.js';
import type { WorkerModelConfiguration } from '../domain/model-configuration.js';
import { compileExecutionGraph, parseImplementationPlan, type CompilationError } from '../domain/planning/graph-compiler.js';
import {
  MANIFEST_VERSION,
  WORKER_ROLES,
  manifestFingerprint,
  type ExecutionAuthorizationManifest,
  type ExecutionAuthorizationRecord,
  type RoleAuthorities,
  type WorkerRole,
} from '../domain/planning/execution-authorization.js';
import { workPackageOf, type GraphVersionRecord } from '../domain/planning/execution-graph.js';
import type { DecisionTicket, RouteMapSnapshot } from '../domain/planning/route-map.js';
import {
  CODEX_FULL_ACCESS_RISK,
  type CodexSandboxMode,
  type ProjectExecutionConfiguration,
} from './project-config.js';
import type { PendingDeliveryRead, StartupRecoveryFacts, RecoveryFactUnavailable } from './startup.js';

export type ExecutionRuntimeBlocker = {
  readonly code: string;
  readonly message: string;
};

/** 候选图的稳定引用；由已记录的 GraphVersion 与世代记录派生，不含任何可变显示状态。 */
export type ExecutionGraphCandidate = {
  readonly graphId: string;
  readonly generation: number;
  readonly version: number;
  readonly mapRevision: number;
  readonly planRevision: number;
  readonly orcaRunId: string;
  readonly baselineHead: string;
  readonly workPackageCount: number;
};

/* -------------------------------------------------------------------------- */
/* 候选图：Plan → 世代与空 Run → 编译 → 追加初始 GraphVersion                  */
/* -------------------------------------------------------------------------- */

export type ProposeExecutionGraphInput = {
  readonly store: BranchCoordinationStore;
  readonly backend: ExecutionBackend;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly writer: CoordinationWriter;
  readonly backendIdentityRef: string;
  readonly timeoutMs: number;
  readonly authority: ExecutionAuthority;
  /** Coordinator 提出的结构化 Implementation Plan；编译边界自己校验结构。 */
  readonly plan: unknown;
  /** Manifest 的预算上限；候选图的节点预算与并发上限由它派生。 */
  readonly limits: ProjectExecutionConfiguration['limits'];
  readonly baselineHead: string;
  readonly objective: string;
};

export type ProposeExecutionGraphResult =
  | { readonly kind: 'recorded'; readonly candidate: ExecutionGraphCandidate }
  | {
      readonly kind: 'rejected';
      readonly code: string;
      readonly message: string;
      readonly errors: readonly CompilationError[];
    }
  | { readonly kind: 'unknown'; readonly operationId: OperationId; readonly reason: string };

/**
 * 空 Run 的分配：Orca `run-create` 是真实副作用，因此走 ExecutionScope，并在建立后按同一身份读回。
 *
 * Run 的身份不取自 `run-create` 的回执正文，而是用专用身份读 `run-current`：这是本仓库已核验的读回
 * 路径。读不回就保持未决——造一个 Run 身份比停在未决更危险。
 */
export function createEmptyRunAllocator(input: {
  readonly backend: ExecutionBackend;
  readonly writer: CoordinationWriter;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly backendIdentityRef: string;
  readonly operationHead: string;
  readonly operationId: OperationId;
  readonly expectedRevision: number;
  readonly timeoutMs: number;
  readonly authority: ExecutionAuthority;
}): EmptyRunAllocator {
  return async (request) => {
    if (request.graphId !== input.operationHead) {
      // 世代派生出现分歧时不能继续：这次 Run 的身份已经绑定在另一个 GraphId 上。
      return {
        kind: 'rejected',
        code: 'generation_mismatch',
        message: `Run 分配针对 ${input.operationHead}，实际请求 ${request.graphId}`,
      };
    }
    const scope = buildExecutionScope({
      coordinationScopeId: input.coordinationScopeId,
      coordinatorSessionId: input.writer.coordinatorSessionId,
      runtimeIncarnationId: input.writer.runtimeIncarnationId,
      fencingGeneration: input.writer.fencingGeneration,
      backendIdentityRef: input.backendIdentityRef,
      operationId: input.operationId,
      target: { kind: 'orca-run', id: request.graphId },
      expectedRevision: input.expectedRevision,
      timeoutMs: input.timeoutMs,
      authority: input.authority,
    });
    const created = await input.backend.mutate({ operation: 'run-create', objective: request.objective }, scope);
    if (created.kind === 'rejected') {
      return { kind: 'rejected', code: created.code, message: created.message };
    }
    if (created.kind === 'unknown') {
      return { kind: 'unknown', reason: created.reason };
    }
    const current = await input.backend.query({
      operation: 'run-current',
      backendIdentityRef: input.backendIdentityRef,
    });
    if (current.kind !== 'accepted') {
      return { kind: 'unknown', reason: `Run 建立后无法按专用身份读回：${current.code} ${current.message}` };
    }
    const run = (current.value as { readonly run?: { readonly runId?: unknown } | null }).run ?? null;
    const runId = run === null ? undefined : run.runId;
    if (typeof runId !== 'string' || runId.length === 0) {
      return { kind: 'unknown', reason: '专用身份下没有读到任何 Run，无法确认本次 Run 身份' };
    }
    return {
      kind: 'allocated',
      orcaRunId: runId,
      ...(created.operation.backendRequestId === undefined
        ? {}
        : { requestId: created.operation.backendRequestId }),
    };
  };
}

/**
 * 记录候选图：分配世代与空 Run、编译计划、追加初始 GraphVersion。
 *
 * 顺序不可交换：世代与 Run 必须先存在，编译产出的图才能绑定它们；编译失败时不追加任何图历史，
 * 但已分配的 Run 会留在 Orca（它的身份已记录在世代记录里，下一次批准沿用它）。
 */
export async function proposeExecutionGraph(
  input: ProposeExecutionGraphInput,
): Promise<ProposeExecutionGraphResult> {
  const scopeRead = readScope(input.store, input.coordinationScopeId);
  if (scopeRead.kind === 'rejected') {
    return { kind: 'rejected', code: scopeRead.code, message: scopeRead.message, errors: [] };
  }
  const scope = scopeRead.scope;
  if (scope.planningCycleId === null) {
    return {
      kind: 'rejected',
      code: 'planning_cycle_missing',
      message: '当前 Scope 没有 Planning Cycle，不能编译候选图',
      errors: [],
    };
  }
  const generation = nextGraphGeneration(input.store, input.coordinationScopeId, scope.graphId);
  if (generation.kind === 'rejected') {
    return { kind: 'rejected', code: generation.code, message: generation.message, errors: [] };
  }
  const expectedGraphId = graphIdFor(input.coordinationScopeId, generation.generation as GraphGeneration);
  const initialPlan = parseImplementationPlan(input.plan);
  if (!initialPlan.ok) {
    return { kind: 'rejected', code: 'invalid_plan', message: initialPlan.message, errors: [] };
  }
  const compiled = compileExecutionGraph({
    plan: initialPlan.value,
    limits: input.limits,
    graphId: expectedGraphId,
    generation: generation.generation as GraphGeneration,
  });
  if (!compiled.ok) {
    return {
      kind: 'rejected',
      code: 'compilation_failed',
      message: '候选图编译失败：' + compiled.errors.map((entry) => entry.code + ':' + entry.message).join('；'),
      errors: compiled.errors,
    };
  }
  const planRevision = planRevisionOf(input.plan);
  if (planRevision === null) {
    return { kind: 'rejected', code: 'invalid_plan', message: 'Implementation Plan 缺少 planRevision', errors: [] };
  }
  const intents = input.store.query({ kind: 'intents', coordinationScopeId: input.coordinationScopeId });
  if (intents.kind !== 'intents') {
    return { kind: 'rejected', code: 'intent_unreadable', message: '无法读取 Run 创建意图', errors: [] };
  }
  const prior = intents.intents.filter((intent) =>
    intent.operationCategory === 'run-create' &&
    intent.target.kind === 'orca-run' &&
    intent.target.id === expectedGraphId,
  );
  const unsettled = prior.find((intent) => intent.state !== 'settled' || intent.outcomeClass !== 'rejected');
  if (unsettled !== undefined) {
    return {
      kind: 'unknown',
      operationId: unsettled.operationId,
      reason: '既有 Run 创建结果尚不能证明无副作用，必须以原 OperationId 对账',
    };
  }
  const operationId = runCreateOperationId(input.coordinationScopeId, generation.generation, prior.length);

  const started = await startGraphGeneration({
    store: input.store,
    coordinationScopeId: input.coordinationScopeId,
    planningCycleId: scope.planningCycleId,
    writer: input.writer,
    operationId,
    objective: input.objective,
    allocateRun: createEmptyRunAllocator({
      backend: input.backend,
      writer: input.writer,
      coordinationScopeId: input.coordinationScopeId,
      backendIdentityRef: input.backendIdentityRef,
      operationHead: expectedGraphId,
      operationId,
      expectedRevision: scope.revision,
      timeoutMs: input.timeoutMs,
      authority: input.authority,
    }),
  });
  if (started.kind === 'unknown') {
    return { kind: 'unknown', operationId, reason: started.reason };
  }
  if (started.kind === 'rejected') {
    return { kind: 'rejected', code: started.code, message: started.message, errors: [] };
  }
  const recorded = ensureGraphGenerationRecord({
    store: input.store,
    coordinationScopeId: input.coordinationScopeId,
    writer: input.writer,
    graphId: started.generation.graphId,
    generation: started.generation.generation,
    planningCycleId: started.generation.planningCycleId,
    orcaRunId: started.generation.orcaRunId,
    predecessorGraphId: scope.graphId,
    baselineHead: input.baselineHead,
  });
  if (recorded.kind === 'rejected') {
    return { kind: 'rejected', code: recorded.failure.code, message: recorded.failure.message, errors: [] };
  }

  const version = recordInitialGraph({
    store: input.store,
    coordinationScopeId: input.coordinationScopeId,
    writer: input.writer,
    graph: compiled.graph,
    initialPlan: initialPlan.value,
    mapRevision: scope.mapRevision,
    planRevision,
    orcaRunId: started.generation.orcaRunId,
  });
  if (version.kind === 'rejected') {
    return { kind: 'rejected', code: version.failure.code, message: version.failure.message, errors: [] };
  }
  return {
    kind: 'recorded',
    candidate: {
      graphId: version.version.graphId,
      generation: version.version.generation,
      version: version.version.version,
      mapRevision: version.version.mapRevision,
      planRevision: version.version.planRevision,
      orcaRunId: version.version.orcaRunId,
      baselineHead: input.baselineHead,
      workPackageCount: compiled.graph.workPackages.length,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* 授权：审阅完整 Manifest 与原子批准                                          */
/* -------------------------------------------------------------------------- */

export type ExecutionAuthorizationFacts = {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  /** 版本化项目配置里的执行策略；Manifest 的长期字段全部来自它。 */
  readonly policy: ProjectExecutionConfiguration;
  /** 当前 Git 身份：canonical worktree 与完整 branch ref。 */
  readonly workspace: {
    readonly canonicalWorktreePath: string;
    readonly canonicalBranch: string;
  };
  readonly routeMapRef: VersionedRef<'route-map'>;
  readonly routeMap: RouteMapSnapshot;
};

export type ExecutionAuthorizationReview = {
  readonly manifest: ExecutionAuthorizationManifest;
  readonly fingerprint: string;
  readonly candidate: ExecutionGraphCandidate;
  /** 批准时用于 CAS 的候选图记录；授权记录只能绑定到它。 */
  readonly candidateRecord: GraphVersionRecord;
  /** 当前生效的授权记录；`null` 表示还没有任何批准。 */
  readonly existingAuthorization: ExecutionAuthorizationRecord | null;
  readonly scopeRevision: number;
  readonly planningCycleId: string;
  readonly gate: HandoffGateResult;
};

export type ExecutionAuthorizationReviewResult =
  | { readonly kind: 'review'; readonly review: ExecutionAuthorizationReview }
  | { readonly kind: 'blocked'; readonly blockers: readonly ExecutionRuntimeBlocker[] }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

export type ApproveExecutionAuthorizationInput = ExecutionAuthorizationFacts & {
  readonly writer: CoordinationWriter;
  /** 用户在审阅里看到的那份 Manifest 的指纹。 */
  readonly fingerprint: string;
  readonly expectedRevision: number;
};

export type ApproveExecutionAuthorizationResult =
  | {
      readonly kind: 'approved';
      readonly revision: number;
      readonly authorizationId: string;
      readonly authorizationVersion: number;
    }
  | {
      /** Manifest 已写入，但门禁未通过：Mode 保持不变，旧批准不触发任何派发。 */
      readonly kind: 'blocked';
      readonly authorizationId: string;
      readonly blockers: readonly ExecutionRuntimeBlocker[];
    }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

/**
 * 门禁事实的唯一装配点。
 *
 * `authorization` 是「用于判定的那一份授权」：审阅阶段传入**这份候选 Manifest 若被批准的等价记录**，
 * 因此用户看到的是「批准后门禁是否通过」；批准阶段传入刚写入的真实授权记录。两处共用同一装配，
 * 门禁条件不会在两处出现分歧。
 */
function handoffFactsFor(input: {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly routeMap: RouteMapSnapshot;
  readonly candidate: GraphVersionRecord;
  readonly authorization: ExecutionAuthorizationRecord | null;
}): HandoffGateFacts | null {
  const snapshot = input.store.query({ kind: 'snapshot', coordinationScopeId: input.coordinationScopeId });
  if (snapshot.kind !== 'snapshot') {
    return null;
  }
  return handoffGateFacts({
    snapshot: snapshot.snapshot,
    tickets: openTicketsOf(input.routeMap),
    routeMap: input.routeMap,
    currentPlanRevision: input.candidate.planRevision,
    candidate: input.candidate,
    authorization: input.authorization,
  });
}

/**
 * 组装并审阅完整 Manifest。
 *
 * 组装只读，且每一项都可重读：Scope 提供 Scope/Cycle/地图 revision，候选图记录提供 Graph、Run 与
 * 计划 revision，世代记录提供 baseline HEAD，Git 身份提供 canonical worktree 与分支，项目配置提供
 * Worker Profile、权限、上限与策略。因此「用户批准的是哪一份内容」可以用指纹精确比对。
 */
export function reviewExecutionAuthorization(
  facts: ExecutionAuthorizationFacts,
): ExecutionAuthorizationReviewResult {
  const blockers: ExecutionRuntimeBlocker[] = [];
  const scopeRead = readScope(facts.store, facts.coordinationScopeId);
  if (scopeRead.kind === 'rejected') {
    return { kind: 'rejected', code: scopeRead.code, message: scopeRead.message };
  }
  const scope = scopeRead.scope;
  if (scope.planningCycleId === null) {
    blockers.push({ code: 'planning_cycle_missing', message: '当前 Scope 没有 Planning Cycle' });
  }
  const candidateRead = readCandidate(facts.store, facts.coordinationScopeId, scope.graphId);
  if (candidateRead.kind === 'rejected') {
    return { kind: 'rejected', code: candidateRead.code, message: candidateRead.message };
  }
  if (candidateRead.version === null) {
    blockers.push({
      code: 'candidate_graph_missing',
      message: '当前还没有被接受编译的候选 Execution Graph：先编译正式 Implementation Plan',
    });
  }
  const generationRead = readGeneration(facts.store, facts.coordinationScopeId, scope.graphId);
  if (generationRead.kind === 'rejected') {
    return { kind: 'rejected', code: generationRead.code, message: generationRead.message };
  }
  if (candidateRead.version !== null && generationRead.record === null) {
    blockers.push({
      code: 'generation_record_missing',
      message: `候选图 ${candidateRead.version.graphId} 没有世代记录：baseline HEAD 与 Run 绑定缺失`,
    });
  }
  const candidate = candidateRead.version;
  const generation = generationRead.record;
  if (blockers.length > 0 || candidate === null || generation === null || scope.planningCycleId === null) {
    return { kind: 'blocked', blockers };
  }
  // 放宽 Worker 沙箱不是默认路径：它必须同时出现在项目配置的 acceptedRisks 里，因此用户在审阅时
  // 看到的是「这份 Manifest 明确接受了这条风险」，而不是一次悄悄的降级。
  if (
    facts.policy.codexSandbox === 'danger-full-access' &&
    !facts.policy.acceptedRisks.includes(CODEX_FULL_ACCESS_RISK)
  ) {
    return {
      kind: 'blocked',
      blockers: [
        {
          code: 'codex_sandbox_risk_not_accepted',
          message: `Worker 沙箱被设为 danger-full-access，但 acceptedRisks 里没有 ${CODEX_FULL_ACCESS_RISK}：先显式接受该风险再授权`,
        },
      ],
    };
  }

  const rawManifest = {
    manifestVersion: MANIFEST_VERSION,
    coordinationScopeId: facts.coordinationScopeId,
    planningCycleId: scope.planningCycleId,
    // Destination 与 Implementation Plan 的引用由地图引用与各自 revision 派生：本 change 不新增
    // 第二份规划产物记录，因此这两个引用必须能在批准时被同样地重读出来。
    destinationRef: {
      kind: 'destination',
      id: `destination:${facts.routeMapRef.id}`,
      version: scope.mapRevision,
    },
    routeMapRef: { kind: 'route-map', id: facts.routeMapRef.id, version: scope.mapRevision },
    implementationPlanRef: {
      kind: 'implementation-plan',
      id: `${facts.routeMapRef.id}#implementation-plan`,
      version: candidate.planRevision,
    },
    graph: { graphId: candidate.graphId, generation: candidate.generation, version: candidate.version },
    baselineHead: generation.baselineHead,
    orcaRunId: candidate.orcaRunId,
    workerProfiles: WORKER_ROLES.map((role) => {
      const profile = facts.policy.workerProfiles.find((entry) => entry.profileRef === facts.policy.workerProfileRefs[role] && entry.role === role);
      return profile === undefined ? { role } : {
        profileRef: { kind: 'worker-profile', id: profile.profileRef },
        role,
        harness: profile.harness,
        modelConfiguration: profile.modelConfiguration,
      };
    }),
    recoveryUtilityProfile: (() => {
      const profile = facts.policy.workerProfiles.find((entry) => entry.profileRef === facts.policy.workerProfileRefs.recovery_utility && entry.role === 'recovery_utility');
      return profile === undefined ? null : {
        profileRef: { kind: 'worker-profile', id: profile.profileRef },
        harness: profile.harness,
        modelConfiguration: profile.modelConfiguration,
      };
    })(),
    permissions: facts.policy.permissions,
    limits: facts.policy.limits,
    workspacePolicy: {
      canonicalWorktree: facts.workspace.canonicalWorktreePath,
      worktreeIsolation: 'per_work_package',
    },
    gitPolicy: {
      canonicalBranch: facts.workspace.canonicalBranch,
      remotes: [...facts.policy.git.remotes],
      refs: [...facts.policy.git.refs],
      allowForcePush: false,
    },
    dependencyPolicy: facts.policy.dependency,
    acceptedRisks: [...facts.policy.acceptedRisks],
  };

  const currentAuthorization = activeAuthorization(facts.store, facts.coordinationScopeId);
  if (currentAuthorization.kind === 'rejected') {
    return { kind: 'rejected', code: currentAuthorization.failure.code, message: currentAuthorization.failure.message };
  }
  if (scope.mode === 'execution_coordination') {
    const snapshot = facts.store.query({ kind: 'snapshot', coordinationScopeId: facts.coordinationScopeId });
    if (scope.controlState === 'cancelling' || scope.controlState === 'cancelled' || scope.controlState === 'unverifiable' ||
      scope.controlState === 'replanning_transition' ||
      snapshot.kind !== 'snapshot' || snapshot.snapshot.unresolvedIntents.length > 0 ||
      generation.status === 'suspended' || generation.status === 'frozen') {
      return { kind: 'rejected', code: 'model_reapproval_unavailable', message: '当前控制状态、重规划或未决副作用不允许模型重新授权' };
    }
    const previous = currentAuthorization.authorization;
    if (previous === null || previous.manifest.graph.graphId !== candidate.graphId ||
      previous.manifest.graph.generation !== candidate.generation || previous.manifest.orcaRunId !== candidate.orcaRunId) {
      return { kind: 'rejected', code: 'authorization_binding_missing', message: '当前图没有可核验的执行授权' };
    }
    const manifest = {
      ...previous.manifest,
      graph: { ...previous.manifest.graph, version: candidate.version },
      workerProfiles: rawManifest.workerProfiles,
      recoveryUtilityProfile: rawManifest.recoveryUtilityProfile,
      // 重新授权只允许改动并行包额度；它随完整指纹与 CAS 一起批准，不构成 Graph Revision。
      limits: { ...previous.manifest.limits, maxActiveWorkPackages: facts.policy.limits.maxActiveWorkPackages },
    };
    const parsed = proposeManifest({ store: facts.store, coordinationScopeId: facts.coordinationScopeId,
      rawManifest: manifest, candidate, currentPlanRevision: candidate.planRevision });
    if (parsed.kind === 'rejected') return { kind: 'rejected', code: parsed.failure.code, message: parsed.failure.message };
    return { kind: 'review', review: { manifest: parsed.manifest, fingerprint: parsed.fingerprint,
      candidate: candidateOf(candidate, generation), candidateRecord: candidate,
      existingAuthorization: previous, scopeRevision: scope.revision,
      planningCycleId: scope.planningCycleId, gate: { kind: 'allowed' } } };
  }
  const proposed = proposeManifest({
    store: facts.store,
    coordinationScopeId: facts.coordinationScopeId,
    rawManifest,
    candidate,
    currentPlanRevision: candidate.planRevision,
  });
  if (proposed.kind === 'rejected') {
    return { kind: 'rejected', code: proposed.failure.code, message: proposed.failure.message };
  }
  const existingAuthorization = activeAuthorization(facts.store, facts.coordinationScopeId);
  if (existingAuthorization.kind === 'rejected') {
    return {
      kind: 'rejected',
      code: existingAuthorization.failure.code,
      message: existingAuthorization.failure.message,
    };
  }
  // 审阅回答的是「批准这份 Manifest 之后门禁是否通过」，因此门禁判定用这份内容本身的等价授权记录：
  // `authorization_missing` 正是批准要消除的那一项，而「旧批准绑定另一版候选图」也由这份记录取代。
  const prospective: ExecutionAuthorizationRecord = {
    coordinationScopeId: facts.coordinationScopeId,
    authorizationId: authorizationIdFor(proposed.manifest),
    authorizationVersion: 0,
    manifestVersion: proposed.manifest.manifestVersion,
    fingerprint: proposed.fingerprint,
    manifest: proposed.manifest,
    approvedAt: 0,
    approvalRef: 'pending-approval',
  };
  const gateFacts = handoffFactsFor({
    store: facts.store,
    coordinationScopeId: facts.coordinationScopeId,
    routeMap: facts.routeMap,
    candidate,
    authorization: prospective,
  });
  if (gateFacts === null) {
    return { kind: 'rejected', code: 'invalid_state', message: '无法读取 Coordination Scope 快照' };
  }

  return {
    kind: 'review',
    review: {
      manifest: proposed.manifest,
      fingerprint: proposed.fingerprint,
      candidate: candidateOf(candidate, generation),
      candidateRecord: candidate,
      scopeRevision: scope.revision,
      planningCycleId: scope.planningCycleId,
      gate: evaluateHandoffGate(gateFacts),
      existingAuthorization: existingAuthorization.authorization,
    },
  };
}

/**
 * 批准并原子切换到 Execution Coordination。
 *
 * 顺序固定：重读全部权威输入 → 比对指纹 → 记录批准 → 以**刚写入的授权**重判门禁 → 同事务切换。
 * 指纹不一致说明用户在审阅之后规划引用已经变化，此时不写任何记录；门禁未通过时授权已落盘但 Mode
 * 不变，旧批准不会触发任何派发。
 */
export function approveExecutionAuthorization(
  input: ApproveExecutionAuthorizationInput,
): ApproveExecutionAuthorizationResult {
  // 重放先于任何重算与门禁：已经受理过的同一份批准只能按指纹回读它的记录。若在这里按当前配置重新
  // 组装 Manifest，用户审阅之后配置或 Scope 控制状态的变化就会把一次重放变成新的决定。
  // 范围限定在已进入执行协调态的记录：初始规划态那次「已写入 Manifest 但未切换模式」的批准必须重新
  // 走门禁，否则会把它当成完成。控制状态与模式正交，因此 cancelling 也不阻断回读。
  const scopeForReplay = readScope(input.store, input.coordinationScopeId);
  if (scopeForReplay.kind === 'rejected') return scopeForReplay;
  if (scopeForReplay.scope.mode === 'execution_coordination' && scopeForReplay.scope.graphId !== null) {
    const replayed = readAcceptedAuthorizationByFingerprint({
      store: input.store,
      coordinationScopeId: input.coordinationScopeId,
      fingerprint: input.fingerprint,
    });
    if (replayed !== null && replayed.manifest.graph.graphId === scopeForReplay.scope.graphId) {
      return {
        kind: 'approved',
        revision: scopeForReplay.scope.revision,
        authorizationId: replayed.authorizationId,
        authorizationVersion: replayed.authorizationVersion,
      };
    }
  }
  const reviewed = reviewExecutionAuthorization(input);
  if (reviewed.kind === 'blocked') {
    return {
      kind: 'rejected',
      code: 'planning_facts_incomplete',
      message: reviewed.blockers.map((blocker) => blocker.message).join('；'),
    };
  }
  if (reviewed.kind === 'rejected') {
    return reviewed;
  }
  const review = reviewed.review;
  if (review.fingerprint !== input.fingerprint) {
    return {
      kind: 'rejected',
      code: 'manifest_changed',
      message: '当前规划事实与用户批准的 Manifest 不一致：请重新审阅后再次批准',
    };
  }
  if (review.scopeRevision !== input.expectedRevision) {
    return {
      kind: 'rejected',
      code: 'stale_revision',
      message: `expected revision ${String(input.expectedRevision)} 已过期，当前为 ${String(review.scopeRevision)}`,
    };
  }

  const existing = activeAuthorization(input.store, input.coordinationScopeId);
  if (existing.kind === 'rejected') {
    return { kind: 'rejected', code: existing.failure.code, message: existing.failure.message };
  }
  const reusable =
    existing.authorization !== null && existing.authorization.fingerprint === review.fingerprint
      ? existing.authorization
      : null;
  const approvalScope = readScope(input.store, input.coordinationScopeId);
  if (approvalScope.kind === 'rejected') return approvalScope;
  const recorded =
    reusable === null
      ? approvalScope.scope.mode === 'execution_coordination'
        ? recordModelReauthorization({ store: input.store, coordinationScopeId: input.coordinationScopeId,
          writer: input.writer, authorizationId: authorizationIdFor(review.manifest),
          expectedScopeRevision: input.expectedRevision,
          workerProfiles: review.manifest.workerProfiles, recoveryUtilityProfile: review.manifest.recoveryUtilityProfile,
          graphVersion: review.manifest.graph.version,
          maxActiveWorkPackages: input.policy.limits.maxActiveWorkPackages,
          approvalRef: `user-approval:${review.fingerprint.slice(0, 16)}` })
        : recordApproval({
          store: input.store,
          coordinationScopeId: input.coordinationScopeId,
          writer: input.writer,
          authorizationId: authorizationIdFor(review.manifest),
          manifest: review.manifest,
          currentPlanRevision: review.candidate.planRevision,
          approvalRef: `user-approval:${review.fingerprint.slice(0, 16)}`,
        })
      : ({ kind: 'recorded', authorization: reusable } as const);
  if (recorded.kind === 'rejected') {
    return { kind: 'rejected', code: recorded.failure.code, message: recorded.failure.message };
  }

  const scopeAfterApproval = readScope(input.store, input.coordinationScopeId);
  if (scopeAfterApproval.kind === 'rejected') return scopeAfterApproval;
  if (scopeAfterApproval.scope.mode === 'execution_coordination') {
    return { kind: 'approved', revision: scopeAfterApproval.scope.revision,
      authorizationId: recorded.authorization.authorizationId,
      authorizationVersion: recorded.authorization.authorizationVersion };
  }

  const gateFacts = handoffFactsFor({
    store: input.store,
    coordinationScopeId: input.coordinationScopeId,
    routeMap: input.routeMap,
    candidate: review.candidateRecord,
    authorization: recorded.authorization,
  });
  if (gateFacts === null) {
    return { kind: 'rejected', code: 'invalid_state', message: '无法读取 Coordination Scope 快照' };
  }
  const transitioned = transitionToExecution({
    store: input.store,
    coordinationScopeId: input.coordinationScopeId,
    planningCycleId: review.planningCycleId as PlanningCycleId,
    writer: input.writer,
    gateFacts,
  });
  if (transitioned.kind === 'blocked') {
    return {
      kind: 'blocked',
      authorizationId: recorded.authorization.authorizationId,
      blockers: transitioned.blockers.map((blocker) => ({ code: blocker.code, message: blocker.message })),
    };
  }
  if (transitioned.kind === 'rejected') {
    return { kind: 'rejected', code: transitioned.code, message: transitioned.message };
  }
  return {
    kind: 'approved',
    revision: transitioned.revision,
    authorizationId: transitioned.authorization.authorizationId,
    authorizationVersion: transitioned.authorization.authorizationVersion,
  };
}

/* -------------------------------------------------------------------------- */
/* 派生与内部读取                                                              */
/* -------------------------------------------------------------------------- */

/** run-create 的稳定操作身份：由 Scope 与候选图代际派生，重启与重放都得到同一个值。 */
export function runCreateOperationId(
  coordinationScopeId: CoordinationScopeId,
  generation: number,
  retry = 0,
): OperationId {
  const base = 'run-create:' + graphIdFor(coordinationScopeId, generation as GraphGeneration);
  return (retry === 0 ? base : base + ':retry-' + String(retry)) as OperationId;
}

/** 当前图 head 之后的世代号；与 `startGraphGeneration` 同源的一次只读派生（无图时为 1）。 */
export function nextGraphGeneration(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
  graphId: string | null,
): { readonly kind: 'read'; readonly generation: number } | { readonly kind: 'rejected'; readonly code: string; readonly message: string } {
  if (graphId === null) {
    return { kind: 'read', generation: 1 };
  }
  const head = store.query({ kind: 'graph-head', coordinationScopeId, graphId: graphId as GraphId });
  if (head.kind === 'rejected') {
    return { kind: 'rejected', code: head.code, message: head.message };
  }
  if (head.kind !== 'graph-head') {
    return { kind: 'rejected', code: 'invalid_state', message: '无法读取 GraphVersion 历史' };
  }
  return { kind: 'read', generation: head.version === null ? 1 : head.version.generation + 1 };
}

/** 开放 Decision Ticket 的只读投影：正文归 tracker，这里把地图章节的每一行当作一张开放票据。 */
export function openTicketsOf(routeMap: RouteMapSnapshot): readonly DecisionTicket[] {
  return routeMap.sections.open_decision_tickets
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => ({
      ticketRef: { kind: 'decision-ticket' as const, id: line, version: routeMap.routeMapRef.version },
      state: 'open' as const,
      blockedBy: [],
      assignee: null,
    }));
}

function readCandidate(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
  graphId: string | null,
): { readonly kind: 'read'; readonly version: GraphVersionRecord | null } | { readonly kind: 'rejected'; readonly code: string; readonly message: string } {
  if (graphId === null) {
    return { kind: 'read', version: null };
  }
  const head = store.query({ kind: 'graph-head', coordinationScopeId, graphId: graphId as GraphId });
  if (head.kind === 'rejected') {
    return { kind: 'rejected', code: head.code, message: head.message };
  }
  if (head.kind !== 'graph-head') {
    return { kind: 'rejected', code: 'invalid_state', message: '无法读取 GraphVersion 历史' };
  }
  return { kind: 'read', version: head.version };
}

function readGeneration(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
  graphId: string | null,
): { readonly kind: 'read'; readonly record: GraphGenerationRecord | null } | { readonly kind: 'rejected'; readonly code: string; readonly message: string } {
  if (graphId === null) {
    return { kind: 'read', record: null };
  }
  const read = store.query({ kind: 'graph-generation', coordinationScopeId, graphId: graphId as GraphId });
  if (read.kind === 'rejected') {
    return { kind: 'rejected', code: read.code, message: read.message };
  }
  if (read.kind !== 'graph-generation') {
    return { kind: 'rejected', code: 'invalid_state', message: '无法读取 Graph Generation 记录' };
  }
  return { kind: 'read', record: read.generation };
}

function candidateOf(version: GraphVersionRecord, generation: GraphGenerationRecord): ExecutionGraphCandidate {
  return {
    graphId: version.graphId,
    generation: version.generation,
    version: version.version,
    mapRevision: version.mapRevision,
    planRevision: version.planRevision,
    orcaRunId: version.orcaRunId,
    baselineHead: generation.baselineHead,
    workPackageCount: version.graph.workPackages.length,
  };
}

function planRevisionOf(plan: unknown): number | null {
  if (typeof plan !== 'object' || plan === null) {
    return null;
  }
  const value = (plan as { readonly planRevision?: unknown }).planRevision;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** 完整配置变化产生新的追加授权身份。 */
function authorizationIdFor(manifest: ExecutionAuthorizationManifest): string {
  return `auth:${manifest.graph.graphId}:${manifestFingerprint(manifest)}`;
}

/* -------------------------------------------------------------------------- */
/* IP-04：当前 Run 的未确认 Delivery 与 Recovery 的生产事实装配                  */
/* -------------------------------------------------------------------------- */

/**
 * 装配 Delivery / Recovery 事实时读不到的东西。
 *
 * 与「已经证明」在类型上不可混淆：读不到时**只能**给出它，调用方据此返回显式 `rejected` 或阻塞
 * 对应 lane，绝不用空数组、空字符串或猜测值顶替。
 */
export type ExecutionFactUnavailable = {
  readonly kind: 'unavailable';
  readonly code: string;
  readonly message: string;
};

/**
 * 物化记录里没有、必须另外读取的 worktree 事实。
 *
 * `materializationBindings` 只回答「这个 Work Package 的当前角色级 Orca Task 是谁」，因此 worktree
 * 身份、Spec Binding 与 Git 改动路径都要从 worktree 读：生产走 `worktree-list` 加 `readWorkspaceFacts`，
 * 测试注入 fake。`changedPaths` 必须是 Controller 从 Git 读到的实际改动，不信任 Worker 自报范围。
 */
export type DeliveryWorktreeFacts = {
  readonly kind: 'read';
  readonly worktreeId: string;
  readonly specBinding: SpecBinding;
  readonly changedPaths: readonly string[];
};

export type DeliveryWorktreeFactReader = (input: {
  readonly workPackageId: WorkPackageId;
  readonly binding: MaterializationBindingRecord;
  readonly segment: SessionSegmentRecord;
  readonly scopeEnvelope: GraphVersionRecord['graph']['workPackages'][number]['scopeEnvelope'];
  readonly authority: RoleAuthorities;
  readonly specificationRevisionLimit: number;
}) => Promise<DeliveryWorktreeFacts | ExecutionFactUnavailable>;

/**
 * locator 与 claimed payload 解析的唯一实现在应用层（`application/worker-report-dto`）；这里只保留
 * 既有 bootstrap 导出面，避免任何 bootstrap 装配路径复制第二份解析。
 */
export { parseOrcaWorkerDoneLocator, parseDeliveryClaimedPayload };
export type { OrcaWorkerDoneLocator, DeliveryClaimedPayload, DeliveryPayloadParse };

export type PendingDeliveryReadInput = {
  readonly store: BranchCoordinationStore;
  readonly backend: ExecutionBackend;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly backendIdentityRef: string;
  /** 当前图身份：Scope Envelope 的权威来源是当前 GraphVersion 里的 WorkPackage。 */
  readonly graphId: GraphId;
  readonly graphVersion: GraphVersion;
  readonly graphGeneration: number;
  readonly authorizationId: string;
  readonly runId: string;
  readonly consumerGeneration: number;
  readonly timeoutMs: number;
  /** 物化记录里没有的 worktree 事实读取 seam；生产读 `worktree-list` + Git，测试注入 fake。 */
  readonly readWorktreeFacts: DeliveryWorktreeFactReader;
};

/** 读一条消息需要的事实：全部来自 store、当前图、授权与 Git；任一不可读即阻塞，不猜。 */
type DeliveryTrustedFactsRead =
  | {
      readonly kind: 'read';
      readonly trusted: TrustedExecutionFacts;
      /** 本次 Delivery 的声称归属：由已记录事实重建（Orca 规范载荷只提供 locator）。 */
      readonly claimed: ClaimedResultAttribution;
      readonly orcaTaskId: string;
    }
  | { readonly kind: 'blocked'; readonly code: string; readonly message: string; readonly laneKey: string | null };

function readSegmentFor(
  segments: readonly SessionSegmentRecord[],
  claimed: ClaimedResultAttribution,
): SessionSegmentRecord | null {
  if (claimed.dispatchId === null || claimed.attemptId === null || claimed.workerTaskId === null) {
    return null;
  }
  return (
    segments.find(
      (segment) =>
        segment.dispatchId === claimed.dispatchId &&
        segment.attemptId === claimed.attemptId &&
        segment.workerTaskId === claimed.workerTaskId,
    ) ?? null
  );
}

/** 读一条消息得到的两条真实路径：Companion 形状（含身份）或 Orca 规范形状（只有 locator）。 */
type DeliveryIntake =
  | { readonly kind: 'claimed'; readonly claimed: ClaimedResultAttribution; readonly acceptedResult: unknown }
  | {
      readonly kind: 'locator';
      readonly locator: OrcaWorkerDoneLocator;
      /** Orca Task Recording 的正文：Companion 接受并回写的归一化结果。 */
      readonly acceptedResult: unknown;
    };

/**
 * 用 Orca 的 locator 解析出被记录的那次派发。
 *
 * 判据全部来自 Controller 在派发时写下的事实：`materialization_bindings.orcaTaskId` 定位 Task 与角色，
 * Session Segment 按 Orca Dispatch 定位同一次派发；两者必须逐项一致（Work Package / 角色 / Attempt /
 * Task），否则阻塞——既不放行「最接近的一条」，也不从 Worker 自报字段补位。
 */
function resolveLocator(
  input: {
    readonly store: BranchCoordinationStore;
    readonly coordinationScopeId: CoordinationScopeId;
    readonly segments: readonly SessionSegmentRecord[];
  },
  locator: OrcaWorkerDoneLocator,
): { readonly segment: SessionSegmentRecord; readonly binding: MaterializationBindingRecord } | null {
  const segments = input.segments.filter((segment) => segment.dispatchId === locator.orcaDispatchId);
  if (segments.length !== 1) {
    return null;
  }
  const segment = segments[0]!;
  const bindings = input.store.query({
    kind: 'materialization-bindings',
    coordinationScopeId: input.coordinationScopeId,
    workPackageId: segment.workPackageId,
  });
  if (bindings.kind !== 'materialization-bindings') {
    return null;
  }
  const binding = bindings.bindings.find(
    (entry) =>
      entry.identity === 'issued' &&
      entry.orcaTaskId === locator.orcaTaskId &&
      entry.role === segment.role &&
      entry.workerTaskId === segment.workerTaskId &&
      entry.attemptId === segment.attemptId,
  );
  return binding === undefined ? null : { segment, binding };
}

/**
 * 装配一条未确认 Delivery 的可信事实。
 *
 * 归属身份取自 store 的 Session Segment（Controller 在派发时写入的事实），worktree 事实取自 worktree
 * 读取 seam；载荷只用来**定位**这条事实。任何一项对不上或读不到都必须阻塞，不得用载荷自报值补位。
 */
/**
 * 用户级凭据 store：与 Coordinator 装配、模型设置保存共用同一份 env 视图。
 *
 * 按调用方传入的 env 而不是 \`process.env\` 解析路径，因此隔离启动与测试只需替换这一处；
 * 替代 Session 与新建 Utility 都用 managed 凭据，缺这一层时准备阶段无法 fail closed 证明 key 存在。
 */
function credentialStore(
  env: Readonly<Record<string, string>>,
): JsonCredentialStore {
  return new JsonCredentialStore({ environment: env });
}

/**
 * 物化绑定钉住的那份授权。
 *
 * 入口是绑定上的授权身份、授权版本与 profile 引用三项：任一缺失（schema 16 之前的历史行）、读不回，
 * 或记录里的版本与绑定登记的不一致，都返回 \`null\` 由调用方阻塞。版本不一致尤其不能放过——那说明绑定
 * 写下的授权身份与实际批准的那份不是同一件事，按哪一边结算都是猜。
 */
function pinnedAuthorizationOf(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
  binding: MaterializationBindingRecord,
  role: WorkerRole,
): { readonly authorizationId: string; readonly authorization: ExecutionAuthorizationRecord } | null {
  // 三项必须同时齐备：授权身份、授权版本与 Worker Profile 引用共同构成这条 Task 的运行依据。
  // 缺任一项都无法证明「这份结果产生于哪次授权、用哪个 profile」，因此一律不可证明，不做「缺版本就
  // 当作匹配」这类兼容猜测——那会让 schema 16 之前的历史行悄悄按当前授权结算。
  if (
    binding.authorizationId === null ||
    binding.authorizationVersion === null ||
    binding.workerProfileRef === null
  ) {
    return null;
  }
  const read = store.query({
    kind: 'authorization',
    coordinationScopeId,
    authorizationId: binding.authorizationId,
  });
  if (read.kind !== 'authorization' || read.authorization === null) {
    return null;
  }
  // 绑定登记的版本必须与实际批准的那份逐字一致：不等说明绑定写下的是另一个授权身份，按哪一边结算
  // 都是猜。
  if (read.authorization.authorizationVersion !== binding.authorizationVersion) {
    return null;
  }
  const profile = read.authorization.manifest.workerProfiles.find((entry) => entry.role === role);
  if (profile === undefined || profile.profileRef.id !== binding.workerProfileRef.id) {
    return null;
  }
  return { authorizationId: binding.authorizationId, authorization: read.authorization };
}

async function readDeliveryTrustedFacts(input: {
  readonly input: PendingDeliveryReadInput;
  readonly segments: readonly SessionSegmentRecord[];
  readonly graphVersion: GraphVersionRecord;
  readonly authority: RoleAuthorities;
  readonly intake: DeliveryIntake;
}): Promise<DeliveryTrustedFactsRead> {
  const resolved =
    input.intake.kind === 'claimed'
      ? null
      : resolveLocator(
          {
            store: input.input.store,
            coordinationScopeId: input.input.coordinationScopeId,
            segments: input.segments,
          },
          input.intake.locator,
        );
  if (input.intake.kind === 'locator' && resolved === null) {
    return {
      kind: 'blocked',
      code: 'dispatch_record_missing',
      message:
        'Orca 报告显示结果属于某个已退出的 Dispatch，但 store 里没有与之逐项匹配的 Session Segment / 物化绑定：无法证明这次 Delivery 属于本 Scope 的哪次派发',
      laneKey: null,
    };
  }
  const segment = resolved === null ? readSegmentFor(input.segments, (input.intake as { claimed: ClaimedResultAttribution }).claimed) : resolved.segment;
  if (segment === null) {
    return {
      kind: 'blocked',
      code: 'dispatch_record_missing',
      message: 'store 里没有与该归属匹配的 Session Segment：无法证明这次 Delivery 属于本 Scope 的哪次派发',
      laneKey: null,
    };
  }
  const binding = input.input.store.query({
    kind: 'materialization-bindings',
    coordinationScopeId: input.input.coordinationScopeId,
    workPackageId: segment.workPackageId,
  });
  const materialization = binding.kind === 'materialization-bindings'
    ? (resolved === null
        ? binding.bindings.find((entry) =>
            entry.role === segment.role &&
            entry.workerTaskId === segment.workerTaskId &&
            entry.attemptId === segment.attemptId,
          )
        : binding.bindings.find((entry) => entry.orcaTaskId === resolved.binding.orcaTaskId)) ?? null
    : null;
  if (materialization === null) {
    return {
      kind: 'blocked',
      code: 'materialization_binding_missing',
      message: `Work Package ${segment.workPackageId} 没有物化绑定：不知道结果应当记录在哪个 Orca Task 上`,
      laneKey: null,
    };
  }
  const workPackage = workPackageOf(input.graphVersion.graph, segment.workPackageId);
  if (workPackage === null) {
    return {
      kind: 'blocked',
      code: 'work_package_not_in_graph',
      message: `Work Package ${segment.workPackageId} 不在当前 GraphVersion 里：Scope Envelope 无法核验`,
      laneKey: acceptResultLaneKey(materialization.orcaTaskId),
    };
  }
  const worktree = await input.input.readWorktreeFacts({
    workPackageId: segment.workPackageId,
    binding: materialization,
    segment,
    scopeEnvelope: workPackage.scopeEnvelope,
    authority: input.authority,
    specificationRevisionLimit: workPackage.budget.specificationRevisions,
  });
  if (worktree.kind === 'unavailable') {
    return {
      kind: 'blocked',
      code: worktree.code,
      message: worktree.message,
      laneKey: acceptResultLaneKey(materialization.orcaTaskId),
    };
  }
  if (materialization.worktreeId === null || worktree.worktreeId !== materialization.worktreeId) {
    return {
      kind: 'blocked',
      code: 'worktree_mismatch',
      message: 'Delivery 的 worktree 与物化绑定不一致或旧绑定缺少身份',
      laneKey: acceptResultLaneKey(materialization.orcaTaskId),
    };
  }
  /**
   * 结果结算按 **Task 自己钉住的授权** 校验，而不是当前授权。
   *
   * 换模型的重新授权只对新的物化 Task 生效：在途 Task 带着旧授权跑完之后回到的 Delivery 必须按它
   * 派出时的授权版本核验，否则「重新授权期间结算旧结果」会被读成新授权下的合法结果，等于让旧模型
   * 的产出借用新模型的身份通过验收。
   *
   * 绑定上缺少 pin（schema 16 之前的历史行）时阻塞：没有可证明的授权身份只能按不可证明处理，不能
   * 回退到当前授权——那正是这条规则要防止的事。
   */
  const pinned = pinnedAuthorizationOf(
    input.input.store,
    input.input.coordinationScopeId,
    materialization,
    segment.role,
  );
  if (pinned === null) {
    return {
      kind: 'blocked',
      code: 'authorization_pin_missing',
      message:
        '物化绑定没有钉住授权身份（authorizationId=' +
        (materialization.authorizationId ?? 'null') +
        '，workerProfileRef=' +
        (materialization.workerProfileRef === null ? 'null' : materialization.workerProfileRef.id) +
        '）：无法证明这份结果是在哪次授权下产生的，不按当前授权结算',
      laneKey: acceptResultLaneKey(materialization.orcaTaskId),
    };
  }
  if (
    pinned.authorization.manifest.coordinationScopeId !== input.input.coordinationScopeId ||
    pinned.authorization.manifest.orcaRunId !== input.input.runId ||
    pinned.authorization.manifest.graph.graphId !== input.input.graphId
  ) {
    return {
      kind: 'blocked',
      code: 'authorization_pin_mismatch',
      message: '物化绑定钉住的授权不属于当前 Scope、Run 或 Graph：结果不推进当前生命周期',
      laneKey: acceptResultLaneKey(materialization.orcaTaskId),
    };
  }
  // 当前代际必须仍是这条 Task 所属的那一代：跨代旧结果只能补历史，不能推进当前生命周期。
  if (pinned.authorization.manifest.graph.generation !== input.input.graphGeneration) {
    return {
      kind: 'blocked',
      code: 'authorization_pin_mismatch',
      message:
        '物化绑定钉住的授权属于图代际 ' +
        String(pinned.authorization.manifest.graph.generation) +
        '，当前代际是 ' +
        String(input.input.graphGeneration) +
        '：跨代结果不推进当前生命周期',
      laneKey: acceptResultLaneKey(materialization.orcaTaskId),
    };
  }
  return {
    kind: 'read',
    orcaTaskId: materialization.orcaTaskId,
    // 归属的**唯一**来源是已记录的事实：Orca 规范载荷只提供 locator，因此这里由解析结果重建 claimed，
    // 后续 `verifyWorkerResult` 校验的是「解析出的这条派发与当前代际/授权一致」。
    claimed: claimedOf({
      segment,
      specBinding: worktree.specBinding,
      worktreeId: worktree.worktreeId,
      execution: input.input,
    }),
    trusted: {
      runId: input.input.runId,
      consumerGeneration: input.input.consumerGeneration,
      graphGeneration: input.input.graphGeneration,
      // 按 Task 派出时的授权核验；当前授权只决定「新 Task 能否派发」，不参与旧结果的可信性判定。
      authorizationId: pinned.authorizationId,
      workerTaskId: segment.workerTaskId,
      dispatchId: segment.dispatchId,
      attemptId: segment.attemptId,
      role: segment.role,
      specBinding: worktree.specBinding,
      worktreeId: worktree.worktreeId,
      // 角色权限同样取自该 Task 当时批准的 Manifest：重新授权不追溯改变在途 Task 的权限边界。
      authority: pinned.authorization.manifest.permissions,
      scopeEnvelope: workPackage.scopeEnvelope,
      changedPaths: worktree.changedPaths,
    },
  };
}

/** 由已记录事实装配本次 Delivery 的声称归属；Orca 载荷只用于定位，不由它提供身份字段。 */
function claimedOf(input: {
  readonly segment: SessionSegmentRecord;
  readonly specBinding: SpecBinding;
  readonly worktreeId: string;
  readonly execution: {
    readonly runId: string;
    readonly consumerGeneration: number;
    readonly graphGeneration: number;
    readonly authorizationId: string;
  };
}): ClaimedResultAttribution {
  return {
    runId: input.execution.runId,
    consumerGeneration: input.execution.consumerGeneration,
    graphGeneration: input.execution.graphGeneration,
    authorizationId: input.execution.authorizationId,
    workerTaskId: input.segment.workerTaskId,
    dispatchId: input.segment.dispatchId,
    attemptId: input.segment.attemptId,
    role: input.segment.role,
    specBinding: input.specBinding,
    worktreeId: input.worktreeId,
  };
}

/**
 * 读取当前 Run 的未确认 Delivery 并装配 `PendingDelivery`。
 *
 * 三种结论严格区分，不用空数组冒充「没有未确认 Delivery」：
 * - `rejected`：读取本身失败（Orca 不可达、批次结构不完整、有消息但没有稳定 Delivery 身份）；
 * - `read.pending`：已经核验的 Delivery，交给前驱唯一 pipeline（`replayDeliveries` → `settleDelivery`）；
 * - `read.blocked`：读到了消息但事实无法证明（载荷不可解析、没有匹配的派发记录、物化绑定或 worktree
 *   事实不可读）。它们不进入重放，对应的可派发 lane 被阻塞并给出可观察原因。
 *
 * `deliveryId` 取自批次自身的稳定身份（`batch.delivery.deliveryId`），不由本模块生成；OperationId
 * 只是「该 lane 从未登记过 intent」时的稳定候选，lane 上已有未决 intent 时以 store 中的原 ID 为准。
 */
/**
 * 消息是否承载结果。
 *
 * Orca 的结果消息类型是 `worker_done`；进度消息（心跳、phase 等）没有结果正文，也不构成归属证明。
 * 只按类型判定、不看正文：正文解析失败必须 fail closed，而不是被这里静默丢弃。
 */
function isResultDeliveryMessage(message: DeliveryMessage): boolean {
  return message.type === 'worker_done';
}

export async function readPendingDeliveries(
  input: PendingDeliveryReadInput,
): Promise<PendingDeliveryRead> {
  const batchRead = await readDeliveryBatch(input.backend, {
    backendIdentityRef: input.backendIdentityRef,
    runId: input.runId,
    types: ['worker_done'],
    timeoutMs: input.timeoutMs,
  });
  if (batchRead.kind !== 'accepted') {
    return { kind: 'rejected', code: batchRead.code, message: `未确认 Delivery 读取失败：${batchRead.message}` };
  }
  const batch = batchRead.value;
  if (batch.delivery === null) {
    if (batch.messages.length === 0) {
      // Orca 明确报告没有未确认批次：这是读取事实，不是「没有新工作」的推断。
      return { kind: 'read', pending: [] };
    }
    return {
      kind: 'rejected',
      code: 'delivery_identity_missing',
      message: '读到了 Delivery 消息，但没有稳定的 Delivery 身份：无法确认或结算任何 Delivery',
    };
  }
  const deliveryId = batch.delivery.deliveryId;
  // Orca 的未确认批次里可能只有进度消息（`heartbeat`），结果消息（`worker_done`）在它被确认之后才会
  // 成为当前批次。进度消息不承载结果，也没有可落盘的权威事实；把它当成「装配失败」会把整条
  // Delivery lane 永久阻塞，而真实的结果消息永远排在它后面。因此这里按事实区分二者。
  const resultMessages = batch.messages.filter((message) => isResultDeliveryMessage(message));
  if (batch.messages.length > 0 && resultMessages.length === 0) {
    return {
      kind: 'read',
      pending: [],
      progressAcks: [{ deliveryId, runId: batch.delivery.runId }],
    };
  }
  if (batch.messages.length === 0) {
    return {
      kind: 'read',
      pending: [],
      blocked: [
        {
          code: 'delivery_messages_missing',
          message: `Delivery ${deliveryId} 没有任何可读消息：归属与结果正文都无从核验，因此既不结算也不确认`,
          laneKey: ackLaneKey(deliveryId),
        },
      ],
    };
  }

  const snapshot = input.store.query({ kind: 'snapshot', coordinationScopeId: input.coordinationScopeId });
  if (snapshot.kind !== 'snapshot') {
    return { kind: 'rejected', code: 'invalid_state', message: '无法读取 Coordination Snapshot：Delivery 归属无从核验' };
  }
  const versionRead = input.store.query({
    kind: 'graph-version',
    coordinationScopeId: input.coordinationScopeId,
    graphId: input.graphId,
    graphVersion: input.graphVersion,
  });
  if (versionRead.kind !== 'graph-version') {
    return { kind: 'rejected', code: 'invalid_state', message: '无法读取当前 GraphVersion：Scope Envelope 无从核验' };
  }
  if (versionRead.version === null) {
    return { kind: 'rejected', code: 'graph_version_missing', message: `GraphVersion ${String(input.graphVersion)} 不存在` };
  }
  const authorizationRead = input.store.query({
    kind: 'authorization',
    coordinationScopeId: input.coordinationScopeId,
    authorizationId: input.authorizationId,
  });
  if (authorizationRead.kind !== 'authorization' || authorizationRead.authorization === null) {
    return { kind: 'rejected', code: 'authorization_unreadable', message: `Execution Authorization ${input.authorizationId} 不可读` };
  }
  const authority = authorizationRead.authorization.manifest.permissions;

  const pending: PendingDelivery[] = [];
  const blocked: { readonly code: string; readonly message: string; readonly laneKey: string | null }[] = [];
  for (const message of resultMessages) {
    if (message.runId !== null && message.runId !== input.runId) {
      blocked.push({
        code: 'delivery_run_mismatch',
        message: `Delivery ${deliveryId} 属于 Run ${message.runId}，不是当前 Run ${input.runId}`,
        laneKey: ackLaneKey(deliveryId),
      });
      continue;
    }
    const parsed = parseDeliveryClaimedPayload(message.payload);
    const locator = parsed.kind === 'rejected' ? parseOrcaWorkerDoneLocator(message.payload, message.body) : null;
    const intake: DeliveryIntake | null =
      parsed.kind === 'parsed'
        ? { kind: 'claimed', claimed: parsed.payload.claimed, acceptedResult: parsed.payload.acceptedResult }
        : locator === null
          ? null
          : {
              kind: 'locator',
              locator,
              // 归一化结果正文：Orca 只给出状态与改动清单，叙述在 `body`；这是 Companion 接受并回写的对象。
              acceptedResult: {
                outcome: locator.outcome,
                filesModified: locator.files,
                summary: locator.summary,
              },
            };
    if (intake === null) {
      blocked.push({
        code: parsed.kind === 'rejected' ? parsed.code : 'payload_unrecognized',
        message:
          parsed.kind === 'rejected'
            ? parsed.message
            : 'Delivery message 的 payload 既不是 Companion 形状也不是 Orca 的 worker_done 形状：无法判定归属与结果正文',
        laneKey: ackLaneKey(deliveryId),
      });
      continue;
    }
    // 独立基线 Planner 有自己的持久 Task/Dispatch 绑定与结算 driver；它不属于图上的角色物化绑定。
    // 留给该 driver 按原身份结算，通用角色 Delivery 重放不把它误报为缺失的普通 Worker。
    if (intake.kind === 'locator' && snapshot.snapshot.baselineReconciliations.some((record) =>
      record.state === 'required' && record.orcaTaskId === intake.locator.orcaTaskId &&
      record.dispatchId === intake.locator.orcaDispatchId,
    )) {
      continue;
    }
    // 集成复验的续接 Task/Dispatch 绑定在轮次记录上，由集成复验 runner 自己 accept/ack；它不是图上的
    // 角色物化绑定。按精确 Task/Dispatch 匹配当前图的 Work Package 轮次（pending/validated）后跳过
    // 通用角色 Delivery 重放，避免误报缺失绑定或全局阻塞。
    if (intake.kind === 'locator') {
      const matchedIntegration = versionRead.version.graph.workPackages.some((workPackage) => {
        const read = input.store.query({
          kind: 'integration-reconciliations',
          coordinationScopeId: input.coordinationScopeId,
          workPackageId: workPackage.workPackageId,
        });
        return (
          read.kind === 'integration-reconciliations' &&
          read.records.some((record) =>
            (record.state === 'pending' || record.state === 'validated' || record.state === 'blocked') &&
            record.orcaTaskId === intake.locator.orcaTaskId &&
            record.dispatchId === intake.locator.orcaDispatchId,
          )
        );
      });
      if (matchedIntegration) {
        continue;
      }
    }
    const facts = await readDeliveryTrustedFacts({
      input,
      segments: snapshot.snapshot.sessionSegments,
      graphVersion: versionRead.version,
      authority,
      intake,
    });
    if (facts.kind === 'blocked') {
      blocked.push({ code: facts.code, message: facts.message, laneKey: facts.laneKey });
      continue;
    }
    const segment = readSegmentFor(snapshot.snapshot.sessionSegments, facts.claimed);
    pending.push({
      delivery: {
        deliveryId,
        claimed: facts.claimed,
        acceptedResult: intake.acceptedResult,
      },
      trusted: facts.trusted,
      orcaTaskId: facts.orcaTaskId,
      operationIds: {
        // 只在「该 lane 从未登记过 intent」时使用；候选身份必须按 attempt 唯一，否则同一 Task 的
        // 第二次 Delivery 会命中已收尾的意图而被静默跳过。
        acceptResult:
          `delivery-accept-result:${deliveryId}:${segment === null ? 'unknown' : segment.dispatchId}:${segment === null ? 'unknown' : segment.attemptId}` as OperationId,
        ack: `delivery-ack:${deliveryId}` as OperationId,
      },
    });
  }
  return blocked.length === 0
    ? { kind: 'read', pending }
    : { kind: 'read', pending, blocked };
}

/* -------------------------------------------------------------------------- */
/* Recovery 续办的生产事实                                                     */
/* -------------------------------------------------------------------------- */

/** Codex 隔离状态根的命名：launchId → 状态根与 SessionStart 报告位置。 */
export function codexSessionPathsUnder(
  companionStateRoot: string,
  launchId: string,
): { readonly stateRoot: string; readonly reporterPath: string; readonly reportPath: string } {
  const stateRoot = join(companionStateRoot, 'codex');
  const id = createHash('sha256').update(launchId).digest('hex').slice(0, 20);
  return {
    stateRoot,
    reporterPath: join(stateRoot, 'reporters', `${id}.mjs`),
    reportPath: join(stateRoot, 'reporters', `${id}.jsonl`),
  };
}

/** 替代 Session 的稳定 launchId：同一 Recovery 的重放必须命中同一组 Codex 状态文件。 */
/** Capsule Utility Worker 的启动身份：由 Segment 确定性派生，重放沿用同一个。 */
export function capsuleLaunchIdOf(segmentId: SessionSegmentId): string {
  return `worker-launch:capsule:${encodeURIComponent(segmentId)}`;
}

/** Capsule Utility Worker 的一组稳定 OperationId：同一 Segment 重放时逐项相同。 */
function capsuleOperationIdsOf(segmentId: SessionSegmentId): UtilityWorkerDispatchInput['operationIds'] {
  const id = encodeURIComponent(segmentId);
  return {
    task: `op:capsule:${id}:task` as OperationId,
    workerPrepare: `op:capsule:${id}:worker-prepare` as OperationId,
    workerStart: `op:capsule:${id}:worker-start` as OperationId,
    workerActivate: `op:capsule:${id}:worker-activate` as OperationId,
  };
}

/**
 * 该 Segment 是否已经留下 Capsule 派发意图。
 *
 * 有意图就说明这次不是全新派发：无论它已收尾还是未决，都必须按原 OperationId 对账，探针结论不能改写
 * 既有事实。意图读不回来时同样按「有进行中的派发」处理——派发路径自己会以 lane 阻塞收尾，不会新建
 * mutation，也不会用能力缺失覆盖掉那份不确定。
 */
function capsuleIntentExists(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
  operationIds: UtilityWorkerDispatchInput['operationIds'],
): boolean {
  const intents = store.query({ kind: 'intents', coordinationScopeId });
  if (intents.kind !== 'intents') {
    return true;
  }
  const mine = new Set<string>(Object.values(operationIds));
  return intents.intents.some((intent) => mine.has(intent.operationId));
}

/** 等待 Capsule 报告的上界：契约上的提取 seam 是同步的，因此必须有界，超时按失败上报。 */
const CAPSULE_REPORT_TIMEOUT_MS = 120_000;

export function recoveryLaunchIdOf(recoveryId: string): string {
  return `worker-launch:recovery:${encodeURIComponent(recoveryId)}`;
}

export type ExecutionRecoveryFactsInput = {
  /** 协调状态读取；懒取是因为前台宿主按需要打开/重开 store，而事实读取发生在启动对账期间。 */
  readonly store: () => BranchCoordinationStore;
  readonly backend: ExecutionBackend;
  readonly coordinationScopeId: CoordinationScopeId;
  /** canonical worktree：隔离 worktree 的列举范围与 Origin 选择器。 */
  readonly canonicalWorktree: string;
  /** 已读到的执行上下文；缺任一项时按不可读报告，不派发替代 Session。 */
  readonly execution: RecoveryExecutionContext | null;
  /** Worker Profile（harness 与模型）：替代 Session 默认复用它们，不从界面或模型填。 */
  readonly workerHarness: string | null;
  readonly resolveModelConfiguration: (subject: RecoveryFactSubject, kind: 'replacement' | 'utility') => WorkerModelConfiguration | null;
  /**
   * 替代 Session 的 Codex 沙箱模式；与常规角色派发同源（都来自已批准 Manifest 绑定的项目配置）。
   * `null` 表示当前配置的沙箱模式未被授权接受，此时替代派发不可用。
   */
  readonly codexSandbox: CodexSandboxMode | null;
  /** Companion 私有的状态根（Git common dir 下）；缺失即无法证明 Codex Session。 */
  readonly companionStateRoot: string | null;
  /**
   * 本机只读 Codex Worker 能力探针。
   *
   * Capsule 提取要派发只读 Utility Worker，因此新派发之前必须知道本机能不能运行受限命令。测试注入
   * 固定结论；生产用真实受限命令探针。
   */
  readonly readOnlyWorkerProbe: ReadOnlyWorkerProbe;
  /**
   * 协调写入者。Capsule 提取要派发受限 Utility Worker，而派发是受 Intent 保护的 mutation，因此需要
   * 可信身份；缺失时不派发（fail closed），其余 Recovery 事实仍照常装配。
   */
  readonly writer?: CoordinationWriter | undefined;
  readonly env: Readonly<Record<string, string>>;
  readonly clock: () => number;
  /** SessionStart 报告的等待窗口。 */
  readonly bindingWindowMs: number;
};

/** 生产读取的窄形状校验：只接受解析器给出的结果，不从原始 JSON 猜字段。 */
function isWorktreeList(value: unknown): value is WorktreeListResult {
  return typeof value === 'object' && value !== null && 'worktrees' in value;
}

/**
 * 装配 Worker Session Recovery 的生产事实。
 *
 * 每一项都来自权威读取：隔离 worktree 与 Git 事实来自 Orca + Git，原会话终态来自 `worker-show` 与
 * 已结算的 Delivery，存活来自 `worker-list`/`terminal-list` 的列举，绑定来自精确 transcript 的
 * `session_meta`，替代派发走既有 Codex prepared-terminal 策略 + `worker-start` 回执。读不到时返回
 * 结构化 `unavailable`：调用方据此保持未决，绝不把「没读到」当成「已退出」或「已恢复」。
 *
 * 两处**没有生产事实来源**的地方如实阻塞而不是编造：
 * - Recovery Capsule 的正文只能由受限 Utility Worker 经 Delivery 回到应用层，而 Delivery 的结算与
 *   确认归 IC-08 唯一 pipeline；本模块因此不改写该路径，缺 Capsule 的角色以 `transcript_unavailable`
 *   阻塞（spec `recovery/worker-sessions` 的 Scenario「transcript 不可用」）。
 * - 精确续接既有 provider session 需要 Codex 侧 resume 路径（当前未验证），因此只给出 `unverifiable`：
 *   原会话仍存活时保持未决，不重复派发。
 */
export function createExecutionRecoveryFacts(input: ExecutionRecoveryFactsInput): StartupRecoveryFacts {
  const scopeId = input.coordinationScopeId;
  const unavailable = (code: string, message: string): RecoveryFactUnavailable => ({ kind: 'unavailable', code, message });

  const segmentsOf = (): readonly SessionSegmentRecord[] | null => {
    const read = input.store().query({ kind: 'session-segments', coordinationScopeId: scopeId });
    return read.kind === 'session-segments' ? read.segments : null;
  };

  const bindingsOf = (): readonly MaterializationBindingRecord[] | null => {
    const read = input.store().query({ kind: 'materialization-bindings', coordinationScopeId: scopeId });
    return read.kind === 'materialization-bindings' ? read.bindings : null;
  };

  const bindingFor = (subject: RecoveryFactSubject): MaterializationBindingRecord | null =>
    bindingsOf()?.find(
      (entry) =>
        entry.identity === 'issued' &&
        entry.workPackageId === subject.workPackageId &&
        entry.role === subject.role &&
        entry.attemptId === subject.businessAttemptId,
    ) ?? null;

  const sourceSegmentOf = (subject: RecoveryFactSubject): SessionSegmentRecord | null =>
    segmentsOf()?.find((entry) => entry.segmentId === subject.sourceSegmentId) ?? null;

  /** 该 Work Package 的隔离 worktree；未列举完整或不存在时给出可区分的原因。 */
  const readIsolatedWorktree = async (
    workPackageId: WorkPackageId,
  ): Promise<
    { readonly kind: 'read'; readonly worktreeId: string; readonly path: string } | ExecutionFactUnavailable
  > => {
    const listed = await input.backend.query({
      operation: 'worktree-list',
      repo: `path:${input.canonicalWorktree}`,
      limit: 1_000,
    });
    if (listed.kind !== 'accepted' || !isWorktreeList(listed.value)) {
      return unavailable(
        'worktree_list_unreadable',
        listed.kind === 'accepted'
          ? 'worktree-list 的结果不是登记的载荷形状'
          : `worktree-list 不可读：${listed.code} ${listed.message}`,
      );
    }
    const value = listed.value;
    if (value.truncated || value.hostScope === null || value.hostScope.omittedHostIds.length > 0) {
      return unavailable('worktree_scope_unverifiable', 'worktree 列举不完整：无法确认该 Work Package 的隔离工作区');
    }
    const match = value.worktrees.find((entry) => entry.comment === workPackageComment(workPackageId));
    if (match === undefined) {
      return unavailable('worktree_not_found', `没有可定位的隔离 worktree（归属注释 ${workPackageComment(workPackageId)}）`);
    }
    return { kind: 'read', worktreeId: match.worktreeId, path: match.path };
  };

  /** 主机范围的终端列举；不完整时如实报 `unavailable`，绝不读成「终端不存在」。 */
  const readHostObservation = async (): Promise<TerminalLivenessFacts['host']> => {
    const listed = await input.backend.query({ operation: 'terminal-list', limit: 1_000 });
    if (listed.kind !== 'accepted') {
      return { kind: 'unavailable', reason: `terminal-list 不可读：${listed.code} ${listed.message}` };
    }
    const value = listed.value as TerminalListResult;
    if (value.truncated || value.omittedHostIds.length > 0) {
      return { kind: 'unavailable', reason: '终端列举不完整：无法据此确认该终端是否仍存在' };
    }
    return { kind: 'enumerated', terminalHandles: value.terminals.map((terminal) => terminal.handle) };
  };

  /**
   * workspace 对账：worktree 身份来自物化绑定，HEAD 来自 Git。
   *
   * 三种结论严格区分——worktree 不存在是 `lost`，列举不完整或 Git 读不回来是 `unverifiable`。
   */
  const reconcileWorkspace = async (subject: RecoveryFactSubject): Promise<WorkspaceReconciliation | RecoveryFactUnavailable> => {
    const binding = bindingFor(subject);
    if (binding === null) {
      return unavailable(
        'materialization_binding_missing',
        `Work Package ${subject.workPackageId} 的 ${subject.role} 角色没有可核验的物化绑定`,
      );
    }
    const worktree = await readIsolatedWorktree(subject.workPackageId);
    if (worktree.kind === 'unavailable') {
      // 隔离 worktree 确实不存在，与「列举无法证明它存在」是两件事：只有前者能读成工作区已丢失。
      return worktree.code === 'worktree_not_found'
        ? { kind: 'lost', reason: worktree.message }
        : { kind: 'unverifiable', reason: worktree.message };
    }
    if (binding.worktreeId === null || binding.worktreeId !== worktree.worktreeId) {
      return { kind: 'unverifiable', reason: '实时 worktree 与物化绑定不一致或旧绑定缺少身份' };
    }
    const observed = await readWorkspaceFacts({ worktreePath: worktree.path, env: input.env });
    if (observed.kind !== 'observed') {
      return { kind: 'unverifiable', reason: `无法读取 ${worktree.path} 的 Git 事实：${observed.reason}` };
    }
    return { kind: 'reconciled', worktreeId: worktree.worktreeId, head: observed.facts.head };
  };

  return {
    observationFor: async (recovery) => {
      const segment = sourceSegmentOf(recovery);
      if (segment === null) {
        return unavailable('source_segment_missing', `找不到中断 Session Segment ${recovery.sourceSegmentId}`);
      }
      if (!segment.transcriptReferenceable || segment.lastTranscriptRef === null) {
        return unavailable('transcript_unreferenced', '中断 Session 的 transcript 已无法引用：无法重新证明该会话的身份');
      }
      const worktree = await readIsolatedWorktree(recovery.workPackageId);
      if (worktree.kind === 'unavailable') {
        return worktree;
      }
      const identity = readCodexTranscriptIdentity({
        transcriptRef: segment.lastTranscriptRef,
        workspace: worktree.path,
      });
      if ('kind' in identity) {
        return unavailable('binding_observation_unreadable', identity.reason);
      }
      // 观察值由「哪个 Dispatch」与当次读到的 provider session 身份派生；与记录不一致时由
      // `verifyExactSessionBinding` 判 mismatch，这里不替它做匹配。
      return {
        sessionBindingId: sessionBindingIdOf(segment.dispatchId, identity.providerSessionId),
        providerSessionId: identity.providerSessionId,
        identityChanged: false,
      };
    },

    livenessFor: async (recovery) => {
      const execution = input.execution;
      if (execution === null) {
        return unavailable('execution_context_unreadable', '当前图的 Run 不可读：无法列举该 Dispatch 的 Worker');
      }
      const listed = await input.backend.query({ operation: 'worker-list', runId: execution.runId });
      if (listed.kind !== 'accepted') {
        return unavailable('worker_list_unreadable', `worker-list 不可读：${listed.code} ${listed.message}`);
      }
      const workers = (listed.value as WorkerListResult).workers;
      const entry = workers.find((worker) => worker.dispatchId === recovery.sourceDispatchId) ?? null;
      return {
        dispatchId: recovery.sourceDispatchId,
        workerRunning: entry !== null && workerStateLiveness(entry.workerState) === 'live',
        terminalHandle: entry?.agentTerminalHandle ?? null,
        host: await readHostObservation(),
      };
    },

    // 精确续接需要 provider 侧 resume 路径（Codex 当前未验证）：只报 `unverifiable`，保持未决。
    resumeExact: () =>
      Promise.resolve({
        kind: 'unverifiable',
        reason: 'Worker Harness Adapter 没有可核验的 provider session 续接路径：保持未决，不重复派发也不伪称已续接',
      }),

    workspaceFor: (recovery) => reconcileWorkspace(recovery),

    sourceTerminalFor: async (recovery) => {
      const shown = await input.backend.query({ operation: 'worker-show', dispatchId: recovery.sourceDispatchId });
      if (shown.kind !== 'accepted') {
        return { kind: 'unverifiable', reason: `worker-show 不可读：${shown.code} ${shown.message}` };
      }
      const view = shown.value as WorkerShowResult;
      const liveness = workerStateLiveness(view.workerState);
      if (liveness === 'live') {
        return { kind: 'not_reached' };
      }
      if (liveness === 'unverifiable') {
        return {
          kind: 'unverifiable',
          reason: `worker-show 报告的 worker.state 未登记（${view.workerState ?? 'null'}）`,
        };
      }
      // 已退出不等于「到达有效终态」：只有已结算的 Orca 结果才是可核验的终态收据。
      const settlements = input.store().query({ kind: 'delivery-settlements', coordinationScopeId: scopeId });
      const settlement = settlements.kind === 'delivery-settlements'
        ? settlements.settlements.find((entry) => entry.dispatchId === recovery.sourceDispatchId)
        : undefined;
      return settlement === undefined
        ? { kind: 'not_reached' }
        : { kind: 'reached', terminalReceiptRef: `orca-result:${settlement.orcaResultRef}` };
    },

    roleGateFor: async (recovery) => {
      switch (recovery.role) {
        case 'planner': {
          const binding = bindingFor(recovery);
          if (binding === null || binding.specificationUnitPath === null) {
            return unavailable(
              'specification_target_unreadable',
              'Planner 的固定规格目标路径不可读：没有可接续的确定性契约',
            );
          }
          const worktree = await readIsolatedWorktree(recovery.workPackageId);
          if (worktree.kind === 'unavailable') {
            return worktree;
          }
          const unitPath = join(worktree.path, binding.specificationUnitPath);
          // 隐藏决定没有权威生产来源：唯一能证明的是「规格单元已落盘」，其余由接续的 Session 自己读回。
          return {
            role: 'planner',
            planner: { specificationUnitLanded: existsSync(unitPath) && statSync(unitPath).size > 0, hiddenDecisions: [] },
          };
        }
        case 'implementation': {
          const workspace = await reconcileWorkspace(recovery);
          const reconciled = !('kind' in workspace) ? false : workspace.kind === 'reconciled';
          const intents = input.store().query({ kind: 'intents', coordinationScopeId: scopeId });
          // 未决/已阻塞的派发意图就是「外部副作用未知」的事实来源：它们对应的 mutation 没有确定结论。
          const unknown = intents.kind === 'intents'
            ? intents.intents
                .filter(
                  (intent) =>
                    intent.target.kind === 'worker-task' &&
                    intent.target.id === recovery.workerTaskId &&
                    intent.state !== 'settled',
                )
                .map((intent) => intent.operationId)
            : [`intent:${recovery.workerTaskId}:unreadable`];
          return {
            role: 'implementation',
            implementation: {
              workspaceReconciled: reconciled,
              headReconciled: reconciled,
              dirtyPathsReconciled: reconciled,
              unknownExternalEffects: [...unknown],
            },
          };
        }
        case 'validator':
          // 接续的 Validator 自己重新验证：此刻没有已识别的缺口，也没有因缺口失效的证据。
          return { role: 'validator', validator: { identifiedGaps: [], invalidatedEvidenceIds: [], reverifiedEvidenceIds: [] } };
        case 'finalizer': {
          const execution = input.execution;
          return execution === null
            ? unavailable('execution_context_unreadable', '当前图的 Run / 授权不可读：没有可重跑只读检查的权威输入')
            : {
                role: 'finalizer',
                finalizer: {
                  authoritativeInputs: [
                    `authorization:${execution.authorizationId}`,
                    `run:${execution.runId}`,
                    `graph-generation:${String(execution.graphGeneration)}`,
                  ],
                },
              };
        }
      }
    },

    extractCapsule: async (request) => {
      const evidence = await inspectCodexTranscript(request.transcriptRef);
      if (evidence.kind !== 'covered') {
        // transcript 读不到是确定性结论：重派读的还是同一份，因此直接上报，不在这里重试。
        return { kind: 'transcript_unavailable', reason: evidence.reason };
      }
      if (input.writer === undefined) {
        return { kind: 'failed', reason: '协调写入者不可读：无法派发受限 Utility Worker' };
      }
      if (input.workerHarness !== 'codex') {
        return {
          kind: 'failed',
          reason: `Worker Profile 的 harness 为 ${input.workerHarness ?? '未配置'}，本进程只能派发 codex Utility Worker`,
        };
      }
      const operationIds = capsuleOperationIdsOf(request.segmentId);
      const pinned = bindingsOf()?.find((entry) => entry.creationOperationId === operationIds.task) ?? null;
      const authorizationRead = pinned === null
        ? activeAuthorization(input.store(), scopeId)
        : input.store().query({ kind: 'authorization', coordinationScopeId: scopeId, authorizationId: pinned.authorizationId ?? '' });
      const authorization = authorizationRead.kind === 'read'
        ? authorizationRead.authorization
        : authorizationRead.kind === 'authorization'
          ? authorizationRead.authorization
          : null;
      const profile = authorization?.manifest.recoveryUtilityProfile ?? null;
      const modelConfiguration = profile?.modelConfiguration ?? null;
      if (modelConfiguration === null || profile === null || authorization === null ||
          (pinned !== null && (pinned.workerProfileRef?.id !== profile.profileRef.id ||
            pinned.authorizationVersion !== authorization.authorizationVersion))) {
        return { kind: 'failed', reason: 'Recovery Utility 缺少可核验模型授权绑定' };
      }
      if (input.companionStateRoot === null) {
        return { kind: 'failed', reason: '无法定位 Companion 私有的状态根：Utility Worker 的 SessionStart 不可证' };
      }
      const execution = input.execution;
      if (execution === null) {
        return { kind: 'failed', reason: '当前图的 Run / 授权 / 后端身份不可读：无法派发 Capsule Utility Worker' };
      }
      if (authorization.manifest.orcaRunId !== execution.runId ||
          authorization.manifest.graph.generation !== execution.graphGeneration) {
        return { kind: 'failed', reason: 'Recovery Utility 的模型授权不属于当前 Run 或 Graph Generation' };
      }
      const worktree = await readIsolatedWorktree(request.workPackageId as WorkPackageId);
      if (worktree.kind === 'unavailable') {
        return { kind: 'failed', reason: `无法定位 Capsule Utility Worker 的隔离 worktree：${worktree.message}` };
      }

      const launchId = capsuleLaunchIdOf(request.segmentId);
      const paths = codexSessionPathsUnder(input.companionStateRoot, launchId);
      const envelope = buildUtilityWorkerEnvelope({
        workPackageId: request.workPackageId,
        sourceWorkerTaskId: request.workerTaskId,
        sourceSegmentId: request.segmentId,
        transcriptRef: request.transcriptRef,
      });
      // 已有派发或既有意图都按原身份对账：只有确认这次会是全新派发时，能力缺失才允许阻断它。
      const priorDispatch = await findDispatchedUtilityWorker({
        backend: input.backend,
        backendIdentityRef: execution.backendIdentityRef,
        runId: execution.runId,
        envelope,
      });
      if (priorDispatch !== null && (pinned === null || pinned.orcaTaskId !== priorDispatch.orcaTaskId)) {
        return { kind: 'failed', reason: '已有 Recovery Utility Task 缺少可核验的原模型绑定' };
      }
      if (priorDispatch === null && !capsuleIntentExists(input.store(), scopeId, operationIds)) {
        const readOnlyBlocker = readOnlyWorkerUnavailableReason(await input.readOnlyWorkerProbe(modelConfiguration));
        if (readOnlyBlocker !== null) {
          // 不进入报告等待、不建 Task/Dispatch、不消耗 Recovery 预算：只留下可诊断的能力 blocker。
          return { kind: 'failed', reason: readOnlyBlocker };
        }
      }
      installCodexSessionStartReporter(paths);
      const expectedCodexHome = join(paths.stateRoot, createHash('sha256').update(launchId).digest('hex').slice(0, 20));
      const dispatchStartedAt = new Date(input.clock()).toISOString();
      const dispatch = await dispatchCapsuleWorker({
        store: input.store(),
        backend: input.backend,
        writer: input.writer,
        coordinationScopeId: scopeId,
        envelope,
        execution: { ...execution, authorizationId: authorization.authorizationId },
        onTaskCreated: (orcaTaskId) => {
          const scope = input.store().query({ kind: 'scope', coordinationScopeId: scopeId });
          if (scope.kind !== 'scope' || scope.scope === null) return { code: 'scope_unreadable', message: '无法读取 Utility Task 的 Scope' };
          const recorded = input.store().transact({
            kind: 'record-materialization-binding', coordinationScopeId: scopeId,
            expectedRevision: scope.scope.revision, writer: input.writer!,
            workPackageId: request.workPackageId as WorkPackageId, role: null, recoveryUtilityRole: 'recovery_utility',
            workerTaskId: operationIds.task as unknown as WorkerTaskId,
            dispatchId: operationIds.workerStart as unknown as DispatchId, attemptId: operationIds.task,
            worktreeId: worktree.worktreeId, specBinding: null, specificationUnitPath: null,
            authorizationId: authorization.authorizationId, authorizationVersion: authorization.authorizationVersion,
            workerProfileRef: profile.profileRef.id, orcaTaskId, launchId, creationOperationId: operationIds.task,
          });
          return recorded.kind === 'rejected' ? { code: recorded.code, message: recorded.message } : null;
        },
        workerLaunch: createCodexWorkerLaunch({
          launchId,
          modelConfiguration,
          // 与宿主其余派发同源：managed 凭据在准备阶段就要用同一份 env-derived store 证明存在。
          credentialStore: credentialStore(input.env),
          credentialStorePath: credentialStorePath({ environment: input.env }),
          // Capsule 提取只读 transcript：权限是共享的 `read-only-local-control` profile（继承
          // `:read-only`，只为本机控制通道开启网络），信封 `authority.write=false`。
          sandboxMode: 'read-only-local-control',
          stateRoot: paths.stateRoot,
          sessionStartReporterPath: paths.reporterPath,
        }),
        worktree: `path:${worktree.path}`,
        operationIds,
        observeSession: async ({ dispatchId }) => {
          const deadline = input.clock() + input.bindingWindowMs;
          const maxAttempts = Math.max(1, Math.ceil(input.bindingWindowMs / 250) + 1);
          for (let attempt = 1; ; attempt += 1) {
            if (existsSync(paths.reportPath)) {
              for (const line of readFileSync(paths.reportPath, 'utf8').split('\n')) {
                if (line.length === 0) {
                  continue;
                }
                let report: CodexSessionStartReport;
                try {
                  report = JSON.parse(line) as CodexSessionStartReport;
                } catch {
                  continue;
                }
                if (report.cwd !== worktree.path) {
                  continue;
                }
                const bound = bindCodexSessionFromStartReport({
                  facts: {
                    harness: 'codex',
                    role: request.role,
                    workerTaskId: request.workerTaskId,
                    dispatchId: dispatchId as DispatchId,
                    attemptId: request.attemptId,
                  },
                  report,
                  workspace: worktree.path,
                  expectedCodexHome,
                  dispatchStartedAt,
                  bindingDeadlineAt: new Date(input.clock()).toISOString(),
                });
                if (bound.kind !== 'bound') {
                  continue;
                }
                return {
                  harness: bound.binding.harness,
                  role: bound.binding.role,
                  workerTaskId: bound.binding.workerTaskId,
                  dispatchId: bound.binding.dispatchId,
                  attemptId: bound.binding.attemptId,
                  providerSessionId: bound.binding.providerSessionId,
                  transcriptRef: bound.binding.transcriptRef,
                  observedAt: bound.binding.observedAt,
                };
              }
            }
            if (attempt >= maxAttempts || input.clock() >= deadline) {
              return null;
            }
            await delay(250);
          }
        },
        evidence: evidence.evidence,
        reportTimeoutMs: CAPSULE_REPORT_TIMEOUT_MS,
      });
      if (dispatch.kind !== 'extracted') {
        return { kind: 'failed', reason: dispatch.reason };
      }

      // 正文先落 Companion 私有状态根、回读确认，再确认它的 Delivery：顺序与 Delivery 处理一致。
      const capsuleRef = capsuleRefOf(deriveRecoveryId(scopeId, request.segmentId));
      const written = writeRecoveryCapsuleBody({
        stateRoot: input.companionStateRoot,
        capsuleRef,
        capsule: dispatch.capsule,
      });
      if (!written.ok) {
        return { kind: 'failed', reason: written.reason };
      }
      if (readRecoveryCapsuleBody({ stateRoot: input.companionStateRoot, capsuleRef }) === null) {
        return { kind: 'failed', reason: `Recovery Capsule 正文回读失败：${written.path}` };
      }
      if (dispatch.delivery !== null) {
        const acked = await ackConsumedDelivery({
          store: input.store(),
          backend: input.backend,
          writer: input.writer,
          coordinationScopeId: scopeId,
          backendIdentityRef: execution.backendIdentityRef,
          graphGeneration: execution.graphGeneration,
          authorizationId: execution.authorizationId,
          runId: execution.runId,
          consumerGeneration: execution.consumerGeneration,
          timeoutMs: execution.timeoutMs,
          deliveryId: dispatch.delivery.deliveryId,
          deliveryRunId: dispatch.delivery.runId,
        });
        // 确认失败不丢弃已生成并落盘的 Capsule：lane 阻塞会在投影里可见，重放会按同一 OperationId 续办。
        void acked;
      }
      return { kind: 'extracted', capsule: dispatch.capsule };
    },

    execution:
      input.execution ??
      unavailable('execution_context_unreadable', '当前图的 Run / 授权 / 后端身份不可读：没有可核验的执行上下文'),

    replacementFor: (recovery) => {
      if (input.workerHarness !== 'codex') {
        return unavailable(
          'worker_harness_unsupported',
          `Worker Profile 的 harness 为 ${input.workerHarness ?? '未配置'}，本进程只能派发 codex 替代 Session`,
        );
      }
      const modelConfiguration = input.resolveModelConfiguration(recovery, 'replacement');
      const originalProfileRef = bindingFor(recovery)?.workerProfileRef?.id;
      if (modelConfiguration === null || originalProfileRef === undefined) {
        return unavailable('worker_model_unresolved', '替代 Session 缺少原任务模型授权绑定');
      }
      if (input.codexSandbox === null) {
        return unavailable(
          'codex_sandbox_risk_not_accepted',
          '当前 Codex 沙箱模式未被 acceptedRisks 接受：不派发一个沙箱策略未经授权的替代 Session',
        );
      }
      if (input.companionStateRoot === null) {
        return unavailable('state_root_unavailable', '无法定位 Companion 私有的状态根：替代 Session 的 SessionStart 不可证');
      }
      const launchId = recoveryLaunchIdOf(recovery.recoveryId);
      const paths = codexSessionPathsUnder(input.companionStateRoot, launchId);
      installCodexSessionStartReporter(paths);
      const expectedCodexHome = join(paths.stateRoot, createHash('sha256').update(launchId).digest('hex').slice(0, 20));
      const dispatchStartedAt = new Date(input.clock()).toISOString();
      return {
        profile: { kind: 'reuse', profileRef: originalProfileRef },
        workerLaunch: createCodexWorkerLaunch({
          launchId,
          modelConfiguration,
          // 替代 Session 沿用原 Task 的模型绑定，凭据 store 仍按本次输入的 env 解析。
          credentialStore: credentialStore(input.env),
          credentialStorePath: credentialStorePath({ environment: input.env }),
          sandboxMode: input.codexSandbox,
          stateRoot: paths.stateRoot,
          sessionStartReporterPath: paths.reporterPath,
        }),
        interpretReceipt: async (outcome) => {
          const receipt = outcome.value as WorkerStartReceipt;
          const dispatchId = receipt.dispatchId;
          if (typeof dispatchId !== 'string' || dispatchId.length === 0) {
            return { failure: '替代派发回执缺少可核验的 Dispatch 身份' };
          }
          const worktree = await readIsolatedWorktree(recovery.workPackageId);
          if (worktree.kind === 'unavailable') {
            return { failure: `无法定位替代 Session 的隔离 worktree：${worktree.message}` };
          }
          const deadline = input.clock() + input.bindingWindowMs;
          // 窗口同时用「轮次」表达：注入的 clock 可能是固定值，只靠它判断会让等待永不结束。
          const maxAttempts = Math.max(1, Math.ceil(input.bindingWindowMs / 250) + 1);
          for (let attempt = 1; ; attempt += 1) {
            if (existsSync(paths.reportPath)) {
              for (const line of readFileSync(paths.reportPath, 'utf8').split('\n')) {
                if (line.length === 0) {
                  continue;
                }
                let report: CodexSessionStartReport;
                try {
                  report = JSON.parse(line) as CodexSessionStartReport;
                } catch {
                  continue;
                }
                const bound = bindCodexSessionFromStartReport({
                  facts: {
                    harness: 'codex',
                    role: recovery.role,
                    workerTaskId: recovery.workerTaskId,
                    dispatchId: dispatchId as DispatchId,
                    attemptId: recovery.businessAttemptId,
                  },
                  report,
                  workspace: worktree.path,
                  expectedCodexHome,
                  dispatchStartedAt,
                  bindingDeadlineAt: new Date(input.clock()).toISOString(),
                });
                if (bound.kind === 'bound') {
                  return {
                    dispatchId,
                    sessionBindingId: sessionBindingIdOf(dispatchId, bound.binding.providerSessionId),
                    transcriptRef: bound.binding.transcriptRef,
                  };
                }
              }
            }
            if (attempt >= maxAttempts || input.clock() >= deadline) {
              return { failure: '替代 Session 的 SessionStart 报告不可达或 transcript 无法精确绑定' };
            }
            await delay(250);
          }
        },
      };
    },
  };
}

function delay(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}
