/**
 * IP-3 / D5：受限进程执行边界，收在 `src/adapters/orca-cli/` 内。
 *
 * 只返回退出码、标准输出、标准错误与截断标记，不解析 Orca 语义：
 * 调用以可执行文件加参数数组表达（绝不经 shell），显式提供工作目录与环境，
 * 分离 stdout 与 stderr，有界限制输出规模并显式标记截断，带有限超时与取消且不隐式重试。
 * 超时或取消一律报告结果未知，不当作确定失败。
 */

import { spawn } from 'node:child_process';

export type OutputLimits = {
  readonly maxBytes: number;
  readonly maxLines: number;
};

export const DEFAULT_OUTPUT_LIMITS: OutputLimits = {
  maxBytes: 1024 * 1024,
  maxLines: 20_000,
};

/** 结束后强制回收子进程的宽限期。 */
const KILL_GRACE_MS = 2_000;

const NEWLINE = 0x0a;

export type ProcessRequest = {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly limits?: OutputLimits;
  readonly signal?: AbortSignal;
  /**
   * 诊断行过滤器。命中的行按噪声丢弃，既不计入失败，也不计入 stderr 的输出上限与截断判定
   * （例如 `orca orchestration check --wait` 每 15 秒写到 stderr 的保活行）。
   */
  readonly dropStderrLine?: (line: string) => boolean;
};

export type ProcessStream = {
  readonly text: string;
  readonly truncated: boolean;
};

export type ProcessResult =
  | {
      readonly kind: 'completed';
      readonly exitCode: number;
      readonly stdout: ProcessStream;
      readonly stderr: ProcessStream;
    }
  | { readonly kind: 'unavailable'; readonly code: 'process_spawn_failed'; readonly message: string }
  | {
      readonly kind: 'unknown';
      readonly reason: 'timeout' | 'cancelled';
      readonly stdout: ProcessStream;
      readonly stderr: ProcessStream;
    };

export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;

type LineSink = {
  push(chunk: Buffer): void;
  finish(): ProcessStream;
};

/**
 * 按行累积输出：整个 chunk 要么保留，要么因超限被丢弃，因此保留的文本永远是合法 UTF-8，
 * 也永远不会无界缓冲。`dropLine` 在计数之前生效，被丢弃的行不占用配额。
 */
function createLineSink(limits: OutputLimits, dropLine?: (line: string) => boolean): LineSink {
  let pending: Buffer = Buffer.alloc(0);
  const kept: Buffer[] = [];
  let keptBytes = 0;
  let keptLines = 0;
  let truncated = false;

  const keep = (line: Buffer): void => {
    if (truncated) {
      return;
    }
    if (keptBytes + line.length > limits.maxBytes || keptLines + 1 > limits.maxLines) {
      truncated = true;
      return;
    }
    kept.push(line);
    keptBytes += line.length;
    keptLines += 1;
  };

  const consume = (line: Buffer): void => {
    if (dropLine !== undefined && dropLine(line.toString('utf8'))) {
      return;
    }
    keep(line);
  };

  const drain = (final: boolean): void => {
    let index = pending.indexOf(NEWLINE);
    while (index >= 0) {
      consume(pending.subarray(0, index + 1));
      pending = pending.subarray(index + 1);
      index = pending.indexOf(NEWLINE);
    }
    if (final && pending.length > 0) {
      consume(pending);
      pending = Buffer.alloc(0);
    }
    if (pending.length > limits.maxBytes) {
      // 没有换行的超长行不得无界滞留。
      truncated = true;
      pending = Buffer.alloc(0);
    }
  };

  return {
    push(chunk: Buffer): void {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      drain(false);
    },
    finish(): ProcessStream {
      drain(true);
      return { text: Buffer.concat(kept).toString('utf8'), truncated };
    },
  };
}

export async function runProcess(request: ProcessRequest): Promise<ProcessResult> {
  const limits = request.limits ?? DEFAULT_OUTPUT_LIMITS;
  const stdoutSink = createLineSink(limits);
  const stderrSink = createLineSink(limits, request.dropStderrLine);

  return await new Promise<ProcessResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const child = spawn(request.executable, [...request.args], {
      cwd: request.cwd,
      env: { ...request.env },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const terminate = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, KILL_GRACE_MS);
    };

    const onAbort = (): void => {
      cancelled = true;
      terminate();
    };

    const cleanup = (): void => {
      clearTimeout(timeoutTimer);
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }
      request.signal?.removeEventListener('abort', onAbort);
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, request.timeoutMs);

    if (request.signal !== undefined) {
      if (request.signal.aborted) {
        onAbort();
      } else {
        request.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutSink.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrSink.push(chunk);
    });

    child.on('error', (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve({ kind: 'unavailable', code: 'process_spawn_failed', message: error.message });
    });

    child.on('close', (code: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      const stdout = stdoutSink.finish();
      const stderr = stderrSink.finish();
      if (cancelled || timedOut) {
        resolve({ kind: 'unknown', reason: cancelled ? 'cancelled' : 'timeout', stdout, stderr });
        return;
      }
      resolve({ kind: 'completed', exitCode: code ?? -1, stdout, stderr });
    });
  });
}

export const processRunner: ProcessRunner = runProcess;
