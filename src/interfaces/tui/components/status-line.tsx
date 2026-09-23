/**
 * 状态行：压缩降级、维护状态、一次性提示与 Sidebar 密度的常驻摘要。
 *
 * `compaction_degraded` 与 `context_exhausted` 只在这里显示 Controller 的投影；界面不自行判定、
 * 也不因为它们触发任何动作。
 */

import { Box, Text } from 'ink';

import { truncateToDisplayWidth } from '../render/width.js';
import type { CompactionView, MaintenanceView, ScopeView } from '../../../application/tui/view-model.js';
import type { SidebarDensity } from '../state.js';

export type StatusLineProps = {
  readonly scope: ScopeView;
  readonly compaction: CompactionView | null;
  readonly maintenance: MaintenanceView | null;
  readonly blockerCount: number;
  readonly notice: string | null;
  readonly sidebarDensity: SidebarDensity;
  readonly availableWidth: number;
};

/** 压缩状态的可读文案；`context_exhausted` 会额外禁用 composer。 */
export function compactionLabel(compaction: CompactionView | null): string | null {
  if (compaction === null) {
    return null;
  }
  switch (compaction.status) {
    case 'not_needed':
      return null;
    case 'compacted':
      return `compacted(${compaction.path ?? 'unknown'})`;
    case 'compaction_degraded':
      return `compaction_degraded: ${compaction.reason ?? '未给出原因'}`;
    case 'context_exhausted':
      return `context_exhausted: ${compaction.reason ?? '未给出原因'}`;
  }
}

export function StatusLine(props: StatusLineProps) {
  const parts: string[] = [`revision ${String(props.scope.revision)}`, `sidebar ${props.sidebarDensity}`];
  const compaction = compactionLabel(props.compaction);
  if (compaction !== null) {
    parts.push(compaction);
  }
  if (props.maintenance !== null) {
    parts.push(
      props.maintenance.stopped
        ? `maintenance stopped(${props.maintenance.stopReason ?? 'unknown'})`
        : `maintenance cycle ${String(props.maintenance.cyclesRun)}`,
    );
  }
  if (props.blockerCount > 0) {
    parts.push(`blockers ${String(props.blockerCount)}`);
  }
  if (props.notice !== null) {
    parts.push(props.notice);
  }
  return (
    <Box>
      <Text>{truncateToDisplayWidth(parts.join(' · '), Math.max(1, props.availableWidth))}</Text>
    </Box>
  );
}
