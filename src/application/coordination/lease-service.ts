/**
 * IC-03 的租约用例（Owner: `m1-persist-coordination-state`）。
 *
 * 这一层提供时序策略：租约时长、心跳、接管前的事实读取；行机制（generation 单调、唯一约束、
 * 精确 CAS）由 store 在单事务内保证。这里刻意不提供「过期即释放」的路径——进程消失不等于
 * 职责转移，Ticket Claim 与 Execution Coordination Lease 只经完成、显式释放或用户授权转移改变。
 */

import type { LeaseRecord } from '../../domain/coordination/leases.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  RuntimeIncarnationId,
} from '../dto/identity.js';
import type {
  BranchCoordinationStore,
  CoordinationCommandRejection,
  CoordinationWriter,
} from '../ports/branch-coordination-store.js';

/** 短租约：持有者按更小的心跳间隔续约。 */
export const DEFAULT_RUNTIME_LEASE_TTL_MS = 30_000;

export type AcquireRuntimeLeaseRequest = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly runtimeIncarnationId: RuntimeIncarnationId;
  readonly fencingGeneration: number;
  readonly ttlMs?: number;
};

export type AcquireRuntimeLeaseResult =
  | {
      readonly kind: 'acquired';
      readonly lease: LeaseRecord;
      readonly revision: number;
      /** 该 Session 之前的 generation；`null` 表示这是首次取得。 */
      readonly previousGeneration: number | null;
    }
  | { readonly kind: 'held'; readonly lease: LeaseRecord }
  | { readonly kind: 'rejected'; readonly rejection: CoordinationCommandRejection };

export type RenewRuntimeLeaseResult =
  | { readonly kind: 'renewed'; readonly lease: LeaseRecord; readonly revision: number }
  | { readonly kind: 'rejected'; readonly rejection: CoordinationCommandRejection };

export type AcquireExecutionLeaseResult =
  | { readonly kind: 'acquired'; readonly lease: LeaseRecord; readonly revision: number }
  | { readonly kind: 'held_by_other'; readonly lease: LeaseRecord }
  | { readonly kind: 'rejected'; readonly rejection: CoordinationCommandRejection };

export type ReleaseExecutionLeaseResult =
  | { readonly kind: 'released'; readonly revision: number }
  | { readonly kind: 'rejected'; readonly rejection: CoordinationCommandRejection };

type ScopeRevisionRead =
  | { readonly kind: 'read'; readonly revision: number }
  | { readonly kind: 'rejected'; readonly rejection: CoordinationCommandRejection };

function readScopeRevision(store: BranchCoordinationStore, coordinationScopeId: CoordinationScopeId): ScopeRevisionRead {
  const result = store.query({ kind: 'scope', coordinationScopeId });
  if (result.kind === 'rejected') {
    return {
      kind: 'rejected',
      rejection: { kind: 'rejected', code: 'invalid_state', message: result.message },
    };
  }
  if (result.kind !== 'scope' || result.scope === null) {
    return {
      kind: 'rejected',
      rejection: { kind: 'rejected', code: 'invalid_state', message: `Scope ${coordinationScopeId} 尚未创建` },
    };
  }
  return { kind: 'read', revision: result.scope.revision };
}

function readLeases(store: BranchCoordinationStore, coordinationScopeId: CoordinationScopeId): readonly LeaseRecord[] {
  const result = store.query({ kind: 'leases', coordinationScopeId });
  return result.kind === 'leases' ? result.leases : [];
}

function runtimeLeaseOf(
  leases: readonly LeaseRecord[],
  coordinatorSessionId: CoordinatorSessionId,
): LeaseRecord | null {
  return (
    leases.find((lease) => lease.kind === 'runtime' && lease.coordinatorSessionId === coordinatorSessionId) ?? null
  );
}

function executionLeaseOf(leases: readonly LeaseRecord[]): LeaseRecord | null {
  return leases.find((lease) => lease.kind === 'execution_coordination' && lease.releasedAt === null) ?? null;
}

export function acquireRuntimeLease(
  store: BranchCoordinationStore,
  request: AcquireRuntimeLeaseRequest,
): AcquireRuntimeLeaseResult {
  const writer: CoordinationWriter = {
    coordinatorSessionId: request.coordinatorSessionId,
    runtimeIncarnationId: request.runtimeIncarnationId,
    fencingGeneration: request.fencingGeneration,
  };
  const previous = runtimeLeaseOf(readLeases(store, request.coordinationScopeId), request.coordinatorSessionId);
  const revision = readScopeRevision(store, request.coordinationScopeId);
  if (revision.kind === 'rejected') {
    return { kind: 'rejected', rejection: revision.rejection };
  }
  const result = store.transact({
    kind: 'acquire-runtime-lease',
    coordinationScopeId: request.coordinationScopeId,
    expectedRevision: revision.revision,
    writer,
    ttlMs: request.ttlMs ?? DEFAULT_RUNTIME_LEASE_TTL_MS,
  });
  if (result.kind === 'rejected') {
    const current = runtimeLeaseOf(readLeases(store, request.coordinationScopeId), request.coordinatorSessionId);
    if (result.code === 'constraint' && current !== null) {
      return { kind: 'held', lease: current };
    }
    return { kind: 'rejected', rejection: result };
  }
  const lease = runtimeLeaseOf(readLeases(store, request.coordinationScopeId), request.coordinatorSessionId);
  if (lease === null) {
    return {
      kind: 'rejected',
      rejection: { kind: 'rejected', code: 'invalid_state', message: '取得租约后无法读回 lease' },
    };
  }
  return {
    kind: 'acquired',
    lease,
    revision: result.revision,
    previousGeneration: previous === null ? null : previous.fencingGeneration,
  };
}

/**
 * 续约的乐观并发重试上限。
 *
 * 续约先读 scope revision 再以它做 CAS，而续约本身不推进 revision：读与提交之间只要夹进任意一次共享
 * 写入（对账、Delivery 结算、预算消耗……），CAS 就会以 `stale_revision` 落空。那是良性的读-改-写竞争，
 * 重读再提交即可；把它当成失去租约会让一个健康的 Session 在高写入期被误判为 fencing 失败并永久停摆。
 */
const RENEW_REVISION_RETRY_LIMIT = 5;

export function renewRuntimeLease(
  store: BranchCoordinationStore,
  request: AcquireRuntimeLeaseRequest,
): RenewRuntimeLeaseResult {
  for (let attempt = 0; ; attempt += 1) {
    const revision = readScopeRevision(store, request.coordinationScopeId);
    if (revision.kind === 'rejected') {
      return { kind: 'rejected', rejection: revision.rejection };
    }
    const result = store.transact({
      kind: 'renew-runtime-lease',
      coordinationScopeId: request.coordinationScopeId,
      expectedRevision: revision.revision,
      writer: {
        coordinatorSessionId: request.coordinatorSessionId,
        runtimeIncarnationId: request.runtimeIncarnationId,
        fencingGeneration: request.fencingGeneration,
      },
      ttlMs: request.ttlMs ?? DEFAULT_RUNTIME_LEASE_TTL_MS,
    });
    if (result.kind === 'rejected') {
      // 只有 revision 竞争可重试；fencing、无租约、账本损坏都必须如实上报给调用方。
      if (result.code === 'stale_revision' && attempt < RENEW_REVISION_RETRY_LIMIT) {
        continue;
      }
      return { kind: 'rejected', rejection: result };
    }
    return renewedLease(store, request, result.revision);
  }
}

function renewedLease(
  store: BranchCoordinationStore,
  request: AcquireRuntimeLeaseRequest,
  revision: number,
): RenewRuntimeLeaseResult {
  const lease = runtimeLeaseOf(readLeases(store, request.coordinationScopeId), request.coordinatorSessionId);
  if (lease === null) {
    return {
      kind: 'rejected',
      rejection: { kind: 'rejected', code: 'invalid_state', message: '续约后无法读回 lease' },
    };
  }
  return { kind: 'renewed', lease, revision };
}

export function acquireExecutionLease(
  store: BranchCoordinationStore,
  request: Omit<AcquireRuntimeLeaseRequest, 'ttlMs'>,
): AcquireExecutionLeaseResult {
  const held = executionLeaseOf(readLeases(store, request.coordinationScopeId));
  if (held !== null && held.coordinatorSessionId !== request.coordinatorSessionId) {
    return { kind: 'held_by_other', lease: held };
  }
  const revision = readScopeRevision(store, request.coordinationScopeId);
  if (revision.kind === 'rejected') {
    return { kind: 'rejected', rejection: revision.rejection };
  }
  const result = store.transact({
    kind: 'acquire-execution-lease',
    coordinationScopeId: request.coordinationScopeId,
    expectedRevision: revision.revision,
    writer: {
      coordinatorSessionId: request.coordinatorSessionId,
      runtimeIncarnationId: request.runtimeIncarnationId,
      fencingGeneration: request.fencingGeneration,
    },
  });
  if (result.kind === 'rejected') {
    const current = executionLeaseOf(readLeases(store, request.coordinationScopeId));
    if (result.code === 'constraint' && current !== null) {
      return { kind: 'held_by_other', lease: current };
    }
    return { kind: 'rejected', rejection: result };
  }
  const lease = executionLeaseOf(readLeases(store, request.coordinationScopeId));
  if (lease === null) {
    return {
      kind: 'rejected',
      rejection: { kind: 'rejected', code: 'invalid_state', message: '取得 Execution Coordination Lease 后无法读回' },
    };
  }
  return { kind: 'acquired', lease, revision: result.revision };
}

export function releaseExecutionLease(
  store: BranchCoordinationStore,
  request: Omit<AcquireRuntimeLeaseRequest, 'ttlMs'>,
): ReleaseExecutionLeaseResult {
  const revision = readScopeRevision(store, request.coordinationScopeId);
  if (revision.kind === 'rejected') {
    return { kind: 'rejected', rejection: revision.rejection };
  }
  const result = store.transact({
    kind: 'release-execution-lease',
    coordinationScopeId: request.coordinationScopeId,
    expectedRevision: revision.revision,
    writer: {
      coordinatorSessionId: request.coordinatorSessionId,
      runtimeIncarnationId: request.runtimeIncarnationId,
      fencingGeneration: request.fencingGeneration,
    },
  });
  if (result.kind === 'rejected') {
    return { kind: 'rejected', rejection: result };
  }
  return { kind: 'released', revision: result.revision };
}

export type RepointExecutionLeaseResult =
  | { readonly kind: 'repointed'; readonly lease: LeaseRecord }
  | { readonly kind: 'unchanged'; readonly lease: LeaseRecord | null }
  | { readonly kind: 'held_by_other'; readonly lease: LeaseRecord }
  | { readonly kind: 'rejected'; readonly rejection: CoordinationCommandRejection };

/**
 * 把已由本 Session 持有的 Execution Coordination Lease 重指到当前 Incarnation。
 *
 * 租约按 Session 归属（并发上限的判定只看 Session），但记录里的 incarnation 与 fencing 会被协调级写入
 * 用来拒绝陈旧进程（`request_graph_patch` 等用例的 `stale_lease_identity`）。Incarnation 在每次进程
 * 启动或同一 Session 重新取得 Runtime Lease 时会拿到更大的 fencing generation，因此**不重指**就会让
 * 同一个 Session 在接管之后永久写不进协调事实：模型请求图修订只会拿到 `stale_lease_identity`，而派发
 * 路径（只比对 Session）看起来一切正常。
 *
 * 只有当前持有者可以重指（别人的租约在这里是 `held_by_other`，绝不覆盖）；身份已经一致时不写任何东西。
 */
export function repointExecutionLease(input: {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly runtimeIncarnationId: RuntimeIncarnationId;
  readonly fencingGeneration: number;
}): RepointExecutionLeaseResult {
  const held = executionLeaseOf(readLeases(input.store, input.coordinationScopeId));
  if (held === null) {
    return { kind: 'unchanged', lease: null };
  }
  if (held.coordinatorSessionId !== input.coordinatorSessionId) {
    return { kind: 'held_by_other', lease: held };
  }
  if (
    held.runtimeIncarnationId === input.runtimeIncarnationId &&
    held.fencingGeneration === input.fencingGeneration
  ) {
    return { kind: 'unchanged', lease: held };
  }
  const acquired = acquireExecutionLease(input.store, {
    coordinationScopeId: input.coordinationScopeId,
    coordinatorSessionId: input.coordinatorSessionId,
    runtimeIncarnationId: input.runtimeIncarnationId,
    fencingGeneration: input.fencingGeneration,
  });
  return acquired.kind === 'acquired'
    ? { kind: 'repointed', lease: acquired.lease }
    : acquired.kind === 'held_by_other'
      ? { kind: 'held_by_other', lease: acquired.lease }
      : { kind: 'rejected', rejection: acquired.rejection };
}
