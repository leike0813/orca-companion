/**
 * 只读 Graph Inspector 与沿依赖导航（IP-08，`tui/graph-inspection`）。
 *
 * 断言的是可观察事实：帧里出现的节点/依赖/Scope Envelope/readiness、沿 `upstreamOf` 求出的上游节点、
 * 选择回调只落到展示态 reducer，以及打开 Inspector 不产生任何 `execute`。
 */

import { describe, expect, test, vi } from 'vitest';
import { createElement } from 'react';

import { GraphInspector, graphDetailRows, upstreamOf } from '../../src/interfaces/tui/components/graph-inspector.js';
import {
  BASIS_ROOT_ENTRIES,
  GraphBasisView,
  basisSourceKey,
  basisVersionSelection,
  basisReflowScroll,
  retirementNote,
  versionRow,
  type BasisViewModel,
} from '../../src/interfaces/tui/components/graph-basis-view.js';
import { basisBack, basisEnter, basisFrameKey, basisStack, basisTop, type BasisFrame } from '../../src/interfaces/tui/state.js';
import { initialTuiState, reduceTuiState } from '../../src/interfaces/tui/state.js';
import { wrapByDisplayWidth } from '../../src/interfaces/tui/render/width.js';
import { projectGraphView, type GraphView } from '../../src/application/tui/view-model.js';
import type { BasisSource, BasisSourceRef, GraphVersionSummary } from '../../src/application/tui/graph-basis.js';
import {
  createFakePorts,
  frameText,
  makeSnapshot,
  makeWorkPackageExecution,
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

test.each(['一'.repeat(600) + '阅读位置' + '二'.repeat(600), '第一段\n\n' + '甲'.repeat(600) + '阅读位置' + '乙'.repeat(600)])('依据正文扩大窗口后保留可见来源位置', text => {
  const narrow = wrapByDisplayWidth(text, 20);
  const wide = wrapByDisplayWidth(text, 100);
  const scroll = narrow.findIndex(line => line.includes('阅读位置'));
  expect(scroll).toBeGreaterThan(wide.length);
  const next = basisReflowScroll(text, narrow, wide, scroll, 8);
  expect(wide.slice(next, next + 8).join('')).toContain('阅读位置');
});

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
    expect(frame).toContain('第一个工作包');
    expect(frame).toContain('后继 2');
    const graph=candidateGraph(),node=graph.nodes[1]!;
    expect(graphDetailRows(node,graph,1).join('\n')).toContain('src/b.ts');
    expect(graphDetailRows(node,graph,1).join('\n')).toContain('tests/**');
    expect(graphDetailRows(node,graph,2).join('\n')).toContain('graph-1 v2');
    expect(graphDetailRows(node,graph,2).join('\n')).toContain('unbound');
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

  test('窄屏仍可浏览节点邻域与详情', () => {
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
    expect(frame).toContain('第一个工作包');
    expect(frame).toContain('后继 2');
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
    expect(frame).toContain('前驱 1 第一个工作包');
    expect(frame).toContain('2 第二个工作包');

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
  test('首次检查选中真实 active 节点，多前驱显式选择，详情 Esc 分层返回', async () => {
    const topology=makeSnapshot().graphTopologies[0]!;
    const first=topology.nodes[0]!,second=topology.nodes[1]!;
    const fake=createFakePorts({snapshot:{mode:'execution_coordination',frontier:[makeWorkPackageExecution('wp-3',{state:'implementing',role:'implementation',liveness:'live'})],graphTopologies:[{...topology,nodes:[first,second,{...second,workPackageId:'wp-3',title:'运行节点',dependsOn:['wp-1','wp-2']}]}]}});
    const rendered=renderTui(fake.ports);await settle();
    rendered.stdin.write('\u0007');await settle(4);
    expect(frameText(rendered)).toContain('3 运行节点');
    rendered.stdin.write('\u001b[C');await settle(2);
    expect(frameText(rendered)).toContain('关系');
    expect(frameText(rendered)).toContain('3 运行节点');
    rendered.stdin.write('\u001b[B');await settle(2);
    rendered.stdin.write('\r');await settle(2);
    expect(frameText(rendered)).toContain('2 第二个工作包');
    rendered.stdin.write('\r');await settle(2);
    rendered.stdin.write('\t');await settle(2);
    expect(frameText(rendered)).toContain('src/b.ts');
    await pressEscape(rendered);
    expect(frameText(rendered)).toContain('Graph Inspector');
    await pressEscape(rendered);
    expect(frameText(rendered)).not.toContain('Graph Inspector');
    expect(fake.executeCount()).toBe(0);
    expect(fake.calls.filter(call=>call.name.startsWith('execution-handoff'))).toEqual([]);
    rendered.unmount();
  });
  test('Ctrl+G 打开候选图后 execute 计数为 0，Esc 逐层关闭', async () => {
    const fake = createFakePorts();
    const rendered = renderTui(fake.ports);
    await settle();

    rendered.stdin.write('\u0007');
    await settle();

    const frame = frameText(rendered);
    expect(frame).toContain('Graph Inspector');
    expect(frame).toContain('前驱 无');
    // 只读：没有 execute，也没有任何写调用。
    expect(fake.executeCount()).toBe(0);
    expect(fake.executeIntents).toEqual([]);

    await pressEscape(rendered);
    expect(frameText(rendered)).not.toContain('Graph Inspector');
    expect(fake.executeCount()).toBe(0);

    rendered.unmount();
  });
});

/* -------------------------------------------------------------------------- */
/* 图历史与执行依据（IP-04）                                                    */
/* -------------------------------------------------------------------------- */

/** 一条可证明的图版本记录；generationStatus 逐字进入目录，因此旧版本不会被笼统叫「冻结」。 */
function versionSummary(overrides: Partial<GraphVersionSummary> = {}): GraphVersionSummary {
  return {
    graphId: 'graph-1',
    generation: 1,
    version: 2,
    recordKind: 'initial',
    parentVersion: null,
    patchId: null,
    mapRevision: 3,
    planRevision: 3,
    orcaRunId: 'run-1',
    recordedAt: Date.UTC(2026, 9, 1),
    generationStatus: 'candidate',
    current: true,
    ...overrides,
  };
}

function basisSource(overrides: Partial<BasisSource> = {}): BasisSource {
  return {
    id: 'plan:graph-1:1:2',
    label: '初始 Implementation Plan',
    ref: { kind: 'initial_plan', graph: { graphId: 'graph-1', generation: 1, version: 2 } },
    sourceVersion: 'plan-3',
    unavailable: null,
    ...overrides,
  };
}

/** 历史版本的只读图投影：与当前快照同形，但不含 frontier/Worker/验收摘要。 */
function historicGraph(): GraphView {
  return projectGraphView(makeSnapshot())!;
}

function basisView(stack: ReturnType<typeof basisStack>, overrides: Partial<BasisViewModel> = {}): BasisViewModel {
  return { stack, session: 'session-a', versions: null, version: null, sources: null, body: null, notice: null, loading: false, ...overrides };
}

describe('依据下钻的纯状态转换', () => {
  test('下钻与逐层返回只改展示态，且每层保留自己的身份', () => {
    const stack = basisStack({ kind: 'inspector' });
    const withVersions = basisEnter(stack, { kind: 'versions', index: 0, after: null, previous: [] });
    const withVersion = basisEnter(withVersions, { kind: 'version', ref: { graphId: 'graph-1', generation: 1, version: 2 }, selection: 'wp-1', tab: 0, relations: null, relationIndex: 0 });
    const plan: BasisSourceRef = { kind: 'initial_plan', graph: { graphId: 'graph-1', generation: 1, version: 2 } };
    const withBody = basisEnter(withVersion, { kind: 'body', source: plan, label: '初始计划', sourceVersion: 'plan-3', offset: 0, visited: [0], scroll: 0 });

    expect(withBody.frames).toHaveLength(4);
    expect(basisTop(basisBack(withBody)!)).toEqual(withVersion.frames.at(-1));
    expect(basisTop(basisBack(withVersion)!)).toEqual(withVersions.frames.at(-1));
    // 第四层弹出根页面时返回 null，表示「回到来源页面」而不是再留一个空栈。
    expect(basisBack(basisBack(basisBack(basisBack(withBody)!)!)!)).toBeNull();

    // 读取身份包含精确图版本、工作包与来源版本：翻页与续读因此不会串页。
    expect(basisFrameKey({ kind: 'version', ref: { graphId: 'graph-1', generation: 1, version: 2 }, selection: null, tab: 0, relations: null, relationIndex: 0 })).not.toBe(
      basisFrameKey({ kind: 'version', ref: { graphId: 'graph-1', generation: 1, version: 3 }, selection: null, tab: 0, relations: null, relationIndex: 0 }),
    );
    expect(basisFrameKey({ kind: 'sources', graph: { graphId: 'graph-1', generation: 1, version: 2 }, workPackageId: null, index: 0, after: null, previous: [] })).not.toBe(
      basisFrameKey({ kind: 'sources', graph: { graphId: 'graph-1', generation: 1, version: 2 }, workPackageId: 'wp-1', index: 0, after: null, previous: [] }),
    );

    // reducer 写入只影响依据栈：协调展示态一个字段都不动。
    const before = initialTuiState;
    const after = reduceTuiState(before, { kind: 'basis-frames', frames: withBody.frames, origin: { kind: 'inspector' } });
    expect(after.basis?.frames).toEqual(withBody.frames);
    expect(after.selectedSessionId).toBe(before.selectedSessionId);
    expect(after.drafts).toEqual(before.drafts);
    expect(after.projectPanel).toEqual(before.projectPanel);
    expect(after.inspectorSelection).toBe(before.inspectorSelection);
  });
});

describe('图版本目录与历史拓扑', () => {
  test('目录逐字显示代际状态与记录来源，不把旧版本统称冻结', () => {
    const row = versionRow(versionSummary({ generationStatus: 'frozen', current: false, recordKind: 'accepted_revision', patchId: 'patch-7', version: 5, generation: 2 }));
    expect(row.title).toContain('G2·v5');
    expect(row.title).toContain('已接受修订 patch-7');
    expect(row.title).not.toContain('当前');
    expect(row.hint).toContain('代际状态 frozen');

    const current = versionRow(versionSummary());
    expect(current.title).toContain('›当前');
    expect(current.hint).toContain('代际状态 candidate');
  });

  test('历史版本只画自己的拓扑，不带当前验收摘要或 Worker', () => {
    const stack = basisStack({ kind: 'inspector' });
    const frame: BasisFrame = { kind: 'version', ref: { graphId: 'graph-1', generation: 1, version: 2 }, selection: 'wp-1', tab: 0, relations: null, relationIndex: 0 };
    const rendered = renderComponent(
      createElement(GraphBasisView, {
        view: basisView(basisEnter(stack, frame), {
          version: { key: basisFrameKey(frame), summary: versionSummary(), graph: historicGraph() },
        }),
        width: 100,
        rows: 24,
      }),
    );

    const text = frameText(rendered);
    expect(text).toContain('历史图版本');
    expect(text).toContain('第一个工作包');
    expect(text).toContain('只读历史拓扑');
    // 验收摘要是当前运行事实，历史视图里不出现。
    expect(text).not.toContain('验收');
    expect(text).toContain('运行态未记录');
    expect(text).not.toContain('unknown');
    expect(BASIS_ROOT_ENTRIES[0].key).toBe('versions');
  });

  test('所选工作包不在本版本时按证明说话，并且不自动改选别的节点', () => {
    const ref = { graphId: 'graph-1', generation: 1, version: 4 };
    const proven = retirementNote(['wp-9'], ref, 'wp-9', false);
    expect(proven).toContain('retire');
    expect(proven).toContain('v4');

    expect(retirementNote([], ref, 'wp-9', false)).toContain('退役证明不可得');
    expect(retirementNote(['wp-9'], ref, 'wp-1', true)).toBeNull();

    // 缺席的选择仍在可导航序列的首位：退役说明不会因为按方向键而消失。
    expect(basisVersionSelection(historicGraph(), 'wp-9')[0]).toBe('wp-9');
    expect(basisVersionSelection(historicGraph(), 'wp-2')).toEqual(['wp-1', 'wp-2']);
  });

  test('来源目录显示精确来源版本，缺失正文仍保留引用', () => {
    const missing = basisSource({ id: 'task:1', label: 'Task task-1 保留记录', ref: { kind: 'retained_task', workPackageId: 'wp-1', orcaTaskId: 'task-1' }, unavailable: '历史记录没有保留正文' });
    const stack = basisEnter(basisStack({ kind: 'inspector' }), { kind: 'sources', graph: { graphId: 'graph-1', generation: 1, version: 2 }, workPackageId: 'wp-1', index: 1, after: null, previous: [] });
    const rendered = renderComponent(
      createElement(GraphBasisView, {
        view: basisView(stack, { sources: { key: basisFrameKey(basisTop(stack)), session: 'session-a', items: [basisSource(), missing], nextCursor: null } }),
        width: 100,
        rows: 24,
      }),
    );

    const text = frameText(rendered);
    expect(text).toContain('初始 Implementation Plan');
    expect(text).toContain('来源版本 plan-3');
    expect(text).toContain('正文缺失：历史记录没有保留正文');
    expect(basisSourceKey(missing.ref!)).toBe('retained_task:wp-1:task-1');
  });

  test('端口未装配时只显示结构化不可用', () => {
    const rendered = renderComponent(
      createElement(GraphBasisView, { view: basisView(basisStack({ kind: 'inspector' })), width: 100, rows: 24, available: false }),
    );
    expect(frameText(rendered)).toContain('依据读取端口未接通');
  });
});


/**
 * Inspector 自述键位为「↑/↓ 选择 · ←/→ 沿依赖导航」。下面的用例断言这两个方向键真的驱动选择与上游导航；
 * 单关系直接导航，多关系由显式候选选择；选择与 overlay 返回不提交业务命令。
 */
describe('Inspector 方向键导航（IP-08 需求）', () => {
  test('↓ 选中节点、→ 沿依赖移动到上游', async () => {
    const fake = createFakePorts();
    const rendered = renderTui(fake.ports);
    await settle();

    rendered.stdin.write('\u0007');
    await settle();

    // 打开时已经选择第一个候选节点。
    expect(frameText(rendered)).toContain('1 第一个工作包');

    // ↓ 到 wp-2，帧里给出它的上游。
    rendered.stdin.write('\u001b[B');
    await settle(2);
    expect(frameText(rendered)).toContain('2 第二个工作包');
    expect(frameText(rendered)).toContain('前驱 1 第一个工作包');

    // → 沿依赖移动到上游节点 wp-1。
    rendered.stdin.write('\u001b[C');
    await settle(2);
    expect(frameText(rendered)).toContain('1 第一个工作包');
    expect(frameText(rendered)).toContain('前驱 无');

    // 导航始终只读。
    expect(fake.executeCount()).toBe(0);

    rendered.unmount();
  });
});
