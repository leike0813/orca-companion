/**
 * 6.4 验收层：Execution Handoff 的伪造与真实分层
 * （change: `m1-recover-execution`；spec `coordinator/execution-handoff` 与 D10/D12）。
 *
 * 全程只使用 fake chat model 与 fake backend：
 *
 * - 普通挂起 / 唤醒（IC-04 的 `admitWakeBatch`）不构成交接触发，也不转移 Execution Coordination Lease；
 * - prepare 与 review 都不提前转移责任：Source 仍是唯一 owner，Target 只能读审阅信息；
 * - cutover 以一次 CAS 转移 Lease、相关 Pending Interaction 与后续 Worker 事件责任（后两者由 Lease
 *   承载），运行 / 图 / 授权 / 预算身份逐项不变，Target 进入 `awaiting_user_prompt`；
 * - 任一步失败都保持 Source 为唯一 owner，不激活 Target；
 * - 交接与挂起 / 唤醒全程零模型生成调用：注入的 fake chat model 在能力核验之后不再被要求生成
 *   （能力核验本身会调用它，所以基线大于 0；再用一次显式 `invoke` 证明计数器不是恒零）。
 *
 * 装置复用 `tests/support/recovery-harness.ts`，并在其上补齐真实 Runtime（IC-04 的模型装配、
 * checkpoint 与 Runtime Lease）与 Target Session 注册；不另建 store 装配。
 *
 * 「cutover 只发一条 advance-execution-handoff」「review 校验七类事实」的逐项断言已在
 * `tests/handoff/execution-handoff.test.ts` 覆盖，这里只覆盖伪造层特有的责任保持与零调用。
 */

import { afterEach, expect, test } from 'vitest';
import { HumanMessage } from '@langchain/core/messages';

import { openCheckpointStore } from '../../../src/adapters/storage/checkpoint-store.js';
import {
  checkpointDatabasePath,
  startCoordinatorRuntime,
  type StartedCoordinatorRuntime,
} from '../../../src/bootstrap/coordinator-runtime.js';
import { acquireRuntimeLease } from '../../../src/application/coordination/lease-service.js';
import { writerFor } from '../../../src/application/coordinator/runtime-guard.js';
import { admitWakeBatch } from '../../../src/application/coordinator/wake-admission.js';
import type {
  CoordinatorSessionId,
  DispatchId,
  GraphGeneration,
  InteractionId,
  RuntimeIncarnationId,
  SessionSegmentId,
} from '../../../src/application/dto/identity.js';
import {
  HANDOFF_RESPONSIBILITIES,
  type BranchCoordinationStore,
  type CoordinationSnapshot,
  type CoordinationWriter,
  type ExecutionHandoffRecord,
} from '../../../src/application/ports/branch-coordination-store.js';
import {
  cutoverExecutionHandoff,
  executionHandoffActivation,
  isExecutionHandoffTrigger,
  prepareExecutionHandoff,
  reviewExecutionHandoff,
  type ExecutionHandoffResult,
} from '../../../src/application/handoff/execution-handoff.js';
import {
  COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
  type WakeBatch,
} from '../../../src/domain/coordinator/session-state.js';
import { CountingChatModel } from '../../support/fake-chat-model.js';
import {
  RECOVERY_SCOPE,
  RECOVERY_SESSION,
  RECOVERY_WORK_PACKAGE,
  createRecoveryHarness,
  type RecoveryHarness,
} from '../../support/recovery-harness.js';

const TARGET_SESSION = 'session-target-recovery' as CoordinatorSessionId;
const TARGET_INCARNATION = 'inc-target-recovery' as RuntimeIncarnationId;
const HANDOFF_INCARNATION = 'inc-handoff-acceptance' as RuntimeIncarnationId;
const HANDOFF_ID = 'handoff-acceptance-1';
const INTERACTION = 'interaction-acceptance-1' as InteractionId;
const ORCA_TASK = 'orca-task-recovery';
const SOURCE_DISPATCH = 'dispatch-source-1' as DispatchId;
const SOURCE_SEGMENT = 'segment-source-1' as SessionSegmentId;
const GRAPH_GENERATION = 1 as GraphGeneration;
const CLOCK_MS = 5_000;
const clock = (): number => CLOCK_MS;

let fixture: HandoffFixture | null = null;

afterEach(() => {
  fixture?.close();
  fixture = null;
});

type HandoffFixture = {
  readonly harness: RecoveryHarness;
  readonly counting: CountingChatModel;
  readonly runtime: StartedCoordinatorRuntime;
  readonly writer: CoordinationWriter;
  readonly snapshot: () => CoordinationSnapshot;
  readonly handoff: (handoffId?: string) => ExecutionHandoffRecord | null;
  readonly leaseHolder: () => CoordinatorSessionId | null;
  readonly openInteractions: (sessionId: CoordinatorSessionId) => readonly InteractionId[];
  readonly budgets: () => readonly unknown[];
  readonly close: () => void;
};

function scopeRevision(store: BranchCoordinationStore): number {
  const read = store.query({ kind: 'scope', coordinationScopeId: RECOVERY_SCOPE });
  if (read.kind !== 'scope' || read.scope === null) {
    throw new Error('Scope 不存在');
  }
  return read.scope.revision;
}

function snapshotOf(store: BranchCoordinationStore): CoordinationSnapshot {
  const read = store.query({ kind: 'snapshot', coordinationScopeId: RECOVERY_SCOPE });
  if (read.kind !== 'snapshot') {
    throw new Error('无法读取 snapshot');
  }
  return read.snapshot;
}

function openInteractionsOf(
  store: BranchCoordinationStore,
  sessionId: CoordinatorSessionId,
): readonly InteractionId[] {
  return snapshotOf(store)
    .pendingInteractions.filter(
      (interaction) => interaction.state === 'open' && interaction.ownerCoordinatorSessionId === sessionId,
    )
    .map((interaction) => interaction.interactionId);
}

function leaseHolderOf(store: BranchCoordinationStore): CoordinatorSessionId | null {
  const lease = snapshotOf(store).executionLease;
  return lease === null ? null : lease.coordinatorSessionId;
}

function wakeBatch(): WakeBatch {
  return {
    wakeBatchId: 'wake-handoff-1',
    coordinationScopeId: RECOVERY_SCOPE,
    coordinatorSessionId: RECOVERY_SESSION,
    sourceRevisions: [{ sourceKind: 'delivery', sourceId: 'delivery-handoff-1', revision: 1 }],
    actionableWork: [{ workKind: 'worker_result', workId: 'wake-handoff-1', summary: '新的 Worker 结果待结算' }],
  };
}

/**
 * 组装一个 Source 持有 Execution Coordination Lease 的 Scope，并以真实 Runtime 装配 Source。
 *
 * 全部业务身份证据（物化绑定、Session Segment、预算计数、Pending Interaction）都在切换 Runtime
 * Incarnation 之前落盘：Runtime 取得新 fencing generation 之后，旧 writer 即被 fence。
 */
async function createHandoffFixture(): Promise<HandoffFixture> {
  const harness = createRecoveryHarness();
  const store = harness.store;

  // Target Session 必须先注册：review 会读它的注册状态。
  const registered = store.transact({
    kind: 'register-session',
    coordinationScopeId: RECOVERY_SCOPE,
    expectedRevision: scopeRevision(store),
    writer: harness.writer,
    coordinatorSessionId: TARGET_SESSION,
    coordinatorModelConfigurationRef: 'model-config-target',
    lifecycleState: 'registered',
  });
  if (registered.kind !== 'committed') {
    throw new Error(`无法注册 Target Session: ${registered.message}`);
  }
  const targetLease = acquireRuntimeLease(store, {
    coordinationScopeId: RECOVERY_SCOPE,
    coordinatorSessionId: TARGET_SESSION,
    runtimeIncarnationId: TARGET_INCARNATION,
    fencingGeneration: 0,
  });
  if (targetLease.kind !== 'acquired') {
    throw new Error(`Target Session 无法取得 Runtime Lease: ${targetLease.kind}`);
  }

  harness.recordMaterializationBinding(RECOVERY_WORK_PACKAGE, ORCA_TASK);
  harness.recordSourceSegment({
    segmentId: SOURCE_SEGMENT,
    dispatchId: SOURCE_DISPATCH,
    attemptId: 'attempt-1',
    sessionBindingId: 'binding-source-1',
    role: 'implementation',
    lastTranscriptRef: 'transcript:source-1',
  });
  const budgeted = store.transact({
    kind: 'consume-budget',
    coordinationScopeId: RECOVERY_SCOPE,
    expectedRevision: scopeRevision(store),
    writer: harness.writer,
    budgetKey: 'coordinator_model_calls',
    approvedLimitRef: 'limit-1',
    amount: 2,
  });
  if (budgeted.kind !== 'committed') {
    throw new Error(`无法消费预算: ${budgeted.message}`);
  }
  const interaction = store.transact({
    kind: 'record-pending-interaction',
    coordinationScopeId: RECOVERY_SCOPE,
    expectedRevision: scopeRevision(store),
    writer: harness.writer,
    interactionId: INTERACTION,
    ownerCoordinatorSessionId: RECOVERY_SESSION,
    subjectRef: { kind: 'worker-question', id: 'question-1' },
  });
  if (interaction.kind !== 'committed') {
    throw new Error(`无法记录 Pending Interaction: ${interaction.message}`);
  }

  // 曾经取过 Runtime Lease 的 Session 必须能读回 checkpoint，否则启动会因「历史缺失」拒绝。
  const checkpoint = openCheckpointStore({ databasePath: checkpointDatabasePath(harness.directory), clock });
  if (checkpoint.kind !== 'opened') {
    throw new Error(`无法打开 checkpoint store: ${checkpoint.message}`);
  }
  const saved = checkpoint.store.saveCheckpoint({
    schemaVersion: COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
    coordinatorSessionId: RECOVERY_SESSION,
    committedMessages: [],
    graphPosition: 'suspend',
    committedModelSteps: [],
    wakeBatches: [],
    lastCompactionOutcome: null,
  });
  checkpoint.store.close();
  if (saved.kind !== 'saved') {
    throw new Error('无法写入启动前 checkpoint');
  }

  // 释放旧的 Source Runtime Lease，让同一个 Session 以新的 Incarnation 接管。
  harness.releaseRuntimeLease();

  const counting = new CountingChatModel();
  const started = await startCoordinatorRuntime({
    coordinationScopeId: RECOVERY_SCOPE,
    coordinatorSessionId: RECOVERY_SESSION,
    runtimeIncarnationId: HANDOFF_INCARNATION,
    configuration: {
      configurationRef: 'model-config-recovery',
      providerIntegration: '@langchain/openai#ChatOpenAI',
      model: 'MiniMax-M3',
      modelOptions: {},
      credentialRefs: [],
      nativeWindowOwnerRef: null,
    },
    resolveModel: () => Promise.resolve({ kind: 'resolved', model: counting }),
    gitCommonDir: harness.directory,
    coordinationStore: store,
    ttlMs: 30_000,
    clock,
    probeTimeoutMs: 2_000,
  });
  if (started.kind !== 'started') {
    throw new Error(`无法启动 Runtime: ${started.code} ${started.message}`);
  }

  return {
    harness,
    counting,
    runtime: started,
    writer: writerFor(started.incarnation),
    snapshot: () => snapshotOf(store),
    handoff: (handoffId = HANDOFF_ID) => {
      const read = store.query({ kind: 'execution-handoff', coordinationScopeId: RECOVERY_SCOPE, handoffId });
      return read.kind === 'execution-handoff' ? read.handoff : null;
    },
    leaseHolder: () => leaseHolderOf(store),
    openInteractions: (sessionId) => openInteractionsOf(store, sessionId),
    budgets: () => {
      const read = store.query({ kind: 'budget-counters', coordinationScopeId: RECOVERY_SCOPE });
      return read.kind === 'budget-counters' ? read.counters : [];
    },
    close: () => {
      started.close();
      harness.close();
    },
  };
}

function prepare(created: HandoffFixture, handoffId = HANDOFF_ID): ExecutionHandoffResult {
  return prepareExecutionHandoff({
    store: created.harness.store,
    coordinationScopeId: RECOVERY_SCOPE,
    writer: created.writer,
    handoffId,
    targetSessionId: TARGET_SESSION,
    graphGeneration: GRAPH_GENERATION,
    capsuleRef: 'capsule-handoff-1',
  });
}

function review(
  created: HandoffFixture,
  overrides: Partial<Parameters<typeof reviewExecutionHandoff>[0]['facts']> = {},
  handoffId = HANDOFF_ID,
): ExecutionHandoffResult {
  return reviewExecutionHandoff({
    store: created.harness.store,
    coordinationScopeId: RECOVERY_SCOPE,
    writer: created.writer,
    handoffId,
    facts: {
      scopeRevision: scopeRevision(created.harness.store),
      currentGraphGeneration: GRAPH_GENERATION,
      targetLifecycleState: 'registered',
      sourceCheckpoint: 'recoverable',
      capsulePortable: true,
      ...overrides,
    },
  });
}

function cutover(created: HandoffFixture, handoffId = HANDOFF_ID): ExecutionHandoffResult {
  return cutoverExecutionHandoff({
    store: created.harness.store,
    coordinationScopeId: RECOVERY_SCOPE,
    writer: created.writer,
    handoffId,
  });
}

/** 与责任转移无关的运行 / 图 / 授权 / 预算身份投影。 */
function identityOf(created: HandoffFixture): unknown {
  const snapshot = created.snapshot();
  return {
    mode: snapshot.scope.mode,
    planningCycleId: snapshot.scope.planningCycleId,
    graphId: snapshot.scope.graphId,
    graphVersion: snapshot.scope.graphVersion,
    authorizationId: snapshot.scope.authorizationId,
    authorizationVersion: snapshot.scope.authorizationVersion,
    materializationBindings: snapshot.materializationBindings,
    sessionSegments: snapshot.sessionSegments,
    ticketClaims: snapshot.ticketClaims,
    budgets: created.budgets(),
  };
}

test('普通挂起 / 唤醒与 prepare / review 都不转移执行责任，也不激活 Target', async () => {
  fixture = await createHandoffFixture();
  const created = fixture;

  const wake = admitWakeBatch(created.harness.store, {
    wakeBatch: wakeBatch(),
    incarnation: created.runtime.incarnation,
    checkpoints: created.runtime.checkpoints,
    clock,
  });
  expect(wake.kind).toBe('admitted');

  // 普通唤醒只准入工作，不构成交接触发：没有提案、Lease 仍在 Source。
  expect(created.handoff()).toBeNull();
  expect(created.leaseHolder()).toBe(RECOVERY_SESSION);
  expect(created.openInteractions(RECOVERY_SESSION)).toEqual([INTERACTION]);
  for (const implicit of ['suspend', 'resume', 'wake_admission', 'keepalive', 'reconciliation']) {
    expect(isExecutionHandoffTrigger(implicit)).toBe(false);
  }

  const prepared = prepare(created);
  expect(prepared.kind).toBe('prepared');
  const record = created.handoff();
  expect(record?.phase).toBe('prepared');
  expect(record?.sourceSessionId).toBe(RECOVERY_SESSION);
  expect(record?.targetSessionId).toBe(TARGET_SESSION);
  expect(record?.responsibilitySet).toEqual([...HANDOFF_RESPONSIBILITIES]);
  // 责任未转移：Lease 与开放交互都还归 Source，Target 只能读审阅信息。
  expect(created.leaseHolder()).toBe(RECOVERY_SESSION);
  expect(created.openInteractions(RECOVERY_SESSION)).toEqual([INTERACTION]);
  expect(
    executionHandoffActivation({
      handoff: record,
      executionLeaseHolderSessionId: RECOVERY_SESSION,
      coordinatorSessionId: TARGET_SESSION,
    }).kind,
  ).toBe('awaiting_user_prompt');
  expect(
    executionHandoffActivation({
      handoff: record,
      executionLeaseHolderSessionId: RECOVERY_SESSION,
      coordinatorSessionId: RECOVERY_SESSION,
    }).kind,
  ).toBe('source_active');

  const reviewed = review(created);
  expect(reviewed.kind).toBe('reviewed');
  expect(created.handoff()?.phase).toBe('reviewed');
  // 复核通过仍然没有转移：Target 依旧不能激活模型循环。
  expect(created.leaseHolder()).toBe(RECOVERY_SESSION);
  expect(created.openInteractions(RECOVERY_SESSION)).toEqual([INTERACTION]);
  expect(
    executionHandoffActivation({
      handoff: created.handoff(),
      executionLeaseHolderSessionId: RECOVERY_SESSION,
      coordinatorSessionId: TARGET_SESSION,
    }).kind,
  ).toBe('awaiting_user_prompt');

  // 整条路径没有产生任何 Orca 副作用：fake backend 一次都没被调用。
  expect(created.harness.backend.calls).toEqual([]);
});

test('cutover 以一次 CAS 原子转移责任，运行 / 图 / 授权 / 预算身份不变', async () => {
  fixture = await createHandoffFixture();
  const created = fixture;
  expect(prepare(created).kind).toBe('prepared');
  expect(review(created).kind).toBe('reviewed');
  const identityBefore = identityOf(created);

  const result = cutover(created);

  expect(result.kind).toBe('cutover');
  if (result.kind !== 'cutover') {
    return;
  }
  // 责任三项：Lease、相关 Pending Interaction、后续 Worker 事件责任（由 Lease 承载）。
  expect(result.transfer.executionLeaseHolderSessionId).toBe(TARGET_SESSION);
  expect(result.transfer.transferredInteractionIds).toEqual([INTERACTION]);
  expect(created.leaseHolder()).toBe(TARGET_SESSION);
  expect(created.openInteractions(RECOVERY_SESSION)).toEqual([]);
  expect(created.openInteractions(TARGET_SESSION)).toEqual([INTERACTION]);
  expect(created.handoff()?.phase).toBe('cutover');

  // 运行、图、授权与预算身份逐项不变。
  expect(identityOf(created)).toEqual(identityBefore);

  // Target 进入 awaiting_user_prompt：用户下一条普通 Prompt 之前不激活模型循环。
  expect(
    executionHandoffActivation({
      handoff: created.handoff(),
      executionLeaseHolderSessionId: TARGET_SESSION,
      coordinatorSessionId: TARGET_SESSION,
    }).kind,
  ).toBe('awaiting_user_prompt');
  expect(
    executionHandoffActivation({
      handoff: created.handoff(),
      executionLeaseHolderSessionId: TARGET_SESSION,
      coordinatorSessionId: TARGET_SESSION,
      awaitingUserPromptSatisfied: true,
    }).kind,
  ).toBe('target_active');
  expect(
    executionHandoffActivation({
      handoff: created.handoff(),
      executionLeaseHolderSessionId: TARGET_SESSION,
      coordinatorSessionId: RECOVERY_SESSION,
    }).kind,
  ).toBe('not_owner');
});

test('review 失败与 cutover CAS 失败都保持 Source 唯一 owner，且不激活 Target', async () => {
  fixture = await createHandoffFixture();
  const created = fixture;
  expect(prepare(created).kind).toBe('prepared');

  // 失败一：Coordinator Context Capsule 不可移植。
  const failedReview = review(created, { capsulePortable: false });
  expect(failedReview.kind).toBe('blocked');
  expect(created.handoff()?.phase).toBe('blocked');
  expect(created.leaseHolder()).toBe(RECOVERY_SESSION);
  expect(created.openInteractions(RECOVERY_SESSION)).toEqual([INTERACTION]);
  expect(
    executionHandoffActivation({
      handoff: created.handoff(),
      executionLeaseHolderSessionId: RECOVERY_SESSION,
      coordinatorSessionId: TARGET_SESSION,
    }).kind,
  ).toBe('awaiting_user_prompt');

  // 用户补充事实后重开提案（blocked → prepared 是允许的恢复路径）。
  const blockedRevision = created.handoff()?.handoffRevision ?? 0;
  const reopened = created.harness.store.transact({
    kind: 'advance-execution-handoff',
    coordinationScopeId: RECOVERY_SCOPE,
    expectedRevision: scopeRevision(created.harness.store),
    writer: created.writer,
    handoffId: HANDOFF_ID,
    phase: 'prepared',
    expectedHandoffRevision: blockedRevision,
  });
  expect(reopened.kind).toBe('committed');
  expect(review(created).kind).toBe('reviewed');

  // 失败二：review 与 cutover 之间出现其它写入 => cutover 的单次 CAS 失败。
  const unrelated = created.harness.store.transact({
    kind: 'consume-budget',
    coordinationScopeId: RECOVERY_SCOPE,
    expectedRevision: scopeRevision(created.harness.store),
    writer: created.writer,
    budgetKey: 'validator_repairs',
    approvedLimitRef: 'limit-1',
    amount: 1,
  });
  expect(unrelated.kind).toBe('committed');

  const failedCutover = cutover(created);
  expect(failedCutover.kind).toBe('blocked');
  if (failedCutover.kind === 'blocked') {
    expect(failedCutover.failure.code).toBe('stale_revision');
  }
  // Source 仍是唯一 owner，Target 未被激活，失败以 blocker 形式可观测。
  expect(created.handoff()?.phase).toBe('blocked');
  expect(created.handoff()?.blockingReason).toBeTruthy();
  expect(created.leaseHolder()).toBe(RECOVERY_SESSION);
  expect(created.openInteractions(RECOVERY_SESSION)).toEqual([INTERACTION]);
  expect(
    executionHandoffActivation({
      handoff: created.handoff(),
      executionLeaseHolderSessionId: RECOVERY_SESSION,
      coordinatorSessionId: TARGET_SESSION,
    }).kind,
  ).toBe('awaiting_user_prompt');
  expect(created.harness.backend.calls).toEqual([]);
});

test('零真实模型调用：交接与挂起 / 唤醒全程只使用注入的 fake chat model', async () => {
  fixture = await createHandoffFixture();
  const created = fixture;

  // 能力核验确实调用过这个模型：基线大于 0，说明计数器不是恒零的。
  const baseline = created.counting.generations;
  expect(baseline).toBeGreaterThan(0);

  admitWakeBatch(created.harness.store, {
    wakeBatch: wakeBatch(),
    incarnation: created.runtime.incarnation,
    checkpoints: created.runtime.checkpoints,
    clock,
  });
  expect(prepare(created).kind).toBe('prepared');
  expect(review(created).kind).toBe('reviewed');
  expect(cutover(created).kind).toBe('cutover');

  // 挂起 / 唤醒与整个交接路径没有新增任何模型生成调用。
  expect(created.counting.generations).toBe(baseline);

  // 对照：显式调用同一个 fake model 会让计数前进，证明上一条断言不是恒真。
  await created.counting.invoke([new HumanMessage('ping')]);
  expect(created.counting.generations).toBe(baseline + 1);
});
