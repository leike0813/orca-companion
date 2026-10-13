import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  museHarness,
  assertMuseSnapshot,
  maintainMuseReporting,
  museReportingDefinition,
  museTranscriptCandidates,
  parseMuseTranscript,
  unwrapMuseRecords,
} from '../../../src/adapters/agents/muse-harness.js';
import { readReportingJson } from '../../../src/adapters/agents/worker-harness-reporting.js';

const SESSION_ID = '0199f8a0-1234-7abc-8def-0123456789ab';

describe('Muse native session format', () => {
  it('derives only the UUIDv7 date shards for the exact session id', () => {
    const candidates = museTranscriptCandidates(SESSION_ID, '/native/sessions');
    expect(candidates.length).toBeGreaterThanOrEqual(3);
    expect(candidates.every((path) => path.endsWith(`/${SESSION_ID}/session.jsonl`))).toBe(true);
    expect(museTranscriptCandidates('session-nearby', '/native/sessions')).toEqual([]);
  });

  it('unwraps retained records and reads Muse workspace and activity fields', () => {
    const rows = [
      { record_type: 'snapshot', payload_type: 'runtime.session.metadata', payload: { record: { workspace_root: '/workspace' } } },
      { record_type: 'event', payload_type: 'run.model.configured', payload: { record: { model_id: 'native-model' } } },
      { record_type: 'event', payload_type: 'session.workspace_branch.observed', payload: { record: { reference: { name: 'main' } } } },
      { record_type: 'retained_frame', frame_schema_version: 1, children: [
        { record_json: JSON.stringify({ record_type: 'event', payload_type: 'runtime.user_intent.accepted', payload: {} }) },
        { record_json: JSON.stringify({ record_type: 'event', payload_type: 'runtime.session', payload: { event: { kind: 'assistant_message_committed' } } }) },
      ] },
    ];
    expect(unwrapMuseRecords(rows[3]!)).toHaveLength(2);
    const parsed = parseMuseTranscript(rows.map((row) => JSON.stringify(row)).join('\n'), SESSION_ID);
    expect(parsed).toMatchObject({ workspace: '/workspace', userEvents: [3], assistantEvents: [4] });
    const consistentWorkspace = [...rows,
      { record_type: 'snapshot', payload_type: 'runtime.session.route_facts', payload: { record: { cwd: '/workspace/.' } } },
      { record_type: 'event', payload_type: 'runtime.model_reconfigure.completed', payload: { record: { effective: { model_id: 'native-model' } } } },
    ];
    expect(parseMuseTranscript(consistentWorkspace.map((row) => JSON.stringify(row)).join('\n'), SESSION_ID))
      .toMatchObject({ workspace: '/workspace' });
    expect(parseMuseTranscript('{ broken', SESSION_ID)).toBeNull();
    expect(parseMuseTranscript(JSON.stringify({ retained_frame: true, children: [{ record_json: '{ broken' }] }), SESSION_ID)).toBeNull();
    expect(parseMuseTranscript(JSON.stringify({ retained_frame: true, children: [{ record_json: '{}' }, { nope: true }] }), SESSION_ID)).toBeNull();
    expect(parseMuseTranscript(JSON.stringify({ retained_marker: 'unknown_marker' }), SESSION_ID)).toBeNull();
    expect(parseMuseTranscript(JSON.stringify({ retained_marker: 'omitted_live_only', schema_version: 1, stream: { kind: 'session', id: 's' } }), SESSION_ID)).not.toBeNull();
  });

  it('rejects effort until Muse exposes a trusted capability', () => {
    expect(() => museHarness.prepareLaunch({ launchId: 'launch', modelSelection: { model: 'muse-model', effort: 'high', effortCapability: null, catalogSource: null }, sandboxMode: 'workspace-write' })).toThrow();
  });

  it.each([
    {},
    { record_type: 'event', payload_type: 'unknown', payload: {} },
    { record_type: 'event', payload_type: 'runtime.session', payload: {} },
    { record_type: 'snapshot', payload_type: 'runtime.session.metadata', payload: { record: { workspace_root: '/other' } } },
    { record_type: 'snapshot', payload_type: 'runtime.session.route_facts', payload: { record: { cwd: '/other' } } },
  ])('rejects unprovable retained history before identity or coverage admission (%j)', (invalid) => {
    const records = [
      { record_type: 'snapshot', payload_type: 'runtime.session.metadata', payload: { record: { workspace_root: '/workspace' } } },
      { record_type: 'event', payload_type: 'runtime.user_intent.accepted', payload: {} },
      invalid,
      { record_type: 'event', payload_type: 'runtime.session', payload: { event: { kind: 'assistant_message_committed' } } },
    ];
    expect(parseMuseTranscript(records.map((row) => JSON.stringify(row)).join('\n'), SESSION_ID)).toBeNull();
  });

  it('describes Muse’s native managed-hooks file and environment allowlist', () => {
    const definition = museReportingDefinition({ HOME: '/home/test', XDG_CONFIG_HOME: '/config', XDG_DATA_HOME: '/data' });
    expect(definition.configPath).toBe('/config/muse/settings.json');
    expect(definition.managedHooksPath).toBe(join('/data', 'orca-companion', 'worker-reporting', 'muse-hooks.json'));
    expect(definition.managedHooksEnvVars).toContain('ORCA_COMPANION_SESSION_REPORTER');
    expect(definition.hooksFile).toHaveProperty('hooks.SessionStart.0.hooks.0.type', 'command');
  });

  it('installs and removes its managed hook while preserving other settings and events', () => {
    const root = mkdtempSync(join(tmpdir(), 'ocp-muse-reporting-'));
    try {
      const env = { HOME: root, XDG_DATA_HOME: join(root, 'data'), XDG_CONFIG_HOME: join(root, 'config') };
      const definition = museReportingDefinition(env);
      mkdirSync(join(root, 'config', 'muse'), { recursive: true });
      mkdirSync(join(root, 'data', 'orca-companion', 'worker-reporting'), { recursive: true });
      writeFileSync(definition.configPath, JSON.stringify({ model: 'user-model', managed_hooks_env_vars: ['USER_HOOK_ENV'] }));
      writeFileSync(definition.managedHooksPath, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-stop' }] }] } }));

      maintainMuseReporting('install', env);
      const installedSettings = readReportingJson(definition.configPath);
      const installedHooks = readReportingJson(definition.managedHooksPath);
      expect(installedSettings['model']).toBe('user-model');
      expect(installedSettings['managed_hooks_env_vars']).toEqual(['USER_HOOK_ENV', 'ORCA_COMPANION_SESSION_REPORTER']);
      expect((installedHooks['hooks'] as Record<string, unknown>)['Stop']).toEqual([{ hooks: [{ type: 'command', command: 'user-stop' }] }]);
      expect((installedHooks['hooks'] as Record<string, unknown>)['SessionStart']).toEqual([definition.hookEntry]);

      maintainMuseReporting('uninstall', env);
      const removedSettings = readReportingJson(definition.configPath);
      const removedHooks = readReportingJson(definition.managedHooksPath);
      expect(removedSettings['model']).toBe('user-model');
      expect(removedSettings['managed_hooks_env_vars']).toEqual(['USER_HOOK_ENV']);
      // Muse must keep pointing at this file while the user's Stop hook remains.
      expect(removedSettings['managed_hooks_path']).toBe(definition.managedHooksPath);
      expect((removedHooks['hooks'] as Record<string, unknown>)['Stop']).toEqual([{ hooks: [{ type: 'command', command: 'user-stop' }] }]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('removes its reporter environment allowlist entry when no user hook remains', () => {
    const root = mkdtempSync(join(tmpdir(), 'ocp-muse-reporting-env-'));
    try {
      const env = { HOME: root, XDG_DATA_HOME: join(root, 'data'), XDG_CONFIG_HOME: join(root, 'config') };
      const definition = museReportingDefinition(env);
      mkdirSync(join(root, 'config', 'muse'), { recursive: true });
      mkdirSync(join(root, 'data', 'orca-companion', 'worker-reporting'), { recursive: true });
      writeFileSync(definition.configPath, JSON.stringify({ managed_hooks_env_vars: ['ORCA_COMPANION_SESSION_REPORTER'] }));

      maintainMuseReporting('install', env);
      maintainMuseReporting('uninstall', env);

      const settings = readReportingJson(definition.configPath);
      expect(settings['managed_hooks_env_vars']).toBeUndefined();
      expect(settings['managed_hooks_path']).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses to replace a different managed hooks path', () => {
    const root = mkdtempSync(join(tmpdir(), 'ocp-muse-reporting-conflict-'));
    try {
      const env = { HOME: root, XDG_DATA_HOME: join(root, 'data'), XDG_CONFIG_HOME: join(root, 'config') };
      const definition = museReportingDefinition(env);
      mkdirSync(join(root, 'config', 'muse'), { recursive: true });
      const original = JSON.stringify({ managed_hooks_path: '/user/managed-hooks.json', model: 'user-model' });
      writeFileSync(definition.configPath, original);
      expect(() => maintainMuseReporting('install', env)).toThrow();
      expect(readFileSync(definition.configPath, 'utf8')).toBe(original);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('preserves a concurrent native edit detected before installation rename', () => {
    const root = mkdtempSync(join(tmpdir(), 'ocp-muse-reporting-cas-'));
    try {
      const env = { HOME: root, XDG_DATA_HOME: join(root, 'data'), XDG_CONFIG_HOME: join(root, 'config') };
      const definition = museReportingDefinition(env);
      mkdirSync(join(root, 'config', 'muse'), { recursive: true });
      mkdirSync(join(root, 'data', 'orca-companion', 'worker-reporting'), { recursive: true });
      const original = JSON.stringify({ model: 'original' });
      const concurrent = JSON.stringify({ model: 'native-edit' });
      writeFileSync(definition.configPath, concurrent);
      expect(() => assertMuseSnapshot(definition.configPath, original)).toThrow();
      expect(readFileSync(definition.configPath, 'utf8')).toBe(concurrent);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
