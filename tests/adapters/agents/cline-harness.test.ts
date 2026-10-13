import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { clineHarness, clineRecoveryMaterialPath, clineReporterPluginSource, clineReportingDefinition, inspectClineTranscript, maintainClineReporting, prepareClineRecoveryMaterial, readClineTranscriptIdentity } from '../../../src/adapters/agents/cline-harness.js';
import { REPORT_TRAMPOLINE, reportingRoot } from '../../../src/adapters/agents/worker-harness-reporting.js';
import { CODEX_MODEL_DESCRIPTOR_FILENAME } from '../../../src/adapters/agents/codex-model-launcher.js';
import { modelSelectionFixture } from '../../support/model-configurations.js';

const sessionId = 'cline-session-0000000000000001';

describe('Cline native reporting and transcript identity', () => {
  test('launch selects an explicit provider separately from its model without changing native defaults', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ocp-cline-launch-'));
    const previous = { CLINE_DIR: process.env['CLINE_DIR'], XDG_DATA_HOME: process.env['XDG_DATA_HOME'] };
    process.env['CLINE_DIR'] = join(root, 'cline'); process.env['XDG_DATA_HOME'] = join(root, 'data');
    try {
      mkdirSync(reportingRoot(), { recursive: true });
      writeFileSync(join(reportingRoot(), 'report.mjs'), REPORT_TRAMPOLINE);
      maintainClineReporting('install');
      const strategy = clineHarness.prepareLaunch({ launchId: 'explicit-provider', stateRoot: join(root, 'artifacts'),
        modelSelection: modelSelectionFixture({ model: 'minimax-cn-coding-plan/MiniMax-M3.1-Flash-Preview', effort: null, effortCapability: null, catalogSource: null }),
        sandboxMode: 'workspace-write' });
      expect(strategy.activation).toBe('none');
      const prepared = await strategy.prepare({ worktreePath: root });
      const descriptor = JSON.parse(readFileSync(join(prepared.stateRoot, CODEX_MODEL_DESCRIPTOR_FILENAME), 'utf8')) as { args: string[] };
      expect(descriptor.args).toEqual(['--tui', '--yolo', '--cwd', root, '--provider', 'minimax-cn-coding-plan', '--model', 'MiniMax-M3.1-Flash-Preview']);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
  test('plugin uses the discovered global JS module path and host-owned setup context', async () => {
    const definition = clineReportingDefinition({ CLINE_DIR: '/tmp/cline-home' });
    expect(definition.modulePath).toBe('/tmp/cline-home/plugins/orca-companion-session-report/index.js');
    expect(definition.source).toBe(clineReporterPluginSource());
    expect(definition.source).toContain('context.session?.sessionId');
    expect(definition.source).toContain('context.workspaceInfo?.rootPath');
    expect(definition.source).toContain('ORCA_COMPANION_SESSION_REPORTER');
    expect(definition.source).not.toContain('--hooks-dir');
    const pluginModule = await import('data:text/javascript;base64,' + Buffer.from(definition.source).toString('base64')) as {
      default: { manifest: { capabilities: string[] }; setup: (api: unknown, context: unknown) => void };
    };
    expect(pluginModule.default.manifest.capabilities).toEqual(['hooks']);
    expect(() => pluginModule.default.setup({}, {})).not.toThrow();
  });

  test('exact session manifest binds transcript and workspace; messages are read from its native path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ocp-cline-session-'));
    const dataDir = join(root, 'data'), sessionDir = join(dataDir, 'sessions'), sessionArtifactsDir = join(sessionDir, sessionId);
    const workspace = join(root, 'workspace');
    mkdirSync(sessionArtifactsDir, { recursive: true }); mkdirSync(workspace);
    const messagesPath = join(sessionArtifactsDir, `${sessionId}.messages.json`);
    writeFileSync(messagesPath, JSON.stringify({ version: 1, updated_at: '2026-10-11T00:00:00Z', agent: 'lead', sessionId,
      origin: { source: 'cli', mode: 'user', sessionId }, messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'world' }] }));
    writeFileSync(join(sessionArtifactsDir, `${sessionId}.json`), JSON.stringify({ version: 1, session_id: sessionId, source: 'cli', pid: 1,
      started_at: '2026-10-11T00:00:00Z', status: 'completed', interactive: true, provider: 'cline', model: 'model-id',
      cwd: workspace, workspace_root: workspace, enable_tools: true, enable_spawn: false, enable_teams: false, messages_path: messagesPath }));
    const oldData = process.env['CLINE_DATA_DIR'], oldSession = process.env['CLINE_SESSION_DATA_DIR'];
    process.env['CLINE_DATA_DIR'] = dataDir; delete process.env['CLINE_SESSION_DATA_DIR'];
    try {
      expect(await readClineTranscriptIdentity(`cline-session:${sessionId}`, workspace)).toEqual({ providerSessionId: sessionId });
      const inspected = await inspectClineTranscript(`cline-session:${sessionId}`);
      expect(inspected).toMatchObject({ kind: 'covered', evidence: { coverage: 'partial' } });
      if (inspected.kind !== 'covered') throw new Error('expected Cline coverage');
      const materialRoot = join(root, 'utility-state');
      const instructions = prepareClineRecoveryMaterial(`cline-session:${sessionId}`, materialRoot, inspected.evidence);
      expect(instructions?.[2]).toContain('material JSONL');
      expect(readFileSync(clineRecoveryMaterialPath(materialRoot, `cline-session:${sessionId}`), 'utf8').trim().split('\n')).toHaveLength(2);
      expect(prepareClineRecoveryMaterial(`cline-session:${sessionId}`, materialRoot, { ...inspected.evidence, coverage: 'complete' })).toBeNull();
      const mismatch = await readClineTranscriptIdentity(`cline-session:${sessionId}`, root);
      expect('kind' in mismatch && mismatch.kind).toBe('transcript_unavailable');
    } finally {
      if (oldData === undefined) delete process.env['CLINE_DATA_DIR']; else process.env['CLINE_DATA_DIR'] = oldData;
      if (oldSession === undefined) delete process.env['CLINE_SESSION_DATA_DIR']; else process.env['CLINE_SESSION_DATA_DIR'] = oldSession;
    }
  });

  test('does not accept a transcript reference with a different native session ID', async () => {
    expect((await inspectClineTranscript('cline-session-other-session-id')).kind).toBe('transcript_unavailable');
  });

  test('install and uninstall own only the Cline module file', () => {
    const root = mkdtempSync(join(tmpdir(), 'ocp-cline-maintain-'));
    const moduleDir = join(root, 'plugins', 'orca-companion-session-report');
    const definition = { modulePath: join(moduleDir, 'index.js'), source: clineReporterPluginSource() };
    maintainClineReporting('install', definition);
    writeFileSync(join(moduleDir, 'user-file.txt'), 'keep');
    maintainClineReporting('install', definition);
    expect(readFileSync(definition.modulePath, 'utf8')).toBe(definition.source);
    maintainClineReporting('uninstall', definition);
    expect(existsSync(definition.modulePath)).toBe(false);
    expect(readFileSync(join(moduleDir, 'user-file.txt'), 'utf8')).toBe('keep');
  });
});
