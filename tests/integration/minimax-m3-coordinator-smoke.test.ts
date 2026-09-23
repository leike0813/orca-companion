/**
 * D19：真实 provider 冒烟验收
 * （Owner: `m1-run-coordinator-sessions`）。
 *
 * 覆盖四个只有真实 provider 才能证明的行为：suspend 之后前台继续、缩短周期的 keepalive 在有限
 * cycle 内停止、手动 compact 得到显式结论、Model Configuration 在重启后仍然生效。
 *
 * 它**只在显式选择隔离工作区与专用身份后**才运行：
 *
 * ```sh
 * COORDINATOR_SMOKE=1 \
 * COORDINATOR_SMOKE_REPO=<isolated-workspace> \
 * COORDINATOR_SMOKE_IDENTITY=<dedicated-identity> \
 * pnpm exec vitest run tests/integration/minimax-m3-coordinator-smoke.test.ts --no-file-parallelism
 * ```
 *
 * 端点、模型与凭据来自 `.env.smoke`（见该文件注释）：填了哪个端点就测哪个，两个都填就两个都测。
 * 未显式开启时整个文件只留一条 skip 记录：不加载 env 文件、不加载 provider、不打开数据库、
 * 不发起真实调用，也不属于普通 `pnpm test` 的一部分。
 *
 * 隔离工作区是**事实而非假设**：冒烟为每个端点在其中新建一次性 Git 项目，按生产路径布局写入两个
 * store，并拒绝非空工作区与已有 Companion 状态的项目。prompt cache 命中只写入观测输出，不参与
 * 任何断言或失败判定——命中取决于 provider 策略与计费窗口，超出 Companion 的可控范围。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage } from '@langchain/core/messages';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { projectActionableWork } from '../../src/application/coordinator/actionable-work.js';
import {
  INITIAL_MAINTENANCE_STATE,
  runMaintenanceCycle,
  type MaintenanceLaneState,
} from '../../src/application/coordinator/maintenance-lane.js';
import {
  assertSwitchable,
  isNativeWindowCompatible,
  switchModelConfiguration,
  type CoordinatorModelConfiguration,
} from '../../src/application/coordinator/model-config-switch.js';
import {
  acquireIncarnation,
  assertFencingGeneration,
  type CoordinatorIncarnation,
} from '../../src/application/coordinator/runtime-guard.js';
import { suspendSession } from '../../src/application/coordinator/suspension.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  PlanningCycleId,
  RuntimeIncarnationId,
} from '../../src/application/dto/identity.js';
import type { CoordinationWriter } from '../../src/application/ports/branch-coordination-store.js';
import { createModuleIntegrationResolverAsync } from '../../src/adapters/agents/chat-model-factory.js';
import { runProcess } from '../../src/adapters/orca-cli/process-runner.js';
import { openCheckpointStore, type CheckpointStore } from '../../src/adapters/storage/checkpoint-store.js';
import { openCoordinationStore, type CoordinationStore } from '../../src/adapters/storage/coordination-store.js';
import { checkpointDatabasePath } from '../../src/bootstrap/coordinator-runtime.js';
import {
  COMPANION_STATE_DIRECTORY,
  coordinationDatabasePath,
  resolveGitCommonDir,
} from '../../src/bootstrap/composition.js';
import {
  COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
  threadIdFor,
  type CoordinatorSessionState,
} from '../../src/domain/coordinator/session-state.js';
import { buildBoundedModelInput } from '../../src/workflow/coordinator/context.js';
import { buildCoordinatorGraph } from '../../src/workflow/coordinator/graph.js';
import { COORDINATOR_INVOKE_DEFAULTS } from '../../src/workflow/coordinator/state.js';

/** Companion 自身仓库：即便被写进 COORDINATOR_SMOKE_REPO 也必须拒绝。 */
const COMPANION_REPOSITORY = resolve(fileURLToPath(new URL('../../', import.meta.url)));

/** env 文件默认位置；可用 COORDINATOR_SMOKE_ENV_FILE 覆盖。 */
const DEFAULT_ENV_FILE = join(COMPANION_REPOSITORY, '.env.smoke');

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

/**
 * 把 env 文件合并进进程环境。
 *
 * 真实环境优先：已存在的变量不会被文件覆盖。凭据只以环境变量形式存在，不进入任何配置对象、
 * 不写入文件、不打印。
 */
function mergeEnvFileIntoProcess(path: string): { readonly loaded: boolean; readonly applied: number } {
  if (!existsSync(path)) {
    return { loaded: false, applied: 0 };
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
  return { loaded: true, applied };
}

export type SmokeProfile = {
  readonly id: string;
  readonly integration: string;
  readonly model: string;
  /** 归一化后的 base URL：已按各家 SDK 的拼接规则补上或去掉 `/v1`。 */
  readonly baseUrl: string;
  /** 实际会被请求的完整路径，只用于诊断与观测。 */
  readonly endpointUrl: string;
  readonly keyEnvVar: string;
  /** 只含非凭据字段：凭据由 provider 集成自己从标准环境变量取得。 */
  readonly modelOptions: Readonly<Record<string, unknown>>;
};

/** 去掉结尾斜杠，便于比较与拼接。 */
function trimSlashes(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Anthropic SDK 自己会拼 `/v1/messages`，所以 base 里不能再带 `v1`，否则会变成 `/v1/v1/messages`。
 */
function baseWithoutV1(raw: string): string {
  const base = trimSlashes(raw);
  return base.endsWith('/v1') ? base.slice(0, -'/v1'.length) : base;
}

/**
 * OpenAI SDK 直接拼 `/chat/completions` 与 `/responses`，所以 base 必须自带 `/v1`。
 * 端点地址通常不写 `v1`，这里统一补上。
 */
function baseWithV1(raw: string): string {
  const base = trimSlashes(raw);
  return base.endsWith('/v1') ? base : `${base}/v1`;
}

type SmokePlan =
  | { readonly kind: 'skip'; readonly reason: string }
  | {
      readonly kind: 'run';
      readonly workspace: string;
      readonly identity: string;
      readonly profiles: readonly SmokeProfile[];
      readonly envFile: string;
      readonly envFileLoaded: boolean;
      readonly envEntriesApplied: number;
    };

type ProfileSource = {
  readonly id: string;
  readonly baseUrlVar: string;
  /** 未设置主变量时的回退变量；Responses 与 Chat Completions 通常同一个 host。 */
  readonly baseUrlFallbackVar?: string;
  readonly modelVar: string;
  readonly integrationVar: string;
  readonly keyEnvVarVar: string;
  readonly defaultIntegration: string;
  readonly defaultKeyEnvVar: string;
  /** 把端点地址归一化成该 SDK 需要的 base URL。 */
  readonly normalize: (raw: string) => string;
  /** 该 SDK 会在 base URL 之后拼出的路径，用于诊断与观测。 */
  readonly endpointPath: string;
  readonly buildOptions: (baseUrl: string) => Readonly<Record<string, unknown>>;
};

const PROFILE_SOURCES: readonly ProfileSource[] = [
  {
    id: 'anthropic',
    baseUrlVar: 'COORDINATOR_SMOKE_ANTHROPIC_BASE_URL',
    modelVar: 'COORDINATOR_SMOKE_ANTHROPIC_MODEL',
    integrationVar: 'COORDINATOR_SMOKE_ANTHROPIC_INTEGRATION',
    keyEnvVarVar: 'COORDINATOR_SMOKE_ANTHROPIC_KEY_ENV',
    defaultIntegration: '@langchain/anthropic#ChatAnthropic',
    defaultKeyEnvVar: 'ANTHROPIC_API_KEY',
    normalize: baseWithoutV1,
    endpointPath: '/v1/messages',
    // Anthropic SDK 自己补 /v1/messages，凭据由集成从 ANTHROPIC_API_KEY 取得。
    buildOptions: (baseUrl) => ({ temperature: 0, anthropicApiUrl: baseUrl }),
  },
  {
    id: 'openai',
    baseUrlVar: 'COORDINATOR_SMOKE_OPENAI_BASE_URL',
    modelVar: 'COORDINATOR_SMOKE_OPENAI_MODEL',
    integrationVar: 'COORDINATOR_SMOKE_OPENAI_INTEGRATION',
    keyEnvVarVar: 'COORDINATOR_SMOKE_OPENAI_KEY_ENV',
    defaultIntegration: '@langchain/openai#ChatOpenAI',
    defaultKeyEnvVar: 'OPENAI_API_KEY',
    normalize: baseWithV1,
    endpointPath: '/chat/completions',
    // OpenAI SDK 直接拼 /chat/completions，凭据由集成从 OPENAI_API_KEY 取得。
    buildOptions: (baseUrl) => ({ temperature: 0, configuration: { baseURL: baseUrl } }),
  },
  {
    id: 'openai-responses',
    baseUrlVar: 'COORDINATOR_SMOKE_RESPONSES_BASE_URL',
    baseUrlFallbackVar: 'COORDINATOR_SMOKE_OPENAI_BASE_URL',
    modelVar: 'COORDINATOR_SMOKE_RESPONSES_MODEL',
    integrationVar: 'COORDINATOR_SMOKE_RESPONSES_INTEGRATION',
    keyEnvVarVar: 'COORDINATOR_SMOKE_RESPONSES_KEY_ENV',
    defaultIntegration: '@langchain/openai#ChatOpenAI',
    defaultKeyEnvVar: 'OPENAI_API_KEY',
    normalize: baseWithV1,
    endpointPath: '/responses',
    // Responses API 是同一个集成的另一条请求路径：SDK 拼 /responses。
    buildOptions: (baseUrl) => ({
      temperature: 0,
      useResponsesApi: true,
      configuration: { baseURL: baseUrl },
    }),
  },
];

/** 显式停用某个端点的标记；用于回退变量默认生效时单独关掉一条路径。 */
const PROFILE_DISABLED_MARKERS: ReadonlySet<string> = new Set(['-', 'off', 'skip', 'none', 'disabled']);

/**
 * 解析一个端点的原始地址。
 *
 * `disabled` 与 `unset` 必须分开：回退变量会让端点默认生效，所以必须有一种显式方式把它关掉
 * （例如端点没有实现 `/v1/responses`），而不是只能靠删掉变量。
 */
function resolveRawBaseUrl(
  source: ProfileSource,
): { readonly kind: 'value'; readonly raw: string } | { readonly kind: 'unset' } | { readonly kind: 'disabled' } {
  const primary = process.env[source.baseUrlVar];
  if (primary !== undefined) {
    const value = primary.trim();
    if (PROFILE_DISABLED_MARKERS.has(value.toLowerCase())) {
      return { kind: 'disabled' };
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

function readProfiles(): readonly SmokeProfile[] {
  const profiles: SmokeProfile[] = [];
  for (const source of PROFILE_SOURCES) {
    const resolved = resolveRawBaseUrl(source);
    if (resolved.kind !== 'value') {
      continue;
    }
    const baseUrl = source.normalize(resolved.raw);
    profiles.push({
      id: source.id,
      integration: process.env[source.integrationVar] ?? source.defaultIntegration,
      model: process.env[source.modelVar] ?? 'MiniMax-M3',
      baseUrl,
      endpointUrl: `${baseUrl}${source.endpointPath}`,
      keyEnvVar: process.env[source.keyEnvVarVar] ?? source.defaultKeyEnvVar,
      modelOptions: source.buildOptions(baseUrl),
    });
  }
  return profiles;
}

/** 一个 key 供各端点共用：把它注入各自集成的标准环境变量。 */
function injectSharedKey(profiles: readonly SmokeProfile[]): number {
  const shared = process.env['COORDINATOR_SMOKE_API_KEY'] ?? '';
  if (shared.length === 0) {
    return 0;
  }
  let injected = 0;
  for (const profile of profiles) {
    if (process.env[profile.keyEnvVar] === undefined) {
      process.env[profile.keyEnvVar] = shared;
      injected += 1;
    }
  }
  return injected;
}

/**
 * 解析运行计划。
 *
 * 开关、隔离工作区与专用身份必须来自真实环境：显式开启这件事不能藏在 env 文件里。
 */
function resolveSmokePlan(): SmokePlan {
  if (process.env['COORDINATOR_SMOKE'] !== '1') {
    return { kind: 'skip', reason: 'COORDINATOR_SMOKE 未显式开启' };
  }
  const workspace = process.env['COORDINATOR_SMOKE_REPO'] ?? '';
  if (workspace.length === 0) {
    return { kind: 'skip', reason: 'COORDINATOR_SMOKE_REPO 未显式选择隔离工作区' };
  }
  const identity = process.env['COORDINATOR_SMOKE_IDENTITY'] ?? '';
  if (identity.length === 0) {
    return { kind: 'skip', reason: 'COORDINATOR_SMOKE_IDENTITY 未显式选择专用身份' };
  }
  const envFile = process.env['COORDINATOR_SMOKE_ENV_FILE'] ?? DEFAULT_ENV_FILE;
  const merged = mergeEnvFileIntoProcess(envFile);
  const profiles = readProfiles();
  injectSharedKey(profiles);
  return {
    kind: 'run',
    workspace: resolve(workspace),
    identity,
    profiles,
    envFile,
    envFileLoaded: merged.loaded,
    envEntriesApplied: merged.applied,
  };
}

const PLAN = resolveSmokePlan();

/**
 * 校验显式选择的隔离工作区。
 *
 * 门禁必须在显式开启后**真的检查**：不存在的路径、不是目录、混入非冒烟产物、Companion 自身仓库，
 * 以及包含 Companion 的过宽路径都直接失败，而不是静默跳过——否则「已选择隔离工作区」只是一句
 * 无法失败的口号。
 *
 * 工作区在两个 profile 之间是共用的，所以「干净」定义为「除了本次冒烟自己的 `project-<profile>`
 * 目录之外没有任何内容」；上一次失败留下的 `project-<profile>` 会被每个 profile 自己的存在性检查
 * 拒绝，而不会静默复用。
 */
function assertIsolatedWorkspace(
  workspace: string,
  allowedProjectDirs: ReadonlySet<string>,
): void {
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
    throw new Error(`COORDINATOR_SMOKE_REPO 不是存在的目录：${workspace}`);
  }
  if (workspace === COMPANION_REPOSITORY) {
    throw new Error(`COORDINATOR_SMOKE_REPO 指向 Companion 自身仓库，冒烟必须在隔离工作区运行：${workspace}`);
  }
  if (COMPANION_REPOSITORY.startsWith(`${workspace}/`)) {
    throw new Error(`COORDINATOR_SMOKE_REPO 是 Companion 的上级目录，范围过宽：${workspace}`);
  }
  const unexpected = readdirSync(workspace).filter((name) => !allowedProjectDirs.has(name));
  if (unexpected.length > 0) {
    throw new Error(
      `隔离工作区混入了非冒烟内容（只允许冒烟自己的 project-* 目录）；请改用空目录，当前多余内容：${unexpected.join(', ')}`,
    );
  }
}

/** 观测输出；只记录，不参与断言或失败判定。 */
export function writeObservation(entry: Readonly<Record<string, unknown>>): void {
  process.stdout.write(`[cache-observation] ${JSON.stringify(entry)}\n`);
}

export type CacheObservation = {
  readonly kind: 'prompt_cache';
  readonly model: string;
  readonly profile: string;
  readonly endpoint: string;
  readonly identity: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheCreationTokens: number | null;
  readonly hit: boolean;
};

function readNumber(record: Record<string, unknown>, ...keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

/**
 * 记录一次真实调用的 prompt cache 命中情况。
 *
 * 读取是容错的：LangChain 的 `usage_metadata` 用 snake_case，已提交 step 里的 usage 用 Companion
 * 自己的驼峰拼写，两者都要能记录。返回值只用于观测输出。
 */
export function collectCacheObservation(
  profile: SmokeProfile,
  identity: string,
  usageCarrier: unknown,
): CacheObservation {
  const wrapper =
    typeof usageCarrier === 'object' && usageCarrier !== null
      ? (usageCarrier as Record<string, unknown>)
      : {};
  const metadata = wrapper['usage_metadata'];
  const record =
    typeof metadata === 'object' && metadata !== null ? (metadata as Record<string, unknown>) : wrapper;
  const details =
    typeof record['input_token_details'] === 'object' && record['input_token_details'] !== null
      ? (record['input_token_details'] as Record<string, unknown>)
      : {};
  const cacheReadTokens = readNumber(details, 'cache_read', 'cacheReadTokens');
  return {
    kind: 'prompt_cache',
    model: profile.model,
    profile: profile.id,
    endpoint: profile.endpointUrl,
    identity,
    inputTokens: readNumber(record, 'input_tokens', 'inputTokens'),
    outputTokens: readNumber(record, 'output_tokens', 'outputTokens'),
    cacheReadTokens,
    cacheCreationTokens: readNumber(details, 'cache_creation', 'cacheCreationTokens'),
    hit: cacheReadTokens !== null && cacheReadTokens > 0,
  };
}

/** 按 step 内容长度估算输入规模；冒烟不依赖 provider 的分词。 */
function estimate(
  segments: readonly { readonly kind: string; readonly messages?: readonly unknown[]; readonly text?: string }[],
): number {
  return segments.reduce((total, segment) => {
    if (segment.kind === 'capsule') {
      return total + (segment.text?.length ?? 0);
    }
    return (
      total +
      (segment.messages ?? []).reduce<number>((sum, message) => {
        const content = (message as { readonly content?: unknown }).content;
        return sum + (typeof content === 'string' ? content.length : 0);
      }, 0)
    );
  }, 0);
}

type ProfileFixture = {
  readonly projectDir: string;
  readonly companionStateDir: string;
  readonly coordination: CoordinationStore;
  readonly checkpoints: CheckpointStore;
  readonly model: BaseChatModel;
  readonly configuration: CoordinatorModelConfiguration;
  readonly scopeId: CoordinationScopeId;
  readonly sessionId: CoordinatorSessionId;
  /** 该 profile 唯一的 Runtime Incarnation：夹具建立时取得，四个场景共用。 */
  readonly incarnation: CoordinatorIncarnation;
  /** 关闭 coordination store 并记录状态；重复调用是安全的空操作。 */
  readonly closeCoordination: () => void;
};

function currentEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

async function initGitRepository(projectDir: string): Promise<void> {
  mkdirSync(projectDir, { recursive: true });
  const result = await runProcess({
    executable: 'git',
    args: ['init', '-q'],
    cwd: projectDir,
    env: currentEnvironment(),
    timeoutMs: 30_000,
    limits: { maxBytes: 32 * 1024, maxLines: 200 },
  });
  if (result.kind !== 'completed' || result.exitCode !== 0) {
    throw new Error(`无法在隔离工作区中初始化一次性 Git 项目：${projectDir}`);
  }
}

/**
 * 为单个端点建立一次性夹具。
 *
 * 两个 store 都使用与生产一致的路径解析，落在该一次性项目的 Git common dir 之下，因此这一步同时
 * 验证真实仓库上的路径归属。已有 Companion 状态的项目直接拒绝。
 */
async function createProfileFixture(
  plan: Extract<SmokePlan, { kind: 'run' }>,
  profile: SmokeProfile,
): Promise<ProfileFixture> {
  const allowedProjectDirs = new Set(plan.profiles.map((entry) => `project-${entry.id}`));
  assertIsolatedWorkspace(plan.workspace, allowedProjectDirs);
  const projectDir = join(plan.workspace, `project-${profile.id}`);
  if (existsSync(projectDir)) {
    throw new Error(`一次性项目目录已存在，冒烟需要干净项目：${projectDir}`);
  }
  await initGitRepository(projectDir);

  const commonDir = await resolveGitCommonDir({ repositoryPath: projectDir, env: currentEnvironment() });
  if (commonDir.kind === 'failed') {
    throw new Error(`无法解析一次性项目的 Git common dir：${commonDir.message}`);
  }
  const companionStateDir = join(commonDir.path, COMPANION_STATE_DIRECTORY);
  if (existsSync(companionStateDir)) {
    throw new Error(`一次性项目已存在 Companion 状态：${companionStateDir}`);
  }

  const coordinationOpen = openCoordinationStore({ databasePath: coordinationDatabasePath(commonDir.path) });
  if (coordinationOpen.kind !== 'opened') {
    throw new Error(`无法打开 coordination store：${coordinationOpen.message}`);
  }
  const coordination = coordinationOpen.store;
  const checkpointOpen = openCheckpointStore({ databasePath: checkpointDatabasePath(commonDir.path) });
  if (checkpointOpen.kind !== 'opened') {
    coordination.close();
    throw new Error(`无法打开 checkpoint store：${checkpointOpen.message}`);
  }

  let coordinationClosed = false;
  const closeCoordination = (): void => {
    if (!coordinationClosed) {
      coordination.close();
      coordinationClosed = true;
    }
  };

  const scopeId = `smoke-${profile.id}-${plan.identity}` as CoordinationScopeId;
  const sessionId = `smoke-${profile.id}-${plan.identity}` as CoordinatorSessionId;
  const write = (incarnationId: string, generation: number): CoordinationWriter => ({
    coordinatorSessionId: sessionId,
    runtimeIncarnationId: incarnationId as RuntimeIncarnationId,
    fencingGeneration: generation,
  });
  const revisionOf = (): number => {
    const result = coordination.query({ kind: 'scope', coordinationScopeId: scopeId });
    if (result.kind !== 'scope' || result.scope === null) {
      throw new Error('冒烟的 Coordination Scope 不存在');
    }
    return result.scope.revision;
  };

  const configuration: CoordinatorModelConfiguration = {
    configurationRef: `smoke-${profile.id}-${plan.identity}`,
    providerIntegration: profile.integration,
    model: profile.model,
    // 只含非凭据字段：凭据由集成自己从标准环境变量取得。
    modelOptions: { ...profile.modelOptions },
    credentialRefs: [`env:${profile.keyEnvVar}`],
    nativeWindowOwnerRef: null,
  };

  const resolveIntegration = createModuleIntegrationResolverAsync();
  const integration = await resolveIntegration(configuration.providerIntegration);
  if (integration === null) {
    checkpointOpen.store.close();
    coordination.close();
    throw new Error(`无法加载 provider 集成 ${configuration.providerIntegration}；请确认它已安装且凭据可用`);
  }
  const model = integration.createChatModel({
    model: configuration.model,
    modelOptions: { ...configuration.modelOptions, maxRetries: 0 },
  });

  const created = coordination.transact({
    kind: 'create-scope',
    coordinationScopeId: scopeId,
    expectedRevision: 0,
    writer: write(`${plan.identity}-bootstrap`, 0),
    mode: 'route_planning',
    controlState: 'active',
    planningCycleId: `cycle-${plan.identity}` as PlanningCycleId,
    fullBranchRef: `refs/heads/${plan.identity}`,
    canonicalWorktreePath: '/tmp/orca-smoke-worktree',
  });
  if (created.kind !== 'committed') {
    throw new Error(`无法创建冒烟 Scope：${created.message}`);
  }
  const registered = coordination.transact({
    kind: 'register-session',
    coordinationScopeId: scopeId,
    expectedRevision: revisionOf(),
    writer: write(`${plan.identity}-bootstrap`, 0),
    coordinatorSessionId: sessionId,
    coordinatorModelConfigurationRef: configuration.configurationRef,
    lifecycleState: 'registered',
  });
  if (registered.kind !== 'committed') {
    throw new Error(`无法注册冒烟 Session：${registered.message}`);
  }

  const empty: CoordinatorSessionState = {
    schemaVersion: COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
    coordinatorSessionId: sessionId,
    committedMessages: [],
    graphPosition: 'start',
    committedModelSteps: [],
    wakeBatches: [],
    lastCompactionOutcome: null,
  };
  const seeded = checkpointOpen.store.saveCheckpoint(empty);
  if (seeded.kind !== 'saved') {
    throw new Error(`无法写入冒烟会话记录：${seeded.message}`);
  }

  // 四个场景共用同一个 Runtime Incarnation：第二个 incarnation 会被 Runtime Lease 正确拒绝，
  // 冒烟不该靠抢占租约来推进。
  const acquired = acquireIncarnation(coordination, {
    coordinationScopeId: scopeId,
    coordinatorSessionId: sessionId,
    runtimeIncarnationId: `${plan.identity}-${profile.id}` as RuntimeIncarnationId,
    ttlMs: 3_600_000,
  });
  if (acquired.kind !== 'acquired') {
    throw new Error(`无法取得冒烟 Runtime Lease：${acquired.kind}`);
  }

  return {
    projectDir,
    companionStateDir,
    coordination,
    checkpoints: checkpointOpen.store,
    model,
    configuration,
    scopeId,
    sessionId,
    incarnation: acquired.incarnation,
    closeCoordination,
  };
}

function defineProfileSuite(plan: Extract<SmokePlan, { kind: 'run' }>, profile: SmokeProfile): void {
  describe(`${profile.id}（${profile.integration}）`, () => {
    let fixture: ProfileFixture | null = null;

    beforeAll(async () => {
      fixture = await createProfileFixture(plan, profile);
    }, 180_000);

    afterAll(() => {
      if (fixture === null) {
        return;
      }
      fixture.checkpoints.close();
      fixture.closeCoordination();
      // 一次性项目整体删除，隔离工作区恢复为空，可重复运行。
      rmSync(fixture.projectDir, { recursive: true, force: true });
      fixture = null;
    });

    test('suspend 结束模型 loop，而前台 Controller 与对账继续运行', async () => {
      const current = fixture;
      expect(current).not.toBeNull();
      if (current === null) {
        return;
      }

      const graph = buildCoordinatorGraph({
        model: current.model,
        checkpointer: current.checkpoints.checkpointer,
        sessionRecords: current.checkpoints,
        // 每次模型调用与 checkpoint 写入之前都回读当前 Runtime Lease。
        assertFencing: () =>
          assertFencingGeneration(current.coordination, current.incarnation, { clock: () => Date.now() }),
        newStepId: () => `smoke-${profile.id}-${String(Date.now())}`,
        buildMessages: (state, currentWork) => {
          const read = current.checkpoints.loadCheckpoint(current.sessionId);
          const steps = read.kind === 'recovered' ? read.state.committedModelSteps : [];
          const input = buildBoundedModelInput({
            segments: steps.map((step) => ({
              kind: 'messages' as const,
              stepId: step.stepId,
              messages: step.messages,
            })),
            estimate,
            fixedOverhead: 0,
            budgetTokens: 100_000,
            native: { kind: 'unavailable', reason: '冒烟不启用 provider 原生压缩' },
            shaken: false,
            instructions: ['你是 Coordinator，只做协调，不实现代码'],
            toolSchema: [],
            authoritativeFacts: [`scope=${current.scopeId}`, `identity=${plan.identity}`, state.note],
            currentWork,
          });
          return Promise.resolve({ messages: input.messages, note: input.compaction.kind });
        },
      });

      const actionable = projectActionableWork({
        coordinatorSessionId: current.sessionId,
        controlState: 'active',
        observations: [
          {
            source: { sourceKind: 'delivery', sourceId: 'smoke-question', revision: 1 },
            classification: 'worker_question',
            summary: '冒烟问题：请用一句话回应',
            ownerCoordinatorSessionId: current.sessionId,
          },
        ],
        admitted: [],
      });

      const result = await graph.invoke(
        {
          coordinatorSessionId: current.sessionId,
          remainingWork: actionable.items,
          deferredWork: actionable.deferredCount,
        },
        { configurable: { thread_id: threadIdFor(current.sessionId) }, ...COORDINATOR_INVOKE_DEFAULTS },
      );

      // 失败时把节点给出的原因一并带上，避免只看到 'stalled' 却不知道 provider 说了什么。
      expect(result.status, result.note).toBe('suspended');
      const read = current.checkpoints.loadCheckpoint(current.sessionId);
      expect(read.kind).toBe('recovered');
      if (read.kind === 'recovered') {
        expect(read.state.committedModelSteps.length).toBeGreaterThan(0);
        expect(read.state.graphPosition).toBe('suspend');
        const last = read.state.committedModelSteps[read.state.committedModelSteps.length - 1];
        if (last !== undefined) {
          writeObservation(
            collectCacheObservation(profile, plan.identity, { usage: last.usage, usage_metadata: null }),
          );
        }
      }

      // 前台继续：挂起不停止 Controller、对账与已运行 Worker。
      const foreground = suspendSession({
        coordinationScopeId: current.scopeId,
        coordinatorSessionId: current.sessionId,
        projection: { items: [], deferredCount: 0, suppressedBy: null },
      });
      expect(foreground.kind).toBe('suspended');

      const direct = await current.model.invoke([new HumanMessage('用一句话确认你在线')]);
      writeObservation(collectCacheObservation(profile, plan.identity, direct));
      expect(direct.text.length).toBeGreaterThan(0);
    }, 300_000);

    test('缩短周期后 keepalive 在有限 cycle 内停止，不产生 Wake Batch 或已提交 step', async () => {
      const current = fixture;
      expect(current).not.toBeNull();
      if (current === null) {
        return;
      }
      const fencing = assertFencingGeneration(current.coordination, current.incarnation, {
        clock: () => Date.now(),
      });
      expect(fencing.kind).toBe('valid');
      if (fencing.kind !== 'valid') {
        return;
      }

      const before = current.checkpoints.loadCheckpoint(current.sessionId);
      const stepsBefore = before.kind === 'recovered' ? before.state.committedModelSteps.length : -1;

      const cycleLimit = 2;
      let state: MaintenanceLaneState = INITIAL_MAINTENANCE_STATE;
      let keepalives = 0;
      for (let index = 0; index < cycleLimit; index += 1) {
        const result = await runMaintenanceCycle({
          state,
          fencing,
          controlState: 'active',
          projection: { items: [], deferredCount: 0, suppressedBy: null },
          cycleLimit,
          keepalive: async () => {
            keepalives += 1;
            const call = await current.model.invoke([new HumanMessage('保持连接')]);
            writeObservation(collectCacheObservation(profile, plan.identity, call));
            return { kind: 'kept-warm', detail: '真实保活调用完成' };
          },
        });
        expect(result.kind).toBe('performed');
        state = result.state;
      }

      const exhausted = await runMaintenanceCycle({
        state,
        fencing,
        controlState: 'active',
        projection: { items: [], deferredCount: 0, suppressedBy: null },
        cycleLimit,
        keepalive: () => Promise.reject(new Error('达到 cycle 上限后不得再保活')),
      });

      expect(exhausted.kind).toBe('stopped');
      if (exhausted.kind === 'stopped') {
        expect(exhausted.reason).toBe('cycle_limit_reached');
      }
      expect(keepalives).toBe(cycleLimit);

      const admissions = current.coordination.query({
        kind: 'wake-admissions',
        coordinationScopeId: current.scopeId,
      });
      expect(admissions.kind === 'wake-admissions' ? admissions.admissions : []).toEqual([]);
      const after = current.checkpoints.loadCheckpoint(current.sessionId);
      if (after.kind === 'recovered') {
        expect(after.state.committedModelSteps).toHaveLength(stepsBefore);
      }
    }, 300_000);

    test('手动 compact 得到显式结论，并走真实 provider 输入路径', async () => {
      const current = fixture;
      expect(current).not.toBeNull();
      if (current === null) {
        return;
      }

      const segments = Array.from({ length: 6 }, (_value, index) => ({
        kind: 'messages' as const,
        stepId: `smoke-step-${String(index)}`,
        messages: [{ role: 'assistant', content: `历史片段 ${String(index)}：${'x'.repeat(400)}` }],
      }));

      const input = buildBoundedModelInput({
        segments,
        estimate,
        fixedOverhead: 0,
        budgetTokens: 600,
        native: { kind: 'unavailable', reason: 'provider 原生压缩能力由集成暴露；此处按不可用处理' },
        shaken: false,
        instructions: ['你是 Coordinator，只做协调'],
        toolSchema: [],
        authoritativeFacts: [`scope=${current.scopeId}`, `identity=${plan.identity}`],
      });

      expect(['compacted', 'compaction_degraded', 'context_exhausted', 'not_needed']).toContain(
        input.compaction.kind,
      );
      if (input.compaction.kind === 'compacted') {
        expect(['provider_native', 'context_capsule', 'mechanical_shake']).toContain(input.compaction.path);
      }

      const response = await current.model.invoke(input.messages as never);
      writeObservation(collectCacheObservation(profile, plan.identity, response));
      expect(response.text.length).toBeGreaterThan(0);
    }, 300_000);

    test('Model Configuration 在重启后仍然生效', async () => {
      const current = fixture;
      expect(current).not.toBeNull();
      if (current === null) {
        return;
      }

      const sessions = current.coordination.query({
        kind: 'sessions',
        coordinationScopeId: current.scopeId,
      });
      expect(
        sessions.kind === 'sessions' ? sessions.sessions.map((entry) => entry.coordinatorModelConfigurationRef) : [],
      ).toEqual([current.configuration.configurationRef]);

      // 切换准入判据：非 suspended 一律拒绝。
      expect(assertSwitchable({ suspension: null, inFlightModelOperations: 0 }).kind).toBe('rejected');
      expect(isNativeWindowCompatible(current.configuration, null)).toBe(true);

      const next: CoordinatorModelConfiguration = {
        ...current.configuration,
        configurationRef: `${current.configuration.configurationRef}-next`,
      };
      const incarnation = current.incarnation;
      const switched = await switchModelConfiguration({
        coordinatorSessionId: current.sessionId,
        current: current.configuration,
        next,
        switchability: {
          suspension: {
            kind: 'suspended',
            coordinationScopeId: current.scopeId,
            coordinatorSessionId: current.sessionId,
            graphPosition: 'suspend',
            suspendedAt: 0,
            reason: 'no_actionable_work',
            deferredActionableWork: 0,
          },
          inFlightModelOperations: 0,
        },
        sessionRecords: current.checkpoints,
        nativeWindows: current.checkpoints,
        deriveCapsule: (parts) => ({
          kind: 'derived_context_capsule',
          capsuleId: `capsule:${parts.fromStepId}..${parts.toStepId}`,
          replacedFromStepId: parts.fromStepId,
          replacedToStepId: parts.toStepId,
          text: `[derived context capsule] ${parts.steps.map((step) => step.stepId).join(', ')}`,
        }),
        verify: () => Promise.resolve({ kind: 'verified' }),
        persistConfiguration: (configuration) => {
          const revision = current.coordination.query({
            kind: 'scope',
            coordinationScopeId: current.scopeId,
          });
          if (revision.kind !== 'scope' || revision.scope === null) {
            return { kind: 'failed', message: '冒烟的 Coordination Scope 不存在' };
          }
          const persisted = current.coordination.transact({
            kind: 'register-session',
            coordinationScopeId: current.scopeId,
            expectedRevision: revision.scope.revision,
            writer: {
              coordinatorSessionId: incarnation.coordinatorSessionId,
              runtimeIncarnationId: incarnation.runtimeIncarnationId,
              fencingGeneration: incarnation.fencingGeneration,
            },
            coordinatorSessionId: current.sessionId,
            coordinatorModelConfigurationRef: configuration.configurationRef,
            lifecycleState: 'registered',
          });
          return persisted.kind === 'committed'
            ? { kind: 'saved' }
            : { kind: 'failed', message: persisted.message };
        },
        clearDerivedCaches: () => 0,
      });
      expect(switched.kind).toBe('switched');

      // 关闭并重开 coordination store：登记与切换后的会话记录仍然生效。
      current.closeCoordination();
      const reopened = openCoordinationStore({
        databasePath: join(current.companionStateDir, 'coordination.sqlite'),
      });
      expect(reopened.kind).toBe('opened');
      if (reopened.kind === 'opened') {
        const after = reopened.store.query({ kind: 'sessions', coordinationScopeId: current.scopeId });
        expect(
          after.kind === 'sessions' ? after.sessions.map((entry) => entry.coordinatorModelConfigurationRef) : [],
        ).toEqual([next.configurationRef]);
        reopened.store.close();
      }
    }, 120_000);
  });
}

describe('D19 MiniMax-M3 隔离冒烟', () => {
  if (PLAN.kind === 'skip') {
    // 显式记录为什么没执行：一条静默消失的测试和通过没有区别。
    test.skip(`未执行：${PLAN.reason}`, () => undefined);
    return;
  }
  const plan = PLAN;

  test('显式开启时端点与凭据变量齐备', () => {
    expect(plan.profiles.length).toBeGreaterThan(0);
    for (const profile of plan.profiles) {
      expect(profile.baseUrl.length).toBeGreaterThan(0);
      expect(profile.endpointUrl).toMatch(/\/v1\/(messages|chat\/completions|responses)$/);
      expect(profile.model.length).toBeGreaterThan(0);
      expect(process.env[profile.keyEnvVar] ?? '').not.toBe('');
    }
    writeObservation({
      kind: 'smoke_plan',
      identity: plan.identity,
      workspace: plan.workspace,
      envFile: plan.envFile,
      envEntriesApplied: plan.envEntriesApplied,
      endpoints: plan.profiles.map((profile) => ({
        profile: profile.id,
        integration: profile.integration,
        model: profile.model,
        endpoint: profile.endpointUrl,
      })),
    });
  });

  if (plan.profiles.length === 0) {
    test('报告缺失的端点配置', () => {
      throw new Error(
        plan.envFileLoaded
          ? `在 ${plan.envFile} 中找不到任何端点配置：请至少填写 COORDINATOR_SMOKE_ANTHROPIC_BASE_URL 或 COORDINATOR_SMOKE_OPENAI_BASE_URL，并填入 COORDINATOR_SMOKE_API_KEY`
          : `未找到 env 文件 ${plan.envFile}：请创建并至少填写一个端点地址与 COORDINATOR_SMOKE_API_KEY`,
      );
    });
  }

  for (const profile of plan.profiles) {
    defineProfileSuite(plan, profile);
  }
});
