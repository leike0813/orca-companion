import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import {
  CODEX_UTILITY_PERMISSION_PROFILE,
  CODEX_UTILITY_PROFILE_CONFIG_TOML,
  createCodexResumeLaunch,
  createCodexWorkerLaunch,
  installCodexSessionStartReporter,
} from '../../../src/adapters/agents/codex-launch.js';
import { CODEX_MANAGED_CREDENTIAL_ENV } from '../../../src/adapters/agents/codex-model-launcher.js';
import { JsonCredentialStore } from '../../../src/adapters/storage/credential-store.js';
import { credentialStoreFixture, modelConfigurationFixture } from '../../support/model-configurations.js';
import type { CredentialStore } from '../../../src/application/ports/credential-store.js';
import type { WorkerModelConfiguration } from '../../../src/domain/model-configuration.js';
import { codexConfigValue } from '../../../src/adapters/agents/codex-model-launcher.js';

const roots: string[] = [];

/** harness_login 绑定不会读凭据，但启动装配仍要求宿主注入 store：这些用例给一个不读文件的替身。 */
const unusedCredentialStore = credentialStoreFixture();

test('SessionStart reporter 可执行并写出完整的一行身份报告', () => {
  const root = mkdtempSync(join(tmpdir(), 'companion-codex-reporter-'));
  roots.push(root);
  const reporterPath = join(root, 'reporter.mjs');
  const reportPath = join(root, 'report.jsonl');
  installCodexSessionStartReporter({ reporterPath, reportPath });
  const event = { session_id: 'session-1', transcript_path: '/tmp/session-1.jsonl', cwd: '/tmp/worktree' };
  const stdout = execFileSync(process.execPath, [reporterPath], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    env: { ...process.env, CODEX_HOME: '/tmp/codex-home' },
  });
  expect(JSON.parse(stdout)).toEqual({});
  const report = JSON.parse(readFileSync(reportPath, 'utf8').trim()) as Record<string, unknown>;
  expect(report).toMatchObject({
    sessionId: event.session_id,
    transcriptPath: event.transcript_path,
    codexHome: '/tmp/codex-home',
    cwd: event.cwd,
  });
  expect(Number.isFinite(Date.parse(String(report['observedAt'])))).toBe(true);
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Codex prepared-terminal 只写 worktree 内隔离状态，并固定 trust bypass', async () => {
  const root = mkdtempSync(join(tmpdir(), 'companion-codex-launch-'));
  roots.push(root);
  const sourceHome = join(root, 'source-codex-home');
  const worktree = join(root, 'worktree');
  const sourceConfig = 'model = "minimax-cn/MiniMax-M3"\n';
  mkdirSync(sourceHome, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(sourceHome, 'config.toml'), sourceConfig, 'utf8');
  writeFileSync(join(sourceHome, 'auth.json'), '{"test":true}\n', 'utf8');
  const reporter = join(worktree, '.companion', 'session-start.mjs');
  mkdirSync(join(worktree, '.companion'), { recursive: true });
  writeFileSync(reporter, '', 'utf8');

  const strategy = createCodexWorkerLaunch({
    launchId: 'validator:attempt-1',
    modelConfiguration: modelConfigurationFixture(),
    credentialStore: unusedCredentialStore,
    sandboxMode: 'workspace-write',
    sourceCodexHome: sourceHome,
    sessionStartReporterPath: reporter,
  });
  const prepared = await strategy.prepare({ worktreePath: worktree });

  expect(strategy.kind).toBe('prepared_terminal');
  expect(prepared.title).toMatch(/^orca-companion:codex:/);
  expect(descriptorArgs(prepared.stateRoot)).toContain('--dangerously-bypass-hook-trust');
  expect(descriptorArgs(prepared.stateRoot)).toContain('--ask-for-approval never --sandbox workspace-write');
  expect(prepared.command).toContain('codex-model-launcher.mjs');
  expect(readFileSync(join(sourceHome, 'config.toml'), 'utf8')).toBe(sourceConfig);
  expect(readFileSync(join(prepared.stateRoot, 'config.toml'), 'utf8')).toContain(
    `[projects.${JSON.stringify(worktree)}]`,
  );
  expect(existsSync(join(prepared.stateRoot, 'auth.json'))).toBe(true);
  expect(readlinkSync(join(prepared.stateRoot, 'auth.json'))).toBe(join(sourceHome, 'auth.json'));
  expect(readFileSync(join(prepared.stateRoot, 'hooks.json'), 'utf8')).toContain(reporter);
  // SessionStart matcher 必须同时覆盖 launch 与 resume 两种 source，否则 resume 不会上报绑定。
  expect(readFileSync(join(prepared.stateRoot, 'hooks.json'), 'utf8')).toContain('startup|resume');
});

test('Utility Codex 使用只读文件系统与本机控制通道 profile', async () => {
  const root = mkdtempSync(join(tmpdir(), 'companion-codex-utility-launch-'));
  roots.push(root);
  const sourceHome = join(root, 'source-codex-home');
  const worktree = join(root, 'worktree');
  mkdirSync(sourceHome, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(sourceHome, 'config.toml'), 'model = "minimax-cn/MiniMax-M3"\n', 'utf8');

  const strategy = createCodexWorkerLaunch({
    launchId: 'utility:attempt-1',
    modelConfiguration: modelConfigurationFixture(),
    credentialStore: unusedCredentialStore,
    sandboxMode: 'read-only-local-control',
    sourceCodexHome: sourceHome,
  });
  const prepared = await strategy.prepare({ worktreePath: worktree });
  const profile = readFileSync(
    join(prepared.stateRoot, `${CODEX_UTILITY_PERMISSION_PROFILE}.config.toml`),
    'utf8',
  );

  expect(descriptorArgs(prepared.stateRoot)).toContain(`--profile ${CODEX_UTILITY_PERMISSION_PROFILE}`);
  // 只读语义由 profile 保证；Landlock 不是只读的退路，启动参数不再带它。
  expect(descriptorArgs(prepared.stateRoot)).not.toContain('use_legacy_landlock');
  expect(descriptorArgs(prepared.stateRoot)).not.toContain('--sandbox read-only');
  expect(profile).toBe(CODEX_UTILITY_PROFILE_CONFIG_TOML);
  expect(profile).toContain('extends = ":read-only"');
  expect(profile).toContain('[permissions.utility-readonly-local-control.network]');
  expect(profile).toContain('enabled = true');
});

test('来源配置的 legacy sandbox 键与只读 profile 混用时启动失败关闭', () => {
  const root = mkdtempSync(join(tmpdir(), 'companion-codex-utility-conflict-'));
  roots.push(root);
  const sourceHome = join(root, 'source-codex-home');
  const worktree = join(root, 'worktree');
  mkdirSync(sourceHome, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(sourceHome, 'config.toml'), 'sandbox_mode = "workspace-write"\n', 'utf8');

  const strategy = createCodexWorkerLaunch({
    launchId: 'utility:attempt-conflict',
    modelConfiguration: modelConfigurationFixture(),
    credentialStore: unusedCredentialStore,
    sandboxMode: 'read-only-local-control',
    sourceCodexHome: sourceHome,
  });

  expect(() => strategy.prepare({ worktreePath: worktree })).toThrow(/legacy sandbox/u);
});

test('只读 Finalizer 的状态根与 reporter 留在 canonical worktree 之外', async () => {
  const root = mkdtempSync(join(tmpdir(), 'companion-codex-finalizer-launch-'));
  roots.push(root);
  const sourceHome = join(root, 'source-codex-home');
  const worktree = join(root, 'worktree');
  const privateState = join(root, 'git-common-dir', 'companion');
  mkdirSync(sourceHome, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(sourceHome, 'config.toml'), 'model = "minimax-cn/MiniMax-M3"\n', 'utf8');
  const reporter = join(privateState, 'session-start.mjs');
  mkdirSync(privateState, { recursive: true });
  writeFileSync(reporter, '', 'utf8');

  const strategy = createCodexWorkerLaunch({
    launchId: 'finalizer:delivery-1',
    modelConfiguration: modelConfigurationFixture(),
    credentialStore: unusedCredentialStore,
    sandboxMode: 'read-only',
    sourceCodexHome: sourceHome,
    sessionStartReporterPath: reporter,
    stateRoot: privateState,
  });
  const prepared = await strategy.prepare({ worktreePath: worktree });

  expect(prepared.stateRoot.startsWith(privateState)).toBe(true);
  expect(descriptorArgs(prepared.stateRoot)).toContain('--sandbox read-only');
  expect(readFileSync(join(prepared.stateRoot, 'hooks.json'), 'utf8')).toContain(reporter);
  expect(readFileSync(join(prepared.stateRoot, 'hooks.json'), 'utf8')).toContain('startup|resume');
  // 只读检查的工作区里不得出现任何 Companion 状态：否则前后工作区比较会把自己的状态当成变化。
  expect(existsSync(join(worktree, '.companion'))).toBe(false);
});

test('状态根必须是绝对路径', () => {
  const strategy = createCodexWorkerLaunch({
    launchId: 'finalizer:delivery-1',
    modelConfiguration: modelConfigurationFixture(),
    credentialStore: unusedCredentialStore,
    sandboxMode: 'read-only',
    stateRoot: './relative-companion',
  });
  expect(() => strategy.prepare({ worktreePath: '/tmp/worktree' })).toThrow(/绝对路径/u);
});

function managedSetup(secret: string): {
  readonly modelConfiguration: WorkerModelConfiguration;
  readonly storePath: string;
  readonly store: JsonCredentialStore;
} {
  const dir = mkdtempSync(join(tmpdir(), 'companion-codex-store-'));
  roots.push(dir);
  const storePath = join(dir, 'credentials.json');
  const store = new JsonCredentialStore({ path: storePath });
  const saved = store.save({ expectedRevision: 0, secret });
  if (saved.kind !== 'saved') throw new Error('credential fixture save failed');
  const base = modelConfigurationFixture();
  return {
    storePath,
    store,
    modelConfiguration: {
      ...base,
      connection: {
        ...base.connection,
        credential: { kind: 'managed', credentialRef: saved.credentialRef, optionPath: 'apiKey' },
      },
      effort: 'medium',
      effortCapability: { values: ['low', 'medium', 'high'], source: 'codex', optionPath: 'effort' },
      modelOptions: { model_verbosity: 'low' },
    },
  };
}

function fakeCodexPath(dir: string): string {
  const fakePath = join(dir, 'fake-codex.mjs');
  writeFileSync(fakePath, [
    '#!' + process.execPath,
    "import { writeFileSync } from 'node:fs';",
    'writeFileSync(process.env.OBSERVATION_FILE, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));',
    '',
  ].join('\n'), 'utf8');
  chmodSync(fakePath, 0o755);
  return fakePath;
}

function runLauncher(stateRoot: string, observationFile: string): void {
  execFileSync(process.execPath, [
    join(stateRoot, 'codex-model-launcher.mjs'),
    join(stateRoot, 'codex-model-launch.json'),
  ], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', OBSERVATION_FILE: observationFile } });
}

function observation(file: string): { readonly argv: string[]; readonly env: Record<string, string> } {
  return JSON.parse(readFileSync(file, 'utf8')) as { argv: string[]; env: Record<string, string> };
}

/** 已批准设置现在存放在非秘密 descriptor 中；命令只有 node/launcher/descriptor。 */
function descriptorArgs(stateRoot: string): string {
  const descriptor = JSON.parse(readFileSync(join(stateRoot, 'codex-model-launch.json'), 'utf8')) as {
    args: string[];
  };
  return descriptor.args.join(' ');
}

test('managed 凭据：子进程真实收到 provider/effort/key，秘密只出现在子进程环境', async () => {
  const root = mkdtempSync(join(tmpdir(), 'companion-codex-managed-'));
  roots.push(root);
  const secret = 'sk-companion-secret-value';
  const { modelConfiguration, storePath, store } = managedSetup(secret);
  const sourceHome = join(root, 'source-codex-home');
  const worktree = join(root, 'worktree');
  const binDir = join(root, 'bin');
  for (const dir of [sourceHome, worktree, binDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(sourceHome, 'config.toml'), 'model = "stale-model"\n', 'utf8');
  writeFileSync(join(sourceHome, 'auth.json'), '{"harness":true}\n', 'utf8');
  const observationFile = join(root, 'observed.json');
  const fakePath = fakeCodexPath(binDir);

  const strategy = createCodexWorkerLaunch({
    launchId: 'planner:attempt-1',
    modelConfiguration,
    credentialStore: store,
    credentialStorePath: storePath,
    codexExecutable: fakePath,
    sandboxMode: 'workspace-write',
    sourceCodexHome: sourceHome,
  });
  const prepared = await strategy.prepare({ worktreePath: worktree });

  expect(prepared.command).not.toContain(secret);
  expect(prepared.command).not.toContain('env CODEX_HOME=');
  expect(existsSync(join(prepared.stateRoot, 'auth.json'))).toBe(false);
  expect(readFileSync(join(prepared.stateRoot, 'codex-model-launch.json'), 'utf8')).not.toContain(secret);
  expect(readFileSync(join(prepared.stateRoot, 'config.toml'), 'utf8')).not.toContain(secret);

  runLauncher(prepared.stateRoot, observationFile);
  const seen = observation(observationFile);
  const argv = seen.argv.join(' ');

  expect(seen.env['CODEX_HOME']).toBe(prepared.stateRoot);
  expect(seen.env[CODEX_MANAGED_CREDENTIAL_ENV]).toBe(secret);
  expect(argv).toContain('model="MiniMax-M3"');
  expect(argv).toContain('model_provider=minimax');
  expect(argv).toContain('model_providers.minimax.wire_api=responses');
  expect(argv).toContain('model_providers.minimax.env_key=' + CODEX_MANAGED_CREDENTIAL_ENV);
  expect(argv).toContain('model_providers.minimax.requires_openai_auth=false');
  expect(argv).toContain('model_reasoning_effort="medium"');
  expect(argv).toContain('model_verbosity="low"');
  expect(seen.argv).not.toContain(secret);
});

test('harness_login 保留原 auth.json 绑定，且不注入凭据环境变量', async () => {
  const root = mkdtempSync(join(tmpdir(), 'companion-codex-harness-'));
  roots.push(root);
  const sourceHome = join(root, 'source-codex-home');
  const worktree = join(root, 'worktree');
  const binDir = join(root, 'bin');
  for (const dir of [sourceHome, worktree, binDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(sourceHome, 'auth.json'), '{"harness":true}\n', 'utf8');
  const observationFile = join(root, 'observed.json');
  const fakePath = fakeCodexPath(binDir);

  const strategy = createCodexWorkerLaunch({
    launchId: 'finalizer:attempt-1',
    modelConfiguration: modelConfigurationFixture(),
    credentialStore: unusedCredentialStore,
    codexExecutable: fakePath,
    sandboxMode: 'read-only',
    sourceCodexHome: sourceHome,
  });
  const prepared = await strategy.prepare({ worktreePath: worktree });

  expect(readlinkSync(join(prepared.stateRoot, 'auth.json'))).toBe(join(sourceHome, 'auth.json'));
  runLauncher(prepared.stateRoot, observationFile);
  const seen = observation(observationFile);
  const argv = seen.argv.join(' ');

  expect(seen.env[CODEX_MANAGED_CREDENTIAL_ENV]).toBeUndefined();
  expect(argv).not.toContain('env_key');
  expect(argv).not.toContain('requires_openai_auth');
  expect(argv).toContain('model="MiniMax-M3"');
});

test('managed 凭据缺失时准备阶段 fail closed，不产出可启动会话', () => {
  const root = mkdtempSync(join(tmpdir(), 'companion-codex-missing-cred-'));
  roots.push(root);
  const sourceHome = join(root, 'source-codex-home');
  const worktree = join(root, 'worktree');
  mkdirSync(sourceHome, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  const storePath = join(root, 'absent-store.json');
  const base = modelConfigurationFixture();
  const modelConfiguration: WorkerModelConfiguration = {
    ...base,
    connection: {
      ...base.connection,
      credential: { kind: 'managed', credentialRef: '22222222-2222-4222-8222-222222222222', optionPath: 'apiKey' },
    },
  };

  const strategy = createCodexWorkerLaunch({
    launchId: 'planner:missing-cred',
    modelConfiguration,
    credentialStore: new JsonCredentialStore({ path: storePath }),
    credentialStorePath: storePath,
    sandboxMode: 'workspace-write',
    sourceCodexHome: sourceHome,
  });

  expect(() => strategy.prepare({ worktreePath: worktree })).toThrow(/凭据/u);
});

test('managed 凭据启动必须由宿主注入 store：未注入时在准备前拒绝，不留下产物', () => {
  const root = mkdtempSync(join(tmpdir(), 'companion-codex-no-store-'));
  roots.push(root);
  const sourceHome = join(root, 'source-codex-home');
  const worktree = join(root, 'worktree');
  mkdirSync(sourceHome, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  const storePath = join(root, 'absent-store.json');
  const base = modelConfigurationFixture();
  const modelConfiguration: WorkerModelConfiguration = {
    ...base,
    connection: {
      ...base.connection,
      credential: { kind: 'managed', credentialRef: '33333333-3333-4333-8333-333333333333', optionPath: 'apiKey' },
    },
  };

  // 模拟绕过类型约束、未注入 store 的调用形态：adapter 不能按路径另建实例，必须 fail closed。
  const strategy = createCodexWorkerLaunch({
    launchId: 'planner:no-store',
    modelConfiguration,
    credentialStore: undefined as unknown as CredentialStore,
    credentialStorePath: storePath,
    sandboxMode: 'workspace-write',
    sourceCodexHome: sourceHome,
  });

  expect(() => strategy.prepare({ worktreePath: worktree })).toThrow(/CredentialStore/u);
  // 未受理，因此不产出可启动的 descriptor。
  expect(existsSync(join(worktree, '.companion', 'codex'))).toBe(false);
});

test('模型配置不能覆写沙箱、审批、profile 或 hook 等宿主保留设置', () => {
  const root = mkdtempSync(join(tmpdir(), 'companion-codex-reserved-'));
  roots.push(root);
  const sourceHome = join(root, 'source-codex-home');
  const worktree = join(root, 'worktree');
  mkdirSync(sourceHome, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  const base = modelConfigurationFixture();

  for (const key of [
    'sandbox_mode',
    'approval_policy',
    'default_permissions',
    'hooks',
    'model_providers.minimax.env_key',
  ]) {
    const modelConfiguration: WorkerModelConfiguration = { ...base, modelOptions: { [key]: 'danger-full-access' } };
    const strategy = createCodexWorkerLaunch({
      launchId: 'planner:reserved-' + key,
      modelConfiguration,
      credentialStore: unusedCredentialStore,
      sandboxMode: 'read-only',
      sourceCodexHome: sourceHome,
    });
    expect(() => strategy.prepare({ worktreePath: worktree })).toThrow(/保留/u);
  }
});

test('嵌套在 modelOptions 里的秘密字段在准备前被拒绝，且不留下任何产物', () => {
  const root = mkdtempSync(join(tmpdir(), 'companion-codex-nested-secret-'));
  roots.push(root);
  const sourceHome = join(root, 'source-codex-home');
  const worktree = join(root, 'worktree');
  mkdirSync(sourceHome, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  const base = modelConfigurationFixture();
  const modelConfiguration: WorkerModelConfiguration = {
    ...base,
    modelOptions: { http_headers: { api_key: 'sk-should-never-reach-argv' } },
  };

  const strategy = createCodexWorkerLaunch({
    launchId: 'planner:nested-secret',
    modelConfiguration,
    credentialStore: unusedCredentialStore,
    sandboxMode: 'workspace-write',
    sourceCodexHome: sourceHome,
  });

  expect(() => strategy.prepare({ worktreePath: worktree })).toThrow(/秘密/u);
  // 拒绝发生在写盘之前：既没有状态根，也没有 descriptor，因此不可能留下可启动的会话。
  expect(existsSync(join(worktree, '.companion', 'codex'))).toBe(false);
  expect(existsSync(join(sourceHome, 'config.toml'))).toBe(false);
});

test('effort 不在能力取值范围内时在准备前被拒绝', () => {
  const root = mkdtempSync(join(tmpdir(), 'companion-codex-bad-effort-'));
  roots.push(root);
  const sourceHome = join(root, 'source-codex-home');
  const worktree = join(root, 'worktree');
  mkdirSync(sourceHome, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  const base = modelConfigurationFixture();
  const modelConfiguration: WorkerModelConfiguration = {
    ...base,
    effort: 'ultra',
    effortCapability: { values: ['low', 'high'], source: 'codex', optionPath: 'effort' },
  };

  const strategy = createCodexWorkerLaunch({
    launchId: 'planner:bad-effort',
    modelConfiguration,
    credentialStore: unusedCredentialStore,
    sandboxMode: 'workspace-write',
    sourceCodexHome: sourceHome,
  });

  expect(() => strategy.prepare({ worktreePath: worktree })).toThrow();
  expect(existsSync(join(worktree, '.companion', 'codex'))).toBe(false);
});

test('无法编码的模型选项在准备前被拒绝，不静默丢弃也不留下产物', () => {
  const root = mkdtempSync(join(tmpdir(), 'companion-codex-bad-option-'));
  roots.push(root);
  const sourceHome = join(root, 'source-codex-home');
  const worktree = join(root, 'worktree');
  mkdirSync(sourceHome, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  const base = modelConfigurationFixture();

  // null 没有确定的 Codex 语义，必须显式拒绝，而不是悄悄不传给 Codex。
  const modelConfiguration: WorkerModelConfiguration = {
    ...base,
    modelOptions: { model_verbosity: null },
  };
  const strategy = createCodexWorkerLaunch({
    launchId: 'planner:bad-option',
    modelConfiguration,
    credentialStore: unusedCredentialStore,
    sandboxMode: 'workspace-write',
    sourceCodexHome: sourceHome,
  });

  expect(() => strategy.prepare({ worktreePath: worktree })).toThrow(/无法编码/u);
  expect(existsSync(join(worktree, '.companion', 'codex'))).toBe(false);
});

test.each([
  ['凭据文件权限过宽', (path: string) => chmodSync(path, 0o644)],
  ['凭据目录权限过宽', (path: string) => chmodSync(join(path, '..'), 0o755)],
] as const)('launcher 在启动子进程前拒绝不可信凭据存储：%s', (_label, weaken) => {
  const root = mkdtempSync(join(tmpdir(), 'companion-codex-store-boundary-'));
  roots.push(root);
  const secret = 'sk-boundary-secret';
  const { modelConfiguration, storePath, store } = managedSetup(secret);
  const sourceHome = join(root, 'source-codex-home');
  const worktree = join(root, 'worktree');
  const binDir = join(root, 'bin');
  mkdirSync(sourceHome, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const fakePath = fakeCodexPath(binDir);
  const strategy = createCodexWorkerLaunch({
    launchId: 'planner:store-boundary',
    modelConfiguration,
    credentialStore: store,
    credentialStorePath: storePath,
    codexExecutable: fakePath,
    sandboxMode: 'workspace-write',
    sourceCodexHome: sourceHome,
  });
  return strategy.prepare({ worktreePath: worktree }).then((result) => {
    const observationFile = join(root, 'observed.json');
    weaken(storePath);
    // launcher 自身 fail closed：非零退出，不启动 codex，错误不回显 secret。
    let stderr = '';
    try {
      execFileSync(process.execPath, [
        join(result.stateRoot, 'codex-model-launcher.mjs'),
        join(result.stateRoot, 'codex-model-launch.json'),
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '', OBSERVATION_FILE: observationFile } });
    } catch (error) {
      stderr = String((error as { stderr?: string }).stderr ?? '');
    }
    expect(stderr).toContain('credential');
    expect(stderr).not.toContain(secret);
    expect(existsSync(observationFile)).toBe(false);
  });
});

/**
 * 用真实 codex 解析我们生成的 `-c` 值。
 *
 * Codex 解析失败时会**静默**把原始字符串当字面量，所以「能启动」证明不了类型正确。这里借 codex
 * 自己的类型报错区分：真 TOML inline table 报 `invalid type: map`，而 JSON 风格的 `{"a":1}`
 * 会退化成 `invalid type: string "..."`。用真实可执行文件判定，不新增任何依赖。
 */
function codexTypeOf(value: string): string {
  try {
    execFileSync('codex', ['-c', 'include_apps_instructions=' + value, 'debug', 'models'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    return 'accepted';
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? '');
    return /invalid type: ([a-z]+)/u.exec(stderr)?.[1] ?? 'unknown';
  }
}

test('inline table 被真实 codex 解析为 map，而不是退回原始字符串', () => {
  const encoded = codexConfigValue({ a: 1, b: { c: 'text' }, d: [1, 2], e: true, f: 'with "quote"' });
  expect(encoded).not.toBeNull();
  // JSON.stringify 会产出 {"a":1,...}，那不是合法 TOML，会被 codex 当成字符串。
  expect(encoded).not.toContain('":');
  expect(codexTypeOf(encoded ?? '')).toBe('map');
  // 反证：JSON 风格确实会被 codex 判成字符串。
  expect(codexTypeOf('{"a":1}')).toBe('string');
});

test('数组与嵌套结构被真实 codex 解析为对应类型', () => {
  expect(codexConfigValue([1, 'two', true])).toBe('[1, "two", true]');
  expect(codexTypeOf(codexConfigValue([{ a: 1 }]) ?? '')).toBe('sequence');
  expect(codexTypeOf(codexConfigValue([1, 2, 3]) ?? '')).toBe('sequence');
});

test('写不成合法 TOML 的值被拒绝，而不是产出静默失效的参数', () => {
  // 嵌套 null 同样不可编码：不再静默丢弃成员。
  expect(codexConfigValue({ a: null })).toBeNull();
  expect(codexConfigValue([1, null])).toBeNull();
  expect(codexConfigValue(Number.NaN)).toBeNull();
  expect(codexConfigValue(() => 1)).toBeNull();
  let deep: unknown = 1;
  for (let index = 0; index < 12; index += 1) deep = { nested: deep };
  expect(codexConfigValue(deep)).toBeNull();
});

test('Codex resume 复用原 CODEX_HOME，argv 以 resume <uuid> 开头', async () => {
  const root = mkdtempSync(join(tmpdir(), 'companion-codex-resume-'));
  roots.push(root);
  const codexHome = join(root, 'original-codex-home');
  const worktree = join(root, 'worktree');
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(codexHome, 'config.toml'), 'model = "x"\n', 'utf8');

  const strategy = createCodexResumeLaunch({
    launchId: 'reconcile:wp-1:round-1',
    modelConfiguration: modelConfigurationFixture(),
    credentialStore: unusedCredentialStore,
    sessionId: '11111111-1111-1111-1111-111111111111',
    codexHome,
    sandboxMode: 'workspace-write',
  });
  const prepared = await strategy.prepare({ worktreePath: worktree });

  expect(prepared.stateRoot).toBe(codexHome);
  const args = descriptorArgs(codexHome);
  expect(args.startsWith('resume 11111111-1111-1111-1111-111111111111')).toBe(true);
  expect(args).toContain('--sandbox workspace-write');
});

test('Codex resume 拒绝形态非法的 session ID，不落到任何启动参数上', () => {
  const root = mkdtempSync(join(tmpdir(), 'companion-codex-resume-bad-'));
  roots.push(root);
  const strategy = createCodexResumeLaunch({
    launchId: 'reconcile:wp-1:round-1',
    modelConfiguration: modelConfigurationFixture(),
    credentialStore: unusedCredentialStore,
    sessionId: 'bad id; rm -rf /',
    codexHome: root,
    sandboxMode: 'workspace-write',
  });
  expect(() => strategy.prepare({ worktreePath: root })).toThrow();
  expect(existsSync(join(root, 'codex-model-launch.json'))).toBe(false);
});
