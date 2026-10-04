import { expect, test } from 'vitest';
import { readProjectDetailPage } from '../../src/application/tui/project-details.js';
import type { ProjectDetailQuery } from '../../src/application/tui/project-presentation.js';

const query: ProjectDetailQuery = { objectKey: 'authorization', coordinatorSessionId: 'session-a', seenRevision: 7, after: null };

test('bounded pages preserve all UTF-8 fields and exact continuation ranges', () => {
  const fields = Array.from({ length: 25 }, (_, index) => ({ key: String(index), label: '字段 ' + index,
    value: index === 0 ? '中文🙂'.repeat(15000) : 'value ' + index }));
  let after: string | null = null;
  const read = new Map<string, string>();
  const source = (start: { readonly index: number; readonly offset: number }, maxBytes: number) => {
  const index = start.index;
    const field = fields[index];
    if (field === undefined) return { field: null, hasNext: false };
    const bytes = new TextEncoder().encode(field.value);
    let end = Math.min(bytes.length, start.offset + maxBytes);
    while (end < bytes.length && end > start.offset && (bytes[end]! & 0xc0) === 0x80) end--;
    return { field: { ...field, value: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start.offset, end)),
      sourceOffset: start.offset, byteLength: bytes.length }, hasNext: end < bytes.length || index + 1 < fields.length };
  };
  do {
    const result = readProjectDetailPage({ query: { ...query, after }, revision: 7, fields: () => fields, readField: source });
    if (result.kind !== 'page') throw new Error(result.kind);
    expect(result.page.items.length).toBeLessThanOrEqual(20);
    expect(result.page.items.reduce((sum, item) => sum + new TextEncoder().encode(item.key + item.label + item.value).length, 0)).toBeLessThanOrEqual(64 * 1024);
    for (const item of result.page.items) {
      const preceding = read.get(item.key) ?? '';
      expect(new TextEncoder().encode(preceding).length).toBe(item.offset);
      read.set(item.key, preceding + item.value);
    }
    after = result.page.nextCursor;
  } while (after !== null);
  expect(fields.map(field => read.get(field.key))).toEqual(fields.map(field => field.value));
});

test('stale versions and cross-object/session cursors never reveal another page', () => {
  const fields = () => Array.from({ length: 21 }, (_, index) => ({ key: String(index), label: 'field', value: 'value' }));
  const readField = (start: { readonly index: number; readonly offset: number }) => ({
    field: fields()[start.index] ? { ...fields()[start.index]!, sourceOffset: 0, byteLength: 5 } : null,
    hasNext: start.index + 1 < fields().length,
  });
  expect(readProjectDetailPage({ query, revision: 8, fields, readField })).toMatchObject({ kind: 'stale', currentRevision: 8 });
  const first = readProjectDetailPage({ query, revision: 7, fields, readField });
  if (first.kind !== 'page') throw new Error(first.kind);
  expect(first.page.nextCursor).not.toBeNull();
  for (const change of [{ objectKey: 'identity' }, { coordinatorSessionId: 'session-b' }, { seenRevision: 8 }]) {
    expect(readProjectDetailPage({ query: { ...query, after: first.page.nextCursor, ...change }, revision: 7, fields, readField }).kind).not.toBe('page');
  }
});
