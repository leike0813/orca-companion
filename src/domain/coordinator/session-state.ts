/**
 * IC-04：Coordinator Session State 的领域类型与边界校验
 * （Owner: `m1-run-coordinator-sessions`；`m1-wire-foreground-planning-runtime` 升为 v2）。
 *
 * 这个模块只描述一个 Session 自己拥有的会话事实：已提交的消息条目与 model step、图位置、
 * 已注入的 Wake Batch、两类上下文压缩产物，以及最近一次维护结论。它刻意不携带任何可从别处重建的
 * 内容——provider 凭据属于用户配置，Orca 运行事实属于 Orca，Route Map 属于 tracker，把它们复制进
 * checkpoint 只会产生第二份真值（`CONTEXT.md`「Coordinator Session State」）。
 *
 * v2 增加的是「每条已提交消息有稳定 entryId 与所属 step」这一层：只有它才能让工具调用与结果按原
 * call 身份配对、让上下文片段按 step 边界重组，也才能让 v1 历史在不丢消息的前提下升级。
 *
 * 校验是闭集：顶层与各嵌套记录的字段集合固定，未声明字段一律拒绝。这样「不含凭据与外部事实」
 * 不需要靠字段名黑名单来猜——凭据根本没有落脚的位置。
 */

import {
  parseStableId,
  type CoordinatorSessionId,
  type IdentityResult,
  type OperationId,
} from '../../application/dto/identity.js';

export type { CoordinatorSessionId };

/** Session 状态的 schema 版本；读取时版本不符即拒绝，不猜测旧形状。 */
export const COORDINATOR_SESSION_STATE_SCHEMA_VERSION = 2;

/** 前驱版本写入的 payload 版本；读取时按可证明唯一的规则升级到 v2。 */
export const LEGACY_SESSION_STATE_SCHEMA_VERSION = 1;

/** checkpoint thread 前缀：让 Session ID 到 `thread_id` 的映射显式且不可与其它用途混用。 */
export const CHECKPOINT_THREAD_PREFIX = 'coordinator-session:';

/** provider 报告的 usage；未取得时保留 `null`，不做估算。 */
export type ModelUsageObservation = {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
};

/**
 * 会话历史里消息的持久化角色闭集。
 *
 * 这是 Companion 自己拥有的词表：provider 与 LangChain 的拼写不同（`ai` 与 `assistant`、
 * `human` 与 `user`），如果直接把 provider 对象存进 checkpoint，重开之后就再也读不出角色。
 */
export const DURABLE_MESSAGE_ROLES = ['system', 'user', 'assistant', 'tool'] as const;

export type DurableMessageRole = (typeof DURABLE_MESSAGE_ROLES)[number];

/**
 * 一次受控工具调用的可信身份。
 *
 * `operationId`（以及 `resolve_ticket` 的 `mapOperationId`）由宿主在提交模型响应时分配，模型不可
 * 填写：它是「这次外部副作用是否已经发起过」的唯一凭据，换一个 ID 重试就等于允许重复副作用。
 */
export type CommittedToolCall = {
  readonly callId: string;
  readonly name: string;
  readonly args: unknown;
  /** 主操作的 OperationId。 */
  readonly operationId: OperationId;
  /** 该 call 触发的第二次独立副作用（`resolve_ticket` 的地图写入）；没有时为 `null`。 */
  readonly mapOperationId: OperationId | null;
};

/**
 * 一条已提交的会话消息。
 *
 * `entryId` 让「同一条消息」在任何进程、任何重放下都有稳定身份；`stepId` 让工具结果与产生它的
 * 模型响应归到同一个片段，上下文维护因此可以按 step 边界重组而不必猜消息属于哪一回合。
 */
export type CommittedMessageEntry = {
  readonly entryId: string;
  readonly stepId: string;
  readonly role: DurableMessageRole;
  readonly content: string;
  /** 仅 assistant：已校验并带可信 operation 身份的 tool calls。 */
  readonly toolCalls?: readonly CommittedToolCall[];
  /** 仅 tool：被回答的 call 身份与工具名。 */
  readonly toolCallId?: string;
  readonly toolName?: string;
};

/**
 * 一次原子接受的 Coordinator Agent 响应（`CONTEXT.md`「Committed Model Step」）。
 *
 * `messages` 是完整响应；`toolCalls` 是它的标准化调用清单。流式草稿永远不构造这个值，因此
 * 「未完整提交的响应」在类型上就没有进入历史的入口。
 */
export type CommittedModelStep = {
  readonly stepId: string;
  /** 该响应在 `committedMessages` 中的条目身份。 */
  readonly entryId: string;
  readonly committedAt: number;
  readonly messages: readonly unknown[];
  readonly toolCalls: readonly CommittedToolCall[];
  readonly usage: ModelUsageObservation | null;
};

/** Authoritative Fact 或 Control Record 的稳定引用；不复制 Delivery 正文或外部记录。 */
export type SourceRevisionRef = {
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly revision: number;
};

/** 需要 Coordinator 判断或模型可见动作的工作引用。 */
export type ActionableWorkRef = {
  readonly workKind: string;
  readonly workId: string;
  readonly summary: string;
};

/** 一次模型恢复的准入记录（`CONTEXT.md`「Wake Batch」）。 */
export type WakeBatch = {
  readonly wakeBatchId: string;
  readonly coordinationScopeId: string;
  readonly coordinatorSessionId: string;
  readonly sourceRevisions: readonly SourceRevisionRef[];
  readonly actionableWork: readonly ActionableWorkRef[];
};

/**
 * provider 原生压缩项：身份与位置由 Companion 记录，内容保持不透明。
 * 后续请求逐字携带，Companion 不解析、不改写、不据其内容改动 Session 状态。
 */
export type NativeWindowItemRef = {
  readonly itemId: string;
  readonly position: number;
  readonly mediaType: string;
  readonly opaque: unknown;
};

/** Native Compacted Window 的 owner metadata：绑定 provider 身份与代际。 */
export type NativeCompactedWindowOwner = {
  readonly ownerRef: string;
  readonly items: readonly NativeWindowItemRef[];
};

/**
 * 派生的可移植上下文摘要（`CONTEXT.md`「Context Capsule」）。
 *
 * `kind` 是给调用方的判别标记：它是派生视图，任何业务判定都必须回到 tracker / Git / Orca。
 */
export type PortableContextCapsule = {
  readonly kind: 'derived_context_capsule';
  readonly capsuleId: string;
  readonly replacedFromStepId: string;
  readonly replacedToStepId: string;
  readonly text: string;
};

/** 两类压缩产物分开归属：任一方缺失或不可用都不损坏另一方。 */
export type ContextMaterial = {
  readonly nativeWindowOwner: NativeCompactedWindowOwner | null;
  readonly capsule: PortableContextCapsule | null;
};

/** 压缩路径的封闭取值；`none` 表示本次没有压缩。 */
export const COMPACTION_PATHS = ['none', 'provider_native', 'context_capsule', 'mechanical_shake'] as const;

export type CompactionPath = (typeof COMPACTION_PATHS)[number];

/**
 * 压缩结果。
 *
 * `compaction_degraded` 与 `context_exhausted` 都是显式终态：前者表示某条路径可用但没有取得
 * 新进展，后者表示所有路径都已尝试而输入仍然超预算。两者都不得被读成「已完成压缩」。
 */
export type CompactionOutcome =
  | { readonly kind: 'not_needed'; readonly path: 'none'; readonly note: string }
  | {
      readonly kind: 'compacted';
      readonly path: Exclude<CompactionPath, 'none'>;
      readonly compactedTokens: number;
      readonly note: string;
    }
  | { readonly kind: 'compaction_degraded'; readonly path: CompactionPath; readonly reason: string }
  | { readonly kind: 'context_exhausted'; readonly reason: string; readonly stillOverBudget: number };

/** 一个 Session 的完整会话状态；可 JSON 序列化，不含凭据与外部权威事实。 */
export type CoordinatorSessionState = {
  readonly schemaVersion: number;
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly committedMessages: readonly CommittedMessageEntry[];
  readonly graphPosition: string;
  readonly committedModelSteps: readonly CommittedModelStep[];
  readonly wakeBatches: readonly WakeBatch[];
  readonly contextMaterial?: ContextMaterial;
  /** 最近一次上下文维护（自动或手动）的结论；从未维护过时为 `null`。 */
  readonly lastCompactionOutcome: CompactionOutcome | null;
};

/**
 * Session ID 到 LangGraph `thread_id` 的确定性映射。
 *
 * 前缀加原样 ID 是单射：不同 Session 永远不会落到同一线程，因此两个 Session 的 checkpoint
 * 互不可见；同一 Session 在任何进程、任何时刻都得到同一个线程。
 */
export function threadIdFor(coordinatorSessionId: CoordinatorSessionId): string {
  return `${CHECKPOINT_THREAD_PREFIX}${coordinatorSessionId}`;
}

/**
 * 用户提交消息的稳定身份派生。
 *
 * 三条派生规则（entry、step、tool operation）都只依赖已持久化的稳定身份，因此重放、重启与
 * 崩溃补齐得到的是同一组 ID，而不是「看起来一样的新记录」。
 */
export function userEntryId(submissionId: string): string {
  return `entry:user:${submissionId}`;
}

export function userStepId(submissionId: string): string {
  return `step:user:${submissionId}`;
}

export function assistantEntryId(stepId: string): string {
  return `entry:assistant:${stepId}`;
}

export function toolResultEntryId(stepId: string, callId: string): string {
  return `entry:tool:${stepId}:${callId}`;
}

export function toolOperationId(stepId: string, callId: string): OperationId {
  return `op:${stepId}:${callId}` as OperationId;
}

export function toolMapOperationId(stepId: string, callId: string): OperationId {
  return `map:${stepId}:${callId}` as OperationId;
}

const SESSION_STATE_FIELDS: readonly string[] = [
  'schemaVersion',
  'coordinatorSessionId',
  'committedMessages',
  'graphPosition',
  'committedModelSteps',
  'wakeBatches',
  'contextMaterial',
  'lastCompactionOutcome',
];

const LEGACY_SESSION_STATE_FIELDS: readonly string[] = [
  'schemaVersion',
  'coordinatorSessionId',
  'committedMessages',
  'graphPosition',
  'committedModelSteps',
  'wakeBatches',
  'contextMaterial',
];

const COMPACTED_STEP_FIELDS: readonly string[] = [
  'stepId',
  'entryId',
  'committedAt',
  'messages',
  'toolCalls',
  'usage',
];

const LEGACY_COMMITTED_STEP_FIELDS: readonly string[] = ['stepId', 'committedAt', 'messages', 'usage'];

const TOOL_CALL_FIELDS: readonly string[] = ['callId', 'name', 'args', 'operationId', 'mapOperationId'];

const MESSAGE_ENTRY_FIELDS: readonly string[] = [
  'entryId',
  'stepId',
  'role',
  'content',
  'toolCalls',
  'toolCallId',
  'toolName',
];

const LEGACY_MESSAGE_FIELDS: readonly string[] = ['role', 'content', 'toolCalls'];

const USAGE_FIELDS: readonly string[] = ['inputTokens', 'outputTokens', 'totalTokens'];

const WAKE_BATCH_FIELDS: readonly string[] = [
  'wakeBatchId',
  'coordinationScopeId',
  'coordinatorSessionId',
  'sourceRevisions',
  'actionableWork',
];

const SOURCE_REVISION_FIELDS: readonly string[] = ['sourceKind', 'sourceId', 'revision'];

const ACTIONABLE_WORK_FIELDS: readonly string[] = ['workKind', 'workId', 'summary'];

const CONTEXT_MATERIAL_FIELDS: readonly string[] = ['nativeWindowOwner', 'capsule'];

const NATIVE_WINDOW_OWNER_FIELDS: readonly string[] = ['ownerRef', 'items'];

const NATIVE_WINDOW_ITEM_FIELDS: readonly string[] = ['itemId', 'position', 'mediaType', 'opaque'];

const PORTABLE_CAPSULE_FIELDS: readonly string[] = [
  'kind',
  'capsuleId',
  'replacedFromStepId',
  'replacedToStepId',
  'text',
];

const CAPSULE_KIND = 'derived_context_capsule';

const COMPACTION_OUTCOME_KINDS = [
  'not_needed',
  'compacted',
  'compaction_degraded',
  'context_exhausted',
] as const;

/**
 * 明确承载凭据的字段名。
 *
 * 顶层闭集已经排除了凭据的落脚点，这一层只处理一个现实风险：凭据被塞进消息或压缩产物里随
 * checkpoint 落盘。这是一份刻意保持封闭的安全边界，不是语义推断——未列出的字段名不会被拒绝。
 * 项目配置以同一个集合拒绝密钥字段，因此这里是这条规则的唯一事实源。
 */
export const CREDENTIAL_BEARING_FIELD_NAMES: ReadonlySet<string> = new Set([
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
  'clientsecret',
  'secretkey',
  'password',
  'passphrase',
  'credential',
  'credentials',
  'privatekey',
]);

function fail<T>(field: string, message: string): IdentityResult<T> {
  return { ok: false, field, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 闭集字段校验：任何未声明字段都是拒绝理由，而不是可以忽略的多余数据。 */
function requireClosedFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): IdentityResult<null> {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      return fail(`${field}.${key}`, `不接受未声明字段 ${key}`);
    }
  }
  return { ok: true, value: null };
}

function requireNonEmptyString(raw: unknown, field: string): IdentityResult<string> {
  return parseStableId(raw, field);
}

function requireNonNegativeInteger(raw: unknown, field: string): IdentityResult<number> {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    return fail(field, '必须是非负整数');
  }
  return { ok: true, value: raw };
}

function requireArray(raw: unknown, field: string): IdentityResult<readonly unknown[]> {
  if (!Array.isArray(raw)) {
    return fail(field, '必须是数组');
  }
  return { ok: true, value: raw };
}

type SerializabilityViolation = { readonly field: string; readonly message: string };

/**
 * 「可 JSON 序列化」的可判定版本：递归拒绝 function、symbol、bigint、undefined、非有限数、
 * 循环引用，以及凭据字段名。`toJSON` 由 `JSON.stringify` 处理，因此这里不预先求值。
 */
function findSerializabilityViolation(
  value: unknown,
  path: string,
  seen: ReadonlySet<object>,
): SerializabilityViolation | null {
  if (value === undefined) {
    return { field: path, message: 'undefined 不能进入会话状态' };
  }
  if (value === null) {
    return null;
  }
  const kind = typeof value;
  if (kind === 'function' || kind === 'symbol' || kind === 'bigint') {
    return { field: path, message: `${kind} 不能进入会话状态` };
  }
  if (kind === 'number' && !Number.isFinite(value)) {
    return { field: path, message: 'NaN 与 Infinity 不能进入会话状态' };
  }
  if (kind !== 'object') {
    return null;
  }
  const object = value;
  if (seen.has(object)) {
    return { field: path, message: '存在循环引用，无法序列化' };
  }
  const nested = new Set(seen);
  nested.add(object);
  if (Array.isArray(object)) {
    for (let index = 0; index < object.length; index += 1) {
      const violation = findSerializabilityViolation(object[index], `${path}.${index}`, nested);
      if (violation !== null) {
        return violation;
      }
    }
    return null;
  }
  for (const [key, entry] of Object.entries(object)) {
    if (CREDENTIAL_BEARING_FIELD_NAMES.has(key.toLowerCase())) {
      return { field: `${path}.${key}`, message: '会话状态不接受凭据字段' };
    }
    const violation = findSerializabilityViolation(entry, `${path}.${key}`, nested);
    if (violation !== null) {
      return violation;
    }
  }
  return null;
}

function parseUsage(raw: unknown, field: string): IdentityResult<ModelUsageObservation | null> {
  if (raw === null || raw === undefined) {
    return { ok: true, value: null };
  }
  if (!isRecord(raw)) {
    return fail(field, '必须是对象或 null');
  }
  const closed = requireClosedFields(raw, USAGE_FIELDS, field);
  if (!closed.ok) {
    return closed;
  }
  const tokens: Record<string, number | null> = {};
  for (const key of USAGE_FIELDS) {
    const entry = raw[key];
    if (entry === undefined || entry === null) {
      tokens[key] = null;
      continue;
    }
    const parsed = requireNonNegativeInteger(entry, `${field}.${key}`);
    if (!parsed.ok) {
      return parsed;
    }
    tokens[key] = parsed.value;
  }
  return {
    ok: true,
    value: {
      inputTokens: tokens['inputTokens'] ?? null,
      outputTokens: tokens['outputTokens'] ?? null,
      totalTokens: tokens['totalTokens'] ?? null,
    },
  };
}

function parseToolCall(raw: unknown, field: string): IdentityResult<CommittedToolCall> {
  if (!isRecord(raw)) {
    return fail(field, '必须是对象');
  }
  const closed = requireClosedFields(raw, TOOL_CALL_FIELDS, field);
  if (!closed.ok) {
    return closed;
  }
  const callId = requireNonEmptyString(raw['callId'], `${field}.callId`);
  if (!callId.ok) {
    return callId;
  }
  const name = requireNonEmptyString(raw['name'], `${field}.name`);
  if (!name.ok) {
    return name;
  }
  if (raw['args'] === undefined) {
    return fail(`${field}.args`, '工具参数必须保存，不能缺失');
  }
  const operationId = requireNonEmptyString(raw['operationId'], `${field}.operationId`);
  if (!operationId.ok) {
    return operationId;
  }
  const mapRaw = raw['mapOperationId'];
  const mapOperationId =
    mapRaw === null || mapRaw === undefined
      ? { ok: true, value: null } as IdentityResult<string | null>
      : requireNonEmptyString(mapRaw, `${field}.mapOperationId`);
  if (!mapOperationId.ok) {
    return mapOperationId;
  }
  return {
    ok: true,
    value: {
      callId: callId.value,
      name: name.value,
      args: raw['args'],
      operationId: operationId.value as OperationId,
      mapOperationId: mapOperationId.value as OperationId | null,
    },
  };
}

function parseMessageEntry(raw: unknown, field: string): IdentityResult<CommittedMessageEntry> {
  if (!isRecord(raw)) {
    return fail(field, '必须是对象');
  }
  const closed = requireClosedFields(raw, MESSAGE_ENTRY_FIELDS, field);
  if (!closed.ok) {
    return closed;
  }
  const entryId = requireNonEmptyString(raw['entryId'], `${field}.entryId`);
  if (!entryId.ok) {
    return entryId;
  }
  const stepId = requireNonEmptyString(raw['stepId'], `${field}.stepId`);
  if (!stepId.ok) {
    return stepId;
  }
  const role = raw['role'];
  if (typeof role !== 'string' || !(DURABLE_MESSAGE_ROLES as readonly string[]).includes(role)) {
    return fail(`${field}.role`, `角色必须是 ${DURABLE_MESSAGE_ROLES.join(' / ')} 之一`);
  }
  if (typeof raw['content'] !== 'string') {
    return fail(`${field}.content`, '必须是字符串');
  }
  const base = {
    entryId: entryId.value,
    stepId: stepId.value,
    role: role as DurableMessageRole,
    content: raw['content'],
  };

  if (role === 'assistant') {
    const callsRaw = raw['toolCalls'];
    if (callsRaw === undefined) {
      return { ok: true, value: base };
    }
    const calls = requireArray(callsRaw, `${field}.toolCalls`);
    if (!calls.ok) {
      return calls;
    }
    const parsed: CommittedToolCall[] = [];
    for (const [index, entry] of calls.value.entries()) {
      const call = parseToolCall(entry, `${field}.toolCalls.${index}`);
      if (!call.ok) {
        return call;
      }
      parsed.push(call.value);
    }
    return parsed.length === 0 ? { ok: true, value: base } : { ok: true, value: { ...base, toolCalls: parsed } };
  }

  if (role === 'tool') {
    const toolCallId = requireNonEmptyString(raw['toolCallId'], `${field}.toolCallId`);
    if (!toolCallId.ok) {
      return toolCallId;
    }
    const toolName = requireNonEmptyString(raw['toolName'], `${field}.toolName`);
    if (!toolName.ok) {
      return toolName;
    }
    return { ok: true, value: { ...base, toolCallId: toolCallId.value, toolName: toolName.value } };
  }

  if (raw['toolCalls'] !== undefined || raw['toolCallId'] !== undefined || raw['toolName'] !== undefined) {
    return fail(field, `${role} 消息不接受工具配对字段`);
  }
  return { ok: true, value: base };
}

function parseStep(raw: unknown, field: string): IdentityResult<CommittedModelStep> {
  if (!isRecord(raw)) {
    return fail(field, '必须是对象');
  }
  const closed = requireClosedFields(raw, COMPACTED_STEP_FIELDS, field);
  if (!closed.ok) {
    return closed;
  }
  const stepId = requireNonEmptyString(raw['stepId'], `${field}.stepId`);
  if (!stepId.ok) {
    return stepId;
  }
  const entryId = requireNonEmptyString(raw['entryId'], `${field}.entryId`);
  if (!entryId.ok) {
    return entryId;
  }
  const committedAt = requireNonNegativeInteger(raw['committedAt'], `${field}.committedAt`);
  if (!committedAt.ok) {
    return committedAt;
  }
  const messages = requireArray(raw['messages'], `${field}.messages`);
  if (!messages.ok) {
    return messages;
  }
  if (messages.value.length === 0) {
    return fail(`${field}.messages`, '已提交的 model step 必须包含至少一条完整响应消息');
  }
  const callsRaw = requireArray(raw['toolCalls'], `${field}.toolCalls`);
  if (!callsRaw.ok) {
    return callsRaw;
  }
  const toolCalls: CommittedToolCall[] = [];
  for (const [index, entry] of callsRaw.value.entries()) {
    const call = parseToolCall(entry, `${field}.toolCalls.${index}`);
    if (!call.ok) {
      return call;
    }
    toolCalls.push(call.value);
  }
  const usage = parseUsage(raw['usage'], `${field}.usage`);
  if (!usage.ok) {
    return usage;
  }
  return {
    ok: true,
    value: {
      stepId: stepId.value,
      entryId: entryId.value,
      committedAt: committedAt.value,
      messages: messages.value,
      toolCalls,
      usage: usage.value,
    },
  };
}

function parseCompactionOutcome(raw: unknown, field: string): IdentityResult<CompactionOutcome | null> {
  if (raw === null || raw === undefined) {
    return { ok: true, value: null };
  }
  if (!isRecord(raw)) {
    return fail(field, '必须是对象或 null');
  }
  const kind = raw['kind'];
  if (typeof kind !== 'string' || !(COMPACTION_OUTCOME_KINDS as readonly string[]).includes(kind)) {
    return fail(`${field}.kind`, `取值必须是 ${COMPACTION_OUTCOME_KINDS.join(' / ')} 之一`);
  }
  switch (kind) {
    case 'not_needed': {
      const closed = requireClosedFields(raw, ['kind', 'path', 'note'], field);
      if (!closed.ok) {
        return closed;
      }
      if (raw['path'] !== 'none' || typeof raw['note'] !== 'string') {
        return fail(field, 'not_needed 必须带 path=none 与 note');
      }
      return { ok: true, value: { kind: 'not_needed', path: 'none', note: raw['note'] } };
    }
    case 'compacted': {
      const closed = requireClosedFields(raw, ['kind', 'path', 'compactedTokens', 'note'], field);
      if (!closed.ok) {
        return closed;
      }
      const path = raw['path'];
      if (typeof path !== 'string' || path === 'none' || !(COMPACTION_PATHS as readonly string[]).includes(path)) {
        return fail(`${field}.path`, 'compacted 必须给出实际使用的压缩路径');
      }
      const tokens = requireNonNegativeInteger(raw['compactedTokens'], `${field}.compactedTokens`);
      if (!tokens.ok) {
        return tokens;
      }
      if (typeof raw['note'] !== 'string') {
        return fail(`${field}.note`, '必须是字符串');
      }
      return {
        ok: true,
        value: {
          kind: 'compacted',
          path: path as Exclude<CompactionPath, 'none'>,
          compactedTokens: tokens.value,
          note: raw['note'],
        },
      };
    }
    case 'compaction_degraded': {
      const closed = requireClosedFields(raw, ['kind', 'path', 'reason'], field);
      if (!closed.ok) {
        return closed;
      }
      const path = raw['path'];
      if (typeof path !== 'string' || !(COMPACTION_PATHS as readonly string[]).includes(path)) {
        return fail(`${field}.path`, '取值必须是已知压缩路径');
      }
      if (typeof raw['reason'] !== 'string') {
        return fail(`${field}.reason`, '必须是字符串');
      }
      return {
        ok: true,
        value: { kind: 'compaction_degraded', path: path as CompactionPath, reason: raw['reason'] },
      };
    }
    default: {
      const closed = requireClosedFields(raw, ['kind', 'reason', 'stillOverBudget'], field);
      if (!closed.ok) {
        return closed;
      }
      const over = requireNonNegativeInteger(raw['stillOverBudget'], `${field}.stillOverBudget`);
      if (!over.ok) {
        return over;
      }
      if (typeof raw['reason'] !== 'string') {
        return fail(`${field}.reason`, '必须是字符串');
      }
      return {
        ok: true,
        value: { kind: 'context_exhausted', reason: raw['reason'], stillOverBudget: over.value },
      };
    }
  }
}

function parseSourceRevisionRef(raw: unknown, field: string): IdentityResult<SourceRevisionRef> {
  if (!isRecord(raw)) {
    return fail(field, '必须是对象');
  }
  const closed = requireClosedFields(raw, SOURCE_REVISION_FIELDS, field);
  if (!closed.ok) {
    return closed;
  }
  const sourceKind = requireNonEmptyString(raw['sourceKind'], `${field}.sourceKind`);
  if (!sourceKind.ok) {
    return sourceKind;
  }
  const sourceId = requireNonEmptyString(raw['sourceId'], `${field}.sourceId`);
  if (!sourceId.ok) {
    return sourceId;
  }
  const revision = requireNonNegativeInteger(raw['revision'], `${field}.revision`);
  if (!revision.ok) {
    return revision;
  }
  return {
    ok: true,
    value: { sourceKind: sourceKind.value, sourceId: sourceId.value, revision: revision.value },
  };
}

function parseActionableWorkRef(raw: unknown, field: string): IdentityResult<ActionableWorkRef> {
  if (!isRecord(raw)) {
    return fail(field, '必须是对象');
  }
  const closed = requireClosedFields(raw, ACTIONABLE_WORK_FIELDS, field);
  if (!closed.ok) {
    return closed;
  }
  const workKind = requireNonEmptyString(raw['workKind'], `${field}.workKind`);
  if (!workKind.ok) {
    return workKind;
  }
  const workId = requireNonEmptyString(raw['workId'], `${field}.workId`);
  if (!workId.ok) {
    return workId;
  }
  const summary = requireNonEmptyString(raw['summary'], `${field}.summary`);
  if (!summary.ok) {
    return summary;
  }
  return {
    ok: true,
    value: { workKind: workKind.value, workId: workId.value, summary: summary.value },
  };
}

function parseWakeBatch(raw: unknown, field: string): IdentityResult<WakeBatch> {
  if (!isRecord(raw)) {
    return fail(field, '必须是对象');
  }
  const closed = requireClosedFields(raw, WAKE_BATCH_FIELDS, field);
  if (!closed.ok) {
    return closed;
  }
  const wakeBatchId = requireNonEmptyString(raw['wakeBatchId'], `${field}.wakeBatchId`);
  if (!wakeBatchId.ok) {
    return wakeBatchId;
  }
  const scopeId = requireNonEmptyString(raw['coordinationScopeId'], `${field}.coordinationScopeId`);
  if (!scopeId.ok) {
    return scopeId;
  }
  const sessionId = requireNonEmptyString(raw['coordinatorSessionId'], `${field}.coordinatorSessionId`);
  if (!sessionId.ok) {
    return sessionId;
  }
  const sources = requireArray(raw['sourceRevisions'], `${field}.sourceRevisions`);
  if (!sources.ok) {
    return sources;
  }
  const sourceRevisions: SourceRevisionRef[] = [];
  for (const [index, entry] of sources.value.entries()) {
    const parsed = parseSourceRevisionRef(entry, `${field}.sourceRevisions.${index}`);
    if (!parsed.ok) {
      return parsed;
    }
    sourceRevisions.push(parsed.value);
  }
  const work = requireArray(raw['actionableWork'], `${field}.actionableWork`);
  if (!work.ok) {
    return work;
  }
  const actionableWork: ActionableWorkRef[] = [];
  for (const [index, entry] of work.value.entries()) {
    const parsed = parseActionableWorkRef(entry, `${field}.actionableWork.${index}`);
    if (!parsed.ok) {
      return parsed;
    }
    actionableWork.push(parsed.value);
  }
  if (sourceRevisions.length === 0 && actionableWork.length === 0) {
    return fail(field, 'Wake Batch 必须携带至少一条 source revision 或 Actionable Work 引用');
  }
  return {
    ok: true,
    value: {
      wakeBatchId: wakeBatchId.value,
      coordinationScopeId: scopeId.value,
      coordinatorSessionId: sessionId.value,
      sourceRevisions,
      actionableWork,
    },
  };
}

function parseNativeWindowOwner(
  raw: unknown,
  field: string,
): IdentityResult<NativeCompactedWindowOwner> {
  if (!isRecord(raw)) {
    return fail(field, '必须是对象');
  }
  const closed = requireClosedFields(raw, NATIVE_WINDOW_OWNER_FIELDS, field);
  if (!closed.ok) {
    return closed;
  }
  const ownerRef = requireNonEmptyString(raw['ownerRef'], `${field}.ownerRef`);
  if (!ownerRef.ok) {
    return ownerRef;
  }
  const items = requireArray(raw['items'], `${field}.items`);
  if (!items.ok) {
    return items;
  }
  const parsed: NativeWindowItemRef[] = [];
  for (const [index, entry] of items.value.entries()) {
    const itemField = `${field}.items.${index}`;
    if (!isRecord(entry)) {
      return fail(itemField, '必须是对象');
    }
    const itemClosed = requireClosedFields(entry, NATIVE_WINDOW_ITEM_FIELDS, itemField);
    if (!itemClosed.ok) {
      return itemClosed;
    }
    const itemId = requireNonEmptyString(entry['itemId'], `${itemField}.itemId`);
    if (!itemId.ok) {
      return itemId;
    }
    const position = requireNonNegativeInteger(entry['position'], `${itemField}.position`);
    if (!position.ok) {
      return position;
    }
    const mediaType = requireNonEmptyString(entry['mediaType'], `${itemField}.mediaType`);
    if (!mediaType.ok) {
      return mediaType;
    }
    if (entry['opaque'] === undefined) {
      return fail(`${itemField}.opaque`, '不透明项必须原样保存，不能缺失');
    }
    parsed.push({
      itemId: itemId.value,
      position: position.value,
      mediaType: mediaType.value,
      opaque: entry['opaque'],
    });
  }
  return { ok: true, value: { ownerRef: ownerRef.value, items: parsed } };
}

function parsePortableCapsule(raw: unknown, field: string): IdentityResult<PortableContextCapsule> {
  if (!isRecord(raw)) {
    return fail(field, '必须是对象');
  }
  const closed = requireClosedFields(raw, PORTABLE_CAPSULE_FIELDS, field);
  if (!closed.ok) {
    return closed;
  }
  if (raw['kind'] !== CAPSULE_KIND) {
    return fail(`${field}.kind`, `必须标记为 ${CAPSULE_KIND}`);
  }
  const capsuleId = requireNonEmptyString(raw['capsuleId'], `${field}.capsuleId`);
  if (!capsuleId.ok) {
    return capsuleId;
  }
  const from = requireNonEmptyString(raw['replacedFromStepId'], `${field}.replacedFromStepId`);
  if (!from.ok) {
    return from;
  }
  const to = requireNonEmptyString(raw['replacedToStepId'], `${field}.replacedToStepId`);
  if (!to.ok) {
    return to;
  }
  const text = requireNonEmptyString(raw['text'], `${field}.text`);
  if (!text.ok) {
    return text;
  }
  return {
    ok: true,
    value: {
      kind: CAPSULE_KIND,
      capsuleId: capsuleId.value,
      replacedFromStepId: from.value,
      replacedToStepId: to.value,
      text: text.value,
    },
  };
}

function parseContextMaterial(raw: unknown, field: string): IdentityResult<ContextMaterial> {
  if (!isRecord(raw)) {
    return fail(field, '必须是对象');
  }
  const closed = requireClosedFields(raw, CONTEXT_MATERIAL_FIELDS, field);
  if (!closed.ok) {
    return closed;
  }
  const ownerRaw = raw['nativeWindowOwner'];
  const capsuleRaw = raw['capsule'];
  const owner =
    ownerRaw === undefined || ownerRaw === null
      ? ({ ok: true, value: null } as IdentityResult<NativeCompactedWindowOwner | null>)
      : parseNativeWindowOwner(ownerRaw, `${field}.nativeWindowOwner`);
  if (!owner.ok) {
    return owner;
  }
  const capsule =
    capsuleRaw === undefined || capsuleRaw === null
      ? ({ ok: true, value: null } as IdentityResult<PortableContextCapsule | null>)
      : parsePortableCapsule(capsuleRaw, `${field}.capsule`);
  if (!capsule.ok) {
    return capsule;
  }
  if (owner.value === null && capsule.value === null) {
    return fail(field, '两类压缩产物不能同时缺失；没有上下文产物时不应写入该字段');
  }
  return { ok: true, value: { nativeWindowOwner: owner.value, capsule: capsule.value } };
}

type SessionStateFields = {
  readonly schemaVersion: number;
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly committedMessages: readonly unknown[];
  readonly graphPosition: string;
  readonly committedModelSteps: readonly unknown[];
  readonly wakeBatches: readonly unknown[];
  readonly contextMaterial?: ContextMaterial;
};

type CommonRead =
  | { readonly ok: true; readonly value: SessionStateFields }
  | { readonly ok: false; readonly field: string; readonly message: string };

function readCommonFields(raw: Record<string, unknown>, allowed: readonly string[]): CommonRead {
  const closed = requireClosedFields(raw, allowed, 'sessionState');
  if (!closed.ok) {
    return closed;
  }
  const schemaVersion = raw['schemaVersion'];
  if (typeof schemaVersion !== 'number' || !Number.isSafeInteger(schemaVersion) || schemaVersion < 0) {
    return fail('sessionState.schemaVersion', '必须是非负整数');
  }
  const sessionId = requireNonEmptyString(raw['coordinatorSessionId'], 'sessionState.coordinatorSessionId');
  if (!sessionId.ok) {
    return sessionId;
  }
  const graphPosition = requireNonEmptyString(raw['graphPosition'], 'sessionState.graphPosition');
  if (!graphPosition.ok) {
    return graphPosition;
  }
  const committedMessages = requireArray(raw['committedMessages'], 'sessionState.committedMessages');
  if (!committedMessages.ok) {
    return committedMessages;
  }
  const steps = requireArray(raw['committedModelSteps'], 'sessionState.committedModelSteps');
  if (!steps.ok) {
    return steps;
  }
  const batches = requireArray(raw['wakeBatches'], 'sessionState.wakeBatches');
  if (!batches.ok) {
    return batches;
  }
  const base = {
    schemaVersion: schemaVersion,
    coordinatorSessionId: sessionId.value as CoordinatorSessionId,
    committedMessages: committedMessages.value,
    graphPosition: graphPosition.value,
    committedModelSteps: steps.value,
    wakeBatches: batches.value,
  };
  if (raw['contextMaterial'] === undefined) {
    return { ok: true, value: base };
  }
  const material = parseContextMaterial(raw['contextMaterial'], 'sessionState.contextMaterial');
  return material.ok ? { ok: true, value: { ...base, contextMaterial: material.value } } : material;
}

function parseWakeBatches(
  raw: readonly unknown[],
  sessionId: string,
): IdentityResult<readonly WakeBatch[]> {
  const wakeBatches: WakeBatch[] = [];
  for (const [index, entry] of raw.entries()) {
    const parsed = parseWakeBatch(entry, `sessionState.wakeBatches.${index}`);
    if (!parsed.ok) {
      return parsed;
    }
    if (parsed.value.coordinatorSessionId !== sessionId) {
      return fail(
        `sessionState.wakeBatches.${index}.coordinatorSessionId`,
        'Wake Batch 的目标 Session 与会话状态不一致',
      );
    }
    wakeBatches.push(parsed.value);
  }
  const batchesById = new Set(wakeBatches.map((batch) => batch.wakeBatchId));
  if (batchesById.size !== wakeBatches.length) {
    return fail('sessionState.wakeBatches', '同一个 WakeBatchId 不能在会话历史中出现两次');
  }
  return { ok: true, value: wakeBatches };
}

function finish(state: CoordinatorSessionState): IdentityResult<CoordinatorSessionState> {
  const violation = findSerializabilityViolation(state, 'sessionState', new Set());
  return violation === null ? { ok: true, value: state } : fail(violation.field, violation.message);
}

/**
 * v1 → v2 升级。
 *
 * v1 的 `committedMessages` 与 `committedModelSteps` 严格一一对应（当时的 model node 在同一次写入
 * 里各追加一条），因此 entry 顺序可以唯一还原：第 i 条消息属于第 i 个 step。两者数量不一致时说明
 * 这份历史无法唯一对应，按不可恢复处理并保留原记录，绝不猜一个顺序。
 *
 * v1 的 assistant 消息可能带 `tool_calls`：v1 的图没有 tools 节点，这些调用从未被发起过，因此
 * 也不存在对应的 Operation Intent。为它们派生确定性 OperationId（`op:<stepId>:<callId>`）是安全的：
 * 没有已发起副作用的记录需要沿用，而这正是 OperationId 要防止重复的东西。
 */
function upgradeFromV1(fields: SessionStateFields): IdentityResult<CoordinatorSessionState> {
  if (fields.committedMessages.length !== fields.committedModelSteps.length) {
    return fail(
      'sessionState.committedMessages',
      `v1 历史无法唯一升级：消息 ${String(fields.committedMessages.length)} 条与 model step ${String(
        fields.committedModelSteps.length,
      )} 个数量不一致`,
    );
  }

  const entries: CommittedMessageEntry[] = [];
  const steps: CommittedModelStep[] = [];
  for (const [index, rawStep] of fields.committedModelSteps.entries()) {
    if (!isRecord(rawStep)) {
      return fail(`sessionState.committedModelSteps.${index}`, '必须是对象');
    }
    const closed = requireClosedFields(rawStep, LEGACY_COMMITTED_STEP_FIELDS, `sessionState.committedModelSteps.${index}`);
    if (!closed.ok) {
      return closed;
    }
    const stepId = requireNonEmptyString(rawStep['stepId'], `sessionState.committedModelSteps.${index}.stepId`);
    if (!stepId.ok) {
      return stepId;
    }
    const committedAt = requireNonNegativeInteger(
      rawStep['committedAt'],
      `sessionState.committedModelSteps.${index}.committedAt`,
    );
    if (!committedAt.ok) {
      return committedAt;
    }
    const messages = requireArray(rawStep['messages'], `sessionState.committedModelSteps.${index}.messages`);
    if (!messages.ok) {
      return messages;
    }
    const usage = parseUsage(rawStep['usage'], `sessionState.committedModelSteps.${index}.usage`);
    if (!usage.ok) {
      return usage;
    }

    const rawMessage = fields.committedMessages[index];
    if (!isRecord(rawMessage)) {
      return fail(`sessionState.committedMessages.${index}`, '必须是对象');
    }
    const messageClosed = requireClosedFields(rawMessage, LEGACY_MESSAGE_FIELDS, `sessionState.committedMessages.${index}`);
    if (!messageClosed.ok) {
      return messageClosed;
    }
    const role = rawMessage['role'];
    if (role !== 'assistant') {
      return fail(
        `sessionState.committedMessages.${index}.role`,
        'v1 的已提交消息只能由 model step 产生，且必须是 assistant',
      );
    }
    if (typeof rawMessage['content'] !== 'string') {
      return fail(`sessionState.committedMessages.${index}.content`, '必须是字符串');
    }
    const rawCalls = rawMessage['toolCalls'];
    const toolCalls: CommittedToolCall[] = [];
    if (rawCalls !== undefined) {
      const calls = requireArray(rawCalls, `sessionState.committedMessages.${index}.toolCalls`);
      if (!calls.ok) {
        return calls;
      }
      for (const [callIndex, entry] of calls.value.entries()) {
        const call = parseLegacyToolCall(entry, stepId.value, `sessionState.committedMessages.${index}.toolCalls.${callIndex}`);
        if (!call.ok) {
          return call;
        }
        toolCalls.push(call.value);
      }
    }

    const entryId = assistantEntryId(stepId.value);
    entries.push(
      toolCalls.length === 0
        ? {
            entryId,
            stepId: stepId.value,
            role: 'assistant',
            content: rawMessage['content'],
          }
        : {
            entryId,
            stepId: stepId.value,
            role: 'assistant',
            content: rawMessage['content'],
            toolCalls,
          },
    );
    steps.push({
      stepId: stepId.value,
      entryId,
      committedAt: committedAt.value,
      messages: messages.value,
      toolCalls,
      usage: usage.value,
    });
  }

  const wakeBatches = parseWakeBatches(fields.wakeBatches, fields.coordinatorSessionId);
  if (!wakeBatches.ok) {
    return wakeBatches;
  }
  const base: CoordinatorSessionState = {
    schemaVersion: COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
    coordinatorSessionId: fields.coordinatorSessionId,
    committedMessages: entries,
    graphPosition: fields.graphPosition,
    committedModelSteps: steps,
    wakeBatches: wakeBatches.value,
    lastCompactionOutcome: null,
  };
  const state = fields.contextMaterial === undefined ? base : { ...base, contextMaterial: fields.contextMaterial };
  return finish(state);
}

/** v1 消息里的 provider 形状 tool call：`{id, name, args}`。 */
function parseLegacyToolCall(raw: unknown, stepId: string, field: string): IdentityResult<CommittedToolCall> {
  if (!isRecord(raw)) {
    return fail(field, '必须是对象');
  }
  const callId = requireNonEmptyString(raw['id'], `${field}.id`);
  if (!callId.ok) {
    return callId;
  }
  const name = requireNonEmptyString(raw['name'], `${field}.name`);
  if (!name.ok) {
    return name;
  }
  if (raw['args'] === undefined) {
    return fail(`${field}.args`, '工具参数必须保存，不能缺失');
  }
  return {
    ok: true,
    value: {
      callId: callId.value,
      name: name.value,
      args: raw['args'],
      operationId: toolOperationId(stepId, callId.value),
      mapOperationId: null,
    },
  };
}

/**
 * 校验一个候选 Coordinator Session State。
 *
 * v1 与 v2 都从这里进入：v1 先按上面的规则升级，v2 直接校验。拒绝理由始终指向具体字段：调用方
 * 要么修好它，要么把 Session 标记为阻塞，不做「尽力恢复」。
 */
export function parseCoordinatorSessionState(raw: unknown): IdentityResult<CoordinatorSessionState> {
  if (!isRecord(raw)) {
    return fail('sessionState', '必须是对象');
  }
  const version = raw['schemaVersion'];
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
    return fail('sessionState.schemaVersion', '必须是非负整数');
  }
  if (version === LEGACY_SESSION_STATE_SCHEMA_VERSION) {
    const common = readCommonFields(raw, LEGACY_SESSION_STATE_FIELDS);
    return common.ok ? upgradeFromV1(common.value) : common;
  }
  if (version !== COORDINATOR_SESSION_STATE_SCHEMA_VERSION) {
    return fail(
      'sessionState.schemaVersion',
      `期望 ${String(COORDINATOR_SESSION_STATE_SCHEMA_VERSION)}（或可升级的 ${String(
        LEGACY_SESSION_STATE_SCHEMA_VERSION,
      )}），实际为 ${String(version)}`,
    );
  }

  const common = readCommonFields(raw, SESSION_STATE_FIELDS);
  if (!common.ok) {
    return common;
  }
  const fields = common.value;

  const entries: CommittedMessageEntry[] = [];
  const entriesById = new Set<string>();
  for (const [index, entry] of fields.committedMessages.entries()) {
    const parsed = parseMessageEntry(entry, `sessionState.committedMessages.${index}`);
    if (!parsed.ok) {
      return parsed;
    }
    if (entriesById.has(parsed.value.entryId)) {
      return fail('sessionState.committedMessages', `entryId ${parsed.value.entryId} 出现了两次`);
    }
    entriesById.add(parsed.value.entryId);
    entries.push(parsed.value);
  }

  const steps: CommittedModelStep[] = [];
  const stepIds: string[] = [];
  for (const [index, entry] of fields.committedModelSteps.entries()) {
    const parsed = parseStep(entry, `sessionState.committedModelSteps.${index}`);
    if (!parsed.ok) {
      return parsed;
    }
    if (!entriesById.has(parsed.value.entryId)) {
      return fail(
        `sessionState.committedModelSteps.${index}.entryId`,
        `该 entryId ${parsed.value.entryId} 在 committedMessages 中不存在`,
      );
    }
    stepIds.push(parsed.value.stepId);
    steps.push(parsed.value);
  }

  const wakeBatches = parseWakeBatches(fields.wakeBatches, fields.coordinatorSessionId);
  if (!wakeBatches.ok) {
    return wakeBatches;
  }

  const outcome = parseCompactionOutcome(
    raw['lastCompactionOutcome'] === undefined ? null : raw['lastCompactionOutcome'],
    'sessionState.lastCompactionOutcome',
  );
  if (!outcome.ok) {
    return outcome;
  }

  const base: CoordinatorSessionState = {
    schemaVersion: fields.schemaVersion,
    coordinatorSessionId: fields.coordinatorSessionId,
    committedMessages: entries,
    graphPosition: fields.graphPosition,
    committedModelSteps: steps,
    wakeBatches: wakeBatches.value,
    lastCompactionOutcome: outcome.value,
  };
  const state = fields.contextMaterial === undefined ? base : { ...base, contextMaterial: fields.contextMaterial };
  return finish(state);
}
