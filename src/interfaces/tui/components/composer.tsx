/**
 * composer：多行输入的展示与模式提示。
 *
 * 输入事件由工作区用固定键位映射处理，本组件不订阅 stdin、不解析文本语义。两种模式严格分离：
 * Answer 模式显式显示它绑定的 interaction ID 与 expected revision，因此普通消息不可能被当成回答。
 */

import { Box, Text } from 'ink';

import { wrapByDisplayWidth } from '../render/width.js';
import type { ComposerMode } from '../state.js';

export type ComposerProps = {
  readonly value: string;
  readonly mode: ComposerMode;
  /** 该 Session 是否只读（Handoff cutover 后的 Source）。 */
  readonly readOnly: boolean;
  /** 非空即为不可提交的原因；界面据此禁用提交，而不是让用户提交后失败。 */
  readonly disabledReason: string | null;
  readonly newlineHint: string;
  readonly availableWidth: number;
};

export function composerSubmitBlocked(props: Pick<ComposerProps, 'readOnly' | 'disabledReason'>): boolean {
  return props.readOnly || props.disabledReason !== null;
}

export function Composer(props: ComposerProps) {
  const width = Math.max(1, props.availableWidth);
  const modeLabel =
    props.mode.kind === 'answer'
      ? `回答 interaction ${props.mode.interactionId} (revision ${String(props.mode.expectedRevision)})`
      : '普通消息';
  const placeholder =
    props.readOnly
      ? '(只读：该 Session 已交接)'
      : props.mode.kind === 'answer'
        ? '(输入回答后回车提交)'
        : `(输入消息后回车提交 · ${props.newlineHint})`;
  const lines = props.value.length === 0 ? [placeholder] : wrapByDisplayWidth(props.value, width);
  return (
    <Box flexDirection="column" borderStyle="single" borderLeft={false} borderRight={false} borderBottom={false}>
      <Text dimColor>{`composer · ${modeLabel}`}</Text>
      {lines.map((line, index) => (
        <Text key={`composer-${String(index)}`}>{line.length === 0 ? ' ' : line}</Text>
      ))}
      {props.disabledReason === null ? null : <Text>{`! ${props.disabledReason}`}</Text>}
    </Box>
  );
}
