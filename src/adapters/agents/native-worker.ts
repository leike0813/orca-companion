/**
 * 原生交互式 Worker Harness（claude / pi / omp）共用的 prepared-terminal 启动与 Session 证明。
 *
 * 模型身份只来自不可变 WorkerModelSelection，且只经 harness 公开的逐次参数表达；认证、provider
 * 配置与状态根由 harness 在真实 launch 环境中拥有：Companion 不再复制登录态、生成 provider 配置或
 * 隔离 HOME/XDG，也不再改写原生环境变量。Companion 只写自己的 launcher/reporter 工件，报告里只含
 * 非秘密身份与从真实子进程环境解析出的 native runtime roots。
 *
 * 身份边界：报告的 session id、transcript path、cwd 与实际 runtime roots 必须互相印证；证明要求
 * transcript 精确落在该 harness 的原生会话子树内（realpath containment），不按 mtime、cwd slug 或
 * 最近文件降级匹配；pi/omp 的 transcript 只按活动分支读取。
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';

import { z } from 'zod';

import type { PreparedTerminalStrategy } from '../../application/worker-launch.js';
import type { TranscriptCoverageEvidence } from '../../application/recovery/recovery-capsule.js';
import { workerModelSelectionSchema } from '../../domain/model-configuration.js';
import type { WorkerModelSelection } from '../../domain/model-configuration.js';
import {
  CODEX_MODEL_DESCRIPTOR_VERSION,
  codexModelLaunchCommand,
  writeCodexModelLaunch,
} from './codex-model-launcher.js';
import type { CodexModelLaunchDescriptor } from './codex-model-launcher.js';
import { WORKER_RUNTIME_SOURCE } from './worker-runtime.js';
import type {
  CodexTranscriptCoverageResult,
  CodexTranscriptProof,
  CodexTranscriptProofResult,
} from './codex-transcript.js';

/** 本模块承载的 harness 白名单（opencode 由独立 adapter 拥有）。 */
export const NATIVE_HARNESSES = ['claude', 'pi', 'omp'] as const;
export type NativeHarness = (typeof NATIVE_HARNESSES)[number];

export type NativeWorkerSandboxMode =
  | 'read-only'
  | 'workspace-write'
  | 'danger-full-access'
  | 'read-only-local-control';

export type PreparedNativeTerminal = {
  readonly title: string;
  readonly command: string;
  readonly stateRoot: string;
};

/** 与 Codex 同一形状的启动输入；resume 给出时必须能证明是原会话。 */
export type NativeWorkerLaunchInput = {
  readonly launchId: string;
  readonly modelSelection: Readonly<WorkerModelSelection>;
  readonly sandboxMode: NativeWorkerSandboxMode;
  /** Companion launcher/reporter 工件父目录；绝不当作 native 状态根。 */
  readonly stateRoot?: string;
  /** 宿主安装的 SessionStart reporter 绝对路径；extensions/hook 直接以它作为上报入口。 */
  readonly reporterPath?: string;
  /** 宿主指定的报告文件绝对路径；省略时由 reporterPath 派生同名 .jsonl。 */
  readonly reportPath?: string;
  /** 测试可指向 fake 可执行文件。 */
  readonly executable?: string;
  /**
   * 只读模式在写任何状态文件之前必须证明 bwrap 包装器可用；由宿主注入的可用性核验（与探针同源）。
   * 未注入时不额外阻塞，由宿主的装配路径负责；一旦注入且失败即 fail closed，不留现场。
   */
  readonly assertReadOnlyWrapperAvailable?: () => Promise<void>;
  /** 复用原会话：精确 session 身份、原精确 report 记录的真实 native root 与 transcript 位置。 */
  readonly resume?: {
    readonly sessionId: string;
    readonly stateRoot: string;
    readonly transcriptRef: string;
  };
};

const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 每个 harness 的默认可执行文件名；测试可覆盖。 */
const HARNESS_EXECUTABLES: Readonly<Record<NativeHarness, string>> = {
  claude: 'claude',
  pi: 'pi',
  omp: 'omp',
};

/** Worker 只按角色选择模型；选择本身必须合法，effort 不能没有可信能力来源。 */
export function assertLaunchableModelSelection(selection: Readonly<WorkerModelSelection>): void {
  if (!workerModelSelectionSchema.safeParse(selection).success) {
    throw new Error('native Worker 模型选择无效：需要合法的 model/effort/effortCapability/catalogSource');
  }
}

function shellQuote(value: string): string {
  return "'" + value.split("'").join("'\\''") + "'";
}

function assertInsideWorktree(worktreePath: string, candidate: string): void {
  const child = relative(resolve(worktreePath), resolve(candidate));
  if (child.length === 0 || child === '..' || child.startsWith('..' + sep) || isAbsolute(child)) {
    throw new Error('native Companion 工件根必须位于 Worker worktree 内：' + candidate);
  }
}

/** 会话子树：claude 落在原生 projects 目录下，pi/omp 落在 sessions 目录下。 */
function sessionSubtree(harness: NativeHarness, stateRoot: string): string {
  return join(stateRoot, harness === 'claude' ? 'projects' : 'sessions');
}

/** 把候选根收窄到该 harness 的会话子树：已是 projects/sessions 的根原样保留，绝不接受任意 home。 */
function sessionRootsFor(harness: NativeHarness, root: string): readonly string[] {
  const base = basename(root);
  if (base === 'sessions' || base === 'projects') {
    return [root];
  }
  return [sessionSubtree(harness, root)];
}

/** 确定性 UUID：同一 launch 的重放得到同一 session 身份，避免模型或调用方自选。 */
function deterministicUuid(seed: string): string {
  const hash = createHash('sha256').update(seed).digest('hex');
  return hash.slice(0, 8) + '-' + hash.slice(8, 12) + '-4' + hash.slice(13, 16) +
    '-a' + hash.slice(17, 20) + '-' + hash.slice(20, 32);
}

function reportPathFor(reporterPath: string): string {
  const name = basename(reporterPath).replace(/\.[^.]+$/u, '');
  return join(dirname(reporterPath), name + '.jsonl');
}

/**
 * 安装宿主控制的 SessionStart reporter。
 *
 * claude 用 shell hook（stdin JSON）；pi/omp 用进程内 extension（session_start 与 turn_end）。
 * reporter 在真实子进程环境里用 nativeWorkerRuntime 解析该 harness 的原生 roots 并只上报非秘密
 * 身份与路径；不写 native auth/config，也不改写任何环境变量。
 */
export function installNativeSessionStartReporter(
  harness: NativeHarness,
  paths: { readonly stateRoot: string; readonly reporterPath: string; readonly reportPath: string },
): void {
  mkdirSync(dirname(paths.reporterPath), { recursive: true });
  const report = JSON.stringify(paths.reportPath);
  const harnessLiteral = JSON.stringify(harness);
  const source = harness === 'claude'
    ? [
        "import { appendFileSync, existsSync } from 'node:fs';",
        "import { homedir } from 'node:os';",
        "import { dirname, isAbsolute, join, resolve } from 'node:path';",
        WORKER_RUNTIME_SOURCE.trimEnd(),
        "let input = '';",
        'for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 65536) throw new Error("hook input exceeds limit"); }',
        'const event = JSON.parse(input);',
        'const HARNESS = ' + harnessLiteral + ';',
        'let runtime = null;',
        'try { runtime = nativeWorkerRuntime(HARNESS); } catch { runtime = null; }',
        'const runtimeRoots = runtime === null ? [] : [...new Set([...runtime.writableRoots, join(runtime.stateRoot, "projects")])].filter((path) => { try { return existsSync(path); } catch { return false; } });',
        'appendFileSync(' + report + ', JSON.stringify({',
        '  harness: HARNESS,',
        '  sessionId: event.session_id ?? null,',
        '  transcriptPath: event.transcript_path ?? null,',
        '  stateRoot: runtime === null ? null : runtime.stateRoot,',
        '  runtimeRoots,',
        '  cwd: event.cwd ?? null,',
        '  observedAt: new Date().toISOString(),',
        '}) + "\\n", { mode: 0o600 });',
        'process.stdout.write("{}\\n");',
        '',
      ].join('\n')
    : [
        "import { appendFileSync, existsSync, writeFileSync } from 'node:fs';",
        "import { homedir } from 'node:os';",
        "import { dirname, isAbsolute, join, resolve } from 'node:path';",
        WORKER_RUNTIME_SOURCE.trimEnd(),
        'const REPORT = ' + report + ';',
        'const HARNESS = ' + harnessLiteral + ';',
        'function report(ctx) {',
        '  const manager = ctx && ctx.sessionManager ? ctx.sessionManager : null;',
        '  const read = (name) => { try { const value = manager ? manager[name]() : null; return typeof value === "string" && value.length > 0 ? value : null; } catch { return null; } };',
        '  let header = null;',
        '  try { header = manager ? manager.getHeader() : null; } catch { header = null; }',
        '  const sessionId = read("getSessionId");',
        '  const transcriptPath = read("getSessionFile");',
        '  const cwd = header && typeof header.cwd === "string" ? header.cwd : null;',
        '  const observedAt = new Date().toISOString();',
        '  const leafId = read("getLeafId");',
        '  let runtime = null;',
        '  try { runtime = nativeWorkerRuntime(HARNESS); } catch { runtime = null; }',
        '  const roots = runtime === null ? [] : [...runtime.writableRoots, join(runtime.stateRoot, "sessions")];',
        '  if (transcriptPath !== null) roots.push(dirname(transcriptPath));',
        '  const runtimeRoots = [...new Set(roots)].filter((path) => { try { return existsSync(path); } catch { return false; } });',
        '  appendFileSync(REPORT, JSON.stringify({',
        '    harness: HARNESS, sessionId, transcriptPath,',
        '    stateRoot: runtime === null ? null : runtime.stateRoot, runtimeRoots, cwd, observedAt, leafId,',
        '  }) + "\\n", { mode: 0o600 });',
        '  if (transcriptPath !== null) {',
        '    try { writeFileSync(transcriptPath + ".companion-leaf.json", JSON.stringify({ harness: HARNESS, sessionId, leafId, cwd, observedAt })); } catch {}',
        '  }',
        '}',
        'function reportWhenOnDisk(ctx, remaining) {',
        '  let onDisk = null;',
        '  try { const manager = ctx && ctx.sessionManager ? ctx.sessionManager : null; onDisk = manager ? manager.getSessionFile() : null; } catch { onDisk = null; }',
        '  if (typeof onDisk === "string" && onDisk.length > 0 && existsSync(onDisk)) { report(ctx); return; }',
        '  if (remaining <= 0) { return; }',
        '  setTimeout(() => { reportWhenOnDisk(ctx, remaining - 1); }, 250);',
        '}',
        'export default (pi) => {',
        ...(harness === 'omp'
          ? [
              "  pi.on('session_start', (_event, ctx) => { if (ctx.hasUI) ctx.ui.setTitle('OMP ready'); });",
              "  pi.on('agent_start', (_event, ctx) => { if (ctx.hasUI) ctx.ui.setTitle('OMP working'); });",
              "  pi.on('agent_end', (_event, ctx) => { if (ctx.hasUI) ctx.ui.setTitle('OMP ready'); });",
            ]
          : []),
        "  pi.on('session_start', (_event, ctx) => { reportWhenOnDisk(ctx, 40); });",
        "  pi.on('turn_end', (_event, ctx) => { reportWhenOnDisk(ctx, 0); });",
        "  pi.on('agent_end', (_event, ctx) => { reportWhenOnDisk(ctx, 40); });",
        "  pi.on('session_tree', (_event, ctx) => { reportWhenOnDisk(ctx, 0); });",
        "  pi.on('session_shutdown', (_event, ctx) => { reportWhenOnDisk(ctx, 0); });",
        '};',
        '',
      ].join('\n');
  if (!existsSync(paths.reporterPath) || readFileSync(paths.reporterPath, 'utf8') !== source) {
    writeFileSync(paths.reporterPath, source, { mode: 0o600 });
  }
}

/**
 * claude 的 --settings overlay：只追加 SessionStart hook 与安全权限，保留原生 setting sources。
 * 不合成 provider endpoint 或模型别名，也不并入来源 settings。
 */
function writeClaudeSettings(stateRoot: string, reporterPath: string | undefined): void {
  const settings: Record<string, unknown> = {
    skipDangerousModePermissionPrompt: true,
    permissions: {
      allow: [
        'Bash(orca orchestration check *)',
        'Bash(orca orchestration send *)',
        'Bash(orca orchestration worker-done *)',
        'Bash(orca orchestration worker-ask *)',
        'Bash(orca orchestration worker-escalate *)',
      ],
    },
  };
  if (reporterPath !== undefined) {
    settings['hooks'] = {
      SessionStart: [{
        matcher: 'startup|resume',
        hooks: [{
          type: 'command',
          command: shellQuote(process.execPath) + ' ' + shellQuote(reporterPath),
          timeout: 10,
        }],
      }],
    };
  }
  writeFileSync(join(stateRoot, 'native-settings.json'), JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
}

type PreparedState = {
  readonly stateRoot: string;
  readonly reportPath: string;
};

/** 早期 fail closed 后，建立 Companion 工件根并写出 launcher/reporter 工件。 */
function prepareState(input: NativeWorkerLaunchInput, harness: NativeHarness, worktreePath: string): PreparedState {
  const digest = createHash('sha256').update(input.launchId).digest('hex').slice(0, 20);
  const stateRoot = input.stateRoot === undefined
    ? join(worktreePath, '.companion', harness, digest)
    : join(input.stateRoot, digest);
  if (input.stateRoot === undefined) {
    assertInsideWorktree(worktreePath, stateRoot);
  }
  mkdirSync(stateRoot, { recursive: true });
  // 只读包装器把 /tmp 设成只读并跳过 tmpfs，因此只读角色需要工件根内的可写临时目录。
  if (isReadOnlyMode(input.sandboxMode)) {
    mkdirSync(join(stateRoot, 'tmp'), { recursive: true });
  }
  const reportPath = input.reportPath
    ?? (input.reporterPath === undefined ? join(stateRoot, 'session-start.jsonl') : reportPathFor(input.reporterPath));
  if (input.reporterPath !== undefined) {
    installNativeSessionStartReporter(harness, { stateRoot, reporterPath: input.reporterPath, reportPath });
  }
  if (harness === 'claude') {
    writeClaudeSettings(stateRoot, input.reporterPath);
  }
  return { stateRoot, reportPath };
}

/** harness 自己的逐次 pin 参数。只含非秘密 selector；秘密与 provider 配置由 harness 拥有。 */
function nativeArguments(
  harness: NativeHarness,
  input: NativeWorkerLaunchInput,
  prepared: PreparedState,
): readonly string[] {
  const selection = input.modelSelection;
  const resume = input.resume;
  const effort = selection.effort === null ? [] : ['--thinking', selection.effort];
  if (harness === 'claude') {
    const permissionArgs = input.sandboxMode === 'danger-full-access'
      ? ['--dangerously-skip-permissions']
      : input.sandboxMode === 'read-only' || input.sandboxMode === 'read-only-local-control'
        // 只读边界由 bwrap 保证；交互式 Worker 不能因审批提示挂起。
        ? ['--permission-mode', 'bypassPermissions']
        : ['--permission-mode', 'acceptEdits'];
    return [
      '--settings', join(prepared.stateRoot, 'native-settings.json'),
      // native selector（alias 或 exact ID）原样传入；不合成模型别名或 provider endpoint。
      '--model', selection.model,
      // claude 原生 effort 档位必须原样下发；批准后不得静默丢弃。
      ...(selection.effort === null ? [] : ['--effort', selection.effort]),
      ...permissionArgs,
      // 新建会话固定确定性 UUID，resume 用原 UUID；两条路径都不经 picker/--continue。
      ...(resume === undefined
        ? ['--session-id', deterministicUuid(input.launchId)]
        : ['--resume', resume.sessionId]),
    ];
  }
  const reporter = input.reporterPath === undefined ? [] : ['--extension', input.reporterPath];
  if (harness === 'pi') {
    return [
      ...reporter,
      ...(resume === undefined
        ? ['--session-id', deterministicUuid(input.launchId)]
        : ['--session', resume.transcriptRef]),
      '--model', selection.model,
      ...effort,
    ];
  }
  return [
    ...reporter,
    ...(resume === undefined ? [] : ['-r', resume.transcriptRef]),
    '--model', selection.model,
    ...effort,
    '--auto-approve',
  ];
}

function isReadOnlyMode(mode: NativeWorkerSandboxMode): boolean {
  return mode === 'read-only' || mode === 'read-only-local-control';
}

/** native harness 的共用 prepared-terminal 工厂；wrapper 只绑定 harness 名。 */
export function createNativeWorkerLaunch(
  harness: NativeHarness,
  input: NativeWorkerLaunchInput,
): PreparedTerminalStrategy<PreparedNativeTerminal> {
  if (input.launchId.length === 0) {
    throw new Error('native launchId 必须是非空字符串');
  }
  const digest = createHash('sha256').update(input.launchId).digest('hex').slice(0, 20);
  const title = 'orca-companion:' + harness + (input.resume === undefined ? '' : '-resume') + ':' + digest;
  return {
    kind: 'prepared_terminal',
    harness,
    activation: 'submit_draft',
    title,
    prepare: async ({ worktreePath }) => {
      if (!isAbsolute(worktreePath)) {
        throw new Error('native Worker worktree 必须是绝对路径：' + worktreePath);
      }
      if (input.stateRoot !== undefined && !isAbsolute(input.stateRoot)) {
        throw new Error('native 工件根必须是绝对路径：' + input.stateRoot);
      }
      // 早期 fail closed 发生在任何写盘之前：非法选择、原会话不可证明都不留现场。
      assertLaunchableModelSelection(input.modelSelection);
      if (input.resume !== undefined) {
        if (!isAbsolute(input.resume.stateRoot)) {
          throw new Error('native resume 的原 native 状态根必须是绝对路径：' + input.resume.stateRoot);
        }
        if (!SAFE_SESSION_ID.test(input.resume.sessionId)) {
          throw new Error('native resume session ID 形态非法，拒绝启动');
        }
        // 原精确 transcript 必须仍自称原 session 身份；真实 runtime roots 的完整 containment 证明
        // 在启动后由 proveSession 用新报告的 runtimeRoots 完成，不在这里用原 stateRoot 伪造 roots。
        const identity = nativeTranscriptIdentity(harness, {
          transcriptRef: input.resume.transcriptRef,
          workspace: worktreePath,
        });
        if (!('providerSessionId' in identity) || identity.providerSessionId !== input.resume.sessionId
          || !basename(realpathSync(input.resume.transcriptRef)).endsWith(input.resume.sessionId + '.jsonl')) {
          throw new Error('native resume 原 Session 身份不可证明');
        }
      }
      // 只读角色必须先证明 bwrap 包装器可用，再写工件；边界无法证明时不留下可启动现场。
      if (isReadOnlyMode(input.sandboxMode)) {
        await input.assertReadOnlyWrapperAvailable?.();
      }
      const prepared = prepareState(input, harness, worktreePath);
      const reportDirectory = dirname(prepared.reportPath);
      const readOnly = isReadOnlyMode(input.sandboxMode)
        ? {
            workspace: worktreePath,
            stateRoot: prepared.stateRoot,
            ...(reportDirectory === prepared.stateRoot ? {} : { reportDirectory }),
          }
        : undefined;
      const descriptor: CodexModelLaunchDescriptor = {
        version: CODEX_MODEL_DESCRIPTOR_VERSION,
        executable: input.executable ?? HARNESS_EXECUTABLES[harness],
        args: nativeArguments(harness, input, prepared),
        harness,
        ...(input.resume === undefined ? {} : { expectedStateRoot: input.resume.stateRoot }),
        runtimeReportPath: join(prepared.stateRoot, 'native-runtime.json'),
        ...(readOnly === undefined ? {} : { readOnly }),
      };
      const { descriptorPath, launcherPath } = writeCodexModelLaunch({ stateRoot: prepared.stateRoot, descriptor });
      return {
        title,
        stateRoot: prepared.stateRoot,
        command: codexModelLaunchCommand({ launcherPath, descriptorPath }),
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Session 报告到精确 transcript 的证明
// ---------------------------------------------------------------------------------------------

/** 报告声明的 harness；opencode 由独立 adapter 拥有，但报告形状同一，跨 harness 报告必须被拒。 */
export const NATIVE_REPORT_HARNESSES = ['claude', 'pi', 'omp', 'opencode'] as const;

export const nativeSessionStartReportSchema = z.object({
  harness: z.enum(NATIVE_REPORT_HARNESSES),
  sessionId: z.string().nullable(),
  transcriptPath: z.string().nullable(),
  stateRoot: z.string().nullable(),
  runtimeRoots: z.array(z.string().min(1).max(4096)).max(16).default([]),
  cwd: z.string().nullable(),
  observedAt: z.string().nullable(),
  leafId: z.string().nullable().optional(),
});
export type NativeSessionStartReport = z.infer<typeof nativeSessionStartReportSchema>;

export type NativeTranscriptProof = CodexTranscriptProof;
export type NativeTranscriptProofResult = CodexTranscriptProofResult;
export type NativeTranscriptCoverageResult = CodexTranscriptCoverageResult;

const SESSION_HEADER_READ_LIMIT = 1024 * 1024;

function unavailable(reason: string): { readonly kind: 'transcript_unavailable'; readonly reason: string } {
  return { kind: 'transcript_unavailable', reason };
}

function instant(value: string | null): number | null {
  if (value === null || value.length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path.length > 0 && path !== '..' && !path.startsWith('..' + sep);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

type TranscriptHeader = { readonly id: string; readonly cwd: string };

/**
 * 在读上限内逐行找出第一条承载会话身份的记录。
 *
 * pi/omp 的身份就在首行 {type:'session', id, cwd}；claude 的真实 transcript 首行常常是
 * file-history 快照，既没有 sessionId 也没有 cwd，因此必须继续扫描，而不是断言第一行。
 * 扫描有界（最多 1 MiB 且一旦越过含身份的行即停止），不整文件读入。
 */
function transcriptHeader(harness: NativeHarness, path: string): TranscriptHeader | null {
  const descriptor = openSync(path, 'r');
  let text: string;
  try {
    const buffer = Buffer.alloc(SESSION_HEADER_READ_LIMIT);
    const length = readSync(descriptor, buffer, 0, buffer.length, 0);
    text = buffer.subarray(0, length).toString('utf8');
  } finally {
    closeSync(descriptor);
  }
  for (const line of text.split('\n')) {
    if (line.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) {
      continue;
    }
    if (harness !== 'claude') {
      if (parsed['type'] !== 'session') {
        continue;
      }
      return typeof parsed['id'] === 'string' && typeof parsed['cwd'] === 'string'
        ? { id: parsed['id'], cwd: parsed['cwd'] }
        : null;
    }
    if (typeof parsed['sessionId'] === 'string' && typeof parsed['cwd'] === 'string') {
      return { id: parsed['sessionId'], cwd: parsed['cwd'] };
    }
  }
  return null;
}

/** 只按形状校验报告；任一必填身份缺失都由调用方按不可证明处理。 */
export function parseNativeSessionStartReport(report: unknown): NativeSessionStartReport | null {
  const parsed = nativeSessionStartReportSchema.safeParse(report);
  return parsed.success ? parsed.data : null;
}

/**
 * 证明一次 native Session：报告字段、cwd、时间窗与精确 transcript metadata 必须一致，且 transcript
 * 必须落在报告的原生 runtime roots（或按 stateRoot 推导出的会话子树）内。
 * expectedStateRoot 核验原会话的实际 native root；身份由精确报告与 transcript 共同证明。
 */
export function proveNativeTranscript(
  harness: NativeHarness,
  input: {
    readonly report: unknown;
    readonly workspace: string;
    readonly expectedStateRoot: string;
    readonly dispatchStartedAt: string;
    readonly bindingDeadlineAt: string;
  },
): NativeTranscriptProofResult {
  const report = parseNativeSessionStartReport(input.report);
  if (report !== null && report.harness !== harness) {
    // 固定 adapter 不等于信任来源：报告必须自称同一 harness，否则不签发绑定。
    return unavailable('SessionStart 报告的 harness 与本次派发不一致：' + report.harness + ' != ' + harness);
  }
  if (
    report === null ||
    report.sessionId === null ||
    report.transcriptPath === null ||
    report.stateRoot === null ||
    report.cwd === null ||
    report.observedAt === null ||
    !SAFE_SESSION_ID.test(report.sessionId)
  ) {
    return unavailable('SessionStart 缺少可核验的 session ID、native 状态根、transcript path、cwd 或观察时间');
  }
  const observedAt = instant(report.observedAt);
  const startedAt = instant(input.dispatchStartedAt);
  const deadlineAt = instant(input.bindingDeadlineAt);
  if (
    observedAt === null || startedAt === null || deadlineAt === null ||
    deadlineAt < startedAt || observedAt < startedAt || observedAt > deadlineAt
  ) {
    return unavailable('SessionStart 报告不在当前 Dispatch 绑定时间窗内');
  }
  try {
    const transcriptPath = realpathSync(report.transcriptPath);
    const workspace = realpathSync(input.workspace);
    // 报告的 native 状态根必须与本次派发预期的原生根一致，不回落工件目录或任意 home。
    const expectedRoot = input.expectedStateRoot.length === 0 ? null : realpathSync(input.expectedStateRoot);
    if (expectedRoot === null || expectedRoot !== realpathSync(report.stateRoot)) {
      return unavailable('报告 native 状态根与本次派发预期的原生根不一致');
    }
    // runtimeRoots 是报告必须携带且可核验的原生事实；缺失或不可解析即不可证明。
    if (report.runtimeRoots.length === 0) {
      return unavailable('报告缺少原生 runtime roots，无法证明 transcript 归属');
    }
    const candidates: string[] = [];
    for (const root of report.runtimeRoots) {
      let resolved: string;
      try {
        resolved = realpathSync(root);
      } catch {
        return unavailable('报告 runtime root 不可核验：' + root);
      }
      candidates.push(...sessionRootsFor(harness, resolved));
    }
    candidates.push(...sessionRootsFor(harness, expectedRoot));
    if (!candidates.some((root) => isInside(root, transcriptPath))) {
      return unavailable('transcript path 不在报告的原生会话子树内');
    }
    if (!basename(transcriptPath).endsWith(report.sessionId + '.jsonl')) {
      return unavailable('transcript 文件名中的 session ID 与上报值不一致');
    }
    const header = transcriptHeader(harness, transcriptPath);
    if (header === null || header.id !== report.sessionId) {
      return unavailable('transcript 会话头中的 id 与上报 session ID 不一致');
    }
    if (realpathSync(header.cwd) !== workspace || realpathSync(report.cwd) !== workspace) {
      return unavailable('报告 cwd 或会话头 cwd 与绑定 workspace 不一致');
    }
    return {
      kind: 'proven',
      proof: { providerSessionId: report.sessionId, transcriptRef: transcriptPath, observedAt: report.observedAt },
    };
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : 'native transcript 证明失败');
  }
}

/** 重启后从精确 transcript 重新读回 provider session 身份，并核验仍属于同一 workspace。 */
export function nativeTranscriptIdentity(
  harness: NativeHarness,
  input: { readonly transcriptRef: string; readonly workspace: string },
): { readonly providerSessionId: string } | { readonly kind: 'transcript_unavailable'; readonly reason: string } {
  try {
    const path = realpathSync(input.transcriptRef);
    const header = transcriptHeader(harness, path);
    if (header === null) {
      return unavailable('transcript 首条记录不是可核验的会话头');
    }
    if (realpathSync(header.cwd) !== realpathSync(input.workspace)) {
      return unavailable('transcript 会话头的 cwd 与绑定 workspace 不一致');
    }
    return { providerSessionId: header.id };
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : 'native transcript 重新观察失败');
  }
}

function eventRef(id: unknown, line: number): string {
  return typeof id === 'string' && id.length > 0 ? id : 'line:' + line;
}

function partialEvidence(
  firstEventRef: string | null,
  lastCompleteEventRef: string | null,
  transcriptRef: string,
  gapRef: string,
  reason: string,
): NativeTranscriptCoverageResult {
  if (firstEventRef === null || lastCompleteEventRef === null) {
    return unavailable('transcript 在首个完整事件前解析失败');
  }
  const evidence: TranscriptCoverageEvidence = {
    coverage: 'partial',
    readableRange: { transcriptRef, fromEventRef: firstEventRef, toEventRef: lastCompleteEventRef },
    gaps: [{ fromEventRef: gapRef, toEventRef: null, reason }],
    lastCompleteEventRef,
  };
  return { kind: 'covered', evidence };
}

/**
 * 读取精确 sidecar 里的活动叶子。
 *
 * 只在同一 transcript 旁侧、且 sidecar 的 sessionId 与文件内会话头 id 完全一致时才承认；缺失、
 * 非法或 id 不符都返回 null（调用方随后 fail closed）。不按 mtime、不按文件顺序、不看其它文件。
 */
function readLeafSidecar(transcriptPath: string, headerId: string | null): string | null {
  if (headerId === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(transcriptPath + '.companion-leaf.json', 'utf8'));
    if (!isRecord(parsed) || parsed['sessionId'] !== headerId) {
      return null;
    }
    return typeof parsed['leafId'] === 'string' && parsed['leafId'].length > 0 ? parsed['leafId'] : null;
  } catch {
    return null;
  }
}

/**
 * 只记录事件边界与解析失败，不复制 transcript 正文。
 *
 * pi/omp 的会话是树：同文件里可能有多个分支，只有从叶子沿 parentId 回溯得到的活动分支才属于本次
 * 会话。活动叶子优先取显式 leafId，其次取 transcript 旁侧的精确 sidecar（extension 在每次上报时
 * 写出，仅 metadata）；两者都没有就不可用——文件最后一行可能是历史分支（/tree 切换分支不会追加
 * 行），按它读会静默读错历史。父链缺父或成环同样不可用。claude 是线性文件，逐行即全部。
 *
 * ponytail: 两趟思路（先索引 parentId 再去重排序），单文件内足够；会话文件若增长到 GB 级需要流式
 * 逆序扫描，目前不需要。
 */
export async function inspectNativeTranscript(
  harness: NativeHarness,
  transcriptRef: string,
  leafId?: string | null,
): Promise<NativeTranscriptCoverageResult> {
  let line = 0;
  let firstEventRef: string | null = null;
  let lastCompleteEventRef: string | null = null;
  let failedLine: number | null = null;
  let headerId: string | null = null;
  const parents = new Map<string, string | null>();
  const order: string[] = [];
  try {
    const path = realpathSync(transcriptRef);
    const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const raw of lines) {
      line += 1;
      if (raw.length === 0) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        failedLine ??= line;
        break;
      }
      if (harness === 'claude') {
        const ref = eventRef(isRecord(parsed) ? parsed['uuid'] : null, line);
        firstEventRef ??= ref;
        lastCompleteEventRef = ref;
        continue;
      }
      if (!isRecord(parsed)) {
        failedLine ??= line;
        continue;
      }
      // OMP 的固定标题槽是文件级 metadata，不属于会话条目树。
      if (harness === 'omp' && line === 1 && parsed['type'] === 'title' && parsed['v'] === 1
        && typeof parsed['title'] === 'string' && typeof parsed['updatedAt'] === 'string'
        && typeof parsed['pad'] === 'string') {
        continue;
      }
      if (parsed['type'] === 'session') {
        // 会话头只承载身份；活动分支从条目图推导。
        headerId = typeof parsed['id'] === 'string' ? parsed['id'] : null;
        continue;
      }
      const id = typeof parsed['id'] === 'string' ? parsed['id'] : null;
      if (id === null) {
        failedLine ??= line;
        continue;
      }
      parents.set(id, typeof parsed['parentId'] === 'string' ? parsed['parentId'] : null);
      order.push(id);
    }
    if (harness !== 'claude') {
      const resolvedLeaf = leafId ?? readLeafSidecar(path, headerId);
      if (resolvedLeaf === null) {
        return unavailable('无法证明活动叶子：既没有显式 leafId，也没有精确 sidecar');
      }
      const branch = activeBranch(parents, order, resolvedLeaf);
      if (branch === null) {
        return unavailable('transcript 活动分支不完整：叶子缺失、父链断裂或成环');
      }
      if (branch.length === 0) {
        return unavailable('transcript 没有完整事件');
      }
      firstEventRef = branch[0] ?? null;
      lastCompleteEventRef = branch.at(-1) ?? null;
    }
    if (firstEventRef === null || lastCompleteEventRef === null) {
      return unavailable('transcript 没有完整事件');
    }
    if (failedLine !== null) {
      return partialEvidence(firstEventRef, lastCompleteEventRef, path, 'line:' + failedLine, 'invalid_json');
    }
    return {
      kind: 'covered',
      evidence: {
        coverage: 'complete',
        readableRange: { transcriptRef: path, fromEventRef: firstEventRef, toEventRef: lastCompleteEventRef },
        gaps: [],
        lastCompleteEventRef,
      },
    };
  } catch (error) {
    if (harness !== 'claude') {
      const branch = activeBranch(parents, order, leafId ?? null);
      if (branch !== null && branch.length > 0) {
        return partialEvidence(branch[0] ?? null, branch.at(-1) ?? null, transcriptRef, 'line:' + (line + 1), 'read_failed');
      }
    } else if (firstEventRef !== null && lastCompleteEventRef !== null) {
      return partialEvidence(firstEventRef, lastCompleteEventRef, transcriptRef, 'line:' + (line + 1), 'read_failed');
    }
    return unavailable(error instanceof Error ? error.message : 'native transcript 读取失败');
  }
}

/**
 * 活动分支：从指定叶子（缺省为文件最后一个条目）沿 parentId 回溯到根。
 *
 * 叶子不在文件里、父链断裂（父 id 未出现）或成环都返回 null——这些都不是「少一点历史」，
 * 而是身份不可证明，必须 fail closed，不能用别的分支顶替。
 */
function activeBranch(
  parents: ReadonlyMap<string, string | null>,
  order: readonly string[],
  leafId: string | null,
): readonly string[] | null {
  const leaf = leafId ?? order.at(-1);
  if (leaf === undefined) {
    return [];
  }
  if (!parents.has(leaf)) {
    return null;
  }
  const branch: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = leaf;
  while (cursor !== null) {
    if (seen.has(cursor) || !parents.has(cursor)) {
      return null;
    }
    seen.add(cursor);
    branch.push(cursor);
    cursor = parents.get(cursor) ?? null;
  }
  return branch.reverse();
}

/**
 * Utility Worker 读取 native transcript 的逐 harness 配方。
 *
 * 这必须随 harness 给出：pi/omp 的会话是带 id/parentId 的树，事件引用是条目 id，且只有从报告的
 * 活动叶子回溯得到的活动分支属于本次会话；claude 是线性 JSONL，事件引用是条目 uuid。通用的 Codex
 * 配方（按 timestamp/ordinal 遍历全部行）在这里都会读错。
 */
export function nativeRecoveryInstructions(harness: NativeHarness): readonly string[] {
  if (harness === 'claude') {
    return [
      'transcript 是线性 JSONL：会话身份在最早出现 sessionId/cwd 的记录里，逐行顺序即会话顺序。',
      '事件引用使用每条记录的 uuid；该条没有 uuid 时退回其行号（line:N）。只在给定的精确 transcriptRef 内读取，不按时间或最近文件另选。',
      '解析失败的行按 adapter evidence.gaps 逐项对待：coverage 为 partial 时不得跨越缺口把两侧当成连续历史。',
    ];
  }
  return [
    'transcript 是 JSONL 树：首行是会话头 {type:"session",id,cwd,version}，用于核验 id 与 cwd。',
    '条目靠 id/parentId 组成树；活动叶子只取 adapter evidence 的 toEventRef（lastCompleteEventRef），不取文件最后一行；从该叶子沿 parentId 回溯到根得到活动分支，忽略同文件里其它分支。',
    '事件引用使用条目 id；evidence.toEventRef 缺失、叶子不在文件里或活动分支不完整（父链断裂、成环）时停止，不用其它分支或全部行顶替。',
    '解析失败的行按 evidence.gaps 逐项对待：coverage 为 partial 时不得跨越缺口把两侧当成连续历史，缺口之后的条目不能充当重放锚点。',
  ];
}
