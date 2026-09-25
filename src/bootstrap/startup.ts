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
import { ackConsumedDelivery } from '../application/delivery/process-delivery.js';
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
  concludeWorkerSessionRecovery,
  recoverWorkerSession,
  type ExactRecoveryAttempt,
  type RecoverWorkerSessionResult,
  type RecoveryExecutionContext,
  type RecoveryFactSubject,
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
 *
 * 三种结果各有严格分工：
 * - `rejected`：**读取本身**失败（Orca 不可达、批次结构不完整、有消息但没有稳定 Delivery 身份）。
 *   这时整个启动停在该步骤，因为「有没有未确认 Delivery」这件事本身无法回答；
 * - `read.pending`：已经核验、可以交给前驱 pipeline 重放的 Delivery；
 * - `read.blocked`：读到了消息，但装机所需的事实（归属、物化绑定、Git 事实）无法证明。这时**不**
 *   编造 `PendingDelivery`，而是把对应的可派发 lane 阻塞并给出可观察原因。
 */
export type StartupPendingDeliveryBlock = {
  readonly code: string;
  readonly message: string;
  /** 受影响的可派发 lane；定位不到时是 `null`，此时只作诊断信息展示。 */
  readonly laneKey: string | null;
};

/** 只带进度消息（无结果正文）的未确认批次：必须确认，结果消息才会成为当前批次。 */
export type ProgressOnlyDelivery = {
  readonly deliveryId: string;
  readonly runId: string | null;
};

export type PendingDeliveryRead =
  | {
      readonly kind: 'read';
      readonly pending: readonly PendingDelivery[];
      /** 已读到但无法证明事实的 Delivery；它们不会进入重放 pipeline。 */
      readonly blocked?: readonly StartupPendingDeliveryBlock[];
      /** 只承载进度消息的批次：没有任何可落盘的结果，确认它们只是让 Orca 推进到结果消息。 */
      readonly progressAcks?: readonly ProgressOnlyDelivery[];
    }
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
 * 本 Incarnation 读不到的恢复期环境事实。
 *
 * 它存在的唯一目的是让「读不到」与「已经证明」在类型上不可混淆：`Orca worker-show` 不报告 provider
 * session 身份、执行主机未被列举、Worker Harness Adapter 未接线时，装配方**只能**给出这个值。
 * 收到它的 Recovery 一律按未决阻塞（`unverifiable_hold`）处理：不调用 `recoverWorkerSession`、
 * 不派发替代 Session、不写任何终态，也绝不把「不可读」读成「已恢复」或「已退出」。
 */
export type RecoveryFactUnavailable = {
  readonly kind: 'unavailable';
  readonly code: string;
  readonly message: string;
};

/**
 * 续办一条 Recovery 所需的环境事实。
 *
 * `RecoverWorkerSessionInput` 里除了业务身份（全部来自 `RecoveryRecord`）之外，还有一批只能从
 * Orca `worker-show` / `worker-read`、Git 状态、已批准 Manifest 与 Worker Harness Adapter 得到的事实。
 * 本模块不构造它们，也不伪造 Orca 身份，因此把它们表达为这个窄 provider：按 `RecoveryRecord` 逐项返回。
 *
 * 每一项都允许显式返回 `RecoveryFactUnavailable`：真实装配能证明多少就证明多少，证明不了的那一项
 * 必须以结构化 blocker 呈现，而不是用一个看起来合法的默认值顶替。
 */
export type StartupRecoveryFacts = {
  /**
   * 当前观察到的 harness 绑定；缺字段即无法证明归属。
   *
   * 生产实现要读精确 transcript / Orca 事实，因此这些都是异步 seam：同步 seam 会迫使装配方在
   * 「异步读到的真实事实」与「当场编一个值」之间二选一。
   */
  readonly observationFor: (subject: RecoveryFactSubject) => Promise<RecoveryBindingObservation | RecoveryFactUnavailable>;
  /** 复用 IC-07 的三值存活事实。 */
  readonly livenessFor: (subject: RecoveryFactSubject) => Promise<TerminalLivenessFacts | RecoveryFactUnavailable>;
  /** 精确恢复原会话的执行 seam。 */
  readonly resumeExact: ExactRecoveryAttempt;
  readonly workspaceFor: (subject: RecoveryFactSubject) => Promise<WorkspaceReconciliation | RecoveryFactUnavailable>;
  readonly sourceTerminalFor: (subject: RecoveryFactSubject) => Promise<SourceTerminalObservation | RecoveryFactUnavailable>;
  readonly roleGateFor: (subject: RecoveryFactSubject) => Promise<RoleGateFacts | RecoveryFactUnavailable>;
  readonly extractCapsule: RecoveryCapsuleExtractor;
  readonly execution: RecoveryExecutionContext | RecoveryFactUnavailable;
  readonly replacementFor: (subject: RecoveryFactSubject) => ReplacementDispatch | RecoveryFactUnavailable;
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

/**
 * 步骤 1 的两种形态（design D4：一个 Scope 一个 Incarnation，只取一次 Runtime Lease）。
 *
 * 裸 `StartCoordinatorRuntimeOptions` 表示「本模块自己启动」；`already-started` 表示前台宿主已经用
 * 同一个 `StartedCoordinatorRuntime` 取得了 Runtime Lease，启动序列必须复用那份 incarnation 与
 * fencing generation，而不是再取第二份租约。两种形态下步骤 2..7 完全相同。
 */
export type StartupRuntimeSeam =
  | StartCoordinatorRuntimeOptions
  | {
      readonly kind: 'already-started';
      /** 已启动的 Runtime：模型、incarnation、checkpoint 与 fencing 都由它给出。 */
      readonly runtime: StartedCoordinatorRuntime;
      readonly coordinationStore: BranchCoordinationStore;
      readonly coordinationScopeId: CoordinationScopeId;
    };

export type CompanionStartupRequest = {
  /** 步骤 1 的装配形态；`coordinationStore` 同时是本模块对 Scope 的读取入口。 */
  readonly runtime: StartupRuntimeSeam;
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

/** `RecoveryFactUnavailable` 与真实事实的判别：只有显式标记 `kind: 'unavailable'` 的值算读不到。 */
function isUnavailableFact<T>(fact: T | RecoveryFactUnavailable): fact is RecoveryFactUnavailable {
  return typeof fact === 'object' && fact !== null && 'kind' in fact && fact.kind === 'unavailable';
}

function unavailableFact(field: string, reason: RecoveryFactUnavailable): RecoveryFactUnavailable {
  return {
    kind: 'unavailable',
    code: `${field}_unreadable`,
    message: `${field} 不可读（${reason.code}）：${reason.message}`,
  };
}

type GatheredRecoveryFacts = {
  readonly kind: 'ready';
  readonly observation: RecoveryBindingObservation;
  readonly liveness: TerminalLivenessFacts;
  readonly workspace: WorkspaceReconciliation;
  readonly sourceTerminal: SourceTerminalObservation;
  readonly roleGate: RoleGateFacts;
  readonly execution: RecoveryExecutionContext;
  readonly replacement: ReplacementDispatch;
};

/**
 * 按固定顺序逐项装配一条 Recovery 需要的事实。
 *
 * 任何一项读不到就整体返回 `unavailable`：**不**调用 `recoverWorkerSession`，因此不可能派发替代
 * Session、不可能消耗 Recovery Budget，也不可能写入任何终态。调用方把它翻成 `unverifiable_hold`，
 * 于是原因以结构化 blocker 出现在启动结果与界面上，而不是被读成「已恢复」。
 */
async function gatherRecoveryFacts(
  subject: RecoveryFactSubject,
  facts: StartupRecoveryFacts,
): Promise<GatheredRecoveryFacts | RecoveryFactUnavailable> {
  const observation = await facts.observationFor(subject);
  if (isUnavailableFact(observation)) {
    return unavailableFact('harnessBindingObservation', observation);
  }
  const liveness = await facts.livenessFor(subject);
  if (isUnavailableFact(liveness)) {
    return unavailableFact('workerLiveness', liveness);
  }
  const workspace = await facts.workspaceFor(subject);
  if (isUnavailableFact(workspace)) {
    return unavailableFact('workspaceReconciliation', workspace);
  }
  const sourceTerminal = await facts.sourceTerminalFor(subject);
  if (isUnavailableFact(sourceTerminal)) {
    return unavailableFact('sourceTerminalObservation', sourceTerminal);
  }
  const roleGate = await facts.roleGateFor(subject);
  if (isUnavailableFact(roleGate)) {
    return unavailableFact('roleGateFacts', roleGate);
  }
  const execution = facts.execution;
  if (isUnavailableFact(execution)) {
    return unavailableFact('executionContext', execution);
  }
  const replacement = facts.replacementFor(subject);
  if (isUnavailableFact(replacement)) {
    return unavailableFact('replacementDispatch', replacement);
  }
  return { kind: 'ready', observation, liveness, workspace, sourceTerminal, roleGate, execution, replacement };
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
 *
 * 环境事实读不到时连 `recoverWorkerSession` 都不调用：结论是 `unverifiable_hold`（保持未决、拦住
 * 替代派发 lane），而不是任何形式的「已恢复」。
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
    // 原会话其实已经交付（同角色同 Attempt 的结果已结算）时，Recovery 的前提已经不成立：以
    // `source_completed` 收口并 supersede 原 Segment，而不是为一条已经交付的会话再派 Utility Worker。
    const settlement = input.snapshot.deliverySettlements.find(
      (entry) => entry.role === recovery.role && entry.attemptId === recovery.businessAttemptId,
    );
    if (settlement !== undefined) {
      continued.push(concludeSupersededRecovery(input, recovery, settlement.orcaResultRef));
      continue;
    }
    continued.push(
      await continueWorkerSessionRecovery({
        store: input.store,
        backend: input.backend,
        writer: input.writer,
        coordinationScopeId: input.coordinationScopeId,
        subject: recovery,
        facts: input.facts,
      }),
    );
  }
  return continued;
}

/** 已由 Delivery 结算证明完成的原会话：Recovery 以 `source_completed` 收口，不消耗任何恢复预算。 */
function concludeSupersededRecovery(
  input: {
    readonly store: BranchCoordinationStore;
    readonly writer: CoordinationWriter;
    readonly coordinationScopeId: CoordinationScopeId;
  },
  recovery: RecoveryRecord,
  terminalReceiptRef: string,
): RecoveryContinuation {
  const concluded = concludeWorkerSessionRecovery({
    store: input.store,
    writer: input.writer,
    coordinationScopeId: input.coordinationScopeId,
    recoveryId: recovery.recoveryId,
    outcome: { kind: 'source_completed', terminalReceiptRef },
  });
  const result: RecoverWorkerSessionResult =
    concluded.kind === 'concluded'
      ? {
          kind: 'source_completed',
          recoveryId: recovery.recoveryId,
          phase: 'superseded',
          supersededSegmentId: recovery.sourceSegmentId,
          terminalReceiptRef,
        }
      : {
          kind: 'rejected',
          code: concluded.code,
          message: concluded.message,
        };
  return {
    recoveryId: recovery.recoveryId,
    previousStatus: recovery.status,
    dispatchLaneKey: workerDispatchLaneKey(recovery),
    result,
  };
}

/**
 * 续办一条 Worker Session Recovery：装配环境事实，再以同一业务身份调用恢复用例。
 *
 * 这是「续办一条已登记 Recovery」与「对一条刚确认中断的 Segment 启动 Recovery」共用的唯一入口：
 * 事实装配顺序、`unavailable` → `unverifiable_hold` 的 fail-closed 规则、以及写入所用的身份都只在这里
 * 实现一次。`subject` 可以是已持久化的 `RecoveryRecord`，也可以由中断 Segment 派生（两者字段同源）。
 */
export async function continueWorkerSessionRecovery(input: {
  readonly store: BranchCoordinationStore;
  readonly backend: ExecutionBackend;
  readonly writer: CoordinationWriter;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly subject: RecoveryFactSubject;
  readonly facts: StartupRecoveryFacts;
}): Promise<RecoveryContinuation> {
  const subject = input.subject;
  // 续办前的状态必须**先**读：续办本身会改写它，读晚了就不是「之前的」状态了。
  const previousStatus = recoveryStatusOf(input.store, input.coordinationScopeId, subject.recoveryId);
  const gathered = await gatherRecoveryFacts(subject, input.facts);
  if (gathered.kind === 'unavailable') {
    return {
      recoveryId: subject.recoveryId,
      previousStatus,
      dispatchLaneKey: workerDispatchLaneKey(subject),
      result: {
        kind: 'unverifiable_hold',
        recoveryId: subject.recoveryId,
        phase: 'unverifiable',
        reason: `环境事实无法装配：${gathered.message}`,
      },
    };
  }
  const result = await recoverWorkerSession({
    store: input.store,
    backend: input.backend,
    writer: input.writer,
    coordinationScopeId: input.coordinationScopeId,
    subject: 'worker_session',
    role: subject.role,
    workPackageId: subject.workPackageId,
    workerTaskId: subject.workerTaskId,
    businessAttemptId: subject.businessAttemptId,
    sourceSegmentId: subject.sourceSegmentId,
    sourceDispatchId: subject.sourceDispatchId,
    observation: gathered.observation,
    liveness: gathered.liveness,
    resumeExact: input.facts.resumeExact,
    workspace: gathered.workspace,
    sourceTerminal: gathered.sourceTerminal,
    roleGate: gathered.roleGate,
    extractCapsule: input.facts.extractCapsule,
    execution: gathered.execution,
    replacement: gathered.replacement,
  });
  return {
    recoveryId: subject.recoveryId,
    previousStatus,
    dispatchLaneKey: workerDispatchLaneKey(subject),
    result,
  };
}

/** 续办前读到的持久状态；尚未登记时按 `pending`（正是 `recoverWorkerSession` 会写下的状态）。 */
function recoveryStatusOf(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
  recoveryId: RecoveryId,
): RecoveryState {
  const read = store.query({ kind: 'recovery', coordinationScopeId, recoveryId });
  return read.kind === 'recovery' && read.recovery !== null ? read.recovery.status : 'pending';
}

/** 某条 Recovery 的替代派发 lane；与 `recoverWorkerSession` 预写 intent 时的 target/category 同源。 */
function workerDispatchLaneKey(subject: RecoveryFactSubject): string {
  return laneKeyOf({ kind: 'worker-task', id: subject.workerTaskId }, 'worker-dispatch');
}

/** 该 Recovery 的续办结论是否要求「停下这条 lane」：失败、无法核验或领域阻塞都算。 */
function continuationHoldsDispatch(continuation: RecoveryContinuation): boolean {
  const kind = continuation.result.kind;
  return kind === 'rejected' || kind === 'unverifiable_hold' || kind === 'blocked';
}

/**
 * 一次 Recovery 续办结论 → 可观测 blocker。
 *
 * 启动序列与前台执行触发点共用它：同一条结论在两个入口必须呈现同一个原因与 lane，不各自解释一遍。
 */
export function recoveryBlockerOf(continuation: RecoveryContinuation): StartupBlocker | null {
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
 * 未确认 Delivery 的唯一重放入口。
 *
 * 启动序列与 Resume 都用它：读取（`readPending`）→ 前驱唯一 pipeline（`replayDeliveries`）→
 * 显式拒绝或「已重放 + 无法装配的那些」。**不**第二套读取、去重或结算路径。
 */
async function replayPendingDeliveries(input: {
  readonly store: BranchCoordinationStore;
  readonly backend: ExecutionBackend;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly writer: CoordinationWriter;
  readonly deliveries: StartupDeliveryFacts;
}): Promise<
  | {
      readonly kind: 'replayed';
      readonly replayed: Extract<ReplayDeliveriesResult, { readonly kind: 'replayed' }>;
      readonly unreadable: readonly StartupPendingDeliveryBlock[];
    }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string }
> {
  const facts = input.deliveries;
  const read = await facts.readPending();
  if (read.kind !== 'read') {
    return { kind: 'rejected', code: read.code, message: read.message };
  }
  // 只带进度消息的批次必须确认，否则真实结果消息不会被 Orca 推进为当前批次（进度消息不承载结果，
  // 也没有要落盘的权威事实）。确认失败按可读性阻塞上报，绝不推断「没有新工作」。
  const progressFailures: StartupPendingDeliveryBlock[] = [];
  for (const progress of read.progressAcks ?? []) {
    const acked = await ackConsumedDelivery({
      store: input.store,
      backend: input.backend,
      writer: input.writer,
      coordinationScopeId: input.coordinationScopeId,
      backendIdentityRef: facts.backendIdentityRef,
      graphGeneration: facts.graphGeneration,
      authorizationId: facts.authorizationId,
      runId: facts.runId,
      consumerGeneration: facts.consumerGeneration,
      timeoutMs: facts.timeoutMs,
      deliveryId: progress.deliveryId,
      deliveryRunId: progress.runId,
    });
    if (acked.kind === 'blocked') {
      progressFailures.push({
        code: acked.code,
        message: `只含进度消息的 Delivery ${progress.deliveryId} 无法确认：${acked.message}`,
        laneKey: acked.laneKey,
      });
    }
  }
  const replayed = await replayDeliveries({
    store: input.store,
    backend: input.backend,
    coordinationScopeId: input.coordinationScopeId,
    writer: input.writer,
    backendIdentityRef: facts.backendIdentityRef,
    graphGeneration: facts.graphGeneration,
    authorizationId: facts.authorizationId,
    runId: facts.runId,
    consumerGeneration: facts.consumerGeneration,
    timeoutMs: facts.timeoutMs,
    pending: read.pending,
    ...(facts.settle === undefined ? {} : { settle: facts.settle }),
  });
  if (replayed.kind !== 'replayed') {
    return { kind: 'rejected', code: replayed.code, message: replayed.message };
  }
  return { kind: 'replayed', replayed, unreadable: [...(read.blocked ?? []), ...progressFailures] };
}

/** 读到了消息、但事实证明不了的 Delivery：不作 blocker 记录，只把 lane 报给调用方。 */
function unreadableDeliveryBlockers(
  blocked: readonly StartupPendingDeliveryBlock[],
): readonly StartupBlocker[] {
  return blocked.map<StartupBlocker>((block) => ({
    source: 'delivery',
    code: block.code,
    message: `Delivery 无法装配：${block.message}`,
    laneKey: block.laneKey,
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
  const seam = request.runtime;
  const store = seam.coordinationStore;
  const coordinationScopeId = seam.coordinationScopeId;
  const observe = (step: StartupStep): void => {
    request.observer?.onStep(step);
  };
  const proven =
    request.provenNoSideEffect === undefined ? {} : { provenNoSideEffect: request.provenNoSideEffect };

  // 步骤 1：加载配置与 Scope、取得 Runtime Lease。内部次序由 startCoordinatorRuntime 固定，这里不重做。
  // 复用形态下这个 Incarnation 已经启动过（前台宿主已经取过租约）：不再启动第二次，也不关闭它。
  const reused = 'kind' in seam;
  let started: StartedCoordinatorRuntime;
  if (reused) {
    started = seam.runtime;
  } else {
    const launched = await startCoordinatorRuntime(seam);
    if (launched.kind !== 'started') {
      return { kind: 'rejected', step: 'runtime_started', code: launched.code, message: launched.message };
    }
    started = launched;
  }
  const writer = writerFor(started.incarnation);
  // 复用形态下 checkpoint store 属于前台宿主（它还要用它读会话历史），本模块不能替它关闭。
  const closeRuntime = (): void => {
    if (!reused) {
      started.close();
    }
  };

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
    const replay = await replayPendingDeliveries({
      store,
      backend: request.backend,
      coordinationScopeId,
      writer,
      deliveries: request.deliveries,
    });
    if (replay.kind !== 'replayed') {
      throw new StartupAbort('deliveries_replayed', replay.code, replay.message);
    }
    const deliveries = replay.replayed;
    // 读到了消息、但事实证明不了的 Delivery：不进入重放，按 blocker 落在它自己的可派发 lane 上。
    const unreadableDeliveries = unreadableDeliveryBlockers(replay.unreadable);
    observe('deliveries_replayed');

    // 步骤 5：续办未完成的 Recovery（同一 RecoveryId，不新建、不重复消耗额度）。
    // 这里读的是**重放之后**的快照：步骤 4 刚结算的 Delivery 可能已经让某些 Recovery 的前提消失
    // （原会话其实交付了），同一次启动就应该把它们收口，而不是留到下一次重启。
    const continued = await continueRecoveries({
      store,
      backend: request.backend,
      writer,
      coordinationScopeId,
      snapshot: snapshotForStep(store, coordinationScopeId, 'recoveries_continued'),
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
      if (result.kind === 'rejected') {
        return { kind: 'rejected', code: result.code, message: result.message };
      }
      // Resume 与启动用的是同一件事：先对账，再重放未确认 Delivery，然后才恢复调度。
      const replay = await replayPendingDeliveries({
        store,
        backend: request.backend,
        coordinationScopeId: input.coordinationScopeId,
        writer: input.writer,
        deliveries: request.deliveries,
      });
      if (replay.kind !== 'replayed') {
        return {
          kind: 'rejected',
          code: replay.code,
          message: `恢复前重放未确认 Delivery 失败：${replay.message}`,
        };
      }
      // 重放可能写 store，因此恢复调度前必须重读 revision（它是控制状态写入的 CAS 基准）。
      const revision = currentScopeRevision(store, input.coordinationScopeId);
      if (revision === null) {
        return {
          kind: 'rejected',
          code: 'invalid_state',
          message: `Scope ${input.coordinationScopeId} 在重放后不可读`,
        };
      }
      const replayBlockedLaneKeys = [
        ...replay.replayed.blockedLaneKeys,
        ...replay.unreadable.flatMap((block) => (block.laneKey === null ? [] : [block.laneKey])),
      ];
      return {
        kind: 'reconciled',
        summary: {
          revision,
          unresolvedLaneKeys: [
            ...new Set([...result.unresolvedLaneKeys, ...replayBlockedLaneKeys]),
          ],
        },
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
      .map(recoveryBlockerOf)
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
      ...unreadableDeliveries,
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
        closeRuntime();
        return verdict;
      },
      close: closeRuntime,
    };
  };

  try {
    return await run();
  } catch (error) {
    closeRuntime();
    if (error instanceof StartupAbort) {
      return { kind: 'rejected', step: error.step, code: error.code, message: error.message };
    }
    throw error;
  }
}
