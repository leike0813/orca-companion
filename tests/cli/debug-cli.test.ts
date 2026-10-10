/**
 * `ocp --debug [directory]` 的 argv 与入口行为。
 *
 * 断言的是入口事实：双 TTY 门禁在装配之前、失败诊断只给稳定错误码、退出时取消并释放宿主，
 * 以及目录参数确实传到运行时。界面行为由 `tests/tui/debug-app.test.tsx` 覆盖。
 */

import { describe, expect, test, vi } from 'vitest';

import { CLI_USAGE, parseCliArguments } from '../../src/interfaces/cli/argv.js';
import { main, type CliEnvironment } from '../../src/interfaces/cli/main.js';
import type { CliIO } from '../../src/interfaces/cli/doctor-command.js';
import {
  DEBUG_INTERRUPTED_CODE,
  DEBUG_NO_TTY_CODE,
  runDebugEntry,
  type DebugEntryEnvironment,
  type DebugStartResult,
} from '../../src/bootstrap/debug-entry.js';
import type { DebugHarnessPort } from '../../src/application/ports/debug-harness.js';

function captureIo(): { io: { writeStdout: (text: string) => void; writeStderr: (text: string) => void }; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { writeStdout: (text) => out.push(text), writeStderr: (text) => err.push(text) }, out, err };
}

function environment(overrides: Partial<CliEnvironment> = {}): CliEnvironment {
  return { cwd: '/work', env: {}, stdinIsTty: true, stdoutIsTty: true, columns: 100, ...overrides };
}

type StubHarness = { readonly harness: DebugHarnessPort; readonly counters: { closed: number; exitIntents: number } };

function stubHarness(): StubHarness {
  const fake = { closed: 0, exitIntents: 0 };
  const harness: DebugHarnessPort = {
    home: () => ({ kind: 'home', debugDirectoryId: 'dir-1', directoryPath: '/work', sessions: [], models: [] }),
    open: () => Promise.resolve({ kind: 'rejected', code: 'not_open', message: '未打开' }),
    state: () => ({ kind: 'no-session' }),
    send: () => Promise.resolve({ kind: 'rejected', code: 'not_open', message: '未打开' }),
    submission: () => ({ kind: 'unverifiable', reason: '未打开' }),
    stop: () => undefined,
    retry: () => Promise.resolve({ kind: 'rejected', failure: { code: 'recovery_rejected', message: '未打开' } }),
    exitIntent: () => { fake.exitIntents += 1; },
    reading: {
      history: () => Promise.resolve({ entries: [], hasMore: false }),
      body: () => Promise.resolve(null),
      previews: () => Promise.resolve([]),
      pin: () => () => undefined,
      subscribe: () => () => undefined,
    },
    inputStore: {} as DebugHarnessPort['inputStore'],
    providerLibrary: {} as DebugHarnessPort['providerLibrary'],
    subscribe: () => () => undefined,
    close: () => { fake.closed += 1; },
  };
  return { harness, counters: fake };
}

describe('cli/debug / ocp --debug 入口', () => {
  test('argv：--debug 接受可选目录，多余参数被结构化拒绝', () => {
    expect(parseCliArguments(['--debug'])).toEqual({ kind: 'debug', directory: null });
    expect(parseCliArguments(['--debug', '/work/demo'])).toEqual({ kind: 'debug', directory: '/work/demo' });
    expect(parseCliArguments(['--debug', 'a', 'b'])).toMatchObject({ kind: 'rejected', code: 'invalid_arguments' });
    expect(parseCliArguments(['--debug', '--json'])).toMatchObject({ kind: 'rejected', code: 'invalid_arguments' });
    expect(CLI_USAGE).toContain('--debug [directory]');
  });

  test('main：目录参数与 TTY 事实传给调试入口', async () => {
    const runDebug = vi.fn<(_environment: DebugEntryEnvironment, _io: CliIO) => Promise<number>>(() => Promise.resolve(0));
    expect(await main(['--debug'], environment(), captureIo().io, { runDebug })).toBe(0);
    expect(await main(['--debug', '/work/demo'], environment(), captureIo().io, { runDebug })).toBe(0);

    const calls = runDebug.mock.calls.map((call) => call[0]);
    expect(calls.map((entry) => entry?.cwd)).toEqual(['/work', '/work/demo']);
    expect(calls[0]?.stdinIsTty).toBe(true);
  });

  test('无 TTY 时在装配之前拒绝，且不渲染任何帧', async () => {
    const start = vi.fn<() => Promise<DebugStartResult>>();
    const render = vi.fn();
    const { io, out } = captureIo();
    const code = await runDebugEntry(
      { cwd: '/work', env: {}, stdinIsTty: false, stdoutIsTty: true, columns: 80 },
      io,
      { start, render },
    );
    expect(code).toBe(DEBUG_NO_TTY_CODE);
    expect(start).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    expect(out).toEqual([]);
  });

  test('装配失败只回显稳定错误码，不输出 provider 细节', async () => {
    const { io, err } = captureIo();
    const code = await runDebugEntry(
      { cwd: '/work', env: {}, stdinIsTty: true, stdoutIsTty: true, columns: 80 },
      io,
      { start: () => Promise.resolve({ kind: 'failed', code: 'model_resolution_failed', message: 'sk-xxx upstream 401' }) },
    );
    expect(code).toBe(1);
    expect(err.join('')).toContain('model_resolution_failed');
    expect(err.join('')).not.toContain('sk-xxx');
  });

  test('退出时取消在途工作并释放宿主', async () => {
    const { harness, counters } = stubHarness();
    const unmounted: number[] = [];
    let mounted: { unmount: () => void } | null = null;
    const code = await runDebugEntry(
      { cwd: '/work', env: {}, stdinIsTty: true, stdoutIsTty: true, columns: 80 },
      captureIo().io,
      {
        start: () => Promise.resolve({ kind: 'started', harness }),
        render: (element, options) => {
          expect(options).toEqual({ exitOnCtrlC: false, interactive: true });
          const element_ = element as { props: { onExit: () => void } };
          mounted = { unmount: () => { unmounted.push(1); } };
          setTimeout(() => element_.props.onExit(), 0);
          return {
            unmount: () => mounted?.unmount(),
            waitUntilExit: () => new Promise<void>((resolve) => setTimeout(resolve, 10)),
          };
        },
      },
    );
    expect(code).toBe(0);
    expect(unmounted.length).toBeGreaterThan(0);
    expect(counters.exitIntents).toBeGreaterThan(0);
    expect(counters.closed).toBe(1);
  });

  test('装配期间收到 SIGINT 时取消并退出，不留下在途请求', async () => {
    const { harness, counters } = stubHarness();
    const code = await runDebugEntry(
      { cwd: '/work', env: {}, stdinIsTty: true, stdoutIsTty: true, columns: 80 },
      captureIo().io,
      {
        start: () => {
          process.emit('SIGINT');
          return Promise.resolve({ kind: 'started', harness });
        },
        render: () => { throw new Error('中断后不应渲染'); },
      },
    );
    expect(code).toBe(DEBUG_INTERRUPTED_CODE);
    expect(counters.closed).toBe(1);
  });
});

describe('cli/debug / 调试入口的取消链', () => {
  test('SIGTERM 取消在途工作并卸载界面一次，宿主随后被关闭', async () => {
    const { harness, counters } = stubHarness();
    let unmounts = 0;
    const code = await runDebugEntry(
      { cwd: '/work', env: {}, stdinIsTty: true, stdoutIsTty: true, columns: 80 },
      captureIo().io,
      {
        start: () => Promise.resolve({ kind: 'started', harness }),
        render: () => ({
          unmount: () => { unmounts += 1; },
          waitUntilExit: () => {
            process.emit('SIGTERM');
            process.emit('SIGTERM');
            return Promise.resolve();
          },
        }),
      },
    );
    expect(code).toBe(0);
    expect(counters.exitIntents).toBe(1);
    expect(unmounts).toBe(1);
    expect(counters.closed).toBe(1);
    expect(process.listenerCount('SIGTERM')).toBe(0);
  });
});
