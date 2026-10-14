import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { HarnessSessionReport, ProveHarnessSessionInput, WorkerHarness, WorkerHarnessLaunchInput } from '../../application/ports/worker-harness.js';
import { candidateSessionPaths, installCandidateReporter, prepareCandidateLaunch, type CandidateResume } from './candidate-worker-launch.js';
import { probeHarnessReadOnlyWorker } from './read-only-execution-wrapper.js';
import { antigravityReportingDefinition, readReportingJson, reportingInstalled } from './worker-harness-reporting.js';
import { runProcess } from '../orca-cli/process-runner.js';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

function optionalNativeJson(path: string, maxBytes?: number): Record<string, unknown> {
  try { return readReportingJson(path, maxBytes); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
}

function readNativeText(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_TRANSCRIPT_BYTES) throw new Error('Native history exceeds bounds');
    const bytes = Buffer.alloc(stat.size);
    if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) throw new Error('Native history changed');
    return new TextDecoder('utf8', { fatal: true }).decode(bytes);
  } finally { closeSync(fd); }
}

/** Exact summaries survive replacement of the TUI's cache entries. */
function persistedWorkspace(stateRoot: string, sessionId: string): unknown[] | null {
  const path = join(stateRoot, 'conversation_summaries.db');
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024 || realpathSync(path) !== path) throw new Error('native summary path');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=100');
    const row = db.prepare('SELECT workspace_uris FROM conversation_summaries WHERE conversation_id=? LIMIT 1').get(sessionId);
    if (row === undefined) return null;
    if (typeof row['workspace_uris'] !== 'string' || Buffer.byteLength(row['workspace_uris']) > 65536) throw new Error('native summary workspace');
    const roots: unknown = JSON.parse(row['workspace_uris']);
    if (!Array.isArray(roots)) throw new Error('native summary workspace');
    return roots as unknown[];
  } finally { db.close(); }
}

function identity(transcriptRef: string, workspace: string): { readonly providerSessionId: string } | null {
  try {
    if (!isAbsolute(transcriptRef) || lstatSync(transcriptRef).isSymbolicLink() || realpathSync(transcriptRef) !== resolve(transcriptRef)) return null;
    const logs = dirname(transcriptRef), brain = dirname(dirname(logs)), id = brain.split('/').at(-1)!;
    const stateRoot = dirname(dirname(brain));
    if (!ID.test(id) || !['transcript.jsonl', 'transcript_full.jsonl'].some((name) => transcriptRef === join(stateRoot, 'brain', id, '.system_generated', 'logs', name))) return null;
    const roots = persistedWorkspace(stateRoot, id);
    if (roots !== null && (roots.length !== 1 || typeof roots[0] !== 'string'
      || realpathSync(fileURLToPath(roots[0])) !== realpathSync(workspace))) return null;
    const cache = optionalNativeJson(join(stateRoot, 'cache', 'conversation_metadata.json'), 4 * 1024 * 1024);
    const entry = (cache['conversations'] as Record<string, { summary?: Record<string, unknown> }> | undefined)?.[id]?.summary;
    if (entry !== undefined) {
      if (entry['ID'] !== id || !Array.isArray(entry['WorkspaceURIs']) || entry['WorkspaceURIs'].length !== 1
        || realpathSync(fileURLToPath(String(entry['WorkspaceURIs'][0]))) !== realpathSync(workspace)) return null;
    } else if (roots === null) {
      const index = optionalNativeJson(join(stateRoot, 'cache', 'last_conversations.json'));
      const matches = Object.entries(index).filter(([, value]) => value === id);
      if (matches.length > 1) return null;
      if (matches.length === 1) {
        if (realpathSync(matches[0]![0]) !== realpathSync(workspace)) return null;
      } else {
        const lines = readNativeText(join(stateRoot, 'history.jsonl')).trim().split('\n');
        if (lines.length > 20000) return null;
        const roots = new Set(lines.map((line): Record<string, unknown> => JSON.parse(line) as Record<string, unknown>)
          .filter((row) => row['conversationId'] === id).map((row) => typeof row['workspace'] === 'string' ? realpathSync(row['workspace']) : null));
        if (roots.size !== 1 || !roots.has(realpathSync(workspace))) return null;
      }
    }
    return { providerSessionId: id };
  } catch { return null; }
}

export function antigravityReporterSource(reportPath: string, runtimeReportPath: string): string {
  return `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
let text = ''; for await (const chunk of process.stdin) { text += chunk; if (Buffer.byteLength(text) > 65536) process.exit(2); }
const p = JSON.parse(text), runtime = JSON.parse(readFileSync(${JSON.stringify(runtimeReportPath)}, 'utf8'));
if (typeof p.conversationId !== 'string' || !Array.isArray(p.workspacePaths) || p.workspacePaths.length !== 1 || typeof p.transcriptPath !== 'string') process.exit(2);
appendFileSync(${JSON.stringify(reportPath)}, JSON.stringify({ harness: 'antigravity', sessionId: p.conversationId, transcriptPath: p.transcriptPath, cwd: p.workspacePaths[0], observedAt: new Date().toISOString(), stateRoot: runtime.stateRoot, runtimeRoots: runtime.writableRoots }) + '\\n', { mode: 0o600 });
if (typeof p.modelName === 'string') writeFileSync(${JSON.stringify(reportPath + '.model.json')}, JSON.stringify({ sessionId: p.conversationId, transcriptPath: p.transcriptPath, model: p.modelName }) + '\\n', { mode: 0o600 });
`;
}

function requireSetup(): void {
  if (!reportingInstalled(antigravityReportingDefinition())) throw Object.assign(new Error('请独立安装 Antigravity Session 报告 hook'), { code: 'worker_reporting_missing' });
}

function launch(input: WorkerHarnessLaunchInput, resume?: CandidateResume) {
  if (input.modelSelection.effort !== null) throw new Error('Antigravity 当前目录未证明独立 effort override');
  return prepareCandidateLaunch({ harness: 'antigravity', executable: 'agy', input, outputProtocol: 'antigravity-tui',
    ...(resume === undefined ? {} : { resume }),
    arguments: () => ['--dangerously-skip-permissions', '--model', input.modelSelection.model,
      ...(input.modelSelection.effort === null ? [] : ['--effort', input.modelSelection.effort]),
      ...(resume === undefined ? [] : ['--conversation', resume.sessionId])],
    reporterSource: antigravityReporterSource, checkSetup: requireSetup,
    verifyResume: (workspace, original) => {
      if (identity(original.transcriptRef, workspace)?.providerSessionId !== original.sessionId) throw new Error('Antigravity 原 Session 身份不可证明');
      return Promise.resolve();
    },
  });
}

function reportValid(input: ProveHarnessSessionInput): boolean {
  const p: HarnessSessionReport = input.report;
  if (p.harness !== 'antigravity' || p.sessionId === null || p.transcriptPath === null || p.cwd === null || p.observedAt === null || p.stateRoot == null || !p.runtimeRoots?.length) return false;
  const at = Date.parse(p.observedAt), from = Date.parse(input.dispatchStartedAt), end = Date.parse(input.bindingDeadlineAt);
  try {
    return ID.test(p.sessionId) && Number.isFinite(at) && Number.isFinite(from) && Number.isFinite(end) && at >= from && at <= end
      && realpathSync(p.cwd) === realpathSync(input.workspace) && realpathSync(p.stateRoot) === realpathSync(input.expectedStateRoot)
      && p.runtimeRoots.length === 1 && realpathSync(p.runtimeRoots[0]!) === realpathSync(p.stateRoot)
      && ['transcript.jsonl', 'transcript_full.jsonl'].some((name) => p.transcriptPath === join(p.stateRoot!, 'brain', p.sessionId!, '.system_generated', 'logs', name))
      && identity(p.transcriptPath, input.workspace)?.providerSessionId === p.sessionId;
  } catch { return false; }
}

export function inspectAntigravityTranscript(transcriptRef: string) {
  let fd: number | undefined;
  try {
    if (lstatSync(transcriptRef).isSymbolicLink() || realpathSync(transcriptRef) !== resolve(transcriptRef)) throw new Error('transcript path');
    fd = openSync(transcriptRef, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_TRANSCRIPT_BYTES) throw new Error('transcript size');
    const bytes = Buffer.alloc(stat.size);
    if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) throw new Error('transcript changed');
    const lines = new TextDecoder('utf8', { fatal: true }).decode(bytes).trim().split('\n');
    if (lines.length > 20000) throw new Error('transcript lines');
    const rows = lines.map((line): Record<string, unknown> => JSON.parse(line) as Record<string, unknown>);
    if (rows.some((row, index) => row['step_index'] !== index || !(row['status'] === 'DONE'
      || (row['status'] === 'ERROR' && row['type'] === 'GENERIC' && row['source'] === 'MODEL'
        && rows[index - 1]?.['type'] === 'PLANNER_RESPONSE' && Array.isArray(rows[index - 1]?.['tool_calls'])
        && (rows[index - 1]!['tool_calls'] as unknown[]).length > 0))
      || !['USER_INPUT', 'PLANNER_RESPONSE', 'GENERIC', 'SYSTEM_MESSAGE'].includes(String(row['type']))
      || !['USER_EXPLICIT', 'MODEL', 'SYSTEM'].includes(String(row['source']))
      || typeof row['created_at'] !== 'string' || !Number.isFinite(Date.parse(row['created_at']))
      || (row['content'] !== undefined && typeof row['content'] !== 'string')
      || (row['content'] === undefined && !(row['type'] === 'PLANNER_RESPONSE'
        && (typeof row['thinking'] === 'string' || Array.isArray(row['tool_calls'])))))) throw new Error('transcript coverage');
    return Promise.resolve({ kind: 'covered' as const, evidence: { coverage: 'complete' as const,
      readableRange: { transcriptRef, fromEventRef: 'step:0', toEventRef: `step:${rows.length - 1}` },
      gaps: [], lastCompleteEventRef: `step:${rows.length - 1}` } });
  } catch { return Promise.resolve({ kind: 'transcript_unavailable' as const, reason: 'Antigravity 精确活动 transcript 不可完整核验' }); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export const antigravityHarness: WorkerHarness = {
  id: 'antigravity', prepareLaunch: (input) => launch(input),
  prepareReadOnlyLaunch: (input) => launch({ ...input, sandboxMode: 'read-only-local-control' }),
  prepareResume: (input) => launch(input, input),
  probe: async (selection) => {
    if (!reportingInstalled(antigravityReportingDefinition())) return { kind: 'unavailable', stage: 'reporting', profile: 'bwrap-read-only', diagnostics: ['Antigravity 报告 hook 未安装'], harnessVersion: null };
    return probeHarnessReadOnlyWorker('antigravity', selection, { harnessExecutable: 'agy' });
  },
  queryModels: async (input) => {
    const env = Object.fromEntries(Object.entries(input.env ?? process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    const started = Date.now();
    const version = await runProcess({ executable: 'agy', args: ['--version'], cwd: input.cwd, env, timeoutMs: 5000,
      limits: { maxBytes: 65536, maxLines: 100 }, ...(input.signal === undefined ? {} : { signal: input.signal }) });
    if (version.kind !== 'completed' || version.exitCode !== 0 || version.stdout.truncated || !version.stdout.text.trim()) return { kind: 'unavailable', code: 'catalog_query_failed', message: 'Antigravity 版本不可核验' };
    const output = await runProcess({ executable: 'agy', args: ['models'], cwd: input.cwd, env, timeoutMs: Math.max(1, 30000 - (Date.now() - started)),
      limits: { maxBytes: 1024 * 1024, maxLines: 5000 }, ...(input.signal === undefined ? {} : { signal: input.signal }) });
    if (output.kind !== 'completed' || output.exitCode !== 0 || output.stdout.truncated) return { kind: 'unavailable', code: 'catalog_query_failed', message: 'Antigravity 模型目录不可核验' };
    if (Date.now() - started > 30000) return { kind: 'unavailable', code: 'catalog_query_failed', message: 'Antigravity 目录超时' };
    const rows = output.stdout.text.split('\n').filter((line) => line.includes('\t'));
    if (rows.some((line) => !/^[A-Za-z0-9][A-Za-z0-9._-]*\t\S/u.test(line))) return { kind: 'unavailable', code: 'catalog_output_unrecognized', message: 'Antigravity 目录结构不可核验' };
    const models = [...new Set(rows.map((line) => line.split('\t')[0]!))];
    if (models.length === 0 || models.length > 4096) return { kind: 'unavailable', code: 'catalog_output_unrecognized', message: 'Antigravity 模型目录不可核验' };
    return { kind: 'available', source: 'antigravity:' + version.stdout.text.trim() + ':agy models', models: models.map((model) => ({ model, effortCapability: null })) };
  },
  sessionPaths: (root, id) => candidateSessionPaths('antigravity', root, id),
  installReporter: (paths) => installCandidateReporter(paths, antigravityReporterSource(paths.reportPath, join(dirname(paths.reporterPath), 'native-runtime.json'))),
  proveSession: (input) => Promise.resolve(reportValid(input)
    ? { kind: 'proven', proof: { providerSessionId: input.report.sessionId!, transcriptRef: input.report.transcriptPath!, observedAt: input.report.observedAt! } }
    : { kind: 'transcript_unavailable', reason: 'Antigravity report 与精确 native metadata/cwd 不一致或 metadata 缺失' }),
  readTranscriptIdentity: ({ transcriptRef, workspace }) => Promise.resolve(identity(transcriptRef, workspace)
    ?? { kind: 'transcript_unavailable', reason: 'Antigravity 原生 Session 身份不可核验' }),
  inspectTranscript: inspectAntigravityTranscript,
  recoveryInstructions: () => ['只读取 binding 指定的精确 Antigravity transcript；step_index 是事件身份，引用格式 step:N。',
    '按 step_index 活动顺序读取 USER_INPUT、PLANNER_RESPONSE、tool 记录；不得替换 transcript 路径或借用其它 conversation。',
    'Task Envelope 已给出完整输出字段与可信覆盖证据；taskKind 是任务标签，无需搜索 schema、测试程序、Orca 安装文件或其他目录。',
    '用有界 Node 读取精确 JSONL，逐行 JSON.parse 并输出必要 step_index/content。run_command 使用 RunPersistent=false、WaitMsBeforeAsync=30000，在前台完成读取。',
    '只接受 DONE 与紧接原生工具调用的 GENERIC/ERROR 终态；活动事件、缺失事件或未知结构时停止。input_tokens/cache_read_tokens/output_tokens 是原生 usage。'],
};
