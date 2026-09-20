/**
 * IC-05：Graph Generation 的分配与过期判定（Owner: `m1-plan-and-authorize-execution`）。
 *
 * 每个 Planning Cycle 产出新的 GraphId 与新的空 Orca Run，WorkPackageId 不跨世代复用：GraphId 由
 * Scope 与世代号确定性派生，世代号是「当前图 head 的世代 + 1」，因此同一个 Scope 不会因为重启或
 * 重放而回退到旧标识。
 *
 * 创建 Orca Run 是一次外部副作用：它先落 Operation Intent，再调用 Orca，最后按回执收尾。结果
 * 不可判定时意图保持未决，调用方必须沿用同一 OperationId 对账，不能换 ID 再建一个 Run。
 */

import type {
  CoordinationScopeId,
  GraphGeneration,
  GraphId,
  OperationId,
  PlanningCycleId,
  Revision,
} from '../dto/identity.js';
import type {
  BranchCoordinationStore,
  CoordinationCommandRejection,
  CoordinationWriter,
} from '../ports/branch-coordination-store.js';
import { readScope, type ScopeReadResult } from './scope-read.js';

export type EmptyRunAllocation =
  | { readonly kind: 'allocated'; readonly orcaRunId: string; readonly requestId?: string }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string }
  | { readonly kind: 'unknown'; readonly reason: string };

export type EmptyRunAllocator = (request: {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly planningCycleId: PlanningCycleId;
  readonly graphId: GraphId;
  readonly generation: GraphGeneration;
  readonly objective: string;
}) => Promise<EmptyRunAllocation>;

export type GraphGenerationRecord = {
  readonly coordinationScopeId: CoordinationScopeId;
  readonly planningCycleId: PlanningCycleId;
  readonly graphId: GraphId;
  readonly generation: GraphGeneration;
  readonly orcaRunId: string;
  /** 编译与授权所依据的地图 revision；地图变化即让这份候选图过期。 */
  readonly mapRevision: Revision;
};

export type StartGraphGenerationInput = {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly planningCycleId: PlanningCycleId;
  readonly writer: CoordinationWriter;
  readonly operationId: OperationId;
  readonly objective: string;
  readonly allocateRun: EmptyRunAllocator;
};

export type StartGraphGenerationResult =
  | { readonly kind: 'started'; readonly generation: GraphGenerationRecord }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string }
  | { readonly kind: 'unknown'; readonly reason: string };

/** GraphId 由 Scope 与世代确定性派生：相同输入得到相同标识，且不同世代不会碰撞。 */
export function graphIdFor(coordinationScopeId: CoordinationScopeId, generation: GraphGeneration): GraphId {
  return `${coordinationScopeId}#g${generation}` as GraphId;
}

function rejectionMessage(rejection: CoordinationCommandRejection): string {
  return rejection.message;
}

function scopeOf(store: BranchCoordinationStore, coordinationScopeId: CoordinationScopeId): ScopeReadResult {
  return readScope(store, coordinationScopeId);
}

/** 当前世代的来源是当前图的 head；还没有图时世代为 0，下一个就是 1。 */
function currentGeneration(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
  graphId: GraphId | null,
): { readonly kind: 'read'; readonly generation: number } | { readonly kind: 'rejected'; readonly code: string; readonly message: string } {
  if (graphId === null) {
    return { kind: 'read', generation: 0 };
  }
  const versions = store.query({ kind: 'graph-versions', coordinationScopeId, graphId });
  if (versions.kind === 'rejected') {
    return { kind: 'rejected', code: versions.code, message: versions.message };
  }
  if (versions.kind !== 'graph-versions') {
    return { kind: 'rejected', code: 'invalid_state', message: '无法读取 GraphVersion 历史' };
  }
  const head = versions.versions.at(-1);
  return { kind: 'read', generation: head === undefined ? 0 : head.generation };
}

/**
 * 开始一个新的 Graph Generation：分配世代标识，并通过 allocator 建立一个空 Orca Run。
 *
 * 候选图本身由调用方在拿到世代后再编译；世代与 Run 的绑定随后写进初始 GraphVersion 记录。
 */
export async function startGraphGeneration(
  input: StartGraphGenerationInput,
): Promise<StartGraphGenerationResult> {
  const scope = scopeOf(input.store, input.coordinationScopeId);
  if (scope.kind === 'rejected') {
    return { kind: 'rejected', code: scope.code, message: scope.message };
  }
  const previous = currentGeneration(input.store, input.coordinationScopeId, scope.scope.graphId);
  if (previous.kind === 'rejected') {
    return { kind: 'rejected', code: previous.code, message: previous.message };
  }
  const generation = (previous.generation + 1) as GraphGeneration;
  const graphId = graphIdFor(input.coordinationScopeId, generation);

  const begun = input.store.transact({
    kind: 'begin-intent',
    coordinationScopeId: input.coordinationScopeId,
    expectedRevision: scope.scope.revision,
    writer: input.writer,
    operationId: input.operationId,
    target: { kind: 'orca-run', id: graphId },
    operationCategory: 'run-create',
  });
  if (begun.kind === 'rejected') {
    return { kind: 'rejected', code: begun.code, message: rejectionMessage(begun) };
  }

  const allocation = await input.allocateRun({
    coordinationScopeId: input.coordinationScopeId,
    planningCycleId: input.planningCycleId,
    graphId,
    generation,
    objective: input.objective,
  });

  if (allocation.kind === 'unknown') {
    return { kind: 'unknown', reason: allocation.reason };
  }

  const settle = (
    outcomeClass: 'accepted' | 'rejected',
    backendRequestId?: string,
  ): string | null => {
    const current = scopeOf(input.store, input.coordinationScopeId);
    if (current.kind === 'rejected') {
      return `${current.message}；意图 ${input.operationId} 未收尾`;
    }
    const settled = input.store.transact({
      kind: 'settle-intent',
      coordinationScopeId: input.coordinationScopeId,
      expectedRevision: current.scope.revision,
      writer: input.writer,
      operationId: input.operationId,
      outcomeClass,
      ...(backendRequestId === undefined ? {} : { backendRequestId }),
    });
    return settled.kind === 'rejected' ? `${rejectionMessage(settled)}；意图 ${input.operationId} 未收尾` : null;
  };

  if (allocation.kind === 'rejected') {
    const unsettled = settle('rejected');
    return unsettled === null
      ? { kind: 'rejected', code: allocation.code, message: allocation.message }
      : { kind: 'unknown', reason: unsettled };
  }

  const unsettled = settle('accepted', allocation.requestId);
  if (unsettled !== null) {
    return { kind: 'unknown', reason: unsettled };
  }
  return {
    kind: 'started',
    generation: {
      coordinationScopeId: input.coordinationScopeId,
      planningCycleId: input.planningCycleId,
      graphId,
      generation,
      orcaRunId: allocation.orcaRunId,
      mapRevision: scope.scope.mapRevision,
    },
  };
}

/**
 * 候选图是否已过期。
 *
 * 地图 revision、计划 revision 或世代任一发生变化都让候选图与既有批准失效：它们的组合就是
 * 「这份图描述的是哪一版规划」。
 */
export function isCandidateStale(input: {
  readonly boundMapRevision: Revision;
  readonly currentMapRevision: Revision;
  readonly boundPlanRevision: Revision;
  readonly currentPlanRevision: Revision;
  readonly boundGeneration: GraphGeneration;
  readonly currentGeneration: GraphGeneration;
}): boolean {
  return (
    input.boundMapRevision !== input.currentMapRevision ||
    input.boundPlanRevision !== input.currentPlanRevision ||
    input.boundGeneration !== input.currentGeneration
  );
}
