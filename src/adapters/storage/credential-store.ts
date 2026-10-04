/**
 * D02 的用户级明文凭据文件（Owner: `complete-tui-model-configuration` IP-02）。
 *
 * 单文件保存全部凭据：XDG 目录下的 `orca-companion/credentials.json`。写入用短 exclusive 锁 +
 * 锁内 revision CAS + 临时文件 `0600` 原子替换 + 回读，因此崩溃、并发写者或响应丢失都不会留下
 * 半份或被静默覆盖的 store。锁忙只拒绝，不猜测也不自动破锁。
 *
 * 权限是这里的硬约束：store 目录与文件都由本模块创建为 `0700`/`0600`，既有的宽松目录、宽松
 * 文件、符号链接与非普通文件一律拒绝，既不改权限也不猜测内容。用户目录（`~/.config` 本身）
 * 由用户继承，本模块既不校验也不 chmod。
 *
 * 所有失败都是结构化 code 加固定安全文案：不转发原始异常、路径或任何 secret 片段。
 */

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { z } from 'zod';

import type { Stats } from 'node:fs';

import type {
  CredentialFailure,
  CredentialMetadataResult,
  CredentialReadResult,
  CredentialSaveInput,
  CredentialSaveResult,
  CredentialStore,
} from '../../application/ports/credential-store.js';

export const CREDENTIAL_STORE_SCHEMA_VERSION = 1;

export const CREDENTIAL_STORE_DIRECTORY = 'orca-companion';

export const CREDENTIAL_STORE_FILENAME = 'credentials.json';

/** 单文件硬上限：读回与写回都以它为界，超过即拒绝而不是截断。 */
export const MAX_CREDENTIAL_STORE_BYTES = 1024 * 1024;

export const MAX_CREDENTIAL_ENTRIES = 256;

export const MAX_CREDENTIAL_SECRET_BYTES = 16 * 1024;

const OWNER_ONLY_FILE_MODE = 0o600;
const OWNER_ONLY_DIRECTORY_MODE = 0o700;
const GROUP_AND_OTHER_BITS = 0o077;
const LOCK_SUFFIX = '.lock';

export type CredentialStoreOptions = {
  /** 显式文件位置；缺省按 XDG 规则推导。 */
  readonly path?: string;
  /** 缺省读 `process.env`；测试与隔离 launcher 注入自己的视图。 */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** `XDG_CONFIG_HOME` 缺省时的家目录；缺省为当前用户家目录。 */
  readonly homeDirectory?: string;
};

type CredentialFailureCode =
  | 'invalid_request'
  | 'credential_missing'
  | 'permission_denied'
  | 'store_invalid'
  | 'store_too_large'
  | 'lock_busy'
  | 'revision_conflict'
  | 'limit_exceeded'
  | 'write_failed';

const FAILURE_MESSAGES = {
  invalid_request: '凭据请求参数不合法',
  credential_missing: '凭据不存在',
  permission_denied: '凭据存储权限不安全',
  store_invalid: '凭据存储内容无法解析',
  store_too_large: '凭据存储超出允许大小',
  lock_busy: '凭据存储正在被其他写者持有',
  revision_conflict: '凭据存储已被其他写者更新',
  limit_exceeded: '凭据数量或体积超出上限',
  write_failed: '凭据存储写入失败',
} satisfies Record<CredentialFailureCode, string>;

function reject(code: CredentialFailureCode): CredentialFailure {
  return { kind: 'rejected', code, message: FAILURE_MESSAGES[code] };
}

const entrySchema = z.strictObject({ credentialRef: z.uuid(), secret: z.string() });

const storeSchema = z.strictObject({
  schemaVersion: z.literal(CREDENTIAL_STORE_SCHEMA_VERSION),
  revision: z.number().int().nonnegative(),
  entries: z.array(entrySchema).max(MAX_CREDENTIAL_ENTRIES),
});

type CredentialEntry = z.infer<typeof entrySchema>;

type StoreState = {
  readonly revision: number;
  readonly entries: readonly CredentialEntry[];
};

type StateRead = { readonly ok: true; readonly state: StoreState } | { readonly ok: false; readonly failure: CredentialFailure };

const EMPTY_STATE: StoreState = { revision: 0, entries: [] };

/** 路径选择：`XDG_CONFIG_HOME` 优先，缺省或非绝对值时退回 `<home>/.config`。 */
export function credentialStorePath(options: CredentialStoreOptions = {}): string {
  if (options.path !== undefined) return resolve(options.path);
  const environment = options.environment ?? process.env;
  const configured = environment['XDG_CONFIG_HOME'];
  if (typeof configured === 'string' && configured.length > 0 && isAbsolute(configured)) {
    return join(configured, CREDENTIAL_STORE_DIRECTORY, CREDENTIAL_STORE_FILENAME);
  }
  const home = options.homeDirectory ?? homedir();
  return join(home, '.config', CREDENTIAL_STORE_DIRECTORY, CREDENTIAL_STORE_FILENAME);
}

function errnoOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export class JsonCredentialStore implements CredentialStore {
  private readonly filePath: string;

  private readonly directoryPath: string;

  private readonly lockPath: string;

  constructor(options: CredentialStoreOptions = {}) {
    this.filePath = credentialStorePath(options);
    this.directoryPath = dirname(this.filePath);
    this.lockPath = `${this.filePath}${LOCK_SUFFIX}`;
  }

  metadata(): CredentialMetadataResult {
    const read = this.readState();
    if (!read.ok) return read.failure;
    return { kind: 'metadata', revision: read.state.revision, refs: read.state.entries.map((entry) => entry.credentialRef) };
  }

  read(credentialRef: string): CredentialReadResult {
    if (typeof credentialRef !== 'string' || credentialRef.length === 0) return reject('invalid_request');
    const read = this.readState();
    if (!read.ok) return read.failure;
    const entry = read.state.entries.find((candidate) => candidate.credentialRef === credentialRef);
    if (entry === undefined) return reject('credential_missing');
    return { kind: 'resolved', secret: entry.secret };
  }

  save(input: CredentialSaveInput): CredentialSaveResult {
    if (typeof input !== 'object' || input === null) return reject('invalid_request');
    if (!isRevision(input.expectedRevision)) return reject('invalid_request');
    if (typeof input.secret !== 'string' || input.secret.length === 0) return reject('invalid_request');
    if (Buffer.byteLength(input.secret, 'utf8') > MAX_CREDENTIAL_SECRET_BYTES) return reject('invalid_request');

    const directory = this.ensureDirectory();
    if (!directory.ok) return directory.failure;

    const lock = this.acquireLock();
    if (!lock.ok) return lock.failure;
    try {
      // 锁内重读：CAS 只认真正持有锁这一段读到的 revision。
      const read = this.readState();
      if (!read.ok) return read.failure;
      if (read.state.revision !== input.expectedRevision) return reject('revision_conflict');
      if (read.state.entries.length >= MAX_CREDENTIAL_ENTRIES) return reject('limit_exceeded');

      const credentialRef = randomUUID();
      const revision = read.state.revision + 1;
      const payload = serialize({ revision, entries: [...read.state.entries, { credentialRef, secret: input.secret }] });
      if (payload === null) return reject('limit_exceeded');

      const written = this.replaceFile(payload);
      if (!written.ok) return written.failure;

      const readback = this.readState();
      if (!readback.ok) return reject('write_failed');
      const stored = readback.state.entries.find((entry) => entry.credentialRef === credentialRef);
      if (readback.state.revision !== revision || stored === undefined || stored.secret !== input.secret) {
        return reject('write_failed');
      }
      return { kind: 'saved', revision, credentialRef };
    } finally {
      this.releaseLock(lock.fd);
    }
  }

  /** 创建缺失的 store 目录；既有目录只校验，不 chmod（含用户继承目录）。 */
  private ensureDirectory(): { readonly ok: true } | { readonly ok: false; readonly failure: CredentialFailure } {
    try {
      mkdirSync(this.directoryPath, { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE });
    } catch {
      return { ok: false, failure: reject('permission_denied') };
    }
    const failure = checkDirectory(this.directoryPath);
    return failure === null ? { ok: true } : { ok: false, failure };
  }

  private acquireLock(): { readonly ok: true; readonly fd: number } | { readonly ok: false; readonly failure: CredentialFailure } {
    try {
      return { ok: true, fd: openSync(this.lockPath, 'wx', OWNER_ONLY_FILE_MODE) };
    } catch (error) {
      return { ok: false, failure: errnoOf(error) === 'EEXIST' ? reject('lock_busy') : reject('write_failed') };
    }
  }

  private releaseLock(fd: number): void {
    try {
      unlinkSync(this.lockPath);
    } catch {
      // 锁已经不在：没有其他可做的清理，也不能因此把成功写成失败。
    }
    try {
      closeSync(fd);
    } catch {
      // 同上，锁文件已释放即可，fd 关闭失败不改变已经确定的结果。
    }
  }

  /** 临时文件 → fsync → rename → 目录 fsync：任一步失败都不留下半份 store。 */
  private replaceFile(payload: string): { readonly ok: true } | { readonly ok: false; readonly failure: CredentialFailure } {
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, payload, { encoding: 'utf8', mode: OWNER_ONLY_FILE_MODE, flag: 'wx' });
      const fd = openSync(temporaryPath, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporaryPath, this.filePath);
    } catch {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // 临时文件可能已不存在；原始失败已经返回。
      }
      return { ok: false, failure: reject('write_failed') };
    }
    try {
      const directoryFd = openSync(this.directoryPath, 'r');
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    } catch {
      return { ok: false, failure: reject('write_failed') };
    }
    return { ok: true };
  }

  private readState(): StateRead {
    const directoryFailure = checkDirectory(this.directoryPath, { allowMissing: true });
    if (directoryFailure !== null) return { ok: false, failure: directoryFailure };
    const payload = readBoundedFile(this.filePath);
    if (!payload.ok) return { ok: false, failure: payload.failure };
    if (payload.text === null) return { ok: true, state: EMPTY_STATE };
    return parseState(payload.text);
  }
}

function checkDirectory(path: string, options: { readonly allowMissing?: boolean } = {}): CredentialFailure | null {
  let stats: Stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') {
      return options.allowMissing === true ? null : reject('permission_denied');
    }
    return reject('permission_denied');
  }
  // 符号链接无法保证不被重定向到别处；宽松目录同样先拒绝再决定，绝不 chmod 既有目录。
  if (stats.isSymbolicLink() || !stats.isDirectory()) return reject('store_invalid');
  if ((stats.mode & GROUP_AND_OTHER_BITS) !== 0) return reject('permission_denied');
  return null;
}

/** 读回一个不超过上限的普通文件；`text: null` 表示文件尚不存在。 */
function readBoundedFile(path: string): { readonly ok: true; readonly text: string | null } | { readonly ok: false; readonly failure: CredentialFailure } {
  let stats: Stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return { ok: true, text: null };
    return { ok: false, failure: reject('permission_denied') };
  }
  if (stats.isSymbolicLink() || !stats.isFile()) return { ok: false, failure: reject('store_invalid') };
  if ((stats.mode & GROUP_AND_OTHER_BITS) !== 0) return { ok: false, failure: reject('permission_denied') };
  if (stats.size > MAX_CREDENTIAL_STORE_BYTES) return { ok: false, failure: reject('store_too_large') };
  const buffer = Buffer.allocUnsafe(stats.size);
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return { ok: false, failure: reject('permission_denied') };
  }
  try {
    let filled = 0;
    while (filled < stats.size) {
      const read = readSync(fd, buffer, filled, stats.size - filled, filled);
      if (read === 0) break;
      filled += read;
    }
    // stat 之后仍在增长：按超限处理，不读取无法界定上限的部分。
    if (readSync(fd, Buffer.alloc(1), 0, 1, stats.size) > 0) return { ok: false, failure: reject('store_too_large') };
    return { ok: true, text: buffer.subarray(0, filled).toString('utf8') };
  } catch {
    return { ok: false, failure: reject('permission_denied') };
  } finally {
    closeSync(fd);
  }
}

function parseState(payload: string): StateRead {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return { ok: false, failure: reject('store_invalid') };
  }
  const parsed = storeSchema.safeParse(value);
  if (!parsed.success) return { ok: false, failure: reject('store_invalid') };
  const refs = new Set<string>();
  for (const entry of parsed.data.entries) {
    if (refs.has(entry.credentialRef)) return { ok: false, failure: reject('store_invalid') };
    if (Buffer.byteLength(entry.secret, 'utf8') > MAX_CREDENTIAL_SECRET_BYTES) {
      return { ok: false, failure: reject('store_invalid') };
    }
    refs.add(entry.credentialRef);
  }
  return { ok: true, state: { revision: parsed.data.revision, entries: parsed.data.entries } };
}

function serialize(state: StoreState): string | null {
  const payload = JSON.stringify({ schemaVersion: CREDENTIAL_STORE_SCHEMA_VERSION, ...state });
  return Buffer.byteLength(payload, 'utf8') > MAX_CREDENTIAL_STORE_BYTES ? null : payload;
}
