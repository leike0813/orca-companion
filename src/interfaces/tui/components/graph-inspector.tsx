import { Box, Text } from 'ink';
import { useSpinner } from '@inkjs/ui';
import { fieldRows } from './selection-list.js';
import { adaptiveGraphCanvas } from '../render/graph-layout.js';
import { truncateToDisplayWidth } from '../render/width.js';
import type { GraphView, TuiViewModel, WorkPackageNodeView } from '../../../application/tui/view-model.js';
import { tuiColors, tuiIconMode, tuiIcons, tuiSpinnerGlyphs, type TuiIconMode } from '../theme.js';

export type GraphInspectorProps = {
  readonly graph: GraphView | null; readonly selectedWorkPackageId: string | null;
  readonly onSelect: (workPackageId: string) => void; readonly narrow: boolean; readonly availableWidth: number;
  readonly view?: TuiViewModel; readonly rows?: number; readonly tab?: number; readonly scroll?: number;
  readonly relations?: readonly string[] | null; readonly relationIndex?: number; readonly iconMode?: TuiIconMode;
  readonly detail?: boolean;
};
export function upstreamOf(graph: GraphView, workPackageId: string): readonly string[] {
  return graph.nodes.find(n => n.workPackageId === workPackageId)?.dependsOn ?? [];
}
export function selectedGraphNode(graph: GraphView | null, selectedId: string | null): WorkPackageNodeView | undefined {
  return selectedId===null ? graph?.nodes.find(node=>node.active)??graph?.nodes[0] : graph?.nodes.find(node=>node.workPackageId===selectedId);
}
function graphFields(node:WorkPackageNodeView,graph:GraphView,tab:number):readonly {label:string;value:string}[] {
  if(tab===1)return [{label:'包含:',value:node.scopeEnvelope.include.join(', ')||'无'},{label:'排除:',value:node.scopeEnvelope.exclude.join(', ')||'无'},{label:'依据:',value:node.derivedFrom.join(', ')||'无'}];
  if(tab===2)return [{label:'节点:',value:node.workPackageId},{label:'图:',value:graph.graphId+' v'+graph.graphVersion+' · G'+graph.generation},
    {label:'准入:',value:(graph.readiness.generationStatus??'不可用')+' · 授权 '+(graph.readiness.authorizationBound?'bound':'unbound')},
    {label:'baseline:',value:node.baselineHead??'未提供'},{label:'worktree:',value:node.worktreePath??'未建立'}];
  return [{label:'角色:',value:node.role??'未派发'},{label:'尝试:',value:node.attemptId??'未建立'},
    {label:'工作区:',value:node.worktreePath??'未建立'},
    {label:'验证:',value:node.validation?.state??'未提供'},{label:'集成:',value:node.integration?.state??'未提供'},
    {label:'证据:',value:node.validation?.evidenceRefs.join(', ')||'无'},
    {label:'集成引用:',value:node.integration?.ref??'无'},{label:'derivedFrom:',value:node.derivedFrom.join(', ')||'无'},
    ...(node.revisionHold?[{label:'revision pending:',value:node.revisionHold.source}]:[]),
    ...(node.reconciliation?[{label:'reconcile:',value:node.reconciliation.severity+' · required '+node.reconciliation.requiredBaselineHead+' · observed '+(node.reconciliation.observedHead??'未知')}]:[]),
    ...node.blockerRefs.map(ref=>({label:'!',value:ref}))];
}
export function graphDetailRows(node:WorkPackageNodeView,graph:GraphView,tab:number):readonly string[] {
  return graphFields(node,graph,tab).map(field=>field.label+' '+field.value);
}
function NodeSpinner({ mode }: { readonly mode: TuiIconMode }) {
  const {frame}=useSpinner({type:mode==='ascii'?'line':'moon'});
  return <Text>{mode==='ascii'?frame:tuiSpinnerGlyphs[frame.trim()]??tuiIcons.nerd.running}</Text>;
}
export function AdaptiveGraph({ graph, selectedId, width, height, planning, inspector=false, detail=false, tab=0, scroll=0, iconMode=tuiIconMode }: {
  readonly graph: GraphView | null; readonly selectedId: string | null; readonly width: number; readonly height: number; readonly planning: boolean;
  readonly inspector?: boolean; readonly tab?: number; readonly scroll?: number; readonly iconMode?: TuiIconMode;
  readonly detail?: boolean;
}) {
  const fit=(s:string)=>truncateToDisplayWidth(s,Math.max(1,width));
  const node=selectedGraphNode(graph,selectedId);
  const cardHeight=detail?height-2:inspector?Math.min(13,Math.max(9,Math.floor(height/2))):7;
  const canvas=adaptiveGraphCanvas(graph?.nodes??[],Math.max(1,width),Math.max(1,height-cardHeight-2),node?.workPackageId??null,planning,iconMode);
  const lineChars=iconMode==='ascii'?[' ','|','-','+','|','|','+','+','-','+','-','+','+','+','+','+']:[' ','│','─','└','│','│','┌','├','─','┘','─','┴','┐','┤','┬','┼'];
  const cardWidth=Math.max(1,width-4);
  const dependencies=(ids:readonly string[])=>ids.map(id=>{const n=graph?.nodes.find(n=>n.workPackageId===id);return n?String(n.position+1)+(inspector?' '+n.title:''):id;}).join(' · ')||'无';
  const details=node&&graph?fieldRows(graphFields(node,graph,tab),cardWidth):[];
  const detailBudget=Math.max(1,cardHeight-8);
  const offset=Math.min(scroll,Math.max(0,details.length-detailBudget));
  return <Box flexDirection="column" height={height} overflow="hidden">
    <Text color={tuiColors.accent}>{fit(graph===null?'图不可用':(planning?'候选图':'执行图')+' G'+graph.generation+'·v'+graph.graphVersion+' · '+graph.nodes.length+' 节点')}</Text>
    <Text dimColor>{fit(detail?'完整记录 · ↑↓滚动':'纵向 '+(canvas.fullWidth>width?'图外 ←'+canvas.startX+' →'+(canvas.fullWidth-width-canvas.startX)+' · ':'')+(canvas.fullHeight>canvas.cells.length?'图外 ↑'+canvas.start+' ↓'+Math.max(0,canvas.fullHeight-canvas.start-canvas.cells.length):'全图可见'))}</Text>
    {detail?null:canvas.cells.map((line,y)=><Text key={y}>{line.map((c,x)=><Text key={x} color={c.color}>{c.spinning?<NodeSpinner mode={iconMode}/>:c.glyph??lineChars[c.mask]}</Text>)}</Text>)}
    <Box flexGrow={1}/>
    <Box borderStyle="round" borderColor={tuiColors.border} paddingX={1} flexDirection="column" height={cardHeight} flexShrink={0} overflow="hidden">
      <Text bold color={tuiColors.accent}>{truncateToDisplayWidth(node?String(node.position+1)+' '+node.title:'所选节点不可用',cardWidth)}</Text>
      {node?<><Text>{truncateToDisplayWidth(node.state+' · Worker '+(node.liveness??'未观察'),cardWidth)}</Text>
      <Text color={tuiColors.accent}>── 依赖关系 ──</Text>
      <Text>{truncateToDisplayWidth('前驱 '+dependencies(node.dependsOn),cardWidth)}</Text>
      <Text>{truncateToDisplayWidth('后继 '+dependencies(graph?.nodes.filter(n=>n.dependsOn.includes(node.workPackageId)).map(n=>n.workPackageId)??[]),cardWidth)}</Text>
      {inspector?<><Text color={tuiColors.accent}>{truncateToDisplayWidth('['+['执行依据','工作范围','完整身份'][tab]+'] · Tab · ↑↓浏览',cardWidth)}</Text>
      {details.slice(offset,offset+detailBudget).map((s,i)=><Text key={i}>{s}</Text>)}</>:null}</>:null}
    </Box>
  </Box>;
}
export function GraphInspector(props: GraphInspectorProps) {
  const mode=props.iconMode??tuiIconMode;
  const width=Math.max(1,props.availableWidth-4);
  const acceptance=props.view?.projectPresentation?.acceptance;
  return <Box width={props.availableWidth} height={Math.max(8,(props.rows??24)-4)} flexDirection="column" borderStyle="round" borderColor={tuiColors.border} paddingX={1}>
    <Text bold color={tuiColors.accent}>执行图检查 · Graph Inspector</Text>
    <Text color={acceptance?tuiColors.success:tuiColors.muted}>{truncateToDisplayWidth(acceptance?`验收 ${acceptance.validatedCount}/${acceptance.totalCount} · G${acceptance.generation} v${acceptance.version}`:'验收摘要不可用',width)}</Text>
    <AdaptiveGraph graph={props.graph} selectedId={props.selectedWorkPackageId} width={width} height={Math.max(5,(props.rows??24)-9-(props.relations?1:0))} planning={props.view?.scope.mode==='route_planning'} inspector detail={props.detail??false} tab={props.tab??0} scroll={props.scroll??0} iconMode={mode}/>
    {props.relations?<Text inverse color={tuiColors.focus}>{truncateToDisplayWidth('选择关系 '+((props.relationIndex??0)+1)+'/'+props.relations.length+': '+props.relations[props.relationIndex??0]+' · ↑↓ Enter',width)}</Text>:null}
    <Text dimColor>{truncateToDisplayWidth('↑↓ 选择 · ←→ 关系 · Enter 详情 · Tab 栏目 · Esc 返回',width)}</Text>
  </Box>;
}
