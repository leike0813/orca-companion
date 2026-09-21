/**
 * IP-12 / D1：一个 Runtime Incarnation 的启动衔接顺序
 * （Owner: `m1-recover-execution`）。
 *
 * 生产代码已经分别落在 IP-1（对账）、IP-3（lane 阻塞）、IP-4（Delivery 重放）、IP-5..IP-8
 * （Worker Session Recovery）与 IP-9（Scope 控制）里。本模块的职责只有一件：**按固定顺序装配它们**，
 * 不重新实现任何规则，也不新增第二套读取、去重、ack、状态集合或结果类型。
 *
 * 固定顺序（implementation-plan 第 4 节；每一步的失败都是显式结果，不静默跳过）：
 *
 * 1. 加载配置与 Scope、取得 Runtime Lease：整体交给 `startCoordinatorRuntime`，它内部已完成模型解析、
 *    能力核验、checkpoint store、Runtime Lease/fencing 与「读回未决 intent」。本模块不复制其中任何一步。
 * 2. 启动对账：`reconcileOperations` 以**原 OperationId** 逐个得出已接受 / 已拒绝 / 未决三值结论。
 * 3. lane 投影：读取 IC-03 的 `CoordinationSnapshot.mutationLanes`，把未决 lane 呈现为可观测的 blocker。
 *    阻塞是 **lane 粒度**：其它 lane 的读写与只读查询不经过这里，也不受影响。
 * 4. Delivery 重放：把未确认 Delivery 交给前驱唯一 pipeline `replayDeliveries`（内部只调用
 *    `settleDelivery`）；unknown 时保持未确认并按原 OperationId 阻塞对应 lane。
 * 5. 续办未完成的 Recovery：对 snapshot 中未终结（`pending` / `recovering` / `blocked`）的
 *    `RecoveryRecord` 逐条以**同一 RecoveryId** 续办 `recoverWorkerSession`，不新建 Recovery、不重置预算。
 *    单条失败只阻塞它自己的派发 lane 并进入 blocker 集合，不拒绝整次启动。
 * 6. Resume / Exit：把 `ScopeReconciliationRunner` 接到 `scope-control-service`，于是 Resume 天然
 *    「先对账再恢复调度」；Exit 只给出结束进程的判决，**不写任何控制状态**（IP-9 的 bootstrap 退出路径）。
 * 7. 允许派发：放行判定由 `evaluateStartupReadiness` 给出，复用 `scopeControlGate` / `mayDispatch` /
 *    `mayResumeModel`。派发是 lane 粒度的（`mayUseLane(laneKey)`：控制状态放行 + 启动序列已完成 +
 *    该 lane 未被阻塞）；模型恢复只看控制状态与启动序列，不受单条 lane 阻塞影响。不提供「零阻塞 lane」
 *    的聚合布尔，避免退化成全局锁。
 *
 * 环境事实（Orca `worker-show` / transcript / Git / 已批准 Manifest）不由本模块凭空构造：Recovery 与
 * Delivery 的读取都通过下面两个窄 provider 接口注入，真实装配与测试各自提供。
 */

import type { ControlState } from '../domain/coordination/mode.js';
import { isLaneBlocked, type MutationLaneRecord } from '../domain/coordination/mutation-lane.js';
import {
  mayDispatch,
  mayResumeModel,
  scopeControlGate,
  type ScopeControlGate,
} from '../domain/coordination/scope-control.js';
import type { RecoveryBindingObservation } from '../domain/recovery/worker-session-recovery.js';
import type { RoleGateFacts } from '../domain/recovery/role-gate.js';
import type { ProvenNoSideEffect } from '../domain/recovery/operation-intent.js';
import type { TerminalLivenessFacts } from '../domain/worker-liveness.js';
import { writerFor } from '../application/coordinator/runtime-guard.js';
import type { CoordinationScopeId, RecoveryId } from '../application/dto/identity.js';
import { laneKeyOf } from '../application/dto/operation-intent.js';
import type { SettleDeliveryInput, SettleDeliveryResult } from '../application/delivery/process-delivery.js';
import {
  createScopeControlService,
  type ScopeControlService,
  type ScopeExitResult,
  type ScopeReconciliationRunner,
  type WorkerStopPort,
} from '../application/coordination/scope-control-service.js';
import { readScope } from '../application/planning/scope-read.js';
import type {
  BranchCoordinationStore,
  CoordinationSnapshot,
  CoordinationWriter,
  RecoveryRecord,
  RecoveryState,
} from '../application/ports/branch-coordination-store.js';
import type { ExecutionBackend } from '../application/ports/execution-backend.js';
import { currentScopeRevision } from '../application/reconciliation/lane-write.js';
import {
  reconcileOperations,
  type ReconcileOperationsResult,
} from '../application/reconciliation/reconcile-operations.js';
import {
  replayDeliveries,
  type PendingDelivery,
  type ReplayDeliveriesResult,
} from '../application/reconciliation/replay-deliveries.js';
import type { RecoveryCapsuleExtractor } from '../application/recovery/recovery-capsule.js';
import {
  recoverWorkerSession,
  type ExactRecoveryAttempt,
  type RecoverWorkerSessionResult,
  type RecoveryExecutionContext,
  type ReplacementDispatch,
  type SourceTerminalObservation,
  type WorkspaceReconciliation,
} from '../application/recovery/worker-session-recovery-service.js';
import {
  startCoordinatorRuntime,
  type StartCoordinatorRuntimeOptions,
  type StartedCoordinatorRuntime,
} from './coordinator-runtime.js';

/* -------------------------------------------------------------------------- */
/* 启动步骤与观察者                                                            */
/* -------------------------------------------------------------------------- */

/**
 * 启动顺序的固定步骤。
 *
 * 顺序本身是合同：对账（步骤 2）与续办（步骤 5）都完成之前不得派发或恢复模型，而「完成」只能由
 * `readiness_evaluated` 之后返回的放行判决表示。观察者只记录步骤到达顺序，不暴露内部实现细节。
 */
export const STARTUP_STEPS = [
  'runtime_started',
  'operations_reconciled',
  'lanes_projected',
  'deliveries_replayed',
  'recoveries_continued',
  'scope_control_wired',
  'readiness_evaluated',
] as const;

export type StartupStep = (typeof STARTUP_STEPS)[number];

export type StartupObserver = {
  readonly onStep: (step: StartupStep) => void;
};

/* -------------------------------------------------------------------------- */
/* 注入的环境事实 seam                                                         */
/* -------------------------------------------------------------------------- */

/**
 * 未确认 Delivery 的读取结果。
 *
 * 读取本身（Orca `delivery-read` 加身份/代际核验）发生在真实装配里；这里只接收已核验的
 * `PendingDelivery` 或一个显式拒绝，不用空数组冒充「没有读取到」。
 */
export type PendingDeliveryRead =
  | { readonly kind: 'read'; readonly pending: readonly PendingDelivery[] }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

/** Delivery 重放需要的执行事实；全部来自已批准 Manifest、当前图与 Orca Run。 */
export type StartupDeliveryFacts = {
  readonly backendIdentityRef: string;
  readonly graphGeneration: number;
  readonly authorizationId: string;
  readonly runId: string;
  readonly consumerGeneration: number;
  readonly timeoutMs: number;
  /** 未确认 Delivery 的读取 seam；真实装配走 Orca，测试注入 fake。 */
  readonly readPending: () => Promise<PendingDeliveryRead>;
  /** 前驱唯一 pipeline 的覆盖点：仅用于测试计数与故障注入，生产不得替换结算路径。 */
  readonly settle?: (input: SettleDeliveryInput) => Promise<SettleDeliveryResult>;
};

/**
 * 续办一条 Recovery 所需的环境事实。
 *
 * `RecoverWorkerSessionInput` 里除了业务身份（全部来自 `RecoveryRecord`）之外，还有一批只能从
 * Orca `worker-show` / `worker-read`、Git 状态、已批准 Manifest 与 Worker Harness Adapter 得到的事实。
 * 本模块不构造它们，也不伪造 Orca 身份，因此把它们表达为这个窄 provider：按 `RecoveryRecord` 逐项返回。
 */
export type StartupRecoveryFacts = {
  /** 当前观察到的 harness 绑定；缺字段即无法证明归属。 */
  readonly observationFor: (recovery: RecoveryRecord) => RecoveryBindingObservation;
  /** 复用 IC-07 的三值存活事实。 */
  readonly livenessFor: (recovery: RecoveryRecord) => TerminalLivenessFacts;
  /** 精确恢复原会话的执行 seam。 */
  readonly resumeExact: ExactRecoveryAttempt;
  readonly workspaceFor: (recovery: RecoveryRecord) => WorkspaceReconciliation;
  readonly sourceTerminalFor: (recovery: RecoveryRecord) => SourceTerminalObservation;
  readonly roleGateFor: (recovery: RecoveryRecord) => RoleGateFacts;
  readonly extractCapsule: RecoveryCapsuleExtractor;
  readonly execution: RecoveryExecutionContext;
  readonly replacementFor: (recovery: RecoveryRecord) => ReplacementDispatch;
};

/* -------------------------------------------------------------------------- */
/* 放行判定                                                                    */
/* -------------------------------------------------------------------------- */

/** 未终结的 Recovery 状态；这些记录必须在本 Incarnation 内以同一 RecoveryId 续办。 */
export const NON_TERMINAL_RECOVERY_STATES = ['pending', 'recovering', 'blocked'] as const;

export function isNonTerminalRecoveryStatus(status: RecoveryState): boolean {
  return (NON_TERMINAL_RECOVERY_STATES as readonly RecoveryState[]).includes(status);
}

export type StartupReadinessInput = {
  readonly controlState: ControlState;
  /** 当前未决 lane 的投影；空数组表示没有任何 lane 阻塞。 */
  readonly lanes: readonly MutationLaneRecord[];
  /**
   * 启动**序列**（对账 → 投影 → 重放 → 续办）是否已经跑完。
   *
   * 这是全局**顺序**门，只回答「前置序列是否都已执行过」，不回答「某条 Recovery 是否成功」——
   * 单条 Recovery 的失败由 `additionalBlockedLaneKeys` 落到对应 lane 上，不升级成全体停摆。
   */
  readonly startupSequenceCompleted: boolean;
  /**
   * lane 级附加阻塞（例如某条 Recovery 续办失败或保持未决）。
   *
   * 与 `lanes` 一样只影响列出的 lane；未列出的 lane 不受影响。
   */
  readonly additionalBlockedLaneKeys?: readonly string[];
};

/**
 * 「允许派发 / 允许恢复模型」的最终判定。
 *
 * 派发是 **lane 粒度**的：唯一入口是 `mayUseLane(laneKey)`，语义为「控制状态放行 **且** 启动序列已完成
 * **且** 该 lane 未被阻塞」。一条 lane 阻塞不会阻止其它已确定 lane 的读写（spec
 * `recovery/controller-reconciliation` 的 MUST NOT，design D3）。
 *
 * 这里刻意**不提供**「面向全部 lane 的聚合派发布尔」：任一 lane 阻塞就停掉整个 Scope 会退化成全局锁，
 * 与 plan §4 第 7 步的「无阻塞项影响**所需 lane**」不符。调用方要判断能否派发，只能带 laneKey 调
 * `mayUseLane`。
 *
 * `mayResumeModel` 不是某条 lane 的写操作，因此**不**依赖 lane 阻塞：它只要求控制状态放行且启动序列
 * 已完成。工具调用是否允许仍由每次调用的 lane 校验（`mayUseLane`）决定（`AGENTS.md` §5）。
 */
export type StartupDispatchReadiness = {
  readonly controlState: ControlState;
  readonly controlGate: ScopeControlGate;
  /** 所有阻塞 lane 的键（store 投影 ∪ 附加 lane 阻塞），仅供可观测与诊断。 */
  readonly blockedLaneKeys: readonly string[];
  readonly startupSequenceCompleted: boolean;
  /** 指定 lane 是否放行；这是派发路径应当使用的唯一判定。 */
  readonly mayUseLane: (laneKey: string) => boolean;
  /** 模型恢复门：控制状态放行且启动序列已完成；不受单条 lane 阻塞影响。 */
  readonly mayResumeModel: boolean;
};

export function evaluateStartupReadiness(input: StartupReadinessInput): StartupDispatchReadiness {
  const controlGate = scopeControlGate(input.controlState);
  const additional = new Set(input.additionalBlockedLaneKeys ?? []);
  const blockedLaneKeys = [
    ...new Set([...input.lanes.map((lane) => lane.laneKey), ...additional]),
  ].sort();
  return {
    controlState: input.controlState,
    controlGate,
    blockedLaneKeys,
    startupSequenceCompleted: input.startupSequenceCompleted,
    mayUseLane: (laneKey: string): boolean =>
      mayDispatch(input.controlState) &&
      input.startupSequenceCompleted &&
      !isLaneBlocked(input.lanes, laneKey) &&
      !additional.has(laneKey),
    mayResumeModel: mayResumeModel(input.controlState) && input.startupSequenceCompleted,
  };
}

/* -------------------------------------------------------------------------- */
/* 请求与结果                                                                  */
/* -------------------------------------------------------------------------- */

export type CompanionStartupRequest = {
  /** 步骤 1 的完整选项；`coordinationStore` 同时是本模块对 Scope 的读取入口。 */
  readonly runtime: StartCoordinatorRuntimeOptions;
  readonly backend: ExecutionBackend;
  readonly clock: () => number;
  readonly deliveries: StartupDeliveryFacts;
  readonly recovery: StartupRecoveryFacts;
  readonly workers: WorkerStopPort;
  /** 调用方已证实的「未产生副作用」事实，透传给对账与 Resume 的对账。 */
  readonly provenNoSideEffect?: readonly ProvenNoSideEffect[];
  readonly observer?: StartupObserver;
};

/** 观测到的启动阻塞来源；都不是全局锁，`laneKey` 指向受影响的那条 lane。 */
export const STARTUP_BLOCKER_SOURCES = ['mutation_lane', 'delivery', 'recovery'] as const;

export type StartupBlockerSource = (typeof STARTUP_BLOCKER_SOURCES)[number];

/**
 * 一条可观测的启动阻塞。
 *
 * 「不得静默跳过」在这里落地：任何没能收尾的 lane 或 Recovery 都必须以结构化 blocker 出现在启动结果里，
 * 而不是只写日志。`laneKey` 为 `null` 的记录不是 lane 级阻塞，调用方只能作为诊断信息展示。
 */
export type StartupBlocker = {
  readonly source: StartupBlockerSource;
  readonly code: string;
  readonly message: string;
  readonly laneKey: string | null;
  readonly recoveryId: RecoveryId | null;
};

/** 一次 Recovery 续办的结果；`previousStatus` 是续办前读到的持久状态。 */
export type RecoveryContinuation = {
  readonly recoveryId: RecoveryId;
  readonly previousStatus: RecoveryState;
  /** 该 Recovery 的替代派发 lane：失败或保持未决时据此阻塞对应 lane，而不是全局停摆。 */
  readonly dispatchLaneKey: string;
  readonly result: RecoverWorkerSessionResult;
};

export type StartedCompanionStartup = {
  readonly kind: 'started';
  /** 步骤 1 的产物：模型、incarnation、checkpoint store 与 fencing。 */
  readonly runtime: StartedCoordinatorRuntime;
  readonly writer: CoordinationWriter;
  /** 步骤 2：以原 OperationId 得出的三值结论与仍未决 lane。 */
  readonly reconciliation: Extract<ReconcileOperationsResult, { readonly kind: 'reconciled' }>;
  /** 步骤 3：未决 lane 的可观测投影。 */
  readonly lanes: readonly MutationLaneRecord[];
  /** 步骤 4：Delivery 重放结论。 */
  readonly deliveries: Extract<ReplayDeliveriesResult, { readonly kind: 'replayed' }>;
  /** 步骤 5：逐条续办的未完成 Recovery（含未能续办的那些，它们不会被静默跳过）。 */
  readonly recoveries: readonly RecoveryContinuation[];
  /** 全部可观测阻塞：lane 阻塞、未确认 Delivery、续办失败的 Recovery。 */
  readonly blockers: readonly StartupBlocker[];
  /** 续办后仍未终结的 Recovery。 */
  readonly unfinishedRecoveryIds: readonly RecoveryId[];
  /** 续办结论为 `rejected` / `unverifiable_hold` / `blocked` 的 Recovery：这些 Worker 不得重复派发。 */
  readonly dispatchHoldingRecoveryIds: readonly RecoveryId[];
  /** 步骤 7：允许派发 / 允许模型恢复的最终判定。 */
  readonly readiness: StartupDispatchReadiness;
  /** 步骤 6 接线后的 Scope 控制；`resume` 已内置「先对账」，`exit` 不写控制状态。 */
  readonly scopeControl: ScopeControlService;
  /** Exit 路径：结束进程并关闭会话库，绝不隐式 Pause/Cancel、不写控制状态。 */
  readonly endProcess: () => ScopeExitResult;
  readonly close: () => void;
};

export type StartupFailure = {
  readonly kind: 'rejected';
  readonly step: StartupStep;
  readonly code: string;
  readonly message: string;
};

export type CompanionStartupResult = StartedCompanionStartup | StartupFailure;

/* -------------------------------------------------------------------------- */
/* 编排                                                                        */
/* -------------------------------------------------------------------------- */

/** 步骤内失败：携带停在哪个步骤，由顶层翻成显式结果，不让异常穿透调用方。 */
class StartupAbort extends Error {
  readonly step: StartupStep;
  readonly code: string;

  constructor(step: StartupStep, code: string, message: string) {
    super(message);
    this.name = 'StartupAbort';
    this.step = step;
    this.code = code;
  }
}

function snapshotForStep(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
  step: StartupStep,
): CoordinationSnapshot {
  const result = store.query({ kind: 'snapshot', coordinationScopeId });
  if (result.kind === 'rejected') {
    throw new StartupAbort(step, result.code, result.message);
  }
  if (result.kind !== 'snapshot') {
    throw new StartupAbort(step, 'invalid_state', 'snapshot 查询返回了错误的结果种类');
  }
  return result.snapshot;
}

/**
 * 步骤 5：以同一 RecoveryId 续办全部未终结 Recovery。
 *
 * 业务身份全部取自持久化的 `RecoveryRecord`，所以续办命中的必然是 `recoverWorkerSession` 内部按
 * `sourceSegmentId` 派生出的同一条记录：不新建 Recovery，也不会因为重启重复消耗 Recovery Budget
 * （额度递增由该用例在创建替代 Segment 的同一事务里完成）。
 *
 * 单条 Recovery 的失败**不**拒绝整次启动：失败只针对这条 Recovery 与它的替代派发 lane，因此记录为
 * 可观测 blocker 并继续其余步骤；该 Recovery 也不被本模块写入终态（`recoverWorkerSession` 自己决定
 * 是否落盘它允许的状态）。只有整个对账序列无法完成才停止启动。
 */
async function continueRecoveries(input: {
  readonly store: BranchCoordinationStore;
  readonly backend: ExecutionBackend;
  readonly writer: CoordinationWriter;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly snapshot: CoordinationSnapshot;
  readonly facts: StartupRecoveryFacts;
}): Promise<readonly RecoveryContinuation[]> {
  const unfinished = input.snapshot.recoveries.filter((recovery) =>
    isNonTerminalRecoveryStatus(recovery.status),
  );
  const continued: RecoveryContinuation[] = [];
  for (const recovery of unfinished) {
    const result = await recoverWorkerSession({
      store: input.store,
      backend: input.backend,
      writer: input.writer,
      coordinationScopeId: input.coordinationScopeId,
      subject: 'worker_session',
      role: recovery.role,
      workPackageId: recovery.workPackageId,
      workerTaskId: recovery.workerTaskId,
      businessAttemptId: recovery.businessAttemptId,
      sourceSegmentId: recovery.sourceSegmentId,
      sourceDispatchId: recovery.sourceDispatchId,
      observation: input.facts.observationFor(recovery),
      liveness: input.facts.livenessFor(recovery),
      resumeExact: input.facts.resumeExact,
      workspace: input.facts.workspaceFor(recovery),
      sourceTerminal: input.facts.sourceTerminalFor(recovery),
      roleGate: input.facts.roleGateFor(recovery),
      extractCapsule: input.facts.extractCapsule,
      execution: input.facts.execution,
      replacement: input.facts.replacementFor(recovery),
    });
    continued.push({
      recoveryId: recovery.recoveryId,
      previousStatus: recovery.status,
      dispatchLaneKey: workerDispatchLaneKey(recovery),
      result,
    });
  }
  return continued;
}

/** 某条 Recovery 的替代派发 lane；与 `recoverWorkerSession` 预写 intent 时的 target/category 同源。 */
function workerDispatchLaneKey(recovery: RecoveryRecord): string {
  return laneKeyOf({ kind: 'worker-task', id: recovery.workerTaskId }, 'worker-dispatch');
}

/** 该 Recovery 的续办结论是否要求「停下这条 lane」：失败、无法核验或领域阻塞都算。 */
function continuationHoldsDispatch(continuation: RecoveryContinuation): boolean {
  const kind = continuation.result.kind;
  return kind === 'rejected' || kind === 'unverifiable_hold' || kind === 'blocked';
}

function recoveryBlocker(continuation: RecoveryContinuation): StartupBlocker | null {
  const { recoveryId, result, dispatchLaneKey } = continuation;
  if (result.kind === 'rejected') {
    return {
      source: 'recovery',
      code: result.code,
      message: `Recovery ${recoveryId} 未能续办：${result.message}`,
      laneKey: dispatchLaneKey,
      recoveryId,
    };
  }
  if (result.kind === 'blocked') {
    return {
      source: 'recovery',
      code: result.code,
      message: `Recovery ${recoveryId} 阻塞：${result.reason}`,
      laneKey: dispatchLaneKey,
      recoveryId,
    };
  }
  if (result.kind === 'unverifiable_hold') {
    return {
      source: 'recovery',
      code: 'unverifiable',
      message: `Recovery ${recoveryId} 保持未决：${result.reason}`,
      laneKey: dispatchLaneKey,
      recoveryId,
    };
  }
  // 其余结论（精确恢复、替代已创建、原会话终态、已终结）不构成阻塞。
  return null;
}

/** Delivery 重放后仍未确认的结果投影成 blocker；它保留 pipeline 自己给出的 lane 键。 */
function deliveryBlockers(
  deliveries: Extract<ReplayDeliveriesResult, { readonly kind: 'replayed' }>,
): readonly StartupBlocker[] {
  return deliveries.outcomes
    .filter((outcome) => !outcome.confirmed)
    .map<StartupBlocker>((outcome) => ({
      source: 'delivery',
      code: outcome.kind,
      message: `Delivery ${outcome.deliveryId} 未确认（${outcome.blockingReason ?? outcome.kind}）`,
      laneKey: outcome.laneKey,
      recoveryId: null,
    }));
}

/**
 * 装配一个 Runtime Incarnation 的启动序列。
 *
 * 失败一律是 `{ kind: 'rejected', step, code, message }`：调用方据此知道停在哪一步、为什么停，
 * 而不会误以为「只是有些步骤被跳过」。步骤 1 之后失败时关闭 checkpoint store，避免泄漏半成品。
 */
export async function startCompanionStartup(
  request: CompanionStartupRequest,
): Promise<CompanionStartupResult> {
  const store = request.runtime.coordinationStore;
  const coordinationScopeId = request.runtime.coordinationScopeId;
  const observe = (step: StartupStep): void => {
    request.observer?.onStep(step);
  };
  const proven =
    request.provenNoSideEffect === undefined ? {} : { provenNoSideEffect: request.provenNoSideEffect };

  // 步骤 1：加载配置与 Scope、取得 Runtime Lease。内部次序由 startCoordinatorRuntime 固定，这里不重做。
  const started = await startCoordinatorRuntime(request.runtime);
  if (started.kind !== 'started') {
    return { kind: 'rejected', step: 'runtime_started', code: started.code, message: started.message };
  }
  const writer = writerFor(started.incarnation);

  const run = async (): Promise<StartedCompanionStartup> => {
    observe('runtime_started');

    // 步骤 2：以原 OperationId 逐个对账未决 intent。
    const baseRevision = currentScopeRevision(store, coordinationScopeId);
    if (baseRevision === null) {
      throw new StartupAbort('operations_reconciled', 'invalid_state', `Scope ${coordinationScopeId} 不可读`);
    }
    const reconciliation = await reconcileOperations({
      store,
      backend: request.backend,
      coordinationScopeId,
      writer,
      expectedRevision: baseRevision,
      clock: request.clock,
      ...proven,
    });
    if (reconciliation.kind !== 'reconciled') {
      throw new StartupAbort('operations_reconciled', reconciliation.code, reconciliation.message);
    }
    observe('operations_reconciled');

    // 步骤 3：lane 投影（IC-03 已把 projectMutationLanes 的结果放进 snapshot）。
    const projected = snapshotForStep(store, coordinationScopeId, 'lanes_projected');
    observe('lanes_projected');

    // 步骤 4：把未确认 Delivery 交给前驱唯一 pipeline。
    const read = await request.deliveries.readPending();
    if (read.kind !== 'read') {
      throw new StartupAbort('deliveries_replayed', read.code, read.message);
    }
    const deliveries = await replayDeliveries({
      store,
      backend: request.backend,
      coordinationScopeId,
      writer,
      backendIdentityRef: request.deliveries.backendIdentityRef,
      graphGeneration: request.deliveries.graphGeneration,
      authorizationId: request.deliveries.authorizationId,
      runId: request.deliveries.runId,
      consumerGeneration: request.deliveries.consumerGeneration,
      timeoutMs: request.deliveries.timeoutMs,
      pending: read.pending,
      ...(request.deliveries.settle === undefined ? {} : { settle: request.deliveries.settle }),
    });
    if (deliveries.kind !== 'replayed') {
      throw new StartupAbort('deliveries_replayed', deliveries.code, deliveries.message);
    }
    observe('deliveries_replayed');

    // 步骤 5：续办未完成的 Recovery（同一 RecoveryId，不新建、不重复消耗额度）。
    const continued = await continueRecoveries({
      store,
      backend: request.backend,
      writer,
      coordinationScopeId,
      snapshot: projected,
      facts: request.recovery,
    });
    observe('recoveries_continued');

    // 步骤 6：把对账接到 Scope 控制，于是 Resume 天然先对账；Exit 不写控制状态。
    const reconciliationRunner: ScopeReconciliationRunner = async (input) => {
      const result = await reconcileOperations({
        store,
        backend: request.backend,
        coordinationScopeId: input.coordinationScopeId,
        writer: input.writer,
        expectedRevision: input.expectedRevision,
        clock: request.clock,
        ...proven,
      });
      return result.kind === 'rejected'
        ? { kind: 'rejected', code: result.code, message: result.message }
        : {
            kind: 'reconciled',
            summary: { revision: result.revision, unresolvedLaneKeys: result.unresolvedLaneKeys },
          };
    };
    const scopeControl = createScopeControlService({
      store,
      reconciliation: reconciliationRunner,
      workers: request.workers,
    });
    observe('scope_control_wired');

    // 步骤 7：以续办后的最新投影判定是否允许派发与模型恢复。
    const scopeRead = readScope(store, coordinationScopeId);
    if (scopeRead.kind === 'rejected') {
      throw new StartupAbort('readiness_evaluated', scopeRead.code, scopeRead.message);
    }
    const finalSnapshot = snapshotForStep(store, coordinationScopeId, 'readiness_evaluated');

    // 单条 Recovery / Delivery 的失败落到它们各自的 lane 上，不升级成全局停摆。
    const recoveryBlockers = continued
      .map(recoveryBlocker)
      .filter((blocker): blocker is StartupBlocker => blocker !== null);
    const blockers: readonly StartupBlocker[] = [
      ...finalSnapshot.mutationLanes.map<StartupBlocker>((lane) => ({
        source: 'mutation_lane',
        code: lane.cause,
        message: `${lane.laneKey}: ${lane.reason}`,
        laneKey: lane.laneKey,
        recoveryId: null,
      })),
      ...deliveryBlockers(deliveries),
      ...recoveryBlockers,
    ];
    const additionalBlockedLaneKeys = [
      ...new Set(
        blockers
          .map((blocker) => blocker.laneKey)
          .filter((laneKey): laneKey is string => laneKey !== null),
      ),
    ];
    const readiness = evaluateStartupReadiness({
      controlState: scopeRead.scope.controlState,
      lanes: finalSnapshot.mutationLanes,
      startupSequenceCompleted: true,
      ...(additionalBlockedLaneKeys.length === 0 ? {} : { additionalBlockedLaneKeys }),
    });
    observe('readiness_evaluated');

    return {
      kind: 'started',
      runtime: started,
      writer,
      reconciliation,
      lanes: projected.mutationLanes,
      deliveries,
      recoveries: continued,
      blockers,
      unfinishedRecoveryIds: finalSnapshot.recoveries
        .filter((recovery) => isNonTerminalRecoveryStatus(recovery.status))
        .map((recovery) => recovery.recoveryId),
      dispatchHoldingRecoveryIds: continued
        .filter(continuationHoldsDispatch)
        .map((entry) => entry.recoveryId),
      readiness,
      scopeControl,
      endProcess: () => {
        const verdict = scopeControl.exit();
        started.close();
        return verdict;
      },
      close: () => {
        started.close();
      },
    };
  };

  try {
    return await run();
  } catch (error) {
    started.close();
    if (error instanceof StartupAbort) {
      return { kind: 'rejected', step: error.step, code: error.code, message: error.message };
    }
    throw error;
  }
}
