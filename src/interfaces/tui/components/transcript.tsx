/**
 * Coordinator transcript。
 *
 * 只展示用户消息、Agent 回复与工具调用记录；工具记录默认折叠，展开后才显示细节。system 消息与
 * 诊断噪声在投影层就被过滤掉了，因此这里不判断「该不该显示」。
 */

import { Box, Text } from 'ink';
import { tuiColors } from '../theme.js';

import { truncateToDisplayWidth, wrapByDisplayWidth } from '../render/width.js';
import type { TranscriptView } from '../../../application/tui/view-model.js';

export type TranscriptProps = {
  readonly transcript: TranscriptView;
  readonly expandedToolIds: readonly string[];
  readonly onToggleTool: (entryId: string) => void;
  readonly availableWidth: number;
  readonly maxLines?: number;
};

/** 折叠记号；不是颜色，因此状态不依赖终端配色。 */
export const TOOL_COLLAPSED_MARKER = '▸';
export const TOOL_EXPANDED_MARKER = '▾';

export function toolToggleLabel(entry: { readonly id: string; readonly name: string }, expanded: boolean): string {
  const marker = expanded ? TOOL_EXPANDED_MARKER : TOOL_COLLAPSED_MARKER;
  return `${marker} tool ${entry.name}`;
}

export function transcriptLineCount(transcript: TranscriptView, expanded: readonly string[], width: number): number {
  return transcript.entries.reduce((lines, entry, index) => lines + (index > 0 && entry.kind !== 'tool' ? 1 : 0) +
    (entry.kind === 'tool' ? 1 + (expanded.includes(entry.id) ? wrapByDisplayWidth(entry.detail, Math.max(1, width - 4)).length : 0)
      : wrapByDisplayWidth(entry.text, Math.max(1, width - (entry.kind === 'user' ? 4 : 2))).length), 0);
}

export function Transcript(props: TranscriptProps) {
  if (props.transcript.entries.length === 0) return <Text dimColor>{
    props.transcript.historyStatus === 'loading' ? '正在读取对话…'
      : props.transcript.historyStatus === 'unavailable' ? '对话尚未载入' : '尚无对话记录'
  }</Text>;
  const width = Math.max(1, props.availableWidth);
  const lines = props.transcript.entries.flatMap((entry, entryIndex) => {
    const gap = entryIndex === 0 ? [] : [{ key: `${entry.id}-gap`, content: <Text> </Text> }];
    switch (entry.kind) {
      case 'user':
        return [...gap, ...wrapByDisplayWidth(entry.text, Math.max(1, width - 4)).map((text, index) => ({
          key: `${entry.id}-${String(index)}`,
          content: <Text color={tuiColors.accent} bold>{`│ ${index === 0 ? '› ' : '  '}${text || ' '}`}</Text>,
        }))];
      case 'agent':
        return [...gap, ...wrapByDisplayWidth(entry.text, Math.max(1, width - 2)).map((text, index) => ({
          key: `${entry.id}-${String(index)}`,
          content: <Text><Text color={tuiColors.success}>{index === 0 ? '● ' : '  '}</Text>{text || ' '}</Text>,
        }))];
      case 'tool': {
        const expanded = props.expandedToolIds.includes(entry.id);
        return [{ key: entry.id, content: <Text color={tuiColors.warning}>{`  ${truncateToDisplayWidth(toolToggleLabel(entry, expanded), Math.max(1, width - 2))}`}</Text> },
          ...(expanded
            ? wrapByDisplayWidth(entry.detail, Math.max(1, width - 4)).map((text, index) => ({
                key: `${entry.id}-detail-${String(index)}`, content: <Text color={tuiColors.muted}>{`  │ ${text || ' '}`}</Text>,
              }))
            : [])];
      }
    }
  });
  const end = Math.max(0, lines.length - Math.max(0, props.transcript.scrollOffset));
  const visible = props.maxLines === undefined ? lines : lines.slice(Math.max(0, end - Math.max(1, props.maxLines)), end);
  return (
    <Box flexDirection="column">
      {visible.map((line) => <Box key={line.key}>{line.content}</Box>)}
    </Box>
  );
}
