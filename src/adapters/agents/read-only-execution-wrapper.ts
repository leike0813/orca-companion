/**
 * IP-09 / D9：跨 harness 的只读执行包装器与真实能力探针（Ubuntu bwrap）。
 *
 * 只回答一个问题：**生产 launcher 与生产 descriptor** 下的受限命令能不能运行、读得到指定输入，又
 * 写不动仓库、Git 事实与 Companion 私有状态。探针不自己拼 bwrap argv：它用
 * `writeCodexModelLaunch` 写出与生产同构的非秘密 descriptor，继承真实原生环境，
 * 再跑同一条公开 launcher 命令；launcher 内嵌的 argv 工厂与本模块的
 * {@link readOnlyExecutionArguments} 是同一次序列化，所以二者不会漂移。
 *
 * 边界要说清楚：它证明的是「生产 launcher + descriptor + 包装器」这条链路，不是某次 harness 会话的
 * 身份。harness 自身的 `--version` 也经同一 descriptor 运行，用于证明该可执行文件能在这条链路里
 * 起来；版本存在仍不构成 exact-session 身份证明——那只能由真实派发的 proveSession 证明。
 *
 * 四项独立证据缺一不可：宿主证明哨兵可写 → 受限命令读出同一内容 → 受限命令对仓库、sibling
 * `coordination.sqlite` 与 `<workspace>/.git/HEAD` 的写入被拒、对精确状态根的写入被允许 → 宿主回读
 * 未变。探针不调用模型、不读项目文件、不修改任何 Scope；它只在项目树之外的临时目录里布置哨兵。
 *
 * 挂载顺序：包装器先 `--ro-bind / /`（一切只读），再按需 `--tmpfs /tmp` 提供可写
 * 暂存，最后 `--bind` 精确状态根。tmpfs 会遮蔽宿主同名目录，因此当 workspace、状态根或 reporter
 * 目录位于其中时，对应的 tmpfs 会被放弃，以保住这些路径可见。
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runProcess, type ProcessRunner, type ProcessResult } from '../orca-cli/process-runner.js';
import type { ReadOnlyWorkerProbeStage } from './codex-read-only-probe.js';
import { WORKER_HARNESS_IDS, workerModelSelectionSchema, type WorkerHarnessId, type WorkerModelSelection } from '../../domain/model-configuration.js';

/** 包装器可执行文件；探针与生产 launcher 用同一份事实。 */
export const READ_ONLY_EXECUTION_WRAPPER = 'bwrap';

/** 诊断里出现的权限配置名；native 只读角色没有 Codex 的 permission profile，包装器就是它的权限。 */
export const READ_ONLY_EXECUTION_PROFILE = 'bwrap-read-only';

/**
 * 受限启动的 argv 形状（不含 `bwrap` 本身）：仓库与 Git 事实只读，仅精确状态根与 tmp 可写。
 *
 * `stateRoot` 必须已存在（bwrap 的 `--bind` 要求目标路径存在）。workspace、状态根或 reporter 目录
 * 位于 `/tmp` 之下时，tmpfs 会被放弃以保住这些路径可见。`/run` 保持只读以保留 DNS。
 */
export type ReadOnlyExecutionInput = {
  readonly workspace: string;
  readonly stateRoot: string;
  readonly executable: string;
  readonly args: readonly string[];
  /**
   * 宿主 Session reporter 的**精确**目录；它通常不等于状态根本身（native 的 reporter 在
   * `<root>/<harness>/reporters/`，而状态根是 `<root>/<harness>/<digest>/`）。给出时只把这一个
   * 目录额外绑定为可写，reporters 的 sibling（含 `coordination.sqlite`）仍然只读。
   *
   * 省略表示 reporter 落在状态根内，无需第二个挂载点。
   */
  readonly reportDirectory?: string;
  readonly writableRoots?: readonly string[];
  readonly protectedPaths?: readonly string[];
};

export function readOnlyExecutionArguments(input: ReadOnlyExecutionInput): readonly string[] {
  const shadowed = (path: string): boolean => path === '/tmp' || path.startsWith('/tmp/');
  // /tmp 内有输入或状态根时保留原路径；harness 的暂存由 TMPDIR 承担。
  const protectedRoots = [input.workspace, input.stateRoot, input.reportDirectory, ...(input.writableRoots ?? []), ...(input.protectedPaths ?? [])]
    .filter((path): path is string => path !== undefined)
    .some(shadowed);
  const args: string[] = [
    '--die-with-parent',
    '--new-session',
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
  ];
  if (!protectedRoots) {
    args.push('--tmpfs', '/tmp');
  }
  // /run 保持根挂载的只读权限，保留 Ubuntu 的 DNS symlink 与 runtime socket。
  for (const path of input.protectedPaths ?? []) args.push('--ro-bind', path, path);
  for (const path of input.writableRoots ?? []) args.push('--bind', path, path);
  args.push('--bind', input.stateRoot, input.stateRoot);
  if (input.reportDirectory !== undefined) {
    args.push('--bind', input.reportDirectory, input.reportDirectory);
  }
  args.push('--chdir', input.workspace, '--', input.executable, ...input.args);
  return args;
}

/**
 * 供自包含 launcher 脚本内嵌的包装器源码。
 *
 * 由 {@link readOnlyExecutionArguments} 自身序列化得到，所以生产脚本里的这份与探针调用的那份永远是
 * 同一段逻辑。launcher 模板以 `const readOnlyArgs = readOnlyExecutionArguments(input)` 使用它。
 */
export const READ_ONLY_EXECUTION_WRAPPER_SOURCE =
  `const readOnlyExecutionArguments = ${readOnlyExecutionArguments.toString()};\n`;

/**
 * 跨 harness 的只读能力结论。
 *
 * 与 Codex 的 `ReadOnlyWorkerProbeResult` 结构兼容（stage 收在同一闭集、保留 `codexVersion`），因此
 * 既有消费者无需改类型；`harnessVersion` 与 `harness` 是逐 harness 的新增事实。
 */
export type WorkerHarnessProbeResult = {
  readonly kind: 'available' | 'unavailable' | 'unknown';
  readonly stage: ReadOnlyWorkerProbeStage;
  readonly profile: string;
  readonly diagnostics: readonly string[];
  /** harness 可执行文件自报版本；读不到时为 null，结论不能因此变成可用。 */
  readonly harnessVersion: string | null;
  readonly harness: string | null;
  /** Codex 探针的历史字段名，逐 harness 结论里保留以兼容既有消费者。 */
  readonly codexVersion: string | null;
};

export type ReadOnlyExecutionProbeInput = {
  readonly runner?: ProcessRunner;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  /** 探针临时根目录的父目录；省略时取系统临时目录。 */
  readonly tempParent?: string;
  /**
   * 哨兵 payload 的可执行文件；省略时为当前 Node。只用于注入自定义哨兵，**不要**把它指向 harness：
   * harness 自身由逐 harness 探针经同一生产 descriptor 运行。
   */
  readonly sandboxExecutable?: string;
};

/** 逐 harness 探针的输入：在探针输入之上再给出 harness 可执行文件覆盖。 */
export type HarnessReadOnlyProbeInput = ReadOnlyExecutionProbeInput & {
  /** harness 可执行文件覆盖；省略时按 harness 名解析。 */
  readonly harnessExecutable?: string;
};

/** 单个探针阶段的超时；受限命令要么很快失败，要么很快返回，60 秒只用于兜住挂死。 */
export const READ_ONLY_EXECUTION_PROBE_TIMEOUT_MS = 60_000;

const DIAGNOSTIC_LIMIT = 400;

/** harness 可执行文件（唯一事实映射）；未登记的 harness 读不到版本。 */
const HARNESS_EXECUTABLES: Readonly<Record<string, string>> = {
  codex: 'codex',
  claude: 'claude',
  opencode: 'opencode',
  pi: 'pi',
  omp: 'omp',
};

/** 诊断行必须短且有界：子进程输出可能整段回显命令与路径。 */
function bounded(text: string): string {
  const single = text.replaceAll(/\s+/gu, ' ').trim();
  return single.length <= DIAGNOSTIC_LIMIT ? single : `${single.slice(0, DIAGNOSTIC_LIMIT)}…`;
}

function failure(stage: ReadOnlyWorkerProbeStage, diagnostics: readonly string[]): WorkerHarnessProbeResult {
  return {
    kind: 'unavailable',
    stage,
    profile: READ_ONLY_EXECUTION_PROFILE,
    diagnostics,
    harnessVersion: null,
    harness: null,
    codexVersion: null,
  };
}

function unknown(stage: ReadOnlyWorkerProbeStage, diagnostics: readonly string[]): WorkerHarnessProbeResult {
  return {
    kind: 'unknown',
    stage,
    profile: READ_ONLY_EXECUTION_PROFILE,
    diagnostics,
    harnessVersion: null,
    harness: null,
    codexVersion: null,
  };
}

/** 探针临时根目录的父目录；显式给出时优先，否则用系统临时目录。 */
function probeParent(input: ReadOnlyExecutionProbeInput): string {
  return input.tempParent ?? tmpdir();
}

/** 受限命令的核验脚本；只读写宿主显式给出的哨兵路径，不触碰任何项目文件。 */
const SANDBOX_SCRIPT = [
  "const fs = require('node:fs');",
  'const [sentinel, coordination, gitHead, stateFile] = process.argv.slice(1);',
  'const out = {};',
  "out.sentinel = fs.readFileSync(sentinel, 'utf8').trim();",
  'function attempt(name, fn) {',
  "  try { fn(); out[name] = 'allowed'; } catch (error) { out[name] = error && error.code ? error.code : String(error); }",
  '}',
  "attempt('workspace', function () { fs.appendFileSync(sentinel, 'x'); });",
  "attempt('coordination', function () { fs.appendFileSync(coordination, 'x'); });",
  "attempt('git', function () { fs.appendFileSync(gitHead, 'x'); });",
  "attempt('stateRoot', function () { fs.appendFileSync(stateFile, 'x'); });",
  'process.stdout.write(JSON.stringify(out));',
].join('\n');

type SandboxOutcome = {
  readonly sentinel: string;
  readonly workspace: string;
  readonly coordination: string;
  readonly git: string;
  readonly stateRoot: string;
};

/** 拒写证据只承认实际文件写入的权限错误；命令非零或文件未变本身不算。 */
const WRITE_DENIED_CODES = new Set(['EROFS', 'EACCES', 'EPERM']);

function parseOutcome(stdout: string): SandboxOutcome | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const keys = ['sentinel', 'workspace', 'coordination', 'git', 'stateRoot'] as const;
    if (keys.some((key) => typeof record[key] !== 'string')) {
      return null;
    }
    return record as unknown as SandboxOutcome;
  } catch {
    return null;
  }
}

/** 探针的临时布局：workspace 只读、精确状态根可写、sibling coordination.sqlite 与 .git 只读。 */
type ProbeLayout = {
  readonly root: string;
  readonly workspace: string;
  readonly stateRoot: string;
  readonly sentinel: string;
  readonly sentinelPath: string;
  readonly coordination: string;
  readonly coordinationPath: string;
  readonly gitHead: string;
  readonly gitHeadPath: string;
  readonly stateFile: string;
};

function createLayout(input: ReadOnlyExecutionProbeInput): ProbeLayout | { readonly error: string } {
  try {
    const root = mkdtempSync(join(probeParent(input), 'orca-companion-read-only-execution-'));
    const stateRoot = join(root, 'state');
    const workspace = join(root, 'workspace');
    const stateDir = join(stateRoot, 'sessions');
    const gitDir = join(workspace, '.git');
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(gitDir, { recursive: true });
    const sentinelPath = join(workspace, 'tracked.txt');
    const gitHeadPath = join(gitDir, 'HEAD');
    const coordinationPath = join(root, 'coordination.sqlite');
    const stateFile = join(stateDir, 'session.jsonl');

    const sentinel = `read-only-probe-${randomUUID()}`;
    const coordination = `coordination-${randomUUID()}\n`;
    const gitHead = `ref: refs/heads/probe-${randomUUID().slice(0, 8)}\n`;
    writeFileSync(sentinelPath, `${sentinel}\n`, 'utf8');
    writeFileSync(gitHeadPath, gitHead, 'utf8');
    writeFileSync(coordinationPath, coordination, 'utf8');

    // 证据 1：宿主能读回自己写下的哨兵。
    if (readFileSync(sentinelPath, 'utf8').trim() !== sentinel || readFileSync(coordinationPath, 'utf8') !== coordination) {
      return { error: '宿主无法读回自己刚写的哨兵文件' };
    }
    return {
      root,
      workspace,
      stateRoot,
      sentinel,
      sentinelPath,
      coordination,
      coordinationPath,
      gitHead,
      gitHeadPath,
      stateFile,
    };
  } catch (error) {
    return { error: bounded(error instanceof Error ? error.message : String(error)) };
  }
}

/** 经生产 launcher + 生产 descriptor 运行一次 payload；payload 可以是哨兵，也可以是 `harness --version`。 */
async function runUnderProductionDescriptor(
  input: ReadOnlyExecutionProbeInput,
  layout: ProbeLayout,
  payload: { readonly executable: string; readonly args: readonly string[] },
  timeoutMs: number,
  env: Readonly<Record<string, string>>,
  harness?: WorkerHarnessId,
): Promise<ProcessResult> {
  // 动态 import：launcher 静态内嵌本模块的源码常量，静态反向 import 会形成
  // launcher → wrapper → codex-model-launcher → launcher 的顶层初始化环。
  const { CODEX_MODEL_DESCRIPTOR_VERSION, writeCodexModelLaunch } = await import('./codex-model-launcher.js');
  const { descriptorPath, launcherPath } = writeCodexModelLaunch({
    stateRoot: layout.stateRoot,
    descriptor: {
      version: CODEX_MODEL_DESCRIPTOR_VERSION,
      executable: payload.executable,
      args: payload.args,
      ...(harness === undefined ? {} : { harness }),
      readOnly: { workspace: layout.workspace, stateRoot: layout.stateRoot },
    },
  });
  const run = input.runner ?? runProcess;
  return await run({
    executable: process.execPath,
    args: [launcherPath, descriptorPath],
    cwd: layout.workspace,
    env,
    timeoutMs,
    limits: { maxBytes: 256 * 1024, maxLines: 2_000 },
  });
}

function sentinelArgs(layout: ProbeLayout): readonly string[] {
  return [
    '--input-type=commonjs',
    '-e',
    SANDBOX_SCRIPT,
    layout.sentinelPath,
    layout.coordinationPath,
    layout.gitHeadPath,
    layout.stateFile,
  ];
}

/** 把一次哨兵运行的原始结果归类成能力结论；诊断数组与调用方共享，便于补记清理失败。 */
function classify(result: ProcessResult, layout: ProbeLayout, diagnostics: string[]): WorkerHarnessProbeResult {
  if (result.kind === 'unavailable') {
    diagnostics.push(`生产 launcher 启动失败 ${result.code}: ${bounded(result.message)}`);
    return failure('sandbox-read', diagnostics);
  }
  if (result.kind === 'unknown') {
    diagnostics.push(`受限命令 ${result.reason}，无法确认只读边界`);
    return unknown('sandbox-read', diagnostics);
  }
  if (result.exitCode !== 0 || result.stdout.truncated) {
    diagnostics.push(`受限命令失败（退出码 ${String(result.exitCode)}）：${bounded(result.stderr.text.split('\n')[0] ?? '')}`);
    return failure('sandbox-read', diagnostics);
  }

  const outcome = parseOutcome(result.stdout.text);
  if (outcome === null) {
    diagnostics.push('无法解析受限命令的核验结果');
    return unknown('sandbox-read', diagnostics);
  }

  // 证据 2：受限命令读得到哨兵，内容与宿主写入一致。
  if (outcome.sentinel !== layout.sentinel) {
    diagnostics.push('受限命令读到的哨兵内容与宿主写入的不一致');
    return failure('sandbox-read', diagnostics);
  }

  // 证据 3a：仓库、Git 事实与 sibling coordination.sqlite 的写入都被真实权限错误拒绝。
  for (const [name, label] of [
    ['workspace', '仓库文件'],
    ['coordination', 'coordination.sqlite'],
    ['git', 'Git 事实（.git/HEAD）'],
  ] as const) {
    if (!WRITE_DENIED_CODES.has(outcome[name])) {
      diagnostics.push(`受限命令${label}的写入未被拒绝（${outcome[name]}）：只读边界未被强制`);
      return failure('sandbox-write', diagnostics);
    }
  }

  // 证据 3b：精确状态根必须可写，否则 harness 无法落盘会话。
  if (outcome.stateRoot !== 'allowed') {
    diagnostics.push(`受限命令无法写入精确状态根（${outcome.stateRoot}）`);
    return failure('sandbox-write', diagnostics);
  }

  // 证据 4：宿主回读，只读目标逐字节未变，只有状态根被写入。
  if (
    readFileSync(layout.sentinelPath, 'utf8') !== `${layout.sentinel}\n` ||
    readFileSync(layout.coordinationPath, 'utf8') !== layout.coordination ||
    readFileSync(layout.gitHeadPath, 'utf8') !== layout.gitHead
  ) {
    diagnostics.push('只读目标在受限命令写入尝试后发生变化');
    return failure('host-verify', diagnostics);
  }
  if (!existsSync(layout.stateFile)) {
    diagnostics.push('受限命令报告写入状态根，但宿主回读不到该文件');
    return unknown('host-verify', diagnostics);
  }

  return {
    kind: 'available',
    stage: 'host-verify',
    profile: READ_ONLY_EXECUTION_PROFILE,
    diagnostics,
    harnessVersion: null,
    harness: null,
    codexVersion: null,
  };
}

/** 建布局并跑一次哨兵；返回结果、布局与共享诊断（布局由调用方负责清理）。 */
async function runSentinelEvidence(
  input: ReadOnlyExecutionProbeInput,
  timeoutMs: number,
  env: Readonly<Record<string, string>>,
  harness?: WorkerHarnessId,
): Promise<{ readonly result: WorkerHarnessProbeResult; readonly layout: ProbeLayout | null; readonly diagnostics: string[] }> {
  const diagnostics: string[] = [];
  let layout: ProbeLayout | null = null;
  try {
    const created = createLayout(input);
    if ('error' in created) {
      return { result: unknown('host-sentinel', [created.error]), layout: null, diagnostics };
    }
    layout = created;
    const result = await runUnderProductionDescriptor(
      input,
      layout,
      { executable: input.sandboxExecutable ?? process.execPath, args: sentinelArgs(layout) },
      timeoutMs,
      env,
      harness,
    );
    return { result: classify(result, layout, diagnostics), layout, diagnostics };
  } catch (error) {
    return { result: unknown('host-sentinel', [bounded(error instanceof Error ? error.message : String(error))]), layout, diagnostics };
  }
}

function cleanup(layout: ProbeLayout | null, diagnostics: string[]): void {
  if (layout === null) {
    return;
  }
  try {
    rmSync(layout.root, { recursive: true, force: true });
  } catch (error) {
    diagnostics.push(`探针临时目录清理失败：${bounded(error instanceof Error ? error.message : String(error))}`);
  }
}

function versionFrom(result: ProcessResult): string | null {
  if (result.kind !== 'completed' || result.exitCode !== 0 || result.stdout.truncated) {
    return null;
  }
  return /(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)/u.exec(result.stdout.text)?.[1] ?? null;
}

/**
 * 用**生产 launcher + 生产 descriptor**判定本机 native 只读能力。
 *
 * 结论只对调用时刻的 bwrap、内核挂载能力与 launcher 脚本成立；调用方不得持久化后当作长期事实。
 */
export async function probeReadOnlyExecution(
  input: ReadOnlyExecutionProbeInput = {},
): Promise<WorkerHarnessProbeResult> {
  const timeoutMs = input.timeoutMs ?? READ_ONLY_EXECUTION_PROBE_TIMEOUT_MS;
  const env = input.env ?? (process.env as Readonly<Record<string, string>>);
  const evidence = await runSentinelEvidence(input, timeoutMs, env);
  cleanup(evidence.layout, evidence.diagnostics);
  return evidence.result;
}

/**
 * 逐 harness 的通用只读探针：按已批准模型配置里的 harness 选择实现。
 *
 * codex（或没有模型配置）沿用 Codex 自己的受限 profile 探针；native harness 先在**同一生产
 * descriptor** 下跑哨兵拿到四项证据，再用同一 descriptor 跑 `<harness> --version` 证明该可执行文件
 * 能在这条链路里起来。两条路径都返回同一种结论形状，调用方不需要自己判断 harness。
 */
export async function probeHarnessReadOnlyWorker(
  harness: string,
  modelSelection?: Readonly<WorkerModelSelection>,
  input: HarnessReadOnlyProbeInput = {},
): Promise<WorkerHarnessProbeResult> {
  if (!(WORKER_HARNESS_IDS as readonly string[]).includes(harness)
    || (modelSelection !== undefined && !workerModelSelectionSchema.safeParse(modelSelection).success)) {
    return unknown('codex-version', ['Worker harness/model selection 无效']);
  }
  const executable = input.harnessExecutable ?? HARNESS_EXECUTABLES[harness];
  if (executable === undefined) {
    return unknown('codex-version', [`未登记的 harness：${harness}`]);
  }
  const timeoutMs = input.timeoutMs ?? READ_ONLY_EXECUTION_PROBE_TIMEOUT_MS;
  const env = input.env ?? (process.env as Readonly<Record<string, string>>);
  const evidence = await runSentinelEvidence(input, timeoutMs, env, harness as WorkerHarnessId);
  let result: WorkerHarnessProbeResult;
  try {
    if (evidence.result.kind !== 'available' || evidence.layout === null) {
      result = { ...evidence.result, harness };
    } else {
      // 第二次运行复用同一 descriptor：证明 harness 可执行文件与本包装器兼容。
      const version = versionFrom(
        await runUnderProductionDescriptor(input, evidence.layout, { executable, args: ['--version'] }, timeoutMs, env, harness as WorkerHarnessId),
      );
      if (version === null) {
        evidence.diagnostics.push(`${harness} 在同一生产 descriptor 下没有输出版本：无法证明该 harness 只读能力可用`);
        result = {
          kind: 'unavailable',
          stage: 'codex-version',
          profile: READ_ONLY_EXECUTION_PROFILE,
          diagnostics: evidence.diagnostics,
          harnessVersion: null,
          harness,
          codexVersion: null,
        };
      } else {
        result = {
          kind: 'available',
          stage: 'host-verify',
          profile: READ_ONLY_EXECUTION_PROFILE,
          diagnostics: evidence.diagnostics,
          harnessVersion: version,
          harness,
          codexVersion: version,
        };
      }
    }
  } catch (error) {
    evidence.diagnostics.push(bounded(error instanceof Error ? error.message : String(error)));
    result = { ...unknown('codex-version', evidence.diagnostics), harness };
  } finally {
    cleanup(evidence.layout, evidence.diagnostics);
  }
  return result;
}

/** 生产 native 只读启动在写任何状态文件之前的包装器前置核验；不可用即抛错 fail closed。 */
export async function assertReadOnlyExecutionWrapperAvailable(
  input: ReadOnlyExecutionProbeInput = {},
): Promise<void> {
  const result = await probeReadOnlyExecution(input);
  if (result.kind !== 'available') {
    throw new Error(`只读包装器不可用：${describeHarnessReadOnlyCapability(result)}`);
  }
}

/** 授权审阅与 doctor 共用的可读结论；逐 harness 文案只有一处。 */
export function describeHarnessReadOnlyCapability(result: WorkerHarnessProbeResult): string {
  const harness = result.harness ?? '未知 harness';
  const version = result.harnessVersion ?? '未读到';
  if (result.kind === 'available') {
    return `可用（${harness} ${version}，profile ${result.profile}）`;
  }
  const detail = result.diagnostics.length === 0 ? '' : `：${result.diagnostics.join('；')}`;
  const state = result.kind === 'unknown' ? '未知' : '不可用';
  return `${state}（${harness} ${version}，阶段 ${result.stage}，profile ${result.profile}）${detail}`;
}
