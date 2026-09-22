/**
 * IC-10 / IP-3：Graph Revision 的 Admission 归一化与唯一提交路径
 * （Owner: `m1-evolve-execution-graph`，D5）。
 *
 * 两条硬边界：
 *
 * 1. Planner 的 Accepted Worker Result 是**来源证据**，不是图。本模块只接受未归一化载荷（`draft`），
 *    由 `admitGraphRevision` 做编译校验并产出带私有 brand 的 `AdmittedGraphRevision`；
 * 2. 唯一提交点是 `ExecutionGraphHistory.appendAcceptedRevision`。`applyGraphRevision` 只接受
 *    `AdmittedGraphRevision`，并按 expected version、补丁标识与 Controller 签发的 OperationId 追加，
 *    写入后回读确认。Store 不暴露第二条写图路径。
 *
 * 修订额度与图变化在同一事务内记账：每个被重定义的 Work Package 消耗一次 `graphRevisions`，因此
 * 不可能出现「图已改、额度未扣」的欠账。`specification_revision` 处置只登记后续需求，不在补丁里扣
 * Specification Revision 额度（那是修订服务的事）。
 */

import type { CoordinationScopeId, OperationId, WorkPackageId } from '../../application/dto/identity.js';
import type { CoordinationWriter } from '../../application/ports/branch-coordination-store.js';
import type { BudgetConsumption } from '../../domain/dispatch-candidate.js';
import { workPackageBudgetKey } from '../../domain/dispatch-candidate.js';
import type { GraphVersionRecord } from '../../domain/planning/execution-graph.js';
import type { ExecutionAuthorizationRecord } from '../../domain/planning/execution-authorization.js';
import type { ExecutionLimits } from '../../domain/planning/budget-policy.js';
import type { GraphPatchPlannerEvidence } from './graph-patch-planner.js';
import type { PatchResponsibilityTakeover, PatchDescendantDisposition } from '../../domain/execution/graph-patch.js';
import {
  compileGraphPatch,
  type CompiledGraphPatch,
  type GraphPatchCompilationError,
} from '../../domain/execution/graph-compiler.js';
import { appendAcceptedRevision, type GraphHistoryFailure } from '../planning/graph-history.js';
import {
  planBaselineReconciliation,
  type BaselineRelation,
  type BaselineReconciliationDriver,
  type BaselineReconciliationPlan,
  type BaselineReconciliationProgress,
} from './baseline-reconciliation.js';

declare const admittedGraphRevisionBrand: unique symbol;

/**
 * 已经被 Admission 归一化、可以提交的 Graph Revision。
 *
 * brand 只在本模块里可命名，因此外部模块无法凭结构拼出一个 `AdmittedGraphRevision`：任何提交都必须
 * 经过 `admitGraphRevision`。
 */
export type AdmittedGraphRevision = CompiledGraphPatch & {
  readonly [admittedGraphRevisionBrand]: 'AdmittedGraphRevision';
};

/** 未归一化载荷：Planner 结果或显式补丁草案。 */
export type GraphRevisionDraft = {
  /** 载荷里的 operationId 与 patchId 一律被丢弃；真正进入提交的由 Controller 签发。 */
  readonly payload: unknown;
  readonly operationId: OperationId;
  /** 提交幂等键；模型填写的同名字段不得成为它。 */
  readonly patchId: string;
};

export type AdmitGraphRevisionInput = {
  readonly draft: GraphRevisionDraft;
  readonly current: GraphVersionRecord;
  readonly limits: ExecutionLimits;
  readonly authorization: ExecutionAuthorizationRecord | null;
  readonly acceptedWorkPackageIds: readonly WorkPackageId[];
  readonly dispatchedWorkPackageIds: readonly WorkPackageId[];
  readonly consumedRevisions?: readonly BudgetConsumption[];
};

export type AdmitGraphRevisionResult =
  | { readonly kind: 'admitted'; readonly revision: AdmittedGraphRevision }
  | { readonly kind: 'rejected'; readonly errors: readonly GraphPatchCompilationError[] };

/**
 * 把一份载荷归一化成可提交的 Graph Revision。
 *
 * 这里复用唯一的图补丁编译器：版本、后代处置、引用、无环、Scope、预算、授权与修订额度都在同一次
 * 判定里完成，所以「Admission 通过的修订」与「编译器接受的补丁」是同一种东西。
 */
export function admitGraphRevision(input: AdmitGraphRevisionInput): AdmitGraphRevisionResult {
  const compiled = compileGraphPatch({
    patch: input.draft.payload,
    current: input.current,
    limits: input.limits,
    authorization: input.authorization,
    acceptedWorkPackageIds: input.acceptedWorkPackageIds,
    dispatchedWorkPackageIds: input.dispatchedWorkPackageIds,
    ...(input.consumedRevisions === undefined ? {} : { consumedRevisions: input.consumedRevisions }),
    trustedOperationId: input.draft.operationId,
    trustedPatchId: input.draft.patchId,
  });
  if (!compiled.ok) {
    return { kind: 'rejected', errors: compiled.errors };
  }
  return { kind: 'admitted', revision: compiled.value as AdmittedGraphRevision };
}

/** 从 Planner 证据构造草案：证据本身永远不构成图，必须先走 Admission。 */
export function graphRevisionDraftFromEvidence(evidence: GraphPatchPlannerEvidence): GraphRevisionDraft {
  return { payload: evidence.payload, operationId: evidence.operationId, patchId: evidence.patchId };
}

export type ApplyGraphRevisionInput = {
  readonly store: Parameters<typeof appendAcceptedRevision>[0]['store'];
  readonly coordinationScopeId: CoordinationScopeId;
  readonly writer: CoordinationWriter;
  readonly revision: AdmittedGraphRevision;
  readonly current: GraphVersionRecord;
  /** 预算计数的授权上限引用；使用当前 Execution Authorization 的标识。 */
  readonly authorizationId: string;
  /** 每个需要重新起草规格的既有节点都必须给出可信 Git/worktree 观察；null 表示尚无 worktree。 */
  readonly baselines: ReadonlyMap<WorkPackageId, {
    readonly requiredBaselineHead: string;
    readonly worktreeBaseHead: string;
    readonly relation: BaselineRelation;
  } | null>;
};

export type ApplyGraphRevisionResult =
  | {
      readonly kind: 'applied';
      readonly version: GraphVersionRecord;
      readonly revisionPendingWorkPackageIds: readonly string[];
      readonly specificationRevisionRequiredWorkPackageIds: readonly string[];
      readonly takesOver: readonly PatchResponsibilityTakeover[];
      readonly descendants: readonly PatchDescendantDisposition[];
      readonly baselineReconciliations: readonly BaselineReconciliationPlan[];
    }
  | { readonly kind: 'rejected'; readonly failure: GraphHistoryFailure };

/**
 * 提交一条已归一化的 Graph Revision。
 *
 * 每个被重定义的 Work Package 在这里消耗一次 `graphRevisions`；扣减与图版本追加同一事务完成。
 */
export function applyGraphRevision(input: ApplyGraphRevisionInput): ApplyGraphRevisionResult {
  const { revision, current } = input;
  if (revision.baseGraphVersion !== current.version) {
    return {
      kind: 'rejected',
      failure: {
        code: 'base_version_mismatch',
        message: `修订基于版本 ${revision.baseGraphVersion}，当前为 ${current.version}`,
      },
    };
  }
  const baselineReconciliations: BaselineReconciliationPlan[] = [];
  for (const workPackageId of new Set([
    ...revision.revisedWorkPackageIds,
    ...revision.specificationRevisionRequiredWorkPackageIds,
  ])) {
    if (!input.baselines.has(workPackageId)) {
      return { kind: 'rejected', failure: { code: 'baseline_unverified', message: `缺少 ${workPackageId} 的基线观察` } };
    }
    const baseline = input.baselines.get(workPackageId);
    if (baseline === undefined) {
      return { kind: 'rejected', failure: { code: 'baseline_unverified', message: `基线观察 ${workPackageId} 无效` } };
    }
    if (baseline !== null) {
      const planned = planBaselineReconciliation({ workPackageId, ...baseline });
      if (planned.kind === 'required') baselineReconciliations.push(planned.plan);
    }
  }
  const budgetConsumption = revision.revisedWorkPackageIds.map((workPackageId) => ({
    budgetKey: workPackageBudgetKey(workPackageId, 'graphRevisions'),
    approvedLimitRef: input.authorizationId,
    amount: 1,
  }));
  const revisionPendingWorkPackageIds = [
    ...new Set([...revision.revisionPendingWorkPackageIds, ...baselineReconciliations.map((plan) => plan.workPackageId)]),
  ];
  const appended = appendAcceptedRevision({
    store: input.store,
    coordinationScopeId: input.coordinationScopeId,
    writer: input.writer,
    graphId: current.graphId,
    expectedVersion: current.version,
    generation: current.generation,
    mapRevision: current.mapRevision,
    planRevision: current.planRevision,
    orcaRunId: current.orcaRunId,
    graph: revision.graph,
    patch: {
      patchId: revision.patchId,
      operationId: revision.operationId,
      baseGraphVersion: revision.baseGraphVersion,
      added: revision.addedWorkPackageIds,
      revised: revision.revisedWorkPackageIds,
      retired: revision.retiredWorkPackageIds,
      descendants: revision.descendants,
      takesOver: revision.takesOver,
      revisionPendingWorkPackageIds,
    },
    ...(budgetConsumption.length === 0 ? {} : { budgetConsumption }),
    baselineReconciliations,
  });
  if (appended.kind === 'rejected') {
    return { kind: 'rejected', failure: appended.failure };
  }
  return {
    kind: 'applied',
    version: appended.version,
    revisionPendingWorkPackageIds,
    specificationRevisionRequiredWorkPackageIds: revision.specificationRevisionRequiredWorkPackageIds,
    takesOver: revision.takesOver,
    descendants: revision.descendants,
    baselineReconciliations,
  };
}

export type ApplyGraphRevisionWithBaselineResult = ApplyGraphRevisionResult & {
  readonly baselineProgress?: readonly {
    readonly reconciliationId: string;
    readonly progress: BaselineReconciliationProgress;
  }[];
};

/** Controller 入口：原子提交图后立即推进持久化的 required 记录。 */
export async function applyGraphRevisionWithBaseline(
  input: ApplyGraphRevisionInput & { readonly baselineReconciliation: BaselineReconciliationDriver },
): Promise<ApplyGraphRevisionWithBaselineResult> {
  const applied = applyGraphRevision(input);
  if (applied.kind === 'rejected') {
    return applied;
  }
  const baselineProgress: Array<{
    readonly reconciliationId: string;
    readonly progress: BaselineReconciliationProgress;
  }> = [];
  for (const plan of applied.baselineReconciliations) {
    try {
      baselineProgress.push({
        reconciliationId: plan.reconciliationId,
        progress: await input.baselineReconciliation(plan),
      });
    } catch (error) {
      baselineProgress.push({
        reconciliationId: plan.reconciliationId,
        progress: {
          kind: 'blocked',
          reason: error instanceof Error ? error.message : '基线补救 driver 异常',
        },
      });
    }
  }
  return { ...applied, baselineProgress };
}
