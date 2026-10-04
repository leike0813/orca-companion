import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  DEFAULT_TUI_PREFERENCES,
  StatuslinePreferences,
  TuiPreferences,
  type TuiPreferencesLoad,
  type TuiPreferencesPort,
  type TuiPreferencesSaveInput,
  type TuiPreferencesSaveResult,
} from '../../application/configuration/tui-preferences.js';

const DIRECTORY = 'orca-companion';
const FILENAME = 'tui-preferences.json';
const MAX_FILE_BYTES = 64 * 1024;
const SAFE_NOTICES = {
  unavailable: '无法读取偏好设置；原文件已保留。',
  invalid: '偏好设置已损坏或使用了较新格式；原文件已保留。',
} as const;
const SAFE_FAILURES = {
  invalid_request: '偏好设置更新内容无效。',
  unavailable: '无法安全更新偏好设置。',
  lock_busy: '偏好设置锁仍存在；确认没有写入进程后再移除锁文件并重试。',
  write_failed: '无法安全更新偏好设置。',
} as const;

type StoreRead = { kind: 'missing' } | { kind: 'valid'; preferences: TuiPreferences } | { kind: 'invalid' } | { kind: 'unavailable' };

function pathFor(configHome?: string): string {
  const root = configHome ?? (process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config'));
  return join(root, DIRECTORY, FILENAME);
}

function parseFile(path: string): StoreRead {
  let raw: string;
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_FILE_BYTES) return { kind: 'invalid' };
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (errno(error) === 'ENOENT') return { kind: 'missing' };
    return { kind: 'unavailable' };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { kind: 'invalid' };
  }
  const parsed = TuiPreferences.safeParse(value);
  return parsed.success ? { kind: 'valid', preferences: parsed.data } : { kind: 'invalid' };
}

function errno(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function loaded(read: StoreRead): TuiPreferencesLoad {
  if (read.kind === 'valid') return { kind: 'loaded', preferences: read.preferences, writable: true, notice: null };
  if (read.kind === 'missing') return { kind: 'loaded', preferences: DEFAULT_TUI_PREFERENCES, writable: true, notice: null };
  return {
    kind: 'loaded',
    preferences: DEFAULT_TUI_PREFERENCES,
    writable: false,
    notice: read.kind === 'invalid' ? SAFE_NOTICES.invalid : SAFE_NOTICES.unavailable,
  };
}

function failure(code: keyof typeof SAFE_FAILURES): TuiPreferencesSaveResult {
  return { kind: 'failed', code, message: SAFE_FAILURES[code] };
}

function releaseLock(path: string, fd: number): void {
  try { unlinkSync(path); } catch { /* A completed write remains completed if lock cleanup fails. */ }
  try { closeSync(fd); } catch { /* The lock pathname is already released. */ }
}

export function createTuiPreferencesStore(options: { readonly configHome?: string } = {}): TuiPreferencesPort {
  const filePath = pathFor(options.configHome);
  const directory = dirname(filePath);
  const lockPath = `${filePath}.lock`;

  return {
    load(): Promise<TuiPreferencesLoad> {
      return Promise.resolve(loaded(parseFile(filePath)));
    },

    save(input: TuiPreferencesSaveInput): Promise<TuiPreferencesSaveResult> {
      return Promise.resolve().then((): TuiPreferencesSaveResult => {
      if (!Number.isSafeInteger(input?.expectedRevision) || input.expectedRevision < 0) return failure('invalid_request');
      if (input.patch?.kind !== 'icons' && input.patch?.kind !== 'statusline') return failure('invalid_request');
      if (input.patch.kind === 'icons' && input.patch.iconMode !== 'nerd' && input.patch.iconMode !== 'ascii') {
        return failure('invalid_request');
      }
      if (input.patch.kind === 'statusline' && !StatuslinePreferences.safeParse(input.patch.statusline).success) {
        return failure('invalid_request');
      }

      const beforeDirectory = parseFile(filePath);
      if (beforeDirectory.kind === 'invalid' || beforeDirectory.kind === 'unavailable') return failure('unavailable');
      try {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
      } catch {
        return failure('unavailable');
      }

      let lockFd: number;
      try {
        lockFd = openSync(lockPath, 'wx', 0o600);
      } catch (error) {
        return errno(error) === 'EEXIST' ? failure('lock_busy') : failure('unavailable');
      }

      try {
        const currentRead = parseFile(filePath);
        if (currentRead.kind === 'invalid' || currentRead.kind === 'unavailable') return failure('unavailable');
        const current = currentRead.kind === 'valid' ? currentRead.preferences : DEFAULT_TUI_PREFERENCES;
        if (current.revision !== input.expectedRevision) return { kind: 'conflict', preferences: current };
        if (current.revision === Number.MAX_SAFE_INTEGER) return failure('invalid_request');

        const candidate = TuiPreferences.parse({
          ...current,
          revision: current.revision + 1,
          ...(input.patch.kind === 'icons'
            ? { iconMode: input.patch.iconMode }
            : { statusline: input.patch.statusline }),
        });
        const payload = `${JSON.stringify(candidate, null, 2)}\n`;
        const temporary = `${filePath}.${randomUUID()}.tmp`;
        let renamed = false;
        try {
          writeFileSync(temporary, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
          const tempFd = openSync(temporary, 'r');
          try { fsyncSync(tempFd); } finally { closeSync(tempFd); }
          renameSync(temporary, filePath);
          renamed = true;
          const directoryFd = openSync(directory, 'r');
          try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
        } catch {
          if (!renamed) {
            try { unlinkSync(temporary); } catch { /* It may already be absent. */ }
          }
          const after = parseFile(filePath);
          if (after.kind === 'valid' && JSON.stringify(after.preferences) === JSON.stringify(candidate)) {
            return { kind: 'saved', preferences: after.preferences };
          }
          return failure('write_failed');
        }

        const readback = parseFile(filePath);
        if (readback.kind !== 'valid' || JSON.stringify(readback.preferences) !== JSON.stringify(candidate)) {
          return failure('write_failed');
        }
        return { kind: 'saved', preferences: readback.preferences };
      } catch {
        return failure('write_failed');
      } finally {
        releaseLock(lockPath, lockFd);
      }
      });
    },
  };
}
