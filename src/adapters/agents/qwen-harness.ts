import { createHash } from 'node:crypto';
import {
  closeSync, constants as fsConstants, fstatSync, lstatSync, mkdirSync, openSync, readSync,
  realpathSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  HarnessSessionReport, HarnessTranscriptCoverageResult, HarnessTranscriptProofResult,
  PreparedHarnessTerminal, ProveHarnessSessionInput, WorkerHarnessLaunchInput,
  WorkerModelCatalogResult,
} from '../../application/ports/worker-harness.js';
import { createWorkerHarness } from '../../application/ports/worker-harness.js';
import type { TranscriptGap } from '../../application/recovery/recovery-capsule.js';
import type { PreparedTerminalStrategy } from '../../application/worker-launch.js';
import { workerModelSelectionSchema } from '../../domain/model-configuration.js';
import { CODEX_MODEL_DESCRIPTOR_VERSION, codexModelLaunchCommand, writeCodexModelLaunch } from './codex-model-launcher.js';
import type { CodexModelLaunchDescriptor } from './codex-model-launcher.js';
import { probeHarnessReadOnlyWorker, assertReadOnlyExecutionWrapperAvailable } from './read-only-execution-wrapper.js';

export const QWEN_HARNESS_ID = 'qwen-code';
const REPORT_FILENAME = 'session-start.jsonl';
const MAX_TRANSCRIPT_BYTES = 1024 * 1024;
const MAX_TRANSCRIPT_LINES = 20_000;
const MAX_SIDECAR_BYTES = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ARTIFACT_SUBTYPES = new Set(['session_artifact_event', 'session_artifact_snapshot']);
const NATIVE_READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;

type QwenRuntimeSidecar = {
  readonly schema_version: 1;
  readonly pid: number;
  readonly session_id: string;
  readonly work_dir: string;
  readonly hostname: string;
  readonly started_at: number;
  readonly qwen_version: string | null;
};
type TranscriptRecord = { readonly uuid: string; readonly parentUuid: string | null; readonly type: string; readonly subtype?: string };
type TranscriptHeader = { readonly sessionId: string; readonly cwd: string };

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }

export function qwenSessionIdFor(launchId: string): string {
  const hash = digest(launchId);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}
function samePath(left: string, right: string): boolean {
  try { return realpathSync(left) === realpathSync(right); } catch { return false; }
}
function sanitizedCwd(cwd: string): string {
  const normalized = process.platform === 'win32' ? cwd.toLowerCase() : cwd;
  return normalized.replace(/[^a-zA-Z0-9]/gu, '-');
}
function exactTranscriptPath(stateRoot: string, cwd: string, sessionId: string): string {
  return join(stateRoot, 'projects', sanitizedCwd(cwd), 'chats', `${sessionId}.jsonl`);
}
function exactSidecarPath(transcriptPath: string): string {
  return transcriptPath.slice(0, -'.jsonl'.length) + '.runtime.json';
}

function readBounded(path: string, maxBytes: number): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, NATIVE_READ_FLAGS);
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error('native path is not a regular file');
    const size = stat.size;
    if (size <= 0 || size > maxBytes) throw new Error('native file exceeds read bound');
    const bytes = Buffer.alloc(size);
    if (readSync(descriptor, bytes, 0, size, 0) !== size) throw new Error('native file changed during bounded read');
    return bytes;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function parseSidecar(path: string): QwenRuntimeSidecar | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readBounded(path, MAX_SIDECAR_BYTES)));
    if (!record(value) || value['schema_version'] !== 1 || !Number.isSafeInteger(value['pid']) || (value['pid'] as number) <= 0
      || typeof value['session_id'] !== 'string' || !UUID.test(value['session_id'])
      || typeof value['work_dir'] !== 'string' || !isAbsolute(value['work_dir'])
      || typeof value['hostname'] !== 'string' || value['hostname'].length === 0
      || typeof value['started_at'] !== 'number' || !Number.isFinite(value['started_at'])
      || !(value['qwen_version'] === null || typeof value['qwen_version'] === 'string')) return null;
    return value as QwenRuntimeSidecar;
  } catch { return null; }
}

function readTranscriptHeader(path: string): TranscriptHeader | null {
  try {
    const bytes = readBounded(path, MAX_TRANSCRIPT_BYTES);
    const first = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\n', 1)[0];
    if (!first) return null;
    const value: unknown = JSON.parse(first);
    if (!record(value) || typeof value['sessionId'] !== 'string' || !UUID.test(value['sessionId'])
      || typeof value['cwd'] !== 'string' || !isAbsolute(value['cwd'])) return null;
    return { sessionId: value['sessionId'], cwd: value['cwd'] };
  } catch { return null; }
}

function readTranscriptChain(path: string, expectedSessionId?: string): {
  readonly header: TranscriptHeader; readonly records: readonly TranscriptRecord[];
} | null {
  try {
    const bytes = readBounded(path, MAX_TRANSCRIPT_BYTES);
    const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\n');
    if (lines.length > MAX_TRANSCRIPT_LINES + 1 || lines.at(-1) !== '') return null;
    const records: TranscriptRecord[] = [];
    let header: TranscriptHeader | null = null;
    let prior: string | null = null;
    const seen = new Set<string>();
    for (const line of lines.slice(0, -1)) {
      if (!line.trim()) return null;
      const value: unknown = JSON.parse(line);
      if (!record(value) || typeof value['uuid'] !== 'string' || value['uuid'].length === 0
        || (value['parentUuid'] !== null && typeof value['parentUuid'] !== 'string')
        || typeof value['sessionId'] !== 'string' || typeof value['type'] !== 'string'
        || !['user', 'assistant', 'tool_result', 'system'].includes(value['type'])) return null;
      if (seen.has(value['uuid']) || (expectedSessionId !== undefined && value['sessionId'] !== expectedSessionId)) return null;
      seen.add(value['uuid']);
      if (header === null) {
        if (typeof value['cwd'] !== 'string' || !isAbsolute(value['cwd']) || !UUID.test(value['sessionId'])) return null;
        header = { sessionId: value['sessionId'], cwd: value['cwd'] };
        if (expectedSessionId !== undefined && header.sessionId !== expectedSessionId) return null;
      } else if (value['sessionId'] !== header.sessionId) return null;
      const subtype = value['subtype'];
      if (subtype !== undefined && typeof subtype !== 'string') return null;
      // Qwen excludes artifact rows when constructing the conversation chain; without their separate identity,
      // a transcript containing one cannot prove that its visible main chain is complete.
      if (value['type'] === 'system' && typeof subtype === 'string' && ARTIFACT_SUBTYPES.has(subtype)) return null;
      const parent = value['parentUuid'];
      if (records.length === 0 ? parent !== null : parent !== prior) return null;
      const item = { uuid: value['uuid'], parentUuid: parent, type: value['type'], ...(subtype === undefined ? {} : { subtype }) };
      records.push(item);
      prior = item.uuid;
    }
    return header === null || records.length === 0 ? null : { header, records };
  } catch { return null; }
}

function transcriptIdentity(transcriptRef: string, workspace: string): string | null {
  try {
    if (!isAbsolute(transcriptRef) || !isAbsolute(workspace) || lstatSync(transcriptRef).isSymbolicLink()) return null;
    const canonical = realpathSync(transcriptRef);
    if (canonical !== resolve(transcriptRef)) return null;
    const header = readTranscriptHeader(canonical);
    if (header === null || !samePath(header.cwd, workspace)) return null;
    const chats = dirname(canonical), project = dirname(chats), projects = dirname(project);
    if (basename(chats) !== 'chats' || basename(projects) !== 'projects'
      || basename(project) !== sanitizedCwd(resolve(workspace))
      || basename(canonical) !== `${header.sessionId}.jsonl`) return null;
    return header.sessionId;
  } catch { return null; }
}

function validReportRoots(report: HarnessSessionReport, expectedStateRoot: string): boolean {
  try {
    if (report.transcriptPath === null || report.stateRoot == null || report.runtimeRoots === undefined || report.runtimeRoots.length === 0) return false;
    if ([report.transcriptPath, report.stateRoot, ...report.runtimeRoots].some(path => lstatSync(path).isSymbolicLink())) return false;
    const transcript = realpathSync(report.transcriptPath), stateRoot = realpathSync(report.stateRoot);
    const roots = report.runtimeRoots.map(path => realpathSync(path));
    return stateRoot === realpathSync(expectedStateRoot) && roots.includes(stateRoot)
      && roots.some(root => inside(root, transcript))
      && transcript === realpathSync(exactTranscriptPath(stateRoot, resolve(report.cwd!), report.sessionId!));
  } catch { return false; }
}

function entrySource(reportPath: string): string {
  return `import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, constants as fsConstants, fstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join, relative, sep, isAbsolute } from 'node:path';
const REPORT = ${JSON.stringify(reportPath)};
const MAX = ${MAX_SIDECAR_BYTES};
const UUID = ${UUID.toString()};
const NATIVE_READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
const safe = value => typeof value === 'string' && UUID.test(value);
const inside = (root, path) => { const part = relative(root, path); return part === '' || (part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part)); };
const readJson = path => { let fd; try { fd = openSync(path, NATIVE_READ_FLAGS); const stat = fstatSync(fd); if (!stat.isFile() || stat.size <= 0 || stat.size > MAX) return null; const b = Buffer.alloc(stat.size); if (readSync(fd, b, 0, stat.size, 0) !== stat.size) return null; return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b)); } catch { return null; } finally { if (fd !== undefined) closeSync(fd); } };
const same = (a, b) => { try { return realpathSync(a) === realpathSync(b); } catch { return false; } };
const belongsTo = (pid, rootPid) => {
  if (pid === rootPid) return true;
  if (process.platform !== 'linux') return false;
  const seen = new Set();
  for (let depth = 0; depth < 16 && Number.isSafeInteger(pid) && pid > 0 && !seen.has(pid); depth++) {
    if (pid === rootPid) return true;
    seen.add(pid);
    try {
      const bytes = readFileSync('/proc/' + pid + '/stat');
      if (bytes.length === 0 || bytes.length > 4096) return false;
      const stat = bytes.toString('utf8');
      const close = stat.lastIndexOf(')');
      if (close < 0) return false;
      const fields = stat.slice(close + 2).trim().split(/\\s+/);
      pid = Number(fields[1]);
    } catch { return false; }
  }
  return false;
};
const payload = readJson(process.argv[2]);
const runtime = payload && readJson(payload.runtimeReportPath);
if (!payload || !runtime || typeof runtime.stateRoot !== 'string' || !Array.isArray(runtime.writableRoots)) process.exit(2);
const stateRoot = realpathSync(runtime.stateRoot), roots = [...new Set([runtime.stateRoot, ...runtime.writableRoots].map(path => realpathSync(path)))];
if (payload.expectedStateRoot && !same(stateRoot, payload.expectedStateRoot)) process.exit(2);
const started = Date.now(), deadline = started + payload.bindingTimeoutMs;
const child = spawn(payload.executable, payload.args, { cwd: payload.workspace, env: process.env, stdio: 'inherit' });
let closed = false, reported = false;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { if (!closed) child.kill(signal); });
child.on('error', () => { closed = true; process.exitCode = 1; });
child.on('close', (code, signal) => { closed = true; process.exitCode = typeof code === 'number' ? code : signal ? 1 : 0; });
const sleep = ms => new Promise(done => setTimeout(done, ms));
const slug = (process.platform === 'win32' ? payload.workspace.toLowerCase() : payload.workspace).replace(/[^a-zA-Z0-9]/g, '-');
const transcriptPath = join(stateRoot, 'projects', slug, 'chats', payload.sessionId + '.jsonl');
const sidecarPath = join(stateRoot, 'projects', slug, 'chats', payload.sessionId + '.runtime.json');
while (!closed && child.exitCode === null && child.signalCode === null && Date.now() <= deadline) {
  const sidecar = readJson(sidecarPath);
  if (sidecar && sidecar.schema_version === 1 && belongsTo(sidecar.pid, child.pid) && sidecar.session_id === payload.sessionId
    && typeof sidecar.work_dir === 'string' && same(sidecar.work_dir, payload.workspace)
    && typeof sidecar.started_at === 'number' && sidecar.started_at * 1000 >= started - 1000
    && sidecar.started_at * 1000 <= deadline && sidecar.hostname === hostname()) {
    const fd = (() => { try { return openSync(transcriptPath, NATIVE_READ_FLAGS); } catch { return undefined; } })();
    if (fd !== undefined) {
      try {
        const stat = fstatSync(fd), size = stat.size;
        if (!stat.isFile()) continue;
        const b = Buffer.alloc(Math.min(size, ${MAX_TRANSCRIPT_BYTES}));
        const n = b.length ? readSync(fd, b, 0, b.length, 0) : 0;
        const prefix = b.subarray(0, n), newline = prefix.indexOf(0x0a);
        if (newline < 0 && size > n) continue;
        const first = new TextDecoder('utf-8', { fatal: true }).decode(prefix.subarray(0, newline < 0 ? n : newline));
        const row = first ? JSON.parse(first) : null;
        const nativeRoots = roots.filter(root => inside(root, realpathSync(transcriptPath)));
        if (size > 0 && size <= ${MAX_TRANSCRIPT_BYTES} && row && row.sessionId === payload.sessionId
          && typeof row.cwd === 'string' && same(row.cwd, payload.workspace) && nativeRoots.length > 0
          && !closed && child.exitCode === null && child.signalCode === null) {
          appendFileSync(REPORT, JSON.stringify({ harness: 'qwen-code', sessionId: payload.sessionId,
            transcriptPath, cwd: payload.workspace, observedAt: new Date().toISOString(), stateRoot, runtimeRoots: roots }) + '\\n', { mode: 0o600 });
          reported = true; break;
        }
      } catch {} finally { closeSync(fd); }
    }
  }
  await sleep(50);
}
if (!reported && !closed) process.stderr.write('qwen-code session identity was not proved within the binding window\\n');
`;
}

export type QwenExecutionInput = WorkerHarnessLaunchInput & {
  readonly executable?: string;
  readonly bindingTimeoutMs?: number;
  readonly assertReadOnlyWrapperAvailable?: () => Promise<void>;
};
type QwenResumeInput = QwenExecutionInput & {
  readonly sessionId: string;
  readonly originalStateRoot: string;
  readonly transcriptRef: string;
};

function launch(input: QwenExecutionInput, resume?: QwenResumeInput): PreparedTerminalStrategy<PreparedHarnessTerminal> {
  if (!input.launchId || !workerModelSelectionSchema.safeParse(input.modelSelection).success || input.modelSelection.effort !== null) {
    throw new Error('Qwen requires a valid exact model ID with null effort');
  }
  const timeout = input.bindingTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 30_000) throw new Error('Qwen binding window must be bounded');
  const sessionId = resume?.sessionId ?? qwenSessionIdFor(input.launchId);
  if (!UUID.test(sessionId)) throw new Error('Qwen session ID must be a UUID');
  const title = `orca-companion:${QWEN_HARNESS_ID}:${digest(input.launchId).slice(0, 20)}`;
  return {
    kind: 'prepared_terminal', harness: QWEN_HARNESS_ID, activation: 'submit_draft', title,
    prepare: async ({ worktreePath }) => {
      if (!isAbsolute(worktreePath) || (input.stateRoot !== undefined && !isAbsolute(input.stateRoot))) throw new Error('Qwen launch paths must be absolute');
      const workspace = realpathSync(worktreePath);
      if (resume !== undefined) {
        if (!isAbsolute(resume.originalStateRoot) || transcriptIdentity(resume.transcriptRef, workspace) !== sessionId
          || !samePath(exactTranscriptPath(resume.originalStateRoot, workspace, sessionId), resume.transcriptRef)) {
          throw new Error('Qwen original session identity is unavailable');
        }
      }
      const readOnly = input.sandboxMode === 'read-only' || input.sandboxMode === 'read-only-local-control';
      if (readOnly) await (input.assertReadOnlyWrapperAvailable ?? assertReadOnlyExecutionWrapperAvailable)();
      const stateRoot = join(input.stateRoot ?? join(workspace, '.companion', QWEN_HARNESS_ID), digest(input.launchId).slice(0, 20));
      mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
      const reporterPath = input.sessionStartReporterPath ?? join(stateRoot, 'session-start.mjs');
      const reportPath = join(dirname(reporterPath), REPORT_FILENAME);
      const runtimeReportPath = join(dirname(reporterPath), 'native-runtime.json');
      const payloadPath = join(stateRoot, 'qwen-entry.json');
      writeFileSync(reportPath, '', { mode: 0o600 });
      writeFileSync(reporterPath, entrySource(reportPath), { mode: 0o600 });
      writeFileSync(payloadPath, JSON.stringify({
        executable: input.executable ?? 'qwen', workspace, sessionId,
        args: ['--model', input.modelSelection.model, '--chat-recording', '--yolo',
          ...(resume === undefined ? ['--session-id', sessionId] : ['--resume', sessionId])],
        runtimeReportPath, bindingTimeoutMs: timeout,
        ...(resume === undefined ? {} : { expectedStateRoot: resume.originalStateRoot }),
      }) + '\n', { mode: 0o600 });
      const descriptor: CodexModelLaunchDescriptor = {
        version: CODEX_MODEL_DESCRIPTOR_VERSION,
        executable: process.execPath,
        args: [reporterPath, payloadPath],
        harness: QWEN_HARNESS_ID,
        runtimeReportPath,
        ...(resume === undefined ? {} : { expectedStateRoot: resume.originalStateRoot }),
        ...(readOnly ? { readOnly: { workspace, stateRoot, reportDirectory: dirname(reportPath) } } : {}),
      };
      const paths = writeCodexModelLaunch({ stateRoot, descriptor });
      return { title, stateRoot, command: codexModelLaunchCommand(paths) };
    },
  };
}

export function createQwenWorkerLaunch(input: QwenExecutionInput): PreparedTerminalStrategy<PreparedHarnessTerminal> {
  return launch(input);
}
export function createQwenResumeLaunch(input: QwenResumeInput): PreparedTerminalStrategy<PreparedHarnessTerminal> {
  return launch(input, input);
}

const unavailable = (reason: string) => ({ kind: 'transcript_unavailable' as const, reason });

export function readQwenTranscriptIdentity(input: { readonly transcriptRef: string; readonly workspace: string }): Promise<
  { readonly providerSessionId: string } | { readonly kind: 'transcript_unavailable'; readonly reason: string }
> {
  const sessionId = transcriptIdentity(input.transcriptRef, input.workspace);
  return Promise.resolve(sessionId === null
    ? unavailable('Qwen transcript path, session ID, or cwd is unavailable')
    : { providerSessionId: sessionId });
}

function reportTime(value: string | null, start: string, deadline: string): boolean {
  const observed = Date.parse(value ?? ''), from = Date.parse(start), until = Date.parse(deadline);
  return Number.isFinite(observed) && Number.isFinite(from) && Number.isFinite(until) && until >= from && observed >= from && observed <= until;
}

export function proveQwenTranscript(input: ProveHarnessSessionInput): Promise<HarnessTranscriptProofResult> {
  const report = input.report;
  if (report.harness !== QWEN_HARNESS_ID || report.sessionId === null || report.transcriptPath === null || report.cwd === null
    || !samePath(report.cwd, input.workspace) || report.stateRoot == null
    || !reportTime(report.observedAt, input.dispatchStartedAt, input.bindingDeadlineAt)
    || !validReportRoots(report, input.expectedStateRoot)) {
    return Promise.resolve(unavailable('Qwen report identity, runtime roots, or dispatch window do not match'));
  }
  const sidecar = parseSidecar(exactSidecarPath(report.transcriptPath));
  const sessionId = transcriptIdentity(report.transcriptPath, input.workspace);
  if (sessionId !== report.sessionId || sidecar === null || sidecar.session_id !== sessionId
    || sidecar.pid <= 0 || !samePath(sidecar.work_dir, input.workspace)) {
    return Promise.resolve(unavailable('Qwen sidecar and transcript identity do not match'));
  }
  const observedAt = Date.parse(report.observedAt!);
  if (sidecar.started_at * 1000 > observedAt + 1000) {
    return Promise.resolve(unavailable('Qwen runtime sidecar is newer than its session report'));
  }
  return Promise.resolve({ kind: 'proven', proof: {
    providerSessionId: sessionId, transcriptRef: realpathSync(report.transcriptPath), observedAt: report.observedAt!,
  } });
}

export function inspectQwenTranscript(transcriptRef: string): Promise<HarnessTranscriptCoverageResult> {
  const chain = readTranscriptChain(transcriptRef);
  if (chain === null) {
    return Promise.resolve(unavailable('Qwen transcript is truncated, branched, contains artifacts, or has no provable unique main chain'));
  }
  const first = chain.records[0]!, last = chain.records.at(-1)!;
  const gaps: TranscriptGap[] = [];
  const evidence = {
    coverage: 'complete' as const,
    readableRange: { transcriptRef: resolve(transcriptRef), fromEventRef: first.uuid, toEventRef: last.uuid },
    gaps,
    lastCompleteEventRef: last.uuid,
  };
  return Promise.resolve({ kind: 'covered', evidence });
}

export const QWEN_RECOVERY_INSTRUCTIONS = [
  '仅读取精确 transcriptRef；首条记录的 sessionId/cwd、路径中的 sanitized cwd 与 session ID 必须一致。',
  'Qwen runtime sidecar 是 schema 1 的 <sessionId>.runtime.json；需匹配 pid、session_id、work_dir 与观察窗口。',
  'coverage 只在 transcript 有界、无损坏/重复/分叉且 parentUuid 形成唯一连续主链时为 complete；否则 unavailable。',
] as const;

export const qwenHarness = createWorkerHarness({
  id: QWEN_HARNESS_ID,
  prepareLaunch: createQwenWorkerLaunch,
  prepareReadOnlyLaunch: input => createQwenWorkerLaunch({ ...input, sandboxMode: 'read-only-local-control' }),
  prepareResume: createQwenResumeLaunch,
  probe: modelSelection => probeHarnessReadOnlyWorker(QWEN_HARNESS_ID, modelSelection),
  queryModels: (): Promise<WorkerModelCatalogResult> => Promise.resolve({
    kind: 'unavailable', code: 'catalog_api_unavailable', message: 'Qwen candidate requires a verified native exact model selection with null effort',
  }),
  sessionPaths: (root, launchId) => {
    const stateRoot = join(root, QWEN_HARNESS_ID), directory = join(stateRoot, 'reporters', digest(launchId).slice(0, 20));
    return { stateRoot, reporterPath: join(directory, 'session-start.mjs'), reportPath: join(directory, REPORT_FILENAME) };
  },
  installReporter: ({ reporterPath, reportPath }) => {
    mkdirSync(dirname(reporterPath), { recursive: true, mode: 0o700 });
    writeFileSync(reporterPath, entrySource(reportPath), { mode: 0o600 });
  },
  readTranscriptIdentity: readQwenTranscriptIdentity,
  proveSession: proveQwenTranscript,
  inspectTranscript: inspectQwenTranscript,
  recoveryInstructions: () => QWEN_RECOVERY_INSTRUCTIONS,
});
