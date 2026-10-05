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
  MaterializationBindingRecord,
  RecoveryRecord,
  RecoveryState,
  RecoveryTerminalOutcome,
  ReplacementSegmentInput,
  SessionSegmentRecord,
  SessionLifecycleState,
} from '../src/application/ports/branch-coordination-store.js';
import type { SpecBinding } from '../src/domain/task-contract.js';
import { workPackageBudgetKey } from '../src/domain/dispatch-candidate.js';
import { DEFAULT_EXECUTION_LIMITS } from '../src/domain/planning/budget-policy.js';
import type { ExecutionAuthorizationManifest } from '../src/domain/planning/execution-authorization.js';
import { openCoordinationStore, type CoordinationStore } from '../src/adapters/storage/coordination-store.js';
import { COORDINATION_TABLES, MIGRATIONS, SCHEMA_VERSION } from '../src/adapters/storage/schema.js';
import { createUserQuestion, answerPendingInteraction } from '../src/application/coordination/pending-interaction.js';
import { implementationPlanFor } from './support/graph-plan-fixture.js';
import { workerProfilesFixture, recoveryUtilityProfileFixture } from './support/model-configurations.js';
import { sessionBindingIdOf } from '../src/adapters/agents/session-binding.js';

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

test('项目详情的 Session 查询只返回精确注册、该 Session 的 active Claim 与当前执行 Lease', () => {
  createScope();
  activateSession();
  expect(store.transact({ kind: 'register-session', coordinationScopeId: SCOPE, expectedRevision: revisionOf(),
    writer: writer(SESSION_A), coordinatorSessionId: SESSION_B,
    coordinatorModelConfigurationRef: 'profile-session-b', lifecycleState: 'registered' }).kind).toBe('committed');
  const secondLease = store.transact({ kind: 'acquire-runtime-lease', coordinationScopeId: SCOPE,
    expectedRevision: revisionOf(), writer: writer(SESSION_B, 0), ttlMs: 30_000 });
  expect(secondLease.kind).toBe('committed');
  for (const [session, ticket] of [[SESSION_A, 'ticket-a'], [SESSION_B, 'ticket-b']] as const) {
    expect(submit(expectedRevision => ({ kind: 'record-ticket-claim', coordinationScopeId: SCOPE,
      expectedRevision, writer: writer(session), ticketRef: { kind: 'decision-ticket', id: ticket } })).kind).toBe('committed');
  }

  expect(store.query({ kind: 'project-detail-session', coordinationScopeId: SCOPE, coordinatorSessionId: SESSION_A }))
    .toMatchObject({ kind: 'project-detail-session', registration: { coordinatorSessionId: SESSION_A },
      activeClaim: { coordinatorSessionId: SESSION_A, ticketRef: { id: 'ticket-a' } },
      executionLease: null });
  expect(store.query({ kind: 'project-detail-session', coordinationScopeId: SCOPE, coordinatorSessionId: 'unknown' as CoordinatorSessionId }))
    .toMatchObject({ kind: 'project-detail-session', registration: null, activeClaim: null, executionLease: null });
});

test('预算读取可按批准引用筛选，不把其他授权主体的计数带入详情', () => {
  createScope();
  activateSession();
  acquireExecutionLease();
  for (const [budgetKey, approvedLimitRef] of [['implementation-attempts:wp-a', 'auth-a'], ['recovery:wp-b', 'auth-b']] as const) {
    expect(submit(expectedRevision => ({ kind: 'consume-budget', coordinationScopeId: SCOPE, expectedRevision,
      writer: writer(SESSION_A), budgetKey, approvedLimitRef, amount: 1 })).kind).toBe('committed');
  }
  expect(store.query({ kind: 'budget-counters', coordinationScopeId: SCOPE, approvedLimitRef: 'auth-a' }))
    .toMatchObject({ kind: 'budget-counters', counters: [{ budgetKey: 'implementation-attempts:wp-a', approvedLimitRef: 'auth-a', consumed: 1 }] });
});

test('真实问题写后回读、原操作重放与回答，Scope 摘要不复制正文', () => {
  createScope(); activateSession();
  const input = { store, coordinationScopeId: SCOPE, writer: writer(), operationId: 'ask-1' as OperationId,
    question: { text: '下一步？', options: [{ label: '继续', description: '完成实现' }] } };
  const created = createUserQuestion(input);
  expect(created.kind).toBe('recorded');
  if (created.kind !== 'recorded') throw new Error('问题创建失败');
  const revision = revisionOf();
  expect(createUserQuestion(input)).toMatchObject({ kind: 'recorded', replayed: true, interaction: { interactionId: created.interaction.interactionId } });
  expect(revisionOf()).toBe(revision);
  expect(createUserQuestion({ ...input, question: { text: '不同内容', options: [] } })).toMatchObject({ kind: 'rejected', code: 'content_conflict' });
  expect(store.query({ kind: 'pending-interaction', coordinationScopeId: SCOPE, coordinatorSessionId: SESSION_B, interactionId: created.interaction.interactionId }))
    .toMatchObject({ kind: 'pending-interaction', interaction: null });
  const snapshot = store.query({ kind: 'snapshot', coordinationScopeId: SCOPE });
  if (snapshot.kind !== 'snapshot') throw new Error('快照不可读');
  expect(snapshot.snapshot.pendingInteractions[0]).not.toHaveProperty('question');
  expect(answerPendingInteraction({ store, coordinationScopeId: SCOPE, writer: writer(), submissionId: 'answer-1',
    interactionId: created.interaction.interactionId, expectedRevision: created.interaction.expectedRevision, answer: '继续' })).toMatchObject({ kind: 'answered' });
  expect(createUserQuestion(input)).toMatchObject({ kind: 'recorded', replayed: true, interaction: { state: 'answered' } });
  expect(submit((expectedRevision) => ({ kind: 'record-control-state', coordinationScopeId: SCOPE,
    expectedRevision, writer: writer(), controlState: 'cancelled' })).kind).toBe('committed');
  const lateId = 'ask-after-cancel' as OperationId;
  expect(createUserQuestion({ ...input, operationId: lateId })).toMatchObject({ kind: 'rejected', code: 'control_state' });
  expect(store.query({ kind: 'pending-interaction', coordinationScopeId: SCOPE,
    interactionId: JSON.stringify(['ask_user', lateId]) as InteractionId })).toMatchObject({ interaction: null });
});

test('当前 Session 问题 keyset 分页最多二十个，不泄漏其他 Session', () => {
  createScope(); activateSession();
  expect(store.transact({ kind: 'register-session', coordinationScopeId: SCOPE, expectedRevision: revisionOf(), writer: writer(),
    coordinatorSessionId: SESSION_B, coordinatorModelConfigurationRef: 'profile-b', lifecycleState: 'registered' }).kind).toBe('committed');
  expect(store.transact({ kind: 'acquire-runtime-lease', coordinationScopeId: SCOPE, expectedRevision: revisionOf(), writer: writer(SESSION_B, 0), ttlMs: 30000 }).kind).toBe('committed');
  for (let index = 0; index < 23; index++) {
    const result = createUserQuestion({ store, coordinationScopeId: SCOPE, writer: writer(), operationId: `ask-${String(index).padStart(2, '0')}` as OperationId,
      question: { text: `问题 ${String(index)}`, options: [] } });
    expect(result.kind).toBe('recorded');
  }
  expect(createUserQuestion({ store, coordinationScopeId: SCOPE, writer: writer(SESSION_B), operationId: 'other' as OperationId,
    question: { text: '另一 Session', options: [] } }).kind).toBe('recorded');
  const first = store.query({ kind: 'pending-interactions', coordinationScopeId: SCOPE, coordinatorSessionId: SESSION_A });
  if (first.kind !== 'pending-interactions' || !first.nextCursor) throw new Error('分页不可用');
  expect(first.interactions).toHaveLength(20);
  const second = store.query({ kind: 'pending-interactions', coordinationScopeId: SCOPE, coordinatorSessionId: SESSION_A, after: first.nextCursor });
  if (second.kind !== 'pending-interactions') throw new Error('第二页不可读');
  expect(second.interactions).toHaveLength(3);
  expect(new Set([...first.interactions, ...second.interactions].map((item) => item.interactionId)).size).toBe(23);
  expect(second.nextCursor).toBeNull();
  const scopePage = store.query({ kind: 'pending-interactions', coordinationScopeId: SCOPE });
  if (scopePage.kind !== 'pending-interactions' || !scopePage.nextCursor) throw new Error('Scope 页不可读');
  expect(scopePage.interactions).toHaveLength(20);
  const scopeTail = store.query({ kind: 'pending-interactions', coordinationScopeId: SCOPE, after: scopePage.nextCursor });
  if (scopeTail.kind !== 'pending-interactions') throw new Error('Scope 后页不可读');
  expect(scopeTail.interactions).toHaveLength(4);
  expect(scopeTail.interactions.some(item => item.ownerCoordinatorSessionId === SESSION_B)).toBe(true);
  const later = second.interactions[0]!;
  expect(store.query({ kind: 'pending-interaction', coordinationScopeId: SCOPE, coordinatorSessionId: SESSION_A, interactionId: later.interactionId }))
    .toMatchObject({ interaction: { interactionId: later.interactionId } });
  const presentation = store.query({ kind: 'presentation-snapshot', coordinationScopeId: SCOPE, coordinatorSessionId: SESSION_A });
  if (presentation.kind !== 'presentation-snapshot') throw new Error('展示快照不可读');
  expect(presentation.snapshot).not.toHaveProperty('pendingInteractions');
  expect(presentation.snapshot.interactionOverview).toMatchObject({ openCount: 24, sessionCounts: [
    { coordinatorSessionId: SESSION_A, openCount: 23 }, { coordinatorSessionId: SESSION_B, openCount: 1 },
  ] });
  expect(presentation.snapshot.interactionOverview.items).toHaveLength(20);
  expect(presentation.snapshot.interactionOverview.items.every(item => !('question' in item) && !('answerText' in item))).toBe(true);
  expect(store.query({ kind: 'interaction-summaries', coordinationScopeId: SCOPE, coordinatorSessionId: SESSION_B, interactionIds: [later.interactionId] })).toMatchObject({ interactions: [] });
  expect(store.query({ kind: 'pending-interactions', coordinationScopeId: SCOPE_2 })).toMatchObject({ interactions: [] });
});

test('问题和回答范围来自同一权威记录，正文版本与 UTF-8 边界受核验', () => {
  createScope(); activateSession();
  const created = createUserQuestion({ store, coordinationScopeId: SCOPE, writer: writer(), operationId: 'range-ask' as OperationId,
    question: { text: '中文🙂'.repeat(2000), options: [{ label: '继续', description: '保留全文' }] } });
  if (created.kind !== 'recorded') throw new Error('问题未保存');
  const id = created.interaction.interactionId;
  const query = { kind: 'interaction-body' as const, coordinationScopeId: SCOPE, coordinatorSessionId: SESSION_A, interactionId: id,
    part: 'question' as const, contentRevision: String(created.interaction.expectedRevision), offset: 0, maxBytes: 4096 };
  let text = '', offset = 0;
  for (;;) {
    const range = store.query({ ...query, offset });
    if (range.kind !== 'interaction-body' || range.body === null) throw new Error('范围不可读');
    expect(Buffer.byteLength(range.body.text)).toBeLessThanOrEqual(4096);
    expect(range.body.text).not.toContain('�'); text += range.body.text; offset = range.body.end;
    if (offset === range.body.byteLength) break;
  }
  expect(text).toBe('中文🙂'.repeat(2000) + '\n继续 — 保留全文');
  expect(store.query({ ...query, offset: 1 })).toMatchObject({ kind: 'rejected', code: 'invalid_utf8_offset' });
  expect(store.query({ ...query, contentRevision: 'stale' })).toMatchObject({ body: null });
  expect(store.query({ ...query, coordinatorSessionId: SESSION_B })).toMatchObject({ body: null });
  expect(answerPendingInteraction({ store, coordinationScopeId: SCOPE, writer: writer(), interactionId: id,
    expectedRevision: created.interaction.expectedRevision, submissionId: 'range-answer', answer: '完整回答🙂'.repeat(1000) }).kind).toBe('answered');
  const detail = store.query({ kind: 'pending-interaction', coordinationScopeId: SCOPE, coordinatorSessionId: SESSION_A, interactionId: id });
  if (detail.kind !== 'pending-interaction' || !detail.interaction?.answerRef) throw new Error('答案不可读');
  expect(store.query({ ...query, part: 'answer', contentRevision: detail.interaction.answerRef.id })).toMatchObject({ kind: 'interaction-body', body: { offset: 0 } });
  const summary = store.query({ kind: 'interaction-summaries', coordinationScopeId: SCOPE, coordinatorSessionId: SESSION_A, interactionIds: [id] });
  if (summary.kind !== 'interaction-summaries') throw new Error('摘要不可读');
  expect(summary.interactions[0]).toMatchObject({ state: 'answered', answerRef: detail.interaction.answerRef });
  expect([...summary.interactions[0]!.answerPreview].length).toBeLessThanOrEqual(160);
  expect(store.query({ kind: 'presentation-snapshot', coordinationScopeId: SCOPE })).toMatchObject({ snapshot: { interactionOverview: { openCount: 0, items: [] } } });
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

test('Materialization Binding 按角色与 Attempt 读回完整派发身份，且不复制 worktree 路径或 Task 状态', () => {
  createScope();
  activateSession();
  acquireExecutionLease();
  // 真实执行图与授权：Implementation Attempt 的接纳会 fail closed 地校验并扣减实现预算。
  expect(recordInitialGraph().kind).toBe('committed');
  recordAuthorization();

  const recorded = submit((expectedRevision) => ({
    kind: 'record-materialization-binding',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(SESSION_A),
    workPackageId: 'wp-1' as WorkPackageId,
    role: 'implementation',
    workerTaskId: 'worker-task-1' as WorkerTaskId,
    dispatchId: 'dispatch-1' as DispatchId,
    attemptId: 'attempt-1',
    worktreeId: 'worktree-1',
    specBinding: SPEC_BINDING,
    specificationUnitPath: null,
    orcaTaskId: 'task-1',
    launchId: 'launch-1',
    creationOperationId: 'op-1' as OperationId,
    ...AUTHORIZATION_PIN,
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
  expect(read.bindings[0]?.identity).toBe('issued');
  expect(read.bindings[0]?.role).toBe('implementation');
  expect(read.bindings[0]?.workerTaskId).toBe('worker-task-1');
  expect(read.bindings[0]?.dispatchId).toBe('dispatch-1');
  expect(read.bindings[0]?.attemptId).toBe('attempt-1');
  expect(read.bindings[0]?.worktreeId).toBe('worktree-1');
  expect(read.bindings[0]?.specBinding?.contentDigest).toBe(SPEC_BINDING.contentDigest);
  expect(read.bindings[0]?.specificationUnitPath).toBeNull();
  expect(read.bindings[0]?.orcaTaskId).toBe('task-1');
  expect(read.bindings[0]?.creationOperationId).toBe('op-1');
  // 派发时固定的授权与 profile 是这个 Task 的运行依据，模型重新授权不会改写它。
  expect(read.bindings[0]?.authorizationId).toBe('auth-1');
  expect(read.bindings[0]?.authorizationVersion).toBe(1);
  expect(read.bindings[0]?.workerProfileRef).toEqual({ kind: 'worker-profile', id: 'profile-implementation' });
  // 不复制 worktree 路径或 Orca Task 状态：绑定只保存最小索引。
  expect(Object.keys(read.bindings[0] ?? {})).not.toContain('worktreePath');
  expect(Object.keys(read.bindings[0] ?? {})).not.toContain('taskStatus');
  // 同一 OperationId 重放同一内容幂等，不产生第二行。
  expect(
    submit((expectedRevision) => ({
      kind: 'record-materialization-binding',
      coordinationScopeId: SCOPE,
      expectedRevision,
      writer: writer(SESSION_A),
      workPackageId: 'wp-1' as WorkPackageId,
      role: 'implementation',
      workerTaskId: 'worker-task-1' as WorkerTaskId,
      dispatchId: 'dispatch-1' as DispatchId,
      attemptId: 'attempt-1',
      worktreeId: 'worktree-1',
      specBinding: SPEC_BINDING,
      specificationUnitPath: null,
      orcaTaskId: 'task-1',
      launchId: 'launch-1',
      creationOperationId: 'op-1' as OperationId,
      ...AUTHORIZATION_PIN,
    })).kind,
  ).toBe('committed');
  expect(bindingsOf()).toHaveLength(1);
});

test('Recovery Utility 派发固定自己的授权与 profile，且不进入四主角色', () => {
  createScope();
  activateSession();
  acquireExecutionLease();

  type UtilityCommand = Extract<CoordinationCommand, { readonly kind: 'record-materialization-binding' }>;
  // 身份与 CAS 字段由基座固定，覆盖项只描述这次派发本身。
  type UtilityOverrides = Partial<Omit<UtilityCommand, 'expectedRevision' | 'coordinationScopeId' | 'writer'>>;
  const utility = (expectedRevision: number, overrides: UtilityOverrides = {}): UtilityCommand => ({
    kind: 'record-materialization-binding',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(SESSION_A),
    workPackageId: 'wp-1' as WorkPackageId,
    role: null,
    recoveryUtilityRole: 'recovery_utility' as const,
    workerTaskId: 'utility-task-1' as WorkerTaskId,
    dispatchId: 'utility-dispatch-1' as DispatchId,
    attemptId: 'attempt-1',
    worktreeId: 'worktree-1',
    specBinding: null,
    specificationUnitPath: null,
    orcaTaskId: 'utility-orca-1',
    launchId: 'utility-launch-1',
    creationOperationId: 'utility-op-1' as OperationId,
    authorizationId: 'auth-2',
    authorizationVersion: 2,
    workerProfileRef: 'profile-recovery-utility',
    ...overrides,
  });

  const firstUtility = submit((expectedRevision) => utility(expectedRevision));
  expect(firstUtility.kind).toBe('committed');
  const bindings = bindingsOf();
  expect(bindings[0]?.role).toBeNull();
  expect(bindings[0]?.recoveryUtilityRole).toBe('recovery_utility');
  expect(bindings[0]?.authorizationId).toBe('auth-2');
  expect(bindings[0]?.workerProfileRef).toEqual({ kind: 'worker-profile', id: 'profile-recovery-utility' });

  // Utility 不得携带规格内容，也不与角色派发混用同一个身份。
  expect(
    submit((expectedRevision) =>
      utility(expectedRevision, {
        specBinding: SPEC_BINDING,
        creationOperationId: 'utility-op-2' as OperationId,
      }),
    ).kind,
  ).toBe('rejected');
  expect(
    submit((expectedRevision) =>
      utility(expectedRevision, {
        role: 'implementation',
        creationOperationId: 'utility-op-3' as OperationId,
      }),
    ).kind,
  ).toBe('rejected');
  expect(
    submit((expectedRevision) =>
      utility(expectedRevision, { role: null, creationOperationId: 'utility-op-4' as OperationId }),
    ).kind,
  ).toBe('rejected');
  expect(bindingsOf()).toHaveLength(1);
});

test('缺少模型授权绑定的新派发被拒绝写入', () => {
  createScope();
  activateSession();
  acquireExecutionLease();

  const base = {
    kind: 'record-materialization-binding',
    coordinationScopeId: SCOPE,
    writer: writer(SESSION_A),
    workPackageId: 'wp-1' as WorkPackageId,
    role: 'validator',
    workerTaskId: 'worker-task-1' as WorkerTaskId,
    dispatchId: 'dispatch-1' as DispatchId,
    attemptId: 'attempt-1',
    worktreeId: 'worktree-1',
    specBinding: SPEC_BINDING,
    specificationUnitPath: null,
    orcaTaskId: 'task-1',
    launchId: 'launch-1',
    creationOperationId: 'op-1' as OperationId,
  } as const;
  for (const missing of ['authorizationId', 'authorizationVersion', 'workerProfileRef'] as const) {
    const command: Record<string, unknown> = { ...base, ...AUTHORIZATION_PIN, expectedRevision: 0 };
    delete command[missing];
    expect(submit(() => command as unknown as CoordinationCommand).kind).toBe('rejected');
  }
  expect(bindingsOf()).toEqual([]);
  expect(submit((expectedRevision) => ({ ...base, ...AUTHORIZATION_PIN, expectedRevision })).kind).toBe('committed');
});

test('同一角色同一 Attempt 的第二次派发被唯一约束拒绝，不同 Attempt 追加为新行', () => {
  createScope();
  activateSession();
  acquireExecutionLease();

  const bind = (
    attemptId: string,
    creationOperationId: string,
    orcaTaskId: string,
    overrides: Record<string, unknown> = {},
  ): CoordinationCommandResult =>
    submit((expectedRevision) => ({
      kind: 'record-materialization-binding',
      coordinationScopeId: SCOPE,
      expectedRevision,
      writer: writer(SESSION_A),
      workPackageId: 'wp-1' as WorkPackageId,
      role: 'validator',
      workerTaskId: 'worker-task-1' as WorkerTaskId,
      dispatchId: `dispatch-${attemptId}` as DispatchId,
      attemptId,
      worktreeId: 'worktree-1',
      specBinding: SPEC_BINDING,
      specificationUnitPath: null,
      orcaTaskId,
      launchId: `launch-${attemptId}`,
      creationOperationId: creationOperationId as OperationId,
      ...AUTHORIZATION_PIN,
      ...overrides,
    }));

  expect(bind('attempt-1', 'op-1', 'task-1').kind).toBe('committed');
  // 同一角色同一 Attempt 换一个 Task：这是重复派发，约束拒绝而不是覆盖既有身份。
  expect(bind('attempt-1', 'op-2', 'task-2').kind).toBe('rejected');
  expect(bindingsOf()).toHaveLength(1);
  // 复用同一个 Task 创建操作、换一个新 Attempt：这是普通 Retry 的合法绑定，追加为新行。
  expect(bind('attempt-2', 'op-1', 'task-1').kind).toBe('committed');
  expect(bindingsOf().map((binding) => binding.attemptId)).toEqual(['attempt-1', 'attempt-2']);
  // 已存在 Attempt 再换一组身份派发：仍被角色 Attempt 唯一约束拒绝。
  expect(bind('attempt-2', 'op-3', 'task-3').kind).toBe('rejected');
  expect(bindingsOf()).toHaveLength(2);
});

test('Planner 绑定只带固定规格目标路径，其它角色必须带 Spec Binding', () => {
  createScope();
  activateSession();
  acquireExecutionLease();

  const plannerWithoutPath = submit((expectedRevision) => ({
    kind: 'record-materialization-binding',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(SESSION_A),
    workPackageId: 'wp-1' as WorkPackageId,
    role: 'planner',
    workerTaskId: 'worker-task-1' as WorkerTaskId,
    dispatchId: 'dispatch-1' as DispatchId,
    attemptId: 'attempt-1',
    worktreeId: 'worktree-1',
    specBinding: null,
    specificationUnitPath: null,
    orcaTaskId: 'task-1',
    launchId: 'launch-1',
    creationOperationId: 'op-1' as OperationId,
    ...AUTHORIZATION_PIN,
  }));
  expect(plannerWithoutPath.kind).toBe('rejected');

  const implementationWithoutBinding = submit((expectedRevision) => ({
    kind: 'record-materialization-binding',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(SESSION_A),
    workPackageId: 'wp-1' as WorkPackageId,
    role: 'implementation',
    workerTaskId: 'worker-task-1' as WorkerTaskId,
    dispatchId: 'dispatch-1' as DispatchId,
    attemptId: 'attempt-1',
    worktreeId: 'worktree-1',
    specBinding: null,
    specificationUnitPath: 'openspec/changes/wp-1',
    orcaTaskId: 'task-1',
    launchId: 'launch-1',
    creationOperationId: 'op-1' as OperationId,
    ...AUTHORIZATION_PIN,
  }));
  expect(implementationWithoutBinding.kind).toBe('rejected');
  expect(bindingsOf()).toEqual([]);

  expect(
    submit((expectedRevision) => ({
      kind: 'record-materialization-binding',
      coordinationScopeId: SCOPE,
      expectedRevision,
      writer: writer(SESSION_A),
      workPackageId: 'wp-1' as WorkPackageId,
      role: 'planner',
      workerTaskId: 'worker-task-1' as WorkerTaskId,
      dispatchId: 'dispatch-1' as DispatchId,
      attemptId: 'attempt-1',
      worktreeId: 'worktree-1',
      specBinding: null,
      specificationUnitPath: 'openspec/changes/wp-1',
      orcaTaskId: 'task-1',
      launchId: 'launch-1',
      creationOperationId: 'op-1' as OperationId,
      ...AUTHORIZATION_PIN,
    })).kind,
  ).toBe('committed');
  expect(bindingsOf()[0]?.specificationUnitPath).toBe('openspec/changes/wp-1');
  expect(bindingsOf()[0]?.specBinding).toBeNull();
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

test('项目详情结算查询按指定 Work Package 的物化 WorkerTask 收窄', () => {
  createScope();
  activateSession();
  acquireExecutionLease();
  for (const [workPackageId, workerTaskId, suffix] of [
    ['wp-detail-a', 'worker-task-a', 'a'], ['wp-detail-b', 'worker-task-b', 'b'],
  ] as const) {
    const dispatchId = `dispatch-${suffix}` as DispatchId;
    expect(submit(expectedRevision => ({ kind: 'record-materialization-binding', coordinationScopeId: SCOPE,
      expectedRevision, writer: writer(SESSION_A), workPackageId: workPackageId as WorkPackageId,
      role: 'validator', workerTaskId: workerTaskId as WorkerTaskId, dispatchId,
      attemptId: `attempt-${suffix}`, worktreeId: `worktree-${suffix}`, specBinding: SPEC_BINDING,
      specificationUnitPath: null, orcaTaskId: `orca-task-${suffix}`, launchId: `launch-${suffix}`,
      creationOperationId: `materialize-${suffix}` as OperationId, ...AUTHORIZATION_PIN })).kind).toBe('committed');
    expect(submit(expectedRevision => ({ kind: 'record-delivery-settlement', coordinationScopeId: SCOPE,
      expectedRevision, writer: writer(SESSION_A), dedupeKey: `delivery-${suffix}`, deliveryId: `delivery-${suffix}`,
      runId: 'run-1', consumerGeneration: 1, workerTaskId: workerTaskId as WorkerTaskId,
      dispatchId, attemptId: `attempt-${suffix}`, role: 'implementation',
      contractRevision: 1, orcaResultRef: `result-${suffix}` })).kind).toBe('committed');
  }

  expect(store.query({ kind: 'delivery-settlements', coordinationScopeId: SCOPE,
    workPackageId: 'wp-detail-a' as WorkPackageId })).toMatchObject({
    kind: 'delivery-settlements', settlements: [{ workerTaskId: 'worker-task-a', orcaResultRef: 'result-a' }],
  });
  expect(store.query({ kind: 'materialization-bindings', coordinationScopeId: SCOPE,
    workPackageId: 'wp-detail-a' as WorkPackageId })).toMatchObject({
    kind: 'materialization-bindings', bindings: [{ workPackageId: 'wp-detail-a', workerTaskId: 'worker-task-a' }],
  });
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

function recordTicketClaim(ticketId: string, owner: CoordinatorSessionId): void {
  const recorded = submit((expectedRevision) => ({
    kind: 'record-ticket-claim',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(owner),
    ticketRef: { kind: 'decision_ticket', id: ticketId },
  }));
  if (recorded.kind !== 'committed') {
    throw new Error(`无法登记 Ticket Claim: ${recorded.message}`);
  }
}

function ticketClaimOwner(ticketId: string): CoordinatorSessionId | null {
  const snapshot = store.query({ kind: 'snapshot', coordinationScopeId: SCOPE });
  if (snapshot.kind !== 'snapshot') {
    return null;
  }
  return (
    snapshot.snapshot.ticketClaims.find((claim) => claim.ticketRef.id === ticketId)
      ?.coordinatorSessionId ?? null
  );
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
  recordTicketClaim('ticket-claim-1', SESSION_A);
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
  // 活跃 Ticket Claim 随执行责任一起转移，不留在 Source 变成第二个所有权来源。
  expect(ticketClaimOwner('ticket-claim-1')).toBe(SESSION_B);
  // open 的责任随执行责任转给 Target；已回答的历史不动。
  expect(interactionOwner('interaction-open')).toBe(SESSION_B);
  expect(interactionOwner('interaction-answered')).toBe(SESSION_A);

  const handoff = store.query({ kind: 'execution-handoff', coordinationScopeId: SCOPE, handoffId: 'handoff-1' });
  if (handoff.kind === 'execution-handoff' && handoff.handoff !== null) {
    expect(handoff.handoff.phase).toBe('cutover');
    expect(handoff.handoff.handoffRevision).toBe(3);
  }
});

test('cutover 在 Target 已持有另一活跃 Claim 时整笔拒绝，Lease、interaction 与 claim 均不变', () => {
  createScope();
  activateSession();
  // 第二个 Session 由 Source 登记，再自己取得 Runtime Lease，才能成为可写的 Claim 所有者。
  expect(
    store.transact({
      kind: 'register-session',
      coordinationScopeId: SCOPE,
      expectedRevision: revisionOf(),
      writer: writer(SESSION_A),
      coordinatorSessionId: SESSION_B,
      coordinatorModelConfigurationRef: 'profile-session-b',
      lifecycleState: 'registered',
    }).kind,
  ).toBe('committed');
  expect(
    store.transact({
      kind: 'acquire-runtime-lease',
      coordinationScopeId: SCOPE,
      expectedRevision: revisionOf(),
      writer: writer(SESSION_B, 0),
      ttlMs: 30_000,
    }).kind,
  ).toBe('committed');
  acquireExecutionLease();
  recordTicketClaim('ticket-source', SESSION_A);
  recordTicketClaim('ticket-target', SESSION_B);
  recordOpenInteraction('interaction-open', SESSION_A);

  submit((expectedRevision) => handoffCommand(expectedRevision, null, 'prepared'));
  submit((expectedRevision) => handoffCommand(expectedRevision, 1, 'reviewed'));
  const before = activeExecutionLease();

  const cutover = cutoverHandoff(revisionOf(), 2);
  expect(cutover.kind).toBe('rejected');
  if (cutover.kind === 'rejected') {
    expect(cutover.code).toBe('constraint');
  }

  // 目标已持票时整笔回滚：Source 仍是唯一执行责任方，两张票的归属都保持原样。
  expect(activeExecutionLease().holder).toBe(SESSION_A);
  expect(activeExecutionLease().generation).toBe(before.generation);
  expect(interactionOwner('interaction-open')).toBe(SESSION_A);
  expect(ticketClaimOwner('ticket-source')).toBe(SESSION_A);
  expect(ticketClaimOwner('ticket-target')).toBe(SESSION_B);
  const handoff = store.query({ kind: 'execution-handoff', coordinationScopeId: SCOPE, handoffId: 'handoff-1' });
  if (handoff.kind === 'execution-handoff' && handoff.handoff !== null) {
    expect(handoff.handoff.phase).toBe('reviewed');
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

const SPEC_BINDING = {
  provider: 'openspec',
  relativePath: 'openspec/changes/wp-1',
  contentDigest: 'digest-1',
  providerVersion: '1',
  contractRevision: 1,
  trackingRevision: 1,
} satisfies SpecBinding;

function bindingsOf(): readonly MaterializationBindingRecord[] {
  const result = store.query({ kind: 'materialization-bindings', coordinationScopeId: SCOPE });
  return result.kind === 'materialization-bindings' ? result.bindings : [];
}

/** 派发时必须钉住的模型授权身份；缺任何一项的写入由 store 拒绝。 */
const AUTHORIZATION_PIN = {
  authorizationId: 'auth-1',
  authorizationVersion: 1,
  workerProfileRef: 'profile-implementation',
} as const;

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

test('migration v10 → v11 保留旧物化绑定并只在缺身份时标为 legacy', () => {
  const databasePath = join(directory, 'coordination-v10.sqlite');

  // 只用 v10 及更早的 migration 建库：那时每个 Work Package 只有一行 Orca Task 指针。
  const legacy = new DatabaseSync(databasePath);
  legacy.exec('BEGIN IMMEDIATE');
  for (const migration of MIGRATIONS) {
    if (migration.version > 10) {
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
         authorization_id, authorization_version, map_revision, revision, updated_at,
         full_branch_ref, canonical_worktree_path
       ) VALUES (?, 'execution_coordination', 'active', 'cycle-1', 'g1', 1, 'auth-1', 1, 0, 3, 1, ?, ?)`,
    )
    .run('scope-migrated', 'refs/heads/migrated', '/tmp/orca-migrated');
  legacy
    .prepare(
      `INSERT INTO materialization_bindings (
         coordination_scope_id, work_package_id, orca_task_id, creation_operation_id, created_at
       ) VALUES ('scope-migrated', 'wp-1', 'orca-task-legacy', 'op-legacy', 1)`,
    )
    .run();
  // 迁移后的追加写入必须是受控写入者：先放进一个活跃的 Runtime Lease 与 Execution Lease。
  legacy
    .prepare(
      `INSERT INTO leases (
         coordination_scope_id, lease_kind, coordinator_session_id, runtime_incarnation_id,
         fencing_generation, acquired_at, expires_at, released_at
       ) VALUES ('scope-migrated', 'runtime', 'session-a', 'inc-a', 1, 1, NULL, NULL)`,
    )
    .run();
  legacy
    .prepare(
      `INSERT INTO leases (
         coordination_scope_id, lease_kind, coordinator_session_id, runtime_incarnation_id,
         fencing_generation, acquired_at, expires_at, released_at
       ) VALUES ('scope-migrated', 'execution_coordination', 'session-a', 'inc-a', 1, 1, NULL, NULL)`,
    )
    .run();
  legacy.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', '10')`).run();
  legacy.exec('COMMIT');
  legacy.close();

  const migrated = openCoordinationStore({ databasePath, clock });
  if (migrated.kind !== 'opened') {
    throw new Error(migrated.message);
  }
  try {
    const scopeId = 'scope-migrated' as CoordinationScopeId;
    const result = migrated.store.query({
      kind: 'materialization-bindings',
      coordinationScopeId: scopeId,
      workPackageId: 'wp-1' as WorkPackageId,
    });
    expect(result.kind).toBe('materialization-bindings');
    if (result.kind !== 'materialization-bindings') {
      return;
    }
    // 旧行保留原来的 Orca Task 与创建 OperationId。
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]?.orcaTaskId).toBe('orca-task-legacy');
    expect(result.bindings[0]?.creationOperationId).toBe('op-legacy');
    // 新增身份列一律为空，并被显式标成 legacy：读取方不得据此推断角色。
    expect(result.bindings[0]?.identity).toBe('legacy');
    expect(result.bindings[0]?.role).toBeNull();
    expect(result.bindings[0]?.workerTaskId).toBeNull();
    expect(result.bindings[0]?.dispatchId).toBeNull();
    expect(result.bindings[0]?.attemptId).toBeNull();
    expect(result.bindings[0]?.worktreeId).toBeNull();
    expect(result.bindings[0]?.specBinding).toBeNull();
    expect(result.bindings[0]?.specificationUnitPath).toBeNull();
    expect(result.bindings[0]?.launchId).toBeNull();
    // schema 16 新增的模型授权三列对旧行保持为空：当时没有这项事实，不做推断回填。
    expect(result.bindings[0]?.authorizationId).toBeNull();
    expect(result.bindings[0]?.authorizationVersion).toBeNull();
    expect(result.bindings[0]?.workerProfileRef).toBeNull();

    // 新主键允许同一 Work Package 追加第二个角色的派发身份，旧行不被覆盖。
    const appended = migrated.store.transact({
      kind: 'record-materialization-binding',
      coordinationScopeId: scopeId,
      expectedRevision: 3,
      writer: {
        coordinatorSessionId: 'session-a' as CoordinatorSessionId,
        runtimeIncarnationId: 'inc-a' as RuntimeIncarnationId,
        fencingGeneration: 1,
      },
      workPackageId: 'wp-1' as WorkPackageId,
      role: 'validator',
      workerTaskId: 'worker-task-1' as WorkerTaskId,
      dispatchId: 'dispatch-1' as DispatchId,
      attemptId: 'attempt-1',
      worktreeId: 'worktree-1',
      specBinding: SPEC_BINDING,
      specificationUnitPath: null,
      orcaTaskId: 'orca-task-1',
      launchId: 'launch-1',
      creationOperationId: 'op-1' as OperationId,
      ...AUTHORIZATION_PIN,
    });
    expect(appended.kind).toBe('committed');
    const after = migrated.store.query({
      kind: 'materialization-bindings',
      coordinationScopeId: scopeId,
    });
    expect(after.kind === 'materialization-bindings' ? after.bindings.length : -1).toBe(2);
  } finally {
    migrated.store.close();
  }

  const version = new DatabaseSync(databasePath, { readOnly: true });
  const row = version
    .prepare(`SELECT value FROM meta WHERE key = 'schema_version'`)
    .get() as unknown as { readonly value: string } | undefined;
  version.close();
  expect(Number.parseInt(row?.value ?? '', 10)).toBe(SCHEMA_VERSION);
});

test('migration v15 → v16 保留已签发派发身份，模型授权列保持为空', () => {
  const databasePath = join(directory, 'coordination-v15.sqlite');

  const legacy = new DatabaseSync(databasePath);
  legacy.exec('BEGIN IMMEDIATE');
  for (const migration of MIGRATIONS) {
    if (migration.version <= 15) {
      for (const statement of migration.statements) legacy.exec(statement);
    }
  }
  legacy.exec(
    `INSERT INTO scope (coordination_scope_id, mode, control_state, planning_cycle_id, graph_id,
       graph_version, authorization_id, authorization_version, map_revision, revision, updated_at,
       full_branch_ref, canonical_worktree_path)
     VALUES ('scope-v15', 'execution_coordination', 'active', 'cycle-1', 'g1', 1, 'auth-1', 1, 0, 3, 1,
       'refs/heads/main', '/tmp/v15')`,
  );
  legacy.exec(
    `INSERT INTO materialization_bindings (coordination_scope_id, work_package_id, creation_operation_id,
       role, worker_task_id, dispatch_id, attempt_id, worktree_id, spec_binding_json,
       specification_unit_path, orca_task_id, launch_id, created_at)
     VALUES ('scope-v15', 'wp-1', 'op-issued', 'implementation', 'task-1', 'dispatch-1', 'attempt-1',
       'worktree-1', '${JSON.stringify(SPEC_BINDING)}', NULL, 'orca-task-1', 'launch-1', 1)`,
  );
  legacy.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', '15')`).run();
  legacy.exec('COMMIT');
  legacy.close();

  const migrated = openCoordinationStore({ databasePath, clock });
  expect(migrated.kind).toBe('opened');
  if (migrated.kind !== 'opened') return;
  try {
    const scopeId = 'scope-v15' as CoordinationScopeId;
    const read = migrated.store.query({ kind: 'materialization-bindings', coordinationScopeId: scopeId });
    expect(read.kind).toBe('materialization-bindings');
    if (read.kind !== 'materialization-bindings') return;
    const binding = read.bindings[0];
    // 已证明的派发身份原样保留。
    expect(binding?.identity).toBe('issued');
    expect(binding?.role).toBe('implementation');
    expect(binding?.attemptId).toBe('attempt-1');
    expect(binding?.launchId).toBe('launch-1');
    expect(binding?.specBinding?.contentDigest).toBe(SPEC_BINDING.contentDigest);
    // 模型授权三列与 utility 身份保持为空：当时没有这项事实，不回填成当前授权或当前 profile。
    expect(binding?.authorizationId).toBeNull();
    expect(binding?.authorizationVersion).toBeNull();
    expect(binding?.workerProfileRef).toBeNull();
    expect(binding?.recoveryUtilityRole).toBeNull();
  } finally {
    migrated.store.close();
  }
});

test('record-validation-attempt 记录有界游标：绑定按角色身份证明、按序追加、terminal 一次写入', () => {
  createScope();
  activateSession();
  acquireExecutionLease();

  const bind = submit((expectedRevision) => ({
    kind: 'record-materialization-binding',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(SESSION_A),
    workPackageId: 'wp-1' as WorkPackageId,
    role: 'validator',
    workerTaskId: 'worker-task-1' as WorkerTaskId,
    // Task Envelope 预发的本地 alias，与 Orca 实际 dispatch 不是同一个值。
    dispatchId: 'envelope-dispatch-1' as DispatchId,
    attemptId: 'attempt-1',
    worktreeId: 'worktree-1',
    specBinding: SPEC_BINDING,
    specificationUnitPath: null,
    orcaTaskId: 'orca-task-1',
    launchId: 'launch-1',
    creationOperationId: 'op-binding-1' as OperationId,
    ...AUTHORIZATION_PIN,
  }));
  expect(bind.kind).toBe('committed');

  const providerSessionId = 'provider-session-1';
  const actualDispatchId = 'dispatch-orca-1' as DispatchId;
  const segment = submit((expectedRevision) => ({
    kind: 'record-session-segment',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(SESSION_A),
    segmentId: 'segment-va-1' as SessionSegmentId,
    workPackageId: 'wp-1' as WorkPackageId,
    role: 'validator',
    workerTaskId: 'worker-task-1' as WorkerTaskId,
    dispatchId: actualDispatchId,
    attemptId: 'attempt-1',
    sessionBindingId: sessionBindingIdOf(actualDispatchId, providerSessionId),
    lastTranscriptRef: 'transcript:1',
    terminalReceiptRef: null,
    transcriptReferenceable: true,
    verifiable: true,
  }));
  expect(segment.kind).toBe('committed');

  const record = (overrides: Record<string, unknown>): CoordinationCommandResult =>
    submit((expectedRevision) => ({
      kind: 'record-validation-attempt',
      coordinationScopeId: SCOPE,
      expectedRevision,
      writer: writer(SESSION_A),
      validationAttemptId: 'attempt-1',
      workPackageId: 'wp-1' as WorkPackageId,
      workerTaskId: 'worker-task-1' as WorkerTaskId,
      dispatchId: actualDispatchId,
      providerSessionId,
      initialRepairConsumed: 0,
      messageIds: ['m1'],
      ...overrides,
    }));

  expect(record({}).kind).toBe('committed');
  expect(store.query({ kind: 'validation-attempt', coordinationScopeId: SCOPE, dispatchId: actualDispatchId }))
    .toMatchObject({ kind: 'validation-attempt', attempt: { messageIds: ['m1'], terminalQuestionMessageId: null } });
  expect(record({ messageIds: ['m1', 'm2'] }).kind).toBe('committed');
  expect(record({ messageIds: ['m1', 'm2'] }).kind).toBe('committed');
  expect(record({ messageIds: ['m2'] }).kind).toBe('rejected');
  expect(record({ messageIds: ['m1', 'm2'], providerSessionId: 'other-session' }).kind).toBe('rejected');
  expect(record({ messageIds: ['m1', 'm2'], initialRepairConsumed: 1 }).kind).toBe('rejected');
  expect(record({ messageIds: ['m1', 'm2'], workerTaskId: 'worker-task-other' }).kind).toBe('rejected');
  expect(record({ messageIds: ['m1', 'm2'], terminalQuestionMessageId: 'q1' }).kind).toBe('committed');
  expect(record({ messageIds: ['m1', 'm2'], terminalQuestionMessageId: 'q2' }).kind).toBe('rejected');
  expect(store.query({ kind: 'validation-attempt', coordinationScopeId: SCOPE, dispatchId: actualDispatchId }))
    .toMatchObject({ kind: 'validation-attempt', attempt: { messageIds: ['m1', 'm2'], terminalQuestionMessageId: 'q1', initialRepairConsumed: 0, providerSessionId } });
  expect(store.query({ kind: 'validation-attempt', coordinationScopeId: SCOPE, dispatchId: 'missing' as DispatchId }))
    .toEqual({ kind: 'validation-attempt', attempt: null });
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
          integrationReconciliations: 2,
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
    initialPlan: implementationPlanFor(executionGraph(graphId), 1),
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
    initialPlan: null,
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
    initialPlan: implementationPlanFor(executionGraph(), 1),
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

test('图修订退场的节点与图版本同事务释放修订持有，仍在图里的持有保持 pending', () => {
  createScope();
  activateSession();
  recordInitialGraph();
  acquireExecutionLease();

  // 先给图里两个节点各落一个 pending 持有：带基数语义的那种「修正在途节点」。
  for (const workPackageId of ['wp-1', 'wp-2'] as WorkPackageId[]) {
    const recorded = submit((expectedRevision) => ({
      kind: 'record-revision-hold',
      coordinationScopeId: SCOPE,
      expectedRevision,
      writer: writer(),
      workPackageId,
      source: 'graph_patch',
      sourceRef: 'graph-patch:setup',
    }));
    expect(recorded.kind).toBe('committed');
  }

  // 接受一份把 wp-1 退场、保留 wp-2 的版本：退场节点的持有必须在同一事务里释放，否则整个 Scope 会
  // 永久停在 revision_pending（真实运行里 Git 侧早已集成成功，Finalizer 门禁却再也不满足）。
  const retired = submit((expectedRevision) =>
    acceptedRevisionCommand(expectedRevision, {
      graphVersion: 2,
      parentVersion: 1,
      graph: {
        ...executionGraph(),
        workPackages: [
          { ...executionGraph().workPackages[0], workPackageId: 'wp-2' as WorkPackageId },
        ],
      },
      patch: {
        patchId: 'patch-2',
        operationId: 'op-2' as OperationId,
        baseGraphVersion: 1 as GraphVersion,
        added: [],
        revised: [],
        retired: ['wp-1' as WorkPackageId],
        descendants: [],
        takesOver: [],
        revisionPendingWorkPackageIds: [],
      },
    }),
  );
  expect(retired.kind).toBe('committed');

  const holds = store.query({ kind: 'revision-holds', coordinationScopeId: SCOPE });
  expect(holds.kind === 'revision-holds' ? holds.holds : null).toEqual([
    expect.objectContaining({ workPackageId: 'wp-1', state: 'released' }),
    expect.objectContaining({ workPackageId: 'wp-2', state: 'pending' }),
  ]);
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

  const release = (approvedLimit = 2): CoordinationCommandResult =>
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
      approvedLimit,
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

test('旧内容版本只能在匹配来源的持有上准备一次，重新登记持有会清空版本边界', () => {
  createScope();
  activateSession();
  recordInitialGraph();
  acquireExecutionLease();
  const record = (sourceRef: string): CoordinationCommandResult =>
    submit((expectedRevision) => ({
      kind: 'record-revision-hold',
      coordinationScopeId: SCOPE,
      expectedRevision,
      writer: writer(),
      workPackageId: 'wp-1' as WorkPackageId,
      source: 'graph_patch',
      sourceRef,
    }));
  const prepare = (sourceRef: string, priorContractRevision: number): CoordinationCommandResult =>
    submit((expectedRevision) => ({
      kind: 'prepare-revision-hold',
      coordinationScopeId: SCOPE,
      expectedRevision,
      writer: writer(),
      workPackageId: 'wp-1' as WorkPackageId,
      sourceRef,
      priorContractRevision,
    }));
  const hold = () => {
    const holds = store.query({ kind: 'revision-holds', coordinationScopeId: SCOPE });
    return holds.kind === 'revision-holds' ? holds.holds[0] : undefined;
  };

  expect(record('patch-1').kind).toBe('committed');
  expect(hold()?.priorContractRevision).toBeNull();
  expect(prepare('patch-1', 3).kind).toBe('committed');
  expect(prepare('patch-1', 3).kind).toBe('committed');
  expect(hold()?.priorContractRevision).toBe(3);
  // 版本边界一旦写下就不因重放而漂移；另一个来源也不能准备别人的持有。
  expect(prepare('patch-1', 4).kind).toBe('rejected');
  expect(prepare('patch-2', 3).kind).toBe('rejected');
  expect(hold()?.priorContractRevision).toBe(3);

  // 重新登记新补丁：两列回到未准备、未结算。
  expect(record('patch-2').kind).toBe('committed');
  expect(hold()?.priorContractRevision).toBeNull();
  expect(hold()?.admittedContractRevision).toBeNull();
});

test('图版本重新登记持有会刷新登记时刻：上一版本链的交付不再被当成本次修订的交付', () => {
  createScope();
  activateSession();
  recordInitialGraph();
  acquireExecutionLease();
  const hold = () => {
    const holds = store.query({ kind: 'revision-holds', coordinationScopeId: SCOPE });
    return holds.kind === 'revision-holds' ? holds.holds[0] : undefined;
  };
  const recordRevision = (graphVersion: number, sourceRef: string): CoordinationCommandResult =>
    submit((expectedRevision) =>
      acceptedRevisionCommand(expectedRevision, {
        graphVersion,
        parentVersion: graphVersion - 1,
        patch: {
          patchId: sourceRef,
          operationId: 'op-1' as OperationId,
          baseGraphVersion: graphVersion - 1,
          added: [],
          revised: ['wp-1' as WorkPackageId],
          retired: [],
          descendants: [],
          takesOver: [],
          revisionPendingWorkPackageIds: ['wp-1' as WorkPackageId],
        },
      }),
    );

  // 第一次修订：持有登记 → 准备被替换的内容版本 → 按重新准入结算。
  now = 5_000;
  expect(recordRevision(2, 'patch-1').kind).toBe('committed');
  expect(hold()?.createdAt).toBe(5_000);
  expect(
    submit((expectedRevision) => ({
      kind: 'prepare-revision-hold',
      coordinationScopeId: SCOPE,
      expectedRevision,
      writer: writer(),
      workPackageId: 'wp-1' as WorkPackageId,
      sourceRef: 'patch-1',
      priorContractRevision: 3,
    })).kind,
  ).toBe('committed');
  expect(
    submit((expectedRevision) => ({
      kind: 'release-revision-hold',
      coordinationScopeId: SCOPE,
      expectedRevision,
      writer: writer(),
      workPackageId: 'wp-1' as WorkPackageId,
      reason: '重新准入',
      expectedSourceRef: 'patch-1',
      admittedContractRevision: 3,
    })).kind,
  ).toBe('committed');
  expect(hold()?.state).toBe('released');
  expect(hold()?.admittedContractRevision).toBe(3);

  // 第二个补丁重新登记同一个节点的持有：这是一次**新的**登记。登记的 `created_at` 是修订 Planner
  // 派发先后关系的唯一判据（`plannerDeliveryAfterHold`）：保留第一次的旧时间戳会把上一个版本链
  // 已结算的 Planner 交付读成本次修订的交付，于是派发门禁拒绝续办、持有结算又因为内容版本没有准备
  // 而跳过，Scope 永久停在 revision_pending（真实运行实测）。
  now = 9_000;
  expect(recordRevision(3, 'patch-2').kind).toBe('committed');
  expect(hold()?.sourceRef).toBe('patch-2');
  expect(hold()?.state).toBe('pending');
  expect(hold()?.createdAt).toBe(9_000);
  expect(hold()?.priorContractRevision).toBeNull();
  expect(hold()?.admittedContractRevision).toBeNull();
});

test('按重新准入结算记录接纳版本：接纳版本可与被替换版本相同，来源不符一律拒绝且零写入', () => {
  createScope();
  activateSession();
  recordInitialGraph();
  acquireExecutionLease();
  submit((expectedRevision) => ({
    kind: 'record-revision-hold',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(),
    workPackageId: 'wp-1' as WorkPackageId,
    source: 'graph_patch',
    sourceRef: 'patch-1',
  }));
  submit((expectedRevision) => ({
    kind: 'prepare-revision-hold',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(),
    workPackageId: 'wp-1' as WorkPackageId,
    sourceRef: 'patch-1',
    priorContractRevision: 3,
  }));
  const settle = (admittedContractRevision: number): CoordinationCommandResult =>
    submit((expectedRevision) => ({
      kind: 'release-revision-hold',
      coordinationScopeId: SCOPE,
      expectedRevision,
      writer: writer(),
      workPackageId: 'wp-1' as WorkPackageId,
      reason: '重新准入',
      expectedSourceRef: 'patch-1',
      admittedContractRevision,
    }));
  const hold = () => {
    const holds = store.query({ kind: 'revision-holds', coordinationScopeId: SCOPE });
    return holds.kind === 'revision-holds' ? holds.holds[0] : undefined;
  };

  // 只改契约（例如依赖）的修订、或 Planner 原样交付同一份内容时，接纳版本与被替换版本相同：
  // 这仍然是一次修订，持有必须释放并记录接纳版本。
  expect(settle(3).kind).toBe('committed');
  expect(hold()?.state).toBe('released');
  expect(hold()?.admittedContractRevision).toBe(3);
  // 同一次结算的重放幂等；另一个接纳版本不能改写已经落下的记录。
  expect(settle(3).kind).toBe('committed');
  expect(settle(4).kind).toBe('rejected');
  expect(hold()?.admittedContractRevision).toBe(3);

  // 来源不符：另一个补丁的收尾不能释放这份持有，也不写任何字段。
  submit((expectedRevision) => ({
    kind: 'record-revision-hold',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(),
    workPackageId: 'wp-2' as WorkPackageId,
    source: 'graph_patch',
    sourceRef: 'patch-1',
  }));
  submit((expectedRevision) => ({
    kind: 'prepare-revision-hold',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(),
    workPackageId: 'wp-2' as WorkPackageId,
    sourceRef: 'patch-1',
    priorContractRevision: 5,
  }));
  const mismatched = submit((expectedRevision) => ({
    kind: 'release-revision-hold',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(),
    workPackageId: 'wp-2' as WorkPackageId,
    reason: '重新准入',
    expectedSourceRef: 'patch-9',
    admittedContractRevision: 6,
  }));
  expect(mismatched.kind).toBe('rejected');
  const holds = store.query({ kind: 'revision-holds', coordinationScopeId: SCOPE });
  expect(holds.kind === 'revision-holds' ? holds.holds.map((entry) => [entry.workPackageId, entry.state, entry.admittedContractRevision]) : null).toEqual([
    ['wp-1', 'released', 3],
    ['wp-2', 'pending', null],
  ]);
});

test('结算拒绝越过已批准的修订额度上限', () => {
  createScope();
  activateSession();
  recordInitialGraph();
  acquireExecutionLease();
  const budgetKey = 'work-package:wp-1:specificationRevisions';
  submit((expectedRevision) => ({
    kind: 'record-revision-hold',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(),
    workPackageId: 'wp-1' as WorkPackageId,
    source: 'graph_patch',
    sourceRef: 'patch-1',
  }));
  submit((expectedRevision) => ({
    kind: 'prepare-revision-hold',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(),
    workPackageId: 'wp-1' as WorkPackageId,
    sourceRef: 'patch-1',
    priorContractRevision: 1,
  }));

  // 上限为 1 时第一次结算消耗掉唯一一次；随后的结算（同键、同授权）必须被拒绝而不是记到 2。
  const settle = (admittedContractRevision: number): CoordinationCommandResult =>
    submit((expectedRevision) => ({
      kind: 'release-revision-hold',
      coordinationScopeId: SCOPE,
      expectedRevision,
      writer: writer(),
      workPackageId: 'wp-1' as WorkPackageId,
      reason: '重新准入',
      expectedSourceRef: 'patch-1',
      admittedContractRevision,
      budgetConsumption: [{ budgetKey, approvedLimitRef: 'auth-1', amount: 1 }],
      approvedLimit: 1,
    }));
  expect(settle(2).kind).toBe('committed');
  const counters = store.query({ kind: 'budget-counters', coordinationScopeId: SCOPE });
  expect(counters.kind === 'budget-counters' ? counters.counters : null).toEqual([
    expect.objectContaining({ budgetKey, consumed: 1 }),
  ]);

  // 另一个节点在同一限额下再结算：累计会越界，因此整笔拒绝（持有保持 pending）。
  submit((expectedRevision) => ({
    kind: 'record-revision-hold',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(),
    workPackageId: 'wp-2' as WorkPackageId,
    source: 'graph_patch',
    sourceRef: 'patch-1',
  }));
  submit((expectedRevision) => ({
    kind: 'prepare-revision-hold',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(),
    workPackageId: 'wp-2' as WorkPackageId,
    sourceRef: 'patch-1',
    priorContractRevision: 1,
  }));
  const overLimit = submit((expectedRevision) => ({
    kind: 'release-revision-hold',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(),
    workPackageId: 'wp-2' as WorkPackageId,
    reason: '重新准入',
    expectedSourceRef: 'patch-1',
    admittedContractRevision: 2,
    budgetConsumption: [{ budgetKey, approvedLimitRef: 'auth-1', amount: 1 }],
    approvedLimit: 1,
  }));
  expect(overLimit.kind).toBe('rejected');
  const holds = store.query({ kind: 'revision-holds', coordinationScopeId: SCOPE });
  expect(holds.kind === 'revision-holds' ? holds.holds.map((entry) => [entry.workPackageId, entry.state]) : null).toEqual([
    ['wp-1', 'released'],
    ['wp-2', 'pending'],
  ]);
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

// IC-03 Extend / IC-11：全代际图历史目录、追加链成员校验与依据正文有界读取（schema 17）。

/** 登记一个候选代际并写下它的 v1，让目录能同时看到多代。 */
function recordGeneration(graphId: GraphId, generation: number, predecessorGraphId: GraphId | null): void {
  // 图负载里的 generation 必须与索引列一致：共用夹具 `executionGraph` 固定为第 1 代，这里按代际改写。
  const graph = { ...executionGraph(graphId), generation: generation as GraphGeneration };
  const registered = submit((expectedRevision) => ({
    kind: 'record-graph-generation',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(),
    graphId,
    generation: generation as GraphGeneration,
    planningCycleId: `cycle-${generation}` as PlanningCycleId,
    orcaRunId: `run-${generation}`,
    predecessorGraphId,
    baselineHead: `head-${generation}`,
  }));
  if (registered.kind !== 'committed') {
    throw new Error(`无法登记代际 ${generation}: ${JSON.stringify(registered)}`);
  }
  const recorded = submit((expectedRevision) => ({
    kind: 'record-graph-version',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(),
    graphId,
    generation: generation as GraphGeneration,
    graphVersion: 1 as GraphVersion,
    recordKind: 'initial',
    parentVersion: null,
    mapRevision: 0,
    planRevision: 1,
    orcaRunId: `run-${generation}`,
    graph,
    patch: null,
    initialPlan: implementationPlanFor(graph, 1),
  }));
  if (recorded.kind !== 'committed') {
    throw new Error(`无法记录代际 ${generation} 的初始图: ${JSON.stringify(recorded)}`);
  }
}

test('图版本目录跨全部代际分页，只认 Scope 指针所指的那一条为当前', () => {
  createScope();
  activateSession();
  // 三代共 24 个版本，超过单页 20 项，用来同时验证分页上限与跨代际排序。
  for (let generation = 1; generation <= 3; generation += 1) {
    recordGeneration(`graph-${generation}` as GraphId, generation, generation === 1 ? null : (`graph-${generation - 1}` as GraphId));
  }
  // 本用例验证只读目录；历史夹具直接播种，生产追加授权/lease在图演进测试验证。
  const database = new DatabaseSync(join(directory, 'coordination.sqlite'));
  const append = database.prepare(`INSERT INTO graph_versions
    (coordination_scope_id, graph_id, graph_version, graph_generation, record_kind, parent_version,
     map_revision, plan_revision, orca_run_id, graph_json, patch_id, recorded_at)
    VALUES (?, ?, ?, ?, 'accepted_revision', ?, 0, 1, ?, ?, ?, 1)`);
  for (let generation = 1; generation <= 3; generation += 1) {
    const graphId = `graph-${generation}` as GraphId;
    for (let version = 2; version <= 8; version += 1) {
      append.run(SCOPE, graphId, version, generation, version - 1, `run-${generation}`,
        JSON.stringify({ ...executionGraph(graphId), generation }), `patch-${generation}-${version}`);
    }
  }
  database.prepare('UPDATE scope SET graph_id = ?, graph_version = ? WHERE coordination_scope_id = ?').run('graph-1', 4, SCOPE);
  database.close();

  const seen: { graphId: string; version: number; current: boolean; status: string | null }[] = [];
  let cursor: { generation: number; graphId: string; version: number } | undefined;
  for (let page = 0; page < 5; page += 1) {
    const result = store.query({
      kind: 'graph-version-index',
      coordinationScopeId: SCOPE,
      ...(cursor === undefined ? {} : { after: cursor }),
    });
    if (result.kind !== 'graph-version-index') {
      throw new Error(`目录第 ${page} 页不可读: ${result.kind}`);
    }
    expect(result.items.length).toBeLessThanOrEqual(20);
    for (const item of result.items) {
      seen.push({ graphId: item.graphId, version: item.version, current: item.current, status: item.generationStatus });
    }
    if (result.nextCursor === null) {
      break;
    }
    cursor = result.nextCursor;
  }

  expect(seen).toHaveLength(24);
  // 每页 ≤20 且无重复无遗漏。
  expect(new Set(seen.map((entry) => `${entry.graphId}#${entry.version}`)).size).toBe(24);
  // 目录按代际倒序：先看到最新的第 3 代。
  expect(seen[0]?.graphId).toBe('graph-3');
  // 当前只取 Scope 指针，与各图 head 无关。
  expect(seen.filter((entry) => entry.current).map((entry) => `${entry.graphId}#${entry.version}`)).toEqual(['graph-1#4']);
  // 代际状态取自 graph_generations 的真实登记值，而不是按版本新旧推断。
  expect(new Set(seen.map((entry) => entry.status))).toEqual(new Set(['candidate']));
});

test('追加链成员校验只认连续链，出现缺口与错父指针一律拒绝', () => {
  createScope();
  activateSession();
  recordGeneration(GRAPH_ID, 1, null);
  // v2/v3 直接写库：accepted_revision 的生产路径要 Execution Coordination Lease 与批准授权，而本用例
  // 要构造的是**库内被破坏的链**（缺口、错父指针），这些状态在正常写入下不可能出现。
  const database = new DatabaseSync(join(directory, 'coordination.sqlite'));
  const insertVersion = database.prepare(
    `INSERT INTO graph_versions (coordination_scope_id, graph_id, graph_version, graph_generation, record_kind,
       parent_version, map_revision, plan_revision, orca_run_id, graph_json, patch_id, patch_json, recorded_at)
     VALUES ('scope-1', ?, ?, 1, 'accepted_revision', ?, 0, 1, 'run-1', ?, ?, '{"patchId":"p"}', 1)`,
  );
  insertVersion.run(GRAPH_ID, 2, 1, JSON.stringify(executionGraph(GRAPH_ID)), 'p-2');
  insertVersion.run(GRAPH_ID, 3, 2, JSON.stringify(executionGraph(GRAPH_ID)), 'p-3');

  const members = store.query({
    kind: 'graph-version-membership',
    coordinationScopeId: SCOPE,
    graphId: GRAPH_ID,
    head: 3 as GraphVersion,
    versions: [3 as GraphVersion, 1 as GraphVersion],
  });
  expect(members.kind === 'graph-version-membership' ? members.members.map((entry) => entry.version) : null).toEqual([3, 1]);

  // head 必须是真实 head：用过期 head 判定成员等于凭空扩大自己的授权范围。
  expect(store.query({
    kind: 'graph-version-membership',
    coordinationScopeId: SCOPE,
    graphId: GRAPH_ID,
    head: 2 as GraphVersion,
    versions: [1 as GraphVersion],
  }).kind).toBe('rejected');

  // 链上出现洞：直接删掉中间一条，聚合校验必须发现 total !== hi。
  // 链上出现洞：删掉中间一条，聚合校验必须发现 total !== hi。
  database.exec('DELETE FROM graph_versions WHERE graph_version = 2');
  database.close();
  const holed = store.query({
    kind: 'graph-version-membership',
    coordinationScopeId: SCOPE,
    graphId: GRAPH_ID,
    head: 3 as GraphVersion,
    versions: [1 as GraphVersion, 3 as GraphVersion],
  });
  expect(holed.kind).toBe('rejected');
});

test('追加链父指针与前一条对不上时拒绝成员判定', () => {
  createScope();
  activateSession();
  recordGeneration(GRAPH_ID, 1, null);
  const database = new DatabaseSync(join(directory, 'coordination.sqlite'));
  const insertVersion = database.prepare(
    `INSERT INTO graph_versions (coordination_scope_id, graph_id, graph_version, graph_generation, record_kind,
       parent_version, map_revision, plan_revision, orca_run_id, graph_json, patch_id, patch_json, recorded_at)
     VALUES ('scope-1', ?, ?, 1, 'accepted_revision', ?, 0, 1, 'run-1', ?, ?, '{"patchId":"p"}', 1)`,
  );
  insertVersion.run(GRAPH_ID, 2, 1, JSON.stringify(executionGraph(GRAPH_ID)), 'p-2');
  // 版本号连续，但 v2 的父指向 v1 之外：链在语义上断开，聚合的 broken 计数必须捕获。
  insertVersion.run(GRAPH_ID, 3, 1, JSON.stringify(executionGraph(GRAPH_ID)), 'p-3');
  database.close();

  const broken = store.query({
    kind: 'graph-version-membership',
    coordinationScopeId: SCOPE,
    graphId: GRAPH_ID,
    head: 3 as GraphVersion,
    versions: [1 as GraphVersion, 3 as GraphVersion],
  });
  expect(broken.kind).toBe('rejected');
});

test('原编译计划与图版本同事务保存，长中文正文按 UTF-8 边界分页可完整读回', () => {
  createScope();
  activateSession();
  // 一份超长中文计划：正文远大于单页 64 KiB，且每个字符三字节，边界必然落在多字节中间。
  const longTitle = '编'.repeat(40_000);
  const graph = executionGraph(GRAPH_ID);
  const plan = {
    ...implementationPlanFor(graph, 1),
    workPackages: [{ key: 'wp-1', title: longTitle, dependsOn: [], scopeEnvelope: { include: ['src/a.ts'], exclude: [] } }],
  };
  const recorded = submit((expectedRevision) => ({
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
    graph,
    patch: null,
    initialPlan: plan,
  }));
  expect(recorded.kind).toBe('committed');

  const source = { kind: 'initial_plan' as const, graphId: GRAPH_ID, generation: 1 as GraphGeneration, version: 1 as GraphVersion };
  let offset = 0;
  let rebuilt = '';
  for (let page = 0; page < 20; page += 1) {
    const chunk = store.query({ kind: 'graph-basis-range', coordinationScopeId: SCOPE, source, offset, maxBytes: 65_536 });
    if (chunk.kind !== 'graph-basis-range' || chunk.text === null) {
      throw new Error(`正文第 ${page} 段不可读: ${chunk.kind}`);
    }
    rebuilt += chunk.text;
    offset = chunk.end;
    if (offset >= chunk.byteLength) {
      break;
    }
  }
  expect(JSON.parse(rebuilt)).toEqual(plan);

  // 偏移越过正文末尾必须报边界错误，而不是退化成「正文缺失」。
  const overrun = store.query({ kind: 'graph-basis-range', coordinationScopeId: SCOPE, source, offset: 10_000_000, maxBytes: 4_096 });
  expect(overrun.kind === 'rejected' ? overrun.code : null).toBe('invalid_utf8_offset');

  // 代际属于身份：拿别代的引用来读必须被拒，而不是当成「没找到」。
  const wrongGeneration = store.query({
    kind: 'graph-basis-range',
    coordinationScopeId: SCOPE,
    source: { ...source, generation: 9 as GraphGeneration },
    offset: 0,
    maxBytes: 4_096,
  });
  expect(wrongGeneration.kind === 'rejected' ? wrongGeneration.code : null).toBe('invalid_query');
});

test('schema 16 之前的初始图没有原计划，按缺失呈现且不补写', () => {
  const databasePath = join(directory, 'coordination-legacy.sqlite');
  const legacy = new DatabaseSync(databasePath);
  legacy.exec('BEGIN IMMEDIATE');
  for (const migration of MIGRATIONS) {
    if (migration.version > 16) {
      continue;
    }
    for (const statement of migration.statements) {
      legacy.exec(statement);
    }
  }
  legacy.prepare(
    `INSERT INTO graph_versions (coordination_scope_id, graph_id, graph_version, graph_generation, record_kind,
       parent_version, map_revision, plan_revision, orca_run_id, graph_json, recorded_at)
     VALUES ('scope-1', ?, 1, 1, 'initial', NULL, 0, 1, 'run-1', ?, 1)`,
  ).run(GRAPH_ID, JSON.stringify(executionGraph(GRAPH_ID)));
  legacy.prepare(
    `INSERT INTO scope (coordination_scope_id, mode, control_state, planning_cycle_id, graph_id, graph_version,
       authorization_id, authorization_version, revision, updated_at)
     VALUES ('scope-1', 'execution_coordination', 'active', 'cycle-1', ?, 1, NULL, NULL, 1, 1)`,
  ).run(GRAPH_ID);
  legacy.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '16');
  legacy.exec('COMMIT');
  legacy.close();

  const migrated = openCoordinationStore({ databasePath, clock });
  if (migrated.kind !== 'opened') {
    throw new Error(`旧库无法升级: ${migrated.message}`);
  }
  try {
    // 迁移后这一行仍读不出原计划：schema 17 的列存在但为 NULL，不得回填，也不得从图反推。
    const basis = migrated.store.query({
      kind: 'graph-basis-range',
      coordinationScopeId: SCOPE,
      source: { kind: 'initial_plan', graphId: GRAPH_ID, generation: 1 as GraphGeneration, version: 1 as GraphVersion },
      offset: 0,
      maxBytes: 4_096,
    });
    expect(basis.kind === 'graph-basis-range' ? basis.found : null).toBe(false);
    expect(basis.kind === 'graph-basis-range' ? basis.byteLength : null).toBe(0);
    // 图版本本身仍完整可读：依据缺失不等于记录丢失。
    const versions = migrated.store.query({ kind: 'graph-versions', coordinationScopeId: SCOPE, graphId: GRAPH_ID });
    expect(versions.kind === 'graph-versions' ? versions.versions.length : null).toBe(1);
  } finally {
    migrated.store.close();
  }
});

test('terminal 创建类意图 accepted 落盘 terminalHandle：同值幂等、异值与错类别拒绝', () => {
  createScope();
  activateSession();

  expect(
    submit((expectedRevision) => ({
      kind: 'begin-intent',
      coordinationScopeId: SCOPE,
      expectedRevision,
      writer: writer(),
      operationId: 'op-terminal' as OperationId,
      target: { kind: 'worker-task', id: 'wp-1' },
      operationCategory: 'worker-terminal-prepare',
    })).kind,
  ).toBe('committed');
  expect(
    submit((expectedRevision) => ({
      kind: 'begin-intent',
      coordinationScopeId: SCOPE,
      expectedRevision,
      writer: writer(),
      operationId: 'op-run' as OperationId,
      target: { kind: 'orca_run', id: 'run-1' },
      operationCategory: 'run-create',
    })).kind,
  ).toBe('committed');

  expect(
    submit((expectedRevision) => ({
      kind: 'settle-intent',
      coordinationScopeId: SCOPE,
      expectedRevision,
      writer: writer(),
      operationId: 'op-run' as OperationId,
      outcomeClass: 'accepted',
      terminalHandle: 'term-x',
    })).kind,
  ).toBe('rejected');
  expect(
    submit((expectedRevision) => ({
      kind: 'settle-intent',
      coordinationScopeId: SCOPE,
      expectedRevision,
      writer: writer(),
      operationId: 'op-terminal' as OperationId,
      outcomeClass: 'rejected',
      terminalHandle: 'term-1',
    })).kind,
  ).toBe('rejected');

  expect(
    submit((expectedRevision) => ({
      kind: 'settle-intent',
      coordinationScopeId: SCOPE,
      expectedRevision,
      writer: writer(),
      operationId: 'op-terminal' as OperationId,
      outcomeClass: 'accepted',
      backendRequestId: 'req-1',
      terminalHandle: 'term-1',
    })).kind,
  ).toBe('committed');
  const read = store.query({ kind: 'intent', coordinationScopeId: SCOPE, operationId: 'op-terminal' as OperationId });
  expect(read.kind === 'intent' ? read.intent?.terminalHandle : null).toBe('term-1');
  expect(read.kind === 'intent' ? read.intent?.outcomeClass : null).toBe('accepted');

  expect(
    submit((expectedRevision) => ({
      kind: 'settle-intent',
      coordinationScopeId: SCOPE,
      expectedRevision,
      writer: writer(),
      operationId: 'op-terminal' as OperationId,
      outcomeClass: 'accepted',
      backendRequestId: 'req-1',
      terminalHandle: 'term-1',
    })).kind,
  ).toBe('committed');
  expect(
    submit((expectedRevision) => ({
      kind: 'settle-intent',
      coordinationScopeId: SCOPE,
      expectedRevision,
      writer: writer(),
      operationId: 'op-terminal' as OperationId,
      outcomeClass: 'accepted',
      backendRequestId: 'req-1',
      terminalHandle: 'term-2',
    })).kind,
  ).toBe('rejected');
});

test('持久行的 terminal_handle 与 state/category 不自洽时读取 fail closed', () => {
  createScope();
  activateSession();
  expect(
    submit((expectedRevision) => ({
      kind: 'begin-intent',
      coordinationScopeId: SCOPE,
      expectedRevision,
      writer: writer(),
      operationId: 'op-pending' as OperationId,
      target: { kind: 'worker-task', id: 'wp-1' },
      operationCategory: 'worker-terminal-prepare',
    })).kind,
  ).toBe('committed');

  const raw = new DatabaseSync(join(directory, 'coordination.sqlite'));
  raw
    .prepare("UPDATE operation_intents SET terminal_handle = ? WHERE coordination_scope_id = ? AND operation_id = ?")
    .run('term-malformed', SCOPE, 'op-pending');
  raw.close();

  const read = store.query({ kind: 'intent', coordinationScopeId: SCOPE, operationId: 'op-pending' as OperationId });
  expect(read.kind).toBe('rejected');
});

/* -------------------------------------------------------------------------- */
/* schema 20：Session blocked、Session 级 Claim 上限、Delivery 结论、预算接纳    */
/* -------------------------------------------------------------------------- */

/** 一份满足 Manifest v3 必填绑定的最小授权正文，用于预算接纳路径。 */
function implementationManifest(graphId: GraphId = GRAPH_ID): ExecutionAuthorizationManifest {
  return {
    manifestVersion: 3,
    coordinationScopeId: SCOPE,
    planningCycleId: 'cycle-1' as PlanningCycleId,
    destinationRef: { kind: 'destination', id: 'dest-1', version: 1 },
    routeMapRef: { kind: 'route-map', id: 'map-1', version: 0 },
    implementationPlanRef: { kind: 'implementation-plan', id: 'plan-1', version: 1 },
    graph: { graphId, generation: 1 as GraphGeneration, version: 1 as GraphVersion },
    baselineHead: 'head-1',
    orcaRunId: 'run-1',
    workerProfiles: workerProfilesFixture(),
    recoveryUtilityProfile: recoveryUtilityProfileFixture(),
    permissions: {
      planner: true,
      implementation: true,
      validator: true,
      finalizer: true,
      gitIntegration: false,
      dependencyChanges: false,
    },
    limits: DEFAULT_EXECUTION_LIMITS,
    workspacePolicy: { canonicalWorktree: '/work', worktreeIsolation: 'per_work_package' },
    gitPolicy: { canonicalBranch: 'main', remotes: [], refs: [], allowForcePush: false },
    dependencyPolicy: { allowDependencyChanges: false, registry: null },
    acceptedRisks: [],
  };
}

function recordAuthorization(graphId: GraphId = GRAPH_ID): void {
  const recorded = submit((expectedRevision) => ({
    kind: 'record-authorization',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(),
    authorizationId: 'auth-1',
    authorizationVersion: 1,
    manifestVersion: 3,
    fingerprint: 'fingerprint-1',
    approvalRef: 'approval-1',
    manifest: implementationManifest(graphId),
  }));
  if (recorded.kind !== 'committed') {
    throw new Error('无法记录测试授权: ' + recorded.message);
  }
}

function implementationBindingCommand(
  expectedRevision: number,
  attemptId: string,
  creationOperationId: string,
): CoordinationCommand {
  return {
    kind: 'record-materialization-binding',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(SESSION_A),
    workPackageId: 'wp-1' as WorkPackageId,
    role: 'implementation',
    workerTaskId: 'worker-task-1' as WorkerTaskId,
    dispatchId: ('dispatch-' + attemptId) as DispatchId,
    attemptId,
    worktreeId: 'worktree-1',
    specBinding: SPEC_BINDING,
    specificationUnitPath: null,
    orcaTaskId: 'orca-task-1',
    launchId: 'launch-' + attemptId,
    creationOperationId: creationOperationId as OperationId,
    ...AUTHORIZATION_PIN,
  };
}

function implementationAttemptsConsumed(): number {
  const result = store.query({ kind: 'budget-counters', coordinationScopeId: SCOPE });
  return result.kind === 'budget-counters'
    ? result.counters.find(
        (counter) => counter.budgetKey === workPackageBudgetKey('wp-1' as WorkPackageId, 'implementationAttempts'),
      )?.consumed ?? 0
    : -1;
}

function validatorRepairsConsumed(): number {
  const result = store.query({ kind: 'budget-counters', coordinationScopeId: SCOPE });
  return result.kind === 'budget-counters'
    ? result.counters.find(
        (counter) => counter.budgetKey === workPackageBudgetKey('wp-1' as WorkPackageId, 'validatorRepairs'),
      )?.consumed ?? 0
    : -1;
}

test('Implementation Attempt 接纳消费一次 implementationAttempts，重放与同 Task Retry 不误扣', () => {
  createScope();
  activateSession();
  expect(recordInitialGraph().kind).toBe('committed');
  recordAuthorization();
  acquireExecutionLease();

  expect(submit((revision) => implementationBindingCommand(revision, 'attempt-1', 'op-impl-1')).kind).toBe('committed');
  expect(implementationAttemptsConsumed()).toBe(1);
  expect(submit((revision) => implementationBindingCommand(revision, 'attempt-1', 'op-impl-1')).kind).toBe('committed');
  expect(implementationAttemptsConsumed()).toBe(1);
  expect(submit((revision) => implementationBindingCommand(revision, 'attempt-2', 'op-impl-2')).kind).toBe('committed');
  expect(implementationAttemptsConsumed()).toBe(2);
  expect(submit((revision) => implementationBindingCommand(revision, 'attempt-3', 'op-impl-3')).kind).toBe('rejected');
  expect(implementationAttemptsConsumed()).toBe(2);
  expect(bindingsOf()).toHaveLength(2);
  expect(bindingsOf().map((binding) => binding.attemptId)).toEqual(['attempt-1', 'attempt-2']);
});

test.each([false, true])('重新授权后新 Task 保留已消耗实现预算，预算上限变化=%s', (changedLimit) => {
  createScope(); activateSession();
  expect(recordInitialGraph().kind).toBe('committed');
  recordAuthorization(); acquireExecutionLease();
  expect(submit(revision => implementationBindingCommand(revision, 'attempt-1', 'op-impl-1')).kind).toBe('committed');
  const base = implementationManifest(GRAPH_ID);
  expect(submit(expectedRevision => ({ kind: 'record-authorization', coordinationScopeId: SCOPE,
    expectedRevision, writer: writer(), authorizationId: 'auth-2', authorizationVersion: 2,
    manifestVersion: 3, fingerprint: 'fingerprint-2', approvalRef: 'approval-2',
    manifest: { ...base, limits: { ...base.limits, implementationAttempts: changedLimit ? 3 : 2 } } })).kind).toBe('committed');
  const recorded = submit(revision => ({
    kind: 'record-materialization-binding', coordinationScopeId: SCOPE, expectedRevision: revision, writer: writer(),
    workPackageId: 'wp-1' as WorkPackageId, role: 'implementation', workerTaskId: 'worker-task-2' as WorkerTaskId,
    dispatchId: 'dispatch-2' as DispatchId, attemptId: 'attempt-2', worktreeId: 'worktree-1', specBinding: SPEC_BINDING,
    specificationUnitPath: null, orcaTaskId: 'orca-task-2', launchId: 'launch-2', creationOperationId: 'op-impl-2' as OperationId,
    authorizationId: 'auth-2', authorizationVersion: 2, workerProfileRef: 'profile-implementation' }));
  expect(recorded.kind).toBe(changedLimit ? 'rejected' : 'committed');
  expect(implementationAttemptsConsumed()).toBe(changedLimit ? 1 : 2);
});

test('admit-validation-step 按 stepId 幂等扣减 validatorRepairs 并可按 stepId 对账', () => {
  createScope();
  activateSession();
  acquireExecutionLease();

  const admit = (stepId: string, repairOrdinal: number, overrides: Record<string, unknown> = {}): CoordinationCommandResult =>
    submit((expectedRevision) => ({
      kind: 'admit-validation-step',
      coordinationScopeId: SCOPE,
      expectedRevision,
      writer: writer(SESSION_A),
      stepId,
      workPackageId: 'wp-1' as WorkPackageId,
      workerTaskId: 'worker-task-1' as WorkerTaskId,
      dispatchId: 'dispatch-1' as DispatchId,
      validationAttemptId: 'attempt-1',
      repairOrdinal,
      approvedLimitRef: 'auth-1',
      approvedLimit: 2,
      ...overrides,
    }));

  expect(admit('validator-repair:1', 1).kind).toBe('committed');
  expect(validatorRepairsConsumed()).toBe(1);
  expect(admit('validator-repair:1', 1).kind).toBe('committed');
  expect(validatorRepairsConsumed()).toBe(1);
  expect(admit('validator-repair:1', 1, { workerTaskId: 'worker-task-other' }).kind).toBe('rejected');
  expect(admit('validator-repair:2', 2).kind).toBe('committed');
  expect(validatorRepairsConsumed()).toBe(2);
  expect(admit('validator-repair:3', 3).kind).toBe('rejected');
  expect(validatorRepairsConsumed()).toBe(2);

  expect(store.query({ kind: 'validation-step-admission', coordinationScopeId: SCOPE, stepId: 'validator-repair:1' }))
    .toMatchObject({ kind: 'validation-step-admission', admission: { stepId: 'validator-repair:1', repairOrdinal: 1 } });
  expect(store.query({ kind: 'validation-step-admission', coordinationScopeId: SCOPE, stepId: 'validator-repair:missing' }))
    .toEqual({ kind: 'validation-step-admission', admission: null });
});

test('同一 Session 至多一个活跃 Ticket Claim，释放后可再认领', () => {
  createScope();
  activateSession();
  const claim = (ticketId: string): CoordinationCommandResult =>
    submit((expectedRevision) => ({
      kind: 'record-ticket-claim',
      coordinationScopeId: SCOPE,
      expectedRevision,
      writer: writer(),
      ticketRef: { kind: 'decision-ticket', id: ticketId },
    }));

  expect(claim('ticket-1').kind).toBe('committed');
  const second = claim('ticket-2');
  expect(second.kind).toBe('rejected');
  if (second.kind === 'rejected') {
    expect(second.code).toBe('constraint');
  }
  const snapshot = store.query({ kind: 'snapshot', coordinationScopeId: SCOPE });
  expect(snapshot.kind === 'snapshot' ? snapshot.snapshot.ticketClaims.filter((claim) => claim.state === 'active') : [])
    .toHaveLength(1);

  expect(submit((expectedRevision) => ({
    kind: 'release-ticket-claim',
    coordinationScopeId: SCOPE,
    expectedRevision,
    writer: writer(),
    ticketRef: { kind: 'decision-ticket', id: 'ticket-1' },
    finalState: 'released',
  })).kind).toBe('committed');
  expect(claim('ticket-2').kind).toBe('committed');
});

test('Session blocked 持久化结构化原因，非 blocked 状态清除原因', () => {
  createScope();
  activateSession();
  const lifecycle = (
    state: SessionLifecycleState,
    blockingReason?: { readonly code: string; readonly message: string },
  ): CoordinationCommandResult =>
    submit((expectedRevision) => ({
      kind: 'update-session-lifecycle',
      coordinationScopeId: SCOPE,
      expectedRevision,
      writer: writer(),
      coordinatorSessionId: SESSION_A,
      lifecycleState: state,
      ...(blockingReason === undefined ? {} : { blockingReason }),
    }));

  expect(lifecycle('blocked').kind).toBe('rejected');
  expect(lifecycle('blocked', { code: 'checkpoint_corrupt', message: 'checkpoint 损坏' }).kind).toBe('committed');
  const blocked = store.query({ kind: 'sessions', coordinationScopeId: SCOPE });
  expect(blocked.kind === 'sessions' ? blocked.sessions[0] : null).toMatchObject({
    lifecycleState: 'blocked',
    blockedReason: { code: 'checkpoint_corrupt', message: 'checkpoint 损坏' },
  });
  expect(lifecycle('active').kind).toBe('committed');
  const active = store.query({ kind: 'sessions', coordinationScopeId: SCOPE });
  expect(active.kind === 'sessions' ? active.sessions[0] : null).toMatchObject({
    lifecycleState: 'active',
    blockedReason: null,
  });
  expect(store.transact({
    kind: 'register-session',
    coordinationScopeId: SCOPE,
    expectedRevision: revisionOf(),
    writer: writer(),
    coordinatorSessionId: SESSION_B,
    coordinatorModelConfigurationRef: 'profile-b',
    lifecycleState: 'blocked',
  })).toMatchObject({ kind: 'rejected' });
});

test('Delivery 结算保存结果成败与验证结论，非 validator 不得给出验证结论', () => {
  createScope();
  activateSession();
  acquireExecutionLease();
  const settlement = (overrides: Record<string, unknown>): CoordinationCommandResult =>
    submit((expectedRevision) => ({
      kind: 'record-delivery-settlement',
      coordinationScopeId: SCOPE,
      expectedRevision,
      writer: writer(SESSION_A),
      dedupeKey: 'dedupe-1',
      deliveryId: 'delivery-1',
      runId: 'run-1',
      consumerGeneration: 1,
      workerTaskId: 'worker-task-1' as WorkerTaskId,
      dispatchId: 'dispatch-1' as DispatchId,
      attemptId: 'attempt-1',
      role: 'implementation',
      contractRevision: 1,
      orcaResultRef: 'result-1',
      ...overrides,
    }));

  expect(settlement({ outcome: 'succeeded' }).kind).toBe('committed');
  const read = store.query({ kind: 'delivery-settlements', coordinationScopeId: SCOPE });
  expect(read.kind === 'delivery-settlements' ? read.settlements[0] : null).toMatchObject({
    outcome: 'succeeded',
    validationVerdict: null,
  });
  expect(settlement({ dedupeKey: 'dedupe-2', deliveryId: 'delivery-2', role: 'validator', validationVerdict: 'passed' }).kind)
    .toBe('committed');
  expect(settlement({ dedupeKey: 'dedupe-3', deliveryId: 'delivery-3', validationVerdict: 'passed' }).kind)
    .toBe('rejected');
});

test('migration v19 → v20 拒绝同一 Session 的重复活跃 Claim 并整体回滚', () => {
  const databasePath = join(directory, 'coordination-v19-dupe.sqlite');
  const legacy = new DatabaseSync(databasePath);
  legacy.exec('BEGIN IMMEDIATE');
  for (const migration of MIGRATIONS) {
    if (migration.version > 19) continue;
    for (const statement of migration.statements) {
      legacy.exec(statement);
    }
  }
  legacy.prepare(
    `INSERT INTO scope (
       coordination_scope_id, mode, control_state, planning_cycle_id, graph_id, graph_version,
       authorization_id, authorization_version, map_revision, revision, updated_at,
       full_branch_ref, canonical_worktree_path
     ) VALUES ('scope-dupe', 'route_planning', 'active', 'cycle-1', NULL, NULL, NULL, NULL, 0, 1, 1,
       'refs/heads/dupe', '/tmp/dupe')`,
  ).run();
  for (const ticket of ['ticket-1', 'ticket-2']) {
    legacy.prepare(
      `INSERT INTO ticket_claims (
         coordination_scope_id, ticket_kind, ticket_id, coordinator_session_id, state, claimed_at
       ) VALUES ('scope-dupe', 'decision-ticket', ?, 'session-a', 'active', 1)`,
    ).run(ticket);
  }
  legacy.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', '19')`).run();
  legacy.exec('COMMIT');
  legacy.close();

  const opened = openCoordinationStore({ databasePath, clock });
  expect(opened.kind).toBe('failed');
  if (opened.kind === 'failed') {
    expect(opened.code).toBe('migration_failed');
  }

  const check = new DatabaseSync(databasePath, { readOnly: true });
  const claims = check.prepare(`SELECT COUNT(*) AS n FROM ticket_claims WHERE state = 'active'`).get() as
    | { readonly n: number }
    | undefined;
  expect(claims?.n).toBe(2);
  const version = check.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    | { readonly value: string }
    | undefined;
  expect(version?.value).toBe('19');
  check.close();
});

test('migration v19 → v20 补齐 Session 原因、Delivery 结论与修复步骤表', () => {
  const databasePath = join(directory, 'coordination-v19.sqlite');
  const legacy = new DatabaseSync(databasePath);
  legacy.exec('BEGIN IMMEDIATE');
  for (const migration of MIGRATIONS) {
    if (migration.version > 19) continue;
    for (const statement of migration.statements) {
      legacy.exec(statement);
    }
  }
  legacy.prepare(
    `INSERT INTO scope (
       coordination_scope_id, mode, control_state, planning_cycle_id, graph_id, graph_version,
       authorization_id, authorization_version, map_revision, revision, updated_at,
       full_branch_ref, canonical_worktree_path
     ) VALUES ('scope-v19', 'route_planning', 'active', 'cycle-1', NULL, NULL, NULL, NULL, 0, 1, 1,
       'refs/heads/v19', '/tmp/v19')`,
  ).run();
  legacy.prepare(
    `INSERT INTO session_registry (
       coordination_scope_id, coordinator_session_id, coordinator_model_configuration_ref,
       lifecycle_state, registered_at
     ) VALUES ('scope-v19', 'session-a', 'profile-a', 'registered', 1)`,
  ).run();
  legacy.prepare(
    `INSERT INTO materialization_bindings (
       coordination_scope_id, work_package_id, creation_operation_id, role, worker_task_id, dispatch_id,
       attempt_id, worktree_id, spec_binding_json, specification_unit_path, authorization_id,
       authorization_version, worker_profile_ref, utility_role, orca_task_id, launch_id, created_at
     ) VALUES ('scope-v19', 'wp-1', 'op-legacy', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
       NULL, NULL, NULL, 'orca-task-legacy', NULL, 1)`,
  ).run();
  legacy.prepare(
    `INSERT INTO delivery_settlements (
       coordination_scope_id, dedupe_key, delivery_id, run_id, consumer_generation, worker_task_id,
       dispatch_id, attempt_id, role, contract_revision, orca_result_ref, accepted_at
     ) VALUES ('scope-v19', 'dedupe-legacy', 'delivery-legacy', 'run-1', 1, 'worker-task-legacy',
       'dispatch-legacy', 'attempt-legacy', 'implementation', 1, 'result-legacy', 1)`,
  ).run();
  legacy.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', '19')`).run();
  legacy.exec('COMMIT');
  legacy.close();

  const migrated = openCoordinationStore({ databasePath, clock });
  expect(migrated.kind).toBe('opened');
  if (migrated.kind !== 'opened') return;
  try {
    const scopeId = 'scope-v19' as CoordinationScopeId;
    const sessions = migrated.store.query({ kind: 'sessions', coordinationScopeId: scopeId });
    expect(sessions.kind === 'sessions' ? sessions.sessions[0] : null).toMatchObject({
      lifecycleState: 'registered',
      blockedReason: null,
    });
    const settlements = migrated.store.query({ kind: 'delivery-settlements', coordinationScopeId: scopeId });
    expect(settlements.kind === 'delivery-settlements' ? settlements.settlements[0] : null).toMatchObject({
      orcaResultRef: 'result-legacy',
      outcome: null,
      validationVerdict: null,
    });
    const bindings = migrated.store.query({
      kind: 'materialization-bindings',
      coordinationScopeId: scopeId,
      workPackageId: 'wp-1' as WorkPackageId,
    });
    expect(bindings.kind === 'materialization-bindings' ? bindings.bindings[0] : null).toMatchObject({
      identity: 'legacy',
      orcaTaskId: 'orca-task-legacy',
    });
    expect(migrated.store.query({
      kind: 'validation-step-admission',
      coordinationScopeId: scopeId,
      stepId: 'unknown-step',
    })).toEqual({ kind: 'validation-step-admission', admission: null });
  } finally {
    migrated.store.close();
  }
});
