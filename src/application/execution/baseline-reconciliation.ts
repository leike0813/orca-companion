/**
 * IC-10 / IP-6：Baseline Reconciliation 的独立任务与核验
 * （Owner: `m1-evolve-execution-graph`，D9）。
 *
 * 当 Graph Revision 让某个 Work Package 的 worktree base 落后于它所需的基线时，基线修复**不是**实现角色
 * 的职责：系统建立一个独立的 Planner-profile 任务，先核验祖先关系、目标 HEAD、dirty paths 与 scope，
 * 核验通过后才开始修订后的规格工作。
 *
 * 本模块不调用 Git、不派发 Worker：Git 事实由调用方注入（`BaselineGitObservations`），Worker 派发由
 * Controller 用返回的任务计划完成。`planBaselineReconciliation` 是纯判定，因此「为什么这里需要补救」
 * 可以在不产生副作用的前提下复算。
 */

import type { CoordinationScopeId, WorkPackageId } from '../dto/identity.js';
import type {
  BaselineReconciliationRecord,
  BranchCoordinationStore,
  CoordinationWriter,
} from '../ports/branch-coordination-store.js';
import type { ScopeEnvelope } from '../../domain/planning/execution-graph.js';
import { pathWithinEnvelope, pathWithinWorktree } from '../specification-admission.js';
import { readScope } from '../planning/scope-read.js';

export type BaselineReconciliationPlan = {
  readonly reconciliationId: string;
  readonly workPackageId: WorkPackageId;
  readonly requiredBaselineHead: string;
  readonly observedBaseHead: string;
  /** Baseline Reconciliation 固定是 Planner-profile 的独立任务。 */
  readonly role: 'planner';
  readonly independentFromImplementation: true;
};

/** Controller 对一条持久化 Baseline Reconciliation 的确定性推进结果。 */
export type BaselineReconciliationProgress =
  | { readonly kind: 'dispatched' }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'verified' }
  | { readonly kind: 'blocked'; readonly reason: string };

export type BaselineReconciliationDriver = (
  plan: BaselineReconciliationPlan,
) => Promise<BaselineReconciliationProgress>;

export type BaselineReconciliationFailure = {
  readonly code: string;
  readonly message: string;
};

/** 稳定的 ReconciliationId：同一 (Work Package, 目标基线) 重放不会产生第二个需求。 */
export function reconciliationIdFor(workPackageId: WorkPackageId, requiredBaselineHead: string): string {
  return `baseline-reconciliation:${workPackageId}:${requiredBaselineHead}`;
}

/**
 * worktree base 与所需基线的关系；由调用方从 Git 事实给出，本模块不自己读 Git。
 *
 * `ahead`（base 已包含所需基线）与 `equal` 都不需要补救：D9 要求的是「base 落后」这一种情况，
 * 领先的 base 去补救只会把一个已经满足的前置条件当成缺口。
 */
export type BaselineRelation = 'behind' | 'ahead' | 'diverged' | 'equal';

/** 基线是否落后到需要独立补救。 */
export function planBaselineReconciliation(input: {
  readonly workPackageId: WorkPackageId;
  readonly requiredBaselineHead: string;
  readonly worktreeBaseHead: string;
  readonly relation: BaselineRelation;
}): { readonly kind: 'not_required' } | { readonly kind: 'required'; readonly plan: BaselineReconciliationPlan } {
  if (input.relation === 'equal' || input.relation === 'ahead') {
    return { kind: 'not_required' };
  }
  return {
    kind: 'required',
    plan: {
      reconciliationId: reconciliationIdFor(input.workPackageId, input.requiredBaselineHead),
      workPackageId: input.workPackageId,
      requiredBaselineHead: input.requiredBaselineHead,
      observedBaseHead: input.worktreeBaseHead,
      role: 'planner',
      independentFromImplementation: true,
    },
  };
}

export type RecordBaselineReconciliationResult =
  | { readonly kind: 'recorded'; readonly plan: BaselineReconciliationPlan }
  | { readonly kind: 'already_required'; readonly reconciliationId: string }
  | { readonly kind: 'rejected'; readonly failure: BaselineReconciliationFailure };

/**
 * 登记基线补救需求。
 *
 * 幂等：同一 Work Package 已有一个未收尾的需求时返回 `already_required`，不产生第二行——`AGENTS.md` 要求
 * 一个 Work Package 同时至多一个未收尾核验。
 */
export function recordBaselineReconciliation(input: {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly writer: CoordinationWriter;
  readonly plan: BaselineReconciliationPlan;
}): RecordBaselineReconciliationResult {
  const existing = input.store.query({
    kind: 'baseline-reconciliations',
    coordinationScopeId: input.coordinationScopeId,
    workPackageId: input.plan.workPackageId,
  });
  if (existing.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: existing.code, message: existing.message } };
  }
  if (existing.kind === 'baseline-reconciliations') {
    const open = existing.reconciliations.find((record) => record.state === 'required');
    if (open !== undefined) {
      return { kind: 'already_required', reconciliationId: open.reconciliationId };
    }
  }
  const scope = readScope(input.store, input.coordinationScopeId);
  if (scope.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: scope.code, message: scope.message } };
  }
  const recorded = input.store.transact({
    kind: 'record-baseline-reconciliation',
    coordinationScopeId: input.coordinationScopeId,
    expectedRevision: scope.scope.revision,
    writer: input.writer,
    reconciliationId: input.plan.reconciliationId,
    workPackageId: input.plan.workPackageId,
    requiredBaselineHead: input.plan.requiredBaselineHead,
  });
  if (recorded.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: recorded.code, message: recorded.message } };
  }
  return { kind: 'recorded', plan: input.plan };
}

/** 调用方从 Git 读到的事实；本模块不自己读 Git。 */
export type BaselineGitObservations = {
  readonly observedHead: string;
  /** 观察到的 HEAD 是否是目标基线的后代（祖先关系可核验）。 */
  readonly descendantOfRequiredBaseline: boolean;
  readonly dirtyPaths: readonly string[];
};

export type BaselineReconciliationObservations = {
  readonly observedHead: string;
  readonly ancestryVerified: boolean;
  readonly targetHeadVerified: boolean;
  readonly dirtyPathsReconciled: boolean;
  readonly scopeReconciled: boolean;
};

/**
 * 把 Git 事实翻译成核验结论。
 *
 * 四件事分别判定：祖先关系、目标 HEAD、dirty paths 是否是 worktree 内的合法相对路径、以及 dirty paths
 * 是否越出该 Work Package 的 Scope Envelope。其中任何一项不成立都只会得到 `false`，不会被读成通过。
 */
export function baselineObservations(input: {
  readonly envelope: ScopeEnvelope;
  readonly requiredBaselineHead: string;
  readonly git: BaselineGitObservations;
}): BaselineReconciliationObservations {
  return {
    observedHead: input.git.observedHead,
    ancestryVerified: input.git.descendantOfRequiredBaseline,
    targetHeadVerified: input.git.observedHead === input.requiredBaselineHead,
    dirtyPathsReconciled: input.git.dirtyPaths.every((path) => pathWithinWorktree(path)),
    scopeReconciled: input.git.dirtyPaths.every((path) => pathWithinEnvelope(input.envelope, path)),
  };
}

export type SettleBaselineReconciliationResult =
  | { readonly kind: 'verified' }
  | { readonly kind: 'blocked'; readonly reason: string }
  | { readonly kind: 'rejected'; readonly failure: BaselineReconciliationFailure };

function unmetObservations(observations: BaselineReconciliationObservations): readonly string[] {
  const unmet: string[] = [];
  if (!observations.ancestryVerified) unmet.push('祖先关系');
  if (!observations.targetHeadVerified) unmet.push('目标 HEAD');
  if (!observations.dirtyPathsReconciled) unmet.push('dirty paths');
  if (!observations.scopeReconciled) unmet.push('scope');
  return unmet;
}

/**
 * 收尾一次基线核验。
 *
 * 四项全部核验通过才是 `verified`；否则记 `blocked` 并给出未对账项，绝不把部分核验读成已完成。
 */
export function settleBaselineReconciliation(input: {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly writer: CoordinationWriter;
  readonly reconciliationId: string;
  readonly observations: BaselineReconciliationObservations;
}): SettleBaselineReconciliationResult {
  const scope = readScope(input.store, input.coordinationScopeId);
  if (scope.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: scope.code, message: scope.message } };
  }
  const unmet = unmetObservations(input.observations);
  const state = unmet.length === 0 ? 'verified' : 'blocked';
  const settled = input.store.transact({
    kind: 'advance-baseline-reconciliation',
    coordinationScopeId: input.coordinationScopeId,
    expectedRevision: scope.scope.revision,
    writer: input.writer,
    reconciliationId: input.reconciliationId,
    state,
    observedHead: input.observations.observedHead,
    ancestryVerified: input.observations.ancestryVerified,
    targetHeadVerified: input.observations.targetHeadVerified,
    dirtyPathsReconciled: input.observations.dirtyPathsReconciled,
    scopeReconciled: input.observations.scopeReconciled,
    ...(state === 'blocked' ? { blockerRef: `baseline-reconciliation:${unmet.join('|')}` } : {}),
  });
  if (settled.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: settled.code, message: settled.message } };
  }
  return state === 'verified' ? { kind: 'verified' } : { kind: 'blocked', reason: `未对账：${unmet.join('、')}` };
}

/** 某个 Work Package 当前未收尾的核验需求；`null` 表示基线不再落后。 */
export function openBaselineReconciliation(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
  workPackageId: WorkPackageId,
): BaselineReconciliationRecord | null {
  const result = store.query({ kind: 'baseline-reconciliations', coordinationScopeId, workPackageId });
  if (result.kind !== 'baseline-reconciliations') {
    return null;
  }
  return result.reconciliations.find((record) => record.state === 'required') ?? null;
}
