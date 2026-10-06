import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createCodexResumeLaunch, createCodexWorkerLaunch, installCodexSessionStartReporter } from '../../../src/adapters/agents/codex-launch.js';
import { codexConfigValue } from '../../../src/adapters/agents/codex-model-launcher.js';
import { nativeWorkerRuntime } from '../../../src/adapters/agents/worker-runtime.js';
import { modelSelectionFixture } from '../../support/model-configurations.js';

const roots: string[] = [];
const selection = modelSelectionFixture({ model: 'native-model', effort: 'medium', effortCapability: { values: ['medium'], source: 'native-catalog' }, catalogSource: 'native-catalog' });
test.each(['/outside/state/opencode.db', '../../outside/opencode.db'])('native OpenCode database path is included in read-only boundary: %s', (database) => {
  const runtime = nativeWorkerRuntime('opencode', { XDG_DATA_HOME: '/native/data', OPENCODE_DB: database }, '/user');
  expect(runtime.writableRoots).toContain(database.startsWith('/') ? '/outside/state' : '/native/outside');
  expect(runtime.stateRoot).toBe('/native/data/opencode');
});
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'companion-native-codex-'));
  roots.push(root);
  const workspace = join(root, 'workspace'), native = join(root, 'native'), artifacts = join(root, 'artifacts');
  for (const path of [workspace, native, artifacts]) mkdirSync(path);
  const observed = join(root, 'observed.json'), executable = join(root, 'codex.mjs');
  writeFileSync(executable, '#!' + process.execPath + '\nimport {writeFileSync} from "node:fs"; import {spawnSync} from "node:child_process"; const event={session_id:"launched-session",transcript_path:process.env.TRANSCRIPT,cwd:process.cwd()}; const hook=spawnSync(process.execPath,[process.env.REPORTER],{input:JSON.stringify(event),encoding:"utf8",env:process.env}); writeFileSync(process.env.OBSERVATION, JSON.stringify({args:process.argv.slice(2),env:process.env,hookStatus:hook.status,hookStdout:hook.stdout}));\n');
  chmodSync(executable, 0o755);
  return { root, workspace, native, artifacts, observed, executable };
}
test('SessionStart reporter records actual native roots and exact event identity', () => {
  const f = fixture(), reporterPath = join(f.artifacts, 'reporter.mjs'), reportPath = join(f.artifacts, 'report.jsonl');
  installCodexSessionStartReporter({ reporterPath, reportPath });
  const event = { session_id: 'exact-id', transcript_path: join(f.native, 'sessions', 'exact.jsonl'), cwd: f.workspace };
  execFileSync(process.execPath, [reporterPath], { input: JSON.stringify(event), env: { ...process.env, CODEX_HOME: f.native } });
  expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toMatchObject({
    sessionId: event.session_id, transcriptPath: event.transcript_path,
    codexHome: f.native, stateRoot: f.native, runtimeRoots: [f.native], cwd: f.workspace,
  });
});
test('launcher v2 applies modelSelection and inherits the actual native runtime environment', async () => {
  const f = fixture(), reporter = join(f.artifacts, 'reporter.mjs');
  const reportPath = join(f.artifacts, 'session-report.jsonl');
  installCodexSessionStartReporter({ reporterPath: reporter, reportPath });
  const launch = createCodexWorkerLaunch({ launchId: 'worker-1', modelSelection: selection, sandboxMode: 'workspace-write', stateRoot: f.artifacts, sessionStartReporterPath: reporter, codexExecutable: f.executable });
  const prepared = await launch.prepare({ worktreePath: f.workspace });
  const descriptorPath = join(prepared.stateRoot, 'codex-model-launch.json');
  const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8')) as { version: number; args: string[]; runtimeReportPath: string };
  expect(descriptor.version).toBe(2);
  expect(descriptor.args).toEqual(expect.arrayContaining(['--no-daemon', '--model', 'native-model', 'model_reasoning_effort="medium"']));
  expect(descriptor.args.join(' ')).toContain('hooks.SessionStart=');
  expect(descriptor.args.join(' ')).toContain('startup|resume');
  execFileSync(process.execPath, [join(prepared.stateRoot, 'codex-model-launcher.mjs'), descriptorPath], {
    env: { ...process.env, CODEX_HOME: f.native, OBSERVATION: f.observed, REPORTER: reporter, TRANSCRIPT: join(f.native, 'sessions', 'launched-session.jsonl') },
    cwd: f.workspace,
  });
  const observation = JSON.parse(readFileSync(f.observed, 'utf8')) as { env: Record<string, string>; args: string[]; hookStatus: number };
  expect(observation.env['CODEX_HOME']).toBe(f.native);
  expect(observation.hookStatus).toBe(0);
  expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toMatchObject({
    sessionId: 'launched-session', transcriptPath: join(f.native, 'sessions', 'launched-session.jsonl'),
    stateRoot: realpathSync(f.native), runtimeRoots: [realpathSync(f.native)], cwd: f.workspace,
  });
  expect(JSON.parse(readFileSync(descriptor.runtimeReportPath, 'utf8'))).toMatchObject({ stateRoot: realpathSync(f.native), writableRoots: [realpathSync(f.native)] });
});
test('只读 launcher 拒绝经符号链接与 workspace 重叠的 native writable root', async () => {
  const f = fixture(), nativeAlias = join(f.root, 'native-alias');
  symlinkSync(f.workspace, nativeAlias, 'dir');
  const prepared = await createCodexWorkerLaunch({
    launchId: 'overlap', modelSelection: selection, sandboxMode: 'read-only-local-control',
    stateRoot: f.artifacts, codexExecutable: f.executable,
  }).prepare({ worktreePath: f.workspace });
  expect(() => execFileSync(process.execPath, [
    join(prepared.stateRoot, 'codex-model-launcher.mjs'), join(prepared.stateRoot, 'codex-model-launch.json'),
  ], { env: { ...process.env, CODEX_HOME: nativeAlias, OBSERVATION: f.observed }, stdio: 'pipe' })).toThrow();
  expect(existsSync(f.observed)).toBe(false);
});
test('read-only roles share the wrapper and keep Companion artifacts outside the project', async () => {
  const f = fixture();
  const prepared = await createCodexWorkerLaunch({ launchId: 'finalizer', modelSelection: selection, sandboxMode: 'read-only-local-control', stateRoot: f.artifacts }).prepare({ worktreePath: f.workspace });
  const descriptor = JSON.parse(readFileSync(join(prepared.stateRoot, 'codex-model-launch.json'), 'utf8')) as Record<string, unknown>;
  expect(descriptor['readOnly']).toMatchObject({ workspace: f.workspace, stateRoot: prepared.stateRoot });
  expect(existsSync(join(f.workspace, '.companion'))).toBe(false);
});
test('resume checks the original native root and never overrides the current environment', async () => {
  const f = fixture();
  const prepared = await createCodexResumeLaunch({ launchId: 'resume', modelSelection: selection, sandboxMode: 'workspace-write', stateRoot: f.artifacts, sessionId: 'exact-session-id', codexHome: f.native, codexExecutable: f.executable }).prepare({ worktreePath: f.workspace });
  const launcher = join(prepared.stateRoot, 'codex-model-launcher.mjs'), descriptor = join(prepared.stateRoot, 'codex-model-launch.json');
  execFileSync(process.execPath, [launcher, descriptor], { env: { ...process.env, CODEX_HOME: f.native, OBSERVATION: f.observed } });
  const observed = JSON.parse(readFileSync(f.observed, 'utf8')) as { args: string[] };
  expect(observed.args.slice(0, 2)).toEqual(['resume', 'exact-session-id']);
  expect(() => execFileSync(process.execPath, [launcher, descriptor], { env: { ...process.env, CODEX_HOME: f.artifacts, OBSERVATION: f.observed }, stdio: 'pipe' })).toThrow();
  expect(existsSync(join(f.native, 'codex-model-launch.json'))).toBe(false);
});
test.each([
  { ...selection, effort: 'invalid' },
])('invalid Worker selection is rejected before artifact creation', (modelSelection) => {
  const f = fixture();
  expect(() => createCodexWorkerLaunch({ launchId: 'invalid', modelSelection, sandboxMode: 'workspace-write', stateRoot: join(f.root, 'absent') }).prepare({ worktreePath: f.workspace })).toThrow();
  expect(existsSync(join(f.root, 'absent'))).toBe(false);
});
test('hook values encode valid TOML inline tables', () => {
  expect(codexConfigValue([{ matcher: 'startup|resume', hooks: [{ type: 'command', timeout: 10 }] }])).toContain('"hooks" = [{');
  expect(codexConfigValue({ nested: null })).toBeNull();
});
