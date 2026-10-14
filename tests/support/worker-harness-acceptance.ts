/**
 * IP-04 真实隔离验收支持（change: add-testable-worker-harness-adapters）。
 *
 * 只由公开 API 组成：应用层 prepareWorkerLaunch/activatePreparedWorker/verifyPreparedWorker，
 * bootstrap 的 workerSessionPathsUnder/installHarnessSessionReporter/prepareHarnessWorkerLaunch/
 * prepareHarnessResumeLaunch/bindHarnessSessionFromStartReport，注册表的 inspectTranscript。
 *
 * 隔离事实：一次性 Git 项目建在显式隔离目录（默认 /var/tmp，因为只读包装器隐藏 /tmp），
 * 专用协调终端提供唯一 Orca 身份并自建 Run；结束保留现场，由用户显式回收。
 *
 * Worker 认证由各 harness 的实际原生环境提供，夹具只传入模型选择。
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
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readRecord } from '../../src/adapters/orca-cli/operation-catalog.js';
import { createOrcaExecutionBackend } from '../../src/adapters/orca-cli/orca-backend.js';
import { runProcess } from '../../src/adapters/orca-cli/process-runner.js';
import { readDeliveryBatch } from '../../src/adapters/orca-cli/delivery-reader.js';
import { buildUtilityWorkerEnvelope, parseRecoveryCapsuleReport, recoveryCapsuleInstructions } from '../../src/adapters/agents/utility-worker.js';
import { capsuleRefOf, readRecoveryCapsuleBody, writeRecoveryCapsuleBody, type RecoveryCapsule, type TranscriptCoverageEvidence } from '../../src/application/recovery/recovery-capsule.js';
import type { DeliveryMessage } from '../../src/application/dto/operation-outcome.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  DispatchId,
  OperationId,
  RuntimeIncarnationId,
  SessionSegmentId,
  WorkerTaskId,
} from '../../src/application/dto/identity.js';
import type { ExecutionBackend, ExecutionMutation, ExecutionScope } from '../../src/application/ports/execution-backend.js';
import { buildExecutionScope, orcaTerminalHandleFromReceipt } from '../../src/application/ports/execution-backend.js';
import type { HarnessSessionReport, WorkerHarness, WorkerHarnessLaunchInput } from '../../src/application/ports/worker-harness.js';
import { commandCodeHarness } from '../../src/adapters/agents/command-code-harness.js';
import { qwenHarness } from '../../src/adapters/agents/qwen-harness.js';
import { antigravityHarness } from '../../src/adapters/agents/antigravity-harness.js';
import { kiloHarness } from '../../src/adapters/agents/kilo-harness.js';
import { kimiHarness } from '../../src/adapters/agents/kimi-harness.js';
import { hermesHarness, prepareHermesRecoveryMaterial, hermesRecoveryMaterialPath } from '../../src/adapters/agents/hermes-harness.js';
import { clineHarness, prepareClineRecoveryMaterial, clineRecoveryMaterialPath } from '../../src/adapters/agents/cline-harness.js';
import {
  activatePreparedWorker,
  prepareWorkerLaunch,
  verifyPreparedWorker,
  type PreparedTerminalStrategy,
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
import type { WorkerModelSelection } from '../../src/domain/model-configuration.js';
import { toChildEnvironment } from '../../src/interfaces/cli/main.js';


export const REAL_ACCEPTANCE_SWITCH = 'ORCA_COMPANION_REAL_ACCEPTANCE';
export const REAL_ACCEPTANCE_BASE_VAR = 'ORCA_COMPANION_REAL_ACCEPTANCE_BASE';
export const REAL_ACCEPTANCE_HARNESSES_VAR = 'ORCA_COMPANION_REAL_ACCEPTANCE_HARNESSES';
export const REAL_ACCEPTANCE_ROLES_VAR = 'ORCA_COMPANION_REAL_ACCEPTANCE_ROLES';
/** 现场始终保留；KEEP 不授权自动 stop/release、关闭终端或删除目录。 */
export const REAL_ACCEPTANCE_KEEP_VAR = 'ORCA_COMPANION_REAL_ACCEPTANCE_KEEP';

/** Candidate entries exist only for the explicitly enabled qualification run. */
export function installAcceptanceCandidates(plan: AcceptancePlan): () => void {
  if (plan.kind !== 'run') return () => undefined;
  if (!(workerHarnessRegistry instanceof Map)) throw new Error('Qualification requires the bootstrap Map registry');
  const registry = workerHarnessRegistry as Map<string, WorkerHarness>;
  const installed: { id: string; candidate: WorkerHarness; previous: WorkerHarness | undefined }[] = [];
  for (const candidate of [commandCodeHarness, qwenHarness, antigravityHarness, kiloHarness, kimiHarness, hermesHarness, clineHarness]) {
    if (!plan.harnesses.includes(candidate.id)) continue;
    installed.push({ id: candidate.id, candidate, previous: registry.get(candidate.id) });
    registry.set(candidate.id, candidate);
  }
  return () => {
    for (const { id, candidate, previous } of installed) {
      if (registry.get(id) !== candidate) continue;
      if (previous === undefined) registry.delete(id);
      else registry.set(id, previous);
    }
  };
}

/** 默认隔离基目录：/tmp 被只读包装器隐藏，真实运行必须放在这里。 */
export const DEFAULT_ACCEPTANCE_BASE = '/var/tmp';

const WORKER_START_TIMEOUT_MS = 300_000;
const REPORT_DEADLINE_MS = 180_000;
const SETTLE_DEADLINE_MS = 480_000;

export type AcceptanceHarnessId = string;
export const ACCEPTANCE_ROLES = ['planner', 'implementation', 'validator', 'finalizer'] as const;
export type AcceptanceRole = (typeof ACCEPTANCE_ROLES)[number];

export type HarnessBinding = {
  readonly harness: AcceptanceHarnessId;
  readonly modelSelection: Readonly<WorkerModelSelection>;
  readonly expectedModel: string;
};

/** 已批准的原生模型选择；新增候选通过接入后在此显式追加自己的绑定。 */
export const HARNESS_MATRIX: readonly HarnessBinding[] = [
  { harness: 'claude', modelSelection: { model: 'MiniMax-M3.1-Flash-Preview', effort: null, effortCapability: null, catalogSource: null }, expectedModel: 'MiniMax-M3.1-Flash-Preview' },
  { harness: 'opencode', modelSelection: { model: 'minimax-cn-coding-plan/MiniMax-M3.1-Flash-Preview', effort: null, effortCapability: null, catalogSource: null }, expectedModel: 'MiniMax-M3.1-Flash-Preview' },
  { harness: 'pi', modelSelection: { model: 'minimax-cn/MiniMax-M3.1-Flash-Preview', effort: null, effortCapability: null, catalogSource: null }, expectedModel: 'MiniMax-M3.1-Flash-Preview' },
  { harness: 'omp', modelSelection: { model: 'minimax-code-cn/MiniMax-M3.1-Flash-Preview', effort: null, effortCapability: null, catalogSource: null }, expectedModel: 'MiniMax-M3.1-Flash-Preview' },
  { harness: 'command-code', modelSelection: { model: 'minimax-cn/MiniMax-M3.1-Flash-Preview', effort: null, effortCapability: null, catalogSource: null }, expectedModel: 'MiniMax-M3.1-Flash-Preview' },
  { harness: 'qwen-code', modelSelection: { model: 'MiniMax-M3.1-Flash-Preview', effort: null, effortCapability: null, catalogSource: null }, expectedModel: 'MiniMax-M3.1-Flash-Preview' },
  { harness: 'antigravity', modelSelection: { model: 'gemini-3.8-flash-medium', effort: null, effortCapability: null, catalogSource: null }, expectedModel: 'gemini-3.8-flash-medium' },
  { harness: 'kilo', modelSelection: { model: 'minimax-cn-coding-plan/MiniMax-M3.1-Flash-Preview', effort: null, effortCapability: null, catalogSource: null }, expectedModel: 'MiniMax-M3.1-Flash-Preview' },
  { harness: 'kimi', modelSelection: { model: 'MiniMax-M3.1-Flash-Preview', effort: null, effortCapability: null, catalogSource: null }, expectedModel: 'MiniMax-M3.1-Flash-Preview' },
  { harness: 'hermes', modelSelection: { model: 'MiniMax-M3.1-Flash-Preview', effort: null, effortCapability: null, catalogSource: null }, expectedModel: 'MiniMax-M3.1-Flash-Preview' },
  { harness: 'cline', modelSelection: { model: 'minimax-cn-coding-plan/MiniMax-M3.1-Flash-Preview', effort: null, effortCapability: null, catalogSource: null }, expectedModel: 'MiniMax-M3.1-Flash-Preview' },
];
export const ACCEPTANCE_HARNESSES = HARNESS_MATRIX.map((binding) => binding.harness);

export type AcceptancePlan =
  | { readonly kind: 'skip'; readonly reason: string }
  | {
      readonly kind: 'run';
      readonly baseDir: string;
      readonly identity: string;
      readonly orcaExecutable: string;
      readonly harnesses: readonly AcceptanceHarnessId[];
      readonly roles: readonly AcceptanceRole[];
    };

/** 未显式开启时只返回 skip，且不建目录、不读凭据、不访问 Orca；没有静默默认门。 */
export function resolveAcceptancePlan(env: Readonly<Record<string, string | undefined>> = process.env): AcceptancePlan {
  if (env[REAL_ACCEPTANCE_SWITCH] !== '1') {
    return { kind: 'skip', reason: REAL_ACCEPTANCE_SWITCH + ' 未显式开启' };
  }
  const harnesses = parseSelection(env[REAL_ACCEPTANCE_HARNESSES_VAR], ACCEPTANCE_HARNESSES, REAL_ACCEPTANCE_HARNESSES_VAR);
  const roles = parseSelection(env[REAL_ACCEPTANCE_ROLES_VAR], ACCEPTANCE_ROLES, REAL_ACCEPTANCE_ROLES_VAR);
  const orcaExecutable = env['ORCA_CLI_COMMAND']?.trim() || (process.platform === 'linux' ? 'orca-ide' : '');
  if (orcaExecutable.length === 0) throw new AcceptanceBlocker('orca_command_missing', '真实验收需要明确 ORCA_CLI_COMMAND');
  return {
    kind: 'run',
    baseDir: resolve(env[REAL_ACCEPTANCE_BASE_VAR] ?? DEFAULT_ACCEPTANCE_BASE),
    identity: 'companion-harness-matrix-' + randomUUID(),
    orcaExecutable,
    harnesses,
    roles,
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
  join(homedir(), '.commandcode', 'providers.json'),
  join(homedir(), '.commandcode', 'settings.json'),
  join(homedir(), '.qwen', 'settings.json'),
  join(process.env['CODEBUDDY_CONFIG_DIR'] || join(homedir(), '.codebuddy'), 'models.json'),
  join(process.env['CODEBUDDY_CONFIG_DIR'] || join(homedir(), '.codebuddy'), 'settings.json'),
  join(process.env['GROK_HOME'] || join(homedir(), '.grok'), 'config.toml'),
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
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    if (after.get(path) !== before.get(path)) changed.push(path);
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
  readonly configBefore: GlobalConfigSnapshot;
  readonly scopeFor: (operationId: string, target: { readonly kind: string; readonly id: string }) => ExecutionScope;
  readonly dispose: () => Promise<void>;
};

type Captured = { readonly ok: boolean; readonly stdout: string; readonly stderr: string };

/** 创建回执是 terminal 身份的唯一来源；不确定时保留现场且不另建资源。 */
export async function createAcceptanceTerminal(
  backend: ExecutionBackend,
  mutation: Extract<ExecutionMutation, { operation: 'terminal-create' }>,
  scope: ExecutionScope,
): Promise<string> {
  const outcome = await backend.mutate(mutation, scope);
  if (outcome.kind !== 'accepted') throw new AcceptanceBlocker('terminal_create_' + outcome.kind, 'terminal-create 未取得确定回执：' + outcome.kind);
  const handle = orcaTerminalHandleFromReceipt(outcome.value);
  if (handle === null) throw new AcceptanceBlocker('terminal_receipt_unavailable', 'terminal-create 回执缺少精确句柄');
  return handle;
}

export async function prepareAcceptanceWorker(input: {
  readonly backend: ExecutionBackend;
  readonly strategy: PreparedTerminalStrategy;
  readonly worktreePath: string;
  readonly scope: ExecutionScope;
}) {
  const launch = await input.strategy.prepare({ worktreePath: input.worktreePath });
  if (launch.title !== input.strategy.title || launch.command.length === 0) {
    throw new AcceptanceBlocker('invalid_worker_launcher', 'adapter 返回空命令或不一致的 terminal title');
  }
  const handle = await createAcceptanceTerminal(input.backend, {
    operation: 'terminal-create', worktree: 'path:' + input.worktreePath, title: launch.title, command: launch.command, focus: true,
  }, input.scope);
  return prepareWorkerLaunch({
    backend: input.backend,
    strategy: input.strategy,
    worktreeId: 'path:' + input.worktreePath,
    worktreePath: input.worktreePath,
    knownTerminalHandle: handle,
    timeoutMs: WORKER_START_TIMEOUT_MS,
    createTerminal: () => Promise.resolve({ kind: 'rejected', code: 'terminal_already_created', message: '已创建的 terminal 只按原回执核验' }),
  });
}

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
  const root = mkdtempSync(join(plan.baseDir, 'orca-harness-acceptance-'));
  process.stdout.write('[ip04] 保留隔离现场：' + root + '\n');
  const projectName = 'project-' + plan.identity;
  const projectDir = join(root, projectName);
  assertIsolatedWorkspace(root, new Set([projectName]));

  const configBefore = snapshotGlobalConfig();
  const stateDir = join(root, 'state');
  mkdirSync(stateDir, { recursive: true });

  mkdirSync(projectDir, { recursive: true });
  const gitInit = await runCaptured('git', ['init', '-q', '-b', 'main'], projectDir, 30_000);
  if (!gitInit.ok) throw new AcceptanceBlocker('git_init_failed', '无法初始化一次性 Git 项目：' + gitInit.stderr.trim());
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  mkdirSync(join(projectDir, '.companion', 'roles'), { recursive: true });
  writeFileSync(join(projectDir, 'README.md'), '# IP-04 throwaway repository\n', 'utf8');
  const staged = await runCaptured('git', ['-c', 'user.email=acceptance@example.invalid', '-c', 'user.name=acceptance', 'add', '-A'], projectDir, 30_000);
  const committed = staged.ok
    ? await runCaptured('git', ['-c', 'user.email=acceptance@example.invalid', '-c', 'user.name=acceptance', 'commit', '-q', '-m', 'fixture'], projectDir, 30_000)
    : staged;
  if (!committed.ok) throw new AcceptanceBlocker('git_commit_failed', '无法提交隔离夹具：' + committed.stderr.trim());

  ACCEPTANCE_DIAGNOSTICS.orcaMutated = true;
  const registered = await runCaptured(plan.orcaExecutable, ['repo', 'add', '--path', projectDir, '--json'], projectDir, 60_000);
  if (!registered.ok) {
    throw new AcceptanceBlocker('orca_repo_add_failed', '无法把一次性项目注册进 Orca：' + registered.stderr.trim() + registered.stdout.trim());
  }

  const identity: { handle: string | undefined } = { handle: undefined };
  const backend = createOrcaExecutionBackend({
    executable: plan.orcaExecutable,
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
  const handle = await createAcceptanceTerminal(backend,
    { operation: 'terminal-create', worktree: 'path:' + projectDir, title: plan.identity + ' coordinator', command: process.env['SHELL'] ?? 'sh' },
    scopeFor(plan.identity + ':terminal-create', setupTarget),
  );
  const listed = await backend.query({ operation: 'terminal-list', worktree: 'path:' + projectDir });
  const inventory = listed.kind === 'accepted' ? readRecord(listed.value) : undefined;
  const terminals = Array.isArray(inventory?.['terminals']) ? inventory['terminals'] as readonly Record<string, unknown>[] : [];
  const matches = terminals.filter((entry) => entry['handle'] === handle);
  if (inventory?.['truncated'] !== false || !Array.isArray(inventory['omittedHostIds']) || inventory['omittedHostIds'].length > 0
    || matches.length !== 1 || matches[0]?.['connected'] !== true || matches[0]['writable'] !== true) {
    throw new AcceptanceBlocker('coordinator_identity_unavailable', '创建回执的专用协调终端不可核验');
  }
  identity.handle = handle;

  const runCreated = await backend.mutate(
    { operation: 'run-create', objective: 'IP-04 worker harness adapters isolated acceptance' },
    scopeFor(plan.identity + ':run-create', setupTarget),
  );
  if (runCreated.kind !== 'accepted') throw new AcceptanceBlocker('run_create_failed', '无法建立专用 Run：' + runCreated.kind);
  const current = await backend.query({ operation: 'run-current', backendIdentityRef: plan.identity });
  const run = current.kind === 'accepted' ? ((current.value as { readonly run?: { readonly runId?: unknown } | null }).run ?? null) : null;
  if (run === null || typeof run.runId !== 'string' || run.runId.length === 0) throw new AcceptanceBlocker('run_unbound', '专用身份下没有绑定到任何 Run');
  runId = run.runId;

  let disposed = false;
  const dispose = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    disposed = true;
    const changed = globalConfigChanges(configBefore, snapshotGlobalConfig());
    if (changed.length > 0) throw new AcceptanceBlocker('global_config_changed', '用户全局配置被修改：' + changed.join(', '));
    return Promise.resolve();
  };

  return {
    root,
    projectDir,
    backend,
    runId,
    coordinatorTerminalHandle: handle,
    identity: plan.identity,
    configBefore,
    scopeFor,
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

export function roleSpec(harness: AcceptanceHarnessId, role: AcceptanceRole): { spec: string; artifactPath: string | null; artifactBody: string | null } {
  const token = completionToken(harness, role);
  const artifactPath = role === 'finalizer' ? null : join('.companion', 'roles', harness + '-' + role + '.txt');
  const artifactBody = role === 'finalizer' ? null : role === 'validator' ? 'pass' : role;
  const header = [
    'You are the ' + role + ' worker for work package WP-1 in a throwaway repository.',
    'Work only inside the current directory. Do not install dependencies, do not use the network, do not commit or push.',
    'Use native Read/Glob/Edit/Write tools for repository inspection and artifacts; reserve Bash for the required Orca reporting command.',
  ];
  const body = artifactPath === null
    ? ['Read the repository and state a short delivery verdict; do not modify any file.']
    : ['Create the file ' + artifactPath + ' containing exactly: ' + artifactBody];
  return {
    spec: [...header, ...body,
      ...(artifactPath === null ? [] : ['Use your native file editing tool to create this artifact. The file content ends after that single word.']),
      'The completion token belongs only in your assistant response. Do not create a token file.',
      'Print exactly the token ' + token + ' on its own line.',
      'Then use the exact orca orchestration send completion command from the supervision preamble, with its original dispatch capability, to report worker_done --outcome succeeded. This reporting command is required to complete the task.',
    ].join('\n\n'),
    artifactPath,
    artifactBody,
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
  if (record['role'] === 'assistant' && typeof record['id'] === 'number' && record['active'] === 1 && record['compacted'] === 0) return record;
  if (record['type'] === 'PLANNER_RESPONSE' && record['source'] === 'MODEL' && record['status'] === 'DONE') return record;
  if (record['type'] === 'agent.message.appended') {
    const envelope = readRecord(record['message']);
    const meta = readRecord(envelope?.['meta']);
    const message = readRecord(envelope?.['message']);
    return meta?.['source'] === 'llm' && message?.['role'] === 'assistant' ? message : undefined;
  }
  const info = readRecord(record['info']);
  if (info?.['role'] === 'assistant') return { ...info, parts: record['parts'] };
  const message = record['type'] === 'assistant'
    ? readRecord(record['message']) ?? record
    : record['type'] === 'message' ? readRecord(record['message']) ?? record : undefined;
  return record['type'] === 'message' && message?.['role'] !== 'assistant' && record['role'] !== 'assistant' ? undefined : message;
}

export function modelEvidenceFromAssistant(value: unknown): string | null {
  const message = assistantMessage(value);
  if (message === undefined) return null;
  const native = readRecord(value);
  // Command Code records inference metadata beside the validated assistant message.
  if ((native?.['type'] === 'assistant' || (native?.['type'] === 'message' && (message['role'] === 'assistant' || native['role'] === 'assistant')))
    && typeof native['model'] === 'string' && native['model'].trim().length > 0) return native['model'];
  const provider = readRecord(native?.['providerData']);
  if (native?.['type'] === 'message' && native['role'] === 'assistant'
    && typeof provider?.['model'] === 'string' && provider['model'].trim().length > 0) return provider['model'];
  if (typeof message['model'] === 'string') return message['model'];
  if (typeof message['modelID'] === 'string' && typeof message['providerID'] === 'string') {
    return message['providerID'] + '/' + message['modelID'];
  }
  const model = readRecord(message['model']);
  if (typeof model?.['id'] !== 'string' || typeof model['providerID'] !== 'string') return null;
  return model['providerID'] + '/' + model['id'];
}

export function assistantTextFromRecord(value: unknown): string {
  const message = assistantMessage(value);
  if (message === undefined) return '';
  const native = readRecord(value);
  const content = message['content'] ?? message['parts'] ?? native?.['content'];
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((part: unknown) => {
    const block = readRecord(part);
    const textBlock = block?.['type'] === 'text' || block?.['type'] === 'output_text'
      || (native?.['type'] === 'assistant' && message['role'] === 'model' && block?.['type'] === undefined && block?.['thought'] !== true);
    return textBlock && typeof block?.['text'] === 'string' ? [block['text']] : [];
  }).join('\n');
}

/** Native export JSON and JSONL retain the same assistant evidence boundary. */
export function transcriptRecords(text: string): readonly unknown[] {
  try {
    const value: unknown = JSON.parse(text);
    const exported = readRecord(value);
    return Array.isArray(exported?.['messages']) ? exported['messages'] : [value];
  } catch {
    return text.split('\n').flatMap((line): unknown[] => {
      if (!line) return [];
      try { return [JSON.parse(line) as unknown]; } catch { return []; }
    });
  }
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
  for (const record of transcriptRecords(text)) {
      result.model ??= modelEvidenceFromAssistant(record);
      const assistantText = assistantTextFromRecord(record);
      if (assistantText.length > 0) result.output += assistantText + '\n';
  }
  return result;
}

export type PermissionDeniedEvidence = { readonly path: string; readonly code: string; readonly eventRef: string };

/** Only native tool outputs can prove the bounded write probe; assistant claims cannot. */
export function permissionDeniedFromToolRecord(value: unknown, path: string, eventRef: string, previous?: unknown): PermissionDeniedEvidence | null {
  const record = readRecord(value);
  if (record === undefined) return null;
  const message = readRecord(record['message']);
  const output = readRecord(record['output']);
  const toolCall = readRecord(record['toolCallResult']);
  const display = readRecord(toolCall?.['resultDisplay']);
  const texts: string[] = [];
  const event = readRecord(record['event']);
  const result = readRecord(event?.['result']);
  if (record['type'] === 'context.append_loop_event' && event?.['type'] === 'tool.result'
    && typeof event['toolCallId'] === 'string' && typeof result?.['output'] === 'string') texts.push(result['output']);
  const preceding = readRecord(previous);
  if (record['type'] === 'GENERIC' && record['source'] === 'MODEL' && record['status'] === 'DONE'
    && preceding?.['type'] === 'PLANNER_RESPONSE' && preceding['source'] === 'MODEL' && preceding['status'] === 'DONE'
    && typeof record['step_index'] === 'number' && preceding['step_index'] === record['step_index'] - 1
    && Array.isArray(preceding['tool_calls']) && preceding['tool_calls'].length === 1
    && readRecord(preceding['tool_calls'][0])?.['name'] === 'run_command' && typeof record['content'] === 'string') {
    texts.push(record['content']);
  }
  if (record['type'] === 'function_call_result' && typeof output?.['text'] === 'string') texts.push(output['text']);
  if (record['type'] === 'tool_result' && typeof display?.['output'] === 'string') texts.push(display['output']);
  const blocks = message?.['content'] ?? record['parts'];
  if (Array.isArray(blocks)) for (const part of blocks as unknown[]) {
    const block = readRecord(part);
    if (block?.['type'] === 'tool_result' && (record['type'] === 'user'
      || (record['type'] === 'message' && message?.['role'] === 'user'))) {
      if (typeof block['content'] === 'string') texts.push(block['content']);
      else if (Array.isArray(block['content'])) for (const item of block['content'] as unknown[]) {
        const text = readRecord(item);
        if (text?.['type'] === 'text' && typeof text['text'] === 'string') texts.push(text['text']);
      }
    }
    if (block?.['type'] === 'text' && message?.['role'] === 'toolResult' && typeof block['text'] === 'string') texts.push(block['text']);
    const state = readRecord(block?.['state']);
    if (block?.['type'] === 'tool' && state?.['status'] === 'completed' && typeof state['output'] === 'string') texts.push(state['output']);
  }
  for (const text of texts) for (const line of text.split('\n')) {
    try {
      const probe = readRecord(JSON.parse(line) as unknown);
      if (probe?.['permissionDenied'] === true && probe['path'] === path
        && typeof probe['code'] === 'string' && ['EROFS', 'EACCES', 'EPERM'].includes(probe['code'])) {
        return { path, code: probe['code'], eventRef };
      }
    } catch { continue; }
  }
  return null;
}

function readPermissionDeniedEvidence(transcriptRef: string, path: string): PermissionDeniedEvidence | null {
  if (!existsSync(transcriptRef) || statSync(transcriptRef).size > 512 * 1024) return null;
  const lines = readFileSync(transcriptRef, 'utf8').split('\n');
  let previous: unknown;
  for (const [index, line] of lines.entries()) {
    try {
      const record: unknown = JSON.parse(line);
      const step = readRecord(record)?.['step_index'];
      const proof = permissionDeniedFromToolRecord(record, path, typeof step === 'number' ? 'step:' + step : 'line:' + (index + 1), previous);
      previous = record;
      if (proof !== null) return proof;
    } catch { previous = undefined; }
  }
  return null;
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
  readonly taskId: string;
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
  readonly role: AcceptanceRole | 'utility';
  readonly launchId: string;
  readonly strategy: ReturnType<typeof prepareHarnessWorkerLaunch>;
  readonly stateRoot: string;
  readonly reporterPath: string;
  readonly reportPath: string;
  readonly spec?: string;
  readonly expectedAssistantText?: string;
}): Promise<LaunchOutcome> {
  const { fixture, binding, role, launchId, strategy } = input;
  const taskCreated = await fixture.backend.mutate(
    {
      operation: 'task-create',
      spec: input.spec ?? roleSpec(binding.harness, role === 'utility' ? 'finalizer' : role).spec,
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
  const prepared = await prepareAcceptanceWorker({
    backend: fixture.backend,
    strategy,
    worktreePath: fixture.projectDir,
    scope: fixture.scopeFor(launchId + ':terminal-create', { kind: 'worker-task', id: taskId }),
  });
  if (prepared.kind !== 'ready') return { kind: 'blocked', code: 'prepare_failed', message: 'prepared-terminal 失败：' + ('message' in prepared ? prepared.message : prepared.reason) };

  const started = await fixture.backend.mutate(
    { operation: 'worker-start', taskId, ...prepared.worker, worktree: 'path:' + fixture.projectDir, runId: fixture.runId, timeoutMs: WORKER_START_TIMEOUT_MS },
    fixture.scopeFor(launchId + ':worker-start', { kind: 'worker-task', id: taskId }),
  );
  if (started.kind !== 'accepted') return { kind: 'blocked', code: 'worker_start_failed', message: 'Orca 未接受 prepared Worker：' + started.kind };
  const dispatchId = stringField(started.value, 'dispatchId', 'dispatch_id');
  if (dispatchId === null) return { kind: 'blocked', code: 'dispatch_identity_missing', message: 'worker-start 回执缺少 dispatch id' };
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

  const proofInput = {
    report,
    workspace: fixture.projectDir,
    expectedStateRoot: report.stateRoot ?? report.codexHome ?? input.stateRoot,
    dispatchStartedAt,
    bindingDeadlineAt: new Date(Date.parse(dispatchStartedAt) + WORKER_START_TIMEOUT_MS + REPORT_DEADLINE_MS).toISOString(),
  };
  const proveBinding = () => role === 'utility'
    ? requireWorkerHarness(binding.harness).proveSession(proofInput).then((proof) => proof.kind === 'proven'
      ? { kind: 'bound' as const, binding: proof.proof }
      : { kind: 'unavailable' as const, code: 'transcript_unavailable', message: proof.reason })
    : bindHarnessSessionFromStartReport({
    facts: {
      harness: binding.harness,
      role,
      workerTaskId: taskId as unknown as WorkerTaskId,
      dispatchId: dispatchId as unknown as DispatchId,
      attemptId: launchId,
    },
    ...proofInput,
    expectedCodexHome: proofInput.expectedStateRoot,
  });
  // SessionStart may precede transcript creation; retry only the first exact report's read proof.
  const proofDeadline = Date.now() + 30_000;
  let bound = await proveBinding();
  while (bound.kind !== 'bound' && Date.now() < proofDeadline) {
    await new Promise((settle) => setTimeout(settle, Math.min(250, proofDeadline - Date.now())));
    if (Date.now() >= proofDeadline) break;
    bound = await proveBinding();
  }
  if (bound.kind !== 'bound') {
    const diagnosis = await diagnoseDispatch(fixture, dispatchId, prepared.preparedTerminal.handle);
    return { kind: 'blocked', code: bound.code, message: 'Session Binding 不可用：' + bound.message + '；' + diagnosis };
  }
  const terminalState = await waitForSettle(fixture.backend, dispatchId, SETTLE_DEADLINE_MS);
  if (terminalState !== 'succeeded' && terminalState !== 'completed' && terminalState !== 'done') {
    return { kind: 'blocked', code: 'worker_not_succeeded', message: `Worker 未完成：${terminalState ?? 'unknown'}；${await diagnoseDispatch(fixture, dispatchId, prepared.preparedTerminal.handle)}` };
  }
  // coverage 必须在真正 settled 之后读取，否则首个 event 后即 complete 会掩盖后续 tail 截断。
  let coverage = await requireWorkerHarness(binding.harness).inspectTranscript(bound.binding.transcriptRef);
  // Kilo's session.updated export can finish after worker_done; observe the same snapshot without redelivery.
  for (let attempt = 0; binding.harness === 'kilo' && coverage.kind !== 'covered' && attempt < 15; attempt += 1) {
    await new Promise((settle) => setTimeout(settle, 1_000));
    coverage = await requireWorkerHarness(binding.harness).inspectTranscript(bound.binding.transcriptRef);
  }
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
  if (binding.harness === 'hermes') {
    if (await prepareHermesRecoveryMaterial(modelTranscript, input.stateRoot, coverage.evidence) === null) return { kind: 'blocked', code: 'transcript_unavailable', message: 'Hermes 公开消息与已核验范围不一致' };
    modelTranscript = hermesRecoveryMaterialPath(input.stateRoot, modelTranscript);
  }
  if (binding.harness === 'cline') {
    if (prepareClineRecoveryMaterial(modelTranscript, input.stateRoot, coverage.evidence) === null) return { kind: 'blocked', code: 'transcript_unavailable', message: 'Cline 原生消息与已核验范围不一致' };
    modelTranscript = clineRecoveryMaterialPath(input.stateRoot, modelTranscript);
  }
  let transcriptEvidence = extractTranscriptEvidence(modelTranscript);
  const expectedAssistantText = input.expectedAssistantText
    ?? (role === 'finalizer' ? completionToken(binding.harness, role) : null);
  // worker_done 可以先于最终 assistant 响应落盘；只从精确来源等待，不用终端回显补结果。
  for (let attempt = 0; expectedAssistantText !== null && !transcriptEvidence.output.includes(expectedAssistantText) && attempt < 15; attempt += 1) {
    await new Promise((settle) => setTimeout(settle, 1_000));
    coverage = await requireWorkerHarness(binding.harness).inspectTranscript(bound.binding.transcriptRef);
    if (coverage.kind !== 'covered') return { kind: 'blocked', code: 'transcript_unavailable', message: coverage.reason };
    if (binding.harness === 'opencode' && await prepareOpencodeRecoveryMaterial(bound.binding.transcriptRef, input.stateRoot, coverage.evidence) === null) continue;
    transcriptEvidence = extractTranscriptEvidence(modelTranscript);
  }
  if (input.expectedAssistantText !== undefined && !transcriptEvidence.output.includes(input.expectedAssistantText)) {
    return { kind: 'blocked', code: 'assistant_evidence_missing', message: '精确 transcript 的预期 assistant 证据尚不可读' };
  }

  if (binding.harness === 'antigravity') {
    const native = readRecord(JSON.parse(readFileSync(input.reportPath + '.model.json', 'utf8')) as unknown);
    if (native?.['sessionId'] === bound.binding.providerSessionId && native['transcriptPath'] === bound.binding.transcriptRef
      && typeof native['model'] === 'string') transcriptEvidence.model = native['model'];
  }

  return {
    kind: 'ran',
    worker: {
      taskId,
      dispatchId,
      terminalHandle: prepared.preparedTerminal.handle,
      stateRoot: report.stateRoot ?? report.codexHome ?? input.stateRoot,
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

/** sessionPaths().stateRoot 是父目录（prepareState 再拼 launch digest）；实际隔离状态根是 dirname(reporterPath)。 */
function stateRootsFor(paths: ReturnType<typeof workerSessionPathsUnder>): { readonly parent: string; readonly actual: string } {
  return { parent: paths.stateRoot, actual: dirname(paths.reporterPath) };
}

function harnessLaunchInput(input: {
  readonly fixture: AcceptanceFixture;
  readonly binding: HarnessBinding;
  readonly launchId: string;
  readonly stateRoot: string;
  readonly reporterPath: string;
  readonly sandboxMode: ReturnType<typeof sandboxModeFor>;
}): WorkerHarnessLaunchInput {
  return {
    launchId: input.launchId,
    modelSelection: input.binding.modelSelection,
    sandboxMode: input.sandboxMode,
    stateRoot: input.stateRoot,
    sessionStartReporterPath: input.reporterPath,
  };
}

export type RoleRun = {
  readonly taskId: string | null;
  readonly contextToken: string | null;
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
  return { harness, role, kind: 'blocked', launchId, taskId: null, contextToken: null, dispatchId: null, sessionId: null, transcriptRef: null, stateRoot: null, reporterPath: null, coverage: null, terminalState: null, artifactOk: null, modelEvidence: null, blocker: { code, message } };
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
  const paths = workerSessionPathsUnder(binding.harness, join(fixture.root, 'state'), launchId);
  const roots = stateRootsFor(paths);
  installHarnessSessionReporter(binding.harness, paths);
  const strategy = prepareHarnessWorkerLaunch(binding.harness, harnessLaunchInput({
    fixture, binding, launchId, stateRoot: roots.parent, reporterPath: paths.reporterPath, sandboxMode: sandboxModeFor(role),
  }));
  const contextToken = role === 'validator' ? randomUUID() : null;
  const expected = roleSpec(binding.harness, role);
  const spec = contextToken === null ? expected.spec : expected.spec + '\n\n'
    + 'Remember this continuation marker only in this conversation (never in a repository file): ' + contextToken + '. '
    + 'State it in your assistant response as a pending follow-up: on the next Validator continuation, recall the marker and write it to the requested continuation file. Do not perform that follow-up now.';
  let outcome: LaunchOutcome;
  try {
    outcome = await launchPreparedTerminal({
      fixture, binding, role, launchId, strategy,
      spec,
      ...(contextToken === null ? {} : { expectedAssistantText: contextToken }),
      stateRoot: roots.actual, reporterPath: paths.reporterPath, reportPath: paths.reportPath,
    });
  } catch (error) {
    return blockedRole(binding.harness, role, launchId, 'launch_exception', error instanceof Error ? error.message : String(error));
  }
  if (outcome.kind === 'blocked') return blockedRole(binding.harness, role, launchId, outcome.code, outcome.message);
  const worker = outcome.worker;
  const artifactOk = expected.artifactPath === null
    ? worker.output.includes(completionToken(binding.harness, role))
    : existsSync(join(fixture.projectDir, expected.artifactPath)) && readFileSync(join(fixture.projectDir, expected.artifactPath), 'utf8').trim() === expected.artifactBody;
  return {
    harness: binding.harness, role, kind: 'ran', launchId,
    taskId: worker.taskId, contextToken,
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
  readonly dispatchId: string | null;
  readonly contextPreserved: boolean | null;
  readonly modelEvidence: string | null;
  readonly blocker: { readonly code: string; readonly message: string } | null;
};

export async function resumeRole(input: {
  readonly fixture: AcceptanceFixture;
  readonly binding: HarnessBinding;
  readonly original: RoleRun;
  readonly resumeLaunchId: string;
}): Promise<ResumeRun> {
  const { fixture, binding, original } = input;
  const blocked = (code: string, message: string): ResumeRun => ({ harness: binding.harness, kind: 'blocked', sessionId: null, sameSession: false, coverage: null, dispatchId: null, contextPreserved: null, modelEvidence: null, blocker: { code, message } });
  if (original.kind !== 'ran' || original.sessionId === null || original.transcriptRef === null || original.reporterPath === null || original.stateRoot === null) {
    return blocked('original_unavailable', '原 Session 没有可核验的精确身份，拒绝恢复');
  }
  const newPaths = resumeSessionPathsUnder(binding.harness, join(fixture.root, 'state'), input.resumeLaunchId, original.stateRoot);
  const { reporterPath, reportPath } = newPaths;
  installHarnessSessionReporter(binding.harness, { reporterPath: newPaths.reporterPath, reportPath: newPaths.reportPath });
  const base = harnessLaunchInput({
    fixture, binding, launchId: input.resumeLaunchId,
    stateRoot: stateRootsFor(newPaths).parent, reporterPath, sandboxMode: sandboxModeFor(original.role),
  });
  const strategy = prepareHarnessResumeLaunch(binding.harness, {
    ...base,
    sessionId: original.sessionId,
    codexHome: original.stateRoot,
    transcriptRef: original.transcriptRef,
  });
  let outcome: LaunchOutcome;
  const continuationFile = join('.companion', 'roles', binding.harness + '-validator-continuation.txt');
  const spec = original.role === 'validator'
    ? 'Continue the same Validator conversation. Recall the continuation marker from the previous turn; this prompt deliberately does not supply it. Write exactly that marker to ' + continuationFile + '. Do not read transcript/state files to find it. Do not install, use network, commit or push. Then report worker_done --outcome succeeded with the exact command and dispatch capability in the current supervision preamble.'
    : roleSpec(binding.harness, original.role).spec;
  try {
    outcome = await launchPreparedTerminal({
      fixture, binding, role: original.role, launchId: input.resumeLaunchId, strategy, spec,
      stateRoot: original.stateRoot, reporterPath, reportPath,
    });
  } catch (error) {
    return blocked('resume_exception', error instanceof Error ? error.message : String(error));
  }
  if (outcome.kind === 'blocked') return blocked(outcome.code, outcome.message);
  return {
    harness: binding.harness, kind: 'ran', sessionId: outcome.worker.sessionId,
    sameSession: outcome.worker.sessionId === original.sessionId, coverage: outcome.worker.coverage, blocker: null,
    dispatchId: outcome.worker.dispatchId, modelEvidence: outcome.worker.modelEvidence,
    contextPreserved: original.role !== 'validator' ? null : original.contextToken !== null
      && existsSync(join(fixture.projectDir, continuationFile))
      && readFileSync(join(fixture.projectDir, continuationFile), 'utf8').trim() === original.contextToken,
  };
}

export type RecoveryRun = {
  readonly kind: 'ran' | 'blocked';
  readonly sourceSessionId: string | null;
  readonly sourceTranscriptRef: string | null;
  readonly utility: LaunchedWorker | null;
  readonly capsuleRef: string | null;
  readonly coverage: TranscriptCoverageEvidence | null;
  readonly sourceBehaviorVerified: boolean;
  readonly readOnlyVerified: boolean;
  readonly permissionDenied: PermissionDeniedEvidence | null;
  readonly deliveryId: string | null;
  readonly deliveryAcked: boolean;
  readonly blocker: { readonly code: string; readonly message: string } | null;
};

/** Qwen coverage identifies native events by uuid; ordinal aliases are not event identities. */
export function qwenRecoverySourcesVerified(records: readonly unknown[], capsule: RecoveryCapsule, marker: string): boolean {
  const events = new Map<string, unknown>();
  for (const value of records) {
    const record = readRecord(value);
    if (typeof record?.['uuid'] === 'string') events.set(record['uuid'], value);
    if (typeof record?.['step_index'] === 'number') events.set('step:' + record['step_index'], value);
  }
  return capsule.sourceRefs.every((ref) => events.has(ref))
    && capsule.openActions.every((action) => events.has(action.sourceRef))
    && capsule.openActions.some((action) => action.description.includes(marker)
      && capsule.sourceRefs.includes(action.sourceRef)
      && assistantTextFromRecord(events.get(action.sourceRef)).includes(marker));
}

/** A real Utility dispatch; this fixture does not advance a Controller recovery lifecycle. */
export async function runRecoveryUtility(input: {
  readonly fixture: AcceptanceFixture; readonly binding: HarnessBinding;
  readonly original: RoleRun; readonly launchId: string;
}): Promise<RecoveryRun> {
  const { fixture, binding, original, launchId } = input;
  let result: RecoveryRun = {
    kind: 'blocked', sourceSessionId: original.sessionId, sourceTranscriptRef: original.transcriptRef,
    utility: null, capsuleRef: null, coverage: null, sourceBehaviorVerified: false,
    readOnlyVerified: false, permissionDenied: null, deliveryId: null, deliveryAcked: false, blocker: null,
  };
  try {
    if (original.kind !== 'ran' || original.taskId === null || original.sessionId === null
      || original.transcriptRef === null || original.contextToken === null) {
      throw new AcceptanceBlocker('original_unavailable', 'Recovery requires the precise original Validator session');
    }
    const harness = requireWorkerHarness(binding.harness);
    const identity = await harness.readTranscriptIdentity({ transcriptRef: original.transcriptRef, workspace: fixture.projectDir });
    if (!('providerSessionId' in identity) || identity.providerSessionId !== original.sessionId) {
      throw new AcceptanceBlocker('source_identity_unavailable', 'Independent original transcript identity failed');
    }
    const covered = await harness.inspectTranscript(original.transcriptRef);
    if (covered.kind !== 'covered') throw new AcceptanceBlocker('source_transcript_unavailable', covered.reason);
    result = { ...result, coverage: covered.evidence };
    const paths = workerSessionPathsUnder(binding.harness, join(fixture.root, 'state'), launchId);
    const roots = stateRootsFor(paths);
    installHarnessSessionReporter(binding.harness, paths);
    const strategy = harness.prepareReadOnlyLaunch(harnessLaunchInput({
      fixture, binding, launchId, stateRoot: roots.parent, reporterPath: paths.reporterPath, sandboxMode: 'read-only',
    }));
    const recipe = binding.harness === 'opencode'
      ? await prepareOpencodeRecoveryMaterial(original.transcriptRef, roots.actual, covered.evidence)
      : binding.harness === 'hermes'
        ? await prepareHermesRecoveryMaterial(original.transcriptRef, roots.actual, covered.evidence)
        : binding.harness === 'cline'
          ? prepareClineRecoveryMaterial(original.transcriptRef, roots.actual, covered.evidence)
          : harness.recoveryInstructions();
    if (recipe === null) throw new AcceptanceBlocker('source_transcript_unavailable', 'Precise public export unavailable');
    const probe = join('.companion', 'utility-write-probe-' + randomUUID());
    const probePath = join(fixture.projectDir, probe);
    const probeScript = 'const fs=require("node:fs");const path=' + JSON.stringify(probePath)
      + ';try{fs.writeFileSync(path,"unexpected-write",{flag:"wx"});console.log(JSON.stringify({path,permissionDenied:false,code:null}));}'
      + 'catch(e){console.log(JSON.stringify({path,permissionDenied:["EROFS","EACCES","EPERM"].includes(e.code),code:e.code}));}';
    const probeCommand = "node -e '" + probeScript.replaceAll("'", "'\\''") + "'";
    const envelope = buildUtilityWorkerEnvelope({
      workPackageId: 'WP-1', sourceWorkerTaskId: original.taskId as WorkerTaskId,
      sourceSegmentId: ('acceptance-segment:' + original.dispatchId) as SessionSegmentId, transcriptRef: original.transcriptRef,
    });
    const spec = JSON.stringify({ ...envelope, instructions: [
      ...recoveryCapsuleInstructions(original.transcriptRef, covered.evidence, recipe),
      ...(binding.harness === 'qwen-code' ? ['Qwen event sourceRefs are exact record.uuid strings, matching host coverage. Do not invent ordinal or line aliases. Cite the actual assistant event containing the pending marker.'] : []),
      'Qualification check, the sole exception to the no-write instruction: run this exact bounded probe once using your native shell tool: ' + probeCommand + '. Retain its actual tool output (permissionDenied/code/path); never retry or write elsewhere. Then read the precise original transcript. Include its pending continuation-marker follow-up in openActions, with the actual marker in description and its actual event sourceRef. This prompt does not supply the marker.',
    ] });
    const launched = await launchPreparedTerminal({
      fixture, binding, role: 'utility', launchId, strategy, spec,
      stateRoot: roots.actual, reporterPath: paths.reporterPath, reportPath: paths.reportPath,
    });
    if (launched.kind !== 'ran') throw new AcceptanceBlocker(launched.code, launched.message);
    const utilityTranscript = binding.harness === 'opencode'
      ? opencodeRecoveryMaterialPath(roots.actual, launched.worker.transcriptRef)
      : binding.harness === 'hermes' ? hermesRecoveryMaterialPath(roots.actual, launched.worker.transcriptRef)
        : binding.harness === 'cline' ? clineRecoveryMaterialPath(roots.actual, launched.worker.transcriptRef) : launched.worker.transcriptRef;
    const permissionDenied = readPermissionDeniedEvidence(utilityTranscript, probePath);
    result = { ...result, utility: launched.worker, permissionDenied,
      readOnlyVerified: permissionDenied !== null && !existsSync(probePath) };
    const deadline = Date.now() + SETTLE_DEADLINE_MS;
    while (Date.now() < deadline) {
      const batch = await readDeliveryBatch(fixture.backend, {
        backendIdentityRef: fixture.identity, runId: fixture.runId, types: ['worker_done', 'question', 'escalation'],
        wait: false, readMode: 'all', timeoutMs: Math.min(60_000, deadline - Date.now()),
      });
      if (batch.kind !== 'accepted') throw new AcceptanceBlocker('utility_delivery_unavailable', batch.message);
      const belongs = (message: DeliveryMessage): boolean => {
        if (message.runId !== fixture.runId || message.payload === null) return false;
        try {
          const payload = readRecord(JSON.parse(message.payload) as unknown);
          return payload?.['taskId'] === launched.worker.taskId && payload['dispatchId'] === launched.worker.dispatchId;
        } catch { return false; }
      };
      const message = batch.value.messages.find((candidate) => belongs(candidate) && candidate.type === 'worker_done');
      if (message !== undefined) {
        const body = message.body ?? '';
        const start = body.indexOf('{'), end = body.lastIndexOf('}');
        const raw: unknown = start >= 0 && end > start ? JSON.parse(body.slice(start, end + 1)) as unknown : null;
        const parsed = parseRecoveryCapsuleReport(raw, covered.evidence);
        if (!parsed.ok) throw new AcceptanceBlocker('utility_capsule_invalid', parsed.reason);
        const capsuleRef = capsuleRefOf(launchId);
        const written = writeRecoveryCapsuleBody({ stateRoot: join(fixture.root, 'state'), capsuleRef, capsule: parsed.capsule });
        if (!written.ok || readRecoveryCapsuleBody({ stateRoot: join(fixture.root, 'state'), capsuleRef }) === null) {
          throw new AcceptanceBlocker('utility_capsule_unreadable', 'Capsule persistence/readback failed');
        }
        let sourceBehaviorVerified = parsed.capsule.openActions.some((action) =>
          action.description.includes(original.contextToken ?? '') && parsed.capsule.sourceRefs.includes(action.sourceRef));
        if (binding.harness === 'qwen-code' || binding.harness === 'antigravity') {
          sourceBehaviorVerified = statSync(original.transcriptRef).size <= 512 * 1024
            && qwenRecoverySourcesVerified(readFileSync(original.transcriptRef, 'utf8').split('\n')
              .filter((line) => line.length > 0).map((line): unknown => JSON.parse(line) as unknown), parsed.capsule, original.contextToken);
        }
        result = { ...result, capsuleRef, sourceBehaviorVerified, deliveryId: batch.value.delivery?.deliveryId ?? null };
        // Public --all is a non-consuming snapshot, independent of the pending FIFO Delivery.
        // Never acknowledge it: other role messages have not been durably consumed here.
        return { ...result, kind: 'ran' };
      }
      if (batch.value.messages.some((candidate) => belongs(candidate) && (candidate.type === 'question' || candidate.type === 'escalation'))) {
        throw new AcceptanceBlocker('utility_needs_input', 'Utility requested intervention; fixture retained');
      }
      await new Promise((settle) => setTimeout(settle, 1_000));
    }
    throw new AcceptanceBlocker('utility_delivery_timeout', 'No exact Utility worker_done in the bounded window');
  } catch (error) {
    return { ...result, blocker: { code: error instanceof AcceptanceBlocker ? error.code : 'utility_exception', message: error instanceof Error ? error.message : String(error) } };
  }
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
  readonly orcaExecutable: string;
  readonly fixtureRoot: string | null;
  readonly runId: string | null;
  readonly coordinatorTerminalHandle: string | null;
  readonly setupBlocker: string | null;
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
};

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? fallback : JSON.stringify(value);
}

export function writeAcceptanceEvidence(directory: string, evidence: AcceptanceEvidence): string {
  mkdirSync(directory, { recursive: true });
  const stamp = evidence.startedAt.replace(/[:.]/gu, '-') + '-' + randomUUID();
  const jsonPath = join(directory, 'ip04-' + stamp + '.json');
  writeFileSync(jsonPath, JSON.stringify(evidence, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  const lines: string[] = [
    '# IP-04 Worker Harness Matrix — 真实隔离验收证据',
    '',
    '- 开始：' + evidence.startedAt,
    '- 结束：' + evidence.finishedAt,
    '- 隔离基目录：' + evidence.baseDir,
    '- 协调身份：' + evidence.identity,
    '- Orca executable：' + evidence.orcaExecutable,
    '- 保留现场：' + (evidence.fixtureRoot ?? '建立失败；见测试输出的现场路径'),
    '- Run：' + (evidence.runId ?? ''),
    '- 协调终端：' + (evidence.coordinatorTerminalHandle ?? ''),
    '- setup blocker：' + (evidence.setupBlocker ?? ''),
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
    if (resume !== undefined && resume !== null) {
      lines.push('| ' + name + ' | resume | ' + text(resume['kind']) + ' | | sameSession=' + text(resume['sameSession']) + ' | ' + text(resume['coverage']) + ' | | ' + (resume['blocker'] === null || resume['blocker'] === undefined ? '' : JSON.stringify(resume['blocker'])) + ' |');
    }
    for (const blocker of Array.isArray(harness['blockers']) ? (harness['blockers'] as readonly string[]) : []) {
      lines.push('| ' + name + ' | - | blocker | | | | | ' + blocker + ' |');
    }
  }
  writeFileSync(join(directory, 'ip04-' + stamp + '.md'), lines.join('\n') + '\n', { encoding: 'utf8', flag: 'wx' });
  return jsonPath;
}
