import { expect, test } from 'vitest';
import { isValidUiDraft } from '../../src/application/ports/ui-input-store.js';
import { composerViewport, editComposer, insertPaste, insertText, textDraft } from '../../src/interfaces/tui/input/composer-editor.js';

test('任意位置编辑与删除完整 grapheme，行首尾和上下移动', () => {
  let draft = textDraft('中e\u0301👩‍💻尾\n下一行');
  draft = editComposer(draft, 'a', { ctrl: true });
  expect(draft.cursor).toBe('中e\u0301👩‍💻尾\n'.length);
  draft = editComposer(draft, '', { upArrow: true });
  expect(draft.cursor).toBe(0);
  draft = editComposer(draft, '', { rightArrow: true });
  draft = editComposer(draft, '', { delete: true });
  expect(draft.text).toBe('中👩‍💻尾\n下一行');
  draft = editComposer(draft, '', { rightArrow: true });
  draft = editComposer(draft, '', { backspace: true });
  expect(draft.text).toBe('中尾\n下一行');
  draft = editComposer(draft, '插', {});
  expect(draft.text).toBe('中插尾\n下一行');
  expect(isValidUiDraft(draft)).toBe(true);
  expect(editComposer(draft, 'r', { ctrl: true })).toBe(draft);
});

test('粘贴按 code points 阈值折叠，在光标插入并保持原子范围', () => {
  const original = { ...textDraft('首尾'), cursor: 1 };
  expect(insertPaste(original, '😀'.repeat(1000), 'short').pasteBlocks).toHaveLength(0);
  const payload = '\t' + '😀'.repeat(1000) + '\r\n\r\n';
  let draft = insertPaste(original, payload, 'block-1');
  expect(draft.text).toBe('首\t' + '😀'.repeat(1000) + '\n\n尾');
  expect(draft.pasteBlocks).toHaveLength(1);
  expect(isValidUiDraft(draft)).toBe(true);
  draft = editComposer(draft, '', { leftArrow: true });
  expect(draft.cursor).toBe(1);
  draft = editComposer(draft, '前', {});
  expect(draft.pasteBlocks[0]?.start).toBe(2);
  draft = editComposer(draft, '', { delete: true });
  expect(draft.text).toBe('首前尾');
  expect(draft.pasteBlocks).toHaveLength(0);
});

test('有界 viewport 随光标和 resize，保留文本坐标', () => {
  const draft = textDraft(('中文 English\n').repeat(20));
  for (const [width, rows] of [[118, 40], [78, 24], [48, 40], [10, 6]]) {
    const viewport = composerViewport(draft, width ?? 1, rows ?? 1);
    expect(viewport.lines.length).toBeLessThanOrEqual(Math.min(6, Math.floor((rows ?? 1) / 3)));
    expect(viewport.cursor.row).toBeGreaterThanOrEqual(0);
    expect(viewport.cursor.row).toBeLessThan(viewport.lines.length);
  }
  expect(draft.cursor).toBe(draft.text.length);
});

test('插入或删除合并字符时仍保存完整 grapheme 与原子块', () => {
  const joined = insertText({ ...textDraft('👩💻'), cursor: 2 }, '\u200d');
  expect(joined.text).toBe('👩‍💻');
  expect(joined.cursor).toBe(joined.text.length);
  expect(isValidUiDraft(joined)).toBe(true);
  const separated = { ...textDraft('🇨 🇳'), cursor: 2 };
  const flag = editComposer(separated, '', { delete: true });
  expect(flag.text).toBe('🇨🇳');
  expect(isValidUiDraft(flag)).toBe(true);
  const folded = insertPaste(textDraft(''), 'a'.repeat(1001), 'stable');
  const accented = insertText(folded, '\u0301');
  expect(accented.pasteBlocks).toEqual([{ id: 'stable', start: 0, end: accented.text.length }]);
  expect(isValidUiDraft(accented)).toBe(true);
  expect(editComposer(accented, '', { backspace: true }).text).toBe('');
});
