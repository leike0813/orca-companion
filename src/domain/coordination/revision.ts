/**
 * MOD-01：共享状态的 expected revision 语义（IC-01、IC-03）。
 *
 * `scope.revision` 由 store 在成功写入的同一事务内推进；调用方只提供自己读到的 expected 值，
 * 不能提交新值，否则等于允许伪造顺序。缺失的 scope 等价于 revision 0，因此首次创建本身也是
 * 一次 CAS 写入，revision 从 0 推进到 1。
 */

/** 不存在的 Scope 所对应的 revision：让「创建」也走同一条 CAS 通道。 */
export const ABSENT_SCOPE_REVISION = 0;

/** 调用方最近读回的 `scope.revision`。 */
export type ExpectedRevision = number;

export type RevisionCheck =
  | { readonly kind: 'matched' }
  | { readonly kind: 'stale'; readonly expected: ExpectedRevision; readonly current: ExpectedRevision };

export function checkExpectedRevision(expected: ExpectedRevision, current: ExpectedRevision): RevisionCheck {
  if (expected !== current) {
    return { kind: 'stale', expected, current };
  }
  return { kind: 'matched' };
}

/** 唯一合法的推进方式：成功写入在同一事务内 +1。心跳类写入不调用它。 */
export function advanceRevision(current: ExpectedRevision): ExpectedRevision {
  return current + 1;
}
