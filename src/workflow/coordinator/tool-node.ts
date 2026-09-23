/**
 * MOD-03：受控工具执行节点（D5）。
 * （Owner: `m1-wire-foreground-planning-runtime`）。
 *
 * 模型响应只描述「想调用什么」；真正的执行发生在这里，并且只发生一次：调用清单与它的可信
 * OperationId 在提交响应时就已持久化，所以执行不需要、也不接受模型再提供一次身份。
 *
 * 三条性质由本节点保证：
 *
 * - **串行**：一次只执行一个 call，因此两次写入不会在同 revision 上并发，结果按 call 顺序配对。
 * - **逐 call 落盘**：每执行完一个就写一次 checkpoint，崩溃只丢「还没执行」的调用。
 * - **重放安全**：已有配对结果的 call 一律跳过。结果由 `toolResultEntryId(stepId, callId)` 定位，
 *   所以重启、重放与崩溃补齐沿用的是同一个 call 身份，不会重复发起已接受的副作用。
 *
 * 工具返回 `unknown` 时保留未配对的 call，停止循环；恢复时以原 OperationId 对账。
 */

import type {
  CheckpointRecoveryRead,
  CoordinatorSessionRecordPort,
  FencingAssertion,
} from '../../application/coordinator/runtime-guard.js';
import type { CoordinatorSessionId } from '../../application/dto/identity.js';
import {
  toolResultEntryId,
  type CommittedMessageEntry,
  type CommittedModelStep,
  type CommittedToolCall,
} from '../../domain/coordinator/session-state.js';
import type {
  PlanningCallContext,
  PlanningToolDefinition,
  PlanningToolOutcome,
} from './planning-tools.js';
import type { CoordinatorGraphState, CoordinatorGraphUpdate } from './state.js';

export const TOOLS_NODE = 'tools';

export type ToolNodeDependencies = {
  readonly sessionRecords: CoordinatorSessionRecordPort;
  /** 每次工具调用紧前都回读当前 Runtime Lease；副作用必须建立在它之上。 */
  readonly assertFencing: () => FencingAssertion;
  readonly tools: readonly PlanningToolDefinition[];
  readonly clock?: () => number;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function blocked(note: string): CoordinatorGraphUpdate {
  return { status: 'blocked', graphPosition: 'blocked', note };
}

/**
 * 执行一个已注册的 call。
 *
 * 未注册的已提交调用和异常都保留为未配对状态；前者可能是恢复时注册表不可读，后者无法证明
 * 副作用未发生。
 */
async function invokeRegistered(
  tools: readonly PlanningToolDefinition[],
  call: CommittedToolCall,
  context: PlanningCallContext,
): Promise<PlanningToolOutcome> {
  const definition = tools.find((candidate) => candidate.name === call.name);
  if (definition === undefined) {
    return { kind: 'unknown', reason: `工具 ${call.name} 未注册，已提交调用需等待核验` };
  }
  try {
    return await definition.invoke(call.args, context);
  } catch (error) {
    return { kind: 'unknown', reason: describeError(error) };
  }
}

/**
 * 受控工具执行节点。
 *
 * 取最后一个 Committed Model Step，逐个执行还没有配对结果的 call，并把结果写回同一 Session 的
 * 已提交历史。全部落盘后回到模型节点：只有模型自己的最终响应才消费 Actionable Work。
 */
export function createToolsNode(dependencies: ToolNodeDependencies) {
  return async (state: CoordinatorGraphState): Promise<CoordinatorGraphUpdate> => {
    const coordinatorSessionId = state.coordinatorSessionId as CoordinatorSessionId;
    if (coordinatorSessionId.length === 0) {
      return blocked('tools node 缺少 Coordinator Session 身份');
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

    const step: CommittedModelStep | undefined =
      read.state.committedModelSteps[read.state.committedModelSteps.length - 1];
    if (step === undefined) {
      return blocked('没有可执行的 Committed Model Step：tools 节点不应在模型响应之前运行');
    }

    const current = read.state;
    const answered = new Set(current.committedMessages.map((entry) => entry.entryId));
    let committedMessages = current.committedMessages;
    let executed = 0;

    for (const call of step.toolCalls) {
      const entryId = toolResultEntryId(step.stepId, call.callId);
      if (answered.has(entryId)) {
        // 崩溃或重放：结果已经在历史里，绝不重复发起同一个副作用。
        continue;
      }
      const fencing = dependencies.assertFencing();
      if (fencing.kind === 'fenced') {
        // 有效 lease 是副作用的准入条件：fenced 时不再执行任何调用，也不写结果。
        return blocked(
          `Runtime Incarnation 已被 fencing 拒绝（${fencing.code}），${step.stepId} 的剩余调用未执行`,
        );
      }
      const outcome = await invokeRegistered(dependencies.tools, call, {
        operationId: call.operationId,
        mapOperationId: call.mapOperationId,
      });
      if (outcome.kind === 'unknown') {
        return blocked(`${call.name}(${call.callId}) 结果未知：${outcome.reason}；等待 ${call.operationId} 对账`);
      }
      const afterCall = dependencies.assertFencing();
      if (afterCall.kind === 'fenced') {
        return blocked(`Runtime Incarnation 已被 fencing 拒绝（${afterCall.code}），${call.operationId} 的结果未写入`);
      }
      const entry: CommittedMessageEntry = {
        entryId,
        stepId: step.stepId,
        role: 'tool',
        content: JSON.stringify(outcome),
        toolCallId: call.callId,
        toolName: call.name,
      };
      const written = dependencies.sessionRecords.saveCheckpoint({
        ...current,
        graphPosition: TOOLS_NODE,
        committedMessages: [...committedMessages, entry],
      });
      if (written.kind === 'failed') {
        return blocked(`无法提交工具结果 ${entryId}：${written.message}`);
      }
      committedMessages = [...committedMessages, entry];
      answered.add(entryId);
      executed += 1;
    }

    const summary =
      executed === 0
        ? `没有待执行的调用：${step.stepId} 的每个 call 都已有配对结果`
        : `已执行 ${String(executed)} 个受控工具调用，结果已逐条写入 ${step.stepId}`;
    return {
      status: 'running',
      graphPosition: TOOLS_NODE,
      pendingToolCalls: 0,
      remainingWork: state.remainingWork,
      note: summary,
    };
  };
}
