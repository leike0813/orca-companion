import type { CoordinationScopeId, GraphId, OperationId, WorkerTaskId } from './dto/identity.js';
import type { BranchCoordinationStore, CoordinationWriter, FinalizerAdmissionRecord } from './ports/branch-coordination-store.js';
import type { ExecutionBackend, ExecutionScope, WorktreeListResult, WorktreeSummary } from './ports/execution-backend.js';
import { beginIntent, settleIntent, blockLane, resolveLane } from './coordination/intent-service.js';
import { readScope } from './planning/scope-read.js';
import type { ExecutionGraph } from '../domain/planning/execution-graph.js';
import { pathsOutsideScopeEnvelope } from '../domain/repair-scope.js';
import { createHash } from 'node:crypto';

export function finalizerPathsOutsideScope(graph: ExecutionGraph, paths: readonly string[]): readonly string[] {
  return paths.filter(path => !graph.workPackages.some(workPackage =>
    pathsOutsideScopeEnvelope(workPackage.scopeEnvelope, [path]).length === 0));
}

/** 准入及基线先落盘，worktree 创建结果未知时只沿原意图核验，不重发。 */
export async function prepareFinalizerWorktree(input: {
  readonly store: BranchCoordinationStore; readonly backend: ExecutionBackend; readonly writer: CoordinationWriter;
  readonly coordinationScopeId: CoordinationScopeId; readonly graphId: GraphId; readonly graphGeneration: number;
  readonly workerTaskId: WorkerTaskId; readonly authorizationId: string; readonly baselineHead: string;
  readonly canonicalWorktree: string; readonly operationId: OperationId;
  readonly executionScope: (revision: number) => ExecutionScope;
}): Promise<{ readonly kind: 'ready'; readonly admission: FinalizerAdmissionRecord; readonly worktree: WorktreeSummary } |
  { readonly kind: 'blocked'; readonly code: string; readonly message: string }> {
  const block = (code: string, message: string) => ({ kind: 'blocked' as const, code, message });
  const scope = readScope(input.store, input.coordinationScopeId);
  if (scope.kind !== 'read') return block(scope.code, scope.message);
  const prior = input.store.query({ kind: 'finalizer-admission', coordinationScopeId: input.coordinationScopeId, workerTaskId: input.workerTaskId });
  if (prior.kind !== 'finalizer-admission') return block('finalizer_admission_unreadable', '无法读取 Finalizer 原准入');
  let admission = prior.kind === 'finalizer-admission' ? prior.admission : null;
  if (admission === null) {
    const admitted = input.store.transact({ kind: 'admit-finalizer', coordinationScopeId: input.coordinationScopeId,
      expectedRevision: scope.scope.revision, writer: input.writer, workerTaskId: input.workerTaskId,
      graphId: input.graphId, graphGeneration: input.graphGeneration, authorizationId: input.authorizationId, baselineHead: input.baselineHead });
    if (admitted.kind === 'rejected') return block(admitted.code, admitted.message);
    const read = input.store.query({ kind: 'finalizer-admission', coordinationScopeId: input.coordinationScopeId, workerTaskId: input.workerTaskId });
    admission = read.kind === 'finalizer-admission' ? read.admission : null;
  }
  if (admission === null || admission.graphId !== input.graphId || admission.graphGeneration !== input.graphGeneration ||
      admission.authorizationId !== input.authorizationId) return block('finalizer_admission_mismatch', 'Finalizer 原准入依据不一致');
  const comment = `finalizerTaskId=${input.workerTaskId}`;
  const locate = async (): Promise<WorktreeSummary | null> => {
    const listed = await input.backend.query({ operation: 'worktree-list', repo: `path:${input.canonicalWorktree}`, limit: 1_000 });
    if (listed.kind !== 'accepted') return null;
    const result = listed.value as WorktreeListResult;
    if (result.truncated || result.hostScope === null || result.hostScope.omittedHostIds.length > 0) return null;
    const matches = result.worktrees.filter(row => row.comment === comment && !row.isMainWorktree && row.branch !== null && row.path !== input.canonicalWorktree);
    return matches.length === 1 ? matches[0]! : null;
  };
  const known = input.store.query({ kind: 'intent', coordinationScopeId: input.coordinationScopeId, operationId: input.operationId });
  const existing = await locate();
  if (known.kind !== 'intent') return block('intent_unreadable', '无法读取 Finalizer worktree 原意图');
  if (known.intent !== null) {
    if (existing === null) return block('finalizer_worktree_unverifiable', '原 worktree 无法精确核验，不重建');
    if (known.intent.target.kind !== 'finalizer-worktree' || known.intent.target.id !== input.workerTaskId ||
        known.intent.expectedHead !== admission.baselineHead) return block('finalizer_worktree_mismatch', '原 worktree 意图与准入不一致');
    if (known.intent.state !== 'settled') {
      if (existing.head !== admission.baselineHead) return block('finalizer_worktree_unknown', '原创建结果无法证明基线，不重发');
      const refreshed = readScope(input.store, input.coordinationScopeId);
      if (refreshed.kind !== 'read') return block(refreshed.code, refreshed.message);
      const finished = known.intent.state === 'blocked'
        ? resolveLane(input.store, { coordinationScopeId: input.coordinationScopeId, operationId: input.operationId,
            writer: input.writer, expectedRevision: refreshed.scope.revision, outcomeClass: 'accepted' })
        : settleIntent(input.store, { coordinationScopeId: input.coordinationScopeId, operationId: input.operationId,
            writer: input.writer, expectedRevision: refreshed.scope.revision,
            outcome: { kind: 'accepted', operation: { operationId: input.operationId, target: known.intent.target }, value: { worktreeId: existing.worktreeId } } });
      return finished.kind === 'settled' ? { kind: 'ready', admission, worktree: existing }
        : block('finalizer_worktree_unsettled', '原 worktree 创建无法收尾');
    }
    return known.intent.outcomeClass === 'accepted' ? { kind: 'ready', admission, worktree: existing }
      : block('finalizer_worktree_rejected', '原 worktree 操作已拒绝');
  }
  if (existing !== null) return block('finalizer_worktree_unattributed', '发现没有原创建意图的 Finalizer worktree');
  const revision = readScope(input.store, input.coordinationScopeId);
  if (revision.kind !== 'read') return block(revision.code, revision.message);
  const target = { kind: 'finalizer-worktree', id: input.workerTaskId };
  const begun = beginIntent(input.store, { coordinationScopeId: input.coordinationScopeId, operationId: input.operationId,
    target, operationCategory: 'finalizer-worktree-create', expectedHead: admission.baselineHead,
    writer: input.writer, expectedRevision: revision.scope.revision });
  if (begun.kind !== 'registered') return block('finalizer_worktree_blocked', 'Finalizer worktree 意图未获准');
  const outcome = await input.backend.mutate({ operation: 'worktree-create', repo: `path:${input.canonicalWorktree}`,
    name: `finalizer-${createHash('sha256').update(input.workerTaskId).digest('hex')}`, comment, baseBranch: admission.baselineHead }, input.executionScope(begun.revision));
  const worktree = outcome.kind === 'accepted' ? await locate() : null;
  const receiptId = outcome.kind === 'accepted' && typeof outcome.value === 'object' && outcome.value !== null
    ? (outcome.value as { worktreeId?: unknown }).worktreeId : null;
  const after = readScope(input.store, input.coordinationScopeId);
  if (after.kind !== 'read') return block(after.code, after.message);
  if (outcome.kind === 'unknown' || (outcome.kind === 'accepted' && (worktree === null || worktree.head !== admission.baselineHead || receiptId !== worktree.worktreeId))) {
    blockLane(input.store, { coordinationScopeId: input.coordinationScopeId, operationId: input.operationId,
      writer: input.writer, expectedRevision: after.scope.revision, reason: 'worktree 创建结果或基线不可证明' });
    return block('finalizer_worktree_unknown', '原 worktree 操作不可证明，不重发');
  }
  const settled = settleIntent(input.store, { coordinationScopeId: input.coordinationScopeId, operationId: input.operationId,
    writer: input.writer, expectedRevision: after.scope.revision, outcome });
  if (settled.kind !== 'settled') return block('finalizer_worktree_unsettled', 'worktree 创建未完成持久结算');
  return worktree !== null ? { kind: 'ready', admission, worktree } : block('finalizer_worktree_rejected', 'worktree 创建被拒绝');
}
