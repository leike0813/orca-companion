/**
 * IC-04/IC-05 的项目级配置来源（Owner: `complete-tui-model-configuration` IP-01，D01）。
 *
 * 配置是**用户维护、纳入版本控制**的长期设置：provider 连接、模型、Coordinator configurations、
 * 默认引用、角色 Worker Profiles、tracker 地图引用、规划写入上限与上下文/输出预算。
 *
 * 它只保存凭据**引用**：明文 key 属于用户级 CredentialStore，这里没有落脚点，出现已知密钥字段名即
 * 拒绝整份配置。schema 3 把模型设置表达为「不可变记录 + 显式引用」，并把执行额度收敛为
 * `maxActiveWorkPackages`（并行包，默认 3）、`maxWorkPackages`（图容量，默认 8）与
 * `integrationReconciliations`（集成复验，默认 2）：编辑只能追加新引用并推进 `revision`，
 * 旧记录不改写，因此已批准的 Manifest 与在途 Task 仍能按原引用读回当时的配置。
 *
 * 读取只做边界校验，不解析 provider、不访问网络、不创建目录：不可用一律是显式拒绝，绝不退到
 * 「任选一个已安装模型」或隐式创建 Scope。旧 schemaVersion 明确拒绝，不自动重写用户项目。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { CONTEXT_READ_BYTES, MODEL_RESPONSE_BYTES } from '../coordinator/history.js';
import {
  coordinatorModelConfigurationSchema,
  type CoordinatorModelConfiguration,
} from '../coordinator/model-config-switch.js';
import type { IdentityFailure, IdentityResult } from '../dto/identity.js';
import {
  MODEL_PROFILE_ROLES,
  scanModelOptionFields,
  modelDefinitionSchema,
  providerConnectionSchema,
  semanticEqual,
  workerProfileConfigurationSchema,
  type ModelDefinition,
  type ModelProfileRole,
  type ProviderConnection,
  type WorkerProfileConfiguration,
} from '../../domain/model-configuration.js';
import { DEFAULT_EXECUTION_LIMITS, type ExecutionLimits } from '../../domain/planning/budget-policy.js';
import type { DependencyPolicy, RoleAuthorities } from '../../domain/planning/execution-authorization.js';

export const PROJECT_CONFIG_FILENAME = 'orca-companion.json';

export const PROJECT_CONFIG_SCHEMA_VERSION = 3;

/** 项目级 tracker 引用；正文仍是 tracker 的事实，这里只有「读写哪张地图」。 */
export type ProjectTrackerConfiguration = {
  readonly kind: 'github';
  readonly routeMapIssueNumber: number;
};

/** 规划写入权限：每个 Scope 周期内允许的 tracker 副作用次数上限；0 表示只读规划。 */
export type ProjectPlanningPermissions = {
  readonly maxMutations: number;
};

/**
 * 一次模型输入允许的上下文预算。
 *
 * `maxInputTokens` 是压缩路径的 token 预算；`maxReadBytes` 是同一份有效上下文允许读回的字节上限。
 * token 数决定是否需要压缩，字节数决定存储读取是否还能有界完成——压缩后仍然超出的历史按
 * `context_exhausted` 阻塞，而不是裁剪原文。
 */
export type ProjectContextBudget = {
  readonly maxInputTokens: number;
  readonly maxReadBytes: number;
};

/** 一次模型输出允许的字节上限；覆盖文本、内容块与工具参数。 */
export type ProjectOutputBudget = {
  readonly maxResponseBytes: number;
};

/**
 * 执行授权的长期策略。
 *
 * 它是 Worker Profile、角色权限、预算上限与 Git/Dependency Policy 的**唯一长期来源**：Execution
 * Authorization Manifest 从它组装并绑定这些值，用户批准的完整 Manifest 才是某一次执行的授权事实。
 * 配置本身不构成授权，因此这里没有「已批准」这种状态；缺省值只用于组装，不会绕开批准。
 */
export type ProjectExecutionConfiguration = {
  readonly harness: string;
  /**
   * 角色模型设置的历史全集；每条都是不可变记录，保存新设置只追加不替换。
   *
   * 纯规划 Scope 可以为空：没有 Worker Profile 就不存在 Worker Model Configuration，四个生产角色
   * 齐备与否是执行授权阶段的要求。
   */
  readonly workerProfiles: readonly WorkerProfileConfiguration[];
  /** 角色当前选择的 profile 引用；这是「当前用哪一条」的唯一来源，与历史记录分开表达。 */
  readonly workerProfileRefs: Partial<Record<ModelProfileRole, string>>;
  /**
   * Worker 角色级 Session 使用的 Codex 沙箱模式。
   *
   * `workspace-write` 是默认值：只允许写隔离 worktree。`danger-full-access` 只在宿主内核无法执行
   * Codex 的 Linux 沙箱时可用，且必须同时出现在 `acceptedRisks` 里（见 `CODEX_FULL_ACCESS_RISK`）。
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
  /**
   * 项目配置的 CAS 计数，由存储在锁内推进；用户手工编辑后自然会与调用方的读数冲突。
   * 缺省按 0 处理，兼容还没有保存过模型设置的项目。
   */
  readonly revision: number;
  readonly providerConnections: readonly ProviderConnection[];
  readonly models: readonly ModelDefinition[];
  readonly coordinatorModels: readonly CoordinatorModelConfiguration[];
  readonly defaultCoordinatorModelRef: string;
  readonly tracker: ProjectTrackerConfiguration;
  readonly planning: ProjectPlanningPermissions;
  readonly context: ProjectContextBudget;
  readonly output: ProjectOutputBudget;
  readonly execution: ProjectExecutionConfiguration;
};

/** 未显式配置执行策略时的组装默认值；每一项都会被完整 Manifest 与用户批准显式覆盖。 */
export const DEFAULT_PROJECT_EXECUTION: ProjectExecutionConfiguration = {
  harness: 'codex',
  workerProfiles: [],
  workerProfileRefs: {},
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

/** 有限正安全整数：预算越界会让读取无界或模型响应无界，因此不接受 0、负数、小数与溢出值。 */
const byteBudget = z.number().int().positive().safe();

const projectConfigSchema = z.strictObject({
  schemaVersion: z.literal(PROJECT_CONFIG_SCHEMA_VERSION),
  revision: z.number().int().nonnegative().safe().optional(),
  providerConnections: z.array(providerConnectionSchema).optional(),
  models: z.array(modelDefinitionSchema).optional(),
  coordinatorModels: z.array(coordinatorModelConfigurationSchema),
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
    maxReadBytes: byteBudget.optional(),
  }),
  output: z.strictObject({ maxResponseBytes: byteBudget }).optional(),
  execution: z
    .strictObject({
      harness: nonEmptyString,
      workerProfiles: z.array(workerProfileConfigurationSchema).optional(),
      // 角色选择是稀疏的：zod 4 的 record 会要求枚举键齐全，因此这里显式声明为可缺省。
      workerProfileRefs: z.partialRecord(z.enum(MODEL_PROFILE_ROLES), nonEmptyString).optional(),
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
          maxActiveWorkPackages: z.number().int().positive().safe(),
          maxWorkPackages: z.number().int().positive().safe(),
          integrationReconciliations: z.number().int().positive().safe(),
          implementationAttempts: z.number().int().positive().safe(),
          validatorRepairs: z.number().int().positive().safe(),
          graphRevisions: z.number().int().positive().safe(),
          specificationRevisions: z.number().int().positive().safe(),
          maxRecoveriesPerWorkerAttempt: z.number().int().positive().safe(),
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
    workerProfiles: raw?.workerProfiles ?? base.workerProfiles,
    workerProfileRefs: { ...raw?.workerProfileRefs },
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
      maxWorkPackages: raw?.limits?.maxWorkPackages ?? base.limits.maxWorkPackages,
      integrationReconciliations:
        raw?.limits?.integrationReconciliations ?? base.limits.integrationReconciliations,
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
 * 在候选配置的自由值口袋里查找已知密钥字段名。
 *
 * v2 的 schema 是闭合的：除 `modelOptions`（`Record<string, unknown>`）外没有任意值能落进来，
 * 未声明的字段由 strict schema 直接拒绝。`modelOptions` 内部扫描密钥字段和带凭据的 URL，
 * 连接的 `codex.baseUrl` 由领域 schema 校验；`credential` 这类结构字段不会被误判成密钥。
 * 判定复用领域层，因此项目配置边界与授权边界是同一套规则。
 *
 * `freeForm` 只在进入 `modelOptions` 后为真，闭合结构照常递归以定位到具体路径。
 *
 * 遍历只跟踪**当前路径上的祖先**：同一对象在两个分支里各出现一次是正常的共享（例如连接记录与它
 * 的快照），只有真正的回指才是循环。祖先重复或超过深度上限时无法证明其中没有密钥字段，按
 * `unbounded` 交由调用方拒绝，而不是递归到栈溢出。
 */
/**
 * 对**尚未落盘**的候选执行同一密钥字段检查。
 *
 * 保存路径必须在写凭据之前调用它：一个把 key 写进 `modelOptions` 的候选应当在任何文件被改动之前
 * 就被拒绝，而不是先留下一个孤立凭据。
 */
export function scanCredentialBearingFields(raw: unknown, root = 'projectConfig') {
  return scanModelOptionFields(raw, root, true);
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length === 0 ? '<root>' : issue.path.join('.')}: ${issue.message}`)
    .join('; ');
}

/**
 * 核验「记录 + 引用」之间的交叉关系。
 *
 * Coordinator configuration 与 Worker Profile 都是**快照**：各自复制 provider、model、options 与
 * 能力来源，好让已批准的授权和在途 Task 不必回查配置。快照一旦与被引用的记录矛盾，说明有人手改过
 * 其中一边；此时只有 fail closed 一条路，因为「以哪边为准」没有任何可信依据。
 *
 * effort 是唯一不能猜的字段：没有可信能力来源、来源里没有这个取值，都按拒绝处理。
 */
function validateReferences(config: ProjectConfig): IdentityFailure | null {
  const connections = new Map<string, ProviderConnection>();
  for (const connection of config.providerConnections) {
    if (connections.has(connection.connectionRef)) {
      return {
        ok: false,
        field: 'projectConfig.providerConnections',
        message: `Provider Connection 引用重复：${connection.connectionRef}`,
      };
    }
    connections.set(connection.connectionRef, connection);
  }

  const models = new Map<string, ModelDefinition>();
  for (const model of config.models) {
    if (models.has(model.modelRef)) {
      return { ok: false, field: 'projectConfig.models', message: `Model 引用重复：${model.modelRef}` };
    }
    if (!connections.has(model.connectionRef)) {
      return {
        ok: false,
        field: `projectConfig.models.${model.modelRef}`,
        message: `引用的 Provider Connection 不存在：${model.connectionRef}`,
      };
    }
    models.set(model.modelRef, model);
  }

  const configurationRefs = new Set<string>();
  for (const configuration of config.coordinatorModels) {
    const field = `projectConfig.coordinatorModels.${configuration.configurationRef}`;
    if (configurationRefs.has(configuration.configurationRef)) {
      return {
        ok: false,
        field: 'projectConfig.coordinatorModels',
        message: `Coordinator Model Configuration 引用重复：${configuration.configurationRef}`,
      };
    }
    configurationRefs.add(configuration.configurationRef);

    let connection: ProviderConnection | null = null;
    if (configuration.providerConnection !== undefined) {
      const snapshot = configuration.providerConnection;
      const found = connections.get(snapshot.connectionRef);
      if (found === undefined) {
        return {
          ok: false,
          field,
          message: `引用的 Provider Connection 不存在：${snapshot.connectionRef}`,
        };
      }
      connection = found;
      if (!semanticEqual(snapshot, found)) {
        return {
          ok: false,
          field: `${field}.providerConnection`,
          message: `与所引用的 Provider Connection 不一致：${snapshot.connectionRef}`,
        };
      }
      if (connection.providerIntegration !== configuration.providerIntegration) {
        return {
          ok: false,
          field: `${field}.providerIntegration`,
          message: `与所引用的 Provider Connection 不一致：${connection.providerIntegration}`,
        };
      }
      if (
        connection.credential.kind === 'managed' &&
        !configuration.credentialRefs.includes(connection.credential.credentialRef)
      ) {
        return {
          ok: false,
          field: `${field}.credentialRefs`,
          message: `缺少所引用连接的凭据引用：${connection.credential.credentialRef}`,
        };
      }
    }

    let model: ModelDefinition | null = null;
    if (configuration.modelRef !== undefined) {
      const found = models.get(configuration.modelRef);
      if (found === undefined) {
        return { ok: false, field, message: `引用的 Model 不存在：${configuration.modelRef}` };
      }
      model = found;
      if (connection === null) {
        return {
          ok: false,
          field: `${field}.providerConnection`,
          message: '引用 Model 时必须同时携带其 Provider Connection 快照',
        };
      }
      if (model.connectionRef !== connection.connectionRef) {
        return {
          ok: false,
          field,
          message: `与所引用的 Model 不一致：${configuration.modelRef}`,
        };
      }
      if (model.model !== configuration.model) {
        return { ok: false, field, message: `与所引用的 Model 不一致：${configuration.modelRef}` };
      }
      if (
        configuration.effortCapability !== undefined &&
        !semanticEqual(configuration.effortCapability, model.effortCapability)
      ) {
        return {
          ok: false,
          field: `${field}.effortCapability`,
          message: `与所引用的 Model 能力来源不一致：${configuration.modelRef}`,
        };
      }
    }

    const capability = configuration.effortCapability ?? model?.effortCapability ?? null;
    if (
      configuration.effort !== undefined &&
      configuration.effort !== null &&
      (capability === null || !capability.values.includes(configuration.effort))
    ) {
      return { ok: false, field: `${field}.effort`, message: 'effort 缺少可信能力来源或超出支持范围' };
    }
  }

  if (!configurationRefs.has(config.defaultCoordinatorModelRef)) {
    return {
      ok: false,
      field: 'projectConfig.defaultCoordinatorModelRef',
      message: `默认引用 ${config.defaultCoordinatorModelRef} 不在 coordinatorModels 中`,
    };
  }

  const profiles = new Map<string, WorkerProfileConfiguration>();
  for (const profile of config.execution.workerProfiles) {
    const field = `projectConfig.execution.workerProfiles.${profile.profileRef}`;
    if (profiles.has(profile.profileRef)) {
      return {
        ok: false,
        field: 'projectConfig.execution.workerProfiles',
        message: `Worker Profile 引用重复：${profile.profileRef}`,
      };
    }
    const connectionRef = profile.modelConfiguration.connection.connectionRef;
    const connection = connections.get(connectionRef);
    if (connection === undefined) {
      return {
        ok: false,
        field: `${field}.modelConfiguration.connection`,
        message: `引用的 Provider Connection 不存在：${connectionRef}`,
      };
    }
    // Profile 的连接与 Coordinator 一样是快照：与记录矛盾说明两边被分别改过，只能 fail closed。
    if (!semanticEqual(profile.modelConfiguration.connection, connection)) {
      return {
        ok: false,
        field: `${field}.modelConfiguration.connection`,
        message: `与所引用的 Provider Connection 不一致：${connectionRef}`,
      };
    }
    const model = models.get(profile.modelConfiguration.modelRef);
    if (model === undefined) {
      return {
        ok: false,
        field,
        message: `引用的 Model 不存在：${profile.modelConfiguration.modelRef}`,
      };
    }
    if (model.connectionRef !== connectionRef || model.model !== profile.modelConfiguration.model) {
      return {
        ok: false,
        field,
        message: `与所引用的 Model 不一致：${profile.modelConfiguration.modelRef}`,
      };
    }
    // 只在 Profile 声明了能力来源时核对：凭空多出来的取值比少声明更危险。
    const capability = profile.modelConfiguration.effortCapability;
    if (capability !== null && !semanticEqual(capability, model.effortCapability)) {
      return {
        ok: false,
        field: `${field}.modelConfiguration.effortCapability`,
        message: `与所引用的 Model 能力来源不一致：${profile.modelConfiguration.modelRef}`,
      };
    }
    profiles.set(profile.profileRef, profile);
  }

  for (const [role, profileRef] of Object.entries(config.execution.workerProfileRefs)) {
    const profile = profiles.get(profileRef);
    if (profile === undefined) {
      return {
        ok: false,
        field: `projectConfig.execution.workerProfileRefs.${role}`,
        message: `当前选择的 Worker Profile 不存在：${profileRef}`,
      };
    }
    if (profile.role !== role) {
      return {
        ok: false,
        field: `projectConfig.execution.workerProfileRefs.${role}`,
        message: `所选 Worker Profile 的角色是 ${profile.role}`,
      };
    }
  }
  return null;
}

/**
 * 校验一份候选项目配置。
 *
 * 拒绝理由始终指向具体字段；默认引用不存在、引用重复或交叉引用不一致都按不可用处理，因为切换、恢复
 * 与授权组装都需要「引用唯一且可解释」这个前提。
 */
export function parseProjectConfig(raw: unknown): IdentityResult<ProjectConfig> {
  const parsed = projectConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, field: 'projectConfig', message: describeIssues(parsed.error) };
  }
  // 读取与输出预算缺省时取应用层的同一组界限，避免配置默认值与运行时界限各自漂移。
  const config: ProjectConfig = {
    ...parsed.data,
    revision: parsed.data.revision ?? 0,
    providerConnections: parsed.data.providerConnections ?? [],
    models: parsed.data.models ?? [],
    context: {
      maxInputTokens: parsed.data.context.maxInputTokens,
      maxReadBytes: parsed.data.context.maxReadBytes ?? CONTEXT_READ_BYTES,
    },
    output: parsed.data.output ?? { maxResponseBytes: MODEL_RESPONSE_BYTES },
    execution: normalizeExecution(parsed.data.execution),
  };
  // 先于交叉引用核验：密钥字段的位置对用户更有指向性，也保证「配置里没有秘密」是前置事实。
  const scan = scanCredentialBearingFields(config);
  if (scan.kind === 'credential_field') {
    return { ok: false, field: scan.path, message: '项目配置只接受凭据引用，不接受凭据字段' };
  }
  if (scan.kind === 'unbounded') {
    return { ok: false, field: 'projectConfig', message: '项目配置结构循环或过深，无法确认其中没有凭据字段' };
  }
  return validateReferences(config) ?? { ok: true, value: config };
}

export function configurationByRef(
  config: ProjectConfig,
  configurationRef: string,
): CoordinatorModelConfiguration | null {
  return (
    config.coordinatorModels.find((configuration) => configuration.configurationRef === configurationRef) ?? null
  );
}

/** 角色当前选择的 Worker Profile；未配置时返回 null，纯规划 Scope 属于正常情况。 */
export function currentWorkerProfile(
  config: ProjectConfig,
  role: ModelProfileRole,
): WorkerProfileConfiguration | null {
  const profileRef = config.execution.workerProfileRefs[role];
  if (profileRef === undefined) {
    return null;
  }
  return config.execution.workerProfiles.find((profile) => profile.profileRef === profileRef) ?? null;
}

export type LoadProjectConfigOptions = {
  readonly worktreePath: string;
  /** 覆盖点：测试注入读取实现；生产读取真实文件。 */
  readonly readFile?: (path: string) => string;
};

/**
 * 从 canonical worktree 根目录读取项目配置。
 *
 * 缺失与不可读都必须与「内容无效」区分开：前者说明仓库还没提供配置，后者说明配置写错了，两者给
 * 用户的动作不同。
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
