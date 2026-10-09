import type { CoordinatorSessionId } from '../dto/identity.js';
import type { CheckpointWriteResult } from '../coordinator/runtime-guard.js';

/** 结构化轮次失败：只有固定 code 与有限 message，不保存 provider 原始错误体或凭据。 */
export const AGENT_TURN_FAILURE_CODES = [
    /** 执行函数抛出异常（含解析、类型、上下文与落盘错误）。 */
    'execution_failed',
    /** 宿主把图结局（stalled/blocked）映射为轮次停止。 */
    'halted_by_host',
    /** 重新打开时读到未结束的 running：视为中断，等待明确恢复。 */
    'interrupted',
    /** 用户明确恢复的核验回调没有通过。 */
    'recovery_rejected',
    /** 宿主或用户停止：先 abort，再持久化。 */
    'stopped',
    /** 轮次状态无法持久化或已损坏：本进程与后续恢复都按停止处理。 */
    'state_unavailable',
] as const;

export type AgentTurnFailureCode = (typeof AGENT_TURN_FAILURE_CODES)[number];

export type AgentTurnFailure = {
    readonly code: AgentTurnFailureCode;
    readonly message: string;
};

/** 落盘 message 的字符上限；超长诊断在此截断，不为了保留上下文放大持久记录。 */
export const AGENT_TURN_MESSAGE_CHARS = 512;

export type AgentTurnState =
    | { readonly kind: 'idle' }
    | { readonly kind: 'running' }
    | { readonly kind: 'halted'; readonly failure: AgentTurnFailure };

/**
 * 轮次状态的持久读写，独立于正文与协调状态。
 *
 * 实现方不保存凭据、provider 原始错误体或任何协调语义；没有轮次行的既有会话按 `idle` 读取。
 */
export type AgentTurnPort = {
    readonly readTurnState: (coordinatorSessionId: CoordinatorSessionId) => AgentTurnState;
    readonly writeTurnState: (coordinatorSessionId: CoordinatorSessionId, state: AgentTurnState) => CheckpointWriteResult;
};

/** 宿主提供的一次轮次执行；图状态到轮次结局的映射由宿主拥有，驱动不认识 graph。 */
export type AgentTurnExecution = (signal: AbortSignal) => Promise<AgentTurnResult>;

export type AgentTurnResult =
    | { readonly kind: 'completed' }
    | { readonly kind: 'halted'; readonly failure: AgentTurnFailure };

export type AgentTurnRunOutcome =
    | { readonly kind: 'completed' }
    | { readonly kind: 'stopped'; readonly failure: AgentTurnFailure };

export type AgentTurnRetryOutcome =
    | { readonly kind: 'cleared' }
    | { readonly kind: 'rejected'; readonly failure: AgentTurnFailure };
