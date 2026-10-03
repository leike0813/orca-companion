/**
 * IP-04 行为测试：Session 已提交历史的独立有界搜索。
 *
 * 固定的是可观察边界——命中的原文字节位置、跨块与跨批次的续接、每批读回上限、固定上界、取消后
 * 迟到结果不得变成命中、游标身份、索引未就绪与读取失败的显式失败。断言落在偏移、计数、状态码和
 * 端口读取上，不断言内部调用顺序或文案。
 *
 * 替身只复刻读取合同（键集元数据、UTF-8 边界、100 项/64 KiB 一页），不解析 Markdown、不排版。
 * 预览入口被记下来而不是抛错，好证明搜索从不碰运行期来源。
 */

import { expect, test } from 'vitest';

import {
  HistoryBoundaryError,
  type HistoryMetadata,
  type HistoryPageQuery,
  type TranscriptBodyQuery,
  type TranscriptBodyRange,
  type TranscriptReadingPort,
} from '../../src/application/coordinator/history.js';
import {
  HistoryIndexNotReadyError,
  HistorySearchCursorError,
  HistorySearchError,
  scanHistory,
} from '../../src/application/coordinator/history-search.js';
import type {
  HistoryCall,
  HistoryCallPage,
  HistoryCallQuery,
  HistorySearchHit,
  UserHistoryQuery,
} from '../../src/application/coordinator/history-inspection.js';
import type { DurableMessageRole } from '../../src/domain/coordinator/session-state.js';

const SESSION = 'session-search';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const byteLengthOf = (text: string): number => encoder.encode(text).length;
const readOriginal = (text: string, offset: number, end: number): string =>
  decoder.decode(encoder.encode(text).subarray(offset, end));

type FixtureCall = { readonly callId: string; readonly stepId: string; readonly args: string };
type FixtureEntry = {
  readonly role: DurableMessageRole;
  readonly content: string;
  readonly calls?: readonly FixtureCall[];
};
type FixtureRead = {
  readonly sourceKind: TranscriptBodyQuery['source']['kind'];
  readonly entryId: string;
  readonly offset: number;
  readonly maxBytes: number;
  bytes: number;
};
type FixtureOptions = {
  readonly sessionId?: string;
  readonly entries?: readonly FixtureEntry[];
  readonly ready?: boolean;
  readonly onRead?: (read: FixtureRead, index: number) => void | Promise<void>;
  readonly failRead?: (read: FixtureRead) => boolean;
};

/** 只复刻读取合同的内存端口：键集元数据 + UTF-8 字节范围。 */
function createSearchFixture(options: FixtureOptions = {}) {
  const sessionId = options.sessionId ?? SESSION;
  const entries: FixtureEntry[] = [...(options.entries ?? [])];
  const reads: FixtureRead[] = [];
  const temporaryAccess: string[] = [];

  const entryIdOf = (index: number): string => 'e' + String(index + 1);
  const metadata = (index: number): HistoryMetadata => ({
    entryId: entryIdOf(index), stepId: 's' + String(index + 1), role: entries[index]!.role,
    sequence: index + 1, contentRevision: 1, byteLength: byteLengthOf(entries[index]!.content),
  });
  const textOf = (source: TranscriptBodyQuery['source']): string | null => {
    if (source.kind === 'history') {
      const index = entries.findIndex((_, position) => entryIdOf(position) === source.entryId);
      return index === -1 ? null : entries[index]!.content;
    }
    if (source.kind === 'arguments') {
      for (const [index, entry] of entries.entries()) {
        if (entry.calls?.some(candidate => candidate.callId === source.callId) === true) {
          return entryIdOf(index) === source.entryId ? source.callId === '' ? null : argsOf(entry, source.callId) : null;
        }
      }
      return null;
    }
    return null;
  };
  const argsOf = (entry: FixtureEntry, callId: string): string | null =>
    entry.calls?.find(candidate => candidate.callId === callId)?.args ?? null;
  const callsOf = (query: HistoryCallQuery): HistoryCallPage => {
    if (query.coordinatorSessionId !== sessionId) return { calls: [], hasMore: false };
    const anchor = query.after;
    const calls: HistoryCall[] = entries.flatMap((entry, index) => (entry.calls ?? [])
      .map((call, ordinal) => ({ call, index, position: { sequence: index + 1, ordinal: ordinal + 1 } })))
      .filter(item => query.entryId === undefined || entryIdOf(item.index) === query.entryId)
      .filter(item => item.position.sequence <= (query.upperSequence ?? entries.length))
      .filter(item => anchor === undefined
        || item.position.sequence > anchor.sequence
        || (item.position.sequence === anchor.sequence && item.position.ordinal > anchor.ordinal))
      .map(item => ({ entryId: entryIdOf(item.index), stepId: item.call.stepId, callId: item.call.callId,
        name: 'read', operationId: 'op-' + item.call.callId, activityKind: 'query' as const,
        activityId: 'act-' + item.call.callId, argsByteLength: byteLengthOf(item.call.args),
        result: null, status: 'ok' as const, ...item.position }));
    return { calls: calls.slice(0, 100), hasMore: calls.length > 100 };
  };

  const port: TranscriptReadingPort = {
    inspection: {
      snapshot: (id: string) => Promise.resolve({ upperSequence: entries.length,
        indexedThroughSequence: entries.length, ready: id === sessionId ? (options.ready ?? true) : false }),
      calls: (query: HistoryCallQuery) => Promise.resolve(callsOf(query)),
      users: (query: UserHistoryQuery) => {
        const rows: number[] = [];
        for (let index = 0; index < entries.length; index += 1) {
          const sequence = index + 1;
          if (entries[index]!.role !== 'user') continue;
          if (sequence <= (query.after ?? 0)) continue;
          if (query.upperSequence !== undefined && sequence > query.upperSequence) break;
          rows.push(index);
        }
        const window = rows.slice(0, 100);
        return Promise.resolve({ entries: window.map(metadata), hasMore: rows.length > window.length });
      },
    },
    history: (query: HistoryPageQuery) => {
      if (query.coordinatorSessionId !== sessionId) return Promise.resolve({ entries: [], hasMore: false });
      const after = query.after ?? 0;
      const before = query.before ?? entries.length + 1;
      const rows: number[] = [];
      for (let index = 0; index < entries.length; index += 1) {
        if (index + 1 > after && index + 1 < before) rows.push(index);
      }
      const window = query.direction === 'newer' ? rows.slice(0, 100) : rows.slice(-100);
      return Promise.resolve({ entries: window.map(metadata), hasMore: window.length < rows.length });
    },
    body: async (query: TranscriptBodyQuery): Promise<TranscriptBodyRange | null> => {
      if (query.coordinatorSessionId !== sessionId) return null;
      if (query.source.kind === 'preview' || query.source.kind === 'interaction') return null;
      const text = textOf(query.source);
      if (text === null) return null;
      const bytes = encoder.encode(text);
      if (query.offset >= bytes.length) return null;
      const read: FixtureRead = { sourceKind: query.source.kind,
        entryId: query.source.entryId, offset: query.offset, maxBytes: query.maxBytes, bytes: 0 };
      reads.push(read);
      await options.onRead?.(read, reads.length - 1);
      if (options.failRead?.(read) === true) throw new Error('history store is unavailable');
      if (query.offset > 0 && (bytes[query.offset]! & 0xc0) === 0x80) {
        throw new HistoryBoundaryError('offset is not a UTF-8 boundary');
      }
      let end = Math.min(bytes.length, query.offset + query.maxBytes);
      while (end > query.offset && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
      read.bytes = end - query.offset;
      return { source: query.source, offset: query.offset, end, byteLength: bytes.length,
        text: decoder.decode(bytes.subarray(query.offset, end)) };
    },
    previews: () => { temporaryAccess.push('previews'); return Promise.resolve([]); },
    pin: () => { temporaryAccess.push('pin'); return () => {}; },
    subscribe: () => { temporaryAccess.push('subscribe'); return () => {}; },
  };
  return { port, reads, temporaryAccess, entries, sessionId };
}

const search = (coordinatorSessionId: string, literal: string, upperSequence: number, target: 'transcript' | 'users' = 'transcript') =>
  ({ coordinatorSessionId, target, literal, upperSequence });

async function allHits(port: TranscriptReadingPort, query: Parameters<typeof scanHistory>[1], cursor: string | null = null) {
  const hits: HistorySearchHit[] = [];
  for (let batch = 0; batch < 1000; batch++) {
    const page = await scanHistory(port, { ...query, cursor });
    expect(page.scannedItems).toBeLessThanOrEqual(100);
    expect(page.scannedBytes).toBeLessThanOrEqual(65536);
    hits.push(...page.hits);
    if (page.complete) return hits;
    expect(page.cursor).not.toBe(cursor);
    cursor = page.cursor;
  }
  throw new Error('search did not finish');
}

test('命中映射到原文的 UTF-8 字节偏移', async () => {
  const content = '前言 里程碑 后续 😀 收尾';
  const fixture = createSearchFixture({ entries: [{ role: 'user', content }] });
  const page = await scanHistory(fixture.port, search(SESSION, '里程碑', 1));

  expect(page.complete).toBe(true);
  expect(page.hits).toEqual([{ source: { kind: 'history', entryId: 'e1', contentRevision: 1 },
    sequence: 1, offset: byteLengthOf('前言 '), end: byteLengthOf('前言 里程碑') }]);
  expect(readOriginal(content, page.hits[0]!.offset, page.hits[0]!.end)).toBe('里程碑');
  expect(fixture.temporaryAccess).toEqual([]);
});

test('无工具调用的连续 Agent 历史按页推进，保留所有匹配且读取工作随记录数增长', async () => {
  const count = 240;
  const fixture = createSearchFixture({ entries: Array.from({ length: count }, (_, index) => ({
    role: index % 2 ? 'assistant' as const : 'user' as const, content: 'needle ' + index })) });
  let metadataItems = 0;
  const reading = { ...fixture.port, history: async (query: HistoryPageQuery) => {
    const page = await fixture.port.history(query); metadataItems += page.entries.length; return page;
  } };
  const hits = await allHits(reading, search(SESSION, 'needle', count));
  expect(hits.map(hit => hit.sequence)).toEqual(Array.from({ length: count }, (_, index) => index + 1));
  expect(metadataItems).toBeLessThanOrEqual(count * 2 + 100);
});

test.each([1, 2, 3])('块末不足四字节的正文仍会读完：%i', async tail => {
  const content = 'a'.repeat(16384) + 'x'.repeat(tail);
  const fixture = createSearchFixture({ entries: [{ role: 'user', content }] });
  const hits = await allHits(fixture.port, search(SESSION, 'x'.repeat(tail), 1));
  expect(hits.map(hit => [hit.offset, hit.end])).toEqual([[16384, content.length]]);
});

test('长来源身份的结果页遵守字节限额并完整续扫', async () => {
  const fixture = createSearchFixture({ entries: [{ role: 'assistant', content: '',
    calls: [{ callId: 'c'.repeat(2500), stepId: 's1', args: 'needle '.repeat(100) }] }] });
  const query = search(SESSION, 'needle', 1);
  let cursor: string | null = null; const offsets: number[] = [];
  for (let batch = 0; batch < 30; batch++) {
    const page = await scanHistory(fixture.port, { ...query, cursor });
    expect(byteLengthOf(JSON.stringify(page))).toBeLessThanOrEqual(65536);
    expect(page.scannedItems).toBeLessThanOrEqual(100);
    offsets.push(...page.hits.map(hit => hit.offset));
    if (page.complete) break;
    expect(page.cursor).not.toBe(cursor); cursor = page.cursor;
  }
  expect(offsets).toEqual(Array.from({ length: 100 }, (_, n) => n * 7));
});

test('跨块匹配只上报一次且位置正确', async () => {
  // 命中横跨第一次块读的字符边界：块在 16384 字节处按 UTF-8 回退，'日本語' 从 16381 开始。
  const content = 'a'.repeat(16381) + '日本語' + '尾巴';
  const fixture = createSearchFixture({ entries: [{ role: 'user', content }] });
  const page = await scanHistory(fixture.port, search(SESSION, '日本語', 1));

  expect(page.hits).toEqual([{ source: { kind: 'history', entryId: 'e1', contentRevision: 1 },
    sequence: 1, offset: 16381, end: 16390 }]);
  expect(page.complete).toBe(true);
  expect(fixture.reads.every(read => read.maxBytes <= 16 * 1024)).toBe(true);
});

test('命中跨过批次边界时由回读重叠接上', async () => {
  // 第一批正好读 64 KiB：'needle' 从 65531 跨到 65537，被切在两批之间。回读重叠还要从
  // 多字节字符中间起步（65516 是 '日' 的尾字节），因此这条路径同时压住边界回退。
  const content = 'a'.repeat(65514) + '日' + 'a'.repeat(14) + 'needl' + 'e' + 'b'.repeat(20000);
  const fixture = createSearchFixture({ entries: [{ role: 'user', content }] });
  const base = search(SESSION, 'needle', 1);

  const first = await scanHistory(fixture.port, base);
  expect(first.hits).toEqual([]);
  expect(first.complete).toBe(false);
  expect(first.scannedBytes).toBe(64 * 1024);

  const second = await scanHistory(fixture.port, { ...base, cursor: first.cursor });
  expect(second.hits).toEqual([{ source: { kind: 'history', entryId: 'e1', contentRevision: 1 },
    sequence: 1, offset: 65531, end: 65537 }]);
  expect(second.complete).toBe(true);
  expect(readOriginal(content, 65531, 65537)).toBe('needle');
});

test('大小写按简单折叠，ß 和全角不做等价', async () => {
  const content = 'GROßE Straße ÜBER Äpfel ＡＢＣ';
  const fixture = createSearchFixture({ entries: [{ role: 'user', content }] });

  const sharpS = await scanHistory(fixture.port, search(SESSION, 'große', 1));
  expect(sharpS.hits).toHaveLength(1);
  expect(sharpS.hits[0]!.offset).toBe(0);

  const upper = await scanHistory(fixture.port, search(SESSION, 'über', 1));
  expect(upper.hits).toHaveLength(1);

  // ß→ss、NFKC 和组合字符去重都不做，所以这些等价写法没有命中。
  for (const literal of ['grosse', 'GROSSE', 'ss', 'abc', 'a\u0308pfel']) {
    const page = await scanHistory(fixture.port, search(SESSION, literal, 1));
    expect(page.hits).toEqual([]);
    expect(page.complete).toBe(true);
  }
});

test('命中上限先到时保留游标，继续查找补齐第 50 个之后的后缀', async () => {
  const content = 'needle '.repeat(60);
  const expected = Array.from({ length: 60 }, (_, index) => index * 7);
  const fixture = createSearchFixture({ entries: [{ role: 'user', content }] });
  const base = search(SESSION, 'needle', 1);

  const first = await scanHistory(fixture.port, base);
  expect(first.hits).toHaveLength(50);
  expect(first.complete).toBe(false);
  expect(first.cursor).not.toBeNull();

  const second = await scanHistory(fixture.port, { ...base, cursor: first.cursor });
  expect(second.complete).toBe(true);
  expect(second.cursor).toBeNull();
  expect([...first.hits, ...second.hits].map(hit => hit.offset)).toEqual(expected);
});

test('大正文按批推进：每批读回有界，跨批次不漏不重', async () => {
  // 64 段，每段 3196 字节：每批 64 KiB 的读回上限落在段中间，续接必须跨批次成立。
  const block = 'a'.repeat(3190) + 'needle';
  const content = block.repeat(64);
  const expected = Array.from({ length: 64 }, (_, index) => index * 3196 + 3190);
  const fixture = createSearchFixture({ entries: [{ role: 'assistant', content }] });
  const base = search(SESSION, 'needle', 1);

  const hits: HistorySearchHit[] = [];
  let cursor: string | null = null;
  let readIndex = 0;
  for (let round = 0; round < 32; round += 1) {
    const page = await scanHistory(fixture.port, { ...base, cursor });
    expect(page.hits.length).toBeLessThanOrEqual(50);
    expect(fixture.reads.slice(readIndex).reduce((total, read) => total + read.bytes, 0))
      .toBeLessThanOrEqual(64 * 1024);
    readIndex = fixture.reads.length;
    hits.push(...page.hits);
    if (page.complete) { cursor = null; break; }
    expect(page.cursor).not.toBeNull();
    cursor = page.cursor;
  }

  expect(cursor).toBeNull();
  expect(hits.map(hit => hit.offset)).toEqual(expected);
  expect(fixture.reads.every(read => read.maxBytes <= 16 * 1024)).toBe(true);
  expect(fixture.reads.length).toBeGreaterThan(4);
});

test('大批次截断在参数中途时，后续调用不会漏', async () => {
  // 第一个调用的参数就超过一批 64 KiB 的读回上限：游标停在它的中间，恢复后必须接着走完它
  // 并进入同一个 entry 的下一个调用，否则 c2 的命中会被静默跳过。
  const fixture = createSearchFixture({ entries: [{
    role: 'assistant', content: '模型回复',
    calls: [
      { callId: 'c1', stepId: 's1', args: 'a'.repeat(70000) },
      { callId: 'c2', stepId: 's1', args: 'needle' },
    ],
  }] });
  const base = search(SESSION, 'needle', 1);

  const first = await scanHistory(fixture.port, base);
  expect(first.hits).toEqual([]);
  expect(first.complete).toBe(false);

  const remaining = await allHits(fixture.port, base, first.cursor);
  expect(remaining).toEqual([{ source: { kind: 'arguments', entryId: 'e1', stepId: 's1',
    callId: 'c2', contentRevision: 1 }, sequence: 1, offset: 0, end: 6, ordinal: 2 }]);
});

test('同一 entry 的多个调用按 canonical ordinal 而不是 callId 排序', async () => {
  // callId 的字典序与调用顺序相反：命中必须带着调用序号，界面才能正确定位上一个/下一个。
  const fixture = createSearchFixture({ entries: [{
    role: 'assistant', content: '模型回复',
    calls: [
      { callId: 'z-call', stepId: 's1', args: 'needle' },
      { callId: 'a-call', stepId: 's1', args: 'needle' },
    ],
  }] });
  const hits = await allHits(fixture.port, search(SESSION, 'needle', 1));

  expect(hits.map(hit => hit.source.kind === 'arguments' ? hit.source.callId : hit.source.kind))
    .toEqual(['z-call', 'a-call']);
  expect(hits.map(hit => hit.ordinal)).toEqual([1, 2]);
});

test('固定上界之外的记录不纳入本轮', async () => {
  const fixture = createSearchFixture({ entries: [
    { role: 'user', content: '目标' },
    { role: 'assistant', content: '无关' },
    { role: 'user', content: '目标在上界之外' },
  ] });
  const hits = await allHits(fixture.port, search(SESSION, '目标', 2));
  expect(hits.map(hit => hit.sequence)).toEqual([1]);
});

test('工具参数与工具结果一起被搜，users 只搜用户输入', async () => {
  const fixture = createSearchFixture({ entries: [
    { role: 'user', content: '用户提到 needle' },
    { role: 'assistant', content: '模型回复', calls: [
      { callId: 'c1', stepId: 's2', args: '{"path":"a","hint":"needle"}' },
      { callId: 'c2', stepId: 's2', args: '{"path":"b"}' },
    ] },
    { role: 'tool', content: '工具结果里也有 needle' },
  ] });

  const transcript = await allHits(fixture.port, search(SESSION, 'needle', 3));
  expect(transcript.map(hit => hit.source.kind)).toEqual(['history', 'arguments', 'history']);
  expect(transcript[1]!.source).toEqual({ kind: 'arguments', entryId: 'e2', stepId: 's2',
    callId: 'c1', contentRevision: 1 });
  expect(transcript[1]!.sequence).toBe(2);
  expect(transcript[1]!.offset).toBe(byteLengthOf('{"path":"a","hint":"'));
  expect(transcript.map(hit => hit.sequence)).toEqual([1, 2, 3]);
  // 只有参数来源带调用序号，正文来源没有这个概念。
  expect(transcript.map(hit => hit.ordinal)).toEqual([undefined, 1, undefined]);

  const users = await scanHistory(fixture.port, search(SESSION, 'needle', 3, 'users'));
  expect(users.hits.map(hit => hit.sequence)).toEqual([1]);
  expect(users.complete).toBe(true);
});

test('游标绑定 Session、target、字面量与上界', async () => {
  const content = 'needle'.repeat(4000);
  const fixture = createSearchFixture({ sessionId: SESSION, entries: [{ role: 'user', content }] });
  const other = createSearchFixture({ sessionId: 'session-other', entries: [{ role: 'user', content }] });
  const cursor = (await scanHistory(fixture.port, search(SESSION, 'needle', 1))).cursor;
  expect(cursor).not.toBeNull();

  const mismatched = [
    { ...search(SESSION, 'needle', 1, 'users'), cursor },
    { ...search(SESSION, 'needles', 1), cursor },
    { ...search(SESSION, 'needle', 2), cursor },
  ];
  for (const query of mismatched) {
    await expect(scanHistory(fixture.port, query)).rejects.toBeInstanceOf(HistorySearchCursorError);
  }
  await expect(scanHistory(other.port, { ...search('session-other', 'needle', 1), cursor }))
    .rejects.toBeInstanceOf(HistorySearchCursorError);
  await expect(scanHistory(fixture.port, { ...search(SESSION, 'needle', 1), cursor: 'not-a-cursor' }))
    .rejects.toBeInstanceOf(HistorySearchCursorError);

  // 同一轮查询的游标可以接着用。
  const resumed = await scanHistory(fixture.port, { ...search(SESSION, 'needle', 1), cursor });
  expect(resumed.hits.length).toBeGreaterThan(0);
});

test('索引未就绪显式失败', async () => {
  const fixture = createSearchFixture({ entries: [{ role: 'user', content: 'needle' }], ready: false });
  await expect(scanHistory(fixture.port, search(SESSION, 'needle', 1)))
    .rejects.toBeInstanceOf(HistoryIndexNotReadyError);
});

test('空字面量是空闲完成，不读任何来源', async () => {
  const fixture = createSearchFixture({ entries: [{ role: 'user', content: 'needle' }], ready: false });
  const page = await scanHistory(fixture.port, search(SESSION, '', 1));
  expect(page).toEqual({ hits: [], cursor: null, complete: true, scannedBytes: 0, scannedItems: 0 });
  expect(fixture.reads).toEqual([]);
});

test('取消后迟到的读取结果不会变成命中', async () => {
  const controller = new AbortController();
  // 前 6 万字节没有命中，第三块读完时取消：迟到的结果必须被丢弃而不是并入命中。
  const content = 'a'.repeat(30000) + 'needle' + 'b'.repeat(30000);
  const fixture = createSearchFixture({ entries: [{ role: 'user', content }],
    onRead: (_read, index) => { if (index === 2) controller.abort(); } });

  await expect(scanHistory(fixture.port, search(SESSION, 'needle', 1), controller.signal))
    .rejects.toMatchObject({ name: 'AbortError' });
  expect(fixture.reads).toHaveLength(3);
});

test('预取消不读任何来源', async () => {
  const controller = new AbortController();
  controller.abort();
  const fixture = createSearchFixture({ entries: [{ role: 'user', content: 'needle' }] });

  await expect(scanHistory(fixture.port, search(SESSION, 'needle', 1), controller.signal))
    .rejects.toMatchObject({ name: 'AbortError' });
  expect(fixture.reads).toEqual([]);
});

test('读取失败不当成没有匹配', async () => {
  const fixture = createSearchFixture({ entries: [
    { role: 'user', content: '前文' },
    { role: 'user', content: 'needle' },
  ], failRead: read => read.entryId === 'e2' });

  await expect(scanHistory(fixture.port, search(SESSION, 'needle', 2)))
    .rejects.toThrow('history store is unavailable');
});

test('索引指向的参数缺失不能报告无匹配', async () => {
  const fixture = createSearchFixture({ entries: [{ role: 'assistant', content: '',
    calls: [{ callId: 'call', stepId: 's1', args: '{"value":"needle"}' }] }] });
  const reading = { ...fixture.port, body: () => Promise.resolve(null) };
  await expect(allHits(reading, search(SESSION, 'needle', 1))).rejects.toBeInstanceOf(HistorySearchError);
});
