/**
 * 候选 Worker 结果的处置与 Retry Attempt 判定测试
 * （change: `m1-execute-and-validate-work-packages`，Owner: IP-B1）。
 *
 * 覆盖 Requirement「Retry Attempt 保持 WorkerTask、contract 与 revision 不变」的四个 Scenario：
 * 结论性失败后新开尝试、重开不重置预算、session 丢失时只走正常重试或阻塞、需要改变 contract 时
 * 不予重试。全部是纯判定，不需要 store 或 backend。
 */

import { expect, test } from 'vitest';

import type { DispatchId, WorkerTaskId, WorkPackageId } from '../../src/application/dto/identity.js';
import {
  decideWorkerResultRecording,
  retryPlanCarriesRecoveryArtifacts,
  type RecordWorkerResultInput,
} from '../../src/application/record-worker-result.js';
import type { BudgetConsumption } from '../../src/domain/dispatch-candidate.js';
import type { RoleAuthorities } from '../../src/domain/planning/execution-authorization.js';
import type { SpecBinding, TaskContract, WorkerBudget } from '../../src/domain/task-contract.js';
import type {
  ClaimedResultAttribution,
  TrustedExecutionFacts,
} from '../../src/domain/worker-result-verification.js';
import { budgetFromLimits, DEFAULT_EXECUTION_LIMITS } from '../../src/domain/planning/budget-policy.js';

const WP = 'wp-1' as WorkPackageId;
const TASK = 'worker-task-1' as WorkerTaskId;
const DISPATCH = 'dispatch-1' as DispatchId;

const AUTHORITY: RoleAuthorities = {
  planner: true,
  implementation: true,
  validator: true,
  finalizer: true,
  gitIntegration: false,
  dependencyChanges: false,
};

const SPEC: SpecBinding = {
  provider: 'openspec',
  relativePath: 'openspec/changes/c/specs/spec.md',
  contentDigest: 'digest-1',
  providerVersion: '0.4.0',
  contractRevision: 3,
  trackingRevision: 5,
};

const CONTRACT: TaskContract = {
  schemaVersion: 1,
  workPackageId: WP,
  graphGeneration: 1,
  dependencies: [],
  scopeEnvelope: { include: ['src'], exclude: [] },
  baselineHead: 'abcdef01',
  authority: AUTHORITY,
  budget: budgetFromLimits(DEFAULT_EXECUTION_LIMITS),
  acceptanceEvidence: [{ evidenceKind: 'command', coveredPaths: ['src'] }],
  resultSchemaVersion: 1,
};

const BUDGET: WorkerBudget = { implementationAttempts: 2, validatorRepairs: 2, recoveries: 1 };

const CONSUMED: readonly BudgetConsumption[] = [{ workPackageId: WP, field: 'implementationAttempts', consumed: 1 }];

const TRUSTED: TrustedExecutionFacts = {
  runId: 'run-1',
  consumerGeneration: 1,
  graphGeneration: 1,
  authorizationId: 'auth-1',
  workerTaskId: TASK,
  dispatchId: DISPATCH,
  attemptId: 'attempt-1',
  role: 'implementation',
  specBinding: SPEC,
  worktreeId: 'wt-1',
  authority: AUTHORITY,
  scopeEnvelope: { include: ['src'], exclude: [] },
  changedPaths: ['src/a.ts'],
};

const CLAIMED: ClaimedResultAttribution = {
  runId: 'run-1',
  consumerGeneration: 1,
  graphGeneration: 1,
  authorizationId: 'auth-1',
  workerTaskId: TASK,
  dispatchId: DISPATCH,
  attemptId: 'attempt-1',
  role: 'implementation',
  specBinding: SPEC,
  worktreeId: 'wt-1',
};

function input(overrides: Partial<RecordWorkerResultInput> = {}): RecordWorkerResultInput {
  return {
    claimed: CLAIMED,
    trusted: TRUSTED,
    attemptOutcome: 'conclusive_failure',
    contractChange: null,
    retry: {
      allowed: true,
      reason: '正常 Retry Attempt 条件成立',
      newDispatchId: 'dispatch-2' as DispatchId,
      newAttemptId: 'attempt-2',
      retryOfDispatchId: DISPATCH,
    },
    taskContract: CONTRACT,
    specBinding: SPEC,
    budget: BUDGET,
    consumedBudgets: CONSUMED,
    ...overrides,
  };
}

test('结论性失败后新开尝试，且沿用同一 contract 与 revision', () => {
  const recording = decideWorkerResultRecording(input());

  expect(recording.kind).toBe('retry');
  if (recording.kind !== 'retry') {
    return;
  }
  expect(recording.plan.workerTaskId).toBe(TASK);
  expect(recording.plan.newDispatchId).toBe('dispatch-2');
  expect(recording.plan.newAttemptId).toBe('attempt-2');
  expect(recording.plan.retryOfDispatchId).toBe(DISPATCH);
  expect(recording.plan.taskContract).toBe(CONTRACT);
  expect(recording.plan.specBinding).toBe(SPEC);
  expect(recording.plan.independentFromPreviousSession).toBe(true);
});

test('重开不重置预算', () => {
  const recording = decideWorkerResultRecording(input({ attemptOutcome: 'interrupted' }));

  expect(recording.kind).toBe('retry');
  if (recording.kind !== 'retry') {
    return;
  }
  expect(recording.plan.consumedBudgets).toEqual(CONSUMED);
  expect(recording.plan.budget).toBe(BUDGET);
});

test('session 丢失且正常重试条件成立时只新建独立尝试，不产生恢复产物', () => {
  const recording = decideWorkerResultRecording(input({ attemptOutcome: 'session_lost' }));

  expect(recording.kind).toBe('retry');
  if (recording.kind !== 'retry') {
    return;
  }
  expect(retryPlanCarriesRecoveryArtifacts(recording.plan)).toBe(false);
  expect(Object.hasOwn(recording.plan, 'capsuleRef')).toBe(false);
  expect(Object.hasOwn(recording.plan, 'recoveryBudget')).toBe(false);
  // 新尝试是独立尝试：沿用 contract，但与原 session 无关。
  expect(recording.plan.taskContract).toBe(CONTRACT);
});

test('session 丢失且正常重试条件不成立时形成 blocker', () => {
  const recording = decideWorkerResultRecording(
    input({
      attemptOutcome: 'session_lost',
      retry: {
        allowed: false,
        reason: '会话已不可核验，且没有可用的实现尝试预算',
        newDispatchId: 'dispatch-2' as DispatchId,
        newAttemptId: 'attempt-2',
        retryOfDispatchId: DISPATCH,
      },
    }),
  );

  expect(recording.kind).toBe('blocked');
  if (recording.kind !== 'blocked') {
    return;
  }
  expect(recording.blockerRef).toContain('dispatch-1');
});

test('需要改变 contract 时不按 Retry Attempt 处理', () => {
  const recording = decideWorkerResultRecording(
    input({ contractChange: { required: true, reason: '验收标准需要改写' } }),
  );

  expect(recording).toEqual({ kind: 'contract_revision_required', reason: '验收标准需要改写' });
});

test('session 丢失且需要改变 contract 时同样走修订路径', () => {
  const recording = decideWorkerResultRecording(
    input({
      attemptOutcome: 'session_lost',
      contractChange: { required: true, reason: 'Scope Envelope 需要扩大' },
    }),
  );

  expect(recording.kind).toBe('contract_revision_required');
});

test('当前代际的完成报告允许记录 Accepted Worker Result', () => {
  const recording = decideWorkerResultRecording(input({ attemptOutcome: 'completed' }));

  expect(recording.kind).toBe('recorded');
});

test('旧代际报告只补历史', () => {
  const recording = decideWorkerResultRecording(
    input({ attemptOutcome: 'completed', claimed: { ...CLAIMED, runId: 'run-0' } }),
  );

  expect(recording.kind).toBe('history_only');
});

test('核验不通过的报告被拒绝', () => {
  const recording = decideWorkerResultRecording(
    input({ attemptOutcome: 'completed', claimed: { ...CLAIMED, worktreeId: 'wt-other' } }),
  );

  expect(recording).toMatchObject({ kind: 'rejected' });
});
