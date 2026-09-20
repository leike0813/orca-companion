# Ink / React 稳定组合与终端约束核验

对应 ticket：[*核验 Ink/React 稳定组合与本机终端约束*](https://github.com/leike0813/orca-companion/issues/4)（父地图 #1，M2 前置）。

结论先行：采用 **ink 7.1.1 + react 19.3.0 + @types/react 19.3.0 + ink-testing-library 4.0.0，Node.js 24**。ink 7.x 的 `engines.node` 为 `>=22`，本仓库 Node 24 基线满足，且 ink 官方 CI 矩阵显式覆盖 Node 24。`ink-testing-library@4.0.0` 停更于 2024-05，上游未针对 Ink 7 / React 19 发布新版本，但本机实测可正常工作。终端约束里最需要设防的一条是：**无 TTY 时任何 `useInput` 组件会让 Ink 抛出 raw mode 错误，而进程退出码仍为 0**，因此 M2 不能靠退出码判断 TUI 是否正常启动。

## 1. 核验环境与方法

| 项 | 值 | 来源 |
| --- | --- | --- |
| 核验日期 | 2026-09-17（Asia/Shanghai） | 本机 |
| Node.js | v24.12.0 | `node -v` |
| 包管理器 | pnpm 11.10.0 | `pnpm -v` |
| 操作系统 | Ubuntu 24.04.4 LTS，Linux 6.8.0-139-generic x86_64 | `uname -a`、`/etc/os-release` |
| Shell 终端 | zsh，`TERM=dumb`，当前 shell **非 TTY** | `echo $TERM`、`tty`（返回 "not a tty"） |
| 可用 PTY 工具 | tmux、screen、script（无 expect） | `which` |
| Python 运行 | `uv run --project="$HOME/.ar" --locked --` | AGENTS.md 约定 |

三类证据：

1. **在线第一方元数据**：npm registry 的 `dist-tags`/`versions`/`time`/`engines`/`peerDependencies`；GitHub 仓库 metadata、tag 列表、CI workflow。
2. **第一方源码**：`vadimdemedes/ink` 的 `v7.1.1` tag、`vadimdemedes/ink-testing-library` 的 `v4.0.0` tag（按 tag 解包阅读，非分支）。
3. **本机实测**：临时目录安装探针 + 真实 PTY（tmux 与 Python `pty`）行为探针。未修改本仓库任何既有文件，未创建 Run/Task/Dispatch。

## 2. 版本与兼容性结论

### 2.1 当前已发布稳定版本（2026-09-17 在线核对）

| 包 | latest | 发布时间 | engines | peerDependencies |
| --- | --- | --- | --- | --- |
| `ink` | 7.1.1 | 2026-07-16 | `node >=22` | `react >=19.2.0`、`@types/react >=19.2.0`（optional）、`react-devtools-core >=6.1.2`（optional） |
| `react` | 19.3.0 | 2026-09-09 | `node >=0.10.0` | — |
| `@types/react` | 19.3.0 | 2026-09-09 | — | — |
| `ink-testing-library` | 4.0.0 | 2024-05-22 | `node >=18` | `@types/react >=18.0.0`（optional） |

Ink 7 是 engines 的分界：`7.0.0` 起 `>=22`；`6.0.1` 为 `>=20`；`5.1.1` 为 `>=18`。`react` 是 ink 的**必需** peer，另外两个 peer 可选。

### 2.2 Node.js 24 支持

**明确支持。** ink 7.1.1 的 `engines.node` 为 `>=22`，覆盖 Node 24；ink 仓库 `.github/workflows/test.yml` 的 CI 矩阵为 `node_version: [24, 22]`，即 Node 24 是上游在跑的版本。本仓库 `package.json` 的 `engines.node` 为 `>=24`，与 ink 无冲突。

### 2.3 ink-testing-library 4.0.0：可推断兼容 + 本机已实测通过（非上游明确支持）

上游**没有**声明支持 Ink 7 / React 19：

- `v4.0.0` 的 `devDependencies` 固定 `ink ^5.0.0`、`react ^18.3.1`，`peerDependencies` 只有 `@types/react >=18.0.0`（optional）。
- GitHub 最后提交为 2024-05-22；`compare v4.0.0...master` 为 `ahead_by: 1`（一条 "Fix CI"），此后无新 release。
- 仓库未归档，`open_issues_count: 10`，但已两年无发布。

可推断兼容的依据是接口面：`source/index.ts` 只调用 `ink` 的公开 `render(tree, options)`，并传入 `stdout`/`stderr`/`stdin`/`debug`/`exitOnCtrlC`/`patchConsole`，不触碰 Ink 内部 API。因此跨大版本仍可用（本机已实测，见 2.4）。结论记为「可推断兼容 + 已实测通过」，不记为「上游明确支持」，后续升级 Ink 主版本时需回归。

### 2.4 推荐最小组合的实测结果（Node v24.12.0）

临时目录执行 `pnpm add ink@7.1.1 react@19.3.0 @types/react@19.3.0 ink-testing-library@4.0.0`：安装干净，41 个包，**无 peer 冲突警告**。

用 ink-testing-library 驱动一个包含 `useStdin().isRawModeSupported` 与 `useInput` 改 state 的 App，全部通过（5/5）：

- `render()` 返回实例，`frames`、`lastFrame()` 可用，首帧文本符合预期；
- `inst.stdin.write('i')` 触发 `useInput` 回调，state 递增并重渲染（`count=0` → `count=1`）；
- `rerender()`、`unmount()`、`cleanup()` 均无异常。

**M2 验收要点**：ink-testing-library 的 Stdin mock 将 `isTTY` 硬编码为 `true`，且 `setRawMode()` 是空操作。测试环境里 raw mode 永远「被支持」，**无法复现无 TTY 的真实报错**。无 TTY 行为必须用 CLI 层或真实 PTY 单独覆盖（见第 5 节）。

## 3. 本机终端约束（第一方源码 + 本机实测）

### 3.1 无 TTY（管道、CI、非交互）

交互判定在 `src/ink.tsx` 的 `resolveInteractiveOption`：`interactive = !isInCi && Boolean(stdout.isTTY)`。非交互时 Ink 禁用 ANSI 擦除、光标控制、同步输出、resize 处理与 kitty 键盘检测，只在 unmount 写最后一帧。

- **已实测**：非交互 render 仍正常输出最终帧，进程正常退出。
- **已实测**：存在 `useInput` 而无 TTY 时，Ink 抛出 `Raw mode is not supported on the current process.stdin, which Ink uses as input stream by default`，**但进程退出码仍为 0**（Ink 捕获异常并渲染为错误面板）。这一条直接影响 M2：不能以退出码判断 TUI 是否正常启动，应断言 stderr 或帧内容。
- 防呆来源：`src/components/App.tsx` 中 `isRawModeSupported = stdin.isTTY`，经 `useStdin()` 暴露；readme 明确要求用 `isRawModeSupported` 决定是否挂载 `useInput`。**该 guard 的端到端实测本次被中断，标记为尚未验证**；源码与文档证据充分，但 M2 应补一条实测。

### 3.2 raw mode 与 Ctrl+C

- `render()` 默认 `exitOnCtrlC: true`；raw mode 下 Ctrl+C 不是由 tty 驱动投递 SIGINT，而是由 Ink 从输入流读到 0x03 字节后自行处理（`App.tsx` 的 `handleInput`）。`render.ts` 文档原话：raw mode 下 Ctrl+C 被忽略，进程需自行处理。
- **已实测**（tmux PTY）：发送 C-c 后进程以 0 退出，终端提示符正常恢复。
- 含义：M2 的退出/取消应走 Ink 输入处理或 `useApp().exit()`；在 raw mode 下注册 `process.on('SIGINT')` 不会被触发。

### 3.3 重绘与终端恢复

- **恢复机制**：`ink.tsx` 在构造时注册 `signalExit(this.unmount, {alwaysLast: false})`，进程退出时执行 unmount 以恢复光标与 raw mode。**已实测**：退出后终端干净。
- **resize**：交互模式下 Ink 监听 `stdout` 的 `resize` 事件；`useWindowSize()` 订阅同一事件并触发重渲染。**已实测**（真实 PTY + SIGWINCH，保活进程）：`100x30 → 60x25 → 40x20` 逐次重渲染，hook 值同步更新。
- 变窄时会整屏清屏重画（`ink.tsx` 的 `resized()`，`currentWidth < lastTerminalWidth` 时 `log.clear()`）。
- **测试陷阱（已实测）**：若应用没有存活的事件循环句柄，进程会在 SIGWINCH 到达前退出，现象酷似「resize 不生效」。M2 的 resize 用例必须保活，否则会得到假阴性。

### 3.4 粘贴与 kitty 键盘

bracketed paste 仅在 `stdout.isTTY` 为真时启用；kitty 键盘协议为 opt-in，auto 模式要求 stdin 与 stdout 皆为 TTY。与 M2 首版关系有限，记录备查。

## 4. 推荐最小版本组合

| 包 | 版本 | 理由 |
| --- | --- | --- |
| `ink` | 7.1.1 | 当前 latest；`>=22` 覆盖 Node 24；peer 要求 react `>=19.2.0` |
| `react` | 19.3.0 | 当前 latest，满足 ink peer；与 19.3.0 类型定义同年同月发布 |
| `@types/react` | 19.3.0 | 与 react 同版本对齐 |
| `ink-testing-library` | 4.0.0（devDependency） | 唯一已发布版本；本机实测可用 |

在 lockfile 中固定上述版本，运行时基线为 Node.js 24。

## 5. M2 在 Linux 本机可执行的验收边界

### 明确支持，且本机已实测通过

1. 真实 PTY 下 TUI 可启动、raw mode 生效、键盘输入驱动状态更新、退出后终端恢复正常（tmux PTY 实测）。
2. 非 TTY 下不含 `useInput` 的核心可加载并输出最终帧，不要求 TTY、不进入 raw mode。
3. resize 触发重渲染与尺寸同步（前提：进程保活）。
4. ink-testing-library 可驱动组件交互（输入 → 状态 → 帧）以及 `rerender`/`unmount`/`cleanup`。

### 必须设防，且需另行覆盖

5. 无 TTY + `useInput` 的错误路径：断言 stderr 或帧文本，**不以退出码判定**（实测退出码为 0）。
6. `isRawModeSupported` guard 的端到端实测尚未完成，M2 需补一条无 TTY 的守卫用例。
7. 本机 agent shell 非 TTY 且 `TERM=dumb`，所有 TUI 用例必须经 PTY（tmux / script / pty）运行，不能在裸 shell 中运行 TUI 断言。

### 尚未验证

8. **Windows 11 全部相关路径**（raw mode、ANSI、信号、路径、终端恢复）。本机为 Ubuntu，无法验证，按 AGENTS.md 不得标记为已支持。
9. 中文宽字符、粘贴、窗口缩放下的重排质量：本机 `TERM=dumb`，仅验证了 resize 的尺寸事件与重渲染，未验证渲染质量。
10. ink-testing-library 上游对新版 Ink 的官方支持状态：上游无新 release，兼容性由本机实测而非上游承诺保证，升级 Ink 主版本时需回归。

## 6. 来源

- npm registry 包元数据（`dist-tags`/`versions`/`time`/`engines`/`peerDependencies`）：<https://registry.npmjs.org/ink>、<https://registry.npmjs.org/react>、<https://registry.npmjs.org/@types/react>、<https://registry.npmjs.org/ink-testing-library>
- Ink v7.1.1 源码与文档：<https://github.com/vadimdemedes/ink/tree/v7.1.1>
  - `src/ink.tsx`（`resolveInteractiveOption`、`resized`、`signalExit` 注册、非交互降级）
  - `src/components/App.tsx`（`isRawModeSupported`、`handleInput` 的 0x03 处理、`handleSetRawMode` 抛错）
  - `src/render.ts`（默认选项 `stdout`/`stdin`、`exitOnCtrlC: true`、raw mode 下 Ctrl+C 说明）
  - `src/hooks/use-window-size.ts`、`src/hooks/use-input.ts`
  - `.github/workflows/test.yml`（Node 24 / 22 CI 矩阵）
  - `readme.md`（`isRawModeSupported`、`setRawMode`、App Lifecycle 与 Ctrl+C）
- ink-testing-library v4.0.0 源码与包定义：<https://github.com/vadimdemedes/ink-testing-library/tree/v4.0.0>（`source/index.ts`、`package.json`）
- 各包 GitHub 仓库元数据与提交历史：<https://api.github.com/repos/vadimdemedes/ink>、<https://api.github.com/repos/vadimdemedes/ink-testing-library>
- 本机实测：Node v24.12.0 临时目录安装探针；tmux 与 Python `pty`（SIGWINCH）行为探针
