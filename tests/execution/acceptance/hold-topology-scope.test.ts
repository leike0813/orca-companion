/**
 * `m1-evolve-execution-graph` 验收层：revision_pending 的拓扑准入范围（IP-10，D13）。
 *
 * 这是一条**显式**的拓扑断言：某个 Work Package 进入 revision pending 时，与其无拓扑关系的节点继续进入
 * Execution Frontier，而受影响节点与其未接受后代不派发后续角色。
 *
 * 它走完整链路而不是只测纯函数：先提交一次真实的 Graph Patch（持有与图版本同事务落盘），再从 store 读回
 * 持有与图，投影准入结果，最后用 `evaluateDispatchCandidate` 确认被持有的节点不能物化、无关节点可以。
 */

import { afterEach, beforeEach, expect, test } from 'vitest';

import type { GraphVersion, OperationId, WorkPackageId } from '../../../src/application/dto/identity.js';
import { budgetFromLimits } from '../../../src/domain/planning/budget-policy.js';
import { evaluateDispatchCandidate } from '../../../src/domain/dispatch-candidate.js';
import { projectRevisionPending } from '../../../src/domain/execution/revision-pending.js';
import { admitGraphRevision, applyGraphRevision } from '../../../src/application/execution/graph-patch-service.js';
import {
  createExecutionScopeHarness,
  type ExecutionScopeHarness,
} from '../../support/execution-harness.js';

const WP_A = 'wp-a' as WorkPackageId;
const WP_B = 'wp-b' as WorkPackageId;
const WP_C = 'wp-c' as WorkPackageId;
const WP_D = 'wp-d' as WorkPackageId;

let harness: ExecutionScopeHarness;

beforeEach(() => {
  harness = createExecutionScopeHarness();
});

afterEach(() => {
  harness.close();
});

/** 修订 wp-b（其未接受后代是 wp-c），并声明 wp-b 当前已派发。 */
function revisedWhileDispatched(): void {
  const payload = {
    baseGraphVersion: harness.currentGraph().version,
    patchId: 'patch-hold',
    operationId: 'op-hold',
    add: [],
    revise: [
      {
        workPackageId: WP_B,
        title: 'B 修订',
        dependsOn: [{ kind: 'existing', workPackageId: WP_A }],
        scopeEnvelope: { include: ['src'], exclude: [] },
      },
    ],
    retire: [],
    descendants: [{ workPackageId: WP_C, disposition: 'unchanged' }],
    takesOver: [],
  };
  const admitted = admitGraphRevision({
    draft: { payload, operationId: 'op-trusted' as OperationId, patchId: 'patch-hold' },
    current: harness.currentGraph(),
    limits: harness.limits,
    authorization: harness.authorization(),
    acceptedWorkPackageIds: [WP_A],
    dispatchedWorkPackageIds: [WP_B],
  });
  expect(admitted.kind).toBe('admitted');
  if (admitted.kind !== 'admitted') {
    return;
  }
  const applied = applyGraphRevision({
    store: harness.store,
    coordinationScopeId: harness.scopeId,
    writer: harness.writer,
    revision: admitted.revision,
    current: harness.currentGraph(),
    authorizationId: 'auth-1',
    baselines: new Map([...admitted.revision.revisedWorkPackageIds, ...admitted.revision.specificationRevisionRequiredWorkPackageIds].map((id) => [id, null])),
  });
  expect(applied.kind).toBe('applied');
}

function pendingFacts() {
  const holds = harness.store.query({ kind: 'revision-holds', coordinationScopeId: harness.scopeId });
  const pending =
    holds.kind === 'revision-holds'
      ? holds.holds
          .filter((hold) => hold.state === 'pending')
          .map((hold) => ({ workPackageId: hold.workPackageId, source: hold.source, sourceRef: hold.sourceRef }))
      : [];
  return projectRevisionPending({
    graph: harness.currentGraph().graph,
    holds: pending,
    accepted: [WP_A],
    dependenciesSatisfied: [WP_A, WP_B, WP_C, WP_D],
  });
}

test('持有期间无拓扑关系的节点仍进入 Execution Frontier', () => {
  revisedWhileDispatched();
  const projection = pendingFacts();
  expect(projection.frozen).toEqual([WP_B, WP_C].sort());
  // wp-d 只依赖已被接受的 wp-a：与 wp-b/wp-c 无拓扑关系，并发上限为 1 不会把它一起挡下。
  expect(projection.admissible).toEqual([WP_D]);
});

test('受影响节点与其未接受后代不派发后续角色', () => {
  revisedWhileDispatched();
  const projection = pendingFacts();
  const facts = (candidate: WorkPackageId) => ({
    candidateWorkPackageId: candidate,
    candidateRole: 'implementation' as const,
    lifecycleStage: 'frontier' as const,
    selectedCandidateId: candidate,
    revisionPending: projection.frozen,
    dependenciesSatisfied: [candidate],
    controlState: 'active',
    authorization: { valid: true, authorizationId: 'auth-1', authorizationVersion: 1, reason: null },
    authority: harness.authorization().manifest.permissions,
    budget: budgetFromLimits(harness.limits),
    consumed: [],
    requiredBudgetField: 'implementationAttempts' as const,
    scopeEnvelope: { include: ['src'], exclude: [] },
  });

  const affected = evaluateDispatchCandidate(facts(WP_B));
  expect(affected.kind === 'rejected' ? affected.rejection.code : null).toBe('revision_pending');
  const descendant = evaluateDispatchCandidate(facts(WP_C));
  expect(descendant.kind === 'rejected' ? descendant.rejection.code : null).toBe('revision_pending');

  const unrelated = evaluateDispatchCandidate(facts(WP_D));
  expect(unrelated.kind).toBe('materializable');
});

test('持有只由修订额度与图版本决定，图历史仍可读回', () => {
  revisedWhileDispatched();
  const versions = harness.store.query({
    kind: 'graph-versions',
    coordinationScopeId: harness.scopeId,
    graphId: harness.graphId,
  });
  if (versions.kind !== 'graph-versions') {
    throw new Error('无法读取图历史');
  }
  expect(versions.versions).toHaveLength(2);
  expect(versions.versions[1]?.version).toBe(2 as GraphVersion);
  expect(versions.versions[1]?.recordKind).toBe('accepted_revision');

  const holds = harness.store.query({ kind: 'revision-holds', coordinationScopeId: harness.scopeId });
  expect(holds.kind === 'revision-holds' ? holds.holds : null).toEqual([
    expect.objectContaining({ workPackageId: WP_B, source: 'graph_patch', state: 'pending' }),
  ]);
});
