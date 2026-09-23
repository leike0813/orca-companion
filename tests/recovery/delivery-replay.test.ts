/**
 * IP-4 启动 Delivery 重放测试（change: `m1-recover-execution`）。
 *
 * 覆盖 Requirement「启动重放必须复用既有 Delivery pipeline」的三个 Scenario：启动时重放有效
 * Delivery、pipeline 返回 unknown 时保持未确认并阻塞 lane（沿用原 OperationId）、旧代际迟到消息只补
 * 历史。关键断言：只有前驱 `settleDelivery` 被调用（用注入的 spy 计数，确认没有第二套结算路径）、
 * 重放沿用 store 中已持久化的原 OperationId、旧代际不推进生命周期也不消耗共享预算。
 *
 * 装置沿用 `tests/application/process-delivery.test.ts`：`openCoordinationStore` + 临时目录 +
 * fake `ExecutionBackend`。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { openCoordinationStore, type CoordinationStore } from '../../src/adapters/storage/coordination-store.js';
import { beginIntent } from '../../src/application/coordination/intent-service.js';
import { acquireRuntimeLease } from '../../src/application/coordination/lease-service.js';
import {
  acceptResultLaneKey,
  type SettleDeliveryInput,
  type SettleDeliveryResult,
} from '../../src/application/delivery/process-delivery.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  DispatchId,
  OperationId,
  PlanningCycleId,
  RuntimeIncarnationId,
  WorkerTaskId,
} from '../../src/application/dto/identity.js';
import { laneKeyOf } from '../../src/application/dto/operation-intent.js';
import type { ExecutionQueryResult, OperationOutcome } from '../../src/application/dto/operation-outcome.js';
import { initializeCoordinationScope } from '../../src/application/planning/initialize-scope.js';
import type { CoordinationWriter } from '../../src/application/ports/branch-coordination-store.js';
import type {
  ExecutionBackend,
  ExecutionMutation,
  ExecutionQuery,
  ExecutionScope,
} from '../../src/application/ports/execution-backend.js';
import {
  replayDeliveries,
  type PendingDelivery,
  type ReplayDeliveriesInput,
} from '../../src/application/reconciliation/replay-deliveries.js';
import type { RoleAuthorities } from '../../src/domain/planning/execution-authorization.js';
import type { SpecBinding } from '../../src/domain/task-contract.js';
import type {
  ClaimedResultAttribution,
  TrustedExecutionFacts,
  WorkerResultVerification,
} from '../../src/domain/worker-result-verification.js';

const SCOPE = 'scope-1' as CoordinationScopeId;
const SESSION_A = 'session-a' as CoordinatorSessionId;
const CYCLE = 'cycle-1' as PlanningCycleId;
const INCARNATION = 'inc-a' as RuntimeIncarnationId;

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
  contractRevision: 3,
  trackingRevision: 5,
};

const ACCEPTED_RESULT = { summary: '实现完成', evidence: [{ evidenceId: 'ev-1' }] };

const ACCEPTED_VERIFICATION: WorkerResultVerification = {
  kind: 'accepted',
  attribution: {
    runId: 'run-1',
    consumerGeneration: 1,
    workerTaskId: 'orca-task-1' as WorkerTaskId,
    dispatchId: 'orca-task-1-dispatch' as DispatchId,
    attemptId: 'orca-task-1-attempt',
    role: 'implementation',
    changedPaths: ['src/a.ts'],
  },
};

let directory = '';
let store: CoordinationStore;
let writer: CoordinationWriter;

const clock = (): number => 1_000;

function revision(): number {
  const scope = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  if (scope.kind !== 'scope' || scope.scope === null) {
    throw new Error('Scope 不存在');
  }
  return scope.scope.revision;
}

function trustedFor(orcaTaskId: string, overrides: Partial<TrustedExecutionFacts> = {}): TrustedExecutionFacts {
  return {
    runId: 'run-1',
    consumerGeneration: 1,
    graphGeneration: 1,
    authorizationId: 'auth-1',
    workerTaskId: orcaTaskId as WorkerTaskId,
    dispatchId: `${orcaTaskId}-dispatch` as DispatchId,
    attemptId: `${orcaTaskId}-attempt`,
    role: 'implementation',
    specBinding: SPEC,
    worktreeId: 'wt-1',
    authority: AUTHORITY,
    scopeEnvelope: { include: ['src'], exclude: [] },
    changedPaths: ['src/a.ts'],
    ...overrides,
  };
}

function claimedFor(orcaTaskId: string, overrides: Partial<ClaimedResultAttribution> = {}): ClaimedResultAttribution {
  return {
    runId: 'run-1',
    consumerGeneration: 1,
    graphGeneration: 1,
    authorizationId: 'auth-1',
    workerTaskId: orcaTaskId as WorkerTaskId,
    dispatchId: `${orcaTaskId}-dispatch` as DispatchId,
    attemptId: `${orcaTaskId}-attempt`,
    role: 'implementation',
    specBinding: SPEC,
    worktreeId: 'wt-1',
    ...overrides,
  };
}

function pendingDelivery(orcaTaskId: string, deliveryId: string): PendingDelivery {
  return {
    delivery: { deliveryId, claimed: claimedFor(orcaTaskId), acceptedResult: ACCEPTED_RESULT },
    trusted: trustedFor(orcaTaskId),
    orcaTaskId,
    operationIds: {
      acceptResult: `${deliveryId}-accept-candidate` as OperationId,
      ack: `${deliveryId}-ack-candidate` as OperationId,
    },
  };
}

/** 在 accept lane 上预登记一条未决意图，模拟「上次启动已发出 mutation 但结果未知」。 */
function beginAcceptIntent(orcaTaskId: string, operationId: OperationId): void {
  const begun = beginIntent(store, {
    coordinationScopeId: SCOPE,
    operationId,
    target: { kind: 'task', id: orcaTaskId },
    operationCategory: 'task',
    writer,
    expectedRevision: revision(),
  });
  if (begun.kind !== 'registered') {
    throw new Error(`无法登记 accept 意图：${begun.kind}`);
  }
}

function intentState(operationId: OperationId): { readonly state: string; readonly blockingReason: string | null } | null {
  const result = store.query({ kind: 'intent', coordinationScopeId: SCOPE, operationId });
  if (result.kind !== 'intent' || result.intent === null) {
    return null;
  }
  return { state: result.intent.state, blockingReason: result.intent.blockingReason };
}

function settlementCount(): number {
  const result = store.query({ kind: 'delivery-settlements', coordinationScopeId: SCOPE });
  if (result.kind !== 'delivery-settlements') {
    throw new Error('无法读取结算记录');
  }
  return result.settlements.length;
}

function budgetCounters(): readonly unknown[] {
  const result = store.query({ kind: 'budget-counters', coordinationScopeId: SCOPE });
  if (result.kind !== 'budget-counters') {
    throw new Error('无法读取预算计数');
  }
  return result.counters;
}

type BackendScript = {
  readonly deliveryId?: string;
  readonly deliveryRunId?: string | null;
  readonly taskRows?: unknown;
};

/** 记录型 fake backend：delivery-read 返回稳定批次，task-list 返回可回读结果，mutation 默认接受。 */
function fakeBackend(script: BackendScript = {}): {
  readonly backend: ExecutionBackend;
  readonly queries: readonly ExecutionQuery[];
  readonly mutations: readonly ExecutionMutation[];
} {
  const queries: ExecutionQuery[] = [];
  const mutations: ExecutionMutation[] = [];
  const deliveryId = script.deliveryId ?? 'delivery-1';
  const deliveryRunId = script.deliveryRunId === undefined ? 'run-1' : script.deliveryRunId;
  const backend: ExecutionBackend = {
    query: (input: ExecutionQuery): Promise<ExecutionQueryResult> => {
      queries.push(input);
      if (input.operation === 'delivery-read') {
        return Promise.resolve({
          kind: 'accepted',
          value: {
            delivery: { deliveryId, runId: deliveryRunId },
            messages: [],
            timedOut: false,
            cancelled: false,
          },
        });
      }
      if (input.operation === 'task-list') {
        const rows = script.taskRows ?? [
          { id: 'orca-task-1', status: 'completed', result: ACCEPTED_RESULT },
        ];
        return Promise.resolve({ kind: 'accepted', value: rows });
      }
      return Promise.resolve({ kind: 'rejected', code: 'unregistered_fake_query', message: 'fake 未登记该查询' });
    },
    mutate: (input: ExecutionMutation, scope: ExecutionScope): Promise<OperationOutcome<unknown>> => {
      mutations.push(input);
      return Promise.resolve({
        kind: 'accepted',
        operation: { operationId: scope.operationId, target: scope.target },
        value: input.operation === 'delivery-ack' ? { acknowledged: true } : { ok: true },
      });
    },
  };
  return { backend, queries, mutations };
}

/** 注入的 spy：只计数与返回登记结果，不写任何结算记录。 */
function spySettle(results: readonly SettleDeliveryResult[]): {
  readonly calls: readonly SettleDeliveryInput[];
  readonly settle: (input: SettleDeliveryInput) => Promise<SettleDeliveryResult>;
} {
  const calls: SettleDeliveryInput[] = [];
  const settle = (input: SettleDeliveryInput): Promise<SettleDeliveryResult> => {
    calls.push(input);
    const result = results[calls.length - 1];
    if (result === undefined) {
      throw new Error(`spy 收到第 ${calls.length} 次调用但没有登记结果`);
    }
    return Promise.resolve(result);
  };
  return { calls, settle };
}

function replayInput(
  backend: ExecutionBackend,
  pending: readonly PendingDelivery[],
  overrides: Partial<ReplayDeliveriesInput> = {},
): ReplayDeliveriesInput {
  return {
    store,
    backend,
    coordinationScopeId: SCOPE,
    writer,
    backendIdentityRef: 'identity-ref',
    graphGeneration: 1,
    authorizationId: 'auth-1',
    runId: 'run-1',
    consumerGeneration: 1,
    timeoutMs: 5_000,
    pending,
    ...overrides,
  };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-delivery-replay-'));
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
    fullBranchRef: 'refs/heads/main',
    canonicalWorktreePath: '/tmp/orca-test-worktree',
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
  const lease = store.transact({
    kind: 'acquire-execution-lease',
    coordinationScopeId: SCOPE,
    expectedRevision: revision(),
    writer,
  });
  if (lease.kind !== 'committed') {
    throw new Error(`无法取得 Execution Lease: ${lease.message}`);
  }
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test('启动时逐条重放有效 Delivery，且只走既有 pipeline 并沿用原 OperationId', async () => {
  const originalAccept = 'op-accept-original' as OperationId;
  beginAcceptIntent('orca-task-1', originalAccept);
  const pending = [pendingDelivery('orca-task-1', 'delivery-1'), pendingDelivery('orca-task-2', 'delivery-2')];
  const results: readonly SettleDeliveryResult[] = [
    { kind: 'settled', dedupeKey: 'dedupe-1', orcaResultRef: 'orca-task-1#abc', verification: ACCEPTED_VERIFICATION },
    { kind: 'settled', dedupeKey: 'dedupe-2', orcaResultRef: 'orca-task-2#def', verification: ACCEPTED_VERIFICATION },
  ];
  const spy = spySettle(results);

  const result = await replayDeliveries(
    replayInput(fakeBackend().backend, pending, { settle: spy.settle }),
  );

  expect(result.kind).toBe('replayed');
  if (result.kind !== 'replayed') {
    return;
  }
  // 每条未确认 Delivery 恰好一次进入前驱 pipeline，没有第二条结算路径。
  expect(spy.calls).toHaveLength(2);
  expect(result.outcomes.map((outcome) => outcome.kind)).toEqual(['settled', 'settled']);
  expect(result.unconfirmed).toEqual([]);
  expect(result.blockedLaneKeys).toEqual([]);
  // 该 lane 已持久化的原 OperationId 覆盖了调用方传入的候选 ID。
  expect(spy.calls[0]?.operationIds.acceptResult).toBe(originalAccept);
  expect(spy.calls[1]?.operationIds.acceptResult).toBe('delivery-2-accept-candidate');
  // 重放编排自身不写结算记录。
  expect(settlementCount()).toBe(0);
});

test('pipeline 返回 unknown 时保持未确认，以原 OperationId 阻塞 lane 且可重复执行', async () => {
  const originalAccept = 'op-accept-original' as OperationId;
  beginAcceptIntent('orca-task-1', originalAccept);
  const pending = [pendingDelivery('orca-task-1', 'delivery-1')];
  const spy = spySettle([
    { kind: 'unknown', operationId: originalAccept, reason: 'response_lost' },
    { kind: 'unknown', operationId: originalAccept, reason: 'response_lost' },
  ]);
  const input = replayInput(fakeBackend().backend, pending, { settle: spy.settle });

  const first = await replayDeliveries(input);
  const revisionAfterFirst = revision();
  const second = await replayDeliveries(input);

  expect(first.kind === 'replayed' && first.unconfirmed).toEqual(['delivery-1']);
  expect(first.kind === 'replayed' && first.outcomes[0]).toMatchObject({
    kind: 'unknown',
    confirmed: false,
    operationId: originalAccept,
    laneKey: laneKeyOf({ kind: 'task', id: 'orca-task-1' }, 'task'),
    storeChanged: true,
  });
  expect(first.kind === 'replayed' && first.blockedLaneKeys).toEqual([
    laneKeyOf({ kind: 'task', id: 'orca-task-1' }, 'task'),
  ]);

  const intent = intentState(originalAccept);
  expect(intent?.state).toBe('blocked');
  expect(intent?.blockingReason).toBeTruthy();

  // 重复重放稳定：已经阻塞的 lane 不再写第二次，revision 不推进。
  expect(second.kind === 'replayed' && second.outcomes[0]?.storeChanged).toBe(false);
  expect(revision()).toBe(revisionAfterFirst);
});

test('旧代际迟到消息只补历史与确认，不推进生命周期也不消耗共享预算', async () => {
  const first = pendingDelivery('orca-task-1', 'delivery-1');
  // claimed 的 runId 是旧代际（run-0），可信事实是当前代际（run-1）。
  const stale: PendingDelivery = {
    ...first,
    delivery: { ...first.delivery, claimed: claimedFor('orca-task-1', { runId: 'run-0' }) },
  };
  const backend = fakeBackend();
  const budgetsBefore = budgetCounters();

  const result = await replayDeliveries(replayInput(backend.backend, [stale]));

  expect(result.kind).toBe('replayed');
  if (result.kind !== 'replayed') {
    return;
  }
  expect(result.outcomes[0]?.kind).toBe('history_only');
  expect(result.outcomes[0]?.confirmed).toBe(true);
  expect(result.unconfirmed).toEqual([]);
  expect(result.blockedLaneKeys).toEqual([]);
  // 只确认，不记录 Accepted Worker Result，也不写结算记录。
  expect(settlementCount()).toBe(0);
  expect(backend.mutations.filter((mutation) => mutation.operation === 'task-update')).toHaveLength(0);
  expect(backend.mutations.some((mutation) => mutation.operation === 'delivery-ack')).toBe(true);
  expect(budgetCounters()).toEqual(budgetsBefore);
});

test('未确认 Delivery 的候选 ID 未被使用时由调用方提供的稳定 ID 兜底', async () => {
  const backend = fakeBackend();
  const spy = spySettle([
    { kind: 'settled', dedupeKey: 'dedupe-1', orcaResultRef: 'orca-task-1#abc', verification: ACCEPTED_VERIFICATION },
  ]);

  const result = await replayDeliveries(
    replayInput(backend.backend, [pendingDelivery('orca-task-1', 'delivery-1')], { settle: spy.settle }),
  );

  expect(result.kind).toBe('replayed');
  expect(spy.calls[0]?.operationIds.acceptResult).toBe('delivery-1-accept-candidate');
  expect(spy.calls[0]?.operationIds.ack).toBe('delivery-1-ack-candidate');
});

test('读取到的身份与待结算 Delivery 不一致时不确认，也不产生结果引用', async () => {
  const backend = fakeBackend({ deliveryId: 'delivery-other' });

  // 使用真实默认 pipeline 才能验证「身份不一致 → rejected 且不确认」。
  const result = await replayDeliveries(
    replayInput(backend.backend, [pendingDelivery('orca-task-1', 'delivery-1')]),
  );

  expect(result.kind).toBe('replayed');
  if (result.kind !== 'replayed') {
    return;
  }
  expect(result.outcomes[0]?.kind).toBe('rejected');
  expect(result.outcomes[0]?.confirmed).toBe(false);
  expect(result.unconfirmed).toEqual(['delivery-1']);
  expect(settlementCount()).toBe(0);
  expect(backend.mutations).toHaveLength(0);
});

test('默认使用前驱 settleDelivery，而不是另建结算入口', async () => {
  const backend = fakeBackend();
  const pending = [pendingDelivery('orca-task-1', 'delivery-1')];

  const result = await replayDeliveries(replayInput(backend.backend, pending));

  expect(result.kind).toBe('replayed');
  if (result.kind !== 'replayed') {
    return;
  }
  expect(result.outcomes[0]?.kind).toBe('settled');
  expect(settlementCount()).toBe(1);
  // 只有前驱 pipeline 会写结算记录：这里断言的正是「复用同一入口」。
  const settlementQuery = store.query({ kind: 'delivery-settlements', coordinationScopeId: SCOPE });
  expect(settlementQuery.kind === 'delivery-settlements' && settlementQuery.settlements[0]?.orcaResultRef).toContain(
    'orca-task-1#',
  );
});

test('pipeline 走到 blocked 分支时给出真实 lane 键，而不是裸 orcaTaskId', async () => {
  // 回读结果与本次归一化结果不一致：pipeline 在 accept-result lane 上返回 blocked。
  const backend = fakeBackend({
    taskRows: [{ id: 'orca-task-1', status: 'completed', result: { other: 'result' } }],
  });

  const result = await replayDeliveries(
    replayInput(backend.backend, [pendingDelivery('orca-task-1', 'delivery-1')]),
  );

  expect(result.kind).toBe('replayed');
  if (result.kind !== 'replayed') {
    return;
  }
  const outcome = result.outcomes[0];
  expect(outcome?.kind).toBe('blocked');
  expect(outcome?.confirmed).toBe(false);
  // lane 键必须是 `laneKeyOf([kind,id,category])` 的编码，而不是一个裸 id。
  const acceptLane = acceptResultLaneKey('orca-task-1');
  expect(JSON.parse(acceptLane)).toEqual(['task', 'orca-task-1', 'task']);
  expect(outcome?.laneKey).toBe(acceptLane);
  expect(outcome?.laneKey).not.toBe('orca-task-1');
  expect(result.blockedLaneKeys).toContain(acceptLane);
});

test('lane 已被占用时 blockedLaneKeys 与 store 中未决 intent 的 laneKey 一致', async () => {
  const holder = 'op-holding-lane' as OperationId;
  const begun = beginIntent(store, {
    coordinationScopeId: SCOPE,
    operationId: holder,
    target: { kind: 'task', id: 'orca-task-1' },
    operationCategory: 'task',
    writer,
    expectedRevision: revision(),
  });
  expect(begun.kind).toBe('registered');
  const backend = fakeBackend();

  const result = await replayDeliveries(
    replayInput(backend.backend, [pendingDelivery('orca-task-1', 'delivery-1')]),
  );

  expect(result.kind).toBe('replayed');
  if (result.kind !== 'replayed') {
    return;
  }
  expect(result.outcomes[0]?.kind).toBe('blocked');
  const lane = result.blockedLaneKeys[0];
  expect(lane).toBe(acceptResultLaneKey('orca-task-1'));

  // 报出的 lane 键必须真的能在 store 的未决 intent 集合里定位到。
  const unresolved = store.query({ kind: 'intents', coordinationScopeId: SCOPE });
  expect(unresolved.kind).toBe('intents');
  if (unresolved.kind !== 'intents') {
    return;
  }
  expect(
    unresolved.intents.some((intent) => intent.laneKey === lane && intent.operationId === holder),
  ).toBe(true);
});
