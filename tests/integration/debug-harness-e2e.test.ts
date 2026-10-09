import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { launchTerminal, type Session } from 'tuistory';
import { describe, expect, it } from 'vitest';
import type { CoordinatorSessionId } from '../../src/application/dto/identity.js';
import type { CommittedMessageEntry } from '../../src/domain/coordinator/session-state.js';
import { openCheckpointStore } from '../../src/adapters/storage/checkpoint-store.js';
import { debugSessionPaths } from '../../src/adapters/storage/debug-session-store.js';
import { credentialFixtureEnvironment, projectConnectionsFixture } from '../support/model-configurations.js';
import { scriptedModelServer } from '../support/scripted-model-server.js';

const entry = resolve('dist/src/interfaces/cli/main.js');

async function until(predicate: () => boolean | Promise<boolean>, timeout = 10_000, diagnostics?: () => Promise<string>): Promise<void> {
  const deadline = Date.now() + timeout;
  let passed = await predicate();
  while (!passed && Date.now() < deadline) { await delay(30); passed = await predicate(); }
  expect(passed, !passed && diagnostics !== undefined ? await diagnostics() : undefined).toBe(true);
}

async function fixture() {
  const server = await scriptedModelServer();
  const directory = mkdtempSync(join(tmpdir(), 'ocp-debug-e2e-'));
  const root = join(directory, 'plain-directory');
  mkdirSync(root);
  writeFileSync(join(root, 'sample.txt'), 'read-only fixture evidence\n');
  const env = { ...credentialFixtureEnvironment(directory), XDG_STATE_HOME: join(directory, 'state'),
    TERM: 'xterm-256color', NODE_NO_WARNINGS: '1', NO_COLOR: '1', FORCE_COLOR: '0' };
  const connections = projectConnectionsFixture();
  writeFileSync(join(directory, 'fixture-config', 'orca-companion', 'providers.json'), JSON.stringify({
    schemaVersion: 1, revision: 1,
    connections: connections.providerConnections.map(connection => ({ ...connection,
      providerId: 'custom', baseUrl: server.baseUrl })), models: connections.models,
  }), { mode: 0o600 });
  const terminals: Session[] = [];
  async function launch(continuing = false, waitForOpen = true) {
    const terminal = await launchTerminal({ command: process.execPath, args: [entry, '--debug', root],
      cwd: directory, env, cols: 100, rows: 30 });
    terminals.push(terminal);
    await terminal.waitForText('新建或继续', { timeout: 15_000 });
    await terminal.press(continuing ? 'c' : 'n');
    if (!continuing) {
      await terminal.waitForText('选择模型');
      await terminal.press('enter');
    }
    if (waitForOpen) await terminal.waitForText('普通消息', { timeout: 15_000 });
    return terminal;
  }
  function record() {
    const registry = JSON.parse(readFileSync(join(env.XDG_STATE_HOME, 'orca-companion/debug/sessions.json'), 'utf8')) as {
      sessions: { coordinatorSessionId: CoordinatorSessionId; configuration: { configurationRef: string } }[] };
    expect(registry.sessions).toHaveLength(1);
    return registry.sessions[0]!;
  }
  function history() {
    const identity = record();
    const paths = debugSessionPaths(join(env.XDG_STATE_HOME, 'orca-companion/debug'), identity.coordinatorSessionId);
    const opened = openCheckpointStore({ databasePath: paths.checkpoints });
    if (opened.kind !== 'opened') throw new Error(opened.message);
    try {
      return { identity, turn: opened.store.turns.readTurnState(identity.coordinatorSessionId),
        entries: opened.store.readCommittedMessages(identity.coordinatorSessionId) as readonly CommittedMessageEntry[],
        calls: opened.store.readHistoryCalls({ coordinatorSessionId: identity.coordinatorSessionId }).calls };
    } finally { opened.store.close(); }
  }
  function writerPid() {
    const identity = record();
    const paths = debugSessionPaths(join(env.XDG_STATE_HOME, 'orca-companion/debug'), identity.coordinatorSessionId);
    const lock = JSON.parse(readFileSync(paths.writerLock, 'utf8')) as { pid: number };
    expect(Number.isSafeInteger(lock.pid) && lock.pid > 0).toBe(true);
    return lock.pid;
  }
  async function send(terminal: Session, content: string) {
    await terminal.type(content);
    // tuistory 的 idle 可在尚未收到按键回显时返回；先确认草稿，避免 Enter 与正文合并成粘贴。
    await terminal.waitForText(content);
    await terminal.press('enter');
    if (content.startsWith('/')) {
      await until(async () => !(await terminal.text()).includes('命令候选'));
      await terminal.press('enter');
    }
  }
  async function exit(terminal: Session) {
    terminal.sendKey(['ctrl', 'c']);
    expect(await terminal.waitForExit(5000)).toBe(true);
    expect(terminal.exitInfo?.exitCode).toBe(0);
    await until(() => server.activeRequests() === 0);
  }
  async function diagnostics(terminal: Session) {
    return JSON.stringify({ requests: server.requests.length, activeRequests: server.activeRequests(),
      history: history(), screen: await terminal.text() });
  }
  return { server, launch, record, history, send, exit, writerPid, root, diagnostics, close: async () => {
    terminals.forEach(terminal => terminal.close());
    await server.close();
  } };
}

describe('real CLI → PTY → fixed SDK → local HTTP/SSE', () => {
  it('Ctrl+C during the first capability probe aborts it without sending remaining probes', async () => {
    const f = await fixture();
    try {
      f.server.setMode('probe-hang');
      const terminal = await f.launch(false, false);
      await until(() => f.server.totalRequests() === 1 && f.server.activeRequests() === 1);
      await f.exit(terminal);
      await delay(300);
      expect(f.server.totalRequests()).toBe(1);
      expect(f.server.requests).toHaveLength(0);
    } finally { await f.close(); }
  }, 30_000);

  it.each(['SIGTERM', 'SIGKILL'] as const)('%s leaves no model connection; reopening requires explicit retry', async signal => {
    const f = await fixture();
    try {
      let terminal = await f.launch();
      f.server.setMode('hang');
      await f.send(terminal, '被中断的消息');
      await until(() => f.server.requests.length === 1 && f.server.activeRequests() === 1 && f.history().turn.kind === 'running',
        10_000, () => f.diagnostics(terminal));
      if (signal === 'SIGTERM') terminal.killProcess();
      else process.kill(f.writerPid(), signal);
      expect(await terminal.waitForExit(5000)).toBe(true);
      await until(() => f.server.activeRequests() === 0);
      expect(f.history().turn.kind).toBe(signal === 'SIGKILL' ? 'running' : 'halted');
      expect(f.history().entries.filter(entry => entry.role === 'assistant')).toHaveLength(0);
      const identity = f.record();
      terminal = await f.launch(true);
      await delay(1200);
      expect(f.record()).toEqual(identity);
      expect(f.server.requests).toHaveLength(1);
      f.server.setMode('normal');
      await f.send(terminal, '/retry');
      await until(() => f.server.requests.length === 2 && f.history().turn.kind === 'idle');
      expect(f.history().entries.filter(entry => entry.role === 'assistant')).toHaveLength(1);
      await f.exit(terminal);
    } finally { await f.close(); }
  }, 45_000);
  it('commits greeting and paired read tool once; continue restores history without model traffic', async () => {
    const f = await fixture();
    try {
      const terminal = await f.launch();
      expect(f.server.requests).toHaveLength(0);
      await f.send(terminal, '你好');
      await until(() => f.server.requests.length === 1 && f.history().turn.kind === 'idle',
        10_000, () => f.diagnostics(terminal));
      await terminal.waitForText('E2E回复');
      await f.send(terminal, '__TOOL__');
      await until(() => f.server.requests.length === 3 && f.history().turn.kind === 'idle');
      await terminal.waitForText('工具结果已收到');
      const saved = f.history();
      expect(saved.entries.filter(entry => entry.role === 'user')).toHaveLength(2);
      expect(saved.calls).toHaveLength(1);
      expect(saved.calls[0]?.status).toBe('ok');
      expect(saved.entries.find(entry => entry.role === 'tool')?.content).toContain('read-only fixture evidence');
      await terminal.press(['ctrl', 't']);
      await terminal.waitForText('read-only fixture evidence');
      await terminal.press(['ctrl', 't']);
      expect(saved.entries.filter(entry => entry.role === 'assistant').every(entry =>
        entry.providerReplay === undefined || entry.providerReplay.configurationRef === saved.identity.configuration.configurationRef)).toBe(true);
      await f.exit(terminal);
      const resumed = await f.launch(true);
      await resumed.waitForText('工具结果已收到');
      await delay(1200);
      expect(f.server.requests).toHaveLength(3);
      expect(f.record()).toEqual(saved.identity);
      await f.exit(resumed);
    } finally { await f.close(); }
  }, 45_000);

  it.each([['rate-limit', 3], ['bad-request', 1], ['disconnect', 3]] as const)(
    '%s stops after %i requests across new input and restart; only explicit retry resumes', async (mode, attempts) => {
      const f = await fixture();
      try {
        let terminal = await f.launch();
        f.server.setMode(mode);
        await f.send(terminal, '故障消息');
        await until(() => f.history().turn.kind === 'halted', 10_000, () => f.diagnostics(terminal));
        expect(f.server.requests).toHaveLength(attempts);
        await f.send(terminal, '停止后消息');
        await delay(1200);
        expect(f.server.requests).toHaveLength(attempts);
        const identity = f.record();
        await f.exit(terminal);
        terminal = await f.launch(true);
        await delay(1200);
        expect(f.server.requests).toHaveLength(attempts);
        expect(f.record()).toEqual(identity);
        f.server.setMode('normal');
        await f.send(terminal, '/retry');
        await until(() => f.server.requests.length === attempts + 2 && f.history().turn.kind === 'idle');
        expect(f.history().entries.filter(entry => entry.role === 'assistant')).toHaveLength(2);
        await f.exit(terminal);
      } finally { await f.close(); }
    }, 45_000);

  it('Ctrl+C cancels a live SSE request and leaves no active request or automatic restart', async () => {
    const f = await fixture();
    try {
      let terminal = await f.launch();
      f.server.setMode('hang');
      await f.send(terminal, '等待取消');
      await until(() => f.server.requests.length === 1 && f.server.activeRequests() === 1);
      await terminal.waitForText('E2E回复');
      await f.exit(terminal);
      expect(f.history().entries.filter(entry => entry.role === 'assistant')).toHaveLength(0);
      expect(f.history().turn.kind).toBe('halted');
      terminal = await f.launch(true);
      await delay(1200);
      expect(f.server.requests).toHaveLength(1);
      await f.exit(terminal);
    } finally { await f.close(); }
  }, 45_000);
});
