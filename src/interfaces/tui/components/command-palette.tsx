/**
 * Command Palette：全局命令入口。
 *
 * 它只列出命令并回调一个稳定 id；真正的动作由工作区映射到 IC-11 命令或展示态变化。`/compact` 的
 * fail-closed 语义在控制器装配层，不在界面层。
 */

import { Box, Text } from 'ink';

import { truncateToDisplayWidth } from '../render/width.js';

export const COMMAND_IDS = [
  'compact',
  'model-picker',
  'handoff',
  'session-picker',
  'event-drawer',
  'graph-inspector',
  'toggle-sidebar',
  'pause',
  'resume',
  'cancel',
  'help',
] as const;

export type CommandId = (typeof COMMAND_IDS)[number];

export type CommandPaletteProps = {
  readonly commands: readonly CommandId[];
  readonly selectedIndex: number;
  readonly onRun: (command: CommandId) => void;
  readonly availableWidth: number;
};

export const COMMAND_LABELS: Readonly<Record<CommandId, string>> = {
  compact: '/compact 手动压缩该 Session',
  'model-picker': 'Model Picker 切换 Coordinator Model Configuration',
  handoff: 'Route Planning Handoff（prepare → review → cutover）',
  'session-picker': 'Session Picker',
  'event-drawer': 'Event Drawer',
  'graph-inspector': 'Graph Inspector',
  'toggle-sidebar': '切换 Sidebar 密度',
  pause: 'Pause 整个 Coordination Scope',
  resume: 'Resume 整个 Coordination Scope',
  cancel: 'Cancel 整个 Coordination Scope',
  help: 'Help',
};

export const HELP_LINES = [
  'Ctrl+P Command Palette · Ctrl+B Sidebar · Ctrl+G Graph Inspector',
  'Ctrl+T 展开/折叠最近一条工具记录 · Ctrl+A 进入回答模式',
  'Esc 逐层关闭 · Ctrl+C 退出（不隐式 Pause/Cancel）',
  'Enter 提交 · Shift+Enter（或 Alt+Enter）换行',
];

export function CommandPalette(props: CommandPaletteProps) {
  return (
    <Box flexDirection="column" borderStyle="single">
      <Text>Command Palette</Text>
      {props.commands.map((command, index) => (
        <Text key={command}>
          {truncateToDisplayWidth(
            `${index === props.selectedIndex ? '>' : ' '} ${COMMAND_LABELS[command]}`,
            Math.max(1, props.availableWidth),
          )}
        </Text>
      ))}
      <Text dimColor>Enter 执行 · Esc 关闭</Text>
    </Box>
  );
}
