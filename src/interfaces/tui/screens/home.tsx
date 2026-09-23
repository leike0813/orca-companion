/**
 * Home：Scope 恢复入口。
 *
 * 它只呈现 Home 解析结果：唯一 Scope 直接恢复、多个 Scope 要求显式选择、零个进入向导、失败显示
 * blocker。解析本身在 `ScopeSetupPort`，界面不查询 store，也不按 branch ref 猜测身份。
 */

import { Box, Text } from 'ink';

import { truncateToDisplayWidth } from '../render/width.js';
import type { HomeResolution } from '../ports.js';

export type HomeProps = {
  /** `null` 表示解析尚未返回；界面显示载入态而不是假设「没有 Scope」。 */
  readonly resolution: HomeResolution | null;
  /** 旧记录候选列表里的选中项；Review 只作用于它。 */
  readonly selectedIndex?: number;
  /** 是否已打开迁移 Review。未确认前界面不进入任何 Scope。 */
  readonly reviewingLegacy?: boolean;
  /** 迁移被拒绝时的结构化原因；Review 内展示。 */
  readonly notice?: string | null;
  readonly onStartWizard: () => void;
  readonly availableWidth: number;
};

export function Home(props: HomeProps) {
  const width = Math.max(1, props.availableWidth);
  if (props.resolution === null) {
    return (
      <Box flexDirection="column">
        <Text>Orca Companion</Text>
        <Text dimColor>正在解析当前仓库的 Coordination Scope…</Text>
      </Box>
    );
  }
  const resolution = props.resolution;
  switch (resolution.kind) {
    case 'restore':
      return (
        <Box flexDirection="column">
          <Text>{`恢复 Coordination Scope ${resolution.coordinationScopeId}`}</Text>
        </Box>
      );
    case 'legacy': {
      const selected = resolution.candidates[Math.min(props.selectedIndex ?? 0, resolution.candidates.length - 1)];
      if (props.reviewingLegacy === true && selected !== undefined) {
        return (
          <Box flexDirection="column">
            <Text>旧 Coordination Scope 迁移 Review</Text>
            <Text>{truncateToDisplayWidth(`Scope: ${selected.coordinationScopeId}`, width)}</Text>
            <Text>{truncateToDisplayWidth(`full branch ref: ${resolution.binding.fullBranchRef}`, width)}</Text>
            <Text>
              {truncateToDisplayWidth(
                `canonical worktree: ${resolution.binding.canonicalWorktreePath}`,
                width,
              )}
            </Text>
            <Text dimColor>确认后登记为不可改写的一次性绑定；未确认前不会进入该 Scope。</Text>
            {props.notice === null || props.notice === undefined ? null : <Text>{`! ${props.notice}`}</Text>}
            <Text>Enter 确认迁移 · Esc 返回候选列表</Text>
          </Box>
        );
      }
      return (
        <Box flexDirection="column">
          <Text>发现缺少身份绑定的旧 Coordination Scope：需要你确认一次性迁移</Text>
          {resolution.candidates.map((candidate, index) => (
            <Text key={candidate.coordinationScopeId}>
              {truncateToDisplayWidth(
                `${index === (props.selectedIndex ?? 0) ? '▸' : '-'} ${candidate.coordinationScopeId} · ${candidate.mode} · ${candidate.controlState}`,
                width,
              )}
            </Text>
          ))}
          <Text dimColor>↑↓ 选择 · Enter 打开迁移 Review · 未确认前不会进入任何 Scope</Text>
          {props.notice === null || props.notice === undefined ? null : <Text>{`! ${props.notice}`}</Text>}
        </Box>
      );
    }
    case 'wizard':
      return (
        <Box flexDirection="column">
          <Text>当前仓库还没有 Coordination Scope。</Text>
          <Text>按 n 进入初始化向导（在 Review 确认之前不会写入任何记录）。</Text>
        </Box>
      );
    case 'failed':
      return (
        <Box flexDirection="column">
          <Text>{`! ${resolution.code}: ${resolution.message}`}</Text>
          <Text dimColor>Scope 解析失败：请修复后重新启动，界面不会自行推断。</Text>
        </Box>
      );
  }
}
