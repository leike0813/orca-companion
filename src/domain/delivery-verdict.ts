/**
 * IC-08 / D11：Delivery Verdict 的结构与确定性接受
 * （Owner: `m1-execute-and-validate-work-packages`）。
 *
 * 项目级交付结论由独立 Finalizer 给出，只有通过角色、会话、覆盖范围与证据核对之后
 * 才被接受。接受只产生一条**新的**分支级结论记录：它不改写 Execution Graph、Accepted Worker
 * Result、Git 历史或 Operation Intent，因此不可能用收尾结论掩盖既有权威事实。
 *
 * 纯函数：不读时钟、不碰存储、不派发任何东西。
 */

import type { WorkPackageId } from '../application/dto/identity.js';
import type { WorkerRole } from './planning/execution-authorization.js';
import type { EvidenceRecord } from './worker-report.js';

export type DeliveryVerdict =
  | { readonly kind: 'deliverable'; readonly evidenceRefs: readonly string[] }
  | { readonly kind: 'blocked'; readonly blockerRefs: readonly string[] };

export type DeliveryVerdictDecisionCode =
  | 'role_mismatch'
  | 'session_reused'
  | 'session_not_read_only'
  | 'session_not_authorized'
  | 'coverage_incomplete'
  | 'missing_evidence'
  | 'evidence_conflicts_with_authoritative_facts'
  | 'final_version_unverified'
  | 'verification_failed'
  | 'integration_unverified';

export type FinalizerSessionFacts =
  /** 新的只读项目级会话：按原授权只读核验的形态。 */
  | { readonly kind: 'new_read_only'; readonly sessionBindingId: string }
  /** 新的可写项目级会话：仅在 Manifest 显式批准修复 policy 时使用。 */
  | { readonly kind: 'new_project'; readonly sessionBindingId: string }
  /** 复用了既有会话；无论是否只读都不能作为项目级结论的来源。 */
  | { readonly kind: 'reused'; readonly sessionBindingId: string }
  /** 会话能力不足或无法核验；不能假定它只读。 */
  | { readonly kind: 'unverifiable'; readonly reason: string };

/**
 * 可写 Finalizer 的最终版本复验：绑定复验后的完整 Git HEAD/tree、真实复验命令与完成集成的权威引用。
 * `expectedHead`/`expectedTree` 是核验方读取的最终版本，与 `head`/`tree` 不一致即拒绝。
 */
export type FinalizerVerification = {
  readonly head: string;
  readonly tree: string;
  readonly expectedHead: string;
  readonly expectedTree: string;
  readonly commands: readonly EvidenceRecord[];
  /** 完成集成的权威引用；只有宿主提供真实集成结果，不能用 Finalizer 自报值。 */
  readonly integrationRef: string | null;
};

export type FinalizerReportFacts = {
  readonly role: WorkerRole;
  readonly session: FinalizerSessionFacts;
  /** 旧只读会话是否被核验为只读权限；可写项目级会话不使用该字段。 */
  readonly readOnly: boolean;
  readonly coveredWorkPackageIds: readonly WorkPackageId[];
  /** 全部必须通过验证的 Work Package。 */
  readonly expectedWorkPackageIds: readonly WorkPackageId[];
  readonly verdict: DeliveryVerdict;
  /** 既有权威事实中已经登记的引用：Accepted Worker Result 与已完成 Integration Operation。 */
  readonly authoritativeRefs: readonly string[];
  /** 可写项目级会话的最终版本复验；旧只读形态不提供，也不合成。 */
  readonly verification?: FinalizerVerification;
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

/** 完整 Git OID：SHA-1 40 位或 SHA-256 64 位小写十六进制。 */
const FULL_GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * 核验可写项目级会话的最终版本复验；通过返回 `null`。
 *
 * 版本或命令未通过时拒绝：修复后的代码版本必须先证明完整、与核验方读取的版本一致，并有真实复验；
 * 集成引用只能来自既有权威事实。
 */
function evaluateProjectVerification(
  verification: FinalizerVerification | undefined,
  authoritative: ReadonlySet<string>,
): DeliveryVerdictDecision | null {
  if (verification === undefined) {
    return blocked('final_version_unverified', ['verification'], '可写 Finalizer 必须报告最终代码版本与复验证据');
  }
  const { head, tree, expectedHead, expectedTree } = verification;
  if (
    !FULL_GIT_OID.test(head) ||
    !FULL_GIT_OID.test(tree) ||
    head !== expectedHead ||
    tree !== expectedTree
  ) {
    return blocked(
      'final_version_unverified',
      [head, tree],
      'Finalizer 报告的最终 HEAD/tree 不是完整 Git OID 或与期望版本不一致',
    );
  }
  const failed = verification.commands.some((record) => record.outcome === 'failed');
  const verified = verification.commands.some(
    (record) =>
      record.kind === 'command' &&
      record.outcome === 'passed' &&
      record.command !== null &&
      record.command.trim().length > 0,
  );
  if (failed || !verified) {
    return blocked(
      'verification_failed',
      [head],
      '可写 Finalizer 必须有通过的真实复验命令，且不能包含失败证据',
    );
  }
  const integrationRef = verification.integrationRef;
  if (integrationRef === null || !authoritative.has(integrationRef)) {
    return blocked(
      'integration_unverified',
      [integrationRef ?? 'integrationRef'],
      '最终版本必须先按授权完成集成，集成引用须来自既有权威事实',
    );
  }
  return null;
}

/**
 * 核验并接受一份 Finalizer 结论。
 *
 * 判定顺序固定：角色 → 会话 → 只读 → 覆盖范围 → 证据。任何一步不成立都阻塞，并且**不**写入
 * 结论记录：报告不一致时保持不可交付，而不是以收尾结论覆盖权威事实。可写项目级会话的可交付结论
 * 还要核验最终版本复验（完整 HEAD/tree、真实复验命令与集成引用）。
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
  if (facts.session.kind === 'new_read_only' && !facts.readOnly) {
    return blocked('session_not_read_only', ['readOnly'], 'Finalizer 会话未被核验为只读权限');
  }

  const evidence = evaluateFinalizerEvidence(facts);
  if (evidence.kind === 'blocked' || !evidence.deliverable) return evidence;
  if (facts.session.kind === 'new_project') {
    const verification = evaluateProjectVerification(facts.verification, new Set(facts.authoritativeRefs));
    if (verification !== null) return verification;
  }
  return evidence;
}

/** 集成前与最终接受共用覆盖和引用核验，不推断会话权限。 */
export function evaluateFinalizerEvidence(facts: Pick<FinalizerReportFacts,
  'coveredWorkPackageIds' | 'expectedWorkPackageIds' | 'verdict' | 'authoritativeRefs'>): DeliveryVerdictDecision {
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
