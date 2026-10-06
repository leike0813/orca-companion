import { FakeListChatModel } from '@langchain/core/utils/testing';
import { expect, test } from 'vitest';

import type { CoordinatorModelConfiguration } from '../../src/application/coordinator/model-config-switch.js';
import {
  chatModelOptionsFor,
  createModuleIntegrationResolverAsync,
  INTEGRATION_SEPARATOR,
  MODEL_INNER_RETRY_DISABLED,
  resolveChatModel,
  type ExactContextCapability,
  type ProviderIntegrationResolver,
} from '../../src/adapters/agents/chat-model-factory.js';
import type { ProviderConnection } from '../../src/domain/model-configuration.js';
import type { CredentialStore } from '../../src/application/ports/credential-store.js';

/** credentialRef 是 z.uuid，夹具必须给真 UUID，否则 schema 会先拒掉、测不到工厂自己的分支。 */
const CREDENTIAL_REF = '11111111-2222-4333-8444-555555555555';

/**
 * 凭据端口由 bootstrap 注入，工厂不再有隐式默认实现；harness_login 的用例也要显式给一个
 * 永不读取的 fake，避免测试又依赖本机 XDG 凭据文件。
 */
const unusedCredentials: Pick<CredentialStore, 'read'> = {
  read: () => ({ kind: 'rejected', code: 'credential_missing', message: 'missing' }),
};

const managedConnection: ProviderConnection = {
  connectionRef: 'connection:test', label: 'test', providerIntegration: 'mock#ChatModel',
  modelOptions: { configuration: { baseURL: 'https://example.invalid/v1' } },
  credential: { kind: 'managed', credentialRef: CREDENTIAL_REF, optionPath: 'apiKey' },
};

test('installed integration exposes its explicit exact context capability for the resolved model', async () => {
  const requests: Parameters<ExactContextCapability['measure']>[0][] = [];
  class InstalledModel extends FakeListChatModel {
    static companionExactContext: ExactContextCapability = {
      measure: input => {
        requests.push(input);
        return Promise.resolve({ used: 42, capacity: 128000 });
      },
    };
  }
  const moduleResolver = createModuleIntegrationResolverAsync({ load: () => Promise.resolve({ InstalledModel }) });
  const integration = await moduleResolver('installed#InstalledModel');
  const result = resolveChatModel(configuration({ modelOptions: { responses: ['ok'] } }), () => integration, unusedCredentials);
  if (result.kind !== 'resolved' || result.exactContext === null) throw new Error('exact capability missing');
  const messages = [{ role: 'system', content: 'instructions' }, { role: 'user', content: '中文🙂' }];
  const tools = [{ name: 'read', schema: { type: 'object' } }];
  const observed = await result.exactContext.measure({ model: result.model, messages, tools });
  expect(observed).toEqual({ used: 42, capacity: 128000 });
  expect(requests[0]).toMatchObject({ model: result.model, messages, tools });
});

test('ordinary tokenizer and usage support never claim an exact context capability', async () => {
  const resolver = createModuleIntegrationResolverAsync({ load: () => Promise.resolve({ OrdinaryModel: FakeListChatModel }) });
  const integration = await resolver('installed#OrdinaryModel');
  const result = resolveChatModel(configuration({ modelOptions: { responses: ['ok'] } }), () => integration, unusedCredentials);
  expect(result).toMatchObject({ kind: 'resolved', exactContext: null });
});

test('installed integration exposes optional native compaction and keepalive; absent or invalid 一律 null', async () => {
  class InstalledModel extends FakeListChatModel {
    static companionNativeCompaction = { compact: () => Promise.resolve(null) };
    static companionKeepalive = { intervalMs: 60_000, keepalive: () => Promise.resolve(true) };
  }
  const moduleResolver = createModuleIntegrationResolverAsync({ load: () => Promise.resolve({ InstalledModel }) });
  const integration = await moduleResolver('installed#InstalledModel');
  const resolved = resolveChatModel(configuration({ modelOptions: { responses: ['ok'] } }), () => integration, unusedCredentials);
  expect(resolved.kind).toBe('resolved');
  if (resolved.kind !== 'resolved') return;
  expect(resolved.nativeCompaction).not.toBeNull();
  expect(resolved.keepalive?.intervalMs).toBe(60_000);

  // 缺能力的集成保持 unavailable，绝不猜 provider 私有接口。
  const plainResolver = createModuleIntegrationResolverAsync({ load: () => Promise.resolve({ Plain: FakeListChatModel }) });
  const plain = await plainResolver('installed#Plain');
  expect(resolveChatModel(configuration({ modelOptions: { responses: ['ok'] } }), () => plain, unusedCredentials)).toMatchObject({
    kind: 'resolved',
    nativeCompaction: null,
    keepalive: null,
  });

  // 间隔不是正安全整数的能力视为无效，同样 unavailable。
  class BadKeepalive extends FakeListChatModel {
    static companionKeepalive = { intervalMs: 0, keepalive: () => Promise.resolve(true) };
  }
  const badResolver = createModuleIntegrationResolverAsync({ load: () => Promise.resolve({ BadKeepalive }) });
  const bad = await badResolver('installed#BadKeepalive');
  expect(resolveChatModel(configuration({ modelOptions: { responses: ['ok'] } }), () => bad, unusedCredentials)).toMatchObject({
    kind: 'resolved',
    keepalive: null,
  });
});

test('rejects credential-bearing options before resolving a provider', () => {
  let constructed = false;
  const result = resolveChatModel(configuration({ modelOptions: { headers: [{ api_key: 'secret-fixture' }] } }), () => {
    constructed = true;
    return null;
  }, unusedCredentials);
  expect(result).toMatchObject({ kind: 'rejected', code: 'invalid_model_options' });
  expect(constructed).toBe(false);
  expect(JSON.stringify(result)).not.toContain('secret-fixture');
});

test('injects the exact credential and independently selected effort only at model construction', () => {
  let received: Readonly<Record<string, unknown>> | null = null;
  const original = configuration({ providerConnection: managedConnection, credentialRefs: [CREDENTIAL_REF],
    effort: 'high', effortCapability: { values: ['low', 'high'], source: 'verified:model', optionPath: 'reasoning.effort' } });
  const result = resolveChatModel(original, () => ({ integrationRef: 'mock#ChatModel', createChatModel: (input) => {
    received = input.modelOptions;
    return new FakeListChatModel({ responses: ['ok'] });
  } }), { read: (ref) => ref === CREDENTIAL_REF ? { kind: 'resolved', secret: 'secret-fixture' }
    : { kind: 'rejected', code: 'credential_missing', message: 'missing' } });
  expect(result.kind).toBe('resolved');
  expect(received).toMatchObject({ apiKey: 'secret-fixture', reasoning: { effort: 'high' }, maxRetries: 0 });
  expect(JSON.stringify(original)).not.toContain('secret-fixture');
});

test('rejects missing credentials and redacts provider construction failures', () => {
  const candidate = configuration({ providerConnection: managedConnection, credentialRefs: [CREDENTIAL_REF] });
  const resolver = () => ({ integrationRef: 'mock#ChatModel', createChatModel: () => { throw new Error('secret-fixture'); } });
  expect(resolveChatModel(candidate, resolver, { read: () => ({ kind: 'rejected', code: 'credential_missing', message: 'missing' }) }))
    .toMatchObject({ kind: 'rejected', code: 'credential_unavailable' });
  const failed = resolveChatModel(candidate, resolver, { read: () => ({ kind: 'resolved', secret: 'secret-fixture' }) });
  expect(failed).toMatchObject({ kind: 'rejected', code: 'construction_failed' });
  expect(JSON.stringify(failed)).not.toContain('secret-fixture');
});

function configuration(overrides: Partial<CoordinatorModelConfiguration> = {}): CoordinatorModelConfiguration {
  return {
    configurationRef: 'coordinator-default',
    providerIntegration: '@langchain/openai#ChatOpenAI',
    model: 'MiniMax-M3',
    modelOptions: { temperature: 0 },
    credentialRefs: [],
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

  const result = resolveChatModel(configuration(), resolver, unusedCredentials);

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
  const result = resolveChatModel(configuration({ providerIntegration: '@acme/unknown#Client' }), () => null, unusedCredentials);

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

  const result = resolveChatModel(configuration(), resolver, unusedCredentials);

  expect(result.kind).toBe('rejected');
  if (result.kind === 'rejected') {
    expect(result.code).toBe('construction_failed');
    expect(result.message).toContain('连接');
  }
});

test('配置里只有凭据引用，没有凭据值可以落盘', () => {
  const config = configuration();
  const serialized = JSON.stringify(config);

  expect(config.credentialRefs).toEqual([]);
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
