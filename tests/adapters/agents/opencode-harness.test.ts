import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import {
  OPENCODE_SESSION_REPORT_FILENAME,
  createOpencodeResumeLaunch,
  createOpencodeWorkerLaunch,
  inspectOpencodeTranscript,
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
import { nativeWorkerRuntime } from '../../../src/adapters/agents/worker-runtime.js';
import { modelSelectionFixture } from '../../support/model-configurations.js';
import type { TranscriptCoverageEvidence } from '../../../src/application/recovery/recovery-capsule.js';
import { readLatestHarnessSessionReport, resumeSessionPathsUnder } from '../../../src/bootstrap/worker-harness.js';

const roots: string[] = [];
const originalPath = process.env['PATH'];
const originalHome = process.env['HOME'];
const originalXdgDataHome = process.env['XDG_DATA_HOME'];
beforeEach(() => { writeFakeOpencode({}); });

afterEach(() => {
  process.env['PATH'] = originalPath;
  if (originalHome === undefined) delete process.env['HOME']; else process.env['HOME'] = originalHome;
  if (originalXdgDataHome === undefined) delete process.env['XDG_DATA_HOME']; else process.env['XDG_DATA_HOME'] = originalXdgDataHome;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const OPENCODE_MODEL = 'MiniMax-M3.1-Flash-Preview';
const modelSelection = modelSelectionFixture({ model: OPENCODE_MODEL });

function launchInput(overrides: Partial<OpencodeExecutionInput> = {}): OpencodeExecutionInput {
  return {
    launchId: 'launch-1',
    modelSelection,
    sandboxMode: 'workspace-write',
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
  readonly version: number;
  readonly args: readonly string[];
  readonly runtimeReportPath: string;
  readonly harness?: string;
  readonly expectedStateRoot?: string;
  readonly readOnly?: { readonly stateRoot: string; readonly workspace: string; readonly reportDirectory?: string };
};

function readDescriptor(stateRoot: string): Descriptor {
  return readJson(join(stateRoot, CODEX_MODEL_DESCRIPTOR_FILENAME)) as unknown as Descriptor;
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

test('launcher v2 binds the native model selector and reports actual runtime roots', async () => {
  const root = tempRoot('companion-oc-launch-');
  const worktree = worktreeUnder(root);
  process.env['HOME'] = root;
  process.env['XDG_DATA_HOME'] = join(root, '.local', 'share');
  mkdirSync(join(process.env['XDG_DATA_HOME'], 'opencode'), { recursive: true });
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

  const descriptor = readDescriptor(actual);
  expect(descriptor.version).toBe(2);
  expect(descriptor.harness).toBe('opencode');
  expect(descriptor.args.map((arg) => arg.split('/').at(-1))).toEqual([
    'opencode-bootstrap.mjs', 'opencode-bootstrap.json',
  ]);
  expect(descriptor.runtimeReportPath).toBe(join(actual, 'native-runtime.json'));
  expect(readJson(descriptor.args[1]!).model).toBe(OPENCODE_MODEL);
  expect(readJson(descriptor.args[1]!).runtimeReportPath).toBe(descriptor.runtimeReportPath);
  expect(descriptor).not.toHaveProperty('environment');
  expect(descriptor.readOnly).toBeUndefined();
  execFileSync(process.execPath, [join(actual, 'codex-model-launcher.mjs'), join(actual, CODEX_MODEL_DESCRIPTOR_FILENAME)], { env: process.env, cwd: worktree });
  const runtime = readJson(descriptor.runtimeReportPath);
  expect(runtime['writableRoots']).toContain(runtime['stateRoot']);
  expect(runtime['stateRoot']).toBe(join(process.env['XDG_DATA_HOME'], 'opencode'));
  const report = readLatestHarnessSessionReport(join(actual, OPENCODE_SESSION_REPORT_FILENAME));
  expect(report).toMatchObject({
    sessionId: opencodeSessionIdFor('launch-1'),
    stateRoot: runtime['stateRoot'], runtimeRoots: runtime['writableRoots'], cwd: worktree,
  });
});

test('resume 复用原状态根与原 session id', async () => {
  const root = tempRoot('companion-oc-resume-');
  const worktree = worktreeUnder(root);
  const stateRootParent = join(root, 'state');
  const nativeRoot = join(root, '.local', 'share', 'opencode');
  mkdirSync(nativeRoot, { recursive: true });
  process.env['HOME'] = root;
  process.env['XDG_DATA_HOME'] = join(root, '.local', 'share');
  const first = await createOpencodeWorkerLaunch(launchInput({ stateRoot: stateRootParent }))
    .prepare({ worktreePath: worktree });
  const originalSessionId = 'ses_existing123';
  const transcriptRef = join(first.stateRoot, OPENCODE_SESSION_REPORT_FILENAME);
  const dispatchStartedAt = new Date(Date.now() - 1_000).toISOString();
  writeFileSync(transcriptRef, JSON.stringify({
    harness: 'opencode', sessionId: originalSessionId, transcriptPath: transcriptRef,
    stateRoot: nativeRoot, runtimeRoots: nativeWorkerRuntime('opencode').writableRoots, cwd: worktree, observedAt: dispatchStartedAt,
  }) + '\n');
  writeFakeOpencode(sessionFixture(originalSessionId, worktree));
  const paths = resumeSessionPathsUnder('opencode', stateRootParent, 'resume-1', first.stateRoot);
  const resumed = await createOpencodeResumeLaunch({
    ...launchInput({ stateRoot: stateRootParent }),
    sessionId: originalSessionId,
    originalStateRoot: nativeRoot,
    transcriptRef: join(first.stateRoot, OPENCODE_SESSION_REPORT_FILENAME),
  }).prepare({ worktreePath: worktree });

  expect(resumed.stateRoot).not.toBe(nativeRoot);
  const descriptor = readDescriptor(resumed.stateRoot);
  expect(readJson(descriptor.args[1]!).sessionId).toBe(originalSessionId);
  expect(descriptor.args).not.toContain(opencodeSessionIdFor('unrelated-launch'));
  expect(resumed.title).toContain('resume');
  expect(descriptor.expectedStateRoot).toBe(nativeRoot);
  expect(paths.reportPath).toBe(join(stateRootParent, 'opencode', opencodeLaunchDigest('resume-1'), OPENCODE_SESSION_REPORT_FILENAME));
  expect(readJson(descriptor.args[1]!).runtimeReportPath).toBe(descriptor.runtimeReportPath);
  writeFakeOpencode({ sessions: [] });
  await expect(createOpencodeResumeLaunch({
    ...launchInput({ stateRoot: stateRootParent }), sessionId: originalSessionId,
    originalStateRoot: nativeRoot, transcriptRef: join(first.stateRoot, OPENCODE_SESSION_REPORT_FILENAME),
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
  expect(readDescriptor(prepared.stateRoot).readOnly).toEqual({ stateRoot: prepared.stateRoot, workspace: worktree });

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
  mkdirSync(join(root, '.local', 'share', 'opencode'), { recursive: true });
  mkdirSync(stateRoot, { recursive: true });
  process.env['XDG_DATA_HOME'] = join(root, '.local', 'share');
  process.env['HOME'] = root;
  const reportPath = join(stateRoot, OPENCODE_SESSION_REPORT_FILENAME);
  const runtimeRoot = join(root, '.local', 'share', 'opencode');
  writeFileSync(reportPath, JSON.stringify({
    harness: 'opencode', sessionId, transcriptPath: reportPath, stateRoot: runtimeRoot,
    runtimeRoots: nativeWorkerRuntime('opencode').writableRoots, cwd, observedAt: null,
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
  bootstrapState(root, sessionId, worktree);
  const stateRoot = join(root, 'state', 'opencode', opencodeLaunchDigest('launch-1'));
  writeFakeOpencode(sessionFixture(sessionId, worktree));

  const report = readLatestHarnessSessionReport(join(stateRoot, OPENCODE_SESSION_REPORT_FILENAME))!;
  const nativeRoot = join(root, '.local', 'share', 'opencode');
  const startedAt = new Date(Date.now() - 1_000).toISOString();
  const proven = await proveOpencodeTranscript({
    report,
    workspace: worktree,
    expectedStateRoot: nativeRoot,
    dispatchStartedAt: startedAt,
    bindingDeadlineAt: new Date(Date.now() + 60_000).toISOString(),
  });
  expect(proven.kind).toBe('proven');
  if (proven.kind !== 'proven') return;
  expect(proven.proof.providerSessionId).toBe(sessionId);
  expect(proven.proof.transcriptRef).toBe(join(stateRoot, OPENCODE_SESSION_REPORT_FILENAME));

  expect(report.runtimeRoots).toEqual(nativeWorkerRuntime('opencode').writableRoots);

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
  bootstrapState(root, sessionId, worktree);
  const stateRoot = join(root, 'state', 'opencode', opencodeLaunchDigest('launch-1'));
  const report = {
    harness: 'opencode' as const,
    sessionId,
    transcriptPath: join(stateRoot, OPENCODE_SESSION_REPORT_FILENAME),
    stateRoot: join(root, '.local', 'share', 'opencode'),
    runtimeRoots: nativeWorkerRuntime('opencode').writableRoots,
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
  await expect(proveOpencodeTranscript({ report, workspace: worktree, expectedStateRoot: join(root, '.local', 'share', 'opencode'), ...window() }))
    .resolves.toMatchObject({ kind: 'transcript_unavailable' });

  writeFakeOpencode({ list: { data: [] } });
  await expect(proveOpencodeTranscript({ report, workspace: worktree, expectedStateRoot: join(root, '.local', 'share', 'opencode'), ...window() }))
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
    harness: 'opencode', sessionId: id, transcriptPath: transcriptRef,
    stateRoot: join(root, '.local', 'share', 'opencode'),
    runtimeRoots: nativeWorkerRuntime('opencode').writableRoots, cwd: worktree, observedAt: null,
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
