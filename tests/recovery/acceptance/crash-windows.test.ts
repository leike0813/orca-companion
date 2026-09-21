/**
 * 6.3 验收层：崩溃窗口
 * （change: `m1-recover-execution`；spec `recovery/worker-sessions` 的替代 Session 路径、
 * D4/D6 的「预写 Operation Intent 之后才执行副作用」与 Delivery 的「先落盘再 ack」）。
 *
 * 崩溃注入方式：在真实 store 外再包一层记录型代理，命中指定命令时**在委托之前**抛出 `CrashSignal`，
 * 于是那条写入从未发生——这正是「进程在两次持久化之间死掉」的等价物。重启用 `reopen()` 重开同一个库，
 * 再用未注入的 store 续办。
 *
 * 覆盖的窗口与不可协商的结论：
 * - intent 预写之前 / 之后：替代派发尚未发生，重启后最多一次派发；
 * - 替代派发已被接受、替代 Segment 与 Recovery 收尾的同一事务提交之前：重启后必须**保持阻塞**，
 *   绝不产生第二个派发，也绝不把「Orca 已派发」当成「Recovery 已完成」；
 * - Delivery ack 之前：本地结果引用尚未落盘时绝不 ack，重放只在落盘之后确认一次
 *   （限定审计标签 `gate.no-ack-before-persist`）；ack 之后崩溃：重放不重复记录结果。
 *
 * 每个窗口都同时断言：最多一个替代派发、最多一条替代 Segment、最多一条 Recovery，且替代派发的
 * OperationId 永远由 RecoveryId 确定性派生（对账不换 ID）。
 *
 * 「替代 Segment 与 Recovery 收尾必须在同一事务」另有一条独立回归：崩溃在该命令提交之前时，
 * 替代 Segment 与 `consumedBudget` 一起缺失，不存在可被低估的半记录。
 */

import { afterEach, expect, test } from 'vitest';

import type {
  DispatchId,
  OperationId,
  SessionSegmentId,
  WorkerTaskId,
  WorkPackageId,
} from '../../../src/application/dto/identity.js';
import type { OperationOutcome } from '../../../src/application/dto/operation-outcome.js';
import { settleDelivery, type SettleDeliveryInput } from '../../../src/application/delivery/process-delivery.js';
import type { CapsuleExtractionOutcome } from '../../../src/application/recovery/recovery-capsule.js';
import {
  deriveRecoveryId,
  deriveReplacementOperationId,
  deriveReplacementSegmentId,
  recoverWorkerSession,
  type RecoverWorkerSessionInput,
} from '../../../src/application/recovery/worker-session-recovery-service.js';
import type {
  BranchCoordinationStore,
  CoordinationCommand,
  RecoveryState,
} from '../../../src/application/ports/branch-coordination-store.js';
import type {
  ExecutionBackend,
  ExecutionMutation,
  ExecutionScope,
} from '../../../src/application/ports/execution-backend.js';
import type { RoleAuthorities } from '../../../src/domain/planning/execution-authorization.js';
import { consumedRecoveryBudget } from '../../../src/domain/recovery/recovery-budget.js';
import type { SpecBinding } from '../../../src/domain/task-contract.js';
import type { TerminalLivenessFacts } from '../../../src/domain/worker-liveness.js';
import type {
  ClaimedResultAttribution,
  TrustedExecutionFacts,
} from '../../../src/domain/worker-result-verification.js';
import {
  RECOVERY_AUTHORIZATION,
  RECOVERY_SCOPE,
  RECOVERY_WORKER_TASK,
  RECOVERY_WORK_PACKAGE,
  createRecoveryHarness,
  type RecoveryHarness,
  type SourceSegmentInput,
} from '../../support/recovery-harness.js';

const ORCA_TASK = 'orca-task-recovery';
const SOURCE_DISPATCH = 'dispatch-source-1' as DispatchId;
const SOURCE_SEGMENT = 'segment-source-1' as SessionSegmentId;
const SOURCE_BINDING = 'binding-source-1';
const ATTEMPT = 'attempt-1';

const DELIVERY_ID = 'delivery-crash-1';
const DELIVERY_DISPATCH = 'dispatch-delivery-1' as DispatchId;
const ACCEPTED_RESULT = { summary: '实现完成', evidence: [{ evidenceId: 'ev-1' }] };

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

const TRUSTED: TrustedExecutionFacts = {
  runId: 'run-recovery',
  consumerGeneration: 1,
  graphGeneration: 1,
  authorizationId: RECOVERY_AUTHORIZATION,
  workerTaskId: RECOVERY_WORKER_TASK,
  dispatchId: DELIVERY_DISPATCH,
  attemptId: ATTEMPT,
  role: 'validator',
  specBinding: SPEC,
  worktreeId: 'worktree-recovery-1',
  authority: AUTHORITY,
  scopeEnvelope: { include: ['src'], exclude: [] },
  changedPaths: ['src/a.ts'],
};

const CLAIMED: ClaimedResultAttribution = {
  runId: 'run-recovery',
  consumerGeneration: 1,
  graphGeneration: 1,
  authorizationId: RECOVERY_AUTHORIZATION,
  workerTaskId: RECOVERY_WORKER_TASK,
  dispatchId: DELIVERY_DISPATCH,
  attemptId: ATTEMPT,
  role: 'validator',
  specBinding: SPEC,
  worktreeId: 'worktree-recovery-1',
};

/** 注入崩溃的显式信号：它代表「这一条写入从未提交」，而不是一次可处理的业务失败。 */
class CrashSignal extends Error {
  readonly commandKind: string;

  constructor(commandKind: string) {
    super(`注入崩溃：${commandKind}`);
    this.name = 'CrashSignal';
    this.commandKind = commandKind;
  }
}

/** 命中 `shouldCrash` 时在委托给真实 store 之前抛出：窗口处的那条写入为零副作用。 */
function crashBefore(
  inner: BranchCoordinationStore,
  shouldCrash: (command: CoordinationCommand) => boolean,
): BranchCoordinationStore {
  return {
    query: (input) => inner.query(input),
    transact: (input) => {
      if (shouldCrash(input)) {
        throw new CrashSignal(input.kind);
      }
      return inner.transact(input);
    },
  };
}

/** 记录写入命令的代理：用于断言替代 Segment 与预算递增出现在同一条命令里。 */
function recordCommands(
  inner: BranchCoordinationStore,
  commands: CoordinationCommand[],
): BranchCoordinationStore {
  return {
    query: (input) => inner.query(input),
    transact: (input) => {
      commands.push(input);
      return inner.transact(input);
    },
  };
}

let harness: RecoveryHarness | null = null;

afterEach(() => {
  harness?.close();
  harness = null;
});

function exitedFacts(): TerminalLivenessFacts {
  return {
    dispatchId: SOURCE_DISPATCH,
    workerRunning: false,
    terminalHandle: 'terminal-1',
    host: { kind: 'enumerated', terminalHandles: [] },
  };
}

function completeCapsule(): Promise<CapsuleExtractionOutcome> {
  return Promise.resolve({
    kind: 'extracted',
    capsule: {
      coverage: 'complete',
      readableRange: { transcriptRef: 'transcript:source-1', fromEventRef: 'ev:1', toEventRef: 'ev:9' },
      gaps: [],
      lastCompleteEventRef: 'ev:9',
      openActions: [],
      sourceRefs: ['ev:9'],
      unknowns: [],
    },
  });
}

function sourceSegment(): SourceSegmentInput {
  return {
    segmentId: SOURCE_SEGMENT,
    dispatchId: SOURCE_DISPATCH,
    attemptId: ATTEMPT,
    sessionBindingId: SOURCE_BINDING,
    lastTranscriptRef: 'transcript:source-1',
  };
}

function setup(created: RecoveryHarness): void {
  created.recordSourceSegment(sourceSegment());
  created.recordMaterializationBinding(RECOVERY_WORK_PACKAGE, ORCA_TASK);
}

function inputFor(
  created: RecoveryHarness,
  overrides: Partial<Parameters<RecoveryHarness['input']>[0]> = {},
): RecoverWorkerSessionInput {
  return created.input({
    sourceSegmentId: SOURCE_SEGMENT,
    sourceDispatchId: SOURCE_DISPATCH,
    businessAttemptId: ATTEMPT,
    observation: {
      sessionBindingId: SOURCE_BINDING,
      providerSessionId: 'provider-session-1',
      identityChanged: false,
    },
    liveness: exitedFacts(),
    extractCapsule: completeCapsule,
    ...overrides,
  });
}

function workerStarts(created: RecoveryHarness): number {
  return created.backend.mutations().filter((mutation) => mutation.operation === 'worker-start').length;
}

function readIntents(created: RecoveryHarness) {
  const read = created.store.query({ kind: 'intents', coordinationScopeId: RECOVERY_SCOPE });
  if (read.kind !== 'intents') {
    throw new Error('无法读取 Operation Intent');
  }
  return read.intents;
}

/* -------------------------------------------------------------------------- */
/* Recovery 崩溃窗口                                                           */
/* -------------------------------------------------------------------------- */

type RecoveryWindow = {
  readonly name: string;
  readonly crashOn: (command: CoordinationCommand, replacementSegmentId: SessionSegmentId) => boolean;
  readonly statusAfterCrash: RecoveryState;
  readonly dispatchesAfterCrash: number;
  readonly replay: 'alternate_created' | 'blocked';
  readonly replayCode: string | null;
  readonly replacementSegmentsAfterReplay: number;
};

const RECOVERY_WINDOWS: readonly RecoveryWindow[] = [
  {
    name: 'intent 预写之前',
    crashOn: (command) => command.kind === 'begin-intent',
    statusAfterCrash: 'pending',
    dispatchesAfterCrash: 0,
    replay: 'alternate_created',
    replayCode: null,
    replacementSegmentsAfterReplay: 1,
  },
  {
    name: 'intent 预写之后、进入 recovering 之前',
    crashOn: (command) => command.kind === 'advance-recovery' && command.status === 'recovering',
    statusAfterCrash: 'pending',
    dispatchesAfterCrash: 0,
    replay: 'alternate_created',
    replayCode: null,
    replacementSegmentsAfterReplay: 1,
  },
  {
    name: '替代派发已被接受、替代 Segment 与 Recovery 收尾的同一事务提交之前',
    crashOn: (command) => command.kind === 'advance-recovery' && command.status === 'recovered',
    statusAfterCrash: 'recovering',
    dispatchesAfterCrash: 1,
    replay: 'blocked',
    replayCode: 'dispatch_identity_unknown',
    replacementSegmentsAfterReplay: 0,
  },
];

test.each(RECOVERY_WINDOWS)(
  '崩溃窗口「$name」：重启后可对账到确定结论或保持未决，绝不产生第二个副作用',
  async (window) => {
    const created = createRecoveryHarness({ maxRecoveriesPerWorkerAttempt: 2 });
    harness = created;
    setup(created);
    const recoveryId = deriveRecoveryId(RECOVERY_SCOPE, SOURCE_SEGMENT);
    const replacementSegmentId = deriveReplacementSegmentId(recoveryId);
    const injected = crashBefore(created.store, (command) => window.crashOn(command, replacementSegmentId));

    await expect(recoverWorkerSession(inputFor(created, { store: injected }))).rejects.toThrow(CrashSignal);

    // 崩溃现场如实停留：副作用最多一次，状态既没有假装成功，也没有凭空推进。
    expect(workerStarts(created)).toBe(window.dispatchesAfterCrash);
    expect(created.recovery(recoveryId)?.status).toBe(window.statusAfterCrash);
    expect(created.recovery(recoveryId)?.terminalOutcome).toBeNull();

    // 重启：重开同一个库，用未注入的 store 续办同一条 Recovery。
    created.reopen();
    const resumed = await recoverWorkerSession(inputFor(created, {}));

    expect(resumed.kind).toBe(window.replay);
    if (window.replayCode !== null && resumed.kind === 'blocked') {
      expect(resumed.code).toBe(window.replayCode);
    }
    // 核心合同：整条路径（崩溃前 + 崩溃后）最多一个替代派发。
    expect(workerStarts(created)).toBeLessThanOrEqual(1);
    if (window.replay === 'alternate_created') {
      expect(workerStarts(created)).toBe(1);
    } else {
      // 已经发生过的那一次派发不会被重放成第二次。
      expect(workerStarts(created)).toBe(window.dispatchesAfterCrash);
    }
    // 至多一条 Recovery、至多一条替代 Segment；替代派发的 OperationId 永远确定性派生。
    expect(created.recoveries()).toHaveLength(1);
    expect(created.segments().filter((segment) => segment.segmentId === replacementSegmentId)).toHaveLength(
      window.replacementSegmentsAfterReplay,
    );
    const intents = readIntents(created);
    expect(intents.length).toBeLessThanOrEqual(1);
    for (const intent of intents) {
      expect(intent.operationId).toBe(deriveReplacementOperationId(recoveryId));
    }
    // 额度绝不超过一次，也不会因为崩溃被清零到负数。
    expect(consumedRecoveryBudget(created.recoveries(), ATTEMPT)).toBeLessThanOrEqual(1);
  },
);

test('替代 Segment 与 Recovery 收尾是同一条命令：不存在单独写 Segment 的第二步', async () => {
  const created = createRecoveryHarness({ maxRecoveriesPerWorkerAttempt: 2 });
  harness = created;
  setup(created);
  const recoveryId = deriveRecoveryId(RECOVERY_SCOPE, SOURCE_SEGMENT);
  const replacementSegmentId = deriveReplacementSegmentId(recoveryId);
  const commands: CoordinationCommand[] = [];

  const result = await recoverWorkerSession(inputFor(created, { store: recordCommands(created.store, commands) }));
  expect(result.kind).toBe('alternate_created');

  // 没有任何独立的 `record-session-segment` 写入替代 Segment。
  expect(
    commands.filter((command) => command.kind === 'record-session-segment' && command.segmentId === replacementSegmentId),
  ).toHaveLength(0);
  // 替代 Segment 与 `consumedBudget` 出现在同一条收尾命令里——这就是「同一事务」。
  const conclusions = commands.filter((command) => command.kind === 'advance-recovery' && command.status === 'recovered');
  expect(conclusions).toHaveLength(1);
  const conclusion = conclusions[0];
  if (conclusion?.kind === 'advance-recovery') {
    expect(conclusion.replacementSegment?.segmentId).toBe(replacementSegmentId);
    expect(conclusion.consumedBudget).toBe(1);
  } else {
    throw new Error('收尾命令必须是 advance-recovery');
  }
  expect(created.segments().filter((segment) => segment.segmentId === replacementSegmentId)).toHaveLength(1);
  expect(consumedRecoveryBudget(created.recoveries(), ATTEMPT)).toBe(1);
});

test('崩溃窗口「Segment 与收尾同一事务」不留半记录：既无替代 Segment，也无额度消耗', async () => {
  // 这是 (A) 的回归：替代 Segment 与 consumedBudget 递增必须在同一事务内提交。崩溃在该命令提交
  // 之前时，两者一起缺失，因此不存在「Segment 已落盘、consumedBudget 仍为 0」的半记录——那种状态
  // 会让按 Worker Attempt 求和的额度被低估，从而突破 `maxRecoveriesPerWorkerAttempt`。
  const created = createRecoveryHarness({ maxRecoveriesPerWorkerAttempt: 2 });
  harness = created;
  setup(created);
  const recoveryId = deriveRecoveryId(RECOVERY_SCOPE, SOURCE_SEGMENT);
  const replacementSegmentId = deriveReplacementSegmentId(recoveryId);
  const injected = crashBefore(
    created.store,
    (command) => command.kind === 'advance-recovery' && command.status === 'recovered',
  );

  await expect(recoverWorkerSession(inputFor(created, { store: injected }))).rejects.toThrow(CrashSignal);

  // Orca 派发已经发生；但 Segment 与额度消耗属于同一条未提交的命令，必须一起缺失。
  expect(workerStarts(created)).toBe(1);
  expect(created.segments().some((segment) => segment.segmentId === replacementSegmentId)).toBe(false);
  expect(consumedRecoveryBudget(created.recoveries(), ATTEMPT)).toBe(0);
  const crashed = created.recovery(recoveryId);
  expect(crashed?.status).toBe('recovering');
  expect(crashed?.replacementDispatchId).toBeNull();
  expect(crashed?.replacementSegmentId).toBeNull();

  // 重启后必须阻塞：既不能假装收尾完成，也不能重复派发。
  created.reopen();
  const resumed = await recoverWorkerSession(inputFor(created, {}));

  expect(resumed.kind).toBe('blocked');
  if (resumed.kind === 'blocked') {
    expect(resumed.code).toBe('dispatch_identity_unknown');
  }
  const after = created.recovery(recoveryId);
  expect(after?.status).toBe('blocked');
  expect(after?.terminalOutcome).toBe('failed');
  expect(created.segments().some((segment) => segment.segmentId === replacementSegmentId)).toBe(false);
  expect(workerStarts(created)).toBe(1);
  expect(consumedRecoveryBudget(created.recoveries(), ATTEMPT)).toBe(0);
});

/**
 * fail-closed 守护：同一 Worker Attempt 上若已存在「替代派发意图已按 accepted 收尾、但没有替代
 * Session Segment」的 Recovery，则该 attempt 的已消耗额度不可证明。此时按 consumedBudget 求和的
 * 预算读取会低估用量，从而放行第二次替代派发；必须阻塞新 Recovery，绝不猜测、绝不重复派发。
 */
test('[fail-closed] 存在已 accepted 收尾但无替代 Segment 的派发时，同一 attempt 的新 Recovery 被阻塞', async () => {
  const created = createRecoveryHarness({ maxRecoveriesPerWorkerAttempt: 2 });
  harness = created;
  setup(created);
  const recoveryId = deriveRecoveryId(RECOVERY_SCOPE, SOURCE_SEGMENT);
  const replacementOperationId = deriveReplacementOperationId(recoveryId);
  const injected = crashBefore(
    created.store,
    (command) => command.kind === 'advance-recovery' && command.status === 'recovered',
  );
  await expect(recoverWorkerSession(inputFor(created, { store: injected }))).rejects.toThrow(CrashSignal);

  // 前置状态：派发过一次、预写意图已 accepted、但没有替代 Segment（收尾事务未提交）。
  const unresolved = created.recovery(recoveryId);
  expect(unresolved?.status).toBe('recovering');
  expect(unresolved?.prewriteOperationId).toBe(replacementOperationId);
  expect(workerStarts(created)).toBe(1);
  const consumedBefore = consumedRecoveryBudget(created.recoveries(), ATTEMPT);
  expect(consumedBefore).toBe(0);

  // 同一 Worker Attempt 的另一次中断：不得新建 Recovery，也不得再派发一次替代 Session。
  created.recordSourceSegment({
    segmentId: 'segment-source-late',
    dispatchId: 'dispatch-source-late',
    attemptId: ATTEMPT,
    sessionBindingId: 'binding-source-late',
  });
  const blocked = await recoverWorkerSession(
    inputFor(created, {
      sourceSegmentId: 'segment-source-late' as SessionSegmentId,
      sourceDispatchId: 'dispatch-source-late' as DispatchId,
    }),
  );

  expect(blocked.kind).toBe('blocked');
  if (blocked.kind === 'blocked') {
    expect(blocked.code).toBe('dispatch_identity_unknown');
    // 阻塞原因可读，并指明是哪个 attempt、哪条已收尾的 prewrite intent。
    expect(blocked.reason).toContain(ATTEMPT);
    expect(blocked.reason).toContain(replacementOperationId);
  }
  // 零第二次派发，且不为这次中断新建 Recovery 行。
  expect(workerStarts(created)).toBe(1);
  expect(created.recoveries()).toHaveLength(1);
  // 不可证明的那条 Recovery 进入可观测的 blocker。
  const blockedRow = created.recovery(recoveryId);
  expect(blockedRow?.status).toBe('blocked');
  expect(blockedRow?.terminalOutcome).toBe('failed');
  expect(blockedRow?.blockingReason).not.toBeNull();
  // 已消耗额度没有被写成更小值（这里保持 0，且不因为守护被回退）。
  expect(consumedRecoveryBudget(created.recoveries(), ATTEMPT)).toBe(consumedBefore);

  // 合法路径不受影响：另一个 Worker Attempt 的新 Recovery 照常完成替代派发。
  const otherPackage = 'wp-recovery-guard-2' as WorkPackageId;
  const otherTask = 'task-recovery-guard-2' as WorkerTaskId;
  created.recordMaterializationBinding(otherPackage, 'orca-task-guard-2');
  created.recordSourceSegment({
    segmentId: 'segment-other-1',
    dispatchId: 'dispatch-other-1',
    attemptId: 'attempt-other-1',
    sessionBindingId: 'binding-other-1',
    workPackageId: otherPackage,
    workerTaskId: otherTask,
  });
  const other = await recoverWorkerSession(
    inputFor(created, {
      sourceSegmentId: 'segment-other-1' as SessionSegmentId,
      sourceDispatchId: 'dispatch-other-1' as DispatchId,
      businessAttemptId: 'attempt-other-1',
      workPackageId: otherPackage,
      workerTaskId: otherTask,
      observation: {
        sessionBindingId: 'binding-other-1',
        providerSessionId: 'provider-other-1',
        identityChanged: false,
      },
    }),
  );
  expect(other.kind).toBe('alternate_created');
});

/* -------------------------------------------------------------------------- */
/* Delivery ack 崩溃窗口                                                       */
/* -------------------------------------------------------------------------- */

type DeliveryFake = {
  readonly backend: ExecutionBackend;
  readonly ackCalls: () => number;
  readonly taskUpdates: () => number;
};

/** Delivery 结算用 fake backend：只登记本用例需要的四类调用，并统计 ack 与结果记录次数。 */
function deliveryBackend(options: { readonly onAck?: () => void } = {}): DeliveryFake {
  let acks = 0;
  let updates = 0;
  const backend: ExecutionBackend = {
    query: (input) => {
      if (input.operation === 'delivery-read') {
        return Promise.resolve({
          kind: 'accepted',
          value: {
            delivery: { deliveryId: DELIVERY_ID, runId: 'run-recovery' },
            messages: [],
            timedOut: false,
            cancelled: false,
          },
        });
      }
      if (input.operation === 'task-list') {
        return Promise.resolve({
          kind: 'accepted',
          value: [{ id: ORCA_TASK, status: 'completed', result: ACCEPTED_RESULT }],
        });
      }
      return Promise.resolve({ kind: 'rejected', code: 'unregistered_fake_query', message: 'fake 未登记该查询' });
    },
    mutate: (input: ExecutionMutation, scope: ExecutionScope): Promise<OperationOutcome<unknown>> => {
      if (input.operation === 'delivery-ack') {
        acks += 1;
        options.onAck?.();
      }
      if (input.operation === 'task-update') {
        updates += 1;
      }
      return Promise.resolve({
        kind: 'accepted',
        operation: { operationId: scope.operationId, target: scope.target },
        value: input.operation === 'delivery-ack' ? { acknowledged: true } : { ok: true },
      });
    },
  };
  return { backend, ackCalls: () => acks, taskUpdates: () => updates };
}

function scopeRevision(created: RecoveryHarness): number {
  const read = created.store.query({ kind: 'scope', coordinationScopeId: RECOVERY_SCOPE });
  if (read.kind !== 'scope' || read.scope === null) {
    throw new Error('Scope 不存在');
  }
  return read.scope.revision;
}

function settlementRows(created: RecoveryHarness) {
  const read = created.store.query({ kind: 'delivery-settlements', coordinationScopeId: RECOVERY_SCOPE });
  if (read.kind !== 'delivery-settlements') {
    throw new Error('无法读取 Delivery 结算记录');
  }
  return read.settlements;
}

function settlementInput(
  created: RecoveryHarness,
  backend: ExecutionBackend,
  overrides: Partial<SettleDeliveryInput> = {},
): SettleDeliveryInput {
  return {
    store: created.store,
    backend,
    coordinationScopeId: RECOVERY_SCOPE,
    writer: created.writer,
    expectedRevision: scopeRevision(created),
    backendIdentityRef: 'backend-identity-recovery',
    graphGeneration: 1,
    authorizationId: RECOVERY_AUTHORIZATION,
    runId: 'run-recovery',
    consumerGeneration: 1,
    timeoutMs: 5_000,
    orcaTaskId: ORCA_TASK,
    delivery: { deliveryId: DELIVERY_ID, claimed: CLAIMED, acceptedResult: ACCEPTED_RESULT },
    trusted: TRUSTED,
    operationIds: { acceptResult: 'op-accept' as OperationId, ack: 'op-ack' as OperationId },
    ...overrides,
  };
}

test(
  '[gate.no-ack-before-persist] 本地结果引用尚未落盘时崩溃：绝不 ack，重放只在落盘之后确认一次',
  async () => {
    const created = createRecoveryHarness();
    harness = created;
    const crashed = deliveryBackend();
    const injected = crashBefore(
      created.store,
      (command) => command.kind === 'record-delivery-settlement',
    );

    await expect(
      settleDelivery(settlementInput(created, crashed.backend, { store: injected })),
    ).rejects.toThrow(CrashSignal);

    // 关键：本地结果引用没有落盘时，Delivery 一次都没有被确认。
    expect(crashed.ackCalls()).toBe(0);
    expect(settlementRows(created)).toHaveLength(0);

    // 重启后重放：沿用同一组 OperationId，不重复在 Orca 记录结果。
    created.reopen();
    const observedAtAck: number[] = [];
    const replay = deliveryBackend({ onAck: () => observedAtAck.push(settlementRows(created).length) });
    const result = await settleDelivery(settlementInput(created, replay.backend));

    expect(result.kind).toBe('settled');
    // ack 发生的那一刻，本地结算记录已经存在：顺序是「先落盘，再 ack」。
    expect(observedAtAck).toEqual([1]);
    expect(settlementRows(created)).toHaveLength(1);
    expect(replay.ackCalls()).toBe(1);
    // 同一 OperationId 的已接受结果被复用，不产生第二份结果记录。
    expect(replay.taskUpdates()).toBe(0);
  },
);

test('崩溃窗口「确认之后」：重放不重复记录结果，只做幂等确认', async () => {
  const created = createRecoveryHarness();
  harness = created;
  const first = deliveryBackend();
  expect((await settleDelivery(settlementInput(created, first.backend))).kind).toBe('settled');
  const before = settlementRows(created);
  expect(before).toHaveLength(1);
  expect(first.ackCalls()).toBe(1);

  // 进程在确认之后崩溃：重开同一个库重放同一条 Delivery。
  created.reopen();
  const replay = deliveryBackend();
  const result = await settleDelivery(settlementInput(created, replay.backend));

  expect(result.kind).toBe('replayed');
  // 不重复记录 Accepted Worker Result，本地结算记录逐字不变。
  expect(replay.taskUpdates()).toBe(0);
  expect(settlementRows(created)).toEqual(before);
  // 同一 OperationId 的确认意图已经收尾为已接受：重放连第二次 ack 都不发。
  expect(replay.ackCalls()).toBe(0);
});
