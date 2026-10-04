import { Box, Text } from 'ink';
import { useMemo } from 'react';
import type { TuiViewModel } from '../../../application/tui/view-model.js';
import type { ControllerRecoveryView, SemanticEvent } from '../../../application/controller-service.js';
import type { ProjectPanelState } from '../state.js';
import { describeSemanticEvent, semanticEventCategory } from './event-drawer.js';
import { truncateToDisplayWidth, wrapByDisplayWidth } from '../render/width.js';
import { graphDetailRows } from './graph-inspector.js';
import { finalizerRows } from './finalizer-panel.js';
import { tuiColors } from '../theme.js';
import { PROJECT_DETAILS_MAX_ITEMS, PROJECT_DETAILS_MAX_PAGE_BYTES, type ProjectDetailPage } from '../../../application/tui/project-presentation.js';

export function recoveryRows(r:ControllerRecoveryView):readonly string[] {
  return ['recovery '+r.recoveryId+' · '+r.role+' '+r.status,
    r.remainingBudget===null?'budget consumed='+r.consumedForAttempt+' 上限未知':'budget remaining='+r.remainingBudget+'/'+(r.budgetLimit??'未知'),
    'segment '+r.sourceSegmentId+' -> '+(r.replacementSegmentId??'none'),'superseded '+(r.supersededSegmentId??'none'),
    'capsule '+(r.capsule?r.capsule.ref+' coverage='+(r.capsule.coverage??'未知')+' gaps='+r.capsule.gaps.join(','):'none'),
    'acceptedResult '+(r.acceptedResultRef??'none'),...(r.blockingReason?['! '+r.blockingReason]:[])];
}

export function projectItems(view: TuiViewModel, events: readonly SemanticEvent[], tab: number): readonly { key: string; title: string; hint: string; group?: string }[] {
  if (tab === 1) return (view.pendingPage?.items ?? view.interactions).map(item => ({ key: item.interactionId, title: (item.questionPreview || item.subjectRef.id).replace(/\s+/gu, ' '), hint: item.ownerCoordinatorSessionId + ' · ' + (item.state === 'open' ? '待回答' : item.state === 'answered' ? '已回答' : '已取消') }));
  if (tab === 2) return events.toReversed().map((event) => ({ key: 'event:' + event.eventId, title: '[' + semanticEventCategory(event) + '] ' + describeSemanticEvent(event), hint: '本次启动 · ' + event.kind }));
  return [
    { key: 'pending', group: '需要你处理', title: '待答问题', hint: view.execution.hazards.openInteractionCount + ' 条 · 按所属会话查看' },
    { key: 'budget', group: '额度与权限', title: '预算与授权', hint: '已用额度、批准引用与权限' },
    { key: 'authorize', title: '查看候选授权', hint: '打开独立审阅' },
    { key: 'identity', group: '项目资料', title: '项目与会话', hint: '完整身份、执行持有者与维护记录' },
    { key: 'work', title: '工作记录与依据', hint: '完整 ID、工作区、验证和集成证据' },
  ];
}

export function projectDetail(view: TuiViewModel, events: readonly SemanticEvent[], key: string): readonly string[] {
  if (key === 'budget') return [
    ...view.budgets.map(item => item.budgetKey + ': 已用 ' + item.consumed + ' · 批准引用 ' + item.approvedLimitRef),
    '数值上限、费用与 Token usage：不可用',
    '授权引用: ' + (view.scope.authorization ? view.scope.authorization.authorizationId + ' v' + view.scope.authorization.version : '尚未授权'),
    '已批准 Manifest 正文：不可用；候选审阅另有入口',
  ];
  if (key === 'identity') return [
    'Scope: ' + view.scope.coordinationScopeId, 'revision: ' + view.scope.revision,
    'Planning Cycle: ' + (view.scope.planningCycleId ?? '未建立'), 'Map revision: ' + view.scope.mapRevision,
    'Execution holder: ' + (view.scope.executionLeaseHolderSessionId ?? '无'),
    '仓库/分支展示标签、Ticket Claim：不可用',
    ...view.sessions.flatMap(s => ['Session: ' + s.coordinatorSessionId, '配置: ' + s.coordinatorModelConfigurationRef + ' · ' + s.lifecycleState]),
    '维护: ' + (view.maintenance ? (view.maintenance.stopped?'停止':'运行')+' · cycles '+view.maintenance.cyclesRun+' · '+(view.maintenance.stopReason??'无停止原因') : '未观察'),
    '压缩: ' + (view.compaction ? view.compaction.status+' · '+(view.compaction.reason??'无原因')+' · path '+(view.compaction.path??'未提供') : '未观察'),
    ...view.blockers.map(b => '阻塞: ' + b.code + ' · ' + b.message),
  ];
  if (key === 'work') return [
    ...(view.graph?view.graph.nodes.slice(0, PROJECT_DETAILS_MAX_ITEMS - 3).map(n=>[n.title+' · '+n.workPackageId+' ['+n.state+']',...graphDetailRows(n,view.graph!,0),...graphDetailRows(n,view.graph!,1),...graphDetailRows(n,view.graph!,2)].join('\n')):['当前图不可用']),
    view.execution.recoveries.slice(0, PROJECT_DETAILS_MAX_ITEMS).flatMap(recoveryRows).join('\n'),
    ['Finalizer', ...finalizerRows(view.execution.finalizer)].join('\n'),
    '历史图版本和依据全文读取：不可用',
  ];
  if (key.startsWith('event:')) {
    const event = events.find(event=>event.eventId===key.slice(6));
    return event ? [describeSemanticEvent(event), '事件 ID: '+event.eventId, '所属会话: '+(event.coordinatorSessionId??'Scope')] : ['该事件已移出本次启动窗口'];
  }
  const item = (view.pendingPage?.items ?? view.interactions).find(i => i.interactionId === key);
  return item ? ['interaction: ' + item.interactionId, 'owner: ' + item.ownerCoordinatorSessionId,
    'state: ' + item.state + ' · expected revision: ' + item.expectedRevision, 'subject: ' + item.subjectRef.id,
    item.questionPreview || '问题正文不可用', 'Enter 在所属会话回答，Esc 保存并返回'] : ['当前对象不可用'];
}

function projectDetailLines(view: TuiViewModel, events: readonly SemanticEvent[], panel: ProjectPanelState, inner: number, details?: ProjectDetailPage | null, detailNotice?: string | null, detailObjectKey?: string | null): readonly string[] {
  if (detailObjectKey !== undefined && detailObjectKey !== null) {
    return remoteProjectDetailLines(view, panel, inner, details, detailNotice, detailObjectKey);
  }
  if (panel.detail === null) return [];
  let remaining = PROJECT_DETAILS_MAX_PAGE_BYTES;
  const source = projectDetail(view, events, panel.detail)
    .slice(0, PROJECT_DETAILS_MAX_ITEMS)
    .map(line => {
      const text = line.slice(0, Math.floor(remaining / 3));
      remaining -= new TextEncoder().encode(text).byteLength;
      return text;
    });
  return source.flatMap(line => wrapByDisplayWidth(line, inner));
}

function remoteProjectDetailLines(view: TuiViewModel, panel: ProjectPanelState, inner: number, details?: ProjectDetailPage | null, detailNotice?: string | null, detailObjectKey?: string): readonly string[] {
  const detailsMatch=details?.objectKey===(detailObjectKey??panel.detail)&&details.coordinatorSessionId===view.selectedSessionId&&details.revision===view.scope.revision;
  const staleBinding = details !== undefined && details !== null && !detailsMatch;
  const status = detailNotice ?? (staleBinding ? '项目详情已失效；返回后重新读取' : '项目详情读取中或暂不可用；可返回后重试');
  const source = detailsMatch
    ? [...details.items.map(item=>`${item.label}: ${item.value}`),...(details.nextCursor?['PgDn 读取后续字段']:[])]
    : detailNotice ? [] : [status];
  return panel.detail === null ? [] : [...(detailNotice?[detailNotice]:[]),...source].flatMap(s => wrapByDisplayWidth(s, inner));
}

export function projectDetailViewport(view: TuiViewModel, events: readonly SemanticEvent[], panel: ProjectPanelState, width: number, height: number, details?: ProjectDetailPage | null, detailNotice?: string | null, detailObjectKey?: string | null, preparedLines?: readonly string[]) {
  const inner = Math.max(1, width - 4), rows = Math.max(1, height - 7);
  const lines = preparedLines ?? projectDetailLines(view, events, panel, inner, details, detailNotice, detailObjectKey);
  const maxScroll = Math.max(0, lines.length - rows);
  return {inner, rows, lines, maxScroll, offset: Math.min(panel.scroll, maxScroll)};
}

export function ProjectPanel({ view, events, panel, width, height, details, detailNotice, detailObjectKey }: {
  readonly view: TuiViewModel; readonly events: readonly SemanticEvent[]; readonly panel: ProjectPanelState; readonly width: number; readonly height: number;
  readonly details?: ProjectDetailPage | null; readonly detailNotice?: string | null; readonly detailObjectKey?: string | null;
}) {
  const inner = Math.max(1, width - 4);
  const remoteLines = useMemo(() => detailObjectKey == null ? null : remoteProjectDetailLines(view, panel, inner, details, detailNotice, detailObjectKey),
    [detailObjectKey, detailNotice, details, inner, panel.detail, view.scope.revision, view.selectedSessionId]);
  const {rows,lines,offset} = projectDetailViewport(view,events,panel,width,height,details,detailNotice,detailObjectKey,remoteLines ?? undefined);
  const fit = (s: string) => truncateToDisplayWidth(s, inner);
  const items = projectItems(view, events, panel.tab);
  const selected = items.findIndex(i => i.key === panel.selectedKey);
  const index = Math.max(0, selected);
  const selectionLost=panel.selectedKey!==null&&selected<0;
  const highlighted=panel.selectedKey===null?0:selected;
  const rowHeight=panel.tab===0?3:2;
  const count=Math.max(1,Math.floor((rows-(selectionLost?1:0))/rowHeight));
  const start=Math.min(Math.max(0,index-Math.floor(count/2)),Math.max(0,items.length-count));
  return <Box width={width} height={height} flexShrink={0} flexDirection="column" borderStyle="round" borderColor={tuiColors.border} paddingX={1} overflow="hidden">
    <Text bold color={tuiColors.accent}>{fit('项目面板 · ' + ['总览', '待答列表', '最近事件'][panel.tab] + (panel.detail?' · 详情':''))}</Text>
    <Text color={tuiColors.muted}>{fit(['总览', '待答列表', '最近事件'].map((s,i) => i === panel.tab ? '[' + s + ']' : s).join('  ') + ' · Tab')}</Text>
    <Text color={tuiColors.muted}>{fit(panel.tab === 2 ? '本次启动 · 最近至多 50 条' + (events.length === 50 ? ' · 窗口可能截断' : '') : panel.tab === 1 && view.pendingPage ? view.pendingPage.error ?? (view.pendingPage.loading ? '正在读取待答…' : `第 ${view.pendingPage.page} 页 · PgUp/PgDn 翻页`) : '')}</Text>
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {selectionLost&&panel.detail===null?<Text color={tuiColors.warning}>{fit('所选对象已不在当前窗口，请重新选择')}</Text>:null}
      {panel.detail !== null ? lines.slice(offset, offset + rows).map((line,i) => <Text key={i}>{line}</Text>) :
        items.length === 0 ? <Text dimColor>{panel.tab === 1 ? '暂无待答交互' : '本次启动暂无语义事件'}</Text> :
        items.slice(start, start + count).map((item,i) => <Box key={item.key} height={rowHeight} flexDirection="column">
          {panel.tab===0?<Text bold color={tuiColors.accent}>{fit(item.group?'── '+item.group+' ──':'')}</Text>:null}
          <Text bold color={highlighted === start+i ? tuiColors.focus : 'white'} inverse={highlighted === start+i}>{fit((highlighted === start+i ? '› ' : '→ ') + item.title)}</Text>
          <Text dimColor>{fit('  ' + item.hint)}</Text>
        </Box>)}
    </Box>
    <Text dimColor>{fit(panel.detail ? '↑↓ 浏览 · Esc 返回列表' : (items.length>count?'显示 '+(start+1)+'–'+Math.min(items.length,start+count)+'/'+items.length+' · ':'')+'↑↓ 选择 · Enter 打开 · Esc 返回')}</Text>
  </Box>;
}
