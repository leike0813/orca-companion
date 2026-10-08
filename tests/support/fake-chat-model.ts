/**
 * 启动路径测试的 fake chat model（change: `m1-recover-execution`）。
 *
 * 只用于让 `startCoordinatorRuntime` 的能力核验通过：`CapableChatModel` 具备文本、流式（默认实现）、
 * tool calling、取消与 usage 能力；`NoToolsChatModel` 故意缺失 tool calling，用于核验失败路径。
 * 两个装置都不产生真实 provider 调用，也不携带任何身份。
 */

import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, AIMessageChunk, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
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
    messages: BaseMessage[],
    options: { readonly signal?: AbortSignal } | undefined,
  ): Promise<ChatResult> {
    const lastMessage = messages.at(-1);
    if (lastMessage?._getType() === 'human' && lastMessage.content === 'capability cancellation probe') {
      return new Promise((_, reject) => {
        const signal = options?.signal;
        if (signal === undefined) return;
        const abort = () => reject(Object.assign(new Error('调用已被取消'), { name: 'AbortError' }));
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    }
    if (options?.signal?.aborted === true) {
      const aborted = new Error('调用已被取消');
      aborted.name = 'AbortError';
      return Promise.reject(aborted);
    }
    if (lastMessage instanceof ToolMessage) {
      const message = new AIMessage('probe continued');
      (message as { usage_metadata?: unknown }).usage_metadata = {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
      };
      return Promise.resolve({ generations: [{ text: 'probe continued', message }] });
    }
    const requestsProbe = lastMessage?._getType() === 'human' &&
      typeof lastMessage.content === 'string' && lastMessage.content.includes('Call the capability_probe tool.');
    const message = requestsProbe
      ? new AIMessage({
          content: '',
          tool_calls: [{ id: 'fixture-capability-probe', name: 'capability_probe', args: {} }],
        })
      : new AIMessage('pong');
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

/** 一次脚本化流式响应里的工具调用；`callId` 由模型提供，身份仍由宿主派生。 */
export type StreamedToolCall = {
  readonly callId: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
};

/**
 * 一次 usage 报告；多个即「归约语义无法从通用合同确认」。
 *
 * 字段可缺：真实 provider 会在中途只报一部分数字，回归测试必须能表达这种形状。
 */
export type StreamedUsageReport = {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly total_tokens?: number;
};

/**
 * 一次脚本化的流式响应。
 *
 * fake 负责把高层形状展开成真实的 chunk 序列：模型节点因此是在消费真实流式调用，而不是在验证
 * 一个「假装流式」的对象。`usage` 放在响应末尾的空 chunk 上，与真实 provider 的形状一致。
 */
export type StreamedTurn =
  | {
      readonly kind: 'text';
      readonly text: string;
      /** 每个 chunk 的字符数；不传表示整段一次产出。 */
      readonly chunkSize?: number;
      readonly usage?: readonly StreamedUsageReport[];
    }
  | {
      readonly kind: 'tool_calls';
      readonly calls: readonly StreamedToolCall[];
      /** 把 args 拆成多个 chunk 片段，模拟 provider 逐段下发参数。 */
      readonly splitArgs?: boolean;
      readonly usage?: readonly StreamedUsageReport[];
    }
  | {
      /** 原样透传的 provider 形状；用于「无法受控执行」的回归。 */
      readonly kind: 'raw_tool_calls';
      readonly content: string;
      readonly toolCalls: readonly Record<string, unknown>[];
    }
  | {
      /** 原样透传的 chunk 序列；用于 provider 交回非常规内容结构的回归。 */
      readonly kind: 'raw_chunks';
      readonly chunks: readonly AIMessageChunk[];
    }
  | {
      /** 产出若干 chunk 后抛出普通错误：这次响应因此不完整。 */
      readonly kind: 'incomplete';
      readonly text: string;
      readonly chunkSize?: number;
    }
  | { readonly kind: 'error' };

function textChunks(text: string, chunkSize: number | undefined): AIMessageChunk[] {
  if (text.length === 0 || chunkSize === undefined) {
    return [new AIMessageChunk(text)];
  }
  const parts: AIMessageChunk[] = [];
  for (let offset = 0; offset < text.length; offset += chunkSize) {
    parts.push(new AIMessageChunk(text.slice(offset, offset + chunkSize)));
  }
  return parts;
}

/** 展开成真实 chunk 序列：文本分片、逐段工具参数，以及末尾只带 usage 的空 chunk。 */
function chunksOf(turn: StreamedTurn): AIMessageChunk[] {
  if (turn.kind === 'error') {
    return [];
  }
  if (turn.kind === 'incomplete') {
    return textChunks(turn.text, turn.chunkSize);
  }
  if (turn.kind === 'text') {
    return [...textChunks(turn.text, turn.chunkSize), ...usageChunks(turn.usage)];
  }
  if (turn.kind === 'raw_tool_calls') {
    return [new AIMessageChunk({ content: turn.content, tool_calls: turn.toolCalls as never })];
  }
  if (turn.kind === 'raw_chunks') {
    return [...turn.chunks];
  }
  const chunks: AIMessageChunk[] = [];
  for (const [index, call] of turn.calls.entries()) {
    chunks.push(
      new AIMessageChunk({
        content: '',
        tool_call_chunks: [{ name: call.name, args: '', id: call.callId, index }],
      }),
    );
    const args = JSON.stringify(call.args);
    const fragments = turn.splitArgs === true && args.length > 1 ? [args.slice(0, Math.ceil(args.length / 2)), args.slice(Math.ceil(args.length / 2))] : [args];
    for (const fragment of fragments) {
      chunks.push(
        new AIMessageChunk({
          content: '',
          tool_call_chunks: [{ args: fragment, id: call.callId, index }],
        }),
      );
    }
  }
  return [...chunks, ...usageChunks(turn.usage)];
}

function usageChunks(reports: readonly StreamedUsageReport[] | undefined): AIMessageChunk[] {
  return (reports ?? []).map((report) => {
    const chunk = new AIMessageChunk('');
    // 与真实 provider 一致：usage 出现在末尾那个空内容 chunk 上。
    (chunk as { usage_metadata?: unknown }).usage_metadata = report;
    return chunk;
  });
}

function toGeneration(chunk: AIMessageChunk): ChatGenerationChunk {
  return new ChatGenerationChunk({ text: typeof chunk.content === 'string' ? chunk.content : '', message: chunk });
}

/**
 * 真正逐 chunk 产出的假 chat model（生产流式链路的行为测试用）。
 *
 * 它记录每次调用的输入与调用次数，因此「重试了几次」「参数是否跨 chunk」「usage 片段有几个」
 * 都是对这个 fake 的事实断言。它没有网络能力，任何一次记录都不可能来自真实 provider。
 */
export class ScriptedStreamingChatModel extends BaseChatModel {
  /** 每次模型调用收到的完整输入，按调用顺序记录。 */
  readonly received: (readonly BaseMessage[])[] = [];
  /** 实际产出过的 chunk 总数：预览是否推进过可以直接断言。 */
  producedChunks = 0;

  private readonly turns: readonly StreamedTurn[];
  private index = 0;

  constructor(turns: readonly StreamedTurn[]) {
    super({});
    this.turns = turns;
  }

  override _llmType(): string {
    return 'scripted-streaming-model';
  }

  /** 走到这里的只有 `invoke` 路径；生产模型节点消费流，因此它按同一份脚本给出一个完整响应。 */
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
    if (turn.kind === 'error') {
      return Promise.reject(new Error('provider 连接中断'));
    }
    const chunks = chunksOf(turn);
    const message = chunks.length === 1 && chunks[0] !== undefined ? chunks[0] : chunks.reduce((left, right) => left.concat(right));
    this.producedChunks += chunks.length;
    return Promise.resolve({ generations: [{ text: message.text, message }] });
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- 异步生成器必须声明 async；这里每步只同步产出一个 chunk。
  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: { readonly signal?: AbortSignal } | undefined,
  ): AsyncGenerator<ChatGenerationChunk> {
    this.received.push(messages);
    const turn = this.turns[this.index];
    if (turn === undefined) {
      throw new Error(`fake 模型脚本已用尽（第 ${String(this.index + 1)} 次调用）`);
    }
    this.index += 1;
    if (turn.kind === 'error') {
      throw new Error('provider 连接中断');
    }
    for (const chunk of chunksOf(turn)) {
      if (options?.signal?.aborted === true) {
        const aborted = new Error('调用已被取消');
        aborted.name = 'AbortError';
        throw aborted;
      }
      this.producedChunks += 1;
      yield toGeneration(chunk);
    }
    if (turn.kind === 'incomplete') {
      // 响应在交付前断开：已经产出的 chunk 不是一次完整响应。
      throw new Error('provider 连接中断');
    }
  }

  override bindTools(tools: readonly unknown[]): Runnable {
    void tools;
    return this;
  }
}
