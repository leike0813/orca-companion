/**
 * Session Picker 与焦点约束（IP-07，Owner: `m2-deliver-planning-tui`）。
 *
 * 断言的是可观察规则：无既有选择时默认选中待答 Session；新事件只增加未读标记，不改选中与草稿；
 * 每个 Session 的草稿与滚动位置独立保存。选择与草稿都是纯 reducer 事实，这里不镜像实现内部结构。
 */

import { describe, expect, test } from 'vitest';

import { projectSessionSummaryView } from '../../src/application/tui/view-model.js';
import { createFakePorts, makeSnapshot, renderComponent, renderTui, settle } from './harness.js';
import {
  SessionPicker,
  preferredSessionId,
  sessionMarker,
} from '../../src/interfaces/tui/components/session-picker.js';
import { draftFor, initialTuiState, reduceTuiState, type TuiState } from '../../src/interfaces/tui/state.js';

function workspaceState(overrides: Partial<TuiState> = {}): TuiState {
  return { ...initialTuiState, screen: 'workspace', ...overrides };
}

function projectSessions(state: TuiState) {
  return makeSnapshot().sessions.map((session) =>
    projectSessionSummaryView(session, {
      selectedSessionId: state.selectedSessionId,
      unreadSessionIds: state.unreadSessionIds,
    }),
  );
}

describe('session-interactions / Session Picker 与焦点约束', () => {
  test('Scenario: 启动时优先待答 Session', async () => {
    const sessions = projectSessions(workspaceState());
    // `makeSnapshot` 的 session-b 带 1 个 Pending Interaction。
    expect(sessions.map(sessionMarker)).toEqual([' ', '?']);

    // 无既有选择：待答 Session 优先，否则退回列表首项（最近活动）。
    expect(preferredSessionId(sessions, null)).toBe('session-b');
    const noPending = sessions.map((session) => ({ ...session, openInteractionCount: 0 }));
    expect(preferredSessionId(noPending, null)).toBe('session-a');
    // 已有选择记录时保留，不因新一轮待答重新默认。
    expect(preferredSessionId(sessions, 'session-a')).toBe('session-a');

    // 界面态接受该默认选中；已有选择不被覆盖。
    const loaded = reduceTuiState(workspaceState(), {
      kind: 'sessions-loaded',
      coordinatorSessionIds: sessions.map((session) => session.coordinatorSessionId),
      preferred: preferredSessionId(sessions, null),
    });
    expect(loaded.selectedSessionId).toBe('session-b');

    const kept = reduceTuiState(workspaceState({ selectedSessionId: 'session-a' }), {
      kind: 'sessions-loaded',
      coordinatorSessionIds: ['session-a', 'session-b'],
      preferred: 'session-b',
    });
    expect(kept.selectedSessionId).toBe('session-a');

    // Session Picker 把选中标记放在待答 Session 上。
    const rendered = renderComponent(
      <SessionPicker
        sessions={sessions}
        selectedSessionId={loaded.selectedSessionId}
        onSelect={() => undefined}
        availableWidth={100}
      />,
    );
    await settle(2);
    const lines = (rendered.lastFrame() ?? '').split('\n');
    const selectedLine = lines.find((line) => line.includes('session-b')) ?? '';
    const otherLine = lines.find((line) => line.includes('session-a')) ?? '';
    expect(selectedLine.indexOf('>')).toBeGreaterThanOrEqual(0);
    expect(selectedLine.indexOf('>')).toBeLessThan(selectedLine.indexOf('session-b'));
    expect(otherLine).not.toContain('>');
  });

  test('Scenario: 启动时优先待答 Session（容器默认选中）', async () => {
    // 端到端：容器依快照默认选中待答 Session，并按它加载 transcript。
    const fake = createFakePorts();
    renderTui(fake.ports);
    await settle(12);

    const transcriptCalls = fake.calls
      .filter((call) => call.name === 'transcript')
      .map((call) => call.detail);
    expect(transcriptCalls).toEqual(['session-b']);
    expect(fake.executeCount()).toBe(0);
  });

  test('Scenario: 新事件不抢占焦点', () => {
    const selected = reduceTuiState(workspaceState(), {
      kind: 'session-selected',
      coordinatorSessionId: 'session-a',
    });
    const typing = reduceTuiState(selected, {
      kind: 'draft-changed',
      coordinatorSessionId: 'session-a',
      text: '正在输入',
    });
    const arrived = reduceTuiState(typing, {
      kind: 'event-arrived',
      coordinatorSessionId: 'session-b',
    });

    // 焦点不变：选中 Session 与草稿保持，另一 Session 只增加未读标记。
    expect(arrived.selectedSessionId).toBe('session-a');
    expect(draftFor(arrived, 'session-a')).toBe('正在输入');
    expect(arrived.unreadSessionIds).toEqual(['session-b']);
    expect(arrived.attention).toBe(true);
    // 除未读标记与 attention 外，其余展示态逐一保持。
    expect({ ...arrived, unreadSessionIds: typing.unreadSessionIds, attention: typing.attention }).toEqual(
      typing,
    );

    // 未读只反映在投影标记上，不改变选中。
    const projected = projectSessions(arrived);
    expect(projected.find((session) => session.coordinatorSessionId === 'session-b')?.unread).toBe(true);
    expect(projected.find((session) => session.coordinatorSessionId === 'session-a')?.unread).toBe(false);
    expect(projected.filter((session) => session.unread).map(sessionMarker)).toEqual(['*']);
    expect(projected.find((session) => session.selected)?.coordinatorSessionId).toBe('session-a');

    // 重复事件不重复标记；当前 Session 的事件只做一次性 attention。
    const again = reduceTuiState(arrived, { kind: 'event-arrived', coordinatorSessionId: 'session-b' });
    expect(again.unreadSessionIds).toEqual(['session-b']);
    const current = reduceTuiState(typing, { kind: 'event-arrived', coordinatorSessionId: 'session-a' });
    expect(current.unreadSessionIds).toEqual([]);
    expect(current.attention).toBe(true);
  });

  test('Scenario: 切换后保留草稿', () => {
    let state = reduceTuiState(workspaceState(), {
      kind: 'session-selected',
      coordinatorSessionId: 'session-a',
    });
    state = reduceTuiState(state, {
      kind: 'draft-changed',
      coordinatorSessionId: 'session-a',
      text: 'A 的未提交草稿',
    });
    state = reduceTuiState(state, {
      kind: 'scroll-changed',
      coordinatorSessionId: 'session-a',
      offset: 12,
    });

    state = reduceTuiState(state, { kind: 'session-selected', coordinatorSessionId: 'session-b' });
    expect(draftFor(state, 'session-b')).toBe('');
    state = reduceTuiState(state, {
      kind: 'draft-changed',
      coordinatorSessionId: 'session-b',
      text: 'B 的草稿',
    });
    state = reduceTuiState(state, {
      kind: 'scroll-changed',
      coordinatorSessionId: 'session-b',
      offset: 3,
    });

    // 往返切回：A 的草稿与滚动位置原样保留，B 的互不影响。
    state = reduceTuiState(state, { kind: 'session-selected', coordinatorSessionId: 'session-a' });
    expect(draftFor(state, 'session-a')).toBe('A 的未提交草稿');
    expect(state.scrollOffsets['session-a']).toBe(12);
    expect(draftFor(state, 'session-b')).toBe('B 的草稿');
    expect(state.scrollOffsets['session-b']).toBe(3);
  });

  test('Scenario: 另一个 Session 的事件只标记未读，不抢占焦点（容器）', async () => {
    // 容器按快照默认选中待答的 session-b；事件归属 session-a 时只增加未读标记。
    const fake = createFakePorts();
    const rendered = renderTui(fake.ports);
    await settle(12);
    expect(fake.calls.filter((call) => call.name === 'transcript').map((call) => call.detail)).toEqual(['session-b']);

    fake.emit({
      eventId: 'event-session-a',
      coordinatorSessionId: 'session-a',
      kind: 'state-changed',
      coordinationScopeId: 'scope-1',
      revision: 5,
      reason: 'committed',
    });
    await settle(2);

    // transcript 不切换：没有新的加载，也没有任何写入意图。
    expect(fake.calls.filter((call) => call.name === 'transcript').map((call) => call.detail)).toEqual(['session-b']);
    expect(fake.executeCount()).toBe(0);

    // 打开 Session Picker：未读标记落在 session-a 上，选中标记仍在 session-b 上。
    rendered.stdin.write('\u0010'); // ctrl+p 打开 Command Palette
    await settle(2);
    for (let index = 0; index < 3; index += 1) {
      rendered.stdin.write('\u001b[B'); // 下移到 Session Picker
      await settle(2);
    }
    rendered.stdin.write('\r');
    await settle(2);

    const lines = (rendered.lastFrame() ?? '').split('\n');
    const unreadLine = lines.find((line) => line.includes('session-a')) ?? '';
    const selectedLine = lines.find((line) => line.includes('session-b')) ?? '';
    expect(unreadLine).toContain('*');
    expect(selectedLine.indexOf('>')).toBeGreaterThanOrEqual(0);
    expect(selectedLine).not.toContain('*');

    rendered.unmount();
  });
});
