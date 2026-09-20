/**
 * IC-04：Coordinator Session State 的领域类型与边界校验
 * （Owner: `m1-run-coordinator-sessions`）。
 *
 * 这个模块只描述一个 Session 自己拥有的会话事实：已提交的消息与 model step、图位置、
 * 已注入的 Wake Batch，以及两类上下文压缩产物。它刻意不携带任何可从别处重建的内容——
 * provider 凭据属于用户配置，Orca 运行事实属于 Orca，Route Map 属于 tracker，把它们复制进
 * checkpoint 只会产生第二份真值（`CONTEXT.md`「Coordinator Session State」）。
 *
 * 校验是闭集：顶层与各嵌套记录的字段集合固定，未声明字段一律拒绝。这样「不含凭据与外部事实」
 * 不需要靠字段名黑名单来猜——凭据根本没有落脚的位置。
 */

import {
  parseStableId,
  type CoordinatorSessionId,
  type IdentityResult,
} from '../../application/dto/identity.js';

export type { CoordinatorSessionId };

/** Session 状态的 schema 版本；读取时版本不符即拒绝，不猜测旧形状。 */
export const COORDINATOR_SESSION_STATE_SCHEMA_VERSION = 1;

/** checkpoint thread 前缀：让 Session ID 到 `thread_id` 的映射显式且不可与其它用途混用。 */
export const CHECKPOINT_THREAD_PREFIX = 'coordinator-session:';

/** provider 报告的 usage；未取得时保留 `null`，不做估算。 */
export type ModelUsageObservation = {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
};

/**
 * 一次原子接受的 Coordinator Agent 响应（`CONTEXT.md`「Committed Model Step」）。
 *
 * `messages` 是完整响应（含 tool calls）；流式草稿永远不构造这个值，因此「未完整提交的响应」
 * 在类型上就没有进入历史的入口。
 */
export type CommittedModelStep = {
  readonly stepId: string;
  readonly committedAt: number;
  readonly messages: readonly unknown[];
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

/** 一个 Session 的完整会话状态；可 JSON 序列化，不含凭据与外部权威事实。 */
export type CoordinatorSessionState = {
  readonly schemaVersion: number;
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly committedMessages: readonly unknown[];
  readonly graphPosition: string;
  readonly committedModelSteps: readonly CommittedModelStep[];
  readonly wakeBatches: readonly WakeBatch[];
  readonly contextMaterial?: ContextMaterial;
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

const SESSION_STATE_FIELDS: readonly string[] = [
  'schemaVersion',
  'coordinatorSessionId',
  'committedMessages',
  'graphPosition',
  'committedModelSteps',
  'wakeBatches',
  'contextMaterial',
];

const COMMITTED_MODEL_STEP_FIELDS: readonly string[] = [
  'stepId',
  'committedAt',
  'messages',
  'usage',
];

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

/**
 * 明确承载凭据的字段名。
 *
 * 顶层闭集已经排除了凭据的落脚点，这一层只处理一个现实风险：凭据被塞进消息或压缩产物里随
 * checkpoint 落盘。这是一份刻意保持封闭的安全边界，不是语义推断——未列出的字段名不会被拒绝。
 */
const CREDENTIAL_BEARING_FIELDS: ReadonlySet<string> = new Set([
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
    if (CREDENTIAL_BEARING_FIELDS.has(key.toLowerCase())) {
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
  if (raw === null) {
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

function parseCommittedModelStep(raw: unknown, field: string): IdentityResult<CommittedModelStep> {
  if (!isRecord(raw)) {
    return fail(field, '必须是对象');
  }
  const closed = requireClosedFields(raw, COMMITTED_MODEL_STEP_FIELDS, field);
  if (!closed.ok) {
    return closed;
  }
  const stepId = requireNonEmptyString(raw['stepId'], `${field}.stepId`);
  if (!stepId.ok) {
    return stepId;
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
  const usage = parseUsage(raw['usage'], `${field}.usage`);
  if (!usage.ok) {
    return usage;
  }
  return {
    ok: true,
    value: {
      stepId: stepId.value,
      committedAt: committedAt.value,
      messages: messages.value,
      usage: usage.value,
    },
  };
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

/**
 * 校验一个候选 Coordinator Session State。
 *
 * 拒绝理由始终指向具体字段：调用方要么修好它，要么把 Session 标记为阻塞，不做「尽力恢复」。
 */
export function parseCoordinatorSessionState(raw: unknown): IdentityResult<CoordinatorSessionState> {
  if (!isRecord(raw)) {
    return fail('sessionState', '必须是对象');
  }
  const closed = requireClosedFields(raw, SESSION_STATE_FIELDS, 'sessionState');
  if (!closed.ok) {
    return closed;
  }
  const schemaVersion = requireNonNegativeInteger(raw['schemaVersion'], 'sessionState.schemaVersion');
  if (!schemaVersion.ok) {
    return schemaVersion;
  }
  if (schemaVersion.value !== COORDINATOR_SESSION_STATE_SCHEMA_VERSION) {
    return fail(
      'sessionState.schemaVersion',
      `期望 ${COORDINATOR_SESSION_STATE_SCHEMA_VERSION}，实际为 ${schemaVersion.value}`,
    );
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
  const committedModelSteps: CommittedModelStep[] = [];
  for (const [index, entry] of steps.value.entries()) {
    const parsed = parseCommittedModelStep(entry, `sessionState.committedModelSteps.${index}`);
    if (!parsed.ok) {
      return parsed;
    }
    committedModelSteps.push(parsed.value);
  }
  const batches = requireArray(raw['wakeBatches'], 'sessionState.wakeBatches');
  if (!batches.ok) {
    return batches;
  }
  const wakeBatches: WakeBatch[] = [];
  for (const [index, entry] of batches.value.entries()) {
    const parsed = parseWakeBatch(entry, `sessionState.wakeBatches.${index}`);
    if (!parsed.ok) {
      return parsed;
    }
    if (parsed.value.coordinatorSessionId !== sessionId.value) {
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

  const base = {
    schemaVersion: schemaVersion.value,
    coordinatorSessionId: sessionId.value as CoordinatorSessionId,
    committedMessages: committedMessages.value,
    graphPosition: graphPosition.value,
    committedModelSteps,
    wakeBatches,
  };
  let state: CoordinatorSessionState = base;
  if (raw['contextMaterial'] !== undefined) {
    const material = parseContextMaterial(raw['contextMaterial'], 'sessionState.contextMaterial');
    if (!material.ok) {
      return material;
    }
    state = { ...base, contextMaterial: material.value };
  }

  const violation = findSerializabilityViolation(state, 'sessionState', new Set());
  if (violation !== null) {
    return fail(violation.field, violation.message);
  }
  return { ok: true, value: state };
}
