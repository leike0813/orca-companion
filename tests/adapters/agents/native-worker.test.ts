/**
 * native Worker harness（claude / pi / omp）启动与 Session 证明的行为合同。
 *
 * 只验证稳定可观察的行为：隔离状态根、非秘密启动面、逐 harness 的 pin 参数/环境、精确身份证明与
 * 活动分支读取。不锁定命令文案、日志或不相关的实现细节；不发起真实模型调用。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import {
  createNativeWorkerLaunch,
  inspectNativeTranscript,
  installNativeSessionStartReporter,
  nativeRecoveryInstructions,
  nativeTranscriptIdentity,
  proveNativeTranscript,
} from '../../../src/adapters/agents/native-worker.js';
import type { NativeHarness, NativeWorkerLaunchInput } from '../../../src/adapters/agents/native-worker.js';
import { credentialStoreFixture, modelConfigurationFixture } from '../../support/model-configurations.js';
import type { CredentialStore } from '../../../src/application/ports/credential-store.js';
import type { WorkerModelConfiguration } from '../../../src/domain/model-configuration.js';

const roots: string[] = [];
const MANAGED_REF = '11111111-1111-4111-8111-111111111111';
const MANAGED_SECRET = 'sk-native-secret-value';

/** harness_login 不读凭据，但装配仍要求注入 store。 */
const unusedCredentialStore: CredentialStore = credentialStoreFixture();

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function nativeConfiguration(
  harness: NativeHarness,
  nativeOverrides: Record<string, unknown> = {},
  overrides: Partial<WorkerModelConfiguration> = {},
): WorkerModelConfiguration {
  const base = modelConfigurationFixture();
  return {
    ...base,
    connection: {
      ...base.connection,
      nativeWorker: { harness, providerId: 'minimax', ...nativeOverrides },
    },
    ...overrides,
  };
}

function managedConfiguration(
  harness: NativeHarness,
  nativeOverrides: Record<string, unknown> = {},
  overrides: Partial<WorkerModelConfiguration> = {},
): WorkerModelConfiguration {
  const base = nativeConfiguration(harness, nativeOverrides);
  return {
    ...base,
    connection: {
      ...base.connection,
      credential: { kind: 'managed', credentialRef: MANAGED_REF, optionPath: 'apiKey' },
    },
    ...overrides,
  };
}

/** 自定义 endpoint（自定义 provider）只有 managed 凭据能证明接线。 */
const ENDPOINT = { baseUrl: 'https://example.test/v1', api: 'anthropic-messages' } as const;

function descriptorFor(stateRoot: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(stateRoot, 'codex-model-launch.json'), 'utf8')) as Record<string, unknown>;
}

function launchFor(harness: NativeHarness) {
  return (input: NativeWorkerLaunchInput) => createNativeWorkerLaunch(harness, input);
}

function baseInput(harness: NativeHarness, overrides: Partial<NativeWorkerLaunchInput> = {}): NativeWorkerLaunchInput {
  return {
    launchId: `${harness}:dispatch-1`,
    modelConfiguration: nativeConfiguration(harness),
    credentialStore: unusedCredentialStore,
    sandboxMode: 'workspace-write',
    ...overrides,
  };
}

test('claude 以隔离状态根、opus 别名与真实模型 env 启动', async () => {
  const root = tempDir('companion-native-claude-');
  const worktree = join(root, 'worktree');
  mkdirSync(worktree, { recursive: true });
  const reporter = join(worktree, '.companion', 'claude-reporter.mjs');

  const strategy = launchFor('claude')(baseInput('claude', {
    modelConfiguration: nativeConfiguration('claude', ENDPOINT),
    reporterPath: reporter,
    sandboxMode: 'workspace-write',
  }));
  const prepared = await strategy.prepare({ worktreePath: worktree });
  const descriptor = descriptorFor(prepared.stateRoot);
  const args = descriptor['args'] as string[];
  const environment = descriptor['environment'] as Record<string, string>;

  expect(prepared.title).toMatch(/^orca-companion:claude:/u);
  expect(prepared.stateRoot.startsWith(worktree)).toBe(true);
  expect(args).toContain('--model');
  expect(args[args.indexOf('--model') + 1]).toBe('opus');
  expect(args).toContain('--setting-sources');
  expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
  expect(args).toContain('--permission-mode');
  expect(environment['CLAUDE_CONFIG_DIR']).toBe(prepared.stateRoot);
  expect(environment['ANTHROPIC_DEFAULT_OPUS_MODEL']).toBe('MiniMax-M3');
  expect(environment['ANTHROPIC_BASE_URL']).toBe('https://example.test/v1');
  const trust: unknown = JSON.parse(readFileSync(join(prepared.stateRoot, '.claude.json'), 'utf8'));
  expect(trust).toMatchObject({ hasCompletedOnboarding: true, projects: { [worktree]: { hasTrustDialogAccepted: true } } });
  // --bare 会跳过 SessionStart hook，生产启动不得使用。
  expect(args).not.toContain('--bare');
  const settings = readFileSync(join(prepared.stateRoot, 'native-settings.json'), 'utf8');
  expect(settings).toContain(reporter);
  expect(settings).toContain('startup|resume');
  expect(prepared.command).toContain('codex-model-launcher.mjs');
});

test('claude resume 只按原 UUID 与原状态根恢复', async () => {
  const root = tempDir('companion-native-claude-resume-');
  const worktree = join(root, 'worktree');
  const originalRoot = join(root, 'original-claude-root');
  mkdirSync(worktree, { recursive: true });
  const sessionId = '0f0e0d0c-1b1a-4918-8877-665544332211';
  const transcriptRef = join(originalRoot, 'projects', 'x', `${sessionId}.jsonl`);
  mkdirSync(join(transcriptRef, '..'), { recursive: true });
  writeFileSync(transcriptRef, JSON.stringify({ sessionId, cwd: worktree }) + '\n');

  const strategy = launchFor('claude')(baseInput('claude', {
    resume: { sessionId, stateRoot: originalRoot, transcriptRef },
  }));
  const prepared = await strategy.prepare({ worktreePath: worktree });
  const args = descriptorFor(prepared.stateRoot)['args'] as string[];

  expect(prepared.stateRoot).toBe(originalRoot);
  expect(prepared.title).toMatch(/-resume:/u);
  expect(args[args.indexOf('--resume') + 1]).toBe(sessionId);
});

test('pi managed 固定 provider/model 与确定性 session id，模型配置只落隔离状态根', async () => {
  const root = tempDir('companion-native-pi-');
  const worktree = join(root, 'worktree');
  mkdirSync(worktree, { recursive: true });
  const reporter = join(worktree, '.companion', 'pi-reporter.mjs');
  const input = baseInput('pi', {
    modelConfiguration: managedConfiguration('pi', ENDPOINT),
    credentialStore: credentialStoreFixture({ [MANAGED_REF]: MANAGED_SECRET }),
    reporterPath: reporter,
  });

  const prepared = await launchFor('pi')(input).prepare({ worktreePath: worktree });
  const descriptor = descriptorFor(prepared.stateRoot);
  const args = descriptor['args'] as string[];
  const environment = descriptor['environment'] as Record<string, string>;

  expect(environment['PI_CODING_AGENT_DIR']).toBe(prepared.stateRoot);
  expect(args).toContain('--no-extensions');
  expect(args[args.indexOf('--extension') + 1]).toBe(reporter);
  expect(args).toContain('--session-id');
  expect(args[args.indexOf('--session-id') + 1]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/u);
  expect(args[args.indexOf('--provider') + 1]).toBe('minimax');
  expect(args[args.indexOf('--model') + 1]).toBe('MiniMax-M3');
  expect(args[args.indexOf('--session-dir') + 1]).toBe(join(prepared.stateRoot, 'sessions'));
  const models = JSON.parse(readFileSync(join(prepared.stateRoot, 'models.json'), 'utf8')) as {
    providers: Record<string, { api?: string; baseUrl?: string; models: { id: string }[] }>;
  };
  expect(models.providers['minimax']?.api).toBe('anthropic-messages');
  expect(models.providers['minimax']?.baseUrl).toBe('https://example.test/v1');
  expect(models.providers['minimax']?.models[0]?.id).toBe('MiniMax-M3');
  // 只写环境变量名，secret 由 launcher 运行时注入。
  expect(JSON.stringify(models)).toContain('$COMPANION_NATIVE_MANAGED_KEY');
  expect(JSON.stringify(models)).not.toContain(MANAGED_SECRET);
});

test('pi harness_login 依赖隔离根内复制的登录态，不合成自定义 provider', async () => {
  const root = tempDir('companion-native-pi-login-');
  const worktree = join(root, 'worktree');
  const sourceHome = join(root, 'source-pi');
  mkdirSync(worktree, { recursive: true });
  mkdirSync(sourceHome, { recursive: true });
  writeFileSync(join(sourceHome, 'auth.json'), '{"anthropic":{"access":"x"}}\n', 'utf8');
  writeFileSync(join(sourceHome, 'settings.json'), '{"theme":"dark"}\n', 'utf8');

  const prepared = await launchFor('pi')(baseInput('pi', { sourceHome })).prepare({ worktreePath: worktree });
  const args = descriptorFor(prepared.stateRoot)['args'] as string[];

  // 非秘密设置与登录态被复制进隔离根，隔离根自足且不指向用户全局资产。
  expect(lstatSync(join(prepared.stateRoot, 'auth.json')).isSymbolicLink()).toBe(false);
  expect(readFileSync(join(prepared.stateRoot, 'auth.json'), 'utf8')).toContain('anthropic');
  expect(readFileSync(join(prepared.stateRoot, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}\n');
  // 没有自定义 provider，就没有可合成的 models.json；provider/model 仍由 argv 固定。
  expect(existsSync(join(prepared.stateRoot, 'models.json'))).toBe(false);
  expect(args[args.indexOf('--provider') + 1]).toBe('minimax');
  expect(args[args.indexOf('--model') + 1]).toBe('MiniMax-M3');
});

test('pi resume 用精确 session 文件路径，不用 --continue 或前缀', async () => {
  const root = tempDir('companion-native-pi-resume-');
  const worktree = join(root, 'worktree');
  const originalRoot = join(root, 'original-pi-root');
  mkdirSync(worktree, { recursive: true });
  const transcriptRef = join(originalRoot, 'sessions', '--w--', '2026_session-1.jsonl');
  writePiSession(transcriptRef, 'session-1', worktree, []);

  const prepared = await launchFor('pi')(baseInput('pi', {
    resume: { sessionId: 'session-1', stateRoot: originalRoot, transcriptRef },
  })).prepare({ worktreePath: worktree });
  const args = descriptorFor(prepared.stateRoot)['args'] as string[];

  expect(args[args.indexOf('--session') + 1]).toBe(transcriptRef);
  expect(args).not.toContain('--continue');
  expect(args).not.toContain('--session-id');
});

test('omp 用 provider/exact-id 与 --config，resume 走 -r 精确 fullpath', async () => {
  const root = tempDir('companion-native-omp-');
  const worktree = join(root, 'worktree');
  const originalRoot = join(root, 'original-omp-root');
  mkdirSync(worktree, { recursive: true });
  const transcriptRef = join(originalRoot, 'sessions', '--w--', 'session-1.jsonl');
  writePiSession(transcriptRef, 'session-1', worktree, []);
  const input = baseInput('omp', {
    modelConfiguration: managedConfiguration('omp', ENDPOINT),
    credentialStore: credentialStoreFixture({ [MANAGED_REF]: MANAGED_SECRET }),
    resume: { sessionId: 'session-1', stateRoot: originalRoot, transcriptRef },
  });

  const prepared = await launchFor('omp')(input).prepare({ worktreePath: worktree });
  const descriptor = descriptorFor(prepared.stateRoot);
  const args = descriptor['args'] as string[];
  const environment = descriptor['environment'] as Record<string, string>;

  expect(environment['OMP_CODING_AGENT_DIR']).toBe(prepared.stateRoot);
  expect(environment['HOME']).toBe(join(prepared.stateRoot, 'home'));
  expect(existsSync(environment['HOME']!)).toBe(true);
  expect(args[args.indexOf('--model') + 1]).toBe('minimax/MiniMax-M3');
  expect(args[args.indexOf('--config') + 1]).toBe(join(prepared.stateRoot, 'native-models.json'));
  expect(args[args.indexOf('-r') + 1]).toBe(transcriptRef);
  expect(args).toContain('--auto-approve');
});

test('omp harness_login 与 pi harness_login+自定义 endpoint 在写盘前 fail closed', async () => {
  const worktree = tempDir('companion-native-auth-reject-');

  // omp 的登录态在 agent.db，隔离根内没有可证明的 auth source。
  await expect(launchFor('omp')(baseInput('omp')).prepare({ worktreePath: worktree }))
    .rejects.toThrow(/omp harness_login/u);

  // pi 的自定义 provider 需要显式 key，harness_login 无法证明其接线。
  await expect(launchFor('pi')(baseInput('pi', {
    modelConfiguration: nativeConfiguration('pi', ENDPOINT),
  })).prepare({ worktreePath: worktree })).rejects.toThrow(/harness_login/u);
});

test.each(['claude', 'pi', 'omp'] as const)('%s resume 拒绝不匹配或缺失的原会话且不写启动文件', async (harness) => {
  const root = tempDir('companion-native-resume-identity-');
  const workspace = join(root, 'workspace');
  const stateRoot = join(root, 'state');
  mkdirSync(workspace, { recursive: true });
  const sessionId = '0f0e0d0c-1b1a-4918-8877-665544332211';
  const transcriptRef = join(stateRoot, harness === 'claude' ? 'projects' : 'sessions', `${sessionId}.jsonl`);
  const input = baseInput(harness, {
    modelConfiguration: managedConfiguration(harness, ENDPOINT),
    credentialStore: credentialStoreFixture({ [MANAGED_REF]: MANAGED_SECRET }),
    resume: { sessionId, stateRoot, transcriptRef },
  });
  await expect(launchFor(harness)(input).prepare({ worktreePath: workspace })).rejects.toThrow(/resume/u);
  mkdirSync(join(transcriptRef, '..'), { recursive: true });
  if (harness === 'claude') {
    writeFileSync(transcriptRef, JSON.stringify({ sessionId: 'other-session', cwd: workspace }) + '\n');
  } else {
    writePiSession(transcriptRef, 'other-session', workspace, []);
  }
  await expect(launchFor(harness)(input).prepare({ worktreePath: workspace })).rejects.toThrow(/resume/u);
  expect(existsSync(join(stateRoot, 'codex-model-launch.json'))).toBe(false);
});

test('managed 秘密只进子进程环境，公开面与状态文件不含 secret', async () => {
  const root = tempDir('companion-native-managed-');
  const worktree = join(root, 'worktree');
  mkdirSync(worktree, { recursive: true });
  const store = credentialStoreFixture({ [MANAGED_REF]: MANAGED_SECRET });

  const prepared = await launchFor('claude')(baseInput('claude', {
    modelConfiguration: managedConfiguration('claude'),
    credentialStore: store,
    credentialStorePath: join(root, 'credentials.json'),
  })).prepare({ worktreePath: worktree });
  const descriptor = descriptorFor(prepared.stateRoot);

  expect(store.reads).toContain(MANAGED_REF);
  expect((descriptor['credential'] as Record<string, unknown>)['kind']).toBe('managed');
  expect((descriptor['credential'] as Record<string, unknown>)['envKey']).toBe('ANTHROPIC_AUTH_TOKEN');
  expect(JSON.stringify(descriptor)).not.toContain(MANAGED_SECRET);
  expect(prepared.command).not.toContain(MANAGED_SECRET);
  expect(readFileSync(join(prepared.stateRoot, 'native-settings.json'), 'utf8')).not.toContain(MANAGED_SECRET);
  // managed 时清掉可能抢先的 harness key。
  expect(descriptor['unsetEnvironment']).toContain('ANTHROPIC_API_KEY');
});

test('harness_login 复制登录态与非秘密 settings，但不并入宿主保留项', async () => {
  const root = tempDir('companion-native-auth-');
  const worktree = join(root, 'worktree');
  const sourceHome = join(root, 'source-claude');
  mkdirSync(worktree, { recursive: true });
  mkdirSync(sourceHome, { recursive: true });
  writeFileSync(join(sourceHome, '.credentials.json'), '{"oauth":true}\n', 'utf8');
  writeFileSync(join(sourceHome, 'settings.json'), JSON.stringify({
    statusLine: { type: 'command', command: 'echo hi' },
    permissions: { allow: ['Bash(rm *)'] },
    env: { ANTHROPIC_API_KEY: 'should-not-be-copied' },
  }), 'utf8');

  const prepared = await launchFor('claude')(baseInput('claude', { sourceHome })).prepare({ worktreePath: worktree });
  const target = join(prepared.stateRoot, '.credentials.json');

  expect(existsSync(target)).toBe(true);
  expect(lstatSync(target).isSymbolicLink()).toBe(false);
  expect(readFileSync(target, 'utf8')).toBe(readFileSync(join(sourceHome, '.credentials.json'), 'utf8'));
  // 用户全局资产保持原样。
  expect(lstatSync(join(sourceHome, '.credentials.json')).isSymbolicLink()).toBe(false);
  // D7：非秘密 settings 并入显式 --settings；宿主保留的权限/凭据入口不与秘密一起并入。
  const settings = readFileSync(join(prepared.stateRoot, 'native-settings.json'), 'utf8');
  expect(settings).toContain('statusLine');
  expect(settings).not.toContain('should-not-be-copied');
  expect(settings).not.toContain('Bash(rm *)');
  expect(JSON.parse(settings)).toMatchObject({ permissions: { allow: [
    'Bash(orca orchestration check *)', 'Bash(orca orchestration send *)', 'Bash(orca orchestration worker-done *)',
    'Bash(orca orchestration worker-ask *)', 'Bash(orca orchestration worker-escalate *)',
  ] } });
});

test('native 模型配置的 harness 不匹配或触碰保留选项时拒绝启动', async () => {
  const worktree = tempDir('companion-native-reject-');
  const mismatched = nativeConfiguration('pi');

  await expect(launchFor('claude')(baseInput('claude', { modelConfiguration: mismatched }))
    .prepare({ worktreePath: worktree })).rejects.toThrow(/harness/u);

  for (const option of ['thinking', 'id', 'model_id']) {
    const reserved = nativeConfiguration('pi', {}, { modelOptions: { [option]: 'override' } });
    await expect(launchFor('pi')(baseInput('pi', { modelConfiguration: reserved }))
      .prepare({ worktreePath: worktree })).rejects.toThrow(/保留/u);
  }
});

test('状态根必须是绝对路径', async () => {
  const strategy = launchFor('pi')(baseInput('pi', { stateRoot: './relative' }));
  await expect(strategy.prepare({ worktreePath: '/tmp/native-worktree' })).rejects.toThrow(/绝对路径/u);
});

test('只读模式写出 readOnly 描述符，并在写盘前证明包装器可用', async () => {
  const root = tempDir('companion-native-readonly-');
  const worktree = join(root, 'worktree');
  const privateState = join(root, 'git-common', 'companion');
  mkdirSync(worktree, { recursive: true });
  mkdirSync(privateState, { recursive: true });
  let probed = 0;

  const prepared = await launchFor('pi')(baseInput('pi', {
    sandboxMode: 'read-only',
    stateRoot: privateState,
    assertReadOnlyWrapperAvailable: () => {
      probed += 1;
      return Promise.resolve();
    },
  })).prepare({ worktreePath: worktree });

  expect(probed).toBe(1);
  expect(descriptorFor(prepared.stateRoot)['readOnly']).toEqual({ workspace: worktree, stateRoot: prepared.stateRoot });
  // 只读包装器把 /tmp 设为只读：临时目录必须落在可写的状态根内。
  expect(existsSync(join(prepared.stateRoot, 'tmp'))).toBe(true);
  expect((descriptorFor(prepared.stateRoot)['environment'] as Record<string, string>)['TMPDIR'])
    .toBe(join(prepared.stateRoot, 'tmp'));
  // 只读角色不在被检查的 canonical 工作区留下状态。
  expect(existsSync(join(worktree, '.companion'))).toBe(false);
});

test('只读包装器不可用时在任何写盘之前 fail closed', async () => {
  const root = tempDir('companion-native-readonly-fail-');
  const worktree = join(root, 'worktree');
  mkdirSync(worktree, { recursive: true });

  const strategy = launchFor('omp')(baseInput('omp', {
    modelConfiguration: managedConfiguration('omp', ENDPOINT),
    credentialStore: credentialStoreFixture({ [MANAGED_REF]: MANAGED_SECRET }),
    sandboxMode: 'read-only-local-control',
    stateRoot: join(root, 'state'),
    assertReadOnlyWrapperAvailable: () => Promise.reject(new Error('bwrap 不可用')),
  }));

  await expect(strategy.prepare({ worktreePath: worktree })).rejects.toThrow(/bwrap/u);
  expect(existsSync(join(root, 'state'))).toBe(false);
});

/** 生成一个 pi/omp 形状的会话文件（首行 session header + 活动分支）。 */
function writePiSession(path: string, id: string, cwd: string, entries: readonly { id: string; parentId: string | null }[]): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const lines = [JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-10-06T00:00:00.000Z', cwd })];
  for (const entry of entries) {
    lines.push(JSON.stringify({ type: 'message', id: entry.id, parentId: entry.parentId, timestamp: '2026-10-06T00:00:01.000Z', message: { role: 'user', content: entry.id } }));
  }
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
}

/** extension 在上报时写出的精确 sidecar（仅 metadata）。 */
function writeLeafSidecar(transcriptPath: string, sessionId: string, leafId: string): void {
  writeFileSync(`${transcriptPath}.companion-leaf.json`, JSON.stringify({ harness: 'pi', sessionId, leafId }), 'utf8');
}

function removeLeafSidecar(transcriptPath: string): void {
  rmSync(`${transcriptPath}.companion-leaf.json`, { force: true });
}

test('pi transcript 证明要求 id、精确 path、状态根与绑定窗口全部一致', () => {
  const root = tempDir('companion-native-proof-pi-');
  const workspace = join(root, 'worktree');
  const stateRoot = join(root, 'state');
  mkdirSync(workspace, { recursive: true });
  const sessionId = '4e2a1c8b-0000-4000-8000-abcdefabcdef';
  const transcript = join(stateRoot, 'sessions', '--worktree--', `2026_${sessionId}.jsonl`);
  writePiSession(transcript, sessionId, workspace, [{ id: 'a', parentId: null }]);

  const report = {
    harness: 'pi',
    sessionId,
    transcriptPath: transcript,
    codexHome: stateRoot,
    cwd: workspace,
    observedAt: '2026-10-06T00:00:30.000Z',
  };
  const window = { dispatchStartedAt: '2026-10-06T00:00:00.000Z', bindingDeadlineAt: '2026-10-06T00:01:00.000Z' };

  expect(proveNativeTranscript('pi', { report, workspace, expectedCodexHome: stateRoot, ...window })).toMatchObject({
    kind: 'proven',
    proof: { providerSessionId: sessionId },
  });

  // cwd 不一致 => 不可用。
  expect(proveNativeTranscript('pi', { report: { ...report, cwd: root }, workspace, expectedCodexHome: stateRoot, ...window })).toMatchObject(
    { kind: 'transcript_unavailable' },
  );
  // 观察早于 Dispatch 窗口 => 不可用。
  expect(proveNativeTranscript('pi', { report: { ...report, observedAt: '2026-10-05T23:59:00.000Z' }, workspace, expectedCodexHome: stateRoot, ...window })).toMatchObject(
    { kind: 'transcript_unavailable' },
  );
  // 首 transcript 延迟（文件尚未出现）=> 不可用，不猜测。
  expect(proveNativeTranscript('pi', {
    report: { ...report, transcriptPath: join(stateRoot, 'sessions', 'missing.jsonl') },
    workspace,
    expectedCodexHome: stateRoot,
    ...window,
  })).toMatchObject({ kind: 'transcript_unavailable' });
  // 会话头 id 与上报不一致 => 不可用。
  const otherId = '5f3b2d9c-0000-4000-8000-abcdefabcdef';
  const otherFile = join(stateRoot, 'sessions', '--other--', `2026_${sessionId}.jsonl`);
  writePiSession(otherFile, otherId, workspace, []);
  expect(proveNativeTranscript('pi', {
    report: { ...report, transcriptPath: otherFile },
    workspace,
    expectedCodexHome: stateRoot,
    ...window,
  })).toMatchObject({ kind: 'transcript_unavailable' });
  // 报告自称其它 harness => 拒绝，不因为 adapter 固定就信任来源。
  expect(proveNativeTranscript('pi', {
    report: { ...report, harness: 'claude' },
    workspace,
    expectedCodexHome: stateRoot,
    ...window,
  })).toMatchObject({ kind: 'transcript_unavailable' });
});

test('claude transcript 证明以文件内 sessionId/cwd 与精确 path 为准', () => {
  const root = tempDir('companion-native-proof-claude-');
  const workspace = join(root, 'worktree');
  const stateRoot = join(root, 'state');
  mkdirSync(workspace, { recursive: true });
  const sessionId = '6a4c3e0d-1111-4222-8333-abcdefabcdef';
  const transcript = join(stateRoot, 'projects', '--worktree--', `${sessionId}.jsonl`);
  mkdirSync(join(transcript, '..'), { recursive: true });
  // 真实 claude transcript 首行常是 file-history 快照，既没有 sessionId 也没有 cwd：
  // 身份证明必须继续有界扫描，而不是断言第一行。
  writeFileSync(transcript, [
    JSON.stringify({ type: 'file-history-snapshot', messageId: 'm0' }),
    JSON.stringify({ type: 'user', sessionId, cwd: workspace, uuid: 'u1' }),
    '',
  ].join('\n'), 'utf8');

  const report = { harness: 'claude', sessionId, transcriptPath: transcript, codexHome: stateRoot, cwd: workspace, observedAt: '2026-10-06T00:00:30.000Z' };
  const window = { dispatchStartedAt: '2026-10-06T00:00:00.000Z', bindingDeadlineAt: '2026-10-06T00:01:00.000Z' };

  expect(proveNativeTranscript('claude', { report, workspace, expectedCodexHome: stateRoot, ...window })).toMatchObject({ kind: 'proven' });
  expect(nativeTranscriptIdentity('claude', { transcriptRef: transcript, workspace })).toEqual({ providerSessionId: sessionId });
  expect(nativeTranscriptIdentity('claude', { transcriptRef: transcript, workspace: root })).toMatchObject({ kind: 'transcript_unavailable' });
});

test('逐 harness 的 recovery 读取配方区分分支树与线性文件', () => {
  const pi = nativeRecoveryInstructions('pi').join('\n');
  expect(pi).toContain('parentId');
  expect(pi).toContain('toEventRef');
  expect(pi).toContain('gaps');
  const omp = nativeRecoveryInstructions('omp').join('\n');
  expect(omp).toContain('parentId');
  const claude = nativeRecoveryInstructions('claude').join('\n');
  expect(claude).toContain('uuid');
  expect(claude).toContain('gaps');
  // 通用 Codex 配方（timestamp/ordinal 遍历全部行）不能用于 native。
  expect(pi).not.toContain('timestamp');
  expect(claude).not.toContain('ordinal');
});

test('pi/omp transcript 只按活动分支读取，不混入其它分支', async () => {
  const root = tempDir('companion-native-branch-');
  const workspace = join(root, 'worktree');
  mkdirSync(workspace, { recursive: true });
  const transcript = join(root, 'session.jsonl');
  writePiSession(transcript, 'session-1', workspace, [
    { id: 'a', parentId: null },
    { id: 'b', parentId: 'a' },
    { id: 'c', parentId: 'a' },
    { id: 'd', parentId: 'c' },
  ]);

  // 关键回归：文件最后一行（d）不是活动叶子。extension 的 sidecar 指向 b，
  // 因此只能读 a..b；绝不能按最后一行把历史分支 d 当成活动分支。
  writeLeafSidecar(transcript, 'session-1', 'b');
  expect(await inspectNativeTranscript('pi', transcript)).toMatchObject({
    kind: 'covered',
    evidence: { coverage: 'complete', readableRange: { fromEventRef: 'a', toEventRef: 'b' }, gaps: [] },
  });

  // 显式 leafId 覆盖 sidecar。
  expect(await inspectNativeTranscript('pi', transcript, 'd')).toMatchObject({
    kind: 'covered',
    evidence: { coverage: 'complete', readableRange: { fromEventRef: 'a', toEventRef: 'd' } },
  });
  // sidecar 与文件内会话头 id 不符 => 不可用，不按 mtime 或最后一行猜。
  writeLeafSidecar(transcript, 'other-session', 'b');
  expect(await inspectNativeTranscript('pi', transcript)).toMatchObject({ kind: 'transcript_unavailable' });
  // 既无显式 leafId 也无 sidecar => 不可用（不得退回文件最后一行）。
  removeLeafSidecar(transcript);
  expect(await inspectNativeTranscript('pi', transcript)).toMatchObject({ kind: 'transcript_unavailable' });
  // 叶子在文件里不存在 => 不可用。
  expect(await inspectNativeTranscript('pi', transcript, 'zzz')).toMatchObject({ kind: 'transcript_unavailable' });

  // 父链断裂或成环都不是「少一点历史」，而是身份不可证明。
  writePiSession(transcript, 'session-1', workspace, [
    { id: 'a', parentId: null },
    { id: 'b', parentId: 'missing' },
  ]);
  writeLeafSidecar(transcript, 'session-1', 'b');
  expect(await inspectNativeTranscript('pi', transcript)).toMatchObject({ kind: 'transcript_unavailable' });
  writePiSession(transcript, 'session-1', workspace, [
    { id: 'a', parentId: 'c' },
    { id: 'c', parentId: 'a' },
  ]);
  writeLeafSidecar(transcript, 'session-1', 'a');
  expect(await inspectNativeTranscript('pi', transcript)).toMatchObject({ kind: 'transcript_unavailable' });

  // 截断行 => partial，范围仍是活动分支，且不把正文复制进证据。
  writePiSession(transcript, 'session-1', workspace, [
    { id: 'a', parentId: null },
    { id: 'b', parentId: 'a' },
  ]);
  writeLeafSidecar(transcript, 'session-1', 'b');
  writeFileSync(transcript, `${readFileSync(transcript, 'utf8')}{"type":"message"`, 'utf8');
  expect(await inspectNativeTranscript('pi', transcript)).toMatchObject({
    kind: 'covered',
    evidence: {
      coverage: 'partial',
      readableRange: { fromEventRef: 'a', toEventRef: 'b' },
      gaps: [{ fromEventRef: 'line:4', toEventRef: null, reason: 'invalid_json' }],
    },
  });

  // 缺口后的可解析事件不能被报成连续历史的末端。
  writeFileSync(transcript, `${readFileSync(transcript, 'utf8')}\n${JSON.stringify({ id: 'c', parentId: 'b' })}\n`);
  writeLeafSidecar(transcript, 'session-1', 'c');
  expect(await inspectNativeTranscript('pi', transcript)).toMatchObject({ kind: 'transcript_unavailable' });
});

test('OMP 文件标题槽不造成转录缺口，未知无身份条目仍按缺口处理', async () => {
  const root = tempDir('companion-omp-title-');
  const transcript = join(root, 'session.jsonl');
  writePiSession(transcript, 'session-1', root, [{ id: 'a', parentId: null }]);
  writeLeafSidecar(transcript, 'session-1', 'a');
  const body = readFileSync(transcript, 'utf8');
  writeFileSync(transcript, JSON.stringify({ type: 'title', v: 1, title: '', updatedAt: '', pad: '' }) + '\n' + body);
  expect(await inspectNativeTranscript('omp', transcript)).toMatchObject({ kind: 'covered', evidence: { coverage: 'complete' } });
  writeFileSync(transcript, JSON.stringify({ type: 'unknown' }) + '\n' + body);
  expect(await inspectNativeTranscript('omp', transcript)).toMatchObject({ kind: 'covered', evidence: { coverage: 'partial' } });
});

test('reporter 可执行并写出完整的一行身份报告', () => {
  const root = tempDir('companion-native-reporter-');
  const reporterPath = join(root, 'claude-reporter.mjs');
  const reportPath = join(root, 'report.jsonl');
  installNativeSessionStartReporter('claude', { stateRoot: root, reporterPath, reportPath });
  const event = { session_id: 'session-1', transcript_path: '/tmp/session-1.jsonl', cwd: '/tmp/worktree' };
  const stdout = execFileSync(process.execPath, [reporterPath], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: '/tmp/claude-root' },
  });

  expect(JSON.parse(stdout)).toEqual({});
  expect(JSON.parse(readFileSync(reportPath, 'utf8').trim())).toMatchObject({
    sessionId: 'session-1',
    transcriptPath: '/tmp/session-1.jsonl',
    codexHome: '/tmp/claude-root',
    cwd: '/tmp/worktree',
  });
});

test('pi/omp reporter 在回合结束与切换分支后更新精确活动叶子', () => {
  const root = tempDir('companion-native-extension-');
  for (const harness of ['pi', 'omp'] as const) {
    const reporterPath = join(root, `${harness}-reporter.mjs`);
    const reportPath = join(root, `${harness}.jsonl`);
    installNativeSessionStartReporter(harness, { stateRoot: root, reporterPath, reportPath });
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { existsSync, readFileSync, writeFileSync } from 'node:fs';
      import { pathToFileURL } from 'node:url';
      const { default: install } = await import(pathToFileURL(${JSON.stringify(reporterPath)}));
      const handlers = new Map();
      install({ on: (name, handler) => handlers.set(name, handler) });
      let leaf = 'a';
      const transcriptPath = ${JSON.stringify(join(root, `${harness}-session.jsonl`))};
      const ctx = { sessionManager: {
        getHeader: () => ({ cwd: ${JSON.stringify(root)} }),
        getSessionId: () => 'session-1', getSessionFile: () => transcriptPath, getLeafId: () => leaf,
      } };
      handlers.get('session_start')({}, ctx);
      if (existsSync(${JSON.stringify(reportPath)})) throw new Error('premature session report');
      writeFileSync(transcriptPath, JSON.stringify({ type: 'session', id: 'session-1' }) + '\\n');
      await new Promise((resolve) => setTimeout(resolve, 300));
      leaf = 'b';
      handlers.get('turn_end')({}, ctx);
      leaf = 'a';
      handlers.get('session_tree')({}, ctx);
      process.stdout.write(readFileSync(transcriptPath + '.companion-leaf.json', 'utf8'));
    `], { encoding: 'utf8' });
    expect(JSON.parse(output)).toMatchObject({ harness, sessionId: 'session-1', leafId: 'a' });
    expect(readFileSync(reportPath, 'utf8').trim().split('\n')).toHaveLength(3);
  }
});
