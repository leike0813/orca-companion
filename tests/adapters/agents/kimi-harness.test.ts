import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { kimiHarness, kimiMainWirePath, kimiWorkspaceKey, kimiReporterSource, kimiReporterHookToml, kimiReportingDefinition, kimiReportingInstalled, kimiSessionLocation, maintainKimiReporting, inspectKimiTranscript, parseKimiWire, parseKimiModelCatalog, readKimiTranscriptIdentity } from '../../../src/adapters/agents/kimi-harness.js';
import { REPORT_TRAMPOLINE } from '../../../src/adapters/agents/worker-harness-reporting.js';
import { CODEX_MODEL_DESCRIPTOR_FILENAME } from '../../../src/adapters/agents/codex-model-launcher.js';
import { candidateSessionPaths } from '../../../src/adapters/agents/candidate-worker-launch.js';
import { modelSelectionFixture } from '../../support/model-configurations.js';

const processMocks = vi.hoisted(() => ({ runProcess: vi.fn(), archivePath: null as string | null, onExport: null as (() => void) | null }));
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
const originalEnv = { HOME: process.env['HOME'], KIMI_CODE_HOME: process.env['KIMI_CODE_HOME'], XDG_DATA_HOME: process.env['XDG_DATA_HOME'] };
afterEach(() => {
  vi.restoreAllMocks();
  fsMocks.onTemporaryWrite = null;
  processMocks.runProcess.mockReset(); processMocks.archivePath = null;
  processMocks.onExport = null;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function nativeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ocp-kimi-native-'));
  tempRoots.push(root);
  process.env['HOME'] = root;
  process.env['KIMI_CODE_HOME'] = join(root, 'kimi-home');
  process.env['XDG_DATA_HOME'] = join(root, 'xdg-data');
  const nativeRoot = process.env['KIMI_CODE_HOME'];
  const workspace = join(root, 'workspace'), sessionId = 'session_17867a2c-b960-4510-a457-e74abc2d96a8';
  const transcriptPath = kimiMainWirePath(nativeRoot, workspace, sessionId), sessionDir = dirname(dirname(dirname(transcriptPath)));
  mkdirSync(workspace); mkdirSync(dirname(transcriptPath), { recursive: true });
  mkdirSync(join(sessionDir, 'agents', 'reviewer'), { recursive: true });
  const mainWire = [
    { type: 'metadata', protocol_version: '1.5', created_at: 1 },
    { type: 'runtime.set_binding', agentId: 'main', time: 1, workspaceId: kimiWorkspaceKey(workspace), runtimeId: 'local' },
    { type: 'context.append_message', agentId: 'main', time: 2, message: { role: 'user', content: [{ type: 'text', text: 'inspect' }], toolCalls: [], origin: { kind: 'user' } } },
    { type: 'context.append_loop_event', agentId: 'main', time: 3, event: { type: 'step.begin', uuid: 'step-1', turnId: '1', step: 1 } },
    { type: 'context.append_loop_event', agentId: 'main', time: 4, event: { type: 'content.part', uuid: 'part-1', turnId: '1', step: 1, part: { type: 'text', text: 'done' } } },
    { type: 'context.append_loop_event', agentId: 'main', time: 5, event: { type: 'step.end', uuid: 'step-1', turnId: '1', step: 1 } },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n';
  const reviewerWire = [
    { type: 'metadata', protocol_version: '1.5', created_at: 2 },
    { type: 'context.append_loop_event', agentId: 'reviewer', time: 2, event: { type: 'step.end', uuid: 'step-2', turnId: '2', step: 1 } },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n';
  writeFileSync(transcriptPath, mainWire);
  writeFileSync(join(sessionDir, 'agents', 'reviewer', 'wire.jsonl'), reviewerWire);
  const archiveSource = join(root, 'archive-source'), archivePath = join(root, 'session.zip');
  const manifest = { sessionId, workspaceDir: workspace, kimiCodeVersion: '2.1.1', wireProtocolVersion: '1.5', exportedAt: '2026-10-11T00:00:01.000Z' };
  mkdirSync(archiveSource); writeFileSync(join(archiveSource, 'manifest.json'), JSON.stringify(manifest));
  mkdirSync(join(archiveSource, 'agents', 'main'), { recursive: true });
  mkdirSync(join(archiveSource, 'agents', 'reviewer'), { recursive: true });
  writeFileSync(join(archiveSource, 'agents', 'main', 'wire.jsonl'), mainWire);
  writeFileSync(join(archiveSource, 'agents', 'reviewer', 'wire.jsonl'), reviewerWire);
  execFileSync('zip', ['-q', '-r', archivePath, 'manifest.json', 'agents'], { cwd: archiveSource });
  processMocks.archivePath = archivePath;
  processMocks.runProcess.mockImplementation(({ executable, args, cwd }: { executable: string; args: readonly string[]; cwd: string }) => {
    if (executable === 'kimi') {
      copyFileSync(processMocks.archivePath as string, String(args[3]));
      processMocks.onExport?.();
      return Promise.resolve({ kind: 'completed', exitCode: 0, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } });
    }
    const text = execFileSync('unzip', args, { cwd, encoding: 'utf8' });
    return Promise.resolve({ kind: 'completed', exitCode: 0, stdout: { text, truncated: false }, stderr: { text: '', truncated: false } });
  });
  const rebuildArchive = () => {
    unlinkSync(archivePath);
    execFileSync('zip', ['-q', '-r', archivePath, 'manifest.json', 'agents'], { cwd: archiveSource });
  };
  return { root, workspace, nativeRoot, sessionId, transcriptPath, sessionDir, archivePath, archiveSource, manifest, rebuildArchive };
}

describe('Kimi Code native adapter surfaces', () => {
  it('matches the verified Kimi 2.1.1 workspace key and native Session path', () => {
    const workspace = '/var/tmp/orca-harness-acceptance-ncWTVr/project-companion-harness-matrix-08812582-8e7b-40d9-99fe-3f17689570f2';
    const key = 'wd_project-companion-harness-matrix-0881258_3ebc338b1854';
    expect(kimiWorkspaceKey(workspace)).toBe(key);
    expect(kimiWorkspaceKey(`${workspace}/`)).toBe(key);
    expect(kimiMainWirePath('/native', workspace, 'session_17867a2c-b960-4510-a457-e74abc2d96a8'))
      .toBe(`/native/sessions/${key}/session_17867a2c-b960-4510-a457-e74abc2d96a8/agents/main/wire.jsonl`);
  });

  it('reports the deterministic transcript from the native snake-case SessionStart payload', () => {
    const { root, workspace, nativeRoot, sessionId, transcriptPath } = nativeFixture();
    const reporter = join(root, 'reporter.mjs'), reportPath = join(root, 'report.jsonl'), runtimePath = join(root, 'runtime.json');
    writeFileSync(runtimePath, JSON.stringify({ stateRoot: nativeRoot, writableRoots: [nativeRoot] }));
    writeFileSync(reporter, kimiReporterSource(reportPath, runtimePath));
    const payload = { hook_event_name: 'SessionStart', session_id: sessionId, cwd: workspace, source: 'startup' };
    execFileSync(process.execPath, [reporter], { input: JSON.stringify(payload), env: process.env });
    expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toMatchObject({ harness: 'kimi', sessionId, transcriptPath, cwd: workspace, stateRoot: nativeRoot });
    expect(() => execFileSync(process.execPath, [reporter], { input: JSON.stringify({ ...payload, hook_event_name: 'SessionEnd' }), env: process.env })).toThrow();
  });

  it.each(['unknown-protocol', 'unknown-record', 'missing-message', 'wrong-agent', 'unknown-loop', 'partial-line'])('rejects %s wire history', (fault) => {
    const { transcriptPath } = nativeFixture();
    const records = readFileSync(transcriptPath, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    if (fault === 'unknown-protocol') records[0]!['protocol_version'] = 'future';
    if (fault === 'unknown-record') records.push({ type: 'future.record', agentId: 'main', time: 10 });
    if (fault === 'missing-message') delete records[2]!['message'];
    if (fault === 'wrong-agent') records[2]!['agentId'] = 'another';
    if (fault === 'unknown-loop') records[3]!['event'] = { type: 'future.loop', uuid: 'step', turnId: '1', step: 1 };
    const text = records.map((row) => JSON.stringify(row)).join('\n') + (fault === 'partial-line' ? '' : '\n');
    expect(parseKimiWire(Buffer.from(text), 'agents/main/wire.jsonl')).toBeNull();
  });

  it.each(['session', 'workspace', 'main-wire', 'missing-subagent', 'unknown-wire-layout'])('rejects ZIP %s mismatch against the exact native snapshot', async (fault) => {
    const { root, transcriptPath, archiveSource, manifest, rebuildArchive, workspace } = nativeFixture();
    if (fault === 'session') writeFileSync(join(archiveSource, 'manifest.json'), JSON.stringify({ ...manifest, sessionId: 'session-other' }));
    if (fault === 'workspace') {
      const other = join(root, 'another-workspace'); mkdirSync(other);
      writeFileSync(join(archiveSource, 'manifest.json'), JSON.stringify({ ...manifest, workspaceDir: other }));
    }
    if (fault === 'main-wire') writeFileSync(join(archiveSource, 'agents', 'main', 'wire.jsonl'), `${JSON.stringify({ type: 'metadata', protocol_version: '1.5', created_at: 1 })}\n`);
    if (fault === 'missing-subagent') unlinkSync(join(archiveSource, 'agents', 'reviewer', 'wire.jsonl'));
    if (fault === 'unknown-wire-layout') {
      mkdirSync(join(archiveSource, 'agents', 'main', 'nested'));
      writeFileSync(join(archiveSource, 'agents', 'main', 'nested', 'wire.jsonl'), readFileSync(transcriptPath));
    }
    rebuildArchive();
    await expect(readKimiTranscriptIdentity({ transcriptRef: transcriptPath, workspace })).resolves.toMatchObject({ kind: 'transcript_unavailable' });
    await expect(inspectKimiTranscript(transcriptPath)).resolves.toMatchObject({ kind: 'transcript_unavailable' });
  });

  it('refuses complete coverage when native history advances during export', async () => {
    const { transcriptPath } = nativeFixture();
    processMocks.onExport = () => appendFileSync(transcriptPath, `${JSON.stringify({ type: 'usage.record', agentId: 'main', time: 10, model: 'native', usage: {} })}\n`);
    await expect(inspectKimiTranscript(transcriptPath)).resolves.toMatchObject({ kind: 'transcript_unavailable' });
  });

  it('does not claim active-history coverage from an identity-only wire', async () => {
    const { transcriptPath, archiveSource, rebuildArchive } = nativeFixture();
    const bytes = `${JSON.stringify({ type: 'metadata', protocol_version: '1.5', created_at: 1 })}\n`;
    writeFileSync(transcriptPath, bytes);
    writeFileSync(join(archiveSource, 'agents', 'main', 'wire.jsonl'), bytes);
    rebuildArchive();
    await expect(inspectKimiTranscript(transcriptPath)).resolves.toMatchObject({ kind: 'transcript_unavailable' });
  });

  it.each([
    { action: 'install', existing: true },
    { action: 'install', existing: false },
    { action: 'uninstall', existing: true },
  ] as const)('refuses $action when native config changes after reading (existing: $existing)', ({ action, existing }) => {
    const root = mkdtempSync(join(tmpdir(), 'ocp-kimi-cas-'));
    tempRoots.push(root);
    const configRoot = join(root, 'kimi'), artifactRoot = join(root, 'reporting');
    mkdirSync(configRoot); mkdirSync(artifactRoot);
    writeFileSync(join(artifactRoot, 'report.mjs'), REPORT_TRAMPOLINE);
    const definition = kimiReportingDefinition({ KIMI_CODE_HOME: configRoot });
    if (existing) writeFileSync(definition.configPath, 'default_model = "native"\n');
    if (action === 'uninstall') maintainKimiReporting('install', definition, artifactRoot);
    const concurrent = 'default_model = "user"\n[providers.native]\ntype = "openai"\n';
    fsMocks.onTemporaryWrite = () => {
      fsMocks.onTemporaryWrite = null;
      writeFileSync(definition.configPath, concurrent);
    };
    expect(() => maintainKimiReporting(action, definition, artifactRoot)).toThrow(expect.objectContaining({ code: 'native_config_changed' }));
    expect(readFileSync(definition.configPath, 'utf8')).toBe(concurrent);
  });

  it('derives the exact session root from the native main-agent wire path', () => {
    const root = mkdtempSync(join(tmpdir(), 'ocp-kimi-layout-'));
    const transcript = kimiMainWirePath(root, '/workspace', 'session_1');
    mkdirSync(dirname(transcript), { recursive: true });
    writeFileSync(transcript, '');
    expect(kimiSessionLocation(transcript)).toEqual({ sessionId: 'session_1', stateRoot: root });
    expect(kimiSessionLocation(join(root, 'sessions', '..', 'other', 'agents', 'main', 'wire.jsonl'))).toBeNull();
    expect(kimiSessionLocation(join(dirname(transcript), '..', 'worker', 'wire.jsonl'))).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  it('describes an additive native SessionStart hook in config.toml', () => {
    const definition = kimiReportingDefinition({ HOME: '/home/test', KIMI_CODE_HOME: '/kimi-home' });
    expect(definition.configPath).toBe(join('/kimi-home', 'config.toml'));
    expect(definition.hook).toMatchObject({ event: 'SessionStart', timeout: 10 });
    expect(kimiReporterHookToml()).toBe(definition.hookToml);
    expect(definition.hookToml).toContain('[[hooks]]');
    expect(definition.hookToml).toContain('event = "SessionStart"');
    expect(definition.hookToml).toContain('command = ');
  });

  it.each(['default', 'hash-in-path'])('installs and removes only its TOML hook table while preserving provider configuration (%s data home)', (dataHome) => {
    const root = mkdtempSync(join(tmpdir(), 'ocp-kimi-setup-'));
    const configRoot = join(root, 'kimi'), artifactRoot = join(root, 'reporting');
    mkdirSync(configRoot); mkdirSync(artifactRoot);
    writeFileSync(join(artifactRoot, 'report.mjs'), REPORT_TRAMPOLINE);
    if (dataHome === 'hash-in-path') process.env['XDG_DATA_HOME'] = join(root, 'data#home');
    const definition = kimiReportingDefinition({ HOME: root, KIMI_CODE_HOME: configRoot });
    const original = '# keep user config\n[models]\ndefault = "native"\n\n[[hooks]]\nevent = "Notification"\ncommand = "notify"\ntimeout = 5\n\n[providers.local]\ntype = "openai"\n';
    writeFileSync(definition.configPath, original, { mode: 0o640 });
    maintainKimiReporting('install', definition, artifactRoot);
    maintainKimiReporting('install', definition, artifactRoot);
    expect(kimiReportingInstalled(definition, artifactRoot)).toBe(true);
    const installed = readFileSync(definition.configPath, 'utf8');
    expect(statSync(definition.configPath).mode & 0o777).toBe(0o640);
    expect(installed).toContain('[providers.local]');
    expect(installed).toContain(definition.hookToml.trim());
    maintainKimiReporting('uninstall', definition, artifactRoot);
    const removed = readFileSync(definition.configPath, 'utf8');
    expect(statSync(definition.configPath).mode & 0o777).toBe(0o640);
    expect(removed).toBe(original);
    expect(kimiReportingInstalled(definition, artifactRoot)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('reads its own hand-written hook table whose command path contains a hash and whose values carry comments', () => {
    const root = mkdtempSync(join(tmpdir(), 'ocp-kimi-handwritten-'));
    const configRoot = join(root, 'kimi'), artifactRoot = join(root, 'reporting');
    mkdirSync(configRoot); mkdirSync(artifactRoot);
    writeFileSync(join(artifactRoot, 'report.mjs'), REPORT_TRAMPOLINE);
    process.env['XDG_DATA_HOME'] = join(root, 'data#home');
    const definition = kimiReportingDefinition({ HOME: root, KIMI_CODE_HOME: configRoot });
    const userTables = '# user file\n[[hooks]]\nevent = "Notification"\ncommand = "notify"\ntimeout = 5  # user note\n\n[providers.local]\ntype = "openai"\n\n';
    const ownTable = `[[hooks]]\n  event = "SessionStart"\n  command = ${JSON.stringify(definition.hook.command)}\n  timeout = 10  # keep native timeout\n`;
    writeFileSync(definition.configPath, userTables + ownTable, { mode: 0o640 });
    expect(kimiReportingInstalled(definition, artifactRoot)).toBe(true);
    maintainKimiReporting('install', definition, artifactRoot);
    expect(readFileSync(definition.configPath, 'utf8')).toBe(userTables + ownTable);
    maintainKimiReporting('uninstall', definition, artifactRoot);
    const removed = readFileSync(definition.configPath, 'utf8');
    expect(removed).toBe(userTables);
    expect(kimiReportingInstalled(definition, artifactRoot)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it.each(['command', 'event'])('refuses a hook table whose %s carries a trailing token instead of a comment', (tampered) => {
    const root = mkdtempSync(join(tmpdir(), 'ocp-kimi-trailing-token-'));
    const configRoot = join(root, 'kimi'), artifactRoot = join(root, 'reporting');
    mkdirSync(configRoot); mkdirSync(artifactRoot);
    writeFileSync(join(artifactRoot, 'report.mjs'), REPORT_TRAMPOLINE);
    const definition = kimiReportingDefinition({ HOME: root, KIMI_CODE_HOME: configRoot });
    const original = [`[[hooks]]`, `event = ${tampered === 'event' ? '"SessionStart" "extra"' : '"SessionStart"'}`,
      `command = ${tampered === 'command' ? `${JSON.stringify(definition.hook.command)} junk` : JSON.stringify(definition.hook.command)}`, 'timeout = 10', ''].join('\n');
    writeFileSync(definition.configPath, original);
    expect(kimiReportingInstalled(definition, artifactRoot)).toBe(false);
    expect(() => maintainKimiReporting('install', definition, artifactRoot)).toThrow();
    expect(() => maintainKimiReporting('uninstall', definition, artifactRoot)).toThrow();
    expect(readFileSync(definition.configPath, 'utf8')).toBe(original);
    rmSync(root, { recursive: true, force: true });
  });

  it('removes only its own table when the native configuration gains further hook tables afterwards', () => {
    const root = mkdtempSync(join(tmpdir(), 'ocp-kimi-trailing-'));
    const configRoot = join(root, 'kimi'), artifactRoot = join(root, 'reporting');
    mkdirSync(configRoot); mkdirSync(artifactRoot);
    writeFileSync(join(artifactRoot, 'report.mjs'), REPORT_TRAMPOLINE);
    const definition = kimiReportingDefinition({ HOME: root, KIMI_CODE_HOME: configRoot });
    writeFileSync(definition.configPath, '[models]\ndefault = "native"\n');
    maintainKimiReporting('install', definition, artifactRoot);
    appendFileSync(definition.configPath, '\n[[hooks]]\nevent = "Stop"\ncommand = "user-stop"\ntimeout = 3\n');
    maintainKimiReporting('uninstall', definition, artifactRoot);
    const removed = readFileSync(definition.configPath, 'utf8');
    expect(removed).not.toContain(definition.hook.command);
    expect(removed).toContain('[models]');
    expect(removed).toContain('command = "user-stop"');
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps install idempotent and uninstall exact when the native hook tables are blank-line separated and indented', () => {
    const root = mkdtempSync(join(tmpdir(), 'ocp-kimi-spaced-'));
    const configRoot = join(root, 'kimi'), artifactRoot = join(root, 'reporting');
    mkdirSync(configRoot); mkdirSync(artifactRoot);
    writeFileSync(join(artifactRoot, 'report.mjs'), REPORT_TRAMPOLINE);
    const definition = kimiReportingDefinition({ HOME: root, KIMI_CODE_HOME: configRoot });
    const original = ['[models]', 'default = "native"', '', '  [[hooks]]  ', '  event = "Notification"', '  command = "notify"', '  timeout = 5', '', '[providers.local]', 'type = "openai"', '', ''].join('\n');
    const ownHooks = (text: string) => text.split(definition.hook.command).length - 1;
    writeFileSync(definition.configPath, original, { mode: 0o640 });
    maintainKimiReporting('install', definition, artifactRoot);
    expect(kimiReportingInstalled(definition, artifactRoot)).toBe(true);
    const installed = readFileSync(definition.configPath, 'utf8');
    expect(ownHooks(installed)).toBe(1);
    maintainKimiReporting('install', definition, artifactRoot);
    expect(readFileSync(definition.configPath, 'utf8')).toBe(installed);
    maintainKimiReporting('uninstall', definition, artifactRoot);
    expect(readFileSync(definition.configPath, 'utf8')).toBe(original);
    expect(kimiReportingInstalled(definition, artifactRoot)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('proves the exact reported Kimi session from ZIP manifest and stable native main/subagent wires', async () => {
    const { workspace, nativeRoot, sessionId, transcriptPath } = nativeFixture();
    const report = { harness: 'kimi', sessionId, transcriptPath, cwd: workspace, observedAt: '2026-10-11T00:00:01.000Z', stateRoot: nativeRoot, runtimeRoots: [nativeRoot] };
    const input = { report, workspace, expectedStateRoot: nativeRoot, dispatchStartedAt: '2026-10-11T00:00:00.000Z', bindingDeadlineAt: '2026-10-11T00:01:00.000Z' };
    const proof = await kimiHarness.proveSession(input);
    expect(proof.kind).toBe('proven');
    if (proof.kind === 'proven') expect(proof.proof).toMatchObject({ providerSessionId: sessionId, transcriptRef: transcriptPath });
    await expect(readKimiTranscriptIdentity({ transcriptRef: transcriptPath, workspace })).resolves.toEqual({ providerSessionId: sessionId });
    await expect(inspectKimiTranscript(transcriptPath)).resolves.toMatchObject({ kind: 'covered', evidence: {
      coverage: 'complete', readableRange: { fromEventRef: 'agents/main/wire.jsonl:1', toEventRef: 'agents/reviewer/wire.jsonl:2' },
      lastCompleteEventRef: 'agents/reviewer/wire.jsonl:2', gaps: [],
    } });
    await expect(kimiHarness.proveSession({ ...input, report: { ...report, cwd: join(nativeRoot, 'other-worktree') } })).resolves.toMatchObject({ kind: 'transcript_unavailable' });
    await expect(kimiHarness.proveSession({ ...input, report: { ...report, sessionId: 'other_session' } })).resolves.toMatchObject({ kind: 'transcript_unavailable' });
  });

  it('resumes the exact Kimi session ID after validating its export manifest and native wires', async () => {
    const { root, workspace, nativeRoot, sessionId, transcriptPath } = nativeFixture();
    const artifactRoot = join(root, 'xdg-data', 'orca-companion', 'worker-reporting');
    mkdirSync(artifactRoot, { recursive: true }); writeFileSync(join(artifactRoot, 'report.mjs'), REPORT_TRAMPOLINE);
    const definition = kimiReportingDefinition();
    maintainKimiReporting('install', definition, artifactRoot);
    const launchId = 'kimi-resume-launch', companionRoot = join(root, 'artifacts');
    const strategy = kimiHarness.prepareResume({ launchId, modelSelection: modelSelectionFixture({ model: 'native/model', effort: null, effortCapability: null, catalogSource: null }),
      sandboxMode: 'workspace-write', stateRoot: companionRoot, sessionId, originalStateRoot: nativeRoot, transcriptRef: transcriptPath });
    const prepared = await strategy.prepare({ worktreePath: workspace });
    const descriptorPath = join(candidateSessionPaths('kimi', companionRoot, launchId).stateRoot, CODEX_MODEL_DESCRIPTOR_FILENAME);
    const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8')) as { readonly args: readonly string[] };
    expect(prepared.stateRoot).toBe(candidateSessionPaths('kimi', companionRoot, launchId).stateRoot);
    expect(descriptor.args).toContain('--session'); expect(descriptor.args).toContain(sessionId);
    await expect(kimiHarness.prepareResume({ launchId, modelSelection: modelSelectionFixture({ model: 'native/model', effort: null, effortCapability: null, catalogSource: null }),
      sandboxMode: 'workspace-write', stateRoot: companionRoot, sessionId, originalStateRoot: nativeRoot,
      transcriptRef: join(nativeRoot, 'sessions', 'other_session', 'agents', 'main', 'wire.jsonl') }).prepare({ worktreePath: workspace })).rejects.toThrow();
  });
});

describe('Kimi configured model aliases', () => {
  const configured = {
    providers: { native: { type: 'kimi', apiKey: 'fixture-secret-key', customHeaders: { Authorization: 'fixture-secret-header' } } },
    models: { alias: { provider: 'native', model: 'upstream-model-id', maxContextSize: 128000 } },
  };
  const completed = (text: string) => ({ kind: 'completed', exitCode: 0, stdout: { text, truncated: false }, stderr: { text: '', truncated: false } });

  it('returns only aliases and bounds the verified providers/models shape', () => {
    expect(parseKimiModelCatalog(JSON.stringify(configured))).toEqual(['alias']);
    expect(parseKimiModelCatalog(JSON.stringify({ models: ['upstream-model-id'] }))).toBeNull();
    expect(parseKimiModelCatalog(JSON.stringify({ ...configured, models: { alias: { provider: 'absent', model: 'model', maxContextSize: 1 } } }))).toBeNull();
    const models = Object.fromEntries(Array.from({ length: 4096 }, (_, index) => [`alias-${index}`, configured.models.alias]));
    expect(parseKimiModelCatalog(JSON.stringify({ ...configured, models }))).toHaveLength(4096);
    expect(parseKimiModelCatalog(JSON.stringify({ ...configured, models: { ...models, extra: configured.models.alias } }))).toBeNull();
  });

  it('uses one cancellable 30-second budget and a version-tagged alias-only result', async () => {
    const { nativeRoot, workspace } = nativeFixture();
    const configPath = join(nativeRoot, 'config.toml'), original = 'default_model = "alias"\n';
    writeFileSync(configPath, original);
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000), controller = new AbortController();
    processMocks.runProcess.mockReset();
    processMocks.runProcess.mockImplementation(({ args }: { readonly args: readonly string[] }) => {
      if (args[0] === '--version') { now.mockReturnValue(13000); return Promise.resolve(completed('2.1.1\n')); }
      return Promise.resolve(completed(JSON.stringify(configured)));
    });
    const result = await kimiHarness.queryModels({ cwd: workspace, signal: controller.signal });
    expect(result).toEqual({ kind: 'available', source: 'kimi:2.1.1:provider-list-json:configured-aliases', models: [{ model: 'alias', effortCapability: null }] });
    expect(processMocks.runProcess.mock.calls[1]![0]).toMatchObject({ args: ['provider', 'list', '--json'], timeoutMs: 18000, signal: controller.signal,
      limits: { maxBytes: 1024 * 1024, maxLines: 20000 } });
    expect(readFileSync(configPath, 'utf8')).toBe(original);
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
    expect(JSON.stringify(result)).not.toContain('upstream-model-id');
  });

  it('refuses an absent config before the native command can create it', async () => {
    const { workspace } = nativeFixture();
    await expect(kimiHarness.queryModels({ cwd: workspace })).resolves.toMatchObject({ kind: 'unavailable' });
    expect(processMocks.runProcess).not.toHaveBeenCalled();
  });

  it('cancels between version and configuration query without exposing diagnostics', async () => {
    const { nativeRoot, workspace } = nativeFixture();
    writeFileSync(join(nativeRoot, 'config.toml'), 'default_model = "alias"\n');
    const controller = new AbortController();
    processMocks.runProcess.mockImplementation(() => { controller.abort(); return Promise.resolve(completed('2.1.1')); });
    await expect(kimiHarness.queryModels({ cwd: workspace, signal: controller.signal })).resolves.toMatchObject({ kind: 'unavailable', code: 'catalog_cancelled' });
    expect(processMocks.runProcess).toHaveBeenCalledTimes(1);
  });

  it.each(['throw', 'truncated', 'malformed'])('does not expose raw secret-bearing %s output', async (fault) => {
    const { nativeRoot, workspace } = nativeFixture();
    writeFileSync(join(nativeRoot, 'config.toml'), 'default_model = "alias"\n');
    processMocks.runProcess.mockReset();
    processMocks.runProcess.mockResolvedValueOnce(completed('2.1.1'));
    if (fault === 'throw') processMocks.runProcess.mockRejectedValueOnce(new Error('fixture-secret-key'));
    else processMocks.runProcess.mockResolvedValueOnce({ ...completed('fixture-secret-key'), stdout: { text: 'fixture-secret-key', truncated: fault === 'truncated' } });
    const result = await kimiHarness.queryModels({ cwd: workspace });
    expect(result.kind).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
  });
});
