/**
 * IP-01 / D1：本机只读 Codex Worker 能力的真实探针。
 *
 * 只回答一个问题：用与实际 Capsule Utility Worker / 只读 Finalizer **同一份**权限 profile，当前的
 * `codex` 能不能运行受限命令，并且该命令读得到指定输入、写不动它。Codex 版本号、profile 文件、
 * `bwrap` 可执行文件、会话能启动，都不是这条能力的证明。
 *
 * 四项独立证据缺一不可：宿主证明哨兵可写 → 沙箱读出同一内容 → 沙箱写入被拒 → 宿主回读内容未变。
 * 拒写证据必须来自实际文件写入的权限错误；命令退出非零或文件未变本身不证明拒写。
 *
 * 探针不调用模型、不创建 Orca Task、不读项目文件、不修改任何 Scope；它只在项目树之外的临时目录里
 * 写一个哨兵文件，并按 `available | unavailable | unknown` 归类，附带失败阶段与有限诊断。
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { runProcess, type ProcessRunner } from '../orca-cli/process-runner.js';
import {
  CODEX_UTILITY_PERMISSION_PROFILE,
  CODEX_UTILITY_PROFILE_ARGS,
  CODEX_UTILITY_PROFILE_CONFIG_FILE,
  CODEX_UTILITY_PROFILE_CONFIG_TOML,
  assertUtilityProfileConfigCompatible,
} from './codex-launch.js';

/** 探针失败阶段：调用方据此区分「Codex 都没有」与「有 Codex 但受限命令跑不起来」。 */
export type ReadOnlyWorkerProbeStage =
  | 'codex-version'
  | 'host-sentinel'
  | 'sandbox-read'
  | 'sandbox-write'
  | 'host-verify';

export type ReadOnlyWorkerProbeResult = {
  readonly kind: 'available' | 'unavailable' | 'unknown';
  /** 得出结论所在的阶段；`available` 时是最后一项证据 `host-verify`。 */
  readonly stage: ReadOnlyWorkerProbeStage;
  /** Codex 自报版本；读不到时是 `null`，此时结论只能是 `unknown`。 */
  readonly codexVersion: string | null;
  /** 本次实际使用的权限 profile 名；与生产启动同源。 */
  readonly profile: string;
  /** 有限诊断：不含凭据、完整 transcript 或任意子进程输出。 */
  readonly diagnostics: readonly string[];
};

/**
 * 单个探针阶段的超时。受限命令要么很快失败（沙箱构建错误），要么很快返回；60 秒只用于兜住挂死。
 */
export const READ_ONLY_WORKER_PROBE_TIMEOUT_MS = 60_000;

const DIAGNOSTIC_LIMIT = 400;

export type ReadOnlyWorkerProbeInput = {
  /** 探针子进程的环境；`CODEX_HOME` 由探针自己覆盖为隔离临时目录。 */
  readonly env?: Readonly<Record<string, string>>;
  readonly executable?: string;
  readonly runner?: ProcessRunner;
  readonly timeoutMs?: number;
  /** 隔离临时目录的父目录；调用方省略时用系统临时目录（不在项目树内）。 */
  readonly tempParent?: string;
  /**
   * 生产启动读取的来源 Codex HOME；探针据此复现同一份来源配置冲突规则。
   *
   * 省略时与 `createCodexWorkerLaunch` 同源解析（`CODEX_HOME` → `~/.codex`）。
   */
  readonly sourceCodexHome?: string;
};

type ProbeVerdict =
  | {
      readonly kind: 'available';
      readonly stage: 'host-verify';
      readonly codexVersion: string;
      readonly diagnostics: readonly string[];
    }
  | {
      readonly kind: 'unavailable' | 'unknown';
      readonly stage: ReadOnlyWorkerProbeStage;
      readonly codexVersion: string | null;
      readonly diagnostics: readonly string[];
    };

/** 诊断行必须短且有界：子进程输出可能整段回显命令与路径。 */
function bounded(text: string): string {
  const single = text.replaceAll(/\s+/gu, ' ').trim();
  return single.length <= DIAGNOSTIC_LIMIT ? single : `${single.slice(0, DIAGNOSTIC_LIMIT)}…`;
}

/**
 * 诊断行：跳过 Codex 自身的 WARNING 噪声（例如临时 CODEX_HOME 下无法建立 PATH alias），
 * 取第一行真正的原因；全是噪声时退回第一行。
 */
function firstLine(text: string): string {
  const lines = text
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const meaningful = lines.find((entry) => !/^warning\b/iu.test(entry));
  return bounded(meaningful ?? lines[0] ?? '');
}

function describeFailure(stage: string, exitCode: number, stderr: string): string {
  const detail = firstLine(stderr);
  return detail.length === 0 ? `${stage} 失败（退出码 ${String(exitCode)}）` : `${stage} 失败（退出码 ${String(exitCode)}）：${detail}`;
}

function parseCodexVersion(stdout: string): string | null {
  const match = /(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)/u.exec(stdout);
  return match?.[1] ?? null;
}

/** `codex sandbox` 的固定调用形状：显式 profile 分层 + 显式 permission profile + 显式工作目录。 */
function sandboxArgs(directory: string, command: readonly string[]): readonly string[] {
  return ['sandbox', ...CODEX_UTILITY_PROFILE_ARGS, '--permission-profile', CODEX_UTILITY_PERMISSION_PROFILE, '--cd', directory, '--', ...command];
}

async function probeOnce(input: {
  readonly run: ProcessRunner;
  readonly executable: string;
  readonly timeoutMs: number;
  readonly env: Readonly<Record<string, string>>;
  readonly directory: string;
  readonly sentinelPath: string;
  /** 哨兵文件里的正文（含换行）；与最后回读逐字节比较。 */
  readonly sentinelContent: string;
}): Promise<ProbeVerdict> {
  const diagnostics: string[] = [];
  const codexHome = join(input.directory, 'codex-home');
  const sandboxEnv = { ...input.env, CODEX_HOME: codexHome };

  const version = await input.run({
    executable: input.executable,
    args: ['--version'],
    cwd: input.directory,
    env: sandboxEnv,
    timeoutMs: input.timeoutMs,
    limits: { maxBytes: 64 * 1024, maxLines: 200 },
  });
  if (version.kind === 'unavailable') {
    return { kind: 'unknown', stage: 'codex-version', codexVersion: null, diagnostics: [...diagnostics, bounded(version.message)] };
  }
  if (version.kind === 'unknown') {
    return { kind: 'unknown', stage: 'codex-version', codexVersion: null, diagnostics: [...diagnostics, `codex --version ${version.reason}`] };
  }
  const codexVersion = parseCodexVersion(version.stdout.text);
  if (version.exitCode !== 0 || codexVersion === null) {
    return {
      kind: 'unknown',
      stage: 'codex-version',
      codexVersion,
      diagnostics: [...diagnostics, describeFailure('codex --version', version.exitCode, version.stderr.text)],
    };
  }

  const read = await input.run({
    executable: input.executable,
    args: sandboxArgs(input.directory, ['/bin/cat', input.sentinelPath]),
    cwd: input.directory,
    env: sandboxEnv,
    timeoutMs: input.timeoutMs,
    limits: { maxBytes: 64 * 1024, maxLines: 200 },
  });
  if (read.kind === 'unavailable') {
    return { kind: 'unknown', stage: 'sandbox-read', codexVersion, diagnostics: [...diagnostics, bounded(read.message)] };
  }
  if (read.kind === 'unknown') {
    return { kind: 'unknown', stage: 'sandbox-read', codexVersion, diagnostics: [...diagnostics, `沙箱读取 ${read.reason}`] };
  }
  if (read.exitCode !== 0 || read.stdout.truncated) {
    return {
      kind: 'unavailable',
      stage: 'sandbox-read',
      codexVersion,
      diagnostics: [...diagnostics, describeFailure('沙箱读取受限命令', read.exitCode, read.stderr.text)],
    };
  }
  if (read.stdout.text.trim() !== input.sentinelContent.trim()) {
    return {
      kind: 'unavailable',
      stage: 'sandbox-read',
      codexVersion,
      diagnostics: [...diagnostics, '沙箱读取的哨兵内容与宿主写入的不一致'],
    };
  }

  // 使用当前 Node 读取实际写入 errno，避免把沙箱启动失败或其它 I/O 错误误认成拒写。
  const write = await input.run({
    executable: input.executable,
    args: sandboxArgs(input.directory, [
      process.execPath, '--input-type=commonjs', '-e',
      'try { require("node:fs").appendFileSync(process.argv[1], "injected"); } catch (error) { process.stdout.write(String(error.code)); process.exitCode = 1; }',
      input.sentinelPath,
    ]),
    cwd: input.directory,
    env: sandboxEnv,
    timeoutMs: input.timeoutMs,
    limits: { maxBytes: 64 * 1024, maxLines: 200 },
  });
  if (write.kind === 'unavailable') {
    return { kind: 'unknown', stage: 'sandbox-write', codexVersion, diagnostics: [...diagnostics, bounded(write.message)] };
  }
  if (write.kind === 'unknown') {
    return { kind: 'unknown', stage: 'sandbox-write', codexVersion, diagnostics: [...diagnostics, `沙箱写入 ${write.reason}`] };
  }
  // 退出码为零只说明 shell 认为写入成功：这就是「只读边界没被强制」。
  if (write.exitCode === 0) {
    return {
      kind: 'unavailable',
      stage: 'sandbox-write',
      codexVersion,
      diagnostics: [...diagnostics, '沙箱允许写入哨兵文件：只读边界未被强制'],
    };
  }

  let observed: string;
  try {
    observed = readFileSync(input.sentinelPath, 'utf8');
  } catch (error) {
    return {
      kind: 'unknown',
      stage: 'host-verify',
      codexVersion,
      diagnostics: [...diagnostics, `宿主回读哨兵失败：${bounded(error instanceof Error ? error.message : String(error))}`],
    };
  }
  if (observed !== input.sentinelContent) {
    return {
      kind: 'unavailable',
      stage: 'host-verify',
      codexVersion,
      diagnostics: [
        ...diagnostics,
        `哨兵内容在沙箱写入尝试后发生变化：${describeFailure('沙箱写入', write.exitCode, write.stderr.text)}`,
      ],
    };
  }
  if (write.exitCode !== 1 || write.stdout.truncated || !['EROFS', 'EACCES', 'EPERM'].includes(write.stdout.text)) {
    return {
      kind: 'unknown',
      stage: 'sandbox-write',
      codexVersion,
      diagnostics: [describeFailure('未取得文件写入的权限拒绝证据', write.exitCode, write.stderr.text)],
    };
  }
  return { kind: 'available', stage: 'host-verify', codexVersion, diagnostics };
}

/**
 * 以真实受限命令判定本机只读 Worker 能力。
 *
 * 结论只对**调用时刻**的 Codex 可执行文件与配置成立；调用方不得把它持久化后当作长期事实。
 */
export async function probeReadOnlyWorker(input: ReadOnlyWorkerProbeInput = {}): Promise<ReadOnlyWorkerProbeResult> {
  const run = input.runner ?? runProcess;
  const executable = input.executable ?? 'codex';
  const timeoutMs = input.timeoutMs ?? READ_ONLY_WORKER_PROBE_TIMEOUT_MS;
  const env = input.env ?? (process.env as Readonly<Record<string, string>>);
  const base = { profile: CODEX_UTILITY_PERMISSION_PROFILE };
  const diagnostics: string[] = [];
  let directory: string | null = null;
  try {
    directory = mkdtempSync(join(input.tempParent ?? tmpdir(), 'orca-companion-read-only-probe-'));
    const sentinelPath = join(directory, 'sentinel.txt');
    const sentinelText = `read-only-probe-${randomUUID()}`;
    const sentinelContent = `${sentinelText}\n`;
    writeFileSync(sentinelPath, sentinelContent, 'utf8');
    if (readFileSync(sentinelPath, 'utf8') !== sentinelContent) {
      diagnostics.push('宿主无法写回自己刚写的哨兵文件');
      return { ...base, kind: 'unknown', stage: 'host-sentinel', codexVersion: null, diagnostics };
    }
    const codexHome = join(directory, 'codex-home');
    mkdirSync(codexHome, { recursive: true });
    // 与 `createCodexWorkerLaunch` 同一份来源配置与同一段冲突规则：来源配置混用 legacy sandbox 键时
    // 生产 launch 会抛错，探针只写隔离 HOME 的 profile 就会漏检并误报可用，因此必须在探测前复现该检查。
    // 只复制 `config.toml`；探针不读也不链接 `auth.json`（无模型调用，不需要凭据）。
    const sourceHome = resolve(input.sourceCodexHome ?? env['CODEX_HOME'] ?? join(homedir(), '.codex'));
    const sourceConfig = join(sourceHome, 'config.toml');
    let sourceConfigText = '';
    if (existsSync(sourceConfig)) {
      copyFileSync(sourceConfig, join(codexHome, 'config.toml'));
      sourceConfigText = readFileSync(sourceConfig, 'utf8');
    }
    assertUtilityProfileConfigCompatible(sourceConfigText);
    writeFileSync(join(codexHome, CODEX_UTILITY_PROFILE_CONFIG_FILE), CODEX_UTILITY_PROFILE_CONFIG_TOML, 'utf8');
    const verdict = await probeOnce({ run, executable, timeoutMs, env, directory, sentinelPath, sentinelContent });
    diagnostics.push(...verdict.diagnostics);
    return { ...base, ...verdict, diagnostics };
  } catch (error) {
    // 临时目录、来源配置或 profile 写入本身失败都不构成能力证明：fail closed 且带上阶段。
    diagnostics.push(bounded(error instanceof Error ? error.message : String(error)));
    return {
      ...base,
      kind: 'unknown',
      stage: 'host-sentinel',
      codexVersion: null,
      diagnostics,
    };
  } finally {
    if (directory !== null) {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch (error) {
        diagnostics.push(`探针临时目录清理失败：${bounded(error instanceof Error ? error.message : String(error))}`);
      }
    }
  }
}

export type ReadOnlyWorkerProbe = () => Promise<ReadOnlyWorkerProbeResult>;

/**
 * 能力的可读结论：授权审阅与 doctor 共用同一段文案，避免两处各自解释同一个探针。
 */
export function describeReadOnlyWorkerCapability(result: ReadOnlyWorkerProbeResult): string {
  if (result.kind === 'available') {
    return `可用（codex ${result.codexVersion ?? '未读到'}，profile ${result.profile}）`;
  }
  const detail = result.diagnostics.length === 0 ? '' : `：${result.diagnostics.join('；')}`;
  const state = result.kind === 'unknown' ? '未知' : '不可用';
  return `${state}（阶段 ${result.stage}，codex ${result.codexVersion ?? '未读到'}，profile ${result.profile}）${detail}`;
}

/**
 * 稳定的 blocker 原因：能力可用时返回 `null`，否则返回带阶段、版本与诊断的一句话。
 *
 * 调用方只消费这个字符串，不各自拼文案；原因里出现的 `read_only_worker_unavailable` 是稳定 token。
 */
export function readOnlyWorkerUnavailableReason(result: ReadOnlyWorkerProbeResult): string | null {
  return result.kind === 'available'
    ? null
    : `read_only_worker_unavailable: ${describeReadOnlyWorkerCapability(result)}`;
}
