/**
 * MOD-06 / IP-01、IP-02：执行图的稳定布局
 * （Owner: `m2-deliver-execution-tui`，D2、D8）。
 *
 * 布局是纯函数：节点顺序只由**编译后的稳定拓扑**决定，状态变化不重排，过滤只隐藏节点。缩进只表达
 * 依赖深度，不参与排序，因此「implementing → validating」这类状态推进不会让用户失去空间记忆。
 *
 * 折叠态在这里不参与：调用方在折叠时根本不调用本模块，因此不可见详情不会被计算（D8）。
 */

import type { IntegrationQueueEntryView, WorkPackageNodeView } from '../../../application/tui/view-model.js';

export type GraphLayoutDensity = 'full' | 'compact' | 'collapsed';

export type GraphLayoutRow = {
  readonly workPackageId: string;
  /** 稳定拓扑位置（编译顺序的索引）。 */
  readonly position: number;
  /** 依赖深度：只用于缩进，`0` 表示没有同图内的依赖。 */
  readonly depth: number;
  readonly node: WorkPackageNodeView;
};

/**
 * 依赖深度。
 *
 * 只认图内依赖；出现环或前驱缺失时该节点停在已求得的深度（不隐藏、不重排），布局因此不会因为异常
 * 拓扑而丢失节点。
 */
export function dependencyDepths(nodes: readonly WorkPackageNodeView[]): ReadonlyMap<string, number> {
  const byId = new Map(nodes.map((node) => [node.workPackageId, node] as const));
  const depths = new Map<string, number>();
  const visit = (workPackageId: string, guard: ReadonlySet<string>): number => {
    const cached = depths.get(workPackageId);
    if (cached !== undefined) {
      return cached;
    }
    const node = byId.get(workPackageId);
    if (node === undefined || guard.has(workPackageId)) {
      return 0;
    }
    const nextGuard = new Set([...guard, workPackageId]);
    const parents = node.dependsOn.filter((dependency) => byId.has(dependency));
    if (parents.length === 0) {
      depths.set(workPackageId, 0);
      return 0;
    }
    const depth = 1 + Math.max(...parents.map((dependency) => visit(dependency, nextGuard)));
    depths.set(workPackageId, depth);
    return depth;
  };
  for (const node of nodes) {
    visit(node.workPackageId, new Set());
  }
  return depths;
}

/** 缩进前缀；每层两个显示列。 */
export function indentFor(depth: number): string {
  return '  '.repeat(Math.max(0, depth));
}

/**
 * 执行图行。
 *
 * 返回全部节点（保持编译顺序），可见性由 `node.hidden` 表达：调用方过滤隐藏行，但**不重新排序**，
 * 因此隐藏中间节点不会让后面节点的位置发生变化。
 */
export function layoutExecutionGraph(
  nodes: readonly WorkPackageNodeView[],
): readonly GraphLayoutRow[] {
  const depths = dependencyDepths(nodes);
  return nodes.map((node, position) => ({
    workPackageId: node.workPackageId,
    position,
    depth: depths.get(node.workPackageId) ?? 0,
    node,
  }));
}

/** 可见行：只按 `hidden` 过滤；顺序与位置保持编译顺序。 */
export function visibleRows(rows: readonly GraphLayoutRow[]): readonly GraphLayoutRow[] {
  return rows.filter((row) => !row.node.hidden);
}

export type IntegrationQueueRow = {
  readonly workPackageId: string;
  /** 队列位置：`0` 是下一个进入集成的那一项；串行意味着不会与其它项重叠。 */
  readonly position: number;
  readonly integrating: boolean;
};

/** 串行 integration queue 的展示行；顺序由调用方给出的队列顺序决定（拓扑顺序）。 */
export function integrationQueueRows(
  queue: readonly IntegrationQueueEntryView[],
): readonly IntegrationQueueRow[] {
  return queue.map((entry) => ({
    workPackageId: entry.workPackageId,
    position: entry.position,
    integrating: entry.integrating,
  }));
}

/** 紧凑态一行：短 key、关键状态与告警；不包含 attempt、证据与 worktree 详情。 */
export function compactGraphRow(row: GraphLayoutRow): string {
  const node = row.node;
  const alerts = node.blockerRefs.length > 0 || node.liveness === 'unverifiable' ? ' !' : '';
  const dependency = node.dependsOn.length === 0 ? '' : ` <- ${node.dependsOn.join(',')}`;
  return `${indentFor(row.depth)}- ${node.shortKey} ${node.state}${alerts}${dependency}`;
}
