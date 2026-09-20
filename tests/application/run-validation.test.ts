/**
 * Validator 同会话验证链测试
 * （change: `m1-execute-and-validate-work-packages`，Owner: IP-B3/B4）。
 *
 * 覆盖 Requirement「Validator 以独立角色验证并复用同一真实会话」的三个 Scenario 与
 * 「修复限定在授权范围与修复预算内，且证据与预算归属不被掩盖」的后两个 Scenario。
 *
 * 步骤执行由注入的 runner 模拟：这些路径本就是会话丢失、越界修复与预算耗尽的故障路径。
 */

import { expect, test } from 'vitest';

import type {
  DispatchId,
  ValidationAttemptId,
  WorkPackageId,
  WorkerTaskId,
} from '../../src/application/dto/identity.js';
import {
  runValidation,
  validationSessionLostOutcome,
  type RunValidationInput,
  type ValidatorStepRequest,
  type ValidatorStepResult,
} from '../../src/application/run-validation.js';
import { retryPlanCarriesRecoveryArtifacts } from '../../src/application/record-worker-result.js';
import type { RoleAuthorities, WorkerRole } from '../../src/domain/planning/execution-authorization.js';
import type { ScopeEnvelope } from '../../src/domain/planning/execution-graph.js';
import { budgetFromLimits, DEFAULT_EXECUTION_LIMITS } from '../../src/domain/planning/budget-policy.js';
import type { SessionBinding, SpecBinding, TaskContract } from '../../src/domain/task-contract.js';
import type { EvidenceRecord } from '../../src/domain/worker-report.js';
import type {
  ClaimedResultAttribution,
  TrustedExecutionFacts,
} from '../../src/domain/worker-result-verification.js';

const WP = 'wp-1' as WorkPackageId;
const TASK = 'worker-task-1' as WorkerTaskId;
const DISPATCH = 'dispatch-1' as DispatchId;
const VALIDATION = 'validation-1' as ValidationAttemptId;

const AUTHORITY: RoleAuthorities = {
  planner: false,
  implementation: true,
  validator: true,
  finalizer: true,
  gitIntegration: false,
  dependencyChanges: false,
};

const SCOPE_ENVELOPE: ScopeEnvelope = { include: ['src'], exclude: [] };

const SESSION: SessionBinding = {
  harness: 'codex',
  role: 'validator',
  workerTaskId: TASK,
  dispatchId: DISPATCH,
  attemptId: 'attempt-1',
  providerSessionId: 'provider-session-1',
  transcriptRef: 'transcript-1',
  observedAt: '2026-09-21T00:00:00.000Z',
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
  scopeEnvelope: SCOPE_ENVELOPE,
  baselineHead: 'abcdef01',
  authority: AUTHORITY,
  budget: budgetFromLimits(DEFAULT_EXECUTION_LIMITS),
  acceptanceEvidence: [{ evidenceKind: 'command', coveredPaths: ['src'] }],
  resultSchemaVersion: 1,
};

function evidence(id: string, coveredPaths: readonly string[]): EvidenceRecord {
  return { evidenceId: id, kind: 'command', coveredPaths, command: 'pnpm test', summary: 'ok', outcome: 'passed' };
}

/** 按脚本依次返回结果，并记录每次请求，便于断言会话复用。 */
function scriptedRunner(script: readonly ValidatorStepResult[]): {
  readonly runStep: (request: ValidatorStepRequest) => Promise<ValidatorStepResult>;
  readonly requests: readonly ValidatorStepRequest[];
} {
  const requests: ValidatorStepRequest[] = [];
  return {
    requests,
    runStep: (request) => {
      requests.push(request);
      const next = script[requests.length - 1];
      if (next === undefined) {
        throw new Error('脚本没有为这次步骤提供结果');
      }
      return Promise.resolve(next);
    },
  };
}

function input(overrides: Partial<RunValidationInput> = {}): RunValidationInput {
  return {
    runStep: () => Promise.resolve({ kind: 'step_failed', code: 'unused', message: 'unused' }),
    implementerRole: 'implementation',
    validatorRole: 'validator',
    authority: AUTHORITY,
    workPackageId: WP,
    workerTaskId: TASK,
    dispatchId: DISPATCH,
    validationAttemptId: VALIDATION,
    sessionBinding: SESSION,
    scopeEnvelope: SCOPE_ENVELOPE,
    repairBudget: { limit: 2, consumed: 0 },
    implementationBudget: { limit: 2, consumed: 1 },
    evidence: [],
    maxSteps: 6,
    ...overrides,
  };
}

test('独立角色执行验证，通过后返回结论', async () => {
  const runner = scriptedRunner([
    {
      kind: 'verified',
      outcome: 'passed',
      evidence: [evidence('ev-1', ['src'])],
      summary: '验证通过',
      sessionBinding: SESSION,
      repairIntent: null,
    },
  ]);

  const result = await runValidation(input({ runStep: runner.runStep }));

  expect(result.kind).toBe('validated');
  expect(runner.requests.map((request) => request.kind)).toEqual(['verify']);
  expect(runner.requests[0]?.sessionBinding).toBe(SESSION);
});

test('实现者不能自验', async () => {
  const result = await runValidation(input({ validatorRole: 'implementation' as WorkerRole }));

  expect(result).toMatchObject({ kind: 'blocked', code: 'invalid_state' });
});

test('修复与复验复用同一真实会话，并记录消耗的修复预算', async () => {
  const runner = scriptedRunner([
    {
      kind: 'verified',
      outcome: 'failed',
      evidence: [evidence('ev-1', ['src'])],
      summary: '发现缺陷',
      sessionBinding: SESSION,
      repairIntent: { changedPaths: ['src/a.ts'], requiresDesignChange: false, requiresDependencyChange: false },
    },
    { kind: 'repair_applied', changedPaths: ['src/a.ts'], sessionBinding: SESSION, note: '修复' },
    {
      kind: 'verified',
      outcome: 'passed',
      evidence: [evidence('ev-2', ['src/a.ts'])],
      summary: '复验通过',
      sessionBinding: SESSION,
      repairIntent: null,
    },
  ]);

  const result = await runValidation(input({ runStep: runner.runStep }));

  expect(runner.requests.map((request) => request.kind)).toEqual(['verify', 'repair', 'verify']);
  expect(runner.requests.every((request) => request.sessionBinding.providerSessionId === 'provider-session-1')).toBe(
    true,
  );
  expect(result.kind).toBe('validated');
  if (result.kind !== 'validated') {
    return;
  }
  expect(result.repairBudget).toEqual({ limit: 2, consumed: 1 });
  // 验证不重置也不替代实现预算。
  expect(result.implementationBudget).toEqual({ limit: 2, consumed: 1 });
});

test('session 丢失时当前 Attempt 停止推进并形成 blocker', async () => {
  const runner = scriptedRunner([{ kind: 'session_lost', reason: 'transcript 不可引用' }]);

  const result = await runValidation(input({ runStep: runner.runStep }));

  expect(result).toMatchObject({ kind: 'blocked', code: 'session_lost' });
  expect(runner.requests.map((request) => request.kind)).toEqual(['verify']);
});

test('复验返回不同 session 时按 session 丢失处理，不伪装成继续', async () => {
  const runner = scriptedRunner([
    {
      kind: 'verified',
      outcome: 'passed',
      evidence: [evidence('ev-1', ['src'])],
      summary: '结论来自另一个 session',
      sessionBinding: { ...SESSION, providerSessionId: 'provider-session-2' },
      repairIntent: null,
    },
  ]);

  const result = await runValidation(input({ runStep: runner.runStep }));

  expect(result).toMatchObject({ kind: 'blocked', code: 'session_lost' });
});

test('session 丢失后只走正常 Retry Attempt 或阻塞', () => {
  const trusted: TrustedExecutionFacts = {
    runId: 'run-1',
    consumerGeneration: 1,
    graphGeneration: 1,
    authorizationId: 'auth-1',
    workerTaskId: TASK,
    dispatchId: DISPATCH,
    attemptId: 'attempt-1',
    role: 'validator',
    specBinding: SPEC,
    worktreeId: 'wt-1',
    authority: AUTHORITY,
    scopeEnvelope: SCOPE_ENVELOPE,
    changedPaths: ['src/a.ts'],
  };
  const claimed: ClaimedResultAttribution = {
    runId: 'run-1',
    consumerGeneration: 1,
    graphGeneration: 1,
    authorizationId: 'auth-1',
    workerTaskId: TASK,
    dispatchId: DISPATCH,
    attemptId: 'attempt-1',
    role: 'validator',
    specBinding: SPEC,
    worktreeId: 'wt-1',
  };
  const base = {
    claimed,
    trusted,
    contractChange: null,
    taskContract: CONTRACT,
    specBinding: SPEC,
    budget: { implementationAttempts: 2, validatorRepairs: 2, recoveries: 1 },
    consumedBudgets: [],
  };

  const retry = validationSessionLostOutcome({
    ...base,
    retry: {
      allowed: true,
      reason: '正常 Retry Attempt 条件成立',
      newDispatchId: 'dispatch-2' as DispatchId,
      newAttemptId: 'attempt-2',
      retryOfDispatchId: DISPATCH,
    },
  });
  expect(retry.kind).toBe('retry');
  if (retry.kind === 'retry') {
    expect(retryPlanCarriesRecoveryArtifacts(retry.plan)).toBe(false);
    expect(retry.plan.taskContract).toBe(CONTRACT);
  }

  const blocked = validationSessionLostOutcome({
    ...base,
    retry: {
      allowed: false,
      reason: '验证预算已耗尽',
      newDispatchId: 'dispatch-2' as DispatchId,
      newAttemptId: 'attempt-2',
      retryOfDispatchId: DISPATCH,
    },
  });
  expect(blocked.kind).toBe('blocked');
});

test('越界修复要求 Worker Escalation，不接受为验证通过', async () => {
  const runner = scriptedRunner([
    {
      kind: 'verified',
      outcome: 'failed',
      evidence: [evidence('ev-1', ['src'])],
      summary: '需要改文档',
      sessionBinding: SESSION,
      repairIntent: { changedPaths: ['docs/x.md'], requiresDesignChange: false, requiresDependencyChange: false },
    },
  ]);

  const result = await runValidation(input({ runStep: runner.runStep }));

  expect(result).toMatchObject({ kind: 'escalation_required', reason: 'scope' });
  expect(runner.requests.map((request) => request.kind)).toEqual(['verify']);
});

test('修复实际改动路径超出获批意图时要求 Worker Escalation', async () => {
  const runner = scriptedRunner([
    {
      kind: 'verified',
      outcome: 'failed',
      evidence: [evidence('ev-1', ['src'])],
      summary: '发现缺陷',
      sessionBinding: SESSION,
      repairIntent: { changedPaths: ['src/a.ts'], requiresDesignChange: false, requiresDependencyChange: false },
    },
    { kind: 'repair_applied', changedPaths: ['src/b.ts'], sessionBinding: SESSION, note: '改到了其它路径' },
  ]);

  const result = await runValidation(input({ runStep: runner.runStep }));

  expect(result).toMatchObject({ kind: 'escalation_required', reason: 'scope' });
});

test('修复触及的证据立即失效，并要求覆盖该范围的新证据', async () => {
  const existing = [evidence('ev-existing', ['src/a.ts'])];
  const stale = scriptedRunner([
    {
      kind: 'verified',
      outcome: 'failed',
      evidence: [evidence('ev-1', ['src'])],
      summary: '发现缺陷',
      sessionBinding: SESSION,
      repairIntent: { changedPaths: ['src/a.ts'], requiresDesignChange: false, requiresDependencyChange: false },
    },
    { kind: 'repair_applied', changedPaths: ['src/a.ts'], sessionBinding: SESSION, note: '修复' },
    {
      kind: 'verified',
      outcome: 'passed',
      // 复验没有覆盖被改动路径的新证据：结论不能用于推进生命周期。
      evidence: [evidence('ev-2', ['src/other.ts'])],
      summary: '复验通过但证据范围不足',
      sessionBinding: SESSION,
      repairIntent: null,
    },
  ]);

  const missing = await runValidation(input({ runStep: stale.runStep, evidence: existing }));
  expect(missing).toMatchObject({ kind: 'blocked', code: 'evidence_missing' });

  const fresh = scriptedRunner([
    {
      kind: 'verified',
      outcome: 'failed',
      evidence: [evidence('ev-1', ['src'])],
      summary: '发现缺陷',
      sessionBinding: SESSION,
      repairIntent: { changedPaths: ['src/a.ts'], requiresDesignChange: false, requiresDependencyChange: false },
    },
    { kind: 'repair_applied', changedPaths: ['src/a.ts'], sessionBinding: SESSION, note: '修复' },
    {
      kind: 'verified',
      outcome: 'passed',
      evidence: [evidence('ev-2', ['src/a.ts'])],
      summary: '复验通过',
      sessionBinding: SESSION,
      repairIntent: null,
    },
  ]);

  const validated = await runValidation(input({ runStep: fresh.runStep, evidence: existing }));
  expect(validated.kind).toBe('validated');
  if (validated.kind === 'validated') {
    // 失效的旧证据不再出现在结论里，只保留复验取得的新证据。
    expect(validated.evidence.map((record) => record.evidenceId)).toEqual(['ev-2']);
  }
});

test('验证修复预算耗尽后阻塞并给出预算键', async () => {
  const runner = scriptedRunner([
    {
      kind: 'verified',
      outcome: 'failed',
      evidence: [evidence('ev-1', ['src'])],
      summary: '仍有缺陷',
      sessionBinding: SESSION,
      repairIntent: { changedPaths: ['src/a.ts'], requiresDesignChange: false, requiresDependencyChange: false },
    },
  ]);

  const result = await runValidation(
    input({ runStep: runner.runStep, repairBudget: { limit: 1, consumed: 1 } }),
  );

  expect(result).toMatchObject({
    kind: 'blocked',
    code: 'budget_exhausted',
    budgetKey: 'work-package:wp-1:validatorRepairs',
  });
});
