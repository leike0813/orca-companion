/**
 * 图历史与执行依据的只读下钻视图（IP-04）。
 *
 * 这一层只做三件事：把宿主读好的目录、正文范围与历史拓扑画出来，并把用户动作交给容器。
 *
 * 硬约束：
 * - 沿三栏目与既有键位（↑↓ 选择 / Enter 下钻 / PgUp·PgDn 翻页 / Esc 逐层返回），不新增栏目与全局键；
 * - 目录每页最多 BASIS_PAGE_ITEMS 项、正文每次最多 BASIS_BODY_BYTES 字节，正文与布局各自限
 *   BASIS_CACHE_BYTES / BASIS_CACHE_ITEMS，render 不排整篇文档；
 * - 历史图只画该版本自己的 GraphView，不叠加当前 frontier、Worker、预算或验收摘要；
 * - 代际标签取记录里的真实 generationStatus，同一代际的旧版本不叫「冻结」。
 */

import { Box, Text } from 'ink';

import type {
  BasisBodyRange,
  BasisReadResult,
  BasisSource,
  BasisSourceRef,
  GraphBasisPort,
  GraphVersionRef,
  GraphVersionSummary,
} from '../../../application/tui/graph-basis.js';
import type { GraphView } from '../../../application/tui/view-model.js';
import { truncateToDisplayWidth, wrapByDisplayWidth } from '../render/width.js';
import { basisFrameKey, basisSourceKey, basisTop, type BasisFrame, type BasisState } from '../state.js';
import { AdaptiveGraph } from './graph-inspector.js';
import { tuiColors, type TuiIconMode } from '../theme.js';

/** 目录页与正文范围的硬上限：与 IC-11 的有界读取一致，界面不再放大。 */
export const BASIS_PAGE_ITEMS = 20;
export const BASIS_BODY_BYTES = 64 * 1024;
export const BASIS_CACHE_BYTES = 8 * 1024 * 1024;
export const BASIS_CACHE_ITEMS = 64;
/** 视图固定占用：标题、面包屑与底部键位行各一行，正文页另有表头与末尾提示。 */
export const BASIS_CHROME_ROWS = 3;

/** 正文一屏能显示的行数；滚动上限与 PgDn 判定都用它，界面因此不会出现魔法常量。 */
export function basisBodyRows(total: number): number {
  return Math.max(1, total - BASIS_CHROME_ROWS - 3);
}

/** Resize keeps the first visible source character in view across wrapping widths. */
export function basisReflowScroll(text: string, previous: readonly string[], next: readonly string[], scroll: number, visible: number): number {
  const advance = (offset: number, line: string): number => {
    const end = offset + line.length;
    return text[end] === '\n' ? end + 1 : end;
  };
  let anchor = 0;
  for (const line of previous.slice(0, scroll)) anchor = advance(anchor, line);
  let offset = 0, index = 0;
  while (index < next.length - 1) {
    const end = advance(offset, next[index]!);
    if (end > anchor) break;
    offset = end;
    index++;
  }
  return Math.min(index, Math.max(0, next.length - visible));
}

export type BasisPage<T> = {
  /** 与 basisFrameKey 相同语义的读取身份；不同 key 的响应不得写回当前页。 */
  readonly key: string;
  readonly session: string;
  readonly items: readonly T[];
  readonly nextCursor: string | null;
};

export type BasisBodyFrame = {
  readonly key: string;
  readonly session: string;
  readonly source: BasisSourceRef;
  readonly sourceVersion: string | null;
  readonly offset: number;
  readonly end: number;
  /** 当前范围在当前宽度下的换行结果；只排这一段，不排整篇。 */
  readonly lines: readonly string[];
  /** 权威来源声明还有后续字节；false 时 PgDn 停在末尾。 */
  readonly hasMore: boolean;
  readonly notice: string | null;
};

export type BasisViewModel = {
  readonly stack: BasisState;
  /** 发起读取时的 Session；换 Session 后迟到的结果必须被丢弃。 */
  readonly session: string | null;
  readonly versions: BasisPage<GraphVersionSummary> | null;
  readonly version: {
    readonly key: string;
    readonly summary: GraphVersionSummary;
    readonly graph: GraphView;
    readonly retiredWorkPackageIds?: readonly string[];
  } | null;
  readonly sources: BasisPage<BasisSource> | null;
  readonly body: BasisBodyFrame | null;
  readonly notice: string | null;
  readonly loading: boolean;
};

export { basisSourceKey };

class BoundedCache<T> {
  private readonly budget: number;
  private readonly limit: number;
  private readonly items = new Map<string, { readonly value: T; readonly bytes: number }>();
  bytes = 0;
  constructor(budget: number, limit: number) {
    this.budget = budget;
    this.limit = limit;
  }
  get size(): number {
    return this.items.size;
  }
  get(key: string): T | undefined {
    const item = this.items.get(key);
    if (item === undefined) return undefined;
    this.items.delete(key);
    this.items.set(key, item);
    return item.value;
  }
  set(key: string, value: T, bytes: number): void {
    const cost = bytes + key.length * 2 + 128;
    if (cost > this.budget) return;
    const previous = this.items.get(key);
    if (previous !== undefined) {
      this.bytes -= previous.bytes;
      this.items.delete(key);
    }
    while (this.items.size >= this.limit || this.bytes + cost > this.budget) {
      const oldest = this.items.keys().next();
      if (oldest.done === true) break;
      this.bytes -= this.items.get(oldest.value)!.bytes;
      this.items.delete(oldest.value);
    }
    this.items.set(key, { value, bytes: cost });
    this.bytes += cost;
  }
  clear(): void {
    this.items.clear();
    this.bytes = 0;
  }
}

/**
 * 正文阅读器：正文与布局各有上限，同一范围的并发读取合并成一次端口调用。
 *
 * 换行只对当前范围做，resize 只重排缓存里的这一段：既不重新编码整篇，也不把布局缓存当权威。
 */
export class BasisBodyReader {
  private readonly bodies = new BoundedCache<BasisBodyRange>(BASIS_CACHE_BYTES, BASIS_CACHE_ITEMS);
  private readonly layouts = new BoundedCache<readonly string[]>(BASIS_CACHE_BYTES, BASIS_CACHE_ITEMS);
  private readonly inflight = new Map<string, Promise<BasisReadResult<BasisBodyRange>>>();

  /** 已缓存的正文范围；不存在时返回 undefined，调用方据此发起读取。 */
  cached(key: string): BasisBodyRange | undefined {
    return this.bodies.get(key);
  }
  remember(key: string, range: BasisBodyRange): void {
    this.bodies.set(key, range, Buffer.byteLength(range.text, 'utf8'));
  }
  get bodyItems(): number {
    return this.bodies.size;
  }
  get layoutItems(): number {
    return this.layouts.size;
  }
  clear(): void {
    this.bodies.clear();
    this.layouts.clear();
    this.inflight.clear();
  }
  read(
    port: GraphBasisPort,
    input: {
      readonly key: string;
      readonly coordinatorSessionId: string;
      readonly source: BasisSourceRef;
      readonly sourceVersion: string | null;
      readonly offset: number;
    },
  ): Promise<BasisReadResult<BasisBodyRange>> {
    const pending = this.inflight.get(input.key);
    if (pending !== undefined) return pending;
    const request = port
      .readSource({
        coordinatorSessionId: input.coordinatorSessionId,
        source: input.source,
        sourceVersion: input.sourceVersion,
        offset: input.offset,
        maxBytes: BASIS_BODY_BYTES,
      })
      .then((result) => {
        if (result.kind === 'read') {
          if (input.sourceVersion === result.value.sourceVersion) this.remember(input.key, result.value);
        }
        return result;
      })
      .finally(() => {
        this.inflight.delete(input.key);
      });
    this.inflight.set(input.key, request);
    return request;
  }
  /** 当前范围的换行结果；宽度不同即不同缓存项，因此 resize 保留原来源与偏移。 */
  layout(key: string, text: string, width: number): readonly string[] {
    const layoutKey = `${key}@${width}`;
    const cached = this.layouts.get(layoutKey);
    if (cached !== undefined) return cached;
    const lines = wrapByDisplayWidth(text, Math.max(1, width));
    // 按换行后的实际占用计费：原文里的换行符不产生行对象，只累计行本身与每行固定开销。
    let bytes = 0;
    for (const line of lines) bytes += line.length * 2 + 64;
    this.layouts.set(layoutKey, lines, bytes);
    return lines;
  }
}

const LEVEL_TITLES: Record<BasisFrame['kind'], string> = {
  root: '执行依据与历史图',
  versions: '图版本历史',
  version: '历史图版本',
  sources: '依据来源目录',
  body: '依据正文',
};

export const BASIS_ROOT_ENTRIES = [
  { key: 'versions', title: '图版本历史（全代际）', hint: '当前代际与已结束代际 · 每页至多 20 项 · Enter 打开' },
  { key: 'sources', title: '执行依据（当前图）', hint: '原计划、已接受补丁、批准授权、原生规格与规划来源' },
] as const;

/** 历史版本里可导航的节点序列：所选工作包不在本版本时排在首位，因此退役说明不会被导航挤掉。 */
export function basisVersionSelection(graph: GraphView, selection: string | null): readonly string[] {
  const ids = graph.nodes.map((node) => node.workPackageId);
  return selection !== null && !ids.includes(selection) ? [selection, ...ids] : ids;
}

export function versionRow(summary: GraphVersionSummary): { readonly title: string; readonly hint: string } {
  const kind = summary.recordKind === 'initial' ? '初始图' : `已接受修订${summary.patchId === null ? '' : ' ' + summary.patchId}`;
  return {
    title: `${summary.current ? '›当前' : ' 历史'} G${summary.generation}·v${summary.version} ${summary.graphId} · ${kind}`,
    hint: `代际状态 ${summary.generationStatus} · map ${summary.mapRevision} · plan ${summary.planRevision} · run ${summary.orcaRunId}`,
  };
}

export function sourceRow(source: BasisSource): { readonly title: string; readonly hint: string } {
  const hint =
    source.unavailable !== null
      ? `正文缺失：${source.unavailable}`
      : source.ref === null
        ? '正文不可用'
        : `来源版本 ${source.sourceVersion ?? '未提供'}`;
  return { title: source.label, hint };
}

/**
 * 退役判定。
 *
 * 只有所选版本的已接受补丁明确列出该工作包时才称退役。
 * 两种情况都保留历史读取入口，也不自动改选别的节点。
 */
export function retirementNote(
  retiredWorkPackageIds: readonly string[],
  ref: GraphVersionRef,
  workPackageId: string,
  present: boolean,
): string | null {
  if (present) return null;
  return !retiredWorkPackageIds.includes(workPackageId)
    ? `所选工作包 ${workPackageId} 不在本版本；退役证明不可得，历史依据仍可读`
    : `所选工作包 ${workPackageId} 已由 ${ref.graphId} v${ref.version} 的已接受修订移出本版本（retire）· 历史依据仍可读`;
}

function frameLabel(frame: BasisFrame): string {
  switch (frame.kind) {
    case 'root':
      return '目录入口';
    case 'versions':
      return frame.after === null ? '版本目录' : '版本目录续页';
    case 'version':
      return `${frame.ref.graphId} G${frame.ref.generation}·v${frame.ref.version}`;
    case 'sources':
      return [
        '来源目录',
        ...(frame.workPackageId === null ? [] : [frame.workPackageId]),
        ...(frame.orcaTaskId === undefined ? [] : [`原生规格 ${frame.orcaTaskId}`]),
      ].join(' · ');
    case 'body':
      return frame.label;
  }
}

const FOOTERS: Record<BasisFrame['kind'], string> = {
  root: '↑↓ 选择 · Enter 打开 · Esc 返回',
  versions: '↑↓ 选择 · Enter 打开该版 · PgUp/PgDn 翻页 · Esc 返回',
  version: '↑↓ 选择节点 · ←→ 关系 · Enter 依据目录 · Esc 返回',
  sources: '↑↓ 选择 · Enter 读正文 · PgUp/PgDn 翻页 · Esc 返回',
  body: '↑↓ 滚动 · PgDn 下一段 · PgUp 上一段 · Esc 返回',
};

type Row = { readonly text: string; readonly selected: boolean; readonly dim: boolean };

/** 目录窗口：光标始终在视窗内，条目再多也不越过可用行数。 */
function directoryRows<T>(
  items: readonly T[],
  index: number,
  render: (item: T) => { readonly title: string; readonly hint: string },
  height: number,
): readonly Row[] {
  const visible = Math.max(1, Math.floor(height / 2));
  const start = Math.min(Math.max(0, index - Math.floor(visible / 2)), Math.max(0, items.length - visible));
  return items.slice(start, start + visible).flatMap((item, offset) => {
    const row = render(item);
    const selected = start + offset === index;
    return [
      { text: (selected ? '› ' : '  ') + row.title, selected, dim: false },
      { text: '  ' + row.hint, selected: false, dim: true },
    ];
  });
}

type BasisContent = { readonly lines: readonly Row[]; readonly graph?: GraphView; readonly graphRows?: number };

function basisContent(props: {
  readonly view: BasisViewModel;
  readonly frame: BasisFrame;
  readonly height: number;
  readonly available: boolean;
}): BasisContent {
  const { view, frame, height } = props;
  if (!props.available) {
    return { lines: [{ text: '依据读取端口未接通；历史版本与来源正文不可用', selected: false, dim: false }] };
  }
  switch (frame.kind) {
    case 'root':
      return { lines: directoryRows(BASIS_ROOT_ENTRIES, frame.index, (item) => item, height) };
    case 'versions': {
      const page = view.versions;
      if (page === null || page.key !== basisFrameKey(frame)) {
        return { lines: [{ text: view.notice ?? (view.loading ? '正在读取图版本目录…' : '图版本目录不可用'), selected: false, dim: true }] };
      }
      const rows = directoryRows(page.items.slice(0, BASIS_PAGE_ITEMS), frame.index, versionRow, height);
      return page.items.length === 0 && page.nextCursor !== null ? { lines: [{ text: '本页没有记录；PgDn 继续读取后续页', selected: false, dim: true }] } : { lines: rows };
    }
    case 'version': {
      const record = view.version;
      // 拓扑缺失也只降级为这一行不可用：只读页面绝不能把整个 TUI 画成空白。
      if (record === null || record.graph === null || record.key !== `version:${frame.ref.graphId}:${frame.ref.generation}:${frame.ref.version}`) {
        return { lines: [{ text: view.notice ?? (view.loading ? '正在读取该图版本…' : '该图版本不可用'), selected: false, dim: true }] };
      }
      const node = record.graph.nodes.find((item) => item.workPackageId === frame.selection) ?? null;
      const lines: Row[] =
        node === null && frame.selection !== null
          ? [{ text: `所选工作包 ${frame.selection} 不在本版本拓扑中`, selected: false, dim: true }]
          : [];
      const note = frame.selection === null ? null : retirementNote(record.retiredWorkPackageIds ?? [], frame.ref, frame.selection, node !== null);
      if (note !== null) lines.push({ text: note, selected: false, dim: true });
      if (frame.relations != null && frame.relations.length > 0) {
        const index = Math.max(0, Math.min(frame.relations.length - 1, frame.relationIndex));
        lines.push({ text: `选择关系 ${index + 1}/${frame.relations.length}: ${frame.relations[index]} · ↑↓ Enter`, selected: true, dim: false });
      }
      return { lines, graph: record.graph, graphRows: node === null && frame.selection !== null ? 3 : 1 };
    }
    case 'sources': {
      const page = view.sources;
      if (page === null || page.key !== basisFrameKey(frame)) {
        return { lines: [{ text: view.notice ?? (view.loading ? '正在读取依据来源目录…' : '依据来源目录不可用'), selected: false, dim: true }] };
      }
      const rows = directoryRows(page.items.slice(0, BASIS_PAGE_ITEMS), frame.index, sourceRow, height);
      // 空页不等于结束：来源目录可能跨页覆盖多个 phase，因此有 nextCursor 就还能翻。
      return page.items.length === 0 && page.nextCursor !== null ? { lines: [{ text: '本页没有来源；PgDn 继续读取后续页', selected: false, dim: true }] } : { lines: rows };
    }
    case 'body': {
      const page = view.body;
      if (page === null) {
        return { lines: [{ text: view.notice ?? (view.loading ? '正在读取正文…' : '正文不可用'), selected: false, dim: true }] };
      }
      if (page.key !== basisFrameKey(frame)) {
        return { lines: [{ text: view.notice ?? '正文范围不可用', selected: false, dim: true }] };
      }
      return {
        lines: [
          { text: `${frame.label} · 来源版本 ${frame.sourceVersion ?? '未提供'} · 字节 ${page.offset}–${page.end}`, selected: false, dim: true },
          ...(page.notice === null ? [] : [{ text: page.notice, selected: false, dim: true }]),
          ...page.lines.slice(frame.scroll, frame.scroll + height).map((text) => ({ text, selected: false, dim: false })),
          ...(page.hasMore ? [] : [{ text: '已到本来源版本末尾', selected: false, dim: true }]),
        ],
      };
    }
  }
}

export function GraphBasisView(props: {
  readonly view: BasisViewModel;
  readonly width: number;
  readonly rows: number;
  readonly iconMode?: TuiIconMode;
  /** 端口未装配时为 false：入口仍可见，但内容按结构化不可用显示。 */
  readonly available?: boolean;
}) {
  const frame = basisTop(props.view.stack);
  const width = Math.max(1, props.width - 4);
  const height = Math.max(6, props.rows);
  const content = Math.max(2, height - BASIS_CHROME_ROWS - 1);
  const fit = (text: string) => truncateToDisplayWidth(text, width);
  const rendered = basisContent({ view: props.view, frame, height: content, available: props.available ?? true });
  const graphRows = rendered.graph === undefined ? 0 : Math.max(5, content - (rendered.graphRows ?? 1) - rendered.lines.length);
  const textRows = Math.max(1, content - graphRows);
  return (
    <Box
      width={props.width}
      height={height}
      flexDirection="column"
      borderStyle="round"
      borderColor={tuiColors.border}
      paddingX={1}
      overflow="hidden"
    >
      <Text bold color={tuiColors.accent}>
        {fit(LEVEL_TITLES[frame.kind] + (frame.kind === 'version' ? ' · 只读历史拓扑' : ''))}
      </Text>
      <Text dimColor>{fit(props.view.stack.frames.map(frameLabel).join(' › '))}</Text>
      {rendered.graph === undefined ? null : (
        <AdaptiveGraph
          graph={rendered.graph}
          selectedId={frame.kind === 'version' ? frame.selection : null}
          width={width}
          height={graphRows}
          planning={false}
          inspector={true}
          historical={true}
          detail={false}
          tab={frame.kind === 'version' ? frame.tab : 0}
          scroll={0}
          iconMode={props.iconMode ?? 'nerd'}
        />
      )}
      {rendered.lines.slice(0, textRows).map((row, index) => (
        <Text key={index} {...(row.selected ? { color: tuiColors.focus } : {})} inverse={row.selected} dimColor={row.dim && !row.selected}>
          {fit(row.text)}
        </Text>
      ))}
      {props.view.notice === null || frame.kind === 'body' ? null : <Text color={tuiColors.warning}>{fit(props.view.notice)}</Text>}
      <Text dimColor>{fit(props.view.loading ? '读取中… · ' + FOOTERS[frame.kind] : FOOTERS[frame.kind])}</Text>
    </Box>
  );
}
