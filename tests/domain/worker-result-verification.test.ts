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
  projectChangedPaths,
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

test('Planner 的规格在报告后接纳：报告可不携带尚未存在的 Binding', () => {
  expect(verifyWorkerResult(
    claimed({ role: 'planner', specBinding: null }),
    trusted({ role: 'planner' }),
  ).kind).toBe('accepted');
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

test('工具状态目录里的报告不算项目改动，也不构成越界', () => {
  const verification = verifyWorkerResult(
    claimed(),
    trusted({
      changedPaths: ['src/domain/a.ts', '.agents/validator-report.md', '.codex/sessions/rollout.jsonl'],
    }),
  );

  expect(verification.kind).toBe('accepted');
  expect(verification.kind === 'accepted' ? verification.attribution.changedPaths : []).toEqual([
    'src/domain/a.ts',
  ]);
});

test('projectChangedPaths 只排除完整目录前缀，不吞掉同名前缀的项目路径', () => {
  expect(
    projectChangedPaths([
      '.agents/skills/openspec-x/SKILL.md',
      '.agents',
      '.codex/sessions/a.jsonl',
      '.agentsx/keep.ts',
      'src/domain/a.ts',
    ]),
  ).toEqual(['.agentsx/keep.ts', 'src/domain/a.ts']);
});

test('Specification Pipeline 的规格树不受 Scope Envelope 约束', () => {
  // Planner 必须把单元写在 openspec/changes/…，而 Work Package 的范围通常是项目源码：流程工件不算越界。
  const verification = verifyWorkerResult(
    claimed(),
    trusted({
      changedPaths: [
        'src/domain/a.ts',
        'openspec/changes/e2e-scope-g1-ticket-c0e65d23/proposal.md',
        'openspec/changes/e2e-scope-g1-ticket-c0e65d23/specs/execution/spec.md',
        'openspec/changes/archive/2026-09-24-e2e-scope-g1-ticket-c0e65d23/tasks.md',
        // 工具自己维护的配置与同步后的主规格同属流程目录。
        'openspec/config.yaml',
        'openspec/specs/execution/spec.md',
      ],
    }),
  );

  expect(verification.kind).toBe('accepted');
});

test('流程目录之外的项目改动仍然越界', () => {
  const verification = verifyWorkerResult(
    claimed(),
    trusted({ changedPaths: ['src/domain/a.ts', 'openspec/changes/x/tasks.md', 'docs/out-of-scope.md'] }),
  );

  expect(verification).toMatchObject({ kind: 'rejected', code: 'scope_envelope_violation' });
  expect(verification.kind === 'rejected' ? verification.mismatches : []).toEqual(['docs/out-of-scope.md']);
});
