/**
 * IC-04：Coordinator chat model 装配
 * （Owner: `m1-run-coordinator-sessions`）。
 *
 * 从完整不可变配置构造内置固定协议模型，凭据只在此解析；模型直接调用选定端点。
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatOpenAICompletions, ChatOpenAIResponses } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatGoogle } from '@langchain/google';

import { coordinatorModelConfigurationSchema, type CoordinatorModelConfiguration } from '../../application/coordinator/model-config-switch.js';
import type { CredentialStore } from '../../application/ports/credential-store.js';
import { providerProtocolSchema, withModelOption } from '../../domain/model-configuration.js';
import type { NativeWindowItemRef } from '../../domain/coordinator/session-state.js';

/**
 * 内层重试必须关闭，否则会与 model node 的重试策略相乘（D15）。
 *
 * 关闭内层重试是装配方的责任，所以常量声明在这里；model node 只负责自己的有界重试。
 */
export const MODEL_INNER_RETRY_DISABLED = 0;


export const MODEL_RESOLUTION_FAILURE_CODES = [
  'invalid_integration_ref',
  'integration_unavailable',
  'integration_invalid',
  'construction_failed',
  'credential_unavailable',
  'invalid_effort',
  'invalid_model_options',
] as const;

export type ModelResolutionFailureCode = (typeof MODEL_RESOLUTION_FAILURE_CODES)[number];

/** Explicit installed-integration capability; approximate BaseChatModel tokenizers do not qualify. */
export type ExactContextCapability = {
  readonly measure: (input: {
    readonly model: BaseChatModel;
    readonly messages: readonly unknown[];
    readonly tools: readonly unknown[];
    readonly signal?: AbortSignal;
  }) => Promise<{ readonly used: number; readonly capacity: number } | null>;
};

function exactContextCapability(value: unknown): ExactContextCapability | null {
  if (typeof value !== 'object' || value === null || !('measure' in value) || typeof value.measure !== 'function') return null;
  return value as ExactContextCapability;
}

/**
 * Provider 原生压缩能力。
 *
 * 输入是**完整有效输入与 tools**，输出是不透明窗口项与 provider 报告的规模；Companion 不解析、
 * 不重写这些项。这是集成显式导出的能力，不读 `BaseChatModel` 私有字段，也不从 tokenizer 反推。
 * 返回 `null` 表示本次没有可用的原生压缩（例如 provider 拒绝），调用方按「无进展」处理。
 */
export type NativeCompactionCapability = {
  readonly compact: (input: {
    readonly messages: readonly unknown[];
    readonly tools: readonly unknown[];
    readonly signal?: AbortSignal;
  }) => Promise<NativeCompactionResult | null>;
};

export type NativeCompactionResult = {
  readonly ownerRef: string;
  /** 不透明窗口项：身份与位置由 Companion 记录，内容原样携带、永不解析。 */
  readonly items: readonly NativeWindowItemRef[];
  readonly compactedTokens: number;
};

/**
 * 缓存保活能力。
 *
 * `intervalMs` 是 provider 提供的可信间隔（正安全整数），宿主按它调度；动作接收 `AbortSignal`，
 * 控制状态变化、出现真实工作、失去 fencing 或退出时立即让位。没有这个能力的集成一律 unavailable。
 */
export type KeepaliveCapability = {
  readonly intervalMs: number;
  readonly keepalive: (input: { readonly signal: AbortSignal }) => Promise<boolean>;
};

function nativeCompactionCapability(value: unknown): NativeCompactionCapability | null {
  if (typeof value !== 'object' || value === null) return null;
  return typeof (value as { readonly compact?: unknown }).compact === 'function'
    ? (value as NativeCompactionCapability)
    : null;
}

function keepaliveCapability(value: unknown): KeepaliveCapability | null {
  if (typeof value !== 'object' || value === null) return null;
  const intervalMs = (value as { readonly intervalMs?: unknown }).intervalMs;
  const action = (value as { readonly keepalive?: unknown }).keepalive;
  if (typeof intervalMs !== 'number' || !Number.isSafeInteger(intervalMs) || intervalMs <= 0) return null;
  if (typeof action !== 'function') return null;
  return value as KeepaliveCapability;
}

/** 一个已解析的 provider 集成：它自己知道如何构造 chat model。 */
export type ProviderIntegration = {
  readonly integrationRef: string;
  readonly exactContext?: ExactContextCapability;
  readonly nativeCompaction?: NativeCompactionCapability;
  readonly keepalive?: KeepaliveCapability;
  readonly createChatModel: (input: {
    readonly model: string;
    readonly modelOptions: Readonly<Record<string, unknown>>;
  }) => BaseChatModel;
};

export type ProviderIntegrationResolver = (integrationRef: string) => ProviderIntegration | null;

export type ResolveChatModelResult =
  | { readonly kind: 'resolved'; readonly model: BaseChatModel; readonly configurationRef: string;
      readonly exactContext: ExactContextCapability | null;
      readonly nativeCompaction: NativeCompactionCapability | null;
      readonly keepalive: KeepaliveCapability | null }
  | {
      readonly kind: 'rejected';
      readonly code: ModelResolutionFailureCode;
      readonly message: string;
    };


/** 内层重试必须关闭；这是 D15 的唯一声明处，装配时统一注入。 */
export function chatModelOptionsFor(
  configuration: CoordinatorModelConfiguration,
): Record<string, unknown> {
  return {
    model: configuration.model,
    maxRetries: MODEL_INNER_RETRY_DISABLED,
  };
}

/**
 * 从配置构造 chat model 实例。
 *
 * 返回的实例就是请求路径：Companion 不包装、不缓存凭据、不改写响应。
 */
export function resolveChatModel(
  configuration: CoordinatorModelConfiguration,
  resolver: ProviderIntegrationResolver,
  /** 凭据来源由 bootstrap 显式注入。 */
  credentials: Pick<CredentialStore, 'read'>,
): ResolveChatModelResult {
  if (!coordinatorModelConfigurationSchema.safeParse(configuration).success) {
    return { kind: 'rejected', code: 'invalid_model_options', message: '模型配置结构无效' };
  }
  const integration = resolver(configuration.providerIntegration);
  if (integration === null) {
    return {
      kind: 'rejected',
      code: 'integration_unavailable',
      message: `配置指向的 provider 集成不可用：${configuration.providerIntegration}`,
    };
  }
  try {
    const connection = configuration.providerConnection;
    if (connection === undefined || connection.providerIntegration !== configuration.providerIntegration ||
      configuration.credentialRefs.length !== 1 || configuration.credentialRefs[0] !== connection.credential.credentialRef) {
      return { kind: 'rejected', code: 'credential_unavailable', message: '模型配置需要完整的连接与凭据绑定' };
    }
    let modelOptions = chatModelOptionsFor(configuration);
    const credential = connection?.credential;
    if (credential?.kind === 'managed') {
      const resolved = credentials.read(credential.credentialRef);
      if (resolved.kind !== 'resolved') {
        return { kind: 'rejected', code: 'credential_unavailable', message: '配置的凭据无法解析，请检查用户凭据存储' };
      }
      modelOptions.apiKey = resolved.secret;
      if (configuration.providerIntegration.startsWith('openai-')) modelOptions.configuration = { baseURL: connection?.baseUrl };
      else if (configuration.providerIntegration === 'anthropic-messages') modelOptions.anthropicApiUrl = connection.baseUrl.replace(/\/v1\/?$/, '');
      else modelOptions.endpoint = connection?.baseUrl;
      if (configuration.providerIntegration === 'openai-responses') {
        modelOptions.zdrEnabled = true;
        modelOptions.modelKwargs = { include: ['reasoning.encrypted_content'] };
      }
    } else if (configuration.credentialRefs.length > 0 && connection === undefined) {
      return { kind: 'rejected', code: 'credential_unavailable', message: '凭据引用缺少明确的连接绑定' };
    }
    if (configuration.effort !== undefined && configuration.effort !== null) {
      const capability = configuration.effortCapability;
      if (capability === undefined || capability === null || !capability.values.includes(configuration.effort)) {
        return { kind: 'rejected', code: 'invalid_effort', message: '推理强度缺少可信能力来源' };
      }
      const optionPath = configuration.providerIntegration.startsWith('openai-') && capability.optionPath === 'reasoningEffort'
        ? 'reasoning.effort' : capability.optionPath;
      modelOptions = withModelOption(modelOptions, optionPath, configuration.effort);
    }
    const model = integration.createChatModel({
      model: configuration.model,
      modelOptions,
    });
    return { kind: 'resolved', model, configurationRef: configuration.configurationRef,
      exactContext: exactContextCapability(integration.exactContext),
      nativeCompaction: nativeCompactionCapability(integration.nativeCompaction),
      keepalive: keepaliveCapability(integration.keepalive) };
  } catch {
    return {
      kind: 'rejected',
      code: 'construction_failed',
      message: '无法构造配置的 chat model，请核验连接、模型和非秘密选项',
    };
  }
}

/**
 * 固定协议注册表；load 仅为宿主显式注入测试/能力实现的 seam。
 */
export function createBuiltinIntegrationResolverAsync(options: {
  readonly load?: (specifier: string) => Promise<unknown>;
} = {}): (integrationRef: string) => Promise<ProviderIntegration | null> {
  return async (integrationRef: string): Promise<ProviderIntegration | null> => {
    const parsed = providerProtocolSchema.safeParse(integrationRef);
    if (!parsed.success) return null;
    const builtins = {
      'openai-chat': ChatOpenAICompletions,
      'openai-responses': ChatOpenAIResponses,
      'anthropic-messages': ChatAnthropic,
      'google-gemini': ChatGoogle,
    };
    let loaded: unknown;
    try { loaded = options.load === undefined ? null : await options.load(integrationRef); }
    catch { return null; }
    const exported = loaded === null ? builtins[parsed.data] :
      typeof loaded === 'function' ? loaded : (loaded as Record<string, unknown>)?.[builtins[parsed.data].name];
    if (typeof exported !== 'function') return null;
    const context = exactContextCapability('companionExactContext' in exported ? exported.companionExactContext : null);
    const compaction = nativeCompactionCapability('companionNativeCompaction' in exported ? exported.companionNativeCompaction : null);
    const keepalive = keepaliveCapability('companionKeepalive' in exported ? exported.companionKeepalive : null);
    return {
      integrationRef,
      ...(context === null ? {} : { exactContext: context }),
      ...(compaction === null ? {} : { nativeCompaction: compaction }),
      ...(keepalive === null ? {} : { keepalive }),
      createChatModel: (input) =>
        // `model` 必须显式并入构造函数字段：集成不会从别处取模型名，漏掉它会静默落到集成自己的
        // 默认模型（OpenAI 集成即 `gpt-3.5-turbo`）上，而调用方以为配置生效了。
        new (exported as new (options: Record<string, unknown>) => BaseChatModel)({ ...input.modelOptions, model: input.model }),
    };
  };
}
