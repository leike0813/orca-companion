import { constants, closeSync, fstatSync, lstatSync, linkSync, mkdirSync, openSync, readSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { HarnessSessionReport, ProveHarnessSessionInput, WorkerHarness, WorkerHarnessLaunchInput } from '../../application/ports/worker-harness.js';
import type { HarnessTranscriptCoverageResult } from '../../application/ports/worker-harness.js';
import type { TranscriptCoverageEvidence } from '../../application/recovery/recovery-capsule.js';
import { candidateSessionPaths, installCandidateReporter, prepareCandidateLaunch, type CandidateResume } from './candidate-worker-launch.js';
import { probeHarnessReadOnlyWorker } from './read-only-execution-wrapper.js';
import { reportingRoot, REPORT_TRAMPOLINE } from './worker-harness-reporting.js';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const SESSION_ID = /^[A-Za-z0-9_-]{8,128}$/u;

export type ClineReportingDefinition = { readonly modulePath: string; readonly source: string };

/** Cline 3.0.70 discovers global JS/TS modules below ~/.cline/plugins. */
export function clineReporterPluginSource(): string {
  const trampoline = join(reportingRoot(), 'report.mjs');
  return `import { spawnSync } from 'node:child_process';
export default {
  name: 'orca-companion-session-report',
  manifest: { capabilities: ['hooks'] },
  setup(_api, context) {
    const sessionId = context.session?.sessionId;
    const cwd = context.workspaceInfo?.rootPath;
    if (typeof sessionId !== 'string' || typeof cwd !== 'string' || !process.env.ORCA_COMPANION_SESSION_REPORTER) return;
    const result = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(trampoline)}], {
      input: JSON.stringify({ session_id: sessionId, cwd }), env: process.env,
      timeout: 8000, maxBuffer: 65536, stdio: ['pipe', 'ignore', 'ignore']
    });
    if (result.error || result.status !== 0) throw new Error('Session report forwarding failed');
  }
};
`;
}

export function clineReportingDefinition(env: Readonly<Record<string, string | undefined>> = process.env): ClineReportingDefinition {
  const clineDir = env['CLINE_DIR'] || join(homedir(), '.cline');
  return { modulePath: join(clineDir, 'plugins', 'orca-companion-session-report', 'index.js'), source: clineReporterPluginSource() };
}

export function clineReportingInstalled(definition = clineReportingDefinition()): boolean {
  try {
    if (readBoundedText(definition.modulePath, 65536) !== definition.source) return false;
    return readBoundedText(join(reportingRoot(), 'report.mjs'), 65536) === REPORT_TRAMPOLINE;
  } catch { return false; }
}

export function maintainClineReporting(action: 'install' | 'uninstall', definition = clineReportingDefinition()): void {
  const directory = dirname(definition.modulePath);
  const lockPath = join(directory, '.orca-companion-cline-reporting.lock');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockFd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  let temp: string | undefined;
  try {
    let current: string | null;
    try { current = readBoundedText(definition.modulePath, 65536); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') current = null; else throw error; }
    if (action === 'install') {
      if (current !== null && current !== definition.source) throw new Error('Cline plugin path is owned by different content');
      if (current === null) {
        temp = `${definition.modulePath}.orca-companion-${process.pid}.tmp`;
        writeFileSync(temp, definition.source, { flag: 'wx', mode: 0o600 });
        if (readBoundedOptional(definition.modulePath) !== null) throw new Error('Cline plugin appeared during install');
        linkSync(temp, definition.modulePath);
        unlinkSync(temp);
        temp = undefined;
      }
      if (readBoundedText(definition.modulePath, 65536) !== definition.source) throw new Error('Cline plugin install readback failed');
    } else if (current === definition.source) {
      if (readBoundedText(definition.modulePath, 65536) !== current) throw new Error('Cline plugin changed during uninstall');
      unlinkSync(definition.modulePath);
    } else if (current !== null) throw new Error('Cline plugin content changed; refusing to uninstall');
    if (action === 'uninstall' && readBoundedOptional(definition.modulePath) !== null) throw new Error('Cline plugin uninstall readback failed');
  } finally {
    closeSync(lockFd);
    if (temp !== undefined) { try { unlinkSync(temp); } catch { /* preserve primary error */ } }
    unlinkSync(lockPath);
  }
}

function readBoundedOptional(path: string): string | null {
  try { return readBoundedText(path, 65536); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
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

/** Generated per-launch receiver. The global plugin forwards only its exact root session and host workspace. */
export function clineReporterSource(reportPath: string, runtimeReportPath: string): string {
  return `import { appendFileSync, readFileSync } from 'node:fs';
let text = ''; for await (const chunk of process.stdin) { text += chunk; if (Buffer.byteLength(text) > 65536) process.exit(2); }
const p = JSON.parse(text), runtime = JSON.parse(readFileSync(${JSON.stringify(runtimeReportPath)}, 'utf8'));
if (typeof p.session_id !== 'string' || typeof p.cwd !== 'string') process.exit(2);
const transcriptPath = 'cline-session:' + p.session_id;
appendFileSync(${JSON.stringify(reportPath)}, JSON.stringify({ harness: 'cline', sessionId: p.session_id, transcriptPath, cwd: p.cwd, observedAt: new Date().toISOString(), stateRoot: runtime.stateRoot, runtimeRoots: runtime.writableRoots }) + '\\n', { mode: 0o600 });
`;
}

function clineDataDirs(env: Readonly<Record<string, string | undefined>> = process.env): { readonly dataDir: string; readonly sessionDataDir: string; readonly clineDir: string } {
  const clineDir = resolve(env['CLINE_DIR'] || join(homedir(), '.cline'));
  const dataDir = resolve(env['CLINE_DATA_DIR'] || join(clineDir, 'data'));
  const sessionDataDir = resolve(env['CLINE_SESSION_DATA_DIR'] || join(dataDir, 'sessions'));
  return { clineDir, dataDir, sessionDataDir };
}

function launch(input: WorkerHarnessLaunchInput, resume?: CandidateResume) {
  if (input.modelSelection.effort !== null) throw new Error('Cline 当前 launch 不支持 effort override');
  const separator = input.modelSelection.model.indexOf('/');
  const modelArgs = separator < 0 ? ['--model', input.modelSelection.model]
    : ['--provider', input.modelSelection.model.slice(0, separator), '--model', input.modelSelection.model.slice(separator + 1)];
  if (modelArgs.some((arg) => !arg.trim())) throw new Error('Cline provider/model selection invalid');
  return prepareCandidateLaunch({ harness: 'cline', executable: 'cline', input,
    ...(resume === undefined ? {} : { resume }),
    // Cline's interactive auto backend ignores its SDK env override; yolo forces a local runtime.
    arguments: (workspace) => ['--tui', '--yolo', '--cwd', workspace, ...modelArgs,
      ...(resume === undefined ? [] : ['--id', resume.sessionId])],
    reporterSource: clineReporterSource,
    checkSetup: () => { if (!clineReportingInstalled()) throw Object.assign(new Error('Cline Session 报告 plugin 未安装'), { code: 'worker_reporting_missing' }); },
    verifyResume: async (workspace, original) => {
      const proof = await readClineTranscriptIdentity(original.transcriptRef, workspace);
      if (!('providerSessionId' in proof) || proof.providerSessionId !== original.sessionId) throw new Error('Cline 原 Session 身份不可证明');
    },
  });
}

type ClineManifest = { readonly session_id?: unknown; readonly workspace_root?: unknown; readonly messages_path?: unknown; readonly status?: unknown; readonly ended_at?: unknown };
type ClineMessagesArtifact = { readonly version?: unknown; readonly sessionId?: unknown; readonly messages?: unknown };

function readJsonFile(path: string, maxBytes = MAX_FILE_BYTES): unknown {
  const resolved = resolve(path);
  if (!isAbsolute(path) || lstatSync(path).isSymbolicLink() || realpathSync(path) !== resolved) throw new Error('Unsafe native file');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) throw new Error('Native file exceeds bounds');
    const data = Buffer.alloc(stat.size);
    if (readSync(fd, data, 0, data.length, 0) !== data.length) throw new Error('Native file changed');
    return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(data)) as unknown;
  } finally { closeSync(fd); }
}

function manifestFor(transcriptRef: string): { readonly manifest: ClineManifest; readonly path: string } | null {
  try {
    const prefix = 'cline-session:';
    if (!transcriptRef.startsWith(prefix)) return null;
    const id = transcriptRef.slice(prefix.length);
    if (!SESSION_ID.test(id)) return null;
    const dirs = clineDataDirs();
    const manifestPath = join(dirs.sessionDataDir, id, `${id}.json`);
    const value: unknown = readJsonFile(manifestPath);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const manifest = value as ClineManifest;
    if (manifest.session_id !== id || typeof manifest.workspace_root !== 'string') return null;
    return { manifest, path: manifestPath };
  } catch { return null; }
}

function nativeMessagesPath(found: { readonly manifest: ClineManifest }, id: string): string {
  const path = typeof found.manifest.messages_path === 'string' && found.manifest.messages_path.length > 0
    ? found.manifest.messages_path : join(clineDataDirs().sessionDataDir, id, `${id}.messages.json`);
  if (!isAbsolute(path)) throw new Error('Cline messages path must be absolute');
  return path;
}

function readNativeMessages(found: { readonly manifest: ClineManifest }, id: string): unknown[] | null {
  try {
    const value = readJsonFile(nativeMessagesPath(found, id));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const artifact = value as ClineMessagesArtifact;
    return artifact.version === 1 && artifact.sessionId === id && Array.isArray(artifact.messages)
      && artifact.messages.length > 0 && artifact.messages.length <= 20000 ? artifact.messages : null;
  } catch { return null; }
}

export function readClineTranscriptIdentity(transcriptRef: string, workspace: string): Promise<{ readonly providerSessionId: string } | { readonly kind: 'transcript_unavailable'; readonly reason: string }> {
  const found = manifestFor(transcriptRef);
  try {
    const id = transcriptRef.slice('cline-session:'.length);
    if (found && readNativeMessages(found, id) !== null && typeof found.manifest.workspace_root === 'string'
      && realpathSync(found.manifest.workspace_root) === realpathSync(workspace)) {
      return Promise.resolve({ providerSessionId: id });
    }
  } catch { /* fail closed */ }
  return Promise.resolve({ kind: 'transcript_unavailable', reason: 'Cline 原生 manifest 未证明精确 Session 与 workspace' });
}

function reportValid(input: ProveHarnessSessionInput): boolean {
  const p: HarnessSessionReport = input.report;
  if (p.harness !== 'cline' || p.sessionId === null || p.transcriptPath === null || p.cwd === null || p.observedAt === null || p.stateRoot == null || !p.runtimeRoots?.length) return false;
  const at = Date.parse(p.observedAt), from = Date.parse(input.dispatchStartedAt), end = Date.parse(input.bindingDeadlineAt);
  try {
    const dirs = clineDataDirs();
    return SESSION_ID.test(p.sessionId) && Number.isFinite(at) && at >= from && at <= end
      && realpathSync(p.cwd) === realpathSync(input.workspace)
      && realpathSync(p.stateRoot) === realpathSync(input.expectedStateRoot)
      && p.runtimeRoots.includes(dirs.dataDir) && p.runtimeRoots.includes(dirs.clineDir)
      && manifestFor(p.transcriptPath)?.manifest.session_id === p.sessionId;
  } catch { return false; }
}

export function inspectClineTranscript(transcriptRef: string): Promise<HarnessTranscriptCoverageResult> {
  const found = manifestFor(transcriptRef);
  if (!found) return Promise.resolve({ kind: 'transcript_unavailable', reason: 'Cline 精确 Session manifest 不可读' });
  try {
    const id = transcriptRef.slice('cline-session:'.length);
    const messages = readNativeMessages(found, id);
    if (messages === null) throw new Error('messages unavailable');
    return Promise.resolve({ kind: 'covered', evidence: clineCoverage(nativeMessagesPath(found, id), messages) });
  } catch { return Promise.resolve({ kind: 'transcript_unavailable', reason: 'Cline 原生 messages artifact 不完整或超出读取边界' }); }
}

function clineCoverage(artifactRef: string, messages: readonly unknown[]): TranscriptCoverageEvidence {
  const last = `message:${messages.length - 1}`;
  const afterLast = `message:${messages.length}`;
  return { coverage: 'partial', readableRange: { transcriptRef: artifactRef, fromEventRef: 'message:0', toEventRef: last },
    gaps: [{ fromEventRef: afterLast, toEventRef: afterLast, reason: 'Cline public persisted messages may omit an in-flight or just-aborted turn' }], lastCompleteEventRef: last };
}

export function clineRecoveryMaterialPath(writableRoot: string, transcriptRef: string): string {
  const digest = createHash('sha256').update(transcriptRef).digest('hex').slice(0, 20);
  return join(resolve(writableRoot), 'cline-recovery', digest + '.jsonl');
}

export function prepareClineRecoveryMaterial(
  transcriptRef: string,
  writableRoot: string,
  expectedEvidence: TranscriptCoverageEvidence,
): readonly string[] | null {
  const found = manifestFor(transcriptRef);
  if (found === null) return null;
  try {
    const id = transcriptRef.slice('cline-session:'.length);
    const messages = readNativeMessages(found, id);
    if (messages === null) return null;
    const sourcePath = nativeMessagesPath(found, id);
    if (JSON.stringify(clineCoverage(sourcePath, messages)) !== JSON.stringify(expectedEvidence)) return null;
    const materialPath = clineRecoveryMaterialPath(writableRoot, transcriptRef);
    mkdirSync(dirname(materialPath), { recursive: true, mode: 0o700 });
    const jsonl = messages.map((message) => JSON.stringify(message)).join('\n') + '\n';
    if (Buffer.byteLength(jsonl, 'utf8') > MAX_FILE_BYTES) return null;
    writeFileSync(materialPath, jsonl, { encoding: 'utf8', mode: 0o600 });
    return [
      'Cline native persisted messages copied to bounded JSONL; coverage remains bound to the original transcriptRef',
      'transcriptRef: ' + transcriptRef,
      'material JSONL (one persisted message per line): ' + materialPath,
      'Use message:N references; persisted messages may omit an in-flight or just-aborted turn.',
      'Do not query Cline SQLite or infer content beyond the reported coverage.',
    ];
  } catch { return null; }
}

export const clineHarness: WorkerHarness = {
  id: 'cline', prepareLaunch: (input) => launch(input),
  prepareReadOnlyLaunch: (input) => launch({ ...input, sandboxMode: 'read-only-local-control' }),
  prepareResume: (input) => launch(input, input),
  probe: async (selection) => {
    if (!clineReportingInstalled()) return { kind: 'unavailable', stage: 'reporting', profile: 'bwrap-read-only', diagnostics: ['Cline Session 报告 plugin 未安装'], harnessVersion: null };
    return probeHarnessReadOnlyWorker('cline', selection, { harnessExecutable: 'cline' });
  },
  queryModels: () => Promise.resolve({ kind: 'unavailable', code: 'catalog_api_unavailable', message: 'Cline 当前没有已核实的受限非交互模型目录接口' }),
  sessionPaths: (root, id) => candidateSessionPaths('cline', root, id),
  installReporter: (paths) => installCandidateReporter(paths, clineReporterSource(paths.reportPath, join(dirname(paths.reporterPath), 'native-runtime.json'))),
  proveSession: async (input) => {
    if (!reportValid(input)) return { kind: 'transcript_unavailable', reason: 'Cline report 与原生 manifest/workspace/runtime 身份不一致' };
    const identity = await readClineTranscriptIdentity(input.report.transcriptPath!, input.workspace);
    return 'providerSessionId' in identity && identity.providerSessionId === input.report.sessionId
      ? { kind: 'proven', proof: { providerSessionId: identity.providerSessionId, transcriptRef: input.report.transcriptPath!, observedAt: input.report.observedAt! } }
      : { kind: 'transcript_unavailable', reason: 'Cline 原生 manifest 身份不匹配' };
  },
  readTranscriptIdentity: async ({ transcriptRef, workspace }) => readClineTranscriptIdentity(transcriptRef, workspace),
  inspectTranscript: inspectClineTranscript,
  recoveryInstructions: () => ['只读取精确 Session 的原生 JSON manifest 与 messages artifact；不得查询 Cline SQLite 数据库。',
    'manifest.session_id 与 workspace_root 必须匹配；messages_path 使用 manifest 字段，缺省时按 SDK 默认 artifact 路径读取。',
    '由宿主调用 prepareClineRecoveryMaterial，将与 coverage 一致的持久消息写为 Utility 私有 JSONL；事件引用格式为 message:N，coverage 保持 partial。'],
};
