/**
 * IC-01：共同 identity、revision 与引用字段族（Owner: `m0-orca-control-baseline`）。
 *
 * 语义不同的 ID 类型不能互相赋值，也不能从 cwd、mtime、terminal 输出或文件名推断。
 * 本文件是这些字段的唯一 owner：后继 change 可以新增领域 ID 类型，但不能放宽这里的共同规则，
 * 也不能另建平行 ID 类型或第二套 revision 语义。
 */

declare const identityBrand: unique symbol;

export type StableId = string;
export type Revision = number;

/** 语义标记：相同底层类型但不同 `Tag` 之间不可赋值。 */
export type BrandedId<Tag extends string> = string & { readonly [identityBrand]: Tag };
export type BrandedRevision<Tag extends string> = number & { readonly [identityBrand]: Tag };

export type EntityRef<Kind extends string, Id extends string = string> = {
  readonly kind: Kind;
  readonly id: Id;
};

export type VersionedRef<Kind extends string, Id extends string = string> = EntityRef<Kind, Id> & {
  readonly version: Revision;
};

export type CoordinationScopeId = BrandedId<'CoordinationScopeId'>;
export type CoordinatorSessionId = BrandedId<'CoordinatorSessionId'>;
export type RuntimeIncarnationId = BrandedId<'RuntimeIncarnationId'>;
export type PlanningCycleId = BrandedId<'PlanningCycleId'>;
export type GraphId = BrandedId<'GraphId'>;
export type WorkPackageId = BrandedId<'WorkPackageId'>;
export type WorkerTaskId = BrandedId<'WorkerTaskId'>;
export type DispatchId = BrandedId<'DispatchId'>;
export type AttemptId = BrandedId<'AttemptId'>;
export type ValidationAttemptId = BrandedId<'ValidationAttemptId'>;
export type SessionSegmentId = BrandedId<'SessionSegmentId'>;
export type OperationId = BrandedId<'OperationId'>;
export type RecoveryId = BrandedId<'RecoveryId'>;
export type InteractionId = BrandedId<'InteractionId'>;
export type GraphVersion = BrandedRevision<'GraphVersion'>;
export type GraphGeneration = BrandedRevision<'GraphGeneration'>;

/** 结构化校验失败：只描述字段与原因，不复制外部系统的错误码词表。 */
export type IdentityFailure = {
  readonly ok: false;
  readonly field: string;
  readonly message: string;
};

export type IdentitySuccess<T> = {
  readonly ok: true;
  readonly value: T;
};

export type IdentityResult<T> = IdentitySuccess<T> | IdentityFailure;

function fail(field: string, message: string): IdentityFailure {
  return { ok: false, field, message };
}

export function isIdentityFailure<T>(result: IdentityResult<T>): result is IdentityFailure {
  return !result.ok;
}

/** 身份与句柄必须是非空字符串；空字符串一律拒绝进入领域层。 */
export function parseStableId(raw: unknown, field: string): IdentityResult<StableId> {
  if (typeof raw !== 'string' || raw.length === 0) {
    return fail(field, '必须是非空字符串');
  }
  return { ok: true, value: raw };
}

/** revision 必须是非负整数；不能用它与 entity version、GraphVersion 或 schema version 互换。 */
export function parseRevision(raw: unknown, field: string): IdentityResult<Revision> {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    return fail(field, '必须是非负整数');
  }
  return { ok: true, value: raw };
}

/** kind 是封闭字面量：未知取值在边界 fail closed，不推断、不降级。 */
export function parseEntityRef(
  raw: unknown,
  field: string,
  allowedKinds: readonly string[],
): IdentityResult<EntityRef<string>> {
  if (typeof raw !== 'object' || raw === null) {
    return fail(field, '必须是对象');
  }
  const candidate = raw as { readonly kind?: unknown; readonly id?: unknown };
  if (typeof candidate.kind !== 'string') {
    return fail(`${field}.kind`, '必须是字符串');
  }
  if (!allowedKinds.includes(candidate.kind)) {
    return fail(`${field}.kind`, `未知 kind: ${candidate.kind}`);
  }
  const id = parseStableId(candidate.id, `${field}.id`);
  if (isIdentityFailure(id)) {
    return id;
  }
  return { ok: true, value: { kind: candidate.kind, id: id.value } };
}
