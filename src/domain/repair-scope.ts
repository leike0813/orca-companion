/**
 * IC-08 / D6：Validator 直接修复的范围与预算判定（Owner: `m1-execute-and-validate-work-packages`）。
 *
 * 修复前由 Controller 做一次确定性检查，而不是由 Worker 自审：改动路径必须落在该 Worker Task 的
 * Scope Envelope 内，需要设计或依赖变更时必须以 Worker Escalation 上报，角色本身必须获授权，
 * 且必须还有修复预算。判定是纯函数，不读时钟、不碰存储。
 *
 * 路径判定复用 `worker-report.ts` 的前缀语义：证据覆盖 `src/domain` 会被 `src/domain/x.ts` 的变化
 * 触及，覆盖 `src/domain/x.ts` 不会被 `src/application/x.ts` 的变化触及。不解析 glob、不猜语义。
 */

import type { RoleAuthorities } from './planning/execution-authorization.js';
import type { ScopeEnvelope } from './planning/execution-graph.js';
import { pathTouchesCoverage, type EscalationReason } from './worker-report.js';

/** 一条路径是否被 Scope Envelope 允许：exclude 优先，include 为空表示没有可改路径。 */
export function pathInsideScopeEnvelope(envelope: ScopeEnvelope, path: string): boolean {
  if (envelope.exclude.some((excluded) => pathTouchesCoverage(excluded, path))) {
    return false;
  }
  return envelope.include.some((included) => pathTouchesCoverage(included, path));
}

/** 逐条列出越出 Scope Envelope 的路径，保持输入顺序。 */
export function pathsOutsideScopeEnvelope(
  envelope: ScopeEnvelope,
  paths: readonly string[],
): readonly string[] {
  return paths.filter((path) => !pathInsideScopeEnvelope(envelope, path));
}

export type RepairScopeFacts = {
  readonly changedPaths: readonly string[];
  readonly scopeEnvelope: ScopeEnvelope;
  readonly authority: RoleAuthorities;
  /** 修复是否必须改动设计；设计变更不在 Validator 的直接修复权限内。 */
  readonly requiresDesignChange: boolean;
  /** 修复是否必须改动依赖；只有 Manifest 显式授权时才是角色权限内的动作。 */
  readonly requiresDependencyChange: boolean;
  readonly repairBudget: {
    readonly limit: number;
    readonly consumed: number;
  };
};

export type RepairScopeDecision =
  | { readonly kind: 'allowed'; readonly changedPaths: readonly string[]; readonly remainingRepairs: number }
  | {
      readonly kind: 'requires_escalation';
      readonly reason: EscalationReason;
      readonly offendingPaths: readonly string[];
      readonly message: string;
    }
  | {
      readonly kind: 'budget_exhausted';
      readonly limit: number;
      readonly consumed: number;
      readonly message: string;
    };

/**
 * 判定一次修复是否可以由 Validator 在授权范围内直接执行。
 *
 * 判定顺序固定：scope → 设计 → 依赖 → authority → 预算。越界修复绝不降级成「部分允许」，
 * 预算耗尽也绝不因为改动很小而放行。
 */
export function evaluateRepairScope(facts: RepairScopeFacts): RepairScopeDecision {
  const outside = pathsOutsideScopeEnvelope(facts.scopeEnvelope, facts.changedPaths);
  if (outside.length > 0) {
    return {
      kind: 'requires_escalation',
      reason: 'scope',
      offendingPaths: outside,
      message: `修复改动了 Scope Envelope 之外的路径：${outside.join(', ')}`,
    };
  }
  if (facts.requiresDesignChange) {
    return {
      kind: 'requires_escalation',
      reason: 'design',
      offendingPaths: facts.changedPaths,
      message: '修复需要改动设计，超出 Validator 的直接修复权限',
    };
  }
  if (facts.requiresDependencyChange && !facts.authority.dependencyChanges) {
    return {
      kind: 'requires_escalation',
      reason: 'dependency',
      offendingPaths: facts.changedPaths,
      message: '修复需要改动依赖，而当前 Execution Authorization 未授权依赖变更',
    };
  }
  if (!facts.authority.validator) {
    return {
      kind: 'requires_escalation',
      reason: 'authority',
      offendingPaths: facts.changedPaths,
      message: 'Execution Authorization 不允许 validator 角色执行修复',
    };
  }
  if (facts.repairBudget.consumed >= facts.repairBudget.limit) {
    return {
      kind: 'budget_exhausted',
      limit: facts.repairBudget.limit,
      consumed: facts.repairBudget.consumed,
      message: `修复预算已耗尽（${facts.repairBudget.consumed}/${facts.repairBudget.limit}）`,
    };
  }
  return {
    kind: 'allowed',
    changedPaths: facts.changedPaths,
    remainingRepairs: facts.repairBudget.limit - facts.repairBudget.consumed,
  };
}
