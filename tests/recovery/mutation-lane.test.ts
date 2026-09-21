/**
 * IP-3 行为测试：mutation lane 阻塞可观测、可按 lane 隔离，且解除前必须重验事实。
 *
 * 断言落在可观察行为上：snapshot 里能读到哪个 lane 未决、原因是什么，其它 lane 的写入与只读查询
 * 照常工作，解除只有在确定结论加 scope/ownership/revision/预算四验通过时才发生。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import {
  PENDING_LANE_REASON,
  checkLaneRelease,
  findMutationLane,
  isLaneBlocked,
  projectMutationLanes,
} from '../../src/domain/coordination/mutation-lane.js';
import {
  beginIntent,
  blockLane,
  resolveLane,
  settleIntent,
} from '../../src/application/coordination/intent-service.js';
import { acquireRuntimeLease } from '../../src/application/coordination/lease-service.js';
import { laneKeyOf, type IntentState, type OperationIntent } from '../../src/application/dto/operation-intent.js';
import type { OperationOutcome } from '../../src/application/dto/operation-outcome.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  EntityRef,
  OperationId,
  PlanningCycleId,
  RuntimeIncarnationId,
} from '../../src/application/dto/identity.js';
import type {
  CoordinationCommandResult,
  CoordinationSnapshot,
  CoordinationWriter,
} from '../../src/application/ports/branch-coordination-store.js';
import { openCoordinationStore, type CoordinationStore } from '../../src/adapters/storage/coordination-store.js';

const SCOPE = 'scope-1' as CoordinationScopeId;
const SESSION = 'session-a' as CoordinatorSessionId;
const INCARNATION = 'inc-1' as RuntimeIncarnationId;
const CATEGORY = 'task-create';
const LANE_A_TARGET: EntityRef<string> = { kind: 'work_package', id: 'wp-1' };
const LANE_B_TARGET: EntityRef<string> = { kind: 'work_package', id: 'wp-2' };
const LANE_A = laneKeyOf(LANE_A_TARGET, CATEGORY);
const LANE_B = laneKeyOf(LANE_B_TARGET, CATEGORY);
const OPERATION_A = 'op-a' as OperationId;
const OPERATION_B = 'op-b' as OperationId;
const BLOCK_REASON = 'orca request-show 返回 pending，无法证明副作用未发生';

let directory = '';
let store: CoordinationStore;
let writer: CoordinationWriter;
let now = 5_000;

const clock = (): number => now;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-mutation-lane-'));
  now = 5_000;
  const opened = openCoordinationStore({ databasePath: join(directory, 'coordination.sqlite'), clock });
  if (opened.kind !== 'opened') {
    throw new Error(opened.message);
  }
  store = opened.store;

  const bootstrap: CoordinationCommandResult = store.transact({
    kind: 'create-scope',
    coordinationScopeId: SCOPE,
    expectedRevision: 0,
    writer: { coordinatorSessionId: SESSION, runtimeIncarnationId: INCARNATION, fencingGeneration: 0 },
    mode: 'route_planning',
    controlState: 'active',
    planningCycleId: 'cycle-1' as PlanningCycleId,
  });
  if (bootstrap.kind !== 'committed') {
    throw new Error('无法创建测试 Scope');
  }
  const registered = store.transact({
    kind: 'register-session',
    coordinationScopeId: SCOPE,
    expectedRevision: bootstrap.revision,
    writer: { coordinatorSessionId: SESSION, runtimeIncarnationId: INCARNATION, fencingGeneration: 0 },
    coordinatorSessionId: SESSION,
    coordinatorModelConfigurationRef: 'profile-a',
    lifecycleState: 'registered',
  });
  if (registered.kind !== 'committed') {
    throw new Error('无法注册测试 Session');
  }
  const lease = acquireRuntimeLease(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION,
    runtimeIncarnationId: INCARNATION,
    fencingGeneration: 0,
  });
  if (lease.kind !== 'acquired') {
    throw new Error('无法取得测试 Runtime Lease');
  }
  writer = {
    coordinatorSessionId: SESSION,
    runtimeIncarnationId: INCARNATION,
    fencingGeneration: lease.lease.fencingGeneration,
  };
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

function revisionOf(): number {
  const result = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  if (result.kind !== 'scope' || result.scope === null) {
    throw new Error('Scope 不存在');
  }
  return result.scope.revision;
}

function snapshot(): CoordinationSnapshot {
  const result = store.query({ kind: 'snapshot', coordinationScopeId: SCOPE });
  if (result.kind !== 'snapshot') {
    throw new Error('无法读取快照');
  }
  return result.snapshot;
}

function begin(operationId: OperationId, target: EntityRef<string>): void {
  const result = beginIntent(store, {
    coordinationScopeId: SCOPE,
    operationId,
    target,
    operationCategory: CATEGORY,
    writer,
    expectedRevision: revisionOf(),
  });
  if (result.kind !== 'registered') {
    throw new Error(`无法登记意图 ${operationId}: ${result.kind}`);
  }
}

/** 仅用于纯投影用例：直接构造 intent，不经过存储。 */
function fakeIntent(input: {
  readonly operationId: string;
  readonly laneKey: string;
  readonly state: IntentState;
  readonly blockingReason: string | null;
  readonly createdAt?: number;
}): OperationIntent {
  return {
    coordinationScopeId: SCOPE,
    operationId: input.operationId as OperationId,
    target: { kind: 'work_package', id: input.laneKey },
    operationCategory: CATEGORY,
    laneKey: input.laneKey,
    expectedRevision: 1,
    expectedHead: null,
    initiatedBy: { coordinatorSessionId: SESSION, runtimeIncarnationId: INCARNATION },
    state: input.state,
    outcomeClass: input.state === 'settled' ? 'accepted' : null,
    backendRequestId: null,
    blockingReason: input.blockingReason,
    createdAt: input.createdAt ?? 1,
    settledAt: input.state === 'settled' ? 2 : null,
  };
}

test('一条 lane 阻塞可从 snapshot 读到，且其它 lane 的读写与只读查询不受影响', () => {
  begin(OPERATION_A, LANE_A_TARGET);
  const blocked = blockLane(store, {
    coordinationScopeId: SCOPE,
    operationId: OPERATION_A,
    writer,
    expectedRevision: revisionOf(),
    reason: BLOCK_REASON,
  });
  expect(blocked.kind).toBe('settled');

  const afterBlock = snapshot();
  const laneA = findMutationLane(afterBlock.mutationLanes, LANE_A);
  expect(laneA).not.toBeNull();
  expect(laneA?.operationId).toBe(OPERATION_A);
  expect(laneA?.cause).toBe('blocked');
  expect(laneA?.reason).toBe(BLOCK_REASON);
  // 阻塞是持久事实，未决 intent 与派生投影一致。
  expect(afterBlock.unresolvedIntents.map((intent) => intent.operationId)).toEqual([OPERATION_A]);

  // 另一条 lane 的写入不受影响：它可以照常登记与收尾。
  begin(OPERATION_B, LANE_B_TARGET);
  const bothLanes = snapshot();
  expect(bothLanes.mutationLanes.map((lane) => lane.laneKey).sort()).toEqual([LANE_A, LANE_B].sort());
  expect(findMutationLane(bothLanes.mutationLanes, LANE_B)?.cause).toBe('pending');

  const accepted: OperationOutcome<unknown> = {
    kind: 'accepted',
    operation: { operationId: OPERATION_B, target: LANE_B_TARGET, backendRequestId: 'req-b' },
    value: null,
  };
  const settled = settleIntent(store, {
    coordinationScopeId: SCOPE,
    operationId: OPERATION_B,
    writer,
    expectedRevision: revisionOf(),
    outcome: accepted,
  });
  expect(settled.kind).toBe('settled');

  // 只读查询与另一条 lane 的推进都不受阻塞影响；投影只保留仍然未决的 lane。
  expect(store.query({ kind: 'scope', coordinationScopeId: SCOPE }).kind).toBe('scope');
  expect(store.query({ kind: 'intents', coordinationScopeId: SCOPE }).kind).toBe('intents');
  const afterSettle = snapshot();
  expect(afterSettle.mutationLanes.map((lane) => lane.laneKey)).toEqual([LANE_A]);
  expect(isLaneBlocked(afterSettle.mutationLanes, LANE_B)).toBe(false);
});

test('派生投影只覆盖未决 lane，结算过的 intent 不产生阻塞', () => {
  const lanes = projectMutationLanes([
    fakeIntent({ operationId: 'op-1', laneKey: 'lane-1', state: 'settled', blockingReason: null }),
    fakeIntent({ operationId: 'op-2', laneKey: 'lane-2', state: 'blocked', blockingReason: '对账未决' }),
    fakeIntent({ operationId: 'op-3', laneKey: 'lane-3', state: 'pending', blockingReason: null }),
  ]);

  expect(lanes.map((lane) => lane.laneKey)).toEqual(['lane-2', 'lane-3']);
  expect(findMutationLane(lanes, 'lane-1')).toBeNull();
  expect(findMutationLane(lanes, 'lane-2')?.reason).toBe('对账未决');
  // pending 且没有记录原因时给出稳定占位语义，而不是空原因。
  expect(findMutationLane(lanes, 'lane-3')?.reason).toBe(PENDING_LANE_REASON);
  expect(findMutationLane(lanes, 'lane-3')?.cause).toBe('pending');
});

test('同一 lane 同时存在阻塞与等待时展示已确认的阻塞', () => {
  const lanes = projectMutationLanes([
    fakeIntent({ operationId: 'op-later', laneKey: 'lane-1', state: 'blocked', blockingReason: '已确认阻塞', createdAt: 9 }),
    fakeIntent({ operationId: 'op-earlier', laneKey: 'lane-1', state: 'pending', blockingReason: null, createdAt: 1 }),
  ]);

  expect(lanes).toHaveLength(1);
  expect(lanes[0]?.cause).toBe('blocked');
  expect(lanes[0]?.operationId).toBe('op-later');
});

test('解除必须先有确定结论或用户补充事实，并在解除后重验 scope/ownership/revision/预算', () => {
  begin(OPERATION_A, LANE_A_TARGET);
  blockLane(store, {
    coordinationScopeId: SCOPE,
    operationId: OPERATION_A,
    writer,
    expectedRevision: revisionOf(),
    reason: BLOCK_REASON,
  });
  const lane = findMutationLane(snapshot().mutationLanes, LANE_A);
  if (lane === null) {
    throw new Error('lane 未出现在投影里');
  }
  const allValid = { scope: true, ownership: true, revision: true, budget: true };

  // 没有结论、也没有用户补充事实时不得解除。
  expect(checkLaneRelease({ lane, resolution: 'indeterminate', revalidation: allValid })).toMatchObject({
    kind: 'rejected',
    code: 'indeterminate',
  });

  // 对账给出确定结论后仍需逐项重验；任一不成立都保持阻塞。
  expect(
    checkLaneRelease({
      lane,
      resolution: 'reconciliation_conclusion',
      revalidation: { ...allValid, scope: false },
    }),
  ).toMatchObject({ kind: 'rejected', code: 'scope_mismatch' });
  expect(
    checkLaneRelease({
      lane,
      resolution: 'reconciliation_conclusion',
      revalidation: { ...allValid, ownership: false },
    }),
  ).toMatchObject({ kind: 'rejected', code: 'ownership_mismatch' });
  expect(
    checkLaneRelease({
      lane,
      resolution: 'reconciliation_conclusion',
      revalidation: { ...allValid, revision: false },
    }),
  ).toMatchObject({ kind: 'rejected', code: 'revision_mismatch' });
  expect(
    checkLaneRelease({
      lane,
      resolution: 'reconciliation_conclusion',
      revalidation: { ...allValid, budget: false },
    }),
  ).toMatchObject({ kind: 'rejected', code: 'budget_exhausted' });

  // 用户显式补充事实同样可以解除，前提是四项事实都成立。
  expect(checkLaneRelease({ lane, resolution: 'user_supplied_fact', revalidation: allValid })).toEqual({
    kind: 'released',
    laneKey: LANE_A,
  });
});

test('解除在 store 边界同样重验 revision：过期写入零副作用，当前 revision 才清空阻塞', () => {
  begin(OPERATION_A, LANE_A_TARGET);
  blockLane(store, {
    coordinationScopeId: SCOPE,
    operationId: OPERATION_A,
    writer,
    expectedRevision: revisionOf(),
    reason: BLOCK_REASON,
  });
  const revisionAtBlock = revisionOf();

  const stale = resolveLane(store, {
    coordinationScopeId: SCOPE,
    operationId: OPERATION_A,
    writer,
    expectedRevision: revisionAtBlock - 1,
    outcomeClass: 'accepted',
  });
  expect(stale.kind).toBe('rejected');
  if (stale.kind === 'rejected') {
    expect(stale.rejection.code).toBe('stale_revision');
    expect(stale.rejection.currentRevision).toBe(revisionAtBlock);
  }
  // 过期写入没有留下任何副作用：lane 仍然是阻塞的。
  expect(isLaneBlocked(snapshot().mutationLanes, LANE_A)).toBe(true);

  const resolved = resolveLane(store, {
    coordinationScopeId: SCOPE,
    operationId: OPERATION_A,
    writer,
    expectedRevision: revisionAtBlock,
    outcomeClass: 'accepted',
    backendRequestId: 'req-a',
  });
  expect(resolved.kind).toBe('settled');

  const afterRelease = snapshot();
  expect(afterRelease.mutationLanes).toHaveLength(0);
  expect(afterRelease.unresolvedIntents).toHaveLength(0);
});
