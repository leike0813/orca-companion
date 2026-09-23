import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { acquireExecutionLease } from '../../src/application/coordination/lease-service.js';
import {
  acquireIncarnation,
  assertFencingGeneration,
  resumeIncarnation,
  writerFor,
  type CheckpointRecoveryRead,
} from '../../src/application/coordinator/runtime-guard.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  PlanningCycleId,
  RuntimeIncarnationId,
} from '../../src/application/dto/identity.js';
import type { CoordinationWriter } from '../../src/application/ports/branch-coordination-store.js';
import { openCoordinationStore, type CoordinationStore } from '../../src/adapters/storage/coordination-store.js';
import {
  COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
  threadIdFor,
  userEntryId,
  userStepId,
  type CoordinatorSessionState,
} from '../../src/domain/coordinator/session-state.js';

const SCOPE = 'scope-1' as CoordinationScopeId;
const SESSION_A = 'session-a' as CoordinatorSessionId;
const SESSION_B = 'session-b' as CoordinatorSessionId;
const TTL_MS = 30_000;

let directory = '';
let store: CoordinationStore;
let now = 1_000;

const clock = (): number => now;
const incarnation = (value: string): RuntimeIncarnationId => value as RuntimeIncarnationId;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-runtime-guard-'));
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
    writer: provisional(SESSION_A),
    mode: 'route_planning',
    controlState: 'active',
    planningCycleId: 'cycle-1' as PlanningCycleId,
    fullBranchRef: 'refs/heads/main',
    canonicalWorktreePath: '/tmp/orca-test-worktree',
  });
  if (created.kind !== 'committed') {
    throw new Error('无法创建测试 Scope');
  }
  registerSession(SESSION_A);
  registerSession(SESSION_B);
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

/** 注册 Session 之前的写入者：此时还没有 lease 行，generation 只作为占位。 */
function provisional(sessionId: CoordinatorSessionId): CoordinationWriter {
  return {
    coordinatorSessionId: sessionId,
    runtimeIncarnationId: `${sessionId}-inc` as RuntimeIncarnationId,
    fencingGeneration: 0,
  };
}

function revisionOf(): number {
  const result = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  if (result.kind !== 'scope' || result.scope === null) {
    throw new Error('Scope 不存在');
  }
  return result.scope.revision;
}

/** 注册 Session；bootstrap 窗口内允许未持租约的写入者。 */
function registerSession(sessionId: CoordinatorSessionId): void {
  const leases = store.query({ kind: 'leases', coordinationScopeId: SCOPE });
  const live =
    leases.kind === 'leases'
      ? leases.leases.find(
          (lease) => lease.kind === 'runtime' && lease.releasedAt === null && (lease.expiresAt ?? Infinity) > now,
        )
      : undefined;
  const result = store.transact({
    kind: 'register-session',
    coordinationScopeId: SCOPE,
    expectedRevision: revisionOf(),
    writer:
      live === undefined
        ? provisional(sessionId)
        : {
            coordinatorSessionId: live.coordinatorSessionId,
            runtimeIncarnationId: live.runtimeIncarnationId,
            fencingGeneration: live.fencingGeneration,
          },
    coordinatorSessionId: sessionId,
    coordinatorModelConfigurationRef: `model-config-${sessionId}`,
    lifecycleState: 'registered',
  });
  if (result.kind !== 'committed') {
    throw new Error(`无法注册 ${sessionId}: ${result.message}`);
  }
}

function sessionIds(): readonly string[] {
  const result = store.query({ kind: 'sessions', coordinationScopeId: SCOPE });
  if (result.kind !== 'sessions') {
    throw new Error('无法读取 Session registry');
  }
  return result.sessions.map((session) => session.coordinatorSessionId);
}

function activeClaimCount(): number {
  const snapshot = store.query({ kind: 'snapshot', coordinationScopeId: SCOPE });
  if (snapshot.kind !== 'snapshot') {
    throw new Error('无法读取 snapshot');
  }
  return snapshot.snapshot.ticketClaims.filter((claim) => claim.state === 'active').length;
}

function budgetConsumed(budgetKey: string): number | null {
  const result = store.query({ kind: 'budget-counters', coordinationScopeId: SCOPE });
  if (result.kind !== 'budget-counters') {
    throw new Error('无法读取预算计数');
  }
  return result.counters.find((counter) => counter.budgetKey === budgetKey)?.consumed ?? null;
}

function executionLeaseHolder(): string | null {
  const snapshot = store.query({ kind: 'snapshot', coordinationScopeId: SCOPE });
  if (snapshot.kind !== 'snapshot') {
    throw new Error('无法读取 snapshot');
  }
  return snapshot.snapshot.executionLease?.coordinatorSessionId ?? null;
}

/** 内存版 checkpoint port：只区分「读回」「从未写过」「读不回来」。 */
function checkpoints(read: CheckpointRecoveryRead) {
  return { loadCheckpoint: (): CheckpointRecoveryRead => read };
}

function sessionState(overrides: Partial<CoordinatorSessionState> = {}): CoordinatorSessionState {
  return {
    schemaVersion: COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
    coordinatorSessionId: SESSION_A,
    committedMessages: [
      {
        entryId: userEntryId('submission-1'),
        stepId: userStepId('submission-1'),
        role: 'user',
        content: '继续',
      },
    ],
    graphPosition: 'model',
    committedModelSteps: [],
    wakeBatches: [],
    lastCompactionOutcome: null,
    ...overrides,
  };
}

test('第二个进程以同一 Session 身份启动时被显式拒绝，且不产生任何写入', () => {
  const first = acquireIncarnation(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: incarnation('inc-1'),
    ttlMs: TTL_MS,
  });
  expect(first.kind).toBe('acquired');

  const revisionBefore = revisionOf();
  const second = acquireIncarnation(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: incarnation('inc-2'),
    ttlMs: TTL_MS,
  });

  expect(second.kind).toBe('held');
  if (second.kind === 'held') {
    expect(second.lease.runtimeIncarnationId).toBe('inc-1');
  }
  expect(revisionOf()).toBe(revisionBefore);
  expect(sessionIds()).toEqual([SESSION_A, SESSION_B]);
});

test('被 fence 的迟到进程不能提交 checkpoint，当前 incarnation 的持久状态不变', () => {
  const stale = acquireIncarnation(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: incarnation('inc-1'),
    ttlMs: TTL_MS,
  });
  expect(stale.kind).toBe('acquired');
  if (stale.kind !== 'acquired') {
    return;
  }

  now += TTL_MS + 1;
  const takeover = acquireIncarnation(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: incarnation('inc-2'),
    ttlMs: TTL_MS,
  });
  expect(takeover.kind).toBe('acquired');

  const late = assertFencingGeneration(store, stale.incarnation, { clock });
  expect(late.kind).toBe('fenced');
  if (late.kind === 'fenced') {
    expect(late.code).toBe('stale_generation');
  }

  if (takeover.kind === 'acquired') {
    expect(assertFencingGeneration(store, takeover.incarnation, { clock }).kind).toBe('valid');
    expect(takeover.incarnation.fencingGeneration).toBe(stale.incarnation.fencingGeneration + 1);
  }
});

test('租约过期后迟到进程同样被拒绝，而不是继续以自己的 generation 写入', () => {
  const held = acquireIncarnation(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: incarnation('inc-1'),
    ttlMs: TTL_MS,
  });
  expect(held.kind).toBe('acquired');
  if (held.kind !== 'acquired') {
    return;
  }

  now += TTL_MS + 1;
  const expired = assertFencingGeneration(store, held.incarnation, { clock });
  expect(expired.kind).toBe('fenced');
  if (expired.kind === 'fenced') {
    expect(expired.code).toBe('expired_lease');
  }
});

test('恢复沿用原 Session 身份与已消耗预算，不创建新的运行身份', () => {
  const first = acquireIncarnation(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: incarnation('inc-1'),
    ttlMs: TTL_MS,
  });
  expect(first.kind).toBe('acquired');
  if (first.kind !== 'acquired') {
    return;
  }
  const execution = acquireExecutionLease(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: first.incarnation.runtimeIncarnationId,
    fencingGeneration: first.incarnation.fencingGeneration,
  });
  expect(execution.kind).toBe('acquired');

  const writer = writerFor(first.incarnation);
  const consumed = store.transact({
    kind: 'consume-budget',
    coordinationScopeId: SCOPE,
    expectedRevision: revisionOf(),
    writer,
    budgetKey: 'coordinator_model_calls',
    approvedLimitRef: 'approval-1',
    amount: 5,
  });
  expect(consumed.kind).toBe('committed');

  now += TTL_MS + 1;
  const resumed = resumeIncarnation(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: incarnation('inc-2'),
    ttlMs: TTL_MS,
    checkpoints: checkpoints({ kind: 'recovered', state: sessionState() }),
  });

  expect(resumed.kind).toBe('resumed');
  if (resumed.kind !== 'resumed') {
    return;
  }
  expect(resumed.recovered).toBe(true);
  expect(resumed.incarnation.coordinatorSessionId).toBe(SESSION_A);
  expect(resumed.incarnation.fencingGeneration).toBe(first.incarnation.fencingGeneration + 1);
  expect(budgetConsumed('coordinator_model_calls')).toBe(5);
  expect(sessionIds()).toEqual([SESSION_A, SESSION_B]);
  expect(executionLeaseHolder()).toBe(SESSION_A);
});

test('同一 Session 首次启动时没有 checkpoint 不算不可恢复', () => {
  const resumed = resumeIncarnation(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: incarnation('inc-1'),
    ttlMs: TTL_MS,
    checkpoints: checkpoints({ kind: 'absent' }),
  });

  expect(resumed.kind).toBe('resumed');
  if (resumed.kind === 'resumed') {
    expect(resumed.recovered).toBe(false);
    expect(resumed.sessionState).toBeNull();
    expect(resumed.previousGeneration).toBeNull();
  }
});

test('checkpoint 不可恢复时 fail closed，且不创建替代 Session、不转移 claim 或 lease', () => {
  const first = acquireIncarnation(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: incarnation('inc-1'),
    ttlMs: TTL_MS,
  });
  expect(first.kind).toBe('acquired');
  if (first.kind !== 'acquired') {
    return;
  }
  acquireExecutionLease(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: first.incarnation.runtimeIncarnationId,
    fencingGeneration: first.incarnation.fencingGeneration,
  });
  const claimed = store.transact({
    kind: 'record-ticket-claim',
    coordinationScopeId: SCOPE,
    expectedRevision: revisionOf(),
    writer: writerFor(first.incarnation),
    ticketRef: { kind: 'decision_ticket', id: 'ticket-1' },
  });
  expect(claimed.kind).toBe('committed');

  const sessionsBefore = sessionIds();
  const claimsBefore = activeClaimCount();
  now += TTL_MS + 1;

  const resumed = resumeIncarnation(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: incarnation('inc-2'),
    ttlMs: TTL_MS,
    checkpoints: checkpoints({ kind: 'unrecoverable', reason: 'checkpoint 校验失败' }),
  });

  expect(resumed.kind).toBe('blocked');
  if (resumed.kind === 'blocked') {
    expect(resumed.error).toBeInstanceOf(Error);
    expect(resumed.error.coordinatorSessionId).toBe(SESSION_A);
    expect(resumed.reason).toContain('checkpoint');
  }
  expect(sessionIds()).toEqual(sessionsBefore);
  expect(activeClaimCount()).toBe(claimsBefore);
  expect(executionLeaseHolder()).toBe(SESSION_A);
});

test('曾经运行过却读不到 checkpoint 的 Session 被阻塞，而不是以空历史继续', () => {
  const first = acquireIncarnation(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: incarnation('inc-1'),
    ttlMs: TTL_MS,
  });
  expect(first.kind).toBe('acquired');
  now += TTL_MS + 1;

  const resumed = resumeIncarnation(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: incarnation('inc-2'),
    ttlMs: TTL_MS,
    checkpoints: checkpoints({ kind: 'absent' }),
  });

  expect(resumed.kind).toBe('blocked');
});

test('checkpoint 属于别的 Session 时阻塞，不把它当成本 Session 的历史', () => {
  now += TTL_MS + 1;
  const resumed = resumeIncarnation(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: incarnation('inc-1'),
    ttlMs: TTL_MS,
    checkpoints: checkpoints({ kind: 'recovered', state: sessionState({ coordinatorSessionId: SESSION_B }) }),
  });

  expect(resumed.kind).toBe('blocked');
});

test('checkpoint thread 映射与 Session 身份一致：一个 Session 一个线程', () => {
  const first = acquireIncarnation(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: incarnation('inc-1'),
    ttlMs: TTL_MS,
  });
  expect(first.kind).toBe('acquired');

  expect(threadIdFor(SESSION_A)).not.toBe(threadIdFor(SESSION_B));
  expect(threadIdFor(SESSION_A)).toBe(threadIdFor(SESSION_A));
});
