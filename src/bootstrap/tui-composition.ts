/**
 * MOD-07：TUI 端口的环境级装配（Owner: `m2-deliver-planning-tui`）。
 *
 * 这里只回答一个问题：给定一次前台进程环境，界面该拿到哪些端口。真正的装配在
 * `foreground-planning-runtime.ts`（配置、Git/Orca/tracker/模型核验、store、Session lease 心跳、
 * Controller 与事件源），本模块只负责把它按进程环境实例化，并把 `close` 交给调用方。
 *
 * 端口全部来自同一个宿主：界面通过 IC-13 访问 UI 输入，业务 store、backend 与 writer 仍由宿主拥有。
 */

import { createForegroundPlanningHost } from './foreground-planning-runtime.js';
import type { TuiPorts } from '../interfaces/tui/ports.js';
import type { TuiEntryEnvironment } from './tui-entry.js';

export type ComposedTuiPorts = {
  readonly ports: TuiPorts;
  /** 进程退出前清理心跳、checkpoint/UI 输入句柄与订阅；不改变任何业务状态。 */
  readonly close: () => void;
};

export async function createTuiPorts(environment: TuiEntryEnvironment): Promise<ComposedTuiPorts> {
  const host = await createForegroundPlanningHost({
    repositoryPath: environment.cwd,
    env: environment.env,
  });
  return { ports: host.ports, close: host.close };
}
