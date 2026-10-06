import { z } from 'zod';

const identity = z.string().min(1).max(2048);

/**
 * 凭据引用只承认 CredentialStore 实际会发出的 UUID。
 *
 * 引用是不可变、不可解释的身份，不是一段自由文本。项目配置是纳入版本控制、且明确由用户手改的
 * 文件，引用一旦接受任意字符串，把明文 key 填进 `credentialRef` 就会随 commit 进入仓库；
 * store 侧本来也只承认 uuid（见 `credential-store.ts` 的条目 schema），两侧用同一条规则，
 * 边界才是闭合的。
 */
const credentialReference = z.uuid();
const optionPath = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/)
  .refine((path) => !path.split('.').some((part) => ['__proto__', 'prototype', 'constructor'].includes(part)));

/**
 * Companion 承认的 Worker harness 标识（唯一事实源）。
 *
 * harness 自己拥有模型、认证、provider endpoint 与真实会话：Companion 只登记身份，能力探测与启动绑定
 * 交给 adapter。这里不描述任何原生连接形状。
 */
export const WORKER_HARNESS_IDS = ['codex', 'claude', 'opencode', 'pi', 'omp'] as const;
export type WorkerHarnessId = (typeof WORKER_HARNESS_IDS)[number];

function urlContainsCredentials(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.username !== '' || url.password !== '' ||
    Array.from(url.searchParams.keys()).some(isModelOptionSecretKey);
}

/** effort 能力的取值集合：非空、有界、无重复。 */
const effortValues = z.array(identity).min(1).max(16)
  .refine((values) => new Set(values).size === values.length);

/**
 * Coordinator 的 effort 能力来源。
 *
 * `optionPath` 是 SDK options 里承载该 effort 的字段路径：Coordinator 由 Companion 组装 LangChain
 * 调用，必须显式描述；Worker 的 effort 由 harness 自身解释，没有可注入的 optionPath。
 */
export const effortCapabilitySchema = z.strictObject({
  values: effortValues,
  source: identity,
  optionPath,
});
export type EffortCapability = z.infer<typeof effortCapabilitySchema>;

/** Worker 的 effort 能力来源：只有取值与来源，没有 SDK optionPath。 */
export const workerEffortCapabilitySchema = z.strictObject({
  values: effortValues,
  source: identity,
});
export type WorkerEffortCapability = z.infer<typeof workerEffortCapabilitySchema>;

/**
 * Coordinator 的 provider 连接记录。
 *
 * Worker 的 provider 连接、endpoint 与凭据已交还 harness，这里只服务 Coordinator。`credential` 保留
 * `harness_login`（Coordinator provider integration 自身的环境认证路径，沿用旧命名）与 `managed`
 * （Companion 凭据引用）。
 */
export const providerConnectionSchema = z.strictObject({
  connectionRef: identity,
  label: identity,
  providerIntegration: identity,
  modelOptions: z.record(z.string(), z.unknown()),
  credential: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('harness_login') }),
    z.strictObject({ kind: z.literal('managed'), credentialRef: credentialReference, optionPath }),
  ]),
});
export type ProviderConnection = z.infer<typeof providerConnectionSchema>;

export const modelDefinitionSchema = z.strictObject({
  modelRef: identity,
  connectionRef: identity,
  model: identity,
  effortCapability: effortCapabilitySchema.nullable(),
});
export type ModelDefinition = z.infer<typeof modelDefinitionSchema>;

/**
 * Worker 的不可变模型选择。
 *
 * Worker 只按角色选择 harness、模型与 effort；连接、凭据与 provider options 由 harness 拥有，因此这里
 * 没有 connection/modelRef/modelOptions/credentialRef。`catalogSource` 是原生目录查询的来源标识；
 * `null` 表示用户手填的未验证 native exact ID，此时 effort 必须为 null。`effortCapability` 非空则
 * 必须有目录来源，非 null 的 effort 必须落在能力取值内。
 */
export const workerModelSelectionSchema = z
  .strictObject({
    model: identity,
    effort: identity.nullable(),
    effortCapability: workerEffortCapabilitySchema.nullable(),
    catalogSource: identity.nullable(),
  })
  .refine((value) => value.effortCapability === null || value.catalogSource !== null, {
    path: ['catalogSource'],
    message: '有可信 effort 能力来源时必须声明目录来源',
  })
  .refine((value) => value.effort === null || value.effortCapability?.values.includes(value.effort) === true, {
    path: ['effort'],
    message: 'effort 缺少可信能力来源或超出支持范围',
  });
export type WorkerModelSelection = z.infer<typeof workerModelSelectionSchema>;

export const MODEL_PROFILE_ROLES = ['planner', 'implementation', 'validator', 'finalizer', 'recovery_utility'] as const;
export type ModelProfileRole = (typeof MODEL_PROFILE_ROLES)[number];
export type ModelSettingsRole = 'coordinator' | ModelProfileRole;

export const workerProfileConfigurationSchema = z.strictObject({
  profileRef: identity,
  role: z.enum(MODEL_PROFILE_ROLES),
  harness: z.enum(WORKER_HARNESS_IDS),
  modelSelection: workerModelSelectionSchema,
});
export type WorkerProfileConfiguration = z.infer<typeof workerProfileConfigurationSchema>;

/** Set an explicitly configured SDK option; never interpret provider names. */
export function withModelOption(options: Readonly<Record<string, unknown>>, path: string, value: unknown): Record<string, unknown> {
  if (!optionPath.safeParse(path).success) throw new Error('invalid_model_option_path');
  const result: Record<string, unknown> = { ...options };
  let cursor = result;
  const parts = path.split('.');
  for (const part of parts.slice(0, -1)) {
    const existing = cursor[part];
    const next: Record<string, unknown> = typeof existing === 'object' && existing !== null && !Array.isArray(existing)
      ? { ...existing as Record<string, unknown> } : {};
    cursor[part] = next;
    cursor = next;
  }
  const last = parts.at(-1);
  if (last !== undefined) cursor[last] = value;
  return result;
}

/**
 * 模型选项里的凭据字段名判定（唯一事实源）。
 *
 * provider options 的键名由集成决定，没有可信的值形态可依赖，因此只能按键名判定。归一化（小写并
 * 去掉 `-`/`_`/空格）后分两类：精确集合覆盖 `apiKey`、`bearer_token`、`x-api-key`、`client_secret`
 * 这类常见拼法；后缀集合只收**不会与规模类选项混淆**的词根，于是 `openaiApiKey`、`refresh_token`
 * 仍然命中，而 `maxTokens`、`inputTokens`、`tokenBudget` 不会被误杀。
 *
 * `credentialRef` 这类身份字段刻意不在任何一侧：秘密的合法载体只有 `credential.credentialRef`，
 * 记录里出现引用不是泄露。
 */
const SECRET_OPTION_KEY_NAMES: ReadonlySet<string> = new Set([
  'apikey',
  'apikeyid',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'sessiontoken',
  'authtoken',
  'authorization',
  'bearer',
  'bearertoken',
  'secret',
  'secretkey',
  'token',
  'password',
  'passphrase',
  'credential',
  'credentials',
  'privatekey',
]);

const SECRET_OPTION_KEY_SUFFIXES: readonly string[] = [
  'apikey',
  'secretkey',
  'privatekey',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'sessiontoken',
  'authtoken',
  'apitoken',
  'bearertoken',
  'clientsecret',
  'authorization',
  'bearer',
  'secret',
  'password',
  'passphrase',
];

/** 键名归一化：大小写与分隔符不改变字段的语义。 */
function normalizeOptionKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, '');
}

/** `modelOptions` 里的这个键是否承载明文秘密。 */
export function isModelOptionSecretKey(key: string): boolean {
  const normalized = normalizeOptionKey(key);
  if (SECRET_OPTION_KEY_NAMES.has(normalized)) {
    return true;
  }
  return SECRET_OPTION_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

export type ModelOptionFieldScan =
  | { readonly kind: 'clean' }
  | { readonly kind: 'credential_field'; readonly path: string }
  | { readonly kind: 'unbounded' };

/** Scan options at every boundary; structured records only open their modelOptions fields. */
export function scanModelOptionFields(
  value: unknown,
  path: string,
  optionsOnly = false,
): ModelOptionFieldScan {
  const ancestors = new Set<object>();
  function visit(entry: unknown, location: string, freeForm: boolean, depth: number): ModelOptionFieldScan {
    if (freeForm && typeof entry === 'string' && urlContainsCredentials(entry)) {
      return { kind: 'credential_field', path: location };
    }
    if (entry === null || typeof entry !== 'object') return { kind: 'clean' };
    if (depth > 32 || ancestors.has(entry)) return { kind: 'unbounded' };
    ancestors.add(entry);
    try {
      for (const [key, nested] of Object.entries(entry)) {
        const nestedPath = `${location}.${key}`;
        if (!Array.isArray(entry) && freeForm && isModelOptionSecretKey(key)) {
          return { kind: 'credential_field', path: nestedPath };
        }
        const found = visit(nested, nestedPath, freeForm || key === 'modelOptions', depth + 1);
        if (found.kind !== 'clean') return found;
      }
      return { kind: 'clean' };
    } finally {
      ancestors.delete(entry);
    }
  }
  return visit(value, path, !optionsOnly, 0);
}

/** 结构比较的深度上限：越界一律按「不相等」处理，循环结构因此不会递归到栈溢出。 */
const MAX_COMPARE_DEPTH = 64;

/** 键序无关的结构序列化；`undefined` 成员按缺省处理，与 JSON 落盘结果一致。 */
function stableStructure(value: unknown, depth: number): string | null {
  if (depth > MAX_COMPARE_DEPTH) {
    return null;
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    const members: string[] = [];
    for (const entry of value) {
      const member = stableStructure(entry, depth + 1);
      if (member === null) {
        return null;
      }
      members.push(member);
    }
    return `[${members.join(',')}]`;
  }
  const members: string[] = [];
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  for (const [key, entry] of entries) {
    const member = stableStructure(entry, depth + 1);
    if (member === null) {
      return null;
    }
    members.push(`${JSON.stringify(key)}:${member}`);
  }
  return `{${members.join(',')}}`;
}

/**
 * 结构相等：只比较内容，键的插入顺序不影响结果。
 *
 * 快照与被引用记录的比对依赖它——同一份配置由不同的人手写，键序不同但语义相同时必须判为一致，
 * 否则会把无害的排版差异当成篡改。深度越界返回 `false`（判为不一致），不做猜测。
 */
export function semanticEqual(left: unknown, right: unknown): boolean {
  const structure = stableStructure(left, 0);
  return structure !== null && structure === stableStructure(right, 0);
}
