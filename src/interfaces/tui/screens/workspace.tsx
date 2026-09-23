/**
 * 工作区主视图：顶栏 / transcript / Pending Interaction 卡片 / composer / 状态行 常驻，Sidebar 与
 * overlay 按展示态组合。
 *
 * 组件本身不订阅 stdin、不调用端口、不推进状态：它只把 view model 渲染出来，并把用户动作交给传入的
 * 回调。overlay 只渲染栈顶，`Esc` 由容器翻译成 `overlay-close-top`。
 */

import { Box, Text } from 'ink';
import type { ReactElement } from 'react';

import { CommandPalette, type CommandId } from '../components/command-palette.js';
import { Composer } from '../components/composer.js';
import { EventDrawer } from '../components/event-drawer.js';
import { GraphInspector } from '../components/graph-inspector.js';
import { HandoffReview } from '../components/handoff-review.js';
import { InteractionCard } from '../components/interaction-card.js';
import { ModelPicker } from '../components/model-picker.js';
import { SessionPicker } from '../components/session-picker.js';
import { Sidebar, SIDEBAR_COLLAPSED_MARKER } from '../components/sidebar.js';
import { StatusLine } from '../components/status-line.js';
import { TopBar } from '../components/top-bar.js';
import { Transcript } from '../components/transcript.js';
import { allowedSidebarDensity, sidebarWidthFor, truncateToDisplayWidth } from '../render/width.js';
import type { ModelCatalog } from '../ports.js';
import type { ControllerPlanningHandoffView, SemanticEvent } from '../../../application/controller-service.js';
import type { TuiViewModel } from '../../../application/tui/view-model.js';
import type { OverlayKind, TuiAction, TuiState } from '../state.js';
import { draftFor, isComposerReadOnly } from '../state.js';

export type WorkspaceActions = {
  readonly dispatch: (action: TuiAction) => void;
  readonly composerChange: (text: string) => void;
  readonly submit: () => void;
  readonly toggleTool: (entryId: string) => void;
  readonly selectSession: (coordinatorSessionId: string) => void;
  readonly enterAnswer: (interactionId: string, expectedRevision: number) => void;
  readonly runCommand: (command: CommandId) => void;
  readonly selectModel: (configurationRef: string) => void;
  readonly confirmHandoff: () => void;
  readonly cancelHandoff: () => void;
  readonly closeTopOverlay: () => void;
};

export type WorkspaceProps = {
  readonly viewModel: TuiViewModel;
  readonly ui: TuiState;
  readonly terminalWidth: number;
  readonly events: readonly SemanticEvent[];
  readonly actions: WorkspaceActions;
  readonly modelCatalog: ModelCatalog;
  readonly modelRejection: string | null;
  readonly paletteSelection: number;
  readonly modelSelection: number;
  readonly composerDisabledReason: string | null;
  readonly newlineHint: string;
  readonly handoffProposal: ControllerPlanningHandoffView | null;
  readonly commands: readonly CommandId[];
};

/**
 * 主视图可用宽度：先给 Sidebar 预算，剩下的都留给 transcript 与 composer。
 *
 * 折叠态不占列：折叠提示改为顶栏下的一行提示，否则提示文本自身会以内容宽度参与 Yoga 布局，把主视图
 * 从整宽挤到只剩一部分（真实 PTY 下实测过）。
 */
export function bodyWidth(terminalWidth: number, density: TuiState['sidebarDensity']): number {
  return Math.max(20, terminalWidth - sidebarWidthFor(density) - 2);
}

export function Workspace(props: WorkspaceProps) {
  const view = props.viewModel;
  const ui = props.ui;
  const width = bodyWidth(props.terminalWidth, ui.sidebarDensity);
  const selected = ui.selectedSessionId;
  const draft = draftFor(ui, selected);
  const readOnly = isComposerReadOnly(ui, selected);
  const interactions = view.interactions.filter(
    (interaction) => selected === null || interaction.ownerCoordinatorSessionId === selected,
  );
  const overlay = ui.overlayStack.at(-1) ?? null;

  return (
    <Box flexDirection="column">
      <TopBar
        coordinationScopeId={view.scope.coordinationScopeId}
        mode={view.scope.mode}
        controlState={view.scope.controlState}
        graphLabel={view.graph === null ? null : `${view.graph.graphId} v${String(view.graph.graphVersion)}`}
        availableWidth={props.terminalWidth}
      />
      {ui.sidebarDensity === 'collapsed' ? (
        <Text>{truncateToDisplayWidth(SIDEBAR_COLLAPSED_MARKER, props.terminalWidth)}</Text>
      ) : null}
      <Box flexDirection="row">
        <Box flexDirection="column" width={width}>
          <Transcript
            transcript={view.transcript}
            expandedToolIds={ui.expandedToolIds}
            onToggleTool={props.actions.toggleTool}
            availableWidth={width}
          />
          {interactions.map((interaction) => (
            <InteractionCard
              key={interaction.interactionId}
              interaction={interaction}
              answering={
                ui.composerMode.kind === 'answer' &&
                ui.composerMode.interactionId === interaction.interactionId
              }
              onEnterAnswer={props.actions.enterAnswer}
              availableWidth={width}
            />
          ))}
          <Composer
            value={draft}
            mode={ui.composerMode}
            readOnly={readOnly}
            disabledReason={props.composerDisabledReason}
            newlineHint={props.newlineHint}
            availableWidth={width}
          />
          <StatusLine
            scope={view.scope}
            compaction={view.compaction}
            maintenance={view.maintenance}
            blockerCount={view.blockers.length}
            notice={ui.notice}
            sidebarDensity={ui.sidebarDensity}
            availableWidth={width}
          />
        </Box>
        {ui.sidebarDensity === 'collapsed' ? null : (
          <Sidebar density={ui.sidebarDensity} viewModel={view} terminalWidth={props.terminalWidth} />
        )}
      </Box>
      {overlay === null ? null : (
        <Overlay
          overlay={overlay}
          props={props}
          narrow={allowedSidebarDensity(props.terminalWidth) === 'collapsed'}
        />
      )}
    </Box>
  );
}

function Overlay(props: {
  readonly overlay: OverlayKind;
  readonly props: WorkspaceProps;
  readonly narrow: boolean;
}): ReactElement {
  const { overlay, props: parent } = props;
  switch (overlay) {
    case 'command-palette':
      return (
        <CommandPalette
          commands={parent.commands}
          selectedIndex={parent.paletteSelection}
          onRun={parent.actions.runCommand}
          availableWidth={parent.terminalWidth}
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
        />
      );
    case 'event-drawer':
      return <EventDrawer events={parent.events} availableWidth={parent.terminalWidth} />;
    case 'model-picker':
      return (
        <ModelPicker
          catalog={parent.modelCatalog}
          rejection={parent.modelRejection}
          selectedIndex={parent.modelSelection}
          onSelect={parent.actions.selectModel}
          availableWidth={parent.terminalWidth}
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
        />
      );
  }
}

/** Help 文本按 overlay 之外的方式显示；它只是一次性提示，不是页面。 */
export function HelpNotice(): ReactElement {
  return (
    <Box flexDirection="column">
      <Text>Help</Text>
      <Text>Ctrl+P Command Palette · Ctrl+B Sidebar · Ctrl+G Graph Inspector</Text>
      <Text>Ctrl+T 展开/折叠最近一条工具记录 · Ctrl+A 进入回答模式</Text>
      <Text>Esc 逐层关闭 · Ctrl+C 退出</Text>
    </Box>
  );
}
