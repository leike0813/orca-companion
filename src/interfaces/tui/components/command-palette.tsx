import { Box, Text } from 'ink';
import { tuiColors } from '../theme.js';
import { displayWidth, truncateToDisplayWidth } from '../render/width.js';
import { COMMAND_METADATA, type CommandId } from '../commands.js';
import { DialogFrame } from './selection-list.js';
export { COMMAND_IDS, COMMAND_METADATA, COMMAND_LABELS, HELP_LINES, commandReason, parseSlashInput, slashCandidates, type CommandId } from '../commands.js';
export type CommandPaletteProps = {
  readonly commands: readonly CommandId[];
  readonly selectedIndex: number;
  readonly onRun: (command: CommandId) => void;
  readonly availableWidth: number;
  readonly maxRows?: number;
  readonly reasons?: Readonly<Partial<Record<CommandId, string>>>;
  readonly slash?: boolean;
  readonly summary?: string;
  readonly query?: string;
};


export function CommandPalette(props: CommandPaletteProps) {
  const width = Math.max(1, props.availableWidth - (props.slash ? 4 : 8));
  const count = Math.max(1, props.maxRows ?? 8);
  const start = Math.max(0, Math.min(props.commands.length - count, props.selectedIndex - Math.floor(count / 2)));
  const fit = (s: string) => truncateToDisplayWidth(s, width);
  const items=<>
    {!props.slash && <Text color={tuiColors.focus}>{fit('搜索 › ' + (props.query || '输入名称、别名或菜单路径'))}</Text>}
    {props.commands.length === 0 && <Text dimColor>没有匹配项</Text>}
    {props.commands.slice(start, start + count).map((command, i) => {
      const meta = COMMAND_METADATA[command], selected = start+i === props.selectedIndex;
      const reason = props.reasons?.[command];
      const left = (selected ? '› ' : '  ') + (props.slash ? '/' + meta.alias : meta.label);
      const right = reason ? '不可用: ' + reason : meta.description + ' · ' + meta.target;
      const leftWidth=Math.min(displayWidth(left),Math.floor(width*0.48));
      const fittedLeft=truncateToDisplayWidth(left,leftWidth),fittedRight=truncateToDisplayWidth(right,Math.max(1,width-leftWidth-1));
      const gap = Math.max(1, width - displayWidth(fittedLeft) - displayWidth(fittedRight));
      return <Text key={command} inverse={selected} color={reason ? tuiColors.muted : selected ? tuiColors.focus : 'white'}>{fit(fittedLeft + ' '.repeat(gap) + fittedRight)}</Text>;
    })}
    {props.slash?<Text dimColor>{fit('↑↓ 选择 · Tab/Enter 填入 · Esc 收起')}</Text>:null}
  </>;
  return props.slash ? <Box flexDirection="column" borderStyle="single" borderColor={tuiColors.border} paddingX={1}>
    <Text bold color={tuiColors.accent}>命令候选</Text>{items}
  </Box> : <DialogFrame title="Command Palette · 命令目录" summary={props.summary ?? 'Scope / Session / UI'} width={props.availableWidth} rows={count+8} footer="↑↓ 选择 · Enter 确认 · Esc 返回">{items}</DialogFrame>;
}
