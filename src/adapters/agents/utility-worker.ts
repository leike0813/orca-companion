/**
 * IC-09 / IP-8：受限 Utility Worker 的派发 adapter（Owner: `m1-recover-execution`）。
 *
 * Recovery Capsule 由一个受限 Utility Worker 从**精确 transcript**提取；本模块只负责把它按前驱
 * 已有的派发机制跑起来：同一个 `Task Envelope` 约定（`task-create` 的 `spec` 就是信封 JSON）、
 * 同一条 `worker-start` mutation、同一套 `beginIntent → mutate → settleIntent/blockLane` 顺序，
 * 以及 `session-binding.ts` 的精确绑定核验。共用的受控派发步骤也用于独立的基线补救 Planner Task；
 * 本模块不读 transcript、不解析 Capsule 正文之外的任何东西，也不触发新的 Recovery。
 *
 * 权限在信封里显式固定为只读：Utility Worker 不可写代码、不可再派发 Worker、不可做 Git 操作；
 * 它没有递归恢复的能力。Capsule 正文经正常 Delivery 回到应用层，边界解析由
 * `parseRecoveryCapsuleReport` 完成，结论契约仍归 `src/application/recovery/recovery-capsule.ts`。
 */

import type {
  CoordinationScopeId,
  DispatchId,
  OperationId,
  SessionSegmentId,
  WorkerTaskId,
} from '../../application/dto/identity.js';
import type { BranchCoordinationStore, CoordinationWriter } from '../../application/ports/branch-coordination-store.js';
import type { ExecutionBackend, ExecutionMutation, ExecutionScope } from '../../application/ports/execution-backend.js';
import {
  buildExecutionScope,
  orcaDispatchIdFromReceipt,
  orcaTaskIdFromReceipt,
  orcaTerminalHandleFromReceipt,
  reconcileOperation,
} from '../../application/ports/execution-backend.js';
import {
  activatePreparedWorker,
  knownTerminalHandleFor,
  prepareWorkerLaunch,
  verifyPreparedWorker,
  type WorkerLaunchStrategy,
} from '../../application/worker-launch.js';
import { beginIntent, blockLane, resolveLane, settleIntent } from '../../application/coordination/intent-service.js';
import { readDeliveryBatch } from '../orca-cli/delivery-reader.js';
import type { DeliveryMessage } from '../../application/dto/operation-outcome.js';
import type { RecoveryCapsule } from '../../application/recovery/recovery-capsule.js';
import type { TranscriptCoverageEvidence } from '../../application/recovery/recovery-capsule.js';
import {
  validateRecoveryCapsule,
  validateTranscriptCoverage,
} from '../../application/recovery/recovery-capsule.js';
import {
  bindHarnessSession,
  type HarnessSessionFacts,
  type SessionBindingFailureCode,
} from './session-binding.js';

/** Utility Worker 的 Task Envelope 结构版本；读取到未知版本在边界 fail closed。 */
export const UTILITY_WORKER_ENVELOPE_SCHEMA_VERSION = 1;

/** 唯一登记的受限 Utility 任务类别：从精确 transcript 生成 Recovery Capsule。 */
export const RECOVERY_CAPSULE_TASK_KIND = 'recovery-capsule-extraction';

/**
 * Capsule 报告的字段形状。
 *
 * 这是一段**可解析的样例**：值是占位字符串，形状必须与 `parseRecoveryCapsuleReport` 的校验逐字一致。
 * 它是产出正文的唯一形状说明，生产 Task spec 的 instructions 与验收 spec 都引用它。
 */
export const RECOVERY_CAPSULE_REPORT_SHAPE = JSON.stringify({
  coverage: 'partial',
  readableRange: { transcriptRef: '<精确 transcript 路径>', fromEventRef: 'ordinal:1', toEventRef: 'ordinal:9' },
  gaps: [{ fromEventRef: 'ordinal:10', toEventRef: null, reason: '<缺口原因>' }],
  lastCompleteEventRef: 'ordinal:9',
  openActions: [{ actionRef: '<动作引用>', description: '<未闭合动作>', sourceRef: 'ordinal:8' }],
  sourceRefs: ['ordinal:9'],
  unknowns: ['<未知项>'],
});

/**
 * Capsule Utility Worker 的 Task spec 指令正文。
 *
 * 生产派发与验收 spec 共用这一份说明：读哪份 transcript、事件引用规则、有界读法、产出形状与交付方式
 * 都在里面，Worker 不靠猜。
 */
export function recoveryCapsuleInstructions(
  transcriptRef: string,
  evidence: TranscriptCoverageEvidence,
  readingInstructions?: readonly string[],
): readonly string[] {
  return [
    '你是只读 Utility Worker，从宿主指定的精确 Worker Harness transcript 提取 Recovery Capsule。',
    '不得改文件、跑 git、再派发 Worker、装依赖或访问外部网络；本机 Orca 控制通道是唯一允许的网络用途。',
    `只读这一份 transcript：${transcriptRef}`,
    `宿主已独立读出的可信 coverage 证据是：${JSON.stringify(evidence)}`,
    ...(readingInstructions ?? [
      '用一个 Node 脚本一次读完所有非空行并 JSON.parse 每一行，只按脚本输出结论；不要倾泻正文或重复读取同一段。',
      '事件引用规则：记录自带 ordinal 字段时用 ordinal:<值>；否则有非空 timestamp 时用 timestamp:<值>；都没有时用 line:<行号>（行号从 1 起）。',
    ]),
    `产出只有一个 JSON 对象，形状与解析器逐字一致的可解析样例是：${RECOVERY_CAPSULE_REPORT_SHAPE}`,
    'coverage、readableRange、gaps、lastCompleteEventRef 必须逐项等于上面的可信证据；openActions 的每个元素都是含 actionRef/description/sourceRef 三个非空字符串的对象，sourceRefs 与 unknowns 都是字符串数组，没有结论时写 []。',
    'lastCompleteEventRef 非空时必须出现在 sourceRefs 里。把该 JSON 作为 worker_done 正文提交（outcome succeeded），不要只打印它。',
  ];
}

export type UtilityWorkerOutputContract = {
  readonly kind: 'recovery-capsule';
  readonly schemaVersion: number;
  readonly coverage: readonly ['complete', 'partial'];
};

/**
 * 受限 Utility Worker 的 Task Envelope。
 *
 * `sourceWorkerTaskId` / `sourceSegmentId` / `transcriptRef` 指向被压缩的中断 Segment，不是本
 * Utility Task 自己的身份；`authority` 全为 `false`，因此它结构上没有写代码、再派发或 Git 权限。
 */
export type UtilityWorkerEnvelope = {
  readonly schemaVersion: number;
  readonly taskKind: typeof RECOVERY_CAPSULE_TASK_KIND;
  readonly workPackageId: string;
  readonly sourceWorkerTaskId: string;
  readonly sourceSegmentId: string;
  /** 精确 transcript 来源；不是「最近一次输出」。 */
  readonly transcriptRef: string;
  readonly outputContract: UtilityWorkerOutputContract;
  readonly authority: {
    readonly write: false;
    readonly dispatch: false;
    readonly git: false;
  };
};

export function buildUtilityWorkerEnvelope(input: {
  readonly workPackageId: string;
  readonly sourceWorkerTaskId: WorkerTaskId;
  readonly sourceSegmentId: SessionSegmentId;
  readonly transcriptRef: string;
}): UtilityWorkerEnvelope {
  return {
    schemaVersion: UTILITY_WORKER_ENVELOPE_SCHEMA_VERSION,
    taskKind: RECOVERY_CAPSULE_TASK_KIND,
    workPackageId: input.workPackageId,
    sourceWorkerTaskId: input.sourceWorkerTaskId,
    sourceSegmentId: input.sourceSegmentId,
    transcriptRef: input.transcriptRef,
    outputContract: { kind: 'recovery-capsule', schemaVersion: 1, coverage: ['complete', 'partial'] },
    authority: { write: false, dispatch: false, git: false },
  };
}

/** 受限 Utility Worker 的精确绑定：它不属于四个业务角色，因此不携带角色字段。 */
export type UtilityWorkerSessionBinding = {
  readonly harness: string;
  readonly workerTaskId: WorkerTaskId;
  readonly dispatchId: DispatchId;
  readonly providerSessionId: string;
  readonly transcriptRef: string;
  readonly observedAt: string;
};

export type UtilityWorkerBindingResult =
  | { readonly kind: 'bound'; readonly binding: UtilityWorkerSessionBinding }
  | {
      readonly kind: 'unavailable';
      readonly code: SessionBindingFailureCode;
      readonly message: string;
      readonly blocksDispatch: true;
    };

/**
 * 核验 Utility Worker 的精确绑定。
 *
 * 复用 `bindHarnessSession` 的全部规则（harness、session 身份、transcript 来源、观察时间窗、身份
 * 变更），只把返回值换成不含业务角色的形状——Utility Worker 不是 Planner / Implementation /
 * Validator / Finalizer 中的任何一个。
 */
export function bindUtilityWorkerSession(
  facts: HarnessSessionFacts,
  options: { readonly identityChanged?: boolean; readonly harness?: string } = {},
): UtilityWorkerBindingResult {
  const bound = bindHarnessSession(options.harness ?? 'codex', facts, options);
  if (bound.kind === 'unavailable') {
    return bound;
  }
  return {
    kind: 'bound',
    binding: {
      harness: bound.binding.harness,
      workerTaskId: bound.binding.workerTaskId,
      dispatchId: bound.binding.dispatchId,
      providerSessionId: bound.binding.providerSessionId,
      transcriptRef: bound.binding.transcriptRef,
      observedAt: bound.binding.observedAt,
    },
  };
}

/** 精确 Session Binding 的观察 seam；真实实现读 Orca `worker-show`，测试注入 fake。 */
export type UtilityWorkerSessionObserver = (facts: {
  readonly dispatchId: string;
  readonly envelope: UtilityWorkerEnvelope;
}) => Promise<HarnessSessionFacts | null>;

export type UtilityWorkerDispatchInput = {
  readonly store: BranchCoordinationStore;
  readonly backend: ExecutionBackend;
  readonly writer: CoordinationWriter;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly envelope: UtilityWorkerEnvelope;
  readonly execution: {
    readonly backendIdentityRef: string;
    readonly graphGeneration: number;
    readonly authorizationId: string;
    readonly runId: string;
    readonly consumerGeneration: number;
    readonly timeoutMs: number;
  };
  readonly workerLaunch: WorkerLaunchStrategy;
  readonly worktree: string;
  readonly taskTitle?: string;
  readonly displayName?: string;
  /** Controller 签发的稳定 OperationId；恢复重放沿用同一组值。 */
  readonly operationIds: {
    readonly task: OperationId;
    readonly workerPrepare: OperationId;
    readonly workerStart: OperationId;
    readonly workerActivate: OperationId;
  };
  readonly observeSession: UtilityWorkerSessionObserver;
  /** 在 task-create intent 结清前持久化固定模型授权；失败保持该 lane 未决。 */
  readonly onTaskCreated?: (orcaTaskId: string) => { readonly code: string; readonly message: string } | null;
  /**
   * 追加进 Task spec 根的可读指令（正文，不参与身份判定）。
   *
   * 生产 Capsule 派发用它在同一个 spec 里说清「读哪份 transcript、事件引用规则、有界读法、产出形状、
   * 交付方式」；信封标识字段保持不变，`specMatchesEnvelope` 的根身份对账不受影响。
   */
  readonly instructions?: readonly string[];
};

export type UtilityWorkerDispatchResult =
  | {
      readonly kind: 'dispatched';
      readonly envelope: UtilityWorkerEnvelope;
      readonly orcaTaskId: string;
      readonly dispatchId: string;
      readonly binding: UtilityWorkerSessionBinding;
    }
  | {
      readonly kind: 'binding_unavailable';
      readonly code: SessionBindingFailureCode;
      readonly message: string;
    }
  | { readonly kind: 'blocked'; readonly laneKey: string; readonly reason: string }
  | { readonly kind: 'unknown'; readonly operationId: OperationId; readonly reason: string }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

/** 角色外独立 Task 的共用受控派发；调用方负责提供已校验的任务正文与持久绑定。 */
export type ScopedWorkerDispatchInput = Omit<UtilityWorkerDispatchInput, 'envelope' | 'observeSession'> & {
  readonly workPackageId: string;
  readonly spec: string;
  readonly existingOrcaTaskId?: string;
  readonly observeSession: (dispatchId: string) => Promise<HarnessSessionFacts | null>;
  readonly onTaskCreated?: (orcaTaskId: string) => { readonly code: string; readonly message: string } | null;
  readonly onDispatchStarted?: (orcaTaskId: string, dispatchId: string) => { readonly code: string; readonly message: string } | null;
};

export type ScopedWorkerDispatchResult =
  | Omit<Extract<UtilityWorkerDispatchResult, { readonly kind: 'dispatched' }>, 'envelope'>
  | Exclude<UtilityWorkerDispatchResult, { readonly kind: 'dispatched' }>;

function freshRevision(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
): number | null {
  const scope = store.query({ kind: 'scope', coordinationScopeId });
  return scope.kind === 'scope' && scope.scope !== null ? scope.scope.revision : null;
}

function scopeOf(
  input: Pick<ScopedWorkerDispatchInput, 'coordinationScopeId' | 'writer' | 'execution'>,
  operationId: OperationId,
  target: { readonly kind: string; readonly id: string },
  expectedRevision: number,
): ExecutionScope {
  return buildExecutionScope({
    coordinationScopeId: input.coordinationScopeId,
    coordinatorSessionId: input.writer.coordinatorSessionId,
    runtimeIncarnationId: input.writer.runtimeIncarnationId,
    fencingGeneration: input.writer.fencingGeneration,
    backendIdentityRef: input.execution.backendIdentityRef,
    operationId,
    target,
    expectedRevision,
    timeoutMs: input.execution.timeoutMs,
    authority: {
      kind: 'execution_coordination',
      graphGeneration: input.execution.graphGeneration,
      authorizationId: input.execution.authorizationId,
      runId: input.execution.runId,
      consumerGeneration: input.execution.consumerGeneration,
    },
  });
}

type ProtectedMutation =
  | { readonly kind: 'accepted'; readonly value: unknown; readonly operationId: OperationId }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string }
  | { readonly kind: 'unknown'; readonly operationId: OperationId; readonly reason: string }
  | { readonly kind: 'blocked'; readonly laneKey: string; readonly reason: string };

/**
 * 一次受 Intent 保护的 mutation。
 *
 * 顺序与前驱物化完全一致：`beginIntent` → `backend.mutate` → `settleIntent`；`unknown` 只按原
 * OperationId 记下 backend request 引用并阻塞 lane，绝不换 ID 重试。
 */
async function runProtected(
  input: ScopedWorkerDispatchInput,
  operationId: OperationId,
  target: { readonly kind: string; readonly id: string },
  category: string,
  mutation: ExecutionMutation,
  beforeSettle?: (value: unknown) => { readonly code: string; readonly message: string } | null,
  /**
   * 结果未知时的**事实对账**：用 Orca 列举事实判断这次 mutation 是否已经发生。
   *
   * `request-show` 只能证明「请求被记录过」，拿不回资源身份；没有 backend request id 时它就把 lane 永久
   * 阻塞。读到事实就按 `accepted` 收尾（附资源身份），读不到才落回原来的阻塞路径。
   */
  reconcileFacts?: () => Promise<{ readonly kind: 'observed'; readonly value: unknown } | { readonly kind: 'unobserved' }>,
): Promise<ProtectedMutation> {
  const revision = freshRevision(input.store, input.coordinationScopeId);
  if (revision === null) {
    return { kind: 'blocked', laneKey: category, reason: '无法读取 Scope revision' };
  }
  /**
   * 统一的 beforeSettle 执行：任何「事实已证明副作用发生」的路径（accepted、unknown+facts、
   * 以及恢复重放）都必须先落 callbacks（如 onDispatchStarted / onTaskCreated），失败即阻塞 lane。
   */
  const checkBeforeSettle = (value: unknown): ProtectedMutation | null => {
    const failure = beforeSettle?.(value) ?? null;
    if (failure === null) return null;
    const blockRevision = freshRevision(input.store, input.coordinationScopeId);
    if (blockRevision !== null) {
      blockLane(input.store, {
        coordinationScopeId: input.coordinationScopeId,
        operationId,
        writer: input.writer,
        expectedRevision: blockRevision,
        reason: failure.message,
      });
    }
    return { kind: 'blocked', laneKey: category, reason: failure.message };
  };
  const begun = beginIntent(input.store, {
    coordinationScopeId: input.coordinationScopeId,
    operationId,
    target,
    operationCategory: category,
    writer: input.writer,
    expectedRevision: revision,
  });
  if (begun.kind === 'lane_blocked') {
    return {
      kind: 'blocked',
      laneKey: begun.laneKey,
      reason: `lane 已被未决意图 ${begun.blockingIntent.operationId} 阻塞`,
    };
  }
  if (begun.kind === 'lane_busy') {
    return {
      kind: 'blocked',
      laneKey: begun.laneKey,
      reason: `lane 上已有未决意图 ${begun.activeIntent.operationId}`,
    };
  }
  if (begun.kind === 'rejected') {
    return { kind: 'blocked', laneKey: category, reason: begun.rejection.message };
  }
  if (begun.kind === 'existing') {
    // 已存在的意图是恢复重放：绝不再次 mutate；settled accepted 只读回读，pending/blocked 按原 ID 对账。
    if (begun.intent.state === 'settled' && begun.intent.outcomeClass === 'rejected') {
      return { kind: 'rejected', code: 'intent_already_rejected', message: '该操作已有结算拒绝记录，未重复执行' };
    }
    const facts: { readonly kind: 'observed'; readonly value: unknown } | { readonly kind: 'unobserved' } =
      reconcileFacts === undefined ? { kind: 'unobserved' } : await reconcileFacts();
    if (facts.kind === 'observed') {
      if (begun.intent.state === 'settled') {
        // 读回成立即复用原结果；beforeSettle 复核在重放路径上同样要跑。
        const blocked = checkBeforeSettle(facts.value);
        if (blocked !== null) return blocked;
        return { kind: 'accepted', value: facts.value, operationId };
      }
      // pending / blocked：按原身份收尾为 accepted（blocked 用 resolveLane），不重复消费。
      const blockedPending = checkBeforeSettle(facts.value);
      if (blockedPending !== null) return blockedPending;
      const settleRevision = freshRevision(input.store, input.coordinationScopeId);
      if (settleRevision !== null) {
        const finished =
          begun.intent.state === 'blocked'
            ? resolveLane(input.store, {
                coordinationScopeId: input.coordinationScopeId,
                operationId,
                writer: input.writer,
                expectedRevision: settleRevision,
                outcomeClass: 'accepted',
              })
            : settleIntent(input.store, {
                coordinationScopeId: input.coordinationScopeId,
                operationId,
                writer: input.writer,
                expectedRevision: settleRevision,
                outcome: { kind: 'accepted', operation: { operationId, target }, value: facts.value },
              });
        if (finished.kind === 'settled') {
          return { kind: 'accepted', value: facts.value, operationId };
        }
      }
      return { kind: 'blocked', laneKey: category, reason: '事实已证明副作用发生，但原意图无法收尾' };
    }
    if (begun.intent.state === 'blocked') {
      return { kind: 'blocked', laneKey: category, reason: begun.intent.blockingReason ?? '该操作已被阻塞' };
    }
    return {
      kind: 'unknown',
      operationId,
      reason: '该操作已有意图记录且事实不可证，未重复执行；按原回执对账',
    };
  }
  const outcome = await input.backend.mutate(
    mutation,
    scopeOf(input, operationId, target, revision),
  );
  if (outcome.kind === 'accepted') {
    const blocked = checkBeforeSettle(outcome.value);
    if (blocked !== null) return blocked;
  }
  const settled = settleIntent(input.store, {
    coordinationScopeId: input.coordinationScopeId,
    operationId,
    writer: input.writer,
    expectedRevision: freshRevision(input.store, input.coordinationScopeId) ?? revision,
    outcome,
  });
  if (settled.kind === 'rejected') {
    return { kind: 'blocked', laneKey: category, reason: settled.rejection.message };
  }
  if (outcome.kind === 'rejected') {
    return { kind: 'rejected', code: outcome.code, message: outcome.message };
  }
  if (outcome.kind === 'unknown') {
    const facts: { readonly kind: 'observed'; readonly value: unknown } | { readonly kind: 'unobserved' } =
      reconcileFacts === undefined ? { kind: 'unobserved' } : await reconcileFacts();
    if (facts.kind === 'observed') {
      // 结果未知但事实已证明发生：先落 callbacks（Task/ctx），再按同 ID 收尾 accepted。
      const blocked = checkBeforeSettle(facts.value);
      if (blocked !== null) return blocked;
      const settledByFacts = settleIntent(input.store, {
        coordinationScopeId: input.coordinationScopeId,
        operationId,
        writer: input.writer,
        expectedRevision: freshRevision(input.store, input.coordinationScopeId) ?? revision,
        outcome: { kind: 'accepted', operation: outcome.operation, value: facts.value },
      });
      if (settledByFacts.kind === 'settled') {
        return { kind: 'accepted', value: facts.value, operationId };
      }
    }
    const blockRevision = freshRevision(input.store, input.coordinationScopeId);
    if (blockRevision !== null) {
      blockLane(input.store, {
        coordinationScopeId: input.coordinationScopeId,
        operationId,
        writer: input.writer,
        expectedRevision: blockRevision,
        reason: 'Worker 调用结果未知，缺少副作用是否发生的证明',
      });
    }
    const reconciled = await reconcileOperation(input.backend, outcome.operation);
    return {
      kind: 'unknown',
      operationId,
      reason: `结果未知（对账结论 ${reconciled.kind}），lane 保持阻塞`,
    };
  }
  return { kind: 'accepted', value: outcome.value, operationId };
}

/**
 * 派发受限 Utility Worker 生成 Recovery Capsule。
 *
 * 它复用前驱的 Task Envelope 约定与派发顺序：`task-create`（spec 是信封 JSON）→ `worker-start` →
 * 精确 Session Binding 核验。任一步不可核验即返回结构化失败，绝不猜 dispatch 或 session 身份。
 */
export async function dispatchScopedWorker(input: ScopedWorkerDispatchInput): Promise<ScopedWorkerDispatchResult> {
  const taskTarget = { kind: 'work-package', id: input.workPackageId };
  let orcaTaskId = input.existingOrcaTaskId ?? null;
  if (orcaTaskId === null) {
    const created = await runProtected(input, input.operationIds.task, taskTarget, 'task-create', {
      operation: 'task-create',
      spec: input.spec,
      ...(input.taskTitle === undefined ? {} : { taskTitle: input.taskTitle }),
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    }, (value) => {
      const taskId = orcaTaskIdFromReceipt(value);
      if (taskId === null) return { code: 'invalid_receipt', message: 'task-create 回执缺少可核验的 task id' };
      return input.onTaskCreated?.(taskId) ?? null;
    });
    if (created.kind !== 'accepted') return created;
    orcaTaskId = orcaTaskIdFromReceipt(created.value);
    if (orcaTaskId === null) return { kind: 'unknown', operationId: created.operationId, reason: 'task-create 回执缺少可核验的 task id' };
  }

  const knownTerminal = knownTerminalHandleFor(
    input.store,
    input.coordinationScopeId,
    input.operationIds.workerPrepare,
  );
  if (knownTerminal.kind === 'evidence_missing') {
    return {
      kind: 'blocked',
      laneKey: 'worker-terminal-prepare',
      reason: '原 prepared terminal 操作已接受但缺少可核验的 terminal handle；需要资源证据，不重复创建',
    };
  }
  const launch = await prepareWorkerLaunch({
    backend: input.backend,
    strategy: input.workerLaunch,
    worktreeId: input.worktree,
    ...(input.worktree.startsWith('path:') ? { worktreePath: input.worktree.slice('path:'.length) } : {}),
    ...(knownTerminal.kind === 'known' ? { knownTerminalHandle: knownTerminal.handle } : {}),
    timeoutMs: input.execution.timeoutMs,
    createTerminal: async (mutation) => {
      const prepared = await runProtected(
        input,
        input.operationIds.workerPrepare,
        taskTarget,
        'worker-terminal-prepare',
        mutation,
      );
      if (prepared.kind !== 'accepted') {
        return prepared;
      }
      const handle = orcaTerminalHandleFromReceipt(prepared.value);
      return handle === null
        ? {
            kind: 'unknown' as const,
            operationId: prepared.operationId,
            reason: 'terminal-create 回执缺少可核验的 terminal handle；不按 title 猜测资源',
          }
        : { kind: 'accepted' as const, terminalHandle: handle };
    },
  });
  if (launch.kind !== 'ready') {
    return launch;
  }

  const started = await runProtected(input, input.operationIds.workerStart, taskTarget, 'worker-start', {
    operation: 'worker-start',
    taskId: orcaTaskId,
    worktree: input.worktree,
    ...launch.worker,
  }, (value) => {
    const dispatchId = orcaDispatchIdFromReceipt(value);
    if (dispatchId === null) return { code: 'invalid_receipt', message: 'worker-start 回执缺少可核验的 dispatch id' };
    return input.onDispatchStarted?.(orcaTaskId, dispatchId) ?? null;
  }, async () => {
    // 结果未知时按 Orca 事实对账：列举里已经出现这个 Task 的 Worker，就说明 worker-start 发生过。
    const listed = await input.backend.query({ operation: 'worker-list', runId: input.execution.runId });
    if (listed.kind !== 'accepted') {
      return { kind: 'unobserved' };
    }
    const value: unknown = listed.value;
    if (typeof value !== 'object' || value === null) {
      return { kind: 'unobserved' };
    }
    const workers = (value as { readonly workers?: unknown }).workers;
    if (!Array.isArray(workers)) {
      return { kind: 'unobserved' };
    }
    for (const worker of workers) {
      if (typeof worker !== 'object' || worker === null) {
        continue;
      }
      const record = worker as Record<string, unknown>;
      if (record['taskId'] !== orcaTaskId) {
        continue;
      }
      const dispatchId = record['dispatchId'];
      if (typeof dispatchId === 'string' && dispatchId.length > 0) {
        return { kind: 'observed', value: { dispatchId } };
      }
    }
    return { kind: 'unobserved' };
  });
  if (started.kind === 'blocked') {
    return started;
  }
  if (started.kind === 'unknown') {
    return started;
  }
  if (started.kind === 'rejected') {
    return started;
  }
  const dispatchId = orcaDispatchIdFromReceipt(started.value);
  if (dispatchId === null) {
    return {
      kind: 'unknown',
      operationId: started.operationId,
      reason: 'worker-start 回执缺少可核验的 dispatch id',
    };
  }

  const activated = await activatePreparedWorker({
    backend: input.backend,
    terminal: launch.preparedTerminal,
    submitTerminal: async (mutation) => {
      const submitted = await runProtected(
        input,
        input.operationIds.workerActivate,
        taskTarget,
        'worker-terminal-activate',
        mutation,
        undefined,
        () => {
          // activate 是不可重发的终态动作：只复用「已 settled accepted」的结算事实，绝不重发，也不凭
          // worker-show 放宽 pending/unknown（worker-start 在 submit 前就已绑定 terminal）。
          const read = input.store.query({
            kind: 'intent',
            coordinationScopeId: input.coordinationScopeId,
            operationId: input.operationIds.workerActivate,
          });
          return Promise.resolve(
            read.kind === 'intent' &&
              read.intent !== null &&
              read.intent.state === 'settled' &&
              read.intent.outcomeClass === 'accepted'
              ? { kind: 'observed', value: {} }
              : { kind: 'unobserved' },
          );
        },
      );
      return submitted.kind === 'accepted' ? { kind: 'accepted' as const } : submitted;
    },
  });
  if (activated.kind !== 'accepted') {
    return activated;
  }

  const adoption = await verifyPreparedWorker(input.backend, dispatchId, launch.preparedTerminal);
  if (adoption !== null) {
    return adoption;
  }

  const facts = await input.observeSession(dispatchId);
  if (facts === null) {
    return {
      kind: 'binding_unavailable',
      code: 'session_not_reported',
      message: '无法观察到该 Utility Worker 的精确 harness session 事实',
    };
  }
  const bound = bindUtilityWorkerSession(facts, {
    harness: input.workerLaunch.kind === 'prepared_terminal' ? input.workerLaunch.harness : input.workerLaunch.agent,
  });
  if (bound.kind === 'unavailable') {
    return { kind: 'binding_unavailable', code: bound.code, message: bound.message };
  }
  return { kind: 'dispatched', orcaTaskId, dispatchId, binding: bound.binding };
}

/**
 * 受限 Utility Worker 的 Capsule 报告读回输入。
 *
 * 报告走既有 Delivery 通道（读 + 确认的传输原语），不做角色结算：Capsule 不是角色结果，它的权威
 * 事实由 `parseRecoveryCapsuleReport` 按 host 侧的 transcript 读取证据校验。
 */
export type CapsuleDispatchInput = {
  readonly instructions?: readonly string[];
  readonly store: BranchCoordinationStore;
  readonly backend: ExecutionBackend;
  readonly writer: CoordinationWriter;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly envelope: UtilityWorkerEnvelope;
  readonly execution: UtilityWorkerDispatchInput['execution'];
  readonly workerLaunch: WorkerLaunchStrategy;
  readonly worktree: string;
  readonly operationIds: UtilityWorkerDispatchInput['operationIds'];
  readonly observeSession: UtilityWorkerDispatchInput['observeSession'];
  readonly onTaskCreated?: UtilityWorkerDispatchInput['onTaskCreated'];
  /** host 侧独立读到的 transcript 覆盖证据；Worker 报告的 coverage 必须逐项等于它。 */
  readonly evidence: TranscriptCoverageEvidence;
  /** 等待 Capsule 报告的上界；超时按失败返回，由同一 Recovery 内的一次安全重派兜底。 */
  readonly reportTimeoutMs: number;
};

/** 消息是否属于本次派发：按 Orca 的 Task / Dispatch 身份配对，不按文本猜。 */
function messageFromDispatch(message: DeliveryMessage, orcaTaskId: string, dispatchId: string): boolean {
  if (message.payload === null) {
    return false;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(message.payload) as unknown;
  } catch {
    return false;
  }
  const record = readRecord(decoded, 'payload');
  if (!record.ok) {
    return false;
  }
  return record.value['taskId'] === orcaTaskId && record.value['dispatchId'] === dispatchId;
}

/** 报告的正文位置不固定：结构化载荷优先，其次从消息 body 里取第一段 JSON 对象。 */
function capsuleReportCandidate(message: DeliveryMessage): unknown {
  if (message.payload !== null) {
    try {
      const payload: unknown = JSON.parse(message.payload);
      if (typeof payload === 'object' && payload !== null && Object.hasOwn(payload, 'coverage')) {
        return payload;
      }
      // Orca 原生 payload 只有 Task/Dispatch 等传输身份，Capsule 正文在 body。
    } catch {
      // 载荷不是 JSON：退回 body。
    }
  }
  const body = message.body ?? '';
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(body.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

export type CapsuleDispatchOutcome =
  | {
      readonly kind: 'extracted';
      readonly capsule: RecoveryCapsule;
      /** 报告所在的 Delivery 身份；整批都属于本次派发时给出，由调用方落盘后再确认。 */
      readonly delivery: { readonly deliveryId: string; readonly runId: string | null } | null;
    }
  | { readonly kind: 'failed'; readonly reason: string };

/**
 * 派发受限 Utility Worker 并读回它的 Recovery Capsule 报告。
 *
 * 只做三件事：按信封派发、按 Orca 身份从当前未确认批次里找出它的报告、把报告按 host 证据校验成
 * Capsule。确认只发生在「整批都属于本次派发」时——批里混着角色结果时留给常规 Delivery 流程，
 * 绝不代它确认。
 */
/** Orca Task 列举里的最小事实；字段缺失即视为不可读（fail closed，不猜身份）。 */
type ListedTask = { readonly id: string; readonly spec: string | null };

function listedTasksOf(value: unknown): readonly ListedTask[] | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const raw = (value as { readonly tasks?: unknown }).tasks;
  if (!Array.isArray(raw)) {
    return null;
  }
  const tasks: ListedTask[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const id = record['id'];
    if (typeof id !== 'string' || id.length === 0) {
      continue;
    }
    const spec = record['spec'];
    tasks.push({ id, spec: typeof spec === 'string' ? spec : null });
  }
  return tasks;
}

/** Task 的 spec 是否就是这次信封派发的内容：按信封身份逐项比对，不按标题或时间猜。 */
function specMatchesEnvelope(spec: string | null, envelope: UtilityWorkerEnvelope): boolean {
  if (spec === null) {
    return false;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(spec) as unknown;
  } catch {
    return false;
  }
  const record = readRecord(decoded, 'spec');
  if (!record.ok) {
    return false;
  }
  return (
    record.value['taskKind'] === envelope.taskKind &&
    record.value['workPackageId'] === envelope.workPackageId &&
    record.value['sourceSegmentId'] === envelope.sourceSegmentId
  );
}

/**
 * 回读**已经派发过**的同一个 Utility Worker。
 *
 * 重放与重启后 OperationId 已收尾、回执也不在了，因此身份必须从 Orca 的列举事实回读：先按信封内容
 * 找到那次 Task，再按 Task 找到它的 Dispatch。读不到就返回 `null`（调用方照常派发，绝不凭猜测续办）。
 */
export async function findDispatchedUtilityWorker(input: {
  readonly backend: ExecutionBackend;
  readonly backendIdentityRef: string;
  readonly runId: string;
  readonly envelope: UtilityWorkerEnvelope;
}): Promise<{ readonly orcaTaskId: string; readonly dispatchId: string } | null> {
  const listed = await input.backend.query({
    operation: 'task-list',
    backendIdentityRef: input.backendIdentityRef,
    runId: input.runId,
  });
  if (listed.kind !== 'accepted') {
    return null;
  }
  const tasks = listedTasksOf(listed.value);
  if (tasks === null) {
    return null;
  }
  const mine = tasks.filter((task) => specMatchesEnvelope(task.spec, input.envelope));
  if (mine.length === 0) {
    return null;
  }
  const workers = await input.backend.query({ operation: 'worker-list', runId: input.runId });
  if (workers.kind !== 'accepted') {
    return null;
  }
  const raw = (workers.value as { readonly workers?: unknown }).workers;
  if (!Array.isArray(raw)) {
    return null;
  }
  // 后创建的 Task 优先：它才是当前有效的报告来源。
  for (const task of [...mine].reverse()) {
    for (const worker of raw) {
      if (typeof worker !== 'object' || worker === null) {
        continue;
      }
      const record = worker as Record<string, unknown>;
      const dispatchId = record['dispatchId'];
      if (record['taskId'] === task.id && typeof dispatchId === 'string' && dispatchId.length > 0) {
        return { orcaTaskId: task.id, dispatchId };
      }
    }
  }
  return null;
}

export async function dispatchCapsuleWorker(input: CapsuleDispatchInput): Promise<CapsuleDispatchOutcome> {
  // 重放/重启后同一个 OperationId 已经收尾过：身份只能从 Orca 列举事实回读，读到就继续读它的报告，
  // 读不到才新建派发（同一 OperationId 也不会被重发，见 `runProtected` 的 `existing` 分支）。
  const existing = await findDispatchedUtilityWorker({
    backend: input.backend,
    backendIdentityRef: input.execution.backendIdentityRef,
    runId: input.execution.runId,
    envelope: input.envelope,
  });
  let dispatched: { readonly orcaTaskId: string; readonly dispatchId: string };
  if (existing !== null) {
    dispatched = existing;
  } else {
    const created = await dispatchUtilityWorker({
      store: input.store,
      backend: input.backend,
      writer: input.writer,
      coordinationScopeId: input.coordinationScopeId,
      envelope: input.envelope,
      execution: input.execution,
      workerLaunch: input.workerLaunch,
      worktree: input.worktree,
      taskTitle: 'Recovery Capsule 提取（只读受限 Utility Worker）',
      operationIds: input.operationIds,
      observeSession: input.observeSession,
      ...(input.onTaskCreated === undefined ? {} : { onTaskCreated: input.onTaskCreated }),
      instructions: recoveryCapsuleInstructions(input.envelope.transcriptRef, input.evidence, input.instructions),
    });
    if (created.kind !== 'dispatched') {
      const reason =
        created.kind === 'blocked' || created.kind === 'unknown'
          ? `Capsule Utility Worker 派发未取得确定结论：${created.reason}`
          : `${created.code}: ${created.message}`;
      return { kind: 'failed', reason };
    }
    dispatched = { orcaTaskId: created.orcaTaskId, dispatchId: created.dispatchId };
  }

  const deadline = Date.now() + input.reportTimeoutMs;
  for (;;) {
    const batchRead = await readDeliveryBatch(input.backend, {
      backendIdentityRef: input.execution.backendIdentityRef,
      runId: input.execution.runId,
      types: ['worker_done'],
      timeoutMs: input.execution.timeoutMs,
    });
    if (batchRead.kind !== 'accepted') {
      return { kind: 'failed', reason: `Capsule 报告读取失败：${batchRead.message}` };
    }
    const batch = batchRead.value;
    const mine = batch.messages.filter((message) =>
      messageFromDispatch(message, dispatched.orcaTaskId, dispatched.dispatchId),
    );
    if (mine.length > 0) {
      const parsed = parseCapsuleReport(mine, input.evidence);
      if (!parsed.ok) {
        return { kind: 'failed', reason: parsed.reason };
      }
      const onlyMine = batch.messages.every((message) =>
        messageFromDispatch(message, dispatched.orcaTaskId, dispatched.dispatchId),
      );
      return {
        kind: 'extracted',
        capsule: parsed.capsule,
        // 批里混着别的 Worker 结果时不报告 Delivery 身份：那一批留给常规 Delivery 流程。
        delivery: onlyMine && batch.delivery !== null
          ? { deliveryId: batch.delivery.deliveryId, runId: batch.delivery.runId }
          : null,
      };
    }
    if (Date.now() >= deadline) {
      return {
        kind: 'failed',
        reason: `等待 Capsule 报告超时（Dispatch ${dispatched.dispatchId}）：不确定它是否还会报告，因此不重读同一批`,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function parseCapsuleReport(
  messages: readonly DeliveryMessage[],
  evidence: TranscriptCoverageEvidence,
): RecoveryCapsuleReportParse {
  let lastReason = 'Capsule 报告不可读';
  for (const message of messages) {
    const candidate = capsuleReportCandidate(message);
    if (candidate === null) {
      continue;
    }
    const parsed = parseRecoveryCapsuleReport(candidate, evidence);
    if (parsed.ok) {
      return parsed;
    }
    lastReason = parsed.reason;
  }
  return { ok: false, reason: lastReason };
}

export async function dispatchUtilityWorker(input: UtilityWorkerDispatchInput): Promise<UtilityWorkerDispatchResult> {
  // 指令是 spec 根的可读正文：身份字段仍是信封原值，`specMatchesEnvelope` 的根身份对账不变。
  const spec =
    input.instructions === undefined || input.instructions.length === 0
      ? JSON.stringify(input.envelope)
      : JSON.stringify({ ...input.envelope, instructions: input.instructions });
  const result = await dispatchScopedWorker({
    ...input,
    workPackageId: input.envelope.workPackageId,
    spec,
    observeSession: (dispatchId) => input.observeSession({ dispatchId, envelope: input.envelope }),
  });
  return result.kind === 'dispatched' ? { ...result, envelope: input.envelope } : result;
}

function readStringArray(value: unknown, field: string): { readonly ok: true; readonly value: readonly string[] } | { readonly ok: false; readonly reason: string } {
  if (!Array.isArray(value)) {
    return { ok: false, reason: `${field} 必须是数组` };
  }
  const values: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0) {
      return { ok: false, reason: `${field} 的每一项都必须是非空字符串` };
    }
    values.push(item);
  }
  return { ok: true, value: values };
}

function readNullableString(value: unknown, field: string): { readonly ok: true; readonly value: string | null } | { readonly ok: false; readonly reason: string } {
  if (value === null) {
    return { ok: true, value: null };
  }
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, reason: `${field} 必须是非空字符串或 null` };
  }
  return { ok: true, value };
}

function readRecord(value: unknown, field: string): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly reason: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: `${field} 必须是对象` };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

export type RecoveryCapsuleReportParse =
  | { readonly ok: true; readonly capsule: RecoveryCapsule }
  | { readonly ok: false; readonly reason: string };

/**
 * 解析受限 Utility Worker 的结构化 Capsule 报告。
 *
 * 这是边界上的运行时校验：字段缺失或类型不符一律返回失败，不降级、不补造字段；解析通过后仍要走
 * `validateRecoveryCapsule` 的内容约束，因此 `partial` 缺任何一项结论都会被拒绝。
 */
export function parseRecoveryCapsuleReport(
  raw: unknown,
  evidence: TranscriptCoverageEvidence,
): RecoveryCapsuleReportParse {
  const report = readRecord(raw, 'capsule');
  if (!report.ok) {
    return report;
  }
  const coverage = report.value['coverage'];
  if (coverage !== 'complete' && coverage !== 'partial') {
    return { ok: false, reason: 'coverage 必须是 complete 或 partial' };
  }
  const range = readRecord(report.value['readableRange'], 'readableRange');
  if (!range.ok) {
    return range;
  }
  const transcriptRef = readNullableString(range.value['transcriptRef'], 'readableRange.transcriptRef');
  if (!transcriptRef.ok || transcriptRef.value === null) {
    return { ok: false, reason: 'readableRange.transcriptRef 必须是非空字符串' };
  }
  const fromEventRef = readNullableString(range.value['fromEventRef'], 'readableRange.fromEventRef');
  if (!fromEventRef.ok) {
    return fromEventRef;
  }
  const toEventRef = readNullableString(range.value['toEventRef'], 'readableRange.toEventRef');
  if (!toEventRef.ok) {
    return toEventRef;
  }
  const rawGaps = report.value['gaps'];
  if (!Array.isArray(rawGaps)) {
    return { ok: false, reason: 'gaps 必须是数组' };
  }
  const gaps: { fromEventRef: string; toEventRef: string | null; reason: string }[] = [];
  for (const item of rawGaps) {
    const gap = readRecord(item, 'gaps[]');
    if (!gap.ok) {
      return gap;
    }
    const from = readNullableString(gap.value['fromEventRef'], 'gaps[].fromEventRef');
    if (!from.ok || from.value === null) {
      return { ok: false, reason: 'gaps[].fromEventRef 必须是非空字符串' };
    }
    const to = readNullableString(gap.value['toEventRef'], 'gaps[].toEventRef');
    if (!to.ok) {
      return to;
    }
    const reason = readNullableString(gap.value['reason'], 'gaps[].reason');
    if (!reason.ok || reason.value === null) {
      return { ok: false, reason: 'gaps[].reason 必须是非空字符串' };
    }
    gaps.push({ fromEventRef: from.value, toEventRef: to.value, reason: reason.value });
  }
  const lastCompleteEventRef = readNullableString(
    report.value['lastCompleteEventRef'],
    'lastCompleteEventRef',
  );
  if (!lastCompleteEventRef.ok) {
    return lastCompleteEventRef;
  }
  const rawActions = report.value['openActions'];
  if (!Array.isArray(rawActions)) {
    return { ok: false, reason: 'openActions 必须是数组' };
  }
  const openActions: { actionRef: string; description: string; sourceRef: string }[] = [];
  for (const item of rawActions) {
    const action = readRecord(item, 'openActions[]');
    if (!action.ok) {
      return action;
    }
    const actionRef = readNullableString(action.value['actionRef'], 'openActions[].actionRef');
    if (!actionRef.ok || actionRef.value === null) {
      return { ok: false, reason: 'openActions[].actionRef 必须是非空字符串' };
    }
    const description = readNullableString(action.value['description'], 'openActions[].description');
    if (!description.ok || description.value === null) {
      return { ok: false, reason: 'openActions[].description 必须是非空字符串' };
    }
    const sourceRef = readNullableString(action.value['sourceRef'], 'openActions[].sourceRef');
    if (!sourceRef.ok || sourceRef.value === null) {
      return { ok: false, reason: 'openActions[].sourceRef 必须是非空字符串' };
    }
    openActions.push({ actionRef: actionRef.value, description: description.value, sourceRef: sourceRef.value });
  }
  const sourceRefs = readStringArray(report.value['sourceRefs'], 'sourceRefs');
  if (!sourceRefs.ok) {
    return sourceRefs;
  }
  const unknowns = readStringArray(report.value['unknowns'], 'unknowns');
  if (!unknowns.ok) {
    return unknowns;
  }
  const capsule: RecoveryCapsule = {
    coverage,
    readableRange: {
      transcriptRef: transcriptRef.value,
      fromEventRef: fromEventRef.value,
      toEventRef: toEventRef.value,
    },
    gaps,
    lastCompleteEventRef: lastCompleteEventRef.value,
    openActions,
    sourceRefs: sourceRefs.value,
    unknowns: unknowns.value,
  };
  const validated = validateRecoveryCapsule(capsule);
  if (!validated.ok) {
    return { ok: false, reason: validated.reason };
  }
  const coverageValidation = validateTranscriptCoverage(capsule, evidence);
  return coverageValidation.ok
    ? { ok: true, capsule }
    : { ok: false, reason: coverageValidation.reason };
}
