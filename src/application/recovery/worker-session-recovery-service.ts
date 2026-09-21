/**
 * IC-09 / IP-5、IP-6、IP-7：Worker Session Recovery 用例（Owner: `m1-recover-execution`）。
 *
 * 这是 Worker Harness session 中断后唯一的恢复入口，覆盖 Specification Planner、Implementation、
 * Validator 与 Finalizer 四类角色。Coordinator Session 不进入它：入口对 Coordinator 主体直接返回
 * `not_worker_recovery`，不写 RecoveryId、Session Segment 或 Recovery Capsule。
 *
 * 固定顺序（每一步失败都保持可对账，不产生第二次副作用）：
 *
 * 1. 观察中断，按精确 Session Binding 核验归属；证据不足即保持未决，不推断退出也不派发；
 * 2. 先尝试精确恢复原会话；只有确认原会话不可恢复才进入替代流程；
 * 3. 替代流程：workspace 对账 → Recovery Budget（上限只读已批准 Manifest）→ 原会话终态 race →
 *    Capsule（Finalizer 不需要）→ 角色门；
 * 4. 建 Recovery → 预写 Operation Intent → 进 `recovering`：预写紧贴替代派发，并用同一条
 *    `advance-recovery` 写回 `prewriteOperationId`；Capsule 或角色门失败时因此不会留下悬空的派发意图；
 * 5. 派发替代 Session 并核验精确 Session Binding；
 * 6. 用**一条** `advance-recovery` 在同一事务内写入替代 Session Segment、把 Recovery 终结为
 *    `recovered` + `replaced`，并递增该 Worker Attempt 的 Recovery Budget（`consumedBudget`
 *    单调不减；store 对同一 `segmentId` 幂等，重放不会写出第二条 Segment 或重复消耗额度）。
 *
 * 替代 Session 保留原 Worker Task、Task Contract、revision 与业务 Attempt 身份，只创建新的 Dispatch、
 * Session Binding 与 Session Segment；原 Dispatch 与原 Segment 的绑定绝不复用。原 Session 在替代
 * Dispatch 被接受之前到达有效终态时，以该终态结束 Recovery 并把原 Segment 标记为 superseded。
 *
 * 本模块不生成 Capsule 正文、不读 transcript、不写 Orca DB，也不新建 worktree 冒充原 Attempt。
 */

import type {
  CoordinationScopeId,
  DispatchId,
  OperationId,
  RecoveryId,
  SessionSegmentId,
  WorkerTaskId,
  WorkPackageId,
} from '../dto/identity.js';
import type { OperationOutcome } from '../dto/operation-outcome.js';
import type { OperationIntent } from '../dto/operation-intent.js';
import type {
  BranchCoordinationStore,
  CoordinationWriter,
  RecoveryRecord,
  RecoveryState,
  RecoveryTerminalOutcome,
  ReplacementSegmentInput,
  SessionSegmentRecord,
} from '../ports/branch-coordination-store.js';
import type { ExecutionBackend, ExecutionMutation, ExecutionScope } from '../ports/execution-backend.js';
import { buildExecutionScope, reconcileOperation } from '../ports/execution-backend.js';
import { beginIntent, blockLane, settleIntent } from '../coordination/intent-service.js';
import { activeAuthorization, recoveryAllowance } from '../planning/authorization-service.js';
import { readScope } from '../planning/scope-read.js';
import type { WorkerRole } from '../../domain/planning/execution-authorization.js';
import type { TerminalLivenessFacts } from '../../domain/worker-liveness.js';
import {
  consumedRecoveryBudget,
  recoveryConsumptionOnReplacement,
} from '../../domain/recovery/recovery-budget.js';
import {
  decideRecoveryEntry,
  type RecoveryBindingObservation,
  type RecoveryLifecyclePhase,
  type WorkerSessionRecoverySubject,
} from '../../domain/recovery/worker-session-recovery.js';
import { evaluateRoleGate, roleGateRequiresCapsule, type RoleGateFacts } from '../../domain/recovery/role-gate.js';
import {
  activatePreparedWorker,
  prepareWorkerLaunch,
  verifyPreparedWorker,
  type WorkerLaunchFailure,
  type WorkerLaunchStrategy,
  type WorkerLaunchMutationResult,
} from '../worker-launch.js';
import {
  capsuleRefOf,
  extractRecoveryCapsule,
  type RecoveryCapsuleExtractor,
} from './recovery-capsule.js';

/** RecoveryId 由中断来源事实确定性派生：重启后命中同一条，而不是新建。 */
export function deriveRecoveryId(
  coordinationScopeId: CoordinationScopeId,
  sourceSegmentId: SessionSegmentId,
): RecoveryId {
  return `recovery:${coordinationScopeId}:${sourceSegmentId}` as RecoveryId;
}

/** 替代派发的稳定 OperationId：同一 Recovery 的续办与恢复重放共用它。 */
export function deriveReplacementOperationId(recoveryId: RecoveryId): OperationId {
  return `op:${recoveryId}:replacement-dispatch` as OperationId;
}

/** prepared terminal 建立使用独立 OperationId；不能与正式 Dispatch 共用请求身份。 */
export function deriveReplacementTerminalOperationId(recoveryId: RecoveryId): OperationId {
  return `op:${recoveryId}:replacement-terminal` as OperationId;
}

export function deriveReplacementTerminalActivationOperationId(recoveryId: RecoveryId): OperationId {
  return `op:${recoveryId}:replacement-terminal-activate` as OperationId;
}

/** 替代 Segment 的稳定 ID：崩溃后重放不会创建第二条 Segment。 */
export function deriveReplacementSegmentId(recoveryId: RecoveryId): SessionSegmentId {
  return `segment:${recoveryId}:replacement` as SessionSegmentId;
}

/** workspace 对账事实：丢失与无法对账都失败并阻塞，绝不新建 worktree。 */
export type WorkspaceReconciliation =
  | { readonly kind: 'reconciled'; readonly worktreeId: string; readonly head: string }
  | { readonly kind: 'lost'; readonly reason: string }
  | { readonly kind: 'unverifiable'; readonly reason: string };

/** 替代派发前原会话的终态观察；`unverifiable` 不当作已到达。 */
export type SourceTerminalObservation =
  | { readonly kind: 'reached'; readonly terminalReceiptRef: string }
  | { readonly kind: 'not_reached' }
  | { readonly kind: 'unverifiable'; readonly reason: string };

export type ExactRecoveryAttemptRequest = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly role: WorkerRole;
  readonly workPackageId: WorkPackageId;
  readonly workerTaskId: WorkerTaskId;
  readonly businessAttemptId: string;
  readonly segment: SessionSegmentRecord;
  readonly sessionBindingId: string;
  readonly providerSessionId: string;
};

export type ExactRecoveryOutcome =
  | { readonly kind: 'resumed'; readonly sessionBindingId: string }
  | { readonly kind: 'unrecoverable'; readonly reason: string }
  | { readonly kind: 'unverifiable'; readonly reason: string };

/** 精确恢复原会话的执行 seam；真实实现由 Worker Harness Adapter 提供。 */
export type ExactRecoveryAttempt = (request: ExactRecoveryAttemptRequest) => Promise<ExactRecoveryOutcome>;

/** 替代派发的精确 Session Binding；缺任一项都不能当作可接续的会话。 */
export type ReplacementSessionReceipt = {
  readonly dispatchId: string;
  readonly sessionBindingId: string;
  readonly transcriptRef: string;
};

export type ReplacementDispatchInterpreter = (
  outcome: Extract<OperationOutcome<unknown>, { readonly kind: 'accepted' }>,
) => ReplacementSessionReceipt | { readonly failure: string };

/** Worker Profile 选择：默认复用该角色原 Profile；切换必须显式带上授权引用。 */
export type ReplacementProfileSelection =
  | { readonly kind: 'reuse'; readonly profileRef: string }
  | { readonly kind: 'alternate'; readonly profileRef: string; readonly authorizationRef: string };

/**
 * 解析替代 Session 使用的 Worker Profile。
 *
 * Manifest 没有「允许兼容替代 Profile」的字段，因此默认路径永远是复用角色原 Profile；调用方只能
 * 在存在显式授权事实时给出 `alternate`，本函数不会自行放宽。
 */
export function resolveReplacementProfile(selection: ReplacementProfileSelection): {
  readonly profileRef: string;
  readonly usedAlternate: boolean;
} {
  return selection.kind === 'alternate'
    ? { profileRef: selection.profileRef, usedAlternate: true }
    : { profileRef: selection.profileRef, usedAlternate: false };
}

export type RecoveryExecutionContext = {
  readonly backendIdentityRef: string;
  readonly graphGeneration: number;
  readonly authorizationId: string;
  readonly runId: string;
  readonly consumerGeneration: number;
  readonly timeoutMs: number;
};

export type ReplacementDispatch = {
  readonly profile: ReplacementProfileSelection;
  readonly workerLaunch: WorkerLaunchStrategy;
  readonly interpretReceipt: ReplacementDispatchInterpreter;
};

export type RecoverWorkerSessionInput = {
  readonly store: BranchCoordinationStore;
  readonly backend: ExecutionBackend;
  readonly writer: CoordinationWriter;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly subject: WorkerSessionRecoverySubject;
  readonly role: WorkerRole;
  readonly workPackageId: WorkPackageId;
  readonly workerTaskId: WorkerTaskId;
  readonly businessAttemptId: string;
  readonly sourceSegmentId: SessionSegmentId;
  readonly sourceDispatchId: DispatchId;
  /** 当前观察到的 harness 绑定；缺字段即无法证明归属。 */
  readonly observation: RecoveryBindingObservation;
  /** 复用 IC-07 的三值存活事实。 */
  readonly liveness: TerminalLivenessFacts;
  readonly resumeExact: ExactRecoveryAttempt;
  readonly workspace: WorkspaceReconciliation;
  readonly sourceTerminal: SourceTerminalObservation;
  readonly roleGate: RoleGateFacts;
  readonly extractCapsule: RecoveryCapsuleExtractor;
  readonly execution: RecoveryExecutionContext;
  readonly replacement: ReplacementDispatch;
};

export const RECOVERY_BLOCK_CODES = [
  'workspace_lost',
  'budget_exhausted',
  'authorization_unreadable',
  'transcript_unavailable',
  'capsule_failed',
  'role_gate_blocked',
  'task_not_materialized',
  'lane_blocked',
  'dispatch_unconfirmed',
  'dispatch_identity_unknown',
  'invalid_state',
] as const;

export type RecoveryBlockCode = (typeof RECOVERY_BLOCK_CODES)[number];

export type RecoverWorkerSessionResult =
  | { readonly kind: 'not_worker_recovery'; readonly reason: string }
  | {
      readonly kind: 'unverifiable_hold';
      readonly recoveryId: RecoveryId;
      readonly phase: 'unverifiable';
      readonly reason: string;
    }
  | {
      readonly kind: 'exact_recovery';
      readonly recoveryId: RecoveryId;
      readonly phase: RecoveryLifecyclePhase;
      readonly sessionBindingId: string;
    }
  | {
      readonly kind: 'alternate_created';
      readonly recoveryId: RecoveryId;
      readonly phase: 'replaced';
      readonly replacementDispatchId: string;
      readonly replacementSegmentId: SessionSegmentId;
      readonly replacementSessionBindingId: string;
      readonly consumedBudget: number;
      readonly profileRef: string;
      readonly usedAlternateProfile: boolean;
    }
  | {
      readonly kind: 'source_completed';
      readonly recoveryId: RecoveryId;
      readonly phase: 'superseded';
      readonly supersededSegmentId: SessionSegmentId;
      readonly terminalReceiptRef: string;
    }
  | {
      readonly kind: 'already_concluded';
      readonly recoveryId: RecoveryId;
      readonly status: RecoveryState;
      readonly terminalOutcome: RecoveryTerminalOutcome | null;
    }
  | {
      readonly kind: 'blocked';
      readonly recoveryId: RecoveryId;
      readonly code: RecoveryBlockCode;
      readonly reason: string;
    }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

type AdvanceRecoveryFields = {
  readonly status: RecoveryState;
  readonly replacementDispatchId?: string;
  readonly replacementSegmentId?: SessionSegmentId;
  readonly replacementSessionBindingId?: string;
  readonly supersededSegmentId?: SessionSegmentId;
  readonly capsuleRef?: string;
  readonly prewriteOperationId?: OperationId;
  readonly terminalOutcome?: RecoveryTerminalOutcome | null;
  readonly blockingReason?: string | null;
  readonly consumedBudget?: number;
  /** 与本次推进同事务写入的替代 Session Segment；只在 `status: 'recovered'` 时允许。 */
  readonly replacementSegment?: ReplacementSegmentInput;
};

function freshRevision(store: BranchCoordinationStore, coordinationScopeId: CoordinationScopeId): number | null {
  const scope = readScope(store, coordinationScopeId);
  return scope.kind === 'rejected' ? null : scope.scope.revision;
}

function readRecovery(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
  recoveryId: RecoveryId,
): RecoveryRecord | null {
  const result = store.query({ kind: 'recovery', coordinationScopeId, recoveryId });
  return result.kind === 'recovery' ? result.recovery : null;
}

function readRecoveriesForAttempt(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
  businessAttemptId: string,
): readonly RecoveryRecord[] | null {
  const result = store.query({ kind: 'recoveries', coordinationScopeId, businessAttemptId });
  return result.kind === 'recoveries' ? result.recoveries : null;
}

function findRecoveryBySourceSegment(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
  sourceSegmentId: SessionSegmentId,
): RecoveryRecord | null {
  const result = store.query({ kind: 'recoveries', coordinationScopeId });
  if (result.kind !== 'recoveries') {
    return null;
  }
  return result.recoveries.find((recovery) => recovery.sourceSegmentId === sourceSegmentId) ?? null;
}

function readIntent(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
  operationId: OperationId,
): OperationIntent | null {
  const result = store.query({ kind: 'intent', coordinationScopeId, operationId });
  return result.kind === 'intent' ? result.intent : null;
}

type RecoveryWrite = { readonly kind: 'committed'; readonly revision: number } | { readonly kind: 'failed'; readonly message: string };

function transactRecovery(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
  writer: CoordinationWriter,
  recoveryId: RecoveryId,
  fields: AdvanceRecoveryFields,
): RecoveryWrite {
  const revision = freshRevision(store, coordinationScopeId);
  if (revision === null) {
    return { kind: 'failed', message: '无法读取 Scope revision' };
  }
  const result = store.transact({
    kind: 'advance-recovery',
    coordinationScopeId,
    expectedRevision: revision,
    writer,
    recoveryId,
    ...fields,
  });
  return result.kind === 'rejected' ? { kind: 'failed', message: result.message } : { kind: 'committed', revision: result.revision };
}

type SourceSegmentRead =
  | { readonly kind: 'read'; readonly segment: SessionSegmentRecord }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unreadable'; readonly code: string; readonly message: string };

function readSourceSegment(input: RecoverWorkerSessionInput): SourceSegmentRead {
  const result = input.store.query({
    kind: 'session-segments',
    coordinationScopeId: input.coordinationScopeId,
    workPackageId: input.workPackageId,
  });
  if (result.kind === 'rejected') {
    return { kind: 'unreadable', code: result.code, message: result.message };
  }
  if (result.kind !== 'session-segments') {
    return { kind: 'unreadable', code: 'invalid_state', message: 'Session Segment 查询返回了错误的结果种类' };
  }
  const segment = result.segments.find((entry) => entry.segmentId === input.sourceSegmentId);
  return segment === undefined ? { kind: 'missing' } : { kind: 'read', segment };
}

/** 中断 Segment 的归属必须与本次 Recovery 的业务身份逐项一致，否则只能拒绝。 */
function segmentIdentityMismatch(input: RecoverWorkerSessionInput, segment: SessionSegmentRecord): string | null {
  if (segment.role !== input.role) return 'role';
  if (segment.workerTaskId !== input.workerTaskId) return 'workerTaskId';
  if (segment.dispatchId !== input.sourceDispatchId) return 'dispatchId';
  if (segment.attemptId !== input.businessAttemptId) return 'businessAttemptId';
  return null;
}

type EnsureRecoveryResult =
  | { readonly kind: 'ok'; readonly recovery: RecoveryRecord }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

/**
 * 取得本次中断的 Recovery 记录。
 *
 * RecoveryId 由中断来源事实确定性派生，因此重启后先按 ID 命中同一条；即使调用方换了 ID，只要
 * `(coordinationScopeId, sourceSegmentId)` 已有记录，也续办那一条而不是新建。
 */
function ensureRecoveryRecord(input: RecoverWorkerSessionInput): EnsureRecoveryResult {
  const derivedId = deriveRecoveryId(input.coordinationScopeId, input.sourceSegmentId);
  const byId = readRecovery(input.store, input.coordinationScopeId, derivedId);
  if (byId !== null) {
    return { kind: 'ok', recovery: byId };
  }
  const bySegment = findRecoveryBySourceSegment(input.store, input.coordinationScopeId, input.sourceSegmentId);
  if (bySegment !== null) {
    return { kind: 'ok', recovery: bySegment };
  }
  const revision = freshRevision(input.store, input.coordinationScopeId);
  if (revision === null) {
    return { kind: 'rejected', code: 'invalid_state', message: '无法读取 Scope revision' };
  }
  const recorded = input.store.transact({
    kind: 'record-recovery',
    coordinationScopeId: input.coordinationScopeId,
    expectedRevision: revision,
    writer: input.writer,
    recoveryId: derivedId,
    role: input.role,
    workPackageId: input.workPackageId,
    workerTaskId: input.workerTaskId,
    businessAttemptId: input.businessAttemptId,
    sourceSegmentId: input.sourceSegmentId,
    sourceDispatchId: input.sourceDispatchId,
  });
  if (recorded.kind === 'rejected') {
    // 并发落在同一条中断 Segment 上：回读既有记录，绝不产生第二行。
    const raced =
      readRecovery(input.store, input.coordinationScopeId, derivedId) ??
      findRecoveryBySourceSegment(input.store, input.coordinationScopeId, input.sourceSegmentId);
    if (raced !== null) {
      return { kind: 'ok', recovery: raced };
    }
    return { kind: 'rejected', code: recorded.code, message: recorded.message };
  }
  const read =
    readRecovery(input.store, input.coordinationScopeId, derivedId) ??
    findRecoveryBySourceSegment(input.store, input.coordinationScopeId, input.sourceSegmentId);
  if (read === null) {
    return { kind: 'rejected', code: 'invalid_state', message: 'Recovery 写入后无法读回' };
  }
  return { kind: 'ok', recovery: read };
}

/** 失败并阻塞：写入 `failed` 终态与阻塞原因，供用户或重规划处理。 */
function blockRecovery(
  input: RecoverWorkerSessionInput,
  recovery: RecoveryRecord,
  code: RecoveryBlockCode,
  reason: string,
): RecoverWorkerSessionResult {
  if (recovery.status === 'pending' || recovery.status === 'recovering') {
    transactRecovery(input.store, input.coordinationScopeId, input.writer, recovery.recoveryId, {
      status: 'blocked',
      terminalOutcome: 'failed',
      blockingReason: reason,
    });
  }
  return { kind: 'blocked', recoveryId: recovery.recoveryId, code, reason };
}

/** 一条「已发过替代派发、但收尾不可证明」的 Recovery 及其预写意图。 */
type UnprovableRecoveryConsumption = {
  readonly recovery: RecoveryRecord;
  readonly operationId: OperationId;
};

/**
 * 找出同一 Worker Attempt 上无法证明「未消耗恢复额度」的替代派发。
 *
 * 判定条件（三项同时成立）：该 Recovery 没有 `replacementSegmentId`（收尾没落盘）、有
 * `prewriteOperationId`（预写过派发意图），且该意图已经按 `accepted` 收尾——这意味着那次替代
 * 派发确实发出过。已终结的 Recovery 不在判定范围内。
 *
 * 读不回来时不在这里猜：预算读取路径会以 `authorization_unreadable` 独立 fail closed。
 */
function findUnprovableRecoveryConsumption(
  input: RecoverWorkerSessionInput,
): UnprovableRecoveryConsumption | null {
  const recoveries = readRecoveriesForAttempt(
    input.store,
    input.coordinationScopeId,
    input.businessAttemptId,
  );
  if (recoveries === null) {
    return null;
  }
  for (const recovery of recoveries) {
    if (recovery.replacementSegmentId !== null) continue;
    if (recovery.prewriteOperationId === null) continue;
    if (recovery.status === 'recovered' || recovery.status === 'cancelled') continue;
    const intent = readIntent(input.store, input.coordinationScopeId, recovery.prewriteOperationId);
    if (intent !== null && intent.state === 'settled' && intent.outcomeClass === 'accepted') {
      return { recovery, operationId: recovery.prewriteOperationId };
    }
  }
  return null;
}

/**
 * 把「不可证明」的阻塞落到真正持有该状态的那条 Recovery 上，使它可观测。
 *
 * 只把 `pending` / `recovering` 推进到 `blocked` + `failed`：这正是该 Recovery 自己续办时会得到的
 * 结论（见 `enterRecoveringWithPrewrite`），所以不改变任何合法路径；已经 blocked 的记录保持原样，
 * 不覆盖既有原因。绝不写 `consumedBudget`，因此不会把已消耗额度改小。
 */
function markUnprovableRecoveryBlocked(
  input: RecoverWorkerSessionInput,
  recovery: RecoveryRecord,
  reason: string,
): void {
  if (recovery.status !== 'pending' && recovery.status !== 'recovering') {
    return;
  }
  transactRecovery(input.store, input.coordinationScopeId, input.writer, recovery.recoveryId, {
    status: 'blocked',
    terminalOutcome: 'failed',
    blockingReason: reason,
  });
}

/** 原会话在替代派发前到达有效终态：以 `source_completed` 结束并 supersede 原 Segment。 */
function concludeSourceCompleted(
  input: RecoverWorkerSessionInput,
  recovery: RecoveryRecord,
  terminalReceiptRef: string,
): RecoverWorkerSessionResult {
  if (recovery.status === 'pending' || recovery.status === 'blocked') {
    const entered = transactRecovery(input.store, input.coordinationScopeId, input.writer, recovery.recoveryId, {
      status: 'recovering',
    });
    if (entered.kind === 'failed') {
      return { kind: 'blocked', recoveryId: recovery.recoveryId, code: 'invalid_state', reason: entered.message };
    }
  }
  const concluded = transactRecovery(input.store, input.coordinationScopeId, input.writer, recovery.recoveryId, {
    status: 'recovered',
    terminalOutcome: 'source_completed',
    supersededSegmentId: recovery.sourceSegmentId,
  });
  if (concluded.kind === 'failed') {
    return { kind: 'blocked', recoveryId: recovery.recoveryId, code: 'invalid_state', reason: concluded.message };
  }
  return {
    kind: 'source_completed',
    recoveryId: recovery.recoveryId,
    phase: 'superseded',
    supersededSegmentId: recovery.sourceSegmentId,
    terminalReceiptRef,
  };
}

function alternateCreatedResult(
  recovery: RecoveryRecord,
  profileRef: string,
  usedAlternateProfile: boolean,
): RecoverWorkerSessionResult {
  if (
    recovery.replacementDispatchId === null ||
    recovery.replacementSegmentId === null ||
    recovery.replacementSessionBindingId === null
  ) {
    return {
      kind: 'blocked',
      recoveryId: recovery.recoveryId,
      code: 'invalid_state',
      reason: 'Recovery 已登记替代派发但缺少完整的替代 Dispatch / Segment / Binding 身份',
    };
  }
  return {
    kind: 'alternate_created',
    recoveryId: recovery.recoveryId,
    phase: 'replaced',
    replacementDispatchId: recovery.replacementDispatchId,
    replacementSegmentId: recovery.replacementSegmentId,
    replacementSessionBindingId: recovery.replacementSessionBindingId,
    consumedBudget: recovery.consumedBudget,
    profileRef,
    usedAlternateProfile,
  };
}

type PrewriteResult =
  | { readonly kind: 'ready'; readonly recovery: RecoveryRecord; readonly operationId: OperationId }
  | { readonly kind: 'blocked'; readonly code: RecoveryBlockCode; readonly reason: string };

/**
 * 预写替代派发的 Operation Intent 并进入 `recovering`。
 *
 * 顺序固定为「预写 intent → 进 recovering」，`prewriteOperationId` 随同一次 `advance-recovery` 写回，
 * 因此重启后能沿同一 intent 续办。已经登记过预写意图时按它的状态判定：`blocked`、或缺少确定结论的
 * 未决意图，都不能重复派发。
 */
function enterRecoveringWithPrewrite(input: RecoverWorkerSessionInput, recovery: RecoveryRecord): PrewriteResult {
  const operationId = deriveReplacementOperationId(recovery.recoveryId);
  const existingIntent = readIntent(input.store, input.coordinationScopeId, operationId);

  // 已存在的预写意图只在能证明「尚未派发」时才允许续办；已阻塞或已收尾的意图都不能重复派发，
  // 否则会在 Orca 侧产生第二个替代 Dispatch。
  if (existingIntent !== null && existingIntent.state === 'blocked') {
    return {
      kind: 'blocked',
      code: 'lane_blocked',
      reason: `替代派发意图 ${operationId} 已阻塞：${existingIntent.blockingReason ?? '原因未知'}`,
    };
  }
  if (existingIntent !== null && existingIntent.state === 'settled') {
    return {
      kind: 'blocked',
      code: 'dispatch_identity_unknown',
      reason: `替代派发意图 ${operationId} 已收尾但缺少可核验的替代 Dispatch 身份，不能重复派发也不能猜测`,
    };
  }

  if (recovery.status === 'recovering') {
    if (recovery.prewriteOperationId === null) {
      return {
        kind: 'blocked',
        code: 'invalid_state',
        reason: 'Recovery 已进入 recovering 但没有预写的 Operation Intent',
      };
    }
    return {
      kind: 'blocked',
      code: 'dispatch_unconfirmed',
      reason:
        existingIntent === null
          ? '预写的替代派发意图读不回来，不能凭猜测继续'
          : `替代派发意图 ${operationId} 仍未确定，不能重复派发`,
    };
  }

  const revision = freshRevision(input.store, input.coordinationScopeId);
  if (revision === null) {
    return { kind: 'blocked', code: 'invalid_state', reason: '无法读取 Scope revision' };
  }
  const began = beginIntent(input.store, {
    coordinationScopeId: input.coordinationScopeId,
    operationId,
    target: { kind: 'worker-task', id: input.workerTaskId },
    operationCategory: 'worker-dispatch',
    writer: input.writer,
    expectedRevision: revision,
  });
  if (began.kind === 'lane_blocked') {
    return {
      kind: 'blocked',
      code: 'lane_blocked',
      reason: `派发 lane 已被未决意图 ${began.blockingIntent.operationId} 阻塞`,
    };
  }
  if (began.kind === 'lane_busy') {
    return {
      kind: 'blocked',
      code: 'lane_blocked',
      reason: `派发 lane 上已有未决意图 ${began.activeIntent.operationId}`,
    };
  }
  if (began.kind === 'rejected') {
    return { kind: 'blocked', code: 'lane_blocked', reason: began.rejection.message };
  }
  const advanced = transactRecovery(input.store, input.coordinationScopeId, input.writer, recovery.recoveryId, {
    status: 'recovering',
    prewriteOperationId: operationId,
  });
  if (advanced.kind === 'failed') {
    return { kind: 'blocked', code: 'invalid_state', reason: advanced.message };
  }
  const read = readRecovery(input.store, input.coordinationScopeId, recovery.recoveryId);
  if (read === null) {
    return { kind: 'blocked', code: 'invalid_state', reason: 'Recovery 推进后无法读回' };
  }
  return { kind: 'ready', recovery: read, operationId };
}

function executionScopeOf(
  input: RecoverWorkerSessionInput,
  operationId: OperationId,
  expectedRevision: number,
): ExecutionScope {
  return buildExecutionScope({
    coordinationScopeId: input.coordinationScopeId,
    coordinatorSessionId: input.writer.coordinatorSessionId,
    runtimeIncarnationId: input.writer.runtimeIncarnationId,
    fencingGeneration: input.writer.fencingGeneration,
    backendIdentityRef: input.execution.backendIdentityRef,
    operationId,
    target: { kind: 'worker-task', id: input.workerTaskId },
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

async function runReplacementTerminalMutation(
  input: RecoverWorkerSessionInput,
  operationId: OperationId,
  operationCategory: 'worker-terminal-prepare' | 'worker-terminal-activate',
  mutation: Extract<ExecutionMutation, { operation: 'terminal-create' | 'terminal-submit' }>,
): Promise<WorkerLaunchMutationResult> {
  const revision = freshRevision(input.store, input.coordinationScopeId);
  if (revision === null) {
    return { kind: 'blocked', laneKey: operationId, reason: '无法读取 Scope revision' };
  }
  const begun = beginIntent(input.store, {
    coordinationScopeId: input.coordinationScopeId,
    operationId,
    target: { kind: 'worker-task', id: input.workerTaskId },
    operationCategory,
    writer: input.writer,
    expectedRevision: revision,
  });
  if (begun.kind === 'lane_blocked') {
    return {
      kind: 'blocked',
      laneKey: begun.laneKey,
      reason: `terminal 准备 lane 已被未决意图 ${begun.blockingIntent.operationId} 阻塞`,
    };
  }
  if (begun.kind === 'lane_busy') {
    return {
      kind: 'blocked',
      laneKey: begun.laneKey,
      reason: `terminal 准备 lane 上已有未决意图 ${begun.activeIntent.operationId}`,
    };
  }
  if (begun.kind === 'rejected') {
    return { kind: 'blocked', laneKey: operationId, reason: begun.rejection.message };
  }

  const outcome = await input.backend.mutate(
    mutation,
    executionScopeOf(input, operationId, revision),
  );
  const settled = settleIntent(input.store, {
    coordinationScopeId: input.coordinationScopeId,
    operationId,
    writer: input.writer,
    expectedRevision: freshRevision(input.store, input.coordinationScopeId) ?? revision,
    outcome,
  });
  if (settled.kind === 'rejected') {
    return { kind: 'blocked', laneKey: operationId, reason: settled.rejection.message };
  }
  if (outcome.kind === 'rejected') {
    return outcome;
  }
  if (outcome.kind === 'unknown') {
    const blockRevision = freshRevision(input.store, input.coordinationScopeId);
    if (blockRevision !== null) {
      blockLane(input.store, {
        coordinationScopeId: input.coordinationScopeId,
        operationId,
        writer: input.writer,
        expectedRevision: blockRevision,
        reason: 'prepared terminal 操作结果未知，缺少副作用是否发生的证明',
      });
    }
    const reconciled = await reconcileOperation(input.backend, outcome.operation);
    return {
      kind: 'unknown',
      operationId,
      reason: `prepared terminal 操作结果未知（对账结论 ${reconciled.kind}），lane 保持阻塞`,
    };
  }
  return { kind: 'accepted' };
}

function launchFailureReason(failure: WorkerLaunchFailure): string {
  return failure.kind === 'rejected' ? `${failure.code}: ${failure.message}` : failure.reason;
}

function readOrcaTaskId(input: RecoverWorkerSessionInput): string | null {
  const result = input.store.query({
    kind: 'materialization-bindings',
    coordinationScopeId: input.coordinationScopeId,
    workPackageId: input.workPackageId,
  });
  if (result.kind !== 'materialization-bindings' || result.bindings.length !== 1) {
    return null;
  }
  return result.bindings[0]?.orcaTaskId ?? null;
}

type SettleOutcome = { readonly kind: 'settled' } | { readonly kind: 'failed'; readonly message: string };

function settleAccepted(
  input: RecoverWorkerSessionInput,
  operationId: OperationId,
  outcome: OperationOutcome<unknown>,
): SettleOutcome {
  const revision = freshRevision(input.store, input.coordinationScopeId);
  if (revision === null) {
    return { kind: 'failed', message: '无法读取 Scope revision' };
  }
  const settled = settleIntent(input.store, {
    coordinationScopeId: input.coordinationScopeId,
    operationId,
    writer: input.writer,
    expectedRevision: revision,
    outcome,
  });
  return settled.kind === 'rejected' ? { kind: 'failed', message: settled.rejection.message } : { kind: 'settled' };
}

/** `unknown` 结果先按原 OperationId 记下 backend request 引用，再阻塞该 lane，不换 ID 重试。 */
function blockUnknownDispatch(
  input: RecoverWorkerSessionInput,
  operationId: OperationId,
  outcome: Extract<OperationOutcome<unknown>, { readonly kind: 'unknown' }>,
): string | null {
  const settled = settleAccepted(input, operationId, outcome);
  if (settled.kind === 'failed') {
    return settled.message;
  }
  const revision = freshRevision(input.store, input.coordinationScopeId);
  if (revision === null) {
    return '无法读取 Scope revision';
  }
  const blocked = blockLane(input.store, {
    coordinationScopeId: input.coordinationScopeId,
    operationId,
    writer: input.writer,
    expectedRevision: revision,
    reason: '替代派发结果未知，缺少副作用是否发生的证明',
  });
  return blocked.kind === 'rejected' ? blocked.rejection.message : null;
}

async function attemptAlternateSession(
  input: RecoverWorkerSessionInput,
  segment: SessionSegmentRecord,
  recovery: RecoveryRecord,
  unrecoverableReason: string,
): Promise<RecoverWorkerSessionResult> {
  const profile = resolveReplacementProfile(input.replacement.profile);
  if (recovery.replacementDispatchId !== null) {
    return alternateCreatedResult(recovery, profile.profileRef, profile.usedAlternate);
  }
  if (input.workspace.kind !== 'reconciled') {
    return blockRecovery(input, recovery, 'workspace_lost', input.workspace.reason);
  }
  const authorization = activeAuthorization(input.store, input.coordinationScopeId);
  if (authorization.kind === 'rejected') {
    return blockRecovery(input, recovery, 'authorization_unreadable', authorization.failure.message);
  }
  const attemptRecoveries = readRecoveriesForAttempt(
    input.store,
    input.coordinationScopeId,
    input.businessAttemptId,
  );
  if (attemptRecoveries === null) {
    return blockRecovery(input, recovery, 'authorization_unreadable', '无法读取该 Worker Attempt 的恢复记录');
  }
  const used = consumedRecoveryBudget(attemptRecoveries, input.businessAttemptId);
  const allowance = recoveryAllowance({ authorization: authorization.authorization, usedRecoveries: used });
  if (allowance.kind === 'not_authorized') {
    // 「尚无有效授权 / 授权读不回来」与「额度耗尽」是两种原因：调用方需要能分辨。
    // 两者都 fail closed，都阻塞而不是继续恢复。
    return blockRecovery(input, recovery, 'authorization_unreadable', allowance.reason);
  }
  if (allowance.kind === 'exhausted') {
    return blockRecovery(
      input,
      recovery,
      'budget_exhausted',
      `Recovery Budget 已达上限（${allowance.limit}）：${unrecoverableReason}`,
    );
  }
  if (input.sourceTerminal.kind === 'reached') {
    return concludeSourceCompleted(input, recovery, input.sourceTerminal.terminalReceiptRef);
  }

  // Capsule 与角色门都在预写 intent 之前：它们失败时不留下悬空的派发意图。
  let capsuleRef: string | null = null;
  if (roleGateRequiresCapsule(input.role)) {
    if (!segment.transcriptReferenceable || segment.lastTranscriptRef === null) {
      return blockRecovery(
        input,
        recovery,
        'transcript_unavailable',
        `Session Segment ${input.sourceSegmentId} 缺少可用 transcript，不能猜测上下文`,
      );
    }
    const extraction = await extractRecoveryCapsule({
      extract: input.extractCapsule,
      request: {
        coordinationScopeId: input.coordinationScopeId,
        role: input.role,
        workPackageId: input.workPackageId,
        workerTaskId: input.workerTaskId,
        attemptId: input.businessAttemptId,
        segmentId: input.sourceSegmentId,
        transcriptRef: segment.lastTranscriptRef,
      },
    });
    if (extraction.kind === 'transcript_unavailable') {
      return blockRecovery(input, recovery, 'transcript_unavailable', extraction.reason);
    }
    if (extraction.kind === 'failed') {
      return blockRecovery(input, recovery, 'capsule_failed', extraction.reason);
    }
    capsuleRef = capsuleRefOf(recovery.recoveryId);
  }
  const gate = evaluateRoleGate(input.roleGate);
  if (gate.kind === 'blocked') {
    return blockRecovery(input, recovery, 'role_gate_blocked', `${gate.code}: ${gate.reason}`);
  }

  const orcaTaskId = readOrcaTaskId(input);
  if (orcaTaskId === null) {
    return blockRecovery(
      input,
      recovery,
      'task_not_materialized',
      '找不到该 Work Package 的物化 Task，无法派发替代 Session',
    );
  }

  const launch = await prepareWorkerLaunch({
    backend: input.backend,
    strategy: input.replacement.workerLaunch,
    worktreeId: input.workspace.worktreeId,
    timeoutMs: input.execution.timeoutMs,
    createTerminal: (mutation) => runReplacementTerminalMutation(
      input,
      deriveReplacementTerminalOperationId(recovery.recoveryId),
      'worker-terminal-prepare',
      mutation,
    ),
  });
  if (launch.kind !== 'ready') {
    return blockRecovery(
      input,
      recovery,
      launch.kind === 'blocked' ? 'lane_blocked' : 'dispatch_unconfirmed',
      launchFailureReason(launch),
    );
  }

  const prewrite = enterRecoveringWithPrewrite(input, recovery);
  if (prewrite.kind === 'blocked') {
    return blockRecovery(input, recovery, prewrite.code, prewrite.reason);
  }
  const revision = freshRevision(input.store, input.coordinationScopeId);
  if (revision === null) {
    return blockRecovery(input, recovery, 'invalid_state', '无法读取 Scope revision');
  }
  const outcome = await input.backend.mutate(
    {
      operation: 'worker-start',
      taskId: orcaTaskId,
      worktree: input.workspace.worktreeId,
      ...launch.worker,
    },
    executionScopeOf(input, prewrite.operationId, revision),
  );

  if (outcome.kind === 'unknown') {
    const reason = blockUnknownDispatch(input, prewrite.operationId, outcome);
    if (reason !== null) {
      return blockRecovery(input, recovery, 'dispatch_unconfirmed', reason);
    }
    const reconciled = await reconcileOperation(input.backend, outcome.operation);
    return blockRecovery(
      input,
      recovery,
      'dispatch_unconfirmed',
      `替代派发结果未知（对账结论 ${reconciled.kind}），lane 保持阻塞`,
    );
  }
  if (outcome.kind === 'rejected') {
    settleAccepted(input, prewrite.operationId, outcome);
    return blockRecovery(input, recovery, 'dispatch_unconfirmed', `替代派发被拒绝：${outcome.message}`);
  }

  const receipt = input.replacement.interpretReceipt(outcome);
  if ('failure' in receipt) {
    settleAccepted(input, prewrite.operationId, outcome);
    return blockRecovery(input, recovery, 'dispatch_unconfirmed', receipt.failure);
  }
  const activated = await activatePreparedWorker({
    backend: input.backend,
    terminal: launch.preparedTerminal,
    submitTerminal: (mutation) => runReplacementTerminalMutation(
      input,
      deriveReplacementTerminalActivationOperationId(recovery.recoveryId),
      'worker-terminal-activate',
      mutation,
    ),
  });
  if (activated.kind !== 'accepted') {
    const revisionToBlock = freshRevision(input.store, input.coordinationScopeId);
    if (revisionToBlock !== null) {
      blockLane(input.store, {
        coordinationScopeId: input.coordinationScopeId,
        operationId: prewrite.operationId,
        writer: input.writer,
        expectedRevision: revisionToBlock,
        reason: launchFailureReason(activated),
      });
    }
    return blockRecovery(input, recovery, 'dispatch_unconfirmed', launchFailureReason(activated));
  }
  const adoption = await verifyPreparedWorker(input.backend, receipt.dispatchId, launch.preparedTerminal);
  if (adoption !== null) {
    const revisionToBlock = freshRevision(input.store, input.coordinationScopeId);
    if (revisionToBlock !== null) {
      blockLane(input.store, {
        coordinationScopeId: input.coordinationScopeId,
        operationId: prewrite.operationId,
        writer: input.writer,
        expectedRevision: revisionToBlock,
        reason: launchFailureReason(adoption),
      });
    }
    return blockRecovery(input, recovery, 'dispatch_identity_unknown', launchFailureReason(adoption));
  }
  const settled = settleAccepted(input, prewrite.operationId, outcome);
  if (settled.kind === 'failed') {
    return blockRecovery(input, recovery, 'invalid_state', settled.message);
  }

  const replacementSegmentId = deriveReplacementSegmentId(recovery.recoveryId);
  // 替代 Segment 与 Recovery 的收尾在**同一条** `advance-recovery` 命令内完成：写入替代 Session
  // Segment、把 Recovery 终结为 `recovered` + `replaced`、并递增该 Worker Attempt 的 Recovery
  // Budget（`consumedBudget`）都是同一 SQL 事务。这消除了「Segment 已落盘、Recovery 未收尾、
  // consumedBudget 仍为 0」的半记录状态——它会让按 attempt 求和的额度被低估，从而突破
  // `maxRecoveriesPerWorkerAttempt`。store 对该载荷按 segmentId 幂等：重启重放同一创建不会写出
  // 第二条 Segment，也不会重复消耗额度。
  const consumed = recoveryConsumptionOnReplacement(recovery.consumedBudget);
  const advanced = transactRecovery(input.store, input.coordinationScopeId, input.writer, recovery.recoveryId, {
    status: 'recovered',
    terminalOutcome: 'replaced',
    replacementDispatchId: receipt.dispatchId,
    replacementSegmentId,
    replacementSessionBindingId: receipt.sessionBindingId,
    ...(capsuleRef === null ? {} : { capsuleRef }),
    consumedBudget: consumed,
    replacementSegment: {
      segmentId: replacementSegmentId,
      workPackageId: input.workPackageId,
      role: input.role,
      workerTaskId: input.workerTaskId,
      dispatchId: receipt.dispatchId as DispatchId,
      // 替代 Session 仍属于原业务 Attempt：attemptId 逐字沿用。
      attemptId: input.businessAttemptId,
      sessionBindingId: receipt.sessionBindingId,
      lastTranscriptRef: receipt.transcriptRef,
      terminalReceiptRef: null,
      transcriptReferenceable: true,
      verifiable: true,
    },
  });
  if (advanced.kind === 'failed') {
    return blockRecovery(input, recovery, 'invalid_state', advanced.message);
  }
  const updated = readRecovery(input.store, input.coordinationScopeId, recovery.recoveryId);
  if (updated === null) {
    return blockRecovery(input, recovery, 'invalid_state', 'Recovery 登记替代 Segment 后无法读回');
  }
  return alternateCreatedResult(updated, profile.profileRef, profile.usedAlternate);
}

/**
 * 恢复一个中断的 Worker Session。
 *
 * 调用方提供已经核验的事实与稳定身份；用例本身不生成业务身份、不读时钟、不新建 worktree。
 */
export async function recoverWorkerSession(
  input: RecoverWorkerSessionInput,
): Promise<RecoverWorkerSessionResult> {
  if (input.subject === 'coordinator_session') {
    return {
      kind: 'not_worker_recovery',
      reason: 'Coordinator Session 按其自身 checkpoint 与启动对账处理，不创建 RecoveryId / Segment / Capsule',
    };
  }
  const segmentRead = readSourceSegment(input);
  if (segmentRead.kind === 'unreadable') {
    return { kind: 'rejected', code: segmentRead.code, message: segmentRead.message };
  }
  if (segmentRead.kind === 'missing') {
    return {
      kind: 'rejected',
      code: 'segment_not_found',
      message: `找不到中断 Session Segment ${input.sourceSegmentId}，无法核验中断归属`,
    };
  }
  const segment = segmentRead.segment;
  const mismatch = segmentIdentityMismatch(input, segment);
  if (mismatch !== null) {
    return {
      kind: 'rejected',
      code: 'identity_mismatch',
      message: `中断 Session Segment 的 ${mismatch} 与本次 Recovery 的业务身份不一致`,
    };
  }

  // 新建 Recovery 之前的 fail-closed 守护：同一 Worker Attempt 若已存在「预写 intent 已按 accepted
  // 收尾、但没有替代 Session Segment」的 Recovery，就说明那次替代派发确实发出过、而它的本地收尾
  // 结果不可证明。此时按 consumedBudget 求和会把该 attempt 的已消耗额度低估，从而放行第二次替代
  // 派发并突破 `maxRecoveriesPerWorkerAttempt`。无法证明未消耗时宁可阻塞，绝不猜测，也绝不重复派发。
  // 同一条中断 Segment 自己的续办不受影响（它在下面按既有路径阻塞），这里只拦「新 Recovery」。
  const existingRecovery =
    readRecovery(input.store, input.coordinationScopeId, deriveRecoveryId(input.coordinationScopeId, input.sourceSegmentId)) ??
    findRecoveryBySourceSegment(input.store, input.coordinationScopeId, input.sourceSegmentId);
  if (existingRecovery === null) {
    const unprovable = findUnprovableRecoveryConsumption(input);
    if (unprovable !== null) {
      const reason =
        `Worker Attempt ${input.businessAttemptId} 的已消耗 Recovery Budget 不可证明：` +
        `Recovery ${unprovable.recovery.recoveryId} 的替代派发意图 ${unprovable.operationId} 已按 accepted 收尾，` +
        '但没有替代 Session Segment。事实补齐前不新建 Recovery、也不派发替代 Session';
      markUnprovableRecoveryBlocked(input, unprovable.recovery, reason);
      return {
        kind: 'blocked',
        recoveryId: unprovable.recovery.recoveryId,
        code: 'dispatch_identity_unknown',
        reason,
      };
    }
  }

  const entry = decideRecoveryEntry({
    subject: input.subject,
    role: input.role,
    binding: {
      role: input.role,
      workerTaskId: input.workerTaskId,
      dispatchId: input.sourceDispatchId,
      attemptId: segment.attemptId,
      recorded: { sessionBindingId: segment.sessionBindingId, providerSessionId: null, identityChanged: false },
      observed: input.observation,
    },
    liveness: input.liveness,
  });

  const ensured = ensureRecoveryRecord(input);
  if (ensured.kind === 'rejected') {
    return { kind: 'rejected', code: ensured.code, message: ensured.message };
  }
  const recovery = ensured.recovery;
  if (recovery.status === 'recovered' || recovery.status === 'cancelled') {
    return {
      kind: 'already_concluded',
      recoveryId: recovery.recoveryId,
      status: recovery.status,
      terminalOutcome: recovery.terminalOutcome,
    };
  }

  if (entry.kind === 'not_worker_recovery') {
    return { kind: 'not_worker_recovery', reason: entry.reason };
  }
  if (entry.kind === 'unverifiable') {
    // 保持未决：Recovery 留在 pending，不推断退出、不派发、不消耗额度。
    return {
      kind: 'unverifiable_hold',
      recoveryId: recovery.recoveryId,
      phase: 'unverifiable',
      reason: entry.reason,
    };
  }

  if (entry.kind === 'exact_recovery') {
    if (recovery.replacementDispatchId !== null) {
      const profile = resolveReplacementProfile(input.replacement.profile);
      return alternateCreatedResult(recovery, profile.profileRef, profile.usedAlternate);
    }
    const outcome = await input.resumeExact({
      coordinationScopeId: input.coordinationScopeId,
      role: input.role,
      workPackageId: input.workPackageId,
      workerTaskId: input.workerTaskId,
      businessAttemptId: input.businessAttemptId,
      segment,
      sessionBindingId: entry.sessionBindingId,
      providerSessionId: entry.providerSessionId,
    });
    if (outcome.kind === 'resumed') {
      // 精确恢复成功：原会话在同一条 Segment 内继续，不创建替代 Session、不消耗 Recovery Budget。
      return {
        kind: 'exact_recovery',
        recoveryId: recovery.recoveryId,
        phase: 'verified',
        sessionBindingId: outcome.sessionBindingId,
      };
    }
    if (outcome.kind === 'unverifiable') {
      return {
        kind: 'unverifiable_hold',
        recoveryId: recovery.recoveryId,
        phase: 'unverifiable',
        reason: outcome.reason,
      };
    }
    return attemptAlternateSession(input, segment, recovery, outcome.reason);
  }

  return attemptAlternateSession(input, segment, recovery, entry.reason);
}

export type ConcludeRecoveryInput =
  | { readonly kind: 'source_completed'; readonly terminalReceiptRef: string }
  | { readonly kind: 'failed'; readonly reason: string };

export type ConcludeRecoveryResult =
  | {
      readonly kind: 'concluded';
      readonly recoveryId: RecoveryId;
      readonly status: RecoveryState;
      readonly terminalOutcome: RecoveryTerminalOutcome;
      readonly supersededSegmentId: SessionSegmentId | null;
    }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

/**
 * 结束一次尚未终结的 Recovery。
 *
 * 替代 Session 的结论（`recovered` + `replaced`）在创建替代 Session Segment 的同一条命令里已经写下，
 * 因此这里只处理另外两条路径：原会话到达有效终态时以 `source_completed` 终结并 supersede 原 Segment；
 * 失败时以 `blocked` + `failed` 留下可处理的阻塞。迁移必须沿 store 允许的路径：`pending` / `blocked`
 * 到 `recovered` 需要经过 `recovering`。
 */
export function concludeWorkerSessionRecovery(input: {
  readonly store: BranchCoordinationStore;
  readonly writer: CoordinationWriter;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly recoveryId: RecoveryId;
  readonly outcome: ConcludeRecoveryInput;
}): ConcludeRecoveryResult {
  const recovery = readRecovery(input.store, input.coordinationScopeId, input.recoveryId);
  if (recovery === null) {
    return { kind: 'rejected', code: 'recovery_not_found', message: `未登记的 RecoveryId ${input.recoveryId}` };
  }
  if (recovery.status === 'recovered' || recovery.status === 'cancelled') {
    return {
      kind: 'rejected',
      code: 'already_concluded',
      message: `Recovery ${input.recoveryId} 已处于终态 ${recovery.status}`,
    };
  }
  const needsRecovering = input.outcome.kind === 'source_completed' && recovery.status !== 'recovering';
  if (needsRecovering) {
    const entered = transactRecovery(input.store, input.coordinationScopeId, input.writer, recovery.recoveryId, {
      status: 'recovering',
    });
    if (entered.kind === 'failed') {
      return { kind: 'rejected', code: 'invalid_state', message: entered.message };
    }
  }
  const fields: AdvanceRecoveryFields =
    input.outcome.kind === 'source_completed'
      ? {
          status: 'recovered',
          terminalOutcome: 'source_completed',
          supersededSegmentId: recovery.sourceSegmentId,
        }
      : { status: 'blocked', terminalOutcome: 'failed', blockingReason: input.outcome.reason };
  const advanced = transactRecovery(
    input.store,
    input.coordinationScopeId,
    input.writer,
    recovery.recoveryId,
    fields,
  );
  if (advanced.kind === 'failed') {
    return { kind: 'rejected', code: 'invalid_state', message: advanced.message };
  }
  const updated = readRecovery(input.store, input.coordinationScopeId, recovery.recoveryId);
  if (updated === null || updated.terminalOutcome === null) {
    return { kind: 'rejected', code: 'invalid_state', message: 'Recovery 终结后无法读回终态结果' };
  }
  return {
    kind: 'concluded',
    recoveryId: updated.recoveryId,
    status: updated.status,
    terminalOutcome: updated.terminalOutcome,
    supersededSegmentId: updated.supersededSegmentId,
  };
}
