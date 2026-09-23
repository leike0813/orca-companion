/**
 * Session Picker：在多个 Coordinator Session 之间切换。
 *
 * 默认选中规则是纯函数（`preferredSessionId`）：有 Pending Interaction 的 Session 优先，否则按传入的
 * 最近活动顺序取第一个。选择动作只是展示态变化——它不改变 Scope 级 Execution Graph。
 */

import { Box, Text } from 'ink';

import { truncateToDisplayWidth } from '../render/width.js';
import type { SessionSummaryView } from '../../../application/tui/view-model.js';

export type SessionPickerProps = {
  readonly sessions: readonly SessionSummaryView[];
  readonly selectedSessionId: string | null;
  readonly onSelect: (coordinatorSessionId: string) => void;
  readonly availableWidth: number;
};

/**
 * 无既有选择时的默认选中：优先有 Pending Interaction 的 Session，其次保留传入顺序中的第一个。
 */
export function preferredSessionId(
  sessions: readonly SessionSummaryView[],
  existing: string | null,
): string | null {
  if (existing !== null && sessions.some((session) => session.coordinatorSessionId === existing)) {
    return existing;
  }
  const pending = sessions.find((session) => session.openInteractionCount > 0);
  return pending?.coordinatorSessionId ?? sessions[0]?.coordinatorSessionId ?? null;
}

export function sessionMarker(session: SessionSummaryView): string {
  if (session.unread) {
    return '*';
  }
  return session.openInteractionCount > 0 ? '?' : ' ';
}

export function SessionPicker(props: SessionPickerProps) {
  return (
    <Box flexDirection="column" borderStyle="single">
      <Text>Session Picker</Text>
      {props.sessions.map((session) => {
        const selected = session.coordinatorSessionId === props.selectedSessionId ? '>' : ' ';
        const label = `${selected}${sessionMarker(session)} ${session.coordinatorSessionId} ${session.lifecycleState} pending=${String(session.openInteractionCount)}`;
        return (
          <Text key={session.coordinatorSessionId}>
            {truncateToDisplayWidth(label, Math.max(1, props.availableWidth))}
          </Text>
        );
      })}
      <Text dimColor>Enter 选择 · Esc 关闭</Text>
    </Box>
  );
}
