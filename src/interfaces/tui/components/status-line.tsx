/**
 * 状态行：压缩降级、维护状态、一次性提示与 Sidebar 密度的常驻摘要。
 *
 * `compaction_degraded` 与 `context_exhausted` 只在这里显示 Controller 的投影；界面不自行判定、
 * 也不因为它们触发任何动作。
 */

import { Box, Text } from 'ink';

import { truncateToDisplayWidth } from '../render/width.js';
import type {
  CompactionView,
  ExecutionProjectionView,
  MaintenanceView,
  ScopeView,
} from '../../../application/tui/view-model.js';
import type { SidebarDensity } from '../state.js';

export type StatusLineProps = {
  readonly scope: ScopeView;
  readonly compaction: CompactionView | null;
  readonly maintenance: MaintenanceView | null;
  readonly blockerCount: number;
  readonly notice: string | null;
  readonly sidebarDensity: SidebarDensity;
  readonly availableWidth: number;
  /** 执行阶段摘要；没有快照分区时为 `null`（例如 Home 前的过渡帧）。 */
  readonly execution: ExecutionProjectionView | null;
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
  // 一次性提示放最前：状态行会被按宽度裁切，用户反馈（拒绝原因、unknown 提示）不能被执行摘要挤出屏幕。
  const parts: string[] = [];
  if (props.notice !== null) {
    parts.push(props.notice);
  }
  parts.push(`revision ${String(props.scope.revision)}`, `sidebar ${props.sidebarDensity}`);
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
  const executionParts: string[] = [];
  if (props.execution !== null) {
    executionParts.push(`active ${String(props.execution.activeWorkPackageCount)}`);
    if (props.execution.reconciliation.pending) {
      executionParts.push('reconciling');
    }
    if (props.execution.hazards.hazardous) {
      executionParts.push(
        `hazard(${String(props.execution.hazards.activeWorkerCount)} live / ${String(props.execution.hazards.unverifiedWorkerCount)} unverifiable / ${String(props.execution.hazards.openInteractionCount)} interaction / ${String(props.execution.hazards.unresolvedOperationCount)} operation)`,
      );
    }
    // blocker 的 Recovery 只作为阻塞事实显示；界面不把它读成「已恢复」或「已停止」。
    const blockedRecoveries = props.execution.recoveries.filter(
      (recovery) => recovery.status === 'blocked',
    ).length;
    if (blockedRecoveries > 0) {
      executionParts.push(`recovery blocked ${String(blockedRecoveries)}`);
    }
  }
  // 执行摘要单独一行：与持久状态挤在一行时，后面的片段会先被执行摘要挤出屏幕（危险态与 unknown 提示
  // 恰恰是最需要可见的部分）。
  return (
    <Box flexDirection="column">
      <Text>{truncateToDisplayWidth(parts.join(' · '), Math.max(1, props.availableWidth))}</Text>
      {executionParts.length === 0 ? null : (
        <Text dimColor>
          {truncateToDisplayWidth(executionParts.join(' · '), Math.max(1, props.availableWidth))}
        </Text>
      )}
    </Box>
  );
}
