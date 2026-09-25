/**
 * IC-04 的项目级配置来源（Owner: `m1-wire-foreground-planning-runtime`，D1）。
 *
 * 配置是**用户维护、纳入版本控制**的长期设置：Coordinator Model Configuration 的闭集、默认引用、
 * tracker 地图引用、规划写入上限与上下文预算。它只保存凭据**引用**——凭据值由用户已安装的 provider
 * 集成按自己的方式取得，因此配置里根本没有落脚的地方；出现已知密钥字段名即拒绝整份配置。
 *
 * 读取只做边界校验，不解析 provider、不访问网络、不创建目录：不可用一律是显式拒绝，绝不退到
 * 「任选一个已安装模型」或隐式创建 Scope。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import type { CoordinatorModelConfiguration } from '../application/coordinator/model-config-switch.js';
import { CREDENTIAL_BEARING_FIELD_NAMES } from '../domain/coordinator/session-state.js';
import type { IdentityResult } from '../application/dto/identity.js';
import { DEFAULT_EXECUTION_LIMITS, type ExecutionLimits } from '../domain/planning/budget-policy.js';
import type {
  DependencyPolicy,
  RoleAuthorities,
} from '../domain/planning/execution-authorization.js';

export const PROJECT_CONFIG_FILENAME = 'orca-companion.json';

export const PROJECT_CONFIG_SCHEMA_VERSION = 1;

/** 项目级 tracker 引用；正文仍是 tracker 的事实，这里只有「读写哪张地图」。 */
export type ProjectTrackerConfiguration = {
  readonly kind: 'github';
  readonly routeMapIssueNumber: number;
};

/** 规划写入权限：每个 Scope 周期内允许的 tracker 副作用次数上限；0 表示只读规划。 */
export type ProjectPlanningPermissions = {
  readonly maxMutations: number;
};

/** 一次模型输入允许的上下文预算；压缩路径以它为准。 */
export type ProjectContextBudget = {
  readonly maxInputTokens: number;
};

/**
 * 执行授权的长期策略。
 *
 * 它是 Worker Profile、角色权限、预算上限与 Git/Dependency Policy 的**唯一长期来源**：Execution
 * Authorization Manifest 从它组装并绑定这些值，用户批准的完整 Manifest 才是某一次执行的授权事实。
 * 配置本身不构成授权，因此这里没有「已批准」这种状态；缺省值只用于组装，不会绕开批准。
 *
 * `workerModel` 是唯一无法从 Manifest 读回的值：Manifest 只绑定 Worker Profile 引用与 harness，
 * 具体模型属于长期设置，由它在派发时解析。
 */
export type ProjectExecutionConfiguration = {
  readonly harness: string;
  readonly workerModel: string | null;
  /**
   * Worker 角色级 Session 使用的 Codex 沙箱模式。
   *
   * `workspace-write` 是默认值：只允许写隔离 worktree。`danger-full-access` 只在宿主内核无法执行
   * Codex 的 Linux 沙箱时可用，且必须同时出现在 `acceptedRisks` 里（见 `CODEX_FULL_ACCESS_RISK`）——
   * 授权审阅会把它显示为已接受风险，因此放宽不会被悄悄引入。Finalizer 的只读模式不由它决定。
   */
  readonly codexSandbox: CodexSandboxMode;
  readonly permissions: RoleAuthorities;
  readonly limits: ExecutionLimits;
  readonly git: {
    readonly remotes: readonly string[];
    readonly refs: readonly string[];
  };
  readonly dependency: DependencyPolicy;
  readonly acceptedRisks: readonly string[];
};

/** Worker Session 可选的 Codex 沙箱模式；Finalizer 仍固定 `read-only`。 */
export const CODEX_SANDBOX_MODES = ['workspace-write', 'danger-full-access'] as const;

export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number];

/** 放宽 Worker 沙箱必须显式接受的具名风险；授权审阅把它当作 Manifest 的一部分呈现。 */
export const CODEX_FULL_ACCESS_RISK = 'codex-sandbox-danger-full-access';

export type ProjectConfig = {
  readonly schemaVersion: typeof PROJECT_CONFIG_SCHEMA_VERSION;
  readonly coordinatorModels: readonly CoordinatorModelConfiguration[];
  readonly defaultCoordinatorModelRef: string;
  readonly tracker: ProjectTrackerConfiguration;
  readonly planning: ProjectPlanningPermissions;
  readonly context: ProjectContextBudget;
  readonly execution: ProjectExecutionConfiguration;
};

/** 未显式配置执行策略时的组装默认值；每一项都会被完整 Manifest 与用户批准显式覆盖。 */
export const DEFAULT_PROJECT_EXECUTION: ProjectExecutionConfiguration = {
  harness: 'codex',
  workerModel: null,
  codexSandbox: 'workspace-write',
  permissions: {
    planner: true,
    implementation: true,
    validator: true,
    finalizer: true,
    gitIntegration: true,
    dependencyChanges: false,
  },
  limits: DEFAULT_EXECUTION_LIMITS,
  git: { remotes: [], refs: [] },
  dependency: { allowDependencyChanges: false, registry: null },
  acceptedRisks: [],
};

export type ProjectConfigFailureCode = 'missing' | 'unreadable' | 'invalid';

export type ProjectConfigLoadResult =
  | {
      readonly kind: 'loaded';
      readonly path: string;
      readonly config: ProjectConfig;
      /** 默认引用解析出的配置；已证明存在，因此调用方不需要再查一次。 */
      readonly defaultConfiguration: CoordinatorModelConfiguration;
    }
  | { readonly kind: 'failed'; readonly code: ProjectConfigFailureCode; readonly message: string };

export function projectConfigPath(worktreePath: string): string {
  return join(worktreePath, PROJECT_CONFIG_FILENAME);
}

const nonEmptyString = z.string().min(1);

const modelConfigurationSchema = z.strictObject({
  configurationRef: nonEmptyString,
  providerIntegration: nonEmptyString,
  model: nonEmptyString,
  modelOptions: z.record(z.string(), z.unknown()),
  credentialRefs: z.array(nonEmptyString),
  nativeWindowOwnerRef: nonEmptyString.nullable(),
});

const projectConfigSchema = z.strictObject({
  schemaVersion: z.literal(PROJECT_CONFIG_SCHEMA_VERSION),
  coordinatorModels: z.array(modelConfigurationSchema),
  defaultCoordinatorModelRef: nonEmptyString,
  tracker: z.strictObject({
    kind: z.literal('github'),
    routeMapIssueNumber: z.number().int().positive(),
  }),
  planning: z.strictObject({
    maxMutations: z.number().int().nonnegative(),
  }),
  context: z.strictObject({
    maxInputTokens: z.number().int().positive(),
  }),
  execution: z
    .strictObject({
      harness: nonEmptyString,
      workerModel: nonEmptyString.nullable(),
      codexSandbox: z.enum(CODEX_SANDBOX_MODES),
      permissions: z
        .strictObject({
          planner: z.boolean(),
          implementation: z.boolean(),
          validator: z.boolean(),
          finalizer: z.boolean(),
          gitIntegration: z.boolean(),
          dependencyChanges: z.boolean(),
        })
        .partial(),
      limits: z
        .strictObject({
          maxActiveWorkPackages: z.number().int().positive(),
          concurrencyLimit: z.number().int().positive(),
          implementationAttempts: z.number().int().positive(),
          validatorRepairs: z.number().int().positive(),
          graphRevisions: z.number().int().positive(),
          specificationRevisions: z.number().int().positive(),
          maxRecoveriesPerWorkerAttempt: z.number().int().positive(),
        })
        .partial(),
      git: z
        .strictObject({
          remotes: z.array(nonEmptyString),
          refs: z.array(nonEmptyString),
        })
        .partial(),
      dependency: z
        .strictObject({
          allowDependencyChanges: z.boolean(),
          registry: nonEmptyString.nullable(),
        })
        .partial(),
      acceptedRisks: z.array(nonEmptyString),
    })
    .partial()
    .optional(),
});

/** 把可选的执行策略补齐成完整值；缺失项取 `DEFAULT_PROJECT_EXECUTION`，不在这里做任何语义推断。 */
function normalizeExecution(
  raw: z.infer<typeof projectConfigSchema>['execution'],
): ProjectExecutionConfiguration {
  const base = DEFAULT_PROJECT_EXECUTION;
  return {
    harness: raw?.harness ?? base.harness,
    workerModel: raw?.workerModel ?? null,
    codexSandbox: raw?.codexSandbox ?? base.codexSandbox,
    permissions: {
      planner: raw?.permissions?.planner ?? base.permissions.planner,
      implementation: raw?.permissions?.implementation ?? base.permissions.implementation,
      validator: raw?.permissions?.validator ?? base.permissions.validator,
      finalizer: raw?.permissions?.finalizer ?? base.permissions.finalizer,
      gitIntegration: raw?.permissions?.gitIntegration ?? base.permissions.gitIntegration,
      dependencyChanges: raw?.permissions?.dependencyChanges ?? base.permissions.dependencyChanges,
    },
    limits: {
      maxActiveWorkPackages: raw?.limits?.maxActiveWorkPackages ?? base.limits.maxActiveWorkPackages,
      concurrencyLimit: raw?.limits?.concurrencyLimit ?? base.limits.concurrencyLimit,
      implementationAttempts: raw?.limits?.implementationAttempts ?? base.limits.implementationAttempts,
      validatorRepairs: raw?.limits?.validatorRepairs ?? base.limits.validatorRepairs,
      graphRevisions: raw?.limits?.graphRevisions ?? base.limits.graphRevisions,
      specificationRevisions: raw?.limits?.specificationRevisions ?? base.limits.specificationRevisions,
      maxRecoveriesPerWorkerAttempt:
        raw?.limits?.maxRecoveriesPerWorkerAttempt ?? base.limits.maxRecoveriesPerWorkerAttempt,
    },
    git: {
      remotes: raw?.git?.remotes ?? [],
      refs: raw?.git?.refs ?? [],
    },
    dependency: {
      allowDependencyChanges: raw?.dependency?.allowDependencyChanges ?? base.dependency.allowDependencyChanges,
      registry: raw?.dependency?.registry ?? base.dependency.registry,
    },
    acceptedRisks: raw?.acceptedRisks ?? [],
  };
}

/**
 * 在整份配置里查找已知密钥字段名。
 *
 * 顶层闭集已经排除了凭据的落脚点，这一层只处理一个现实风险：密钥被写进 `modelOptions` 或其它
 * 嵌套值里随配置进入版本控制。未列出的字段名不会被拒绝——这是封闭的安全边界，不是语义推断。
 */
function findCredentialField(value: unknown, path: string): string | null {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const found = findCredentialField(entry, `${path}.${index}`);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (CREDENTIAL_BEARING_FIELD_NAMES.has(key.toLowerCase())) {
      return `${path}.${key}`;
    }
    const found = findCredentialField(entry, `${path}.${key}`);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length === 0 ? '<root>' : issue.path.join('.')}: ${issue.message}`)
    .join('; ');
}

/**
 * 校验一份候选项目配置。
 *
 * 拒绝理由始终指向具体字段；默认引用不存在或 configurationRef 重复都按不可用处理，因为切换与恢复
 * 都需要「引用唯一」这个前提。
 */
export function parseProjectConfig(raw: unknown): IdentityResult<ProjectConfig> {
  const credentialField = findCredentialField(raw, 'projectConfig');
  if (credentialField !== null) {
    return { ok: false, field: credentialField, message: '项目配置只接受凭据引用，不接受凭据字段' };
  }
  const parsed = projectConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, field: 'projectConfig', message: describeIssues(parsed.error) };
  }
  const config: ProjectConfig = { ...parsed.data, execution: normalizeExecution(parsed.data.execution) };
  const refs = new Set<string>();
  for (const configuration of config.coordinatorModels) {
    if (refs.has(configuration.configurationRef)) {
      return {
        ok: false,
        field: 'projectConfig.coordinatorModels',
        message: `Coordinator Model Configuration 引用重复：${configuration.configurationRef}`,
      };
    }
    refs.add(configuration.configurationRef);
  }
  if (!refs.has(config.defaultCoordinatorModelRef)) {
    return {
      ok: false,
      field: 'projectConfig.defaultCoordinatorModelRef',
      message: `默认引用 ${config.defaultCoordinatorModelRef} 不在 coordinatorModels 中`,
    };
  }
  return { ok: true, value: config };
}

export function configurationByRef(
  config: ProjectConfig,
  configurationRef: string,
): CoordinatorModelConfiguration | null {
  return (
    config.coordinatorModels.find((configuration) => configuration.configurationRef === configurationRef) ??
    null
  );
}

export type LoadProjectConfigOptions = {
  readonly worktreePath: string;
  /** 覆盖点：测试注入读取实现；生产读取真实文件。 */
  readonly readFile?: (path: string) => string;
};

/**
 * 从 canonical worktree 根目录读取项目配置。
 *
 * 缺失与不可读都必须与「内容无效」区分开：前者说明仓库还没提供配置，后者说明配置写错了，
 * 两者给用户的动作不同。
 */
export function loadProjectConfig(options: LoadProjectConfigOptions): ProjectConfigLoadResult {
  const path = projectConfigPath(options.worktreePath);
  const read = options.readFile ?? ((target: string) => readFileSync(target, 'utf8'));
  let text: string;
  try {
    text = read(path);
  } catch (error) {
    const code = (error as { readonly code?: unknown }).code;
    return code === 'ENOENT'
      ? { kind: 'failed', code: 'missing', message: `未找到项目配置 ${path}` }
      : {
          kind: 'failed',
          code: 'unreadable',
          message: `无法读取项目配置 ${path}：${error instanceof Error ? error.message : String(error)}`,
        };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      kind: 'failed',
      code: 'invalid',
      message: `项目配置不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const parsed = parseProjectConfig(raw);
  if (!parsed.ok) {
    return { kind: 'failed', code: 'invalid', message: `${parsed.field}: ${parsed.message}` };
  }
  const defaultConfiguration = configurationByRef(parsed.value, parsed.value.defaultCoordinatorModelRef);
  if (defaultConfiguration === null) {
    // `parseProjectConfig` 已经证明它存在；这里只是把不变式带回类型系统。
    return {
      kind: 'failed',
      code: 'invalid',
      message: `默认引用 ${parsed.value.defaultCoordinatorModelRef} 无法解析`,
    };
  }
  return { kind: 'loaded', path, config: parsed.value, defaultConfiguration };
}
