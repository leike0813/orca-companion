/**
 * MOD-06 / IP-01、IP-02：执行图的稳定布局
 * （Owner: `m2-deliver-execution-tui`，D2、D8）。
 *
 * 布局是纯函数：节点顺序只由**编译后的稳定拓扑**决定，状态变化不重排，过滤只隐藏节点。缩进只表达
 * 依赖深度，不参与排序，因此「implementing → validating」这类状态推进不会让用户失去空间记忆。
 *
 * 折叠态在这里不参与：调用方在折叠时根本不调用本模块，因此不可见详情不会被计算（D8）。
 */

import { tuiColors, tuiIcons } from '../theme.js';
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

export type GraphCell = { mask: number; color: string; glyph: string | null; spinning: boolean };
export function adaptiveGraphCanvas(nodes: readonly WorkPackageNodeView[], width: number, height: number, selectedId: string | null, planning: boolean, icons: import('../theme.js').TuiIconMode) {
  const rows = layoutExecutionGraph(nodes);
  const positions = new Map<string, { x: number; y: number }>();
  const layers = new Map<number, GraphLayoutRow[]>();
  for (const row of rows) { const layer = layers.get(row.depth) ?? []; layer.push(row); layers.set(row.depth, layer); }
  const fullWidth=Math.max(width,...[...layers.values()].map(layer=>layer.length*5+4));
  for (const [depth, layer] of layers) layer.forEach((row,i) => positions.set(row.workPackageId, { x: Math.round((i+1)*(fullWidth-4)/(layer.length+1))+1, y: depth*3 }));
  const selected = positions.get(selectedId ?? '');
  const startX=Math.max(0,Math.min(fullWidth-width,(selected?.x??0)-Math.floor(width/2)));
  const fullHeight = Math.max(1, ...rows.map(row => row.depth*3+1));
  const start = Math.max(0, Math.min(fullHeight-height, (selected?.y ?? 0)-Math.floor(height/2)));
  const cells = Array.from({ length: Math.min(height, fullHeight) }, () => Array.from({ length: width }, (): GraphCell => ({ mask: 0, color: tuiColors.border, glyph: null, spinning: false })));
  const mark = (x: number, y: number, bit: number, color: string) => {
    const cell = cells[y-start]?.[x-startX]; if (cell) { cell.mask |= bit; cell.color = color; }
  };
  const segment = (a: {x:number;y:number}, b: {x:number;y:number}, color: string) => {
    if (a.y === b.y) { for (let x=Math.min(a.x,b.x);x<Math.max(a.x,b.x);x++) { mark(x,a.y,2,color);mark(x+1,a.y,8,color); } }
    else { for (let y=Math.max(start-1,Math.min(a.y,b.y));y<Math.min(start+height,Math.max(a.y,b.y));y++) { mark(a.x,y,4,color);mark(a.x,y+1,1,color); } }
  };
  for (const row of rows) {
    if (row.node.hidden) continue;
    const target=positions.get(row.workPackageId); if(!target) continue;
    for(const id of row.node.dependsOn) {
      const source=positions.get(id); if(!source) continue;
      const points=target.y-source.y>3?[source,{x:source.x,y:source.y+1},{x:fullWidth-2,y:source.y+1},{x:fullWidth-2,y:target.y-1},{x:target.x,y:target.y-1},target]:[source,{x:source.x,y:source.y+1},{x:target.x,y:source.y+1},target];
      const color=row.node.state==='blocked' ? tuiColors.error : row.workPackageId===selectedId ? tuiColors.focus : tuiColors.border;
      for(let i=1;i<points.length;i++) segment(points[i-1]!,points[i]!,color);
    }
  }
  for(const row of rows) {
    if(row.node.hidden) continue;
    const p=positions.get(row.workPackageId); if(!p) continue;
    const symbol = planning ? tuiIcons[icons].candidate : row.node.state==='accepted' ? tuiIcons[icons].accepted : row.node.state==='blocked' ? tuiIcons[icons].blocked : row.node.state==='unknown' ? tuiIcons[icons].unknown : row.node.active ? tuiIcons[icons].running : tuiIcons[icons].waiting;
    const color=planning ? tuiColors.accent : row.node.state==='accepted' ? tuiColors.success : row.node.state==='blocked' ? tuiColors.error : row.node.state==='unknown' ? tuiColors.warning : tuiColors.accent;
    const label=(row.workPackageId===selectedId ? icons==='ascii'?'>':'›' : ' ') + symbol+' '+(row.position+1);
    [...label].forEach((glyph,i) => { const cell=cells[p.y-start]?.[p.x-1+i-startX]; if(cell) {cell.glyph=glyph;cell.color=color;cell.spinning=i===1&&!planning&&row.node.active&&row.node.liveness==='live';} });
  }
  return { cells, start, fullHeight, startX, fullWidth };
}
