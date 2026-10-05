/** Throwaway top/statusline comparison on the shared project/dialog workbench. */
import { Box, Text, useInput } from 'ink';
import { useRef, useState } from 'react';
import { z } from 'zod';

import type { TuiViewModel } from '../../application/tui/view-model.js';
import { modelInfo } from './dialog-prototype.js';
import { displayWidth, truncateToDisplayWidth } from './render/width.js';
import { tuiColors } from './theme.js';

export type StatusVariant = 'current' | 'fixed' | 'custom';
export type StatusAvailability = 'available' | 'unset' | 'unavailable';
export const statusVariants: readonly StatusVariant[] = ['current', 'fixed', 'custom'];
export const statusFields = ['graph', 'ticket', 'work-package', 'progress', 'budget'] as const;
export type StatusField = typeof statusFields[number];
type StatusSegment = { field: 'model' | 'effort' | 'context' | StatusField; text: string };
const fieldColors: Record<StatusSegment['field'], string> = {
  model: tuiColors.accent, effort: tuiColors.focus, context: tuiColors.success,
  graph: 'blueBright', ticket: tuiColors.focus, 'work-package': tuiColors.accent,
  progress: tuiColors.success, budget: tuiColors.focus,
};
export const statusPreferenceSchema = z.object({
  modelFormat: z.enum(['model', 'provider-model']),
  contextFormat: z.enum(['used', 'remaining', 'tokens']),
  progressFormat: z.enum(['count', 'percent']),
  budgetKey: z.enum(['work-packages', 'implementation-attempts', 'recovery']),
  fields: z.array(z.enum(statusFields)).max(statusFields.length).refine((fields) => new Set(fields).size === fields.length),
}).strict();
export type StatusPreferences = z.infer<typeof statusPreferenceSchema>;
export const defaultStatusPreferences: StatusPreferences = {
  modelFormat: 'model', contextFormat: 'used', progressFormat: 'count', budgetKey: 'work-packages', fields: ['graph'],
};
const fieldLabels: Record<StatusField, string> = { graph: '图代际与版本', ticket: '当前规划票', 'work-package': '当前执行工作包', progress: '验收进度', budget: '流程预算' };
const budgetLabels = { 'work-packages': '工作包', 'implementation-attempts': '实现尝试', recovery: '恢复' };
export type StatusSamples = {
  ticket: { number: string; title: string } | null;
  context: { used: number; capacity: number } | null;
  progress: { accepted: number; total: number } | null;
};
export const prototypeSessionLabel = (id: string | null) => id === 'session-long-中文规划-2026' ? 'S-A'
  : id === 'session-b' ? 'S-B' : id === null ? '无' : truncateToDisplayWidth(id, 8);

function alertLines(items: readonly string[], width: number): readonly string[] {
  const groups: string[][] = [];
  let hidden = 0;
  for (const item of items) {
    const last = groups.at(-1);
    if (last !== undefined && displayWidth(`! ${[...last, item].join(' · ')}`) <= width) last.push(item);
    else if (groups.length < 2) groups.push([item]);
    else hidden += 1;
  }
  if (hidden > 0) {
    const last = groups.at(-1)!;
    while (last.length > 1 && displayWidth(`! ${last.join(' · ')} · 另有 ${hidden} 项`) > width) {
      last.pop();
      hidden += 1;
    }
    const suffix = ` · 另有 ${hidden} 项`;
    return groups.map((group, index) => index === groups.length - 1
      ? `${truncateToDisplayWidth(`! ${group.join(' · ')}`, width - displayWidth(suffix))}${suffix}`
      : truncateToDisplayWidth(`! ${group.join(' · ')}`, width));
  }
  return groups.map((group) => truncateToDisplayWidth(`! ${group.join(' · ')}`, width));
}

export function prototypeChrome(view: TuiViewModel, width: number, unread: boolean) {
  const control = ({ active: '运行', blocked: '阻塞', paused: '暂停', cancelling: '取消中', cancelled: '已取消' } as Record<string, string>)[view.scope.controlState] ?? view.scope.controlState;
  const holder = view.scope.executionLeaseHolderSessionId;
  const facts = [
    prototypeSessionLabel(view.selectedSessionId),
    `${view.scope.mode === 'route_planning' ? '规划' : '执行'}/${control}`,
    `待答${view.interactions.filter((item) => item.state === 'open').length}`,
    ...(holder !== null && holder !== view.selectedSessionId ? [`持有${prototypeSessionLabel(holder)}`] : []),
    ...(unread ? ['新消息'] : []),
  ].join(' · ');
  // Repository labels are fixtures; reserve space for the scope/session facts first.
  const repository = truncateToDisplayWidth(width < 100 ? 'orca-c/main' : 'orca-companion/main',
    Math.max(0, width - displayWidth(facts) - 3));
  const identity = truncateToDisplayWidth(repository ? `${repository} · ${facts}` : facts, width);
  const risks = [
    view.execution.reconciliation.pending ? '原操作结果未知 · 待对账' : null,
    view.scope.controlState === 'cancelling' ? '停止结果待核验' : null,
    view.execution.hazards.unverifiedWorkerCount > 0 ? 'Worker 状态待核验' : null,
    view.compaction?.status === 'context_exhausted' ? '上下文耗尽' : null,
    view.blockers.length > 0 ? `阻塞 ${view.blockers.length} 项 · Ctrl+B 查看依据` : null,
    view.compaction?.status === 'compaction_degraded' ? '压缩降级' : null,
    view.maintenance?.stopped ? '维护已停止' : null,
  ].filter((item): item is string => item !== null);
  return { identity, alerts: alertLines(risks, width) };
}

export type PrototypeStatusProps = {
  view: TuiViewModel;
  configurationRef: string;
  effort: string | null | undefined;
  availability: StatusAvailability;
  contextAvailable: boolean;
  width: number;
  variant: StatusVariant;
  preferences: StatusPreferences;
  samples: StatusSamples;
};

function prototypeStatusSegments(props: PrototypeStatusProps): StatusSegment[] {
  const info = modelInfo[props.configurationRef];
  const effort = props.availability === 'unavailable' ? '不可用'
    : info === undefined ? '不可用' : info.efforts.length === 0 ? '不支持'
      : props.availability === 'unset' ? '未设置' : props.effort === null ? '未设置' : props.effort ?? info.defaultEffort ?? '未设置';
  const preferences = props.variant === 'custom' ? props.preferences : defaultStatusPreferences;
  // These explicit samples are not billed usage or compaction-state estimates.
  const context = props.availability !== 'available' || !props.contextAvailable ? null : props.samples.context;
  const percent = context === null || context.capacity <= 0 ? null : Math.round(context.used / context.capacity * 100);
  const contextLabel = preferences.contextFormat === 'remaining' ? '上下文剩余' : '上下文';
  const contextValue = percent === null ? '不可用' : preferences.contextFormat === 'tokens'
    ? `${context!.used / 1000}k/${context!.capacity / 1000}k` : `${preferences.contextFormat === 'remaining' ? Math.max(0, 100 - percent) : percent}%`;
  const tail = ` · 推理 ${effort} · ${contextLabel} ${contextValue}`;
  let label = info === undefined ? '模型不可用' : preferences.modelFormat === 'provider-model' ? `${info.provider}/${info.model}` : info.model;
  const modelWidth = Math.max(1, props.width - displayWidth(tail));
  if (info !== undefined && displayWidth(label) > modelWidth) label = info.model;
  const model = truncateToDisplayWidth(label, modelWidth);
  const segments: StatusSegment[] = [];
  let line = '';
  for (const segment of [{ field: 'model', text: model }, { field: 'effort', text: `推理 ${effort}` },
    { field: 'context', text: `${contextLabel} ${contextValue}` }] as const) {
    const separator = segments.length === 0 ? '' : ' · ';
    const remaining = props.width - displayWidth(line + separator);
    if (remaining <= 0) break;
    const text = truncateToDisplayWidth(segment.text, remaining);
    segments.push({ field: segment.field, text }); line += separator + text;
  }
  if (props.variant !== 'custom') return segments;
  const executing = props.view.scope.mode === 'execution_coordination';
  const unavailable = props.availability === 'unavailable';
  const budget = props.view.budgets.find((entry) => entry.budgetKey === preferences.budgetKey);
  const activeWorkPackageId = props.view.execution.activeWorkPackageIds[0] ?? null;
  const work = props.view.graph?.frontier.find((entry) => entry.workPackageId === activeWorkPackageId)
    ?? props.view.graph?.frontier[0];
  const progress = unavailable ? null : props.samples.progress;
  const phase = work?.state === 'implementing' ? '实现' : work?.state === 'reconciling' ? '对账' : work?.state;
  const extras: Record<StatusField, string | null> = {
    graph: props.view.graph === null ? unavailable ? '图不可用' : '未建立图' : `图 G${props.view.graph.generation ?? '?'}·v${props.view.graph.graphVersion}`,
    ticket: executing ? null : unavailable ? '规划票不可用' : props.samples.ticket === null ? '未领取规划票' : `规划 #${props.samples.ticket.number} ${props.samples.ticket.title}`,
    'work-package': !executing ? null : unavailable ? '执行工作包不可用' : work === undefined ? '执行空闲' : `执行 ${work.workPackageId} · ${phase}`,
    progress: !executing ? null : progress === null ? '验收进度不可用' : preferences.progressFormat === 'percent'
      ? progress.total === 0 ? '尚无验收工作包' : `验收 ${Math.round(progress.accepted / progress.total * 100)}%` : `验收 ${progress.accepted}/${progress.total}`,
    budget: !executing ? null : unavailable ? `${budgetLabels[preferences.budgetKey]}预算不可用` : budget === undefined
      ? `${budgetLabels[preferences.budgetKey]}预算未登记` : `${budgetLabels[preferences.budgetKey]}已用 ${budget.consumed}`,
  };
  for (const field of preferences.fields) {
    let extra = extras[field];
    if (extra === null) continue;
    if (field === 'ticket' && props.samples.ticket !== null && !unavailable) {
      const prefix = `规划 #${props.samples.ticket.number} `;
      const available = props.width - displayWidth(line + ' · ' + prefix);
      if (available > 1) extra = prefix + truncateToDisplayWidth(props.samples.ticket.title, available);
    }
    if (displayWidth(`${line} · ${extra}`) > props.width) break;
    line += ` · ${extra}`;
    segments.push({ field, text: extra });
  }
  return segments;
}

export function prototypeStatusText(props: PrototypeStatusProps): string {
  return prototypeStatusSegments(props).map((segment) => segment.text).join(' · ');
}

export function PrototypeStatusLine(props: PrototypeStatusProps) {
  return <Text>{prototypeStatusSegments(props).map((segment, index) => <Text key={segment.field}>
    {index === 0 ? null : <Text color={tuiColors.muted}> · </Text>}
    <Text color={fieldColors[segment.field]}>{segment.text}</Text>
  </Text>)}</Text>;
}

/** A draft editor inside the existing Options frame; only Save writes preferences. */
export function StatusOptions(props: {
  status: PrototypeStatusProps;
  width: number;
  height: number;
  onSave: (preferences: StatusPreferences) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(props.status.preferences);
  const draftRef = useRef(draft);
  const [index, setIndex] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const change = (update: (current: StatusPreferences) => StatusPreferences) => {
    draftRef.current = update(draftRef.current); setDraft(draftRef.current); setNotice(null);
  };
  const fields = [...draft.fields, ...statusFields.filter((field) => !draft.fields.includes(field))];
  const rows = [
    `模型名称：${draft.modelFormat === 'model' ? '仅模型' : 'Provider + 模型'}`,
    '推理强度：明确标签 · 常驻',
    `上下文：${{ used: '已用比例', remaining: '剩余比例', tokens: '已用量 / 容量' }[draft.contextFormat]}`,
    ...fields.map((field) => `${draft.fields.includes(field) ? '[x]' : '[ ]'} ${fieldLabels[field]}`),
    `进度格式：${draft.progressFormat === 'count' ? '验收数量' : '验收百分比'}`,
    `预算类别：${budgetLabels[draft.budgetKey]}`,
    '恢复默认（空格）',
  ];
  const rowFields: StatusSegment['field'][] = ['model', 'effort', 'context', ...fields, 'progress', 'budget'];
  const fit = (text: string) => truncateToDisplayWidth(text, props.width);
  const capacity = Math.max(1, props.height - 5);
  const start = Math.max(0, Math.min(rows.length - capacity, index - Math.floor(capacity / 2)));
  const save = async () => {
    savingRef.current = true; setSaving(true);
    try { await props.onSave(draftRef.current); }
    catch { setNotice('保存失败，原设置保留；可重试或取消'); }
    finally { savingRef.current = false; setSaving(false); }
  };
  useInput((input, key) => {
    if (savingRef.current) return;
    if (key.escape) { props.onCancel(); return; }
    if (key.return) { void save(); return; }
    if (key.ctrl) return;
    if (key.upArrow || key.downArrow) {
      setIndex(Math.max(0, Math.min(rows.length - 1, index + (key.upArrow ? -1 : 1))));
      return;
    }
    if (!(key.leftArrow || key.rightArrow || input === ' ')) return;
    const delta = key.leftArrow ? -1 : 1;
    if (index === 0) change((current) => ({ ...current, modelFormat: current.modelFormat === 'model' ? 'provider-model' : 'model' }));
    else if (index === 2) change((current) => { const formats = ['used', 'remaining', 'tokens'] as const; return { ...current, contextFormat: formats[(formats.indexOf(current.contextFormat) + delta + 3) % 3]! }; });
    else if (index >= 3 && index < 8) {
      const field = fields[index - 3]!;
      if (key.leftArrow || key.rightArrow) {
        const position = draftRef.current.fields.indexOf(field);
        const target = position + delta;
        if (position >= 0 && target >= 0 && target < draftRef.current.fields.length) {
          change((current) => { const next = [...current.fields]; [next[position], next[target]] = [next[target]!, next[position]!]; return { ...current, fields: next }; });
          setIndex(index + delta);
        }
      } else {
        change((current) => ({ ...current, fields: current.fields.includes(field) ? current.fields.filter((entry) => entry !== field) : [...current.fields, field] }));
        setIndex(3 + [...draftRef.current.fields, ...statusFields.filter((entry) => !draftRef.current.fields.includes(entry))].indexOf(field));
      }
    } else if (index === 8) change((current) => ({ ...current, progressFormat: current.progressFormat === 'count' ? 'percent' : 'count' }));
    else if (index === 9) change((current) => { const keys = ['work-packages', 'implementation-attempts', 'recovery'] as const; return { ...current, budgetKey: keys[(keys.indexOf(current.budgetKey) + delta + 3) % 3]! }; });
    else if (index === 10 && input === ' ') change(() => ({ ...defaultStatusPreferences, fields: [...defaultStatusPreferences.fields] }));
  });
  const hint = index < 3 ? '核心信息常驻；这里只调整展示格式' : index < 8 ? '已选顺序决定窄屏优先级；模式不适用时隐藏'
    : index === 8 ? '仅计入验收通过的工作包 · 示例' : index === 9 ? '按类别展示已用量；数值上限未提供' : '空格恢复默认；Enter 保存，Esc 放弃';
  const previewWidth = Math.min(props.status.width, props.width);
  return <Box height={props.height} flexDirection="column">
    <Text bold color={tuiColors.accent}>{fit('状态栏 · ↑↓选择 · 空格切换 · ←→排序/格式')}</Text>
    <Box height={capacity} flexDirection="column" overflow="hidden">
      {rows.slice(start, start + capacity).map((row, position) => <Text key={start + position}
        color={rowFields[start + position] === undefined ? tuiColors.muted : fieldColors[rowFields[start + position]!]}
        inverse={start + position === index}>{fit((start + position === index ? '› ' : '  ') + row)}</Text>)}
    </Box>
    <Text dimColor>{fit(notice ?? hint)}</Text>
    <Text color={tuiColors.accent}>{fit(`预览 · 主区域 ${props.status.width} 列${previewWidth < props.status.width ? ` · 预览${previewWidth}列` : ''}`)}</Text>
    <PrototypeStatusLine {...props.status} width={previewWidth} variant="custom" preferences={draft} />
    <Text bold color={tuiColors.accent}>{fit(saving ? '保存中…' : 'Enter 保存 · Esc 取消')}</Text>
  </Box>;
}
