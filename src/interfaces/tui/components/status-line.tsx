import { Box, Text } from 'ink';
import { displayWidth, truncateToDisplayWidth } from '../render/width.js';
import type { CompactionView, ExecutionProjectionView, GraphView, MaintenanceView, ScopeView } from '../../../application/tui/view-model.js';
import type { SidebarDensity } from '../state.js';
import { tuiColors } from '../theme.js';

export type StatusLineProps = {
  readonly scope: ScopeView; readonly compaction: CompactionView | null; readonly maintenance: MaintenanceView | null;
  readonly blockerCount: number; readonly notice: string | null; readonly sidebarDensity: SidebarDensity;
  readonly availableWidth: number; readonly execution: ExecutionProjectionView | null;
  readonly model?: string | null; readonly graph?: GraphView | null;
};
export function compactionLabel(compaction: CompactionView | null): string | null {
  if (compaction === null || compaction.status === 'not_needed') return null;
  return compaction.status + (compaction.reason ? ': ' + compaction.reason : '');
}
export function StatusLine(props: StatusLineProps) {
  const width = Math.max(1, props.availableWidth);
  const modelWidth = Math.max(1, width - displayWidth(' · 推理 不可用 · 上下文 不可用'));
  const core: {text:string;color:string}[] = [
    { text: truncateToDisplayWidth(props.model ?? '模型不可用', modelWidth), color: tuiColors.accent },
    { text: '推理 不可用', color: tuiColors.focus },
    { text: '上下文 不可用', color: tuiColors.success },
  ];
  const graph = props.graph ? '图 G' + (props.graph.generation ?? '?') + '·v' + props.graph.graphVersion : '图未建立';
  if (displayWidth(core.map(s => s.text).join(' · ') + ' · ' + graph) <= width) core.push({ text: graph, color: 'blueBright' });
  return <Box><Text>{core.map((part,i) => <Text key={i}>{i ? <Text color={tuiColors.muted}> · </Text> : null}<Text color={part.color}>{part.text}</Text></Text>)}</Text></Box>;
}
