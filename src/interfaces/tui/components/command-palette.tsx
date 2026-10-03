/**
 * Command Palette：全局命令入口。
 *
 * 它只列出命令并回调一个稳定 id；真正的动作由工作区映射到 IC-11 命令或展示态变化。`/compact` 的
 * fail-closed 语义在控制器装配层，不在界面层。
 */

import { Box, Text } from 'ink';
import { tuiColors } from '../theme.js';
import { DialogFrame } from './selection-list.js';

import { displayWidth, truncateToDisplayWidth } from '../render/width.js';

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
  'project',
  'options',
  'statusline',
  'help',
] as const;

export type CommandId = (typeof COMMAND_IDS)[number];

export type CommandPaletteProps = {
  readonly commands: readonly CommandId[];
  readonly selectedIndex: number;
  readonly onRun: (command: CommandId) => void;
  readonly availableWidth: number;
  readonly maxRows?: number;
  readonly reasons?: Readonly<Partial<Record<CommandId, string>>>;
  readonly slash?: boolean;
  readonly summary?: string;
};

/**
 * 命令的唯一展示定义：名称/说明与 slash 别名。
 *
 * 面板、帮助与 slash 解析都从这里取；它不取代 Controller 的业务准入、授权与 revision 核验。
 */
export type CommandMeta = { readonly alias: string | null; readonly label: string; readonly description: string; readonly target: 'Scope' | 'Session' | 'UI' };

export const COMMAND_METADATA: Readonly<Record<CommandId, CommandMeta>> = {
  "answer": {"alias":"answer","label":"当前会话回答","description":"绑定当前问题","target":"Session"},
  "paste": {"alias":"paste","label":"粘贴块","description":"查看完整载荷","target":"UI"},
  "compact": {"alias":"compact","label":"压缩会话","description":"请求手动压缩","target":"Session"},
  "model-picker": {"alias":"model","label":"Model Picker","description":"选择协调模型","target":"Session"},
  "handoff": {"alias":"handoff","label":"Route Planning Handoff","description":"交接规划责任","target":"Scope"},
  "session-picker": {"alias":"sessions","label":"Session Picker","description":"切换会话","target":"UI"},
  "event-drawer": {"alias":"events","label":"最近事件","description":"打开项目事件页","target":"Scope"},
  "graph-inspector": {"alias":"graph","label":"执行图检查","description":"依赖与依据","target":"Scope"},
  "toggle-sidebar": {"alias":null,"label":"侧栏密度","description":"展开或折叠","target":"UI"},
  "pause": {"alias":"pause","label":"Pause","description":"暂停项目协调","target":"Scope"},
  "resume": {"alias":"resume","label":"Resume","description":"先对账再恢复","target":"Scope"},
  "cancel": {"alias":"cancel","label":"Cancel","description":"停止项目协调","target":"Scope"},
  "input-record-manager": {"alias":"inputs","label":"输入记录","description":"草稿/冲突/待核验","target":"UI"},
  "execution-handoff": {"alias":"handoff","label":"Execution Handoff","description":"交接执行责任","target":"Scope"},
  "authorize-execution": {"alias":"authorize","label":"Execution Authorization","description":"审阅并批准执行","target":"Scope"},
  "filter-execution": {"alias":null,"label":"图过滤","description":"仅改变可见性","target":"UI"},
  "exit": {"alias":"exit","label":"Exit","description":"退出前台","target":"UI"},
  "project": {"alias":"project","label":"项目总览","description":"预算与身份","target":"Scope"},
  "options": {"alias":"options","label":"选项","description":"图标与显示","target":"UI"},
  "statusline": {"alias":"statusline","label":"状态栏设置","description":"用户级偏好未接通","target":"UI"},
  "help": {"alias":"help","label":"Help","description":"命令与键位","target":"UI"},
};

export const COMMAND_LABELS: Readonly<Record<CommandId, string>> = Object.fromEntries(
  Object.entries(COMMAND_METADATA).map(([id, meta]) => [id, meta.label]),
) as Readonly<Record<CommandId, string>>;

export type SlashResolution =
  | { readonly kind: 'not-command' }
  | { readonly kind: 'command'; readonly command: CommandId }
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
  return {
    kind: 'error',
    code: 'unknown_command',
    message: `无法识别的命令 /${alias}；按 /help 查看可用命令`,
  };
}

export const HELP_LINES = [
  'Ctrl+P 命令 · Ctrl+B 项目 · Ctrl+G 执行图检查',
  'Ctrl+T 展开/折叠最近一条工具记录 · Shift+← 回答 · Ctrl+A/E 行首尾',
  'Esc 逐层关闭 · Ctrl+C 退出（不隐式 Pause/Cancel，危险态先确认）',
  '执行图过滤只隐藏节点，不改变拓扑顺序',
  'Enter 提交 · Alt+Enter 换行（支持解析 Shift+Enter 的终端也可使用）',
];

export function commandReason(command: CommandId, view: { readonly mode: string; readonly selectedSessionId: string | null; readonly pasteBlocks: number }): string | null {
  if (command === 'statusline') return '用户级状态栏设置尚未接通';
  if (command === 'handoff' && view.mode !== 'route_planning') return '仅用于规划模式';
  if (command === 'execution-handoff' && view.mode !== 'execution_coordination') return '仅用于执行模式';
  if (command === 'paste' && view.pasteBlocks === 0) return '当前草稿没有粘贴块';
  if (COMMAND_METADATA[command].target === 'Session' && view.selectedSessionId === null) return '未选择 Coordinator Session';
  return null;
}

export function slashCandidates(text: string, mode: string): readonly CommandId[] {
  if (!/^\/[a-z-]*$/i.test(text)) return [];
  const query = text.slice(1).toLowerCase();
  return COMMAND_IDS.filter(command => {
    const alias = COMMAND_METADATA[command].alias;
    return alias !== null && alias.startsWith(query) && commandForSlashAlias(alias, mode) === command;
  });
}

export function CommandPalette(props: CommandPaletteProps) {
  const width = Math.max(1, props.availableWidth - (props.slash ? 4 : 8));
  const count = Math.max(1, props.maxRows ?? 8);
  const start = Math.max(0, props.selectedIndex - Math.floor(count / 2));
  const fit = (s: string) => truncateToDisplayWidth(s, width);
  const items=<>
    {props.commands.slice(start, start + count).map((command, i) => {
      const meta = COMMAND_METADATA[command], selected = start+i === props.selectedIndex;
      const reason = props.reasons?.[command];
      const left = (selected ? '› ' : '  ') + (props.slash ? '/' + meta.alias : meta.label);
      const right = reason ? '不可用: ' + reason : meta.description + ' · ' + meta.target;
      const gap = Math.max(1, width - displayWidth(left) - displayWidth(right));
      return <Text key={command} inverse={selected} color={reason ? tuiColors.muted : selected ? tuiColors.focus : 'white'}>{fit(left + ' '.repeat(gap) + right)}</Text>;
    })}
    {props.slash?<Text dimColor>{fit('↑↓ 选择 · Tab/Enter 填入 · Esc 收起')}</Text>:null}
  </>;
  return props.slash ? <Box flexDirection="column" borderStyle="single" borderColor={tuiColors.border} paddingX={1}>
    <Text bold color={tuiColors.accent}>命令候选</Text>{items}
  </Box> : <DialogFrame title="Command Palette · 命令目录" summary={props.summary ?? 'Scope / Session / UI'} width={props.availableWidth} rows={count+6} footer="↑↓ 选择 · Enter 确认 · Esc 返回">{items}</DialogFrame>;
}
