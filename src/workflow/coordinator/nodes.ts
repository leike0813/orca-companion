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

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RetryPolicy } from '@langchain/langgraph';

import type { ProjectedActionableWorkItem } from '../../application/coordinator/actionable-work.js';
import type {
  CheckpointRecoveryRead,
  CoordinatorSessionRecordPort,
  FencingAssertion,
} from '../../application/coordinator/runtime-guard.js';
import type { CoordinatorSessionId } from '../../application/dto/identity.js';
import type { CommittedModelStep, CoordinatorSessionState, ModelUsageObservation } from '../../domain/coordinator/session-state.js';
import { toDurableMessage } from './context.js';
import type { CoordinatorGraphState, CoordinatorGraphUpdate } from './state.js';

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
  if (error instanceof Error && error.name === 'AbortError') {
    return false;
  }
  return true;
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

/** 节点需要的依赖；全部由 Bootstrap 注入，节点不构造它们。 */
export type CoordinatorNodeDependencies = {
  readonly model: BaseChatModel;
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
  readonly clock?: () => number;
  /** 退避等待由宿主注入，便于在测试与紧耦合宿主中不真实等待。 */
  readonly sleep?: (ms: number) => Promise<void>;
};

/**
 * 按策略执行一次可证明安全的模型调用。
 *
 * 返回最后一次错误，或成功的响应。次数由策略封顶，不重试不可重试的错误。
 */
async function invokeModelWithRetry(
  model: BaseChatModel,
  messages: readonly unknown[],
  sleep: (ms: number) => Promise<void>,
): Promise<{ readonly response: unknown } | { readonly error: unknown }> {
  const maxAttempts = MODEL_NODE_RETRY_POLICY.maxAttempts ?? 1;
  const retryOn = MODEL_NODE_RETRY_POLICY.retryOn ?? (() => true);
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return { response: await model.invoke(messages as never) };
    } catch (error) {
      lastError = error;
      if (!retryOn(error) || attempt === maxAttempts) {
        break;
      }
      await sleep(retryBackoffMs(attempt));
    }
  }
  return { error: lastError };
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
  return async (state: CoordinatorGraphState): Promise<CoordinatorGraphUpdate> => {
    const coordinatorSessionId = state.coordinatorSessionId as CoordinatorSessionId;
    if (coordinatorSessionId.length === 0) {
      return blocked('model node 缺少 Coordinator Session 身份');
    }
    let read: CheckpointRecoveryRead;
    try {
      read = dependencies.sessionRecords.loadCheckpoint(coordinatorSessionId);
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

    const call = await invokeModelWithRetry(dependencies.model, built.messages, sleep);
    if ('error' in call) {
      // 未完整提交：历史停在最后一个 Committed Model Step，重启后从这里继续。
      return {
        status: 'stalled',
        graphPosition: 'model',
        note: `模型调用未完整提交：${describeError(call.error)}`,
      };
    }
    const response = call.response;

    const step: CommittedModelStep = {
      stepId: dependencies.newStepId(),
      committedAt: clock(),
      // 只有完整返回的响应才会走到这里，并且落盘的是 Companion 自己的持久化形状：
      // 直接存 provider 对象在重开后会丢失角色，历史就再也读不出来了。
      messages: [toDurableMessage(response)],
      usage: usageOf(response),
    };
    const beforeWrite = assertWritable(dependencies.assertFencing);
    if (beforeWrite !== null) {
      return beforeWrite;
    }
    const next: CoordinatorSessionState = {
      ...read.state,
      graphPosition: 'model',
      committedMessages: [...read.state.committedMessages, toDurableMessage(response)],
      committedModelSteps: [...read.state.committedModelSteps, step],
    };
    const written = dependencies.sessionRecords.saveCheckpoint(next);
    if (written.kind === 'failed') {
      return blocked(`无法提交 Committed Model Step：${written.message}`);
    }

    const [consumed, ...remaining] = state.remainingWork;
    return {
      status: 'running',
      graphPosition: 'model',
      remainingWork: remaining,
      note:
        consumed === undefined
          ? `已提交 ${step.stepId}`
          : `已提交 ${step.stepId}，处理 ${consumed.source.sourceId}`,
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
    const read = dependencies.sessionRecords.loadCheckpoint(coordinatorSessionId);
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
    const written = dependencies.sessionRecords.saveCheckpoint({
      ...read.state,
      graphPosition: 'suspend',
    });
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
