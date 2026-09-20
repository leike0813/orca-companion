/**
 * IC-08 / IP-B6：派发前的 Unattributed Drift 检查
 * （Owner: `m1-execute-and-validate-work-packages`）。
 *
 * 每次派发前先比对该 Scope 的 canonical HEAD 与最近一条已完成 Integration Operation 的 expected
 * HEAD：无法归属的变化一律判定为 Unattributed Drift，暂停新的派发，直到确定该变化是否仍落在当前
 * 授权范围内。检查通过后才调用前驱的 `evaluateDispatchCandidate`——本模块不复制任何前置条件集合。
 *
 * 纯函数：不读 Git、不读 Orca、不写存储，因此「为什么这次没有派发」永远可以在零副作用下复算。
 */

import {
  evaluateDispatchCandidate,
  type DispatchCandidateDecision,
  type DispatchCandidateFacts,
  type DispatchCandidateRejection,
} from '../domain/dispatch-candidate.js';
import { classifyCanonicalHead, type CanonicalHeadFacts } from '../domain/git-integration-policy.js';
import type { WorkPackageId } from './dto/identity.js';
import type { WorkerRole } from '../domain/planning/execution-authorization.js';
import type { ScopeEnvelope } from '../domain/planning/execution-graph.js';

export type DispatchGuardDecision =
  | { readonly kind: 'clear'; readonly statement: string }
  | {
      readonly kind: 'paused';
      readonly code: 'unattributed_drift';
      readonly reason: string;
      /** 结论的一部分，不是提示：出现未归属变化就必须停止新派发。 */
      readonly pauseDispatch: true;
    };

/** 归属判定：只依赖 canonical HEAD/worktree 与既有 Integration Operation 记录。 */
export function evaluateDispatchGuard(facts: CanonicalHeadFacts): DispatchGuardDecision {
  const verdict = classifyCanonicalHead(facts);
  if (verdict.kind === 'attributed') {
    return { kind: 'clear', statement: verdict.statement };
  }
  return {
    kind: 'paused',
    code: 'unattributed_drift',
    reason: verdict.reason,
    pauseDispatch: true,
  };
}

export type GuardedDispatchDecision =
  | {
      readonly kind: 'materializable';
      readonly workPackageId: WorkPackageId;
      readonly role: WorkerRole;
      readonly scopeEnvelope: ScopeEnvelope;
    }
  | { readonly kind: 'paused'; readonly reason: string }
  | { readonly kind: 'rejected'; readonly rejection: DispatchCandidateRejection };

/**
 * 派发前的完整判定：先 drift 检查，再复用前驱的候选判定。
 *
 * drift 未通过时不进入候选判定，因此暂停结论不会掩盖也不会绕过任何既有前置条件；检查通过时的
 * 结论与前驱逐字一致。
 */
export function guardDispatchCandidate(input: {
  readonly guard: CanonicalHeadFacts;
  readonly candidate: DispatchCandidateFacts;
}): GuardedDispatchDecision {
  const guard = evaluateDispatchGuard(input.guard);
  if (guard.kind === 'paused') {
    return { kind: 'paused', reason: guard.reason };
  }
  const decision: DispatchCandidateDecision = evaluateDispatchCandidate(input.candidate);
  return decision;
}
