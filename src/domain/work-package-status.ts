/**
 * IC-08 / D3：实现完成、验证通过与项目可交付三个独立事实
 * （Owner: `m1-execute-and-validate-work-packages`）。
 *
 * 这三个事实刻意用三个互不相同的判别联合表达，而不是一个 phase 枚举：单一枚举天然蕴含推导关系
 * （走到 `accepted` 就「显然」验证过了），而这正是规格禁止的。因此本模块只提供逐字段写入函数，
 * 每个函数把其余两个字段**原样保留**，不提供任何由一个推出另一个的转换。
 *
 * 纯粹的记录形状：不读时钟、不碰存储、不派发任何东西。
 *
 * 与 `dispatch-candidate.ts` 的 `WorkPackageLifecycleStage` 的关系：那个枚举表达「图上的物化位置」，
 * 用于派发前置判定；这里的三个字段表达「已经确立了哪些事实」。二者不能互相推导，也不能合并。
 */

import type { WorkPackageId } from '../application/dto/identity.js';

/** 实现事实：Implementation Worker 的当前状态。 */
export const IMPLEMENTATION_STATUS_KINDS = ['not_started', 'in_progress', 'implemented', 'failed'] as const;

export type ImplementationStatus =
  | { readonly kind: 'not_started' }
  | { readonly kind: 'in_progress'; readonly attemptId: string }
  | { readonly kind: 'implemented'; readonly attemptId: string; readonly acceptedResultRef: string }
  | { readonly kind: 'failed'; readonly attemptId: string; readonly reason: string };

/** 验证事实：独立 Validator 的当前状态。 */
export const VALIDATION_STATUS_KINDS = [
  'not_validated',
  'validating',
  'validated',
  'rejected',
  'blocked',
] as const;

export type ValidationStatus =
  | { readonly kind: 'not_validated' }
  | { readonly kind: 'validating'; readonly validationAttemptId: string; readonly sessionBindingId: string }
  | { readonly kind: 'validated'; readonly validationAttemptId: string; readonly acceptedResultRef: string }
  | { readonly kind: 'rejected'; readonly validationAttemptId: string; readonly reason: string }
  | { readonly kind: 'blocked'; readonly reason: string; readonly blockerRef: string };

/** 交付事实：项目级交付结论的当前状态；只有独立结论才能推进它。 */
export const DELIVERY_STATUS_KINDS = ['not_finalized', 'finalizing', 'deliverable', 'blocked'] as const;

export type DeliveryStatus =
  | { readonly kind: 'not_finalized' }
  | { readonly kind: 'finalizing'; readonly finalizerSessionBindingId: string }
  | { readonly kind: 'deliverable'; readonly verdictRef: string }
  | { readonly kind: 'blocked'; readonly verdictRef: string; readonly blockerRefs: readonly string[] };

export type WorkPackageStatus = {
  readonly workPackageId: WorkPackageId;
  readonly implementation: ImplementationStatus;
  readonly validation: ValidationStatus;
  readonly delivery: DeliveryStatus;
};

/** 初始状态：三个事实都未成立。 */
export function initialWorkPackageStatus(workPackageId: WorkPackageId): WorkPackageStatus {
  return {
    workPackageId,
    implementation: { kind: 'not_started' },
    validation: { kind: 'not_validated' },
    delivery: { kind: 'not_finalized' },
  };
}

/** 写入实现事实；验证与交付事实原样保留。 */
export function withImplementationStatus(
  status: WorkPackageStatus,
  implementation: ImplementationStatus,
): WorkPackageStatus {
  return { ...status, implementation };
}

/** 写入验证事实；实现与交付事实原样保留。 */
export function withValidationStatus(
  status: WorkPackageStatus,
  validation: ValidationStatus,
): WorkPackageStatus {
  return { ...status, validation };
}

/**
 * 写入交付事实。
 *
 * 交付状态只能由项目级结论推进：本函数不检查验证状态，因为「检查」会立刻变成一条推导规则；
 * 「能否收尾」的判定属于 `finalize-project` 的用例，而不是这个记录形状。
 */
export function withDeliveryStatus(status: WorkPackageStatus, delivery: DeliveryStatus): WorkPackageStatus {
  return { ...status, delivery };
}

/** 只有独立的项目级结论才能宣告可交付；全部任务通过验证本身不构成结论。 */
export function projectIsDeliverable(statuses: readonly WorkPackageStatus[]): boolean {
  return statuses.length > 0 && statuses.every((status) => status.delivery.kind === 'deliverable');
}
