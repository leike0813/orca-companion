/**
 * 测试用的内存 `TranscriptReadingPort`：只为权威历史提供 keyset 元数据和 UTF-8 字节范围。
 *
 * 预览不是这里的职责——需要预览的测试直接用生产 `transcript-preview-store`，免得出现第二份预览语义。
 * 本 fixture 也不解析 Markdown、不排版：它只复刻读取合同（100 条 / 64 KiB 一页、范围两端停在字符
 * 边界、tool 正文剥掉 viewmodel 补在首行的工具名），替身越薄，reader 的行为越可信。
 */

import { HistoryBoundaryError, HISTORY_BODY_BYTES, HISTORY_PAGE_BYTES, HISTORY_PAGE_ITEMS, type HistoryMetadata, type HistoryMetadataPage, type HistoryPageQuery, type TranscriptBodyQuery, type TranscriptBodyRange, type TranscriptReadingPort } from '../../src/application/coordinator/history.js';
import type { ControllerTranscriptPage } from '../../src/application/controller-service.js';
import { DURABLE_MESSAGE_ROLES, type DurableMessageRole } from '../../src/domain/coordinator/session-state.js';

export const TRANSCRIPT_FIXTURE_SESSION = 'session-fixture';

export type TranscriptFixtureMessage = {
  readonly role: DurableMessageRole;
  readonly content: string;
  readonly stepId?: string | null;
  readonly entryId?: string;
  readonly toolName?: string;
};
export type TranscriptReadingFixtureOptions = {
  readonly coordinatorSessionId?: string;
  /** 每次读取都重新投影的来源，用来模拟同一个 Session 持续追加。 */
  readonly page?: () => ControllerTranscriptPage;
  readonly messages?: readonly TranscriptFixtureMessage[];
};
const decoder = new TextDecoder('utf-8', { fatal: true });

/** UTF-8 安全的字节范围；`offset` 不在字符边界上时按合同的边界错误拒绝。 */
function sliceRange(bytes: Uint8Array, offset: number, maxBytes: number): { text: string; end: number } | null {
  if (offset > bytes.length) return null;
  if (offset > 0 && offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) {
    throw new HistoryBoundaryError('offset is not a UTF-8 boundary');
  }
  let end = Math.min(bytes.length, offset + maxBytes);
  while (end > offset && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return { text: decoder.decode(bytes.subarray(offset, end)), end };
}
function toRole(role: string): DurableMessageRole {
  const found = DURABLE_MESSAGE_ROLES.find(candidate => candidate === role);
  if (found === undefined) throw new Error('fixture message has an unknown role: ' + role);
  return found;
}
/** viewmodel 的 tool 行把工具名放在首行；权威正文只含工具输出。 */
function toolBody(content: string): string {
  const newline = content.indexOf('\n');
  return newline === -1 ? '' : content.slice(newline + 1);
}
export function createTranscriptReadingFixture(
  options: TranscriptReadingFixtureOptions = {},
): TranscriptReadingPort {
  const coordinatorSessionId = options.coordinatorSessionId ?? TRANSCRIPT_FIXTURE_SESSION;
  const empty: HistoryMetadataPage = { entries: [], hasMore: false };
  const messages = (): readonly TranscriptFixtureMessage[] => {
    if (options.page === undefined) {
      return options.messages ?? [];
    }
    return (options.page()?.messages ?? []).map(message => ({
      role: toRole(message.role),
      content: message.content,
      ...(message.stepId === null || message.stepId === undefined ? {} : { stepId: message.stepId }),
      ...(message.entryId === undefined ? {} : { entryId: message.entryId }),
    }));
  };
  const entries = (): readonly { meta: HistoryMetadata; bytes: Uint8Array }[] => messages()
    .filter(message => message.role !== 'system')
    .map((message, index) => {
      const entryId = message.entryId ?? message.stepId ?? 'entry:' + String(index + 1);
      const bytes = new TextEncoder().encode(message.role === 'tool' ? toolBody(message.content) : message.content);
      return { bytes, meta: { entryId, stepId: message.stepId ?? entryId, role: message.role,
        sequence: index + 1, contentRevision: 1 as const, byteLength: bytes.length,
        ...(message.toolName === undefined ? {} : { toolName: message.toolName }) } };
    });
  return {
    history(query: HistoryPageQuery): Promise<HistoryMetadataPage> {
      if (query.coordinatorSessionId !== coordinatorSessionId) {
        return Promise.resolve(empty);
      }
      const newer = query.direction === 'newer';
      const bound = newer ? query.after ?? 0 : query.before ?? Number.MAX_SAFE_INTEGER;
      const matching = entries().filter(entry => (newer ? entry.meta.sequence > bound : entry.meta.sequence < bound));
      const window = newer ? matching.slice(0, HISTORY_PAGE_ITEMS) : matching.slice(-HISTORY_PAGE_ITEMS);
      const page: HistoryMetadata[] = [];
      let bytes = 2;
      for (const entry of window) {
        const size = Buffer.byteLength(JSON.stringify(entry.meta)) + (page.length > 0 ? 1 : 0);
        if (bytes + size > HISTORY_PAGE_BYTES) {
          break;
        }
        page.push(entry.meta);
        bytes += size;
      }
      return Promise.resolve({ entries: page, hasMore: page.length < matching.length });
    },
    body(query: TranscriptBodyQuery): Promise<TranscriptBodyRange | null> {
      const source = query.source;
      if (source.kind !== 'history' || query.coordinatorSessionId !== coordinatorSessionId) {
        return Promise.resolve(null);
      }
      // 边界错误以 rejected promise 出现，和生产 async port 的形状一致，reader 才能同样 await。
      return Promise.resolve().then(() => {
        const entry = entries().find(item => item.meta.entryId === source.entryId);
        if (entry === undefined) return null;
        const range = sliceRange(entry.bytes, query.offset, Math.min(query.maxBytes, HISTORY_BODY_BYTES));
        return range === null ? null
          : { source, offset: query.offset, end: range.end, byteLength: entry.bytes.length, text: range.text };
      });
    },
    previews: () => Promise.resolve([]),
    pin: () => () => {},
    subscribe: () => () => {},
  };
}
