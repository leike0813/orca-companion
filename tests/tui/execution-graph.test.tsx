/**
 * 执行图与 Frontier 投影（`tui/execution-monitoring`，Owner: `m2-deliver-execution-tui`）。
 *
 * 断言的是用户可观察事实：节点位置来自编译后的稳定拓扑，状态推进（implementing → validating）只更新
 * 状态标识而**不重排**；折叠态只渲染折叠标记、不渲染（也不计算）不可见详情；状态过滤只把不匹配的节点
 * 置为 `hidden`，其余节点的位置与相对顺序不变；并发上限为 1，界面最多把一个 Work Package 显示为 active。
 *
 * 布局与过滤都是纯函数，因此先直接断言 `projectGraphView`/`layoutExecutionGraph` 的事实，再渲染一次
 * `Sidebar`/`Workspace` 确认同样的顺序出现在界面上——避免只断言投影、不验证渲染。
 */

import { describe, expect, test } from 'vitest';

import type {
  ControllerFrontierEntry,
  ControllerGraphNodeView,
  ControllerSnapshot,
} from '../../src/application/controller-service.js';
import {
  projectGraphView,
  projectTranscriptPage,
  projectTuiViewModel,
  type ExecutionFilter,
  type TuiViewModel,
} from '../../src/application/tui/view-model.js';
import { COMMAND_IDS } from '../../src/interfaces/tui/components/command-palette.js';
import { SIDEBAR_COLLAPSED_MARKER, Sidebar } from '../../src/interfaces/tui/components/sidebar.js';
import type { ModelCatalog } from '../../src/interfaces/tui/ports.js';
import { layoutExecutionGraph, visibleRows } from '../../src/interfaces/tui/render/graph-layout.js';
import { Workspace, type WorkspaceActions } from '../../src/interfaces/tui/screens/workspace.js';
import { initialTuiState, type SidebarDensity, type TuiState } from '../../src/interfaces/tui/state.js';
import {
  makeSnapshot,
  makeTranscript,
  makeWorkPackageExecution,
  renderComponent,
  settle,
  type RenderedTui,
} from './harness.js';

/* -------------------------------------------------------------------------- */
/* fixture                                                                     */
/* -------------------------------------------------------------------------- */

/** 三个节点的编译拓扑：wp-2 依赖 wp-1，wp-3 独立；顺序即稳定位置。 */
const TOPOLOGY: readonly ControllerGraphNodeView[] = [
  {
    workPackageId: 'wp-1',
    title: '第一个工作包',
    dependsOn: [],
    scopeEnvelope: { include: ['src/a.ts'], exclude: [] },
  },
  {
    workPackageId: 'wp-2',
    title: '第二个工作包',
    dependsOn: ['wp-1'],
    scopeEnvelope: { include: ['src/b.ts'], exclude: [] },
  },
  {
    workPackageId: 'wp-3',
    title: '第三个工作包',
    dependsOn: [],
    scopeEnvelope: { include: ['src/c.ts'], exclude: [] },
  },
];

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
  closeTopOverlay: () => undefined,
};

const MODEL_CATALOG: ModelCatalog = {
  options: [{ configurationRef: 'config-a', model: 'model-a' }],
  currentConfigurationRef: 'config-a',
  switchable: true,
  switchBlockReason: null,
};

function graphSnapshot(frontier: readonly ControllerFrontierEntry[]): ControllerSnapshot {
  return makeSnapshot({
    mode: 'execution_coordination',
    graphTopologies: [
      {
        graphId: 'graph-1',
        graphVersion: 2,
        generation: 1,
        nodes: TOPOLOGY,
        readiness: { generationStatus: 'candidate', authorizationBound: true },
      },
    ],
    frontier,
  });
}

function viewFor(snapshot: ControllerSnapshot, filter: ExecutionFilter = []): TuiViewModel {
  return projectTuiViewModel({
    snapshot,
    transcript: projectTranscriptPage(makeTranscript('session-a'), { coordinatorSessionId: 'session-a' }),
    selectedSessionId: 'session-a',
    unreadSessionIds: [],
    executionFilter: filter,
  });
}

function renderSidebar(
  snapshot: ControllerSnapshot,
  density: SidebarDensity = 'full',
  filter: ExecutionFilter = [],
): RenderedTui {
  return renderComponent(
    <Sidebar density={density} viewModel={viewFor(snapshot, filter)} terminalWidth={100} />,
  );
}

function renderWorkspace(snapshot: ControllerSnapshot, filter: ExecutionFilter = []): RenderedTui {
  const ui: TuiState = {
    ...initialTuiState,
    screen: 'workspace',
    selectedSessionId: 'session-a',
    executionFilter: filter,
  };
  return renderComponent(
    <Workspace
      viewModel={viewFor(snapshot, filter)}
      ui={ui}
      terminalWidth={100}
      events={[]}
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

/** 顶栏/侧栏渲染出的 Work Package 详情行；按节点顺序取出 id。 */
function nodeIds(frame: string): readonly string[] {
  return frame
    .split('\n')
    .map((line) => /(wp-\d+) \[/.exec(line)?.[1])
    .filter((id): id is string => id !== undefined);
}

/** 某节点的完整详情块：从状态行到下一个节点行之前的全部渲染行。 */
function nodeBlock(frame: string, workPackageId: string): readonly string[] {
  const lines = frame.split('\n');
  const start = lines.findIndex((line) => line.includes(`${workPackageId} [`));
  if (start === -1) {
    return [];
  }
  const block = [lines[start] ?? ''];
  for (const line of lines.slice(start + 1)) {
    if (/(wp-\d+) \[/.test(line)) {
      break;
    }
    block.push(line);
  }
  return block;
}

/**
 * 节点在界面上的位置：详情行号 + 行内起始列。
 *
 * 不能比较整个 frame 里的字符偏移——状态文案变短会让后面所有行的偏移前移，那不是重排。
 */
function nodePlacement(frame: string, workPackageId: string): readonly [number, number] {
  const lines = frame.split('\n');
  const rowIndex = lines.findIndex((line) => line.includes(`${workPackageId} [`));
  const column = rowIndex === -1 ? -1 : (lines[rowIndex] ?? '').indexOf(workPackageId);
  return [rowIndex, column];
}

/* -------------------------------------------------------------------------- */
/* Scenario                                                                    */
/* -------------------------------------------------------------------------- */

describe('execution-monitoring / 执行图与 Frontier 投影', () => {
  test('Scenario: 状态变化不重排节点', async () => {
    const implementing = graphSnapshot([
      makeWorkPackageExecution('wp-1', {
        state: 'implementing',
        role: 'implementation',
        attemptId: 'attempt-1',
        liveness: 'live',
      }),
      makeWorkPackageExecution('wp-2', { state: 'waiting' }),
      makeWorkPackageExecution('wp-3', { state: 'waiting' }),
    ]);
    const validating = graphSnapshot([
      makeWorkPackageExecution('wp-1', {
        state: 'validating',
        role: 'validator',
        attemptId: 'attempt-1',
        liveness: 'live',
      }),
      makeWorkPackageExecution('wp-2', { state: 'waiting' }),
      makeWorkPackageExecution('wp-3', { state: 'waiting' }),
    ]);

    // 位置与依赖深度只由编译拓扑决定，与状态无关。
    const layoutOf = (snapshot: ControllerSnapshot): readonly (readonly [string, number, number])[] =>
      layoutExecutionGraph(projectGraphView(snapshot)?.nodes ?? []).map((row) => [
        row.workPackageId,
        row.position,
        row.depth,
      ]);
    expect(layoutOf(implementing)).toEqual([
      ['wp-1', 0, 0],
      ['wp-2', 1, 1],
      ['wp-3', 2, 0],
    ]);
    expect(layoutOf(validating)).toEqual(layoutOf(implementing));

    const before = renderWorkspace(implementing);
    const after = renderWorkspace(validating);
    await settle(2);
    const beforeFrame = before.lastFrame() ?? '';
    const afterFrame = after.lastFrame() ?? '';

    // 只有状态标识更新。
    expect(beforeFrame).toContain('wp-1 [implementing]');
    expect(afterFrame).toContain('wp-1 [validating]');
    expect(afterFrame).not.toContain('[implementing]');
    // 节点位置与相对顺序不变：详情行号与行内列偏移完全一致，行数也不变。
    expect(nodeIds(afterFrame)).toEqual(['wp-1', 'wp-2', 'wp-3']);
    expect(afterFrame.split('\n')).toHaveLength(beforeFrame.split('\n').length);
    for (const workPackageId of ['wp-1', 'wp-2', 'wp-3']) {
      const placement = nodePlacement(beforeFrame, workPackageId);
      expect(placement[0]).toBeGreaterThan(0);
      expect(nodePlacement(afterFrame, workPackageId)).toEqual(placement);
    }
    expect(afterFrame.indexOf('wp-1')).toBeLessThan(afterFrame.indexOf('wp-2'));

    before.unmount();
    after.unmount();
  });

  test('Scenario: 折叠态不计算详情', async () => {
    const snapshot = graphSnapshot([
      makeWorkPackageExecution('wp-1', {
        state: 'implementing',
        role: 'implementation',
        attemptId: 'attempt-1',
        liveness: 'live',
        worktreePath: '/tmp/worktrees/wp-1',
        baselineHead: 'head-1',
      }),
      makeWorkPackageExecution('wp-2', { state: 'waiting_integration' }),
      makeWorkPackageExecution('wp-3', { state: 'blocked', blockerRefs: ['blocker-1'] }),
    ]);

    // 先确认同一份 view model 在全密度下确实有详情，否则折叠态断言可能是空的。
    const full = renderSidebar(snapshot, 'full');
    await settle(2);
    const fullFrame = full.lastFrame() ?? '';
    expect(fullFrame).toContain('execution graph');
    expect(fullFrame).toContain('integration queue (串行)');
    expect(fullFrame).toContain('wp-1');
    expect(fullFrame).toContain('role=');
    expect(fullFrame).toContain('finalizer');

    const collapsed = renderSidebar(snapshot, 'collapsed');
    await settle(2);
    const collapsedFrame = collapsed.lastFrame() ?? '';
    expect(collapsedFrame).toContain(SIDEBAR_COLLAPSED_MARKER);
    // 折叠态不渲染任何 Work Package / 队列 / Finalizer 详情。
    for (const hidden of ['wp-1', 'wp-2', 'wp-3', 'role=', 'execution graph', 'integration queue', 'finalizer']) {
      expect(collapsedFrame).not.toContain(hidden);
    }

    full.unmount();
    collapsed.unmount();
  });

  test('Scenario: 过滤只隐藏节点', async () => {
    const snapshot = graphSnapshot([
      makeWorkPackageExecution('wp-1', { state: 'implementing', role: 'implementation' }),
      makeWorkPackageExecution('wp-2', { state: 'validating', role: 'validator' }),
      makeWorkPackageExecution('wp-3', { state: 'waiting_integration' }),
    ]);
    const unfiltered = projectGraphView(snapshot);
    const filter: ExecutionFilter = ['implementing', 'waiting_integration'];
    const filtered = projectGraphView(snapshot, filter);
    expect(unfiltered).not.toBeNull();
    expect(filtered).not.toBeNull();

    // 节点集合、位置与相对顺序都不变，过滤只改变 `hidden`。
    expect(filtered?.nodes.map((node) => node.workPackageId)).toEqual(['wp-1', 'wp-2', 'wp-3']);
    expect(filtered?.nodes.map((node) => node.position)).toEqual(
      unfiltered?.nodes.map((node) => node.position),
    );
    expect(filtered?.nodes.map((node) => node.hidden)).toEqual([false, true, false]);
    expect(unfiltered?.nodes.map((node) => node.hidden)).toEqual([false, false, false]);

    // 隐藏中间节点不会让后面的节点提前：位置仍是编译位置 2。
    const visible = visibleRows(layoutExecutionGraph(filtered?.nodes ?? []));
    expect(visible.map((row) => row.workPackageId)).toEqual(['wp-1', 'wp-3']);
    expect(visible.map((row) => row.position)).toEqual([0, 2]);

    // 界面上同样只少了被隐藏的节点，其余节点行逐字不变。
    const unfilteredRender = renderSidebar(snapshot);
    const filteredRender = renderSidebar(snapshot, 'full', filter);
    await settle(2);
    const unfilteredFrame = unfilteredRender.lastFrame() ?? '';
    const filteredFrame = filteredRender.lastFrame() ?? '';
    expect(nodeIds(unfilteredFrame)).toEqual(['wp-1', 'wp-2', 'wp-3']);
    expect(nodeIds(filteredFrame)).toEqual(['wp-1', 'wp-3']);
    expect(filteredFrame).not.toContain('wp-2');
    // 其余节点的完整详情块逐行不变：过滤没有改写任何未隐藏的节点。
    expect(nodeBlock(filteredFrame, 'wp-1')).toEqual(nodeBlock(unfilteredFrame, 'wp-1'));
    expect(nodeBlock(filteredFrame, 'wp-3')).toEqual(nodeBlock(unfilteredFrame, 'wp-3'));

    unfilteredRender.unmount();
    filteredRender.unmount();
  });

  test('Scenario: 并发上限为 1', async () => {
    const snapshot = graphSnapshot([
      makeWorkPackageExecution('wp-1', {
        state: 'implementing',
        role: 'implementation',
        attemptId: 'attempt-1',
        liveness: 'live',
      }),
      // 依赖已满足的其它候选：只能排队，不能同时 active。
      makeWorkPackageExecution('wp-2', { state: 'waiting' }),
      makeWorkPackageExecution('wp-3', { state: 'waiting' }),
    ]);

    const view = viewFor(snapshot);
    expect(view.execution.activeWorkPackageId).toBe('wp-1');
    expect(view.execution.activeWorkPackageCount).toBe(1);
    expect(view.graph?.nodes.filter((node) => node.active).map((node) => node.workPackageId)).toEqual([
      'wp-1',
    ]);
    // waiting 既不是 active 也不是完成：其余候选如实显示为排队/等待。
    expect(view.graph?.nodes.filter((node) => node.state === 'waiting')).toHaveLength(2);

    // 没有 active 时计数为 0，绝不会出现 2。
    const idle = viewFor(graphSnapshot([makeWorkPackageExecution('wp-3', { state: 'waiting' })]));
    expect(idle.execution.activeWorkPackageId).toBeNull();
    expect(idle.execution.activeWorkPackageCount).toBe(0);

    const rendered = renderSidebar(snapshot);
    await settle(2);
    const frame = rendered.lastFrame() ?? '';
    // 界面上最多一个 `*active` 标记，其余候选显示为 waiting。
    expect(frame.split('*active').length - 1).toBe(1);
    expect(frame).toContain('wp-1 [implementing] *active');
    expect(frame).toContain('wp-2 [waiting]');
    expect(frame).toContain('wp-3 [waiting]');

    rendered.unmount();
  });
});
