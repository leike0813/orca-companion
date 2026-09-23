import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { projectActionableWork, type SourceObservation } from '../../src/application/coordinator/actionable-work.js';
import { acquireIncarnation } from '../../src/application/coordinator/runtime-guard.js';
import { suspendSession, SUSPENSION_GRAPH_POSITION } from '../../src/application/coordinator/suspension.js';
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
  directory = mkdtempSync(join(tmpdir(), 'orca-suspend-'));
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

function scopeFacts(): { readonly controlState: string; readonly lifecycle: readonly string[] } {
  const scope = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  const sessions = store.query({ kind: 'sessions', coordinationScopeId: SCOPE });
  return {
    controlState: scope.kind === 'scope' && scope.scope !== null ? scope.scope.controlState : 'missing',
    lifecycle:
      sessions.kind === 'sessions'
        ? sessions.sessions.map((session) => `${session.coordinatorSessionId}:${session.lifecycleState}`)
        : [],
  };
}

function projectionOf(observations: readonly SourceObservation[]) {
  return projectActionableWork({
    coordinatorSessionId: SESSION,
    controlState: 'active',
    observations,
    admitted: [],
  });
}

function observation(classification: SourceObservation['classification'], sourceId: string): SourceObservation {
  return {
    source: { sourceKind: 'delivery', sourceId, revision: 1 },
    classification,
    summary: `work:${sourceId}`,
    ownerCoordinatorSessionId: SESSION,
  };
}

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
        if (batches.some((candidate) => candidate.wakeBatchId === batch.wakeBatchId)) {
          return { kind: 'already-committed', state: state() };
        }
        batches.push(batch);
        return { kind: 'committed', state: state() };
      },
    },
  };
}

test('无 Actionable Work 时挂起是可恢复条件，而不是完成或取消', () => {
  const before = scopeFacts();
  const revisionBefore = revisionOf();

  const suspended = suspendSession({
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION,
    projection: projectionOf([observation('routine_progress', 'task-1')]),
    clock,
  });

  expect(suspended.kind).toBe('suspended');
  if (suspended.kind !== 'suspended') {
    return;
  }
  expect(suspended.state.kind).toBe('suspended');
  expect(suspended.state.graphPosition).toBe(SUSPENSION_GRAPH_POSITION);
  expect(suspended.state.reason).toBe('no_actionable_work');

  // 挂起不写任何协调状态：控制状态、Session 生命周期与 revision 都原样保留。
  expect(scopeFacts()).toEqual(before);
  expect(revisionOf()).toBe(revisionBefore);
});

test('有 Actionable Work 时不得挂起', () => {
  const suspended = suspendSession({
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION,
    projection: projectionOf([observation('worker_question', 'dispatch-1')]),
    clock,
  });

  expect(suspended.kind).toBe('actionable-work');
  if (suspended.kind === 'actionable-work') {
    expect(suspended.items).toHaveLength(1);
  }
});

test('挂起后出现新 Actionable Work 时由同一 Session 恢复，不需要新身份', () => {
  const checkpoints = createCheckpoints();
  const suspended = suspendSession({
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION,
    projection: projectionOf([]),
    clock,
  });
  expect(suspended.kind).toBe('suspended');
  if (suspended.kind !== 'suspended') {
    return;
  }
  const lifecycleAfterSuspend = scopeFacts().lifecycle;

  const acquired = acquireIncarnation(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION,
    runtimeIncarnationId: incarnation('inc-2'),
    ttlMs: TTL_MS,
  });
  expect(acquired.kind).toBe('acquired');
  if (acquired.kind !== 'acquired') {
    return;
  }

  const admitted = admitWakeBatch(store, {
    wakeBatch: {
      wakeBatchId: 'wake-after-suspend',
      coordinationScopeId: SCOPE,
      coordinatorSessionId: SESSION,
      sourceRevisions: [{ sourceKind: 'delivery', sourceId: 'dispatch-1', revision: 1 }],
      actionableWork: [{ workKind: 'worker_question', workId: 'dispatch-1', summary: '需要 Coordinator 回复' }],
    },
    incarnation: acquired.incarnation,
    checkpoints: checkpoints.port,
    clock,
  });

  expect(admitted.kind).toBe('admitted');
  expect(checkpoints.batches).toHaveLength(1);
  // 同一 Session：registry 里没有出现第二个 Session，挂起也没有改变它的生命周期。
  expect(scopeFacts().lifecycle).toEqual(lifecycleAfterSuspend);
  expect(scopeFacts().lifecycle).toEqual([`${SESSION}:registered`]);
});

test('挂起期间到达的工作仍要经过准入，不能跳过 Wake Batch', () => {
  const checkpoints = createCheckpoints();
  const acquired = acquireIncarnation(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION,
    runtimeIncarnationId: incarnation('inc-1'),
    ttlMs: TTL_MS,
  });
  expect(acquired.kind).toBe('acquired');
  if (acquired.kind !== 'acquired') {
    return;
  }

  const admitted = admitWakeBatch(store, {
    wakeBatch: {
      wakeBatchId: 'wake-1',
      coordinationScopeId: SCOPE,
      coordinatorSessionId: SESSION,
      sourceRevisions: [{ sourceKind: 'delivery', sourceId: 'dispatch-1', revision: 1 }],
      actionableWork: [{ workKind: 'worker_question', workId: 'dispatch-1', summary: '问题' }],
    },
    incarnation: acquired.incarnation,
    checkpoints: checkpoints.port,
    clock,
  });
  expect(admitted.kind).toBe('admitted');

  const replay = admitWakeBatch(store, {
    wakeBatch: {
      wakeBatchId: 'wake-1',
      coordinationScopeId: SCOPE,
      coordinatorSessionId: SESSION,
      sourceRevisions: [{ sourceKind: 'delivery', sourceId: 'dispatch-1', revision: 1 }],
      actionableWork: [{ workKind: 'worker_question', workId: 'dispatch-1', summary: '问题' }],
    },
    incarnation: acquired.incarnation,
    checkpoints: checkpoints.port,
    clock,
  });
  expect(replay.kind).toBe('already-admitted');
  expect(checkpoints.batches).toHaveLength(1);
});
