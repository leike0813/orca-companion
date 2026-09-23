import { expect, test } from 'vitest';

import {
  ACTIONABLE_WORK_LIMIT,
  isActionableObservationClass,
  projectActionableWork,
  SOURCE_OBSERVATION_CLASSES,
  type SourceObservation,
  type SourceObservationClass,
} from '../../src/application/coordinator/actionable-work.js';
import type { CoordinatorSessionId } from '../../src/application/dto/identity.js';
import type { WakeAdmissionRecord } from '../../src/application/ports/branch-coordination-store.js';
import type { SourceRevisionRef } from '../../src/domain/coordinator/session-state.js';

const SESSION = 'session-a' as CoordinatorSessionId;
const OTHER_SESSION = 'session-b' as CoordinatorSessionId;

function source(sourceId: string, revision: number): SourceRevisionRef {
  return { sourceKind: 'delivery', sourceId, revision };
}

function observation(
  classification: SourceObservationClass,
  sourceId: string,
  options: { readonly revision?: number; readonly owner?: CoordinatorSessionId | null } = {},
): SourceObservation {
  return {
    source: source(sourceId, options.revision ?? 1),
    classification,
    summary: `${classification}:${sourceId}`,
    ownerCoordinatorSessionId: options.owner === undefined ? SESSION : options.owner,
  };
}

function admitted(...sources: readonly SourceRevisionRef[]): WakeAdmissionRecord {
  return {
    coordinationScopeId: 'scope-1' as WakeAdmissionRecord['coordinationScopeId'],
    coordinatorSessionId: SESSION,
    wakeBatchId: 'wake-1',
    admissionState: 'admitted',
    sourceRevisions: sources,
    admittedAt: 1,
  };
}

function project(observations: readonly SourceObservation[], options: {
  readonly controlState?: 'active' | 'paused' | 'cancelled';
  readonly admittedRecords?: readonly WakeAdmissionRecord[];
  readonly limit?: number;
} = {}) {
  return projectActionableWork({
    coordinatorSessionId: SESSION,
    controlState: options.controlState ?? 'active',
    observations,
    admitted: options.admittedRecords ?? [],
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
}

test('只有普通进度、keepalive、长轮询超时与无变化对账时不产生 Actionable Work', () => {
  const projection = project([
    observation('routine_progress', 'task-1'),
    observation('keepalive', 'connection-1'),
    observation('long_poll_timeout', 'poll-1'),
    observation('unchanged_reconciliation', 'reconcile-1'),
    observation('deterministic_transition', 'dispatch-1'),
  ]);

  expect(projection.items).toEqual([]);
  expect(projection.deferredCount).toBe(0);
  expect(projection.suppressedBy).toBeNull();
});

test('每个分类都被显式判定过是否可行动', () => {
  const actionable = SOURCE_OBSERVATION_CLASSES.filter((value) => isActionableObservationClass(value));

  expect(actionable).toEqual([
    'worker_question',
    'worker_escalation',
    'pending_interaction',
    'user_message',
    'unattributed_drift',
  ]);
});

test('需要判断的事实被投影成 Actionable Work', () => {
  const projection = project([
    observation('worker_escalation', 'dispatch-9'),
    observation('worker_question', 'dispatch-2'),
  ]);

  expect(projection.items.map((item) => item.workKind)).toEqual(['worker_question', 'worker_escalation']);
  expect(projection.items[0]?.summary).toContain('worker_question');
});

test('投影是 owner-scoped：别的 Session 的工作不会唤醒本 Session', () => {
  const projection = project([
    observation('worker_question', 'dispatch-a', { owner: OTHER_SESSION }),
    observation('worker_question', 'dispatch-b', { owner: null }),
  ]);

  expect(projection.items.map((item) => item.source.sourceId)).toEqual(['dispatch-b']);
});

test('已经准入过的 source revision 不会再次形成工作', () => {
  const projection = project(
    [observation('worker_escalation', 'dispatch-1', { revision: 3 })],
    { admittedRecords: [admitted(source('dispatch-1', 3))] },
  );

  expect(projection.items).toEqual([]);
});

test('同一 source 的更高 revision 仍然形成新工作', () => {
  const projection = project(
    [observation('worker_escalation', 'dispatch-1', { revision: 4 })],
    { admittedRecords: [admitted(source('dispatch-1', 3))] },
  );

  expect(projection.items).toHaveLength(1);
});

test('暂停或取消期间不产生 Actionable Work', () => {
  const observations = [observation('worker_escalation', 'dispatch-1')];

  for (const controlState of ['paused', 'cancelled'] as const) {
    const projection = project(observations, { controlState });
    expect(projection.items).toEqual([]);
    expect(projection.suppressedBy).toBe('control_state');
  }
});

test('投影有界且顺序稳定，超出的部分留给下一次而不是丢弃', () => {
  const observations = Array.from({ length: ACTIONABLE_WORK_LIMIT + 5 }, (_value, index) =>
    observation('worker_question', `dispatch-${String(index).padStart(3, '0')}`),
  );

  const first = project(observations);
  const second = project(observations);

  expect(first.items).toHaveLength(ACTIONABLE_WORK_LIMIT);
  expect(first.deferredCount).toBe(5);
  expect(first.items.map((item) => item.source.sourceId)).toEqual(
    second.items.map((item) => item.source.sourceId),
  );
  expect(first.items[0]?.source.sourceId).toBe('dispatch-000');

  const bounded = project(observations, { limit: 2 });
  expect(bounded.items).toHaveLength(2);
  expect(bounded.deferredCount).toBe(ACTIONABLE_WORK_LIMIT + 3);
});
