import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import { antigravityHarness, antigravityReporterSource } from '../../../src/adapters/agents/antigravity-harness.js';
import { COMPANION_REPORT_HOOK, maintainReporting, readReportingJson, REPORT_TRAMPOLINE } from '../../../src/adapters/agents/worker-harness-reporting.js';

const sessionId = '11111111-2222-4333-8444-555555555555';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ocp-agy-test-'));
  const workspace = join(root, 'workspace'), native = join(root, 'native');
  const transcript = join(native, 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl');
  mkdirSync(dirname(transcript), { recursive: true }); mkdirSync(workspace); mkdirSync(join(native, 'cache'));
  writeFileSync(join(native, 'cache', 'conversation_metadata.json'), JSON.stringify({ conversations: {
    [sessionId]: { summary: { ID: sessionId, WorkspaceURIs: [pathToFileURL(workspace).href] } },
  } }));
  writeFileSync(transcript, JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-10-11T00:00:00Z', content: 'input' }) + '\n');
  const report = { harness: 'antigravity', sessionId, cwd: workspace, transcriptPath: transcript,
    stateRoot: native, runtimeRoots: [native], observedAt: '2026-10-11T00:00:01Z' };
  return { root, workspace, native, transcript, report, input: { report, workspace, expectedStateRoot: native,
    dispatchStartedAt: '2026-10-11T00:00:00Z', bindingDeadlineAt: '2026-10-11T00:00:02Z' } };
}

describe('Antigravity exact native Session', () => {
  test('hook report needs independent native identity and workspace', async () => {
    const f = fixture();
    expect((await antigravityHarness.proveSession(f.input)).kind).toBe('proven');
    expect(await antigravityHarness.readTranscriptIdentity({ transcriptRef: f.transcript, workspace: f.workspace })).toEqual({ providerSessionId: sessionId });
    writeFileSync(join(f.native, 'cache', 'conversation_metadata.json'), '{"conversations":{}}');
    expect((await antigravityHarness.proveSession(f.input)).kind).toBe('transcript_unavailable');
  });
  test.each(['cwd', 'timestamp', 'id'] as const)('rejects %s conflicts', async (field) => {
    const f = fixture();
    const report = { ...f.report,
      ...(field === 'cwd' ? { cwd: f.root } : field === 'id' ? { sessionId: 'other' } : { observedAt: '2026-10-10T00:00:00Z' }) };
    expect((await antigravityHarness.proveSession({ ...f.input, report })).kind).toBe('transcript_unavailable');
  });
  test('exact persisted history proves workspace when optional caches are absent', async () => {
    const f = fixture();
    unlinkSync(join(f.native, 'cache', 'conversation_metadata.json'));
    const history = join(f.native, 'history.jsonl');
    writeFileSync(history, JSON.stringify({ conversationId: sessionId, workspace: f.workspace }) + '\n');
    expect((await antigravityHarness.proveSession(f.input)).kind).toBe('proven');
    writeFileSync(history, readFileSync(history, 'utf8') + JSON.stringify({ conversationId: sessionId, workspace: f.root }) + '\n');
    expect((await antigravityHarness.proveSession(f.input)).kind).toBe('transcript_unavailable');
  });
  test('coverage rejects missing or incomplete native events', async () => {
    const f = fixture();
    expect((await antigravityHarness.inspectTranscript(f.transcript)).kind).toBe('covered');
    writeFileSync(f.transcript, readFileSync(f.transcript, 'utf8') + JSON.stringify({ step_index: 1,
      source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-10-11T00:00:01Z',
      thinking: 'native reasoning', tool_calls: [] }) + '\n');
    expect((await antigravityHarness.inspectTranscript(f.transcript)).kind).toBe('covered');
    writeFileSync(f.transcript, JSON.stringify({ step_index: 2, status: 'DONE', type: 'PLANNER_RESPONSE', content: 'out', created_at: 'now' }));
    expect((await antigravityHarness.inspectTranscript(f.transcript)).kind).toBe('transcript_unavailable');
  });
  test('reporter forwards only native identity and actual runtime paths', () => {
    const f = fixture(), reporter = join(f.root, 'report.mjs'), output = join(f.root, 'report.jsonl'), runtime = join(f.root, 'runtime.json');
    writeFileSync(runtime, JSON.stringify({ stateRoot: f.native, writableRoots: [f.native], secret: 'must-not-leak' }));
    writeFileSync(reporter, antigravityReporterSource(output, runtime));
    const result = spawnSync(process.execPath, [reporter], { input: JSON.stringify({ conversationId: sessionId, workspacePaths: [f.workspace], transcriptPath: f.transcript, secret: 'must-not-leak' }) });
    expect(result.status).toBe(0);
    expect(readFileSync(output, 'utf8')).not.toContain('must-not-leak');
    expect(JSON.parse(readFileSync(output, 'utf8')) as unknown).toMatchObject({ sessionId });
  });
});

test('persistent reporting installation is idempotent and preserves unrelated hooks', () => {
  const root = mkdtempSync(join(tmpdir(), 'ocp-hook-test-')), path = join(root, 'hooks.json');
  const definition = { configPath: path, entry: { Stop: [{ command: 'companion-hook' }] } };
  writeFileSync(path, JSON.stringify({ 'user-hook': { enabled: false } }));
  maintainReporting(definition, 'install', root); maintainReporting(definition, 'install', root);
  expect(readReportingJson(path)['user-hook']).toEqual({ enabled: false });
  expect(readReportingJson(path)[COMPANION_REPORT_HOOK]).toEqual(definition.entry);
  maintainReporting(definition, 'uninstall', root);
  expect(readReportingJson(path)).toEqual({ 'user-hook': { enabled: false } });
});

test('persistent trampoline has no action outside Companion launch', () => {
  const root = mkdtempSync(join(tmpdir(), 'ocp-hook-noop-')), path = join(root, 'report.mjs');
  writeFileSync(path, REPORT_TRAMPOLINE);
  const env = { ...process.env }; delete env['ORCA_COMPANION_SESSION_REPORTER'];
  expect(spawnSync(process.execPath, [path], { env }).status).toBe(0);
});
