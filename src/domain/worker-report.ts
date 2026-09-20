/**
 * IC-07 / IP-A3：四种 Worker 报告与证据失效判定（Owner: `m1-admit-work-package-specifications`）。
 *
 * 报告是候选载荷：它只描述 Worker 声称发生了什么，不携带任何可以推进生命周期的身份位。
 * 因此本模块的类型里没有 scope、run、consumer generation、operation identity 或协调身份；
 * 归属（Task / Dispatch / Attempt / 角色）由 Controller 在校验后从可信来源注入。
 *
 * 证据记录必须落在受影响的工作区范围内，并且只指向可复核的命令与结果：它不携带完整 transcript，
 * 也不做全仓断言。后续变更触及某个证据记录的范围时，该记录即失效，不能再用来推进生命周期。
 */

import type { EvidenceRequirement } from './task-contract.js';

export const EVIDENCE_RECORD_KINDS = ['command', 'inspection', 'review'] as const;

export type EvidenceRecordKind = (typeof EVIDENCE_RECORD_KINDS)[number];

/** 单条有界证据：范围是 worktree 相对路径集合，`command` 与 `summary` 是可复核的最小事实。 */
export type EvidenceRecord = {
  readonly evidenceId: string;
  readonly kind: EvidenceRecordKind;
  readonly coveredPaths: readonly string[];
  readonly command: string | null;
  readonly summary: string;
  /** 证据采信与否；只有通过校验且未被失效的记录才可用于推进生命周期。 */
  readonly outcome: 'passed' | 'failed';
};

export type WorkerResult = {
  readonly reportId: string;
  readonly summary: string;
  readonly evidence: readonly EvidenceRecord[];
};

export type WorkerQuestion = {
  readonly reportId: string;
  readonly question: string;
  /** 该回答阻塞的工作范围；之外的 Work Package 不受影响。 */
  readonly blockedWorkPackageIds: readonly string[];
};

export const ESCALATION_REASONS = [
  'scope',
  'design',
  'dependency',
  'authority',
  'budget',
] as const;

export type EscalationReason = (typeof ESCALATION_REASONS)[number];

export type WorkerEscalation = {
  readonly reportId: string;
  readonly reason: EscalationReason;
  readonly request: string;
};

export type WorkerReport = WorkerResult | WorkerQuestion | WorkerEscalation;

/** 只判定报告形状，不判定归属：归属校验属于 Controller 的接管路径。 */
export function isWorkerResult(report: WorkerReport): report is WorkerResult {
  return 'evidence' in report;
}

export function isWorkerQuestion(report: WorkerReport): report is WorkerQuestion {
  return 'question' in report;
}

export function isWorkerEscalation(report: WorkerReport): report is WorkerEscalation {
  return 'reason' in report;
}

export type EvidenceCoverage = {
  readonly evidence: EvidenceRecord;
  /** 该证据覆盖的 worktree 相对路径集合。 */
  readonly coveredPaths: readonly string[];
};

export type EvidenceInvalidation = {
  readonly evidenceId: string;
  /** 证据覆盖范围与本次变更相交的路径，按输入顺序稳定排序。 */
  readonly invalidatedPaths: readonly string[];
};

/**
 * 路径是否被变更触及。
 *
 * 只需判定「变更路径落在证据覆盖范围内」：覆盖 `src/domain` 的证据会因 `src/domain/x.ts` 变化而失效，
 * 覆盖 `src/domain/x.ts` 的证据不会因 `src/application/x.ts` 变化而失效。这里做的是纯前缀判定，
 * 不解析 glob、不猜测语义。
 */
export function pathTouchesCoverage(coveredPath: string, changedPath: string): boolean {
  if (coveredPath === changedPath) {
    return true;
  }
  const prefix = coveredPath.endsWith('/') ? coveredPath : `${coveredPath}/`;
  return changedPath.startsWith(prefix);
}

/**
 * 判定一组证据里哪些因本次变更而失效。
 *
 * 未被触及的证据不进结果；因此空数组表示「没有任何证据失效」，而不是「没有任何证据」。
 */
export function invalidateEvidence(
  evidence: readonly EvidenceRecord[],
  changedPaths: readonly string[],
): readonly EvidenceInvalidation[] {
  const invalidation: EvidenceInvalidation[] = [];
  for (const record of evidence) {
    const invalidatedPaths: string[] = [];
    for (const changedPath of changedPaths) {
      if (record.coveredPaths.some((covered) => pathTouchesCoverage(covered, changedPath))) {
        invalidatedPaths.push(changedPath);
      }
    }
    if (invalidatedPaths.length > 0) {
      invalidation.push({ evidenceId: record.evidenceId, invalidatedPaths });
    }
  }
  return invalidation;
}

/** 证据是否仍然可用于推进该 Work Package 的生命周期。 */
export function evidenceIsUsable(
  record: EvidenceRecord,
  changedPaths: readonly string[],
): boolean {
  const invalidated = invalidateEvidence([record], changedPaths);
  return invalidated.length === 0;
}

/**
 * 证据记录是否符合边界约定：必须限定在受影响范围内，且不得携带完整 transcript 或全仓断言。
 *
 * 判定只看结构：`coveredPaths` 非空且不是仓库根，`command` 与 `summary` 都不为空。
 */
export function evidenceIsBounded(record: EvidenceRecord): boolean {
  if (record.coveredPaths.length === 0) {
    return false;
  }
  if (record.coveredPaths.some((path) => path === '' || path === '.' || path === '/')) {
    return false;
  }
  return record.command !== null && record.command.length > 0 && record.summary.length > 0;
}

/** 期望证据与回报证据的种类对应关系；缺失的期望证据在结果里逐条列出。 */
export function missingExpectedEvidence(
  expected: readonly EvidenceRequirement[],
  reported: readonly EvidenceRecord[],
): readonly string[] {
  const reportedKinds = new Set(reported.map((record) => record.kind));
  return expected
    .map((requirement) => requirement.evidenceKind)
    .filter((kind) => !reportedKinds.has(kind as EvidenceRecordKind));
}
