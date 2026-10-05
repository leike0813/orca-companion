#!/usr/bin/env node
/**
 * restore-configurable-execution-concurrency IP-05：建立多包并发真实验收用的隔离项目与专用协调身份。
 *
 * 用法：`node artifacts/execution-concurrency/setup-fixture.mjs <fixture-path> <name> [--dry-run]`
 *
 * `--dry-run` 只写项目配置并用生产解析器核验，不做 git/Orca 登记：先确认配置与凭据可用，再花掉
 * 隔离仓库与专用终端这两项一次性资源。
 *
 * 与 `~/.cache/orca-acceptance/setup-fixture.sh` 的差别是本 change 要求的两处：
 *
 * 1. 项目配置是 **schema 3**：删除重复的 `concurrencyLimit`，并行包额度用
 *    `limits.maxActiveWorkPackages`，并单独给出 `maxWorkPackages`（图容量）与
 *    `integrationReconciliations`（集成复验）。本验收显式把并行额度设为 5，证明它可配置且大于
 *    设计时的保守假定 3。
 * 2. 凭据走**隔离的用户级 CredentialStore**：本脚本新建一个 0700 的 `XDG_CONFIG_HOME`，用生产
 *    `JsonCredentialStore` 存一次（只有 SDK 构造需要的非秘密占位值），拿到它生成的不可变
 *    `credentialRef` 再写进项目配置。用户的 `~/.config/orca-companion` 不被读写、不被 chmod。
 *
 * 连接参数（provider integration、本机已核验的 loopback OAuth 代理与验收模型）是**非秘密**的，
 * 可沿用既有验收现场；任何 secret 都不写入本文件、不写入仓库、不进日志。
 *
 * 需要先 `pnpm build`：凭据写入走的是生产模块（`dist/`），不是这里手搓的 JSON。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath, pathToFileURL } from 'node:url';

const COMPANION_REPOSITORY = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const CREDENTIAL_STORE_MODULE = join(
  COMPANION_REPOSITORY,
  'dist',
  'src',
  'adapters',
  'storage',
  'credential-store.js',
);
const PROJECT_CONFIG_MODULE = join(
  COMPANION_REPOSITORY,
  'dist',
  'src',
  'application',
  'configuration',
  'project-config.js',
);
const ACCEPTANCE_BIN = '/home/joshua/.cache/orca-acceptance/acceptance-bin';
const INTEGRATION_REMOTE = process.env['ORCA_COMPANION_ACCEPTANCE_REMOTE'] ??
  'https://github.com/leike0813/orca-companion-test';

/**
 * 预建的标准 OpenSpec 结构（`openspec init --tools none` 的原样产物）。
 *
 * 基线就带同一份 `openspec/config.yaml` 时，两个包的 canonical 共享它，Planner 无需再 init，
 * 集成复验也就不会把 `openspec/config.yaml` 的 add/add 变化判成某个包的越权修改。
 */
const OPENSPEC_CONFIG_TEMPLATE = "schema: spec-driven\n\n# Project context (optional)\n# Add only constraints that should guide OpenSpec artifacts and workflows.\n# Include constraints an agent cannot infer by reading the code.\n# Keep general project documentation and discoverable codebase facts out.\n# Example:\n#   context: |\n#     Designs and tasks must cover Windows, macOS, and Linux\n#     Write all artifacts in Spanish\n\n# Per-artifact rules (optional)\n# Add custom rules for specific artifacts.\n# Example:\n#   rules:\n#     proposal:\n#       - Keep proposals under 500 words\n#       - Always state what is out of scope\n#     tasks:\n#       - Break tasks into chunks of max 2 hours\n\n# Per-operation guidance (optional)\n# Add advisory guidance for how apply and archive work should be conducted.\n# This is separate from artifact rules above.\n# Example:\n#   operations:\n#     apply:\n#       guidance:\n#         - Keep test summaries concise\n#     archive:\n#       guidance:\n#         - Summarize the archive outcome before finishing\n";

/** 用户批准的验收模型与本机已核验的 loopback OAuth 代理（均非秘密）。 */
const ACCEPTANCE_MODEL = process.env['ORCA_COMPANION_COORDINATOR_MODEL'] ?? 'minimax-cn/MiniMax-M3.1-Flash-Preview';
const PROVIDER_ID = 'companion-oauth';
const PROVIDER_INTEGRATION = '@langchain/openai#ChatOpenAI';
const DEFAULT_BASE_URL = 'http://127.0.0.1:10100/v1';
const CONNECTION_REF = 'acceptance-coordinator';
const WORKER_CONNECTION_REF = 'acceptance-worker';
const MODEL_REF = 'acceptance-model';
const WORKER_MODEL_REF = 'acceptance-worker-model';
const CONFIGURATION_REF = 'planning-default';
const WORKER_ROLES = ['planner', 'implementation', 'validator', 'finalizer', 'recovery_utility'];
const SDK_COMPATIBILITY_PLACEHOLDER = 'loopback-oauth-proxy';

/** 本验收的唯一并发目标：额度可配置且大于 3。 */
const ACCEPTANCE_MAX_ACTIVE_PACKAGES = 5;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function runOrca(args, what) {
  const result = spawnSync('orca', args, { encoding: 'utf8', timeout: 120_000 });
  if (result.status !== 0) {
    fail(`${what} 失败（exit ${String(result.status)}）：${(result.stderr ?? '').trim()}`);
  }
  return JSON.parse(result.stdout);
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    fail(`git ${args.join(' ')} 失败（exit ${String(result.status)}）：${(result.stderr ?? '').trim()}`);
  }
  return (result.stdout ?? '').trim();
}

function projectConfig(credentialRef, integrationRef) {
  const coordinatorConnection = {
    connectionRef: CONNECTION_REF,
    label: '本机 OAuth Coordinator',
    providerIntegration: PROVIDER_INTEGRATION,
    modelOptions: { temperature: 0, configuration: { baseURL: DEFAULT_BASE_URL } },
    credential: { kind: 'managed', credentialRef, optionPath: 'apiKey' },
    codex: null,
  };
  const workerConnection = {
    connectionRef: WORKER_CONNECTION_REF,
    label: '本机 OAuth Worker Harness',
    providerIntegration: PROVIDER_INTEGRATION,
    modelOptions: { temperature: 0, configuration: { baseURL: DEFAULT_BASE_URL } },
    credential: { kind: 'harness_login' },
    codex: { providerId: PROVIDER_ID, baseUrl: DEFAULT_BASE_URL, wireApi: 'responses' },
  };
  const model = {
    modelRef: MODEL_REF,
    connectionRef: CONNECTION_REF,
    model: ACCEPTANCE_MODEL,
    effortCapability: null,
  };
  const workerModel = {
    modelRef: WORKER_MODEL_REF,
    connectionRef: WORKER_CONNECTION_REF,
    model: ACCEPTANCE_MODEL,
    effortCapability: null,
  };
  const workerModelConfiguration = {
    connection: workerConnection,
    modelRef: WORKER_MODEL_REF,
    model: ACCEPTANCE_MODEL,
    effort: null,
    effortCapability: null,
    modelOptions: {},
  };
  return {
    schemaVersion: 3,
    revision: 0,
    providerConnections: [coordinatorConnection, workerConnection],
    models: [model, workerModel],
    coordinatorModels: [
      {
        configurationRef: CONFIGURATION_REF,
        providerIntegration: PROVIDER_INTEGRATION,
        model: ACCEPTANCE_MODEL,
        modelOptions: { temperature: 0, configuration: { baseURL: DEFAULT_BASE_URL } },
        credentialRefs: [credentialRef],
        nativeWindowOwnerRef: null,
        providerConnection: coordinatorConnection,
        modelRef: MODEL_REF,
        effortCapability: null,
      },
    ],
    defaultCoordinatorModelRef: CONFIGURATION_REF,
    tracker: { kind: 'github', routeMapIssueNumber: 1 },
    planning: { maxMutations: 8 },
    context: { maxInputTokens: 20000 },
    execution: {
      harness: 'codex',
      workerProfiles: WORKER_ROLES.map((role) => ({
        profileRef: `profile-${role}`,
        role,
        harness: 'codex',
        modelConfiguration: workerModelConfiguration,
      })),
      workerProfileRefs: Object.fromEntries(WORKER_ROLES.map((role) => [role, `profile-${role}`])),
      codexSandbox: 'danger-full-access',
      git: { remotes: ['origin'], refs: [`refs/heads/${integrationRef}`] },
      limits: {
        maxActiveWorkPackages: ACCEPTANCE_MAX_ACTIVE_PACKAGES,
        maxWorkPackages: 8,
        integrationReconciliations: 2,
        implementationAttempts: 2,
        validatorRepairs: 2,
        graphRevisions: 2,
        specificationRevisions: 2,
        maxRecoveriesPerWorkerAttempt: 1,
      },
      acceptedRisks: ['codex-sandbox-danger-full-access'],
    },
  };
}

const [fixtureArgument, name, ...flags] = process.argv.slice(2);
const dryRun = flags.includes('--dry-run');
if (fixtureArgument === undefined || name === undefined) {
  fail('用法：node artifacts/execution-concurrency/setup-fixture.mjs <fixture-path> <name>');
}
const fixture = resolve(fixtureArgument);
const xdgRoot = `${fixture}-xdg`;
const integrationRef = `${name}-integration`;

if (!existsSync(CREDENTIAL_STORE_MODULE)) {
  fail('先运行 pnpm build：凭据写入走生产模块 dist/src/adapters/storage/credential-store.js');
}
if (DEFAULT_BASE_URL === '') fail('验收代理 URL 未配置');
const modelsResponse = await globalThis.fetch(`${DEFAULT_BASE_URL}/models`, {
  signal: globalThis.AbortSignal.timeout(5_000),
});
if (!modelsResponse.ok) fail(`本机模型代理不可用：HTTP ${modelsResponse.status}`);
const modelsPayload = await modelsResponse.json();
const availableModels = Array.isArray(modelsPayload?.data) ? modelsPayload.data : [];
if (!availableModels.some((entry) => entry?.id === ACCEPTANCE_MODEL)) {
  fail(`本机模型代理未列出 ${ACCEPTANCE_MODEL}`);
}

// 隔离凭据根：0700 是 store 合同对目录的硬要求，因此由这里新建而不是继承用户目录。
mkdirSync(xdgRoot, { recursive: true, mode: 0o700 });
const { JsonCredentialStore } = await import(pathToFileURL(CREDENTIAL_STORE_MODULE).href);
const store = new JsonCredentialStore({ environment: { XDG_CONFIG_HOME: xdgRoot } });
const metadata = store.metadata();
if (metadata.kind !== 'metadata') {
  fail(`读取隔离凭据存储失败：${metadata.code} ${metadata.message}`);
}
// SDK 需要非空的 apiKey 字段；loopback OAuth 代理自身负责上游认证。该值不是用户凭据。
const saved = store.save({ expectedRevision: metadata.revision, secret: SDK_COMPATIBILITY_PLACEHOLDER });
if (saved.kind !== 'saved') {
  fail(`写入隔离凭据存储失败：${saved.code} ${saved.message}`);
}

mkdirSync(fixture, { recursive: true });
writeFileSync(join(fixture, '.gitignore'), '');
writeFileSync(join(fixture, 'README.md'), `# ${name}\n`);
// 预建标准 OpenSpec 结构：两个包的 canonical 共享同一份 config，Planner 无需 init，
// 集成复验因此不会把 openspec/config.yaml 的 add/add 变化判成某个包的越权修改。
mkdirSync(join(fixture, 'openspec', 'specs'), { recursive: true });
mkdirSync(join(fixture, 'openspec', 'changes', 'archive'), { recursive: true });
writeFileSync(join(fixture, 'openspec', 'specs', '.gitkeep'), '');
writeFileSync(join(fixture, 'openspec', 'changes', 'archive', '.gitkeep'), '');
writeFileSync(join(fixture, 'openspec', 'config.yaml'), OPENSPEC_CONFIG_TEMPLATE, { mode: 0o644 });
const config = projectConfig(saved.credentialRef, integrationRef);
writeFileSync(join(fixture, 'orca-companion.json'), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o644 });

// 夹具必须能被生产解析器接受：配置形状错了要在这里失败，而不是等到授权审阅那一步。
const { parseProjectConfig } = await import(pathToFileURL(PROJECT_CONFIG_MODULE).href);
const parsed = parseProjectConfig(config);
if (!parsed.ok) {
  fail(`生成的项目配置未通过生产解析：${parsed.field} ${parsed.message}`);
}
if (dryRun) {
  process.stdout.write(`dry-run ok：${join(fixture, 'orca-companion.json')}\n`);
  process.exit(0);
}

git(fixture, ['init', '-q', '-b', 'main']);
git(fixture, ['-c', 'user.email=acceptance@local', '-c', 'user.name=acceptance', 'add', '-A']);
git(fixture, [
  '-c', 'user.email=acceptance@local', '-c', 'user.name=acceptance', 'commit', '-q',
  '-m', `${name}: isolated project baseline`,
]);
git(fixture, ['remote', 'add', 'origin', INTEGRATION_REMOTE]);

// 项目必须先登记进 Orca，否则 worktree / terminal 的 path 选择器会以 selector_not_found 失败。
runOrca(['repo', 'add', '--path', fixture, '--json'], 'orca repo add');
const created = runOrca(
  [
    'terminal', 'create', '--worktree', `path:${fixture}`,
    // 身份终端必须是可交互 shell：验收进程要经 `orca terminal send` 在其中运行，Orca 才会把
    // 请求认证成这个终端；`sleep infinity` 不接受输入，无法承载验证进程。
    '--title', `${name}-identity`, '--command', 'bash -i', '--json',
  ],
  'orca terminal create',
);
const identity = created?.result?.terminal?.handle;
if (typeof identity !== 'string' || identity.length === 0) {
  fail('orca terminal create 没有返回 terminal handle');
}

const evidence = {
  fixture,
  name,
  baselineHead: git(fixture, ['rev-parse', 'HEAD']),
  integrationRef,
  integrationRemote: INTEGRATION_REMOTE,
  identity,
  credentialRef: saved.credentialRef,
  credentialStorePath: join(xdgRoot, 'orca-companion', 'credentials.json'),
  acceptanceModel: ACCEPTANCE_MODEL,
  maxActiveWorkPackages: ACCEPTANCE_MAX_ACTIVE_PACKAGES,
  coordinatorBaseUrl: DEFAULT_BASE_URL,
  coordinatorProviderIntegration: PROVIDER_INTEGRATION,
  coordinatorWireApi: 'chat',
  coordinatorCredential: 'non-secret-sdk-placeholder-in-isolated-CredentialStore',
  workerCredential: 'harness_login',
  workerWireApi: 'responses',
};
const evidenceDirectory = join(COMPANION_REPOSITORY, 'artifacts', 'execution-concurrency');
mkdirSync(evidenceDirectory, { recursive: true });
const evidencePath = join(evidenceDirectory, `fixture-${name}.json`);
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

process.stdout.write([
  `# 隔离验收环境已建立；证据：${evidencePath}`,
  `export PATH=${ACCEPTANCE_BIN}:$PATH`,
  `export XDG_CONFIG_HOME=${xdgRoot}`,
  `export ORCA_COMPANION_E2E_REPO=${fixture}`,
  `export ORCA_COMPANION_E2E_IDENTITY=${identity}`,
  `export ORCA_COMPANION_E2E_CONCURRENCY=1`,
  `export ORCA_COMPANION_COORDINATOR_MODEL=${ACCEPTANCE_MODEL}`,
  '',
].join('\n'));
