/**
 * Execution Frontier 生命周期与串行 integration queue 的投影
 * （`tui/execution-monitoring` Requirement: Work Package 生命周期与串行 integration queue 投影）。
 *
 * 断言的是可观察事实：Sidebar 渲染出的片段（`[state]` / `*active` / `queue` 分区 / `reconcile <severity>`）
 * 与视图模型上的字段（`activeWorkPackageCount`、`integrationQueue`、`liveness`、`reconciliation.severity`）。
 * 生命周期与 liveness 是两个独立字段，因此这里既断言它们分别可见，也断言「不可核验」不会被读成「已退出」。
 */

import { createElement } from 'react';
import { describe, expect, test } from 'vitest';

import type { ControllerSnapshot } from '../../src/application/controller-service.js';
import { reconciliationSeverity } from '../../src/application/execution/execution-view.js';
import {
  projectTranscriptPage,
  projectTuiViewModel,
  type TuiViewModel,
} from '../../src/application/tui/view-model.js';
import { Sidebar } from '../../src/interfaces/tui/components/sidebar.js';
import {
  makeSnapshot,
  makeWorkPackageExecution,
  renderComponent,
  settle,
  type SnapshotOverrides,
} from './harness.js';

/** 显式给出图拓扑：节点顺序即编译顺序，依赖只影响缩进（不参与排序）。 */
function topology(
  entries: readonly (readonly [string, readonly string[]])[],
): ControllerSnapshot['graphTopologies'] {
  return [
    {
      graphId: 'graph-1',
      graphVersion: 2,
      generation: 1,
      nodes: entries.map(([workPackageId, dependsOn]) => ({
        workPackageId,
        title: `包 ${workPackageId}`,
        dependsOn: [...dependsOn],
        scopeEnvelope: { include: ['src/a.ts'], exclude: [] },
      })),
      readiness: { generationStatus: 'candidate', authorizationBound: false },
    },
  ];
}

function viewModelFor(snapshot: ControllerSnapshot): TuiViewModel {
  return projectTuiViewModel({
    snapshot,
    transcript: projectTranscriptPage(null, { coordinatorSessionId: null }),
    selectedSessionId: null,
    unreadSessionIds: [],
  });
}

/** 完整密度 Sidebar 的渲染文本；密度只由 `density` 决定，因此显式渲染组件而不依赖终端尺寸。 */
async function renderSidebar(snapshot: ControllerSnapshot): Promise<string> {
  const rendered = renderComponent(
    createElement(Sidebar, {
      density: 'full',
      viewModel: viewModelFor(snapshot),
      terminalWidth: 120,
    }),
  );
  await settle(2);
  return rendered.lastFrame() ?? '';
}

/** 依赖已满足的候选与依赖未满足的排队者都只能显示为 waiting/排队，不出现第二个 active。 */
const SERIAL_FRONTIER: SnapshotOverrides = {
  graphTopologies: topology([
    ['wp-1', []],
    ['wp-2', []],
    ['wp-3', ['wp-1']],
  ]),
  frontier: [
    makeWorkPackageExecution('wp-1', {
      state: 'implementing',
      role: 'implementation',
      attemptId: 'attempt-1',
      liveness: 'live',
    }),
    makeWorkPackageExecution('wp-2', { state: 'waiting' }),
    makeWorkPackageExecution('wp-3', { state: 'waiting' }),
  ],
};

describe('execution-monitoring / Work Package 生命周期与串行 integration queue 投影', () => {
  test('Scenario: 单 active Work Package 串行推进', async () => {
    const snapshot = makeSnapshot(SERIAL_FRONTIER);
    const viewModel = viewModelFor(snapshot);

    // 并发上限 1：即使有多个候选，也只有一个节点持有 Frontier 位置。
    expect(viewModel.execution.activeWorkPackageId).toBe('wp-1');
    expect(viewModel.execution.activeWorkPackageCount).toBe(1);
    expect(
      (viewModel.graph?.nodes ?? []).filter((node) => node.active).map((node) => node.workPackageId),
    ).toEqual(['wp-1']);

    const frame = await renderSidebar(snapshot);
    expect(frame).toContain('wp-1 [implementing] *active');
    expect(frame).toContain('wp-2 [waiting]');
    expect(frame).not.toContain('wp-2 [waiting] *active');
    expect(frame).not.toContain('wp-3 [waiting] *active');
  });

  test('Scenario: 完成后排队进入集成', async () => {
    const snapshot = makeSnapshot({
      graphTopologies: topology([
        ['wp-1', []],
        ['wp-2', []],
      ]),
      frontier: [
        makeWorkPackageExecution('wp-1', {
          state: 'waiting_integration',
          role: 'validator',
          attemptId: 'attempt-2',
          validation: {
            state: 'validated',
            acceptedResultRef: 'result-1',
            evidenceRefs: ['evidence-1'],
          },
          integration: { state: 'integrating', ref: 'merge-1' },
        }),
        makeWorkPackageExecution('wp-2', {
          state: 'waiting_integration',
          validation: { state: 'validated', acceptedResultRef: 'result-2', evidenceRefs: [] },
          integration: { state: 'waiting', ref: null },
        }),
      ],
    });

    const viewModel = viewModelFor(snapshot);
    // 队列顺序 = 拓扑顺序；等待集成的包不再占用 active 槽位。
    expect(viewModel.execution.integrationQueue.map((entry) => entry.workPackageId)).toEqual([
      'wp-1',
      'wp-2',
    ]);
    expect(viewModel.execution.integrationQueue.map((entry) => entry.position)).toEqual([0, 1]);
    expect(
      viewModel.execution.integrationQueue
        .filter((entry) => entry.integrating)
        .map((entry) => entry.workPackageId),
    ).toEqual(['wp-1']);
    expect(viewModel.execution.activeWorkPackageCount).toBe(0);

    const frame = await renderSidebar(snapshot);
    expect(frame).toContain('wp-1 [waiting_integration]');
    expect(frame).toContain('integration queue (串行)');
    expect(frame).toContain('queue 0 wp-1 integrating');
    expect(frame).toContain('queue 1 wp-2');
    // 串行：不会出现第二个 integrating。
    expect(frame).not.toContain('queue 1 wp-2 integrating');
  });

  test('Scenario: liveness 与生命周期分别显示', async () => {
    const snapshot = makeSnapshot({
      graphTopologies: topology([['wp-1', []]]),
      frontier: [
        makeWorkPackageExecution('wp-1', {
          state: 'implementing',
          role: 'implementation',
          attemptId: 'attempt-1',
          liveness: 'unverifiable',
        }),
      ],
      // 执行主机不可核验：Worker 名单里同样只能给出 `unverifiable`，不能推断成已退出。
      // 完整密度 Sidebar 的节点行固定 40 列（`SIDEBAR_FULL_WIDTH`），行尾的 `attempt=`/liveness 会被裁掉，
      // 因此节点级 liveness 同时断言视图模型字段；「单独显示」的可观察证据来自下方 workers 分区。
      workers: [
        {
          dispatchId: 'dispatch-1',
          workerTaskId: 'task-1',
          workPackageId: 'wp-1',
          role: 'implementation',
          liveness: 'unverifiable',
        },
      ],
    });

    const node = viewModelFor(snapshot).graph?.nodes[0];
    expect(node?.state).toBe('implementing');
    expect(node?.liveness).toBe('unverifiable');

    const frame = await renderSidebar(snapshot);
    expect(frame).toContain('[implementing]');
    expect(frame).toContain('unverifiable');
    // 不可核验既不是失败也不是已停止。
    expect(frame).not.toContain('exited');
    expect(frame).not.toContain('[blocked]');
    expect(frame).not.toContain('[cancelled]');
    expect(frame).not.toContain('已停止');
  });

  test('Scenario: 严重冲突升级为可区分状态', async () => {
    const snapshot = makeSnapshot({
      graphTopologies: topology([
        ['wp-1', []],
        ['wp-2', []],
        ['wp-3', []],
      ]),
      frontier: [
        makeWorkPackageExecution('wp-1', { state: 'reconciling' }),
        makeWorkPackageExecution('wp-2', { state: 'reconciling' }),
        makeWorkPackageExecution('wp-3', { state: 'reconciling' }),
      ],
      graphEvolution: {
        generations: [],
        revisionHolds: [],
        lineages: [],
        adoptions: [],
        reconciliations: [
          {
            reconciliationId: 'rec-1',
            workPackageId: 'wp-1',
            state: 'verified',
            severity: reconciliationSeverity('verified'),
            requiredBaselineHead: 'head-a',
            observedHead: 'head-a',
            blockerRef: null,
          },
          {
            reconciliationId: 'rec-2',
            workPackageId: 'wp-2',
            state: 'required',
            severity: reconciliationSeverity('required'),
            requiredBaselineHead: 'head-b',
            observedHead: 'head-c',
            blockerRef: null,
          },
          {
            reconciliationId: 'rec-3',
            workPackageId: 'wp-3',
            state: 'blocked',
            severity: reconciliationSeverity('blocked'),
            requiredBaselineHead: 'head-d',
            observedHead: 'head-e',
            blockerRef: 'conflict-out-of-scope',
          },
        ],
      },
    });

    const nodes = viewModelFor(snapshot).graph?.nodes ?? [];
    const reconciliationOf = (workPackageId: string) =>
      nodes.find((node) => node.workPackageId === workPackageId)?.reconciliation ?? null;
    expect(reconciliationOf('wp-1')?.severity).toBe('canonical_advance');
    expect(reconciliationOf('wp-2')?.severity).toBe('reconciliation_required');
    expect(reconciliationOf('wp-3')?.severity).toBe('conflict_escalated');
    // 升级状态带出 blocker 引用，轻微核验不带。
    expect(reconciliationOf('wp-3')?.blockerRef).toBe('conflict-out-of-scope');
    expect(reconciliationOf('wp-2')?.blockerRef).toBeNull();

    const frame = await renderSidebar(snapshot);
    // 三种严重度在界面上互相可区分。
    expect(frame).toContain('reconcile canonical_advance');
    expect(frame).toContain('reconcile reconciliation_required');
    expect(frame).toContain('reconcile conflict_escalated');
  });
});
