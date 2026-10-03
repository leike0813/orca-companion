/**
 * Execution Authorization Review：完整 Manifest 的审阅与一次显式批准。
 *
 * 界面只显示宿主读好的字段：它不组装 Manifest、不计算指纹、也不提供「跳过缺口」的路径。门禁未通过
 * 或事实不可读时只显示 blocker，批准入口随之关闭（fail closed 由用例决定，界面不发明替代方案）。
 */

import { DialogFrame, fieldRows, ReviewBody, type ReviewLayoutProps } from './selection-list.js';
import type { ExecutionAuthorizationLoad } from '../ports.js';

export type AuthorizationReviewProps = ReviewLayoutProps & {
  /** `null` 表示审阅结果尚未加载：此时不显示任何可批准的内容。 */
  readonly review: ExecutionAuthorizationLoad | null;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly availableWidth: number;
};

/** 审阅展示行：先给结论与门禁，再逐项列出 Manifest，最后是绑定指纹。 */
export function authorizationReviewRows(load: ExecutionAuthorizationLoad): readonly string[] {
  if (load.kind !== 'review') {
    return [`! ${load.code}: ${load.message}`];
  }
  const { review } = load;
  return [
    `graph ${review.candidate.graphId} v${String(review.candidate.version)} · ${String(review.candidate.workPackageCount)} 个 Work Package`,
    `baseline ${review.candidate.baselineHead}`,
    `scopeRevision ${String(review.scopeRevision)}`,
    ...review.manifestRows.map((row) => `${row.label}: ${row.value}`),
    `fingerprint ${review.fingerprint}`,
  ];
}

/** 只有「审阅成功且门禁通过」时才允许批准。 */
export function authorizationApprovable(load: ExecutionAuthorizationLoad | null): boolean {
  return load !== null && load.kind === 'review' && load.review.gate.ready;
}

export function AuthorizationReview(props: AuthorizationReviewProps) {
  const load=props.review,rows=props.rows??18;
  const lines=load===null?['正在读取当前规划产物…']:authorizationReviewRows(load);
  const gate=load?.kind==='review'?load.review.gate:null;
  const overview=load?.kind==='review'?fieldRows([{label:'图',value:load.review.candidate.graphId+' v'+load.review.candidate.version},{label:'工作包',value:String(load.review.candidate.workPackageCount)},{label:'baseline',value:load.review.candidate.baselineHead},{label:'revision',value:String(load.review.scopeRevision)},...load.review.manifestRows,{label:'fingerprint',value:load.review.fingerprint}],Math.max(1,props.availableWidth-8)):lines;
  return <DialogFrame title="Execution Authorization Review" summary={load?.kind==='review'?`graph ${load.review.candidate.graphId} · revision ${load.review.scopeRevision}`:'规划授权'} width={props.availableWidth} rows={rows} footer="Tab 栏目 · ↑↓ 滚动 · ←→ 动作 · Enter 选择 · Esc 返回">
    <ReviewBody lines={[...(gate?.ready?['门禁: 通过']:gate?.blockers.map(b=>`! 门禁未通过: ${b}`)??[]),...(props.tab===1?lines:overview)]} width={props.availableWidth} rows={rows} tab={props.tab??0} scroll={props.scroll??0} action={props.action??0} allowed={authorizationApprovable(load)} label="批准授权"/>
  </DialogFrame>;
}
