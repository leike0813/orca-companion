/**
 * IC-05：Execution Graph 的追加历史（Owner: `m1-plan-and-authorize-execution`）。
 *
 * 图拓扑只有一个写 seam：每次编译或修订都以新的 GraphVersion 追加，历史版本不被改写，因此
 * 「当前图」永远是某一条确切记录，而不是一个可以被就地覆盖的引用。本模块不判断规划语义，也不
 * 决定该不该追加新版本——那是 Controller 与 Graph Compiler 的事。
 *
 * 初始版本由本 change 追加；`accepted_revision` 的追加路径属于直接后继
 * `m1-evolve-execution-graph`，这里只读取它的记录。
 *
 * 函数是同步的：IC-03 的 store 本身同步，包一层 Promise 只会给调用方增加无意义的等待点。
 */

import type { CoordinationScopeId, GraphId, GraphVersion } from '../dto/identity.js';
import type {
  BranchCoordinationStore,
  CoordinationCommandRejection,
  CoordinationWriter,
} from '../ports/branch-coordination-store.js';
import type { ExecutionGraph, GraphVersionRecord } from '../../domain/planning/execution-graph.js';
import { readScope } from './scope-read.js';

export type GraphHistoryFailure = {
  readonly code: string;
  readonly message: string;
};

export type RecordInitialGraphInput = {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly writer: CoordinationWriter;
  readonly graph: ExecutionGraph;
  readonly mapRevision: number;
  readonly planRevision: number;
  readonly orcaRunId: string;
};

export type RecordInitialGraphResult =
  | { readonly kind: 'recorded'; readonly version: GraphVersionRecord }
  | { readonly kind: 'rejected'; readonly failure: GraphHistoryFailure };

function rejectionMessage(rejection: CoordinationCommandRejection): string {
  return rejection.message;
}

function scopeRevision(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
): { readonly kind: 'read'; readonly revision: number } | { readonly kind: 'rejected'; readonly failure: GraphHistoryFailure } {
  const read = readScope(store, coordinationScopeId);
  return read.kind === 'rejected'
    ? { kind: 'rejected', failure: { code: read.code, message: read.message } }
    : { kind: 'read', revision: read.scope.revision };
}

function readVersionRecord(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
  graphId: GraphId,
  graphVersion: GraphVersion,
): { readonly kind: 'read'; readonly version: GraphVersionRecord | null } | { readonly kind: 'rejected'; readonly failure: GraphHistoryFailure } {
  const result = store.query({ kind: 'graph-version', coordinationScopeId, graphId, graphVersion });
  if (result.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: result.code, message: result.message } };
  }
  if (result.kind !== 'graph-version') {
    return { kind: 'rejected', failure: { code: 'invalid_state', message: '无法读取 GraphVersion' } };
  }
  return { kind: 'read', version: result.version };
}

/**
 * 追加一个 Graph Generation 的初始 GraphVersion，并读回该记录。
 *
 * 追加与「当前图」指针在同一事务里完成，因此返回成功时调用方可以确信当前图确实指向这条记录；
 * 初始版本固定为 1 且只能追加一次，重复编译不会覆盖既有历史。
 */
export function recordInitialGraph(input: RecordInitialGraphInput): RecordInitialGraphResult {
  const scope = scopeRevision(input.store, input.coordinationScopeId);
  if (scope.kind === 'rejected') {
    return { kind: 'rejected', failure: scope.failure };
  }
  const recorded = input.store.transact({
    kind: 'record-graph-version',
    coordinationScopeId: input.coordinationScopeId,
    expectedRevision: scope.revision,
    writer: input.writer,
    graphId: input.graph.graphId,
    generation: input.graph.generation,
    graphVersion: 1 as GraphVersion,
    recordKind: 'initial',
    parentVersion: null,
    mapRevision: input.mapRevision,
    planRevision: input.planRevision,
    orcaRunId: input.orcaRunId,
    graph: input.graph,
  });
  if (recorded.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: recorded.code, message: rejectionMessage(recorded) } };
  }
  const read = readVersionRecord(input.store, input.coordinationScopeId, input.graph.graphId, 1 as GraphVersion);
  if (read.kind === 'rejected') {
    return { kind: 'rejected', failure: read.failure };
  }
  if (read.version === null) {
    return {
      kind: 'rejected',
      failure: { code: 'invalid_state', message: 'GraphVersion 追加后无法读回' },
    };
  }
  return { kind: 'recorded', version: read.version };
}

export type LoadCurrentGraphInput = {
  readonly store: BranchCoordinationStore;
  readonly coordinationScopeId: CoordinationScopeId;
  readonly graphId: GraphId;
};

export type LoadCurrentGraphResult =
  | { readonly kind: 'loaded'; readonly version: GraphVersionRecord }
  | { readonly kind: 'absent' }
  | { readonly kind: 'rejected'; readonly failure: GraphHistoryFailure };

/** 读取某个 GraphId 的 head：追加历史的最后一条，就是当前接受的图拓扑。 */
export function loadCurrentGraph(input: LoadCurrentGraphInput): LoadCurrentGraphResult {
  const result = input.store.query({
    kind: 'graph-versions',
    coordinationScopeId: input.coordinationScopeId,
    graphId: input.graphId,
  });
  if (result.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: result.code, message: result.message } };
  }
  if (result.kind !== 'graph-versions') {
    return { kind: 'rejected', failure: { code: 'invalid_state', message: '无法读取 GraphVersion 历史' } };
  }
  const head = result.versions.at(-1);
  return head === undefined ? { kind: 'absent' } : { kind: 'loaded', version: head };
}

/**
 * 读取 Scope 当前指向的图 head。
 *
 * `graphId` 为 `null` 表示这个 Scope 还没有编译过任何图——这是候选图缺失的正常状态，不是错误。
 */
export function loadScopeGraph(
  store: BranchCoordinationStore,
  coordinationScopeId: CoordinationScopeId,
): LoadCurrentGraphResult {
  const scope = readScope(store, coordinationScopeId);
  if (scope.kind === 'rejected') {
    return { kind: 'rejected', failure: { code: scope.code, message: scope.message } };
  }
  if (scope.scope.graphId === null) {
    return { kind: 'absent' };
  }
  return loadCurrentGraph({ store, coordinationScopeId, graphId: scope.scope.graphId });
}
