import { Box, Text, useBoxMetrics, type DOMElement } from 'ink';
import { useRef } from 'react';
import type { ControllerInteractionView } from '../../../application/controller-service.js';
import type { UserQuestion } from '../../../application/ports/branch-coordination-store.js';
import type { UiDraft } from '../../../application/ports/ui-input-store.js';
import { wrapByDisplayWidth, truncateToDisplayWidth } from '../render/width.js';
import { Composer } from './composer.js';

export type AnswerPanelView = {
  readonly interaction: ControllerInteractionView & { readonly question: UserQuestion | null };
  readonly index: number;
  readonly count: number;
  readonly option: number;
  readonly focus: 'options' | 'text';
  readonly scroll: number;
};

export function AnswerPanel(props: { readonly view: AnswerPanelView; readonly draft: UiDraft; readonly width: number;
  readonly rows: number; readonly focused: boolean; readonly readOnly: boolean; readonly disabledReason: string | null;
  readonly origin: { readonly x: number; readonly y: number } }) {
  const ref = useRef<DOMElement>(null);
  const metrics = useBoxMetrics(ref);
  const view = props.view;
  const question = view.interaction.question;
  const options = question?.options ?? [];
  const body = wrapByDisplayWidth(question?.text ?? `${view.interaction.subjectRef.kind}:${view.interaction.subjectRef.id}`, props.width);
  const start = Math.max(0, view.option - 3);
  return <Box ref={ref} flexDirection="column">
    <Text bold>{truncateToDisplayWidth(`回答 ${String(view.index + 1)}/${String(view.count)} · Shift+←/→ 切题 · Esc 返回聊天`, props.width)}</Text>
    {body.slice(view.scroll, view.scroll + 3).map((line, index) => <Text key={index}>{line || ' '}</Text>)}
    {options.slice(start, start + 4).map((option, index) => <Text key={option.label}>
      {truncateToDisplayWidth(`${view.focus === 'options' && view.option === start + index ? '>' : ' '} ${option.label}${option.description ? ` · ${option.description}` : ''}`, props.width)}
    </Text>)}
    <Text dimColor>{truncateToDisplayWidth('Tab 切换选项/自由回答 · Enter 提交 · PgUp/PgDn 阅读问题', props.width)}</Text>
    {view.focus === 'text' ? <Composer value={props.draft.text} draft={props.draft}
      mode={{ kind: 'answer', interactionId: view.interaction.interactionId, expectedRevision: view.interaction.expectedRevision }}
      availableWidth={props.width} terminalHeight={props.rows} newlineHint="Alt+Enter 换行" readOnly={props.readOnly}
      disabledReason={props.disabledReason} focused={props.focused}
      origin={{ x: props.origin.x + metrics.left, y: props.origin.y + metrics.top }} /> : null}
  </Box>;
}
