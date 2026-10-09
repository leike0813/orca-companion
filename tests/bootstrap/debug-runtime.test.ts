/**
 * IP-04 / D-04：调试宿主的持久会话、单写者、提交三值与明确恢复。
 *
 * 全部使用隔离临时目录、隔离 XDG 配置与本机假模型：不产生真实 provider 请求，也不碰用户凭据或
 * 调试状态目录。断言落在可观察行为上——注册表内容、会话身份、历史条目、轮次状态与写者锁。
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, expect, test } from 'vitest';

import { startDebugHarness } from '../../src/bootstrap/debug-runtime.js';
import { submitDebugUserMessage } from '../../src/application/coordinator/debug-user-message.js';
import type { DebugHarnessPort } from '../../src/application/ports/debug-harness.js';
import type { CoordinatorSessionId } from '../../src/application/dto/identity.js';
import type { UserMessageCommitPort } from '../../src/application/coordinator/runtime-guard.js';
import {
  debugDirectoryId,
  debugSessionPaths,
  FileDebugSessionStore,
} from '../../src/adapters/storage/debug-session-store.js';
import { openCheckpointStore } from '../../src/adapters/storage/checkpoint-store.js';
import { CapableChatModel, CountingChatModel } from '../support/fake-chat-model.js';
import { MAX_USER_MESSAGE_CHARS } from '../../src/application/coordinator/user-message.js';
import { toolInputSchema, type CoordinatorToolDefinition } from '../../src/workflow/coordinator/tool-definition.js';

const MODEL_REF = 'model-1';
const CREDENTIAL_REF = '11111111-1111-4111-8111-111111111111';

let root = '';
let debugDirectory = '';
let environment: Record<string, string>;
let stateDirectory = '';

const clock = (): number => Date.now();

function writeProviderLibrary(configHome: string): void {
  const directory = join(configHome, 'orca-companion');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(directory, 'providers.json'),
    JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      connections: [
        {
          connectionRef: 'connection-1',
          label: 'fixture',
          providerId: 'custom',
          providerIntegration: 'openai-chat',
          baseUrl: 'https://example.invalid/v1',
          credential: { kind: 'managed', credentialRef: CREDENTIAL_REF },
        },
      ],
      models: [
        { modelRef: MODEL_REF, connectionRef: 'connection-1', model: 'fixture-model', effortCapability: null },
      ],
    }),
    { encoding: 'utf8', mode: 0o600 },
  );
  writeFileSync(
    join(directory, 'credentials.json'),
    JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      entries: [{ credentialRef: CREDENTIAL_REF, secret: 'fixture-only-not-a-provider-key' }],
    }),
    { encoding: 'utf8', mode: 0o600 },
  );
}

async function startHarness(options: {
  readonly model?: () => CapableChatModel;
  readonly createTools?: () => readonly CoordinatorToolDefinition[];
} = {}): Promise<{ readonly harness: DebugHarnessPort; readonly model: CapableChatModel }> {
  const model = options.model?.() ?? new CapableChatModel();
  const started = await startDebugHarness({
    directory: debugDirectory,
    environment,
    stateDirectory,
    clock,
    // 假模型具备五项能力：能力核验走真实代码路径，但不产生任何 provider 请求。
    resolveModel: () => Promise.resolve({
      kind: 'resolved',
      model,
      exactContext: null,
      nativeCompaction: null,
      keepalive: null,
    }),
    ...(options.createTools === undefined ? {} : { createTools: options.createTools }),
  });
  if (started.kind !== 'started') throw new Error('调试宿主装配失败：' + started.message);
  return { harness: started.harness, model };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('等待超时：' + message);
}

function running(harness: DebugHarnessPort): boolean {
  const state = harness.state();
  return state.kind === 'state' && state.state.running;
}

function turnKind(harness: DebugHarnessPort): string {
  const state = harness.state();
  return state.kind === 'state' ? state.state.turn.kind : 'no-session';
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-debug-'));
  debugDirectory = join(root, 'plain-directory');
  mkdirSync(debugDirectory, { recursive: true });
  stateDirectory = join(root, 'state');
  environment = { XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'xdg-state') };
  writeProviderLibrary(environment['XDG_CONFIG_HOME'] as string);
});

test('home 只列出该目录的会话与用户模型库模型，不创建任何状态', async () => {
  const { harness } = await startHarness();
  const home = harness.home();

  expect(home.kind).toBe('home');
  if (home.kind !== 'home') return;
  expect(home.sessions).toEqual([]);
  expect(home.models.map((model) => model.modelRef)).toEqual([MODEL_REF]);
  expect(home.models[0]?.connectionLabel).toBe('fixture');
  // home 是纯只读：明确 open 之前既不核验模型，也不取得写者或创建会话目录。
  expect(existsSync(join(stateDirectory, 'sessions'))).toBe(false);
  harness.close();
});

test('非 Git 目录可调试：新建会话落盘真实历史，重开沿用同一会话与配置快照', async () => {
  const { harness: first } = await startHarness();
  const opened = await first.open({ kind: 'new', modelRef: MODEL_REF });
  expect(opened.kind).toBe('opened');
  if (opened.kind !== 'opened') return;
  expect(opened.recovered).toBe(false);
  const sessionId = opened.state.coordinatorSessionId;

  const emptyInspection = await first.reading.inspection!.snapshot(sessionId);
  expect(emptyInspection.upperSequence).toBe(0);
  expect((await first.reading.history({ coordinatorSessionId: sessionId })).entries).toEqual([]);

  const sent = await first.send({ submissionId: 'submission-1', content: '你好' });
  expect(sent.kind).toBe('accepted');
  await waitFor(() => !running(first), '轮次结束');

  expect(first.submission({ submissionId: 'submission-1', content: '你好' })).toEqual({
    kind: 'accepted',
    ref: { kind: 'user-message', id: 'submission-1' },
  });
  expect(first.submission({ submissionId: 'submission-1', content: '改写过的内容' }).kind).toBe('conflict');
  expect(first.submission({ submissionId: 'never-sent', content: 'x' }).kind).toBe('not-found');

  const page = await first.reading.history({ coordinatorSessionId: sessionId });
  const roles = page.entries.map((entry) => entry.role);
  expect(roles).toContain('user');
  expect(roles).toContain('assistant');
  first.close();

  const { harness: second } = await startHarness();
  const home = second.home();
  expect(home.kind === 'home' && home.sessions.map((session) => session.coordinatorSessionId)).toEqual([sessionId]);
  const reopened = await second.open({ kind: 'continue', coordinatorSessionId: sessionId });
  expect(reopened.kind).toBe('opened');
  if (reopened.kind !== 'opened') return;
  expect(reopened.recovered).toBe(true);
  expect(reopened.state.configuration.configurationRef).toBe(opened.state.configuration.configurationRef);
  expect(await second.reading.history({ coordinatorSessionId: sessionId })).toEqual(page);
  second.close();
});

test('同一会话只允许一个写者：第二个宿主立即拒绝，写者退出后释放', async () => {
  const { harness: first } = await startHarness();
  const opened = await first.open({ kind: 'new', modelRef: MODEL_REF });
  expect(opened.kind).toBe('opened');
  if (opened.kind !== 'opened') return;
  const sessionId = opened.state.coordinatorSessionId;

  const { harness: second } = await startHarness();
  const whileHeld = await second.open({ kind: 'continue', coordinatorSessionId: sessionId });
  expect(whileHeld.kind).toBe('rejected');
  if (whileHeld.kind !== 'rejected') return;
  expect(whileHeld.code).toBe('session_locked');

  first.close();
  const { harness: third } = await startHarness();
  const afterRelease = await third.open({ kind: 'continue', coordinatorSessionId: sessionId });
  expect(afterRelease.kind).toBe('opened');
  third.close();
});

test('停止后重启不自动恢复：轮次保持 halted，明确 retry 才继续', async () => {
  const { harness: first } = await startHarness();
  const opened = await first.open({ kind: 'new', modelRef: MODEL_REF });
  if (opened.kind !== 'opened') throw new Error('会话未打开');
  const sessionId = opened.state.coordinatorSessionId;

  first.stop();
  expect(turnKind(first)).toBe('halted');
  await first.send({ submissionId: 'after-stop', content: '停止之后的消息' });
  first.close();

  const { harness: second } = await startHarness();
  const reopened = await second.open({ kind: 'continue', coordinatorSessionId: sessionId });
  expect(reopened.kind === 'opened' && reopened.state.turn.kind).toBe('halted');
  // 未明确恢复的会话不再自动发起请求：消息只落盘，不唤醒模型。
  await second.send({ submissionId: 'after-restart', content: '重启之后的消息' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const before = await second.reading.history({ coordinatorSessionId: sessionId });
  expect(before.entries.some((entry) => entry.role === 'assistant')).toBe(false);

  const retried = await second.retry();
  expect(retried.kind).toBe('cleared');
  await waitFor(() => !running(second), '明确恢复后的轮次结束');
  const answered = await second.reading.history({ coordinatorSessionId: sessionId });
  expect(answered.entries.some((entry) => entry.role === 'assistant')).toBe(true);
  second.close();
});

test('上下文无法收敛时在模型请求之前停下：结论落盘，轮次 halted 且不自动重试', async () => {
  // 工具 schema 本身就让固定开销超出调试上下文预算：Capsule 与机械 Shake 都压缩不了它，
  // 因此一次超长用户消息必然走成 context_exhausted，而不是被悄悄截断后照常请求模型。
  const heavyTool: CoordinatorToolDefinition = {
    name: 'heavy_fixture',
    description: 'fixture',
    mutating: false,
    inputSchema: toolInputSchema({ padding: { type: 'string', description: 'x'.repeat(500_000) } }, ['padding']),
    invoke: () => Promise.resolve({ kind: 'ok', value: null }),
  };
  const { harness, model } = await startHarness({
    model: () => new CountingChatModel(),
    createTools: () => [heavyTool],
  });
  const opened = await harness.open({ kind: 'new', modelRef: MODEL_REF });
  if (opened.kind !== 'opened') throw new Error('会话未打开');
  const sessionId = opened.state.coordinatorSessionId;
  const counter = model as CountingChatModel;
  // 能力核验本身会调用模型；断言的是本轮不再产生新的模型请求。
  const probed = counter.generations;
  expect(probed).toBeGreaterThan(0);

  await harness.send({ submissionId: 'oversized', content: 'x'.repeat(MAX_USER_MESSAGE_CHARS) });
  await waitFor(() => turnKind(harness) === 'halted', '上下文耗尽后停止');
  expect(counter.generations).toBe(probed);
  const page = await harness.reading.history({ coordinatorSessionId: sessionId });
  expect(page.entries.some((entry) => entry.role === 'assistant')).toBe(false);

  // 结论已经落盘：重启后不必重新推导，同一边界读到的是同一结论。
  const store = openCheckpointStore({ databasePath: debugSessionPaths(stateDirectory, sessionId).checkpoints, clock });
  if (store.kind !== 'opened') throw new Error('会话库无法打开');
  const persisted = store.store.loadCheckpoint(sessionId as CoordinatorSessionId, 'metadata');
  store.store.close();
  expect(persisted.kind === 'recovered' && persisted.state.lastCompactionOutcome?.kind).toBe('context_exhausted');

  // 已停止的轮次不自动重试：新消息只落盘，不唤醒模型。
  await harness.send({ submissionId: 'after-exhausted', content: '再来一次' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(counter.generations).toBe(probed);
  harness.close();
});

test('提交结果不可证明时返回 unknown，而不是换身份重发', () => {
  const checkpoints: UserMessageCommitPort = {
    commitUserMessage: () => ({ kind: 'unrecoverable', reason: '会话库写入失败' }),
  };
  const result = submitDebugUserMessage({
    checkpoints,
    debugDirectoryId: debugDirectoryId(debugDirectory),
    coordinatorSessionId: 'session-x' as CoordinatorSessionId,
    submissionId: 'submission-1',
    content: '你好',
  });
  expect(result.kind).toBe('unknown');
});

test('注册表：同目录追加、跨目录隔离，写锁占用时拒绝而不是丢掉记录', () => {
  let counter = 0;
  const store = new FileDebugSessionStore({ stateDirectory, clock, newId: () => 'id-' + String(++counter) });
  const configuration = {
    configurationRef: 'configuration-1',
    providerIntegration: 'openai-chat' as const,
    model: 'fixture-model',
    credentialRefs: [CREDENTIAL_REF],
    nativeWindowOwnerRef: null,
    effortCapability: null,
    effort: null,
  };
  const here = store.register({ debugDirectoryId: 'dir-a', directoryPath: '/tmp/a', configuration });
  const elsewhere = store.register({ debugDirectoryId: 'dir-b', directoryPath: '/tmp/b', configuration });
  if (here.kind !== 'ok' || elsewhere.kind !== 'ok') throw new Error('注册表写入失败');
  expect(here.value.coordinatorSessionId).not.toBe(elsewhere.value.coordinatorSessionId);
  const listedA = store.list('dir-a');
  const listedB = store.list('dir-b');
  expect(listedA.kind === 'ok' && listedA.value.map((record) => record.coordinatorSessionId)).toEqual([
    here.value.coordinatorSessionId,
  ]);
  expect(listedB.kind === 'ok' && listedB.value.map((record) => record.coordinatorSessionId)).toEqual([
    elsewhere.value.coordinatorSessionId,
  ]);

  // 另一个进程正持有注册表的写锁：本次写入必须拒绝，否则两个独立会话会互相覆盖记录。
  const registryLock = join(stateDirectory, 'sessions.json.lock');
  writeFileSync(registryLock, '{"pid":1}', { encoding: 'utf8', mode: 0o600 });
  const blocked = store.register({ debugDirectoryId: 'dir-a', directoryPath: '/tmp/a', configuration });
  expect(blocked.kind).toBe('rejected');
  const listedAfterBlock = store.list('dir-a');
  expect(listedAfterBlock.kind === 'ok' && listedAfterBlock.value).toHaveLength(1);
});
