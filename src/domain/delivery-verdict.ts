/**
 * IC-08 / D11：Delivery Verdict 的结构与确定性接受
 * （Owner: `m1-execute-and-validate-work-packages`）。
 *
 * 项目级交付结论只能由独立只读 Finalizer 给出，并且只有通过角色、会话、覆盖范围与证据核对之后
 * 才被接受。接受只产生一条**新的**分支级结论记录：它不改写 Execution Graph、Accepted Worker
 * Result、Git 历史或 Operation Intent，因此不可能用收尾结论掩盖既有权威事实。
 *
 * 纯函数：不读时钟、不碰存储、不派发任何东西。
 */

import type { WorkPackageId } from '../application/dto/identity.js';
import type { WorkerRole } from './planning/execution-authorization.js';

export type DeliveryVerdict =
  | { readonly kind: 'deliverable'; readonly evidenceRefs: readonly string[] }
  | { readonly kind: 'blocked'; readonly blockerRefs: readonly string[] };

export type DeliveryVerdictDecisionCode =
  | 'role_mismatch'
  | 'session_reused'
  | 'session_not_read_only'
  | 'coverage_incomplete'
  | 'missing_evidence'
  | 'evidence_conflicts_with_authoritative_facts';

export type FinalizerSessionFacts =
  /** 新的只读项目级会话：唯一被接受的形态。 */
  | { readonly kind: 'new_read_only'; readonly sessionBindingId: string }
  /** 复用了既有会话；无论是否只读都不能作为项目级结论的来源。 */
  | { readonly kind: 'reused'; readonly sessionBindingId: string }
  /** 会话能力不足或无法核验；不能假定它只读。 */
  | { readonly kind: 'unverifiable'; readonly reason: string };

export type FinalizerReportFacts = {
  readonly role: WorkerRole;
  readonly session: FinalizerSessionFacts;
  /** Finalizer 会话是否被核验为只读权限。 */
  readonly readOnly: boolean;
  readonly coveredWorkPackageIds: readonly WorkPackageId[];
  /** 全部必须通过验证的 Work Package。 */
  readonly expectedWorkPackageIds: readonly WorkPackageId[];
  readonly verdict: DeliveryVerdict;
  /** 既有权威事实中已经登记的引用：Accepted Worker Result 与已完成 Integration Operation。 */
  readonly authoritativeRefs: readonly string[];
};

export type DeliveryVerdictDecision =
  | {
      readonly kind: 'accepted';
      readonly verdict: DeliveryVerdict;
      /** `false` 表示结论是阻塞，项目必须保持不可交付。 */
      readonly deliverable: boolean;
    }
  | {
      readonly kind: 'blocked';
      readonly code: DeliveryVerdictDecisionCode;
      readonly mismatches: readonly string[];
      readonly message: string;
    };

function blocked(
  code: DeliveryVerdictDecisionCode,
  mismatches: readonly string[],
  message: string,
): DeliveryVerdictDecision {
  return { kind: 'blocked', code, mismatches, message };
}

/**
 * 核验并接受一份 Finalizer 结论。
 *
 * 判定顺序固定：角色 → 会话 → 只读 → 覆盖范围 → 证据。任何一步不成立都阻塞，并且**不**写入
 * 结论记录：报告不一致时保持不可交付，而不是以收尾结论覆盖权威事实。
 */
export function evaluateDeliveryVerdict(facts: FinalizerReportFacts): DeliveryVerdictDecision {
  if (facts.role !== 'finalizer') {
    return blocked('role_mismatch', ['role'], `交付结论必须由 finalizer 角色给出，实际为 ${facts.role}`);
  }
  if (facts.session.kind === 'reused') {
    return blocked(
      'session_reused',
      [facts.session.sessionBindingId],
      'Finalizer 必须使用新的项目级会话，不能复用既有会话',
    );
  }
  if (facts.session.kind === 'unverifiable') {
    return blocked('session_not_read_only', ['session'], facts.session.reason);
  }
  if (!facts.readOnly) {
    return blocked('session_not_read_only', ['readOnly'], 'Finalizer 会话未被核验为只读权限');
  }

  const covered = new Set(facts.coveredWorkPackageIds);
  const missing = facts.expectedWorkPackageIds.filter((id) => !covered.has(id));
  if (missing.length > 0) {
    return blocked(
      'coverage_incomplete',
      missing,
      `交付结论未覆盖全部 Work Package：${missing.join(', ')}`,
    );
  }

  if (facts.verdict.kind === 'blocked') {
    if (facts.verdict.blockerRefs.length === 0) {
      return blocked('missing_evidence', ['blockerRefs'], '阻塞结论必须给出至少一个阻塞项引用');
    }
    return { kind: 'accepted', verdict: facts.verdict, deliverable: false };
  }

  if (facts.verdict.evidenceRefs.length === 0) {
    return blocked('missing_evidence', ['evidenceRefs'], '可交付结论必须给出覆盖项目的证据引用');
  }
  const authoritative = new Set(facts.authoritativeRefs);
  const unknown = facts.verdict.evidenceRefs.filter((ref) => !authoritative.has(ref));
  if (unknown.length > 0) {
    return blocked(
      'evidence_conflicts_with_authoritative_facts',
      unknown,
      `交付结论引用了与既有权威事实不一致的证据：${unknown.join(', ')}`,
    );
  }
  return { kind: 'accepted', verdict: facts.verdict, deliverable: true };
}
