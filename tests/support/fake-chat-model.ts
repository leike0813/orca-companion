/**
 * 启动路径测试的 fake chat model（change: `m1-recover-execution`）。
 *
 * 只用于让 `startCoordinatorRuntime` 的能力核验通过：`CapableChatModel` 具备文本、流式（默认实现）、
 * tool calling、取消与 usage 能力；`NoToolsChatModel` 故意缺失 tool calling，用于核验失败路径。
 * 两个装置都不产生真实 provider 调用，也不携带任何身份。
 */

import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import type { Runnable } from '@langchain/core/runnables';

/** 全能力假模型：能力核验必须通过，因此启动路径可以继续。 */
export class CapableChatModel extends BaseChatModel {
  constructor() {
    super({});
  }

  override _llmType(): string {
    return 'capable';
  }

  override _generate(
    _messages: BaseMessage[],
    options: { readonly signal?: AbortSignal } | undefined,
  ): Promise<ChatResult> {
    if (options?.signal?.aborted === true) {
      const aborted = new Error('调用已被取消');
      aborted.name = 'AbortError';
      return Promise.reject(aborted);
    }
    const message = new AIMessage('pong');
    (message as { usage_metadata?: unknown }).usage_metadata = {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
    };
    return Promise.resolve({ generations: [{ text: 'pong', message }] });
  }

  override bindTools(tools: readonly unknown[]): Runnable {
    void tools;
    return this;
  }
}

/** 不支持工具调用的假模型：用于核验「能力缺失即拒绝启动」。 */
export class NoToolsChatModel extends CapableChatModel {
  override bindTools(): Runnable {
    return { invoke: (): Promise<never> => Promise.reject(new Error('不支持工具')) } as unknown as Runnable;
  }
}

/**
 * 记录调用次数的假模型：用于断言「某条路径没有产生模型生成调用」。
 *
 * 计数只在本实例上累加，因此 `generations` 是「这个 fake model 被要求生成几次」的事实。它同样
 * 没有网络能力，所以每一次计数都不可能来自真实 provider。
 */
export class CountingChatModel extends CapableChatModel {
  generations = 0;
  toolBindingCalls = 0;

  override _generate(
    messages: BaseMessage[],
    options: { readonly signal?: AbortSignal } | undefined,
  ): Promise<ChatResult> {
    this.generations += 1;
    return super._generate(messages, options);
  }

  override bindTools(tools: readonly unknown[]): Runnable {
    this.toolBindingCalls += 1;
    return super.bindTools(tools);
  }
}
