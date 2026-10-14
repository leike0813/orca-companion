import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { HarnessSessionReport, ProveHarnessSessionInput, WorkerHarnessLaunchInput } from '../../application/ports/worker-harness.js';
import type { HarnessTranscriptCoverageResult } from '../../application/ports/worker-harness.js';
import { createWorkerHarness } from '../../application/ports/worker-harness.js';
import { candidateSessionPaths, installCandidateReporter, prepareCandidateLaunch, type CandidateResume } from './candidate-worker-launch.js';
import { probeHarnessReadOnlyWorker } from './read-only-execution-wrapper.js';
import { reportingCommand, reportingRoot, REPORT_TRAMPOLINE, readReportingJson, readReportingText } from './worker-harness-reporting.js';
import { runProcess } from '../orca-cli/process-runner.js';

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const MAX_TRANSCRIPT_LINES = 20_000;
const MAX_CURSOR_WORKSPACE_DIRS = 4096;
const MAX_CURSOR_CHAT_META_BYTES = 64 * 1024;

export type CursorReportingDefinition = {
  readonly configPath: string;
  readonly event: 'sessionStart';
  readonly entry: Readonly<Record<string, unknown>>;
  readonly command: string;
};

export function cursorConfigRoot(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const customConfigDir = env['CURSOR_CONFIG_DIR']?.trim();
  if (customConfigDir) return resolve(customConfigDir);
  const xdgConfigHome = env['XDG_CONFIG_HOME']?.trim();
  if (xdgConfigHome) return join(xdgConfigHome, 'cursor');
  return join(env['HOME'] || homedir(), '.cursor');
}

/** Cursor's global hook file is versioned JSON with event arrays under `hooks`. */
export function cursorReportingDefinition(env: Readonly<Record<string, string | undefined>> = process.env): CursorReportingDefinition {
  const command = reportingCommand();
  return { configPath: join(cursorConfigRoot(env), 'hooks.json'), event: 'sessionStart', command, entry: { command } };
}

export function cursorReportingInstalled(definition = cursorReportingDefinition()): boolean {
  try {
    const config = readReportingJson(definition.configPath);
    if (config['version'] !== 1) return false;
    const hooks = config['hooks'];
    if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return false;
    const entries = (hooks as Record<string, unknown>)[definition.event];
    return Array.isArray(entries) && entries.some((entry) => JSON.stringify(entry) === JSON.stringify(definition.entry))
      && readReportingTrampoline() === REPORT_TRAMPOLINE;
  } catch { return false; }
}

/** Mutates only Companion's sessionStart entry in Cursor's user hooks.json. */
export function maintainCursorReporting(action: 'install' | 'uninstall', env: Readonly<Record<string, string | undefined>> = process.env): void {
  const definition = cursorReportingDefinition(env);
  const path = definition.configPath;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.orca-companion-lock`;
  const lock = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  let temporary: string | undefined;
  try {
    const original = readCursorSnapshot(path);
    const config = parseCursorSnapshot(original);
    if (config['version'] !== undefined && config['version'] !== 1) throw new Error('Cursor hooks.json has an unsupported version');
    const hooksValue = config['hooks'];
    if (hooksValue !== undefined && (typeof hooksValue !== 'object' || hooksValue === null || Array.isArray(hooksValue))) {
      throw new Error('Cursor hooks must be an object');
    }
    const hooks = (hooksValue ?? {}) as Record<string, unknown>;
    const current = hooks[definition.event];
    if (current !== undefined && !Array.isArray(current)) throw new Error('Cursor sessionStart hooks must be an array');
    const entries = (current ?? []) as unknown[];
    const hasEntry = entries.some((entry) => JSON.stringify(entry) === JSON.stringify(definition.entry));
    if ((action === 'install' && hasEntry) || (action === 'uninstall' && !hasEntry)) return;
    const nextEntries = action === 'install'
      ? hasEntry ? entries : [...entries, definition.entry]
      : entries.filter((entry) => JSON.stringify(entry) !== JSON.stringify(definition.entry));
    if (nextEntries.length === 0) delete hooks[definition.event];
    else hooks[definition.event] = nextEntries;
    if (JSON.stringify(hooksValue ?? {}) !== JSON.stringify(hooks)) {
      if (Object.keys(hooks).length === 0) delete config['hooks'];
      else config['hooks'] = hooks;
    }
    config['version'] = 1;

    temporary = `${path}.orca-companion-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    assertCursorSnapshot(path, original);
    renameSync(temporary, path);
    temporary = undefined;
    if (JSON.stringify(readReportingJson(path)) !== JSON.stringify(config)) throw new Error('Cursor hooks.json readback failed');
  } finally {
    closeSync(lock);
    if (temporary !== undefined) unlinkSync(temporary);
    unlinkSync(lockPath);
  }
}

export function assertCursorSnapshot(path: string, expectedSnapshot: string | null): void {
  if (readCursorSnapshot(path) !== expectedSnapshot) throw new Error('Cursor hooks.json changed during update');
}

function readCursorSnapshot(path: string): string | null {
  try { return readReportingText(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function parseCursorSnapshot(snapshot: string | null): Record<string, unknown> {
  if (snapshot === null) return {};
  const value: unknown = JSON.parse(snapshot);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Cursor hooks.json must be an object');
  return value as Record<string, unknown>;
}

function readReportingTrampoline(): string {
  return readBoundedText(join(reportingRoot(), 'report.mjs'), 65536);
}

function readBoundedText(path: string, maxBytes: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) throw new Error('Native file exceeds bounds');
    const data = Buffer.alloc(stat.size);
    if (readSync(fd, data, 0, data.length, 0) !== data.length) throw new Error('Native file changed');
    return new TextDecoder('utf8', { fatal: true }).decode(data);
  } finally { closeSync(fd); }
}

/** The upstream scanner's Cursor shape is projects/<slug>/agent-transcripts/<id>/<id>.jsonl. */
export function cursorTranscriptId(transcriptPath: string, cursorRoot = cursorConfigRoot()): string | null {
  if (!isAbsolute(transcriptPath) || !isAbsolute(cursorRoot)) return null;
  const root = resolve(cursorRoot);
  const path = resolve(transcriptPath);
  const parts = relative(root, path).split(sep);
  if (parts.length !== 5 || parts[0] !== 'projects' || parts[2] !== 'agent-transcripts'
    || !SESSION_ID.test(parts[3]!) || parts[4] !== `${parts[3]}.jsonl`) {
    // Transcript file is directly inside the ID directory: projects/<slug>/agent-transcripts/<id>/<id>.jsonl.
    return null;
  }
  return parts[3]!;
}

/** Bind the hook's transcript ID to Cursor's native chats/<workspace>/<id>/meta.json cwd. */
export function cursorTranscriptWorkspaceMatches(transcriptPath: string, workspace: string, cursorRoot = cursorConfigRoot()): boolean {
  const sessionId = cursorTranscriptId(transcriptPath, cursorRoot);
  if (sessionId === null) return false;
  const chatsRoot = join(resolve(cursorRoot), 'chats');
  try {
    const workspaceDirs = readdirSync(chatsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    if (workspaceDirs.length > MAX_CURSOR_WORKSPACE_DIRS) return false;
    const matches: string[] = [];
    for (const workspaceDir of workspaceDirs) {
      const metaPath = join(chatsRoot, workspaceDir.name, sessionId, 'meta.json');
      try {
        const stat = lstatSync(metaPath);
        if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(metaPath) !== resolve(metaPath)) return false;
        const metadata: unknown = JSON.parse(readBoundedText(metaPath, MAX_CURSOR_CHAT_META_BYTES));
        if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return false;
        const cwd = (metadata as Record<string, unknown>)['cwd'];
        if (typeof cwd !== 'string' || cwd.length === 0) return false;
        matches.push(cwd);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      }
    }
    return matches.length === 1 && realpathSync(matches[0]!) === realpathSync(workspace);
  } catch { return false; }
}

type CursorTranscript = { readonly messages: readonly number[] };

export function parseCursorTranscript(text: string): CursorTranscript | null {
  if (Buffer.byteLength(text, 'utf8') > MAX_TRANSCRIPT_BYTES) return null;
  const lines = text.split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length === 0 || lines.length > MAX_TRANSCRIPT_LINES) return null;
  const messages: number[] = [];
  for (let index = 0; index < lines.length; index++) {
    let value: unknown;
    try { value = JSON.parse(lines[index]!); } catch { return null; }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if ((row['role'] !== 'user' && row['role'] !== 'assistant')
      || (!('message' in row) && !('content' in row))) return null;
    messages.push(index);
  }
  return messages.length === 0 ? null : { messages };
}

function readCursorTranscript(transcriptPath: string, sessionId: string, workspace: string): boolean {
  const root = cursorConfigRoot();
  if (cursorTranscriptId(transcriptPath, root) !== sessionId || !cursorTranscriptWorkspaceMatches(transcriptPath, workspace, root)) return false;
  try {
    if (realpathSync(transcriptPath) !== resolve(transcriptPath) || realpathSync(workspace) !== resolve(workspace)) return false;
    const content = readBoundedText(transcriptPath, MAX_TRANSCRIPT_BYTES);
    return parseCursorTranscript(content) !== null;
  } catch { return false; }
}

export function cursorReporterSource(reportPath: string, runtimeReportPath: string): string {
  return `import { appendFileSync, readFileSync } from 'node:fs';
let text = ''; for await (const chunk of process.stdin) { text += chunk; if (Buffer.byteLength(text) > 65536) process.exit(2); }
const p = JSON.parse(text), runtime = JSON.parse(readFileSync(${JSON.stringify(runtimeReportPath)}, 'utf8'));
if (p.hook_event_name !== 'sessionStart' || typeof p.conversation_id !== 'string' || !Array.isArray(p.workspace_roots) || p.workspace_roots.length !== 1 || typeof p.workspace_roots[0] !== 'string' || typeof p.transcript_path !== 'string' || !p.transcript_path) process.exit(2);
appendFileSync(${JSON.stringify(reportPath)}, JSON.stringify({ harness: 'cursor', sessionId: p.conversation_id, transcriptPath: p.transcript_path, cwd: p.workspace_roots[0], observedAt: new Date().toISOString(), stateRoot: runtime.stateRoot, runtimeRoots: runtime.writableRoots }) + '\\n', { mode: 0o600 });
`;
}

export function cursorArguments(input: WorkerHarnessLaunchInput, resume?: CandidateResume): readonly string[] {
  if (input.modelSelection.effort !== null) throw new Error('Cursor CLI does not expose a verified reasoning-effort launch option');
  return ['--model', input.modelSelection.model, ...(resume === undefined ? [] : ['--resume', resume.sessionId])];
}

function launch(input: WorkerHarnessLaunchInput, resume?: CandidateResume) {
  return prepareCandidateLaunch({
    harness: 'cursor', executable: 'cursor-agent', input, ...(resume === undefined ? {} : { resume }),
    arguments: () => cursorArguments(input, resume), reporterSource: cursorReporterSource,
    checkSetup: () => {
      if (!cursorReportingInstalled()) throw Object.assign(new Error('Cursor sessionStart hook 未安装'), { code: 'worker_reporting_missing' });
    },
    verifyResume: (workspace, original) => readCursorTranscript(original.transcriptRef, original.sessionId, workspace)
      ? Promise.resolve()
      : Promise.reject(new Error('Cursor 原 Session transcript 身份不可证明')),
  });
}

export function parseCursorModelCatalog(output: string): readonly string[] | null {
  if (Buffer.byteLength(output, 'utf8') > 1024 * 1024) return null;
  let value: unknown;
  try { value = JSON.parse(output); } catch { value = undefined; }
  if (Array.isArray(value)) {
    if (value.length > 4096) return null;
    const models = value.filter((item): item is string => typeof item === 'string' && MODEL_ID.test(item));
    return models.length > 0 && models.length === value.length && new Set(models).size === models.length ? models : null;
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const candidate = (value as Record<string, unknown>)['models'];
    if (Array.isArray(candidate)) {
      if (candidate.length > 4096) return null;
      const models = candidate.map((item) => typeof item === 'string' ? item : typeof item === 'object' && item !== null ? (item as Record<string, unknown>)['id'] : null);
      if (models.every((item): item is string => typeof item === 'string' && MODEL_ID.test(item))
        && models.length > 0 && new Set(models).size === models.length) return models;
    }
  }
  const lines = output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 4096) return null;
  const models = lines.map((line) => line.startsWith('- ') || line.startsWith('* ') ? line.slice(2).trim() : line);
  return models.length > 0 && models.every((model) => MODEL_ID.test(model)) && new Set(models).size === models.length ? models : null;
}

export function readCursorTranscriptIdentity(input: { readonly transcriptRef: string; readonly workspace: string }): Promise<
  { readonly providerSessionId: string } | { readonly kind: 'transcript_unavailable'; readonly reason: string }
> {
  const sessionId = cursorTranscriptId(input.transcriptRef);
  return Promise.resolve(sessionId !== null && readCursorTranscript(input.transcriptRef, sessionId, input.workspace)
    ? { providerSessionId: sessionId }
    : { kind: 'transcript_unavailable', reason: 'Cursor 原生 transcript 路径、会话 ID 或活动消息不可核验' });
}

function reportValid(input: ProveHarnessSessionInput): boolean {
  const report: HarnessSessionReport = input.report;
  if (report.harness !== 'cursor' || report.sessionId === null || report.transcriptPath === null || report.cwd === null
    || report.observedAt === null || report.stateRoot == null || !report.runtimeRoots?.length) return false;
  const at = Date.parse(report.observedAt), from = Date.parse(input.dispatchStartedAt), until = Date.parse(input.bindingDeadlineAt);
  try {
    return SESSION_ID.test(report.sessionId)
      && Number.isFinite(at) && at >= from && at <= until
      && realpathSync(report.cwd) === realpathSync(input.workspace)
      && realpathSync(report.stateRoot) === realpathSync(input.expectedStateRoot)
      && report.runtimeRoots.some((root) => realpathSync(root) === realpathSync(cursorConfigRoot()))
      && cursorTranscriptId(report.transcriptPath) === report.sessionId
      && readCursorTranscript(report.transcriptPath, report.sessionId, input.workspace);
  } catch { return false; }
}

export async function proveCursorSession(input: ProveHarnessSessionInput) {
  if (!reportValid(input)) return { kind: 'transcript_unavailable' as const, reason: 'Cursor report 与精确 conversation/workspace/runtime 身份不匹配' };
  const identity = await readCursorTranscriptIdentity({ transcriptRef: input.report.transcriptPath!, workspace: input.workspace });
  return 'providerSessionId' in identity && identity.providerSessionId === input.report.sessionId
    ? { kind: 'proven' as const, proof: { providerSessionId: identity.providerSessionId, transcriptRef: input.report.transcriptPath!, observedAt: input.report.observedAt! } }
    : { kind: 'transcript_unavailable' as const, reason: 'Cursor SessionStart 报告未被 transcript 独立核验' };
}

export function inspectCursorTranscript(transcriptRef: string): Promise<HarnessTranscriptCoverageResult> {
  const sessionId = cursorTranscriptId(transcriptRef);
  if (sessionId === null) return Promise.resolve({ kind: 'transcript_unavailable', reason: 'Cursor transcript 路径不符合原生 session layout' });
  try {
    if (realpathSync(transcriptRef) !== resolve(transcriptRef)) throw new Error('transcript path');
    const parsed = parseCursorTranscript(readBoundedText(transcriptRef, MAX_TRANSCRIPT_BYTES));
    if (parsed === null) throw new Error('transcript parse');
    const first = parsed.messages[0]!, last = parsed.messages.at(-1)!;
    return Promise.resolve({ kind: 'covered', evidence: { coverage: 'complete', readableRange: { transcriptRef, fromEventRef: `line:${first}`, toEventRef: `line:${last}` }, gaps: [], lastCompleteEventRef: `line:${last}` } });
  } catch { return Promise.resolve({ kind: 'transcript_unavailable', reason: 'Cursor transcript 为空、损坏、超限或不可安全读取' }); }
}

export const cursorHarness = createWorkerHarness({
  id: 'cursor',
  prepareLaunch: (input) => launch(input),
  prepareReadOnlyLaunch: (input) => launch({ ...input, sandboxMode: 'read-only-local-control' }),
  prepareResume: (input) => launch(input, input),
  probe: async (selection) => {
    if (!cursorReportingInstalled()) return { kind: 'unavailable', stage: 'reporting', profile: 'bwrap-read-only', diagnostics: ['Cursor sessionStart hook 未安装'], harnessVersion: null };
    return probeHarnessReadOnlyWorker('cursor', selection, { harnessExecutable: 'cursor-agent' });
  },
  queryModels: async (input) => {
    const env = Object.fromEntries(Object.entries(input.env ?? process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    const startedAt = Date.now();
    const version = await runProcess({ executable: 'cursor-agent', args: ['--version'], cwd: input.cwd, env, timeoutMs: 10_000,
      limits: { maxBytes: 64 * 1024, maxLines: 100 }, ...(input.signal === undefined ? {} : { signal: input.signal }) });
    if (version.kind !== 'completed' || version.exitCode !== 0 || version.stdout.truncated || !version.stdout.text.trim()) {
      return { kind: 'unavailable', code: 'harness_version_unreadable', message: '无法核验 Cursor CLI 版本' };
    }
    const remainingMs = Math.floor(30_000 - (Date.now() - startedAt));
    if (remainingMs <= 0) return { kind: 'unavailable', code: 'catalog_timeout', message: 'Cursor 本地模型目录查询超时' };
    const output = await runProcess({ executable: 'cursor-agent', args: ['--list-models'], cwd: input.cwd, env, timeoutMs: remainingMs,
      limits: { maxBytes: 1024 * 1024, maxLines: 5000 }, ...(input.signal === undefined ? {} : { signal: input.signal }) });
    const models = output.kind === 'completed' && output.exitCode === 0 && !output.stdout.truncated ? parseCursorModelCatalog(output.stdout.text) : null;
    return models === null
      ? { kind: 'unavailable', code: 'catalog_output_unrecognized', message: 'Cursor CLI 模型目录查询失败或输出结构不可核验' }
      : Date.now() - startedAt > 30_000
        ? { kind: 'unavailable', code: 'catalog_timeout', message: 'Cursor 本地模型目录查询超时' }
        : { kind: 'available', source: `cursor:${version.stdout.text.trim()}:cursor-agent --list-models`, models: models.map((model) => ({ model, effortCapability: null })) };
  },
  sessionPaths: (root, id) => candidateSessionPaths('cursor', root, id),
  installReporter: (paths) => installCandidateReporter(paths, cursorReporterSource(paths.reportPath, join(dirname(paths.reporterPath), 'native-runtime.json'))),
  proveSession: proveCursorSession,
  readTranscriptIdentity: readCursorTranscriptIdentity,
  inspectTranscript: inspectCursorTranscript,
  recoveryInstructions: () => [
    '只读取 SessionStart 报告给出的精确 transcript_path；conversation_id 必须匹配 transcript 目录与文件名。',
    'Cursor JSONL 的事件引用格式为 line:N；保留 user/assistant 消息原有顺序与 message.content。',
    'transcript_path 为 null、workspace_roots 非单根或 transcript 不可读时停止恢复。',
  ],
});
