import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import {
  OPENCODE_MANAGED_CREDENTIAL_ENV,
  OPENCODE_SESSION_REPORT_FILENAME,
  createOpencodeResumeLaunch,
  createOpencodeWorkerLaunch,
  inspectOpencodeTranscript,
  observeOpencodeSession,
  opencodeHarness,
  opencodeLaunchDigest,
  opencodeRecoveryInstructions,
  opencodeRecoveryMaterialPath,
  opencodeSessionIdFor,
  proveOpencodeTranscript,
  prepareOpencodeRecoveryMaterial,
  readOpencodeTranscriptIdentity,
  sessionPathsUnder,
  type OpencodeExecutionInput,
} from '../../../src/adapters/agents/opencode-harness.js';
import { CODEX_MODEL_DESCRIPTOR_FILENAME } from '../../../src/adapters/agents/codex-model-launcher.js';
import { credentialStoreFixture } from '../../support/model-configurations.js';
import type { WorkerModelConfiguration } from '../../../src/domain/model-configuration.js';
import type { TranscriptCoverageEvidence } from '../../../src/application/recovery/recovery-capsule.js';
import { readLatestHarnessSessionReport, resumeSessionPathsUnder } from '../../../src/bootstrap/worker-harness.js';

const roots: string[] = [];
const originalPath = process.env['PATH'];
beforeEach(() => { writeFakeOpencode({}); });

afterEach(() => {
  process.env['PATH'] = originalPath;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const OPENCODE_PROVIDER = 'minimax-cn-coding-plan';
const OPENCODE_MODEL = 'MiniMax-M3.1-Flash-Preview';

function opencodeModelConfiguration(overrides: Partial<WorkerModelConfiguration> = {}): WorkerModelConfiguration {
  return {
    connection: {
      connectionRef: 'connection-open',
      label: '测试连接',
      providerIntegration: 'minimax',
      modelOptions: {},
      credential: { kind: 'harness_login' },
      codex: null,
      nativeWorker: { harness: 'opencode', providerId: OPENCODE_PROVIDER },
    },
    modelRef: 'model-open',
    model: OPENCODE_MODEL,
    effort: null,
    effortCapability: null,
    modelOptions: {},
    ...overrides,
  };
}

function managedModelConfiguration(credentialRef: string): WorkerModelConfiguration {
  const base = opencodeModelConfiguration();
  return opencodeModelConfiguration({
    connection: {
      ...base.connection,
      credential: { kind: 'managed', credentialRef, optionPath: 'connection.credential' },
      nativeWorker: { harness: 'opencode', providerId: OPENCODE_PROVIDER },
    },
  });
}

function launchInput(overrides: Partial<OpencodeExecutionInput> = {}): OpencodeExecutionInput {
  return {
    launchId: 'launch-1',
    modelConfiguration: opencodeModelConfiguration(),
    credentialStore: credentialStoreFixture({}),
    sandboxMode: 'workspace-write',
    // 默认指向空的来源数据目录：harness_login 用例不读用户真实 opencode 登录态。
    sourceDataHome: tempRoot('companion-oc-source-'),
    ...overrides,
  };
}

function worktreeUnder(root: string): string {
  const worktree = join(root, 'worktree');
  mkdirSync(worktree, { recursive: true });
  return worktree;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

type Descriptor = {
  readonly args: readonly string[];
  readonly environment: Record<string, string>;
  readonly unsetEnvironment: readonly string[];
  readonly credential: Record<string, unknown>;
  readonly readOnly?: { readonly stateRoot: string; readonly workspace: string; readonly reportDirectory?: string };
};

function readDescriptor(stateRoot: string): Descriptor {
  return readJson(join(stateRoot, CODEX_MODEL_DESCRIPTOR_FILENAME)) as unknown as Descriptor;
}

function reportLines(stateRoot: string): readonly Record<string, unknown>[] {
  return readFileSync(join(stateRoot, OPENCODE_SESSION_REPORT_FILENAME), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** fake opencode：只服务公开 CLI 的 api 子命令，行为由同目录 fixture.json 驱动。 */
function writeFakeOpencode(fixture: unknown): string {
  const dir = tempRoot('companion-oc-fake-');
  writeFileSync(join(dir, 'fixture.json'), JSON.stringify(fixture), 'utf8');
  const executable = join(dir, 'opencode');
  writeFileSync(executable, [
    '#!/usr/bin/env node',
    "import { readFileSync } from 'node:fs';",
    "import { dirname, join } from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    "const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixture.json'), 'utf8'));",
    'const args = process.argv.slice(2);',
    "if (args[0] !== 'api') process.exit(0);",
    'const operation = args[2];',
    'if (operation === "POST" && args[3] === "/api/session") {',
    '  const payload = JSON.parse(args[args.indexOf("--data") + 1]);',
    '  process.stdout.write(JSON.stringify({ data: { ...payload, location: payload.location } }) + "\\n"); process.exit(0);',
    '}',
    'const params = {};',
    'const url = operation === "GET" ? new URL(args[3], "http://localhost") : null;',
    'if (url) for (const [key, value] of url.searchParams) params[key] = value;',
    'for (let index = 3; index < args.length; index += 1) {',
    "  if (args[index] !== '--param') continue;",
    "  const raw = String(args[index + 1] ?? '');",
    "  const split = raw.indexOf('=');",
    "  const key = split < 0 ? raw : raw.slice(0, split);",
    "  params[key] = split < 0 ? '' : raw.slice(split + 1);",
    '  index += 1;',
    '}',
    'function emit(value) { process.stdout.write(JSON.stringify(value) + "\\n"); process.exit(0); }',
    'function fail(tag) { process.stderr.write("HTTP 500 ServerError\\n"); process.stdout.write(JSON.stringify({ _tag: tag }) + "\\n"); process.exit(1); }',
    "if (operation === 'session.list') {",
    '  if (fixture.failList) fail("ServerError");',
    '  emit(fixture.listPages?.[params.cursor ?? ""] ?? fixture.list ?? { data: fixture.sessions ?? [], cursor: { previous: null, next: null } });',
    '}',
    "if (url?.pathname.endsWith('/message')) {",
    '  if (fixture.failMessages) fail("ServerError");',
    '  const page = (fixture.messagePages ?? {})[params.cursor ?? ""];',
    '  if (page === undefined) fail("SessionNotFoundError");',
    '  emit(page);',
    '}',
    'emit({});',
    '',
  ].join('\n'), 'utf8');
  chmodSync(executable, 0o755);
  process.env['PATH'] = dir + ':' + (originalPath ?? '');
  return executable;
}

function sessionFixture(sessionId: string, cwd: string): unknown {
  return { sessions: [{ id: sessionId, location: { directory: cwd } }] };
}

test('sessionPaths 返回 harness 级父根与带 digest 的报告路径', () => {
  const digest = opencodeLaunchDigest('launch-1');
  expect(digest).toMatch(/^[0-9a-f]{20}$/u);
  const paths = sessionPathsUnder('/companion', 'launch-1');
  expect(paths.stateRoot).toBe(join('/companion', 'opencode'));
  expect(paths.reportPath).toBe(join('/companion', 'opencode', digest, OPENCODE_SESSION_REPORT_FILENAME));
  expect(paths.reporterPath).toBe(paths.reportPath);
  expect(opencodeSessionIdFor('launch-1')).toBe('ses_' + digest);
  expect(opencodeHarness.sessionPaths('/companion', 'launch-1')).toEqual(paths);
  expect(opencodeHarness.id).toBe('opencode');
  expect(typeof opencodeHarness.prepareReadOnlyLaunch).toBe('function');
  expect(typeof opencodeHarness.probe).toBe('function');
});

test('managed 凭据不可用时在写盘前拒绝', async () => {
  const root = tempRoot('companion-oc-managed-');
  const worktree = worktreeUnder(root);
  const stateRootParent = join(root, 'state');
  const strategy = createOpencodeWorkerLaunch(launchInput({
    stateRoot: stateRootParent,
    modelConfiguration: managedModelConfiguration(randomUUID()),
    credentialStore: credentialStoreFixture({}),
  }));
  await expect(strategy.prepare({ worktreePath: worktree })).rejects.toThrow(/凭据/u);
  expect(existsSync(join(stateRootParent, 'opencode'))).toBe(false);
});

test('nativeWorker harness 不匹配或含秘密选项时拒绝', async () => {
  const root = tempRoot('companion-oc-guard-');
  const worktree = worktreeUnder(root);
  const base = opencodeModelConfiguration();
  const wrongHarness = opencodeModelConfiguration({
    connection: { ...base.connection, nativeWorker: { harness: 'pi', providerId: 'x' } },
  });
  await expect(createOpencodeWorkerLaunch(launchInput({ modelConfiguration: wrongHarness }))
    .prepare({ worktreePath: worktree })).rejects.toThrow(/nativeWorker/u);
  const secretOptions = opencodeModelConfiguration({ modelOptions: { apiKey: 'sk-live-not-a-real-key' } });
  await expect(createOpencodeWorkerLaunch(launchInput({ modelConfiguration: secretOptions }))
    .prepare({ worktreePath: worktree })).rejects.toThrow(/秘密/u);
});

test('新建启动写隔离 XDG、JSONL bootstrap 与非秘密 descriptor', async () => {
  const root = tempRoot('companion-oc-launch-');
  const worktree = worktreeUnder(root);
  const stateRootParent = join(root, 'state');
  // 运行时把 sessionPaths().stateRoot 当父目录交给 adapter，adapter 统一在其下拼 digest。
  const paths = sessionPathsUnder(stateRootParent, 'launch-1');
  const strategy = createOpencodeWorkerLaunch(launchInput({ stateRoot: paths.stateRoot }));
  const prepared = await strategy.prepare({ worktreePath: worktree });

  const digest = opencodeLaunchDigest('launch-1');
  const actual = join(paths.stateRoot, digest);
  expect(prepared.stateRoot).toBe(actual);
  expect(prepared.title).toBe(strategy.title);
  expect(prepared.title).not.toContain('ses_');

  const config = readJson(join(actual, 'opencode-config.json'));
  const provider = (config['providers'] as Record<string, Record<string, unknown> | undefined>)[OPENCODE_PROVIDER];
  expect(provider?.['models']).toEqual({ [OPENCODE_MODEL]: { settings: {} } });
  // 根命令不接受 --model：模型必须经隔离 config 的顶层 model 钉住。
  expect(config['model']).toBe(OPENCODE_PROVIDER + '/' + OPENCODE_MODEL);

  const descriptor = readDescriptor(actual);
  expect(descriptor.args).toEqual([
    'mini', '--standalone', '--model', OPENCODE_PROVIDER + '/' + OPENCODE_MODEL, '--session', 'ses_' + digest,
  ]);
  expect(descriptor.environment['XDG_DATA_HOME']).toBe(join(actual, 'xdg', 'data'));
  expect(descriptor.environment['OPENCODE_CONFIG']).toBe(join(actual, 'opencode-config.json'));
  expect(descriptor.unsetEnvironment).toContain('OPENCODE_CONFIG_CONTENT');
  expect(descriptor.credential).toEqual({ kind: 'harness_login' });
  expect(descriptor.readOnly).toBeUndefined();

  const lines = reportLines(actual);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatchObject({ harness: 'opencode', sessionId: 'ses_' + digest, observedAt: null, cwd: worktree });
});

test('managed 只把变量名写进 config/descriptor，secret 不进公开面', async () => {
  const root = tempRoot('companion-oc-managed2-');
  const worktree = worktreeUnder(root);
  const stateRootParent = join(root, 'state');
  const credentialRef = randomUUID();
  const strategy = createOpencodeWorkerLaunch(launchInput({
    stateRoot: stateRootParent,
    modelConfiguration: managedModelConfiguration(credentialRef),
    credentialStore: credentialStoreFixture({ [credentialRef]: 'sk-secret-value' }),
  }));
  const prepared = await strategy.prepare({ worktreePath: worktree });

  const descriptor = readDescriptor(prepared.stateRoot);
  expect(descriptor.credential['kind']).toBe('managed');
  expect(descriptor.credential['credentialRef']).toBe(credentialRef);
  expect(descriptor.credential['envKey']).toBe(OPENCODE_MANAGED_CREDENTIAL_ENV);
  expect(typeof descriptor.credential['storePath']).toBe('string');
  expect(JSON.stringify(descriptor)).not.toContain('sk-secret-value');
  const config = readFileSync(join(prepared.stateRoot, 'opencode-config.json'), 'utf8');
  expect(config).not.toContain('sk-secret-value');
  expect(readJson(join(prepared.stateRoot, 'opencode-config.json'))['providers']).toMatchObject({
    [OPENCODE_PROVIDER]: { env: [OPENCODE_MANAGED_CREDENTIAL_ENV] },
  });
  expect(readJson(join(prepared.stateRoot, 'opencode-config.json'))['experimental']).toEqual({
    policies: [
      { action: 'provider.use', resource: '*', effect: 'deny' },
      { action: 'provider.use', resource: OPENCODE_PROVIDER, effect: 'allow' },
    ],
  });
});

test('harness_login 复制来源登录文件而不修改来源', async () => {
  const root = tempRoot('companion-oc-login-');
  const worktree = worktreeUnder(root);
  const sourceDataHome = join(root, 'source-data');
  mkdirSync(join(sourceDataHome, 'opencode'), { recursive: true });
  const sourceAuth = join(sourceDataHome, 'opencode', 'auth.json');
  writeFileSync(sourceAuth, '{"integration":"minimax"}', 'utf8');
  writeFileSync(join(sourceDataHome, 'opencode', 'account.json'), '{"accounts":[]}', 'utf8');

  const strategy = createOpencodeWorkerLaunch(launchInput({ stateRoot: join(root, 'state'), sourceDataHome }));
  const prepared = await strategy.prepare({ worktreePath: worktree });
  expect(readFileSync(join(prepared.stateRoot, 'xdg', 'data', 'opencode', 'auth.json'), 'utf8'))
    .toBe('{"integration":"minimax"}');
  expect(existsSync(join(prepared.stateRoot, 'xdg', 'data', 'opencode', 'account.json'))).toBe(true);
  expect(readFileSync(sourceAuth, 'utf8')).toBe('{"integration":"minimax"}');
});

test('resume 复用原状态根与原 session id', async () => {
  const root = tempRoot('companion-oc-resume-');
  const worktree = worktreeUnder(root);
  const stateRootParent = join(root, 'state');
  const first = await createOpencodeWorkerLaunch(launchInput({ stateRoot: stateRootParent }))
    .prepare({ worktreePath: worktree });
  const originalSessionId = opencodeSessionIdFor('launch-1');
  const transcriptRef = join(first.stateRoot, OPENCODE_SESSION_REPORT_FILENAME);
  const report = readLatestHarnessSessionReport(transcriptRef)!;
  writeFileSync(transcriptRef, JSON.stringify({ ...report, observedAt: '2020-01-01T00:00:00Z' }) + '\n');
  writeFakeOpencode(sessionFixture(originalSessionId, worktree));
  const dispatchStartedAt = new Date().toISOString();
  const paths = resumeSessionPathsUnder('opencode', stateRootParent, 'resume-1', first.stateRoot);
  const resumed = await createOpencodeResumeLaunch({
    ...launchInput({ stateRoot: stateRootParent }),
    sessionId: originalSessionId,
    originalStateRoot: first.stateRoot,
    transcriptRef: join(first.stateRoot, OPENCODE_SESSION_REPORT_FILENAME),
  }).prepare({ worktreePath: worktree });

  expect(resumed.stateRoot).toBe(first.stateRoot);
  const descriptor = readDescriptor(resumed.stateRoot);
  expect(descriptor.args).toContain(originalSessionId);
  expect(descriptor.args).not.toContain(opencodeSessionIdFor('unrelated-launch'));
  expect(resumed.title).toContain('resume');
  expect(paths.reportPath).toBe(transcriptRef);
  const fresh = readLatestHarnessSessionReport(paths.reportPath)!;
  expect(Date.parse(fresh.observedAt!)).toBeGreaterThanOrEqual(Date.parse(dispatchStartedAt));
  expect(await proveOpencodeTranscript({
    report: fresh, workspace: worktree, expectedStateRoot: first.stateRoot,
    dispatchStartedAt, bindingDeadlineAt: new Date().toISOString(),
  })).toMatchObject({ kind: 'proven', proof: { providerSessionId: originalSessionId } });
  writeFakeOpencode({ sessions: [] });
  await expect(createOpencodeResumeLaunch({
    ...launchInput({ stateRoot: stateRootParent }), sessionId: originalSessionId,
    originalStateRoot: first.stateRoot, transcriptRef: join(first.stateRoot, OPENCODE_SESSION_REPORT_FILENAME),
  }).prepare({ worktreePath: worktree })).rejects.toThrow(/Session/u);
});

test('read-only 启动先核验包装器，descriptor 记录可写状态根', async () => {
  const root = tempRoot('companion-oc-readonly-');
  const worktree = worktreeUnder(root);
  const stateRootParent = join(root, 'state');
  let asserted = 0;
  const strategy = createOpencodeWorkerLaunch({
    ...launchInput({ stateRoot: stateRootParent, sandboxMode: 'read-only-local-control' }),
    assertReadOnlyWrapperAvailable: () => { asserted += 1; return Promise.resolve(); },
  });
  const prepared = await strategy.prepare({ worktreePath: worktree });
  expect(asserted).toBe(1);
  expect(readDescriptor(prepared.stateRoot).readOnly).toEqual({
    stateRoot: prepared.stateRoot,
    workspace: worktree,
    reportDirectory: prepared.stateRoot,
  });

  const failingParent = join(root, 'state-2');
  const failing = createOpencodeWorkerLaunch({
    ...launchInput({ stateRoot: failingParent, sandboxMode: 'read-only' }),
    assertReadOnlyWrapperAvailable: () => Promise.reject(new Error('wrapper unavailable')),
  });
  await expect(failing.prepare({ worktreePath: worktree })).rejects.toThrow(/wrapper/u);
  expect(existsSync(join(failingParent, 'opencode'))).toBe(false);
});

/** 建好一个含 bootstrap 行的实际状态根，供观察/证明用例直接使用。 */
function bootstrapState(root: string, sessionId: string, cwd: string): string {
  const stateRoot = join(root, 'state', 'opencode', opencodeLaunchDigest('launch-1'));
  mkdirSync(join(stateRoot, 'xdg', 'data'), { recursive: true });
  const reportPath = join(stateRoot, OPENCODE_SESSION_REPORT_FILENAME);
  writeFileSync(reportPath, JSON.stringify({
    harness: 'opencode', sessionId, transcriptPath: reportPath, stateRoot, cwd, observedAt: null,
  }) + '\n', 'utf8');
  return stateRoot;
}

function window(): { readonly dispatchStartedAt: string; readonly bindingDeadlineAt: string } {
  const now = Date.now();
  return {
    dispatchStartedAt: new Date(now - 60_000).toISOString(),
    bindingDeadlineAt: new Date(now + 60_000).toISOString(),
  };
}

test('公开 API 唯一候选：observe/prove/identity 与 JSONL 确认行', async () => {
  const root = tempRoot('companion-oc-prove-');
  const sessionId = 'ses_proven1234';
  const worktree = worktreeUnder(root);
  const stateRoot = bootstrapState(root, sessionId, worktree);
  writeFakeOpencode(sessionFixture(sessionId, worktree));

  const observed = await observeOpencodeSession({ stateRoot, workspace: worktree, sessionId });
  expect(observed.kind).toBe('observed');
  if (observed.kind !== 'observed') return;
  expect(observed.report.observedAt).not.toBeNull();

  const proven = await proveOpencodeTranscript({
    report: observed.report,
    workspace: worktree,
    expectedStateRoot: stateRoot,
    ...window(),
  });
  expect(proven.kind).toBe('proven');
  if (proven.kind !== 'proven') return;
  expect(proven.proof.providerSessionId).toBe(sessionId);
  expect(proven.proof.transcriptRef).toBe(join(stateRoot, OPENCODE_SESSION_REPORT_FILENAME));

  const lines = reportLines(stateRoot);
  expect(lines.length).toBeGreaterThanOrEqual(2);
  expect(typeof lines.at(-1)?.['observedAt']).toBe('string');

  const identity = await readOpencodeTranscriptIdentity({
    transcriptRef: proven.proof.transcriptRef,
    workspace: worktree,
  });
  expect(identity).toEqual({ providerSessionId: sessionId });
});

test('prove 对状态根、时间窗与候选唯一性失败关闭', async () => {
  const root = tempRoot('companion-oc-prove-fail-');
  const sessionId = 'ses_failcheck1';
  const worktree = worktreeUnder(root);
  const stateRoot = bootstrapState(root, sessionId, worktree);
  const report = {
    harness: 'opencode' as const,
    sessionId,
    transcriptPath: join(stateRoot, OPENCODE_SESSION_REPORT_FILENAME),
    stateRoot,
    cwd: worktree,
    observedAt: null,
  };

  writeFakeOpencode(sessionFixture(sessionId, worktree));
  await expect(proveOpencodeTranscript({
    report: { ...report, stateRoot: join(root, 'other') },
    workspace: worktree,
    expectedStateRoot: stateRoot,
    ...window(),
  })).resolves.toMatchObject({ kind: 'transcript_unavailable' });

  await expect(proveOpencodeTranscript({
    report: { ...report, observedAt: new Date(Date.now() - 600_000).toISOString() },
    workspace: worktree,
    expectedStateRoot: stateRoot,
    ...window(),
  })).resolves.toMatchObject({ kind: 'transcript_unavailable' });

  const duplicated = {
    data: [
      { id: sessionId, location: { directory: worktree } },
      { id: sessionId, location: { directory: worktree } },
    ],
    cursor: { previous: null, next: null },
  };
  writeFakeOpencode({ list: duplicated });
  await expect(proveOpencodeTranscript({ report, workspace: worktree, expectedStateRoot: stateRoot, ...window() }))
    .resolves.toMatchObject({ kind: 'transcript_unavailable' });

  writeFakeOpencode({ list: { data: [] } });
  await expect(proveOpencodeTranscript({ report, workspace: worktree, expectedStateRoot: stateRoot, ...window() }))
    .resolves.toMatchObject({ kind: 'transcript_unavailable' });
});

test('inspect 分页覆盖完整；cursor 循环或 API 失败按证据缺口停止', async () => {
  const root = tempRoot('companion-oc-inspect-');
  const sessionId = 'ses_inspect123';
  const worktree = worktreeUnder(root);
  const stateRoot = bootstrapState(root, sessionId, worktree);
  const transcriptRef = join(stateRoot, OPENCODE_SESSION_REPORT_FILENAME);

  writeFakeOpencode({
    sessions: [{ id: sessionId, location: { directory: worktree } }],
    messagePages: {
      '': { data: [{ info: { id: 'msg_1' } }], cursor: { previous: null, next: 'c1' } },
      c1: { data: [{ info: { id: 'msg_2' } }], cursor: { previous: null, next: null } },
    },
  });
  const complete = await inspectOpencodeTranscript(transcriptRef);
  expect(complete).toMatchObject({
    kind: 'covered',
    evidence: { coverage: 'complete', lastCompleteEventRef: 'msg_2' },
  });
  if (complete.kind === 'covered') {
    expect(complete.evidence.readableRange).toMatchObject({ fromEventRef: 'msg_1', toEventRef: 'msg_2' });
  }

  writeFakeOpencode({
    listPages: {
      '': { data: [{ id: sessionId, location: { directory: worktree } }], cursor: { next: 'last' } },
      last: { data: [], cursor: {} },
    },
    messagePages: {
      '': { data: [{ info: { id: 'msg_1' } }], cursor: { next: 'last' } },
      last: { data: [], cursor: {} },
    },
  });
  await expect(observeOpencodeSession({ stateRoot, workspace: worktree, sessionId })).resolves.toMatchObject({ kind: 'observed' });
  await expect(inspectOpencodeTranscript(transcriptRef)).resolves.toMatchObject({
    kind: 'covered', evidence: { coverage: 'complete', lastCompleteEventRef: 'msg_1' },
  });

  writeFakeOpencode({
    sessions: [{ id: sessionId, location: { directory: worktree } }],
    messagePages: {
      '': { data: [{ info: { id: 'msg_1' } }], cursor: { previous: null, next: 'c1' } },
      c1: { data: [{ info: { id: 'msg_2' } }], cursor: { previous: null, next: 'c1' } },
    },
  });
  const cycled = await inspectOpencodeTranscript(transcriptRef);
  expect(cycled).toMatchObject({ kind: 'covered', evidence: { coverage: 'partial' } });
  if (cycled.kind === 'covered') {
    expect(cycled.evidence.gaps[0]?.reason).toBe('cursor_cycle');
  }

  writeFakeOpencode({ sessions: [], failMessages: true });
  await expect(inspectOpencodeTranscript(transcriptRef)).resolves.toMatchObject({ kind: 'transcript_unavailable' });
});

test('报告只认最新非空行，且拒绝多 session 候选', async () => {
  const root = tempRoot('companion-oc-report-');
  const sessionId = 'ses_report1234';
  const worktree = worktreeUnder(root);
  const stateRoot = bootstrapState(root, sessionId, worktree);
  const transcriptRef = join(stateRoot, OPENCODE_SESSION_REPORT_FILENAME);

  // 旧行有效但最新行 malformed：不得回落到旧行。
  appendFileSync(transcriptRef, '{"harness":"opencode","sessionId":"' + sessionId + '"\n', 'utf8');
  await expect(readOpencodeTranscriptIdentity({ transcriptRef, workspace: worktree }))
    .resolves.toMatchObject({ kind: 'transcript_unavailable' });

  // 两条有效行给出不同 session ID：多候选，fail closed。
  const line = (id: string): string => JSON.stringify({
    harness: 'opencode', sessionId: id, transcriptPath: transcriptRef, stateRoot, cwd: worktree, observedAt: null,
  });
  writeFileSync(transcriptRef, line(sessionId) + '\n' + line('ses_other9999') + '\n', 'utf8');
  await expect(readOpencodeTranscriptIdentity({ transcriptRef, workspace: worktree }))
    .resolves.toMatchObject({ kind: 'transcript_unavailable' });
});

test('材料只在 coverage 与实读逐项一致时写盘', async () => {
  const root = tempRoot('companion-oc-drift-');
  const sessionId = 'ses_drift12345';
  const worktree = worktreeUnder(root);
  const stateRoot = bootstrapState(root, sessionId, worktree);
  const transcriptRef = join(stateRoot, OPENCODE_SESSION_REPORT_FILENAME);
  const session = { id: sessionId, location: { directory: worktree } };
  const completePages = {
    '': { data: [{ info: { id: 'msg_1' } }, { info: { id: 'msg_2' } }], cursor: { previous: null, next: null } },
  };

  // 已签 complete，实读出现截断缺口：拒绝写材料。
  writeFakeOpencode({ sessions: [session], messagePages: completePages });
  const complete = await inspectOpencodeTranscript(transcriptRef);
  expect(complete.kind === 'covered' && complete.evidence.coverage).toBe('complete');
  if (complete.kind !== 'covered') return;
  writeFakeOpencode({
    sessions: [session],
    messagePages: { '': { data: [{ info: { id: 'msg_1' } }], cursor: { previous: null, next: null }, truncated: true } },
  });
  const driftRoot = join(root, 'utility-state');
  await expect(prepareOpencodeRecoveryMaterial(transcriptRef, driftRoot, complete.evidence)).resolves.toBeNull();
  expect(existsSync(opencodeRecoveryMaterialPath(driftRoot, transcriptRef))).toBe(false);

  // 已签 partial，实读变完整：同样拒绝。
  writeFakeOpencode({
    sessions: [session],
    messagePages: {
      '': { data: [{ info: { id: 'msg_1' } }], cursor: { previous: null, next: 'c1' } },
      c1: { data: [{ info: { id: 'msg_2' } }], cursor: { previous: null, next: 'c1' } },
    },
  });
  const partial = await inspectOpencodeTranscript(transcriptRef);
  expect(partial.kind === 'covered' && partial.evidence.coverage).toBe('partial');
  if (partial.kind !== 'covered') return;
  writeFakeOpencode({ sessions: [session], messagePages: completePages });
  await expect(prepareOpencodeRecoveryMaterial(transcriptRef, join(root, 'utility-state-2'), partial.evidence))
    .resolves.toBeNull();
});

test('截断的一页不计入可读事件，缺口后不得当 lastComplete', async () => {
  const root = tempRoot('companion-oc-truncated-');
  const sessionId = 'ses_trunc12345';
  const worktree = worktreeUnder(root);
  const stateRoot = bootstrapState(root, sessionId, worktree);
  const transcriptRef = join(stateRoot, OPENCODE_SESSION_REPORT_FILENAME);
  const session = { id: sessionId, location: { directory: worktree } };

  // 第二页被截断：msg_2 不得成为 lastComplete，缺口 reason=truncated。
  writeFakeOpencode({
    sessions: [session],
    messagePages: {
      '': { data: [{ info: { id: 'msg_1' } }], cursor: { previous: null, next: 'c1' } },
      c1: { data: [{ info: { id: 'msg_2' } }], cursor: { previous: null, next: null }, truncated: true },
    },
  });
  const truncated = await inspectOpencodeTranscript(transcriptRef);
  expect(truncated.kind === 'covered' && truncated.evidence.coverage).toBe('partial');
  if (truncated.kind !== 'covered') return;
  expect(truncated.evidence.lastCompleteEventRef).toBe('msg_1');
  expect(truncated.evidence.readableRange.toEventRef).toBe('msg_1');
  expect(truncated.evidence.gaps[0]?.reason).toBe('truncated');

  // 首页就截断：没有可读事件，直接不可用。
  writeFakeOpencode({
    sessions: [session],
    messagePages: { '': { data: [{ info: { id: 'msg_1' } }], cursor: { previous: null, next: null }, truncated: true } },
  });
  await expect(inspectOpencodeTranscript(transcriptRef)).resolves.toMatchObject({ kind: 'transcript_unavailable' });
});

test('派生转录材料：范围一致才写盘，缺口按 host gap 保留', async () => {
  const root = tempRoot('companion-oc-material-');
  const sessionId = 'ses_material123';
  const worktree = worktreeUnder(root);
  const stateRoot = bootstrapState(root, sessionId, worktree);
  const transcriptRef = join(stateRoot, OPENCODE_SESSION_REPORT_FILENAME);
  writeFakeOpencode({
    sessions: [{ id: sessionId, location: { directory: worktree } }],
    messagePages: {
      '': { data: [{ info: { id: 'msg_1' } }], cursor: { previous: null, next: 'c1' } },
      c1: { data: [{ info: { id: 'msg_2' } }], cursor: { previous: null, next: null } },
    },
  });
  const evidence = await inspectOpencodeTranscript(transcriptRef);
  expect(evidence.kind).toBe('covered');
  if (evidence.kind !== 'covered') return;

  const writableRoot = join(root, 'utility-state');
  const instructions = await prepareOpencodeRecoveryMaterial(transcriptRef, writableRoot, evidence.evidence);
  const materialPath = opencodeRecoveryMaterialPath(writableRoot, transcriptRef);
  expect(instructions?.join('\n')).toContain(materialPath);
  const material = readFileSync(materialPath, 'utf8').trim().split('\n')
    .map((line) => (JSON.parse(line) as { info: { id: string } }).info.id);
  expect(material).toEqual(['msg_1', 'msg_2']);

  // coverage 范围与实读不一致时不写材料。
  const mismatched: TranscriptCoverageEvidence = {
    ...evidence.evidence,
    readableRange: { ...evidence.evidence.readableRange, toEventRef: 'msg_9' },
  };
  const otherRoot = join(root, 'utility-state-2');
  await expect(prepareOpencodeRecoveryMaterial(transcriptRef, otherRoot, mismatched)).resolves.toBeNull();
  expect(existsSync(opencodeRecoveryMaterialPath(otherRoot, transcriptRef))).toBe(false);

  // 材料未生成时 instructions 只要求先 prepare。
  const pending = opencodeRecoveryInstructions(transcriptRef, { writableRoot });
  expect(pending?.join('\n')).toContain('prepareOpencodeRecoveryMaterial');
});
