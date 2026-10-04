import {
  PROJECT_DETAILS_MAX_ITEMS,
  PROJECT_DETAILS_MAX_PAGE_BYTES,
  projectDetailQuerySchema,
  type ProjectDetailItem,
  type ProjectDetailQuery,
  type ProjectDetailsResult,
} from './project-presentation.js';
import { z } from 'zod';

const cursorSchema = z.strictObject({
  objectKey: z.string(), coordinatorSessionId: z.string(), revision: z.number().int().nonnegative().safe(),
  index: z.number().int().nonnegative().safe(), offset: z.number().int().nonnegative().safe(),
});

export type ProjectDetailField = {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  /** Present for a source-read slice, so page assembly never encodes the complete stored field. */
  readonly sourceOffset?: number;
  readonly byteLength?: number;
};

export type ProjectDetailFieldRead = {
  readonly field: Omit<ProjectDetailField, 'sourceOffset'> & { readonly sourceOffset: number } | null;
  readonly hasNext: boolean;
  readonly available?: boolean;
  readonly unavailableReason?: string;
};

/** A bounded page of one version-bound object's fields; no source I/O or state mutation. */
export function readProjectDetailPage(input: {
  readonly query: ProjectDetailQuery;
  readonly revision: number;
  readonly fields: (start: { readonly index: number; readonly offset: number }) => Iterable<ProjectDetailField>;
  readonly readField?: (start: { readonly index: number; readonly offset: number }, maxBytes: number) => ProjectDetailFieldRead;
}): ProjectDetailsResult {
  const parsed = projectDetailQuerySchema.safeParse(input.query);
  if (!parsed.success) return { kind: 'unavailable', reason: '项目详情请求无效' };
  const query = parsed.data;
  if (query.seenRevision !== input.revision) return { kind: 'stale', currentRevision: input.revision };
  const binding = { objectKey: query.objectKey, coordinatorSessionId: query.coordinatorSessionId, revision: input.revision };
  let start = { ...binding, index: 0, offset: 0 };
  if (query.after !== null) {
    let decoded: unknown;
    try { decoded = JSON.parse(query.after); } catch { return { kind: 'unavailable', reason: '项目详情游标无效' }; }
    const cursor = cursorSchema.safeParse(decoded);
    if (!cursor.success || cursor.data.objectKey !== binding.objectKey || cursor.data.coordinatorSessionId !== binding.coordinatorSessionId || cursor.data.revision !== binding.revision) {
      return { kind: 'unavailable', reason: '项目详情游标不属于当前对象版本' };
    }
    start = cursor.data;
  }
  const items: ProjectDetailItem[] = [];
  const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, index = start.index;
  let nextCursor: string | null = null;
  const fieldIterator: Iterator<ProjectDetailField, undefined> | null = input.readField === undefined
    ? input.fields({ index: start.index, offset: start.offset })[Symbol.iterator]()
    : null;
  while (true) {
    const remainingItems = PROJECT_DETAILS_MAX_ITEMS - items.length;
    if (remainingItems <= 0 || bytes >= PROJECT_DETAILS_MAX_PAGE_BYTES) {
      nextCursor = JSON.stringify({ ...binding, index, offset: index === start.index ? start.offset : 0 });
      break;
    }
    const result = input.readField === undefined ? fieldIterator?.next() : undefined;
    const fieldRead = input.readField?.({ index, offset: index === start.index ? start.offset : 0 },
      Math.max(4, PROJECT_DETAILS_MAX_PAGE_BYTES - bytes));
    if (fieldRead?.available === false) return { kind: 'unavailable', reason: fieldRead.unavailableReason ?? '项目详情源对象不可用' };
    if (input.readField !== undefined && fieldRead?.field === null) {
      if (index === start.index && items.length === 0 && start.offset > 0) return { kind: 'unavailable', reason: '项目详情游标超出原文范围' };
      break;
    }
    let field: ProjectDetailField | null;
    if (input.readField !== undefined) {
      field = fieldRead?.field ?? null;
    } else if (result !== undefined && !result.done) {
      field = result.value;
    } else {
      break;
    }
    if (field === null) {
      if (index === start.index && items.length === 0 && start.offset > 0) return { kind: 'unavailable', reason: '项目详情游标超出原文范围' };
      break;
    }
    const offset = index === start.index ? start.offset : 0;
    const sourceOffset = field.sourceOffset ?? 0;
    const value = encoder.encode(field.value);
    const byteLength = field.byteLength ?? sourceOffset + value.length;
    const localOffset = offset - sourceOffset;
    if (localOffset < 0 || offset > byteLength || localOffset > value.length ||
      (localOffset < value.length && (value[localOffset]! & 0xc0) === 0x80)) {
      return { kind: 'unavailable', reason: '项目详情原文位置无效' };
    }
    const overhead = encoder.encode(field.key).length + encoder.encode(field.label).length;
    if (overhead > PROJECT_DETAILS_MAX_PAGE_BYTES - 4) return { kind: 'unavailable', reason: '项目详情字段标签超过读取上限' };
    const room = PROJECT_DETAILS_MAX_PAGE_BYTES - bytes - overhead;
    if (remainingItems <= 0 || room < Math.min(4, byteLength - offset)) {
      nextCursor = JSON.stringify({ ...binding, index, offset });
      break;
    }
    if (room < 0) return { kind: 'unavailable', reason: '项目详情字段标签超过读取上限' };
    let consumed = Math.min(value.length - localOffset, room, byteLength - offset);
    while (consumed > 0 && localOffset + consumed < value.length && (value[localOffset + consumed]! & 0xc0) === 0x80) consumed--;
    if (consumed < value.length - localOffset && consumed === 0) return { kind: 'unavailable', reason: '项目详情源范围无法形成 UTF-8 字符' };
    const text = decoder.decode(value.subarray(localOffset, localOffset + consumed));
    const end = offset + consumed;
    items.push({ key: field.key, label: field.label, value: text, offset, end, byteLength });
    bytes += overhead + consumed;
    if (end < byteLength) {
      nextCursor = JSON.stringify({ ...binding, index, offset: end });
      break;
    }
    index++;
    if (input.readField !== undefined && !fieldRead!.hasNext) break;
  }
  if (items.length === 0 && (start.index > 0 || start.offset > 0)) return { kind: 'unavailable', reason: '项目详情游标超出原文范围' };
  return { kind: 'page', page: { ...binding, items, nextCursor } };
}
