/**
 * Handoff Review：交接的确认界面，同时服务 Route Planning Handoff 与 Execution Handoff。
 *
 * 两种交接是**不同**的领域记录：规划交接只展示 `ControllerPlanningHandoffView`（Plan proposal），执行
 * 交接只展示 `ExecutionHandoffState` 的投影。它们复用同一个交互与同一层信息分层，但不共享记录、也
 * 不互相表达。
 *
 * Capsule 不可用时界面显示 blocker，不提供「跳过」路径：fail closed 由用例决定，界面不发明替代方案。
 */

import { Box, Text } from 'ink';

import { truncateToDisplayWidth } from '../render/width.js';
import type {
  ControllerHandoffView,
  ControllerPlanningHandoffView,
} from '../../../application/controller-service.js';

export type HandoffReviewProps = {
  readonly proposal: ControllerPlanningHandoffView | null;
  /** 当前持有规划责任的 Session；即这次规划交接要转移的责任来源。 */
  readonly responsibleSessionId: string | null;
  /**
   * 执行阶段交接。
   *
   * 传入（即使是 `null`）表示当前审阅的是 Execution Handoff：此时不使用 `proposal`，因此不会把规划
   * 提案的表达带进执行交接。
   */
  readonly executionHandoff?: ControllerHandoffView | null;
  /** Cutover 完成后 Target 是否仍处于 `awaiting_user_prompt`（等待用户下一条普通 Prompt）。 */
  readonly targetAwaitingUserPrompt?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly availableWidth: number;
};

/** Route Planning Handoff 的展示行；纯函数，便于断言 Capsule 摘要、Target 与待转移责任都可见。 */
export function handoffReviewRows(
  proposal: ControllerPlanningHandoffView,
  responsibleSessionId: string | null,
): readonly string[] {
  return [
    `proposal ${proposal.proposalId} phase=${proposal.phase}`,
    `source ${proposal.sourceSessionId} -> target ${proposal.targetSessionId}`,
    `mapRevision ${String(proposal.mapRevision)} · planRevision ${String(proposal.planRevision)}`,
    `capsule ${proposal.capsuleRef ?? '(未生成：fail closed)'}`,
    `待转移规划责任: ${responsibleSessionId ?? 'none'}`,
    `proposalRevision ${String(proposal.proposalRevision)}`,
  ];
}

/**
 * Execution Handoff 的展示行。
 *
 * 明确列出一次性转移的三项责任集合；Run、Task、Dispatch、Attempt、Worker、worktree、Execution Graph、
 * Authorization 与预算身份**不在**转移范围内，因此界面也不显示「运行身份已变更」。
 */
export function executionHandoffRows(
  handoff: ControllerHandoffView,
  targetAwaitingUserPrompt: boolean,
): readonly string[] {
  return [
    `execution handoff ${handoff.handoffId} phase=${handoff.phase}`,
    `source ${handoff.sourceSessionId} -> target ${handoff.targetSessionId}`,
    `graphGeneration ${String(handoff.graphGeneration)}`,
    `待转移责任: ${handoff.responsibilitySet.join(', ') || 'none'}`,
    `expectedRevision ${String(handoff.expectedRevision)}`,
    `target ${targetAwaitingUserPrompt ? 'awaiting_user_prompt' : 'active'}`,
    '运行身份（Run/Task/Dispatch/Attempt/worktree/Authorization/预算）保持不变',
  ];
}

export function HandoffReview(props: HandoffReviewProps) {
  if (props.executionHandoff !== undefined) {
    const handoff = props.executionHandoff;
    if (handoff === null) {
      return (
        <Box flexDirection="column" borderStyle="single">
          <Text>Execution Handoff Review</Text>
          <Text>! 没有待审阅的 Execution Handoff 记录</Text>
          <Text dimColor>Esc 关闭</Text>
        </Box>
      );
    }
    return (
      <Box flexDirection="column" borderStyle="single">
        <Text>Execution Handoff Review</Text>
        {executionHandoffRows(handoff, props.targetAwaitingUserPrompt ?? false).map((row) => (
          <Text key={row}>{truncateToDisplayWidth(row, Math.max(1, props.availableWidth))}</Text>
        ))}
        {handoff.phase === 'blocked' ? (
          <Text>! 交接进入 blocked：Source 仍是唯一 owner，Target 未被激活</Text>
        ) : null}
        <Text dimColor>
          {handoff.phase === 'reviewed' ? 'Enter 确认 cutover · Esc 取消' : '当前阶段不可 cutover（fail closed）· Esc 关闭'}
        </Text>
      </Box>
    );
  }

  const proposal = props.proposal;
  if (proposal === null) {
    return (
      <Box flexDirection="column" borderStyle="single">
        <Text>Handoff Review</Text>
        <Text>! 没有待审阅的 Route Planning Handoff 提案</Text>
        <Text dimColor>Esc 关闭</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" borderStyle="single">
      <Text>Handoff Review</Text>
      {handoffReviewRows(proposal, props.responsibleSessionId).map((row) => (
        <Text key={row}>{truncateToDisplayWidth(row, Math.max(1, props.availableWidth))}</Text>
      ))}
      {proposal.capsuleRef === null ? (
        <Text>! Capsule 不可用：cutover 不会激活 Target</Text>
      ) : null}
      <Text dimColor>Enter 确认 cutover · Esc 取消</Text>
    </Box>
  );
}
