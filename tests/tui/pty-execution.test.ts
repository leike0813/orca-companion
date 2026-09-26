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
 * 未显式开启时整个文件只留一条 skip 记录：不解析身份、不调用 Orca、不打开数据库。隔离项目必须由本文件
 * 自己播种（见下），并且**尚无 Coordination Scope**；Session 历史应当很短——pane 有 60 行高，帧高于它时
 * Ink 会把顶栏裁到可见区域之外。终端的列宽也要足够（本文件用 `-x 220 -y 60`），否则顶栏与 Sidebar 会被
 * 按宽度裁切。
 *
 * ## 覆盖范围
 *
 * 用例顺序即阶段顺序，共用一个前台进程与一个 tmux server：
 *
 * 1. 播种（`beforeAll`）：用 `tests/support/real-execution-scope.ts` 把全新隔离项目推到
 *    「route_planning + 候选图与 Run」，与进程内的执行闭环用例共用同一份夹具；
 * 2. ①②③ 启动、顶栏与 Scope 控制的投影必须等于持久事实；
 * 3. ⑤ 在 TUI 里完成授权，再用 `Pause`/`Resume` 单步驱动真实串行 Frontier：真实 Planner、
 *    Implementation、Validator、受控 Git 集成与只读 Finalizer 都在生产路径上运行；期间**真实关闭一次
 *    Implementation Worker 的 agent 终端**制造执行态 Session 中断，核对 Recovery 的界面事实；
 * 4. ④ 退出重启：读回同一批 `(workPackageId, state, attemptId)`，不产生新的派发或集成；
 * 5. ⑤b 与 ⑥ Finalizer 终态投影与 `Ctrl+C` 前台退出。
 *
 * 所有角色共用一个模型来源（项目配置 `execution.workerModel`），因此验收要求它显式等于
 * `minimax-cn/MiniMax-M3`，并在真实 Codex Session 记录里逐角色核对。
 *
 * 本文件的现有单包场景不触发图修订；Graph Patch Planner 与 baseline reconciliation 的生产入口
 * 已由执行运行时接线，独立路径有行为测试。真实 PTY 同链路证据仍需隔离项目中增补该场景。
 *
 * ## 两种运行模式
 *
 * 两种模式分别验证 Session 中断续办与完整交付；使用的 Codex 必须通过真实只读能力探针：
 *
 * - 默认（制造一次执行态中断）：覆盖授权、真实 Planner/Implementation、同一会话内结算 Delivery、
 *   真实 Capsule、替代 Session 与界面事实；
 * - `ORCA_COMPANION_PTY_RECOVERY_INTERRUPT=0`（不中断）：链路一路走到 validate → 受控集成
 *   （canonical 被真实推进）→ Finalizer 派发，覆盖 Finalizer 的门禁与终态投影。
 *
 * 能力可用时必须取得独立 Finalizer 结论，不中断模式必须 deliverable；能力缺失只能接受点名该缺口的 blocker。
 *
 * 用例会真实改变隔离项目的状态。退出前台进程不会释放 Runtime Lease（产品语义），重启类断言因此要等
 * 租约过期；重复运行请换一个隔离项目。
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, expect, test } from 'vitest';

import { createOrcaExecutionBackend } from '../../src/adapters/orca-cli/orca-backend.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  RuntimeIncarnationId,
} from '../../src/application/dto/identity.js';
import { buildExecutionScope } from '../../src/application/ports/execution-backend.js';
import { DEFAULT_RUNTIME_LEASE_TTL_MS } from '../../src/application/coordination/lease-service.js';
import {
  createCoordinationStore,
  openRepositoryCoordinationStore,
  resolveGitCommonDir,
} from '../../src/bootstrap/composition.js';
import { toChildEnvironment } from '../../src/interfaces/cli/main.js';
import { runStatus, type StatusSnapshot } from '../../src/interfaces/cli/status-command.js';
import { COMMAND_IDS, type CommandId } from '../../src/interfaces/tui/components/command-palette.js';
import {
  mergeRealEnvFileIntoProcess,
  REAL_ENV_FILE_VAR,
} from '../support/real-env.js';
import { seedRealExecutionScope } from '../support/real-execution-scope.js';

const COMPANION_REPOSITORY = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const BUILT_ENTRY = join(COMPANION_REPOSITORY, 'dist', 'src', 'interfaces', 'cli', 'main.js');
const REAL_SWITCH = 'ORCA_COMPANION_REAL_HARNESS';
const WORKSPACE_VAR = 'ORCA_COMPANION_REAL_REPO';
const IDENTITY_VAR = 'ORCA_COMPANION_REAL_IDENTITY';
const MODEL_VAR = 'ORCA_COMPANION_COORDINATOR_MODEL';
/**
 * 是否制造一次执行态 Worker Session 中断（默认制造）。
 *
 * 默认覆盖真实 Capsule 与替代 Session；设为 `0` 验证不中断的完整交付。两种模式各用全新隔离项目。
 */
const RECOVERY_INTERRUPT_VAR = 'ORCA_COMPANION_PTY_RECOVERY_INTERRUPT';

/** provider 凭据的装载位置；与其它真实验收共用同一个 env 文件。 */
const DEFAULT_ENV_FILE = join(COMPANION_REPOSITORY, '.env.smoke');
/** 计划要求的 Coordinator 模型；凭据只留在 provider 环境变量里，本文件不读也不打印。 */
const REQUIRED_COORDINATOR_MODEL = 'minimax-cn/MiniMax-M3';
/** 只读 Worker 能力缺口的稳定 token：探针与 blocker 原因共用它（`codex-read-only-probe.ts`）。 */
const READ_ONLY_WORKER_BLOCKER = 'read_only_worker_unavailable';

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
  // 真实调用需要 provider 凭据：装载 env 文件（已存在的环境变量优先），缺凭据时明确跳过而不是让宿主
  // 在能力核验处失败。宿主与 Worker 都从这个进程继承环境。
  const envLoad = mergeRealEnvFileIntoProcess(
    process.env[REAL_ENV_FILE_VAR] ?? DEFAULT_ENV_FILE,
  );
  if (!envLoad.hasProviderCredential) {
    return {
      kind: 'skip',
      reason: `缺少 provider 凭据：请设置 OPENAI_API_KEY，或填充 ${envLoad.path}（或经 ${REAL_ENV_FILE_VAR} 指定）`,
    };
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

/**
 * 状态行的执行摘要（第二行）：`active 0[ · reconciling]…`。
 *
 * 同一行右侧是 Sidebar 的内容（两者在同一个终端行里拼接），因此这里只认行首的 `active 0|1` 词边界，
 * 不对行尾作任何假设。
 */
const EXECUTION_SUMMARY_PATTERN = /^active [01]\b/u;

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
/** 一轮开始前等宿主静止的窗口：外部派发与结算都要走完。 */
const QUIESCENCE_WINDOW_MS = 10 * 60_000;
/** 在途真实 Worker 的收尾窗口：超时不再硬失败，而是把链路停在可诊断的位置。 */
const IN_FLIGHT_WINDOW_MS = 12 * 60_000;
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
  // TypeScript 不会把外层的窄化带进嵌套函数：专用身份在这里显式取出，后续一律用它。
  const dedicatedIdentity = gate.identity;
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

    /* ---------------------------------------------------------------------- */
    /* 真实执行闭环的夹具与事实读取                                             */
    /* ---------------------------------------------------------------------- */

    /** 播种得到的 Orca Run：驱动按它读 Worker 存活（`worker-list` 必须带 `--run`）。 */
    let seededRunId = '';

    /** 本次运行是否制造执行态中断（见文件头部：两种模式各覆盖一半）。 */
    const interruptRecovery = process.env[RECOVERY_INTERRUPT_VAR] !== '0';

    /** 播种时 canonical 的 HEAD：集成必须把它推进，验收据此用 Git 事实核验集成。 */
    let seededBaselineHead = '';

    /**
     * 把全新隔离项目推到「route_planning + 候选图与 Run」。
     *
     * 与进程内的执行闭环用例共用同一个夹具函数（`tests/support/real-execution-scope.ts`），因此两者
     * 验证的是同一条生产路径，而不是各自拼一套事实。已有 Scope 的项目会在这里直接失败。
     */
    beforeAll(async () => {
      const seeded = await seedRealExecutionScope({
        workspace,
        identity: dedicatedIdentity,
        objective: 'm2-deliver-execution-tui 真实 PTY 执行验收',
        env: process.env as Record<string, string>,
      });
      seededRunId = seeded.orcaRunId;
      seededBaselineHead = seeded.baselineHead;
    }, 300_000);

    /** 与前台宿主同一个后端：同一条身份约定、同一个 transport。 */
    const backend = createOrcaExecutionBackend({
      cwd: workspace,
      env: toChildEnvironment(process.env),
      resolveIdentityHandle: (ref) => Promise.resolve(ref === dedicatedIdentity ? ref : undefined),
    });

    /**
     * 轮询到条件成立。
     *
     * 真实 Worker 的完成时间只能由外部事实回答，因此等待的是**条件**，不是猜的固定时长。
     */
    async function pollUntil(
      check: () => Promise<boolean>,
      intervalMs: number,
      timeoutMs: number,
    ): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (await check()) {
          return true;
        }
        if (Date.now() >= deadline) {
          return false;
        }
        sleepSync(intervalMs);
      }
    }

    /** 一次 Run 下的真实 Worker 事实。读不到 `worker-list` 时返回空数组——宿主也不把它读成「没有 Worker」。 */
    type RunWorkerFacts = {
      readonly dispatchId: string;
      readonly taskId: string | null;
      readonly workerState: string | null;
      readonly agentTerminalHandle: string | null;
    };

    async function listRunWorkers(): Promise<readonly RunWorkerFacts[]> {
      const listed = await backend.query({ operation: 'worker-list', runId: seededRunId });
      if (listed.kind !== 'accepted') {
        return [];
      }
      const workers =
        (listed.value as { readonly workers?: readonly Record<string, unknown>[] }).workers ?? [];
      return workers.map((worker) => ({
        dispatchId: typeof worker['dispatchId'] === 'string' ? worker['dispatchId'] : '',
        taskId: typeof worker['taskId'] === 'string' ? worker['taskId'] : null,
        workerState: typeof worker['workerState'] === 'string' ? worker['workerState'] : null,
        agentTerminalHandle:
          typeof worker['agentTerminalHandle'] === 'string' ? worker['agentTerminalHandle'] : null,
      }));
    }

    /**
     * 「这次派发还没收尾」的取值闭集。
     *
     * 生产侧的存活判据（`execution-view.ts`）把 `ready`/`starting`/`stopping` 一类取值判为**不可核验**，
     * 因此它们不算 `live`（fail closed，不得读成「没有 Worker」）。但对驱动来说这些取值意味着派发仍在
     * 进行：prepared terminal 上的真实 Codex 会话running期间正是 `ready`。驱动必须据此等待，否则会在
     * Worker 还在跑时就把链路判成停住。
     */
    const IN_FLIGHT_WORKER_STATES = new Set([
      'running',
      'active',
      'working',
      'in_progress',
      'starting',
      'ready',
      'start_unknown',
      'stopping',
      'stop_unknown',
    ]);

    async function inFlightWorkers(): Promise<readonly RunWorkerFacts[]> {
      return (await listRunWorkers()).filter(
        (worker) => worker.workerState !== null && IN_FLIGHT_WORKER_STATES.has(worker.workerState),
      );
    }

    async function inFlightWorkerCount(): Promise<number> {
      return (await inFlightWorkers()).length;
    }

    /** 只读读取本次验收关心的持久事实：Recovery 记录与逐角色的物化绑定（含 launchId）。 */
    type ExecutionFacts = {
      readonly recoveries: readonly {
        readonly recoveryId: string;
        readonly role: string;
        readonly status: string;
        readonly capsuleRef: string | null;
        readonly replacementSegmentId: string | null;
        readonly supersededSegmentId: string | null;
        readonly blockingReason: string | null;
        readonly terminalOutcome: string | null;
      }[];
      readonly roleLaunches: readonly {
        readonly role: string;
        readonly launchId: string;
        readonly orcaTaskId: string;
      }[];
      /** 已经有 Session Segment（可核验会话）的 Dispatch：中断必须落在真实会话上。 */
      readonly sessionBoundDispatchIds: readonly string[];
      readonly coordinationScopeId: string;
      readonly gitCommonDir: string;
      /** 当前 Graph Generation 与它在 Orca 侧的 consumer generation：中断操作的 authority 需要它们。 */
      readonly graphGeneration: number;
      readonly consumerGeneration: number;
    };

    async function readExecutionFacts(): Promise<ExecutionFacts> {
      const commonDir = await resolveGitCommonDir({
        repositoryPath: workspace,
        env: toChildEnvironment(process.env),
      });
      if (commonDir.kind !== 'resolved') {
        throw new Error(`无法解析 Git common dir：${commonDir.message}`);
      }
      const opened = createCoordinationStore({
        gitCommonDir: commonDir.path,
        readOnly: true,
      });
      if (opened.kind !== 'opened') {
        throw new Error(`无法只读打开协调库：${opened.message}`);
      }
      try {
        const scopes = opened.store.query({ kind: 'scopes' });
        const coordinationScopeId =
          scopes.kind === 'scopes' ? (scopes.scopes[0]?.coordinationScopeId ?? '') : '';
        if (coordinationScopeId.length === 0) {
          throw new Error('隔离项目没有 Coordination Scope');
        }
        const recoveries = opened.store.query({
          kind: 'recoveries',
          coordinationScopeId: coordinationScopeId as CoordinationScopeId,
        });
        const bindings = opened.store.query({
          kind: 'materialization-bindings',
          coordinationScopeId: coordinationScopeId as CoordinationScopeId,
        });
        const segments = opened.store.query({
          kind: 'session-segments',
          coordinationScopeId: coordinationScopeId as CoordinationScopeId,
        });
        const generations = opened.store.query({
          kind: 'graph-generations',
          coordinationScopeId: coordinationScopeId as CoordinationScopeId,
        });
        const settlements = opened.store.query({
          kind: 'delivery-settlements',
          coordinationScopeId: coordinationScopeId as CoordinationScopeId,
        });
        const currentGeneration =
          generations.kind === 'graph-generations' ? generations.generations[0] : undefined;
        // consumer generation 是 Orca 在绑定消费者时给出的代际：播种建立的第一个 Run 为 1，其后以已结算
        // Delivery 记录里的取值为准（那是 Orca 自己写回的权威值）。
        const consumerGeneration =
          settlements.kind === 'delivery-settlements' && settlements.settlements.length > 0
            ? Math.max(...settlements.settlements.map((entry) => entry.consumerGeneration))
            : 1;
        return {
          coordinationScopeId,
          gitCommonDir: commonDir.path,
          sessionBoundDispatchIds:
            segments.kind === 'session-segments'
              ? segments.segments.map((segment) => segment.dispatchId)
              : [],
          graphGeneration: currentGeneration?.generation ?? 1,
          consumerGeneration,
          recoveries:
            recoveries.kind === 'recoveries'
              ? recoveries.recoveries.map((recovery) => ({
                  recoveryId: recovery.recoveryId,
                  role: recovery.role,
                  status: recovery.status,
                  capsuleRef: recovery.capsuleRef,
                  replacementSegmentId: recovery.replacementSegmentId,
                  supersededSegmentId: recovery.supersededSegmentId,
                  blockingReason: recovery.blockingReason,
                  terminalOutcome: recovery.terminalOutcome,
                }))
              : [],
          roleLaunches:
            bindings.kind === 'materialization-bindings'
              ? bindings.bindings.flatMap((binding) =>
                  binding.role !== null && binding.launchId !== null
                    ? [{ role: binding.role, launchId: binding.launchId, orcaTaskId: binding.orcaTaskId }]
                    : [],
                )
              : [],
        };
      } finally {
        opened.close();
      }
    }

    /**
     * 逐角色核对真实 Codex Session 记录里的模型。
     *
     * 角色的状态根名字是 `sha256(launchId)` 的前 20 位（`createCodexWorkerLaunch` 派生），因此可以从
     * 物化绑定把状态根映射回角色；Finalizer 没有物化绑定（它由宿主直接派发），但它在 canonical worktree
     * 里运行，用 rollout 的 `cwd` 认它。会话记录里出现的模型名是这次派发真正使用的模型绑定，不是配置回显。
     */
    function roleSessionModels(facts: ExecutionFacts): ReadonlyMap<string, readonly string[]> {
      const stateRoot = join(facts.gitCommonDir, 'orca-companion', 'codex');
      const models = new Map<string, string[]>();
      if (!existsSync(stateRoot)) {
        return models;
      }
      const roleOfDigest = new Map<string, string>();
      for (const entry of facts.roleLaunches) {
        roleOfDigest.set(createHash('sha256').update(entry.launchId).digest('hex').slice(0, 20), entry.role);
      }
      for (const dirent of readdirSync(stateRoot, { withFileTypes: true, encoding: 'utf8' })) {
        if (!dirent.isDirectory()) {
          continue;
        }
        const sessions = join(stateRoot, dirent.name, 'sessions');
        if (!existsSync(sessions)) {
          continue;
        }
        const rollouts = readdirSync(sessions, { recursive: true, encoding: 'utf8' })
          .filter((name) => /rollout-.*\.jsonl$/u.test(name))
          .map((name) => join(sessions, name));
        for (const rollout of rollouts) {
          const first = readFileSync(rollout, 'utf8').split('\n').find((line) => line.length > 0);
          if (first === undefined) {
            continue;
          }
          const parsed = JSON.parse(first) as {
            readonly payload?: {
              readonly cwd?: unknown;
              readonly base_instructions?: { readonly text?: unknown };
            };
          };
          const text = parsed.payload?.base_instructions?.text;
          const matched = typeof text === 'string' ? /MiniMax-[A-Za-z0-9.-]+/u.exec(text)?.[0] : undefined;
          if (matched === undefined) {
            continue;
          }
          const role =
            roleOfDigest.get(dirent.name) ??
            (parsed.payload?.cwd === workspace ? 'finalizer' : dirent.name);
          const list = models.get(role) ?? [];
          list.push(matched);
          models.set(role, list);
        }
      }
      return models;
    }

    /** 轮询到持久事实满足条件；失败信息带上是哪一条事实没到。 */
    async function pollStatus(
      predicate: (status: StatusSnapshot) => boolean,
      timeoutMs: number,
      what: string,
    ): Promise<StatusSnapshot> {
      const deadline = Date.now() + timeoutMs;
      let status = await readStatus(workspace);
      while (!predicate(status) && Date.now() < deadline) {
        sleepSync(1_000);
        status = await readStatus(workspace);
      }
      expect(predicate(status), `${what}：${describeStatus(status)}`).toBe(true);
      return status;
    }

    function describeStatus(status: StatusSnapshot): string {
      return JSON.stringify({
        mode: status.scope.mode,
        controlState: status.scope.controlState,
        active: status.execution.activeWorkPackageCount,
        workPackages: status.execution.workPackages.map((entry) => [
          entry.workPackageId,
          entry.state,
          entry.role,
          entry.attemptId,
        ]),
        verdict: status.execution.finalizer.verdict?.kind ?? null,
        blockers: status.blockers.map((blocker) => `${blocker.source}:${blocker.code}`),
      });
    }

    /**
     * 本次运行是不是被「本机只读 Worker 能力缺口」解释的。
     *
     * 这是唯一允许「没有真实 Capsule / 没有 deliverable」的环境原因：探针结论在 blocker 里点名
     * `read_only_worker_unavailable`（见 `docs/orca-compatibility.md`）。没有这个 token 时，只读能力
     * 就已经被证明可用，链路必须真的取得 Capsule 与交付结论——宽松接受任何 blocker 会让环境恢复后
     * 的失败被静默吞掉。
     */
    function readOnlyCapabilityGap(input: {
      readonly blockers: StatusSnapshot['blockers'];
      readonly recoveries: ExecutionFacts['recoveries'];
    }): boolean {
      return (
        input.blockers.some(
          (blocker) => blocker.code.includes('read_only_worker') || blocker.message.includes(READ_ONLY_WORKER_BLOCKER),
        ) ||
        input.recoveries.some((recovery) => (recovery.blockingReason ?? '').includes(READ_ONLY_WORKER_BLOCKER))
      );
    }

    /**
     * Orca Task → 角色。
     *
     * Scope 快照里的 `role` 是**物化时**记下的角色，真实派发之后还会滞后一轮投影，因此不能用它判断
     * 「此刻在跑的是谁」；Orca 的 Task 身份才是这次派发的当前事实。
     */
    function roleOfTask(facts: ExecutionFacts, taskId: string | null): string | null {
      if (taskId === null) {
        return null;
      }
      return facts.roleLaunches.find((entry) => entry.orcaTaskId === taskId)?.role ?? null;
    }

    /** 与生产同一份已退出判据（`execution-view.ts` 的 `EXITED_WORKER_STATES`）。 */
    const EXITED_WORKER_STATES = new Set([
      'succeeded',
      'failed',
      'cancelled',
      'canceled',
      'exited',
      'abandoned',
      'completed',
      'done',
      'timed_out',
    ]);

    /**
     * 真实制造一次执行态 Worker Session 中断。
     *
     * 关闭该 Dispatch 的 agent 终端会被 Orca 记成 operator_close（workerState `failed`，属于已退出），
     * 而 `worker-stop` 只停在 `stopped`——它不在已退出集合里，宿主因此不会把它认成中断。副作用经生产
     * transport（`ExecutionBackend.mutate`）发出，不绕过 adapter。
     */
    async function interruptWorkerSession(
      facts: ExecutionFacts,
      worker: RunWorkerFacts,
    ): Promise<void> {
      const status = await readStatus(workspace);
      const authorization = status.scope.authorization;
      expect(authorization, '中断必须发生在已授权进入 Execution Coordination 之后').not.toBeNull();
      const handle = worker.agentTerminalHandle;
      expect(handle, '被中断的 Worker 必须有可关闭的 exact terminal').not.toBeNull();
      const scope = buildExecutionScope({
        coordinationScopeId: facts.coordinationScopeId as CoordinationScopeId,
        coordinatorSessionId: 'e2e-loop-session' as CoordinatorSessionId,
        runtimeIncarnationId: 'pty-execution-interrupt' as RuntimeIncarnationId,
        fencingGeneration: 0,
        backendIdentityRef: dedicatedIdentity,
        operationId: `pty-execution-interrupt:${worker.dispatchId}`,
        target: { kind: 'worker-dispatch', id: worker.dispatchId },
        expectedRevision: status.snapshotRevision,
        timeoutMs: 60_000,
        authority: {
          kind: 'execution_coordination',
          graphGeneration: facts.graphGeneration,
          authorizationId: authorization?.id ?? '',
          runId: seededRunId,
          consumerGeneration: facts.consumerGeneration,
        },
      });
      const closed = await backend.mutate(
        { operation: 'terminal-close', terminal: handle ?? '' },
        scope,
      );
      expect(closed.kind, `关闭 Worker agent 终端失败：${JSON.stringify(closed)}`).toBe('accepted');
    }

    /**
     * 同一终端行里左面板与 Sidebar 用 `│` 分隔：Sidebar 单元格是最后一个分隔符之后的内容。
     *
     * 不能直接对整行 trim 后比较分区标题——左边距会把 `│recovery` 一起带进来。
     */
    function sidebarCell(line: string): string {
      const index = line.lastIndexOf('│');
      return (index < 0 ? line : line.slice(index + 1)).trim();
    }

    /** Sidebar 的 recovery 分区行；没有该分区时为空数组。 */
    function recoveryRows(pane: string): readonly string[] {
      const cells = pane.split('\n').map(sidebarCell);
      const headers = new Set([
        '预算',
        'execution graph',
        'integration queue (串行)',
        'recovery',
        'workers',
        'blockers',
        'finalizer',
      ]);
      const start = cells.indexOf('recovery');
      if (start < 0) {
        return [];
      }
      const rows: string[] = [];
      for (const cell of cells.slice(start + 1)) {
        if (headers.has(cell)) {
          break;
        }
        if (cell.length > 0) {
          rows.push(cell);
        }
      }
      return rows;
    }

    /**
     * 等到宿主静止：没有未收尾的真实 Worker，也没有未决 mutation intent。
     *
     * 宿主的触发是 fire-and-forget 的：上一轮 Resume 触发的推进还在派发时按 Pause，会让这次派发在
     * 「控制状态不是 active」下被拒绝，而随后的 Resume 又会因为未决 mutation 而**先对账后拒绝恢复**
     * （D4 的既有语义，界面显示 reconciling）。驱动必须先等它收尾。
     */
    async function waitForQuiescence(timeoutMs: number): Promise<boolean> {
      return pollUntil(async () => {
        if ((await inFlightWorkerCount()) > 0) {
          return false;
        }
        const status = await readStatus(workspace);
        return (
          status.scope.unresolvedIntentCount === 0 &&
          status.execution.executionReconciliation.unresolvedIntentCount === 0
        );
      }, 5_000, timeoutMs);
    }

    /**
     * Pause → Resume 一次，让宿主做一次触发（只有 Resume 会触发）。
     *
     * 不要求宿主静止：真实 Worker 正在跑时也要用它——补记在途派发的 Session Binding 只发生在触发点上。
     */
    async function pokeTrigger(): Promise<boolean> {
      const before = await readStatus(workspace);
      if (before.scope.controlState !== 'paused') {
        const paused = await submitControl('pause', before.scope.controlState);
        if (paused.status.scope.controlState !== 'paused') {
          return false;
        }
      }
      const resumed = await submitControl('resume', 'paused');
      return resumed.status.scope.controlState === 'active';
    }

    /**
     * 提交一次推进轮次：先等宿主静止，再 Pause → Resume。
     *
     * 返回这次轮次是否真的落到 `active`：被拒绝时不把它读成成功——拒绝本身是界面上的可观察事实
     * （状态行提示或 reconciling），由调用方按「无变化」处理。
     */
    async function triggerRound(): Promise<boolean> {
      await waitForQuiescence(QUIESCENCE_WINDOW_MS);
      return pokeTrigger();
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
        expect(selectedIdentity, '前台宿主将采用的身份必须是显式选择的专用身份').toBe(dedicatedIdentity);

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

    test(
      '③ 接线：Pause 落盘为 paused 且 status --json 可读，Resume 先对账再恢复 active',
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

    test(
      '⑤ 授权 → 串行 Frontier → 执行态 Recovery → Finalizer（Scenario: 授权切换 / 串行推进 / Recovery 可观察 / Finalizer 终态）',
      async () => {
        expect(seededRunId.length, '播种必须给出候选图的 Orca Run').toBeGreaterThan(0);
        const config = JSON.parse(readFileSync(join(workspace, 'orca-companion.json'), 'utf8')) as {
          readonly execution?: { readonly workerModel?: unknown };
        };
        // 所有角色共用一个模型来源（项目配置），因此验收先钉住它，再由真实 Session 记录逐角色核对。
        expect(config.execution?.workerModel, 'Worker 模型必须由项目配置显式给出').toBe(
          REQUIRED_COORDINATOR_MODEL,
        );

        // ---- 授权：在 TUI 里打开审阅并批准 ----
        const seeded = await readStatus(workspace);
        expect(seeded.scope.mode).toBe('route_planning');
        runPaletteCommand('authorize-execution');
        const review = pollPane(
          SOCKET,
          SESSION,
          (text) => text.includes('Execution Authorization Review'),
          60_000,
        );
        expect(review.ok, `授权审阅未打开（${paneStatus(SOCKET, SESSION)}）：\n${review.text}`).toBe(true);
        // 放宽沙箱必须真的写在项目配置里并被审阅显示出来，批准才是有意为之。
        expect(review.text, '审阅必须显示 Worker Sandbox').toContain('danger-full-access');
        expect(review.text, '门禁通过才允许批准').toContain('门禁: 通过');
        tmux(SOCKET, ['send-keys', '-t', SESSION, 'Enter']);
        const authorized = await pollStatus(
          (status) => status.scope.mode === 'execution_coordination',
          120_000,
          '授权未进入 Execution Coordination',
        );
        expect(authorized.scope.authorization).not.toBeNull();
        expect(authorized.scope.executionLeaseHolder).not.toBeNull();
        // 授权不重置工作区：顶栏出现授权，composer 仍在。
        const authorizedPane = pollPane(SOCKET, SESSION, (text) => /auth=(?!none)\S+/u.test(text), 30_000);
        expect(authorizedPane.ok, `顶栏未显示授权：\n${authorizedPane.text}`).toBe(true);
        expect(authorizedPane.text, '授权不重置工作区').toContain('composer ·');

        // ---- 驱动：一次触发最多推进一个阶段，因此用 Pause→Resume 轮次推进真实 Frontier ----
        const fingerprintOf = (status: StatusSnapshot): string =>
          status.execution.workPackages
            .map((entry) => `${entry.workPackageId}:${entry.state}:${entry.role ?? '-'}:${entry.attemptId ?? '-'}`)
            .join('|');
        /**
         * 终态判据：Finalizer 给出独立结论，或某个 Work Package 阻塞且**没有仍在续办的 Recovery**。
         *
         * 后者是必要的区分：Recovery 未决时 Work Package 也显示为阻塞，但它还在推进，不能当终态。
         */
        const terminalReached = (status: StatusSnapshot, facts: ExecutionFacts): boolean =>
          status.execution.finalizer.verdict !== null ||
          (status.execution.workPackages.some((entry) => entry.state === 'blocked') &&
            facts.recoveries.every(
              (recovery) =>
                recovery.status === 'recovered' ||
                recovery.status === 'blocked' ||
                // 带原因的未决 Recovery 表示 lane 已被占住：它在界面上就是 blocker，不会自愈。
                recovery.blockingReason !== null,
            ));
        // 制造中断时链路会停在 Recovery blocker（还要等 Capsule 的同步窗口）；不制造中断时要一路推到
        // 集成与 Finalizer 派发，再给独立结论留一段有界的等待窗口。
        const deadline = Date.now() + (interruptRecovery ? 60 : 40) * 60_000;
        /** 一轮触发后等待可观察变化的窗口：有真实 Worker 在跑时要等它收尾，没有 Worker 时不必空等。 */
        const WORKER_WINDOW_MS = 15 * 60_000;
        const NO_WORKER_WINDOW_MS = 90_000;
        /** 容忍的连续无变化轮次：结果消息要等进度批次被确认后才成为当前批次，一轮可能只推进消息。 */
        const MAX_NO_CHANGE_ROUNDS = 4;
        let snapshot = authorized;
        let loopFacts = await readExecutionFacts();
        let rounds = 0;
        let interrupted: string | null = null;
        let noChangeRounds = 0;
        while (Date.now() < deadline && !terminalReached(snapshot, loopFacts)) {
          const inFlight = await inFlightWorkers();
          if (inFlight.length > 0) {
            const target = inFlight.length === 1 ? inFlight[0] : undefined;
            const targetRole = target === undefined ? null : roleOfTask(loopFacts, target.taskId);
            // 只中断 Implementation 或 Validator：Planner 的产出是 Specification Admission 的确定性
            // 门禁，不动它才能让本条链路走完；替代 Session 由 Recovery 在同一次 Attempt 内续办。
            const interruptible =
              interruptRecovery &&
              target !== undefined &&
              (targetRole === 'implementation' || targetRole === 'validator');
            if (interrupted === null && interruptible && target !== undefined) {
              if (!loopFacts.sessionBoundDispatchIds.includes(target.dispatchId)) {
                // 会话还没被绑定：在 SessionStart 之前关掉终端只会留下一个不可观察的派发（宿主 blocker
                // `awaiting-observation`，没有 Session 可恢复）。先触发一轮让宿主补记 Session Binding。
                await pokeTrigger();
                rounds += 1;
                loopFacts = await readExecutionFacts();
                snapshot = await readStatus(workspace);
                continue;
              }
              await interruptWorkerSession(await readExecutionFacts(), target);
              const exited = await pollUntil(async () => {
                const after = (await listRunWorkers()).find((worker) => worker.dispatchId === target.dispatchId);
                return (
                  after !== undefined &&
                  after.workerState !== null &&
                  EXITED_WORKER_STATES.has(after.workerState)
                );
              }, 2_000, 120_000);
              expect(exited, '关闭终端后 Orca 必须把该 Dispatch 记为已退出').toBe(true);
              interrupted = target.dispatchId;
            }
            const idle = await pollUntil(
              async () => (await inFlightWorkerCount()) === 0,
              5_000,
              IN_FLIGHT_WINDOW_MS,
            );
            if (!idle) {
              // 真实 Worker 长时间不收尾：本机只读沙箱会让受限会话（Capsule Utility、Finalizer）卡在
              // 自己的第一轮命令上。它既没有退出、也没有结果，不能读成任何一种终态，因此停在这里，
              // 由结论断言回答「链路停在哪儿、有没有 deliverable」。
              const stalled = await readStatus(workspace);
              console.warn(
                `[pty-execution] 在途 Worker 未在窗口内收尾，停止驱动：${describeStatus(stalled)}`,
              );
              break;
            }
            continue;
          }
          const beforeFingerprint = fingerprintOf(snapshot);
          const roundApplied = await triggerRound();
          rounds += 1;
          const workerDeadline = Date.now() + WORKER_WINDOW_MS;
          const noWorkerDeadline = Date.now() + NO_WORKER_WINDOW_MS;
          let sawInFlightWorker = (await inFlightWorkerCount()) > 0;
          let advanced = false;
          for (;;) {
            const live = await inFlightWorkerCount();
            const wasLive = sawInFlightWorker;
            sawInFlightWorker = sawInFlightWorker || live > 0;
            const current = await readStatus(workspace);
            if (
              fingerprintOf(current) !== beforeFingerprint ||
              current.execution.finalizer.verdict !== null ||
              current.blockers.length > 0 ||
              // 刚结束的真实 Worker：交付要走下一次触发才结算，因此这里就返回。
              (wasLive && live === 0)
            ) {
              advanced = true;
              break;
            }
            if (Date.now() >= (sawInFlightWorker ? workerDeadline : noWorkerDeadline)) {
              break;
            }
            sleepSync(5_000);
          }
          snapshot = await readStatus(workspace);
          loopFacts = await readExecutionFacts();
          console.warn(`[pty-execution] round=${String(rounds)} advanced=${String(advanced)} ${describeStatus(snapshot)}`);
          // 并发上限固定为 1：任一时刻最多一个 Work Package 处于非终态。
          expect(snapshot.execution.activeWorkPackageCount, '并发上限为 1').toBeLessThanOrEqual(1);
          noChangeRounds = advanced && roundApplied ? 0 : noChangeRounds + 1;
          if (noChangeRounds >= MAX_NO_CHANGE_ROUNDS) {
            break;
          }
        }
        expect(rounds, '闭环没有产生任何推进').toBeGreaterThan(0);
        const observed = await readStatus(workspace);
        const facts = await readExecutionFacts();
        console.warn(`[pty-execution] rounds=${String(rounds)} ${describeStatus(observed)}`);

        // ---- 界面先重读一次快照：只是为了让 Sidebar 画出已持久化的 Recovery / Finalizer 事实 ----
        await waitForQuiescence(QUIESCENCE_WINDOW_MS);
        await submitControl('pause', (await readStatus(workspace)).scope.controlState);
        const refreshed = pollPane(
          SOCKET,
          SESSION,
          (text) => text.includes('finalizer'),
          15_000,
        );
        expect(refreshed.ok, `Sidebar 未渲染 finalizer 分区：\n${refreshed.text}`).toBe(true);

        const capabilityGap = readOnlyCapabilityGap({ blockers: observed.blockers, recoveries: facts.recoveries });
        if (interruptRecovery) {
          // ---- 执行态 Worker Session Recovery：真实中断必须留下可核验的 Recovery，并在界面如实可见 ----
          expect(
            facts.recoveries.length,
            '本次验收必须覆盖至少一次执行态 Worker Session Recovery',
          ).toBeGreaterThan(0);
          const recovery = facts.recoveries[0];
          expect(recovery, 'Recovery 记录必须可读').toBeDefined();
          const recovered = typeof recovery?.replacementSegmentId === 'string' || recovery?.status === 'recovered';
          if (capabilityGap) {
            // 只读受限命令跑不起来时 Capsule 无法投递：此时只接受点名能力缺口的 blocker。
            expect(recovery?.status, `能力缺口必须停在 blocker：${JSON.stringify(facts.recoveries)}`).toBe('blocked');
            expect(
              recovery?.blockingReason ?? '',
              `能力缺口的 blocker 必须可诊断：${JSON.stringify(facts.recoveries)}`,
            ).toContain(READ_ONLY_WORKER_BLOCKER);
          } else {
            // 能力可用：中断必须被真实 Capsule 续办，替代 Session 是唯一可接受的终态。
            expect(recovered, `本机只读能力可用时必须取得真实 Capsule：${JSON.stringify(facts.recoveries)}`).toBe(true);
          }
          const rows = recoveryRows(refreshed.text);
          expect(rows.length, `Sidebar 未渲染 recovery 分区：\n${refreshed.text}`).toBeGreaterThan(0);
          const rowsText = rows.join('\n');
          expect(rowsText, 'recovery 行必须点名角色与状态').toContain(recovery?.role ?? '');
          if (!recovered) {
            expect(rowsText, `blocked Recovery 必须在界面上带原因：\n${rowsText}`).toMatch(/^! .+/mu);
          }
          if (recovered) {
            expect(recovery?.capsuleRef, '续办必须绑定真实 Capsule').toEqual(expect.any(String));
            expect(recovery?.replacementSegmentId, '续办必须绑定替代 Segment').toEqual(expect.any(String));
            // Sidebar 会裁切长身份；身份取持久事实，界面核验状态与对应行。
            expect(rowsText).toContain('recovered');
            expect(rowsText).toMatch(/^segment \S+/mu);
          }
        } else {
          // 未制造中断时不该凭空出现 Recovery：Record 只能由真实中断产生。
          expect(facts.recoveries).toEqual([]);
        }

        // ---- 集成：取得交付结论后，用 Git 事实核验 canonical 真的前进了 ----
        if (observed.execution.finalizer.verdict?.kind === 'deliverable') {
          const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' });
          expect(head.status).toBe(0);
          expect(head.stdout.trim(), 'canonical 必须已被受控集成推进').not.toBe(seededBaselineHead);
          const remote = spawnSync('git', ['ls-remote', 'origin', 'refs/heads/main'], {
            cwd: workspace,
            encoding: 'utf8',
          });
          expect(remote.status).toBe(0);
          expect(remote.stdout.split(/\s+/u)[0], '获批 remote 必须包含集成后的 HEAD').toBe(head.stdout.trim());
        }

        // ---- Finalizer：只有被接受的只读结论才显示 deliverable ----
        //
        // 能力不可用时（见 docs/orca-compatibility.md）界面只能呈现「不显示
        // deliverable」，且 blocker 必须点名能力缺口；能力可用时链路必须真的取得交付结论，本次运行
        // 的交付物（deliverable）是必达项，不再接受任何其他 blocker 作为替代。
        const verdict = observed.execution.finalizer.verdict;
        if (capabilityGap) {
          expect(verdict, '只读能力不可用时不接受任何交付结论').toBeNull();
          expect(
            refreshed.text,
            `没有独立结论时不得显示 deliverable：\n${refreshed.text}`,
          ).toContain('verdict 未返回（不显示 deliverable）');
          expect(refreshed.text).not.toContain('verdict deliverable');
        } else {
          expect(
            verdict,
            `本机只读能力可用时必须取得独立交付结论：${describeStatus(observed)}`,
          ).not.toBeNull();
          expect(
            refreshed.text,
            `Finalizer 结论必须在界面上如实呈现：\n${refreshed.text}`,
          ).toContain(verdict?.kind === 'deliverable' ? 'verdict deliverable' : 'verdict blocked');
          if (!interruptRecovery) {
            // 不制造中断的那次验收以 deliverable 为必达项：只读角色能跑通就应该走完整条链路。
            expect(verdict?.kind, `不中断模式必须取得 deliverable：${describeStatus(observed)}`).toBe('deliverable');
            // 只读观察属于运行中的宿主；独立 status 查询只有持久事实，无法提供该观察。
            expect(refreshed.text).toContain('read-only enforced');
          }
        }

        // ---- 逐角色核对真实 Codex Session 的模型绑定 ----
        const models = roleSessionModels(facts);
        // 每个真的跑起来的角色都必须落在配置声明的模型上：模型来自唯一来源（项目配置），这里是逐角色的
        // 真实会话证据。Planner 与 Implementation 在两种模式下都会出现，因此必须读到。
        for (const role of ['planner', 'implementation', ...models.keys()]) {
          const seen = models.get(role) ?? [];
          expect(
            seen.length,
            `没有读到 ${role} 的真实 Codex Session 记录：${[...models.keys()].join(',')}`,
          ).toBeGreaterThan(0);
          expect(
            seen.every((model) => model.includes('MiniMax-M3')),
            `${role} 的 Session 记录模型不符：${seen.join(',')}`,
          ).toBe(true);
        }
      },
      // 与循环的 60 分钟截止一致：进度由真实 Worker 决定，vitest 只在链路真的卡死时才兜底。
      3_600_000,
    );

    test.skip(
      '④ 退出重启后界面先显示 reconciling（Scenario: 重启先对账）：需要可控的在途操作',
      () => {
        // 不可达：真实闭环里每个阶段都会收尾（Worker 退出、Delivery 结算、集成完成），重启时不存在
        // 「活跃 Worker 或未决操作」，界面因此不会进入 reconciling。见文件头部「覆盖范围」。
        // 可达的替代断言在下面：「重启后界面恢复同一持久事实，且不产生新的派发或集成」。
      },
    );

    test(
      '④ 退出重启后界面恢复同一持久事实，且不产生新的派发或集成（Scenario: 退出后不继续推进）',
      async () => {
        ensureTuiPane();
        const before = await readStatus(workspace);
        const dispatchesBefore = (await listRunWorkers()).map((worker) => worker.dispatchId).sort();

        restartTui(workspace);
        ensureTuiPane();
        const after = await readStatus(workspace);
        expect((await listRunWorkers()).map((worker) => worker.dispatchId).sort()).toEqual(dispatchesBefore);

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
        expect(
          rendered.ok,
          `界面未跟上持久事实（期望 active=${String(after.execution.activeWorkPackageCount)} control=${after.scope.controlState}；` +
            `界面 active=${executionSummaryLine(rendered.text)} control=${String(displayedControlStateOrNull(rendered.text))}）：\n${rendered.text}`,
        ).toBe(true);
      },
      240_000,
    );

    test(
      '⑤b Finalizer 未返回结论时不显示 deliverable（Scenario: 单包验证通过不等于可交付 / blocker 结论明确呈现）',
      async () => {
        const pane = ensureTuiPane();
        const status = await readStatus(workspace);
        const facts = await readExecutionFacts();
        const verdict = status.execution.finalizer.verdict;
        expect(pane, `Sidebar 未渲染 finalizer 分区：\n${pane}`).toContain('finalizer');
        if (verdict === null) {
          // 没有独立结论时只能呈现「不显示 deliverable」，而且必须由本机只读能力缺口解释。
          expect(pane).toContain('不显示 deliverable');
          expect(pane).not.toContain('verdict deliverable');
          expect(
            readOnlyCapabilityGap({ blockers: status.blockers, recoveries: facts.recoveries }),
            `没有结论必须能被只读能力缺口解释：${describeStatus(status)}`,
          ).toBe(true);
          return;
        }
        expect(pane).toContain(verdict.kind === 'deliverable' ? 'verdict deliverable' : 'verdict blocked');
      },
      60_000,
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
