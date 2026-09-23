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
  readonly onSelectScope: (coordinationScopeId: string) => void;
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
    case 'choose':
      return (
        <Box flexDirection="column">
          <Text>发现多个 Coordination Scope：请显式选择一个（不会自动创建）</Text>
          {resolution.candidates.map((candidate) => (
            <Text key={candidate.coordinationScopeId}>
              {truncateToDisplayWidth(
                `- ${candidate.coordinationScopeId} · ${candidate.mode} · ${candidate.controlState}`,
                width,
              )}
            </Text>
          ))}
        </Box>
      );
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
