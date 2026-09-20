/**
 * IC-08 / IP-B3、IP-B4：独立 Validator 的「验证—范围内修复—复验」链
 * （Owner: `m1-execute-and-validate-work-packages`）。
 *
 * 这个用例把一条验证链固定在同一个真实 harness session 内：每一步都要求返回可核验的 Session
 * Binding，任何一步给出不同的 session 都按「session 丢失」处理，而不是把新 session 当作原
 * Validation Attempt 的继续。session 丢失只产生 blocker，或交给调用方按正常 Retry Attempt 重开
 * ——本 change 没有 Worker Session Recovery 能力，因此这里不生成 Capsule、不记录也不消耗
 * Recovery Budget。
 *
 * 修复只在已授权范围与修复预算内直接执行：改动路径必须落在 Scope Envelope 内，需要设计或依赖变更
 * 时以 Worker Escalation 上报。修复触及某条 Evidence Record 覆盖的路径时，该记录立即失效，验证
 * 结论必须带上覆盖该范围的新证据。验证修复预算与实现预算各自独立计数，互不替代、互不重置。
 *
 * 步骤执行由注入的 runner 完成（真实实现是 Worker Harness Adapter）：本模块只拥有顺序与准入规则。
 */

import type { DispatchId, ValidationAttemptId, WorkPackageId, WorkerTaskId } from './dto/identity.js';
import { workPackageBudgetKey } from '../domain/dispatch-candidate.js';
import type { RoleAuthorities, WorkerRole } from '../domain/planning/execution-authorization.js';
import type { ScopeEnvelope } from '../domain/planning/execution-graph.js';
import { evaluateRepairScope } from '../domain/repair-scope.js';
import type { SessionBinding } from '../domain/task-contract.js';
import {
  evidenceIsBounded,
  invalidateEvidence,
  pathTouchesCoverage,
  type EscalationReason,
  type EvidenceRecord,
} from '../domain/worker-report.js';
import { decideWorkerResultRecording, type WorkerResultRecording } from './record-worker-result.js';

export type ValidationStepKind = 'verify' | 'repair';

/** 一次修复意图；由 Validator 的失败结论给出，决定这次修复是否被允许直接执行。 */
export type RepairIntent = {
  readonly changedPaths: readonly string[];
  readonly requiresDesignChange: boolean;
  readonly requiresDependencyChange: boolean;
};

export type ValidatorStepRequest = {
  readonly kind: ValidationStepKind;
  /** 该 Worker Task 的同一真实 harness session；修复与复验必须与之一致。 */
  readonly sessionBinding: SessionBinding;
  readonly workPackageId: WorkPackageId;
  readonly workerTaskId: WorkerTaskId;
  readonly dispatchId: DispatchId;
  readonly validationAttemptId: ValidationAttemptId;
  /** 仅修复步骤携带。 */
  readonly repairIntent: RepairIntent | null;
};

export type ValidatorStepResult =
  | {
      readonly kind: 'verified';
      readonly outcome: 'passed' | 'failed';
      readonly evidence: readonly EvidenceRecord[];
      readonly summary: string;
      readonly sessionBinding: SessionBinding;
      /** 验证失败时给出的修复意图；通过时为 `null`。 */
      readonly repairIntent: RepairIntent | null;
    }
  | {
      readonly kind: 'repair_applied';
      readonly changedPaths: readonly string[];
      readonly sessionBinding: SessionBinding;
      readonly note: string;
    }
  /** harness session 已不可继续：当前 Validation Attempt 必须停止推进。 */
  | { readonly kind: 'session_lost'; readonly reason: string }
  | { readonly kind: 'escalation'; readonly reason: EscalationReason; readonly request: string }
  | { readonly kind: 'step_failed'; readonly code: string; readonly message: string };

/** 步骤执行 seam；真实实现是 Worker Harness Adapter。 */
export type ValidatorStepRunner = (request: ValidatorStepRequest) => Promise<ValidatorStepResult>;

export type RepairBudgetState = {
  readonly limit: number;
  readonly consumed: number;
};

export type RunValidationInput = {
  readonly runStep: ValidatorStepRunner;
  /** 实际写出该实现的角色；必须与 Validator 不同。 */
  readonly implementerRole: WorkerRole;
  readonly validatorRole: WorkerRole;
  readonly authority: RoleAuthorities;
  readonly workPackageId: WorkPackageId;
  readonly workerTaskId: WorkerTaskId;
  readonly dispatchId: DispatchId;
  readonly validationAttemptId: ValidationAttemptId;
  /** 验证链起始的真实 Session Binding；全程不允许替换。 */
  readonly sessionBinding: SessionBinding;
  readonly scopeEnvelope: ScopeEnvelope;
  readonly repairBudget: RepairBudgetState;
  /** 只用于断言独立：验证链绝不重置或消耗实现预算。 */
  readonly implementationBudget: RepairBudgetState;
  /** 派发前已有的证据记录。 */
  readonly evidence: readonly EvidenceRecord[];
  /** 有限循环上限；与修复预算共同保证链一定终止。 */
  readonly maxSteps: number;
};

export type ValidationBlockCode = 'session_lost' | 'budget_exhausted' | 'evidence_missing' | 'invalid_state';

export type RunValidationResult =
  | {
      readonly kind: 'validated';
      readonly evidence: readonly EvidenceRecord[];
      readonly sessionBindingId: string;
      readonly repairBudget: RepairBudgetState;
      /** 原样回带：验证不改变实现预算。 */
      readonly implementationBudget: RepairBudgetState;
      readonly steps: number;
    }
  | {
      readonly kind: 'escalation_required';
      readonly reason: EscalationReason;
      readonly request: string;
      readonly sessionBindingId: string;
    }
  | {
      readonly kind: 'blocked';
      readonly code: ValidationBlockCode;
      readonly reason: string;
      readonly blockerRef: string;
      readonly budgetKey: string | null;
    }
  | { readonly kind: 'step_failed'; readonly code: string; readonly message: string };

/** 两步是否属于同一个真实 session；任何一项不同都不能当作同一条验证链。 */
export function sessionBindingMatches(expected: SessionBinding, observed: SessionBinding): boolean {
  return (
    expected.harness === observed.harness &&
    expected.role === observed.role &&
    expected.workerTaskId === observed.workerTaskId &&
    expected.dispatchId === observed.dispatchId &&
    expected.attemptId === observed.attemptId &&
    expected.providerSessionId === observed.providerSessionId
  );
}

/** 失效路径是否被新证据覆盖：每条路径都必须落在某条通过且有限的证据覆盖范围内。 */
export function evidenceCoversPaths(
  evidence: readonly EvidenceRecord[],
  paths: readonly string[],
): readonly string[] {
  const uncovered: string[] = [];
  for (const path of paths) {
    const covered = evidence.some(
      (record) =>
        record.outcome === 'passed' &&
        evidenceIsBounded(record) &&
        record.coveredPaths.some((coveredPath) => pathTouchesCoverage(coveredPath, path)),
    );
    if (!covered) {
      uncovered.push(path);
    }
  }
  return uncovered;
}

function blockerRef(input: RunValidationInput, suffix: string): string {
  return `${suffix}:${input.dispatchId}:${input.validationAttemptId}`;
}

/**
 * 执行一条验证链。
 *
 * 循环一定会终止：修复次数受修复预算约束，总步数受 `maxSteps` 约束。任何越界、越权或 session
 * 不匹配的情形都以阻塞或升级结束，绝不降级成「验证通过」。
 */
export async function runValidation(input: RunValidationInput): Promise<RunValidationResult> {
  if (input.validatorRole !== 'validator' || input.validatorRole === input.implementerRole) {
    return {
      kind: 'blocked',
      code: 'invalid_state',
      reason: '验证必须由独立于实现者的 validator 角色执行',
      blockerRef: blockerRef(input, 'role-separation'),
      budgetKey: null,
    };
  }
  if (!input.authority.validator) {
    return {
      kind: 'blocked',
      code: 'invalid_state',
      reason: 'Execution Authorization 不允许 validator 角色执行验证',
      blockerRef: blockerRef(input, 'authority'),
      budgetKey: null,
    };
  }

  const repairBudgetKey = workPackageBudgetKey(input.workPackageId, 'validatorRepairs');
  let consumed = input.repairBudget.consumed;
  let usableEvidence = [...input.evidence];
  /** 因修复而失效、必须由新证据覆盖的路径。 */
  let pendingPaths: string[] = [];
  let steps = 0;

  while (steps < input.maxSteps) {
    steps += 1;
    const verified = await input.runStep({
      kind: 'verify',
      sessionBinding: input.sessionBinding,
      workPackageId: input.workPackageId,
      workerTaskId: input.workerTaskId,
      dispatchId: input.dispatchId,
      validationAttemptId: input.validationAttemptId,
      repairIntent: null,
    });

    if (verified.kind === 'session_lost') {
      return {
        kind: 'blocked',
        code: 'session_lost',
        reason: verified.reason,
        blockerRef: blockerRef(input, 'session-lost'),
        budgetKey: null,
      };
    }
    if (verified.kind === 'escalation') {
      return {
        kind: 'escalation_required',
        reason: verified.reason,
        request: verified.request,
        sessionBindingId: input.sessionBinding.providerSessionId,
      };
    }
    if (verified.kind === 'step_failed') {
      return { kind: 'step_failed', code: verified.code, message: verified.message };
    }
    if (verified.kind === 'repair_applied') {
      return {
        kind: 'step_failed',
        code: 'invalid_step_sequence',
        message: '修复只能在一次失败的验证结论之后执行',
      };
    }

    // 复验必须回到同一条真实 session；换 session 一律按 session 丢失处理，不得伪装成继续。
    if (!sessionBindingMatches(input.sessionBinding, verified.sessionBinding)) {
      return {
        kind: 'blocked',
        code: 'session_lost',
        reason: '验证步骤返回的 Session Binding 与当前 Validation Attempt 不一致',
        blockerRef: blockerRef(input, 'session-mismatch'),
        budgetKey: null,
      };
    }

    if (verified.outcome === 'passed') {
      const uncovered = evidenceCoversPaths(verified.evidence, pendingPaths);
      if (uncovered.length > 0) {
        return {
          kind: 'blocked',
          code: 'evidence_missing',
          reason: `修复后缺少覆盖受影响路径的新证据：${uncovered.join(', ')}`,
          blockerRef: blockerRef(input, 'evidence-missing'),
          budgetKey: null,
        };
      }
      return {
        kind: 'validated',
        evidence: [...usableEvidence, ...verified.evidence],
        sessionBindingId: input.sessionBinding.providerSessionId,
        repairBudget: { limit: input.repairBudget.limit, consumed },
        implementationBudget: input.implementationBudget,
        steps,
      };
    }

    // 验证失败：先判定这次修复是否被允许直接执行。
    if (consumed >= input.repairBudget.limit) {
      return {
        kind: 'blocked',
        code: 'budget_exhausted',
        reason: `验证修复预算已耗尽（${consumed}/${input.repairBudget.limit}）`,
        blockerRef: blockerRef(input, 'repair-budget'),
        budgetKey: repairBudgetKey,
      };
    }
    const intent = verified.repairIntent;
    if (intent === null) {
      return {
        kind: 'step_failed',
        code: 'missing_repair_intent',
        message: '验证失败但没有给出可判定的修复意图',
      };
    }
    const decision = evaluateRepairScope({
      changedPaths: intent.changedPaths,
      scopeEnvelope: input.scopeEnvelope,
      authority: input.authority,
      requiresDesignChange: intent.requiresDesignChange,
      requiresDependencyChange: intent.requiresDependencyChange,
      repairBudget: { limit: input.repairBudget.limit, consumed },
    });
    if (decision.kind === 'requires_escalation') {
      return {
        kind: 'escalation_required',
        reason: decision.reason,
        request: decision.message,
        sessionBindingId: input.sessionBinding.providerSessionId,
      };
    }
    if (decision.kind === 'budget_exhausted') {
      return {
        kind: 'blocked',
        code: 'budget_exhausted',
        reason: decision.message,
        blockerRef: blockerRef(input, 'repair-budget'),
        budgetKey: repairBudgetKey,
      };
    }

    steps += 1;
    const repaired = await input.runStep({
      kind: 'repair',
      sessionBinding: input.sessionBinding,
      workPackageId: input.workPackageId,
      workerTaskId: input.workerTaskId,
      dispatchId: input.dispatchId,
      validationAttemptId: input.validationAttemptId,
      repairIntent: intent,
    });
    if (repaired.kind === 'session_lost') {
      return {
        kind: 'blocked',
        code: 'session_lost',
        reason: repaired.reason,
        blockerRef: blockerRef(input, 'session-lost'),
        budgetKey: null,
      };
    }
    if (repaired.kind === 'escalation') {
      return {
        kind: 'escalation_required',
        reason: repaired.reason,
        request: repaired.request,
        sessionBindingId: input.sessionBinding.providerSessionId,
      };
    }
    if (repaired.kind === 'step_failed') {
      return { kind: 'step_failed', code: repaired.code, message: repaired.message };
    }
    if (repaired.kind !== 'repair_applied') {
      return {
        kind: 'step_failed',
        code: 'invalid_step_sequence',
        message: '修复步骤返回了验证结论',
      };
    }
    if (!sessionBindingMatches(input.sessionBinding, repaired.sessionBinding)) {
      return {
        kind: 'blocked',
        code: 'session_lost',
        reason: '修复步骤返回的 Session Binding 与当前 Validation Attempt 不一致',
        blockerRef: blockerRef(input, 'session-mismatch'),
        budgetKey: null,
      };
    }

    const undeclaredPaths = repaired.changedPaths.filter(
      (path) => !intent.changedPaths.some((approved) => pathTouchesCoverage(approved, path)),
    );
    if (undeclaredPaths.length > 0) {
      return {
        kind: 'escalation_required',
        reason: 'scope',
        request: `修复实际改动了未获批路径：${undeclaredPaths.join(', ')}`,
        sessionBindingId: input.sessionBinding.providerSessionId,
      };
    }
    const actualScope = evaluateRepairScope({
      changedPaths: repaired.changedPaths,
      scopeEnvelope: input.scopeEnvelope,
      authority: input.authority,
      requiresDesignChange: intent.requiresDesignChange,
      requiresDependencyChange: intent.requiresDependencyChange,
      repairBudget: { limit: input.repairBudget.limit, consumed },
    });
    if (actualScope.kind === 'requires_escalation') {
      return {
        kind: 'escalation_required',
        reason: actualScope.reason,
        request: actualScope.message,
        sessionBindingId: input.sessionBinding.providerSessionId,
      };
    }
    if (actualScope.kind === 'budget_exhausted') {
      return {
        kind: 'blocked',
        code: 'budget_exhausted',
        reason: actualScope.message,
        blockerRef: blockerRef(input, 'repair-budget'),
        budgetKey: repairBudgetKey,
      };
    }

    consumed += 1;
    // 修复触及的证据立即失效，并要求新的证据覆盖这些路径。
    const invalidated = invalidateEvidence(usableEvidence, repaired.changedPaths);
    const invalidatedIds = new Set(invalidated.map((entry) => entry.evidenceId));
    usableEvidence = usableEvidence.filter((record) => !invalidatedIds.has(record.evidenceId));
    pendingPaths = [...new Set([...pendingPaths, ...repaired.changedPaths])];
  }

  return {
    kind: 'blocked',
    code: 'invalid_state',
    reason: `验证链超过步数上限 ${input.maxSteps} 而未收敛`,
    blockerRef: blockerRef(input, 'step-limit'),
    budgetKey: null,
  };
}

/**
 * Validator session 丢失后的处置。
 *
 * 复用正常的 Retry Attempt 判定：条件成立时给出新 Dispatch/Attempt 计划（新尝试独立于原 session），
 * 否则形成 blocker。绝不生成 Capsule、绝不消耗 Recovery Budget。
 */
export function validationSessionLostOutcome(input: {
  readonly claimed: Parameters<typeof decideWorkerResultRecording>[0]['claimed'];
  readonly trusted: Parameters<typeof decideWorkerResultRecording>[0]['trusted'];
  readonly retry: Parameters<typeof decideWorkerResultRecording>[0]['retry'];
  readonly contractChange: Parameters<typeof decideWorkerResultRecording>[0]['contractChange'];
  readonly taskContract: Parameters<typeof decideWorkerResultRecording>[0]['taskContract'];
  readonly specBinding: Parameters<typeof decideWorkerResultRecording>[0]['specBinding'];
  readonly budget: Parameters<typeof decideWorkerResultRecording>[0]['budget'];
  readonly consumedBudgets: Parameters<typeof decideWorkerResultRecording>[0]['consumedBudgets'];
}): WorkerResultRecording {
  return decideWorkerResultRecording({ ...input, attemptOutcome: 'session_lost' });
}
