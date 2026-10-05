/**
 * IC-10 / IP-9：旧成果的采用规则、矛盾事实阻塞与 lineage 记账
 * （Owner: `m1-evolve-execution-graph`，D11）。
 *
 * 新 Work Package 只能按三条规则之一使用旧代际成果，且都不复制完成状态：
 *
 * - **Baseline Adoption**：旧结果已表示在 Replanning Baseline 中且证据仍适用；该能力被视为既有代码，
 *   新图不为它创建完成节点；
 * - **Migration Material**：旧结果、规格或未集成 worktree 只作为**只读**输入；新 Work Package 使用基于
 *   Replanning Baseline 的新 worktree，并显式迁移与重新验证；
 * - **Planning Reference**：只作为规划输入，不构成任何已实现事实。
 *
 * 语义适用性属于 Coordinator Agent；本模块只做确定性校验：被引用的接受记录是否存在、集成状态与版本是否
 * 给出、证据是否仍适用。Git、Orca 与旧图给出相互矛盾的结论时**阻塞**，而不是挑一个继续。
 */

import type { CoordinationScopeId, GraphId, WorkPackageId } from '../dto/identity.js';
import type {
  BaselineAdoptionKind,
  BaselineAdoptionRecord,
  BaselineAdoptionState,
  BranchCoordinationStore,
  CoordinationWriter,
} from '../ports/branch-coordination-store.js';
import type { BudgetConsumption } from '../../domain/dispatch-candidate.js';
import {
  effectiveConsumption,
  planLineage,
  type WorkPackageLineage,
} from '../../domain/execution/work-package-lineage.js';
import { readScope } from '../planning/scope-read.js';
import { workPackageIdFor } from '../../domain/planning/graph-compiler.js';
import type { ExecutionGraph, ImplementationPlan, PlannedAdoption } from '../../domain/planning/execution-graph.js';

export type AdoptionFailure = {
  readonly code: string;
  readonly message: string;
};

/** 一次采用的声明与外部可核验事实。 */
export type AdoptionRequest = {
  readonly workPackageId: WorkPackageId;
  readonly kind: BaselineAdoptionKind;
  readonly adoptedResultRef: string;
  readonly baselineHead: string;
  readonly integrationRef: string | null;
  /** 被引用的 Accepted Worker Result 是否仍存在于 Orca 侧。 */
  readonly acceptedResultRecorded: boolean;
  readonly evidenceRefs: readonly string[];
  readonly evidenceStillApplicable: boolean;
  /** Git、Orca 与旧图相互矛盾的结论；非空即阻塞。 */
  readonly conflictingFacts: readonly string[];
  /** Migration Material 是否以只读方式提供。 */
  readonly materialReadOnly: boolean;
  /** 新 Work Package 是否使用基于 Replanning Baseline 的新 worktree。 */
  readonly newWorktreeBasedOnBaseline: boolean;
};

export type AdoptionPlan = {
  readonly workPackageId: WorkPackageId;
  readonly kind: BaselineAdoptionKind;
  readonly adoptedResultRef: string;
  readonly baselineHead: string;
  readonly integrationRef: string | null;
  readonly evidenceRefs: readonly string[];
  /** 恒为 `true`：三条规则都不复制旧完成状态。 */
  readonly copiesCompletionState: false;
  /** 恒为 `true`：旧成果只以只读方式进入新规划。 */
  readonly readOnlyMaterial: true;
  /** 只有 Baseline Adoption 让旧能力被视为既有代码。 */
  readonly treatsCapabilityAsExistingCode: boolean;
  /** 恒为 `false`：旧成果从不自动满足新 Work Package。 */
  readonly satisfiesNewWorkPackage: false;
  /** Migration Material 必须显式迁移并重新验证。 */
  readonly requiresExplicitMigrationAndRevalidation: boolean;
};

export type AdoptionDecision =
  | { readonly kind: 'adoptable'; readonly plan: AdoptionPlan }
  | { readonly kind: 'blocked'; readonly reason: string }
  | { readonly kind: 'rejected'; readonly failure: AdoptionFailure };

/**
 * 判定一次采用是否可以继续。
 *
 * 判定顺序固定：先看矛盾事实（它排除一切继续），再看三条规则各自的必要条件，最后才给出计划。
 */
export function evaluateAdoptionRequest(request: AdoptionRequest): AdoptionDecision {
  if (request.conflictingFacts.length > 0) {
    return {
      kind: 'blocked',
      reason: `Git、Orca 与旧图对代际成果给出相互矛盾的结论：${request.conflictingFacts.join('、')}`,
    };
  }
  if (!request.acceptedResultRecorded) {
    return {
      kind: 'rejected',
      failure: { code: 'accepted_result_missing', message: `被引用的接受记录 ${request.adoptedResultRef} 不存在` },
    };
  }
  if (request.baselineHead.length === 0) {
    return {
      kind: 'rejected',
      failure: { code: 'baseline_missing', message: '采用必须绑定一个确切的 Replanning Baseline' },
    };
  }
  if (request.kind === 'baseline_adoption') {
    if (!request.evidenceStillApplicable || request.evidenceRefs.length === 0) {
      return {
        kind: 'rejected',
        failure: {
          code: 'evidence_not_applicable',
          message: 'Baseline Adoption 要求证据仍然适用且给出证据引用',
        },
      };
    }
  }
  if (request.kind === 'migration_material') {
    if (!request.materialReadOnly) {
      return {
        kind: 'rejected',
        failure: { code: 'material_mutable', message: 'Migration Material 必须以只读方式提供' },
      };
    }
    if (!request.newWorktreeBasedOnBaseline) {
      return {
        kind: 'rejected',
        failure: {
          code: 'worktree_not_rebased',
          message: 'Migration Material 的新工作必须使用基于 Replanning Baseline 的新 worktree',
        },
      };
    }
  }
  if (request.kind === 'planning_reference' && request.evidenceRefs.length === 0) {
    return {
      kind: 'rejected',
      failure: { code: 'evidence_not_applicable', message: 'Planning Reference 必须给出可追溯的引用' },
    };
  }

  return {
    kind: 'adoptable',
    plan: {
      workPackageId: request.workPackageId,
      kind: request.kind,
      adoptedResultRef: request.adoptedResultRef,
      baselineHead: request.baselineHead,
      integrationRef: request.integrationRef,
      evidenceRefs: [...request.evidenceRefs],
      copiesCompletionState: false,
      readOnlyMaterial: true,
      treatsCapabilityAsExistingCode: request.kind === 'baseline_adoption',
      satisfiesNewWorkPackage: false,
      requiresExplicitMigrationAndRevalidation: request.kind === 'migration_material',
    },
  };
}

export type RecordAdoptionResult =
  | { readonly kind: 'recorded'; readonly state: BaselineAdoptionState }
  | { readonly kind: 'already_recorded' }
  | { readonly kind: 'rejected'; readonly failure: AdoptionFailure };

/**
 * 记录一次采用结论（含矛盾事实导致的阻塞）。
 *
 * 阻塞也要落盘：矛盾事实是用户后续处理的依据，留在内存里等于把它丢掉。
 */
export function recordBaselineAdoption(input: {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly writer: CoordinationWriter;
  readonly adoptionId: string;
  readonly decision: AdoptionDecision;
  readonly request: AdoptionRequest;
}): RecordAdoptionResult {
  const existing = input.store.query({
    kind: 'baseline-adoptions',
    coordinationScopeId: input.coordinationScopeId,
    workPackageId: input.request.workPackageId,
  });
  if (existing.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: existing.code, message: existing.message } };
  }
  if (
    existing.kind === 'baseline-adoptions' &&
    existing.adoptions.some((adoption) => adoption.adoptionId === input.adoptionId)
  ) {
    return { kind: 'already_recorded' };
  }
  // 被判定为不可采用的是「没有结论」，不写记录：只有可采用与因矛盾事实阻塞才需要落盘。
  if (input.decision.kind === 'rejected') {
    return { kind: 'rejected', failure: input.decision.failure };
  }

  const state: BaselineAdoptionState = input.decision.kind === 'blocked' ? 'blocked' : 'recorded';
  const blockingReason = input.decision.kind === 'blocked' ? input.decision.reason : null;
  if (state === 'blocked' && blockingReason === null) {
    return { kind: 'rejected', failure: { code: 'invalid_state', message: '阻塞的采用必须给出矛盾事实' } };
  }
  const evidenceRefs =
    input.decision.kind === 'adoptable' ? input.decision.plan.evidenceRefs : [...input.request.evidenceRefs];
  if (state === 'recorded' && evidenceRefs.length === 0) {
    return {
      kind: 'rejected',
      failure: { code: 'evidence_not_applicable', message: '记录的采用必须给出证据引用' },
    };
  }

  const scope = readScope(input.store, input.coordinationScopeId);
  if (scope.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: scope.code, message: scope.message } };
  }
  const recorded = input.store.transact({
    kind: 'record-baseline-adoption',
    coordinationScopeId: input.coordinationScopeId,
    expectedRevision: scope.scope.revision,
    writer: input.writer,
    adoptionId: input.adoptionId,
    workPackageId: input.request.workPackageId,
    adoptionKind: input.request.kind,
    adoptedResultRef: input.request.adoptedResultRef,
    baselineHead: input.request.baselineHead,
    integrationRef: input.request.integrationRef,
    evidenceRefs,
    state,
    blockingReason,
  });
  if (recorded.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: recorded.code, message: recorded.message } };
  }
  return { kind: 'recorded', state };
}

export type RecordLineageResult =
  | { readonly kind: 'recorded'; readonly lineage: WorkPackageLineage }
  | { readonly kind: 'already_recorded' }
  | { readonly kind: 'rejected'; readonly failure: AdoptionFailure };

/**
 * 记录一次责任延续与继承额度。
 *
 * 继承值取自旧责任当前的已消耗计数（`planLineage`），因此记录里没有「重置为新值」的表达空间。
 */
export function recordWorkPackageLineage(input: {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly writer: CoordinationWriter;
  readonly workPackageId: WorkPackageId;
  readonly priorWorkPackageId: WorkPackageId;
  readonly priorGraphId: GraphId;
  readonly priorConsumed: readonly BudgetConsumption[];
}): RecordLineageResult {
  const existing = input.store.query({
    kind: 'work-package-lineages',
    coordinationScopeId: input.coordinationScopeId,
    workPackageId: input.workPackageId,
  });
  if (existing.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: existing.code, message: existing.message } };
  }
  if (existing.kind === 'work-package-lineages' && existing.lineages.length > 0) {
    return { kind: 'already_recorded' };
  }
  const planned = planLineage({
    workPackageId: input.workPackageId,
    priorWorkPackageId: input.priorWorkPackageId,
    priorGraphId: input.priorGraphId,
    priorConsumed: input.priorConsumed,
  });
  if (planned.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: planned.code, message: planned.message } };
  }
  const scope = readScope(input.store, input.coordinationScopeId);
  if (scope.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: scope.code, message: scope.message } };
  }
  const recorded = input.store.transact({
    kind: 'record-work-package-lineage',
    coordinationScopeId: input.coordinationScopeId,
    expectedRevision: scope.scope.revision,
    writer: input.writer,
    workPackageId: input.workPackageId,
    priorWorkPackageId: input.priorWorkPackageId,
    priorGraphId: input.priorGraphId,
    inherited: planned.lineage.inherited,
  });
  if (recorded.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: recorded.code, message: recorded.message } };
  }
  return { kind: 'recorded', lineage: planned.lineage };
}

/** 读取某个 Work Package 的 lineage；没有记录时返回 `null`。 */
export function loadLineage(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
  workPackageId: WorkPackageId,
): WorkPackageLineage | null {
  const result = store.query({ kind: 'work-package-lineages', coordinationScopeId, workPackageId });
  if (result.kind !== 'work-package-lineages') {
    return null;
  }
  const record = result.lineages.find((lineage) => lineage.workPackageId === workPackageId);
  return record === undefined
    ? null
    : {
        workPackageId: record.workPackageId,
        priorWorkPackageId: record.priorWorkPackageId,
        priorGraphId: record.priorGraphId,
        inherited: record.inherited,
      };
}

/**
 * 调度侧读取的「实际已消耗额度」：本代计数与 lineage 继承合并。
 *
 * 调用方把它交给 `evaluateDispatchCandidate` 之前的预算事实组装，从而继承在准入判定里自动生效，
 * 而不需要每个调用点各自记得加上继承量。
 */
export function effectiveBudgetConsumption(input: {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly workPackageId: WorkPackageId;
  readonly own: readonly BudgetConsumption[];
}): readonly BudgetConsumption[] {
  return effectiveConsumption({
    workPackageId: input.workPackageId,
    own: input.own,
    lineage: loadLineage(input.store, input.coordinationScopeId, input.workPackageId),
  });
}

/** 采用记录只读投影；供调用方核对矛盾事实的阻塞结论。 */
export function adoptionRecords(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
  workPackageId?: WorkPackageId,
): readonly BaselineAdoptionRecord[] {
  const result = store.query({
    kind: 'baseline-adoptions',
    coordinationScopeId,
    ...(workPackageId === undefined ? {} : { workPackageId }),
  });
  return result.kind === 'baseline-adoptions' ? result.adoptions : [];
}

/** 一个声明节点需要宿主回读的事实：证据是否适用、被引用的接受记录是否存在，以及旧责任当前消耗。 */
export type PlanContinuationFacts = {
  readonly acceptedResultRecorded: boolean;
  readonly evidenceStillApplicable: boolean;
  readonly conflictingFacts: readonly string[];
  readonly materialReadOnly: boolean;
  readonly newWorktreeBasedOnBaseline: boolean;
  /** 旧责任**当前**的已消耗计数；由宿主用 `effectiveBudgetConsumption` 回读，计划里没有填入新值的位置。 */
  readonly priorConsumed: readonly BudgetConsumption[];
};

export type RecordPlanContinuationsResult =
  | { readonly kind: 'recorded'; readonly adoptions: number; readonly lineages: number }
  | { readonly kind: 'blocked'; readonly reason: string }
  | { readonly kind: 'rejected'; readonly failure: AdoptionFailure };

/** 只读预检结论；`ok` 只表示「可以落盘」，不表示旧成果已满足新工作。 */
export type PlanContinuationPreflight =
  | { readonly kind: 'ok' }
  | { readonly kind: 'blocked'; readonly reason: string }
  | { readonly kind: 'rejected'; readonly failure: AdoptionFailure };

/** 由计划声明与宿主回读事实组装一次采用请求；预检与落盘共用同一构造。 */
function adoptionRequestOf(
  workPackageId: WorkPackageId,
  adoption: PlannedAdoption,
  facts: PlanContinuationFacts,
): AdoptionRequest {
  return {
    workPackageId,
    kind: adoption.kind,
    adoptedResultRef: adoption.adoptedResultRef,
    baselineHead: adoption.baselineHead,
    integrationRef: adoption.integrationRef ?? null,
    acceptedResultRecorded: facts.acceptedResultRecorded,
    evidenceRefs: adoption.evidenceRefs,
    evidenceStillApplicable: facts.evidenceStillApplicable,
    conflictingFacts: facts.conflictingFacts,
    materialReadOnly: facts.materialReadOnly,
    newWorktreeBasedOnBaseline: facts.newWorktreeBasedOnBaseline,
  };
}

/**
 * 只读预检全部采用/延续声明。
 *
 * 外部副作用（建立空 Run）与部分落盘都必须发生在整份计划已被判定之后；因此这个判定不写任何记录，
 * 只复用 `evaluateAdoptionRequest` 与 `planLineage` 的既有规则。
 */
export function preflightPlanContinuations(input: {
  readonly graph: ExecutionGraph;
  readonly plan: ImplementationPlan;
  readonly factsFor: (workPackageId: WorkPackageId) => PlanContinuationFacts | null;
}): PlanContinuationPreflight {
  for (const planned of input.plan.workPackages) {
    if (planned.adoption === undefined && planned.lineage === undefined) {
      continue;
    }
    const workPackageId = workPackageIdFor(input.graph.graphId, planned.key);
    const facts = input.factsFor(workPackageId);
    if (facts === null) {
      return {
        kind: 'rejected',
        failure: { code: 'invalid_state', message: `Work Package ${planned.key} 的采用/延续事实不可读` },
      };
    }
    if (facts.conflictingFacts.length > 0) {
      return { kind: 'blocked', reason: facts.conflictingFacts.join('；') };
    }
    if (planned.adoption !== undefined) {
      const decision = evaluateAdoptionRequest(adoptionRequestOf(workPackageId, planned.adoption, facts));
      if (decision.kind === 'rejected') {
        return { kind: 'rejected', failure: decision.failure };
      }
      if (decision.kind === 'blocked') {
        return { kind: 'blocked', reason: decision.reason };
      }
    }
    if (planned.lineage !== undefined) {
      const lineage = planLineage({
        workPackageId,
        priorWorkPackageId: planned.lineage.priorWorkPackageId as WorkPackageId,
        priorGraphId: planned.lineage.priorGraphId as GraphId,
        priorConsumed: facts.priorConsumed,
      });
      if (lineage.kind === 'rejected') {
        return { kind: 'rejected', failure: { code: lineage.code, message: lineage.message } };
      }
    }
  }
  return { kind: 'ok' };
}

/**
 * 把新 Plan 里的采用/延续声明落盘。
 *
 * 这是声明与既有采用/lineage 用例之间的唯一接线：计划只给出引用与种类，宿主为每个节点回读证据、
 * 事实与旧责任消耗，再走 `evaluateAdoptionRequest` → `recordBaselineAdoption` 与
 * `recordWorkPackageLineage`。任一节点判定为拒绝即整体拒绝；矛盾事实导致的阻塞如实返回，不继续记录。
 */
export function recordPlanContinuations(input: {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly writer: CoordinationWriter;
  readonly graph: ExecutionGraph;
  readonly plan: ImplementationPlan;
  readonly factsFor: (workPackageId: WorkPackageId) => PlanContinuationFacts | null;
}): RecordPlanContinuationsResult {
  // 先整体预检，再落盘：任一节点不可采用时不留下部分记录。
  const preflight = preflightPlanContinuations({
    graph: input.graph,
    plan: input.plan,
    factsFor: input.factsFor,
  });
  if (preflight.kind === 'blocked') {
    return { kind: 'blocked', reason: preflight.reason };
  }
  if (preflight.kind === 'rejected') {
    return { kind: 'rejected', failure: preflight.failure };
  }
  let adoptions = 0;
  let lineages = 0;
  for (const planned of input.plan.workPackages) {
    if (planned.adoption === undefined && planned.lineage === undefined) {
      continue;
    }
    const workPackageId = workPackageIdFor(input.graph.graphId, planned.key);
    const facts = input.factsFor(workPackageId);
    if (facts === null) {
      return {
        kind: 'rejected',
        failure: { code: 'invalid_state', message: `Work Package ${planned.key} 的采用/延续事实不可读` },
      };
    }
    if (planned.adoption !== undefined) {
      const request = adoptionRequestOf(workPackageId, planned.adoption, facts);
      const decision = evaluateAdoptionRequest(request);
      if (decision.kind === 'rejected') {
        return { kind: 'rejected', failure: decision.failure };
      }
      if (decision.kind === 'blocked') {
        return { kind: 'blocked', reason: decision.reason };
      }
      const recorded = recordBaselineAdoption({
        store: input.store,
        coordinationScopeId: input.coordinationScopeId,
        writer: input.writer,
        adoptionId: `${workPackageId}:${planned.adoption.kind}:${planned.adoption.adoptedResultRef}`,
        decision,
        request,
      });
      if (recorded.kind === 'rejected') {
        return { kind: 'rejected', failure: recorded.failure };
      }
      adoptions += 1;
    }
    if (planned.lineage !== undefined) {
      const recorded = recordWorkPackageLineage({
        store: input.store,
        coordinationScopeId: input.coordinationScopeId,
        writer: input.writer,
        workPackageId,
        priorWorkPackageId: planned.lineage.priorWorkPackageId as WorkPackageId,
        priorGraphId: planned.lineage.priorGraphId as GraphId,
        priorConsumed: facts.priorConsumed,
      });
      if (recorded.kind === 'rejected') {
        return { kind: 'rejected', failure: recorded.failure };
      }
      lineages += 1;
    }
  }
  return { kind: 'recorded', adoptions, lineages };
}
