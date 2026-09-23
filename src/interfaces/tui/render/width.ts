/**
 * MOD-06：按终端显示宽度渲染（Owner: `m2-deliver-planning-tui`，D8）。
 *
 * Node 24 没有内置的显示宽度计算，而验收明确要求中文与中英文混排在 resize 后不失配，因此这里有一
 * 处最小实现：只覆盖本项目实际使用的码点区间（ASCII、CJK 全宽/宽、韩文、零宽组合与格式字符）。
 *
 * 边界是明确的：复杂 emoji、ZWJ 序列与区域指示符不做图形簇合并，按单个码点计算（多数情况下宽度
 * 为 1，不保证与所有终端一致）；无法判定的码点按宽度 1 处理。
 */

import type { SidebarDensity } from '../state.js';

/** 零宽：组合附加符号与格式控制字符，不占终端列。 */
function isZeroWidth(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    codePoint === 0xfeff
  );
}

/** East Asian Wide / Fullwidth 的最小闭集。 */
function isWide(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3041 && codePoint <= 0x33ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

export function codePointWidth(codePoint: number): number {
  if (isZeroWidth(codePoint)) {
    return 0;
  }
  return isWide(codePoint) ? 2 : 1;
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    width += codePointWidth(character.codePointAt(0) ?? 0);
  }
  return width;
}

/**
 * 按显示宽度换行。
 *
 * 已存在的换行符强制断行；单个宽字符宽于可用宽度时该字符独占一行（宁可行溢出也不丢内容）。
 */
export function wrapByDisplayWidth(text: string, width: number): readonly string[] {
  const limit = Math.max(1, Math.trunc(width));
  const lines: string[] = [];
  for (const rawLine of text.split('\n')) {
    if (rawLine.length === 0) {
      lines.push('');
      continue;
    }
    let current = '';
    let currentWidth = 0;
    for (const character of rawLine) {
      const characterWidth = codePointWidth(character.codePointAt(0) ?? 0);
      if (currentWidth + characterWidth > limit && current.length > 0) {
        lines.push(current);
        current = '';
        currentWidth = 0;
      }
      current += character;
      currentWidth += characterWidth;
    }
    lines.push(current);
  }
  return lines;
}

/** 按显示宽度裁切；超长时以 `ellipsis` 收尾，且总宽度不超过 `width`。 */
export function truncateToDisplayWidth(text: string, width: number, ellipsis = '…'): string {
  const limit = Math.max(0, Math.trunc(width));
  if (displayWidth(text) <= limit) {
    return text;
  }
  const ellipsisWidth = displayWidth(ellipsis);
  if (limit <= ellipsisWidth) {
    return truncateToDisplayWidth(ellipsis, limit, '');
  }
  const budget = limit - ellipsisWidth;
  let result = '';
  let used = 0;
  for (const character of text) {
    const characterWidth = codePointWidth(character.codePointAt(0) ?? 0);
    if (used + characterWidth > budget) {
      break;
    }
    result += character;
    used += characterWidth;
  }
  return `${result}${ellipsis}`;
}

/** 右侧补空格到给定显示宽度；已超宽时原样返回（调用方应先裁切）。 */
export function padToDisplayWidth(text: string, width: number): string {
  const padding = Math.max(0, Math.trunc(width) - displayWidth(text));
  return `${text}${' '.repeat(padding)}`;
}

/** Sidebar 宽度预算；终端过窄时主视图优先。 */
export const SIDEBAR_FULL_WIDTH = 40;
export const SIDEBAR_COMPACT_WIDTH = 24;
/** 低于这个宽度时 Sidebar 只能折叠，主视图不再被挤压。 */
export const SIDEBAR_MIN_TERMINAL_WIDTH = 60;

/** 终端宽度允许的最高密度；它只规定上限，不主动展开。 */
export function allowedSidebarDensity(terminalWidth: number): SidebarDensity {
  if (terminalWidth < SIDEBAR_MIN_TERMINAL_WIDTH) {
    return 'collapsed';
  }
  if (terminalWidth >= SIDEBAR_MIN_TERMINAL_WIDTH + SIDEBAR_FULL_WIDTH) {
    return 'full';
  }
  return 'compact';
}

export function sidebarWidthFor(density: SidebarDensity): number {
  switch (density) {
    case 'full':
      return SIDEBAR_FULL_WIDTH;
    case 'compact':
      return SIDEBAR_COMPACT_WIDTH;
    case 'collapsed':
      return 0;
  }
}

/** Graph Inspector 在 Sidebar 宽度不足时的提示（D5：不得用 overlay 遮挡主视图）。 */
export const NARROW_TERMINAL_NOTICE = '终端过窄：请扩宽终端后再打开 Graph Inspector';
