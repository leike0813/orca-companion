import { textDraft } from '../../src/interfaces/tui/input/composer-editor.js';
/**
 * 常驻 transcript 与 composer 主视图（IP-05，Owner: `m2-deliver-planning-tui`）。
 *
 * 断言的是用户可观察事实：窄屏下主视图不折叠、工具细节默认不渲染、普通字符只进草稿、`Esc` 只弹出栈顶、
 * 语义事件只进抽屉而不改写 transcript。窄屏不能走 `renderTui`（ink-testing-library 的 mock stdout 固定
 * 100 列），因此直接渲染 `Workspace` 并显式传入 `terminalWidth`；密度由 `allowedSidebarDensity` 与
 * reducer 推导，与真实 resize 路径一致。
 */

import { describe, expect, test } from 'vitest';
import { openCheckpointStore } from '../../src/adapters/storage/checkpoint-store.js';
import { readTranscriptPage } from '../../src/application/coordinator/history.js';
import type { CoordinatorSessionId } from '../../src/application/dto/identity.js';
import type { TranscriptLoad } from '../../src/interfaces/tui/ports.js';

test('分页阅读、最早/最新与 Esc 保留 composer，失败保留原画面', async () => {
  const opened = openCheckpointStore({ databasePath: ':memory:' });
  if (opened.kind !== 'opened') throw new Error(opened.message);
  const history = opened.store, session = 'session-b' as CoordinatorSessionId;
  history.saveCheckpoint({ schemaVersion: 2, coordinatorSessionId: session, graphPosition: 'suspend',
    committedMessages: [], committedModelSteps: [], wakeBatches: [], lastCompactionOutcome: null });
  for (let index = 0; index < 320; index += 1) history.appendMessage(session, {
    entryId: `row-${index}`, stepId: `row-${index}`, role: 'assistant', content: `历史条目 ${index}` });
  const fake = createFakePorts();
  let fail = false;
  const ports = { ...fake.ports, transcript: (id: string, cursor: string | null): Promise<TranscriptLoad> =>
    Promise.resolve(fail ? { kind: 'failed', code: 'offline', message: '离线' }
      : { kind: 'transcript', transcript: readTranscriptPage(history, id, cursor) }) };
  const rendered = renderTui(ports);
  try {
    await settle();
    rendered.stdin.write('首尾'); await settle(2);
    rendered.stdin.write('\u001b[D'); await settle(2);
    rendered.stdin.write('\u001b[1;5H'); await settle();
    expect(rendered.lastFrame()).toContain('历史条目 0');
    expect(rendered.lastFrame()).toContain('首尾');
    fake.emit({ kind: 'state-changed', coordinationScopeId: 'scope-1', revision: 8, reason: 'updated',
      eventId: 'history-update', coordinatorSessionId: 'session-b' });
    await settle();
    expect(rendered.lastFrame()).toContain('历史条目 0');
    expect(rendered.lastFrame()).toContain('会话有更新');
    for (let index = 0; index < 30 && !rendered.lastFrame()?.includes('历史条目 100'); index += 1) {
      rendered.stdin.write('\u001b[6~'); await settle(2);
    }
    expect(rendered.lastFrame()).toContain('历史条目 100');
    rendered.stdin.write('\u001b[1;5H'); await settle();
    fail = true;
    rendered.stdin.write('\u001b[1;5F'); await settle();
    expect(rendered.lastFrame()).toContain('历史条目 0');
    expect(rendered.lastFrame()).toContain('离线');
    fail = false;
    rendered.stdin.write('\u001b'); await new Promise(resolve => setTimeout(resolve, 100)); await settle();
    expect(rendered.lastFrame()).toContain('历史条目 319');
    rendered.stdin.write('中'); await settle();
    expect(rendered.lastFrame()).toContain('首中尾');
    expect(fake.executeIntents).toHaveLength(0);
  } finally { rendered.unmount(); fake.closeInputStore(); history.close(); }
});

test.each(['最新请求', '切换 Session'])('分页响应迟到时不覆盖%s', async (action) => {
  const fake = createFakePorts();
  let finish: ((value: TranscriptLoad) => void) | undefined;
  const ports = { ...fake.ports, transcript: (id: string, cursor: string | null): Promise<TranscriptLoad> =>
    cursor === 'oldest' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ kind: 'transcript',
      transcript: { coordinatorSessionId: id, messages: [{ role: 'assistant', content: `最新记录 ${id}`, stepId: 'latest' }], nextCursor: 'earlier' } }) };
  const rendered = renderTui(ports);
  try {
    await settle();
    rendered.stdin.write('\u001b[1;5H'); await settle();
    if (action === '切换 Session') {
      rendered.stdin.write('\u0010'); await settle(2);
      for (let index = 0; index < COMMAND_IDS.indexOf('session-picker'); index += 1) {
        rendered.stdin.write('\u001b[B'); await settle(2);
      }
      rendered.stdin.write('\r'); await settle();
      rendered.stdin.write('\u001b[A'); await settle(2);
      rendered.stdin.write('\r'); await settle();
    } else {
      rendered.stdin.write('\u001b[1;5F'); await settle();
    }
    finish?.({ kind: 'transcript', transcript: { coordinatorSessionId: 'session-b',
      messages: [{ role: 'assistant', content: '迟到旧记录', stepId: 'old' }], nextCursor: null } });
    await settle();
    expect(rendered.lastFrame()).toContain(`最新记录 ${action === '切换 Session' ? 'session-a' : 'session-b'}`);
    expect(rendered.lastFrame()).not.toContain('迟到旧记录');
  } finally { rendered.unmount(); fake.closeInputStore(); }
});

import { toSemanticEvent, type SemanticEvent } from '../../src/application/controller-service.js';
import {
  projectTranscriptPage,
  projectTuiViewModel,
  type TranscriptEntry,
  type TuiViewModel,
} from '../../src/application/tui/view-model.js';
import { handleComposerKey } from '../../src/interfaces/tui/app.js';
import type { AnswerPanelView } from '../../src/interfaces/tui/components/answer-panel.js';
import { COMMAND_IDS } from '../../src/interfaces/tui/components/command-palette.js';
import { TOOL_COLLAPSED_MARKER, TOOL_EXPANDED_MARKER } from '../../src/interfaces/tui/components/transcript.js';
import { TopBar } from '../../src/interfaces/tui/components/top-bar.js';
import { resolveGlobalAction } from '../../src/interfaces/tui/input/keymap.js';
import type { ModelCatalog } from '../../src/interfaces/tui/ports.js';
import { allowedSidebarDensity } from '../../src/interfaces/tui/render/width.js';
import { Workspace, type WorkspaceActions } from '../../src/interfaces/tui/screens/workspace.js';
import { answerDraftKey, draftFor, initialTuiState, reduceTuiState, type TuiState } from '../../src/interfaces/tui/state.js';
import {
  createFakePorts,
  makeSnapshot,
  makeTranscript,
  renderComponent,
  renderTui,
  settle,
  type RenderedTui,
  type SnapshotOverrides,
} from './harness.js';

const MODEL_CATALOG: ModelCatalog = {
  options: [{ configurationRef: 'config-a', model: 'model-a' }],
  currentConfigurationRef: 'config-a',
  switchable: true,
  switchBlockReason: null,
};

const NOOP_ACTIONS: WorkspaceActions = {
  dispatch: () => undefined,
  composerChange: () => undefined,
  submit: () => undefined,
  toggleTool: () => undefined,
  selectSession: () => undefined,
  enterAnswer: () => undefined,
  runCommand: () => undefined,
  selectModel: () => undefined,
  confirmHandoff: () => undefined,
  cancelHandoff: () => undefined,
  confirmExecutionHandoff: () => undefined,
  cancelExecutionHandoff: () => undefined,
  confirmAuthorization: () => undefined,
  cancelAuthorization: () => undefined,
  closeTopOverlay: () => undefined,
  confirmPending: () => undefined,
  dismissPending: () => undefined,
};

function uiState(overrides: Partial<TuiState> = {}): TuiState {
  return { ...initialTuiState, screen: 'workspace', selectedSessionId: 'session-a', ...overrides };
}

function workspaceView(snapshot: SnapshotOverrides = {}, selectedSessionId: string | null = 'session-a'): TuiViewModel {
  return projectTuiViewModel({
    snapshot: makeSnapshot(snapshot),
    transcript: projectTranscriptPage(makeTranscript(selectedSessionId ?? 'session-a'), {
      coordinatorSessionId: selectedSessionId,
    }),
    selectedSessionId,
    unreadSessionIds: [],
  });
}

function renderWorkspace(
  options: {
    readonly terminalWidth?: number;
    readonly terminalHeight?: number;
    readonly transcriptEntries?: readonly TranscriptEntry[];
    readonly ui?: TuiState;
    readonly snapshot?: SnapshotOverrides;
    readonly events?: readonly SemanticEvent[];
    readonly answerPanel?: AnswerPanelView;
    readonly disabledReason?: string;
  } = {},
): RenderedTui {
  const ui = options.ui ?? uiState();
  const view = workspaceView(options.snapshot ?? {}, ui.selectedSessionId);
  return renderComponent(
    <Workspace
      viewModel={options.transcriptEntries === undefined ? view : {
        ...view,
        transcript: { ...view.transcript, entries: options.transcriptEntries },
      }}
      ui={ui}
      terminalWidth={options.terminalWidth ?? 100}
      terminalHeight={options.terminalHeight ?? 60}
      events={options.events ?? []}
      actions={NOOP_ACTIONS}
      modelCatalog={MODEL_CATALOG}
      modelRejection={null}
      paletteSelection={0}
      composerDisabledReason={options.disabledReason ?? null}
      answerPanel={options.answerPanel ?? null}
      newlineHint="Shift+Enter 换行"
      handoffProposal={null}
      authorizationReview={null}
      commands={COMMAND_IDS}
    />,
  );
}

describe('planning-workspace / 常驻 transcript 与 composer 主视图', () => {
  test.each([[80, 24], [50, 40]])('长问题、选项和答案在 %ix%i 保留时间线与不可提交原因', async (terminalWidth, terminalHeight) => {
    const header = renderComponent(<TopBar coordinationScopeId="scope-a" mode="execution_coordination"
      controlState="blocked" graphLabel={null} generation={null} authorizationLabel={null}
      activeWorkPackageCount={0} reconciling availableWidth={terminalWidth}
      sessionId="session-long-中文规划-2026" pendingCount={3} holder="another-session-with-long-identity" />);
    expect(header.lastFrame()).toContain('待答3');
    header.unmount();
    const interaction = { interactionId: 'i-large', ownerCoordinatorSessionId: 'session-a',
      subjectRef: { kind: 'coordinator-session' as const, id: 'session-a' }, expectedRevision: 7, state: 'open' as const,
      question: { text: '需要保留的中文问题。'.repeat(30), options: Array.from({ length: 8 }, (_, index) => ({ label: `选项 ${String(index)}` })) } };
    let ui = uiState({ sidebarDensity: allowedSidebarDensity(terminalWidth) });
    ui = reduceTuiState(ui, { kind: 'answer-mode-entered', interactionId: interaction.interactionId, expectedRevision: 7 });
    ui = reduceTuiState(ui, { kind: 'answer-draft-changed', answerKey: answerDraftKey('session-a', interaction.interactionId, 7),
      draft: textDraft(Array.from({ length: 10 }, (_, index) => `答案 ${String(index)}`).join('\n')) });
    const rendered = renderWorkspace({ terminalWidth, terminalHeight, ui, disabledReason: 'context_exhausted',
      answerPanel: { interaction, index: 0, count: 1, option: 3, focus: 'text', scroll: 0 } });
    await settle(4);
    const frame = rendered.lastFrame() ?? '';
    expect(frame).toContain('search');
    expect(frame).toContain('答案 9');
    expect(frame).toContain('context_exhausted');
    expect(frame.split('\n').length).toBeLessThanOrEqual(terminalHeight);
    rendered.unmount();
  });

  test('长会话保留最新消息与固定状态区域', async () => {
    const transcriptEntries: TranscriptEntry[] = Array.from({ length: 40 }, (_, index) => ({
      kind: 'agent', id: `message-${String(index)}`, text: `消息 ${String(index)}`,
    }));
    const rendered = renderWorkspace({ terminalHeight: 24, transcriptEntries });
    await settle(2);
    const frame = rendered.lastFrame() ?? '';
    expect(frame).toContain('消息 39');
    expect(frame).not.toContain('消息 0');
    expect(frame).toContain('普通消息');
    expect(frame).toContain('上下文 不可用');
  });

  test('Scenario: 窄屏下主视图保持可见', async () => {
    // 任何宽度下 transcript 与 composer 都常驻；宽度只决定 Sidebar 密度。
    for (const width of [40, 70, 120]) {
      const density = reduceTuiState(uiState(), {
        kind: 'sidebar-resized',
        allowed: allowedSidebarDensity(width),
      });
      const rendered = renderWorkspace({ terminalWidth: width, ui: density });
      await settle(2);
      const frame = rendered.lastFrame() ?? '';
      expect(frame).toContain('先看看地图'); // transcript 常驻
      expect(frame).toContain('好的');
      expect(frame).toContain('普通消息'); // composer 常驻
    }

    const terminalWidth = 40;
    expect(allowedSidebarDensity(terminalWidth)).toBe('collapsed');

    // 与容器 resize 路径一致：宽度只收紧密度上限，不切换走 transcript 或 composer。
    let ui = reduceTuiState(uiState(), {
      kind: 'sidebar-resized',
      allowed: allowedSidebarDensity(terminalWidth),
    });
    expect(ui.sidebarDensity).toBe('collapsed');

    // 窄屏下继续输入：普通字符经 composer 输入路径进入当前 Session 草稿。
    handleComposerKey('窄屏草稿', {}, {
      readOnly: false,
      draft: textDraft(draftFor(ui, 'session-a')),
      change: (draft) => {
        ui = reduceTuiState(ui, { kind: 'draft-changed', coordinatorSessionId: 'session-a', draft });
      },
      submit: () => undefined,
    });
    expect(draftFor(ui, 'session-a')).toBe('窄屏草稿');

    const rendered = renderWorkspace({ terminalWidth, ui });
    await settle(2);
    const frame = rendered.lastFrame() ?? '';

    expect(frame).not.toContain('执行图侧栏'); // Sidebar 折叠，主视图不被挤压
    expect(frame).not.toContain('wp-1'); // 折叠态不渲染不可见详情
    expect(frame).toContain('先看看地图');
    expect(frame).toContain('普通消息');
    expect(frame).toContain('窄屏草稿'); // 窄屏下草稿仍完整可见
  });

  test('Scenario: 工具调用默认折叠', async () => {
    const collapsed = renderWorkspace();
    await settle(2);
    const collapsedFrame = collapsed.lastFrame() ?? '';

    expect(collapsedFrame).toContain(TOOL_COLLAPSED_MARKER);
    expect(collapsedFrame).toContain('tool search'); // 折叠记录本身可见
    expect(collapsedFrame).not.toContain('命中 3 个文件'); // 细节不渲染

    // 展开由 reducer 的 expandedToolIds 驱动。
    const expandedUi = reduceTuiState(uiState(), { kind: 'tool-toggled', entryId: 'step-2' });
    expect(expandedUi.expandedToolIds).toContain('step-2');

    const expanded = renderWorkspace({ ui: expandedUi });
    await settle(2);
    const expandedFrame = expanded.lastFrame() ?? '';
    expect(expandedFrame).toContain(TOOL_EXPANDED_MARKER);
    expect(expandedFrame).toContain('命中 3 个文件');

    // 再切换一次回到折叠，展开集合不残留。
    const recollapsed = reduceTuiState(expandedUi, { kind: 'tool-toggled', entryId: 'step-2' });
    expect(recollapsed.expandedToolIds).toEqual([]);
  });

  test('Scenario: composer 聚焦时普通字符不触发全局命令', async () => {
    // 固定映射表不认识普通字符：调用方只能把输入交给 composer。
    for (const character of ['p', 'b', 'g', 'c', '/', '中']) {
      expect(resolveGlobalAction(character, {})).toBeNull();
    }
    expect(resolveGlobalAction('p', { ctrl: true })).toBe('command-palette');
    expect(resolveGlobalAction('x', { ctrl: true })).toBeNull();

    // 字符进入草稿，且不产生 overlay。
    let ui = uiState({ drafts: { 'session-a': textDraft('已经输入') } });
    const submitted: string[] = [];
    handleComposerKey('p', {}, {
      readOnly: false,
      draft: textDraft(draftFor(ui, 'session-a')),
      change: (draft) => {
        ui = reduceTuiState(ui, { kind: 'draft-changed', coordinatorSessionId: 'session-a', draft });
      },
      submit: () => {
        submitted.push(draftFor(ui, 'session-a'));
      },
    });
    expect(draftFor(ui, 'session-a')).toBe('已经输入p');
    expect(ui.overlayStack).toEqual([]);
    expect(submitted).toEqual([]);

    const rendered = renderWorkspace({ ui });
    await settle(2);
    expect(rendered.lastFrame() ?? '').toContain('已经输入p');

    // 容器级：真实输入路径下普通字符让 placeholder 让位，且没有打开任何 overlay。
    const fake = createFakePorts();
    const app = renderTui(fake.ports);
    await settle(12);
    expect(app.lastFrame() ?? '').toContain('输入消息…');

    app.stdin.write('p');
    await settle(2);
    const frame = app.lastFrame() ?? '';
    expect(frame).not.toContain('输入消息…');
    expect(frame).not.toContain('Command Palette');
    expect(fake.executeCount()).toBe(0);
  });

  test('Scenario: Esc 逐层关闭', async () => {
    let ui = uiState();
    ui = reduceTuiState(ui, { kind: 'overlay-open', overlay: 'session-picker' });
    ui = reduceTuiState(ui, { kind: 'overlay-open', overlay: 'event-drawer' });
    expect(ui.overlayStack).toEqual(['session-picker', 'event-drawer']);

    // 只有栈顶 overlay 渲染。
    const stacked = renderWorkspace({ ui });
    await settle(2);
    const stackedFrame = stacked.lastFrame() ?? '';
    expect(stackedFrame).toContain('最近事件');
    expect(stackedFrame).not.toContain('Session Picker');

    const closed = reduceTuiState(ui, { kind: 'overlay-close-top' });
    expect(closed.overlayStack).toEqual(['session-picker']);
    // 除 overlay 栈外，界面状态逐一保持。
    expect({ ...closed, overlayStack: ui.overlayStack }).toEqual(ui);

    const restored = renderWorkspace({ ui: closed });
    await settle(2);
    expect(restored.lastFrame() ?? '').toContain('Session Picker');
  });
});

describe('planning-workspace / 信息分层', () => {
  test('Scenario: 维护噪声不进入用户时间线', async () => {
    // 噪声在 façade 就被丢弃，界面语义事件流里根本没有它们。
    expect(
      toSemanticEvent({
        envelope: { eventId: 'noise-1', coordinatorSessionId: null },
        notification: { kind: 'keepalive', at: 1 },
      }),
    ).toBeNull();
    expect(
      toSemanticEvent({
        envelope: { eventId: 'noise-2', coordinatorSessionId: null },
        notification: { kind: 'unchanged-reconciliation', at: 2 },
      }),
    ).toBeNull();

    const ui = uiState({ projectPanel: {...initialTuiState.projectPanel,open:true,tab:2} });
    const rendered = renderWorkspace({ ui, events: [] });
    await settle(2);
    const frame = rendered.lastFrame() ?? '';

    expect(frame).toContain('暂无语义事件');
    expect(frame).not.toContain('keepalive');
    // transcript 仍只显示用户/Agent 消息与折叠工具记录。
    for (const line of ['先看看地图', '好的', 'tool search']) {
      expect(frame).toContain(line);
    }
    expect(frame).not.toContain('内部注入');
  });

  test('Scenario: 语义事件进入 Event Drawer', async () => {
    // 「Worker Task 完成验证并被接受」由语义事件层的 state-changed reason 承载。
    const verified: SemanticEvent = {
      eventId: 'event-verified',
      coordinatorSessionId: 'session-a',
      kind: 'state-changed',
      coordinationScopeId: 'scope-1',
      revision: 9,
      reason: 'worker-task-verified-accepted',
    };
    const ui = uiState({ projectPanel: {...initialTuiState.projectPanel,open:true,tab:2,detail:'event:event-verified'} });

    const withEvent = renderWorkspace({ ui, events: [verified] });
    await settle(2);
    const frame = withEvent.lastFrame() ?? '';
    expect(frame.replace(/\s|│/g,'')).toContain('worker-task-verified-accepted');
    // 事件只在抽屉里，位于常驻主视图之后；transcript 不被改写。
    expect(frame).toContain('最近事件');
    for (const line of ['先看看地图', '好的', 'tool search']) {
      expect(frame).toContain(line);
    }

    const withoutEvent = renderWorkspace({ ui, events: [] });
    await settle(2);
    expect(withoutEvent.lastFrame() ?? '').not.toContain('worker-task-verified-accepted');
  });
});
