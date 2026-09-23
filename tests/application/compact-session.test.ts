/**
 * `m1-wire-foreground-planning-runtime` D7 的行为测试：手动上下文压缩。
 *
 * 固定三件可观察事实：只有挂起（或已因上下文耗尽阻塞）的 Session 能接受压缩请求；压缩结论与产物
 * 写进该 Session 的 checkpoint，重启后仍能读到；底层历史永远不被 Capsule 覆盖。压缩本身由宿主注入
 * 的回调执行，因此这里用一个可控的 fake 回调，不调用任何模型。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { openCheckpointStore, type CheckpointStore } from '../../src/adapters/storage/checkpoint-store.js';
import { openCoordinationStore, type CoordinationStore } from '../../src/adapters/storage/coordination-store.js';
import {
  requestSessionCompaction,
  type SessionCompactionArtifacts,
} from '../../src/application/coordinator/compact-session.js';
import {
  acquireIncarnation,
  type CoordinatorIncarnation,
} from '../../src/application/coordinator/runtime-guard.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  PlanningCycleId,
  RuntimeIncarnationId,
} from '../../src/application/dto/identity.js';
import type { CoordinationWriter } from '../../src/application/ports/branch-coordination-store.js';
import {
  COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
  assistantEntryId,
  type CoordinatorSessionState,
} from '../../src/domain/coordinator/session-state.js';

const SCOPE = 'scope-1' as CoordinationScopeId;
const SESSION = 'session-a' as CoordinatorSessionId;
const TTL_MS = 30_000;

let directory = '';
let store: CoordinationStore;
let checkpoints: CheckpointStore;
let now = 1_000;
let incarnation: CoordinatorIncarnation;

const clock = (): number => now;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-compact-'));
  now = 1_000;
  const opened = openCoordinationStore({ databasePath: join(directory, 'coordination.sqlite'), clock });
  if (opened.kind !== 'opened') {
    throw new Error(opened.message);
  }
  store = opened.store;
  const checkpointOpened = openCheckpointStore({ databasePath: join(directory, 'checkpoints.sqlite'), clock });
  if (checkpointOpened.kind !== 'opened') {
    throw new Error(checkpointOpened.message);
  }
  checkpoints = checkpointOpened.store;

  const provisional: CoordinationWriter = {
    coordinatorSessionId: SESSION,
    runtimeIncarnationId: 'bootstrap' as RuntimeIncarnationId,
    fencingGeneration: 0,
  };
  const created = store.transact({
    kind: 'create-scope',
    coordinationScopeId: SCOPE,
    expectedRevision: 0,
    writer: provisional,
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
    expectedRevision: 1,
    writer: provisional,
    coordinatorSessionId: SESSION,
    coordinatorModelConfigurationRef: 'model-config-1',
    lifecycleState: 'registered',
  });
  if (registered.kind !== 'committed') {
    throw new Error('无法注册测试 Session');
  }
  const acquired = acquireIncarnation(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION,
    runtimeIncarnationId: 'inc-1' as RuntimeIncarnationId,
    ttlMs: TTL_MS,
  });
  if (acquired.kind !== 'acquired') {
    throw new Error('无法取得测试 Runtime Lease');
  }
  incarnation = acquired.incarnation;
});

afterEach(() => {
  checkpoints.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

/** 一个已有两步历史、停在 `graphPosition` 的 Session。 */
function seedSession(graphPosition: string): CoordinatorSessionState {
  const state: CoordinatorSessionState = {
    schemaVersion: COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
    coordinatorSessionId: SESSION,
    committedMessages: [
      { entryId: assistantEntryId('step-1'), stepId: 'step-1', role: 'assistant', content: '第一步' },
      { entryId: assistantEntryId('step-2'), stepId: 'step-2', role: 'assistant', content: '第二步' },
    ],
    graphPosition,
    committedModelSteps: [
      {
        stepId: 'step-1',
        entryId: assistantEntryId('step-1'),
        committedAt: 1_000,
        messages: [{ role: 'assistant', content: '第一步' }],
        toolCalls: [],
        usage: null,
      },
      {
        stepId: 'step-2',
        entryId: assistantEntryId('step-2'),
        committedAt: 2_000,
        messages: [{ role: 'assistant', content: '第二步' }],
        toolCalls: [],
        usage: null,
      },
    ],
    wakeBatches: [],
    lastCompactionOutcome: null,
  };
  const saved = checkpoints.saveCheckpoint(state);
  if (saved.kind !== 'saved') {
    throw new Error(saved.message);
  }
  return state;
}

const compacted: SessionCompactionArtifacts = {
  outcome: { kind: 'compacted', path: 'context_capsule', compactedTokens: 120, note: '用一个 Capsule 表示更早的两步' },
  capsule: {
    kind: 'derived_context_capsule' as const,
    capsuleId: 'capsule:step-1..step-2',
    replacedFromStepId: 'step-1',
    replacedToStepId: 'step-2',
    text: '[derived context capsule capsule:step-1..step-2]',
  },
  nativeWindowOwner: null,
};

function request(overrides: { readonly inFlightModelOperations?: number } = {}) {
  return requestSessionCompaction({
    store,
    checkpoints,
    incarnation,
    coordinatorSessionId: SESSION,
    reason: 'user-requested',
    inFlightModelOperations: overrides.inFlightModelOperations ?? 0,
    clock,
    compact: () => compacted,
  });
}

test('挂起的 Session 可以手动压缩，结论与产物重启后仍在，历史不被覆盖', () => {
  seedSession('suspend');

  const result = request();

  expect(result).toMatchObject({ kind: 'compacted', capsuleRef: 'capsule:step-1..step-2' });

  const read = checkpoints.loadCheckpoint(SESSION);
  if (read.kind !== 'recovered') {
    throw new Error('checkpoint 应可恢复');
  }
  expect(read.state.lastCompactionOutcome).toEqual(compacted.outcome);
  expect(read.state.contextMaterial?.capsule?.capsuleId).toBe('capsule:step-1..step-2');
  // Capsule 是派生视图：被取代区间的原文仍可读回。
  expect(read.state.committedMessages.map((entry) => entry.content)).toEqual(['第一步', '第二步']);
  expect(checkpoints.loadPortableCapsule(SESSION)?.text).toContain('capsule:step-1..step-2');
});

test('正在运行的 Session 与有在途模型操作时都拒绝压缩', () => {
  seedSession('model');

  expect(request()).toMatchObject({ kind: 'rejected', code: 'not_suspended' });

  // 挂起但有在途模型操作：同样拒绝，因为中途改写输入会产生半压缩状态。
  seedSession('suspend');
  expect(request({ inFlightModelOperations: 1 })).toMatchObject({
    kind: 'rejected',
    code: 'operations_in_flight',
  });

  // 上面两次都零写入：没有结论被写进 checkpoint。
  const read = checkpoints.loadCheckpoint(SESSION);
  if (read.kind !== 'recovered') {
    throw new Error('checkpoint 应可恢复');
  }
  expect(read.state.lastCompactionOutcome).toBeNull();
});

test('已因上下文耗尽阻塞的 Session 与挂起的一样可以再次手动压缩', () => {
  const state = seedSession('model');
  const saved = checkpoints.saveCheckpoint({
    ...state,
    lastCompactionOutcome: { kind: 'context_exhausted', reason: '所有压缩路径均已尝试', stillOverBudget: 42 },
  });
  expect(saved.kind).toBe('saved');

  expect(request()).toMatchObject({ kind: 'compacted' });
});

test('压缩不能收敛时结论被持久化，重启后仍然可见', () => {
  seedSession('suspend');
  const exhausted: SessionCompactionArtifacts = {
    outcome: { kind: 'context_exhausted', reason: '所有压缩路径均已尝试', stillOverBudget: 900 },
    capsule: null,
    nativeWindowOwner: null,
  };

  const result = requestSessionCompaction({
    store,
    checkpoints,
    incarnation,
    coordinatorSessionId: SESSION,
    reason: 'user-requested',
    inFlightModelOperations: 0,
    clock,
    compact: () => exhausted,
  });

  expect(result.kind).toBe('compacted');
  const read = checkpoints.loadCheckpoint(SESSION);
  if (read.kind !== 'recovered') {
    throw new Error('checkpoint 应可恢复');
  }
  expect(read.state.lastCompactionOutcome).toMatchObject({ kind: 'context_exhausted', stillOverBudget: 900 });
  expect(checkpoints.loadPortableCapsule(SESSION)).toBeNull();
});

test('没有会话记录、原因缺失与 fencing 失效都不产生写入', () => {
  expect(request()).toMatchObject({ kind: 'rejected', code: 'no_session' });

  seedSession('suspend');
  const noReason = requestSessionCompaction({
    store,
    checkpoints,
    incarnation,
    coordinatorSessionId: SESSION,
    reason: '  ',
    inFlightModelOperations: 0,
    clock,
    compact: () => compacted,
  });
  expect(noReason).toMatchObject({ kind: 'rejected', code: 'reason_required' });

  const fenced = requestSessionCompaction({
    store,
    checkpoints,
    incarnation: { ...incarnation, fencingGeneration: 99 },
    coordinatorSessionId: SESSION,
    reason: 'user-requested',
    inFlightModelOperations: 0,
    clock,
    compact: () => compacted,
  });
  expect(fenced).toMatchObject({ kind: 'rejected', code: 'fenced' });

  const read = checkpoints.loadCheckpoint(SESSION);
  if (read.kind !== 'recovered') {
    throw new Error('checkpoint 应可恢复');
  }
  expect(read.state.lastCompactionOutcome).toBeNull();
});

test('压缩回调抛错时按阻塞处理并保留原记录', () => {
  seedSession('suspend');

  const result = requestSessionCompaction({
    store,
    checkpoints,
    incarnation,
    coordinatorSessionId: SESSION,
    reason: 'user-requested',
    inFlightModelOperations: 0,
    clock,
    compact: () => {
      throw new Error('历史中出现无法安全归类的项');
    },
  });

  expect(result).toMatchObject({ kind: 'blocked' });
  const read = checkpoints.loadCheckpoint(SESSION);
  if (read.kind !== 'recovered') {
    throw new Error('checkpoint 应可恢复');
  }
  expect(read.state.lastCompactionOutcome).toBeNull();
  expect(read.state.committedMessages).toHaveLength(2);
});

