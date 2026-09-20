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
  readonly mapRevision: Revision;
  readonly planRevision: Revision;
  readonly orcaRunId: string;
  readonly graph: ExecutionGraph;
  readonly recordedAt: number;
};

export function workPackageOf(graph: ExecutionGraph, workPackageId: WorkPackageId): WorkPackage | null {
  return graph.workPackages.find((workPackage) => workPackage.workPackageId === workPackageId) ?? null;
}

export function isGraphVersionRecordKind(raw: unknown): raw is GraphVersionRecordKind {
  return typeof raw === 'string' && (GRAPH_VERSION_RECORD_KINDS as readonly string[]).includes(raw);
}
