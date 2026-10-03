import { Box, Text, useBoxMetrics, useCursor, type DOMElement } from 'ink';
import { useRef } from 'react';
import type { UiDraft } from '../../../application/ports/ui-input-store.js';
import { displayWidth, truncateToDisplayWidth } from '../render/width.js';
import { tuiColors } from '../theme.js';

export type ContextSearchView = { readonly label: string; readonly draft: UiDraft; readonly feedback: string; readonly editable: boolean };
export function ContextSearch({ view, width, origin }: { readonly view: ContextSearchView; readonly width: number; readonly origin: { x: number; y: number } }) {
  const ref = useRef<DOMElement>(null), metrics = useBoxMetrics(ref);
  const { setCursorPosition } = useCursor();
  const prefix = view.label + ' › ';
  setCursorPosition(view.editable && metrics.hasMeasured ? { x: Math.round(origin.x + metrics.left +
    Math.min(width - 1, displayWidth(prefix + view.draft.text.slice(0, view.draft.cursor)))), y: Math.round(origin.y + metrics.top) } : undefined);
  return <Box ref={ref} flexDirection="column" flexShrink={0}>
    <Text color={tuiColors.focus}>{truncateToDisplayWidth(prefix + view.draft.text.replace(/\n/gu, '↵'), width)}</Text>
    <Text dimColor>{truncateToDisplayWidth(view.feedback, width)}</Text>
  </Box>;
}
