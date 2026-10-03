/** Presentation consumes only the reader's bounded viewport. */
import { Box, Text } from 'ink';
import { tuiColors } from '../theme.js';
import { truncateToDisplayWidth } from '../render/width.js';
import { staticTranscriptLines, type TranscriptFrame, type TranscriptLine } from '../render/transcript-reader.js';
import type { TranscriptView } from '../../../application/tui/view-model.js';
export type TranscriptProps = {
  readonly transcript: TranscriptView;
  readonly frame?: TranscriptFrame | null;
  readonly expandedToolIds: readonly string[];
  readonly onToggleTool: (entryId: string) => void;
  readonly availableWidth: number;
  readonly maxLines?: number;
};
export const TOOL_COLLAPSED_MARKER = '▸';
export const TOOL_EXPANDED_MARKER = '▾';
export function toolToggleLabel(entry: { readonly id: string; readonly name: string }, expanded: boolean): string {
  return (expanded ? TOOL_EXPANDED_MARKER : TOOL_COLLAPSED_MARKER) + ' tool ' + entry.name;
}
function Row({ line, width }: { readonly line: TranscriptLine; readonly width: number }) {
  const text = truncateToDisplayWidth(line.text, Math.max(1, width - (line.kind === 'user' || line.kind === 'tool-detail' ? 4 : 2)));
  if (line.kind === 'gap') return <Text> </Text>;
  if (line.highlighted) return <Text inverse>{'› ' + text}</Text>;
  if (line.kind === 'user') return <Text color={tuiColors.accent} bold>{'│ ' + (line.first ? '› ' : '  ') + (text || ' ')}</Text>;
  if (line.kind === 'tool' || line.kind === 'status') return <Text color={tuiColors.warning}>{'  ' + text}</Text>;
  if (line.kind === 'tool-detail') return <Text color={tuiColors.muted}>{'  │ ' + (text || ' ')}</Text>;
  return <Text><Text color={tuiColors.success}>{line.first ? '● ' : '  '}</Text>{text !== line.text ? text :
    line.spans.length === 0 ? ' ' : line.spans.map((span, index) => <Text key={index}
      bold={span.style === 'strong' || span.style === 'heading'} italic={span.style === 'emphasis'}
      underline={span.style === 'link'} strikethrough={span.style === 'deleted'} dimColor={span.style === 'code'}>{span.text}</Text>)}</Text>;
}
export function Transcript(props: TranscriptProps) {
  const height = props.maxLines ?? 24;
  const lines = props.frame === undefined ? staticTranscriptLines(props.transcript, props.expandedToolIds, props.availableWidth, height)
    : props.frame?.lines ?? [];
  if (lines.length === 0) return <Text dimColor>{props.transcript.historyStatus === 'loading' ? '正在读取对话…'
    : props.transcript.historyStatus === 'unavailable' ? '对话尚未载入' : '尚无对话记录'}</Text>;
  const visible = props.frame?.atLatest ? lines.slice(-height) : lines.slice(0, height);
  return <Box flexDirection="column">{visible.map(line => <Box key={line.key}><Row line={line} width={props.availableWidth}/></Box>)}</Box>;
}
