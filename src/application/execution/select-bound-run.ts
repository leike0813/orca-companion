import type { CoordinationScopeId, OperationId } from '../dto/identity.js';
import type { BranchCoordinationStore, CoordinationWriter } from '../ports/branch-coordination-store.js';
import { buildExecutionScope, type ExecutionAuthority, type ExecutionBackend } from '../ports/execution-backend.js';
import { beginIntent, blockLane, resolveLane, settleIntent } from '../coordination/intent-service.js';
import { readScope } from '../planning/scope-read.js';

/** 恢复挂起代际时以原 OperationId 选择原 Run；只有实时读回证明后才恢复本地代际。 */
export async function selectBoundRun(input: {
  readonly store: BranchCoordinationStore;
  readonly backend: ExecutionBackend;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly writer: CoordinationWriter;
  readonly backendIdentityRef: string;
  readonly runId: string;
  readonly operationId: OperationId;
  readonly authority: ExecutionAuthority;
  readonly timeoutMs: number;
}): Promise<{ readonly kind: 'selected' } | { readonly kind: 'blocked'; readonly reason: string }> {
  const revision = () => {
    const scope = readScope(input.store, input.coordinationScopeId);
    return scope.kind === 'read' ? scope.scope.revision : null;
  };
  const selected = async () => {
    const read = await input.backend.query({ operation: 'run-current', backendIdentityRef: input.backendIdentityRef });
    if (read.kind !== 'accepted' || typeof read.value !== 'object' || read.value === null) return false;
    const run = (read.value as { run?: { runId?: unknown; consumerGeneration?: unknown } }).run;
    return run?.runId === input.runId && Number.isSafeInteger(run.consumerGeneration) && Number(run.consumerGeneration) > 0;
  };
  const existing = input.store.query({ kind: 'intent', coordinationScopeId: input.coordinationScopeId, operationId: input.operationId });
  if (existing.kind !== 'intent') return { kind: 'blocked', reason: 'Run 选择意图不可读' };
  if (existing.intent !== null && (existing.intent.target.kind !== 'orca-run' || existing.intent.target.id !== input.runId ||
    existing.intent.operationCategory !== 'replanning-run-use')) return { kind: 'blocked', reason: '原 OperationId 指向其它选择意图' };
  const proof = await selected();
  if (proof && existing.intent === null) return { kind: 'selected' };
  const before = revision();
  if (before === null) return { kind: 'blocked', reason: 'Scope 不可读' };
  const begun = beginIntent(input.store, { coordinationScopeId: input.coordinationScopeId,
    writer: input.writer, expectedRevision: before, operationId: input.operationId,
    operationCategory: 'replanning-run-use', target: { kind: 'orca-run', id: input.runId } });
  if (begun.kind !== 'registered' && begun.kind !== 'existing') return { kind: 'blocked', reason: 'Run 选择 lane 未准入' };
  if (begun.kind === 'existing' && !proof) return { kind: 'blocked', reason: '原 Run 选择结果未读回，不重复签发' };
  const outcome = begun.kind === 'existing' ? null : await input.backend.mutate(
    { operation: 'run-use', runId: input.runId }, buildExecutionScope({ ...input.writer,
      coordinationScopeId: input.coordinationScopeId, backendIdentityRef: input.backendIdentityRef,
      operationId: input.operationId, target: { kind: 'orca-run', id: input.runId },
      expectedRevision: before, timeoutMs: input.timeoutMs, authority: input.authority }));
  const after = revision();
  if (after === null) return { kind: 'blocked', reason: 'Run 选择后 Scope 不可读' };
  if (outcome !== null) {
    const failure = outcome.kind === 'accepted' && typeof outcome.value === 'object' && outcome.value !== null &&
      (outcome.value as { ok?: unknown }).ok === false;
    const persisted = settleIntent(input.store, { coordinationScopeId: input.coordinationScopeId, writer: input.writer,
      expectedRevision: after, operationId: input.operationId, outcome: failure
        ? { kind: 'rejected', code: 'run_use_failed', message: 'Orca 已记录原 Run 选择失败' } : outcome });
    if (persisted.kind === 'rejected') return { kind: 'blocked', reason: persisted.rejection.message };
    if (outcome.kind === 'rejected') return { kind: 'blocked', reason: outcome.message };
    if (failure) return { kind: 'blocked', reason: 'Orca 已记录原 Run 选择失败' };
  }
  const proven = proof || await selected();
  const state = input.store.query({ kind: 'intent', coordinationScopeId: input.coordinationScopeId, operationId: input.operationId });
  const currentRevision = revision();
  if (state.kind !== 'intent' || state.intent === null || currentRevision === null)
    return { kind: 'blocked', reason: 'Run 选择意图不能回读' };
  if (!proven) {
    if (state.intent.state !== 'settled') blockLane(input.store, { coordinationScopeId: input.coordinationScopeId,
      writer: input.writer, expectedRevision: currentRevision, operationId: input.operationId, reason: '原 Run 尚未实时读回' });
    return { kind: 'blocked', reason: '原 Run 尚未实时读回' };
  }
  if (state.intent.state !== 'settled') {
    const settled = state.intent.state === 'blocked'
      ? resolveLane(input.store, { coordinationScopeId: input.coordinationScopeId, writer: input.writer,
          expectedRevision: currentRevision, operationId: input.operationId, outcomeClass: 'accepted' })
      : settleIntent(input.store, { coordinationScopeId: input.coordinationScopeId, writer: input.writer,
          expectedRevision: currentRevision, operationId: input.operationId,
          outcome: { kind: 'accepted', operation: { operationId: input.operationId, target: { kind: 'orca-run', id: input.runId } }, value: null } });
    if (settled.kind === 'rejected') return { kind: 'blocked', reason: '原 Run 选择证明未落盘' };
  }
  return state.intent.outcomeClass === 'rejected' ? { kind: 'blocked', reason: '原选择操作已被拒绝' } : { kind: 'selected' };
}
