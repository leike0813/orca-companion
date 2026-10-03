/**
 * IP-04：Session 已提交历史的独立有界搜索（Owner: `m1-wire-foreground-planning-runtime`）。
 *
 * 搜索只消费 IC-04/11 的读取端口——键集元数据、正文范围和调用索引。它不解析 Markdown、不排版、
 * 不读运行期预览，也不认识 Ink，因此不依赖 TUI 就能跑完。命中是**原文位置**（UTF-8 字节偏移），
 * 怎么定位、怎么高亮由调用方决定。
 *
 * 一次 `scanHistory` 就是一批：≤100 项元数据、≤64 KiB 正文读取（含跨块重叠）、≤50 个命中。
 * 没扫完就返回 `complete: false` 和一个不透明游标，绝不用「没有匹配」冒充中途结果；读取失败直接
 * 抛出，让调用方区分失败与无匹配。游标绑定 Session、target、字面量与固定上界，换一个查询复用它
 * 会被拒绝。
 *
 * 跨块的重叠是必需的：一次块读在字符边界结束，但一次匹配可能横跨边界。保留字面量长度减一个
 * code point 的尾巴，重叠区里完全落在已扫描范围内的命中不再重复上报，因此既不漏掉续接的匹配，
 * 也不产生重复命中。工作区因此只有这一批结果、≤255 code point 的尾巴和当前一块正文，远低于
 * 1 MiB / 64 项的上限；从不保留全部命中。
 */

import { z } from 'zod';

import { DURABLE_MESSAGE_ROLES, type DurableMessageRole } from '../../domain/coordinator/session-state.js';
import {
  HistoryBoundaryError,
  HISTORY_CHUNK_BYTES,
  type HistoryMetadataPage,
  type TranscriptReadingPort,
  type TranscriptSourceRef,
} from './history.js';
import {
  callPositionSchema,
  historySearchQuerySchema,
  type CallPosition,
  type HistoryCall,
  type HistoryInspectionReadingPort,
  type HistorySearchHit,
  type HistorySearchPage,
  type HistorySearchQuery,
} from './history-inspection.js';

const SEARCH_MAX_HITS = 50;
const SEARCH_BATCH_ITEMS = 100;
const SEARCH_BATCH_BODY_BYTES = 64 * 1024;
const SEARCH_CURSOR_MAX_BYTES = 4096;
const SEARCH_RESULT_BYTES = 64 * 1024 - SEARCH_CURSOR_MAX_BYTES - 256;
/** `transcriptBodyQuerySchema` 拒绝更小的 maxBytes。 */
const SEARCH_MIN_READ_BYTES = 4;

export class HistorySearchError extends Error {}
/** 派生索引未就绪时必须显式失败，不能扫出「看起来没有匹配」的结果。 */
export class HistoryIndexNotReadyError extends HistorySearchError {}
export class HistorySearchCursorError extends HistorySearchError {}

/** 搜索只读已提交来源；运行期预览没有稳定位置，不进搜索。 */
type SearchableSource = Extract<TranscriptSourceRef, { readonly kind: 'history' } | { readonly kind: 'arguments' }>;

/**
 * 扫描位置。`metadata` 是元数据键集；`entry` 表示「这个 entry 的正文已读完，继续走它的参数」；
 * `body` 表示正在读某个来源的某个字节偏移。`afterCall` 区分正文阶段与参数阶段。
 */
export type HistorySearchPosition =
  | { readonly kind: 'metadata'; readonly afterSequence: number }
  | {
      readonly kind: 'entry';
      readonly entryId: string;
      readonly sequence: number;
      readonly role: DurableMessageRole;
      readonly afterCall: CallPosition | null;
    }
  | {
      readonly kind: 'body';
      readonly entryId: string;
      readonly sequence: number;
      readonly role: DurableMessageRole;
      readonly source: SearchableSource;
      offset: number;
      readonly byteLength: number;
      readonly afterCall: CallPosition | null;
    };

const identity = z.string().min(1);
const integer = z.number().int().nonnegative();
const searchableSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('history'), entryId: identity, contentRevision: z.literal(1) }),
  z.strictObject({ kind: z.literal('arguments'), entryId: identity, stepId: identity, callId: identity, contentRevision: z.literal(1) }),
]);
const positionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('metadata'), afterSequence: integer }),
  z.strictObject({ kind: z.literal('entry'), entryId: identity, sequence: integer,
    role: z.enum(DURABLE_MESSAGE_ROLES), afterCall: callPositionSchema.nullable() }),
  z.strictObject({ kind: z.literal('body'), entryId: identity, sequence: integer,
    role: z.enum(DURABLE_MESSAGE_ROLES), source: searchableSourceSchema, offset: integer,
    byteLength: integer, afterCall: callPositionSchema.nullable() }),
]);
const cursorSchema = z.strictObject({
  v: z.literal(1),
  session: identity,
  target: z.enum(['transcript', 'users']),
  literal: z.string(),
  upperSequence: integer,
  position: positionSchema,
  hasCalls: z.boolean().optional(),
});

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const byteLengthOf = (text: string): number => encoder.encode(text).length;

/** 字面量转义后按 Unicode 简单折叠匹配：不额外做 NFKC、去重音或 ß→ss。 */
const escapeRegExp = (literal: string): string => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function previousCodePointIndex(text: string, index: number): number {
  const last = text.charCodeAt(index - 1);
  if (last >= 0xdc00 && last <= 0xdfff && index >= 2) {
    const lead = text.charCodeAt(index - 2);
    if (lead >= 0xd800 && lead <= 0xdbff) return index - 2;
  }
  return index - 1;
}

/** 末尾 `count` 个完整 code point；按 code point 切，尾巴不会截断代理对。 */
function tailCodePoints(text: string, count: number): string {
  if (count <= 0) return '';
  let index = text.length;
  for (let taken = 0; taken < count && index > 0; taken += 1) {
    index = previousCodePointIndex(text, index);
  }
  return index === 0 ? text : text.slice(index);
}

/** 每个 UTF-16 下标对应的字节偏移；命中起点与终点都是 code point 边界。 */
function byteOffsets(text: string): Uint32Array {
  const offsets = new Uint32Array(text.length + 1);
  let bytes = 0;
  let index = 0;
  while (index < text.length) {
    offsets[index] = bytes;
    const code = text.codePointAt(index) as number;
    if (code < 0x80) { bytes += 1; index += 1; } else if (code < 0x800) { bytes += 2; index += 1; } else if (code < 0x10000) { bytes += 3; index += 1; } else { bytes += 4; offsets[index + 1] = bytes; index += 2; }
  }
  offsets[text.length] = bytes;
  return offsets;
}

function takePrefixBytes(text: string, bytes: number): string {
  if (bytes >= byteLengthOf(text)) return text;
  return decoder.decode(encoder.encode(text).subarray(0, bytes));
}

const historySource = (entryId: string): SearchableSource => ({ kind: 'history', entryId, contentRevision: 1 });
const argumentsSource = (call: HistoryCall): SearchableSource => ({
  kind: 'arguments', entryId: call.entryId, stepId: call.stepId, callId: call.callId, contentRevision: 1,
});
const isAfterCall = (call: HistoryCall, anchor: CallPosition): boolean =>
  call.sequence > anchor.sequence || (call.sequence === anchor.sequence && call.ordinal > anchor.ordinal);

/**
 * 命中所在调用的序号。正文来源没有这个概念；参数来源必须带它，否则同一 entry 里多个调用的命中
 * 只能按 callId 字典序比较，方向键的上一个/下一个就会跳错位置。
 */
function hitOrdinal(
  position: HistorySearchPosition & { readonly kind: 'body' },
): number | undefined {
  if (position.source.kind !== 'arguments') return undefined;
  if (position.afterCall === null) throw new HistorySearchError('arguments source lost its call position');
  return position.afterCall.ordinal;
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  const reason: unknown = signal.reason;
  throw reason instanceof Error ? reason : new DOMException('The transcript search was cancelled.', 'AbortError');
}

/** 让出事件循环，长历史搜索不独占线程，输入和取消仍能被处理。 */
const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

type ScanState = {
  readonly sessionId: string;
  readonly target: 'transcript' | 'users';
  readonly upperSequence: number;
  readonly pattern: RegExp;
  /** 跨块保留的 code point 数：字面量长度减一。 */
  readonly overlap: number;
  readonly signal: AbortSignal | undefined;
  readonly reading: TranscriptReadingPort;
  readonly inspection: HistoryInspectionReadingPort;
  readonly hits: HistorySearchHit[];
  bodyBytes: number;
  items: number;
  hitBytes: number;
  full: boolean;
};

const budgetReached = (state: ScanState): boolean =>
  state.hits.length >= SEARCH_MAX_HITS
  || state.full
  || state.bodyBytes >= SEARCH_BATCH_BODY_BYTES;

type BodyRead = { readonly text: string; readonly offset: number; readonly end: number };

/**
 * 读一段正文并归一到 `[offset, end)`。反向读（重叠）可能落在字符中间，向前挪一字节重试；
 * 已提交来源读不到时显式失败，不能把缺失当成没有匹配。
 */
async function readBody(
  state: ScanState,
  source: SearchableSource,
  offset: number,
  maxBytes: number,
  limit: number | null,
): Promise<BodyRead | null> {
  let start = offset;
  for (let attempt = 0; attempt <= 3; attempt += 1) {
    const span = limit === null ? maxBytes : limit - start;
    if (span < SEARCH_MIN_READ_BYTES) return null;
    let range: Awaited<ReturnType<TranscriptReadingPort['body']>>;
    try {
      range = await state.reading.body({ coordinatorSessionId: state.sessionId, source, offset: start, maxBytes: span });
    } catch (error) {
      if (!(error instanceof HistoryBoundaryError)) throw error;
      start += 1;
      continue;
    }
    // 取消发生在读取途中时，这次结果连同已读计量一起丢弃。
    throwIfCancelled(state.signal);
    if (range === null) {
      throw new HistorySearchError('authoritative history body is unavailable: ' + source.entryId);
    }
    if (range.end <= start) throw new HistorySearchError('history reading made no progress: ' + source.entryId);
    const end = limit === null ? range.end : Math.min(range.end, limit);
    return { text: takePrefixBytes(range.text, end - start), offset: start, end };
  }
  throw new HistorySearchError('history body offset is not a UTF-8 boundary: ' + source.entryId);
}

/** 扫描一个来源直到读完或本批预算用尽。返回非 null 表示还剩尾巴，游标从该偏移继续。 */
async function scanSource(
  state: ScanState,
  position: HistorySearchPosition & { readonly kind: 'body' },
): Promise<(HistorySearchPosition & { readonly kind: 'body' }) | null> {
  const source = position.source;
  const byteLength = position.byteLength;
  // 读到的偏移、已上报命中的水位和重叠尾巴在这里是同一个游标：命中上限先到时退回水位，
  // 块尾未扫的部分由下一批重读，因此既不漏也不重。
  let offset = position.offset;
  let emittedThrough = position.offset;
  let carry = '';
  if (offset > 0) {
    // 游标不携带正文尾巴：按 code point 宽度上限回读重叠区，保证跨块匹配不会漏掉续接部分。
    const back = Math.min(offset, state.overlap * 4);
    if (back >= SEARCH_MIN_READ_BYTES && state.bodyBytes + back <= SEARCH_BATCH_BODY_BYTES) {
      const probe = await readBody(state, source, offset - back, back, offset);
      if (probe !== null) {
        state.bodyBytes += probe.end - probe.offset;
        carry = tailCodePoints(probe.text, state.overlap);
      }
    }
  }
  while (offset < byteLength) {
    if (budgetReached(state)) break;
    const maxBytes = Math.min(HISTORY_CHUNK_BYTES, SEARCH_BATCH_BODY_BYTES - state.bodyBytes);
    if (maxBytes < SEARCH_MIN_READ_BYTES) break;
    const range = await readBody(state, source, offset, maxBytes, null);
    // Only an empty overlap probe can return null; forward reads have a positive budget.
    if (range === null) return null;
    state.bodyBytes += range.end - range.offset;
    if (range.end <= offset) throw new HistorySearchError('history reading made no progress: ' + source.entryId);
    const window = carry + range.text;
    const base = offset - byteLengthOf(carry);
    const offsets = byteOffsets(window);
    state.pattern.lastIndex = 0;
    let match = state.pattern.exec(window);
    while (match !== null) {
      const start = base + offsets[match.index]!;
      const end = base + offsets[match.index + match[0].length]!;
      // 完全落在已扫描范围内的命中在上一批已经上报过；跨过水位的这一次是新的。
      if (end > offset) {
        const ordinal = hitOrdinal(position);
        const hit = { source, sequence: position.sequence, offset: start, end,
          ...(ordinal === undefined ? {} : { ordinal }) };
        const size = byteLengthOf(JSON.stringify(hit)) + 1;
        if (size > SEARCH_RESULT_BYTES) throw new HistorySearchError('search hit exceeds response budget');
        if (state.hitBytes + size > SEARCH_RESULT_BYTES) { state.full = true; break; }
        state.hits.push(hit); state.hitBytes += size;
        emittedThrough = end;
      }
      if (state.hits.length >= SEARCH_MAX_HITS) break;
      match = state.pattern.exec(window);
    }
    carry = tailCodePoints(window, state.overlap);
    if (state.hits.length >= SEARCH_MAX_HITS || state.full) { offset = emittedThrough; break; }
    offset = range.end;
    await yieldToLoop();
  }
  if (offset >= byteLength) return null;
  position.offset = offset;
  return position;
}

async function fetchMetadata(state: ScanState, afterSequence: number): Promise<HistoryMetadataPage> {
  if (state.target === 'users') {
    return state.inspection.users({ coordinatorSessionId: state.sessionId, after: afterSequence,
      direction: 'newer', upperSequence: state.upperSequence });
  }
  return state.reading.history({ coordinatorSessionId: state.sessionId, after: afterSequence, direction: 'newer' });
}

function decodeCursor(cursor: string, query: HistorySearchQuery): { position: HistorySearchPosition; hasCalls?: boolean } {
  let payload: unknown;
  try { payload = JSON.parse(cursor) as unknown; } catch { throw new HistorySearchCursorError('search cursor is not readable'); }
  const parsed = (() => {
    try { return cursorSchema.parse(payload); } catch { throw new HistorySearchCursorError('search cursor is not readable'); }
  })();
  // 游标只对产生它的那一轮查询有效：换了 Session、target、字面量或固定上界都不是同一轮。
  if (parsed.session !== query.coordinatorSessionId) throw new HistorySearchCursorError('search cursor belongs to another Session');
  if (parsed.target !== query.target) throw new HistorySearchCursorError('search cursor belongs to another target');
  if (parsed.literal !== query.literal) throw new HistorySearchCursorError('search cursor belongs to another literal');
  if (parsed.upperSequence !== query.upperSequence) throw new HistorySearchCursorError('search cursor belongs to another upper bound');
  return { position: parsed.position, ...(parsed.hasCalls === undefined ? {} : { hasCalls: parsed.hasCalls }) };
}

function encodeCursor(query: HistorySearchQuery, position: HistorySearchPosition, hasCalls: boolean): string {
  const cursor = JSON.stringify({ v: 1, session: query.coordinatorSessionId, target: query.target,
    literal: query.literal, upperSequence: query.upperSequence, position, hasCalls });
  if (byteLengthOf(cursor) > SEARCH_CURSOR_MAX_BYTES) {
    throw new HistorySearchCursorError('search cursor exceeds the opaque size limit');
  }
  return cursor;
}

/**
 * 在当前 Session 的已提交历史里按字面量搜索一批。
 *
 * 空字面量是空闲查询：既不读端口也不需要索引就返回完成。索引未就绪时显式失败，因为此时任何
 * 「无匹配」都是编造的。被取消时抛出取消原因，迟到的读取结果不会变成命中。
 */
export async function scanHistory(
  reading: TranscriptReadingPort,
  query: HistorySearchQuery,
  signal?: AbortSignal,
): Promise<HistorySearchPage> {
  const parsed = historySearchQuerySchema.parse(query);
  if (parsed.literal.length === 0) {
    return { hits: [], cursor: null, complete: true, scannedBytes: 0, scannedItems: 0 };
  }
  const inspection = reading.inspection;
  if (inspection === undefined) throw new HistorySearchError('history inspection is unavailable');
  throwIfCancelled(signal);
  const snapshot = await inspection.snapshot(parsed.coordinatorSessionId);
  throwIfCancelled(signal);
  if (!snapshot.ready) throw new HistoryIndexNotReadyError('history inspection index is not ready');

  const state: ScanState = {
    sessionId: parsed.coordinatorSessionId,
    target: parsed.target,
    upperSequence: parsed.upperSequence,
    pattern: new RegExp(escapeRegExp(parsed.literal), 'giu'),
    overlap: Math.max(0, [...parsed.literal].length - 1),
    signal,
    reading,
    inspection,
    hits: [],
    bodyBytes: 0,
    items: 0,
    hitBytes: 2,
    full: false,
  };
  const resumed = parsed.cursor == null
    ? { position: { kind: 'metadata', afterSequence: 0 } as HistorySearchPosition }
    : decodeCursor(parsed.cursor, parsed);
  let position = resumed.position;
  let hasCalls = state.target === 'users' ? false : resumed.hasCalls;
  let complete = false;
  // 工作区只保留端口界限内的一页元数据（≤100 项 / 64 KiB）。
  let pending: { page: HistoryMetadataPage; index: number; afterSequence: number } | null = null;
  // A batch admits one bounded metadata page, including call pages. Charge returned
  // rows, not just visited entries; loading both pages could otherwise exceed 100.
  let metadataRead = false;

  // Prove once whether this fixed snapshot has any calls. A call-free Session can
  // consume its whole history page without stopping at every assistant message.
  if (hasCalls === undefined) {
    const page = await inspection.calls({ coordinatorSessionId: state.sessionId, upperSequence: state.upperSequence, direction: 'newer' });
    throwIfCancelled(state.signal);
    state.items = page.calls.length;
    if (state.items > SEARCH_BATCH_ITEMS) throw new HistorySearchError('call page exceeds metadata item budget');
    hasCalls = page.calls.length > 0;
    metadataRead = page.calls.length > 0;
  }

  while (!budgetReached(state)) {
    if (position.kind === 'body') {
      const resumed = await scanSource(state, position);
      if (resumed !== null) { position = resumed; break; }
      position = { kind: 'entry', entryId: position.entryId, sequence: position.sequence,
        role: position.role, afterCall: position.afterCall };
      continue;
    }
    if (position.kind === 'entry') {
      const entry = position;
      if (entry.afterCall === null && (!hasCalls || entry.role !== 'assistant')) {
        if (pending !== null) { pending.index += 1; pending.afterSequence = entry.sequence; }
        position = { kind: 'metadata', afterSequence: entry.sequence };
        continue;
      }
      if (metadataRead) break;
      const page = await inspection.calls({ coordinatorSessionId: state.sessionId, entryId: entry.entryId, upperSequence: state.upperSequence,
        direction: 'newer', ...(entry.afterCall === null ? {} : { after: entry.afterCall }) });
      throwIfCancelled(state.signal);
      metadataRead = true;
      state.items += page.calls.length;
      if (state.items > SEARCH_BATCH_ITEMS) throw new HistorySearchError('call page exceeds metadata item budget');
      const anchor = entry.afterCall;
      const call = anchor === null ? page.calls[0] : page.calls.find(item => isAfterCall(item, anchor));
      if (call === undefined) {
        if (pending !== null) { pending.index += 1; pending.afterSequence = entry.sequence; }
        position = { kind: 'metadata', afterSequence: entry.sequence };
        continue;
      }
      position = { kind: 'body', entryId: call.entryId, sequence: call.sequence, role: entry.role,
        source: argumentsSource(call), offset: 0, byteLength: call.argsByteLength,
        afterCall: { sequence: call.sequence, ordinal: call.ordinal } };
      continue;
    }
    if (pending === null) {
      if (metadataRead) break;
      pending = { page: await fetchMetadata(state, position.afterSequence), index: 0, afterSequence: position.afterSequence };
      metadataRead = true; state.items = pending.page.entries.length;
      if (state.items > SEARCH_BATCH_ITEMS) throw new HistorySearchError('history page exceeds metadata item budget');
    }
    throwIfCancelled(state.signal);
    let entry = pending.page.entries[pending.index];
    while (entry !== undefined && entry.sequence <= pending.afterSequence) {
      pending.index += 1;
      entry = pending.page.entries[pending.index];
    }
    if (entry === undefined) {
      if (!pending.page.hasMore) { complete = true; break; }
      pending = null;
      continue;
    }
    if (entry.sequence > state.upperSequence) { complete = true; break; }
    position = { kind: 'body', entryId: entry.entryId, sequence: entry.sequence, role: entry.role,
      source: historySource(entry.entryId), offset: 0, byteLength: entry.byteLength, afterCall: null };
  }

  return { hits: state.hits, cursor: complete ? null : encodeCursor(parsed, position, hasCalls), complete,
    scannedBytes: state.bodyBytes, scannedItems: state.items };
}
