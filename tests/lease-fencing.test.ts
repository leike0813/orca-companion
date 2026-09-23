import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  GraphId,
  GraphVersion,
  PlanningCycleId,
  RuntimeIncarnationId,
} from '../src/application/dto/identity.js';
import type {
  CoordinationCommandResult,
  CoordinationWriter,
} from '../src/application/ports/branch-coordination-store.js';
import {
  acquireExecutionLease,
  acquireRuntimeLease,
  releaseExecutionLease,
  renewRuntimeLease,
} from '../src/application/coordination/lease-service.js';
import { openCoordinationStore, type CoordinationStore } from '../src/adapters/storage/coordination-store.js';

const SCOPE = 'scope-1' as CoordinationScopeId;
const SESSION_A = 'session-a' as CoordinatorSessionId;
const SESSION_B = 'session-b' as CoordinatorSessionId;
const TTL_MS = 30_000;

let directory = '';
let store: CoordinationStore;
let now = 1_000;

const clock = (): number => now;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-lease-'));
  now = 1_000;
  const opened = openCoordinationStore({ databasePath: join(directory, 'coordination.sqlite'), clock });
  if (opened.kind !== 'opened') {
    throw new Error(opened.message);
  }
  store = opened.store;

  const created = store.transact({
    kind: 'create-scope',
    coordinationScopeId: SCOPE,
    expectedRevision: 0,
    writer: provisionalWriter(SESSION_A),
    mode: 'route_planning',
    controlState: 'active',
    planningCycleId: 'cycle-1' as PlanningCycleId,
    fullBranchRef: 'refs/heads/main',
    canonicalWorktreePath: '/tmp/orca-test-worktree',
  });
  if (created.kind !== 'committed') {
    throw new Error('无法创建测试 Scope');
  }
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

/** 取得租约之前的写入者：此时还没有 lease 行，generation 只作为占位。 */
function provisionalWriter(sessionId: CoordinatorSessionId): CoordinationWriter {
  return {
    coordinatorSessionId: sessionId,
    runtimeIncarnationId: `${sessionId}-inc` as RuntimeIncarnationId,
    fencingGeneration: 0,
  };
}

const incarnation = (value: string): RuntimeIncarnationId => value as RuntimeIncarnationId;

function revisionOf(): number {
  const result = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  if (result.kind !== 'scope' || result.scope === null) {
    throw new Error('Scope 不存在');
  }
  return result.scope.revision;
}

/** 注册 Session 并取得 Runtime Lease，返回带真实 fencing generation 的写入者。 */
function bootstrapSession(sessionId: CoordinatorSessionId, incarnationId: string): CoordinationWriter {
  const runtimeIncarnationId = incarnation(incarnationId);
  const leases = store.query({ kind: 'leases', coordinationScopeId: SCOPE });
  const currentRuntime =
    leases.kind === 'leases'
      ? leases.leases.find(
          (lease) => lease.kind === 'runtime' && lease.releasedAt === null && (lease.expiresAt ?? Infinity) > now,
        )
      : undefined;
  const registered: CoordinationCommandResult = store.transact({
    kind: 'register-session',
    coordinationScopeId: SCOPE,
    expectedRevision: revisionOf(),
    writer:
      currentRuntime === undefined
        ? provisionalWriter(sessionId)
        : {
            coordinatorSessionId: currentRuntime.coordinatorSessionId,
            runtimeIncarnationId: currentRuntime.runtimeIncarnationId,
            fencingGeneration: currentRuntime.fencingGeneration,
          },
    coordinatorSessionId: sessionId,
    coordinatorModelConfigurationRef: `profile-${sessionId}`,
    lifecycleState: 'registered',
  });
  if (registered.kind !== 'committed') {
    throw new Error(`无法注册 ${sessionId}`);
  }
  const acquired = acquireRuntimeLease(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: sessionId,
    runtimeIncarnationId,
    fencingGeneration: 0,
    ttlMs: TTL_MS,
  });
  if (acquired.kind !== 'acquired') {
    throw new Error(`无法为 ${sessionId} 取得 Runtime Lease`);
  }
  return {
    coordinatorSessionId: sessionId,
    runtimeIncarnationId,
    fencingGeneration: acquired.lease.fencingGeneration,
  };
}

function runtimeLeaseOf(sessionId: CoordinatorSessionId): {
  readonly fencingGeneration: number;
  readonly expiresAt: number | null;
} {
  const leases = store.query({ kind: 'leases', coordinationScopeId: SCOPE });
  if (leases.kind !== 'leases') {
    throw new Error('无法读取 leases');
  }
  const lease = leases.leases.find(
    (candidate) => candidate.kind === 'runtime' && candidate.coordinatorSessionId === sessionId,
  );
  if (lease === undefined) {
    throw new Error(`没有 ${sessionId} 的 Runtime Lease`);
  }
  return lease;
}

function activeClaimCount(): number {
  const snapshot = store.query({ kind: 'snapshot', coordinationScopeId: SCOPE });
  if (snapshot.kind !== 'snapshot') {
    throw new Error('无法读取 snapshot');
  }
  return snapshot.snapshot.ticketClaims.filter((claim) => claim.state === 'active').length;
}

test('心跳续约推进到期时间，但不推进 scope.revision', () => {
  const writer = bootstrapSession(SESSION_A, 'inc-1');
  const revisionBefore = revisionOf();

  now += 5_000;
  const renewed = renewRuntimeLease(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: writer.coordinatorSessionId,
    runtimeIncarnationId: writer.runtimeIncarnationId,
    fencingGeneration: writer.fencingGeneration,
    ttlMs: TTL_MS,
  });

  expect(renewed.kind).toBe('renewed');
  if (renewed.kind === 'renewed') {
    expect(renewed.lease.expiresAt).toBe(now + TTL_MS);
    expect(renewed.lease.fencingGeneration).toBe(writer.fencingGeneration);
    expect(renewed.revision).toBe(revisionBefore);
  }
  expect(revisionOf()).toBe(revisionBefore);
});

test('过期租约由新的 Runtime Incarnation 接管并获得更大的 generation', () => {
  const first = bootstrapSession(SESSION_A, 'inc-1');
  expect(runtimeLeaseOf(SESSION_A).fencingGeneration).toBe(first.fencingGeneration);

  now += TTL_MS + 1;
  const takeover = acquireRuntimeLease(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: incarnation('inc-2'),
    fencingGeneration: first.fencingGeneration,
    ttlMs: TTL_MS,
  });

  expect(takeover.kind).toBe('acquired');
  if (takeover.kind === 'acquired') {
    expect(takeover.lease.fencingGeneration).toBe(first.fencingGeneration + 1);
    expect(takeover.lease.runtimeIncarnationId).toBe('inc-2');
    expect(takeover.previousGeneration).toBe(first.fencingGeneration);
  }
});

test('尚未过期的租约不能被第二个 Incarnation 抢占', () => {
  const first = bootstrapSession(SESSION_A, 'inc-1');

  const contested = acquireRuntimeLease(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: incarnation('inc-2'),
    fencingGeneration: first.fencingGeneration,
    ttlMs: TTL_MS,
  });

  expect(contested.kind).toBe('held');
  expect(runtimeLeaseOf(SESSION_A).fencingGeneration).toBe(first.fencingGeneration);
});

test('迟到进程以旧 generation 写入被拒绝', () => {
  const stale = bootstrapSession(SESSION_A, 'inc-1');
  now += TTL_MS + 1;
  const takeover = acquireRuntimeLease(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: incarnation('inc-2'),
    fencingGeneration: stale.fencingGeneration,
    ttlMs: TTL_MS,
  });
  expect(takeover.kind).toBe('acquired');

  const late = store.transact({
    kind: 'record-control-state',
    coordinationScopeId: SCOPE,
    expectedRevision: revisionOf(),
    writer: stale,
    controlState: 'paused',
  });

  expect(late.kind).toBe('rejected');
  if (late.kind === 'rejected') {
    expect(late.code).toBe('fenced');
  }
  const scope = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  if (scope.kind === 'scope' && scope.scope !== null) {
    expect(scope.scope.controlState).toBe('active');
    expect(scope.scope.mode).toBe('route_planning');
  }
});

test('Runtime Lease 过期与接管不释放 Ticket Claim', () => {
  const first = bootstrapSession(SESSION_A, 'inc-1');
  const claimed = store.transact({
    kind: 'record-ticket-claim',
    coordinationScopeId: SCOPE,
    expectedRevision: revisionOf(),
    writer: first,
    ticketRef: { kind: 'decision_ticket', id: 'ticket-1' },
  });
  expect(claimed.kind).toBe('committed');
  expect(activeClaimCount()).toBe(1);

  now += TTL_MS + 1;
  const takeover = acquireRuntimeLease(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: incarnation('inc-2'),
    fencingGeneration: first.fencingGeneration,
    ttlMs: TTL_MS,
  });
  expect(takeover.kind).toBe('acquired');

  expect(activeClaimCount()).toBe(1);
});

test('恢复沿用原所有权：同一 Session 重新取得租约后仍持有 Execution Coordination Lease', () => {
  const first = bootstrapSession(SESSION_A, 'inc-1');
  const execution = acquireExecutionLease(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: incarnation('inc-1'),
    fencingGeneration: first.fencingGeneration,
  });
  expect(execution.kind).toBe('acquired');

  now += TTL_MS + 1;
  const recovered = acquireRuntimeLease(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: incarnation('inc-2'),
    fencingGeneration: first.fencingGeneration,
    ttlMs: TTL_MS,
  });
  expect(recovered.kind).toBe('acquired');
  if (recovered.kind !== 'acquired') {
    return;
  }

  const snapshot = store.query({ kind: 'snapshot', coordinationScopeId: SCOPE });
  if (snapshot.kind === 'snapshot') {
    expect(snapshot.snapshot.executionLease?.coordinatorSessionId).toBe(SESSION_A);
  }

  const consume = store.transact({
    kind: 'consume-budget',
    coordinationScopeId: SCOPE,
    expectedRevision: revisionOf(),
    writer: {
      coordinatorSessionId: SESSION_A,
      runtimeIncarnationId: incarnation('inc-2'),
      fencingGeneration: recovered.lease.fencingGeneration,
    },
    budgetKey: 'implementation_attempts',
    approvedLimitRef: 'approval-1',
    amount: 1,
  });
  expect(consume.kind).toBe('committed');
});

test('Execution Coordination Lease 只有一个持有者，非持有者不能推进执行', () => {
  const writerA = bootstrapSession(SESSION_A, 'a-inc-1');
  const writerB = bootstrapSession(SESSION_B, 'b-inc-1');

  const acquired = acquireExecutionLease(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: writerA.runtimeIncarnationId,
    fencingGeneration: writerA.fencingGeneration,
  });
  expect(acquired.kind).toBe('acquired');

  const contested = acquireExecutionLease(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_B,
    runtimeIncarnationId: writerB.runtimeIncarnationId,
    fencingGeneration: writerB.fencingGeneration,
  });
  expect(contested.kind).toBe('held_by_other');
  if (contested.kind === 'held_by_other') {
    expect(contested.lease.coordinatorSessionId).toBe(SESSION_A);
  }

  const graphChange = store.transact({
    kind: 'update-scope-refs',
    coordinationScopeId: SCOPE,
    expectedRevision: revisionOf(),
    writer: writerB,
    graphId: 'graph-1' as GraphId,
    graphVersion: 1 as GraphVersion,
    authorizationId: 'authorization-1',
    authorizationVersion: 1,
  });
  expect(graphChange.kind).toBe('rejected');
  if (graphChange.kind === 'rejected') {
    expect(graphChange.code).toBe('constraint');
  }

  const budgetByNonHolder = store.transact({
    kind: 'consume-budget',
    coordinationScopeId: SCOPE,
    expectedRevision: revisionOf(),
    writer: writerB,
    budgetKey: 'implementation_attempts',
    approvedLimitRef: 'approval-1',
    amount: 1,
  });
  expect(budgetByNonHolder.kind).toBe('rejected');

  const graphByHolder = store.transact({
    kind: 'update-scope-refs',
    coordinationScopeId: SCOPE,
    expectedRevision: revisionOf(),
    writer: writerA,
    graphId: 'graph-1' as GraphId,
    graphVersion: 1 as GraphVersion,
    authorizationId: 'authorization-1',
    authorizationVersion: 1,
  });
  expect(graphByHolder.kind).toBe('committed');
});

test('预算计数只累积不重置，且授权上限引用必须一致', () => {
  const writer = bootstrapSession(SESSION_A, 'inc-1');
  const execution = acquireExecutionLease(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: writer.runtimeIncarnationId,
    fencingGeneration: writer.fencingGeneration,
  });
  expect(execution.kind).toBe('acquired');

  for (const amount of [2, 3]) {
    const consumed = store.transact({
      kind: 'consume-budget',
      coordinationScopeId: SCOPE,
      expectedRevision: revisionOf(),
      writer,
      budgetKey: 'implementation_attempts',
      approvedLimitRef: 'approval-1',
      amount,
    });
    expect(consumed.kind).toBe('committed');
  }

  const switched = store.transact({
    kind: 'consume-budget',
    coordinationScopeId: SCOPE,
    expectedRevision: revisionOf(),
    writer,
    budgetKey: 'implementation_attempts',
    approvedLimitRef: 'approval-2',
    amount: 1,
  });
  expect(switched.kind).toBe('rejected');

  const counters = store.query({ kind: 'budget-counters', coordinationScopeId: SCOPE });
  if (counters.kind === 'budget-counters') {
    expect(counters.counters).toEqual([
      {
        coordinationScopeId: SCOPE,
        budgetKey: 'implementation_attempts',
        approvedLimitRef: 'approval-1',
        consumed: 5,
      },
    ]);
  }
});

test('显式释放后 Execution Coordination Lease 才可以转移给另一个 Session', () => {
  const writerA = bootstrapSession(SESSION_A, 'a-inc-1');
  const writerB = bootstrapSession(SESSION_B, 'b-inc-1');
  acquireExecutionLease(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: writerA.runtimeIncarnationId,
    fencingGeneration: writerA.fencingGeneration,
  });

  const released = releaseExecutionLease(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: writerA.runtimeIncarnationId,
    fencingGeneration: writerA.fencingGeneration,
  });
  expect(released.kind).toBe('released');

  const transferred = acquireExecutionLease(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_B,
    runtimeIncarnationId: writerB.runtimeIncarnationId,
    fencingGeneration: writerB.fencingGeneration,
  });
  expect(transferred.kind).toBe('acquired');
  if (transferred.kind === 'acquired') {
    expect(transferred.lease.coordinatorSessionId).toBe(SESSION_B);
  }
});

test('显式释放 Runtime Lease 后旧 incarnation 不能继续写入', () => {
  const writerA = bootstrapSession(SESSION_A, 'inc-1');

  const released = store.transact({
    kind: 'release-runtime-lease',
    coordinationScopeId: SCOPE,
    expectedRevision: revisionOf(),
    writer: writerA,
  });
  expect(released.kind).toBe('committed');

  const late = store.transact({
    kind: 'record-control-state',
    coordinationScopeId: SCOPE,
    expectedRevision: revisionOf(),
    writer: writerA,
    controlState: 'paused',
  });
  expect(late.kind).toBe('rejected');
  if (late.kind === 'rejected') {
    expect(late.code).toBe('fenced');
  }

  const reacquired = acquireRuntimeLease(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: incarnation('inc-2'),
    fencingGeneration: writerA.fencingGeneration,
    ttlMs: TTL_MS,
  });
  expect(reacquired.kind).toBe('acquired');
  if (reacquired.kind === 'acquired') {
    expect(reacquired.lease.fencingGeneration).toBe(writerA.fencingGeneration + 1);
  }
});

test('非持有者不能释放别人的 Execution Coordination Lease', () => {
  const writerA = bootstrapSession(SESSION_A, 'a-inc-1');
  const writerB = bootstrapSession(SESSION_B, 'b-inc-1');
  acquireExecutionLease(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: writerA.runtimeIncarnationId,
    fencingGeneration: writerA.fencingGeneration,
  });

  const stolen = releaseExecutionLease(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_B,
    runtimeIncarnationId: writerB.runtimeIncarnationId,
    fencingGeneration: writerB.fencingGeneration,
  });

  expect(stolen.kind).toBe('rejected');
  const snapshot = store.query({ kind: 'snapshot', coordinationScopeId: SCOPE });
  if (snapshot.kind === 'snapshot') {
    expect(snapshot.snapshot.executionLease?.coordinatorSessionId).toBe(SESSION_A);
  }
});
