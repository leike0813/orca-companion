import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type {
  HarnessSessionReport, HarnessTranscriptCoverageResult, HarnessTranscriptProofResult,
  PreparedHarnessTerminal, ProveHarnessSessionInput, WorkerHarnessLaunchInput,
  WorkerModelCatalogResult,
} from '../../application/ports/worker-harness.js';
import { createWorkerHarness } from '../../application/ports/worker-harness.js';
import type { TranscriptCoverageEvidence } from '../../application/recovery/recovery-capsule.js';
import type { PreparedTerminalStrategy } from '../../application/worker-launch.js';
import type { WorkerModelSelection } from '../../domain/model-configuration.js';
import { workerModelSelectionSchema } from '../../domain/model-configuration.js';
import { runProcess } from '../orca-cli/process-runner.js';
import { nativeWorkerRuntime } from './worker-runtime.js';
import { candidateSessionPaths, installCandidateReporter, prepareCandidateLaunch, type CandidateResume } from './candidate-worker-launch.js';
import { probeHarnessReadOnlyWorker } from './read-only-execution-wrapper.js';
import { REPORT_TRAMPOLINE, reportingRoot } from './worker-harness-reporting.js';

export const KILO_HARNESS_ID = 'kilo';
const MAX_EXPORT_BYTES = 8 * 1024 * 1024;
const MAX_EXPORT_MESSAGES = 20_000;
const SAFE_ID = /^[a-zA-Z0-9_-]{1,128}$/u;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

type KiloExport = {
  readonly info: Record<string, unknown> & { readonly id: string; readonly directory: string };
  readonly messages: readonly (Record<string, unknown> & {
    readonly info: Record<string, unknown> & { readonly id: string; readonly role: string };
    readonly parts: readonly (Record<string, unknown> & { readonly type: string })[];
  })[];
};

function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

function boundedRead(path: string, maxBytes = MAX_EXPORT_BYTES): Buffer {
  let fd: number | undefined;
  try {
    fd = openSync(path, READ_FLAGS);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) throw new Error('native export bound');
    const bytes = Buffer.alloc(stat.size);
    if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) throw new Error('native export changed');
    return bytes;
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function parseKiloExport(value: unknown): KiloExport | null {
  if (!record(value) || !record(value['info']) || !Array.isArray(value['messages'])
    || typeof value['info']['id'] !== 'string' || !SAFE_ID.test(value['info']['id'])
    || typeof value['info']['directory'] !== 'string' || !isAbsolute(value['info']['directory'])
    || value['messages'].length > MAX_EXPORT_MESSAGES) return null;
  if (value['messages'].some((message) => !record(message) || !record(message['info'])
    || typeof message['info']['id'] !== 'string' || typeof message['info']['role'] !== 'string'
    || !Array.isArray(message['parts']) || message['parts'].some((part) => !record(part) || typeof part['type'] !== 'string'))) return null;
  return value as KiloExport;
}

function readExport(path: string): KiloExport | null {
  try { return parseKiloExport(JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(boundedRead(path)))); }
  catch { return null; }
}

function samePath(left: string, right: string): boolean {
  try { return realpathSync(left) === realpathSync(right); } catch { return false; }
}

function exportTranscript(path: string, workspace: string): KiloExport | null {
  const saved = readExport(path);
  if (saved === null || !samePath(saved.info['directory'], workspace)) return null;
  return saved;
}

async function currentExport(sessionId: string, workspace: string, signal?: AbortSignal): Promise<KiloExport | null> {
  const result = await runProcess({ executable: 'kilo', args: ['export', sessionId, '--pure'], cwd: workspace,
    env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    timeoutMs: 30_000, limits: { maxBytes: MAX_EXPORT_BYTES, maxLines: MAX_EXPORT_MESSAGES * 40 }, ...(signal === undefined ? {} : { signal }) });
  if (result.kind !== 'completed' || result.exitCode !== 0 || result.stdout.truncated) return null;
  try {
    const data = Buffer.from(result.stdout.text, 'utf8');
    if (data.length > MAX_EXPORT_BYTES) return null;
    return parseKiloExport(JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(data)));
  } catch { return null; }
}

function stripJsoncComments(text: string): string {
    let output = '', quoted = false, escaped = false, line = false, block = false;
    for (let i = 0; i < text.length;) {
      const c = text[i]!, next = text[i + 1];
      if (line) { if (c === '\n') { line = false; output += c; } else output += ' '; i++; continue; }
      if (block) { if (c === '*' && next === '/') { output += '  '; i += 2; block = false; } else { output += c === '\n' ? '\n' : ' '; i++; } continue; }
      if (quoted) { output += c; i++; if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
      if (c === '"') { quoted = true; output += c; i++; continue; }
      if (c === '/' && next === '/') { line = true; output += '  '; i += 2; continue; }
      if (c === '/' && next === '*') { block = true; output += '  '; i += 2; continue; }
      output += c; i++;
    }
    return output;
}

function stripJsoncTrailingCommas(text: string): string {
  let output = '', quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      output += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') { quoted = true; output += c; continue; }
    if (c === ',') {
      let next = i + 1;
      while (/\s/u.test(text[next] ?? '')) next++;
      if (text[next] === ']' || text[next] === '}') continue;
    }
    output += c;
  }
  return output;
}

function jsoncObject(path: string): Record<string, unknown> | null {
  try {
    return jsoncObjectFromText(new TextDecoder('utf8', { fatal: true }).decode(boundedRead(path, 1024 * 1024)));
  } catch { return null; }
}

function stringEnd(text: string, start: number): number {
  let escaped = false;
  for (let i = start + 1; i < text.length; i++) {
    if (escaped) escaped = false;
    else if (text[i] === '\\') escaped = true;
    else if (text[i] === '"') return i + 1;
  }
  throw new Error('Kilo JSONC string is incomplete');
}

function matchingEnd(text: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '"') { i = stringEnd(text, i) - 1; continue; }
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return i;
  }
  throw new Error('Kilo JSONC container is incomplete');
}

function locatePluginArray(source: string): { readonly text: string; readonly open: number | null; readonly close: number; readonly rootClose: number } {
  const text = stripJsoncComments(source);
  const rootOpen = text.indexOf('{');
  if (rootOpen < 0) throw new Error('Kilo config root is not an object');
  const rootClose = matchingEnd(text, rootOpen, '{', '}');
  for (let i = rootOpen + 1; i < rootClose;) {
    if (text[i] === '"') {
      const end = stringEnd(text, i);
      let colon = end;
      while (/\s/u.test(text[colon] ?? '')) colon++;
      if (text[colon] === ':') {
        let value = colon + 1;
        while (/\s/u.test(text[value] ?? '')) value++;
        if (JSON.parse(text.slice(i, end)) === 'plugin') {
          if (text[value] !== '[') throw new Error('Kilo config plugin entry is not an array');
          return { text, open: value, close: matchingEnd(text, value, '[', ']'), rootClose };
        }
        i = value;
        if (text[i] === '"') { i = stringEnd(text, i); continue; }
        if (text[i] !== '{' && text[i] !== '[') {
          while (i < rootClose && text[i] !== ',') i++;
          if (text[i] === ',') i++;
          continue;
        }
        const stack: string[] = [];
        if (text[i] === '{' || text[i] === '[') stack.push(text[i] === '{' ? '}' : ']');
        while (stack.length > 0 && i < rootClose) {
          i++;
          if (text[i] === '"') i = stringEnd(text, i) - 1;
          else if (text[i] === '{') stack.push('}');
          else if (text[i] === '[') stack.push(']');
          else if (text[i] === stack.at(-1)) stack.pop();
        }
        if (stack.length === 0) i++;
        continue;
      }
      i = end;
      continue;
    }
    i++;
  }
  return { text, open: null, close: rootClose, rootClose };
}

function addPluginEntry(source: string, entry: string): string {
  const location = locatePluginArray(source), encoded = JSON.stringify(entry);
  if (location.open === null) {
    const before = location.text.slice(0, location.rootClose).trimEnd();
    const comma = before.endsWith(',') ? '' : Object.keys(jsoncObjectFromText(source)).length > 0 ? ',' : '';
    return source.slice(0, location.rootClose) + `${comma}\n  "plugin": [${encoded}]\n` + source.slice(location.rootClose);
  }
  const values = JSON.parse(stripJsoncTrailingCommas(location.text.slice(location.open, location.close + 1))) as unknown;
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) throw new Error('Kilo config plugin list is invalid');
  if (values.includes(entry)) return source;
  const inner = location.text.slice(location.open + 1, location.close).trimEnd();
  const separator = inner.length === 0 || inner.endsWith(',') ? '' : ',';
  return source.slice(0, location.close) + `${separator} ${encoded}` + source.slice(location.close);
}

function jsoncObjectFromText(source: string): Record<string, unknown> {
  const value: unknown = JSON.parse(stripJsoncTrailingCommas(stripJsoncComments(source)));
  if (!record(value)) throw new Error('Kilo config root is invalid');
  return value;
}

function removePluginEntry(source: string, entry: string): string {
  const location = locatePluginArray(source);
  if (location.open === null) return source;
  const values = JSON.parse(stripJsoncTrailingCommas(location.text.slice(location.open, location.close + 1))) as unknown;
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) throw new Error('Kilo config plugin list is invalid');
  if (values.filter((value) => value === entry).length !== 1) throw new Error('Kilo plugin entry is missing or duplicated');
  const encoded = JSON.stringify(entry), start = location.text.indexOf(encoded, location.open + 1), end = start + encoded.length;
  if (start < 0 || start > location.close || location.text.indexOf(encoded, end) >= 0 && location.text.indexOf(encoded, end) < location.close) {
    throw new Error('Kilo plugin entry location is ambiguous');
  }
  let before = start - 1;
  while (/\s/u.test(location.text[before] ?? '')) before--;
  if (location.text[before] === ',') return source.slice(0, before) + source.slice(end);
  let after = end;
  while (/\s/u.test(location.text[after] ?? '')) after++;
  if (location.text[after] === ',') after++;
  return source.slice(0, start) + source.slice(after);
}

function readConfig(path: string): { readonly text: string; readonly mode: number } | null {
  try {
    const fd = openSync(path, READ_FLAGS);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Kilo config exceeds limit');
      const bytes = Buffer.alloc(stat.size);
      if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) throw new Error('Kilo config changed');
      return { text: new TextDecoder('utf8', { fatal: true }).decode(bytes), mode: stat.mode & 0o777 };
    } finally { closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function writeConfig(path: string, text: string, mode: number, original: string | null): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.companion-${process.pid}.tmp`;
  try {
    writeFileSync(temporary, text, { flag: 'wx', mode });
    const latest = readConfig(path);
    if ((latest?.text ?? null) !== original || (latest !== null && latest.mode !== mode)) {
      throw Object.assign(new Error('Kilo native config changed concurrently'), { code: 'native_config_changed' });
    }
    renameSync(temporary, path);
  } finally { try { unlinkSync(temporary); } catch { /* renamed or absent */ } }
}

export function kiloReporterPluginSource(trampoline = join(reportingRoot(), 'report.mjs')): string {
  return `import { spawnSync } from 'node:child_process';\n` +
    `export default async function KiloSessionReporter() { return { event: async ({ event }) => {\n` +
    `if (!['session.created', 'session.updated'].includes(event?.type)) return;\n` +
    `const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(trampoline)}], { input: JSON.stringify(event), timeout: 10000, maxBuffer: 65536, stdio: ['pipe', 'ignore', 'ignore'] });\n` +
    `if (r.error || r.status !== 0) throw new Error('Companion session reporter failed');\n` +
    `} }; }\n`;
}

export function kiloReportingDefinition(env: Readonly<Record<string, string | undefined>> = process.env) {
  const configRoot = env['KILO_CONFIG_DIR'] || join(env['XDG_CONFIG_HOME'] || join(homedir(), '.config'), 'kilo');
  const pluginPath = join(reportingRoot(env), 'kilo-session-reporter.mjs');
  // Native global loading replaces plugin arrays; later files can shadow kilo.jsonc.
  const files = env['KILO_CONFIG_DIR']
    ? ['kilo.jsonc', 'kilo.json', 'opencode.jsonc', 'opencode.json']
    : ['config.json', 'kilo.json', 'kilo.jsonc', 'opencode.json', 'opencode.jsonc'];
  let configPath = join(configRoot, 'kilo.jsonc');
  for (const file of files) {
    const path = join(configRoot, file), config = readConfig(path);
    if (config !== null && jsoncObjectFromText(config.text)['plugin'] !== undefined) configPath = path;
  }
  return { configPath, pluginPath, pluginEntry: pluginPath,
    pluginSource: kiloReporterPluginSource(join(dirname(pluginPath), 'report.mjs')) };
}

export function kiloReportingInstalled(definition = kiloReportingDefinition()): boolean {
  try {
    const config = jsoncObject(definition.configPath);
    const plugins = config?.['plugin'];
    return Array.isArray(plugins) && plugins.includes(definition.pluginEntry)
      && new TextDecoder('utf8', { fatal: true }).decode(boundedRead(definition.pluginPath, 65536)) === definition.pluginSource
      && new TextDecoder('utf8', { fatal: true }).decode(boundedRead(join(dirname(definition.pluginPath), 'report.mjs'), 65536)) === REPORT_TRAMPOLINE;
  } catch { return false; }
}

export function maintainKiloReporting(action: 'install' | 'uninstall', definition = kiloReportingDefinition()): void {
  mkdirSync(dirname(definition.configPath), { recursive: true, mode: 0o700 });
  const lockPath = `${definition.configPath}.companion-lock`;
  const lock = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    const current = readConfig(definition.configPath);
    const source = current?.text ?? '{}\n';
    const config = jsoncObjectFromText(source);
    const plugins = config['plugin'];
    if (plugins !== undefined && (!Array.isArray(plugins) || plugins.some((value) => typeof value !== 'string'))) {
      throw new Error('Kilo config plugin list is not a string array');
    }
    const entries = (plugins ?? []) as string[];
    const count = entries.filter((entry) => entry === definition.pluginEntry).length;
    if (count > 1) throw new Error('Kilo Companion plugin entry is duplicated');

    if (action === 'install') {
      const trampoline = new TextDecoder('utf8', { fatal: true }).decode(boundedRead(join(dirname(definition.pluginPath), 'report.mjs'), 65536));
      if (trampoline !== REPORT_TRAMPOLINE) throw new Error('Shared Companion reporting trampoline is not installed');
      try {
        const existing = new TextDecoder('utf8', { fatal: true }).decode(boundedRead(definition.pluginPath, 65536));
        if (existing !== definition.pluginSource) throw new Error('Kilo Companion plugin path contains different content');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        writeFileSync(definition.pluginPath, definition.pluginSource, { flag: 'wx', mode: 0o600 });
      }
      if (count === 0) writeConfig(definition.configPath, addPluginEntry(source, definition.pluginEntry), current?.mode ?? 0o600, current?.text ?? null);
      return;
    }

    if (count === 1) writeConfig(definition.configPath, removePluginEntry(source, definition.pluginEntry), current?.mode ?? 0o600, current?.text ?? null);
    try {
      if (new TextDecoder('utf8', { fatal: true }).decode(boundedRead(definition.pluginPath, 65536)) !== definition.pluginSource) {
        throw new Error('Kilo Companion plugin changed; refusing to remove it');
      }
      unlinkSync(definition.pluginPath);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
  }
}

export function kiloReporterSource(reportPath: string, runtimeReportPath: string): string {
  return `import { appendFileSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
let text = ''; for await (const chunk of process.stdin) { text += chunk; if (Buffer.byteLength(text) > 65536) process.exit(2); }
const event = JSON.parse(text), info = event?.properties?.info, sessionID = info?.id, suppliedSessionID = event?.properties?.sessionID;
if (!['session.created', 'session.updated'].includes(event?.type) || typeof sessionID !== 'string' || (suppliedSessionID !== undefined && suppliedSessionID !== sessionID) || typeof info.directory !== 'string' || !isAbsolute(info.directory) || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionID)) process.exit(2);
const runtime = JSON.parse(readFileSync(${JSON.stringify(runtimeReportPath)}, 'utf8'));
if (runtime.stateRoot !== resolve(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'kilo') || !Array.isArray(runtime.writableRoots) || !runtime.writableRoots.includes(runtime.stateRoot)) process.exit(2);
const result = spawnSync('kilo', ['export', sessionID, '--pure'], { cwd: info.directory, env: process.env, timeout: 7000, maxBuffer: ${MAX_EXPORT_BYTES}, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
if (result.error || result.status !== 0 || typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > ${MAX_EXPORT_BYTES}) process.exit(2);
const exported = JSON.parse(result.stdout); if (exported?.info?.id !== sessionID || exported?.info?.directory !== info.directory || !Array.isArray(exported.messages)) process.exit(2);
const destination = join(runtime.stateRoot, 'orca-companion-exports', sessionID + '.json'); mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
const temp = destination + '.' + process.pid + '.tmp'; writeFileSync(temp, result.stdout, { flag: 'wx', mode: 0o600 }); renameSync(temp, destination);
appendFileSync(${JSON.stringify(reportPath)}, JSON.stringify({ harness: 'kilo', sessionId: sessionID, transcriptPath: destination, cwd: info.directory, observedAt: new Date().toISOString(), stateRoot: runtime.stateRoot, runtimeRoots: runtime.writableRoots }) + '\\n', { mode: 0o600 });
`;
}

function requireSetup(): void {
  if (!kiloReportingInstalled()) throw Object.assign(new Error('请独立安装 Kilo session.created 插件'), { code: 'worker_reporting_missing' });
}

function launch(input: WorkerHarnessLaunchInput, resume?: CandidateResume): PreparedTerminalStrategy<PreparedHarnessTerminal> {
  if (input.modelSelection.effort !== null) throw new Error('Kilo requires an exact native model ID with null effort');
  const strategy = prepareCandidateLaunch({ harness: KILO_HARNESS_ID, executable: 'kilo', input, ...(resume === undefined ? {} : { resume }),
    arguments: () => ['--model', input.modelSelection.model, ...(resume === undefined ? [] : ['--session', resume.sessionId])],
    reporterSource: kiloReporterSource, checkSetup: requireSetup,
    verifyResume: (workspace, original) => {
      const saved = exportTranscript(original.transcriptRef, workspace);
      if (saved?.info['id'] !== original.sessionId) throw new Error('Kilo 原 Session 身份不可证明');
      return Promise.resolve();
    },
  });
  return { ...strategy, prepare: async (context) => {
    const prepared = await strategy.prepare(context);
    // Resume must keep tools and reporting inside this launch's OS boundary.
    return { ...prepared, command: `KILO_NO_DAEMON=1 ${prepared.command}` };
  } };
}

type ValidKiloReportInput = ProveHarnessSessionInput & { readonly report: HarnessSessionReport & {
  readonly sessionId: string; readonly transcriptPath: string; readonly cwd: string; readonly observedAt: string;
  readonly stateRoot: string; readonly runtimeRoots: readonly string[];
} };

function validReport(input: ProveHarnessSessionInput): input is ValidKiloReportInput {
  const report: HarnessSessionReport = input.report;
  if (typeof report.sessionId !== 'string' || typeof report.transcriptPath !== 'string' || typeof report.cwd !== 'string'
    || typeof report.observedAt !== 'string' || typeof report.stateRoot !== 'string' || !report.runtimeRoots?.length
    || report.harness !== KILO_HARNESS_ID) return false;
  const at = Date.parse(report.observedAt), from = Date.parse(input.dispatchStartedAt), end = Date.parse(input.bindingDeadlineAt);
  try {
    const runtime = nativeWorkerRuntime(KILO_HARNESS_ID);
    const stateRoot = realpathSync(runtime.stateRoot), roots = runtime.writableRoots.map((root) => realpathSync(root));
    const transcript = realpathSync(report.transcriptPath);
    return SAFE_ID.test(report.sessionId) && Number.isFinite(at) && Number.isFinite(from) && Number.isFinite(end)
      && at >= from && at <= end && samePath(report.cwd, input.workspace) && samePath(report.stateRoot, input.expectedStateRoot)
      && stateRoot === realpathSync(input.expectedStateRoot) && roots.length === report.runtimeRoots.length
      && roots.every((root) => report.runtimeRoots!.some((item) => samePath(root, item)))
      && roots.some((root) => inside(root, transcript)) && basename(transcript) === `${report.sessionId}.json`
      && report.transcriptPath === resolve(report.transcriptPath)
      && lstatSync(report.transcriptPath).isFile() && !lstatSync(report.transcriptPath).isSymbolicLink()
      && exportTranscript(report.transcriptPath, input.workspace)?.info['id'] === report.sessionId;
  } catch { return false; }
}

export function inspectKiloTranscript(transcriptRef: string): Promise<HarnessTranscriptCoverageResult> {
  const saved = readExport(transcriptRef);
  if (saved === null) return Promise.resolve({ kind: 'transcript_unavailable', reason: 'Kilo exact session export is unavailable' });
  return currentExport(saved.info['id'], saved.info['directory']).then((fresh) => {
    if (fresh === null || fresh.info['id'] !== saved.info['id'] || !samePath(fresh.info['directory'], saved.info['directory'])
      || fresh.messages.length === 0 || !isDeepStrictEqual(fresh.messages, saved.messages)) return { kind: 'transcript_unavailable' as const, reason: 'Kilo exact session history is incomplete or mismatched' };
    const ids = saved.messages.map((message) => message.info.id);
    if (new Set(ids).size !== ids.length) return { kind: 'transcript_unavailable' as const, reason: 'Kilo export contains duplicate message identities' };
    const evidence: TranscriptCoverageEvidence = { coverage: 'complete', readableRange: { transcriptRef: resolve(transcriptRef), fromEventRef: ids[0]!, toEventRef: ids.at(-1)! }, gaps: [], lastCompleteEventRef: ids.at(-1)! };
    return { kind: 'covered' as const, evidence };
  });
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

export async function readKiloTranscriptIdentity(input: { readonly transcriptRef: string; readonly workspace: string }): Promise<
  { readonly providerSessionId: string } | { readonly kind: 'transcript_unavailable'; readonly reason: string }
> {
  const exported = exportTranscript(input.transcriptRef, input.workspace);
  if (exported === null) return { kind: 'transcript_unavailable', reason: 'Kilo session export identity or cwd cannot be proven' };
  const fresh = await currentExport(exported.info['id'], input.workspace);
  if (fresh === null || fresh.info['id'] !== exported.info['id'] || !samePath(fresh.info['directory'], input.workspace)) {
    return { kind: 'transcript_unavailable', reason: 'Kilo exact-ID public export identity or cwd cannot be proven' };
  }
  return { providerSessionId: exported.info['id'] };
}

export async function proveKiloTranscript(input: ProveHarnessSessionInput): Promise<HarnessTranscriptProofResult> {
  if (!validReport(input)) return { kind: 'transcript_unavailable', reason: 'Kilo report, native runtime roots, session export, or workspace mismatch' };
  const report = input.report;
  const fresh = await currentExport(report.sessionId, input.workspace);
  if (fresh === null || fresh.info['id'] !== report.sessionId || !samePath(fresh.info['directory'], input.workspace)) {
    return { kind: 'transcript_unavailable', reason: 'Kilo exact-ID public export does not match the reported session' };
  }
  return { kind: 'proven', proof: { providerSessionId: report.sessionId, transcriptRef: report.transcriptPath, observedAt: report.observedAt } };
}

export const KILO_RECOVERY_INSTRUCTIONS = [
  '只通过 `kilo export <exact-session-id> --pure` 读取该 Session 的公开 JSON；不得查询 Kilo 私有数据库。',
  '先核对 `info.id` 与 `info.directory`，再按 messages 数组原生顺序读取每条 info 与 parts。',
  '导出超限、结构不完整或 ID/cwd 不一致时停止；不要改用最近 Session。',
] as const;

export const kiloHarness = createWorkerHarness({
  id: KILO_HARNESS_ID,
  prepareLaunch: (input) => launch(input),
  prepareReadOnlyLaunch: (input) => launch({ ...input, sandboxMode: 'read-only-local-control' }),
  prepareResume: (input) => launch(input, input),
  probe: async (selection?: Readonly<WorkerModelSelection>) => {
    if (selection !== undefined && (!workerModelSelectionSchema.safeParse(selection).success || selection.effort !== null)) {
      return { kind: 'unavailable', stage: 'model-selection', profile: 'production-bwrap', diagnostics: ['Kilo requires an exact model ID with null effort'], harnessVersion: null };
    }
    if (!kiloReportingInstalled()) return { kind: 'unavailable', stage: 'reporting', profile: 'production-bwrap', diagnostics: ['Kilo session reporter plugin is not installed'], harnessVersion: null };
    return probeHarnessReadOnlyWorker(KILO_HARNESS_ID, selection, { harnessExecutable: 'kilo' });
  },
  queryModels: async (input): Promise<WorkerModelCatalogResult> => {
    const env = Object.fromEntries(Object.entries(input.env ?? process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    const started = Date.now();
    const version = await runProcess({ executable: 'kilo', args: ['--version'], cwd: input.cwd, env, timeoutMs: 5000,
      limits: { maxBytes: 65536, maxLines: 100 }, ...(input.signal === undefined ? {} : { signal: input.signal }) });
    if (version.kind !== 'completed' || version.exitCode !== 0 || version.stdout.truncated || !version.stdout.text.trim()) {
      return { kind: 'unavailable', code: 'catalog_query_failed', message: 'Kilo version unavailable' };
    }
    const output = await runProcess({ executable: 'kilo', args: ['models', '--pure'], cwd: input.cwd, env,
      timeoutMs: Math.max(1, 30000 - (Date.now() - started)), limits: { maxBytes: 1024 * 1024, maxLines: 4097 },
      ...(input.signal === undefined ? {} : { signal: input.signal }) });
    if (output.kind !== 'completed' || output.exitCode !== 0 || output.stdout.truncated || Date.now() - started > 30000) {
      return { kind: 'unavailable', code: 'catalog_query_failed', message: 'Kilo model catalog unavailable' };
    }
    const rows = output.stdout.text.split(/\r?\n/u).filter(Boolean);
    if (!rows.length || rows.length > 4096 || rows.some((row) => !/^[^\s/]+\/[^\s]+$/u.test(row))) {
      return { kind: 'unavailable', code: 'catalog_output_unrecognized', message: 'Kilo model catalog exceeds bounds or has unknown rows' };
    }
    return { kind: 'available', source: 'kilo:' + version.stdout.text.trim() + ':kilo models --pure',
      models: [...new Set(rows)].map((model) => ({ model, effortCapability: null })) };
  },
  sessionPaths: (root, launchId) => candidateSessionPaths(KILO_HARNESS_ID, root, launchId),
  installReporter: (paths) => installCandidateReporter(paths, kiloReporterSource(paths.reportPath, join(dirname(paths.reporterPath), 'native-runtime.json'))),
  readTranscriptIdentity: readKiloTranscriptIdentity,
  proveSession: proveKiloTranscript,
  inspectTranscript: inspectKiloTranscript,
  recoveryInstructions: () => KILO_RECOVERY_INSTRUCTIONS,
});

