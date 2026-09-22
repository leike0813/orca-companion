/**
 * `m1-evolve-execution-graph` 的行为测试：Replanning Transition 与 Generation Cutover（IC-10 / IP-7、IP-8）。
 *
 * 覆盖 `execution/replanning` 的前两个 Requirement：过渡必须结清在途工作并释放 Lease；Cutover 必须原子
 * 替换代际、让新代际全新开始，并在切换前允许取消。
 */

import { afterEach, beforeEach, expect, test } from 'vitest';

import type {
  GraphGeneration,
  GraphId,
  GraphVersion,
  PlanningCycleId,
} from '../../src/application/dto/identity.js';
import { recordInitialGraph } from '../../src/application/planning/graph-history.js';
import { recordApproval } from '../../src/application/planning/authorization-service.js';
import {
  classifyGenerationEvent,
  isGenerationRecoverable,
  planReplanningCancellation,
  planReplanningTransition,
  replanningClosure,
  settlementComplete,
  settlementGaps,
  validateCutoverRefs,
  type CandidateGenerationRefs,
} from '../../src/domain/execution/replanning.js';
import {
  beginReplanningTransition,
  cancelReplanningTransition,
  commitGenerationCutover,
  completeReplanningTransition,
  ensureGraphGenerationRecord,
} from '../../src/application/execution/replanning-service.js';
import {
  createExecutionScopeHarness,
  executionManifest,
  executionWorkPackage,
  EXECUTION_AUTHORIZATION_ID,
  EXECUTION_CYCLE,
  EXECUTION_GENERATION,
  EXECUTION_MAP_REVISION,
  EXECUTION_PLAN_REVISION,
  EXECUTION_RUN_ID,
  type ExecutionScopeHarness,
} from '../support/execution-harness.js';

const CANDIDATE_GRAPH = 'scope-1#g2' as GraphId;
const CANDIDATE_RUN = 'run-2';
const CANDIDATE_AUTH = 'auth-2';
const NEXT_CYCLE = 'cycle-2' as PlanningCycleId;

let harness: ExecutionScopeHarness;

beforeEach(() => {
  harness = createExecutionScopeHarness();
});

afterEach(() => {
  harness.close();
});

function predecessorFacts() {
  return {
    graphId: harness.graphId,
    generation: harness.generation,
    planningCycleId: EXECUTION_CYCLE,
    orcaRunId: EXECUTION_RUN_ID,
    baselineHead: 'head-1',
  };
}

function scopeState() {
  const read = harness.store.query({ kind: 'scope', coordinationScopeId: harness.scopeId });
  if (read.kind !== 'scope' || read.scope === null) {
    throw new Error('无法读取 Scope');
  }
  return read.scope;
}

function generationStatus(graphId: GraphId): string | null {
  const read = harness.store.query({ kind: 'graph-generation', coordinationScopeId: harness.scopeId, graphId });
  return read.kind === 'graph-generation' ? (read.generation?.status ?? null) : null;
}

function executionLeaseHolder(): string | null {
  const leases = harness.store.query({ kind: 'leases', coordinationScopeId: harness.scopeId });
  if (leases.kind !== 'leases') {
    return null;
  }
  return (
    leases.leases.find((lease) => lease.kind === 'execution_coordination' && lease.releasedAt === null)
      ?.coordinatorSessionId ?? null
  );
}

function begin() {
  return beginReplanningTransition({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    facts: {
      userRequestedReplanning: true,
      goalOrGlobalConstraintChanged: false,
      graphRevisionsExhausted: false,
    },
    predecessor: predecessorFacts(),
  });
}

test('过渡触发条件必须显式，已处于过渡中时拒绝', () => {
  expect(
    planReplanningTransition({
      controlState: 'active',
      userRequestedReplanning: false,
      goalOrGlobalConstraintChanged: false,
      graphRevisionsExhausted: false,
      transitionAlreadyActive: false,
    }).kind,
  ).toBe('rejected');

  expect(
    planReplanningTransition({
      controlState: 'active',
      userRequestedReplanning: false,
      goalOrGlobalConstraintChanged: true,
      graphRevisionsExhausted: false,
      transitionAlreadyActive: false,
    }),
  ).toMatchObject({ kind: 'start', reason: '目标或全局约束发生变化' });

  expect(
    planReplanningTransition({
      controlState: 'replanning_transition',
      userRequestedReplanning: true,
      goalOrGlobalConstraintChanged: false,
      graphRevisionsExhausted: false,
      transitionAlreadyActive: true,
    }),
  ).toMatchObject({ kind: 'rejected', code: 'already_in_transition' });

  expect(
    planReplanningTransition({
      controlState: 'unverifiable',
      userRequestedReplanning: true,
      goalOrGlobalConstraintChanged: false,
      graphRevisionsExhausted: false,
      transitionAlreadyActive: false,
    }),
  ).toMatchObject({ kind: 'rejected', code: 'control_state_blocks' });
});

test('两种收尾方式都不伪造已停止，且结果只记在被挂起的代际上', () => {
  const drain = replanningClosure('drain');
  expect(drain.waitsForDrain).toBe(true);
  expect(drain.requestsWorkerStop).toBe(false);
  expect(drain.fabricatesStopped).toBe(false);
  expect(drain.recordsAgainstSuspendedGeneration).toBe(true);

  const cancel = replanningClosure('cancel_and_reconcile');
  expect(cancel.waitsForDrain).toBe(false);
  expect(cancel.requestsWorkerStop).toBe(true);
  expect(cancel.reconciliationRequired).toBe(true);
  expect(cancel.fabricatesStopped).toBe(false);

  expect(settlementComplete({ inFlightWorkers: 0, pendingDeliveries: 0, openInteractions: 0, unresolvedIntents: 0 })).toBe(true);
  expect(settlementGaps({ inFlightWorkers: 1, pendingDeliveries: 0, openInteractions: 1, unresolvedIntents: 0 })).toEqual([
    '在途 Worker 1 个',
    '未决交互 1 个',
  ]);
});

test('开始过渡先停派发并挂起前代代际', () => {
  const started = begin();
  expect(started.kind).toBe('started');
  expect(scopeState().controlState).toBe('replanning_transition');
  expect(generationStatus(harness.graphId)).toBe('suspended');
  // 过渡期间不释放 Lease：Worker 仍要运行至可核验终态。
  expect(executionLeaseHolder()).not.toBeNull();
});

test('drain 模式下未结清就等待，结清后才释放 Lease 并建立新 Planning Cycle', () => {
  begin();
  const waiting = completeReplanningTransition({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    closure: 'drain',
    settlement: { inFlightWorkers: 1, pendingDeliveries: 0, openInteractions: 0, unresolvedIntents: 0 },
    newPlanningCycleId: NEXT_CYCLE,
  });
  expect(waiting.kind).toBe('waiting');
  expect(executionLeaseHolder()).not.toBeNull();
  expect(scopeState().mode).toBe('execution_coordination');

  const released = completeReplanningTransition({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    closure: 'drain',
    settlement: { inFlightWorkers: 0, pendingDeliveries: 0, openInteractions: 0, unresolvedIntents: 0 },
    newPlanningCycleId: NEXT_CYCLE,
  });
  expect(released.kind).toBe('released');
  const scope = scopeState();
  expect(scope.mode).toBe('route_planning');
  expect(scope.planningCycleId).toBe(NEXT_CYCLE);
  expect(scope.controlState).toBe('active');
  expect(executionLeaseHolder()).toBeNull();
});

test('cancel-and-reconcile 在停止未确认时保持 cancelling，不伪造已停止', () => {
  begin();
  const pending = completeReplanningTransition({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    closure: 'cancel_and_reconcile',
    settlement: { inFlightWorkers: 1, pendingDeliveries: 0, openInteractions: 0, unresolvedIntents: 0 },
    workerStopsConfirmed: false,
    newPlanningCycleId: NEXT_CYCLE,
  });
  expect(pending.kind).toBe('cancelling');
  expect(scopeState().mode).toBe('execution_coordination');
});

test('切换前取消重规划：对账完成后恢复被挂起的代际并重新取得 Lease', () => {
  begin();
  const blocked = cancelReplanningTransition({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    suspendedGraphId: harness.graphId,
    refreshedAuthorization: { authorizationId: EXECUTION_AUTHORIZATION_ID, authorizationVersion: 1 },
    reconciliationResolved: false,
  });
  expect(blocked.kind).toBe('blocked');
  expect(generationStatus(harness.graphId)).toBe('suspended');

  const cancelled = cancelReplanningTransition({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    suspendedGraphId: harness.graphId,
    refreshedAuthorization: { authorizationId: EXECUTION_AUTHORIZATION_ID, authorizationVersion: 1 },
    reconciliationResolved: true,
  });
  expect(cancelled.kind).toBe('cancelled');
  expect(generationStatus(harness.graphId)).toBe('active');
  expect(scopeState().controlState).toBe('active');
  expect(executionLeaseHolder()).toBe(harness.writer.coordinatorSessionId);
  expect(planReplanningCancellation({ reconciliationResolved: false, authorizationRefreshed: true }).kind).toBe('blocked');
});

function recordCandidateGeneration(options: { runId?: string; workPackageId?: string } = {}): void {
  const runId = options.runId ?? CANDIDATE_RUN;
  const ensured = ensureGraphGenerationRecord({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    graphId: CANDIDATE_GRAPH,
    generation: 2 as GraphGeneration,
    planningCycleId: NEXT_CYCLE,
    orcaRunId: runId,
    predecessorGraphId: harness.graphId,
    baselineHead: 'head-2',
  });
  if (ensured.kind === 'rejected') {
    throw new Error(ensured.failure.message);
  }
  const recorded = recordInitialGraph({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    graph: {
      graphId: CANDIDATE_GRAPH,
      generation: 2 as GraphGeneration,
      concurrencyLimit: 1,
      workPackages: [executionWorkPackage(options.workPackageId ?? 'wp-new')],
    },
    mapRevision: EXECUTION_MAP_REVISION,
    planRevision: EXECUTION_PLAN_REVISION,
    orcaRunId: runId,
  });
  if (recorded.kind !== 'recorded') {
    throw new Error('无法记录候选图');
  }
  const authorized = recordApproval({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    authorizationId: CANDIDATE_AUTH,
    approvalRef: 'approval-2',
    manifest: executionManifest({
      graphId: CANDIDATE_GRAPH,
      generation: 2 as GraphGeneration,
      mapRevision: EXECUTION_MAP_REVISION,
      planRevision: EXECUTION_PLAN_REVISION,
      orcaRunId: runId,
      baselineHead: 'head-2',
      planningCycleId: NEXT_CYCLE,
    }),
    currentPlanRevision: EXECUTION_PLAN_REVISION,
  });
  if (authorized.kind === 'rejected') {
    throw new Error(`无法记录候选授权: ${authorized.failure.message}`);
  }
}

function cutoverRefs(overrides: Partial<CandidateGenerationRefs> = {}): CandidateGenerationRefs {
  return {
    predecessorGraphId: harness.graphId,
    candidateGraphId: CANDIDATE_GRAPH,
    candidateGeneration: 2 as GraphGeneration,
    candidateGraphVersion: 1 as GraphVersion,
    candidateRunId: CANDIDATE_RUN,
    planningCycleId: NEXT_CYCLE,
    authorizationId: CANDIDATE_AUTH,
    authorizationVersion: 2,
    baselineHead: 'head-2',
    expectedRevision: scopeState().revision,
    ...overrides,
  };
}

function prepareForCutover(options: { runId?: string; workPackageId?: string } = {}): void {
  begin();
  completeReplanningTransition({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    closure: 'drain',
    settlement: { inFlightWorkers: 0, pendingDeliveries: 0, openInteractions: 0, unresolvedIntents: 0 },
    newPlanningCycleId: NEXT_CYCLE,
  });
  for (const mapRevision of [1, EXECUTION_MAP_REVISION]) {
    const advanced = harness.store.transact({
      kind: 'advance-map-revision',
      coordinationScopeId: harness.scopeId,
      expectedRevision: scopeState().revision,
      writer: harness.writer,
      mapRevision,
    });
    if (advanced.kind === 'rejected') throw new Error(advanced.message);
  }
  recordCandidateGeneration(options);
}

test('Cutover 在一次写入里冻结前代、激活候选并切换全部引用', () => {
  prepareForCutover();
  expect(scopeState().graphId).toBe(harness.graphId);
  expect(scopeState().authorizationId).toBe(EXECUTION_AUTHORIZATION_ID);
  const result = commitGenerationCutover({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    refs: cutoverRefs(),
  });
  expect(result.kind).toBe('cutover');

  const scope = scopeState();
  expect(scope.graphId).toBe(CANDIDATE_GRAPH);
  expect(scope.planningCycleId).toBe(NEXT_CYCLE);
  expect(scope.mode).toBe('execution_coordination');
  expect(scope.authorizationId).toBe(CANDIDATE_AUTH);
  expect(generationStatus(CANDIDATE_GRAPH)).toBe('active');
  expect(generationStatus(harness.graphId)).toBe('frozen');
  expect(isGenerationRecoverable('frozen')).toBe(false);
  expect(executionLeaseHolder()).toBe(harness.writer.coordinatorSessionId);

  // 幂等：重复提交不产生第二份代际事实。
  const replay = commitGenerationCutover({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    refs: cutoverRefs({ expectedRevision: scopeState().revision }),
  });
  expect(replay.kind).toBe('cutover');
  expect(generationStatus(CANDIDATE_GRAPH)).toBe('active');
});

test('Cutover 拒绝错误前代和复用的 Run', () => {
  prepareForCutover({ runId: EXECUTION_RUN_ID, workPackageId: 'wp-b' });
  const wrongPredecessor = commitGenerationCutover({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    refs: cutoverRefs({ predecessorGraphId: 'another-graph' as GraphId, candidateRunId: EXECUTION_RUN_ID }),
  });
  expect(wrongPredecessor.kind).toBe('rejected');
  const reusedRun = commitGenerationCutover({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    refs: cutoverRefs({ candidateRunId: EXECUTION_RUN_ID }),
  });
  expect(reusedRun.kind).toBe('rejected');
  expect(generationStatus(CANDIDATE_GRAPH)).toBe('candidate');
  expect(generationStatus(harness.graphId)).toBe('suspended');
  expect(scopeState().graphId).toBe(harness.graphId);
});

test('Cutover 拒绝复用前代 WorkPackageId', () => {
  prepareForCutover({ workPackageId: 'wp-b' });
  const result = commitGenerationCutover({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    refs: cutoverRefs(),
  });
  expect(result.kind).toBe('rejected');
  expect(generationStatus(CANDIDATE_GRAPH)).toBe('candidate');
});

test('引用集合不完整时整体阻断，不产生任何变化', () => {
  prepareForCutover();
  const incomplete = cutoverRefs({ candidateRunId: '' });
  expect(validateCutoverRefs(incomplete).kind).toBe('blocked');

  const result = commitGenerationCutover({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    refs: incomplete,
  });
  expect(result.kind).toBe('blocked');
  expect(generationStatus(CANDIDATE_GRAPH)).toBe('candidate');
  expect(generationStatus(harness.graphId)).toBe('suspended');
  expect(scopeState().mode).toBe('route_planning');

  expect(validateCutoverRefs(cutoverRefs({ candidateGraphId: harness.graphId })).kind).toBe('blocked');
  expect(validateCutoverRefs(cutoverRefs()).kind).toBe('ready');
});

test('过期的 switch revision 被拒绝，代际状态不变', () => {
  prepareForCutover();
  const stale = commitGenerationCutover({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    refs: cutoverRefs({ expectedRevision: (scopeState().revision - 1) }),
  });
  expect(stale.kind).toBe('rejected');
  if (stale.kind === 'rejected') {
    expect(stale.failure.code).toBe('stale_revision');
  }
  expect(generationStatus(CANDIDATE_GRAPH)).toBe('candidate');
});

test('Cutover 之后前代事件只补全历史，不影响当前代际', () => {
  prepareForCutover();
  commitGenerationCutover({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    refs: cutoverRefs(),
  });
  expect(classifyGenerationEvent({ eventGraphId: harness.graphId, activeGraphId: CANDIDATE_GRAPH })).toBe(
    'predecessor_history',
  );
  expect(classifyGenerationEvent({ eventGraphId: CANDIDATE_GRAPH, activeGraphId: CANDIDATE_GRAPH })).toBe(
    'current_generation',
  );
});

test('新代际使用全新的 Graph、Run 与 WorkPackageId', () => {
  prepareForCutover();
  commitGenerationCutover({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    refs: cutoverRefs(),
  });
  const read = harness.store.query({ kind: 'graph-generation', coordinationScopeId: harness.scopeId, graphId: CANDIDATE_GRAPH });
  expect(read.kind === 'graph-generation' ? read.generation : null).toEqual(
    expect.objectContaining({
      orcaRunId: CANDIDATE_RUN,
      planningCycleId: NEXT_CYCLE,
      predecessorGraphId: harness.graphId,
      status: 'active',
    }),
  );
  const versions = harness.store.query({
    kind: 'graph-versions',
    coordinationScopeId: harness.scopeId,
    graphId: CANDIDATE_GRAPH,
  });
  const candidatePackages = versions.kind === 'graph-versions' ? versions.versions[0]?.graph.workPackages : [];
  expect(candidatePackages?.map((entry) => entry.workPackageId)).toEqual(['wp-new']);
  expect(EXECUTION_GENERATION).toBe(1);
});
