/**
 * IP-12：启动衔接顺序的行为测试
 * （change: `m1-recover-execution`；Requirement「启动对账必须以原 OperationId 得出三值结论」、
 * 「mutation lane 阻塞必须可观测且可解除」、「启动重放必须复用既有 Delivery pipeline」与
 * 「Scope 控制动作必须正交且不隐式改变其他控制状态」的启动/退出路径）。
 *
 * 覆盖要点：
 * - 固定顺序：对账 → lane 投影 → Delivery 重放 → 续办 Recovery → 放行判定；对账与续办完成之前
 *   不派发、不恢复模型（用记录调用次序的 fake 观察者断言，并断言启动期间零 `worker-start`）；
 * - 未决 intent 以**原 OperationId** 对账，未决时对应 lane 阻塞且 blocker 可观测；
 * - 阻塞是 **lane 粒度**：另一条无未决 intent 的 lane 仍放行，只读查询不受影响；
 * - 未完成 Recovery 以**同一 RecoveryId** 续办，不新建 Recovery、不重复消耗额度；
 * - pipeline 返回 unknown 的 Delivery 保持未确认并阻塞对应 lane；
 * - Resume 先对账再恢复调度；Exit 不写任何控制状态；
 * - 放行判定复用 `scopeControlGate`：非 `active` 控制状态一律不放行。
 *
 * 装置复用 `tests/support/recovery-harness.ts`（临时目录 + 真实 store + fake backend + 重启模拟）
 * 与 `tests/support/fake-chat-model.ts`，不另起平行装置。
 */

import { afterEach, expect, test } from 'vitest';

import { openCheckpointStore } from '../../src/adapters/storage/checkpoint-store.js';
import { beginIntent, settleIntent } from '../../src/application/coordination/intent-service.js';
import type { RoleAuthorities } from '../../src/domain/planning/execution-authorization.js';
import type { SpecBinding } from '../../src/domain/task-contract.js';
import type {
  ClaimedResultAttribution,
  TrustedExecutionFacts,
} from '../../src/domain/worker-result-verification.js';
import type {
  DispatchId,
  OperationId,
  RecoveryId,
  RuntimeIncarnationId,
  SessionSegmentId,
} from '../../src/application/dto/identity.js';
import { laneKeyOf } from '../../src/application/dto/operation-intent.js';
import {
  acceptResultLaneKey,
  type SettleDeliveryInput,
} from '../../src/application/delivery/process-delivery.js';
import type {
  BranchCoordinationStore,
  CoordinationCommand,
  CoordinationWriter,
} from '../../src/application/ports/branch-coordination-store.js';
import {
  deriveRecoveryId,
  deriveReplacementOperationId,
  type ExactRecoveryAttemptRequest,
} from '../../src/application/recovery/worker-session-recovery-service.js';
import type { PendingDelivery } from '../../src/application/reconciliation/replay-deliveries.js';
import { checkpointDatabasePath } from '../../src/bootstrap/coordinator-runtime.js';
import {
  evaluateStartupReadiness,
  startCompanionStartup,
  STARTUP_STEPS,
  type CompanionStartupRequest,
  type CompanionStartupResult,
  type StartedCompanionStartup,
  type StartupRecoveryFacts,
  type StartupStep,
} from '../../src/bootstrap/startup.js';
import { COORDINATOR_SESSION_STATE_SCHEMA_VERSION } from '../../src/domain/coordinator/session-state.js';
import type { ControlState } from '../../src/domain/coordination/mode.js';
import type { MutationLaneRecord } from '../../src/domain/coordination/mutation-lane.js';
import type { ActiveWorkerListResult, WorkerStopPort } from '../../src/application/coordination/scope-control-service.js';
import {
  createRecoveryHarness,
  readReplacementReceipt,
  RECOVERY_AUTHORIZATION,
  RECOVERY_SCOPE,
  RECOVERY_SESSION,
  RECOVERY_WORKER_TASK,
  RECOVERY_WORK_PACKAGE,
  type RecoveryHarness,
} from '../support/recovery-harness.js';
import { CapableChatModel } from '../support/fake-chat-model.js';

const CLOCK_MS = 5_000;
const clock = (): number => CLOCK_MS;
const STARTUP_INCARNATION = 'inc-startup' as RuntimeIncarnationId;

const AUTHORITY: RoleAuthorities = {
  planner: true,
  implementation: true,
  validator: true,
  finalizer: true,
  gitIntegration: false,
  dependencyChanges: false,
};

const SPEC: SpecBinding = {
  provider: 'openspec',
  relativePath: 'openspec/changes/c/specs/spec.md',
  contentDigest: 'digest-1',
  providerVersion: '0.4.0',
  contractRevision: 1,
  trackingRevision: 1,
};

let harness: RecoveryHarness | null = null;

afterEach(() => {
  harness?.close();
  harness = null;
});

/* -------------------------------------------------------------------------- */
/* 观察与投影装置                                                              */
/* -------------------------------------------------------------------------- */

type ObservingStore = {
  readonly store: BranchCoordinationStore;
  readonly commands: CoordinationCommand[];
};

/** 记录经过 store 的每条命令：用于断言 Exit 零控制状态写入。 */
function observingStore(inner: BranchCoordinationStore): ObservingStore {
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

function fakeWorkers(): WorkerStopPort {
  const list: ActiveWorkerListResult = { kind: 'listed', dispatchIds: [] };
  return {
    listActiveDispatches: () => Promise.resolve(list),
    requestStop: () => Promise.resolve('stopped'),
  };
}

function expectStarted(result: CompanionStartupResult): StartedCompanionStartup {
  if (result.kind !== 'started') {
    throw new Error(`期望启动成功，实际停在步骤 ${result.step}: ${result.code} ${result.message}`);
  }
  return result;
}

function scopeRevision(store: BranchCoordinationStore): number {
  const read = store.query({ kind: 'scope', coordinationScopeId: RECOVERY_SCOPE });
  if (read.kind !== 'scope' || read.scope === null) {
    throw new Error('Scope 不存在');
  }
  return read.scope.revision;
}

function controlStateOf(store: BranchCoordinationStore): ControlState {
  const read = store.query({ kind: 'scope', coordinationScopeId: RECOVERY_SCOPE });
  if (read.kind !== 'scope' || read.scope === null) {
    throw new Error('Scope 不存在');
  }
  return read.scope.controlState;
}

function intentStateOf(
  store: BranchCoordinationStore,
  operationId: OperationId,
): { readonly state: string; readonly blockingReason: string | null } | null {
  const read = store.query({ kind: 'intent', coordinationScopeId: RECOVERY_SCOPE, operationId });
  if (read.kind !== 'intent' || read.intent === null) {
    return null;
  }
  return { state: read.intent.state, blockingReason: read.intent.blockingReason };
}

function intentCount(store: BranchCoordinationStore): number {
  const read = store.query({ kind: 'intents', coordinationScopeId: RECOVERY_SCOPE });
  return read.kind === 'intents' ? read.intents.length : -1;
}

/* -------------------------------------------------------------------------- */
/* Delivery 事实                                                               */
/* -------------------------------------------------------------------------- */

function trustedFacts(): TrustedExecutionFacts {
  return {
    runId: 'run-recovery',
    consumerGeneration: 1,
    graphGeneration: 1,
    authorizationId: RECOVERY_AUTHORIZATION,
    workerTaskId: RECOVERY_WORKER_TASK,
    dispatchId: 'dispatch-delivery-1' as DispatchId,
    attemptId: 'attempt-1',
    role: 'validator',
    specBinding: SPEC,
    worktreeId: 'worktree-recovery-1',
    authority: AUTHORITY,
    scopeEnvelope: { include: ['src'], exclude: [] },
    changedPaths: ['src/a.ts'],
  };
}

function claimedFacts(): ClaimedResultAttribution {
  return {
    runId: 'run-recovery',
    consumerGeneration: 1,
    graphGeneration: 1,
    authorizationId: RECOVERY_AUTHORIZATION,
    workerTaskId: RECOVERY_WORKER_TASK,
    dispatchId: 'dispatch-delivery-1' as DispatchId,
    attemptId: 'attempt-1',
    role: 'validator',
    specBinding: SPEC,
    worktreeId: 'worktree-recovery-1',
  };
}

function pendingDelivery(orcaTaskId: string, deliveryId: string): PendingDelivery {
  return {
    delivery: { deliveryId, claimed: claimedFacts(), acceptedResult: { summary: '实现完成' } },
    trusted: trustedFacts(),
    orcaTaskId,
    operationIds: {
      acceptResult: `${deliveryId}-accept-candidate` as OperationId,
      ack: `${deliveryId}-ack-candidate` as OperationId,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Fixture                                                                     */
/* -------------------------------------------------------------------------- */

type Fixture = {
  readonly harness: RecoveryHarness;
  readonly observed: ObservingStore;
  readonly request: CompanionStartupRequest;
  readonly steps: StartupStep[];
  readonly settleCalls: SettleDeliveryInput[];
  readonly resumeExactCalls: ExactRecoveryAttemptRequest[];
  readonly laneAOperation: OperationId;
  readonly laneAKey: string;
  readonly laneBOperation: OperationId;
  readonly laneBKey: string;
  readonly cleanLaneKey: string;
  readonly recoveryId: RecoveryId;
  readonly sourceSegmentId: SessionSegmentId;
  readonly deliveryId: string;
};

/** 在 store 上预置一条「已发出 mutation、结果未知」的 intent（保持 pending 且带 backend request）。 */
function beginUnresolvedIntent(input: {
  readonly store: BranchCoordinationStore;
  readonly writer: CoordinationWriter;
  readonly operationId: OperationId;
  readonly targetId: string;
  readonly backendRequestId: string;
}): void {
  const target = { kind: 'task', id: input.targetId };
  const begun = beginIntent(input.store, {
    coordinationScopeId: RECOVERY_SCOPE,
    operationId: input.operationId,
    target,
    operationCategory: 'task',
    writer: input.writer,
    expectedRevision: scopeRevision(input.store),
  });
  if (begun.kind !== 'registered') {
    throw new Error(`无法登记未决 intent ${input.operationId}: ${begun.kind}`);
  }
  const retained = settleIntent(input.store, {
    coordinationScopeId: RECOVERY_SCOPE,
    operationId: input.operationId,
    writer: input.writer,
    expectedRevision: scopeRevision(input.store),
    outcome: {
      kind: 'unknown',
      operation: { operationId: input.operationId, backendRequestId: input.backendRequestId, target },
      reason: 'response_lost',
    },
  });
  if (retained.kind !== 'retained') {
    throw new Error(`未决 intent ${input.operationId} 未能保持 pending: ${retained.kind}`);
  }
}

function createFixture(
  options: { readonly releaseRuntimeLease?: boolean; readonly orphanRecovery?: boolean } = {},
): Fixture {
  const created = createRecoveryHarness({ role: 'validator' });
  harness = created;
  const fixture = created;
  const observed = observingStore(fixture.store);

  const laneAOperation = 'op-lane-a-original' as OperationId;
  beginUnresolvedIntent({
    store: fixture.store,
    writer: fixture.writer,
    operationId: laneAOperation,
    targetId: 'orca-task-a',
    backendRequestId: 'request-lane-a',
  });
  const laneBOperation = 'op-lane-b-original' as OperationId;
  beginUnresolvedIntent({
    store: fixture.store,
    writer: fixture.writer,
    operationId: laneBOperation,
    targetId: 'orca-task-b',
    backendRequestId: 'request-lane-b',
  });

  // orphanRecovery 模拟「Recovery 记录存在、但它引用的中断 Segment 已不可读」：
  // `recoverWorkerSession` 会以 `segment_not_found` 拒绝，而记录本身仍保持非终结。
  const orphanRecovery = options.orphanRecovery ?? false;
  const sourceSegmentId = (orphanRecovery ? 'segment-orphan-1' : 'segment-source-1') as SessionSegmentId;
  const sourceDispatchId = (orphanRecovery ? 'dispatch-orphan-1' : 'dispatch-source-1') as DispatchId;
  if (!orphanRecovery) {
    fixture.recordSourceSegment({
      segmentId: sourceSegmentId,
      dispatchId: sourceDispatchId,
      attemptId: 'attempt-1',
      sessionBindingId: 'binding-source-1',
      role: 'validator',
      lastTranscriptRef: 'transcript:source-1',
    });
  }
  const recoveryId = deriveRecoveryId(RECOVERY_SCOPE, sourceSegmentId);
  const recorded = fixture.store.transact({
    kind: 'record-recovery',
    coordinationScopeId: RECOVERY_SCOPE,
    expectedRevision: scopeRevision(fixture.store),
    writer: fixture.writer,
    recoveryId,
    role: 'validator',
    workPackageId: RECOVERY_WORK_PACKAGE,
    workerTaskId: RECOVERY_WORKER_TASK,
    businessAttemptId: 'attempt-1',
    sourceSegmentId,
    sourceDispatchId,
  });
  if (recorded.kind === 'rejected') {
    throw new Error(`无法登记 Recovery: ${recorded.message}`);
  }

  // 曾经取过 Runtime Lease 的 Session 必须能读回 checkpoint，否则启动会因「历史缺失」拒绝。
  const checkpoint = openCheckpointStore({
    databasePath: checkpointDatabasePath(fixture.directory),
    clock,
  });
  if (checkpoint.kind !== 'opened') {
    throw new Error(checkpoint.message);
  }
  const saved = checkpoint.store.saveCheckpoint({
    schemaVersion: COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
    coordinatorSessionId: RECOVERY_SESSION,
    committedMessages: [],
    graphPosition: 'suspend',
    committedModelSteps: [],
    wakeBatches: [],
  });
  checkpoint.store.close();
  if (saved.kind !== 'saved') {
    throw new Error('无法写入启动前 checkpoint');
  }

  // 释放上一个 Incarnation 的 Runtime Lease：启动会取得新的 generation，走真实恢复路径。
  if (options.releaseRuntimeLease ?? true) {
    fixture.releaseRuntimeLease();
  }

  const steps: StartupStep[] = [];
  const settleCalls: SettleDeliveryInput[] = [];
  const resumeExactCalls: ExactRecoveryAttemptRequest[] = [];
  const deliveryId = 'delivery-b';

  const recoveryFacts: StartupRecoveryFacts = {
    observationFor: () => ({
      sessionBindingId: 'binding-source-1',
      providerSessionId: 'provider-session-1',
      identityChanged: false,
    }),
    // 宿主明确报告 worker 仍在运行：先尝试精确恢复，不进入替代路径。
    livenessFor: (recovery) => ({
      dispatchId: recovery.sourceDispatchId,
      workerRunning: true,
      terminalHandle: 'terminal-1',
      host: { kind: 'not-enumerated' },
    }),
    resumeExact: (request) => {
      resumeExactCalls.push(request);
      return Promise.resolve({ kind: 'resumed', sessionBindingId: request.sessionBindingId });
    },
    workspaceFor: () => ({ kind: 'reconciled', worktreeId: 'worktree-recovery-1', head: 'head-recovery' }),
    sourceTerminalFor: () => ({ kind: 'not_reached' }),
    roleGateFor: () => ({
      role: 'validator',
      validator: { identifiedGaps: [], invalidatedEvidenceIds: [], reverifiedEvidenceIds: [] },
    }),
    extractCapsule: () => Promise.resolve({ kind: 'transcript_unavailable', reason: '测试不生成 Capsule' }),
    execution: {
      backendIdentityRef: 'backend-identity-recovery',
      graphGeneration: 1,
      authorizationId: RECOVERY_AUTHORIZATION,
      runId: 'run-recovery',
      consumerGeneration: 1,
      timeoutMs: 60_000,
    },
    replacementFor: () => ({
      profile: { kind: 'reuse', profileRef: 'profile-validator' },
      workerLaunch: { kind: 'orca_managed', agent: 'codex' },
      interpretReceipt: readReplacementReceipt,
    }),
  };

  const request: CompanionStartupRequest = {
    runtime: {
      coordinationScopeId: RECOVERY_SCOPE,
      coordinatorSessionId: RECOVERY_SESSION,
      runtimeIncarnationId: STARTUP_INCARNATION,
      configuration: {
        configurationRef: 'model-config-recovery',
        providerIntegration: '@langchain/openai#ChatOpenAI',
        model: 'MiniMax-M3',
        modelOptions: {},
        credentialRefs: [],
        nativeWindowOwnerRef: null,
      },
      resolveModel: () => Promise.resolve({ kind: 'resolved', model: new CapableChatModel() }),
      gitCommonDir: fixture.directory,
      coordinationStore: observed.store,
      ttlMs: 30_000,
      clock,
      probeTimeoutMs: 2_000,
    },
    backend: fixture.backend.backend,
    clock,
    deliveries: {
      backendIdentityRef: 'backend-identity-recovery',
      graphGeneration: 1,
      authorizationId: RECOVERY_AUTHORIZATION,
      runId: 'run-recovery',
      consumerGeneration: 1,
      timeoutMs: 60_000,
      readPending: () => Promise.resolve({ kind: 'read', pending: [pendingDelivery('orca-task-b', deliveryId)] }),
      settle: (input) => {
        settleCalls.push(input);
        return Promise.resolve({ kind: 'unknown', operationId: laneBOperation, reason: 'response_lost' });
      },
    },
    recovery: recoveryFacts,
    workers: fakeWorkers(),
    observer: { onStep: (step) => steps.push(step) },
  };

  return {
    harness: fixture,
    observed,
    request,
    steps,
    settleCalls,
    resumeExactCalls,
    laneAOperation,
    laneAKey: acceptResultLaneKey('orca-task-a'),
    laneBOperation,
    laneBKey: acceptResultLaneKey('orca-task-b'),
    cleanLaneKey: laneKeyOf({ kind: 'task', id: 'orca-task-clean' }, 'task'),
    recoveryId,
    sourceSegmentId,
    deliveryId,
  };
}

/* -------------------------------------------------------------------------- */
/* 测试                                                                        */
/* -------------------------------------------------------------------------- */

test('固定顺序装配启动：对账与续办完成之前不派发，未决 lane 以原 OperationId 可观测', async () => {
  const fixture = createFixture();
  const result = expectStarted(await startCompanionStartup(fixture.request));

  // 顺序是合同：七个步骤严格按序到达，放行判定只可能在全部前置步骤之后产生。
  expect(fixture.steps).toEqual([...STARTUP_STEPS]);
  expect(fixture.steps.at(-1)).toBe('readiness_evaluated');

  // 对账以原 OperationId 发出只读查询，绝不换 ID。
  const requestShows = fixture.harness.backend.calls
    .filter((call) => call.kind === 'query')
    .map((call) => call.operation)
    .filter((operation) => operation.operation === 'request-show')
    .map((operation) => operation.requestId);
  expect(requestShows).toEqual(expect.arrayContaining(['request-lane-a', 'request-lane-b']));
  expect(intentStateOf(fixture.harness.store, fixture.laneAOperation)).toMatchObject({ state: 'blocked' });
  expect(intentStateOf(fixture.harness.store, fixture.laneBOperation)).toMatchObject({ state: 'blocked' });
  // 未决结论不换 OperationId：intent 数量不变，ID 原样保留。
  expect(intentCount(fixture.harness.store)).toBe(2);

  // lane 阻塞可观测，且是 lane 粒度：另一条无未决 intent 的 lane 仍放行。
  expect(result.lanes.map((lane) => lane.laneKey).sort()).toEqual([fixture.laneAKey, fixture.laneBKey].sort());
  expect(result.lanes.every((lane) => lane.reason.length > 0)).toBe(true);
  expect(result.readiness.mayUseLane(fixture.laneAKey)).toBe(false);
  expect(result.readiness.mayUseLane(fixture.laneBKey)).toBe(false);
  expect(result.readiness.mayUseLane(fixture.cleanLaneKey)).toBe(true);
  // 存在阻塞 lane 不影响模型恢复：它只看控制状态与启动序列是否已完成。
  expect(result.readiness.startupSequenceCompleted).toBe(true);
  expect(result.readiness.mayResumeModel).toBe(true);
  expect(result.readiness.blockedLaneKeys).toEqual(expect.arrayContaining([fixture.laneAKey, fixture.laneBKey]));
  // blocker 是结构化、可观测的事实，不是日志。
  expect(result.blockers.map((blocker) => blocker.laneKey)).toEqual(
    expect.arrayContaining([fixture.laneAKey, fixture.laneBKey]),
  );

  // 只读查询不受 lane 阻塞影响。
  const readOnly = fixture.harness.store.query({ kind: 'intent', coordinationScopeId: RECOVERY_SCOPE, operationId: fixture.laneAOperation });
  expect(readOnly.kind === 'intent' ? readOnly.intent?.operationId : null).toBe(fixture.laneAOperation);

  // Delivery 重放：只走前驱唯一 pipeline，unknown 时保持未确认且 lane 仍阻塞。
  expect(fixture.settleCalls).toHaveLength(1);
  expect(fixture.settleCalls[0]?.delivery.deliveryId).toBe(fixture.deliveryId);
  expect(result.deliveries.unconfirmed).toContain(fixture.deliveryId);
  expect(result.deliveries.blockedLaneKeys).toContain(fixture.laneBKey);

  // 未完成的 Recovery 以同一 RecoveryId 续办：不新建记录、不重复消耗额度。
  expect(result.recoveries.map((entry) => entry.recoveryId)).toEqual([fixture.recoveryId]);
  expect(result.recoveries[0]?.previousStatus).toBe('pending');
  expect(result.recoveries[0]?.result.kind).toBe('exact_recovery');
  expect(fixture.resumeExactCalls).toHaveLength(1);
  const recoveries = fixture.harness.recoveries();
  expect(recoveries).toHaveLength(1);
  expect(recoveries[0]?.recoveryId).toBe(fixture.recoveryId);
  expect(recoveries[0]?.consumedBudget).toBe(0);

  // 对账与续办完成之前不派发：启动全程零 worker-start。
  expect(fixture.harness.backend.mutations().filter((mutation) => mutation.operation === 'worker-start')).toEqual([]);

  result.close();
});

test('未完成的 Recovery 以同一 RecoveryId 续办，不重复派发也不重复消耗额度', async () => {
  const fixture = createFixture({ releaseRuntimeLease: false });

  // 预置一次已经消费过额度的中断：recovering + 已预写 intent + consumedBudget 1。
  const replacementOperationId = deriveReplacementOperationId(fixture.recoveryId);
  const begun = beginIntent(fixture.harness.store, {
    coordinationScopeId: RECOVERY_SCOPE,
    operationId: replacementOperationId,
    target: { kind: 'worker-task', id: RECOVERY_WORKER_TASK },
    operationCategory: 'worker-dispatch',
    writer: fixture.harness.writer,
    expectedRevision: scopeRevision(fixture.harness.store),
  });
  expect(begun.kind).toBe('registered');
  const advanced = fixture.harness.store.transact({
    kind: 'advance-recovery',
    coordinationScopeId: RECOVERY_SCOPE,
    expectedRevision: scopeRevision(fixture.harness.store),
    writer: fixture.harness.writer,
    recoveryId: fixture.recoveryId,
    status: 'recovering',
    prewriteOperationId: replacementOperationId,
    consumedBudget: 1,
  });
  expect(advanced.kind).toBe('committed');
  fixture.harness.releaseRuntimeLease();

  // 原会话已退出：本次续办只能走替代路径，而额度已经用尽，因此只能阻塞。
  const result = expectStarted(
    await startCompanionStartup({
      ...fixture.request,
      recovery: {
        ...fixture.request.recovery,
        livenessFor: (recovery) => ({
          dispatchId: recovery.sourceDispatchId,
          workerRunning: false,
          terminalHandle: 'terminal-1',
          host: { kind: 'enumerated', terminalHandles: [] },
        }),
      },
    }),
  );

  // 续办命中的还是同一条 Recovery；额度不因重启或续办被重置。
  expect(result.recoveries.map((entry) => entry.recoveryId)).toEqual([fixture.recoveryId]);
  expect(result.recoveries[0]?.previousStatus).toBe('recovering');
  expect(result.recoveries[0]?.result.kind).toBe('blocked');
  const recoveries = fixture.harness.recoveries();
  expect(recoveries).toHaveLength(1);
  expect(recoveries[0]?.recoveryId).toBe(fixture.recoveryId);
  expect(recoveries[0]?.consumedBudget).toBe(1);
  // 预写的替代派发意图未被换 ID，也没有产生第二次替代派发。
  const replacementIntents = fixture.harness.store.query({ kind: 'intent', coordinationScopeId: RECOVERY_SCOPE, operationId: replacementOperationId });
  expect(replacementIntents.kind === 'intent' ? replacementIntents.intent?.operationId : null).toBe(replacementOperationId);
  expect(fixture.harness.backend.mutations().filter((mutation) => mutation.operation === 'worker-start')).toEqual([]);
  // 未终结的 Recovery 暴露给调用方，作为「不得重复派发」的事实。
  expect(result.unfinishedRecoveryIds).toContain(fixture.recoveryId);
  expect(result.dispatchHoldingRecoveryIds).toContain(fixture.recoveryId);
  // 它只停掉自己的替代派发 lane，不影响其它 lane，也不阻止模型恢复。
  const recoveryLaneKey = laneKeyOf({ kind: 'worker-task', id: RECOVERY_WORKER_TASK }, 'worker-dispatch');
  expect(result.readiness.mayUseLane(recoveryLaneKey)).toBe(false);
  expect(result.readiness.mayUseLane(fixture.cleanLaneKey)).toBe(true);
  expect(result.readiness.mayResumeModel).toBe(true);
  expect(result.blockers.some((blocker) => blocker.recoveryId === fixture.recoveryId)).toBe(true);

  result.close();
});

test('lane 粒度：一条 lane 阻塞不阻止其它 lane 的派发，也不阻止模型恢复', () => {
  const blockedLane: MutationLaneRecord = {
    laneKey: 'blocked-lane',
    operationId: 'op-blocked-lane' as OperationId,
    cause: 'blocked',
    reason: '对账未决',
  };
  const readiness = evaluateStartupReadiness({
    controlState: 'active',
    lanes: [blockedLane],
    startupSequenceCompleted: true,
  });
  // spec 的 MUST NOT：阻塞是 lane 粒度，不是全局锁。
  expect(readiness.mayUseLane('blocked-lane')).toBe(false);
  expect(readiness.mayUseLane('clean-lane')).toBe(true);
  expect(readiness.mayResumeModel).toBe(true);
  expect(readiness.blockedLaneKeys).toEqual(['blocked-lane']);

  // 附加 lane 阻塞（例如某条 Recovery 未能续办）同样只影响它自己的 lane。
  const withRecoveryHold = evaluateStartupReadiness({
    controlState: 'active',
    lanes: [],
    startupSequenceCompleted: true,
    additionalBlockedLaneKeys: ['recovery-lane'],
  });
  expect(withRecoveryHold.mayUseLane('recovery-lane')).toBe(false);
  expect(withRecoveryHold.mayUseLane('clean-lane')).toBe(true);
  expect(withRecoveryHold.mayResumeModel).toBe(true);
});

test('单条 Recovery 续办失败只阻塞自己的 lane，不拒绝整次启动', async () => {
  const fixture = createFixture({ orphanRecovery: true });
  const result = expectStarted(await startCompanionStartup(fixture.request));

  // 失败是显式结果，不是整次启动失败，也不是静默跳过。
  const continuation = result.recoveries.find((entry) => entry.recoveryId === fixture.recoveryId);
  expect(continuation?.result.kind).toBe('rejected');
  const blocker = result.blockers.find((entry) => entry.recoveryId === fixture.recoveryId);
  const recoveryLaneKey = laneKeyOf({ kind: 'worker-task', id: RECOVERY_WORKER_TASK }, 'worker-dispatch');
  expect(blocker).toMatchObject({ source: 'recovery', laneKey: recoveryLaneKey });
  expect(blocker?.message).toBeTruthy();

  // 对应 lane 被拦住，干净 lane 仍放行，模型恢复不被单条 Recovery 失败阻止。
  expect(result.readiness.mayUseLane(recoveryLaneKey)).toBe(false);
  expect(result.readiness.mayUseLane(fixture.cleanLaneKey)).toBe(true);
  expect(result.readiness.mayResumeModel).toBe(true);
  // 该 Recovery 保持非终结：启动没有替它写终态。
  expect(result.unfinishedRecoveryIds).toContain(fixture.recoveryId);
  expect(fixture.harness.recoveries()[0]?.status).toBe('pending');

  result.close();
});

test('步骤 1 运行时启动失败仍然整次拒绝（回归保护）', async () => {
  const fixture = createFixture();
  const result = await startCompanionStartup({
    ...fixture.request,
    runtime: {
      ...fixture.request.runtime,
      resolveModel: () => Promise.resolve({ kind: 'failed', message: 'provider 集成不可用' }),
    },
  });

  expect(result.kind).toBe('rejected');
  if (result.kind === 'rejected') {
    expect(result.step).toBe('runtime_started');
    expect(result.code).toBe('model_resolution_failed');
  }
  // 未决 intent 没有被对账改动，也没有任何恢复期派发。
  expect(intentStateOf(fixture.harness.store, fixture.laneAOperation)?.state).toBe('pending');
  expect(fixture.harness.backend.mutations()).toEqual([]);
});

test('Resume 先对账再恢复调度；Exit 不写任何控制状态', async () => {
  const fixture = createFixture();
  const result = expectStarted(await startCompanionStartup(fixture.request));

  const paused = result.scopeControl.pause({ coordinationScopeId: RECOVERY_SCOPE, writer: result.writer });
  expect(paused.kind).toBe('applied');
  expect(controlStateOf(fixture.harness.store)).toBe('paused');

  const queriesBefore = fixture.harness.backend.calls.filter(
    (call) => call.kind === 'query' && call.operation.operation === 'request-show',
  ).length;
  const resumed = await result.scopeControl.resume({ coordinationScopeId: RECOVERY_SCOPE, writer: result.writer });
  const queriesAfter = fixture.harness.backend.calls.filter(
    (call) => call.kind === 'query' && call.operation.operation === 'request-show',
  ).length;

  // Resume 的结论里带着对账摘要：恢复调度之前确实重新对账了未决副作用。
  expect(resumed.kind).toBe('applied');
  if (resumed.kind === 'applied') {
    expect(resumed.reconciliation).not.toBeNull();
    expect(resumed.controlState).toBe('active');
  }
  expect(queriesAfter).toBeGreaterThan(queriesBefore);
  expect(controlStateOf(fixture.harness.store)).toBe('active');

  // Exit 只结束进程：store 写入命令流里没有任何控制状态写入。
  const before = fixture.observed.commands.length;
  const exited = result.endProcess();
  expect(exited.kind).toBe('exited');
  expect(exited.controlStateWritten).toBeNull();
  expect(exited.verdict.endsProcess).toBe(true);
  expect(fixture.observed.commands.slice(before)).toEqual([]);
  expect(controlStateOf(fixture.harness.store)).toBe('active');
});

test('放行判定复用 scopeControlGate：非 active 控制状态一律不放行', () => {
  const nonActive: readonly ControlState[] = [
    'paused',
    'cancelling',
    'blocked',
    'unverifiable',
    'replanning_transition',
  ];
  for (const controlState of nonActive) {
    const readiness = evaluateStartupReadiness({
      controlState,
      lanes: [],
      startupSequenceCompleted: true,
    });
    expect(readiness.controlGate.mayDispatch).toBe(false);
    expect(readiness.controlGate.mayResumeModel).toBe(false);
    expect(readiness.mayResumeModel).toBe(false);
    expect(readiness.mayUseLane(laneKeyOf({ kind: 'task', id: 'x' }, 'task'))).toBe(false);
  }

  // 启动序列未完成同样是全局顺序门：派发与模型恢复都不放行。
  const pendingSequence = evaluateStartupReadiness({
    controlState: 'active',
    lanes: [],
    startupSequenceCompleted: false,
  });
  expect(pendingSequence.mayUseLane('any-lane')).toBe(false);
  expect(pendingSequence.mayResumeModel).toBe(false);

  const ready = evaluateStartupReadiness({
    controlState: 'active',
    lanes: [],
    startupSequenceCompleted: true,
  });
  expect(ready.mayUseLane('any-lane')).toBe(true);
  expect(ready.mayResumeModel).toBe(true);
  expect(ready.controlGate.mayDispatch).toBe(true);
});

test('未确认 Delivery 读取失败时启动显式停在该步骤，不静默跳过重放', async () => {
  const fixture = createFixture();
  const result = await startCompanionStartup({
    ...fixture.request,
    deliveries: {
      ...fixture.request.deliveries,
      readPending: () => Promise.resolve({ kind: 'rejected', code: 'unavailable', message: 'Orca 不可达' }),
    },
  });

  expect(result.kind).toBe('rejected');
  if (result.kind === 'rejected') {
    expect(result.step).toBe('deliveries_replayed');
    expect(result.code).toBe('unavailable');
  }
  // 对账已经发生并留下可观测结论，但没有任何恢复期派发。
  expect(intentStateOf(fixture.harness.store, fixture.laneAOperation)?.state).toBe('blocked');
  expect(fixture.harness.backend.mutations().filter((mutation) => mutation.operation === 'worker-start')).toEqual([]);
});
