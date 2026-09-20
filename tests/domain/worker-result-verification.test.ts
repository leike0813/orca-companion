/**
 * Worker 结果核验的纯函数测试
 * （change: `m1-execute-and-validate-work-packages`，Owner: IP-B1）。
 *
 * 覆盖 Requirement「Worker 报告在身份与代际核验后才成为 Accepted Worker Result」的两个 Scenario：
 * 当前代际的报告通过核验；旧代际或已被取代的尝试只补历史，不推进当前流程。
 */

import { expect, test } from 'vitest';

import type { DispatchId, WorkerTaskId } from '../../src/application/dto/identity.js';
import type { RoleAuthorities, WorkerRole } from '../../src/domain/planning/execution-authorization.js';
import type { ScopeEnvelope } from '../../src/domain/planning/execution-graph.js';
import type { SpecBinding } from '../../src/domain/task-contract.js';
import {
  resultAdvancesLifecycle,
  verifyWorkerResult,
  type ClaimedResultAttribution,
  type TrustedExecutionFacts,
} from '../../src/domain/worker-result-verification.js';

const TASK_1 = 'task-1' as WorkerTaskId;
const DISPATCH_1 = 'dispatch-1' as DispatchId;

const AUTHORITY: RoleAuthorities = {
  planner: true,
  implementation: true,
  validator: false,
  finalizer: true,
  gitIntegration: false,
  dependencyChanges: false,
};

const SCOPE_ENVELOPE: ScopeEnvelope = { include: ['src'], exclude: ['src/generated'] };

const SPEC: SpecBinding = {
  provider: 'openspec',
  relativePath: 'openspec/changes/c/specs/spec.md',
  contentDigest: 'digest-1',
  providerVersion: '0.4.0',
  contractRevision: 3,
  trackingRevision: 5,
};

function trusted(overrides: Partial<TrustedExecutionFacts> = {}): TrustedExecutionFacts {
  return {
    runId: 'run-1',
    consumerGeneration: 7,
    graphGeneration: 1,
    authorizationId: 'auth-1',
    workerTaskId: TASK_1,
    dispatchId: DISPATCH_1,
    attemptId: 'attempt-1',
    role: 'implementation',
    specBinding: SPEC,
    worktreeId: 'wt-1',
    authority: { ...AUTHORITY, validator: true },
    scopeEnvelope: SCOPE_ENVELOPE,
    changedPaths: ['src/domain/a.ts'],
    ...overrides,
  };
}

function claimed(overrides: Partial<ClaimedResultAttribution> = {}): ClaimedResultAttribution {
  return {
    runId: 'run-1',
    consumerGeneration: 7,
    graphGeneration: 1,
    authorizationId: 'auth-1',
    workerTaskId: TASK_1,
    dispatchId: DISPATCH_1,
    attemptId: 'attempt-1',
    role: 'implementation',
    specBinding: SPEC,
    worktreeId: 'wt-1',
    ...overrides,
  };
}

test('当前代际的报告通过核验', () => {
  const verification = verifyWorkerResult(claimed(), trusted());

  expect(verification).toEqual({
    kind: 'accepted',
    attribution: {
      runId: 'run-1',
      consumerGeneration: 7,
      workerTaskId: 'task-1',
      dispatchId: 'dispatch-1',
      attemptId: 'attempt-1',
      role: 'implementation',
      changedPaths: ['src/domain/a.ts'],
    },
  });
  expect(resultAdvancesLifecycle(verification)).toBe(true);
});

test('上一代际 Run 的报告降级为 stale，不推进当前流程', () => {
  const verification = verifyWorkerResult(claimed({ runId: 'run-0' }), trusted());

  expect(verification.kind).toBe('stale_generation');
  expect(resultAdvancesLifecycle(verification)).toBe(false);
});

test('已自增 consumer generation 的报告降级为 stale', () => {
  const verification = verifyWorkerResult(claimed({ consumerGeneration: 6 }), trusted());

  expect(verification.kind).toBe('stale_generation');
});

test('已被取代的 Dispatch 与 Attempt 只补历史', () => {
  const verification = verifyWorkerResult(
    claimed({ dispatchId: 'dispatch-0' as DispatchId, attemptId: 'attempt-0' }),
    trusted(),
  );

  expect(verification.kind).toBe('stale_attempt');
  expect(resultAdvancesLifecycle(verification)).toBe(false);
});

test('缺少归属字段的报告被拒绝', () => {
  const verification = verifyWorkerResult(claimed({ worktreeId: null, attemptId: null }), trusted());

  expect(verification).toMatchObject({ kind: 'rejected', code: 'missing_attribution' });
});

test.each([
  ['role', claimed({ role: 'validator' as WorkerRole }), 'role_mismatch'],
  ['specBinding', claimed({ specBinding: { ...SPEC, contentDigest: 'digest-2' } }), 'spec_binding_mismatch'],
  ['worktreeId', claimed({ worktreeId: 'wt-2' }), 'worktree_mismatch'],
] satisfies readonly (readonly [string, ClaimedResultAttribution, string])[])(
  '%s 不一致时报告被拒绝',
  (_field, report, code) => {
    expect(verifyWorkerResult(report, trusted())).toMatchObject({ kind: 'rejected', code });
  },
);

test('Manifest 未授权的角色不能提交结果', () => {
  const verification = verifyWorkerResult(
    claimed(),
    trusted({ authority: { ...AUTHORITY, implementation: false } }),
  );

  expect(verification).toMatchObject({ kind: 'rejected', code: 'role_not_authorized' });
});

test('改动越出 Scope Envelope 的报告被拒绝', () => {
  const verification = verifyWorkerResult(
    claimed(),
    trusted({ changedPaths: ['src/domain/a.ts', 'docs/x.md', 'src/generated/b.ts'] }),
  );

  expect(verification).toMatchObject({ kind: 'rejected', code: 'scope_envelope_violation' });
  expect(verification.kind === 'rejected' ? verification.mismatches : []).toEqual([
    'docs/x.md',
    'src/generated/b.ts',
  ]);
});
