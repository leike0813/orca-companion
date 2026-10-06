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
 * `codex` 用 `codex` 连接（LangChain wireApi/baseUrl）；其余四个用各自 harness 的原生 provider 连接，
 * 因此不能共用同一套 wireApi 描述。这里只给出身份，能力探测与启动绑定仍由 adapter 拥有。
 */
export const WORKER_HARNESS_IDS = ['codex', 'claude', 'opencode', 'pi', 'omp'] as const;
export type WorkerHarnessId = (typeof WORKER_HARNESS_IDS)[number];

/**
 * 原生连接声明的接口族。
 *
 * `claude` 只可能是 anthropic-messages；`opencode` 用它选择 SDK 的接口；`pi`/`omp` 接受原生取值。
 */
export const NATIVE_WORKER_APIS = ['anthropic-messages', 'openai-completions', 'openai-responses'] as const;
export type NativeWorkerApi = (typeof NATIVE_WORKER_APIS)[number];

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

/** 连接 URL 不得携带 userinfo 或凭据查询参数；两端连接（codex 与原生）共用同一条规则。 */
const credentialFreeUrl = z.url().refine((value) => !urlContainsCredentials(value), {
  message: '连接 URL 不得包含认证信息；请使用凭据引用',
});

export const effortCapabilitySchema = z.strictObject({
  values: z.array(identity).min(1).max(16).refine((values) => new Set(values).size === values.length),
  source: identity,
  optionPath,
});
export type EffortCapability = z.infer<typeof effortCapabilitySchema>;

/** providerId：harness 侧的 provider 标识，非空有界。 */
const nativeProviderId = z.string().min(1).max(256);

/**
 * Worker harness 的原生 provider 连接。
 *
 * 与 `codex` 连接互斥：codex 走 LangChain 的 wireApi/baseUrl，claude/opencode/pi/omp 走各自 harness
 * 的原生接口。`providerId` 必填；`baseUrl` 可选且不得携带认证信息；`api` 可选，claude 固定
 * anthropic-messages，opencode 用它选择 SDK 接口，pi/omp 接受原生取值。判别联合按 harness 收窄，
 * 每个 harness 只接受自己的字段与取值，未知 harness 或额外字段一律拒绝。
 */
export const nativeWorkerConnectionSchema = z.discriminatedUnion('harness', [
  z.strictObject({
    harness: z.literal('claude'),
    providerId: nativeProviderId,
    baseUrl: credentialFreeUrl.optional(),
    api: z.literal('anthropic-messages').optional(),
  }),
  z.strictObject({
    harness: z.literal('opencode'),
    providerId: nativeProviderId,
    baseUrl: credentialFreeUrl.optional(),
    api: z.enum(NATIVE_WORKER_APIS).optional(),
  }),
  z.strictObject({
    harness: z.literal('pi'),
    providerId: nativeProviderId,
    baseUrl: credentialFreeUrl.optional(),
    api: z.enum(NATIVE_WORKER_APIS).optional(),
  }),
  z.strictObject({
    harness: z.literal('omp'),
    providerId: nativeProviderId,
    baseUrl: credentialFreeUrl.optional(),
    api: z.enum(NATIVE_WORKER_APIS).optional(),
  }),
]);
export type NativeWorkerConnection = z.infer<typeof nativeWorkerConnectionSchema>;

export const providerConnectionSchema = z.strictObject({
  connectionRef: identity,
  label: identity,
  providerIntegration: identity,
  modelOptions: z.record(z.string(), z.unknown()),
  credential: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('harness_login') }),
    z.strictObject({ kind: z.literal('managed'), credentialRef: credentialReference, optionPath }),
  ]),
  codex: z.strictObject({
    providerId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
    baseUrl: credentialFreeUrl,
    wireApi: z.enum(['responses', 'chat']),
  }).nullable(),
  /**
   * 原生 Worker 连接；缺省保持缺省。
   *
   * 它是**附加**字段：旧的连接没有它，解析与序列化都不会凭空补出一个 key，因此旧配置的指纹不因
   * 这次扩展而改变。
   */
  nativeWorker: nativeWorkerConnectionSchema.optional(),
});
export type ProviderConnection = z.infer<typeof providerConnectionSchema>;

export const modelDefinitionSchema = z.strictObject({
  modelRef: identity,
  connectionRef: identity,
  model: identity,
  effortCapability: effortCapabilitySchema.nullable(),
});
export type ModelDefinition = z.infer<typeof modelDefinitionSchema>;

export const workerModelConfigurationSchema = z.strictObject({
  connection: providerConnectionSchema,
  modelRef: identity,
  model: identity,
  effort: identity.nullable(),
  effortCapability: effortCapabilitySchema.nullable(),
  modelOptions: z.record(z.string(), z.unknown()),
}).refine((value) => value.effort === null || value.effortCapability?.values.includes(value.effort) === true,
  { path: ['effort'], message: 'effort 缺少可信能力来源或超出支持范围' });
export type WorkerModelConfiguration = z.infer<typeof workerModelConfigurationSchema>;

export const MODEL_PROFILE_ROLES = ['planner', 'implementation', 'validator', 'finalizer', 'recovery_utility'] as const;
export type ModelProfileRole = (typeof MODEL_PROFILE_ROLES)[number];
export type ModelSettingsRole = 'coordinator' | ModelProfileRole;

export const workerProfileConfigurationSchema = z.strictObject({
  profileRef: identity,
  role: z.enum(MODEL_PROFILE_ROLES),
  harness: identity,
  modelConfiguration: workerModelConfigurationSchema,
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
