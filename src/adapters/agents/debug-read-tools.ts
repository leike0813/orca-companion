/**
 * IP-03 / D-05：调试会话的有界只读工具实现（Owner: 本 change 的 debug read tools）。
 *
 * 这些工具只服务 `--debug` 的普通目录，不参与任何协调语义。职责只有一个：把一次模型请求
 * 变成一次**有界**的真实读取，并且在这个过程中不写任何东西。
 *
 * 四条边界在这里落地，workflow 层的工具定义不再重复：
 *
 * - **目录边界**：模型给的路径先归一化再 `realpath`；绝对路径、父路径与符号链接逃逸都在读取前拒绝，
 *   非普通文件不是文件读取的合法目标。
 * - **处理量与输出预算**：单文件 64 KiB，扫描条目数与命中数各自有上限，遍历不跟随符号链接，
 *   因此既不会走出根目录，也不会在环上停不下来。
 * - **时间预算**：每次调用一个 deadline 并链接调用方 signal；超时与取消都是结构化拒绝，不是未知结果。
 * - **不是任意 shell**：Git 走参数数组并关闭 external diff / textconv / pager，模型无法追加参数。
 *
 * 契约本身在 `src/application/ports/debug-read-tools.ts`：这里只实现它，不重新声明类型。
 */

import { realpathSync } from 'node:fs';
import { open, opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type {
  DebugReadFileMatch,
  DebugReadLimits,
  DebugReadRequest,
  DebugReadResult,
  DebugReadServices,
} from '../../application/ports/debug-read-tools.js';
import { DEFAULT_DEBUG_READ_LIMITS } from '../../application/ports/debug-read-tools.js';
import {
  DEFAULT_OUTPUT_LIMITS,
  processRunner,
  type ProcessRunner,
} from '../orca-cli/process-runner.js';

type Limits = DebugReadLimits;
type WalkVisit = (relative: string, isDirectory: boolean) => boolean | Promise<boolean>;

/** opendir 的内部读取缓冲；目录项按这个批次流出，目录再大也是常数内存。 */
const DIR_BUFFER_BYTES = 32;

const LIMIT_KEYS = ['maxReadBytes', 'maxEntries', 'maxMatches', 'maxScanBytes', 'outputMaxBytes', 'timeoutMs'] as const;

/**
 * 校验预算。
 *
 * 这些数字直接决定 `Buffer.alloc` 的大小和循环次数，所以 0、负数、NaN、Infinity 都不是「宽松的
 * 配置」而是一次无界分配。装配期拒绝比在调用期炸掉更早，也更容易定位。
 */
function resolveLimits(overrides: Partial<DebugReadLimits> | undefined): Limits {
  const limits: Limits = { ...DEFAULT_DEBUG_READ_LIMITS, ...overrides };
  for (const key of LIMIT_KEYS) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0) {
      throw new Error(`debug read 限制 ${key} 必须是正安全整数`);
    }
  }
  return limits;
}

function rejected<T>(code: string, message: string): DebugReadResult<T> {
  return { kind: 'rejected', code, message };
}

function accepted<T>(value: T): DebugReadResult<T> {
  return { kind: 'accepted', value };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 结果文本的字节上限；超出时显式标记截断，调用方不必猜结果是否完整。 */
function boundText(text: string, limits: Limits, note: string): { readonly text: string; readonly truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= limits.outputMaxBytes) {
    return { text, truncated: false };
  }
  // 截断标记本身也必须落在上限内：先给标记预留字节再切正文，否则「有界输出」名存实亡。
  const suffix = trimIncompleteTail(Buffer.from(note, 'utf8').subarray(0, limits.outputMaxBytes)).toString('utf8');
  const reserve = Buffer.byteLength(suffix, 'utf8');
  const cut = trimIncompleteTail(Buffer.from(text, 'utf8').subarray(0, limits.outputMaxBytes - reserve)).toString('utf8');
  return { text: `${cut}${suffix}`, truncated: true };
}

/**
 * 有界读取几乎必然落在多字节字符中间。丢掉结尾那段不完整序列，结果里就不会出现替换字符，
 * 模型看到的是一个真实被截断的文本，而不是看起来像编码故障的文本。
 */
function trimIncompleteTail(buffer: Buffer): Buffer {
  let index = buffer.length - 1;
  let continuations = 0;
  while (index >= 0 && continuations < 4 && (buffer[index]! & 0b1100_0000) === 0b1000_0000) {
    continuations += 1;
    index -= 1;
  }
  if (index < 0) {
    return buffer;
  }
  const lead = buffer[index]!;
  if (lead < 0x80) {
    return buffer;
  }
  const expected = lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
  return continuations + 1 === expected ? buffer : buffer.subarray(0, index);
}

/**
 * 每次调用的 deadline。它链接调用方 signal，并把超时与取消都折叠成结构化拒绝——只读工具没有
 * 副作用，超时不是「结果未知」，因此不需要对账。
 *
 * run 必须真的 await 完所有 I/O 的清理（目录句柄、文件句柄、子进程）之后才返回，
 * 否则「超时拒绝」会和仍在进行的读取并发，调用方拿到拒绝时磁盘还在被读。
 */
async function withDeadline<T>(
  request: DebugReadRequest | undefined,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<DebugReadResult<T>>,
): Promise<DebugReadResult<T>> {
  if (request?.signal?.aborted === true) {
    return rejected('cancelled', '调用在开始前已被取消');
  }
  const deadline = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    deadline.abort();
  }, timeoutMs);
  const signal = request?.signal === undefined ? deadline.signal : AbortSignal.any([request.signal, deadline.signal]);
  try {
    const result = await run(signal);
    // deadline 到点后即使 run 侥幸跑完，也不能把这次调用报告成一次成功读取：调用方已经
    // 等过了整个时间预算，拿到的是「预算用尽」，不是一个它没等过的结果。
    return timedOut ? rejected('timeout', `读取超过 ${timeoutMs}ms 预算`) : result;
  } catch (error) {
    if (timedOut) {
      return rejected('timeout', `读取超过 ${String(timeoutMs)}ms 预算`);
    }
    if (signal.aborted) {
      return rejected('cancelled', '调用已被取消');
    }
    return rejected('tool_failed', describe(error));
  } finally {
    clearTimeout(timer);
  }
}

type Resolution =
  | { readonly kind: 'resolved'; readonly absolute: string }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

/**
 * 把模型给的相对路径解析成根目录内的真实路径。
 *
 * 顺序是关键：先拒绝绝对路径，再 resolve，最后 `realpath`。只有真实路径落在根目录内才算合法，
 * 因此指向外部的符号链接在读取发生之前就被挡住，而不是读完之后才发现。
 */
async function resolveWithinRoot(
  root: string,
  candidate: string | undefined,
  want: 'file' | 'directory' | 'any',
): Promise<Resolution> {
  if (candidate !== undefined && (typeof candidate !== 'string' || candidate.trim().length === 0)) {
    return { kind: 'rejected', code: 'invalid_path', message: 'path 必须是非空字符串' };
  }
  const relative = candidate ?? '.';
  if (path.isAbsolute(relative)) {
    return { kind: 'rejected', code: 'path_outside_root', message: '只接受根目录内的相对路径' };
  }
  // 词法边界先判一次：明显越界的路径不论目标存不存在都算逃逸，而不是被 not_found 掩盖。
  const lexical = path.resolve(root, relative);
  if (lexical !== root && !lexical.startsWith(root + path.sep)) {
    return { kind: 'rejected', code: 'path_outside_root', message: `路径逃出根目录：${relative}` };
  }
  let absolute: string;
  try {
    absolute = await realpath(lexical);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT'
      ? { kind: 'rejected', code: 'not_found', message: `路径不存在：${relative}` }
      : { kind: 'rejected', code: 'not_found', message: `路径无法解析：${describe(error)}` };
  }
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    return { kind: 'rejected', code: 'path_outside_root', message: `路径逃出根目录：${relative}` };
  }
  const stats = await stat(absolute);
  if (want === 'file' && !stats.isFile()) {
    return { kind: 'rejected', code: 'not_a_regular_file', message: `不是普通文件：${relative}` };
  }
  if (want === 'directory' && !stats.isDirectory()) {
    return { kind: 'rejected', code: 'not_a_directory', message: `不是目录：${relative}` };
  }
  return { kind: 'resolved', absolute };
}

/**
 * 有界读取：最多读 `maxBytes + 1` 字节，多出来的那一个字节就是截断的证据。
 *
 * 打开前重新做一次边界证明。搜索的路径来自目录遍历而不是模型输入，遍历与打开之间存在窗口，
 * 期间一个普通文件可以被换成指向根目录外的符号链接；这里再 realpath 一次并确认仍是根目录内的
 * 普通文件，窗口就被关在读取之前。
 */
async function readAtMost(
  root: string,
  absolute: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ readonly buffer: Buffer; readonly truncated: boolean }> {
  const real = await realpath(absolute);
  if (real !== root && !real.startsWith(`${root}${path.sep}`)) {
    throw new Error(`路径在打开前逃出根目录：${absolute}`);
  }
  if (!(await stat(real)).isFile()) {
    throw new Error(`不是普通文件：${absolute}`);
  }
  const handle = await open(real, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) {
        break;
      }
      filled += bytesRead;
      if (signal.aborted) {
        throw new Error('read aborted');
      }
    }
    const truncated = filled > maxBytes;
    const kept = truncated ? buffer.subarray(0, maxBytes) : buffer.subarray(0, filled);
    return { buffer: trimIncompleteTail(kept), truncated };
  } finally {
    await handle.close();
  }
}

/**
 * 广度优先遍历。只读目录项本身、不跟随符号链接，因此不会走出根目录，也不会在环上停不下来。
 * `visit` 返回 false 表示预算用尽，遍历立刻停止。
 */
async function walk(
  root: string,
  start: string,
  limits: Limits,
  signal: AbortSignal,
  visit: WalkVisit,
): Promise<{ readonly scanned: number; readonly truncated: boolean }> {
  const queue: string[] = [start];
  let scanned = 0;
  let truncated = false;
  while (queue.length > 0 && !truncated) {
    if (signal.aborted) {
      throw new Error('walk aborted');
    }
    const current = queue.shift()!;
    // 用 opendir 的异步迭代而不是 readdir：后者会先把整个目录的条目数组读进内存，
    // 于是 maxEntries 这个扫描上限对内存根本不成立（百万级目录会先把它撑爆）。
    // opendir 每次只取一批目录项，达到预算就 break，内存与扫描量一起被限制。
    const handle = await opendir(current, { bufferSize: DIR_BUFFER_BYTES }).catch(() => null);
    if (handle === null) {
      // 不可读的子目录（权限、竞态删除）不该中断整次遍历。
      continue;
    }
    try {
      for await (const entry of handle) {
        if (signal.aborted) {
          throw new Error('walk aborted');
        }
        if (entry.isSymbolicLink()) {
          continue;
        }
        const isDirectory = entry.isDirectory();
        const child = path.join(current, entry.name);
        const relative = path.relative(root, child);
        scanned += 1;
        if (scanned > limits.maxEntries || !(await visit(relative, isDirectory))) {
          truncated = true;
          break;
        }
        if (isDirectory) {
          queue.push(child);
        }
      }
    } finally {
      // break 之后迭代器可能已经关闭了自己，重复 close 无害；但必须等它结束，
      // 否则方法返回后目录句柄还开着，遍历也还没真正停。
      await handle.close().catch(() => undefined);
    }
  }
  return { scanned: Math.min(scanned, limits.maxEntries), truncated };
}

/**
 * 有界只读工具的实现。
 *
 * `rootDirectory` 在构造时就 `realpath` 归一化，后续每次比较的都是同一份真实路径。根目录不存在时
 * 直接抛错：启动装配应该失败，而不是让每次调用各自重新判断读的是哪个地方。
 */
export function createDebugReadServices(input: {
  readonly rootDirectory: string;
  readonly limits?: Partial<DebugReadLimits>;
  readonly runProcess?: ProcessRunner;
}): DebugReadServices {
  const limits = resolveLimits(input.limits);
  const runProcess = input.runProcess ?? processRunner;
  const root = realpathSync(input.rootDirectory);
  const truncationNote = (what: string): string => `\n[已截断：${what}]`;

  return {
    listFiles: (request, call) =>
      withDeadline(call, limits.timeoutMs, async (signal) => {
        const resolved = await resolveWithinRoot(root, request.path, 'directory');
        if (resolved.kind === 'rejected') {
          return rejected(resolved.code, resolved.message);
        }
        const files: string[] = [];
        const result = await walk(root, resolved.absolute, limits, signal, (relative, isDirectory) => {
          files.push(isDirectory ? `${relative}/` : relative);
          return true;
        });
        files.sort();
        const bounded = boundText(files.join('\n'), limits, truncationNote('条目列表超过输出上限'));
        return accepted({
          files: bounded.text.split('\n').filter((line) => line.length > 0),
          truncated: result.truncated || bounded.truncated,
        });
      }),

    readFile: (request, call) =>
      withDeadline(call, limits.timeoutMs, async (signal) => {
        const resolved = await resolveWithinRoot(root, request.path, 'file');
        if (resolved.kind === 'rejected') {
          return rejected(resolved.code, resolved.message);
        }
        const read = await readAtMost(root, resolved.absolute, limits.maxReadBytes, signal);
        const content = read.buffer.toString('utf8');
        // 两种截断共用一次封顶：读满上限时的标记和结果超上限时的标记，都不能把结果推过 outputMaxBytes。
        const readNote = truncationNote(`只读取了前 ${String(limits.maxReadBytes)} 字节`);
        const bounded = boundText(read.truncated ? content + readNote : content, limits, truncationNote('文件内容超过输出上限'));
        return accepted({
          path: path.relative(root, resolved.absolute),
          content: bounded.text,
          truncated: read.truncated || bounded.truncated,
        });
      }),

    search: (request, call) =>
      withDeadline(call, limits.timeoutMs, async (signal) => {
        if (typeof request.pattern !== 'string' || request.pattern.length === 0) {
          return rejected('invalid_argument', 'pattern 必须是非空字符串');
        }
        const resolved = await resolveWithinRoot(root, request.path, 'directory');
        if (resolved.kind === 'rejected') {
          return rejected(resolved.code, resolved.message);
        }
        const matches: DebugReadFileMatch[] = [];
        let truncated = false;
        let outputBytes = 0;
        let scanBytes = 0;
        // 固定字符串匹配：模型无法构造一个正则，把这次调用变成灾难性回溯的面。
        const result = await walk(root, resolved.absolute, limits, signal, async (relative, isDirectory) => {
          if (isDirectory) {
            return true;
          }
          // 宽目录里「每个文件都读到上限」本身就是无界的：单次调用的总读取量单独计预算。
          const remaining = limits.maxScanBytes - scanBytes;
          if (remaining <= 0) {
            truncated = true;
            return false;
          }
          let read: { readonly buffer: Buffer; readonly truncated: boolean };
          try {
            read = await readAtMost(root, path.join(root, relative), Math.min(limits.maxReadBytes, remaining), signal);
          } catch (error) {
            // 遍历与打开之间被换成符号链接、或文件刚好被删除：跳过这一项并把结果标为不完整，
            // 不让一次竞态把整次搜索变成失败。
            if (signal.aborted) {
              throw error;
            }
            truncated = true;
            return true;
          }
          scanBytes += read.buffer.length + (read.truncated ? 1 : 0);
          truncated ||= read.truncated;
          for (const [index, line] of read.buffer.toString('utf8').split('\n').entries()) {
            if (!line.includes(request.pattern)) {
              continue;
            }
            // 命中数与命中文本都计入预算，否则一条超长行就能把结果撑到无界。
            const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
            if (matches.length >= limits.maxMatches || outputBytes + lineBytes > limits.outputMaxBytes) {
              truncated = true;
              return false;
            }
            outputBytes += lineBytes;
            matches.push({ path: relative, line: index + 1, text: line });
          }
          return true;
        });
        return accepted({
          matches,
          scanned: result.scanned,
          truncated: result.truncated || truncated,
        });
      }),

    gitDiff: (request, call) =>
      withDeadline(call, limits.timeoutMs, async (signal) => {
        const args = ['--no-pager', '--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-color'];
        if (request.staged === true) {
          args.push('--cached');
        }
        // 总是显式给一条 pathspec。`git -C <子目录> diff --cached` 在没有 pathspec 时是相对仓库根
        // 计算的，会把调试根目录之外的 staged 改动一起返回（工作树 diff 受 cwd 限制，staged diff
        // 不受），所以「不写路径就是整个仓库」不是可接受的结果。`.` 永远等于配置的调试根目录。
        let pathspec = '.';
        if (request.path !== undefined) {
          const resolved = await resolveWithinRoot(root, request.path, 'any');
          if (resolved.kind === 'rejected') {
            return rejected(resolved.code, resolved.message);
          }
          pathspec = path.relative(root, resolved.absolute) || '.';
        }
        // --literal-pathspecs：模型给的路径是字面文件名，`*`、`[` 之类不是通配符也不是 magic 前缀。
        args.push('--', pathspec);
        const result = await runProcess({
          executable: 'git',
          args,
          cwd: root,
          env: { ...process.env, GIT_PAGER: 'cat' },
          timeoutMs: limits.timeoutMs,
          limits: { ...DEFAULT_OUTPUT_LIMITS, maxBytes: limits.outputMaxBytes },
          signal,
        });
        if (result.kind === 'unavailable') {
          return rejected('git_unavailable', result.message);
        }
        if (result.kind === 'unknown') {
          return rejected(result.reason, `git diff ${result.reason === 'timeout' ? '超时' : '被取消'}`);
        }
        if (result.exitCode !== 0) {
          const stderr = result.stderr.text.trim();
          return rejected(
            /not a git repository|no such file or directory/i.test(stderr)
              ? 'not_a_repository'
              : 'git_failed',
            stderr.length > 0 ? stderr : `git diff 退出码 ${String(result.exitCode)}`,
          );
        }
        // runner 已按 outputMaxBytes 截过 stdout；追加标记后要再封一次顶，结果才仍在预算内。
        const bounded = boundText(result.stdout.text, limits, truncationNote('diff 超过输出上限'));
        return accepted({ diff: bounded.text, truncated: result.stdout.truncated || bounded.truncated });
      }),
  };
}
