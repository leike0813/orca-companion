/**
 * 6.5 验收层：真实隔离 MiniMax-M3 Validator Recovery
 * （change: `m1-recover-execution`；spec `recovery/worker-sessions` 的
 * 「Recovery Capsule 必须由受限 Utility Worker 生成且按角色门判定」）。
 *
 * 它**只在显式选择隔离工作区、专用 Orca 身份与显式 Worker 模型后**运行：
 *
 * ```sh
 * ORCA_COMPANION_REAL_HARNESS=1 \
 * ORCA_COMPANION_REAL_REPO=<isolated-workspace> \
 * ORCA_COMPANION_REAL_IDENTITY=<dedicated-identity> \
 * ORCA_COMPANION_REAL_WORKER_MODEL=minimax-cn/MiniMax-M3 \
 * pnpm exec vitest run tests/recovery/acceptance/real-validator-partial.test.ts --no-file-parallelism
 * ```
 *
 * 端点、模型与凭据沿用 `.env.smoke` 的 `COORDINATOR_SMOKE_*` 变量（见该文件注释）：Anthropic 的 base
 * 写**不带 `v1`** 的地址（SDK 自己补 `/v1/messages`），OpenAI / Responses 的 base 写**带 `v1`** 的
 * 地址。凭据只以标准 provider 环境变量存在，不进入任何配置对象、不写入文件、不打印。
 *
 * 未显式开启时整个文件只留一条 skip 记录：**不加载 env 文件、不解析端点、不打开数据库、不发起任何
 * 真实调用**，也不干扰常规 `pnpm test`。
 *
 * ## 隔离护栏（照抄 `tests/integration/minimax-m3-*-smoke.test.ts`）
 *
 * - `ORCA_COMPANION_REAL_REPO` 必须是**显式选择**的隔离工作区：不存在的路径、Companion 自身仓库、
 *   Companion 的上级目录（范围过宽）以及混入非本次产物的工作区都直接失败，而不是静默跳过；
 * - 一次性 Git 项目建在该工作区内（`project-<identity>`），结束时整体删除；已存在同名项目即拒绝；
 * - 专用 Orca 身份：本次自己创建协调终端并从 `terminal-list` 取得句柄，自建 Run 并绑定到它；
 * - 不触碰用户主项目、不重启全局 Orca runtime、不修改 `references/orca`、不把凭据或 transcript 正文
 *   写入仓库。断言只读结构化字段，不比对大段文案。
 *
 * ## prepared-terminal 启动门
 *
 * Harness Adapter 在 worktree 内准备隔离 `CODEX_HOME` 与固定 trust bypass；Application 通过公开
 * terminal API 启动它，再以 `worker-start --terminal` 交给 Orca 正式接管。
 *
 * 清理会依次停止并释放本次 Dispatch、关闭专用终端，再删除一次性项目。真实 `partial` 仍由 fake
 * 覆盖；正常 Codex rollout 在中断后可完整读取，因此本文件的真实结论应为 `complete`。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { createCodexWorkerLaunch } from '../../../src/adapters/agents/codex-launch.js';
import {
  inspectCodexTranscript,
  proveCodexTranscript,
  type CodexSessionStartReport,
} from '../../../src/adapters/agents/codex-transcript.js';
import { parseRecoveryCapsuleReport } from '../../../src/adapters/agents/utility-worker.js';
import { ackDelivery, readDeliveryBatch } from '../../../src/adapters/orca-cli/delivery-reader.js';
import { readRecord } from '../../../src/adapters/orca-cli/operation-catalog.js';
import { createOrcaExecutionBackend } from '../../../src/adapters/orca-cli/orca-backend.js';
import { runProcess } from '../../../src/adapters/orca-cli/process-runner.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  OperationId,
  RuntimeIncarnationId,
} from '../../../src/application/dto/identity.js';
import type { TranscriptCoverageEvidence } from '../../../src/application/recovery/recovery-capsule.js';
import type { ExecutionBackend, ExecutionScope } from '../../../src/application/ports/execution-backend.js';
import { buildExecutionScope } from '../../../src/application/ports/execution-backend.js';
import {
  activatePreparedWorker,
  prepareWorkerLaunch,
  verifyPreparedWorker,
} from '../../../src/application/worker-launch.js';
import { evaluateRoleGate } from '../../../src/domain/recovery/role-gate.js';
import { toChildEnvironment } from '../../../src/interfaces/cli/main.js';
import type { DeliveryMessage } from '../../../src/application/dto/operation-outcome.js';

/** Companion 自身仓库：即便被写进 `ORCA_COMPANION_REAL_REPO` 也必须拒绝。 */
const COMPANION_REPOSITORY = resolve(fileURLToPath(new URL('../../../', import.meta.url)));

/** env 文件默认位置；可用 `ORCA_COMPANION_REAL_ENV_FILE` 覆盖。 */
const DEFAULT_ENV_FILE = join(COMPANION_REPOSITORY, '.env.smoke');

const REAL_SWITCH = 'ORCA_COMPANION_REAL_HARNESS';
const WORKSPACE_VAR = 'ORCA_COMPANION_REAL_REPO';
const IDENTITY_VAR = 'ORCA_COMPANION_REAL_IDENTITY';
const WORKER_MODEL_VAR = 'ORCA_COMPANION_REAL_WORKER_MODEL';
const ENV_FILE_VAR = 'ORCA_COMPANION_REAL_ENV_FILE';

/** 专用协调身份引用；adapter 把它解析成本次自建终端的句柄，句柄不进入 DTO。 */
const COORDINATOR_IDENTITY_REF = 'companion-real-recovery';

/** 6.5 只允许 MiniMax-M3 作为 Validator 的模型；派发前显式绑定，缺失或不是它即失败。 */
const REQUIRED_WORKER_MODEL_FRAGMENT = 'MiniMax-M3';

const WORKER_START_TIMEOUT_MS = 300_000;
const FIRST_OUTPUT_DEADLINE_MS = 45_000;
const SESSION_START_DEADLINE_MS = 120_000;
const UTILITY_DEADLINE_MS = 360_000;

/**
 * 「未开启时什么都没做」的可观察形式。
 *
 * 三个标记都只在显式开启后才可能被置位，因此关掉开关时它们同时为 `false`，可以直接断言。
 */
const DIAGNOSTICS = {
  envFileLoaded: false,
  endpointsResolved: false,
  realCallAttempted: false,
};

function parseEnvFile(text: string): ReadonlyMap<string, string> {
  const entries = new Map<string, string>();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const separator = line.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).replace(/^export\s+/, '').trim();
    let value = line.slice(separator + 1).trim();
    const quoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")));
    if (quoted) {
      value = value.slice(1, -1);
    }
    if (key.length > 0) {
      entries.set(key, value);
    }
  }
  return entries;
}

/** 真实环境优先：已存在的变量不会被文件覆盖。 */
function mergeEnvFileIntoProcess(path: string): number {
  if (!existsSync(path)) {
    return 0;
  }
  const entries = parseEnvFile(readFileSync(path, 'utf8'));
  let applied = 0;
  for (const [key, value] of entries) {
    if (value.length === 0 || process.env[key] !== undefined) {
      continue;
    }
    process.env[key] = value;
    applied += 1;
  }
  DIAGNOSTICS.envFileLoaded = true;
  return applied;
}

export type RealEndpointProfile = {
  readonly id: string;
  /** 归一化后的 base URL：已按各家 SDK 的拼接规则补上或去掉 `/v1`。 */
  readonly baseUrl: string;
  /** 实际会被请求的完整路径，只用于诊断。 */
  readonly endpointUrl: string;
  readonly model: string;
  readonly keyEnvVar: string;
};

type EndpointSource = {
  readonly id: string;
  readonly baseUrlVar: string;
  /** 未设置主变量时的回退变量；Responses 与 Chat Completions 通常同一个 host。 */
  readonly baseUrlFallbackVar?: string;
  readonly modelVar: string;
  readonly keyEnvVarVar: string;
  readonly defaultKeyEnvVar: string;
  /** 把端点地址归一化成该 SDK 需要的 base URL。 */
  readonly normalize: (raw: string) => string;
  /** 该 SDK 会在 base URL 之后拼出的路径。 */
  readonly endpointPath: string;
};

function trimSlashes(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Anthropic SDK 自己拼 `/v1/messages`，所以 base 里不能再带 `v1`，否则会变成 `/v1/v1/messages`。 */
function baseWithoutV1(raw: string): string {
  const base = trimSlashes(raw);
  return base.endsWith('/v1') ? base.slice(0, -'/v1'.length) : base;
}

/** OpenAI SDK 直接拼 `/chat/completions` 与 `/responses`，所以 base 必须自带 `/v1`。 */
function baseWithV1(raw: string): string {
  const base = trimSlashes(raw);
  return base.endsWith('/v1') ? base : `${base}/v1`;
}

const ENDPOINT_SOURCES: readonly EndpointSource[] = [
  {
    id: 'anthropic',
    baseUrlVar: 'COORDINATOR_SMOKE_ANTHROPIC_BASE_URL',
    modelVar: 'COORDINATOR_SMOKE_ANTHROPIC_MODEL',
    keyEnvVarVar: 'COORDINATOR_SMOKE_ANTHROPIC_KEY_ENV',
    defaultKeyEnvVar: 'ANTHROPIC_API_KEY',
    normalize: baseWithoutV1,
    endpointPath: '/v1/messages',
  },
  {
    id: 'openai',
    baseUrlVar: 'COORDINATOR_SMOKE_OPENAI_BASE_URL',
    modelVar: 'COORDINATOR_SMOKE_OPENAI_MODEL',
    keyEnvVarVar: 'COORDINATOR_SMOKE_OPENAI_KEY_ENV',
    defaultKeyEnvVar: 'OPENAI_API_KEY',
    normalize: baseWithV1,
    endpointPath: '/chat/completions',
  },
  {
    id: 'openai-responses',
    baseUrlVar: 'COORDINATOR_SMOKE_RESPONSES_BASE_URL',
    baseUrlFallbackVar: 'COORDINATOR_SMOKE_OPENAI_BASE_URL',
    modelVar: 'COORDINATOR_SMOKE_RESPONSES_MODEL',
    keyEnvVarVar: 'COORDINATOR_SMOKE_RESPONSES_KEY_ENV',
    defaultKeyEnvVar: 'OPENAI_API_KEY',
    normalize: baseWithV1,
    endpointPath: '/responses',
  },
];

/** 显式停用某个端点的标记；用于回退变量默认生效时单独关掉一条路径。 */
const DISABLED_MARKERS: ReadonlySet<string> = new Set(['-', 'off', 'skip', 'none', 'disabled']);

function resolveRawBaseUrl(
  source: EndpointSource,
): { readonly kind: 'value'; readonly raw: string } | { readonly kind: 'unset' } {
  const primary = process.env[source.baseUrlVar];
  if (primary !== undefined) {
    const value = primary.trim();
    if (DISABLED_MARKERS.has(value.toLowerCase())) {
      return { kind: 'unset' };
    }
    if (value.length > 0) {
      return { kind: 'value', raw: value };
    }
  }
  const fallback = source.baseUrlFallbackVar === undefined ? undefined : process.env[source.baseUrlFallbackVar];
  if (fallback !== undefined && fallback.trim().length > 0) {
    return { kind: 'value', raw: fallback.trim() };
  }
  return { kind: 'unset' };
}

function readEndpointProfiles(): readonly RealEndpointProfile[] {
  const profiles: RealEndpointProfile[] = [];
  for (const source of ENDPOINT_SOURCES) {
    const resolved = resolveRawBaseUrl(source);
    if (resolved.kind !== 'value') {
      continue;
    }
    const baseUrl = source.normalize(resolved.raw);
    profiles.push({
      id: source.id,
      baseUrl,
      endpointUrl: `${baseUrl}${source.endpointPath}`,
      model: process.env[source.modelVar] ?? 'MiniMax-M3',
      keyEnvVar: process.env[source.keyEnvVarVar] ?? source.defaultKeyEnvVar,
    });
  }
  return profiles;
}

/** 一个 key 供各端点共用：把它注入各自集成的标准环境变量。 */
function injectSharedKey(profiles: readonly RealEndpointProfile[]): void {
  const shared = process.env['COORDINATOR_SMOKE_API_KEY'] ?? '';
  if (shared.length === 0) {
    return;
  }
  for (const profile of profiles) {
    if (process.env[profile.keyEnvVar] === undefined) {
      process.env[profile.keyEnvVar] = shared;
    }
  }
}

export type RealPlan =
  | { readonly kind: 'skip'; readonly reason: string }
  | {
      readonly kind: 'run';
      readonly workspace: string;
      readonly identity: string;
      /** Validator Worker 的显式模型绑定；在派发前核验，缺失即失败。 */
      readonly workerModel: string;
      readonly profiles: readonly RealEndpointProfile[];
      readonly envFile: string;
      readonly envEntriesApplied: number;
    };

/**
 * 解析运行计划。
 *
 * 开关、隔离工作区、专用身份与 Worker 模型必须来自真实环境：显式开启这件事不能藏在 env 文件里。
 * 任一缺失都退化为 skip 而不是「用一个默认值跑真实调用」。
 */
function resolveRealPlan(): RealPlan {
  if (process.env[REAL_SWITCH] !== '1') {
    return { kind: 'skip', reason: `${REAL_SWITCH} 未显式开启` };
  }
  const workspace = (process.env[WORKSPACE_VAR] ?? '').trim();
  if (workspace.length === 0) {
    return { kind: 'skip', reason: `${WORKSPACE_VAR} 未显式选择隔离工作区` };
  }
  const identity = (process.env[IDENTITY_VAR] ?? '').trim();
  if (identity.length === 0) {
    return { kind: 'skip', reason: `${IDENTITY_VAR} 未显式选择专用 Orca 身份` };
  }
  const workerModel = (process.env[WORKER_MODEL_VAR] ?? '').trim();
  if (workerModel.length === 0) {
    return { kind: 'skip', reason: `${WORKER_MODEL_VAR} 未显式绑定 Validator 模型，默认不派发真实 Worker` };
  }
  if (!workerModel.includes(REQUIRED_WORKER_MODEL_FRAGMENT)) {
    // 显式开启却绑定了别的模型：这是配置错误，不是「跳过」，必须在派发前失败。
    throw new Error(
      `6.5 只允许 ${REQUIRED_WORKER_MODEL_FRAGMENT} 作为 Validator 模型，收到 ${workerModel}`,
    );
  }
  const envFile = process.env[ENV_FILE_VAR] ?? DEFAULT_ENV_FILE;
  const envEntriesApplied = mergeEnvFileIntoProcess(envFile);
  const profiles = readEndpointProfiles();
  DIAGNOSTICS.endpointsResolved = true;
  injectSharedKey(profiles);
  return { kind: 'run', workspace: resolve(workspace), identity, workerModel, profiles, envFile, envEntriesApplied };
}

const PLAN = resolveRealPlan();

/** 观测输出；只记录，不参与断言或失败判定。 */
function writeObservation(entry: Readonly<Record<string, unknown>>): void {
  process.stdout.write(`[real-harness] ${JSON.stringify(entry)}\n`);
}

/**
 * 校验显式选择的隔离工作区。
 *
 * 门禁必须在显式开启后**真的检查**：不存在的路径、不是目录、Companion 自身仓库、包含 Companion 的
 * 过宽路径以及混入非本次产物的内容都直接失败，而不是静默跳过。
 */
export function assertIsolatedWorkspace(workspace: string, allowedEntries: ReadonlySet<string>): void {
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
    throw new Error(`${WORKSPACE_VAR} 不是存在的目录：${workspace}`);
  }
  if (workspace === COMPANION_REPOSITORY) {
    throw new Error(`${WORKSPACE_VAR} 指向 Companion 自身仓库，真实 harness 必须在隔离工作区运行：${workspace}`);
  }
  if (COMPANION_REPOSITORY.startsWith(`${workspace}/`)) {
    throw new Error(`${WORKSPACE_VAR} 是 Companion 的上级目录，范围过宽：${workspace}`);
  }
  const unexpected = readdirSync(workspace).filter((name) => !allowedEntries.has(name));
  if (unexpected.length > 0) {
    throw new Error(
      `隔离工作区混入了非本次产物（只允许本次自己的 project-* 目录）；请改用空目录，当前多余内容：${unexpected.join(', ')}`,
    );
  }
}

function currentEnvironment(): Record<string, string> {
  return toChildEnvironment(process.env);
}

async function runCaptured(
  executable: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ readonly ok: boolean; readonly stdout: string; readonly stderr: string; readonly exitCode: number | null }> {
  const result = await runProcess({
    executable,
    args: [...args],
    cwd,
    env: currentEnvironment(),
    timeoutMs,
    limits: { maxBytes: 256 * 1024, maxLines: 4_000 },
  });
  if (result.kind !== 'completed') {
    return { ok: false, stdout: '', stderr: `进程未完成：${result.kind}`, exitCode: null };
  }
  return { ok: result.exitCode === 0, stdout: result.stdout.text, stderr: result.stderr.text, exitCode: result.exitCode };
}

/** 一次性项目的夹具：一个真实的 range 模块加一组会暴露缺陷的验证用例。 */
function writeFixtureFiles(projectDir: string): void {
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  mkdirSync(join(projectDir, 'tests'), { recursive: true });
  mkdirSync(join(projectDir, '.companion'), { recursive: true });
  writeFileSync(
    join(projectDir, 'src', 'range.ts'),
    [
      'export function clampRange(start: number, end: number, limit: number): [number, number] {',
      '  const lower = Math.max(0, start);',
      '  const upper = Math.min(limit, end);',
      '  return [lower, upper];',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(projectDir, 'tests', 'check.mjs'),
    [
      "import { clampRange } from '../src/range.ts';",
      'const cases = [',
      "  { name: 'R1 normal', args: [2, 5, 10], expected: [2, 5] },",
      "  { name: 'R2 negative start', args: [-3, 5, 10], expected: [0, 5] },",
      "  { name: 'R3 end beyond limit', args: [2, 99, 10], expected: [2, 10] },",
      "  { name: 'R4 start beyond end', args: [8, 3, 10], expected: [3, 8] },",
      '];',
      'let failed = 0;',
      'for (const c of cases) {',
      '  const got = clampRange(...c.args);',
      '  const ok = JSON.stringify(got) === JSON.stringify(c.expected);',
      '  if (!ok) failed += 1;',
      "  console.log(`${ok ? 'PASS' : 'FAIL'} ${c.name} expected=${JSON.stringify(c.expected)} got=${JSON.stringify(got)}`);",
      '}',
      'console.log(`summary ${cases.length - failed}/${cases.length} passed`);',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(join(projectDir, 'README.md'), '# isolated real-harness validator project\n', 'utf8');
  writeFileSync(
    join(projectDir, '.companion', 'session-start.mjs'),
    [
      "import { appendFileSync } from 'node:fs';",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "for await (const chunk of process.stdin) input += chunk;",
      "const event = JSON.parse(input);",
      `appendFileSync(${JSON.stringify(join(projectDir, '.companion', 'session-start.jsonl'))}, JSON.stringify({`,
      "  sessionId: event.session_id ?? null,",
      "  transcriptPath: event.transcript_path ?? null,",
      // 只读该次进程真实的 CODEX_HOME；没有注入就如实报 null，绝不退回用户级 ~/.codex。
      "  codexHome: process.env.CODEX_HOME ?? null,",
      "  cwd: event.cwd ?? null,",
      "  model: event.model ?? null,",
      "  observedAt: new Date().toISOString(),",
      "}) + '\\n', 'utf8');",
      "process.stdout.write('{}\\n');",
      '',
    ].join('\n'),
    'utf8',
  );
}

/** Validator 任务信封正文：多步验证，确保中断发生时 transcript 已经真实产生内容。 */
const VALIDATOR_SPEC = [
  'You are the Validator worker for work package WP-1 in a throwaway repository.',
  'Your job is independent verification, not implementation.',
  'Work only inside the current directory. Do not commit, push, publish, deploy, install dependencies, or use the network.',
  'Do not modify any file under src/.',
  'Verification target: src/range.ts must implement clampRange(start, end, limit) satisfying four requirements:',
  'R1 normal window, R2 negative start clamps to 0, R3 end beyond limit clamps to limit,',
  'R4 when start is greater than end the result is the ordered pair of the clamped bounds.',
  'Proceed strictly step by step, one shell command per step, and print "step <n>: <result>" after each step.',
  'Step 1: read src/range.ts.',
  'Step 2: run the existing case runner with exactly: node tests/check.mjs',
  'Steps 3 to 12: for step n run one individual probe with: node -e "console.log(clampRange(...))" style commands, one case per step.',
  'Step 13: write validation-report.json containing {"workPackageId":"WP-1","requirements":[{"id":"R1","verdict":"pass|fail","evidence":"..."}],"overall":"pass|fail"} and nothing else.',
  'Report the absolute path of validation-report.json when finished.',
].join(' ');

type RealFixture = {
  readonly projectDir: string;
  readonly backend: ExecutionBackend;
  readonly runId: string;
  readonly coordinatorTerminalHandle: string;
  /** 变更 scope 的构造器：身份、Run 与 consumer generation 由本夹具持有。 */
  readonly scopeFor: (operationId: string, target: { readonly kind: string; readonly id: string }) => ExecutionScope;
  /** 登记本次真实的 Worker Dispatch，让清理阶段能连它的 agent terminal 一起收掉。 */
  readonly noteWorkerDispatch: (dispatchId: string, agentTerminalHandle: string | null) => void;
  /** external terminal 不归 worker-stop 所有；中断时必须精确关闭并读回不存在。 */
  readonly closeWorkerTerminal: (dispatchId: string) => Promise<void>;
  readonly dispose: () => Promise<void>;
};

async function initGitRepository(projectDir: string): Promise<void> {
  mkdirSync(projectDir, { recursive: true });
  const result = await runCaptured('git', ['init', '-q', '-b', 'main'], projectDir, 30_000);
  if (!result.ok) {
    throw new Error(`无法在隔离工作区中初始化一次性 Git 项目：${projectDir}（${result.stderr.trim()}）`);
  }
}

/**
 * 建立一次性的真实夹具。
 *
 * 每一步都走真实路径：真实 Git 项目、真实 `orca repo add`、真实协调终端与真实自建 Run。夹具只
 * 提供身份与现场，不代替任何控制闭环判定。
 */
async function createRealFixture(plan: Extract<RealPlan, { kind: 'run' }>): Promise<RealFixture> {
  const projectName = `project-${plan.identity}`;
  assertIsolatedWorkspace(plan.workspace, new Set([projectName]));
  const projectDir = join(plan.workspace, projectName);
  const userConfigPath = join(process.env['CODEX_HOME'] ?? join(homedir(), '.codex'), 'config.toml');
  const userConfigBefore = existsSync(userConfigPath) ? readFileSync(userConfigPath, 'utf8') : null;
  if (existsSync(projectDir)) {
    throw new Error(`一次性项目目录已存在，真实 harness 需要干净项目：${projectDir}`);
  }
  await initGitRepository(projectDir);
  writeFixtureFiles(projectDir);
  const committed = await runCaptured(
    'git',
    ['-c', 'user.email=real-harness@example.invalid', '-c', 'user.name=real-harness', 'add', '-A'],
    projectDir,
    30_000,
  );
  if (!committed.ok) {
    throw new Error(`无法暂存隔离夹具：${committed.stderr.trim()}`);
  }
  const commit = await runCaptured(
    'git',
    ['-c', 'user.email=real-harness@example.invalid', '-c', 'user.name=real-harness', 'commit', '-q', '-m', 'fixture'],
    projectDir,
    30_000,
  );
  if (!commit.ok) {
    throw new Error(`无法提交隔离夹具：${commit.stderr.trim()}`);
  }

  // 隔离夹具注册：这是现场搭建，不属于控制闭环；Orca 没有公开的 repo remove。
  const registered = await runCaptured('orca', ['repo', 'add', '--path', projectDir, '--json'], projectDir, 60_000);
  if (!registered.ok) {
    throw new Error(`无法把一次性项目注册进 Orca：${registered.stderr.trim()}${registered.stdout.trim()}`);
  }

  const identity: { handle: string | undefined } = { handle: undefined };
  const backend = createOrcaExecutionBackend({
    cwd: projectDir,
    env: currentEnvironment(),
    resolveIdentityHandle: (ref) => (ref === COORDINATOR_IDENTITY_REF ? identity.handle : undefined),
  });

  // 建立 scope 的事实由本夹具持有；模型与 Worker 不能填写它们。
  let runId = '';
  const scopeFor = (operationId: string, target: { readonly kind: string; readonly id: string }): ExecutionScope =>
    buildExecutionScope({
      coordinationScopeId: `${plan.identity}:scope` as CoordinationScopeId,
      coordinatorSessionId: `${plan.identity}:session` as CoordinatorSessionId,
      runtimeIncarnationId: `${plan.identity}:incarnation` as RuntimeIncarnationId,
      fencingGeneration: 1,
      backendIdentityRef: COORDINATOR_IDENTITY_REF,
      operationId,
      target,
      expectedRevision: 0,
      timeoutMs: WORKER_START_TIMEOUT_MS,
      authority:
        runId.length === 0
          ? { kind: 'route_planning' }
          : {
              kind: 'execution_coordination',
              graphGeneration: 1,
              authorizationId: `${plan.identity}:authorization`,
              runId,
              consumerGeneration: 1,
            },
    });

  const projectTarget = { kind: 'work-package', id: `${plan.identity}:setup` };
  const created = await backend.mutate(
    {
      operation: 'terminal-create',
      worktree: `path:${projectDir}`,
      title: `${plan.identity} coordinator`,
      command: process.env['SHELL'] ?? 'sh',
    },
    scopeFor(`${plan.identity}:terminal-create`, projectTarget),
  );
  if (created.kind !== 'accepted') {
    throw new Error(`无法创建专用协调终端：${created.kind === 'rejected' ? created.message : created.reason}`);
  }

  // 句柄只从 terminal-list 的存活事实取得，不从 create 回执猜字段。
  const listed = await backend.query({ operation: 'terminal-list', worktree: `path:${projectDir}` });
  if (listed.kind !== 'accepted') {
    throw new Error(`无法列举一次性项目的终端：${listed.code} ${listed.message}`);
  }
  const terminals = (listed.value as { readonly terminals?: readonly Record<string, unknown>[] }).terminals ?? [];
  const live = terminals.find((entry) => entry['connected'] === true && entry['writable'] === true);
  const handle = typeof live?.['handle'] === 'string' ? live['handle'] : undefined;
  if (handle === undefined) {
    throw new Error('专用协调终端没有可用的存活句柄，拒绝在没有专用身份的情况下继续');
  }
  identity.handle = handle;

  const runCreated = await backend.mutate(
    {
      operation: 'run-create',
      objective: 'Orca Companion m1-recover-execution 6.5 isolated real validator recovery',
    },
    scopeFor(`${plan.identity}:run-create`, projectTarget),
  );
  if (runCreated.kind !== 'accepted') {
    throw new Error(`无法建立专用 Run：${runCreated.kind === 'rejected' ? runCreated.message : runCreated.reason}`);
  }
  const current = await backend.query({ operation: 'run-current', backendIdentityRef: COORDINATOR_IDENTITY_REF });
  if (current.kind !== 'accepted') {
    throw new Error(`无法读回专用 Run：${current.code} ${current.message}`);
  }
  const run = (current.value as { readonly run?: { readonly runId?: unknown } | null }).run ?? null;
  if (run === null || typeof run.runId !== 'string' || run.runId.length === 0) {
    throw new Error('专用身份下没有绑定到任何 Run，6.5 无法继续');
  }
  runId = run.runId;

  // 本次真实的 Worker Dispatch：清理时先收 agent terminal，再删项目，避免残留进程回写已删目录。
  const workers: { dispatchId: string; agentTerminalHandle: string | null; terminalClosed: boolean }[] = [];
  const noteWorkerDispatch = (dispatchId: string, agentTerminalHandle: string | null): void => {
    workers.push({ dispatchId, agentTerminalHandle, terminalClosed: false });
  };
  const closeWorkerTerminal = async (dispatchId: string): Promise<void> => {
    const worker = workers.find((entry) => entry.dispatchId === dispatchId);
    if (worker?.agentTerminalHandle === null || worker?.agentTerminalHandle === undefined) {
      throw new Error(`Dispatch ${dispatchId} 没有可关闭的 exact external terminal`);
    }
    const closed = await backend.mutate(
      { operation: 'terminal-close', terminal: worker.agentTerminalHandle },
      scopeFor(`${plan.identity}:terminal-interrupt:${dispatchId}`, { kind: 'worker-dispatch', id: dispatchId }),
    );
    if (closed.kind !== 'accepted') {
      throw new Error(`关闭 Validator external terminal 失败：${closed.kind}`);
    }
    worker.terminalClosed = true;
    const listed = await backend.query({ operation: 'terminal-list', worktree: `path:${projectDir}` });
    const terminals = listed.kind === 'accepted'
      ? ((listed.value as { readonly terminals?: readonly Record<string, unknown>[] }).terminals ?? [])
      : [];
    if (
      listed.kind !== 'accepted' ||
      terminals.some(
        (terminal) => terminal['handle'] === worker.agentTerminalHandle && terminal['connected'] === true,
      )
    ) {
      throw new Error(`Validator external terminal 关闭后仍可读回：${worker.agentTerminalHandle}`);
    }
  };

  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) {
      return;
    }
    disposed = true;
    const cleanupFailures: string[] = [];
    for (const worker of workers) {
      // 已收尾的 Dispatch 上是空操作；未收尾时它负责 fence，随后 release 关闭 agent terminal。
      await runCaptured(
        'orca',
        ['orchestration', 'worker-stop', '--dispatch', worker.dispatchId, '--json'],
        projectDir,
        60_000,
      );
      await runCaptured(
        'orca',
        ['orchestration', 'worker-release', '--dispatch', worker.dispatchId, '--json'],
        projectDir,
        60_000,
      );
      if (worker.agentTerminalHandle !== null && !worker.terminalClosed) {
        const closed = await backend.mutate(
          { operation: 'terminal-close', terminal: worker.agentTerminalHandle },
          scopeFor(`${plan.identity}:terminal-close:${worker.dispatchId}`, {
            kind: 'worker-dispatch',
            id: worker.dispatchId,
          }),
        );
        if (closed.kind !== 'accepted') {
          cleanupFailures.push(`worker terminal ${worker.agentTerminalHandle}: ${closed.kind}`);
        }
      }
    }
    // 专用协调终端与一次性项目都整体清理；Orca 侧没有公开的单条 repo 删除入口。
    const coordinatorClosed = await backend.mutate(
      { operation: 'terminal-close', terminal: handle },
      scopeFor(`${plan.identity}:coordinator-terminal-close`, projectTarget),
    );
    if (coordinatorClosed.kind !== 'accepted') {
      cleanupFailures.push(`coordinator terminal ${handle}: ${coordinatorClosed.kind}`);
    }
    const userConfigAfter = existsSync(userConfigPath) ? readFileSync(userConfigPath, 'utf8') : null;
    if (userConfigAfter !== userConfigBefore) {
      cleanupFailures.push(`用户级 Codex 配置被修改：${userConfigPath}`);
    }
    rmSync(projectDir, { recursive: true, force: true });
    if (cleanupFailures.length > 0) {
      throw new Error(`真实夹具清理未完成：${cleanupFailures.join('；')}`);
    }
  };

  writeObservation({
    kind: 'real_fixture',
    identity: plan.identity,
    workspace: plan.workspace,
    project: projectDir,
    runId,
    envFile: plan.envFile,
    envEntriesApplied: plan.envEntriesApplied,
    endpoints: plan.profiles.map((profile) => ({
      profile: profile.id,
      endpoint: profile.endpointUrl,
      model: profile.model,
    })),
  });

  return {
    projectDir,
    backend,
    runId,
    coordinatorTerminalHandle: handle,
    scopeFor,
    noteWorkerDispatch,
    closeWorkerTerminal,
    dispose,
  };
}

async function startPreparedCodexWorker(input: {
  readonly fixture: RealFixture;
  readonly taskId: string;
  readonly launchId: string;
  readonly operationPrefix: string;
  readonly model: string;
  readonly sandboxMode: 'read-only' | 'workspace-write' | 'read-only-local-control';
}): Promise<{ readonly dispatchId: string; readonly terminalHandle: string }> {
  const strategy = createCodexWorkerLaunch({
    launchId: input.launchId,
    model: input.model,
    sandboxMode: input.sandboxMode,
    sessionStartReporterPath: join(input.fixture.projectDir, '.companion', 'session-start.mjs'),
  });
  const prepared = await prepareWorkerLaunch({
    backend: input.fixture.backend,
    strategy,
    worktreeId: `path:${input.fixture.projectDir}`,
    worktreePath: input.fixture.projectDir,
    timeoutMs: WORKER_START_TIMEOUT_MS,
    createTerminal: async (mutation) => {
      const operationId = `${input.operationPrefix}:terminal-create` as OperationId;
      const outcome = await input.fixture.backend.mutate(
        mutation,
        input.fixture.scopeFor(operationId, { kind: 'worker-task', id: input.taskId }),
      );
      if (outcome.kind === 'accepted') {
        return { kind: 'accepted' };
      }
      return outcome.kind === 'rejected'
        ? outcome
        : { kind: 'unknown', operationId, reason: outcome.reason };
    },
  });
  if (prepared.kind !== 'ready') {
    throw new Error(`Codex prepared-terminal 失败：${'message' in prepared ? prepared.message : prepared.reason}`);
  }
  const started = await input.fixture.backend.mutate(
    {
      operation: 'worker-start',
      taskId: input.taskId,
      ...prepared.worker,
      worktree: `path:${input.fixture.projectDir}`,
      runId: input.fixture.runId,
      timeoutMs: WORKER_START_TIMEOUT_MS,
    },
    input.fixture.scopeFor(`${input.operationPrefix}:worker-start`, { kind: 'worker-task', id: input.taskId }),
  );
  if (started.kind !== 'accepted') {
    throw new Error(`Orca 未接受 prepared Worker：${started.kind === 'rejected' ? started.message : started.reason}`);
  }
  const dispatchId = stringField(started.value, 'dispatchId', 'dispatch_id');
  if (dispatchId === null) {
    throw new Error('prepared worker-start 回执缺少 dispatch id');
  }
  const activated = await activatePreparedWorker({
    backend: input.fixture.backend,
    terminal: prepared.preparedTerminal,
    submitTerminal: async (mutation) => {
      const operationId = `${input.operationPrefix}:terminal-submit` as OperationId;
      const outcome = await input.fixture.backend.mutate(
        mutation,
        input.fixture.scopeFor(operationId, { kind: 'worker-task', id: input.taskId }),
      );
      if (outcome.kind === 'accepted') {
        return { kind: 'accepted' };
      }
      return outcome.kind === 'rejected'
        ? outcome
        : { kind: 'unknown', operationId, reason: outcome.reason };
    },
  });
  if (activated.kind !== 'accepted') {
    throw new Error(`prepared Worker draft 提交失败：${'message' in activated ? activated.message : activated.reason}`);
  }
  const adoption = await verifyPreparedWorker(input.fixture.backend, dispatchId, prepared.preparedTerminal);
  if (adoption !== null || prepared.preparedTerminal === null) {
    throw new Error(
      adoption === null
        ? 'prepared Worker 缺少 external terminal 绑定'
        : `prepared Worker 接管无法核验：${'message' in adoption ? adoption.message : adoption.reason}`,
    );
  }
  input.fixture.noteWorkerDispatch(dispatchId, prepared.preparedTerminal.handle);
  return { dispatchId, terminalHandle: prepared.preparedTerminal.handle };
}

/** 从 `task-create` 的原始回执里取出可核验的 Orca Task 身份（回执把 task 包在 `task` 下）。 */
function orcaTaskIdOf(value: unknown): string | null {
  const record = readRecord(value);
  const task = record === undefined ? undefined : readRecord(record['task']);
  if (task === undefined) {
    return null;
  }
  const id = task['id'] ?? task['taskId'] ?? task['task_id'];
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function stringField(value: unknown, ...keys: readonly string[]): string | null {
  const record = readRecord(value);
  if (record === undefined) {
    return null;
  }
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  return null;
}

type ReportedCodexSession = CodexSessionStartReport & { readonly model: string | null };

async function waitForCodexSessionReport(input: {
  readonly projectDir: string;
  readonly terminalHandle: string;
  readonly reportIndex?: number;
}): Promise<{ readonly report: ReportedCodexSession; readonly bindingDeadlineAt: string }> {
  const reportPath = join(input.projectDir, '.companion', 'session-start.jsonl');
  const deadline = Date.now() + SESSION_START_DEADLINE_MS;
  let nextTrustCheck = 0;
  while (Date.now() < deadline) {
    if (existsSync(reportPath)) {
      const reports = readFileSync(reportPath, 'utf8').trim().split('\n').filter(Boolean);
      const reportText = reports[input.reportIndex ?? 0];
      const report = reportText === undefined ? null : (JSON.parse(reportText) as ReportedCodexSession);
      if (report !== null) {
        return { report, bindingDeadlineAt: new Date().toISOString() };
      }
    }
    if (Date.now() >= nextTrustCheck) {
      const screen = await runCaptured(
        'orca',
        ['terminal', 'read', '--terminal', input.terminalHandle, '--screen', '--json'],
        input.projectDir,
        30_000,
      );
      if (screen.stdout.includes('Hooks need review')) {
        throw new Error(
          'hook_trust_required：Orca 启动的 Codex 正在等待项目 SessionStart hook 审查；不得擅自写用户级 Codex 信任配置',
        );
      }
      nextTrustCheck = Date.now() + 2_000;
    }
    await new Promise((settle) => setTimeout(settle, 500));
  }
  {
    const [screen, stream] = await Promise.all([
      runCaptured(
        'orca',
        ['terminal', 'read', '--terminal', input.terminalHandle, '--screen', '--json'],
        input.projectDir,
        30_000,
      ),
      runCaptured(
        'orca',
        ['terminal', 'read', '--terminal', input.terminalHandle, '--limit', '200', '--json'],
        input.projectDir,
        30_000,
      ),
    ]);
    throw new Error(
      `Codex SessionStart 未在绑定时间窗内上报 session 与 transcript：screen=${screen.stdout.trim()} stream=${stream.stdout.trim()}`,
    );
  }
}

async function waitForFirstOutput(
  backend: ExecutionBackend,
  dispatchId: string,
  deadlineMs: number,
): Promise<number> {
  const startedAt = Date.now();
  let seen = 0;
  while (Date.now() - startedAt < deadlineMs) {
    const read = await backend.query({ operation: 'worker-read', dispatchId, source: 'auto', limit: 2 });
    if (read.kind === 'accepted') {
      const terminal = readRecord((readRecord(read.value) ?? {})['terminal']);
      const returned = terminal?.['returnedLineCount'];
      seen = typeof returned === 'number' ? returned : 0;
      if (seen > 0) {
        return seen;
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  return seen;
}

export type WorkerLaunchFacts = {
  readonly agent: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly terminationReason: string | null;
};

/**
 * 直接从 Orca 读出该 Dispatch 的 launch 与终止事实。
 *
 * `worker-show` 的登记 parser 不保留 `launch.effective` 与 `termination_reason`，因此这里直接做
 * 一次只读观测来核验中断事实。external terminal 的模型由 SessionStart 报告证明。
 */
async function observeLaunch(projectDir: string, dispatchId: string): Promise<WorkerLaunchFacts> {
  const empty: WorkerLaunchFacts = {
    agent: null,
    model: null,
    effort: null,
    terminationReason: null,
  };
  const shown = await runCaptured(
    'orca',
    ['orchestration', 'worker-show', '--dispatch', dispatchId, '--json'],
    projectDir,
    60_000,
  );
  if (!shown.ok) {
    return empty;
  }
  const parsed: unknown = JSON.parse(shown.stdout);
  const result = readRecord(readRecord(parsed)?.['result']);
  const worker = result === undefined ? undefined : readRecord(result['worker']);
  const dispatch = result === undefined ? undefined : readRecord(result['dispatch']);
  const rawOptions = worker?.['start_options'];
  if (typeof rawOptions !== 'string') {
    return { ...empty, terminationReason: stringField(dispatch, 'termination_reason') };
  }
  const options: unknown = JSON.parse(rawOptions);
  const launch = readRecord(readRecord(options)?.['launch']);
  const effective = launch === undefined ? undefined : readRecord(launch['effective']);
  return {
    agent: stringField(effective, 'agent'),
    model: stringField(effective, 'model'),
    effort: stringField(effective, 'effort'),
    terminationReason: stringField(dispatch, 'termination_reason'),
  };
}

export type WorkerShowSnapshot = {
  readonly dispatchStatus: string | null;
  readonly workerState: string | null;
  readonly workerStage: string | null;
  readonly observationStatus: string | null;
  readonly exactWorker: boolean | null;
  readonly agentTerminalHandle: string | null;
};

function toSnapshot(value: unknown): WorkerShowSnapshot {
  const record = readRecord(value) ?? {};
  const exact = record['exactWorker'];
  return {
    dispatchStatus: stringField(record, 'dispatchStatus'),
    workerState: stringField(record, 'workerState'),
    workerStage: stringField(record, 'workerStage'),
    observationStatus: stringField(record, 'observationStatus'),
    exactWorker: typeof exact === 'boolean' ? exact : null,
    agentTerminalHandle: stringField(record, 'agentTerminalHandle'),
  };
}

function payloadOf(message: DeliveryMessage): Record<string, unknown> {
  if (message.payload === null) {
    return {};
  }
  const parsed: unknown = JSON.parse(message.payload);
  return readRecord(parsed) ?? {};
}

function utilitySpec(transcriptRef: string, evidence: TranscriptCoverageEvidence): string {
  return [
    'You are a read-only Utility Worker extracting a Recovery Capsule from one exact Codex JSONL transcript.',
    'Do not modify files, run git, dispatch workers, install dependencies, or use external network access.',
    `Read and parse every non-empty JSONL line from this exact path: ${transcriptRef}`,
    `The trusted Adapter coverage evidence is: ${JSON.stringify(evidence)}`,
    'Confirm the transcript is readable and the event bounds agree with that evidence.',
    'Build exactly one JSON object and no markdown or commentary.',
    'Copy coverage, readableRange, gaps, and lastCompleteEventRef exactly from the trusted evidence.',
    'Add openActions, sourceRefs, and unknowns. Use [] when the complete transcript supports no such conclusion.',
    'When lastCompleteEventRef is non-null, include it in sourceRefs.',
    'Then follow the injected Orca dispatch preamble and send that JSON as the worker_done body with outcome succeeded.',
    'The local Orca control channel is the only permitted network use. Do not merely print the JSON and stop.',
  ].join(' ');
}

async function waitForUtilityCapsule(input: {
  readonly fixture: RealFixture;
  readonly taskId: string;
  readonly dispatchId: string;
  readonly evidence: TranscriptCoverageEvidence;
}): Promise<ReturnType<typeof parseRecoveryCapsuleReport>> {
  const deadline = Date.now() + UTILITY_DEADLINE_MS;
  while (Date.now() < deadline) {
    const batch = await readDeliveryBatch(input.fixture.backend, {
      backendIdentityRef: COORDINATOR_IDENTITY_REF,
      runId: input.fixture.runId,
      wait: true,
      types: ['worker_done', 'escalation', 'question'],
      timeoutMs: Math.min(60_000, deadline - Date.now()),
      readMode: 'default',
    });
    if (batch.kind !== 'accepted') {
      throw new Error(`读取 Utility Worker Delivery 失败：${batch.code} ${batch.message}`);
    }
    const blocked = batch.value.messages.find((candidate) => {
      if (candidate.type !== 'escalation' && candidate.type !== 'question') {
        return false;
      }
      const payload = payloadOf(candidate);
      return payload['taskId'] === input.taskId && payload['dispatchId'] === input.dispatchId;
    });
    if (blocked !== undefined) {
      throw new Error(`Utility Worker ${blocked.type}：${blocked.body ?? blocked.subject ?? '无正文'}`);
    }
    const message = batch.value.messages.find((candidate) => {
      if (candidate.type !== 'worker_done') {
        return false;
      }
      const payload = payloadOf(candidate);
      return payload['taskId'] === input.taskId && payload['dispatchId'] === input.dispatchId;
    });
    if (message !== undefined) {
      if (message.body === null) {
        throw new Error('Utility Worker 的 worker_done 缺少结构化正文');
      }
      const raw: unknown = JSON.parse(message.body);
      const parsed = parseRecoveryCapsuleReport(raw, input.evidence);
      if (!parsed.ok) {
        throw new Error(`Utility Worker Capsule 无效：${parsed.reason}`);
      }
      if (batch.value.delivery === null) {
        throw new Error('Utility Worker Delivery 缺少稳定 identity');
      }
      const acked = await ackDelivery(
        input.fixture.backend,
        input.fixture.scopeFor(`${PLAN.kind === 'run' ? PLAN.identity : 'skip'}:delivery-ack:${batch.value.delivery.deliveryId}`, {
          kind: 'worker-task',
          id: input.taskId,
        }),
        batch.value.delivery,
      );
      if (acked.kind !== 'accepted') {
        throw new Error(`Utility Worker Delivery 确认失败：${acked.kind}`);
      }
      return parsed;
    }
    if (batch.value.delivery !== null) {
      const acked = await ackDelivery(
        input.fixture.backend,
        input.fixture.scopeFor(`${PLAN.kind === 'run' ? PLAN.identity : 'skip'}:delivery-ack:${batch.value.delivery.deliveryId}`, {
          kind: 'worker-dispatch',
          id: input.dispatchId,
        }),
        batch.value.delivery,
      );
      if (acked.kind !== 'accepted') {
        throw new Error(`前序 Delivery 确认失败：${acked.kind}`);
      }
    }
  }
  const [shown, output] = await Promise.all([
    input.fixture.backend.query({ operation: 'worker-show', dispatchId: input.dispatchId }),
    input.fixture.backend.query({ operation: 'worker-read', dispatchId: input.dispatchId, source: 'auto', limit: 20 }),
  ]);
  throw new Error(`等待 Utility Worker Capsule 超时：${JSON.stringify({ shown, output })}`);
}

/** 未显式开启时，本文件不产生任何真实调用；这条断言本身就是「默认跳过」的可观察形式。 */
test.skipIf(PLAN.kind !== 'skip')('未开启开关时整个真实验收被跳过且不加载端点配置', () => {
  expect(PLAN.kind).toBe('skip');
  expect(DIAGNOSTICS.envFileLoaded).toBe(false);
  expect(DIAGNOSTICS.endpointsResolved).toBe(false);
  expect(DIAGNOSTICS.realCallAttempted).toBe(false);
});

test('隔离边界自检拒绝 Companion 自身仓库与其上级目录', () => {
  expect(() => {
    assertIsolatedWorkspace(COMPANION_REPOSITORY, new Set(['project-x']));
  }).toThrow(/自身仓库/);
  expect(() => {
    assertIsolatedWorkspace(dirname(COMPANION_REPOSITORY), new Set(['project-x']));
  }).toThrow(/范围过宽/);
  expect(() => {
    assertIsolatedWorkspace(join(COMPANION_REPOSITORY, 'does-not-exist'), new Set(['project-x']));
  }).toThrow(/不是存在的目录/);
  // 空的隔离目录只放自己的 project-* 才放行；混入别的内容必须直接失败。
  const isolated = mkdtempSync(join(tmpdir(), 'orca-real-harness-guard.'));
  mkdirSync(join(isolated, 'project-x'));
  expect(() => {
    assertIsolatedWorkspace(isolated, new Set(['project-x']));
  }).not.toThrow();
  expect(() => {
    assertIsolatedWorkspace(isolated, new Set(['project-y']));
  }).toThrow(/混入/);
  rmSync(isolated, { recursive: true, force: true });
});

describe.skipIf(PLAN.kind !== 'run')('真实隔离 MiniMax-M3 Validator Recovery', () => {
  let fixture: RealFixture | null = null;

  beforeAll(async () => {
    if (PLAN.kind !== 'run') {
      return;
    }
    fixture = await createRealFixture(PLAN);
  }, 300_000);

  afterAll(async () => {
    await fixture?.dispose();
    fixture = null;
  }, 300_000);

  test('显式开启时 MiniMax 端点与凭据齐备', () => {
    if (PLAN.kind !== 'run') {
      return;
    }
    expect(PLAN.profiles.length).toBeGreaterThan(0);
    for (const profile of PLAN.profiles) {
      expect(profile.baseUrl.length).toBeGreaterThan(0);
      expect(profile.endpointUrl).toMatch(/\/v1\/(messages|chat\/completions|responses)$/);
      expect(process.env[profile.keyEnvVar] ?? '').not.toBe('');
    }
  });

  test('真实隔离：中断 Validator 经 Codex Adapter 与 Utility Worker 生成实际 coverage Capsule', async () => {
    const current = fixture;
    expect(current).not.toBeNull();
    if (current === null || PLAN.kind !== 'run') {
      return;
    }

    // 1. 真实 Validator Task：spec 是多步验证，确保中断时 transcript 已有内容。
    const taskCreated = await current.backend.mutate(
      {
        operation: 'task-create',
        spec: VALIDATOR_SPEC,
        runId: current.runId,
        taskTitle: `${PLAN.identity} validator`,
        displayName: `${PLAN.identity} validator`,
      },
      current.scopeFor(`${PLAN.identity}:task-create`, { kind: 'work-package', id: 'WP-1' }),
    );
    expect(taskCreated.kind).toBe('accepted');
    if (taskCreated.kind !== 'accepted') {
      return;
    }
    const taskId = orcaTaskIdOf(taskCreated.value);
    expect(taskId).not.toBeNull();
    if (taskId === null) {
      return;
    }

    // 2. 真实 Worker：由 Orca 正式启动 Codex；SessionStart 在首次模型请求前报告精确 session。
    DIAGNOSTICS.realCallAttempted = true;
    const dispatchStartedAt = new Date().toISOString();
    const { dispatchId, terminalHandle } = await startPreparedCodexWorker({
      fixture: current,
      taskId,
      launchId: `${PLAN.identity}:validator`,
      operationPrefix: `${PLAN.identity}:validator`,
      model: PLAN.workerModel,
      sandboxMode: 'workspace-write',
    });
    const sessionStart = await waitForCodexSessionReport({
      projectDir: current.projectDir,
      terminalHandle,
    });
    expect(sessionStart.report.model ?? '').toContain(REQUIRED_WORKER_MODEL_FRAGMENT);
    const launch = await observeLaunch(current.projectDir, dispatchId);
    writeObservation({ kind: 'validator_launch', dispatchId, taskId, runId: current.runId, ...launch });

    // 3. 中断：一旦 terminal 出现输出就 operator stop，留下一个被切断的 Session Segment。
    const seenLines = await waitForFirstOutput(current.backend, dispatchId, FIRST_OUTPUT_DEADLINE_MS);
    const stopped = await current.backend.mutate(
      { operation: 'worker-stop', dispatchId },
      current.scopeFor(`${PLAN.identity}:worker-stop`, { kind: 'worker-dispatch', id: dispatchId }),
    );
    // `worker-stop` 缺失的登记 parser 让它只回原始结果；三值结论照实记录，不用它推断中断成立。
    const stopOutcome =
      stopped.kind === 'accepted'
        ? { outcome: 'accepted' as const, alreadySettled: readRecord(stopped.value)?.['alreadySettled'] ?? null }
        : stopped.kind === 'unknown'
          ? { outcome: 'unknown' as const, reason: stopped.reason }
          : { outcome: 'rejected' as const, code: stopped.code, message: stopped.message };
    await current.closeWorkerTerminal(dispatchId);
    const shownAfterClose = await current.backend.query({ operation: 'worker-show', dispatchId });
    expect(shownAfterClose.kind).toBe('accepted');
    if (shownAfterClose.kind !== 'accepted') {
      return;
    }
    const settled = toSnapshot(shownAfterClose.value);
    const interrupted = await observeLaunch(current.projectDir, dispatchId);
    writeObservation({
      kind: 'validator_interrupted',
      dispatchId,
      terminalOutputLines: seenLines,
      ...stopOutcome,
      dispatchStatus: settled.dispatchStatus,
      workerState: settled.workerState,
      workerStage: settled.workerStage,
      observationStatus: settled.observationStatus,
      exactWorker: settled.exactWorker,
      terminationReason: interrupted.terminationReason,
    });
    // operator stop 必须真的切断了一个尚未自行走完的会话；若它已成功收尾，这次中断不成立。
    expect(settled.workerState, '中断必须发生在 Worker 成功收尾之前').not.toBe('succeeded');

    // 4. Codex Adapter 只接受 SessionStart + CODEX_HOME + 唯一 rollout metadata 的精确来源。
    const proof = proveCodexTranscript({
      report: sessionStart.report,
      workspace: current.projectDir,
      dispatchStartedAt,
      bindingDeadlineAt: sessionStart.bindingDeadlineAt,
    });
    expect(proof.kind).toBe('proven');
    if (proof.kind !== 'proven') {
      return;
    }
    const coverage = await inspectCodexTranscript(proof.proof.transcriptRef);
    expect(coverage.kind).toBe('covered');
    if (coverage.kind !== 'covered') {
      return;
    }
    expect(coverage.evidence.coverage).toBe('complete');

    // 5. 真实派发受限 Utility Worker；它读取精确 transcript，结构化结果须与 Adapter coverage 一致。
    const utilityTaskCreated = await current.backend.mutate(
      {
        operation: 'task-create',
        spec: utilitySpec(proof.proof.transcriptRef, coverage.evidence),
        runId: current.runId,
        taskTitle: `${PLAN.identity} recovery utility`,
        displayName: `${PLAN.identity} recovery utility`,
      },
      current.scopeFor(`${PLAN.identity}:utility-task-create`, { kind: 'work-package', id: 'WP-1' }),
    );
    expect(utilityTaskCreated.kind).toBe('accepted');
    if (utilityTaskCreated.kind !== 'accepted') {
      return;
    }
    const utilityTaskId = orcaTaskIdOf(utilityTaskCreated.value);
    expect(utilityTaskId).not.toBeNull();
    if (utilityTaskId === null) {
      return;
    }
    const { dispatchId: utilityDispatchId, terminalHandle: utilityTerminalHandle } = await startPreparedCodexWorker({
      fixture: current,
      taskId: utilityTaskId,
      launchId: `${PLAN.identity}:utility`,
      operationPrefix: `${PLAN.identity}:utility`,
      model: PLAN.workerModel,
      sandboxMode: 'read-only-local-control',
    });
    const utilitySession = await waitForCodexSessionReport({
      projectDir: current.projectDir,
      terminalHandle: utilityTerminalHandle,
      reportIndex: 1,
    });
    expect(utilitySession.report.model ?? '').toContain(REQUIRED_WORKER_MODEL_FRAGMENT);
    const parsed = await waitForUtilityCapsule({
      fixture: current,
      taskId: utilityTaskId,
      dispatchId: utilityDispatchId,
      evidence: coverage.evidence,
    });
    expect(parsed.ok).toBe(true);
    expect(
      evaluateRoleGate({
        role: 'validator',
        validator: { identifiedGaps: [], invalidatedEvidenceIds: [], reverifiedEvidenceIds: [] },
      }).kind,
    ).toBe('admitted');
    writeObservation({
      kind: 'recovery_capsule',
      dispatchId,
      coverage: coverage.evidence.coverage,
      transcriptRef: proof.proof.transcriptRef,
    });
  }, 600_000);
});
