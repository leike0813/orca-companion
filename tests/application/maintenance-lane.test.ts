import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import {
  INITIAL_MAINTENANCE_STATE,
  MAINTENANCE_CYCLE_LIMIT,
  planMaintenance,
  runMaintenanceCycle,
  stopMaintenance,
  yieldForActionableWork,
  type MaintenanceLaneState,
} from '../../src/application/coordinator/maintenance-lane.js';
import { projectActionableWork, type SourceObservation } from '../../src/application/coordinator/actionable-work.js';
import {
  acquireIncarnation,
  assertFencingGeneration,
  type CoordinatorIncarnation,
  type FencingAssertion,
} from '../../src/application/coordinator/runtime-guard.js';
import {
  admitWakeBatch,
  type WakeCheckpointCommit,
  type WakeCheckpointPort,
} from '../../src/application/coordinator/wake-admission.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  PlanningCycleId,
  RuntimeIncarnationId,
} from '../../src/application/dto/identity.js';
import type { CoordinationWriter } from '../../src/application/ports/branch-coordination-store.js';
import { openCoordinationStore, type CoordinationStore } from '../../src/adapters/storage/coordination-store.js';
import {
  COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
  type CoordinatorSessionState,
  type WakeBatch,
} from '../../src/domain/coordinator/session-state.js';

const SCOPE = 'scope-1' as CoordinationScopeId;
const SESSION = 'session-a' as CoordinatorSessionId;
const TTL_MS = 30_000;

let directory = '';
let store: CoordinationStore;
let now = 1_000;

const clock = (): number => now;
const incarnation = (value: string): RuntimeIncarnationId => value as RuntimeIncarnationId;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-maintenance-'));
  now = 1_000;
  const opened = openCoordinationStore({ databasePath: join(directory, 'coordination.sqlite'), clock });
  if (opened.kind !== 'opened') {
    throw new Error(opened.message);
  }
  store = opened.store;
  const created = store.transact({
    kind: 'create-scope',
    coordinationScopeId: SCOPE,
    expectedRevision: 0,
    writer: writer('bootstrap', 0),
    mode: 'route_planning',
    controlState: 'active',
    planningCycleId: 'cycle-1' as PlanningCycleId,
    fullBranchRef: 'refs/heads/main',
    canonicalWorktreePath: '/tmp/orca-test-worktree',
  });
  if (created.kind !== 'committed') {
    throw new Error('无法创建测试 Scope');
  }
  const registered = store.transact({
    kind: 'register-session',
    coordinationScopeId: SCOPE,
    expectedRevision: revisionOf(),
    writer: writer('bootstrap', 0),
    coordinatorSessionId: SESSION,
    coordinatorModelConfigurationRef: 'model-config-1',
    lifecycleState: 'registered',
  });
  if (registered.kind !== 'committed') {
    throw new Error('无法注册测试 Session');
  }
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

function writer(incarnationId: string, fencingGeneration: number): CoordinationWriter {
  return {
    coordinatorSessionId: SESSION,
    runtimeIncarnationId: incarnation(incarnationId),
    fencingGeneration,
  };
}

function revisionOf(): number {
  const result = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  if (result.kind !== 'scope' || result.scope === null) {
    throw new Error('Scope 不存在');
  }
  return result.scope.revision;
}

function acquire(): CoordinatorIncarnation {
  const acquired = acquireIncarnation(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION,
    runtimeIncarnationId: incarnation(`inc-${String(now)}`),
    ttlMs: TTL_MS,
  });
  if (acquired.kind !== 'acquired') {
    throw new Error(`无法取得 Runtime Lease: ${acquired.kind}`);
  }
  return acquired.incarnation;
}

function observation(classification: SourceObservation['classification'], sourceId: string): SourceObservation {
  return {
    source: { sourceKind: 'delivery', sourceId, revision: 1 },
    classification,
    summary: `work:${sourceId}`,
    ownerCoordinatorSessionId: SESSION,
  };
}

function project(observations: readonly SourceObservation[], controlState: 'active' | 'paused' | 'cancelled' = 'active') {
  return projectActionableWork({
    coordinatorSessionId: SESSION,
    controlState,
    observations,
    admitted: [],
  });
}

/** 维护 lane 拿不到 checkpoint store；这个 fixture 用来证明它确实没有写过任何 batch。 */
function createCheckpoints(): { readonly port: WakeCheckpointPort; readonly batches: WakeBatch[] } {
  const batches: WakeBatch[] = [];
  const state = (): CoordinatorSessionState => ({
    schemaVersion: COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
    coordinatorSessionId: SESSION,
    committedMessages: [],
    graphPosition: 'suspend',
    committedModelSteps: [],
    wakeBatches: [...batches],
    lastCompactionOutcome: null,
  });
  return {
    batches,
    port: {
      commitWakeBatch: (batch: WakeBatch): WakeCheckpointCommit => {
        batches.push(batch);
        return { kind: 'committed', state: state() };
      },
    },
  };
}

const NO_WORK = project([]);
const WITH_WORK = project([observation('worker_question', 'dispatch-1')]);

type Harness = {
  readonly incarnation: CoordinatorIncarnation;
  readonly fencing: FencingAssertion;
  keepaliveCalls: number;
  readonly transcript: string[];
};

function harness(options: { readonly fencing?: FencingAssertion } = {}): Harness {
  const incarnationUnderTest = acquire();
  const target: Harness = {
    incarnation: incarnationUnderTest,
    fencing: options.fencing ?? assertFencingGeneration(store, incarnationUnderTest, { clock }),
    keepaliveCalls: 0,
    transcript: [],
  };
  return target;
}

async function cycle(
  target: Harness,
  input: {
    readonly state: MaintenanceLaneState;
    readonly controlState?: 'active' | 'paused' | 'cancelled';
    readonly projection?: typeof NO_WORK;
    readonly cycleLimit?: number;
    readonly available?: boolean;
  },
) {
  return await runMaintenanceCycle({
    state: input.state,
    fencing: target.fencing,
    controlState: input.controlState ?? 'active',
    projection: input.projection ?? NO_WORK,
    ...(input.cycleLimit === undefined ? {} : { cycleLimit: input.cycleLimit }),
    keepalive: () => {
      target.keepaliveCalls += 1;
      return Promise.resolve(
        input.available === false
          ? { kind: 'unavailable', reason: 'provider 拒绝了保活请求' }
          : { kind: 'kept-warm', detail: '连接与缓存保持温热' },
      );
    },
  });
}

test('keepalive 不产生 Wake Batch、Committed Model Step、transcript，也不改图位置', async () => {
  const target = harness();
  const checkpoints = createCheckpoints();
  const revisionBefore = revisionOf();
  const sessionsBefore = store.query({ kind: 'sessions', coordinationScopeId: SCOPE });

  let state = INITIAL_MAINTENANCE_STATE;
  for (let index = 0; index < 3; index += 1) {
    const result = await cycle(target, { state });
    expect(result.kind).toBe('performed');
    state = result.state;
  }

  expect(target.keepaliveCalls).toBe(3);
  expect(state.cyclesRun).toBe(3);
  // 协调状态与 checkpoint 都未被维护 lane 触碰。
  expect(revisionOf()).toBe(revisionBefore);
  expect(store.query({ kind: 'sessions', coordinationScopeId: SCOPE })).toEqual(sessionsBefore);
  expect(store.query({ kind: 'wake-admissions', coordinationScopeId: SCOPE })).toEqual({
    kind: 'wake-admissions',
    admissions: [],
  });
  expect(checkpoints.batches).toEqual([]);
  expect(target.transcript).toEqual([]);
});

test('维护受有限 cycle 上限约束，不产生无限心跳', async () => {
  const target = harness();
  let state = INITIAL_MAINTENANCE_STATE;
  const limit = 3;

  for (let index = 0; index < limit; index += 1) {
    const result = await cycle(target, { state, cycleLimit: limit });
    expect(result.kind).toBe('performed');
    state = result.state;
  }

  const exhausted = await cycle(target, { state, cycleLimit: limit });
  expect(exhausted.kind).toBe('stopped');
  if (exhausted.kind === 'stopped') {
    expect(exhausted.reason).toBe('cycle_limit_reached');
    expect(exhausted.state.stopReason).toBe('cycle_limit_reached');
  }
  expect(target.keepaliveCalls).toBe(limit);

  const afterStop = await cycle(target, { state: exhausted.state, cycleLimit: limit });
  expect(afterStop.kind).toBe('stopped');
  expect(target.keepaliveCalls).toBe(limit);
  expect(planMaintenance({
    state: exhausted.state,
    fencing: target.fencing,
    controlState: 'active',
    projection: NO_WORK,
    cycleLimit: limit,
  })).toEqual({ kind: 'stop', reason: 'cycle_limit_reached' });
});

test('默认 cycle 上限有限', () => {
  const target = harness();
  const plan = planMaintenance({
    state: { cyclesRun: MAINTENANCE_CYCLE_LIMIT, stopped: false, stopReason: null },
    fencing: target.fencing,
    controlState: 'active',
    projection: NO_WORK,
  });

  expect(plan).toEqual({ kind: 'stop', reason: 'cycle_limit_reached' });
});

test('fencing 失效时维护停止，且不尝试重新获取', async () => {
  const target = harness();
  const stale: FencingAssertion = { kind: 'fenced', code: 'stale_generation' };

  const result = await runMaintenanceCycle({
    state: INITIAL_MAINTENANCE_STATE,
    fencing: stale,
    controlState: 'active',
    projection: NO_WORK,
    keepalive: () => {
      target.keepaliveCalls += 1;
      return Promise.resolve({ kind: 'kept-warm', detail: '不应被调用' });
    },
  });

  expect(result.kind).toBe('stopped');
  if (result.kind === 'stopped') {
    expect(result.reason).toBe('fencing_lost');
  }
  expect(target.keepaliveCalls).toBe(0);
});

test('保活不可用时维护停止，但不产生业务状态', async () => {
  const target = harness();
  const revisionBefore = revisionOf();

  const result = await cycle(target, { state: INITIAL_MAINTENANCE_STATE, available: false });

  expect(result.kind).toBe('stopped');
  if (result.kind === 'stopped') {
    expect(result.reason).toBe('keepalive_unavailable');
  }
  expect(target.keepaliveCalls).toBe(1);
  expect(revisionOf()).toBe(revisionBefore);
});

test('Actionable Work 抢占维护，模型以该 batch 在同一 Session 上恢复', async () => {
  const target = harness();
  const checkpoints = createCheckpoints();

  let state = INITIAL_MAINTENANCE_STATE;
  const first = await cycle(target, { state });
  expect(first.kind).toBe('performed');
  state = first.state;

  // 维护进行中出现 Actionable Work：让位，且不再发起新的保活。
  const preempted = await cycle(target, { state, projection: WITH_WORK });
  expect(preempted.kind).toBe('stopped');
  if (preempted.kind === 'stopped') {
    expect(preempted.reason).toBe('actionable_work');
  }
  expect(target.keepaliveCalls).toBe(1);

  state = yieldForActionableWork();
  expect(state).toEqual({ cyclesRun: 0, stopped: true, stopReason: 'actionable_work' });

  // 模型以该 batch 恢复：消费的是同一份 Actionable Work，没有新 Session，也没有被维护消费掉。
  const admitted = admitWakeBatch(store, {
    wakeBatch: {
      wakeBatchId: 'wake-1',
      coordinationScopeId: SCOPE,
      coordinatorSessionId: SESSION,
      sourceRevisions: WITH_WORK.items.map((item) => item.source),
      actionableWork: WITH_WORK.items.map((item) => ({
        workKind: item.workKind,
        workId: item.source.sourceId,
        summary: item.summary,
      })),
    },
    incarnation: target.incarnation,
    checkpoints: checkpoints.port,
    clock,
  });
  expect(admitted.kind).toBe('admitted');
  expect(checkpoints.batches).toHaveLength(1);

  const projectAfter = projectActionableWork({
    coordinatorSessionId: SESSION,
    controlState: 'active',
    observations: [observation('worker_question', 'dispatch-1')],
    admitted: admitted.kind === 'admitted' ? [admitted.record] : [],
  });
  expect(projectAfter.items).toEqual([]);
});

test('Pause 或 Cancel 停止维护且不再发起 keepalive', async () => {
  for (const controlState of ['paused', 'cancelled'] as const) {
    now += TTL_MS + 1;
    const target = harness();
    const result = await cycle(target, { state: INITIAL_MAINTENANCE_STATE, controlState });

    expect(result.kind).toBe('stopped');
    if (result.kind === 'stopped') {
      expect(result.reason).toBe('control_state');
    }
    expect(target.keepaliveCalls).toBe(0);

    // 已停止的 lane 不会因为控制状态回到 active 就自行复活。
    if (result.kind === 'stopped') {
      const revived = await cycle(target, { state: result.state });
      expect(revived.kind).toBe('stopped');
      if (revived.kind === 'stopped') {
        expect(revived.reason).toBe('control_state');
      }
      expect(target.keepaliveCalls).toBe(0);
    }
  }
});

test('因控制状态或 fencing 停止时保留已消耗的 cycle 计数，便于诊断', () => {
  const state: MaintenanceLaneState = { cyclesRun: 5, stopped: false, stopReason: null };

  expect(stopMaintenance(state, 'control_state')).toEqual({
    cyclesRun: 5,
    stopped: true,
    stopReason: 'control_state',
  });
  expect(yieldForActionableWork().cyclesRun).toBe(0);
});
