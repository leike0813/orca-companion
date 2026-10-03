/** Local document reader: identities, ranges, Markdown, layout and cache share one owner. */
import { Lexer, type Token } from 'marked';
import {
  HISTORY_CHUNK_BYTES, HISTORY_BODY_BYTES, HistoryBoundaryError,
  type HistoryMetadata, type TranscriptBodyRange, type TranscriptPreview,
  type TranscriptReadingPort, type TranscriptSourceRef,
} from '../../../application/coordinator/history.js';
import type { ControllerTranscriptPage } from '../../../application/controller-service.js';
import type { TranscriptView } from '../../../application/tui/view-model.js';
import { displayWidth, truncateToDisplayWidth } from './width.js';

export const TRANSCRIPT_CACHE_BYTES = 8 * 1024 * 1024;
export const TRANSCRIPT_CACHE_ITEMS = 64;
type Style = 'plain' | 'strong' | 'emphasis' | 'code' | 'link' | 'heading' | 'deleted';
export type TranscriptSpan = { readonly text: string; readonly style: Style };
type Source = {
  readonly ref: TranscriptSourceRef; readonly sequence: number; readonly byteLength: number;
  readonly role: 'user' | 'assistant' | 'tool'; readonly name: string; readonly status?: TranscriptPreview['status'];
};
export type TranscriptAnchor = {
  readonly coordinatorSessionId: string; readonly source: TranscriptSourceRef;
  readonly sequence: number; readonly offset: number;
};
export type TranscriptLine = {
  readonly key: string; readonly id: string; readonly kind: 'user' | 'agent' | 'tool' | 'tool-detail' | 'gap' | 'status';
  readonly first: boolean; readonly text: string; readonly spans: readonly TranscriptSpan[];
  readonly anchor: TranscriptAnchor; readonly end: number;
};
export type TranscriptFrame = {
  readonly coordinatorSessionId: string; readonly lines: readonly TranscriptLine[];
  readonly anchor: TranscriptAnchor | null; readonly atLatest: boolean; readonly width: number;
  readonly page: ControllerTranscriptPage;
};
type PaintedSpan = TranscriptSpan & { start: number; end: number; contentStart: number };
type LocalLine = { text: string; spans: TranscriptSpan[]; start: number; end: number; first: boolean };

class Cache<T> {
  private readonly budget: number;
  private readonly itemLimit: number;
  constructor(budget = TRANSCRIPT_CACHE_BYTES, itemLimit = TRANSCRIPT_CACHE_ITEMS) { this.budget = budget; this.itemLimit = itemLimit; }
  private readonly items = new Map<string, { value: T; bytes: number }>();
  private pinned = new Set<string>();
  bytes = 0;
  get(key: string): T | undefined {
    const item = this.items.get(key); if (item === undefined) return undefined;
    this.items.delete(key); this.items.set(key, item); return item.value;
  }
  set(key: string, value: T, bytes: number): void {
    bytes += key.length * 2 + 256;
    if (bytes > this.budget) return;
    const old = this.items.get(key); if (old !== undefined) { this.bytes -= old.bytes; this.items.delete(key); }
    while (this.items.size >= this.itemLimit || this.bytes + bytes > this.budget) {
      const target = [...this.items.keys()].find(id => !this.pinned.has(id));
      if (target === undefined) return;
      this.bytes -= this.items.get(target)!.bytes; this.items.delete(target);
    }
    this.items.set(key, { value, bytes }); this.bytes += bytes;
  }
  pin(keys: Set<string>): void { this.pinned = keys; }
  clear(): void { this.items.clear(); this.pinned.clear(); this.bytes = 0; }
  get size(): number { return this.items.size; }
}
const utf8Length = (text: string): number => Buffer.byteLength(text, 'utf8');
const idOf = (source: TranscriptSourceRef): string => source.kind === 'history' ? source.entryId : source.previewId;
const sourceKey = (source: TranscriptSourceRef): string => `${source.kind}:${idOf(source)}`;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function rawSpan(text: string, offset: number, style: Style = 'plain'): PaintedSpan {
  return { text, start: offset, end: offset + utf8Length(text), contentStart: offset, style };
}

/** Marked owns syntax; source positions are derived only inside this finite raw block. */
function inlineSpans(tokens: readonly Token[], offset: number, style: Style = 'plain', depth = 0): PaintedSpan[] {
  const spans: PaintedSpan[] = [];
  for (const token of tokens) {
    const raw = token.raw, end = offset + utf8Length(raw);
    if (depth > 16) { spans.push(rawSpan(raw, offset, style)); offset = end; continue; }
    if ('tokens' in token && Array.isArray(token.tokens) && ['strong', 'em', 'del', 'link'].includes(token.type)) {
      const inset = token.type === 'strong' || token.type === 'del' ? 2 : 1;
      const childStyle: Style = token.type === 'strong' ? 'strong' : token.type === 'em' ? 'emphasis' : token.type === 'del' ? 'deleted' : 'link';
      const nested = inlineSpans(token.tokens, offset + utf8Length(raw.slice(0, inset)), childStyle, depth + 1);
      if (nested.length > 0) {
        nested[0] = { ...nested[0]!, start: offset };
        nested[nested.length - 1] = { ...nested.at(-1)!, end };
      }
      spans.push(...nested);
    } else if (token.type === 'codespan' && 'text' in token && typeof token.text === 'string') {
      const inset = raw.indexOf(token.text);
      spans.push(inset < 0 ? rawSpan(raw, offset, 'code') : { text: token.text, start: offset, end,
        contentStart: offset + utf8Length(raw.slice(0, inset)), style: 'code' });
    } else if (token.type === 'br') {
      spans.push({ text: '\n', start: offset, end, style, contentStart: offset });
    } else {
      spans.push(rawSpan(raw, offset, style));
    }
    offset = end;
  }
  return spans;
}

function markdownSpans(text: string, offset: number, known: boolean, fence: string | null): PaintedSpan[] {
  if (fence !== null) {
    const closing = new RegExp('^ {0,3}' + fence[0]! + '{' + String(fence.length) + ',}[\\t ]*(?:\\r?\\n|$)', 'mu').exec(text);
    if (closing === null) return [rawSpan(text, offset, 'code')];
    const boundary = closing.index + closing[0].length, prefix = text.slice(0, boundary);
    return [rawSpan(prefix, offset, 'code'), ...markdownSpans(text.slice(boundary), offset + utf8Length(prefix), true, null)];
  }
  if (!known || utf8Length(text) > HISTORY_BODY_BYTES) return [rawSpan(text, offset)];
  try {
    const tokens = Lexer.lex(text);
    const spans: PaintedSpan[] = [];
    let position = offset;
    for (const token of tokens) {
      const raw = token.raw, end = position + utf8Length(raw);
      if (token.type === 'heading') {
        const prefix = raw.match(/^ {0,3}#{1,6}[\t ]+/u)?.[0] ?? '';
        const content = inlineSpans(token.tokens ?? [], position + utf8Length(prefix), 'heading');
        if (content[0] !== undefined) content[0] = { ...content[0], start: position };
        if (raw.endsWith('\n')) spans.push(...content, rawSpan('\n', end - 1));
        else { if (content.length > 0) content[content.length - 1] = { ...content.at(-1)!, end }; spans.push(...content); }
      } else if ((token.type === 'paragraph' || token.type === 'text') && 'tokens' in token && token.tokens !== undefined) {
        spans.push(...inlineSpans(token.tokens, position));
        const consumed = token.tokens.map(item => item.raw).join('');
        if (raw.length > consumed.length) spans.push(rawSpan(raw.slice(consumed.length), position + utf8Length(consumed)));
      } else if (token.type === 'code') {
        // Preserve code delimiters as readable source; terminal code has no separate font.
        spans.push(rawSpan(raw, position, 'code'));
      } else {
        // Lists, tables, HTML and definitions retain their complete source structure.
        spans.push(rawSpan(raw, position));
      }
      position = end;
    }
    return spans;
  } catch {
    return [rawSpan(text, offset)];
  }
}

/** Only keep the requested local rows; never build a whole-message row array. */
function layout(spans: readonly PaintedSpan[], width: number, count: number, offset: number, direction: 'start' | 'end'): LocalLine[] {
  const lines: LocalLine[] = [];
  let parts: TranscriptSpan[] = [], text = '', columns = 0, start = offset, end = offset;
  let stopped = false;
  const push = () => {
    lines.push({ text, spans: parts, start, end, first: start === 0 });
    if (direction === 'end' && lines.length > count) lines.shift();
    if (direction === 'start' && lines.length >= count) stopped = true;
    parts = []; text = ''; columns = 0; start = end;
  };
  for (const span of spans) {
    if (direction === 'start' && span.end <= offset) continue;
    if (direction === 'end' && span.start >= offset) break;
    let rawPosition = span.contentStart;
    const graphemes = segmenter.segment(span.text);
    for (const part of graphemes) {
      const next = part.index + part.segment.length === span.text.length ? span.end : rawPosition + utf8Length(part.segment);
      if (direction === 'start' && next <= offset) { rawPosition = next; continue; }
      if (direction === 'end' && rawPosition >= offset) { stopped = true; break; }
      if (text.length === 0) start = Math.max(part.index === 0 ? span.start : rawPosition, direction === 'start' ? offset : 0);
      if (part.segment === '\n' || part.segment === '\r\n') {
        end = next; push(); rawPosition = next;
        if (stopped) break; continue;
      }
      const size = displayWidth(part.segment);
      if (columns + size > width && text.length > 0) {
        push(); if (stopped) break; start = rawPosition;
      }
      const previous = parts.at(-1);
      if (previous?.style === span.style) parts[parts.length - 1] = { text: previous.text + part.segment, style: span.style };
      else parts.push({ text: part.segment, style: span.style });
      text += part.segment; columns += size; end = next; rawPosition = next;
    }
    if (stopped) break;
  }
  if (text.length > 0 && (!stopped || direction === 'end') || !stopped && lines.length === 0) push();
  return lines;
}

class StaleRead extends Error {}
class ReadBudget extends Error {}
type Context = { fence: string | null };

export class TranscriptReader {
  private session = '';
  private generation = 0;
  private width = 80;
  private height = 12;
  private expanded: readonly string[] = [];
  private sources: Source[] = [];
  private previews: readonly TranscriptPreview[] = [];
  private currentSources = new Map<string, Source>();
  private following = true;
  private current: TranscriptFrame | null = null;
  private readonly bodies = new Cache<TranscriptBodyRange>();
  private readonly layouts = new Cache<LocalLine[]>(TRANSCRIPT_CACHE_BYTES - 512 * 1024, TRANSCRIPT_CACHE_ITEMS - 16);
  private readonly contexts = new Map<string, Context>();
  private previewPins = new Map<string, () => void>();
  private readBytes = 0;
  private layoutRows = 0;
  private readonly port: TranscriptReadingPort;
  constructor(port: TranscriptReadingPort) { this.port = port; }
  get frame(): TranscriptFrame | null { return this.current; }
  get atLatest(): boolean { return this.following; }
  stats() { return { bodyBytes: this.bodies.bytes, bodyItems: this.bodies.size,
    layoutBytes: this.layouts.bytes + [...this.contexts].reduce((n, [key]) => n + key.length * 2 + 256, 0), layoutItems: this.layouts.size + this.contexts.size, lastReadBytes: this.readBytes,
    lastLayoutRows: this.layoutRows, metadataItems: this.sources.length }; }
  dispose(): void {
    this.generation += 1; this.bodies.clear(); this.layouts.clear(); this.contexts.clear(); this.currentSources.clear();
    for (const release of this.previewPins.values()) release(); this.previewPins.clear();
  }
  private check(request: number): void { if (request !== this.generation) throw new StaleRead(); }
  private async metadata(direction: 'older' | 'newer', sequence: number | undefined, request: number): Promise<Source[]> {
    const [page, previews] = await Promise.all([
      this.port.history({ coordinatorSessionId: this.session, direction,
        ...(sequence === undefined ? {} : direction === 'older' ? { before: sequence } : { after: sequence }) }),
      this.port.previews(this.session),
    ]);
    this.check(request); this.previews = previews;
    const histories = page.entries.filter((entry): entry is HistoryMetadata & { role: Source['role'] } =>
      entry.role === 'user' || entry.role === 'assistant' || entry.role === 'tool').map((entry): Source => ({
        ref: { kind: 'history', entryId: entry.entryId, contentRevision: 1 }, sequence: entry.sequence,
        byteLength: entry.byteLength, role: entry.role, name: entry.toolName ?? 'tool',
      }));
    const from = histories[0]?.sequence ?? 0;
    const to = histories.at(-1)?.sequence ?? Infinity;
    const temporary = previews.filter(p => (p.status !== 'committed' || !this.following && this.currentSources.has(`preview:${p.previewId}`)) && p.afterSequence >= from - 1 && p.afterSequence <= to)
      .map((preview): Source => !this.following && this.currentSources.has(`preview:${preview.previewId}`)
        ? this.currentSources.get(`preview:${preview.previewId}`)!
        : { ref: { kind: 'preview', previewId: preview.previewId, contentRevision: preview.contentRevision },
          sequence: preview.afterSequence, byteLength: preview.byteLength, role: 'assistant', name: '', status: preview.status });
    this.sources = [...histories, ...temporary].sort((a, b) => a.sequence - b.sequence ||
      (a.ref.kind === 'history' ? -1 : b.ref.kind === 'history' ? 1 : 0));
    return this.sources;
  }
  private anchor(source: Source, offset: number): TranscriptAnchor {
    return { coordinatorSessionId: this.session, source: source.ref, sequence: source.sequence, offset };
  }
  private line(source: Source, item: LocalLine, kind: TranscriptLine['kind']): TranscriptLine {
    return { ...item, key: `${sourceKey(source.ref)}:${source.ref.contentRevision}:${item.start}:${kind}`,
      id: idOf(source.ref), kind, anchor: this.anchor(source, item.start) };
  }
  private async range(source: Source, block: number, request: number, keys: Set<string>): Promise<TranscriptBodyRange> {
    const immutable = source.ref.kind === 'history' || block + HISTORY_CHUNK_BYTES + 8 <= source.byteLength;
    const key = `${this.session}:${sourceKey(source.ref)}:${block}:${immutable ? 'fixed' : source.ref.contentRevision}`;
    keys.add(key);
    const cached = this.bodies.get(key);
    if (cached !== undefined) return { ...cached, source: source.ref, byteLength: source.byteLength };
    let range: TranscriptBodyRange | null = null;
    const maxBytes = Math.min(HISTORY_CHUNK_BYTES + 8, HISTORY_BODY_BYTES - this.readBytes);
    if (maxBytes < 4) throw new ReadBudget();
    for (let position = Math.max(0, block - 4); position <= block; position += 1) {
      try {
        range = await this.port.body({ coordinatorSessionId: this.session, source: source.ref,
          offset: position, maxBytes });
        this.check(request); break;
      } catch (error) { this.check(request); if (!(error instanceof HistoryBoundaryError)) throw error; }
    }
    if (range === null) throw new Error('原文范围不可用');
    this.readBytes += utf8Length(range.text);
    this.bodies.set(key, range, range.text.length * 2 + 256);
    return range;
  }
  private captureContext(source: Source, range: TranscriptBodyRange, block: number): void {
    const prefix = `${this.session}:${sourceKey(source.ref)}`;
    const known = block === 0 ? { fence: null } : this.contexts.get(`${prefix}:${block}`);
    if (known === undefined || range.end < block + HISTORY_CHUNK_BYTES) return;
    let fence = known.fence;
    const bounded = Buffer.from(range.text).subarray(Math.max(0, block - range.offset), block + HISTORY_CHUNK_BYTES - range.offset).toString('utf8');
    for (const line of bounded.split('\n')) {
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
      if (marker === null) continue;
      if (fence === null) fence = marker[1]!;
      else if (marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && marker[2]!.trim() === '') fence = null;
    }
    this.contexts.set(`${prefix}:${block + HISTORY_CHUNK_BYTES}`, { fence });
    while (this.contexts.size > 16 ||
      [...this.contexts].reduce((n, [key]) => n + key.length * 2 + 256, 0) > 512 * 1024) this.contexts.delete(this.contexts.keys().next().value!);
  }
  private async localLines(source: Source, offset: number, direction: 'start' | 'end', count: number,
    request: number, bodyKeys: Set<string>, layoutKeys: Set<string>): Promise<LocalLine[]> {
    const block = Math.floor(Math.max(0, direction === 'end' ? offset - 1 : offset) / HISTORY_CHUNK_BYTES) * HISTORY_CHUNK_BYTES;
    const prefix = `${this.session}:${sourceKey(source.ref)}`;
    if (block > 0 && !this.contexts.has(`${prefix}:${block}`) &&
      (block === HISTORY_CHUNK_BYTES || this.contexts.has(`${prefix}:${block - HISTORY_CHUNK_BYTES}`))) {
      const previous = await this.range(source, block - HISTORY_CHUNK_BYTES, request, bodyKeys);
      this.captureContext(source, previous, block - HISTORY_CHUNK_BYTES);
    }
    const range = await this.range(source, block, request, bodyKeys);
    this.captureContext(source, range, block);
    const immutable = source.ref.kind === 'history' || block + HISTORY_CHUNK_BYTES + 8 <= source.byteLength;
    const key = `${prefix}:${immutable ? 'fixed' : source.ref.contentRevision}:${range.offset}:${offset}:${this.width}:${direction}:${count}`;
    layoutKeys.add(key);
    const cached = this.layouts.get(key); if (cached !== undefined) return cached;
    const context = block === 0 ? { fence: null } : this.contexts.get(`${prefix}:${block}`);
    let text = range.text;
    // A look-ahead grapheme remains for the next range, so combining sequences are not split.
    if (range.end < source.byteLength) {
      let final = 0; for (const part of segmenter.segment(text)) final = part.index;
      text = text.slice(0, final);
    }
    const spans = source.role === 'assistant'
      ? markdownSpans(text, range.offset, context !== undefined && range.offset === block, context?.fence ?? null)
      : [rawSpan(text, range.offset)];
    const width = Math.max(1, this.width - (source.role === 'user' || source.role === 'tool' ? 4 : 2));
    const rows = layout(spans, width, count, offset, direction);
    this.layoutRows += rows.length;
    this.layouts.set(key, rows, rows.reduce((n, row) => n + row.text.length * 2 +
      row.spans.reduce((sum, span) => sum + span.text.length * 2 + 64, 0) + 160, 0));
    return rows;
  }
  private async neighbor(source: Source, direction: 'older' | 'newer', request: number): Promise<Source | null> {
    const index = this.sources.findIndex(item => sourceKey(item.ref) === sourceKey(source.ref));
    const adjacent = index < 0 ? undefined : this.sources[index + (direction === 'older' ? -1 : 1)];
    if (adjacent !== undefined) return adjacent;
    const sequence = direction === 'older' && source.ref.kind === 'preview' ? source.sequence + 1 : source.sequence;
    const page = await this.metadata(direction, sequence, request);
    const eligible = page.filter(item => sourceKey(item.ref) !== sourceKey(source.ref) &&
      (direction === 'older' ? item.sequence < sequence : item.sequence > sequence));
    return (direction === 'older' ? eligible.at(-1) : eligible[0]) ?? null;
  }
  private page(lines: readonly TranscriptLine[], sources: ReadonlyMap<string, Source>): ControllerTranscriptPage {
    const seen = new Map<string, typeof lines[number]>();
    for (const line of lines) if (line.kind !== 'gap' && line.kind !== 'status') seen.set(line.id, line);
    return { coordinatorSessionId: this.session, nextCursor: null, messages: [...seen.values()].map(line => ({
      role: line.kind === 'user' ? 'user' : line.kind === 'tool' || line.kind === 'tool-detail' ? 'tool' : 'assistant',
      entryId: line.id, stepId: line.id, content: line.kind === 'tool' || line.kind === 'tool-detail'
        ? `${sources.get(sourceKey(line.anchor.source))?.name ?? 'tool'}\n${line.kind === 'tool-detail' ? line.text : ''}` : line.text,
    })) };
  }
  private async collect(source: Source | null, offset: number, direction: 'start' | 'end', request: number): Promise<TranscriptFrame> {
    const lines: TranscriptLine[] = [], bodyKeys = new Set<string>(), layoutKeys = new Set<string>();
    const nextPins = new Map<string, () => void>();
    const nextSources = new Map<string, Source>();
    const count = this.height * 3;
    let current = source, position = offset, previousRole: Source['role'] | null = null;
    try {
      for (let work = 0; current !== null && lines.length < count && work < 64 && this.readBytes <= HISTORY_BODY_BYTES; work += 1) {
        this.check(request);
        const id = idOf(current.ref);
        nextSources.set(sourceKey(current.ref), current);
        if (current.ref.kind === 'preview' && !nextPins.has(id)) nextPins.set(id,
          this.previewPins.get(id) ?? this.port.pin(this.session, id));
        let rows: TranscriptLine[] = [];
        const collapsed = current.role === 'tool' && !this.expanded.includes(id);
        if (collapsed) {
          rows = [this.line(current, { text: truncateToDisplayWidth(`▸ tool ${current.name}`, Math.max(1, this.width - 2)),
            spans: [], start: 0, end: current.byteLength, first: true }, 'tool')];
        } else {
          let local: LocalLine[];
          try { local = await this.localLines(current, position, direction, count - lines.length, request, bodyKeys, layoutKeys); }
          catch (error) { if (error instanceof ReadBudget) break; throw error; }
          rows = local.map(row => this.line(current!, row, current!.role === 'user' ? 'user' : current!.role === 'tool' ? 'tool-detail' : 'agent'));
          if (current.role === 'tool' && (direction === 'start' ? position === 0 : rows[0]?.anchor.offset === 0)) rows.unshift(this.line(current,
            { text: truncateToDisplayWidth(`▾ tool ${current.name}`, Math.max(1, this.width - 2)), spans: [], start: 0, end: 0, first: true }, 'tool'));
          if (current.ref.kind === 'preview' && current.status !== 'streaming' &&
            (direction === 'end' ? position === current.byteLength : (rows.at(-1)?.end ?? 0) >= current.byteLength)) {
            rows.push(this.line(current, { text: current.status === 'not_saved' ? '流式预览不可用 · 等待完整响应' : '预览中断 · 未提交',
              spans: [], start: current.byteLength, end: current.byteLength, first: false }, 'status'));
          }
        }
        if (previousRole !== null && (direction === 'start' ? current.role : previousRole) !== 'tool' &&
          (collapsed || (direction === 'start' ? position === 0 : position === current.byteLength))) {
          const gap = this.line(current, { text: '', spans: [], start: position, end: position, first: false }, 'gap');
          if (direction === 'start') rows.unshift(gap); else rows.push(gap);
        }
        if (direction === 'start') lines.push(...rows); else lines.unshift(...rows);
        if (lines.length >= count) break;
        const next = direction === 'start' ? rows.filter(row => row.kind !== 'status').at(-1)?.end : rows[0]?.anchor.offset;
        if (!collapsed && next !== undefined && (direction === 'start' ? next > position && next < current.byteLength : next > 0 && next < position)) {
          position = next;
        } else {
          previousRole = current.role;
          current = await this.neighbor(current, direction === 'start' ? 'newer' : 'older', request);
          position = current === null ? 0 : direction === 'start' ? 0 : current.byteLength;
        }
        if (work % 8 === 7) await new Promise<void>(resolve => setImmediate(resolve));
      }
      this.check(request);
      const visible = direction === 'start' ? lines.slice(0, this.height) : lines.slice(-this.height);
      const anchor = visible.find(line => line.kind !== 'gap')?.anchor ?? null;
      const frame: TranscriptFrame = { coordinatorSessionId: this.session, lines: visible, anchor,
        atLatest: this.following, width: this.width, page: this.page(visible, nextSources) };
      this.current = frame; this.bodies.pin(bodyKeys); this.layouts.pin(layoutKeys);
      this.currentSources = nextSources;
      for (const [id, release] of this.previewPins) if (!nextPins.has(id)) release();
      this.previewPins = nextPins;
      return frame;
    } catch (error) {
      for (const [id, release] of nextPins) if (!this.previewPins.has(id)) release();
      throw error;
    }
  }
  private sourceAt(anchor: TranscriptAnchor): Source | undefined {
    const frozen = this.currentSources.get(sourceKey(anchor.source));
    if (!this.following && frozen?.ref.contentRevision === anchor.source.contentRevision) return frozen;
    const exact = this.sources.find(item => sourceKey(item.ref) === sourceKey(anchor.source));
    if (exact !== undefined && anchor.source.kind === 'history') return exact;
    if (anchor.source.kind === 'preview') {
      const preview = this.previews.find(item => item.previewId === idOf(anchor.source));
      if (preview !== undefined) return { ref: anchor.source, sequence: anchor.sequence,
        byteLength: anchor.source.contentRevision - 1, role: 'assistant', name: '', status: preview.status };
    }
    return undefined;
  }
  async open(session: string, width: number, height: number, expanded: readonly string[], anchor: TranscriptAnchor | null = null): Promise<TranscriptFrame | null> {
    if (this.session !== session) { this.dispose(); this.session = session; this.current = null; this.sources = []; this.previews = []; }
    this.width = Math.max(1, width); this.height = Math.max(1, height); this.expanded = expanded;
    this.following = anchor === null;
    return this.read(anchor === null ? 'latest' : 'anchor', anchor);
  }
  async resize(width: number, height: number, expanded: readonly string[]): Promise<TranscriptFrame | null> {
    if (width === this.width && height === this.height && expanded.join('\0') === this.expanded.join('\0')) return this.current;
    this.width = Math.max(1, width); this.height = Math.max(1, height); this.expanded = expanded;
    return this.read(this.following ? 'latest' : 'anchor', this.current?.anchor ?? null);
  }
  async read(mode: 'latest' | 'oldest' | 'anchor', anchor: TranscriptAnchor | null = null): Promise<TranscriptFrame | null> {
    const request = ++this.generation; this.readBytes = 0; this.layoutRows = 0;
    const before = this.following;
    this.following = mode === 'latest';
    try {
      const sources = await this.metadata(mode === 'oldest' ? 'newer' : 'older',
        mode === 'anchor' && anchor !== null ? anchor.sequence + 1 : undefined, request);
      const source = mode === 'anchor' && anchor !== null ? this.sourceAt(anchor)
        : mode === 'oldest' ? sources[0] : sources.at(-1);
      if (mode === 'anchor' && source === undefined) throw new Error('原阅读来源不可用');
      return await this.collect(source ?? null, mode === 'anchor' && anchor !== null ? anchor.offset
        : mode === 'oldest' ? 0 : source?.byteLength ?? 0, mode === 'latest' ? 'end' : 'start', request);
    } catch (error) { if (error instanceof StaleRead) return null; this.following = before; throw error; }
  }
  async move(direction: 'older' | 'newer'): Promise<TranscriptFrame | null> {
    if (this.current === null) return this.read('latest');
    const visible = this.current.lines.filter(line => line.kind !== 'gap' && line.kind !== 'status');
    const edge = direction === 'older' ? visible[0] : visible.at(-1);
    if (edge === undefined) return this.current;
    const wasFollowing = this.following;
    this.following = false;
    const request = ++this.generation; this.readBytes = 0; this.layoutRows = 0;
    try {
      let source = this.sourceAt(edge.anchor);
      if (source === undefined) {
        await this.metadata('older', edge.anchor.sequence + 1, request); source = this.sourceAt(edge.anchor);
      }
      if (source === undefined) throw new Error('原阅读来源不可用');
      let offset = direction === 'older' ? edge.anchor.offset : edge.end;
      if (offset === 0 && direction === 'older' || offset >= source.byteLength && direction === 'newer') {
        const adjacent = await this.neighbor(source, direction, request);
        if (adjacent === null) {
          if (direction === 'newer') return this.read('latest');
          this.current = { ...this.current, atLatest: false };
          return this.current;
        }
        source = adjacent; offset = direction === 'older' ? source.byteLength : 0;
      }
      return await this.collect(source, offset, direction === 'older' ? 'end' : 'start', request);
    } catch (error) { if (error instanceof StaleRead) return null; this.following = wasFollowing; throw error; }
  }
}

/** Standalone presentation fixtures use the same finite layout, without a second renderer. */
export function staticTranscriptLines(transcript: TranscriptView, expanded: readonly string[], width: number, height: number): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const entry of [...transcript.entries].reverse()) {
    if (lines.length >= height * 3) break;
    const text = entry.kind === 'tool' ? entry.detail : entry.text;
    const source: TranscriptSourceRef = { kind: 'history', entryId: entry.id, contentRevision: 1 };
    const anchor = { coordinatorSessionId: transcript.coordinatorSessionId ?? '', source, sequence: 0, offset: 0 };
    const add = (item: LocalLine, kind: TranscriptLine['kind']): TranscriptLine => ({ ...item, kind, id: entry.id,
      key: `${entry.id}:${item.start}:${kind}`, anchor: { ...anchor, offset: item.start } });
    const collapsed = entry.kind === 'tool' && !expanded.includes(entry.id);
    const rows = collapsed ? [] : layout(markdownSpans(text.slice(-HISTORY_CHUNK_BYTES), 0, text.length <= HISTORY_CHUNK_BYTES && entry.kind === 'agent', null),
      Math.max(1, width - (entry.kind === 'agent' ? 2 : 4)), height * 3 - lines.length, utf8Length(text), 'end')
      .map(row => add(row, entry.kind === 'tool' ? 'tool-detail' : entry.kind));
    if (entry.kind === 'tool') rows.unshift(add({ text: truncateToDisplayWidth(`${collapsed ? '▸' : '▾'} tool ${entry.name}`, Math.max(1, width - 2)),
      spans: [], start: 0, end: utf8Length(text), first: true }, 'tool'));
    if (lines.length > 0 && lines[0]?.kind !== 'tool') rows.push(add({ text: '', spans: [], start: 0, end: 0, first: false }, 'gap'));
    lines.unshift(...rows);
  }
  const end = Math.max(0, lines.length - transcript.scrollOffset);
  return lines.slice(Math.max(0, end - height), end);
}
