import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test } from 'vitest';
import {
  DEBUG_REGISTRY_FILENAME,
  FileDebugSessionStore,
  acquireDebugWriterLock,
} from '../../src/adapters/storage/debug-session-store.js';

const configuration = {
  configurationRef: 'configuration-1',
  providerIntegration: 'openai-chat' as const,
  model: 'fixture-model',
  credentialRefs: ['11111111-1111-4111-8111-111111111111'],
  nativeWindowOwnerRef: null,
  effortCapability: null,
  effort: null,
};
const registration = { debugDirectoryId: 'dir-a', directoryPath: '/tmp/a', configuration };

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'ocp-debug-registry-'));
}

test('非法写者身份和未结清回收锁拒绝接管', () => {
  const directory = tempRoot();
  const lockPath = join(directory, 'writer.lock');
  expect(acquireDebugWriterLock({ lockPath, pid: 0 }).kind).toBe('held');
  expect(existsSync(lockPath)).toBe(false);
  writeFileSync(lockPath, JSON.stringify({ pid: 2_147_483_647 }));
  writeFileSync(`${lockPath}.recovery`, 'unknown');
  expect(acquireDebugWriterLock({ lockPath }).kind).toBe('held');
  expect(readFileSync(`${lockPath}.recovery`, 'utf8')).toBe('unknown');
});

test('写入锁覆盖读改写：锁期间提交的记录不会被覆盖，写锁占用时拒绝而不是排队', () => {
  const stateDirectory = tempRoot();
  let counter = 0;
  const newId = () => `id-${String(++counter)}`;
  const other = new FileDebugSessionStore({ stateDirectory, clock: () => 2, newId });
  // 本 store 的读在 clock 之前发生，而 clock 里正好落下另一个进程的提交：修好的实现里这一次提交
  // 必须被写锁挡住，否则它会被基于旧内容的写回抹掉。
  let raced = false;
  const mine = new FileDebugSessionStore({
    stateDirectory,
    clock: () => {
      if (!raced) {
        raced = true;
        other.register(registration);
      }
      return 1;
    },
    newId,
  });

  const outcomes = [other.register(registration), mine.register(registration)];
  const acknowledged = outcomes
    .filter((outcome) => outcome.kind === 'ok')
    .map((outcome) => (outcome.kind === 'ok' ? outcome.value.coordinatorSessionId : ''));
  const listed = mine.list('dir-a');
  const persisted = listed.kind === 'ok' ? listed.value.map((record) => record.coordinatorSessionId) : [];
  // 已经答复成功的注册必须都还在：一次丢失的更新比一次拒绝更难发现。
  expect(persisted.sort()).toEqual([...acknowledged].sort());

  const registryPath = join(stateDirectory, DEBUG_REGISTRY_FILENAME);
  const before = readFileSync(registryPath, 'utf8');
  writeFileSync(`${registryPath}.lock`, '{"pid":1}', { encoding: 'utf8', mode: 0o600 });
  expect(mine.register(registration)).toMatchObject({ kind: 'rejected', code: 'registry_busy' });
  expect(readFileSync(registryPath, 'utf8')).toBe(before);
});

test('身份不可信的写者锁既不取得也不删除', () => {
  const directory = tempRoot();
  const lockPath = join(directory, 'writer.lock');
  for (const content of ['', 'not json', '{"pid":"me"}', '{"pid":0,"extra":1}']) {
    writeFileSync(lockPath, content, { encoding: 'utf8', mode: 0o600 });
    expect(acquireDebugWriterLock({ lockPath })).toEqual({ kind: 'held', holderPid: null });
    expect(readFileSync(lockPath, 'utf8')).toBe(content);
  }
});

test('存活的持有者立即拒绝，第二把锁也拒绝', () => {
  const directory = tempRoot();
  const lockPath = join(directory, 'writer.lock');
  const first = acquireDebugWriterLock({ lockPath });
  expect(first.kind).toBe('acquired');
  expect(acquireDebugWriterLock({ lockPath })).toEqual({ kind: 'held', holderPid: process.pid });
  if (first.kind !== 'acquired') throw new Error('expected the first acquisition to win');
  first.release();
  expect(existsSync(lockPath)).toBe(false);
});

test('真实 SIGKILL 之后的残留锁被回收，迟到的 release 不删掉新写者的锁', async () => {
  const directory = tempRoot();
  const lockPath = join(directory, 'writer.lock');
  const holder = spawn(
    process.execPath,
    [
      '-e',
      `require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ pid: process.pid }), { mode: 0o600 }); setInterval(() => {}, 1000);`,
      lockPath,
    ],
    { stdio: 'ignore' },
  );
  const exited = new Promise((resolve) => holder.once('exit', resolve));
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(lockPath) && Date.now() < deadline) await delay(20);
    expect(existsSync(lockPath)).toBe(true);
    // 持有者活着：不能破锁。
    expect(acquireDebugWriterLock({ lockPath })).toEqual({ kind: 'held', holderPid: holder.pid });
    holder.kill('SIGKILL');
    await exited;
    const recovered = acquireDebugWriterLock({ lockPath });
    expect(recovered.kind).toBe('acquired');
    if (recovered.kind !== 'acquired') throw new Error('expected a killed holder to be recovered');
    // 模拟更晚到达的旧写者：它的 release 只能认出自己建立的那一份锁。
    unlinkSync(lockPath);
    const next = acquireDebugWriterLock({ lockPath, pid: 1 });
    expect(next.kind).toBe('acquired');
    recovered.release();
    expect(readFileSync(lockPath, 'utf8')).toBe('{"pid":1}');
    if (next.kind !== 'acquired') throw new Error('expected the second acquisition to win');
    next.release();
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(`${lockPath}.recovery`)).toBe(false);
  } finally {
    if (holder.exitCode === null) holder.kill('SIGKILL');
  }
});

test('会话目录不可创建时按占用拒绝，不留下半份锁', () => {
  const directory = tempRoot();
  const notDirectory = join(directory, 'regular-file');
  writeFileSync(notDirectory, 'not a directory', { encoding: 'utf8', mode: 0o600 });
  expect(acquireDebugWriterLock({ lockPath: join(notDirectory, 'session', 'writer.lock') })).toEqual({
    kind: 'held',
    holderPid: null,
  });
  expect(readFileSync(notDirectory, 'utf8')).toBe('not a directory');
});
