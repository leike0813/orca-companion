/** IC-10 / D9：已有 Work Package worktree 的独立 Planner 基线补救 Task。 */

import type { DispatchId } from '../../application/dto/identity.js';
import type {
  BaselineReconciliationPlan,
  BaselineReconciliationProgress,
} from '../../application/execution/baseline-reconciliation.js';
import { baselineObservations, reconciliationIdFor, settleBaselineReconciliation } from '../../application/execution/baseline-reconciliation.js';
import { worktreeMatches } from '../../application/materialize-work-package.js';
import { loadCurrentGraph } from '../../application/planning/graph-history.js';
import type { WorktreeListResult } from '../../application/ports/execution-backend.js';
import type { WorktreeSummary } from '../../application/ports/execution-backend.js';
import { workPackageOf } from '../../domain/planning/execution-graph.js';
import { readBaselineGitObservations } from '../git/baseline-observer.js';
import { dispatchScopedWorker, type ScopedWorkerDispatchInput, type ScopedWorkerDispatchResult } from './utility-worker.js';

export type BaselineWorkerDispatchInput = Omit<
  ScopedWorkerDispatchInput,
  'workPackageId' | 'spec' | 'existingOrcaTaskId' | 'onTaskCreated' | 'onDispatchStarted'
> & {
  readonly plan: BaselineReconciliationPlan;
  readonly repoSelector: string;
  readonly canonicalWorktree: string;
};

export type BaselineWorkerDispatchResult =
  | ScopedWorkerDispatchResult
  | { readonly kind: 'already_dispatched'; readonly orcaTaskId: string; readonly dispatchId: DispatchId };

async function ownedWorktree(input: Pick<BaselineWorkerDispatchInput, 'backend' | 'repoSelector' | 'worktree' | 'canonicalWorktree' | 'plan'>): Promise<
  { readonly kind: 'found'; readonly worktree: WorktreeSummary }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string }
> {
  const listed = await input.backend.query({ operation: 'worktree-list', repo: input.repoSelector, limit: 1_000 });
  if (listed.kind !== 'accepted') return { kind: 'rejected', code: listed.code, message: listed.message };
  const value = listed.value;
  if (typeof value !== 'object' || value === null || !Array.isArray((value as { worktrees?: unknown }).worktrees)) {
    return { kind: 'rejected', code: 'invalid_worktree_list', message: 'worktree 列举结果无效' };
  }
  const worktrees = value as WorktreeListResult;
  if (worktrees.truncated !== false || worktrees.hostScope === null ||
      !Array.isArray(worktrees.hostScope?.omittedHostIds) || worktrees.hostScope.omittedHostIds.length > 0) {
    return { kind: 'rejected', code: 'worktree_scope_unverifiable', message: 'worktree 列举不完整' };
  }
  const worktree = worktrees.worktrees.find((entry) => entry.worktreeId === input.worktree);
  if (worktree === undefined || !worktreeMatches(worktree, input.plan.workPackageId, input.canonicalWorktree)) {
    return { kind: 'rejected', code: 'worktree_mismatch', message: '基线补救必须使用所属 Work Package 的隔离 worktree' };
  }
  return { kind: 'found', worktree };
}

function bind(input: BaselineWorkerDispatchInput, orcaTaskId: string, dispatchId?: DispatchId): { code: string; message: string } | null {
  const scope = input.store.query({ kind: 'scope', coordinationScopeId: input.coordinationScopeId });
  if (scope.kind !== 'scope' || scope.scope === null) return { code: 'scope_unavailable', message: '无法读取 Scope' };
  const bound = input.store.transact({
    kind: 'bind-baseline-reconciliation-task',
    coordinationScopeId: input.coordinationScopeId,
    expectedRevision: scope.scope.revision,
    writer: input.writer,
    reconciliationId: input.plan.reconciliationId,
    orcaTaskId,
    ...(dispatchId === undefined ? {} : { dispatchId }),
  });
  return bound.kind === 'rejected' ? { code: bound.code, message: bound.message } : null;
}

/**
 * 读取 required 记录与现有隔离 worktree 后派发；Task 和 Dispatch receipt 在各自 Intent 结算前绑定。
 * 已绑定的 Dispatch 由前驱恢复协议接管，不换 OperationId 重派。
 */
export async function dispatchBaselineWorker(input: BaselineWorkerDispatchInput): Promise<BaselineWorkerDispatchResult> {
  const { plan } = input;
  if (plan.reconciliationId !== reconciliationIdFor(plan.workPackageId, plan.requiredBaselineHead)) {
    return { kind: 'rejected', code: 'invalid_reconciliation_id', message: '基线补救身份与目标基线不匹配' };
  }
  const scope = input.store.query({ kind: 'scope', coordinationScopeId: input.coordinationScopeId });
  if (scope.kind !== 'scope' || scope.scope === null || scope.scope.mode !== 'execution_coordination' || scope.scope.controlState !== 'active' || scope.scope.authorizationId !== input.execution.authorizationId) {
    return { kind: 'rejected', code: 'invalid_scope', message: '当前 Scope 不允许派发基线补救' };
  }
  if ((input.workerLaunch.kind === 'orca_managed' && input.workerLaunch.agent !== 'codex') ||
      (input.workerLaunch.kind === 'prepared_terminal' && input.workerLaunch.harness !== 'codex')) {
    return { kind: 'rejected', code: 'harness_mismatch', message: '基线补救要求 Codex Planner Worker' };
  }
  const authorization = input.store.query({
    kind: 'authorization', coordinationScopeId: input.coordinationScopeId,
    authorizationId: input.execution.authorizationId,
  });
  if (authorization.kind !== 'authorization' || authorization.authorization === null ||
      !authorization.authorization.manifest.permissions.planner ||
      !authorization.authorization.manifest.workerProfiles.some((profile) => profile.role === 'planner' && profile.harness === 'codex')) {
    return { kind: 'rejected', code: 'planner_not_authorized', message: '当前授权未批准 Codex Planner' };
  }
  const graph = scope.scope.graphId === null ? null : loadCurrentGraph({ store: input.store, coordinationScopeId: input.coordinationScopeId, graphId: scope.scope.graphId });
  const workPackage = graph?.kind === 'loaded' ? workPackageOf(graph.version.graph, plan.workPackageId) : null;
  if (workPackage === null || graph?.kind !== 'loaded' || graph.version.generation !== input.execution.graphGeneration || graph.version.orcaRunId !== input.execution.runId) {
    return { kind: 'rejected', code: 'graph_mismatch', message: '基线补救必须属于当前 Graph Generation 与 Run' };
  }
  const reconciliations = input.store.query({ kind: 'baseline-reconciliations', coordinationScopeId: input.coordinationScopeId, workPackageId: plan.workPackageId });
  if (reconciliations.kind !== 'baseline-reconciliations') {
    return { kind: 'rejected', code: 'reconciliation_unavailable', message: '无法读取基线补救记录' };
  }
  const record = reconciliations.reconciliations.find((entry) => entry.reconciliationId === plan.reconciliationId);
  if (record?.state !== 'required' || record.requiredBaselineHead !== plan.requiredBaselineHead) {
    return { kind: 'rejected', code: 'reconciliation_not_required', message: '当前没有匹配的基线补救需求' };
  }
  if (record.orcaTaskId !== null && record.dispatchId !== null) {
    return { kind: 'already_dispatched', orcaTaskId: record.orcaTaskId, dispatchId: record.dispatchId };
  }
  const owned = await ownedWorktree(input);
  if (owned.kind === 'rejected') return owned;
  const { worktree } = owned;
  const spec = JSON.stringify({
    schemaVersion: 1,
    taskKind: 'baseline-reconciliation',
    role: 'planner',
    workerTaskId: plan.reconciliationId,
    workPackageId: plan.workPackageId,
    requiredBaselineHead: plan.requiredBaselineHead,
    observedBaseHead: plan.observedBaseHead,
    worktreeId: worktree.worktreeId,
    scopeEnvelope: workPackage.scopeEnvelope,
    instruction: '在此 worktree 内对齐目标基线；报告祖先关系、实际 HEAD、dirty paths 和 scope 证据。不要执行实现角色工作。完成后按 Orca Dispatch 指令提交 worker_done。',
  });
  return dispatchScopedWorker({
    ...input,
    workPackageId: plan.workPackageId,
    spec,
    ...(record.orcaTaskId === null ? {} : { existingOrcaTaskId: record.orcaTaskId }),
    onTaskCreated: (taskId) => bind(input, taskId),
    onDispatchStarted: (taskId, dispatchId) => bind(input, taskId, dispatchId as DispatchId),
    observeSession: async (dispatchId) => {
      const facts = await input.observeSession(dispatchId);
      return facts?.role === 'planner' && facts.workerTaskId === plan.reconciliationId && facts.dispatchId === dispatchId
        ? facts
        : null;
    },
  });
}

/** 正常 Delivery 已结算后，重新读取 Git 与当前图，四项检查通过才解除补救门禁。 */
export async function verifyBaselineWorker(input: BaselineWorkerDispatchInput): Promise<
  | { readonly kind: 'verified' }
  | { readonly kind: 'blocked'; readonly reason: string }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string }
> {
  const scope = input.store.query({ kind: 'scope', coordinationScopeId: input.coordinationScopeId });
  if (scope.kind !== 'scope' || scope.scope === null || scope.scope.graphId === null ||
      scope.scope.authorizationId !== input.execution.authorizationId || scope.scope.mode !== 'execution_coordination') {
    return { kind: 'rejected', code: 'scope_unavailable', message: '无法读取当前 Scope 与图' };
  }
  const reconciliations = input.store.query({ kind: 'baseline-reconciliations', coordinationScopeId: input.coordinationScopeId, workPackageId: input.plan.workPackageId });
  if (reconciliations.kind !== 'baseline-reconciliations') {
    return { kind: 'rejected', code: 'reconciliation_unavailable', message: '无法读取基线补救记录' };
  }
  const record = reconciliations.reconciliations.find((entry) => entry.reconciliationId === input.plan.reconciliationId);
  if (record?.state !== 'required' || record.orcaTaskId === null || record.dispatchId === null) {
    return { kind: 'rejected', code: 'task_not_bound', message: '基线补救 Task 或 Dispatch 尚未绑定' };
  }
  const settlements = input.store.query({ kind: 'delivery-settlements', coordinationScopeId: input.coordinationScopeId });
  if (settlements.kind !== 'delivery-settlements' || !settlements.settlements.some((result) =>
    result.workerTaskId === record.reconciliationId && result.dispatchId === record.dispatchId &&
    result.role === 'planner' && result.runId === input.execution.runId &&
    result.consumerGeneration === input.execution.consumerGeneration &&
    result.orcaResultRef.startsWith(`${record.orcaTaskId}#`)
  )) {
    return { kind: 'rejected', code: 'planner_result_missing', message: '独立 Planner Task 尚无 Accepted Worker Result' };
  }
  const graph = loadCurrentGraph({ store: input.store, coordinationScopeId: input.coordinationScopeId, graphId: scope.scope.graphId });
  const workPackage = graph.kind === 'loaded' ? workPackageOf(graph.version.graph, input.plan.workPackageId) : null;
  if (workPackage === null || graph.kind !== 'loaded' || graph.version.generation !== input.execution.graphGeneration || graph.version.orcaRunId !== input.execution.runId) {
    return { kind: 'rejected', code: 'work_package_unavailable', message: '无法从当前图读取 Work Package Scope' };
  }
  const owned = await ownedWorktree(input);
  if (owned.kind === 'rejected') return owned;
  const observed = await readBaselineGitObservations({
    worktreePath: owned.worktree.path,
    requiredBaselineHead: record.requiredBaselineHead,
  });
  if (observed.kind === 'rejected') return { kind: 'rejected', code: 'git_unverifiable', message: observed.reason };
  const outcome = settleBaselineReconciliation({
    store: input.store,
    coordinationScopeId: input.coordinationScopeId,
    writer: input.writer,
    reconciliationId: record.reconciliationId,
    observations: baselineObservations({
      envelope: workPackage.scopeEnvelope,
      requiredBaselineHead: record.requiredBaselineHead,
      git: observed.git,
    }),
  });
  return outcome.kind === 'rejected'
    ? { kind: 'rejected', code: outcome.failure.code, message: outcome.failure.message }
    : outcome;
}

/** required 记录的单一推进入口：未派发则派发，已派发则等待或核验，重放不创建第二个 Task。 */
export async function driveBaselineWorker(
  input: BaselineWorkerDispatchInput,
): Promise<BaselineReconciliationProgress> {
  const records = input.store.query({
    kind: 'baseline-reconciliations',
    coordinationScopeId: input.coordinationScopeId,
    workPackageId: input.plan.workPackageId,
  });
  if (records.kind !== 'baseline-reconciliations') {
    return { kind: 'blocked', reason: '无法读取基线补救记录' };
  }
  const record = records.reconciliations.find(
    (entry) => entry.reconciliationId === input.plan.reconciliationId,
  );
  if (record === undefined) {
    return { kind: 'blocked', reason: '基线补救记录不存在' };
  }
  if (record.state === 'verified') {
    return { kind: 'verified' };
  }
  if (record.state === 'blocked') {
    return { kind: 'blocked', reason: record.blockerRef ?? '基线补救已阻塞' };
  }
  if (record.orcaTaskId === null || record.dispatchId === null) {
    const dispatched = await dispatchBaselineWorker(input);
    return dispatched.kind === 'dispatched' || dispatched.kind === 'already_dispatched'
      ? { kind: 'dispatched' }
      : {
          kind: 'blocked',
          reason:
            dispatched.kind === 'rejected'
              ? dispatched.message
              : dispatched.kind === 'binding_unavailable'
                ? dispatched.message
                : dispatched.reason,
        };
  }
  const verified = await verifyBaselineWorker(input);
  if (verified.kind === 'verified' || verified.kind === 'blocked') {
    return verified;
  }
  return verified.code === 'planner_result_missing'
    ? { kind: 'waiting' }
    : { kind: 'blocked', reason: verified.message };
}
