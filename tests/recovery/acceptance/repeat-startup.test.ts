/**
 * 6.3 验收层：同一 Scope 连续两次启动
 * （change: `m1-recover-execution`；spec `recovery/controller-reconciliation` 与
 * `coordination/scope-control` 的启动/重启路径）。
 *
 * 这里补的是**重复启动**这一维度，而不是把既有启动单测抄一遍：
 *
 * - 未决 intent 的 `OperationId` 与 backend request 引用在第二次启动时原样复用：不新建 intent、不换
 *   ID 重试（限定审计标签 `gate.no-new-operation-id-on-unknown`）；两次启动都不派发。
 * - 未完成的 Recovery 在第二次启动时仍命中**同一 RecoveryId**：不新建 Recovery、不重复消耗额度、
 *   不重复派发；已提交的 Wake Batch 也不会被再次注入会话历史。
 *
 * 「单次启动的固定顺序」「对账未决时 lane 阻塞且以原 OperationId 可观测」「单条 Recovery 续办失败只
 * 阻塞自己的 lane」已由 `tests/bootstrap/startup-reconciliation.test.ts` 覆盖；
 * 「同一 WakeBatchId 不被重复写入」的单元级断言已由 `tests/application/wake-admission.test.ts` 与
 * `tests/domain/coordinator-session-state.test.ts` 覆盖，这里只断言「启动不额外注入」。
 */

import { afterEach, expect, test } from 'vitest';

import { beginIntent, settleIntent } from '../../../src/application/coordination/intent-service.js';
import type {
  DispatchId,
  OperationId,
  RecoveryId,
  RuntimeIncarnationId,
  SessionSegmentId,
} from '../../../src/application/dto/identity.js';
import { laneKeyOf } from '../../../src/application/dto/operation-intent.js';
import { deriveRecoveryId } from '../../../src/application/recovery/worker-session-recovery-service.js';
import type { BranchCoordinationStore } from '../../../src/application/ports/branch-coordination-store.js';
import type { WakeBatch } from '../../../src/domain/coordinator/session-state.js';
import {
  type CompanionStartupResult,
  type StartedCompanionStartup,
} from '../../../src/bootstrap/startup.js';
import {
  createCompanionStartupFixture,
  type CompanionStartupFixture,
} from '../../support/companion-startup-harness.js';
import { RECOVERY_SCOPE, RECOVERY_SESSION, RECOVERY_WORKER_TASK, RECOVERY_WORK_PACKAGE, type RecoveryHarness } from '../../support/recovery-harness.js';

const STARTUP_ONE = 'inc-startup-1' as RuntimeIncarnationId;
const STARTUP_TWO = 'inc-startup-2' as RuntimeIncarnationId;

let fixture: CompanionStartupFixture | null = null;

afterEach(() => {
  fixture?.close();
  fixture = null;
});

function expectStarted(result: CompanionStartupResult): StartedCompanionStartup {
  if (result.kind !== 'started') {
    throw new Error(`期望启动成功，实际停在 ${result.step}: ${result.code} ${result.message}`);
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

function intentIds(store: BranchCoordinationStore): readonly string[] {
  const read = store.query({ kind: 'intents', coordinationScopeId: RECOVERY_SCOPE });
  if (read.kind !== 'intents') {
    throw new Error('无法读取 Operation Intent');
  }
  return read.intents.map((intent) => intent.operationId).sort();
}

function intentStateOf(store: BranchCoordinationStore, operationId: OperationId): string | null {
  const read = store.query({ kind: 'intent', coordinationScopeId: RECOVERY_SCOPE, operationId });
  return read.kind === 'intent' ? (read.intent?.state ?? null) : null;
}

/** 查询从 `fromIndex` 起新产生的 `request-show` 引用；用于比较两次启动用的是不是同一组 ID。 */
function requestShowIds(harness: RecoveryHarness, fromIndex: number): readonly string[] {
  const ids: string[] = [];
  for (const call of harness.backend.calls.slice(fromIndex)) {
    if (call.kind === 'query' && call.operation.operation === 'request-show') {
      ids.push(call.operation.requestId);
    }
  }
  return ids;
}

function workerStarts(harness: RecoveryHarness): number {
  return harness.backend.mutations().filter((mutation) => mutation.operation === 'worker-start').length;
}

/** 登记一条「已发出 mutation、结果未知」的 intent：保持 pending 且带 backend request 引用。 */
function beginUnresolvedIntent(
  harness: RecoveryHarness,
  operationId: OperationId,
  targetId: string,
  backendRequestId: string,
): void {
  const target = { kind: 'task', id: targetId };
  const begun = beginIntent(harness.store, {
    coordinationScopeId: RECOVERY_SCOPE,
    operationId,
    target,
    operationCategory: 'task',
    writer: harness.writer,
    expectedRevision: scopeRevision(harness.store),
  });
  if (begun.kind !== 'registered') {
    throw new Error(`无法登记未决 intent ${operationId}: ${begun.kind}`);
  }
  const retained = settleIntent(harness.store, {
    coordinationScopeId: RECOVERY_SCOPE,
    operationId,
    writer: harness.writer,
    expectedRevision: scopeRevision(harness.store),
    outcome: {
      kind: 'unknown',
      operation: { operationId, backendRequestId, target },
      reason: 'response_lost',
    },
  });
  if (retained.kind !== 'retained') {
    throw new Error(`未决 intent ${operationId} 未能保持 pending: ${retained.kind}`);
  }
}

function seedBatch(): WakeBatch {
  return {
    wakeBatchId: 'wake-seeded-1',
    coordinationScopeId: RECOVERY_SCOPE,
    coordinatorSessionId: RECOVERY_SESSION,
    sourceRevisions: [{ sourceKind: 'delivery', sourceId: 'delivery-1', revision: 1 }],
    actionableWork: [
      { workKind: 'worker_result', workId: 'wake-seeded-1', summary: '已提交的唤醒批次' },
    ],
  };
}

test(
  '[gate.no-new-operation-id-on-unknown] 同一 Scope 连续两次启动：以原 OperationId 重新对账未决 intent，不新建 intent、不换 ID',
  async () => {
    fixture = createCompanionStartupFixture();
    const harness = fixture.harness;
    const laneA = 'op-lane-a-original' as OperationId;
    const laneB = 'op-lane-b-original' as OperationId;
    beginUnresolvedIntent(harness, laneA, 'orca-task-a', 'request-lane-a');
    beginUnresolvedIntent(harness, laneB, 'orca-task-b', 'request-lane-b');
    const laneAKey = laneKeyOf({ kind: 'task', id: 'orca-task-a' }, 'task');
    const cleanLaneKey = laneKeyOf({ kind: 'task', id: 'orca-task-clean' }, 'task');

    const first = expectStarted(await fixture.start(STARTUP_ONE));
    const intentsAfterFirst = intentIds(harness.store);
    const firstQueries = requestShowIds(harness, 0);

    // 第一次启动：两个未决 intent 都以原 requestId 对账，结论是未决并阻塞各自的 lane。
    expect(intentStateOf(harness.store, laneA)).toBe('blocked');
    expect(intentStateOf(harness.store, laneB)).toBe('blocked');
    expect(firstQueries).toEqual(expect.arrayContaining(['request-lane-a', 'request-lane-b']));
    expect(first.readiness.mayUseLane(laneAKey)).toBe(false);
    expect(first.readiness.mayUseLane(cleanLaneKey)).toBe(true);
    first.close();

    const callsBeforeSecond = harness.backend.calls.length;
    const second = expectStarted(await fixture.start(STARTUP_TWO));
    const secondQueries = requestShowIds(harness, callsBeforeSecond);

    // 第二次启动：仍以**同一组** backend request 引用重新对账，没有换 ID。
    expect(secondQueries).toEqual(firstQueries);
    expect(secondQueries).toEqual(expect.arrayContaining(['request-lane-a', 'request-lane-b']));
    // intent 集合逐字不变：没有为了「重试」新增第二行。
    expect(intentIds(harness.store)).toEqual(intentsAfterFirst);
    expect(intentStateOf(harness.store, laneA)).toBe('blocked');
    expect(intentStateOf(harness.store, laneB)).toBe('blocked');
    // 两次启动都不派发：对账与续办没有越过放行判定。
    expect(workerStarts(harness)).toBe(0);
    expect(second.readiness.mayUseLane(laneAKey)).toBe(false);
    expect(second.readiness.mayUseLane(cleanLaneKey)).toBe(true);
    expect(second.blockers.map((blocker) => blocker.laneKey)).toEqual(
      expect.arrayContaining([laneAKey, laneKeyOf({ kind: 'task', id: 'orca-task-b' }, 'task')]),
    );
  },
);

test('同一 Scope 连续两次启动以同一 RecoveryId 续办未完成的 Recovery，且不重复注入 Wake Batch', async () => {
  fixture = createCompanionStartupFixture({ wakeBatches: [seedBatch()] });
  const harness = fixture.harness;
  const segmentId = 'segment-source-1' as SessionSegmentId;
  const sourceDispatchId = 'dispatch-source-1' as DispatchId;
  harness.recordSourceSegment({
    segmentId,
    dispatchId: sourceDispatchId,
    attemptId: 'attempt-1',
    sessionBindingId: 'binding-source-1',
    role: 'validator',
    lastTranscriptRef: 'transcript:source-1',
  });
  const recoveryId = deriveRecoveryId(RECOVERY_SCOPE, segmentId);
  const recorded = harness.store.transact({
    kind: 'record-recovery',
    coordinationScopeId: RECOVERY_SCOPE,
    expectedRevision: scopeRevision(harness.store),
    writer: harness.writer,
    recoveryId,
    role: 'validator',
    workPackageId: RECOVERY_WORK_PACKAGE,
    workerTaskId: RECOVERY_WORKER_TASK,
    businessAttemptId: 'attempt-1',
    sourceSegmentId: segmentId,
    sourceDispatchId,
  });
  if (recorded.kind === 'rejected') {
    throw new Error(`无法登记 Recovery: ${recorded.message}`);
  }

  const first = expectStarted(await fixture.start(STARTUP_ONE));
  expect(first.recoveries.map((entry) => entry.recoveryId)).toEqual([recoveryId]);
  expect(first.recoveries[0]?.result.kind).toBe('exact_recovery');
  expect(first.recoveries[0]?.previousStatus).toBe('pending');
  first.close();

  const second = expectStarted(await fixture.start(STARTUP_TWO));

  // 第二次启动命中的还是同一条 Recovery：不新建、不重复消耗额度、不重复派发。
  expect(second.recoveries.map((entry) => entry.recoveryId)).toEqual([recoveryId]);
  expect(second.recoveries[0]?.result.kind).toBe('exact_recovery');
  const rows: readonly { readonly recoveryId: RecoveryId }[] = harness.recoveries();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.recoveryId).toBe(recoveryId);
  expect(harness.recovery(recoveryId)?.consumedBudget).toBe(0);
  expect(harness.segments()).toHaveLength(1);
  expect(workerStarts(harness)).toBe(0);

  // Wake Batch：两次启动之后会话历史里仍然只有那一条已提交的批次，没有被再次注入。
  expect(fixture.sessionState().wakeBatchIds).toEqual([seedBatch().wakeBatchId]);
  expect(second.recoveries[0]?.dispatchLaneKey).toBe(
    laneKeyOf({ kind: 'worker-task', id: RECOVERY_WORKER_TASK }, 'worker-dispatch'),
  );
});
