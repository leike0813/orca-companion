/**
 * Handoff Review：交接的确认界面，同时服务 Route Planning Handoff 与 Execution Handoff。
 *
 * 两种交接是**不同**的领域记录：规划交接只展示 `ControllerPlanningHandoffView`（Plan proposal），执行
 * 交接只展示 `ExecutionHandoffState` 的投影。它们复用同一个交互与同一层信息分层，但不共享记录、也
 * 不互相表达。
 *
 * Capsule 不可用时界面显示 blocker，不提供「跳过」路径：fail closed 由用例决定，界面不发明替代方案。
 */

import { DialogFrame, fieldRows, ReviewBody, type ReviewLayoutProps } from './selection-list.js';
import type {
  ControllerHandoffView,
  ControllerPlanningHandoffView,
} from '../../../application/controller-service.js';

export type HandoffReviewProps = ReviewLayoutProps & {
  readonly proposal: ControllerPlanningHandoffView | null;
  /** 当前持有规划责任的 Session；即这次规划交接要转移的责任来源。 */
  readonly responsibleSessionId: string | null;
  /**
   * 执行阶段交接。
   *
   * 传入（即使是 `null`）表示当前审阅的是 Execution Handoff：此时不使用 `proposal`，因此不会把规划
   * 提案的表达带进执行交接。
   */
  readonly executionHandoff?: ControllerHandoffView | null;
  /** Cutover 完成后 Target 是否仍处于 `awaiting_user_prompt`（等待用户下一条普通 Prompt）。 */
  readonly targetAwaitingUserPrompt?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly availableWidth: number;
};

/** Route Planning Handoff 的展示行；纯函数，便于断言 Capsule 摘要、Target 与待转移责任都可见。 */
export function handoffReviewRows(
  proposal: ControllerPlanningHandoffView,
  responsibleSessionId: string | null,
): readonly string[] {
  return [
    `proposal ${proposal.proposalId} phase=${proposal.phase}`,
    `source ${proposal.sourceSessionId} -> target ${proposal.targetSessionId}`,
    `mapRevision ${String(proposal.mapRevision)} · planRevision ${String(proposal.planRevision)}`,
    `capsule ${proposal.capsuleRef ?? '(未生成：fail closed)'}`,
    `待转移规划责任: ${responsibleSessionId ?? 'none'}`,
    `proposalRevision ${String(proposal.proposalRevision)}`,
  ];
}

/**
 * Execution Handoff 的展示行。
 *
 * 明确列出一次性转移的三项责任集合；Run、Task、Dispatch、Attempt、Worker、worktree、Execution Graph、
 * Authorization 与预算身份**不在**转移范围内，因此界面也不显示「运行身份已变更」。
 */
export function executionHandoffRows(
  handoff: ControllerHandoffView,
  targetAwaitingUserPrompt: boolean,
): readonly string[] {
  return [
    `execution handoff ${handoff.handoffId} phase=${handoff.phase}`,
    `source ${handoff.sourceSessionId} -> target ${handoff.targetSessionId}`,
    `graphGeneration ${String(handoff.graphGeneration)}`,
    `待转移责任: ${handoff.responsibilitySet.join(', ') || 'none'}`,
    `expectedRevision ${String(handoff.expectedRevision)}`,
    `target ${targetAwaitingUserPrompt ? 'awaiting_user_prompt' : 'active'}`,
    '运行身份（Run/Task/Dispatch/Attempt/worktree/Authorization/预算）保持不变',
  ];
}

export function HandoffReview(props: HandoffReviewProps) {
  const execution=props.executionHandoff!==undefined,record=execution?props.executionHandoff:props.proposal,rows=props.rows??18;
  const lines=execution?(props.executionHandoff==null?['! 没有待审阅的 Execution Handoff 记录']:executionHandoffRows(props.executionHandoff,props.targetAwaitingUserPrompt??false)):(props.proposal===null?['! 没有待审阅的 Route Planning Handoff 提案']:handoffReviewRows(props.proposal,props.responsibleSessionId));
  const overview=record?fieldRows([{label:'Source',value:record.sourceSessionId},{label:'Target',value:record.targetSessionId},{label:'阶段',value:record.phase},...(props.executionHandoff?[{label:'图代际',value:String(props.executionHandoff.graphGeneration)},{label:'revision',value:String(props.executionHandoff.expectedRevision)},{label:'待转移责任',value:props.executionHandoff.responsibilitySet.join(', ')},{label:'Target',value:props.targetAwaitingUserPrompt?'awaiting_user_prompt':'active'}]:props.proposal?[{label:'提案',value:props.proposal.proposalId},{label:'Capsule',value:props.proposal.capsuleRef??'不可用 · fail closed'},{label:'map revision',value:String(props.proposal.mapRevision)},{label:'plan revision',value:String(props.proposal.planRevision)},{label:'proposal revision',value:String(props.proposal.proposalRevision)},{label:'待转移规划责任',value:props.responsibleSessionId??'无'}]:[])],Math.max(1,props.availableWidth-8)):lines;
  const allowed=execution?props.executionHandoff?.phase==='reviewed':props.proposal?.capsuleRef!==null&&props.proposal!==null;
  return <DialogFrame title={execution?'Execution Handoff Review':'Handoff Review'} summary={record?`${record.sourceSessionId} → ${record.targetSessionId}`:'交接记录不可用'} width={props.availableWidth} rows={rows} footer="Tab 栏目 · ↑↓ 滚动 · ←→ 动作 · Enter 选择 · Esc 返回">
    <ReviewBody lines={[...(!allowed?['! '+(execution?'交接不可确认':'Capsule 不可用 · fail closed')]:[]),...(props.executionHandoff?.phase==='blocked'?['! 交接进入 blocked：Source 仍是唯一 owner，Target 未被激活']:[]),...(props.tab===1?lines:overview)]} width={props.availableWidth} rows={rows} tab={props.tab??0} scroll={props.scroll??0} action={props.action??0} allowed={allowed} label="确认 cutover"/>
  </DialogFrame>;
}
