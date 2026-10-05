/**
 * Dispatch Candidate 物化前置判定测试
 * （change: `m1-admit-work-package-specifications`，Owner: IP-A1）。
 *
 * 覆盖 Requirement「Work Package 的 worktree 只在进入调度时建立」与「Dispatch Candidate 物化恰好
 * 一个角色级 Orca Task」的判定部分：
 * - 选中候选时判定为可物化；
 * - 未进入 Frontier 的 Work Package 判定为拒绝；
 * - 授权失效、预算耗尽分别给出确定的拒绝原因；
 * - 判定是纯函数：同一输入重复求值结果相同，且不消耗预算。
 */

import { expect, test } from 'vitest';

import type { WorkPackageId } from '../../src/application/dto/identity.js';
import {
  WORK_PACKAGE_BUDGET_FIELDS,
  evaluateDispatchCandidate,
  exhaustedBudgetField,
  workPackageBudgetKey,
  type DispatchCandidateFacts,
} from '../../src/domain/dispatch-candidate.js';
import { DEFAULT_EXECUTION_LIMITS } from '../../src/domain/planning/budget-policy.js';
import { budgetFromLimits } from '../../src/domain/planning/budget-policy.js';

const WP = 'wp-1' as WorkPackageId;
const WP_OTHER = 'wp-2' as WorkPackageId;

function facts(overrides: Partial<DispatchCandidateFacts> = {}): DispatchCandidateFacts {
  return {
    candidateWorkPackageId: WP,
    candidateRole: 'implementation',
    lifecycleStage: 'frontier',
    selectedCandidateId: WP,
    revisionPending: [],
    revisionPlanner: null,
    dependenciesSatisfied: [WP],
    controlState: 'active',
    authorization: {
      valid: true,
      authorizationId: 'auth-1',
      authorizationVersion: 1,
      reason: null,
    },
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
    scopeEnvelope: { include: ['src/domain'], exclude: [] },
    ...overrides,
  };
}

test('选中 Frontier 中的候选时判定为可物化', () => {
  const decision = evaluateDispatchCandidate(facts());

  expect(decision.kind).toBe('materializable');
  if (decision.kind !== 'materializable') {
    return;
  }
  expect(decision.workPackageId).toBe(WP);
  expect(decision.role).toBe('implementation');
  expect(decision.scopeEnvelope.include).toEqual(['src/domain']);
});

test('未进入 Frontier 或未被选中的 Work Package 判定为拒绝', () => {
  const notFrontier = evaluateDispatchCandidate(facts({ lifecycleStage: 'pending' }));
  const notSelected = evaluateDispatchCandidate(facts({ selectedCandidateId: WP_OTHER }));
  const noCandidate = evaluateDispatchCandidate(facts({ selectedCandidateId: null }));
  const dependencyPending = evaluateDispatchCandidate(facts({ dependenciesSatisfied: [] }));

  expect(notFrontier.kind).toBe('rejected');
  expect(notSelected.kind).toBe('rejected');
  expect(noCandidate.kind).toBe('rejected');
  expect(dependencyPending.kind).toBe('rejected');
  if (notFrontier.kind === 'rejected') {
    expect(notFrontier.rejection.code).toBe('lifecycle_not_frontier');
    expect(notFrontier.rejection.budgetKey).toBeNull();
  }
  if (dependencyPending.kind === 'rejected') {
    expect(dependencyPending.rejection.code).toBe('graph_dependency_unsatisfied');
  }
  if (notSelected.kind === 'rejected') {
    expect(notSelected.rejection.code).toBe('not_selected_candidate');
  }
});

test('授权失效与预算耗尽分别给出确定的拒绝原因', () => {
  const unauthorized = evaluateDispatchCandidate(
    facts({
      authorization: {
        valid: false,
        authorizationId: null,
        authorizationVersion: null,
        reason: 'Graph Generation 尚无有效的 Execution Authorization',
      },
    }),
  );
  const exhausted = evaluateDispatchCandidate(
    facts({
      consumed: [{ workPackageId: WP, field: 'implementationAttempts', consumed: 2 }],
    }),
  );

  expect(unauthorized.kind).toBe('rejected');
  expect(exhausted.kind).toBe('rejected');
  if (unauthorized.kind === 'rejected') {
    expect(unauthorized.rejection.code).toBe('authorization_invalid');
    expect(unauthorized.rejection.message).toContain('Execution Authorization');
  }
  if (exhausted.kind === 'rejected') {
    expect(exhausted.rejection.code).toBe('budget_exhausted');
    expect(exhausted.rejection.budgetKey).toBe(workPackageBudgetKey(WP, 'implementationAttempts'));
  }
});

test('未授权角色在任何副作用前被拒绝，且不相关的零预算不阻止当前动作', () => {
  const roleDenied = evaluateDispatchCandidate(
    facts({ authority: { ...facts().authority, implementation: false } }),
  );
  const unrelatedZeroBudget = evaluateDispatchCandidate(
    facts({
      budget: { ...facts().budget, graphRevisions: 0 },
      requiredBudgetField: 'implementationAttempts',
    }),
  );

  expect(roleDenied.kind).toBe('rejected');
  if (roleDenied.kind === 'rejected') {
    expect(roleDenied.rejection.code).toBe('role_not_authorized');
  }
  expect(unrelatedZeroBudget.kind).toBe('materializable');
});

test('集成复验额度耗尽只影响集成，不阻止普通角色派发', () => {
  // 门禁只看调用方给定的 requiredBudgetField；integrationReconciliations 属于独立额度，
  // 即使已耗尽也不能阻塞与它无关的角色。
  const planner = evaluateDispatchCandidate(
    facts({
      candidateRole: 'planner',
      requiredBudgetField: null,
      budget: { ...facts().budget, integrationReconciliations: 0 },
      consumed: [{ workPackageId: WP, field: 'integrationReconciliations', consumed: 2 }],
    }),
  );
  const implementation = evaluateDispatchCandidate(
    facts({
      budget: { ...facts().budget, integrationReconciliations: 0 },
      consumed: [{ workPackageId: WP, field: 'integrationReconciliations', consumed: 2 }],
    }),
  );

  expect(planner.kind).toBe('materializable');
  expect(implementation.kind).toBe('materializable');
});

test('控制状态不是 active 时不开始新的物化', () => {
  for (const controlState of ['paused', 'blocked', 'cancelled', 'replanning_transition']) {
    const decision = evaluateDispatchCandidate(facts({ controlState }));
    expect(decision.kind).toBe('rejected');
    if (decision.kind === 'rejected') {
      expect(decision.rejection.code).toBe('control_state_not_active');
    }
  }
});

test('缺预算计数的项按 0 处理，上限为 0 的项才被视为耗尽', () => {
  const noConsumption = exhaustedBudgetField({
    candidateWorkPackageId: WP,
    budget: budgetFromLimits(DEFAULT_EXECUTION_LIMITS),
    consumed: [],
  });
  expect(noConsumption).toBeNull();

  const zeroLimit = exhaustedBudgetField({
    candidateWorkPackageId: WP,
    budget: { ...budgetFromLimits(DEFAULT_EXECUTION_LIMITS), graphRevisions: 0 },
    consumed: [],
  });
  expect(zeroLimit).toBe('graphRevisions');
});

test('判定是纯函数：重复求值结果一致且不改变输入', () => {
  const input = facts({
    consumed: [{ workPackageId: WP, field: 'validatorRepairs', consumed: 1 }],
  });
  const snapshot = JSON.stringify(input);
  const first = evaluateDispatchCandidate(input);
  const second = evaluateDispatchCandidate(input);

  expect(second).toEqual(first);
  expect(JSON.stringify(input)).toBe(snapshot);
  expect(WORK_PACKAGE_BUDGET_FIELDS.every((field) => field in input.budget)).toBe(true);
});

test('修订节点只对带匹配许可的 planner 放开：许可指向别处或角色不是 planner 都仍被挡住', () => {
  const permit = { workPackageId: WP, sourceRef: 'patch-1', priorContractRevision: null };
  const planner = evaluateDispatchCandidate(
    facts({ candidateRole: 'planner', revisionPending: [WP], revisionPlanner: permit }),
  );
  expect(planner.kind).toBe('materializable');

  const foreign = evaluateDispatchCandidate(
    facts({
      candidateRole: 'planner',
      revisionPending: [WP],
      revisionPlanner: { workPackageId: WP_OTHER, sourceRef: 'patch-1', priorContractRevision: null },
    }),
  );
  expect(foreign.kind === 'rejected' ? foreign.rejection.code : null).toBe('revision_pending');

  const otherRole = evaluateDispatchCandidate(
    facts({ candidateRole: 'implementation', revisionPending: [WP], revisionPlanner: permit }),
  );
  expect(otherRole.kind === 'rejected' ? otherRole.rejection.code : null).toBe('revision_pending');
});
