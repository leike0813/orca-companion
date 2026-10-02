import { Box, Text } from 'ink';
import type { UiDraft } from '../../../application/ports/ui-input-store.js';
import { truncateToDisplayWidth } from '../render/width.js';
import { editorLayout, textDraft } from '../input/composer-editor.js';

export type PasteViewerView = { readonly draft: UiDraft; readonly block: number; readonly scroll: number };
export function PasteViewer(props: { readonly view: PasteViewerView; readonly width: number; readonly rows: number }) {
  const block = props.view.draft.pasteBlocks[props.view.block];
  const text = block ? props.view.draft.text.slice(block.start, block.end) : '当前草稿没有折叠粘贴块';
  return <Box flexDirection="column" borderStyle="single">
    <Text bold>{truncateToDisplayWidth(`粘贴查看 ${String(props.view.block + 1)}/${String(props.view.draft.pasteBlocks.length)} · ←/→ 切块 · ↑/↓ 滚动 · Esc 返回`, Math.max(1, props.width - 2))}</Text>
    {editorLayout(textDraft(text), Math.max(1, props.width - 2)).slice(props.view.scroll, props.view.scroll + Math.max(1, props.rows - 8))
      .map((line, index) => <Text key={index}>{line.text || ' '}</Text>)}
  </Box>;
}
