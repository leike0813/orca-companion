/**
 * 渲染、重挂载与高频事件的零业务副作用（IP-09，`tui/graph-inspection`）。
 *
 * 断言的是可观察事实：`execute` 计数为 0、调用清单只有只读 query、Event Drawer 的窗口有界，
 * 以及折叠态 Sidebar 在结构上不访问图/Worker 详情。
 */

import { describe, expect, test } from 'vitest';
import { createElement } from 'react';

import { EVENT_WINDOW } from '../../src/interfaces/tui/app.js';
import { Sidebar, SIDEBAR_COLLAPSED_MARKER } from '../../src/interfaces/tui/components/sidebar.js';
import {
  projectTranscriptPage,
  projectTuiViewModel,
} from '../../src/application/tui/view-model.js';
import {
  createFakePorts,
  frameText,
  makeSnapshot,
  renderComponent,
  renderTui,
  settle,
  type RenderedTui,
} from './harness.js';

/** 只读端口白名单：渲染路径只允许 query，不允许任何写。 */
const READ_ONLY_PORTS = ['resolveHome', 'snapshot', 'transcript'];

async function pressKey(rendered: RenderedTui, input: string): Promise<void> {
  rendered.stdin.write(input);
  await settle(2);
}

describe('重挂载与 resize 零业务副作用', () => {
  test('挂载、输入与重挂载后 execute 计数为 0，且只有只读调用', async () => {
    const fake = createFakePorts();

    const first = renderTui(fake.ports);
    await settle();
    // resize 只重算布局：不重新查询、更不写入。
    first.stdout.emit('resize');
    await settle(2);
    // 未提交的普通输入同样不产生任何写。
    first.stdin.write('half-typed');
    await settle(2);
    expect(fake.executeCount()).toBe(0);
    first.unmount();

    const second = renderTui(fake.ports);
    await settle();
    expect(frameText(second)).toContain('composer');

    expect(fake.executeCount()).toBe(0);
    expect(fake.executeIntents).toEqual([]);
    const names = [...new Set(fake.calls.map((call) => call.name))];
    expect(names.every((name) => READ_ONLY_PORTS.includes(name))).toBe(true);
    // 只读加载确实发生过（不是「什么都没跑」的假绿）。
    expect(names).toContain('snapshot');
    expect(names).toContain('transcript');
    // 重挂载真的重跑了挂载 effect，而不是复用了上一次的实例。
    expect(fake.calls.filter((call) => call.name === 'resolveHome')).toHaveLength(2);

    second.unmount();
  });
});

describe('高频事件有界刷新', () => {
  test('批量投递 200 条语义事件后无 execute，Event Drawer 窗口有界', async () => {
    const fake = createFakePorts();
    const rendered = renderTui(fake.ports);
    await settle();
    const framesBefore = rendered.frames.length;

    for (let index = 0; index < 200; index += 1) {
      fake.emit({
        eventId: `event-${String(index)}`,
        coordinatorSessionId: 'session-a',
        kind: 'state-changed',
        coordinationScopeId: 'scope-1',
        revision: index,
        reason: `r${String(index)}`,
      });
    }
    fake.emit({
      eventId: 'event-199',
      coordinatorSessionId: 'session-b',
      kind: 'state-changed',
      coordinationScopeId: 'scope-1',
      revision: 199,
      reason: 'duplicate-delivery',
    });
    await settle(2);
    expect(rendered.frames.length - framesBefore).toBeLessThan(EVENT_WINDOW);

    // 事件只进展示态，绝不触发领域动作。
    expect(fake.executeCount()).toBe(0);
    expect(fake.executeIntents).toEqual([]);

    // 打开 Event Drawer 观察窗口：只保留最近 EVENT_WINDOW 条。
    await pressKey(rendered, '\u0010');
    expect(frameText(rendered)).toContain('Command Palette');
    for (let index = 0; index < 4; index += 1) {
      await pressKey(rendered, '\u001b[B');
    }
    await pressKey(rendered, '\r');

    const frame = frameText(rendered);
    expect(frame).toContain('Event Drawer');
    const shown = frame.match(/state-changed rev=/g) ?? [];
    expect(shown).toHaveLength(EVENT_WINDOW);
    expect(shown.length).toBeLessThan(200);
    // 窗口保留的是最新事件，最旧的已被裁掉。
    expect(frame).toContain('(r199)');
    expect(frame).not.toContain('(r0)');
    expect(frame).not.toContain('duplicate-delivery');
    expect(fake.executeCount()).toBe(0);

    rendered.unmount();
  });
});

describe('折叠态不计算不可见详情', () => {
  test('Sidebar 折叠态不访问 graph/workers 字段', async () => {
    const poisoned = new Proxy(
      {},
      {
        get: () => {
          throw new Error('折叠态不得读取图与 Worker 详情');
        },
      },
    );
    // 毒化确实会在读取时抛出，避免「假绿」。
    expect(() => (poisoned as { graph: unknown }).graph).toThrow();

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

    const rendered = renderComponent(
      createElement(Sidebar, { density: 'collapsed', viewModel, terminalWidth: 120 }),
    );
    await settle(2);

    const frame = frameText(rendered);
    expect(frame).toContain(SIDEBAR_COLLAPSED_MARKER);
    expect(frame).not.toContain('wp-1');
    expect(frame).not.toContain('ready:');
  });
});
