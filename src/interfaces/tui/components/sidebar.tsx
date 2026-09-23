/**
 * Sidebar：Scope 状态、预算、紧凑 Execution Graph、Worker 与 blocker 的只读投影。
 *
 * 三态密度只表达「允许显示多少」：`collapsed` 时函数在读取任何图/Worker/interaction 细节之前就返回，
 * 因此折叠状态下不会计算不可见详情——这不是纪律，而是结构性的：`nodes`、`workers` 等字段根本不会被
 * 访问。密度由 `allowedSidebarDensity(terminalWidth)` 给出上限，用户只在该上限内降级。
 */

import { Box, Text } from 'ink';

import { padToDisplayWidth, sidebarWidthFor, truncateToDisplayWidth, wrapByDisplayWidth } from '../render/width.js';
import type { TuiViewModel } from '../../../application/tui/view-model.js';
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

export function Sidebar(props: SidebarProps) {
  if (props.density === 'collapsed') {
    return (
      <Box>
        <Text>{SIDEBAR_COLLAPSED_MARKER}</Text>
      </Box>
    );
  }

  const view = props.viewModel;
  const width = sidebarWidthFor(props.density);
  const graphNodes = view.graph === null ? [] : view.graph.nodes;

  const header = line(`Scope ${view.scope.controlState}`, width);
  const budgetLines = view.budgets
    .slice(0, props.density === 'compact' ? 2 : 6)
    .map((budget) => line(`${budget.budgetKey} ${String(budget.consumed)}/${budget.approvedLimitRef}`, width));
  const graphLines =
    view.graph === null
      ? [line('graph: 不可用', width)]
      : [
          line(`graph ${view.graph.graphId} v${String(view.graph.graphVersion)}`, width),
          ...(props.density === 'compact'
            ? graphNodes.slice(0, 3).map((node) => line(`- ${node.workPackageId}`, width))
            : graphNodes.map((node) =>
                line(
                  `- ${node.workPackageId} [${node.frontierStatus ?? 'not-frontier'}] <- ${node.dependsOn.join(',') || 'none'}`,
                  width,
                ),
              )),
          line(
            `ready: gen=${view.graph.readiness.generationStatus ?? 'none'} auth=${view.graph.readiness.authorizationBound ? 'bound' : 'unbound'}`,
            width,
          ),
        ];
  const workerLines = view.workers
    .slice(0, props.density === 'compact' ? 2 : 5)
    .map((worker) => line(`${worker.role} ${worker.liveness}`, width));
  const blockerLines = view.blockers.slice(0, 4).map((blocker) => line(`! ${blocker.code}`, width));

  return (
    <Box flexDirection="column" width={width + 2} borderStyle="single" borderTop={false} borderBottom={false} borderRight={false}>
      <Text>{header}</Text>
      {wrapByDisplayWidth(`预算`, width).map((text) => (
        <Text key={`budget-title-${text}`} dimColor>
          {text}
        </Text>
      ))}
      {budgetLines.map((text) => (
        <Text key={`budget-${text}`}>{text}</Text>
      ))}
      {graphLines.map((text) => (
        <Text key={`graph-${text}`}>{text}</Text>
      ))}
      {workerLines.length === 0 ? null : <Text dimColor>workers</Text>}
      {workerLines.map((text) => (
        <Text key={`worker-${text}`}>{text}</Text>
      ))}
      {blockerLines.length === 0 ? null : <Text dimColor>blockers</Text>}
      {blockerLines.map((text) => (
        <Text key={`blocker-${text}`}>{text}</Text>
      ))}
    </Box>
  );
}
