import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { hermesHarness, hermesReporterSource, hermesReportingDefinition, hermesReportingInstalled, maintainHermesReporting, prepareHermesRecoveryMaterial, validateHermesExportedSession } from '../../../src/adapters/agents/hermes-harness.js';
import { REPORT_TRAMPOLINE } from '../../../src/adapters/agents/worker-harness-reporting.js';

const { runProcessMock } = vi.hoisted(() => ({ runProcessMock: vi.fn() }));
vi.mock('../../../src/adapters/orca-cli/process-runner.js', () => ({ runProcess: runProcessMock }));

describe('Hermes classic interactive launch', () => {
  afterEach(() => { vi.unstubAllEnvs(); runProcessMock.mockReset(); });

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'ocp-hermes-launch-'));
    const workspace = join(root, 'workspace'), native = join(root, 'native'), bin = join(root, 'bin');
    for (const path of [workspace, native, bin]) mkdirSync(path);
    vi.stubEnv('HERMES_HOME', native);
    vi.stubEnv('XDG_DATA_HOME', join(root, 'data'));
    const trampoline = join(root, 'data', 'orca-companion', 'worker-reporting', 'report.mjs');
    mkdirSync(join(root, 'data', 'orca-companion', 'worker-reporting'), { recursive: true });
    writeFileSync(trampoline, REPORT_TRAMPOLINE);
    const definition = hermesReportingDefinition();
    const config = `display:\n  interface: tui\nterminal:\n  backend: local\n  cwd: /native-config/elsewhere\nhooks:\n  pre_llm_call:\n    - command: ${JSON.stringify(definition.command)}\n`;
    writeFileSync(definition.configPath, config);
    writeFileSync(join(native, 'shell-hooks-allowlist.json'), JSON.stringify({ approvals: [{ event: definition.event, command: definition.command }] }));
    const sessionId = '20261011_103000_abcdef12';
    const input = { launchId: 'classic-launch', sandboxMode: 'workspace-write' as const, stateRoot: join(root, 'artifacts'),
      modelSelection: { model: 'fixture/model', effort: null, effortCapability: null, catalogSource: null } };
    return { root, workspace, native, bin, trampoline, config, definition, sessionId, input };
  }

  test.each([false, true])('launch and exact resume use the public classic frontend while preserving native environment (resume=%s)', async (resume) => {
    const f = fixture();
    runProcessMock.mockResolvedValue({ kind: 'completed', exitCode: 0, stdout: { text: JSON.stringify({ id: f.sessionId, cwd: f.workspace,
      parent_session_id: null, end_reason: null, message_count: 1, rewind_count: 0, archived: 0, model_config: '{}',
      messages: [{ id: 10, active: 1, compacted: 0, role: 'user' }] }), truncated: false }, stderr: { text: '', truncated: false } });
    // Public frontend stand-in: exercise the real foreground launcher and stdin forwarding,
    // without starting Hermes, reading its real config, or making a model request.
    writeFileSync(join(f.bin, 'hermes'), `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const hook = spawnSync(process.execPath, [process.env.OCP_TEST_TRAMPOLINE], {
  input: JSON.stringify({ hook_event_name: 'pre_llm_call', session_id: ${JSON.stringify(f.sessionId)}, cwd: process.cwd() }), env: process.env
});
if (hook.status !== 0) process.exit(2);
process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(),
  sameHome: process.env.HOME === process.env.OCP_TEST_HOME, native: process.env.HERMES_HOME,
  authInherited: process.env.MINIMAX_API_KEY === 'fixture-only', tuiPreference: process.env.HERMES_TUI }));
`, { mode: 0o700 });
    const strategy = resume ? hermesHarness.prepareResume({ ...f.input, sessionId: f.sessionId, originalStateRoot: f.native,
      transcriptRef: `hermes-session:${f.sessionId}` }) : hermesHarness.prepareLaunch(f.input);
    const launch = await strategy.prepare({ worktreePath: f.workspace });
    const child = spawnSync('/bin/sh', ['-c', launch.command], { cwd: f.workspace, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, PATH: `${f.bin}:${process.env['PATH'] ?? ''}`, HERMES_TUI: '1', MINIMAX_API_KEY: 'fixture-only',
        OCP_TEST_TRAMPOLINE: f.trampoline, OCP_TEST_HOME: process.env['HOME'] } });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ args: ['--cli', '--model', 'fixture/model', ...(resume ? ['--resume', f.sessionId] : [])],
      cwd: f.workspace, sameHome: true, native: f.native, authInherited: true, tuiPreference: '1' });
    expect(JSON.parse(readFileSync(join(launch.stateRoot, 'session-start.jsonl'), 'utf8'))).toMatchObject({
      harness: 'hermes', sessionId: f.sessionId, cwd: f.workspace, stateRoot: f.native, runtimeRoots: [f.native],
    });
    expect(readFileSync(f.definition.configPath, 'utf8')).toBe(f.config);
    if (resume) expect(runProcessMock).toHaveBeenCalledWith(expect.objectContaining({
      executable: 'hermes', args: ['sessions', 'export', '--session-id', f.sessionId, '-'],
    }));
  });

  test('resume refuses a public export from a different launch workspace', async () => {
    const f = fixture();
    runProcessMock.mockResolvedValue({ kind: 'completed', exitCode: 0, stdout: { text: JSON.stringify({ id: f.sessionId, cwd: f.native,
      parent_session_id: null, end_reason: null, message_count: 1, rewind_count: 0, archived: 0, model_config: '{}',
      messages: [{ id: 10, active: 1, compacted: 0, role: 'user' }] }), truncated: false }, stderr: { text: '', truncated: false } });
    const strategy = hermesHarness.prepareResume({ ...f.input, sessionId: f.sessionId, originalStateRoot: f.native,
      transcriptRef: `hermes-session:${f.sessionId}` });
    await expect(strategy.prepare({ worktreePath: f.workspace })).rejects.toThrow(/Session/u);
  });
});

describe('Hermes native reporting', () => {
  test('uses the native shell-hook configuration location and event', () => {
    const definition = hermesReportingDefinition({ HERMES_HOME: '/tmp/hermes-home' });
    expect(definition.configPath).toBe('/tmp/hermes-home/config.yaml');
    expect(definition.event).toBe('pre_llm_call');
    expect(typeof definition.command).toBe('string');
  });

  test('presence check requires the exact YAML hook and the installed forwarding trampoline', () => {
    const root = join(tmpdir(), `ocp-hermes-hook-${process.pid}`);
    const definition = hermesReportingDefinition({ HERMES_HOME: root });
    const command = definition.command;
    const oldXdg = process.env['XDG_DATA_HOME'];
    process.env['XDG_DATA_HOME'] = root;
    const artifact = join(root, 'orca-companion', 'worker-reporting');
    mkdirSync(artifact, { recursive: true });
    writeFileSync(join(artifact, 'report.mjs'), REPORT_TRAMPOLINE);
    writeFileSync(join(root, 'shell-hooks-allowlist.json'), JSON.stringify({ approvals: [{ event: 'pre_llm_call', command }] }));
    writeFileSync(join(root, 'config.yaml'), `hooks:\n  pre_llm_call:\n    - command: '${command}'\n`);
    try {
      expect(hermesReportingInstalled(definition)).toBe(true);
      writeFileSync(join(root, 'config.yaml'), `hooks:\n  pre_llm_call:\n    - command: 'other'\n`);
      expect(hermesReportingInstalled(definition)).toBe(false);
      writeFileSync(join(root, 'config.yaml'), `hooks:\n  pre_llm_call:\n    - command: 'other'\n  on_session_end:\n    - command: '${command}'\n`);
      expect(hermesReportingInstalled(definition)).toBe(false);
    } finally {
      if (oldXdg === undefined) delete process.env['XDG_DATA_HOME']; else process.env['XDG_DATA_HOME'] = oldXdg;
    }
  });

  test('per-launch reporter emits only native identity and runtime roots', () => {
    const root = mkdtempSync(join(tmpdir(), 'ocp-hermes-report-'));
    const reportPath = join(root, 'report.jsonl'), runtimePath = join(root, 'runtime.json'), reporter = join(root, 'reporter.mjs');
    const sessionId = '20261011_103000_abcdef12';
    writeFileSync(runtimePath, JSON.stringify({ stateRoot: join(root, 'native'), writableRoots: [join(root, 'native')], api_key: 'secret' }));
    writeFileSync(reporter, hermesReporterSource(reportPath, runtimePath));
    const result = spawnSync(process.execPath, [reporter], { input: JSON.stringify({ hook_event_name: 'pre_llm_call', session_id: sessionId, cwd: root, token: 'secret' }) });
    expect(result.status).toBe(0);
    const report = readFileSync(reportPath, 'utf8');
    expect(report).not.toContain('secret');
    expect(JSON.parse(report)).toMatchObject({ harness: 'hermes', sessionId, cwd: root, transcriptPath: `hermes-session:${sessionId}` });
  });

  test('shared trampoline remains the single global stdin forwarding implementation', () => {
    expect(REPORT_TRAMPOLINE).toContain('ORCA_COMPANION_SESSION_REPORTER');
  });

  test('install and uninstall preserve unrelated native hook entries and approvals', () => {
    const root = mkdtempSync(join(tmpdir(), 'ocp-hermes-maintain-'));
    const definition = { ...hermesReportingDefinition({ HERMES_HOME: root }), command: "'/usr/bin/node' '/tmp/orca-report.mjs'" };
    const config = join(root, 'config.yaml'), allowlist = join(root, 'shell-hooks-allowlist.json');
    writeFileSync(config, 'model:\n  default: test-model\nhooks:\n  on_session_end:\n    - command: keep-me\n');
    writeFileSync(allowlist, JSON.stringify({ approvals: [{ event: 'post_api_request', command: 'other', source: 'user' }] }));
    maintainHermesReporting('install', definition);
    const installedConfig = readFileSync(config, 'utf8');
    expect(installedConfig).toContain('on_session_end:');
    expect(installedConfig).toContain('command: keep-me');
    expect(installedConfig).toContain('pre_llm_call:');
    expect(installedConfig).toContain('# orca-companion-managed');
    expect(JSON.parse(readFileSync(allowlist, 'utf8'))).toMatchObject({ approvals: [
      { event: 'post_api_request', command: 'other', source: 'user' },
      { event: 'pre_llm_call', command: definition.command, source: 'orca-companion' },
    ] });
    maintainHermesReporting('uninstall', definition);
    const removedConfig = readFileSync(config, 'utf8');
    expect(removedConfig).toContain('on_session_end:');
    expect(removedConfig).toContain('command: keep-me');
    expect(removedConfig).not.toContain('# orca-companion-managed');
    expect(JSON.parse(readFileSync(allowlist, 'utf8'))).toEqual({ approvals: [
      { event: 'post_api_request', command: 'other', source: 'user' },
    ] });
  });
});

describe('Hermes public export identity and active transcript', () => {
  const messages = [
    { id: 10, active: 1, compacted: 0, role: 'user' },
    { id: 11, active: 1, compacted: 0, role: 'assistant' },
  ];

  test('requires the exact session, independent cwd, ordered active rows, and matching active count', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ocp-hermes-workspace-'));
    const base = {
      id: '20261011_103000_abcdef12', cwd: workspace, parent_session_id: null,
      end_reason: null, message_count: 2, rewind_count: 0, archived: 0, model_config: '{}',
      messages,
    };
    expect(validateHermesExportedSession(base, base.id, workspace)).toBe(true);
    expect(validateHermesExportedSession({ ...base, id: 'other-session-000000' }, base.id, workspace)).toBe(false);
    expect(validateHermesExportedSession({ ...base, cwd: '/tmp/elsewhere' }, base.id, workspace)).toBe(false);
    expect(validateHermesExportedSession({ ...base, message_count: 3 }, base.id, workspace)).toBe(false);
  });

  test.each([
    { rewind_count: 1 },
    { parent_session_id: 'parent-session-00001' },
    { end_reason: 'compression' },
    { model_config: JSON.stringify({ _branched_from: 'parent-session-00001' }) },
    { messages: [{ id: 10, active: 0, compacted: 1, role: 'user' }, messages[1]] },
    { messages: [{ id: 10, active: 1, compacted: 1, role: 'user' }, messages[1]] },
    { messages: [messages[1], messages[0]] },
  ])('rejects export metadata/history boundary %#', (change) => {
    const workspace = mkdtempSync(join(tmpdir(), 'ocp-hermes-workspace-'));
    const base = { id: '20261011_103000_abcdef12', cwd: workspace, parent_session_id: null, end_reason: null,
      message_count: 2, rewind_count: 0, archived: 0, model_config: '{}', messages };
    expect(validateHermesExportedSession({ ...base, ...change }, base.id, workspace)).toBe(false);
  });

  test('recovery material is written only when fresh public export exactly matches inspected coverage', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ocp-hermes-recovery-workspace-'));
    const sessionId = '20261011_103000_abcdef12';
    const session = { id: sessionId, cwd: workspace, parent_session_id: null, end_reason: null, message_count: 2,
      rewind_count: 0, archived: 0, model_config: '{}', messages: [
        { ...messages[0], content: 'hello' }, { ...messages[1], content: 'world' },
      ] };
    runProcessMock.mockResolvedValue({ kind: 'completed', exitCode: 0, stdout: { text: JSON.stringify(session), truncated: false }, stderr: { text: '', truncated: false } });
    const evidence = { coverage: 'partial' as const, readableRange: { transcriptRef: `hermes-session:${sessionId}`, fromEventRef: 'message:10', toEventRef: 'message:11' },
      gaps: [{ fromEventRef: 'message:0', toEventRef: 'message:10', reason: 'Hermes public export omits inactive rows, including compacted history; its earlier boundary is not exposed' }], lastCompleteEventRef: 'message:11' };
    const root = mkdtempSync(join(tmpdir(), 'ocp-hermes-recovery-'));
    expect(await hermesHarness.inspectTranscript(`hermes-session:${sessionId}`)).toMatchObject({ kind: 'covered', evidence });
    const instructions = await prepareHermesRecoveryMaterial(`hermes-session:${sessionId}`, root, evidence);
    expect(instructions?.[2]).toContain('material JSONL');
    const changedEvidence = { ...evidence, coverage: 'complete' as const };
    expect(await prepareHermesRecoveryMaterial(`hermes-session:${sessionId}`, root, changedEvidence)).toBeNull();
  });
});
