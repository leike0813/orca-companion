/**
 * 工作区主视图：顶栏 / transcript / Pending Interaction 卡片 / composer / 状态行 常驻，Sidebar 与
 * overlay 按展示态组合。
 *
 * 组件本身不订阅 stdin、不调用端口、不推进状态：它只把 view model 渲染出来，并把用户动作交给传入的
 * 回调。overlay 只渲染栈顶，`Esc` 由容器翻译成 `overlay-close-top`。
 */

import { Box, Text, useBoxMetrics, type DOMElement } from 'ink';
import { useEffect, useRef, type ReactElement } from 'react';
import { AnswerPanel, type AnswerPanelView } from '../components/answer-panel.js';
import { PasteViewer, type PasteViewerView } from '../components/paste-viewer.js';

import { CommandPalette, commandReason, slashCandidates, type CommandId } from '../components/command-palette.js';
import { Composer } from '../components/composer.js';
import { ControlBar } from '../components/control-bar.js';
import { ProjectPanel } from '../components/project-panel.js';
import { DialogFrame } from '../components/selection-list.js';
import { tuiColors } from '../theme.js';
import { GraphInspector } from '../components/graph-inspector.js';
import { HandoffReview } from '../components/handoff-review.js';
import {
  InputRecordManager,
  type InputRecordManagerView,
} from '../components/input-record-manager.js';
import { AuthorizationReview } from '../components/authorization-review.js';
import { InteractionCard } from '../components/interaction-card.js';
import { ModelPicker } from '../components/model-picker.js';
import { SessionPicker } from '../components/session-picker.js';
import { Sidebar } from '../components/sidebar.js';
import { StatusLine } from '../components/status-line.js';
import { TopBar } from '../components/top-bar.js';
import { Transcript } from '../components/transcript.js';
import type { TranscriptFrame } from '../render/transcript-reader.js';
import { sidebarWidthFor, truncateToDisplayWidth } from '../render/width.js';
import type { ExecutionAuthorizationLoad, ModelCatalog } from '../ports.js';
import type {
  ControllerHandoffView,
  ControllerPlanningHandoffView,
  SemanticEvent,
} from '../../../application/controller-service.js';
import type { TuiViewModel } from '../../../application/tui/view-model.js';
import type { OverlayKind, TuiAction, TuiState } from '../state.js';
import { composerDraftFor, composerInputFor, isComposerReadOnly } from '../state.js';
import type { UiDraft } from '../../../application/ports/ui-input-store.js';

export type WorkspaceActions = {
  readonly dispatch: (action: TuiAction) => void;
  readonly composerChange: (draft: UiDraft) => void;
  readonly submit: () => void;
  readonly toggleTool: (entryId: string) => void;
  readonly selectSession: (coordinatorSessionId: string) => void;
  readonly selectRecipient?: (coordinatorSessionId: string) => void;
  readonly enterAnswer: (interactionId: string, expectedRevision: number) => void;
  readonly runCommand: (command: CommandId) => void;
  readonly selectModel: (configurationRef: string) => void;
  readonly confirmPending: () => void;
  readonly dismissPending: () => void;
  readonly confirmHandoff: () => void;
  readonly cancelHandoff: () => void;
  readonly confirmExecutionHandoff: () => void;
  readonly cancelExecutionHandoff: () => void;
  readonly confirmAuthorization: () => void;
  readonly cancelAuthorization: () => void;
  readonly closeTopOverlay: () => void;
};

export type WorkspaceProps = {
  readonly viewModel: TuiViewModel;
  readonly ui: TuiState;
  readonly terminalWidth: number;
  readonly terminalHeight?: number;
  readonly onTranscriptHeight?: (height: number) => void;
  readonly transcriptFrame?: TranscriptFrame | null;
  readonly events: readonly SemanticEvent[];
  readonly actions: WorkspaceActions;
  readonly modelCatalog: ModelCatalog;
  readonly modelRejection: string | null;
  readonly paletteSelection: number;
  readonly composerDisabledReason: string | null;
  readonly newlineHint: string;
  readonly handoffProposal: ControllerPlanningHandoffView | null;
  readonly authorizationReview: ExecutionAuthorizationLoad | null;
  readonly commands: readonly CommandId[];
  /** 输入记录管理的当前投影；`null` 表示 overlay 未打开。 */
  readonly inputManager?: InputRecordManagerView | null;
  readonly answerPanel?: AnswerPanelView | null;
  readonly pasteViewer?: PasteViewerView | null;
};

/** overlay 未打开时的空投影：组件本身不猜记录，只渲染容器读好的内容。 */
export const EMPTY_INPUT_MANAGER: InputRecordManagerView = {
  entries: [],
  usage: { records: 0, bytes: 0 },
  selectedIndex: 0,
  bodyScroll: 0,
  bodyFocus: false,
  feedback: null,
  confirmDelete: false,
};

/**
 * 主视图可用宽度：先给 Sidebar 预算，剩下的都留给 transcript 与 composer。
 *
 * 100 列及以上保留紧凑右侧区域给项目面板；更窄时折叠 Sidebar。输入与渲染消费同一有效密度。
 */
export function bodyWidth(terminalWidth: number, density: TuiState['sidebarDensity']): number {
  const effective = density === 'collapsed' && terminalWidth >= 100 ? 'compact' : density;
  return Math.max(20, terminalWidth - sidebarWidthFor(effective) - 2);
}

export function workspaceLayout(view: TuiViewModel, ui: TuiState, terminalWidth: number, rows: number) {
  const width=bodyWidth(terminalWidth,ui.sidebarDensity);
  const alerts=[
    ...(ui.notice?[ui.notice]:[]),
    ...(view.transcript.hasUpdates ? ['当前会话有更新 · Ctrl+End 查看'] : []),
    ...(view.execution.reconciliation.pending?['reconciling · 原操作结果未知，待对账']:[]),
    ...(view.execution.hazards.unverifiedWorkerCount?['Worker 状态待核验']:[]),
    ...(view.scope.controlState==='cancelling'?['停止结果待核验']:[]),
    ...view.blockers.slice(0,1).map(b=>b.code+': '+b.message),
    ...(view.compaction?.status==='context_exhausted'?['context_exhausted · 输入仍保留']:[]),
    ...(view.compaction?.status==='compaction_degraded'?['compaction_degraded · '+(view.compaction.reason??'')]:[]),
  ];
  const riskRows=Math.min(2,alerts.length),bodyRows=Math.max(8,rows-3-riskRows);
  return {width,bodyRows,alerts,projectWidth:terminalWidth>=100?terminalWidth-width:terminalWidth};
}

export function Workspace(props: WorkspaceProps) {
  const rowRef=useRef<DOMElement>(null), bodyRef=useRef<DOMElement>(null), transcriptRef=useRef<DOMElement>(null);
  const rowMetrics=useBoxMetrics(rowRef),bodyMetrics=useBoxMetrics(bodyRef),transcriptMetrics=useBoxMetrics(transcriptRef);
  const transcriptHeight = transcriptMetrics.hasMeasured ? Math.max(1, Math.round(transcriptMetrics.height)) : null;
  useEffect(() => { if (transcriptHeight !== null) props.onTranscriptHeight?.(transcriptHeight); }, [transcriptHeight, props.onTranscriptHeight]);
  const view=props.viewModel,ui=props.ui,rows=props.terminalHeight??24;
  const {width,bodyRows,alerts,projectWidth}=workspaceLayout(view,ui,props.terminalWidth,rows);
  const selected=ui.selectedSessionId,input=composerInputFor(ui,selected),readOnly=isComposerReadOnly(ui,selected);
  const overlay=ui.overlayStack.at(-1)??null;
  const focus=overlay===null&&ui.pendingConfirmation===null&&!ui.projectPanel.open;
  const interactions=view.interactions.filter(i=>i.state==='open'&&i.ownerCoordinatorSessionId===selected);
  const candidates=ui.slashDismissed?[]:slashCandidates(input.text,view.scope.mode);
  const candidateRows=Math.min(candidates.length,Math.min(3,Math.max(1,rows-21)))+4;
  const reasons=Object.fromEntries(props.commands.flatMap(c=>{const reason=commandReason(c,{mode:view.scope.mode,selectedSessionId:selected,pasteBlocks:input.pasteBlocks.length});return reason?[[c,reason]]:[];}));
  const origin={x:rowMetrics.left+bodyMetrics.left,y:rowMetrics.top+bodyMetrics.top};
  const panel=props.answerPanel;
  const modelRef=view.sessions.find(s=>s.coordinatorSessionId===selected)?.coordinatorModelConfigurationRef;
  const model=props.modelCatalog.options.find(o=>o.configurationRef===modelRef)?.model??null;
  const project=<ProjectPanel view={view} events={props.events} panel={ui.projectPanel} width={projectWidth} height={bodyRows}/>;
  if(overlay==='paste-viewer'&&props.pasteViewer) return <PasteViewer view={props.pasteViewer} width={props.terminalWidth} rows={rows}/>;
  return <Box flexDirection="column" height={rows-1} overflow="hidden">
    <TopBar coordinationScopeId={view.scope.coordinationScopeId} mode={view.scope.mode} controlState={view.scope.controlState}
      graphLabel={null} generation={view.graph?.generation??null} authorizationLabel={null} activeWorkPackageCount={view.execution.activeWorkPackageCount}
      reconciling={view.execution.reconciliation.pending} availableWidth={props.terminalWidth} sessionId={selected}
      holder={view.scope.executionLeaseHolderSessionId} pendingCount={view.interactions.filter(i=>i.state==='open').length}/>
    {alerts.slice(0,2).map((s,i)=><Text key={i} color={tuiColors.warning}>{truncateToDisplayWidth('! '+s+(i===1&&alerts.length>2?' · 另有 '+(alerts.length-2)+' 项':''),props.terminalWidth)}</Text>)}
    {overlay!==null?<Box height={bodyRows} width={props.terminalWidth} justifyContent="center" flexDirection="column"><Overlay overlay={overlay} props={props} narrow={props.terminalWidth<100}/></Box>:
    ui.pendingConfirmation!==null?<Box height={bodyRows} width={props.terminalWidth} justifyContent="center" flexDirection="column"><ControlBar controlState={view.scope.controlState} hazards={view.execution.hazards} pending={ui.pendingConfirmation} availableWidth={props.terminalWidth}
      rows={Math.max(10,rows-7)} tab={ui.reviewTab} scroll={ui.reviewScroll} action={ui.reviewAction}
      scopeId={view.scope.coordinationScopeId} sessionCount={view.sessions.length}
      onConfirm={props.actions.confirmPending} onDismiss={props.actions.dismissPending}/></Box>:
    ui.projectPanel.open&&props.terminalWidth<100?project:
    <Box ref={rowRef} flexDirection="row" height={bodyRows} flexShrink={0}>
      <Box ref={bodyRef} flexDirection="column" width={width} height={bodyRows}>
        <Box ref={transcriptRef} flexDirection="column" flexGrow={1} flexBasis={0} minHeight={1} overflow="hidden">
          <Transcript transcript={view.transcript} {...(props.transcriptFrame === undefined ? {} : { frame: props.transcriptFrame })} expandedToolIds={ui.expandedToolIds} onToggleTool={props.actions.toggleTool} availableWidth={width}
            maxLines={transcriptMetrics.hasMeasured?Math.max(1,Math.round(transcriptMetrics.height)):Math.max(1,bodyRows-12)}/>
        </Box>
        {candidates.length&&focus?<CommandPalette commands={candidates} selectedIndex={Math.min(ui.slashIndex,candidates.length-1)} onRun={props.actions.runCommand}
          availableWidth={width} maxRows={Math.min(3,Math.max(1,rows-21))} reasons={reasons} slash/>:null}
        {panel?<AnswerPanel view={panel} draft={input} width={width} rows={bodyRows-1-(candidates.length&&focus?candidateRows:0)} origin={origin} focused={focus} readOnly={readOnly} disabledReason={props.composerDisabledReason}/>:
        <><>{interactions.slice(0,1).map(i=><InteractionCard key={i.interactionId} interaction={i} answering={false} onEnterAnswer={props.actions.enterAnswer} availableWidth={width}/>)}</>
        <Composer value={composerDraftFor(ui,selected)} draft={input} terminalHeight={rows} focused={focus} origin={origin} mode={ui.composerMode} readOnly={readOnly}
          disabledReason={props.composerDisabledReason} newlineHint={props.newlineHint} availableWidth={width}/></>}
        <StatusLine scope={view.scope} compaction={view.compaction} maintenance={view.maintenance} blockerCount={view.blockers.length} notice={ui.notice}
          sidebarDensity={ui.sidebarDensity} execution={view.execution} availableWidth={width} model={model} graph={view.graph}/>
      </Box>
      {ui.projectPanel.open?project:ui.sidebarDensity==='collapsed'?null:<Sidebar density={ui.sidebarDensity} viewModel={view} terminalWidth={props.terminalWidth} height={bodyRows} selectedId={ui.inspectorSelection} iconMode={ui.iconMode}/>}
    </Box>}
  </Box>;
}

function Overlay(props: {
  readonly overlay: OverlayKind;
  readonly props: WorkspaceProps;
  readonly narrow: boolean;
}): ReactElement {
  const { overlay, props: parent } = props;
  switch (overlay) {
    case 'paste-viewer':
      return <PasteViewer view={parent.pasteViewer ?? { draft: composerInputFor(parent.ui, parent.ui.selectedSessionId), block: 0, scroll: 0 }} width={parent.terminalWidth} rows={parent.terminalHeight ?? 24} />;
    case 'command-palette':
      return (
        <CommandPalette
          commands={parent.commands}
          selectedIndex={parent.paletteSelection}
          onRun={parent.actions.runCommand}
          availableWidth={parent.terminalWidth}
          summary={`${parent.ui.selectedSessionId??'未选择会话'} · ${parent.viewModel.scope.mode==='route_planning'?'规划':'执行'}`}
          maxRows={Math.max(1,(parent.terminalHeight??24)-11)}
          reasons={Object.fromEntries(parent.commands.flatMap(command=>{const reason=commandReason(command,{mode:parent.viewModel.scope.mode,selectedSessionId:parent.ui.selectedSessionId,pasteBlocks:composerInputFor(parent.ui,parent.ui.selectedSessionId).pasteBlocks.length});return reason?[[command,reason]]:[];}))}
        />
      );
    case 'graph-inspector':
      return (
        <GraphInspector
          graph={parent.viewModel.graph}
          selectedWorkPackageId={parent.ui.inspectorSelection}
          onSelect={(workPackageId) =>
            parent.actions.dispatch({ kind: 'inspector-selected', workPackageId })
          }
          narrow={props.narrow}
          view={parent.viewModel} rows={Math.max(12,(parent.terminalHeight??24)-2)} detail={parent.ui.inspectorDetail} tab={parent.ui.inspectorTab} scroll={parent.ui.inspectorScroll} relations={parent.ui.inspectorRelations} relationIndex={parent.ui.relationIndex} iconMode={parent.ui.iconMode}
          availableWidth={parent.terminalWidth}
        />
      );
    case 'session-picker':
      return (
        <SessionPicker
          sessions={parent.viewModel.sessions}
          selectedSessionId={parent.ui.selectedSessionId}
          onSelect={parent.actions.selectSession}
          availableWidth={parent.terminalWidth}
          rows={Math.max(10,(parent.terminalHeight??24)-7)}
        />
      );
    case 'handoff-target':
      return <SessionPicker title="选择交接收件方" sessions={parent.viewModel.sessions} selectedSessionId={null}
        onSelect={id=>parent.actions.selectRecipient?.(id)} availableWidth={parent.terminalWidth} rows={Math.max(10,(parent.terminalHeight??24)-7)}/>;
    case 'event-drawer':
      return <ProjectPanel view={parent.viewModel} events={parent.events} panel={{...parent.ui.projectPanel,tab:2}} width={parent.terminalWidth} height={Math.max(8,(parent.terminalHeight??24)-4)}/>;
    case 'options':
      return <DialogFrame title="选项" summary="本次进程的显示选项" width={parent.terminalWidth} rows={Math.max(10,(parent.terminalHeight??24)-7)} footer="Enter 切换 · Esc 返回"><Text>图标 · {parent.ui.iconMode}</Text><Text inverse color={tuiColors.focus}>Enter 切换 Nerd / ASCII</Text><Text dimColor>状态栏设置：用户级偏好尚未接通</Text></DialogFrame>;
    case 'model-picker':
      return (
        <ModelPicker
          catalog={parent.modelCatalog}
          rejection={parent.modelRejection}
          onSelect={parent.actions.selectModel}
          availableWidth={parent.terminalWidth}
          rows={Math.max(10,(parent.terminalHeight??24)-7)}
        />
      );
    case 'handoff-review':
      return (
        <HandoffReview
          proposal={parent.handoffProposal}
          responsibleSessionId={
            parent.viewModel.sessions.find((session) => session.planningResponsible)
              ?.coordinatorSessionId ?? null
          }
          onConfirm={parent.actions.confirmHandoff}
          onCancel={parent.actions.cancelHandoff}
          availableWidth={parent.terminalWidth}
          rows={Math.max(10,(parent.terminalHeight??24)-7)}
          tab={parent.ui.reviewTab} scroll={parent.ui.reviewScroll} action={parent.ui.reviewAction}
        />
      );
    case 'execution-handoff-review':
      return (
        <HandoffReview
          proposal={null}
          responsibleSessionId={null}
          executionHandoff={executionHandoffUnderReview(parent)}
          targetAwaitingUserPrompt
          onConfirm={parent.actions.confirmExecutionHandoff}
          onCancel={parent.actions.cancelExecutionHandoff}
          availableWidth={parent.terminalWidth}
          rows={Math.max(10,(parent.terminalHeight??24)-7)}
          tab={parent.ui.reviewTab} scroll={parent.ui.reviewScroll} action={parent.ui.reviewAction}
        />
      );
    case 'authorization-review':
      return (
        <AuthorizationReview
          review={parent.authorizationReview}
          onConfirm={parent.actions.confirmAuthorization}
          onCancel={parent.actions.cancelAuthorization}
          availableWidth={parent.terminalWidth}
          rows={Math.max(10,(parent.terminalHeight??24)-7)}
          tab={parent.ui.reviewTab} scroll={parent.ui.reviewScroll} action={parent.ui.reviewAction}
        />
      );
    case 'input-record-manager':
      return (
        <InputRecordManager
          view={parent.inputManager ?? EMPTY_INPUT_MANAGER}
          availableWidth={parent.terminalWidth}
        />
      );
  }
}

/**
 * 正在审阅的 Execution Handoff。
 *
 * 只按记录 id 从快照里取：界面不构造交接记录，也不从 Session 关系推断一个。
 */
export function executionHandoffUnderReview(props: WorkspaceProps): ControllerHandoffView | null {
  const handoffId = props.ui.executionHandoffReviewId;
  if (handoffId === null) {
    return null;
  }
  return props.viewModel.execution.handoffs.find((handoff) => handoff.handoffId === handoffId) ?? null;
}

/** Help 文本按 overlay 之外的方式显示；它只是一次性提示，不是页面。 */
export function HelpNotice(): ReactElement {
  return (
    <Box flexDirection="column">
      <Text>Help</Text>
      <Text>Ctrl+P Command Palette · Ctrl+B 项目 · Ctrl+G Graph Inspector</Text>
      <Text>Ctrl+T 展开/折叠最近一条工具记录 · Shift+← 回答 · Ctrl+A/E 行首尾</Text>
      <Text>Esc 逐层关闭 · Ctrl+C 退出（危险态先确认）· Cancel 需确认</Text>
    </Box>
  );
}
