/**
 * 真实 PTY 的执行阶段验收（`m2-deliver-execution-tui` 的 IP-10 / 任务 5.2、5.3）。
 *
 * 这是本 change 里需要真实 Orca、真实 Coordinator 模型与真实 PTY 的端到端用例：它在隔离项目里启动
 * 前台 TUI，驱动 Command Palette，再用 `status --json` 只读核对持久事实。
 *
 * ```sh
 * pnpm build   # 用例运行 `dist/src/interfaces/cli/main.js`，改了 src 必须先重新构建
 * ORCA_COMPANION_REAL_HARNESS=1 \
 * ORCA_COMPANION_REAL_REPO=<isolated-project> \
 * ORCA_COMPANION_REAL_IDENTITY=<dedicated-identity> \
 * ORCA_COMPANION_COORDINATOR_MODEL=minimax-cn/MiniMax-M3 \
 * pnpm exec vitest run tests/tui/pty-execution.test.ts --no-file-parallelism
 * ```
 *
 * 未显式开启时整个文件只留一条 skip 记录：不解析身份、不调用 Orca、不打开数据库。隔离项目必须已经
 * 初始化过一个 Coordination Scope 且至少注册一个 Coordinator Session；Session 历史应当很短——pane
 * 有 60 行高，帧高于它时 Ink 会把顶栏裁到可见区域之外。终端的列宽也要足够（本文件用 `-x 220 -y 60`），
 * 否则顶栏与 Sidebar 会被按宽度裁切。
 *
 * ## 当前状态：执行运行时已在生产路径接线，真实 PTY 验收仍需显式隔离环境
 *
 * `m2-wire-execution-runtime` 已把执行用例接进前台宿主，可核验的证据：
 *
 * - `src/bootstrap/foreground-planning-runtime.ts` 在启动对账完成后复用同一 Runtime Incarnation 跑一次
 *   对账序列，并在启动 / 授权切换 / Resume / 用户命令上触发单步 `advanceExecution`
 *   （`materializeWorkPackage` → Task → Worker）；
 * - 授权的生产来源是 Execution Authorization Review（`proposeManifest` + `recordApproval` +
 *   `transitionToExecution`），由审查界面触发、宿主补齐身份；
 * - Delivery 结算、Worker Session Recovery 续办、受控 Git 集成与只读 Finalizer
 *   （`finalizeProject`）都在生产路径上；`scope-control` 意图真实落盘（Resume 先对账再恢复调度）。
 *
 * 显式提供隔离项目与专用身份后，本文件检查真实 PTY、Scope 控制与持久事实。完整 Worker 闭环的用例
 * 仍单独跳过；当前主机的 Codex 受限沙箱不可用，见 `docs/orca-compatibility.md`。默认未设置
 * `ORCA_COMPANION_REAL_*` 时不打开真实项目。
 *
 * 用例会真实改变隔离项目的状态（Pause / Resume 一旦接线即写控制状态）。退出前台进程不会释放 Runtime
 * Lease（产品语义），重启类断言因此要等租约过期；重复运行同样请等 TTL 或换一个隔离项目。
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, expect, test } from 'vitest';

import { createOrcaExecutionBackend } from '../../src/adapters/orca-cli/orca-backend.js';
import { DEFAULT_RUNTIME_LEASE_TTL_MS } from '../../src/application/coordination/lease-service.js';
import { openRepositoryCoordinationStore } from '../../src/bootstrap/composition.js';
import { toChildEnvironment } from '../../src/interfaces/cli/main.js';
import { runStatus, type StatusSnapshot } from '../../src/interfaces/cli/status-command.js';
import { COMMAND_IDS, type CommandId } from '../../src/interfaces/tui/components/command-palette.js';

const COMPANION_REPOSITORY = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const BUILT_ENTRY = join(COMPANION_REPOSITORY, 'dist', 'src', 'interfaces', 'cli', 'main.js');
const REAL_SWITCH = 'ORCA_COMPANION_REAL_HARNESS';
const WORKSPACE_VAR = 'ORCA_COMPANION_REAL_REPO';
const IDENTITY_VAR = 'ORCA_COMPANION_REAL_IDENTITY';
const MODEL_VAR = 'ORCA_COMPANION_COORDINATOR_MODEL';
/** 计划要求的 Coordinator 模型；凭据只留在 provider 环境变量里，本文件不读也不打印。 */
const REQUIRED_COORDINATOR_MODEL = 'minimax-cn/MiniMax-M3';

/**
 * 执行运行时是否已在生产路径接线。
 *
 * 已接线（依据见文件头部「当前状态」）。用例仍然只在同时显式开启 `ORCA_COMPANION_REAL_HARNESS` 并给出
 * 隔离项目与专用身份时才运行，因此默认检查不会启动真实 Worker，也不会修改用户主项目。
 */
const EXECUTION_RUNTIME_WIRED: boolean = true;

type Gate =
  | { readonly kind: 'run'; readonly workspace: string; readonly identity: string }
  | { readonly kind: 'skip'; readonly reason: string };

function evaluateGate(): Gate {
  if (process.env[REAL_SWITCH] !== '1') {
    return { kind: 'skip', reason: `${REAL_SWITCH} 未显式开启` };
  }
  const workspace = process.env[WORKSPACE_VAR];
  if (workspace === undefined || workspace.length === 0) {
    return { kind: 'skip', reason: `${WORKSPACE_VAR} 未显式选择隔离项目` };
  }
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
    return { kind: 'skip', reason: `${WORKSPACE_VAR} 指向的不是已存在的目录` };
  }
  if (resolve(workspace) === COMPANION_REPOSITORY) {
    return { kind: 'skip', reason: '隔离项目不得是 Companion 自身仓库' };
  }
  if (!existsSync(join(workspace, '.git'))) {
    return { kind: 'skip', reason: `${WORKSPACE_VAR} 不是 Git 仓库` };
  }
  const identity = process.env[IDENTITY_VAR];
  if (identity === undefined || identity.length === 0) {
    return { kind: 'skip', reason: `${IDENTITY_VAR} 未显式选择专用身份` };
  }
  // 模型必须由用户显式声明：错误的模型会让「真实 PTY 执行验收」跑在与计划不同的执行体上。
  if (process.env[MODEL_VAR] !== REQUIRED_COORDINATOR_MODEL) {
    return { kind: 'skip', reason: `${MODEL_VAR} 必须显式声明为 ${REQUIRED_COORDINATOR_MODEL}` };
  }
  if (!existsSync(BUILT_ENTRY)) {
    return { kind: 'skip', reason: '先运行 pnpm build：用例启动的是 dist 里的前台入口' };
  }
  return { kind: 'run', workspace: resolve(workspace), identity };
}

/* -------------------------------------------------------------------------- */
/* tmux PTY                                                                    */
/* -------------------------------------------------------------------------- */

const TMUX_BIN = existsSync('/usr/bin/tmux') ? '/usr/bin/tmux' : 'tmux';

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function tmux(
  socket: string,
  args: readonly string[],
  options: { readonly env?: NodeJS.ProcessEnv | undefined } = {},
): SpawnSyncReturns<string> {
  return spawnSync(TMUX_BIN, ['-L', socket, '-f', '/dev/null', ...args], {
    encoding: 'utf8',
    timeout: 10_000,
    ...(options.env === undefined ? {} : { env: options.env }),
  });
}

function capturePane(socket: string, session: string): string {
  const result = tmux(socket, ['capture-pane', '-p', '-t', session]);
  return result.status === 0 ? (result.stdout ?? '') : '';
}

/**
 * 失败诊断用的 pane 存活状态。
 *
 * `capturePane` 在会话消失时返回空串，与「渲染了一屏空白」无法区分；失败信息里必须能看出是哪一种。
 */
function paneStatus(socket: string, session: string): string {
  const result = tmux(socket, [
    'display-message', '-p', '-t', session,
    'dead=#{pane_dead} status=#{pane_dead_status} cmd=#{pane_current_command}',
  ]);
  return result.status === 0 ? (result.stdout ?? '').trim() : `会话已消失（${(result.stderr ?? '').trim()}）`;
}

function pollPane(
  socket: string,
  session: string,
  predicate: (text: string) => boolean,
  timeoutMs = 5_000,
): { readonly ok: boolean; readonly text: string } {
  const deadline = Date.now() + timeoutMs;
  let text = capturePane(socket, session);
  while (!predicate(text) && Date.now() < deadline) {
    sleepSync(100);
    text = capturePane(socket, session);
  }
  return { ok: predicate(text), text };
}

function quoteArgument(value: string): string {
  return JSON.stringify(value);
}

function probePty(): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  const socket = `orca-companion-execution-probe-${String(process.pid)}`;
  try {
    // 命令必须活过第一次 capture：`echo` 会让 pane 与 server 在捕获前就退出，探测会永远失败，
    // 真实用例因而被静默跳过。
    const started = tmux(socket, [
      'new-session', '-d', '-s', 'probe', '-x', '80', '-y', '24',
      'sh -c "printf __PTY_PROBE__; sleep 2"',
    ]);
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
/* 只读事实与界面文本                                                          */
/* -------------------------------------------------------------------------- */

/** 与 `orca-companion status --json` 同一条只读路径读取隔离项目的持久事实。 */
async function readStatus(workspace: string): Promise<StatusSnapshot> {
  let stdout = '';
  let stderr = '';
  const code = await runStatus({
    openStore: () =>
      openRepositoryCoordinationStore({
        repositoryPath: workspace,
        env: toChildEnvironment(process.env),
        readOnly: true,
      }),
    json: true,
    io: {
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
    },
  });
  expect(code, `status 必须以 0 退出：${stderr}`).toBe(0);
  return JSON.parse(stdout) as StatusSnapshot;
}

/** 状态行的稳定形状：`[一次性提示 · ]revision N · sidebar <密度> …`。 */
const STATUS_LINE_PATTERN = /(?<notice>.*?)revision \d+ · sidebar (?:full|compact|collapsed)/u;

function statusLine(pane: string): string {
  return pane.split('\n').find((line) => STATUS_LINE_PATTERN.test(line)) ?? '';
}

/** 状态行上的一次性提示（拒绝原因、unknown 提示）；没有提示时为 `null`。 */
function noticeOf(pane: string): string | null {
  const matched = STATUS_LINE_PATTERN.exec(statusLine(pane));
  const prefix = (matched?.groups?.['notice'] ?? '').replace(/ · $/u, '').trim();
  return prefix.length === 0 ? null : prefix;
}

/** 状态行的执行摘要（第二行）：`active 0[ · reconciling]…`。 */
const EXECUTION_SUMMARY_PATTERN = /^active [01](?: ·|$)/u;

function executionSummaryLine(pane: string): string {
  return pane.split('\n').map((line) => line.trim()).find((line) => EXECUTION_SUMMARY_PATTERN.test(line)) ?? '';
}

/** 控制条 `scope control · <state>`；未渲染控制条时为 `null`。 */
function displayedControlStateOrNull(pane: string): string | null {
  return /scope control · ([a-z_]+)/u.exec(pane)?.[1] ?? null;
}

function displayedControlState(pane: string): string {
  const state = displayedControlStateOrNull(pane);
  expect(state, `未在界面上找到 Scope 控制条（control bar）：\n${pane}`).not.toBeNull();
  return state ?? '';
}

/* -------------------------------------------------------------------------- */
/* TUI 驱动                                                                    */
/* -------------------------------------------------------------------------- */

const SOCKET = `orca-companion-execution-${String(process.pid)}`;
const SESSION = 'execution';
/** 顶栏与 Sidebar 都按终端宽度裁切；窄屏会让本文件的顶栏断言失去意义。 */
const PANE_WIDTH = '220';
const PANE_HEIGHT = '60';

function startTui(workspace: string): void {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const command = [process.execPath, BUILT_ENTRY].map(quoteArgument).join(' ');
  // 上一次失败的尝试可能留下同名会话；先清掉，否则 tmux 的 `duplicate session` 会掩盖真实原因。
  tmux(SOCKET, ['kill-session', '-t', SESSION]);
  const started = tmux(SOCKET, [
    'new-session', '-d', '-s', SESSION, '-x', PANE_WIDTH, '-y', PANE_HEIGHT,
    '-c', workspace, command,
  ], { env });
  expect(started.status, `tmux 无法启动前台 TUI：${(started.stderr ?? '').trim()}`).toBe(0);
  const workspaceFrame = pollPane(SOCKET, SESSION, (text) => text.includes('composer ·'), 60_000);
  expect(
    workspaceFrame.ok,
    `TUI 未在隔离项目中进入 workspace（${paneStatus(SOCKET, SESSION)}）：\n${workspaceFrame.text}`,
  ).toBe(true);
}

/** Palette 执行命令 = Ctrl+P → 按目标索引次数的 Down → Enter；返回覆盖层关闭后的界面文本。 */
function runPaletteCommand(command: CommandId): void {
  const index = COMMAND_IDS.indexOf(command);
  expect(index, `未知命令 ${command}`).toBeGreaterThanOrEqual(0);
  tmux(SOCKET, ['send-keys', '-t', SESSION, 'C-p']);
  const palette = pollPane(SOCKET, SESSION, (text) => text.includes('Command Palette'));
  expect(palette.ok, `Command Palette 未打开：\n${palette.text}`).toBe(true);
  for (let step = 0; step < index; step += 1) {
    tmux(SOCKET, ['send-keys', '-t', SESSION, 'Down']);
  }
  tmux(SOCKET, ['send-keys', '-t', SESSION, 'Enter']);
  // 覆盖层关闭是 Enter 生效的可观察点；命令自身的异步结果由调用方继续等待。
  const closed = pollPane(SOCKET, SESSION, (text) => !text.includes('Command Palette'));
  expect(closed.ok, `Command Palette 未关闭：\n${closed.text}`).toBe(true);
}

type IntentOutcome = {
  readonly pane: string;
  readonly status: StatusSnapshot;
  /** 界面是否给出了可核验结果：控制状态变化，或状态行上出现一次性提示。 */
  readonly observed: boolean;
};

/**
 * 退出前台进程后重启。
 *
 * 退出不会释放 Runtime Lease（产品语义），同一身份立刻重启会被 fence 拒绝，因此必须等租约过期。
 */
function restartTui(workspace: string): void {
  tmux(SOCKET, ['kill-session', '-t', SESSION]);
  sleepSync(DEFAULT_RUNTIME_LEASE_TTL_MS + 5_000);
  startTui(workspace);
}

/* -------------------------------------------------------------------------- */
/* 用例                                                                        */
/* -------------------------------------------------------------------------- */

const gate = evaluateGate();

if (gate.kind === 'skip') {
  test.skip(`真实 PTY 执行阶段验收未运行：${gate.reason}`, () => {});
} else {
  const workspace = gate.workspace;
  const pty = probePty();

  if (!pty.ok) {
    test.skip(`真实 PTY 执行阶段验收未运行：${pty.reason}`, () => {});
  } else {
    let launched = false;

    // 无论用例如何结束都要拆掉这台机器上的 tmux server：留下的前台进程会继续持有 Runtime Lease。
    afterAll(() => {
      tmux(SOCKET, ['kill-server']);
    });

    /** 启动（一次）并返回 workspace 帧；后续用例复用同一个前台进程。 */
    function ensureTuiPane(): string {
      if (!launched) {
        startTui(workspace);
        launched = true;
      }
      const pane = capturePane(SOCKET, SESSION);
      expect(pane, `前台 TUI 不在 workspace（${paneStatus(SOCKET, SESSION)}）：\n${pane}`).toContain(
        'composer ·',
      );
      return pane;
    }

    /**
     * 提交一次 Scope 级控制命令，并等到界面给出可核验结果。
     *
     * 未接线时命令被拒绝：此时**唯一**的可观察结果是状态行上的一次性提示（拒绝原因），不会有任何控制
     * 状态写入。这里只等「状态变化或提示出现」，绝不把提示读成暂停成功——是否真的落盘由 `status --json`
     * 与调用方的一致性断言判定。
     */
    async function submitControl(
      command: CommandId,
      baselineControlState: string,
    ): Promise<IntentOutcome> {
      const initialNotice = noticeOf(capturePane(SOCKET, SESSION));
      runPaletteCommand(command);
      const deadline = Date.now() + 15_000;
      for (;;) {
        const pane = capturePane(SOCKET, SESSION);
        const changed = displayedControlStateOrNull(pane) !== baselineControlState;
        const notice = noticeOf(pane);
        const newNotice = notice !== null && notice !== initialNotice;
        if (changed || newNotice || Date.now() >= deadline) {
          return { pane, status: await readStatus(workspace), observed: changed || newNotice };
        }
        sleepSync(100);
      }
    }

    test(
      '① 前台 TUI 在隔离项目中启动并通过双 TTY 门禁',
      async () => {
        // 前台宿主从当前 canonical worktree 的终端里选身份：先证明它会采用的正是显式声明的专用身份。
        const backend = createOrcaExecutionBackend({
          cwd: workspace,
          env: toChildEnvironment(process.env),
        });
        const listed = await backend.query({
          operation: 'terminal-list',
          worktree: `path:${workspace}`,
        });
        expect(
          listed.kind,
          `Orca terminal-list 被拒绝：${JSON.stringify(listed)}`,
        ).toBe('accepted');
        if (listed.kind !== 'accepted') {
          return;
        }
        const terminals = listed.value as {
          readonly terminals: readonly {
            readonly handle: string;
            readonly connected: boolean;
            readonly writable: boolean;
            readonly orphaned: boolean;
            readonly executionHostId: string | null;
          }[];
          readonly hostIds: readonly string[];
        };
        const selectedIdentity = terminals.terminals.find((terminal) =>
          terminal.connected && terminal.writable && !terminal.orphaned &&
          terminal.executionHostId !== null && terminals.hostIds.includes(terminal.executionHostId),
        )?.handle;
        expect(selectedIdentity, '前台宿主将采用的身份必须是显式选择的专用身份').toBe(gate.identity);

        const pane = ensureTuiPane();
        // 双 TTY 门禁在挂载 Ink 之前判决：没有 TTY 时进程只会留下拒绝提示，不会渲染 workspace。
        expect(pane, '有 TTY 时不应出现无 TTY 的拒绝提示').not.toContain('需要交互式终端');
        expect(pane).toContain('composer ·');
      },
      180_000,
    );

    test(
      '② 顶栏显示 Graph Generation、Authorization 与 active 计数（Scenario: 授权不重置工作区 / 并发上限为 1）',
      async () => {
        const pane = ensureTuiPane();
        const status = await readStatus(workspace);
        const topBar = pane.split('\n').find((line) => line.startsWith('Scope ')) ?? '';
        expect(topBar, `顶栏未显示执行摘要（终端宽度 ${PANE_WIDTH} 是否被裁切）：\n${pane}`).toMatch(
          /gen=(?:none|\d+)/u,
        );
        expect(topBar).toContain(`active=${String(status.execution.activeWorkPackageCount)}`);
        // 顶栏不得虚构授权：显示的 Authorization 必须与持久化的授权记录一致。
        const authorization = status.scope.authorization;
        expect(topBar).toContain(
          authorization === null
            ? 'auth=none'
            : `auth=${authorization.id} v${String(authorization.version)}`,
        );
        // Execution Coordination 的并发上限固定为 1；真实快照与界面都只可能给出 0 或 1。
        expect(status.execution.activeWorkPackageCount).toBeLessThanOrEqual(1);
        expect(topBar).toMatch(/active=[01]\b/u);
      },
      90_000,
    );

    test(
      '③ Scope 级 Pause / Resume：界面显示的 control state 必须等于已持久化的状态（Scenario: Pause 不要求确认）',
      async () => {
        ensureTuiPane();
        const before = await readStatus(workspace);

        const paused = await submitControl('pause', before.scope.controlState);
        // Pause 从不要求确认，也不乐观显示终态：`cancelling` 一类终态只能来自后续快照。
        expect(paused.pane).not.toContain('确认 Cancel 整个 Coordination Scope');
        expect(paused.observed, '提交 Pause 后界面既没有状态变化也没有拒绝提示').toBe(true);
        expect(displayedControlState(paused.pane)).toBe(paused.status.scope.controlState);

        const resumed = await submitControl('resume', paused.status.scope.controlState);
        // Resume 只负责「先对账再恢复调度」；未接线时它以提示如实呈现，界面不得显示成已恢复。
        // 未接线时前后两次拒绝提示文本相同，状态行不提供第二个可区分信号，因此这里不再断言 observed。
        expect(displayedControlState(resumed.pane)).toBe(resumed.status.scope.controlState);
      },
      90_000,
    );

    test.skipIf(!EXECUTION_RUNTIME_WIRED)(
      '③ 接线后：Pause 落盘为 paused 且 status --json 可读，Resume 先对账再恢复 active',
      async () => {
        ensureTuiPane();
        const before = await readStatus(workspace);

        const paused = await submitControl('pause', before.scope.controlState);
        expect(paused.status.scope.controlState, `Pause 未落盘；PTY: ${paused.pane}`).toBe('paused');
        expect(displayedControlState(paused.pane)).toBe('paused');

        const resumed = await submitControl('resume', 'paused');
        expect(resumed.status.scope.controlState).toBe('active');
        expect(displayedControlState(resumed.pane)).toBe('active');
      },
      120_000,
    );

    test.skip(
      '④ 退出重启后界面先显示 reconciling（Scenario: 重启先对账）：需要可控的在途操作',
      () => {
        // 不可达：没有任何生产路径写 Operation Intent，也没有 Worker 会被派发，因此隔离项目里不可能
        // 存在「活跃 Worker 或未决操作」，界面不会进入 reconciling。见文件头部「当前状态」。
        // 可达的替代断言在下面：「重启后界面恢复同一持久事实，且不产生新的派发或集成」。
      },
    );

    test(
      '④ 退出重启后界面恢复同一持久事实，且不产生新的派发或集成（Scenario: 退出后不继续推进）',
      async () => {
        ensureTuiPane();
        const before = await readStatus(workspace);

        restartTui(workspace);
        ensureTuiPane();
        const after = await readStatus(workspace);

        // 重启只读回已持久化的事实：图、授权、控制状态与 Frontier 计数都不变。
        expect(after.graph ?? null).toEqual(before.graph ?? null);
        expect(after.scope.authorization).toEqual(before.scope.authorization);
        expect(after.scope.controlState).toBe(before.scope.controlState);
        expect(after.execution.activeWorkPackageCount).toBe(before.execution.activeWorkPackageCount);
        // 不产生新的派发：每个 Work Package 的生命周期与 attempt 身份在重启前后完全一致。
        expect(
          after.execution.workPackages.map((entry) => [
            entry.workPackageId,
            entry.state,
            entry.attemptId,
          ]),
        ).toEqual(
          before.execution.workPackages.map((entry) => [
            entry.workPackageId,
            entry.state,
            entry.attemptId,
          ]),
        );
        expect(after.blockers.length).toBe(before.blockers.length);

        // 「先对账」只在存在未对账事实时可见；两种状态下界面都必须与持久事实一致。
        const rendered = pollPane(SOCKET, SESSION, (text) =>
          executionSummaryLine(text).startsWith(`active ${String(after.execution.activeWorkPackageCount)}`) &&
          displayedControlStateOrNull(text) === after.scope.controlState,
        10_000);
        expect(rendered.ok, `界面未跟上持久事实：\n${rendered.text}`).toBe(true);
      },
      240_000,
    );

    test(
      '⑤b Finalizer 未返回结论时不显示 deliverable（Scenario: 单包验证通过不等于可交付 / blocker 结论明确呈现）',
      async () => {
        const pane = ensureTuiPane();
        const status = await readStatus(workspace);
        const verdict = status.execution.finalizer.verdict;
        expect(pane, `Sidebar 未渲染 finalizer 分区：\n${pane}`).toContain('finalizer');
        if (verdict === null) {
          // 没有独立结论时只能呈现「不显示 deliverable」。
          expect(pane).toContain('不显示 deliverable');
          expect(pane).not.toContain('verdict deliverable');
          return;
        }
        expect(pane).toContain(verdict.kind === 'deliverable' ? 'verdict deliverable' : 'verdict blocked');
      },
      60_000,
    );

    test.skip(
      '⑤ 串行 Frontier 推进、Validator repair、reconciliation 与 Finalizer deliverable：当前主机受限沙箱不可用',
      () => {},
    );

    test(
      '⑥ Ctrl+C 退出前台进程：不写 Scope 控制状态，也不产生新的派发（Scenario: Exit 不等同 Cancel / 退出后不继续推进）',
      async () => {
        ensureTuiPane();
        const before = await readStatus(workspace);
        // 不可核验 Worker 属于危险态；确认后仍只退出前台，不修改 Scope。
        tmux(SOCKET, ['send-keys', '-t', SESSION, 'C-c']);
        const prompted = pollPane(SOCKET, SESSION, (text) =>
          text.includes('确认退出前台进程') || !text.includes('composer ·'), 5_000);
        if (prompted.text.includes('确认退出前台进程')) {
          tmux(SOCKET, ['send-keys', '-t', SESSION, 'y']);
        }
        const gone = pollPane(SOCKET, SESSION, (text) => !text.includes('composer ·'), 30_000);
        expect(
          gone.ok,
          `前台进程未退出（${paneStatus(SOCKET, SESSION)}）：\n${gone.text}`,
        ).toBe(true);
        const after = await readStatus(workspace);
        // 退出只结束前台进程：Scope 不进入暂停或取消状态，也不留下未决操作。
        expect(after.scope.controlState).toBe(before.scope.controlState);
        expect(after.scope.unresolvedIntentCount).toBe(before.scope.unresolvedIntentCount);
        expect(after.execution.workPackages.length).toBe(before.execution.workPackages.length);
      },
      90_000,
    );
  }
}
