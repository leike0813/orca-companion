/**
 * Session Picker：在多个 Coordinator Session 之间切换。
 *
 * 默认选中规则是纯函数（`preferredSessionId`）：有 Pending Interaction 的 Session 优先，否则按传入的
 * 最近活动顺序取第一个。选择动作只是展示态变化——它不改变 Scope 级 Execution Graph。
 */

import { Text } from 'ink';

import { truncateToDisplayWidth } from '../render/width.js';
import type { SessionSummaryView } from '../../../application/tui/view-model.js';
import { DialogFrame, SelectionList } from './selection-list.js';

export type SessionPickerProps = {
  readonly sessions: readonly SessionSummaryView[];
  readonly selectedSessionId: string | null;
  readonly onSelect: (coordinatorSessionId: string) => void;
  readonly availableWidth: number;
  readonly rows?: number;
  readonly title?: string;
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
  const rows=props.rows??16;
  return <DialogFrame title={props.title??'Session Picker'} summary={`当前 ${props.selectedSessionId??'未选择'} · ${props.sessions.length} 个会话`} width={props.availableWidth} rows={rows} footer="↑↓ 选择 · Enter 进入 · Esc 返回">
    <Text dimColor>会话                                      状态 / 待答</Text>
    <SelectionList options={props.sessions.map(session=>({
      label:truncateToDisplayWidth(`${sessionMarker(session)} ${session.coordinatorSessionId} · ${session.lifecycleState} · 待答 ${session.openInteractionCount}`,Math.max(1,props.availableWidth-10)),
      value:session.coordinatorSessionId,
    }))} {...(props.selectedSessionId===null?{}:{defaultValue:props.selectedSessionId})} visibleOptionCount={Math.max(1,rows-8)} onSelect={props.onSelect}/>
  </DialogFrame>;
}
