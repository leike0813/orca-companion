/**
 * Pending Interaction 内联卡片与回答绑定（IP-08，`tui/session-interactions`）。
 *
 * 断言的是可观察事实：提交落到哪个 intent（种类与字段）、交互是否仍待答、拒绝时草稿与绑定是否保留。
 * 普通消息与 Answer 模式的分离是结构性的：composer 模式决定 intent 形状，而不是解析自由文本。
 */

import { describe, expect, test, vi } from 'vitest';
import { createElement } from 'react';

import { COMMAND_IDS } from '../../src/interfaces/tui/components/command-palette.js';
import { InteractionCard } from '../../src/interfaces/tui/components/interaction-card.js';
import { Workspace, type WorkspaceActions } from '../../src/interfaces/tui/screens/workspace.js';
import { initialTuiState, reduceTuiState, type TuiState } from '../../src/interfaces/tui/state.js';
import type { ControllerInteractionView } from '../../src/application/controller-service.js';
import type { ModelCatalog } from '../../src/interfaces/tui/ports.js';
import {
  projectTranscriptPage,
  projectTuiViewModel,
} from '../../src/application/tui/view-model.js';
import {
  createFakePorts,
  frameText,
  makeSnapshot,
  makeTranscript,
  renderComponent,
  renderTui,
  settle,
  type RenderedTui,
} from './harness.js';

/** Ctrl+A：进入当前 Session 的回答模式（见 `src/interfaces/tui/input/keymap.ts`）。 */
const CTRL_A = '\u0001';

const INTERACTION: ControllerInteractionView = {
  interactionId: 'i-1',
  ownerCoordinatorSessionId: 'session-b',
  subjectRef: { kind: 'ticket', id: 't-1' },
  expectedRevision: 4,
  state: 'open',
};

const EMPTY_CATALOG: ModelCatalog = {
  options: [],
  currentConfigurationRef: null,
  switchable: false,
  switchBlockReason: null,
};

function noopActions(): WorkspaceActions {
  return {
    dispatch: vi.fn(),
    composerChange: vi.fn(),
    submit: vi.fn(),
    toggleTool: vi.fn(),
    selectSession: vi.fn(),
    enterAnswer: vi.fn(),
    runCommand: vi.fn(),
    selectModel: vi.fn(),
    confirmHandoff: vi.fn(),
    cancelHandoff: vi.fn(),
    closeTopOverlay: vi.fn(),
  };
}

async function pressKey(rendered: RenderedTui, input: string): Promise<void> {
  rendered.stdin.write(input);
  await settle(2);
}

describe('Pending Interaction 内联卡片', () => {
  test('普通消息提交走 send-session-message，而不是回答', async () => {
    const fake = createFakePorts({ snapshot: { interactions: [INTERACTION] } });
    const rendered = renderTui(fake.ports);
    await settle();

    // 卡片可见：绑定 interaction ID 与 expected revision。
    const before = frameText(rendered);
    expect(before).toContain('待答 ticket:t-1');
    expect(before).toContain('revision=4');

    await pressKey(rendered, 'proceed');
    await pressKey(rendered, '\r');

    expect(fake.executeIntents).toHaveLength(1);
    const intent = fake.executeIntents[0];
    expect(intent?.kind).toBe('send-session-message');
    if (intent?.kind === 'send-session-message') {
      expect(intent.coordinatorSessionId).toBe('session-b');
      expect(intent.content).toBe('proceed');
    }
    // 普通消息结构上不可能满足待答问题：没有任何回答 intent，交互仍待答。
    expect(fake.executeIntents.some((entry) => entry.kind === 'answer-pending-interaction')).toBe(
      false,
    );
    expect(frameText(rendered)).toContain('待答 ticket:t-1');
    expect(frameText(rendered)).toContain('state=open');

    rendered.unmount();
  });

  test('Answer 模式把 interaction ID 与 expected revision 写进展示态', () => {
    const answering = reduceTuiState(initialTuiState, {
      kind: 'answer-mode-entered',
      interactionId: 'i-1',
      expectedRevision: 4,
    });
    expect(answering.composerMode).toEqual({
      kind: 'answer',
      interactionId: 'i-1',
      expectedRevision: 4,
    });
    // 切换 Session 会重置模式，避免回答绑到错误的交互。
    expect(
      reduceTuiState(answering, { kind: 'session-selected', coordinatorSessionId: 'session-a' })
        .composerMode,
    ).toEqual({ kind: 'message' });

    const ui: TuiState = {
      ...answering,
      screen: 'workspace',
      selectedSessionId: 'session-b',
    };
    const viewModel = projectTuiViewModel({
      snapshot: makeSnapshot({ interactions: [INTERACTION] }),
      transcript: projectTranscriptPage(makeTranscript('session-b'), {
        coordinatorSessionId: 'session-b',
      }),
      selectedSessionId: 'session-b',
      unreadSessionIds: [],
    });

    const rendered = renderComponent(
      createElement(Workspace, {
        viewModel,
        ui,
        terminalWidth: 100,
        events: [],
        actions: noopActions(),
        modelCatalog: EMPTY_CATALOG,
        modelRejection: null,
        paletteSelection: 0,
        modelSelection: 0,
        composerDisabledReason: null,
        newlineHint: 'Shift+Enter 换行',
        handoffProposal: null,
        commands: COMMAND_IDS,
      }),
    );

    const frame = frameText(rendered);
    // composer 与卡片都显式绑定该 interaction 与 revision。
    expect(frame).toContain('回答 interaction i-1');
    expect(frame).toContain('revision 4');
    expect(frame).toContain('[回答模式]');
  });

  test('卡片展示绑定的 interaction 与 revision，回答模式下带标记', () => {
    const rendered = renderComponent(
      createElement(InteractionCard, {
        interaction: INTERACTION,
        answering: true,
        onEnterAnswer: vi.fn(),
        availableWidth: 100,
      }),
    );
    const frame = frameText(rendered);
    expect(frame).toContain('待答 ticket:t-1');
    expect(frame).toContain('revision=4');
    expect(frame).toContain('[回答模式]');
  });
});

describe('Answer 模式端到端', () => {
  test('进入回答模式后按绑定 interaction ID 与 revision 提交一次回答', async () => {
    const fake = createFakePorts({ snapshot: { interactions: [INTERACTION] } });
    const rendered = renderTui(fake.ports);
    await settle();

    await pressKey(rendered, CTRL_A);
    expect(frameText(rendered)).toContain('回答 interaction i-1');
    expect(frameText(rendered)).toContain('revision 4');

    await pressKey(rendered, 'yes');
    await pressKey(rendered, '\r');

    expect(fake.executeIntents).toHaveLength(1);
    const intent = fake.executeIntents[0];
    expect(intent?.kind).toBe('answer-pending-interaction');
    if (intent?.kind === 'answer-pending-interaction') {
      expect(intent.interactionId).toBe('i-1');
      expect(intent.expectedRevision).toBe(4);
      expect(intent.answer).toBe('yes');
    }

    rendered.unmount();
  });

  test('过期 revision 被拒绝时保留输入并提示重新读取', async () => {
    const fake = createFakePorts({
      snapshot: { interactions: [INTERACTION] },
      executeResult: {
        kind: 'rejected',
        code: 'stale_revision',
        message: 'expected revision 4 已过期',
      },
    });
    const rendered = renderTui(fake.ports);
    await settle();

    await pressKey(rendered, CTRL_A);
    await pressKey(rendered, 'yes');
    await pressKey(rendered, '\r');

    expect(fake.executeIntents.map((intent) => intent.kind)).toEqual([
      'answer-pending-interaction',
    ]);
    const frame = frameText(rendered);
    // 结构化拒绝可见；草稿与回答模式绑定都保留，用户可直接重读 revision 后重试。
    expect(frame).toContain('stale_revision');
    expect(frame).toContain('yes');
    expect(frame).toContain('回答 interaction i-1');

    rendered.unmount();
  });
});
