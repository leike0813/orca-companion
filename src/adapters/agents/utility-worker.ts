/**
 * IC-09 / IP-8：受限 Utility Worker 的派发 adapter（Owner: `m1-recover-execution`）。
 *
 * Recovery Capsule 由一个受限 Utility Worker 从**精确 transcript**提取；本模块只负责把它按前驱
 * 已有的派发机制跑起来：同一个 `Task Envelope` 约定（`task-create` 的 `spec` 就是信封 JSON）、
 * 同一条 `worker-start` mutation、同一套 `beginIntent → mutate → settleIntent/blockLane` 顺序，
 * 以及 `session-binding.ts` 的精确绑定核验。它不另建派发流水线、不读 transcript、不解析 Capsule
 * 正文之外的任何东西，也不触发新的 Recovery。
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
import { buildExecutionScope, reconcileOperation } from '../../application/ports/execution-backend.js';
import {
  activatePreparedWorker,
  prepareWorkerLaunch,
  verifyPreparedWorker,
  type WorkerLaunchStrategy,
} from '../../application/worker-launch.js';
import { beginIntent, blockLane, settleIntent } from '../../application/coordination/intent-service.js';
import type { RecoveryCapsule } from '../../application/recovery/recovery-capsule.js';
import type { TranscriptCoverageEvidence } from '../../application/recovery/recovery-capsule.js';
import {
  validateRecoveryCapsule,
  validateTranscriptCoverage,
} from '../../application/recovery/recovery-capsule.js';
import {
  bindCodexSession,
  type HarnessSessionFacts,
  type SessionBindingFailureCode,
} from './session-binding.js';

/** Utility Worker 的 Task Envelope 结构版本；读取到未知版本在边界 fail closed。 */
export const UTILITY_WORKER_ENVELOPE_SCHEMA_VERSION = 1;

/** 唯一登记的受限 Utility 任务类别：从精确 transcript 生成 Recovery Capsule。 */
export const RECOVERY_CAPSULE_TASK_KIND = 'recovery-capsule-extraction';

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
 * 复用 `bindCodexSession` 的全部规则（harness、session 身份、transcript 来源、观察时间窗、身份
 * 变更），只把返回值换成不含业务角色的形状——Utility Worker 不是 Planner / Implementation /
 * Validator / Finalizer 中的任何一个。
 */
export function bindUtilityWorkerSession(
  facts: HarnessSessionFacts,
  options: { readonly identityChanged?: boolean } = {},
): UtilityWorkerBindingResult {
  const bound = bindCodexSession(facts, options);
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

function readRecordField(value: unknown, keys: readonly string[]): string | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  return null;
}

/** `task-create` 回执里可核验的 Orca Task 身份；缺失即不可核验。 */
export function orcaTaskIdFromReceipt(value: unknown): string | null {
  return readRecordField(value, ['id', 'taskId', 'task_id']);
}

/** `worker-start` 回执里可核验的 Dispatch 身份；缺失即不可核验。 */
export function dispatchIdFromReceipt(value: unknown): string | null {
  return readRecordField(value, ['dispatchId', 'dispatch_id']);
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

function freshRevision(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
): number | null {
  const scope = store.query({ kind: 'scope', coordinationScopeId });
  return scope.kind === 'scope' && scope.scope !== null ? scope.scope.revision : null;
}

function scopeOf(
  input: UtilityWorkerDispatchInput,
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
  input: UtilityWorkerDispatchInput,
  operationId: OperationId,
  target: { readonly kind: string; readonly id: string },
  category: string,
  mutation: ExecutionMutation,
): Promise<ProtectedMutation> {
  const revision = freshRevision(input.store, input.coordinationScopeId);
  if (revision === null) {
    return { kind: 'blocked', laneKey: category, reason: '无法读取 Scope revision' };
  }
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

  const outcome = await input.backend.mutate(
    mutation,
    scopeOf(input, operationId, target, revision),
  );
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
    const blockRevision = freshRevision(input.store, input.coordinationScopeId);
    if (blockRevision !== null) {
      blockLane(input.store, {
        coordinationScopeId: input.coordinationScopeId,
        operationId,
        writer: input.writer,
        expectedRevision: blockRevision,
        reason: '受限 Utility Worker 的调用结果未知，缺少副作用是否发生的证明',
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
export async function dispatchUtilityWorker(
  input: UtilityWorkerDispatchInput,
): Promise<UtilityWorkerDispatchResult> {
  const taskTarget = { kind: 'work-package', id: input.envelope.workPackageId };
  const created = await runProtected(input, input.operationIds.task, taskTarget, 'task-create', {
    operation: 'task-create',
    spec: JSON.stringify(input.envelope),
    ...(input.taskTitle === undefined ? {} : { taskTitle: input.taskTitle }),
    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
  });
  if (created.kind === 'blocked') {
    return created;
  }
  if (created.kind === 'unknown') {
    return created;
  }
  if (created.kind === 'rejected') {
    return created;
  }
  const orcaTaskId = orcaTaskIdFromReceipt(created.value);
  if (orcaTaskId === null) {
    return { kind: 'unknown', operationId: created.operationId, reason: 'task-create 回执缺少可核验的 task id' };
  }

  const launch = await prepareWorkerLaunch({
    backend: input.backend,
    strategy: input.workerLaunch,
    worktreeId: input.worktree,
    ...(input.worktree.startsWith('path:') ? { worktreePath: input.worktree.slice('path:'.length) } : {}),
    timeoutMs: input.execution.timeoutMs,
    createTerminal: async (mutation) => {
      const prepared = await runProtected(
        input,
        input.operationIds.workerPrepare,
        taskTarget,
        'worker-terminal-prepare',
        mutation,
      );
      return prepared.kind === 'accepted' ? { kind: 'accepted' as const } : prepared;
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
  const dispatchId = dispatchIdFromReceipt(started.value);
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

  const facts = await input.observeSession({ dispatchId, envelope: input.envelope });
  if (facts === null) {
    return {
      kind: 'binding_unavailable',
      code: 'session_not_reported',
      message: '无法观察到该 Utility Worker 的精确 harness session 事实',
    };
  }
  const bound = bindUtilityWorkerSession(facts);
  if (bound.kind === 'unavailable') {
    return { kind: 'binding_unavailable', code: bound.code, message: bound.message };
  }
  return { kind: 'dispatched', envelope: input.envelope, orcaTaskId, dispatchId, binding: bound.binding };
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
