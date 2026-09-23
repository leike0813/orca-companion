/**
 * Scope 级控制条（IP-05、IP-06）。
 *
 * 控制只作用于整个 Coordination Scope：本组件**没有** Work Package 参数，因此在结构上不可能出现
 * 「暂停/取消某个 Work Package」的入口。危险态（活跃 Worker、Pending Interaction、未决操作）下的
 * Cancel 与 Exit 需要一次显式确认；Pause 永不确认。
 *
 * 确认只是一次意图提交：界面不推断终态，`cancelling` 一律来自 Controller 已持久化的控制状态。
 */

import { Box, Text } from 'ink';

import { truncateToDisplayWidth } from '../render/width.js';
import type { ControlHazardsView } from '../../../application/execution/execution-view.js';
import type { PendingConfirmation } from '../state.js';

export type ControlBarProps = {
  readonly controlState: string;
  readonly hazards: ControlHazardsView;
  readonly pending: PendingConfirmation;
  readonly availableWidth: number;
};

const HAZARD_LABELS = {
  activeWorkerCount: '活跃 Worker',
  unverifiedWorkerCount: '不可核验 Worker',
  openInteractionCount: '待答交互',
  unresolvedOperationCount: '未决操作',
} as const;

/** 危险态的可读原因；空数组表示没有危险态，因此不需要确认。 */
export function hazardReasons(hazards: ControlHazardsView): readonly string[] {
  return (Object.keys(HAZARD_LABELS) as readonly (keyof typeof HAZARD_LABELS)[])
    .filter((key) => hazards[key] > 0)
    .map((key) => `${HAZARD_LABELS[key]} ${String(hazards[key])}`);
}

/** 该动作在当前控制状态与危险态下是否需要先确认。 */
export function requiresConfirmation(action: 'pause' | 'resume' | 'cancel' | 'exit', hazards: ControlHazardsView): boolean {
  // Pause 不需要确认：它只阻止新的派发与模型恢复，已运行的工作继续到可核验边界。
  if (action === 'pause' || action === 'resume') {
    return false;
  }
  return hazards.hazardous;
}

/** 待确认动作的提示行；`null` 表示没有待确认动作。 */
export function confirmationPrompt(
  pending: PendingConfirmation,
  hazards: ControlHazardsView,
): string | null {
  if (pending === null) {
    return null;
  }
  const reasons = hazardReasons(hazards);
  const detail = reasons.length === 0 ? '没有危险态' : reasons.join('、');
  return pending.kind === 'cancel'
    ? `确认 Cancel 整个 Coordination Scope？(${detail}) y 确认 · n 取消`
    : `确认退出前台进程？Scope 不会进入暂停或取消。(${detail}) y 确认 · n 取消`;
}

export function ControlBar(props: ControlBarProps) {
  const prompt = confirmationPrompt(props.pending, props.hazards);
  const summary = `scope control · ${props.controlState}`;
  return (
    <Box flexDirection="column">
      <Text dimColor>
        {truncateToDisplayWidth(
          `${summary} · Pause/Resume/Cancel 只作用于整个 Scope（无单包控制）`,
          Math.max(1, props.availableWidth),
        )}
      </Text>
      {prompt === null ? null : (
        <Text>{truncateToDisplayWidth(prompt, Math.max(1, props.availableWidth))}</Text>
      )}
    </Box>
  );
}
