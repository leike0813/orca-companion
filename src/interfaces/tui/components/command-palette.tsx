/**
 * Command Palette：全局命令入口。
 *
 * 它只列出命令并回调一个稳定 id；真正的动作由工作区映射到 IC-11 命令或展示态变化。`/compact` 的
 * fail-closed 语义在控制器装配层，不在界面层。
 */

import { Box, Text } from 'ink';

import { truncateToDisplayWidth } from '../render/width.js';

/**
 * 命令顺序沿用前驱已交付的排列，新维护入口追加在 `cancel` 之后：既有索引与肌肉记忆保持，`help`
 * 仍是最后一项。
 */
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
  'input-record-manager',
  'execution-handoff',
  'authorize-execution',
  'filter-execution',
  'answer',
  'paste',
  'exit',
  'help',
] as const;

export type CommandId = (typeof COMMAND_IDS)[number];

export type CommandPaletteProps = {
  readonly commands: readonly CommandId[];
  readonly selectedIndex: number;
  readonly onRun: (command: CommandId) => void;
  readonly availableWidth: number;
};

/**
 * 命令的唯一展示定义：名称/说明与 slash 别名。
 *
 * 面板、帮助与 slash 解析都从这里取；它不取代 Controller 的业务准入、授权与 revision 核验。
 */
export type CommandMeta = { readonly alias: string | null; readonly label: string };

export const COMMAND_METADATA: Readonly<Record<CommandId, CommandMeta>> = {
  answer: { alias: 'answer', label: '/answer 当前 Session 回答面板（Shift+←）' },
  paste: { alias: 'paste', label: '/paste 查看完整粘贴块' },
  compact: { alias: 'compact', label: '/compact 手动压缩该 Session' },
  'model-picker': { alias: 'model', label: 'Model Picker 切换 Coordinator Model Configuration' },
  handoff: { alias: 'handoff', label: 'Route Planning Handoff（prepare → review → cutover）' },
  'session-picker': { alias: 'sessions', label: 'Session Picker' },
  'event-drawer': { alias: 'events', label: 'Event Drawer' },
  'graph-inspector': { alias: 'graph', label: 'Graph Inspector' },
  'toggle-sidebar': { alias: null, label: '切换 Sidebar 密度' },
  pause: { alias: 'pause', label: 'Pause 整个 Coordination Scope' },
  resume: { alias: 'resume', label: 'Resume 整个 Coordination Scope' },
  cancel: { alias: 'cancel', label: 'Cancel 整个 Coordination Scope' },
  'input-record-manager': { alias: 'inputs', label: '/inputs 输入记录管理（草稿/冲突/待核验提交）' },
  'execution-handoff': {
    alias: 'handoff',
    label: 'Execution Handoff（prepare → review → cutover，责任转移）',
  },
  'authorize-execution': {
    alias: 'authorize',
    label: 'Execution Authorization（审阅完整 Manifest 并批准进入执行）',
  },
  'filter-execution': { alias: null, label: '切换执行图过滤（只隐藏节点）' },
  exit: { alias: 'exit', label: 'Exit 前台进程（不暂停或取消 Scope）' },
  help: { alias: 'help', label: 'Help' },
};

export const COMMAND_LABELS: Readonly<Record<CommandId, string>> = Object.fromEntries(
  Object.entries(COMMAND_METADATA).map(([id, meta]) => [id, meta.label]),
) as Readonly<Record<CommandId, string>>;

export type SlashResolution =
  | { readonly kind: 'not-command' }
  | { readonly kind: 'command'; readonly command: CommandId }
  | { readonly kind: 'unavailable'; readonly alias: string; readonly reason: string }
  | {
      readonly kind: 'error';
      readonly code: 'unknown_command' | 'invalid_format';
      readonly message: string;
    };

/**
 * 按 slash 别名查命令：唯一来源就是 `COMMAND_IDS` 与 `COMMAND_METADATA`，不另建命令目录。
 *
 * `handoff` 在规划与执行两个业务合同下同名：按当前模式选择，执行阶段取 `execution-handoff`。
 */
function commandForSlashAlias(alias: string, mode: string): CommandId | undefined {
  const matches = COMMAND_IDS.filter((command) => COMMAND_METADATA[command].alias === alias);
  if (matches.length <= 1) {
    return matches[0];
  }
  return mode === 'execution_coordination'
    ? (matches.find((command) => command === 'execution-handoff') ?? matches[0])
    : matches[0];
}

/** 本批尚未接通的已裁决别名：可发现、明确不可用，不回退为发送。 */
const UNAVAILABLE_SLASH: Readonly<Record<string, string>> = {
  project: '项目面板将在后续批次接通',
  options: '选项目录将在后续批次接通',
  statusline: '状态栏设置将在后续批次接通',
};

/**
 * 严格 slash 分类：只要以 `/` 开头就归命令处理，绝不回退为普通消息或回答。
 *
 * 只接受单个完整命令：空命令、内联参数与多行正文都报格式错误并保留输入。
 */
export function parseSlashInput(text: string, mode: string): SlashResolution {
  if (!text.startsWith('/')) {
    return { kind: 'not-command' };
  }
  if (/\r|\n/u.test(text)) {
    return { kind: 'error', code: 'invalid_format', message: '命令必须是单行，不支持内联正文' };
  }
  const trimmed = text.trim();
  if (trimmed.length <= 1) {
    return { kind: 'error', code: 'invalid_format', message: '以 / 开头时必须给出完整命令名' };
  }
  const body = trimmed.slice(1);
  if (/\s/u.test(body)) {
    return { kind: 'error', code: 'invalid_format', message: '命令不接受内联参数或空白，请在打开的界面里选择' };
  }
  const alias = body.toLowerCase();
  const command = commandForSlashAlias(alias, mode);
  if (command !== undefined) {
    return { kind: 'command', command };
  }
  const reason = UNAVAILABLE_SLASH[alias];
  if (reason !== undefined) {
    return { kind: 'unavailable', alias, reason };
  }
  return {
    kind: 'error',
    code: 'unknown_command',
    message: `无法识别的命令 /${alias}；按 /help 查看可用命令`,
  };
}

export const HELP_LINES = [
  'Ctrl+P Command Palette · Ctrl+B Sidebar · Ctrl+G Graph Inspector',
  'Ctrl+T 展开/折叠最近一条工具记录 · Shift+← 回答 · Ctrl+A/E 行首尾',
  'Esc 逐层关闭 · Ctrl+C 退出（不隐式 Pause/Cancel，危险态先确认）',
  '执行图过滤只隐藏节点，不改变拓扑顺序',
  'Enter 提交 · Alt+Enter 换行（支持解析 Shift+Enter 的终端也可使用）',
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
