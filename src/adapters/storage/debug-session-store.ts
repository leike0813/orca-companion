/**
 * IP-04 / D-04：调试会话注册表、用户级状态路径与会话单写者锁。
 *
 * 注册表是「哪个真实目录下有哪些调试会话、各自固定了哪份模型配置」的唯一事实源，落在用户状态
 * 目录（XDG state）而不是项目里：调试目录可能根本不是 Git 仓库，也可能同时被多个项目使用。
 * 记录只保存不可变配置快照与凭据引用，密钥只在装配时从唯一 CredentialStore 解析。
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';

import { coordinatorModelConfigurationSchema } from '../../application/coordinator/model-config-switch.js';

export const DEBUG_REGISTRY_FILENAME = 'sessions.json';
export const DEBUG_SESSIONS_DIRECTORY = 'sessions';
export const DEBUG_SCHEMA_VERSION = 1;
export const MAX_DEBUG_SESSIONS = 200;
export const MAX_DEBUG_REGISTRY_BYTES = 8 * 1024 * 1024;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export type DebugSessionRecord = {
  readonly coordinatorSessionId: string;
  /** 真实目录 realpath 的命名空间身份；同一路径的不同写法落到同一个命名空间。 */
  readonly debugDirectoryId: string;
  readonly directoryPath: string;
  readonly configuration: z.infer<typeof coordinatorModelConfigurationSchema>;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type DebugRegistryResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

export type DebugSessionStore = {
  readonly list: (debugDirectoryId: string) => DebugRegistryResult<readonly DebugSessionRecord[]>;
  readonly read: (
    debugDirectoryId: string,
    coordinatorSessionId: string,
  ) => DebugRegistryResult<DebugSessionRecord | null>;
  /** 追加一条新会话；已有会话的配置快照不改写。 */
  readonly register: (input: {
    readonly debugDirectoryId: string;
    readonly directoryPath: string;
    readonly configuration: z.infer<typeof coordinatorModelConfigurationSchema>;
  }) => DebugRegistryResult<DebugSessionRecord>;
  /** 记录一次会话活动时间，不触碰配置快照。 */
  readonly touch: (coordinatorSessionId: string, updatedAt: number) => DebugRegistryResult<DebugSessionRecord>;
};

const recordSchema = z.strictObject({
  coordinatorSessionId: z.string().min(1).max(256),
  debugDirectoryId: z.string().min(1).max(256),
  directoryPath: z.string().min(1).max(4096),
  configuration: coordinatorModelConfigurationSchema,
  createdAt: z.number().int().nonnegative().safe(),
  updatedAt: z.number().int().nonnegative().safe(),
});
const registrySchema = z.strictObject({
  schemaVersion: z.literal(DEBUG_SCHEMA_VERSION),
  revision: z.number().int().nonnegative().safe(),
  sessions: z.array(recordSchema).max(MAX_DEBUG_SESSIONS),
});

/** 用户级调试状态目录：`$XDG_STATE_HOME/orca-companion/debug`，缺省落在 `~/.local/state`。 */
export function debugStateDirectory(
  options: { environment?: Readonly<Record<string, string | undefined>>; homeDirectory?: string } = {},
): string {
  const environment = options.environment ?? process.env;
  const xdg = environment['XDG_STATE_HOME'];
  return join(
    typeof xdg === 'string' && isAbsolute(xdg) ? xdg : join(options.homeDirectory ?? homedir(), '.local', 'state'),
    'orca-companion',
    'debug',
  );
}

/** 目录命名空间身份：realpath 的稳定摘要。路径不进身份，因此同一目录的不同写法（含符号链接）归一。 */
export function debugDirectoryId(directoryPath: string): string {
  return createHash('sha256').update(directoryPath, 'utf8').digest('hex').slice(0, 32);
}

/** 归一化调试根目录：realpath 之后的绝对路径，符号链接因此不再是两个目录。 */
export function resolveDebugDirectory(directory: string): DebugRegistryResult<string> {
  try {
    const resolved = realpathSync(directory);
    return lstatSync(resolved).isDirectory()
      ? { kind: 'ok', value: resolved }
      : { kind: 'rejected', code: 'directory_unavailable', message: `调试目录不是一个目录：${directory}` };
  } catch (error) {
    return {
      kind: 'rejected',
      code: 'directory_unavailable',
      message: `调试目录不可用：${(error as NodeJS.ErrnoException).code ?? 'unknown'}`,
    };
  }
}

/** 单个调试会话在用户状态目录里的位置：checkpoint、UI 输入与诊断各自独立文件。 */
export function debugSessionDirectory(stateDirectory: string, coordinatorSessionId: string): string {
  return join(stateDirectory, DEBUG_SESSIONS_DIRECTORY, coordinatorSessionId);
}

export type DebugSessionPaths = {
  readonly directory: string;
  readonly checkpoints: string;
  readonly input: string;
  readonly diagnostics: string;
  readonly writerLock: string;
};

export function debugSessionPaths(stateDirectory: string, coordinatorSessionId: string): DebugSessionPaths {
  const directory = debugSessionDirectory(stateDirectory, coordinatorSessionId);
  return {
    directory,
    checkpoints: join(directory, 'checkpoints.sqlite'),
    input: join(directory, 'ui.sqlite'),
    diagnostics: join(directory, 'diagnostics'),
    writerLock: join(directory, 'writer.lock'),
  };
}

function readRegistryFile(path: string): DebugRegistryResult<z.infer<typeof registrySchema> | null> {
  let raw: Buffer;
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return { kind: 'rejected', code: 'registry_unreadable', message: '调试会话注册表不是普通文件' };
    }
    if ((stat.mode & 0o077) !== 0) {
      return { kind: 'rejected', code: 'registry_unreadable', message: '调试会话注册表权限不安全' };
    }
    if (stat.size > MAX_DEBUG_REGISTRY_BYTES) {
      return { kind: 'rejected', code: 'registry_unreadable', message: '调试会话注册表超出允许大小' };
    }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      raw = Buffer.allocUnsafe(stat.size);
      let offset = 0;
      while (offset < raw.length) {
        const count = readSync(fd, raw, offset, raw.length - offset, offset);
        if (count === 0) break;
        offset += count;
      }
      raw = raw.subarray(0, offset);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT'
      ? { kind: 'ok', value: null }
      : { kind: 'rejected', code: 'registry_unreadable', message: `调试会话注册表不可读：${code ?? 'unknown'}` };
  }
  try {
    const parsed = registrySchema.safeParse(JSON.parse(raw.toString('utf8')) as unknown);
    return parsed.success
      ? { kind: 'ok', value: parsed.data }
      : { kind: 'rejected', code: 'registry_unreadable', message: '调试会话注册表结构无效；原文件已保留' };
  } catch {
    return { kind: 'rejected', code: 'registry_unreadable', message: '调试会话注册表不是合法 JSON；原文件已保留' };
  }
}

/**
 * 注册表 store：整份文件读写、单写者、原子替换。
 *
 * 会话数量有界且远小于 Provider 库，整份读写换来的是「不存在部分写入的半条会话」这一简单性质。
 */
export class FileDebugSessionStore implements DebugSessionStore {
  private readonly path: string;
  private readonly directory: string;
  private readonly clock: () => number;
  private readonly newId: () => string;

  constructor(options: {
    readonly stateDirectory: string;
    readonly clock?: () => number;
    readonly newId?: () => string;
  }) {
    this.directory = options.stateDirectory;
    this.path = join(options.stateDirectory, DEBUG_REGISTRY_FILENAME);
    this.clock = options.clock ?? Date.now;
    this.newId = options.newId ?? randomUUID;
  }

  private current(): DebugRegistryResult<z.infer<typeof registrySchema>> {
    const read = readRegistryFile(this.path);
    if (read.kind === 'rejected') return read;
    return {
      kind: 'ok',
      value: read.value ?? { schemaVersion: DEBUG_SCHEMA_VERSION, revision: 0, sessions: [] },
    };
  }

  /**
   * 独占写入：锁覆盖读、改、写三步。
   *
   * 只在写之前取锁是不够的——两个进程会各自基于同一份旧内容算出新值并丢掉对方的记录。
   * 锁被占用即拒绝，不排队重试：丢一条会话记录比让用户多按一次键更难发现。
   */
  private commit<T>(
    apply: (current: z.infer<typeof registrySchema>) => DebugRegistryResult<{
      readonly value: T;
      readonly sessions: readonly z.infer<typeof recordSchema>[];
    }>,
  ): DebugRegistryResult<T> {
    let lockFd: number;
    try {
      mkdirSync(this.directory, { recursive: true, mode: DIRECTORY_MODE });
      lockFd = openSync(`${this.path}.lock`, 'wx', FILE_MODE);
    } catch (error) {
      return {
        kind: 'rejected',
        code: (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'registry_busy' : 'registry_unreadable',
        message: `调试会话注册表写入失败：${(error as NodeJS.ErrnoException).code ?? 'unknown'}`,
      };
    }
    try {
      const current = this.current();
      if (current.kind === 'rejected') return current;
      const applied = apply(current.value);
      if (applied.kind === 'rejected') return applied;
      // `apply` 的入参在运行时不保证可信（record 由调用方组装），写盘前按落盘形状再校验一次：
      // 写出去的字节必须正好是 schema 描述的注册表。
      const validated = registrySchema.safeParse({
        schemaVersion: DEBUG_SCHEMA_VERSION,
        revision: current.value.revision + 1,
        sessions: applied.value.sessions,
      });
      if (!validated.success || new Set(applied.value.sessions.map(record => record.coordinatorSessionId)).size !== applied.value.sessions.length) {
        return { kind: 'rejected', code: 'registry_unreadable', message: '调试会话注册表结构无效；原文件已保留' };
      }
      const payload = `${JSON.stringify(validated.data)}\n`;
      if (Buffer.byteLength(payload, 'utf8') > MAX_DEBUG_REGISTRY_BYTES) {
        return { kind: 'rejected', code: 'registry_unreadable', message: '调试会话注册表超出允许大小' };
      }
      const temporary = `${this.path}.${this.newId()}.tmp`;
      try {
        writeFileSync(temporary, payload, { encoding: 'utf8', mode: FILE_MODE, flag: 'wx' });
        const fd = openSync(temporary, 'r');
        try {
          // 先落盘再改名：崩溃只会留下孤儿临时文件，不会留下半份注册表。
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(temporary, this.path);
        return { kind: 'ok', value: applied.value.value };
      } catch (error) {
        try {
          unlinkSync(temporary);
        } catch {
          /* best-effort temporary-file cleanup */
        }
        return {
          kind: 'rejected',
          code: 'registry_unreadable',
          message: `调试会话注册表写入失败：${(error as NodeJS.ErrnoException).code ?? 'unknown'}`,
        };
      }
    } finally {
      try {
        unlinkSync(`${this.path}.lock`);
      } catch {
        /* 锁可能已被移除 */
      }
      try {
        closeSync(lockFd);
      } catch {
        /* 写入结果已经确定 */
      }
    }
  }

  list(directoryId: string): DebugRegistryResult<readonly DebugSessionRecord[]> {
    const current = this.current();
    if (current.kind === 'rejected') return current;
    return {
      kind: 'ok',
      value: current.value.sessions
        .filter((record) => record.debugDirectoryId === directoryId)
        .slice()
        .sort((left, right) => left.createdAt - right.createdAt),
    };
  }

  read(directoryId: string, coordinatorSessionId: string): DebugRegistryResult<DebugSessionRecord | null> {
    const current = this.current();
    if (current.kind === 'rejected') return current;
    const found =
      current.value.sessions.find(
        (record) => record.debugDirectoryId === directoryId && record.coordinatorSessionId === coordinatorSessionId,
      ) ?? null;
    return { kind: 'ok', value: found };
  }

  register(input: {
    readonly debugDirectoryId: string;
    readonly directoryPath: string;
    readonly configuration: z.infer<typeof coordinatorModelConfigurationSchema>;
  }): DebugRegistryResult<DebugSessionRecord> {
    return this.commit((current) => {
      const now = this.clock();
      const record: DebugSessionRecord = {
        coordinatorSessionId: this.newId(),
        debugDirectoryId: input.debugDirectoryId,
        directoryPath: input.directoryPath,
        configuration: input.configuration,
        createdAt: now,
        updatedAt: now,
      };
      // 会话身份是注册表的键：重复身份会让 read/touch 指向前一条记录。
      if (current.sessions.some((existing) => existing.coordinatorSessionId === record.coordinatorSessionId)) {
        return {
          kind: 'rejected',
          code: 'session_duplicate',
          message: `调试会话 ${record.coordinatorSessionId} 已注册`,
        };
      }
      return { kind: 'ok', value: { value: record, sessions: [...current.sessions, record] } };
    });
  }

  touch(coordinatorSessionId: string, updatedAt: number): DebugRegistryResult<DebugSessionRecord> {
    return this.commit((current) => {
      const index = current.sessions.findIndex((record) => record.coordinatorSessionId === coordinatorSessionId);
      if (index < 0) {
        return { kind: 'rejected', code: 'session_unknown', message: `调试会话 ${coordinatorSessionId} 未注册` };
      }
      const record = { ...current.sessions[index]!, updatedAt };
      const sessions = current.sessions.slice();
      sessions[index] = record;
      return { kind: 'ok', value: { value: record, sessions } };
    });
  }
}

export type DebugWriterLock =
  | { readonly kind: 'acquired'; readonly release: () => void }
  /** 存活或身份不可信的写者持有：立即拒绝，不等待，也不破锁。 */
  | { readonly kind: 'held'; readonly holderPid: number | null };

const holderPidSchema = z.strictObject({ pid: z.number().int().positive() });
/** 本模块自己写出的锁文件只有 `{"pid":<n>}`；更长的文件说明它已被篡改，不值得读进内存。 */
const MAX_HOLDER_BYTES = 64;

type HolderState =
  /** 锁文件不存在。 */
  | { readonly kind: 'free' }
  /** 锁文件存在但持有者身份不可信：不可破锁，按持有处理。 */
  | { readonly kind: 'unknown' }
  | { readonly kind: 'dead'; readonly pid: number }
  | { readonly kind: 'live'; readonly pid: number };

/** 只有 ESRCH 证明进程已退出；EPERM 与任何其他错误都 fail closed 当作存活。 */
function provablyDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function readHolderState(path: string): HolderState {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_HOLDER_BYTES) return { kind: 'unknown' };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'free' } : { kind: 'unknown' };
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { kind: 'unknown' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    // 刚被 `wx` 创建、pid 还没写进去的锁文件也走这里：宁可拒绝，也不删掉别人的锁。
    return { kind: 'unknown' };
  }
  const holder = holderPidSchema.safeParse(parsed);
  if (!holder.success) return { kind: 'unknown' };
  return provablyDead(holder.data.pid)
    ? { kind: 'dead', pid: holder.data.pid }
    : { kind: 'live', pid: holder.data.pid };
}

function fileIdentity(stat: Stats): string {
  return `${stat.dev}:${stat.ino}`;
}

/** 以 `wx` 建立锁并写入持有者 pid；已被占用即报告 held，不等待也不重试。 */
function createWriterLock(lockPath: string, pid: number): DebugWriterLock {
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx', FILE_MODE);
  } catch {
    return { kind: 'held', holderPid: null };
  }
  let identity: string;
  try {
    writeSync(fd, JSON.stringify({ pid }));
    identity = fileIdentity(fstatSync(fd));
  } catch {
    try {
      closeSync(fd);
      unlinkSync(lockPath);
    } catch {
      /* best-effort cleanup of a lock we just created */
    }
    return { kind: 'held', holderPid: null };
  }
  try {
    closeSync(fd);
  } catch {
    /* 锁事实已经确定 */
  }
  return {
    kind: 'acquired',
    release: () => {
      try {
        // 只释放本进程建立的那一份：残留锁被回收之后，迟到的 release 不能删掉新写者的锁。
        if (fileIdentity(lstatSync(lockPath)) !== identity) return;
        unlinkSync(lockPath);
      } catch {
        /* 锁可能已被移除；释放失败不改变本进程已经交出写者的事实 */
      }
    },
  };
}

/**
 * 取走回收用的短锁，把「判定残留持有者已退出并删除它」串行化。
 *
 * 回收锁占用时拒绝；嵌套破锁会重新引入回收者相互删除新锁的竞态。
 */
function takeRecoveryLock(recoveryPath: string, pid: number): number | null {
    let fd: number;
    try {
      fd = openSync(recoveryPath, 'wx', FILE_MODE);
    } catch {
      return null;
    }
    try {
      writeSync(fd, JSON.stringify({ pid }));
    } catch {
      try {
        closeSync(fd);
        unlinkSync(recoveryPath);
      } catch {
        /* best-effort cleanup of a lock we just created */
      }
      return null;
    }
    return fd;
}

/**
 * 取得一个调试会话的单写者锁。
 *
 * 锁文件记录持有者 pid：只有 ESRCH 证明已经退出的 pid 才回收（崩溃后不必手工清理），存活 pid 与
 * 身份不可信的文件立即以 `held` 拒绝。回收在独立的短锁内串行完成，否则两个回收者会各自删掉对方
 * 刚建立的存活锁。等待与重试都不做——同一会话出现第二个写者意味着用户在两处同时操作它，那必须由
 * 人决定，而不是由超时决定。
 */
export function acquireDebugWriterLock(options: { readonly lockPath: string; readonly pid?: number }): DebugWriterLock {
  const pid = options.pid ?? process.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) return { kind: 'held', holderPid: null };
  try {
    mkdirSync(dirname(options.lockPath), { recursive: true, mode: DIRECTORY_MODE });
  } catch {
    return { kind: 'held', holderPid: null };
  }
  const state = readHolderState(options.lockPath);
  if (state.kind === 'live') return { kind: 'held', holderPid: state.pid };
  if (state.kind === 'unknown') return { kind: 'held', holderPid: null };
  if (state.kind === 'free') return createWriterLock(options.lockPath, pid);
  const recoveryPath = `${options.lockPath}.recovery`;
  const recoveryFd = takeRecoveryLock(recoveryPath, pid);
  if (recoveryFd === null) return { kind: 'held', holderPid: state.pid };
  try {
    // 拿到回收锁之后重验：等待这把锁的期间，残留锁可能已经被另一个写者取走。
    const current = readHolderState(options.lockPath);
    if (current.kind === 'live') return { kind: 'held', holderPid: current.pid };
    if (current.kind === 'unknown') return { kind: 'held', holderPid: null };
    if (current.kind === 'dead') {
      try {
        unlinkSync(options.lockPath);
      } catch {
        return { kind: 'held', holderPid: current.pid };
      }
    }
  } finally {
    try {
      closeSync(recoveryFd);
    } catch {
      /* 回收锁已经用完 */
    }
    try {
      unlinkSync(recoveryPath);
    } catch {
      /* 回收锁可能已被移除 */
    }
  }
  return createWriterLock(options.lockPath, pid);
}
