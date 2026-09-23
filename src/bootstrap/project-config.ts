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

export type ProjectConfig = {
  readonly schemaVersion: typeof PROJECT_CONFIG_SCHEMA_VERSION;
  readonly coordinatorModels: readonly CoordinatorModelConfiguration[];
  readonly defaultCoordinatorModelRef: string;
  readonly tracker: ProjectTrackerConfiguration;
  readonly planning: ProjectPlanningPermissions;
  readonly context: ProjectContextBudget;
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
});

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
  const config: ProjectConfig = parsed.data;
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
