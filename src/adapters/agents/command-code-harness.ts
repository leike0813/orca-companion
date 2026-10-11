import { createHash } from 'node:crypto';
import {
  constants as fsConstants, lstatSync, mkdirSync, mkdtempSync, openSync, closeSync,
  readSync, fstatSync, realpathSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { WorkerHarness } from '../../application/ports/worker-harness.js';
import type {
  HarnessSessionReport, HarnessTranscriptCoverageResult, HarnessTranscriptProofResult,
  PreparedHarnessTerminal, ProveHarnessSessionInput, WorkerHarnessLaunchInput,
  WorkerModelCatalogResult,
} from '../../application/ports/worker-harness.js';
import type { TranscriptCoverageEvidence } from '../../application/recovery/recovery-capsule.js';
import type { PreparedTerminalStrategy } from '../../application/worker-launch.js';
import type { WorkerModelSelection } from '../../domain/model-configuration.js';
import { workerModelSelectionSchema } from '../../domain/model-configuration.js';
import { runProcess } from '../orca-cli/process-runner.js';
import {
  CODEX_MODEL_DESCRIPTOR_VERSION, codexModelLaunchCommand, writeCodexModelLaunch,
} from './codex-model-launcher.js';
import type { CodexModelLaunchDescriptor } from './codex-model-launcher.js';
import { assertReadOnlyExecutionWrapperAvailable, probeHarnessReadOnlyWorker } from './read-only-execution-wrapper.js';

export const COMMAND_CODE_HARNESS_ID = 'command-code';
const REPORT_FILENAME = 'session-start.jsonl';
const MAX_TRANSCRIPT_BYTES = 1024 * 1024;
const MAX_TRANSCRIPT_LINES = 20_000;
const MAX_HEADER_BYTES = 64 * 1024;
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const SIDECAR_SUFFIX = '.companion-leaf.json';
const NATIVE_READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;

type TranscriptEntry = { readonly id: string; readonly parentId: string | null };

function inside(root: string, path: string): boolean {
  const pathFromRoot = relative(root, path);
  return pathFromRoot === '' || (pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot));
}

function readHeader(path: string): { readonly sessionId: string; readonly cwd: string } | null {
  let descriptor: number | undefined;
  try {
    if (!isAbsolute(path) || lstatSync(path).isSymbolicLink() || realpathSync(path) !== resolve(path)) return null;
    descriptor = openSync(path, NATIVE_READ_FLAGS);
    if (!fstatSync(descriptor).isFile()) return null;
    const bytes = Buffer.alloc(MAX_HEADER_BYTES);
    const length = readSync(descriptor, bytes, 0, bytes.length, 0);
    const prefix = bytes.subarray(0, length);
    const newline = prefix.indexOf(0x0a);
    if (newline < 0 && length === bytes.length) return null;
    const firstLine = new TextDecoder('utf-8', { fatal: true }).decode(prefix.subarray(0, newline < 0 ? length : newline));
    if (firstLine === undefined) return null;
    const record: unknown = JSON.parse(firstLine);
    if (typeof record !== 'object' || record === null) return null;
    const header = record as { type?: unknown; version?: unknown; id?: unknown; cwd?: unknown };
    return header.type === 'session' && header.version === 3
      && typeof header.id === 'string' && SAFE_SESSION_ID.test(header.id)
      && typeof header.cwd === 'string' && isAbsolute(header.cwd)
      ? { sessionId: header.id, cwd: header.cwd }
      : null;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function reportRootsAreExact(report: HarnessSessionReport, expectedStateRoot: string): boolean {
  try {
    if (report.transcriptPath === null || report.stateRoot == null || report.runtimeRoots === undefined
      || report.runtimeRoots.length === 0) return false;
    const canonicalTranscript = realpathSync(report.transcriptPath);
    const canonicalStateRoot = realpathSync(report.stateRoot);
    const canonicalRoots = report.runtimeRoots.map((root) => {
      if (lstatSync(root).isSymbolicLink()) throw new Error('runtime root is a symlink');
      return realpathSync(root);
    });
    if (lstatSync(report.transcriptPath).isSymbolicLink() || lstatSync(report.stateRoot).isSymbolicLink()
      || canonicalRoots.some((root) => !inside(root, canonicalTranscript))
      || !canonicalRoots.includes(canonicalStateRoot)) return false;
    return canonicalStateRoot === realpathSync(expectedStateRoot)
      && basename(canonicalTranscript) === `${report.sessionId}.jsonl`;
  } catch {
    return false;
  }
}

function readTranscriptTree(path: string, expectedSessionId: string): {
  readonly sessionId: string; readonly entries: readonly TranscriptEntry[];
} | null {
  try {
    if (lstatSync(path).isSymbolicLink() || realpathSync(path) !== resolve(path)) return null;
    const descriptor = openSync(path, NATIVE_READ_FLAGS);
    let bytes: Buffer;
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_TRANSCRIPT_BYTES) return null;
      const size = stat.size;
      bytes = Buffer.alloc(size);
      if (readSync(descriptor, bytes, 0, size, 0) !== size) return null;
    } finally {
      closeSync(descriptor);
    }
    const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\n').filter((line) => line.trim().length > 0);
    if (lines.length < 2 || lines.length > MAX_TRANSCRIPT_LINES) return null;
    const header: unknown = JSON.parse(lines[0]!);
    if (typeof header !== 'object' || header === null) return null;
    const identity = header as { type?: unknown; version?: unknown; id?: unknown; cwd?: unknown };
    if (identity.type !== 'session' || identity.version !== 3 || identity.id !== expectedSessionId) return null;
    const entries: TranscriptEntry[] = [];
    const ids = new Set<string>();
    for (const line of lines.slice(1)) {
      const value: unknown = JSON.parse(line);
      if (typeof value !== 'object' || value === null) return null;
      const entry = value as { id?: unknown; parentId?: unknown };
      if (typeof entry.id !== 'string' || entry.id.length === 0 || ids.has(entry.id)
        || (entry.parentId !== null && typeof entry.parentId !== 'string')) return null;
      if (typeof entry.parentId === 'string' && !ids.has(entry.parentId)) return null;
      ids.add(entry.id);
      entries.push({ id: entry.id, parentId: entry.parentId });
    }
    return { sessionId: expectedSessionId, entries };
  } catch {
    return null;
  }
}

function activeBranch(path: string): { readonly first: string; readonly last: string } | null {
  const header = readHeader(path);
  if (header === null) return null;
  let sidecar: unknown;
  try {
    const sidecarPath = path + SIDECAR_SUFFIX;
    if (lstatSync(sidecarPath).isSymbolicLink()) return null;
    const descriptor = openSync(sidecarPath, NATIVE_READ_FLAGS);
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.size > 4096) return null;
      const bytes = Buffer.alloc(4096);
      const length = readSync(descriptor, bytes, 0, bytes.length, 0);
      sidecar = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
    } finally {
      closeSync(descriptor);
    }
  } catch {
    return null;
  }
  if (typeof sidecar !== 'object' || sidecar === null) return null;
  const leaf = sidecar as { sessionId?: unknown; leafId?: unknown };
  if (leaf.sessionId !== header.sessionId || typeof leaf.leafId !== 'string' || leaf.leafId.length === 0) return null;
  const tree = readTranscriptTree(path, header.sessionId);
  if (tree === null) return null;
  const byId = new Map(tree.entries.map((entry) => [entry.id, entry]));
  if (!byId.has(leaf.leafId)) return null;
  let cursor: string | null = leaf.leafId;
  const seen = new Set<string>();
  const pathToRoot: string[] = [];
  while (cursor !== null) {
    if (seen.has(cursor)) return null;
    seen.add(cursor);
    pathToRoot.push(cursor);
    const entry = byId.get(cursor);
    if (entry === undefined) return null;
    cursor = entry.parentId;
  }
  return { first: pathToRoot.at(-1)!, last: leaf.leafId };
}

function reportTimestampInWindow(value: string, start: string, deadline: string): boolean {
  const observed = Date.parse(value);
  const from = Date.parse(start);
  const until = Date.parse(deadline);
  return Number.isFinite(observed) && Number.isFinite(from) && Number.isFinite(until)
    && until >= from && observed >= from && observed <= until;
}

function artifactRoot(input: WorkerHarnessLaunchInput, workspace: string): string {
  const digest = createHash('sha256').update(input.launchId).digest('hex').slice(0, 20);
  const root = input.stateRoot === undefined
    ? join(workspace, '.companion', COMMAND_CODE_HARNESS_ID, digest)
    : join(input.stateRoot, digest);
  if (!isAbsolute(root)) throw new Error('Command Code 工件根必须是绝对路径');
  if (input.stateRoot === undefined && !inside(resolve(workspace), resolve(root))) throw new Error('Command Code 工件根越过 worktree');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

function modSource(reportPath: string, runtimeReportPath: string): string {
  return `import { appendFileSync, closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, relative, sep, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(realpathSync(process.argv[1]));
const slugify = require('@sindresorhus/slugify').default;
const REPORT = ${JSON.stringify(reportPath)};
const RUNTIME = ${JSON.stringify(runtimeReportPath)};
const SIDECAR = '.companion-leaf.json';
const NATIVE_READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
const inside = (root, path) => { const rel = relative(root, path); return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)); };
const readJson = path => { let fd; try { fd = openSync(path, NATIVE_READ_FLAGS); const stat = fstatSync(fd); if (!stat.isFile() || stat.size <= 0 || stat.size > 65536) return null; const bytes = Buffer.alloc(stat.size); if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) return null; return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return null; } finally { if (fd !== undefined) closeSync(fd); } };
export default function (cmd) {
  let sessionId = null;
  const record = (candidate) => {
    const id = candidate ?? sessionId;
    if (typeof id !== 'string' || !id || typeof cmd.cwd !== 'string' || !isAbsolute(cmd.cwd)) return;
    try {
      const runtime = readJson(RUNTIME);
      if (!runtime) return;
      const project = slugify(cmd.cwd) || 'root';
      const candidates = new Set();
      for (const root of [runtime.stateRoot, ...runtime.writableRoots]) {
        if (typeof root !== 'string' || !isAbsolute(root)) continue;
        candidates.add(resolve(root, 'projects', project, id + '.jsonl'));
      }
      const paths = [...candidates].filter(path => { try { return lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink() && realpathSync(path) === resolve(path) && [...runtime.writableRoots, runtime.stateRoot].some(root => inside(resolve(root), path)); } catch { return false; } });
      if (paths.length !== 1) return;
      const transcriptPath = paths[0];
      const descriptor = openSync(transcriptPath, NATIVE_READ_FLAGS);
      let header;
      try {
        if (!fstatSync(descriptor).isFile()) return;
        const bytes = Buffer.alloc(65536);
        const length = readSync(descriptor, bytes, 0, bytes.length, 0);
        const prefix = bytes.subarray(0, length);
        const newline = prefix.indexOf(0x0a);
        if (newline < 0 && length === bytes.length) return;
        const firstLine = new TextDecoder('utf-8', { fatal: true }).decode(prefix.subarray(0, newline < 0 ? length : newline));
        header = JSON.parse(firstLine);
      } finally { closeSync(descriptor); }
      if (header?.type !== 'session' || header.version !== 3 || header.id !== id || header.cwd !== cmd.cwd) return;
      const row = { harness: 'command-code', sessionId: id, transcriptPath, cwd: cmd.cwd,
        observedAt: new Date().toISOString(), stateRoot: runtime.stateRoot, runtimeRoots: runtime.writableRoots };
      appendFileSync(REPORT, JSON.stringify(row) + '\\n', { mode: 0o600 });
      let leafId;
      try { leafId = cmd.sessions.leafId(); } catch {}
      if (typeof leafId === 'string' && leafId) {
        writeFileSync(transcriptPath + SIDECAR, JSON.stringify({ sessionId: id, leafId }) + '\\n', { mode: 0o600 });
      }
    } catch {}
  };
  cmd.on('run_start', event => { sessionId = event.sessionId; record(sessionId); });
  for (const event of ['turn_end', 'run_end', 'session_shutdown']) cmd.on(event, () => record(sessionId));
}
`;
}

function installCommandCodeReporter(input: {
  readonly reporterPath: string; readonly reportPath: string;
}): void {
  mkdirSync(dirname(input.reporterPath), { recursive: true, mode: 0o700 });
  writeFileSync(input.reporterPath, modSource(input.reportPath, join(dirname(input.reporterPath), 'native-runtime.json')), { mode: 0o600 });
}

function buildLaunch(input: {
  readonly execution: WorkerHarnessLaunchInput;
  readonly workspace: string;
  readonly reportPath: string;
  readonly reporterPath: string;
  readonly runtimeReportPath: string;
  readonly originalStateRoot?: string;
  readonly transcriptRef?: string;
}): PreparedHarnessTerminal {
  if (!workerModelSelectionSchema.safeParse(input.execution.modelSelection).success
    || input.execution.modelSelection.effort !== null) throw new Error('Command Code 只接受已校验且无 effort 的原生模型 ID');
  const stateRoot = artifactRoot(input.execution, input.workspace);
  const args = [
    '--no-auto-update', '--local-only', '--skip-onboarding', '--trust', '--yolo',
    '--model', input.execution.modelSelection.model,
    '--mod', input.reporterPath,
    ...(input.transcriptRef === undefined ? [] : ['--session', input.transcriptRef]),
  ];
  const readOnly = input.execution.sandboxMode === 'read-only' || input.execution.sandboxMode === 'read-only-local-control'
    ? { workspace: input.workspace, stateRoot, ...(dirname(input.reportPath) === stateRoot ? {} : { reportDirectory: dirname(input.reportPath) }) }
    : undefined;
  const descriptor: CodexModelLaunchDescriptor = {
    version: CODEX_MODEL_DESCRIPTOR_VERSION,
    executable: COMMAND_CODE_HARNESS_ID,
    args,
    harness: COMMAND_CODE_HARNESS_ID,
    ...(input.originalStateRoot === undefined ? {} : { expectedStateRoot: input.originalStateRoot }),
    runtimeReportPath: input.runtimeReportPath,
    ...(readOnly === undefined ? {} : { readOnly }),
  };
  const { descriptorPath, launcherPath } = writeCodexModelLaunch({ stateRoot, descriptor });
  return {
    title: `orca-companion:command-code:${createHash('sha256').update(input.execution.launchId).digest('hex').slice(0, 20)}`,
    stateRoot, command: codexModelLaunchCommand({ launcherPath, descriptorPath }),
  };
}

function createLaunch(input: WorkerHarnessLaunchInput, readOnly: boolean): PreparedTerminalStrategy<PreparedHarnessTerminal> {
  if (!input.launchId) throw new Error('Command Code launchId must be nonempty');
  const digest = createHash('sha256').update(input.launchId).digest('hex').slice(0, 20);
  return {
    kind: 'prepared_terminal', harness: COMMAND_CODE_HARNESS_ID, activation: 'submit_draft',
    title: `orca-companion:command-code:${digest}`,
    prepare: async ({ worktreePath }) => {
      if (!isAbsolute(worktreePath) || (input.stateRoot !== undefined && !isAbsolute(input.stateRoot))) {
        throw new Error('Command Code workspace and artifacts must be absolute paths');
      }
      if (readOnly) await assertReadOnlyExecutionWrapperAvailable();
      const stateRoot = artifactRoot(input, worktreePath);
      const reporterPath = input.sessionStartReporterPath ?? join(stateRoot, 'session-start.mjs');
      const paths = { reporterPath, reportPath: join(dirname(reporterPath), REPORT_FILENAME) };
      installCommandCodeReporter(paths);
      return buildLaunch({
        execution: readOnly ? { ...input, sandboxMode: 'read-only-local-control' } : input,
        workspace: resolve(worktreePath), reportPath: paths.reportPath, reporterPath: paths.reporterPath,
        runtimeReportPath: join(dirname(paths.reporterPath), 'native-runtime.json'),
      });
    },
  };
}

export function createCommandCodeResumeLaunch(input: WorkerHarnessLaunchInput & {
  readonly sessionId: string; readonly originalStateRoot: string; readonly transcriptRef: string;
}): PreparedTerminalStrategy<PreparedHarnessTerminal> {
  if (!SAFE_SESSION_ID.test(input.sessionId) || !isAbsolute(input.originalStateRoot)) throw new Error('Command Code resume identity is invalid');
  return {
    kind: 'prepared_terminal', harness: COMMAND_CODE_HARNESS_ID, activation: 'submit_draft',
    title: `orca-companion:command-code:${createHash('sha256').update(input.launchId).digest('hex').slice(0, 20)}`,
    prepare: async ({ worktreePath }) => {
      const identity = await readCommandCodeTranscriptIdentity({ transcriptRef: input.transcriptRef, workspace: worktreePath });
      if (!('providerSessionId' in identity) || identity.providerSessionId !== input.sessionId
        || !basename(input.transcriptRef).endsWith(`${input.sessionId}.jsonl`)) {
        throw new Error('Command Code original session cannot be proven');
      }
      if (input.sandboxMode === 'read-only' || input.sandboxMode === 'read-only-local-control') {
        await assertReadOnlyExecutionWrapperAvailable();
      }
      const stateRoot = artifactRoot(input, worktreePath);
      const reporterPath = input.sessionStartReporterPath ?? join(stateRoot, 'session-start.mjs');
      const paths = { reporterPath, reportPath: join(dirname(reporterPath), REPORT_FILENAME) };
      installCommandCodeReporter(paths);
      return buildLaunch({
        execution: input, workspace: resolve(worktreePath), reportPath: paths.reportPath,
        reporterPath: paths.reporterPath, runtimeReportPath: join(dirname(paths.reporterPath), 'native-runtime.json'),
        originalStateRoot: input.originalStateRoot, transcriptRef: input.transcriptRef,
      });
    },
  };
}

export function readCommandCodeTranscriptIdentity(input: {
  readonly transcriptRef: string; readonly workspace: string;
}): Promise<{ readonly providerSessionId: string } | { readonly kind: 'transcript_unavailable'; readonly reason: string }> {
  const header = readHeader(input.transcriptRef);
  if (header === null || !isAbsolute(input.workspace) || resolve(header.cwd) !== resolve(input.workspace)) {
    return Promise.resolve({ kind: 'transcript_unavailable', reason: 'Command Code native transcript v3 header or cwd is unavailable or inconsistent' });
  }
  return Promise.resolve({ providerSessionId: header.sessionId });
}

export function proveCommandCodeTranscript(input: ProveHarnessSessionInput): Promise<HarnessTranscriptProofResult> {
  const report = input.report;
  const transcriptRef = report.transcriptPath;
  const observedAt = report.observedAt;
  if (transcriptRef === null || report.sessionId === null || report.cwd !== resolve(input.workspace)
    || report.stateRoot !== resolve(input.expectedStateRoot) || report.harness !== COMMAND_CODE_HARNESS_ID
    || observedAt === null || !reportTimestampInWindow(observedAt, input.dispatchStartedAt, input.bindingDeadlineAt)) {
    return Promise.resolve({ kind: 'transcript_unavailable', reason: 'Command Code session report is stale or does not match its dispatch/workspace' });
  }
  const parsed = readHeader(transcriptRef);
  if (parsed === null || parsed.sessionId !== report.sessionId || resolve(parsed.cwd) !== resolve(input.workspace)
    || !reportRootsAreExact(report, input.expectedStateRoot)) {
    return Promise.resolve({ kind: 'transcript_unavailable', reason: 'Command Code native transcript identity or runtime roots cannot be proven' });
  }
  return Promise.resolve({ kind: 'proven', proof: { providerSessionId: parsed.sessionId, transcriptRef: resolve(transcriptRef), observedAt } });
}

export function inspectCommandCodeTranscript(transcriptRef: string): Promise<HarnessTranscriptCoverageResult> {
  const branch = activeBranch(transcriptRef);
  if (branch === null) return Promise.resolve({ kind: 'transcript_unavailable', reason: 'Command Code native transcript or exact active-leaf sidecar is unavailable' });
  const evidence: TranscriptCoverageEvidence = {
    coverage: 'complete', readableRange: { transcriptRef: resolve(transcriptRef), fromEventRef: branch.first, toEventRef: branch.last },
    gaps: [], lastCompleteEventRef: branch.last,
  };
  return Promise.resolve({ kind: 'covered', evidence });
}

export const COMMAND_CODE_RECOVERY_INSTRUCTIONS = [
  'transcriptRef 是原生 Command Code JSONL 路径；只读取该路径，不扫描或复制其他 transcript。',
  '核验首行为 version 3 session header，id 与 cwd 必须匹配绑定；读取上限 1 MiB、20,000 行。',
  '活动叶子只接受原生文件旁 .companion-leaf.json 中匹配 sessionId 的 leafId；按 parentId 回溯该分支，缺失或断链即停止。',
] as const;

async function queryCommandCodeModels(input: {
  readonly cwd: string; readonly signal?: AbortSignal; readonly env?: Readonly<Record<string, string>>;
}): Promise<WorkerModelCatalogResult> {
  if (input.signal?.aborted) return { kind: 'unavailable', code: 'catalog_cancelled', message: 'Command Code 模型目录查询已取消' };
  const startedAt = performance.now();
  const totalBudgetMs = 30_000;
  const env: Readonly<Record<string, string>> = input.env ?? Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const version = await runProcess({
    executable: COMMAND_CODE_HARNESS_ID, args: ['--no-auto-update', '--version'], cwd: input.cwd, env,
    timeoutMs: 10_000, limits: { maxBytes: 64 * 1024, maxLines: 20 }, ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (input.signal?.aborted) return { kind: 'unavailable', code: 'catalog_cancelled', message: 'Command Code 模型目录查询已取消' };
  if (version.kind !== 'completed' || version.exitCode !== 0 || version.stdout.truncated) {
    return { kind: 'unavailable', code: 'harness_version_unreadable', message: '无法核验 Command Code 版本' };
  }
  const remainingMs = Math.floor(totalBudgetMs - (performance.now() - startedAt));
  if (remainingMs <= 0) return { kind: 'unavailable', code: 'catalog_timeout', message: 'Command Code 本地模型目录查询超时' };
  const catalog = await runProcess({
    executable: COMMAND_CODE_HARNESS_ID, args: ['--no-auto-update', '--local-only', '--list-models'], cwd: input.cwd, env,
    timeoutMs: remainingMs, limits: { maxBytes: MAX_TRANSCRIPT_BYTES, maxLines: MAX_TRANSCRIPT_LINES }, ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (catalog.kind !== 'completed' || catalog.exitCode !== 0 || catalog.stdout.truncated) {
    return { kind: 'unavailable', code: 'catalog_unavailable', message: 'Command Code 本地模型目录不可用' };
  }
  const models = new Set<string>();
  for (const line of catalog.stdout.text.split('\n')) {
    if (line.trim() === 'Decision models (headless only)') break;
    if (line.length > 4096) return { kind: 'unavailable', code: 'catalog_line_limit_exceeded', message: 'Command Code 模型目录包含超长行' };
    const match = /^([A-Za-z0-9][A-Za-z0-9._:/-]{0,254}[A-Za-z0-9])\s{2,}\S/u.exec(line.trimEnd());
    if (match !== null) models.add(match[1]!);
    if (models.size > 4096) return { kind: 'unavailable', code: 'catalog_limit_exceeded', message: 'Command Code 模型目录超过上限' };
  }
  return models.size === 0
    ? { kind: 'unavailable', code: 'catalog_empty', message: 'Command Code 未返回可核验的模型候选' }
    : { kind: 'available', source: `command-code:${version.stdout.text.trim()}:--list-models:local-only`, models: [...models].sort().map((model) => ({ model, effortCapability: null })) };
}

export const commandCodeHarness: WorkerHarness = {
  id: COMMAND_CODE_HARNESS_ID,
  prepareLaunch: (input) => createLaunch(input, false),
  prepareReadOnlyLaunch: (input) => createLaunch(input, true),
  probe: async (modelSelection?: Readonly<WorkerModelSelection>) => {
    if (modelSelection !== undefined && (!workerModelSelectionSchema.safeParse(modelSelection).success || modelSelection.effort !== null)) {
      return { kind: 'unavailable', stage: 'model-selection', profile: 'production-bwrap', diagnostics: ['Command Code requires an exact model ID with null effort'], harnessVersion: null };
    }
    try {
      const directory = mkdtempSync(join(tmpdir(), 'orca-companion-command-code-'));
      const executable = join(directory, 'command-code-no-update');
      writeFileSync(executable, '#!/bin/sh\nexec command-code --no-auto-update --local-only "$@"\n', { mode: 0o700 });
      return await probeHarnessReadOnlyWorker(COMMAND_CODE_HARNESS_ID, modelSelection, { harnessExecutable: executable });
    } catch (error) {
      return { kind: 'unavailable', stage: 'host-verify', profile: 'production-bwrap', diagnostics: [error instanceof Error ? error.message : String(error)], harnessVersion: null };
    }
  },
  queryModels: queryCommandCodeModels,
  prepareResume: (input) => createCommandCodeResumeLaunch(input),
  readTranscriptIdentity: readCommandCodeTranscriptIdentity,
  recoveryInstructions: () => COMMAND_CODE_RECOVERY_INSTRUCTIONS,
  sessionPaths: (companionStateRoot, launchId) => {
    const stateRoot = join(companionStateRoot, COMMAND_CODE_HARNESS_ID);
    const digest = createHash('sha256').update(launchId).digest('hex').slice(0, 20);
    return { stateRoot, reporterPath: join(stateRoot, digest, 'session-start.mjs'), reportPath: join(stateRoot, digest, REPORT_FILENAME) };
  },
  installReporter: installCommandCodeReporter,
  proveSession: proveCommandCodeTranscript,
  inspectTranscript: inspectCommandCodeTranscript,
};
