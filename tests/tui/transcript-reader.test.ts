import { afterEach, describe, expect, it } from 'vitest';
import { openCheckpointStore } from '../../src/adapters/storage/checkpoint-store.js';
import { createTranscriptPreviewStore } from '../../src/adapters/storage/transcript-preview-store.js';
import { TranscriptReader, TRANSCRIPT_CACHE_BYTES, TRANSCRIPT_CACHE_ITEMS } from '../../src/interfaces/tui/render/transcript-reader.js';
import type { TranscriptReadingPort, TranscriptBodyQuery } from '../../src/application/coordinator/history.js';
import type { CommittedMessageEntry } from '../../src/domain/coordinator/session-state.js';
import type { CoordinatorSessionId } from '../../src/application/dto/identity.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
function fixture(messages: readonly CommittedMessageEntry[], session = 'reader') {
  const opened = openCheckpointStore({ databasePath: ':memory:' });
  if (opened.kind !== 'opened') throw new Error(opened.message);
  const store = opened.store, previews = createTranscriptPreviewStore();
  const saved = store.saveCheckpoint({ schemaVersion: 2, coordinatorSessionId: session as CoordinatorSessionId, graphPosition: 'suspend',
    committedMessages: messages, committedModelSteps: [], wakeBatches: [], lastCompactionOutcome: null });
  if (saved.kind !== 'saved') throw new Error(saved.message);
  const reads: TranscriptBodyQuery[] = [];
  const port: TranscriptReadingPort = {
    history: query => Promise.resolve(store.readHistoryPage(query)),
    body: query => Promise.resolve().then(() => {
      reads.push(query);
      if (query.source.kind === 'preview') return previews.body(query);
      const range = store.readHistoryBody({ coordinatorSessionId: query.coordinatorSessionId, offset: query.offset,
        maxBytes: query.maxBytes, entryId: query.source.entryId, contentRevision: 1 });
      return range === null ? null : { source: query.source, offset: range.offset, end: range.end, byteLength: range.byteLength, text: range.text };
    }), previews: id => Promise.resolve(previews.list(id)), pin: previews.pin, subscribe: previews.subscribe,
  };
  const reader = new TranscriptReader(port);
  cleanup.push(() => { reader.dispose(); previews.close(); store.close(); });
  return { reader, store, previews, reads, port, session };
}
const message = (id: string, content: string, role: CommittedMessageEntry['role'] = 'assistant'): CommittedMessageEntry =>
  ({ entryId: id, stepId: id, role, content, ...(role === 'tool' ? { toolCallId: id, toolName: 'read' } : {}) });

describe('bounded source reader', () => {
  it('navigates real keysets and omits collapsed tool bodies', async () => {
    const f = fixture(Array.from({ length: 320 }, (_, n) => message(`entry-${n}`, n === 319 ? 'result'.repeat(100000) : `record ${n}`, n === 319 ? 'tool' : 'assistant')));
    const latest = await f.reader.open(f.session, 76, 8, []);
    expect(latest?.lines.some(line => line.id === 'entry-319' && line.kind === 'tool')).toBe(true);
    expect(f.reads.some(query => query.source.kind === 'history' && query.source.entryId === 'entry-319')).toBe(false);
    const oldest = await f.reader.read('oldest');
    expect(oldest?.anchor?.source).toEqual({ kind: 'history', entryId: 'entry-0', contentRevision: 1 });
    const newer = await f.reader.move('newer');
    expect(newer?.anchor?.sequence).toBeGreaterThan(oldest!.anchor!.sequence);
    expect(f.reader.stats().metadataItems).toBeLessThanOrEqual(100);
    expect(f.reads.every(query => query.maxBytes <= 65536)).toBe(true);
  });
  it('uses UTF-8 source anchors inside a large CJK response and preserves them on resize', async () => {
    const f = fixture([message('large', '中文🙂é abc\n'.repeat(100000))]);
    const latest = await f.reader.open(f.session, 76, 10, []);
    expect(latest!.anchor!.offset).toBeGreaterThan(100000);
    const older = await f.reader.move('older');
    expect(older!.anchor!.offset).toBeLessThan(latest!.anchor!.offset);
    const offset = older!.anchor!.offset;
    const resized = await f.reader.resize(40, 10, []);
    expect(resized!.anchor!.offset).toBe(offset);
    expect(resized!.lines.every(line => !line.text.includes('�'))).toBe(true);
    expect(f.reader.stats().lastLayoutRows).toBeLessThanOrEqual(30);
    expect(f.reader.stats().lastReadBytes).toBeLessThanOrEqual(65536);
  });
  it('renders finite Markdown while cold giant blocks retain readable source', async () => {
    const f = fixture([message('md', '# 中文标题\n\n**strong** *emphasis* `code` [link](https://example.com)\n\n```ts\nconst n = 1;\n```')]);
    const frame = await f.reader.open(f.session, 76, 24, []);
    const styles = frame!.lines.flatMap(line => line.spans.map(span => span.style));
    for (const style of ['heading', 'strong', 'emphasis', 'code', 'link']) expect(styles).toContain(style);
    const huge = fixture([message('raw', '界'.repeat(100000) + '**unfinished')]);
    const tail = await huge.reader.open(huge.session, 76, 10, []);
    expect(tail!.lines.map(line => line.text).join('')).toContain('**unfinished');
  });
  it('carries a known fence across ranges and resumes Markdown after its actual closing line', async () => {
    const f = fixture([message('code', '```ts\n' + 'x'.repeat(16384) + '\n**literal**\n```\n\n**outside**')]);
    const frame = await f.reader.open(f.session, 76, 8, []);
    const spans = frame!.lines.flatMap(line => line.spans);
    expect(spans.some(span => span.style === 'code' && span.text.includes('**literal**'))).toBe(true);
    expect(spans.some(span => span.style === 'strong' && span.text.includes('outside'))).toBe(true);
    expect(f.reader.stats().lastReadBytes).toBeLessThanOrEqual(65536);
  });
  it.each(['| a | b |\n| - | - |\n| 中文 | **cell** |\n', '- 中文 **item**\n'])('giant structures remain finite readable source', async structure => {
    const f = fixture([message('structure', structure.repeat(5000))]);
    const frame = await f.reader.open(f.session, 76, 8, []);
    expect(frame!.lines.map(line => line.text).join('')).toContain('**');
    expect(f.reader.stats().lastReadBytes).toBeLessThanOrEqual(65536);
    expect(f.reader.stats().lastLayoutRows).toBeLessThanOrEqual(24);
  });
  it('freezes the preview prefix while reading and only follows commit on explicit latest', async () => {
    const f = fixture([message('before', 'before')]);
    const event = { coordinatorSessionId: f.session, previewId: 'stream-1' };
    f.previews.observe({ ...event, kind: 'started' }, 1);
    f.previews.observe({ ...event, kind: 'delta', text: 'prefix\n'.repeat(100) });
    const latest = await f.reader.open(f.session, 76, 6, []);
    expect(latest!.anchor!.source.kind).toBe('preview');
    const pinned = await f.reader.move('older');
    const revision = pinned!.anchor!.source.contentRevision;
    f.previews.observe({ ...event, kind: 'delta', text: 'new tail' });
    f.store.appendMessage(f.session as CoordinatorSessionId, message('accepted', 'prefix\n'.repeat(100) + 'new tail'));
    f.previews.observe({ ...event, kind: 'committed', entryId: 'accepted' });
    const resized = await f.reader.resize(50, 6, []);
    expect(resized!.anchor!.source).toMatchObject({ kind: 'preview', contentRevision: revision });
    expect(resized!.lines.map(line => line.text).join('\n')).not.toContain('new tail');
    const accepted = await f.reader.read('latest');
    expect(accepted!.anchor!.source).toMatchObject({ kind: 'history', entryId: 'accepted' });
  });
  it('keeps cache budgets finite across many widths and source ranges', async () => {
    const f = fixture([message('long', 'line 中文\n'.repeat(20000))]);
    await f.reader.open(f.session, 76, 8, []);
    for (let n = 0; n < 90; n++) { await f.reader.move('older'); await f.reader.resize(40 + n % 20, 8, []); }
    const stats = f.reader.stats();
    expect(stats.bodyBytes).toBeLessThanOrEqual(TRANSCRIPT_CACHE_BYTES);
    expect(stats.layoutBytes).toBeLessThanOrEqual(TRANSCRIPT_CACHE_BYTES);
    expect(stats.bodyItems).toBeLessThanOrEqual(TRANSCRIPT_CACHE_ITEMS);
    expect(stats.layoutItems).toBeLessThanOrEqual(TRANSCRIPT_CACHE_ITEMS);
    expect(stats.lastLayoutRows).toBeLessThanOrEqual(24);
  });
  it('retains the previous viewport when a range fails', async () => {
    const f = fixture([message('long', 'line\n'.repeat(10000))]);
    let fail = false;
    const reader = new TranscriptReader({ ...f.port, body: query => fail ? Promise.reject(new Error('unavailable')) : f.port.body(query) });
    cleanup.push(() => reader.dispose());
    const previous = await reader.open(f.session, 76, 8, []);
    fail = true;
    await expect(reader.read('oldest')).rejects.toThrow('unavailable');
    expect(reader.frame).toBe(previous);
  });
});
