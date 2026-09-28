/**
 * IC-10 / IP-4、IP-5、IP-6：Specification Revision 的用例
 * （Owner: `m1-evolve-execution-graph`，D7、D8、D9）。
 *
 * 一次规格修订的生命周期固定为：
 *
 * 1. 判定额度（只读已批准 Manifest 的 `specificationRevisions` 上限）；
 * 2. 置入或认定 revision pending 持有（有界：只冻结该节点与其未接受后代）；
 * 3. 若 worktree base 落后，先建立独立的 Baseline Reconciliation 任务；
 * 4. 由 Specification Planner 在该 worktree 上重写契约内容，重新经过 Specification Admission；
 * 5. 准入通过后**在同一事务里**消耗一次规格修订额度、记录接纳的内容版本并解除持有，角色链从
 *    Implementation 继续。
 *
 * 两支来源共用这一条链路：调用方声明的纯内容修订（`planSpecificationRevision`），以及图补丁在已派发
 * 节点上留下的在途修订持有——后者只认当前图中匹配的补丁来源，并从既有 Specification Unit 取得被替换
 * 的内容版本。被替换的版本与接纳的版本都记在持有上：少了前者，「内容是否真的变了」无从判定；少了后者，
 * 修订前的角色结果会被读成修订已完成。
 *
 * 准入失败时持有保持 pending，额度不扣：契约没被接受就消耗额度会让「修订次数」表达不了实际发生的事。
 * 本模块不派发 Worker、不调用 Orca，也不实现 Admission 的检查本身（那是 `specification-admission.ts`）。
 */

import type { CoordinationScopeId, WorkPackageId } from '../dto/identity.js';
import type { BranchCoordinationStore, CoordinationWriter } from '../ports/branch-coordination-store.js';
import { workPackageBudgetKey, type BudgetConsumption } from '../../domain/dispatch-candidate.js';
import type { ExecutionAuthorizationManifest } from '../../domain/planning/execution-authorization.js';
import { evaluateRevisionRequest, type RevisionAllowance } from '../../domain/execution/revision-budget.js';
import type { SpecificationRevisionPlan } from '../../domain/execution/specification-revision.js';
import {
  planBaselineReconciliation,
  recordBaselineReconciliation,
  type BaselineReconciliationPlan,
  type BaselineRelation,
} from './baseline-reconciliation.js';
import { readScope } from '../planning/scope-read.js';

/** 重跑任务计划：从 Specification Planner 起，沿用同一 WorkPackageId 与 worktree。 */
export type SpecificationRevisionTaskPlan = {
  readonly workPackageId: WorkPackageId;
  /** 本次修订的稳定标识：在途补丁修订是补丁标识，纯内容修订是它的修订标识。 */
  readonly revisionId: string;
  readonly role: 'planner';
  /** 被替换的内容版本（修订起点）；接纳版本由 Admission 读出后核验。 */
  readonly priorContractRevision: number;
  readonly reAdmissionRequired: true;
  readonly roleChainFrom: 'planner';
  readonly reuseWorktree: true;
};

/**
 * 本次修订的来源形态。
 *
 * 两支都必须落到同一个持有语义上：内容被替换的节点在重新准入之前保持 revision pending，重新准入通过
 * 才解除。差别只在「被替换的内容版本从哪里读」：纯内容修订由调用方声明，在途补丁修订必须从已经存在
 * 的补丁持有与既有 Specification Unit 核验。
 */
export type SpecificationRevisionRequest =
  | {
      readonly kind: 'planned_content_revision';
      readonly plan: SpecificationRevisionPlan;
      /** 本次修订的稳定标识；用作持有的来源引用与重放幂等键。 */
      readonly revisionId: string;
      /** 被替换的内容版本（`planSpecificationRevision` 判定时的当前值）。 */
      readonly priorContractRevision: number;
    }
  | {
      readonly kind: 'in_flight_graph_patch';
      readonly workPackageId: WorkPackageId;
      /** 当前 GraphVersion 的补丁标识：必须与 pending 持有的来源逐项一致。 */
      readonly sourceRef: string;
      /**
       * 从既有 Specification Unit 读到的内容版本；`null` 表示该节点还没有既有 Unit（按 0 准备）。
       *
       * 持有已经记录过旧版本时以记录为准：内容版本边界是 durable 事实，不因重新读取一份可能已被改写
       * 的 Unit 而漂移。
       */
      readonly priorContractRevision: number | null;
    };

export type BeginSpecificationRevisionInput = {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly writer: CoordinationWriter;
  readonly request: SpecificationRevisionRequest;
  readonly manifest: ExecutionAuthorizationManifest;
  readonly consumption: readonly BudgetConsumption[];
  /** worktree base 与修订所需基线的关系；`null` 表示调用方无法提供该事实。 */
  readonly baseline: {
    readonly requiredBaselineHead: string;
    readonly worktreeBaseHead: string;
    readonly relation: BaselineRelation;
  } | null;
};

export type BeginSpecificationRevisionResult =
  | {
      readonly kind: 'started';
      readonly taskPlan: SpecificationRevisionTaskPlan;
      readonly allowance: RevisionAllowance;
    }
  | { readonly kind: 'baseline_reconciliation_required'; readonly reconciliation: BaselineReconciliationPlan }
  | { readonly kind: 'exhausted'; readonly reason: string }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

type RevisionHoldFacts =
  | { readonly kind: 'prepared'; readonly workPackageId: WorkPackageId; readonly sourceRef: string; readonly prior: number }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

/**
 * 解析待续办的修订来源，并算出被替换的内容版本。
 *
 * 在途补丁修订只认「当前图中的补丁持有」：来源必须与 pending 持有的来源一致，否则这次 Planner 的产出
 * 会挂到别人的持有上；持有已经记录了旧版本时以记录为准，调用方读到的值只作一致性核验。
 */
function resolveRevisionRequest(input: {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly request: SpecificationRevisionRequest;
}): RevisionHoldFacts {
  if (input.request.kind === 'planned_content_revision') {
    return {
      kind: 'prepared',
      workPackageId: input.request.plan.workPackageId,
      sourceRef: input.request.revisionId,
      prior: input.request.priorContractRevision,
    };
  }
  const holds = input.store.query({
    kind: 'revision-holds',
    coordinationScopeId: input.coordinationScopeId,
    workPackageId: input.request.workPackageId,
  });
  if (holds.kind !== 'revision-holds') {
    return { kind: 'rejected', code: 'invalid_state', message: '无法读取修订持有' };
  }
  const hold = holds.holds.find((entry) => entry.state === 'pending');
  if (hold === undefined) {
    return {
      kind: 'rejected',
      code: 'revision_hold_absent',
      message: `Work Package ${input.request.workPackageId} 没有 pending 的修订持有，不能续办修订`,
    };
  }
  if (hold.source !== 'graph_patch' || hold.sourceRef !== input.request.sourceRef) {
    return {
      kind: 'rejected',
      code: 'revision_hold_mismatch',
      message: `Work Package ${input.request.workPackageId} 的持有来自 ${hold.source}:${hold.sourceRef}，与本次修订的 ${input.request.sourceRef} 不一致`,
    };
  }
  if (
    hold.priorContractRevision !== null &&
    input.request.priorContractRevision !== null &&
    hold.priorContractRevision !== input.request.priorContractRevision
  ) {
    return {
      kind: 'rejected',
      code: 'revision_prior_conflict',
      message: `持有已记录的旧内容版本 ${String(hold.priorContractRevision)} 与本次读到的 ${String(input.request.priorContractRevision)} 不一致`,
    };
  }
  return {
    kind: 'prepared',
    workPackageId: input.request.workPackageId,
    sourceRef: hold.sourceRef,
    prior: hold.priorContractRevision ?? input.request.priorContractRevision ?? 0,
  };
}

/** 置入持有；纯内容修订的持有由这一步建立，在途补丁修订的持有已经由图版本事务建立。 */
function placeHold(input: {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly writer: CoordinationWriter;
  readonly workPackageId: WorkPackageId;
  readonly sourceRef: string;
}): { readonly ok: true } | { readonly ok: false; readonly code: string; readonly message: string } {
  const scope = readScope(input.store, input.coordinationScopeId);
  if (scope.kind === 'rejected') {
    return { ok: false, code: scope.code, message: scope.message };
  }
  const recorded = input.store.transact({
    kind: 'record-revision-hold',
    coordinationScopeId: input.coordinationScopeId,
    expectedRevision: scope.scope.revision,
    writer: input.writer,
    workPackageId: input.workPackageId,
    source: 'specification_revision',
    sourceRef: input.sourceRef,
  });
  return recorded.kind === 'rejected'
    ? { ok: false, code: recorded.code, message: recorded.message }
    : { ok: true };
}

/** 开始一次修订：解析来源、准备旧内容版本，必要时先建立基线补救任务。 */
export function beginSpecificationRevision(
  input: BeginSpecificationRevisionInput,
): BeginSpecificationRevisionResult {
  const resolved = resolveRevisionRequest({
    store: input.store,
    coordinationScopeId: input.coordinationScopeId,
    request: input.request,
  });
  if (resolved.kind === 'rejected') {
    return resolved;
  }
  const decision = evaluateRevisionRequest({
    manifest: input.manifest,
    consumption: input.consumption,
    workPackageId: resolved.workPackageId,
    field: 'specificationRevisions',
  });
  if (decision.kind === 'exhausted') {
    return { kind: 'exhausted', reason: decision.reason };
  }

  const reconciliations = input.store.query({
    kind: 'baseline-reconciliations',
    coordinationScopeId: input.coordinationScopeId,
    workPackageId: resolved.workPackageId,
  });
  if (reconciliations.kind === 'rejected') {
    return { kind: 'rejected', code: reconciliations.code, message: reconciliations.message };
  }
  if (reconciliations.kind !== 'baseline-reconciliations') {
    return { kind: 'rejected', code: 'invalid_state', message: '无法读取基线补救状态' };
  }
  const pendingBaseline = reconciliations.reconciliations.find((entry) => entry.state !== 'verified');
  if (pendingBaseline !== undefined) {
    return { kind: 'rejected', code: 'baseline_reconciliation_pending', message: `基线补救 ${pendingBaseline.reconciliationId} 尚未核验通过` };
  }

  if (input.request.kind === 'planned_content_revision') {
    const hold = placeHold({
      store: input.store,
      coordinationScopeId: input.coordinationScopeId,
      writer: input.writer,
      workPackageId: resolved.workPackageId,
      sourceRef: resolved.sourceRef,
    });
    if (!hold.ok) {
      return { kind: 'rejected', code: hold.code, message: hold.message };
    }
  }

  // 旧内容版本在同一持有上原子准备：写完它，本次修订的 Planner 才被允许派发。
  const scope = readScope(input.store, input.coordinationScopeId);
  if (scope.kind === 'rejected') {
    return { kind: 'rejected', code: scope.code, message: scope.message };
  }
  const prepared = input.store.transact({
    kind: 'prepare-revision-hold',
    coordinationScopeId: input.coordinationScopeId,
    expectedRevision: scope.scope.revision,
    writer: input.writer,
    workPackageId: resolved.workPackageId,
    sourceRef: resolved.sourceRef,
    priorContractRevision: resolved.prior,
  });
  if (prepared.kind === 'rejected') {
    return { kind: 'rejected', code: prepared.code, message: prepared.message };
  }

  if (input.baseline !== null) {
    const planned = planBaselineReconciliation({
      workPackageId: resolved.workPackageId,
      requiredBaselineHead: input.baseline.requiredBaselineHead,
      worktreeBaseHead: input.baseline.worktreeBaseHead,
      relation: input.baseline.relation,
    });
    if (planned.kind === 'required') {
      const recorded = recordBaselineReconciliation({
        store: input.store,
        coordinationScopeId: input.coordinationScopeId,
        writer: input.writer,
        plan: planned.plan,
      });
      if (recorded.kind === 'rejected') {
        return { kind: 'rejected', code: recorded.failure.code, message: recorded.failure.message };
      }
      return { kind: 'baseline_reconciliation_required', reconciliation: planned.plan };
    }
  }

  return {
    kind: 'started',
    allowance: decision.allowance,
    taskPlan: {
      workPackageId: resolved.workPackageId,
      revisionId: resolved.sourceRef,
      role: 'planner',
      priorContractRevision: resolved.prior,
      reAdmissionRequired: true,
      roleChainFrom: 'planner',
      reuseWorktree: true,
    },
  };
}

export type SpecificationAdmissionOutcome =
  | { readonly kind: 'admitted' }
  | { readonly kind: 'rejected'; readonly message: string };

export type SettleSpecificationRevisionInput = {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly writer: CoordinationWriter;
  readonly workPackageId: WorkPackageId;
  /** 触发这次持有的补丁或修订标识；必须与 pending 持有的来源一致。 */
  readonly sourceRef: string;
  /** 已核验的 Admission Spec Binding 的 `contractRevision`：本次重新准入接纳的内容版本。 */
  readonly admittedContractRevision: number;
  /** 预算计数的授权上限引用：当前 Execution Authorization 的标识。 */
  readonly authorizationId: string;
  /** 已批准 Manifest 中 `specificationRevisions` 的上限；store 在事务内拒绝越界消费。 */
  readonly approvedLimit: number;
  readonly admission: SpecificationAdmissionOutcome;
};

export type SettleSpecificationRevisionResult =
  | { readonly kind: 'accepted'; readonly nextRole: 'implementation'; readonly consumedBudgetKey: string }
  | { readonly kind: 'kept_pending'; readonly reason: string }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

/**
 * 收尾一次修订：只有重新准入通过才消耗额度并解除持有。
 *
 * 该释放携带同事务的预算扣减与接纳版本，因此「接受并计一次修订」与「解除持有」不会只发生一半；对
 * 已释放持有的重复收尾在来源与接纳版本都一致时幂等成功，不会把额度再扣一次。来源不符、旧版本未准备
 * 时 store 在事务内拒绝；接纳版本可以与被替换版本相同。
 */
export function settleSpecificationRevision(
  input: SettleSpecificationRevisionInput,
): SettleSpecificationRevisionResult {
  if (input.admission.kind === 'rejected') {
    return {
      kind: 'kept_pending',
      reason: `Specification Admission 未通过，持有保持 pending：${input.admission.message}`,
    };
  }
  const scope = readScope(input.store, input.coordinationScopeId);
  if (scope.kind === 'rejected') {
    return { kind: 'rejected', code: scope.code, message: scope.message };
  }
  const budgetKey = workPackageBudgetKey(input.workPackageId, 'specificationRevisions');
  const settled = input.store.transact({
    kind: 'release-revision-hold',
    coordinationScopeId: input.coordinationScopeId,
    expectedRevision: scope.scope.revision,
    writer: input.writer,
    workPackageId: input.workPackageId,
    reason: `specification revision ${input.sourceRef} 已重新准入`,
    expectedSourceRef: input.sourceRef,
    admittedContractRevision: input.admittedContractRevision,
    budgetConsumption: [{ budgetKey, approvedLimitRef: input.authorizationId, amount: 1 }],
    approvedLimit: input.approvedLimit,
  });
  if (settled.kind === 'rejected') {
    return { kind: 'rejected', code: settled.code, message: settled.message };
  }
  return { kind: 'accepted', nextRole: 'implementation', consumedBudgetKey: budgetKey };
}

export type SettleRetiredRevisionInput = {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly writer: CoordinationWriter;
  readonly workPackageId: WorkPackageId;
  /** 当前图里的 Work Package：仍在图里说明本次不是退休，持有留给规格重新准入去解除。 */
  readonly currentGraphWorkPackageIds: readonly WorkPackageId[];
};

export type SettleRetiredRevisionResult =
  | { readonly kind: 'released' }
  | { readonly kind: 'kept_pending'; readonly reason: string }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string };

/**
 * 结算一次「退休」造成的修订持有。
 *
 * 规格要求：修订或退休需求在 Worker 已派发时被报告，受影响节点进入 revision pending，其当前 Worker 必须
 * 先运行至可核验终态。规格修订由重新准入解除持有；**退休的节点不会再被重新准入**——它已经不在图里——
 * 因此必须由这里在「节点已退场且没有未收尾 Worker」时解除。缺了这条路径，持有会永久 pending，整个 Scope
 * 钉在 revision_pending 上（真实运行里 Finalizer 门禁因此永不满足，虽然没有 Worker 在跑）。
 *
 * 判定只读 store：节点仍在当前图里就不属于退休（持有留给规格重新准入结算）；已经不在图里则退休已生效——
 * 它不可能再有角色或依赖工作，持有继续 pending 只会把整个 Scope 钉在 revision_pending。规格要求的「当前
 * Worker 先运行至可核验终态」并不因此被违反：工作不会被打断，只是它的旧结果无法越过一个已退场的节点推进。
 *
 * 事务内的正规路径在存储层（`record-graph-version` 与图版本同事务释放）；这里兜底修复历史遗留的悬挂持有。
 */
export function settleRetiredRevision(
  input: SettleRetiredRevisionInput,
): SettleRetiredRevisionResult {
  if (input.currentGraphWorkPackageIds.includes(input.workPackageId)) {
    return { kind: 'kept_pending', reason: '节点仍在当前图中：退休未生效，持有留给规格重新准入结算' };
  }
  const scope = readScope(input.store, input.coordinationScopeId);
  if (scope.kind === 'rejected') {
    return { kind: 'rejected', code: scope.code, message: scope.message };
  }
  const released = input.store.transact({
    kind: 'release-revision-hold',
    coordinationScopeId: input.coordinationScopeId,
    expectedRevision: scope.scope.revision,
    writer: input.writer,
    workPackageId: input.workPackageId,
    reason: '节点已由图修订退场，不会有后续角色或依赖工作',
  });
  if (released.kind === 'rejected') {
    return { kind: 'rejected', code: released.code, message: released.message };
  }
  return { kind: 'released' };
}
