/**
 * 信息分层：语义事件只进 Event Drawer，维护噪声不进入用户时间线（IP-07，Owner: `m2-deliver-planning-tui`）。
 *
 * 断言分两层：`toSemanticEvent` 在 façade 丢弃 keepalive/超时/重复对账/诊断；`EventDrawer` 只渲染传入
 * 的语义事件，且不改写 transcript。这里不断言整屏快照，只断言结构化字段与语义片段。
 */

import { describe, expect, test } from 'vitest';

import {
  toSemanticEvent,
  type ControllerNotification,
  type SemanticEvent,
} from '../../src/application/controller-service.js';
import { projectTranscriptPage } from '../../src/application/tui/view-model.js';
import { EventDrawer, describeSemanticEvent } from '../../src/interfaces/tui/components/event-drawer.js';
import { Transcript } from '../../src/interfaces/tui/components/transcript.js';
import { makeTranscript, renderComponent, settle, type RenderedTui } from './harness.js';

const AVAILABLE_WIDTH = 100;

function renderDrawer(events: readonly SemanticEvent[]): RenderedTui {
  return renderComponent(<EventDrawer events={events} availableWidth={AVAILABLE_WIDTH} />);
}

function renderTimeline(): RenderedTui {
  return renderComponent(
    <Transcript
      transcript={projectTranscriptPage(makeTranscript(), { coordinatorSessionId: 'session-a' })}
      expandedToolIds={[]}
      onToggleTool={() => undefined}
      availableWidth={AVAILABLE_WIDTH}
    />,
  );
}

const NOISE: readonly ControllerNotification[] = [
  { kind: 'keepalive', at: 1 },
  { kind: 'poll-timeout', source: 'delivery' },
  { kind: 'unchanged-reconciliation', at: 2 },
  { kind: 'stderr', line: '诊断噪声' },
  { kind: 'diagnostic', message: '诊断噪声' },
];

describe('planning-workspace / 信息分层', () => {
  test('Scenario: 维护噪声不进入用户时间线', async () => {
    // 噪声在 façade 就被过滤：即使带着 envelope 发进来，界面的语义事件流里也没有它们。
    for (const [index, notification] of NOISE.entries()) {
      expect(
        toSemanticEvent({
          envelope: { eventId: `noise-${String(index)}`, coordinatorSessionId: null },
          notification,
        }),
      ).toBeNull();
    }

    // 抽屉只渲染传入的语义事件，保活/超时/对账没有对应条目。
    const drawer = renderDrawer([]);
    await settle(2);
    const drawerFrame = drawer.lastFrame() ?? '';
    expect(drawerFrame).toContain('暂无语义事件');

    const timeline = renderTimeline();
    await settle(2);
    const timelineFrame = timeline.lastFrame() ?? '';
    for (const notification of NOISE) {
      expect(timelineFrame).not.toContain(notification.kind);
      expect(drawerFrame).not.toContain(notification.kind);
    }
    expect(timelineFrame).not.toContain('诊断噪声');
    expect(drawerFrame).not.toContain('诊断噪声');
  });

  test('Scenario: 语义事件进入 Event Drawer', async () => {
    // Worker 生命周期、验证、授权、暂停与恢复都是语义事件；验证接受由 state-changed 的 reason 承载。
    // envelope 携带发布者给出的身份与归属：Session 事件归自己，Scope 级事件归 null。
    const semantic: readonly SemanticEvent[] = [
      {
        eventId: 'event-1',
        coordinatorSessionId: 'session-x',
        kind: 'state-changed',
        coordinationScopeId: 'scope-1',
        revision: 9,
        reason: 'worker-task-verified-accepted',
      },
      {
        eventId: 'event-2',
        coordinatorSessionId: 'session-x',
        kind: 'worker-liveness-changed',
        coordinationScopeId: 'scope-1',
        dispatchId: 'dispatch-1',
        liveness: 'exited',
      },
      {
        eventId: 'event-3',
        coordinatorSessionId: 'session-x',
        kind: 'recovery-status-changed',
        coordinationScopeId: 'scope-1',
        recoveryId: 'recovery-1',
        status: 'blocked',
      },
      {
        eventId: 'event-4',
        coordinatorSessionId: null,
        kind: 'scope-control-changed',
        coordinationScopeId: 'scope-1',
        controlState: 'paused',
      },
      {
        eventId: 'event-5',
        coordinatorSessionId: 'session-x',
        kind: 'generation-status-changed',
        coordinationScopeId: 'scope-1',
        graphId: 'graph-1',
        status: 'candidate',
      },
    ];

    const drawer = renderDrawer(semantic);
    await settle(2);
    const drawerFrame = drawer.lastFrame() ?? '';
    // 抽屉逐条渲染：归属不参与过滤，Scope 级事件（coordinatorSessionId 为 null）也会出现在这里。
    for (const event of semantic) {
      expect(drawerFrame).toContain(describeSemanticEvent(event));
    }
    // 关键语义事实可见：接受、存活、恢复阻塞、暂停、代际状态。
    expect(drawerFrame).toContain('worker-task-verified-accepted');
    expect(drawerFrame).toContain('dispatch-1');
    expect(drawerFrame).toContain('exited');
    expect(drawerFrame).toContain('blocked');
    expect(drawerFrame).toContain('paused');
    expect(drawerFrame).toContain('candidate');

    // 事件只进抽屉：transcript 由 transcript 页投影，不被事件改写。
    const timeline = renderTimeline();
    await settle(2);
    const timelineFrame = timeline.lastFrame() ?? '';
    expect(timelineFrame).toContain('先看看地图');
    expect(timelineFrame).toContain('好的');
    for (const event of semantic) {
      expect(timelineFrame).not.toContain(event.kind);
    }
    expect(timelineFrame).not.toContain('worker-task-verified-accepted');
  });
});
