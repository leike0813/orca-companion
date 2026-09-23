import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, expect, test } from 'vitest';

import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  DispatchId,
  GraphGeneration,
  GraphId,
  GraphVersion,
  InteractionId,
  OperationId,
  PlanningCycleId,
  RecoveryId,
  RuntimeIncarnationId,
  SessionSegmentId,
  WorkerTaskId,
  WorkPackageId,
} from '../src/application/dto/identity.js';
import type {
  CoordinationCommand,
  CoordinationCommandResult,
  ExecutionHandoffPhase,
  RecoveryRecord,
  RecoveryState,
  RecoveryTerminalOutcome,
  ReplacementSegmentInput,
  SessionSegmentRecord,
} from '../src/application/ports/branch-coordination-store.js';
import { openCoordinationStore, type CoordinationStore } from '../src/adapters/storage/coordination-store.js';
import { COORDINATION_TABLES, MIGRATIONS, SCHEMA_VERSION } from '../src/adapters/storage/schema.js';

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
    fullBranchRef: `refs/heads/${scopeId}`,
    canonicalWorktreePath: `/tmp/orca-test-worktree/${scopeId}`,
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

test('Delivery 结算记录只保存去重键与结果引用，重放不产生第二行', () => {
  createScope();
  activateSession();
  acquireExecutionLease();

  const settlement = (expectedRevision: number): CoordinationCommand => ({
    kind: 'record-delivery-settlement',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(SESSION_A),
    dedupeKey: '["delivery-1","run-1",1,"wt-1","wt-1","attempt-1"]',
    deliveryId: 'delivery-1',
    runId: 'run-1',
    consumerGeneration: 1,
    workerTaskId: 'worker-task-1' as WorkerTaskId,
    dispatchId: 'dispatch-1' as DispatchId,
    attemptId: 'attempt-1',
    role: 'implementation',
    contractRevision: 3,
    orcaResultRef: 'orca-task-1#abc123',
  });

  expect(submit(settlement).kind).toBe('committed');
  const read = store.query({ kind: 'delivery-settlements', coordinationScopeId: SCOPE });
  expect(read.kind).toBe('delivery-settlements');
  if (read.kind !== 'delivery-settlements') {
    return;
  }
  expect(read.settlements).toHaveLength(1);
  expect(read.settlements[0]?.orcaResultRef).toBe('orca-task-1#abc123');
  expect(read.settlements[0]?.role).toBe('implementation');
  // Accepted Worker Result 正文只归 Orca：本地记录里没有正文列。
  expect(Object.keys(read.settlements[0] ?? {})).not.toContain('result');
  expect(Object.keys(read.settlements[0] ?? {})).not.toContain('body');

  // 重放同一个 Delivery 身份被唯一约束拒绝；调用方回读既有记录而不是写出第二行。
  const replayed = submit(settlement);
  expect(replayed.kind).toBe('rejected');
  const after = store.query({ kind: 'delivery-settlements', coordinationScopeId: SCOPE });
  expect(after.kind === 'delivery-settlements' ? after.settlements : []).toHaveLength(1);

  // 同一组局部 ID 在新 Run / consumer generation 中是另一条合法身份。
  const nextGeneration = submit((expectedRevision) => ({
    ...settlement(expectedRevision),
    dedupeKey: '["delivery-1","run-2",2,"worker-task-1","dispatch-1","attempt-1"]',
    runId: 'run-2',
    consumerGeneration: 2,
    orcaResultRef: 'orca-task-1#def456',
  }));
  expect(nextGeneration.kind).toBe('committed');
});

test('Delivery Verdict 追加记录并保持确定顺序', () => {
  createScope();
  activateSession();
  acquireExecutionLease();

  const blocked = submit((expectedRevision) => ({
    kind: 'record-delivery-verdict',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(SESSION_A),
    verdictId: 'verdict-1',
    verdict: { kind: 'blocked', blockerRefs: ['blocker-1'] },
    finalizerRole: 'finalizer',
    sessionBindingRef: 'session-binding-1',
  }));
  expect(blocked.kind).toBe('committed');

  const deliverable = submit((expectedRevision) => ({
    kind: 'record-delivery-verdict',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(SESSION_A),
    verdictId: 'verdict-2',
    verdict: { kind: 'deliverable', evidenceRefs: ['orca-task-1#abc123'] },
    finalizerRole: 'finalizer',
    sessionBindingRef: 'session-binding-2',
  }));
  expect(deliverable.kind).toBe('committed');

  const read = store.query({ kind: 'delivery-verdicts', coordinationScopeId: SCOPE });
  expect(read.kind).toBe('delivery-verdicts');
  if (read.kind !== 'delivery-verdicts') {
    return;
  }
  expect(read.verdicts.map((verdict) => verdict.verdictId)).toEqual(['verdict-1', 'verdict-2']);
  expect(read.verdicts.map((verdict) => verdict.verdictSequence)).toEqual([1, 2]);
  expect(read.verdicts[1]?.verdict).toEqual({ kind: 'deliverable', evidenceRefs: ['orca-task-1#abc123'] });
});

/**
 * IP-3：Worker Session Recovery 与 Execution Handoff 的持久化往返。
 *
 * 断言只覆盖稳定行为：同一来源事实不产生第二行、非法迁移被拒绝、预算按 Worker Attempt 求和、
 * 提案级 CAS 生效，以及 migration 保留前驱数据。
 */
function recoveryCommand(
  expectedRevision: number,
  recoveryId: string,
  sourceSegmentId: string,
  businessAttemptId = 'attempt-1',
): CoordinationCommand {
  return {
    kind: 'record-recovery',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(SESSION_A),
    recoveryId: recoveryId as RecoveryId,
    role: 'validator',
    workPackageId: 'wp-1' as WorkPackageId,
    workerTaskId: 'task-1' as WorkerTaskId,
    businessAttemptId,
    sourceSegmentId: sourceSegmentId as SessionSegmentId,
    sourceDispatchId: 'dispatch-1' as DispatchId,
  };
}

type AdvanceRecoveryFields = {
  readonly status: RecoveryState;
  readonly replacementDispatchId?: string;
  readonly replacementSegmentId?: SessionSegmentId;
  readonly replacementSessionBindingId?: string;
  readonly consumedBudget?: number;
  readonly capsuleRef?: string;
  readonly terminalOutcome?: RecoveryTerminalOutcome | null;
  readonly blockingReason?: string | null;
  readonly replacementSegment?: ReplacementSegmentInput;
};

function advanceRecovery(
  recoveryId: string,
  fields: AdvanceRecoveryFields,
): CoordinationCommandResult {
  return store.transact({
    kind: 'advance-recovery',
    coordinationScopeId: SCOPE,
    expectedRevision: revisionOf(),
    writer: writer(SESSION_A),
    recoveryId: recoveryId as RecoveryId,
    ...fields,
  });
}

function handoffCommand(
  expectedRevision: number,
  expectedHandoffRevision: number | null,
  phase: ExecutionHandoffPhase,
  capsuleRef: string | null = 'capsule-1',
): CoordinationCommand {
  return {
    kind: 'record-execution-handoff',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(SESSION_A),
    handoffId: 'handoff-1',
    sourceSessionId: SESSION_A,
    targetSessionId: SESSION_B,
    graphGeneration: 1 as GraphGeneration,
    responsibilitySet: ['execution_coordination_lease', 'pending_interactions'],
    phase,
    coordinatorContextCapsuleRef: capsuleRef,
    expectedHandoffRevision,
  };
}

test('Recovery 从确定性初值创建，同一中断 Segment 只允许一个 Recovery', () => {
  createScope();
  activateSession();
  acquireExecutionLease();

  expect(submit((expectedRevision) => recoveryCommand(expectedRevision, 'recovery-1', 'segment-1')).kind).toBe(
    'committed',
  );

  const read = store.query({
    kind: 'recovery',
    coordinationScopeId: SCOPE,
    recoveryId: 'recovery-1' as RecoveryId,
  });
  expect(read.kind).toBe('recovery');
  if (read.kind !== 'recovery' || read.recovery === null) {
    return;
  }
  expect(read.recovery.status).toBe('pending');
  expect(read.recovery.consumedBudget).toBe(0);
  expect(read.recovery.terminalOutcome).toBeNull();
  expect(read.recovery.replacementDispatchId).toBeNull();
  expect(read.recovery.businessAttemptId).toBe('attempt-1');

  // 同一条 source segment 换一个 RecoveryId 重放：被唯一约束拒绝，不产生第二行。
  const replayed = submit((expectedRevision) =>
    recoveryCommand(expectedRevision, 'recovery-2', 'segment-1'),
  );
  expect(replayed.kind).toBe('rejected');
  if (replayed.kind === 'rejected') {
    expect(replayed.code).toBe('constraint');
  }
  const all = store.query({ kind: 'recoveries', coordinationScopeId: SCOPE });
  expect(all.kind === 'recoveries' ? all.recoveries : []).toHaveLength(1);
});

test('Recovery 非法状态迁移被拒绝，合法推进保留替代派发与终态结果', () => {
  createScope();
  activateSession();
  acquireExecutionLease();
  submit((expectedRevision) => recoveryCommand(expectedRevision, 'recovery-1', 'segment-1'));

  // 跳过 recovering 直接终结：迁移非法。
  const skipped = advanceRecovery('recovery-1', { status: 'recovered', terminalOutcome: 'replaced' });
  expect(skipped.kind).toBe('rejected');
  if (skipped.kind === 'rejected') {
    expect(skipped.code).toBe('invalid_state');
  }

  // 创建替代 Segment 即消耗一次 Recovery Budget，并回写替代派发。
  const recovering = advanceRecovery('recovery-1', {
    status: 'recovering',
    replacementDispatchId: 'dispatch-2',
    replacementSegmentId: 'segment-2' as SessionSegmentId,
    consumedBudget: 1,
  });
  expect(recovering.kind).toBe('committed');

  // recovered 必须带终态结果，否则记录不可读。
  const missingOutcome = advanceRecovery('recovery-1', { status: 'recovered' });
  expect(missingOutcome.kind).toBe('rejected');
  if (missingOutcome.kind === 'rejected') {
    expect(missingOutcome.code).toBe('invalid_state');
  }

  const recovered = advanceRecovery('recovery-1', { status: 'recovered', terminalOutcome: 'replaced' });
  expect(recovered.kind).toBe('committed');

  // 终态不再接受推进。
  const afterTerminal = advanceRecovery('recovery-1', { status: 'blocked', terminalOutcome: 'failed' });
  expect(afterTerminal.kind).toBe('rejected');
  if (afterTerminal.kind === 'rejected') {
    expect(afterTerminal.code).toBe('invalid_state');
  }

  const read = store.query({
    kind: 'recovery',
    coordinationScopeId: SCOPE,
    recoveryId: 'recovery-1' as RecoveryId,
  });
  if (read.kind === 'recovery' && read.recovery !== null) {
    expect(read.recovery.status).toBe('recovered');
    expect(read.recovery.terminalOutcome).toBe('replaced');
    expect(read.recovery.replacementDispatchId).toBe('dispatch-2');
    expect(read.recovery.replacementSegmentId).toBe('segment-2');
    expect(read.recovery.consumedBudget).toBe(1);
  }
});

test('Recovery 从 blocked 继续时清空上一次失败结论', () => {
  createScope();
  activateSession();
  acquireExecutionLease();
  submit((expectedRevision) => recoveryCommand(expectedRevision, 'recovery-1', 'segment-1'));

  advanceRecovery('recovery-1', {
    status: 'blocked',
    terminalOutcome: 'failed',
    blockingReason: 'Recovery Budget 已达上限',
  });
  const blocked = store.query({
    kind: 'recovery',
    coordinationScopeId: SCOPE,
    recoveryId: 'recovery-1' as RecoveryId,
  });
  if (blocked.kind === 'recovery' && blocked.recovery !== null) {
    expect(blocked.recovery.status).toBe('blocked');
    expect(blocked.recovery.terminalOutcome).toBe('failed');
    expect(blocked.recovery.blockingReason).toBe('Recovery Budget 已达上限');
  }

  // 用户补充事实后继续：旧的 failed 结论不再成立。
  const resumed = advanceRecovery('recovery-1', { status: 'recovering' });
  expect(resumed.kind).toBe('committed');
  const after = store.query({
    kind: 'recovery',
    coordinationScopeId: SCOPE,
    recoveryId: 'recovery-1' as RecoveryId,
  });
  if (after.kind === 'recovery' && after.recovery !== null) {
    expect(after.recovery.status).toBe('recovering');
    expect(after.recovery.terminalOutcome).toBeNull();
    expect(after.recovery.blockingReason).toBeNull();
  }
});

test('Recovery Budget 按 Worker Attempt 求和，续办不重置既有计数', () => {
  createScope();
  activateSession();
  acquireExecutionLease();

  // 同一个 Worker Attempt 的两次 Recovery 各消耗一次。
  for (const [index, recoveryId] of ['recovery-1', 'recovery-2'].entries()) {
    submit((expectedRevision) => recoveryCommand(expectedRevision, recoveryId, `segment-${index + 1}`));
    const advanced = advanceRecovery(recoveryId, {
      status: 'recovering',
      replacementDispatchId: `dispatch-${index + 2}`,
      consumedBudget: 1,
    });
    expect(advanced.kind).toBe('committed');
  }
  // 另一个 Worker Attempt 独立计数。
  submit((expectedRevision) => recoveryCommand(expectedRevision, 'recovery-3', 'segment-3', 'attempt-2'));
  advanceRecovery('recovery-3', { status: 'recovering', consumedBudget: 1 });

  const forAttempt = store.query({
    kind: 'recoveries',
    coordinationScopeId: SCOPE,
    businessAttemptId: 'attempt-1',
  });
  expect(forAttempt.kind).toBe('recoveries');
  if (forAttempt.kind !== 'recoveries') {
    return;
  }
  expect(forAttempt.recoveries).toHaveLength(2);
  expect(forAttempt.recoveries.reduce((total, recovery) => total + recovery.consumedBudget, 0)).toBe(2);

  // 同一 Recovery 续办（重复写入同样的消耗值）不改变求和结果。
  const resumed = advanceRecovery('recovery-1', { status: 'blocked', consumedBudget: 1 });
  expect(resumed.kind).toBe('committed');
  const afterResume = store.query({
    kind: 'recoveries',
    coordinationScopeId: SCOPE,
    businessAttemptId: 'attempt-1',
  });
  if (afterResume.kind === 'recoveries') {
    expect(afterResume.recoveries.reduce((total, recovery) => total + recovery.consumedBudget, 0)).toBe(2);
  }
});

test('Execution Handoff 用提案级 revision 做 CAS，阶段迁移非法时拒绝', () => {
  createScope();
  activateSession();
  acquireExecutionLease();

  const created = submit((expectedRevision) => handoffCommand(expectedRevision, null, 'prepared'));
  expect(created.kind).toBe('committed');

  const read = store.query({ kind: 'execution-handoff', coordinationScopeId: SCOPE, handoffId: 'handoff-1' });
  expect(read.kind).toBe('execution-handoff');
  if (read.kind !== 'execution-handoff' || read.handoff === null) {
    return;
  }
  expect(read.handoff.handoffRevision).toBe(1);
  expect(read.handoff.phase).toBe('prepared');
  expect(read.handoff.responsibilitySet).toEqual([
    'execution_coordination_lease',
    'pending_interactions',
  ]);
  // 记录写下之后生效的执行态 revision，与提案级 CAS（handoffRevision）分离。
  expect(read.handoff.expectedRevision).toBe(revisionOf());

  // 重复创建同一 handoffId 被约束拒绝。
  const duplicated = submit((expectedRevision) => handoffCommand(expectedRevision, null, 'prepared'));
  expect(duplicated.kind).toBe('rejected');
  if (duplicated.kind === 'rejected') {
    expect(duplicated.code).toBe('constraint');
  }

  // 过期的提案 revision 被拒绝。
  const staleCas = submit((expectedRevision) =>
    handoffCommand(expectedRevision, 99, 'reviewed'),
  );
  expect(staleCas.kind).toBe('rejected');
  if (staleCas.kind === 'rejected') {
    expect(staleCas.code).toBe('constraint');
  }

  // prepared 直接 cutover 不是合法迁移。
  const premature = submit((expectedRevision) =>
    handoffCommand(expectedRevision, 1, 'cutover'),
  );
  expect(premature.kind).toBe('rejected');
  if (premature.kind === 'rejected') {
    expect(premature.code).toBe('invalid_state');
  }

  const reviewed = submit((expectedRevision) => handoffCommand(expectedRevision, 1, 'reviewed'));
  expect(reviewed.kind).toBe('committed');

  // blocked 必须给出原因，否则 blocker 不可观测。
  const blockedWithoutReason = store.transact({
    kind: 'advance-execution-handoff',
    coordinationScopeId: SCOPE,
    expectedRevision: revisionOf(),
    writer: writer(SESSION_A),
    handoffId: 'handoff-1',
    phase: 'blocked',
    expectedHandoffRevision: 2,
  });
  expect(blockedWithoutReason.kind).toBe('rejected');
  if (blockedWithoutReason.kind === 'rejected') {
    expect(blockedWithoutReason.code).toBe('invalid_state');
  }

  const blocked = store.transact({
    kind: 'advance-execution-handoff',
    coordinationScopeId: SCOPE,
    expectedRevision: revisionOf(),
    writer: writer(SESSION_A),
    handoffId: 'handoff-1',
    phase: 'blocked',
    expectedHandoffRevision: 2,
    blockingReason: 'Source checkpoint 不可恢复',
  });
  expect(blocked.kind).toBe('committed');

  const afterBlock = store.query({
    kind: 'execution-handoff',
    coordinationScopeId: SCOPE,
    handoffId: 'handoff-1',
  });
  if (afterBlock.kind === 'execution-handoff' && afterBlock.handoff !== null) {
    expect(afterBlock.handoff.phase).toBe('blocked');
    expect(afterBlock.handoff.blockingReason).toBe('Source checkpoint 不可恢复');
    expect(afterBlock.handoff.handoffRevision).toBe(3);
  }

  // 从 blocked 回到 reviewed 会清空旧的阻塞原因。
  const retried = store.transact({
    kind: 'advance-execution-handoff',
    coordinationScopeId: SCOPE,
    expectedRevision: revisionOf(),
    writer: writer(SESSION_A),
    handoffId: 'handoff-1',
    phase: 'reviewed',
    expectedHandoffRevision: 3,
  });
  expect(retried.kind).toBe('committed');

  const snapshot = store.query({ kind: 'snapshot', coordinationScopeId: SCOPE });
  if (snapshot.kind === 'snapshot') {
    expect(snapshot.snapshot.executionHandoffs).toHaveLength(1);
    expect(snapshot.snapshot.executionHandoffs[0]?.blockingReason).toBeNull();
    expect(snapshot.snapshot.recoveries).toHaveLength(0);
    expect(snapshot.snapshot.mutationLanes).toHaveLength(0);
  }
});

/** 当前未释放的 Execution Coordination Lease 持有者与 generation；没有则为 null / 0。 */
function activeExecutionLease(): { readonly holder: CoordinatorSessionId | null; readonly generation: number } {
  const leases = store.query({ kind: 'leases', coordinationScopeId: SCOPE });
  const active =
    leases.kind === 'leases'
      ? leases.leases.find((lease) => lease.kind === 'execution_coordination' && lease.releasedAt === null)
      : undefined;
  return { holder: active?.coordinatorSessionId ?? null, generation: active?.fencingGeneration ?? 0 };
}

function interactionOwner(interactionId: string): CoordinatorSessionId | null {
  const snapshot = store.query({ kind: 'snapshot', coordinationScopeId: SCOPE });
  if (snapshot.kind !== 'snapshot') {
    return null;
  }
  const found = snapshot.snapshot.pendingInteractions.find(
    (interaction) => interaction.interactionId === interactionId,
  );
  return found?.ownerCoordinatorSessionId ?? null;
}

function recordOpenInteraction(interactionId: string, owner: CoordinatorSessionId): void {
  const recorded = submit((expectedRevision) => ({
    kind: 'record-pending-interaction',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(SESSION_A),
    interactionId: interactionId as InteractionId,
    ownerCoordinatorSessionId: owner,
    subjectRef: { kind: 'work_package', id: 'wp-1' },
  }));
  if (recorded.kind !== 'committed') {
    throw new Error(`无法登记 Pending Interaction: ${recorded.message}`);
  }
}

function answerInteraction(interactionId: string): void {
  const resolved = submit((expectedRevision) => ({
    kind: 'resolve-pending-interaction',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(SESSION_A),
    interactionId: interactionId as InteractionId,
    state: 'answered',
    answerRef: { kind: 'user_answer', id: 'answer-1' },
    answerText: '继续',
  }));
  if (resolved.kind !== 'committed') {
    throw new Error(`无法回答 Pending Interaction: ${resolved.message}`);
  }
}

function cutoverHandoff(expectedRevision: number, expectedHandoffRevision: number): CoordinationCommandResult {
  return store.transact({
    kind: 'advance-execution-handoff',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(SESSION_A),
    handoffId: 'handoff-1',
    phase: 'cutover',
    expectedHandoffRevision,
  });
}

test('cutover 在一次调用内转移 Execution Lease 与 open interaction 责任', () => {
  createScope();
  activateSession();
  acquireExecutionLease();
  recordOpenInteraction('interaction-open', SESSION_A);
  recordOpenInteraction('interaction-answered', SESSION_A);
  answerInteraction('interaction-answered');

  submit((expectedRevision) => handoffCommand(expectedRevision, null, 'prepared'));
  submit((expectedRevision) => handoffCommand(expectedRevision, 1, 'reviewed'));
  const before = activeExecutionLease();
  expect(before.holder).toBe(SESSION_A);

  const cutover = cutoverHandoff(revisionOf(), 2);
  expect(cutover.kind).toBe('committed');

  // 单次调用之内：Source 不再持有，Target 持有，generation 单调推进。
  const after = activeExecutionLease();
  expect(after.holder).toBe(SESSION_B);
  expect(after.generation).toBeGreaterThan(before.generation);
  // open 的责任随执行责任转给 Target；已回答的历史不动。
  expect(interactionOwner('interaction-open')).toBe(SESSION_B);
  expect(interactionOwner('interaction-answered')).toBe(SESSION_A);

  const handoff = store.query({ kind: 'execution-handoff', coordinationScopeId: SCOPE, handoffId: 'handoff-1' });
  if (handoff.kind === 'execution-handoff' && handoff.handoff !== null) {
    expect(handoff.handoff.phase).toBe('cutover');
    expect(handoff.handoff.handoffRevision).toBe(3);
  }
});

test('cutover 重放不会产生第二次转移', () => {
  createScope();
  activateSession();
  acquireExecutionLease();
  recordOpenInteraction('interaction-open', SESSION_A);
  submit((expectedRevision) => handoffCommand(expectedRevision, null, 'prepared'));
  submit((expectedRevision) => handoffCommand(expectedRevision, 1, 'reviewed'));
  expect(cutoverHandoff(revisionOf(), 2).kind).toBe('committed');
  const afterCutover = activeExecutionLease();
  expect(afterCutover.holder).toBe(SESSION_B);

  // 同一份输入重放：阶段已是终态，整笔拒绝，租约不再次变动。
  const replayed = cutoverHandoff(revisionOf(), 2);
  expect(replayed.kind).toBe('rejected');
  const afterReplay = activeExecutionLease();
  expect(afterReplay.holder).toBe(SESSION_B);
  expect(afterReplay.generation).toBe(afterCutover.generation);
  expect(interactionOwner('interaction-open')).toBe(SESSION_B);
});

test('cutover 的过期守卫整笔拒绝，lease 与 interaction 均无变化', () => {
  createScope();
  activateSession();
  acquireExecutionLease();
  recordOpenInteraction('interaction-open', SESSION_A);
  submit((expectedRevision) => handoffCommand(expectedRevision, null, 'prepared'));
  submit((expectedRevision) => handoffCommand(expectedRevision, 1, 'reviewed'));
  const before = activeExecutionLease();
  const revisionAfterReview = revisionOf();

  // 提案级 CAS 过期。
  const staleHandoffRevision = cutoverHandoff(revisionAfterReview, 1);
  expect(staleHandoffRevision.kind).toBe('rejected');
  if (staleHandoffRevision.kind === 'rejected') {
    expect(staleHandoffRevision.code).toBe('constraint');
  }
  expect(activeExecutionLease()).toEqual(before);
  expect(interactionOwner('interaction-open')).toBe(SESSION_A);

  // review 之后有其它写入：基础 CAS 用最新 revision 可以通过，但提案的 expectedRevision 已经
  // 落后，因此 cutover 仍被守卫拒绝，且不能出现「lease 转了但 phase 没转」。
  submit((expectedRevision) => ({
    kind: 'record-control-state',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(SESSION_A),
    controlState: 'paused',
  }));
  const interveningWrite = cutoverHandoff(revisionOf(), 2);
  expect(interveningWrite.kind).toBe('rejected');
  if (interveningWrite.kind === 'rejected') {
    expect(interveningWrite.code).toBe('constraint');
  }
  expect(activeExecutionLease()).toEqual(before);
  expect(interactionOwner('interaction-open')).toBe(SESSION_A);
  const handoff = store.query({ kind: 'execution-handoff', coordinationScopeId: SCOPE, handoffId: 'handoff-1' });
  if (handoff.kind === 'execution-handoff' && handoff.handoff !== null) {
    expect(handoff.handoff.phase).toBe('reviewed');
    expect(handoff.handoff.handoffRevision).toBe(2);
  }

  // 重放同一份被拒输入：仍然零副作用。
  const replayed = cutoverHandoff(revisionOf(), 2);
  expect(replayed.kind).toBe('rejected');
  expect(activeExecutionLease()).toEqual(before);
  expect(interactionOwner('interaction-open')).toBe(SESSION_A);
});

test('Recovery 已消耗预算不回退', () => {
  createScope();
  activateSession();
  acquireExecutionLease();
  submit((expectedRevision) => recoveryCommand(expectedRevision, 'recovery-1', 'segment-1'));
  expect(
    advanceRecovery('recovery-1', { status: 'recovering', consumedBudget: 1, capsuleRef: 'capsule-1' }).kind,
  ).toBe('committed');

  // 传入更小的值不可能把已消耗量调回去；省略的 set-once 字段保持原值。
  expect(advanceRecovery('recovery-1', { status: 'blocked', consumedBudget: 0 }).kind).toBe('committed');
  const afterLower = store.query({
    kind: 'recovery',
    coordinationScopeId: SCOPE,
    recoveryId: 'recovery-1' as RecoveryId,
  });
  if (afterLower.kind === 'recovery' && afterLower.recovery !== null) {
    expect(afterLower.recovery.consumedBudget).toBe(1);
    expect(afterLower.recovery.capsuleRef).toBe('capsule-1');
  }

  // 重放同值仍然幂等。
  expect(advanceRecovery('recovery-1', { status: 'recovering', consumedBudget: 1 }).kind).toBe('committed');
  const afterReplay = store.query({
    kind: 'recovery',
    coordinationScopeId: SCOPE,
    recoveryId: 'recovery-1' as RecoveryId,
  });
  if (afterReplay.kind === 'recovery' && afterReplay.recovery !== null) {
    expect(afterReplay.recovery.consumedBudget).toBe(1);
    expect(afterReplay.recovery.capsuleRef).toBe('capsule-1');
  }
});

test('review 走 advance-execution-handoff 时 cutover 守卫同样成立', () => {
  createScope();
  activateSession();
  acquireExecutionLease();
  submit((expectedRevision) => handoffCommand(expectedRevision, null, 'prepared'));

  const reviewed = store.transact({
    kind: 'advance-execution-handoff',
    coordinationScopeId: SCOPE,
    expectedRevision: revisionOf(),
    writer: writer(SESSION_A),
    handoffId: 'handoff-1',
    phase: 'reviewed',
    expectedHandoffRevision: 1,
  });
  expect(reviewed.kind).toBe('committed');

  // 两条写入路径都让记录的 expectedRevision 跟上当前 scope.revision。
  const handoff = store.query({ kind: 'execution-handoff', coordinationScopeId: SCOPE, handoffId: 'handoff-1' });
  if (handoff.kind === 'execution-handoff' && handoff.handoff !== null) {
    expect(handoff.handoff.expectedRevision).toBe(revisionOf());
  }

  expect(cutoverHandoff(revisionOf(), 2).kind).toBe('committed');
  expect(activeExecutionLease().holder).toBe(SESSION_B);
});

function recoveryOf(recoveryId: string): RecoveryRecord | null {
  const result = store.query({
    kind: 'recovery',
    coordinationScopeId: SCOPE,
    recoveryId: recoveryId as RecoveryId,
  });
  return result.kind === 'recovery' ? result.recovery : null;
}

function segmentsOf(): readonly SessionSegmentRecord[] {
  const result = store.query({ kind: 'session-segments', coordinationScopeId: SCOPE });
  return result.kind === 'session-segments' ? result.segments : [];
}

/** 替代 Session Segment：保留原 Worker Task、业务 Attempt 与角色，只换 Dispatch/Binding/Segment。 */
const REPLACEMENT_SEGMENT = {
  segmentId: 'segment-2' as SessionSegmentId,
  workPackageId: 'wp-1' as WorkPackageId,
  role: 'validator',
  workerTaskId: 'task-1' as WorkerTaskId,
  dispatchId: 'dispatch-2' as DispatchId,
  attemptId: 'attempt-1',
  sessionBindingId: 'binding-2',
  lastTranscriptRef: 'transcript:20',
  terminalReceiptRef: null,
  transcriptReferenceable: true,
  verifiable: true,
} satisfies ReplacementSegmentInput;

function recordSessionSegmentCommand(
  expectedRevision: number,
  segment: ReplacementSegmentInput,
): CoordinationCommand {
  return {
    kind: 'record-session-segment',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(SESSION_A),
    segmentId: segment.segmentId,
    workPackageId: segment.workPackageId,
    role: segment.role,
    workerTaskId: segment.workerTaskId,
    dispatchId: segment.dispatchId,
    attemptId: segment.attemptId,
    sessionBindingId: segment.sessionBindingId,
    lastTranscriptRef: segment.lastTranscriptRef,
    terminalReceiptRef: segment.terminalReceiptRef,
    transcriptReferenceable: segment.transcriptReferenceable,
    verifiable: segment.verifiable,
  };
}

test('带 replacementSegment 的一次调用同时写入替代 Segment 与 Recovery 收尾', () => {
  createScope();
  activateSession();
  acquireExecutionLease();
  submit((expectedRevision) => recoveryCommand(expectedRevision, 'recovery-1', 'segment-1'));
  advanceRecovery('recovery-1', { status: 'recovering', replacementDispatchId: 'dispatch-2' });

  const concluded = advanceRecovery('recovery-1', {
    status: 'recovered',
    terminalOutcome: 'replaced',
    consumedBudget: 1,
    replacementSegmentId: REPLACEMENT_SEGMENT.segmentId,
    replacementSessionBindingId: REPLACEMENT_SEGMENT.sessionBindingId,
    replacementSegment: REPLACEMENT_SEGMENT,
  });
  expect(concluded.kind).toBe('committed');

  const recovery = recoveryOf('recovery-1');
  expect(recovery?.status).toBe('recovered');
  expect(recovery?.terminalOutcome).toBe('replaced');
  expect(recovery?.consumedBudget).toBe(1);
  expect(recovery?.replacementSegmentId).toBe('segment-2');

  const segments = segmentsOf();
  expect(segments).toHaveLength(1);
  expect(segments[0]?.segmentId).toBe('segment-2');
  expect(segments[0]?.dispatchId).toBe('dispatch-2');
  expect(segments[0]?.attemptId).toBe('attempt-1');
  expect(segments[0]?.verifiable).toBe(true);
});

test('replacementSegment 与既有 Segment 冲突时整笔回滚', () => {
  createScope();
  activateSession();
  acquireExecutionLease();
  submit((expectedRevision) => recoveryCommand(expectedRevision, 'recovery-1', 'segment-1'));
  advanceRecovery('recovery-1', { status: 'recovering', consumedBudget: 1 });

  // 同 segmentId 但内容不同（Dispatch 不同）：内容不一致必须拒绝覆盖。
  const conflicting: ReplacementSegmentInput = { ...REPLACEMENT_SEGMENT, dispatchId: 'dispatch-9' as DispatchId };
  const recorded = submit((expectedRevision) => recordSessionSegmentCommand(expectedRevision, conflicting));
  expect(recorded.kind).toBe('committed');

  const rejected = advanceRecovery('recovery-1', {
    status: 'recovered',
    terminalOutcome: 'replaced',
    consumedBudget: 5,
    replacementSegmentId: REPLACEMENT_SEGMENT.segmentId,
    replacementSegment: REPLACEMENT_SEGMENT,
  });
  expect(rejected.kind).toBe('rejected');
  if (rejected.kind === 'rejected') {
    expect(rejected.code).toBe('constraint');
  }

  // 整笔回滚：Recovery 行完全不变，既有 Segment 不被改写，也不新增行。
  const recovery = recoveryOf('recovery-1');
  expect(recovery?.status).toBe('recovering');
  expect(recovery?.terminalOutcome).toBeNull();
  expect(recovery?.consumedBudget).toBe(1);
  expect(recovery?.replacementSegmentId).toBeNull();
  const segments = segmentsOf();
  expect(segments).toHaveLength(1);
  expect(segments[0]?.dispatchId).toBe('dispatch-9');
});

test('替代 Segment 已存在且一致时重放仍能收尾，且不产生第二行', () => {
  createScope();
  activateSession();
  acquireExecutionLease();
  submit((expectedRevision) => recoveryCommand(expectedRevision, 'recovery-1', 'segment-1'));
  advanceRecovery('recovery-1', { status: 'recovering', consumedBudget: 1 });

  // 崩溃窗口：替代 Segment 已落盘，Recovery 还没收尾。
  const recorded = submit((expectedRevision) =>
    recordSessionSegmentCommand(expectedRevision, REPLACEMENT_SEGMENT),
  );
  expect(recorded.kind).toBe('committed');

  const conclusion = {
    status: 'recovered',
    terminalOutcome: 'replaced',
    consumedBudget: 1,
    replacementSegmentId: REPLACEMENT_SEGMENT.segmentId,
    replacementSegment: REPLACEMENT_SEGMENT,
  } as const;
  const concluded = advanceRecovery('recovery-1', conclusion);
  expect(concluded.kind).toBe('committed');
  expect(segmentsOf()).toHaveLength(1);
  expect(recoveryOf('recovery-1')?.consumedBudget).toBe(1);

  // 已收尾后重放同一条命令：状态迁移已不合法，零副作用——不产生第二行、预算不回退也不重复增加。
  const replayed = advanceRecovery('recovery-1', conclusion);
  expect(replayed.kind).toBe('rejected');
  if (replayed.kind === 'rejected') {
    expect(replayed.code).toBe('invalid_state');
  }
  expect(segmentsOf()).toHaveLength(1);
  expect(recoveryOf('recovery-1')?.consumedBudget).toBe(1);
});

test('带 replacementSegment 但目标状态不是 recovered 时拒绝且零副作用', () => {
  createScope();
  activateSession();
  acquireExecutionLease();
  submit((expectedRevision) => recoveryCommand(expectedRevision, 'recovery-1', 'segment-1'));

  const rejected = advanceRecovery('recovery-1', {
    status: 'recovering',
    replacementSegment: REPLACEMENT_SEGMENT,
  });
  expect(rejected.kind).toBe('rejected');
  if (rejected.kind === 'rejected') {
    expect(rejected.code).toBe('invalid_state');
  }

  const recovery = recoveryOf('recovery-1');
  expect(recovery?.status).toBe('pending');
  expect(recovery?.consumedBudget).toBe(0);
  expect(recovery?.replacementSegmentId).toBeNull();
  expect(segmentsOf()).toHaveLength(0);
});

test('migration v6 → v7 保留既有数据并补齐新表', () => {
  const databasePath = join(directory, 'coordination-v6.sqlite');

  // 只用 v6 及更早的 migration 建库，写入若干前驱事实，模拟真实旧库。
  const legacy = new DatabaseSync(databasePath);
  legacy.exec('BEGIN IMMEDIATE');
  for (const migration of MIGRATIONS) {
    if (migration.version > 6) {
      continue;
    }
    for (const statement of migration.statements) {
      legacy.exec(statement);
    }
  }
  legacy
    .prepare(
      `INSERT INTO scope (
         coordination_scope_id, mode, control_state, planning_cycle_id, graph_id, graph_version,
         authorization_id, authorization_version, map_revision, revision, updated_at
       ) VALUES (?, 'route_planning', 'active', 'cycle-1', NULL, NULL, NULL, NULL, 0, 4, 1)`,
    )
    .run('scope-migrated');
  legacy
    .prepare(
      `INSERT INTO operation_intents (
         coordination_scope_id, operation_id, target_kind, target_id, operation_category, lane_key,
         initiated_by_session_id, initiated_by_incarnation_id, expected_revision, state, outcome_class,
         backend_request_id, blocking_reason, created_at, settled_at, expected_head
       ) VALUES (?, 'op-legacy', 'work_package', 'wp-1', 'task-create', ?, 'session-a', 'inc-1', 3,
                 'blocked', NULL, NULL, 'legacy reason', 1, NULL, NULL)`,
    )
    .run('scope-migrated', JSON.stringify(['work_package', 'wp-1', 'task-create']));
  legacy
    .prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', '6')`)
    .run();
  legacy.exec('COMMIT');
  legacy.close();

  const migrated = openCoordinationStore({ databasePath, clock });
  if (migrated.kind !== 'opened') {
    throw new Error(migrated.message);
  }
  try {
    const scopeId = 'scope-migrated' as CoordinationScopeId;
    const scope = migrated.store.query({ kind: 'scope', coordinationScopeId: scopeId });
    expect(scope.kind === 'scope' ? scope.scope?.revision : null).toBe(4);

    const intents = migrated.store.query({ kind: 'intents', coordinationScopeId: scopeId });
    if (intents.kind === 'intents') {
      expect(intents.intents).toHaveLength(1);
      expect(intents.intents[0]?.blockingReason).toBe('legacy reason');
      expect(intents.intents[0]?.laneKey).toBe(JSON.stringify(['work_package', 'wp-1', 'task-create']));
    }

    // 新表已建立且为空；旧记录没有被重建或丢失。
    const recoveries = migrated.store.query({ kind: 'recoveries', coordinationScopeId: scopeId });
    expect(recoveries.kind === 'recoveries' ? recoveries.recoveries : null).toEqual([]);
    const handoffs = migrated.store.query({ kind: 'execution-handoffs', coordinationScopeId: scopeId });
    expect(handoffs.kind === 'execution-handoffs' ? handoffs.handoffs : null).toEqual([]);
  } finally {
    migrated.store.close();
  }

  // 已升级到当前实现版本，二次打开不再重复执行 migration。
  const version = new DatabaseSync(databasePath, { readOnly: true });
  const row = version
    .prepare(`SELECT value FROM meta WHERE key = 'schema_version'`)
    .get() as unknown as { readonly value: string } | undefined;
  version.close();
  expect(Number.parseInt(row?.value ?? '', 10)).toBe(SCHEMA_VERSION);
});

/* -------------------------------------------------------------------------- */
/* M8：图演进、重规划与代际记录                                                */
/* -------------------------------------------------------------------------- */

const GRAPH_ID = 'g1' as GraphId;

function executionGraph(graphId: GraphId = GRAPH_ID) {
  return {
    graphId,
    generation: 1 as GraphGeneration,
    concurrencyLimit: 1,
    workPackages: [
      {
        workPackageId: 'wp-1' as WorkPackageId,
        title: '工作包',
        dependsOn: [],
        scopeEnvelope: { include: ['src'], exclude: [] },
        budget: {
          implementationAttempts: 2,
          validatorRepairs: 2,
          graphRevisions: 2,
          specificationRevisions: 2,
          maxRecoveriesPerWorkerAttempt: 1,
        },
      },
    ],
  };
}

function recordInitialGraph(graphId: GraphId = GRAPH_ID): CoordinationCommandResult {
  return submit((expectedRevision) => ({
    kind: 'record-graph-version',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(),
    graphId,
    generation: 1 as GraphGeneration,
    graphVersion: 1 as GraphVersion,
    recordKind: 'initial',
    parentVersion: null,
    mapRevision: 0,
    planRevision: 1,
    orcaRunId: 'run-1',
    graph: executionGraph(graphId),
    patch: null,
  }));
}

function acceptedRevisionCommand(expectedRevision: number, overrides: Record<string, unknown> = {}): CoordinationCommand {
  return {
    kind: 'record-graph-version',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(),
    graphId: GRAPH_ID,
    generation: 1 as GraphGeneration,
    graphVersion: 2 as GraphVersion,
    recordKind: 'accepted_revision',
    parentVersion: 1 as GraphVersion,
    mapRevision: 0,
    planRevision: 1,
    orcaRunId: 'run-1',
    graph: executionGraph(),
    patch: {
      patchId: 'patch-1',
      operationId: 'op-1' as OperationId,
      baseGraphVersion: 1 as GraphVersion,
      added: [],
      revised: ['wp-1' as WorkPackageId],
      retired: [],
      descendants: [],
      takesOver: [],
      revisionPendingWorkPackageIds: ['wp-1' as WorkPackageId],
    },
    ...overrides,
  };
}

test('migration v7 → v8 保留既有数据并补齐图演进表', () => {
  const databasePath = join(directory, 'coordination-v7.sqlite');

  const legacy = new DatabaseSync(databasePath);
  legacy.exec('BEGIN IMMEDIATE');
  for (const migration of MIGRATIONS) {
    if (migration.version > 7) {
      continue;
    }
    for (const statement of migration.statements) {
      legacy.exec(statement);
    }
  }
  legacy
    .prepare(
      `INSERT INTO scope (
         coordination_scope_id, mode, control_state, planning_cycle_id, graph_id, graph_version,
         authorization_id, authorization_version, map_revision, revision, updated_at
       ) VALUES (?, 'execution_coordination', 'active', 'cycle-1', 'g1', 1, 'auth-1', 1, 0, 7, 1)`,
    )
    .run('scope-migrated');
  legacy
    .prepare(
      `INSERT INTO graph_versions (
         coordination_scope_id, graph_id, graph_version, graph_generation, record_kind, parent_version,
         map_revision, plan_revision, orca_run_id, graph_json, recorded_at
       ) VALUES ('scope-migrated', 'g1', 1, 1, 'initial', NULL, 0, 1, 'run-1', ?, 1)`,
    )
    .run(JSON.stringify(executionGraph()));
  legacy.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', '7')`).run();
  legacy.exec('COMMIT');
  legacy.close();

  const migrated = openCoordinationStore({ databasePath, clock });
  if (migrated.kind !== 'opened') {
    throw new Error(migrated.message);
  }
  try {
    const scopeId = 'scope-migrated' as CoordinationScopeId;
    const versions = migrated.store.query({ kind: 'graph-versions', coordinationScopeId: scopeId, graphId: GRAPH_ID });
    expect(versions.kind === 'graph-versions' ? versions.versions.length : -1).toBe(1);
    expect(versions.kind === 'graph-versions' ? versions.versions[0]?.patchId : 'missing').toBeNull();

    for (const query of ['graph-generations', 'revision-holds', 'baseline-reconciliations', 'work-package-lineages', 'baseline-adoptions'] as const) {
      const result = migrated.store.query({ kind: query, coordinationScopeId: scopeId });
      expect(result.kind, query).not.toBe('rejected');
    }
    const holds = migrated.store.query({ kind: 'revision-holds', coordinationScopeId: scopeId });
    expect(holds.kind === 'revision-holds' ? holds.holds : null).toEqual([]);
  } finally {
    migrated.store.close();
  }
});

test('initial GraphVersion 不得携带补丁，accepted_revision 必须携带补丁', () => {
  createScope();
  activateSession();

  const withPatch = submit((expectedRevision) => ({
    kind: 'record-graph-version',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(),
    graphId: GRAPH_ID,
    generation: 1 as GraphGeneration,
    graphVersion: 1 as GraphVersion,
    recordKind: 'initial',
    parentVersion: null,
    mapRevision: 0,
    planRevision: 1,
    orcaRunId: 'run-1',
    graph: executionGraph(),
    patch: {
      patchId: 'patch-illegal',
      operationId: 'op-1' as OperationId,
      baseGraphVersion: 0 as GraphVersion,
      added: [],
      revised: [],
      retired: [],
      descendants: [],
      takesOver: [],
      revisionPendingWorkPackageIds: [],
    },
  }));
  expect(withPatch.kind === 'rejected' ? withPatch.message : '').toContain('initial');

  expect(recordInitialGraph().kind).toBe('committed');
  const withoutPatch = submit((expectedRevision) => ({
    ...(acceptedRevisionCommand(expectedRevision) as Record<string, unknown>),
    patch: null,
  }) as CoordinationCommand);
  expect(withoutPatch.kind === 'rejected' ? withoutPatch.message : '').toContain('accepted_revision');
});

test('没有 Execution Coordination Lease 的写入者不能追加 accepted revision', () => {
  createScope();
  activateSession();
  recordInitialGraph();

  // 图修订改变正在执行的拓扑：只有当前执行权威可以推进它。
  const rejected = submit((expectedRevision) => acceptedRevisionCommand(expectedRevision));
  expect(rejected.kind).toBe('rejected');
  if (rejected.kind === 'rejected') {
    expect(rejected.code).toBe('constraint');
    expect(rejected.message).toContain('Execution Coordination Lease');
  }
  const versions = store.query({ kind: 'graph-versions', coordinationScopeId: SCOPE, graphId: GRAPH_ID });
  expect(versions.kind === 'graph-versions' ? versions.versions.length : -1).toBe(1);
});

test('accepted revision 与 revision pending 持有、预算扣减在同一事务内生效', () => {
  createScope();
  activateSession();
  recordInitialGraph();
  acquireExecutionLease();

  const committed = submit((expectedRevision) =>
    acceptedRevisionCommand(expectedRevision, {
      budgetConsumption: [
        { budgetKey: 'work-package:wp-1:graphRevisions', approvedLimitRef: 'auth-1', amount: 1 },
      ],
    }),
  );
  expect(committed.kind).toBe('committed');

  const versions = store.query({ kind: 'graph-versions', coordinationScopeId: SCOPE, graphId: GRAPH_ID });
  expect(versions.kind === 'graph-versions' ? versions.versions.map((entry) => entry.patchId) : null).toEqual([
    null,
    'patch-1',
  ]);
  const holds = store.query({ kind: 'revision-holds', coordinationScopeId: SCOPE });
  expect(holds.kind === 'revision-holds' ? holds.holds : null).toEqual([
    expect.objectContaining({ workPackageId: 'wp-1', source: 'graph_patch', state: 'pending' }),
  ]);
  const counters = store.query({ kind: 'budget-counters', coordinationScopeId: SCOPE });
  expect(counters.kind === 'budget-counters' ? counters.counters : null).toEqual([
    expect.objectContaining({ budgetKey: 'work-package:wp-1:graphRevisions', consumed: 1 }),
  ]);

  // 同一补丁标识只能提交一次：唯一索引把重放挡在库边界。
  const replay = submit((expectedRevision) =>
    acceptedRevisionCommand(expectedRevision, {
      graphVersion: 3,
      parentVersion: 2,
    }),
  );
  expect(replay.kind).toBe('rejected');
  if (replay.kind === 'rejected') {
    expect(replay.code).toBe('constraint');
  }
});

test('补丁基线必须等于当前 head，否则整笔拒绝', () => {
  createScope();
  activateSession();
  recordInitialGraph();
  acquireExecutionLease();

  const mismatched = submit((expectedRevision) =>
    acceptedRevisionCommand(expectedRevision, {
      patch: {
        patchId: 'patch-2',
        operationId: 'op-2' as OperationId,
        baseGraphVersion: 0 as GraphVersion,
        added: [],
        revised: [],
        retired: [],
        descendants: [],
        takesOver: [],
        revisionPendingWorkPackageIds: [],
      },
    }),
  );
  expect(mismatched.kind).toBe('rejected');
  const versions = store.query({ kind: 'graph-versions', coordinationScopeId: SCOPE, graphId: GRAPH_ID });
  expect(versions.kind === 'graph-versions' ? versions.versions.length : -1).toBe(1);
});

test('代际状态迁移受闭集约束，frozen 是终态', () => {
  createScope();
  activateSession();

  expect(
    submit((expectedRevision) => ({
      kind: 'record-graph-generation',
      coordinationScopeId: SCOPE,
      expectedRevision,
      writer: writer(),
      graphId: GRAPH_ID,
      generation: 1 as GraphGeneration,
      planningCycleId: 'cycle-1' as PlanningCycleId,
      orcaRunId: 'run-1',
      predecessorGraphId: null,
      baselineHead: 'head-1',
    })).kind,
  ).toBe('committed');
  expect(
    submit((expectedRevision) => ({
      kind: 'record-graph-generation',
      coordinationScopeId: SCOPE,
      expectedRevision,
      writer: writer(),
      graphId: GRAPH_ID,
      generation: 1 as GraphGeneration,
      planningCycleId: 'cycle-1' as PlanningCycleId,
      orcaRunId: 'run-1',
      predecessorGraphId: null,
      baselineHead: 'head-1',
    })).kind,
  ).toBe('rejected');

  const advance = (status: 'active' | 'suspended' | 'frozen'): CoordinationCommandResult =>
    submit((expectedRevision) => ({
      kind: 'advance-graph-generation',
      coordinationScopeId: SCOPE,
      expectedRevision,
      writer: writer(),
      graphId: GRAPH_ID,
      status,
    }));

  expect(advance('active').kind).toBe('committed');
  expect(advance('active').kind).toBe('committed');
  expect(advance('suspended').kind).toBe('committed');
  expect(advance('active').kind).toBe('committed');
  expect(advance('frozen').kind).toBe('committed');
  const terminal = advance('active');
  expect(terminal.kind).toBe('rejected');
  if (terminal.kind === 'rejected') {
    expect(terminal.message).toContain('frozen');
  }
});

test('释放持有是幂等的，重放不会把修订额度再扣一次', () => {
  createScope();
  activateSession();
  recordInitialGraph();
  acquireExecutionLease();
  submit((expectedRevision) =>
    acceptedRevisionCommand(expectedRevision, {
      patch: {
        patchId: 'patch-1',
        operationId: 'op-1' as OperationId,
        baseGraphVersion: 1 as GraphVersion,
        added: [],
        revised: ['wp-1' as WorkPackageId],
        retired: [],
        descendants: [],
        takesOver: [],
        revisionPendingWorkPackageIds: ['wp-1' as WorkPackageId],
      },
    }),
  );

  const release = (): CoordinationCommandResult =>
    submit((expectedRevision) => ({
      kind: 'release-revision-hold',
      coordinationScopeId: SCOPE,
      expectedRevision,
      writer: writer(),
      workPackageId: 'wp-1' as WorkPackageId,
      reason: 'specification revision 已重新准入',
      budgetConsumption: [
        { budgetKey: 'work-package:wp-1:specificationRevisions', approvedLimitRef: 'auth-1', amount: 1 },
      ],
    }));

  expect(release().kind).toBe('committed');
  expect(release().kind).toBe('committed');
  const counters = store.query({ kind: 'budget-counters', coordinationScopeId: SCOPE });
  expect(counters.kind === 'budget-counters' ? counters.counters : null).toEqual([
    expect.objectContaining({ budgetKey: 'work-package:wp-1:specificationRevisions', consumed: 1 }),
  ]);

  const absent = submit((expectedRevision) => ({
    kind: 'release-revision-hold',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(),
    workPackageId: 'wp-unknown' as WorkPackageId,
    reason: '不存在',
  }));
  expect(absent.kind).toBe('rejected');
});

test('Baseline Reconciliation 的 verified 要求四项核验齐全', () => {
  createScope();
  activateSession();
  submit((expectedRevision) => ({
    kind: 'record-baseline-reconciliation',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(),
    reconciliationId: 'reconciliation-1',
    workPackageId: 'wp-1' as WorkPackageId,
    requiredBaselineHead: 'base-2',
  }));

  const incomplete = submit((expectedRevision) => ({
    kind: 'advance-baseline-reconciliation',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(),
    reconciliationId: 'reconciliation-1',
    state: 'verified',
    observedHead: 'base-2',
    ancestryVerified: true,
    targetHeadVerified: true,
    dirtyPathsReconciled: true,
    scopeReconciled: false,
  }));
  expect(incomplete.kind).toBe('rejected');

  const blocked = submit((expectedRevision) => ({
    kind: 'advance-baseline-reconciliation',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(),
    reconciliationId: 'reconciliation-1',
    state: 'blocked',
    blockerRef: 'git:diverged',
  }));
  expect(blocked.kind).toBe('committed');
  const records = store.query({ kind: 'baseline-reconciliations', coordinationScopeId: SCOPE });
  expect(records.kind === 'baseline-reconciliations' ? records.reconciliations[0]?.state : null).toBe('blocked');
});

test('采用记录要求证据，阻塞结论必须给出矛盾事实', () => {
  createScope();
  activateSession();

  const noEvidence = submit((expectedRevision) => ({
    kind: 'record-baseline-adoption',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(),
    adoptionId: 'adoption-1',
    workPackageId: 'wp-1' as WorkPackageId,
    adoptionKind: 'baseline_adoption',
    adoptedResultRef: 'result-1',
    baselineHead: 'head-1',
    integrationRef: 'commit-1',
    evidenceRefs: [],
    state: 'recorded',
    blockingReason: null,
  }));
  expect(noEvidence.kind).toBe('rejected');

  const blockedWithoutReason = submit((expectedRevision) => ({
    kind: 'record-baseline-adoption',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(),
    adoptionId: 'adoption-2',
    workPackageId: 'wp-1' as WorkPackageId,
    adoptionKind: 'migration_material',
    adoptedResultRef: 'result-1',
    baselineHead: 'head-1',
    integrationRef: null,
    evidenceRefs: ['evidence-1'],
    state: 'blocked',
    blockingReason: null,
  }));
  expect(blockedWithoutReason.kind).toBe('rejected');
});

test('lineage 只接受可继承额度项，且一个 Work Package 至多一条', () => {
  createScope();
  activateSession();

  const nonInheritable = submit((expectedRevision) => ({
    kind: 'record-work-package-lineage',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(),
    workPackageId: 'wp-1' as WorkPackageId,
    priorWorkPackageId: 'wp-old' as WorkPackageId,
    priorGraphId: 'g-old' as GraphId,
    inherited: [{ field: 'maxRecoveriesPerWorkerAttempt', consumed: 1 } as never],
  }));
  expect(nonInheritable.kind).toBe('rejected');

  const recorded = submit((expectedRevision) => ({
    kind: 'record-work-package-lineage',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(),
    workPackageId: 'wp-1' as WorkPackageId,
    priorWorkPackageId: 'wp-old' as WorkPackageId,
    priorGraphId: 'g-old' as GraphId,
    inherited: [{ field: 'implementationAttempts', consumed: 1 }],
  }));
  expect(recorded.kind).toBe('committed');

  const duplicate = submit((expectedRevision) => ({
    kind: 'record-work-package-lineage',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(),
    workPackageId: 'wp-1' as WorkPackageId,
    priorWorkPackageId: 'wp-other' as WorkPackageId,
    priorGraphId: 'g-old' as GraphId,
    inherited: [],
  }));
  expect(duplicate.kind).toBe('rejected');

  const lineages = store.query({ kind: 'work-package-lineages', coordinationScopeId: SCOPE });
  const recordedLineage = lineages.kind === 'work-package-lineages' ? lineages.lineages[0] : undefined;
  expect(recordedLineage?.workPackageId).toBe('wp-1');
  expect(recordedLineage?.priorWorkPackageId).toBe('wp-old');
  expect(typeof recordedLineage?.recordedAt).toBe('number');
});

test('代际引用只在 Cutover 时整体切换：候选未授权时整笔拒绝', () => {
  createScope();
  activateSession();
  recordInitialGraph();

  const candidate = submit((expectedRevision) => ({
    kind: 'record-graph-generation',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(),
    graphId: 'g2' as GraphId,
    generation: 2 as GraphGeneration,
    planningCycleId: 'cycle-2' as PlanningCycleId,
    orcaRunId: 'run-2',
    predecessorGraphId: GRAPH_ID,
    baselineHead: 'head-2',
  }));
  expect(candidate.kind).toBe('committed');

  const missingAuthorization = submit((expectedRevision) => ({
    kind: 'commit-generation-cutover',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(),
    candidateGraphId: 'g2' as GraphId,
    candidateGraphVersion: 1 as GraphVersion,
    planningCycleId: 'cycle-2' as PlanningCycleId,
    authorizationId: 'auth-missing',
    authorizationVersion: 1,
    predecessorGraphId: GRAPH_ID,
    candidateRunId: 'run-2',
    baselineHead: 'head-2',
  }));
  expect(missingAuthorization.kind).toBe('rejected');

  const scope = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  expect(scope.kind === 'scope' ? scope.scope?.graphId : null).toBe(GRAPH_ID);
  const generations = store.query({ kind: 'graph-generations', coordinationScopeId: SCOPE });
  expect(generations.kind === 'graph-generations' ? generations.generations.map((entry) => entry.status) : null).toEqual([
    'candidate',
  ]);
});
