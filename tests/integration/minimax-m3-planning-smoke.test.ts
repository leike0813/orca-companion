/**
 * D20：真实 provider 的规划侧冒烟验收
 * （Owner: `m1-plan-and-authorize-execution`）。
 *
 * 覆盖两件只有真实 provider 才能证明的事：从真实 model step 派生出一次 Context Capsule 并把该
 * 输入交给真实模型，以及在真实仓库的生产 store 路径上完成一次 prepare→review→cutover 的 Route
 * Planning 责任交接，并确认在途 Worker 的所有权事实与 Execution Coordination Lease 未被触碰。
 *
 * 它**只在显式选择隔离工作区与专用身份后**才运行：
 *
 * ```sh
 * PLANNING_SMOKE=1 \
 * PLANNING_SMOKE_REPO=<isolated-workspace> \
 * PLANNING_SMOKE_IDENTITY=<dedicated-identity> \
 * pnpm exec vitest run tests/integration/minimax-m3-planning-smoke.test.ts --no-file-parallelism
 * ```
 *
 * 端点、模型与凭据沿用 `.env.smoke` 的 `COORDINATOR_SMOKE_*` 变量：冒烟共用同一份端点配置，凭据只以
 * 标准 provider 环境变量存在，不进入任何配置对象、不写入文件、不打印。未显式开启时整个文件只留一条
 * skip 记录：不加载 env 文件、不解析端点、不加载 provider、不打开数据库、不发起真实调用。
 *
 * 跨库故障窗口（checkpoint 与 admission 之间崩溃、tracker 响应丢失、交接中途重启）仍由
 * `tests/application/planning-handoff.test.ts` 的 fake backend 覆盖：那些窗口需要可重复的注入与
 * 确定性时序，真实 provider 无法稳定提供，因此本文件不重复它们。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage } from '@langchain/core/messages';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { createModuleIntegrationResolverAsync } from '../../src/adapters/agents/chat-model-factory.js';
import { runProcess } from '../../src/adapters/orca-cli/process-runner.js';
import { openCoordinationStore, type CoordinationStore } from '../../src/adapters/storage/coordination-store.js';
import { acquireRuntimeLease } from '../../src/application/coordination/lease-service.js';
import type {
  CoordinationScopeId,
  CoordinatorSessionId,
  PlanningCycleId,
  RuntimeIncarnationId,
} from '../../src/application/dto/identity.js';
import type { CoordinationWriter } from '../../src/application/ports/branch-coordination-store.js';
import { initializeCoordinationScope } from '../../src/application/planning/initialize-scope.js';
import {
  cutoverPlanningHandoff,
  preparePlanningHandoff,
  resumePlanningHandoff,
  reviewPlanningHandoff,
  type HandoffReviewFacts,
} from '../../src/application/planning/planning-handoff.js';
import { COMPANION_STATE_DIRECTORY, coordinationDatabasePath, resolveGitCommonDir } from '../../src/bootstrap/composition.js';
import {
  buildBoundedModelInput,
  deriveContextCapsule,
  toDurableMessage,
  type ToolSchemaEntry,
} from '../../src/workflow/coordinator/context.js';
import {
  planningToolset,
  type PlanningToolOutcome,
  type PlanningToolServices,
} from '../../src/workflow/coordinator/planning-tools.js';
import type { PlanningHandoffResult } from '../../src/application/planning/planning-handoff.js';
import type { PlanningMutationResult } from '../../src/application/planning/route-map-service.js';
import type { HistorySegment } from '../../src/workflow/coordinator/state.js';

const COMPANION_REPOSITORY = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const DEFAULT_ENV_FILE = join(COMPANION_REPOSITORY, '.env.smoke');

/** 只记录、不断言：用于让「未开启时什么都没做」可观察。 */
const DIAGNOSTICS = { envFileLoaded: false, profilesResolved: false };

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
function mergeEnvFile(path: string): void {
  if (!existsSync(path)) {
    return;
  }
  DIAGNOSTICS.envFileLoaded = true;
  for (const [key, value] of parseEnvFile(readFileSync(path, 'utf8'))) {
    if (value.length > 0 && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export type SmokeProfile = {
  readonly id: string;
  readonly integration: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly endpointUrl: string;
  readonly keyEnvVar: string;
  readonly modelOptions: Readonly<Record<string, unknown>>;
};

const PROFILE_SOURCES = [
  {
    id: 'anthropic',
    baseUrlVar: 'COORDINATOR_SMOKE_ANTHROPIC_BASE_URL',
    modelVar: 'COORDINATOR_SMOKE_ANTHROPIC_MODEL',
    defaultIntegration: '@langchain/anthropic#ChatAnthropic',
    defaultKeyEnvVar: 'ANTHROPIC_API_KEY',
    endpointPath: '/v1/messages',
    normalize: (raw: string) => {
      const base = raw.replace(/\/+$/, '');
      return base.endsWith('/v1') ? base.slice(0, -3) : base;
    },
    buildOptions: (baseUrl: string) => ({ temperature: 0, anthropicApiUrl: baseUrl }),
  },
  {
    id: 'openai',
    baseUrlVar: 'COORDINATOR_SMOKE_OPENAI_BASE_URL',
    modelVar: 'COORDINATOR_SMOKE_OPENAI_MODEL',
    defaultIntegration: '@langchain/openai#ChatOpenAI',
    defaultKeyEnvVar: 'OPENAI_API_KEY',
    endpointPath: '/chat/completions',
    normalize: (raw: string) => {
      const base = raw.replace(/\/+$/, '');
      return base.endsWith('/v1') ? base : `${base}/v1`;
    },
    buildOptions: (baseUrl: string) => ({ temperature: 0, configuration: { baseURL: baseUrl } }),
  },
  {
    id: 'openai-responses',
    baseUrlVar: 'COORDINATOR_SMOKE_RESPONSES_BASE_URL',
    fallbackVar: 'COORDINATOR_SMOKE_OPENAI_BASE_URL',
    modelVar: 'COORDINATOR_SMOKE_RESPONSES_MODEL',
    defaultIntegration: '@langchain/openai#ChatOpenAI',
    defaultKeyEnvVar: 'OPENAI_API_KEY',
    endpointPath: '/responses',
    normalize: (raw: string) => {
      const base = raw.replace(/\/+$/, '');
      return base.endsWith('/v1') ? base : `${base}/v1`;
    },
    buildOptions: (baseUrl: string) => ({
      temperature: 0,
      useResponsesApi: true,
      configuration: { baseURL: baseUrl },
    }),
  },
] as const;

const DISABLED_MARKERS: ReadonlySet<string> = new Set(['-', 'off', 'skip', 'none', 'disabled']);

function readProfiles(): readonly SmokeProfile[] {
  const profiles: SmokeProfile[] = [];
  for (const source of PROFILE_SOURCES) {
    const primary = process.env[source.baseUrlVar];
    const fallback = 'fallbackVar' in source ? process.env[source.fallbackVar] : undefined;
    const raw = primary !== undefined ? primary.trim() : (fallback ?? '').trim();
    if (raw.length === 0 || DISABLED_MARKERS.has(raw.toLowerCase())) {
      continue;
    }
    const baseUrl = source.normalize(raw);
    profiles.push({
      id: source.id,
      integration: process.env[`${source.baseUrlVar.replace('_BASE_URL', '')}_INTEGRATION`] ?? source.defaultIntegration,
      model: process.env[source.modelVar] ?? 'MiniMax-M3',
      baseUrl,
      endpointUrl: `${baseUrl}${source.endpointPath}`,
      keyEnvVar: process.env[`${source.baseUrlVar.replace('_BASE_URL', '')}_KEY_ENV`] ?? source.defaultKeyEnvVar,
      modelOptions: source.buildOptions(baseUrl),
    });
  }
  return profiles;
}

/** 一个 key 供各端点共用：注入各集成自己的标准环境变量。 */
function injectSharedKey(profiles: readonly SmokeProfile[]): void {
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

type SmokePlan =
  | { readonly kind: 'skip'; readonly reason: string }
  | {
      readonly kind: 'run';
      readonly workspace: string;
      readonly identity: string;
      readonly profiles: readonly SmokeProfile[];
      readonly envFile: string;
    };

function resolveSmokePlan(): SmokePlan {
  if (process.env['PLANNING_SMOKE'] !== '1') {
    return { kind: 'skip', reason: 'PLANNING_SMOKE 未显式开启' };
  }
  const workspace = (process.env['PLANNING_SMOKE_REPO'] ?? '').trim();
  if (workspace.length === 0) {
    return { kind: 'skip', reason: 'PLANNING_SMOKE_REPO 未显式选择隔离工作区' };
  }
  const identity = (process.env['PLANNING_SMOKE_IDENTITY'] ?? '').trim();
  if (identity.length === 0) {
    return { kind: 'skip', reason: 'PLANNING_SMOKE_IDENTITY 未显式选择专用身份' };
  }
  const envFile = process.env['PLANNING_SMOKE_ENV_FILE'] ?? DEFAULT_ENV_FILE;
  mergeEnvFile(envFile);
  const profiles = readProfiles();
  DIAGNOSTICS.profilesResolved = true;
  injectSharedKey(profiles);
  if (profiles.length === 0) {
    return { kind: 'skip', reason: '未配置任何 provider 端点' };
  }
  return { kind: 'run', workspace: resolve(workspace), identity, profiles, envFile };
}

const PLAN = resolveSmokePlan();
const RUN = PLAN.kind === 'run' ? PLAN : null;

/**
 * 未显式开启时，本文件不产生任何真实调用。
 *
 * 这条断言本身也是「默认跳过」的可观察形式：它检查计划是 skip、env 文件没有被加载、端点没有被解析。
 */
test.skipIf(RUN !== null)('未开启 PLANNING_SMOKE 时整个冒烟被跳过且不加载端点配置', () => {
  expect(PLAN.kind).toBe('skip');
  expect(DIAGNOSTICS.envFileLoaded).toBe(false);
  expect(DIAGNOSTICS.profilesResolved).toBe(false);
});

function currentEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

/**
 * 校验隔离工作区。
 *
 * 「已选择隔离工作区」必须是会失败的检查：不存在的路径、Companion 自身仓库、过宽的上级目录，以及
 * 混入非冒烟内容的工作区都直接拒绝。
 */
function assertIsolatedWorkspace(workspace: string, allowed: ReadonlySet<string>): void {
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
    throw new Error(`PLANNING_SMOKE_REPO 不是存在的目录：${workspace}`);
  }
  if (workspace === COMPANION_REPOSITORY) {
    throw new Error(`PLANNING_SMOKE_REPO 指向 Companion 自身仓库：${workspace}`);
  }
  if (COMPANION_REPOSITORY.startsWith(`${workspace}/`)) {
    throw new Error(`PLANNING_SMOKE_REPO 是 Companion 的上级目录，范围过宽：${workspace}`);
  }
  const unexpected = readdirSync(workspace).filter((name) => !allowed.has(name));
  if (unexpected.length > 0) {
    throw new Error(`隔离工作区混入了非冒烟内容；请改用空目录，当前多余内容：${unexpected.join(', ')}`);
  }
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

type Fixture = {
  readonly profile: SmokeProfile;
  readonly projectDir: string;
  readonly store: CoordinationStore;
  readonly model: BaseChatModel;
  readonly scopeId: CoordinationScopeId;
  readonly sessionA: CoordinatorSessionId;
  readonly sessionB: CoordinatorSessionId;
  readonly writerA: CoordinationWriter;
  readonly writerB: CoordinationWriter;
  readonly dispose: () => void;
};

async function createFixture(plan: Extract<SmokePlan, { kind: 'run' }>, profile: SmokeProfile): Promise<Fixture> {
  const allowed = new Set(plan.profiles.map((entry) => `project-${entry.id}`));
  assertIsolatedWorkspace(plan.workspace, allowed);
  const projectDir = join(plan.workspace, `project-${profile.id}`);
  if (existsSync(projectDir)) {
    throw new Error(`一次性项目目录已存在，冒烟需要干净项目：${projectDir}`);
  }
  await initGitRepository(projectDir);

  const commonDir = await resolveGitCommonDir({ repositoryPath: projectDir, env: currentEnvironment() });
  if (commonDir.kind === 'failed') {
    throw new Error(`无法解析一次性项目的 Git common dir：${commonDir.message}`);
  }
  const stateDir = join(commonDir.path, COMPANION_STATE_DIRECTORY);
  if (existsSync(stateDir)) {
    throw new Error(`一次性项目已存在 Companion 状态：${stateDir}`);
  }
  const opened = openCoordinationStore({ databasePath: coordinationDatabasePath(commonDir.path) });
  if (opened.kind !== 'opened') {
    throw new Error(`无法打开 coordination store：${opened.message}`);
  }
  const store = opened.store;
  const dispose = (): void => {
    store.close();
    rmSync(projectDir, { recursive: true, force: true });
  };

  const resolveIntegration = createModuleIntegrationResolverAsync();
  const integration = await resolveIntegration(profile.integration);
  if (integration === null) {
    dispose();
    throw new Error(`无法加载 provider 集成 ${profile.integration}；请确认它已安装且凭据可用`);
  }
  const model = integration.createChatModel({
    model: profile.model,
    modelOptions: { ...profile.modelOptions, maxRetries: 0 },
  });

  const scopeId = `${plan.identity}:scope` as CoordinationScopeId;
  const sessionA = `${plan.identity}:session-a` as CoordinatorSessionId;
  const sessionB = `${plan.identity}:session-b` as CoordinatorSessionId;
  const initialized = initializeCoordinationScope({
    store,
    coordinationScopeId: scopeId,
    coordinatorSessionId: sessionA,
    coordinatorModelConfigurationRef: `${profile.integration}#${profile.model}`,
    planningCycleId: `${plan.identity}:cycle-1` as PlanningCycleId,
    fullBranchRef: `refs/heads/${plan.identity}`,
    canonicalWorktreePath: '/tmp/orca-smoke-worktree',
  });
  if (initialized.kind !== 'initialized') {
    dispose();
    throw new Error(`无法初始化 Coordination Scope：${initialized.code} ${initialized.message}`);
  }

  const acquiredA = acquireRuntimeLease(store, {
    coordinationScopeId: scopeId,
    coordinatorSessionId: sessionA,
    runtimeIncarnationId: `${plan.identity}:inc-a` as RuntimeIncarnationId,
    fencingGeneration: 0,
  });
  if (acquiredA.kind !== 'acquired') {
    dispose();
    throw new Error('无法为 Source Session 取得 Runtime Lease');
  }
  const writerA: CoordinationWriter = {
    coordinatorSessionId: sessionA,
    runtimeIncarnationId: `${plan.identity}:inc-a` as RuntimeIncarnationId,
    fencingGeneration: acquiredA.lease.fencingGeneration,
  };

  const scopeRow = store.query({ kind: 'scope', coordinationScopeId: scopeId });
  if (scopeRow.kind !== 'scope' || scopeRow.scope === null) {
    dispose();
    throw new Error('无法读回刚创建的 Scope');
  }
  const registered = store.transact({
    kind: 'register-session',
    coordinationScopeId: scopeId,
    expectedRevision: scopeRow.scope.revision,
    writer: writerA,
    coordinatorSessionId: sessionB,
    coordinatorModelConfigurationRef: `${profile.integration}#${profile.model}`,
    lifecycleState: 'registered',
  });
  if (registered.kind !== 'committed') {
    dispose();
    throw new Error('无法注册 Target Session');
  }
  const acquiredB = acquireRuntimeLease(store, {
    coordinationScopeId: scopeId,
    coordinatorSessionId: sessionB,
    runtimeIncarnationId: `${plan.identity}:inc-b` as RuntimeIncarnationId,
    fencingGeneration: 0,
  });
  if (acquiredB.kind !== 'acquired') {
    dispose();
    throw new Error('无法为 Target Session 取得 Runtime Lease');
  }
  const writerB: CoordinationWriter = {
    coordinatorSessionId: sessionB,
    runtimeIncarnationId: `${plan.identity}:inc-b` as RuntimeIncarnationId,
    fencingGeneration: acquiredB.lease.fencingGeneration,
  };

  // 在途 Worker 的等价事实：一个执行租约与一条 Ticket Claim。交接不得触碰它们。
  const current = store.query({ kind: 'scope', coordinationScopeId: scopeId });
  if (current.kind !== 'scope' || current.scope === null) {
    dispose();
    throw new Error('Scope 在读回时消失');
  }
  const lease = store.transact({
    kind: 'acquire-execution-lease',
    coordinationScopeId: scopeId,
    expectedRevision: current.scope.revision,
    writer: writerA,
  });
  if (lease.kind !== 'committed') {
    dispose();
    throw new Error('无法取得 Execution Coordination Lease');
  }
  const claim = store.transact({
    kind: 'record-ticket-claim',
    coordinationScopeId: scopeId,
    expectedRevision: lease.revision,
    writer: writerA,
    ticketRef: { kind: 'decision-ticket', id: `${plan.identity}:ticket-1` },
  });
  if (claim.kind !== 'committed') {
    dispose();
    throw new Error('无法登记起始 Ticket Claim');
  }

  return { profile, projectDir, store, model, scopeId, sessionA, sessionB, writerA, writerB, dispose };
}

function textOf(value: unknown): string {
  if (typeof value !== 'object' || value === null) {
    return '';
  }
  const text = (value as { readonly text?: unknown }).text;
  if (typeof text === 'string') {
    return text;
  }
  const content = (value as { readonly content?: unknown }).content;
  return typeof content === 'string' ? content : '';
}

/**
 * 当前暴露给 Coordinator 的规划工具 schema。
 *
 * 冒烟不构造应用服务，因此只取工具的名字、描述与输入 schema —— 它们才是 Capsule 输入要携带的上下文
 * 契约；handler 是否需要服务与「provider 是否接受这份输入」无关。只读权限下工具集恰好是只读的那两个，
 * 因此没有一个 handler 会被真正调用。
 */
const SMOKE_UNUSED = '冒烟只读取工具 schema，不调用 handler';

const unusedOutcome = (): Promise<PlanningToolOutcome> =>
  Promise.resolve({ kind: 'rejected', code: 'unused', message: SMOKE_UNUSED });
const unusedMutation = (): Promise<PlanningMutationResult> =>
  Promise.resolve({ kind: 'rejected', code: 'unused', message: SMOKE_UNUSED });
const unusedHandoff = (): Promise<PlanningHandoffResult> =>
  Promise.resolve({ kind: 'rejected', failure: { code: 'unused', message: SMOKE_UNUSED } });

const PLANNING_TOOL_SERVICES: PlanningToolServices = {
  readFacts: () => {
    throw new Error(SMOKE_UNUSED);
  },
  readRouteMap: unusedOutcome,
  readFrontier: unusedOutcome,
  updateRouteMapSection: unusedMutation,
  claimTicket: unusedMutation,
  releaseTicket: unusedMutation,
  resolveTicket: unusedMutation,
  preparePlanningHandoff: unusedHandoff,
  reviewPlanningHandoff: unusedHandoff,
};

const PLANNING_TOOL_SCHEMA: readonly ToolSchemaEntry[] = planningToolset(
  {
    mode: 'route_planning',
    controlState: 'active',
    coordinationScopeId: 'smoke:scope' as CoordinationScopeId,
    coordinatorSessionId: 'smoke:session' as CoordinatorSessionId,
    scopeRevision: 1,
    activation: { kind: 'active', coordinatorSessionId: 'smoke:session' as CoordinatorSessionId },
    permissions: { allowPlanningWrites: false },
    budget: { remainingMutations: 0 },
  },
  PLANNING_TOOL_SERVICES,
).map((definition) => ({
  name: definition.name,
  description: definition.description,
  schema: definition.inputSchema,
}));

function isSystemMessage(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const getType = (value as { readonly getType?: unknown }).getType;
  if (typeof getType !== 'function') {
    return false;
  }
  return (getType as () => unknown).call(value) === 'system';
}

async function generateCapsuleSmoke(fixture: Fixture): Promise<{ readonly capsuleChars: number }> {
  const first = await fixture.model.invoke([new HumanMessage('用一句话说明这个项目要做的事。')]);
  const second = await fixture.model.invoke([
    new HumanMessage('再用一句话说明这个项目的第一条约束。'),
    toDurableMessage(first),
  ]);

  const segments: readonly HistorySegment[] = [
    { kind: 'messages', stepId: 'step-1', messages: [toDurableMessage(first)] },
    { kind: 'messages', stepId: 'step-2', messages: [toDurableMessage(second)] },
  ];

  // 估算是纯函数，且必须对 Capsule 片段给出远小于逐字消息的规模：否则 Capsule 路径永远「没进展」，
  // 输入会被判成 compaction_degraded，测不出真正的压缩成功。
  const estimate = (candidate: readonly HistorySegment[]): number =>
    candidate.reduce((total, segment) => total + (segment.kind === 'capsule' ? 64 : 8_000), 0);

  const bounded = buildBoundedModelInput({
    segments,
    // 两个逐字 step 远超预算，压缩后只剩「一个 Capsule + 最新 step」，恰好落回预算内。
    estimate,
    fixedOverhead: 128,
    budgetTokens: 8_192,
    native: { kind: 'unavailable', reason: '冒烟不探测 provider 原生压缩' },
    shaken: false,
    instructions: ['你是 Orca Companion 的 Coordinator Agent。'],
    // 规划工具就是当前配置的 tool schema：Capsule 输入必须连同它一起重新注入。
    toolSchema: PLANNING_TOOL_SCHEMA,
    authoritativeFacts: ['Scope 处于 route_planning 模式'],
    currentWork: { workKind: 'pending_interaction', summary: '确认 Destination' },
  });

  expect(bounded.compaction.kind).toBe('compacted');
  if (bounded.compaction.kind === 'compacted') {
    expect(bounded.compaction.path).toBe('context_capsule');
  }
  // 真实 provider 必须接受这份 Capsule 输入：这正是 D19 抓到过缺陷的地方。
  const systemCount = bounded.messages.filter((message) => isSystemMessage(message)).length;
  expect(systemCount).toBe(1);
  expect(isSystemMessage(bounded.messages[0])).toBe(true);
  const response = await fixture.model.invoke(bounded.messages as never);
  const text = textOf(response).trim();
  expect(text.length).toBeGreaterThan(0);
  return { capsuleChars: text.length };
}

async function runPlanningHandoffSmoke(fixture: Fixture): Promise<void> {
  const before = fixture.store.query({ kind: 'snapshot', coordinationScopeId: fixture.scopeId });
  if (before.kind !== 'snapshot') {
    throw new Error('无法读取起始快照');
  }

  // 真实模型产出 Destination 摘要，并据此派生一个可移植 Capsule：真实调用确实参与交接。
  const summary = await fixture.model.invoke([new HumanMessage('用一句话给出这个项目的 Destination。')]);
  const capsule = deriveContextCapsule({
    fromStepId: 'step-1',
    toStepId: 'step-1',
    steps: [{ stepId: 'step-1', messages: [toDurableMessage(summary)] }],
  });
  expect(capsule.text.trim().length).toBeGreaterThan(0);

  const scope = fixture.store.query({ kind: 'scope', coordinationScopeId: fixture.scopeId });
  if (scope.kind !== 'scope' || scope.scope === null) {
    throw new Error('无法读取 Scope');
  }
  const proposalId = 'smoke-proposal-1';
  const prepared = preparePlanningHandoff({
    store: fixture.store,
    coordinationScopeId: fixture.scopeId,
    writer: fixture.writerA,
    proposalId,
    targetCoordinatorSessionId: fixture.sessionB,
    mapRevision: scope.scope.mapRevision,
    planRevision: 1,
    graphId: null,
    graphVersion: null,
    capsuleRef: capsule.capsuleId,
  });
  expect(prepared.kind).toBe('prepared');

  const facts: HandoffReviewFacts = {
    currentMapRevision: scope.scope.mapRevision,
    currentPlanRevision: 1,
    openDecisionTickets: 0,
    candidate: null,
  };
  const reviewed = reviewPlanningHandoff({
    store: fixture.store,
    coordinationScopeId: fixture.scopeId,
    writer: fixture.writerB,
    proposalId,
    facts,
  });
  expect(reviewed.kind).toBe('reviewed');

  const cut = cutoverPlanningHandoff({
    store: fixture.store,
    coordinationScopeId: fixture.scopeId,
    writer: fixture.writerA,
    proposalId,
    facts: { currentMapRevision: facts.currentMapRevision, currentPlanRevision: 1, candidate: null },
  });
  expect(cut.kind).toBe('cutover');

  const responsibility = fixture.store.query({
    kind: 'planning-responsibility',
    coordinationScopeId: fixture.scopeId,
  });
  expect(responsibility.kind === 'planning-responsibility' ? responsibility.responsibility?.coordinatorSessionId : null).toBe(
    fixture.sessionB,
  );
  expect(resumePlanningHandoff({ store: fixture.store, coordinationScopeId: fixture.scopeId }).kind).toBe(
    'cutover_done',
  );

  const after = fixture.store.query({ kind: 'snapshot', coordinationScopeId: fixture.scopeId });
  if (after.kind !== 'snapshot') {
    throw new Error('无法读取结束快照');
  }
  expect(after.snapshot.executionLease?.coordinatorSessionId).toBe(fixture.sessionA);
  expect(after.snapshot.ticketClaims.map((claim) => claim.ticketRef.id)).toEqual(
    before.snapshot.ticketClaims.map((claim) => claim.ticketRef.id),
  );
  expect(after.snapshot.scope.mode).toBe(before.snapshot.scope.mode);
}

describe.skipIf(RUN === null)('PLANNING_SMOKE：真实 provider 冒烟', () => {
  const fixtures = new Map<string, Fixture>();

  beforeAll(async () => {
    if (RUN === null) {
      return;
    }
    for (const profile of RUN.profiles) {
      fixtures.set(profile.id, await createFixture(RUN, profile));
    }
  }, 300_000);

  afterAll(() => {
    for (const fixture of fixtures.values()) {
      fixture.dispose();
    }
  });

  for (const profile of RUN?.profiles ?? []) {
    test(`[${profile.id}] generateCapsuleSmoke：真实模型派生并使用一次 Context Capsule`, async () => {
      const fixture = fixtures.get(profile.id);
      expect(fixture).toBeDefined();
      if (fixture === undefined) {
        return;
      }
      const observation = await generateCapsuleSmoke(fixture);
      process.stdout.write(`[planning-smoke] ${profile.id} capsule=${observation.capsuleChars} chars\n`);
    }, 300_000);

    test(`[${profile.id}] runPlanningHandoffSmoke：真实条件下完成 prepare→review→cutover`, async () => {
      const fixture = fixtures.get(profile.id);
      expect(fixture).toBeDefined();
      if (fixture === undefined) {
        return;
      }
      await runPlanningHandoffSmoke(fixture);
      process.stdout.write(`[planning-smoke] ${profile.id} handoff=cutover\n`);
    }, 300_000);
  }
});
