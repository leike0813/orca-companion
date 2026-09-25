/**
 * IP-04 的行为测试（change: `m2-wire-execution-runtime`）。
 *
 * 覆盖三件事，全部走生产路径（真实 store、真实用例、fake Orca/transport）：
 *
 * - **当前 Run 的 Delivery 装配**：`readPendingDeliveries` 从 Delivery message 的载荷解析出**声称的**
 *   归属，把所有可信事实从 store 的物化绑定、当前图、授权与 Git 读出的 worktree 事实装配成
 *   `PendingDelivery`，再交给前驱唯一 pipeline `replayDeliveries`；
 * - **a 顺序**：本地落盘失败时**不**确认（未落盘不 ack），旧代际 Delivery 只确认、只补历史；
 * - **Validator 同 Session 修复复验**：`createValidatorStepRunner` 把验证链固定在同一条真实 session
 *   上，任何一步换了 session 或绑定不可读都按 `session_lost` 返回；
 * - **Recovery 事实不可读**：生产装配（`createExecutionRecoveryFacts`）缺事实时给出结构化 blocker，
 *   精确 transcript 缺失时保持未决并阻塞替代派发 lane，绝不伪称已续接、也不派发 Worker。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, expect, test } from 'vitest';

import { sessionBindingIdOf } from '../../src/adapters/agents/session-binding.js';
import { createValidatorStepRunner } from '../../src/adapters/agents/validator-runner.js';
import { openCoordinationStore, type CoordinationStore } from '../../src/adapters/storage/coordination-store.js';
import { workPackageComment } from '../../src/application/materialize-work-package.js';
import {
  acceptResultLaneKey,
  ackLaneKey,
  ackConsumedDelivery,
} from '../../src/application/delivery/process-delivery.js';
import { acquireRuntimeLease } from '../../src/application/coordination/lease-service.js';
import { proposeManifest, recordApproval } from '../../src/application/planning/authorization-service.js';
import { recordInitialGraph } from '../../src/application/planning/graph-history.js';
import { initializeCoordinationScope } from '../../src/application/planning/initialize-scope.js';
import {
  deriveRecoveryId,
  recoverySubjectOf,
  type RecoveryFactSubject,
} from '../../src/application/recovery/worker-session-recovery-service.js';
import {
  replayDeliveries,
  type PendingDelivery,
} from '../../src/application/reconciliation/replay-deliveries.js';
import { runValidation, type ValidatorStepRequest, type ValidatorStepResult } from '../../src/application/run-validation.js';
import { decideLiveness, type TerminalLivenessFacts } from '../../src/domain/worker-liveness.js';
import {
  verifyExactSessionBinding,
  type RecoveryBindingObservation,
} from '../../src/domain/recovery/worker-session-recovery.js';
import {
  createExecutionRecoveryFacts,
  readPendingDeliveries,
  type PendingDeliveryReadInput,
} from '../../src/bootstrap/execution-runtime.js';
import { isNonTerminalRecoveryStatus, type PendingDeliveryRead } from '../../src/bootstrap/startup.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  DispatchId,
  GraphGeneration,
  GraphId,
  OperationId,
  PlanningCycleId,
  RuntimeIncarnationId,
  SessionSegmentId,
  ValidationAttemptId,
  WorkerTaskId,
  WorkPackageId,
} from '../../src/application/dto/identity.js';
import type { DeliveryMessage, ExecutionQueryResult } from '../../src/application/dto/operation-outcome.js';
import type {
  BranchCoordinationStore,
  CoordinationCommand,
  CoordinationCommandResult,
  CoordinationWriter,
  SessionSegmentRecord,
} from '../../src/application/ports/branch-coordination-store.js';
import type {
  ExecutionBackend,
  ExecutionMutation,
  ExecutionQuery,
} from '../../src/application/ports/execution-backend.js';
import type { RoleAuthorities } from '../../src/domain/planning/execution-authorization.js';
import type { ExecutionGraph, ScopeEnvelope } from '../../src/domain/planning/execution-graph.js';
import type { SessionBinding, SpecBinding } from '../../src/domain/task-contract.js';
import type { EvidenceRecord } from '../../src/domain/worker-report.js';
import { createCompanionStartupFixture, type CompanionStartupFixture } from '../support/companion-startup-harness.js';
import {
  RECOVERY_SCOPE,
  RECOVERY_WORK_PACKAGE,
  RECOVERY_WORKER_TASK,
  createRecoveryHarness,
  fakeRecoveryBackend,
  type RecoveryHarness,
} from '../support/recovery-harness.js';
import { laneKeyOf } from '../../src/application/dto/operation-intent.js';

const clock = (): number => 5_000;
const CLOCK_MS = 5_000;

function revisionOf(target: BranchCoordinationStore): number {
  const read = target.query({ kind: 'scope', coordinationScopeId: RECOVERY_SCOPE });
  if (read.kind !== 'scope' || read.scope === null) {
    throw new Error('Scope 不存在');
  }
  return read.scope.revision;
}

const SCOPE = 'scope-delivery' as CoordinationScopeId;
const SESSION = 'session-delivery' as CoordinatorSessionId;
const CYCLE = 'cycle-delivery' as PlanningCycleId;
const GRAPH = 'graph-delivery' as GraphId;
const WORK_PACKAGE = 'wp-delivery' as WorkPackageId;
const WORKER_TASK = 'task-delivery' as WorkerTaskId;
const DISPATCH = 'dispatch-delivery' as DispatchId;
const AUTHORIZATION = 'auth-delivery';
const RUN = 'run-delivery';
const ORCA_TASK = 'orca-task-delivery';
const WORKTREE = 'worktree-delivery';
const INCARNATION = 'incarnation-delivery' as RuntimeIncarnationId;

const SCOPE_ENVELOPE: ScopeEnvelope = { include: ['src'], exclude: [] };

const SPEC: SpecBinding = {
  provider: 'openspec',
  relativePath: 'openspec/changes/c/specs/spec.md',
  contentDigest: 'digest-delivery',
  providerVersion: '0.4.0',
  contractRevision: 1,
  trackingRevision: 1,
};

let store: CoordinationStore | null = null;
let directory: string | null = null;

afterEach(() => {
  store?.close();
  store = null;
  if (directory !== null) {
    rmSync(directory, { recursive: true, force: true });
    directory = null;
  }
});

/* -------------------------------------------------------------------------- */
/* 装置：一个位于 Execution Coordination 的 Scope，图里含一个 Work Package        */
/* -------------------------------------------------------------------------- */

const GRAPH_TOPOLOGY: ExecutionGraph = {
  graphId: GRAPH,
  generation: 1 as GraphGeneration,
  concurrencyLimit: 1,
  workPackages: [
    {
      workPackageId: WORK_PACKAGE,
      title: '交付一个 Work Package',
      dependsOn: [],
      scopeEnvelope: SCOPE_ENVELOPE,
      budget: {
        implementationAttempts: 1,
        validatorRepairs: 1,
        graphRevisions: 1,
        specificationRevisions: 1,
        maxRecoveriesPerWorkerAttempt: 1,
      },
    },
  ],
};

type DeliveryFixture = {
  readonly store: CoordinationStore;
  readonly writer: CoordinationWriter;
  readonly backend: FakeDeliveryBackend;
  readonly readInput: Omit<PendingDeliveryReadInput, 'store' | 'backend'>;
};

function createDeliveryFixture(): DeliveryFixture {
  directory = mkdtempSync(join(tmpdir(), 'orca-delivery-'));
  const opened = openCoordinationStore({ databasePath: join(directory, 'coordination.sqlite'), clock });
  if (opened.kind !== 'opened') {
    throw new Error(opened.message);
  }
  store = opened.store;
  const created = store;
  const initialized = initializeCoordinationScope({
    store: created,
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION,
    coordinatorModelConfigurationRef: 'model-config-delivery',
    planningCycleId: CYCLE,
    fullBranchRef: `refs/heads/${SCOPE}`,
    canonicalWorktreePath: '/tmp/orca-delivery-worktree',
  });
  if (initialized.kind !== 'initialized') {
    throw new Error(`无法初始化 Scope: ${initialized.message}`);
  }
  const leased = acquireRuntimeLease(created, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION,
    runtimeIncarnationId: INCARNATION,
    fencingGeneration: 0,
  });
  if (leased.kind !== 'acquired') {
    throw new Error('无法取得 Runtime Lease');
  }
  const writer: CoordinationWriter = {
    coordinatorSessionId: SESSION,
    runtimeIncarnationId: INCARNATION,
    fencingGeneration: leased.lease.fencingGeneration,
  };
  const revisionOf = (): number => {
    const read = created.query({ kind: 'scope', coordinationScopeId: SCOPE });
    if (read.kind !== 'scope' || read.scope === null) {
      throw new Error('Scope 不存在');
    }
    return read.scope.revision;
  };
  const mapRevisionOf = (): number => {
    const read = created.query({ kind: 'scope', coordinationScopeId: SCOPE });
    if (read.kind !== 'scope' || read.scope === null) {
      throw new Error('Scope 不存在');
    }
    return read.scope.mapRevision;
  };

  const candidate = recordInitialGraph({
    store: created,
    coordinationScopeId: SCOPE,
    writer,
    graph: GRAPH_TOPOLOGY,
    mapRevision: mapRevisionOf(),
    planRevision: 1,
    orcaRunId: RUN,
  });
  if (candidate.kind !== 'recorded') {
    throw new Error(`无法记录候选图: ${candidate.failure.message}`);
  }
  const proposed = proposeManifest({
    store: created,
    coordinationScopeId: SCOPE,
    candidate: candidate.version,
    currentPlanRevision: candidate.version.planRevision,
    rawManifest: {
      coordinationScopeId: SCOPE,
      planningCycleId: CYCLE,
      destinationRef: { kind: 'destination', id: 'destination-delivery', version: 1 },
      routeMapRef: { kind: 'route-map', id: 'map-delivery', version: candidate.version.mapRevision },
      implementationPlanRef: {
        kind: 'implementation-plan',
        id: 'plan-delivery',
        version: candidate.version.planRevision,
      },
      graph: {
        graphId: candidate.version.graphId,
        generation: candidate.version.generation,
        version: candidate.version.version,
      },
      baselineHead: 'head-delivery',
      orcaRunId: RUN,
      workerProfiles: (['planner', 'implementation', 'validator', 'finalizer'] as const).map((role) => ({
        profileRef: { kind: 'worker-profile' as const, id: `profile-${role}` },
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
      limits: { maxRecoveriesPerWorkerAttempt: 1 },
      workspacePolicy: { canonicalWorktree: '/tmp/orca-delivery-worktree', worktreeIsolation: 'per_work_package' },
      gitPolicy: {
        canonicalBranch: 'main',
        remotes: ['origin'],
        refs: ['refs/heads/main'],
        allowForcePush: false,
      },
      dependencyPolicy: { allowDependencyChanges: false, registry: null },
      acceptedRisks: ['risk-delivery'],
    },
  });
  if (proposed.kind !== 'proposed') {
    throw new Error(`无法组装 Manifest: ${proposed.failure.message}`);
  }
  const approved = recordApproval({
    store: created,
    coordinationScopeId: SCOPE,
    writer,
    authorizationId: AUTHORIZATION,
    manifest: proposed.manifest,
    currentPlanRevision: candidate.version.planRevision,
    approvalRef: 'approval-delivery',
  });
  if (approved.kind !== 'recorded') {
    throw new Error(`无法记录授权: ${approved.failure.message}`);
  }
  // Scope 引用只能由 Execution Coordination Lease 持有者推进：先取得租约。
  const executionLease = created.transact({
    kind: 'acquire-execution-lease',
    coordinationScopeId: SCOPE,
    expectedRevision: revisionOf(),
    writer,
  });
  if (executionLease.kind !== 'committed') {
    throw new Error(`无法取得 Execution Lease: ${executionLease.message}`);
  }
  const refs = created.transact({
    kind: 'update-scope-refs',
    coordinationScopeId: SCOPE,
    expectedRevision: revisionOf(),
    writer,
    graphId: GRAPH,
    graphVersion: candidate.version.version,
    authorizationId: AUTHORIZATION,
    authorizationVersion: approved.authorization.authorizationVersion,
  });
  if (refs.kind !== 'committed') {
    throw new Error(`无法更新 Scope 引用: ${refs.message}`);
  }
  // 派发时 Controller 写入的中断 Segment：Delivery 的归属必须能在这里被证明。
  const segment = created.transact({
    kind: 'record-session-segment',
    coordinationScopeId: SCOPE,
    expectedRevision: revisionOf(),
    writer,
    segmentId: 'segment-delivery-1' as SessionSegmentId,
    workPackageId: WORK_PACKAGE,
    role: 'validator',
    workerTaskId: WORKER_TASK,
    dispatchId: DISPATCH,
    attemptId: 'attempt-1',
    sessionBindingId: 'binding-delivery-1',
    lastTranscriptRef: 'transcript:delivery-1',
    terminalReceiptRef: null,
    transcriptReferenceable: true,
    verifiable: true,
  });
  if (segment.kind === 'rejected') {
    throw new Error(`无法记录 Session Segment: ${segment.message}`);
  }
  const binding = created.transact({
    kind: 'record-materialization-binding',
    coordinationScopeId: SCOPE,
    expectedRevision: revisionOf(),
    writer,
    workPackageId: WORK_PACKAGE,
    role: 'validator',
    workerTaskId: WORKER_TASK,
    dispatchId: DISPATCH,
    attemptId: 'attempt-1',
    worktreeId: WORKTREE,
    specBinding: SPEC,
    specificationUnitPath: null,
    orcaTaskId: ORCA_TASK,
    creationOperationId: `op:${ORCA_TASK}:create` as OperationId,
    launchId: `launch:${ORCA_TASK}`,
  });
  if (binding.kind === 'rejected') {
    throw new Error(`无法记录物化绑定: ${binding.message}`);
  }

  const backend = fakeDeliveryBackend();
  return {
    store: created,
    writer,
    backend,
    readInput: {
      coordinationScopeId: SCOPE,
      backendIdentityRef: 'coordinator@delivery',
      graphId: GRAPH,
      graphVersion: candidate.version.version,
      graphGeneration: 1,
      authorizationId: AUTHORIZATION,
      runId: RUN,
      consumerGeneration: 1,
      timeoutMs: 60_000,
      readWorktreeFacts: () =>
        Promise.resolve({ kind: 'read', worktreeId: WORKTREE, specBinding: SPEC, changedPaths: ['src/a.ts'] }),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* fake Orca：delivery-read、task-list 与两次 mutation                          */
/* -------------------------------------------------------------------------- */

type FakeDeliveryBackend = {
  readonly backend: ExecutionBackend;
  readonly mutations: readonly ExecutionMutation[];
  readonly result: { deliveryId: string; messages: readonly DeliveryMessage[] };
};

function deliveryMessage(payload: unknown): DeliveryMessage {
  return {
    messageId: 'message-1',
    runId: RUN,
    deliveryContract: 'current_delivery',
    fromHandle: 'worker@delivery',
    toHandle: 'coordinator@delivery',
    type: 'worker_done',
    subject: 'validator 结果',
    priority: null,
    body: '结果见 payload',
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
  };
}

/** 一条完整的 Worker 结果载荷：归属字段 + 结果正文。 */
function workerResultPayload(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    runId: RUN,
    consumerGeneration: 1,
    graphGeneration: 1,
    authorizationId: AUTHORIZATION,
    workerTaskId: WORKER_TASK,
    dispatchId: DISPATCH,
    attemptId: 'attempt-1',
    role: 'validator',
    specBinding: SPEC,
    worktreeId: WORKTREE,
    result: { summary: '实现完成' },
    ...overrides,
  };
}

function fakeDeliveryBackend(
  options: {
    readonly messages?: readonly DeliveryMessage[];
    readonly deliveryId?: string;
    readonly runId?: string | null;
    /** `ackUnknown`：确认的结果未知且没有 request id；后续读取改报「批次已换」。 */
    readonly ackUnknown?: boolean;
  } = {},
): FakeDeliveryBackend {
  const mutations: ExecutionMutation[] = [];
  const deliveryId = options.deliveryId ?? 'delivery-1';
  const messages = options.messages ?? [deliveryMessage(workerResultPayload())];
  let ackedUnknown = false;
  const backend: ExecutionBackend = {
    query: (input: ExecutionQuery): Promise<ExecutionQueryResult> => {
      if (input.operation === 'delivery-read') {
        return Promise.resolve({
          kind: 'accepted',
          value: {
            // 确认结果未知之后再读：这条 Delivery 已不在未确认批次里。
            delivery: ackedUnknown ? { deliveryId: 'delivery-next', runId: options.runId === undefined ? RUN : options.runId } : { deliveryId, runId: options.runId === undefined ? RUN : options.runId },
            messages,
            timedOut: false,
            cancelled: false,
          },
        });
      }
      if (input.operation === 'task-list') {
        return Promise.resolve({
          kind: 'accepted',
          value: { tasks: [{ id: ORCA_TASK, status: 'completed', result: { summary: '实现完成' } }] },
        });
      }
      return Promise.resolve({ kind: 'accepted', value: {} });
    },
    mutate: (input: ExecutionMutation, scope): Promise<never> => {
      mutations.push(input);
      if (options.ackUnknown === true && input.operation === 'delivery-ack') {
        ackedUnknown = true;
        return Promise.resolve({
          kind: 'unknown',
          operation: { operationId: scope.operationId, target: scope.target },
          reason: 'response_lost',
        } as never);
      }
      return Promise.resolve({
        kind: 'accepted',
        operation: {
          operationId: scope.operationId,
          backendRequestId: `request-${scope.operationId}`,
          target: scope.target,
        },
        value: { ok: true },
      } as never);
    },
  };
  return { backend, mutations, result: { deliveryId, messages } };
}

async function readPending(fixture: DeliveryFixture): Promise<PendingDeliveryRead> {
  return await readPendingDeliveries({ ...fixture.readInput, store: fixture.store, backend: fixture.backend.backend });
}

async function replay(
  fixture: DeliveryFixture,
  pending: readonly PendingDelivery[],
  target: BranchCoordinationStore,
  writer: CoordinationWriter,
) {
  return await replayDeliveries({
    store: target,
    backend: fixture.backend.backend,
    coordinationScopeId: SCOPE,
    writer,
    backendIdentityRef: fixture.readInput.backendIdentityRef,
    graphGeneration: fixture.readInput.graphGeneration,
    authorizationId: fixture.readInput.authorizationId,
    runId: RUN,
    consumerGeneration: fixture.readInput.consumerGeneration,
    timeoutMs: fixture.readInput.timeoutMs,
    pending,
  });
}

/** 让本地落盘必然失败：`record-delivery-settlement` 返回显式拒绝。 */
function failingSettlementStore(inner: BranchCoordinationStore): BranchCoordinationStore {
  return {
    query: (input) => inner.query(input),
    transact: (input: CoordinationCommand): CoordinationCommandResult =>
      input.kind === 'record-delivery-settlement'
        ? { kind: 'rejected', code: 'stale_revision', message: '测试注入：本地落盘失败' }
        : inner.transact(input),
  };
}

/* -------------------------------------------------------------------------- */
/* Delivery 装配                                                               */
/* -------------------------------------------------------------------------- */

test('只承载进度消息的批次不当作装配失败：报告为待确认的进度批次', async () => {
  // Orca 的当前批次会停在进度消息（heartbeat）上；真实结果消息在它被确认之后才会成为当前批次。
  // 把进度消息当成「结果正文缺失」会把整条 Delivery lane 永久阻塞。
  const fixture = createDeliveryFixture();
  const progress = fakeDeliveryBackend({
    deliveryId: 'delivery-progress',
    messages: [{ ...deliveryMessage({ taskId: ORCA_TASK, dispatchId: 'ctx-progress', phase: 'implementing' }), type: 'heartbeat' }],
  });

  const read = await readPendingDeliveries({
    ...fixture.readInput,
    store: fixture.store,
    backend: progress.backend,
  });

  expect(read.kind).toBe('read');
  if (read.kind === 'read') {
    expect(read.pending).toEqual([]);
    expect(read.blocked ?? []).toEqual([]);
    expect(read.progressAcks).toEqual([{ deliveryId: 'delivery-progress', runId: RUN }]);
  }
  // 进度消息不落任何权威事实：不读任务、不结算。
  expect(progress.mutations).toEqual([]);
});

test('进度批次按既有 intent 顺序确认：ack 只发一次，意图落到已接受', async () => {
  const fixture = createDeliveryFixture();
  const progress = fakeDeliveryBackend({
    deliveryId: 'delivery-progress',
    messages: [{ ...deliveryMessage({ taskId: ORCA_TASK, dispatchId: 'ctx-progress', phase: 'implementing' }), type: 'heartbeat' }],
  });

  const acked = await ackConsumedDelivery({
    store: fixture.store,
    backend: progress.backend,
    writer: fixture.writer,
    coordinationScopeId: SCOPE,
    backendIdentityRef: fixture.readInput.backendIdentityRef,
    graphGeneration: fixture.readInput.graphGeneration,
    authorizationId: fixture.readInput.authorizationId,
    runId: RUN,
    consumerGeneration: fixture.readInput.consumerGeneration,
    timeoutMs: fixture.readInput.timeoutMs,
    deliveryId: 'delivery-progress',
    deliveryRunId: RUN,
  });

  expect(acked.kind).toBe('acked');
  expect(progress.mutations.filter((mutation) => mutation.operation === 'delivery-ack')).toHaveLength(1);
  const intents = fixture.store.query({ kind: 'intents', coordinationScopeId: SCOPE });
  const ackIntent = intents.kind === 'intents'
    ? intents.intents.find((intent) => intent.operationId === 'delivery-ack:delivery-progress')
    : undefined;
  expect(ackIntent?.state).toBe('settled');
  expect(ackIntent?.outcomeClass).toBe('accepted');
});

test('未确认 Delivery 由载荷声称归属 + store/Git 事实装配成可重放输入', async () => {
  const fixture = createDeliveryFixture();
  const read = await readPending(fixture);

  expect(read.kind).toBe('read');
  if (read.kind !== 'read') {
    return;
  }
  expect(read.blocked ?? []).toEqual([]);
  expect(read.pending).toHaveLength(1);
  const pending = read.pending[0];
  if (pending === undefined) {
    throw new Error('应当装配出一条 PendingDelivery');
  }
  // 声称的归属来自载荷（只有比对才能判定它是否成立）。
  expect(pending.delivery.claimed.workerTaskId).toBe(WORKER_TASK);
  expect(pending.delivery.claimed.runId).toBe(RUN);
  expect(pending.delivery.acceptedResult).toEqual({ summary: '实现完成' });
  // 可信事实来自 store 的物化绑定、当前图与授权，加上 Git 读到的 worktree 事实。
  expect(pending.orcaTaskId).toBe(ORCA_TASK);
  expect(pending.trusted.worktreeId).toBe(WORKTREE);
  expect(pending.trusted.changedPaths).toEqual(['src/a.ts']);
  expect(pending.trusted.scopeEnvelope).toEqual(SCOPE_ENVELOPE);
  expect(pending.trusted.authority.validator).toBe(true);
  expect(pending.trusted.dispatchId).toBe(DISPATCH);
});

test('装配出的 Delivery 走完唯一 pipeline：先记录结果与去重键，最后才确认', async () => {
  const fixture = createDeliveryFixture();
  const read = await readPending(fixture);
  expect(read.kind).toBe('read');
  if (read.kind !== 'read') {
    return;
  }
  const replayed = await replay(fixture, read.pending, fixture.store, fixture.writer);

  expect(replayed.kind).toBe('replayed');
  if (replayed.kind !== 'replayed') {
    return;
  }
  expect(replayed.outcomes[0]?.kind).toBe('settled');
  expect(replayed.outcomes[0]?.confirmed).toBe(true);
  expect(replayed.unconfirmed).toEqual([]);
  // 顺序固定：先在 Orca 记录 Accepted Worker Result，再落本地去重键与结果引用，最后确认。
  expect(fixture.backend.mutations.map((mutation) => mutation.operation)).toEqual(['task-update', 'delivery-ack']);
  const settlements = fixture.store.query({ kind: 'delivery-settlements', coordinationScopeId: SCOPE });
  const recorded = settlements.kind === 'delivery-settlements' ? settlements.settlements : [];
  expect(recorded).toHaveLength(1);
  expect(recorded[0]?.deliveryId).toBe(fixture.backend.result.deliveryId);
  expect(recorded[0]?.dispatchId).toBe(DISPATCH);
});

test('未落盘不 ack：本地写入失败时 Delivery 保持未确认，只留下阻塞的 accept lane', async () => {
  const fixture = createDeliveryFixture();
  const read = await readPending(fixture);
  expect(read.kind).toBe('read');
  if (read.kind !== 'read') {
    return;
  }
  const replayed = await replay(fixture, read.pending, failingSettlementStore(fixture.store), fixture.writer);

  expect(replayed.kind).toBe('replayed');
  if (replayed.kind !== 'replayed') {
    return;
  }
  const outcome = replayed.outcomes[0];
  expect(outcome?.confirmed).toBe(false);
  expect(outcome?.kind).toBe('blocked');
  expect(outcome?.laneKey).toBe(acceptResultLaneKey(ORCA_TASK));
  // Orca 侧已记录结果（task-update），但本地落盘失败后**没有**发出确认。
  expect(fixture.backend.mutations.map((mutation) => mutation.operation)).toEqual(['task-update']);
  const settlements = fixture.store.query({ kind: 'delivery-settlements', coordinationScopeId: SCOPE });
  expect(settlements.kind === 'delivery-settlements' ? settlements.settlements : []).toEqual([]);
});

test('旧代际 Delivery 只补历史：确认但不写入当前生命周期，也不重复记录结果', async () => {
  const fixture = createDeliveryFixture();
  const read = await readPending(fixture);
  if (read.kind !== 'read' || read.pending[0] === undefined) {
    throw new Error('应当装配出一条 PendingDelivery');
  }
  // 载荷声称的是旧 Run：代际核验必须把它判为旧代际，而不是推进当前生命周期。
  const staleMessage = deliveryMessage(workerResultPayload({ runId: 'run-old' }));
  const withStale = { ...read.pending[0], delivery: { ...read.pending[0].delivery, claimed: { ...read.pending[0].delivery.claimed, runId: 'run-old' } } };
  const backend = fakeDeliveryBackend({ messages: [staleMessage] });
  const replayed = await replayDeliveries({
    store: fixture.store,
    backend: backend.backend,
    coordinationScopeId: SCOPE,
    writer: fixture.writer,
    backendIdentityRef: fixture.readInput.backendIdentityRef,
    graphGeneration: fixture.readInput.graphGeneration,
    authorizationId: fixture.readInput.authorizationId,
    runId: RUN,
    consumerGeneration: fixture.readInput.consumerGeneration,
    timeoutMs: fixture.readInput.timeoutMs,
    pending: [withStale],
  });

  expect(replayed.kind).toBe('replayed');
  if (replayed.kind !== 'replayed') {
    return;
  }
  expect(replayed.outcomes[0]?.kind).toBe('history_only');
  expect(replayed.outcomes[0]?.confirmed).toBe(true);
  // 只确认，不记录 Accepted Worker Result，也不写入去重键与结果引用。
  expect(backend.mutations.map((mutation) => mutation.operation)).toEqual(['delivery-ack']);
  const settlements = fixture.store.query({ kind: 'delivery-settlements', coordinationScopeId: SCOPE });
  expect(settlements.kind === 'delivery-settlements' ? settlements.settlements : []).toEqual([]);
});

test('Delivery 事实证明不了时给出显式阻塞，不用空数组冒充「没有未确认 Delivery」', async () => {
  const fixture = createDeliveryFixture();

  // 1. 载荷无法解析：阻塞 ack lane，并且**不**产出一条看似可结算的 Delivery。
  const unparsable = fakeDeliveryBackend({ messages: [deliveryMessage('{不是 JSON')] });
  const read = await readPendingDeliveries({
    ...fixture.readInput,
    store: fixture.store,
    backend: unparsable.backend,
  });
  expect(read.kind).toBe('read');
  if (read.kind === 'read') {
    expect(read.pending).toEqual([]);
    expect(read.blocked?.map((block) => block.code)).toEqual(['payload_not_json']);
    expect(read.blocked?.[0]?.laneKey).toBe(ackLaneKey('delivery-1'));
  }

  // 2. Store 里没有与该归属匹配的中断 Segment：阻塞但不臆造 lane。
  const otherIdentity = fakeDeliveryBackend({
    messages: [deliveryMessage(workerResultPayload({ dispatchId: 'dispatch-unknown' }))],
  });
  const unknown = await readPendingDeliveries({
    ...fixture.readInput,
    store: fixture.store,
    backend: otherIdentity.backend,
  });
  if (unknown.kind !== 'read') {
    throw new Error('读取本身应当成功');
  }
  expect(unknown.pending).toEqual([]);
  expect(unknown.blocked?.map((block) => block.code)).toEqual(['dispatch_record_missing']);

  // 3. worktree / Spec Binding 事实读不到：阻塞 accept lane，而不是拿不可证明的事实顶替。
  const blocked = await readPendingDeliveries({
    ...fixture.readInput,
    store: fixture.store,
    backend: fixture.backend.backend,
    readWorktreeFacts: () =>
      Promise.resolve({
        kind: 'unavailable',
        code: 'spec_binding_unreadable',
        message: '无法重读 Spec Binding',
      }),
  });
  if (blocked.kind !== 'read') {
    throw new Error('读取本身应当成功');
  }
  expect(blocked.pending).toEqual([]);
  expect(blocked.blocked?.[0]?.code).toBe('spec_binding_unreadable');
  expect(blocked.blocked?.[0]?.laneKey).toBe(acceptResultLaneKey(ORCA_TASK));

  // 4. 有稳定 Delivery 身份但没有消息：既不结算也不确认。
  const empty = fakeDeliveryBackend({ messages: [] });
  const noMessages = await readPendingDeliveries({
    ...fixture.readInput,
    store: fixture.store,
    backend: empty.backend,
  });
  if (noMessages.kind !== 'read') {
    throw new Error('读取本身应当成功');
  }
  expect(noMessages.pending).toEqual([]);
  expect(noMessages.blocked?.map((block) => block.code)).toEqual(['delivery_messages_missing']);
});

/* -------------------------------------------------------------------------- */
/* Validator：同一真实 Session 的修复与复验                                      */
/* -------------------------------------------------------------------------- */

const VALIDATION = 'validation-1' as ValidationAttemptId;
const VALIDATOR_AUTHORITY: RoleAuthorities = {
  planner: false,
  implementation: true,
  validator: true,
  finalizer: true,
  gitIntegration: false,
  dependencyChanges: false,
};

function validatorSession(overrides: Partial<SessionBinding> = {}): SessionBinding {
  return {
    harness: 'codex',
    role: 'validator',
    workerTaskId: RECOVERY_WORKER_TASK,
    dispatchId: 'dispatch-source-1' as DispatchId,
    attemptId: 'attempt-1',
    providerSessionId: 'provider-session-1',
    transcriptRef: 'transcript-1',
    observedAt: '2026-09-23T00:00:00.000Z',
    ...overrides,
  };
}

function evidence(id: string, coveredPaths: readonly string[]): EvidenceRecord {
  return { evidenceId: id, kind: 'command', coveredPaths, command: 'pnpm test', summary: 'ok', outcome: 'passed' };
}

function validationInput(runStep: (request: ValidatorStepRequest) => Promise<ValidatorStepResult>) {
  return {
    runStep,
    implementerRole: 'implementation' as const,
    validatorRole: 'validator' as const,
    authority: VALIDATOR_AUTHORITY,
    workPackageId: RECOVERY_WORK_PACKAGE,
    workerTaskId: RECOVERY_WORKER_TASK,
    dispatchId: 'dispatch-source-1' as DispatchId,
    validationAttemptId: VALIDATION,
    sessionBinding: validatorSession(),
    scopeEnvelope: SCOPE_ENVELOPE,
    repairBudget: { limit: 1, consumed: 0 },
    implementationBudget: { limit: 2, consumed: 1 },
    evidence: [] as readonly EvidenceRecord[],
    maxSteps: 4,
  };
}

test('修复与复验落在同一条真实 session 上：验证→修复→复验走完并保留实现预算', async () => {
  const steps: ValidatorStepRequest[] = [];
  const runner = createValidatorStepRunner({
    bindSession: () => Promise.resolve(validatorSession()),
    session: {
      runStep: (request) => {
        steps.push(request);
        if (request.kind === 'verify' && steps.length === 1) {
          return Promise.resolve({
            kind: 'verified',
            outcome: 'failed',
            evidence: [evidence('ev-1', ['src'])],
            summary: '缺少边界处理',
            sessionBinding: validatorSession(),
            repairIntent: { changedPaths: ['src/a.ts'], requiresDesignChange: false, requiresDependencyChange: false },
          });
        }
        if (request.kind === 'repair') {
          return Promise.resolve({
            kind: 'repair_applied',
            changedPaths: ['src/a.ts'],
            sessionBinding: validatorSession(),
            note: '补齐边界处理',
          });
        }
        return Promise.resolve({
          kind: 'verified',
          outcome: 'passed',
          evidence: [evidence('ev-2', ['src/a.ts'])],
          summary: '复验通过',
          sessionBinding: validatorSession(),
          repairIntent: null,
        });
      },
    },
  });

  const result = await runValidation(validationInput(runner));

  expect(result.kind).toBe('validated');
  if (result.kind !== 'validated') {
    return;
  }
  expect(steps.map((step) => step.kind)).toEqual(['verify', 'repair', 'verify']);
  // 三步都带着同一条真实 session 的绑定：修复与复验没有换会话。
  expect(steps.every((step) => step.sessionBinding.providerSessionId === 'provider-session-1')).toBe(true);
  expect(result.sessionBindingId).toBe('provider-session-1');
  // 验证链不消耗、也不重置实现预算。
  expect(result.repairBudget).toEqual({ limit: 1, consumed: 1 });
  expect(result.implementationBudget).toEqual({ limit: 2, consumed: 1 });
});

test('步骤换了 session 或绑定不可读时按 session_lost 返回，不伪造成继续', async () => {
  const stepped: ValidatorStepRequest[] = [];
  const drifting = createValidatorStepRunner({
    bindSession: () => Promise.resolve(validatorSession()),
    session: {
      runStep: (request) => {
        stepped.push(request);
        return Promise.resolve({
          kind: 'verified',
          outcome: 'passed',
          evidence: [evidence('ev-1', ['src'])],
          summary: '另一个会话给出的结论',
          sessionBinding: validatorSession({ providerSessionId: 'provider-session-2' }),
          repairIntent: null,
        });
      },
    },
  });
  expect(await runValidation(validationInput(drifting))).toMatchObject({ kind: 'blocked', code: 'session_lost' });
  expect(stepped).toHaveLength(1);

  // 绑定本身读不到：连一次步骤都不执行，结论同样是 session 丢失。
  const unavailable = createValidatorStepRunner({
    bindSession: () =>
      Promise.resolve({ kind: 'unavailable', code: 'binding_unreadable', message: 'provider session 身份读不到' }),
    session: {
      runStep: () => Promise.reject(new Error('绑定不可读时不得执行步骤')),
    },
  });
  expect(await runValidation(validationInput(unavailable))).toMatchObject({ kind: 'blocked', code: 'session_lost' });
});

/* -------------------------------------------------------------------------- */
/* Recovery：精确 transcript 缺失时保持未决                                       */
/* -------------------------------------------------------------------------- */

let recoveryFixture: CompanionStartupFixture | null = null;

afterEach(() => {
  recoveryFixture?.close();
  recoveryFixture = null;
});

test('精确 transcript 缺失时 Recovery 保持未决并阻塞替代派发 lane', async () => {
  const fixture = createCompanionStartupFixture({
    recovery: {
      livenessFor: (recovery) =>
        Promise.resolve({
          dispatchId: recovery.sourceDispatchId,
          workerRunning: true,
          terminalHandle: 'terminal-1',
          host: { kind: 'enumerated' as const, terminalHandles: ['terminal-1'] },
        }),
      // 原会话仍在运行但已不可精确恢复：进入替代流程，于是 Capsule 成为必经一步。
      resumeExact: () => Promise.resolve({ kind: 'unrecoverable', reason: '原会话的 provider session 已丢失' }),
    },
  });
  recoveryFixture = fixture;
  const segment = fixture.harness.recordSourceSegment({
    segmentId: 'segment-transcriptless-1',
    dispatchId: 'dispatch-transcriptless-1',
    attemptId: 'attempt-1',
    // 与注入的 observation 报告的同一条绑定：归属必须能被精确证明，才谈得上 Capsule 这一步。
    sessionBindingId: 'binding-source-1',
    role: 'validator',
    lastTranscriptRef: null,
    transcriptReferenceable: false,
  });
  const recoveryId = deriveRecoveryId(RECOVERY_SCOPE, segment.segmentId);
  const recorded = fixture.harness.store.transact({
    kind: 'record-recovery',
    coordinationScopeId: RECOVERY_SCOPE,
    expectedRevision: revisionOf(fixture.harness.store),
    writer: fixture.harness.writer,
    recoveryId,
    role: 'validator',
    workPackageId: RECOVERY_WORK_PACKAGE,
    workerTaskId: RECOVERY_WORKER_TASK,
    businessAttemptId: 'attempt-1',
    sourceSegmentId: segment.segmentId,
    sourceDispatchId: segment.dispatchId,
  });
  expect(recorded.kind).toBe('committed');

  const result = await fixture.start('incarnation-transcriptless' as RuntimeIncarnationId);

  expect(result.kind).toBe('started');
  if (result.kind !== 'started') {
    return;
  }
  const continuation = result.recoveries.find((entry) => entry.recoveryId === recoveryId);
  expect(continuation?.result.kind).toBe('blocked');
  if (continuation?.result.kind === 'blocked') {
    expect(continuation.result.code).toBe('transcript_unavailable');
  }
  // 绝不伪称已续接：没有替代派发，Recovery 也没有进入任何终态（recovered / cancelled）。
  expect(fixture.harness.backend.mutations().filter((mutation) => mutation.operation === 'worker-start')).toEqual([]);
  const recordedRecovery = fixture.harness.recovery(recoveryId);
  expect(isNonTerminalRecoveryStatus(recordedRecovery?.status ?? 'cancelled')).toBe(true);
  expect(recordedRecovery?.blockingReason ?? '').toContain('transcript');
  expect(result.dispatchHoldingRecoveryIds).toContain(recoveryId);
  expect(result.blockers.some((blocker) => blocker.recoveryId === recoveryId)).toBe(true);
  const recoveryLaneKey = laneKeyOf({ kind: 'worker-task', id: RECOVERY_WORKER_TASK }, 'worker-dispatch');
  expect(result.readiness.mayUseLane(recoveryLaneKey)).toBe(false);
  expect(result.blockers.some((blocker) => blocker.laneKey === recoveryLaneKey)).toBe(true);
});

test('生产事实装配读不到归属时：以结构化 blocker 呈现，不伪造 Session 身份也不写终态', async () => {
  // 生产装配：store 与 fake backend 都由 fixture 提供；fake backend 对本次读取返回的不是登记的载荷。
  const fixture = createCompanionStartupFixture({
    recovery: (harness) =>
      createExecutionRecoveryFacts({
        store: () => harness.store,
        backend: harness.backend.backend,
        coordinationScopeId: RECOVERY_SCOPE,
        canonicalWorktree: harness.directory,
        execution: null,
        workerHarness: null,
        workerModel: null,
        codexSandbox: 'workspace-write',
        companionStateRoot: null,
        env: {},
        clock: () => CLOCK_MS,
        bindingWindowMs: 100,
      }),
  });
  recoveryFixture = fixture;
  const segment = fixture.harness.recordSourceSegment({
    segmentId: 'segment-unreadable-1',
    dispatchId: 'dispatch-unreadable-1',
    attemptId: 'attempt-1',
    sessionBindingId: 'binding-unreadable-1',
    role: 'validator',
  });
  const recoveryId = deriveRecoveryId(RECOVERY_SCOPE, segment.segmentId);
  const recorded = fixture.harness.store.transact({
    kind: 'record-recovery',
    coordinationScopeId: RECOVERY_SCOPE,
    expectedRevision: revisionOf(fixture.harness.store),
    writer: fixture.harness.writer,
    recoveryId,
    role: 'validator',
    workPackageId: RECOVERY_WORK_PACKAGE,
    workerTaskId: RECOVERY_WORKER_TASK,
    businessAttemptId: 'attempt-1',
    sourceSegmentId: segment.segmentId,
    sourceDispatchId: segment.dispatchId,
  });
  expect(recorded.kind).toBe('committed');

  const result = await fixture.start('incarnation-unreadable' as RuntimeIncarnationId);

  expect(result.kind).toBe('started');
  if (result.kind !== 'started') {
    return;
  }
  const continuation = result.recoveries.find((entry) => entry.recoveryId === recoveryId);
  expect(continuation?.result.kind).toBe('unverifiable_hold');
  if (continuation?.result.kind === 'unverifiable_hold') {
    // 原因是**读到的**事实不可用（worktree 列举不是登记形状），而不是「本 change 没有适配器」。
    expect(continuation.result.reason).toContain('环境事实无法装配');
    expect(continuation.result.reason).toContain('worktree');
  }
  // 启动没有替它写任何终态，也没有产生任何外部副作用：读到的是「未决」，不是「已恢复」也不是「已退出」。
  expect(fixture.harness.recovery(recoveryId)?.status).toBe('pending');
  expect(fixture.harness.backend.mutations()).toEqual([]);
  const blocker = result.blockers.find((entry) => entry.recoveryId === recoveryId);
  expect(blocker?.source).toBe('recovery');
  expect(blocker?.laneKey).toBe(laneKeyOf({ kind: 'worker-task', id: RECOVERY_WORKER_TASK }, 'worker-dispatch'));
  expect(result.dispatchHoldingRecoveryIds).toContain(recoveryId);
  expect(result.readiness.mayUseLane(blocker?.laneKey ?? 'none')).toBe(false);
});

/* -------------------------------------------------------------------------- */
/* 生产 Recovery 事实：从 Orca / Git / transcript / Store 真读                    */
/* -------------------------------------------------------------------------- */

/**
 * 生产事实装配的证据来自三类真实读取：Orca 的 worktree/worker/terminal 列举与 `worker-show`、Git 的
 * HEAD、以及精确 transcript 的 `session_meta`。这里用脚本化 fake backend 提供前两类，用真实临时 Git
 * 仓库与真实 rollout 文件提供后两类；断言的是**判定结果**（`decideLiveness`、精确绑定结论、workspace
 * 对账结论），不是中间形状。
 */
const RECOVERY_DISPATCH = 'dispatch-prod-1';
const RECOVERY_SESSION_ID = '7f5a1e2b-planted-session';
const RECOVERY_BINDING = sessionBindingIdOf(RECOVERY_DISPATCH, RECOVERY_SESSION_ID);
const RECOVERY_WORKTREE_ID = `worktree:${RECOVERY_WORK_PACKAGE}`;
const RECOVERY_WORKTREE_COMMENT = workPackageComment(RECOVERY_WORK_PACKAGE);

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败：${result.stderr}`);
  }
  return result.stdout.trim();
}

/** 一次性 Git 仓库：workspace 对账必须核验真实 HEAD，而不是自报值。 */
function createWorktreeRepository(): { readonly path: string; readonly head: string } {
  const path = mkdtempSync(join(tmpdir(), 'orca-recovery-workspace-'));
  git(path, ['init', '-b', 'main']);
  git(path, ['config', 'user.email', 'companion@example.invalid']);
  git(path, ['config', 'user.name', 'companion']);
  writeFileSync(join(path, 'README.md'), '# recovery\n', 'utf8');
  git(path, ['add', 'README.md']);
  git(path, ['commit', '-m', 'baseline']);
  return { path, head: git(path, ['rev-parse', 'HEAD']) };
}

/** Codex rollout 的最小可核验形状：首条 `session_meta` 带 session 身份与 cwd。 */
function writeRollout(directory: string, sessionId: string, cwd: string): string {
  const path = join(directory, `rollout-2026-09-24T00-00-00-${sessionId}.jsonl`);
  writeFileSync(
    path,
    `${JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd } })}\n`,
    'utf8',
  );
  return path;
}

function worktreeListOf(path: string): ExecutionQueryResult {
  return {
    kind: 'accepted',
    value: {
      worktrees: [
        {
          worktreeId: RECOVERY_WORKTREE_ID,
          path,
          branch: 'refs/heads/wp-recovery',
          head: null,
          displayName: null,
          comment: RECOVERY_WORKTREE_COMMENT,
          isMainWorktree: false,
        },
      ],
      totalCount: 1,
      truncated: false,
      hostScope: { hostIds: ['host-1'], omittedHostIds: [] },
    },
  };
}

function factsFor(input: {
  readonly harness: RecoveryHarness;
  readonly query: (query: ExecutionQuery) => ExecutionQueryResult | undefined;
  readonly companionStateRoot: string;
  readonly execution?: boolean;
}): ReturnType<typeof createExecutionRecoveryFacts> {
  const harness = input.harness;
  return createExecutionRecoveryFacts({
    store: () => harness.store,
    backend: fakeRecoveryBackend({ query: input.query }).backend,
    coordinationScopeId: RECOVERY_SCOPE,
    canonicalWorktree: harness.directory,
    execution:
      input.execution === false
        ? null
        : {
            backendIdentityRef: 'identity-prod',
            graphGeneration: 1,
            authorizationId: 'auth-prod',
            runId: 'run-recovery',
            consumerGeneration: 1,
            timeoutMs: 60_000,
          },
    workerHarness: 'codex',
    workerModel: 'minimax-cn/MiniMax-M3',
    codexSandbox: 'workspace-write',
    companionStateRoot: input.companionStateRoot,
    env: {},
    clock,
    bindingWindowMs: 50,
  });
}

/** 生产事实装置：真实 harness store + 脚本化只读查询 + 一次性 Git 仓库。 */
function createProductionFacts(input: {
  readonly query?: (query: ExecutionQuery) => ExecutionQueryResult | undefined;
} = {}): {
  readonly harness: RecoveryHarness;
  readonly segment: SessionSegmentRecord;
  readonly subject: RecoveryFactSubject;
  readonly facts: ReturnType<typeof createExecutionRecoveryFacts>;
  readonly worktree: { readonly path: string; readonly head: string };
  readonly close: () => void;
} {
  const worktree = createWorktreeRepository();
  const stateRoot = mkdtempSync(join(tmpdir(), 'orca-recovery-state-'));
  const harness = createRecoveryHarness();
  const transcriptRef = writeRollout(stateRoot, RECOVERY_SESSION_ID, worktree.path);
  const segment = harness.recordSourceSegment({
    segmentId: 'segment-prod-1',
    dispatchId: RECOVERY_DISPATCH,
    attemptId: 'attempt-1',
    sessionBindingId: RECOVERY_BINDING,
    role: 'validator',
    lastTranscriptRef: transcriptRef,
  });
  harness.recordMaterializationBinding(RECOVERY_WORK_PACKAGE, 'orca-task-prod', 'attempt-1');
  const query =
    input.query ??
    ((asked: ExecutionQuery): ExecutionQueryResult | undefined =>
      asked.operation === 'worktree-list' ? worktreeListOf(worktree.path) : undefined);
  return {
    harness,
    segment,
    subject: recoverySubjectOf(RECOVERY_SCOPE, segment),
    facts: factsFor({ harness, query, companionStateRoot: stateRoot }),
    worktree,
    close: () => {
      harness.close();
      rmSync(worktree.path, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    },
  };
}

test('生产 workspace 对账：核验实时 worktree 身份与真实 HEAD，缺失或不完整时给出可区分结论', async () => {
  const fixture = createProductionFacts();
  try {
    expect(await fixture.facts.workspaceFor(fixture.subject)).toEqual({
      kind: 'reconciled',
      worktreeId: RECOVERY_WORKTREE_ID,
      head: fixture.worktree.head,
    });
  } finally {
    fixture.close();
  }

  // 隔离 worktree 不存在：这是「工作区已丢失」，不是「无法核验」。
  const missing = createProductionFacts({
    query: (asked) =>
      asked.operation === 'worktree-list'
        ? {
            kind: 'accepted',
            value: { worktrees: [], totalCount: 0, truncated: false, hostScope: { hostIds: [], omittedHostIds: [] } },
          }
        : undefined,
  });
  try {
    expect(await missing.facts.workspaceFor(missing.subject)).toMatchObject({ kind: 'lost' });
  } finally {
    missing.close();
  }

  // 列举被截断：无法证明 worktree 不存在，因此只能是不可核验。
  const truncated = createProductionFacts({
    query: (asked) =>
      asked.operation === 'worktree-list'
        ? {
            kind: 'accepted',
            value: { worktrees: [], totalCount: 9, truncated: true, hostScope: { hostIds: [], omittedHostIds: [] } },
          }
        : undefined,
  });
  try {
    expect(await truncated.facts.workspaceFor(truncated.subject)).toMatchObject({ kind: 'unverifiable' });
  } finally {
    truncated.close();
  }
}, 60_000);

test('生产存活事实：worker 仍在运行 → live；已列举且不含其终端 → exited；列举不可读 → unverifiable', async () => {
  const queryFor = (workerState: string, terminals: readonly string[]): ((asked: ExecutionQuery) => ExecutionQueryResult | undefined) =>
    (asked) => {
      if (asked.operation === 'worker-list') {
        return {
          kind: 'accepted',
          value: {
            workers: [
              {
                dispatchId: RECOVERY_DISPATCH,
                taskId: 'orca-task-prod',
                runId: 'run-recovery',
                workerState,
                terminalState: 'active',
                agentTerminalHandle: 'terminal-prod',
              },
            ],
          },
        };
      }
      if (asked.operation === 'terminal-list') {
        return {
          kind: 'accepted',
          value: {
            terminals: terminals.map((handle) => ({
              handle,
              connected: true,
              writable: true,
              orphaned: false,
              executionHostId: 'host-1',
              worktreeId: RECOVERY_WORKTREE_ID,
              branch: null,
              title: null,
            })),
            hostIds: ['host-1'],
            omittedHostIds: [],
            totalCount: terminals.length,
            truncated: false,
          },
        };
      }
      return undefined;
    };

  const running = createProductionFacts({ query: queryFor('running', ['terminal-prod']) });
  try {
    const liveness = await running.facts.livenessFor(running.subject);
    expect(decideLiveness(liveness as TerminalLivenessFacts).liveness).toBe('live');
  } finally {
    running.close();
  }

  const exited = createProductionFacts({ query: queryFor('succeeded', []) });
  try {
    const liveness = await exited.facts.livenessFor(exited.subject);
    expect(decideLiveness(liveness as TerminalLivenessFacts).liveness).toBe('exited');
  } finally {
    exited.close();
  }

  // 列举不可读：绝不读成「已退出」。
  const unreadable = createProductionFacts({
    query: (asked) => {
      if (asked.operation === 'worker-list') {
        return { kind: 'rejected', code: 'orca_unavailable', message: 'Orca 不可达' };
      }
      return undefined;
    },
  });
  try {
    expect(await unreadable.facts.livenessFor(unreadable.subject)).toMatchObject({ kind: 'unavailable' });
  } finally {
    unreadable.close();
  }
}, 60_000);

test('生产原会话终态：只有已结算的 Orca 结果才算到达终态，未登记状态一律不可核验', async () => {
  const workerShow = (workerState: string): ((asked: ExecutionQuery) => ExecutionQueryResult | undefined) =>
    (asked) =>
      asked.operation === 'worker-show'
        ? {
            kind: 'accepted',
            value: {
              dispatchId: RECOVERY_DISPATCH,
              taskId: 'orca-task-prod',
              dispatchStatus: 'completed',
              workerState,
              workerStage: null,
              agentTerminalHandle: null,
              observationStatus: null,
              exactWorker: true,
            },
          }
        : undefined;

  const exited = createProductionFacts({
    query: (asked) => {
      const shown = workerShow('succeeded')(asked);
      return shown ?? (asked.operation === 'worktree-list' ? worktreeListOf('/tmp') : undefined);
    },
  });
  try {
    // 已退出但没有任何已结算结果：不能声称「到达有效终态」。
    expect(await exited.facts.sourceTerminalFor(exited.subject)).toEqual({ kind: 'not_reached' });
    exited.harness.store.transact({
      kind: 'record-delivery-settlement',
      coordinationScopeId: RECOVERY_SCOPE,
      expectedRevision: revisionOf(exited.harness.store),
      writer: exited.harness.writer,
      dedupeKey: 'dedupe-prod-1',
      deliveryId: 'delivery-prod-1',
      runId: 'run-recovery',
      consumerGeneration: 1,
      workerTaskId: RECOVERY_WORKER_TASK,
      dispatchId: RECOVERY_DISPATCH as DispatchId,
      attemptId: 'attempt-1',
      role: 'validator',
      contractRevision: 1,
      orcaResultRef: 'orca-result-prod-1',
    });
    expect(await exited.facts.sourceTerminalFor(exited.subject)).toEqual({
      kind: 'reached',
      terminalReceiptRef: 'orca-result:orca-result-prod-1',
    });
  } finally {
    exited.close();
  }

  const unknownState = createProductionFacts({ query: (asked) => workerShow('wat')(asked) });
  try {
    expect(await unknownState.facts.sourceTerminalFor(unknownState.subject)).toMatchObject({
      kind: 'unverifiable',
    });
  } finally {
    unknownState.close();
  }
}, 60_000);

test('生产绑定观察：重新读精确 transcript 的 session_meta，并据此得到与记录一致的精确绑定', async () => {
  const fixture = createProductionFacts();
  try {
    const observation = await fixture.facts.observationFor(fixture.subject);
    expect(observation).toEqual({
      sessionBindingId: RECOVERY_BINDING,
      providerSessionId: RECOVERY_SESSION_ID,
      identityChanged: false,
    });
    expect(
      verifyExactSessionBinding({
        role: 'validator',
        workerTaskId: RECOVERY_WORKER_TASK,
        dispatchId: fixture.segment.dispatchId,
        attemptId: fixture.segment.attemptId,
        recorded: {
          sessionBindingId: fixture.segment.sessionBindingId,
          providerSessionId: null,
          identityChanged: false,
        },
        observed: observation as RecoveryBindingObservation,
      }),
    ).toMatchObject({ kind: 'exact', providerSessionId: RECOVERY_SESSION_ID });
  } finally {
    fixture.close();
  }

  // transcript 已不可引用：归属无法重新证明，只能阻塞。
  const transcriptless = createProductionFacts();
  try {
    const segment = transcriptless.harness.recordSourceSegment({
      segmentId: 'segment-prod-2',
      dispatchId: RECOVERY_DISPATCH,
      attemptId: 'attempt-1',
      sessionBindingId: RECOVERY_BINDING,
      role: 'validator',
      lastTranscriptRef: null,
      transcriptReferenceable: false,
    });
    expect(
      await transcriptless.facts.observationFor(recoverySubjectOf(RECOVERY_SCOPE, segment)),
    ).toMatchObject({ kind: 'unavailable', code: 'transcript_unreferenced' });
  } finally {
    transcriptless.close();
  }
}, 60_000);

test('生产角色门：planner 以已落盘的规格单元为准，缺单元即阻塞', async () => {
  const worktree = createWorktreeRepository();
  const harness = createRecoveryHarness({ role: 'planner' });
  try {
    const segment = harness.recordSourceSegment({
      segmentId: 'segment-planner-1',
      dispatchId: RECOVERY_DISPATCH,
      attemptId: 'attempt-1',
      sessionBindingId: RECOVERY_BINDING,
      role: 'planner',
      lastTranscriptRef: writeRollout(harness.directory, RECOVERY_SESSION_ID, worktree.path),
    });
    harness.recordMaterializationBinding(RECOVERY_WORK_PACKAGE, 'orca-task-prod', 'attempt-1');
    const facts = factsFor({
      harness,
      query: (asked) => (asked.operation === 'worktree-list' ? worktreeListOf(worktree.path) : undefined),
      companionStateRoot: harness.directory,
    });
    const subject = recoverySubjectOf(RECOVERY_SCOPE, segment);

    expect(await facts.roleGateFor(subject)).toEqual({
      role: 'planner',
      planner: { specificationUnitLanded: false, hiddenDecisions: [] },
    });

    const unitPath = join(worktree.path, `openspec/changes/${RECOVERY_WORK_PACKAGE}`);
    mkdirSync(join(worktree.path, 'openspec/changes'), { recursive: true });
    writeFileSync(unitPath, '# specification unit\n', 'utf8');
    expect(await facts.roleGateFor(subject)).toEqual({
      role: 'planner',
      planner: { specificationUnitLanded: true, hiddenDecisions: [] },
    });
  } finally {
    harness.close();
    rmSync(worktree.path, { recursive: true, force: true });
  }
}, 60_000);

test('生产替代派发：只复用原 Worker Profile，SessionStart 报告读不到时不伪造 Binding', async () => {
  const fixture = createProductionFacts();
  try {
    const replacement = fixture.facts.replacementFor(fixture.subject);
    expect('kind' in replacement).toBe(false);
    if ('kind' in replacement) {
      return;
    }
    // 复用原 Profile：不从界面或模型换一个模型。
    expect(replacement.profile).toEqual({ kind: 'reuse', profileRef: 'minimax-cn/MiniMax-M3' });
    // 复用既有的 Codex prepared-terminal 策略：替代 Session 的启动方式与常规派发同源。
    expect(replacement.workerLaunch.kind).toBe('prepared_terminal');
    // 窗口内没有 SessionStart 报告：回执解释只能失败，而不是猜一个 Binding。
    const receipt = await replacement.interpretReceipt({
      kind: 'accepted',
      operation: {
        operationId: 'op-prod',
        backendRequestId: 'request-op-prod',
        target: { kind: 'worker-task', id: RECOVERY_WORKER_TASK },
      },
      value: {
        state: 'ready',
        stage: null,
        runId: 'run-recovery',
        taskId: 'orca-task-prod',
        dispatchId: 'dispatch-replacement-1',
      },
    });
    expect('failure' in receipt).toBe(true);
    if ('failure' in receipt) {
      expect(receipt.failure).toContain('SessionStart');
    }

    // 缺少 Worker 模型或 Companion 状态根时如实不可读，而不是派发一个无法证明的 Session。
    const modeless = createExecutionRecoveryFacts({
      store: () => fixture.harness.store,
      backend: fixture.harness.backend.backend,
      coordinationScopeId: RECOVERY_SCOPE,
      canonicalWorktree: fixture.harness.directory,
      execution: null,
      workerHarness: 'codex',
      workerModel: null,
      codexSandbox: 'workspace-write',
      companionStateRoot: null,
      env: {},
      clock,
      bindingWindowMs: 10,
    });
    expect(modeless.replacementFor(fixture.subject)).toMatchObject({ kind: 'unavailable' });
  } finally {
    fixture.close();
  }
}, 60_000);

/* -------------------------------------------------------------------------- */
/* 真实 Orca 载荷形状：locator 解析                                              */
/* -------------------------------------------------------------------------- */

/** 真实 Codex Worker 投递的 `worker_done` 载荷（Orca 规范形状），不含 Companion 身份。 */
function orcaWorkerDonePayload(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    taskId: ORCA_TASK,
    dispatchId: DISPATCH,
    outcome: 'succeeded',
    filesModified: ['README.md'],
    ...overrides,
  };
}

test('Orca 规范形状的 worker_done：按 orcaTaskId + Session Segment 解析归属并进入可结算列表', async () => {
  const fixture = createDeliveryFixture();
  const orca = fakeDeliveryBackend({ messages: [deliveryMessage(orcaWorkerDonePayload())] });
  const read = await readPendingDeliveries({
    ...fixture.readInput,
    store: fixture.store,
    backend: orca.backend,
  });
  expect(read.kind).toBe('read');
  if (read.kind !== 'read') {
    return;
  }
  // 归属由已记录事实解析：Work Package / 角色 / Attempt / worktree 都来自 Segment 与物化绑定。
  expect(read.blocked ?? []).toEqual([]);
  expect(read.pending).toHaveLength(1);
  const pending = read.pending[0]!;
  expect(pending.orcaTaskId).toBe(ORCA_TASK);
  expect(pending.delivery.claimed.workerTaskId).toBe(WORKER_TASK);
  expect(pending.delivery.claimed.dispatchId).toBe(DISPATCH);
  expect(pending.delivery.claimed.attemptId).toBe('attempt-1');
  expect(pending.delivery.claimed.role).toBe('validator');
  expect(pending.delivery.claimed.worktreeId).toBe(WORKTREE);
  // 结果正文归一化自 Orca 报告（状态 + 改动清单 + 叙述），不要求 Worker 回显 Companion 的 result。
  expect(pending.delivery.acceptedResult).toEqual({
    outcome: 'succeeded',
    filesModified: ['README.md'],
    summary: '结果见 payload',
  });
});

test('Orca 规范形状但定位不到已记录的派发时阻塞，不按「最接近的一条」匹配', async () => {
  const fixture = createDeliveryFixture();
  const unknownDispatch = fakeDeliveryBackend({
    messages: [deliveryMessage(orcaWorkerDonePayload({ dispatchId: 'ctx-unknown' }))],
  });
  const read = await readPendingDeliveries({
    ...fixture.readInput,
    store: fixture.store,
    backend: unknownDispatch.backend,
  });
  if (read.kind !== 'read') {
    throw new Error('读取本身应当成功');
  }
  expect(read.pending).toEqual([]);
  expect(read.blocked?.map((block) => block.code)).toEqual(['dispatch_record_missing']);

  // 已知 Dispatch 但 Orca Task 对不上：同样阻塞（身份逐项一致才放行）。
  const unknownTask = fakeDeliveryBackend({
    messages: [deliveryMessage(orcaWorkerDonePayload({ taskId: 'task-other' }))],
  });
  const second = await readPendingDeliveries({
    ...fixture.readInput,
    store: fixture.store,
    backend: unknownTask.backend,
  });
  if (second.kind !== 'read') {
    throw new Error('读取本身应当成功');
  }
  expect(second.pending).toEqual([]);
  expect(second.blocked?.map((block) => block.code)).toEqual(['dispatch_record_missing']);
});

test('确认结果未知但 Orca 的未确认批次已换：按事实收尾，不再把 lane 阻塞', async () => {
  const fixture = createDeliveryFixture();
  const backend = fakeDeliveryBackend({ ackUnknown: true });
  const read = await readPending({ ...fixture, backend });
  expect(read.kind).toBe('read');
  if (read.kind !== 'read') {
    return;
  }

  const replayed = await replay(fixture, read.pending, fixture.store, fixture.writer);

  expect(replayed.kind).toBe('replayed');
  if (replayed.kind !== 'replayed') {
    return;
  }
  // 事实是「这条 Delivery 已不在未确认批次里」：确认按已发生处理，结果照常写入并落去重键。
  expect(replayed.outcomes[0]?.kind).toBe('settled');
  expect(replayed.outcomes[0]?.confirmed).toBe(true);
  const settlements = fixture.store.query({ kind: 'delivery-settlements', coordinationScopeId: SCOPE });
  expect(settlements.kind === 'delivery-settlements' ? settlements.settlements : []).toHaveLength(1);
});
