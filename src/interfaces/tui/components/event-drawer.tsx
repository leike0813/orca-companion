/**
 * Event Drawer：语义事件的只读列表。
 *
 * 只接受 IC-11 的 `SemanticEvent`：keepalive、stderr、poll timeout、无变化对账与诊断在 façade 就被
 * 过滤，因此这里不可能显示维护噪声。事件只进入抽屉，不改写 transcript。
 */

import { Box, Text } from 'ink';

import { truncateToDisplayWidth } from '../render/width.js';
import type { SemanticEvent } from '../../../application/controller-service.js';

export type EventDrawerProps = {
  readonly events: readonly SemanticEvent[];
  readonly availableWidth: number;
};

/**
 * 语义事件的分类。
 *
 * 分类只由事件 `kind` 决定（不做字符串匹配），因此「Task/Worker/Attempt/Recovery/Graph/控制/交互/
 * 交接/blocker」这些分区不会因为 payload 文案变化而漂移。keepalive、stderr、poll timeout、重复
 * delivery 与无变化对账在 IC-11 façade 已被过滤，结构上不可能到这里。
 */
export const SEMANTIC_EVENT_CATEGORIES = [
  'task',
  'worker',
  'attempt',
  'recovery',
  'graph',
  'control',
  'interaction',
  'handoff',
  'blocker',
] as const;

export type SemanticEventCategory = (typeof SEMANTIC_EVENT_CATEGORIES)[number];

export function semanticEventCategory(event: SemanticEvent): SemanticEventCategory {
  switch (event.kind) {
    case 'worker-liveness-changed':
      return 'worker';
    case 'recovery-status-changed':
      return 'recovery';
    case 'revision-hold-changed':
      return 'attempt';
    case 'graph-version-appended':
    case 'generation-status-changed':
    case 'generation-cutover-committed':
      return 'graph';
    case 'scope-control-changed':
      return 'control';
    case 'interaction-opened':
    case 'interaction-resolved':
      return 'interaction';
    case 'handoff-phase-changed':
      return 'handoff';
    case 'blocked':
      return 'blocker';
    case 'state-changed':
      return 'task';
  }
}

/** 语义事件的可读摘要；未知变体按 kind 原样显示，不猜测含义。 */
export function describeSemanticEvent(event: SemanticEvent): string {
  switch (event.kind) {
    case 'state-changed':
      return `state-changed rev=${String(event.revision)} (${event.reason})`;
    case 'interaction-opened':
      return `interaction-opened ${event.interactionId} rev=${String(event.expectedRevision)}`;
    case 'interaction-resolved':
      return `interaction-resolved ${event.interactionId}`;
    case 'handoff-phase-changed':
      return `handoff-phase-changed ${event.handoffId} -> ${event.phase}`;
    case 'worker-liveness-changed':
      return `worker-liveness-changed ${event.dispatchId} -> ${event.liveness}`;
    case 'recovery-status-changed':
      return `recovery-status-changed ${event.recoveryId} -> ${event.status}`;
    case 'scope-control-changed':
      return `scope-control-changed -> ${event.controlState}`;
    case 'graph-version-appended':
      return `graph-version-appended ${event.graphId} v${String(event.graphVersion)}`;
    case 'revision-hold-changed':
      return `revision-hold-changed ${event.workPackageId} -> ${event.state}`;
    case 'generation-status-changed':
      return `generation-status-changed ${event.graphId} -> ${event.status}`;
    case 'generation-cutover-committed':
      return `generation-cutover-committed ${event.predecessorGraphId} -> ${event.candidateGraphId}`;
    case 'blocked':
      return `blocked ${event.code}: ${event.message}`;
  }
}

export function EventDrawer(props: EventDrawerProps) {
  return (
    <Box flexDirection="column" borderStyle="single">
      <Text>Event Drawer</Text>
      {props.events.length === 0 ? (
        <Text dimColor>（暂无语义事件）</Text>
      ) : (
        props.events.map((event, index) => (
          <Text key={`${event.kind}-${String(index)}`}>
            {truncateToDisplayWidth(
              `[${semanticEventCategory(event)}] ${describeSemanticEvent(event)}`,
              Math.max(1, props.availableWidth),
            )}
          </Text>
        ))
      )}
      <Text dimColor>Esc 关闭</Text>
    </Box>
  );
}
