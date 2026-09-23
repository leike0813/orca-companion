/**
 * `m1-plan-and-authorize-execution` 的行为测试：Route Planning 的语义操作（IC-05）。
 *
 * 覆盖 `planning/route-map` 的 Requirement「Route Map authority and fixed-section updates」及其
 * Scenario「本地不保存地图副本」「写入固定章节」「复述已解决决策不新增章节」，以及 Requirement
 * 「Ticket Claim binds a ticket to one Session」的认领、冲突、释放与解决路径。
 *
 * 这些用例同时固定副作用纪律的可观察形态：写入 tracker 之前 Operation Intent 已经落盘；tracker
 * 明确拒绝时意图收尾为 rejected 且地图 revision 不推进；结果不明时意图保持 pending、地图 revision
 * 不变，并且同一条 mutation lane 不能换一个 OperationId 再写。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { openCoordinationStore, type CoordinationStore } from '../../src/adapters/storage/coordination-store.js';
import { acquireRuntimeLease } from '../../src/application/coordination/lease-service.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  EntityRef,
  OperationId,
  PlanningCycleId,
  RuntimeIncarnationId,
} from '../../src/application/dto/identity.js';
import type { OperationIntent } from '../../src/application/dto/operation-intent.js';
import { initializeCoordinationScope } from '../../src/application/planning/initialize-scope.js';
import {
  claimTicket,
  readRouteMap,
  releaseTicket,
  resolveTicket,
  updateRouteMapSection,
  writeResolvedTicketMap,
  type IssueTrackerGateway,
  type PlanningMutationContext,
  type TrackerReadOutcome,
  type TrackerWriteOutcome,
} from '../../src/application/planning/route-map-service.js';
import type {
  CoordinationWriter,
  ScopeRecord,
  TicketClaimRecord,
} from '../../src/application/ports/branch-coordination-store.js';
import {
  parseRouteMapSections,
  type DecisionTicketRef,
  type RouteMapRef,
} from '../../src/domain/planning/route-map.js';

const SCOPE = 'scope-1' as CoordinationScopeId;
const SESSION_A = 'session-a' as CoordinatorSessionId;
const SESSION_B = 'session-b' as CoordinatorSessionId;
const CYCLE = 'cycle-1' as PlanningCycleId;

const MAP_REF: RouteMapRef = { kind: 'route-map', id: 'map-1', version: 1 };
const TICKET: DecisionTicketRef = { kind: 'decision-ticket', id: 'ticket-1', version: 1 };

const MAP_BODY = [
  '## Destination',
  '目标 A',
  '',
  '## Resolved Decisions',
  '- r1: 已决',
  '',
  '## Open Decision Tickets',
  '- ticket-1: 待决',
  '',
  '## Dependencies',
  '- dep-a',
  '',
  '## Fog',
  '- fog-x',
  '',
  '## Scope Boundaries',
  '- src',
].join('\n');

let directory = '';
let store: CoordinationStore;
let writer: CoordinationWriter;
let now = 1_000;

const clock = (): number => now;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-planning-a-'));
  now = 1_000;
  const opened = openCoordinationStore({ databasePath: join(directory, 'coordination.sqlite'), clock });
  if (opened.kind !== 'opened') {
    throw new Error(opened.message);
  }
  store = opened.store;

  const initialized = initializeCoordinationScope({
    store,
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    coordinatorModelConfigurationRef: 'model-config-1',
    planningCycleId: CYCLE,
    fullBranchRef: 'refs/heads/main',
    canonicalWorktreePath: '/tmp/orca-test-worktree',
  });
  if (initialized.kind !== 'initialized') {
    throw new Error('无法创建测试 Scope');
  }
  writer = leaseWriterFor(SESSION_A, 'inc-a');
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// store 读回辅助
// ---------------------------------------------------------------------------

function scopeRecord(): ScopeRecord {
  const result = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  if (result.kind !== 'scope' || result.scope === null) {
    throw new Error('Scope 不存在');
  }
  return result.scope;
}

function mapRevision(): number {
  return scopeRecord().mapRevision;
}

function intentOf(operationId: OperationId): OperationIntent | null {
  const result = store.query({ kind: 'intent', coordinationScopeId: SCOPE, operationId });
  if (result.kind !== 'intent') {
    throw new Error('无法读取 Operation Intent');
  }
  return result.intent;
}

function intents(): readonly OperationIntent[] {
  const result = store.query({ kind: 'intents', coordinationScopeId: SCOPE });
  if (result.kind !== 'intents') {
    throw new Error('无法读取 Operation Intent 列表');
  }
  return result.intents;
}

function ticketClaims(): readonly TicketClaimRecord[] {
  const result = store.query({ kind: 'snapshot', coordinationScopeId: SCOPE });
  if (result.kind !== 'snapshot') {
    throw new Error('无法读取 snapshot');
  }
  return result.snapshot.ticketClaims;
}

/** 注册一个新 Session（由当前活跃 incarnation 代写），并取得它自己的 Runtime Lease。 */
function registerSession(sessionId: CoordinatorSessionId): void {
  const registered = store.transact({
    kind: 'register-session',
    coordinationScopeId: SCOPE,
    expectedRevision: scopeRecord().revision,
    writer,
    coordinatorSessionId: sessionId,
    coordinatorModelConfigurationRef: `model-config-${sessionId}`,
    lifecycleState: 'registered',
  });
  if (registered.kind !== 'committed') {
    throw new Error(`无法注册 ${sessionId}: ${registered.message}`);
  }
}

function leaseWriterFor(sessionId: CoordinatorSessionId, incarnationId: string): CoordinationWriter {
  const runtimeIncarnationId = incarnationId as RuntimeIncarnationId;
  const acquired = acquireRuntimeLease(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: sessionId,
    runtimeIncarnationId,
    fencingGeneration: 0,
  });
  if (acquired.kind !== 'acquired') {
    throw new Error(`无法取得 ${sessionId} 的 Runtime Lease`);
  }
  return {
    coordinatorSessionId: sessionId,
    runtimeIncarnationId,
    fencingGeneration: acquired.lease.fencingGeneration,
  };
}

function mutationContext(operationId: string): PlanningMutationContext {
  return {
    store,
    coordinationScopeId: SCOPE,
    writer,
    operationId: operationId as OperationId,
    expectedRevision: scopeRecord().revision,
    routeMapRef: MAP_REF,
    planningCycleId: CYCLE,
  };
}

// ---------------------------------------------------------------------------
// 内存假 tracker：记录每次调用，可配置读取/写入结果与「丢响应」
// ---------------------------------------------------------------------------

type TrackerCall =
  | { readonly method: 'read'; readonly ref: EntityRef<string> }
  | { readonly method: 'update-body'; readonly ref: EntityRef<string>; readonly body: string }
  | { readonly method: 'assign'; readonly ref: EntityRef<string>; readonly assignee: string | null };

type FakeIssue = {
  title: string;
  body: string;
  state: 'open' | 'closed';
  assignees: string[];
};

type FakeIssueSeed = {
  readonly ref: EntityRef<string>;
  readonly body: string;
  readonly title?: string;
  readonly assignees?: readonly string[];
};

const ACCEPTED_WRITE: TrackerWriteOutcome = { kind: 'accepted' };

class FakeIssueTracker implements IssueTrackerGateway {
  readonly calls: TrackerCall[] = [];
  /** 非 null 时读取一律返回它，用于模拟 not_found / unavailable / unknown。 */
  readOutcome: TrackerReadOutcome | null = null;
  /** 非 null 时写入一律返回它；`unknown` 表示已落盘但响应丢失。 */
  writeOutcome: TrackerWriteOutcome | null = null;
  /** 模拟 tracker 落盘时改写了正文，用于构造读回核验失败。 */
  bodyRewrite: ((body: string) => string) | null = null;
  /** 每次调用前的观察钩子。 */
  onCall: ((call: TrackerCall) => void) | null = null;

  readonly #issues = new Map<string, FakeIssue>();

  constructor(seeds: readonly FakeIssueSeed[]) {
    for (const seed of seeds) {
      this.#issues.set(seed.ref.id, {
        title: seed.title ?? seed.ref.id,
        body: seed.body,
        state: 'open',
        assignees: [...(seed.assignees ?? [])],
      });
    }
  }

  readIssue(ref: EntityRef<string>): Promise<TrackerReadOutcome> {
    const call: TrackerCall = { method: 'read', ref };
    this.calls.push(call);
    this.onCall?.(call);
    if (this.readOutcome !== null) {
      return Promise.resolve(this.readOutcome);
    }
    const issue = this.#issues.get(ref.id);
    if (issue === undefined) {
      return Promise.resolve({ kind: 'not_found' });
    }
    return Promise.resolve({
      kind: 'read',
      issue: { ref, title: issue.title, body: issue.body, state: issue.state, assignees: [...issue.assignees] },
    });
  }

  updateIssueBody(input: { ref: EntityRef<string>; body: string }): Promise<TrackerWriteOutcome> {
    const call: TrackerCall = { method: 'update-body', ref: input.ref, body: input.body };
    this.calls.push(call);
    this.onCall?.(call);
    const outcome = this.writeOutcome ?? ACCEPTED_WRITE;
    if (outcome.kind !== 'rejected') {
      const issue = this.#issues.get(input.ref.id);
      if (issue !== undefined) {
        issue.body = this.bodyRewrite === null ? input.body : this.bodyRewrite(input.body);
      }
    }
    return Promise.resolve(outcome);
  }

  assignIssue(input: { ref: EntityRef<string>; assignee: string | null }): Promise<TrackerWriteOutcome> {
    const call: TrackerCall = { method: 'assign', ref: input.ref, assignee: input.assignee };
    this.calls.push(call);
    this.onCall?.(call);
    const outcome = this.writeOutcome ?? ACCEPTED_WRITE;
    if (outcome.kind !== 'rejected') {
      const issue = this.#issues.get(input.ref.id);
      if (issue !== undefined) {
        issue.assignees = input.assignee === null ? [] : [input.assignee];
      }
    }
    return Promise.resolve(outcome);
  }

  setBody(id: string, body: string): void {
    const issue = this.#issues.get(id);
    if (issue === undefined) {
      throw new Error(`tracker 上没有 ${id}`);
    }
    issue.body = body;
  }

  bodyOf(id: string): string {
    const issue = this.#issues.get(id);
    if (issue === undefined) {
      throw new Error(`tracker 上没有 ${id}`);
    }
    return issue.body;
  }

  assigneesOf(id: string): readonly string[] {
    return this.#issues.get(id)?.assignees ?? [];
  }

  /** 只统计外部写入，不统计读回。 */
  writeCalls(): readonly TrackerCall[] {
    return this.calls.filter((call) => call.method !== 'read');
  }
}

function mapTracker(): FakeIssueTracker {
  return new FakeIssueTracker([{ ref: MAP_REF, body: MAP_BODY }]);
}

function mapAndTicketTracker(): FakeIssueTracker {
  return new FakeIssueTracker([
    { ref: MAP_REF, body: MAP_BODY },
    { ref: TICKET, body: '## 决策票\n待决' },
  ]);
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

test('读取地图的内容来自 tracker，本地不保存副本', async () => {
  const tracker = mapTracker();

  const first = await readRouteMap({ tracker, routeMapRef: MAP_REF, planningCycleId: CYCLE });
  expect(first.kind).toBe('read');
  if (first.kind !== 'read') {
    return;
  }
  expect(first.snapshot.sections.destination).toBe('目标 A');
  expect(first.snapshot.routeMapRef).toEqual(MAP_REF);
  expect(first.snapshot.planningCycleId).toBe(CYCLE);

  // tracker 上的正文变化后再次读取拿到新内容：本地没有可返回的副本。
  tracker.setBody(MAP_REF.id, '## Destination\n目标 B');
  const second = await readRouteMap({ tracker, routeMapRef: MAP_REF, planningCycleId: CYCLE });
  expect(second.kind).toBe('read');
  if (second.kind !== 'read') {
    return;
  }
  expect(second.snapshot.sections.destination).toBe('目标 B');
});

test('读取结果按 not_found / unavailable / unknown 原样映射', async () => {
  const tracker = mapTracker();

  tracker.readOutcome = { kind: 'not_found' };
  expect((await readRouteMap({ tracker, routeMapRef: MAP_REF, planningCycleId: CYCLE })).kind).toBe('not_found');

  tracker.readOutcome = { kind: 'unavailable', message: 'tracker 离线' };
  const unavailable = await readRouteMap({ tracker, routeMapRef: MAP_REF, planningCycleId: CYCLE });
  expect(unavailable.kind).toBe('unavailable');
  if (unavailable.kind === 'unavailable') {
    expect(unavailable.message).toBe('tracker 离线');
  }

  tracker.readOutcome = { kind: 'unknown', reason: '代理返回 502' };
  const unknown = await readRouteMap({ tracker, routeMapRef: MAP_REF, planningCycleId: CYCLE });
  expect(unknown.kind).toBe('unknown');
  if (unknown.kind === 'unknown') {
    expect(unknown.reason).toBe('代理返回 502');
  }
});

// ---------------------------------------------------------------------------
// 固定章节写入
// ---------------------------------------------------------------------------

test('写入固定章节只替换目标章节，其它章节不变且地图 revision 依次推进', async () => {
  const tracker = mapTracker();
  const before = parseRouteMapSections(MAP_BODY);

  const first = await updateRouteMapSection({
    ...mutationContext('op-map-1'),
    tracker,
    section: 'destination',
    content: '新目标',
  });
  expect(first.kind).toBe('accepted');
  if (first.kind !== 'accepted') {
    return;
  }
  expect(first.mapRevision).toBe(1);

  const after = parseRouteMapSections(tracker.bodyOf(MAP_REF.id));
  expect(after.destination).toBe('新目标');
  expect(after.resolved_decisions).toBe(before.resolved_decisions);
  expect(after.open_decision_tickets).toBe(before.open_decision_tickets);
  expect(after.dependencies).toBe(before.dependencies);
  expect(after.fog).toBe(before.fog);
  expect(after.scope_boundaries).toBe(before.scope_boundaries);

  const second = await updateRouteMapSection({
    ...mutationContext('op-map-2'),
    tracker,
    section: 'fog',
    content: '- 没有 fog',
  });
  expect(second.kind).toBe('accepted');
  if (second.kind !== 'accepted') {
    return;
  }
  expect(second.mapRevision).toBe(2);
  expect(parseRouteMapSections(tracker.bodyOf(MAP_REF.id)).fog).toBe('- 没有 fog');
});

test('调用 tracker 之前意图已经落盘，成功收尾后意图为 settled/accepted', async () => {
  const tracker = mapTracker();
  const operationId = 'op-map-1' as OperationId;
  let intentStateBeforeWrite: string | null = '未观察';
  let intentExistedBeforeWrite = false;
  tracker.onCall = (call) => {
    if (call.method !== 'update-body') {
      return;
    }
    const intent = intentOf(operationId);
    intentStateBeforeWrite = intent?.state ?? null;
    intentExistedBeforeWrite = intent !== null;
  };

  const result = await updateRouteMapSection({
    ...mutationContext('op-map-1'),
    tracker,
    section: 'destination',
    content: '新目标',
  });

  expect(result.kind).toBe('accepted');
  expect(intentExistedBeforeWrite).toBe(true);
  expect(intentStateBeforeWrite).toBe('pending');
  const settled = intentOf(operationId);
  expect(settled?.state).toBe('settled');
  expect(settled?.outcomeClass).toBe('accepted');
  // 同一事实在 Scope 级意图列表里可见。
  const listed = intents().find((intent) => intent.operationId === operationId);
  expect(listed?.state).toBe('settled');
  expect(listed?.outcomeClass).toBe('accepted');
});

test('accepted 意图出现时地图 revision 与票据 claim 已经持久化', async () => {
  const tracker = mapAndTicketTracker();
  const transact = store.transact.bind(store);
  const observed: { mapRevision: number; activeClaims: number }[] = [];
  vi.spyOn(store, 'transact').mockImplementation((command) => {
    const result = transact(command);
    if (command.kind === 'settle-intent' && command.outcomeClass === 'accepted') {
      observed.push({
        mapRevision: mapRevision(),
        activeClaims: ticketClaims().filter((claim) => claim.state === 'active').length,
      });
    }
    return result;
  });

  const claimed = await claimTicket({
    ...mutationContext('op-claim-1'), tracker, ticketRef: TICKET, trackerAssignee: 'alice',
  });
  expect(claimed.kind).toBe('accepted');
  expect(observed).toEqual([{ mapRevision: 1, activeClaims: 1 }]);
});

test('tracker 明确拒绝时意图收尾为 rejected，地图 revision 不推进', async () => {
  const tracker = mapTracker();
  tracker.writeOutcome = { kind: 'rejected', code: 'tracker_conflict', message: '正文冲突' };
  const before = mapRevision();

  const result = await updateRouteMapSection({
    ...mutationContext('op-map-1'),
    tracker,
    section: 'destination',
    content: '新目标',
  });

  expect(result.kind).toBe('rejected');
  if (result.kind === 'rejected') {
    expect(result.code).toBe('tracker_conflict');
  }
  const intent = intentOf('op-map-1' as OperationId);
  expect(intent?.state).toBe('settled');
  expect(intent?.outcomeClass).toBe('rejected');
  expect(mapRevision()).toBe(before);
});

test('tracker 丢响应时保持未决，同一条 lane 不能换 OperationId 再写', async () => {
  const tracker = mapTracker();
  tracker.writeOutcome = { kind: 'unknown', reason: '响应超时' };

  const first = await updateRouteMapSection({
    ...mutationContext('op-map-1'),
    tracker,
    section: 'destination',
    content: '新目标',
  });
  expect(first.kind).toBe('unknown');
  expect(intentOf('op-map-1' as OperationId)?.state).toBe('pending');

  const writesBefore = tracker.writeCalls().length;
  const second = await updateRouteMapSection({
    ...mutationContext('op-map-2'),
    tracker,
    section: 'fog',
    content: '- 没有 fog',
  });

  expect(second.kind).toBe('rejected');
  expect(tracker.writeCalls().length).toBe(writesBefore);
  expect(intentOf('op-map-2' as OperationId)).toBeNull();
});

test('过期 expected revision 在读取或写入 tracker 前被拒绝', async () => {
  const tracker = mapTracker();
  const firstContext = mutationContext('op-cas-1');
  const staleContext = { ...firstContext, operationId: 'op-cas-2' as OperationId };

  const first = await updateRouteMapSection({
    ...firstContext,
    tracker,
    section: 'fog',
    content: 'first',
  });
  expect(first.kind).toBe('accepted');
  const callsAfterFirst = tracker.calls.length;

  const stale = await updateRouteMapSection({
    ...staleContext,
    tracker,
    section: 'destination',
    content: 'stale',
  });
  expect(stale.kind).toBe('rejected');
  if (stale.kind === 'rejected') expect(stale.code).toBe('stale_revision');
  expect(tracker.calls).toHaveLength(callsAfterFirst);
});

test('写后读回与写入不一致时结果为 unknown，地图 revision 不推进', async () => {
  const tracker = mapTracker();
  tracker.bodyRewrite = () => '## Destination\n与写入不一致';
  const before = mapRevision();

  const result = await updateRouteMapSection({
    ...mutationContext('op-map-1'),
    tracker,
    section: 'destination',
    content: '新目标',
  });

  expect(result.kind).toBe('unknown');
  expect(mapRevision()).toBe(before);
});

// ---------------------------------------------------------------------------
// Ticket Claim
// ---------------------------------------------------------------------------

test('认领票据写入 tracker assignee 并登记本地 active claim', async () => {
  const tracker = mapAndTicketTracker();

  const result = await claimTicket({
    ...mutationContext('op-claim-1'),
    tracker,
    ticketRef: TICKET,
    trackerAssignee: 'alice',
  });

  expect(result.kind).toBe('accepted');
  expect(tracker.assigneesOf(TICKET.id)).toEqual(['alice']);
  const active = ticketClaims().filter((claim) => claim.state === 'active');
  expect(active).toHaveLength(1);
  expect(active[0]?.ticketRef.id).toBe(TICKET.id);
  expect(active[0]?.coordinatorSessionId).toBe(SESSION_A);
});

test('票据已由另一个 Session 持有时直接拒绝，且不发出 tracker 写', async () => {
  const tracker = mapAndTicketTracker();
  const claimed = await claimTicket({
    ...mutationContext('op-claim-1'),
    tracker,
    ticketRef: TICKET,
    trackerAssignee: 'alice',
  });
  expect(claimed.kind).toBe('accepted');

  registerSession(SESSION_B);
  const writerB = leaseWriterFor(SESSION_B, 'inc-b');
  const writesBefore = tracker.writeCalls().length;

  const conflict = await claimTicket({
    store,
    coordinationScopeId: SCOPE,
    writer: writerB,
    operationId: 'op-claim-2' as OperationId,
    expectedRevision: scopeRecord().revision,
    routeMapRef: MAP_REF,
    planningCycleId: CYCLE,
    tracker,
    ticketRef: TICKET,
    trackerAssignee: 'bob',
  });

  expect(conflict.kind).toBe('rejected');
  if (conflict.kind === 'rejected') {
    expect(conflict.code).toBe('claim_conflict');
  }
  expect(tracker.writeCalls().length).toBe(writesBefore);
  expect(tracker.assigneesOf(TICKET.id)).toEqual(['alice']);
});

test('释放票据清空 assignee 并把本地 claim 收尾为 released', async () => {
  const tracker = mapAndTicketTracker();
  await claimTicket({
    ...mutationContext('op-claim-1'),
    tracker,
    ticketRef: TICKET,
    trackerAssignee: 'alice',
  });

  const released = await releaseTicket({
    ...mutationContext('op-release-1'),
    tracker,
    ticketRef: TICKET,
  });

  expect(released.kind).toBe('accepted');
  expect(tracker.assigneesOf(TICKET.id)).toEqual([]);
  const claims = ticketClaims();
  expect(claims.filter((claim) => claim.state === 'active')).toHaveLength(0);
  expect(claims.filter((claim) => claim.state === 'released')).toHaveLength(1);
});

test('解决票据写入结论、移出开放票据、收尾 claim，并用独立 lane 更新地图', async () => {
  const tracker = mapAndTicketTracker();
  await claimTicket({
    ...mutationContext('op-claim-1'),
    tracker,
    ticketRef: TICKET,
    trackerAssignee: 'alice',
  });

  const writesBefore = tracker.writeCalls().length;
  const resolved = await resolveTicket({
    ...mutationContext('op-resolve-1'),
    tracker,
    ticketRef: TICKET,
    resolution: '选择方案 A',
    mapOperationId: 'op-map-resolve-1' as OperationId,
  });

  expect(resolved.kind).toBe('accepted');
  const writes = tracker.writeCalls().slice(writesBefore);
  expect(writes.map((call) => call.method)).toEqual(['assign', 'update-body']);
  expect(tracker.assigneesOf(TICKET.id)).toEqual([]);

  const sections = parseRouteMapSections(tracker.bodyOf(MAP_REF.id));
  expect(sections.resolved_decisions).toContain('选择方案 A');
  expect(sections.open_decision_tickets).not.toContain(TICKET.id);

  const claims = ticketClaims();
  expect(claims.filter((claim) => claim.state === 'completed')).toHaveLength(1);
  expect(claims.filter((claim) => claim.state === 'active')).toHaveLength(0);

  // 清空 assignee 与更新地图正文是两条独立 lane：各自留下已收尾的意图。
  const claimIntent = intentOf('op-resolve-1' as OperationId);
  const mapIntent = intentOf('op-map-resolve-1' as OperationId);
  expect(claimIntent?.state).toBe('settled');
  expect(mapIntent?.state).toBe('settled');
  expect(mapIntent?.operationCategory).not.toBe(claimIntent?.operationCategory);
});

test('释放阶段完成后可用原地图 OperationId 继续，且不再次清空 assignee', async () => {
  const tracker = mapAndTicketTracker();
  await claimTicket({
    ...mutationContext('op-claim-1'), tracker, ticketRef: TICKET, trackerAssignee: 'alice',
  });
  const released = await releaseTicket({
    ...mutationContext('op-release-1'), tracker, ticketRef: TICKET,
  });
  expect(released.kind).toBe('accepted');
  const writesBefore = tracker.writeCalls().length;
  const input = {
    ...mutationContext('op-release-1'),
    tracker,
    ticketRef: TICKET,
    resolution: '选择方案 A',
    mapOperationId: 'op-map-resolve-1' as OperationId,
  };

  const completed = await writeResolvedTicketMap(input, scopeRecord().revision);

  expect(completed.kind).toBe('accepted');
  expect(tracker.writeCalls().slice(writesBefore).map((call) => call.method)).toEqual(['update-body']);
  expect(intentOf(input.mapOperationId)?.outcomeClass).toBe('accepted');
});
