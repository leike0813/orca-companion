/**
 * Handoff Review：Route Planning Handoff 的确认界面。
 *
 * 它只展示 Controller 投影出的提案（Capsule 引用、Target 与当前规划责任方）并提交一次确认或取消。
 * Capsule 不可用时界面显示 blocker，不提供「跳过」路径：fail closed 由用例决定，界面不发明替代方案。
 */

import { Box, Text } from 'ink';

import { truncateToDisplayWidth } from '../render/width.js';
import type { ControllerPlanningHandoffView } from '../../../application/controller-service.js';

export type HandoffReviewProps = {
  readonly proposal: ControllerPlanningHandoffView | null;
  /** 当前持有规划责任的 Session；即这次交接要转移的责任来源。 */
  readonly responsibleSessionId: string | null;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly availableWidth: number;
};

/** Review 的展示行；纯函数，便于断言「Capsule 摘要、Target 与待转移责任」都可见。 */
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

export function HandoffReview(props: HandoffReviewProps) {
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
