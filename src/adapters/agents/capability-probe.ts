/**
 * IC-04：Coordinator 模型能力核验
 * （Owner: `m1-run-coordinator-sessions`）。
 *
 * 建立 Coordinator Session 之前，注入的 chat model 必须先通过五项核验：文本生成、流式输出、
 * tool calling、取消与可用 usage。任一必需能力缺失就以显式拒绝结束启动——不做降级、不换模型、
 * 不假装「部分可用」。
 *
 * 核验的是**路径可用性**而不是模型判断：tool calling 只要求绑定工具后的请求被接受且响应形状合法，
 * 不要求模型一定选择调用工具；那属于模型判断，不是能力。
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage } from '@langchain/core/messages';

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

/** 核验用的最小工具：只要求请求路径被接受，不要求模型真的调用它。 */
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

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`能力核验超过 ${String(timeoutMs)}ms`));
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

type ProbeOutcome = { readonly ok: boolean; readonly detail: string };

async function probeTextGeneration(model: BaseChatModel, timeoutMs: number): Promise<ProbeOutcome> {
  try {
    const response = await withTimeout(model.invoke([new HumanMessage('ping')]), timeoutMs);
    const content = (response as { readonly content?: unknown }).content;
    const text = typeof content === 'string' ? content : JSON.stringify(content ?? null);
    return text.length > 0
      ? { ok: true, detail: '文本生成返回非空响应' }
      : { ok: false, detail: '文本生成返回空响应' };
  } catch (error) {
    return { ok: false, detail: `文本生成失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

async function probeStreaming(model: BaseChatModel, timeoutMs: number): Promise<ProbeOutcome> {
  try {
    const stream = await withTimeout(
      Promise.resolve(model.stream([new HumanMessage('ping')])),
      timeoutMs,
    );
    const first = await withTimeout(stream[Symbol.asyncIterator]().next(), timeoutMs);
    return !first.done
      ? { ok: true, detail: '流式输出产生首个 chunk' }
      : { ok: false, detail: '流式输出没有产生任何 chunk' };
  } catch (error) {
    return { ok: false, detail: `流式输出失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

async function probeToolCalling(model: BaseChatModel, timeoutMs: number): Promise<ProbeOutcome> {
  const bindTools = (model as { readonly bindTools?: unknown }).bindTools;
  if (typeof bindTools !== 'function') {
    return { ok: false, detail: '模型实例没有 bindTools，无法声明工具调用能力' };
  }
  try {
    const bound = (bindTools as (tools: readonly unknown[]) => unknown).call(model, [CAPABILITY_PROBE_TOOL]) as {
      readonly invoke?: (input: unknown) => Promise<unknown>;
    };
    if (typeof bound.invoke !== 'function') {
      return { ok: false, detail: 'bindTools 返回的对象不能 invoke' };
    }
    const response = await withTimeout(bound.invoke([new HumanMessage('ping')]), timeoutMs);
    const toolCalls = (response as { readonly tool_calls?: unknown }).tool_calls;
    return Array.isArray(toolCalls)
      ? { ok: true, detail: '绑定工具后的请求被接受且响应形状合法' }
      : { ok: false, detail: '绑定工具后的响应缺少 tool_calls 字段' };
  } catch (error) {
    return { ok: false, detail: `tool calling 失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

async function probeCancellation(model: BaseChatModel, timeoutMs: number): Promise<ProbeOutcome> {
  const controller = new AbortController();
  controller.abort();
  try {
    await withTimeout(
      model.invoke([new HumanMessage('ping')], { signal: controller.signal }),
      timeoutMs,
    );
    return { ok: false, detail: '已取消的调用仍然成功返回，未观察到取消能力' };
  } catch {
    // 以已取消的 signal 调用并被拒绝，即取消路径可用。
    return { ok: true, detail: '以已取消的 signal 调用被拒绝' };
  }
}

function usageAvailabilityOf(response: unknown): boolean {
  const metadata = (response as { readonly usage_metadata?: unknown }).usage_metadata;
  if (typeof metadata !== 'object' || metadata === null) {
    return false;
  }
  return Object.values(metadata as Record<string, unknown>).some(
    (value) => typeof value === 'number' && Number.isFinite(value),
  );
}

async function probeUsage(model: BaseChatModel, timeoutMs: number): Promise<ProbeOutcome> {
  try {
    const response = await withTimeout(model.invoke([new HumanMessage('ping')]), timeoutMs);
    return usageAvailabilityOf(response)
      ? { ok: true, detail: '响应包含可用 usage 元数据' }
      : { ok: false, detail: '响应没有可用的 usage 元数据' };
  } catch (error) {
    return { ok: false, detail: `usage 探测失败：${error instanceof Error ? error.message : String(error)}` };
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
