/**
 * 显示宽度渲染测试（IP-06）。
 *
 * 断言的是可观察的渲染事实：换行与裁切按显示宽度、中文与中英文混排不失落、折叠态不计算详情。
 */

import { describe, expect, test } from 'vitest';
import { createElement } from 'react';

import {
  allowedSidebarDensity,
  displayWidth,
  padToDisplayWidth,
  sidebarWidthFor,
  truncateToDisplayWidth,
  wrapByDisplayWidth,
} from '../../src/interfaces/tui/render/width.js';
import { Sidebar } from '../../src/interfaces/tui/components/sidebar.js';
import { renderComponent, makeSnapshot, settle } from './harness.js';
import { projectTuiViewModel, projectTranscriptPage } from '../../src/application/tui/view-model.js';

describe('display width', () => {
  test('中文与全角字符按 2 列计算', () => {
    expect(displayWidth('中文')).toBe(4);
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('中文abc')).toBe(7);
  });

  test('零宽字符不占列', () => {
    expect(displayWidth('e\u0301')).toBe(1);
    expect(displayWidth('\u200b')).toBe(0);
  });

  test('按显示宽度换行：中英文混排不丢内容', () => {
    const lines = wrapByDisplayWidth('中文abc中文', 6);
    expect(lines).toEqual(['中文ab', 'c中文']);
    expect(lines.join('')).toBe('中文abc中文');
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(6);
    }
  });

  test('已有换行符强制断行', () => {
    expect(wrapByDisplayWidth('ab\ncd', 10)).toEqual(['ab', 'cd']);
  });

  test('按显示宽度裁切并保留省略号预算', () => {
    expect(truncateToDisplayWidth('中文中文', 5)).toBe('中文…');
    expect(displayWidth(truncateToDisplayWidth('中文中文', 5))).toBeLessThanOrEqual(5);
    expect(truncateToDisplayWidth('abc', 5)).toBe('abc');
  });

  test('右侧补齐到目标显示宽度', () => {
    expect(displayWidth(padToDisplayWidth('中文', 6))).toBe(6);
  });
});

describe('Sidebar 三态与密度上限', () => {
  test('宽度决定允许的最高密度，而不是强制展开', () => {
    expect(allowedSidebarDensity(40)).toBe('collapsed');
    expect(allowedSidebarDensity(70)).toBe('compact');
    expect(allowedSidebarDensity(120)).toBe('full');
    expect(sidebarWidthFor('collapsed')).toBe(0);
  });

  test('用户折叠后即使出现待处理交互也不强制展开', async () => {
    const viewModel = projectTuiViewModel({
      snapshot: makeSnapshot({
        interactions: [
          {
            interactionId: 'i-1',
            ownerCoordinatorSessionId: 'session-a',
            subjectRef: { kind: 'ticket', id: 't-1' },
            expectedRevision: 4,
            state: 'open',
          },
        ],
      }),
      transcript: projectTranscriptPage(null, { coordinatorSessionId: 'session-a' }),
      selectedSessionId: 'session-a',
      unreadSessionIds: [],
    });
    const rendered = renderComponent(
      createElement(Sidebar, { density: 'collapsed', viewModel, terminalWidth: 120 }),
    );
    await settle(2);
    expect(rendered.lastFrame()).toContain('已折叠');
    // 折叠态不计算不可见详情：展开态才出现的节点信息不得出现在帧里。
    expect(rendered.lastFrame()).not.toContain('wp-1');
    expect(rendered.lastFrame()).not.toContain('ready:');
  });

  test('折叠态不读取图与 Worker 细节（结构性保证）', () => {
    const poisoned = new Proxy(
      {},
      {
        get: () => {
          throw new Error('折叠态不得读取 details');
        },
      },
    );
    const viewModel = {
      ...projectTuiViewModel({
        snapshot: makeSnapshot(),
        transcript: projectTranscriptPage(null, { coordinatorSessionId: null }),
        selectedSessionId: null,
        unreadSessionIds: [],
      }),
      graph: poisoned as never,
      workers: poisoned as never,
    };
    expect(() =>
      renderComponent(createElement(Sidebar, { density: 'collapsed', viewModel, terminalWidth: 120 })),
    ).not.toThrow();
  });

  test('完整态展示节点、依赖与 readiness', async () => {
    const viewModel = projectTuiViewModel({
      snapshot: makeSnapshot(),
      transcript: projectTranscriptPage(null, { coordinatorSessionId: null }),
      selectedSessionId: null,
      unreadSessionIds: [],
    });
    const rendered = renderComponent(
      createElement(Sidebar, { density: 'full', viewModel, terminalWidth: 120 }),
    );
    await settle(2);
    const frame = rendered.lastFrame() ?? '';
    expect(frame).toContain('wp-1');
    expect(frame).toContain('auth=unbound');
  });
});
