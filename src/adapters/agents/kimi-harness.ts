import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type {
  HarnessSessionReport, HarnessTranscriptCoverageResult, HarnessTranscriptProofResult,
  PreparedHarnessTerminal, ProveHarnessSessionInput, WorkerHarness, WorkerHarnessLaunchInput,
  WorkerModelCatalogQuery, WorkerModelCatalogResult,
} from '../../application/ports/worker-harness.js';
import type { TranscriptCoverageEvidence } from '../../application/recovery/recovery-capsule.js';
import type { PreparedTerminalStrategy } from '../../application/worker-launch.js';
import type { WorkerModelSelection } from '../../domain/model-configuration.js';
import { workerModelSelectionSchema } from '../../domain/model-configuration.js';
import { runProcess } from '../orca-cli/process-runner.js';
import { nativeWorkerRuntime } from './worker-runtime.js';
import { candidateSessionPaths, installCandidateReporter, prepareCandidateLaunch, type CandidateResume } from './candidate-worker-launch.js';
import { probeHarnessReadOnlyWorker } from './read-only-execution-wrapper.js';
import { REPORT_TRAMPOLINE, reportingCommand, reportingRoot } from './worker-harness-reporting.js';

export const KIMI_HARNESS_ID = 'kimi';
const SAFE_ID = /^[a-zA-Z0-9_-]{1,128}$/u;
const MAX_ARCHIVE_LIST_BYTES = 256 * 1024;
const MAX_WIRE_BYTES = 8 * 1024 * 1024;
const MAX_WIRE_LINES = 20_000;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
type KimiManifest = { readonly sessionId: string; readonly workspaceDir: string };
type KimiWire = {
  readonly name: string; readonly bytes: Buffer; readonly first: string; readonly last: string;
  readonly hasUserActivity: boolean; readonly hasAssistantActivity: boolean;
};
type KimiArchive = { readonly manifest: KimiManifest; readonly wires: readonly KimiWire[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function samePath(a: string, b: string): boolean {
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
}
function boundedRead(path: string, maxBytes: number): Buffer {
  let fd: number | undefined;
  try {
    fd = openSync(path, READ_FLAGS);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) throw new Error('native file bound');
    const bytes = Buffer.alloc(stat.size);
    if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) throw new Error('native file changed');
    const after = fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('native file changed');
    return bytes;
  } finally { if (fd !== undefined) closeSync(fd); }
}
/** Kimi Code 2.1.1 workdir-slug.ts: 40-character basename plus 12 SHA-256 hex digits. */
function encodeKimiWorkspaceKey(workspace: string, hash: typeof createHash): string {
  const normalized = workspace.replace(/\\/gu, '/').replace(/\/+$/u, '');
  const slug = (normalized.split('/').at(-1) ?? normalized).toLowerCase().replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '').slice(0, 40).replace(/^-+|-+$/gu, '');
  const name = slug === '' || slug === '.' || slug === '..' ? 'workspace' : slug;
  return `wd_${name}_${hash('sha256').update(normalized).digest('hex').slice(0, 12)}`;
}

export function kimiWorkspaceKey(workspace: string): string {
  return encodeKimiWorkspaceKey(workspace, createHash);
}

export function kimiMainWirePath(stateRoot: string, workspace: string, sessionId: string): string {
  return join(stateRoot, 'sessions', kimiWorkspaceKey(workspace), sessionId, 'agents', 'main', 'wire.jsonl');
}
export function kimiSessionLocation(transcriptRef: string): { readonly sessionId: string; readonly stateRoot: string } | null {
  try {
    if (!isAbsolute(transcriptRef) || lstatSync(transcriptRef).isSymbolicLink() || realpathSync(transcriptRef) !== resolve(transcriptRef)) return null;
    const sessionDir = dirname(dirname(dirname(transcriptRef)));
    const sessionId = basename(sessionDir);
    const workspaceDir = dirname(sessionDir), sessionsDir = dirname(workspaceDir), stateRoot = dirname(sessionsDir);
    if (!SAFE_ID.test(sessionId) || !/^wd_[a-z0-9._-]{1,40}_[a-f0-9]{12}$/u.test(basename(workspaceDir))
      || basename(sessionsDir) !== 'sessions' || transcriptRef !== join(sessionDir, 'agents', 'main', 'wire.jsonl')) return null;
    return { sessionId, stateRoot };
  } catch { return null; }
}

function kimiHookEntry(): { readonly event: 'SessionStart'; readonly command: string; readonly timeout: 10 } {
  return { event: 'SessionStart', command: reportingCommand(), timeout: 10 };
}

/** Parent setup maintains this additive [[hooks]] table; the hook itself only forwards stdin. */
export function kimiReporterHookToml(): string {
  return `[[hooks]]\nevent = "SessionStart"\ncommand = ${JSON.stringify(kimiHookEntry().command)}\ntimeout = 10\n`;
}

export function kimiReportingDefinition(env: Readonly<Record<string, string | undefined>> = process.env) {
  const root = env['KIMI_CODE_HOME']?.trim() || join(homedir(), '.kimi-code');
  return { configPath: join(root, 'config.toml'), hookToml: kimiReporterHookToml(), hook: kimiHookEntry() };
}

export function kimiReportingInstalled(definition = kimiReportingDefinition(), artifactRoot = reportingRoot()): boolean {
  try {
    const source = new TextDecoder('utf8', { fatal: true }).decode(boundedRead(definition.configPath, 1024 * 1024));
    const expected = definition.hook;
    return kimiHookSections(source).some((section) => section.event === expected.event && section.command === expected.command
      && section.timeout === expected.timeout && section.keys.length === 3)
      && new TextDecoder('utf8', { fatal: true }).decode(boundedRead(join(artifactRoot, 'report.mjs'), 65536)) === REPORT_TRAMPOLINE;
  } catch { return false; }
}

/** A table range begins at its header bracket; `\s` in the header patterns would swallow the preceding blank line. */
function tableStart(match: { readonly index?: number; readonly 0: string }): number {
  return (match.index ?? 0) + match[0].indexOf('[');
}

function kimiHookSections(source: string): { readonly start: number; readonly end: number; readonly event: string | null; readonly command: string | null; readonly timeout: number | null; readonly keys: readonly string[] }[] {
  const starts = [...source.matchAll(/^[ \t]*\[\[hooks\]\][ \t]*$/gmu)].map(tableStart).sort((a, b) => a - b);
  return starts.map((start) => {
    const nextHeader = /^[ \t]*\[\[?.*\]\]?[ \t]*$/gmu;
    nextHeader.lastIndex = start + 1;
    const next = nextHeader.exec(source);
    const end = next === null ? source.length : tableStart(next);
    const fields = new Map<string, unknown>();
    const keys: string[] = [];
    for (const line of source.slice(start).split(/\r?\n/u).slice(1)) {
      if (/^\s*\[\[/u.test(line) || /^\s*\[/u.test(line)) break;
      const assignment = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$/u);
      if (assignment) {
        const value = assignment[2]!.match(/^("(?:[^"\\]|\\.)*"|[^"#]*)[ \t]*(?:#.*)?$/u);
        if (value === null) throw new Error('Kimi hook field cannot be parsed safely');
        keys.push(assignment[1]!);
        try { fields.set(assignment[1]!, JSON.parse(value[1]!)); } catch { fields.set(assignment[1]!, null); }
      }
    }
    return { start, end, event: typeof fields.get('event') === 'string' ? fields.get('event') as string : null,
      command: typeof fields.get('command') === 'string' ? fields.get('command') as string : null,
      timeout: typeof fields.get('timeout') === 'number' ? fields.get('timeout') as number : null, keys };
  });
}

function readKimiConfig(path: string): { readonly text: string; readonly mode: number } | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, READ_FLAGS);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Kimi config exceeds limit');
    const bytes = Buffer.alloc(stat.size);
    if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) throw new Error('Kimi config changed');
    return { text: new TextDecoder('utf8', { fatal: true }).decode(bytes), mode: stat.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}

function writeKimiConfig(path: string, text: string, mode: number, original: string | null): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.companion-${process.pid}.tmp`;
  try {
    writeFileSync(temporary, text, { flag: 'wx', mode });
    const latest = readKimiConfig(path);
    if ((latest?.text ?? null) !== original || (latest !== null && latest.mode !== mode)) {
      throw Object.assign(new Error('Kimi native config changed concurrently'), { code: 'native_config_changed' });
    }
    renameSync(temporary, path);
  }
  finally { try { unlinkSync(temporary); } catch { /* renamed or absent */ } }
}

export function maintainKimiReporting(action: 'install' | 'uninstall', definition = kimiReportingDefinition(), artifactRoot = reportingRoot()): void {
  mkdirSync(dirname(definition.configPath), { recursive: true, mode: 0o700 });
  const lockPath = `${definition.configPath}.companion-lock`;
  const lock = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    const current = readKimiConfig(definition.configPath);
    const source = current?.text ?? '';
    const entry = definition.hook;
    const matching = kimiHookSections(source).filter((section) => section.command === entry.command);
    if (matching.some((section) => section.event !== entry.event || section.timeout !== entry.timeout
      || section.keys.length !== 3 || new Set(section.keys).size !== 3
      || section.keys.some((key) => !['event', 'command', 'timeout'].includes(key)))) {
      throw new Error('Kimi Companion hook entry conflicts with existing configuration');
    }
    if (matching.length > 1) throw new Error('Kimi Companion hook entry is duplicated');

    if (action === 'install') {
      if (new TextDecoder('utf8', { fatal: true }).decode(boundedRead(join(artifactRoot, 'report.mjs'), 65536)) !== REPORT_TRAMPOLINE) {
        throw new Error('Shared Companion reporting trampoline is not installed');
      }
      if (matching.length === 0) {
        const addition = `${source.length > 0 && !source.endsWith('\n') ? '\n' : ''}${definition.hookToml}`;
        writeKimiConfig(definition.configPath, source + addition, current?.mode ?? 0o600, current?.text ?? null);
      }
      return;
    }

    if (matching.length === 1) {
      const section = matching[0]!;
      writeKimiConfig(definition.configPath, source.slice(0, section.start) + source.slice(section.end), current?.mode ?? 0o600, current?.text ?? null);
    }
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
  }
}

export function kimiReporterSource(reportPath: string, runtimeReportPath: string): string {
  return `import { appendFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
let text = ''; for await (const chunk of process.stdin) { text += chunk; if (Buffer.byteLength(text) > 65536) process.exit(2); }
const payload = JSON.parse(text), sessionId = payload?.session_id, cwd = payload?.cwd;
if (payload?.hook_event_name !== 'SessionStart' || typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId) || typeof cwd !== 'string' || !isAbsolute(cwd)) process.exit(2);
const runtime = JSON.parse(readFileSync(${JSON.stringify(runtimeReportPath)}, 'utf8'));
const expected = resolve(process.env.KIMI_CODE_HOME?.trim() || join(homedir(), '.kimi-code'));
if (runtime.stateRoot !== expected || !Array.isArray(runtime.writableRoots) || !runtime.writableRoots.includes(runtime.stateRoot)) process.exit(2);
const workspaceKey = (${encodeKimiWorkspaceKey.toString()})(cwd, createHash);
const transcriptPath = join(runtime.stateRoot, 'sessions', workspaceKey, sessionId, 'agents', 'main', 'wire.jsonl');
appendFileSync(${JSON.stringify(reportPath)}, JSON.stringify({ harness: 'kimi', sessionId, transcriptPath, cwd, observedAt: new Date().toISOString(), stateRoot: runtime.stateRoot, runtimeRoots: runtime.writableRoots }) + '\\n', { mode: 0o600 });
`;
}

function requireSetup(): void {
  if (!kimiReportingInstalled()) throw Object.assign(new Error('请独立安装 Kimi Code SessionStart hook'), { code: 'worker_reporting_missing' });
}

function launch(input: WorkerHarnessLaunchInput, resume?: CandidateResume): PreparedTerminalStrategy<PreparedHarnessTerminal> {
  if (input.modelSelection.effort !== null) throw new Error('Kimi Code requires an exact native model ID with null effort');
  return prepareCandidateLaunch({ harness: KIMI_HARNESS_ID, executable: 'kimi', input, ...(resume === undefined ? {} : { resume }),
    arguments: () => ['--model', input.modelSelection.model, ...(resume === undefined ? [] : ['--session', resume.sessionId])],
    reporterSource: kimiReporterSource, checkSetup: requireSetup,
    verifyResume: async (workspace, original) => {
      const archive = await exportArchive(original.transcriptRef, workspace);
      if (archive?.manifest.sessionId !== original.sessionId) throw new Error('Kimi Code 原 Session 身份不可证明');
    },
  });
}

// Native durable event names from Kimi Code 2.1.1 agent-core-v2, wire protocol 1.5.
const KIMI_WIRE_TYPES = new Set([
  'turn.step.interrupted', 'turn.step.retrying', 'context.append_message', 'context.append_loop_event',
  'context.clear', 'context.apply_compaction', 'context.undo', 'turn.prompt', 'turn.steer', 'turn.cancel', 'turn.ended',
  'file_history.tracked', 'file_history.checkpoint', 'runtime.set_binding', 'task.started', 'task.terminated', 'task.waitDelivered',
  'full_compaction.begin', 'full_compaction.cancel', 'full_compaction.complete', 'plan_mode.enter', 'plan_mode.cancel',
  'plan_mode.exit', 'plan.revision', 'swarm_mode.enter', 'swarm_mode.exit', 'tower_mode.enter', 'tower_mode.exit',
  'prompt.completed', 'prompt.aborted', 'prompt.steered', 'goal.create', 'goal.update', 'goal.clear', 'forked',
  'usage.record', 'profile.bind', 'config.update', 'tools.set_active_tools', 'tools.reset_active_tools',
  'cron.add', 'cron.delete', 'cron.cursor', 'permission.set_mode', 'interaction.request', 'interaction.resolved',
  'token_counting.measured', 'token_counting.truncated', 'token_counting.rebased', 'token_counting.turn_recorded',
  'plugin.session_start', 'tools.update_store', 'llm.tools_snapshot', 'llm.request', 'interruptionReminder.recorded',
  'mcp.tools_discovered', 'permission.record_approval_result', 'tools.register_user_tool', 'tools.unregister_user_tool',
]);
const KIMI_HUMAN_TYPES = new Set(['agent.switched', 'agent.message.appended', 'agent.turn.started', 'agent.turn.ended']);

function kimiRecordValid(row: Record<string, unknown>, agentId: string): boolean {
  const type = row['type'];
  if (typeof type !== 'string' || typeof row['time'] !== 'number' || !Number.isFinite(row['time']) || row['time'] <= 0) return false;
  if (KIMI_HUMAN_TYPES.has(type)) {
    return type === 'agent.message.appended' ? isRecord(row['message'])
      : type === 'agent.switched' ? typeof row['agentId'] === 'string' : typeof row['turnId'] === 'number';
  }
  if (!KIMI_WIRE_TYPES.has(type) || row['agentId'] !== agentId) return false;
  if (type === 'context.append_message') {
    const message = row['message'];
    return isRecord(message) && ['user', 'assistant', 'system', 'tool'].includes(String(message['role']))
      && Array.isArray(message['content']) && Array.isArray(message['toolCalls']);
  }
  if (type === 'context.append_loop_event') {
    const event = row['event'];
    if (!isRecord(event)) return false;
    if (event['type'] === 'tool.result') return typeof event['parentUuid'] === 'string' && typeof event['toolCallId'] === 'string'
      && isRecord(event['result']) && ('output' in event['result']);
    if (typeof event['uuid'] !== 'string' || !event['uuid'] || typeof event['turnId'] !== 'string' || !event['turnId']
      || typeof event['step'] !== 'number' || !Number.isSafeInteger(event['step']) || event['step'] < 0) return false;
    if (event['type'] === 'step.begin' || event['type'] === 'step.end') return true;
    if (event['type'] === 'content.part') return isRecord(event['part']) && ['text', 'think'].includes(String(event['part']['type']));
    return event['type'] === 'tool.call' && typeof event['toolCallId'] === 'string' && typeof event['name'] === 'string' && isRecord(event['args']);
  }
  if (type === 'context.undo') return typeof row['count'] === 'number' && Number.isSafeInteger(row['count']) && row['count'] > 0;
  if (type === 'context.apply_compaction') return (typeof row['summary'] === 'string' || isRecord(row['summary']) || typeof row['contextSummary'] === 'string')
    && (typeof row['compactedCount'] === 'number' || typeof row['count'] === 'number');
  return true;
}

export function parseKimiWire(bytes: Buffer, name: string): KimiWire | null {
  const match = /^agents\/([a-zA-Z0-9_-]{1,128})\/wire\.jsonl$/u.exec(name);
  if (match === null || bytes.length === 0 || bytes.length > MAX_WIRE_BYTES) return null;
  try {
    const text = new TextDecoder('utf8', { fatal: true }).decode(bytes);
    if (!text.endsWith('\n')) return null;
    const lines = text.slice(0, -1).split('\n');
    if (lines.length > MAX_WIRE_LINES) return null;
    const records: unknown[] = lines.map((line) => JSON.parse(line) as unknown);
    const metadata = records[0];
    if (!isRecord(metadata) || metadata['type'] !== 'metadata' || metadata['protocol_version'] !== '1.5'
      || typeof metadata['created_at'] !== 'number' || !Number.isFinite(metadata['created_at']) || metadata['created_at'] <= 0
      || records.slice(1).some((row) => !isRecord(row) || !kimiRecordValid(row, match[1]!))) return null;
    const events = records.slice(1) as Record<string, unknown>[];
    return { name, bytes, first: `${name}:1`, last: `${name}:${lines.length}`,
      hasUserActivity: events.some((row) => row['type'] === 'context.append_message' && isRecord(row['message']) && row['message']['role'] === 'user'),
      hasAssistantActivity: events.some((row) => (row['type'] === 'context.append_message' && isRecord(row['message']) && row['message']['role'] === 'assistant')
        || (row['type'] === 'context.append_loop_event' && isRecord(row['event']) && row['event']['type'] === 'step.end')) };
  } catch { return null; }
}

function nativeWireSnapshot(transcriptRef: string): readonly KimiWire[] {
  const sessionDir = dirname(dirname(dirname(transcriptRef))), agentsDir = join(sessionDir, 'agents');
  const agents = readdirSync(agentsDir, { withFileTypes: true });
  if (agents.length === 0 || agents.length > 4096 || agents.some((agent) => !agent.isDirectory() || !SAFE_ID.test(agent.name))) throw new Error('native agent layout');
  const wires: KimiWire[] = [];
  let totalBytes = 0, totalLines = 0;
  for (const agent of agents.sort((a, b) => a.name.localeCompare(b.name))) {
    const name = `agents/${agent.name}/wire.jsonl`, path = join(sessionDir, name);
    if (realpathSync(path) !== resolve(path)) throw new Error('native wire path');
    const bytes = boundedRead(path, MAX_WIRE_BYTES);
    const wire = parseKimiWire(bytes, name);
    if (wire === null) throw new Error('native wire schema');
    totalBytes += bytes.length; totalLines += Number(wire.last.slice(wire.last.lastIndexOf(':') + 1));
    if (totalBytes > MAX_WIRE_BYTES || totalLines > MAX_WIRE_LINES) throw new Error('native wire bound');
    wires.push(wire);
  }
  if (!wires.some((wire) => wire.name === 'agents/main/wire.jsonl')) throw new Error('native main wire missing');
  return wires;
}

async function exportArchive(transcriptRef: string, workspace?: string, signal?: AbortSignal): Promise<KimiArchive | null> {
  const location = kimiSessionLocation(transcriptRef);
  if (location === null) return null;
  const { sessionId, stateRoot } = location;
  let directory: string | undefined;
  try {
    if (!samePath(stateRoot, nativeWorkerRuntime(KIMI_HARNESS_ID).stateRoot)) return null;
    const before = nativeWireSnapshot(transcriptRef);
    const cwd = workspace ?? process.cwd();
    const startedAt = performance.now();
    directory = mkdtempSync(join(tmpdir(), 'orca-companion-kimi-export-'));
    const archivePath = join(directory, 'session.zip');
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    const run: typeof runProcess = (request) => {
      const remainingMs = Math.floor(30_000 - (performance.now() - startedAt));
      if (remainingMs <= 0) throw new Error('Kimi export timeout');
      return runProcess({ ...request, timeoutMs: Math.min(request.timeoutMs, remainingMs) });
    };
    const exported = await run({ executable: 'kimi', args: ['export', sessionId, '--output', archivePath, '--yes', '--no-include-global-log'],
      cwd, env, timeoutMs: 30_000, limits: { maxBytes: 64 * 1024, maxLines: 1000 }, ...(signal === undefined ? {} : { signal }) });
    if (exported.kind !== 'completed' || exported.exitCode !== 0 || exported.stdout.truncated) return null;
    const listed = await run({ executable: 'unzip', args: ['-Z1', archivePath], cwd, env,
      timeoutMs: 10_000, limits: { maxBytes: MAX_ARCHIVE_LIST_BYTES, maxLines: 5000 }, ...(signal === undefined ? {} : { signal }) });
    if (listed.kind !== 'completed' || listed.exitCode !== 0 || listed.stdout.truncated) return null;
    const integrity = await run({ executable: 'unzip', args: ['-t', archivePath], cwd, env,
      timeoutMs: 10_000, limits: { maxBytes: 64 * 1024, maxLines: 5000 }, ...(signal === undefined ? {} : { signal }) });
    if (integrity.kind !== 'completed' || integrity.exitCode !== 0 || integrity.stdout.truncated) return null;
    const names = listed.stdout.text.split(/\r?\n/u).filter(Boolean);
    if (names.length === 0 || names.length > 5000 || new Set(names).size !== names.length
      || names.some((name) => name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) || !names.includes('manifest.json')) return null;
    const manifestResult = await run({ executable: 'unzip', args: ['-p', archivePath, 'manifest.json'], cwd, env,
      timeoutMs: 10_000, limits: { maxBytes: 1024 * 1024, maxLines: 10000 }, ...(signal === undefined ? {} : { signal }) });
    if (manifestResult.kind !== 'completed' || manifestResult.exitCode !== 0 || manifestResult.stdout.truncated) return null;
    const manifestValue: unknown = JSON.parse(manifestResult.stdout.text);
    if (!isRecord(manifestValue) || manifestValue['sessionId'] !== sessionId || typeof manifestValue['workspaceDir'] !== 'string'
      || !isAbsolute(manifestValue['workspaceDir']) || manifestValue['wireProtocolVersion'] !== '1.5'
      || typeof manifestValue['kimiCodeVersion'] !== 'string' || !manifestValue['kimiCodeVersion']
      || typeof manifestValue['exportedAt'] !== 'string' || !Number.isFinite(Date.parse(manifestValue['exportedAt']))
      || (workspace !== undefined && !samePath(manifestValue['workspaceDir'], workspace))
      || transcriptRef !== kimiMainWirePath(stateRoot, manifestValue['workspaceDir'], sessionId)) return null;
    const wireNames = names.filter((name) => name.endsWith('wire.jsonl')).sort();
    if (wireNames.length !== before.length || wireNames.some((name) => !before.some((wire) => wire.name === name))) return null;
    const wires: KimiWire[] = [];
    for (const name of wireNames) {
      const output = await run({ executable: 'unzip', args: ['-p', archivePath, name], cwd, env,
        timeoutMs: 10_000, limits: { maxBytes: MAX_WIRE_BYTES, maxLines: MAX_WIRE_LINES }, ...(signal === undefined ? {} : { signal }) });
      if (output.kind !== 'completed' || output.exitCode !== 0 || output.stdout.truncated) return null;
      const raw = Buffer.from(output.stdout.text, 'utf8');
      const original = before.find((wire) => wire.name === name)!;
      if (!raw.equals(original.bytes)) return null;
      wires.push(original);
    }
    const after = nativeWireSnapshot(transcriptRef);
    if (after.length !== before.length || before.some((wire) => !after.some((other) => other.name === wire.name && other.bytes.equals(wire.bytes)))
      || performance.now() - startedAt > 30_000) return null;
    return { manifest: { sessionId, workspaceDir: manifestValue['workspaceDir'] }, wires };
  } catch { return null; }
  finally { if (directory !== undefined) { try { unlinkSync(join(directory, 'session.zip')); } catch { /* absent on failed export */ } try { (await import('node:fs')).rmdirSync(directory); } catch { /* empty temp directory only */ } } }
}

type ValidKimiReportInput = ProveHarnessSessionInput & { readonly report: HarnessSessionReport & {
  readonly sessionId: string; readonly transcriptPath: string; readonly cwd: string; readonly observedAt: string;
  readonly stateRoot: string; readonly runtimeRoots: readonly string[];
} };

function reportValid(input: ProveHarnessSessionInput): input is ValidKimiReportInput {
  const report: HarnessSessionReport = input.report;
  if (typeof report.sessionId !== 'string' || typeof report.transcriptPath !== 'string' || typeof report.cwd !== 'string'
    || typeof report.observedAt !== 'string' || typeof report.stateRoot !== 'string' || !report.runtimeRoots?.length
    || report.harness !== KIMI_HARNESS_ID) return false;
  const at = Date.parse(report.observedAt), from = Date.parse(input.dispatchStartedAt), end = Date.parse(input.bindingDeadlineAt);
  try {
    const runtime = nativeWorkerRuntime(KIMI_HARNESS_ID), roots = runtime.writableRoots.map((root) => realpathSync(root));
    const found = kimiSessionLocation(report.transcriptPath);
    return found !== null && found.sessionId === report.sessionId && found.stateRoot === resolve(runtime.stateRoot)
      && SAFE_ID.test(report.sessionId) && Number.isFinite(at) && Number.isFinite(from) && Number.isFinite(end)
      && at >= from && at <= end && samePath(report.cwd, input.workspace) && samePath(report.stateRoot, input.expectedStateRoot)
      && samePath(runtime.stateRoot, input.expectedStateRoot) && roots.length === report.runtimeRoots.length
      && roots.every((root) => report.runtimeRoots!.some((item) => samePath(root, item)))
      && report.transcriptPath === resolve(report.transcriptPath);
  } catch { return false; }
}

export async function readKimiTranscriptIdentity(input: { readonly transcriptRef: string; readonly workspace: string }): Promise<
  { readonly providerSessionId: string } | { readonly kind: 'transcript_unavailable'; readonly reason: string }
> {
  const archive = await exportArchive(input.transcriptRef, input.workspace);
  return archive === null
    ? { kind: 'transcript_unavailable', reason: 'Kimi Code exact export manifest, native snapshot or workspace cannot be proven' }
    : { providerSessionId: archive.manifest.sessionId };
}

export async function proveKimiTranscript(input: ProveHarnessSessionInput): Promise<HarnessTranscriptProofResult> {
  if (!reportValid(input)) return { kind: 'transcript_unavailable', reason: 'Kimi Code report, native roots, manifest, or workspace mismatch' };
  const report = input.report;
  const archive = await exportArchive(report.transcriptPath, input.workspace);
  if (archive === null || archive.manifest.sessionId !== report.sessionId || !samePath(archive.manifest.workspaceDir, input.workspace)) {
    return { kind: 'transcript_unavailable', reason: 'Kimi Code exact-ID ZIP export does not match the reported Session' };
  }
  return { kind: 'proven', proof: { providerSessionId: report.sessionId, transcriptRef: report.transcriptPath, observedAt: report.observedAt } };
}

export async function inspectKimiTranscript(transcriptRef: string): Promise<HarnessTranscriptCoverageResult> {
  const archive = await exportArchive(transcriptRef);
  if (archive === null || archive.wires.length === 0) return { kind: 'transcript_unavailable', reason: 'Kimi Code session export is incomplete or unavailable' };
  const main = archive.wires.find((wire) => wire.name === 'agents/main/wire.jsonl');
  if (!main?.hasUserActivity || !main.hasAssistantActivity) return { kind: 'transcript_unavailable', reason: 'Kimi Code native history has no complete user/assistant activity' };
  const first = archive.wires[0]!, last = archive.wires.at(-1)!;
  const evidence: TranscriptCoverageEvidence = { coverage: 'complete',
    readableRange: { transcriptRef: resolve(transcriptRef), fromEventRef: first.first, toEventRef: last.last },
    gaps: [], lastCompleteEventRef: last.last };
  return { kind: 'covered', evidence };
}

export const KIMI_RECOVERY_INSTRUCTIONS = [
  'transcriptRef 精确指向 sessions/wd_<basename-slug>_<workspace-hash>/<SessionID>/agents/main/wire.jsonl；不得扫描最近 Session。',
  '只对精确 session ID 执行 `kimi export <ID> --output <ZIP> --yes --no-include-global-log`；不读取 global diagnostic log。',
  'manifest.json 位于导出 ZIP；核对 sessionId/workspaceDir/wireProtocolVersion，协议 1.5，并读取全部 agents/<agentId>/wire.jsonl。',
  '事件引用为 agents/<agentId>/wire.jsonl:N（N 从 1 开始）；范围只覆盖已核验稳定快照，不包括之后追加的行。',
  'context.append_message 与 context.append_loop_event 是活动历史；context.undo 撤销原消息，context.clear 重置上下文，context.apply_compaction 保留原生压缩边界。',
  '任何 agent wire 缺失、未知记录、metadata 无效、ZIP 损坏、导出期间变化、超限或身份不一致时停止，不借用其它 Session。',
] as const;

/** provider list --json emits raw configuration; only configured alias keys leave this parser. */
export function parseKimiModelCatalog(output: string): readonly string[] | null {
  if (Buffer.byteLength(output, 'utf8') > 1024 * 1024 || output.split('\n').length > 20_000) return null;
  try {
    const value: unknown = JSON.parse(output);
    if (!isRecord(value) || !isRecord(value['providers']) || !isRecord(value['models'])) return null;
    const models = Object.entries(value['models']);
    if (models.length === 0 || models.length > 4096) return null;
    const providers = value['providers'];
    if (models.some(([alias, model]) => alias.length === 0 || alias.length > 2048 || /\s/u.test(alias)
      || [...alias].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
      || !isRecord(model) || typeof model['provider'] !== 'string' || !Object.hasOwn(providers, model['provider'])
      || !isRecord(providers[model['provider']]) || typeof model['model'] !== 'string' || !model['model']
      || typeof model['maxContextSize'] !== 'number' || !Number.isSafeInteger(model['maxContextSize']) || model['maxContextSize'] <= 0)) return null;
    return models.map(([alias]) => alias).sort();
  } catch { return null; }
}

async function queryKimiModels(input: WorkerModelCatalogQuery): Promise<WorkerModelCatalogResult> {
  const unavailable = (code: string): WorkerModelCatalogResult => ({ kind: 'unavailable', code, message: 'Kimi Code 本地模型目录不可核验' });
  if (input.signal?.aborted) return unavailable('catalog_cancelled');
  const env = Object.fromEntries(Object.entries(input.env ?? process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  try {
    // provider list calls ensureConfigFile; refuse an absent config instead of allowing native creation.
    const root = nativeWorkerRuntime(KIMI_HARNESS_ID, env, env['HOME'] || homedir()).stateRoot;
    const configPath = join(root, 'config.toml');
    if (!lstatSync(configPath).isFile() || realpathSync(configPath) !== resolve(configPath)) return unavailable('catalog_config_unavailable');
    const startedAt = performance.now();
    const version = await runProcess({ executable: 'kimi', args: ['--version'], cwd: input.cwd, env, timeoutMs: 10_000,
      limits: { maxBytes: 4096, maxLines: 20 }, ...(input.signal === undefined ? {} : { signal: input.signal }) });
    if (input.signal?.aborted) return unavailable('catalog_cancelled');
    const versionMatch = version.kind === 'completed' && version.exitCode === 0 && !version.stdout.truncated
      ? /^(?:Kimi Code\s+)?v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/u.exec(version.stdout.text.trim()) : null;
    if (versionMatch === null) return unavailable('harness_version_unreadable');
    const remainingMs = Math.floor(30_000 - (performance.now() - startedAt));
    if (remainingMs <= 0) return unavailable('catalog_timeout');
    const result = await runProcess({ executable: 'kimi', args: ['provider', 'list', '--json'], cwd: input.cwd, env, timeoutMs: remainingMs,
      limits: { maxBytes: 1024 * 1024, maxLines: 20_000 }, ...(input.signal === undefined ? {} : { signal: input.signal }) });
    if (input.signal?.aborted) return unavailable('catalog_cancelled');
    if (performance.now() - startedAt > 30_000) return unavailable('catalog_timeout');
    const aliases = result.kind === 'completed' && result.exitCode === 0 && !result.stdout.truncated ? parseKimiModelCatalog(result.stdout.text) : null;
    return aliases === null ? unavailable('catalog_output_unrecognized')
      : { kind: 'available', source: `kimi:${versionMatch[1]!}:provider-list-json:configured-aliases`, models: aliases.map((model) => ({ model, effortCapability: null })) };
  } catch { return unavailable('catalog_query_failed'); }
}

export const kimiHarness: WorkerHarness = {
  id: KIMI_HARNESS_ID,
  prepareLaunch: (input) => launch(input),
  prepareReadOnlyLaunch: (input) => launch({ ...input, sandboxMode: 'read-only-local-control' }),
  prepareResume: (input) => launch(input, input),
  probe: async (selection?: Readonly<WorkerModelSelection>) => {
    if (selection !== undefined && (!workerModelSelectionSchema.safeParse(selection).success || selection.effort !== null)) {
      return { kind: 'unavailable', stage: 'model-selection', profile: 'production-bwrap', diagnostics: ['Kimi Code requires an exact model ID with null effort'], harnessVersion: null };
    }
    if (!kimiReportingInstalled()) return { kind: 'unavailable', stage: 'reporting', profile: 'production-bwrap', diagnostics: ['Kimi Code SessionStart hook is not installed'], harnessVersion: null };
    return probeHarnessReadOnlyWorker(KIMI_HARNESS_ID, selection, { harnessExecutable: 'kimi' });
  },
  queryModels: queryKimiModels,
  sessionPaths: (root, launchId) => candidateSessionPaths(KIMI_HARNESS_ID, root, launchId),
  installReporter: (paths) => installCandidateReporter(paths, kimiReporterSource(paths.reportPath, join(dirname(paths.reporterPath), 'native-runtime.json'))),
  readTranscriptIdentity: readKimiTranscriptIdentity,
  proveSession: proveKimiTranscript,
  inspectTranscript: inspectKimiTranscript,
  recoveryInstructions: () => KIMI_RECOVERY_INSTRUCTIONS,
};

