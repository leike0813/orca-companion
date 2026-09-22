/**
 * IC-10 / IP-6：修订额度的只读判定（Owner: `m1-evolve-execution-graph`，D9）。
 *
 * 上限来自已批准的 Execution Authorization Manifest，本模块**只读取**它：执行阶段不新增、不推断、
 * 不放宽字段。已消耗量来自 IC-03 的单调计数（`BudgetConsumption`），因此重启、恢复、Patch 与重规划都
 * 不会让额度回到 0。
 *
 * 判定是纯函数、fail closed：上限缺失或非法一律读成「额度已用尽」，绝不会读成「不受限制」。
 */

import type { WorkPackageId } from '../../application/dto/identity.js';
import type { BudgetConsumption } from '../dispatch-candidate.js';
import type { ExecutionAuthorizationManifest } from '../planning/execution-authorization.js';

export const REVISION_BUDGET_FIELDS = ['graphRevisions', 'specificationRevisions'] as const;

export type RevisionBudgetField = (typeof REVISION_BUDGET_FIELDS)[number];

export type RevisionAllowance = {
  readonly field: RevisionBudgetField;
  readonly workPackageId: WorkPackageId;
  readonly limit: number;
  readonly consumed: number;
  readonly remaining: number;
  readonly exhausted: boolean;
};

/** Manifest 里已批准的修订上限；字段名与 `WorkPackageBudget` 逐字一致，因此不需要映射表。 */
export function revisionLimits(
  manifest: ExecutionAuthorizationManifest,
): Readonly<Record<RevisionBudgetField, number>> {
  return {
    graphRevisions: manifest.limits.graphRevisions,
    specificationRevisions: manifest.limits.specificationRevisions,
  };
}

export function revisionLimitOf(
  manifest: ExecutionAuthorizationManifest,
  field: RevisionBudgetField,
): number {
  return revisionLimits(manifest)[field];
}

/** 某个 Work Package 在某个修订额度项上的已消耗量；缺少计数按 0 处理（不是「不限制」）。 */
export function consumedRevisionCount(
  consumption: readonly BudgetConsumption[],
  workPackageId: WorkPackageId,
  field: RevisionBudgetField,
): number {
  return (
    consumption.find((entry) => entry.workPackageId === workPackageId && entry.field === field)?.consumed ?? 0
  );
}

/**
 * 计算剩余额度。
 *
 * `limit` 与 `consumed` 不是安全非负整数时按已用尽处理：非法输入只会收紧权限，不会放开。
 */
export function revisionAllowance(input: {
  readonly workPackageId: WorkPackageId;
  readonly field: RevisionBudgetField;
  readonly limit: number;
  readonly consumed: number;
}): RevisionAllowance {
  const valid =
    Number.isSafeInteger(input.limit) && input.limit > 0 && Number.isSafeInteger(input.consumed) && input.consumed >= 0;
  if (!valid) {
    return {
      field: input.field,
      workPackageId: input.workPackageId,
      limit: input.limit,
      consumed: input.consumed,
      remaining: 0,
      exhausted: true,
    };
  }
  const remaining = Math.max(0, input.limit - input.consumed);
  return {
    field: input.field,
    workPackageId: input.workPackageId,
    limit: input.limit,
    consumed: input.consumed,
    remaining,
    exhausted: remaining === 0,
  };
}

export type RevisionRequestDecision =
  | { readonly kind: 'allowed'; readonly allowance: RevisionAllowance }
  | { readonly kind: 'exhausted'; readonly allowance: RevisionAllowance; readonly reason: string };

/**
 * 判断一次修订是否还有额度。
 *
 * 判定只读取 Manifest 与已消耗计数：它不接受调用方传入的「上限覆盖」，因为放宽上限不是执行阶段的
 * 能力，只能回到重规划或用户决定。
 */
export function evaluateRevisionRequest(input: {
  readonly manifest: ExecutionAuthorizationManifest;
  readonly consumption: readonly BudgetConsumption[];
  readonly workPackageId: WorkPackageId;
  readonly field: RevisionBudgetField;
}): RevisionRequestDecision {
  const allowance = revisionAllowance({
    workPackageId: input.workPackageId,
    field: input.field,
    limit: revisionLimitOf(input.manifest, input.field),
    consumed: consumedRevisionCount(input.consumption, input.workPackageId, input.field),
  });
  if (allowance.exhausted) {
    return {
      kind: 'exhausted',
      allowance,
      reason: `Work Package ${input.workPackageId} 的 ${input.field} 额度已耗尽（${allowance.consumed}/${allowance.limit}）`,
    };
  }
  return { kind: 'allowed', allowance };
}
