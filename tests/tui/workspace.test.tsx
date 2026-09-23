/**
 * 常驻 transcript 与 composer 主视图（IP-05，Owner: `m2-deliver-planning-tui`）。
 *
 * 断言的是用户可观察事实：窄屏下主视图不折叠、工具细节默认不渲染、普通字符只进草稿、`Esc` 只弹出栈顶、
 * 语义事件只进抽屉而不改写 transcript。窄屏不能走 `renderTui`（ink-testing-library 的 mock stdout 固定
 * 100 列），因此直接渲染 `Workspace` 并显式传入 `terminalWidth`；密度由 `allowedSidebarDensity` 与
 * reducer 推导，与真实 resize 路径一致。
 */

import { describe, expect, test } from 'vitest';

import { toSemanticEvent, type SemanticEvent } from '../../src/application/controller-service.js';
import {
  projectTranscriptPage,
  projectTuiViewModel,
  type TuiViewModel,
} from '../../src/application/tui/view-model.js';
import { handleComposerKey } from '../../src/interfaces/tui/app.js';
import { COMMAND_IDS } from '../../src/interfaces/tui/components/command-palette.js';
import { SIDEBAR_COLLAPSED_MARKER } from '../../src/interfaces/tui/components/sidebar.js';
import { TOOL_COLLAPSED_MARKER, TOOL_EXPANDED_MARKER } from '../../src/interfaces/tui/components/transcript.js';
import { resolveGlobalAction } from '../../src/interfaces/tui/input/keymap.js';
import type { ModelCatalog } from '../../src/interfaces/tui/ports.js';
import { allowedSidebarDensity } from '../../src/interfaces/tui/render/width.js';
import { Workspace, type WorkspaceActions } from '../../src/interfaces/tui/screens/workspace.js';
import { draftFor, initialTuiState, reduceTuiState, type TuiState } from '../../src/interfaces/tui/state.js';
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
  closeTopOverlay: () => undefined,
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
    readonly ui?: TuiState;
    readonly snapshot?: SnapshotOverrides;
    readonly events?: readonly SemanticEvent[];
  } = {},
): RenderedTui {
  const ui = options.ui ?? uiState();
  return renderComponent(
    <Workspace
      viewModel={workspaceView(options.snapshot ?? {}, ui.selectedSessionId)}
      ui={ui}
      terminalWidth={options.terminalWidth ?? 100}
      events={options.events ?? []}
      actions={NOOP_ACTIONS}
      modelCatalog={MODEL_CATALOG}
      modelRejection={null}
      paletteSelection={0}
      modelSelection={0}
      composerDisabledReason={null}
      newlineHint="Shift+Enter 换行"
      handoffProposal={null}
      commands={COMMAND_IDS}
    />,
  );
}

describe('planning-workspace / 常驻 transcript 与 composer 主视图', () => {
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
      expect(frame).toContain('composer ·'); // composer 常驻
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
      draft: draftFor(ui, 'session-a'),
      change: (text) => {
        ui = reduceTuiState(ui, { kind: 'draft-changed', coordinatorSessionId: 'session-a', text });
      },
      submit: () => undefined,
    });
    expect(draftFor(ui, 'session-a')).toBe('窄屏草稿');

    const rendered = renderWorkspace({ terminalWidth, ui });
    await settle(2);
    const frame = rendered.lastFrame() ?? '';

    expect(frame).toContain(SIDEBAR_COLLAPSED_MARKER); // Sidebar 折叠，主视图不被挤压
    expect(frame).not.toContain('wp-1'); // 折叠态不渲染不可见详情
    expect(frame).toContain('先看看地图');
    expect(frame).toContain('composer ·');
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
    let ui = uiState({ drafts: { 'session-a': '已经输入' } });
    const submitted: string[] = [];
    handleComposerKey('p', {}, {
      readOnly: false,
      draft: draftFor(ui, 'session-a'),
      change: (text) => {
        ui = reduceTuiState(ui, { kind: 'draft-changed', coordinatorSessionId: 'session-a', text });
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
    expect(app.lastFrame() ?? '').toContain('输入消息后回车提交');

    app.stdin.write('p');
    await settle(2);
    const frame = app.lastFrame() ?? '';
    expect(frame).not.toContain('输入消息后回车提交');
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
    expect(stackedFrame).toContain('Event Drawer');
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
    expect(toSemanticEvent({ kind: 'keepalive', at: 1 })).toBeNull();
    expect(toSemanticEvent({ kind: 'unchanged-reconciliation', at: 2 })).toBeNull();

    const ui = uiState({ overlayStack: ['event-drawer'] });
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
      kind: 'state-changed',
      coordinationScopeId: 'scope-1',
      revision: 9,
      reason: 'worker-task-verified-accepted',
    };
    const ui = uiState({ overlayStack: ['event-drawer'] });

    const withEvent = renderWorkspace({ ui, events: [verified] });
    await settle(2);
    const frame = withEvent.lastFrame() ?? '';
    expect(frame).toContain('worker-task-verified-accepted');
    // 事件只在抽屉里，位于常驻主视图之后；transcript 不被改写。
    expect(frame.indexOf('state-changed')).toBeGreaterThan(frame.indexOf('composer ·'));
    for (const line of ['先看看地图', '好的', 'tool search']) {
      expect(frame).toContain(line);
    }

    const withoutEvent = renderWorkspace({ ui, events: [] });
    await settle(2);
    expect(withoutEvent.lastFrame() ?? '').not.toContain('worker-task-verified-accepted');
  });
});
