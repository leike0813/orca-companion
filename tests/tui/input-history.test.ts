import { expect, test, vi } from 'vitest';
import type { UiDraft } from '../../src/application/ports/ui-input-store.js';
import { HISTORY_CHUNK_BYTES, type HistoryMetadata, type TranscriptReadingPort } from '../../src/application/coordinator/history.js';
import { MAX_USER_MESSAGE_CHARS } from '../../src/application/coordinator/user-message.js';
import { emptyDraft, textDraft } from '../../src/interfaces/tui/input/composer-editor.js';
import { InputHistory, readHistoricalInput } from '../../src/interfaces/tui/input/input-history.js';
import { createTranscriptReadingFixture, type TranscriptFixtureMessage } from '../support/transcript-reading.js';

const SESSION = 'input-history-session';
const OTHER = 'input-history-other';

/** Reuse the existing UTF-8 body fixture; add only the user-only inspection seam. */
function fixture(sessions: Record<string, TranscriptFixtureMessage[]>) {
  const portFor = (session: string) => createTranscriptReadingFixture({
    coordinatorSessionId: session, messages: sessions[session] ?? [],
  });
  const body = vi.fn<TranscriptReadingPort['body']>(query => portFor(query.coordinatorSessionId).body(query));
  const users = vi.fn<NonNullable<TranscriptReadingPort['inspection']>['users']>(query => {
    const visible = (sessions[query.coordinatorSessionId] ?? []).filter(message => message.role !== 'system');
    const rows: HistoryMetadata[] = visible.map((message, index) => ({
      entryId: message.entryId ?? `entry:${String(index + 1)}`,
      stepId: message.stepId ?? `entry:${String(index + 1)}`,
      sequence: index + 1, contentRevision: 1 as const, role: message.role,
      byteLength: Buffer.byteLength(message.content),
    })).filter(entry => entry.role === 'user' && entry.sequence <= (query.upperSequence ?? Infinity)
      && entry.sequence < (query.before ?? Infinity) && entry.sequence > (query.after ?? 0));
    const entries = query.direction === 'newer' ? rows.slice(0, 100) : rows.slice(-100);
    return Promise.resolve({ entries, hasMore: entries.length < rows.length });
  });
  const reading: TranscriptReadingPort = {
    history: query => portFor(query.coordinatorSessionId).history(query), body,
    previews: () => Promise.resolve([]), pin: () => () => {}, subscribe: () => () => {},
    inspection: {
      snapshot: session => {
        const upperSequence = (sessions[session] ?? []).filter(message => message.role !== 'system').length;
        return Promise.resolve({ upperSequence, indexedThroughSequence: upperSequence, ready: true });
      },
      users, calls: () => Promise.resolve({ calls: [], hasMore: false }),
    },
  };
  return { reading, body, users };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

test('recalls only ordinary user entries belonging to the selected Session', async () => {
  const { reading } = fixture({
    [SESSION]: [
      { role: 'user', content: 'first ordinary input' },
      { role: 'assistant', content: 'agent reply' },
      { role: 'system', content: 'interaction answer reference' },
      { role: 'tool', content: 'read\ntool result' },
      { role: 'user', content: 'latest ordinary input' },
    ],
    [OTHER]: [{ role: 'user', content: 'other Session input' }],
  });
  const history = new InputHistory(reading);
  const latest = await history.move(SESSION, emptyDraft(), 'older');
  expect(latest).toEqual(textDraft('latest ordinary input'));
  const first = await history.move(SESSION, { ...latest!, cursor: 0 }, 'older');
  expect(first).toEqual(textDraft('first ordinary input'));
  expect(await history.move(SESSION, { ...first!, cursor: 0 }, 'older')).toEqual(first);
  expect(await history.move(SESSION, first!, 'newer')).toEqual(latest);
});

test('recall is a preview; cancel restores the entire original draft', async () => {
  const { reading } = fixture({ [SESSION]: [{ role: 'user', content: 'historical input' }] });
  const original: UiDraft = { text: '前缀 pasted text 后缀', cursor: 3,
    pasteBlocks: [{ id: 'paste-original', start: 3, end: 14 }] };
  const before = structuredClone(original);
  const history = new InputHistory(reading);
  const recalled = await history.move(SESSION, original, 'older');
  expect(recalled).toEqual(textDraft('historical input'));
  expect(history.draft).toEqual(recalled);
  expect(original).toEqual(before);
  expect(history.cancel()).toEqual(before);
  expect(history.active).toBe(false);
  expect(history.draft).toBeNull();
  expect(history.cancel()).toBeNull();
});

test('moving beyond the newest entry restores the saved original draft', async () => {
  const { reading } = fixture({ [SESSION]: [{ role: 'user', content: 'last sent' }] });
  const original: UiDraft = { text: 'unsent paste', cursor: 0,
    pasteBlocks: [{ id: 'original-block', start: 0, end: 12 }] };
  const history = new InputHistory(reading);
  const recalled = await history.move(SESSION, original, 'older');
  expect(await history.move(SESSION, recalled!, 'newer')).toEqual(original);
  expect(history.active).toBe(false);
  expect(history.draft).toBeNull();
});

test('only unmodified recall at the whole-text boundary continues browsing', async () => {
  const { reading } = fixture({ [SESSION]: [{ role: 'user', content: 'first\nsecond' }] });
  const history = new InputHistory(reading);
  expect(history.canMove(emptyDraft(), 'older')).toBe(false);
  const recalled = (await history.move(SESSION, emptyDraft(), 'older'))!;
  expect(history.canMove({ ...recalled, cursor: 0 }, 'older')).toBe(true);
  expect(history.canMove(recalled, 'newer')).toBe(true);
  expect(history.canMove(recalled, 'older')).toBe(false);
  expect(history.canMove({ ...recalled, cursor: 6 }, 'older')).toBe(false);
  expect(history.canMove({ ...recalled, cursor: 6 }, 'newer')).toBe(false);
  expect(history.canMove(textDraft(recalled.text + ' edited'), 'newer')).toBe(false);
  history.cancel();
  expect(history.canMove(recalled, 'newer')).toBe(false);
});

test('keyset recall crosses metadata pages and excludes later appends', async () => {
  const messages: TranscriptFixtureMessage[] = Array.from({ length: 105 }, (_, index) => ({
    role: 'user', content: `input ${String(index)}`,
  }));
  const { reading, users } = fixture({ [SESSION]: messages });
  const history = new InputHistory(reading);
  let recalled = (await history.move(SESSION, emptyDraft(), 'older'))!;
  expect(recalled.text).toBe('input 104');
  messages.push({ role: 'user', content: 'appended after recall began' });
  for (let index = 103; index >= 0; index--) {
    recalled = (await history.move(SESSION, { ...recalled, cursor: 0 }, 'older'))!;
    expect(recalled.text).toBe(`input ${String(index)}`);
  }
  expect(await history.move(SESSION, { ...recalled, cursor: 0 }, 'older')).toEqual(recalled);
  for (let index = 1; index <= 104; index++) {
    recalled = (await history.move(SESSION, recalled, 'newer'))!;
    expect(recalled.text).toBe(`input ${String(index)}`);
  }
  expect(await history.move(SESSION, recalled, 'newer')).toEqual(emptyDraft());
  expect(users.mock.calls.every(([query]) => query.upperSequence === 105)).toBe(true);
});

test('full recall reads bounded UTF-8 ranges and never synthesizes paste identities', async () => {
  const content = '中😀\n'.repeat(3000);
  const { reading, body } = fixture({ [SESSION]: [{ role: 'user', content }] });
  const draft = await readHistoricalInput(reading, SESSION, 'entry:1');
  expect(draft).toEqual({ text: content, cursor: content.length, pasteBlocks: [] });
  expect(body.mock.calls.length).toBeGreaterThan(1);
  expect(body.mock.calls.every(([query]) => query.maxBytes === HISTORY_CHUNK_BYTES)).toBe(true);
});

test('empty historical input remains a valid full draft', async () => {
  const { reading } = fixture({ [SESSION]: [{ role: 'user', content: '' }] });
  expect(await readHistoricalInput(reading, SESSION, 'entry:1')).toEqual(emptyDraft());
});

test('excessive historical input is rejected rather than truncated or adopted', async () => {
  const { reading } = fixture({ [SESSION]: [{ role: 'user', content: 'x'.repeat(MAX_USER_MESSAGE_CHARS + 1) }] });
  const original = textDraft('retain this draft');
  const history = new InputHistory(reading);
  await expect(history.move(SESSION, original, 'older')).rejects.toBeInstanceOf(RangeError);
  expect(history.draft).toBeNull();
  expect(history.cancel()).toEqual(original);
});

test('read failure retains the previous preview and can retry the same entry', async () => {
  const { reading, body } = fixture({ [SESSION]: [
    { role: 'user', content: 'earlier' }, { role: 'user', content: 'latest' },
  ] });
  const original = textDraft('unsent');
  const history = new InputHistory(reading);
  const latest = (await history.move(SESSION, original, 'older'))!;
  body.mockRejectedValueOnce(new Error('read unavailable'));
  await expect(history.move(SESSION, { ...latest, cursor: 0 }, 'older')).rejects.toThrow();
  expect(history.draft).toEqual(latest);
  expect(await history.move(SESSION, { ...latest, cursor: 0 }, 'older')).toEqual(textDraft('earlier'));
  expect(history.cancel()).toEqual(original);
});

test('a late body result cannot reopen cancelled recall', async () => {
  const { reading, body } = fixture({ [SESSION]: [{ role: 'user', content: 'late' }] });
  const gate = deferred<Awaited<ReturnType<TranscriptReadingPort['body']>>>();
  const originalRead = reading.body;
  const entered = deferred<void>();
  body.mockImplementationOnce(() => { entered.resolve(); return gate.promise; });
  const original = textDraft('unsent');
  const history = new InputHistory(reading);
  const pending = history.move(SESSION, original, 'older');
  await entered.promise;
  expect(history.cancel()).toEqual(original);
  gate.resolve(await originalRead({ coordinatorSessionId: SESSION,
    source: { kind: 'history', entryId: 'entry:1', contentRevision: 1 }, offset: 0, maxBytes: HISTORY_CHUNK_BYTES }));
  expect(await pending).toBeNull();
  expect(history.active).toBe(false);
  expect(history.draft).toBeNull();
});

test('switching Session discards the old pending body result', async () => {
  const { reading, body } = fixture({
    [SESSION]: [{ role: 'user', content: 'old Session' }],
    [OTHER]: [{ role: 'user', content: 'new Session' }],
  });
  const gate = deferred<Awaited<ReturnType<TranscriptReadingPort['body']>>>();
  const originalRead = reading.body;
  const entered = deferred<void>();
  body.mockImplementationOnce(() => { entered.resolve(); return gate.promise; });
  const history = new InputHistory(reading);
  const pending = history.move(SESSION, emptyDraft(), 'older');
  await entered.promise;
  const newOriginal = textDraft('new unsent');
  expect(await history.move(OTHER, newOriginal, 'older')).toEqual(textDraft('new Session'));
  gate.resolve(await originalRead({ coordinatorSessionId: SESSION,
    source: { kind: 'history', entryId: 'entry:1', contentRevision: 1 }, offset: 0, maxBytes: HISTORY_CHUNK_BYTES }));
  expect(await pending).toBeNull();
  expect(history.draft).toEqual(textDraft('new Session'));
  expect(history.cancel()).toEqual(newOriginal);
});

test('an aborted historical read discards late data and preserves its abort reason', async () => {
  const { reading, body } = fixture({ [SESSION]: [{ role: 'user', content: 'late' }] });
  const gate = deferred<Awaited<ReturnType<TranscriptReadingPort['body']>>>();
  const originalRead = reading.body;
  body.mockImplementationOnce(() => gate.promise);
  const abort = new AbortController();
  const pending = readHistoricalInput(reading, SESSION, 'entry:1', abort.signal);
  const reason = new Error('cancel recall');
  abort.abort(reason);
  gate.resolve(await originalRead({ coordinatorSessionId: SESSION,
    source: { kind: 'history', entryId: 'entry:1', contentRevision: 1 }, offset: 0, maxBytes: HISTORY_CHUNK_BYTES }));
  await expect(pending).rejects.toBe(reason);
});

test('missing history or a non-progressing body fails without producing a partial draft', async () => {
  const { reading, body } = fixture({ [SESSION]: [{ role: 'user', content: 'remaining' }] });
  await expect(readHistoricalInput(reading, SESSION, 'missing')).rejects.toThrow();
  body.mockResolvedValueOnce({ source: { kind: 'history', entryId: 'entry:1', contentRevision: 1 },
    text: '', offset: 0, end: 0, byteLength: 9 });
  await expect(readHistoricalInput(reading, SESSION, 'entry:1')).rejects.toThrow();
});
