/**
 * 调试前台进程入口（`ocp --debug`）。
 *
 * 与 `tui-entry.ts` 同一门禁：先检查 stdin/stdout 双 TTY，通过后才动态加载 Ink 与 React，
 * 因此无 TTY 时 stdout 不会出现渲染帧。调试目录可以是普通非 Git 目录；会话注册、模型库、
 * checkpoint、只读工具与轮次驱动都由 `startDebugHarness` 装配，界面只消费
 * `DebugHarnessPort`。
 *
 * 诊断只输出稳定错误码与本入口自己产生的文案：provider 错误体、凭据引用与原始异常文本
 * 不写进 stderr。
 */

import type { CliIO } from '../interfaces/cli/doctor-command.js';
import type { DebugHarnessPort } from '../application/ports/debug-harness.js';

export const DEBUG_NO_TTY_CODE = 2;
/** Ctrl+C 在装配或渲染期间到达时的退出码；宿主已取消在途工作并释放会话。 */
export const DEBUG_INTERRUPTED_CODE = 130;
/** 装配失败时对外可见的稳定码；细节留在诊断日志与 host 自己的结构化结果里。 */
export const DEBUG_START_FAILED = 'debug_start_failed';

export type DebugEntryEnvironment = {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdinIsTty: boolean;
  readonly stdoutIsTty: boolean;
  readonly columns: number;
};

export type RenderedAppLike = {
  readonly unmount: () => void;
  readonly waitUntilExit: () => Promise<void>;
};

export type RenderLike = (
  element: unknown,
  options: { readonly exitOnCtrlC: boolean; readonly interactive: boolean },
) => RenderedAppLike;

export type DebugEntryDependencies = {
  /** 覆盖点：测试注入 fake 端口与渲染器；生产走 `startDebugHarness`。 */
  readonly start?: (options: DebugStartOptions) => Promise<DebugStartResult>;
  readonly render?: RenderLike;
};

export type DebugStartOptions = {
  readonly directory: string;
  readonly environment: Readonly<Record<string, string>>;
};

export type DebugStartResult =
  | { readonly kind: 'started'; readonly harness: DebugHarnessPort }
  | { readonly kind: 'failed'; readonly code: string; readonly message: string };

/** 与 TUI 相同的双 TTY 判定；失败关闭，不降级为一次性输出。 */
export function assertDebugInteractiveTty(environment: DebugEntryEnvironment): string | null {
  const missing: string[] = [];
  if (!environment.stdinIsTty) {
    missing.push('stdin');
  }
  if (!environment.stdoutIsTty) {
    missing.push('stdout');
  }
  return missing.length === 0 ? null : missing.join(' 与 ');
}

export async function runDebugEntry(
  environment: DebugEntryEnvironment,
  io: CliIO,
  dependencies: DebugEntryDependencies = {},
): Promise<number> {
  const missing = assertDebugInteractiveTty(environment);
  if (missing !== null) {
    io.writeStderr('orca-companion: 调试前台需要交互式终端，但 ' + missing + ' 没有 TTY；请改用 status 或 doctor。\n');
    return DEBUG_NO_TTY_CODE;
  }

  // Ink 以 `exitOnCtrlC: false` 接管按键，因此 SIGINT 只可能发生在 Ink 挂载之前的装配窗口。
  // 装配本身不发模型请求（能力核验在打开会话时进行，那时界面已接管 Ctrl+C），
  // 这里记下意图，装配一返回就取消并退出。
  let interrupted = false;
  const onInterrupt = (): void => { interrupted = true; };
  process.on('SIGINT', onInterrupt);
  let started: DebugStartResult;
  try {
    started = await (dependencies.start ?? startProductionHarness)({
      directory: environment.cwd,
      environment: environment.env,
    });
  } finally {
    process.off('SIGINT', onInterrupt);
  }
  if (started.kind === 'failed') {
    io.writeStderr('orca-companion: 调试会话不可用（' + started.code + '）\n');
    return 1;
  }
  const harness = started.harness;

  let unmountApp: (() => void) | null = null;
  let aborted = false;
  // SIGTERM（例如父进程或会话管理器结束本进程）走同一条取消链：先取消在途模型工作，再卸载界面。
  const onTerminate = (): void => {
    if (aborted) return;
    aborted = true;
    harness.exitIntent();
    unmountApp?.();
  };
  process.on('SIGTERM', onTerminate);
  try {
    if (interrupted) return DEBUG_INTERRUPTED_CODE;
    const renderElement: RenderLike = dependencies.render ?? (await import('ink')).render.bind(undefined) as unknown as RenderLike;
    const { createElement } = await import('react');
    const { DebugApp } = await import('../interfaces/tui/debug-app.js');

    const app = renderElement(
      createElement(DebugApp, { harness, terminalWidth: environment.columns, onExit: () => { app.unmount(); } }),
      { exitOnCtrlC: false, interactive: true },
    );
    unmountApp = () => app.unmount();
    await app.waitUntilExit();
    return 0;
  } catch {
    // 界面异常同样不回显原始文本：provider 错误体可能带请求细节。
    io.writeStderr('orca-companion: 调试前台异常退出（' + DEBUG_START_FAILED + '）\n');
    return 1;
  } finally {
    // 退出先取消在途模型工作，再释放会话锁与存储。
    process.off('SIGTERM', onTerminate);
    if (!aborted) harness.exitIntent();
    harness.close();
  }
}

/**
 * 生产 host：debug runtime 在双 TTY 通过之后才加载，
 * 因此 `status`/`doctor` 与无 TTY 的 `--debug` 都不会装配运行时。
 */
async function startProductionHarness(options: {
  readonly directory: string;
  readonly environment: Readonly<Record<string, string>>;
}): Promise<DebugStartResult> {
  const { startDebugHarness } = await import('./debug-runtime.js');
  const started = await startDebugHarness({ directory: options.directory, environment: options.environment });
  return started.kind === 'started'
    ? { kind: 'started', harness: started.harness }
    : { kind: 'failed', code: started.code, message: started.message };
}
