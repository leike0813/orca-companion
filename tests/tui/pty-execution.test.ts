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
 * ORCA_COMPANION_REAL_SCOPE=<fixture-scope> \
 * ORCA_COMPANION_PTY_PHASE=execution \
 * ORCA_COMPANION_COORDINATOR_MODEL=minimax-cn/MiniMax-M3.1-Flash-Preview \
 * pnpm exec vitest run tests/tui/pty-execution.test.ts --no-file-parallelism
 * ```
 *
 * 未显式开启时整个文件只留一条 skip 记录：不解析身份、不调用 Orca、不打开数据库。隔离项目必须由本文件
 * 自己播种（见下），并且**尚无 Coordination Scope**；Session 历史应当很短——pane 有 80 行高，帧高于它时
 * Ink 会把顶栏裁到可见区域之外。终端的列宽也要足够（本文件用 `-x 220 -y 80`），否则顶栏与 Sidebar 会被
 * 按宽度裁切。
 *
 * ## 覆盖范围
 *
 * 用例顺序即阶段顺序，共用一个前台进程与一个 tmux server：
 *
 * 1. 播种（`beforeAll`）：用 `tests/support/real-execution-scope.ts` 把全新隔离项目推到
 *    「route_planning + 候选图与 Run」，与进程内的执行闭环用例共用同一份夹具；
 * 2. ①②③ 启动、顶栏与 Scope 控制的投影必须等于持久事实；
 * 3. ⑤ 在 TUI 里完成授权，再用 `Pause`/`Resume` 单步驱动真实串行 Frontier：两个 Work Package 的
 *    Planner、Implementation、Validator、受控 Git 集成、Graph Patch Planner、Baseline Reconciliation 与
 *    只读 Finalizer 都在生产路径上运行；默认模式**真实关闭一次 Implementation Worker 的 agent 终端**
 *    制造执行态 Session 中断，核对 Recovery 的界面事实；
 * 4. ④ 退出重启：读回同一批 `(workPackageId, state, attemptId)`，不产生新的派发或集成；
 * 5. ⑤b 与 ⑥ Finalizer 终态投影与 `Ctrl+C` 前台退出。
 *
 * 各角色由项目 schema2 的 Worker Profile 显式绑定模型，验收先核对当前角色配置，再核对真实
 * Codex Session；配置本身不代替启动证据。
 *
 * ## 图修订与基线补救的同链路覆盖
 *
 * 夹具是两个互不依赖的 Work Package：第一个集成让 canonical 前移之后，第二个包的 worktree 仍建立在授权
 * baseline 上，于是链路必须真的走一次 **Baseline Reconciliation**（`advanceExecution` 在派发前登记需求，
 * 物化只把 worktree 建出来、角色 Task 由门禁挡到核验通过）才能继续。第一个包被接受之后、第二个包仍未被
 * 接受时，用例经 composer 提交一次含糊变化声明：真实 Coordinator 调用 `request_graph_patch`，工具内部
 * 有界等待 Run 静止并结清未确认 Delivery，然后真实 Graph Patch Planner 产出补丁、Admission 追加
 * GraphVersion，修订后的 worktree 由独立 Planner Task 对齐并核验。
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
  GraphGeneration,
  GraphId,
  GraphVersion,
  PlanningCycleId,
  RuntimeIncarnationId,
} from '../../src/application/dto/identity.js';
import { buildExecutionScope } from '../../src/application/ports/execution-backend.js';
import type { CoordinationWriter } from '../../src/application/ports/branch-coordination-store.js';
import { DEFAULT_RUNTIME_LEASE_TTL_MS } from '../../src/application/coordination/lease-service.js';
import { acquireRuntimeLease } from '../../src/application/coordination/lease-service.js';
import { readScope } from '../../src/application/planning/scope-read.js';
import {
  beginReplanningTransition,
  commitGenerationCutover,
  completeReplanningTransition,
} from '../../src/application/execution/replanning-service.js';
import { proposeExecutionGraph } from '../../src/bootstrap/execution-runtime.js';
import { DEFAULT_EXECUTION_LIMITS } from '../../src/domain/planning/budget-policy.js';
import {
  createCoordinationStore,
  openRepositoryCoordinationStore,
  resolveGitCommonDir,
} from '../../src/bootstrap/composition.js';
import { toChildEnvironment } from '../../src/interfaces/cli/main.js';
import { runStatus, type StatusSnapshot } from '../../src/interfaces/cli/status-command.js';
import { COMMAND_IDS, type CommandId } from '../../src/interfaces/tui/components/command-palette.js';
import { REAL_LOOP_PLAN, seedRealExecutionScope } from '../support/real-execution-scope.js';
import { executionManifest } from '../support/execution-harness.js';
import { currentWorkerProfile, parseProjectConfig } from '../../src/bootstrap/project-config.js';
import type { ModelProfileRole } from '../../src/domain/model-configuration.js';

const COMPANION_REPOSITORY = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const BUILT_ENTRY = join(COMPANION_REPOSITORY, 'dist', 'src', 'interfaces', 'cli', 'main.js');
const REAL_SWITCH = 'ORCA_COMPANION_REAL_HARNESS';
const WORKSPACE_VAR = 'ORCA_COMPANION_REAL_REPO';
const IDENTITY_VAR = 'ORCA_COMPANION_REAL_IDENTITY';
const SCOPE_VAR = 'ORCA_COMPANION_REAL_SCOPE';
/** 置 1 时要求本次图变化声明把目标节点退场，用来验收「退场」形态；默认验收「保留并修订」形态。 */
const RETIRE_NODE_SWITCH = 'ORCA_COMPANION_PTY_RETIRE_NODE';
const MODEL_VAR = 'ORCA_COMPANION_COORDINATOR_MODEL';
/**
 * 是否制造一次执行态 Worker Session 中断（默认制造）。
 *
 * 默认覆盖真实 Capsule 与替代 Session；设为 `0` 验证不中断的完整交付。两种模式各用全新隔离项目。
 */
const RECOVERY_INTERRUPT_VAR = 'ORCA_COMPANION_PTY_RECOVERY_INTERRUPT';
/**
 * 只跑零 provider 成本的阶段（`ORCA_COMPANION_PTY_PHASE=cutover-only`）。
 *
 * ①–⑥ 都要真实派发 Codex Worker 与 Coordinator 模型；⑦ 只走生产应用用例加一次真实新 Run，
 * 不调用任何模型。验收模型配额紧张时，用这一个开关仍能拿到真实多代际记录、前代冻结与依据正文可读的
 * 证据，缺口按「本轮未运行」如实记录，不拿 fixture 冒充。
 */
const PHASE_VAR = 'ORCA_COMPANION_PTY_PHASE';
const CUTOVER_ONLY_PHASE = 'cutover-only';

/** provider 凭据的装载位置；与其它真实验收共用同一个 env 文件。 */
/** 计划要求的 Coordinator 模型；连接与凭据由隔离项目配置提供。 */
const REQUIRED_COORDINATOR_MODEL = process.env[MODEL_VAR];
/** 只读 Worker 能力缺口的稳定 token：探针与 blocker 原因共用它（`codex-read-only-probe.ts`）。 */
const READ_ONLY_WORKER_BLOCKER = 'read_only_worker_unavailable';

type Gate =
  | { readonly kind: 'run'; readonly workspace: string; readonly identity: string; readonly scopeId: string }
  | { readonly kind: 'skip'; readonly reason: string };

function evaluateGate(): Gate {
  const phase = process.env[PHASE_VAR];
  if (phase !== CUTOVER_ONLY_PHASE && phase !== 'execution') {
    return { kind: 'skip', reason: `${PHASE_VAR} 必须显式设为 cutover-only 或 execution` };
  }
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
  const scopeId = process.env[SCOPE_VAR];
  if (
    scopeId === undefined ||
    !/^ip05-[A-Za-z0-9_-]+-scope$/u.test(scopeId) ||
    scopeId === 'e2e-loop-scope'
  ) {
    return { kind: 'skip', reason: `${SCOPE_VAR} 必须是本次 fixture 专属的 ip05-* scope ID` };
  }
  // 模型必须由用户显式声明：错误的模型会让「真实 PTY 执行验收」跑在与计划不同的执行体上。
  if (REQUIRED_COORDINATOR_MODEL === undefined || REQUIRED_COORDINATOR_MODEL.trim().length === 0) {
    return { kind: 'skip', reason: `${MODEL_VAR} 必须显式声明本次验收模型` };
  }
  if (!existsSync(BUILT_ENTRY)) {
    return { kind: 'skip', reason: '先运行 pnpm build：用例启动的是 dist 里的前台入口' };
  }
  return { kind: 'run', workspace: resolve(workspace), identity, scopeId };
}

/** 测试只把专用 identityRef 显式交给 backend；不继承宿主 terminal、Worker、Task 或 Run selector。 */
function realChildEnvironment(): Record<string, string> {
  const env = toChildEnvironment(process.env);
  for (const key of Object.keys(env)) {
    if (/^ORCA_(?:TERMINAL|WORKER|TASK|RUN)(?:_|$)/u.test(key)) delete env[key];
  }
  return env;
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

/**
 * 界面上的 blocker 行（Sidebar 的 `blockers` 分区以 `! ` 开头）。
 *
 * 宿主的执行期 blocker 只存在于宿主自己的快照里，`status --json` 读不到；链路停住时这一行是唯一能
 * 说明「宿主到底卡在哪条门禁上」的可观察事实，因此每轮把它记进日志。
 *
 * 行的左边可能带终端边框（Sidebar 渲染成 `│! graph_patch`），所以先去掉行首的边框字符再判定；
 * 只认行首的 `! ` 会让这条日志长期打印 `none`，把最关键的信息遮住。
 */
function blockerLines(pane: string): string {
  return pane
    .split('\n')
    .map((line) => line.replace(/^[\s│┃|]+/u, '').trim())
    .filter((line) => line.startsWith('! '))
    .slice(0, 4)
    .join(' / ');
}

/** 状态行上的一次性提示（拒绝原因、unknown 提示）；没有提示时为 `null`。 */
function noticeOf(pane: string): string | null {
  return pane.split('\n').find(line=>line.startsWith('! '))?.slice(2) ?? null;
}

/**
 * 状态行的执行摘要（第二行）：`active 0[ · reconciling]…`。
 *
 * 同一行右侧是 Sidebar 的内容（两者在同一个终端行里拼接），因此这里只认行首的 `active 0|1` 词边界，
 * 不对行尾作任何假设。
 */
function executionSummaryLine(pane: string): string {
  const count=/执行图侧栏 · active ([01])\b/u.exec(pane)?.[1];
  return count===undefined?'':`active ${count}`;
}

/** 控制条 `scope control · <state>`；未渲染控制条时为 `null`。 */
function displayedControlStateOrNull(pane: string): string | null {
  return /(?:规划|执行) · ([a-z_]+)/u.exec(pane.split('\n')[0]??'')?.[1] ?? null;
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
/**
 * 在途 Worker 收尾的等待上限。
 *
 * 必须比一轮的 Worker 观察窗口（`WORKER_WINDOW_MS = 15 分钟`）更宽：真实 Codex 会话的时长由模型决定，
 * 没有固定上限，窗口太短会在**健康但慢**的会话上放弃整条链路（实测第 3 轮就停在一个刚起步的 Planner 上）。
 */
const IN_FLIGHT_WINDOW_MS = 30 * 60_000;
/** 顶栏与 Sidebar 都按终端宽度裁切；窄屏会让本文件的顶栏断言失去意义。 */
const PANE_WIDTH = '220';
/** 两个 Work Package 的 Sidebar（图、integration queue、reconcile 行与 finalizer）需要更高的 pane。 */
const PANE_HEIGHT = '80';

function startTui(workspace: string): void {
  const env: NodeJS.ProcessEnv = realChildEnvironment();
  const command = [process.execPath, BUILT_ENTRY].map(quoteArgument).join(' ');
  // 上一次失败的尝试可能留下同名会话；先清掉，否则 tmux 的 `duplicate session` 会掩盖真实原因。
  tmux(SOCKET, ['kill-session', '-t', SESSION]);
  const started = tmux(SOCKET, [
    'new-session', '-d', '-s', SESSION, '-x', PANE_WIDTH, '-y', PANE_HEIGHT,
    '-c', workspace, command,
  ], { env });
  expect(started.status, `tmux 无法启动前台 TUI：${(started.stderr ?? '').trim()}`).toBe(0);
  const workspaceFrame = pollPane(SOCKET, SESSION, (text) => text.includes('普通消息'), 60_000);
  expect(
    workspaceFrame.ok,
    `TUI 未在隔离项目中进入 workspace（${paneStatus(SOCKET, SESSION)}）：\n${workspaceFrame.text}`,
  ).toBe(true);
}

/** 搜索固定命令身份后确认；首次控制动作包含真实模型能力核验。 */
function runPaletteCommand(command: CommandId): void {
  expect(COMMAND_IDS).toContain(command);
  tmux(SOCKET, ['send-keys', '-t', SESSION, 'C-p']);
  const palette = pollPane(SOCKET, SESSION, (text) => text.includes('Command Palette'));
  expect(palette.ok, `Command Palette 未打开：\n${palette.text}`).toBe(true);
  tmux(SOCKET, ['send-keys', '-t', SESSION, '-l', command]);
  const matched = pollPane(SOCKET, SESSION, text => text.includes('搜索 › ' + command));
  expect(matched.ok, `命令搜索没有呈现目标：\n${matched.text}`).toBe(true);
  // 查询收窄后明确选中唯一结果，不依赖目录的展示顺序。
  tmux(SOCKET, ['send-keys', '-t', SESSION, 'Down']);
  sleepSync(100);
  tmux(SOCKET, ['send-keys', '-t', SESSION, 'Enter']);
  // 覆盖层关闭是 Enter 生效的可观察点；命令自身的异步结果由调用方继续等待。
  const closed = pollPane(SOCKET, SESSION, (text) => !text.includes('Command Palette'), 180_000);
  expect(closed.ok, `Command Palette 未关闭：\n${closed.text}`).toBe(true);
}

type IntentOutcome = {
  readonly pane: string;
  readonly status: StatusSnapshot;
  /** 界面是否给出了可核验结果：控制状态变化，或状态行上出现一次性提示。 */
  readonly observed: boolean;
};

/**
 * 经 composer 提交一条用户消息（= 用户真的敲进输入行再回车）。
 *
 * `send-keys -l` 逐字符写入，回车提交；消息本身不得包含换行——composer 的单行输入不接受换行。单行输入
 * 会按光标位置滚动，因此只能断言**尾部**出现在帧里（头部可能已被滚出可见区）。
 */
function submitComposerMessage(content: string): void {
  const tail = content.slice(-12);
  tmux(SOCKET, ['send-keys', '-t', SESSION, '-l', content]);
  const typed = pollPane(SOCKET, SESSION, (text) => text.includes(tail), 10_000);
  expect(typed.ok, `composer 未收到消息文本：\n${typed.text}`).toBe(true);
  tmux(SOCKET, ['send-keys', '-t', SESSION, 'Enter']);
  // 提交后草稿会离开输入行，但同一条消息也会作为用户发言出现在 transcript 里（宽行会被折行），因此
  // 「草稿消失」只等一小会儿、不作为断言：真正的可观察结果是模型是否因此调用了受控工具。
  pollPane(SOCKET, SESSION, (text) => !text.includes(tail), 3_000);
}

/**
 * 一次含糊的图变化声明：分类结论必须落到「派发 Graph Patch Planner」那一支。
 *
 * 九字段里不能出现结构性 `yes`（那会路由到无副作用的 `graph_patch`），也不能全是 `no`（那是 `no_change`）；
 * 依赖、Scope Envelope、objective 与基础设施都明确声明为「不成立」，只有「是否仅属 contract 内容」无法
 * 判定，于是声明不足以分类、只能交给 Graph Patch Planner 起草补丁。
 */
function graphChangeInstruction(workPackageId: string): string {
  const changeInstruction = process.env[RETIRE_NODE_SWITCH] === '1'
    ? '这份工作已不再需要：补丁只应把该 Work Package 从图中退场（retire），不要保留它。不要新增或改动其它文件、依赖与 Scope Envelope。'
    : '补丁只应调整该 Work Package 已有的 contract 内容（requirements、design 或验收条件），不要新增或改动其它文件、依赖与 Scope Envelope。';
  // 声明按**字面 JSON**给出：九字段的分类路由是确定性的，而「哪些字段留 unknown」决定这次请求会不会
  // 真的交给 Graph Patch Planner。用散文描述九个字段时模型可能自行改写（实测把 `unknown` 读成 `no`，
  // 于是全部声明事实都「已核验不成立」→ 路由成 `no_change`，一次补丁都不会起草）。
  //
  // 两个 `unknown` 是刻意留的：分类器只在「声明事实不足以判定」时才派 Planner，而
  // `infrastructureFailure` 与 `contractContentOnly` 同时为 `unknown`、结构性字段全为 `no` 时，
  // 既不会命中 `no_change`、`graph_patch`（结构性 yes）、`specification_revision`、`retry_attempt`，
  // 也不会命中 `blocked`（基础设施 yes 与语义 yes 不能同时成立），必然落到「派发 Planner」那一支。
  // 单行给出：composer 是单行输入，长行按光标位置横向滚动，多行消息会让「草稿是否已提交」无从判断。
  const request = JSON.stringify({
    workPackageId,
    changeInstruction,
    infrastructureFailure: 'unknown',
    changesDependencies: 'no',
    changesScopeEnvelope: 'no',
    changesObjective: 'no',
    contractContentOnly: 'unknown',
    goalOrGlobalConstraintChanged: 'no',
    userRequestedReplanning: 'no',
    requiresUserChoice: 'no',
  });
  return (
    `执行期间发现变化：Work Package ${workPackageId} 的验收条件需要更新。` +
    `请立即调用一次 request_graph_patch，request 参数按此 JSON 原样提交（不要改写取值、不要增删字段）：${request}` +
    // 补丁只会经由确定性 Admission 编译校验：把变化限定在该 Work Package 已有的 contract 内容上，
    // 不去新增或改动其它文件与 Scope Envelope（真实运行里 Planner 的初稿曾因此被判 `admission_rejected`）。
    //
    // 取舍说明（真实 Planner 自己决定补丁形态）：默认要求「保留该节点、只改 contract 内容」得到修订形态；
    // 设 `ORCA_COMPANION_PTY_RETIRE_NODE=1` 时明确要求退场，用来覆盖另一种形态。
    changeInstruction +
    /**
     * 这条消息必须以模型的**最终响应**收尾，而且只在这次调用**被受理**之后收尾。
     *
     * 工作项由「没有 tool call 的 assistant 响应」消费（`nodes.ts` 的模型节点、宿主的
     * `pendingWorkFor`），因此「除这一次工具调用外不要做其它事」这种指令会让这条消息永远留在待处理
     * 工作里：模型每次被唤醒都重读它、再调用一次工具，于是同一份声明被反复送达 Graph Patch Planner。
     * 实测（`orca-companion-e2e64`/`e2e65`）一次声明因此追加了两个 GraphVersion，把该 Work Package 的
     * 实现尝试额度耗尽，链路停在 `budget_exhausted`。
     *
     * 反过来，只要模型在**被拒绝**时也回一句话，工作项同样会被消费，链路就再也不会重提这次请求
     * （`orca-companion-e2e69`：两次调用分别拿到 `worker_in_flight` 与 `delivery_pending`，随后模型收尾，
     * 声明一条补丁都没落地）。工具会自己按有界等待与逐轮对账清理这些窗口，所以正确的要求是：
     * 被拒绝就再试（有界），被受理才收尾。
     */
    '如果这次调用被拒绝或结果未知（例如 worker_in_flight、delivery_pending、control_state），' +
    '等链路安静下来后再调用一次，最多再试两次；一旦被受理，就用一句话说明结果，不要重复提交同一份声明。'
  );
}

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
  const dedicatedScopeId = gate.scopeId;
  const pty = probePty();

  if (!pty.ok) {
    test.skip(`真实 PTY 执行阶段验收未运行：${pty.reason}`, () => {});
  } else {
    let launched = false;

    /**
     * ①–⑥ 都要真实模型调用；`cutover-only` 阶段把它们整体跳过，只留下零成本的 ⑦。
     * 跳过的用例在报告里显示为 skipped，不会被读成通过。
     */
    const cutoverOnly = process.env[PHASE_VAR] === CUTOVER_ONLY_PHASE;
    const modelPhase = cutoverOnly ? test.skip : test;
    const cutoverPhase = cutoverOnly ? test : test.skip;

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
        '普通消息',
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
        coordinationScopeId: dedicatedScopeId,
        objective: 'm2-deliver-execution-tui 真实 PTY 执行验收',
        // 双包计划：第一个包集成推进 canonical 之后，第二个包的 worktree 仍建立在授权 baseline 上，
        // 因此需要真实的 Baseline Reconciliation 才能继续（见 `advanceExecution` 的登记路径）。
        plan: REAL_LOOP_PLAN,
        env: realChildEnvironment(),
      });
      seededRunId = seeded.orcaRunId;
      seededBaselineHead = seeded.baselineHead;
    }, 300_000);

    /** 与前台宿主同一个后端：同一条身份约定、同一个 transport。 */
    const backend = createOrcaExecutionBackend({
      cwd: workspace,
      env: realChildEnvironment(),
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
        readonly workPackageId: string;
      }[];
      /** 已经有 Session Segment（可核验会话）的 Dispatch：中断必须落在真实会话上。 */
      readonly sessionBoundDispatchIds: readonly string[];
      readonly coordinationScopeId: string;
      readonly gitCommonDir: string;
      /** 当前 Graph Generation 与它在 Orca 侧的 consumer generation：中断操作的 authority 需要它们。 */
      readonly graphGeneration: number;
      readonly consumerGeneration: number;
      /** 当前图的全部已提交版本（含图修订）；`patchId` 为 `null` 表示初始编译版本。 */
      readonly graphVersions: readonly { readonly version: number; readonly patchId: string | null }[];
      /**
       * 修订持有：在途修订必须在闭环里被结算（`released`），且接纳版本落在被改过的那个节点上。
       * pending 的持有意味着 Scope 会永久停在 revision_pending，Finalizer 门禁再也不满足。
       */
      readonly revisionHolds: readonly {
        readonly workPackageId: string;
        readonly source: string;
        readonly sourceRef: string;
        readonly state: string;
        readonly priorContractRevision: number | null;
        readonly admittedContractRevision: number | null;
      }[];
      /** 共享预算计数：修订次数必须恰好等于实际发生的重新准入次数（重启不重置、不重复扣减）。 */
      readonly budgetCounters: readonly { readonly budgetKey: string; readonly consumed: number }[];
      /**
       * 有已收尾且被接受的 `git-integration` Operation 的 Work Package。
       *
       * 这是「集成已完成」的持久事实（宿主自己的判定规则与它一致）。界面投影目前仍按 Baseline Adoption
       * 记录判断集成状态——那是研究记录 §4b 的既有不一致，按本 change 的范围另行处理——因此验收读持久
       * 事实，而不是读那个尚未收敛的投影字段。
       */
      readonly integratedWorkPackageIds: readonly string[];
      /** 基线补救记录：图修订或 canonical 前移让 worktree base 落后时必须出现的那一条。 */
      readonly baselineReconciliations: readonly {
        readonly reconciliationId: string;
        readonly workPackageId: string;
        readonly state: string;
        readonly requiredBaselineHead: string;
        readonly observedHead: string | null;
        readonly orcaTaskId: string | null;
        readonly dispatchId: string | null;
      }[];
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
        const scopeRead = opened.store.query({
          kind: 'scope',
          coordinationScopeId: coordinationScopeId as CoordinationScopeId,
        });
        const graphId = scopeRead.kind === 'scope' ? (scopeRead.scope?.graphId ?? null) : null;
        const versions = graphId === null
          ? null
          : opened.store.query({
              kind: 'graph-versions',
              coordinationScopeId: coordinationScopeId as CoordinationScopeId,
              graphId,
            });
        const reconciliations = opened.store.query({
          kind: 'baseline-reconciliations',
          coordinationScopeId: coordinationScopeId as CoordinationScopeId,
        });
        const revisionHolds = opened.store.query({
          kind: 'revision-holds',
          coordinationScopeId: coordinationScopeId as CoordinationScopeId,
        });
        const budgetCounters = opened.store.query({
          kind: 'budget-counters',
          coordinationScopeId: coordinationScopeId as CoordinationScopeId,
        });
        const intents = opened.store.query({
          kind: 'intents',
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
          graphVersions:
            versions?.kind === 'graph-versions'
              ? versions.versions.map((entry) => ({ version: entry.version, patchId: entry.patchId }))
              : [],
          revisionHolds:
            revisionHolds.kind === 'revision-holds'
              ? revisionHolds.holds.map((hold) => ({
                  workPackageId: hold.workPackageId,
                  source: hold.source,
                  sourceRef: hold.sourceRef,
                  state: hold.state,
                  priorContractRevision: hold.priorContractRevision,
                  admittedContractRevision: hold.admittedContractRevision,
                }))
              : [],
          budgetCounters:
            budgetCounters.kind === 'budget-counters'
              ? budgetCounters.counters.map((counter) => ({
                  budgetKey: counter.budgetKey,
                  consumed: counter.consumed,
                }))
              : [],
          integratedWorkPackageIds:
            intents.kind === 'intents'
              ? [
                  ...new Set(
                    intents.intents
                      .filter(
                        (intent) =>
                          intent.operationCategory === 'git-integration' &&
                          intent.target.kind === 'work-package' &&
                          intent.state === 'settled' &&
                          intent.outcomeClass === 'accepted',
                      )
                      .map((intent) => intent.target.id),
                  ),
                ]
              : [],
          baselineReconciliations:
            reconciliations.kind === 'baseline-reconciliations'
              ? reconciliations.reconciliations.map((entry) => ({
                  reconciliationId: entry.reconciliationId,
                  workPackageId: entry.workPackageId,
                  state: entry.state,
                  requiredBaselineHead: entry.requiredBaselineHead,
                  observedHead: entry.observedHead,
                  orcaTaskId: entry.orcaTaskId,
                  dispatchId: entry.dispatchId,
                }))
              : [],
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
                    ? [{
                        role: binding.role,
                        launchId: binding.launchId,
                        orcaTaskId: binding.orcaTaskId,
                        workPackageId: binding.workPackageId,
                      }]
                    : [],
                )
              : [],
        };
      } finally {
        opened.close();
      }
    }

    /**
     * 逐角色核对真实 Codex Session 记录里**实际用于请求的模型 id**。
     *
     * 角色的状态根名字是 `sha256(launchId)` 的前 20 位（`createCodexWorkerLaunch` 派生），因此可以从
     * 物化绑定把状态根映射回角色；Finalizer 没有物化绑定（它由宿主直接派发），但它在 canonical worktree
     * 里运行，用 rollout 的 `cwd` 认它。模型取自 rollout 的 `"model":"…"` 字段：每条请求/响应与会话元数据
     * 都带它，是这次派发真正使用的模型绑定，不是配置回显。此前依赖首行指令正文里的「powered by <模型>」
     * 这句话，而同一版本 Codex 有的会话不再生成它（实测 `orca-companion-e2e66` 的 11 份 rollout 全都没有），
     * 断言因此会读到「没有真实会话记录」这一假结论。
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
          const text = readFileSync(rollout, 'utf8');
          const first = text.split('\n').find((line) => line.length > 0);
          if (first === undefined) {
            continue;
          }
          const declared = [...text.matchAll(/"model":"([^"]+)"/gu)].map((match) => match[1] ?? '');
          if (declared.length === 0) {
            continue;
          }
          const parsed = JSON.parse(first) as { readonly payload?: { readonly cwd?: unknown } };
          const role =
            roleOfDigest.get(dirent.name) ??
            (parsed.payload?.cwd === workspace ? 'finalizer' : dirent.name);
          const list = models.get(role) ?? [];
          list.push(...declared);
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
     * 面板按列硬换行，断言 token 可能正好落在换行处；去掉空白与边框字符后，被换行拆开的连续事实重新
     * 接上，`includes` 因此不依赖某一帧恰好停在哪一列。
     */
    function compactPane(text: string): string {
      return text.replace(/[\s│┃|─╭╮╰╯]/gu, '');
    }

    /** 发送按键并等到界面变化（复用 pollPane）；超时无变化时返回最后一次文本，由调用方判定。 */
    function sendKeyAndSettle(key: string, previous: string, timeoutMs = 3_000): string {
      tmux(SOCKET, ['send-keys', '-t', SESSION, key]);
      return pollPane(SOCKET, SESSION, (text) => text !== previous, timeoutMs).text;
    }

    /**
     * 经真实入口读取项目面板「工作记录与依据」详情。
     *
     * V-03 把完整工作记录、Recovery 与 Finalizer 归到这里，默认 Sidebar 不再产出 recovery/finalizer
     * 分区，因此核验必须真的进入详情，而不是在普通工作区等旧分区。总览条目的顺序由原型分组决定，这里
     * 按选中标记定位「工作记录与依据」，不硬编码索引。面板只有 40 列，条目/字段会硬换行，两个节点加
     * Recovery 与 Finalizer 可能远超一屏及一个有界详情页。每按一次 Down 都轮询到界面变化（Ink 的一帧
     * 可能落后于 send-keys），连续两次没有变化才判定当前页到底；出现生产提示 `PgDn 读取后续字段` 时
     * 再翻页，直到最后一页。返回前把详情重开以复位滚动位置，避免下一次读取漏掉开头。调用方读完用
     * `closeProjectPanel` 逐层退回工作区。
     */
    function readProjectWorkDetail(): string {
      // Below 100 columns the project panel owns the main area, so transcript
      // text cannot be interleaved into a wrapped field or long identity.
      const before = capturePane(SOCKET, SESSION);
      tmux(SOCKET, ['resize-window', '-t', SESSION, '-x', '80', '-y', '80']);
      pollPane(SOCKET, SESSION, text => text !== before, 5_000);
      try {
        return readProjectWorkDetailPages();
      } finally {
        const narrow = capturePane(SOCKET, SESSION);
        tmux(SOCKET, ['resize-window', '-t', SESSION, '-x', '220', '-y', '80']);
        pollPane(SOCKET, SESSION, text => text !== narrow, 5_000);
      }
    }

    function readProjectWorkDetailPages(): string {
      const detailReady = (text: string): boolean =>
        text.includes('项目面板 · 总览 · 详情') && !text.includes('正在读取项目详情');
      if (!capturePane(SOCKET, SESSION).includes('项目面板')) {
        tmux(SOCKET, ['send-keys', '-t', SESSION, 'C-b']);
      }
      const list = pollPane(SOCKET, SESSION, (text) => text.includes('项目面板'), 10_000);
      expect(list.ok, `项目面板未打开：\n${list.text}`).toBe(true);
      let pane = list.text;
      if (list.text.includes('项目面板 · 总览 · 详情')) {
        pane = sendKeyAndSettle('Escape', list.text, 5_000);
      }
      let collected: string | null = null;
      for (let step = 0; step < 12 && collected === null; step += 1) {
        pane = sendKeyAndSettle('Down', pane);
        if (!/› [^\n]*工作记录/u.test(pane)) {
          continue;
        }
        tmux(SOCKET, ['send-keys', '-t', SESSION, 'Enter']);
        const opened = pollPane(SOCKET, SESSION, detailReady, 10_000);
        pane = opened.text;
        if (!opened.ok) {
          continue;
        }
        let allPages = '';
        let pageCount = 0;
        while (pageCount < 200) {
          pageCount += 1;
          allPages += `${pane}\n`;
          // 每页独立滚到底：连续两次无变化说明 scroll 已被夹住，避免只读到当前视窗。
          let unchanged = 0;
          for (let down = 0; down < 400; down += 1) {
            const next = sendKeyAndSettle('Down', pane, 1_000);
            if (next === pane) {
              unchanged += 1;
              if (unchanged >= 2) break;
              continue;
            }
            unchanged = 0;
            pane = next;
            allPages += `${pane}\n`;
          }
          if (!pane.includes('PgDn 读取后续字段')) {
            if (compactPane(allPages).includes('finalizer.verdict')) collected = allPages;
            break;
          }
          const previousPage = pane;
          tmux(SOCKET, ['send-keys', '-t', SESSION, 'NPage']);
          const nextPage = pollPane(SOCKET, SESSION,
            text => text !== previousPage && detailReady(text), 10_000);
          if (!nextPage.ok) break;
          pane = nextPage.text;
        }
        if (collected === null) pane = sendKeyAndSettle('Escape', pane, 5_000);
      }
      expect(
        collected,
        `未能经真实入口读取包含 finalizer.verdict 的完整分页详情：\n${capturePane(SOCKET, SESSION)}`,
      ).not.toBeNull();
      // 返回前滚回顶部：Esc 回列表、再 Enter 重开（打开详情时 scroll=0），避免下一次读取从底部开始。
      pane = sendKeyAndSettle('Escape', pane, 5_000);
      if (!pane.includes('项目面板 · 总览 · 详情')) {
        tmux(SOCKET, ['send-keys', '-t', SESSION, 'Enter']);
        const reopened = pollPane(SOCKET, SESSION, detailReady, 10_000);
        expect(reopened.ok, '工作详情重开后必须加载完成').toBe(true);
      }
      return collected ?? capturePane(SOCKET, SESSION);
    }

    /** Current node runtime facts belong to Inspector, not retained Task fields. */
    function readGraphReconciliation(workPackageId: string): string {
      tmux(SOCKET, ['send-keys', '-t', SESSION, 'C-g']);
      let pane = pollPane(SOCKET, SESSION, text => text.includes('Graph Inspector'), 10_000).text;
      for (let step = 0; step < 8; step++) pane = sendKeyAndSettle('Up', pane, 250);
      pane = sendKeyAndSettle('Tab', pane);
      pane = sendKeyAndSettle('Tab', pane);
      for (let step = 0; step < 8 && !compactPane(pane).includes(`节点:${workPackageId}`); step++) {
        pane = sendKeyAndSettle('Down', pane);
      }
      expect(compactPane(pane), 'Inspector must select the exact current node').toContain(`节点:${workPackageId}`);
      pane = sendKeyAndSettle('Tab', pane);
      pane = sendKeyAndSettle('Enter', pane);
      let collected = pane;
      let unchanged = 0;
      for (let step = 0; step < 100; step++) {
        const next = sendKeyAndSettle('Down', pane, 250);
        if (next === pane) {
          if (++unchanged >= 2) break;
        } else {
          unchanged = 0;
          pane = next;
          collected += `\n${pane}`;
        }
      }
      pane = sendKeyAndSettle('Escape', pane);
      sendKeyAndSettle('Escape', pane);
      return compactPane(collected);
    }

    /** Esc 逐层返回：详情 → 列表 → 工作区（关闭项目面板）。 */
    function closeProjectPanel(): void {
      // 两次 Esc 必须各自等到界面真的回到上一层：Ink/终端可能把紧挨的两个 Esc 当成一次 Alt 序列吞掉，
      // 因此一次只发一个 Esc，等到界面变化再发下一个。
      for (let step = 0; step < 4; step += 1) {
        const current = capturePane(SOCKET, SESSION);
        if (!current.includes('项目面板')) {
          break;
        }
        sendKeyAndSettle('Escape', current, 5_000);
      }
      const gone = pollPane(SOCKET, SESSION, (text) => !text.includes('项目面板'), 10_000);
      expect(gone.ok, `项目面板未关闭：\n${gone.text}`).toBe(true);
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

    modelPhase(
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
        expect(pane).toContain('普通消息');
      },
      180_000,
    );

    modelPhase(
      '② 图摘要、授权详情与 active 计数按定稿分层（Scenario: 授权不重置工作区 / 并发上限为 1）',
      async () => {
        const pane = ensureTuiPane();
        const status = await readStatus(workspace);
        expect(displayedControlState(pane)).toBe(status.scope.controlState);
        if(status.graph!==undefined)expect(pane).toContain(`·v${status.graph.version}`);
        if(status.scope.mode==='execution_coordination')expect(executionSummaryLine(pane)).toBe(`active ${status.execution.activeWorkPackageCount}`);
        tmux(SOCKET,['send-keys','-t',SESSION,'C-b']);
        tmux(SOCKET,['send-keys','-t',SESSION,'Down']);
        tmux(SOCKET,['send-keys','-t',SESSION,'Enter']);
        const detail=pollPane(SOCKET,SESSION,text=>text.includes('approvedAuthorization:'));
        expect(detail.ok,detail.text).toBe(true);
        // 顶栏不得虚构授权：显示的 Authorization 必须与持久化的授权记录一致。
        const authorization = status.scope.authorization;
        expect(detail.text).toContain(
          authorization === null
            ? 'approvedAuthorization: 不可用'
            : authorization.id,
        );
        tmux(SOCKET,['send-keys','-t',SESSION,'Escape']);
        tmux(SOCKET,['send-keys','-t',SESSION,'Escape']);
        // Execution Coordination 的并发上限固定为 1；真实快照与界面都只可能给出 0 或 1。
        expect(status.execution.activeWorkPackageCount).toBeLessThanOrEqual(1);
      },
      90_000,
    );

    modelPhase(
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
      240_000,
    );

    modelPhase(
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
      240_000,
    );

    modelPhase(
      '⑤ 授权 → 串行 Frontier → 执行态 Recovery → Finalizer（Scenario: 授权切换 / 串行推进 / Recovery 可观察 / Finalizer 终态）',
      async () => {
        expect(seededRunId.length, '播种必须给出候选图的 Orca Run').toBeGreaterThan(0);
        const parsedConfig = parseProjectConfig(JSON.parse(readFileSync(join(workspace, 'orca-companion.json'), 'utf8')));
        if (!parsedConfig.ok) throw new Error('隔离项目模型配置无效：' + parsedConfig.field);
        const config = parsedConfig.value;
        const workerRoles: readonly ModelProfileRole[] = ['planner', 'implementation', 'validator', 'finalizer', 'recovery_utility'];
        for (const role of workerRoles) {
          expect(currentWorkerProfile(config, role)?.modelConfiguration.model, '角色模型必须显式绑定：' + role)
            .toBe(REQUIRED_COORDINATOR_MODEL);
        }

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
        expect(review.text, '通过准入才呈现批准动作').toContain('[批准授权]');
        tmux(SOCKET, ['send-keys', '-t', SESSION, 'Right']);
        tmux(SOCKET, ['send-keys', '-t', SESSION, 'Enter']);
        const authorized = await pollStatus(
          (status) => status.scope.mode === 'execution_coordination',
          120_000,
          '授权未进入 Execution Coordination',
        );
        expect(authorized.scope.authorization).not.toBeNull();
        expect(authorized.scope.executionLeaseHolder).not.toBeNull();
        // 持久化切换先完成，异步审阅结果再恢复原项目面板；等原弹层返回后才能逐层关闭。
        const reviewReturned = pollPane(SOCKET, SESSION, text =>
          !text.includes('Execution Authorization Review') &&
          displayedControlStateOrNull(text) === authorized.scope.controlState,
        30_000);
        expect(reviewReturned.ok, `授权审阅未返回：\n${reviewReturned.text}`).toBe(true);
        // 授权后总览仍可能打开；沿既有返回路径关闭项目面板，回到工作区读取执行图侧栏。
        closeProjectPanel();
        // 授权不重置工作区：顶栏出现授权，composer 仍在。
        const authorizedPane = pollPane(SOCKET, SESSION, (text) => text.includes('执行图侧栏') && displayedControlStateOrNull(text)===authorized.scope.controlState, 30_000);
        expect(authorizedPane.ok, `界面未显示授权后的执行状态：\n${authorizedPane.text}`).toBe(true);
        expect(authorizedPane.text, '授权不重置工作区').toContain('普通消息');

        // ---- 驱动：一次触发最多推进一个阶段，因此用 Pause→Resume 轮次推进真实 Frontier ----
        /**
         * 一轮是否有可观察变化。
         *
         * 除了每个 Work Package 的状态身份，还要包含 Graph Version 与 Baseline Reconciliation：图修订与
         * 基线核验都由独立的真实 Worker 推进，未必改变任何 Work Package 的生命周期字段。
         */
        const fingerprintOf = (status: StatusSnapshot): string =>
          [
            status.execution.workPackages
              .map((entry) => `${entry.workPackageId}:${entry.state}:${entry.role ?? '-'}:${entry.attemptId ?? '-'}`)
              .join('|'),
            `graph:${String(status.graph?.version ?? 0)}`,
            status.execution.reconciliations
              .map((entry) => `${entry.workPackageId}:${entry.severity}`)
              .join(','),
            // blocker 集合也进指纹：**新出现或消失**的 blocker 是可观察变化，常驻的 blocker 不是。
            // 反过来把「有 blocker」当成推进，会把任何静止状态读成进展，驱动也就永远等不到「无变化」。
            `blockers:${status.blockers
              .map((blocker) => `${blocker.source}:${blocker.code}`)
              .sort()
              .join(',')}`,
          ].join('#');
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
        // 真实链路现在还要容纳一次图修订（Planner 起草 + Admission + 受影响 Work Package 重跑）与
        // 基线补救，因此截止放宽；vitest 的单测超时同步放宽，只有链路真的卡死时才由它兜底。
        const deadline = Date.now() + (interruptRecovery ? 120 : 100) * 60_000;
        /** 一轮触发后等待可观察变化的窗口：有真实 Worker 在跑时要等它收尾，没有 Worker 时不必空等。 */
        const WORKER_WINDOW_MS = 15 * 60_000;
        const NO_WORKER_WINDOW_MS = 90_000;
        /** 容忍的连续无变化轮次：结果消息要等进度批次被确认后才成为当前批次，一轮可能只推进消息。 */
        const MAX_NO_CHANGE_ROUNDS = 6;
        /** 同一轮内允许的触发次数：一次触发被 CAS/门禁拒绝时立刻重试，不浪费整轮等待。 */
        const TRIGGER_ATTEMPTS = 4;
        /**
         * 重试的观察窗口。
         *
         * 一次触发的结论（`stale_revision`、门禁拒绝或真的派出 Worker）通常在十几秒内就能读到
         * （实测一次推进的装配约 9.7s：Runtime Lease 心跳每 10s 推进一次 Scope revision，CAS 窗口因此
         * 常常跨过心跳）；重试不需要为空等留满 90s。
         */
        const RETRY_WINDOW_MS = 30_000;
        let snapshot = authorized;
        let loopFacts = await readExecutionFacts();
        let rounds = 0;
        let interrupted: string | null = null;
        let noChangeRounds = 0;
        /**
         * 图变化声明的目标：当前**已物化且尚未被接受**的那个 Work Package。
         *
         * 不写死 key：Frontier 的候选顺序不保证与计划顺序一致，而修订必须先落在「还在跑」的节点上——
         * 已接受的节点不允许被补丁重定义，提交给它只会得到 `accepted_node_mutation`。它的 worktree 建立在
         * 授权 baseline 上，而 canonical 已被前一个 Work Package 的集成推进，因此这次修订必然取到
         * 「worktree base 落后于所需基线」。
         */
        const graphChangeTargetOf = (status: StatusSnapshot, current: ExecutionFacts): string | null => {
          const materialized = new Set(current.roleLaunches.map((entry) => entry.workPackageId));
          const candidate = status.execution.workPackages.find(
            (entry) =>
              materialized.has(entry.workPackageId) &&
              entry.state !== 'accepted' &&
              entry.state !== 'waiting_integration' &&
              entry.state !== 'retired',
          );
          return candidate?.workPackageId ?? null;
        };
        let graphChangeTarget: string | null = null;
        /**
         * 声明的提交次数。
         *
         * 声明本身是确定性的路由输入，但「读九字段再把它们原样交给工具」由模型完成：实测它会自行改写
         * 取值（把 `unknown` 读成 `no`），于是这次请求被路由成 `no_change` 而一次补丁都不起草。驱动的
         * 职责是提出请求，因此允许有界重试——**断言仍然要求真实 Graph Patch Planner 追加一个
         * GraphVersion**，重试不放宽结论，只保证请求真的被送达一次。
         */
        const GRAPH_CHANGE_ATTEMPTS = 3;
        /** 两次提交之间的间隔：给模型一轮时间把上一次请求交给工具，而不是阻塞驱动循环。 */
        const GRAPH_CHANGE_INTERVAL_MS = 4 * 60_000;
        /**
         * 提交后保持 Scope active 的时长。
         *
         * 驱动靠 Pause → Resume「单步」推进 Frontier，但 `request_graph_patch` 在 Scope 处于
         * `paused` 时以 `control_state` 拒绝（实测：模型忠实照抄了声明，两次都在提交后几秒内落进
         * 驱动制造的 paused 窗口里）。因此提交之后要先留出一段不制造 paused 的窗口，让这次工具调用
         * 真的进得来；工具内部还会为静止的 Run 等待，所以窗口要比一次模型调用宽。
         */
        const GRAPH_CHANGE_HOLD_MS = 3 * 60_000;
        /**
         * 补丁落地后只提交一次的收口说明。
         *
         * 模型会把「请提交 request_graph_patch」这条指令留在上下文里，补丁落地后仍可能自行重试：而一次
         * Graph Patch Planner 派发本身就占用并发上限 1（`graphPatchPlannerInFlight` 会挡住所有执行触发），
         * 于是 Frontier 会被这次无谓的重试饿住，修订节点永远等不到自己的窗口。真实用户在这一步也会被告知
         * 「已受理」，因此驱动补上同一句话，而不是让模型自己对着一份已生效的声明反复尝试。
         */
        let patchAcceptedNoticeSent = false;
        let graphChangeAttempts = 0;
        let graphChangeNextAttemptAt = 0;
        let graphChangeHoldUntil = 0;
        const canonicalHead = (): string =>
          spawnSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).stdout.trim();
        while (Date.now() < deadline && !terminalReached(snapshot, loopFacts)) {
          const inFlight = await inFlightWorkers();
          // ---- 图变化声明：canonical 已被受控集成推进，同时还有未被接受的 Work Package ----
          const candidateTarget = graphChangeTargetOf(snapshot, loopFacts);
          // ---- 图变化声明：canonical 已被受控集成推进，同时还有未被接受的 Work Package ----
          //
          // 提交后不阻塞驱动循环：请求由模型交给工具，工具自己会在需要时等待 Run 静止；循环本身每一轮
          // 都要等真实 Worker 收尾，用它的等待换取补丁出现即可。补丁一旦落到图上就停止重试。
          const patchApplied = loopFacts.graphVersions.some((entry) => entry.patchId !== null);
          if (patchApplied) {
            graphChangeAttempts = GRAPH_CHANGE_ATTEMPTS;
            graphChangeHoldUntil = 0;
            if (!patchAcceptedNoticeSent && graphChangeTarget !== null) {
              patchAcceptedNoticeSent = true;
              submitComposerMessage(
                `图变化已受理：补丁已提交为 GraphVersion ${String(snapshot.graph?.version ?? 0)}，` +
                  `Work Package ${graphChangeTarget} 已进入修订流程。不要再调用 request_graph_patch，` +
                  '也不要重复提交同一份声明；接下来只需用受控工具按既有事实继续推进。',
              );
              loopFacts = await readExecutionFacts();
              snapshot = await readStatus(workspace);
              continue;
            }
          } else if (
            canonicalHead() !== seededBaselineHead &&
            candidateTarget !== null &&
            // 在途 Worker 就是上一次请求自己派出的 Graph Patch Planner：它的产出还没落成
            // GraphVersion，此时再提交一次声明会让模型再调用一次工具、再追加一个图版本
            // （实测：第二个补丁把同一个节点的修订重新登记，验收断言「恰好一次规格修订」随即失效）。
            inFlight.length === 0 &&
            graphChangeAttempts < GRAPH_CHANGE_ATTEMPTS &&
            Date.now() >= graphChangeNextAttemptAt
          ) {
            graphChangeAttempts += 1;
            graphChangeNextAttemptAt = Date.now() + GRAPH_CHANGE_INTERVAL_MS;
            graphChangeHoldUntil = Date.now() + GRAPH_CHANGE_HOLD_MS;
            graphChangeTarget = graphChangeTarget ?? candidateTarget;
            submitComposerMessage(graphChangeInstruction(candidateTarget));
            console.warn(
              `[pty-execution] 图变化声明第 ${String(graphChangeAttempts)} 次提交 ${describeStatus(snapshot)}`,
            );
            loopFacts = await readExecutionFacts();
            snapshot = await readStatus(workspace);
            continue;
          }
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
            // Worker 收尾的同一时刻补丁可能刚好落地：下一轮判定「声明是否已被受理」必须按新事实，
            // 不能复用这一轮开始时读到的副本（实测旧副本让驱动在上一次请求刚成功时就又提交了一次）。
            loopFacts = await readExecutionFacts();
            snapshot = await readStatus(workspace);
            continue;
          }
          const beforeFingerprint = fingerprintOf(snapshot);
          let advanced = false;
          /**
           * 图修订请求在途时不制造 paused 窗口：只确保 Scope 回到 active，让模型的受控工具调用能被受理。
           *
           * 代价是这一轮不推进 Frontier；真实 Worker 仍在自己跑，窗口结束后照常继续推进。
           */
          if (Date.now() < graphChangeHoldUntil) {
            const held = await readStatus(workspace);
            if (held.scope.controlState === 'paused') {
              await submitControl('resume', 'paused');
            }
            loopFacts = await readExecutionFacts();
            snapshot = await readStatus(workspace);
            continue;
          }
          let sawInFlightWorker = (await inFlightWorkerCount()) > 0;
          /**
           * 一次触发可能什么都没推进：宿主可能正好把这次推进判成 `stale_revision`（Runtime Lease 心跳
           * 每 10s 推进一次 Scope revision，而重新读取事实也要花时间，两者同相时 CAS 必然冲突），也可能被
           * 门禁拒绝。界面上的用户会再按一次 Resume，因此这里同样有界地重试，而不是空等一整轮。
           */
          for (let attempt = 0; attempt < TRIGGER_ATTEMPTS && !advanced; attempt += 1) {
            await triggerRound();
            rounds += 1;
            sawInFlightWorker = sawInFlightWorker || (await inFlightWorkerCount()) > 0;
            const deadlineForThisAttempt =
              Date.now() +
              (sawInFlightWorker ? WORKER_WINDOW_MS : attempt === 0 ? NO_WORKER_WINDOW_MS : RETRY_WINDOW_MS);
            for (;;) {
              const live = await inFlightWorkerCount();
              const wasLive = sawInFlightWorker;
              sawInFlightWorker = sawInFlightWorker || live > 0;
              const current = await readStatus(workspace);
              if (
                fingerprintOf(current) !== beforeFingerprint ||
                current.execution.finalizer.verdict !== null ||
                // 刚结束的真实 Worker：交付要走下一次触发才结算，因此这里就返回。
                (wasLive && live === 0)
              ) {
                advanced = true;
                break;
              }
              if (Date.now() >= deadlineForThisAttempt) {
                break;
              }
              sleepSync(5_000);
            }
            if (!advanced && attempt + 1 < TRIGGER_ATTEMPTS) {
              console.warn(
                `[pty-execution] 第 ${String(attempt + 1)} 次触发没有推进，重试：` +
                  `in-flight=${String(await inFlightWorkerCount())}`,
              );
              await waitForQuiescence(QUIESCENCE_WINDOW_MS);
            }
          }
          snapshot = await readStatus(workspace);
          loopFacts = await readExecutionFacts();
          console.warn(
            `[pty-execution] round=${String(rounds)} advanced=${String(advanced)} ` +
              `pane-blockers=${blockerLines(capturePane(SOCKET, SESSION)) || 'none'} ${describeStatus(snapshot)}`,
          );
          // 并发上限固定为 1：投影里的 active 计数只可能是 0 或 1，且任一时刻最多一个真实 Worker 在跑。
          expect(snapshot.execution.activeWorkPackageCount, '并发上限为 1').toBeLessThanOrEqual(1);
          expect(await inFlightWorkerCount(), '并发上限为 1：最多一个真实 Worker 在跑').toBeLessThanOrEqual(1);
          // 「这一轮没有推进」只在**确实没有角色在跑**时才算无进展：并发上限为 1 时，一个真实 Worker
          // 在途期间宿主本来就没有可推进的对象（尤其中断模式还要跑 Capsule 与替代 Session），把这种等待
          // 计成无进展会让驱动在健康链路上提前收手。
          //
          // 判据是执行事实的指纹，而不是「这一轮有没有写库」：驱动自己的 Pause→Resume 每轮都会写 Scope，
          // 把它算成推进就再也等不到「无变化」，链路真卡死时只能耗到截止时间。
          noChangeRounds = advanced || sawInFlightWorker ? 0 : noChangeRounds + 1;
          if (noChangeRounds >= MAX_NO_CHANGE_ROUNDS) {
            // 停在这里时，宿主自己的 blocker 只出现在这一屏里（`status --json` 读不到），因此整屏落盘。
            console.warn(
              `[pty-execution] 连续 ${String(MAX_NO_CHANGE_ROUNDS)} 轮没有可观察变化，停止驱动：\n` +
                capturePane(SOCKET, SESSION),
            );
            break;
          }
        }
        expect(rounds, '闭环没有产生任何推进').toBeGreaterThan(0);
        const observed = await readStatus(workspace);
        const facts = await readExecutionFacts();
        console.warn(`[pty-execution] rounds=${String(rounds)} ${describeStatus(observed)}`);

        // ---- 界面先重读一次快照：让项目面板详情画出已持久化的 Recovery / Finalizer 事实 ----
        await waitForQuiescence(QUIESCENCE_WINDOW_MS);
        await submitControl('pause', (await readStatus(workspace)).scope.controlState);
        // V-03/V-04：完整工作记录（含 Recovery 与 Finalizer）归项目面板「工作记录与依据」详情，默认
        // Sidebar 不再产出这两个分区。经真实入口进入并只读浏览，断言完逐层退回工作区。
        const refreshedPane = readProjectWorkDetail();
        closeProjectPanel();
        const refreshed = {
          text: refreshedPane,
          compact: compactPane(refreshedPane),
          ok: compactPane(refreshedPane).includes('finalizer.verdict'),
        };
        expect(
          refreshed.ok,
          `「工作记录与依据」详情未读完分页或缺少 finalizer.verdict：\n${refreshed.text}`,
        ).toBe(true);

        // ---- 图修订与基线补救：含糊变化声明必须走完真实 Graph Patch Planner 与独立核验 ----
        //
        // 声明必须真的被提交过：两种模式都会在 canonical 前移、目标节点仍在跑时提交它。
        expect(graphChangeTarget, '本次验收必须真的提交过一次图变化声明').not.toBeNull();
        const target = graphChangeTarget ?? '';
        const patchedVersions = facts.graphVersions.filter((version) => version.patchId !== null).length;
        /**
         * 补丁落地是**不中断模式**的必达项（任务 5.2：图修订 + Baseline Reconciliation + Finalizer +
         * deliverable 的同链路证据）。
         *
         * 制造中断的那次验收覆盖的是执行态 Recovery 与界面事实（任务 5.3），它在这一段上不可靠：声明要在
         * canonical 前移之后、目标节点仍未被接受时才提得出来，而中断会把这条链路缩短，补丁请求又必须等到
         * Run 静止（`worker_in_flight` / `delivery_pending` 都是拒绝理由）。实测 `orca-companion-e2e69`
         * （Recovery 成功续办、`deliverable`）与 `e2e70`（Recovery 停在保守持有、无结论）都只提交了声明、
         * 没有落地补丁，两者都不是产品缺陷。
         */
        if (!interruptRecovery) {
          expect(
            patchedVersions,
            `本次验收必须经真实 Graph Patch Planner 追加一个 GraphVersion：${JSON.stringify(facts.graphVersions)}`,
          ).toBeGreaterThan(0);
          expect(observed.graph?.version ?? 1).toBeGreaterThan(1);
        }
        // 目标节点在补丁落地后是否还在图里，决定本次是「保留并修订」还是「退场」形态：两种形态都必须在
        // 同一次验收里被接受，因此形态相关的断言按它分支。
        const stillInGraph = observed.execution.workPackages.some((entry) => entry.workPackageId === target);
        if (stillInGraph) {
          const reconciliation = facts.baselineReconciliations.find((entry) => entry.workPackageId === target);
          expect(
            reconciliation,
            `图修订后必须为落后基线的 ${target} 登记独立补救：${JSON.stringify(facts.baselineReconciliations)}`,
          ).toBeDefined();
          expect(reconciliation?.orcaTaskId, '基线补救必须是独立 Planner Task').toEqual(expect.any(String));
          expect(reconciliation?.dispatchId, '基线补救必须绑定真实 Dispatch').toEqual(expect.any(String));
          expect(
            reconciliation?.state,
            `基线补救必须由真实 Worker 核验通过：${JSON.stringify(reconciliation)}`,
          ).toBe('verified');
          expect(
            observed.execution.reconciliations.find((entry) => entry.workPackageId === target)?.severity,
            'canonical 前进必须以 `canonical_advance` 呈现，而不是停留在待核验或冲突升级',
          ).toBe('canonical_advance');
        }
        if (stillInGraph && facts.baselineReconciliations.length > 0) {
          // Current runtime reconciliation is shown by Inspector. Retired nodes
          // have historical topology and retained sources, without live overlays.
          const reconciliation = readGraphReconciliation(target);
          expect(reconciliation, 'reconcile 行必须带严重性与所需基线').toMatch(
            /reconcile:canonical_advance·required/u,
          );
        }
        // ---- 在途 Graph Patch 修订必须真的被结算，而不是把 Scope 钉在 revision_pending ----
        //
        // 两种补丁形态共用这一段断言：保留并修订的节点走「重新准入 → 释放持有 + 记接纳版本 + 计一次
        // 修订额度」，退场节点走退休释放。两种形态都必须留下 released 的持有，且不能残留 pending。
        // 没有补丁落地的那次运行（见上）没有持有可结算，因此这里只要求「不允许残留 pending」。
        expect(
          facts.revisionHolds.filter((hold) => hold.state === 'pending').map((hold) => hold.workPackageId),
          `不允许残留 pending 的修订持有：${JSON.stringify(facts.revisionHolds)}`,
        ).toEqual([]);
        const hold = facts.revisionHolds.find((entry) => entry.workPackageId === target);
        if (patchedVersions > 0) {
          expect(hold, `受影响节点 ${target} 必须有修订持有记录：${JSON.stringify(facts.revisionHolds)}`).toBeDefined();
          expect(hold?.state, `修订持有必须已被结算：${JSON.stringify(hold)}`).toBe('released');
          if (stillInGraph) {
            // 修订形态：旧内容版本与新接纳版本都必须落盘；仅改图契约时两者可以相同。
            expect(hold?.priorContractRevision, '修订形态必须记下被替换的内容版本').not.toBeNull();
            expect(hold?.admittedContractRevision, '修订形态必须记下重新准入的内容版本').not.toBeNull();
            expect(
              facts.budgetCounters.find(
                (counter) => counter.budgetKey === `work-package:${target}:specificationRevisions`,
              )?.consumed ?? 0,
              `一次修订必须恰好消耗一次规格修订额度：${JSON.stringify(facts.budgetCounters)}`,
            ).toBe(1);
          }
        }

        // 每个**留在图里并已集成**的 Work Package 都必须真的把成果落进 canonical。被图修订 retire 的
        // 节点不在这个集合里：它按设计不再集成（补丁已经把它移出图），要求它提交只会把正确的行为判成失败。
        // 「已集成」按 `git-integration` 的持久 Operation 判定（与宿主的集成门禁同一规则）。
        //
        // 核对的是**成果文件**（夹具计划用 Scope Envelope 声明每个 Work Package 只能改哪些文件），
        // 不是提交主题：宿主只在工作区有未提交内容时才创建自己的集成 commit，`merge --ff-only` 直接采用
        // Worker 自己的提交同样符合 Git Integration Policy（实测 `orca-companion-e2e71`：readme-banner
        // 的三步集成全部 settled/accepted，canonical 上是 Worker 自己的提交主题），作者因此不是可断言的事实。
        const tree = spawnSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], {
          cwd: workspace,
          encoding: 'utf8',
        });
        expect(tree.status).toBe(0);
        const treeEntries = tree.stdout.split('\n');
        const integrated = observed.execution.workPackages.filter((entry) =>
          facts.integratedWorkPackageIds.includes(entry.workPackageId),
        );
        expect(integrated.length, `至少有一个 Work Package 集成完成：${describeStatus(observed)}`).toBeGreaterThan(0);
        for (const entry of integrated) {
          const planned = REAL_LOOP_PLAN.workPackages.find((workPackage) =>
            entry.workPackageId.endsWith(`:${workPackage.key}`),
          );
          expect(planned, `已集成节点 ${entry.workPackageId} 必须来自本次夹具计划`).toBeDefined();
          for (const path of planned?.scopeEnvelope.include ?? []) {
            expect(treeEntries, `${entry.workPackageId} 的成果必须落进 canonical：${path}`).toContain(path);
          }
        }
        // 没有 Work Package 可以停在阻塞：多包代际必须整体收口。
        expect(
          observed.execution.workPackages.filter((entry) => entry.state === 'blocked').length,
          `没有 Work Package 可以停在阻塞：${describeStatus(observed)}`,
        ).toBe(0);

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
          // Recovery 的完整字段只在「工作记录与依据」详情里呈现：身份、角色、预算、Capsule 与 Segment
          // 都要真的可读，详情分页必须完整消费。
          expect(
            refreshed.compact,
            `「工作记录与依据」详情未渲染真实 Recovery ID：\n${refreshed.text}`,
          ).toContain(`recoveries.0.recoveryId:${recovery?.recoveryId ?? ''}`);
          expect(refreshed.compact, 'Recovery 字段必须点名角色与状态')
            .toContain(`recoveries.0.role:${recovery?.role ?? ''}`);
          expect(refreshed.compact).toContain(`recoveries.0.status:${recovery?.status ?? ''}`);
          expect(refreshed.compact, 'recovery 行必须带预算').toContain('budget');
          if (!recovered) {
            // 只用这条 Recovery 自己的 blockingReason 核对：项目面板是逐行边框，全屏任意一行 `! ` 也可能是
            // 别的 blocker（其它分区，甚至 Node 的 blockerRef），不能拿它冒充 Recovery 的原因。
            const reason = recovery?.blockingReason ?? '';
            expect(reason, `未续办时必须给出可诊断的原因：${JSON.stringify(recovery)}`).not.toBe('');
            expect(
              refreshed.compact,
              `blocked Recovery 必须在界面上带真实原因：\n${refreshed.text}`,
            ).toContain(compactPane('! ' + reason));
          }
          if (recovered) {
            expect(recovery?.capsuleRef, '续办必须绑定真实 Capsule').toEqual(expect.any(String));
            expect(recovery?.replacementSegmentId, '续办必须绑定替代 Segment').toEqual(expect.any(String));
            // 身份取持久事实，界面核验状态、Capsule 与 Segment 行。
            expect(refreshed.compact).toContain(`recoveries.0.capsule.ref:${recovery?.capsuleRef ?? ''}`);
            expect(refreshed.compact).toContain(
              `recoveries.0.replacementSegmentId:${recovery?.replacementSegmentId ?? ''}`,
            );
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
          // 获批的 remote 与 ref 来自项目配置（夹具写的是 `<name>-integration` 这种专用分支，不是 main）：
          // 断言必须按 Manifest 里真正获批的目标校验，否则会去比一条从来没被推过的引用。
          const approvedRemote = config.execution?.git?.remotes?.[0] ?? 'origin';
          const approvedRef = config.execution?.git?.refs?.[0];
          expect(approvedRef, '项目配置必须给出获批的集成 ref').toEqual(expect.any(String));
          if (approvedRef === undefined) {
            return;
          }
          const remote = spawnSync('git', ['ls-remote', approvedRemote, approvedRef], {
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
            refreshed.compact,
            `没有独立结论时不得显示 deliverable：\n${refreshed.text}`,
          ).toContain('finalizer.verdict:不可用');
          expect(refreshed.compact).not.toContain('finalizer.verdict.kind:deliverable');
        } else {
          expect(
            verdict,
            `本机只读能力可用时必须取得独立交付结论：${describeStatus(observed)}`,
          ).not.toBeNull();
          expect(
            refreshed.compact,
            `Finalizer 结论必须在界面上如实呈现：\n${refreshed.text}`,
          ).toContain(`finalizer.verdict.kind:${verdict?.kind ?? ''}`);
          expect(refreshed.compact, `Finalizer 真实结论 ID 必须可读：\n${refreshed.text}`)
            .toContain(`finalizer.verdict.verdictId:${verdict?.verdictId ?? ''}`);
          expect(refreshed.compact).toContain(`finalizer.verdict.sessionBindingRef:${verdict?.sessionBindingRef ?? ''}`);
          if (!interruptRecovery) {
            // 不制造中断的那次验收以 deliverable 为必达项：只读角色能跑通就应该走完整条链路。
            expect(verdict?.kind, `不中断模式必须取得 deliverable：${describeStatus(observed)}`).toBe('deliverable');
            // 只读观察属于运行中的宿主；独立 status 查询只有持久事实，无法提供该观察。
            expect(refreshed.compact).toContain('finalizer.readOnlyProfile:enforced');
          }
        }
        // Finalizer 的只读 Profile 之外，运行前后工作区事实（HEAD/index/dirty）也必须真的呈现。
        if (observed.execution.finalizer.workspace !== null) {
          const { before, after } = observed.execution.finalizer.workspace;
          expect(refreshed.compact, `Finalizer 必须呈现运行前 HEAD：\n${refreshed.text}`)
            .toContain(`finalizer.workspace.before.head:${before.head}`);
          expect(refreshed.compact).toContain(`finalizer.workspace.after.head:${after.head}`);
          expect(refreshed.compact).toContain(`finalizer.workspace.before.indexRevision:${before.indexRevision}`);
          expect(refreshed.compact).toContain(`finalizer.workspace.after.indexRevision:${after.indexRevision}`);
          if (before.dirtyPaths.length > 0) expect(refreshed.compact).toContain('finalizer.workspace.before.dirtyPaths');
          if (after.dirtyPaths.length > 0) expect(refreshed.compact).toContain('finalizer.workspace.after.dirtyPaths');
        }

        // ---- 逐角色核对真实 Codex Session 的模型绑定 ----
        const models = roleSessionModels(facts);
        // 逐角色核对真实 Session 的模型；显示名可能包含 provider 前缀。
        for (const role of ['planner', 'implementation', ...models.keys()]) {
          const expectedWorkerModel = workerRoles.includes(role as ModelProfileRole)
            ? currentWorkerProfile(config, role as ModelProfileRole)?.modelConfiguration.model
            : currentWorkerProfile(config, 'planner')?.modelConfiguration.model;
          const seen = models.get(role) ?? [];
          expect(
            seen.length,
            `没有读到 ${role} 的真实 Codex Session 记录：${[...models.keys()].join(',')}`,
          ).toBeGreaterThan(0);
          expect(
            seen.some(
              (model) =>
                typeof expectedWorkerModel === 'string' &&
                (model.includes(expectedWorkerModel) || expectedWorkerModel.includes(model)),
            ),
            `${role} 的 Session 记录模型不符：${seen.join(',')}（期望 ${String(expectedWorkerModel)}）`,
          ).toBe(true);
        }
      },
      // 与循环的截止一致（串行角色 + 集成 + Finalizer 都是真实会话）：
      // 进度由真实 Worker 决定，vitest 只在链路真的卡死时才兜底。
      9_000_000,
    );

    test.skip(
      '④ 退出重启后界面先显示 reconciling（Scenario: 重启先对账）：需要可控的在途操作',
      () => {
        // 不可达：真实闭环里每个阶段都会收尾（Worker 退出、Delivery 结算、集成完成），重启时不存在
        // 「活跃 Worker 或未决操作」，界面因此不会进入 reconciling。见文件头部「覆盖范围」。
        // 可达的替代断言在下面：「重启后界面恢复同一持久事实，且不产生新的派发或集成」。
      },
    );

    modelPhase(
      '④ 退出重启后界面恢复同一持久事实，且不产生新的派发或集成（Scenario: 退出后不继续推进）',
      async () => {
        ensureTuiPane();
        const before = await readStatus(workspace);
        const factsBefore = await readExecutionFacts();
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

        // 重启不重复结算：修订持有与预算计数必须与重启前完全一致（不重复释放、不重复扣额）。
        const factsAfter = await readExecutionFacts();
        expect(factsAfter.revisionHolds).toEqual(factsBefore.revisionHolds);
        expect(factsAfter.budgetCounters).toEqual(factsBefore.budgetCounters);

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

    modelPhase(
      '⑤b Finalizer 未返回结论时不显示 deliverable（Scenario: 单包验证通过不等于可交付 / blocker 结论明确呈现）',
      async () => {
        const pane = ensureTuiPane();
        const status = await readStatus(workspace);
        const verdict = status.execution.finalizer.verdict;
        // Finalizer 字段已移入项目面板「工作记录与依据」详情：经真实入口进入读取；宿主自己的 blocker 仍
        // 由 Sidebar 风险行给出，因此先在工作区帧上取 blocker 诊断，再进入详情核对结论呈现。
        const blockers = blockerLines(pane);
        const detailText = readProjectWorkDetail();
        closeProjectPanel();
        const detail = compactPane(detailText);
        expect(detail, `「工作记录与依据」详情未渲染 finalizer 字段：\n${detailText}`).toContain('finalizer.');
        if (verdict === null) {
          // 不变量：没有独立结论时只能呈现「不显示 deliverable」，而且必须同时有可诊断的原因——
          // 只读能力缺口只是一种原因；中断模式下的 Recovery 保守持有、Worker 会话不再产生结果同样是
          // 真实的环境阻塞（见 `docs/orca-compatibility.md`）。宿主自己的 blocker 只出现在这一屏里
          // （`status --json` 读不到），因此判据取 Sidebar 的 blocker 行。
          expect(detail).toContain('finalizer.verdict:不可用');
          expect(detail).not.toContain('finalizer.verdict.kind:deliverable');
          expect(blockers.length, `没有结论必须同时给出可诊断的 blocker：\n${pane}`).toBeGreaterThan(0);
          expect(blockers, `没有结论的 blocker 必须点名原因：\n${pane}`).toMatch(
            /work-package|recovery|worker|frontier|delivery|baseline|unsettled/iu,
          );
          return;
        }
        expect(detail).toContain(`finalizer.verdict.kind:${verdict.kind}`);
        expect(detail).toContain(`finalizer.verdict.verdictId:${verdict.verdictId}`);
      },
      60_000,
    );

    modelPhase(
      '⑥ Ctrl+C 退出前台进程：不写 Scope 控制状态，也不产生新的派发（Scenario: Exit 不等同 Cancel / 退出后不继续推进）',
      async () => {
        ensureTuiPane();
        const before = await readStatus(workspace);
        // 不可核验 Worker 属于危险态；确认后仍只退出前台，不修改 Scope。
        tmux(SOCKET, ['send-keys', '-t', SESSION, 'C-c']);
        const prompted = pollPane(SOCKET, SESSION, (text) =>
          text.includes('确认退出前台进程') || !text.includes('普通消息'), 5_000);
        if (prompted.text.includes('确认退出前台进程')) {
          tmux(SOCKET, ['send-keys', '-t', SESSION, 'y']);
        }
        const gone = pollPane(SOCKET, SESSION, (text) => !text.includes('普通消息'), 30_000);
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

    /**
     * ⑦ Replanning Cutover 与真实多代际记录。
     *
     * 这一段不派发任何 Worker，也不调用模型：它走的是生产应用用例（`beginReplanningTransition` →
     * `completeReplanningTransition` → `ensureGraphGenerationRecord` → `recordInitialGraph` →
     * `record-authorization` → `commitGenerationCutover`）加一次真实的新 Orca Run，因此可以在配额
     * 紧张时独立成立。断言落在持久事实上：前代被冻结、候选代际换新图/新 Run/新 WorkPackageId、Scope
     * 引用整体切换，以及**前代冻结之后它的原始计划正文与版本链仍可按精确身份有界读回**。
     *
     * 依据正文走 `graph-basis-range`：这正是 TUI 历史详情要用的读端口，用例在这里先证明它对真实多代际
     * 数据成立，界面层（IP-04）在同一份事实上验收。
     */
    cutoverPhase(
      '⑦ Replanning Cutover：前代冻结、候选落在真实新 Run，前代依据仍按精确身份可读（Scenario: Generation Cutover 之后前代只作历史）',
      async () => {
        // ⑥ 已退出前台进程；退出不释放 Runtime Lease（产品语义）。等它过期后由本用例以新 incarnation
        // 和更大的 fencing generation 接管——这正是「同一 Session 重启续办」的真实路径。
        sleepSync(DEFAULT_RUNTIME_LEASE_TTL_MS + 5_000);

        const env = toChildEnvironment(process.env);
        const commonDir = await resolveGitCommonDir({ repositoryPath: workspace, env });
        if (commonDir.kind !== 'resolved') {
          throw new Error(`无法解析 Git common dir：${commonDir.message}`);
        }
        const opened = await openRepositoryCoordinationStore({ repositoryPath: workspace, env });
        if (opened.kind !== 'opened') {
          throw new Error(`无法打开协调状态：${opened.message}`);
        }
        const store = opened.store;
        try {
          const scopeId = (() => {
            const scopes = store.query({ kind: 'scopes' });
            const found = scopes.kind === 'scopes' ? scopes.scopes[0]?.coordinationScopeId : undefined;
            if (found === undefined) throw new Error('隔离项目没有 Coordination Scope');
            return found;
          })();
          const before = readScope(store, scopeId);
          if (before.kind === 'rejected') {
            throw new Error(`无法读取 Scope：${before.code} ${before.message}`);
          }
          const predecessorGraphId = before.scope.graphId;
          if (predecessorGraphId === null) {
            throw new Error('Cutover 前 Scope 必须已经指向一张图');
          }
          const predecessorPlanningCycleId = before.scope.planningCycleId;
          if (predecessorPlanningCycleId === null) {
            throw new Error('Cutover 前 Scope 必须已经处于一个 Planning Cycle');
          }
          const leases = store.query({ kind: 'leases', coordinationScopeId: scopeId });
          if (leases.kind !== 'leases') {
            throw new Error('无法读取租约');
          }
          const sessionId = leases.leases[0]?.coordinatorSessionId;
          if (sessionId === undefined) {
            throw new Error('隔离项目没有已注册的 Coordinator Session');
          }
          const highestFencing = leases.leases.reduce(
            (highest, lease) => Math.max(highest, lease.fencingGeneration),
            0,
          );
          const incarnation = 'pty-cutover-incarnation' as RuntimeIncarnationId;
          const lease = acquireRuntimeLease(store, {
            coordinationScopeId: scopeId,
            coordinatorSessionId: sessionId,
            runtimeIncarnationId: incarnation,
            fencingGeneration: highestFencing + 1,
          });
          if (lease.kind !== 'acquired') {
            throw new Error(`无法接管 Runtime Lease：${lease.kind}`);
          }
          const writer: CoordinationWriter = {
            coordinatorSessionId: sessionId,
            runtimeIncarnationId: incarnation,
            fencingGeneration: lease.lease.fencingGeneration,
          };
          const revision = (): number => {
            const read = readScope(store, scopeId);
            if (read.kind === 'rejected') throw new Error(`无法读取 Scope：${read.message}`);
            return read.scope.revision;
          };

          // 前代代际身份：登记过的直接读，未登记的按当前事实登记一次（与 beginReplanningTransition 同一入口）。
          const generationRows = store.query({ kind: 'graph-generations', coordinationScopeId: scopeId });
          const registered =
            generationRows.kind === 'graph-generations'
              ? generationRows.generations.find((entry) => entry.graphId === predecessorGraphId)
              : undefined;
          const predecessorGeneration = (registered?.generation ?? 1) as GraphGeneration;
          const predecessorRunId = registered?.orcaRunId ?? seededRunId;
          const predecessorBaseline =
            registered?.baselineHead ??
            spawnSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).stdout.trim();

          // 1. 过渡：记录意图、挂起前代、结清、释放 Execution Coordination Lease 并切到新的 Planning Cycle。
          const begun = beginReplanningTransition({
            store,
            coordinationScopeId: scopeId,
            writer,
            facts: {
              userRequestedReplanning: true,
              goalOrGlobalConstraintChanged: false,
              graphRevisionsExhausted: false,
            },
            predecessor: {
              graphId: predecessorGraphId,
              generation: predecessorGeneration,
              planningCycleId: predecessorPlanningCycleId,
              orcaRunId: predecessorRunId,
              baselineHead: predecessorBaseline,
            },
          });
          expect(begun.kind, '重规划过渡未能开始').toBe('started');

          const candidatePlanningCycleId = `${scopeId}:cycle-2` as PlanningCycleId;
          const completed = completeReplanningTransition({
            store,
            coordinationScopeId: scopeId,
            writer,
            closure: 'drain',
            settlement: {
              inFlightWorkers: 0,
              pendingDeliveries: 0,
              openInteractions: 0,
              unresolvedIntents: 0,
            },
            newPlanningCycleId: candidatePlanningCycleId,
          });
          expect(completed.kind, `过渡收尾未释放 Lease：${JSON.stringify(completed)}`).toBe('released');

          // 2. 候选代际走生产编译路径：它自己分配空 Run（真实 Orca 副作用）、翻计划、追加初始 GraphVersion
          // 并把归一化后的原计划与 v1 同事务落盘。这里不自己拼图，也不自己造 Run 身份。
          const candidateBaseline = spawnSync('git', ['rev-parse', 'HEAD'], {
            cwd: workspace,
            encoding: 'utf8',
          }).stdout.trim();
          const proposed = await proposeExecutionGraph({
            store,
            backend,
            coordinationScopeId: scopeId,
            writer,
            backendIdentityRef: dedicatedIdentity,
            timeoutMs: 120_000,
            // 过渡已经把 Scope 切回 route_planning，候选图与它的空 Run 都是规划侧动作。
            authority: { kind: 'route_planning' },
            plan: {
              planRevision: 1,
              destinationRef: { kind: 'destination', id: 'destination-graph-basis', version: 1 },
              workPackages: [
                {
                  key: 'graph-basis-candidate',
                  title: '图依据验收候选包',
                  dependsOn: [],
                  scopeEnvelope: { include: ['NOTES.md'], exclude: [] },
                },
              ],
            },
            limits: DEFAULT_EXECUTION_LIMITS,
            baselineHead: candidateBaseline,
            objective: `graph basis acceptance cutover (${dedicatedIdentity})`,
          });
          if (proposed.kind !== 'recorded') {
            throw new Error(`候选图未编译落盘：${proposed.kind} ${JSON.stringify(proposed)}`);
          }
          const candidateGraphId = proposed.candidate.graphId as GraphId;
          const candidateGeneration = proposed.candidate.generation as GraphGeneration;
          const candidateRunId = proposed.candidate.orcaRunId;
          expect(candidateRunId.length, '新 Run 没有可读回的 runId').toBeGreaterThan(0);
          expect(candidateRunId, '候选代际必须落在与前代不同的真实 Run 上').not.toBe(predecessorRunId);
          expect(candidateGraphId).not.toBe(predecessorGraphId);

          // 3. 候选代际的完整授权。
          const candidateAuthorizationId = `${dedicatedIdentity}:auth-cutover-2`;
          const candidateAuthorization = store.transact({
            kind: 'record-authorization',
            coordinationScopeId: scopeId,
            expectedRevision: revision(),
            writer,
            authorizationId: candidateAuthorizationId,
            authorizationVersion: 1,
            manifestVersion: 3,
            fingerprint: `fingerprint-graph-basis-cutover-${candidateRunId}`,
            approvalRef: `${dedicatedIdentity}:approval-cutover-2`,
            manifest: executionManifest({
              graphId: candidateGraphId,
              generation: candidateGeneration,
              orcaRunId: candidateRunId,
              baselineHead: candidateBaseline,
              coordinationScopeId: scopeId,
              planningCycleId: candidatePlanningCycleId,
            }),
          });
          if (candidateAuthorization.kind === 'rejected') {
            throw new Error(`无法记录候选授权：${candidateAuthorization.message}`);
          }

          // 4. Cutover：一次写入冻结前代、激活候选并切换全部引用。
          const cutover = commitGenerationCutover({
            store,
            coordinationScopeId: scopeId,
            writer,
            refs: {
              predecessorGraphId,
              candidateGraphId,
              candidateGeneration,
              candidateGraphVersion: proposed.candidate.version as GraphVersion,
              candidateRunId,
              planningCycleId: candidatePlanningCycleId,
              authorizationId: candidateAuthorizationId,
              authorizationVersion: 1,
              baselineHead: candidateBaseline,
              expectedRevision: revision(),
            },
          });
          expect(cutover.kind, `Cutover 未提交：${JSON.stringify(cutover)}`).toBe('cutover');

          // 5. 持久事实：两条代际记录各有真实状态，Scope 引用整体切到候选。
          const after = readScope(store, scopeId);
          if (after.kind === 'rejected') throw new Error(`无法读取切换后的 Scope：${after.message}`);
          expect(after.scope.graphId).toBe(candidateGraphId);
          expect(after.scope.planningCycleId).toBe(candidatePlanningCycleId);
          expect(after.scope.mode).toBe('execution_coordination');
          expect(after.scope.authorizationId).toBe(candidateAuthorizationId);

          const generations = store.query({ kind: 'graph-generations', coordinationScopeId: scopeId });
          if (generations.kind !== 'graph-generations') {
            throw new Error('无法读取代际记录');
          }
          const byGraph = new Map(generations.generations.map((entry) => [entry.graphId, entry]));
          expect(byGraph.get(predecessorGraphId)?.status, '前代在 Cutover 之后必须是 frozen').toBe('frozen');
          expect(byGraph.get(candidateGraphId)?.status).toBe('active');
          expect(byGraph.get(candidateGraphId)?.orcaRunId).toBe(candidateRunId);
          expect(generations.generations.length, '真实多代际记录必须同时保留前后两代').toBeGreaterThanOrEqual(2);

          // 6. 前代冻结之后仍然可读：版本链按精确身份分页，依据正文按 UTF-8 范围有界读回。
          // 目录是**跨代际**的（每页最多 20 项、只读元数据）：冻结代际必须仍然出现在里面。
          const index = store.query({ kind: 'graph-version-index', coordinationScopeId: scopeId });
          if (index.kind !== 'graph-version-index') {
            throw new Error(`无法读取图版本目录：${index.kind}`);
          }
          expect(index.items.length, '版本目录每页最多 20 项').toBeLessThanOrEqual(20);
          const predecessorItems = index.items.filter((item) => item.graphId === predecessorGraphId);
          expect(predecessorItems.length, '前代至少要留下初始编译版本').toBeGreaterThan(0);
          expect(
            predecessorItems.some((item) => item.patchId === null),
            '前代目录里必须有初始编译版本（patchId 为 null）',
          ).toBe(true);
          expect(
            index.items.some((item) => item.graphId === candidateGraphId),
            '目录必须同时列出冻结的前代与当前候选代际',
          ).toBe(true);
          // 代际标签取真实状态，不用同代际旧版本冒充冻结。
          expect(
            predecessorItems.every((item) => item.generationStatus === 'frozen'),
            `前代每一项都必须标成 frozen：${JSON.stringify(predecessorItems)}`,
          ).toBe(true);

          const plan = store.query({
            kind: 'graph-basis-range',
            coordinationScopeId: scopeId,
            source: {
              kind: 'initial_plan',
              graphId: predecessorGraphId,
              generation: predecessorGeneration,
              version: 1 as GraphVersion,
            },
            offset: 0,
            maxBytes: 64 * 1024,
          });
          if (plan.kind !== 'graph-basis-range') {
            throw new Error(`无法读取前代原计划正文：${plan.kind}`);
          }
          expect(
            plan.found,
            '前代的原始计划正文必须可读：新写入的图 v1 与原计划同事务保存，读不到说明 schema 17 写入路径没接上',
          ).toBe(true);
          expect(plan.text ?? '').toContain('README');
          expect(plan.text ?? '').toContain('NOTES');
          expect(plan.byteLength).toBeGreaterThan(0);

          // 7. 执行现场身份（不含任何 secret），供本批证据目录记录。
          const worktrees = await backend.query({ operation: 'worktree-list', repo: `path:${workspace}` });
          process.stdout.write(
            `${JSON.stringify({
              phase: 'cutover',
              identity: dedicatedIdentity,
              scopeId,
              sessionId,
              predecessor: { graphId: predecessorGraphId, generation: predecessorGeneration, orcaRunId: predecessorRunId },
              candidate: { graphId: candidateGraphId, orcaRunId: candidateRunId },
              directoryItems: index.items.length,
              predecessorVersionCount: predecessorItems.length,
              planBytes: plan.byteLength,
              worktreeListReadable: worktrees.kind === 'accepted',
            })}\n`,
          );
        } finally {
          opened.close();
        }
      },
      900_000,
    );
  }
}
