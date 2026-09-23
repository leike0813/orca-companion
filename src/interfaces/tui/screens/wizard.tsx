/**
 * 初始化向导：核验 → Review → 单次提交。
 *
 * 核验与提交都在 `ScopeSetupPort`：核验只读，确认后恰好调用一次初始化。这里没有 Worker Profile、
 * 预算、依赖权限、Git 集成策略或 accepted risks 的输入项——它们属于 Execution Authorization
 * Manifest。Review 期间的失败显示 blocker 并停留在向导内，不产生部分状态。
 */

import { Box, Text } from 'ink';

import { truncateToDisplayWidth } from '../render/width.js';
import type { WizardCheck, WizardProposal } from '../ports.js';

export type WizardProps = {
  /** `null` 表示核验尚未运行。 */
  readonly checks: readonly WizardCheck[] | null;
  readonly proposal: WizardProposal | null;
  /** 用户是否已按下 Review 确认；确认后由容器调用一次初始化。 */
  readonly confirmed: boolean;
  readonly blocker: string | null;
  readonly onRunChecks: () => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly availableWidth: number;
};

export const WIZARD_REVIEW_TITLE = 'Review：确认后创建 Scope、初始 Planning Cycle 与首个 Coordinator Session';

export function allChecksPassed(checks: readonly WizardCheck[] | null): boolean {
  return checks !== null && checks.length > 0 && checks.every((check) => check.ok);
}

/** 只有全部核验通过且未确认过时，才允许提交。 */
export function canConfirm(checks: readonly WizardCheck[] | null, confirmed: boolean): boolean {
  return allChecksPassed(checks) && !confirmed;
}

export function Wizard(props: WizardProps) {
  const width = Math.max(1, props.availableWidth);
  const checks = props.checks;
  return (
    <Box flexDirection="column">
      <Text>初始化向导</Text>
      {checks === null ? (
        <Text dimColor>按 r 运行核验（repository/Orca 能力与身份/Model Configuration/tracker）</Text>
      ) : (
        checks.map((check) => (
          <Text key={check.id}>
            {truncateToDisplayWidth(`${check.ok ? '✓' : '✗'} ${check.id}: ${check.detail}`, width)}
          </Text>
        ))
      )}
      {checks !== null && !allChecksPassed(checks) ? (
        <Box flexDirection="column">
          {checks
            .filter((check) => !check.ok)
            .map((check) => (
              <Text key={`failed-${check.id}`}>{`! 核验失败：${check.id}（停留在向导内，不写入任何记录）`}</Text>
            ))}
        </Box>
      ) : null}
      {props.proposal === null || !allChecksPassed(checks) ? null : (
        <Box flexDirection="column">
          <Text>{WIZARD_REVIEW_TITLE}</Text>
          <Text>{`repository: ${props.proposal.repositoryPath}`}</Text>
          <Text>{`canonical worktree: ${props.proposal.canonicalWorktree}`}</Text>
          <Text>{`scope: ${props.proposal.coordinationScopeId}`}</Text>
          <Text>{`session: ${props.proposal.coordinatorSessionId}`}</Text>
          <Text>{`model configuration: ${props.proposal.coordinatorModelConfigurationRef}`}</Text>
          <Text>{`planning cycle: ${props.proposal.planningCycleId}`}</Text>
          <Text>{`tracker: ${props.proposal.trackerRef}`}</Text>
          <Text>{confirmed2Label(props.confirmed)}</Text>
        </Box>
      )}
      {props.blocker === null ? null : <Text>{`! ${props.blocker}`}</Text>}
      <Text dimColor>
        {canConfirm(checks, props.confirmed)
          ? 'r 重新核验 · Enter 确认并创建 · Esc 退出向导'
          : 'r 重新核验 · 核验全部通过后才能确认 · Esc 退出向导'}
      </Text>
    </Box>
  );
}

function confirmed2Label(confirmed: boolean): string {
  return confirmed ? '已确认：正在以单事务创建…' : '按 Enter 确认创建（此前的步骤没有持久化）';
}
