/**
 * Execution Authorization Review：完整 Manifest 的审阅与一次显式批准。
 *
 * 界面只显示宿主读好的字段：它不组装 Manifest、不计算指纹、也不提供「跳过缺口」的路径。门禁未通过
 * 或事实不可读时只显示 blocker，批准入口随之关闭（fail closed 由用例决定，界面不发明替代方案）。
 */

import { Box, Text } from 'ink';

import { truncateToDisplayWidth } from '../render/width.js';
import type { ExecutionAuthorizationLoad } from '../ports.js';

export type AuthorizationReviewProps = {
  /** `null` 表示审阅结果尚未加载：此时不显示任何可批准的内容。 */
  readonly review: ExecutionAuthorizationLoad | null;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly availableWidth: number;
};

/** 审阅展示行：先给结论与门禁，再逐项列出 Manifest，最后是绑定指纹。 */
export function authorizationReviewRows(load: ExecutionAuthorizationLoad): readonly string[] {
  if (load.kind !== 'review') {
    return [`! ${load.code}: ${load.message}`];
  }
  const { review } = load;
  return [
    `graph ${review.candidate.graphId} v${String(review.candidate.version)} · ${String(review.candidate.workPackageCount)} 个 Work Package`,
    `baseline ${review.candidate.baselineHead}`,
    `scopeRevision ${String(review.scopeRevision)}`,
    ...review.manifestRows.map((row) => `${row.label}: ${row.value}`),
    `fingerprint ${review.fingerprint}`,
  ];
}

/** 只有「审阅成功且门禁通过」时才允许批准。 */
export function authorizationApprovable(load: ExecutionAuthorizationLoad | null): boolean {
  return load !== null && load.kind === 'review' && load.review.gate.ready;
}

export function AuthorizationReview(props: AuthorizationReviewProps) {
  const load = props.review;
  const rows = load === null ? [] : authorizationReviewRows(load);
  const gate = load !== null && load.kind === 'review' ? load.review.gate : null;
  return (
    <Box flexDirection="column" borderStyle="single">
      <Text>Execution Authorization Review</Text>
      {load === null ? <Text dimColor>正在读取当前规划产物…</Text> : null}
      {rows.map((row) => (
        <Text key={row}>{truncateToDisplayWidth(row, Math.max(1, props.availableWidth))}</Text>
      ))}
      {gate === null ? null : gate.ready ? (
        <Text>门禁: 通过</Text>
      ) : (
        gate.blockers.map((blocker) => <Text key={blocker}>{`! 门禁未通过: ${blocker}`}</Text>)
      )}
      {authorizationApprovable(load) ? (
        <Text dimColor>Enter 批准并进入 Execution Coordination · Esc 取消</Text>
      ) : (
        <Text dimColor>当前不可批准（fail closed）· Esc 关闭</Text>
      )}
    </Box>
  );
}
