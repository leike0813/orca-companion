/**
 * 派发前 Unattributed Drift 检查测试
 * （change: `m1-execute-and-validate-work-packages`，Owner: IP-B6）。
 *
 * 覆盖 Requirement「未归属的 canonical 分支变化暂停派发」的 Scenario：HEAD 前进但没有可归属的
 * Integration Operation 记录时返回暂停结论，且不产生任何 mutation。
 */

import { expect, test } from 'vitest';

import type { WorkPackageId } from '../../src/application/dto/identity.js';
import {
  evaluateDispatchGuard,
  guardDispatchCandidate,
} from '../../src/application/dispatch-guard.js';
import type { DispatchCandidateFacts } from '../../src/domain/dispatch-candidate.js';
import type { RoleAuthorities } from '../../src/domain/planning/execution-authorization.js';

const WP = 'wp-1' as WorkPackageId;

const AUTHORITY: RoleAuthorities = {
  planner: false,
  implementation: true,
  validator: true,
  finalizer: true,
  gitIntegration: false,
  dependencyChanges: false,
};

const BASELINE = 'aaaa00000000000000000000000000000000000000';
const ADVANCED = 'bbbb00000000000000000000000000000000000000';

function candidate(): DispatchCandidateFacts {
  return {
    candidateWorkPackageId: WP,
    candidateRole: 'implementation',
    lifecycleStage: 'frontier',
    selectedCandidateId: WP,
    dependenciesSatisfied: [WP],
    controlState: 'active',
    authorization: { valid: true, authorizationId: 'auth-1', authorizationVersion: 1, reason: null },
    authority: AUTHORITY,
    budget: {
      implementationAttempts: 2,
      validatorRepairs: 2,
      graphRevisions: 2,
      specificationRevisions: 2,
      maxRecoveriesPerWorkerAttempt: 1,
    },
    consumed: [],
    requiredBudgetField: 'implementationAttempts',
    scopeEnvelope: { include: ['src'], exclude: [] },
  };
}

test('canonical HEAD 前进而无对应集成记录时暂停派发', () => {
  const decision = evaluateDispatchGuard({
    canonicalHead: ADVANCED,
    authorizedBaselineHead: BASELINE,
    canonicalWorktreeDirty: false,
    lastIntegrationExpectedHead: null,
  });

  expect(decision).toMatchObject({ kind: 'paused', code: 'unattributed_drift', pauseDispatch: true });
});

test('HEAD 与已完成的 Integration Operation 一致时放行', () => {
  expect(
    evaluateDispatchGuard({
      canonicalHead: ADVANCED,
      authorizedBaselineHead: BASELINE,
      canonicalWorktreeDirty: false,
      lastIntegrationExpectedHead: ADVANCED,
    }).kind,
  ).toBe('clear');
});

test('未归属变化时不进入候选判定，也不产生任何 mutation', () => {
  const facts = candidate();
  const decision = guardDispatchCandidate({
    guard: { canonicalHead: ADVANCED, authorizedBaselineHead: BASELINE, canonicalWorktreeDirty: false, lastIntegrationExpectedHead: null },
    candidate: facts,
  });

  expect(decision.kind).toBe('paused');
  // 判定是纯函数：候选事实没有被改写。
  expect(facts.lifecycleStage).toBe('frontier');
  expect(facts.consumed).toHaveLength(0);
});

test('归属成立时沿用前驱的候选判定结论', () => {
  const allowed = guardDispatchCandidate({
    guard: { canonicalHead: BASELINE, authorizedBaselineHead: BASELINE, canonicalWorktreeDirty: false, lastIntegrationExpectedHead: null },
    candidate: candidate(),
  });
  expect(allowed).toMatchObject({ kind: 'materializable', workPackageId: WP });

  const rejected = guardDispatchCandidate({
    guard: { canonicalHead: BASELINE, authorizedBaselineHead: BASELINE, canonicalWorktreeDirty: false, lastIntegrationExpectedHead: null },
    candidate: { ...candidate(), lifecycleStage: 'implementing' },
  });
  expect(rejected).toMatchObject({ kind: 'rejected', rejection: { code: 'lifecycle_not_frontier' } });
});

test('canonical worktree 有未归属改动时暂停派发', () => {
  expect(
    evaluateDispatchGuard({
      canonicalHead: BASELINE,
      authorizedBaselineHead: BASELINE,
      canonicalWorktreeDirty: true,
      lastIntegrationExpectedHead: null,
    }),
  ).toMatchObject({ kind: 'paused', code: 'unattributed_drift' });
});
