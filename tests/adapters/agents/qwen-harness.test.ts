import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { HarnessSessionReport } from '../../../src/application/ports/worker-harness.js';
import {
  createQwenResumeLaunch, createQwenWorkerLaunch, inspectQwenTranscript, proveQwenTranscript,
  qwenHarness, qwenSessionIdFor, readQwenTranscriptIdentity,
} from '../../../src/adapters/agents/qwen-harness.js';
import { CODEX_MODEL_DESCRIPTOR_FILENAME } from '../../../src/adapters/agents/codex-model-launcher.js';
import type { WorkerModelSelection } from '../../../src/domain/model-configuration.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const selection: WorkerModelSelection = {
  model: 'MiniMax-M3.1-Flash-Preview', effort: null, effortCapability: null, catalogSource: null,
};
const otherSelection: WorkerModelSelection = { ...selection, model: 'some exact native model' };
type Descriptor = {
  readonly executable: string; readonly args: string[]; readonly harness: string;
  readonly runtimeReportPath: string; readonly expectedStateRoot?: string;
  readonly readOnly?: { readonly workspace: string; readonly stateRoot: string; readonly reportDirectory?: string };
};

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'companion-qwen-test-'));
  roots.push(root);
  return root;
}
function slug(cwd: string): string { return (process.platform === 'win32' ? cwd.toLowerCase() : cwd).replace(/[^a-zA-Z0-9]/gu, '-'); }
function transcriptAt(nativeRoot: string, cwd: string, id: string): string {
  return join(nativeRoot, 'projects', slug(cwd), 'chats', `${id}.jsonl`);
}
function qwenTranscript(path: string, id: string, cwd: string, chain: readonly { uuid: string; parentUuid: string | null }[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const rows = chain.map((entry, index) => JSON.stringify({
    ...entry, sessionId: id, type: index % 2 === 0 ? 'user' : 'assistant', cwd, version: '0.25.0',
  }));
  writeFileSync(path, rows.join('\n') + '\n');
}
function fakeQwen(root: string): string {
  const executable = join(root, 'fake-qwen.mjs');
  writeFileSync(executable, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
const args = process.argv.slice(2), flag = args.includes('--resume') ? '--resume' : '--session-id';
if (process.env.QWEN_TEST_MODE === 'nested' && !process.env.QWEN_FAKE_NATIVE_CHILD) {
  const result = spawnSync(process.execPath, [process.argv[1], ...args], { env: { ...process.env, QWEN_FAKE_NATIVE_CHILD: '1' } });
  process.exit(result.status ?? 1);
}
const id = args[args.indexOf(flag) + 1], cwd = process.cwd(), root = process.env.QWEN_RUNTIME_DIR;
const base = join(root, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), 'chats');
const transcript = join(base, id + '.jsonl'), sidecar = join(base, id + '.runtime.json');
mkdirSync(base, { recursive: true });
const mode = process.env.QWEN_TEST_MODE;
const uuid = 'qwen-user';
writeFileSync(transcript, JSON.stringify({ uuid, parentUuid: null, sessionId: id, cwd, version: '0.25.0', type: 'user' }) + '\\n');
writeFileSync(sidecar, JSON.stringify({ schema_version: 1, pid: mode === 'wrong-pid' ? process.pid + 1 : process.pid,
  session_id: id, work_dir: cwd, hostname: hostname(), started_at: Date.now() / 1000, qwen_version: '0.25.0' }));
writeFileSync(join(root, 'invocation.json'), JSON.stringify({ args, inherited: process.env.QWEN_NATIVE_AUTH === 'present' }));
setTimeout(() => process.exit(0), 120);
`, { mode: 0o700 });
  chmodSync(executable, 0o700);
  return executable;
}

async function prepareAndRun(mode = 'good', resume?: { id: string; nativeRoot: string; transcript: string }) {
  const root = tempRoot();
  const workspace = join(root, 'worktree with spaces');
  const nativeRoot = resume?.nativeRoot ?? join(root, 'native runtime');
  mkdirSync(workspace, { recursive: true }); mkdirSync(nativeRoot, { recursive: true });
  const id = resume?.id ?? qwenSessionIdFor('dispatch-qwen-1');
  const input = {
    launchId: 'dispatch-qwen-1', modelSelection: selection, sandboxMode: 'workspace-write' as const,
    stateRoot: join(root, 'companion-state'), sessionStartReporterPath: join(root, 'companion-state', 'reporter.mjs'),
    executable: fakeQwen(root), bindingTimeoutMs: 2_000,
  };
  const strategy = resume === undefined
    ? createQwenWorkerLaunch(input)
    : createQwenResumeLaunch({ ...input, sessionId: id, originalStateRoot: nativeRoot, transcriptRef: resume.transcript });
  const prepared = await strategy.prepare({ worktreePath: workspace });
  const descriptor = JSON.parse(readFileSync(join(prepared.stateRoot, CODEX_MODEL_DESCRIPTOR_FILENAME), 'utf8')) as Descriptor;
  writeFileSync(descriptor.runtimeReportPath, JSON.stringify({ stateRoot: nativeRoot, writableRoots: [nativeRoot] }) + '\n');
  const started = new Date().toISOString();
  const child = spawn(descriptor.executable, descriptor.args, {
    cwd: workspace,
    env: { ...process.env, QWEN_RUNTIME_DIR: nativeRoot, QWEN_TEST_MODE: mode, QWEN_NATIVE_AUTH: 'present' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', bytes => { stderr += String(bytes); });
  await new Promise<void>((done, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? done() : reject(new Error(`reporter exited ${String(code)}: ${stderr}`)));
  });
  const reportPath = join(dirname(input.sessionStartReporterPath), 'session-start.jsonl');
  const reportText = existsSync(reportPath) ? readFileSync(reportPath, 'utf8').trim() : '';
  const report = reportText.length > 0 ? JSON.parse(reportText) as HarnessSessionReport : null;
  return { root, workspace, nativeRoot, id, prepared, descriptor, report, started };
}

test('new launch pins exact model and deterministic UUID through production descriptor', async () => {
  const root = tempRoot(), workspace = join(root, 'worktree'); mkdirSync(workspace);
  const prepared = await createQwenWorkerLaunch({
    launchId: 'stable-qwen-dispatch', modelSelection: selection, sandboxMode: 'workspace-write', stateRoot: join(root, 'state'),
  }).prepare({ worktreePath: workspace });
  const descriptor = JSON.parse(readFileSync(join(prepared.stateRoot, CODEX_MODEL_DESCRIPTOR_FILENAME), 'utf8')) as Descriptor;
  const payload = JSON.parse(readFileSync(descriptor.args[1]!, 'utf8')) as { args: string[] };
  expect(descriptor.harness).toBe('qwen-code');
  expect(descriptor.executable).toBe(process.execPath);
  expect(payload.args).toEqual(['--model', selection.model, '--chat-recording', '--yolo', '--session-id', qwenSessionIdFor('stable-qwen-dispatch')]);
  expect(payload.args).not.toContain('--resume');
  expect(payload.args).not.toContain('--continue');
  expect(payload.args).not.toContain('--fork-session');
  expect(prepared.command).not.toContain('QWEN_NATIVE_AUTH');
  expect(qwenHarness.id).toBe('qwen-code');
});

test('report binds actual child PID, runtime sidecar, exact transcript header and inherited native environment', async () => {
  const result = await prepareAndRun();
  expect(result.report).toMatchObject({ harness: 'qwen-code', sessionId: result.id, cwd: result.workspace, stateRoot: result.nativeRoot });
  expect(result.report?.transcriptPath).toBe(transcriptAt(result.nativeRoot, result.workspace, result.id));
  const invocation = JSON.parse(readFileSync(join(result.nativeRoot, 'invocation.json'), 'utf8')) as { args: string[]; inherited: boolean };
  expect(invocation.inherited).toBe(true);
  expect(invocation.args).toEqual(['--model', selection.model, '--chat-recording', '--yolo', '--session-id', result.id]);
  await expect(readQwenTranscriptIdentity({ transcriptRef: result.report!.transcriptPath!, workspace: result.workspace }))
    .resolves.toEqual({ providerSessionId: result.id });
  await expect(proveQwenTranscript({
    report: result.report!, workspace: result.workspace, expectedStateRoot: result.nativeRoot,
    dispatchStartedAt: result.started, bindingDeadlineAt: new Date(Date.now() + 1000).toISOString(),
  })).resolves.toMatchObject({ kind: 'proven', proof: { providerSessionId: result.id, transcriptRef: result.report!.transcriptPath } });
});

test('stale sidecar with a different child PID never binds', async () => {
  const result = await prepareAndRun('wrong-pid');
  expect(result.report).toBeNull();
});

test('report binds a native sidecar PID from the launched CLI descendant', async () => {
  const result = await prepareAndRun('nested');
  expect(result.report).toMatchObject({ harness: 'qwen-code', sessionId: result.id, cwd: result.workspace });
  expect(result.report?.transcriptPath).toBe(transcriptAt(result.nativeRoot, result.workspace, result.id));
});

test('resume uses only exact --resume ID and validates the original transcript first', async () => {
  const root = tempRoot(), workspace = join(root, 'worktree'), nativeRoot = join(root, 'native');
  mkdirSync(workspace); mkdirSync(nativeRoot);
  const id = qwenSessionIdFor('existing-qwen-session'), transcript = transcriptAt(nativeRoot, workspace, id);
  qwenTranscript(transcript, id, workspace, [{ uuid: 'first', parentUuid: null }]);
  const prepared = await createQwenResumeLaunch({
    launchId: 'resume-qwen', modelSelection: otherSelection, sandboxMode: 'workspace-write',
    stateRoot: join(root, 'companion-state'), sessionId: id, originalStateRoot: nativeRoot, transcriptRef: transcript,
  }).prepare({ worktreePath: workspace });
  const descriptor = JSON.parse(readFileSync(join(prepared.stateRoot, CODEX_MODEL_DESCRIPTOR_FILENAME), 'utf8')) as Descriptor;
  const payload = JSON.parse(readFileSync(descriptor.args[1]!, 'utf8')) as { args: string[]; expectedStateRoot: string };
  expect(payload.args).toEqual(['--model', otherSelection.model, '--chat-recording', '--yolo', '--resume', id]);
  expect(payload.args).not.toContain('--session-id');
  expect(payload.args).not.toContain('--continue');
  expect(payload.args).not.toContain('--fork-session');
  expect(payload.expectedStateRoot).toBe(nativeRoot);
});

test('resume refuses a transcript whose native session id or cwd differs', async () => {
  const root = tempRoot(), workspace = join(root, 'worktree'), nativeRoot = join(root, 'native');
  mkdirSync(workspace); mkdirSync(nativeRoot);
  const id = qwenSessionIdFor('resume-qwen'), transcript = transcriptAt(nativeRoot, workspace, id);
  qwenTranscript(transcript, qwenSessionIdFor('other'), workspace, [{ uuid: 'first', parentUuid: null }]);
  await expect(createQwenResumeLaunch({ launchId: 'resume-qwen', modelSelection: selection, sandboxMode: 'workspace-write',
    sessionId: id, originalStateRoot: nativeRoot, transcriptRef: transcript }).prepare({ worktreePath: workspace })).rejects.toThrow(/identity/u);
});

test('coverage is complete only for one continuous native parent chain; branch and truncation are unavailable', async () => {
  const root = tempRoot(), workspace = join(root, 'worktree'), nativeRoot = join(root, 'native');
  mkdirSync(workspace); mkdirSync(nativeRoot);
  const id = qwenSessionIdFor('coverage'), transcript = transcriptAt(nativeRoot, workspace, id);
  qwenTranscript(transcript, id, workspace, [
    { uuid: 'root', parentUuid: null }, { uuid: 'child', parentUuid: 'root' }, { uuid: 'leaf', parentUuid: 'child' },
  ]);
  await expect(inspectQwenTranscript(transcript)).resolves.toMatchObject({ kind: 'covered', evidence: {
    coverage: 'complete', readableRange: { fromEventRef: 'root', toEventRef: 'leaf' }, lastCompleteEventRef: 'leaf', gaps: [],
  } });
  qwenTranscript(transcript, id, workspace, [
    { uuid: 'root', parentUuid: null }, { uuid: 'left', parentUuid: 'root' }, { uuid: 'right', parentUuid: 'root' },
  ]);
  await expect(inspectQwenTranscript(transcript)).resolves.toMatchObject({ kind: 'transcript_unavailable' });
  writeFileSync(transcript, readFileSync(transcript, 'utf8').trimEnd());
  await expect(inspectQwenTranscript(transcript)).resolves.toMatchObject({ kind: 'transcript_unavailable' });
});

test.each(['identity', 'coverage'])('invalid UTF-8 transcript bytes are rejected by %s inspection', async (inspection) => {
  const root = tempRoot(), workspace = join(root, 'worktree'), nativeRoot = join(root, 'native');
  mkdirSync(workspace); mkdirSync(nativeRoot);
  const id = qwenSessionIdFor('invalid-utf8'), transcript = transcriptAt(nativeRoot, workspace, id);
  mkdirSync(dirname(transcript), { recursive: true });
  const row = JSON.stringify({ uuid: 'first', parentUuid: null, sessionId: id, cwd: workspace,
    type: 'user', version: '0.25.0', metadata: 'x' });
  writeFileSync(transcript, Buffer.concat([
    Buffer.from(row.slice(0, -2), 'utf8'), Buffer.from([0xff]), Buffer.from(`${row.slice(-2)}\n`, 'utf8'),
  ]));
  if (inspection === 'identity') {
    await expect(readQwenTranscriptIdentity({ transcriptRef: transcript, workspace }))
      .resolves.toMatchObject({ kind: 'transcript_unavailable' });
  } else {
    await expect(inspectQwenTranscript(transcript)).resolves.toMatchObject({ kind: 'transcript_unavailable' });
  }
});

test('read-only launch delegates Qwen runtime roots to shared production bwrap', async () => {
  const root = tempRoot(), workspace = join(root, 'worktree'); mkdirSync(workspace);
  const prepared = await createQwenWorkerLaunch({
    launchId: 'qwen-readonly', modelSelection: selection, sandboxMode: 'read-only', stateRoot: join(root, 'state'),
    assertReadOnlyWrapperAvailable: () => Promise.resolve(),
  }).prepare({ worktreePath: workspace });
  const descriptor = JSON.parse(readFileSync(join(prepared.stateRoot, CODEX_MODEL_DESCRIPTOR_FILENAME), 'utf8')) as Descriptor;
  expect(descriptor.readOnly).toMatchObject({ workspace, stateRoot: prepared.stateRoot });
  expect(descriptor.harness).toBe('qwen-code');
  await expect(qwenHarness.queryModels({ cwd: workspace })).resolves.toMatchObject({ kind: 'unavailable' });
});
