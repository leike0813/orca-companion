/**
 * 主视图顶栏：Scope 身份、模式、控制状态与执行阶段摘要的常驻视图。
 *
 * 只渲染 view model 的字段；不查询、不判定控制状态的含义，也不因为执行态变化重置任何工作区内容
 * （授权后 transcript 与 composer 由容器保持原状，D1）。
 */

import { Box, Text } from 'ink';

import { displayWidth, truncateToDisplayWidth } from '../render/width.js';
import { tuiColors } from '../theme.js';

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
  readonly sessionId?: string | null;
  readonly pendingCount?: number;
  readonly holder?: string | null;
};

/**
 * 为模式、控制状态、待对账与待答数量预留宽度，次要持有者仅使用剩余空间。
 */
export function topBarSegments(props: TopBarProps): readonly string[] {
  const fixed=[props.mode==='route_planning'?'规划':'执行',props.controlState,...(props.reconciling?['待对账']:[]),'待答'+(props.pendingCount??0)].join(' · ');
  const identity=truncateToDisplayWidth(props.sessionId??'未选择会话',Math.max(1,props.availableWidth-displayWidth(fixed)-3));
  const segments = [
    identity,
    props.mode === 'route_planning' ? '规划' : '执行',
    props.controlState,
    ...(props.reconciling ? ['待对账'] : []),
    '待答' + (props.pendingCount ?? 0),
  ];
  const remaining = props.availableWidth - displayWidth(segments.join(' · ')) - 3;
  if (props.holder && props.holder !== props.sessionId && remaining >= 6) {
    segments.push(truncateToDisplayWidth('持有 ' + props.holder, remaining));
  }
  return segments;
}

export function TopBar(props: TopBarProps) {
  return (
    <Box borderStyle="single" borderColor={tuiColors.border} borderBottom borderTop={false} borderLeft={false} borderRight={false}>
      <Text color={props.reconciling || props.controlState === 'blocked' ? tuiColors.warning : tuiColors.accent} bold>
        {truncateToDisplayWidth(topBarSegments(props).join(' · '), props.availableWidth)}
      </Text>
    </Box>
  );
}
