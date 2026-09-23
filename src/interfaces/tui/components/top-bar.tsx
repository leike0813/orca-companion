/**
 * 主视图顶栏：Scope 身份、模式与控制状态的常驻摘要。
 *
 * 只渲染 view model 的字段；不查询、不判定控制状态的含义。
 */

import { Box, Text } from 'ink';

import { truncateToDisplayWidth } from '../render/width.js';

export type TopBarProps = {
  readonly coordinationScopeId: string;
  readonly mode: string;
  readonly controlState: string;
  /** 当前图的短标签；没有图时为 `null`。 */
  readonly graphLabel: string | null;
  /** 可用显示宽度；由工作区按终端预算传入。 */
  readonly availableWidth: number;
};

export function TopBar(props: TopBarProps) {
  const label = `Scope ${props.coordinationScopeId} · ${props.mode} · ${props.controlState}`;
  const graph = props.graphLabel === null ? '' : ` · ${props.graphLabel}`;
  return (
    <Box borderStyle="single" borderBottom borderTop={false} borderLeft={false} borderRight={false}>
      <Text>{truncateToDisplayWidth(`${label}${graph}`, props.availableWidth)}</Text>
    </Box>
  );
}
