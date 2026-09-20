import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, AIMessageChunk, type BaseMessage } from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import type { Runnable } from '@langchain/core/runnables';
import { expect, test } from 'vitest';

import {
  CAPABILITY_PROBE_TOOL,
  REQUIRED_MODEL_CAPABILITIES,
  verifyModelCapabilities,
  type ModelCapability,
} from '../../src/adapters/agents/capability-probe.js';

/**
 * 可控的能力假模型。
 *
 * 取消与流式的行为必须由模型实现自己决定，所以这个 fake 显式地检查 `signal` 并可以拒绝产出
 * chunk——否则核验就成了恒真的自证。
 */
class ProbeChatModel extends BaseChatModel {
  readonly enabled: Readonly<Record<ModelCapability, boolean>>;

  constructor(enabled: Partial<Record<ModelCapability, boolean>> = {}) {
    super({});
    this.enabled = {
      text_generation: enabled.text_generation ?? true,
      streaming: enabled.streaming ?? true,
      tool_calling: enabled.tool_calling ?? true,
      cancellation: enabled.cancellation ?? true,
      usage: enabled.usage ?? true,
    };
  }

  override _llmType(): string {
    return 'probe';
  }

  override _generate(
    _messages: BaseMessage[],
    options: { readonly signal?: AbortSignal } | undefined,
  ): Promise<ChatResult> {
    if (this.enabled.cancellation && options?.signal?.aborted === true) {
      const aborted = new Error('调用已被取消');
      aborted.name = 'AbortError';
      return Promise.reject(aborted);
    }
    const message = new AIMessage(this.enabled.text_generation ? 'pong' : '');
    if (this.enabled.usage) {
      (message as { usage_metadata?: unknown }).usage_metadata = {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
      };
    }
    return Promise.resolve({ generations: [{ text: message.text, message }] });
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- 异步生成器必须声明 async，但这里没有需要 await 的步骤。
  override async *_streamResponseChunks(): AsyncGenerator<ChatGenerationChunk> {
    if (!this.enabled.streaming) {
      return;
    }
    yield new ChatGenerationChunk({ text: 'pong', message: new AIMessageChunk('pong') });
  }

  override bindTools(tools: readonly unknown[]): Runnable {
    void tools;
    if (!this.enabled.tool_calling) {
      return { invoke: (): Promise<never> => Promise.reject(new Error('该模型不支持工具调用')) } as unknown as Runnable;
    }
    return this;
  }
}

test('五项必需能力全部通过才算核验成功', async () => {
  const result = await verifyModelCapabilities(new ProbeChatModel(), { timeoutMs: 2_000 });

  expect(result.kind).toBe('verified');
  if (result.kind === 'verified') {
    expect(result.report.missing).toEqual([]);
    expect(REQUIRED_MODEL_CAPABILITIES.every((capability) => result.report.capabilities[capability])).toBe(true);
    expect(result.report.details).toHaveLength(REQUIRED_MODEL_CAPABILITIES.length);
  }
});

test('缺少 tool calling 时拒绝启动并列出缺失能力', async () => {
  const result = await verifyModelCapabilities(new ProbeChatModel({ tool_calling: false }), {
    timeoutMs: 2_000,
  });

  expect(result.kind).toBe('rejected');
  if (result.kind === 'rejected') {
    expect(result.reason).toBe('capability_missing');
    expect(result.missing).toEqual(['tool_calling']);
    expect(result.message).toContain('tool_calling');
  }
});

test('缺少流式输出时拒绝启动', async () => {
  const result = await verifyModelCapabilities(new ProbeChatModel({ streaming: false }), { timeoutMs: 2_000 });

  expect(result.kind).toBe('rejected');
  if (result.kind === 'rejected') {
    expect(result.missing).toContain('streaming');
  }
});

test('首个流式 chunk 超时时拒绝启动，不无限等待', async () => {
  class HangingStreamModel extends ProbeChatModel {
    override async *_streamResponseChunks(): AsyncGenerator<ChatGenerationChunk> {
      await new Promise<void>(() => undefined);
      yield new ChatGenerationChunk({ text: 'unreachable', message: new AIMessageChunk('unreachable') });
    }
  }

  const result = await verifyModelCapabilities(new HangingStreamModel(), { timeoutMs: 10 });

  expect(result.kind).toBe('rejected');
  if (result.kind === 'rejected') {
    expect(result.missing).toContain('streaming');
  }
});

test('不能取消时拒绝启动', async () => {
  const result = await verifyModelCapabilities(new ProbeChatModel({ cancellation: false }), {
    timeoutMs: 2_000,
  });

  expect(result.kind).toBe('rejected');
  if (result.kind === 'rejected') {
    expect(result.missing).toContain('cancellation');
  }
});

test('没有可用 usage 时拒绝启动', async () => {
  const result = await verifyModelCapabilities(new ProbeChatModel({ usage: false }), { timeoutMs: 2_000 });

  expect(result.kind).toBe('rejected');
  if (result.kind === 'rejected') {
    expect(result.missing).toContain('usage');
  }
});

test('没有 bindTools 的模型被判定为缺少 tool calling', async () => {
  const withoutBindTools = {
    invoke: () => Promise.resolve(new AIMessage('pong')),
    stream: () => {
      throw new Error('未实现');
    },
  } as unknown as BaseChatModel;

  const result = await verifyModelCapabilities(withoutBindTools, { timeoutMs: 2_000 });

  expect(result.kind).toBe('rejected');
  if (result.kind === 'rejected') {
    expect(result.missing).toContain('tool_calling');
  }
});

test('多个能力同时缺失时全部列出，不掩盖', async () => {
  const result = await verifyModelCapabilities(
    new ProbeChatModel({ tool_calling: false, usage: false }),
    { timeoutMs: 2_000 },
  );

  expect(result.kind).toBe('rejected');
  if (result.kind === 'rejected') {
    expect(result.missing).toEqual(['tool_calling', 'usage']);
  }
});

test('核验用的工具只声明路径可用性，不要求模型真的调用它', () => {
  expect(CAPABILITY_PROBE_TOOL.name).toBe('capability_probe');
  expect(CAPABILITY_PROBE_TOOL.description.length).toBeGreaterThan(0);
});

test('文本生成为空时判定为缺失', async () => {
  const result = await verifyModelCapabilities(new ProbeChatModel({ text_generation: false }), {
    timeoutMs: 2_000,
  });

  expect(result.kind).toBe('rejected');
  if (result.kind === 'rejected') {
    expect(result.missing).toContain('text_generation');
  }
});
