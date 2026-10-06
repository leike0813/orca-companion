import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { WorkerHarnessId } from '../../domain/model-configuration.js';

export type WorkerRuntime = {
  readonly stateRoot: string;
  readonly writableRoots: readonly string[];
};

/** Non-secret native paths, evaluated inside the actual terminal's launch environment. */
function resolveNativeWorkerRuntime(
  harness: WorkerHarnessId,
  env: Readonly<Record<string, string | undefined>>,
  home: string,
  { existsSync, dirname, isAbsolute, join, resolve }: { existsSync: typeof import('node:fs').existsSync; dirname: typeof import('node:path').dirname; isAbsolute: typeof import('node:path').isAbsolute; join: typeof import('node:path').join; resolve: typeof import('node:path').resolve },
): WorkerRuntime {
  const absolute = (path: string): string => {
    if (!isAbsolute(path)) throw new Error('native runtime path must be absolute');
    return resolve(path);
  };
  let stateRoot: string;
  let roots: string[];
  switch (harness) {
    case 'codex':
      stateRoot = absolute(env['CODEX_HOME'] || join(home, '.codex'));
      roots = [stateRoot];
      break;
    case 'claude':
      stateRoot = absolute(env['CLAUDE_CONFIG_DIR'] || join(home, '.claude'));
      roots = [stateRoot];
      break;
    case 'pi':
      stateRoot = absolute(env['PI_CODING_AGENT_DIR'] || join(home, '.pi', 'agent'));
      roots = [stateRoot];
      if (env['PI_CODING_AGENT_SESSION_DIR']) roots.push(absolute(env['PI_CODING_AGENT_SESSION_DIR']));
      break;
    case 'omp': {
      const profile = (env['OMP_PROFILE'] ?? env['PI_PROFILE'] ?? '').trim();
      if (profile && profile !== 'default' && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile)) throw new Error('native profile invalid');
      const base = join(home, env['PI_CONFIG_DIR'] || '.omp');
      const config = profile && profile !== 'default' ? join(base, 'profiles', profile) : base;
      stateRoot = absolute(profile && profile !== 'default' ? join(config, 'agent') : env['PI_CODING_AGENT_DIR'] || join(config, 'agent'));
      roots = [stateRoot, absolute(config)];
      if (stateRoot === join(config, 'agent')) {
        for (const key of ['XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) {
          const xdg = env[key];
          if (!xdg) continue;
          const path = profile && profile !== 'default' ? join(xdg, 'omp', 'profiles', profile) : join(xdg, 'omp');
          if (existsSync(path)) roots.push(absolute(path));
        }
      }
      break;
    }
    case 'opencode':
      stateRoot = absolute(join(env['XDG_DATA_HOME'] || join(home, '.local', 'share'), 'opencode'));
      roots = [
        stateRoot,
        absolute(join(env['XDG_STATE_HOME'] || join(home, '.local', 'state'), 'opencode')),
        absolute(join(env['XDG_CACHE_HOME'] || join(home, '.cache'), 'opencode')),
      ];
      if (env['OPENCODE_DB'] && env['OPENCODE_DB'] !== ':memory:') roots.push(dirname(resolve(stateRoot, env['OPENCODE_DB'])));
      break;
    default:
      throw new Error('worker harness unregistered');
  }
  return { stateRoot, writableRoots: [...new Set(roots)] };
}

export function nativeWorkerRuntime(harness: WorkerHarnessId, env: Readonly<Record<string, string | undefined>> = process.env, home = homedir()): WorkerRuntime {
  return resolveNativeWorkerRuntime(harness, env, home, { existsSync, dirname, isAbsolute, join, resolve });
}
export const WORKER_RUNTIME_SOURCE = 'const resolveNativeWorkerRuntime = ' + resolveNativeWorkerRuntime.toString() + ';\n'
  + 'const nativeWorkerRuntime = (harness, env = process.env, home = homedir()) => resolveNativeWorkerRuntime(harness, env, home, { existsSync, dirname, isAbsolute, join, resolve });\n';
