/**
 * 有界输入记录管理（IC-13 的界面侧，`/inputs`）。
 *
 * 纯展示组件：列表最多渲染 `INPUT_MANAGER_VISIBLE_ROWS` 行，正文用局部有界视口查看，记录再多也不会
 * 让渲染无界增长。恢复、删除与核验由容器执行；组件不打开数据库、不调用 Orca、不写业务状态。
 */

import { Box, Text } from 'ink';

import { truncateToDisplayWidth, wrapByDisplayWidth } from '../render/width.js';
import type { UiInputRecord } from '../../../application/ports/ui-input-store.js';
import { tuiColors } from '../theme.js';

/** 列表可见行数上限；超出部分滚动查看。 */
export const INPUT_MANAGER_VISIBLE_ROWS = 20;
/** 正文视口行数上限。 */
export const INPUT_MANAGER_BODY_ROWS = 10;

/** 可选条目：有效记录，或存在但无法解析、只能删除的记录身份。 */
export type InputManagerEntry =
  | { readonly kind: 'record'; readonly record: UiInputRecord }
  | { readonly kind: 'invalid'; readonly key: string; readonly revision: number };

export type InputRecordManagerView = {
  readonly entries: readonly InputManagerEntry[];
  readonly usage: { readonly records: number; readonly bytes: number };
  readonly selectedIndex: number;
  /** 正文视口的滚动偏移（行）。 */
  readonly bodyScroll: number;
  /** 正文视口是否接管方向键。 */
  readonly bodyFocus: boolean;
  readonly feedback: string | null;
  /** 已请求删除、等待二次确认。 */
  readonly confirmDelete: boolean;
};

export type InputRecordManagerProps = {
  readonly view: InputRecordManagerView;
  readonly availableWidth: number;
};

/** 目标的可读摘要；界面只显示范围，不构造身份。 */
export function inputRecordTargetLabel(record: UiInputRecord): string {
  const target = record.target;
  return target.kind === 'message'
    ? `msg ${target.coordinatorSessionId}`
    : `answer ${target.coordinatorSessionId} ${target.interactionId}@${String(target.expectedRevision)}`;
}

export function inputManagerEntryLabel(entry: InputManagerEntry): string {
  if (entry.kind === 'invalid') {
    return `不可读记录 rev=${String(entry.revision)}`;
  }
  const { record } = entry;
  const head = `rev=${String(record.revision)} · ${record.kind} · ${inputRecordTargetLabel(record)}`;
  if (record.kind !== 'submission') {
    return head;
  }
  const reason = record.reason === null ? '' : ` · ${record.reason}`;
  return `${head} · ${record.submissionId} · ${record.status}${reason}`;
}

/** 列表可见窗口：以选中项为中心，最多 `INPUT_MANAGER_VISIBLE_ROWS` 行。 */
export function inputManagerWindow(
  entries: readonly InputManagerEntry[],
  selectedIndex: number,
): readonly { readonly index: number; readonly entry: InputManagerEntry }[] {
  if (entries.length <= INPUT_MANAGER_VISIBLE_ROWS) {
    return entries.map((entry, index) => ({ index, entry }));
  }
  const start = Math.min(
    Math.max(0, selectedIndex - Math.floor(INPUT_MANAGER_VISIBLE_ROWS / 2)),
    entries.length - INPUT_MANAGER_VISIBLE_ROWS,
  );
  return entries
    .slice(start, start + INPUT_MANAGER_VISIBLE_ROWS)
    .map((entry, offset) => ({ index: start + offset, entry }));
}

/**
 * 选中条目正文的可见行。
 *
 * 有界遍历：按原始行依次换行，收满视口即停止，绝不先对整段正文（可能到 32 MiB）做全量换行；
 * 单行也按「够填满 skip + take 行」的前缀截断，避免超长单行撑爆渲染。
 */
export function inputManagerBodyLines(
  view: InputRecordManagerView,
  availableWidth: number,
): readonly string[] {
  const selected = view.entries[view.selectedIndex];
  if (selected === undefined || selected.kind === 'invalid') {
    return ['（不可读记录没有正文，只能删除）'];
  }
  const text = selected.record.draft.text;
  if (text.length === 0) {
    return ['（空正文）'];
  }
  const width = Math.max(1, availableWidth);
  const skip = Math.max(0, view.bodyScroll);
  const rowBudget = width * (skip + INPUT_MANAGER_BODY_ROWS + 1);
  const rows: string[] = [];
  let rowIndex = 0;
  let lineStart = 0;
  while (lineStart <= text.length) {
    const newline = text.indexOf('\n', lineStart);
    const end = newline === -1 ? text.length : newline;
    const line = text.slice(lineStart, Math.min(end, lineStart + rowBudget));
    for (const row of wrapByDisplayWidth(line, width)) {
      if (rowIndex >= skip) {
        rows.push(row);
      }
      rowIndex += 1;
      if (rows.length >= INPUT_MANAGER_BODY_ROWS) {
        return rows;
      }
    }
    if (newline === -1) {
      break;
    }
    lineStart = newline + 1;
  }
  return rows.length === 0 ? ['（空正文）'] : rows;
}

export function InputRecordManager(props: InputRecordManagerProps) {
  const { view } = props;
  const width = Math.max(1, props.availableWidth);
  const visible = inputManagerWindow(view.entries, view.selectedIndex);
  const body = inputManagerBodyLines(view, width);
  return (
    <Box flexDirection="column" borderStyle="single">
      <Text bold>
        {truncateToDisplayWidth(
          `输入记录管理 · 本 Scope ${String(view.entries.length)} 条 · 容量 ${String(view.usage.records)} 条 / ${String(view.usage.bytes)} 字节`,
          width,
        )}
      </Text>
      {view.entries.length === 0 ? <Text dimColor>（本 Scope 没有输入记录）</Text> : null}
      {visible.map(({ index, entry }) => (
        <Text
          key={entry.kind === 'record' ? entry.record.key : entry.key}
          bold={index === view.selectedIndex}
          {...(entry.kind === 'invalid'
            ? { color: tuiColors.warning }
            : index === view.selectedIndex
              ? { color: tuiColors.focus }
              : {})}
        >
          {truncateToDisplayWidth(
            `${index === view.selectedIndex ? '>' : ' '} ${inputManagerEntryLabel(entry)}`,
            width,
          )}
        </Text>
      ))}
      {view.entries.length > INPUT_MANAGER_VISIBLE_ROWS ? (
        <Text dimColor>
          {`（列表滚动：显示 ${String(visible.length)} / ${String(view.entries.length)} 条 · 正文第 ${String(view.bodyScroll + 1)} 行起）`}
        </Text>
      ) : null}
      <Text dimColor>{'─'.repeat(Math.min(width, 60))}</Text>
      {body.map((line, index) => (
        <Text key={`body-${String(index)}`}>{line.length === 0 ? ' ' : line}</Text>
      ))}
      {view.confirmDelete ? (
        <Text color={tuiColors.warning} bold>
          {truncateToDisplayWidth('确认删除选中记录？（y 确认 / n 取消；待核验提交删除后不可盲重试）', width)}
        </Text>
      ) : null}
      {view.feedback === null ? null : <Text>{truncateToDisplayWidth(`! ${view.feedback}`, width)}</Text>}
      <Text dimColor>
        {truncateToDisplayWidth(
          view.bodyFocus
            ? '正文视口：↑↓ 滚动 · Enter/Esc 返回列表 · r 恢复 · v 核验 · d 删除 · Ctrl+C 退出'
            : '↑↓ 选择 · Enter 查看正文 · r 恢复 · v 核验 · d 删除（二次确认） · Esc 关闭',
          width,
        )}
      </Text>
    </Box>
  );
}
