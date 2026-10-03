/**
 * 真实 PTY 验收（IP-02、IP-10）。
 *
 * 覆盖两类只有真实进程/终端才能证明的事实：
 *
 * 1. 前台入口与 TTY 门禁：无 TTY 时在挂载 Ink 之前以非零状态拒绝、stdout 不含渲染帧；`status --json`
 *    无 TTY 仍可运行；`resume`/`tui` 被拒绝并指出受支持入口。
 * 2. 真实 PTY 中的启动/退出与渲染保真：窗口 120x40 → 50x40 重绘后按显示宽度换行、边框列对齐、
 *    无旧帧残留；三档项目/图检查保留选择与草稿，关闭恢复原生输入位置。
 *
 * 运行：
 *
 * ```sh
 * pnpm exec vitest run tests/tui/pty.test.ts
 * ```
 *
 * 子进程跑构建产物而不是源码：Node 24 的 type stripping 不会把源码里的 `.js` 说明符重写成 `.ts`，
 * 因此 `dist/src/interfaces/cli/main.js` 才是真实入口。构建产物缺失或早于 `src` 变更时在收集阶段
 * 同步执行一次 `pnpm build`（`describe.skipIf` 需要收集期结论）；`pnpm` 不可用或构建失败时整个文件
 * 跳过，不伪造通过。
 *
 * PTY 来自独立 tmux server（`-L <socket>`），不触碰用户已有 tmux。tmux 不存在、无法 fork 进程，或
 * 沙箱拒绝 `/dev/ptmx` 时，全部真实 PTY 用例跳过并把原因写进跳过记录。
 */

import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, test } from 'vitest';

import { displayWidth } from '../../src/interfaces/tui/render/width.js';

const REPOSITORY_ROOT = process.cwd();
const BUILT_ENTRY = join(REPOSITORY_ROOT, 'dist', 'src', 'interfaces', 'cli', 'main.js');
const BUILT_TUI_APP = join(REPOSITORY_ROOT, 'dist', 'src', 'interfaces', 'tui', 'app.js');

/** 渲染保真样本：中文与中英文混排，且足够长到会在窄屏换行。 */
/** 换行前的稳定前缀（显示宽度 18，任何被测宽度下都不会被切断）。 */
const CJK_MARKER = '请规划第一版路线图';
const SIDEBAR_BORDER = '│';
const HORIZONTAL_RULE_LINE = /^[─│┌┐└┘├┤┬┴┼╭╮╰╯]+$/u;

/* -------------------------------------------------------------------------- */
/* 构建产物                                                                    */
/* -------------------------------------------------------------------------- */

type BuildAvailability = { readonly ok: true } | { readonly ok: false; readonly reason: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `src/` 下最新的 mtime；用于判断 dist 是否早于源码。 */
function newestSourceMtime(root: string): number {
  let newest = 0;
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    const mtime = statSync(join(entry.parentPath, entry.name)).mtimeMs;
    if (mtime > newest) {
      newest = mtime;
    }
  }
  return newest;
}

function runBuild(trigger: string): BuildAvailability {
  try {
    execFileSync('pnpm', ['build'], { cwd: REPOSITORY_ROOT, stdio: 'inherit' });
  } catch (error) {
    return { ok: false, reason: `${trigger}，且 pnpm build 失败：${errorMessage(error)}` };
  }
  if (!existsSync(BUILT_ENTRY) || !existsSync(BUILT_TUI_APP)) {
    return { ok: false, reason: `${trigger}，且构建后仍缺少入口或 TUI 产物` };
  }
  return { ok: true };
}

function ensureBuild(): BuildAvailability {
  if (!existsSync(BUILT_ENTRY) || !existsSync(BUILT_TUI_APP)) {
    return runBuild('构建产物缺失');
  }
  if (newestSourceMtime(join(REPOSITORY_ROOT, 'src')) > statSync(BUILT_ENTRY).mtimeMs) {
    return runBuild('构建产物早于 src 变更');
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* 子进程                                                                      */
/* -------------------------------------------------------------------------- */

function childEnvironment(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  return { ...process.env, TERM: 'dumb', ...extra };
}

function runCli(args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [BUILT_ENTRY, ...args], {
    cwd: REPOSITORY_ROOT,
    env: childEnvironment(),
    encoding: 'utf8',
    timeout: 30_000,
  });
}

/* -------------------------------------------------------------------------- */
/* tmux PTY                                                                    */
/* -------------------------------------------------------------------------- */

const TMUX_BIN = resolveTmux();

function resolveTmux(): string | null {
  if (existsSync('/usr/bin/tmux')) {
    return '/usr/bin/tmux';
  }
  const probe = spawnSync('tmux', ['-V'], { encoding: 'utf8', timeout: 2_000 });
  return probe.status === 0 ? 'tmux' : null;
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function tmux(
  socket: string,
  args: readonly string[],
  options: { readonly timeoutMs?: number; readonly env?: NodeJS.ProcessEnv | undefined } = {},
): SpawnSyncReturns<string> {
  if (TMUX_BIN === null) {
    throw new Error('tmux 不可用');
  }
  return spawnSync(TMUX_BIN, ['-L', socket, '-f', '/dev/null', ...args], {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 5_000,
    ...(options.env === undefined ? {} : { env: options.env }),
  });
}

function capturePane(socket: string, session: string): string {
  const result = tmux(socket, ['capture-pane', '-p', '-t', session]);
  return result.status === 0 ? (result.stdout ?? '') : '';
}

type PollResult = { readonly ok: boolean; readonly text: string };

/** 轮询 capture-pane，直到谓词成立或超时；不用固定睡眠做同步。 */
function pollPane(
  socket: string,
  session: string,
  predicate: (text: string) => boolean,
  timeoutMs = 5_000,
): PollResult {
  const deadline = Date.now() + timeoutMs;
  let text = capturePane(socket, session);
  while (!predicate(text) && Date.now() < deadline) {
    sleepSync(100);
    text = capturePane(socket, session);
  }
  return { ok: predicate(text), text };
}

function startSession(
  socket: string,
  session: string,
  width: number,
  height: number,
  command: string,
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv } = {},
): SpawnSyncReturns<string> {
  // 先建保活会话：没有会话的 tmux server 会立刻退出，那样任何服务级选项都留不下来，被观察的 pane
  // 退出后 `list-panes` 也读不到真实退出码。
  tmux(socket, ['new-session', '-d', '-s', '__keeper__', 'sleep 600'], { env: options.env });
  // remain-on-exit 必须是服务级窗口选项且在建会话前生效，否则进程退出时 pane 会被立刻销毁。
  tmux(socket, ['set-option', '-g', 'remain-on-exit', 'on'], { env: options.env });
  const args = ['new-session', '-d', '-s', session, '-x', String(width), '-y', String(height)];
  if (options.cwd !== undefined) {
    args.push('-c', options.cwd);
  }
  args.push(command);
  return tmux(socket, args, { env: options.env });
}

type PaneState = { readonly dead: boolean; readonly status: number | null };

function paneState(socket: string, session: string): PaneState {
  const result = tmux(socket, ['list-panes', '-t', session, '-F', '#{pane_dead}:#{pane_dead_status}']);
  const first = (result.stdout ?? '').trim().split('\n')[0] ?? '';
  const [dead, status] = first.split(':');
  return {
    dead: dead === '1',
    status: status === undefined || status.length === 0 ? null : Number(status),
  };
}

function pollPaneDead(socket: string, session: string, timeoutMs = 5_000): PaneState & { readonly ok: boolean } {
  const deadline = Date.now() + timeoutMs;
  let state = paneState(socket, session);
  while (!state.dead && Date.now() < deadline) {
    sleepSync(100);
    state = paneState(socket, session);
  }
  return { ...state, ok: state.dead };
}

function probeTmux(): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (TMUX_BIN === null) {
    return { ok: false, reason: '未找到可执行的 tmux' };
  }
  const socket = `orca-companion-pty-probe-${String(process.pid)}`;
  try {
    // 命令必须活过第一次 capture：`echo` 会让 pane 与 server 在捕获前就退出。
    const started = startSession(socket, 'probe', 80, 24, 'sh -c "printf __PTY_PROBE__; sleep 2"');
    if (started.status !== 0) {
      return { ok: false, reason: `tmux 无法创建 PTY 会话：${(started.stderr ?? '').trim()}` };
    }
    const captured = pollPane(socket, 'probe', (text) => text.includes('__PTY_PROBE__'), 2_000);
    return captured.ok ? { ok: true } : { ok: false, reason: 'tmux 会话未产生可捕获输出' };
  } finally {
    tmux(socket, ['kill-server']);
  }
}

/* -------------------------------------------------------------------------- */
/* 帧几何                                                                      */
/* -------------------------------------------------------------------------- */

function paneLines(frame: string): readonly string[] {
  return frame.split('\n').filter((line) => line.length > 0);
}

/** 一行里每个竖边框字符所在的显示列。 */
function verticalBorderColumns(line: string): readonly number[] {
  const columns: number[] = [];
  let column = 0;
  for (const character of line) {
    if (character === SIDEBAR_BORDER) {
      columns.push(column);
    }
    column += displayWidth(character);
  }
  return columns;
}

/**
 * 可观察的渲染保真问题。
 *
 * spec 说「所有含边框的行显示宽度一致」；不同盒子本来就允许不同宽度（全宽顶栏横线 = 终端宽度，
 * Sidebar 分隔线 = 主体宽度），因此这里断言的是真正可观察的对齐事实：任一行不超宽、所有含竖边框的
 * 输入框自身的左右边框对齐、含横线的行只由 box-drawing 字符组成（错位会混入文本）。
 * continuous 用户色边、工具详情与 Sidebar 分隔线各有自己的列，不能当成同一个外框。
 */
function frameGeometryProblems(lines: readonly string[], terminalWidth: number): readonly string[] {
  const problems: string[] = [];
  for (const line of lines) {
    const measured = displayWidth(line.trimEnd());
    if (measured > terminalWidth) {
      problems.push(`行宽 ${String(measured)} 超过终端 ${String(terminalWidth)}：${line}`);
    }
    // 只检查主视图那一列：横线属于 transcript 边框，Sidebar 在自己的列里显示文本是正确的并排渲染。
    const [mainColumn] = line.split(SIDEBAR_BORDER);
    const mainTrimmed = (mainColumn ?? '').trim();
    if (mainTrimmed.includes('─') && !HORIZONTAL_RULE_LINE.test(mainTrimmed)) {
      problems.push(`横线行混入非边框字符：${line}`);
    }
  }
  const top = lines.findIndex((line) => line.startsWith('╭'));
  const bottom = lines.findIndex((line, index) => index > top && line.startsWith('╰'));
  if (top >= 0 && bottom > top) {
    const width = displayWidth((lines[top] ?? '').split(SIDEBAR_BORDER)[0] ?? '');
    if (displayWidth((lines[bottom] ?? '').split(SIDEBAR_BORDER)[0] ?? '') !== width) {
      problems.push('输入框上下边框宽度不一致');
    }
    for (const line of lines.slice(top + 1, bottom)) {
      const columns = verticalBorderColumns(line);
      if (columns[0] !== 0 || !columns.includes(width - 1)) problems.push(`外框竖边框错位：${line}`);
    }
  }
  return problems;
}

/* -------------------------------------------------------------------------- */
/* PTY fixture                                                                 */
/* -------------------------------------------------------------------------- */

/** sh 单参数引用；只用于本文件控制的固定路径。 */
function quoteArgument(value: string): string {
  return JSON.stringify(value);
}

/* -------------------------------------------------------------------------- */
/* 用例                                                                        */
/* -------------------------------------------------------------------------- */

const build = ensureBuild();
const pty = build.ok ? probeTmux() : { ok: false as const, reason: '构建产物不可用' };
const SOCKETS: string[] = [];

function newSocket(label: string): string {
  const socket = `orca-companion-pty-${label}-${String(process.pid)}`;
  SOCKETS.push(socket);
  return socket;
}

function fixtureCommand(): string {
  return [process.execPath, join(REPOSITORY_ROOT, 'scripts', 'tui-preview.mjs')].map(quoteArgument).join(' ');
}

afterAll(() => {
  if (TMUX_BIN !== null) {
    for (const socket of SOCKETS) {
      tmux(socket, ['kill-server']);
    }
  }
});

const SUITE_NAME = build.ok
  ? '前台 TUI 与真实 PTY'
  : `前台 TUI 与真实 PTY（跳过：${build.reason}）`;

describe.skipIf(!build.ok)(SUITE_NAME, () => {
  describe('前台入口与 TTY 门禁', () => {
    test('无 TTY 启动前台 TUI：非零退出，诊断写 stderr，stdout 不含渲染帧', () => {
      const child = runCli([]);

      expect(child.status).not.toBeNull();
      expect(child.status).not.toBe(0);
      expect(child.stderr).toMatch(/TTY/u);
      // 必须在挂载 Ink 之前拒绝：不能出现渲染内容，也不能出现 raw-mode 假失败。
      expect(child.stdout).not.toMatch(/Command Palette|composer|Graph Inspector/u);
      expect(child.stdout).not.toMatch(/[─│┌┐└┘]/u);
      expect(child.stderr).not.toMatch(/Raw mode is not supported/u);
    });

    test('无 TTY 下 status --json 不因缺少 TTY 崩溃', () => {
      const child = runCli(['status', '--json']);

      expect([0, 1]).toContain(child.status);
      const stdout = child.stdout.trim();
      if (stdout.length === 0) {
        expect(child.stderr.trim().length).toBeGreaterThan(0);
      } else {
        expect(() => {
          JSON.parse(stdout);
        }).not.toThrow();
      }
      expect(child.stderr).not.toMatch(/Raw mode is not supported/u);
    });

    test.each(['resume', 'tui'])('退役子命令 %s 被拒绝并指出受支持入口', (subcommand) => {
      const child = runCli([subcommand]);

      expect(child.status).not.toBeNull();
      expect(child.status).not.toBe(0);
      expect(child.stderr).toContain(subcommand);
      expect(child.stderr).toMatch(/status/u);
      expect(child.stderr).toMatch(/doctor/u);
    });
  });

  describe('真实 PTY 生命周期与渲染保真', () => {
    if (!pty.ok) {
      test.skip(`真实 PTY 用例未运行：${pty.reason}`, () => {});
    } else {
      test.each([[120, 40], [80, 24], [50, 40]])('%i 列 %i 行中文多行粘贴只保存，退出恢复终端模式', (width, height) => {
        const socket = newSocket(`input-${String(width)}`);
        const session = 'input';
        // 同一个 shell 在 TUI 退出后检查原 PTY，才能证明 raw mode 已恢复。
        const command = `before=$(stty -g); ${fixtureCommand()}; result=$?; after=$(stty -g); if [ "$before" = "$after" ]; then printf '\\n__TERMINAL_RESTORED__\\n'; fi; printf '__TUI_EXIT_%s__\\n' "$result"; exit "$result"`;
        expect(startSession(socket, session, width, height, command, { cwd: REPOSITORY_ROOT }).status).toBe(0);
        expect(pollPane(socket, session, (text) => text.includes('普通消息')).ok).toBe(true);

        tmux(socket, ['send-keys', '-t', session, '-l', '\u001b[200~中文粘贴abc\n第二行\u001b[201~']);
        const pasted = pollPane(socket, session, (text) => text.includes('中文粘贴abc') && text.includes('第二行'));
        expect(pasted.ok, pasted.text).toBe(true);
        expect(pasted.text).not.toContain('preview_read_only');
        expect(frameGeometryProblems(paneLines(pasted.text), width)).toEqual([]);

        tmux(socket, ['send-keys', '-t', session, 'C-c']);
        const exited = pollPaneDead(socket, session);
        expect(exited.ok).toBe(true);
        expect(capturePane(socket, session)).toContain('__TUI_EXIT_0__');
        expect(capturePane(socket, session)).toContain('__TERMINAL_RESTORED__');
      });

      test('无色真实 PTY 的完整编辑、ShiftLeft 面板、Esc 光标恢复与折叠块查看', () => {
        const socket = newSocket('editor');
        const session = 'editor';
        expect(startSession(socket, session, 80, 24, `${fixtureCommand()} answer`, { cwd: REPOSITORY_ROOT, env: childEnvironment({ NO_COLOR: '1', FORCE_COLOR: '0' }) }).status).toBe(0);
        expect(pollPane(socket, session, (text) => text.includes('/answer')).ok).toBe(true);
        tmux(socket, ['send-keys', '-t', session, '-l', '首尾']);
        tmux(socket, ['send-keys', '-t', session, 'Left']);
        tmux(socket, ['send-keys', '-t', session, '-l', '中']);
        expect(pollPane(socket, session, (text) => text.includes('首中尾')).ok).toBe(true);
        const cursor = tmux(socket, ['display-message', '-p', '-t', session, '#{cursor_x}:#{cursor_y}:#{cursor_flag}']).stdout.trim().split(':');
        const cursorLine = capturePane(socket, session).split('\n')[Number(cursor[1])] ?? '';
        expect(Number(cursor[0])).toBe(displayWidth(cursorLine.slice(0, cursorLine.indexOf('首')) + '首中'));
        expect(cursor[2]).toBe('1');
        expect(capturePane(socket, session).split('\n')[Number(cursor[1])]).toContain('首中尾');
        tmux(socket, ['send-keys', '-t', session, '-l', '\u001b[1;2D']);
        expect(pollPane(socket, session, (text) => text.includes('请确认中文路径')).ok).toBe(true);
        tmux(socket, ['send-keys', '-t', session, 'Tab']);
        tmux(socket, ['send-keys', '-t', session, '-l', '回答草稿']);
        expect(pollPane(socket, session, (text) => text.includes('回答草稿')).ok).toBe(true);
        tmux(socket, ['send-keys', '-t', session, 'Escape']);
        expect(pollPane(socket, session, (text) => text.includes('普通消息')).ok).toBe(true);
        tmux(socket, ['send-keys', '-t', session, '-l', '后']);
        expect(pollPane(socket, session, (text) => text.includes('首中后尾')).ok).toBe(true);
        tmux(socket, ['send-keys', '-t', session, '-l', '\u001b[200~' + '中文'.repeat(501) + '\u001b[201~']);
        expect(pollPane(socket, session, (text) => text.includes('粘贴 1')).ok).toBe(true);
        tmux(socket, ['send-keys', '-t', session, 'C-p']);
        for (let index = 0; index < 15; index++) tmux(socket, ['send-keys', '-t', session, 'Down']);
        tmux(socket, ['send-keys', '-t', session, 'Enter']);
        expect(pollPane(socket, session, (text) => text.includes('粘贴查看')).ok).toBe(true);
        tmux(socket, ['send-keys', '-t', session, 'Escape']);
        expect(pollPane(socket, session, (text) => text.includes('粘贴 1')).ok).toBe(true);
        tmux(socket, ['send-keys', '-t', session, 'C-c']);
        expect(pollPane(socket, session, (text) => text.includes('确认')).ok).toBe(true);
        tmux(socket, ['send-keys', '-t', session, '-l', 'y']);
        expect(pollPaneDead(socket, session).ok).toBe(true);
      });

      test('PTY 中启动前台 TUI，Ctrl+C 退出后终端仍可用', () => {
        const socket = newSocket('start');
        const session = 'app';
        const command = [process.execPath, BUILT_ENTRY].map(quoteArgument).join(' ');
        expect(startSession(socket, session, 120, 40, command, { cwd: REPOSITORY_ROOT }).status).toBe(0);

        const frame = pollPane(socket, session, (text) => /Coordination Scope|初始化向导|Orca Companion|config_unavailable/u.test(text));
        expect(frame.ok, `5s 内未出现界面语义片段，最后帧：\n${frame.text}`).toBe(true);
        expect(paneState(socket, session).dead).toBe(false);

        tmux(socket, ['send-keys', '-t', session, 'C-c']);
        const exited = pollPaneDead(socket, session);
        expect(exited.ok, 'Ctrl+C 后 TUI 未在 5s 内退出').toBe(true);
        expect(exited.status).toBe(0);

        // 退出后同一 tmux server 仍能执行简单命令并返回正常退出码。
        expect(startSession(socket, 'usable', 80, 24, 'exit 0').status).toBe(0);
        const usable = pollPaneDead(socket, 'usable');
        expect(usable.ok).toBe(true);
        expect(usable.status).toBe(0);
      });

      test('resize 120x40 → 50x40 后按显示宽度重排，边框对齐且无旧帧残留', () => {
        const socket = newSocket('resize');
        const session = 'tui';
        expect(
          startSession(socket, session, 120, 40, fixtureCommand(), { cwd: REPOSITORY_ROOT }).status,
        ).toBe(0);

        const wide = pollPane(
          socket,
          session,
          (text) => text.includes(CJK_MARKER) && text.includes(SIDEBAR_BORDER) && text.includes('第一个工作包'),
        );
        expect(wide.ok, `120 列下未渲染出 CJK transcript 与完整 Sidebar：\n${wide.text}`).toBe(true);
        expect(frameGeometryProblems(paneLines(wide.text), 120)).toEqual([]);

        tmux(socket, ['resize-window', '-t', session, '-x', '50', '-y', '40']);
        const narrow = pollPane(
          socket,
          session,
          (text) => !text.includes('执行图侧栏') && text.includes(CJK_MARKER),
        );
        expect(narrow.ok, `50 列下未按新宽度重排（仍见旧帧或丢内容）：\n${narrow.text}`).toBe(true);
        expect(frameGeometryProblems(paneLines(narrow.text), 50)).toEqual([]);
        expect(narrow.text).not.toContain('sidebar full');
        // 全宽顶栏横线重排到新宽度，而不是残留 120 列。
        expect(narrow.text).toContain('─'.repeat(50));
      });

      test('执行态预览只用假端口，提交会明确拒绝', () => {
        const socket = newSocket('preview-read-only');
        const session = 'tui';
        expect(startSession(socket, session, 120, 40, `${fixtureCommand()} execution`, { cwd: REPOSITORY_ROOT }).status).toBe(0);
        const ready = pollPane(socket, session, (text) => text.includes('执行') && text.includes('implementing') && text.includes('preview-model-a'));
        expect(ready.ok, ready.text).toBe(true);
        tmux(socket, ['send-keys', '-t', session, '-l', 'hello']);
        expect(pollPane(socket,session,text=>text.includes('hello')).ok).toBe(true);
        tmux(socket, ['send-keys', '-t', session, 'Enter']);
        const rejected = pollPane(socket, session, (text) => text.includes('preview_read_only'));
        expect(rejected.ok, rejected.text).toBe(true);
        expect(paneState(socket, session).dead).toBe(false);
      });

      test('项目详情与图选择跨三档 resize 保持，返回恢复中文插入位置', () => {
        const socket=newSocket('project-graph-resize'),session='tui';
        expect(startSession(socket,session,120,40,fixtureCommand(),{cwd:REPOSITORY_ROOT}).status).toBe(0);
        expect(pollPane(socket,session,text=>text.includes('preview-model-a')).ok).toBe(true);
        tmux(socket,['send-keys','-t',session,'-l','首尾']);
        expect(pollPane(socket,session,text=>text.includes('首尾')).ok).toBe(true);
        tmux(socket,['send-keys','-t',session,'Left']);
        tmux(socket,['send-keys','-t',session,'C-b']);
        for(let index=0;index<3;index++)tmux(socket,['send-keys','-t',session,'Down']);
        tmux(socket,['send-keys','-t',session,'Enter']);
        expect(pollPane(socket,session,text=>text.includes('Scope: scope-preview')).ok).toBe(true);
        for(const [width,height] of [[80,24],[50,40]]){
          tmux(socket,['resize-window','-t',session,'-x',String(width),'-y',String(height)]);
          const detail=pollPane(socket,session,text=>text.includes('Scope: scope-preview')&&text.includes('项目面板')&&!text.includes('普通消息')&&frameGeometryProblems(paneLines(text),width!).length===0);
          expect(detail.ok,detail.text).toBe(true);
          expect(frameGeometryProblems(paneLines(detail.text),width!)).toEqual([]);
        }
        tmux(socket,['send-keys','-t',session,'Escape']);
        expect(pollPane(socket,session,text=>text.includes('项目面板')&&!text.includes('Scope: scope-preview')).ok).toBe(true);
        tmux(socket,['send-keys','-t',session,'Escape']);
        expect(pollPane(socket,session,text=>text.includes('普通消息')&&!text.includes('项目面板')).ok).toBe(true);
        tmux(socket,['send-keys','-t',session,'C-g']);
        expect(pollPane(socket,session,text=>text.includes('Graph Inspector')).ok).toBe(true);
        tmux(socket,['send-keys','-t',session,'Down']);
        const selected=pollPane(socket,session,text=>/(?:^|\n)[│\s]*2 长中文路径和日志验收/u.test(text));
        expect(selected.ok,selected.text).toBe(true);
        tmux(socket,['send-keys','-t',session,'Enter']);
        tmux(socket,['send-keys','-t',session,'Tab']);
        tmux(socket,['resize-window','-t',session,'-x','120','-y','40']);
        const graph=pollPane(socket,session,text=>text.includes('工作范围')&&text.includes('2 长中文路径和日志验收')&&text.includes('─'.repeat(120))&&text.includes('中文文件名.ts'));
        expect(graph.ok,graph.text).toBe(true);
        expect(graph.text).toContain('中文文件名.ts');
        tmux(socket,['send-keys','-t',session,'Escape']);
        expect(pollPane(socket,session,text=>text.includes('Graph Inspector')&&!text.includes('完整记录')).ok).toBe(true);
        tmux(socket,['send-keys','-t',session,'Escape']);
        expect(pollPane(socket,session,text=>text.includes('普通消息')).ok).toBe(true);
        tmux(socket,['send-keys','-t',session,'-l','中']);
        const restored=pollPane(socket,session,text=>text.includes('首中尾'));
        expect(restored.ok,restored.text).toBe(true);
      });

      test('50 列 Ctrl+G 可浏览图，Esc 恢复主视图', () => {
        const socket = newSocket('narrow');
        const session = 'tui';
        expect(
          startSession(socket, session, 50, 40, fixtureCommand(), { cwd: REPOSITORY_ROOT }).status,
        ).toBe(0);

        const frame = pollPane(socket, session, (text) => text.includes('普通消息') && text.includes(CJK_MARKER));
        expect(frame.ok, `50 列下主视图未就绪：\n${frame.text}`).toBe(true);

        tmux(socket, ['send-keys', '-t', session, 'C-g']);
        const afterInspector = pollPane(socket, session, (text) => text.includes('Graph Inspector'));
        expect(afterInspector.ok, afterInspector.text).toBe(true);
        expect(frameGeometryProblems(paneLines(afterInspector.text), 50)).toEqual([]);
        tmux(socket, ['send-keys', '-t', session, 'Escape']);
        const restored = pollPane(socket, session, (text) => text.includes('普通消息') && text.includes(CJK_MARKER));
        expect(restored.ok, restored.text).toBe(true);
      });
    }
  });
});
