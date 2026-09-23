/**
 * MOD-07：TUI 进程入口（Owner: `m2-deliver-planning-tui`，D1）。
 *
 * TTY 门禁在这里，且必须在挂载 Ink **之前**：research 已实测「无 TTY + `useInput`」会抛 raw-mode
 * 错误却保持退出码 0，若把判断交给组件就无法区分真失败与假成功。因此本模块先检查 stdin/stdout，
 * 通过后才动态 import Ink 与 React——未通过时 Ink 根本没有被加载，stdout 也不会出现渲染帧。
 */

import type { CliIO } from '../interfaces/cli/doctor-command.js';
import type { TuiPorts } from '../interfaces/tui/ports.js';

export const TUI_NO_TTY_CODE = 2;

export type TuiEntryEnvironment = {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdinIsTty: boolean;
  readonly stdoutIsTty: boolean;
  /** 初始终端宽度；运行中由 Ink 的 `useStdout` 提供实时值。 */
  readonly columns: number;
};

export type TuiEntryDependencies = {
  /** 覆盖点：测试注入 fake 端口与渲染器；生产不替换。 */
  readonly createPorts?: (environment: TuiEntryEnvironment) => Promise<TuiPorts> | TuiPorts;
  readonly render?: RenderLike;
};

export type RenderedAppLike = {
  readonly unmount: () => void;
  readonly waitUntilExit: () => Promise<void>;
};

export type RenderLike = (
  element: unknown,
  options: { readonly exitOnCtrlC: boolean },
) => RenderedAppLike;

/**
 * 判断是否可以在当前进程挂载前台 TUI。
 *
 * 两个流都必须有 TTY：stdin 无 TTY 时 `useInput` 无法进入 raw mode，stdout 无 TTY 时渲染帧会污染
 * 机器输出。失败关闭：不降级为一次性输出。
 */
export function assertInteractiveTty(environment: TuiEntryEnvironment): string | null {
  const missing: string[] = [];
  if (!environment.stdinIsTty) {
    missing.push('stdin');
  }
  if (!environment.stdoutIsTty) {
    missing.push('stdout');
  }
  return missing.length === 0 ? null : missing.join(' 与 ');
}

export async function runTuiEntry(
  environment: TuiEntryEnvironment,
  io: CliIO,
  dependencies: TuiEntryDependencies = {},
): Promise<number> {
  const missing = assertInteractiveTty(environment);
  if (missing !== null) {
    io.writeStderr(
      `orca-companion: 前台 TUI 需要交互式终端，但 ${missing} 没有 TTY；请改用 status 或 doctor。\n`,
    );
    return TUI_NO_TTY_CODE;
  }

  const ports = await (dependencies.createPorts ?? createDefaultPorts)(environment);
  const renderElement: RenderLike =
    dependencies.render ??
    (await import('ink')).render.bind(undefined) as unknown as RenderLike;
  const { createElement } = await import('react');
  const { TuiApp } = await import('../interfaces/tui/app.js');

  // `onExit` 只在渲染完成后被调用，因此闭包引用 `app` 不存在暂时性死区问题。
  const app = renderElement(
    createElement(TuiApp, {
      ports,
      terminalWidth: environment.columns,
      initialScopeId: null,
      onExit: () => {
        app.unmount();
      },
    }),
    { exitOnCtrlC: false },
  );
  await app.waitUntilExit();
  return 0;
}

async function createDefaultPorts(environment: TuiEntryEnvironment): Promise<TuiPorts> {
  const { createTuiPorts } = await import('./tui-composition.js');
  return createTuiPorts(environment);
}
