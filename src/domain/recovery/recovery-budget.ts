/**
 * IC-09 / IP-6：按 Worker Attempt 独立计数的 Recovery Budget（Owner: `m1-recover-execution`）。
 *
 * 计数语义由 IP-3 的持久记录确定：单条 Recovery 的 `consumedBudget` 是**覆盖**值，某个
 * `businessAttemptId` 的已消耗总额等于该 attempt 全部 Recovery 记录的 `consumedBudget` 之和。
 * 因此没有第二份计数、也没有可以清零的游标——重启、恢复、Patch 与重规划都不可能重置已消耗额度。
 *
 * Recovery Budget 与实现尝试、验证修复等业务预算**分开计数**：它们各自有独立的计数键命名空间，
 * 本模块只负责恢复这一条。上限只来自已批准的
 * `ExecutionAuthorizationManifest.maxRecoveriesPerWorkerAttempt`；上限判定复用应用层
 * `recoveryAllowance`（`src/application/planning/authorization-service.ts`），本模块不复制该策略，
 * 也不在 Manifest 之外缓存预算来源。
 *
 * 纯算术：不读时钟、不碰存储、不调用 Orca。
 */

/** 恢复预算的计数对象：每个 Worker Attempt 一份，而不是每个 Validation Attempt 或每个 Session。 */
export const RECOVERY_BUDGET_ENTITY = 'worker-attempt';

/** 计数键前缀；与实现/验证/修复预算键不会互相覆盖。 */
export const RECOVERY_BUDGET_KEY_PREFIX = 'recovery';

/** 某个 Worker Attempt 的恢复预算计数键，供投影与断言使用。 */
export function workerAttemptRecoveryBudgetKey(businessAttemptId: string): string {
  return `${RECOVERY_BUDGET_KEY_PREFIX}:${RECOVERY_BUDGET_ENTITY}:${businessAttemptId}`;
}

/** 判断一个计数键是否属于恢复预算命名空间。 */
export function isRecoveryBudgetKey(key: string): boolean {
  return key.startsWith(`${RECOVERY_BUDGET_KEY_PREFIX}:`);
}

/** 预算读取只需要这两个字段；其它 Recovery 字段与计数无关。 */
export type RecoveryBudgetLedgerEntry = {
  readonly businessAttemptId: string;
  readonly consumedBudget: number;
};

/**
 * 某个 Worker Attempt 的已消耗恢复额度。
 *
 * 求和而不是取最大值或最后一行：每条 Recovery 记录只表达自己消耗了几次，总额必须由全部记录
 * 相加得出，因此任何单行覆盖都不会让总额回退。
 */
export function consumedRecoveryBudget(
  entries: readonly RecoveryBudgetLedgerEntry[],
  businessAttemptId: string,
): number {
  let total = 0;
  for (const entry of entries) {
    if (entry.businessAttemptId === businessAttemptId) {
      total += entry.consumedBudget;
    }
  }
  return total;
}

/** 按 Worker Attempt 汇总全部已消耗额度；每个 attempt 独立计数。 */
export function recoveryBudgetLedger(
  entries: readonly RecoveryBudgetLedgerEntry[],
): ReadonlyMap<string, number> {
  const ledger = new Map<string, number>();
  for (const entry of entries) {
    ledger.set(entry.businessAttemptId, (ledger.get(entry.businessAttemptId) ?? 0) + entry.consumedBudget);
  }
  return ledger;
}

/**
 * 创建替代 Session Segment 时该条 Recovery 的新消耗值。
 *
 * 一条 Recovery 最多产生一个替代 Session Segment，所以创建时把该条记录的消耗从 0 覆盖为 1；
 * 重复写入同样的值（重启续办、崩溃后重放）不会重复消耗，这就是覆盖语义要保护的幂等性。
 */
export function recoveryConsumptionOnReplacement(currentConsumedBudget: number): number {
  return currentConsumedBudget <= 0 ? 1 : currentConsumedBudget;
}
