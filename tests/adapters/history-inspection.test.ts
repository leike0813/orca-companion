import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { openCheckpointStore, type CheckpointStore } from '../../src/adapters/storage/checkpoint-store.js';
import type { HistoryCall } from '../../src/application/coordinator/history-inspection.js';
import { HistoryBoundaryError, HISTORY_BODY_BYTES } from '../../src/application/coordinator/history.js';
import type { CoordinatorSessionId, OperationId } from '../../src/application/dto/identity.js';
import {
  COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
  assistantEntryId,
  toolResultEntryId,
  userEntryId,
  userStepId,
  type CommittedMessageEntry,
  type CommittedModelStep,
  type CommittedToolCall,
  type CoordinatorSessionState,
} from '../../src/domain/coordinator/session-state.js';

const SESSION = 'session-inspection' as CoordinatorSessionId;

let directory = '';
let databasePath = '';
let store: CheckpointStore;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-inspection-'));
  databasePath = join(directory, 'checkpoints.sqlite');
  const opened = openCheckpointStore({ databasePath, clock: () => 1_000 });
  if (opened.kind !== 'opened') throw new Error(opened.message);
  store = opened.store;
  expect(store.saveCheckpoint(emptyState()).kind).toBe('saved');
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

function emptyState(): CoordinatorSessionState {
  return { schemaVersion: COORDINATOR_SESSION_STATE_SCHEMA_VERSION, coordinatorSessionId: SESSION, committedMessages: [], committedModelSteps: [],
    wakeBatches: [], graphPosition: 'model', lastCompactionOutcome: null };
}

function call(callId: string, args: unknown, name = 'read_route_map', activityKind?: 'query' | 'action'): CommittedToolCall {
  return { callId, name, args, operationId: `op:${callId}` as OperationId, mapOperationId: null, ...(activityKind === undefined ? {} : { activityKind }) };
}

function assistantEntry(stepId: string, content: string, toolCalls: readonly CommittedToolCall[] = []): CommittedMessageEntry {
  return { entryId: assistantEntryId(stepId), stepId, role: 'assistant', content, ...(toolCalls.length > 0 ? { toolCalls } : {}) };
}

function stepOf(entry: CommittedMessageEntry, toolCalls: readonly CommittedToolCall[]): CommittedModelStep {
  return { stepId: entry.stepId, entryId: entry.entryId, committedAt: 1_000, messages: [{ role: 'assistant', content: entry.content }], toolCalls, usage: null };
}

function commit(entry: CommittedMessageEntry): void {
  const toolCalls = entry.toolCalls ?? [];
  const written = store.appendModelStep({ coordinatorSessionId: SESSION, graphPosition: 'tools', entry, step: stepOf(entry, toolCalls) });
  expect(written.kind, written.kind === 'failed' ? written.message : '').toBe('saved');
}

function commitResult(stepId: string, callId: string, outcome: unknown, name = 'read_route_map'): void {
  const entry: CommittedMessageEntry = { entryId: toolResultEntryId(stepId, callId), stepId, role: 'tool', content: JSON.stringify(outcome), toolCallId: callId, toolName: name };
  const written = store.appendToolResult({ coordinatorSessionId: SESSION, graphPosition: 'tools', entry });
  expect(written.kind, written.kind === 'failed' ? written.message : '').toBe('saved');
}

function callsAll(): readonly HistoryCall[] {
  return store.readHistoryCalls({ coordinatorSessionId: SESSION }).calls;
}

function withRawDatabase(work: (raw: DatabaseSync) => void): void {
  const raw = new DatabaseSync(databasePath);
  try {
    work(raw);
  } finally {
    raw.close();
  }
}

/** 清空派生索引，等价于一份还没有被索引覆盖的既有历史；权威原文不动。 */
function resetDerivedIndex(): void {
  withRawDatabase(raw => {
    for (const table of ['history_call_index', 'history_activity_tally', 'history_call_results', 'history_inspection_scans'])
      raw.prepare(`DELETE FROM ${table}`).run();
    raw.prepare('UPDATE history_inspection_progress SET indexed_through_seq=0,open_activity_id=NULL').run();
  });
}

test('提交时立即建立调用定位：参数只留字节范围，巨大参数按范围读回原文', () => {
  const args = { literal: '参数🙂中文', blob: 'x'.repeat(1024 * 1024) };
  commit(assistantEntry('step-huge', '', [call('call-huge', args)]));

  const indexed = callsAll()[0];
  expect(indexed).toMatchObject({ entryId: assistantEntryId('step-huge'), stepId: 'step-huge', callId: 'call-huge', name: 'read_route_map', operationId: 'op:call-huge', result: null, status: 'unconfirmed' });
  expect(indexed?.argsByteLength).toBe(Buffer.byteLength(JSON.stringify(args)));

  // 分段读回必须与原参数逐字一致，且每段都在完整字符边界上结束。
  let offset = 0, text = '';
  while (offset < (indexed?.argsByteLength ?? 0)) {
    const range = store.readHistoryArguments({ coordinatorSessionId: SESSION, entryId: indexed!.entryId, stepId: indexed!.stepId, callId: indexed!.callId, contentRevision: 1, offset, maxBytes: HISTORY_BODY_BYTES });
    expect(range?.byteLength).toBe(indexed?.argsByteLength);
    expect(range?.source).toEqual({ kind: 'arguments', entryId: indexed!.entryId, stepId: 'step-huge', callId: 'call-huge', contentRevision: 1 });
    text += range?.text ?? '';
    offset = range?.end ?? offset;
  }
  expect(text).toBe(JSON.stringify(args));

  // 越界偏移不能被猜成半个字符，单次范围也不能超过 64 KiB。
  const boundary = Buffer.byteLength(JSON.stringify({ literal: '参' }));
  expect(() => store.readHistoryArguments({ coordinatorSessionId: SESSION, entryId: indexed!.entryId, stepId: 'step-huge', callId: 'call-huge', contentRevision: 1, offset: boundary, maxBytes: 4096 })).toThrow(HistoryBoundaryError);
  expect(() => store.readHistoryArguments({ coordinatorSessionId: SESSION, entryId: indexed!.entryId, stepId: 'step-huge', callId: 'call-huge', contentRevision: 1, offset: 0, maxBytes: HISTORY_BODY_BYTES + 1 })).toThrow();
  expect(store.readHistoryArguments({ coordinatorSessionId: SESSION, entryId: 'entry:missing', stepId: 'step-huge', callId: 'call-huge', contentRevision: 1, offset: 0, maxBytes: 64 })).toBeNull();
});

test('参数范围在多字节字符边界上收尾：整段中文、emoji 与被切开的字符', () => {
  // 参数刚好以中文和 emoji 结尾：一次读完必须逐字完整。
  const whole = { text: '整段中文🙂🎉结尾' };
  commit(assistantEntry('step-whole', '', [call('c-whole', whole)]));
  const target = callsAll()[0]!;
  const all = store.readHistoryArguments({ coordinatorSessionId: SESSION, entryId: target.entryId, stepId: target.stepId, callId: target.callId, contentRevision: 1, offset: 0, maxBytes: HISTORY_BODY_BYTES });
  expect(all?.text).toBe(JSON.stringify(whole));
  expect(all?.end).toBe(target.argsByteLength);

  // 每一次都从一个完整字符开始、在完整字符处结束；拼接后与原文逐字一致。
  const split = { text: '中文🙂中文🎉中文' };
  commit(assistantEntry('step-split', '', [call('c-split', split)]));
  const anchor = callsAll().find(entry => entry.callId === 'c-split')!;
  let offset = 0, text = '';
  while (offset < anchor.argsByteLength) {
    const range = store.readHistoryArguments({ coordinatorSessionId: SESSION, entryId: anchor.entryId, stepId: anchor.stepId, callId: anchor.callId, contentRevision: 1, offset, maxBytes: 7 });
    expect(range?.end).toBeGreaterThan(offset);
    expect(Buffer.byteLength(range?.text ?? '')).toBe((range?.end ?? 0) - offset);
    text += range?.text ?? '';
    offset = range?.end ?? offset;
  }
  expect(text).toBe(JSON.stringify(split));
});

test('固定上界读到的是那一刻的调用：上界之后的结果与结局不出现', () => {
  const toolCalls = [call('c-1', { n: 1 }, 'read_route_map', 'query'), call('c-2', { n: 2 }, 'read_route_map', 'query')];
  commit(assistantEntry('step-1', '', toolCalls));
  const upper = store.readHistoryInspection(SESSION).upperSequence;
  commitResult('step-1', 'c-1', { kind: 'ok', value: {} });
  commitResult('step-1', 'c-2', { kind: 'rejected', code: 'nope', message: '不' });

  const current = new Map(callsAll().map(entry => [entry.callId, entry]));
  expect(current.get('c-1')?.status).toBe('ok');
  expect(current.get('c-2')?.status).toBe('rejected');
  expect(current.get('c-1')?.activityStatus).toBe('rejected');

  // 上界停在模型响应上：那时还没有任何结果，活动也还没有结局。
  const frozen = new Map(store.readHistoryCalls({ coordinatorSessionId: SESSION, upperSequence: upper }).calls.map(entry => [entry.callId, entry]));
  expect(frozen.get('c-1')?.result).toBeNull();
  expect(frozen.get('c-1')?.status).toBe('unconfirmed');
  expect(frozen.get('c-1')?.activityStatus).toBe('unconfirmed');
  expect(frozen.get('c-1')?.activityCount).toBe(2);
});

test('精确来源定位：命中可以直接指向同一次响应里的任意调用', () => {
  const toolCalls = Array.from({ length: 120 }, (_, index) => call(`c-${String(index)}`, { n: index }));
  commit(assistantEntry('step-wide', '', toolCalls));
  const entryId = assistantEntryId('step-wide');
  // 该调用排在第一页之外，仍可直接定位，不需要先翻页。
  const hit = store.readHistoryCalls({ coordinatorSessionId: SESSION, entryId, callId: 'c-119' }).calls;
  expect(hit).toHaveLength(1);
  expect(hit[0]).toMatchObject({ callId: 'c-119', entryId, ordinal: 119 });
  expect(hit[0]?.activityCount).toBe(1);
  expect(store.readHistoryCalls({ coordinatorSessionId: SESSION, entryId, callId: 'c-none' }).calls).toEqual([]);
});

test('相邻 query 合入同一活动；用户消息与 action 结束活动，工具结果不结束', () => {
  commit(assistantEntry('step-1', '', [call('q1', { n: 1 }, 'read_route_map', 'query'), call('q2', { n: 2 }, 'read_route_map', 'query')]));
  commitResult('step-1', 'q1', { kind: 'ok', value: {} });
  commitResult('step-1', 'q2', { kind: 'rejected', code: 'nope', message: '不' });
  expect(store.appendMessage(SESSION, { entryId: userEntryId('submission-1'), stepId: userStepId('submission-1'), role: 'user', content: '继续' }).kind).toBe('saved');
  commit(assistantEntry('step-2', '', [call('q3', { n: 3 }, 'read_route_map', 'query')]));
  commit(assistantEntry('step-3', '', [call('a1', { n: 4 }, 'read_route_map', 'action')]));

  const calls = callsAll();
  expect(calls.map(entry => entry.callId)).toEqual(['q1', 'q2', 'q3', 'a1']);
  expect(calls[0]?.activityKind).toBe('query');
  expect(calls[0]?.activityId).toBe(calls[1]?.activityId);
  expect(calls[0]?.activityCount).toBe(2);
  // 工具结果属于已经发起的那次查询，不结束活动；用户消息结束活动。
  expect(calls[2]?.activityId).not.toBe(calls[1]?.activityId);
  expect(calls[2]?.activityCount).toBe(1);
  expect(calls[3]?.activityKind).toBe('action');
  expect(calls[3]?.activityId).not.toBe(calls[2]?.activityId);
  // 活动结局取最值得注意的成员；拒绝不被 ok 掩盖。
  expect(calls[0]?.activityStatus).toBe('rejected');
  expect(calls[2]?.activityStatus).toBe('unconfirmed');
  expect(calls[3]?.activityStatus).toBe('unconfirmed');
});

test('结局来自真实事实：配对结果优先，其次 unknown 观测，都没有才是未确认', () => {
  // 同一次查询的相邻调用合为一个活动。
  const toolCalls = [call('c-ok', { n: 1 }, 'read_route_map', 'query'), call('c-rejected', { n: 2 }, 'read_route_map', 'query'),
    call('c-observed', { n: 3 }, 'read_route_map', 'query'), call('c-silent', { n: 4 }, 'read_route_map', 'query')];
  commit(assistantEntry('step-1', '', toolCalls));
  commitResult('step-1', 'c-ok', { kind: 'ok', value: {} });
  commitResult('step-1', 'c-rejected', { kind: 'rejected', code: 'stale', message: '过期' });
  expect(store.recordToolObservation({ coordinatorSessionId: SESSION, entryId: assistantEntryId('step-1'), stepId: 'step-1', callId: 'c-observed', operationId: 'op:c-observed', kind: 'unknown', reason: '结果未知' }).kind).toBe('saved');
  const byId = new Map(callsAll().map(entry => [entry.callId, entry]));
  expect(byId.get('c-ok')?.status).toBe('ok');
  expect(byId.get('c-rejected')?.status).toBe('rejected');
  expect(byId.get('c-observed')?.status).toBe('unknown');
  expect(byId.get('c-observed')?.result).toBeNull();
  expect(byId.get('c-silent')?.status).toBe('unconfirmed');
  expect(byId.get('c-ok')?.result).toMatchObject({ entryId: toolResultEntryId('step-1', 'c-ok') });
  expect(byId.get('c-ok')?.activityStatus).toBe('unknown');
  expect(byId.get('c-silent')?.activityCount).toBe(4);
  expect(new Set(callsAll().map(entry => entry.activityId)).size).toBe(1);

  // 结果后到的观测不改写已经确定的结局。
  commitResult('step-1', 'c-observed', { kind: 'ok', value: {} });
  expect(callsAll().find(entry => entry.callId === 'c-observed')?.status).toBe('ok');
});

test('unknown 观测绑定原调用身份和序号：诊断变化仍幂等，旧上界不泄漏后续观测', () => {
  commit(assistantEntry('step-1', '', [call('c-1', { n: 1 })]));
  const upperSequence = store.readHistoryInspection(SESSION).upperSequence;
  commit(assistantEntry('step-2', '继续处理'));
  const observation = { coordinatorSessionId: SESSION, entryId: assistantEntryId('step-1'), stepId: 'step-1', callId: 'c-1', operationId: 'op:c-1', kind: 'unknown' as const, reason: '响应丢失' };
  expect(store.recordToolObservation(observation).kind).toBe('saved');
  expect(store.recordToolObservation(observation).kind).toBe('saved');
  expect(callsAll()).toHaveLength(1);
  expect(store.recordToolObservation({ ...observation, reason: '对账仍不可达' }).kind).toBe('saved');
  expect(store.recordToolObservation({ ...observation, callId: 'c-none' }).kind).toBe('failed');
  expect(store.recordToolObservation({ ...observation, operationId: 'op:other' }).kind).toBe('failed');
  // 观测从不补配对结果：工具没有真正跑完，结局仍是 unknown。
  expect(callsAll()[0]?.status).toBe('unknown');
  expect(callsAll()[0]?.result).toBeNull();
  expect(callsAll()[0]?.activityCount).toBe(1);
  expect(callsAll()[0]?.activityStatus).toBe('unknown');
  expect(store.readHistoryCalls({ coordinatorSessionId: SESSION, upperSequence }).calls[0])
    .toMatchObject({ status: 'unconfirmed', activityStatus: 'unconfirmed', result: null });
});

test('结局只认根对象的 kind：嵌套 kind 不会被误当成这次调用的结局', () => {
  const toolCalls = [call('c-nested', { n: 1 }), call('c-root', { n: 2 })];
  commit(assistantEntry('step-1', '', toolCalls));
  // 根 kind 缺失、只有嵌套 value.kind：如实保持未确认，不猜成 unknown。
  commitResult('step-1', 'c-nested', { value: { kind: 'unknown' } });
  // 根 kind 在前、嵌套 kind 在后：以根为准。
  commitResult('step-1', 'c-root', { kind: 'ok', value: { kind: 'unknown' } });
  const byId = new Map(callsAll().map(entry => [entry.callId, entry]));
  expect(byId.get('c-nested')?.status).toBe('unconfirmed');
  expect(byId.get('c-root')?.status).toBe('ok');
});

test('读取不隐式补齐：水位未就绪时调用清单为空，补齐只由显式维护推进', () => {
  commit(assistantEntry('step-1', '', [call('c-1', { n: 1 })]));
  commitResult('step-1', 'c-1', { kind: 'ok', value: 'x'.repeat(1024) });
  const before = callsAll();
  resetDerivedIndex();

  expect(callsAll()).toEqual([]);
  const snapshot = store.readHistoryInspection(SESSION);
  expect(snapshot.ready).toBe(false);
  expect(snapshot.indexedThroughSequence).toBeLessThan(snapshot.upperSequence);
  // 读端不动水位：连续读取不会自己把索引补上。
  expect(store.readHistoryInspection(SESSION)).toEqual(snapshot);
  expect(callsAll()).toEqual([]);

  const progress = store.prepareHistoryInspection();
  expect(progress.ready).toBe(true);
  const database = new DatabaseSync(databasePath);
  try {
    const source = database.prepare("SELECT SUM(length(CAST(metadata AS BLOB))) + SUM(CASE WHEN role='tool' THEN length(CAST(summary_metadata AS BLOB)) + MIN(512,byte_length) ELSE 0 END) AS bytes FROM conversation_entries WHERE coordinator_session_id=?").get(SESSION) as { bytes: number };
    expect(progress.scannedBytes).toBe(source.bytes);
  } finally { database.close(); }
  expect(store.readHistoryInspection(SESSION)).toMatchObject({ ready: true });
  expect(callsAll().map(entry => ({ callId: entry.callId, argsByteLength: entry.argsByteLength, activityId: entry.activityId })))
    .toEqual(before.map(entry => ({ callId: entry.callId, argsByteLength: entry.argsByteLength, activityId: entry.activityId })));
});

test('巨大参数跨多次调用建立精确范围；补齐期间的追加不会跳过未索引的行', () => {
  const args = { blob: 'y'.repeat(1024 * 1024) };
  const toolCalls = [call('c-1', args), call('c-2', { n: 2 })];
  commit(assistantEntry('step-1', '', toolCalls));
  const expected = callsAll().map(entry => ({ callId: entry.callId, argsByteLength: entry.argsByteLength, activityCount: entry.activityCount }));
  resetDerivedIndex();

  // 一次调用只推进固定字节：1 MiB 参数不可能在一次调用里建立定位。
  const first = store.prepareHistoryInspection();
  expect(first.scannedBytes).toBeLessThanOrEqual(64 * 1024);
  expect(first.scannedItems).toBeLessThanOrEqual(100);
  expect(first.ready).toBe(false);
  // 补齐期间到来的新提交不会把水位推过仍未索引的行。
  expect(store.appendMessage(SESSION, { entryId: userEntryId('submission-late'), stepId: userStepId('submission-late'), role: 'user', content: '补齐期间的消息' }).kind).toBe('saved');

  let rounds = 0, done = false;
  while (!done && rounds < 100) {
    const progress = store.prepareHistoryInspection();
    expect(progress.scannedBytes).toBeLessThanOrEqual(64 * 1024);
    expect(progress.scannedItems).toBeLessThanOrEqual(100);
    done = progress.ready;
    rounds += 1;
  }
  expect(done).toBe(true);
  expect(rounds).toBeGreaterThan(1);
  expect(store.readHistoryInspection(SESSION)).toMatchObject({ ready: true });
  // 重扫没有产生第二条调用，也没有把活动计数加两次。
  expect(callsAll().map(entry => ({ callId: entry.callId, argsByteLength: entry.argsByteLength, activityCount: entry.activityCount }))).toEqual(expected);
  // 巨大参数按范围仍能逐字读回原文。
  const huge = callsAll()[0]!;
  let offset = 0, text = '';
  while (offset < huge.argsByteLength) {
    const range = store.readHistoryArguments({ coordinatorSessionId: SESSION, entryId: huge.entryId, stepId: huge.stepId, callId: huge.callId, contentRevision: 1, offset, maxBytes: HISTORY_BODY_BYTES });
    text += range?.text ?? '';
    offset = range?.end ?? offset;
  }
  expect(text).toBe(JSON.stringify(args));
  expect(store.readUserHistoryPage({ coordinatorSessionId: SESSION, direction: 'newer' }).entries.map(entry => entry.entryId)).toContain(userEntryId('submission-late'));

  // 重放同一次提交不产生第二条调用。
  const entry = assistantEntry('step-1', '', toolCalls);
  expect(store.appendModelStep({ coordinatorSessionId: SESSION, graphPosition: 'tools', entry, step: stepOf(entry, toolCalls) }).kind).toBe('saved');
  expect(callsAll()).toHaveLength(2);
  expect(callsAll().every(entry => entry.activityCount === 1)).toBe(true);
});

test('活动过滤是一次定位：向旧方向给组尾、向新方向给组首，折叠组不必逐页展开', () => {
  const toolCalls = Array.from({ length: 150 }, (_, index) => call(`q-${String(index)}`, { n: index }, 'read_route_map', 'query'));
  commit(assistantEntry('step-wide', '', toolCalls));
  const activityId = callsAll()[0]?.activityId ?? '';

  const page = store.readHistoryCalls({ coordinatorSessionId: SESSION, upperSequence: 10, direction: 'newer' });
  expect(page.calls).toHaveLength(100);
  expect(page.hasMore).toBe(true);
  expect(new Set(page.calls.map(entry => entry.activityId))).toEqual(new Set([activityId]));
  expect(page.calls[0]?.activityCount).toBe(150);

  const fromNewer = store.readHistoryCalls({ coordinatorSessionId: SESSION, activityId, direction: 'older' });
  const fromOlder = store.readHistoryCalls({ coordinatorSessionId: SESSION, activityId, direction: 'newer' });
  expect(fromNewer.calls).toHaveLength(1);
  expect(fromNewer.calls[0]?.callId).toBe('q-149');
  expect(fromOlder.calls[0]?.callId).toBe('q-0');
  // 越过组尾之后没有可取的成员，读取方因此知道整组已经读完。
  expect(store.readHistoryCalls({ coordinatorSessionId: SESSION, direction: 'newer', after: { sequence: fromNewer.calls[0]!.sequence, ordinal: fromNewer.calls[0]!.ordinal } }).calls).toEqual([]);
  // 固定上界之外的调用不出现。
  expect(store.readHistoryCalls({ coordinatorSessionId: SESSION, upperSequence: 0 }).calls).toEqual([]);
});

test('普通输入历史只含 role=user，并遵守固定上界与键集', () => {
  commit(assistantEntry('step-1', '', [call('c-1', { n: 1 })]));
  commitResult('step-1', 'c-1', { kind: 'ok', value: {} });
  for (const submission of ['submission-1', 'submission-2', 'submission-3'])
    expect(store.appendMessage(SESSION, { entryId: userEntryId(submission), stepId: userStepId(submission), role: 'user', content: `消息 ${submission}` }).kind).toBe('saved');

  const page = store.readUserHistoryPage({ coordinatorSessionId: SESSION, upperSequence: 10, direction: 'newer' });
  expect(page.entries.map(entry => entry.entryId)).toEqual([userEntryId('submission-1'), userEntryId('submission-2'), userEntryId('submission-3')]);
  expect(page.entries.every(entry => entry.role === 'user')).toBe(true);
  const older = store.readUserHistoryPage({ coordinatorSessionId: SESSION, upperSequence: 10, before: page.entries[2]!.sequence, direction: 'older' });
  expect(older.entries.map(entry => entry.entryId)).toEqual([userEntryId('submission-1'), userEntryId('submission-2')]);
  expect(store.readUserHistoryPage({ coordinatorSessionId: SESSION, upperSequence: 3 }).entries.map(entry => entry.entryId)).toEqual([userEntryId('submission-1')]);
});

test('工具结果只在原调用身份成立时才配对', () => {
  commit(assistantEntry('step-1', '', [call('c-1', { n: 1 }, 'read_route_map')]));
  const wrongName: CommittedMessageEntry = { entryId: toolResultEntryId('step-1', 'c-1'), stepId: 'step-1', role: 'tool', content: '{"kind":"ok"}', toolCallId: 'c-1', toolName: 'claim_ticket' };
  expect(store.appendToolResult({ coordinatorSessionId: SESSION, graphPosition: 'tools', entry: wrongName }).kind).toBe('failed');
  const unknownCall: CommittedMessageEntry = { ...wrongName, entryId: toolResultEntryId('step-1', 'c-9'), toolCallId: 'c-9' };
  expect(store.appendToolResult({ coordinatorSessionId: SESSION, graphPosition: 'tools', entry: unknownCall }).kind).toBe('failed');
  expect(callsAll()[0]?.result).toBeNull();
  expect(callsAll()[0]?.status).toBe('unconfirmed');
});

test('配对建立在上一步身份上：stepId 必须是产生该调用的模型 step', () => {
  const toolCalls = [call('c-1', { n: 1 }), call('c-2', { n: 2 })];
  const assistant = assistantEntry('step-1', '', toolCalls);
  const resultOf = (callId: string, stepId: string): CommittedMessageEntry => ({ entryId: toolResultEntryId(stepId, callId), stepId, role: 'tool', content: '{"kind":"ok","value":{}}', toolCallId: callId, toolName: 'read_route_map' });

  // 批量保存把 model step 放在它的 canonical 条目之后、工具结果之前，因此结果在写入时就已配对。
  expect(store.saveCheckpoint({ ...emptyState(), committedMessages: [assistant, resultOf('c-1', 'step-1'), resultOf('c-2', 'result-step-9')],
    committedModelSteps: [stepOf(assistant, toolCalls)] }).kind).toBe('saved');
  const byId = new Map(callsAll().map(entry => [entry.callId, entry]));
  expect(byId.get('c-1')?.status).toBe('ok');
  expect(byId.get('c-1')?.result?.entryId).toBe(toolResultEntryId('step-1', 'c-1'));
  // 另一个 stepId 没有对应的 model step：不猜它属于哪个调用，保持未确认，也不阻塞水位。
  expect(byId.get('c-2')?.status).toBe('unconfirmed');
  expect(byId.get('c-2')?.result).toBeNull();
  expect(store.prepareHistoryInspection().ready).toBe(true);
  expect(store.readHistoryInspection(SESSION).ready).toBe(true);

  // 同一步的合法结果补上后立即配对，结局按结果重算。
  commitResult('step-1', 'c-2', { kind: 'rejected', code: 'nope', message: '不' });
  expect(callsAll().find(entry => entry.callId === 'c-2')?.status).toBe('rejected');
});

test('补齐不修复结构上无法归属的结果：没有 model step 就不猜，水位照常就绪', () => {
  const toolCalls = [call('c-1', { n: 1 })];
  const assistant = assistantEntry('step-1', '', toolCalls);
  // 只导入消息、没有 model step 的历史：结果没有可证明的归属。
  expect(store.saveCheckpoint({ ...emptyState(), committedMessages: [assistant, { entryId: toolResultEntryId('step-1', 'c-1'), stepId: 'step-1', role: 'tool', content: '{"kind":"ok"}', toolCallId: 'c-1', toolName: 'read_route_map' }] }).kind).toBe('saved');
  expect(store.prepareHistoryInspection().ready).toBe(true);
  expect(callsAll()[0]?.status).toBe('unconfirmed');
  expect(callsAll()[0]?.result).toBeNull();
});

test('无效、孤儿与重复的结果不会拖住补齐：它们保持未配对，待办照常结清', () => {
  const toolCalls = [call('c-1', { n: 1 })];
  const assistant = assistantEntry('step-1', '', toolCalls);
  const tool = (entryId: string, callId: string, name = 'read_route_map'): CommittedMessageEntry => ({ entryId, stepId: 'step-1', role: 'tool', content: '{"kind":"ok"}', toolCallId: callId, toolName: name });
  // 合法结果、callId 不存在、工具名不符、以及重复占用同一个 call 的第二条结果。
  expect(store.saveCheckpoint({ ...emptyState(), committedMessages: [assistant, tool(toolResultEntryId('step-1', 'c-1'), 'c-1'),
    tool('orphan-call', 'c-none'), tool('wrong-name', 'c-1', 'claim_ticket'), tool('duplicate-call', 'c-1')],
  committedModelSteps: [stepOf(assistant, toolCalls)] }).kind).toBe('saved');

  // 补齐既不重试也无法把它们配上，但每次都推进：待办不会原地打转，水位照常就绪。
  expect(store.prepareHistoryInspection()).toMatchObject({ ready: true, scannedItems: 0 });
  const byId = new Map(callsAll().map(entry => [entry.callId, entry]));
  expect(byId.get('c-1')?.status).toBe('ok');
  expect(byId.get('c-1')?.result?.entryId).toBe(toolResultEntryId('step-1', 'c-1'));
  expect(store.readHistoryInspection(SESSION).ready).toBe(true);
});

test('延后落地的结果回到旧序号时，计数链由有界重放纠正而不是留下陈旧版本', () => {
  const first = [call('c-1', { n: 1 }, 'read_route_map', 'query'), call('c-2', { n: 2 }, 'read_route_map', 'query')];
  const second = [call('c-3', { n: 3 }, 'read_route_map', 'query')];
  const assistant = assistantEntry('step-1', '', first), later = assistantEntry('step-2', '', second);
  const result: CommittedMessageEntry = { entryId: toolResultEntryId('step-1', 'c-1'), stepId: 'step-1', role: 'tool',
    content: '{"kind":"rejected","code":"denied","message":"不"}', toolCallId: 'c-1', toolName: 'read_route_map' };
  // 分批导入的第一批只有消息、没有 model step：结果落盘时归属不可证明，因此延后。
  const messages = [assistant, result, later];
  expect(store.saveCheckpoint({ ...emptyState(), committedMessages: messages }).kind).toBe('saved');
  expect(store.readHistoryInspection(SESSION).ready).toBe(false);
  expect(callsAll()[0]?.activityCount).toBe(3);

  // 第二批补上 model step。补齐随后把结果接回它自己的序号（比活动最新的计数更早），
  // 因此必须重放纠正更晚的版本，而不是留下陈旧计数。
  expect(store.saveCheckpoint({ ...emptyState(), committedMessages: messages, committedModelSteps: [stepOf(assistant, first), stepOf(later, second)] }).kind).toBe('saved');
  let rounds = 0, done = false;
  while (!done && rounds < 20) {
    const progress = store.prepareHistoryInspection();
    expect(progress.scannedItems).toBeLessThanOrEqual(100);
    done = progress.ready;
    rounds += 1;
  }
  expect(done).toBe(true);
  // 更晚的计数版本已被重放纠正：被拒的成员没有被后面那次未确认计数覆盖。
  const group = callsAll()[0];
  expect(group?.activityStatus).toBe('rejected');
  expect(group?.activityCount).toBe(3);
  expect(callsAll().find(entry => entry.callId === 'c-1')?.status).toBe('rejected');
});

test('大活动重放跨多次批次、连续序号不跳号', () => {
  // 一个活动 250 个成员，序号连续；延后结果落在最早的序号上，因此重放要跨多批。
  const assistants: CommittedMessageEntry[] = [], steps: CommittedModelStep[] = [];
  for (let index = 0; index < 250; index += 1) {
    const toolCall = call(`c-${String(index)}`, { n: index }, 'read_route_map', 'query');
    const entry = assistantEntry(`step-${String(index)}`, '', [toolCall]);
    assistants.push(entry);
    steps.push(stepOf(entry, [toolCall]));
  }
  const first = assistants[0]!;
  const result: CommittedMessageEntry = { entryId: toolResultEntryId(first.stepId, 'c-0'), stepId: first.stepId, role: 'tool',
    content: '{"kind":"rejected","code":"denied","message":"不"}', toolCallId: 'c-0', toolName: 'read_route_map' };
  const messages = [first, result, ...assistants.slice(1)];
  expect(store.saveCheckpoint({ ...emptyState(), committedMessages: messages }).kind).toBe('saved');
  expect(store.saveCheckpoint({ ...emptyState(), committedMessages: messages, committedModelSteps: steps }).kind).toBe('saved');

  let rounds = 0, done = false;
  while (!done && rounds < 50) {
    const progress = store.prepareHistoryInspection();
    expect(progress.scannedItems).toBeLessThanOrEqual(100);
    done = progress.ready;
    rounds += 1;
  }
  expect(done).toBe(true);
  // 250 个连续序号全部被重放：没有跳号，最早那个被拒成员没有被后面的计数覆盖。
  expect(rounds).toBeGreaterThan(1);
  const group = callsAll()[0];
  expect(group?.activityCount).toBe(250);
  expect(group?.activityStatus).toBe('rejected');
  const statusOf = (callId: string): string | undefined => store.readHistoryCalls({ coordinatorSessionId: SESSION, callId }).calls[0]?.status;
  expect(statusOf('c-0')).toBe('rejected');
  expect(statusOf('c-249')).toBe('unconfirmed');
});

test('待办探测走索引：会话内只从水位往后读，已索引前缀不进查询计划', () => {
  commit(assistantEntry('step-1', '', [call('c-1', { n: 1 }, 'read_route_map', 'query')]));
  while (!store.prepareHistoryInspection().ready) { /* 补齐是显式维护 */ }
  withRawDatabase(raw => {
    const plan = (sql: string): string => (raw.prepare('EXPLAIN QUERY PLAN ' + sql).all() as { detail: string }[]).map(row => row.detail).join(' | ');
    const session = plan('SELECT s.coordinator_session_id AS id FROM coordinator_sessions s JOIN history_inspection_progress p ON p.coordinator_session_id=s.coordinator_session_id WHERE (SELECT MAX(seq) FROM conversation_entries WHERE coordinator_session_id=s.coordinator_session_id) > p.indexed_through_seq ORDER BY s.updated_at DESC,s.coordinator_session_id LIMIT 1');
    const entry = plan('SELECT seq FROM conversation_entries WHERE coordinator_session_id=? AND seq>? ORDER BY seq LIMIT 1');
    // 会话内查找必须是主键索引上的区间扫描，而不是从头扫表。
    expect(session).not.toMatch(/SCAN conversation_entries/);
    expect(entry).toMatch(/SEARCH conversation_entries/);
  });
});
