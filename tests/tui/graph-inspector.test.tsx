/**
 * 只读 Graph Inspector 与沿依赖导航（IP-08，`tui/graph-inspection`）。
 *
 * 断言的是可观察事实：帧里出现的节点/依赖/Scope Envelope/readiness、沿 `upstreamOf` 求出的上游节点、
 * 选择回调只落到展示态 reducer，以及打开 Inspector 不产生任何 `execute`。
 */

import { describe, expect, test, vi } from 'vitest';
import { createElement } from 'react';

import { GraphInspector, upstreamOf } from '../../src/interfaces/tui/components/graph-inspector.js';
import { NARROW_TERMINAL_NOTICE } from '../../src/interfaces/tui/render/width.js';
import { initialTuiState, reduceTuiState } from '../../src/interfaces/tui/state.js';
import { projectGraphView, type GraphView } from '../../src/application/tui/view-model.js';
import {
  createFakePorts,
  frameText,
  makeSnapshot,
  renderComponent,
  renderTui,
  settle,
  type RenderedTui,
} from './harness.js';

/** harness 的默认快照带候选图拓扑，这里把它投影成组件输入。 */
function candidateGraph(): GraphView {
  const graph = projectGraphView(makeSnapshot());
  if (graph === null) {
    throw new Error('默认快照应包含候选图拓扑');
  }
  return graph;
}

/**
 * Ink 会把单独一个 `ESC` 当作可能的分块转义序列前缀挂起 20ms 再作为字面输入回放，
 * 因此按 Esc 必须等真实时间，不能只靠 `settle()` 的 microtask/timer(0)。
 */
async function pressEscape(rendered: RenderedTui): Promise<void> {
  rendered.stdin.write('\u001b');
  await new Promise((resolve) => setTimeout(resolve, 40));
  await settle(2);
}

describe('Graph Inspector 只读投影', () => {
  test('展示节点、依赖、Scope Envelope 与 admission readiness', () => {
    const rendered = renderComponent(
      createElement(GraphInspector, {
        graph: candidateGraph(),
        selectedWorkPackageId: null,
        onSelect: () => undefined,
        narrow: false,
        availableWidth: 100,
      }),
    );

    const frame = frameText(rendered);
    expect(frame).toContain('Graph Inspector');
    expect(frame).toContain('graph-1 v2');
    expect(frame).toContain('status=candidate');
    expect(frame).toContain('authorization=unbound');
    // 节点标题与依赖；workPackageId 在 dependsOn 中可见。
    expect(frame).toContain('第一个工作包');
    expect(frame).toContain('第二个工作包');
    expect(frame).toContain('dependsOn: none');
    expect(frame).toContain('dependsOn: wp-1');
    // Scope Envelope
    expect(frame).toContain('+src/a.ts');
    expect(frame).toContain('+src/b.ts');
    expect(frame).toContain('-tests/**');
  });

  test('图记录不可读时显示 blocker，而不是空白图', () => {
    // 指针存在但 graphTopologies 记录缺失：投影必须返回 null 让界面显示 blocker。
    const missing = projectGraphView(makeSnapshot({ graphTopologies: [] }));
    expect(missing).toBeNull();

    const rendered = renderComponent(
      createElement(GraphInspector, {
        graph: missing,
        selectedWorkPackageId: null,
        onSelect: () => undefined,
        narrow: false,
        availableWidth: 100,
      }),
    );

    const frame = frameText(rendered);
    expect(frame).toContain('Graph Inspector');
    expect(frame).toContain('不可用');
    // 空白图的特征：没有任何节点行。
    expect(frame).not.toContain('wp-1');
    expect(frame).not.toContain('dependsOn');
  });

  test('终端过窄时提示加宽，不用 overlay 遮挡主视图', () => {
    const rendered = renderComponent(
      createElement(GraphInspector, {
        graph: candidateGraph(),
        selectedWorkPackageId: null,
        onSelect: () => undefined,
        narrow: true,
        availableWidth: 40,
      }),
    );

    const frame = frameText(rendered);
    expect(frame).toContain(NARROW_TERMINAL_NOTICE);
    expect(frame).not.toContain('dependsOn');
  });
});

describe('沿依赖导航', () => {
  test('upstreamOf 只读返回依赖上游，不改变图定义', () => {
    const graph = candidateGraph();
    const before = graph.nodes.map((node) => node.workPackageId);

    expect(upstreamOf(graph, 'wp-2')).toEqual(['wp-1']);
    expect(upstreamOf(graph, 'wp-1')).toEqual([]);
    expect(upstreamOf(graph, 'wp-missing')).toEqual([]);

    // 计算上游不写回图定义。
    expect(graph.nodes.map((node) => node.workPackageId)).toEqual(before);
  });

  test('选中上游节点的回调只改展示态', () => {
    const graph = candidateGraph();
    const onSelect = vi.fn<(workPackageId: string) => void>();

    const rendered = renderComponent(
      createElement(GraphInspector, {
        graph,
        selectedWorkPackageId: 'wp-2',
        onSelect,
        narrow: false,
        availableWidth: 100,
      }),
    );
    // 选中 wp-2 时帧里给出它的上游，并标出当前选中行。
    const frame = frameText(rendered);
    expect(frame).toContain('upstream: wp-1');
    expect(frame).toContain('> 第二个工作包');

    const upstream = upstreamOf(graph, 'wp-2');
    for (const workPackageId of upstream) {
      onSelect(workPackageId);
    }
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('wp-1');

    // 选择落到 reducer 后只有 inspectorSelection 变化，没有任何业务字段被触碰。
    const before = initialTuiState;
    const after = reduceTuiState(before, { kind: 'inspector-selected', workPackageId: 'wp-1' });
    expect(after.inspectorSelection).toBe('wp-1');
    expect(after.screen).toBe(before.screen);
    expect(after.overlayStack).toEqual(before.overlayStack);
    expect(after.selectedSessionId).toBe(before.selectedSessionId);
    expect(after.drafts).toEqual(before.drafts);
    expect(after.unreadSessionIds).toEqual(before.unreadSessionIds);
  });
});

describe('完整 TUI 中的 Inspector 不触发领域动作', () => {
  test('Ctrl+G 打开候选图后 execute 计数为 0，Esc 逐层关闭', async () => {
    const fake = createFakePorts();
    const rendered = renderTui(fake.ports);
    await settle();

    rendered.stdin.write('\u0007');
    await settle();

    const frame = frameText(rendered);
    expect(frame).toContain('Graph Inspector');
    expect(frame).toContain('upstream: none');
    // 只读：没有 execute，也没有任何写调用。
    expect(fake.executeCount()).toBe(0);
    expect(fake.executeIntents).toEqual([]);

    await pressEscape(rendered);
    expect(frameText(rendered)).not.toContain('Graph Inspector');
    expect(fake.executeCount()).toBe(0);

    rendered.unmount();
  });
});

/**
 * Inspector 自述键位为「↑/↓ 选择 · ←/→ 沿依赖导航」。下面的用例断言这两个方向键真的驱动选择与上游导航；
 * 当前 `src/interfaces/tui/app.tsx` 的 `useInput` 在 graph-inspector overlay 上不处理方向键，
 * 因此会失败——失败是可复现的缺陷证据，不要为让它变绿而放宽断言。
 */
describe('Inspector 方向键导航（IP-08 需求）', () => {
  test('↓ 选中节点、→ 沿依赖移动到上游', async () => {
    const fake = createFakePorts();
    const rendered = renderTui(fake.ports);
    await settle();

    rendered.stdin.write('\u0007');
    await settle();

    // ↓ 选中第一个节点。
    rendered.stdin.write('\u001b[B');
    await settle(2);
    expect(frameText(rendered)).toContain('> 第一个工作包');

    // ↓ 到 wp-2，帧里给出它的上游。
    rendered.stdin.write('\u001b[B');
    await settle(2);
    expect(frameText(rendered)).toContain('> 第二个工作包');
    expect(frameText(rendered)).toContain('upstream: wp-1');

    // → 沿依赖移动到上游节点 wp-1。
    rendered.stdin.write('\u001b[C');
    await settle(2);
    expect(frameText(rendered)).toContain('> 第一个工作包');
    expect(frameText(rendered)).toContain('upstream: none');

    // 导航始终只读。
    expect(fake.executeCount()).toBe(0);

    rendered.unmount();
  });
});
