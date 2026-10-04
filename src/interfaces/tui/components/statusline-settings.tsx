import { Box, Text } from 'ink';
import { DialogFrame } from './selection-list.js';
import { StatusLine, type StatusLineProps } from './status-line.js';
import type { StatuslinePreferences } from '../../../application/configuration/tui-preferences.js';
import { tuiColors } from '../theme.js';
import { truncateToDisplayWidth } from '../render/width.js';

const FIELD_ORDER = ['graph', 'ticket', 'work-package', 'progress', 'budget'] as const;
const FIELD_LABELS = { graph: '图代际与版本', ticket: '当前规划票', 'work-package': '当前执行工作包', progress: '验收进度', budget: '流程预算' } as const;
const BUDGET_LABELS = { 'work-packages': '工作包', 'implementation-attempts': '实现尝试', recovery: '恢复' } as const;
export type StatuslineSettingRow = 'modelFormat' | 'effort' | 'contextFormat' | StatuslinePreferences['fields'][number] | 'progressFormat' | 'budgetKey' | 'restore';
export function statuslineSettingRows(preferences: StatuslinePreferences): StatuslineSettingRow[] {
  return ['modelFormat','effort','contextFormat',...preferences.fields,...FIELD_ORDER.filter(field=>!preferences.fields.includes(field)),'progressFormat','budgetKey','restore'];
}

export function updateStatuslinePreference(value: StatuslinePreferences, row: StatuslineSettingRow, direction: -1 | 1): StatuslinePreferences {
  if (row === 'restore' || row === 'effort') return value;
  if (row === 'modelFormat') return { ...value, modelFormat: value.modelFormat === 'model' ? 'provider-model' : 'model' };
  if (row === 'contextFormat') return { ...value, contextFormat: rotate(value.contextFormat, ['used', 'remaining', 'tokens'], direction) };
  if (row === 'progressFormat') return { ...value, progressFormat: value.progressFormat === 'count' ? 'percent' : 'count' };
  if (row === 'budgetKey') return { ...value, budgetKey: rotate(value.budgetKey, ['work-packages', 'implementation-attempts', 'recovery'], direction) };
  const fields = [...value.fields], index = fields.indexOf(row);
  if (index < 0) return value;
  const target = Math.max(0, Math.min(fields.length - 1, index + direction));
  if (target === index) return value;
  [fields[index], fields[target]] = [fields[target]!, fields[index]!];
  return { ...value, fields };
}

function rotate<T extends string>(current: T, choices: readonly T[], direction: -1 | 1): T {
  return choices[(choices.indexOf(current) + direction + choices.length) % choices.length]!;
}

export function StatuslineSettings({ preferences, selected, notice, width, rows = 24, statusLineProps, summary }: {
  readonly preferences: StatuslinePreferences;
  readonly selected: number;
  readonly notice: string | null;
  readonly width: number;
  readonly rows?: number;
  readonly statusLineProps: StatusLineProps;
  readonly summary?: string;
}) {
  const frameRows = Math.max(12, rows - 4);
  const inner = Math.max(1, width - 8);
  const items = statuslineSettingRows(preferences);
  const visibleRows = Math.max(1, frameRows - 10);
  const start = Math.max(0, Math.min(items.length - visibleRows, selected - Math.floor(visibleRows / 2)));
  const labels: Record<StatuslineSettingRow, string> = {
    modelFormat: `模型名称：${preferences.modelFormat === 'model' ? '仅模型' : 'Provider + 模型'}`,
    effort: '推理强度：明确标签 · 常驻',
    contextFormat: `上下文：${{ used: '已用比例', remaining: '剩余比例', tokens: '已用量 / 容量' }[preferences.contextFormat]}`,
    graph: `${preferences.fields.includes('graph') ? '[x]' : '[ ]'} ${FIELD_LABELS.graph}`,
    ticket: `${preferences.fields.includes('ticket') ? '[x]' : '[ ]'} ${FIELD_LABELS.ticket}`,
    'work-package': `${preferences.fields.includes('work-package') ? '[x]' : '[ ]'} ${FIELD_LABELS['work-package']}`,
    progress: `${preferences.fields.includes('progress') ? '[x]' : '[ ]'} ${FIELD_LABELS.progress}`,
    budget: `${preferences.fields.includes('budget') ? '[x]' : '[ ]'} ${FIELD_LABELS.budget}`,
    progressFormat: `进度格式：${preferences.progressFormat === 'count' ? '验收数量' : '验收百分比'}`,
    budgetKey: `预算类别：${BUDGET_LABELS[preferences.budgetKey]}`,
    restore: '恢复默认（空格）',
  };
  const rowColors: Record<StatuslineSettingRow, string> = { modelFormat:tuiColors.accent,effort:tuiColors.focus,contextFormat:tuiColors.success,graph:'blueBright',ticket:tuiColors.focus,'work-package':tuiColors.accent,progress:tuiColors.success,budget:tuiColors.focus,progressFormat:tuiColors.success,budgetKey:tuiColors.focus,restore:tuiColors.muted };
  const hint = notice ?? (selected < 3 ? '核心信息常驻；这里只调整展示格式' : selected < items.length - 3 ? '已选顺序决定窄屏优先级；不适用的内容会隐藏' : selected === items.length - 3 ? '仅计入已验收工作包' : selected === items.length - 2 ? '按类别显示实际主体和批准额度' : '空格恢复默认；Enter 保存，Esc 放弃');
  const fit = (text: string) => truncateToDisplayWidth(text, inner);
  const previewWidth = statusLineProps.availableWidth;
  const saveLabel = rows > 0 ? 'Enter 保存 · Esc 取消' : '';
  return <DialogFrame title="状态栏设置" summary={summary ?? '选项 · 状态栏'} width={width} rows={frameRows} footer={saveLabel}>
    <Box height={Math.max(1,frameRows-6)} flexDirection="column" overflow="hidden">
      <Text color={tuiColors.accent}>{fit('状态栏 · ↑↓选择 · 空格切换 · ←→排序/格式')}</Text>
      <Box height={visibleRows} flexDirection="column" overflow="hidden">
        {items.slice(start,start+visibleRows).map((row,offset)=>{const index=start+offset;return <Text key={index} color={rowColors[row]} inverse={index===selected}>{fit(`${index===selected?'› ':'  '}${labels[row]}`)}</Text>;})}
      </Box>
      <Text dimColor>{fit(hint)}</Text>
      <Text color={tuiColors.accent}>{fit(`预览 · 主区域 ${previewWidth} 列`)}</Text>
      <Box width={previewWidth} overflow="hidden"><StatusLine {...statusLineProps} availableWidth={previewWidth} preferences={preferences}/></Box>
    </Box>
  </DialogFrame>;
}

export const STATUSLINE_SETTING_ROWS = statuslineSettingRows;
