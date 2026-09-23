/**
 * Graph Inspector：候选 Execution Graph 的只读检查与沿依赖导航。
 *
 * 它没有写入路径：组件只接收 view model 与一个选择回调，`onSelect` 只改变展示态。终端过窄时它不
 * 用 overlay 遮挡主视图，而是提示加宽（D5）。
 */

import { Box, Text } from 'ink';

import { truncateToDisplayWidth } from '../render/width.js';
import { NARROW_TERMINAL_NOTICE } from '../render/width.js';
import type { GraphView } from '../../../application/tui/view-model.js';

export type GraphInspectorProps = {
  readonly graph: GraphView | null;
  readonly selectedWorkPackageId: string | null;
  readonly onSelect: (workPackageId: string) => void;
  readonly narrow: boolean;
  readonly availableWidth: number;
};

/** 沿依赖方向求上游节点；只读且不改变图定义。 */
export function upstreamOf(graph: GraphView, workPackageId: string): readonly string[] {
  const node = graph.nodes.find((entry) => entry.workPackageId === workPackageId);
  return node === undefined ? [] : node.dependsOn;
}

export function GraphInspector(props: GraphInspectorProps) {
  if (props.narrow) {
    return (
      <Box>
        <Text>{NARROW_TERMINAL_NOTICE}</Text>
      </Box>
    );
  }
  const graph = props.graph;
  if (graph === null) {
    return (
      <Box flexDirection="column" borderStyle="single">
        <Text>Graph Inspector</Text>
        <Text>! 当前图不可用（GraphVersion 记录不可读）</Text>
        <Text dimColor>Esc 关闭</Text>
      </Box>
    );
  }
  const upstream = props.selectedWorkPackageId === null ? [] : upstreamOf(graph, props.selectedWorkPackageId);
  return (
    <Box flexDirection="column" borderStyle="single">
      <Text>{`Graph Inspector · ${graph.graphId} v${String(graph.graphVersion)}`}</Text>
      <Text>{`generation=${graph.generation === null ? 'none' : String(graph.generation)} status=${graph.readiness.generationStatus ?? 'none'} authorization=${graph.readiness.authorizationBound ? 'bound' : 'unbound'}`}</Text>
      {graph.nodes.map((node) => (
        <Box key={node.workPackageId} flexDirection="column">
          <Text>
            {truncateToDisplayWidth(
              `${node.workPackageId === props.selectedWorkPackageId ? '>' : ' '} ${node.title} [${node.frontierStatus ?? 'not-frontier'}]`,
              Math.max(1, props.availableWidth),
            )}
          </Text>
          <Text dimColor>{`  dependsOn: ${node.dependsOn.join(', ') || 'none'}`}</Text>
          <Text dimColor>{`  scope: +${node.scopeEnvelope.include.join(',') || 'none'} -${node.scopeEnvelope.exclude.join(',') || 'none'}`}</Text>
        </Box>
      ))}
      <Text dimColor>{`upstream: ${upstream.join(', ') || 'none'}`}</Text>
      <Text dimColor>↑/↓ 选择 · ←/→ 沿依赖导航 · Esc 关闭</Text>
    </Box>
  );
}
