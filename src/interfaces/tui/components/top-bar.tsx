/**
 * 主视图顶栏：Scope 身份、模式、控制状态与执行阶段摘要的常驻视图。
 *
 * 只渲染 view model 的字段；不查询、不判定控制状态的含义，也不因为执行态变化重置任何工作区内容
 * （授权后 transcript 与 composer 由容器保持原状，D1）。
 */

import { Box, Text } from 'ink';

import { truncateToDisplayWidth } from '../render/width.js';

export type TopBarProps = {
  readonly coordinationScopeId: string;
  readonly mode: string;
  readonly controlState: string;
  /** 当前图的短标签；没有图时为 `null`。 */
  readonly graphLabel: string | null;
  /** Graph Generation；没有代际时为 `null`。 */
  readonly generation: number | null;
  /** Execution Authorization 标签（`<id> v<version>`）；没有授权时为 `null`。 */
  readonly authorizationLabel: string | null;
  /** active Work Package 计数；并发上限固定为 1，因此只可能是 0 或 1。 */
  readonly activeWorkPackageCount: number;
  /** 存在未对账的执行事实时为 `true`：对账完成前不得显示可推进状态。 */
  readonly reconciling: boolean;
  /** 可用显示宽度；由工作区按终端预算传入。 */
  readonly availableWidth: number;
};

/**
 * 顶栏的展示片段；纯函数，便于断言「授权后出现新的 Generation 与计数」。
 *
 * `reconciling` 排在控制状态之后：顶栏会被按终端宽度裁切，而「重启先对账」是安全相关的状态，不能被
 * Generation/Authorization 等次要片段挤出屏幕。
 */
export function topBarSegments(props: TopBarProps): readonly string[] {
  return [
    `Scope ${props.coordinationScopeId}`,
    props.mode,
    props.controlState,
    ...(props.reconciling ? ['reconciling'] : []),
    props.graphLabel ?? 'graph none',
    `gen=${props.generation === null ? 'none' : String(props.generation)}`,
    `auth=${props.authorizationLabel ?? 'none'}`,
    `active=${String(props.activeWorkPackageCount)}`,
  ];
}

export function TopBar(props: TopBarProps) {
  return (
    <Box borderStyle="single" borderBottom borderTop={false} borderLeft={false} borderRight={false}>
      <Text>{truncateToDisplayWidth(topBarSegments(props).join(' · '), props.availableWidth)}</Text>
    </Box>
  );
}
