/**
 * 工具循环测试的 fake chat model（change: `m1-wire-foreground-planning-runtime`）。
 *
 * 按脚本顺序返回「带 tool calls 的响应」或「纯文本响应」，并记录每次调用收到的完整消息序列，
 * 因此「配对结果是否进入了下一次模型输入」是对这个 fake 的事实断言，而不是对中间变量的猜测。
 * 它没有网络能力，所以每一次记录都不可能来自真实 provider。脚本用尽即失败：测试不该靠一个
 * 沉默的默认响应通过。
 */

import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import type { Runnable } from '@langchain/core/runnables';

/** 一次脚本化的受控调用；`callId` 由模型提供，身份由宿主派生。 */
export type FakeToolCall = {
  readonly callId: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
};

export type FakeToolModelTurn =
  | { readonly kind: 'text'; readonly content: string }
  | {
      readonly kind: 'tool_calls';
      readonly content?: string;
      readonly calls: readonly FakeToolCall[];
    };

export class FakeToolModel extends BaseChatModel {
  /** 每次模型调用收到的完整输入，按调用顺序记录。 */
  readonly received: (readonly BaseMessage[])[] = [];

  private readonly turns: readonly FakeToolModelTurn[];
  private index = 0;

  constructor(turns: readonly FakeToolModelTurn[]) {
    super({});
    this.turns = turns;
  }

  override _llmType(): string {
    return 'fake-tool-model';
  }

  override _generate(
    messages: BaseMessage[],
    options: { readonly signal?: AbortSignal } | undefined,
  ): Promise<ChatResult> {
    this.received.push(messages);
    if (options?.signal?.aborted === true) {
      const aborted = new Error('调用已被取消');
      aborted.name = 'AbortError';
      return Promise.reject(aborted);
    }
    const turn = this.turns[this.index];
    if (turn === undefined) {
      return Promise.reject(new Error(`fake 模型脚本已用尽（第 ${String(this.index + 1)} 次调用）`));
    }
    this.index += 1;
    const message =
      turn.kind === 'text'
        ? new AIMessage(turn.content)
        : new AIMessage({
            content: turn.content ?? '',
            tool_calls: turn.calls.map((call) => ({
              id: call.callId,
              name: call.name,
              args: call.args,
              type: 'tool_call' as const,
            })),
          });
    (message as { usage_metadata?: unknown }).usage_metadata = {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
    };
    return Promise.resolve({ generations: [{ text: message.text, message }] });
  }

  override bindTools(tools: readonly unknown[]): Runnable {
    void tools;
    return this;
  }
}
