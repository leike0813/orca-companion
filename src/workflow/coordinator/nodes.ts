/**
 * MOD-03：Coordinator graph 的节点
 * （Owner: `m1-run-coordinator-sessions`）。
 *
 * 节点只做图内的事：调用一次模型、原子接受一个 Committed Model Step、在无工作可做时结束本次
 * invoke。准入、状态转换、预算与副作用策略都不在这里（D4）——它们属于 Application 层，节点通过
 * 注入的 seam 使用它们。
 *
 * 「原子接受」是本模块最重要的性质：一次模型响应只有完整返回后才构造 `CommittedModelStep`，
 * 并在同一 store 调用里落盘。中途中断的响应因此不可能进入历史，重启后循环从最后一个已提交
 * step 之后继续。
 */

import type { RunnableConfig } from '@langchain/core/runnables';
import type { RetryPolicy } from '@langchain/langgraph';

import type { ProjectedActionableWorkItem } from '../../application/coordinator/actionable-work.js';
import type { TranscriptStreamObserver } from '../../application/coordinator/history.js';
import type {
  CheckpointRecoveryRead,
  CoordinatorSessionRecordPort,
  FencingAssertion,
} from '../../application/coordinator/runtime-guard.js';
import type { CoordinatorSessionId } from '../../application/dto/identity.js';
import {
  assistantEntryId,
  toolMapOperationId,
  toolOperationId,
  type CommittedModelStep,
} from '../../domain/coordinator/session-state.js';
import { entryFromResponse, parseModelToolCalls } from './context.js';
import {
  isCancellationError,
  isRetryableModelCallFailure,
  publishStreamEvent,
  streamModelCall,
  usageOf,
  type ModelCallFailure,
  type StreamingModelHandle,
} from './model-call.js';
import type { PlanningToolDefinition } from './planning-tools.js';
import type { CoordinatorGraphState, CoordinatorGraphUpdate } from './state.js';

/** usage 的读取规则由 `model-call.ts` 拥有（流式片段的确认规则在那里），这里只做转出。 */
export { usageOf };

export const MODEL_NODE = 'model';
export const SUSPEND_NODE = 'suspend';

/** 达到这个 technical 上限只说明循环失控；业务预算另有归属（D15）。 */
export const MODEL_NODE_MAX_ATTEMPTS = 3;

/**
 * 模型调用的自动重试只覆盖可证明安全的调用。
 *
 * 取消不是可重试错误：重试一个已被用户取消的调用会违背取消语义。除此之外，模型调用不产生副作用，
 * 且未完整返回的响应不会被提交，所以重试是安全的。
 */
export function isRetryableModelCall(error: unknown): boolean {
  return !isCancellationError(error);
}

/**
 * 模型调用的自动重试策略。
 *
 * 只覆盖可证明安全的调用：模型调用不产生副作用，且未完整返回的响应不会被提交，所以重试是安全的；
 * 取消则不是可重试错误。策略由 model node 自己执行，**不**同时交给 `addNode` 的 retryPolicy——
 * 两层重试会让次数相乘，这正是 D15 要避免的。内层重试同样在 `resolveChatModel` 中关闭。
 */
export const MODEL_NODE_RETRY_POLICY: RetryPolicy = {
  maxAttempts: MODEL_NODE_MAX_ATTEMPTS,
  initialInterval: 250,
  backoffFactor: 2,
  jitter: false,
  retryOn: isRetryableModelCall,
};

/** 第 `attempt` 次失败后的退避毫秒数（`attempt` 从 1 开始）。 */
export function retryBackoffMs(attempt: number): number {
  const initial = MODEL_NODE_RETRY_POLICY.initialInterval ?? 0;
  const factor = MODEL_NODE_RETRY_POLICY.backoffFactor ?? 1;
  return initial * factor ** Math.max(0, attempt - 1);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 节点需要的依赖；全部由 Bootstrap 注入，节点不构造它们。 */
export type CoordinatorNodeDependencies = {
  readonly model: StreamingModelHandle;
  readonly sessionRecords: CoordinatorSessionRecordPort;
  /** 每次模型调用和 checkpoint 写入紧前都回读当前 Runtime Lease。 */
  readonly assertFencing: () => FencingAssertion;
  /**
   * 组装一次有界模型输入；由 `context.ts` 提供，因此上下文维护规则不在这里复制。
   *
   * `currentWork` 是本次正要消费的那一条 Actionable Work：节点把它显式交给组装方，避免出现
   * 「节点消费了工作、模型却不知道要做什么」——历史为空时那会退化成只有 system 消息的请求，
   * 部分 provider 会直接以 `messages must not be empty` 拒绝。
   *
   * 抛出 `ContextMaintenanceError` 时节点按 fail closed 处理。
   */
  readonly buildMessages: (
    state: CoordinatorGraphState,
    currentWork: ProjectedActionableWorkItem | null,
  ) => Promise<{
    readonly messages: readonly unknown[];
    readonly note: string;
  }>;
  readonly newStepId: () => string;
  /**
   * 已注册的受控工具集，与绑定到模型的那一份是同一个列表。
   *
   * 模型只能申请这里注册的名字；执行则只发生在 tools 节点。不传表示不暴露任何工具，因此
   * 「忘记配置」不会意外打开规划写入。
   */
  readonly tools?: readonly PlanningToolDefinition[];
  readonly clock?: () => number;
  /** 退避等待由宿主注入，便于在测试与紧耦合宿主中不真实等待。 */
  readonly sleep?: (ms: number) => Promise<void>;
  /** 把未提交的流式响应投影成临时预览；预览故障不影响模型调用。 */
  readonly streamObserver?: TranscriptStreamObserver;
  /** 单次模型响应的输出预算；缺省由 `MODEL_RESPONSE_BYTES` 拥有。 */
  readonly maxResponseBytes?: number;
};

/**
 * 按策略执行一次可证明安全的流式模型调用。
 *
 * 步骤身份在调用之前产生，因此每次 attempt 的预览身份都由同一个可信 step 派生；返回最后一次失败，
 * 或成功接受的那一个完整响应。次数由策略封顶，输出超限、取消与 fencing 失效都不重试。
 */
async function streamModelWithRetry(input: {
  readonly dependencies: CoordinatorNodeDependencies;
  readonly coordinatorSessionId: CoordinatorSessionId;
  readonly stepId: string;
  readonly messages: readonly unknown[];
  readonly signal: AbortSignal | undefined;
  readonly sleep: (ms: number) => Promise<void>;
}): Promise<
  | {
      readonly kind: 'response';
      readonly response: unknown;
      readonly usage: ReturnType<typeof usageOf>;
      readonly previewId: string;
    }
  | { readonly kind: 'failed'; readonly failure: ModelCallFailure }
> {
  const maxAttempts = MODEL_NODE_RETRY_POLICY.maxAttempts ?? 1;
  let lastFailure: ModelCallFailure | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // 预览身份由可信 step 与本次 attempt 派生：模型无法影响它，也无法复用上一次尝试的预览。
    const previewId = `preview:${input.stepId}:attempt-${String(attempt)}`;
    const outcome = await streamModelCall({
      model: input.dependencies.model,
      messages: input.messages,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.dependencies.maxResponseBytes === undefined
        ? {}
        : { maxResponseBytes: input.dependencies.maxResponseBytes }),
      assertFencing: input.dependencies.assertFencing,
      ...(input.dependencies.streamObserver === undefined
        ? {}
        : { streamObserver: input.dependencies.streamObserver }),
      coordinatorSessionId: input.coordinatorSessionId,
      previewId,
    });
    if (outcome.kind === 'response') {
      return { kind: 'response', response: outcome.response, usage: outcome.usage, previewId };
    }
    lastFailure = outcome;
    if (!isRetryableModelCallFailure(outcome) || attempt === maxAttempts) {
      break;
    }
    await input.sleep(retryBackoffMs(attempt));
  }
  return {
    kind: 'failed',
    failure:
      lastFailure ?? {
        kind: 'failed',
        reason: 'unconfirmed',
        detail: '模型调用没有产生任何结果',
        error: null,
      },
  };
}

function blocked(note: string): CoordinatorGraphUpdate {
  return { status: 'blocked', graphPosition: 'blocked', note };
}

function assertWritable(assertFencing: () => FencingAssertion): CoordinatorGraphUpdate | null {
  const fencing = assertFencing();
  return fencing.kind === 'fenced'
    ? blocked(`Runtime Incarnation 已被 fencing 拒绝（${fencing.code}）`)
    : null;
}

/**
 * 模型节点。
 *
 * 读回会话记录 → 组装有界输入 → 调用模型 → 原子接受 Committed Model Step。任一步失败都不写历史：
 * `stalled` 表示本次响应未完整提交，`blocked` 表示上下文或持久化无法安全推进。
 */
export function createModelNode(dependencies: CoordinatorNodeDependencies) {
  const clock = dependencies.clock ?? (() => Date.now());
  const sleep = dependencies.sleep ?? defaultSleep;
  return async (
    state: CoordinatorGraphState,
    config?: RunnableConfig,
  ): Promise<CoordinatorGraphUpdate> => {
    const coordinatorSessionId = state.coordinatorSessionId as CoordinatorSessionId;
    if (coordinatorSessionId.length === 0) {
      return blocked('model node 缺少 Coordinator Session 身份');
    }
    let read: CheckpointRecoveryRead;
    try {
      read = dependencies.sessionRecords.loadCheckpoint(coordinatorSessionId, 'metadata');
    } catch (error) {
      return blocked(`无法读回会话记录：${describeError(error)}`);
    }
    if (read.kind !== 'recovered') {
      return blocked(
        read.kind === 'absent'
          ? '该 Session 还没有可恢复的会话记录'
          : `会话记录不可恢复：${read.reason}`,
      );
    }

    const beforeCall = assertWritable(dependencies.assertFencing);
    if (beforeCall !== null) {
      return beforeCall;
    }

    // 本次正要消费的那一条工作必须进入模型输入，否则模型不知道要做什么。
    const [currentWork] = state.remainingWork;
    let built: { readonly messages: readonly unknown[]; readonly note: string };
    try {
      built = await dependencies.buildMessages(state, currentWork ?? null);
    } catch (error) {
      return blocked(`上下文维护失败：${describeError(error)}`);
    }

    // 可信身份在调用之前产生：预览、entry 与 operation 身份都由同一个 step 派生，重试也不会换号。
    const stepId = dependencies.newStepId();
    const call = await streamModelWithRetry({
      dependencies,
      coordinatorSessionId,
      stepId,
      messages: built.messages,
      signal: config?.signal,
      sleep,
    });
    if (call.kind === 'failed') {
      if (call.failure.reason === 'fenced') {
        // 失去写入权不是「响应没拿到」，而是这个 incarnation 不能再写任何东西。
        return blocked(call.failure.detail);
      }
      // 未完整提交：历史停在最后一个 Committed Model Step，重启后从这里继续。
      return {
        status: 'stalled',
        graphPosition: 'model',
        note: `模型调用未完整提交：${call.failure.detail}`,
      };
    }
    const response = call.response;

    const entryId = assistantEntryId(stepId);
    // 这一次调用发布的预览必须在任何结局上都有终态：只有 committed 与 interrupted 两种，缺一个
    // 就意味着临时源会一直停在 streaming，直到容量淘汰。
    const interrupted = (reason: string): CoordinatorGraphUpdate => {
      publishStreamEvent(dependencies.streamObserver, {
        coordinatorSessionId,
        previewId: call.previewId,
        kind: 'interrupted',
        reason,
      });
      return { status: 'stalled', graphPosition: 'model', note: `模型调用未完整提交：${reason}` };
    };
    const allowedNames = (dependencies.tools ?? []).map((definition) => definition.name);
    const parsed = parseModelToolCalls(response, allowedNames, (callId) => ({
      operationId: toolOperationId(stepId, callId),
      mapOperationId: toolMapOperationId(stepId, callId),
    }));
    // 无法受控执行的调用绝不是「没有调用」：先完整提交这次响应，再以 blocked 停下并说明原因，
    // 不猜参数、不跳过、不换一个名字继续。
    const blockedNote = parsed.ok
      ? null
      : `模型响应包含无法受控执行的 tool call：${parsed.reason}；响应已提交为 ${stepId}`;
    const toolCalls = parsed.ok ? parsed.calls : [];

    let entry: ReturnType<typeof entryFromResponse>;
    try {
      entry = entryFromResponse(response, { stepId, entryId, toolCalls });
    } catch (error) {
      // 无法归一化的响应不是可提交的响应：写不下去，也不留下仍在 streaming 的预览。
      return interrupted(`响应无法安全归一化：${describeError(error)}`);
    }
    const step: CommittedModelStep = {
      stepId,
      entryId,
      committedAt: clock(),
      // 只有完整返回的响应才会走到这里，并且落盘的是 Companion 自己的持久化形状：
      // 直接存 provider 对象在重开后会丢失角色，历史就再也读不出来了。
      messages: [entry],
      toolCalls,
      usage: call.usage,
    };
    // 接受之前重新核验：模型等待期间 Scope 可能已被取消，或这个 incarnation 已被取代。
    if (config?.signal?.aborted === true) {
      return interrupted('调用在提交前已被取消');
    }
    const beforeWrite = assertWritable(dependencies.assertFencing);
    if (beforeWrite !== null) {
      publishStreamEvent(dependencies.streamObserver, {
        coordinatorSessionId,
        previewId: call.previewId,
        kind: 'interrupted',
        reason: typeof beforeWrite.note === 'string' ? beforeWrite.note : '提交前失去写入权',
      });
      return beforeWrite;
    }
    // 从最新已提交状态追加：模型等待期间受理的用户消息不会被这次写入覆盖。
    const written = dependencies.sessionRecords.appendModelStep({
      coordinatorSessionId,
      graphPosition: 'model',
      step,
      entry,
    });
    if (written.kind === 'failed') {
      publishStreamEvent(dependencies.streamObserver, {
        coordinatorSessionId,
        previewId: call.previewId,
        kind: 'interrupted',
        reason: `无法提交 Committed Model Step：${written.message}`,
      });
      return blocked(`无法提交 Committed Model Step：${written.message}`);
    }
    // 预览到此才与权威记录合一：之前它只是未提交的临时内容。
    publishStreamEvent(dependencies.streamObserver, {
      coordinatorSessionId,
      previewId: call.previewId,
      kind: 'committed',
      entryId,
    });
    if (blockedNote !== null) {
      return blocked(blockedNote);
    }

    if (toolCalls.length > 0) {
      // 有未决 tool call 时不消费工作：这次响应只是请求调用，工作仍由它的最终响应处理。
      return {
        status: 'running',
        graphPosition: 'model',
        pendingToolCalls: toolCalls.length,
        remainingWork: state.remainingWork,
        note: `已提交 ${stepId}，待执行 ${String(toolCalls.length)} 个受控工具调用`,
      };
    }

    const [consumed, ...remaining] = state.remainingWork;
    return {
      status: 'running',
      graphPosition: 'model',
      pendingToolCalls: 0,
      remainingWork: remaining,
      note:
        consumed === undefined
          ? `已提交 ${stepId}`
          : `已提交 ${stepId}，处理 ${consumed.source.sourceId}`,
    };
  };
}

export type SuspendNodeDependencies = {
  readonly sessionRecords: CoordinatorSessionRecordPort;
  readonly assertFencing: () => FencingAssertion;
};

/**
 * 挂起节点。
 *
 * 只把图位置记为挂起：不停止前台 Controller、不释放任何所有权、不创建 Wake Batch、也不把 Session
 * 记为完成或取消。挂起的准入判定由 Application 的 `suspendSession` 负责，图只在没有剩余工作时
 * 走到这里。
 */
export function createSuspendNode(dependencies: SuspendNodeDependencies) {
  return (state: CoordinatorGraphState): CoordinatorGraphUpdate => {
    const coordinatorSessionId = state.coordinatorSessionId as CoordinatorSessionId;
    const read = dependencies.sessionRecords.loadCheckpoint(coordinatorSessionId, 'metadata');
    if (read.kind !== 'recovered') {
      return blocked(
        read.kind === 'absent'
          ? '该 Session 还没有可恢复的会话记录'
          : `会话记录不可恢复：${read.reason}`,
      );
    }
    const beforeWrite = assertWritable(dependencies.assertFencing);
    if (beforeWrite !== null) {
      return beforeWrite;
    }
    const written = dependencies.sessionRecords.updateCheckpoint(coordinatorSessionId, { graphPosition: 'suspend' });
    if (written.kind === 'failed') {
      return blocked(`无法记录挂起位置：${written.message}`);
    }
    return {
      status: 'suspended',
      graphPosition: 'suspend',
      note: '模型循环已结束，前台 Controller、对账与已运行 Worker 继续',
    };
  };
}
