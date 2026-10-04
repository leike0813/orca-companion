import { Box, Text } from 'ink';
import { compactGraphRow, layoutExecutionGraph, visibleRows } from '../render/graph-layout.js';
import { sidebarWidthFor, truncateToDisplayWidth } from '../render/width.js';
import { AdaptiveGraph } from './graph-inspector.js';
import type { TuiViewModel } from '../../../application/tui/view-model.js';
import type { SidebarDensity } from '../state.js';
import { tuiColors, tuiIconMode, type TuiIconMode } from '../theme.js';
export type SidebarProps = { readonly density: SidebarDensity; readonly viewModel: TuiViewModel; readonly terminalWidth: number; readonly height?: number; readonly selectedId?: string | null; readonly iconMode?: TuiIconMode };
export const SIDEBAR_COLLAPSED_MARKER='sidebar 已折叠 · Ctrl+G 检查';
export function compactGraphLines(view:TuiViewModel,width:number):readonly string[] {
  return visibleRows(layoutExecutionGraph(view.graph?.nodes??[])).slice(0,6).map(row=>truncateToDisplayWidth(compactGraphRow(row),width));
}
export function Sidebar(props:SidebarProps) {
  if(props.density==='collapsed') return <Text>{SIDEBAR_COLLAPSED_MARKER}</Text>;
  const view=props.viewModel, width=sidebarWidthFor(props.density), height=props.height??32;
  const fit=(s:string)=>truncateToDisplayWidth(s,width);
  const active=view.graph?.nodes.find(n=>n.active);
  const acceptance=view.projectPresentation?.acceptance;
  const risks=view.blockers.slice(0,2).map(b=>'! '+b.code+': '+b.message);
  if(view.execution.reconciliation.pending) risks.unshift('reconciling · 待对账');
  return <Box width={width+2} height={height} borderStyle="single" borderTop={false} borderBottom={false} borderRight={false} borderColor={tuiColors.border} flexDirection="column" paddingLeft={1} overflow="hidden">
    <Text bold color={tuiColors.accent}>{fit('执行图侧栏'+(view.scope.mode==='execution_coordination'?' · active '+view.execution.activeWorkPackageCount:''))}</Text>
    <Text color={acceptance?tuiColors.success:tuiColors.muted}>{fit(acceptance?`验收 ${acceptance.validatedCount}/${acceptance.totalCount} · G${acceptance.generation} v${acceptance.version}`:'验收摘要不可用')}</Text>
    <AdaptiveGraph graph={view.graph} selectedId={props.selectedId??null} width={width} height={Math.max(8,height-5-risks.length)} planning={view.scope.mode==='route_planning'} iconMode={props.iconMode??tuiIconMode}/>
    {active?<Text color={tuiColors.accent}>{fit('当前 '+active.shortKey+' · '+active.state+' · '+(active.liveness??'未观察'))}</Text>:null}
    {view.execution.integrationQueue.length?<Text>{fit('集成队列（串行） '+view.execution.integrationQueue.map(n=>n.workPackageId).join(' → '))}</Text>:null}
    {risks.map((s,i)=><Text key={i} color={tuiColors.error}>{fit(s)}</Text>)}
    <Box flexGrow={1}/>
    <Text dimColor>{fit('图标异常？选项切ASCII')}</Text>
  </Box>;
}
