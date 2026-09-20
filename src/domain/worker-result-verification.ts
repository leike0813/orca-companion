/**
 * IC-08 / D1：Worker 报告的身份与代际核验（Owner: `m1-execute-and-validate-work-packages`）。
 *
 * 核验是纯函数：输入是「载荷声称的归属」与「Controller 从可信来源读到的当前事实」，输出是
 * `accepted | stale_generation | stale_attempt | rejected(reason)`。应用层只在 `accepted` 时写入
 * Accepted Worker Result；两种 stale 都只用于补充历史，不推进任何生命周期。
 *
 * 载荷永远不是归属的来源：这里不解析 Worker 自报身份（那是 `worker-report-dto.ts` 的边界职责），
 * 只比对调用方已经解析并归一化后的声称值。本模块不读时钟、不碰存储、不派发任何东西。
 */

import type { DispatchId, WorkerTaskId } from '../application/dto/identity.js';
import type { RoleAuthorities, WorkerRole } from './planning/execution-authorization.js';
import type { ScopeEnvelope } from './planning/execution-graph.js';
import { pathInsideScopeEnvelope } from './repair-scope.js';
import type { SpecBinding } from './task-contract.js';

/** 载荷声称的归属；缺失字段一律是 `null`，空字符串被边界解析拒绝，因此这里不出现。 */
export type ClaimedResultAttribution = {
  readonly runId: string | null;
  readonly consumerGeneration: number | null;
  readonly graphGeneration: number | null;
  readonly authorizationId: string | null;
  readonly workerTaskId: WorkerTaskId | null;
  readonly dispatchId: DispatchId | null;
  readonly attemptId: string | null;
  readonly role: WorkerRole | null;
  readonly specBinding: SpecBinding | null;
  readonly worktreeId: string | null;
};

/** Controller 从 Execution Scope、图记录与 store 读到的当前事实。 */
export type TrustedExecutionFacts = {
  readonly runId: string;
  readonly consumerGeneration: number;
  readonly graphGeneration: number;
  readonly authorizationId: string;
  readonly workerTaskId: WorkerTaskId;
  readonly dispatchId: DispatchId;
  readonly attemptId: string;
  readonly role: WorkerRole;
  readonly specBinding: SpecBinding;
  readonly worktreeId: string;
  readonly authority: RoleAuthorities;
  readonly scopeEnvelope: ScopeEnvelope;
  /** Controller 从 Git/worktree 读取的实际改动路径；不信任 Worker 自报范围。 */
  readonly changedPaths: readonly string[];
};

export type ResultVerificationRejectionCode =
  | 'missing_attribution'
  | 'run_mismatch'
  | 'consumer_generation_mismatch'
  | 'graph_generation_mismatch'
  | 'authorization_mismatch'
  | 'worker_task_mismatch'
  | 'dispatch_mismatch'
  | 'attempt_mismatch'
  | 'role_mismatch'
  | 'role_not_authorized'
  | 'spec_binding_mismatch'
  | 'worktree_mismatch'
  | 'scope_envelope_violation';

/** 核验通过的归属：后续用例只应消费这里给出的值，而不是重新读声称值。 */
export type VerifiedResultAttribution = {
  readonly runId: string;
  readonly consumerGeneration: number;
  readonly workerTaskId: WorkerTaskId;
  readonly dispatchId: DispatchId;
  readonly attemptId: string;
  readonly role: WorkerRole;
  readonly changedPaths: readonly string[];
};

export type WorkerResultVerification =
  | { readonly kind: 'accepted'; readonly attribution: VerifiedResultAttribution }
  /** 旧代际（Run / consumer generation / Graph Generation / Authorization）：只补历史。 */
  | {
      readonly kind: 'stale_generation';
      readonly code: ResultVerificationRejectionCode;
      readonly mismatches: readonly string[];
      readonly message: string;
    }
  /** 同代际但已被取代的 Attempt / Dispatch：只补历史。 */
  | {
      readonly kind: 'stale_attempt';
      readonly code: ResultVerificationRejectionCode;
      readonly mismatches: readonly string[];
      readonly message: string;
    }
  | {
      readonly kind: 'rejected';
      readonly code: ResultVerificationRejectionCode;
      readonly mismatches: readonly string[];
      readonly message: string;
    };

const REQUIRED_FIELDS = [
  'runId',
  'consumerGeneration',
  'workerTaskId',
  'dispatchId',
  'attemptId',
  'role',
  'specBinding',
  'worktreeId',
] as const satisfies readonly (keyof ClaimedResultAttribution)[];

/** Spec Binding 的身份由 provider、内容摘要与两个 revision 确定；路径只用于定位。 */
export function specBindingMatches(reported: SpecBinding, trusted: SpecBinding): boolean {
  return (
    reported.provider === trusted.provider &&
    reported.providerVersion === trusted.providerVersion &&
    reported.contentDigest === trusted.contentDigest &&
    reported.contractRevision === trusted.contractRevision &&
    reported.trackingRevision === trusted.trackingRevision
  );
}

/**
 * 核验一份候选报告的归属与代际。
 *
 * 判定顺序固定，因此同一份输入永远得到同一个结论：先排除缺失归属，再判旧代际，再判旧尝试，
 * 最后判角色、版本、worktree 与 Scope Envelope。顺序本身也是规格的一部分——旧代际的报告即使
 * 角色也不对，结论仍然是「旧代际，只补历史」，而不是「拒绝」。
 */
export function verifyWorkerResult(
  claimed: ClaimedResultAttribution,
  trusted: TrustedExecutionFacts,
): WorkerResultVerification {
  const missing: string[] = [];
  for (const field of REQUIRED_FIELDS) {
    if (claimed[field] === null) {
      missing.push(field);
    }
  }
  if (missing.length > 0) {
    return {
      kind: 'rejected',
      code: 'missing_attribution',
      mismatches: missing,
      message: `报告缺少可核验的归属字段：${missing.join(', ')}`,
    };
  }

  const generationMismatches: string[] = [];
  if (claimed.runId !== trusted.runId) {
    generationMismatches.push('runId');
  }
  if (claimed.consumerGeneration !== trusted.consumerGeneration) {
    generationMismatches.push('consumerGeneration');
  }
  if (claimed.graphGeneration !== null && claimed.graphGeneration !== trusted.graphGeneration) {
    generationMismatches.push('graphGeneration');
  }
  if (claimed.authorizationId !== null && claimed.authorizationId !== trusted.authorizationId) {
    generationMismatches.push('authorizationId');
  }
  if (generationMismatches.length > 0) {
    const code: ResultVerificationRejectionCode = generationMismatches.includes('runId')
      ? 'run_mismatch'
      : generationMismatches.includes('consumerGeneration')
        ? 'consumer_generation_mismatch'
        : generationMismatches.includes('graphGeneration')
          ? 'graph_generation_mismatch'
          : 'authorization_mismatch';
    return {
      kind: 'stale_generation',
      code,
      mismatches: generationMismatches,
      message: `报告属于旧代际（${generationMismatches.join(', ')}），只用于补充历史`,
    };
  }

  const attemptMismatches: string[] = [];
  if (claimed.dispatchId !== trusted.dispatchId) {
    attemptMismatches.push('dispatchId');
  }
  if (claimed.attemptId !== trusted.attemptId) {
    attemptMismatches.push('attemptId');
  }
  if (claimed.workerTaskId !== trusted.workerTaskId) {
    attemptMismatches.push('workerTaskId');
  }
  if (attemptMismatches.length > 0) {
    const code: ResultVerificationRejectionCode = attemptMismatches.includes('workerTaskId')
      ? 'worker_task_mismatch'
      : attemptMismatches.includes('dispatchId')
        ? 'dispatch_mismatch'
        : 'attempt_mismatch';
    return {
      kind: 'stale_attempt',
      code,
      mismatches: attemptMismatches,
      message: `报告属于已被取代的尝试（${attemptMismatches.join(', ')}），只用于补充历史`,
    };
  }

  if (claimed.role !== trusted.role) {
    return {
      kind: 'rejected',
      code: 'role_mismatch',
      mismatches: ['role'],
      message: `报告角色 ${String(claimed.role)} 与当前 Worker Task 的角色 ${trusted.role} 不一致`,
    };
  }
  if (!trusted.authority[trusted.role]) {
    return {
      kind: 'rejected',
      code: 'role_not_authorized',
      mismatches: ['authority'],
      message: `Execution Authorization 不允许 ${trusted.role} 角色提交结果`,
    };
  }
  if (claimed.specBinding === null || !specBindingMatches(claimed.specBinding, trusted.specBinding)) {
    return {
      kind: 'rejected',
      code: 'spec_binding_mismatch',
      mismatches: ['specBinding'],
      message: '报告绑定的 Specification Unit 与当前 Spec Binding 不一致',
    };
  }
  if (claimed.worktreeId !== trusted.worktreeId) {
    return {
      kind: 'rejected',
      code: 'worktree_mismatch',
      mismatches: ['worktreeId'],
      message: '报告来自与该 Worker Task 不同的 worktree',
    };
  }

  const changedPaths = trusted.changedPaths;
  const outside = changedPaths.filter((path) => !pathInsideScopeEnvelope(trusted.scopeEnvelope, path));
  if (outside.length > 0) {
    return {
      kind: 'rejected',
      code: 'scope_envelope_violation',
      mismatches: outside,
      message: `报告声明改动越出 Scope Envelope：${outside.join(', ')}`,
    };
  }

  return {
    kind: 'accepted',
    attribution: {
      runId: trusted.runId,
      consumerGeneration: trusted.consumerGeneration,
      workerTaskId: trusted.workerTaskId,
      dispatchId: trusted.dispatchId,
      attemptId: trusted.attemptId,
      role: trusted.role,
      changedPaths,
    },
  };
}

/** 只有 `accepted` 允许推进生命周期；两种 stale 只允许写历史与确认。 */
export function resultAdvancesLifecycle(verification: WorkerResultVerification): boolean {
  return verification.kind === 'accepted';
}
