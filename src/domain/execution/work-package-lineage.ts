/**
 * IC-10 / IP-9：Work Package Lineage 与已消耗额度的继承
 * （Owner: `m1-evolve-execution-graph`，D11）。
 *
 * 当新 Work Package 明确延续一个未完成的旧责任时，这次延续必须被显式记录：旧责任已消耗的实现、修复、
 * Graph Revision 与 Specification Revision 额度随之继承，而不是被重置为新值。`maxRecoveriesPerWorkerAttempt`
 * 不在继承范围内——它是单个 Worker Attempt 的恢复次数，不是 Work Package 级的已消耗额度。
 *
 * 继承是**记录**，不是状态复制：这里不搬运旧完成状态、不复用旧 worktree，也不让旧结果自动满足新节点。
 * 纯判定：不读时钟、不碰存储。
 */

import type { GraphId, WorkPackageId } from '../../application/dto/identity.js';
import {
  type BudgetConsumption,
  type WorkPackageBudgetField,
} from '../dispatch-candidate.js';

/** 可被 lineage 继承的额度项；恢复次数按 Worker Attempt 计，不在此列。 */
export const INHERITABLE_BUDGET_FIELDS = [
  'implementationAttempts',
  'validatorRepairs',
  'graphRevisions',
  'specificationRevisions',
] as const satisfies readonly WorkPackageBudgetField[];

export type InheritableBudgetField = (typeof INHERITABLE_BUDGET_FIELDS)[number];

/** 一条被继承的已消耗额度；端口层的 `InheritedBudgetEntry` 就是这个形状。 */
export type InheritedBudgetUse = {
  readonly field: InheritableBudgetField;
  readonly consumed: number;
};

export type WorkPackageLineage = {
  readonly workPackageId: WorkPackageId;
  readonly priorWorkPackageId: WorkPackageId;
  readonly priorGraphId: GraphId;
  readonly inherited: readonly InheritedBudgetUse[];
};

export type LineagePlanResult =
  | { readonly kind: 'planned'; readonly lineage: WorkPackageLineage }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

/** 该字段是否属于可继承范围。 */
export function isInheritableField(field: string): field is InheritableBudgetField {
  return (INHERITABLE_BUDGET_FIELDS as readonly string[]).includes(field);
}

function consumedOf(consumption: readonly BudgetConsumption[], field: WorkPackageBudgetField): number {
  return consumption.find((entry) => entry.field === field)?.consumed ?? 0;
}

/**
 * 规划一次延续。
 *
 * 继承值直接取自旧责任**当前**的已消耗计数，因此「继承」与「重置」在结构上互斥：计划里没有可以填入
 * 新值的位置，只有旧计数的快照。旧计数非法（负数或非整数）时拒绝，绝不按 0 处理——那会把已消耗的
 * 额度偷偷还回去。
 */
export function planLineage(input: {
  readonly workPackageId: WorkPackageId;
  readonly priorWorkPackageId: WorkPackageId;
  readonly priorGraphId: GraphId;
  readonly priorConsumed: readonly BudgetConsumption[];
}): LineagePlanResult {
  if (input.workPackageId === input.priorWorkPackageId) {
    return { kind: 'rejected', code: 'self_lineage', message: 'Work Package 不能延续自身' };
  }
  const inherited: InheritedBudgetUse[] = [];
  for (const field of INHERITABLE_BUDGET_FIELDS) {
    const consumed = consumedOf(input.priorConsumed, field);
    if (!Number.isSafeInteger(consumed) || consumed < 0) {
      return {
        kind: 'rejected',
        code: 'invalid_consumed',
        message: `旧责任在 ${field} 上的已消耗值 ${String(consumed)} 不是非负安全整数`,
      };
    }
    inherited.push({ field, consumed });
  }
  return {
    kind: 'planned',
    lineage: {
      workPackageId: input.workPackageId,
      priorWorkPackageId: input.priorWorkPackageId,
      priorGraphId: input.priorGraphId,
      inherited,
    },
  };
}

/**
 * 把继承额度折算成调用方已经使用的 `BudgetConsumption` 形状。
 *
 * 调度侧只需把本函数的结果与自身计数合并，无需知道 lineage 的存在；因此「继承」和「本代消耗」在读取端
 * 是同一种事实。
 */
export function inheritedConsumption(
  lineage: WorkPackageLineage | null,
  workPackageId: WorkPackageId,
): readonly BudgetConsumption[] {
  if (lineage === null || lineage.workPackageId !== workPackageId) {
    return [];
  }
  return lineage.inherited.map((entry) => ({
    workPackageId,
    field: entry.field,
    consumed: entry.consumed,
  }));
}

/**
 * 合并「本代已消耗」与「继承已消耗」。
 *
 * 逐字段取和，不做任何截断：因此继承后的已消耗量只会更大，重启、恢复与重规划都不可能把它降回去。
 */
export function effectiveConsumption(input: {
  readonly workPackageId: WorkPackageId;
  readonly own: readonly BudgetConsumption[];
  readonly lineage: WorkPackageLineage | null;
}): readonly BudgetConsumption[] {
  const totals = new Map<WorkPackageBudgetField, number>();
  const add = (entry: BudgetConsumption): void => {
    totals.set(entry.field, (totals.get(entry.field) ?? 0) + entry.consumed);
  };
  for (const entry of input.own) {
    add(entry);
  }
  for (const entry of inheritedConsumption(input.lineage, input.workPackageId)) {
    add(entry);
  }
  return [...totals.entries()]
    .map(([field, consumed]) => ({ workPackageId: input.workPackageId, field, consumed }))
    .sort((left, right) => (left.field < right.field ? -1 : left.field > right.field ? 1 : 0));
}

/** 继承是否确实没有重置额度：每个可继承字段都不小于旧责任的已消耗值。 */
export function inheritancePreservesConsumed(
  inherited: readonly InheritedBudgetUse[],
  priorConsumed: readonly BudgetConsumption[],
): boolean {
  return INHERITABLE_BUDGET_FIELDS.every((field) => {
    const use = inherited.find((entry) => entry.field === field);
    return use !== undefined && use.consumed >= consumedOf(priorConsumed, field);
  });
}

/** 校验用的字段闭集：继承计划里不允许出现不可继承的额度项。 */
export function allFieldsInheritable(inherited: readonly InheritedBudgetUse[]): boolean {
  return inherited.every((entry) => isInheritableField(entry.field));
}
