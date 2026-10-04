/**
 * IC-05：Implementation Plan 与 Execution Graph 的领域类型（Owner: `m1-plan-and-authorize-execution`）。
 *
 * Execution Graph 是 Companion 拥有的版本化逻辑 Work Package DAG，不是 LangGraph，也不是 Orca
 * Task DAG。本模块只有类型与不变量：编译逻辑在 `graph-compiler.ts`，预算上限在 `budget-policy.ts`，
 * 追加历史是 `ExecutionGraphHistory` 的唯一写 seam。
 *
 * 图里的每个预算字段都来自配置与授权输入，节点不能自行放宽；这里不读时钟、不触碰存储。
 */

import type {
  GraphGeneration,
  GraphId,
  GraphVersion,
  Revision,
  VersionedRef,
  WorkPackageId,
} from '../../application/dto/identity.js';

/** Scope Envelope 是工作包允许改动的路径集合；空 include 表示没有可改路径，属于非法配置。 */
export type ScopeEnvelope = {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
};

/** 单个 Work Package 的有限预算；所有字段都是非负整数，没有「无限」表示。 */
export type WorkPackageBudget = {
  readonly implementationAttempts: number;
  readonly validatorRepairs: number;
  readonly graphRevisions: number;
  readonly specificationRevisions: number;
  readonly maxRecoveriesPerWorkerAttempt: number;
};

export type WorkPackage = {
  readonly workPackageId: WorkPackageId;
  readonly title: string;
  readonly dependsOn: readonly WorkPackageId[];
  readonly scopeEnvelope: ScopeEnvelope;
  readonly budget: WorkPackageBudget;
};

export type ExecutionGraph = {
  readonly graphId: GraphId;
  readonly generation: GraphGeneration;
  readonly concurrencyLimit: number;
  readonly workPackages: readonly WorkPackage[];
};

/** 规划阶段的结构化输出；键在计划内唯一，依赖用键表达，编译器把它翻成 WorkPackageId。 */
export type PlannedWorkPackage = {
  readonly key: string;
  readonly title: string;
  readonly dependsOn: readonly string[];
  readonly scopeEnvelope: ScopeEnvelope;
  /** 计划声明的预算需求；缺省表示只取配置上限，不额外声明。 */
  readonly requestedBudget?: Partial<WorkPackageBudget>;
};

export type ImplementationPlan = {
  readonly planRevision: Revision;
  readonly destinationRef: VersionedRef<'destination'>;
  readonly workPackages: readonly PlannedWorkPackage[];
};

/**
 * GraphVersion 记录的种类。
 *
 * 本 change 只产生 `initial`；`accepted_revision` 由直接后继 `m1-evolve-execution-graph` 追加，
 * 因此这里只声明闭集，不实现追加路径。
 */
export const GRAPH_VERSION_RECORD_KINDS = ['initial', 'accepted_revision'] as const;

export type GraphVersionRecordKind = (typeof GRAPH_VERSION_RECORD_KINDS)[number];

/** 一条追加的 GraphVersion：图拓扑、世代与编译依据都在这里，历史不改写。 */
export type GraphVersionRecord = {
  readonly graphId: GraphId;
  readonly generation: GraphGeneration;
  readonly version: GraphVersion;
  readonly recordKind: GraphVersionRecordKind;
  readonly parentVersion: GraphVersion | null;
  /** `initial` 恒为 `null`；`accepted_revision` 是提交这次修订的补丁标识（幂等键）。 */
  readonly patchId: string | null;
  readonly mapRevision: Revision;
  readonly planRevision: Revision;
  readonly orcaRunId: string;
  readonly graph: ExecutionGraph;
  readonly recordedAt: number;
};

export function workPackageOf(graph: ExecutionGraph, workPackageId: WorkPackageId): WorkPackage | null {
  return graph.workPackages.find((workPackage) => workPackage.workPackageId === workPackageId) ?? null;
}

/**
 * 当前图版本的追加链：从当前版本沿 `parentVersion` 回溯到初始版本。
 *
 * 授权与候选图都用它回答同一个问题——「某个 GraphVersion 是否仍是当前图的一部分」。图会随 accepted
 * revision 前移（提交路径把新版本挂成当前 head 的子节点），因此**绑定时刻的版本只要还在链上就仍然有效**；
 * 指向未来版本、其它图的版本或已被换掉的版本不在链上，一律不成立。
 */
export function graphVersionChain(
  versions: readonly GraphVersionRecord[],
  current: GraphVersionRecord,
): ReadonlySet<GraphVersion> {
  const byVersion = new Map(versions.map((version) => [version.version, version] as const));
  const chain = new Set<GraphVersion>();
  let cursor: GraphVersion | null = current.version;
  while (cursor !== null && !chain.has(cursor)) {
    chain.add(cursor);
    cursor = byVersion.get(cursor)?.parentVersion ?? null;
  }
  return chain;
}

/**
 * 判定某个 GraphVersion 是否仍属于当前图的追加链，与 `graphVersionChain` 同一规则、同一份实现。
 *
 * `approved` 是调用方已经取得的**链成员事实**（宿主用存储的轻量 membership 查询按需得到，不必为了
 * 一次判定把整条历史拓扑读进内存）。缺它时退回用记录列表现场算链——那是纯用例的路径；生产装配
 * 必须注入 `approved`，否则说明授权链合法性没有被存储证明。
 */
export function isGraphVersionInChain(input: {
  readonly versions: readonly GraphVersionRecord[];
  readonly current: GraphVersionRecord;
  readonly candidate: GraphVersion;
  readonly approved?: ReadonlySet<GraphVersion> | undefined;
}): boolean {
  return (input.approved ?? graphVersionChain(input.versions, input.current)).has(input.candidate);
}

export function isGraphVersionRecordKind(raw: unknown): raw is GraphVersionRecordKind {
  return typeof raw === 'string' && (GRAPH_VERSION_RECORD_KINDS as readonly string[]).includes(raw);
}
