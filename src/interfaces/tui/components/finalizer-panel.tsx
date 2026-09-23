/**
 * Finalizer 面板（IP-07）。
 *
 * 它只复述投影出来的事实：门禁、只读 Profile、集成冻结、canonical worktree、运行前后 HEAD/index/
 * dirty paths 与项目级 Evidence，以及最近一次**被接受**的 Delivery Verdict。
 *
 * 硬边界：门禁不满足、只读无法强制或工作区在运行期间变化时只呈现 blocker；没有独立结论时不显示
 * deliverable——「实现完成」「单包验证通过」与「项目可交付」是三个不同事实（D7）。
 */

import { Box, Text } from 'ink';

import { truncateToDisplayWidth } from '../render/width.js';
import type { FinalizerView } from '../../../application/execution/execution-view.js';

export type FinalizerPanelProps = {
  readonly finalizer: FinalizerView;
  readonly availableWidth: number;
};

const READ_ONLY_LABEL = {
  enforced: 'read-only enforced',
  unenforceable: 'read-only 无法强制',
  unverified: 'read-only 未核验',
} as const;

const FROZEN_LABEL = {
  frozen: 'integration frozen',
  unknown: 'integration 冻结状态未知',
} as const;

function workspaceLine(
  label: string,
  facts: { readonly head: string; readonly indexRevision: string; readonly dirtyPaths: readonly string[] },
): string {
  const dirty = facts.dirtyPaths.length === 0 ? 'clean' : facts.dirtyPaths.join(',');
  return `${label} HEAD ${facts.head} · index ${facts.indexRevision} · dirty ${dirty}`;
}

/**
 * Finalizer 面板的行；纯函数，便于断言「门禁不满足只显示 blocker」与「成功时显示前后工作区与证据」。
 */
export function finalizerRows(finalizer: FinalizerView): readonly string[] {
  const rows: string[] = [
    `gate ${finalizer.gate.ready ? 'ready' : 'not ready'} · ${READ_ONLY_LABEL[finalizer.readOnlyProfile]} · ${FROZEN_LABEL[finalizer.integrationFrozen]}`,
    `worktree ${finalizer.worktreePath ?? '未记录'}`,
    `covers ${finalizer.coversWorkPackageIds.length === 0 ? 'none' : finalizer.coversWorkPackageIds.join(',')}`,
  ];
  if (finalizer.workspace !== null) {
    rows.push(workspaceLine('before', finalizer.workspace.before));
    rows.push(workspaceLine('after', finalizer.workspace.after));
  } else {
    rows.push('workspace 运行前后事实未记录');
  }
  for (const blocker of finalizer.gate.blockers) {
    rows.push(`! ${blocker}`);
  }
  // 项目级 Evidence 与被接受的结论是两件事：只要读到就展示，不再等 verdict 才间接出现。
  if (finalizer.evidenceRefs.length > 0) {
    rows.push(`evidence ${finalizer.evidenceRefs.join(',')}`);
  }
  const verdict = finalizer.verdict;
  if (verdict === null) {
    // 没有独立结论时不显示 deliverable：全部包验证通过与项目可交付是两个事实。
    rows.push('verdict 未返回（不显示 deliverable）');
    return rows;
  }
  rows.push(
    verdict.kind === 'deliverable'
      ? `verdict deliverable · evidence ${verdict.refs.join(',') || 'none'}`
      : `verdict blocked · ${verdict.refs.join(',') || 'none'}`,
  );
  rows.push(`verdictRecording ${verdict.verdictId} · session ${verdict.sessionBindingRef}`);
  return rows;
}

export function FinalizerPanel(props: FinalizerPanelProps) {
  return (
    <Box flexDirection="column">
      <Text dimColor>finalizer</Text>
      {finalizerRows(props.finalizer).map((row, index) => (
        <Text key={`finalizer-${String(index)}`}>
          {truncateToDisplayWidth(row, Math.max(1, props.availableWidth))}
        </Text>
      ))}
    </Box>
  );
}
