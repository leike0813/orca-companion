/**
 * IP-03 / D-03：多分支集成的「合并树复验」应用模块
 * （Owner: restore-configurable-execution-concurrency）。
 *
 * canonical 集成必须串行，但 Work Package 可以乱序完成。当某个包验证通过时 canonical 可能已经被
 * 别的包推进，此时把该包 fast-forward 到 canonical 会永久失败。这个模块拥有那一步的正确顺序：
 *
 * 1. 在包自己的 worktree 里 merge 当前已归属的 canonical HEAD（--no-commit）；
 * 2. 由原 Validator Session 在同一条真实 harness session 与同一 Validation Attempt 内解冲突并
 *    复验合并后的精确树；
 * 3. 复验通过后由 Controller 创建普通 merge commit（包 worktree 里），使 canonical 成为其祖先；
 * 4. 后续的 merge --ff-only 因此总能推进 canonical。
 *
 * 幂等与恢复的根因约束：
 * - 每个 Git 步骤都先登记 Operation Intent 再执行；重放时只按同一 OperationId 对账，绝不重跑 run。
 * - 未决的 Git 步骤保留 lane 阻塞并在下次触发时只读对账，因此 unknown 不会永久卡死。
 * - 续接 Task/Dispatch 身份由 Orca 分配：本模块只派生稳定的 Task 创建 OperationId，真实 ID 由复验
 *   执行方在创建后回报并持久化；重放时把已记录的 ID 传回去复用，不新建第二个 Task。
 */

import type {
  CoordinationScopeId,
  DispatchId,
  OperationId,
  Revision,
  ValidationAttemptId,
  WorkPackageId,
} from './dto/identity.js';
import type { BranchCoordinationStore, CoordinationWriter } from './ports/branch-coordination-store.js';
import { buildExecutionScope, type ExecutionAuthority, type ExecutionScope } from './ports/execution-backend.js';
import { readScope } from './planning/scope-read.js';
import { beginIntent, blockLane, resolveLane, settleIntent } from './coordination/intent-service.js';
import type { OperationOutcome } from './dto/operation-outcome.js';
import type { SessionBinding } from '../domain/task-contract.js';
import type { EvidenceRecord, EscalationReason } from '../domain/worker-report.js';
import type { GitIntegrationPort, GitStepOutcome, GitStepRequest } from './integrate-work-package.js';

/** 集成复验轮次的状态闭集；pending 是唯一可以继续的进行态。 */
export const INTEGRATION_RECONCILIATION_STATES = ['pending', 'validated', 'rejected', 'blocked'] as const;

export type IntegrationReconciliationState = (typeof INTEGRATION_RECONCILIATION_STATES)[number];

/**
 * 一轮集成复验的持久记录。
 *
 * reconciliationId 是稳定轮次身份，由 scope / graph / generation / package / round 确定性派生；
 * targetHead 绑定本轮合并进来的 canonical HEAD，mergedTreeRef 绑定复验过的精确树。orcaTaskId 与
 * dispatchId 保存 Orca 实际分配的续接身份，重放时据此复用而不是新建。
 */
export type IntegrationReconciliationRecord = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly workPackageId: WorkPackageId;
  readonly reconciliationId: string;
  readonly round: number;
  /** 原 Validation Attempt 身份；复验不产生新的 Attempt。 */
  readonly validationAttemptId: string;
  /** 原已接受结果引用；复验不改写它。 */
  readonly sourceAcceptedResultRef: string;
  /** 本轮合并进来的 canonical HEAD。 */
  readonly targetHead: string;
  /** 复验通过的精确树 OID；未复验时为 null。 */
  readonly mergedTreeRef: string | null;
  readonly orcaTaskId: string | null;
  readonly dispatchId: string | null;
  readonly state: IntegrationReconciliationState;
  readonly blockerRef: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
};

/** 轮次登记与集成复验额度消费一起落盘；额度越界在这里就拒绝。 */
export type RegisterIntegrationReconciliationInput = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly expectedRevision: Revision;
  readonly writer: CoordinationWriter;
  readonly workPackageId: WorkPackageId;
  readonly reconciliationId: string;
  readonly round: number;
  readonly validationAttemptId: string;
  readonly sourceAcceptedResultRef: string;
  readonly targetHead: string;
  readonly budgetKey: string;
  readonly approvedLimitRef: string;
};

export type RegisterIntegrationReconciliationResult =
  | { readonly kind: 'registered' | 'existing'; readonly record: IntegrationReconciliationRecord; readonly revision: number }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

export type SettleIntegrationReconciliationInput = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly expectedRevision: Revision;
  readonly writer: CoordinationWriter;
  /** 轮次所属 Work Package：结算后按包读回记录需要它。 */
  readonly workPackageId: WorkPackageId;
  readonly reconciliationId: string;
  readonly state: Exclude<IntegrationReconciliationState, 'pending'>;
  readonly mergedTreeRef?: string | null;
  readonly orcaTaskId?: string | null;
  readonly dispatchId?: string | null;
  readonly blockerRef?: string | null;
};

export type SettleIntegrationReconciliationResult =
  | { readonly kind: 'settled'; readonly record: IntegrationReconciliationRecord }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

/**
 * 立即登记续接 Task/Dispatch 的真实 Orca 身份，保持轮次 pending。
 *
 * 以 Orca 实际分配值为准（不是伪造的确定性 ID）。它必须在创建后立刻落盘，否则重启重放会新建第二个
 * Task；同 scope CAS + 稳定 reconciliationId 保证重复登记幂等、终态不可改写。
 */
export type BindIntegrationContinuationInput = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly expectedRevision: Revision;
  readonly writer: CoordinationWriter;
  readonly workPackageId: WorkPackageId;
  readonly reconciliationId: string;
  readonly orcaTaskId: string;
  readonly dispatchId: DispatchId | null;
};

export type BindIntegrationContinuationResult =
  | { readonly kind: 'bound'; readonly record: IntegrationReconciliationRecord }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

/**
 * 集成复验的存储 seam。
 *
 * 只暴露轮次登记（与额度同事务）、结算与按包读取；生产实现是 Branch Coordination Store 的 CAS
 * 事务。Git 步骤的副作用幂等由 Operation Intent 拥有，不在这条 port 上复制。
 */
export type IntegrationReconciliationStore = {
  readonly register: (input: RegisterIntegrationReconciliationInput) => RegisterIntegrationReconciliationResult;
  readonly settle: (input: SettleIntegrationReconciliationInput) => SettleIntegrationReconciliationResult;
  /** 创建/启动续接 Task 后立即登记真实 Orca 身份；失败即中止本轮，不得降级重派。 */
  readonly bindContinuation: (input: BindIntegrationContinuationInput) => BindIntegrationContinuationResult;
  readonly list: (
    coordinationScopeId: CoordinationScopeId,
    workPackageId: WorkPackageId,
  ) => IntegrationReconciliationListResult;
};

/** 轮次读取的三值结果：rejected 表示无法核验，调用方必须 fail closed，不得当成空。 */
export type IntegrationReconciliationListResult =
  | { readonly kind: 'records'; readonly records: readonly IntegrationReconciliationRecord[] }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

/**
 * 把 Branch Coordination Store 的轮次 query/command 适配成集成复验 port。
 *
 * 只做 transport 转换：登记/结算各自是一条短 CAS 事务；结算后按包读回记录以返回稳定形状。生产接线
 * 直接把 Branch store 传进来即可，不需要第二份存储实现。
 */
export function branchIntegrationReconciliationStore(
  store: BranchCoordinationStore,
): IntegrationReconciliationStore {
  const read = (
    coordinationScopeId: CoordinationScopeId,
    workPackageId: WorkPackageId,
  ): IntegrationReconciliationListResult => {
    const result = store.query({ kind: 'integration-reconciliations', coordinationScopeId, workPackageId });
    if (result.kind === 'integration-reconciliations') {
      return { kind: 'records', records: result.records };
    }
    if (result.kind === 'rejected') {
      return { kind: 'rejected', code: result.code, message: result.message };
    }
    return { kind: 'rejected', code: 'unexpected_query_result', message: '轮次查询返回了未预期的结果形态' };
  };
  type Found =
    | { readonly kind: 'found'; readonly record: IntegrationReconciliationRecord }
    | { readonly kind: 'missing' }
    | { readonly kind: 'rejected'; readonly code: string; readonly message: string };
  const find = (
    coordinationScopeId: CoordinationScopeId,
    workPackageId: WorkPackageId,
    reconciliationId: string,
  ): Found => {
    const listed = read(coordinationScopeId, workPackageId);
    if (listed.kind === 'rejected') {
      return { kind: 'rejected', code: listed.code, message: listed.message };
    }
    const record = listed.records.find((entry) => entry.reconciliationId === reconciliationId);
    return record === undefined ? { kind: 'missing' } : { kind: 'found', record };
  };
  return {
    register: (request) => {
      const existing = find(request.coordinationScopeId, request.workPackageId, request.reconciliationId);
      if (existing.kind === 'rejected') {
        return { kind: 'rejected', code: existing.code, message: existing.message };
      }
      if (existing.kind === 'found') {
        // 同载荷才复用；异载荷必须在这里拒绝，绝不能绕过 store 的不可变字段检查。
        const record = existing.record;
        const samePayload =
          record.round === request.round &&
          record.validationAttemptId === request.validationAttemptId &&
          record.sourceAcceptedResultRef === request.sourceAcceptedResultRef &&
          record.targetHead === request.targetHead;
        return samePayload
          ? { kind: 'existing', record, revision: request.expectedRevision }
          : {
              kind: 'rejected',
              code: 'reconciliation_payload_mismatch',
              message: '同一轮次身份已绑定不同的 round/validationAttempt/sourceResult/targetHead：拒绝异载荷重放',
            };
      }
      const committed = store.transact({
        kind: 'register-integration-reconciliation',
        coordinationScopeId: request.coordinationScopeId,
        expectedRevision: request.expectedRevision,
        writer: request.writer,
        workPackageId: request.workPackageId,
        reconciliationId: request.reconciliationId,
        round: request.round,
        validationAttemptId: request.validationAttemptId,
        sourceAcceptedResultRef: request.sourceAcceptedResultRef,
        targetHead: request.targetHead,
        budgetKey: request.budgetKey,
        approvedLimitRef: request.approvedLimitRef,
      });
      if (committed.kind === 'rejected') {
        return { kind: 'rejected', code: committed.code, message: committed.message };
      }
      const reread = find(request.coordinationScopeId, request.workPackageId, request.reconciliationId);
      if (reread.kind !== 'found') {
        return reread.kind === 'rejected'
          ? { kind: 'rejected', code: reread.code, message: reread.message }
          : { kind: 'rejected', code: 'invalid_state', message: '轮次登记后无法读回' };
      }
      return { kind: 'registered', record: reread.record, revision: committed.revision };
    },
    settle: (request) => {
      const committed = store.transact({
        kind: 'settle-integration-reconciliation',
        coordinationScopeId: request.coordinationScopeId,
        expectedRevision: request.expectedRevision,
        writer: request.writer,
        workPackageId: request.workPackageId,
        reconciliationId: request.reconciliationId,
        state: request.state,
        mergedTreeRef: request.mergedTreeRef ?? null,
        orcaTaskId: request.orcaTaskId ?? null,
        dispatchId: request.dispatchId ?? null,
        blockerRef: request.blockerRef ?? null,
      });
      if (committed.kind === 'rejected') {
        return { kind: 'rejected', code: committed.code, message: committed.message };
      }
      const reread = find(request.coordinationScopeId, request.workPackageId, request.reconciliationId);
      if (reread.kind !== 'found') {
        return reread.kind === 'rejected'
          ? { kind: 'rejected', code: reread.code, message: reread.message }
          : { kind: 'rejected', code: 'invalid_state', message: '轮次结算后无法读回' };
      }
      return { kind: 'settled', record: reread.record };
    },
    bindContinuation: (request) => {
      const committed = store.transact({
        kind: 'bind-integration-continuation',
        coordinationScopeId: request.coordinationScopeId,
        expectedRevision: request.expectedRevision,
        writer: request.writer,
        workPackageId: request.workPackageId,
        reconciliationId: request.reconciliationId,
        orcaTaskId: request.orcaTaskId,
        dispatchId: request.dispatchId,
      });
      if (committed.kind === 'rejected') {
        return { kind: 'rejected', code: committed.code, message: committed.message };
      }
      const reread = find(request.coordinationScopeId, request.workPackageId, request.reconciliationId);
      if (reread.kind !== 'found') {
        return reread.kind === 'rejected'
          ? { kind: 'rejected', code: reread.code, message: reread.message }
          : { kind: 'rejected', code: 'invalid_state', message: '续接身份登记后无法读回' };
      }
      return { kind: 'bound', record: reread.record };
    },
    list: (coordinationScopeId, workPackageId) => read(coordinationScopeId, workPackageId),
  };
}

/**
 * 续接复验的稳定身份。
 *
 * 不伪造 Orca 身份：Orca 分配的 Task/Dispatch ID 只在创建后记录。这里给出稳定的业务尝试身份与 Task
 * 创建 OperationId，并回放已记录的真实 ID 供执行方复用。
 */
export type IntegrationReconciliationContinuation = {
  /** 稳定业务尝试身份：绑定原 Validation Attempt，不含 Orca 分配的 ID。 */
  readonly attemptId: string;
  /** 稳定的 Task 创建 OperationId；Orca 任务创建的幂等键由它表达。 */
  readonly taskOperationId: OperationId;
  /** 已记录的续接 Task/Dispatch（重放时复用；null 表示尚未创建）。 */
  readonly existingTaskId: string | null;
  readonly existingDispatchId: DispatchId | null;
};

export function integrationReconciliationContinuation(input: {
  readonly reconciliationId: string;
  readonly taskOperationId: OperationId;
  readonly existingTaskId: string | null;
  readonly existingDispatchId: DispatchId | null;
}): IntegrationReconciliationContinuation {
  return {
    attemptId: 'integration-reconciliation-attempt:' + encodeURIComponent(input.reconciliationId),
    taskOperationId: input.taskOperationId,
    existingTaskId: input.existingTaskId,
    existingDispatchId: input.existingDispatchId,
  };
}

/** 稳定轮次身份；同一 Scope/Generation/Package/Round 只可能有一条。 */
export function integrationReconciliationId(input: {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly graphId: string;
  readonly graphGeneration: number;
  readonly workPackageId: WorkPackageId;
  readonly round: number;
}): string {
  return [
    input.coordinationScopeId,
    input.graphId,
    String(input.graphGeneration),
    input.workPackageId,
    'round-' + String(input.round),
  ]
    .map((segment) => encodeURIComponent(segment))
    .join(':');
}

/** 本轮 Git 步骤与续接 Task 的稳定 OperationId。 */
export function integrationReconciliationOperationIds(input: {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly graphId: string;
  readonly graphGeneration: number;
  readonly workPackageId: WorkPackageId;
  readonly round: number;
}): { readonly mergeCanonical: OperationId; readonly mergeCommit: OperationId; readonly continuationTask: OperationId } {
  const suffix = [
    input.coordinationScopeId,
    input.graphId,
    String(input.graphGeneration),
    input.workPackageId,
    'round-' + String(input.round),
  ]
    .map((segment) => encodeURIComponent(segment))
    .join(':');
  return {
    mergeCanonical: ('git-integration-merge-canonical:' + suffix) as OperationId,
    mergeCommit: ('git-integration-merge-commit:' + suffix) as OperationId,
    continuationTask: ('integration-reconciliation-task:' + suffix) as OperationId,
  };
}

/* -------------------------------------------------------------------------- */
/* 复验执行 seam                                                               */
/* -------------------------------------------------------------------------- */

/** 交给原 Validator Session 的复验请求；所有身份都来自可信装配，不由模型填写。 */
export type IntegrationReconciliationRequest = {
  readonly workPackageId: WorkPackageId;
  readonly round: number;
  readonly reconciliationId: string;
  readonly validationAttemptId: string;
  readonly sourceAcceptedResultRef: string;
  /** 原 Validator 的真实 Session Binding；复验必须落在同一 provider session 上。 */
  readonly sessionBinding: SessionBinding;
  /** 本轮目标 canonical HEAD。 */
  readonly targetHead: string;
  /** 合并产生的冲突路径；干净合并时为空。 */
  readonly conflictPaths: readonly string[];
  readonly worktreePath: string;
  readonly continuation: IntegrationReconciliationContinuation;
};

export type IntegrationReconciliationOutcome =
  | {
      readonly kind: 'validated';
      readonly evidence: readonly EvidenceRecord[];
      readonly sessionBinding: SessionBinding;
      /** Orca 实际分配的续接身份；由执行方回报并持久化，不由本模块伪造。 */
      readonly orcaTaskId: string | null;
      readonly dispatchId: DispatchId | null;
      /** 复验 Worker 声明的精确合并树；必须与 Controller 只读回读的树一致，否则不接受。 */
      readonly treeRef: string;
      /** Worker 声明的实际修改路径（与普通 Worker 的 filesModified 同形）；用于写范围准入。 */
      readonly filesModified: readonly string[];
      /** 本轮 Delivery 的真实身份；结算路径先 accept 再 ack，runner 不提前确认。 */
      readonly deliveryId: string | null;
      readonly deliveryRunId: string | null;
    }
  | { readonly kind: 'rejected'; readonly reason: string }
  | { readonly kind: 'session_lost'; readonly reason: string }
  | { readonly kind: 'escalation'; readonly reason: EscalationReason; readonly request: string }
  | { readonly kind: 'step_failed'; readonly code: string; readonly message: string };

/**
 * 复验执行 seam。
 *
 * 生产实现必须：以请求里的 continuation.taskOperationId 幂等地创建或复用续接 Task（已有
 * existingTaskId/existingDispatchId 时直接复用），再复验；原 terminal 可核验就复用，已退出才以原
 * CODEX_HOME 与精确 UUID 执行 codex resume，并核验前后是同一条 provider session。
 */
export type IntegrationReconciliationRunner = (
  request: IntegrationReconciliationRequest,
) => Promise<IntegrationReconciliationOutcome>;

/** 装配集成复验所需的全部可信事实；null 表示本进程没有复验能力。 */
export type IntegrationReconciliationContext = {
  readonly store: IntegrationReconciliationStore;
  readonly runner: IntegrationReconciliationRunner;
  readonly acceptResult: (
    reconciliationId: string, outcome: Extract<IntegrationReconciliationOutcome, { kind: 'validated' }>,
  ) => Promise<{ readonly kind: 'accepted' } | { readonly kind: 'blocked'; readonly reason: string }>;
  readonly acknowledgeResult: (
    record: IntegrationReconciliationRecord,
  ) => Promise<{ readonly kind: 'acknowledged' } | { readonly kind: 'blocked'; readonly reason: string }>;
  readonly isClosed?: () => boolean;
  readonly validationAttemptId: ValidationAttemptId;
  readonly sourceAcceptedResultRef: string;
  readonly sessionBinding: SessionBinding;
  /** 批准上限：每包独立于 Validator 修复预算。 */
  readonly limit: number;
  readonly budgetKey: string;
  readonly approvedLimitRef: string;
};

/* -------------------------------------------------------------------------- */
/* 单轮执行                                                                    */
/* -------------------------------------------------------------------------- */

export type RunIntegrationRoundInput = {
  readonly port: GitIntegrationPort;
  readonly reconciliation: IntegrationReconciliationContext;
  readonly store: BranchCoordinationStore;
  readonly writer: CoordinationWriter;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly graphId: string;
  readonly graphGeneration: number;
  readonly authorizationId: string;
  readonly runId: string;
  readonly consumerGeneration: number;
  readonly backendIdentityRef: string;
  readonly timeoutMs: number;
  readonly workPackageId: WorkPackageId;
  readonly worktreePath: string;
  /** 本轮要合并进来的、已归属的 canonical HEAD。 */
  readonly canonicalHead: string;
  readonly round: number;
  readonly commitMessage: string;
};

export type IntegrationRoundResult =
  | { readonly kind: 'completed'; readonly packageHead: string; readonly treeRef: string | null }
  | { readonly kind: 'budget_exhausted'; readonly limit: number; readonly consumed: number }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string }
  | { readonly kind: 'unknown'; readonly operationId: OperationId; readonly reason: string }
  | { readonly kind: 'blocked'; readonly laneKey: string; readonly reason: string };

function scopeFor(
  input: RunIntegrationRoundInput,
  operationId: OperationId,
  expectedRevision: Revision,
): ExecutionScope {
  const authority: ExecutionAuthority = {
    kind: 'execution_coordination',
    graphGeneration: input.graphGeneration,
    authorizationId: input.authorizationId,
    runId: input.runId,
    consumerGeneration: input.consumerGeneration,
  };
  return buildExecutionScope({
    coordinationScopeId: input.coordinationScopeId,
    coordinatorSessionId: input.writer.coordinatorSessionId,
    runtimeIncarnationId: input.writer.runtimeIncarnationId,
    fencingGeneration: input.writer.fencingGeneration,
    backendIdentityRef: input.backendIdentityRef,
    operationId,
    target: { kind: 'work-package', id: input.workPackageId },
    expectedRevision,
    timeoutMs: input.timeoutMs,
    authority,
  });
}

function currentRevision(input: RunIntegrationRoundInput): number | null {
  if (input.reconciliation.isClosed?.()) return null;
  const read = readScope(input.store, input.coordinationScopeId);
  return read.kind === 'read' ? read.scope.revision : null;
}

function asOperationOutcome(
  outcome: GitStepOutcome,
  operationId: OperationId,
  target: { readonly kind: string; readonly id: string },
): OperationOutcome<unknown> {
  if (outcome.kind === 'rejected') {
    return { kind: 'rejected', code: outcome.code, message: outcome.message };
  }
  if (outcome.kind === 'unknown') {
    return { kind: 'unknown', operation: { operationId, target }, reason: outcome.reason };
  }
  return { kind: 'accepted', operation: { operationId, target }, value: outcome };
}

type IntentStepRun =
  | { readonly kind: 'applied'; readonly outcome: GitStepOutcome }
  | { readonly kind: 'unknown'; readonly operationId: OperationId; readonly reason: string }
  | { readonly kind: 'blocked'; readonly laneKey: string; readonly reason: string };

/**
 * 登记意图、执行一个 Git 步骤、按原身份收尾。
 *
 * 重放语义与 integrateWorkPackage 一致：已有 settled accepted 意图时只读对账，绝不重跑 run；已有
 * pending/blocked 意图时也只读对账，成功则收尾（blocked 用 resolveLane），仍未知则保持阻塞并返回
 * unknown，因此 unknown 不会永久卡死。
 */
async function runIntentStep(
  input: RunIntegrationRoundInput,
  operationId: OperationId,
  request: GitStepRequest,
  expectedHead: string,
): Promise<IntentStepRun> {
  const target = { kind: 'work-package', id: input.workPackageId };
  if (input.reconciliation.isClosed?.()) return { kind: 'blocked', laneKey: input.workPackageId, reason: '运行已关闭' };
  const revision = readScope(input.store, input.coordinationScopeId);
  if (revision.kind === 'rejected') {
    return { kind: 'blocked', laneKey: input.workPackageId, reason: revision.message };
  }
  if (revision.scope.mode !== 'execution_coordination' || revision.scope.controlState !== 'active' ||
    revision.scope.graphId !== input.graphId || revision.scope.graphVersion === null)
    return { kind: 'blocked', laneKey: input.workPackageId, reason: '当前 Scope 不可推进 Git 集成' };
  const graph = input.store.query({ kind: 'graph-version', coordinationScopeId: input.coordinationScopeId,
    graphId: revision.scope.graphId, graphVersion: revision.scope.graphVersion });
  const holds = input.store.query({ kind: 'revision-holds', coordinationScopeId: input.coordinationScopeId,
    workPackageId: input.workPackageId });
  if (graph.kind !== 'graph-version' || graph.version?.generation !== input.graphGeneration ||
    !graph.version.graph.workPackages.some(entry => entry.workPackageId === input.workPackageId) ||
    holds.kind !== 'revision-holds' || holds.holds.some(entry => entry.state === 'pending'))
    return { kind: 'blocked', laneKey: input.workPackageId, reason: '当前包的图或修订状态不可集成' };
  const begun = beginIntent(input.store, {
    coordinationScopeId: input.coordinationScopeId,
    operationId,
    target,
    operationCategory: 'git-integration',
    expectedHead,
    writer: input.writer,
    expectedRevision: revision.scope.revision,
  });
  if (begun.kind === 'lane_blocked') {
    return { kind: 'blocked', laneKey: begun.laneKey, reason: 'lane 已被未决意图 ' + begun.blockingIntent.operationId + ' 阻塞' };
  }
  if (begun.kind === 'lane_busy') {
    return { kind: 'blocked', laneKey: begun.laneKey, reason: 'lane 上已有未决意图 ' + begun.activeIntent.operationId };
  }
  if (begun.kind === 'rejected') {
    return { kind: 'blocked', laneKey: input.workPackageId, reason: begun.rejection.message };
  }

  const scope = scopeFor(input, operationId, revision.scope.revision);

  if (begun.kind === 'existing') {
    // 已有意图一律只对账，不重跑 run。
    const reconciled = await input.port.reconcile(request, scope);
    if (reconciled.kind === 'unknown') {
      if (begun.intent.state === 'pending') {
        const blockedRevision = readScope(input.store, input.coordinationScopeId);
        if (blockedRevision.kind === 'read') {
          blockLane(input.store, {
            coordinationScopeId: input.coordinationScopeId,
            operationId,
            writer: input.writer,
            expectedRevision: blockedRevision.scope.revision,
            reason: reconciled.reason,
          });
        }
      }
      return { kind: 'unknown', operationId, reason: reconciled.reason };
    }
    const settleRevision = readScope(input.store, input.coordinationScopeId);
    if (settleRevision.kind === 'read') {
      if (begun.intent.state === 'blocked') {
        resolveLane(input.store, {
          coordinationScopeId: input.coordinationScopeId,
          operationId,
          writer: input.writer,
          expectedRevision: settleRevision.scope.revision,
          outcomeClass: 'accepted',
        });
      } else {
        settleIntent(input.store, {
          coordinationScopeId: input.coordinationScopeId,
          operationId,
          writer: input.writer,
          expectedRevision: settleRevision.scope.revision,
          outcome: asOperationOutcome(reconciled, operationId, target),
        });
      }
    }
    return { kind: 'applied', outcome: reconciled };
  }

  let outcome = await input.port.run(request, scope);
  if (outcome.kind === 'unknown') {
    outcome = await input.port.reconcile(request, scope);
  }
  if (outcome.kind === 'unknown') {
    const blockedRevision = readScope(input.store, input.coordinationScopeId);
    if (blockedRevision.kind === 'read') {
      blockLane(input.store, {
        coordinationScopeId: input.coordinationScopeId,
        operationId,
        writer: input.writer,
        expectedRevision: blockedRevision.scope.revision,
        reason: outcome.reason,
      });
    }
    return { kind: 'unknown', operationId, reason: outcome.reason };
  }
  const settleRevision = readScope(input.store, input.coordinationScopeId);
  if (settleRevision.kind === 'read') {
    const settled = settleIntent(input.store, {
      coordinationScopeId: input.coordinationScopeId,
      operationId,
      writer: input.writer,
      expectedRevision: settleRevision.scope.revision,
      outcome: asOperationOutcome(outcome, operationId, target),
    });
    // 步骤结果已发生但意图未持久化时不得声称 applied：保持阻塞，由下一次触发按原身份对账。
    if (settled.kind === 'rejected') {
      return { kind: 'blocked', laneKey: input.workPackageId, reason: settled.rejection.message };
    }
  }
  return { kind: 'applied', outcome };
}

type SettleRoundResult =
  | { readonly kind: 'settled' }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

function settleRound(
  input: RunIntegrationRoundInput,
  reconciliationId: string,
  state: 'validated' | 'rejected' | 'blocked',
  extras: {
    readonly mergedTreeRef?: string | null;
    readonly orcaTaskId?: string | null;
    readonly dispatchId?: DispatchId | null;
    readonly blockerRef?: string | null;
  } = {},
): SettleRoundResult {
  const revision = currentRevision(input);
  if (revision === null) {
    return { kind: 'rejected', code: 'scope_unreadable', message: '无法读取当前 Scope revision' };
  }
  const result = input.reconciliation.store.settle({
    coordinationScopeId: input.coordinationScopeId,
    expectedRevision: revision,
    writer: input.writer,
    workPackageId: input.workPackageId,
    reconciliationId,
    state,
    mergedTreeRef: extras.mergedTreeRef ?? null,
    orcaTaskId: extras.orcaTaskId ?? null,
    dispatchId: extras.dispatchId ?? null,
    blockerRef: extras.blockerRef ?? null,
  });
  return result.kind === 'settled'
    ? { kind: 'settled' }
    : { kind: 'rejected', code: result.code, message: result.message };
}

/**
 * 执行一轮集成复验。
 *
 * 顺序固定：登记轮次（与额度同事务）→ 读包 HEAD → merge canonical --no-commit → 原 Validator 复验
 * → 读合并树 → merge commit → 结算轮次。Git 步骤各自有 Operation Intent；unknown 只阻塞不结算，因此
 * 重启后仍可按原身份对账。
 */
export async function runIntegrationReconciliationRound(
  input: RunIntegrationRoundInput,
): Promise<IntegrationRoundResult> {
  const laneKey = input.workPackageId;
  const reconciliationId = integrationReconciliationId({
    coordinationScopeId: input.coordinationScopeId,
    graphId: input.graphId,
    graphGeneration: input.graphGeneration,
    workPackageId: input.workPackageId,
    round: input.round,
  });
  const operationIds = integrationReconciliationOperationIds({
    coordinationScopeId: input.coordinationScopeId,
    graphId: input.graphId,
    graphGeneration: input.graphGeneration,
    workPackageId: input.workPackageId,
    round: input.round,
  });

  const revision = currentRevision(input);
  if (revision === null) {
    return { kind: 'blocked', laneKey, reason: '无法读取当前 Scope revision' };
  }
  const registered = input.reconciliation.store.register({
    coordinationScopeId: input.coordinationScopeId,
    expectedRevision: revision,
    writer: input.writer,
    workPackageId: input.workPackageId,
    reconciliationId,
    round: input.round,
    validationAttemptId: input.reconciliation.validationAttemptId,
    sourceAcceptedResultRef: input.reconciliation.sourceAcceptedResultRef,
    targetHead: input.canonicalHead,
    budgetKey: input.reconciliation.budgetKey,
    approvedLimitRef: input.reconciliation.approvedLimitRef,
  });
  if (registered.kind === 'rejected') {
    if (registered.code === 'budget_exhausted') {
      return { kind: 'budget_exhausted', limit: input.reconciliation.limit, consumed: input.round };
    }
    return {
      kind: 'blocked',
      laneKey,
      reason: '第 ' + String(input.round) + ' 轮集成复验无法登记：' + registered.message,
    };
  }
  const record = registered.record;
  if (record.state === 'validated') {
    const head = await input.port.readHead({ kind: 'source', worktreePath: input.worktreePath });
    if (head.kind === 'unavailable') {
      // 无法回读包 HEAD 就不能宣告完成：保持阻塞，由下一次触发按同一轮次对账。
      return { kind: 'blocked', laneKey, reason: '无法回读包 worktree HEAD：' + head.reason };
    }
    const acknowledged = await input.reconciliation.acknowledgeResult(record);
    if (acknowledged.kind === 'blocked') return { kind: 'blocked', laneKey, reason: acknowledged.reason };
    return { kind: 'completed', packageHead: head.head, treeRef: record.mergedTreeRef };
  }
  if (record.state === 'rejected') {
    return { kind: 'blocked', laneKey, reason: '第 ' + String(input.round) + ' 轮集成复验已被拒绝' };
  }
  // pending 或 blocked 都允许继续：blocked 只表示上一次未证明成功；报告可证明时用同一轮次身份续办，
  // 不新建轮次、不重置额度，也不主张原 session 仍然存在。

  const headRead = await input.port.readHead({ kind: 'source', worktreePath: input.worktreePath });
  if (headRead.kind === 'unavailable') {
    return { kind: 'blocked', laneKey, reason: '无法回读包 worktree HEAD：' + headRead.reason };
  }
  const packageHead = headRead.head;

  // 重放时沿用原意图的 expectedHead：崩溃后 HEAD 已前移，用新 head 会造成同一 OperationId 载荷漂移。
  const priorMergeCanonicalIntent = input.store.query({
    kind: 'intent',
    coordinationScopeId: input.coordinationScopeId,
    operationId: operationIds.mergeCanonical,
  });
  const mergeCanonicalHead =
    priorMergeCanonicalIntent.kind === 'intent' &&
    priorMergeCanonicalIntent.intent !== null &&
    priorMergeCanonicalIntent.intent.expectedHead !== null
      ? priorMergeCanonicalIntent.intent.expectedHead
      : input.canonicalHead;
  const mergeRequest: GitStepRequest = {
    step: 'merge_canonical',
    workPackageId: input.workPackageId,
    sourceWorktreePath: input.worktreePath,
    branch: input.graphId,
    sourceBranch: input.graphId,
    remote: null,
    ref: null,
    expectedHead: mergeCanonicalHead,
    commitMessage: null,
  };
  const merged = await runIntentStep(input, operationIds.mergeCanonical, mergeRequest, mergeCanonicalHead);
  if (merged.kind === 'unknown') {
    return { kind: 'unknown', operationId: merged.operationId, reason: merged.reason };
  }
  if (merged.kind === 'blocked') {
    return { kind: 'blocked', laneKey: merged.laneKey, reason: merged.reason };
  }
  const mergeOutcome = merged.outcome;
  if (mergeOutcome.kind === 'rejected') {
    settleRound(input, reconciliationId, 'rejected');
    return { kind: 'rejected', code: mergeOutcome.code, message: mergeOutcome.message };
  }
  if (mergeOutcome.kind === 'unknown') {
    return { kind: 'unknown', operationId: operationIds.mergeCanonical, reason: mergeOutcome.reason };
  }
  if (mergeOutcome.kind !== 'merge_applied' && mergeOutcome.kind !== 'already_merged') {
    const reason = 'merge_canonical 返回了意外的结果形态 ' + mergeOutcome.kind;
    settleRound(input, reconciliationId, 'blocked', { blockerRef: reason });
    return { kind: 'blocked', laneKey, reason };
  }
  const applied = mergeOutcome.kind === 'merge_applied';
  const conflictPaths = applied ? mergeOutcome.conflicts : [];

  let validatedOutcome: IntegrationReconciliationOutcome | null = null;
  // 已包含 canonical 时树未改变，无需复验；否则由原 Validator 复验精确合并树。
  if (applied) {
    const continuation = integrationReconciliationContinuation({
      reconciliationId,
      taskOperationId: operationIds.continuationTask,
      existingTaskId: record.orcaTaskId,
      existingDispatchId: record.dispatchId === null ? null : (record.dispatchId as DispatchId),
    });
    let outcome: IntegrationReconciliationOutcome;
    try {
      outcome = await input.reconciliation.runner({
        workPackageId: input.workPackageId,
        round: input.round,
        reconciliationId,
        validationAttemptId: input.reconciliation.validationAttemptId,
        sourceAcceptedResultRef: input.reconciliation.sourceAcceptedResultRef,
        sessionBinding: input.reconciliation.sessionBinding,
        targetHead: input.canonicalHead,
        conflictPaths,
        worktreePath: input.worktreePath,
        continuation,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : '集成复验通道抛出了非 Error 值';
      settleRound(input, reconciliationId, 'blocked', { blockerRef: reason });
      return { kind: 'blocked', laneKey, reason };
    }
    if (outcome.kind === 'session_lost') {
      settleRound(input, reconciliationId, 'blocked', { blockerRef: outcome.reason });
      return { kind: 'blocked', laneKey, reason: outcome.reason };
    }
    if (outcome.kind === 'escalation') {
      settleRound(input, reconciliationId, 'blocked', { blockerRef: outcome.request });
      return {
        kind: 'blocked',
        laneKey,
        reason: '集成复验需要升级（' + outcome.reason + '）：' + outcome.request,
      };
    }
    if (outcome.kind === 'step_failed') {
      return { kind: 'rejected', code: outcome.code, message: outcome.message };
    }
    if (outcome.kind === 'rejected') {
      settleRound(input, reconciliationId, 'rejected');
      return { kind: 'rejected', code: 'integration_revalidation_rejected', message: outcome.reason };
    }
    validatedOutcome = outcome;
  }

  // 复验通过后读精确树：already_merged 也必须读树（结算 validated 要求非空 mergedTreeRef）。
  const tree = await input.port.readTree({ worktreePath: input.worktreePath });
  if (tree.kind === 'unavailable') {
    settleRound(input, reconciliationId, 'blocked', { blockerRef: '无法回读合并树：' + tree.reason });
    return { kind: 'blocked', laneKey, reason: '无法回读合并树：' + tree.reason };
  }
  // Worker 声明的合并树必须等于 Controller 只读回读的精确树；不一致即不接受未经核验的树。
  if (validatedOutcome !== null && validatedOutcome.treeRef !== tree.tree) {
    settleRound(input, reconciliationId, 'blocked', {
      blockerRef: 'Worker 声明的合并树与 Controller 回读不一致',
    });
    return {
      kind: 'blocked',
      laneKey,
      reason: '复验 Worker 声明的合并树与 Controller 只读回读的树不一致：不接受未经核验的树',
    };
  }
  if (validatedOutcome !== null) {
    const accepted = await input.reconciliation.acceptResult(reconciliationId, validatedOutcome);
    if (accepted.kind === 'blocked') return { kind: 'blocked', laneKey, reason: accepted.reason };
  }

  let packageHeadAfter = packageHead;
  if (applied) {
    const priorMergeCommitIntent = input.store.query({
      kind: 'intent',
      coordinationScopeId: input.coordinationScopeId,
      operationId: operationIds.mergeCommit,
    });
    const mergeCommitHead =
      priorMergeCommitIntent.kind === 'intent' &&
      priorMergeCommitIntent.intent !== null &&
      priorMergeCommitIntent.intent.expectedHead !== null
        ? priorMergeCommitIntent.intent.expectedHead
        : packageHead;
    const commitRequest: GitStepRequest = {
      step: 'merge_commit',
      workPackageId: input.workPackageId,
      sourceWorktreePath: input.worktreePath,
      branch: input.graphId,
      sourceBranch: input.graphId,
      remote: null,
      ref: null,
      expectedHead: mergeCommitHead,
      expectedTree: tree.tree,
      commitMessage: input.commitMessage,
    };
    const committed = await runIntentStep(input, operationIds.mergeCommit, commitRequest, mergeCommitHead);
    if (committed.kind === 'unknown') {
      return { kind: 'unknown', operationId: committed.operationId, reason: committed.reason };
    }
    if (committed.kind === 'blocked') {
      return { kind: 'blocked', laneKey: committed.laneKey, reason: committed.reason };
    }
    if (committed.outcome.kind !== 'committed') {
      const code = committed.outcome.kind === 'rejected' ? committed.outcome.code : 'merge_commit_failed';
      const message = committed.outcome.kind === 'rejected' ? committed.outcome.message : 'merge commit 未产生可核验的 HEAD';
      settleRound(input, reconciliationId, 'rejected');
      return { kind: 'rejected', code, message };
    }
    packageHeadAfter = committed.outcome.head;
  }

  const settled = settleRound(input, reconciliationId, 'validated', {
    mergedTreeRef: tree.tree,
    orcaTaskId: validatedOutcome === null ? null : validatedOutcome.orcaTaskId,
    dispatchId: validatedOutcome === null ? null : validatedOutcome.dispatchId,
  });
  if (settled.kind === 'rejected') {
    // 结算未持久化时绝不宣告完成：保持阻塞，避免未落盘的结果被当成已接受。
    return { kind: 'blocked', laneKey, reason: '集成复验轮次 validated 未持久化：' + settled.message };
  }
  const recorded = input.reconciliation.store.list(input.coordinationScopeId, input.workPackageId);
  if (recorded.kind === 'rejected') return { kind: 'blocked', laneKey, reason: recorded.message };
  const validated = recorded.records.find(entry => entry.reconciliationId === reconciliationId && entry.state === 'validated');
  if (validated === undefined) return { kind: 'blocked', laneKey, reason: '无法回读已通过的集成复验轮次' };
  const acknowledged = await input.reconciliation.acknowledgeResult(validated);
  if (acknowledged.kind === 'blocked') return { kind: 'blocked', laneKey, reason: acknowledged.reason };
  return { kind: 'completed', packageHead: packageHeadAfter, treeRef: tree.tree };
}
