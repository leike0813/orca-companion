/**
 * IC-02 / IC-03 / IP-A2：Dispatch Candidate 的物化用例
 * （Owner: `m1-admit-work-package-specifications`）。
 *
 * 一次物化严格按固定顺序执行，并且任一前置条件不成立时不产生任何副作用：
 *
 * 1. 读取当前事实（图位置、授权、预算、控制状态）；
 * 2. IP-A1 纯判定；被拒绝时只记录原因；
 * 3. 查询该 Work Package 既有 worktree；核验通过则复用，否则建立并核验；
 * 4. 复用既有 Materialization Binding；没有绑定时才执行 `task-create`；
 * 5. 回写 Materialization Binding，再结算 Task Operation Intent；
 * 6. 以独立 Operation Intent 执行 `worker-start --task` 并核验 receipt。
 *
 * `unknown` 一律以原 OperationId 对账：`absent` 与 `pending` 都不是「未发生」的证明，因此该 lane 保持
 * 阻塞，绝不用新 ID 重试，也绝不创建第二个 Task。
 */

import type { CoordinationScopeId, OperationId, WorkPackageId } from './dto/identity.js';
import type {
  ExecutionQueryResult,
  OperationOutcome,
} from './dto/operation-outcome.js';
import type {
  BranchCoordinationStore,
  CoordinationWriter,
  MaterializationBindingRecord,
} from './ports/branch-coordination-store.js';
import type {
  ExecutionBackend,
  ExecutionMutation,
  ExecutionScope,
  WorktreeListResult,
  WorktreeSummary,
} from './ports/execution-backend.js';
import { reconcileOperation } from './ports/execution-backend.js';
import { beginIntent, blockLane, settleIntent } from './coordination/intent-service.js';
import { readScope } from './planning/scope-read.js';
import { parseTaskEnvelope } from './worker-report-dto.js';
import {
  activatePreparedWorker,
  prepareWorkerLaunch,
  verifyPreparedWorker,
  type WorkerLaunchFailure,
  type WorkerLaunchStrategy,
} from './worker-launch.js';
import {
  evaluateDispatchCandidate,
  type DispatchCandidateFacts,
  type DispatchCandidateRejection,
} from '../domain/dispatch-candidate.js';
import type { WorkerRole } from '../domain/planning/execution-authorization.js';
import type { TaskEnvelope } from '../domain/task-contract.js';

/** worktree metadata 里的 Work Package 归属标记；这是「复用而不是重建」的唯一判据。 */
export const WORK_PACKAGE_COMMENT_PREFIX = 'workPackageId=';

export function workPackageComment(workPackageId: WorkPackageId): string {
  return `${WORK_PACKAGE_COMMENT_PREFIX}${workPackageId}`;
}

/** Orca worktree 名称是短标识，不承担身份语义；归属由 comment 表达。 */
export function worktreeNameFor(workPackageId: WorkPackageId): string {
  return `wp-${workPackageId}`.slice(0, 128);
}

/**
 * 一次物化用到的稳定 OperationId，按外部 mutation 分组。
 *
 * 每个外部 mutation 有自己的 OperationId：IC-03 的一个 intent 只对应一个 OperationId，且同一个
 * OperationId 不能被两次不同的外部调用复用（`unknown` 对账需要唯一的 request 归属）。「稳定」指的是
 * 同一操作在恢复重放时沿用同一个 ID，而不是多次不同调用共用一个 ID。
 */
export type MaterializeOperationIds = {
  readonly worktree: OperationId;
  readonly task: OperationId;
  readonly workerPrepare: OperationId;
  readonly workerStart: OperationId;
  readonly workerActivate: OperationId;
};

export type MaterializeCandidateContext = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly writer: CoordinationWriter;
  readonly role: WorkerRole;
  readonly graphGeneration: number;
  readonly authorizationId: string;
  readonly runId: string;
  readonly consumerGeneration: number;
  readonly backendIdentityRef: string;
  /** Controller 组装的结构化 Task Envelope；物化前与实际 worktree 重新绑定并校验。 */
  readonly taskEnvelope: TaskEnvelope;
  readonly taskDependencies?: readonly string[];
  readonly taskTitle?: string;
  readonly displayName?: string;
  /** 可信 bootstrap 选择的封闭启动策略；prepared launcher 只能由 Harness Adapter 生成。 */
  readonly workerLaunch: WorkerLaunchStrategy;
  readonly timeoutMs: number;
};

export type MaterializeWorktreePaths = {
  /** 仓库选择器，例如 `path:<canonical-worktree>`。 */
  readonly repoSelector: string;
  /** canonical worktree 的绝对路径；只用于核验，不落盘。 */
  readonly canonicalWorktree: string;
  /** 当前 Authorization 绑定的 canonical branch。 */
  readonly baseBranch: string;
  /** 当前 Authorization 绑定的 exact baseline HEAD。 */
  readonly baselineHead: string;
};

export type MaterializeWorkPackageContext = {
  readonly candidate: MaterializeCandidateContext;
  readonly paths: MaterializeWorktreePaths;
  readonly operationIds: MaterializeOperationIds;
  /** 声明的 Work Package 骨架；scope envelope 与预算上限来自这里。 */
  readonly workPackage: Pick<DispatchCandidateFacts, 'scopeEnvelope' | 'budget'>;
};

export type MaterializeWorkPackageInput = {
  readonly store: BranchCoordinationStore;
  readonly backend: ExecutionBackend;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly workPackageId: WorkPackageId;
  /** 本次物化用到的稳定 ID；恢复重放必须传同一组值。 */
  readonly context: MaterializeWorkPackageContext;
  /** 当前事实；由 Controller 从 store 与图读取后注入，避免用例自行猜测权威来源。 */
  readonly facts: Omit<
    DispatchCandidateFacts,
    'candidateWorkPackageId' | 'candidateRole' | 'scopeEnvelope' | 'budget'
  >;
  readonly expectedRevision: number;
};

export type MaterializationFailure = {
  readonly code: string;
  readonly message: string;
};

export type MaterializeWorkPackageResult =
  | {
      readonly kind: 'materialized';
      readonly worktree: WorktreeSummary;
      readonly orcaTaskId: string;
      readonly dispatchId: string | null;
      /** `true` 表示 worktree 是复用既有资源，而不是本次建立。 */
      readonly worktreeReused: boolean;
    }
  | { readonly kind: 'rejected'; readonly failure: MaterializationFailure; readonly rejection?: DispatchCandidateRejection }
  | { readonly kind: 'unknown'; readonly operationId: OperationId; readonly reason: string }
  | { readonly kind: 'blocked'; readonly laneKey: string; readonly reason: string };

function taskIdFromReceipt(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['id', 'taskId', 'task_id']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  return null;
}

function dispatchIdFromReceipt(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['dispatchId', 'dispatch_id']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  return null;
}

type WorktreeListing =
  | { readonly kind: 'listed'; readonly worktrees: readonly WorktreeSummary[] }
  | { readonly kind: 'failed'; readonly failure: MaterializationFailure };

function readWorktreeList(result: ExecutionQueryResult): WorktreeListing {
  if (result.kind !== 'accepted') {
    return { kind: 'failed', failure: { code: result.code, message: result.message } };
  }
  const value = result.value as WorktreeListResult;
  if (
    typeof value !== 'object' ||
    value === null ||
    !Array.isArray(value.worktrees) ||
    typeof value.totalCount !== 'number' ||
    typeof value.truncated !== 'boolean' ||
    value.hostScope === undefined ||
    (value.hostScope !== null && !Array.isArray(value.hostScope.omittedHostIds))
  ) {
    return { kind: 'failed', failure: { code: 'invalid_response', message: 'worktree list 返回了无效结果' } };
  }
  if (value.truncated || value.hostScope === null || value.hostScope.omittedHostIds.length > 0) {
    return {
      kind: 'failed',
      failure: { code: 'worktree_scope_unverifiable', message: 'worktree 列举未覆盖全部执行主机' },
    };
  }
  return { kind: 'listed', worktrees: value.worktrees };
}

type MaterializationBindingRead =
  | { readonly kind: 'read'; readonly binding: MaterializationBindingRecord | null }
  | { readonly kind: 'failed'; readonly failure: MaterializationFailure };

function readMaterializationBinding(input: MaterializeWorkPackageInput): MaterializationBindingRead {
  const result = input.store.query({
    kind: 'materialization-bindings',
    coordinationScopeId: input.coordinationScopeId,
    workPackageId: input.workPackageId,
  });
  if (result.kind === 'rejected') {
    return { kind: 'failed', failure: { code: result.code, message: result.message } };
  }
  if (result.kind !== 'materialization-bindings') {
    return {
      kind: 'failed',
      failure: { code: 'invalid_state', message: '物化绑定查询返回了错误的结果种类' },
    };
  }
  if (result.bindings.length > 1) {
    return {
      kind: 'failed',
      failure: { code: 'invalid_state', message: '同一 Work Package 存在多个物化绑定' },
    };
  }
  return { kind: 'read', binding: result.bindings[0] ?? null };
}

/**
 * 既有 worktree 是否就是这个 Work Package 的隔离工作区。
 *
 * 仓库归属已由 `worktree-list --repo <selector>` 保证，这里判定三件事：它带本 Work Package 的归属
 * 标记、它不是 canonical worktree、也不是仓库的 main worktree。Work Package 必须使用隔离 worktree，
 * 所以「看起来像」还不够，必须排除掉会污染主线的那一个。
 */
export function worktreeMatches(
  worktree: WorktreeSummary,
  workPackageId: WorkPackageId,
  canonicalWorktree: string,
): boolean {
  if (worktree.isMainWorktree || worktree.path === canonicalWorktree) {
    return false;
  }
  return worktree.comment === workPackageComment(workPackageId);
}

function executionScope(
  input: MaterializeWorkPackageInput,
  operationId: OperationId,
  target: { readonly kind: string; readonly id: string },
  expectedRevision: number,
): ExecutionScope {
  return {
    coordinationScopeId: input.coordinationScopeId,
    coordinatorSessionId: input.context.candidate.writer.coordinatorSessionId,
    runtimeIncarnationId: input.context.candidate.writer.runtimeIncarnationId,
    fencingGeneration: input.context.candidate.writer.fencingGeneration,
    backendIdentityRef: input.context.candidate.backendIdentityRef,
    operationId,
    target,
    expectedRevision,
    timeoutMs: input.context.candidate.timeoutMs,
    authority: {
      kind: 'execution_coordination',
      graphGeneration: input.context.candidate.graphGeneration,
      authorizationId: input.context.candidate.authorizationId,
      runId: input.context.candidate.runId,
      consumerGeneration: input.context.candidate.consumerGeneration,
    },
  };
}

/** `accepted` 携带的确定失败（Orca 记录了结果，但结果是拒绝）。 */
function definiteFailureCode(outcome: OperationOutcome<unknown>): string | null {
  if (outcome.kind !== 'accepted') {
    return null;
  }
  const value = outcome.value;
  if (typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false) {
    const code = (value as { code?: unknown }).code;
    return typeof code === 'string' && code.length > 0 ? code : 'definite_failure';
  }
  return null;
}

/**
 * 物化一个 Dispatch Candidate。
 *
 * 调用方负责提供已经读好的事实与稳定 OperationId：用例本身不生成 ID、不换 ID 重试、不读时钟。
 */
export async function materializeWorkPackage(
  input: MaterializeWorkPackageInput,
): Promise<MaterializeWorkPackageResult> {
  const { candidate, paths, operationIds, workPackage } = input.context;
  // 调用方给出的 revision 必须仍然是最新读到的那个：否则它依据的事实已经过期。
  const current = readScope(input.store, input.coordinationScopeId);
  if (current.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: current.code, message: current.message } };
  }
  if (current.scope.revision !== input.expectedRevision) {
    return {
      kind: 'rejected',
      failure: {
        code: 'stale_revision',
        message: `expected revision ${input.expectedRevision} 已过期，当前为 ${current.scope.revision}`,
      },
    };
  }
  const reconciliations = input.store.query({
    kind: 'baseline-reconciliations',
    coordinationScopeId: input.coordinationScopeId,
    workPackageId: input.workPackageId,
  });
  if (reconciliations.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: reconciliations.code, message: reconciliations.message } };
  }
  if (reconciliations.kind !== 'baseline-reconciliations') {
    return { kind: 'rejected', failure: { code: 'invalid_state', message: '无法读取基线补救状态' } };
  }
  if (reconciliations.reconciliations.some((entry) => entry.state !== 'verified')) {
    return { kind: 'rejected', failure: { code: 'baseline_reconciliation_pending', message: '基线补救尚未核验通过' } };
  }
  const decision = evaluateDispatchCandidate({
    ...input.facts,
    candidateWorkPackageId: input.workPackageId,
    candidateRole: candidate.role,
    scopeEnvelope: workPackage.scopeEnvelope,
    budget: workPackage.budget,
  });
  if (decision.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: decision.rejection.code, message: decision.rejection.message }, rejection: decision.rejection };
  }
  const initialEnvelope = parseTaskEnvelope(candidate.taskEnvelope, {
    workerTaskId: candidate.taskEnvelope.workerTaskId,
    dispatchId: candidate.taskEnvelope.dispatchId,
    attemptId: candidate.taskEnvelope.attemptId,
    role: candidate.role,
  });
  if (
    initialEnvelope.kind === 'rejected' ||
    initialEnvelope.envelope.taskContract.workPackageId !== input.workPackageId ||
    initialEnvelope.envelope.role !== candidate.role
  ) {
    return {
      kind: 'rejected',
      failure: {
        code: initialEnvelope.kind === 'rejected' ? initialEnvelope.code : 'task_envelope_mismatch',
        message:
          initialEnvelope.kind === 'rejected'
            ? initialEnvelope.message
            : 'Task Envelope 的 Work Package 或角色与 Dispatch Candidate 不一致',
      },
    };
  }

  // 步骤 3：先查既有 worktree，核验通过即复用；不把路径写进本地记录。
  const listed = readWorktreeList(
    await input.backend.query({ operation: 'worktree-list', repo: paths.repoSelector, limit: 1_000 }),
  );
  if (listed.kind === 'failed') {
    return { kind: 'rejected', failure: listed.failure };
  }
  const existing = listed.worktrees.find((worktree) =>
    worktreeMatches(worktree, input.workPackageId, paths.canonicalWorktree),
  );

  let worktree = existing ?? null;
  let worktreeReused = existing !== undefined;

  if (worktree === null) {
    const created = await runMutation(
      input,
      operationIds.worktree,
      'worktree',
      {
        operation: 'worktree-create',
        repo: paths.repoSelector,
        name: worktreeNameFor(input.workPackageId),
        comment: workPackageComment(input.workPackageId),
        baseBranch: paths.baseBranch,
      },
      interpretWorktreeCreation,
      async (value) => {
        const verified = readWorktreeList(
          await input.backend.query({ operation: 'worktree-list', repo: paths.repoSelector, limit: 1_000 }),
        );
        if (verified.kind === 'failed') {
          return verified.failure;
        }
        const found = verified.worktrees.find((entry) => entry.worktreeId === value.worktreeId);
        return found !== undefined &&
          found.head === paths.baselineHead &&
          worktreeMatches(found, input.workPackageId, paths.canonicalWorktree)
          ? null
          : { code: 'unknown', message: 'worktree 建立后无法在实时事实中核验其身份' };
      },
    );
    if (created.kind !== 'worktree-created') {
      return created.result;
    }
    worktreeReused = false;
    const verified = readWorktreeList(
      await input.backend.query({ operation: 'worktree-list', repo: paths.repoSelector, limit: 1_000 }),
    );
    if (verified.kind === 'failed') {
      return { kind: 'rejected', failure: verified.failure };
    }
    const found = verified.worktrees.find(
      (entry) =>
        entry.worktreeId === created.worktreeId &&
        worktreeMatches(entry, input.workPackageId, paths.canonicalWorktree),
    );
    if (found === undefined) {
      return {
        kind: 'unknown',
        operationId: operationIds.worktree,
        reason: 'worktree 建立后无法在实时事实中核验其身份',
      };
    }
    worktree = found;
  }

  const finalEnvelope = parseTaskEnvelope(
    {
      ...initialEnvelope.envelope,
      workspace: { ...initialEnvelope.envelope.workspace, worktreeId: worktree.worktreeId },
    },
    {
      workerTaskId: initialEnvelope.envelope.workerTaskId,
      dispatchId: initialEnvelope.envelope.dispatchId,
      attemptId: initialEnvelope.envelope.attemptId,
      role: initialEnvelope.envelope.role,
    },
  );
  if (finalEnvelope.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: finalEnvelope.code, message: finalEnvelope.message } };
  }

  // 步骤 4-6：先复用已记录的 Task；没有绑定时才创建，并在 intent 结算前记录绑定。
  const bindingRead = readMaterializationBinding(input);
  if (bindingRead.kind === 'failed') {
    return { kind: 'blocked', laneKey: input.workPackageId, reason: bindingRead.failure.message };
  }
  let orcaTaskId = bindingRead.binding?.orcaTaskId ?? null;
  if (orcaTaskId === null) {
    const task = await runMutation(
      input,
      operationIds.task,
      'task',
      {
        operation: 'task-create',
        spec: JSON.stringify(finalEnvelope.envelope),
        ...(candidate.taskDependencies === undefined ? {} : { deps: candidate.taskDependencies }),
        ...(candidate.taskTitle === undefined ? {} : { taskTitle: candidate.taskTitle }),
        ...(candidate.displayName === undefined ? {} : { displayName: candidate.displayName }),
      },
      interpretTaskCreation,
      (value) => recordMaterializationBinding(input, value.taskId, operationIds.task),
    );
    if (task.kind !== 'task-created') {
      return task.result;
    }
    orcaTaskId = task.taskId;
  }

  const launch = await prepareWorkerLaunch({
    backend: input.backend,
    strategy: candidate.workerLaunch,
    worktreeId: worktree.worktreeId,
    worktreePath: worktree.path,
    timeoutMs: candidate.timeoutMs,
    createTerminal: async (mutation) => {
      const prepared = await runMutation(
        input,
        operationIds.workerPrepare,
        'worker-terminal',
        mutation,
        () => ({ kind: 'terminal-created' as const }),
      );
      return prepared.kind === 'terminal-created'
        ? { kind: 'accepted' as const }
        : materializeLaunchFailure(prepared.result);
    },
  });
  if (launch.kind !== 'ready') {
    return materializeResultFromLaunchFailure(launch);
  }

  const started = await runMutation(
    input,
    operationIds.workerStart,
    'worker-start',
    {
      operation: 'worker-start',
      taskId: orcaTaskId,
      worktree: worktree.worktreeId,
      ...launch.worker,
    },
    interpretWorkerStart,
    async (value) => {
      if (launch.preparedTerminal === null) {
        return null;
      }
      if (value.dispatchId === null) {
        return { code: 'worker_adoption_unverifiable', message: 'prepared worker-start 回执缺少 dispatch id' };
      }
      const verified = await verifyPreparedWorker(input.backend, value.dispatchId, launch.preparedTerminal);
      return verified === null ? null : { code: verified.kind, message: 'message' in verified ? verified.message : verified.reason };
    },
  );
  if (started.kind !== 'worker-started') {
    return started.result;
  }

  const activated = await activatePreparedWorker({
    backend: input.backend,
    terminal: launch.preparedTerminal,
    submitTerminal: async (mutation) => {
      const submitted = await runMutation(
        input,
        operationIds.workerActivate,
        'worker-activate',
        mutation,
        () => ({ kind: 'worker-activated' as const }),
      );
      return submitted.kind === 'worker-activated'
        ? { kind: 'accepted' as const }
        : materializeLaunchFailure(submitted.result);
    },
  });
  if (activated.kind !== 'accepted') {
    return materializeResultFromLaunchFailure(activated);
  }

  return {
    kind: 'materialized',
    worktree,
    orcaTaskId,
    dispatchId: started.dispatchId,
    worktreeReused,
  };
}

function recordMaterializationBinding(
  input: MaterializeWorkPackageInput,
  orcaTaskId: string,
  creationOperationId: OperationId,
): MaterializationFailure | null {
  const current = readScope(input.store, input.coordinationScopeId);
  if (current.kind === 'rejected') {
    return { code: current.code, message: current.message };
  }
  const recorded = input.store.transact({
    kind: 'record-materialization-binding',
    coordinationScopeId: input.coordinationScopeId,
    expectedRevision: current.scope.revision,
    writer: input.context.candidate.writer,
    workPackageId: input.workPackageId,
    orcaTaskId,
    creationOperationId,
  });
  return recorded.kind === 'rejected'
    ? { code: recorded.code, message: recorded.message }
    : null;
}

/**
 * 三类 mutation 的回执解释。缺失可核验身份时返回失败原因，而不是猜一个 ID。
 */
function interpretWorktreeCreation(
  outcome: Extract<OperationOutcome<unknown>, { kind: 'accepted' }>,
): { readonly kind: 'worktree-created'; readonly worktreeId: string } | MaterializationFailure {
  const worktreeId = (outcome.value as { worktreeId?: unknown } | null)?.worktreeId;
  if (typeof worktreeId !== 'string' || worktreeId.length === 0) {
    return { code: 'unknown', message: 'worktree create 回执缺少 worktree id，无法核验身份' };
  }
  return { kind: 'worktree-created', worktreeId };
}

function interpretTaskCreation(
  outcome: Extract<OperationOutcome<unknown>, { kind: 'accepted' }>,
): { readonly kind: 'task-created'; readonly taskId: string } | MaterializationFailure {
  const taskId = taskIdFromReceipt(outcome.value);
  if (taskId === null || taskId.length === 0) {
    return { code: 'unknown', message: 'task-create 回执缺少可核验的 task id' };
  }
  return { kind: 'task-created', taskId };
}

function interpretWorkerStart(
  outcome: Extract<OperationOutcome<unknown>, { kind: 'accepted' }>,
): { readonly kind: 'worker-started'; readonly dispatchId: string | null } | MaterializationFailure {
  return { kind: 'worker-started', dispatchId: dispatchIdFromReceipt(outcome.value) };
}

function materializeLaunchFailure(result: MaterializeWorkPackageResult): WorkerLaunchFailure {
  if (result.kind === 'rejected') {
    return { kind: 'rejected', code: result.failure.code, message: result.failure.message };
  }
  if (result.kind === 'unknown' || result.kind === 'blocked') {
    return result;
  }
  return { kind: 'rejected', code: 'invalid_state', message: 'terminal-create 返回了意外的物化结果' };
}

function materializeResultFromLaunchFailure(failure: WorkerLaunchFailure): MaterializeWorkPackageResult {
  return failure.kind === 'rejected'
    ? { kind: 'rejected', failure: { code: failure.code, message: failure.message } }
    : failure;
}

/** 一次 mutation 尝试的结果：要么成功，要么带着完整结果失败。 */
type MutationAttempt<T> =
  | T
  | { readonly kind: 'failed'; readonly result: MaterializeWorkPackageResult };

/**
 * 执行一次受 Intent 保护的 mutation。
 *
 * 顺序固定：begin intent → 调用 backend → settle/block intent。`unknown` 只做一次原 OperationId 对账，
 * 对账仍不确定就把 lane 阻塞在原地，绝不换 ID 重试。
 */
async function runMutation<T extends { readonly kind: string }>(
  input: MaterializeWorkPackageInput,
  operationId: OperationId,
  purpose: 'worktree' | 'task' | 'worker-terminal' | 'worker-start' | 'worker-activate',
  mutation: ExecutionMutation,
  interpret: (outcome: Extract<OperationOutcome<unknown>, { kind: 'accepted' }>) => T | MaterializationFailure,
  beforeSettle?: (value: T) => MaterializationFailure | null | Promise<MaterializationFailure | null>,
): Promise<MutationAttempt<T>> {
  const target = {
    kind: purpose === 'worktree' ? 'worktree' : purpose === 'task' ? 'task' : 'worker-task',
    id: input.workPackageId,
  };
  /**
   * 每次写入前重新读取 revision。
   *
   * 同一个用例会连续写多次（intent 落盘、收尾、回写绑定），每次写入都会推进 Scope revision；
   * 沿用上一次读到的值只会把自己的第二次写入判成 stale。
   */
  const freshRevision = (): number | MaterializationFailure => {
    const read = readScope(input.store, input.coordinationScopeId);
    return read.kind === 'rejected'
      ? { code: read.code, message: read.message }
      : read.scope.revision;
  };

  const firstRevision = freshRevision();
  if (typeof firstRevision !== 'number') {
    return {
      kind: 'failed',
      result: { kind: 'blocked', laneKey: input.workPackageId, reason: firstRevision.message },
    };
  }
  const expectedRevision = firstRevision;
  const begun = beginIntent(input.store, {
    coordinationScopeId: input.coordinationScopeId,
    operationId,
    target,
    operationCategory: `materialize-${purpose}`,
    writer: input.context.candidate.writer,
    expectedRevision,
  });
  if (begun.kind === 'lane_blocked') {
    return {
      kind: 'failed',
      result: { kind: 'blocked', laneKey: begun.laneKey, reason: `lane 已被未决意图 ${begun.blockingIntent.operationId} 阻塞` },
    };
  }
  if (begun.kind === 'lane_busy') {
    return {
      kind: 'failed',
      result: { kind: 'blocked', laneKey: begun.laneKey, reason: `lane 上已有未决意图 ${begun.activeIntent.operationId}` },
    };
  }
  if (begun.kind === 'rejected') {
    return {
      kind: 'failed',
      result: { kind: 'blocked', laneKey: input.workPackageId, reason: begun.rejection.message },
    };
  }

  const outcome = await input.backend.mutate(
    mutation,
    executionScope(input, operationId, target, expectedRevision),
  );
  if (outcome.kind === 'unknown') {
    const reconciled = await reconcileOperation(input.backend, outcome.operation);
    const reconcileRevision = freshRevision();
    if (typeof reconcileRevision !== 'number') {
      return {
        kind: 'failed',
        result: { kind: 'blocked', laneKey: input.workPackageId, reason: reconcileRevision.message },
      };
    }
    const reason = reconciled.kind === 'settled'
      ? `${reconciled.statement}；缺少可恢复的资源结果`
      : `对账结果 ${reconciled.reason} 不构成副作用是否发生的证明`;
    const blocked = blockLane(input.store, {
      coordinationScopeId: input.coordinationScopeId,
      operationId,
      writer: input.context.candidate.writer,
      expectedRevision: reconcileRevision,
      reason,
    });
    if (blocked.kind === 'rejected') {
      return {
        kind: 'failed',
        result: { kind: 'blocked', laneKey: input.workPackageId, reason: blocked.rejection.message },
      };
    }
    return {
      kind: 'failed',
      result: { kind: 'unknown', operationId, reason: `${reason}，lane 保持阻塞` },
    };
  }

  if (outcome.kind === 'accepted') {
    const definite = definiteFailureCode(outcome);
    if (definite === null) {
      const interpreted = interpret(outcome);
      if ('code' in interpreted) {
        const blockedRevision = freshRevision();
        if (typeof blockedRevision === 'number') {
          blockLane(input.store, {
            coordinationScopeId: input.coordinationScopeId,
            operationId,
            writer: input.context.candidate.writer,
            expectedRevision: blockedRevision,
            reason: interpreted.message,
          });
        }
        return { kind: 'failed', result: { kind: 'unknown', operationId, reason: interpreted.message } };
      }
      const preSettlementFailure = await beforeSettle?.(interpreted);
      if (preSettlementFailure != null) {
        const blockedRevision = freshRevision();
        if (typeof blockedRevision === 'number') {
          blockLane(input.store, {
            coordinationScopeId: input.coordinationScopeId,
            operationId,
            writer: input.context.candidate.writer,
            expectedRevision: blockedRevision,
            reason: preSettlementFailure.message,
          });
        }
        return {
          kind: 'failed',
          result: { kind: 'unknown', operationId, reason: preSettlementFailure.message },
        };
      }
    }
  }

  const settleRevision = freshRevision();
  if (typeof settleRevision !== 'number') {
    return {
      kind: 'failed',
      result: { kind: 'blocked', laneKey: input.workPackageId, reason: settleRevision.message },
    };
  }
  const settled = settleIntent(input.store, {
    coordinationScopeId: input.coordinationScopeId,
    operationId,
    writer: input.context.candidate.writer,
    expectedRevision: settleRevision,
    outcome,
  });
  if (settled.kind === 'rejected') {
    return {
      kind: 'failed',
      result: { kind: 'blocked', laneKey: input.workPackageId, reason: settled.rejection.message },
    };
  }
  if (outcome.kind === 'rejected') {
    return {
      kind: 'failed',
      result: { kind: 'rejected', failure: { code: outcome.code, message: outcome.message } },
    };
  }
  const definite = definiteFailureCode(outcome);
  if (definite !== null) {
    return {
      kind: 'failed',
      result: { kind: 'rejected', failure: { code: definite, message: `Orca 记录了确定失败: ${definite}` } },
    };
  }

  return interpret(outcome) as T;
}
