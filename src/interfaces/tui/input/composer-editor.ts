import type { UiDraft } from '../../../application/ports/ui-input-store.js';
import { displayWidth, truncateToDisplayWidth } from '../render/width.js';

export const emptyDraft = (): UiDraft => ({ text: '', cursor: 0, pasteBlocks: [] });
export const textDraft = (text: string): UiDraft => ({ text, cursor: text.length, pasteBlocks: [] });
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export type EditorUnit = { readonly start: number; readonly end: number; readonly text: string };

export function editorUnits(draft: UiDraft): readonly EditorUnit[] {
  const units: EditorUnit[] = [];
  let offset = 0;
  for (const [index, block] of draft.pasteBlocks.entries()) {
    for (const part of segmenter.segment(draft.text.slice(offset, block.start))) {
      units.push({ start: offset + part.index, end: offset + part.index + part.segment.length, text: part.segment });
    }
    const sequence = /^\d+:/.test(block.id) ? block.id.split(':')[0] : String(index + 1);
    units.push({ start: block.start, end: block.end,
      text: `[粘贴 ${sequence} · ${String(Array.from(draft.text.slice(block.start, block.end)).length)} 字符]` });
    offset = block.end;
  }
  for (const part of segmenter.segment(draft.text.slice(offset))) {
    units.push({ start: offset + part.index, end: offset + part.index + part.segment.length, text: part.segment });
  }
  return units;
}

/** 所有文本修改都经范围替换，块身份不依赖标签或 substring 搜索。 */
function replace(draft: UiDraft, start: number, end: number, text: string, blockId?: string): UiDraft {
  const delta = text.length - (end - start);
  const blocks = draft.pasteBlocks.filter((block) => block.end <= start || block.start >= end)
    .map((block) => ({ ...block, start: block.start + (block.start >= end ? delta : 0), end: block.end + (block.start >= end ? delta : 0) }));
  if (blockId !== undefined) blocks.push({ id: blockId, start, end: start + text.length });
  blocks.sort((a, b) => a.start - b.start);
  const value = draft.text.slice(0, start) + text + draft.text.slice(end);
  let cursor = start + text.length;
  let boundary = 0;
  // 插入组合符或删除分隔符会合并 grapheme；光标和原子块都必须覆盖完整字符。
  for (const part of segmenter.segment(value)) {
    const finish = part.index + part.segment.length;
    if (part.index < cursor && cursor < finish) cursor = finish;
    while (boundary < blocks.length * 2) {
      const block = blocks[Math.floor(boundary / 2)];
      if (!block) break;
      const edge = boundary % 2 === 0 ? 'start' : 'end';
      if (block[edge] >= finish) break;
      if (block[edge] > part.index) block[edge] = edge === 'start' ? part.index : finish;
      boundary++;
    }
  }
  const merged: typeof blocks = [];
  for (const block of blocks) {
    const previous = merged.at(-1);
    if (previous && previous.end > block.start) previous.end = Math.max(previous.end, block.end);
    else merged.push(block);
  }
  const containing = merged.find((block) => block.start < cursor && cursor < block.end);
  return { text: value, cursor: containing?.end ?? cursor, pasteBlocks: merged };
}

export function insertText(draft: UiDraft, text: string): UiDraft {
  return replace(draft, draft.cursor, draft.cursor, text);
}

export function insertPaste(draft: UiDraft, raw: string, blockId: string): UiDraft {
  const text = raw.replace(/\r\n?/g, '\n');
  return replace(draft, draft.cursor, draft.cursor, text, Array.from(text).length > 1000 ? blockId : undefined);
}

export type EditorKey = {
  readonly leftArrow?: boolean; readonly rightArrow?: boolean; readonly upArrow?: boolean; readonly downArrow?: boolean;
  readonly home?: boolean; readonly end?: boolean; readonly backspace?: boolean; readonly delete?: boolean;
  readonly return?: boolean; readonly shift?: boolean; readonly meta?: boolean; readonly ctrl?: boolean;
  readonly tab?: boolean; readonly escape?: boolean;
};

export type EditorLine = { readonly text: string; readonly stops: readonly { offset: number; column: number }[] };

export function editorLayout(draft: UiDraft, width: number): readonly EditorLine[] {
  const limit = Math.max(1, width);
  const lines: EditorLine[] = [];
  let text = '';
  let column = 0;
  let stops = [{ offset: 0, column: 0 }];
  for (const unit of editorUnits(draft)) {
    if (unit.text === '\n') {
      lines.push({ text, stops }); text = ''; column = 0; stops = [{ offset: unit.end, column: 0 }]; continue;
    }
    let visible = unit.text === '\t' ? ' '.repeat(Math.min(limit, 4 - column % 4)) : truncateToDisplayWidth(unit.text, limit);
    let size = displayWidth(visible);
    if (column + size > limit && text) {
      lines.push({ text, stops }); text = ''; column = 0; stops = [{ offset: unit.start, column: 0 }];
      if (unit.text === '\t') { visible = ' '.repeat(Math.min(limit, 4)); size = visible.length; }
    }
    text += visible; column += size; stops.push({ offset: unit.end, column });
  }
  lines.push({ text, stops });
  return lines;
}

export function cursorInLayout(lines: readonly EditorLine[], offset: number): { row: number; column: number } {
  for (let row = lines.length - 1; row >= 0; row--) {
    const stop = lines[row]?.stops.find((entry) => entry.offset === offset);
    if (stop) return { row, column: stop.column };
  }
  return { row: 0, column: 0 };
}

export function editComposer(draft: UiDraft, input: string, key: EditorKey, width = 80): UiDraft {
  const units = editorUnits(draft);
  const previous = units.findLast((unit) => unit.end <= draft.cursor);
  const next = units.find((unit) => unit.start >= draft.cursor);
  if (key.leftArrow) return { ...draft, cursor: previous?.start ?? 0 };
  if (key.rightArrow) return { ...draft, cursor: next?.end ?? draft.text.length };
  if (key.backspace) return previous ? replace(draft, previous.start, previous.end, '') : draft;
  if (key.delete) return next ? replace(draft, next.start, next.end, '') : draft;
  if (key.home || key.end || (key.ctrl && (input === 'a' || input === 'e'))) {
    // 折叠块是一个单元；其内部换行不参与编辑行导航。
    const breaks = units.filter((unit) => unit.text === '\n');
    const start = breaks.findLast((unit) => unit.end <= draft.cursor)?.end ?? 0;
    const end = breaks.find((unit) => unit.start >= draft.cursor)?.start ?? draft.text.length;
    return { ...draft, cursor: key.home || input === 'a' ? start : end };
  }
  if (key.upArrow || key.downArrow) {
    const lines = editorLayout(draft, width);
    const position = cursorInLayout(lines, draft.cursor);
    const line = lines[position.row + (key.upArrow ? -1 : 1)];
    if (!line) return draft;
    const stop = line.stops.reduce((best, entry) => Math.abs(entry.column - position.column) < Math.abs(best.column - position.column) ? entry : best);
    return { ...draft, cursor: stop.offset };
  }
  if (key.return) return key.shift || key.meta ? insertText(draft, '\n') : draft;
  if (key.ctrl || key.meta || key.escape || key.tab || !input || Array.from(input).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  })) return draft;
  return insertText(draft, input);
}

export function composerViewport(draft: UiDraft, width: number, rows: number) {
  const lines = editorLayout(draft, width);
  const cursor = cursorInLayout(lines, draft.cursor);
  const height = Math.max(1, Math.min(6, Math.floor(rows / 3)));
  const start = Math.max(0, cursor.row - height + 1);
  return { lines: lines.slice(start, start + height), cursor: { row: cursor.row - start, column: cursor.column }, start };
}
