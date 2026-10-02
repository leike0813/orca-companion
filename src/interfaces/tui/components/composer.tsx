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
import { truncateToDisplayWidth } from '../render/width.js';

import type { ComposerMode } from '../state.js';

export type ComposerProps = {
  readonly value: string;
  readonly draft?: UiDraft;
  readonly terminalHeight?: number;
  readonly focused?: boolean;
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
  const width = Math.max(1, props.availableWidth);
  const ref = useRef<DOMElement>(null);
  const metrics = useBoxMetrics(ref);
  const { setCursorPosition } = useCursor();
  const draft = props.draft ?? textDraft(props.value);
  const viewport = composerViewport(draft, Math.max(1, width - 1), props.terminalHeight ?? 24);
  // Ink 在 commit 时发布 cursor ref；本帧必须先填入位置，effect 会落后一帧。
  setCursorPosition(props.focused === true && !props.readOnly && metrics.hasMeasured
    ? { x: (props.origin?.x ?? 0) + metrics.left + Math.min(width - 1, viewport.cursor.column),
      y: (props.origin?.y ?? 0) + metrics.top + 2 + viewport.cursor.row }
    : undefined);
  const modeLabel =
    props.mode.kind === 'answer'
      ? `回答 interaction ${props.mode.interactionId} (revision ${String(props.mode.expectedRevision)})`
      : '普通消息';
  const placeholder =
    props.readOnly
      ? '(只读：该 Session 已交接)'
      : props.mode.kind === 'answer'
        ? '(输入回答后回车提交)'
        : `(输入消息后回车提交 · ${props.newlineHint})`;
  const lines = draft.text.length === 0 ? [truncateToDisplayWidth(placeholder, width)] : viewport.lines.map((line) => line.text);
  return (
    <Box ref={ref} flexDirection="column" borderStyle="single" borderLeft={false} borderRight={false} borderBottom={false}>
      <Text dimColor>{truncateToDisplayWidth(`composer · ${modeLabel}`, width)}</Text>
      {lines.map((line, index) => (
        <Text key={`composer-${String(index)}`}>{line.length === 0 ? ' ' : line}</Text>
      ))}
      {props.disabledReason === null ? null : <Text>{truncateToDisplayWidth(`! ${props.disabledReason}`, width)}</Text>}
    </Box>
  );
}
