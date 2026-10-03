/** IC-04/11: authoritative history identities, keysets and UTF-8 ranges. */
import { z } from 'zod';
import type { CommittedMessageEntry } from '../../domain/coordinator/session-state.js';
import type { ControllerTranscriptPage, ControllerTranscriptMessage } from '../controller-service.js';

export const HISTORY_PAGE_ITEMS = 100;
export const HISTORY_PAGE_BYTES = 64 * 1024;
export const HISTORY_BODY_BYTES = 64 * 1024;
export const HISTORY_CHUNK_BYTES = 16 * 1024;
export const CONTEXT_READ_BYTES = 4 * 1024 * 1024;
export const CONTEXT_READ_ITEMS = 4096;
export type CheckpointReadPurpose = 'full' | 'migration' | 'metadata' | 'context' | 'tools' | 'pending';
export type HistoryMetadata = Omit<CommittedMessageEntry, 'content' | 'toolCalls'> & {
  readonly sequence: number;
  readonly contentRevision: 1;
  readonly byteLength: number;
};
export type HistoryPageQuery = {
  readonly coordinatorSessionId: string;
  readonly before?: number;
  readonly after?: number;
  readonly direction?: 'older' | 'newer';
};
export type HistoryMetadataPage = {
  readonly entries: readonly HistoryMetadata[];
  readonly hasMore: boolean;
};
export type HistoryBodyQuery = {
  readonly coordinatorSessionId: string;
  readonly entryId: string;
  readonly contentRevision: 1;
  readonly offset: number;
  readonly maxBytes?: number;
};
export type HistoryBodyRange = {
  readonly entryId: string;
  readonly contentRevision: 1;
  readonly offset: number;
  readonly end: number;
  readonly byteLength: number;
  readonly text: string;
};
export type HistoryReadPort = {
  readonly readHistoryPage: (query: HistoryPageQuery) => HistoryMetadataPage;
  readonly readHistoryBody: (query: HistoryBodyQuery) => HistoryBodyRange | null;
  readonly readEntry: (coordinatorSessionId: string, entryId: string) => CommittedMessageEntry | null;
};
const integer = z.number().int().nonnegative();
export const historyPageQuerySchema = z.strictObject({
  coordinatorSessionId: z.string().min(1), before: integer.optional(), after: integer.optional(),
  direction: z.enum(['older', 'newer']).optional(),
}).refine(q => q.before === undefined || q.after === undefined);
export const historyBodyQuerySchema = z.strictObject({
  coordinatorSessionId: z.string().min(1), entryId: z.string().min(1), contentRevision: z.literal(1),
  offset: integer, maxBytes: z.number().int().min(4).max(HISTORY_BODY_BYTES).optional(),
});
const cursorSchema = z.tuple([z.string().min(1), integer, integer, z.enum(['older', 'newer'])]);
export type HistoryCursor = z.infer<typeof cursorSchema>;
export function parseHistoryCursor(cursor: string, sessionId: string): HistoryCursor {
  const parsed = cursorSchema.parse(JSON.parse(cursor) as unknown);
  if (parsed[0] !== sessionId) throw new Error('history cursor belongs to another Session');
  return parsed;
}

export class HistoryBoundaryError extends RangeError {}

/** A bounded fragment of authoritative history, ordered oldest to newest. */
export function readTranscriptPage(port: HistoryReadPort, sessionId: string, cursor: string | null): ControllerTranscriptPage {
  const anchor = cursor === null || cursor === 'oldest' ? null : parseHistoryCursor(cursor, sessionId);
  const newer = cursor === 'oldest' || anchor?.[3] === 'newer';
  const page = port.readHistoryPage({ coordinatorSessionId: sessionId,
    direction: newer ? 'newer' : 'older',
    ...(anchor === null ? {} : newer
      ? { after: anchor[1] - (anchor[2] > 0 ? 1 : 0) }
      : { before: anchor[1] + (anchor[2] > 0 ? 1 : 0) }),
  });
  const rows = newer ? page.entries : [...page.entries].reverse();
  const messages: ControllerTranscriptMessage[] = [];
  let remaining = HISTORY_BODY_BYTES;
  for (const entry of rows) {
    if (remaining < 4) break;
    const boundary = anchor?.[1] === entry.sequence ? anchor[2] : newer ? 0 : entry.byteLength;
    if (newer && boundary === entry.byteLength && entry.byteLength > 0) continue;
    let offset = newer ? boundary : Math.max(0, boundary - remaining);
    let body: HistoryBodyRange | null = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        body = port.readHistoryBody({ coordinatorSessionId: sessionId, entryId: entry.entryId,
          contentRevision: 1, offset, maxBytes: remaining });
        break;
      } catch (error) {
        if (!(error instanceof HistoryBoundaryError) || newer) throw error;
        offset += 1;
      }
    }
    if (body === null) throw new Error('Authoritative history body unavailable');
    const text = newer ? body.text : new TextDecoder('utf-8', { fatal: true }).decode(
      new TextEncoder().encode(body.text).subarray(0, boundary - offset));
    const end = offset + new TextEncoder().encode(text).length;
    messages.push({ role: entry.role, content: entry.role === 'tool' ? `${entry.toolName ?? 'tool'}\n${text}` : text,
      stepId: entry.role === 'tool' ? entry.entryId : entry.stepId, entryId: entry.entryId,
      sequence: entry.sequence, offset, end, byteLength: entry.byteLength });
    remaining -= end - offset;
    if (newer ? end < entry.byteLength : offset > 0) break;
  }
  if (!newer) messages.reverse();
  const first = messages[0], last = messages.at(-1);
  // The opposite endpoint needs only an indexed metadata probe, never its body.
  const older = first !== undefined && (first.offset! > 0 || port.readHistoryPage({
    coordinatorSessionId: sessionId, before: first.sequence!, direction: 'older' }).entries.length > 0);
  const later = last !== undefined && (last.end! < last.byteLength! || port.readHistoryPage({
    coordinatorSessionId: sessionId, after: last.sequence!, direction: 'newer' }).entries.length > 0);
  return { coordinatorSessionId: sessionId, messages,
    nextCursor: older ? JSON.stringify([sessionId, first.sequence, first.offset, 'older']) : null,
    newerCursor: later ? JSON.stringify([sessionId, last.sequence, last.end! < last.byteLength! ? last.end : 0, 'newer']) : null };
}
