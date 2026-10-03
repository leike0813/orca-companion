/**
 * Scope 级控制条（IP-05、IP-06）。
 *
 * 控制只作用于整个 Coordination Scope：本组件**没有** Work Package 参数，因此在结构上不可能出现
 * 「暂停/取消某个 Work Package」的入口。危险态（活跃 Worker、Pending Interaction、未决操作）下的
 * Cancel 与 Exit 需要一次显式确认；Pause 永不确认。
 *
 * 确认只是一次意图提交：界面不推断终态，`cancelling` 一律来自 Controller 已持久化的控制状态。
 */

import { ConfirmInput } from '@inkjs/ui';
import type { ControlHazardsView } from '../../../application/execution/execution-view.js';
import type { PendingConfirmation } from '../state.js';
import { DialogFrame, fieldRows, ReviewBody, type ReviewLayoutProps } from './selection-list.js';

export type ControlBarProps = ReviewLayoutProps & {
  readonly controlState: string;
  readonly hazards: ControlHazardsView;
  readonly pending: PendingConfirmation;
  readonly availableWidth: number;
  readonly scopeId?: string;
  readonly sessionCount?: number;
  readonly onConfirm: () => void;
  readonly onDismiss: () => void;
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
  if (pending.kind === 'exit-discard') {
    return `未保存的输入写入失败，仍要退出并丢弃这些输入？(${detail}) `;
  }
  return pending.kind === 'cancel'
    ? `确认 Cancel 整个 Coordination Scope？(${detail}) `
    : `确认退出前台进程？Scope 不会进入暂停或取消。(${detail}) `;
}

export function ControlBar(props: ControlBarProps) {
  const prompt=confirmationPrompt(props.pending,props.hazards);
  if(prompt===null)return null;
  const rows=props.rows??18,cancel=props.pending?.kind==='cancel';
  const fields=fieldRows([{label:'Scope',value:props.scopeId??'身份不可用'},{label:'控制状态',value:props.controlState},
    {label:'会话',value:props.sessionCount===undefined?'不可用':String(props.sessionCount)},
    {label:'活跃 Worker',value:String(props.hazards.activeWorkerCount)},
    {label:'不可核验 Worker',value:String(props.hazards.unverifiedWorkerCount)},
    {label:'待答交互',value:String(props.hazards.openInteractionCount)},
    {label:'未决操作',value:String(props.hazards.unresolvedOperationCount)}],Math.max(1,props.availableWidth-8));
  const impact=cancel?['— 确认后 —','新工作：停止新的模型恢复与 Worker 派发','运行工作：请求停止；结果未确认时保持 cancelling 或不可核验','— 已完成的工作 —','保留代码、工作记录与已消耗预算']:
    ['— 确认后 —','退出前台进程；活跃 Worker 可能继续运行','恢复时先对账；Scope 不隐式暂停或取消',...(props.pending?.kind==='exit-discard'?['未保存的输入将按本次明确确认丢弃']:['保留已保存输入与工作记录'])];
  return <DialogFrame title={cancel?'Cancel Scope':'Exit Companion'} summary={`Scope · ${props.controlState}`} width={props.availableWidth} rows={rows} footer="Tab 栏目 · ↑↓ 浏览 · ←→ 动作 · Enter · y 确认 / n 返回">
    <ReviewBody lines={props.tab===1?[prompt,...fields,...impact]:[prompt,'— 影响整个项目 —',...hazardReasons(props.hazards),...impact]}
      width={props.availableWidth} rows={rows-1} tab={props.tab??0} scroll={props.scroll??0} action={props.action??0} allowed label="确认 y"/>
    <ConfirmInput defaultChoice="cancel" submitOnEnter={false} onConfirm={props.onConfirm} onCancel={props.onDismiss}/>
  </DialogFrame>;
}
