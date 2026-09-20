/**
 * IC-05：Route Planning 责任交接的行为测试
 * （Requirement「Route Planning session handoff」与「Handoff resilience and activation gate」）。
 *
 * 覆盖：prepare 只产出提案、review 由接收方独立复核、cutover 才转移责任、交接不触碰执行中的
 * Worker 与 Execution Coordination Lease、取消/过期/崩溃阶段恢复，以及 awaiting_user_prompt 激活门。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { acquireRuntimeLease } from '../../src/application/coordination/lease-service.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  GraphId,
  GraphVersion,
  PlanningCycleId,
  RuntimeIncarnationId,
} from '../../src/application/dto/identity.js';
import type { CoordinationWriter } from '../../src/application/ports/branch-coordination-store.js';
import { initializeCoordinationScope } from '../../src/application/planning/initialize-scope.js';
import {
  activationGate,
  cancelPlanningHandoff,
  cutoverPlanningHandoff,
  isProposalStale,
  preparePlanningHandoff,
  resumePlanningHandoff,
  reviewPlanningHandoff,
  type HandoffReviewFacts,
  type PlanningHandoffProposal,
} from '../../src/application/planning/planning-handoff.js';
import { openCoordinationStore, type CoordinationStore } from '../../src/adapters/storage/coordination-store.js';

const SCOPE = 'scope-handoff' as CoordinationScopeId;
const SESSION_A = 'session-a' as CoordinatorSessionId;
const SESSION_B = 'session-b' as CoordinatorSessionId;
const SESSION_C = 'session-c' as CoordinatorSessionId;
const INC_A = 'inc-a' as RuntimeIncarnationId;
const INC_B = 'inc-b' as RuntimeIncarnationId;
const CYCLE = 'cycle-1' as PlanningCycleId;
const PROPOSAL = 'proposal-1';

let directory = '';
let store: CoordinationStore;
let writerA: CoordinationWriter;
let writerB: CoordinationWriter;
let now = 1_000;

const clock = (): number => now;

/** 从当前 Scope 读出地图 revision；提案与复核事实都用它，避免测试里写死一个可能漂移的值。 */
function mapRevision(): number {
  const scope = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  if (scope.kind !== 'scope' || scope.scope === null) {
    throw new Error('Scope 不存在');
  }
  return scope.scope.mapRevision;
}

function registerSecondSession(): void {
  const scope = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  if (scope.kind !== 'scope' || scope.scope === null) {
    throw new Error('Scope 不存在');
  }
  const registered = store.transact({
    kind: 'register-session',
    coordinationScopeId: SCOPE,
    expectedRevision: scope.scope.revision,
    writer: writerA,
    coordinatorSessionId: SESSION_B,
    coordinatorModelConfigurationRef: 'model-config-b',
    lifecycleState: 'registered',
  });
  if (registered.kind !== 'committed') {
    throw new Error('无法注册第二个 Session');
  }
  const acquired = acquireRuntimeLease(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_B,
    runtimeIncarnationId: INC_B,
    fencingGeneration: 0,
  });
  if (acquired.kind !== 'acquired') {
    throw new Error('第二个 Session 无法取得 Runtime Lease');
  }
  writerB = {
    coordinatorSessionId: SESSION_B,
    runtimeIncarnationId: INC_B,
    fencingGeneration: acquired.lease.fencingGeneration,
  };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-planning-handoff-'));
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
    coordinatorModelConfigurationRef: 'model-config-a',
    planningCycleId: CYCLE,
  });
  if (initialized.kind !== 'initialized') {
    throw new Error('无法创建测试 Scope');
  }
  const acquired = acquireRuntimeLease(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: INC_A,
    fencingGeneration: 0,
  });
  if (acquired.kind !== 'acquired') {
    throw new Error('无法取得 Runtime Lease');
  }
  writerA = {
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: INC_A,
    fencingGeneration: acquired.lease.fencingGeneration,
  };
  registerSecondSession();
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

function prepare(revision = mapRevision(), planRevision = 1): PlanningHandoffProposal {
  const result = preparePlanningHandoff({
    store,
    coordinationScopeId: SCOPE,
    writer: writerA,
    proposalId: PROPOSAL,
    targetCoordinatorSessionId: SESSION_B,
    mapRevision: revision,
    planRevision,
    graphId: null,
    graphVersion: null,
    capsuleRef: 'capsule-1',
  });
  if (result.kind === 'rejected') {
    throw new Error(`prepare 失败：${result.failure.code} ${result.failure.message}`);
  }
  return result.proposal;
}

function review(facts: HandoffReviewFacts, writer: CoordinationWriter = writerB) {
  return reviewPlanningHandoff({ store, coordinationScopeId: SCOPE, writer, proposalId: PROPOSAL, facts });
}

function reviewFacts(overrides: Partial<HandoffReviewFacts> = {}): HandoffReviewFacts {
  return {
    currentMapRevision: mapRevision(),
    currentPlanRevision: 1,
    openDecisionTickets: 0,
    candidate: null,
    ...overrides,
  };
}

function responsibilityOwner(): CoordinatorSessionId | null {
  const result = store.query({ kind: 'planning-responsibility', coordinationScopeId: SCOPE });
  return result.kind === 'planning-responsibility' ? (result.responsibility?.coordinatorSessionId ?? null) : null;
}

test('prepare 阶段只产出提案，责任仍属原 Session', () => {
  const proposal = prepare();

  expect(proposal.phase).toBe('prepared');
  expect(proposal.sourceCoordinatorSessionId).toBe(SESSION_A);
  expect(proposal.targetCoordinatorSessionId).toBe(SESSION_B);
  expect(proposal.proposalRevision).toBe(1);
  expect(responsibilityOwner()).toBe(SESSION_A);
  // 接收方此时不能推进规划：未决交接尚未通过激活门。
  const gate = activationGate({
    proposal,
    responsibility: { coordinationScopeId: SCOPE, coordinatorSessionId: SESSION_A, sourceProposalId: null, assignedAt: 1 },
    coordinatorSessionId: SESSION_B,
  });
  expect(gate.kind).toBe('awaiting_user_prompt');
});

test('只有提案的接收 Session 可以复核，复核失败保持原责任方', () => {
  prepare();

  const bySource = review(reviewFacts(), writerA);
  expect(bySource.kind).toBe('rejected');
  if (bySource.kind === 'rejected') {
    expect(bySource.failure.code).toBe('not_reviewer');
  }

  const changedMap = review(reviewFacts({ currentMapRevision: mapRevision() + 1 }));
  expect(changedMap.kind).toBe('rejected');
  if (changedMap.kind === 'rejected') {
    expect(changedMap.failure.code).toBe('review_failed');
  }

  const withOpenTicket = review(reviewFacts({ openDecisionTickets: 1 }));
  expect(withOpenTicket.kind).toBe('rejected');

  expect(responsibilityOwner()).toBe(SESSION_A);
});

test('review 通过后仍是原责任方，cutover 才把责任转移给接收 Session', () => {
  prepare();
  const reviewed = review(reviewFacts());
  expect(reviewed.kind).toBe('reviewed');
  expect(responsibilityOwner()).toBe(SESSION_A);

  const cut = cutoverPlanningHandoff({
    store,
    coordinationScopeId: SCOPE,
    writer: writerA,
    proposalId: PROPOSAL,
    facts: { currentMapRevision: mapRevision(), currentPlanRevision: 1, candidate: null },
  });
  expect(cut.kind).toBe('cutover');
  expect(responsibilityOwner()).toBe(SESSION_B);

  // 原 Session 不再能推进规划，也不存在两个责任方。
  const gateForSource = activationGate({
    proposal: cut.kind === 'cutover' ? cut.proposal : null,
    responsibility: { coordinationScopeId: SCOPE, coordinatorSessionId: SESSION_B, sourceProposalId: PROPOSAL, assignedAt: 1 },
    coordinatorSessionId: SESSION_A,
  });
  expect(gateForSource.kind).toBe('not_planning_owner');
  const gateForTarget = activationGate({
    proposal: cut.kind === 'cutover' ? cut.proposal : null,
    responsibility: { coordinationScopeId: SCOPE, coordinatorSessionId: SESSION_B, sourceProposalId: PROPOSAL, assignedAt: 1 },
    coordinatorSessionId: SESSION_B,
  });
  expect(gateForTarget.kind).toBe('active');
});

test('交接不触碰在途 Worker 的所有权事实与 Execution Coordination Lease', () => {
  // 在执行租约存在的前提下做一次规划交接：它只转移规划责任。
  const scopeBefore = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  if (scopeBefore.kind !== 'scope' || scopeBefore.scope === null) {
    throw new Error('Scope 不存在');
  }
  const lease = store.transact({
    kind: 'acquire-execution-lease',
    coordinationScopeId: SCOPE,
    expectedRevision: scopeBefore.scope.revision,
    writer: writerA,
  });
  expect(lease.kind).toBe('committed');
  const claims = store.query({ kind: 'snapshot', coordinationScopeId: SCOPE });
  if (claims.kind !== 'snapshot') {
    throw new Error('无法读取快照');
  }
  const before = store.transact({
    kind: 'record-ticket-claim',
    coordinationScopeId: SCOPE,
    expectedRevision: claims.snapshot.scope.revision,
    writer: writerA,
    ticketRef: { kind: 'decision-ticket', id: 'ticket-1' },
  });
  expect(before.kind).toBe('committed');

  prepare();
  expect(review(reviewFacts()).kind).toBe('reviewed');
  expect(
    cutoverPlanningHandoff({
      store,
      coordinationScopeId: SCOPE,
      writer: writerA,
      proposalId: PROPOSAL,
      facts: { currentMapRevision: mapRevision(), currentPlanRevision: 1, candidate: null },
    }).kind,
  ).toBe('cutover');

  const after = store.query({ kind: 'snapshot', coordinationScopeId: SCOPE });
  if (after.kind !== 'snapshot') {
    throw new Error('无法读取快照');
  }
  expect(after.snapshot.executionLease?.coordinatorSessionId).toBe(SESSION_A);
  expect(after.snapshot.ticketClaims.map((claim) => claim.ticketRef.id)).toContain('ticket-1');
  expect(after.snapshot.ticketClaims.every((claim) => claim.state === 'active')).toBe(true);
});

test('cutover 之前取消交接，责任保持原 Session 且提案标记为已取消', () => {
  prepare();
  const cancelled = cancelPlanningHandoff({
    store,
    coordinationScopeId: SCOPE,
    writer: writerB,
    proposalId: PROPOSAL,
  });

  expect(cancelled.kind).toBe('cancelled');
  expect(responsibilityOwner()).toBe(SESSION_A);
  const resume = resumePlanningHandoff({ store, coordinationScopeId: SCOPE });
  expect(resume.kind).toBe('cancelled');
});

test('提案引用的事实变化后不能 cutover，必须重新 prepare', () => {
  prepare();
  expect(review(reviewFacts()).kind).toBe('reviewed');

  const scope = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  if (scope.kind !== 'scope' || scope.scope === null) {
    throw new Error('Scope 不存在');
  }
  const advanced = store.transact({
    kind: 'advance-map-revision',
    coordinationScopeId: SCOPE,
    expectedRevision: scope.scope.revision,
    writer: writerA,
    mapRevision: scope.scope.mapRevision + 1,
  });
  expect(advanced.kind).toBe('committed');

  const stale = cutoverPlanningHandoff({
    store,
    coordinationScopeId: SCOPE,
    writer: writerA,
    proposalId: PROPOSAL,
    facts: { currentMapRevision: mapRevision(), currentPlanRevision: 1, candidate: null },
  });
  expect(stale.kind).toBe('rejected');
  if (stale.kind === 'rejected') {
    expect(stale.failure.code).toBe('proposal_stale');
  }
  expect(responsibilityOwner()).toBe(SESSION_A);
});

test('崩溃后按持久阶段确定性恢复', () => {
  expect(resumePlanningHandoff({ store, coordinationScopeId: SCOPE }).kind).toBe('none');

  prepare();
  expect(resumePlanningHandoff({ store, coordinationScopeId: SCOPE }).kind).toBe('awaiting_review');

  review(reviewFacts());
  expect(resumePlanningHandoff({ store, coordinationScopeId: SCOPE }).kind).toBe('awaiting_cutover');

  cutoverPlanningHandoff({
    store,
    coordinationScopeId: SCOPE,
    writer: writerA,
    proposalId: PROPOSAL,
    facts: { currentMapRevision: mapRevision(), currentPlanRevision: 1, candidate: null },
  });
  expect(resumePlanningHandoff({ store, coordinationScopeId: SCOPE }).kind).toBe('cutover_done');
});

test('未决交接期间第三方 Session 不是责任方，接收方等待用户输入', () => {
  const proposal = prepare();
  const responsibility = {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    sourceProposalId: null,
    assignedAt: 1,
  };

  expect(activationGate({ proposal, responsibility, coordinatorSessionId: SESSION_B }).kind).toBe(
    'awaiting_user_prompt',
  );
  expect(
    activationGate({
      proposal,
      responsibility,
      coordinatorSessionId: SESSION_B,
      awaitingUserPromptSatisfied: true,
    }).kind,
  ).toBe('handoff_review');
  expect(activationGate({ proposal, responsibility, coordinatorSessionId: SESSION_A }).kind).toBe('active');
  expect(activationGate({ proposal, responsibility, coordinatorSessionId: SESSION_C }).kind).toBe(
    'not_planning_owner',
  );

  // 同一 Scope 同时最多一个未终结提案：第二个 prepare 被 store 拒绝。
  const second = preparePlanningHandoff({
    store,
    coordinationScopeId: SCOPE,
    writer: writerA,
    proposalId: 'proposal-2',
    targetCoordinatorSessionId: SESSION_B,
    mapRevision: mapRevision(),
    planRevision: 1,
    graphId: null,
    graphVersion: null,
    capsuleRef: null,
  });
  expect(second.kind).toBe('rejected');
});

test('prepare 后候选图从无到有时提案过期', () => {
  const proposal = prepare();
  const candidate = {
    graphId: 'graph-new' as GraphId,
    generation: 1 as never,
    version: 1 as GraphVersion,
    recordKind: 'initial' as const,
    parentVersion: null,
    mapRevision: proposal.mapRevision,
    planRevision: proposal.planRevision,
    orcaRunId: 'run-new',
    graph: { graphId: 'graph-new' as GraphId, generation: 1 as never, concurrencyLimit: 1, workPackages: [] },
    recordedAt: 1,
  };
  const reviewed = review(reviewFacts({ candidate }));
  expect(reviewed.kind).toBe('rejected');
  expect(isProposalStale(proposal, { currentMapRevision: proposal.mapRevision, currentPlanRevision: proposal.planRevision, candidate })).toBe(true);
});

test('非责任方不能发起交接', () => {
  const result = preparePlanningHandoff({
    store,
    coordinationScopeId: SCOPE,
    writer: writerB,
    proposalId: 'proposal-3',
    targetCoordinatorSessionId: SESSION_C,
    mapRevision: mapRevision(),
    planRevision: 1,
    graphId: 'graph-1' as GraphId,
    graphVersion: 1 as GraphVersion,
    capsuleRef: null,
  });
  expect(result.kind).toBe('rejected');
  if (result.kind === 'rejected') {
    expect(result.failure.code).toBe('not_planning_owner');
  }
});
