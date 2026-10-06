/** Native Worker launcher: inherit authentication and configuration from the actual terminal. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { workerModelSelectionSchema, type WorkerHarnessId, type WorkerModelSelection } from '../../domain/model-configuration.js';
import { READ_ONLY_EXECUTION_WRAPPER_SOURCE } from './read-only-execution-wrapper.js';
import { WORKER_RUNTIME_SOURCE } from './worker-runtime.js';

export const CODEX_MODEL_LAUNCHER_FILENAME = 'codex-model-launcher.mjs';
export const CODEX_MODEL_DESCRIPTOR_FILENAME = 'codex-model-launch.json';
export const CODEX_MODEL_DESCRIPTOR_VERSION = 2;
export const SAFE_CODEX_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export type CodexModelLaunchDescriptor = {
  readonly version: typeof CODEX_MODEL_DESCRIPTOR_VERSION;
  readonly executable: string;
  readonly args: readonly string[];
  readonly harness?: WorkerHarnessId;
  readonly expectedStateRoot?: string;
  readonly runtimeReportPath?: string;
  readonly readOnly?: {
    readonly workspace: string;
    readonly stateRoot: string;
    readonly reportDirectory?: string;
  };
};
/** TOML values used only for explicit model, effort and Companion's session hook. */
export function codexConfigValue(value: unknown): string | null {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (Array.isArray(value)) {
    const items = value.map(codexConfigValue);
    return items.includes(null) ? null : '[' + items.join(', ') + ']';
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).map(([key, item]) => {
      const encoded = codexConfigValue(item);
      return encoded === null ? null : JSON.stringify(key) + ' = ' + encoded;
    });
    return entries.includes(null) ? null : '{ ' + entries.join(', ') + ' }';
  }
  return null;
}
export function assertLaunchableModelConfiguration(selection: Readonly<WorkerModelSelection>): void {
  if (!workerModelSelectionSchema.safeParse(selection).success) throw new Error('Worker model selection invalid');
}
export function codexModelArguments(selection: Readonly<WorkerModelSelection>): readonly string[] {
  assertLaunchableModelConfiguration(selection);
  return ['--model', selection.model,
    ...(selection.effort === null ? [] : ['-c', 'model_reasoning_effort=' + JSON.stringify(selection.effort)])];
}
export function buildCodexModelLaunchDescriptor(input: {
  readonly modelSelection: Readonly<WorkerModelSelection>;
  readonly baseArguments: readonly string[];
  readonly sandboxArguments: readonly string[];
  readonly executable?: string;
  readonly resumeSessionId?: string;
  readonly expectedStateRoot?: string;
}): CodexModelLaunchDescriptor {
  if (input.resumeSessionId !== undefined && !SAFE_CODEX_SESSION_ID.test(input.resumeSessionId)) throw new Error('Codex resume session ID invalid');
  return {
    version: CODEX_MODEL_DESCRIPTOR_VERSION,
    executable: input.executable ?? 'codex',
    harness: 'codex',
    args: [...(input.resumeSessionId === undefined ? [] : ['resume', input.resumeSessionId]),
      ...input.baseArguments, ...input.sandboxArguments, ...codexModelArguments(input.modelSelection)],
    ...(input.expectedStateRoot === undefined ? {} : { expectedStateRoot: input.expectedStateRoot }),
  };
}
function launcherSource(): string {
  return `import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
${WORKER_RUNTIME_SOURCE}
${READ_ONLY_EXECUTION_WRAPPER_SOURCE}
function fail(message) {
  process.stderr.write('companion worker launcher: ' + message + '\\n');
  process.exit(2);
}
let descriptor;
try { descriptor = JSON.parse(readFileSync(process.argv[2], 'utf8')); }
catch { fail('cannot read launch descriptor'); }
const allowed = ['version', 'executable', 'args', 'harness', 'expectedStateRoot', 'runtimeReportPath', 'readOnly'];
if (!descriptor || descriptor.version !== ${CODEX_MODEL_DESCRIPTOR_VERSION}
  || Object.keys(descriptor).some(key => !allowed.includes(key))
  || typeof descriptor.executable !== 'string' || !Array.isArray(descriptor.args)
  || descriptor.args.some(arg => typeof arg !== 'string')) fail('invalid launch descriptor');
const env = { ...process.env };
let runtime;
try {
  runtime = descriptor.harness === undefined ? null : nativeWorkerRuntime(descriptor.harness, env);
  if (descriptor.expectedStateRoot !== undefined
    && (!runtime || realpathSync(runtime.stateRoot) !== realpathSync(descriptor.expectedStateRoot))) fail('native runtime changed since original session');
  if (descriptor.runtimeReportPath !== undefined && runtime) writeFileSync(descriptor.runtimeReportPath, JSON.stringify(runtime) + '\\n', { mode: 0o600 });
} catch { fail('native runtime unavailable'); }
let readOnlyArgs = null;
if (descriptor.readOnly !== undefined) {
  try {
    const boundary = descriptor.readOnly;
    const workspace = realpathSync(boundary.workspace);
    const artifacts = realpathSync(boundary.stateRoot);
    const protectedPaths = [workspace];
    const dotGit = join(workspace, '.git');
    if (existsSync(dotGit)) {
      let gitDir;
      try {
        const pointer = readFileSync(dotGit, 'utf8').trim();
        if (!pointer.startsWith('gitdir: ')) throw new Error('invalid git pointer');
        gitDir = realpathSync(resolve(workspace, pointer.slice(8)));
      } catch { gitDir = realpathSync(dotGit); }
      protectedPaths.push(gitDir);
      const commonPointer = join(gitDir, 'commondir');
      if (existsSync(commonPointer)) protectedPaths.push(realpathSync(resolve(gitDir, readFileSync(commonPointer, 'utf8').trim())));
    }
    const overlaps = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
    const writableRoots = runtime ? runtime.writableRoots.map(path => realpathSync(path)) : [];
    if (writableRoots.some(root => root === '/' || root === homedir()
      || protectedPaths.some(target => overlaps(root, target))
      || overlaps(root, dirname(artifacts)))) fail('native writable paths overlap protected state');
    const artifactPaths = [artifacts, ...(boundary.reportDirectory ? [realpathSync(boundary.reportDirectory)] : [])];
    if (artifactPaths.some(root => root === workspace || workspace.startsWith(root + '/')
      || protectedPaths.some(target => target === root || target.startsWith(root + '/'))
      || ['coordination.sqlite', 'checkpoints.sqlite', 'ui.sqlite'].some(name => existsSync(join(root, name))))) fail('artifact paths overlap protected state');
    const temp = join(artifacts, 'tmp');
    mkdirSync(temp, { recursive: true });
    env.TMPDIR = temp;
    readOnlyArgs = readOnlyExecutionArguments({
      workspace, stateRoot: artifacts, reportDirectory: boundary.reportDirectory,
      writableRoots, protectedPaths, executable: descriptor.executable, args: descriptor.args,
    });
  } catch { fail('read-only runtime unavailable'); }
}
const child = spawn(readOnlyArgs === null ? descriptor.executable : 'bwrap', readOnlyArgs ?? descriptor.args, { env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { if (!child.killed) child.kill(signal); });
child.on('error', error => {
  process.stderr.write('companion worker launcher: spawn failed (' + (error.code ?? 'unknown') + ')\\n');
  process.exit(1);
});
child.on('close', (code, signal) => process.exit(typeof code === 'number' ? code : signal ? 1 : 0));
`;
}
export function installCodexModelLauncher(stateRoot: string): string {
  const path = join(stateRoot, CODEX_MODEL_LAUNCHER_FILENAME);
  const source = launcherSource();
  if (!existsSync(path) || readFileSync(path, 'utf8') !== source) writeFileSync(path, source, 'utf8');
  return path;
}
function shellQuote(value: string): string { return "'" + value.replaceAll("'", "'\"'\"'") + "'"; }
export function writeCodexModelLaunch(input: { readonly stateRoot: string; readonly descriptor: CodexModelLaunchDescriptor }): {
  readonly descriptorPath: string; readonly launcherPath: string;
} {
  const descriptorPath = join(input.stateRoot, CODEX_MODEL_DESCRIPTOR_FILENAME);
  writeFileSync(descriptorPath, JSON.stringify(input.descriptor) + '\n', { mode: 0o600 });
  return { descriptorPath, launcherPath: installCodexModelLauncher(input.stateRoot) };
}
export function codexModelLaunchCommand(input: {
  readonly launcherPath: string; readonly descriptorPath: string; readonly nodeExecutable?: string;
}): string {
  return [shellQuote(input.nodeExecutable ?? 'node'), shellQuote(input.launcherPath), shellQuote(input.descriptorPath)].join(' ');
}
