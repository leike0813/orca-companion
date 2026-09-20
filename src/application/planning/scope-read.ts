/**
 * IC-05：Coordination Scope 的只读取回（Owner: `m1-plan-and-authorize-execution`）。
 *
 * 规划用例几乎每个入口都要先回答同一个问题：「这个 Scope 还在吗，它当前的事实是什么」。散落的
 * 内联查询会让「Scope 不存在」在不同用例里退化成不同的错误；这里把它固定成一个 seam，失败一律
 * 是结构化拒绝，绝不返回一个看起来正常的空值。
 *
 * 它只读：租约、fencing 与 CAS 都由 store 在写入路径上判断，这里不复制那些规则。
 */

import type { CoordinationScopeId } from '../dto/identity.js';
import type { BranchCoordinationStore, ScopeRecord } from '../ports/branch-coordination-store.js';

export type ScopeReadResult =
  | { readonly kind: 'read'; readonly scope: ScopeRecord }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

export function readScope(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
): ScopeReadResult {
  const result = store.query({ kind: 'scope', coordinationScopeId });
  if (result.kind === 'rejected') {
    return { kind: 'rejected', code: result.code, message: result.message };
  }
  if (result.kind !== 'scope' || result.scope === null) {
    return { kind: 'rejected', code: 'invalid_state', message: `Scope ${coordinationScopeId} 不存在` };
  }
  return { kind: 'read', scope: result.scope };
}
