/**
 * IC-04：Coordinator chat model 装配
 * （Owner: `m1-run-coordinator-sessions`）。
 *
 * 这里只做一件事：把用户批准的 Coordinator Model Configuration 解析成**已安装** provider 集成的
 * 一个 chat model 实例，并把它原样交给 workflow。Companion 不维护 allowlist、不打包 provider、
 * 不保存凭据、不做 fallback；解析出来的实例就是调用路径本身，中间没有 Companion 代理层。
 *
 * 集成标识的形状是 `<module>#<export>`：模块与导出都由用户在配置里写死，解析失败就是启动失败，
 * 不会退到「猜一个 provider」。
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

import type { CoordinatorModelConfiguration } from '../../application/coordinator/model-config-switch.js';

/**
 * 内层重试必须关闭，否则会与 model node 的重试策略相乘（D15）。
 *
 * 关闭内层重试是装配方的责任，所以常量声明在这里；model node 只负责自己的有界重试。
 */
export const MODEL_INNER_RETRY_DISABLED = 0;

/** 集成标识的分隔符：`<module>#<export>`。 */
export const INTEGRATION_SEPARATOR = '#';

export const MODEL_RESOLUTION_FAILURE_CODES = [
  'invalid_integration_ref',
  'integration_unavailable',
  'integration_invalid',
  'construction_failed',
] as const;

export type ModelResolutionFailureCode = (typeof MODEL_RESOLUTION_FAILURE_CODES)[number];

/** 一个已解析的 provider 集成：它自己知道如何构造 chat model。 */
export type ProviderIntegration = {
  readonly integrationRef: string;
  readonly createChatModel: (input: {
    readonly model: string;
    readonly modelOptions: Readonly<Record<string, unknown>>;
  }) => BaseChatModel;
};

export type ProviderIntegrationResolver = (integrationRef: string) => ProviderIntegration | null;

export type ResolveChatModelResult =
  | { readonly kind: 'resolved'; readonly model: BaseChatModel; readonly configurationRef: string }
  | {
      readonly kind: 'rejected';
      readonly code: ModelResolutionFailureCode;
      readonly message: string;
    };

function splitIntegrationRef(integrationRef: string): { readonly module: string; readonly exportName: string } | null {
  const index = integrationRef.lastIndexOf(INTEGRATION_SEPARATOR);
  if (index <= 0 || index === integrationRef.length - 1) {
    return null;
  }
  return {
    module: integrationRef.slice(0, index),
    exportName: integrationRef.slice(index + 1),
  };
}

function isConstructable(value: unknown): value is new (options: Record<string, unknown>) => BaseChatModel {
  return typeof value === 'function';
}

/** 内层重试必须关闭；这是 D15 的唯一声明处，装配时统一注入。 */
export function chatModelOptionsFor(
  configuration: CoordinatorModelConfiguration,
): Record<string, unknown> {
  return {
    ...configuration.modelOptions,
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
): ResolveChatModelResult {
  const integration = resolver(configuration.providerIntegration);
  if (integration === null) {
    return {
      kind: 'rejected',
      code: 'integration_unavailable',
      message: `配置指向的 provider 集成不可用：${configuration.providerIntegration}`,
    };
  }
  try {
    const model = integration.createChatModel({
      model: configuration.model,
      modelOptions: chatModelOptionsFor(configuration),
    });
    return { kind: 'resolved', model, configurationRef: configuration.configurationRef };
  } catch (error) {
    return {
      kind: 'rejected',
      code: 'construction_failed',
      message: `无法用配置 ${configuration.configurationRef} 构造 chat model：${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * 异步解析器：先加载配置指向的模块，再按导出名构造实例。
 *
 * 这是 Bootstrap 使用的路径；加载失败、导出缺失或导出不可构造都在这里 fail closed。
 */
export function createModuleIntegrationResolverAsync(options: {
  readonly load?: (specifier: string) => Promise<unknown>;
} = {}): (integrationRef: string) => Promise<ProviderIntegration | null> {
  const load = options.load ?? ((specifier: string) => import(specifier));
  return async (integrationRef: string): Promise<ProviderIntegration | null> => {
    const parts = splitIntegrationRef(integrationRef);
    if (parts === null) {
      return null;
    }
    let loaded: unknown;
    try {
      loaded = await load(parts.module);
    } catch {
      return null;
    }
    const exported = (loaded as Record<string, unknown> | null)?.[parts.exportName];
    if (!isConstructable(exported)) {
      return null;
    }
    return {
      integrationRef,
      createChatModel: (input) =>
        // `model` 必须显式并入构造函数字段：集成不会从别处取模型名，漏掉它会静默落到集成自己的
        // 默认模型（OpenAI 集成即 `gpt-3.5-turbo`）上，而调用方以为配置生效了。
        new exported({ ...input.modelOptions, model: input.model }),
    };
  };
}
