/**
 * IP-5 / D8：`orca-companion doctor` 的环境与能力核验。
 *
 * 只读顺序固定为：可执行文件与版本 → `status --json` 的 runtime 可达性与必需能力 → `host list` 的本地
 * host → 协调身份可取得性（绑定型命令可用性）。任一失败即停止，不再继续后续检查，也绝不自动回退、
 * 伪造身份或绕过缺口。本模块不要求 TTY，也不加载 Ink/React。
 */

import { failureCategoryOf } from '../adapters/orca-cli/error-classification.js';
import { createOrcaExecutionBackend } from '../adapters/orca-cli/orca-backend.js';
import { runProcess } from '../adapters/orca-cli/process-runner.js';

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
  terminal: ['create', 'list', 'show', 'read', 'wait'],
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
  | 'public-commands';

export type DoctorCheck = {
  readonly id: DoctorCheckId;
  readonly status: DoctorStatus;
  readonly detail: string;
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

  return finish(version.value);
}

export type OrcaDoctorProbeEnvironment = {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly executable?: string;
  /** 显式指定的协调身份引用；缺省时使用刚核验过存活的活动终端句柄。 */
  readonly coordinatorIdentityRef?: string;
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
export function createOrcaDoctorProbe(environment: OrcaDoctorProbeEnvironment): DoctorProbe {
  const observedHandles = new Set<string>();
  const backend = createOrcaExecutionBackend({
    ...(environment.executable === undefined ? {} : { executable: environment.executable }),
    cwd: environment.cwd,
    env: environment.env,
    resolveIdentityHandle: (ref) => (observedHandles.has(ref) ? ref : undefined),
  });

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
      const listed = await backend.query({ operation: 'terminal-list' });
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
      const explicit = environment.coordinatorIdentityRef;
      const handle =
        explicit ?? terminals.terminals.find((terminal) => observedHandles.has(terminal.handle))?.handle;
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
        value:
          explicit === undefined
            ? '绑定型查询接受一个刚核验存活的活动终端句柄'
            : '绑定型查询接受指定的协调身份引用',
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
  };
}
