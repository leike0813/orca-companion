/**
 * Git 集成授权边界与 canonical HEAD 归属判定测试
 * （change: `m1-execute-and-validate-work-packages`，Owner: IP-B5）。
 *
 * 覆盖 Requirement「集成操作限制在授权范围内」的两个 Scenario，以及未归属变化的纯规则部分。
 */

import { expect, test } from 'vitest';

import {
  classifyCanonicalHead,
  evaluateGitIntegration,
  type GitIntegrationRequest,
} from '../../src/domain/git-integration-policy.js';
import type { GitIntegrationPolicy, RoleAuthorities } from '../../src/domain/planning/execution-authorization.js';

const POLICY: GitIntegrationPolicy = {
  canonicalBranch: 'main',
  remotes: ['origin'],
  refs: ['refs/heads/main'],
  allowForcePush: false,
};

const AUTHORITY: RoleAuthorities = {
  planner: false,
  implementation: true,
  validator: true,
  finalizer: true,
  gitIntegration: true,
  dependencyChanges: false,
};

function request(overrides: Partial<GitIntegrationRequest> = {}): GitIntegrationRequest {
  return { kind: 'integrate_canonical', remote: 'origin', ref: 'refs/heads/main', branch: 'main', ...overrides };
}

function evaluate(
  overrides: Partial<GitIntegrationRequest> = {},
  authority: RoleAuthorities = AUTHORITY,
) {
  return evaluateGitIntegration({ policy: POLICY, authority, request: request(overrides) });
}

test('授权内的普通集成被允许', () => {
  expect(evaluate().kind).toBe('authorized');
  expect(evaluate({ kind: 'commit', remote: null, ref: null }).kind).toBe('authorized');
});

test('force-push 被拒绝并报告越界部分', () => {
  const decision = evaluate({ kind: 'force_push' });

  expect(decision).toMatchObject({ kind: 'denied', code: 'force_push_not_permitted' });
  expect(decision.kind === 'denied' ? decision.outOfScope : []).toEqual(['force-push']);
});

test.each([['publish'], ['deploy'], ['history_rewrite']] as const)('%s 永远需要单独授权', (kind) => {
  expect(evaluate({ kind })).toMatchObject({ kind: 'denied', code: 'reserved_operation' });
});

test('Manifest 未授权 Git 集成时拒绝', () => {
  expect(evaluate({}, { ...AUTHORITY, gitIntegration: false })).toMatchObject({
    kind: 'denied',
    code: 'git_integration_not_authorized',
  });
});

test('未获批的 remote 与 ref 被拒绝，并报告越界部分', () => {
  const remote = evaluate({ remote: 'upstream' });
  expect(remote).toMatchObject({ kind: 'denied', code: 'remote_not_approved' });
  expect(remote.kind === 'denied' ? remote.outOfScope : []).toEqual(['upstream']);

  const ref = evaluate({ ref: 'refs/heads/release' });
  expect(ref).toMatchObject({ kind: 'denied', code: 'ref_not_approved' });
  expect(ref.kind === 'denied' ? ref.outOfScope : []).toEqual(['refs/heads/release']);
});

test('非 canonical 分支被拒绝', () => {
  expect(evaluate({ branch: 'feature/x' })).toMatchObject({ kind: 'denied', code: 'branch_not_canonical' });
});

test('集成 canonical 分支缺少 remote 或 ref 时拒绝', () => {
  expect(evaluate({ remote: null })).toMatchObject({ kind: 'denied', code: 'missing_remote' });
  expect(evaluate({ ref: null })).toMatchObject({ kind: 'denied', code: 'missing_ref' });
});

test('canonical HEAD 与最近一条集成记录一致时归属成立', () => {
  expect(
    classifyCanonicalHead({
      canonicalHead: 'bbbb',
      authorizedBaselineHead: 'aaaa',
      canonicalWorktreeDirty: false,
      lastIntegrationExpectedHead: 'bbbb',
    }).kind,
  ).toBe('attributed');
});

test('canonical HEAD 无对应集成记录时判定为未归属变化', () => {
  const drift = classifyCanonicalHead({
    canonicalHead: 'bbbb',
    authorizedBaselineHead: 'aaaa',
    canonicalWorktreeDirty: false,
    lastIntegrationExpectedHead: null,
  });

  expect(drift).toMatchObject({ kind: 'unattributed_drift', pauseDispatch: true });
  // HEAD 未前进且仍等于 baseline 时归属成立。
  expect(
    classifyCanonicalHead({
      canonicalHead: 'aaaa',
      authorizedBaselineHead: 'aaaa',
      canonicalWorktreeDirty: false,
      lastIntegrationExpectedHead: null,
    }).kind,
  ).toBe('attributed');
});

test('canonical worktree 有未归属改动时暂停派发', () => {
  expect(
    classifyCanonicalHead({
      canonicalHead: 'aaaa',
      authorizedBaselineHead: 'aaaa',
      canonicalWorktreeDirty: true,
      lastIntegrationExpectedHead: null,
    }),
  ).toMatchObject({ kind: 'unattributed_drift', pauseDispatch: true });
});
