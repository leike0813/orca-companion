/**
 * IP-05：OpenCode Worker Harness adapter（Owner: \`add-worker-harness-adapters\`）。
 *
 * OpenCode 没有 SessionStart hook 或进程内 extension：provider session 事实只经隔离
 * \`--standalone\` 私有子进程的公开 HTTP API 观察（\`GET /api/session\`、
 * \`GET /api/session/:sessionID/message\`）。本 adapter 因此是 pull 型：启动时把 bootstrap 状态
 * 写进可写的隔离状态根，观察/证明阶段再经公开 API 回读精确身份；不直读 SQLite，也不按终端输出猜。
 *
 * \`--standalone\` 的内部 server 用随机端口 + 随机密码，外部无法发现，因此统一经同一隔离 XDG 下的
 * 公开 CLI \`opencode api --standalone\` 访问（自行拉起私有 server，实测无需外部密码）。秘密只经子进程
 * 环境进入 opencode；隔离 config 只声明承载 key 的环境变量**名称**。
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

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
import {
  nativeWorkerConnectionSchema,
  scanModelOptionFields,
  type NativeWorkerConnection,
  type WorkerModelConfiguration,
} from '../../domain/model-configuration.js';
import { credentialStorePath } from '../storage/credential-store.js';
import { CODEX_MODEL_DESCRIPTOR_VERSION, codexModelLaunchCommand, writeCodexModelLaunch } from './codex-model-launcher.js';
import type { CodexModelCredentialDescriptor, CodexModelLaunchDescriptor } from './codex-model-launcher.js';
import { assertReadOnlyExecutionWrapperAvailable, probeHarnessReadOnlyWorker } from './read-only-execution-wrapper.js';

export const OPENCODE_HARNESS_ID = 'opencode';

/** managed 凭据承载变量「名称」；名称非秘密，可写进隔离 config 与 descriptor。 */
export const OPENCODE_MANAGED_CREDENTIAL_ENV = 'COMPANION_OPENCODE_MANAGED_KEY';

export const OPENCODE_CONFIG_FILENAME = 'opencode-config.json';

/** 会话状态报告（JSONL）：首行是未确认的 bootstrap 状态，后续每行是一次经公开 API 确认的观察。 */
export const OPENCODE_SESSION_REPORT_FILENAME = 'session-start.jsonl';

/** Utility 私有可写根内的派生转录材料目录。 */
export const OPENCODE_MATERIAL_DIR = 'opencode-recovery';

const MAX_API_BODY_BYTES = 8 * 1024 * 1024;
const API_TIMEOUT_MS = 30_000;
const SESSION_REPORT_MAX_BYTES = 64 * 1024;
const MAX_MATERIAL_BYTES = 4 * 1024 * 1024;

/** session 列表分页上限：候选唯一性只在穷尽窗口后成立。 */
const SESSION_LIST_PAGE_SIZE = 20;
const MAX_SESSION_LIST_PAGES = 3;

export const OPENCODE_MESSAGE_PAGE_SIZE = 50;
export const OPENCODE_MAX_MESSAGE_PAGES = 40;
export const OPENCODE_MAX_MESSAGE_EVENTS = 2_000;

const SAFE_SESSION_ID = /^ses[A-Za-z0-9_-]{3,}$/;

/** 宿主保留键：身份、权限与自动化开关由 Manifest 决定，不能被 modelOptions 改写。 */
const RESERVED_OPTION_KEYS: ReadonlySet<string> = new Set([
  'model', 'models', 'provider', 'apikey', 'session', 'sessionid', 'agent', 'variant',
  'config', 'plugin', 'plugins', 'permission', 'permissions', 'tool', 'tools',
  'auto', 'autoapprove', 'continue', 'fork', 'standalone', 'server', 'directory', 'prompt',
]);

function normalizeOptionKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/gu, '');
}

function assertOptionsAreNotReserved(options: Readonly<Record<string, unknown>>): void {
  for (const key of Object.keys(options)) {
    const head = key.split('.')[0] ?? key;
    if (RESERVED_OPTION_KEYS.has(normalizeOptionKey(key)) || RESERVED_OPTION_KEYS.has(normalizeOptionKey(head))) {
      throw new Error('模型配置不能设置宿主保留的 opencode 选项：' + key);
    }
  }
}

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
    throw new Error('opencode 状态根必须位于 Worker worktree 内：' + candidate);
  }
}

/** 启动前门禁；与 config/argv/env 生成共用同一判断，且在写盘之前跑。 */
export function assertLaunchableOpencodeModelConfiguration(
  configuration: Readonly<WorkerModelConfiguration>,
): NativeWorkerConnection & { readonly harness: 'opencode' } {
  if (scanModelOptionFields(configuration, 'configuration', true).kind !== 'clean') {
    throw new Error('opencode 模型配置含秘密字段，拒绝启动');
  }
  const raw = (configuration.connection as { readonly nativeWorker?: unknown }).nativeWorker;
  const parsed = nativeWorkerConnectionSchema.safeParse(raw);
  if (!parsed.success || parsed.data.harness !== 'opencode') {
    throw new Error('opencode 启动需要合法的 connection.nativeWorker（harness=opencode、providerId）');
  }
  // effort 只在 --model provider/model#variant 里表达，该映射未经运行时核验：宁可阻塞也不换模型。
  if (configuration.effort !== null) {
    throw new Error('opencode adapter 未核验 effort→variant 映射，拒绝带 effort 的启动');
  }
  assertOptionsAreNotReserved(configuration.connection.modelOptions);
  assertOptionsAreNotReserved(configuration.modelOptions);
  return parsed.data;
}

function modelOptionRecord(configuration: Readonly<WorkerModelConfiguration>): Record<string, unknown> {
  return { ...configuration.connection.modelOptions, ...configuration.modelOptions };
}

/** 隔离 XDG：data/config/cache/state 与测试 HOME 全部指向状态根。 */
function isolatedStateEnvironment(stateRoot: string): Record<string, string> {
  return {
    XDG_DATA_HOME: join(stateRoot, 'xdg', 'data'),
    XDG_CONFIG_HOME: join(stateRoot, 'xdg', 'config'),
    XDG_CACHE_HOME: join(stateRoot, 'xdg', 'cache'),
    XDG_STATE_HOME: join(stateRoot, 'xdg', 'state'),
    OPENCODE_TEST_HOME: join(stateRoot, 'home'),
    OPENCODE_CONFIG: join(stateRoot, OPENCODE_CONFIG_FILENAME),
  };
}

/** 必须剔除的用户侧环境：否则会连上用户后台 server 或覆盖隔离 config。 */
const UNSET_ENVIRONMENT = [
  'OPENCODE_PASSWORD',
  'OPENCODE_SERVER_PASSWORD',
  'OPENCODE_CONFIG_CONTENT',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_SERVER',
] as const;

/** 隔离 provider/model 声明；managed 只写承载 secret 的变量名（models.dev 的 env 语义）。 */
function opencodeProviderConfig(
  native: NativeWorkerConnection & { readonly harness: 'opencode' },
  configuration: Readonly<WorkerModelConfiguration>,
): Record<string, unknown> {
  const provider: Record<string, unknown> = {};
  if (native.api !== undefined) {
    provider['package'] = native.api === 'anthropic-messages'
      ? '@opencode/ai/providers/anthropic'
      : native.api === 'openai-responses'
        ? '@opencode/ai/providers/openai/responses'
        : '@opencode/ai/providers/openai/chat';
  }
  provider['settings'] = {
    ...(native.baseUrl === undefined ? {} : {
      baseURL: native.api === 'anthropic-messages' && !native.baseUrl.replace(/\/$/u, '').endsWith('/v1')
        ? native.baseUrl.replace(/\/$/u, '') + '/v1' : native.baseUrl,
    }),
    ...(configuration.connection.credential.kind === 'managed'
      ? { apiKey: '{env:' + OPENCODE_MANAGED_CREDENTIAL_ENV + '}' } : {}),
  };
  if (configuration.connection.credential.kind === 'managed') {
    provider['env'] = [OPENCODE_MANAGED_CREDENTIAL_ENV];
  }
  provider['models'] = { [configuration.model]: { settings: modelOptionRecord(configuration) } };
  // TUI 在 provider 插件尚未完成初始化时可能先选中环境中的其它 provider。
  // 原生 policy 收紧可用目录，避免这个初始化窗口导致模型回退。
  return {
    model: native.providerId + '/' + configuration.model,
    providers: { [native.providerId]: provider },
    permissions: [{ action: '*', resource: '*', effect: 'allow' }],
    experimental: {
      policies: [
        { action: 'provider.use', resource: '*', effect: 'deny' },
        { action: 'provider.use', resource: native.providerId, effect: 'allow' },
      ],
    },
  };
}

/** harness_login 只复制来源登录文件；managed 不复制，避免既有登录抢在 env 之前生效。 */
function copyHarnessLoginAuth(input: { readonly sourceDataHome?: string }, stateRoot: string): void {
  const sourceDataHome = resolve(
    input.sourceDataHome ?? process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share'),
  );
  mkdirSync(join(stateRoot, 'xdg', 'data', 'opencode'), { recursive: true });
  for (const asset of ['auth.json', 'account.json'] as const) {
    const source = join(sourceDataHome, 'opencode', asset);
    if (!existsSync(source)) continue;
    copyFileSync(source, join(stateRoot, 'xdg', 'data', 'opencode', asset));
  }
}

export type OpencodeExecutionInput = WorkerHarnessLaunchInput & {
  /** 测试可指向 fake opencode 可执行文件。 */
  readonly executable?: string;
  /** harness_login 的来源数据目录；省略时按 XDG_DATA_HOME/家目录推导。 */
  readonly sourceDataHome?: string;
  /** 只读启动前的包装器核验；省略时用真实 bwrap 探针。 */
  readonly assertReadOnlyWrapperAvailable?: () => Promise<void>;
};

export type OpencodeResumeInput = OpencodeExecutionInput & {
  readonly sessionId: string;
  readonly originalStateRoot: string;
  readonly transcriptRef: string;
};

/** 每行一条完整 JSON 的会话状态报告；超过上限时只保留最新一条。 */
function appendSessionReport(reportPath: string, value: unknown): void {
  mkdirSync(join(reportPath, '..'), { recursive: true });
  const line = JSON.stringify(value) + '\n';
  if (existsSync(reportPath) && statSync(reportPath).size > SESSION_REPORT_MAX_BYTES) {
    writeFileSync(reportPath, line, 'utf8');
    return;
  }
  appendFileSync(reportPath, line, 'utf8');
}

type PreparedState = {
  readonly stateRoot: string;
  readonly native: NativeWorkerConnection & { readonly harness: 'opencode' };
};

/** 早期 fail closed 后，建立状态根并写出全部非秘密状态文件。 */
function prepareState(
  input: OpencodeExecutionInput,
  worktreePath: string,
  sessionId: string,
  exactStateRoot: string | null,
): PreparedState {
  const native = assertLaunchableOpencodeModelConfiguration(input.modelConfiguration);
  // 状态根一律在 input.stateRoot（harness 级父目录）下再拼 digest，与其它注册项一致。
  const stateRoot = exactStateRoot ?? join(
    input.stateRoot ?? join(worktreePath, '.companion', 'opencode'),
    opencodeLaunchDigest(input.launchId),
  );
  if (exactStateRoot === null && input.stateRoot === undefined) {
    assertInsideWorktree(worktreePath, stateRoot);
  }

  for (const sub of [['xdg', 'data'], ['xdg', 'config'], ['xdg', 'cache'], ['xdg', 'state'], ['home']]) {
    mkdirSync(join(stateRoot, ...sub), { recursive: true });
  }
  writeFileSync(
    join(stateRoot, OPENCODE_CONFIG_FILENAME),
    JSON.stringify(opencodeProviderConfig(native, input.modelConfiguration), null, 2) + '\n',
    'utf8',
  );
  if (input.modelConfiguration.connection.credential.kind === 'harness_login') {
    copyHarnessLoginAuth(input, stateRoot);
  }

  // bootstrap 状态落在可写的隔离状态根里（read-only 包装器只把状态根与 tmp 绑定为可写）。
  const reportPath = join(stateRoot, OPENCODE_SESSION_REPORT_FILENAME);
  if (!existsSync(reportPath)) {
    appendSessionReport(reportPath, {
      harness: OPENCODE_HARNESS_ID,
      sessionId,
      transcriptPath: reportPath,
      stateRoot,
      cwd: resolve(worktreePath),
      observedAt: null,
    });
  }
  return { stateRoot, native };
}

function opencodeCredential(input: OpencodeExecutionInput): CodexModelCredentialDescriptor {
  const credential = input.modelConfiguration.connection.credential;
  if (credential.kind !== 'managed') {
    return { kind: 'harness_login' };
  }
  return {
    kind: 'managed',
    credentialRef: credential.credentialRef,
    envKey: OPENCODE_MANAGED_CREDENTIAL_ENV,
    storePath: input.credentialStorePath ?? credentialStorePath(),
  };
}

/** managed 启动只在准备阶段证明 key 存在；secret 由 launcher 运行时注入。 */
function assertManagedCredentialResolvable(input: OpencodeExecutionInput): void {
  const credential = input.modelConfiguration.connection.credential;
  if (credential.kind !== 'managed') return;
  if (input.credentialStore === undefined) {
    throw new Error('opencode managed 凭据启动必须由 Bootstrap 注入 CredentialStore');
  }
  const read = input.credentialStore.read(credential.credentialRef);
  if (read.kind !== 'resolved') {
    throw new Error('opencode managed 凭据不可用：' + read.code);
  }
}

function buildLaunch(input: {
  readonly execution: OpencodeExecutionInput;
  readonly title: string;
  readonly worktreePath: string;
  readonly sessionId: string;
  readonly exactStateRoot: string | null;
}): PreparedHarnessTerminal {
  const { execution } = input;
  assertManagedCredentialResolvable(execution);
  const prepared = prepareState(execution, input.worktreePath, input.sessionId, input.exactStateRoot);
  const readOnly = execution.sandboxMode === 'read-only' || execution.sandboxMode === 'read-only-local-control'
    ? { stateRoot: prepared.stateRoot, workspace: input.worktreePath, reportDirectory: prepared.stateRoot }
    : undefined;
  const descriptor: CodexModelLaunchDescriptor = {
    version: CODEX_MODEL_DESCRIPTOR_VERSION,
    codexHome: prepared.stateRoot,
    executable: execution.executable ?? OPENCODE_HARNESS_ID,
    // mini 通过公开 --model 绑定 Session，避免完整 TUI 在目录初始化时重选默认模型。
    args: ['mini', '--standalone', '--model', prepared.native.providerId + '/' + execution.modelConfiguration.model,
      '--session', input.sessionId],
    credential: opencodeCredential(execution),
    environment: isolatedStateEnvironment(prepared.stateRoot),
    unsetEnvironment: [...UNSET_ENVIRONMENT],
    ...(readOnly === undefined ? {} : { readOnly }),
  };
  // 复用 Codex 的 self-contained launcher：注入 managed secret、透传信号与退出码。
  const { descriptorPath, launcherPath } = writeCodexModelLaunch({
    codexHome: prepared.stateRoot,
    descriptor,
  });
  return {
    title: input.title,
    stateRoot: prepared.stateRoot,
    command: codexModelLaunchCommand({ launcherPath, descriptorPath }),
  };
}

async function assertReadOnlyReady(execution: OpencodeExecutionInput): Promise<void> {
  if (execution.sandboxMode !== 'read-only' && execution.sandboxMode !== 'read-only-local-control') return;
  await (execution.assertReadOnlyWrapperAvailable ?? assertReadOnlyExecutionWrapperAvailable)();
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
        throw new Error('opencode 状态根必须是绝对路径：' + input.stateRoot);
      }
      await assertReadOnlyReady(input);
      const prepared = buildLaunch({ execution: input, title, worktreePath, sessionId, exactStateRoot: null });
      const native = assertLaunchableOpencodeModelConfiguration(input.modelConfiguration);
      const created = await runOpencodeApi({
        executable: input.executable ?? OPENCODE_HARNESS_ID,
        stateRoot: prepared.stateRoot,
        workspace: worktreePath,
        args: ['POST', '/api/session', '--data', JSON.stringify({
          id: sessionId, location: { directory: worktreePath },
          model: { providerID: native.providerId, id: input.modelConfiguration.model },
        })],
      });
      const response = created.ok ? parseJson(created.stdout) : null;
      const session = isRecord(response) ? response['data'] : null;
      const metadata = parseSessionItem(session);
      const model = isRecord(session) ? session['model'] : null;
      if (metadata?.id !== sessionId || !samePath(metadata.directory, worktreePath)
        || !isRecord(model) || model['id'] !== input.modelConfiguration.model || model['providerID'] !== native.providerId) {
        throw new Error('opencode 精确 Session/model 未由公开 API 确认，拒绝启动');
      }
      appendSessionReport(join(prepared.stateRoot, OPENCODE_SESSION_REPORT_FILENAME), {
        harness: OPENCODE_HARNESS_ID, sessionId,
        transcriptPath: join(prepared.stateRoot, OPENCODE_SESSION_REPORT_FILENAME),
        stateRoot: prepared.stateRoot, cwd: worktreePath, observedAt: new Date().toISOString(),
      });
      return prepared;
    },
  };
}

/**
 * 复用原 Session：同一隔离状态根 + 原 exact session id。
 * 绝不用 --continue、picker 或最近会话；新 session 由 Recovery 的正常路径创建。
 */
export function createOpencodeResumeLaunch(
  input: OpencodeResumeInput,
): PreparedTerminalStrategy<PreparedHarnessTerminal> {
  if (input.launchId.length === 0) {
    throw new Error('opencode launchId 必须是非空字符串');
  }
  if (!isAbsolute(input.originalStateRoot)) {
    throw new Error('opencode resume 的原状态根必须是绝对路径：' + input.originalStateRoot);
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
      const report = readSessionReportFile(input.transcriptRef);
      if (report === null || report.sessionId !== input.sessionId
        || !samePath(report.stateRoot, input.originalStateRoot) || !samePath(report.cwd, worktreePath)) {
        throw new Error('opencode resume 原 Session 身份不可证明');
      }
      const original = await findUniqueSession({
        executable: input.executable ?? OPENCODE_HARNESS_ID,
        stateRoot: input.originalStateRoot, workspace: worktreePath, sessionId: input.sessionId,
      });
      if (!original.ok) throw new Error('opencode resume 原 Session 不可用：' + original.reason);
      await assertReadOnlyReady(input);
      const prepared = buildLaunch({
        execution: input,
        title,
        worktreePath,
        sessionId: input.sessionId,
        exactStateRoot: resolve(input.originalStateRoot),
      });
      appendSessionReport(input.transcriptRef, {
        ...report, observedAt: new Date().toISOString(),
      });
      return prepared;
    },
  };
}

/**
 * 每个 launch 的稳定私有命名空间：stateRoot 是 harness 级父目录（实际状态根在其下按 digest 取），
 * 报告路径已拼好 digest，指向实际状态根内的 JSONL 会话状态报告。
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
  readonly cwd: string;
  readonly observedAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function unavailable(reason: string): { readonly kind: 'transcript_unavailable'; readonly reason: string } {
  return { kind: 'transcript_unavailable', reason };
}

function instant(value: string | null): number | null {
  if (value === null || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

function isInside(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path.length > 0 && path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
}

type CliResult =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** 公开 CLI 调用；输出有界、超时可控，失败只报告固定 code。 */
function runOpencodeApi(input: {
  readonly executable: string;
  readonly stateRoot: string;
  readonly workspace: string;
  readonly args: readonly string[];
}): Promise<CliResult> {
  return new Promise((resolveResult) => {
    const env = { ...process.env, ...isolatedStateEnvironment(input.stateRoot) };
    for (const name of UNSET_ENVIRONMENT) delete env[name];
    execFile(
      input.executable,
      ['api', '--standalone', ...input.args],
      {
        cwd: input.workspace,
        env,
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

/** 只承认规范的 \`{data: [], cursor: {previous, next}}\` 形状；形状不符即不可核验。 */
function parseSessionListEnvelope(value: unknown): { readonly items: readonly unknown[]; readonly next: string | null } | null {
  if (!isRecord(value) || !Array.isArray(value['data'])) return null;
  const cursor = value['cursor'];
  if (!isRecord(cursor)) return null;
  const previous = cursor['previous'];
  const next = cursor['next'];
  if (previous !== undefined && previous !== null && typeof previous !== 'string') return null;
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

/** v2 消息条目是 \`{info:{id}, parts:[...]}\`；缺失事件引用即不可读。 */
function messageEventRef(item: unknown): string | null {
  if (!isRecord(item)) return null;
  const info = item['info'];
  const id = isRecord(info) ? info['id'] : item['id'];
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * 经公开 \`GET /api/session\`（\`{data, cursor:{previous,next}}\`）在有界窗口内确认唯一候选。
 * 窗口未穷尽、候选不为 1、directory 不符或 cursor 循环都判不可核验。
 */
async function findUniqueSession(input: {
  readonly executable: string;
  readonly stateRoot: string;
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
      stateRoot: input.stateRoot,
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

/** 报告文件里的一条可核验会话状态；bootstrap 行的 observedAt 为 null。 */
type SessionReportFile = {
  readonly harness: 'opencode';
  readonly sessionId: string;
  readonly transcriptPath: string;
  readonly stateRoot: string;
  readonly cwd: string;
  readonly observedAt: string | null;
};

/** 读最后一条可核验记录；bootstrap 行与确认行共用同一文件与形状。 */
function parseSessionReportLine(parsed: unknown): SessionReportFile | null {
  if (!isRecord(parsed)) return null;
  const { harness, sessionId, transcriptPath, stateRoot, cwd, observedAt } = parsed;
  return harness === OPENCODE_HARNESS_ID
    && typeof sessionId === 'string' && SAFE_SESSION_ID.test(sessionId)
    && typeof transcriptPath === 'string' && transcriptPath.length > 0
    && typeof stateRoot === 'string' && stateRoot.length > 0
    && typeof cwd === 'string' && cwd.length > 0
    && (observedAt === null || typeof observedAt === 'string')
    ? { harness: OPENCODE_HARNESS_ID, sessionId, transcriptPath, stateRoot, cwd, observedAt }
    : null;
}

/**
 * 只认**最新一条非空行**：最新行解析或 schema 失败即 null，不回落旧行；任何其它有效行出现不同
 * session ID 都表示多候选，同样 fail closed。
 */
function readSessionReportFile(path: string): SessionReportFile | null {
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

/** 经公开 API 观察一次本次派发的 session，并把确认记录追加到可写的隔离状态根。 */
export async function observeOpencodeSession(input: {
  readonly stateRoot: string;
  readonly workspace: string;
  readonly sessionId: string;
  readonly executable?: string;
}): Promise<{ readonly kind: 'observed'; readonly report: OpencodeSessionReport }
  | { readonly kind: 'unavailable'; readonly reason: string }> {
  if (!SAFE_SESSION_ID.test(input.sessionId)) {
    return { kind: 'unavailable', reason: 'opencode session ID 形态非法' };
  }
  const found = await findUniqueSession({
    executable: input.executable ?? OPENCODE_HARNESS_ID,
    stateRoot: input.stateRoot,
    workspace: input.workspace,
    sessionId: input.sessionId,
  });
  if (!found.ok) return { kind: 'unavailable', reason: found.reason };
  const report: OpencodeSessionReport = {
    harness: OPENCODE_HARNESS_ID,
    sessionId: input.sessionId,
    transcriptPath: join(input.stateRoot, OPENCODE_SESSION_REPORT_FILENAME),
    stateRoot: input.stateRoot,
    cwd: resolve(found.session.directory),
    observedAt: new Date().toISOString(),
  };
  appendSessionReport(report.transcriptPath, report);
  return { kind: 'observed', report };
}

/**
 * 证明一次 opencode Session：报告、隔离状态根、workspace、时间窗与公开 API 事实必须一致。
 * \`observedAt\` 缺失（bootstrap）时取本次真实观察时刻；任何不一致都判不可用。
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
  const expectedRoot = resolve(input.expectedStateRoot);
  const reportRoot = report.stateRoot ?? report.codexHome ?? null;
  if (reportRoot === null || !samePath(reportRoot, expectedRoot)) {
    return unavailable('报告状态根与本次派发的隔离状态根不一致');
  }
  const transcriptPath = report.transcriptPath ?? join(expectedRoot, OPENCODE_SESSION_REPORT_FILENAME);
  if (!isInside(expectedRoot, transcriptPath)) {
    return unavailable('报告 transcript path 不在隔离状态根内');
  }
  if (!samePath(cwd, input.workspace)) {
    return unavailable('报告 cwd 与绑定 workspace 不一致');
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
    stateRoot: expectedRoot,
    workspace: input.workspace,
    sessionId,
  });
  if (!found.ok) return unavailable(found.reason);
  appendSessionReport(transcriptPath, {
    harness: OPENCODE_HARNESS_ID,
    sessionId,
    transcriptPath,
    stateRoot: expectedRoot,
    cwd: resolve(found.session.directory),
    observedAt,
  });
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
  const found = await findUniqueSession({
    executable: OPENCODE_HARNESS_ID,
    stateRoot: report.stateRoot,
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
  readonly stateRoot: string;
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
      stateRoot: input.stateRoot,
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
  const collected = await collectMessages({
    executable: OPENCODE_HARNESS_ID,
    stateRoot: report.stateRoot,
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
  return "'" + value.replaceAll("'", "'\\''") + "'";
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
  const collected = await collectMessages({
    executable: OPENCODE_HARNESS_ID,
    stateRoot: report.stateRoot,
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
  probe: (configuration) => probeHarnessReadOnlyWorker(configuration),
  prepareResume: (input) => createOpencodeResumeLaunch(input),
  sessionPaths: (companionStateRoot, launchId) => sessionPathsUnder(companionStateRoot, launchId),
  installReporter: (paths) => {
    // opencode 没有 hook/extension 上报通道：会话事实由 adapter 经公开 API 主动观察（pull），
    // 这里只保证报告目录存在于可写的隔离状态根。
    mkdirSync(join(paths.reportPath, '..'), { recursive: true });
  },
  proveSession: (input) => proveOpencodeTranscript(input),
  inspectTranscript: (transcriptRef) => inspectOpencodeTranscript(transcriptRef),
};
