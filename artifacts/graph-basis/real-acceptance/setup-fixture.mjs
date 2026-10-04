/**
 * `complete-tui-graph-basis` IP-05 / D06：建立一次真实验收用的隔离项目、隔离凭据存储与专用协调身份。
 *
 * 用法：`node setup-fixture.mjs <fixture-path> <name> [--dry-run]`
 *
 * `--dry-run` 只写项目配置并用生产解析器核验，不做 git/Orca 登记：先确认配置与凭据可用，再花掉隔离
 * 仓库与专用终端这两项一次性资源。
 *
 * 与 `~/.cache/orca-acceptance/setup-fixture.sh` 的差别只有两处，都是当前产品合同要求的：
 *
 * 1. 项目配置是 **schema 2**（`providerConnections` + `models` + `execution.workerProfiles`），五个角色
 *    各自带完整 `modelConfiguration` 并显式绑定本批验收模型；旧脚本写的是 schema 1 的
 *    `execution.workerModel`，现在会被明确拒绝。
 * 2. 凭据走**隔离的用户级 CredentialStore**：本脚本新建一个 0700 的 `XDG_CONFIG_HOME`，用生产
 *    `JsonCredentialStore` 存一次，拿到它自己生成的不可变 `credentialRef`（uuid）再写进项目配置。
 *    用户的 `~/.config/orca-companion` 不被读写、不被 chmod——它当前是 0755，产品按
 *    `permission_denied` 拒绝，本脚本因此完全绕开它。
 *
 * 仅 SDK 构造需要的非秘密占位值由生产 CredentialStore 隔离保存；它不是代理认证凭据。
 * 需要先 `pnpm build`：凭据写入走的是生产模块（`dist/`），不是这里手搓的 JSON。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath, pathToFileURL } from 'node:url';

const COMPANION_REPOSITORY = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
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

/** D06 用户批准的 Coordinator 模型和已核验的本机 OAuth proxy。 */
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
    schemaVersion: 2,
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
      workerProfileRefs: Object.fromEntries(
        WORKER_ROLES.map((role) => [role, `profile-${role}`]),
      ),
      codexSandbox: 'danger-full-access',
      git: { remotes: ['origin'], refs: [`refs/heads/${integrationRef}`] },
      limits: {
        maxActiveWorkPackages: 8,
        concurrencyLimit: 1,
        implementationAttempts: 2,
        validatorRepairs: 1,
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
  fail('用法：node setup-fixture.mjs <fixture-path> <name>');
}
const fixture = resolve(fixtureArgument);
const xdgRoot = `${fixture}-xdg`;
const integrationRef = `${name}-integration`;

if (!existsSync(CREDENTIAL_STORE_MODULE)) {
  fail('先运行 pnpm build：凭据写入走生产模块 dist/src/adapters/storage/credential-store.js');
}
if (DEFAULT_BASE_URL !== 'http://127.0.0.1:10100/v1') fail('验收代理 URL 不符合已批准配置');
const modelsResponse = await globalThis.fetch(`${DEFAULT_BASE_URL}/models`, {
  signal: globalThis.AbortSignal.timeout(5_000),
});
if (!modelsResponse.ok) fail(`本机模型代理不可用：HTTP ${modelsResponse.status}`);
const modelsPayload = await modelsResponse.json();
const availableModels = Array.isArray(modelsPayload?.data) ? modelsPayload.data : [];
if (!availableModels.some((model) => model?.id === ACCEPTANCE_MODEL)) {
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
// ChatOpenAI/OpenAI SDK 要求存在 apiKey 字段；loopback OAuth 代理自身负责上游 OAuth。
// 该非秘密值仅用于 SDK 构造兼容，既不认证代理，也不包含任何用户凭据。
const saved = store.save({ expectedRevision: metadata.revision, secret: SDK_COMPATIBILITY_PLACEHOLDER });
if (saved.kind !== 'saved') {
  fail(`写入隔离凭据存储失败：${saved.code} ${saved.message}`);
}

mkdirSync(fixture, { recursive: true });
writeFileSync(join(fixture, '.gitignore'), '');
writeFileSync(join(fixture, 'README.md'), `# ${name}\n`);
const config = projectConfig(saved.credentialRef, integrationRef);
writeFileSync(
  join(fixture, 'orca-companion.json'),
  `${JSON.stringify(config, null, 2)}\n`,
  { mode: 0o644 },
);

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
    '--title', `${name}-identity`, '--command', 'sleep infinity', '--json',
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
  coordinationScopeId: `ip05-${name}-scope`,
  expectedRunCreateOperationId: `run-create:${`ip05-${name}-scope`}#g1`,
  coordinatorBaseUrl: DEFAULT_BASE_URL,
  coordinatorProviderIntegration: PROVIDER_INTEGRATION,
  coordinatorWireApi: 'chat',
  coordinatorCredential: 'non-secret-sdk-placeholder-in-isolated-CredentialStore',
  workerCredential: 'harness_login',
  workerWireApi: 'responses',
};
const evidenceDirectory = join(COMPANION_REPOSITORY, 'artifacts', 'graph-basis', 'real-acceptance');
mkdirSync(evidenceDirectory, { recursive: true });
const evidencePath = join(evidenceDirectory, `fixture-${name}.json`);
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

process.stdout.write([
  `# 隔离验收环境已建立；证据：${evidencePath}`,
  `export PATH=${ACCEPTANCE_BIN}:$PATH`,
  `export XDG_CONFIG_HOME=${xdgRoot}`,
  'export ORCA_COMPANION_REAL_HARNESS=1',
  `export ORCA_COMPANION_REAL_REPO=${fixture}`,
  `export ORCA_COMPANION_REAL_IDENTITY=${identity}`,
  `export ORCA_COMPANION_REAL_SCOPE=ip05-${name}-scope`,
  `export ORCA_COMPANION_COORDINATOR_MODEL=${ACCEPTANCE_MODEL}`,
  '',
].join('\n'));
