/**
 * IP-5 / D8：`orca-companion doctor` 的环境与能力核验。
 *
 * 只读顺序固定为：可执行文件与版本 → `status --json` 的 runtime 可达性与必需能力 → `host list` 的本地
 * host → 协调身份可取得性（绑定型命令可用性）。任一失败即停止，不再继续后续检查，也绝不自动回退、
 * 伪造身份或绕过缺口。本模块不要求 TTY，也不加载 Ink/React。
 */

import { readFileSync } from 'node:fs';

import { failureCategoryOf } from '../adapters/orca-cli/error-classification.js';
import { createOrcaExecutionBackend } from '../adapters/orca-cli/orca-backend.js';
import { runProcess } from '../adapters/orca-cli/process-runner.js';
import {
  describeHarnessReadOnlyCapability,
  probeHarnessReadOnlyWorker,
  type WorkerHarnessProbeResult,
} from '../adapters/agents/read-only-execution-wrapper.js';
import { MODEL_PROFILE_ROLES, WORKER_HARNESS_IDS, type WorkerProfileConfiguration } from '../domain/model-configuration.js';
import {
  createModuleIntegrationResolverAsync,
  resolveChatModel,
} from '../adapters/agents/chat-model-factory.js';
import { verifyModelCapabilities } from '../adapters/agents/capability-probe.js';
import { JsonCredentialStore } from '../adapters/storage/credential-store.js';
import { queryWorkerModels } from '../adapters/agents/worker-model-catalog.js';
import type { CredentialStore } from '../application/ports/credential-store.js';
import {
  configurationByRef,
  currentWorkerProfile,
  loadProjectConfig,
  type ProjectConfig,
} from '../application/configuration/project-config.js';

export const DOCTOR_SCHEMA_VERSION = 1;

/** 本机已验证过的 Orca 基线；低于它的版本按「版本不符」拒绝，更新的版本放行并如实报告。 */
export const MINIMUM_ORCA_VERSION = '1.4.198';

/**
 * M0 依赖的运行时能力令牌。缺少任一项即能力缺失：这些是编排 typed RPC 契约与 create/stop 幂等回执的
 * 声明，Companion 依赖它们而不是自建第二套权威。
 */
export const REQUIRED_RUNTIME_CAPABILITIES: readonly string[] = [
  'orchestration.contract.v1',
  'orchestration.worker-stop-verdict.v1',
  'worktree.create-idempotency.v1',
  'terminal.create-idempotency.v2',
];

export const REQUIRED_CLI_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  orchestration: [
    'run-create',
    'run-use',
    'run-current',
    'run-list',
    'run-show',
    'task-create',
    'task-list',
    'task-update',
    'worker-start',
    'worker-show',
    'worker-read',
    'worker-list',
    'worker-stop',
    'worker-abandon',
    'worker-release',
    'check',
    'request-show',
  ],
  terminal: ['create', 'list', 'show', 'read', 'wait', 'send', 'close'],
  host: ['list'],
  worktree: ['current'],
};

export type DoctorStatus = 'ok' | 'unreachable' | 'version-mismatch' | 'capability-missing';

export type DoctorCheckId =
  | 'orca-executable'
  | 'orca-version'
  | 'runtime'
  | 'runtime-capabilities'
  | 'hosts'
  | 'coordinator-identity'
  | 'public-commands'
  | 'coordinator-model'
  | 'read-only-worker';

export type DoctorCheck = {
  readonly id: DoctorCheckId;
  readonly status: DoctorStatus;
  readonly detail: string;
  /** 结构化缺失能力清单；只在能力缺失时有值，供机器消费者直接读取而不必解析文案。 */
  readonly missing?: readonly string[];
};

export type DoctorReport = {
  readonly schemaVersion: number;
  readonly ok: boolean;
  readonly expectedOrcaVersion: string;
  readonly observedOrcaVersion: string | null;
  readonly checks: readonly DoctorCheck[];
};

export type DoctorProbeStep<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly status: Exclude<DoctorStatus, 'ok' | 'version-mismatch'>; readonly detail: string };

export type RuntimeFacts = {
  readonly state: string;
  readonly reachable: boolean;
  readonly capabilities: readonly string[];
};

export type HostFacts = {
  readonly id: string;
  readonly kind: string;
  readonly platform: string | null;
};

export type DoctorProbe = {
  readonly readOrcaVersion: () => Promise<DoctorProbeStep<string>>;
  readonly readRuntime: () => Promise<DoctorProbeStep<RuntimeFacts>>;
  readonly readHosts: () => Promise<DoctorProbeStep<readonly HostFacts[]>>;
  readonly readCoordinatorIdentity: () => Promise<DoctorProbeStep<string>>;
  readonly readPublicCommands: () => Promise<DoctorProbeStep<readonly string[]>>;
  /**
   * Coordinator 模型能力核验。
   *
   * 可选：只有在当前 Scope 已经配置了 Coordinator Model Configuration 时才探测。未配置时 doctor
   * 不假装核验过，也不因此判定失败——模型核验是「配置了就必查」，而不是「没配置也必查」。
   */
  readonly readCoordinatorModel?: () => Promise<DoctorProbeStep<CoordinatorModelFacts>>;
  /**
   * 本机只读 Worker 能力核验，按**被配置引用的 harness** 逐项输出（Capsule Utility Worker 与只读
   * Finalizer 都走这条路径）。
   *
   * 可选：未提供时不报告该项结论，而不是默认通过。它与 Route Planning 的启动门无关，只影响
   * `doctor` 的结论与依赖这两个角色的执行授权。
   */
  readonly readReadOnlyWorkers?: () => Promise<DoctorProbeStep<readonly ReadOnlyHarnessFacts[]>>;
};

/**
 * 单个只读角色 profile 的能力事实：三态结论加上一段可读结论（阶段、版本、profile 与诊断）。
 *
 * 按 profile 而不是按 harness 归并：同一 harness 的不同 profile 可能带不同模型与认证来源，合并成
 * 一条会让其中一条不合法被另一条掩盖。doctor 只做投影，不重新判断能力。
 */
export type ReadOnlyHarnessFacts = {
  readonly harness: string;
  readonly profileRef: string;
  readonly capability: WorkerHarnessProbeResult['kind'];
  readonly harnessVersion: string | null;
  readonly detail: string;
};

/** 模型核验的事实：报告与缺失能力；doctor 只做投影，不重新判断能力。 */
export type CoordinatorModelFacts = {
  readonly modelRef: string;
  readonly missing: readonly string[];
  readonly details: readonly string[];
};

function parseVersion(value: string): readonly [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (match === null) {
    return undefined;
  }
  const [, major, minor, patch] = match;
  if (major === undefined || minor === undefined || patch === undefined) {
    return undefined;
  }
  return [Number(major), Number(minor), Number(patch)];
}

/** 无法解析时返回 undefined；调用方必须按「版本不符」处理，不能猜。 */
export function compareVersions(left: string, right: string): number | undefined {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a === undefined || b === undefined) {
    return undefined;
  }
  for (let index = 0; index < 3; index += 1) {
    const left1 = a[index] ?? 0;
    const right1 = b[index] ?? 0;
    if (left1 !== right1) {
      return left1 < right1 ? -1 : 1;
    }
  }
  return 0;
}

export type DoctorOptions = {
  readonly minimumVersion?: string;
  readonly requiredCapabilities?: readonly string[];
};

export async function runDoctor(probe: DoctorProbe, options: DoctorOptions = {}): Promise<DoctorReport> {
  const minimumVersion = options.minimumVersion ?? MINIMUM_ORCA_VERSION;
  const requiredCapabilities = options.requiredCapabilities ?? REQUIRED_RUNTIME_CAPABILITIES;
  const checks: DoctorCheck[] = [];
  const finish = (observedOrcaVersion: string | null): DoctorReport => ({
    schemaVersion: DOCTOR_SCHEMA_VERSION,
    ok: checks.every((check) => check.status === 'ok'),
    expectedOrcaVersion: minimumVersion,
    observedOrcaVersion,
    checks,
  });

  const version = await probe.readOrcaVersion();
  if (!version.ok) {
    checks.push({ id: 'orca-executable', status: version.status, detail: version.detail });
    return finish(null);
  }
  checks.push({ id: 'orca-executable', status: 'ok', detail: 'Orca CLI 可执行' });

  const comparison = compareVersions(version.value, minimumVersion);
  if (comparison === undefined) {
    checks.push({
      id: 'orca-version',
      status: 'version-mismatch',
      detail: `无法解析 Orca 版本 ${version.value}，不能确认它与 ${minimumVersion} 兼容`,
    });
    return finish(version.value);
  }
  if (comparison < 0) {
    checks.push({
      id: 'orca-version',
      status: 'version-mismatch',
      detail: `Orca 版本 ${version.value} 低于已验证基线 ${minimumVersion}`,
    });
    return finish(version.value);
  }
  checks.push({ id: 'orca-version', status: 'ok', detail: `Orca 版本 ${version.value}` });

  const runtime = await probe.readRuntime();
  if (!runtime.ok) {
    checks.push({ id: 'runtime', status: runtime.status, detail: runtime.detail });
    return finish(version.value);
  }
  if (!runtime.value.reachable) {
    checks.push({
      id: 'runtime',
      status: 'unreachable',
      detail: `Orca runtime 状态为 ${runtime.value.state}，不可达`,
    });
    return finish(version.value);
  }
  checks.push({ id: 'runtime', status: 'ok', detail: `Orca runtime 可达（state=${runtime.value.state}）` });

  const missing = requiredCapabilities.filter((capability) => !runtime.value.capabilities.includes(capability));
  if (missing.length > 0) {
    checks.push({
      id: 'runtime-capabilities',
      status: 'capability-missing',
      detail: `runtime 缺少 M0 必需能力：${missing.join(', ')}`,
    });
    return finish(version.value);
  }
  checks.push({
    id: 'runtime-capabilities',
    status: 'ok',
    detail: `已核验 ${requiredCapabilities.length} 项 M0 必需能力`,
  });

  const hosts = await probe.readHosts();
  if (!hosts.ok) {
    checks.push({ id: 'hosts', status: hosts.status, detail: hosts.detail });
    return finish(version.value);
  }
  const local = hosts.value.filter((host) => host.kind === 'local');
  if (local.length === 0) {
    checks.push({ id: 'hosts', status: 'capability-missing', detail: 'host list 没有 local host' });
    return finish(version.value);
  }
  checks.push({ id: 'hosts', status: 'ok', detail: `local host ${local.map((host) => host.id).join(', ')}` });

  const identity = await probe.readCoordinatorIdentity();
  if (!identity.ok) {
    checks.push({ id: 'coordinator-identity', status: identity.status, detail: identity.detail });
    return finish(version.value);
  }
  checks.push({ id: 'coordinator-identity', status: 'ok', detail: identity.value });

  const commands = await probe.readPublicCommands();
  if (!commands.ok) {
    checks.push({ id: 'public-commands', status: commands.status, detail: commands.detail });
    return finish(version.value);
  }
  const available = new Set(commands.value);
  const missingCommands = Object.entries(REQUIRED_CLI_COMMANDS).flatMap(([group, names]) =>
    names.filter((name) => !available.has(`${group} ${name}`)).map((name) => `${group} ${name}`),
  );
  if (missingCommands.length > 0) {
    checks.push({
      id: 'public-commands',
      status: 'capability-missing',
      detail: `Orca CLI 缺少 M0 必需命令：${missingCommands.join(', ')}`,
    });
    return finish(version.value);
  }
  const requiredCommandCount = Object.values(REQUIRED_CLI_COMMANDS).reduce((total, names) => total + names.length, 0);
  checks.push({ id: 'public-commands', status: 'ok', detail: `已核验 ${requiredCommandCount} 个 M0 必需公开命令` });

  // 模型能力核验并入同一份报告：它是启动路径与 doctor 路径共用的唯一核验。
  if (probe.readCoordinatorModel !== undefined) {
    const model = await probe.readCoordinatorModel();
    if (!model.ok) {
      checks.push({ id: 'coordinator-model', status: model.status, detail: model.detail });
      return finish(version.value);
    }
    if (model.value.missing.length > 0) {
      checks.push({
        id: 'coordinator-model',
        status: 'capability-missing',
        detail: `Coordinator 模型 ${model.value.modelRef} 缺少必需能力：${model.value.missing.join(', ')}`,
        missing: model.value.missing,
      });
      return finish(version.value);
    }
    checks.push({
      id: 'coordinator-model',
      status: 'ok',
      detail: `Coordinator 模型 ${model.value.modelRef} 已通过 ${model.value.details.length} 项能力核验`,
    });
  }

  // 只读 Worker 是本机的一条独立能力：它在既有前置换完成后单独核验，不参与 Route Planning 启动门。
  // 每个被配置引用的 harness 各出一条结论：某一项能力缺失只把该项标记失败，不把别的 harness 的
  // 结论套到它身上。
  if (probe.readReadOnlyWorkers !== undefined) {
    const readOnly = await probe.readReadOnlyWorkers();
    if (!readOnly.ok) {
      checks.push({ id: 'read-only-worker', status: readOnly.status, detail: readOnly.detail });
      return finish(version.value);
    }
    for (const fact of readOnly.value) {
      const available = fact.capability === 'available';
      checks.push({
        id: 'read-only-worker',
        status: available ? 'ok' : 'capability-missing',
        detail: `只读 Worker 能力［${fact.harness} ${fact.harnessVersion ?? '未读到'} · ${fact.profileRef}］：${fact.detail}`,
        ...(available ? {} : { missing: [fact.profileRef] }),
      });
    }
  }

  return finish(version.value);
}

export type OrcaDoctorProbeEnvironment = {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /**
   * 宿主已构造的用户级凭据 store。前台 Bootstrap 传入与其它消费者共用的同一实例；独立的
   * `doctor` 命令省略时由本模块按 `env` 构造一份，保持「一次调用一个实例」。
   */
  readonly credentialStore?: CredentialStore;
  readonly executable?: string;
  /** 前台 Scope 的调用者身份只从该 canonical worktree 的终端中选择。 */
  readonly identityWorktreePath?: string;
  /** 显式指定的协调身份引用；缺省时使用刚核验过存活的活动终端句柄。 */
  readonly coordinatorIdentityRef?: string;
  /**
   * 已配置的 Coordinator 模型；缺省表示当前 Scope 还没配置，doctor 不做模型核验。
   *
   * `resolve` 由 Bootstrap 提供，doctor 不自己解析 provider 集成，也不保存凭据。
   */
  readonly coordinatorModel?: {
    readonly configurationRef: string;
    readonly resolve: () => Promise<DoctorProbeStep<CoordinatorModelFacts>>;
  };
};

function stepFromRejection(code: string, message: string): DoctorProbeStep<never> {
  return {
    ok: false,
    status: failureCategoryOf(code) === 'backend_unreachable' ? 'unreachable' : 'capability-missing',
    detail: `${code}: ${message}`,
  };
}

/**
 * Bootstrap 组合：由公开 CLI 只读查询组装真实探测，并把 `DoctorProbe` 交给 CLI，
 * 使 `MOD-05` 不必直接调用 adapter。
 *
 * 全部为只读查询：不创建终端、不写数据库、不重启 runtime，也不触碰既有 workload 的内容。
 * 身份探测只用 `terminal list` 已报告为存活且属于本地 host scope 的句柄；缺失 host scope 时不能读作本地。
 * 这里的身份解析是受限直通：只接受本次 `terminal list` 观察到的活动句柄，且 handle 不进入任何应用层 DTO。
 */
/** doctor 读到的项目配置事实（IP-03 / D03）。 */
type DoctorProjectConfigRead =
  | { readonly kind: 'loaded'; readonly config: ProjectConfig }
  | { readonly kind: 'absent' }
  | { readonly kind: 'failed'; readonly code: string; readonly message: string };

/**
 * 读取项目配置一次，供模型核验与只读探针共用。
 *
 * 显式三态而不是布尔值：缺配置允许跳过核验，配置存在但读不动或写坏了必须报出来。压成一个布尔值会让
 * 「没配」与「配错了」变成同一句话，用户既无从判断该不该装 provider 集成，也看不到项目配置有问题。
 */
function readProjectConfigOnce(worktreePath: string): DoctorProjectConfigRead {
  const loaded = loadProjectConfig({
    worktreePath,
    readFile: (target: string) => readFileSync(target, 'utf8'),
  });
  if (loaded.kind === 'loaded') {
    return { kind: 'loaded', config: loaded.config };
  }
  return loaded.code === 'missing'
    ? { kind: 'absent' }
    : { kind: 'failed', code: loaded.code, message: loaded.message };
}

/**
 * 用启动同一条路径核验已配置的 Coordinator 模型：同一工厂、同一份 CredentialStore、同一套五项能力
 * 核验。
 *
 * 凭据 store 由 `createOrcaDoctorProbe` 按本次 env 构造一份并注入，而不是每个消费者各建一个：doctor
 * 可能运行在另一个 XDG 环境里，store 必须跟随本次调用；同时装配面上只有一个实例来源，避免同一进程
 * 内出现指向不同文件的副本。
 */
function unreadableConfigStep(message: string): DoctorProbeStep<CoordinatorModelFacts> {
  return {
    ok: false,
    status: 'capability-missing',
    detail: `项目配置无法使用：${message}`,
  };
}

async function verifyConfiguredCoordinatorModel(
  config: ProjectConfig,
  credentials: CredentialStore,
): Promise<DoctorProbeStep<CoordinatorModelFacts>> {
  const configuration = configurationByRef(config, config.defaultCoordinatorModelRef);
  if (configuration === null) {
    return {
      ok: false,
      status: 'capability-missing',
      detail: `默认 Coordinator 配置 ${config.defaultCoordinatorModelRef} 不在项目配置中`,
    };
  }
  const resolver = createModuleIntegrationResolverAsync();
  const integration = await resolver(configuration.providerIntegration);
  if (integration === null) {
    return {
      ok: false,
      status: 'capability-missing',
      detail: `provider 集成不可用：${configuration.providerIntegration}`,
    };
  }
  const resolved = resolveChatModel(
    configuration,
    () => integration,
    credentials,
  );
  if (resolved.kind !== 'resolved') {
    // 凭据解析失败与 provider 不可用都不是「能力探针没跑」，而是这份配置本身用不了：如实报不可用。
    return { ok: false, status: 'capability-missing', detail: resolved.message };
  }
  const verification = await verifyModelCapabilities(resolved.model, {
    modelRef: configuration.configurationRef,
  });
  return verification.kind === 'rejected'
    ? { ok: false, status: 'capability-missing', detail: verification.message }
    : {
        ok: true,
        value: {
          modelRef: configuration.configurationRef,
          missing: verification.report.missing,
          details: verification.report.details,
        },
      };
}

/**
 * 单个被配置 harness 的只读核验。
 *
 * 结论只来自真实受限命令；harness 名称、版本字符串或配置文件存在都不构成能力证明。Worker 的模型、
 * 凭据与 provider endpoint 由 harness 自身拥有，doctor 只按被引用 harness 与其 `modelSelection` 用
 * 同一生产包装器探针，不解析凭据、也不读原生连接。
 */
async function probeConfiguredReadOnlyHarness(
  profile: WorkerProfileConfiguration,
  env: Readonly<Record<string, string>>,
): Promise<ReadOnlyHarnessFacts> {
  const harness = profile.harness;
  const base = { harness, profileRef: profile.profileRef };
  const fail = (
    capability: WorkerHarnessProbeResult['kind'],
    detail: string,
    harnessVersion: string | null = null,
  ): ReadOnlyHarnessFacts => ({ ...base, capability, harnessVersion, detail });
  if (!(WORKER_HARNESS_IDS as readonly string[]).includes(harness)) {
    return fail('unknown', `未注册的 Worker harness：${String(harness)}`);
  }
  try {
    const result = await probeHarnessReadOnlyWorker(harness, profile.modelSelection, { env });
    return {
      ...base,
      capability: result.kind,
      harnessVersion: result.harnessVersion,
      detail: describeHarnessReadOnlyCapability(result),
    };
  } catch (error) {
    // 原始 error.message 会被子进程与 SDK 放大，可能带出命令行、模型参数或凭据片段。doctor 是给人看的
    // 诊断面，不是调试通道：这里只报错误类别，细节留在日志里由调用方自己取。
    const category = error instanceof Error ? error.name : typeof error;
    return fail('unknown', `只读 Worker 能力探针无法运行（${category}）`);
  }
}

export function createOrcaDoctorProbe(environment: OrcaDoctorProbeEnvironment): DoctorProbe {
  // 本次 doctor 调用唯一的凭据 store：优先沿用宿主注入的同一实例；独立命令未注入时按 env 构造
  // 一份，供所有需要读凭据的消费者共用，不在各消费者内部各建一个指向同一文件的副本。
  const credentials =
    environment.credentialStore ?? new JsonCredentialStore({ environment: environment.env });
  // 显式给出的协调身份与 `terminal list` 观察到的句柄同权：否则探测会先宣布「身份可用」，
  // 随后每个带身份的查询都因解析不到这个句柄而失败。
  const observedHandles = new Set<string>(
    environment.coordinatorIdentityRef === undefined ? [] : [environment.coordinatorIdentityRef],
  );
  const backend = createOrcaExecutionBackend({
    ...(environment.executable === undefined ? {} : { executable: environment.executable }),
    cwd: environment.cwd,
    env: environment.env,
    resolveIdentityHandle: (ref) => (observedHandles.has(ref) ? ref : undefined),
  });

  // 装配时读一次：模型核验与只读探针必须看到同一份 revision，否则 doctor 报告的默认引用与实际
  // 核验的配置可能不是同一份。项目配置缺失只影响这两个检查，不影响 Orca 相关的其余结论。
  const projectConfig = readProjectConfigOnce(environment.cwd);

  return {
    readOrcaVersion: async () => {
      const result = await backend.query({ operation: 'version' });
      if (result.kind !== 'accepted') {
        return stepFromRejection(result.code, result.message);
      }
      const version = typeof result.value === 'string' ? result.value : '';
      if (version.length === 0) {
        return { ok: false, status: 'unreachable', detail: 'orca --version 没有输出可解析的版本号' };
      }
      return { ok: true, value: version };
    },
    readRuntime: async () => {
      const result = await backend.query({ operation: 'status' });
      if (result.kind !== 'accepted') {
        return stepFromRejection(result.code, result.message);
      }
      const status = result.value as Partial<RuntimeFacts> | null;
      if (status === null || typeof status.reachable !== 'boolean' || !Array.isArray(status.capabilities)) {
        return { ok: false, status: 'capability-missing', detail: 'status 缺少 reachable 或 capabilities' };
      }
      return {
        ok: true,
        value: {
          state: typeof status.state === 'string' ? status.state : 'unknown',
          reachable: status.reachable,
          capabilities: status.capabilities,
        },
      };
    },
    readHosts: async () => {
      const result = await backend.query({ operation: 'host-list' });
      if (result.kind !== 'accepted') {
        return stepFromRejection(result.code, result.message);
      }
      return { ok: true, value: result.value as readonly HostFacts[] };
    },
    readCoordinatorIdentity: async () => {
      const explicit = environment.coordinatorIdentityRef;
      if (explicit !== undefined) {
        // 显式声明的协调身份直接生效：不再依赖 terminal 列举，因此新项目（路径还没被 Orca 登记成
        // worktree、`terminal-list --worktree` 会以 selector_not_found 失败）也能取到身份。
        const explicitBinding = await backend.query({ operation: 'run-current', backendIdentityRef: explicit });
        if (explicitBinding.kind !== 'accepted') {
          return stepFromRejection(explicitBinding.code, explicitBinding.message);
        }
        return { ok: true, value: explicit };
      }
      const listed = await backend.query({
        operation: 'terminal-list',
        ...(environment.identityWorktreePath === undefined
          ? {}
          : { worktree: `path:${environment.identityWorktreePath}` }),
      });
      if (listed.kind !== 'accepted') {
        return stepFromRejection(listed.code, listed.message);
      }
      const terminals = listed.value as {
        readonly terminals: readonly {
          readonly handle: string;
          readonly connected: boolean;
          readonly writable: boolean;
          readonly orphaned: boolean;
          readonly executionHostId: string | null;
        }[];
        readonly hostIds: readonly string[];
      };
      for (const terminal of terminals.terminals) {
        const inLocalScope =
          terminal.connected &&
          terminal.writable &&
          !terminal.orphaned &&
          terminal.executionHostId !== null &&
          terminals.hostIds.includes(terminal.executionHostId);
        if (inLocalScope) {
          observedHandles.add(terminal.handle);
        }
      }
      const handle = terminals.terminals.find((terminal) => observedHandles.has(terminal.handle))?.handle;
      if (handle === undefined) {
        return {
          ok: false,
          status: 'capability-missing',
          detail: '没有处于本地 host scope 内且 connected+writable 的终端句柄可用作协调身份',
        };
      }
      const binding = await backend.query({ operation: 'run-current', backendIdentityRef: handle });
      if (binding.kind !== 'accepted') {
        return stepFromRejection(binding.code, binding.message);
      }
      return {
        ok: true,
        value: handle,
      };
    },
    readPublicCommands: async () => {
      const commands: string[] = [];
      for (const group of Object.keys(REQUIRED_CLI_COMMANDS)) {
        const result = await runProcess({
          executable: environment.executable ?? 'orca',
          args: [group, '--help'],
          cwd: environment.cwd,
          env: environment.env,
          timeoutMs: 30_000,
          limits: { maxBytes: 256 * 1024, maxLines: 5_000 },
        });
        if (result.kind === 'unavailable') {
          return stepFromRejection(result.code, result.message);
        }
        if (result.kind === 'unknown') {
          return { ok: false, status: 'unreachable', detail: `${group} --help ${result.reason}` };
        }
        if (result.exitCode !== 0 || result.stdout.truncated) {
          return { ok: false, status: 'capability-missing', detail: `${group} --help 无法完整读取` };
        }
        for (const line of result.stdout.text.split('\n')) {
          const match = /^ {2}([a-z][a-z0-9-]+)\s{2,}/.exec(line);
          if (match?.[1] !== undefined) {
            commands.push(`${group} ${match[1]}`);
          }
        }
      }
      return { ok: true, value: commands };
    },
    // 显式给出 Coordinator 模型时以它为准（前台宿主已经解析过）。否则按 D03 自己从项目配置解析，
    // 走与启动完全相同的那条路径：同一个 chat-model 工厂、同一份 env-derived CredentialStore、同一套
    // 五项能力核验，因此 doctor 通过确实说明正式启动会拿到同一个模型。
    //
    // 未配置时不装配这一项：模型核验是「配置了就必查」，没有可核验的配置就不假装核验过、也不因此
    // 判定失败。配置存在但读不动、写坏、凭据解析不了或能力缺失都装配，并如实报 capability-missing
    // —— 这一项的失败状态沿用既有闭集，不为它新增 doctor 状态。
    ...(environment.coordinatorModel === undefined
      ? projectConfig.kind === 'absent'
        ? {}
        : projectConfig.kind === 'loaded'
          ? {
              readCoordinatorModel: () =>
                verifyConfiguredCoordinatorModel(projectConfig.config, credentials),
            }
          // 配置在但读不动或写坏：同样装配，让 doctor 如实报不可用。跳过会把「配错了」说成「没配」。
          : { readCoordinatorModel: () => Promise.resolve(unreadableConfigStep(projectConfig.message)) }
      : { readCoordinatorModel: environment.coordinatorModel.resolve }),
    readReadOnlyWorkers: async (): Promise<DoctorProbeStep<readonly ReadOnlyHarnessFacts[]>> => {
      // 按配置引用的每个角色核验模型、认证与受限执行能力，未配置的角色不假装核验过。
      if (projectConfig.kind === 'absent') {
        return { ok: true, value: [] };
      }
      if (projectConfig.kind === 'failed') {
        return { ok: false, status: 'capability-missing', detail: `项目配置无法使用：${projectConfig.message}` };
      }
      const profiles = MODEL_PROFILE_ROLES
        .map((role) => currentWorkerProfile(projectConfig.config, role))
        .filter((profile): profile is WorkerProfileConfiguration => profile !== null);
      if (profiles.length === 0) {
        return {
          ok: false,
          status: 'capability-missing',
          detail: '项目配置没有 Worker Profile：拿不到可证明的模型绑定',
        };
      }
      // 逐 profile 核验，不按 harness 合并：同一 harness 的两个 profile 可能带不同模型或认证来源，
      // 合并成一条会让其中一条不合法被另一条掩盖。harness 探针本身可以按 harness 复用结论。
      const facts: ReadOnlyHarnessFacts[] = [];
      const catalogs = new Map<string, string>();
      for (const profile of profiles) {
        let catalog = catalogs.get(profile.harness);
        if (catalog === undefined) {
          const result = await queryWorkerModels({ harness: profile.harness, cwd: environment.cwd, env: environment.env });
          catalog = result.kind === 'available'
            ? `原生模型目录可用（${result.models.length} 项）`
            : `原生模型目录不可用（${result.code}），可手填未验证模型 ID`;
          catalogs.set(profile.harness, catalog);
        }
        const fact = await probeConfiguredReadOnlyHarness(profile, environment.env);
        facts.push({ ...fact, detail: `${fact.detail}；${catalog}；精确 Session/runtime roots 由实际派发报告核验` });
      }
      return { ok: true, value: facts };
    },
  };
}
