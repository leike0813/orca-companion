/**
 * IC-10 / IP-2：Graph Patch 的确定性编译与校验（Owner: `m1-evolve-execution-graph`，D4）。
 *
 * 编译只做**结构**判定：基线版本、后代逐一处置、引用完整性、无环、Scope Envelope、预算、授权与
 * 版本一致性。它不评判规划语义——「这个 Patch Work Package 该不该存在」属于 Coordinator 与用户。
 * 任一检查失败即返回显式错误列表且没有候选图：没有部分结果，也不存在「先写一半再补」的路径。
 *
 * 判定所需的「已接受」与「已派发」都是外部事实，由调用方从生命周期与 Orca 投影给出，编译器不猜。
 */

import {
  type GraphVersion,
  type OperationId,
  type WorkPackageId,
} from '../../application/dto/identity.js';
import type { ExecutionLimits } from '../planning/budget-policy.js';
import { assertWithinCaps, budgetFromLimits } from '../planning/budget-policy.js';
import type { BudgetConsumption } from '../dispatch-candidate.js';
import type { ExecutionGraph, GraphVersionRecord, WorkPackage } from '../planning/execution-graph.js';
import { findDependencyCycle, validateScopeEnvelope } from '../planning/graph-compiler.js';
import {
  authorizeOperation,
  type ExecutionAuthorizationRecord,
} from '../planning/execution-authorization.js';
import {
  parseGraphPatch,
  patchWorkPackageIdFor,
  unacceptedDescendants,
  type DescendantDispositionKind,
  type PatchDependencyRef,
  type PatchDescendantDisposition,
  type PatchResponsibilityTakeover,
} from './graph-patch.js';

export const GRAPH_PATCH_ERROR_CODES = [
  'invalid_schema',
  'base_version_mismatch',
  'duplicate_key',
  'duplicate_revision',
  'duplicate_disposition',
  'unknown_reference',
  'self_dependency',
  'undisposed_descendant',
  'unexpected_disposition',
  'accepted_node_mutation',
  'unknown_takeover_target',
  'invalid_scope_envelope',
  'cycle',
  'budget_exceeded',
  'revision_budget_exhausted',
  'not_authorized',
] as const;

export type GraphPatchErrorCode = (typeof GRAPH_PATCH_ERROR_CODES)[number];

export type GraphPatchCompilationError = {
  readonly code: GraphPatchErrorCode;
  readonly message: string;
  readonly workPackageId: string | null;
};

export type CompiledGraphPatch = {
  readonly patchId: string;
  readonly operationId: OperationId;
  readonly baseGraphVersion: GraphVersion;
  /** 补丁生效后的完整拓扑；它就是要被追加的那条 GraphVersion 的图体。 */
  readonly graph: ExecutionGraph;
  readonly descendants: readonly PatchDescendantDisposition[];
  readonly takesOver: readonly PatchResponsibilityTakeover[];
  readonly addedWorkPackageIds: readonly WorkPackageId[];
  readonly revisedWorkPackageIds: readonly WorkPackageId[];
  readonly retiredWorkPackageIds: readonly WorkPackageId[];
  /** 处置为 `specification_revision` 的后代：保持拓扑，但契约内容必须重新走修订。 */
  readonly specificationRevisionRequiredWorkPackageIds: readonly WorkPackageId[];
  /** 已派发 Worker 的修订节点：应用后必须进入 revision pending。 */
  readonly revisionPendingWorkPackageIds: readonly WorkPackageId[];
};

export type GraphPatchCompilationInput = {
  readonly patch: unknown;
  readonly current: GraphVersionRecord;
  readonly limits: ExecutionLimits;
  readonly authorization: ExecutionAuthorizationRecord | null;
  readonly acceptedWorkPackageIds: readonly WorkPackageId[];
  /** 当前已派发 Worker Task 的 Work Package；由调用方从 Orca 投影给出。 */
  readonly dispatchedWorkPackageIds: readonly WorkPackageId[];
  /** 各 Work Package 已消耗的修订额度；缺计数按 0 处理，不会被读成「不受限制」。 */
  readonly consumedRevisions?: readonly BudgetConsumption[];
  /**
   * Controller 签发的 OperationId。
   *
   * 给出时覆盖补丁载荷里的同名字段：模型与 Worker 填写的 operation identity 在边界被丢弃，唯一进入
   * 提交的 operationId 只能来自可信调用方。
   */
  readonly trustedOperationId?: OperationId;
  /**
   * Controller 签发的补丁标识。
   *
   * 与 `trustedOperationId` 同理：补丁标识是提交的幂等键，由模型填写会让它有机会复用或制造冲突，
   * 因此给出时覆盖载荷里的 `patchId`。
   */
  readonly trustedPatchId?: string;
};

export type GraphPatchCompilationResult =
  | { readonly ok: true; readonly value: CompiledGraphPatch }
  | { readonly ok: false; readonly errors: readonly GraphPatchCompilationError[] };

function error(
  code: GraphPatchErrorCode,
  message: string,
  workPackageId: string | null = null,
): GraphPatchCompilationError {
  return { code, message, workPackageId };
}

function resolveRef(
  ref: PatchDependencyRef,
  context: {
    readonly currentById: ReadonlyMap<WorkPackageId, WorkPackage>;
    readonly removed: ReadonlySet<WorkPackageId>;
    readonly addKeys: ReadonlySet<string>;
    readonly addIdByKey: ReadonlyMap<string, WorkPackageId>;
  },
): { readonly ok: true; readonly workPackageId: WorkPackageId } | { readonly ok: false; readonly message: string } {
  if (ref.kind === 'existing') {
    if (context.removed.has(ref.workPackageId)) {
      return { ok: false, message: `依赖引用了已被移出活动图的 Work Package ${ref.workPackageId}` };
    }
    if (!context.currentById.has(ref.workPackageId)) {
      return { ok: false, message: `依赖引用了当前图中不存在的 Work Package ${ref.workPackageId}` };
    }
    return { ok: true, workPackageId: ref.workPackageId };
  }
  if (!context.addKeys.has(ref.key)) {
    return { ok: false, message: `依赖引用了同一补丁中不存在的新增节点 ${ref.key}` };
  }
  const workPackageId = context.addIdByKey.get(ref.key);
  return workPackageId === undefined
    ? { ok: false, message: `依赖引用了同一补丁中不存在的新增节点 ${ref.key}` }
    : { ok: true, workPackageId };
}

/**
 * 编译一个 Graph Patch。
 *
 * 输出顺序稳定：新增节点按 key、依赖按 WorkPackageId 排序，因此同一补丁与同一基线必然得到相同的
 * 结果拓扑，重放不会产生第二份图。
 */
export function compileGraphPatch(input: GraphPatchCompilationInput): GraphPatchCompilationResult {
  const parsed = parseGraphPatch(input.patch);
  if (!parsed.ok) {
    return { ok: false, errors: [error('invalid_schema', `${parsed.field}: ${parsed.message}`)] };
  }
  const patch = parsed.value;
  const errors: GraphPatchCompilationError[] = [];

  if (patch.baseGraphVersion !== input.current.version) {
    errors.push(
      error(
        'base_version_mismatch',
        `补丁声明 baseGraphVersion ${patch.baseGraphVersion}，当前图版本为 ${input.current.version}`,
      ),
    );
    return { ok: false, errors };
  }

  const currentById = new Map(input.current.graph.workPackages.map((wp) => [wp.workPackageId, wp]));
  const accepted = new Set(input.acceptedWorkPackageIds);
  const addKeys = new Set<string>();
  const addIdByKey = new Map<string, WorkPackageId>();

  for (const addition of patch.add) {
    if (addKeys.has(addition.key)) {
      errors.push(error('duplicate_key', `补丁内新增节点 key ${addition.key} 重复`, addition.key));
      continue;
    }
    addKeys.add(addition.key);
    addIdByKey.set(
      addition.key,
      patchWorkPackageIdFor(input.current.graphId, input.trustedPatchId ?? patch.patchId, addition.key),
    );
  }

  const revised = new Map<WorkPackageId, (typeof patch.revise)[number]>();
  for (const revision of patch.revise) {
    if (revised.has(revision.workPackageId)) {
      errors.push(
        error('duplicate_revision', `Work Package ${revision.workPackageId} 在补丁中被重复重定义`, revision.workPackageId),
      );
      continue;
    }
    revised.set(revision.workPackageId, revision);
    const existing = currentById.get(revision.workPackageId);
    if (existing === undefined) {
      errors.push(
        error('unknown_reference', `补丁重定义了当前图中不存在的 Work Package ${revision.workPackageId}`, revision.workPackageId),
      );
      continue;
    }
    if (accepted.has(revision.workPackageId)) {
      errors.push(
        error('accepted_node_mutation', `Work Package ${revision.workPackageId} 已被接受，不能被补丁重定义`, revision.workPackageId),
      );
    }
  }

  const retire = new Set<WorkPackageId>();
  for (const workPackageId of patch.retire) {
    if (retire.has(workPackageId)) {
      errors.push(error('duplicate_disposition', `Work Package ${workPackageId} 在 retire 中重复出现`, workPackageId));
      continue;
    }
    retire.add(workPackageId);
    if (!currentById.has(workPackageId)) {
      errors.push(error('unknown_reference', `补丁退休了当前图中不存在的 Work Package ${workPackageId}`, workPackageId));
      continue;
    }
    if (accepted.has(workPackageId)) {
      errors.push(
        error('accepted_node_mutation', `Work Package ${workPackageId} 已被接受，不能被退休`, workPackageId),
      );
    }
    if (revised.has(workPackageId)) {
      errors.push(
        error('unexpected_disposition', `Work Package ${workPackageId} 同时出现在 revise 与 retire`, workPackageId),
      );
    }
  }

  for (const workPackageId of revised.keys()) {
    const existing = currentById.get(workPackageId);
    if (existing === undefined) {
      continue;
    }
    const consumed =
      (input.consumedRevisions ?? []).find(
        (entry) => entry.workPackageId === workPackageId && entry.field === 'graphRevisions',
      )?.consumed ?? 0;
    if (consumed >= existing.budget.graphRevisions) {
      errors.push(
        error(
          'revision_budget_exhausted',
          `Work Package ${workPackageId} 的 graphRevisions 额度已耗尽（${consumed}/${existing.budget.graphRevisions}）`,
          workPackageId,
        ),
      );
    }
  }

  const affected = [...new Set<WorkPackageId>([...revised.keys(), ...retire])];
  /**
   * 必须逐一处置的未接受后代：受影响节点的传递依赖者，去掉直接退休的节点。
   *
   * 直接退休由 `retire` 数组表达，因此它不再需要一个后代处置条目；而**被重定义的后代依然要列出**
   * （处置为 `graph_revision`），否则「补丁既改了上游又改了这个后代」这件事就只存在于 revise 数组里，
   * 读补丁的人无法从处置表看出后代的完整处境。
   */
  const requiredDescendants = new Set(
    unacceptedDescendants({ graph: input.current.graph, affected, accepted: input.acceptedWorkPackageIds }).filter(
      (workPackageId) => !retire.has(workPackageId),
    ),
  );

  const dispositionOf = new Map<WorkPackageId, DescendantDispositionKind>();
  for (const disposition of patch.descendants) {
    if (dispositionOf.has(disposition.workPackageId)) {
      errors.push(
        error('duplicate_disposition', `Work Package ${disposition.workPackageId} 的后代处置重复`, disposition.workPackageId),
      );
      continue;
    }
    dispositionOf.set(disposition.workPackageId, disposition.disposition);
    if (!requiredDescendants.has(disposition.workPackageId)) {
      errors.push(
        error(
          'unexpected_disposition',
          `Work Package ${disposition.workPackageId} 不是本次补丁的未接受后代，不需要处置`,
          disposition.workPackageId,
        ),
      );
    }
  }
  for (const descendant of requiredDescendants) {
    if (!dispositionOf.has(descendant)) {
      errors.push(
        error('undisposed_descendant', `未接受后代 ${descendant} 没有任何处置`, descendant),
      );
    }
  }

  // 处置与补丁内容必须一致：`graph_revision` 必须真的在 revise 里，其余处置不得偷偷重定义拓扑。
  for (const [workPackageId, disposition] of dispositionOf) {
    if (disposition === 'graph_revision' && !revised.has(workPackageId)) {
      errors.push(
        error('unexpected_disposition', `后代 ${workPackageId} 处置为 graph_revision，却不在 revise 中`, workPackageId),
      );
    }
    if (disposition !== 'graph_revision' && revised.has(workPackageId)) {
      errors.push(
        error('unexpected_disposition', `后代 ${workPackageId} 被重定义，却未处置为 graph_revision`, workPackageId),
      );
    }
  }
  for (const addition of patch.add) {
    const envelopeError = validateScopeEnvelope(addition.scopeEnvelope);
    if (envelopeError !== null) {
      errors.push(error('invalid_scope_envelope', `新增节点 ${addition.key}：${envelopeError}`, addition.key));
    }
  }
  for (const revision of patch.revise) {
    const envelopeError = validateScopeEnvelope(revision.scopeEnvelope);
    if (envelopeError !== null) {
      errors.push(
        error('invalid_scope_envelope', `重定义 ${revision.workPackageId}：${envelopeError}`, revision.workPackageId),
      );
    }
  }

  const retireByDisposition = new Set(
    [...dispositionOf.entries()].filter(([, kind]) => kind === 'retire').map(([workPackageId]) => workPackageId),
  );
  const removed = new Set<WorkPackageId>([...retire, ...retireByDisposition]);
  const resolveContext = {
    currentById,
    removed,
    addKeys,
    addIdByKey,
  };

  const resolveList = (
    refs: readonly PatchDependencyRef[],
    owner: string,
  ): readonly WorkPackageId[] => {
    const resolved: WorkPackageId[] = [];
    for (const ref of refs) {
      const result = resolveRef(ref, resolveContext);
      if (!result.ok) {
        errors.push(error('unknown_reference', `${owner}：${result.message}`, owner));
        continue;
      }
      if (result.workPackageId === owner) {
        errors.push(error('self_dependency', `${owner} 依赖自身`, owner));
        continue;
      }
      resolved.push(result.workPackageId);
    }
    return resolved;
  };

  const addedWorkPackages: WorkPackage[] = [...patch.add]
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
    .map((addition) => ({
      workPackageId: addIdByKey.get(addition.key) as WorkPackageId,
      title: addition.title,
      dependsOn: [...new Set(resolveList(addition.dependsOn, addition.key))].sort(),
      scopeEnvelope: {
        include: [...addition.scopeEnvelope.include],
        exclude: [...addition.scopeEnvelope.exclude],
      },
      budget: budgetFromLimits(input.limits),
    }));

  const keptWorkPackages: WorkPackage[] = input.current.graph.workPackages
    .filter((workPackage) => !removed.has(workPackage.workPackageId))
    .map((workPackage) => {
      const revision = revised.get(workPackage.workPackageId);
      if (revision === undefined) {
        return workPackage;
      }
      return {
        workPackageId: workPackage.workPackageId,
        title: revision.title,
        dependsOn: [...new Set(resolveList(revision.dependsOn, workPackage.workPackageId))].sort(),
        scopeEnvelope: {
          include: [...revision.scopeEnvelope.include],
          exclude: [...revision.scopeEnvelope.exclude],
        },
        budget: workPackage.budget,
      };
    });

  const resultGraph: ExecutionGraph = {
    graphId: input.current.graphId,
    generation: input.current.generation,
    concurrencyLimit: input.current.graph.concurrencyLimit,
    workPackages: [...keptWorkPackages, ...addedWorkPackages],
  };

  const resultIds = new Set(resultGraph.workPackages.map((workPackage) => workPackage.workPackageId));
  for (const workPackage of resultGraph.workPackages) {
    for (const dependency of workPackage.dependsOn) {
      if (!resultIds.has(dependency)) {
        errors.push(
          error(
            'unknown_reference',
            `Work Package ${workPackage.workPackageId} 的依赖 ${dependency} 不在补丁生效后的图中`,
            workPackage.workPackageId,
          ),
        );
      }
    }
  }

  if (errors.length === 0) {
    const edges = new Map<string, readonly string[]>(
      resultGraph.workPackages.map((workPackage) => [workPackage.workPackageId, workPackage.dependsOn]),
    );
    const cycle = findDependencyCycle(edges);
    if (cycle !== null) {
      errors.push(error('cycle', `补丁生效后依赖存在环：${cycle.join(' -> ')}`, cycle[0] ?? null));
    }
  }

  for (const violation of assertWithinCaps({
    limits: input.limits,
    workPackages: patch.add.map((addition) => ({
      key: addition.key,
      ...(addition.requestedBudget === undefined ? {} : { requestedBudget: addition.requestedBudget }),
    })),
    activeWorkPackageCount: resultGraph.workPackages.length,
  })) {
    errors.push(error('budget_exceeded', violation.message, violation.workPackageKey));
  }

  const authorization = authorizeOperation({
    authorization: input.authorization,
    category: 'worker-dispatch',
    role: 'planner',
  });
  if (authorization.kind !== 'authorized') {
    errors.push(
      error(
        'not_authorized',
        authorization.kind === 'not_authorized'
          ? authorization.reason
          : `图补丁没有落在当前授权范围内：${authorization.category}`,
      ),
    );
  } else {
    const manifest = authorization.authorization.manifest;
    if (
      manifest.graph.graphId !== input.current.graphId ||
      manifest.graph.generation !== input.current.generation
    ) {
      errors.push(
        error(
          'not_authorized',
          `Execution Authorization 绑定的是 Graph ${manifest.graph.graphId} 世代 ${manifest.graph.generation}，与当前图 ${input.current.graphId} 世代 ${input.current.generation} 不一致`,
        ),
      );
    }
  }

  const takesOver: PatchResponsibilityTakeover[] = [];
  for (const takeover of patch.takesOver) {
    if (!requiredDescendants.has(takeover.workPackageId) && !affected.includes(takeover.workPackageId)) {
      errors.push(
        error(
          'unknown_takeover_target',
          `接管关系指向的 ${takeover.workPackageId} 不在本次补丁的受影响节点或未接受后代中`,
          takeover.workPackageId,
        ),
      );
    }
    if (!addKeys.has(takeover.takesOverByKey)) {
      errors.push(
        error(
          'unknown_takeover_target',
          `接管关系声明的接管方 ${takeover.takesOverByKey} 不是同一补丁新增的节点`,
          takeover.workPackageId,
        ),
      );
    }
    takesOver.push(takeover);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const dispatched = new Set(input.dispatchedWorkPackageIds);
  return {
    ok: true,
    value: {
      patchId: input.trustedPatchId ?? patch.patchId,
      operationId: input.trustedOperationId ?? patch.operationId,
      baseGraphVersion: patch.baseGraphVersion,
      graph: resultGraph,
      descendants: patch.descendants,
      takesOver,
      addedWorkPackageIds: addedWorkPackages.map((workPackage) => workPackage.workPackageId),
      revisedWorkPackageIds: [...revised.keys()].sort(),
      retiredWorkPackageIds: [...removed].sort(),
      specificationRevisionRequiredWorkPackageIds: patch.descendants
        .filter((disposition) => disposition.disposition === 'specification_revision')
        .map((disposition) => disposition.workPackageId)
        .sort(),
      revisionPendingWorkPackageIds: [
        ...new Set<WorkPackageId>([
          ...[...revised.keys()].filter((id) => dispatched.has(id)),
          // 退休同样改变这个节点的处境：已派发 Worker 必须先运行至可核验终态，其后不再派发后续工作。
          ...[...retire].filter((id) => dispatched.has(id)),
        ]),
      ].sort(),
    },
  };
}
