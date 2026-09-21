/**
 * IP-1 / IP-2 恢复期对账测试（change: `m1-recover-execution`）。
 *
 * 覆盖 Requirement「启动对账必须以原 OperationId 得出三值结论」与「mutation lane 阻塞必须可观测且
 * 可解除」的关键行为：先对账再决定、`absent` 判为未决（不是已拒绝）、同一 OperationId 被复用、
 * 未决时 lane 持久化阻塞且原因可读、重复对账稳定、stale revision 重读后只重试一次，
 * 以及 `rejected` 只能来自调用方显式给出的已证实事实。
 *
 * 全部通过 fake backend 验证：这些本就是故障与恢复路径，与 process-delivery.test.ts 使用同一套
 * `openCoordinationStore` + 临时目录装置。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { openCoordinationStore, type CoordinationStore } from '../../src/adapters/storage/coordination-store.js';
import { beginIntent, blockLane, settleIntent } from '../../src/application/coordination/intent-service.js';
import { acquireRuntimeLease } from '../../src/application/coordination/lease-service.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  EntityRef,
  OperationId,
  PlanningCycleId,
  RuntimeIncarnationId,
} from '../../src/application/dto/identity.js';
import { type OperationIntent } from '../../src/application/dto/operation-intent.js';
import type { ExecutionQueryResult, OperationOutcome } from '../../src/application/dto/operation-outcome.js';
import { initializeCoordinationScope } from '../../src/application/planning/initialize-scope.js';
import type { CoordinationWriter } from '../../src/application/ports/branch-coordination-store.js';
import type {
  ExecutionBackend,
  ExecutionMutation,
  ExecutionQuery,
} from '../../src/application/ports/execution-backend.js';
import { reconcileOperations } from '../../src/application/reconciliation/reconcile-operations.js';
import {
  concludeFromProvenNoSideEffect,
  concludeReconciliation,
  decideLaneUnblock,
} from '../../src/domain/recovery/operation-intent.js';

const SCOPE = 'scope-1' as CoordinationScopeId;
const SESSION_A = 'session-a' as CoordinatorSessionId;
const CYCLE = 'cycle-1' as PlanningCycleId;
const INCARNATION = 'inc-a' as RuntimeIncarnationId;

const TASK_TARGET: EntityRef<string> = { kind: 'task', id: 'task-1' };

let directory = '';
let store: CoordinationStore;
let writer: CoordinationWriter;
let now = 1_000;

const clock = (): number => now;

function revision(): number {
  const scope = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  if (scope.kind !== 'scope' || scope.scope === null) {
    throw new Error('Scope 不存在');
  }
  return scope.scope.revision;
}

function intents(): readonly OperationIntent[] {
  const result = store.query({ kind: 'intents', coordinationScopeId: SCOPE });
  if (result.kind !== 'intents') {
    throw new Error('无法读取意图');
  }
  return result.intents;
}

function intentOf(operationId: OperationId): OperationIntent | null {
  const result = store.query({ kind: 'intent', coordinationScopeId: SCOPE, operationId });
  if (result.kind !== 'intent') {
    throw new Error('无法读取单条意图');
  }
  return result.intent;
}

/** 登记一条未决意图；给出 requestId 时补记 backend request 引用（仍是 pending）。 */
function begin(
  operationId: OperationId,
  target: EntityRef<string> = TASK_TARGET,
  backendRequestId?: string,
): OperationIntent {
  const begun = beginIntent(store, {
    coordinationScopeId: SCOPE,
    operationId,
    target,
    operationCategory: target.kind,
    writer,
    expectedRevision: revision(),
  });
  if (begun.kind !== 'registered') {
    throw new Error(`无法登记意图：${begun.kind}`);
  }
  if (backendRequestId !== undefined) {
    const retained = settleIntent(store, {
      coordinationScopeId: SCOPE,
      operationId,
      writer,
      expectedRevision: revision(),
      outcome: {
        kind: 'unknown',
        operation: { operationId, backendRequestId, target },
        reason: 'response_lost',
      },
    });
    if (retained.kind !== 'retained') {
      throw new Error(`无法补记 backend request 引用：${retained.kind}`);
    }
  }
  const intent = intentOf(operationId);
  if (intent === null) {
    throw new Error('意图登记后读不回来');
  }
  return intent;
}

function blockRecordedIntent(operationId: OperationId, reason = '此前对账未决'): OperationIntent {
  const blocked = blockLane(store, {
    coordinationScopeId: SCOPE,
    operationId,
    writer,
    expectedRevision: revision(),
    reason,
  });
  if (blocked.kind !== 'settled') {
    throw new Error(`无法阻塞意图：${blocked.kind}`);
  }
  const intent = intentOf(operationId);
  if (intent === null) {
    throw new Error('阻塞后读不回意图');
  }
  return intent;
}

type Recording = {
  readonly backend: ExecutionBackend;
  readonly queries: readonly ExecutionQuery[];
  readonly mutations: readonly ExecutionMutation[];
};

/** 记录型 fake backend：只登记 `request-show`，任何 mutation 都被记录并拒绝。 */
function fakeBackend(script: {
  readonly requestShow?: (requestId: string) => ExecutionQueryResult;
}): Recording {
  const queries: ExecutionQuery[] = [];
  const mutations: ExecutionMutation[] = [];
  const backend: ExecutionBackend = {
    query: (input: ExecutionQuery): Promise<ExecutionQueryResult> => {
      queries.push(input);
      if (input.operation === 'request-show' && script.requestShow !== undefined) {
        return Promise.resolve(script.requestShow(input.requestId));
      }
      return Promise.resolve({ kind: 'rejected', code: 'unregistered_fake_query', message: 'fake 未登记该查询' });
    },
    mutate: (input: ExecutionMutation): Promise<OperationOutcome<unknown>> => {
      mutations.push(input);
      return Promise.resolve({ kind: 'rejected', code: 'unexpected_mutation', message: '对账不得发起 mutation' });
    },
  };
  return { backend, queries, mutations };
}

function requestShowCalls(recording: Recording, requestId: string): readonly ExecutionQuery[] {
  return recording.queries.filter(
    (query) => query.operation === 'request-show' && query.requestId === requestId,
  );
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-reconcile-'));
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
  });
  if (initialized.kind !== 'initialized') {
    throw new Error('无法创建测试 Scope');
  }
  const acquired = acquireRuntimeLease(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: INCARNATION,
    fencingGeneration: 0,
  });
  if (acquired.kind !== 'acquired') {
    throw new Error('无法取得 Runtime Lease');
  }
  writer = {
    coordinatorSessionId: SESSION_A,
    runtimeIncarnationId: INCARNATION,
    fencingGeneration: acquired.lease.fencingGeneration,
  };
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test('收据为 completed 时按已接受收尾，且不发起任何 mutation', async () => {
  const operationId = 'op-accepted' as OperationId;
  begin(operationId, TASK_TARGET, 'req-ok');
  const recording = fakeBackend({
    requestShow: (requestId) => ({
      kind: 'accepted',
      value: { requestId, state: 'completed', interpretation: 'request recorded' },
    }),
  });

  const result = await reconcileOperations({
    store,
    backend: recording.backend,
    coordinationScopeId: SCOPE,
    writer,
    expectedRevision: revision(),
    clock,
  });

  expect(result.kind).toBe('reconciled');
  if (result.kind !== 'reconciled') {
    return;
  }
  expect(result.operations).toHaveLength(1);
  expect(result.operations[0]?.conclusion).toEqual({
    kind: 'accepted',
    operationId,
    statement: 'request recorded',
  });
  expect(result.operations[0]?.storeChanged).toBe(true);
  expect(result.unresolved).toHaveLength(0);
  expect(result.unresolvedLaneKeys).toEqual([]);

  const intent = intentOf(operationId);
  expect(intent?.state).toBe('settled');
  expect(intent?.outcomeClass).toBe('accepted');

  // 对账只读：只用原 requestId 查询一次，且没有任何 mutation。
  expect(requestShowCalls(recording, 'req-ok')).toHaveLength(1);
  expect(recording.mutations).toHaveLength(0);
});

test('absent 判为未决：lane 持久化阻塞且原因可读，绝不换 OperationId', async () => {
  const operationId = 'op-absent' as OperationId;
  const started = begin(operationId, TASK_TARGET, 'req-absent');
  const recording = fakeBackend({
    requestShow: (requestId) => ({
      kind: 'accepted',
      value: { requestId, state: 'absent', interpretation: 'absent 不代表未发生' },
    }),
  });

  const result = await reconcileOperations({
    store,
    backend: recording.backend,
    coordinationScopeId: SCOPE,
    writer,
    expectedRevision: revision(),
    clock,
  });

  expect(result.kind).toBe('reconciled');
  if (result.kind !== 'reconciled') {
    return;
  }
  expect(result.operations[0]?.conclusion).toEqual({
    kind: 'unknown',
    operationId,
    reason: 'absent',
  });
  expect(result.operations[0]?.storeChanged).toBe(true);
  expect(result.unresolved.map((intent) => intent.operationId)).toEqual([operationId]);
  expect(result.unresolvedLaneKeys).toEqual([started.laneKey]);

  const intent = intentOf(operationId);
  expect(intent?.state).toBe('blocked');
  expect(intent?.blockingReason).toBeTruthy();
  // 原 OperationId 与 backend request 引用都不变，也没有第二条 intent。
  expect(intent?.operationId).toBe(operationId);
  expect(intent?.backendRequestId).toBe('req-absent');
  expect(intents()).toHaveLength(1);
  expect(requestShowCalls(recording, 'req-absent')).toHaveLength(1);
  expect(recording.mutations).toHaveLength(0);
});

test('响应丢失但动作已落地：阻塞中的意图以同一 OperationId 收尾为已接受', async () => {
  const operationId = 'op-lost-response' as OperationId;
  begin(operationId, TASK_TARGET, 'req-lost');
  const blocked = blockRecordedIntent(operationId, '响应丢失');
  expect(blocked.state).toBe('blocked');
  const recording = fakeBackend({
    requestShow: (requestId) => ({
      kind: 'accepted',
      value: { requestId, state: 'completed', interpretation: 'request recorded' },
    }),
  });

  const result = await reconcileOperations({
    store,
    backend: recording.backend,
    coordinationScopeId: SCOPE,
    writer,
    expectedRevision: revision(),
    clock,
  });

  expect(result.kind === 'reconciled' && result.operations[0]?.previousState).toBe('blocked');
  expect(result.kind === 'reconciled' && result.operations[0]?.conclusion.kind).toBe('accepted');
  const intent = intentOf(operationId);
  expect(intent?.state).toBe('settled');
  expect(intent?.outcomeClass).toBe('accepted');
  expect(intent?.operationId).toBe(operationId);
  expect(requestShowCalls(recording, 'req-lost')).toHaveLength(1);
});

test('pending 仍是未决：阻塞该 lane', async () => {
  const operationId = 'op-pending' as OperationId;
  const started = begin(operationId, TASK_TARGET, 'req-pending');
  const recording = fakeBackend({
    requestShow: (requestId) => ({
      kind: 'accepted',
      value: { requestId, state: 'pending', interpretation: 'still running' },
    }),
  });

  const result = await reconcileOperations({
    store,
    backend: recording.backend,
    coordinationScopeId: SCOPE,
    writer,
    expectedRevision: revision(),
    clock,
  });

  expect(result.kind === 'reconciled' && result.operations[0]?.conclusion).toEqual({
    kind: 'unknown',
    operationId,
    reason: 'pending',
  });
  const intent = intentOf(operationId);
  expect(intent?.state).toBe('blocked');
  expect(intent?.laneKey).toBe(started.laneKey);
  expect(intent?.blockingReason).toBeTruthy();
});

test('没有 backend request id 时不发查询，直接保持未决', async () => {
  const operationId = 'op-no-request' as OperationId;
  begin(operationId, TASK_TARGET);
  const recording = fakeBackend({});

  const result = await reconcileOperations({
    store,
    backend: recording.backend,
    coordinationScopeId: SCOPE,
    writer,
    expectedRevision: revision(),
    clock,
  });

  expect(result.kind === 'reconciled' && result.operations[0]?.conclusion).toEqual({
    kind: 'unknown',
    operationId,
    reason: 'no_backend_request_id',
  });
  expect(recording.queries).toHaveLength(0);
  expect(intentOf(operationId)?.state).toBe('blocked');
  expect(intentOf(operationId)?.blockingReason).toBeTruthy();
});

test('重复对账结果稳定：已阻塞的意图不再产生第二次写入', async () => {
  const operationId = 'op-repeat' as OperationId;
  begin(operationId, TASK_TARGET, 'req-repeat');
  const recording = fakeBackend({
    requestShow: (requestId) => ({
      kind: 'accepted',
      value: { requestId, state: 'absent', interpretation: 'not proof' },
    }),
  });

  const first = await reconcileOperations({
    store,
    backend: recording.backend,
    coordinationScopeId: SCOPE,
    writer,
    expectedRevision: revision(),
    clock,
  });
  const revisionAfterFirst = revision();
  const second = await reconcileOperations({
    store,
    backend: recording.backend,
    coordinationScopeId: SCOPE,
    writer,
    expectedRevision: revision(),
    clock,
  });

  expect(first.kind === 'reconciled' && first.operations[0]?.storeChanged).toBe(true);
  expect(second.kind === 'reconciled' && second.operations[0]?.conclusion.kind).toBe('unknown');
  expect(second.kind === 'reconciled' && second.operations[0]?.storeChanged).toBe(false);
  expect(revision()).toBe(revisionAfterFirst);
  expect(intents()).toHaveLength(1);
  expect(intentOf(operationId)?.state).toBe('blocked');
  // 每次对账都用原 requestId 做只读查询，不会换 ID。
  expect(requestShowCalls(recording, 'req-repeat')).toHaveLength(2);
});

test('stale revision 时重读后只重试一次，且仍使用原 OperationId', async () => {
  const operationId = 'op-stale' as OperationId;
  begin(operationId, TASK_TARGET, 'req-stale');
  const recording = fakeBackend({
    requestShow: (requestId) => ({
      kind: 'accepted',
      value: { requestId, state: 'absent', interpretation: 'not proof' },
    }),
  });

  const result = await reconcileOperations({
    store,
    backend: recording.backend,
    coordinationScopeId: SCOPE,
    writer,
    expectedRevision: revision() - 1,
    clock,
  });

  expect(result.kind === 'reconciled' && result.operations[0]?.storeChanged).toBe(true);
  expect(result.kind === 'reconciled' && result.operations[0]?.rejection).toBeNull();
  const intent = intentOf(operationId);
  expect(intent?.state).toBe('blocked');
  expect(intent?.operationId).toBe(operationId);
  expect(requestShowCalls(recording, 'req-stale')).toHaveLength(1);
});

test('已证实的未产生副作用事实才产出 rejected，且优先于只读查询', async () => {
  const operationId = 'op-proven' as OperationId;
  begin(operationId, TASK_TARGET, 'req-maybe');
  const recording = fakeBackend({});

  const result = await reconcileOperations({
    store,
    backend: recording.backend,
    coordinationScopeId: SCOPE,
    writer,
    expectedRevision: revision(),
    clock,
    provenNoSideEffect: [{ operationId, code: 'never_sent', message: '请求在离开 transport 前失败' }],
  });

  expect(result.kind === 'reconciled' && result.operations[0]?.conclusion).toEqual({
    kind: 'rejected',
    operationId,
    code: 'never_sent',
    message: '请求在离开 transport 前失败',
  });
  expect(recording.queries).toHaveLength(0);
  const intent = intentOf(operationId);
  expect(intent?.state).toBe('settled');
  expect(intent?.outcomeClass).toBe('rejected');
});

test('自动对账路径永远不会产出 rejected', () => {
  const intent = begin('op-domain' as OperationId, TASK_TARGET, 'req-domain');
  for (const state of ['pending', 'absent'] as const) {
    const conclusion = concludeReconciliation(intent, {
      kind: 'blocked',
      operation: { operationId: intent.operationId, backendRequestId: 'req-domain', target: TASK_TARGET },
      reason: state,
    });
    expect(conclusion.kind).toBe('unknown');
  }
  // 只有显式事实才成立 rejected；事实的 OperationId 必须匹配。
  const matched = concludeFromProvenNoSideEffect(intent, {
    operationId: intent.operationId,
    code: 'never_sent',
    message: 'proof',
  });
  expect(matched.kind).toBe('rejected');
  const mismatched = concludeFromProvenNoSideEffect(intent, {
    operationId: 'op-other' as OperationId,
    code: 'never_sent',
    message: 'proof',
  });
  expect(mismatched.kind).toBe('unknown');
});

test('解除 lane 阻塞要求确定结论并重新校验 scope、ownership、revision 与预算', () => {
  const accepted = { kind: 'accepted', operationId: 'op-1' as OperationId, statement: 'recorded' } as const;
  expect(
    decideLaneUnblock(accepted, {
      scopeMatches: true,
      ownershipValid: true,
      revisionMatches: true,
      budgetAvailable: true,
    }),
  ).toEqual({ kind: 'clearable' });

  const undecided = decideLaneUnblock(
    { kind: 'unknown', operationId: 'op-1' as OperationId, reason: 'absent' },
    { scopeMatches: false, ownershipValid: false, revisionMatches: false, budgetAvailable: false },
  );
  expect(undecided).toEqual({
    kind: 'remains_blocked',
    reasons: ['inconclusive', 'scope_mismatch', 'ownership_invalid', 'stale_revision', 'budget_exhausted'],
  });
});
