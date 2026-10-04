/**
 * MOD-06：固定全局键位映射（Owner: `m2-deliver-planning-tui`，D7）。
 *
 * 映射是编译期常量：项目不提供自定义键位，也不保存键位配置。普通字符永远不产生全局动作，因此
 * composer 聚焦时输入 `p` 或 `g` 只会进入 composer。`Esc` 的「逐层关闭」由 overlay 栈决定，这里只
 * 把它翻译成一个动作。
 */

import { GLOBAL_KEY_BINDINGS, type GlobalAction } from '../commands.js';
export { GLOBAL_KEY_BINDINGS, COMPOSER_SUBMIT_KEY, COMPOSER_NEWLINE_KEYS, type GlobalAction } from '../commands.js';

export type KeyEventLike = {
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly escape?: boolean;
  readonly shift?: boolean;
  readonly leftArrow?: boolean;
};

/**
 * 把一次按键翻译成全局动作。
 *
 * 未识别的键位（包括所有普通字符）返回 `null`：调用方据此把输入交给 composer，而不是猜测意图。
 */
export function resolveGlobalAction(input: string, key: KeyEventLike): GlobalAction | null {
  if (['\u001bOR', '\u001b[13~'].includes(input)) return 'search-history';
  if (['\u001bOS', '\u001b[14~'].includes(input)) return 'navigate-activity';
  if (key.shift && key.leftArrow && !key.ctrl && !key.meta) return 'enter-answer';
  if (key.ctrl === true && key.meta !== true) return (Object.entries(GLOBAL_KEY_BINDINGS).find(([, binding]) => binding === `ctrl+${input}`)?.[0] as GlobalAction | undefined) ?? null;
  if (key.escape === true) {
    return 'escape';
  }
  return null;
}

/** Enter 提交；终端无法区分 Shift+Enter 时回退到 Alt+Enter 换行（界面显示实际键位）。 */

export function composerNewlineHint(altEnterRequired: boolean): string {
  return altEnterRequired ? 'Alt+Enter 换行' : 'Shift+Enter 换行';
}
