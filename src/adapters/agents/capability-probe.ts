/**
 * IC-04：Coordinator 模型能力核验
 * （Owner: `m1-run-coordinator-sessions`）。
 *
 * 建立 Coordinator Session 之前，注入的 chat model 必须先通过五项核验：文本生成、流式输出、
 * tool calling、取消与可用 usage。任一必需能力缺失就以显式拒绝结束启动——不做降级、不换模型、
 * 不假装「部分可用」。
 *
 * 核验真实工具调用和配对结果续接，避免把「工具参数被接受」误当成可用能力。
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { ModelAbortError } from '@langchain/core/errors';

export const REQUIRED_MODEL_CAPABILITIES = [
  'text_generation',
  'streaming',
  'tool_calling',
  'cancellation',
  'usage',
] as const;

export type ModelCapability = (typeof REQUIRED_MODEL_CAPABILITIES)[number];

export type ModelCapabilityReport = {
  readonly modelRef: string;
  readonly capabilities: Readonly<Record<ModelCapability, boolean>>;
  /** 未通过必需能力的名字，按 `REQUIRED_MODEL_CAPABILITIES` 顺序。 */
  readonly missing: readonly ModelCapability[];
  readonly details: readonly string[];
};

export type ModelCapabilityVerification =
  | { readonly kind: 'verified'; readonly report: ModelCapabilityReport }
  | {
      readonly kind: 'rejected';
      readonly reason: 'capability_missing';
      readonly report: ModelCapabilityReport;
      readonly missing: readonly ModelCapability[];
      readonly message: string;
    };

/** 核验用的无副作用工具。 */
export const CAPABILITY_PROBE_TOOL = {
  name: 'capability_probe',
  description: '核验 tool calling 路径可用性；调用方不应依赖它的副作用',
  schema: { type: 'object', properties: {}, additionalProperties: false },
} as const;

export type VerifyModelCapabilitiesOptions = {
  readonly modelRef?: string;
  /** 单次探测的上限；超时即视为该项能力缺失。 */
  readonly timeoutMs?: number;
};

const DEFAULT_PROBE_TIMEOUT_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 250;
const MAX_STREAM_CHUNKS = 256;
const MAX_STREAM_BYTES = 1024 * 1024;

class ProbeTimeoutError extends Error {}

function withTimeout<T>(work: Promise<T>, timeoutMs: number, controller: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new ProbeTimeoutError());
    }, timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function safeFailure(): string {
  return '请求失败或超时';
}

function visibleText(value: unknown): string {
  const content = (value as { readonly content?: unknown } | null)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (typeof block === 'string') return block;
    if (typeof block !== 'object' || block === null) return '';
    const item = block as { readonly type?: unknown; readonly text?: unknown };
    return item.type === 'text' && typeof item.text === 'string' ? item.text : '';
  }).join('');
}

function streamBytes(value: unknown): number {
  const message = value as { readonly content?: unknown; readonly additional_kwargs?: unknown } | null;
  let bytes = 0;
  for (const item of [message?.content, message?.additional_kwargs]) {
    if (typeof item === 'string') bytes += Buffer.byteLength(item, 'utf8');
    else if (item !== null && typeof item === 'object') bytes += Buffer.byteLength(JSON.stringify(item) ?? '', 'utf8');
  }
  return bytes;
}

type ProbeOutcome = { readonly ok: boolean; readonly detail: string };

async function probeTextGeneration(model: BaseChatModel, timeoutMs: number): Promise<ProbeOutcome> {
  try {
    const controller = new AbortController();
    const response = await withTimeout(model.invoke([new HumanMessage('ping')], { signal: controller.signal }), timeoutMs, controller);
    const text = visibleText(response);
    return text.trim().length > 0
      ? { ok: true, detail: '文本生成返回非空响应' }
      : { ok: false, detail: '文本生成返回空响应' };
  } catch {
    return { ok: false, detail: `文本生成失败：${safeFailure()}` };
  }
}

async function probeStreaming(model: BaseChatModel, timeoutMs: number): Promise<ProbeOutcome> {
  const deadline = Date.now() + timeoutMs;
  const controller = new AbortController();
  try {
    const stream = await withTimeout(Promise.resolve(model.stream([new HumanMessage('ping')], { signal: controller.signal })), Math.max(1, deadline - Date.now()), controller);
    const iterator = stream[Symbol.asyncIterator]();
    try {
      let chunks = 0;
      let bytes = 0;
      while (chunks < MAX_STREAM_CHUNKS && bytes <= MAX_STREAM_BYTES) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new ProbeTimeoutError();
        const next = await withTimeout(iterator.next(), remaining, controller);
        if (next.done) return { ok: false, detail: '流式输出结束前没有产生非空文本' };
        chunks += 1;
        bytes += streamBytes(next.value);
        if (bytes > MAX_STREAM_BYTES) return { ok: false, detail: '流式输出超过探测字节上限' };
        if (visibleText(next.value).trim().length > 0) return { ok: true, detail: '流式输出产生非空文本 chunk' };
      }
      return { ok: false, detail: '流式输出超过探测 chunk 上限' };
    } finally {
      controller.abort();
      try {
        if (iterator.return !== undefined) await withTimeout(Promise.resolve(iterator.return()), CLEANUP_TIMEOUT_MS, controller);
      } catch { /* cleanup remains bounded even when an iterator ignores cancellation */ }
    }
  } catch {
    return { ok: false, detail: `流式输出失败：${safeFailure()}` };
  }
}

async function probeToolCalling(model: BaseChatModel, timeoutMs: number): Promise<ProbeOutcome> {
  const bindTools = (model as { readonly bindTools?: unknown }).bindTools;
  if (typeof bindTools !== 'function') {
    return { ok: false, detail: '模型实例没有 bindTools，无法声明工具调用能力' };
  }
  try {
    const bound = (bindTools as (tools: readonly unknown[], options: unknown) => unknown).call(model, [CAPABILITY_PROBE_TOOL], { tool_choice: CAPABILITY_PROBE_TOOL.name }) as {
      readonly invoke?: (input: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>;
    };
    if (typeof bound.invoke !== 'function') {
      return { ok: false, detail: 'bindTools 返回的对象不能 invoke' };
    }
    const controller = new AbortController();
    const response = await withTimeout(bound.invoke([new HumanMessage('Call the capability_probe tool.')], { signal: controller.signal }), timeoutMs, controller);
    if (!(response instanceof AIMessage)) return { ok: false, detail: '工具调用没有返回 assistant 消息' };
    const toolCalls = (response as { readonly tool_calls?: unknown } | null)?.tool_calls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return { ok: false, detail: '模型没有返回真实工具调用' };
    const ids = new Set<string>();
    const toolMessages: ToolMessage[] = [];
    for (const call of toolCalls) {
      const item = call as { id?: unknown; name?: unknown; args?: unknown } | null;
      if (typeof item?.id !== 'string' || item.id.length === 0 || ids.has(item.id) || item.name !== CAPABILITY_PROBE_TOOL.name || typeof item.args !== 'object' || item.args === null || Object.keys(item.args).length !== 0) {
        return { ok: false, detail: '模型工具调用结构不匹配' };
      }
      ids.add(item.id);
      toolMessages.push(new ToolMessage({ content: 'probe accepted', tool_call_id: item.id, name: CAPABILITY_PROBE_TOOL.name }));
    }
    const continuationModel = (bindTools as (tools: readonly unknown[], options: unknown) => unknown).call(model, [CAPABILITY_PROBE_TOOL], { tool_choice: 'auto' }) as {
      readonly invoke?: (input: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>;
    };
    if (typeof continuationModel.invoke !== 'function') return { ok: false, detail: '续接模型不能 invoke' };
    const continued = await withTimeout(continuationModel.invoke([
      new HumanMessage('Call the capability_probe tool.'),
      response,
      ...toolMessages,
    ], { signal: controller.signal }), timeoutMs, controller);
    return continued instanceof AIMessage && visibleText(continued).trim().length > 0
      ? { ok: true, detail: '真实工具调用及 ToolMessage 续接成功' }
      : { ok: false, detail: 'ToolMessage 续接未返回有效响应' };
  } catch {
    return { ok: false, detail: `tool calling 失败：${safeFailure()}` };
  }
}

async function probeCancellation(model: BaseChatModel, timeoutMs: number): Promise<ProbeOutcome> {
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), 0);
  try {
    const request = model.invoke([new HumanMessage('capability cancellation probe')], { signal: controller.signal });
    await withTimeout(request, timeoutMs, controller);
    return { ok: false, detail: '已取消的调用仍然成功返回，未观察到取消能力' };
  } catch (error) {
    if (error instanceof ProbeTimeoutError || !(error instanceof Error && (error.name === 'AbortError' || ModelAbortError.isInstance(error)))) return { ok: false, detail: `取消请求失败：${safeFailure()}` };
    return { ok: true, detail: '以已取消的 signal 调用被拒绝' };
  } finally {
    clearTimeout(abortTimer);
  }
}

function usageAvailabilityOf(response: unknown): boolean {
  const metadata = (response as { readonly usage_metadata?: unknown }).usage_metadata;
  if (typeof metadata !== 'object' || metadata === null) {
    return false;
  }
  const values = metadata as Record<string, unknown>;
  const count = (key: string): number | null => {
    const value = values[key];
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  const input = count('input_tokens');
  const output = count('output_tokens');
  const total = count('total_tokens');
  return input !== null && output !== null && total !== null && input + output === total;
}

async function probeUsage(model: BaseChatModel, timeoutMs: number): Promise<ProbeOutcome> {
  try {
    const controller = new AbortController();
    const response = await withTimeout(model.invoke([new HumanMessage('ping')], { signal: controller.signal }), timeoutMs, controller);
    return usageAvailabilityOf(response)
      ? { ok: true, detail: '响应包含可用 usage 元数据' }
      : { ok: false, detail: '响应没有可用的 usage 元数据' };
  } catch {
    return { ok: false, detail: `usage 探测失败：${safeFailure()}` };
  }
}

/**
 * 执行五项核验。
 *
 * 全部通过才返回 `verified`；否则返回 `rejected` 并列出缺失能力，调用方必须据此拒绝启动。
 */
export async function verifyModelCapabilities(
  model: BaseChatModel,
  options: VerifyModelCapabilitiesOptions = {},
): Promise<ModelCapabilityVerification> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const outcomes: Record<ModelCapability, ProbeOutcome> = {
    text_generation: await probeTextGeneration(model, timeoutMs),
    streaming: await probeStreaming(model, timeoutMs),
    tool_calling: await probeToolCalling(model, timeoutMs),
    cancellation: await probeCancellation(model, timeoutMs),
    usage: await probeUsage(model, timeoutMs),
  };

  const capabilities = Object.fromEntries(
    REQUIRED_MODEL_CAPABILITIES.map((capability) => [capability, outcomes[capability].ok]),
  ) as Record<ModelCapability, boolean>;
  const missing = REQUIRED_MODEL_CAPABILITIES.filter((capability) => !capabilities[capability]);
  const report: ModelCapabilityReport = {
    modelRef: options.modelRef ?? 'coordinator-model-configuration',
    capabilities,
    missing,
    details: REQUIRED_MODEL_CAPABILITIES.map(
      (capability) => `${capability}: ${outcomes[capability].detail}`,
    ),
  };

  if (missing.length > 0) {
    return {
      kind: 'rejected',
      reason: 'capability_missing',
      report,
      missing,
      message: `注入的模型缺少必需能力：${missing.join(', ')}`,
    };
  }
  return { kind: 'verified', report };
}
