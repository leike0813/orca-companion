/**
 * IC-04：项目配置的 Node 文件实现（Owner: `complete-tui-model-configuration` IP-02 / D02）。
 *
 * 项目配置是用户仓库里**纳入版本控制**的文件，所以这里与 CredentialStore 有两点刻意不同：不做权限
 * 收紧（文件模式沿用用户既有文件，缺省 `0644`），也不创建目录（canonical worktree 必须已经存在）。
 * 除此之外的纪律完全一致——短锁、锁内重读 CAS、临时文件 + fsync + rename 原子替换、写完回读核验。
 *
 * store 是 `revision` 的唯一推进者：调用方只能提交 `expectedRevision` 与「revision 恰好 +1」的
 * 候选配置，锁内不接受任何其它推进。锁用 exclusive 创建且**不自动破锁**：进程崩溃留下的锁必须由用户
 * 确认后删除，否则宁可拒绝保存，也不覆盖别人已经写下的配置。
 */

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import { parseProjectConfig, type ProjectConfig } from '../../application/configuration/project-config.js';
import { semanticEqual } from '../../domain/model-configuration.js';
import type {
  ProjectConfigurationFailure,
  ProjectConfigurationFailureCode,
  ProjectConfigurationReadResult,
  ProjectConfigurationSaveInput,
  ProjectConfigurationSaveResult,
  ProjectConfigurationStore,
} from '../../application/ports/project-configuration-store.js';

const LOCK_SUFFIX = '.lock';

/** 单文件上限：配置是有限的小型文档，超出即按无效处理，避免无界读取。 */
export const MAX_PROJECT_CONFIG_BYTES = 1024 * 1024;

const DEFAULT_FILE_MODE = 0o644;

export type ProjectConfigurationStoreOptions = {
  /** 配置文件路径；生产用 `projectConfigPath(canonicalWorktree)`。 */
  readonly configPath: string;
};

function reject(code: ProjectConfigurationFailureCode, message: string): ProjectConfigurationFailure {
  return { kind: 'failed', code, message };
}

function errnoOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

/**
 * 序列化候选配置。
 *
 * 循环引用、超出范围的数值这类无法序列化的候选也是一次**明确的拒绝**：端口约定方法只返回结果
 * 联合而不抛异常，序列化异常不能因此漏给调用方。
 */
function serializeCandidate(next: unknown): string | null {
  try {
    const payload = JSON.stringify(next);
    return typeof payload === 'string' && Buffer.byteLength(payload, 'utf8') <= MAX_PROJECT_CONFIG_BYTES
      ? payload
      : null;
  } catch {
    return null;
  }
}

/**
 * 已存在的记录是否在候选里原样保留。
 *
 * 「编辑只追加」是引用不可变的前提：同一个 `connectionRef` 一旦被改写，已批准的授权和在途 Task
 * 按引用读回的就是另一份配置。这里逐条按引用身份比对内容，角色当前选择这类**指针**可以前移，
 * 记录本身不行。
 */
function preservesHistory(current: ProjectConfig, candidate: ProjectConfig): boolean {
  const preserved = <T>(
    before: readonly T[],
    after: readonly T[],
    identity: (entry: T) => string,
  ): boolean =>
    before.every((entry) => {
      const kept = after.find((candidateEntry) => identity(candidateEntry) === identity(entry));
      return kept !== undefined && semanticEqual(kept, entry);
    });
  return (
    preserved(current.providerConnections, candidate.providerConnections, (entry) => entry.connectionRef) &&
    preserved(current.models, candidate.models, (entry) => entry.modelRef) &&
    preserved(current.coordinatorModels, candidate.coordinatorModels, (entry) => entry.configurationRef) &&
    preserved(current.execution.workerProfiles, candidate.execution.workerProfiles, (entry) => entry.profileRef)
  );
}

export class FileProjectConfigurationStore implements ProjectConfigurationStore {
  private readonly filePath: string;

  private readonly directoryPath: string;

  private readonly lockPath: string;

  constructor(options: ProjectConfigurationStoreOptions) {
    this.filePath = options.configPath;
    this.directoryPath = dirname(options.configPath);
    this.lockPath = `${options.configPath}${LOCK_SUFFIX}`;
  }

  read(): ProjectConfigurationReadResult {
    const raw = this.readFile();
    if (raw.kind === 'failed') {
      return raw;
    }
    if (raw.text === null) {
      return { kind: 'absent' };
    }
    return this.parse(raw.text);
  }

  save(input: ProjectConfigurationSaveInput): ProjectConfigurationSaveResult {
    // 1. 候选先在锁外校验：语义错误不该占用锁，更不该先动文件。
    const payload = serializeCandidate(input.next);
    if (payload === null) {
      return reject('invalid', '候选配置无法序列化或超出大小上限');
    }
    const candidate = this.parse(payload);
    if (candidate.kind === 'failed') {
      return candidate;
    }
    if (candidate.config.revision !== input.expectedRevision + 1) {
      return reject('invalid', `候选 revision 必须等于 ${String(input.expectedRevision + 1)}`);
    }
    const prettyPayload = `${JSON.stringify(candidate.config, null, 2)}\n`;
    if (Buffer.byteLength(prettyPayload, 'utf8') > MAX_PROJECT_CONFIG_BYTES) {
      return reject('invalid', '项目配置超出大小上限');
    }

    // 2. 短锁：忙就拒绝，不排队也不破锁。
    let lockFd: number;
    try {
      lockFd = openSync(this.lockPath, 'wx', DEFAULT_FILE_MODE);
    } catch (error) {
      return errnoOf(error) === 'EEXIST'
        ? reject('lock_busy', '项目配置存在锁文件；确认没有正在进行的保存后，可删除该文件再重试')
        : reject('write_failed', '无法创建项目配置锁');
    }
    try {
      // 3. 锁内重读才是 CAS 依据；既有文件无法解析时拒绝覆盖，而不是替用户重写。
      const current = this.read();
      if (current.kind === 'failed') {
        return current;
      }
      const currentRevision = current.kind === 'absent' ? 0 : current.config.revision;
      if (currentRevision !== input.expectedRevision) {
        return reject('conflict', `项目配置已被其他编辑修改（当前 revision ${String(currentRevision)}）`);
      }
      // CAS 通过之后才比对历史：revision 相同不代表记录没被改写，同引用改写必须在这里挡住。
      if (current.kind === 'read' && !preservesHistory(current.config, candidate.config)) {
        return reject('invalid', '项目配置只能追加新记录，既有引用不可改写或删除');
      }

      const written = this.replaceFile(prettyPayload);
      if (!written.ok) {
        return written.failure;
      }

      // 4. 回读核验：写进去的必须就是刚校验过的那份。
      const readback = this.read();
      if (readback.kind !== 'read') {
        return reject('verify_failed', '写入后无法读回项目配置');
      }
      if (
        readback.config.revision !== candidate.config.revision ||
        !semanticEqual(readback.config, candidate.config)
      ) {
        return reject('verify_failed', '读回的项目配置与候选不一致');
      }
      return { kind: 'saved', revision: readback.config.revision, config: readback.config };
    } finally {
      this.releaseLock(lockFd);
    }
  }

  private parse(text: string):
    | { readonly kind: 'read'; readonly config: ProjectConfig }
    | ProjectConfigurationFailure {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return reject('invalid', '项目配置不是合法 JSON');
    }
    const parsed = parseProjectConfig(raw);
    if (!parsed.ok) {
      return reject('invalid', `${parsed.field}: ${parsed.message}`);
    }
    return { kind: 'read', config: parsed.value };
  }

  /** 读回不超过上限的普通文件；符号链接与目录都不是有效配置。 */
  private readFile():
    | { readonly kind: 'ok'; readonly text: string | null }
    | ProjectConfigurationFailure {
    let stats;
    try {
      stats = lstatSync(this.filePath);
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') {
        return { kind: 'ok', text: null };
      }
      return reject('unreadable', '无法读取项目配置');
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      return reject('unreadable', '项目配置不是普通文件');
    }
    if (stats.size > MAX_PROJECT_CONFIG_BYTES) {
      return reject('invalid', '项目配置超出大小上限');
    }
    let fd: number;
    try {
      fd = openSync(this.filePath, 'r');
    } catch {
      return reject('unreadable', '无法读取项目配置');
    }
    try {
      const buffer = Buffer.allocUnsafe(stats.size);
      let filled = 0;
      while (filled < stats.size) {
        const read = readSync(fd, buffer, filled, stats.size - filled, filled);
        if (read === 0) break;
        filled += read;
      }
      // lstat 后文件仍在增长：拒绝，不读取无法界定上限的部分。
      if (readSync(fd, Buffer.alloc(1), 0, 1, stats.size) > 0) {
        return reject('invalid', '项目配置超出大小上限');
      }
      return { kind: 'ok', text: buffer.subarray(0, filled).toString('utf8') };
    } catch {
      return reject('unreadable', '无法读取项目配置');
    } finally {
      closeSync(fd);
    }
  }

  /** 临时文件 → fsync → rename → 目录 fsync：任一步失败都不留下半份配置。 */
  private replaceFile(payload: string): { readonly ok: true } | { readonly ok: false; readonly failure: ProjectConfigurationFailure } {
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, payload, { encoding: 'utf8', mode: this.fileMode(), flag: 'wx' });
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
      return { ok: false, failure: reject('write_failed', '无法写入项目配置') };
    }
    try {
      const directoryFd = openSync(this.directoryPath, 'r');
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    } catch {
      return { ok: false, failure: reject('write_failed', '无法落盘项目配置') };
    }
    return { ok: true };
  }

  /** 沿用用户既有文件的权限；新文件用 `0644`，让配置照常纳入版本控制。 */
  private fileMode(): number {
    try {
      return statSync(this.filePath).mode & 0o777;
    } catch {
      return DEFAULT_FILE_MODE;
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
}
