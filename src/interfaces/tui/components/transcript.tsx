/**
 * Coordinator transcript。
 *
 * 只展示用户消息、Agent 回复与工具调用记录；工具记录默认折叠，展开后才显示细节。system 消息与
 * 诊断噪声在投影层就被过滤掉了，因此这里不判断「该不该显示」。
 */

import { Box, Text } from 'ink';

import { wrapByDisplayWidth } from '../render/width.js';
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

export function Transcript(props: TranscriptProps) {
  const width = Math.max(1, props.availableWidth);
  const lines = props.transcript.entries.flatMap((entry) => {
    switch (entry.kind) {
      case 'user':
        return [{ key: `${entry.id}-heading`, text: '你', bold: true },
          ...wrapByDisplayWidth(entry.text, width).map((text, index) => ({ key: `${entry.id}-${String(index)}`, text, bold: false }))];
      case 'agent':
        return [{ key: `${entry.id}-heading`, text: 'Coordinator', bold: true },
          ...wrapByDisplayWidth(entry.text, width).map((text, index) => ({ key: `${entry.id}-${String(index)}`, text, bold: false }))];
      case 'tool': {
        const expanded = props.expandedToolIds.includes(entry.id);
        return [{ key: entry.id, text: toolToggleLabel(entry, expanded), bold: false },
          ...(expanded
            ? wrapByDisplayWidth(entry.detail, width).map((text, index) => ({
                key: `${entry.id}-detail-${String(index)}`, text: `  ${text}`, bold: false,
              }))
            : [])];
      }
    }
  });
  const visible = props.maxLines === undefined ? lines : lines.slice(-Math.max(1, props.maxLines));
  return (
    <Box flexDirection="column">
      {visible.map((line) => <Text key={line.key} bold={line.bold}>{line.text}</Text>)}
    </Box>
  );
}
