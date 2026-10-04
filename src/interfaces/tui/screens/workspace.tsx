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
import { HELP_LINES, COMMAND_METADATA } from '../commands.js';
import { Composer } from '../components/composer.js';
import { ContextSearch, type ContextSearchView } from '../components/context-search.js';
import { ControlBar } from '../components/control-bar.js';
import { ProjectPanel } from '../components/project-panel.js';
import { DialogFrame } from '../components/selection-list.js';
import { tuiColors } from '../theme.js';
import { GraphInspector } from '../components/graph-inspector.js';
import { GraphBasisView, type BasisViewModel } from '../components/graph-basis-view.js';
import { HandoffReview } from '../components/handoff-review.js';
import {
  InputRecordManager,
  type InputRecordManagerView,
} from '../components/input-record-manager.js';
import { AuthorizationReview } from '../components/authorization-review.js';
import { InteractionCard } from '../components/interaction-card.js';
import { ModelPicker, RoleModelMenu, modelRoleAdmission, modelRoles } from '../components/model-picker.js';
import { ModelSettingsEditor } from '../components/model-settings-editor.js';
import { SessionPicker } from '../components/session-picker.js';
import { Sidebar } from '../components/sidebar.js';
import { StatusLine } from '../components/status-line.js';
import { StatuslineSettings } from '../components/statusline-settings.js';
import { TopBar } from '../components/top-bar.js';
import { Transcript } from '../components/transcript.js';
import type { TranscriptFrame } from '../render/transcript-reader.js';
import { sidebarWidthFor, truncateToDisplayWidth } from '../render/width.js';
import type { ExecutionAuthorizationLoad, ModelCatalog, ModelRoleView } from '../ports.js';
import type {
  ControllerHandoffView,
  ControllerPlanningHandoffView,
  SemanticEvent,
} from '../../../application/controller-service.js';
import type { TuiViewModel } from '../../../application/tui/view-model.js';
import { DEFAULT_TUI_PREFERENCES, type StatuslinePreferences } from '../../../application/configuration/tui-preferences.js';
import type { ProjectDetailPage } from '../../../application/tui/project-presentation.js';
import type { OverlayKind, TuiAction, TuiState } from '../state.js';
import { composerDraftFor, composerInputFor, isComposerReadOnly, EMPTY_MODEL_SETTINGS_EDIT, type ModelSettingsEdit } from '../state.js';
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
  /** 进入某个角色的候选菜单；不可用时由容器显示宿主给出的原因。 */
  readonly openModelRole: () => void;
  /** 保存当前内存编辑；只追加不可变记录，不代表应用。 */
  readonly saveModelSettings: () => void;
  /** 提交候选菜单的当前动作：0 返回，1 应用选择。 */
  readonly submitModelRole: (action: number) => void;
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
  readonly historyContext?: ContextSearchView | null;
  readonly historyPreview?: UiDraft | null;
  readonly events: readonly SemanticEvent[];
  readonly actions: WorkspaceActions;
  readonly modelCatalog: ModelCatalog;
  readonly modelRejection: string | null;
  /** 角色模型配置端口是否已装配；未装配时编辑入口显示为不可用。缺省即未装配。 */
  readonly modelSettingsAvailable?: boolean;
  readonly preferencesAvailable?: boolean;
  readonly statuslineDraft?: StatuslinePreferences;
  readonly savedStatusline?: StatuslinePreferences;
  readonly statuslineSelection?: number;
  readonly statuslineNotice?: string | null;
  readonly projectDetailsPage?: ProjectDetailPage | null;
  readonly projectDetailsKey?: string | null;
  readonly projectDetailsNotice?: string | null;
  /** 依据下钻的只读投影；`undefined` 表示宿主未装配该端口。 */
  readonly basisView?: BasisViewModel;
  /** 图依据读取端口是否已装配；缺省即未装配，界面据此隐藏无入口的提示。 */
  readonly graphBasisAvailable?: boolean;
  /** 正在查看的角色；由容器按当前 overlay 解析，组件不自己挑。 */
  readonly modelRole?: ModelRoleView | null;
  readonly paletteSelection: number;
  readonly composerDisabledReason: string | null;
  readonly newlineHint: string;
  readonly executionReview?: ControllerHandoffView | null;
  readonly handoffProposal: ControllerPlanningHandoffView | null;
  readonly authorizationReview: ExecutionAuthorizationLoad | null;
  readonly commands: readonly CommandId[];
  /** 输入记录管理的当前投影；`null` 表示 overlay 未打开。 */
  readonly inputManager?: InputRecordManagerView | null;
  readonly answerPanel?: AnswerPanelView | null;
  readonly pasteViewer?: PasteViewerView | null;
  /** 模型弹窗沿用定稿的身份摘要：项目 / 分支 / Session。 */
  readonly modelIdentity?: string;
  /** 编辑器当前内存字段；`null` 表示 overlay 未打开。 */
  readonly modelSettingsEdit?: ModelSettingsEdit | null;
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

/** 角色目录尚未装载时的占位角色：明确不可用，而不是显示空白候选。 */
const UNKNOWN_MODEL_ROLE: ModelRoleView = {
  role: 'coordinator',
  label: 'Coordinator',
  group: 'current',
  current: null,
  candidates: [],
  availability: { available: false, reason: '角色模型目录尚未装载' },
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
  const selected=ui.selectedSessionId,input=props.historyPreview??composerInputFor(ui,selected),readOnly=isComposerReadOnly(ui,selected);
  const overlay=ui.overlayStack.at(-1)??null;
  const focus=overlay===null&&ui.pendingConfirmation===null&&!ui.projectPanel.open&&!props.historyContext;
  const interactions=view.interactions.filter(i=>i.state==='open'&&i.ownerCoordinatorSessionId===selected);
  const candidates=ui.slashDismissed?[]:slashCandidates(input.text,view.scope.mode);
  const candidateRows=Math.min(candidates.length,Math.min(3,Math.max(1,rows-21)))+4;
  const reasons=Object.fromEntries(props.commands.flatMap(c=>{const reason=commandReason(c,{mode:view.scope.mode,selectedSessionId:selected,pasteBlocks:input.pasteBlocks.length,...(props.modelSettingsAvailable===true?{modelSettings:true}:{}),...(props.preferencesAvailable===true?{preferences:true}:{})});return reason?[[c,reason]]:[];}));
  const origin={x:rowMetrics.left+bodyMetrics.left,y:rowMetrics.top+bodyMetrics.top};
  const panel=props.answerPanel;
  const modelRef=view.sessions.find(s=>s.coordinatorSessionId===selected)?.coordinatorModelConfigurationRef;
  const model=props.modelCatalog.options.find(o=>o.configurationRef===modelRef)?.model??null;
  const project=ui.basis!==null&&props.basisView!==undefined
    ? <GraphBasisView view={props.basisView} width={projectWidth} rows={bodyRows} iconMode={ui.iconMode} available={props.graphBasisAvailable!==false}/>
    : <ProjectPanel view={view} events={props.events} panel={ui.projectPanel} width={projectWidth} height={bodyRows}
    {...(props.projectDetailsPage===undefined?{}:{details:props.projectDetailsPage})}
    {...(props.projectDetailsKey===undefined?{}:{detailObjectKey:props.projectDetailsKey})}
    {...(props.projectDetailsNotice===undefined?{}:{detailNotice:props.projectDetailsNotice})}/>;
  if(overlay==='paste-viewer'&&props.pasteViewer) return <PasteViewer view={props.pasteViewer} width={props.terminalWidth} rows={rows}/>;
  return <Box flexDirection="column" height={rows-1} overflow="hidden">
    <TopBar coordinationScopeId={view.scope.coordinationScopeId} mode={view.scope.mode} controlState={view.scope.controlState}
      graphLabel={null} generation={view.graph?.generation??null} authorizationLabel={null} activeWorkPackageCount={view.execution.activeWorkPackageCount}
      reconciling={view.execution.reconciliation.pending} availableWidth={props.terminalWidth} sessionId={selected}
      holder={view.scope.executionLeaseHolderSessionId} pendingCount={view.execution.hazards.openInteractionCount} {...(view.projectPresentation===undefined?{}:{presentation:view.projectPresentation})}/>
    {alerts.slice(0,2).map((s,i)=><Text key={i} color={tuiColors.warning}>{truncateToDisplayWidth('! '+s+(i===1&&alerts.length>2?' · 另有 '+(alerts.length-2)+' 项':''),props.terminalWidth)}</Text>)}
    {ui.pendingConfirmation!==null?<Box height={bodyRows} width={props.terminalWidth} justifyContent="center" flexDirection="column"><ControlBar controlState={view.scope.controlState} hazards={view.execution.hazards} pending={ui.pendingConfirmation} availableWidth={props.terminalWidth}
      rows={Math.max(10,rows-7)} tab={ui.reviewTab} scroll={ui.reviewScroll} action={ui.reviewAction}
      scopeId={view.scope.coordinationScopeId} sessionCount={view.sessions.length}
      onConfirm={props.actions.confirmPending} onDismiss={props.actions.dismissPending}/></Box>:
    overlay!==null?<Box height={bodyRows} width={props.terminalWidth} justifyContent="center" flexDirection="column"><Overlay overlay={overlay} props={props} narrow={props.terminalWidth<100}/></Box>:
    ui.projectPanel.open&&props.terminalWidth<100?project:
    <Box ref={rowRef} flexDirection="row" height={bodyRows} flexShrink={0}>
      <Box ref={bodyRef} flexDirection="column" width={width} height={bodyRows}>
        <Box ref={transcriptRef} flexDirection="column" flexGrow={1} flexBasis={0} minHeight={1} overflow="hidden">
          <Transcript transcript={view.transcript} {...(props.transcriptFrame === undefined ? {} : { frame: props.transcriptFrame })} expandedToolIds={ui.expandedToolIds} onToggleTool={props.actions.toggleTool} availableWidth={width}
            maxLines={transcriptMetrics.hasMeasured?Math.max(1,Math.round(transcriptMetrics.height)):Math.max(1,bodyRows-12)}/>
        </Box>
        {candidates.length&&focus?<CommandPalette commands={candidates} selectedIndex={Math.min(ui.slashIndex,candidates.length-1)} onRun={props.actions.runCommand}
          availableWidth={width} maxRows={Math.min(3,Math.max(1,rows-21))} reasons={reasons} slash/>:null}
        {props.historyContext?<ContextSearch view={props.historyContext} width={width} origin={origin}/>:null}
        {panel?<AnswerPanel view={panel} draft={input} width={width} rows={bodyRows-1-(candidates.length&&focus?candidateRows:0)} origin={origin} focused={focus} readOnly={readOnly} disabledReason={props.composerDisabledReason}/>:
        <><>{interactions.slice(0,1).map(i=><InteractionCard key={i.interactionId} interaction={i} answering={false} onEnterAnswer={props.actions.enterAnswer} availableWidth={width}/>)}</>
        <Composer value={composerDraftFor(ui,selected)} draft={input} terminalHeight={rows} focused={focus} externalCursor={!!props.historyContext} origin={origin} mode={ui.composerMode} readOnly={readOnly}
          disabledReason={props.composerDisabledReason} newlineHint={props.newlineHint} availableWidth={width}/></>}
        <StatusLine scope={view.scope} compaction={view.compaction} maintenance={view.maintenance} blockerCount={view.blockers.length} notice={ui.notice}
          sidebarDensity={ui.sidebarDensity} execution={view.execution} availableWidth={width} model={model} graph={view.graph} {...(view.projectPresentation===undefined?{}:{presentation:view.projectPresentation})} {...(props.savedStatusline===undefined?{}:{preferences:props.savedStatusline})}/>
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
          query={parent.ui.dialogSelections['command-palette']?.query.text??''}
          onRun={parent.actions.runCommand}
          availableWidth={parent.terminalWidth}
          summary={`${parent.ui.selectedSessionId??'未选择会话'} · ${parent.viewModel.scope.mode==='route_planning'?'规划':'执行'}`}
          maxRows={Math.max(1,(parent.terminalHeight??24)-15)}
          reasons={Object.fromEntries(parent.commands.flatMap(command=>{const reason=commandReason(command,{mode:parent.viewModel.scope.mode,selectedSessionId:parent.ui.selectedSessionId,pasteBlocks:composerInputFor(parent.ui,parent.ui.selectedSessionId).pasteBlocks.length,...(parent.modelSettingsAvailable===true?{modelSettings:true}:{})});return reason?[[command,reason]]:[];}))}
        />
      );
    case 'graph-inspector':
      if (parent.ui.basis !== null && parent.basisView !== undefined) {
        // 行数必须等于这一帧真正拿到的正文高度：容器是居中布局，超出的部分会从上下两端被裁掉。
        const layout = workspaceLayout(parent.viewModel, parent.ui, parent.terminalWidth, parent.terminalHeight ?? 24);
        return (
          <GraphBasisView
            view={parent.basisView}
            width={parent.terminalWidth}
            rows={Math.max(8, layout.bodyRows)}
            iconMode={parent.ui.iconMode}
            available={parent.graphBasisAvailable !== false}
          />
        );
      }
      return (
        <GraphInspector
          graph={parent.viewModel.graph}
          selectedWorkPackageId={parent.ui.inspectorSelection}
          onSelect={(workPackageId) =>
            parent.actions.dispatch({ kind: 'inspector-selected', workPackageId })
          }
          narrow={props.narrow}
          view={parent.viewModel} rows={Math.max(12,(parent.terminalHeight??24)-2)} detail={parent.ui.inspectorDetail} tab={parent.ui.inspectorTab} scroll={parent.ui.inspectorScroll} relations={parent.ui.inspectorRelations} relationIndex={parent.ui.relationIndex} iconMode={parent.ui.iconMode}
          basisEntry={parent.graphBasisAvailable !== false}
          availableWidth={parent.terminalWidth}
        />
      );
    case 'session-picker':
      return (
        <SessionPicker
          sessions={parent.viewModel.sessions}
          selectedSessionId={parent.ui.selectedSessionId}
          {...(parent.ui.dialogSelections['session-picker']?{selection:parent.ui.dialogSelections['session-picker']}:{})}
          onSelect={parent.actions.selectSession}
          availableWidth={parent.terminalWidth}
          rows={Math.max(10,(parent.terminalHeight??24)-7)}
        />
      );
    case 'handoff-target':
      return <SessionPicker title="选择交接收件方" sessions={parent.viewModel.sessions.filter(s=>s.coordinatorSessionId !== (parent.viewModel.scope.mode==='route_planning'?parent.viewModel.sessions.find(s=>s.planningResponsible)?.coordinatorSessionId:parent.viewModel.scope.executionLeaseHolderSessionId))} selectedSessionId={null}
        {...(parent.ui.dialogSelections['handoff-target']?{selection:parent.ui.dialogSelections['handoff-target']}:{})}
        onSelect={id=>parent.actions.selectRecipient?.(id)} availableWidth={parent.terminalWidth} rows={Math.max(10,(parent.terminalHeight??24)-7)}/>;
    case 'event-drawer':
      return <ProjectPanel view={parent.viewModel} events={parent.events} panel={{...parent.ui.projectPanel,tab:2}} width={parent.terminalWidth} height={Math.max(8,(parent.terminalHeight??24)-4)}/>;
    case 'options':
      return <CommandPalette commands={parent.commands.filter(id=>COMMAND_METADATA[id].path.startsWith('选项 →'))} selectedIndex={parent.paletteSelection} query={parent.ui.dialogSelections.options?.query.text??''} onRun={parent.actions.runCommand} availableWidth={parent.terminalWidth} maxRows={Math.max(1,(parent.terminalHeight??24)-11)} summary={`选项${parent.ui.iconModeUnsaved?' · 图标未保存':''} · 当前图标 ${parent.ui.iconMode}`} reasons={{...(parent.preferencesAvailable?{}:{statusline:'用户偏好端口不可用；只能使用默认显示设置'})}}/>;
    case 'statusline-settings': {
      const view=parent.viewModel,ui=parent.ui;
      const mainWidth=bodyWidth(parent.terminalWidth,ui.sidebarDensity);
      const modelRef=view.sessions.find(s=>s.coordinatorSessionId===ui.selectedSessionId)?.coordinatorModelConfigurationRef;
      const model=parent.modelCatalog.options.find(o=>o.configurationRef===modelRef)?.model??null;
      return <StatuslineSettings preferences={parent.statuslineDraft??DEFAULT_TUI_PREFERENCES.statusline} selected={parent.statuslineSelection??0} notice={parent.statuslineNotice??null} width={parent.terminalWidth} rows={parent.terminalHeight??24} summary={`${view.projectPresentation?.identity.repository??'仓库不可用'} · ${view.projectPresentation?.identity.fullBranchRef??'分支不可用'} · ${ui.selectedSessionId??'未选择会话'}`} statusLineProps={{scope:view.scope,compaction:view.compaction,maintenance:view.maintenance,blockerCount:view.blockers.length,notice:null,sidebarDensity:ui.sidebarDensity,availableWidth:mainWidth,execution:view.execution,model,graph:view.graph,...(view.projectPresentation===undefined?{}:{presentation:view.projectPresentation})}}/>;
    }
    case 'help':
      return <DialogFrame title="Help · 命令与键位" summary="Scope / Session / UI" width={parent.terminalWidth} rows={Math.max(10,(parent.terminalHeight??24)-7)} footer="↑↓ 浏览 · Esc 返回"><Box flexDirection="column" overflow="hidden">{[...HELP_LINES,...parent.commands.map(id=>{const meta=COMMAND_METADATA[id];return `${meta.alias?'/'+meta.alias:meta.label} · ${meta.target} · ${meta.description}`;})].slice(parent.ui.reviewScroll,parent.ui.reviewScroll+Math.max(1,(parent.terminalHeight??24)-14)).map((line,i)=><Text key={i}>{truncateToDisplayWidth(line,Math.max(1,parent.terminalWidth-8))}</Text>)}</Box></DialogFrame>;
    case 'model-picker':
      return (
        <ModelPicker
          catalog={parent.modelCatalog}
          rejection={parent.modelRejection}
          notice={parent.ui.modelSettingsNotice}
          onOpenRole={parent.actions.openModelRole}
          availableWidth={parent.terminalWidth}
          roleIndex={parent.ui.modelRoleIndex}
          {...(parent.modelIdentity===undefined?{}:{identity:parent.modelIdentity})}
          rows={Math.max(10,(parent.terminalHeight??24)-7)}
        />
      );
    case 'model-role-menu':
      return (
        <RoleModelMenu
          role={parent.modelRole ?? modelRoles(parent.modelCatalog)[0] ?? UNKNOWN_MODEL_ROLE}
          menu={parent.ui.modelRoleMenu ?? { role: 'coordinator', selectedCandidateRef: null, focus: 'list', action: 0, effort: null }}
          query={parent.ui.dialogSelections['model-role-menu']?.query.text??''}
          admissionReason={parent.modelRole===null||parent.modelRole===undefined?null:modelRoleAdmission(parent.modelRole,parent.modelCatalog).reason}
          notice={parent.ui.modelSettingsNotice}
          onAction={parent.actions.submitModelRole}
          availableWidth={parent.terminalWidth}
          {...(parent.modelIdentity===undefined?{}:{identity:parent.modelIdentity})}
          rows={Math.max(10,(parent.terminalHeight??24)-7)}
        />
      );
    case 'model-settings-editor':
      return (
        <ModelSettingsEditor
          edit={parent.modelSettingsEdit ?? EMPTY_MODEL_SETTINGS_EDIT}
          field={parent.ui.modelSettingsField}
          notice={parent.ui.modelSettingsNotice}
          failing={parent.ui.modelSettingsNotice!==null&&parent.ui.modelSettingsNotice.startsWith('!')}
          availableWidth={parent.terminalWidth}
          {...(parent.modelIdentity===undefined?{}:{identity:parent.modelIdentity})}
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
          executionHandoff={parent.executionReview??executionHandoffUnderReview(parent)}
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
      {HELP_LINES.map(line=><Text key={line}>{line}</Text>)}
    </Box>
  );
}
