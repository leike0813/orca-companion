/**
 * `m1-wire-foreground-planning-runtime` D4 的行为测试：用户消息的持久提交与准入。
 *
 * 这里覆盖两条真实库（`coordination.sqlite` 与 `checkpoints.sqlite`）上的可观察事实：
 * 消息先落盘再准入；以同一 `submissionId` 重放只产生一条消息与一次模型恢复；暂停时消息仍落盘但
 * 不唤醒模型；Cancel 拒绝新消息；普通消息不满足 Pending Interaction。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { openCheckpointStore, type CheckpointStore } from '../../src/adapters/storage/checkpoint-store.js';
import { openCoordinationStore, type CoordinationStore } from '../../src/adapters/storage/coordination-store.js';
import {
  acquireIncarnation,
  writerFor,
  type CoordinatorIncarnation,
} from '../../src/application/coordinator/runtime-guard.js';
import {
  MAX_USER_MESSAGE_CHARS,
  submitUserMessage,
} from '../../src/application/coordinator/user-message.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  InteractionId,
  PlanningCycleId,
  RuntimeIncarnationId,
} from '../../src/application/dto/identity.js';
import type { CoordinationWriter } from '../../src/application/ports/branch-coordination-store.js';
import { userEntryId } from '../../src/domain/coordinator/session-state.js';

const SCOPE = 'scope-1' as CoordinationScopeId;
const SESSION = 'session-a' as CoordinatorSessionId;
const TTL_MS = 30_000;

let directory = '';
let store: CoordinationStore;
let checkpoints: CheckpointStore;
let now = 1_000;
let incarnationUnderTest: CoordinatorIncarnation;

const clock = (): number => now;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-user-message-'));
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
    expectedRevision: revisionOf(),
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
  incarnationUnderTest = acquired.incarnation;
});

afterEach(() => {
  checkpoints.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

function revisionOf(): number {
  const scope = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  return scope.kind === 'scope' && scope.scope !== null ? scope.scope.revision : 0;
}

const writer = (): CoordinationWriter => writerFor(incarnationUnderTest);

function submit(submissionId: string, content: string) {
  return submitUserMessage({
    store,
    checkpoints,
    incarnation: incarnationUnderTest,
    coordinatorSessionId: SESSION,
    submissionId,
    content,
    clock,
  });
}

function setControlState(state: 'active' | 'paused' | 'cancelled'): void {
  const written = store.transact({
    kind: 'record-control-state',
    coordinationScopeId: SCOPE,
    expectedRevision: revisionOf(),
    writer: writer(),
    controlState: state,
  });
  if (written.kind !== 'committed') {
    throw new Error(`无法把 Scope 置为 ${state}`);
  }
}

function admissions(): readonly string[] {
  const result = store.query({ kind: 'wake-admissions', coordinationScopeId: SCOPE, coordinatorSessionId: SESSION });
  return result.kind === 'wake-admissions' ? result.admissions.map((entry) => entry.wakeBatchId) : [];
}

test('消息先落盘再准入：历史里有一条 entry，IC-03 有一条 source admission', () => {
  const result = submit('submission-1', '请先读一下 Route Map，再告诉我当前 frontier');

  expect(result.kind).toBe('accepted');
  if (result.kind !== 'accepted') {
    return;
  }
  expect(result.wakeModel).toBe(true);
  expect(result.actionableWork).toHaveLength(1);
  expect(admissions()).toEqual(['wake:user:submission-1']);

  const read = checkpoints.loadCheckpoint(SESSION);
  expect(read.kind).toBe('recovered');
  if (read.kind !== 'recovered') {
    return;
  }
  const entry = read.state.committedMessages.find((message) => message.entryId === userEntryId('submission-1'));
  expect(entry).toMatchObject({ role: 'user', content: '请先读一下 Route Map，再告诉我当前 frontier' });
  expect(read.state.wakeBatches.map((batch) => batch.wakeBatchId)).toEqual(['wake:user:submission-1']);
});

test('提交后崩溃：以同一 submissionId 重放只产生一条消息，并补记缺失的准入', () => {
  // 崩溃窗口：消息与 batch 已落 checkpoint，IC-03 还没有准入记录。
  const crashed = checkpoints.commitUserMessage({
    coordinatorSessionId: SESSION,
    submissionId: 'submission-crash',
    content: '继续',
    wakeBatch: {
      wakeBatchId: 'wake:user:submission-crash',
      coordinationScopeId: SCOPE,
      coordinatorSessionId: SESSION,
      sourceRevisions: [{ sourceKind: 'user-message', sourceId: 'submission-crash', revision: 1 }],
      actionableWork: [{ workKind: 'user_message', workId: 'submission-crash', summary: '继续' }],
    },
  });
  expect(crashed.kind).toBe('committed');
  expect(admissions()).toEqual([]);

  const replayed = submit('submission-crash', '继续');
  expect(replayed.kind).toBe('accepted');
  if (replayed.kind !== 'accepted') {
    return;
  }
  expect(replayed.wakeModel).toBe(true);
  expect(replayed.actionableWork).toHaveLength(1);
  expect(replayed.admission.kind).toBe('repaired');
  expect(admissions()).toEqual(['wake:user:submission-crash']);

  const after = checkpoints.loadCheckpoint(SESSION);
  if (after.kind !== 'recovered') {
    throw new Error('checkpoint 应可恢复');
  }
  expect(after.state.committedMessages).toHaveLength(1);
  expect(after.state.wakeBatches).toHaveLength(1);

  // 已经准入且有历史的提交再次重放：不再唤醒模型，也不再写第二条消息。
  const third = submit('submission-crash', '继续');
  expect(third.kind).toBe('accepted');
  if (third.kind !== 'accepted') {
    return;
  }
  expect(third.wakeModel).toBe(false);
  expect(third.actionableWork).toHaveLength(0);
  expect(admissions()).toEqual(['wake:user:submission-crash']);
});

test('同一 submissionId 提交不同内容被拒绝，且不写第二条消息', () => {
  expect(submit('submission-conflict', '第一条').kind).toBe('accepted');

  const conflict = submit('submission-conflict', '完全不同的内容');

  expect(conflict).toMatchObject({ kind: 'rejected', code: 'content_conflict' });
  const read = checkpoints.loadCheckpoint(SESSION);
  if (read.kind !== 'recovered') {
    throw new Error('checkpoint 应可恢复');
  }
  expect(read.state.committedMessages).toHaveLength(1);
});

test('Pause 接受消息但不唤醒模型，Cancel 拒绝新消息', () => {
  setControlState('paused');

  const paused = submit('submission-paused', '暂停期间写下的想法');
  expect(paused.kind).toBe('accepted');
  if (paused.kind !== 'accepted') {
    return;
  }
  expect(paused.wakeModel).toBe(false);
  expect(admissions()).toEqual(['wake:user:submission-paused']);

  setControlState('cancelled');
  const cancelled = submit('submission-cancelled', '取消后不该被接受');

  expect(cancelled).toMatchObject({ kind: 'rejected', code: 'control_state' });
  const read = checkpoints.loadCheckpoint(SESSION);
  if (read.kind !== 'recovered') {
    throw new Error('checkpoint 应可恢复');
  }
  expect(read.state.committedMessages.map((entry) => entry.entryId)).toEqual([
    userEntryId('submission-paused'),
  ]);
});

test('空白与超长内容在写入之前被拒绝', () => {
  expect(submit('submission-blank', '   \n ')).toMatchObject({ kind: 'rejected', code: 'blank_content' });
  expect(submit('submission-long', 'x'.repeat(MAX_USER_MESSAGE_CHARS + 1))).toMatchObject({
    kind: 'rejected',
    code: 'content_too_long',
  });
  expect(checkpoints.loadCheckpoint(SESSION).kind).toBe('absent');
  expect(admissions()).toEqual([]);
});

test('普通消息不满足 Pending Interaction', () => {
  const recorded = store.transact({
    kind: 'record-pending-interaction',
    coordinationScopeId: SCOPE,
    expectedRevision: revisionOf(),
    writer: { ...incarnationUnderTest, runtimeIncarnationId: 'inc-1' as RuntimeIncarnationId },
    interactionId: 'interaction-1' as InteractionId,
    ownerCoordinatorSessionId: SESSION,
    subjectRef: { kind: 'worker-question', id: 'question-1' },
  });
  expect(recorded.kind).toBe('committed');

  expect(submit('submission-does-not-answer', '这就是回答？').kind).toBe('accepted');

  const snapshot = store.query({ kind: 'snapshot', coordinationScopeId: SCOPE });
  if (snapshot.kind !== 'snapshot') {
    throw new Error('snapshot 应可读');
  }
  const interaction = snapshot.snapshot.pendingInteractions.find(
    (entry) => entry.interactionId === ('interaction-1' as InteractionId),
  );
  expect(interaction?.state).toBe('open');
  expect(interaction?.answerText).toBeNull();
});

test('fencing 失效时拒绝写入，且不产生消息或准入', () => {
  const stale: CoordinatorIncarnation = { ...incarnationUnderTest, fencingGeneration: 99 };

  const rejected = submitUserMessage({
    store,
    checkpoints,
    incarnation: stale,
    coordinatorSessionId: SESSION,
    submissionId: 'submission-fenced',
    content: '不该被接受',
    clock,
  });

  expect(rejected).toMatchObject({ kind: 'rejected', code: 'fenced' });
  expect(checkpoints.loadCheckpoint(SESSION).kind).toBe('absent');
  expect(admissions()).toEqual([]);
});
