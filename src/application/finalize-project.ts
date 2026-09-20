/**
 * IC-08 / IP-B7：项目级收尾（Owner: `m1-execute-and-validate-work-packages`）。
 *
 * 收尾分两步，且两步都不会改写既有权威事实：
 *
 * 1. `planFinalizerDispatch`：只有全部 Work Package 通过验证、没有未决交互、也没有未结算 mutation
 *    时，才派发一个使用**新的只读项目级会话**的 Finalizer；否则保持未收尾并给出阻塞项。
 * 2. `acceptDeliveryVerdict`：核验 Finalizer 的角色、会话、覆盖范围与证据后，把结论作为一条**新的**
 *    分支级记录写入（D11）。结论为阻塞时只记录阻塞项并保持不可交付。
 *
 * 判定与副作用都不修改 Execution Graph、Accepted Worker Result、Git 历史或 Operation Intent。
 */

import type { CoordinationScopeId } from './dto/identity.js';
import type { BranchCoordinationStore, CoordinationWriter, DeliveryVerdictRecord } from './ports/branch-coordination-store.js';
import { readScope } from './planning/scope-read.js';
import {
  evaluateDeliveryVerdict,
  type DeliveryVerdict,
  type DeliveryVerdictDecision,
  type DeliveryVerdictDecisionCode,
  type FinalizerReportFacts,
} from '../domain/delivery-verdict.js';
import type { RoleAuthorities } from '../domain/planning/execution-authorization.js';
import {
  withDeliveryStatus,
  type WorkPackageStatus,
} from '../domain/work-package-status.js';

export type FinalizerGateFacts = {
  readonly workPackageStatuses: readonly WorkPackageStatus[];
  readonly pendingInteractionCount: number;
  /** 未结算的 mutation 意图数量；非零即不得收尾。 */
  readonly unresolvedMutationCount: number;
  readonly authority: RoleAuthorities;
};

export type FinalizerDispatchPlan = {
  readonly role: 'finalizer';
  /** Finalizer 使用新的项目级会话。 */
  readonly sessionKind: 'new';
  /** 权限限定为只读：不能改代码、规格、配置或 Git 历史。 */
  readonly readOnly: true;
  readonly coversWorkPackageIds: readonly WorkPackageStatus['workPackageId'][];
};

export type FinalizerGateDecision =
  | { readonly kind: 'dispatch'; readonly plan: FinalizerDispatchPlan }
  | { readonly kind: 'not_ready'; readonly blockers: readonly string[] };

/**
 * 收尾门禁。
 *
 * 判定只读且确定性：任一 Work Package 未通过验证、存在未决交互、存在未结算 mutation，或
 * Manifest 未授权 finalizer 角色时，都不派发 Finalizer。
 */
export function planFinalizerDispatch(facts: FinalizerGateFacts): FinalizerGateDecision {
  const blockers: string[] = [];
  for (const status of facts.workPackageStatuses) {
    if (status.validation.kind !== 'validated') {
      blockers.push(`work-package:${status.workPackageId}:${status.validation.kind}`);
    }
  }
  if (facts.workPackageStatuses.length === 0) {
    blockers.push('no-work-packages');
  }
  if (facts.pendingInteractionCount > 0) {
    blockers.push(`pending-interactions:${facts.pendingInteractionCount}`);
  }
  if (facts.unresolvedMutationCount > 0) {
    blockers.push(`unsettled-mutations:${facts.unresolvedMutationCount}`);
  }
  if (!facts.authority.finalizer) {
    blockers.push('finalizer-not-authorized');
  }
  if (blockers.length > 0) {
    return { kind: 'not_ready', blockers };
  }
  return {
    kind: 'dispatch',
    plan: {
      role: 'finalizer',
      sessionKind: 'new',
      readOnly: true,
      coversWorkPackageIds: facts.workPackageStatuses.map((status) => status.workPackageId),
    },
  };
}

export type FinalizeProjectInput = {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly writer: CoordinationWriter;
  readonly expectedRevision: number;
  readonly gate: FinalizerGateFacts;
  readonly report: FinalizerReportFacts;
  /** Controller 从 Orca 结果与已完成集成记录读取的权威引用；不得采用 Finalizer 自报集合。 */
  readonly authoritativeRefs: readonly string[];
  /** 稳定的结论记录 ID；恢复重放沿用同一个值。 */
  readonly verdictId: string;
};

export type FinalizeProjectResult =
  | {
      readonly kind: 'accepted';
      readonly verdict: DeliveryVerdict;
      readonly deliverable: boolean;
      /** 按结论更新后的交付状态；其它两个事实原样保留。 */
      readonly statuses: readonly WorkPackageStatus[];
      readonly record: DeliveryVerdictRecord;
    }
  | { readonly kind: 'not_ready'; readonly blockers: readonly string[] }
  | {
      readonly kind: 'blocked';
      readonly code: DeliveryVerdictDecisionCode;
      readonly mismatches: readonly string[];
      readonly message: string;
    }
  | { readonly kind: 'persist_failed'; readonly code: string; readonly message: string };

function projectStatuses(
  statuses: readonly WorkPackageStatus[],
  verdict: DeliveryVerdict,
  verdictId: string,
): readonly WorkPackageStatus[] {
  return statuses.map((status) =>
    withDeliveryStatus(
      status,
      verdict.kind === 'deliverable'
        ? { kind: 'deliverable', verdictRef: verdictId }
        : { kind: 'blocked', verdictRef: verdictId, blockerRefs: verdict.blockerRefs },
    ),
  );
}

/**
 * 核验并记录一份 Delivery Verdict。
 *
 * 门禁不通过或核验不通过时不写入任何记录：项目保持未收尾或不可交付，而不是以收尾结论覆盖既有
 * 权威事实。写入后回读核验，回读失败即报告未持久化。
 */
export function finalizeProject(input: FinalizeProjectInput): FinalizeProjectResult {
  const gate = planFinalizerDispatch(input.gate);
  if (gate.kind === 'not_ready') {
    return { kind: 'not_ready', blockers: gate.blockers };
  }

  const decision: DeliveryVerdictDecision = evaluateDeliveryVerdict({
    ...input.report,
    expectedWorkPackageIds: gate.plan.coversWorkPackageIds,
    authoritativeRefs: input.authoritativeRefs,
  });
  if (decision.kind === 'blocked') {
    return decision;
  }
  if (input.report.session.kind !== 'new_read_only') {
    return {
      kind: 'blocked',
      code: 'session_not_read_only',
      mismatches: ['session'],
      message: 'Finalizer 会话未被核验为新的只读会话',
    };
  }

  const current = readScope(input.store, input.coordinationScopeId);
  if (current.kind === 'rejected') {
    return { kind: 'persist_failed', code: current.code, message: current.message };
  }
  if (current.scope.revision !== input.expectedRevision) {
    return {
      kind: 'persist_failed',
      code: 'stale_revision',
      message: `expected revision ${input.expectedRevision} 已过期，当前为 ${current.scope.revision}`,
    };
  }
  const recorded = input.store.transact({
    kind: 'record-delivery-verdict',
    coordinationScopeId: input.coordinationScopeId,
    expectedRevision: current.scope.revision,
    writer: input.writer,
    verdictId: input.verdictId,
    verdict: decision.verdict,
    finalizerRole: 'finalizer',
    sessionBindingRef: input.report.session.sessionBindingId,
  });
  if (recorded.kind === 'rejected') {
    return { kind: 'persist_failed', code: recorded.code, message: recorded.message };
  }

  const readback = input.store.query({ kind: 'delivery-verdicts', coordinationScopeId: input.coordinationScopeId });
  if (readback.kind === 'rejected') {
    return { kind: 'persist_failed', code: readback.code, message: readback.message };
  }
  if (readback.kind !== 'delivery-verdicts') {
    return { kind: 'persist_failed', code: 'invalid_state', message: '交付结论查询返回了错误的结果种类' };
  }
  const latest = readback.verdicts.find((record) => record.verdictId === input.verdictId);
  if (latest === undefined) {
    return { kind: 'persist_failed', code: 'readback_missing', message: '交付结论写入后无法回读' };
  }

  return {
    kind: 'accepted',
    verdict: decision.verdict,
    deliverable: decision.deliverable,
    statuses: projectStatuses(input.gate.workPackageStatuses, decision.verdict, input.verdictId),
    record: latest,
  };
}
