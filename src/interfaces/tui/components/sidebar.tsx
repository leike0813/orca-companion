/**
 * Sidebar：Scope 状态、预算、执行图、Worker、integration queue、Recovery、Finalizer 与 blocker 的只读投影。
 *
 * 三态密度只表达「允许显示多少」：`collapsed` 时函数在读取任何执行详情之前就返回，因此折叠态不会
 * 计算或渲染不可见的 Work Package/Worker/Finalizer 详情——这不是纪律，而是结构性的：那些字段根本
 * 不会被访问（D8）。
 *
 * 节点位置来自 `render/graph-layout.ts` 的稳定拓扑布局；状态变化只更新标识，过滤只隐藏节点。
 */

import { Box, Text } from 'ink';

import { padToDisplayWidth, sidebarWidthFor, truncateToDisplayWidth } from '../render/width.js';
import { compactGraphRow, integrationQueueRows, layoutExecutionGraph, visibleRows } from '../render/graph-layout.js';
import { FinalizerPanel } from './finalizer-panel.js';
import type {
  ExecutionProjectionView,
  TuiViewModel,
  WorkPackageNodeView,
} from '../../../application/tui/view-model.js';
import type { ControllerRecoveryView } from '../../../application/controller-service.js';
import type { SidebarDensity } from '../state.js';

export type SidebarProps = {
  readonly density: SidebarDensity;
  readonly viewModel: TuiViewModel;
  readonly terminalWidth: number;
};

export const SIDEBAR_COLLAPSED_MARKER = '▏sidebar 已折叠 (Ctrl+B)';

function line(text: string, width: number): string {
  return padToDisplayWidth(truncateToDisplayWidth(text, Math.max(1, width)), Math.max(1, width));
}

/** 生命周期与 liveness 分列显示：liveness 只在能核验时给出确定值。 */
function livenessLabel(node: WorkPackageNodeView): string {
  if (node.liveness === null) {
    return 'liveness 未知';
  }
  switch (node.liveness) {
    case 'live':
      return 'live';
    case 'exited':
      return 'exited';
    case 'unverifiable':
      return 'unverifiable(待核验)';
  }
}

function detailLines(node: WorkPackageNodeView, width: number): readonly string[] {
  // 每一条事实单独成行：Sidebar 完整态只有 40 列，把 id/状态/角色/attempt/liveness 串一行会把后两项截掉，
  // 而「生命周期与 liveness 分列显示」要求两者都真的可见。
  const rows = [
    line(`${node.workPackageId} [${node.state}]${node.active ? ' *active' : ''}`, width),
    line(`  role=${node.role ?? 'unknown'} attempt=${node.attemptId ?? 'unknown'}`, width),
    line(`  ${livenessLabel(node)}`, width),
    line(`  worktree=${node.worktreePath ?? '未记录'}`, width),
    line(`  baseline=${node.baselineHead ?? '未记录'}`, width),
  ];
  if (node.validation !== null) {
    rows.push(
      line(
        `  validation ${node.validation.state} evidence=${node.validation.evidenceRefs.join(',') || 'none'}`,
        width,
      ),
    );
  }
  if (node.integration !== null) {
    rows.push(line(`  integration ${node.integration.state} ref=${node.integration.ref ?? 'none'}`, width));
  }
  if (node.revisionHold !== null) {
    rows.push(line(`  revision pending (${node.revisionHold.source})`, width));
  }
  if (node.reconciliation !== null) {
    rows.push(
      line(
        `  reconcile ${node.reconciliation.severity} required=${node.reconciliation.requiredBaselineHead} observed=${node.reconciliation.observedHead ?? 'unknown'}`,
        width,
      ),
    );
  }
  for (const blocker of node.blockerRefs) {
    rows.push(line(`  ! ${blocker}`, width));
  }
  return rows;
}

/** Recovery 行：替代 Segment、coverage、预算与 superseded 都是独立字段，不把它们合并成「已恢复」。 */
function recoveryLines(recovery: ControllerRecoveryView, width: number): readonly string[] {
  const coverage =
    recovery.capsule === null
      ? 'none'
      : `${recovery.capsule.ref} coverage=${recovery.capsule.coverage ?? '未知'}${
          recovery.capsule.gaps.length === 0 ? '' : ` gaps=${recovery.capsule.gaps.join(',')}`
        }`;
  const budget =
    recovery.remainingBudget === null
      ? `budget consumed=${String(recovery.consumedForAttempt)} 上限未知`
      : `budget remaining=${String(recovery.remainingBudget)}/${String(recovery.budgetLimit ?? 0)}`;
  // 完整态只有 40 列：每条事实各自一行，否则 requirement 要求可见的 coverage/预算/superseded 会被省略号吃掉。
  const rows = [
    line(`${recovery.role} ${recovery.status}`, width),
    line(`  ${budget}`, width),
    line(`  segment ${recovery.sourceSegmentId} -> ${recovery.replacementSegmentId ?? 'none'}`, width),
    line(`  superseded ${recovery.supersededSegmentId ?? 'none'}`, width),
    line(`  capsule ${coverage}`, width),
    line(`  acceptedResult ${recovery.acceptedResultRef ?? 'none'}`, width),
  ];
  if (recovery.blockingReason !== null) {
    rows.push(line(`  ! ${recovery.blockingReason}`, width));
  }
  return rows;
}

/**
 * 紧凑态执行图：只保留图关系、短 key、关键状态与告警。
 *
 * 隐藏的节点不参与；顺序与位置仍来自编译顺序，因此隐藏中间节点不会让其余节点重排。
 */
export function compactGraphLines(viewModel: TuiViewModel, width: number): readonly string[] {
  const rows = layoutExecutionGraph(viewModel.graph?.nodes ?? []);
  return visibleRows(rows)
    .slice(0, 6)
    .map((row) => line(compactGraphRow(row), width));
}

export function Sidebar(props: SidebarProps) {
  if (props.density === 'collapsed') {
    // 折叠态只保留顶栏计数：这里在任何执行详情被读取之前返回。
    return (
      <Box>
        <Text>{SIDEBAR_COLLAPSED_MARKER}</Text>
      </Box>
    );
  }

  const view = props.viewModel;
  const execution: ExecutionProjectionView = view.execution;
  const width = sidebarWidthFor(props.density);

  const header = line(
    `Scope ${view.scope.controlState} · active ${String(execution.activeWorkPackageCount)}${
      execution.reconciliation.pending ? ' · reconciling' : ''
    }`,
    width,
  );

  if (props.density === 'compact') {
    const queue = integrationQueueRows(execution.integrationQueue)
      .slice(0, 2)
      .map((entry) => line(`queue ${String(entry.position)} ${entry.workPackageId}`, width));
    const alerts = view.blockers.slice(0, 2).map((blocker) => line(`! ${blocker.code}`, width));
    return (
      <Box
        flexDirection="column"
        width={width + 2}
        borderStyle="single"
        borderTop={false}
        borderBottom={false}
        borderRight={false}
      >
        <Text>{header}</Text>
        {compactGraphLines(view, width).map((text, index) => (
          <Text key={`graph-${String(index)}`}>{text}</Text>
        ))}
        {execution.activeWorkPackageId === null ? null : (
          <Text>{line(`! ${execution.activeWorkPackageId} ${execution.reconciliation.pending ? 'reconciling' : 'active'}`, width)}</Text>
        )}
        {queue.map((text, index) => (
          <Text key={`queue-${String(index)}`}>{text}</Text>
        ))}
        {alerts.map((text, index) => (
          <Text key={`alert-${String(index)}`}>{text}</Text>
        ))}
      </Box>
    );
  }

  const rows = layoutExecutionGraph(view.graph?.nodes ?? []);
  const topologyLines = visibleRows(rows).flatMap((row) => detailLines(row.node, width));
  // admission/authorization readiness 仍是 Sidebar 的关键状态：执行投影只增加分区，不替换它。
  const readinessLine =
    view.graph === null
      ? line('ready: 图不可用', width)
      : line(
          `ready: gen=${view.graph.readiness.generationStatus ?? 'none'} auth=${view.graph.readiness.authorizationBound ? 'bound' : 'unbound'}`,
          width,
        );
  const budgetLines = view.budgets
    .slice(0, 6)
    .map((budget) =>
      line(`${budget.budgetKey} ${String(budget.consumed)}/${budget.approvedLimitRef}`, width),
    );
  const queueLines = integrationQueueRows(execution.integrationQueue).map((entry) =>
    line(
      `queue ${String(entry.position)} ${entry.workPackageId}${entry.integrating ? ' integrating' : ''}`,
      width,
    ),
  );
  const recoveryRows = execution.recoveries.flatMap((recovery) => recoveryLines(recovery, width));
  const workerLines = view.workers
    .slice(0, 5)
    .map((worker) => line(`${worker.role} ${worker.liveness} ${worker.workPackageId}`, width));
  const blockerLines = view.blockers.slice(0, 4).map((blocker) => line(`! ${blocker.code}`, width));

  return (
    <Box
      flexDirection="column"
      width={width + 2}
      borderStyle="single"
      borderTop={false}
      borderBottom={false}
      borderRight={false}
    >
      <Text>{header}</Text>
      <Text dimColor>预算</Text>
      {budgetLines.map((text, index) => (
        <Text key={`budget-${String(index)}`}>{text}</Text>
      ))}
      <Text dimColor>execution graph</Text>
      <Text>{readinessLine}</Text>
      {view.graph === null ? (
        <Text>{line('graph: 不可用', width)}</Text>
      ) : (
        topologyLines.map((text, index) => <Text key={`node-${String(index)}`}>{text}</Text>)
      )}
      {queueLines.length === 0 ? null : <Text dimColor>integration queue (串行)</Text>}
      {queueLines.map((text, index) => (
        <Text key={`queue-${String(index)}`}>{text}</Text>
      ))}
      {recoveryRows.length === 0 ? null : <Text dimColor>recovery</Text>}
      {recoveryRows.map((text, index) => (
        <Text key={`recovery-${String(index)}`}>{text}</Text>
      ))}
      <FinalizerPanel finalizer={execution.finalizer} availableWidth={width} />
      {workerLines.length === 0 ? null : <Text dimColor>workers</Text>}
      {workerLines.map((text, index) => (
        <Text key={`worker-${String(index)}`}>{text}</Text>
      ))}
      {blockerLines.length === 0 ? null : <Text dimColor>blockers</Text>}
      {blockerLines.map((text, index) => (
        <Text key={`blocker-${String(index)}`}>{text}</Text>
      ))}
    </Box>
  );
}
