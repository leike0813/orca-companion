import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { ChatOpenAICompletions, ChatOpenAIResponses } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { expect, test } from 'vitest';
import { createBuiltinIntegrationResolverAsync, resolveChatModel, type ProviderIntegration, type ExactContextCapability } from '../../src/adapters/agents/chat-model-factory.js';
import type { CoordinatorModelConfiguration } from '../../src/application/coordinator/model-config-switch.js';
import type { ProviderProtocol } from '../../src/domain/model-configuration.js';

const ref = '11111111-2222-4333-8444-555555555555';
const credentials = { read: () => ({ kind: 'resolved' as const, secret: 'fixture-secret' }) };
function configuration(protocol: ProviderProtocol = 'openai-chat'): CoordinatorModelConfiguration {
  return { configurationRef: 'config-1', providerIntegration: protocol, model: 'exact-model',
    credentialRefs: [ref], nativeWindowOwnerRef: null, modelRef: 'model-1',
    providerConnection: { connectionRef: 'connection-1', label: 'test', providerId: 'custom',
      providerIntegration: protocol, baseUrl: 'https://example.invalid/v1', credential: { kind: 'managed', credentialRef: ref } } };
}

test.each(['openai-chat', 'openai-responses', 'anthropic-messages', 'google-gemini'] as const)('bundled %s resolves without user-installed modules', async protocol => {
  const resolver = createBuiltinIntegrationResolverAsync();
  const integration = await resolver(protocol);
  const result = resolveChatModel(configuration(protocol), () => integration, credentials);
  expect(result.kind).toBe('resolved');
  if (result.kind === 'resolved') {
    expect(result.exactContext).toBeNull();
    if (protocol === 'openai-chat') expect(result.model).toBeInstanceOf(ChatOpenAICompletions);
    if (protocol === 'openai-responses') expect(result.model).toBeInstanceOf(ChatOpenAIResponses);
  }
  expect(await resolver('@langchain/openai#ChatOpenAI')).toBeNull();
});

test('exact key and trusted effort are injected only during construction; instance calls remain direct', () => {
  const candidate = { ...configuration(), effort: 'high', effortCapability: { values: ['low', 'high'], source: 'trusted', optionPath: 'reasoningEffort' } };
  const created = new FakeListChatModel({ responses: ['ok'] });
  let options: Record<string, unknown> = {};
  const integration: ProviderIntegration = { integrationRef: 'openai-chat', createChatModel: input => { options = { ...input.modelOptions }; return created; } };
  const result = resolveChatModel(candidate, () => integration, credentials);
  expect(result).toMatchObject({ kind: 'resolved', model: created });
  expect(options).toMatchObject({ apiKey: 'fixture-secret', reasoning: { effort: 'high' }, configuration: { baseURL: 'https://example.invalid/v1' }, maxRetries: 0, model: 'exact-model' });
  expect(JSON.stringify(candidate)).not.toContain('fixture-secret');
});

test('invalid config and missing key fail closed; construction errors never reveal key', () => {
  const resolver = () => ({ integrationRef: 'openai-chat', createChatModel: () => { throw new Error('fixture-secret'); } });
  expect(resolveChatModel({ ...configuration(), modelOptions: { apiKey: 'fixture-secret' } } as CoordinatorModelConfiguration, resolver, credentials)).toMatchObject({ kind: 'rejected', code: 'invalid_model_options' });
  expect(resolveChatModel(configuration(), resolver, { read: () => ({ kind: 'rejected', code: 'credential_missing', message: 'missing' }) })).toMatchObject({ code: 'credential_unavailable' });
  const failed = resolveChatModel(configuration(), resolver, credentials);
  expect(failed).toMatchObject({ code: 'construction_failed' });
  expect(JSON.stringify(failed)).not.toContain('fixture-secret');
  expect(resolveChatModel({ ...configuration(), effort: 'high', effortCapability: null }, resolver, credentials)).toMatchObject({ code: 'invalid_effort' });
});

test('explicit integration capabilities survive injection without approximate tokenizer claims', async () => {
  class Installed extends FakeListChatModel {
    static companionExactContext: ExactContextCapability = { measure: () => Promise.resolve({ used: 42, capacity: 128000 }) };
    static companionNativeCompaction = { compact: () => Promise.resolve(null) };
    static companionKeepalive = { intervalMs: 60000, keepalive: () => Promise.resolve(true) };
  }
  const integration = await createBuiltinIntegrationResolverAsync({ load: () => Promise.resolve(Installed) })('openai-chat');
  expect(integration).toMatchObject({ exactContext: Installed.companionExactContext, nativeCompaction: Installed.companionNativeCompaction, keepalive: Installed.companionKeepalive });
  expect(await createBuiltinIntegrationResolverAsync({ load: () => Promise.reject(new Error('failure')) })('openai-chat')).toBeNull();
});

test('chat request preserves provider reasoning_content for tool continuation', async () => {
  const requests: Record<string, unknown>[] = [];
  const integration = await createBuiltinIntegrationResolverAsync()('openai-chat');
  const resolved = resolveChatModel(configuration(), () => integration, credentials);
  if (resolved.kind !== 'resolved') throw new Error('model unavailable');
  const model = resolved.model as ChatOpenAICompletions;
  model.client = { chat: { completions: { create: (input: Record<string, unknown>) => {
    requests.push(input);
    return Promise.resolve({ id: 'reply', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  } } } } as unknown as typeof model.client;
  await model.invoke([new AIMessage({ content: '', additional_kwargs: { reasoning_content: 'provider-thinking' }, tool_calls: [{ id: 'call-1', name: 'read', args: {} }] }), new ToolMessage({ content: 'result', tool_call_id: 'call-1' })]);
  expect(requests[0]?.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'assistant', reasoning_content: 'provider-thinking' })]));
});

test('Responses 请求关闭服务器存储并索取可恢复的 encrypted reasoning', async () => {
  const integration = await createBuiltinIntegrationResolverAsync()('openai-responses');
  const resolved = resolveChatModel(configuration('openai-responses'), () => integration, credentials);
  if (resolved.kind !== 'resolved') throw new Error('model unavailable');
  const params = (resolved.model as ChatOpenAIResponses).invocationParams({});
  expect(params).toMatchObject({ store: false, include: ['reasoning.encrypted_content'] });
});

test.each(['openai-chat', 'openai-responses'] as const)('%s effort 进入实际 SDK 请求参数', async protocol => {
  const candidate = { ...configuration(protocol), model: 'gpt-5.1', effort: 'high', effortCapability: { values: ['high'], source: 'trusted', optionPath: 'reasoning.effort' } };
  const integration = await createBuiltinIntegrationResolverAsync()(protocol);
  const resolved = resolveChatModel(candidate, () => integration, credentials);
  if (resolved.kind !== 'resolved') throw new Error('model unavailable');
  const effort = protocol === 'openai-chat'
    ? (resolved.model as ChatOpenAICompletions).invocationParams({}).reasoning_effort
    : (resolved.model as ChatOpenAIResponses).invocationParams({}).reasoning?.effort;
  expect(effort).toBe('high');
});

test.each(['https://api.anthropic.com', 'https://api.minimax.cn/anthropic/v1'])('Anthropic 地址 %s 只追加一次协议路径', async baseUrl => {
  let requestUrl = '';
  const integration: ProviderIntegration = {
    integrationRef: 'anthropic-messages',
    createChatModel: input => new ChatAnthropic({ ...input.modelOptions, model: input.model, clientOptions: {
      fetch: input => {
        requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return Promise.resolve(Response.json({ id: 'msg-1', type: 'message', role: 'assistant', model: 'exact-model', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
      },
    } }),
  };
  const candidate = configuration('anthropic-messages');
  const resolved = resolveChatModel({ ...candidate, providerConnection: { ...candidate.providerConnection!, baseUrl } }, () => integration, credentials);
  if (resolved.kind !== 'resolved') throw new Error('model unavailable');
  await resolved.model.invoke('ping');
  expect(new URL(requestUrl).pathname).toBe(baseUrl.includes('minimax') ? '/anthropic/v1/messages' : '/v1/messages');
});
