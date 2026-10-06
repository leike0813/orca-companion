/**
 * IP-15 真实隔离验收支持（change: add-worker-harness-adapters）。
 *
 * 只由公开 API 组成：应用层 prepareWorkerLaunch/activatePreparedWorker/verifyPreparedWorker，
 * bootstrap 的 workerSessionPathsUnder/installHarnessSessionReporter/prepareHarnessWorkerLaunch/
 * prepareHarnessResumeLaunch/bindHarnessSessionFromStartReport，注册表的 inspectTranscript。
 *
 * 隔离事实：一次性 Git 项目建在显式隔离目录（默认 /var/tmp，因为只读包装器隐藏 /tmp），
 * 专用协调终端提供唯一 Orca 身份并自建 Run，结束整体删除。
 *
 * 凭据边界：secret 只从进程环境（.env.smoke 与既有 harness 环境）或非数据库的本机配置读入，
 * 写进隔离 CredentialStore；不打开任何 harness SQLite、不打印 secret、不改写用户全局配置。
 * omp 显式复用同一 MiniMax provider 端点的 managed key，来源在证据里如实标注。
 *
 * 报告边界：任何 harness 的 SessionStart 报告都经运行时 schema 映射为结构化 HarnessSessionReport
 * （缺字段为 null），不做裸类型断言。
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readRecord } from '../../src/adapters/orca-cli/operation-catalog.js';
import { createOrcaExecutionBackend } from '../../src/adapters/orca-cli/orca-backend.js';
import { runProcess } from '../../src/adapters/orca-cli/process-runner.js';
import { JsonCredentialStore, credentialStorePath } from '../../src/adapters/storage/credential-store.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  DispatchId,
  OperationId,
  RuntimeIncarnationId,
  WorkerTaskId,
} from '../../src/application/dto/identity.js';
import type { CredentialStore } from '../../src/application/ports/credential-store.js';
import type { ExecutionBackend, ExecutionScope } from '../../src/application/ports/execution-backend.js';
import { buildExecutionScope } from '../../src/application/ports/execution-backend.js';
import type { HarnessSessionReport, WorkerHarnessLaunchInput } from '../../src/application/ports/worker-harness.js';
import {
  activatePreparedWorker,
  prepareWorkerLaunch,
  verifyPreparedWorker,
} from '../../src/application/worker-launch.js';
import {
  bindHarnessSessionFromStartReport,
  installHarnessSessionReporter,
  prepareHarnessResumeLaunch,
  prepareHarnessWorkerLaunch,
  requireWorkerHarness,
  readLatestHarnessSessionReport,
  workerHarnessRegistry,
  workerSessionPathsUnder,
  resumeSessionPathsUnder,
} from '../../src/bootstrap/worker-harness.js';
import { prepareOpencodeRecoveryMaterial, opencodeRecoveryMaterialPath } from '../../src/adapters/agents/opencode-harness.js';
import type { NativeWorkerApi, NativeWorkerConnection, WorkerModelConfiguration } from '../../src/domain/model-configuration.js';
import { toChildEnvironment } from '../../src/interfaces/cli/main.js';

import { REAL_ENV_FILE_VAR, mergeRealEnvFileIntoProcess } from './real-env.js';

export const REAL_ACCEPTANCE_SWITCH = 'ORCA_COMPANION_REAL_ACCEPTANCE';
export const REAL_ACCEPTANCE_BASE_VAR = 'ORCA_COMPANION_REAL_ACCEPTANCE_BASE';
export const REAL_ACCEPTANCE_HARNESSES_VAR = 'ORCA_COMPANION_REAL_ACCEPTANCE_HARNESSES';
export const REAL_ACCEPTANCE_ROLES_VAR = 'ORCA_COMPANION_REAL_ACCEPTANCE_ROLES';
/** 置 1 时失败也保留现场（不 stop/release、不关终端、不删目录），仅供人工只读排错。 */
export const REAL_ACCEPTANCE_KEEP_VAR = 'ORCA_COMPANION_REAL_ACCEPTANCE_KEEP';

/** 默认隔离基目录：/tmp 被只读包装器隐藏，真实运行必须放在这里。 */
export const DEFAULT_ACCEPTANCE_BASE = '/var/tmp';
const DEFAULT_ACCEPTANCE_ENV_FILE = join(fileURLToPath(new URL('../../', import.meta.url)), '.env.smoke');

const WORKER_START_TIMEOUT_MS = 300_000;
const REPORT_DEADLINE_MS = 180_000;
const SETTLE_DEADLINE_MS = 480_000;

export const ACCEPTANCE_HARNESSES = ['claude', 'opencode', 'pi', 'omp'] as const;
export type AcceptanceHarnessId = (typeof ACCEPTANCE_HARNESSES)[number];
export const ACCEPTANCE_ROLES = ['planner', 'implementation', 'validator', 'finalizer'] as const;
export type AcceptanceRole = (typeof ACCEPTANCE_ROLES)[number];

export type HarnessBinding = {
  readonly harness: AcceptanceHarnessId;
  readonly model: string;
  readonly providerId: string;
  readonly api: NativeWorkerApi;
  readonly baseUrl: string;
};

/** 用户固定的四个绑定：pi 用 MiniMax-M3，其余用 MiniMax-M3.1-Flash-Preview（逐字断言）。 */
export const HARNESS_MATRIX: readonly HarnessBinding[] = [
  { harness: 'claude', model: 'MiniMax-M3.1-Flash-Preview', providerId: 'minimax', api: 'anthropic-messages', baseUrl: 'https://api.minimax.cn/anthropic' },
  { harness: 'opencode', model: 'MiniMax-M3.1-Flash-Preview', providerId: 'minimax-cn-coding-plan', api: 'anthropic-messages', baseUrl: 'https://api.minimax.cn/anthropic' },
  { harness: 'pi', model: 'MiniMax-M3', providerId: 'minimax-cn', api: 'anthropic-messages', baseUrl: 'https://api.minimax.cn/anthropic' },
  { harness: 'omp', model: 'MiniMax-M3.1-Flash-Preview', providerId: 'minimax-code-cn', api: 'anthropic-messages', baseUrl: 'https://api.minimax.cn/anthropic' },
];

export type AcceptancePlan =
  | { readonly kind: 'skip'; readonly reason: string }
  | {
      readonly kind: 'run';
      readonly baseDir: string;
      readonly identity: string;
      readonly envFile: string;
      readonly harnesses: readonly AcceptanceHarnessId[];
      readonly roles: readonly AcceptanceRole[];
      readonly baseUrl: string;
    };

/** 未显式开启时只返回 skip，且不建目录、不读凭据、不访问 Orca；没有静默默认门。 */
export function resolveAcceptancePlan(env: Readonly<Record<string, string | undefined>> = process.env): AcceptancePlan {
  if (env[REAL_ACCEPTANCE_SWITCH] !== '1') {
    return { kind: 'skip', reason: REAL_ACCEPTANCE_SWITCH + ' 未显式开启' };
  }
  const harnesses = parseSelection(env[REAL_ACCEPTANCE_HARNESSES_VAR], ACCEPTANCE_HARNESSES, REAL_ACCEPTANCE_HARNESSES_VAR);
  const roles = parseSelection(env[REAL_ACCEPTANCE_ROLES_VAR], ACCEPTANCE_ROLES, REAL_ACCEPTANCE_ROLES_VAR);
  const envBaseUrl = (env['COORDINATOR_SMOKE_ANTHROPIC_BASE_URL'] ?? '').trim();
  return {
    kind: 'run',
    baseDir: resolve(env[REAL_ACCEPTANCE_BASE_VAR] ?? DEFAULT_ACCEPTANCE_BASE),
    // 并发独立跑时身份必须逐跑唯一，避免共享 Run/协调终端；选择集稳定，故身份可复现。
    identity: 'companion-harness-matrix-' + harnesses.join('-'),
    envFile: env[REAL_ENV_FILE_VAR] ?? DEFAULT_ACCEPTANCE_ENV_FILE,
    harnesses,
    roles,
    baseUrl: envBaseUrl.length > 0 ? envBaseUrl : HARNESS_MATRIX[0]?.baseUrl ?? '',
  };
}

function parseSelection<T extends string>(raw: string | undefined, allowed: readonly T[], varName: string): readonly T[] {
  const value = (raw ?? '').trim();
  if (value.length === 0) return allowed;
  const parts = value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  const selected = parts.filter((entry): entry is T => (allowed as readonly string[]).includes(entry));
  if (selected.length !== parts.length) {
    throw new Error(varName + ' 含不可识别的取值：' + parts.join(', '));
  }
  return selected;
}

/** 未开启时可观察形式：三个标记都只在真实路径里被置位。 */
export const ACCEPTANCE_DIAGNOSTICS = { credentialsRead: false, orcaMutated: false, harnessLaunched: false };

export class AcceptanceBlocker extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'AcceptanceBlocker';
  }
}

/** 拒绝把真实 harness 跑在 Companion 自身仓库、其上级目录或混入非本次产物的工作区；只读，不建目录。 */
export function assertIsolatedWorkspace(workspace: string, allowedEntries: ReadonlySet<string>): void {
  const companion = resolve(fileURLToPath(new URL('../../', import.meta.url)));
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
    throw new Error('隔离工作区不是存在的目录：' + workspace);
  }
  if (workspace === companion) {
    throw new Error('隔离工作区指向 Companion 自身仓库：' + workspace);
  }
  if (companion.startsWith(workspace + '/')) {
    throw new Error('隔离工作区是 Companion 的上级目录：' + workspace);
  }
  const unexpected = readdirSync(workspace).filter((name) => !allowedEntries.has(name));
  if (unexpected.length > 0) {
    throw new Error('隔离工作区混入非本次产物（只允许 ' + [...allowedEntries].join(', ') + '）：' + unexpected.join(', '));
  }
}

// ---------------------------------------------------------------------------------------------
// 凭据：只读进程环境与非数据库本机配置，写进隔离 store
// ---------------------------------------------------------------------------------------------

type CredentialSource = { readonly secret: string; readonly source: string };

function claudeSettingsToken(): string | null {
  const path = join(homedir(), '.claude', 'settings.json');
  if (!existsSync(path)) return null;
  try {
    const parsed = readRecord(JSON.parse(readFileSync(path, 'utf8')));
    const env = parsed === undefined ? undefined : readRecord(parsed['env']);
    if (env === undefined) return null;
    for (const key of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
      const value = env[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
    return null;
  } catch {
    return null;
  }
}

function opencodeAuthToken(): string | null {
  const path = join(homedir(), '.local', 'share', 'opencode', 'auth.json');
  if (!existsSync(path)) return null;
  try {
    const parsed = readRecord(JSON.parse(readFileSync(path, 'utf8')));
    const entry = parsed === undefined ? undefined : readRecord(parsed['minimax-cn-coding-plan']);
    const key = entry === undefined ? undefined : entry['key'];
    return typeof key === 'string' && key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

/** 共享的 MiniMax managed key：进程环境优先，其次非数据库的本机 claude 登录态。 */
function sharedMinimaxCredential(): CredentialSource | null {
  for (const name of ['MINIMAX_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'COORDINATOR_SMOKE_API_KEY']) {
    const value = process.env[name];
    if (typeof value === 'string' && value.length > 0) return { secret: value, source: 'env:' + name };
  }
  const claude = claudeSettingsToken();
  return claude === null ? null : { secret: claude, source: 'claude-settings' };
}

/** omp 不读 agent.db：优先 MINIMAX_API_KEY，否则复用同一 MiniMax 端点的 managed key。 */
function resolveHarnessCredential(harness: AcceptanceHarnessId): CredentialSource {
  if (harness === 'opencode') {
    const token = opencodeAuthToken();
    if (token !== null) return { secret: token, source: 'opencode-auth' };
    const shared = sharedMinimaxCredential();
    if (shared !== null) return { secret: shared.secret, source: 'shared-minimax:' + shared.source };
    throw new AcceptanceBlocker('credential_unavailable', 'opencode 没有可用的本机凭据来源');
  }
  if (harness === 'claude') {
    const token = process.env['ANTHROPIC_AUTH_TOKEN'] ?? process.env['ANTHROPIC_API_KEY'];
    if (typeof token === 'string' && token.length > 0) return { secret: token, source: 'env:ANTHROPIC_AUTH_TOKEN' };
  }
  if (harness === 'pi' || harness === 'omp') {
    const direct = process.env['MINIMAX_API_KEY'];
    if (typeof direct === 'string' && direct.length > 0) return { secret: direct, source: 'env:MINIMAX_API_KEY' };
  }
  const shared = sharedMinimaxCredential();
  if (shared === null) throw new AcceptanceBlocker('credential_unavailable', harness + ' 没有可用的本机凭据来源');
  return { secret: shared.secret, source: 'shared-minimax:' + shared.source };
}

export type ResolvedCredential = { readonly credentialRef: string; readonly source: string };

export function createCredentialStore(directory: string): CredentialStore {
  return new JsonCredentialStore({ path: join(directory, 'credentials.json') });
}

/** 同一次运行内按 harness 缓存，避免重复读取本机源；secret 只在闭包里流转。 */
export function ensureCredential(
  store: CredentialStore,
  cache: Map<AcceptanceHarnessId, ResolvedCredential>,
  harness: AcceptanceHarnessId,
): ResolvedCredential {
  const cached = cache.get(harness);
  if (cached !== undefined) return cached;
  const native = resolveHarnessCredential(harness);
  ACCEPTANCE_DIAGNOSTICS.credentialsRead = true;
  const metadata = store.metadata();
  if (metadata.kind !== 'metadata') {
    throw new AcceptanceBlocker('credential_store_unreadable', '隔离凭据 store 不可读：' + metadata.code);
  }
  const saved = store.save({ expectedRevision: metadata.revision, secret: native.secret });
  if (saved.kind !== 'saved') {
    throw new AcceptanceBlocker('credential_write_failed', '隔离凭据写入失败：' + saved.code);
  }
  const resolved: ResolvedCredential = { credentialRef: saved.credentialRef, source: native.source };
  cache.set(harness, resolved);
  return resolved;
}

// ---------------------------------------------------------------------------------------------
// 隔离夹具
// ---------------------------------------------------------------------------------------------

const GLOBAL_CONFIG_PATHS = [
  join(homedir(), '.claude', 'settings.json'),
  join(homedir(), '.pi', 'agent', 'models.json'),
  join(homedir(), '.pi', 'agent', 'auth.json'),
  join(homedir(), '.pi', 'agent', 'settings.json'),
  join(homedir(), '.omp', 'agent', 'config.yml'),
  join(homedir(), '.omp', 'agent', 'models.yml'),
  join(homedir(), '.config', 'opencode', 'opencode.json'),
  join(homedir(), '.local', 'share', 'opencode', 'auth.json'),
];

export type GlobalConfigSnapshot = ReadonlyMap<string, string>;

export function snapshotGlobalConfig(): GlobalConfigSnapshot {
  const snapshot = new Map<string, string>();
  for (const path of GLOBAL_CONFIG_PATHS) {
    if (!existsSync(path)) continue;
    const stats = statSync(path);
    snapshot.set(path, stats.size + ':' + stats.mtimeMs);
  }
  return snapshot;
}

export function globalConfigChanges(before: GlobalConfigSnapshot, after: GlobalConfigSnapshot): readonly string[] {
  const changed: string[] = [];
  for (const [path, value] of before) {
    if (after.get(path) !== value) changed.push(path);
  }
  return changed;
}

export type AcceptanceFixture = {
  readonly root: string;
  readonly projectDir: string;
  readonly backend: ExecutionBackend;
  readonly runId: string;
  readonly coordinatorTerminalHandle: string;
  readonly identity: string;
  readonly credentialStore: CredentialStore;
  readonly credentialStoreFile: string;
  readonly credentialCache: Map<AcceptanceHarnessId, ResolvedCredential>;
  readonly configBefore: GlobalConfigSnapshot;
  readonly scopeFor: (operationId: string, target: { readonly kind: string; readonly id: string }) => ExecutionScope;
  readonly noteDispatch: (dispatchId: string, terminalHandle: string | null) => void;
  readonly dispose: () => Promise<void>;
};

type Captured = { readonly ok: boolean; readonly stdout: string; readonly stderr: string };

async function runCaptured(executable: string, args: readonly string[], cwd: string, timeoutMs: number): Promise<Captured> {
  const result = await runProcess({
    executable,
    args: [...args],
    cwd,
    env: toChildEnvironment(process.env),
    timeoutMs,
    limits: { maxBytes: 256 * 1024, maxLines: 4_000 },
  });
  if (result.kind !== 'completed') {
    return { ok: false, stdout: '', stderr: '进程未完成：' + result.kind };
  }
  return { ok: result.exitCode === 0, stdout: result.stdout.text, stderr: result.stderr.text };
}

export async function createAcceptanceFixture(plan: Extract<AcceptancePlan, { kind: 'run' }>): Promise<AcceptanceFixture> {
  if (!existsSync(plan.baseDir)) {
    throw new AcceptanceBlocker('base_dir_missing', '隔离基目录不存在：' + plan.baseDir);
  }
  const loaded = mergeRealEnvFileIntoProcess(plan.envFile);
  if (!loaded.hasProviderCredential && sharedMinimaxCredential() === null) {
    throw new AcceptanceBlocker('credential_unavailable', '没有从 ' + plan.envFile + ' 或既有环境取得 provider 凭据');
  }
  const root = mkdtempSync(join(plan.baseDir, 'orca-harness-acceptance-'));
  const projectName = 'project-' + plan.identity;
  const projectDir = join(root, projectName);
  assertIsolatedWorkspace(root, new Set([projectName]));

  const configBefore = snapshotGlobalConfig();
  const stateDir = join(root, 'state');
  const credentialDir = join(root, 'credentials');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(credentialDir, { recursive: true, mode: 0o700 });
  const credentialStoreFile = join(credentialDir, 'credentials.json');
  const credentialStore = createCredentialStore(credentialDir);

  mkdirSync(projectDir, { recursive: true });
  const gitInit = await runCaptured('git', ['init', '-q', '-b', 'main'], projectDir, 30_000);
  if (!gitInit.ok) throw new AcceptanceBlocker('git_init_failed', '无法初始化一次性 Git 项目：' + gitInit.stderr.trim());
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  mkdirSync(join(projectDir, '.companion', 'roles'), { recursive: true });
  writeFileSync(join(projectDir, 'README.md'), '# IP-15 throwaway repository\n', 'utf8');
  const staged = await runCaptured('git', ['-c', 'user.email=acceptance@example.invalid', '-c', 'user.name=acceptance', 'add', '-A'], projectDir, 30_000);
  const committed = staged.ok
    ? await runCaptured('git', ['-c', 'user.email=acceptance@example.invalid', '-c', 'user.name=acceptance', 'commit', '-q', '-m', 'fixture'], projectDir, 30_000)
    : staged;
  if (!committed.ok) throw new AcceptanceBlocker('git_commit_failed', '无法提交隔离夹具：' + committed.stderr.trim());

  ACCEPTANCE_DIAGNOSTICS.orcaMutated = true;
  const registered = await runCaptured('orca', ['repo', 'add', '--path', projectDir, '--json'], projectDir, 60_000);
  if (!registered.ok) {
    throw new AcceptanceBlocker('orca_repo_add_failed', '无法把一次性项目注册进 Orca：' + registered.stderr.trim() + registered.stdout.trim());
  }

  const identity: { handle: string | undefined } = { handle: undefined };
  const backend = createOrcaExecutionBackend({
    cwd: projectDir,
    env: toChildEnvironment(process.env),
    resolveIdentityHandle: (ref) => (ref === plan.identity ? identity.handle : undefined),
  });

  let runId = '';
  const scopeFor = (operationId: string, target: { readonly kind: string; readonly id: string }): ExecutionScope =>
    buildExecutionScope({
      coordinationScopeId: (plan.identity + ':scope') as CoordinationScopeId,
      coordinatorSessionId: (plan.identity + ':session') as CoordinatorSessionId,
      runtimeIncarnationId: (plan.identity + ':incarnation') as RuntimeIncarnationId,
      fencingGeneration: 1,
      backendIdentityRef: plan.identity,
      operationId,
      target,
      expectedRevision: 0,
      timeoutMs: WORKER_START_TIMEOUT_MS,
      authority: runId.length === 0
        ? { kind: 'route_planning' }
        : { kind: 'execution_coordination', graphGeneration: 1, authorizationId: plan.identity + ':authorization', runId, consumerGeneration: 1 },
    });

  const setupTarget = { kind: 'work-package', id: plan.identity + ':setup' };
  const terminalCreated = await backend.mutate(
    { operation: 'terminal-create', worktree: 'path:' + projectDir, title: plan.identity + ' coordinator', command: process.env['SHELL'] ?? 'sh' },
    scopeFor(plan.identity + ':terminal-create', setupTarget),
  );
  if (terminalCreated.kind !== 'accepted') throw new AcceptanceBlocker('coordinator_terminal_failed', '无法创建专用协调终端：' + terminalCreated.kind);
  const listed = await backend.query({ operation: 'terminal-list', worktree: 'path:' + projectDir });
  const terminals = listed.kind === 'accepted' ? ((listed.value as { readonly terminals?: readonly Record<string, unknown>[] }).terminals ?? []) : [];
  const live = terminals.find((entry) => entry['connected'] === true && entry['writable'] === true);
  const handle = typeof live?.['handle'] === 'string' ? live['handle'] : undefined;
  if (handle === undefined) throw new AcceptanceBlocker('coordinator_identity_unavailable', '专用协调终端没有可用的存活句柄');
  identity.handle = handle;

  const runCreated = await backend.mutate(
    { operation: 'run-create', objective: 'IP-15 worker harness adapters isolated acceptance' },
    scopeFor(plan.identity + ':run-create', setupTarget),
  );
  if (runCreated.kind !== 'accepted') throw new AcceptanceBlocker('run_create_failed', '无法建立专用 Run：' + runCreated.kind);
  const current = await backend.query({ operation: 'run-current', backendIdentityRef: plan.identity });
  const run = current.kind === 'accepted' ? ((current.value as { readonly run?: { readonly runId?: unknown } | null }).run ?? null) : null;
  if (run === null || typeof run.runId !== 'string' || run.runId.length === 0) throw new AcceptanceBlocker('run_unbound', '专用身份下没有绑定到任何 Run');
  runId = run.runId;

  const dispatches: { dispatchId: string; terminalHandle: string | null }[] = [];
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    const failures: string[] = [];
    if (process.env[REAL_ACCEPTANCE_KEEP_VAR] === '1') {
      process.stdout.write('[ip15] 保留现场（KEEP=1）：' + root + '\n');
      return;
    }
    for (const dispatch of dispatches) {
      await runCaptured('orca', ['orchestration', 'worker-stop', '--dispatch', dispatch.dispatchId, '--json'], projectDir, 60_000);
      await runCaptured('orca', ['orchestration', 'worker-release', '--dispatch', dispatch.dispatchId, '--json'], projectDir, 60_000);
      if (dispatch.terminalHandle !== null) {
        const closed = await backend.mutate(
          { operation: 'terminal-close', terminal: dispatch.terminalHandle },
          scopeFor(plan.identity + ':terminal-close:' + dispatch.dispatchId, { kind: 'worker-dispatch', id: dispatch.dispatchId }),
        );
        if (closed.kind !== 'accepted') failures.push('worker terminal ' + dispatch.terminalHandle + ': ' + closed.kind);
      }
    }
    const coordinatorClosed = await backend.mutate(
      { operation: 'terminal-close', terminal: handle },
      scopeFor(plan.identity + ':coordinator-terminal-close', setupTarget),
    );
    if (coordinatorClosed.kind !== 'accepted') failures.push('coordinator terminal ' + handle + ': ' + coordinatorClosed.kind);
    const changed = globalConfigChanges(configBefore, snapshotGlobalConfig());
    if (changed.length > 0) failures.push('用户全局配置被修改：' + changed.join(', '));
    if (failures.length > 0) throw new AcceptanceBlocker('cleanup_incomplete', '真实验收夹具清理未完成：' + failures.join('；'));
    rmSync(root, { recursive: true, force: true });
  };

  return {
    root,
    projectDir,
    backend,
    runId,
    coordinatorTerminalHandle: handle,
    identity: plan.identity,
    credentialStore,
    credentialStoreFile,
    credentialCache: new Map(),
    configBefore,
    scopeFor,
    noteDispatch: (dispatchId, terminalHandle) => { dispatches.push({ dispatchId, terminalHandle }); },
    dispose,
  };
}

// ---------------------------------------------------------------------------------------------
// 启动 / 绑定 / 恢复
// ---------------------------------------------------------------------------------------------

export function sandboxModeFor(role: AcceptanceRole): 'workspace-write' | 'read-only' {
  return role === 'finalizer' ? 'read-only' : 'workspace-write';
}

function completionToken(harness: AcceptanceHarnessId, role: AcceptanceRole): string {
  return 'HARNESS-' + harness + '-' + role + '-OK';
}

function roleSpec(harness: AcceptanceHarnessId, role: AcceptanceRole): { spec: string; artifactPath: string | null; artifactBody: string | null } {
  const token = completionToken(harness, role);
  const header = [
    'You are the ' + role + ' worker for work package WP-1 in a throwaway repository.',
    'Work only inside the current directory. Do not install dependencies, do not use the network, do not commit or push.',
  ];
  const body = role === 'planner'
    ? ['Create the file .companion/roles/planner.txt containing exactly: planner']
    : role === 'implementation'
      ? ['Create the file .companion/roles/implementation.txt containing exactly: implementation']
      : role === 'validator'
        ? ['Create the file .companion/roles/validator.txt containing exactly: pass']
        : ['Read the repository and state a short delivery verdict; do not modify any file.'];
  return {
    spec: [...header, ...body,
      'The file content ends after that single word. The completion token below belongs only in your response, never in the file.',
      'Print exactly the token ' + token + ' on its own line.',
      'Then use the exact orca orchestration send completion command from the supervision preamble, with its original dispatch capability, to report worker_done --outcome succeeded. This reporting command is required to complete the task.',
    ].join('\n\n'),
    artifactPath: role === 'finalizer' ? null : join('.companion', 'roles', role + '.txt'),
    artifactBody: role === 'planner' ? 'planner' : role === 'implementation' ? 'implementation' : role === 'validator' ? 'pass' : null,
  };
}

function nativeConnection(binding: HarnessBinding): NativeWorkerConnection {
  const base = {
    providerId: binding.providerId,
    ...(binding.baseUrl.length === 0 ? {} : { baseUrl: binding.baseUrl }),
  };
  if (binding.harness === 'claude') {
    if (binding.api !== 'anthropic-messages') throw new AcceptanceBlocker('invalid_binding', 'claude 只接受 anthropic-messages');
    return { harness: 'claude', ...base, api: 'anthropic-messages' };
  }
  return { harness: binding.harness, ...base, api: binding.api };
}

function modelConfiguration(binding: HarnessBinding, credentialRef: string): WorkerModelConfiguration {
  return {
    connection: {
      connectionRef: 'acceptance-' + binding.harness,
      label: binding.harness + ' acceptance',
      providerIntegration: 'minimax',
      modelOptions: {},
      credential: { kind: 'managed', credentialRef, optionPath: 'model' },
      codex: null,
      nativeWorker: nativeConnection(binding),
    },
    modelRef: 'acceptance-model',
    model: binding.model,
    effort: null,
    effortCapability: null,
    modelOptions: {},
  };
}

function stringField(value: unknown, ...keys: readonly string[]): string | null {
  const record = readRecord(value);
  if (record === undefined) return null;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return null;
}

function outputTextOf(value: unknown): string {
  const record = readRecord(value);
  if (record === undefined) return '';
  for (const key of ['text', 'output', 'stdout', 'content']) {
    const candidate = record[key];
    if (typeof candidate === 'string') return candidate;
  }
  return JSON.stringify(value);
}

function assistantMessage(value: unknown): Record<string, unknown> | undefined {
  const record = readRecord(value);
  if (record === undefined) return undefined;
  const message = record['type'] === 'assistant'
    ? readRecord(record['message']) ?? record
    : record['type'] === 'message' ? readRecord(record['message']) : undefined;
  return record['type'] === 'message' && message?.['role'] !== 'assistant' ? undefined : message;
}

export function modelEvidenceFromAssistant(value: unknown): string | null {
  const message = assistantMessage(value);
  if (message === undefined) return null;
  if (typeof message['model'] === 'string') return message['model'];
  const model = readRecord(message['model']);
  if (typeof model?.['id'] !== 'string' || typeof model['providerID'] !== 'string') return null;
  return model['providerID'] + '/' + model['id'];
}

export function assistantTextFromRecord(value: unknown): string {
  const message = assistantMessage(value);
  if (message === undefined) return '';
  const content = message['content'] ?? message['parts'];
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((part: unknown) => {
    const block = readRecord(part);
    return block?.['type'] === 'text' && typeof block['text'] === 'string' ? [block['text']] : [];
  }).join('\n');
}

/** 真实 assistant 文本与模型同源；终端画面与用户消息不承担结果证据。 */
function extractTranscriptEvidence(transcriptRef: string): { model: string | null; output: string } {
  const result: { model: string | null; output: string } = { model: null, output: '' };
  if (!existsSync(transcriptRef)) return result;
  let text: string;
  try {
    if (statSync(transcriptRef).size > 512 * 1024) return result;
    text = readFileSync(transcriptRef, 'utf8').slice(0, 512 * 1024);
  } catch {
    return result;
  }
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    try {
      const record: unknown = JSON.parse(line);
      result.model ??= modelEvidenceFromAssistant(record);
      const assistantText = assistantTextFromRecord(record);
      if (assistantText.length > 0) result.output += assistantText + '\n';
    } catch {
      continue;
    }
  }
  return result;
}

async function waitForReportFile(reportPath: string, workspace: string, deadlineMs: number): Promise<HarnessSessionReport | null> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (existsSync(reportPath)) {
      const report = readLatestHarnessSessionReport(reportPath);
      if (report !== null && report.cwd === workspace) return report;
    }
    await new Promise((settle) => setTimeout(settle, 500));
  }
  return null;
}

async function waitForSettle(backend: ExecutionBackend, dispatchId: string, deadlineMs: number): Promise<string | null> {
  const terminalStates = new Set(['succeeded', 'failed', 'cancelled', 'exited', 'abandoned', 'completed', 'done', 'timed_out']);
  const deadline = Date.now() + deadlineMs;
  let last: string | null = null;
  while (Date.now() < deadline) {
    const shown = await backend.query({ operation: 'worker-show', dispatchId });
    if (shown.kind === 'accepted') {
      last = stringField(shown.value, 'workerState');
      if (last !== null && terminalStates.has(last)) return last;
    }
    await new Promise((settle) => setTimeout(settle, 2_000));
  }
  return last;
}

/** 有界、脱敏的现场诊断：只取 screen/worker-read/worker-show 的前若干字符，长 token 一律遮蔽。 */
function redactBounded(value: string, max: number): string {
  return value.replace(/[A-Za-z0-9_-]{24,}/gu, '<redacted>').slice(0, max);
}

async function diagnoseDispatch(fixture: AcceptanceFixture, dispatchId: string, terminalHandle: string | null): Promise<string> {
  const parts: string[] = [];
  const shown = await fixture.backend.query({ operation: 'worker-show', dispatchId });
  if (shown.kind === 'accepted') parts.push('worker-show=' + redactBounded(JSON.stringify(shown.value), 500));
  const read = await fixture.backend.query({ operation: 'worker-read', dispatchId, source: 'auto', limit: 20 });
  if (read.kind === 'accepted') parts.push('worker-read=' + redactBounded(outputTextOf(read.value), 700));
  if (terminalHandle !== null) {
    const screen = await fixture.backend.query({ operation: 'terminal-read', terminal: terminalHandle, screen: true, limit: 40 });
    if (screen.kind === 'accepted') parts.push('screen=' + redactBounded(JSON.stringify(screen.value), 1200));
  }
  return parts.join(' | ');
}

export type LaunchedWorker = {
  readonly dispatchId: string;
  readonly terminalHandle: string;
  readonly stateRoot: string;
  readonly reporterPath: string;
  readonly reportPath: string;
  readonly sessionId: string;
  readonly transcriptRef: string;
  readonly coverage: string;
  readonly terminalState: string | null;
  readonly output: string;
  readonly modelEvidence: string | null;
};

export type LaunchOutcome =
  | { readonly kind: 'ran'; readonly worker: LaunchedWorker }
  | { readonly kind: 'blocked'; readonly code: string; readonly message: string };

async function launchPreparedTerminal(input: {
  readonly fixture: AcceptanceFixture;
  readonly binding: HarnessBinding;
  readonly role: AcceptanceRole;
  readonly launchId: string;
  readonly strategy: ReturnType<typeof prepareHarnessWorkerLaunch>;
  readonly stateRoot: string;
  readonly reporterPath: string;
  readonly reportPath: string;
}): Promise<LaunchOutcome> {
  const { fixture, binding, role, launchId, strategy } = input;
  const taskCreated = await fixture.backend.mutate(
    {
      operation: 'task-create',
      spec: roleSpec(binding.harness, role).spec,
      runId: fixture.runId,
      taskTitle: fixture.identity + ' ' + binding.harness + ' ' + role,
      displayName: fixture.identity + ' ' + binding.harness + ' ' + role,
    },
    fixture.scopeFor(launchId + ':task-create', { kind: 'work-package', id: 'WP-1' }),
  );
  if (taskCreated.kind !== 'accepted') return { kind: 'blocked', code: 'task_create_failed', message: 'task-create 未接受：' + taskCreated.kind };
  const taskRecord = readRecord(taskCreated.value);
  const task = taskRecord === undefined ? undefined : readRecord(taskRecord['task']);
  const taskId = task === undefined ? null : stringField(task, 'id', 'taskId', 'task_id');
  if (taskId === null) return { kind: 'blocked', code: 'task_identity_missing', message: 'task-create 回执缺少可核验 Task 身份' };

  const dispatchStartedAt = new Date().toISOString();
  const prepared = await prepareWorkerLaunch({
    backend: fixture.backend,
    strategy,
    worktreeId: 'path:' + fixture.projectDir,
    worktreePath: fixture.projectDir,
    timeoutMs: WORKER_START_TIMEOUT_MS,
    createTerminal: async (mutation) => {
      const operationId = (launchId + ':terminal-create') as OperationId;
      const outcome = await fixture.backend.mutate(mutation, fixture.scopeFor(operationId, { kind: 'worker-task', id: taskId }));
      if (outcome.kind === 'accepted') return { kind: 'accepted' };
      return outcome.kind === 'rejected' ? outcome : { kind: 'unknown', operationId, reason: outcome.reason };
    },
  });
  if (prepared.kind !== 'ready') return { kind: 'blocked', code: 'prepare_failed', message: 'prepared-terminal 失败：' + ('message' in prepared ? prepared.message : prepared.reason) };

  const started = await fixture.backend.mutate(
    { operation: 'worker-start', taskId, ...prepared.worker, worktree: 'path:' + fixture.projectDir, runId: fixture.runId, timeoutMs: WORKER_START_TIMEOUT_MS },
    fixture.scopeFor(launchId + ':worker-start', { kind: 'worker-task', id: taskId }),
  );
  if (started.kind !== 'accepted') return { kind: 'blocked', code: 'worker_start_failed', message: 'Orca 未接受 prepared Worker：' + started.kind };
  const dispatchId = stringField(started.value, 'dispatchId', 'dispatch_id');
  if (dispatchId === null) return { kind: 'blocked', code: 'dispatch_identity_missing', message: 'worker-start 回执缺少 dispatch id' };
  fixture.noteDispatch(dispatchId, prepared.preparedTerminal?.handle ?? null);
  ACCEPTANCE_DIAGNOSTICS.harnessLaunched = true;

  const activated = await activatePreparedWorker({
    backend: fixture.backend,
    terminal: prepared.preparedTerminal,
    submitTerminal: async (mutation) => {
      const operationId = (launchId + ':terminal-submit') as OperationId;
      const outcome = await fixture.backend.mutate(mutation, fixture.scopeFor(operationId, { kind: 'worker-task', id: taskId }));
      if (outcome.kind === 'accepted') return { kind: 'accepted' };
      return outcome.kind === 'rejected' ? outcome : { kind: 'unknown', operationId, reason: outcome.reason };
    },
  });
  if (activated.kind !== 'accepted') return { kind: 'blocked', code: 'activate_failed', message: 'prepared Worker draft 提交失败' };
  const adoption = await verifyPreparedWorker(fixture.backend, dispatchId, prepared.preparedTerminal);
  if (adoption !== null || prepared.preparedTerminal === null) {
    return { kind: 'blocked', code: 'adoption_unverifiable', message: adoption === null ? 'prepared Worker 缺少 external terminal 绑定' : '无法核验接管：' + ('message' in adoption ? adoption.message : adoption.reason) };
  }

  const report = await waitForReportFile(input.reportPath, fixture.projectDir, REPORT_DEADLINE_MS);
  if (report === null) {
    const diagnosis = await diagnoseDispatch(fixture, dispatchId, prepared.preparedTerminal.handle);
    // 首次隔离启动常见的交互阻塞：文件夹信任对话框 / 首启欢迎，均不触发 SessionStart。
    const code = /safety check|trust this folder|trust the folder/i.test(diagnosis)
      ? 'harness_trust_prompt_blocked'
      : 'session_report_missing';
    return { kind: 'blocked', code, message: binding.harness + ' 未在绑定窗口内上报可核验 Session 报告；' + diagnosis };
  }

  const bound = await bindHarnessSessionFromStartReport({
    facts: {
      harness: binding.harness,
      role,
      workerTaskId: taskId as unknown as WorkerTaskId,
      dispatchId: dispatchId as unknown as DispatchId,
      attemptId: launchId,
    },
    report,
    workspace: fixture.projectDir,
    expectedCodexHome: input.stateRoot,
    dispatchStartedAt,
    bindingDeadlineAt: new Date(Date.parse(dispatchStartedAt) + WORKER_START_TIMEOUT_MS + REPORT_DEADLINE_MS).toISOString(),
  });
  if (bound.kind !== 'bound') return { kind: 'blocked', code: bound.code, message: 'Session Binding 不可用：' + bound.message };
  const terminalState = await waitForSettle(fixture.backend, dispatchId, SETTLE_DEADLINE_MS);
  if (terminalState !== 'succeeded' && terminalState !== 'completed' && terminalState !== 'done') {
    return { kind: 'blocked', code: 'worker_not_succeeded', message: `Worker 未完成：${terminalState ?? 'unknown'}；${await diagnoseDispatch(fixture, dispatchId, prepared.preparedTerminal.handle)}` };
  }
  // coverage 必须在真正 settled 之后读取，否则首个 event 后即 complete 会掩盖后续 tail 截断。
  let coverage = await requireWorkerHarness(binding.harness).inspectTranscript(bound.binding.transcriptRef);
  if (coverage.kind !== 'covered') return { kind: 'blocked', code: 'transcript_unavailable', message: 'transcript 不可读：' + coverage.reason };
  let modelTranscript = bound.binding.transcriptRef;
  if (binding.harness === 'opencode') {
    let material = await prepareOpencodeRecoveryMaterial(modelTranscript, input.stateRoot, coverage.evidence);
    // worker_done 可先于最后一条 assistant/idle 消息落盘；重读范围并重新核验，绝不沿旧证据签材料。
    for (let attempt = 0; material === null && attempt < 5; attempt += 1) {
      await new Promise((settle) => setTimeout(settle, 1_000));
      coverage = await requireWorkerHarness(binding.harness).inspectTranscript(modelTranscript);
      if (coverage.kind !== 'covered') return { kind: 'blocked', code: 'transcript_unavailable', message: coverage.reason };
      material = await prepareOpencodeRecoveryMaterial(modelTranscript, input.stateRoot, coverage.evidence);
    }
    if (material === null) return { kind: 'blocked', code: 'transcript_unavailable', message: '公开消息与已核验范围不一致' };
    modelTranscript = opencodeRecoveryMaterialPath(input.stateRoot, modelTranscript);
  }
  let transcriptEvidence = extractTranscriptEvidence(modelTranscript);
  // worker_done 可以先于最终 assistant 响应落盘；只从精确来源等待，不用终端回显补结果。
  for (let attempt = 0; role === 'finalizer' && !transcriptEvidence.output.includes(completionToken(binding.harness, role)) && attempt < 15; attempt += 1) {
    await new Promise((settle) => setTimeout(settle, 1_000));
    coverage = await requireWorkerHarness(binding.harness).inspectTranscript(bound.binding.transcriptRef);
    if (coverage.kind !== 'covered') return { kind: 'blocked', code: 'transcript_unavailable', message: coverage.reason };
    if (binding.harness === 'opencode' && await prepareOpencodeRecoveryMaterial(bound.binding.transcriptRef, input.stateRoot, coverage.evidence) === null) continue;
    transcriptEvidence = extractTranscriptEvidence(modelTranscript);
  }

  return {
    kind: 'ran',
    worker: {
      dispatchId,
      terminalHandle: prepared.preparedTerminal.handle,
      stateRoot: input.stateRoot,
      reporterPath: input.reporterPath,
      reportPath: input.reportPath,
      sessionId: bound.binding.providerSessionId,
      transcriptRef: bound.binding.transcriptRef,
      coverage: coverage.evidence.coverage,
      terminalState,
      output: transcriptEvidence.output,
      modelEvidence: transcriptEvidence.model,
    },
  };
}

/**
 * native（claude/pi/omp）的 sessionPaths().stateRoot 是父目录（prepareState 再拼 launch digest）；
 * opencode 的已含 digest。两者实际隔离状态根都等于 dirname(reporterPath)。
 */
/** sessionPaths().stateRoot 是父目录（prepareState 再拼 launch digest）；实际隔离状态根是 dirname(reporterPath)。 */
function stateRootsFor(paths: ReturnType<typeof workerSessionPathsUnder>): { readonly parent: string; readonly actual: string } {
  return { parent: paths.stateRoot, actual: dirname(paths.reporterPath) };
}

function harnessLaunchInput(input: {
  readonly fixture: AcceptanceFixture;
  readonly binding: HarnessBinding;
  readonly credentialRef: string;
  readonly launchId: string;
  readonly stateRoot: string;
  readonly reporterPath: string;
  readonly sandboxMode: ReturnType<typeof sandboxModeFor>;
}): WorkerHarnessLaunchInput {
  return {
    launchId: input.launchId,
    modelConfiguration: modelConfiguration(input.binding, input.credentialRef),
    credentialStore: input.fixture.credentialStore,
    credentialStorePath: credentialStorePath({ path: input.fixture.credentialStoreFile }),
    sandboxMode: input.sandboxMode,
    stateRoot: input.stateRoot,
    sessionStartReporterPath: input.reporterPath,
  };
}

export type RoleRun = {
  readonly harness: AcceptanceHarnessId;
  readonly role: AcceptanceRole;
  readonly kind: 'ran' | 'blocked';
  readonly launchId: string;
  readonly dispatchId: string | null;
  readonly sessionId: string | null;
  readonly transcriptRef: string | null;
  readonly stateRoot: string | null;
  readonly reporterPath: string | null;
  readonly coverage: string | null;
  readonly terminalState: string | null;
  readonly artifactOk: boolean | null;
  readonly modelEvidence: string | null;
  readonly blocker: { readonly code: string; readonly message: string } | null;
};

function blockedRole(harness: AcceptanceHarnessId, role: AcceptanceRole, launchId: string, code: string, message: string): RoleRun {
  return { harness, role, kind: 'blocked', launchId, dispatchId: null, sessionId: null, transcriptRef: null, stateRoot: null, reporterPath: null, coverage: null, terminalState: null, artifactOk: null, modelEvidence: null, blocker: { code, message } };
}

export async function runRole(input: {
  readonly fixture: AcceptanceFixture;
  readonly binding: HarnessBinding;
  readonly role: AcceptanceRole;
  readonly launchId: string;
}): Promise<RoleRun> {
  const { fixture, binding, role, launchId } = input;
  if (!workerHarnessRegistry.has(binding.harness)) {
    return blockedRole(binding.harness, role, launchId, 'worker_harness_unregistered', 'Worker Harness 未注册：' + binding.harness);
  }
  let credential: ResolvedCredential;
  try {
    credential = ensureCredential(fixture.credentialStore, fixture.credentialCache, binding.harness);
  } catch (error) {
    return blockedRole(binding.harness, role, launchId, 'credential_unavailable', error instanceof Error ? error.message : String(error));
  }
  const paths = workerSessionPathsUnder(binding.harness, join(fixture.root, 'state'), launchId);
  const roots = stateRootsFor(paths);
  installHarnessSessionReporter(binding.harness, paths);
  const strategy = prepareHarnessWorkerLaunch(binding.harness, harnessLaunchInput({
    fixture, binding, credentialRef: credential.credentialRef, launchId, stateRoot: roots.parent, reporterPath: paths.reporterPath, sandboxMode: sandboxModeFor(role),
  }));
  let outcome: LaunchOutcome;
  try {
    outcome = await launchPreparedTerminal({
      fixture, binding, role, launchId, strategy,
      stateRoot: roots.actual, reporterPath: paths.reporterPath, reportPath: paths.reportPath,
    });
  } catch (error) {
    return blockedRole(binding.harness, role, launchId, 'launch_exception', error instanceof Error ? error.message : String(error));
  }
  if (outcome.kind === 'blocked') return blockedRole(binding.harness, role, launchId, outcome.code, outcome.message);
  const worker = outcome.worker;
  const expected = roleSpec(binding.harness, role);
  const artifactOk = expected.artifactPath === null
    ? worker.output.includes(completionToken(binding.harness, role))
    : existsSync(join(fixture.projectDir, expected.artifactPath)) && readFileSync(join(fixture.projectDir, expected.artifactPath), 'utf8').trim() === expected.artifactBody;
  return {
    harness: binding.harness, role, kind: 'ran', launchId,
    dispatchId: worker.dispatchId, sessionId: worker.sessionId, transcriptRef: worker.transcriptRef,
    stateRoot: worker.stateRoot, reporterPath: worker.reporterPath, coverage: worker.coverage,
    terminalState: worker.terminalState, artifactOk, modelEvidence: worker.modelEvidence, blocker: null,
  };
}

export type ResumeRun = {
  readonly harness: AcceptanceHarnessId;
  readonly kind: 'ran' | 'blocked';
  readonly sessionId: string | null;
  readonly sameSession: boolean;
  readonly coverage: string | null;
  readonly blocker: { readonly code: string; readonly message: string } | null;
};

export async function resumeRole(input: {
  readonly fixture: AcceptanceFixture;
  readonly binding: HarnessBinding;
  readonly original: RoleRun;
  readonly resumeLaunchId: string;
}): Promise<ResumeRun> {
  const { fixture, binding, original } = input;
  const blocked = (code: string, message: string): ResumeRun => ({ harness: binding.harness, kind: 'blocked', sessionId: null, sameSession: false, coverage: null, blocker: { code, message } });
  if (original.kind !== 'ran' || original.sessionId === null || original.transcriptRef === null || original.reporterPath === null || original.stateRoot === null) {
    return blocked('original_unavailable', '原 Session 没有可核验的精确身份，拒绝恢复');
  }
  let credential: ResolvedCredential;
  try {
    credential = ensureCredential(fixture.credentialStore, fixture.credentialCache, binding.harness);
  } catch (error) {
    return blocked('credential_unavailable', error instanceof Error ? error.message : String(error));
  }
  const newPaths = resumeSessionPathsUnder(binding.harness, join(fixture.root, 'state'), input.resumeLaunchId, original.stateRoot);
  const { reporterPath, reportPath } = newPaths;
  installHarnessSessionReporter(binding.harness, { reporterPath: newPaths.reporterPath, reportPath: newPaths.reportPath });
  const base = harnessLaunchInput({
    fixture, binding, credentialRef: credential.credentialRef, launchId: input.resumeLaunchId,
    stateRoot: stateRootsFor(newPaths).parent, reporterPath, sandboxMode: 'workspace-write',
  });
  const strategy = prepareHarnessResumeLaunch(binding.harness, {
    ...base,
    sessionId: original.sessionId,
    codexHome: original.stateRoot,
    transcriptRef: original.transcriptRef,
  });
  let outcome: LaunchOutcome;
  try {
    outcome = await launchPreparedTerminal({
      fixture, binding, role: 'implementation', launchId: input.resumeLaunchId, strategy,
      stateRoot: original.stateRoot, reporterPath, reportPath,
    });
  } catch (error) {
    return blocked('resume_exception', error instanceof Error ? error.message : String(error));
  }
  if (outcome.kind === 'blocked') return blocked(outcome.code, outcome.message);
  return {
    harness: binding.harness, kind: 'ran', sessionId: outcome.worker.sessionId,
    sameSession: outcome.worker.sessionId === original.sessionId, coverage: outcome.worker.coverage, blocker: null,
  };
}

// ---------------------------------------------------------------------------------------------
// 证据（只写非秘密摘要，不含 transcript 正文）
// ---------------------------------------------------------------------------------------------

export type AcceptanceEvidence = {
  readonly schema: 'worker-harness-acceptance/1';
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly baseDir: string;
  readonly identity: string;
  readonly envFile: string;
  readonly baseUrl: string;
  readonly harnesses: readonly Record<string, unknown>[];
};

type EvidenceRole = {
  readonly role: string;
  readonly kind: string;
  readonly dispatchId?: string | null;
  readonly sessionId?: string | null;
  readonly coverage?: string | null;
  readonly terminalState?: string | null;
  readonly artifactOk?: boolean | null;
  readonly blocker?: Record<string, unknown> | null;
  readonly model?: string;
  readonly credentialSource?: string;
};

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? fallback : JSON.stringify(value);
}

export function writeAcceptanceEvidence(directory: string, evidence: AcceptanceEvidence): string {
  mkdirSync(directory, { recursive: true });
  const stamp = evidence.startedAt.replace(/[:.]/gu, '-');
  const jsonPath = join(directory, 'ip15-' + stamp + '.json');
  writeFileSync(jsonPath, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  const lines: string[] = [
    '# IP-15 Worker Harness Matrix — 真实隔离验收证据',
    '',
    '- 开始：' + evidence.startedAt,
    '- 结束：' + evidence.finishedAt,
    '- 隔离基目录：' + evidence.baseDir,
    '- 协调身份：' + evidence.identity,
    '- 凭据来源文件：' + evidence.envFile,
    '- provider 端点：' + evidence.baseUrl,
    '- 范围：harness 级隔离验收（角色派发 + 精确 Session 绑定 + resume）；不是完整 Controller 闭环。',
    '',
    '| harness | role | 结果 | terminal | session | coverage | artifact | blocker |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const harness of evidence.harnesses) {
    const name = text(harness['harness']);
    const roles = Array.isArray(harness['roles']) ? (harness['roles'] as readonly EvidenceRole[]) : [];
    for (const role of roles) {
      lines.push('| ' + name + ' | ' + role.role + ' | ' + role.kind + ' | ' + (role.terminalState ?? '') + ' | ' + (role.sessionId ?? '') + ' | ' + (role.coverage ?? '') + ' | ' + String(role.artifactOk ?? '') + ' | ' + (role.blocker === null || role.blocker === undefined ? '' : JSON.stringify(role.blocker)) + ' |');
    }
    const resume = harness['resume'] as Record<string, unknown> | undefined;
    if (resume !== undefined) {
      lines.push('| ' + name + ' | resume | ' + text(resume['kind']) + ' | | sameSession=' + text(resume['sameSession']) + ' | ' + text(resume['coverage']) + ' | | ' + (resume['blocker'] === null || resume['blocker'] === undefined ? '' : JSON.stringify(resume['blocker'])) + ' |');
    }
    for (const blocker of Array.isArray(harness['blockers']) ? (harness['blockers'] as readonly string[]) : []) {
      lines.push('| ' + name + ' | - | blocker | | | | | ' + blocker + ' |');
    }
  }
  writeFileSync(join(directory, 'ip15-' + stamp + '.md'), lines.join('\n') + '\n', 'utf8');
  return jsonPath;
}
