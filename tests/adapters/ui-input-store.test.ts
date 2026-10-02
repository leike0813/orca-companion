import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, expect, test } from 'vitest';

import {
  DEFAULT_UI_INPUT_LIMITS,
  conflictKey,
  submissionKey,
  targetDraftKey,
  type UiAnswerTarget,
  type UiDraft,
  type UiInputLimits,
  type UiInputRecord,
  type UiInputStoreHandle,
  type UiInputTarget,
  type UiInputValue,
  type UiMessageTarget,
  type UiSubmissionStatus,
} from '../../src/application/ports/ui-input-store.js';
import { UI_INPUT_SCHEMA_VERSION, openUiInputStore } from '../../src/adapters/storage/ui-input-store.js';

const SCOPE = 'scope-1';
const SCOPE_2 = 'scope-2';
const SESSION_A = 'session-a';
const SESSION_B = 'session-b';

let directory = '';
let databasePath = '';
let store: UiInputStoreHandle;

function openInputs(limits?: UiInputLimits): UiInputStoreHandle {
  const options = limits === undefined ? { databasePath } : { databasePath, limits };
  const opened = openUiInputStore(options);
  if (opened.kind !== 'opened') {
    throw new Error(opened.message);
  }
  return opened.store;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-ui-inputs-'));
  databasePath = join(directory, 'ui.sqlite');
  store = openInputs();
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

function messageTarget(scopeId = SCOPE, sessionId = SESSION_A): UiMessageTarget {
  return { kind: 'message', coordinationScopeId: scopeId, coordinatorSessionId: sessionId };
}

function answerTarget(interactionId = 'interaction-1', expectedRevision = 3): UiAnswerTarget {
  return { kind: 'answer', coordinationScopeId: SCOPE, coordinatorSessionId: SESSION_A, interactionId, expectedRevision };
}

function draft(text: string, pasteBlocks: UiDraft['pasteBlocks'] = []): UiDraft {
  return { text, cursor: text.length, pasteBlocks };
}

function draftValue(target: UiInputTarget, text: string): UiInputValue {
  return { kind: 'draft', target, draft: draft(text) };
}

function submissionValue(
  target: UiInputTarget,
  submissionId: string,
  status: UiSubmissionStatus = 'awaiting',
  reason: string | null = null,
): UiInputValue {
  return { kind: 'submission', target, draft: draft('要发送的内容'), submissionId, status, reason };
}

function writeDraft(target: UiInputTarget, text: string): UiInputRecord {
  const result = store.write({ key: targetDraftKey(target), expectedRevision: 0, record: draftValue(target, text) });
  if (result.kind !== 'saved') {
    throw new Error(`写入失败：${result.kind}`);
  }
  return result.record;
}

function readText(target: UiInputTarget): string | null {
  const read = store.read(targetDraftKey(target));
  return read.kind === 'record' && read.record !== null && read.record.kind !== 'submission'
    ? read.record.draft.text
    : null;
}

function utf8Bytes(...texts: readonly string[]): number {
  return texts.reduce((total, text) => total + Buffer.byteLength(text, 'utf8'), 0);
}

function rawRow(sql: string, ...params: readonly string[]): unknown {
  const raw = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return raw.prepare(sql).get(...params);
  } finally {
    raw.close();
  }
}

test('默认上限是每仓库 256 条与 32 MiB，并写入 schema 版本位', () => {
  expect(DEFAULT_UI_INPUT_LIMITS).toEqual({ maxRecords: 256, maxBytes: 32 * 1024 * 1024 });
  store.close();
  const row = rawRow('SELECT value FROM ui_input_meta WHERE key = ?', 'ui_input_schema_version') as
    | { readonly value: string }
    | undefined;
  expect(row?.value).toBe(String(UI_INPUT_SCHEMA_VERSION));
});

test('草稿、光标与粘贴载荷跨重启完整恢复', () => {
  const target = messageTarget();
  const pasteBlocks = [
    { id: 'paste-1', start: 0, end: 2 },
    { id: 'paste-2', start: 5, end: 7 },
  ];
  const value: UiInputValue = {
    kind: 'draft',
    target,
    draft: { text: '多行中文\n正文', cursor: 4, pasteBlocks },
  };
  expect(store.write({ key: targetDraftKey(target), expectedRevision: 0, record: value })).toMatchObject({
    kind: 'saved',
    record: { revision: 1 },
  });

  store.close();
  store = openInputs();

  const read = store.read(targetDraftKey(target));
  expect(read).toEqual({
    kind: 'record',
    record: { kind: 'draft', target, draft: { text: '多行中文\n正文', cursor: 4, pasteBlocks }, key: targetDraftKey(target), revision: 1 },
    revision: 1,
  });
});

test('消息、回答与不同 Session 的草稿互不影响，usage 计量整库', () => {
  writeDraft(messageTarget(SCOPE, SESSION_A), 'A 的普通草稿');
  writeDraft(messageTarget(SCOPE, SESSION_B), 'B 的普通草稿');
  writeDraft(answerTarget('interaction-1', 3), '回答草稿');
  writeDraft(messageTarget(SCOPE_2), '别的 Scope');

  const listed = store.list(SCOPE);
  expect(listed.kind).toBe('records');
  if (listed.kind !== 'records') {
    return;
  }
  expect(listed.records.map((record) => record.key).sort()).toEqual(
    [targetDraftKey(messageTarget(SCOPE, SESSION_A)), targetDraftKey(messageTarget(SCOPE, SESSION_B)), targetDraftKey(answerTarget('interaction-1', 3))].sort(),
  );
  expect(listed.invalidRecords).toEqual([]);
  expect(listed.usage).toEqual({
    records: 4,
    bytes: utf8Bytes('A 的普通草稿', 'B 的普通草稿', '回答草稿', '别的 Scope'),
  });
  expect(readText(messageTarget(SCOPE, SESSION_A))).toBe('A 的普通草稿');
  expect(readText(messageTarget(SCOPE, SESSION_B))).toBe('B 的普通草稿');
  expect(readText(messageTarget(SCOPE_2))).toBe('别的 Scope');
});

test('同一交互不同 expected revision 的回答草稿相互隔离', () => {
  const older = answerTarget('interaction-1', 3);
  const newer = answerTarget('interaction-1', 4);
  expect(targetDraftKey(older)).not.toBe(targetDraftKey(newer));

  writeDraft(older, '旧 revision 的回答');
  writeDraft(newer, '新 revision 的回答');

  expect(readText(older)).toBe('旧 revision 的回答');
  expect(readText(newer)).toBe('新 revision 的回答');
});

test('记录 key 按目标种类稳定派生且互不冲突', () => {
  const message = messageTarget();
  expect(targetDraftKey(message)).toBe(JSON.stringify(['draft', SCOPE, SESSION_A]));
  expect(targetDraftKey(answerTarget('interaction-9', 7))).toBe(
    JSON.stringify(['draft', SCOPE, SESSION_A, 'interaction-9', 7]),
  );
  expect(submissionKey(message, 'submission-1')).toBe(JSON.stringify(['submission', SCOPE, SESSION_A, 'submission-1']));
  expect(conflictKey(message, 'conflict-1')).toBe(JSON.stringify(['conflict', SCOPE, SESSION_A, 'conflict-1']));
  expect(
    new Set([
      targetDraftKey(message),
      targetDraftKey(answerTarget()),
      submissionKey(message, 'same-id'),
      conflictKey(message, 'same-id'),
    ]).size,
  ).toBe(4);
});

test('读取不存在的 key 返回空记录与 revision 0', () => {
  expect(store.read('missing-key')).toEqual({ kind: 'record', record: null, revision: 0 });
});

test('CAS 冲突保留双方内容，按冲突返回的 revision 重试可写入', () => {
  const target = messageTarget();
  const key = targetDraftKey(target);
  expect(store.write({ key, expectedRevision: 0, record: draftValue(target, '第一次') })).toMatchObject({
    kind: 'saved',
    record: { revision: 1 },
  });

  const stale = store.write({ key, expectedRevision: 0, record: draftValue(target, '竞争写入') });
  expect(stale).toMatchObject({
    kind: 'conflict',
    revision: 1,
    current: { draft: { text: '第一次' }, revision: 1 },
  });
  if (stale.kind !== 'conflict') {
    return;
  }

  expect(store.write({ key, expectedRevision: stale.revision, record: draftValue(target, '竞争写入') })).toMatchObject({
    kind: 'saved',
    record: { revision: 2 },
  });
  expect(readText(target)).toBe('竞争写入');
});

test('两个连接以同一 revision 写入时只有一个成功', () => {
  const other = openInputs();
  try {
    const target = messageTarget();
    const key = targetDraftKey(target);
    expect(store.write({ key, expectedRevision: 0, record: draftValue(target, '连接一') })).toMatchObject({ kind: 'saved' });

    expect(other.write({ key, expectedRevision: 0, record: draftValue(target, '连接二') })).toMatchObject({
      kind: 'conflict',
      revision: 1,
      current: { draft: { text: '连接一' } },
    });
    expect(other.read(key)).toMatchObject({ kind: 'record', record: { draft: { text: '连接一' } } });
  } finally {
    other.close();
  }
});

test('删除后旧版本的写入被拒绝，按当前 revision 重建可行', () => {
  const target = messageTarget();
  const key = targetDraftKey(target);
  writeDraft(target, '将被删除');

  expect(store.remove({ key, expectedRevision: 1 })).toEqual({ kind: 'removed', revision: 2 });
  expect(store.read(key)).toEqual({ kind: 'record', record: null, revision: 2 });
  expect(store.write({ key, expectedRevision: 1, record: draftValue(target, '拿旧版本回来') })).toEqual({
    kind: 'conflict',
    current: null,
    revision: 2,
  });
  expect(store.write({ key, expectedRevision: 2, record: draftValue(target, '重建') })).toMatchObject({
    kind: 'saved',
    record: { revision: 3 },
  });
  expect(readText(target)).toBe('重建');
});

test('删除不存在的 key 只留下 tombstone 版本', () => {
  const key = 'ghost-key';
  expect(store.remove({ key, expectedRevision: 0 })).toEqual({ kind: 'removed', revision: 1 });
  expect(store.read(key)).toEqual({ kind: 'record', record: null, revision: 1 });
  expect(store.write({ key, expectedRevision: 0, record: draftValue(messageTarget(), '迟到写入') })).toEqual({
    kind: 'conflict',
    current: null,
    revision: 1,
  });
  expect(store.write({ key, expectedRevision: 1, record: draftValue(messageTarget(), '当前版本写入') })).toMatchObject({
    kind: 'saved',
    record: { revision: 2 },
  });
});

test('记录数满额时保留既有记录并拒绝新写入', () => {
  store.close();
  store = openInputs({ maxRecords: 1, maxBytes: 1024 * 1024 });
  const first = writeDraft(messageTarget(SCOPE, SESSION_A), '第一条');

  const second = store.write({
    key: targetDraftKey(messageTarget(SCOPE, SESSION_B)),
    expectedRevision: 0,
    record: draftValue(messageTarget(SCOPE, SESSION_B), '第二条'),
  });
  expect(second).toMatchObject({ kind: 'failed', code: 'capacity_exceeded' });
  expect(store.read(first.key)).toMatchObject({ kind: 'record', record: { draft: { text: '第一条' } } });
  expect(store.list(SCOPE)).toMatchObject({ kind: 'records', usage: { records: 1 } });
});

test('容量按唯一展开正文的 UTF-8 字节计算', () => {
  store.close();
  store = openInputs({ maxRecords: 16, maxBytes: 8 });
  const target = messageTarget();
  const value: UiInputValue = {
    kind: 'draft',
    target,
    draft: { text: '你好ab', cursor: 4, pasteBlocks: [{ id: 'paste-1', start: 2, end: 4 }] },
  };
  expect(store.write({ key: targetDraftKey(target), expectedRevision: 0, record: value })).toMatchObject({ kind: 'saved' });

  const other = messageTarget(SCOPE, SESSION_B);
  expect(store.write({ key: targetDraftKey(other), expectedRevision: 0, record: draftValue(other, 'ab') })).toMatchObject({
    kind: 'failed',
    code: 'capacity_exceeded',
  });
  expect(store.list(SCOPE)).toMatchObject({ kind: 'records', usage: { records: 1, bytes: 8 } });
});

test('草稿拒绝非法块身份、范围和 grapheme 光标，保留既有记录', () => {
  const target = messageTarget();
  const key = targetDraftKey(target);
  expect(store.write({ key, expectedRevision: 0, record: draftValue(target, '既有') }).kind).toBe('saved');
  const invalid: UiDraft[] = [
    { text: '😀', cursor: 1, pasteBlocks: [] },
    { text: 'abcd', cursor: 2, pasteBlocks: [{ id: 'x', start: 1, end: 3 }] },
    { text: 'abcd', cursor: 4, pasteBlocks: [{ id: 'x', start: 0, end: 2 }, { id: 'x', start: 2, end: 4 }] },
    { text: 'abcd', cursor: 4, pasteBlocks: [{ id: 'x', start: 0, end: 3 }, { id: 'y', start: 2, end: 4 }] },
    { text: 'a', cursor: 1, pasteBlocks: [{ id: 'x', start: 0, end: 2 }] },
  ];
  for (const draft of invalid) expect(store.write({ key, expectedRevision: 1, record: { kind: 'draft', target, draft } }).kind).toBe('failed');
  expect(store.read(key)).toMatchObject({ kind: 'record', record: { revision: 1, draft: { text: '既有' } } });
});

test('更新既有记录不额外占用记录位', () => {
  store.close();
  store = openInputs({ maxRecords: 1, maxBytes: 1024 });
  const target = messageTarget();
  writeDraft(target, '第一版');

  expect(
    store.write({ key: targetDraftKey(target), expectedRevision: 1, record: draftValue(target, '第二版更长一些') }),
  ).toMatchObject({ kind: 'saved', record: { revision: 2 } });
  expect(store.list(SCOPE)).toMatchObject({ kind: 'records', usage: { records: 1 } });
});

test('删除释放的记录位可以再写', () => {
  store.close();
  store = openInputs({ maxRecords: 1, maxBytes: 1024 });
  const first = writeDraft(messageTarget(SCOPE, SESSION_A), '第一条');
  expect(store.remove({ key: first.key, expectedRevision: first.revision })).toMatchObject({ kind: 'removed' });

  const second = writeDraft(messageTarget(SCOPE, SESSION_B), '第二条');
  expect(store.read(second.key)).toMatchObject({ kind: 'record', record: { draft: { text: '第二条' } } });
  expect(store.list(SCOPE)).toMatchObject({ kind: 'records', usage: { records: 1 } });
});

test('同一 Session 最多一条活跃提交，明确拒绝后释放等待位', () => {
  const target = messageTarget(SCOPE, SESSION_A);
  const firstKey = submissionKey(target, 'submission-1');
  expect(store.write({ key: firstKey, expectedRevision: 0, record: submissionValue(target, 'submission-1') })).toMatchObject({
    kind: 'saved',
    record: { revision: 1 },
  });

  expect(
    store.write({
      key: submissionKey(target, 'submission-2'),
      expectedRevision: 0,
      record: submissionValue(target, 'submission-2'),
    }),
  ).toMatchObject({ kind: 'failed', code: 'submission_lane_busy' });

  const otherSession = messageTarget(SCOPE, SESSION_B);
  expect(
    store.write({
      key: submissionKey(otherSession, 'submission-3'),
      expectedRevision: 0,
      record: submissionValue(otherSession, 'submission-3'),
    }),
  ).toMatchObject({ kind: 'saved' });

  expect(
    store.write({
      key: firstKey,
      expectedRevision: 1,
      record: submissionValue(target, 'submission-1', 'rejected', '正文冲突'),
    }),
  ).toMatchObject({ kind: 'saved', record: { revision: 2, status: 'rejected' } });

  expect(
    store.write({
      key: submissionKey(target, 'submission-4'),
      expectedRevision: 0,
      record: submissionValue(target, 'submission-4'),
    }),
  ).toMatchObject({ kind: 'saved' });
});

test('无法解析的记录进入 invalidRecords，read 与 write 都 fail closed，只能显式删除', () => {
  const target = messageTarget();
  const key = targetDraftKey(target);
  const saved = writeDraft(target, '稍后损坏');

  store.close();
  const raw = new DatabaseSync(databasePath);
  raw.prepare('UPDATE ui_input SET value = ? WHERE key = ?').run('{ 不是 JSON', key);
  raw.close();
  store = openInputs();

  expect(store.list(SCOPE)).toEqual({
    kind: 'records',
    records: [],
    invalidRecords: [{ key, revision: saved.revision }],
    usage: { records: 1, bytes: utf8Bytes('稍后损坏') },
  });
  expect(store.read(key)).toMatchObject({ kind: 'failed', code: 'record_invalid' });
  expect(store.write({ key, expectedRevision: saved.revision, record: draftValue(target, '覆盖损坏记录') })).toMatchObject({
    kind: 'failed',
    code: 'record_invalid',
  });
  expect(store.list(SCOPE)).toMatchObject({
    kind: 'records',
    invalidRecords: [{ key, revision: saved.revision }],
    usage: { records: 1, bytes: utf8Bytes('稍后损坏') },
  });
  expect(store.remove({ key, expectedRevision: saved.revision })).toEqual({ kind: 'removed', revision: saved.revision + 1 });
  expect(store.list(SCOPE)).toEqual({
    kind: 'records',
    records: [],
    invalidRecords: [],
    usage: { records: 0, bytes: 0 },
  });
});

test('非法记录与非法 revision 在写入前被拒绝', () => {
  const target = messageTarget();
  const key = targetDraftKey(target);
  const withExtraField = {
    kind: 'draft',
    target,
    draft: { text: 'x', cursor: 0, pasteBlocks: [], extra: true },
  };
  expect(store.write({ key, expectedRevision: 0, record: withExtraField as unknown as UiInputValue })).toMatchObject({
    kind: 'failed',
    code: 'record_invalid',
  });
  expect(store.write({ key, expectedRevision: -1, record: draftValue(target, 'x') })).toMatchObject({
    kind: 'failed',
    code: 'invalid_request',
  });
  expect(store.read(key)).toEqual({ kind: 'record', record: null, revision: 0 });
});

test('关闭后所有方法返回 failed 且可以重复 close', () => {
  store.close();
  expect(store.read('key')).toMatchObject({ kind: 'failed', code: 'store_closed' });
  expect(store.list(SCOPE)).toMatchObject({ kind: 'failed', code: 'store_closed' });
  expect(store.write({ key: 'key', expectedRevision: 0, record: draftValue(messageTarget(), 'x') })).toMatchObject({
    kind: 'failed',
    code: 'store_closed',
  });
  expect(store.remove({ key: 'key', expectedRevision: 0 })).toMatchObject({ kind: 'failed', code: 'store_closed' });
  expect(() => {
    store.close();
  }).not.toThrow();
});

test.each([null, undefined])('write/remove 拒绝空入参 %s，不抛异常或改变既有记录', (input) => {
  const target = messageTarget();
  const saved = writeDraft(target, '保留正文');
  // @ts-expect-error 验证运行时边界，不允许空入参。
  expect(store.write(input)).toMatchObject({ kind: 'failed', code: 'invalid_request' });
  // @ts-expect-error 验证运行时边界，不允许空入参。
  expect(store.remove(input)).toMatchObject({ kind: 'failed', code: 'invalid_request' });
  expect(store.read(saved.key)).toEqual({ kind: 'record', record: saved, revision: saved.revision });
});

test('内存库可用于预览装配', () => {
  const opened = openUiInputStore({ databasePath: ':memory:' });
  expect(opened.kind).toBe('opened');
  if (opened.kind !== 'opened') {
    return;
  }
  const target = messageTarget();
  expect(
    opened.store.write({ key: targetDraftKey(target), expectedRevision: 0, record: draftValue(target, '内存草稿') }),
  ).toMatchObject({ kind: 'saved' });
  expect(opened.store.read(targetDraftKey(target))).toMatchObject({
    kind: 'record',
    record: { draft: { text: '内存草稿' } },
  });
  opened.store.close();
});

test('schema 版本不认识时拒绝打开', () => {
  store.close();
  const raw = new DatabaseSync(databasePath);
  raw.prepare('INSERT INTO ui_input_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    'ui_input_schema_version',
    '99',
  );
  raw.close();

  expect(openUiInputStore({ databasePath })).toMatchObject({ kind: 'failed', code: 'schema_version_unsupported' });
});

test('schema 版本按精确字符串比较，前缀相同的版本也被拒绝', () => {
  store.close();
  const raw = new DatabaseSync(databasePath);
  raw.prepare('INSERT INTO ui_input_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    'ui_input_schema_version',
    `${String(UI_INPUT_SCHEMA_VERSION)}junk`,
  );
  raw.close();

  expect(openUiInputStore({ databasePath })).toMatchObject({ kind: 'failed', code: 'schema_version_unsupported' });
});

test.each(['both', 'ui_input', 'ui_input_meta'])('已有 %s 表但缺版本时拒绝打开且保留数据库', (tables) => {
  writeDraft(messageTarget(), '保留正文');
  store.close();
  const raw = new DatabaseSync(databasePath);
  try {
    const existingValue = raw.prepare('SELECT value FROM ui_input').get();
    raw.prepare('DELETE FROM ui_input_meta WHERE key = ?').run('ui_input_schema_version');
    if (tables === 'ui_input') raw.exec('DROP TABLE ui_input_meta');
    if (tables === 'ui_input_meta') raw.exec('DROP TABLE ui_input');
    expect(openUiInputStore({ databasePath })).toMatchObject({ kind: 'failed', code: 'schema_version_unsupported' });
    if (tables !== 'ui_input') {
      expect(raw.prepare('SELECT value FROM ui_input_meta WHERE key = ?').get('ui_input_schema_version')).toBeUndefined();
    }
    if (tables !== 'ui_input_meta') {
      expect(raw.prepare('SELECT value FROM ui_input').get()).toEqual(existingValue);
    }
  } finally {
    raw.close();
  }
});

test('已有文件但没有 UI 表的空库可以初始化', () => {
  const emptyPath = join(directory, 'empty.sqlite');
  new DatabaseSync(emptyPath).close();
  const opened = openUiInputStore({ databasePath: emptyPath });
  expect(opened.kind).toBe('opened');
  if (opened.kind === 'opened') {
    expect(opened.store.list(SCOPE)).toMatchObject({ kind: 'records', usage: { records: 0, bytes: 0 } });
    opened.store.close();
  }
});
