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

export function renewRuntimeLease(
  store: BranchCoordinationStore,
  request: AcquireRuntimeLeaseRequest,
): RenewRuntimeLeaseResult {
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
    return { kind: 'rejected', rejection: result };
  }
  const lease = runtimeLeaseOf(readLeases(store, request.coordinationScopeId), request.coordinatorSessionId);
  if (lease === null) {
    return {
      kind: 'rejected',
      rejection: { kind: 'rejected', code: 'invalid_state', message: '续约后无法读回 lease' },
    };
  }
  return { kind: 'renewed', lease, revision: result.revision };
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
