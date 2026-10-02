/**
 * IP-02：只读提交核验的行为测试（design D8）。
 *
 * 覆盖封闭的四值结果与关键边界：普通消息按 `submissionId` + 正文、回答按
 * `JSON.stringify([interactionId, submissionId])` 派生的 `answerRef`；被别的身份解决、绑定 revision
 * 过期、owner 不符、权威记录不可读与非法查询都不得被投影成成功。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { openCheckpointStore, type CheckpointStore } from '../../src/adapters/storage/checkpoint-store.js';
import {
  openCoordinationStore,
  type CoordinationStore,
} from '../../src/adapters/storage/coordination-store.js';
import { answerPendingInteraction } from '../../src/application/coordination/pending-interaction.js';
import {
  acquireIncarnation,
  writerFor,
  type CoordinatorIncarnation,
} from '../../src/application/coordinator/runtime-guard.js';
import {
  querySubmission,
  type SubmissionQuery,
  type SubmissionStatus,
} from '../../src/application/coordinator/submission-status.js';
import type { BranchCoordinationStore } from '../../src/application/ports/branch-coordination-store.js';
import type { CoordinationWriter } from '../../src/application/ports/branch-coordination-store.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  InteractionId,
  PlanningCycleId,
  RuntimeIncarnationId,
} from '../../src/application/dto/identity.js';
import type { WakeBatch } from '../../src/domain/coordinator/session-state.js';
import { userEntryId } from '../../src/domain/coordinator/session-state.js';

const SCOPE = 'scope-1' as CoordinationScopeId;
const SESSION = 'session-a' as CoordinatorSessionId;
const OTHER_SESSION = 'session-b' as CoordinatorSessionId;
const TTL_MS = 30_000;

let directory = '';
let store: CoordinationStore;
let checkpoints: CheckpointStore;
let incarnation: CoordinatorIncarnation;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-submission-status-'));
  const opened = openCoordinationStore({ databasePath: join(directory, 'coordination.sqlite') });
  if (opened.kind !== 'opened') {
    throw new Error(opened.message);
  }
  store = opened.store;
  const checkpointOpened = openCheckpointStore({ databasePath: join(directory, 'checkpoints.sqlite') });
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
  for (const sessionId of [SESSION, OTHER_SESSION]) {
    const registered = store.transact({
      kind: 'register-session',
      coordinationScopeId: SCOPE,
      expectedRevision: revisionOf(),
      // 写入者身份必须与被注册的 Session 一致，否则注册被拒绝。
      writer: { ...provisional, coordinatorSessionId: sessionId },
      coordinatorSessionId: sessionId,
      coordinatorModelConfigurationRef: 'model-config-1',
      lifecycleState: 'registered',
    });
    if (registered.kind !== 'committed') {
      throw new Error(`无法注册 Session ${sessionId}`);
    }
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

function revisionOf(): number {
  const scope = store.query({ kind: 'scope', coordinationScopeId: SCOPE });
  return scope.kind === 'scope' && scope.scope !== null ? scope.scope.revision : 0;
}

function wakeBatch(wakeBatchId: string): WakeBatch {
  return {
    wakeBatchId,
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION,
    sourceRevisions: [{ sourceKind: 'delivery', sourceId: 'delivery-1', revision: 2 }],
    actionableWork: [{ workKind: 'worker_question', workId: 'dispatch-1', summary: '问题' }],
  };
}

function commitMessage(submissionId: string, content: string): void {
  const committed = checkpoints.commitUserMessage({
    coordinatorSessionId: SESSION,
    submissionId,
    content,
    wakeBatch: wakeBatch(`wake:${submissionId}`),
  });
  if (committed.kind !== 'committed') {
    throw new Error(`消息落盘失败：${committed.kind}`);
  }
}

function queryMessage(submissionId: string, content: string): SubmissionStatus {
  return querySubmission({
    store,
    checkpoints,
    coordinationScopeId: SCOPE,
    input: { kind: 'message', coordinatorSessionId: SESSION, submissionId, content },
  });
}

function recordInteraction(interactionId: string, owner: CoordinatorSessionId = SESSION): number {
  const committed = store.transact({
    kind: 'record-pending-interaction',
    coordinationScopeId: SCOPE,
    expectedRevision: revisionOf(),
    writer: writerFor(incarnation),
    interactionId: interactionId as InteractionId,
    ownerCoordinatorSessionId: owner,
    subjectRef: { kind: 'worker-question', id: `question:${interactionId}` },
  });
  if (committed.kind !== 'committed') {
    throw new Error('无法记录 Pending Interaction');
  }
  const snapshot = store.query({ kind: 'snapshot', coordinationScopeId: SCOPE });
  const record =
    snapshot.kind === 'snapshot'
      ? snapshot.snapshot.pendingInteractions.find(
          (candidate) => candidate.interactionId === (interactionId as InteractionId),
        )
      : undefined;
  if (record === undefined) {
    throw new Error('无法读回交互绑定');
  }
  return record.expectedRevision;
}

function answer(interactionId: string, submissionId: string, expectedRevision: number, text: string): void {
  const result = answerPendingInteraction({
    store,
    coordinationScopeId: SCOPE,
    writer: writerFor(incarnation),
    submissionId,
    interactionId: interactionId as InteractionId,
    expectedRevision,
    answer: text,
  });
  if (result.kind !== 'answered') {
    throw new Error(`回答落盘失败：${result.kind === 'rejected' ? result.code : 'unknown'}`);
  }
}

function queryAnswer(
  interactionId: string,
  submissionId: string,
  content: string,
  expectedRevision: number,
  coordinatorSessionId: CoordinatorSessionId = SESSION,
): SubmissionStatus {
  const input: SubmissionQuery = {
    kind: 'answer',
    coordinatorSessionId,
    submissionId,
    content,
    interactionId,
    expectedRevision,
  };
  return querySubmission({ store, checkpoints, coordinationScopeId: SCOPE, input });
}

test('普通消息存在且内容一致时返回已受理，并给出权威引用', () => {
  commitMessage('submission-1', '开始规划');
  expect(queryMessage('submission-1', '开始规划')).toEqual({
    kind: 'accepted',
    ref: { kind: 'user-message', id: userEntryId('submission-1') },
  });
});

test('普通消息不存在时返回未发现，同一身份内容不同时返回内容冲突', () => {
  expect(queryMessage('submission-missing', '任何正文')).toEqual({ kind: 'not-found' });

  commitMessage('submission-1', '开始规划');
  const conflict = queryMessage('submission-1', '改过的内容');
  expect(conflict.kind).toBe('conflict');
  expect(conflict.kind === 'conflict' ? conflict.code : null).toBe('content_conflict');
});

test('回答被同一 submissionId 解决时返回已受理，引用由 interaction 与 submissionId 派生', () => {
  const binding = recordInteraction('interaction-1');
  answer('interaction-1', 'submission-answer-1', binding, '按方案 B 执行');

  expect(queryAnswer('interaction-1', 'submission-answer-1', '按方案 B 执行', binding)).toEqual({
    kind: 'accepted',
    ref: { kind: 'interaction-answer', id: JSON.stringify(['interaction-1', 'submission-answer-1']) },
  });
});

test('被别的 submissionId 回答的问题不算本次成功；同身份不同正文判为冲突', () => {
  const binding = recordInteraction('interaction-2');
  answer('interaction-2', 'submission-answer-2', binding, '按方案 B 执行');

  const other = queryAnswer('interaction-2', 'submission-answer-other', '按方案 B 执行', binding);
  expect(other.kind).toBe('conflict');
  expect(other.kind === 'conflict' ? other.code : null).toBe('answered_by_other');

  const changed = queryAnswer('interaction-2', 'submission-answer-2', '完全不同的话', binding);
  expect(changed.kind).toBe('conflict');
  expect(changed.kind === 'conflict' ? changed.code : null).toBe('content_conflict');
});

test('仍开放但绑定 revision 过期时判为冲突，而不是未发现', () => {
  const binding = recordInteraction('interaction-3');
  const stale = queryAnswer('interaction-3', 'submission-x', '正文', binding - 1);
  expect(stale.kind).toBe('conflict');
  expect(stale.kind === 'conflict' ? stale.code : null).toBe('stale_revision');

  // 绑定一致且仍未回答：这次提交确实没被受理。
  expect(queryAnswer('interaction-3', 'submission-x', '正文', binding)).toEqual({ kind: 'not-found' });
});

test('owner Session 与查询不一致时不可核验，不当作别人的成功或失败', () => {
  const binding = recordInteraction('interaction-4', OTHER_SESSION);
  const status = queryAnswer('interaction-4', 'submission-y', '正文', binding, SESSION);
  expect(status.kind).toBe('unverifiable');
});

test('未注册的 Session 与非法查询都返回不可核验', () => {
  commitMessage('submission-1', '开始规划');
  const unregistered = querySubmission({
    store,
    checkpoints,
    coordinationScopeId: SCOPE,
    input: {
      kind: 'message',
      coordinatorSessionId: 'session-unknown',
      submissionId: 'submission-1',
      content: '开始规划',
    },
  });
  expect(unregistered.kind).toBe('unverifiable');

  // 缺字段/空 submissionId 是非法输入，不能被当成「未发现」。
  const invalid = querySubmission({
    store,
    checkpoints,
    coordinationScopeId: SCOPE,
    input: {
      kind: 'message',
      coordinatorSessionId: SESSION,
      submissionId: '',
      content: '开始规划',
    } as never,
  });
  expect(invalid.kind).toBe('unverifiable');
});

test('权威 checkpoint 损坏时不猜结果：返回不可核验', () => {
  commitMessage('submission-corrupt', '开始规划');
  const raw = new DatabaseSync(join(directory, 'checkpoints.sqlite'));
  raw
    .prepare('UPDATE coordinator_sessions SET session_state = ? WHERE coordinator_session_id = ?')
    .run('{', SESSION);
  raw.close();

  const status = queryMessage('submission-corrupt', '开始规划');
  expect(status.kind).toBe('unverifiable');
});

test('store 读取抛出异常时返回不可核验，而不是让异常冒泡', () => {
  const throwing = {
    query: () => {
      throw new Error('coordination store 不可达');
    },
  } as unknown as BranchCoordinationStore;

  const status = querySubmission({
    store: throwing,
    checkpoints,
    coordinationScopeId: SCOPE,
    input: {
      kind: 'message',
      coordinatorSessionId: SESSION,
      submissionId: 'submission-1',
      content: '正文',
    },
  });
  expect(status.kind).toBe('unverifiable');
});
