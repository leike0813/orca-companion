/**
 * IP-05：OpenCode Worker Harness adapter（Owner: remove-worker-credential-management）。
 *
 * OpenCode 没有 SessionStart hook 或进程内 extension：provider session 事实只经隔离 --standalone
 * 私有子进程的公开 HTTP API 观察（GET /api/session、GET /api/session/:sessionID/message）。
 *
 * 本 adapter 不再建立隔离 HOME/XDG、不复制登录态、不生成 provider 配置：Worker 启动继承真实
 * launch 的 process.env，认证与状态根由 opencode 自身拥有。session 创建必须发生在真实终端 spawn
 * 的子进程里，因此 prepare 只写一份自包含的 Companion bootstrap 工件（非秘密）；该脚本在真实环境
 * 内经公开 opencode api --standalone 建 exact session、上报 runtime roots，再 exec opencode mini。
 * Companion 侧只经公开 API 回读精确身份，绝不直读 SQLite、不按终端输出或最近会话猜。
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { PreparedTerminalStrategy } from '../../application/worker-launch.js';
import type {
  HarnessTranscriptCoverageResult,
  HarnessTranscriptProofResult,
  PreparedHarnessTerminal,
  ProveHarnessSessionInput,
  WorkerHarness,
  WorkerHarnessLaunchInput,
} from '../../application/ports/worker-harness.js';
import type { TranscriptCoverageEvidence, TranscriptGap } from '../../application/recovery/recovery-capsule.js';
import { workerModelSelectionSchema } from '../../domain/model-configuration.js';
import type { WorkerModelSelection } from '../../domain/model-configuration.js';
import { CODEX_MODEL_DESCRIPTOR_VERSION, codexModelLaunchCommand, writeCodexModelLaunch } from './codex-model-launcher.js';
import type { CodexModelLaunchDescriptor } from './codex-model-launcher.js';
import { assertReadOnlyExecutionWrapperAvailable, probeHarnessReadOnlyWorker } from './read-only-execution-wrapper.js';
import { queryWorkerModels } from './worker-model-catalog.js';
import { nativeWorkerRuntime } from './worker-runtime.js';

export const OPENCODE_HARNESS_ID = 'opencode';

/** 会话状态报告（JSONL）：每行一次经公开 API 确认的观察。 */
export const OPENCODE_SESSION_REPORT_FILENAME = 'session-start.jsonl';

/** Utility 私有可写根内的派生转录材料目录。 */
export const OPENCODE_MATERIAL_DIR = 'opencode-recovery';

/** Companion bootstrap 工件文件名（写入 Companion 工件根，非秘密）。 */
export const OPENCODE_BOOTSTRAP_SCRIPT_FILENAME = 'opencode-bootstrap.mjs';
export const OPENCODE_BOOTSTRAP_PAYLOAD_FILENAME = 'opencode-bootstrap.json';

const MAX_API_BODY_BYTES = 8 * 1024 * 1024;
const API_TIMEOUT_MS = 30_000;
const MAX_MATERIAL_BYTES = 4 * 1024 * 1024;

/** session 列表分页上限：候选唯一性只在穷尽窗口后成立。 */
const SESSION_LIST_PAGE_SIZE = 20;
const MAX_SESSION_LIST_PAGES = 3;

export const OPENCODE_MESSAGE_PAGE_SIZE = 50;
export const OPENCODE_MAX_MESSAGE_PAGES = 40;
export const OPENCODE_MAX_MESSAGE_EVENTS = 2_000;

const SAFE_SESSION_ID = /^ses[A-Za-z0-9_-]{3,}$/;

/** 与 Codex/native 相同的启动摘要公式：sha256(launchId) 前 20 位十六进制。 */
export function opencodeLaunchDigest(launchId: string): string {
  return createHash('sha256').update(launchId).digest('hex').slice(0, 20);
}

/** 由 launchId 确定性派生 provider session 身份；重放得到同一 id。 */
export function opencodeSessionIdFor(launchId: string): string {
  return 'ses_' + opencodeLaunchDigest(launchId);
}

function assertInsideWorktree(worktreePath: string, candidate: string): void {
  const child = relative(resolve(worktreePath), resolve(candidate));
  if (child.length === 0 || child === '..' || child.startsWith('..' + sep) || isAbsolute(child)) {
    throw new Error('opencode Companion 工件根必须位于 Worker worktree 内：' + candidate);
  }
}

function samePath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

/** 启动前门禁：Worker 选择必须合法；opencode 的 effort→variant 映射未经核验，宁可阻塞也不换模型。 */
export function assertLaunchableOpencodeModelSelection(selection: Readonly<WorkerModelSelection>): void {
  if (!workerModelSelectionSchema.safeParse(selection).success) {
    throw new Error('opencode Worker 模型选择无效：需要合法的 model/effort/effortCapability/catalogSource');
  }
  if (selection.effort !== null) {
    throw new Error('opencode adapter 未核验 effort→variant 映射，拒绝带 effort 的启动');
  }
}

export type OpencodeExecutionInput = WorkerHarnessLaunchInput & {
  /** 测试可指向 fake opencode 可执行文件。 */
  readonly executable?: string;
  /** 只读启动前的包装器核验；省略时用真实 bwrap 探针。 */
  readonly assertReadOnlyWrapperAvailable?: () => Promise<void>;
};

export type OpencodeResumeInput = OpencodeExecutionInput & {
  readonly sessionId: string;
  /** 原精确 report 记录的真实 native 状态根；仅用于核验。 */
  readonly originalStateRoot: string;
  readonly transcriptRef: string;
};

/**
 * 真实终端里运行的自包含 bootstrap 脚本；只依赖 node 内置与公开 opencode CLI。
 *
 * create=true 时先经公开 api --standalone 建立 exact session 并核验身份，随后把一次确认观察追加到
 * Companion 报告，最后 exec opencode mini。期间不写任何 native auth/config，也不改写环境。
 */
const OPENCODE_BOOTSTRAP_SCRIPT = [
  "import { spawn, spawnSync } from 'node:child_process';",
  "import { appendFileSync, readFileSync, realpathSync } from 'node:fs';",
  '',
  'const payload = JSON.parse(readFileSync(process.argv[2], "utf8"));',
  'const runtime = JSON.parse(readFileSync(payload.runtimeReportPath, "utf8"));',
  'function fail(message) { process.stderr.write("companion opencode bootstrap: " + message + "\\n"); process.exit(2); }',
  'function samePath(left, right) { try { return realpathSync(left) === realpathSync(right); } catch { return false; } }',
  'function api(args) {',
  '  const result = spawnSync(payload.executable, ["api", "--standalone", ...args], { cwd: payload.workspace, env: process.env, encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });',
  '  if (result.error || result.status !== 0) return null;',
  '  try { return JSON.parse(result.stdout); } catch { return null; }',
  '}',
  'if (payload.create) {',
  '  const created = api(["POST", "/api/session", "--data", JSON.stringify({ id: payload.sessionId, location: { directory: payload.workspace } })]);',
  '  const session = created && created.data ? created.data : null;',
  '  if (!session || session.id !== payload.sessionId || !session.location || !samePath(session.location.directory, payload.workspace)) fail("session identity unconfirmed");',
  '}',
  'appendFileSync(payload.reportPath, JSON.stringify({ harness: "opencode", sessionId: payload.sessionId, transcriptPath: payload.reportPath, stateRoot: runtime.stateRoot, runtimeRoots: runtime.writableRoots, cwd: payload.workspace, observedAt: new Date().toISOString() }) + "\\n", { mode: 0o600 });',
  'const child = spawn(payload.executable, ["mini", "--standalone", "--model", payload.model, "--session", payload.sessionId], { stdio: "inherit" });',
  'for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => { if (!child.killed) child.kill(signal); });',
  'child.on("error", () => process.exit(1));',
  'child.on("close", (code, signal) => process.exit(typeof code === "number" ? code : signal ? 1 : 0));',
  '',
].join('\n');

type BootstrapPayload = {
  readonly executable: string;
  readonly sessionId: string;
  readonly workspace: string;
  readonly model: string;
  readonly runtimeReportPath: string;
  readonly reportPath: string;
  readonly create: boolean;
};

/** 写 Companion bootstrap 脚本与 payload（非秘密）；脚本内容不变则不重写。 */
function writeBootstrapArtifacts(stateRoot: string, payload: BootstrapPayload): { readonly scriptPath: string; readonly payloadPath: string } {
  mkdirSync(stateRoot, { recursive: true });
  const scriptPath = join(stateRoot, OPENCODE_BOOTSTRAP_SCRIPT_FILENAME);
  if (!existsSync(scriptPath) || readFileSync(scriptPath, 'utf8') !== OPENCODE_BOOTSTRAP_SCRIPT) {
    writeFileSync(scriptPath, OPENCODE_BOOTSTRAP_SCRIPT, { mode: 0o600 });
  }
  const payloadPath = join(stateRoot, OPENCODE_BOOTSTRAP_PAYLOAD_FILENAME);
  writeFileSync(payloadPath, JSON.stringify(payload) + '\n', { mode: 0o600 });
  return { scriptPath, payloadPath };
}

function isReadOnlyMode(mode: WorkerHarnessLaunchInput['sandboxMode']): boolean {
  return mode === 'read-only' || mode === 'read-only-local-control';
}

/** Companion 工件根：只放 launcher/reporter/bootstrap 工件，绝不当作 native 状态根。 */
function prepareState(execution: OpencodeExecutionInput, worktreePath: string): string {
  const digest = opencodeLaunchDigest(execution.launchId);
  const stateRoot = execution.stateRoot === undefined
    ? join(worktreePath, '.companion', OPENCODE_HARNESS_ID, digest)
    : join(execution.stateRoot, digest);
  if (execution.stateRoot === undefined) {
    assertInsideWorktree(worktreePath, stateRoot);
  }
  mkdirSync(stateRoot, { recursive: true });
  if (isReadOnlyMode(execution.sandboxMode)) {
    mkdirSync(join(stateRoot, 'tmp'), { recursive: true });
  }
  return stateRoot;
}

async function assertReadOnlyReady(execution: OpencodeExecutionInput): Promise<void> {
  if (!isReadOnlyMode(execution.sandboxMode)) return;
  await (execution.assertReadOnlyWrapperAvailable ?? assertReadOnlyExecutionWrapperAvailable)();
}

function buildLaunch(input: {
  readonly execution: OpencodeExecutionInput;
  readonly title: string;
  readonly worktreePath: string;
  readonly sessionId: string;
  readonly create: boolean;
  readonly reportPath?: string;
  readonly expectedStateRoot?: string;
}): PreparedHarnessTerminal {
  assertLaunchableOpencodeModelSelection(input.execution.modelSelection);
  const stateRoot = prepareState(input.execution, input.worktreePath);
  // 本次派发的报告写在本次 Companion 工件区（sessionStartReporterPath），用于证明本次观察窗口；
  // resume 的原报告只用于核验原身份，不被复用为本次证据。
  const reportPath = input.reportPath ?? input.execution.sessionStartReporterPath ?? join(stateRoot, OPENCODE_SESSION_REPORT_FILENAME);
  const runtimeReportPath = join(stateRoot, 'native-runtime.json');
  const { scriptPath, payloadPath } = writeBootstrapArtifacts(stateRoot, {
    executable: input.execution.executable ?? OPENCODE_HARNESS_ID,
    sessionId: input.sessionId,
    workspace: resolve(input.worktreePath),
    model: input.execution.modelSelection.model,
    runtimeReportPath,
    reportPath,
    create: input.create,
  });
  const reportDirectory = dirname(reportPath);
  const readOnly = isReadOnlyMode(input.execution.sandboxMode)
    ? {
        workspace: input.worktreePath,
        stateRoot,
        ...(reportDirectory === stateRoot ? {} : { reportDirectory }),
      }
    : undefined;
  const descriptor: CodexModelLaunchDescriptor = {
    version: CODEX_MODEL_DESCRIPTOR_VERSION,
    executable: process.execPath,
    args: [scriptPath, payloadPath],
    harness: OPENCODE_HARNESS_ID,
    ...(input.expectedStateRoot === undefined ? {} : { expectedStateRoot: input.expectedStateRoot }),
    runtimeReportPath,
    ...(readOnly === undefined ? {} : { readOnly }),
  };
  const { descriptorPath, launcherPath } = writeCodexModelLaunch({ stateRoot, descriptor });
  return { title: input.title, stateRoot, command: codexModelLaunchCommand({ launcherPath, descriptorPath }) };
}

/** 新建 Session 的固定 prepared-terminal 策略；session id 由 launchId 确定性派生。 */
export function createOpencodeWorkerLaunch(
  input: OpencodeExecutionInput,
): PreparedTerminalStrategy<PreparedHarnessTerminal> {
  if (input.launchId.length === 0) {
    throw new Error('opencode launchId 必须是非空字符串');
  }
  const sessionId = opencodeSessionIdFor(input.launchId);
  const title = 'orca-companion:opencode:' + opencodeLaunchDigest(input.launchId);
  return {
    kind: 'prepared_terminal',
    harness: OPENCODE_HARNESS_ID,
    activation: 'submit_draft',
    title,
    prepare: async ({ worktreePath }) => {
      if (!isAbsolute(worktreePath)) {
        throw new Error('opencode Worker worktree 必须是绝对路径：' + worktreePath);
      }
      if (input.stateRoot !== undefined && !isAbsolute(input.stateRoot)) {
        throw new Error('opencode 工件根必须是绝对路径：' + input.stateRoot);
      }
      assertLaunchableOpencodeModelSelection(input.modelSelection);
      await assertReadOnlyReady(input);
      const reportPath = input.sessionStartReporterPath ?? join(prepareState(input, worktreePath), OPENCODE_SESSION_REPORT_FILENAME);
      return buildLaunch({ execution: input, title, worktreePath, sessionId, create: true, reportPath });
    },
  };
}

/**
 * 复用原 Session：同一精确 session id 与原原生状态根。
 * 绝不用 --continue、picker 或最近会话；session 创建在启动子进程里完成，这里只做失败前置核验。
 */
export function createOpencodeResumeLaunch(
  input: OpencodeResumeInput,
): PreparedTerminalStrategy<PreparedHarnessTerminal> {
  if (input.launchId.length === 0) {
    throw new Error('opencode launchId 必须是非空字符串');
  }
  if (!isAbsolute(input.originalStateRoot)) {
    throw new Error('opencode resume 的原 native 状态根必须是绝对路径：' + input.originalStateRoot);
  }
  const title = 'orca-companion:opencode-resume:' + opencodeLaunchDigest(input.launchId);
  return {
    kind: 'prepared_terminal',
    harness: OPENCODE_HARNESS_ID,
    activation: 'submit_draft',
    title,
    prepare: async ({ worktreePath }) => {
      if (!isAbsolute(worktreePath)) {
        throw new Error('opencode Worker worktree 必须是绝对路径：' + worktreePath);
      }
      if (!SAFE_SESSION_ID.test(input.sessionId)) {
        throw new Error('opencode resume session ID 形态非法，拒绝启动');
      }
      assertLaunchableOpencodeModelSelection(input.modelSelection);
      const report = readSessionReportFile(input.transcriptRef);
      if (report === null || report.sessionId !== input.sessionId
        || !samePath(report.cwd, worktreePath) || !samePath(report.stateRoot, input.originalStateRoot)
        || !matchesCurrentNativeRoot(report.stateRoot, report.runtimeRoots)) {
        throw new Error('opencode resume 原 Session 身份不可证明');
      }
      const original = await findUniqueSession({
        executable: input.executable ?? OPENCODE_HARNESS_ID,
        env: currentOpencodeEnv(),
        workspace: worktreePath,
        sessionId: input.sessionId,
      });
      if (!original.ok) throw new Error('opencode resume 原 Session 不可用：' + original.reason);
      await assertReadOnlyReady(input);
      return buildLaunch({
        execution: input,
        title,
        worktreePath,
        sessionId: input.sessionId,
        create: false,
        reportPath: input.transcriptRef,
        expectedStateRoot: input.originalStateRoot,
      });
    },
  };
}

/**
 * 每个 launch 的稳定私有命名空间：stateRoot 是 Companion harness 级工件父目录（实际工件根在其下按
 * digest 取），报告路径已拼好 digest。
 */
export function sessionPathsUnder(companionStateRoot: string, launchId: string): {
  readonly stateRoot: string;
  readonly reporterPath: string;
  readonly reportPath: string;
} {
  const stateRoot = join(companionStateRoot, OPENCODE_HARNESS_ID);
  const reportPath = join(stateRoot, opencodeLaunchDigest(launchId), OPENCODE_SESSION_REPORT_FILENAME);
  return { stateRoot, reporterPath: reportPath, reportPath };
}

// ---------------------------------------------------------------------------------------------
// 经公开 API 的观察、证明与覆盖证据
// ---------------------------------------------------------------------------------------------

export type OpencodeSessionReport = {
  readonly harness: 'opencode';
  readonly sessionId: string;
  readonly transcriptPath: string;
  readonly stateRoot: string;
  readonly runtimeRoots: readonly string[];
  readonly cwd: string;
  readonly observedAt: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

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

/** 真实 launch 环境：proof/query 只继承当前进程环境，绝不从报告反推或覆盖 XDG/认证。 */
function currentOpencodeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

/** 本进程当前真实原生状态根；报告必须与它一致，禁止从报告反向生成环境。 */
function currentNativeRoot(): string | null {
  try {
    return nativeWorkerRuntime(OPENCODE_HARNESS_ID, process.env).stateRoot;
  } catch {
    return null;
  }
}

/** 报告的 native 根必须与本进程实际 native runtime 相同；不同即不可用。 */
function matchesCurrentNativeRoot(reportedRoot: string, reportedRoots: readonly string[]): boolean {
  const actual = currentNativeRoot();
  if (actual === null || !samePath(actual, reportedRoot)) return false;
  try {
    const roots = nativeWorkerRuntime(OPENCODE_HARNESS_ID, process.env).writableRoots;
    return roots.length === reportedRoots.length && roots.every((root) => reportedRoots.includes(root));
  } catch { return false; }
}

type CliResult =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** 公开 CLI 调用；输出有界、超时可控，失败只报告固定 code。环境由调用方按真实 roots 提供。 */
function runOpencodeApi(input: {
  readonly executable: string;
  readonly env: Readonly<Record<string, string>>;
  readonly workspace: string;
  readonly args: readonly string[];
}): Promise<CliResult> {
  return new Promise((resolveResult) => {
    execFile(
      input.executable,
      ['api', '--standalone', ...input.args],
      {
        cwd: input.workspace,
        env: input.env,
        encoding: 'utf8',
        maxBuffer: MAX_API_BODY_BYTES,
        timeout: API_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolveResult({ ok: true, stdout });
          return;
        }
        const rawCode = (error as { readonly code?: unknown }).code;
        const code = typeof rawCode === 'string' && rawCode.length > 0 ? rawCode : 'opencode_api_failed';
        resolveResult({ ok: false, code, message: (stderr.length > 0 ? stderr : stdout).trim().slice(0, 400) });
      },
    );
  });
}

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

type SessionMetadata = { readonly id: string; readonly directory: string };

function parseSessionItem(value: unknown): SessionMetadata | null {
  if (!isRecord(value)) return null;
  const id = value['id'];
  const location = value['location'];
  return typeof id === 'string' && id.length > 0
    && isRecord(location) && typeof location['directory'] === 'string' && location['directory'].length > 0
    ? { id, directory: location['directory'] }
    : null;
}

/** 只承认规范的 {data: [], cursor: {previous, next}} 形状；形状不符即不可核验。 */
function parseSessionListEnvelope(value: unknown): { readonly items: readonly unknown[]; readonly next: string | null } | null {
  if (!isRecord(value) || !Array.isArray(value['data'])) return null;
  const cursor = value['cursor'];
  if (!isRecord(cursor)) return null;
  const next = cursor['next'];
  if (next !== null && typeof next !== 'string' && !(next === undefined && value['data'].length === 0)) return null;
  return { items: value['data'], next: typeof next === 'string' && next.length > 0 ? next : null };
}

/** 消息 envelope：cursor 是必填分页形状，缺失或未知不能当末页。 */
function parseMessageEnvelope(value: unknown): {
  readonly items: readonly unknown[];
  readonly next: string | null;
  readonly truncated: boolean;
} | null {
  if (!isRecord(value) || !Array.isArray(value['data'])) return null;
  const cursor = value['cursor'];
  if (!isRecord(cursor)) return null;
  const next = cursor['next'];
  if (next !== null && typeof next !== 'string' && !(next === undefined && value['data'].length === 0)) return null;
  return {
    items: value['data'],
    next: typeof next === 'string' && next.length > 0 ? next : null,
    truncated: value['truncated'] === true,
  };
}

/** v2 消息条目是 {info:{id}, parts:[...]}；缺失事件引用即不可读。 */
function messageEventRef(item: unknown): string | null {
  if (!isRecord(item)) return null;
  const info = item['info'];
  const id = isRecord(info) ? info['id'] : item['id'];
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * 经公开 GET /api/session（{data, cursor:{previous,next}}）在有界窗口内确认唯一候选。
 * 窗口未穷尽、候选不为 1、directory 不符或 cursor 循环都判不可核验。
 */
async function findUniqueSession(input: {
  readonly executable: string;
  readonly env: Readonly<Record<string, string>>;
  readonly workspace: string;
  readonly sessionId: string;
}): Promise<{ readonly ok: true; readonly session: SessionMetadata } | { readonly ok: false; readonly reason: string }> {
  const candidates: SessionMetadata[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  let exhausted = false;
  for (;;) {
    pages += 1;
    if (pages > MAX_SESSION_LIST_PAGES) break;
    const result = await runOpencodeApi({
      executable: input.executable,
      env: input.env,
      workspace: input.workspace,
      args: [
        'session.list',
        '--param', 'limit=' + SESSION_LIST_PAGE_SIZE,
        '--param', 'directory=' + input.workspace,
        ...(cursor === null ? [] : ['--param', 'cursor=' + cursor]),
      ],
    });
    if (!result.ok) return { ok: false, reason: 'opencode API 读取失败：' + result.code };
    const envelope = parseSessionListEnvelope(parseJson(result.stdout));
    if (envelope === null) return { ok: false, reason: 'opencode session 列表形状不可核验' };
    for (const item of envelope.items) {
      const session = parseSessionItem(item);
      if (session !== null) candidates.push(session);
    }
    if (envelope.next === null) {
      exhausted = true;
      break;
    }
    if (seen.has(envelope.next)) return { ok: false, reason: 'opencode session 列表 cursor 循环' };
    seen.add(envelope.next);
    cursor = envelope.next;
  }
  if (!exhausted) return { ok: false, reason: 'opencode session 列表未穷尽，无法证明候选唯一' };
  const matches = candidates.filter((candidate) => candidate.id === input.sessionId);
  if (matches.length !== 1) {
    return { ok: false, reason: 'opencode session 候选数量必须为 1，实际为 ' + String(matches.length) };
  }
  const session = matches[0];
  if (session === undefined || !samePath(session.directory, input.workspace)) {
    return { ok: false, reason: 'opencode session metadata 的 directory 与绑定 workspace 不一致' };
  }
  return { ok: true, session };
}

/** 报告文件里的一条可核验会话状态。 */
function parseSessionReportLine(parsed: unknown): OpencodeSessionReport | null {
  if (!isRecord(parsed)) return null;
  const { harness, sessionId, transcriptPath, stateRoot, runtimeRoots, cwd, observedAt } = parsed;
  return harness === OPENCODE_HARNESS_ID
    && typeof sessionId === 'string' && SAFE_SESSION_ID.test(sessionId)
    && typeof transcriptPath === 'string' && transcriptPath.length > 0
    && typeof stateRoot === 'string' && stateRoot.length > 0
    && Array.isArray(runtimeRoots) && runtimeRoots.every((root) => typeof root === 'string' && root.length > 0)
    && typeof cwd === 'string' && cwd.length > 0
    && (observedAt === null || typeof observedAt === 'string')
    ? {
        harness: OPENCODE_HARNESS_ID,
        sessionId,
        transcriptPath,
        stateRoot,
        runtimeRoots: runtimeRoots as readonly string[],
        cwd,
        observedAt,
      }
    : null;
}

/**
 * 只认最新一条非空行：最新行解析或 schema 失败即 null，不回落旧行；任何其它有效行出现不同
 * session ID 都表示多候选，同样 fail closed。
 */
function readSessionReportFile(path: string): OpencodeSessionReport | null {
  let lines: readonly string[];
  try {
    lines = readFileSync(path, 'utf8').split('\n');
  } catch {
    return null;
  }
  const nonEmpty = lines.map((line) => line.trim()).filter((line) => line.length > 0);
  const latest = nonEmpty.at(-1);
  if (latest === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(latest);
  } catch {
    return null;
  }
  const report = parseSessionReportLine(parsed);
  if (report === null) return null;
  for (const line of nonEmpty.slice(0, -1)) {
    let other: unknown;
    try {
      other = JSON.parse(line);
    } catch {
      continue;
    }
    const otherReport = parseSessionReportLine(other);
    if (otherReport !== null && otherReport.sessionId !== report.sessionId) return null;
  }
  return report;
}

/**
 * 证明一次 opencode Session：报告、真实 native 状态根、runtime roots、workspace、时间窗与公开 API
 * 事实必须一致。expectedStateRoot 只作核验，不覆盖真实环境；工件目录不当作 native root。
 */
export async function proveOpencodeTranscript(
  input: ProveHarnessSessionInput,
): Promise<HarnessTranscriptProofResult> {
  const report = input.report;
  if (report.harness !== undefined && report.harness !== OPENCODE_HARNESS_ID) {
    return unavailable('报告的 harness 不是 opencode');
  }
  const sessionId = report.sessionId;
  const cwd = report.cwd;
  if (sessionId === null || cwd === null || !SAFE_SESSION_ID.test(sessionId)) {
    return unavailable('opencode 报告缺少可核验的 session ID 或 cwd');
  }
  const nativeRoot = report.stateRoot ?? report.codexHome ?? null;
  if (nativeRoot === null) {
    return unavailable('opencode 报告缺少真实 native 状态根');
  }
  if (!samePath(cwd, input.workspace)) {
    return unavailable('报告 cwd 与绑定 workspace 不一致');
  }
  if (input.expectedStateRoot.length === 0 || !samePath(nativeRoot, input.expectedStateRoot)) {
    return unavailable('报告 native 状态根与本次派发预期的原生根不一致');
  }
  if (report.runtimeRoots === undefined || report.runtimeRoots.length === 0) {
    return unavailable('opencode 报告缺少原生 runtime roots');
  }
  if (!matchesCurrentNativeRoot(nativeRoot, report.runtimeRoots)) {
    return unavailable('opencode 当前真实原生状态根与报告不一致');
  }
  const observedAt = report.observedAt ?? new Date().toISOString();
  const observed = instant(observedAt);
  const startedAt = instant(input.dispatchStartedAt);
  const deadlineAt = instant(input.bindingDeadlineAt);
  if (
    observed === null || startedAt === null || deadlineAt === null
    || deadlineAt < startedAt || observed < startedAt || observed > deadlineAt
  ) {
    return unavailable('opencode 观察不在当前 Dispatch 绑定时间窗内');
  }
  const found = await findUniqueSession({
    executable: OPENCODE_HARNESS_ID,
    env: currentOpencodeEnv(),
    workspace: input.workspace,
    sessionId,
  });
  if (!found.ok) return unavailable(found.reason);
  // 只读核验：报告由实际 launch bootstrap 签发，这里绝不 append 或改写任何报告。
  const transcriptPath = report.transcriptPath ?? join(nativeRoot, OPENCODE_SESSION_REPORT_FILENAME);
  return { kind: 'proven', proof: { providerSessionId: sessionId, transcriptRef: transcriptPath, observedAt } };
}

/** 重启后从精确状态报告重新观察 opencode 身份，并经公开 API 确认仍在同一 workspace。 */
export async function readOpencodeTranscriptIdentity(input: {
  readonly transcriptRef: string;
  readonly workspace: string;
}): Promise<{ readonly providerSessionId: string }
  | { readonly kind: 'transcript_unavailable'; readonly reason: string }> {
  const report = readSessionReportFile(input.transcriptRef);
  if (report === null) return unavailable('opencode 状态报告缺失或不可核验');
  if (!samePath(report.cwd, input.workspace)) {
    return unavailable('状态报告的 cwd 与绑定 workspace 不一致');
  }
  if (!matchesCurrentNativeRoot(report.stateRoot, report.runtimeRoots)) {
    return unavailable('opencode 当前真实原生状态根与报告不一致');
  }
  const found = await findUniqueSession({
    executable: OPENCODE_HARNESS_ID,
    env: currentOpencodeEnv(),
    workspace: input.workspace,
    sessionId: report.sessionId,
  });
  if (!found.ok) return unavailable(found.reason);
  return { providerSessionId: report.sessionId };
}

type MessageCollection = {
  readonly items: readonly unknown[];
  readonly events: readonly string[];
  readonly gap: TranscriptGap | null;
};

/** 有界分页：硬上限页数/事件数/材料字节数，并检测 cursor 循环、截断与非法条目。 */
async function collectMessages(input: {
  readonly executable: string;
  readonly env: Readonly<Record<string, string>>;
  readonly workspace: string;
  readonly sessionId: string;
}): Promise<MessageCollection> {
  const items: unknown[] = [];
  const events: string[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  let cursor: string | null = null;
  let pages = 0;
  const gapAt = (reason: string): MessageCollection => ({
    items,
    events,
    gap: { fromEventRef: events.at(-1) ?? 'message:0', toEventRef: null, reason },
  });
  for (;;) {
    pages += 1;
    if (pages > OPENCODE_MAX_MESSAGE_PAGES) return gapAt('page_limit');
    const result = await runOpencodeApi({
      executable: input.executable,
      env: input.env,
      workspace: input.workspace,
      args: [
        'GET', '/api/session/' + encodeURIComponent(input.sessionId) + '/message?'
          + new URLSearchParams({ limit: String(OPENCODE_MESSAGE_PAGE_SIZE), ...(cursor === null ? {} : { cursor }) }).toString(),
      ],
    });
    if (!result.ok) return gapAt(result.code);
    const envelope = parseMessageEnvelope(parseJson(result.stdout));
    if (envelope === null) return gapAt('invalid_response');
    // 被截断的一页尾部不可信：该页条目一律不计入可读事件，缺口从上一页末尾开始，
    // 绝不让可能被截断的条目充当 lastCompleteEventRef。
    if (envelope.truncated) return gapAt('truncated');
    for (const item of envelope.items) {
      const id = messageEventRef(item);
      if (id === null) return gapAt('invalid_message');
      const serialized = JSON.stringify(item);
      bytes += serialized.length + 1;
      if (bytes > MAX_MATERIAL_BYTES) return gapAt('material_byte_limit');
      items.push(item);
      events.push(id);
      if (events.length > OPENCODE_MAX_MESSAGE_EVENTS) return gapAt('event_limit');
    }
    const next = envelope.next;
    if (next === null) return { items, events, gap: null };
    if (seen.has(next)) return gapAt('cursor_cycle');
    seen.add(next);
    cursor = next;
  }
}

/** 只记录事件边界与解析失败，不复制转录正文；消息只经 v2 分页接口读取。 */
export async function inspectOpencodeTranscript(transcriptRef: string): Promise<HarnessTranscriptCoverageResult> {
  const report = readSessionReportFile(transcriptRef);
  if (report === null) return unavailable('opencode 状态报告缺失或不可核验');
  if (!matchesCurrentNativeRoot(report.stateRoot, report.runtimeRoots)) {
    return unavailable('opencode 当前真实原生状态根与报告不一致');
  }
  const collected = await collectMessages({
    executable: OPENCODE_HARNESS_ID,
    env: currentOpencodeEnv(),
    workspace: report.cwd,
    sessionId: report.sessionId,
  });
  const firstEventRef = collected.events[0] ?? null;
  const lastCompleteEventRef = collected.events.at(-1) ?? null;
  if (firstEventRef === null || lastCompleteEventRef === null) {
    return unavailable(collected.gap === null ? 'opencode 转录没有可读事件' : 'opencode 转录不可读：' + collected.gap.reason);
  }
  const evidence: TranscriptCoverageEvidence = {
    coverage: collected.gap === null ? 'complete' : 'partial',
    readableRange: {
      transcriptRef: report.transcriptPath,
      fromEventRef: firstEventRef,
      toEventRef: lastCompleteEventRef,
    },
    gaps: collected.gap === null ? [] : [collected.gap],
    lastCompleteEventRef,
  };
  return { kind: 'covered', evidence };
}

// ---------------------------------------------------------------------------------------------
// IP-13：派生转录材料（宿主在沙箱外经公开 API 提取，Utility 只读该材料）
// ---------------------------------------------------------------------------------------------

/** 材料路径：确定性派生自原 transcriptRef，落在 Utility 私有可写状态根内。 */
export function opencodeRecoveryMaterialPath(writableRoot: string, transcriptRef: string): string {
  const digest = createHash('sha256').update(resolve(transcriptRef)).digest('hex').slice(0, 20);
  return join(writableRoot, OPENCODE_MATERIAL_DIR, digest + '.jsonl');
}

function shellQuote(value: string): string {
  return "'" + value.split("'").join("'\\''") + "'";
}

/**
 * Utility 侧只读说明：材料是宿主提取的派生副本，coverage 仍绑定原 transcriptRef。
 * 材料尚未写好时返回 null，调用方按不可用阻塞。
 */
export function opencodeRecoveryInstructions(
  transcriptRef: string,
  options: { readonly writableRoot?: string; readonly materialized?: boolean; readonly gap?: TranscriptGap | null } = {},
): readonly string[] | null {
  const report = readSessionReportFile(transcriptRef);
  if (report === null) return null;
  const materialPath = options.writableRoot === undefined
    ? null
    : opencodeRecoveryMaterialPath(options.writableRoot, transcriptRef);
  const lines = [
    'opencode 转录材料读取（host 经公开分页 API 提取的派生副本；coverage 绑定原 transcriptRef）',
    '原 transcriptRef：' + shellQuote(transcriptRef),
    'session：' + report.sessionId,
  ];
  if (materialPath === null || options.materialized !== true) {
    lines.push('材料尚未由宿主写入 Utility 私有可写状态；先调用 prepareOpencodeRecoveryMaterial 生成，再让 Utility 读取。');
  } else {
    lines.push('材料 JSONL（每行一条消息，只读）：' + shellQuote(materialPath));
  }
  if (options.gap !== null && options.gap !== undefined) {
    lines.push('宿主缺口（材料覆盖只到该处，不当作完整结论）：' + options.gap.reason);
  }
  lines.push('禁止直读 opencode.db、禁止连接公开 API、禁止使用更宽权限；材料缺失或截断即按不可用阻塞。');
  return lines;
}

/**
 * 签发证据必须与本次实读逐项一致：事件范围、lastCompleteEventRef、coverage 与缺口都要相同，
 * 防止已签 partial 被静默升格为 complete，或范围漂移后仍签同一份材料。
 */
function evidenceMatchesCollection(
  evidence: TranscriptCoverageEvidence,
  collected: MessageCollection,
): boolean {
  const first = collected.events[0] ?? null;
  const last = collected.events.at(-1) ?? null;
  if (first === null || last === null) return false;
  if (first !== evidence.readableRange.fromEventRef || last !== evidence.readableRange.toEventRef) return false;
  if (evidence.lastCompleteEventRef !== last) return false;
  if (evidence.coverage === 'complete') {
    return collected.gap === null && evidence.gaps.length === 0;
  }
  if (collected.gap === null || evidence.gaps.length !== 1) return false;
  const signed = evidence.gaps[0];
  return signed !== undefined
    && signed.fromEventRef === collected.gap.fromEventRef
    && signed.toEventRef === collected.gap.toEventRef
    && signed.reason === collected.gap.reason;
}

/**
 * 在 Utility 私有可写根内生成有界派生转录材料。
 *
 * 宿主在沙箱外经公开 API 读取消息，验证事件范围与 expectedEvidence 完全一致后才写盘；范围不等、
 * 空材料或形状不可核验都返回 null。截断尾部作为 host gap 保留，不伪装成完整覆盖。
 */
export async function prepareOpencodeRecoveryMaterial(
  transcriptRef: string,
  writableRoot: string,
  expectedEvidence: TranscriptCoverageEvidence,
): Promise<readonly string[] | null> {
  const report = readSessionReportFile(transcriptRef);
  if (report === null) return null;
  if (!samePath(expectedEvidence.readableRange.transcriptRef, report.transcriptPath)) return null;
  if (!matchesCurrentNativeRoot(report.stateRoot, report.runtimeRoots)) return null;
  const collected = await collectMessages({
    executable: OPENCODE_HARNESS_ID,
    env: currentOpencodeEnv(),
    workspace: report.cwd,
    sessionId: report.sessionId,
  });
  if (!evidenceMatchesCollection(expectedEvidence, collected)) return null;

  const materialPath = opencodeRecoveryMaterialPath(writableRoot, transcriptRef);
  mkdirSync(join(materialPath, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(materialPath, collected.items.map((item) => JSON.stringify(item)).join('\n') + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  return opencodeRecoveryInstructions(transcriptRef, {
    writableRoot,
    materialized: true,
    gap: collected.gap,
  });
}

/** 应用层 WorkerHarness 端口实现；由 bootstrap registry 显式注册。 */
export const opencodeHarness: WorkerHarness = {
  id: OPENCODE_HARNESS_ID,
  prepareLaunch: (input) => createOpencodeWorkerLaunch(input),
  prepareReadOnlyLaunch: (input) => createOpencodeWorkerLaunch({ ...input, sandboxMode: 'read-only-local-control' }),
  probe: (modelSelection) => probeHarnessReadOnlyWorker(OPENCODE_HARNESS_ID, modelSelection),
  queryModels: (input) => queryWorkerModels({ ...input, harness: OPENCODE_HARNESS_ID }),
  prepareResume: (input) => createOpencodeResumeLaunch(input),
  sessionPaths: (companionStateRoot, launchId) => sessionPathsUnder(companionStateRoot, launchId),
  installReporter: (paths) => {
    // opencode 没有 hook/extension 上报通道：会话事实由 adapter 经公开 API 主动观察（pull），
    // 这里只保证报告目录存在于 Companion 工件区。
    mkdirSync(join(paths.reportPath, '..'), { recursive: true });
  },
  proveSession: (input) => proveOpencodeTranscript(input),
  inspectTranscript: (transcriptRef) => inspectOpencodeTranscript(transcriptRef),
};
