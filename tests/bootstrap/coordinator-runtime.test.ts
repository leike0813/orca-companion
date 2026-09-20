import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import type { Runnable } from '@langchain/core/runnables';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { acquireIncarnation } from '../../src/application/coordinator/runtime-guard.js';
import type { CoordinatorModelConfiguration } from '../../src/application/coordinator/model-config-switch.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  PlanningCycleId,
  RuntimeIncarnationId,
} from '../../src/application/dto/identity.js';
import type { CoordinationWriter } from '../../src/application/ports/branch-coordination-store.js';
import { openCoordinationStore, type CoordinationStore } from '../../src/adapters/storage/coordination-store.js';
import {
  checkpointDatabasePath,
  CHECKPOINT_STORE_FILENAME,
  startCoordinatorRuntime,
} from '../../src/bootstrap/coordinator-runtime.js';
import { COMPANION_STATE_DIRECTORY } from '../../src/bootstrap/composition.js';
import { openCheckpointStore } from '../../src/adapters/storage/checkpoint-store.js';
import {
  COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
  type CoordinatorSessionState,
} from '../../src/domain/coordinator/session-state.js';

const SCOPE = 'scope-1' as CoordinationScopeId;
const SESSION = 'session-a' as CoordinatorSessionId;
const TTL_MS = 30_000;

/** 全能力假模型：只用于让启动路径通过能力核验。 */
class CapableChatModel extends BaseChatModel {
  constructor() {
    super({});
  }

  override _llmType(): string {
    return 'capable';
  }

  override _generate(
    _messages: BaseMessage[],
    options: { readonly signal?: AbortSignal } | undefined,
  ): Promise<ChatResult> {
    if (options?.signal?.aborted === true) {
      const aborted = new Error('调用已被取消');
      aborted.name = 'AbortError';
      return Promise.reject(aborted);
    }
    const message = new AIMessage('pong');
    (message as { usage_metadata?: unknown }).usage_metadata = {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
    };
    return Promise.resolve({ generations: [{ text: 'pong', message }] });
  }

  override bindTools(tools: readonly unknown[]): Runnable {
    void tools;
    return this;
  }
}

/** 不支持工具调用的假模型：用于核验失败路径。 */
class NoToolsChatModel extends CapableChatModel {
  override bindTools(): Runnable {
    return { invoke: (): Promise<never> => Promise.reject(new Error('不支持工具')) } as unknown as Runnable;
  }
}

let directory = '';
let gitCommonDir = '';
let store: CoordinationStore;
let now = 1_000;

const clock = (): number => now;
const incarnation = (value: string): RuntimeIncarnationId => value as RuntimeIncarnationId;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-runtime-'));
  gitCommonDir = join(directory, 'common');
  now = 1_000;
  const opened = openCoordinationStore({
    databasePath: join(gitCommonDir, COMPANION_STATE_DIRECTORY, 'coordination.sqlite'),
    clock,
  });
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
    coordinatorModelConfigurationRef: 'coordinator-default',
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

function leaseCount(): number {
  const result = store.query({ kind: 'leases', coordinationScopeId: SCOPE });
  return result.kind === 'leases' ? result.leases.filter((lease) => lease.releasedAt === null).length : -1;
}

function configuration(): CoordinatorModelConfiguration {
  return {
    configurationRef: 'coordinator-default',
    providerIntegration: '@langchain/openai#ChatOpenAI',
    model: 'MiniMax-M3',
    modelOptions: {},
    credentialRefs: [],
    nativeWindowOwnerRef: null,
  };
}

function options(model: BaseChatModel) {
  return {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION,
    runtimeIncarnationId: incarnation('inc-1'),
    configuration: configuration(),
    resolveModel: () => Promise.resolve({ kind: 'resolved' as const, model }),
    gitCommonDir,
    coordinationStore: store,
    ttlMs: TTL_MS,
    clock,
    probeTimeoutMs: 2_000,
  };
}

function checkpointPath(): string {
  return checkpointDatabasePath(gitCommonDir);
}

test('核验通过后才建立 Session：打开 checkpoint store 并取得 Runtime Lease', async () => {
  const started = await startCoordinatorRuntime(options(new CapableChatModel()));

  expect(started.kind).toBe('started');
  if (started.kind !== 'started') {
    return;
  }
  expect(started.recovered).toBe(false);
  expect(started.sessionState).toBeNull();
  expect(started.incarnation.coordinatorSessionId).toBe(SESSION);
  expect(started.incarnation.fencingGeneration).toBe(1);
  expect(started.unresolvedIntents).toEqual([]);
  expect(existsSync(checkpointPath())).toBe(true);
  expect(leaseCount()).toBe(1);
  started.close();
});

test('配置的集成不可用时拒绝启动，且不建立 Session、不取得 lease、不建库', async () => {
  const started = await startCoordinatorRuntime({
    ...options(new CapableChatModel()),
    resolveModel: () => Promise.resolve({ kind: 'failed' as const, message: 'provider 集成不可用' }),
  });

  expect(started.kind).toBe('rejected');
  if (started.kind === 'rejected') {
    expect(started.code).toBe('model_resolution_failed');
  }
  expect(existsSync(checkpointPath())).toBe(false);
  expect(leaseCount()).toBe(0);
});

test('缺少 tool calling 时拒绝启动，且核验先于 Session 建立', async () => {
  const started = await startCoordinatorRuntime(options(new NoToolsChatModel()));

  expect(started.kind).toBe('rejected');
  if (started.kind === 'rejected') {
    expect(started.code).toBe('capability_missing');
    expect(started.message).toContain('tool_calling');
  }
  expect(existsSync(checkpointPath())).toBe(false);
  expect(leaseCount()).toBe(0);
});

test('Runtime Lease 仍由存活 incarnation 持有时拒绝第二个进程', async () => {
  const first = acquireIncarnation(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION,
    runtimeIncarnationId: incarnation('inc-alive'),
    ttlMs: TTL_MS,
  });
  expect(first.kind).toBe('acquired');

  const started = await startCoordinatorRuntime(options(new CapableChatModel()));

  expect(started.kind).toBe('rejected');
  if (started.kind === 'rejected') {
    expect(started.code).toBe('incarnation_rejected');
    // 拒绝原因指向仍然存活的那个 incarnation，便于运维判断谁还活着。
    expect(started.message).toContain('inc-alive');
  }
  // 被拒绝的启动不写入任何会话记录。
  const opened = openCheckpointStore({ databasePath: checkpointPath(), clock });
  expect(opened.kind).toBe('opened');
  if (opened.kind === 'opened') {
    expect(opened.store.loadCheckpoint(SESSION)).toEqual({ kind: 'absent' });
    opened.store.close();
  }
});

test('已有会话记录时恢复同一 Session，不创建新身份', async () => {
  const opened = openCheckpointStore({ databasePath: checkpointPath(), clock });
  if (opened.kind !== 'opened') {
    throw new Error(opened.message);
  }
  const state: CoordinatorSessionState = {
    schemaVersion: COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
    coordinatorSessionId: SESSION,
    committedMessages: [{ role: 'assistant', content: '先读地图' }],
    graphPosition: 'suspend',
    committedModelSteps: [],
    wakeBatches: [],
  };
  expect(opened.store.saveCheckpoint(state).kind).toBe('saved');
  opened.store.close();

  const started = await startCoordinatorRuntime(options(new CapableChatModel()));

  expect(started.kind).toBe('started');
  if (started.kind !== 'started') {
    return;
  }
  expect(started.recovered).toBe(true);
  expect(started.sessionState?.coordinatorSessionId).toBe(SESSION);
  expect(started.sessionState?.committedMessages).toHaveLength(1);
  started.close();
});

test('曾经运行过但 checkpoint 缺失时拒绝启动，不以空历史继续', async () => {
  const first = acquireIncarnation(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION,
    runtimeIncarnationId: incarnation('inc-old'),
    ttlMs: TTL_MS,
  });
  expect(first.kind).toBe('acquired');
  now += TTL_MS + 1;

  const started = await startCoordinatorRuntime({
    ...options(new CapableChatModel()),
    runtimeIncarnationId: incarnation('inc-new'),
  });

  expect(started.kind).toBe('rejected');
  if (started.kind === 'rejected') {
    expect(started.code).toBe('checkpoint_store_failed');
    expect(started.message).toContain('曾经运行过');
  }
});

test('会话库损坏时拒绝启动，不创建替代 Session', async () => {
  const opened = openCheckpointStore({ databasePath: checkpointPath(), clock });
  if (opened.kind !== 'opened') {
    throw new Error(opened.message);
  }
  opened.store.saveCheckpoint({
    schemaVersion: COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
    coordinatorSessionId: SESSION,
    committedMessages: [],
    graphPosition: 'start',
    committedModelSteps: [],
    wakeBatches: [],
  });
  opened.store.close();

  const raw = new DatabaseSync(checkpointPath());
  raw.prepare('UPDATE coordinator_sessions SET session_state = ?').run('{ broken');
  raw.close();

  const started = await startCoordinatorRuntime(options(new CapableChatModel()));

  expect(started.kind).toBe('rejected');
  if (started.kind === 'rejected') {
    expect(started.code).toBe('checkpoint_store_failed');
  }
  // 未决意图仍然留在原处，等待人工处理。
  const sessions = store.query({ kind: 'sessions', coordinationScopeId: SCOPE });
  expect(sessions.kind === 'sessions' ? sessions.sessions : []).toHaveLength(1);
});

test('checkpoint store 与 coordination store 在同一私有目录但不同文件', () => {
  expect(checkpointPath()).toBe(join(gitCommonDir, COMPANION_STATE_DIRECTORY, CHECKPOINT_STORE_FILENAME));
  expect(CHECKPOINT_STORE_FILENAME).toBe('checkpoints.sqlite');
  expect(CHECKPOINT_STORE_FILENAME).not.toBe('coordination.sqlite');
});

test('启动把未决 Operation Intent 原样交给调用方，不代替它做对账', async () => {
  const first = acquireIncarnation(store, {
    coordinationScopeId: SCOPE,
    coordinatorSessionId: SESSION,
    runtimeIncarnationId: incarnation('inc-seed'),
    ttlMs: TTL_MS,
  });
  expect(first.kind).toBe('acquired');
  if (first.kind !== 'acquired') {
    return;
  }
  const begun = store.transact({
    kind: 'begin-intent',
    coordinationScopeId: SCOPE,
    expectedRevision: revisionOf(),
    writer: {
      coordinatorSessionId: SESSION,
      runtimeIncarnationId: incarnation('inc-seed'),
      fencingGeneration: first.incarnation.fencingGeneration,
    },
    operationId: 'op-1' as never,
    target: { kind: 'worker_task', id: 'task-1' },
    operationCategory: 'dispatch',
  });
  expect(begun.kind).toBe('committed');
  const opened = openCheckpointStore({ databasePath: checkpointPath(), clock });
  if (opened.kind !== 'opened') {
    throw new Error(opened.message);
  }
  expect(opened.store.saveCheckpoint({
    schemaVersion: COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
    coordinatorSessionId: SESSION,
    committedMessages: [],
    graphPosition: 'suspend',
    committedModelSteps: [],
    wakeBatches: [],
  }).kind).toBe('saved');
  opened.store.close();
  now += TTL_MS + 1;

  const started = await startCoordinatorRuntime(options(new CapableChatModel()));

  expect(started.kind).toBe('started');
  if (started.kind !== 'started') {
    return;
  }
  expect(started.unresolvedIntents.map((intent) => intent.operationId)).toEqual(['op-1']);
  started.close();
});

test('会话记录文件确实落在 Companion 私有目录下', async () => {
  const started = await startCoordinatorRuntime(options(new CapableChatModel()));
  expect(started.kind).toBe('started');
  if (started.kind !== 'started') {
    return;
  }
  started.close();

  const contents = readFileSync(checkpointPath()).subarray(0, 16).toString('utf8');
  expect(contents.startsWith('SQLite format 3')).toBe(true);
});
