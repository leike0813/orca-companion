/**
 * Finalizer 门禁与 Delivery Verdict 投影（IP-07，`tui/delivery-finalization`）。
 *
 * 断言的是「只有被接受的只读 Finalizer 结论才显示可交付」这一可观察事实：门禁不满足、只读无法强制、
 * 工作区在运行期间变化或没有独立结论时只呈现 blocker 与「不显示 deliverable」；成功完成时才显示运行
 * 前后 HEAD/index/dirty paths 与 Evidence 引用；被接受的 blocked 结论与 deliverable 是两个不同终态。
 *
 * Sidebar 的 full 密度只有 40 列，行尾会被裁切，因此细节事实同时读 `finalizerRows` 与加宽后的
 * `FinalizerPanel` 渲染；「不显示交付结论」一律断言稳定片段 `verdict deliverable` 不出现（
 * `不显示 deliverable` 这一提示本身是允许出现的负面表述）。
 */

import { describe, expect, test } from 'vitest';

import type { FinalizerView } from '../../src/application/execution/execution-view.js';
import {
  projectTranscriptPage,
  projectTuiViewModel,
  type TuiViewModel,
} from '../../src/application/tui/view-model.js';
import {
  FinalizerPanel,
  finalizerRows,
} from '../../src/interfaces/tui/components/finalizer-panel.js';
import { Sidebar } from '../../src/interfaces/tui/components/sidebar.js';
import {
  frameText,
  makeFinalizer,
  makeSnapshot,
  makeTranscript,
  makeWorkPackageExecution,
  renderComponent,
  type RenderedTui,
  type SnapshotOverrides,
} from './harness.js';

/** Deliverable 结论文本；它是「项目可交付」的唯一表达，任何未满足的条件都不得让它出现。 */
const DELIVERABLE = 'verdict deliverable';

function viewFor(finalizer: FinalizerView, overrides: SnapshotOverrides): TuiViewModel {
  return projectTuiViewModel({
    snapshot: makeSnapshot({ finalizer, ...overrides }),
    transcript: projectTranscriptPage(makeTranscript('session-a'), {
      coordinatorSessionId: 'session-a',
    }),
    selectedSessionId: 'session-a',
    unreadSessionIds: [],
  });
}

/** Sidebar 的 full 密度渲染：Finalizer 分区就在其中。 */
function renderSidebar(finalizer: FinalizerView, overrides: SnapshotOverrides = {}): RenderedTui {
  return renderComponent(
    <Sidebar density="full" viewModel={viewFor(finalizer, overrides)} terminalWidth={100} />,
  );
}

/** 加宽后的 Finalizer 面板：用于断言被 40 列裁掉的运行前后事实与 Evidence 引用。 */
function renderPanel(finalizer: FinalizerView): RenderedTui {
  return renderComponent(<FinalizerPanel finalizer={finalizer} availableWidth={200} />);
}

describe('delivery-finalization / Finalizer 门禁与 Delivery Verdict 投影', () => {
  test('Scenario: 只读无法强制时阻塞', () => {
    const finalizer = makeFinalizer({
      readOnlyProfile: 'unenforceable',
      gate: { ready: false, blockers: ['finalizer-read-only-not-enforceable'] },
    });

    const rows = finalizerRows(finalizer).join('\n');
    expect(rows).toContain('read-only 无法强制');
    expect(rows).toContain('finalizer-read-only-not-enforceable');
    expect(rows).not.toContain(DELIVERABLE);

    const frame = frameText(renderSidebar(finalizer));
    expect(frame).toContain('read-only 无法强制');
    expect(frame).toContain('finalizer-read-only-not-enforceable');
    expect(frame).not.toContain(DELIVERABLE);
  });

  test('Scenario: 工作区在运行期间变化', () => {
    const finalizer = makeFinalizer({
      readOnlyProfile: 'enforced',
      integrationFrozen: 'frozen',
      gate: { ready: false, blockers: ['finalizer-workspace-changed'] },
      workspace: {
        before: { head: 'head-a', indexRevision: 'idx-1', dirtyPaths: [] },
        after: { head: 'head-b', indexRevision: 'idx-1', dirtyPaths: ['src/a.ts'] },
      },
    });

    const rows = finalizerRows(finalizer).join('\n');
    expect(rows).toContain('finalizer-workspace-changed');
    expect(rows).toContain('before HEAD head-a');
    expect(rows).toContain('after HEAD head-b');
    expect(rows).not.toContain(DELIVERABLE);

    const panel = frameText(renderPanel(finalizer));
    // 变化是可见的事实：前后 HEAD 不同、dirty paths 非空。
    expect(panel).toContain('before HEAD head-a');
    expect(panel).toContain('after HEAD head-b');
    expect(panel).toContain('dirty src/a.ts');
    expect(panel).not.toContain(DELIVERABLE);

    const sidebar = frameText(renderSidebar(finalizer));
    expect(sidebar).toContain('finalizer-workspace-changed');
    expect(sidebar).not.toContain(DELIVERABLE);
  });

  test('Scenario: 成功完成后显示证据', () => {
    const finalizer = makeFinalizer({
      readOnlyProfile: 'enforced',
      integrationFrozen: 'frozen',
      gate: { ready: true, blockers: [] },
      coversWorkPackageIds: ['wp-1', 'wp-2'],
      worktreePath: '/wt/canonical',
      workspace: {
        before: { head: 'head-a', indexRevision: 'idx-1', dirtyPaths: [] },
        after: { head: 'head-a', indexRevision: 'idx-1', dirtyPaths: [] },
      },
      evidenceRefs: ['evidence-suite'],
      verdict: {
        verdictId: 'verdict-1',
        kind: 'deliverable',
        refs: ['evidence-suite', 'evidence-lint'],
        sessionBindingRef: 'binding-finalizer',
        recordedAt: 42,
      },
    });

    const rows = finalizerRows(finalizer).join('\n');
    expect(rows).toContain('before HEAD head-a · index idx-1 · dirty clean');
    expect(rows).toContain('after HEAD head-a · index idx-1 · dirty clean');
    expect(rows).toContain('verdict deliverable');
    expect(rows).toContain('evidence-suite');
    expect(rows).toContain('evidence-lint');
    // 结论必须绑定到记录本身，而不是匿名的一个「成功」。
    expect(rows).toContain('verdictRecording verdict-1 · session binding-finalizer');

    const panel = frameText(renderPanel(finalizer));
    expect(panel).toContain('covers wp-1,wp-2');
    expect(panel).toContain('worktree /wt/canonical');
    expect(panel).toContain('read-only enforced');
    expect(panel).toContain('integration frozen');
    expect(panel).toContain('before HEAD head-a');
    expect(panel).toContain('after HEAD head-a');
    expect(panel).toContain('verdict deliverable');

    const sidebar = frameText(renderSidebar(finalizer));
    expect(sidebar).toContain('before HEAD head-a');
    expect(sidebar).toContain('after HEAD head-a');
    expect(sidebar).toContain(DELIVERABLE);
  });

  test('Scenario: 单包验证通过不等于可交付', () => {
    const finalizer = makeFinalizer({
      readOnlyProfile: 'enforced',
      integrationFrozen: 'frozen',
      gate: { ready: true, blockers: [] },
      coversWorkPackageIds: ['wp-1'],
      verdict: null,
    });
    const frontier = [
      makeWorkPackageExecution('wp-1', {
        state: 'accepted',
        validation: {
          state: 'validated',
          acceptedResultRef: 'result-1',
          evidenceRefs: ['evidence-validation'],
        },
        integration: { state: 'integrated', ref: 'integration-1' },
      }),
    ];

    const rows = finalizerRows(finalizer).join('\n');
    expect(rows).toContain('verdict 未返回（不显示 deliverable）');
    expect(rows).not.toContain(DELIVERABLE);

    const rendered = renderSidebar(finalizer, { frontier });
    const frame = frameText(rendered);
    // 三种事实各自可见：包已接受、单包 validation 通过、只缺独立 Finalizer 结论。
    expect(frame).toContain('wp-1 [accepted]');
    expect(frame).toContain('validation validated');
    expect(frame).toContain('integration integrated');
    expect(frame).toContain('不显示 deliverable');
    expect(frame).not.toContain(DELIVERABLE);
  });

  test('Scenario: blocker 结论明确呈现', () => {
    const blocked = makeFinalizer({
      readOnlyProfile: 'enforced',
      integrationFrozen: 'frozen',
      gate: { ready: true, blockers: [] },
      verdict: {
        verdictId: 'verdict-2',
        kind: 'blocked',
        refs: ['blocker-finalizer-unresolved'],
        sessionBindingRef: 'binding-finalizer',
        recordedAt: 43,
      },
    });

    const rows = finalizerRows(blocked).join('\n');
    expect(rows).toContain('verdict blocked · blocker-finalizer-unresolved');
    expect(rows).not.toContain(DELIVERABLE);

    const panel = frameText(renderPanel(blocked));
    expect(panel).toContain('verdict blocked');
    expect(panel).toContain('blocker-finalizer-unresolved');
    expect(panel).not.toContain(DELIVERABLE);

    const sidebar = frameText(renderSidebar(blocked));
    expect(sidebar).toContain('verdict blocked');
    expect(sidebar).not.toContain(DELIVERABLE);

    // blocked 与 deliverable 是两个不同终态，不会因为「有结论」就都读成可交付。
    const deliverable = makeFinalizer({
      verdict: {
        verdictId: 'verdict-2',
        kind: 'deliverable',
        refs: ['evidence-suite'],
        sessionBindingRef: 'binding-finalizer',
        recordedAt: 44,
      },
    });
    expect(finalizerRows(blocked).join('\n')).not.toBe(finalizerRows(deliverable).join('\n'));
    expect(finalizerRows(deliverable).join('\n')).toContain(DELIVERABLE);
  });
});
