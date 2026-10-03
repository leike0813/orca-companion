/**
 * 临时流式预览的存储行为：内容只增长、按 UTF-8 分片可读、旧版本冻结在已写入前缀，
 * 并且容量、Session 隔离、终态与关闭都不会让临时正文冒充权威历史。
 */

import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { afterEach, expect, test, vi } from 'vitest';

import { createTranscriptPreviewStore } from '../../src/adapters/storage/transcript-preview-store.js';
import {
  HistoryBoundaryError,
  type TranscriptBodyQuery,
  type TranscriptStreamEvent,
} from '../../src/application/coordinator/history.js';

const SESSION_A = 'session-a';
const SESSION_B = 'session-b';
const PREVIEW_DIR_PREFIX = 'orca-companion-preview-';

const stores: { close(): void }[] = [];

afterEach(() => {
  for (const store of stores) {
    store.close();
  }
  stores.length = 0;
  vi.doUnmock('node:fs');
  vi.resetModules();
});

function store(options: { readonly maxBytes?: number; readonly maxItems?: number; readonly notificationDelay?: number } = {}) {
  const created = createTranscriptPreviewStore(options);
  stores.push(created);
  return created;
}

function stream(target: ReturnType<typeof store>, session: string, previewId: string, deltas: readonly string[]): void {
  target.observe({ kind: 'started', coordinatorSessionId: session, previewId });
  for (const text of deltas) {
    target.observe({ kind: 'delta', coordinatorSessionId: session, previewId, text });
  }
}

function start(target: ReturnType<typeof store>, session: string, previewId: string) {
  return target.observe({ kind: 'started', coordinatorSessionId: session, previewId });
}

/** 读完整份预览正文；来源不可读时返回 null，可读但没有正文时返回空串。 */
function readAll(target: ReturnType<typeof store>, session: string, previewId: string, revision: number, maxBytes = 64 * 1024): string | null {
  let offset = 0;
  let text = '';
  for (;;) {
    const query: TranscriptBodyQuery = { coordinatorSessionId: session,
      source: { kind: 'preview', previewId, contentRevision: revision }, offset, maxBytes };
    const range = target.body(query);
    if (range === null) {
      return offset === 0 ? null : text;
    }
    if (range.text.length === 0) {
      return text;
    }
    text += range.text;
    offset = range.end;
  }
}

test('代理对跨 delta 切开时正文不丢字，字节范围停在 UTF-8 边界', () => {
  const target = store();
  const deltas = ['回答：', '开头🙂', '中文', '结尾'];
  stream(target, SESSION_A, 'p1', deltas);

  const preview = target.list(SESSION_A)[0]!;
  expect(readAll(target, SESSION_A, 'p1', preview.contentRevision)).toBe(deltas.join(''));
  expect(preview.byteLength).toBe(Buffer.byteLength(deltas.join('')));
  expect(preview.contentRevision).toBe(preview.byteLength + 1);

  // 范围两端都停在字符边界：4 字节的 emoji 不因为 maxBytes 落在中间而变成半个码位。
  const emojiStart = Buffer.byteLength('回答：开头');
  const exact = target.body({ coordinatorSessionId: SESSION_A,
    source: { kind: 'preview', previewId: 'p1', contentRevision: preview.contentRevision }, offset: emojiStart, maxBytes: 4 });
  expect(exact?.text).toBe('🙂');
  const partial = target.body({ coordinatorSessionId: SESSION_A,
    source: { kind: 'preview', previewId: 'p1', contentRevision: preview.contentRevision }, offset: emojiStart, maxBytes: 6 });
  expect(partial?.text).toBe('🙂');
  expect(partial?.end).toBe(emojiStart + 4);
  expect(() => target.body({ coordinatorSessionId: SESSION_A,
    source: { kind: 'preview', previewId: 'p1', contentRevision: preview.contentRevision }, offset: emojiStart + 1, maxBytes: 4 }))
    .toThrow(HistoryBoundaryError);
});

test('单个 delta 内部的 4096 字符分片同样不切开代理对', () => {
  const target = store();
  // 分片长度正好落在高代理上：4095 个 ASCII 加一个 4 字节 emoji，再跟一段尾巴。
  const content = 'a'.repeat(4095) + '🙂' + '尾巴🙂';
  stream(target, SESSION_A, 'p1', [content]);

  const preview = target.list(SESSION_A)[0]!;
  expect(readAll(target, SESSION_A, 'p1', preview.contentRevision)).toBe(content);
  expect(readAll(target, SESSION_A, 'p1', preview.contentRevision)).not.toContain('\uFFFD');
  expect(preview.byteLength).toBe(Buffer.byteLength(content));
  // 第一个分片停在 emoji 之前：4 字节一个字符的分片最多写 4095 个 ASCII。
  const firstBlock = target.body({ coordinatorSessionId: SESSION_A,
    source: { kind: 'preview', previewId: 'p1', contentRevision: preview.contentRevision }, offset: 0, maxBytes: 4095 });
  expect(firstBlock?.text).toBe('a'.repeat(4095));
  expect(firstBlock?.end).toBe(4095);
});

test('旧内容版本冻结在已写入前缀，新分片不改写它，超前版本不可读', () => {
  const target = store();
  target.observe({ kind: 'started', coordinatorSessionId: SESSION_A, previewId: 'p1' });
  target.observe({ kind: 'delta', coordinatorSessionId: SESSION_A, previewId: 'p1', text: '前半段' });
  const frozen = target.list(SESSION_A)[0]!.contentRevision;
  target.observe({ kind: 'delta', coordinatorSessionId: SESSION_A, previewId: 'p1', text: '，后半段' });
  const latest = target.list(SESSION_A)[0]!;

  expect(readAll(target, SESSION_A, 'p1', frozen)).toBe('前半段');
  expect(readAll(target, SESSION_A, 'p1', latest.contentRevision)).toBe('前半段，后半段');
  expect(latest.contentRevision).toBeGreaterThan(frozen);
  expect(target.body({ coordinatorSessionId: SESSION_A,
    source: { kind: 'preview', previewId: 'p1', contentRevision: latest.contentRevision + 1 }, offset: 0, maxBytes: 64 })).toBeNull();
});

test('预览按 Session 隔离：他人 Session 读不到、列不出、也 pin 不动', () => {
  const target = store();
  stream(target, SESSION_A, 'pa', ['A 正文']);
  stream(target, SESSION_B, 'pb', ['B 正文']);

  expect(target.list(SESSION_A).map(preview => preview.coordinatorSessionId)).toEqual([SESSION_A]);
  expect(target.list(SESSION_B).map(preview => preview.previewId)).toEqual(['pb']);
  const revision = target.list(SESSION_A)[0]!.contentRevision;
  expect(readAll(target, SESSION_A, 'pa', revision)).toBe('A 正文');
  expect(readAll(target, SESSION_B, 'pa', revision)).toBeNull();
  expect(target.body({ coordinatorSessionId: SESSION_B,
    source: { kind: 'preview', previewId: 'pa', contentRevision: revision }, offset: 0, maxBytes: 64 })).toBeNull();
  const release = target.pin(SESSION_B, 'pa');
  release();
  expect(readAll(target, SESSION_A, 'pa', revision)).toBe('A 正文');
  expect(target.body({ coordinatorSessionId: SESSION_A,
    source: { kind: 'history', entryId: 'pa', contentRevision: 1 }, offset: 0, maxBytes: 64 })).toBeNull();
});

test('pin 阻止淘汰，终态预览先于流式预览被淘汰，释放后可回收', () => {
  const target = store({ maxItems: 3 });
  stream(target, SESSION_A, 'pinned', ['固定']);
  stream(target, SESSION_A, 'done', ['已结束']);
  stream(target, SESSION_A, 'live', ['流式中']);
  const release = target.pin(SESSION_A, 'pinned');
  target.observe({ kind: 'committed', coordinatorSessionId: SESSION_A, previewId: 'done', entryId: 'entry:done' });

  stream(target, SESSION_A, 'next', ['新响应']);
  expect(target.list(SESSION_A).map(preview => preview.previewId).sort()).toEqual(['live', 'next', 'pinned']);

  release();
  stream(target, SESSION_A, 'later', ['更晚']);
  expect(target.list(SESSION_A).map(preview => preview.previewId).sort()).toEqual(['later', 'live', 'next']);
  expect(target.body({ coordinatorSessionId: SESSION_A,
    source: { kind: 'preview', previewId: 'pinned', contentRevision: 100 }, offset: 0, maxBytes: 64 })).toBeNull();
});

test('条目被固定占满时不登记新预览：上限不破，宿主拿到可记录的诊断', async () => {
  const target = store({ maxItems: 1, notificationDelay: 1 });
  stream(target, SESSION_A, 'keep', ['保留内容']);
  const release = target.pin(SESSION_A, 'keep');
  const seen: string[] = [];
  target.subscribe(session => seen.push(session));

  expect(start(target, SESSION_A, 'blocked')).toEqual({ kind: 'not_saved', reason: 'items_capacity' });
  expect(target.observe({ kind: 'delta', coordinatorSessionId: SESSION_A, previewId: 'blocked', text: '无处安放' }))
    .toEqual({ kind: 'not_saved', reason: 'unknown_preview' });
  expect(target.observe({ kind: 'committed', coordinatorSessionId: SESSION_A, previewId: 'blocked', entryId: 'entry:blocked' }))
    .toEqual({ kind: 'not_saved', reason: 'unknown_preview' });
  expect(target.list(SESSION_A).map(preview => preview.previewId)).toEqual(['keep']);
  expect(target.stats().items).toBeLessThanOrEqual(1);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(seen.length).toBeGreaterThan(0);
  expect(target.body({ coordinatorSessionId: SESSION_A,
    source: { kind: 'preview', previewId: 'blocked', contentRevision: 64 }, offset: 0, maxBytes: 64 })).toBeNull();
  expect(readAll(target, SESSION_A, 'keep', target.list(SESSION_A)[0]!.contentRevision)).toBe('保留内容');
  release();
  expect(start(target, SESSION_A, 'after')).toEqual({ kind: 'accepted' });
  expect(target.stats().items).toBeLessThanOrEqual(1);
});

test('字节容量耗尽时已登记预览转为 not_saved，完整响应提交与固定内容不受影响', () => {
  const target = store({ maxItems: 8, maxBytes: 32 });
  stream(target, SESSION_A, 'keep', ['保留内容']);
  const release = target.pin(SESSION_A, 'keep');
  expect(start(target, SESSION_A, 'big')).toEqual({ kind: 'accepted' });

  expect(target.observe({ kind: 'delta', coordinatorSessionId: SESSION_A, previewId: 'big', text: 'x'.repeat(64) }))
    .toEqual({ kind: 'not_saved', reason: 'bytes_capacity' });
  const blocked = target.list(SESSION_A).find(preview => preview.previewId === 'big')!;
  expect(blocked.status).toBe('not_saved');
  expect(blocked.byteLength).toBe(0);
  expect(blocked.contentRevision).toBe(1);
  expect(target.observe({ kind: 'delta', coordinatorSessionId: SESSION_A, previewId: 'big', text: '更多内容' }))
    .toEqual({ kind: 'not_saved', reason: 'bytes_capacity' });
  target.observe({ kind: 'committed', coordinatorSessionId: SESSION_A, previewId: 'big', entryId: 'entry:big' });
  const committed = target.list(SESSION_A).find(preview => preview.previewId === 'big')!;
  expect(committed.status).toBe('committed');
  expect(committed.entryId).toBe('entry:big');
  expect(target.body({ coordinatorSessionId: SESSION_A,
    source: { kind: 'preview', previewId: 'big', contentRevision: committed.contentRevision }, offset: 0, maxBytes: 64 }))
    .toMatchObject({ text: '', byteLength: 0 });
  release();
  expect(readAll(target, SESSION_A, 'keep', target.list(SESSION_A).find(preview => preview.previewId === 'keep')!.contentRevision))
    .toBe('保留内容');
});

test('配额超限前已写入的 prefix 保持可读：已固定版本与最新版本读出同一份正文', () => {
  const target = store({ maxBytes: 64 });
  stream(target, SESSION_A, 'p1', ['已写好的前缀🙂']);
  const frozen = target.list(SESSION_A)[0]!;
  const release = target.pin(SESSION_A, 'p1');

  // 先写成功、再超配额：失败只停止追加，不清空已经落盘的前缀。
  expect(target.observe({ kind: 'delta', coordinatorSessionId: SESSION_A, previewId: 'p1', text: 'x'.repeat(200) }))
    .toEqual({ kind: 'not_saved', reason: 'bytes_capacity' });
  const after = target.list(SESSION_A)[0]!;
  expect([after.byteLength, after.contentRevision, after.status])
    .toEqual([frozen.byteLength, frozen.contentRevision, 'not_saved']);
  expect(target.stats().bytes).toBe(frozen.byteLength);
  expect(readAll(target, SESSION_A, 'p1', frozen.contentRevision)).toBe('已写好的前缀🙂');
  expect(readAll(target, SESSION_A, 'p1', after.contentRevision)).toBe('已写好的前缀🙂');

  // 停止追加：后续分片既不写入也不推进内容版本。
  expect(target.observe({ kind: 'delta', coordinatorSessionId: SESSION_A, previewId: 'p1', text: '不再追加' }))
    .toEqual({ kind: 'not_saved', reason: 'bytes_capacity' });
  expect(target.list(SESSION_A)[0]?.contentRevision).toBe(frozen.contentRevision);
  expect(readAll(target, SESSION_A, 'p1', after.contentRevision)).toBe('已写好的前缀🙂');
  release();
  expect(target.close().disposed).toBe(1);
});

test('committed 关联正式 entry，interrupted 保留可读前缀且不冒充历史', () => {
  const target = store();
  stream(target, SESSION_A, 'p1', ['完整响应']);
  target.observe({ kind: 'committed', coordinatorSessionId: SESSION_A, previewId: 'p1', entryId: 'entry:assistant:step-1' });
  const committed = target.list(SESSION_A)[0]!;
  expect(committed.status).toBe('committed');
  expect(committed.entryId).toBe('entry:assistant:step-1');
  expect(readAll(target, SESSION_A, 'p1', committed.contentRevision)).toBe('完整响应');

  stream(target, SESSION_A, 'p2', ['未完成的前缀']);
  target.observe({ kind: 'interrupted', coordinatorSessionId: SESSION_A, previewId: 'p2', reason: 'cancelled' });
  const interrupted = target.list(SESSION_A).find(preview => preview.previewId === 'p2')!;
  expect(interrupted.status).toBe('interrupted');
  expect(interrupted.entryId).toBeNull();
  expect(readAll(target, SESSION_A, 'p2', interrupted.contentRevision)).toBe('未完成的前缀');
  target.observe({ kind: 'delta', coordinatorSessionId: SESSION_A, previewId: 'p2', text: '不应写入' });
  expect(readAll(target, SESSION_A, 'p2', interrupted.contentRevision)).toBe('未完成的前缀');
});

test('一个订阅者抛错不会带走定时器，也不会饿死其他 Session 的通知', async () => {
  const target = store({ notificationDelay: 1 });
  const seen: string[] = [];
  target.subscribe(() => {
    throw new Error('subscriber exploded');
  });
  target.subscribe(session => {
    seen.push(session);
  });
  const events: TranscriptStreamEvent[] = [
    { kind: 'started', coordinatorSessionId: SESSION_A, previewId: 'p1' },
    { kind: 'delta', coordinatorSessionId: SESSION_A, previewId: 'p1', text: '内容' },
  ];
  for (const event of events) {
    target.observe(event);
  }
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(seen).toEqual([SESSION_A]);
  expect(readAll(target, SESSION_A, 'p1', target.list(SESSION_A)[0]!.contentRevision)).toBe('内容');
});

test('close 之后不再接受事件，并清理全部临时文件', () => {
  const before = readdirSync(tmpdir()).filter(name => name.startsWith(PREVIEW_DIR_PREFIX));
  const target = store();
  stream(target, SESSION_A, 'p1', ['正文']);
  const during = readdirSync(tmpdir()).filter(name => name.startsWith(PREVIEW_DIR_PREFIX) && !before.includes(name));
  expect(during.length).toBe(1);
  expect(target.stats().items).toBe(1);

  target.close();

  expect(target.stats()).toEqual({ bytes: 0, items: 0 });
  expect(readdirSync(tmpdir()).filter(name => name.startsWith(PREVIEW_DIR_PREFIX) && !before.includes(name))).toEqual([]);
  target.observe({ kind: 'delta', coordinatorSessionId: SESSION_A, previewId: 'p1', text: '关闭后' });
  expect(target.list(SESSION_A)).toEqual([]);
  expect(target.body({ coordinatorSessionId: SESSION_A,
    source: { kind: 'preview', previewId: 'p1', contentRevision: 64 }, offset: 0, maxBytes: 64 })).toBeNull();
  target.close();
});

test('磁盘写入失败时预览明确不可用，丢弃的前缀不留下幻影内容版本', async () => {
  vi.resetModules();
  vi.doMock('node:fs', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return { ...actual, writeSync: () => { throw new Error('EIO: no space left on device'); },
      ftruncateSync: () => { throw new Error('EIO: no space left on device'); } };
  });
  const { createTranscriptPreviewStore: failing } = await import('../../src/adapters/storage/transcript-preview-store.js');
  const target = failing();
  target.observe({ kind: 'started', coordinatorSessionId: SESSION_A, previewId: 'p1' });
  target.observe({ kind: 'delta', coordinatorSessionId: SESSION_A, previewId: 'p1', text: '写不进去的正文' });

  const preview = target.list(SESSION_A)[0]!;
  expect(preview.status).toBe('not_saved');
  expect(preview.byteLength).toBe(0);
  expect(preview.contentRevision).toBe(1);
  expect(target.body({ coordinatorSessionId: SESSION_A,
    source: { kind: 'preview', previewId: 'p1', contentRevision: 64 }, offset: 0, maxBytes: 64 })).toBeNull();
  expect(target.stats().bytes).toBe(0);
  target.close();
});

test('清理失败只按条数上报，不打断模型响应与进程退出', async () => {
  vi.resetModules();
  vi.doMock('node:fs', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return { ...actual, unlinkSync: () => { throw new Error('EPERM: cannot unlink'); },
      rmdirSync: () => { throw new Error('ENOTEMPTY: directory not empty'); } };
  });
  const { createTranscriptPreviewStore: failing } = await import('../../src/adapters/storage/transcript-preview-store.js');
  const target = failing();
  stream(target, SESSION_A, 'p1', ['仍然可读']);
  const revision = target.list(SESSION_A)[0]!.contentRevision;

  // 删不掉临时文件时正文照常可读，模型与读取侧不受影响。
  expect(readAll(target, SESSION_A, 'p1', revision)).toBe('仍然可读');
  const result = target.close();

  expect(result.disposed).toBe(1);
  expect(result.failed).toBeGreaterThan(0);
  expect(target.stats()).toEqual({ bytes: 0, items: 0 });
  expect(target.close()).toEqual({ disposed: 0, failed: 0 });
});
