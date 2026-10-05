/**
 * IC-05：执行预算上限（Owner: `m1-plan-and-authorize-execution`）。
 *
 * 上限是 Manifest 的字段，在这里一次性定型；后继 change 只读取与扣减，不新增字段（D7/D8）。
 * 所有上限都是有限正安全整数——没有 `null`、没有 `Infinity`、没有「不限制」的表示，因此
 * 「上限缺失」只能表现为拒绝，而不可能被读成放开。
 *
 * 三个「额度」各自只有一个含义：`maxActiveWorkPackages` 是并行包调度额度，
 * `maxWorkPackages` 是当前图容量，`integrationReconciliations` 是每包集成复验次数。
 * 图拓扑只受容量约束，不携带并行额度副本。
 */

import { parseRevision, type IdentityResult } from '../../application/dto/identity.js';
import type { WorkPackageBudget } from './execution-graph.js';

export type ExecutionLimits = {
  /** 并行 Work Package 调度额度；提高即补槽，降低只阻止新包。 */
  readonly maxActiveWorkPackages: number;
  /** 当前图容量：未 retire 包数量上限。 */
  readonly maxWorkPackages: number;
  /** 每包可用的集成复验轮次；独立于 Validator 修复预算。 */
  readonly integrationReconciliations: number;
  readonly implementationAttempts: number;
  readonly validatorRepairs: number;
  readonly graphRevisions: number;
  readonly specificationRevisions: number;
  readonly maxRecoveriesPerWorkerAttempt: number;
};

/** `AGENTS.md` 第 7 节的有限默认值；可配置但必须有限，且不因恢复而重置。 */
export const DEFAULT_EXECUTION_LIMITS: ExecutionLimits = {
  maxActiveWorkPackages: 3,
  maxWorkPackages: 8,
  integrationReconciliations: 2,
  implementationAttempts: 2,
  validatorRepairs: 2,
  graphRevisions: 2,
  specificationRevisions: 2,
  maxRecoveriesPerWorkerAttempt: 1,
};

/** 单个 Worker Attempt 的恢复次数默认值；显式写入 Manifest，不留空（D8）。 */
export const DEFAULT_RECOVERIES_PER_WORKER_ATTEMPT = 1;

const LIMIT_FIELDS = [
  'maxActiveWorkPackages',
  'maxWorkPackages',
  'integrationReconciliations',
  'implementationAttempts',
  'validatorRepairs',
  'graphRevisions',
  'specificationRevisions',
  'maxRecoveriesPerWorkerAttempt',
] as const satisfies readonly (keyof ExecutionLimits)[];

/** 解析 Manifest 的 `limits`：字段闭集、逐项正安全整数、缺失即拒绝。 */
export function parseExecutionLimits(raw: unknown, field: string): IdentityResult<ExecutionLimits> {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, field, message: '必须是对象' };
  }
  const record = raw as Record<string, unknown>;
  const parsed: Record<string, number> = {};
  for (const key of LIMIT_FIELDS) {
    const value = parseRevision(record[key], `${field}.${key}`);
    if (!value.ok) {
      return value;
    }
    if (!Number.isSafeInteger(value.value) || value.value <= 0) {
      return { ok: false, field: `${field}.${key}`, message: '上限必须是大于 0 的安全整数' };
    }
    parsed[key] = value.value;
  }
  return {
    ok: true,
    value: {
      maxActiveWorkPackages: parsed['maxActiveWorkPackages'] ?? 0,
      maxWorkPackages: parsed['maxWorkPackages'] ?? 0,
      integrationReconciliations: parsed['integrationReconciliations'] ?? 0,
      implementationAttempts: parsed['implementationAttempts'] ?? 0,
      validatorRepairs: parsed['validatorRepairs'] ?? 0,
      graphRevisions: parsed['graphRevisions'] ?? 0,
      specificationRevisions: parsed['specificationRevisions'] ?? 0,
      maxRecoveriesPerWorkerAttempt: parsed['maxRecoveriesPerWorkerAttempt'] ?? 0,
    },
  };
}

/** 上限缺失时补默认值；这是 Manifest 组装路径，解析路径仍然严格拒绝缺失字段。 */
export function applyLimitDefaults(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) {
    return raw;
  }
  const record = { ...(raw as Record<string, unknown>) };
  for (const key of LIMIT_FIELDS) {
    if (record[key] === undefined) {
      record[key] = DEFAULT_EXECUTION_LIMITS[key];
    }
  }
  return record;
}

export function budgetFromLimits(limits: ExecutionLimits): WorkPackageBudget {
  return {
    implementationAttempts: limits.implementationAttempts,
    validatorRepairs: limits.validatorRepairs,
    graphRevisions: limits.graphRevisions,
    specificationRevisions: limits.specificationRevisions,
    integrationReconciliations: limits.integrationReconciliations,
    maxRecoveriesPerWorkerAttempt: limits.maxRecoveriesPerWorkerAttempt,
  };
}

export type BudgetViolationCode =
  | 'work_package_capacity_exceeded'
  | 'work_package_capacity_invalid'
  | 'work_package_budget_exceeded';

export type BudgetViolation = {
  readonly code: BudgetViolationCode;
  readonly message: string;
  readonly workPackageKey: string | null;
};

/**
 * 一条待校验的预算需求。
 *
 * 只保留上限比较真正需要的两个字段，因此「初始编译的计划条目」与「Graph Patch 新增的节点」可以用
 * 同一套上限判定，而不必互相伪造对方的结构。
 */
export type BudgetRequirement = {
  readonly key: string;
  readonly requestedBudget?: Partial<WorkPackageBudget>;
};

/**
 * 判断计划声明的预算需求是否全部落在上限内。
 *
 * 返回空数组表示通过；任何超限都逐项列出，不做截断也不放宽。缺少显式需求的 Work Package 只取
 * 配置上限，因此不会产生「未声明即无限」的解读。`activeWorkPackageCount` 表达变化生效后的节点总数：
 * 追加补丁时它大于声明数量，判定因此看到的是新图的总量而不是本次增量。
 */
export function assertWithinCaps(input: {
  readonly limits: ExecutionLimits;
  readonly workPackages: readonly BudgetRequirement[];
  readonly activeWorkPackageCount?: number;
}): readonly BudgetViolation[] {
  const violations: BudgetViolation[] = [];
  if (!Number.isSafeInteger(input.limits.maxWorkPackages) || input.limits.maxWorkPackages <= 0) {
    violations.push({
      code: 'work_package_capacity_invalid',
      message: `图容量上限必须为正安全整数，实际为 ${String(input.limits.maxWorkPackages)}`,
      workPackageKey: null,
    });
  }
  const activeCount = input.activeWorkPackageCount ?? input.workPackages.length;
  if (activeCount > input.limits.maxWorkPackages) {
    violations.push({
      code: 'work_package_capacity_exceeded',
      message: `Work Package 数量 ${activeCount} 超过图容量上限 ${input.limits.maxWorkPackages}`,
      workPackageKey: null,
    });
  }
  const caps = budgetFromLimits(input.limits);
  for (const planned of input.workPackages) {
    const requested = planned.requestedBudget;
    if (requested === undefined) {
      continue;
    }
    for (const key of Object.keys(requested) as readonly (keyof WorkPackageBudget)[]) {
      const value = requested[key];
      if (value === undefined) {
        continue;
      }
      if (!Number.isSafeInteger(value) || value < 0 || value > caps[key]) {
        violations.push({
          code: 'work_package_budget_exceeded',
          message: `Work Package ${planned.key} 的 ${key} 需求 ${String(value)} 超过上限 ${caps[key]}`,
          workPackageKey: planned.key,
        });
      }
    }
  }
  return violations;
}
