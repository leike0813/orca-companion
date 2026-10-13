import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cursorArguments,
  cursorHarness,
  assertCursorSnapshot,
  cursorConfigRoot,
  cursorReportingDefinition,
  cursorTranscriptId,
  cursorTranscriptWorkspaceMatches,
  readCursorTranscriptIdentity,
  maintainCursorReporting,
  parseCursorModelCatalog,
  parseCursorTranscript,
} from '../../../src/adapters/agents/cursor-harness.js';
import { readReportingJson } from '../../../src/adapters/agents/worker-harness-reporting.js';

const { runProcessMock } = vi.hoisted(() => ({ runProcessMock: vi.fn() }));
vi.mock('../../../src/adapters/orca-cli/process-runner.js', () => ({ runProcess: runProcessMock }));

describe('Cursor native session format', () => {
  it('resolves the official config override and Cursor transcript ID layout', () => {
    expect(cursorConfigRoot({ CURSOR_CONFIG_DIR: '/custom/cursor' })).toBe('/custom/cursor');
    const root = '/home/test/.cursor';
    const path = join(root, 'projects', 'workspace-slug', 'agent-transcripts', 'chat-123', 'chat-123.jsonl');
    expect(cursorTranscriptId(path, root)).toBe('chat-123');
    expect(cursorTranscriptId(path.replace('chat-123.jsonl', 'other.jsonl'), root)).toBeNull();
    expect(cursorTranscriptId('/tmp/chat-123.jsonl', root)).toBeNull();
  });

  it('parses native JSONL messages and rejects malformed rows', () => {
    const parsed = parseCursorTranscript([
      JSON.stringify({ role: 'user', message: { content: 'inspect this' } }),
      JSON.stringify({ role: 'assistant', message: { content: 'done' } }),
    ].join('\n'));
    expect(parsed?.messages).toEqual([0, 1]);
    expect(parseCursorTranscript('{ malformed')).toBeNull();
    expect(parseCursorTranscript(JSON.stringify({ role: 'system', content: 'not a conversation turn' }))).toBeNull();
    expect(parseCursorTranscript(`${JSON.stringify({ role: 'user', content: 'hello' })}\n${JSON.stringify({ role: 'tool', content: 'ignored by old parser' })}`)).toBeNull();
    expect(parseCursorTranscript(JSON.stringify({ role: 'assistant' }))).toBeNull();
  });

  it('requires Cursor chat metadata to bind transcript ID to the reported workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'ocp-cursor-native-meta-'));
    const workspace = mkdtempSync(join(tmpdir(), 'ocp-cursor-workspace-'));
    const otherWorkspace = mkdtempSync(join(tmpdir(), 'ocp-cursor-other-workspace-'));
    try {
      const sessionId = 'chat-123';
      const transcript = join(root, 'projects', 'project-slug', 'agent-transcripts', sessionId, `${sessionId}.jsonl`);
      const meta = join(root, 'chats', 'workspace-hash', sessionId, 'meta.json');
      mkdirSync(join(transcript, '..'), { recursive: true });
      mkdirSync(join(meta, '..'), { recursive: true });
      writeFileSync(transcript, `${JSON.stringify({ role: 'user', content: 'hello' })}\n`);
      writeFileSync(meta, JSON.stringify({ cwd: workspace }));
      expect(cursorTranscriptWorkspaceMatches(transcript, workspace, root)).toBe(true);
      expect(cursorTranscriptWorkspaceMatches(transcript, otherWorkspace, root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
      rmSync(otherWorkspace, { recursive: true, force: true });
    }
  });

  it('does not treat the caller workspace as proof when native chat metadata is absent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ocp-cursor-identity-'));
    const workspace = mkdtempSync(join(tmpdir(), 'ocp-cursor-identity-workspace-'));
    const previousConfigDir = process.env['CURSOR_CONFIG_DIR'];
    try {
      process.env['CURSOR_CONFIG_DIR'] = root;
      const sessionId = 'chat-123';
      const transcript = join(root, 'projects', 'project-slug', 'agent-transcripts', sessionId, `${sessionId}.jsonl`);
      mkdirSync(join(transcript, '..'), { recursive: true });
      writeFileSync(transcript, `${JSON.stringify({ role: 'user', content: 'hello' })}\n`);

      expect(await readCursorTranscriptIdentity({ transcriptRef: transcript, workspace })).toMatchObject({ kind: 'transcript_unavailable' });

      const meta = join(root, 'chats', 'workspace-hash', sessionId, 'meta.json');
      mkdirSync(join(meta, '..'), { recursive: true });
      writeFileSync(meta, JSON.stringify({ cwd: workspace }));
      expect(await readCursorTranscriptIdentity({ transcriptRef: transcript, workspace })).toEqual({ providerSessionId: sessionId });
    } finally {
      if (previousConfigDir === undefined) delete process.env['CURSOR_CONFIG_DIR'];
      else process.env['CURSOR_CONFIG_DIR'] = previousConfigDir;
      rmSync(root, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('accepts only model identifiers emitted by the CLI catalog', () => {
    expect(parseCursorModelCatalog('["auto","gpt-4.1"]')).toEqual(['auto', 'gpt-4.1']);
    expect(parseCursorModelCatalog('auto\ngpt-4.1\n')).toEqual(['auto', 'gpt-4.1']);
    expect(parseCursorModelCatalog('Available models:\nauto')).toBeNull();
    expect(parseCursorModelCatalog('["auto","auto"]')).toBeNull();
    expect(parseCursorModelCatalog(JSON.stringify(Array.from({ length: 4097 }, (_, index) => `model-${index}`)))).toBeNull();
  });

  it('queries version and catalog within one deadline and versions the catalog source', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    runProcessMock.mockImplementation(({ args }: { readonly args: readonly string[] }) => {
      if (args[0] === '--version') {
        now.mockReturnValue(13_000);
        return { kind: 'completed', exitCode: 0, stdout: { text: 'Cursor Agent 1.2.3\n', truncated: false }, stderr: { text: '', truncated: false } };
      }
      return { kind: 'completed', exitCode: 0, stdout: { text: '["auto"]', truncated: false }, stderr: { text: '', truncated: false } };
    });
    try {
      const result = await cursorHarness.queryModels({ cwd: '/workspace' });
      expect(result).toMatchObject({ kind: 'available', source: 'cursor:Cursor Agent 1.2.3:cursor-agent --list-models' });
      expect(runProcessMock).toHaveBeenCalledTimes(2);
      expect(runProcessMock.mock.calls[1]![0]).toMatchObject({ args: ['--list-models'], timeoutMs: 18_000 });
    } finally {
      now.mockRestore();
      runProcessMock.mockReset();
    }
  });

  it('declares Cursor’s sessionStart JSON hook entry and exact resume arguments', () => {
    const definition = cursorReportingDefinition({ HOME: '/home/test' });
    expect(definition.configPath).toBe('/home/test/.cursor/hooks.json');
    expect(definition.event).toBe('sessionStart');
    expect(definition.entry).toEqual({ command: definition.command });
    expect(cursorArguments({ launchId: 'launch', modelSelection: { model: 'gpt-4.1', effort: null, effortCapability: null, catalogSource: null }, sandboxMode: 'workspace-write' }, {
      sessionId: 'chat-123', originalStateRoot: '/state', transcriptRef: '/native/transcript.jsonl',
    })).toEqual(['--model', 'gpt-4.1', '--resume', 'chat-123']);
    expect(() => cursorArguments({ launchId: 'launch', modelSelection: { model: 'gpt-4.1', effort: 'high', effortCapability: null, catalogSource: null }, sandboxMode: 'workspace-write' })).toThrow();
  });

  it('installs and removes only its sessionStart entry while preserving user hooks', () => {
    const root = mkdtempSync(join(tmpdir(), 'ocp-cursor-reporting-'));
    try {
      const env = { HOME: root };
      const definition = cursorReportingDefinition(env);
      mkdirSync(join(root, '.cursor'), { recursive: true });
      writeFileSync(definition.configPath, JSON.stringify({ version: 1, hooks: { sessionStart: [{ command: 'user-hook' }], stop: [{ command: 'user-stop' }] }, model: 'user-model' }));
      maintainCursorReporting('install', env);
      const installed = readReportingJson(definition.configPath);
      expect(installed['model']).toBe('user-model');
      expect((installed['hooks'] as Record<string, unknown>)['stop']).toEqual([{ command: 'user-stop' }]);
      expect((installed['hooks'] as Record<string, unknown>)['sessionStart']).toEqual([{ command: 'user-hook' }, definition.entry]);
      maintainCursorReporting('uninstall', env);
      const removed = readReportingJson(definition.configPath);
      expect((removed['hooks'] as Record<string, unknown>)['sessionStart']).toEqual([{ command: 'user-hook' }]);
      expect((removed['hooks'] as Record<string, unknown>)['stop']).toEqual([{ command: 'user-stop' }]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses malformed sessionStart configuration without replacing it', () => {
    const root = mkdtempSync(join(tmpdir(), 'ocp-cursor-reporting-conflict-'));
    try {
      const env = { HOME: root };
      const definition = cursorReportingDefinition(env);
      const original = JSON.stringify({ version: 1, hooks: { sessionStart: { command: 'user-hook' } } });
      mkdirSync(join(root, '.cursor'), { recursive: true });
      writeFileSync(definition.configPath, original);
      expect(() => maintainCursorReporting('install', env)).toThrow();
      expect(readFileSync(definition.configPath, 'utf8')).toBe(original);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('preserves a concurrent native edit detected before installation rename', () => {
    const root = mkdtempSync(join(tmpdir(), 'ocp-cursor-reporting-cas-'));
    try {
      const definition = cursorReportingDefinition({ HOME: root });
      mkdirSync(join(root, '.cursor'), { recursive: true });
      const original = JSON.stringify({ version: 1, model: 'original' });
      const concurrent = JSON.stringify({ version: 1, model: 'native-edit' });
      writeFileSync(definition.configPath, concurrent);
      expect(() => assertCursorSnapshot(definition.configPath, original)).toThrow();
      expect(readFileSync(definition.configPath, 'utf8')).toBe(concurrent);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
