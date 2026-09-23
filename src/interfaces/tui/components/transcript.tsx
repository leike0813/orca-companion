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
  return (
    <Box flexDirection="column">
      {props.transcript.entries.map((entry) => {
        switch (entry.kind) {
          case 'user':
            return (
              <Box key={entry.id} flexDirection="column">
                <Text bold>你</Text>
                {wrapByDisplayWidth(entry.text, width).map((line, index) => (
                  <Text key={`${entry.id}-${String(index)}`}>{line}</Text>
                ))}
              </Box>
            );
          case 'agent':
            return (
              <Box key={entry.id} flexDirection="column">
                <Text bold>Coordinator</Text>
                {wrapByDisplayWidth(entry.text, width).map((line, index) => (
                  <Text key={`${entry.id}-${String(index)}`}>{line}</Text>
                ))}
              </Box>
            );
          case 'tool': {
            const expanded = props.expandedToolIds.includes(entry.id);
            return (
              <Box key={entry.id} flexDirection="column">
                <Text>{toolToggleLabel(entry, expanded)}</Text>
                {expanded
                  ? wrapByDisplayWidth(entry.detail, width).map((line, index) => (
                      <Text key={`${entry.id}-detail-${String(index)}`}>{`  ${line}`}</Text>
                    ))
                  : null}
              </Box>
            );
          }
        }
      })}
    </Box>
  );
}
