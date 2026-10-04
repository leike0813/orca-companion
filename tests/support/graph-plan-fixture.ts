/**
 * IC-03 Extend / IC-11：把 `ExecutionGraph` 反推成一份归一化 Implementation Plan 的测试夹具
 * （schema 17）。
 *
 * v1 追加现在必填原计划，因此每个记录初始图的测试都要给出一份计划。与其让 20 个测试文件各自编一份
 * `PlannedWorkPackage`，不如在这里从图反推：`key` 由数组下标派生，`dependsOn` 按 `workPackageId`
 * 映回同一个 key，预算与范围逐字段照搬。
 *
 * 它只用于让「图 + 计划」成对存在，不校验两者语义一致——真实编译路径由 Graph Compiler 负责。
 */

import type {
  ExecutionGraph,
  ImplementationPlan,
  PlannedWorkPackage,
} from '../../src/domain/planning/execution-graph.js';

export function implementationPlanFor(
  graph: ExecutionGraph,
  planRevision: number,
  destinationId = 'destination-under-test',
): ImplementationPlan {
  const keyOf = new Map(graph.workPackages.map((workPackage, index) => [workPackage.workPackageId, `wp-${index + 1}`] as const));
  const workPackages: PlannedWorkPackage[] = graph.workPackages.map((workPackage, index) => ({
    key: `wp-${index + 1}`,
    title: workPackage.title,
    dependsOn: workPackage.dependsOn.map((dependency) => keyOf.get(dependency) ?? dependency),
    scopeEnvelope: workPackage.scopeEnvelope,
    requestedBudget: workPackage.budget,
  }));
  return {
    planRevision,
    destinationRef: { kind: 'destination', id: destinationId, version: 1 },
    workPackages,
  };
}
