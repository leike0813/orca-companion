/**
 * `m1-evolve-execution-graph` 的行为测试：revision_pending 的有界持有（IC-10 / IP-5）。
 *
 * 覆盖 `execution/specification-revision` 的第二个 Requirement：持有只冻结受影响节点与其未接受后代；
 * 无关节点的节点继续可准入（并发上限为 1 不是拓扑准入限制）；已派发 Worker 不被杀死；旧结果不得越过
 * 持有推进。
 */

import { expect, test } from 'vitest';

import type { GraphGeneration, GraphId, WorkPackageId } from '../../src/application/dto/identity.js';
import { budgetFromLimits, DEFAULT_EXECUTION_LIMITS } from '../../src/domain/planning/budget-policy.js';
import type { ExecutionGraph } from '../../src/domain/planning/execution-graph.js';
import {
  evaluateDispatchCandidate,
  type DispatchCandidateFacts,
} from '../../src/domain/dispatch-candidate.js';
import {
  evaluateHeldResult,
  frozenWorkPackageIds,
  mayReleaseHold,
  projectRevisionPending,
  type RevisionHold,
} from '../../src/domain/execution/revision-pending.js';

const WP_A = 'wp-a' as WorkPackageId;
const WP_B = 'wp-b' as WorkPackageId;
const WP_C = 'wp-c' as WorkPackageId;
const WP_D = 'wp-d' as WorkPackageId;

/** A → B → C，另有只依赖 A 的兄弟节点 D。 */
function graph(): ExecutionGraph {
  const workPackage = (id: WorkPackageId, dependsOn: readonly WorkPackageId[]) => ({
    workPackageId: id,
    title: id,
    dependsOn,
    scopeEnvelope: { include: ['src'], exclude: [] },
    budget: budgetFromLimits(DEFAULT_EXECUTION_LIMITS),
  });
  return {
    graphId: 'graph-1' as GraphId,
    generation: 1 as GraphGeneration,
    concurrencyLimit: 1,
    workPackages: [
      workPackage(WP_A, []),
      workPackage(WP_B, [WP_A]),
      workPackage(WP_C, [WP_B]),
      workPackage(WP_D, [WP_A]),
    ],
  };
}

function hold(workPackageId: WorkPackageId): RevisionHold {
  return { workPackageId, source: 'specification_revision', sourceRef: 'revision-1' };
}

test('持有只冻结受影响节点与其未接受后代', () => {
  const frozen = frozenWorkPackageIds({
    graph: graph(),
    holds: [hold(WP_B)],
    accepted: [WP_A],
  });
  expect(frozen).toEqual([WP_B, WP_C].sort());
  expect(frozen).not.toContain(WP_D);
  expect(frozen).not.toContain(WP_A);
});

test('无关节点的节点仍按既有准入规则进入 Execution Frontier', () => {
  const projection = projectRevisionPending({
    graph: graph(),
    holds: [hold(WP_B)],
    accepted: [WP_A],
    dependenciesSatisfied: [WP_B, WP_C, WP_D],
  });
  expect(projection.frozen).toEqual([WP_B, WP_C].sort());
  // D 与 B/C 无拓扑关系：并发上限为 1 不会把它一起挡下。
  expect(projection.admissible).toEqual([WP_D]);
});

test('已接受节点不是准入候选', () => {
  const projection = projectRevisionPending({
    graph: graph(),
    holds: [],
    accepted: [WP_A],
    dependenciesSatisfied: [WP_A, WP_B],
  });
  expect(projection.admissible).toEqual([WP_B]);
});

test('持有不被杀死 Worker：解除需要 Worker 结清且修订被接受或节点被退休', () => {
  expect(mayReleaseHold({ currentWorkerSettled: false, revisionAccepted: true, nodeRetired: false })).toBe(false);
  expect(mayReleaseHold({ currentWorkerSettled: true, revisionAccepted: false, nodeRetired: false })).toBe(false);
  expect(mayReleaseHold({ currentWorkerSettled: true, revisionAccepted: true, nodeRetired: false })).toBe(true);
  expect(mayReleaseHold({ currentWorkerSettled: true, revisionAccepted: false, nodeRetired: true })).toBe(true);
});

test('旧结果不得越过持有推进，无关节点不受影响', () => {
  const frozen = [WP_B, WP_C];
  expect(evaluateHeldResult({ frozen, workPackageId: WP_C }).kind).toBe('blocked_by_hold');
  expect(evaluateHeldResult({ frozen, workPackageId: WP_D }).kind).toBe('may_advance');
});

function facts(overrides: Partial<DispatchCandidateFacts> = {}): DispatchCandidateFacts {
  return {
    candidateWorkPackageId: WP_B,
    candidateRole: 'implementation',
    lifecycleStage: 'frontier',
    selectedCandidateId: WP_B,
    revisionPending: [],
    dependenciesSatisfied: [WP_B],
    controlState: 'active',
    authorization: { valid: true, authorizationId: 'auth-1', authorizationVersion: 1, reason: null },
    authority: {
      planner: true,
      implementation: true,
      validator: true,
      finalizer: true,
      gitIntegration: false,
      dependencyChanges: false,
    },
    budget: budgetFromLimits(DEFAULT_EXECUTION_LIMITS),
    consumed: [],
    requiredBudgetField: 'implementationAttempts',
    scopeEnvelope: { include: ['src'], exclude: [] },
    ...overrides,
  };
}

test('被持有的节点不能物化，无关节点仍可物化', () => {
  const held = evaluateDispatchCandidate(facts({ revisionPending: [WP_B, WP_C] }));
  expect(held.kind).toBe('rejected');
  if (held.kind === 'rejected') {
    expect(held.rejection.code).toBe('revision_pending');
  }

  const unrelated = evaluateDispatchCandidate(
    facts({
      candidateWorkPackageId: WP_D,
      selectedCandidateId: WP_D,
      dependenciesSatisfied: [WP_D],
      revisionPending: [WP_B, WP_C],
    }),
  );
  expect(unrelated.kind).toBe('materializable');
});
