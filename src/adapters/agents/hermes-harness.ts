import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { HarnessSessionReport, ProveHarnessSessionInput, WorkerHarness, WorkerHarnessLaunchInput } from '../../application/ports/worker-harness.js';
import type { HarnessTranscriptCoverageResult } from '../../application/ports/worker-harness.js';
import type { TranscriptCoverageEvidence } from '../../application/recovery/recovery-capsule.js';
import { candidateSessionPaths, installCandidateReporter, prepareCandidateLaunch, type CandidateResume } from './candidate-worker-launch.js';
import { probeHarnessReadOnlyWorker } from './read-only-execution-wrapper.js';
import { reportingCommand, REPORT_TRAMPOLINE } from './worker-harness-reporting.js';
import { runProcess } from '../orca-cli/process-runner.js';

const MAX_EXPORT_BYTES = 8 * 1024 * 1024;
const SESSION_ID = /^[A-Za-z0-9_-]{8,128}$/u;
const HERMES_HOOK_MARKER = '# orca-companion-managed';

export type HermesReportingDefinition = {
  readonly configPath: string;
  readonly event: 'pre_llm_call';
  readonly command: string;
};

export function hermesReportingDefinition(env: Readonly<Record<string, string | undefined>> = process.env): HermesReportingDefinition {
  return { configPath: join(env['HERMES_HOME'] || join(homedir(), '.hermes'), 'config.yaml'),
    event: 'pre_llm_call', command: reportingCommand() };
}

/** Hermes shell hooks are YAML entries under `hooks:`; this check accepts only the exact owned event/command pair. */
export function hermesReportingInstalled(definition = hermesReportingDefinition()): boolean {
  try {
    const text = readBoundedText(definition.configPath, 1024 * 1024);
    return hasHermesHookEntry(text, definition) && hasHermesHookApproval(definition)
      && readReportingTrampoline() === REPORT_TRAMPOLINE;
  } catch { return false; }
}

export function maintainHermesReporting(action: 'install' | 'uninstall', definition = hermesReportingDefinition()): void {
  const directory = dirname(definition.configPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, '.orca-companion-hermes-reporting.lock');
  const lockFd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  let tempFiles: string[] = [];
  try {
    const configBefore = readOptionalText(definition.configPath, 1024 * 1024);
    const allowlistPath = join(directory, 'shell-hooks-allowlist.json');
    const allowlistBefore = readOptionalText(allowlistPath, 256 * 1024);
    const configAfter = updateHermesHookConfig(configBefore ?? '', action, definition);
    const allowlistAfter = updateHermesAllowlist(allowlistBefore, action, definition);
    let configWritten = false;
    let allowlistWritten = false;
    try {
      if (configAfter !== configBefore && (action === 'install' || configBefore !== null)) {
        tempFiles.push(atomicReplaceText(definition.configPath, configAfter, configBefore)); configWritten = true;
      }
      if (allowlistAfter !== allowlistBefore && allowlistAfter !== null) {
        tempFiles.push(atomicReplaceText(allowlistPath, allowlistAfter, allowlistBefore)); allowlistWritten = true;
      }
      if (action === 'install') {
        if (!hasHermesHookEntry(readBoundedText(definition.configPath, 1024 * 1024), definition)
          || !hasHermesHookApproval(definition)) throw new Error('Hermes hook install readback failed');
      } else if (hasHermesHookEntry(readOptionalText(definition.configPath, 1024 * 1024) ?? '', definition)
        || hasOwnedHermesHookApproval(definition)) throw new Error('Hermes hook uninstall readback failed');
    } catch (error) {
      if (allowlistWritten) atomicReplaceText(allowlistPath, allowlistBefore ?? '', allowlistAfter);
      if (configWritten) atomicReplaceText(definition.configPath, configBefore ?? '', configAfter);
      throw error;
    }
    tempFiles = [];
  } finally {
    closeSync(lockFd);
    for (const path of tempFiles) { try { unlinkSync(path); } catch { /* rename consumed it */ } }
    unlinkSync(lockPath);
  }
}

function readOptionalText(path: string, maxBytes: number): string | null {
  try { return readBoundedText(path, maxBytes); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

function atomicReplaceText(path: string, text: string, expected: string | null): string {
  const current = readOptionalText(path, 1024 * 1024);
  if (current !== expected) throw new Error('Hermes native file changed during update');
  const mode = current === null ? 0o600 : lstatSync(path).mode & 0o777;
  const temp = `${path}.orca-companion-${process.pid}.tmp`;
  writeFileSync(temp, text, { flag: 'wx', mode });
  try {
    if (readOptionalText(path, 1024 * 1024) !== expected) throw new Error('Hermes native file changed during update');
    renameSync(temp, path);
    return temp;
  } catch (error) { try { unlinkSync(temp); } catch { /* preserve original error */ } throw error; }
}

function updateHermesHookConfig(text: string, action: 'install' | 'uninstall', definition: HermesReportingDefinition): string {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.length === 0 ? [] : text.split(/\r?\n/u);
  const hooksIndex = lines.findIndex((line) => /^hooks:\s*(?:#.*)?$/u.test(line) || /^hooks:\s*\{\s*\}\s*(?:#.*)?$/u.test(line));
  const commandLine = `    - command: ${yamlQuote(definition.command)} ${HERMES_HOOK_MARKER}`;
  if (action === 'install') {
    if (hooksIndex < 0) {
      if (lines.some((line) => /^hooks\s*:/u.test(line))) throw new Error('Unsupported Hermes hooks YAML shape');
      const prefix = lines.length === 0 || lines.at(-1) === '' ? lines : [...lines, ''];
      return [...prefix, 'hooks:', `  ${definition.event}:`, commandLine, ''].join(newline);
    }
    const hookLine = lines[hooksIndex]!;
    if (/^hooks:\s*\{\s*\}\s*(?:#.*)?$/u.test(hookLine)) lines[hooksIndex] = 'hooks:';
    let blockEnd = lines.length;
    for (let i = hooksIndex + 1; i < lines.length; i++) if (lines[i]!.trim() && !lines[i]!.startsWith(' ')) { blockEnd = i; break; }
    const eventIndex = lines.findIndex((line, index) => index > hooksIndex && index < blockEnd
      && new RegExp(`^  ${definition.event}:\\s*(?:#.*)?$`, 'u').test(line));
    if (eventIndex < 0) {
      lines.splice(blockEnd, 0, `  ${definition.event}:`, commandLine);
    } else {
      const end = findHermesEventEnd(lines, eventIndex, blockEnd);
      const eventLine = lines[eventIndex]!;
      if (new RegExp(`^  ${definition.event}:\\s*\\[\\s*\\]\\s*(?:#.*)?$`, 'u').test(eventLine)) lines[eventIndex] = `  ${definition.event}:`;
      const existing = lines.slice(eventIndex + 1, end);
      if (existing.some((line) => hermesCommandLine(line)?.command === definition.command)) {
        if (existing.some((line) => hermesCommandLine(line)?.command === definition.command && hermesCommandLine(line)?.owned)) return text;
        throw new Error('Hermes hook command already exists without Companion ownership marker');
      }
      if (existing.some((line) => line.trim() && !line.trimStart().startsWith('#') && !/^ {4}-/u.test(line) && !/^ {6}\S/u.test(line))) {
        throw new Error('Unsupported Hermes on_session_start YAML shape');
      }
      lines.splice(end, 0, commandLine);
    }
    return lines.join(newline);
  }
  const uninstallHooksIndex = lines.findIndex((line) => /^hooks:\s*(?:#.*)?$/u.test(line));
  if (uninstallHooksIndex < 0) return text;
  let hooksEnd = lines.length;
  for (let i = uninstallHooksIndex + 1; i < lines.length; i++) if (lines[i]!.trim() && !lines[i]!.startsWith(' ')) { hooksEnd = i; break; }
  const eventIndex = lines.findIndex((line, index) => index > uninstallHooksIndex && index < hooksEnd
    && new RegExp(`^  ${definition.event}:\\s*(?:#.*)?$`, 'u').test(line));
  if (eventIndex < 0) return text;
  const eventEnd = findHermesEventEnd(lines, eventIndex, hooksEnd);
  const ownedIndex = lines.findIndex((line, index) => index > eventIndex && index < eventEnd
    && hermesCommandLine(line)?.command === definition.command && hermesCommandLine(line)?.owned);
  if (ownedIndex < 0) return text;
  lines.splice(ownedIndex, 1);
  return lines.join(newline);
}

function findHermesEventEnd(lines: readonly string[], eventIndex: number, limit: number): number {
  for (let i = eventIndex + 1; i < limit; i++) if (lines[i]!.trim() && !lines[i]!.startsWith('    ')) return i;
  return limit;
}

function yamlQuote(value: string): string { return `'${value.replaceAll("'", "''")}'`; }

function hermesCommandLine(line: string): { readonly command: string; readonly owned: boolean } | null {
  const match = line.match(/^ {4}-\s+command:\s*(.*?)\s*(?:#.*)?$/u);
  return match === null ? null : { command: yamlScalar(match[1]!), owned: line.includes(HERMES_HOOK_MARKER) };
}

function updateHermesAllowlist(text: string | null, action: 'install' | 'uninstall', definition: HermesReportingDefinition): string | null {
  let data: Record<string, unknown> = {};
  if (text !== null) {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Hermes hook allowlist must be a JSON object');
    data = value as Record<string, unknown>;
  }
  const rawApprovals: unknown = data['approvals'] ?? [];
  if (!Array.isArray(rawApprovals) || rawApprovals.some((entry: unknown) => !isObject(entry))) {
    throw new Error('Hermes hook allowlist approvals must be an array of objects');
  }
  const approvals = rawApprovals as unknown as Record<string, unknown>[];
  const matching = approvals.filter((entry) => (entry as { event?: unknown }).event === definition.event
    && (entry as { command?: unknown }).command === definition.command);
  if (action === 'uninstall') {
    const owned = matching.filter((entry) => (entry as { source?: unknown }).source === 'orca-companion');
    if (owned.length === 0) return text;
    data['approvals'] = approvals.filter((entry) => !owned.includes(entry));
  } else if (matching.length === 0) {
    data['approvals'] = [...approvals, { event: definition.event, command: definition.command,
      approved_at: new Date().toISOString(), script_mtime_at_approval: null, source: 'orca-companion' }];
  } else return text;
  return `${JSON.stringify(data, null, 2)}\n`;
}

function hasOwnedHermesHookApproval(definition: HermesReportingDefinition): boolean {
  try {
    const value: unknown = JSON.parse(readBoundedText(join(dirname(definition.configPath), 'shell-hooks-allowlist.json'), 256 * 1024));
    if (!isObject(value) || !Array.isArray(value['approvals'])) return false;
    return value['approvals'].some((entry) => isObject(entry) && entry['source'] === 'orca-companion'
      && entry['event'] === definition.event && entry['command'] === definition.command);
  } catch { return false; }
}

function hasHermesHookApproval(definition: HermesReportingDefinition): boolean {
  try {
    const value: unknown = JSON.parse(readBoundedText(join(dirname(definition.configPath), 'shell-hooks-allowlist.json'), 256 * 1024));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const approvals = (value as { approvals?: unknown }).approvals;
    return Array.isArray(approvals) && approvals.some((approval: unknown) => typeof approval === 'object'
      && approval !== null && !Array.isArray(approval)
      && (approval as { event?: unknown }).event === definition.event
      && (approval as { command?: unknown }).command === definition.command);
  } catch { return false; }
}

function hasHermesHookEntry(text: string, definition: HermesReportingDefinition): boolean {
  const lines = text.split('\n');
  const hooks = lines.findIndex((line) => /^hooks:\s*(?:#.*)?$/u.test(line));
  if (hooks < 0) return false;
  let eventStart = -1;
  for (let i = hooks + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() && !line.startsWith(' ')) break;
    if (new RegExp(`^  ${definition.event}:\\s*(?:#.*)?$`, 'u').test(line)) { eventStart = i; break; }
  }
  if (eventStart < 0) return false;
  for (let i = eventStart + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() && !line.startsWith('    ')) break;
    const match = line.match(/^ {4}-\s+command:\s*(.*?)\s*(?:#.*)?$/u);
    if (match && yamlScalar(match[1]!) === definition.command) return true;
  }
  return false;
}

function yamlScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replaceAll("''", "'");
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try { return JSON.parse(trimmed) as string; } catch { return ''; }
  }
  return trimmed;
}

function readReportingTrampoline(): string {
  const root = process.env['XDG_DATA_HOME'] || join(homedir(), '.local', 'share');
  return readBoundedText(join(root, 'orca-companion', 'worker-reporting', 'report.mjs'), 65536);
}

function readBoundedText(path: string, maxBytes: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('Native file exceeds bounds');
    const data = Buffer.alloc(stat.size);
    if (readSync(fd, data, 0, data.length, 0) !== data.length) throw new Error('Native file changed');
    return new TextDecoder('utf8', { fatal: true }).decode(data);
  } finally { closeSync(fd); }
}

/** Generated per-launch receiver for Hermes' resume-capable pre_llm_call hook. */
export function hermesReporterSource(reportPath: string, runtimeReportPath: string): string {
  return `import { appendFileSync, readFileSync } from 'node:fs';
let text = ''; for await (const chunk of process.stdin) { text += chunk; if (Buffer.byteLength(text) > 65536) process.exit(2); }
const p = JSON.parse(text), runtime = JSON.parse(readFileSync(${JSON.stringify(runtimeReportPath)}, 'utf8'));
if (p.hook_event_name !== 'pre_llm_call' || typeof p.session_id !== 'string' || typeof p.cwd !== 'string') process.exit(2);
appendFileSync(${JSON.stringify(reportPath)}, JSON.stringify({ harness: 'hermes', sessionId: p.session_id, transcriptPath: 'hermes-session:' + p.session_id, cwd: p.cwd, observedAt: new Date().toISOString(), stateRoot: runtime.stateRoot, runtimeRoots: runtime.writableRoots }) + '\\n', { mode: 0o600 });
`;
}

function nativeStateRoot(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return resolve(env['HERMES_HOME'] || join(homedir(), '.hermes'));
}

function launch(input: WorkerHarnessLaunchInput, resume?: CandidateResume) {
  if (input.modelSelection.effort !== null) throw new Error('Hermes 当前 launch 不支持 effort override');
  return prepareCandidateLaunch({ harness: 'hermes', executable: 'hermes', input,
    ...(resume === undefined ? {} : { resume }),
    // Classic REPL registers YAML hooks and pins the local backend to launch cwd.
    arguments: () => ['--cli', '--model', input.modelSelection.model,
      ...(resume === undefined ? [] : ['--resume', resume.sessionId])],
    reporterSource: hermesReporterSource,
    checkSetup: () => { if (!hermesReportingInstalled()) throw Object.assign(new Error('Hermes Session 报告 hook 未安装'), { code: 'worker_reporting_missing' }); },
    verifyResume: async (workspace, original) => {
      const identity = await readHermesTranscriptIdentity(original.transcriptRef, workspace);
      if (!('providerSessionId' in identity) || identity.providerSessionId !== original.sessionId) throw new Error('Hermes 原 Session 身份不可证明');
    },
  });
}

type ExportedSession = {
  readonly id?: unknown;
  readonly cwd?: unknown;
  readonly parent_session_id?: unknown;
  readonly end_reason?: unknown;
  readonly message_count?: unknown;
  readonly rewind_count?: unknown;
  readonly archived?: unknown;
  readonly model_config?: unknown;
  readonly messages?: unknown;
};

type ExportedMessage = { readonly id: number; readonly active: number; readonly compacted: number; readonly role: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isExportedMessage(value: unknown): value is ExportedMessage {
  return isObject(value) && Number.isSafeInteger(value['id']) && typeof value['active'] === 'number'
    && typeof value['compacted'] === 'number' && typeof value['role'] === 'string';
}

/** Checks only fields returned by SessionDB.export_session/get_messages in the installed Hermes source. */
export function validateHermesExportedSession(value: unknown, expectedId: string, workspace?: string): value is ExportedSession & { id: string; cwd: string; messages: ExportedMessage[] } {
  if (!isObject(value)) return false;
  const session = value as ExportedSession;
  if (session.id !== expectedId || typeof session.cwd !== 'string' || !isSamePath(session.cwd, workspace)
    || session.parent_session_id != null || session.end_reason === 'compression'
    || session.archived !== 0 || !Number.isInteger(session.rewind_count) || session.rewind_count !== 0
    || !Number.isInteger(session.message_count) || !Array.isArray(session.messages) || session.messages.length === 0
    || session.messages.length !== session.message_count || session.messages.length > 20000) return false;
  let modelConfig: unknown = session.model_config;
  if (typeof modelConfig === 'string') {
    try { modelConfig = JSON.parse(modelConfig) as unknown; } catch { return false; }
  }
  if (typeof modelConfig !== 'object' || modelConfig === null || Array.isArray(modelConfig)
    || '_branched_from' in modelConfig || '_delegate_from' in modelConfig) return false;
  let lastMessageId = -1;
  const messages: ExportedMessage[] = [];
  for (const entry of session.messages) {
    if (!isExportedMessage(entry) || entry.id <= lastMessageId || entry.active !== 1 || entry.compacted !== 0) return false;
    lastMessageId = entry.id;
    messages.push(entry);
  }
  return true;
}

function isSamePath(path: string, expected?: string): boolean {
  if (expected === undefined) return isAbsolute(path);
  try { return realpathSync(path) === realpathSync(expected); } catch { return false; }
}

async function exportHermesSession(sessionId: string): Promise<ExportedSession | null> {
  if (!SESSION_ID.test(sessionId)) return null;
  const output = await runProcess({ executable: 'hermes', args: ['sessions', 'export', '--session-id', sessionId, '-'], cwd: process.cwd(),
    env: process.env as Record<string, string>, timeoutMs: 15000, limits: { maxBytes: MAX_EXPORT_BYTES, maxLines: 20000 } });
  if (output.kind !== 'completed' || output.exitCode !== 0 || output.stdout.truncated) return null;
  try {
    const text = output.stdout.text.trim();
    const parsed: unknown = JSON.parse(text);
    if (isObject(parsed)) return parsed;
  } catch {
    const rows = output.stdout.text.trim().split('\n');
    if (rows.length === 1) {
      try {
        const row: unknown = JSON.parse(rows[0]!);
        return isObject(row) ? row : null;
      } catch { return null; }
    }
  }
  return null;
}

export async function readHermesTranscriptIdentity(transcriptRef: string, workspace?: string): Promise<{ readonly providerSessionId: string } | { readonly kind: 'transcript_unavailable'; readonly reason: string }> {
  const prefix = 'hermes-session:';
  if (!transcriptRef.startsWith(prefix)) return { kind: 'transcript_unavailable', reason: 'Hermes 精确 Session export 引用无效' };
  const id = transcriptRef.slice(prefix.length), session = await exportHermesSession(id);
  return session && validateHermesExportedSession(session, id, workspace)
    ? { providerSessionId: id }
    : { kind: 'transcript_unavailable', reason: 'Hermes 公开 Session export 未证明精确身份' };
}

function validHermesReport(input: ProveHarnessSessionInput): boolean {
  const p: HarnessSessionReport = input.report;
  if (p.harness !== 'hermes' || p.sessionId === null || p.transcriptPath === null || p.cwd === null || p.observedAt === null || p.stateRoot == null || !p.runtimeRoots?.length) return false;
  const at = Date.parse(p.observedAt), from = Date.parse(input.dispatchStartedAt), end = Date.parse(input.bindingDeadlineAt);
  try {
  return SESSION_ID.test(p.sessionId) && Number.isFinite(at) && Number.isFinite(from) && Number.isFinite(end) && at >= from && at <= end
      && realpathSync(p.cwd) === realpathSync(input.workspace)
      && realpathSync(p.stateRoot) === realpathSync(input.expectedStateRoot)
      && p.runtimeRoots.includes(nativeStateRoot())
      && p.transcriptPath === `hermes-session:${p.sessionId}`;
  } catch { return false; }
}

export async function inspectHermesTranscript(transcriptRef: string): Promise<HarnessTranscriptCoverageResult> {
  const prefix = 'hermes-session:';
  if (!transcriptRef.startsWith(prefix)) return { kind: 'transcript_unavailable', reason: 'Hermes 精确 Session export 引用无效' };
  const id = transcriptRef.slice(prefix.length), session = await exportHermesSession(id);
  if (!session || !validateHermesExportedSession(session, id)) {
    return { kind: 'transcript_unavailable', reason: 'Hermes export 缺少一致的 active-message、rewind、branch、compression 或 cwd 元数据' };
  }
  const last = session.messages.at(-1)!.id;
  return { kind: 'covered', evidence: { coverage: 'partial',
    readableRange: { transcriptRef, fromEventRef: `message:${session.messages[0]!.id}`, toEventRef: `message:${last}` },
    gaps: [{ fromEventRef: 'message:0', toEventRef: `message:${session.messages[0]!.id}`,
      reason: 'Hermes public export omits inactive rows, including compacted history; its earlier boundary is not exposed' }],
    lastCompleteEventRef: `message:${last}` } };
}

export function hermesRecoveryMaterialPath(writableRoot: string, transcriptRef: string): string {
  const digest = createHash('sha256').update(transcriptRef).digest('hex').slice(0, 20);
  return join(resolve(writableRoot), 'hermes-recovery', digest + '.jsonl');
}

export async function prepareHermesRecoveryMaterial(
  transcriptRef: string,
  writableRoot: string,
  expectedEvidence: TranscriptCoverageEvidence,
): Promise<readonly string[] | null> {
  const prefix = 'hermes-session:';
  if (!transcriptRef.startsWith(prefix)) return null;
  const id = transcriptRef.slice(prefix.length);
  const session = await exportHermesSession(id);
  if (session === null || !validateHermesExportedSession(session, id)) return null;
  const first = session.messages[0]!, last = session.messages.at(-1)!;
  const evidence = {
    coverage: 'partial' as const,
    readableRange: { transcriptRef, fromEventRef: `message:${first.id}`, toEventRef: `message:${last.id}` },
    gaps: [{ fromEventRef: 'message:0', toEventRef: `message:${first.id}`,
      reason: 'Hermes public export omits inactive rows, including compacted history; its earlier boundary is not exposed' }],
    lastCompleteEventRef: `message:${last.id}`,
  };
  if (JSON.stringify(evidence) !== JSON.stringify(expectedEvidence)) return null;
  const materialPath = hermesRecoveryMaterialPath(writableRoot, transcriptRef);
  mkdirSync(dirname(materialPath), { recursive: true, mode: 0o700 });
  const jsonl = session.messages.map((message) => JSON.stringify(message)).join('\n') + '\n';
  if (Buffer.byteLength(jsonl, 'utf8') > MAX_EXPORT_BYTES) return null;
  writeFileSync(materialPath, jsonl, { encoding: 'utf8', mode: 0o600 });
  return [
    'Hermes public export derived JSONL (coverage remains bound to the original transcriptRef)',
    'transcriptRef: ' + transcriptRef,
    'material JSONL (one active exported message per line): ' + materialPath,
    'Use message:<id> references; export is partial because inactive/compacted history is not exposed.',
    'Do not access Hermes private databases or infer content beyond the reported coverage.',
  ];
}

export const hermesHarness: WorkerHarness = {
  id: 'hermes', prepareLaunch: (input) => launch(input),
  prepareReadOnlyLaunch: (input) => launch({ ...input, sandboxMode: 'read-only-local-control' }),
  prepareResume: (input) => launch(input, input),
  probe: async (selection) => {
    if (!hermesReportingInstalled()) return { kind: 'unavailable', stage: 'reporting', profile: 'bwrap-read-only', diagnostics: ['Hermes Session 报告 hook 未安装'], harnessVersion: null };
    return probeHarnessReadOnlyWorker('hermes', selection, { harnessExecutable: 'hermes' });
  },
  queryModels: () => Promise.resolve({ kind: 'unavailable', code: 'catalog_api_unavailable', message: 'Hermes 当前没有已核实的非交互模型目录接口' }),
  sessionPaths: (root, id) => candidateSessionPaths('hermes', root, id),
  installReporter: (paths) => installCandidateReporter(paths, hermesReporterSource(paths.reportPath, join(dirname(paths.reporterPath), 'native-runtime.json'))),
  proveSession: async (input) => {
    if (!validHermesReport(input)) return { kind: 'transcript_unavailable', reason: 'Hermes report 与原生 workspace/runtime 身份不一致' };
      const identity = await readHermesTranscriptIdentity(input.report.transcriptPath!, input.workspace);
    return 'providerSessionId' in identity && identity.providerSessionId === input.report.sessionId
      ? { kind: 'proven', proof: { providerSessionId: identity.providerSessionId, transcriptRef: input.report.transcriptPath!, observedAt: input.report.observedAt! } }
      : { kind: 'transcript_unavailable', reason: 'Hermes 公开 Session export 不匹配 hook 报告' };
  },
  readTranscriptIdentity: async ({ transcriptRef, workspace }) => readHermesTranscriptIdentity(transcriptRef, workspace),
  inspectTranscript: inspectHermesTranscript,
  recoveryInstructions: () => ['只通过 `hermes sessions export --session-id <exact-id> -` 读取会话；不得访问 Hermes 私有数据库。',
    '先由宿主调用 prepareHermesRecoveryMaterial，将与 coverage 一致的公开 export messages 写为 Utility 私有 JSONL。',
    '仅引用公开 export 中的 messages，事件引用格式为 message:<id>；coverage 为 partial，结构不完整时停止恢复。'],
};
