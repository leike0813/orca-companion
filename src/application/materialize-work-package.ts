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

import { createHash } from 'node:crypto';

import type { CoordinationScopeId, OperationId, WorkPackageId } from './dto/identity.js';
import type {
  ExecutionQueryResult,
  OperationOutcome,
} from './dto/operation-outcome.js';
import type {
  BranchCoordinationStore,
  CoordinationCommandResult,
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
import {
  orcaDispatchIdFromReceipt,
  orcaTaskIdFromReceipt,
  orcaTerminalHandleFromReceipt,
  reconcileOperation,
} from './ports/execution-backend.js';
import { beginIntent, blockLane, resolveLane, settleIntent } from './coordination/intent-service.js';
import { readScope } from './planning/scope-read.js';
import { parseTaskEnvelope } from './worker-report-dto.js';
import {
  activatePreparedWorker,
  knownTerminalHandleFor,
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
  return `wp-${createHash('sha256').update(workPackageId).digest('hex')}`;
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
  readonly authorizationVersion: number;
  readonly workerProfileRef: string;
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
  /**
   * 本次派发的 Worker launch 身份（与 `workerLaunch` 用同一个值构造）。
   *
   * 物化绑定把它记成事实，使「派发窗口内没读到 SessionStart 报告」的派发能在后续触发里按同一身份
   * 补记 Session Binding——否则重建它就得复刻派生编码。
   */
  readonly launchId: string;
  readonly timeoutMs: number;
};

export type MaterializeWorktreePaths = {
  /** 仓库选择器，例如 `path:<canonical-worktree>`。 */
  readonly repoSelector: string;
  /** canonical worktree 的绝对路径；只用于核验，不落盘。 */
  readonly canonicalWorktree: string;
  /**
   * 包准入时固定的 exact HEAD；新包取已归属当前 canonical，已有包的后续角色沿用原占位基线。
   */
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
  const legacy = result.bindings.find((entry) => entry.identity === 'legacy');
  if (legacy !== undefined) {
    return {
      kind: 'failed',
      failure: { code: 'legacy_materialization_unverifiable', message: '旧物化绑定缺少角色和 Attempt 身份，不能据此复用或创建角色 Task' },
    };
  }
  const matches = result.bindings.filter((entry) =>
    entry.role === input.context.candidate.role &&
    entry.workerTaskId === input.context.candidate.taskEnvelope.workerTaskId &&
    entry.dispatchId === input.context.candidate.taskEnvelope.dispatchId &&
    entry.attemptId === input.context.candidate.taskEnvelope.attemptId,
  );
  if (matches.length > 1) {
    return { kind: 'failed', failure: { code: 'invalid_state', message: '同一角色 Attempt 存在多个物化绑定' } };
  }
  const binding = matches[0];
  if (binding !== undefined && (binding.authorizationId !== input.context.candidate.authorizationId ||
    binding.authorizationVersion !== input.context.candidate.authorizationVersion ||
    binding.workerProfileRef?.id !== input.context.candidate.workerProfileRef)) {
    return { kind: 'failed', failure: { code: 'model_binding_mismatch', message: '物化任务的原模型授权绑定无法核验' } };
  }
  return { kind: 'read', binding: matches[0] ?? null };
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
  // 准入先于任何外部 mutation；pending start 尚不可见时也持有同一包额度。
  if (current.scope.graphId === null) {
    return { kind: 'rejected', failure: { code: 'invalid_state', message: '当前 Scope 没有 Execution Graph' } };
  }
  const lanes = input.store.query({ kind: 'work-package-lanes', coordinationScopeId: input.coordinationScopeId });
  if (lanes.kind !== 'work-package-lanes') {
    return { kind: 'rejected', failure: { code: 'invalid_state', message: '包准入状态不可读' } };
  }
  const occupied = lanes.reservations.find(lane => lane.graphId === current.scope.graphId &&
    lane.generation === candidate.graphGeneration && lane.workPackageId === input.workPackageId);
  if (occupied === undefined) {
    const refreshed = readScope(input.store, input.coordinationScopeId);
    if (refreshed.kind === 'rejected') return { kind: 'rejected', failure: { code: refreshed.code, message: refreshed.message } };
    const graphRead = current.scope.graphVersion === null ? null : input.store.query({
      kind: 'graph-version', coordinationScopeId: input.coordinationScopeId,
      graphId: current.scope.graphId, graphVersion: current.scope.graphVersion,
    });
    if (graphRead?.kind !== 'graph-version' || graphRead.version === null ||
      graphRead.version.generation !== candidate.graphGeneration) {
      return { kind: 'rejected', failure: { code: 'invalid_state', message: '派发代际与当前图不一致' } };
    }
    const admitted = input.store.transact({
      kind: 'reserve-work-package-lane', coordinationScopeId: input.coordinationScopeId,
      expectedRevision: refreshed.scope.revision, writer: candidate.writer,
      graphId: current.scope.graphId, generation: graphRead.version.generation,
      workPackageId: input.workPackageId,
      operationId: `work-package-lane:${[input.coordinationScopeId, current.scope.graphId,
        String(candidate.graphGeneration), input.workPackageId].map(encodeURIComponent).join(':')}` as OperationId,
      authorizationId: candidate.authorizationId, authorizationVersion: candidate.authorizationVersion,
      baselineHead: paths.baselineHead,
    });
    if (admitted.kind === 'rejected') {
      return { kind: 'rejected', failure: { code: admitted.code, message: admitted.message } };
    }
  } else if (occupied.baselineHead !== paths.baselineHead) {
    return { kind: 'rejected', failure: { code: 'baseline_mismatch', message: '派发必须沿用包准入时的基线' } };
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
        // 传准入时固定的 exact commit；已有包后续角色沿用同一基线。
        baseBranch: paths.baselineHead,
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

  /**
   * 基线补救门禁：核验通过之前**不派发角色 Task**。
   *
   * 它放在 worktree 步骤之后是有意的：落后基线的 Work Package 需要一个已经存在的隔离 worktree 才能被
   * 对齐（`verifyBaselineWorker` 要求 worktree 唯一可定位且 HEAD 精确等于目标基线）。因此这里允许先把
   * worktree 建出来（或复用），只把角色 Task 与 Worker 挡住——否则「先补救再派发」在结构上无法成立。
   */
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
      (value) => recordMaterializationBinding(input, value.taskId, operationIds.task, finalEnvelope.envelope, worktree.worktreeId),
    );
    if (task.kind !== 'task-created') {
      return task.result;
    }
    orcaTaskId = task.taskId;
  }

  // 复用共享 helper：查询不可读、pending/blocked、或 accepted 但缺句柄都 fail closed 为 evidence_missing。
  const knownTerminal = knownTerminalHandleFor(input.store, input.coordinationScopeId, operationIds.workerPrepare);
  if (knownTerminal.kind === 'evidence_missing') {
    return {
      kind: 'blocked',
      laneKey: input.workPackageId,
      reason: '原 terminal-create 操作已接受但缺少可核验句柄：不以 title 猜回，拒绝重复创建',
    };
  }
  const launch = await prepareWorkerLaunch({
    backend: input.backend,
    strategy: candidate.workerLaunch,
    worktreeId: worktree.worktreeId,
    worktreePath: worktree.path,
    timeoutMs: candidate.timeoutMs,
    // 重放时用原 worker-prepare 意图记录的真实 terminal 句柄重定位；有句柄即绕过 title/create。
    ...(knownTerminal.kind === 'known' ? { knownTerminalHandle: knownTerminal.handle } : {}),
    createTerminal: async (mutation) => {
      const prepared = await runMutation<{ readonly kind: 'terminal-created'; readonly terminalHandle: string }>(
        input,
        operationIds.workerPrepare,
        'worker-terminal',
        mutation,
        (value) => {
          const terminalHandle = orcaTerminalHandleFromReceipt(value.value);
          return terminalHandle === null
            ? { code: 'invalid_receipt', message: 'terminal-create 回执缺少可核验的 terminal handle' }
            : { kind: 'terminal-created' as const, terminalHandle };
        },
      );
      return prepared.kind === 'terminal-created'
        ? { kind: 'accepted' as const, terminalHandle: prepared.terminalHandle }
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
    // 结果未知时的按事实对账：Orca 列举里已经出现这个 Task 的 Worker，就说明 worker-start 发生过。
    async () => {
      const listed = await input.backend.query({
        operation: 'worker-list',
        runId: input.context.candidate.runId,
      });
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
      let dispatchId: string | null = null;
      for (const worker of workers) {
        if (typeof worker !== 'object' || worker === null) {
          continue;
        }
        const record = worker as Record<string, unknown>;
        if (record['taskId'] !== orcaTaskId) {
          continue;
        }
        const candidate = record['dispatchId'];
        dispatchId = typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
        break;
      }
      if (typeof dispatchId !== 'string' || dispatchId.length === 0) {
        return { kind: 'unobserved' };
      }
      return { kind: 'observed', value: { dispatchId } };
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
        undefined,
        () => {
          const read = input.store.query({
            kind: 'intent', coordinationScopeId: input.coordinationScopeId,
            operationId: operationIds.workerActivate,
          });
          return Promise.resolve(read.kind === 'intent' && read.intent?.state === 'settled' &&
            read.intent.outcomeClass === 'accepted'
            ? { kind: 'observed' as const, value: {} }
            : { kind: 'unobserved' as const });
        },
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
  envelope: TaskEnvelope,
  worktreeId: string,
): MaterializationFailure | null {
  const current = readScope(input.store, input.coordinationScopeId);
  if (current.kind === 'rejected') {
    return { code: current.code, message: current.message };
  }
  // 绑定写入同样受心跳推进 revision 的影响：并发冲突时重读 revision 再写，绝不丢已经发生的 Task。
  const recorded = writeBinding(input, {
    orcaTaskId,
    creationOperationId,
    envelope,
    worktreeId,
  });
  return recorded.kind === 'rejected'
    ? { code: recorded.code, message: recorded.message }
    : null;
}

/** 绑定写入本体；`casWrite` 负责在 stale revision 上重读重试。 */
function writeBinding(
  input: MaterializeWorkPackageInput,
  payload: {
    readonly orcaTaskId: string;
    readonly creationOperationId: OperationId;
    readonly envelope: TaskEnvelope;
    readonly worktreeId: string;
  },
): CoordinationCommandResult {
  return casWrite<CoordinationCommandResult>(
    () => {
      const read = readScope(input.store, input.coordinationScopeId);
      return read.kind === 'rejected' ? { code: read.code, message: read.message } : read.scope.revision;
    },
    intentWriteStale,
    (revision) =>
      input.store.transact({
        kind: 'record-materialization-binding',
        coordinationScopeId: input.coordinationScopeId,
        expectedRevision: revision,
        writer: input.context.candidate.writer,
        workPackageId: input.workPackageId,
        orcaTaskId: payload.orcaTaskId,
        creationOperationId: payload.creationOperationId,
        role: payload.envelope.role,
        workerTaskId: payload.envelope.workerTaskId,
        dispatchId: payload.envelope.dispatchId,
        attemptId: payload.envelope.attemptId,
        worktreeId: payload.worktreeId,
        specBinding: payload.envelope.specBinding,
        specificationUnitPath: payload.envelope.specificationUnitPath ?? null,
        launchId: input.context.candidate.launchId,
        authorizationId: input.context.candidate.authorizationId,
        authorizationVersion: input.context.candidate.authorizationVersion,
        workerProfileRef: input.context.candidate.workerProfileRef,
      }),
  ) as CoordinationCommandResult;
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
  const taskId = orcaTaskIdFromReceipt(outcome.value);
  if (taskId === null || taskId.length === 0) {
    return { code: 'unknown', message: 'task-create 回执缺少可核验的 task id' };
  }
  return { kind: 'task-created', taskId };
}

function interpretWorkerStart(
  outcome: Extract<OperationOutcome<unknown>, { kind: 'accepted' }>,
): { readonly kind: 'worker-started'; readonly dispatchId: string | null } | MaterializationFailure {
  return { kind: 'worker-started', dispatchId: orcaDispatchIdFromReceipt(outcome.value) };
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
 * 受 CAS 保护的写入：`stale_revision` 时重读 revision 再写（有界重试）。
 *
 * 身份由 OperationId 表达，`expectedRevision` 只是写入护栏；Runtime Lease 心跳每 10s 续租一次并推进
 * Scope revision，因此「读 revision → 写」之间被内部心跳命中是正常并发，而不是「事实已变」。按计划
 * §5「CAS 冲突重读事实重新决策」在本地重读重写：重试只重发**本地** intent 写入，绝不重发任何外部
 * 副作用。仍冲突时返回最后一次结果，由调用方按既有路径阻塞。
 */
function casWrite<T extends { readonly kind: string }>(
  readRevision: () => number | MaterializationFailure,
  isStale: (value: T) => boolean,
  write: (expectedRevision: number) => T,
  attempts = 5,
): T | MaterializationFailure {
  let last: T | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const revision = readRevision();
    if (typeof revision !== 'number') {
      return revision;
    }
    const result = write(revision);
    if (!isStale(result)) {
      return result;
    }
    last = result;
  }
  return last as T;
}

/** intent 写入是否因并发写入（stale revision）被拒：这是可重试的本地冲突，不是业务结论。 */
function intentWriteStale(result: { readonly kind: string }): boolean {
  return (
    result.kind === 'rejected' &&
    'rejection' in result &&
    (result as { readonly rejection: { readonly code: string } }).rejection.code === 'stale_revision'
  );
}

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
  /**
   * 结果未知时的**事实对账**：用 Orca 的列举事实判断这次 mutation 是否已经发生。
   *
   * `request-show` 只能证明「请求被记录过」，拿不回资源身份；`worker-start` 这类 mutation 一旦没有
   * backend request id，光靠它就会把 lane 永久阻塞。这里让调用方给出「按事实找资源」的读取，读到就按
   * `accepted` 收尾（附带资源身份），读不到再走原来的阻塞路径。
   */
  reconcileFacts?: () => Promise<{ readonly kind: 'observed'; readonly value: unknown } | { readonly kind: 'unobserved' }>,
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
  const begun = casWrite(
    freshRevision,
    intentWriteStale,
    (revision) =>
      beginIntent(input.store, {
        coordinationScopeId: input.coordinationScopeId,
        operationId,
        target,
        operationCategory: `materialize-${purpose}`,
        writer: input.context.candidate.writer,
        expectedRevision: revision,
      }),
  );
  if ('code' in begun) {
    return {
      kind: 'failed',
      result: { kind: 'blocked', laneKey: input.workPackageId, reason: begun.message },
    };
  }
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

  /**
   * 重放已存在的意图：绝不重发外部 mutation，也绝不重复 settle。
   *
   * - settled accepted：只按事实读回（reconcileFacts），读不到即证明不了原副作用；
   * - settled rejected：原样回带该结论；
   * - pending / blocked：只按同一 OperationId 对账，证明成立才收尾，否则保持阻塞。
   */
  if (begun.kind === 'existing') {
    if (begun.intent.state === 'settled' && begun.intent.outcomeClass === 'rejected') {
      return {
        kind: 'failed',
        result: {
          kind: 'rejected',
          failure: { code: 'intent_settled_rejected', message: '意图 ' + operationId + ' 已结算为 rejected' },
        },
      };
    }
    const facts: { readonly kind: 'observed'; readonly value: unknown } | { readonly kind: 'unobserved' } =
      reconcileFacts === undefined ? { kind: 'unobserved' } : await reconcileFacts();
    if (facts.kind === 'unobserved') {
      return {
        kind: 'failed',
        result: {
          kind: 'blocked',
          laneKey: input.workPackageId,
          reason: '意图 ' + operationId + ' 已存在但缺少可核验的读回事实',
        },
      };
    }
    const acceptedOperation: Extract<OperationOutcome<unknown>, { kind: 'accepted' }> = {
      kind: 'accepted',
      operation: { operationId, target },
      value: facts.value,
    };
    const interpreted = interpret(acceptedOperation);
    if ('code' in interpreted) {
      return { kind: 'failed', result: { kind: 'blocked', laneKey: input.workPackageId, reason: interpreted.message } };
    }
    // 与 accepted 正常路径一致：收尾前重跑 beforeSettle（例如 prepare 的 exact worker 接管核验）。
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
      return { kind: 'failed', result: { kind: 'unknown', operationId, reason: preSettlementFailure.message } };
    }
    if (begun.intent.state !== 'settled') {
      const settleRevision = freshRevision();
      if (typeof settleRevision === 'number') {
        const closed =
          begun.intent.state === 'blocked'
            ? resolveLane(input.store, {
                coordinationScopeId: input.coordinationScopeId,
                operationId,
                writer: input.context.candidate.writer,
                expectedRevision: settleRevision,
                outcomeClass: 'accepted',
              })
            : settleIntent(input.store, {
                coordinationScopeId: input.coordinationScopeId,
                operationId,
                writer: input.context.candidate.writer,
                expectedRevision: settleRevision,
                outcome: acceptedOperation,
              });
        if (closed.kind === 'rejected') {
          return {
            kind: 'failed',
            result: { kind: 'blocked', laneKey: input.workPackageId, reason: closed.rejection.message },
          };
        }
      }
    }
    return interpreted;
  }

  const outcome = await input.backend.mutate(
    mutation,
    executionScope(input, operationId, target, expectedRevision),
  );
  if (outcome.kind === 'unknown') {
    const reconciled = await reconcileOperation(input.backend, outcome.operation);
    const facts: { readonly kind: 'observed'; readonly value: unknown } | { readonly kind: 'unobserved' } =
      reconcileFacts === undefined ? { kind: 'unobserved' } : await reconcileFacts();
    if (facts.kind === 'observed') {
      const interpreted = interpret({ kind: 'accepted', operation: outcome.operation, value: facts.value });
      const factsRevision = freshRevision();
      if (!('code' in interpreted) && typeof factsRevision === 'number') {
        const factsOutcome: OperationOutcome<unknown> = {
          kind: 'accepted',
          operation: outcome.operation,
          value: facts.value,
        };
        const settledByFacts = settleIntent(input.store, {
          coordinationScopeId: input.coordinationScopeId,
          operationId,
          writer: input.context.candidate.writer,
          expectedRevision: factsRevision,
          outcome: factsOutcome,
        });
        if (settledByFacts.kind === 'settled') {
          // 事实已证明这次 mutation 发生过：按同一条成功路径收尾，不再把 lane 阻塞在原地。
          return interpreted;
        }
      }
    }
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
    const blocked = casWrite(
      freshRevision,
      intentWriteStale,
      (revision) =>
        blockLane(input.store, {
          coordinationScopeId: input.coordinationScopeId,
          operationId,
          writer: input.context.candidate.writer,
          expectedRevision: revision,
          reason,
        }),
    );
    if ('code' in blocked) {
      return {
        kind: 'failed',
        result: { kind: 'blocked', laneKey: input.workPackageId, reason: blocked.message },
      };
    }
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
        casWrite(
          freshRevision,
          intentWriteStale,
          (revision) =>
            blockLane(input.store, {
              coordinationScopeId: input.coordinationScopeId,
              operationId,
              writer: input.context.candidate.writer,
              expectedRevision: revision,
              reason: interpreted.message,
            }),
        );
        return { kind: 'failed', result: { kind: 'unknown', operationId, reason: interpreted.message } };
      }
      const preSettlementFailure = await beforeSettle?.(interpreted);
      if (preSettlementFailure != null) {
        casWrite(
          freshRevision,
          intentWriteStale,
          (revision) =>
            blockLane(input.store, {
              coordinationScopeId: input.coordinationScopeId,
              operationId,
              writer: input.context.candidate.writer,
              expectedRevision: revision,
              reason: preSettlementFailure.message,
            }),
        );
        return {
          kind: 'failed',
          result: { kind: 'unknown', operationId, reason: preSettlementFailure.message },
        };
      }
    }
  }

  const settled = casWrite(
    freshRevision,
    intentWriteStale,
    (revision) =>
      settleIntent(input.store, {
        coordinationScopeId: input.coordinationScopeId,
        operationId,
        writer: input.context.candidate.writer,
        expectedRevision: revision,
        outcome,
      }),
  );
  if ('code' in settled) {
    return {
      kind: 'failed',
      result: { kind: 'blocked', laneKey: input.workPackageId, reason: settled.message },
    };
  }
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
