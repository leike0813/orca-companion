import { FakeListChatModel } from '@langchain/core/utils/testing';
import { expect, test } from 'vitest';

import type { CoordinatorModelConfiguration } from '../../src/application/coordinator/model-config-switch.js';
import {
  chatModelOptionsFor,
  createModuleIntegrationResolverAsync,
  INTEGRATION_SEPARATOR,
  MODEL_INNER_RETRY_DISABLED,
  resolveChatModel,
  type ProviderIntegrationResolver,
} from '../../src/adapters/agents/chat-model-factory.js';

function configuration(overrides: Partial<CoordinatorModelConfiguration> = {}): CoordinatorModelConfiguration {
  return {
    configurationRef: 'coordinator-default',
    providerIntegration: '@langchain/openai#ChatOpenAI',
    model: 'MiniMax-M3',
    modelOptions: { temperature: 0 },
    credentialRefs: ['env:MINIMAX_API_KEY'],
    nativeWindowOwnerRef: null,
    ...overrides,
  };
}

test('从配置构造的实例就是请求路径，Companion 不包装也不代理', () => {
  const created = new FakeListChatModel({ responses: ['ok'] });
  let received: { readonly model: string; readonly modelOptions: Readonly<Record<string, unknown>> } | null = null;
  const resolver: ProviderIntegrationResolver = (integrationRef) => ({
    integrationRef,
    createChatModel: (input) => {
      received = input;
      return created;
    },
  });

  const result = resolveChatModel(configuration(), resolver);

  expect(result.kind).toBe('resolved');
  if (result.kind === 'resolved') {
    // 同一个对象，不是包装层：调用直达注入的实例。
    expect(result.model).toBe(created);
    expect(result.configurationRef).toBe('coordinator-default');
  }
  expect(received).toEqual({
    model: 'MiniMax-M3',
    modelOptions: { temperature: 0, model: 'MiniMax-M3', maxRetries: MODEL_INNER_RETRY_DISABLED },
  });
});

test('内层重试在装配时统一关闭，避免与 model node 的重试相乘', () => {
  const options = chatModelOptionsFor(configuration({ modelOptions: { temperature: 0.2 } }));

  expect(options['maxRetries']).toBe(0);
  expect(options['model']).toBe('MiniMax-M3');
  expect(options['temperature']).toBe(0.2);
});

test('配置指向的集成不可用时拒绝，不改用其他模型或环境凭据', () => {
  const result = resolveChatModel(configuration({ providerIntegration: '@acme/unknown#Client' }), () => null);

  expect(result.kind).toBe('rejected');
  if (result.kind === 'rejected') {
    expect(result.code).toBe('integration_unavailable');
    expect(result.message).toContain('@acme/unknown#Client');
  }
});

test('构造实例失败时以可操作诊断拒绝，而不是返回半成品', () => {
  const resolver: ProviderIntegrationResolver = (integrationRef) => ({
    integrationRef,
    createChatModel: () => {
      throw new Error('缺少 baseURL');
    },
  });

  const result = resolveChatModel(configuration(), resolver);

  expect(result.kind).toBe('rejected');
  if (result.kind === 'rejected') {
    expect(result.code).toBe('construction_failed');
    expect(result.message).toContain('缺少 baseURL');
  }
});

test('配置里只有凭据引用，没有凭据值可以落盘', () => {
  const config = configuration();
  const serialized = JSON.stringify(config);

  expect(config.credentialRefs).toEqual(['env:MINIMAX_API_KEY']);
  expect(serialized).not.toContain('apiKey');
  expect(serialized).not.toContain('secret');
  expect(serialized).not.toContain('token');
});

test('模块解析器加载配置里的模块与导出，不查内置清单', async () => {
  const created = new FakeListChatModel({ responses: ['ok'] });
  const loaded: string[] = [];
  const resolver = createModuleIntegrationResolverAsync({
    load: (specifier) => {
      loaded.push(specifier);
      return Promise.resolve({ ChatOpenAI: class { readonly instance = created; } });
    },
  });

  const integration = await resolver(`@langchain/openai${INTEGRATION_SEPARATOR}ChatOpenAI`);

  expect(loaded).toEqual(['@langchain/openai']);
  expect(integration).not.toBeNull();
  expect(integration?.integrationRef).toBe('@langchain/openai#ChatOpenAI');
});

test('导出缺失、模块不可加载或标识非法时解析失败，不猜测', async () => {
  const missingExport = createModuleIntegrationResolverAsync({
    load: () => Promise.resolve({ SomethingElse: class {} }),
  });
  expect(await missingExport('@langchain/openai#ChatOpenAI')).toBeNull();

  const unloadable = createModuleIntegrationResolverAsync({
    load: () => Promise.reject(new Error('模块不存在')),
  });
  expect(await unloadable('@langchain/openai#ChatOpenAI')).toBeNull();

  const malformed = createModuleIntegrationResolverAsync({
    load: () => Promise.resolve({ ChatOpenAI: class {} }),
  });
  expect(await malformed('@langchain/openai')).toBeNull();
  expect(await malformed('#ChatOpenAI')).toBeNull();
  expect(await malformed('@langchain/openai#')).toBeNull();
});

test('模块解析器把配置里的模型名一起传给集成构造函数', async () => {
  const received: Record<string, unknown>[] = [];
  const resolver = createModuleIntegrationResolverAsync({
    load: () =>
      Promise.resolve({
        ChatOpenAI: class {
          constructor(options: Record<string, unknown>) {
            received.push(options);
          }
        },
      }),
  });
  const integration = await resolver(`@langchain/openai${INTEGRATION_SEPARATOR}ChatOpenAI`);
  expect(integration).not.toBeNull();

  const model = configuration({ model: 'MiniMax-M3' });
  integration?.createChatModel({ model: model.model, modelOptions: chatModelOptionsFor(model) });

  // 漏掉 model 会让集成静默落到它自己的默认模型（OpenAI 集成即 gpt-3.5-turbo），
  // 而调用方以为配置生效了。
  expect(received[0]?.['model']).toBe('MiniMax-M3');
  expect(received[0]?.['maxRetries']).toBe(MODEL_INNER_RETRY_DISABLED);
});
