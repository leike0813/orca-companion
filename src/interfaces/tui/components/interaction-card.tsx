/**
 * Pending Interaction 内联卡片。
 *
 * 卡片只呈现待答问题并提供一个「进入回答模式」的入口；回答的提交由 composer 在绑定
 * interaction ID 与 expected revision 的 Answer 模式下完成。因此普通聊天消息在结构上不可能满足
 * 待答问题：普通模式提交走的是 send-session-message，而不是回答用例。
 */

import { Box, Text } from 'ink';

import { truncateToDisplayWidth } from '../render/width.js';
import type { InteractionView } from '../../../application/tui/view-model.js';

export type InteractionCardProps = {
  readonly interaction: InteractionView;
  /** 当前 composer 是否已绑定该 interaction。 */
  readonly answering: boolean;
  readonly onEnterAnswer: (interactionId: string, expectedRevision: number) => void;
  readonly availableWidth: number;
};

export function interactionCardLabel(interaction: InteractionView): string {
  const subject = `${interaction.subjectRef.kind}:${interaction.subjectRef.id}`;
  return `待答 ${subject} · state=${interaction.state} · revision=${String(interaction.expectedRevision)}`;
}

export function InteractionCard(props: InteractionCardProps) {
  const label = `${props.answering ? '[回答模式] ' : ''}${interactionCardLabel(props.interaction)}`;
  return (
    <Box flexDirection="column">
      <Text>{truncateToDisplayWidth(label, Math.max(1, props.availableWidth))}</Text>
      <Text dimColor>Ctrl+A 进入回答模式（绑定该 interaction 与当前 expected revision）</Text>
    </Box>
  );
}
