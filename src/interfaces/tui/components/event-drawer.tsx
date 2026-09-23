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
            {truncateToDisplayWidth(describeSemanticEvent(event), Math.max(1, props.availableWidth))}
          </Text>
        ))
      )}
      <Text dimColor>Esc 关闭</Text>
    </Box>
  );
}
