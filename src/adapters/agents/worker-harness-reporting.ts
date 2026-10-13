import { constants, closeSync, fstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const COMPANION_REPORT_HOOK = 'orca-companion-session-report';
export type ReportingDefinition = {
  readonly configPath: string;
  readonly entry: Readonly<Record<string, unknown>>;
};

export function readReportingText(path: string, maxBytes = 1024 * 1024): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('Native metadata exceeds bounds');
    const data = Buffer.alloc(stat.size);
    if (readSync(fd, data, 0, data.length, 0) !== data.length) throw new Error('Native metadata changed');
    return new TextDecoder('utf8', { fatal: true }).decode(data);
  } finally { closeSync(fd); }
}

export function readReportingJson(path: string, maxBytes = 1024 * 1024): Record<string, unknown> {
  const value: unknown = JSON.parse(readReportingText(path, maxBytes));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Native metadata is not an object');
  return value as Record<string, unknown>;
}

export function installReportingTrampoline(root = reportingRoot()): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, 'report.mjs');
  try {
    if (readReportingText(path, 65536) !== REPORT_TRAMPOLINE) throw new Error('Companion reporting trampoline conflicts');
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  writeFileSync(path, REPORT_TRAMPOLINE, { flag: 'wx', mode: 0o600 });
}

export function reportingRoot(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return join(env['XDG_DATA_HOME'] || join(homedir(), '.local', 'share'), 'orca-companion', 'worker-reporting');
}

export function reportingCommand(): string {
  const quote = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
  return `${quote(process.execPath)} ${quote(join(reportingRoot(), 'report.mjs'))}`;
}

export function antigravityReportingDefinition(): ReportingDefinition {
  const handler = { type: 'command', command: reportingCommand(), timeout: 10 };
  return { configPath: join(homedir(), '.gemini', 'config', 'hooks.json'),
    entry: { PreInvocation: [handler], PostInvocation: [handler], Stop: [handler] } };
}

// A persistent hook only forwards native input to the host-owned per-launch reporter.
export const REPORT_TRAMPOLINE = `import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
const path = process.env.ORCA_COMPANION_SESSION_REPORTER;
if (!path) process.exit(0);
if (!isAbsolute(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile() || realpathSync(path) !== path) process.exit(2);
let input = ''; for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 65536) process.exit(2); }
const result = spawnSync(process.execPath, [path], { input, timeout: 8000, maxBuffer: 65536, stdio: ['pipe', 'ignore', 'ignore'] });
process.exit(result.status ?? 2);
`;

export function reportingInstalled(definition: ReportingDefinition): boolean {
  try {
    const config = readReportingJson(definition.configPath);
    return isDeepStrictEqual(config[COMPANION_REPORT_HOOK], definition.entry)
      && readTrampoline() === REPORT_TRAMPOLINE;
  } catch { return false; }
}

function readTrampoline(): string {
  return readReportingText(join(reportingRoot(), 'report.mjs'), 65536);
}

export function maintainReporting(definition: ReportingDefinition, action: 'install' | 'uninstall', artifactRoot = reportingRoot()): void {
  mkdirSync(dirname(definition.configPath), { recursive: true, mode: 0o700 });
  const lock = `${definition.configPath}.companion-lock`;
  const fd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  let temp: string | undefined;
  try {
    let original: string | null;
    try { original = readReportingText(definition.configPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; original = null; }
    const raw: unknown = original === null ? {} : JSON.parse(original);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('Native metadata is not an object');
    const config = raw as Record<string, unknown>;
    if (action === 'install') {
      if (config[COMPANION_REPORT_HOOK] !== undefined && !isDeepStrictEqual(config[COMPANION_REPORT_HOOK], definition.entry)) {
        throw new Error('Companion hook entry has conflicting configuration');
      }
      installReportingTrampoline(artifactRoot);
      config[COMPANION_REPORT_HOOK] = definition.entry;
    } else {
      if (config[COMPANION_REPORT_HOOK] === undefined) return;
      if (!isDeepStrictEqual(config[COMPANION_REPORT_HOOK], definition.entry)) throw new Error('Companion hook entry changed');
      delete config[COMPANION_REPORT_HOOK];
    }
    temp = `${definition.configPath}.companion-${process.pid}`;
    writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    let beforeRename: string | null;
    try { beforeRename = readReportingText(definition.configPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; beforeRename = null; }
    if (beforeRename !== original) throw new Error('Native reporter configuration changed during update');
    renameSync(temp, definition.configPath);
    temp = undefined;
    const actual = readReportingJson(definition.configPath);
    if (JSON.stringify(actual) !== JSON.stringify(config)) throw new Error('Reporter configuration readback failed');
  } finally {
    closeSync(fd);
    if (temp !== undefined) unlinkSync(temp);
    unlinkSync(lock);
  }
}
