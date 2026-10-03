/**
 * composer：多行输入的展示与模式提示。
 *
 * 输入事件由工作区用固定键位映射处理，本组件不订阅 stdin、不解析文本语义。两种模式严格分离：
 * Answer 模式显式显示它绑定的 interaction ID 与 expected revision，因此普通消息不可能被当成回答。
 */

import { Box, Text, useBoxMetrics, useCursor, type DOMElement } from 'ink';
import { useRef } from 'react';
import type { UiDraft } from '../../../application/ports/ui-input-store.js';
import { composerViewport, textDraft } from '../input/composer-editor.js';
import { composerContentWidth, truncateToDisplayWidth } from '../render/width.js';
import { tuiColors } from '../theme.js';

import type { ComposerMode } from '../state.js';

export type ComposerProps = {
  readonly value: string;
  readonly draft?: UiDraft;
  readonly terminalHeight?: number;
  readonly focused?: boolean;
  readonly externalCursor?: boolean;
  readonly origin?: { readonly x: number; readonly y: number };
  readonly mode: ComposerMode;
  /** 该 Session 是否只读（Handoff cutover 后的 Source）。 */
  readonly readOnly: boolean;
  /** 非空即为不可提交的原因；界面据此禁用提交，而不是让用户提交后失败。 */
  readonly disabledReason: string | null;
  readonly newlineHint: string;
  readonly availableWidth: number;
};

export function composerSubmitBlocked(props: Pick<ComposerProps, 'readOnly' | 'disabledReason'>): boolean {
  return props.readOnly || props.disabledReason !== null;
}

export function Composer(props: ComposerProps) {
  const width = composerContentWidth(props.availableWidth);
  const ref = useRef<DOMElement>(null);
  const metrics = useBoxMetrics(ref);
  const { setCursorPosition } = useCursor();
  const draft = props.draft ?? textDraft(props.value);
  const viewport = composerViewport(draft, width, props.terminalHeight ?? 24);
  // Ink 在 commit 时发布 cursor ref；本帧必须先填入位置，effect 会落后一帧。
  if (!props.externalCursor) setCursorPosition(props.focused === true && !props.readOnly && metrics.hasMeasured
    ? { x: Math.round((props.origin?.x ?? 0) + metrics.left + 2 + Math.min(width, viewport.cursor.column)),
      y: Math.round((props.origin?.y ?? 0) + metrics.top + 2 + viewport.cursor.row) }
    : undefined);
  const modeLabel =
    props.mode.kind === 'answer'
      ? `回答 interaction ${props.mode.interactionId} (revision ${String(props.mode.expectedRevision)})`
      : '普通消息';
  const color = props.readOnly || props.focused === false ? tuiColors.muted : tuiColors.focus;
  const placeholder =
    props.readOnly
      ? '(只读：该 Session 已交接)'
      : props.mode.kind === 'answer'
        ? '(输入回答后回车提交)'
        : `输入消息… · ${props.newlineHint}`;
  const lines = draft.text.length === 0 ? [truncateToDisplayWidth(placeholder, width)] : viewport.lines.map((line) => line.text);
  return (
    <Box ref={ref} flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
      <Text color={color} bold>{truncateToDisplayWidth(`› ${modeLabel}${props.readOnly ? ' · 只读' : ''}`, width)}</Text>
      {lines.map((line, index) => (
        <Text key={`composer-${String(index)}`} dimColor={draft.text.length === 0}>{line.length === 0 ? ' ' : line}</Text>
      ))}
      {props.disabledReason === null ? null : <Text color={tuiColors.warning}>{truncateToDisplayWidth(`! ${props.disabledReason}`, width)}</Text>}
    </Box>
  );
}
