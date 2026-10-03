import { afterEach, describe, expect, it, vi } from 'vitest';
import { openCheckpointStore } from '../../src/adapters/storage/checkpoint-store.js';
import { scanHistory } from '../../src/application/coordinator/history-search.js';
import type { TranscriptReadingPort } from '../../src/application/coordinator/history.js';
import type { CommittedMessageEntry } from '../../src/domain/coordinator/session-state.js';
import type { CoordinatorSessionId, OperationId } from '../../src/application/dto/identity.js';
import { TranscriptReader } from '../../src/interfaces/tui/render/transcript-reader.js';
import { createFakePorts, renderTui, settle } from './harness.js';
import { userQuestionInteractionId } from '../../src/application/coordination/pending-interaction.js';
import type { InteractionSummary } from '../../src/application/ports/branch-coordination-store.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
function fixture(withQuestion = false) {
  const opened = openCheckpointStore({ databasePath: ':memory:' });
  if (opened.kind !== 'opened') throw new Error(opened.message);
  const store = opened.store;
  const entries: CommittedMessageEntry[] = [{ entryId: 'user-old', stepId: 'user-old', role: 'user', content: 'old input 中文🙂' }];
  for (let n = 0; n < 130; n++) {
    entries.push({ entryId: 'step-' + n, stepId: 'step-' + n, role: 'assistant', content: '', toolCalls: [{ callId: 'call-' + n,
      name: withQuestion && n === 120 ? 'ask_user' : 'read', operationId: ('op-' + n) as OperationId, mapOperationId: null, activityKind: withQuestion && n === 120 ? 'action' : 'query', args: { value: 'ARG_NEEDLE_' + n } }] });
    entries.push({ entryId: 'result-' + n, stepId: 'step-' + n, role: 'tool', toolCallId: 'call-' + n, toolName: withQuestion && n === 120 ? 'ask_user' : 'read',
      content: JSON.stringify(n === 60 ? { kind: 'rejected', code: 'denied' } : { kind: 'ok', value: 'RESULT_NEEDLE_' + n }) });
  }
  entries.push({ entryId: 'user-new', stepId: 'user-new', role: 'user', content: 'new input 中文🙂' });
  const saved = store.saveCheckpoint({ schemaVersion: 2, coordinatorSessionId: 'session-b' as CoordinatorSessionId, graphPosition: 'suspend',
    committedMessages: entries, committedModelSteps: entries.filter(entry => entry.toolCalls !== undefined).map(entry => ({ stepId: entry.stepId,
      entryId: entry.entryId, committedAt: 1, messages: [{ role: 'assistant', content: entry.content, toolCalls: entry.toolCalls }], toolCalls: entry.toolCalls!, usage: null })),
    wakeBatches: [], lastCompactionOutcome: null });
  if (saved.kind !== 'saved') throw new Error(saved.message);
  while (!store.prepareHistoryInspection().ready) { /* Explicit fixture bootstrap. */ }
  const reading: TranscriptReadingPort = {
    inspection: { snapshot: session => Promise.resolve(store.readHistoryInspection(session)), calls: query => Promise.resolve(store.readHistoryCalls(query)),
      users: query => Promise.resolve(store.readUserHistoryPage(query)), search: (query, signal) => scanHistory(reading, query, signal) },
    history: query => Promise.resolve(store.readHistoryPage(query)), body: query => Promise.resolve().then(() => {
      if (query.source.kind === 'preview' || query.source.kind === 'interaction') return null;
      if (query.source.kind === 'arguments') return store.readHistoryArguments({ coordinatorSessionId: query.coordinatorSessionId,
        entryId: query.source.entryId, stepId: query.source.stepId, callId: query.source.callId, contentRevision: 1, offset: query.offset, maxBytes: query.maxBytes });
      const range = store.readHistoryBody({ coordinatorSessionId: query.coordinatorSessionId, entryId: query.source.entryId,
        contentRevision: 1, offset: query.offset, maxBytes: query.maxBytes });
      return range === null ? null : { source: query.source, ...range };
    }), previews: () => Promise.resolve([]), pin: () => () => {}, subscribe: () => () => {},
  };
  cleanups.push(() => store.close());
  return { reading, store };
}
async function waitFor(rendered: ReturnType<typeof renderTui>, token: string) {
  const deadline = Date.now() + 5000;
  while (!(rendered.lastFrame() ?? '').includes(token) && Date.now() < deadline) await settle(2);
  expect(rendered.lastFrame()).toContain(token);
}
async function press(rendered: ReturnType<typeof renderTui>, input: string) {
  rendered.stdin.write(input);
  if (input === '\u001b') await new Promise(resolve => setTimeout(resolve, 100));
  await settle(4);
}
describe('authoritative activity reading and input paths', () => {
  it('binds retained ask_user to operation identity and reads Q/A in place with bounded source anchors', async () => {
    const { store, reading } = fixture(true);
    const question = '权威问题 中文🙂\n'.repeat(1600), answer = '权威回答 中文🙂\n'.repeat(1600);
    const id = userQuestionInteractionId('op-120');
    let summary: InteractionSummary = { coordinationScopeId: 'scope-1' as InteractionSummary['coordinationScopeId'], interactionId: id,
      ownerCoordinatorSessionId: 'session-b' as CoordinatorSessionId, subjectRef: { kind: 'coordinator-session', id: 'session-b' },
      expectedRevision: 4, state: 'open', answerRef: null, createdAt: 1, resolvedAt: null,
      questionPreview: '权威问题 中文🙂', answerPreview: '', questionByteLength: Buffer.byteLength(question), answerByteLength: 0 };
    const bodyReads: string[] = [], batches: number[] = [];
    let failSummaries = false, missing = false;
    const port: TranscriptReadingPort = { ...reading,
      interactions: (session, ids) => { expect(session).toBe('session-b'); batches.push(ids.length);
        if (failSummaries) throw new Error('authority unavailable');
        return Promise.resolve(!missing && ids.includes(id) ? [summary] : []); },
      body: async query => {
        if (query.source.kind !== 'interaction') return reading.body(query);
        bodyReads.push(query.source.part);
        const bytes = Buffer.from(query.source.part === 'question' ? question : answer);
        expect(query.source.interactionId).toBe(id); expect(query.maxBytes).toBeLessThanOrEqual(65536);
        if (query.offset < bytes.length && (bytes[query.offset]! & 0xc0) === 0x80) throw new (await import('../../src/application/coordinator/history.js')).HistoryBoundaryError('边界');
        let end = Math.min(bytes.length, query.offset + query.maxBytes);
        while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
        return { source: query.source, text: bytes.subarray(query.offset, end).toString('utf8'), offset: query.offset, end, byteLength: bytes.length };
      },
    };
    const reader = new TranscriptReader(port); cleanups.push(() => reader.dispose());
    const call = store.readHistoryCalls({ coordinatorSessionId: 'session-b', direction: 'newer', entryId: 'step-120', callId: 'call-120' }).calls[0]!;
    const anchor = { coordinatorSessionId: 'session-b', sequence: call.sequence,
      source: { kind: 'arguments' as const, entryId: call.entryId, stepId: call.stepId, callId: call.callId, contentRevision: 1 as const }, offset: 0 };
    await reader.open('session-b', 76, 12, []);
    const compact = await reader.read('anchor', anchor);
    expect(compact!.lines.some(line => line.text.includes('权威问题') && line.text.includes('待回答'))).toBe(true);
    expect(bodyReads).toEqual([]);
    summary = { ...summary, state: 'answered', answerRef: { kind: 'ui-submission', id: 'answer-ref' }, resolvedAt: 2,
      answerPreview: '权威回答 中文🙂', answerByteLength: Buffer.byteLength(answer) };
    const closed = await reader.read('anchor', anchor);
    expect(closed!.lines.some(line => line.text.includes('已回答'))).toBe(true);
    expect(closed!.lines.some(line => line.text.includes('权威回答'))).toBe(true);
    await reader.resize(76, 12, [call.activityId]);
    const qAnchor = { coordinatorSessionId: 'session-b', sequence: call.sequence,
      source: { kind: 'interaction' as const, interactionId: id, part: 'question' as const, contentRevision: '4' }, offset: 0 };
    const q = await reader.read('anchor', qAnchor);
    expect(q!.lines.some(line => line.text.includes('权威问题'))).toBe(true);
    const next = await reader.move('newer'), offset = next!.anchor!.offset;
    expect(offset).toBeGreaterThan(0);
    expect((await reader.resize(40, 12, [call.activityId]))!.anchor).toMatchObject({ source: qAnchor.source, offset });
    const a = await reader.read('anchor', { ...qAnchor, source: { ...qAnchor.source, part: 'answer', contentRevision: 'answer-ref' } });
    expect(a!.lines.some(line => line.text.includes('权威回答'))).toBe(true);
    expect(bodyReads).toContain('answer'); expect(Math.max(...batches)).toBeLessThanOrEqual(20);
    expect(reader.stats().lastReadBytes).toBeLessThanOrEqual(65536);
    expect(reader.stats().bodyItems).toBeLessThanOrEqual(64);
    expect(reader.stats().layoutItems).toBeLessThanOrEqual(64);
    expect(reader.stats().bodyBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(reader.stats().layoutBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    const pinned = reader.frame;
    failSummaries = true;
    await expect(reader.read('anchor', anchor)).rejects.toThrow('authority unavailable');
    expect(reader.frame).toBe(pinned);
    failSummaries = false; missing = true;
    expect((await reader.read('anchor', anchor))!.lines.some(line => line.text.includes('问题记录缺失'))).toBe(true);
    const unavailable = new TranscriptReader(reading); cleanups.push(() => unavailable.dispose());
    await unavailable.open('session-b', 76, 12, []);
    expect((await unavailable.read('anchor', anchor))!.lines.some(line => line.text.includes('问题关联不可用'))).toBe(true);
    const pendingIndex = new TranscriptReader({ ...port, inspection: { ...reading.inspection!,
      snapshot: session => Promise.resolve({ ...store.readHistoryInspection(session), ready: false }),
    } }); cleanups.push(() => pendingIndex.dispose());
    await pendingIndex.open('session-b', 76, 12, []);
    expect((await pendingIndex.read('anchor', { ...anchor, sequence: call.result!.sequence,
      source: { kind: 'history', entryId: call.result!.entryId, contentRevision: 1 } }))!.lines
      .some(line => line.text.includes('问题索引未就绪'))).toBe(true);
  });
  it('uses one group across pages and keeps a rejected member visible while compact', async () => {
    const { reading } = fixture(), reader = new TranscriptReader(reading);
    cleanups.push(() => reader.dispose());
    const newest = await reader.open('session-b', 76, 12, []);
    const group = newest!.lines.find(line => line.activityId !== undefined);
    expect(group?.text).toContain('rejected');
    const oldest = await reader.read('oldest');
    expect(oldest!.lines.find(line => line.activityId !== undefined)?.activityId).toBe(group?.activityId);
    expect(reader.stats().lastReadBytes).toBeLessThanOrEqual(65536);
  });
  it('reads both results in sequence when one model step asks two questions', async () => {
    const { reading, store } = fixture();
    const calls = ['first', 'second'].map(id => ({ callId: id, name: 'ask_user', args: { text: id }, operationId: ('op-' + id) as OperationId,
      mapOperationId: null, activityKind: 'action' as const }));
    const entry = { entryId: 'two-questions', stepId: 'two-questions', role: 'assistant' as const, content: '', toolCalls: calls };
    expect(store.appendModelStep({ coordinatorSessionId: 'session-b' as CoordinatorSessionId, graphPosition: 'suspend', entry,
      step: { entryId: entry.entryId, stepId: entry.stepId, committedAt: 1,
        messages: [{ role: 'assistant', content: '' }], toolCalls: calls, usage: null } }).kind).toBe('saved');
    for (const call of calls) expect(store.appendToolResult({ coordinatorSessionId: 'session-b' as CoordinatorSessionId,
      graphPosition: 'suspend', entry: { entryId: 'result-' + call.callId, stepId: entry.stepId, role: 'tool',
        toolName: call.name, toolCallId: call.callId, content: 'RESULT_' + call.callId } }).kind).toBe('saved');
    const reader = new TranscriptReader({ ...reading, interactions: () => Promise.resolve(calls.map(call => ({
      coordinationScopeId: 'scope-1' as InteractionSummary['coordinationScopeId'], interactionId: userQuestionInteractionId(call.operationId),
      ownerCoordinatorSessionId: 'session-b' as CoordinatorSessionId, subjectRef: { kind: 'coordinator-session', id: 'session-b' },
      expectedRevision: 4, state: 'open' as const, answerRef: null, createdAt: 1, resolvedAt: null,
      questionPreview: call.callId, answerPreview: '', questionByteLength: call.callId.length, answerByteLength: 0,
    }))), body: query => query.source.kind === 'interaction' ? Promise.resolve({ source: query.source, offset: 0,
      end: query.source.interactionId.includes('first') ? 5 : 6, byteLength: query.source.interactionId.includes('first') ? 5 : 6,
      text: query.source.interactionId.includes('first') ? 'first' : 'second' }) : reading.body(query),
    }); cleanups.push(() => reader.dispose());
    reader.setDetailed(true);
    const frame = await reader.open('session-b', 76, 40, []);
    const results = frame!.lines.filter(line => line.text.startsWith('RESULT_')).map(line => line.text);
    expect(results).toEqual(['RESULT_first', 'RESULT_second']);
    const questions = frame!.lines.filter(line => line.anchor.source.kind === 'interaction' && line.kind === 'tool-detail');
    expect(questions.map(line => line.text)).toEqual(['first', 'second']);
  });
  it('reads exact argument and result sources with whole details and preserves argument anchors', async () => {
    const { reading } = fixture(), reader = new TranscriptReader(reading);
    cleanups.push(() => reader.dispose());
    reader.setDetailed(true); await reader.open('session-b', 76, 12, []);
    const frame = await reader.read('anchor', { coordinatorSessionId: 'session-b', sequence: 2,
      source: { kind: 'arguments', entryId: 'step-0', stepId: 'step-0', callId: 'call-0', contentRevision: 1 }, offset: 0 });
    expect(frame!.lines.some(line => line.text.includes('ARG_NEEDLE_0'))).toBe(true);
    expect(frame!.lines.some(line => line.text.includes('RESULT_NEEDLE_0'))).toBe(true);
    const resized = await reader.resize(40, 12, []);
    expect(resized!.anchor?.source.kind).toBe('arguments');
  });
  it('Ctrl+R adopts before sending and Esc returns the untouched chat draft', async () => {
    const { reading } = fixture(), fake = createFakePorts();
    cleanups.push(() => fake.closeInputStore());
    const rendered = renderTui({ ...fake.ports, reading });
    cleanups.push(() => rendered.unmount());
    await waitFor(rendered, 'new input');
    await press(rendered, 'DRAFT'); await press(rendered, '\u0012');
    await waitFor(rendered, 'Ctrl+R'); await waitFor(rendered, 'new input');
    expect(fake.executeCount()).toBe(0);
    await press(rendered, '\r'); expect(fake.executeCount()).toBe(0);
    expect(rendered.lastFrame()).not.toContain('Ctrl+R');
    await press(rendered, '\r'); await settle(6); expect(fake.executeCount()).toBe(1);
  });
  it('F4 navigates complete activities and returns without sending the chat draft', async () => {
    const { reading } = fixture(), fake = createFakePorts();
    cleanups.push(() => fake.closeInputStore());
    const rendered = renderTui({ ...fake.ports, reading });
    cleanups.push(() => rendered.unmount());
    await waitFor(rendered, 'new input');
    await press(rendered, 'DRAFT'); await press(rendered, '\u001bOS');
    await waitFor(rendered, 'ARG_NEEDLE_0');
    expect(fake.executeCount()).toBe(0);
    await press(rendered, '\u001b');
    expect(rendered.lastFrame()).toContain('DRAFT');
    expect(rendered.lastFrame()).not.toContain('F4 活动');
  });
  it('a recalled ordinary preview never becomes a pending-interaction answer', async () => {
    const { reading, store } = fixture();
    const RECALLED = 'RECALL_PROBE_TEXT';
    const appended = store.appendMessage('session-b' as CoordinatorSessionId,
      { entryId: 'user-probe', stepId: 'user-probe', role: 'user', content: RECALLED });
    if (appended.kind !== 'saved') throw new Error(appended.message);
    const recalls = vi.spyOn(store, 'readUserHistoryPage');
    const fake = createFakePorts({ snapshot: { interactions: [{ interactionId: 'i-1',
      ownerCoordinatorSessionId: 'session-b', subjectRef: { kind: 'ticket', id: 't-1' },
      expectedRevision: 4, state: 'open' }] } });
    cleanups.push(() => fake.closeInputStore());
    const rendered = renderTui({ ...fake.ports, reading });
    cleanups.push(() => rendered.unmount());
    await waitFor(rendered, 'new input');
    await press(rendered, '\u001b[A');
    await waitFor(rendered, RECALLED);
    expect(recalls).toHaveBeenCalled();
    // 回答面板与普通历史互不相干：进入回答模式就不得带着选中的旧聊天原文。
    await press(rendered, '\u001b[1;2D');
    await waitFor(rendered, 'i-1');
    await press(rendered, '\r');
    await settle(6);
    expect(fake.executeIntents).toEqual([]);
  });
});
