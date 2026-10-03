/**
 * MOD-03：一次真实的流式模型调用（change: `render-bounded-transcript`）。
 *
 * 这个模块只做一件事：把「一次有界的模型生成」变成「一个可判断成败的结果」。它不知道 Session、
 * 不知道步骤身份、也不写历史——身份由 model 节点在调用前产生，提交由 model 节点在接受之后完成。
 *
 * 两条不变量决定了它的形状：
 *
 * 1. **最终响应只有一个来源**。LangChain SDK 自己把 chunk 聚合成一条消息，并通过 `handleLLMEnd`
 *    交回；这里用 `_awaitHandler: true` 让那个 callback 在流结束前被 await，因此拿到的就是 SDK 的
 *    聚合结果，而不是这里再 concat 一份可能与 SDK 语义不同的副本。
 * 2. **未完整返回的响应没有价值**。输出超限、取消、fencing 失效都在这里实际 abort 这次调用，
 *    结果只能是失败；部分 chunk 只能作为临时预览出现，永远不进入已提交历史。
 */

import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { ModelAbortError } from '@langchain/core/errors';
import type { BaseMessage } from '@langchain/core/messages';
import type { LLMResult } from '@langchain/core/outputs';
import type { Runnable } from '@langchain/core/runnables';

import {
  MODEL_RESPONSE_BYTES,
  type TranscriptStreamEvent,
  type TranscriptStreamObserver,
} from '../../application/coordinator/history.js';
import type { FencingAssertion } from '../../application/coordinator/runtime-guard.js';
import type { ModelUsageObservation } from '../../domain/coordinator/session-state.js';

/**
 * 模型节点真正需要的模型能力：只有「流」。
 *
 * 绑定工具后的对象是 `RunnableBinding` 而不是 `BaseChatModel`，但它同样满足这个形状；把依赖收窄到
 * 流，也就不需要在别处把绑定结果伪称成 chat model。
 */
export type StreamingModelHandle = Pick<Runnable, 'stream'>;

/** 一次流式调用失败的原因分类；只有 `error` 可能是可重试的普通模型故障。 */
export type ModelCallFailureReason =
  | 'output_limit'
  | 'cancelled'
  | 'fenced'
  | 'unconfirmed'
  | 'error';

export type ModelCallFailure = {
  readonly kind: 'failed';
  readonly reason: ModelCallFailureReason;
  readonly detail: string;
  readonly error: unknown;
  readonly fenceCode?: string;
};

export type ModelCallOutcome =
  | {
      readonly kind: 'response';
      /** SDK 聚合出的唯一最终消息。 */
      readonly response: BaseMessage;
      /** 只有取得单个可确认的完整报告时才有值；不明确或缺失时为 `null`。 */
      readonly usage: ModelUsageObservation | null;
    }
  | ModelCallFailure;

/** 从模型响应上读取 provider 报告的 usage；未取得时保留 `null`，不估算。 */
export function usageOf(response: unknown): ModelUsageObservation | null {
  if (typeof response !== 'object' || response === null) {
    return null;
  }
  const metadata = (response as { readonly usage_metadata?: unknown }).usage_metadata;
  if (typeof metadata !== 'object' || metadata === null) {
    return null;
  }
  const read = (key: string): number | null => {
    const value = (metadata as Record<string, unknown>)[key];
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  const usage: ModelUsageObservation = {
    inputTokens: read('input_tokens'),
    outputTokens: read('output_tokens'),
    totalTokens: read('total_tokens'),
  };
  return usage.inputTokens === null && usage.outputTokens === null && usage.totalTokens === null
    ? null
    : usage;
}

/**
 * 只在 SDK 交回聚合消息时才有值的收集器。
 *
 * `_awaitHandler: true` 是必须的：否则 callback 会被丢进后台队列，`stream()` 返回时这里还是空的，
 * 于是每一次调用都会退化成「没有完整响应」。
 */
class AggregatedResponseCollector extends BaseCallbackHandler {
  readonly name = 'coordinator_aggregated_response';
  response: BaseMessage | null = null;

  constructor() {
    super({ _awaitHandler: true });
  }

  override handleLLMEnd(output: LLMResult): void {
    const generation = output.generations[0]?.[0] as { readonly message?: unknown } | undefined;
    this.response = (generation?.message as BaseMessage | undefined) ?? null;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 取消的两种来源：fetch 层的中止（`AbortError`）与 SDK 自己的中止（`ModelAbortError`）。
 *
 * 只认其中一个会让取消被当成普通故障重试，从而违背取消语义。
 */
export function isCancellationError(error: unknown): boolean {
  if (ModelAbortError.isInstance(error)) {
    return true;
  }
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * 一个报告只有在三个数都有效时才是可确认的完整报告；缺任何一个都不作为费用事实。
 *
 * 这里不加「总数必须等于输入加输出」这类算术硬门禁：怎么算属于 provider 计量语义，Companion 不复刻。
 */
function isCompleteUsage(usage: ModelUsageObservation | null): usage is ModelUsageObservation {
  return (
    usage !== null &&
    usage.inputTokens !== null &&
    usage.outputTokens !== null &&
    usage.totalTokens !== null
  );
}

/**
 * 转发一个预览事件，且绝不把观察者的故障变成模型的故障。
 *
 * 预览是显示侧能力：写盘失败、渲染异常或订阅者抛错都只应该让这一次预览不可用，已经发出的模型
 * 调用不因此重来。
 */
export function publishStreamEvent(
  observer: TranscriptStreamObserver | undefined,
  event: TranscriptStreamEvent,
): void {
  if (observer === undefined) {
    return;
  }
  try {
    observer(event);
  } catch {
    // 预览不可用只影响显示，不影响已经发出的模型调用。
  }
}

/** 输出计量按 UTF-8 字节：文本、结构化内容块与工具参数都算在同一个预算里。 */
function valueBytes(value: unknown): number {
  if (typeof value === 'string') {
    return Buffer.byteLength(value, 'utf8');
  }
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === 'object') {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return Buffer.byteLength(value.toString(), 'utf8');
  }
  return 0;
}

function chunkBytes(chunk: BaseMessage): number {
  const message = chunk as {
    readonly content?: unknown;
    readonly tool_calls?: readonly { readonly args?: unknown }[] | undefined;
    readonly tool_call_chunks?: readonly { readonly args?: unknown }[] | undefined;
  };
  let bytes = valueBytes(message.content);
  // 工具参数只计一次：带 `tool_call_chunks` 的 chunk 里，`tool_calls` 是 SDK 从同一批原始片段解析出的
  // 副本。两边都计会让参数在预算里翻倍，把合法的大参数响应判成超限。
  const rawChunks = message.tool_call_chunks;
  if (rawChunks !== undefined && rawChunks.length > 0) {
    for (const call of rawChunks) {
      bytes += valueBytes(call.args);
    }
  } else {
    for (const call of message.tool_calls ?? []) {
      bytes += valueBytes(call.args);
    }
  }
  return bytes;
}

/** 一个 chunk 里的可见文本：结构化内容只取文本块，纯 metadata/usage chunk 因此天然为空。 */
function deltaTextOf(chunk: BaseMessage): string {
  const content = (chunk as { readonly content?: unknown }).content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((block) => {
      // 内容块是 provider 给的任意结构：null 与非对象块只能跳过，不能让预览把整个调用打崩。
      if (typeof block !== 'string' && (typeof block !== 'object' || block === null)) {
        return '';
      }
      if (typeof block === 'string') {
        return block;
      }
      const text = (block as { readonly text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    })
    .join('');
}

/**
 * 只有普通模型故障可以重试。
 *
 * 输出超限、取消与 fencing 失效都是「这次调用不该再发生」的事实：重试会重新生成一个同样大的
 * 响应、违背取消语义，或让已被取代的 incarnation 重新写入。
 */
export function isRetryableModelCallFailure(failure: ModelCallFailure): boolean {
  return failure.reason === 'error' && !isCancellationError(failure.error);
}

/**
 * 执行一次流式模型调用。
 *
 * `coordinatorSessionId` 与 `previewId` 由调用方可信地产生：模型不提供、也不允许自己声明任何身份。
 * 预览观察者失败只影响显示，绝不能让已经发出的模型调用重来一次。
 */
export async function streamModelCall(input: {
  readonly model: StreamingModelHandle;
  readonly messages: readonly unknown[];
  /** 宿主信号（Scope Cancel / Exit 组合而成）；与本次调用的局部 abort 控制器合并。 */
  readonly signal?: AbortSignal;
  readonly maxResponseBytes?: number;
  readonly assertFencing: () => FencingAssertion;
  readonly streamObserver?: TranscriptStreamObserver;
  readonly coordinatorSessionId: string;
  readonly previewId: string;
}): Promise<ModelCallOutcome> {
  const maxResponseBytes = input.maxResponseBytes ?? MODEL_RESPONSE_BYTES;
  const collector = new AggregatedResponseCollector();
  const controller = new AbortController();
  const preview = { coordinatorSessionId: input.coordinatorSessionId, previewId: input.previewId } as const;
  const publish = (event: TranscriptStreamEvent): void => {
    publishStreamEvent(input.streamObserver, event);
  };
  // 读信号的状态不能缓存：中途发生的 abort 只有在真正抛错的那一刻才看得见。
  const callerAborted = (): boolean => input.signal?.aborted === true;
  // 已经被取消的调用根本不启动：再发一次请求既没有接收方，也会让「预览是否还在 streaming」
  // 取决于有没有人先发过 started。这类调用直接以 interrupted 收尾。
  if (callerAborted()) {
    const cancelled: ModelCallFailure = {
      kind: 'failed',
      reason: 'cancelled',
      detail: '调用在开始前已被取消',
      error: null,
    };
    publish({ ...preview, kind: 'interrupted', reason: cancelled.detail });
    return cancelled;
  }
  const onCallerAbort = (): void => {
    controller.abort(input.signal?.reason);
  };
  input.signal?.addEventListener('abort', onCallerAbort, { once: true });

  publish({ ...preview, kind: 'started' });

  let bytes = 0;
  // usage 片段只留「唯一观察到的那个」加一个饱和计数：两个片段已经足以判定归约语义不明确，
  // 再往上数既不改变结论，也不值得为一次调用留一份无界数组。
  //
  // 只要报告里有任何一个数字就算一次观察：否则「一个部分报告 + 一个完整报告」会被当成只有一次，
  // 部分报告被静默忽略。是否完整留到最后统一判断。
  let observedUsage: ModelUsageObservation | null = null;
  let usageFragmentCount = 0;
  // 失败原因在流循环里由闭包写入；放在对象里而不是裸变量，读写两侧才看到同一份事实。
  const attempt: { failure: ModelCallFailure | null } = { failure: null };
  const fail = (next: ModelCallFailure): void => {
    attempt.failure = next;
    controller.abort(next.detail);
  };

  try {
    const stream = await input.model.stream(input.messages, {
      signal: controller.signal,
      callbacks: [collector],
    });
    for await (const raw of stream) {
      const chunk = raw as BaseMessage;
      bytes += chunkBytes(chunk);
      if (bytes > maxResponseBytes) {
        fail({
          kind: 'failed',
          reason: 'output_limit',
          detail: `模型输出超过 ${String(maxResponseBytes)} 字节上限`,
          error: null,
        });
        break;
      }
      const fencing = input.assertFencing();
      if (fencing.kind === 'fenced') {
        fail({
          kind: 'failed',
          reason: 'fenced',
          detail: `Runtime Incarnation 已被 fencing 拒绝（${fencing.code}）`,
          error: null,
          fenceCode: fencing.code,
        });
        break;
      }
      const usage = usageOf(chunk);
      if (usage !== null) {
        observedUsage ??= usage;
        usageFragmentCount = Math.min(usageFragmentCount + 1, 2);
      }
      const text = deltaTextOf(chunk);
      if (text.length > 0) {
        publish({ ...preview, kind: 'delta', text });
      }
    }
  } catch (error) {
    if (attempt.failure === null) {
      fail({
        kind: 'failed',
        reason: callerAborted() || isCancellationError(error) ? 'cancelled' : 'error',
        detail: describeError(error),
        error,
      });
    }
  } finally {
    input.signal?.removeEventListener('abort', onCallerAbort);
  }

  if (attempt.failure !== null) {
    publish({ ...preview, kind: 'interrupted', reason: attempt.failure.detail });
    return attempt.failure;
  }
  if (collector.response === null) {
    const unconfirmed: ModelCallFailure = {
      kind: 'failed',
      reason: 'unconfirmed',
      detail: '流式调用没有交回完整聚合响应',
      error: null,
    };
    publish({ ...preview, kind: 'interrupted', reason: unconfirmed.detail });
    return unconfirmed;
  }
  // 多个 usage 片段的归约语义无法从通用合同确认，因此不猜；唯一那次观察也必须本身完整。
  // 宁可留空，也不把不完整或不明归约的数字写成费用事实。
  return {
    kind: 'response',
    response: collector.response,
    usage: usageFragmentCount === 1 && isCompleteUsage(observedUsage) ? observedUsage : null,
  };
}
