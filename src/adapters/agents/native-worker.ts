/**
 * 原生交互式 Worker Harness（claude / pi / omp）共用的 prepared-terminal 启动与 Session 证明。
 *
 * 与 Codex 同源：模型身份只来自不可变 `WorkerModelConfiguration`，秘密只经子进程环境进入 harness，
 * 公开 terminal 命令与非秘密 descriptor 只含路径。差异集中在每个 harness 自己的 pin 参数、状态根
 * 环境变量与 Session 报告机制，因此这里只保留一份启动骨架，三个 wrapper 只声明 harness 事实。
 *
 * 身份边界：报告里的 session id、transcript path、cwd 与隔离状态根必须与真实文件互相印证，
 * 不按 mtime、cwd slug 或「最近文件」降级匹配；pi/omp 的 transcript 只按**活动分支**读取，
 * 不把同文件里其它分支的条目当成同一次会话。
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';

import { z } from 'zod';

import type { PreparedTerminalStrategy } from '../../application/worker-launch.js';
import type { CredentialStore } from '../../application/ports/credential-store.js';
import type { TranscriptCoverageEvidence } from '../../application/recovery/recovery-capsule.js';
import { nativeWorkerConnectionSchema, scanModelOptionFields } from '../../domain/model-configuration.js';
import type { NativeWorkerConnection, WorkerModelConfiguration } from '../../domain/model-configuration.js';
import { credentialStorePath } from '../storage/credential-store.js';
import {
  CODEX_MODEL_DESCRIPTOR_VERSION,
  codexModelLaunchCommand,
  writeCodexModelLaunch,
} from './codex-model-launcher.js';
import type {
  CodexModelCredentialDescriptor,
  CodexModelLaunchDescriptor,
} from './codex-model-launcher.js';
import type {
  CodexTranscriptCoverageResult,
  CodexTranscriptProof,
  CodexTranscriptProofResult,
} from './codex-transcript.js';

/** 本模块承载的 harness 白名单（opencode 由独立 adapter 拥有），与领域判别联合分开收窄。 */
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

/** 与 Codex 同一形状的启动输入；`resume` 给出时必须能证明是原会话。 */
export type NativeWorkerLaunchInput = {
  readonly launchId: string;
  readonly modelConfiguration: Readonly<WorkerModelConfiguration>;
  /** 宿主（Bootstrap）注入，adapter 不按路径另建实例。 */
  readonly credentialStore: CredentialStore;
  /** 写入 descriptor 供 launcher 运行时读取的凭据文件位置；省略时按 XDG 推导。 */
  readonly credentialStorePath?: string;
  readonly sandboxMode: NativeWorkerSandboxMode;
  /** 状态根的父目录；省略时放在 Worker worktree 内。 */
  readonly stateRoot?: string;
  /** 宿主安装的 SessionStart reporter 绝对路径；extensions/hook 直接以它作为上报入口。 */
  readonly reporterPath?: string;
  /** 宿主指定的报告文件绝对路径；省略时由 reporterPath 派生同名 .jsonl。 */
  readonly reportPath?: string;
  /** 来源 auth 资产的目录（harness_login 才链接）；省略时按 harness 环境变量/默认家目录推导。 */
  readonly sourceHome?: string;
  /** 测试可指向 fake 可执行文件。 */
  readonly executable?: string;
  /**
   * 只读模式在写任何状态文件之前必须证明 bwrap 包装器可用；由宿主注入的可用性核验（与探针同源）。
   * 未注入时不额外阻塞，由宿主的装配路径负责；一旦注入且失败即 fail closed，不留现场。
   */
  readonly assertReadOnlyWrapperAvailable?: () => Promise<void>;
  /** 复用原会话：session 身份、原隔离状态根与精确 transcript 位置，缺一即拒绝。 */
  readonly resume?: {
    readonly sessionId: string;
    readonly stateRoot: string;
    readonly transcriptRef: string;
  };
};

const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 归一化后的宿主保留选项：模型、provider、会话身份、扩展入口与审批/沙箱开关只能由宿主决定。 */
const RESERVED_NATIVE_OPTION_KEYS: ReadonlySet<string> = new Set([
  'id',
  'modelid',
  'model',
  'provider',
  'apikey',
  'session',
  'sessionid',
  'sessiondir',
  'extension',
  'config',
  'settings',
  'hooks',
  'permission',
  'permissionmode',
  'approval',
  'approvalmode',
  'autoapprove',
  'sandbox',
  'fallbackmodel',
  'thinking',
]);

function normalizeOptionKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/gu, '');
}

function assertOptionsAreNotReserved(options: Readonly<Record<string, unknown>>): void {
  for (const key of Object.keys(options)) {
    const head = key.split('.')[0] ?? key;
    if (RESERVED_NATIVE_OPTION_KEYS.has(normalizeOptionKey(key)) || RESERVED_NATIVE_OPTION_KEYS.has(normalizeOptionKey(head))) {
      throw new Error('模型配置不能设置宿主保留的 native harness 选项：' + key);
    }
  }
}

/**
 * 启动前的 native 门禁，与 argv/env/状态文件生成共用同一套判断，且在写盘之前跑。
 *
 * `connection.nativeWorker` 的唯一事实源是领域的 `nativeWorkerConnectionSchema`；这里只做本模块
 * 白名单（claude/pi/omp）收窄，不另立一份 schema。
 */
export function assertLaunchableNativeModelConfiguration(
  configuration: Readonly<WorkerModelConfiguration>,
  harness: NativeHarness,
): NativeWorkerConnection {
  if (scanModelOptionFields(configuration, 'configuration', true).kind !== 'clean') {
    throw new Error('native 模型配置含秘密字段，拒绝启动');
  }
  const raw = (configuration.connection as { readonly nativeWorker?: unknown }).nativeWorker;
  const parsed = nativeWorkerConnectionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error('native Worker 启动需要合法的 connection.nativeWorker（harness/providerId/baseUrl/api）');
  }
  if (parsed.data.harness !== harness) {
    throw new Error(`native 模型配置声明的 harness 与启动 harness 不一致：${parsed.data.harness} != ${harness}`);
  }
  if (configuration.effort !== null && configuration.effortCapability === null) {
    throw new Error('native 模型配置设置了 effort 却没有可信能力来源，拒绝启动');
  }
  assertOptionsAreNotReserved(configuration.connection.modelOptions);
  assertOptionsAreNotReserved(configuration.modelOptions);
  return parsed.data;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function assertInsideWorktree(worktreePath: string, candidate: string): void {
  const child = relative(resolve(worktreePath), resolve(candidate));
  if (child.length === 0 || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`native 状态根必须位于 Worker worktree 内：${candidate}`);
  }
}

/** 每个 harness 的固定事实：可执行文件、状态根环境变量、来源目录与 harness_login auth 资产。 */
type HarnessSpec = {
  readonly executable: string;
  readonly stateEnvVar: string;
  readonly extraStateEnvVars: readonly string[];
  readonly defaultSourceDir: string;
  /** harness_login 时从来源目录链接进隔离状态根的 auth 资产；omp 的登录在 agent.db，不声明。 */
  readonly authAssets: readonly string[];
  /** harness_login 时从来源目录复制进隔离状态根的非秘密设置（模型别名等）。 */
  readonly settingsAssets: readonly string[];
};

const HARNESS_SPECS: Readonly<Record<NativeHarness, HarnessSpec>> = {
  claude: {
    executable: 'claude',
    stateEnvVar: 'CLAUDE_CONFIG_DIR',
    extraStateEnvVars: [],
    defaultSourceDir: join(homedir(), '.claude'),
    authAssets: ['.credentials.json'],
    // claude 的 settings 由 writeClaudeSettings 合并进显式 --settings 文件，不走原样复制。
    settingsAssets: [],
  },
  pi: {
    executable: 'pi',
    stateEnvVar: 'PI_CODING_AGENT_DIR',
    extraStateEnvVars: [],
    defaultSourceDir: join(homedir(), '.pi', 'agent'),
    authAssets: ['auth.json'],
    settingsAssets: ['settings.json'],
  },
  omp: {
    executable: 'omp',
    stateEnvVar: 'PI_CODING_AGENT_DIR',
    extraStateEnvVars: ['OMP_CODING_AGENT_DIR'],
    defaultSourceDir: join(homedir(), '.omp', 'agent'),
    // omp 18 的登录在 agent.db，隔离根内没有可复制的非秘密登录资产；harness_login 因此 fail closed。
    authAssets: [],
    settingsAssets: [],
  },
};

const NATIVE_MANAGED_CREDENTIAL_ENV = 'COMPANION_NATIVE_MANAGED_KEY';
const CLAUDE_MANAGED_CREDENTIAL_ENV = 'ANTHROPIC_AUTH_TOKEN';

function credentialEnvKey(harness: NativeHarness): string {
  return harness === 'claude' ? CLAUDE_MANAGED_CREDENTIAL_ENV : NATIVE_MANAGED_CREDENTIAL_ENV;
}

/** 确定性 UUID：同一 launch 的重放得到同一 session 身份，避免模型或调用方自选。 */
function deterministicUuid(seed: string): string {
  const hash = createHash('sha256').update(seed).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function reportPathFor(reporterPath: string): string {
  const name = basename(reporterPath).replace(/\.[^.]+$/u, '');
  return join(dirname(reporterPath), `${name}.jsonl`);
}

/**
 * 安装宿主控制的 SessionStart reporter。
 *
 * claude 用 shell hook（stdin JSON）；pi/omp 用进程内 extension（`session_start` 与 `turn_end`）。
 * pi/omp 的 session 文件到首次模型回合才落盘，因此两个事件都要上报，宿主按最新一条核验。
 * 报告只写身份事实，不回显任何 secret。
 */
export function installNativeSessionStartReporter(
  harness: NativeHarness,
  paths: { readonly stateRoot: string; readonly reporterPath: string; readonly reportPath: string },
): void {
  mkdirSync(dirname(paths.reporterPath), { recursive: true });
  const spec = HARNESS_SPECS[harness];
  const report = JSON.stringify(paths.reportPath);
  const stateEnv = JSON.stringify(spec.stateEnvVar);
  const harnessLiteral = JSON.stringify(harness);
  // 报告的隔离状态根：优先取 harness 子进程环境，未提供时退回宿主装配的精确根，绝不猜家目录。
  const homeExpr = `process.env[${stateEnv}] ?? ${JSON.stringify(paths.stateRoot)}`;
  const source = harness === 'claude'
    ? [
        "import { appendFileSync } from 'node:fs';",
        "let input = '';",
        'for await (const chunk of process.stdin) input += chunk;',
        'const event = JSON.parse(input);',
        `appendFileSync(${report}, JSON.stringify({`,
        `harness: ${harnessLiteral},`,
        'sessionId: event.session_id ?? null, transcriptPath: event.transcript_path ?? null,',
        `codexHome: ${homeExpr}, cwd: event.cwd ?? null,`,
        'observedAt: new Date().toISOString() }) + "\\n");',
        'process.stdout.write("{}\\n");',
        '',
      ].join('\n')
    : [
        "import { appendFileSync, existsSync, writeFileSync } from 'node:fs';",
        `const REPORT = ${report};`,
        `const STATE_ENV = ${stateEnv};`,
        `const FALLBACK_ROOT = ${JSON.stringify(paths.stateRoot)};`,
        `const HARNESS = ${harnessLiteral};`,
        'function report(ctx) {',
        '  const manager = ctx && ctx.sessionManager ? ctx.sessionManager : null;',
        "  const read = (name) => { try { const value = manager ? manager[name]() : null; return typeof value === 'string' && value.length > 0 ? value : null; } catch { return null; } };",
        '  let header = null;',
        '  try { header = manager ? manager.getHeader() : null; } catch { header = null; }',
        "  const sessionId = read('getSessionId');",
        "  const transcriptPath = read('getSessionFile');",
        "  const cwd = header && typeof header.cwd === 'string' ? header.cwd : null;",
        "  const observedAt = new Date().toISOString();",
        "  const leafId = read('getLeafId');",
        '  appendFileSync(REPORT, JSON.stringify({',
        '    harness: HARNESS, sessionId, transcriptPath,',
        '    codexHome: process.env[STATE_ENV] ?? FALLBACK_ROOT, cwd, observedAt, leafId }) + "\\n");',
        '  // 活动叶子写到精确 transcript 旁侧 sidecar（仅 metadata）：/tree 之类切换分支不会追加行，',
        '  // 恢复时只能靠这份精确 sidecar 确定活动分支，不能按文件最后一行或 mtime 猜。',
        '  if (transcriptPath !== null) {',
        '    try { writeFileSync(transcriptPath + ".companion-leaf.json", JSON.stringify({ harness: HARNESS, sessionId, leafId, cwd, observedAt })); } catch {}',
        '  }',
        '}',
        // session 文件到首次模型回合才落盘：session_start 时轮询 manager，最多等 10 秒再上报，
        // 免得宿主只看到一条没有 transcript 的报告而误判不可用。
        'function reportWhenOnDisk(ctx, remaining) {',
        '  let onDisk = null;',
        "  try { const manager = ctx && ctx.sessionManager ? ctx.sessionManager : null; onDisk = manager ? manager.getSessionFile() : null; } catch { onDisk = null; }",
        "  if (typeof onDisk === 'string' && onDisk.length > 0 && existsSync(onDisk)) { report(ctx); return; }",
        // 到点仍未落盘就不写行：报告里绝不出现 transcriptPath 为空的早期记录，
        // 免得读取方取到「首行空报告」而卡住。
        '  if (remaining <= 0) { return; }',
        '  setTimeout(() => { reportWhenOnDisk(ctx, remaining - 1); }, 250);',
        '}',
        'export default (pi) => {',
        ...(harness === 'omp' ? [
          "  pi.on('session_start', (_event, ctx) => { if (ctx.hasUI) ctx.ui.setTitle('OMP ready'); });",
          "  pi.on('agent_start', (_event, ctx) => { if (ctx.hasUI) ctx.ui.setTitle('OMP working'); });",
          "  pi.on('agent_end', (_event, ctx) => { if (ctx.hasUI) ctx.ui.setTitle('OMP ready'); });",
        ] : []),
        "  pi.on('session_start', (_event, ctx) => { reportWhenOnDisk(ctx, 40); });",
        "  pi.on('turn_end', (_event, ctx) => { reportWhenOnDisk(ctx, 0); });",
        "  pi.on('agent_end', (_event, ctx) => { reportWhenOnDisk(ctx, 40); });",
        "  pi.on('session_tree', (_event, ctx) => { reportWhenOnDisk(ctx, 0); });",
        "  pi.on('session_shutdown', (_event, ctx) => { reportWhenOnDisk(ctx, 0); });",
        '};',
        '',
      ].join('\n');
  if (!existsSync(paths.reporterPath) || readFileSync(paths.reporterPath, 'utf8') !== source) {
    writeFileSync(paths.reporterPath, source, 'utf8');
  }
}

type PreparedState = {
  readonly stateRoot: string;
  readonly native: NativeWorkerConnection;
  readonly spec: HarnessSpec;
  readonly reportPath: string;
  /** pi/omp 的自定义 provider/model 配置文件；claude 为 null。 */
  readonly modelsConfigPath: string | null;
};

function modelOptionRecord(configuration: Readonly<WorkerModelConfiguration>): Record<string, unknown> {
  return { ...configuration.connection.modelOptions, ...configuration.modelOptions };
}

/** pi/omp 的自定义 provider pin：baseUrl/api/apiKey 来自 nativeWorker，模型 id 与选项来自绑定。 */
function writeNativeModelsConfig(
  stateRoot: string,
  native: NativeWorkerConnection,
  configuration: Readonly<WorkerModelConfiguration>,
  envKey: string,
  fileName: string,
): string {
  const provider = {
    ...(native.baseUrl === undefined ? {} : { baseUrl: native.baseUrl }),
    ...(native.api === undefined ? {} : { api: native.api }),
    // 只写环境变量名，secret 由 launcher 在运行时注入；本函数只服务 managed 启动。
    apiKey: native.harness === 'pi' ? `$${envKey}` : envKey,
    models: [{ id: configuration.model, ...modelOptionRecord(configuration) }],
  };
  const path = join(stateRoot, fileName);
  const models = `${JSON.stringify({ providers: { [native.providerId]: provider } }, null, 2)}\n`;
  if (native.harness === 'omp') {
    writeFileSync(join(stateRoot, 'models.json'), models, 'utf8');
    // --config 是设置 overlay；模型 registry 独立读取 agent dir 的 models.json。
    writeFileSync(path, JSON.stringify({ startup: { setupWizard: false }, tui: { titleState: false } }) + '\n', 'utf8');
  } else {
    writeFileSync(path, models, 'utf8');
  }
  return path;
}

/**
 * claude 读取 settings 时不使用用户全局文件（`--setting-sources ''`），因此 D7 的「复制非秘密
 * settings 与模型 alias 映射」只能体现在这份显式 settings 里：先并入来源设置中非宿主保留、非秘密
 * 的键，再用固定模型选项与 hook 覆盖，宿主控制的权限/凭据入口绝不并入。
 */
const CLAUDE_SOURCE_SETTINGS_DENYLIST: ReadonlySet<string> = new Set([
  'hooks',
  'permissions',
  'env',
  'apikeyhelper',
  'awsauthrefresh',
  'awscredentialexport',
  'otelheadershelper',
  'forceloginmethod',
]);

/** 读取来源目录里可安全并入的非秘密 claude settings；文件缺失或非法即视为无可并入项。 */
function readClaudeSourceSettings(input: NativeWorkerLaunchInput, spec: HarnessSpec): Record<string, unknown> | null {
  if (input.modelConfiguration.connection.credential.kind !== 'harness_login') {
    return null;
  }
  const source = join(sourceHomeFor(input, spec), 'settings.json');
  if (!existsSync(source)) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(source, 'utf8'));
    if (!isRecord(parsed)) {
      return null;
    }
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!CLAUDE_SOURCE_SETTINGS_DENYLIST.has(key.toLowerCase().replace(/[-_\s]/gu, ''))) {
        kept[key] = value;
      }
    }
    return kept;
  } catch {
    return null;
  }
}

/** claude 的 settings 文件：来源非秘密设置 + 模型选项 + SessionStart hook。`--bare` 会跳过 hook。 */
function writeClaudeSettings(
  stateRoot: string,
  reporterPath: string | undefined,
  configuration: Readonly<WorkerModelConfiguration>,
  sourceSettings: Readonly<Record<string, unknown>> | null,
): string {
  const settings: Record<string, unknown> = { ...sourceSettings, ...modelOptionRecord(configuration) };
  settings['skipDangerousModePermissionPrompt'] = true;
  settings['permissions'] = { allow: [
    'Bash(orca orchestration check *)',
    'Bash(orca orchestration send *)',
    'Bash(orca orchestration worker-done *)',
    'Bash(orca orchestration worker-ask *)',
    'Bash(orca orchestration worker-escalate *)',
  ] };
  if (reporterPath !== undefined) {
    settings['hooks'] = {
      SessionStart: [{
        matcher: 'startup|resume',
        hooks: [{
          type: 'command',
          command: `${shellQuote(process.execPath)} ${shellQuote(reporterPath)}`,
          timeout: 10,
        }],
      }],
    };
  }
  const path = join(stateRoot, 'native-settings.json');
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return path;
}

/** 来源目录：显式 sourceHome 优先，其次该 harness 的环境变量，最后才是默认家目录。 */
function sourceHomeFor(input: NativeWorkerLaunchInput, spec: HarnessSpec): string {
  return resolve(input.sourceHome ?? process.env[spec.stateEnvVar] ?? spec.defaultSourceDir);
}

/**
 * harness_login 只复制显式来源的登录资产与非秘密设置（D7）；managed 一律不复制，避免既有登录抢在
 * env 注入的 key 之前生效。复制而非链接，隔离状态根因此自足。
 */
function linkHarnessLoginAuth(input: NativeWorkerLaunchInput, stateRoot: string, spec: HarnessSpec): void {
  if (input.modelConfiguration.connection.credential.kind !== 'harness_login') {
    return;
  }
  const sourceHome = sourceHomeFor(input, spec);
  for (const asset of [...spec.authAssets, ...spec.settingsAssets]) {
    const source = join(sourceHome, asset);
    const target = join(stateRoot, asset);
    if (!existsSync(source)) {
      continue;
    }
    // 只复制，不建符号链接：隔离状态根必须自足，且永不跟随指向用户全局资产的链接。
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
      throw new Error(`隔离 native auth 位置被意外的符号链接占用：${target}`);
    }
    const content = readFileSync(source);
    if (!existsSync(target) || !readFileSync(target).equals(content)) {
      copyFileSync(source, target);
    }
  }
}

function assertLaunchable(input: NativeWorkerLaunchInput, harness: NativeHarness): NativeWorkerConnection {
  if (input.launchId.length === 0) {
    throw new Error('native launchId 必须是非空字符串');
  }
  const native = assertLaunchableNativeModelConfiguration(input.modelConfiguration, harness);
  const credential = input.modelConfiguration.connection.credential;
  if (credential.kind === 'managed') {
    // store 必须由宿主注入：缺失即拒绝，绝不按路径另建实例或跳过校验。
    if (input.credentialStore === undefined) {
      throw new Error('native managed 凭据启动必须由 Bootstrap 注入 CredentialStore');
    }
    const read = input.credentialStore.read(credential.credentialRef);
    if (read.kind !== 'resolved') {
      throw new Error('native managed 凭据不可用：' + read.code);
    }
  }
  if (credential.kind === 'harness_login' && harness === 'omp') {
    // omp 的登录态在 agent.db，隔离状态根里没有可证明的 auth source；不猜、不静默无认证。
    throw new Error('omp harness_login 无法在隔离状态根证明 auth source；请为该角色使用 managed 凭据');
  }
  if (credential.kind === 'harness_login' && harness === 'pi' && (native.baseUrl !== undefined || native.api !== undefined)) {
    // 自定义 endpoint 的 pi provider 需要显式 key；harness_login 只证明登录态，无法证明该 provider 的接线。
    throw new Error('pi harness_login 不能与 nativeWorker.baseUrl/api 组合（无法证明自定义 provider 的认证来源）');
  }
  if (input.resume !== undefined) {
    if (!isAbsolute(input.resume.stateRoot)) {
      throw new Error('native resume 的原状态根必须是绝对路径：' + input.resume.stateRoot);
    }
    if (!SAFE_SESSION_ID.test(input.resume.sessionId)) {
      throw new Error('native resume session ID 形态非法，拒绝启动');
    }
  }
  return native;
}

/** 早期 fail closed 后，建立状态根并写出全部 harness 自己的非秘密状态文件。 */
function prepareState(
  input: NativeWorkerLaunchInput,
  harness: NativeHarness,
  native: NativeWorkerConnection,
  worktreePath: string,
): PreparedState {
  const digest = createHash('sha256').update(input.launchId).digest('hex').slice(0, 20);
  const stateRoot = input.resume !== undefined
    ? input.resume.stateRoot
    : input.stateRoot === undefined
      ? join(worktreePath, '.companion', harness, digest)
      : join(input.stateRoot, digest);
  if (input.resume === undefined && input.stateRoot === undefined) {
    assertInsideWorktree(worktreePath, stateRoot);
  }
  mkdirSync(stateRoot, { recursive: true });
  // 只读包装器把 /tmp 设成只读并跳过 tmpfs，因此只读角色需要状态根内的可写临时目录。
  if (isReadOnlyMode(input.sandboxMode)) {
    mkdirSync(join(stateRoot, 'tmp'), { recursive: true });
  }

  const spec = HARNESS_SPECS[harness];
  const reportPath = input.reportPath
    ?? (input.reporterPath === undefined ? join(stateRoot, 'session-start.jsonl') : reportPathFor(input.reporterPath));
  if (input.reporterPath !== undefined) {
    installNativeSessionStartReporter(harness, { stateRoot, reporterPath: input.reporterPath, reportPath });
  }
  linkHarnessLoginAuth(input, stateRoot, spec);
  if (harness === 'omp') mkdirSync(join(stateRoot, 'home'), { recursive: true });

  if (harness === 'claude') {
    const path = join(stateRoot, '.claude.json');
    const decoded: unknown = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
    if (!isRecord(decoded) || Array.isArray(decoded)) throw new Error('隔离 Claude 配置不可核验');
    const projects = isRecord(decoded['projects']) ? decoded['projects'] : {};
    const project = isRecord(projects[worktreePath]) ? projects[worktreePath] : {};
    writeFileSync(path, JSON.stringify({
      ...decoded,
      hasCompletedOnboarding: true,
      theme: 'dark',
      projects: { ...projects, [worktreePath]: { ...project, hasTrustDialogAccepted: true } },
    }) + '\n', { encoding: 'utf8', mode: 0o600 });
  }

  const managed = input.modelConfiguration.connection.credential.kind === 'managed';
  const modelsConfigPath = harness === 'claude'
    ? (writeClaudeSettings(stateRoot, input.reporterPath, input.modelConfiguration, readClaudeSourceSettings(input, spec)), null)
    // pi 从 agent dir 读 models.json；omp 用显式 --config，文件名不承载语义。
    // 只有 managed 才写自定义 provider；harness_login 依赖隔离根内复制的登录态与 argv 上的 pin。
    : managed
      ? writeNativeModelsConfig(
          stateRoot,
          native,
          input.modelConfiguration,
          credentialEnvKey(harness),
          harness === 'pi' ? 'models.json' : 'native-models.json',
        )
      : null;
  return { stateRoot, native, spec, reportPath, modelsConfigPath };
}

/** harness 自己的 pin 参数。只含非秘密值；秘密一律走环境变量。 */
function nativeArguments(
  harness: NativeHarness,
  input: NativeWorkerLaunchInput,
  prepared: PreparedState,
): readonly string[] {
  const { native, stateRoot } = prepared;
  const configuration = input.modelConfiguration;
  const reporter = input.reporterPath;
  const resume = input.resume;
  if (harness === 'claude') {
    const permissionArgs = input.sandboxMode === 'danger-full-access'
      ? ['--dangerously-skip-permissions']
      : input.sandboxMode === 'read-only' || input.sandboxMode === 'read-only-local-control'
        // 只读边界由 bwrap 保证；交互式 Worker 不能因审批提示挂起。
        ? ['--permission-mode', 'bypassPermissions']
        : ['--permission-mode', 'acceptEdits'];
    return [
      '--setting-sources', '', '--settings', join(stateRoot, 'native-settings.json'),
      '--model', 'opus',
      ...permissionArgs,
      // 新建会话固定确定性 UUID，resume 用原 UUID；两条路径都不经 picker/--continue。
      ...(resume === undefined
        ? ['--session-id', deterministicUuid(input.launchId)]
        : ['--resume', resume.sessionId]),
    ];
  }
  const common = [
    '--no-extensions',
    ...(reporter === undefined ? [] : ['--extension', reporter]),
    '--no-skills',
    '--session-dir', join(stateRoot, 'sessions'),
  ];
  if (harness === 'pi') {
    return [
      ...common,
      '--no-prompt-templates',
      ...(resume === undefined
        ? ['--session-id', deterministicUuid(input.launchId)]
        : ['--session', resume.transcriptRef]),
      '--provider', native.providerId,
      '--model', configuration.model,
      ...(configuration.effort === null ? [] : ['--thinking', configuration.effort]),
    ];
  }
  return [
    ...common,
    '--no-rules',
    ...(prepared.modelsConfigPath === null ? [] : ['--config', prepared.modelsConfigPath]),
    ...(resume === undefined ? [] : ['-r', resume.transcriptRef]),
    '--model', `${native.providerId}/${configuration.model}`,
    ...(configuration.effort === null ? [] : ['--thinking', configuration.effort]),
    '--auto-approve',
  ];
}

function nativeEnvironment(
  harness: NativeHarness,
  input: NativeWorkerLaunchInput,
  prepared: PreparedState,
): { readonly environment: Record<string, string>; readonly unsetEnvironment: readonly string[] } {
  const { native, spec, stateRoot } = prepared;
  const environment: Record<string, string> = { [spec.stateEnvVar]: stateRoot };
  if (harness === 'omp') {
    environment['HOME'] = join(stateRoot, 'home');
    environment['PI_CONFIG_DIR'] = '.omp';
  }
  for (const name of spec.extraStateEnvVars) {
    environment[name] = stateRoot;
  }
  if (isReadOnlyMode(input.sandboxMode)) {
    environment['TMPDIR'] = join(stateRoot, 'tmp');
  }
  if (harness === 'claude') {
    // 固定 opus 别名，再用 env 指向真实模型；模型身份因此只有一个事实源。
    environment['ANTHROPIC_DEFAULT_OPUS_MODEL'] = input.modelConfiguration.model;
    if (native.baseUrl !== undefined) {
      environment['ANTHROPIC_BASE_URL'] = native.baseUrl;
    }
  }
  // managed 时清掉可能抢在 token 之前生效的 harness key；harness_login 保持原样。
  const unsetEnvironment = [
    ...(input.modelConfiguration.connection.credential.kind === 'managed' && harness === 'claude' ? ['ANTHROPIC_API_KEY'] : []),
    ...(harness === 'omp' ? ['PI_PROFILE', 'OMP_PROFILE', 'PI_CONFIG_FILES'] : []),
  ];
  return { environment, unsetEnvironment };
}

function isReadOnlyMode(mode: NativeWorkerSandboxMode): boolean {
  return mode === 'read-only' || mode === 'read-only-local-control';
}

function nativeCredential(input: NativeWorkerLaunchInput, harness: NativeHarness): CodexModelCredentialDescriptor {
  const credential = input.modelConfiguration.connection.credential;
  if (credential.kind !== 'managed') {
    return { kind: 'harness_login' };
  }
  return {
    kind: 'managed',
    credentialRef: credential.credentialRef,
    envKey: credentialEnvKey(harness),
    storePath: input.credentialStorePath ?? credentialStorePath(),
  };
}

/** native harness 的共用 prepared-terminal 工厂；wrapper 只绑定 harness 名。 */
export function createNativeWorkerLaunch(
  harness: NativeHarness,
  input: NativeWorkerLaunchInput,
): PreparedTerminalStrategy<PreparedNativeTerminal> {
  const digest = createHash('sha256').update(input.launchId).digest('hex').slice(0, 20);
  const title = `orca-companion:${harness}${input.resume === undefined ? '' : '-resume'}:${digest}`;
  return {
    kind: 'prepared_terminal',
    harness,
    activation: 'submit_draft',
    title,
    prepare: async ({ worktreePath }) => {
      if (!isAbsolute(worktreePath)) {
        throw new Error(`native Worker worktree 必须是绝对路径：${worktreePath}`);
      }
      if (input.stateRoot !== undefined && !isAbsolute(input.stateRoot)) {
        throw new Error(`native 状态根必须是绝对路径：${input.stateRoot}`);
      }
      // 早期 fail closed 发生在任何写盘之前：缺凭据、保留选项与 harness 不匹配都不留现场。
      const native = assertLaunchable(input, harness);
      if (input.resume !== undefined) {
        const now = new Date().toISOString();
        const proof = proveNativeTranscript(harness, {
          report: {
            harness, sessionId: input.resume.sessionId, transcriptPath: input.resume.transcriptRef,
            codexHome: input.resume.stateRoot, cwd: worktreePath, observedAt: now,
          },
          workspace: worktreePath, expectedCodexHome: input.resume.stateRoot,
          dispatchStartedAt: now, bindingDeadlineAt: now,
        });
        if (proof.kind !== 'proven') throw new Error(`native resume 身份不可证明：${proof.reason}`);
      }
      // 只读角色必须先证明 bwrap 包装器可用，再写状态根；边界无法证明时不留下可启动现场。
      if (isReadOnlyMode(input.sandboxMode)) {
        await input.assertReadOnlyWrapperAvailable?.();
      }
      const prepared = prepareState(input, harness, native, worktreePath);
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
        codexHome: prepared.stateRoot,
        executable: input.executable ?? prepared.spec.executable,
        args: nativeArguments(harness, input, prepared),
        credential: nativeCredential(input, harness),
        ...nativeEnvironment(harness, input, prepared),
        ...(readOnly === undefined ? {} : { readOnly }),
      };
      const { descriptorPath, launcherPath } = writeCodexModelLaunch({
        codexHome: prepared.stateRoot,
        descriptor,
      });
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
  codexHome: z.string().nullable(),
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
  return path.length > 0 && path !== '..' && !path.startsWith(`..${sep}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

type TranscriptHeader = { readonly id: string; readonly cwd: string };

/**
 * 在读上限内逐行找出第一条承载会话身份的记录。
 *
 * pi/omp 的身份就在首行 `{type:'session', id, cwd}`；claude 的真实 transcript 首行常常是
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

/** pi/omp 的 session 文件落在隔离状态根的 sessions 目录下；claude 落在 projects 目录下。 */
function transcriptSubtree(harness: NativeHarness, codexHome: string): string {
  return join(codexHome, harness === 'claude' ? 'projects' : 'sessions');
}

/** 只按形状校验报告；任一必填身份缺失都由调用方按不可证明处理。 */
export function parseNativeSessionStartReport(report: unknown): NativeSessionStartReport | null {
  const parsed = nativeSessionStartReportSchema.safeParse(report);
  return parsed.success ? parsed.data : null;
}

export function proveNativeTranscript(
  harness: NativeHarness,
  input: {
    readonly report: unknown;
    readonly workspace: string;
    readonly expectedCodexHome: string;
    readonly dispatchStartedAt: string;
    readonly bindingDeadlineAt: string;
  },
): NativeTranscriptProofResult {
  const report = parseNativeSessionStartReport(input.report);
  if (report !== null && report.harness !== harness) {
    // 固定 adapter 不等于信任来源：报告必须自称同一 harness，否则不签发绑定。
    return unavailable(`SessionStart 报告的 harness 与本次派发不一致：${report.harness} != ${harness}`);
  }
  if (
    report === null ||
    report.sessionId === null ||
    report.transcriptPath === null ||
    report.codexHome === null ||
    report.cwd === null ||
    report.observedAt === null ||
    !SAFE_SESSION_ID.test(report.sessionId)
  ) {
    return unavailable('SessionStart 缺少可核验的 session ID、状态根、transcript path、cwd 或观察时间');
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
    const codexHome = realpathSync(report.codexHome);
    if (codexHome !== realpathSync(input.expectedCodexHome)) {
      return unavailable('报告状态根与本次派发的隔离状态根不一致');
    }
    const transcriptPath = realpathSync(report.transcriptPath);
    const workspace = realpathSync(input.workspace);
    if (!isInside(realpathSync(transcriptSubtree(harness, codexHome)), transcriptPath)) {
      return unavailable('transcript path 不在隔离状态根的会话目录内');
    }
    if (!basename(transcriptPath).endsWith(`${report.sessionId}.jsonl`)) {
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
  return typeof id === 'string' && id.length > 0 ? id : `line:${line}`;
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
 * 非法或 id 不符都返回 `null`（调用方随后 fail closed）。不按 mtime、不按文件顺序、不看其它文件。
 */
function readLeafSidecar(transcriptPath: string, headerId: string | null): string | null {
  if (headerId === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(`${transcriptPath}.companion-leaf.json`, 'utf8'));
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
 * pi/omp 的会话是树：同文件里可能有多个分支，只有从叶子沿 `parentId` 回溯得到的**活动分支**
 * 才属于本次会话。活动叶子优先取显式 `leafId`，其次取 transcript 旁侧的精确 sidecar（extension
 * 在每次上报时写出，仅 metadata）；两者都没有就不可用——文件最后一行可能是历史分支（/tree 切换
 * 分支不会追加行），按它读会静默读错历史。父链缺父或成环同样不可用。claude 是线性文件，逐行即全部。
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
      return partialEvidence(firstEventRef, lastCompleteEventRef, path, `line:${failedLine}`, 'invalid_json');
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
        return partialEvidence(branch[0] ?? null, branch.at(-1) ?? null, transcriptRef, `line:${line + 1}`, 'read_failed');
      }
    } else if (firstEventRef !== null && lastCompleteEventRef !== null) {
      return partialEvidence(firstEventRef, lastCompleteEventRef, transcriptRef, `line:${line + 1}`, 'read_failed');
    }
    return unavailable(error instanceof Error ? error.message : 'native transcript 读取失败');
  }
}

/**
 * 活动分支：从指定叶子（缺省为文件最后一个条目）沿 parentId 回溯到根。
 *
 * 叶子不在文件里、父链断裂（父 id 未出现）或成环都返回 `null`——这些都不是「少一点历史」，
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
 * 这必须随 harness 给出：pi/omp 的会话是带 `id`/`parentId` 的树，事件引用是条目 `id`，且只有从
 * 报告的活动叶子回溯得到的活动分支属于本次会话；claude 是线性 JSONL，事件引用是条目 `uuid`。
 * 通用的 Codex 配方（按 timestamp/ordinal 遍历全部行）在这里都会读错。
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
