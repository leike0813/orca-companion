/**
 * IC-09 / IP-10：Execution Coordination 责任交接
 * （Owner: `m1-recover-execution`，D10）。
 *
 * 交接由持久化的 `ExecutionHandoffState` 驱动：`prepared → reviewed → cutover | cancelled | blocked`。
 * 它**不是** `PlanningHandoffProposal`，也**不是**普通 suspend/resume：普通挂起与唤醒继续由
 * `coordinator/actionable-work.ts`、`suspension.ts` 与 `wake-admission.ts` 原样拥有，本模块不包装、
 * 不复制、也不以 Wake Batch 暗示责任转移。
 *
 * 责任集合只有三项（IC-09 `HandoffResponsibility`）：Execution Coordination Lease、相关
 * Pending Interaction、当前 Graph Generation 后续 Worker 生命周期事件责任。前两项与第三项都由
 * Execution Coordination Lease 表达——只有未释放的 Lease 持有者能推进执行事实。
 *
 * 关键顺序：
 * - prepare 只冻结来源 revision、Target Session 与责任集合，Source 仍是唯一 owner；
 * - review 独立校验 Source checkpoint、可移植 Coordinator Context Capsule、Target 身份、expected
 *   revision、当前 Graph Generation 与责任集合；失败写 blocker，Source 仍是唯一 owner；
 * - cutover **只调用一次** `advance-execution-handoff`：handoffRevision 与 Scope expectedRevision
 *   两个 CAS 都在这一条命令里，责任转移由 store 在同一事务内完成（Lease 释放/取得、归属 Source 的
 *   开放交互转交）。本模块**不**自己串 release/acquire，也不改动 Run、Task、Dispatch、Attempt、
 *   Worker、worktree、Execution Graph、Authorization 与预算身份。
 *
 * `awaiting_user_prompt` 不是持久化的 Session 状态：它是激活门（与 planning-handoff 同一模式）。
 * cutover 之后 Target 在没有用户下一条普通 Prompt 之前不自动激活模型循环；Worker 事件继续落盘与
 * 对账。
 */

import type { GraphGeneration, CoordinatorSessionId, CoordinationScopeId, InteractionId, Revision } from '../dto/identity.js';
import type {
  BranchCoordinationStore,
  CoordinationWriter,
  ExecutionHandoffPhase,
  ExecutionHandoffRecord,
  HandoffResponsibility,
  SessionLifecycleState,
} from '../ports/branch-coordination-store.js';
import { HANDOFF_RESPONSIBILITIES } from '../ports/branch-coordination-store.js';
import { readScope } from '../planning/scope-read.js';

/**
 * 唯一合法的交接触发来源。
 *
 * 只有用户动作可以发起 Execution Handoff。普通挂起、唤醒、keepalive 与对账都不在触发集合里，
 * 因此它们不可能隐式转移执行责任。
 */
export const EXECUTION_HANDOFF_TRIGGERS = ['user_command'] as const;

export type ExecutionHandoffTrigger = (typeof EXECUTION_HANDOFF_TRIGGERS)[number];

export function isExecutionHandoffTrigger(value: string): value is ExecutionHandoffTrigger {
  return (EXECUTION_HANDOFF_TRIGGERS as readonly string[]).includes(value);
}

export type ExecutionHandoffFailure = {
  readonly code: string;
  readonly message: string;
};

export type PrepareExecutionHandoffInput = {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly writer: CoordinationWriter;
  readonly handoffId: string;
  readonly targetSessionId: CoordinatorSessionId;
  readonly graphGeneration: GraphGeneration;
  /** 可移植 Coordinator Context Capsule 的引用；本库不保存 Capsule 内容。 */
  readonly capsuleRef: string | null;
};

/** review 需要的事实由调用方从各自权威处读好；本模块不读 checkpoint store、不解析 Capsule 正文。 */
export type ExecutionHandoffReviewFacts = {
  /** 调用方读到 Scope 时的 revision；必须与该提案冻结的 expectedRevision 相等。 */
  readonly scopeRevision: Revision;
  readonly currentGraphGeneration: GraphGeneration | null;
  /** Target 的 Session 注册状态；`null` 表示该 Session 未注册。 */
  readonly targetLifecycleState: SessionLifecycleState | null;
  readonly sourceCheckpoint: 'recoverable' | 'absent' | 'unrecoverable';
  /** Coordinator Context Capsule 是否可移植；没有 Capsule 引用时为 `false`。 */
  readonly capsulePortable: boolean;
};

/** cutover 之后核验到的责任归属证据。 */
export type ExecutionHandoffTransfer = {
  readonly executionLeaseHolderSessionId: CoordinatorSessionId | null;
  /** cutover 前归属 Source 的开放交互，cutover 后应全部归属 Target。 */
  readonly transferredInteractionIds: readonly InteractionId[];
};

export type ExecutionHandoffResult =
  | { readonly kind: 'prepared'; readonly record: ExecutionHandoffRecord }
  | { readonly kind: 'reviewed'; readonly record: ExecutionHandoffRecord }
  | {
      readonly kind: 'cutover';
      readonly record: ExecutionHandoffRecord;
      readonly transfer: ExecutionHandoffTransfer;
    }
  | { readonly kind: 'cancelled'; readonly record: ExecutionHandoffRecord }
  | {
      readonly kind: 'blocked';
      readonly failure: ExecutionHandoffFailure;
      readonly record: ExecutionHandoffRecord | null;
    }
  | { readonly kind: 'rejected'; readonly failure: ExecutionHandoffFailure };

type HandoffRead =
  | { readonly kind: 'read'; readonly record: ExecutionHandoffRecord | null }
  | { readonly kind: 'rejected'; readonly failure: ExecutionHandoffFailure };

function readHandoff(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
  handoffId: string,
): HandoffRead {
  const result = store.query({ kind: 'execution-handoff', coordinationScopeId, handoffId });
  if (result.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: result.code, message: result.message } };
  }
  if (result.kind !== 'execution-handoff') {
    return { kind: 'rejected', failure: { code: 'invalid_state', message: '无法读取 Execution Handoff' } };
  }
  return { kind: 'read', record: result.handoff };
}

function scopeRevision(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
): { readonly kind: 'read'; readonly revision: Revision } | { readonly kind: 'rejected'; readonly failure: ExecutionHandoffFailure } {
  const scope = readScope(store, coordinationScopeId);
  return scope.kind === 'rejected'
    ? { kind: 'rejected', failure: { code: scope.code, message: scope.message } }
    : { kind: 'read', revision: scope.scope.revision };
}

function responsibilitySetComplete(set: readonly HandoffResponsibility[]): boolean {
  return (
    set.length === HANDOFF_RESPONSIBILITIES.length &&
    HANDOFF_RESPONSIBILITIES.every((responsibility) => set.includes(responsibility))
  );
}

/**
 * 把失败写成 `blocked`，Source 保持唯一 owner。
 *
 * 记录 blocker 是 best-effort：CAS 已经过期时它本身也会被拒绝，此时失败原因仍由返回值如实带出，
 * 由 Controller 投影成 Scope blocker。
 */
function recordBlocker(
  input: {
    readonly store: BranchCoordinationStore;
    readonly coordinationScopeId: CoordinationScopeId;
    readonly writer: CoordinationWriter;
  },
  record: ExecutionHandoffRecord,
  reason: string,
): ExecutionHandoffRecord | null {
  const current = readHandoff(input.store, input.coordinationScopeId, record.handoffId);
  if (current.kind !== 'read' || current.record === null) {
    return null;
  }
  const revision = scopeRevision(input.store, input.coordinationScopeId);
  if (revision.kind === 'rejected') {
    return null;
  }
  const written = input.store.transact({
    kind: 'advance-execution-handoff',
    coordinationScopeId: input.coordinationScopeId,
    expectedRevision: revision.revision,
    writer: input.writer,
    handoffId: current.record.handoffId,
    phase: 'blocked',
    expectedHandoffRevision: current.record.handoffRevision,
    blockingReason: reason,
  });
  if (written.kind === 'rejected') {
    return null;
  }
  const after = readHandoff(input.store, input.coordinationScopeId, record.handoffId);
  return after.kind === 'read' ? after.record : null;
}

function blocked(
  input: {
    readonly store: BranchCoordinationStore;
    readonly coordinationScopeId: CoordinationScopeId;
    readonly writer: CoordinationWriter;
  },
  record: ExecutionHandoffRecord,
  failure: ExecutionHandoffFailure,
): ExecutionHandoffResult {
  return { kind: 'blocked', failure, record: recordBlocker(input, record, failure.message) ?? record };
}

/**
 * prepare：冻结来源 revision、Target Session、Graph Generation 与责任集合。
 *
 * 只产出提案，不触碰 Lease、交互或任何执行身份。写入者必须是当前 Execution Coordination Lease
 * 持有者——这一点由 store 判定，本模块不复制该规则。
 */
export function prepareExecutionHandoff(input: PrepareExecutionHandoffInput): ExecutionHandoffResult {
  if (input.targetSessionId === input.writer.coordinatorSessionId) {
    return {
      kind: 'rejected',
      failure: { code: 'invalid_argument', message: '交接的 Source 与 Target 不能是同一个 Session' },
    };
  }
  const revision = scopeRevision(input.store, input.coordinationScopeId);
  if (revision.kind === 'rejected') {
    return { kind: 'rejected', failure: revision.failure };
  }
  const written = input.store.transact({
    kind: 'record-execution-handoff',
    coordinationScopeId: input.coordinationScopeId,
    expectedRevision: revision.revision,
    writer: input.writer,
    handoffId: input.handoffId,
    sourceSessionId: input.writer.coordinatorSessionId,
    targetSessionId: input.targetSessionId,
    graphGeneration: input.graphGeneration,
    responsibilitySet: [...HANDOFF_RESPONSIBILITIES],
    phase: 'prepared',
    coordinatorContextCapsuleRef: input.capsuleRef,
    expectedHandoffRevision: null,
  });
  if (written.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: written.code, message: written.message } };
  }
  const after = readHandoff(input.store, input.coordinationScopeId, input.handoffId);
  if (after.kind === 'rejected' || after.record === null) {
    return {
      kind: 'rejected',
      failure: { code: 'invalid_state', message: 'Execution Handoff 写入后无法读回' },
    };
  }
  return { kind: 'prepared', record: after.record };
}

/**
 * review：独立校验提案引用的全部事实。
 *
 * 复核通过才进入 `reviewed`；任何一项不成立都写 blocker 并保持 Source 为唯一 owner。复核阶段
 * 绝不提前转移 Lease。
 */
export function reviewExecutionHandoff(input: {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly writer: CoordinationWriter;
  readonly handoffId: string;
  readonly facts: ExecutionHandoffReviewFacts;
}): ExecutionHandoffResult {
  const read = readHandoff(input.store, input.coordinationScopeId, input.handoffId);
  if (read.kind === 'rejected') {
    return { kind: 'rejected', failure: read.failure };
  }
  const record = read.record;
  if (record === null) {
    return {
      kind: 'rejected',
      failure: { code: 'not_found', message: `Execution Handoff ${input.handoffId} 不存在` },
    };
  }
  if (record.phase !== 'prepared') {
    return {
      kind: 'rejected',
      failure: { code: 'invalid_state', message: `提案处于 ${record.phase}，不能复核` },
    };
  }
  const failure = reviewFailureReason(record, input.facts);
  if (failure !== null) {
    return blocked(input, record, failure);
  }
  const current = scopeRevision(input.store, input.coordinationScopeId);
  if (current.kind === 'rejected') {
    return { kind: 'rejected', failure: current.failure };
  }
  const written = input.store.transact({
    kind: 'advance-execution-handoff',
    coordinationScopeId: input.coordinationScopeId,
    expectedRevision: current.revision,
    writer: input.writer,
    handoffId: record.handoffId,
    phase: 'reviewed',
    expectedHandoffRevision: record.handoffRevision,
  });
  if (written.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: written.code, message: written.message } };
  }
  const after = readHandoff(input.store, input.coordinationScopeId, input.handoffId);
  if (after.kind === 'rejected' || after.record === null) {
    return { kind: 'rejected', failure: { code: 'invalid_state', message: '复核写入后无法读回' } };
  }
  return { kind: 'reviewed', record: after.record };
}

function reviewFailureReason(
  record: ExecutionHandoffRecord,
  facts: ExecutionHandoffReviewFacts,
): ExecutionHandoffFailure | null {
  if (record.expectedRevision !== facts.scopeRevision) {
    return {
      code: 'stale_revision',
      message: `提案冻结于 Scope revision ${record.expectedRevision}，当前为 ${facts.scopeRevision}`,
    };
  }
  if (!responsibilitySetComplete(record.responsibilitySet)) {
    return { code: 'responsibility_set_incomplete', message: '待转移的责任集合不完整，必须重新 prepare' };
  }
  if (facts.targetLifecycleState === null) {
    return { code: 'target_unknown', message: 'Target Session 未注册' };
  }
  if (facts.targetLifecycleState === 'cancelled') {
    return { code: 'target_cancelled', message: 'Target Session 已取消，不能接收执行责任' };
  }
  if (facts.sourceCheckpoint !== 'recoverable') {
    return {
      code: 'source_checkpoint_unrecoverable',
      message:
        facts.sourceCheckpoint === 'absent'
          ? 'Source Session 没有可恢复的 checkpoint'
          : 'Source Session 的 checkpoint 不可恢复',
    };
  }
  if (!facts.capsulePortable) {
    return {
      code: 'capsule_not_portable',
      message: 'Coordinator Context Capsule 不可移植，Target 无法在可解释的历史上继续',
    };
  }
  if (facts.currentGraphGeneration !== record.graphGeneration) {
    return {
      code: 'graph_generation_changed',
      message: `提案绑定 Graph Generation ${record.graphGeneration}，当前为 ${String(facts.currentGraphGeneration)}`,
    };
  }
  return null;
}

function openInteractionsOwnedBy(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
  sessionId: CoordinatorSessionId,
): readonly InteractionId[] {
  const result = store.query({ kind: 'snapshot', coordinationScopeId });
  if (result.kind !== 'snapshot') {
    return [];
  }
  return result.snapshot.pendingInteractions
    .filter((interaction) => interaction.state === 'open' && interaction.ownerCoordinatorSessionId === sessionId)
    .map((interaction) => interaction.interactionId);
}

function readExecutionLeaseHolder(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
): CoordinatorSessionId | null {
  const result = store.query({ kind: 'snapshot', coordinationScopeId });
  return result.kind === 'snapshot' && result.snapshot.executionLease !== null
    ? result.snapshot.executionLease.coordinatorSessionId
    : null;
}

/**
 * cutover：以**一次** `advance-execution-handoff` 转移全部责任。
 *
 * 调用前必须处于 `reviewed`；命令同时带两个 CAS——`expectedRevision` 取得「review 之后没有其它写入」
 * 的守卫，`expectedHandoffRevision` 是提案级 CAS。责任转移（Lease 与开放交互）由 store 在同一事务内
 * 完成，本模块只在提交后回读核验，绝不自己串 release/acquire。
 *
 * 提交后核验不通过时 Source 仍是实际 owner；失败以 blocker 形式返回，由 Controller 投影，不激活 Target。
 */
export function cutoverExecutionHandoff(input: {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly writer: CoordinationWriter;
  readonly handoffId: string;
}): ExecutionHandoffResult {
  const read = readHandoff(input.store, input.coordinationScopeId, input.handoffId);
  if (read.kind === 'rejected') {
    return { kind: 'rejected', failure: read.failure };
  }
  const record = read.record;
  if (record === null) {
    return {
      kind: 'rejected',
      failure: { code: 'not_found', message: `Execution Handoff ${input.handoffId} 不存在` },
    };
  }
  if (record.phase !== 'reviewed') {
    return {
      kind: 'rejected',
      failure: { code: 'invalid_state', message: `提案处于 ${record.phase}，不能 cutover` },
    };
  }
  const current = scopeRevision(input.store, input.coordinationScopeId);
  if (current.kind === 'rejected') {
    return { kind: 'rejected', failure: current.failure };
  }
  if (current.revision !== record.expectedRevision) {
    return blocked(input, record, {
      code: 'stale_revision',
      message: `复核之后 Scope revision 已从 ${record.expectedRevision} 推进到 ${current.revision}，必须重新 prepare`,
    });
  }

  const expectedInteractions = openInteractionsOwnedBy(
    input.store,
    input.coordinationScopeId,
    record.sourceSessionId,
  );

  const written = input.store.transact({
    kind: 'advance-execution-handoff',
    coordinationScopeId: input.coordinationScopeId,
    expectedRevision: record.expectedRevision,
    writer: input.writer,
    handoffId: record.handoffId,
    phase: 'cutover',
    expectedHandoffRevision: record.handoffRevision,
  });
  if (written.kind === 'rejected') {
    return blocked(input, record, {
      code: written.code === 'stale_revision' ? 'cutover_cas_failed' : written.code,
      message: `cutover CAS 失败：${written.message}`,
    });
  }

  const after = readHandoff(input.store, input.coordinationScopeId, input.handoffId);
  const transferred = after.kind === 'read' ? after.record : null;
  if (transferred === null || transferred.phase !== 'cutover') {
    return { kind: 'rejected', failure: { code: 'invalid_state', message: 'cutover 提交后无法读回提案' } };
  }

  const leaseHolder = readExecutionLeaseHolder(input.store, input.coordinationScopeId);
  const stillOwnedBySource = openInteractionsOwnedBy(
    input.store,
    input.coordinationScopeId,
    record.sourceSessionId,
  );
  const responsibilityTransferred =
    leaseHolder === record.targetSessionId && stillOwnedBySource.length === 0;
  if (!responsibilityTransferred) {
    return {
      kind: 'blocked',
      failure: {
        code: 'responsibility_not_transferred',
        message:
          leaseHolder !== record.targetSessionId
            ? `cutover 已落盘，但 Execution Coordination Lease 仍在 ${leaseHolder ?? '无人'} 手中`
            : `cutover 已落盘，但仍有 ${String(stillOwnedBySource.length)} 个开放交互归属 Source`,
      },
      record: transferred,
    };
  }

  return {
    kind: 'cutover',
    record: transferred,
    transfer: {
      executionLeaseHolderSessionId: leaseHolder,
      transferredInteractionIds: expectedInteractions,
    },
  };
}

/** 在 cutover 之前取消交接：责任保持或回到 Source，不留下半转移状态。 */
export function cancelExecutionHandoff(input: {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly writer: CoordinationWriter;
  readonly handoffId: string;
}): ExecutionHandoffResult {
  const read = readHandoff(input.store, input.coordinationScopeId, input.handoffId);
  if (read.kind === 'rejected') {
    return { kind: 'rejected', failure: read.failure };
  }
  const record = read.record;
  if (record === null) {
    return {
      kind: 'rejected',
      failure: { code: 'not_found', message: `Execution Handoff ${input.handoffId} 不存在` },
    };
  }
  if (record.phase !== 'prepared' && record.phase !== 'reviewed' && record.phase !== 'blocked') {
    return {
      kind: 'rejected',
      failure: { code: 'invalid_state', message: `提案处于 ${record.phase}，不能取消` },
    };
  }
  const current = scopeRevision(input.store, input.coordinationScopeId);
  if (current.kind === 'rejected') {
    return { kind: 'rejected', failure: current.failure };
  }
  const written = input.store.transact({
    kind: 'advance-execution-handoff',
    coordinationScopeId: input.coordinationScopeId,
    expectedRevision: current.revision,
    writer: input.writer,
    handoffId: record.handoffId,
    phase: 'cancelled',
    expectedHandoffRevision: record.handoffRevision,
  });
  if (written.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: written.code, message: written.message } };
  }
  const after = readHandoff(input.store, input.coordinationScopeId, input.handoffId);
  if (after.kind === 'rejected' || after.record === null) {
    return { kind: 'rejected', failure: { code: 'invalid_state', message: '取消写入后无法读回' } };
  }
  return { kind: 'cancelled', record: after.record };
}

/**
 * `awaiting_user_prompt` 激活门。
 *
 * cutover 之后 Target 只有在用户发出下一条普通 Prompt（`awaitingUserPromptSatisfied === true`）之后
 * 才能激活模型循环。worker 事件与对账不受这道门影响，它们继续落盘。
 */
export type ExecutionHandoffActivation =
  | { readonly kind: 'source_active'; readonly coordinatorSessionId: CoordinatorSessionId }
  | { readonly kind: 'target_active'; readonly coordinatorSessionId: CoordinatorSessionId }
  | {
      readonly kind: 'awaiting_user_prompt';
      readonly handoffId: string;
      readonly targetSessionId: CoordinatorSessionId;
      readonly reason: string;
    }
  | { readonly kind: 'not_owner'; readonly ownerCoordinatorSessionId: CoordinatorSessionId }
  | { readonly kind: 'none' };

const NOT_ACTIVATED_PHASES: ReadonlySet<ExecutionHandoffPhase> = new Set(['prepared', 'reviewed', 'blocked']);

export function executionHandoffActivation(input: {
  readonly handoff: ExecutionHandoffRecord | null;
  readonly executionLeaseHolderSessionId: CoordinatorSessionId | null;
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly awaitingUserPromptSatisfied?: boolean;
}): ExecutionHandoffActivation {
  const handoff = input.handoff;
  if (handoff === null) {
    if (input.executionLeaseHolderSessionId === null) {
      return { kind: 'none' };
    }
    return input.executionLeaseHolderSessionId === input.coordinatorSessionId
      ? { kind: 'source_active', coordinatorSessionId: input.coordinatorSessionId }
      : { kind: 'not_owner', ownerCoordinatorSessionId: input.executionLeaseHolderSessionId };
  }

  if (handoff.phase === 'cutover') {
    if (handoff.targetSessionId !== input.coordinatorSessionId) {
      return { kind: 'not_owner', ownerCoordinatorSessionId: handoff.targetSessionId };
    }
    return input.awaitingUserPromptSatisfied === true
      ? { kind: 'target_active', coordinatorSessionId: input.coordinatorSessionId }
      : {
          kind: 'awaiting_user_prompt',
          handoffId: handoff.handoffId,
          targetSessionId: handoff.targetSessionId,
          reason: '责任已 cutover，等待用户的下一条普通 Prompt 才激活模型循环',
        };
  }

  if (NOT_ACTIVATED_PHASES.has(handoff.phase)) {
    if (handoff.sourceSessionId === input.coordinatorSessionId) {
      return { kind: 'source_active', coordinatorSessionId: input.coordinatorSessionId };
    }
    if (handoff.targetSessionId === input.coordinatorSessionId) {
      return {
        kind: 'awaiting_user_prompt',
        handoffId: handoff.handoffId,
        targetSessionId: handoff.targetSessionId,
        reason:
          handoff.phase === 'prepared'
            ? '交接提案尚未复核，Target 只能读取审阅信息'
            : '交接已阻塞，Source 仍是唯一 owner',
      };
    }
    return { kind: 'not_owner', ownerCoordinatorSessionId: handoff.sourceSessionId };
  }

  // cancelled：不构成门禁，按持久化的 Lease holder 判断。
  if (input.executionLeaseHolderSessionId === null) {
    return { kind: 'none' };
  }
  return input.executionLeaseHolderSessionId === input.coordinatorSessionId
    ? { kind: 'source_active', coordinatorSessionId: input.coordinatorSessionId }
    : { kind: 'not_owner', ownerCoordinatorSessionId: input.executionLeaseHolderSessionId };
}
