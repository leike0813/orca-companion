import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { kiloHarness, kiloReporterPluginSource, kiloReporterSource, kiloReportingDefinition, kiloReportingInstalled, maintainKiloReporting, parseKiloExport, inspectKiloTranscript, readKiloTranscriptIdentity } from '../../../src/adapters/agents/kilo-harness.js';
import { REPORT_TRAMPOLINE } from '../../../src/adapters/agents/worker-harness-reporting.js';
import { CODEX_MODEL_DESCRIPTOR_FILENAME, codexModelLaunchCommand, writeCodexModelLaunch } from '../../../src/adapters/agents/codex-model-launcher.js';
import { candidateSessionPaths } from '../../../src/adapters/agents/candidate-worker-launch.js';
import { modelSelectionFixture } from '../../support/model-configurations.js';

const processMocks = vi.hoisted(() => ({ runProcess: vi.fn() }));
vi.mock('../../../src/adapters/orca-cli/process-runner.js', () => ({ runProcess: processMocks.runProcess }));
const fsMocks = vi.hoisted(() => ({ onTemporaryWrite: null as (() => void) | null }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
    actual.writeFileSync(...args);
    if (typeof args[0] === 'string' && args[0].endsWith('.tmp')) fsMocks.onTemporaryWrite?.();
  } };
});

const tempRoots: string[] = [];
const originalEnv = { HOME: process.env['HOME'], XDG_DATA_HOME: process.env['XDG_DATA_HOME'], XDG_STATE_HOME: process.env['XDG_STATE_HOME'], XDG_CACHE_HOME: process.env['XDG_CACHE_HOME'], XDG_CONFIG_HOME: process.env['XDG_CONFIG_HOME'] };
afterEach(() => {
  fsMocks.onTemporaryWrite = null;
  processMocks.runProcess.mockReset();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function nativeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ocp-kilo-native-'));
  tempRoots.push(root);
  process.env['HOME'] = root;
  process.env['XDG_DATA_HOME'] = join(root, 'data');
  process.env['XDG_STATE_HOME'] = join(root, 'state');
  process.env['XDG_CACHE_HOME'] = join(root, 'cache');
  process.env['XDG_CONFIG_HOME'] = join(root, 'config');
  const workspace = join(root, 'workspace'), nativeRoot = join(root, 'data', 'kilo');
  const runtimeRoots = [nativeRoot, join(root, 'state', 'kilo'), join(root, 'state', 'kilo-sandbox-policy'), join(root, 'cache', 'kilo')];
  mkdirSync(workspace); for (const path of runtimeRoots) mkdirSync(path, { recursive: true });
  return { root, workspace, nativeRoot, runtimeRoots };
}

const bwrapUsable = spawnSync('bwrap', ['--version'], { encoding: 'utf8' }).status === 0;

function exportedSession(id: string, directory: string, messageIds = ['m1', 'm2']) {
  return { info: { id, directory }, messages: messageIds.map((messageId) => ({ info: { id: messageId, role: 'user' }, parts: [{ type: 'text', text: messageId }] })) };
}

function completedExport(value: unknown) {
  return { kind: 'completed', exitCode: 0, stdout: { text: JSON.stringify(value), truncated: false }, stderr: { text: '', truncated: false } };
}

describe('Kilo native adapter surfaces', () => {
  it.each(['valid', 'truncated', 'unknown-row', 'overflow'] as const)('bounds the public native catalog: %s', async (kind) => {
    const output = kind === 'overflow' ? Array.from({ length: 4097 }, (_, index) => `provider/model${index}`).join('\n')
      : kind === 'unknown-row' ? 'provider/model\nunknown diagnostic' : 'provider/model\nprovider/model\n';
    const completed = (text: string, truncated = false) => ({ kind: 'completed', exitCode: 0,
      stdout: { text, truncated }, stderr: { text: '', truncated: false } });
    processMocks.runProcess.mockResolvedValueOnce(completed('7.8.8')).mockResolvedValueOnce(completed(output, kind === 'truncated'));
    const result = await kiloHarness.queryModels({ cwd: '/tmp' });
    expect(result.kind).toBe(kind === 'valid' ? 'available' : 'unavailable');
    if (result.kind === 'available') {
      expect(result.models).toEqual([{ model: 'provider/model', effortCapability: null }]);
      expect(result.source).toContain('7.8.8');
    }
  });
  it('accepts only the public ID export identity and message structure', () => {
    const valid = { info: { id: 'session_1', directory: '/workspace' }, messages: [
      { info: { id: 'message_1', role: 'user' }, parts: [{ type: 'text', text: 'hello' }] },
    ] };
    expect(parseKiloExport(valid)?.info).toMatchObject({ id: 'session_1', directory: '/workspace' });
    expect(parseKiloExport({ ...valid, info: { ...valid.info, id: '../other' } })).toBeNull();
    expect(parseKiloExport({ ...valid, messages: [{ info: { id: 'message_1' }, parts: [] }] })).toBeNull();
  });

  it('exposes the native JSONC plugin-array installation contract and trampoline forwarding source', () => {
    const definition = kiloReportingDefinition({ HOME: '/home/test', XDG_CONFIG_HOME: '/config', XDG_DATA_HOME: '/data' });
    expect(definition.configPath).toBe('/config/kilo/kilo.jsonc');
    expect(definition.pluginEntry).toBe('/data/orca-companion/worker-reporting/kilo-session-reporter.mjs');
    expect(definition.pluginSource).toContain('session.created');
    expect(definition.pluginSource).toContain('session.updated');
    expect(kiloReporterPluginSource()).toContain('JSON.stringify(event)');
    expect(REPORT_TRAMPOLINE).toContain('ORCA_COMPANION_SESSION_REPORTER');
  });

  it.each([
    { sessionID: undefined, accepted: true },
    { sessionID: 'session_1', accepted: true },
    { sessionID: 'other_session', accepted: false },
  ])('executes the reporter from the native plugin host (sessionID: $sessionID)', ({ sessionID, accepted }) => {
    const { root, workspace, nativeRoot, runtimeRoots } = nativeFixture();
    const sessionId = 'session_1', bin = join(root, 'bin'), artifacts = join(root, 'reporting');
    mkdirSync(bin); mkdirSync(artifacts);
    const fakeKilo = join(bin, 'kilo'), exported = exportedSession(sessionId, workspace);
    // The executable only implements the exact public export; plugin-loaded export recursion fails this fixture.
    writeFileSync(fakeKilo, `#!${process.execPath}\nif (JSON.stringify(process.argv.slice(2)) !== ${JSON.stringify(JSON.stringify(['export', sessionId, '--pure']))}) process.exit(2);\nprocess.stdout.write(${JSON.stringify(JSON.stringify(exported))});\n`, { mode: 0o700 });
    const reportPath = join(artifacts, 'report.jsonl'), runtimePath = join(artifacts, 'runtime.json');
    const reporterPath = join(artifacts, 'reporter.mjs'), trampolinePath = join(artifacts, 'report.mjs'), pluginPath = join(artifacts, 'plugin.mjs');
    writeFileSync(runtimePath, JSON.stringify({ stateRoot: nativeRoot, writableRoots: runtimeRoots }));
    writeFileSync(reporterPath, kiloReporterSource(reportPath, runtimePath));
    writeFileSync(trampolinePath, REPORT_TRAMPOLINE);
    writeFileSync(pluginPath, kiloReporterPluginSource(trampolinePath));
    const event = { type: 'session.created', properties: { info: { id: sessionId, directory: workspace }, ...(sessionID === undefined ? {} : { sessionID }) } };
    const hostPath = join(artifacts, 'native-host.mjs');
    // Model compiled Bun's process.execPath while executing the real generated plugin/trampoline/reporter chain.
    writeFileSync(hostPath, `Object.defineProperty(process, 'execPath', { value: ${JSON.stringify(fakeKilo)} });\nconst { default: plugin } = await import(${JSON.stringify(pathToFileURL(pluginPath).href)});\nawait (await plugin()).event({ event: ${JSON.stringify(event)} });\n`);
    const result = spawnSync(process.execPath, [hostPath], { cwd: workspace,
      env: { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}`, ORCA_COMPANION_SESSION_REPORTER: reporterPath }, encoding: 'utf8', timeout: 10_000 });
    if (!accepted) {
      expect(result.status).not.toBe(0);
      expect(() => readFileSync(reportPath)).toThrow();
      return;
    }
    expect(result.status, result.stderr).toBe(0);
    const report: unknown = JSON.parse(readFileSync(reportPath, 'utf8').trim());
    const transcriptPath = join(nativeRoot, 'orca-companion-exports', `${sessionId}.json`);
    expect(report).toMatchObject({ harness: 'kilo', sessionId, cwd: workspace, transcriptPath, stateRoot: nativeRoot, runtimeRoots });
    expect(parseKiloExport(JSON.parse(readFileSync(transcriptPath, 'utf8')))?.messages).toEqual(exported.messages);
  });

  it('installs and removes only its plugin entry while preserving existing JSONC text', () => {
    const root = mkdtempSync(join(tmpdir(), 'ocp-kilo-setup-'));
    const definition = kiloReportingDefinition({ HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data') });
    mkdirSync(dirname(definition.pluginPath), { recursive: true });
    mkdirSync(dirname(definition.configPath), { recursive: true });
    writeFileSync(join(dirname(definition.pluginPath), 'report.mjs'), REPORT_TRAMPOLINE);
    const original = '{\n  // keep native comment\n  "provider": { "default": "native" },\n  "plugin": ["other-plugin",],\n}\n';
    writeFileSync(definition.configPath, original, { mode: 0o640 });
    maintainKiloReporting('install', definition);
    maintainKiloReporting('install', definition);
    expect(kiloReportingInstalled(definition)).toBe(true);
    const installed = readFileSync(definition.configPath, 'utf8');
    expect(statSync(definition.configPath).mode & 0o777).toBe(0o640);
    expect(installed).toContain('// keep native comment');
    expect(installed).toContain('"provider": { "default": "native" }');
    expect(installed).toContain(definition.pluginEntry);
    maintainKiloReporting('uninstall', definition);
    const removed = readFileSync(definition.configPath, 'utf8');
    expect(statSync(definition.configPath).mode & 0o777).toBe(0o640);
    expect(removed).toContain('// keep native comment');
    expect(removed).toContain('"provider": { "default": "native" }');
    expect(removed).toContain('"other-plugin"');
    expect(removed).not.toContain(definition.pluginEntry);
    expect(kiloReportingInstalled(definition)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    { override: true, customDirectory: false },
    { override: false, customDirectory: false },
    { override: true, customDirectory: true },
  ])('maintains the native plugin-array source (override: $override, custom: $customDirectory)', ({ override, customDirectory }) => {
    const root = mkdtempSync(join(tmpdir(), 'ocp-kilo-precedence-'));
    tempRoots.push(root);
    const configRoot = join(root, 'config', 'kilo');
    mkdirSync(configRoot, { recursive: true });
    const lower = join(configRoot, 'kilo.jsonc'), higher = join(configRoot, 'opencode.json');
    const lowerText = '{"model":"native/default","plugin":["lower-plugin"]}\n';
    const higherText = JSON.stringify(override ? { plugin: ['higher-plugin'] } : { model: 'native/override' }) + '\n';
    writeFileSync(lower, lowerText); writeFileSync(higher, higherText);
    const env = { XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
      ...(customDirectory ? { KILO_CONFIG_DIR: configRoot } : {}) };
    const definition = kiloReportingDefinition(env);
    expect(definition.configPath).toBe(override ? higher : lower);
    mkdirSync(dirname(definition.pluginPath), { recursive: true });
    writeFileSync(join(dirname(definition.pluginPath), 'report.mjs'), REPORT_TRAMPOLINE);
    maintainKiloReporting('install', definition);
    expect(kiloReportingInstalled(kiloReportingDefinition(env))).toBe(true);
    expect(JSON.parse(readFileSync(definition.configPath, 'utf8'))).toMatchObject({ plugin: [
      override ? 'higher-plugin' : 'lower-plugin', definition.pluginEntry,
    ] });
    expect(readFileSync(override ? lower : higher, 'utf8')).toBe(override ? lowerText : higherText);
    maintainKiloReporting('uninstall', definition);
    expect(JSON.parse(readFileSync(lower, 'utf8'))).toEqual(JSON.parse(lowerText));
    expect(JSON.parse(readFileSync(higher, 'utf8'))).toEqual(JSON.parse(higherText));
  });

  it.each([
    { action: 'install', existing: true },
    { action: 'install', existing: false },
    { action: 'uninstall', existing: true },
  ] as const)('refuses $action when native config changes after reading (existing: $existing)', ({ action, existing }) => {
    const root = mkdtempSync(join(tmpdir(), 'ocp-kilo-cas-'));
    tempRoots.push(root);
    const definition = kiloReportingDefinition({ XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data') });
    mkdirSync(dirname(definition.pluginPath), { recursive: true });
    mkdirSync(dirname(definition.configPath), { recursive: true });
    writeFileSync(join(dirname(definition.pluginPath), 'report.mjs'), REPORT_TRAMPOLINE);
    if (existing) writeFileSync(definition.configPath, '{"model":"original/default"}\n', { mode: 0o640 });
    if (action === 'uninstall') maintainKiloReporting('install', definition);
    const concurrent = '{"model":"user/default","provider":{"native":{"env":["NATIVE_KEY"]}}}\n';
    fsMocks.onTemporaryWrite = () => {
      fsMocks.onTemporaryWrite = null;
      writeFileSync(definition.configPath, concurrent, { mode: 0o640 });
    };
    expect(() => maintainKiloReporting(action, definition)).toThrow(expect.objectContaining({ code: 'native_config_changed' }));
    expect(readFileSync(definition.configPath, 'utf8')).toBe(concurrent);
    expect(statSync(definition.configPath).mode & 0o777).toBe(0o640);
  });

  it('locates plugin after native scalar config values without confusing their closing quotes for new strings', () => {
    const { root } = nativeFixture();
    const definition = kiloReportingDefinition(process.env);
    mkdirSync(dirname(definition.pluginPath), { recursive: true });
    writeFileSync(join(dirname(definition.pluginPath), 'report.mjs'), REPORT_TRAMPOLINE);
    const config = '{\n  "theme": "dark",\n  "model": "provider/model",\n  "plugin": ["existing"],\n}\n';
    mkdirSync(dirname(definition.configPath), { recursive: true }); writeFileSync(definition.configPath, config);
    expect(() => maintainKiloReporting('install', definition)).not.toThrow();
    const installed = readFileSync(definition.configPath, 'utf8');
    expect(installed).toContain('"theme": "dark"'); expect(installed).toContain('"model": "provider/model"');
    expect(installed).toContain('"existing"'); expect(installed).toContain(definition.pluginEntry);
    rmSync(root, { recursive: true, force: true });
  });

  it('proves the reported native session and complete exported message range, rejecting cwd and ID mismatches', async () => {
    const { root, workspace, nativeRoot, runtimeRoots } = nativeFixture();
    const sessionId = 'session_1', transcriptPath = join(nativeRoot, 'orca-companion-exports', `${sessionId}.json`);
    mkdirSync(dirname(transcriptPath), { recursive: true });
    writeFileSync(transcriptPath, JSON.stringify(exportedSession(sessionId, workspace)));
    const report = { harness: 'kilo', sessionId, transcriptPath, cwd: workspace, observedAt: '2026-10-11T00:00:01.000Z', stateRoot: nativeRoot, runtimeRoots };
    const input = { report, workspace, expectedStateRoot: nativeRoot, dispatchStartedAt: '2026-10-11T00:00:00.000Z', bindingDeadlineAt: '2026-10-11T00:01:00.000Z' };
    processMocks.runProcess.mockResolvedValue(completedExport(exportedSession(sessionId, workspace)));
    await expect(kiloHarness.proveSession(input)).resolves.toMatchObject({ kind: 'proven', proof: { providerSessionId: sessionId, transcriptRef: transcriptPath } });
    await expect(readKiloTranscriptIdentity({ transcriptRef: transcriptPath, workspace })).resolves.toEqual({ providerSessionId: sessionId });
    expect(processMocks.runProcess).toHaveBeenCalledWith(expect.objectContaining({ executable: 'kilo', args: ['export', sessionId, '--pure'], cwd: workspace }));
    await expect(inspectKiloTranscript(transcriptPath)).resolves.toMatchObject({ kind: 'covered', evidence: {
      coverage: 'complete', readableRange: { fromEventRef: 'm1', toEventRef: 'm2' }, lastCompleteEventRef: 'm2', gaps: [],
    } });

    await expect(kiloHarness.proveSession({ ...input, workspace: join(root, 'elsewhere') })).resolves.toMatchObject({ kind: 'transcript_unavailable' });
    processMocks.runProcess.mockResolvedValue(completedExport(exportedSession('other_session', workspace)));
    await expect(kiloHarness.proveSession(input)).resolves.toMatchObject({ kind: 'transcript_unavailable' });
    processMocks.runProcess.mockResolvedValue(completedExport(exportedSession(sessionId, join(root, 'elsewhere'))));
    await expect(inspectKiloTranscript(transcriptPath)).resolves.toMatchObject({ kind: 'transcript_unavailable' });
  });

  it.each(['additional-message', 'changed-content'] as const)('refuses complete coverage for a saved snapshot with $0', async (difference) => {
    const { workspace, nativeRoot } = nativeFixture();
    const sessionId = 'session_1', transcriptPath = join(nativeRoot, 'orca-companion-exports', `${sessionId}.json`);
    mkdirSync(dirname(transcriptPath), { recursive: true });
    const saved = exportedSession(sessionId, workspace);
    writeFileSync(transcriptPath, JSON.stringify(saved));
    const fresh = difference === 'additional-message' ? exportedSession(sessionId, workspace, ['m1', 'm2', 'm3'])
      : { ...saved, messages: saved.messages.map((message) => ({ ...message, parts: [{ type: 'text', text: 'native content changed' }] })) };
    processMocks.runProcess.mockResolvedValue(completedExport(fresh));
    await expect(inspectKiloTranscript(transcriptPath)).resolves.toMatchObject({ kind: 'transcript_unavailable' });
    expect(parseKiloExport(JSON.parse(readFileSync(transcriptPath, 'utf8')))?.messages).toEqual(saved.messages);
  });

  it.each(['wrong-id', 'wrong-cwd', 'unavailable'] as const)('independently rejects saved identity when public export is $0', async (difference) => {
    const { workspace, nativeRoot } = nativeFixture();
    const sessionId = 'session_1', transcriptPath = join(nativeRoot, 'orca-companion-exports', `${sessionId}.json`);
    mkdirSync(dirname(transcriptPath), { recursive: true });
    writeFileSync(transcriptPath, JSON.stringify(exportedSession(sessionId, workspace)));
    processMocks.runProcess.mockResolvedValue(difference === 'unavailable' ? { kind: 'completed', exitCode: 1 }
      : completedExport(exportedSession(difference === 'wrong-id' ? 'other_session' : sessionId, difference === 'wrong-cwd' ? nativeRoot : workspace)));
    await expect(readKiloTranscriptIdentity({ transcriptRef: transcriptPath, workspace })).resolves.toMatchObject({ kind: 'transcript_unavailable' });
  });

  it('resumes only the exact Kilo export ID after installing its reporter into a temporary native config', async () => {
    const { root, workspace, nativeRoot } = nativeFixture();
    const sessionId = 'resume_session', transcriptRef = join(nativeRoot, 'orca-companion-exports', `${sessionId}.json`);
    mkdirSync(dirname(transcriptRef), { recursive: true });
    writeFileSync(transcriptRef, JSON.stringify(exportedSession(sessionId, workspace)));
    const definition = kiloReportingDefinition(process.env);
    mkdirSync(dirname(definition.pluginPath), { recursive: true });
    writeFileSync(join(dirname(definition.pluginPath), 'report.mjs'), REPORT_TRAMPOLINE);
    maintainKiloReporting('install', definition);
    const launchId = 'resume-launch';
    const artifactRoot = join(root, 'artifacts');
    const strategy = kiloHarness.prepareResume({ launchId, modelSelection: modelSelectionFixture({ model: 'native/model', effort: null, effortCapability: null, catalogSource: null }),
      sandboxMode: 'workspace-write', stateRoot: artifactRoot, sessionId, originalStateRoot: nativeRoot, transcriptRef });
    expect(strategy.activation).toBe('none');
    const prepared = await strategy.prepare({ worktreePath: workspace });
    const stateRoot = candidateSessionPaths('kilo', artifactRoot, launchId).stateRoot;
    const descriptor = JSON.parse(readFileSync(join(stateRoot, CODEX_MODEL_DESCRIPTOR_FILENAME), 'utf8')) as { readonly args: readonly string[] };
    expect(prepared.stateRoot).toBe(stateRoot);
    expect(prepared.command).toContain('KILO_NO_DAEMON=1');
    expect(descriptor.args).not.toContain('--mini');
    expect(descriptor.args).toContain(sessionId);
    expect(descriptor.args).toContain('--session');
    await expect(kiloHarness.prepareResume({ launchId, modelSelection: modelSelectionFixture({ model: 'native/model', effort: null, effortCapability: null, catalogSource: null }),
      sandboxMode: 'workspace-write', stateRoot: artifactRoot, sessionId, originalStateRoot: nativeRoot,
      transcriptRef: join(nativeRoot, 'orca-companion-exports', 'another_session.json') }).prepare({ worktreePath: workspace })).rejects.toThrow();
  });

  it.skipIf(!bwrapUsable)('只读边界放开 XDG state 下的 sandbox policy，同时仍拒写 workspace 与 Git', () => {
    const { root, workspace } = nativeFixture();
    mkdirSync(join(workspace, '.git'));
    // 保持 artifacts 父目录与 XDG native root 分离，复现生产 launcher 的实际目录关系。
    const stateRoot = candidateSessionPaths('kilo', join(root, 'artifacts'), 'sandbox-policy').stateRoot;
    mkdirSync(stateRoot, { recursive: true });
    const coordination = join(workspace, '.git', 'coordination.sqlite');
    writeFileSync(coordination, 'retained');
    const probe = "const fs = require('node:fs'); const run = (p) => { try { fs.writeFileSync(p, 'x'); return 'allowed'; } catch (error) { return error.code; } };"
      + ' process.stdout.write(JSON.stringify({ policy: run(process.argv[1]), workspace: run(process.argv[2]), git: run(process.argv[3]), coordination: run(process.argv[4]) }));';
    const launch = writeCodexModelLaunch({ stateRoot, descriptor: { version: 2, executable: process.execPath, harness: 'kilo',
      args: ['-e', probe, join(root, 'state', 'kilo-sandbox-policy', 'policy.json'), join(workspace, 'blocked.txt'), join(workspace, '.git', 'blocked.txt'), coordination],
      readOnly: { workspace, stateRoot } } });
    const result = spawnSync('script', ['-qec', codexModelLaunchCommand(launch), '--echo', 'never', '/dev/null'], { env: { ...process.env }, encoding: 'utf8', timeout: 30_000 });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ policy: 'allowed', workspace: 'EROFS', git: 'EROFS', coordination: 'EROFS' });
    expect(readFileSync(coordination, 'utf8')).toBe('retained');
  });
});
