/**
 * Session Picker：在多个 Coordinator Session 之间切换。
 *
 * 默认选中规则是纯函数（`preferredSessionId`）：有 Pending Interaction 的 Session 优先，否则按传入的
 * 最近活动顺序取第一个。选择动作只是展示态变化——它不改变 Scope 级 Execution Graph。
 */

import { Text } from 'ink';

import { truncateToDisplayWidth } from '../render/width.js';
import type { SessionSummaryView } from '../../../application/tui/view-model.js';
import { DialogFrame, SearchSelectionList, type DialogSelection, type SearchChoice } from './selection-list.js';
import { emptyDraft } from '../input/composer-editor.js';

export type SessionPickerProps = {
  readonly sessions: readonly SessionSummaryView[];
  readonly selectedSessionId: string | null;
  readonly onSelect: (coordinatorSessionId: string) => void;
  readonly availableWidth: number;
  readonly rows?: number;
  readonly title?: string;
  readonly selection?: DialogSelection;
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

export function sessionChoices(sessions: readonly SessionSummaryView[], selectedSessionId: string | null): readonly SearchChoice[] {
  return sessions.map(session=>({label:`${sessionMarker(session)} ${session.coordinatorSessionId} · ${session.lifecycleState} · 待答 ${session.openInteractionCount}`,value:session.coordinatorSessionId,current:session.coordinatorSessionId===selectedSessionId}));
}

export function SessionPicker(props: SessionPickerProps) {
  const rows=props.rows??16;
  const selection=props.selection??{query:emptyDraft(),selectedId:preferredSessionId(props.sessions,props.selectedSessionId)};
  const selected=props.sessions.find(s=>s.coordinatorSessionId===selection.selectedId);
  return <DialogFrame title={props.title??'Session Picker'} summary={`当前 ${props.selectedSessionId??'未选择'} · ${props.sessions.length} 个会话`} width={props.availableWidth} rows={rows} footer="↑↓ 选择 · Enter 进入 · Esc 返回">
    <SearchSelectionList choices={sessionChoices(props.sessions,props.selectedSessionId)} selection={selection} width={Math.max(1,props.availableWidth-8)} rows={Math.max(1,rows-12)}/>
    <Text dimColor>{'─'.repeat(Math.max(1,props.availableWidth-8))}</Text>
    <Text>{truncateToDisplayWidth(selected?`会话 ${selected.coordinatorSessionId} · 配置 ${selected.coordinatorModelConfigurationRef}`:'请选择会话',Math.max(1,props.availableWidth-8))}</Text>
    <Text dimColor>{selected?`${selected.planningResponsible?'规划责任 · ':''}${selected.holdsExecutionLease?'执行责任 · ':''}待答 ${selected.openInteractionCount}`:''}</Text>
  </DialogFrame>;
}
