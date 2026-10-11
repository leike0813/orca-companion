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
  readonly pendingSubmission?: { readonly submissionId: string; readonly text: string; readonly status: string } | null;
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
  const height = Math.max(1, (props.maxLines ?? 24) - (props.pendingSubmission ? 1 : 0));
  let lines = props.frame === undefined ? staticTranscriptLines(props.transcript, props.expandedToolIds, props.availableWidth, height)
    : props.frame?.lines ?? [];
  const pending = props.pendingSubmission;
  if (pending && props.frame?.atLatest !== false && !lines.some(line => line.id === 'entry:user:' + pending.submissionId)) {
    const pendingLines = staticTranscriptLines({ ...props.transcript, scrollOffset: 0,
      entries: [{ kind: 'user', id: 'pending:' + pending.submissionId, text: pending.text }] }, [], props.availableWidth, height);
    lines = [...lines, ...pendingLines];
  }
  if (lines.length === 0) return <Text dimColor>{props.transcript.historyStatus === 'loading' ? '正在读取对话…'
    : props.transcript.historyStatus === 'unavailable' ? '对话尚未载入' : '尚无对话记录'}</Text>;
  const visible = props.frame?.atLatest !== false ? lines.slice(-height) : lines.slice(0, height);
  return <Box flexDirection="column">{visible.map(line => <Box key={line.key}><Row line={line} width={props.availableWidth}/></Box>)}
    {pending ? <Text dimColor>{pending.status === 'awaiting' ? '正在提交…' : '提交' + pending.status + ' · /inputs 恢复或核验'}</Text> : null}
  </Box>;
}
