import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Annotation, StateGraph } from '@langchain/langgraph';
import { afterEach, beforeEach, expect, test } from 'vitest';

import type { CoordinatorSessionId } from '../../src/application/dto/identity.js';
import {
  CHECKPOINT_SCHEMA_VERSION,
  openCheckpointStore,
  type CheckpointStore,
} from '../../src/adapters/storage/checkpoint-store.js';
import {
  COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
  type CommittedModelStep,
  type CoordinatorSessionState,
  type WakeBatch,
} from '../../src/domain/coordinator/session-state.js';
import { COORDINATOR_DURABILITY } from '../../src/workflow/coordinator/state.js';

const SESSION_A = 'session-a' as CoordinatorSessionId;
const SESSION_B = 'session-b' as CoordinatorSessionId;

let directory = '';
let databasePath = '';
let store: CheckpointStore;
let openedStores: CheckpointStore[] = [];
let now = 5_000;

const clock = (): number => now;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-checkpoints-'));
  databasePath = join(directory, 'checkpoints.sqlite');
  now = 5_000;
  openedStores = [];
  store = open();
});

afterEach(() => {
  for (const opened of openedStores) {
    opened.close();
  }
  rmSync(directory, { recursive: true, force: true });
});

function open(): CheckpointStore {
  const opened = openCheckpointStore({ databasePath, clock });
  if (opened.kind !== 'opened') {
    throw new Error(opened.message);
  }
  openedStores.push(opened.store);
  return opened.store;
}

function step(stepId: string, content: string, at: number): CommittedModelStep {
  return {
    stepId,
    committedAt: at,
    messages: [{ role: 'assistant', content }],
    usage: null,
  };
}

function sessionState(
  coordinatorSessionId: CoordinatorSessionId,
  overrides: Partial<CoordinatorSessionState> = {},
): CoordinatorSessionState {
  return {
    schemaVersion: COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
    coordinatorSessionId,
    committedMessages: [
      { role: 'user', content: '开始规划' },
      { role: 'assistant', content: '先读地图' },
    ],
    graphPosition: 'model',
    committedModelSteps: [step('step-1', '先读地图', 1_000)],
    wakeBatches: [],
    ...overrides,
  };
}

function rawDatabase(): DatabaseSync {
  return new DatabaseSync(databasePath);
}

test('两个 Session 各自读回自己的会话状态，互不影响', () => {
  expect(store.saveCheckpoint(sessionState(SESSION_A)).kind).toBe('saved');
  expect(store.saveCheckpoint(sessionState(SESSION_B, {
    committedMessages: [{ role: 'user', content: '另一个 Session 的对话' }],
    graphPosition: 'suspend',
  })).kind).toBe('saved');

  const readA = store.loadCheckpoint(SESSION_A);
  const readB = store.loadCheckpoint(SESSION_B);

  expect(readA.kind).toBe('recovered');
  expect(readB.kind).toBe('recovered');
  if (readA.kind === 'recovered' && readB.kind === 'recovered') {
    expect(readA.state.coordinatorSessionId).toBe(SESSION_A);
    expect(readA.state.graphPosition).toBe('model');
    expect(readB.state.coordinatorSessionId).toBe(SESSION_B);
    expect(readB.state.graphPosition).toBe('suspend');
    expect(readA.state.committedMessages).not.toEqual(readB.state.committedMessages);
  }

  // 写 A 之后再读 B：B 的可读状态没有变化。
  const beforeB = JSON.stringify(readB);
  expect(store.saveCheckpoint(sessionState(SESSION_A, { graphPosition: 'suspend' })).kind).toBe('saved');
  expect(JSON.stringify(store.loadCheckpoint(SESSION_B))).toBe(beforeB);
});

test('从未写入过的 Session 报告 absent，而不是空历史', () => {
  expect(store.loadCheckpoint(SESSION_A)).toEqual({ kind: 'absent' });
});

test('损坏的会话记录报告 unrecoverable，不降级成空历史', () => {
  expect(store.saveCheckpoint(sessionState(SESSION_A)).kind).toBe('saved');
  const raw = rawDatabase();
  raw.prepare('UPDATE coordinator_sessions SET session_state = ? WHERE coordinator_session_id = ?').run(
    '{ not json',
    SESSION_A,
  );
  raw.close();

  const read = store.loadCheckpoint(SESSION_A);
  expect(read.kind).toBe('unrecoverable');
});

test('被 Capsule 取代的区间仍能读回原始已提交消息', () => {
  const state = sessionState(SESSION_A, {
    committedModelSteps: [step('step-1', '第一步', 1_000), step('step-2', '第二步', 2_000), step('step-3', '第三步', 3_000)],
    committedMessages: [
      { role: 'assistant', content: '第一步' },
      { role: 'assistant', content: '第二步' },
      { role: 'assistant', content: '第三步' },
    ],
  });
  expect(store.saveCheckpoint(state).kind).toBe('saved');
  expect(
    store.savePortableCapsule(SESSION_A, {
      kind: 'derived_context_capsule',
      capsuleId: 'capsule-1',
      replacedFromStepId: 'step-1',
      replacedToStepId: 'step-2',
      text: '前两步的派生摘要',
    }).kind,
  ).toBe('saved');

  const read = store.loadCheckpoint(SESSION_A);
  expect(read.kind).toBe('recovered');
  if (read.kind === 'recovered') {
    // 底层完整对话仍在：Capsule 只是派生视图，不覆盖原始消息。
    expect(read.state.committedMessages).toHaveLength(3);
    expect(read.state.contextMaterial?.capsule?.capsuleId).toBe('capsule-1');
  }

  expect(store.readCommittedMessages(SESSION_A)).toHaveLength(3);
  expect(store.readCommittedMessages(SESSION_A, {
    replacedFromStepId: 'step-1',
    replacedToStepId: 'step-2',
  })).toEqual([
    { role: 'assistant', content: '第一步' },
    { role: 'assistant', content: '第二步' },
  ]);
});

test('两类压缩产物分字段保存；原生项损坏时阻塞会话但不损坏 Capsule', () => {
  expect(store.saveCheckpoint(sessionState(SESSION_A)).kind).toBe('saved');
  expect(
    store.saveNativeWindowOwner(SESSION_A, {
      ownerRef: 'provider:minimax-m3:generation-2',
      items: [{ itemId: 'enc-1', position: 0, mediaType: 'application/octet-stream', opaque: { blob: 'AAAA' } }],
    }).kind,
  ).toBe('saved');
  expect(
    store.savePortableCapsule(SESSION_A, {
      kind: 'derived_context_capsule',
      capsuleId: 'capsule-1',
      replacedFromStepId: 'step-1',
      replacedToStepId: 'step-1',
      text: '摘要',
    }).kind,
  ).toBe('saved');

  const both = store.loadCheckpoint(SESSION_A);
  expect(both.kind).toBe('recovered');
  if (both.kind === 'recovered') {
    expect(both.state.contextMaterial?.nativeWindowOwner?.items).toHaveLength(1);
    expect(both.state.contextMaterial?.capsule?.capsuleId).toBe('capsule-1');
  }

  // 只更新原生窗口 owner：Capsule 原样保留。
  expect(
    store.saveNativeWindowOwner(SESSION_A, {
      ownerRef: 'provider:minimax-m3:generation-3',
      items: [{ itemId: 'enc-2', position: 0, mediaType: 'application/octet-stream', opaque: { blob: 'BBBB' } }],
    }).kind,
  ).toBe('saved');
  expect(store.loadPortableCapsule(SESSION_A)?.capsuleId).toBe('capsule-1');

  // 损坏原生窗口一侧：Capsule 仍可单独读回，但完整会话必须 fail closed。
  const raw = rawDatabase();
  raw.prepare('UPDATE native_window_owners SET items = ? WHERE coordinator_session_id = ?').run(
    '[[[',
    SESSION_A,
  );
  raw.close();

  expect(() => store.loadNativeWindowOwner(SESSION_A)).toThrow(/原生压缩项不可恢复/);
  expect(store.loadPortableCapsule(SESSION_A)?.capsuleId).toBe('capsule-1');
  const degraded = store.loadCheckpoint(SESSION_A);
  expect(degraded.kind).toBe('unrecoverable');
  if (degraded.kind === 'unrecoverable') {
    expect(degraded.reason).toContain('原生压缩项不可恢复');
  }
});

test('没有先写会话记录时不能单独写压缩产物', () => {
  const result = store.savePortableCapsule(SESSION_A, {
    kind: 'derived_context_capsule',
    capsuleId: 'capsule-1',
    replacedFromStepId: 'step-1',
    replacedToStepId: 'step-1',
    text: '摘要',
  });

  expect(result.kind).toBe('failed');
  expect(store.loadCheckpoint(SESSION_A)).toEqual({ kind: 'absent' });
});

test('含凭据的候选会话状态被拒绝，库内不留记录', () => {
  const candidate = { ...sessionState(SESSION_A), apiKey: 'sk-live-1' };
  const result = store.saveCheckpoint(candidate);

  expect(result.kind).toBe('failed');
  expect(store.loadCheckpoint(SESSION_A)).toEqual({ kind: 'absent' });
});

test('同一 WakeBatchId 只追加一次会话历史', () => {
  const batch: WakeBatch = {
    wakeBatchId: 'wake-1',
    coordinationScopeId: 'scope-1',
    coordinatorSessionId: SESSION_A,
    sourceRevisions: [{ sourceKind: 'delivery', sourceId: 'delivery-1', revision: 2 }],
    actionableWork: [{ workKind: 'worker_question', workId: 'dispatch-1', summary: '问题' }],
  };

  const first = store.commitWakeBatch(batch);
  expect(first.kind).toBe('committed');
  const second = store.commitWakeBatch(batch);
  expect(second.kind).toBe('already-committed');

  const read = store.loadCheckpoint(SESSION_A);
  expect(read.kind).toBe('recovered');
  if (read.kind === 'recovered') {
    expect(read.state.wakeBatches).toHaveLength(1);
  }
});

test('checkpoint 文件同时保存 LangGraph 图状态与会话记录，两者互不干扰', async () => {
  const saver = store.checkpointer;
  const State = Annotation.Root({
    note: Annotation({ reducer: (_left: string, right: string) => right, default: () => '' }),
  });
  const graph = new StateGraph(State)
    .addNode('record', (state: { readonly note: string }) => ({ note: `${state.note}+` }))
    .addEdge('__start__', 'record')
    .addEdge('record', '__end__')
    .compile({ checkpointer: saver });

  const config = { configurable: { thread_id: 'thread-1' } };
  await graph.invoke({ note: 'step' }, { ...config, durability: COORDINATOR_DURABILITY });

  const raw = rawDatabase();
  const tables = (
    raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as readonly {
      readonly name: string;
    }[]
  ).map((row) => row.name);
  raw.close();

  expect(tables).toContain('checkpoints');
  expect(tables).toContain('writes');
  expect(tables).toContain('coordinator_sessions');
  expect(tables).toContain('native_window_owners');
  expect(tables).toContain('portable_capsules');

  const noteOf = async (): Promise<string> => {
    const snapshot = (await graph.getState(config)) as { readonly values: { readonly note: string } };
    return snapshot.values.note;
  };
  expect(await noteOf()).toBe('step+');
  // 图线程与会话记录互不覆盖：写入会话记录后图状态仍然可读。
  expect(store.saveCheckpoint(sessionState(SESSION_A)).kind).toBe('saved');
  expect(await noteOf()).toBe('step+');
  expect(store.loadCheckpoint(SESSION_A).kind).toBe('recovered');
});

test('重新打开同一个库时 migration 可重入，schema 版本更高时拒绝启动', () => {
  expect(store.saveCheckpoint(sessionState(SESSION_A)).kind).toBe('saved');
  store.close();

  const reopened = open();
  const read = reopened.loadCheckpoint(SESSION_A);
  expect(read.kind).toBe('recovered');

  // 版本高于实现时不能猜：拒绝打开。
  reopened.close();
  const raw = rawDatabase();
  raw
    .prepare('UPDATE checkpoint_meta SET value = ? WHERE key = ?')
    .run(String(CHECKPOINT_SCHEMA_VERSION + 5), 'checkpoint_schema_version');
  raw.close();

  const tooNew = openCheckpointStore({ databasePath, clock });
  expect(tooNew.kind).toBe('failed');
  if (tooNew.kind === 'failed') {
    expect(tooNew.code).toBe('schema_version_unsupported');
  }
});

test('库文件只在给定路径产生，不与 coordination.sqlite 共用', () => {
  expect(existsSync(databasePath)).toBe(true);
  expect(existsSync(join(directory, 'coordination.sqlite'))).toBe(false);
});
