import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, expect, test } from 'vitest';

import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  DispatchId,
  OperationId,
  PlanningCycleId,
  RuntimeIncarnationId,
  SessionSegmentId,
  WorkerTaskId,
  WorkPackageId,
} from '../src/application/dto/identity.js';
import type {
  CoordinationCommand,
  CoordinationCommandResult,
} from '../src/application/ports/branch-coordination-store.js';
import { openCoordinationStore, type CoordinationStore } from '../src/adapters/storage/coordination-store.js';
import { COORDINATION_TABLES } from '../src/adapters/storage/schema.js';

const SCOPE = 'scope-1' as CoordinationScopeId;
const SCOPE_2 = 'scope-2' as CoordinationScopeId;
const SESSION_A = 'session-a' as CoordinatorSessionId;
const SESSION_B = 'session-b' as CoordinatorSessionId;

let directory = '';
let store: CoordinationStore;
let now = 1_000;

const clock = (): number => now;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-coordination-'));
  now = 1_000;
  const opened = openCoordinationStore({
    databasePath: join(directory, 'coordination.sqlite'),
    clock,
  });
  if (opened.kind !== 'opened') {
    throw new Error(`无法打开测试 store: ${opened.message}`);
  }
  store = opened.store;
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

function writer(session: CoordinatorSessionId = SESSION_A, generation = 1): {
  coordinatorSessionId: CoordinatorSessionId;
  runtimeIncarnationId: RuntimeIncarnationId;
  fencingGeneration: number;
} {
  return {
    coordinatorSessionId: session,
    runtimeIncarnationId: `${session}-inc` as RuntimeIncarnationId,
    fencingGeneration: generation,
  };
}

function revisionOf(scopeId: CoordinationScopeId = SCOPE): number {
  const result = store.query({ kind: 'scope', coordinationScopeId: scopeId });
  if (result.kind !== 'scope' || result.scope === null) {
    throw new Error(`Scope ${scopeId} 不存在`);
  }
  return result.scope.revision;
}

/** 以当前 revision 提交命令，避免每个用例手工串联 revision。 */
function submit(
  build: (expectedRevision: number) => CoordinationCommand,
  scopeId: CoordinationScopeId = SCOPE,
): CoordinationCommandResult {
  return store.transact(build(revisionOf(scopeId)));
}

function createScope(scopeId: CoordinationScopeId = SCOPE): CoordinationCommandResult {
  return store.transact({
    kind: 'create-scope',
    coordinationScopeId: scopeId,
    expectedRevision: 0,
    writer: writer(),
    mode: 'route_planning',
    controlState: 'active',
    planningCycleId: 'cycle-1' as PlanningCycleId,
  });
}

function activateSession(
  scopeId: CoordinationScopeId = SCOPE,
  sessionId: CoordinatorSessionId = SESSION_A,
): void {
  const registered = store.transact({
    kind: 'register-session',
    coordinationScopeId: scopeId,
    expectedRevision: revisionOf(scopeId),
    writer: writer(sessionId, 0),
    coordinatorSessionId: sessionId,
    coordinatorModelConfigurationRef: `profile-${sessionId}`,
    lifecycleState: 'registered',
  });
  if (registered.kind !== 'committed') {
    throw new Error('无法注册测试 Session');
  }
  const acquired = store.transact({
    kind: 'acquire-runtime-lease',
    coordinationScopeId: scopeId,
    expectedRevision: registered.revision,
    writer: writer(sessionId, 0),
    ttlMs: 30_000,
  });
  if (acquired.kind !== 'committed') {
    throw new Error('无法取得测试 Runtime Lease');
  }
}

function scopeMode(scopeId: CoordinationScopeId = SCOPE): string {
  const result = store.query({ kind: 'scope', coordinationScopeId: scopeId });
  if (result.kind !== 'scope' || result.scope === null) {
    throw new Error(`Scope ${scopeId} 不存在`);
  }
  return result.scope.mode;
}

test('创建 Scope 从缺失状态推进到 revision 1', () => {
  const created = createScope();

  expect(created).toEqual({ kind: 'committed', revision: 1 });
  const result = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  expect(result.kind).toBe('scope');
  if (result.kind === 'scope' && result.scope !== null) {
    expect(result.scope.mode).toBe('route_planning');
    expect(result.scope.controlState).toBe('active');
    expect(result.scope.planningCycleId).toBe('cycle-1');
    expect(result.scope.revision).toBe(1);
  }
});

test('过期 revision 的写入被拒绝且先前写入保持不变', () => {
  createScope();
  activateSession();
  const paused = submit((expectedRevision) => ({
    kind: 'record-control-state',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(),
    controlState: 'paused',
  }));
  expect(paused).toEqual({ kind: 'committed', revision: 4 });

  const stale = store.transact({
    kind: 'record-control-state',
    coordinationScopeId: SCOPE,
    expectedRevision: 3,
    writer: writer(),
    controlState: 'cancelled',
  });

  expect(stale.kind).toBe('rejected');
  if (stale.kind === 'rejected') {
    expect(stale.code).toBe('stale_revision');
    expect(stale.currentRevision).toBe(4);
  }
  const result = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  if (result.kind === 'scope' && result.scope !== null) {
    expect(result.scope.controlState).toBe('paused');
    expect(result.scope.revision).toBe(4);
  }
});

test('未登记的命令形态被拒绝，库内状态不变', () => {
  createScope();
  activateSession();

  const unknown = store.transact({
    coordinationScopeId: SCOPE,
    expectedRevision: 3,
    writer: writer(),
    kind: 'record-git-head',
    head: 'deadbeef',
  } as unknown as CoordinationCommand);

  expect(unknown.kind).toBe('rejected');
  if (unknown.kind === 'rejected') {
    expect(unknown.code).toBe('invalid_state');
  }
  expect(revisionOf()).toBe(3);
});

test('库内只有共享协调事实的表，没有会话消息或图位置表', () => {
  createScope();

  const raw = new DatabaseSync(join(directory, 'coordination.sqlite'), { readOnly: true });
  const rows = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as readonly {
    readonly name: string;
  }[];
  raw.close();
  const names = rows.map((row) => row.name).filter((name) => !name.startsWith('sqlite_'));

  expect(new Set(names)).toEqual(new Set(COORDINATION_TABLES));
  expect(names.some((name) => /message|checkpoint|graph_position|contract/i.test(name))).toBe(false);
});

test('多表写入在同一事务内整体生效或整体回滚', () => {
  createScope();
  activateSession();

  // 成功路径同时写 ticket_claims 与 scope.revision。
  const claimed = submit((expectedRevision) => ({
    kind: 'record-ticket-claim',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(),
    ticketRef: { kind: 'decision_ticket', id: 'ticket-1' },
  }));
  expect(claimed).toEqual({ kind: 'committed', revision: 4 });
  const claimsAfterFirst = store.query({ kind: 'snapshot', coordinationScopeId: SCOPE });
  if (claimsAfterFirst.kind === 'snapshot') {
    expect(claimsAfterFirst.snapshot.ticketClaims).toHaveLength(1);
  }

  // 同一 ticket 的第二次活跃 claim 违反唯一约束：整体回滚，revision 不推进。
  const duplicate = submit((expectedRevision) => ({
    kind: 'record-ticket-claim',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(),
    ticketRef: { kind: 'decision_ticket', id: 'ticket-1' },
  }));
  expect(duplicate.kind).toBe('rejected');
  if (duplicate.kind === 'rejected') {
    expect(duplicate.code).toBe('constraint');
  }
  expect(revisionOf()).toBe(4);
  const claimsAfterSecond = store.query({ kind: 'snapshot', coordinationScopeId: SCOPE });
  if (claimsAfterSecond.kind === 'snapshot') {
    expect(claimsAfterSecond.snapshot.ticketClaims).toHaveLength(1);
  }
});

test('未声明的模式被拒绝且保留原有模式', () => {
  createScope();
  activateSession();

  const rejected = submit((expectedRevision) => ({
    kind: 'update-scope-mode',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(),
    mode: 'worker_coordination',
    planningCycleId: null,
  } as unknown as CoordinationCommand));

  expect(rejected.kind).toBe('rejected');
  if (rejected.kind === 'rejected') {
    expect(rejected.code).toBe('invalid_state');
  }
  expect(scopeMode()).toBe('route_planning');
  expect(revisionOf()).toBe(3);
});

test('暂停与取消只改变控制状态，不改变模式', () => {
  createScope();
  activateSession();

  for (const controlState of ['paused', 'cancelled'] as const) {
    const result = submit((expectedRevision) => ({
      kind: 'record-control-state',
      coordinationScopeId: SCOPE,
      expectedRevision,
      writer: writer(),
      controlState,
    }));
    expect(result.kind).toBe('committed');
    const scope = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
    if (scope.kind === 'scope' && scope.scope !== null) {
      expect(scope.scope.mode).toBe('route_planning');
      expect(scope.scope.controlState).toBe(controlState);
    }
  }
});

test('同一 Scope 内多个 Coordinator Session 的注册共存', () => {
  createScope();
  activateSession();

  for (const sessionId of [SESSION_A, SESSION_B]) {
    const result = submit((expectedRevision) => ({
      kind: 'register-session',
      coordinationScopeId: SCOPE,
      expectedRevision,
      writer: writer(),
      coordinatorSessionId: sessionId,
      coordinatorModelConfigurationRef: `profile-${sessionId}`,
      lifecycleState: 'registered',
    }));
    expect(result.kind).toBe('committed');
  }

  const sessions = store.query({ kind: 'sessions', coordinationScopeId: SCOPE });
  if (sessions.kind === 'sessions') {
    expect(sessions.sessions.map((session) => session.coordinatorSessionId)).toEqual([SESSION_A, SESSION_B]);
  }
});

test('同一 Session 注册到另一个 Scope 被拒绝', () => {
  createScope();
  activateSession();
  submit((expectedRevision) => ({
    kind: 'register-session',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(),
    coordinatorSessionId: SESSION_A,
    coordinatorModelConfigurationRef: 'profile-a',
    lifecycleState: 'registered',
  }));
  createScope(SCOPE_2);

  const crossScope = store.transact({
    kind: 'register-session',
    coordinationScopeId: SCOPE_2,
    expectedRevision: revisionOf(SCOPE_2),
    writer: writer(),
    coordinatorSessionId: SESSION_A,
    coordinatorModelConfigurationRef: 'profile-a',
    lifecycleState: 'registered',
  });

  expect(crossScope.kind).toBe('rejected');
  if (crossScope.kind === 'rejected') {
    expect(crossScope.code).toBe('constraint');
  }
  const sessions = store.query({ kind: 'sessions', coordinationScopeId: SCOPE_2 });
  if (sessions.kind === 'sessions') {
    expect(sessions.sessions).toHaveLength(0);
  }
});

test('已有 Runtime Lease 后，无 lease 的 Session 不能写共享状态', () => {
  createScope();
  activateSession();

  const unleased = store.transact({
    kind: 'record-control-state',
    coordinationScopeId: SCOPE,
    expectedRevision: revisionOf(),
    writer: {
      coordinatorSessionId: 'session-x' as CoordinatorSessionId,
      runtimeIncarnationId: 'fake-inc' as RuntimeIncarnationId,
      fencingGeneration: 999,
    },
    controlState: 'paused',
  });

  expect(unleased.kind).toBe('rejected');
  if (unleased.kind === 'rejected') {
    expect(unleased.code).toBe('fenced');
  }
  expect(scopeMode()).toBe('route_planning');
});

test('当前 schema 的数据库可以关闭后重开', () => {
  createScope();
  activateSession();
  const revision = revisionOf();

  store.close();
  const reopened = openCoordinationStore({ databasePath: join(directory, 'coordination.sqlite'), clock });
  if (reopened.kind !== 'opened') {
    throw new Error(reopened.message);
  }
  store = reopened.store;

  expect(revisionOf()).toBe(revision);
});

/**
 * Session Segment 是跨重启可读的前置事实（change: `m1-admit-work-package-specifications`，IP-A5）。
 *
 * 记录里不含 Recovery Budget 计数、Capsule 或替代 Segment：读回来的事实只回答「中断发生在哪里」，
 * 不构成任何恢复动作已经发生的证据。
 */
/** 两个新记录都是执行事实：写入者必须是 Execution Coordination Lease 持有者。 */
function acquireExecutionLease(): void {
  const acquired = store.transact({
    kind: 'acquire-execution-lease',
    coordinationScopeId: SCOPE,
    expectedRevision: revisionOf(),
    writer: writer(SESSION_A),
  });
  if (acquired.kind !== 'committed') {
    throw new Error(`无法取得测试 Execution Lease: ${acquired.message}`);
  }
}

test('Session Segment 在重启后仍可读取，且不带恢复副作用', () => {
  createScope();
  activateSession();
  acquireExecutionLease();
  const segmentId = 'segment-1' as SessionSegmentId;

  const recorded = submit((expectedRevision) => ({
    kind: 'record-session-segment',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(SESSION_A),
    segmentId,
    workPackageId: 'wp-1' as WorkPackageId,
    role: 'implementation',
    workerTaskId: 'task-1' as WorkerTaskId,
    dispatchId: 'dispatch-1' as DispatchId,
    attemptId: 'attempt-1',
    sessionBindingId: 'binding-1',
    lastTranscriptRef: 'transcript:12',
    terminalReceiptRef: 'receipt:1',
    transcriptReferenceable: true,
    verifiable: true,
  }));
  expect(recorded.kind).toBe('committed');

  store.close();
  const reopened = openCoordinationStore({ databasePath: join(directory, 'coordination.sqlite'), clock });
  if (reopened.kind !== 'opened') {
    throw new Error(reopened.message);
  }
  store = reopened.store;

  const read = store.query({ kind: 'session-segments', coordinationScopeId: SCOPE });
  expect(read.kind).toBe('session-segments');
  if (read.kind !== 'session-segments') {
    return;
  }
  expect(read.segments).toHaveLength(1);
  const segment = read.segments[0];
  expect(segment).toBeDefined();
  if (segment === undefined) {
    return;
  }
  expect(segment.segmentId).toBe(segmentId);
  expect(segment.role).toBe('implementation');
  expect(segment.workPackageId).toBe('wp-1');
  expect(segment.dispatchId).toBe('dispatch-1');
  expect(segment.transcriptReferenceable).toBe(true);
  // 记录里没有恢复预算、Capsule 或替代 Segment 字段。
  expect(Object.keys(segment)).not.toContain('recoveryBudget');
  expect(Object.keys(segment)).not.toContain('capsuleRef');
  expect(Object.keys(segment)).not.toContain('replacementSegmentId');

  // 同一 Segment 不能重复登记，也不产生第二条替代 Segment。
  const duplicate = submit((expectedRevision) => ({
    kind: 'record-session-segment',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(SESSION_A),
    segmentId,
    workPackageId: 'wp-1' as WorkPackageId,
    role: 'implementation',
    workerTaskId: 'task-1' as WorkerTaskId,
    dispatchId: 'dispatch-1' as DispatchId,
    attemptId: 'attempt-1',
    sessionBindingId: 'binding-1',
    lastTranscriptRef: 'transcript:13',
    terminalReceiptRef: null,
    transcriptReferenceable: true,
    verifiable: false,
  }));
  expect(duplicate.kind).toBe('rejected');
  expect(store.query({ kind: 'session-segments', coordinationScopeId: SCOPE })).toMatchObject({
    segments: [expect.objectContaining({ lastTranscriptRef: 'transcript:12' })],
  });
});

test('Materialization Binding 可按 Work Package 读回，并只保存最小索引', () => {
  createScope();
  activateSession();
  acquireExecutionLease();

  const recorded = submit((expectedRevision) => ({
    kind: 'record-materialization-binding',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(SESSION_A),
    workPackageId: 'wp-1' as WorkPackageId,
    orcaTaskId: 'task-1',
    creationOperationId: 'op-1' as OperationId,
  }));
  expect(recorded.kind).toBe('committed');

  const read = store.query({
    kind: 'materialization-bindings',
    coordinationScopeId: SCOPE,
    workPackageId: 'wp-1' as WorkPackageId,
  });
  expect(read.kind).toBe('materialization-bindings');
  if (read.kind !== 'materialization-bindings') {
    return;
  }
  expect(read.bindings).toHaveLength(1);
  expect(read.bindings[0]?.orcaTaskId).toBe('task-1');
  expect(read.bindings[0]?.creationOperationId).toBe('op-1');
  // 不复制 worktree 路径或 Orca Task 状态：绑定只保存最小索引。
  expect(Object.keys(read.bindings[0] ?? {})).not.toContain('worktreePath');
  expect(Object.keys(read.bindings[0] ?? {})).not.toContain('taskStatus');
});
