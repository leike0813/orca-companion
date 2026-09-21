/**
 * 6.2 验收层：superseded / 非当前 Segment 的迟到结果
 * （change: `m1-recover-execution`；spec `recovery/worker-sessions` 的
 * 「替代 Session 保留业务身份但创建新 Dispatch 与 Segment」）。
 *
 * 这里补的是**身份边界 + 迟到结果只入历史**的验收断言：
 *
 * - 替代 Session 必须新建 Dispatch / Session Binding / Segment，绝不复用原绑定（限定审计标签
 *   `gate.alternate-session-new-dispatch-only`）；
 * - 原 Segment 的迟到结果走**正常 Delivery pipeline**：`settleDelivery` 在身份核验处按 Dispatch
 *   身份把它判为 `stale_attempt`，只确认该 Delivery 而不写结果引用、不推进生命周期（端到端证据，
 *   不是恢复模块里的本地分类器）。
 */

import { afterEach, expect, test } from 'vitest';

import type {
  DispatchId,
  OperationId,
  SessionSegmentId,
} from '../../../src/application/dto/identity.js';
import type { ExecutionQueryResult, OperationOutcome } from '../../../src/application/dto/operation-outcome.js';
import {
  settleDelivery,
  type SettleDeliveryInput,
} from '../../../src/application/delivery/process-delivery.js';
import type { CapsuleExtractionOutcome } from '../../../src/application/recovery/recovery-capsule.js';
import {
  concludeWorkerSessionRecovery,
  recoverWorkerSession,
} from '../../../src/application/recovery/worker-session-recovery-service.js';
import type {
  ExecutionBackend,
  ExecutionMutation,
  ExecutionQuery,
  ExecutionScope,
} from '../../../src/application/ports/execution-backend.js';
import type { RoleAuthorities } from '../../../src/domain/planning/execution-authorization.js';
import type { SpecBinding } from '../../../src/domain/task-contract.js';
import type {
  ClaimedResultAttribution,
  TrustedExecutionFacts,
} from '../../../src/domain/worker-result-verification.js';
import type { TerminalLivenessFacts } from '../../../src/domain/worker-liveness.js';
import {
  RECOVERY_AUTHORIZATION,
  RECOVERY_SCOPE,
  RECOVERY_WORKER_TASK,
  RECOVERY_WORK_PACKAGE,
  createRecoveryHarness,
  type RecoveryHarness,
} from '../../support/recovery-harness.js';

const ORCA_TASK = 'orca-task-recovery';
const SOURCE_DISPATCH = 'dispatch-source-1' as DispatchId;
const SOURCE_SEGMENT = 'segment-source-1' as SessionSegmentId;
const SOURCE_BINDING = 'binding-source-1';
const ATTEMPT = 'attempt-1';

const AUTHORITY: RoleAuthorities = {
  planner: true,
  implementation: true,
  validator: true,
  finalizer: true,
  gitIntegration: false,
  dependencyChanges: false,
};

const SPEC_BINDING: SpecBinding = {
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

function setup(created: RecoveryHarness): void {
  created.recordSourceSegment({
    segmentId: SOURCE_SEGMENT,
    dispatchId: SOURCE_DISPATCH,
    attemptId: ATTEMPT,
    sessionBindingId: SOURCE_BINDING,
  });
  created.recordMaterializationBinding(RECOVERY_WORK_PACKAGE, ORCA_TASK);
}

function recoveryInput(
  created: RecoveryHarness,
  overrides: Partial<Parameters<RecoveryHarness['input']>[0]> = {},
): ReturnType<RecoveryHarness['input']> {
  return created.input({
    sourceSegmentId: SOURCE_SEGMENT,
    sourceDispatchId: SOURCE_DISPATCH,
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

/** 结算迟到 Delivery 用到的 fake backend：只回答该批次与 ack。 */
function fakeDeliveryBackend(deliveryId: string): {
  readonly backend: ExecutionBackend;
  readonly mutations: () => readonly ExecutionMutation[];
} {
  const calls: ExecutionMutation[] = [];
  const backend: ExecutionBackend = {
    query: (input: ExecutionQuery): Promise<ExecutionQueryResult> => {
      if (input.operation === 'delivery-read') {
        return Promise.resolve({
          kind: 'accepted',
          value: {
            delivery: { deliveryId, runId: 'run-recovery' },
            messages: [],
            timedOut: false,
            cancelled: false,
          },
        });
      }
      return Promise.resolve({ kind: 'rejected', code: 'unregistered_fake_query', message: 'fake 未登记该查询' });
    },
    mutate: (input: ExecutionMutation, scope: ExecutionScope): Promise<OperationOutcome<unknown>> => {
      calls.push(input);
      return Promise.resolve({
        kind: 'accepted',
        operation: { operationId: scope.operationId, target: scope.target },
        value: input.operation === 'delivery-ack' ? { acknowledged: true } : { ok: true },
      });
    },
  };
  return { backend, mutations: () => calls };
}

function currentRevision(created: RecoveryHarness): number {
  const scope = created.store.query({ kind: 'scope', coordinationScopeId: RECOVERY_SCOPE });
  if (scope.kind !== 'scope' || scope.scope === null) {
    throw new Error('Scope 不存在');
  }
  return scope.scope.revision;
}

function settlementCount(created: RecoveryHarness): number {
  const rows = created.store.query({ kind: 'delivery-settlements', coordinationScopeId: RECOVERY_SCOPE });
  return rows.kind === 'delivery-settlements' ? rows.settlements.length : 0;
}

/**
 * 把一条自报**原 Dispatch** 的迟到结果交给正常 Delivery pipeline 结算。
 *
 * 这是端到端路径：`settleDelivery` 读取 → `verifyWorkerResult` 核验 → 只补历史。
 */
async function settleLateResult(
  created: RecoveryHarness,
  currentDispatchId: string,
): Promise<{
  readonly result: Awaited<ReturnType<typeof settleDelivery>>;
  readonly mutations: () => readonly ExecutionMutation[];
}> {
  const claimed: ClaimedResultAttribution = {
    runId: 'run-recovery',
    consumerGeneration: 1,
    graphGeneration: 1,
    authorizationId: RECOVERY_AUTHORIZATION,
    workerTaskId: RECOVERY_WORKER_TASK,
    // 迟到结果自报的是被取代的原 Dispatch 与原 Attempt。
    dispatchId: SOURCE_DISPATCH,
    attemptId: ATTEMPT,
    role: 'validator',
    specBinding: SPEC_BINDING,
    worktreeId: 'worktree-recovery-1',
  };
  const trusted: TrustedExecutionFacts = {
    runId: 'run-recovery',
    consumerGeneration: 1,
    graphGeneration: 1,
    authorizationId: RECOVERY_AUTHORIZATION,
    workerTaskId: RECOVERY_WORKER_TASK,
    dispatchId: currentDispatchId as DispatchId,
    attemptId: ATTEMPT,
    role: 'validator',
    specBinding: SPEC_BINDING,
    worktreeId: 'worktree-recovery-1',
    authority: AUTHORITY,
    scopeEnvelope: { include: ['src'], exclude: [] },
    changedPaths: [],
  };
  const { backend, mutations } = fakeDeliveryBackend('delivery-late-1');
  const input: SettleDeliveryInput = {
    store: created.store,
    backend,
    coordinationScopeId: RECOVERY_SCOPE,
    writer: created.writer,
    expectedRevision: currentRevision(created),
    backendIdentityRef: 'backend-identity-recovery',
    graphGeneration: 1,
    authorizationId: RECOVERY_AUTHORIZATION,
    runId: 'run-recovery',
    consumerGeneration: 1,
    timeoutMs: 5_000,
    orcaTaskId: ORCA_TASK,
    delivery: { deliveryId: 'delivery-late-1', claimed, acceptedResult: { summary: '迟到的完成结果' } },
    trusted,
    operationIds: {
      acceptResult: 'op-accept-late' as OperationId,
      ack: 'op-ack-late' as OperationId,
    },
  };
  const result = await settleDelivery(input);
  return { result, mutations };
}

test(
  '[gate.alternate-session-new-dispatch-only] 替代 Session 只新建 Dispatch / Binding / Segment，原 Segment 的迟到结果只能入历史',
  async () => {
    harness = createRecoveryHarness({ maxRecoveriesPerWorkerAttempt: 1 });
    setup(harness);

    const created = await recoverWorkerSession(recoveryInput(harness));
    expect(created.kind).toBe('alternate_created');
    if (created.kind !== 'alternate_created') {
      return;
    }
    const row = harness.recovery(created.recoveryId);

    // 原 Dispatch / Binding / Segment 一个都没有被复用。
    expect(row?.replacementDispatchId).not.toBe(SOURCE_DISPATCH);
    expect(row?.replacementSessionBindingId).not.toBe(SOURCE_BINDING);
    expect(row?.replacementSegmentId).not.toBe(SOURCE_SEGMENT);
    // 只有一次替代派发：没有「复用原 Dispatch 再派一次」的第二条副作用。
    expect(workerStarts(harness)).toBe(1);

    // 原 Segment 仍是原绑定；替代 Segment 用的是新的绑定与新的 Dispatch。
    const sourceSegment = harness.segments().find((segment) => segment.segmentId === SOURCE_SEGMENT);
    expect(sourceSegment?.sessionBindingId).toBe(SOURCE_BINDING);
    expect(sourceSegment?.dispatchId).toBe(SOURCE_DISPATCH);
    const replacementSegment = harness.segments().find(
      (segment) => segment.segmentId === row?.replacementSegmentId,
    );
    expect(replacementSegment?.sessionBindingId).toBe(row?.replacementSessionBindingId);
    expect(replacementSegment?.dispatchId).toBe(row?.replacementDispatchId);
    // 替代 Segment 沿用一个业务 Attempt。
    expect(replacementSegment?.attemptId).toBe(ATTEMPT);

    // 原 Segment 的迟到结果走正常 Delivery：按 Dispatch 身份被判为已被取代的尝试，只补历史。
    const late = await settleLateResult(harness, row?.replacementDispatchId ?? '');
    expect(late.result.kind).toBe('history_only');
    if (late.result.kind === 'history_only') {
      expect(late.result.verification.kind).toBe('stale_attempt');
      if (late.result.verification.kind === 'stale_attempt') {
        expect(late.result.verification.mismatches).toContain('dispatchId');
      }
    }
    // 只确认该 Delivery（ack），绝不写结果引用，也没有结算记录。
    expect(late.mutations().map((mutation) => mutation.operation)).toEqual(['delivery-ack']);
    expect(settlementCount(harness)).toBe(0);

    // 迟到结果零写入：记录不变，也不能重启这条已经终结的 Recovery。
    const before = harness.recovery(created.recoveryId);
    const again = await recoverWorkerSession(recoveryInput(harness));
    expect(again.kind).toBe('already_concluded');
    expect(harness.recovery(created.recoveryId)).toEqual(before);
    expect(workerStarts(harness)).toBe(1);
    expect(harness.segments()).toHaveLength(2);
  },
);

test('superseded 原 Segment 的迟到结果只入历史：不改变当前 Attempt、不新建 Recovery、不新增派发', async () => {
  harness = createRecoveryHarness({ maxRecoveriesPerWorkerAttempt: 1 });
  setup(harness);

  const concluded = await recoverWorkerSession(
    recoveryInput(harness, { sourceTerminal: { kind: 'reached', terminalReceiptRef: 'receipt:source-terminal' } }),
  );
  expect(concluded.kind).toBe('source_completed');
  if (concluded.kind !== 'source_completed') {
    return;
  }
  const row = harness.recovery(concluded.recoveryId);
  // supersede 是持久化事实：原 Segment 被显式标记，且没有产生替代派发。
  expect(row?.supersededSegmentId).toBe(SOURCE_SEGMENT);
  expect(row?.consumedBudget).toBe(0);
  expect(harness.backend.mutations()).toEqual([]);

  // 迟到的完成结果不能重新激活已经终结的 Recovery，也不能新建第二条 Recovery。
  const late = await recoverWorkerSession(
    recoveryInput(harness, { sourceTerminal: { kind: 'reached', terminalReceiptRef: 'receipt:late' } }),
  );
  expect(late.kind).toBe('already_concluded');
  expect(harness.recoveries()).toHaveLength(1);
  expect(harness.segments()).toHaveLength(1);
  expect(harness.backend.mutations()).toEqual([]);
  // 终态与 supersede 事实都没有被迟到结果改写。
  expect(harness.recovery(concluded.recoveryId)?.terminalOutcome).toBe('source_completed');
  expect(harness.recovery(concluded.recoveryId)?.supersededSegmentId).toBe(SOURCE_SEGMENT);
  // 迟到结果没有写入任何结算记录，也没有推进任何 Worker Attempt 事实。
  expect(settlementCount(harness)).toBe(0);
});

test('已终结的 Recovery 不接受迟到的结论：终态不可改写', async () => {
  harness = createRecoveryHarness({ maxRecoveriesPerWorkerAttempt: 1 });
  setup(harness);

  const concluded = await recoverWorkerSession(
    recoveryInput(harness, { sourceTerminal: { kind: 'reached', terminalReceiptRef: 'receipt:source-terminal' } }),
  );
  expect(concluded.kind).toBe('source_completed');
  if (concluded.kind !== 'source_completed') {
    return;
  }
  const before = harness.recovery(concluded.recoveryId);

  const late = concludeWorkerSessionRecovery({
    store: harness.store,
    writer: harness.writer,
    coordinationScopeId: RECOVERY_SCOPE,
    recoveryId: concluded.recoveryId,
    outcome: { kind: 'failed', reason: '迟到的失败结论' },
  });

  expect(late.kind).toBe('rejected');
  if (late.kind === 'rejected') {
    expect(late.code).toBe('already_concluded');
  }
  expect(harness.recovery(concluded.recoveryId)).toEqual(before);
  expect(harness.backend.mutations()).toEqual([]);
});
