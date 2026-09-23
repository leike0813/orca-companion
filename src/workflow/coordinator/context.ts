/**
 * MOD-03：模型输入的上下文维护
 * （Owner: `m1-run-coordinator-sessions`）。
 *
 * 这个模块负责把已提交会话历史变成一次有界的模型输入，并保证三件事：
 *
 * - **派生视图不越权**：Context Capsule 是派生摘要，永远不覆盖底层对话，也不被当作状态或证据的
 *   权威副本；权威仍以 tracker、Git 与 Orca 为准。
 * - **每次调用按当前配置重新注入**：instructions、tool schema 与最新权威事实只接受当前值。
 *   这些函数没有访问被压缩区间的入口，所以「沿用旧副本」在结构上不可能发生。
 * - **故障关闭**：无法安全归类历史、派生不出 Capsule、原生项无法再原样携带时，抛出
 *   `ContextMaintenanceError` 让调用方阻塞，而不是截断历史、伪造摘要或自行构造不透明内容。
 */

import type { BaseMessage } from '@langchain/core/messages';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';

import type { OperationId } from '../../application/dto/identity.js';
import {
  DURABLE_MESSAGE_ROLES,
  type CommittedMessageEntry,
  type CommittedToolCall,
  type DurableMessageRole,
  type NativeCompactedWindowOwner,
  type NativeWindowItemRef,
  type PortableContextCapsule,
} from '../../domain/coordinator/session-state.js';
import { compactWithNativeFirst, type CompactionResult } from './compaction.js';
import {
  type CompactionOutcome,
  type HistorySegment,
  type NativeCompactionAvailability,
} from './state.js';

/**
 * 上下文无法安全维护。
 *
 * 这是终态阻塞信号：调用方必须停下并报告，不得截断历史、伪造摘要或继续超窗请求。
 */
export class ContextMaintenanceError extends Error {
  readonly reason: string;
  readonly stepId: string | null;

  constructor(reason: string, stepId: string | null = null) {
    super(stepId === null ? reason : `${reason}（step ${stepId}）`);
    this.name = 'ContextMaintenanceError';
    this.reason = reason;
    this.stepId = stepId;
  }
}

/**
 * 会话历史里消息的持久化角色闭集。
 *
 * 词表由 `src/domain/coordinator/session-state.js` 拥有：workflow 侧只消费它，不再定义第二份，
 * 否则「checkpoint 能存什么角色」会有两个事实源。
 */
export { DURABLE_MESSAGE_ROLES };
export type { DurableMessageRole };

/** 一条可持久化的会话消息；它是 `CommittedMessageEntry` 去掉稳定身份后的形状。 */
export type DurableMessage = {
  readonly role: DurableMessageRole;
  readonly content: string;
  /** 完整模型响应中的标准化 tool calls；缺失时不写该字段。 */
  readonly toolCalls?: readonly unknown[];
};

/** 已知的角色别名。未列出的角色一律阻塞，不猜。 */
const ROLE_ALIASES: Readonly<Record<string, DurableMessageRole>> = {
  system: 'system',
  user: 'user',
  human: 'user',
  assistant: 'assistant',
  ai: 'assistant',
  tool: 'tool',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 已经是 LangChain 消息对象时原样透传：它的角色与 tool calls 才是权威形状。 */
function isBaseMessage(value: unknown): value is BaseMessage {
  return isRecord(value) && typeof value['_getType'] === 'function';
}

function rawRoleOf(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value['role'] === 'string') {
    return value['role'];
  }
  const getType = value['getType'];
  if (typeof getType === 'function') {
    const type = (getType as () => unknown).call(value);
    return typeof type === 'string' ? type : null;
  }
  return null;
}

/** 把 provider 或 LangChain 的角色拼写归一化到 Companion 的词表。 */
export function canonicalRoleOf(value: unknown): DurableMessageRole | null {
  const raw = rawRoleOf(value);
  if (raw === null) {
    return null;
  }
  return ROLE_ALIASES[raw] ?? null;
}

/**
 * 把一条消息的内容渲染成可持久化文本。
 *
 * 字符串内容原样保留；内容块数组按 JSON 原样渲染（忠实表示，不是摘要）；其余形状返回 `null`
 * 让调用方阻塞。
 */
function contentTextOf(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const content = value['content'];
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return JSON.stringify(content);
  }
  return null;
}

/** 把一次模型响应归一化成可持久化形状；无法安全归类时阻塞，不写入半条历史。 */
export function toDurableMessage(value: unknown): DurableMessage {
  const role = canonicalRoleOf(value);
  if (role === null) {
    throw new ContextMaintenanceError('模型响应缺少可识别的角色，无法安全写入会话历史');
  }
  const content = contentTextOf(value);
  if (content === null) {
    throw new ContextMaintenanceError('模型响应内容不是可持久化的形状，无法安全写入会话历史');
  }
  const toolCalls = isRecord(value) ? value['tool_calls'] : undefined;
  if (toolCalls !== undefined && !Array.isArray(toolCalls)) {
    throw new ContextMaintenanceError('模型响应的 tool_calls 不是可持久化数组');
  }
  return toolCalls === undefined || toolCalls.length === 0
    ? { role, content }
    : { role, content, toolCalls };
}

/** 把持久化形状还原成 LangChain 消息，供下一次模型调用使用。 */
export function fromDurableMessage(value: unknown): BaseMessage {
  if (isBaseMessage(value)) {
    return value;
  }
  const role = canonicalRoleOf(value);
  const content = contentTextOf(value);
  if (role === null) {
    throw new ContextMaintenanceError('历史中出现无法安全归类的项：缺少可识别的角色');
  }
  if (content === null) {
    throw new ContextMaintenanceError('历史中出现无法安全归类的内容：content 不是字符串');
  }
  const toolCalls = isRecord(value) && Array.isArray(value['toolCalls'])
    ? value['toolCalls']
    : undefined;
  switch (role) {
    case 'system':
      return new SystemMessage(content);
    case 'assistant':
      return new AIMessage({
        content,
        ...(toolCalls === undefined ? {} : { tool_calls: langchainToolCalls(toolCalls) as never }),
      });
    case 'tool':
      return toolMessageFrom(value, content);
    case 'user':
      return new HumanMessage(content);
  }
}

/**
 * 已提交的 tool call 还原成 LangChain 的 `tool_calls` 形状。
 *
 * 身份取自持久化的 `callId`——它就是 provider 的 call ID，所以模型看到的调用与它自己的请求是
 * 同一个；v1 升级或 `toDurableMessage` 留下的 provider 形状（`{id, name, args}`）本身就是权威
 * 形状，原样透传。
 */
function langchainToolCalls(calls: readonly unknown[]): readonly unknown[] {
  return calls.map((call) => {
    if (!isRecord(call)) {
      return call;
    }
    const callId = call['callId'];
    return typeof callId === 'string' && callId.length > 0
      ? { id: callId, name: call['name'], args: call['args'], type: 'tool_call' }
      : call;
  });
}

/** tool entry 还原成真正的 `ToolMessage`：配对身份必须来自持久化记录，而不是推断。 */
function toolMessageFrom(value: unknown, content: string): ToolMessage {
  const toolCallId = isRecord(value) ? value['toolCallId'] : undefined;
  const toolName = isRecord(value) ? value['toolName'] : undefined;
  if (typeof toolCallId !== 'string' || toolCallId.length === 0) {
    throw new ContextMaintenanceError('历史中的 tool 消息缺少被回答的 call 身份，无法与调用配对');
  }
  if (typeof toolName !== 'string' || toolName.length === 0) {
    throw new ContextMaintenanceError('历史中的 tool 消息缺少工具名，无法与调用配对');
  }
  return new ToolMessage({ content, tool_call_id: toolCallId, name: toolName });
}

/**
 * 把一次完整模型响应归一化成一条带稳定身份的 durable entry。
 *
 * 复用 `toDurableMessage` 的角色与内容归一化规则；调用清单必须由调用方校验后传入——模型响应的
 * 原始 `tool_calls` 不是可信身份，它只是「模型想做什么」。
 */
export function entryFromResponse(
  value: unknown,
  input: {
    readonly stepId: string;
    readonly entryId: string;
    readonly toolCalls: readonly CommittedToolCall[];
  },
): CommittedMessageEntry {
  const durable = toDurableMessage(value);
  const base = {
    entryId: input.entryId,
    stepId: input.stepId,
    role: durable.role,
    content: durable.content,
  };
  if (durable.role === 'assistant') {
    return input.toolCalls.length === 0 ? base : { ...base, toolCalls: input.toolCalls };
  }
  if (durable.role === 'tool') {
    // 模型响应里出现 tool 角色时，配对身份只接受持久化的字段名，不猜 provider 的拼写。
    const toolCallId = isRecord(value) ? value['toolCallId'] : undefined;
    const toolName = isRecord(value) ? value['toolName'] : undefined;
    if (typeof toolCallId !== 'string' || toolCallId.length === 0 || typeof toolName !== 'string') {
      throw new ContextMaintenanceError('tool 角色的响应缺少 toolCallId 或 toolName，无法与调用配对');
    }
    return { ...base, toolCallId, toolName };
  }
  return base;
}

/**
 * 从模型响应里读并校验受支持的 tool calls，并为每个 call 派生可信身份。
 *
 * 缺失或不合法时返回拒绝理由而不是补一个默认值：调用清单是「模型请求了什么」的唯一记录，
 * 猜一个 call ID 就等于允许重复副作用。`mapOperationId` 只对 `resolve_ticket` 有意义，其它工具
 * 一律为 `null`（它们只发起一次副作用）。
 */
export function parseModelToolCalls(
  value: unknown,
  allowedNames: readonly string[],
  derive: (callId: string) => { readonly operationId: OperationId; readonly mapOperationId: OperationId | null },
):
  | { readonly ok: true; readonly calls: readonly CommittedToolCall[] }
  | { readonly ok: false; readonly reason: string } {
  const raw = isRecord(value) ? value['tool_calls'] : undefined;
  if (raw === undefined || raw === null) {
    return { ok: true, calls: [] };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, reason: 'tool_calls 不是数组' };
  }
  const calls: CommittedToolCall[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry)) {
      return { ok: false, reason: `第 ${String(index + 1)} 个 tool call 不是对象` };
    }
    const callId = entry['callId'] ?? entry['id'];
    if (typeof callId !== 'string' || callId.length === 0) {
      return { ok: false, reason: `第 ${String(index + 1)} 个 tool call 缺少非空 callId` };
    }
    const name = entry['name'];
    if (typeof name !== 'string' || !allowedNames.includes(name)) {
      return {
        ok: false,
        reason: `第 ${String(index + 1)} 个 tool call 请求了未注册的工具 ${String(name)}`,
      };
    }
    const args = entry['args'];
    if (!isRecord(args)) {
      return { ok: false, reason: `第 ${String(index + 1)} 个 tool call 的 args 不是对象` };
    }
    const identity = derive(callId);
    calls.push({
      callId,
      name,
      args,
      operationId: identity.operationId,
      mapOperationId: name === 'resolve_ticket' ? identity.mapOperationId : null,
    });
  }
  return { ok: true, calls };
}

function classify(message: unknown, stepId: string): DurableMessage {
  const role = canonicalRoleOf(message);
  if (role === null) {
    const raw = rawRoleOf(message);
    throw new ContextMaintenanceError(
      raw === null ? '历史中出现无法安全归类的项：缺少可识别的角色' : `历史中出现无法安全归类的角色 ${raw}`,
      stepId,
    );
  }
  const content = contentTextOf(message);
  if (content === null) {
    throw new ContextMaintenanceError('历史中出现无法安全归类的内容：content 不是字符串', stepId);
  }
  return { role, content };
}

/** Capsule 里每条消息保留的字符上限；超出部分显式截断并标注原文所在 step。 */
export const CAPSULE_MESSAGE_CHAR_LIMIT = 240;

/** Capsule 文本的一条记录：保留 step 归属，原文始终可以从 checkpoint 读回。 */
export type CapsuleEntry = {
  readonly stepId: string;
  readonly role: DurableMessageRole;
  readonly content: string;
};

function capsuleLine(entry: CapsuleEntry): string {
  if (entry.content.length <= CAPSULE_MESSAGE_CHAR_LIMIT) {
    return `- ${entry.role}: ${entry.content}`;
  }
  const elided = entry.content.length - CAPSULE_MESSAGE_CHAR_LIMIT;
  const head = entry.content.slice(0, CAPSULE_MESSAGE_CHAR_LIMIT);
  return `- ${entry.role}: ${head}…<truncated ${String(elided)} chars; 原文见 ${entry.stepId}>`;
}

/**
 * Capsule 的可移植文本形状：结构化、可读、确定性。
 *
 * 截断是显式的，并指出原文属于哪个 step。这不是伪造摘要：被取代区间的原始消息仍完整保存在
 * checkpoint 里，随时可以读回，Capsule 只是它的派生视图。
 */
export function capsuleTextOf(capsuleId: string, entries: readonly CapsuleEntry[]): string {
  return [`[derived context capsule ${capsuleId}]`, ...entries.map(capsuleLine)].join('\n');
}

/**
 * 从已提交历史派生一个可移植 Context Capsule。
 *
 * 区间内出现无法安全归类的项时抛出 `ContextMaintenanceError`：猜测裁剪边界比停下更危险。
 */
export function deriveContextCapsule(input: {
  readonly fromStepId: string;
  readonly toStepId: string;
  readonly steps: readonly {
    readonly stepId: string;
    readonly messages: readonly unknown[];
  }[];
}): PortableContextCapsule {
  const fromIndex = input.steps.findIndex((step) => step.stepId === input.fromStepId);
  const toIndex = input.steps.findIndex((step) => step.stepId === input.toStepId);
  if (fromIndex < 0 || toIndex < 0 || fromIndex > toIndex) {
    throw new ContextMaintenanceError('Capsule 区间与被取代的已提交历史不匹配');
  }
  const entries: CapsuleEntry[] = [];
  for (const step of input.steps.slice(fromIndex, toIndex + 1)) {
    for (const message of step.messages) {
      const classified = classify(message, step.stepId);
      entries.push({ stepId: step.stepId, role: classified.role, content: classified.content });
    }
  }
  if (entries.length === 0) {
    throw new ContextMaintenanceError('Capsule 区间没有任何可归类的消息');
  }
  const capsuleId = `capsule:${input.fromStepId}..${input.toStepId}`;
  return {
    kind: 'derived_context_capsule',
    capsuleId,
    replacedFromStepId: input.fromStepId,
    replacedToStepId: input.toStepId,
    text: capsuleTextOf(capsuleId, entries),
  };
}

/**
 * 原样携带 provider 原生压缩项。
 *
 * Companion 只记录身份与位置：`items` 逐字返回，不解析、不改写、不依据其内容改动会话状态。
 * 需要携带却又没有可用项时阻塞，绝不用自行构造的内容替代不透明项。
 */
export function carryOpaqueNativeWindow(
  owner: NativeCompactedWindowOwner | null,
  options: { readonly required: boolean },
): readonly NativeWindowItemRef[] {
  if (owner === null) {
    if (options.required) {
      throw new ContextMaintenanceError(
        '之前记录的原生压缩项无法再被原样携带，且不存在可用的 Capsule 迁移路径',
      );
    }
    return [];
  }
  return owner.items.map((item) => ({ ...item }));
}

/**
 * 按当前配置重新注入 system 与 project instructions。
 *
 * 只接受当前值：这个函数看不到被压缩区间，因此不可能沿用其中的旧副本。当前值缺失即阻塞，
 * 因为用旧副本会让工具契约与事实滞后。
 */
export function reinjectInstructions(current: readonly string[] | null): readonly string[] {
  if (current === null || current.length === 0) {
    throw new ContextMaintenanceError('当前配置没有可注入的 system 或 project instructions');
  }
  return [...current];
}

export type ToolSchemaEntry = {
  readonly name: string;
  readonly description: string;
  readonly schema: unknown;
};

/** 按当前配置重新注入 tool schema；当前值为空即阻塞，不沿用旧契约。 */
export function reinjectToolSchema(current: readonly ToolSchemaEntry[] | null): readonly ToolSchemaEntry[] {
  if (current === null) {
    throw new ContextMaintenanceError('当前配置没有可注入的 tool schema');
  }
  return current.map((tool) => ({ ...tool }));
}

/** 按当前事实重新注入最新权威事实；不是「上一次注入过的」事实。 */
export function reinjectAuthoritativeFacts(current: readonly string[] | null): readonly string[] {
  if (current === null) {
    throw new ContextMaintenanceError('当前没有可注入的最新权威事实');
  }
  return [...current];
}

/** 一次模型输入的完整组成：有界历史 + 按当前配置注入的上下文 + 本次压缩结论。 */
export type BoundedModelInput = {
  /** provider-native opaque items remain byte-for-byte the objects returned by the provider. */
  readonly messages: readonly unknown[];
  readonly toolSchema: readonly ToolSchemaEntry[];
  readonly compaction: CompactionOutcome;
  /** 本次输入采用的片段，供调用方在需要时把派生视图写回 checkpoint。 */
  readonly segments: readonly HistorySegment[];
};

export type BuildBoundedModelInputRequest = {
  readonly segments: readonly HistorySegment[];
  readonly estimate: (segments: readonly HistorySegment[]) => number;
  readonly fixedOverhead: number;
  readonly budgetTokens: number;
  readonly native: NativeCompactionAvailability;
  readonly shaken: boolean;
  readonly instructions: readonly string[] | null;
  readonly toolSchema: readonly ToolSchemaEntry[] | null;
  readonly authoritativeFacts: readonly string[] | null;
  /** 本次正要消费的 Actionable Work；它是请求里唯一的非 system 内容来源之一。 */
  readonly currentWork?: { readonly workKind: string; readonly summary: string } | null;
};

/**
 * 一个 step 的消息还原成模型可读的消息。
 *
 * 已提交历史里存的是 Companion 自己的持久化形状；这里只做还原，不做角色推断。
 */
function messagesFromSegment(segment: Extract<HistorySegment, { kind: 'messages' }>): readonly BaseMessage[] {
  return segment.messages.map((message) => {
    try {
      return fromDurableMessage(message);
    } catch (error) {
      throw new ContextMaintenanceError(
        error instanceof ContextMaintenanceError ? error.reason : '历史中出现无法安全归类的项',
        segment.stepId,
      );
    }
  });
}

/**
 * 把片段拼成 provider 无关的消息序列。
 *
 * 系统内容必须被合并成**恰好一条**前导消息：Anthropic 只接受第一条为 system，第二条 system 就会
 * 报错；OpenAI 虽然宽容，但没有理由依赖这个差异。因此 instructions、最新权威事实、派生的 Context
 * Capsule 以及历史里出现的 system 消息都汇总到同一条前导消息里，对话部分只剩非系统消息。
 *
 * `currentWork` 作为最后一条 user 消息出现：它才是本次要处理的事，也让请求永远至少有一条非
 * system 消息——部分 provider 会以 `messages must not be empty` 拒绝只有 system 的请求。
 */
function assembleMessages(
  preamble: readonly BaseMessage[],
  segments: readonly HistorySegment[],
  currentWork: { readonly workKind: string; readonly summary: string } | null,
): readonly unknown[] {
  const systemBlocks: string[] = preamble.map((message) => message.text);
  const conversation: unknown[] = [];
  for (const segment of segments) {
    switch (segment.kind) {
      case 'messages':
        for (const message of messagesFromSegment(segment)) {
          if (message instanceof SystemMessage) {
            systemBlocks.push(message.text);
          } else {
            conversation.push(message);
          }
        }
        break;
      case 'capsule':
        systemBlocks.push(segment.text);
        break;
      case 'native-window':
        // 原生项保持不透明：下一次 provider 请求逐字携带，不翻译成 Companion 消息。
        conversation.push(...segment.items.map((item) => item.opaque));
        break;
    }
  }
  if (currentWork !== null) {
    conversation.push(
      new HumanMessage(
        `[待处理 Actionable Work]\nkind: ${currentWork.workKind}\nsummary: ${currentWork.summary}`,
      ),
    );
  }
  const head = systemBlocks.length === 0 ? [] : [new SystemMessage(systemBlocks.join('\n\n'))];
  return [...head, ...conversation];
}

/**
 * 组装一次有界的模型输入。
 *
 * 顺序固定：先把历史压回有界范围，再按当前配置重新注入 instructions、tool schema 与最新事实。
 * `context_exhausted` 与 `compaction_degraded` 都会原样返回给调用方，由调用方决定阻塞，而不是
 * 在这里降级成截断请求。
 */
export function buildBoundedModelInput(request: BuildBoundedModelInputRequest): BoundedModelInput {
  const compacted: CompactionResult = compactWithNativeFirst({
    segments: request.segments,
    estimate: request.estimate,
    fixedOverhead: request.fixedOverhead,
    budgetTokens: request.budgetTokens,
    native: request.native,
    shaken: request.shaken,
    deriveCapsule: (segments) => {
      const run: Extract<HistorySegment, { kind: 'messages' }>[] = [];
      for (const segment of segments) {
        if (segment.kind !== 'messages') {
          break;
        }
        run.push(segment);
      }
      // 至少保留最新一个 step 逐字出现：Capsule 只取代更早的区间，不吞掉当前上下文。
      const replaceable = run.slice(0, Math.max(0, run.length - 1));
      const first = replaceable[0];
      const last = replaceable[replaceable.length - 1];
      if (first === undefined || last === undefined) {
        return null;
      }
      const capsule = deriveContextCapsule({
        fromStepId: first.stepId,
        toStepId: last.stepId,
        steps: replaceable.map((segment) => ({ stepId: segment.stepId, messages: segment.messages })),
      });
      return {
        replacedCount: replaceable.length,
        segment: {
          kind: 'capsule',
          capsuleId: capsule.capsuleId,
          text: capsule.text,
          replacedFromStepId: capsule.replacedFromStepId,
          replacedToStepId: capsule.replacedToStepId,
        },
      };
    },
  });

  const preamble: BaseMessage[] = [
    ...reinjectInstructions(request.instructions).map((text) => new SystemMessage(text)),
    ...reinjectAuthoritativeFacts(request.authoritativeFacts).map(
      (text) => new SystemMessage(`[authoritative fact] ${text}`),
    ),
  ];
  return {
    messages: assembleMessages(preamble, compacted.segments, request.currentWork ?? null),
    toolSchema: reinjectToolSchema(request.toolSchema),
    compaction: compacted.outcome,
    segments: compacted.segments,
  };
}
