import { Box, Text } from 'ink';
import { displayWidth, truncateToDisplayWidth } from '../render/width.js';
import type { CompactionView, ExecutionProjectionView, GraphView, MaintenanceView, ScopeView } from '../../../application/tui/view-model.js';
import type { SidebarDensity } from '../state.js';
import { tuiColors } from '../theme.js';
import type { ProjectPresentation } from '../../../application/tui/project-presentation.js';
import { DEFAULT_TUI_PREFERENCES, type StatuslinePreferences } from '../../../application/configuration/tui-preferences.js';

export type StatusLineProps = {
  readonly scope: ScopeView; readonly compaction: CompactionView | null; readonly maintenance: MaintenanceView | null;
  readonly blockerCount: number; readonly notice: string | null; readonly sidebarDensity: SidebarDensity;
  readonly availableWidth: number; readonly execution: ExecutionProjectionView | null;
  readonly model?: string | null; readonly graph?: GraphView | null;
  readonly presentation?: ProjectPresentation;
  readonly preferences?: StatuslinePreferences;
};
export function compactionLabel(compaction: CompactionView | null): string | null {
  if (compaction === null || compaction.status === 'not_needed') return null;
  return compaction.status + (compaction.reason ? ': ' + compaction.reason : '');
}
export function StatusLine(props: StatusLineProps) {
  const width = Math.max(1, props.availableWidth);
  const presentation = props.presentation;
  const preferences = props.preferences ?? DEFAULT_TUI_PREFERENCES.statusline;
  const model = presentation?.session?.model ?? props.model ?? null;
  const effort = presentation?.session?.effort;
  const context = presentation?.context;
  const effortText = effort?.status === 'configured' ? `推理 ${effort.value}` : effort?.status === 'not_configured' ? '推理 未配置' : effort?.status === 'not_supported' ? '推理 不支持' : '推理 不可用';
  const contextText = context?.status === 'available' ? formatContext(context.used, context.capacity, preferences.contextFormat) : '上下文 不可用';
  const rawCore = [model ?? '模型不可用', effortText, contextText];
  const minimumCoreWidth = [1, 8, 10];
  const coreColors = [tuiColors.accent, tuiColors.focus, tuiColors.success];
  const core: {text:string;color:string}[] = [];
  let usedWidth = 0;
  for (let index = 0; index < rawCore.length; index += 1) {
    const separator = core.length === 0 ? 0 : displayWidth(' · ');
    const remaining = width - usedWidth - separator;
    if (remaining < 1) break;
    const reserved = rawCore.slice(index + 1).reduce((sum, text, offset) =>
      sum + displayWidth(' · ') + Math.min(displayWidth(text), minimumCoreWidth[index + offset + 1]!), 0);
    const partWidth = Math.max(1, remaining - reserved);
    let text = rawCore[index]!;
    if (index === 0 && preferences.modelFormat === 'provider-model' && model !== null && presentation?.session?.provider) {
      const full = `${presentation.session.provider}/${model}`;
      text = displayWidth(full) <= partWidth ? full : model;
    }
    text = truncateToDisplayWidth(text, partWidth, '…');
    core.push({ text, color: coreColors[index]! });
    usedWidth += separator + displayWidth(text);
  }
  const accepted = presentation?.acceptance;
  const extras: {text:string;color:string;ticket?:{ref:string;title:string}}[] = [];
  for (const field of preferences.fields) {
    if (field === 'ticket' && props.scope.mode !== 'route_planning') continue;
    if (field === 'work-package' && props.scope.mode !== 'execution_coordination') continue;
    if (field === 'graph') extras.push({text:props.graph===undefined?'图不可用':props.graph===null?'图未建立':`图 G${props.graph.generation ?? '?'}·v${props.graph.graphVersion}`,color:'blueBright'});
    else if (field === 'ticket' && presentation?.ticket) extras.push({text:`票 ${presentation.ticket.ref}`,color:tuiColors.focus,ticket:presentation.ticket});
    else if (field === 'ticket' && presentation === undefined) extras.push({text:'规划票不可用',color:tuiColors.focus});
    else if (field === 'ticket' && presentation?.ticket === null) extras.push({text:'未领取规划票',color:tuiColors.focus});
    else if (field === 'work-package') extras.push({text:presentation===undefined?'执行工作包不可用':presentation.activeWorkPackage===null?'执行空闲':`执行 WP ${presentation.activeWorkPackage.id} ${presentation.activeWorkPackage.title}`,color:tuiColors.accent});
    else if (field === 'progress' && accepted) extras.push({text:preferences.progressFormat === 'percent'
      ? accepted.totalCount === 0 ? '验收 尚无工作包' : `验收 ${Math.floor(accepted.validatedCount * 100 / accepted.totalCount)}%`
      : `验收 ${accepted.validatedCount}/${accepted.totalCount}`,color:tuiColors.success});
    else if (field === 'progress') extras.push({text:'验收进度不可用',color:tuiColors.success});
    else if (field === 'budget' && presentation) {
      const budget = presentation.budgets[preferences.budgetKey === 'work-packages' ? 'workPackages' : preferences.budgetKey === 'implementation-attempts' ? 'implementationAttempts' : 'recovery'];
      if (budget?.status === 'available') extras.push({text:`预算 ${budget.subject ?? '主体未知'} ${budget.consumed ?? '不可用'}/${budget.limit ?? '上限未知'}`,color:tuiColors.focus});
      else extras.push({text:'预算不可用',color:tuiColors.focus});
    } else if (field === 'budget') {
      extras.push({text:'预算不可用',color:tuiColors.focus});
    }
  }
  const visible = [...core];
  for (const part of extras) {
    const prefix = visible.map(s=>s.text).join(' · ');
    const room = width - displayWidth(prefix) - 3;
    if (room <= 0) break;
    if(part.ticket){
      if(displayWidth(part.text)>room)break;
      const titleWidth=room-displayWidth(part.text)-1;
      const value=titleWidth>0?`${part.text} ${truncateToDisplayWidth(part.ticket.title,titleWidth,'…')}`:part.text;
      visible.push({...part,text:value});
    }else if(displayWidth(part.text)<=room)visible.push(part);
    else break;
  }
  return <Box><Text>{visible.map((part,i) => <Text key={i}>{i ? <Text color={tuiColors.muted}> · </Text> : null}<Text color={part.color}>{part.text}</Text></Text>)}</Text></Box>;
}

function formatContext(used:number, capacity:number, format:StatuslinePreferences['contextFormat']):string {
  if(format==='remaining')return `上下文 剩余 ${Math.round(Math.max(0,capacity-used)*100/capacity)}%`;
  if(format==='tokens')return `上下文 ${used}/${capacity} tokens`;
  return `上下文 已用 ${Math.round(used*100/capacity)}%`;
}
