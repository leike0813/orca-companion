import { constants, closeSync, fstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { HarnessSessionReport, ProveHarnessSessionInput, WorkerHarness, WorkerHarnessLaunchInput } from '../../application/ports/worker-harness.js';
import type { HarnessTranscriptCoverageResult } from '../../application/ports/worker-harness.js';
import { candidateSessionPaths, installCandidateReporter, prepareCandidateLaunch, type CandidateResume } from './candidate-worker-launch.js';
import { probeHarnessReadOnlyWorker } from './read-only-execution-wrapper.js';
import { reportingCommand, reportingRoot, REPORT_TRAMPOLINE, readReportingJson, readReportingText } from './worker-harness-reporting.js';

const UUID_V7 = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[0-9a-f]{4}-([0-9a-f]{12})$/iu;
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const MAX_TRANSCRIPT_LINES = 20_000;
const REPORTER_ENV = 'ORCA_COMPANION_SESSION_REPORTER';

export type MuseReportingDefinition = {
  readonly configPath: string;
  readonly managedHooksPath: string;
  readonly event: 'SessionStart';
  readonly command: string;
  readonly managedHooksEnvVars: readonly string[];
  readonly hookEntry: Readonly<Record<string, unknown>>;
  readonly hooksFile: Readonly<Record<string, unknown>>;
};

/** Muse 1.3 managed hooks live in a separate hooks file referenced by settings.json. */
export function museReportingDefinition(env: Readonly<Record<string, string | undefined>> = process.env): MuseReportingDefinition {
  const configHome = env['XDG_CONFIG_HOME']?.trim() || join(env['HOME'] || homedir(), '.config');
  const command = reportingCommand();
  const hookEntry = { hooks: [{ type: 'command', command, timeout: 10 }] };
  const hooksFile = { hooks: { SessionStart: [hookEntry] } };
  return {
    configPath: join(configHome, 'muse', 'settings.json'),
    managedHooksPath: join(reportingRoot(env), 'muse-hooks.json'),
    event: 'SessionStart', command, managedHooksEnvVars: [REPORTER_ENV], hookEntry, hooksFile,
  };
}

export function museReportingInstalled(definition = museReportingDefinition()): boolean {
  try {
    const config = readReportingJson(definition.configPath);
    if (config['managed_hooks_path'] !== definition.managedHooksPath
      || !Array.isArray(config['managed_hooks_env_vars'])
      || !config['managed_hooks_env_vars'].includes(REPORTER_ENV)) return false;
    const hooks = readReportingJson(definition.managedHooksPath);
    const hookEvents = hooks['hooks'];
    const entries = typeof hookEvents === 'object' && hookEvents !== null && !Array.isArray(hookEvents)
      ? (hookEvents as Record<string, unknown>)[definition.event] : undefined;
    return Array.isArray(entries) && entries.some((entry) => JSON.stringify(entry) === JSON.stringify(definition.hookEntry))
      && readReportingTrampoline() === REPORT_TRAMPOLINE;
  } catch { return false; }
}

/** Updates Muse's dedicated managed hooks file and preserves unrelated settings and hooks. */
export function maintainMuseReporting(action: 'install' | 'uninstall', env: Readonly<Record<string, string | undefined>> = process.env): void {
  const definition = museReportingDefinition(env);
  const path = definition.configPath;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(definition.managedHooksPath), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.orca-companion-lock`;
  const lock = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    const configSnapshot = readMuseSnapshot(path);
    const hooksSnapshot = readMuseSnapshot(definition.managedHooksPath);
    const config = parseMuseSnapshot(configSnapshot);
    const configuredPath = config['managed_hooks_path'];
    if (configuredPath !== undefined && configuredPath !== definition.managedHooksPath) {
      throw new Error('Muse already uses a different managed hooks file');
    }
    const rawEnvVars = config['managed_hooks_env_vars'];
    if (rawEnvVars !== undefined && (!Array.isArray(rawEnvVars) || !rawEnvVars.every((value) => typeof value === 'string'))) {
      throw new Error('Muse managed_hooks_env_vars is not a string array');
    }
    const hooksFile = parseMuseSnapshot(hooksSnapshot);
    const rawHooks = hooksFile['hooks'];
    if (rawHooks !== undefined && (typeof rawHooks !== 'object' || rawHooks === null || Array.isArray(rawHooks))) {
      throw new Error('Muse managed hooks must be an object');
    }
    const hooks = (rawHooks ?? {}) as Record<string, unknown>;
    const rawEvents = hooks[definition.event];
    if (rawEvents !== undefined && !Array.isArray(rawEvents)) throw new Error('Muse SessionStart hooks must be an array');
    const entries = (rawEvents ?? []) as unknown[];
    const hasEntry = entries.some((entry) => JSON.stringify(entry) === JSON.stringify(definition.hookEntry));
    const conflictingEntry = entries.some((entry) => {
      const configured = record(entry);
      const hooks = configured?.['hooks'];
      return Array.isArray(hooks) && hooks.some((hook) => record(hook)?.['command'] === definition.command)
        && JSON.stringify(entry) !== JSON.stringify(definition.hookEntry);
    });
    if (action === 'install' && conflictingEntry) throw new Error('Muse SessionStart hook command has conflicting configuration');
    const nextEntries = action === 'install'
      ? hasEntry ? entries : [...entries, definition.hookEntry]
      : entries.filter((entry) => JSON.stringify(entry) !== JSON.stringify(definition.hookEntry));
    if (JSON.stringify(rawEvents ?? []) !== JSON.stringify(nextEntries)) {
      if (nextEntries.length === 0) delete hooks[definition.event];
      else hooks[definition.event] = nextEntries;
      if (Object.keys(hooks).length === 0) delete hooksFile['hooks'];
      else hooksFile['hooks'] = hooks;
    }

    const envVars = rawEnvVars ?? [];
    if (action === 'install') {
      config['managed_hooks_path'] = definition.managedHooksPath;
      config['managed_hooks_env_vars'] = [...new Set([...envVars, REPORTER_ENV])];
      if (JSON.stringify(hooksFile) !== JSON.stringify(parseMuseSnapshot(hooksSnapshot))) writeMuseJson(definition.managedHooksPath, hooksFile, hooksSnapshot);
      if (JSON.stringify(config) !== JSON.stringify(parseMuseSnapshot(configSnapshot))) writeMuseJson(path, config, configSnapshot);
    } else {
      const hasOtherHooks = Object.values(hooks).some((value) => Array.isArray(value) && value.length > 0);
      if (!hasOtherHooks && config['managed_hooks_path'] === definition.managedHooksPath) delete config['managed_hooks_path'];
      const remainingEnvVars = envVars.filter((value) => value !== REPORTER_ENV);
      if (remainingEnvVars.length === 0) delete config['managed_hooks_env_vars'];
      else config['managed_hooks_env_vars'] = remainingEnvVars;
      if (JSON.stringify(config) !== JSON.stringify(parseMuseSnapshot(configSnapshot))) writeMuseJson(path, config, configSnapshot);
      if (JSON.stringify(hooksFile) !== JSON.stringify(parseMuseSnapshot(hooksSnapshot))) writeMuseJson(definition.managedHooksPath, hooksFile, hooksSnapshot);
    }
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
  }
}

function readMuseSnapshot(path: string): string | null {
  try { return readReportingText(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function parseMuseSnapshot(snapshot: string | null): Record<string, unknown> {
  if (snapshot === null) return {};
  const value: unknown = JSON.parse(snapshot);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Muse configuration must be an object');
  return value as Record<string, unknown>;
}

function writeMuseJson(path: string, value: Record<string, unknown>, expectedSnapshot: string | null): void {
  const temporary = `${path}.orca-companion-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  try {
    assertMuseSnapshot(path, expectedSnapshot);
    renameSync(temporary, path);
    if (JSON.stringify(readReportingJson(path)) !== JSON.stringify(value)) throw new Error('Muse hook configuration readback failed');
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* Rename already consumed the temporary file. */ }
    throw error;
  }
}

export function assertMuseSnapshot(path: string, expectedSnapshot: string | null): void {
  if (readMuseSnapshot(path) !== expectedSnapshot) throw new Error('Muse hook configuration changed during update');
}

function readReportingTrampoline(): string {
  return readBoundedText(join(reportingRoot(), 'report.mjs'), 65536);
}

export function museNativeDataRoot(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const dataHome = env['XDG_DATA_HOME']?.trim() || join(env['HOME'] || homedir(), '.local', 'share');
  return join(dataHome, 'muse');
}

function nativeSessionsRoot(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return join(museNativeDataRoot(env), 'sessions');
}

function readBoundedText(path: string, maxBytes: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) throw new Error('Native file exceeds bounds');
    const bytes = Buffer.alloc(stat.size);
    if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) throw new Error('Native file changed');
    return new TextDecoder('utf8', { fatal: true }).decode(bytes);
  } finally { closeSync(fd); }
}

function dateParts(date: Date, utc: boolean): readonly string[] {
  const year = utc ? date.getUTCFullYear() : date.getFullYear();
  const month = (utc ? date.getUTCMonth() : date.getMonth()) + 1;
  const day = utc ? date.getUTCDate() : date.getDate();
  return [String(year), String(month).padStart(2, '0'), String(day).padStart(2, '0')];
}

/** Resolve only the UUIDv7-derived date shards; never enumerate sessions or choose by mtime. */
export function museTranscriptCandidates(sessionId: string, sessionsRoot = nativeSessionsRoot()): readonly string[] {
  const match = UUID_V7.exec(sessionId);
  if (!match) return [];
  const startedAt = Number.parseInt(`${match[1]}${match[2]}`, 16);
  if (!Number.isSafeInteger(startedAt) || startedAt <= 0) return [];
  const day = 24 * 60 * 60 * 1000;
  const candidates = new Set<string>();
  for (const offset of [0, -day, day]) {
    const date = new Date(startedAt + offset);
    for (const utc of [false, true]) candidates.add(join(sessionsRoot, ...dateParts(date, utc), sessionId, 'session.jsonl'));
  }
  return [...candidates];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Muse retained_frame children contain the original JSON record as record_json. */
export function unwrapMuseRecords(envelope: Record<string, unknown>): readonly Record<string, unknown>[] | null {
  if ('retained_marker' in envelope) return envelope['retained_marker'] === 'omitted_live_only' ? [] : null;
  const retainedFrame = envelope['retained_frame'] === true || envelope['record_type'] === 'retained_frame';
  if (!retainedFrame && !('children' in envelope)) return [envelope];
  if (!retainedFrame || envelope['frame_schema_version'] !== 1 || !Array.isArray(envelope['children'])) return null;
  const records: Record<string, unknown>[] = [];
  for (const child of envelope['children']) {
    const raw = record(child)?.['record_json'];
    if (typeof raw !== 'string') return null;
    let nested: unknown;
    try { nested = JSON.parse(raw); } catch { return null; }
    const parsed = record(nested);
    if (parsed === null) return null;
    records.push(parsed);
  }
  return records;
}

export type MuseTranscript = {
  readonly sessionId: string;
  readonly workspace: string | null;
  readonly records: readonly Record<string, unknown>[];
  readonly userEvents: readonly number[];
  readonly assistantEvents: readonly number[];
};

export function parseMuseTranscript(text: string, sessionId: string): MuseTranscript | null {
  if (!UUID_V7.test(sessionId) || Buffer.byteLength(text, 'utf8') > MAX_TRANSCRIPT_BYTES) return null;
  const lines = text.split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length === 0 || lines.length > MAX_TRANSCRIPT_LINES) return null;
  const records: Record<string, unknown>[] = [];
  for (const line of lines) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { return null; }
    const envelope = record(value);
    if (envelope === null) return null;
    const unwrapped = unwrapMuseRecords(envelope);
    if (unwrapped === null) return null;
    if (records.length + unwrapped.length > MAX_TRANSCRIPT_LINES) return null;
    records.push(...unwrapped);
  }
  let workspace: string | null = null;
  const userEvents: number[] = [];
  const assistantEvents: number[] = [];
  for (let index = 0; index < records.length; index++) {
    const item = records[index]!;
    const payload = record(item['payload']);
    const payloadType = item['payload_type'];
    if (payload === null || !['snapshot', 'event'].includes(String(item['record_type']))) return null;
    if (payloadType === 'runtime.session.metadata' || payloadType === 'runtime.session.route_facts') {
      const root = record(payload['record'])?.[payloadType === 'runtime.session.metadata' ? 'workspace_root' : 'cwd'];
      if (typeof root !== 'string' || !isAbsolute(root)) return null;
      const normalized = resolve(root);
      if (workspace !== null && workspace !== normalized) return null;
      workspace = normalized;
    } else if (payloadType === 'session.workspace_branch.observed' || payloadType === 'run.model.configured'
      || payloadType === 'runtime.model_reconfigure.completed') {
      if (record(payload['record']) === null) return null;
    } else if (payloadType === 'runtime.user_intent.accepted') {
      userEvents.push(index);
    } else if (payloadType === 'runtime.session') {
      const event = record(payload?.['event']);
      if (typeof event?.['kind'] !== 'string' || event['kind'].length === 0) return null;
      if (event?.['kind'] === 'assistant_message_committed') assistantEvents.push(index);
    } else return null;
  }
  return { sessionId, workspace, records, userEvents, assistantEvents };
}

function readMuseTranscript(sessionId: string): { readonly path: string; readonly transcript: MuseTranscript } | null {
  const existing = museTranscriptCandidates(sessionId).filter((path) => {
    try { return realpathSync(path) === resolve(path); } catch { return false; }
  });
  if (existing.length !== 1) return null;
  try {
    const path = existing[0]!;
    const transcript = parseMuseTranscript(readBoundedText(path, MAX_TRANSCRIPT_BYTES), sessionId);
    return transcript === null ? null : { path, transcript };
  } catch { return null; }
}

export function museReporterSource(reportPath: string, runtimeReportPath: string): string {
  return `import { appendFileSync, readFileSync } from 'node:fs';
let text = ''; for await (const chunk of process.stdin) { text += chunk; if (Buffer.byteLength(text) > 65536) process.exit(2); }
const p = JSON.parse(text), runtime = JSON.parse(readFileSync(${JSON.stringify(runtimeReportPath)}, 'utf8'));
if (p.hook_event_name !== 'SessionStart' || typeof p.session_id !== 'string' || typeof p.cwd !== 'string') process.exit(2);
appendFileSync(${JSON.stringify(reportPath)}, JSON.stringify({ harness: 'muse', sessionId: p.session_id, transcriptPath: 'muse-session:' + p.session_id, cwd: p.cwd, observedAt: new Date().toISOString(), stateRoot: runtime.stateRoot, runtimeRoots: runtime.writableRoots }) + '\\n', { mode: 0o600 });
`;
}

function launch(input: WorkerHarnessLaunchInput, resume?: CandidateResume) {
  if (input.modelSelection.effort !== null) throw new Error('Muse has no verified reasoning-effort capability');
  return prepareCandidateLaunch({
    harness: 'muse', executable: 'muse', input, ...(resume === undefined ? {} : { resume }),
    arguments: () => [
      '--trust-workspace', '--model', input.modelSelection.model,
      ...(input.modelSelection.effort === null ? [] : ['--reasoning-effort', input.modelSelection.effort]),
      ...(resume === undefined ? [] : ['resume', resume.sessionId]),
    ],
    reporterSource: museReporterSource,
    checkSetup: () => {
      if (!museReportingInstalled()) throw Object.assign(new Error('Muse SessionStart 报告 hook 未安装'), { code: 'worker_reporting_missing' });
    },
    verifyResume: async (workspace, original) => {
      const identity = await readMuseTranscriptIdentity({ transcriptRef: original.transcriptRef, workspace });
      if (!('providerSessionId' in identity) || identity.providerSessionId !== original.sessionId) throw new Error('Muse 原 Session 身份不可证明');
    },
  });
}

export function readMuseTranscriptIdentity(input: { readonly transcriptRef: string; readonly workspace: string }): Promise<
  { readonly providerSessionId: string } | { readonly kind: 'transcript_unavailable'; readonly reason: string }
> {
  const prefix = 'muse-session:';
  if (!input.transcriptRef.startsWith(prefix)) return Promise.resolve({ kind: 'transcript_unavailable', reason: 'Muse transcript 引用无效' });
  const sessionId = input.transcriptRef.slice(prefix.length);
  const result = readMuseTranscript(sessionId);
  try {
    if (result !== null && result.transcript.sessionId === sessionId && result.transcript.workspace !== null
      && realpathSync(result.transcript.workspace) === realpathSync(input.workspace)) return Promise.resolve({ providerSessionId: sessionId });
  } catch { /* Paths that cannot be independently resolved are unavailable. */ }
  return Promise.resolve({ kind: 'transcript_unavailable', reason: 'Muse 原生 session.jsonl 未证明精确 Session/workspace' });
}

function reportValid(input: ProveHarnessSessionInput): boolean {
  const report: HarnessSessionReport = input.report;
  if (report.harness !== 'muse' || report.sessionId === null || report.transcriptPath === null || report.cwd === null
    || report.observedAt === null || report.stateRoot == null || !report.runtimeRoots?.length) return false;
  const at = Date.parse(report.observedAt), from = Date.parse(input.dispatchStartedAt), until = Date.parse(input.bindingDeadlineAt);
  try {
    return UUID_V7.test(report.sessionId) && report.transcriptPath === `muse-session:${report.sessionId}`
      && Number.isFinite(at) && at >= from && at <= until
      && realpathSync(report.cwd) === realpathSync(input.workspace)
      && realpathSync(report.stateRoot) === realpathSync(input.expectedStateRoot)
      && report.runtimeRoots.some((root) => realpathSync(root) === realpathSync(museNativeDataRoot()));
  } catch { return false; }
}

async function proveMuseSession(input: ProveHarnessSessionInput) {
  if (!reportValid(input)) return { kind: 'transcript_unavailable' as const, reason: 'Muse report 与精确 workspace/runtime 身份不匹配' };
  const identity = await readMuseTranscriptIdentity({ transcriptRef: input.report.transcriptPath!, workspace: input.workspace });
  return 'providerSessionId' in identity && identity.providerSessionId === input.report.sessionId
    ? { kind: 'proven' as const, proof: { providerSessionId: identity.providerSessionId, transcriptRef: input.report.transcriptPath!, observedAt: input.report.observedAt! } }
    : { kind: 'transcript_unavailable' as const, reason: 'Muse native session.jsonl 与 SessionStart 报告不匹配' };
}

export function inspectMuseTranscript(transcriptRef: string): Promise<HarnessTranscriptCoverageResult> {
  if (!transcriptRef.startsWith('muse-session:')) return Promise.resolve({ kind: 'transcript_unavailable', reason: 'Muse transcript 引用无效' });
  const sessionId = transcriptRef.slice('muse-session:'.length);
  const result = readMuseTranscript(sessionId);
  if (result === null || result.transcript.userEvents.length === 0 || result.transcript.assistantEvents.length === 0) {
    return Promise.resolve({ kind: 'transcript_unavailable', reason: 'Muse native history 缺失或没有完整 user/assistant 活动' });
  }
  const first = Math.min(result.transcript.userEvents[0]!, result.transcript.assistantEvents[0]!);
  const last = Math.max(result.transcript.userEvents.at(-1)!, result.transcript.assistantEvents.at(-1)!);
  return Promise.resolve({ kind: 'covered', evidence: { coverage: 'complete', readableRange: { transcriptRef, fromEventRef: `record:${first}`, toEventRef: `record:${last}` }, gaps: [], lastCompleteEventRef: `record:${last}` } });
}

export const museHarness: WorkerHarness = {
  id: 'muse',
  prepareLaunch: (input) => launch(input),
  prepareReadOnlyLaunch: (input) => launch({ ...input, sandboxMode: 'read-only-local-control' }),
  prepareResume: (input) => launch(input, input),
  probe: async (selection) => {
    if (!museReportingInstalled()) return { kind: 'unavailable', stage: 'reporting', profile: 'bwrap-read-only', diagnostics: ['Muse SessionStart 报告 hook 未安装'], harnessVersion: null };
    return probeHarnessReadOnlyWorker('muse', selection, { harnessExecutable: 'muse' });
  },
  // The SDK's model/list is available through the separate MSP serve protocol; no verified one-shot CLI catalog command exists.
  queryModels: () => Promise.resolve({ kind: 'unavailable', code: 'catalog_transport_unavailable', message: 'Muse 模型目录仅能通过 MSP model/list 查询；当前没有可安全复用的非交互 CLI transport' }),
  sessionPaths: (root, id) => candidateSessionPaths('muse', root, id),
  installReporter: (paths) => installCandidateReporter(paths, museReporterSource(paths.reportPath, join(paths.reporterPath, '..', 'native-runtime.json'))),
  proveSession: proveMuseSession,
  readTranscriptIdentity: readMuseTranscriptIdentity,
  inspectTranscript: inspectMuseTranscript,
  recoveryInstructions: () => [
    '只读取由 Muse SessionStart 报告绑定的 UUIDv7 session.jsonl；不得枚举后选择最近会话。',
    '以 record:N 引用 retained record 顺序；保留 retained_frame 的 children[].record_json 原生顺序。',
    'UTF-8、JSONL、workspace_root/cwd 或活动 user/assistant 事件缺失时停止恢复。',
  ],
};
