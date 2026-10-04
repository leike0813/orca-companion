/**
 * 图历史与执行依据的 fake 端口（IP-04 行为测试）。
 *
 * 它按生产合同工作：keyset 目录、UTF-8 连续的范围正文、精确图版本身份与「未保留/不可用」结果。
 * 测试因此能断言可观察事实（读了哪些来源、续读是否连续、迟到结果是否被丢弃），而不是内部结构。
 */

import type {
  BasisBodyRange,
  BasisSource,
  BasisSourceRef,
  GraphBasisPort,
  GraphVersionRef,
  GraphVersionSummary,
} from '../../src/application/tui/graph-basis.js';
import type { GraphView } from '../../src/application/tui/view-model.js';

export type FakeGraphBasisCall = { readonly name: string; readonly detail: unknown };

export type FakeGraphBasisOptions = {
  readonly versions?: readonly GraphVersionSummary[];
  /** 每个图版本的只读拓扑；缺失的版本返回 unavailable。 */
  readonly graphs?: Readonly<Record<string, GraphView | null>>;
  readonly sources?: readonly BasisSource[];
  /** 带原生 Task 身份后继续下钻时列出的真实文件来源。 */
  readonly specFiles?: readonly BasisSource[];
  /** 来源 id 到正文的映射；未登记的来源返回 unavailable。 */
  readonly bodies?: Readonly<Record<string, string>>;
  /** 目录页大小；生产合同是每页至多 20 项。 */
  readonly pageSize?: number;
  /** 逐次覆盖某次调用，用来制造迟到结果。 */
  readonly onCall?: (call: FakeGraphBasisCall) => void;
};

export type FakeGraphBasis = {
  readonly port: GraphBasisPort;
  readonly calls: FakeGraphBasisCall[];
  callsOf(name: string): readonly FakeGraphBasisCall[];
};

/** UTF-8 字节范围；尾部的半个字符序列会被回退到字符边界，因此续读不会切碎多字节字符。 */
function readRange(text: string, sourceVersion: string, offset: number, maxBytes: number): BasisBodyRange {
  const bytes = Buffer.from(text, 'utf8');
  const start = Math.max(0, Math.min(offset, bytes.length));
  let end = Math.min(bytes.length, start + Math.max(0, maxBytes));
  while (end < bytes.length && end > start && (bytes[end]! & 0xc0) === 0x80) end--;
  const slice = bytes.subarray(start, end).toString('utf8');
  return { sourceVersion, text: slice, offset: start, end, byteLength: bytes.length };
}

function keyOf(source: BasisSourceRef): string {
  switch (source.kind) {
    case 'initial_plan':
    case 'graph_patch':
      return `${source.kind}:${source.graph.graphId}:${source.graph.generation}:${source.graph.version}`;
    case 'authorization':
      return `authorization:${source.authorizationId}@${source.authorizationVersion}`;
    case 'retained_task':
      return `retained_task:${source.workPackageId}:${source.orcaTaskId}`;
    case 'specification':
      return `specification:${source.orcaTaskId}:${source.locator.worktreeId}:${source.locator.relativePath}:${source.path}:${source.contractRevision}`;
    case 'tracker':
      return `tracker:${source.issueRef}`;
  }
}

function page<T>(items: readonly T[], after: string | null, pageSize: number): { items: readonly T[]; nextCursor: string | null } {
  // 游标是 keyset 式的「已消费条数」，不是下标：续页只依赖它，不依赖偏移或 Scope revision。
  const start = after === null ? 0 : Math.max(0, Math.min(items.length, Number.parseInt(after, 10) || 0));
  const slice = items.slice(start, start + pageSize);
  const last = start + slice.length;
  return { items: slice, nextCursor: last < items.length ? String(last) : null };
}

export function createFakeGraphBasis(options: FakeGraphBasisOptions = {}): FakeGraphBasis {
  const calls: FakeGraphBasisCall[] = [];
  const versions = options.versions ?? [];
  const sources = options.sources ?? [];
  const bodies = options.bodies ?? {};
  const pageSize = options.pageSize ?? 20;
  const record = (name: string, detail: unknown) => {
    const call: FakeGraphBasisCall = { name, detail };
    calls.push(call);
    options.onCall?.(call);
  };
  const readVersion = (graph: GraphVersionRef): GraphView | null | undefined =>
    options.graphs?.[`${graph.graphId}:${graph.generation}:${graph.version}`];

  const port: GraphBasisPort = {
    listVersions: (input) => {
      record('graphBasis.listVersions', input);
      return Promise.resolve({ kind: 'read', value: page(versions, input.after, pageSize) });
    },
    readVersion: (input) => {
      record('graphBasis.readVersion', input);
      const summary = versions.find(
        (item) => item.graphId === input.graph.graphId && item.generation === input.graph.generation && item.version === input.graph.version,
      );
      const graph = readVersion(input.graph);
      if (summary === undefined || graph == null) {
        return Promise.resolve({ kind: 'unavailable', code: 'graph_version_missing', message: '该图版本没有可证明的记录' });
      }
      return Promise.resolve({ kind: 'read', value: { summary, graph } });
    },
    listSources: (input) => {
      record('graphBasis.listSources', input);
      const items = input.orcaTaskId === undefined ? sources : (options.specFiles ?? []);
      return Promise.resolve({ kind: 'read', value: page(items, input.after, pageSize) });
    },
    readSource: (input) => {
      record('graphBasis.readSource', input);
      const text = bodies[keyOf(input.source)];
      if (text === undefined) {
        return Promise.resolve({ kind: 'unavailable', code: 'source_body_missing', message: '该来源没有保留正文' });
      }
      return Promise.resolve({ kind: 'read', value: readRange(text, input.sourceVersion ?? 'version-1', input.offset, input.maxBytes) });
    },
  };

  return { port, calls, callsOf: (name) => calls.filter((call) => call.name === name) };
}
