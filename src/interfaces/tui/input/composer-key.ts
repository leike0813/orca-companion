/**
 * composer 键位映射（协调与调试外壳共用同一实现，不各自解释一次按键）。
 *
 * 普通字符只进入草稿；Enter 提交；Shift/Alt+Enter 换行由 `key.shift`/`key.meta` 判定，终端无法区分
 * 时回退为 Alt+Enter（提示里显示实际键位）。映射是纯函数：它不认识 Session、Scope 或草稿存储，
 * 只把按键翻译成 `change`/`submit`。
 */

import type { UiDraft } from '../../../application/ports/ui-input-store.js';
import { editComposer, type EditorKey } from './composer-editor.js';

export type ComposerKeyContext = {
  readonly readOnly: boolean;
  readonly draft: UiDraft;
  readonly width?: number;
  readonly change: (draft: UiDraft) => void;
  readonly submit: () => void;
};

export function handleComposerKey(input: string, key: EditorKey, context: ComposerKeyContext): void {
  if (context.readOnly) {
    return;
  }
  if (key.return === true) {
    if (key.shift === true || key.meta === true) {
      context.change(editComposer(context.draft, input, key, context.width));
      return;
    }
    if (context.draft.text.trim()) context.submit();
    return;
  }
  const next = editComposer(context.draft, input, key, context.width);
  if (next !== context.draft) context.change(next);
}
