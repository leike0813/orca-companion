/**
 * IP-1 / IP-4：恢复期 lane 写入的公共 CAS 助手（Owner: `m1-recover-execution`）。
 *
 * 对账与 Delivery 重放都会在同一个 Scope 上连续写入若干 intent（阻塞或收尾）。它们共享两条规则，
 * 因此收敛在这里而不是各自复制：
 *
 * 1. 写入沿用调用方读到的 `expectedRevision` 做 CAS，遇到 `stale_revision` 时**重新读取** Scope revision
 *    再试一次即可；重试只换 revision，绝不更换 OperationId，也不跳过该 intent；
 * 2. 意图的只读回读按 OperationId 精确定位，不按目标或 lane 猜测。
 *
 * 本模块不决定「该不该写」——那是 `reconcile-operations.ts` 与 `replay-deliveries.ts` 的语义。
 */

import type { CoordinationScopeId, OperationId, Revision } from '../dto/identity.js';
import type { OperationIntent } from '../dto/operation-intent.js';
import type {
  BranchCoordinationStore,
  CoordinationCommandRejection,
} from '../ports/branch-coordination-store.js';
import { readScope } from '../planning/scope-read.js';

/** 可用 `writeWithRevisionRetry` 包装的写入结果形状；与既有 lane 服务的结果结构相容。 */
export type LaneWriteOutcome =
  | { readonly kind: 'settled'; readonly revision: number }
  | { readonly kind: 'retained'; readonly revision: number }
  | { readonly kind: 'rejected'; readonly rejection: CoordinationCommandRejection };

export type LaneWriteAttempt = {
  readonly outcome: LaneWriteOutcome;
  /** 写入成功后的 Scope revision；被拒绝时保持基准值。 */
  readonly revision: Revision;
};

export function currentScopeRevision(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
): Revision | null {
  const read = readScope(store, coordinationScopeId);
  return read.kind === 'rejected' ? null : read.scope.revision;
}

export function readIntentRecord(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
  operationId: OperationId,
): OperationIntent | null {
  const result = store.query({ kind: 'intent', coordinationScopeId, operationId });
  return result.kind === 'intent' ? result.intent : null;
}

/**
 * 以 `baseRevision` 为基准执行一次 lane 写入；仅在 `stale_revision` 时重读 revision 并重试一次。
 *
 * 重试使用同一个闭包，因此 OperationId、目标与结论都不会改变——这正是「不得换 ID 重试」的落点。
 */
export function writeWithRevisionRetry(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
  baseRevision: Revision,
  call: (expectedRevision: Revision) => LaneWriteOutcome,
): LaneWriteAttempt {
  let outcome = call(baseRevision);
  if (outcome.kind === 'rejected' && outcome.rejection.code === 'stale_revision') {
    const fresh = currentScopeRevision(store, coordinationScopeId);
    if (fresh !== null && fresh !== baseRevision) {
      outcome = call(fresh);
    }
  }
  return {
    outcome,
    revision: outcome.kind === 'rejected' ? baseRevision : outcome.revision,
  };
}
