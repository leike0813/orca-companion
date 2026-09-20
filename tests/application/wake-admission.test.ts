import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { acquireIncarnation, type CoordinatorIncarnation } from '../../src/application/coordinator/runtime-guard.js';
import {
  admissionKeyFor,
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
import type {
  BranchCoordinationStore,
  CoordinationCommand,
  CoordinationWriter,
} from '../../src/application/ports/branch-coordination-store.js';
import { openCoordinationStore, type CoordinationStore } from '../../src/adapters/storage/coordination-store.js';
import {
  COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
  type CoordinatorSessionState,
  type SourceRevisionRef,
  type WakeBatch,
} from '../../src/domain/coordinator/session-state.js';

const SCOPE = 'scope-1' as CoordinationScopeId;
const SESSION = 'session-a' as CoordinatorSessionId;
const TTL_MS = 30_000;

let directory = '';
let store: CoordinationStore;
let now = 1_000;
const log: string[] = [];

const clock = (): number => now;
const incarnation = (value: string): RuntimeIncarnationId => value as RuntimeIncarnationId;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-wake-'));
  now = 1_000;
  log.length = 0;
  const opened = openCoordinationStore({ databasePath: join(directory, 'coordination.sqlite'), clock });
  if (opened.kind !== 'opened') {
    throw new Error(opened.message);
  }
  store = opened.store;
  const created = store.transact({
    kind: 'create-scope',
    coordinationScopeId: SCOPE,
    expectedRevision: 0,
    writer: provisional(),
    mode: 'route_planning',
    controlState: 'active',
    planningCycleId: 'cycle-1' as PlanningCycleId,
  });
  if (created.kind !== 'committed') {
    throw new Error('无法创建测试 Scope');
  }
  const registered = store.transact({
    kind: 'register-session',
    coordinationScopeId: SCOPE,
    expectedRevision: revisionOf(),
    writer: provisional(),
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

function provisional(): CoordinationWriter {
  return {
    coordinatorSessionId: SESSION,
    runtimeIncarnationId: incarnation('bootstrap'),
    fencingGeneration: 0,
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

/** 记录调用顺序的 store 包装：只记录写入，不记录只读查询。 */
function recordingStore(inner: CoordinationStore): BranchCoordinationStore {
  return {
    query: (input) => inner.query(input),
    transact: (input: CoordinationCommand) => {
      log.push(`store:${input.kind}`);
      return inner.transact(input);
    },
  };
}

type CheckpointFixture = {
  readonly port: WakeCheckpointPort;
  readonly batches: WakeBatch[];
  failReason: string | null;
};

function createCheckpoints(): CheckpointFixture {
  const batches: WakeBatch[] = [];
  const fixture: CheckpointFixture = {
    batches,
    failReason: null,
    port: {
      commitWakeBatch: (batch: WakeBatch): WakeCheckpointCommit => {
        log.push('checkpoint:commit');
        if (fixture.failReason !== null) {
          return { kind: 'unrecoverable', reason: fixture.failReason };
        }
        const existing = batches.find((candidate) => candidate.wakeBatchId === batch.wakeBatchId);
        if (existing !== undefined) {
          return { kind: 'already-committed', state: stateWith(batches) };
        }
        batches.push(batch);
        return { kind: 'committed', state: stateWith(batches) };
      },
    },
  };
  return fixture;
}

function stateWith(batches: readonly WakeBatch[]): CoordinatorSessionState {
  return {
    schemaVersion: COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
    coordinatorSessionId: SESSION,
    committedMessages: [],
    graphPosition: 'suspend',
    committedModelSteps: [],
    wakeBatches: [...batches],
  };
}

function source(sourceId: string, revision: number): SourceRevisionRef {
  return { sourceKind: 'delivery', sourceId, revision };
}

function wakeBatch(wakeBatchId: string, sources: readonly SourceRevisionRef[]): WakeBatch {
  return {
    wakeBatchId,
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION,
    sourceRevisions: sources,
    actionableWork: [{ workKind: 'worker_result', workId: wakeBatchId, summary: '新的 Worker 结果待结算' }],
  };
}

function admissions(): readonly { readonly wakeBatchId: string; readonly admissionState: string }[] {
  const result = store.query({ kind: 'wake-admissions', coordinationScopeId: SCOPE });
  if (result.kind !== 'wake-admissions') {
    throw new Error('无法读取 wake admissions');
  }
  return result.admissions;
}

test('Wake Batch 先写 checkpoint，再记 source admission', () => {
  const incarnationUnderTest = acquire();
  const checkpoints = createCheckpoints();

  const outcome = admitWakeBatch(recordingStore(store), {
    wakeBatch: wakeBatch('wake-1', [source('delivery-1', 3)]),
    incarnation: incarnationUnderTest,
    checkpoints: checkpoints.port,
    clock,
  });

  expect(outcome.kind).toBe('admitted');
  expect(log).toEqual(['checkpoint:commit', 'store:record-wake-admission']);
  expect(checkpoints.batches).toHaveLength(1);
  expect(admissions()).toEqual([
    {
      coordinationScopeId: SCOPE,
      coordinatorSessionId: SESSION,
      wakeBatchId: 'wake-1',
      admissionState: 'admitted',
      sourceRevisions: [source('delivery-1', 3)],
      admittedAt: now,
    },
  ]);
});

test('已提交的 batch 不被再次注入，也不重复写 checkpoint', () => {
  const incarnationUnderTest = acquire();
  const checkpoints = createCheckpoints();
  const batch = wakeBatch('wake-1', [source('delivery-1', 3)]);

  const first = admitWakeBatch(recordingStore(store), {
    wakeBatch: batch,
    incarnation: incarnationUnderTest,
    checkpoints: checkpoints.port,
    clock,
  });
  expect(first.kind).toBe('admitted');

  log.length = 0;
  const second = admitWakeBatch(recordingStore(store), {
    wakeBatch: batch,
    incarnation: incarnationUnderTest,
    checkpoints: checkpoints.port,
    clock,
  });

  expect(second.kind).toBe('already-admitted');
  expect(log).toEqual([]);
  expect(checkpoints.batches).toHaveLength(1);
  expect(admissions()).toHaveLength(1);
});

test('崩溃在「已写 checkpoint、未记 admission」之间时按同一 batch ID 补齐', () => {
  const incarnationUnderTest = acquire();
  const checkpoints = createCheckpoints();
  const batch = wakeBatch('wake-1', [source('delivery-1', 3)]);
  // 模拟第一次尝试：checkpoint 写成功，admission 写入前进程中断。
  checkpoints.port.commitWakeBatch(batch);
  log.length = 0;

  const outcome = admitWakeBatch(recordingStore(store), {
    wakeBatch: batch,
    incarnation: incarnationUnderTest,
    checkpoints: checkpoints.port,
    clock,
  });

  expect(outcome.kind).toBe('repaired');
  expect(log).toEqual(['checkpoint:commit', 'store:record-wake-admission']);
  expect(checkpoints.batches).toHaveLength(1);
  expect(admissions().map((row) => row.admissionState)).toEqual(['repaired']);
});

test('同一批 source revision 换一个 batch ID 再来时不重复注入', () => {
  const incarnationUnderTest = acquire();
  const checkpoints = createCheckpoints();
  const first = admitWakeBatch(recordingStore(store), {
    wakeBatch: wakeBatch('wake-1', [source('delivery-1', 3)]),
    incarnation: incarnationUnderTest,
    checkpoints: checkpoints.port,
    clock,
  });
  expect(first.kind).toBe('admitted');

  log.length = 0;
  const replay = admitWakeBatch(recordingStore(store), {
    wakeBatch: wakeBatch('wake-2', [source('delivery-1', 3)]),
    incarnation: incarnationUnderTest,
    checkpoints: checkpoints.port,
    clock,
  });

  expect(replay.kind).toBe('already-admitted');
  if (replay.kind === 'already-admitted') {
    expect(replay.record.wakeBatchId).toBe('wake-1');
  }
  expect(log).toEqual([]);
  expect(checkpoints.batches).toHaveLength(1);
});

test('同一条 source 的更高 revision 会被当作新工作准入', () => {
  const incarnationUnderTest = acquire();
  const checkpoints = createCheckpoints();
  admitWakeBatch(store, {
    wakeBatch: wakeBatch('wake-1', [source('delivery-1', 3)]),
    incarnation: incarnationUnderTest,
    checkpoints: checkpoints.port,
    clock,
  });

  const next = admitWakeBatch(store, {
    wakeBatch: wakeBatch('wake-2', [source('delivery-1', 4)]),
    incarnation: incarnationUnderTest,
    checkpoints: checkpoints.port,
    clock,
  });

  expect(next.kind).toBe('admitted');
  expect(checkpoints.batches).toHaveLength(2);
  expect(admissionKeyFor(source('delivery-1', 4))).not.toBe(admissionKeyFor(source('delivery-1', 3)));
});

test('checkpoint 不可恢复时不记准入、不推进任何状态', () => {
  const incarnationUnderTest = acquire();
  const checkpoints = createCheckpoints();
  checkpoints.failReason = 'checkpoint 校验失败';
  const revisionsBefore = revisionOf();

  const outcome = admitWakeBatch(recordingStore(store), {
    wakeBatch: wakeBatch('wake-1', [source('delivery-1', 3)]),
    incarnation: incarnationUnderTest,
    checkpoints: checkpoints.port,
    clock,
  });

  expect(outcome.kind).toBe('blocked');
  expect(log).toEqual(['checkpoint:commit']);
  expect(admissions()).toEqual([]);
  expect(revisionOf()).toBe(revisionsBefore);
});

test('被 fence 的 incarnation 不能写 checkpoint', () => {
  const stale = acquire();
  now += TTL_MS + 1;
  acquire();
  const checkpoints = createCheckpoints();

  const outcome = admitWakeBatch(recordingStore(store), {
    wakeBatch: wakeBatch('wake-1', [source('delivery-1', 3)]),
    incarnation: stale,
    checkpoints: checkpoints.port,
    clock,
  });

  expect(outcome.kind).toBe('rejected');
  if (outcome.kind === 'rejected') {
    expect(outcome.rejection.code).toBe('fenced');
  }
  expect(log).toEqual([]);
  expect(checkpoints.batches).toHaveLength(0);
});

test('Wake Batch 的目标 Session 必须与当前 incarnation 一致', () => {
  const incarnationUnderTest = acquire();
  const checkpoints = createCheckpoints();

  const outcome = admitWakeBatch(store, {
    wakeBatch: { ...wakeBatch('wake-1', [source('delivery-1', 3)]), coordinatorSessionId: 'session-other' },
    incarnation: incarnationUnderTest,
    checkpoints: checkpoints.port,
    clock,
  });

  expect(outcome.kind).toBe('rejected');
  expect(checkpoints.batches).toHaveLength(0);
});

test('Wake Batch 的 Coordination Scope 必须与当前 incarnation 一致', () => {
  const incarnationUnderTest = acquire();
  const checkpoints = createCheckpoints();

  const outcome = admitWakeBatch(store, {
    wakeBatch: { ...wakeBatch('wake-1', [source('delivery-1', 3)]), coordinationScopeId: 'scope-other' },
    incarnation: incarnationUnderTest,
    checkpoints: checkpoints.port,
    clock,
  });

  expect(outcome.kind).toBe('rejected');
  expect(checkpoints.batches).toHaveLength(0);
});

test('wake_admissions 的唯一键是 Scope + Session + WakeBatchId，migration 可重入', () => {
  const incarnationUnderTest = acquire();
  const checkpoints = createCheckpoints();
  const batch = wakeBatch('wake-1', [source('delivery-1', 3)]);
  admitWakeBatch(store, { wakeBatch: batch, incarnation: incarnationUnderTest, checkpoints: checkpoints.port, clock });

  // 直接重放同一 command：唯一键拒绝，不产生第二条记录。
  const replayed = store.transact({
    kind: 'record-wake-admission',
    coordinationScopeId: SCOPE,
    expectedRevision: revisionOf(),
    writer: {
      coordinatorSessionId: incarnationUnderTest.coordinatorSessionId,
      runtimeIncarnationId: incarnationUnderTest.runtimeIncarnationId,
      fencingGeneration: incarnationUnderTest.fencingGeneration,
    },
    wakeBatchId: 'wake-1',
    admissionState: 'admitted',
    sourceRevisions: [source('delivery-1', 3)],
  });
  expect(replayed.kind).toBe('rejected');
  expect(admissions()).toHaveLength(1);

  // 关闭并以同一路径重新打开：migration 已升级过，重跑必须幂等。
  store.close();
  const reopened = openCoordinationStore({
    databasePath: join(directory, 'coordination.sqlite'),
    clock,
  });
  expect(reopened.kind).toBe('opened');
  if (reopened.kind === 'opened') {
    store = reopened.store;
  }
  expect(admissions()).toHaveLength(1);
});
