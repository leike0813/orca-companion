/**
 * IP-08：Route Map 初始化的未决创建记录（Owner: simplify-ledger-lab-lifecycle IP-08）。
 *
 * 记录落在 Git common dir 的 Companion 私有目录里、按**完整 branch ref** 一个文件：同一仓库的不同
 * 分支各自拥有自己的创建身份，因此换分支初始化不会继承或覆盖另一条分支的未决创建。
 *
 * 纪律与既有 store 一致：短 exclusive 锁、锁内重读 CAS、临时文件 + fsync + rename 原子替换、写后回读
 * 核验。锁忙只拒绝，不排队也不破锁；并发写者按冲突拒绝，绝不覆盖别人的未决标记——那会让一次结果
 * 不明的远端创建失去唯一的对账依据。
 *
 * 目录权限不由本模块收紧：Companion 私有目录由同一个 Git common dir 下的其它 store 建立，本模块只在
 * 缺失时创建，自己的文件用 0600。
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
import { join } from 'node:path';

import { z } from 'zod';

import type {
  RouteMapInitializationRecord,
  RouteMapInitializationRecordStore,
  RouteMapInitializationResult,
  RouteMapTarget,
} from '../../application/planning/route-map-initialization.js';
import {
  isRouteMapRepository,
  ROUTE_MAP_REPOSITORY_PATTERN,
} from '../../application/planning/route-map-initialization.js';

export const ROUTE_MAP_INITIALIZATION_RECORD_SCHEMA_VERSION = 1;

/** 与 bootstrap 的 COMPANION_STATE_DIRECTORY 同名；适配层按字面量镜像，避免反向依赖装配层。 */
const COMPANION_STATE_DIRECTORY = 'orca-companion';

const RECORD_SUBDIRECTORY = 'route-map-initialization';

const OWNER_ONLY_FILE_MODE = 0o600;
const OWNER_ONLY_DIRECTORY_MODE = 0o700;
const LOCK_SUFFIX = '.lock';

/** 单个记录只是一个小 JSON：超出即视为损坏，不做部分读取。 */
const MAX_RECORD_BYTES = 64 * 1024;

export type RouteMapInitializationRecordStoreOptions = {
  readonly gitCommonDir: string;
  /** 形如 owner/repo 的可信目标仓库；不是合法形态即拒绝安装 store。 */
  readonly repository: string;
  /** 完整 branch ref，例如 refs/heads/main；同一仓库内按它隔离记录。 */
  readonly fullBranchRef: string;
};

const targetSchema = z.strictObject({
  number: z.number().int().positive(),
  url: z.string().min(1),
});

const recordSchema = z.strictObject({
  schemaVersion: z.literal(ROUTE_MAP_INITIALIZATION_RECORD_SCHEMA_VERSION),
  revision: z.number().int().nonnegative(),
  operationId: z.uuid(),
  repository: z.string().regex(ROUTE_MAP_REPOSITORY_PATTERN),
  fullBranchRef: z.string().min(1),
  title: z.string().min(1),
  issue: targetSchema.nullable(),
});

type StoredRecord = z.infer<typeof recordSchema>;

type FileReadResult =
  | { readonly kind: 'ok'; readonly text: string | null }
  | { readonly kind: 'failed'; readonly message: string };

type WriteOutcome = RouteMapInitializationResult<RouteMapInitializationRecord>;

/**
 * 记录路径：分支 ref 用 percent-encoding，文件名因此可逆且不会因为斜杠或空格落到目录外。
 *
 * 导出供 bootstrap 与测试核对位置；写入前必须先校验 ref 形态。
 */
export function routeMapInitializationRecordPath(
  gitCommonDir: string,
  fullBranchRef: string,
): string {
  if (typeof fullBranchRef !== 'string' || fullBranchRef.trim().length === 0) {
    throw new Error('fullBranchRef 不能为空');
  }
  return join(
    gitCommonDir,
    COMPANION_STATE_DIRECTORY,
    RECORD_SUBDIRECTORY,
    encodeURIComponent(fullBranchRef) + '.json',
  );
}

function ok<T>(value: T): RouteMapInitializationResult<T> {
  return { kind: 'ok', value };
}

function failed<T>(code: 'record_conflict' | 'record_unavailable', message: string): RouteMapInitializationResult<T> {
  return { kind: 'failed', code, message };
}

function errnoOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

export class FileRouteMapInitializationRecordStore implements RouteMapInitializationRecordStore {
  private readonly filePath: string;

  private readonly directoryPath: string;

  private readonly lockPath: string;

  private readonly repository: string;

  private readonly fullBranchRef: string;

  constructor(options: RouteMapInitializationRecordStoreOptions) {
    if (!isRouteMapRepository(options.repository)) {
      throw new Error('repository 必须是 owner/repo 形态');
    }
    this.repository = options.repository;
    this.fullBranchRef = options.fullBranchRef;
    this.filePath = routeMapInitializationRecordPath(options.gitCommonDir, options.fullBranchRef);
    this.directoryPath = join(options.gitCommonDir, COMPANION_STATE_DIRECTORY, RECORD_SUBDIRECTORY);
    this.lockPath = this.filePath + LOCK_SUFFIX;
  }

  read(): RouteMapInitializationResult<RouteMapInitializationRecord | null> {
    const payload = this.readFile();
    if (payload.kind !== 'ok') {
      return failed('record_unavailable', payload.message);
    }
    if (payload.text === null) {
      return ok(null);
    }
    return this.parse(payload.text);
  }

  begin(input: {
    readonly repository: string;
    readonly fullBranchRef: string;
    readonly title: string;
  }): RouteMapInitializationResult<RouteMapInitializationRecord> {
    if (input.repository !== this.repository || input.fullBranchRef !== this.fullBranchRef) {
      return failed('record_conflict', '初始化记录目标与当前存储身份不一致');
    }
    const record: StoredRecord = {
      schemaVersion: ROUTE_MAP_INITIALIZATION_RECORD_SCHEMA_VERSION,
      revision: 1,
      operationId: randomUUID(),
      repository: input.repository,
      fullBranchRef: input.fullBranchRef,
      title: input.title,
      issue: null,
    };
    return this.write((current) => {
      // 已有记录（含未决标记）一律按冲突拒绝：并发或重启后的第二次创建必须走对账，不能改写身份。
      if (current.kind === 'failed') return failed('record_unavailable', current.message);
      if (current.text !== null) {
        return failed('record_conflict', '同一分支已存在 Route Map 初始化记录');
      }
      return this.replace(record, 1);
    });
  }

  recordIssue(input: {
    readonly operationId: string;
    readonly expectedRevision: number;
    readonly issue: RouteMapTarget;
  }): RouteMapInitializationResult<RouteMapInitializationRecord> {
    return this.write((current) => {
      const existing = this.requireRecord(current, input.operationId, input.expectedRevision);
      if (existing.kind !== 'ok') {
        return existing;
      }
      const next = existing.value.issue === null ? input.issue : existing.value.issue;
      return this.replace({ ...existing.value, schemaVersion: ROUTE_MAP_INITIALIZATION_RECORD_SCHEMA_VERSION, issue: next }, input.expectedRevision + 1);
    });
  }

  /**
   * 锁内的唯一写入路径：重读 → 变更 → 原子替换 → 回读核验。
   *
   * 回读失败一律按写不成功处理：调用方会保留远端事实并请用户对账，不会因为本机没写成就重发创建。
   */
  private write(
    mutate: (current: FileReadResult) => WriteOutcome,
  ): RouteMapInitializationResult<RouteMapInitializationRecord> {
    const directory = this.ensureDirectory();
    if (directory.kind !== 'ok') {
      return directory;
    }
    let lockFd: number;
    try {
      lockFd = openSync(this.lockPath, 'wx', OWNER_ONLY_FILE_MODE);
    } catch (error) {
      return errnoOf(error) === 'EEXIST'
        ? failed('record_conflict', 'Route Map 初始化记录正在被其他写者持有')
        : failed('record_unavailable', '无法创建 Route Map 初始化记录锁');
    }
    try {
      const current = this.readFile();
      if (current.kind !== 'ok') {
        return failed('record_unavailable', current.message);
      }
      const mutated = mutate(current);
      if (mutated.kind === 'failed') {
        return mutated;
      }
      const readback = this.read();
      if (readback.kind !== 'ok' || readback.value === null) {
        return failed('record_unavailable', '写入后无法读回 Route Map 初始化记录');
      }
      if (readback.value.revision !== mutated.value.revision || readback.value.operationId !== mutated.value.operationId) {
        return failed('record_unavailable', '读回的 Route Map 初始化记录与写入不一致');
      }
      return ok(readback.value);
    } finally {
      this.releaseLock(lockFd);
    }
  }

  /** 用运行期 schema 校验读回内容；任何形状漂移都按不可用处理，不做尽力解析。 */
  private parse(text: string): RouteMapInitializationResult<RouteMapInitializationRecord> {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return failed('record_unavailable', 'Route Map 初始化记录不是合法 JSON');
    }
    const parsed = recordSchema.safeParse(raw);
    if (!parsed.success) {
      return failed('record_unavailable', 'Route Map 初始化记录不符合运行期 schema');
    }
    if (parsed.data.repository !== this.repository || parsed.data.fullBranchRef !== this.fullBranchRef) {
      return failed('record_unavailable', 'Route Map 初始化记录身份与存储位置不一致');
    }
    return ok(parsed.data);
  }

  /** CAS 只认「当前操作身份 + 当前 revision」，两者任一不符即拒绝。 */
  private requireRecord(
    current: FileReadResult,
    operationId: string,
    expectedRevision: number,
  ): RouteMapInitializationResult<RouteMapInitializationRecord> {
    if (current.kind === 'failed') {
      return failed('record_unavailable', current.message);
    }
    if (current.text === null) {
      return failed('record_conflict', 'Route Map 初始化记录不存在');
    }
    const parsed = this.parse(current.text);
    if (parsed.kind !== 'ok') {
      return parsed;
    }
    if (parsed.value.operationId !== operationId || parsed.value.revision !== expectedRevision) {
      return failed('record_conflict', 'Route Map 初始化记录已被其他写者更新');
    }
    return parsed;
  }

  private replace(record: StoredRecord, revision: number): RouteMapInitializationResult<RouteMapInitializationRecord> {
    const payload = JSON.stringify({ ...record, revision }, null, 2) + '\n';
    if (Buffer.byteLength(payload, 'utf8') > MAX_RECORD_BYTES) {
      return failed('record_unavailable', 'Route Map 初始化记录超出大小上限');
    }
    const temporaryPath = this.filePath + '.' + randomUUID() + '.tmp';
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
      return failed('record_unavailable', '无法写入 Route Map 初始化记录');
    }
    try {
      const directoryFd = openSync(this.directoryPath, 'r');
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    } catch {
      return failed('record_unavailable', '无法落盘 Route Map 初始化记录');
    }
    return ok({ ...record, revision });
  }

  private ensureDirectory(): RouteMapInitializationResult<null> {
    try {
      mkdirSync(this.directoryPath, { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE });
    } catch {
      return failed('record_unavailable', '无法创建 Route Map 初始化记录目录');
    }
    let stats;
    try {
      stats = lstatSync(this.directoryPath);
    } catch {
      return failed('record_unavailable', '无法读取 Route Map 初始化记录目录');
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return failed('record_unavailable', 'Route Map 初始化记录路径不是目录');
    }
    return ok(null);
  }

  /** 读回不超过上限的普通文件；text 为 null 表示尚无记录。 */
  private readFile(): FileReadResult {
    let stats;
    try {
      stats = lstatSync(this.filePath);
    } catch (error) {
      return errnoOf(error) === 'ENOENT' ? { kind: 'ok', text: null } : { kind: 'failed', message: '无法读取 Route Map 初始化记录' };
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      return { kind: 'failed', message: 'Route Map 初始化记录不是普通文件' };
    }
    if (stats.size > MAX_RECORD_BYTES) {
      return { kind: 'failed', message: 'Route Map 初始化记录超出大小上限' };
    }
    let fd: number;
    try {
      fd = openSync(this.filePath, 'r');
    } catch {
      return { kind: 'failed', message: '无法打开 Route Map 初始化记录' };
    }
    try {
      const buffer = Buffer.allocUnsafe(stats.size);
      let filled = 0;
      while (filled < stats.size) {
        const read = readSync(fd, buffer, filled, stats.size - filled, filled);
        if (read === 0) {
          break;
        }
        filled += read;
      }
      // lstat 之后仍在增长：无法界定上限的部分不读取。
      if (readSync(fd, Buffer.alloc(1), 0, 1, stats.size) > 0) {
        return { kind: 'failed', message: 'Route Map 初始化记录超出大小上限' };
      }
      return { kind: 'ok', text: buffer.subarray(0, filled).toString('utf8') };
    } catch {
      return { kind: 'failed', message: '无法读取 Route Map 初始化记录' };
    } finally {
      closeSync(fd);
    }
  }

  private releaseLock(fd: number): void {
    try {
      unlinkSync(this.lockPath);
    } catch {
      // 锁已不在：没有其它可清理的，也不因此把成功改写成失败。
    }
    try {
      closeSync(fd);
    } catch {
      // 同上，锁文件已释放即可。
    }
  }
}

export function createRouteMapInitializationRecordStore(
  options: RouteMapInitializationRecordStoreOptions,
): RouteMapInitializationRecordStore {
  return new FileRouteMapInitializationRecordStore(options);
}
