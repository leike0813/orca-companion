/**
 * MOD-01：Runtime Lease 与 Execution Coordination Lease 的纯判定（IC-03）。
 *
 * 租约是「谁有权写」的事实，不是生命周期状态机：这里只回答租约是否仍然有效、写入者是否被
 * fencing 拒绝、下一个 generation 是多少。过期与显式释放都不释放 Ticket Claim 或
 * Execution Coordination Lease，因此本模块没有「过期即降级」的函数。
 *
 * 所有时间参数都由调用方以 epoch 毫秒传入：领域层不读时钟（MOD-01 禁止时钟读取）。
 */

export const LEASE_KINDS = ['runtime', 'execution_coordination'] as const;

export type LeaseKind = (typeof LEASE_KINDS)[number];

export type LeaseRecord = {
  readonly kind: LeaseKind;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly runtimeIncarnationId: RuntimeIncarnationId;
  readonly fencingGeneration: number;
  readonly acquiredAt: number;
  /** `null` 表示不按时间过期，只能显式释放（Execution Coordination Lease）。 */
  readonly expiresAt: number | null;
  /** 显式释放时间；释放后行仍保留，fencing generation 才不会被重用。 */
  readonly releasedAt: number | null;
};

export type FenceViolationCode =
  | 'stale_generation'
  | 'other_incarnation'
  | 'released_lease'
  | 'expired_lease';

export type FenceViolation = {
  readonly kind: 'fenced';
  readonly code: FenceViolationCode;
  readonly presentedGeneration: number;
  readonly currentGeneration: number;
};

export type LeaseWriter = {
  readonly runtimeIncarnationId: RuntimeIncarnationId;
  readonly fencingGeneration: number;
};

export function isLeaseActive(lease: LeaseRecord, now: number): boolean {
  if (lease.releasedAt !== null) {
    return false;
  }
  return lease.expiresAt === null || lease.expiresAt > now;
}

/** 接管或重新取得时 generation 单调增加；首次取得为 1。 */
export function nextFencingGeneration(current: number | null): number {
  return current === null ? 1 : current + 1;
}

/**
 * 写入者 fencing 判定。
 *
 * 该 Session 还没有租约行时返回 `undefined`；是否允许 bootstrap 写入由 store 入口决定。
 * 一旦存在租约行，行本身就是权威——包括已被释放或已过期的行，因为它们的 generation
 * 已经作废。
 */
export function findFenceViolation(
  runtimeLease: LeaseRecord | undefined,
  writer: LeaseWriter,
  now: number,
): FenceViolation | undefined {
  if (runtimeLease === undefined) {
    return undefined;
  }
  const currentGeneration = runtimeLease.fencingGeneration;
  if (currentGeneration !== writer.fencingGeneration) {
    return {
      kind: 'fenced',
      code: 'stale_generation',
      presentedGeneration: writer.fencingGeneration,
      currentGeneration,
    };
  }
  if (runtimeLease.runtimeIncarnationId !== writer.runtimeIncarnationId) {
    return {
      kind: 'fenced',
      code: 'other_incarnation',
      presentedGeneration: writer.fencingGeneration,
      currentGeneration,
    };
  }
  if (runtimeLease.releasedAt !== null) {
    return {
      kind: 'fenced',
      code: 'released_lease',
      presentedGeneration: writer.fencingGeneration,
      currentGeneration,
    };
  }
  if (!isLeaseActive(runtimeLease, now)) {
    return {
      kind: 'fenced',
      code: 'expired_lease',
      presentedGeneration: writer.fencingGeneration,
      currentGeneration,
    };
  }
  return undefined;
}
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  RuntimeIncarnationId,
} from '../../application/dto/identity.js';
