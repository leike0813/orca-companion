/**
 * IP-10：Execution Handoff 的行为测试
 * （Requirement「Execution Handoff 以独立状态和 CAS 转移执行责任」，FLOW-04）。
 *
 * 覆盖三个 Scenario：
 * - prepare 与 review 不提前转移责任：Source 仍持有 Lease 与交互责任，Target 只读；
 * - 成功 cutover：以**一次** CAS 转移 Execution Coordination Lease、相关 Pending Interaction 与后续
 *   Worker 事件责任（后两者由 Lease 承载），运行、图、授权与预算身份不变，Target 进入
 *   `awaiting_user_prompt`；
 * - Capsule 不可移植或 CAS 失败：Target 未激活，Source 仍是唯一 owner，失败投影为 blocker。
 *
 * 断言围绕责任归属、CAS 结果与身份不变，不锁定文案或内部调用顺序。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { openCoordinationStore, type CoordinationStore } from '../../src/adapters/storage/coordination-store.js';
import { acquireRuntimeLease } from '../../src/application/coordination/lease-service.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  DispatchId,
  GraphGeneration,
  GraphId,
  InteractionId,
  OperationId,
  PlanningCycleId,
  RuntimeIncarnationId,
  SessionSegmentId,
  WorkerTaskId,
  WorkPackageId,
} from '../../src/application/dto/identity.js';
import {
  cutoverExecutionHandoff,
  executionHandoffActivation,
  isExecutionHandoffTrigger,
  prepareExecutionHandoff,
  reviewExecutionHandoff,
  cancelExecutionHandoff,
  type ExecutionHandoffResult,
  type ExecutionHandoffReviewFacts,
} from '../../src/application/handoff/execution-handoff.js';
import { recordApproval, proposeManifest } from '../../src/application/planning/authorization-service.js';
import { recordInitialGraph } from '../../src/application/planning/graph-history.js';
import type { HandoffGateFacts } from '../../src/application/planning/handoff-gate.js';
import { initializeCoordinationScope } from '../../src/application/planning/initialize-scope.js';
import { transitionToExecution } from '../../src/application/planning/lease-handoff.js';
import type {
  BranchCoordinationStore,
  CoordinationCommand,
  CoordinationSnapshot,
  CoordinationWriter,
  ExecutionHandoffRecord,
} from '../../src/application/ports/branch-coordination-store.js';
import { HANDOFF_RESPONSIBILITIES } from '../../src/application/ports/branch-coordination-store.js';
import { WORKER_ROLES, type ExecutionAuthorizationRecord } from '../../src/domain/planning/execution-authorization.js';
import type { ExecutionGraph, GraphVersionRecord } from '../../src/domain/planning/execution-graph.js';

const SCOPE = 'scope-1' as CoordinationScopeId;
const SESSION_A = 'session-a' as CoordinatorSessionId;
const SESSION_B = 'session-b' as CoordinatorSessionId;
const INC_A = 'inc-a' as RuntimeIncarnationId;
const INC_B = 'inc-b' as RuntimeIncarnationId;
const CYCLE = 'cycle-1' as PlanningCycleId;
const GRAPH_ID = 'graph-1' as GraphId;
const PLAN_REVISION = 1;
const HANDOFF = 'handoff-1';
const WORK_PACKAGE = 'wp-1' as WorkPackageId;
const WORKER_TASK = 'task-1' as WorkerTaskId;
const DISPATCH = 'dispatch-1' as DispatchId;
const SEGMENT = 'segment-1' as SessionSegmentId;

let directory = '';
let store: CoordinationStore;
let writerA: CoordinationWriter;
let now = 1_000;
let graphGeneration = 1 as GraphGeneration;

const clock = (): number => now;

function snapshot(): CoordinationSnapshot {
  const result = store.query({ kind: 'snapshot', coordinationScopeId: SCOPE });
  if (result.kind !== 'snapshot') {
    throw new Error('无法读取 snapshot');
  }
  return result.snapshot;
}

function scopeRevision(): number {
  return snapshot().scope.revision;
}

function handoffRecord(handoffId = HANDOFF): ExecutionHandoffRecord | null {
  const result = store.query({ kind: 'execution-handoff', coordinationScopeId: SCOPE, handoffId });
  return result.kind === 'execution-handoff' ? result.handoff : null;
}

function executionLeaseHolder(): CoordinatorSessionId | null {
  const lease = snapshot().executionLease;
  return lease === null ? null : lease.coordinatorSessionId;
}

function openInteractionsOwnedBy(sessionId: CoordinatorSessionId): readonly InteractionId[] {
  return snapshot()
    .pendingInteractions.filter(
      (interaction) => interaction.state === 'open' && interaction.ownerCoordinatorSessionId === sessionId,
    )
    .map((interaction) => interaction.interactionId);
}

type Observed = { readonly store: BranchCoordinationStore; readonly commands: CoordinationCommand[] };

function observingStore(inner: BranchCoordinationStore): Observed {
  const commands: CoordinationCommand[] = [];
  return {
    store: {
      query: (input) => inner.query(input),
      transact: (input) => {
        commands.push(input);
        return inner.transact(input);
      },
    },
    commands,
  };
}

function emptyGraph(): ExecutionGraph {
  return { graphId: GRAPH_ID, generation: 1 as GraphGeneration, concurrencyLimit: 1, workPackages: [] };
}

function registerAndLease(sessionId: CoordinatorSessionId, incarnation: RuntimeIncarnationId): CoordinationWriter {
  const registered = store.transact({
    kind: 'register-session',
    coordinationScopeId: SCOPE,
    expectedRevision: scopeRevision(),
    writer: writerA,
    coordinatorSessionId: sessionId,
    coordinatorModelConfigurationRef: `model-config-${sessionId}`,
    lifecycleState: 'registered',
  });
  if (registered.kind !== 'committed') {
    throw new Error(`无法注册 ${sessionId}：${registered.message}`);
  }
  const acquired = acquireRuntimeLease(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: sessionId,
    runtimeIncarnationId: incarnation,
    fencingGeneration: 0,
  });
  if (acquired.kind !== 'acquired') {
    throw new Error(`${sessionId} 无法取得 Runtime Lease`);
  }
  return {
    coordinatorSessionId: sessionId,
    runtimeIncarnationId: incarnation,
    fencingGeneration: acquired.lease.fencingGeneration,
  };
}

/** 走真实编译记录路径产出候选图：初始版本绑定当前地图 revision 与给定计划 revision。 */
function recordCandidate(): GraphVersionRecord {
  const recorded = recordInitialGraph({
    store,
    coordinationScopeId: SCOPE,
    writer: writerA,
    graph: emptyGraph(),
    mapRevision: snapshot().scope.mapRevision,
    planRevision: PLAN_REVISION,
    orcaRunId: 'run-1',
  });
  if (recorded.kind !== 'recorded') {
    throw new Error(`无法记录候选图：${recorded.failure.message}`);
  }
  graphGeneration = recorded.version.generation;
  return recorded.version;
}

/** 走真实批准路径产出版权记录：Manifest 必须逐项绑定该候选图。 */
function recordAuthorization(candidate: GraphVersionRecord): ExecutionAuthorizationRecord {
  const proposed = proposeManifest({
    store,
    coordinationScopeId: SCOPE,
    candidate,
    currentPlanRevision: candidate.planRevision,
    rawManifest: {
      coordinationScopeId: SCOPE,
      planningCycleId: CYCLE,
      destinationRef: { kind: 'destination', id: 'destination-1', version: 1 },
      routeMapRef: { kind: 'route-map', id: 'map-1', version: candidate.mapRevision },
      implementationPlanRef: { kind: 'implementation-plan', id: 'plan-1', version: candidate.planRevision },
      graph: { graphId: candidate.graphId, generation: candidate.generation, version: candidate.version },
      baselineHead: 'head-1',
      orcaRunId: 'run-1',
      workerProfiles: WORKER_ROLES.map((role) => ({
        profileRef: { kind: 'worker-profile', id: `profile-${role}` },
        role,
        harness: 'codex',
      })),
      permissions: {
        planner: true,
        implementation: true,
        validator: true,
        finalizer: true,
        gitIntegration: false,
        dependencyChanges: false,
      },
      limits: {},
      workspacePolicy: { canonicalWorktree: '/tmp/worktree', worktreeIsolation: 'per_work_package' },
      gitPolicy: {
        canonicalBranch: 'main',
        remotes: ['origin'],
        refs: ['refs/heads/main'],
        allowForcePush: false,
      },
      dependencyPolicy: { allowDependencyChanges: false, registry: null },
      acceptedRisks: ['risk-1'],
    },
  });
  if (proposed.kind !== 'proposed') {
    throw new Error(`无法组装 Manifest：${proposed.failure.message}`);
  }
  const recorded = recordApproval({
    store,
    coordinationScopeId: SCOPE,
    writer: writerA,
    authorizationId: 'authorization-1',
    manifest: proposed.manifest,
    currentPlanRevision: candidate.planRevision,
    approvalRef: 'approval-1',
  });
  if (recorded.kind !== 'recorded') {
    throw new Error(`无法记录批准：${recorded.failure.message}`);
  }
  return recorded.authorization;
}

function gateFactsFor(
  candidate: GraphVersionRecord | null,
  authorization: ExecutionAuthorizationRecord | null,
): HandoffGateFacts {
  return {
    openDecisionTickets: 0,
    fogPresent: false,
    unresolvedInteractions: 0,
    unresolvedMutations: 0,
    currentMapRevision: candidate?.mapRevision ?? 0,
    currentPlanRevision: candidate?.planRevision ?? PLAN_REVISION,
    candidate,
    authorization,
  };
}

function prepare(handoffId = HANDOFF): ExecutionHandoffResult {
  return prepareExecutionHandoff({
    store,
    coordinationScopeId: SCOPE,
    writer: writerA,
    handoffId,
    targetSessionId: SESSION_B,
    graphGeneration,
    capsuleRef: 'capsule-1',
  });
}

function review(
  overrides: Partial<Parameters<typeof reviewExecutionHandoff>[0]['facts']> = {},
  handoffId = HANDOFF,
): ExecutionHandoffResult {
  return reviewExecutionHandoff({
    store,
    coordinationScopeId: SCOPE,
    writer: writerA,
    handoffId,
    facts: {
      scopeRevision: scopeRevision(),
      currentGraphGeneration: graphGeneration,
      targetLifecycleState: 'registered',
      sourceCheckpoint: 'recoverable',
      capsulePortable: true,
      ...overrides,
    },
  });
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-execution-handoff-'));
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
  // Target 必须是已注册的 Session；这里走真实注册与 Runtime Lease 路径。
  registerAndLease(SESSION_B, INC_B);

  // 真实路径进入 execution_coordination：候选图、授权、预算与执行租约一起生效。
  const candidate = recordCandidate();
  const authorization = recordAuthorization(candidate);
  const transitioned = transitionToExecution({
    store,
    coordinationScopeId: SCOPE,
    planningCycleId: CYCLE,
    writer: writerA,
    gateFacts: gateFactsFor(candidate, authorization),
  });
  if (transitioned.kind !== 'transitioned') {
    throw new Error(`无法切换到 execution_coordination：${transitioned.kind}`);
  }
  const budgeted = store.transact({
    kind: 'consume-budget',
    coordinationScopeId: SCOPE,
    expectedRevision: scopeRevision(),
    writer: writerA,
    budgetKey: 'coordinator_model_calls',
    approvedLimitRef: 'limit-1',
    amount: 2,
  });
  if (budgeted.kind !== 'committed') {
    throw new Error('无法消费预算');
  }
  const interaction = store.transact({
    kind: 'record-pending-interaction',
    coordinationScopeId: SCOPE,
    expectedRevision: scopeRevision(),
    writer: writerA,
    interactionId: 'interaction-1' as InteractionId,
    ownerCoordinatorSessionId: SESSION_A,
    subjectRef: { kind: 'worker-question', id: 'question-1' },
  });
  if (interaction.kind !== 'committed') {
    throw new Error('无法记录 Pending Interaction');
  }
  const binding = store.transact({
    kind: 'record-materialization-binding',
    coordinationScopeId: SCOPE,
    expectedRevision: scopeRevision(),
    writer: writerA,
    workPackageId: WORK_PACKAGE,
    orcaTaskId: 'orca-task-1',
    creationOperationId: 'operation-1' as OperationId,
  });
  if (binding.kind !== 'committed') {
    throw new Error('无法记录物化绑定');
  }
  const segment = store.transact({
    kind: 'record-session-segment',
    coordinationScopeId: SCOPE,
    expectedRevision: scopeRevision(),
    writer: writerA,
    segmentId: SEGMENT,
    workPackageId: WORK_PACKAGE,
    role: 'implementation',
    workerTaskId: WORKER_TASK,
    dispatchId: DISPATCH,
    attemptId: 'attempt-1',
    sessionBindingId: 'binding-1',
    lastTranscriptRef: 'transcript-1',
    terminalReceiptRef: null,
    transcriptReferenceable: true,
    verifiable: true,
  });
  if (segment.kind !== 'committed') {
    throw new Error('无法记录 Session Segment');
  }
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test('prepare 只产出提案：Source 仍持有全部执行责任，Target 只能读取审阅信息', () => {
  const result = prepare();

  expect(result.kind).toBe('prepared');
  const record = handoffRecord();
  expect(record?.phase).toBe('prepared');
  expect(record?.sourceSessionId).toBe(SESSION_A);
  expect(record?.targetSessionId).toBe(SESSION_B);
  expect(record?.responsibilitySet).toEqual([...HANDOFF_RESPONSIBILITIES]);
  // 责任未转移。
  expect(executionLeaseHolder()).toBe(SESSION_A);
  expect(openInteractionsOwnedBy(SESSION_A)).toHaveLength(1);
  const gate = executionHandoffActivation({
    handoff: record,
    executionLeaseHolderSessionId: SESSION_A,
    coordinatorSessionId: SESSION_B,
  });
  expect(gate.kind).toBe('awaiting_user_prompt');
  expect(
    executionHandoffActivation({
      handoff: record,
      executionLeaseHolderSessionId: SESSION_A,
      coordinatorSessionId: SESSION_A,
    }).kind,
  ).toBe('source_active');
});

test('review 校验 checkpoint、Capsule、Target、expected revision 与 Graph Generation，通过后仍不转移责任', () => {
  prepare();
  const reviewed = review();

  expect(reviewed.kind).toBe('reviewed');
  expect(handoffRecord()?.phase).toBe('reviewed');
  expect(executionLeaseHolder()).toBe(SESSION_A);
  expect(openInteractionsOwnedBy(SESSION_A)).toHaveLength(1);
  // 复核通过但仍未 cutover：Target 依旧不能激活模型循环。
  expect(
    executionHandoffActivation({
      handoff: handoffRecord(),
      executionLeaseHolderSessionId: SESSION_A,
      coordinatorSessionId: SESSION_B,
    }).kind,
  ).toBe('awaiting_user_prompt');
});

test('review 失败时写 blocker，Source 仍是唯一 owner，Target 未激活', () => {
  const cases: readonly { readonly name: string; readonly overrides: Partial<ExecutionHandoffReviewFacts> }[] = [
    { name: 'checkpoint 不可恢复', overrides: { sourceCheckpoint: 'unrecoverable' } },
    { name: 'checkpoint 缺失', overrides: { sourceCheckpoint: 'absent' } },
    { name: 'Capsule 不可移植', overrides: { capsulePortable: false } },
    { name: 'Target 未注册', overrides: { targetLifecycleState: null } },
    { name: 'Target 已取消', overrides: { targetLifecycleState: 'cancelled' } },
    { name: 'expected revision 过期', overrides: { scopeRevision: scopeRevision() - 1 } },
    {
      name: 'Graph Generation 已变化',
      overrides: { currentGraphGeneration: (graphGeneration + 1) as GraphGeneration },
    },
  ];

  // 一个 Scope 同时至多一条未终结 handoff，因此复用同一条提案，逐项验证失败原因后重开。
  const handoffId = `${HANDOFF}-review-failures`;
  expect(prepare(handoffId).kind, 'prepare').toBe('prepared');
  for (const scenario of cases) {
    const reviewed = review(scenario.overrides, handoffId);

    expect(reviewed.kind, `${scenario.name}: ${JSON.stringify(reviewed)}`).toBe('blocked');
    expect(handoffRecord(handoffId)?.phase, scenario.name).toBe('blocked');
    expect(handoffRecord(handoffId)?.blockingReason, scenario.name).toBeTruthy();
    expect(executionLeaseHolder(), scenario.name).toBe(SESSION_A);
    expect(openInteractionsOwnedBy(SESSION_A), scenario.name).toHaveLength(1);
    expect(
      executionHandoffActivation({
        handoff: handoffRecord(handoffId),
        executionLeaseHolderSessionId: SESSION_A,
        coordinatorSessionId: SESSION_B,
      }).kind,
      scenario.name,
    ).toBe('awaiting_user_prompt');

    // blocked → prepared 是允许的恢复路径：用户补充事实后重开提案。
    const record = handoffRecord(handoffId);
    if (record === null) {
      throw new Error('提案丢失');
    }
    const reopened = store.transact({
      kind: 'advance-execution-handoff',
      coordinationScopeId: SCOPE,
      expectedRevision: scopeRevision(),
      writer: writerA,
      handoffId,
      phase: 'prepared',
      expectedHandoffRevision: record.handoffRevision,
    });
    expect(reopened.kind, scenario.name).toBe('committed');
  }
});

test('review 拒绝不完整的责任集合', () => {
  // 直接写一条责任集合不完整的提案：prepare 正常路径永远写全集，这里模拟旧记录/半写入。
  const recorded = store.transact({
    kind: 'record-execution-handoff',
    coordinationScopeId: SCOPE,
    expectedRevision: scopeRevision(),
    writer: writerA,
    handoffId: HANDOFF,
    sourceSessionId: SESSION_A,
    targetSessionId: SESSION_B,
    graphGeneration,
    responsibilitySet: ['execution_coordination_lease'],
    phase: 'prepared',
    coordinatorContextCapsuleRef: 'capsule-1',
    expectedHandoffRevision: null,
  });
  expect(recorded.kind).toBe('committed');

  const reviewed = review();
  expect(reviewed.kind).toBe('blocked');
  expect(reviewed.kind === 'blocked' ? reviewed.failure.code : null).toBe('responsibility_set_incomplete');
});

test('成功 cutover：一次 CAS 转移 Lease 与责任，运行/图/授权/预算身份不变，Target 进入 awaiting_user_prompt', () => {
  prepare();
  const reviewed = review();
  expect(reviewed.kind).toBe('reviewed');
  const handoffRevisionBefore = handoffRecord()?.handoffRevision ?? 0;
  const before = snapshot();
  const observed = observingStore(store);

  const result = cutoverExecutionHandoff({
    store: observed.store,
    coordinationScopeId: SCOPE,
    writer: writerA,
    handoffId: HANDOFF,
  });

  expect(result.kind, JSON.stringify(result)).toBe('cutover');
  // 单次 CAS：提案级 revision 只前进一格，且没有第二条 handoff 命令。
  expect(handoffRecord()?.handoffRevision).toBe(handoffRevisionBefore + 1);
  expect(observed.commands.filter((command) => command.kind === 'advance-execution-handoff')).toHaveLength(1);
  // 责任转移由 store 在同一事务内完成：本模块不自己串 release/acquire。
  expect(observed.commands.some((command) => command.kind === 'release-execution-lease')).toBe(false);
  expect(observed.commands.some((command) => command.kind === 'acquire-execution-lease')).toBe(false);

  // Lease 与相关 Pending Interaction 都归 Target；后续 Worker 事件责任由 Lease 承载。
  expect(executionLeaseHolder()).toBe(SESSION_B);
  expect(openInteractionsOwnedBy(SESSION_A)).toHaveLength(0);
  expect(openInteractionsOwnedBy(SESSION_B)).toHaveLength(1);

  // 运行、图、授权与预算身份不变。
  const after = snapshot();
  expect(after.scope.graphId).toBe(before.scope.graphId);
  expect(after.scope.graphVersion).toBe(before.scope.graphVersion);
  expect(after.scope.authorizationId).toBe(before.scope.authorizationId);
  expect(after.scope.authorizationVersion).toBe(before.scope.authorizationVersion);
  expect(after.scope.planningCycleId).toBe(before.scope.planningCycleId);
  expect(after.materializationBindings).toEqual(before.materializationBindings);
  expect(after.sessionSegments).toEqual(before.sessionSegments);
  const budgets = store.query({ kind: 'budget-counters', coordinationScopeId: SCOPE });
  expect(budgets.kind === 'budget-counters' ? budgets.counters : []).toMatchObject([
    { budgetKey: 'coordinator_model_calls', approvedLimitRef: 'limit-1', consumed: 2 },
  ]);
  expect(after.ticketClaims).toEqual(before.ticketClaims);

  // Target 进入 awaiting_user_prompt：下一条普通 Prompt 之前不激活模型循环。
  const awaiting = executionHandoffActivation({
    handoff: handoffRecord(),
    executionLeaseHolderSessionId: SESSION_B,
    coordinatorSessionId: SESSION_B,
  });
  expect(awaiting.kind).toBe('awaiting_user_prompt');
  expect(
    executionHandoffActivation({
      handoff: handoffRecord(),
      executionLeaseHolderSessionId: SESSION_B,
      coordinatorSessionId: SESSION_B,
      awaitingUserPromptSatisfied: true,
    }).kind,
  ).toBe('target_active');
  expect(
    executionHandoffActivation({
      handoff: handoffRecord(),
      executionLeaseHolderSessionId: SESSION_B,
      coordinatorSessionId: SESSION_A,
    }).kind,
  ).toBe('not_owner');
});

test('review 之后出现其它写入时 cutover CAS 失败：Source 仍是唯一 owner，失败投影为 blocker', () => {
  prepare();
  expect(review().kind).toBe('reviewed');

  // review 与 cutover 之间的任何 Scope 写入都让提案过期。
  const paused = store.transact({
    kind: 'record-control-state',
    coordinationScopeId: SCOPE,
    expectedRevision: scopeRevision(),
    writer: writerA,
    controlState: 'paused',
  });
  expect(paused.kind).toBe('committed');

  const result = cutoverExecutionHandoff({
    store,
    coordinationScopeId: SCOPE,
    writer: writerA,
    handoffId: HANDOFF,
  });

  expect(result.kind).toBe('blocked');
  expect(result.kind === 'blocked' ? result.failure.code : null).toBe('stale_revision');
  expect(handoffRecord()?.phase).toBe('blocked');
  expect(handoffRecord()?.blockingReason).toBeTruthy();
  expect(executionLeaseHolder()).toBe(SESSION_A);
  expect(openInteractionsOwnedBy(SESSION_A)).toHaveLength(1);
  // 投影为 blocker 的数据来源：phase 与 blockingReason 都在持久记录里。
  expect(handoffRecord()?.phase === 'blocked' && handoffRecord()?.blockingReason !== null).toBe(true);
});

test('cutover 前取消：责任留在 Source，Target 未激活', () => {
  prepare();
  expect(review().kind).toBe('reviewed');

  const cancelled = cancelExecutionHandoff({
    store,
    coordinationScopeId: SCOPE,
    writer: writerA,
    handoffId: HANDOFF,
  });

  expect(cancelled.kind).toBe('cancelled');
  expect(handoffRecord()?.phase).toBe('cancelled');
  expect(executionLeaseHolder()).toBe(SESSION_A);
  expect(openInteractionsOwnedBy(SESSION_A)).toHaveLength(1);
  expect(
    executionHandoffActivation({
      handoff: handoffRecord(),
      executionLeaseHolderSessionId: SESSION_A,
      coordinatorSessionId: SESSION_B,
    }).kind,
  ).toBe('not_owner');
});

test('普通挂起与唤醒不构成交接触发', () => {
  expect(isExecutionHandoffTrigger('user_command')).toBe(true);
  for (const implicit of ['suspend', 'resume', 'wake_admission', 'keepalive', 'reconciliation']) {
    expect(isExecutionHandoffTrigger(implicit)).toBe(false);
  }
});
