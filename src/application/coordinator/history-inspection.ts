/** IC-04/11: bounded references into the sole committed Session history. */
import { z } from 'zod';
import type { HistoryMetadataPage, TranscriptBodyRange, TranscriptSourceRef } from './history.js';

const integer = z.number().int().nonnegative();
const identity = z.string().min(1);
export const callPositionSchema = z.strictObject({ sequence: integer, ordinal: integer });
export type CallPosition = z.infer<typeof callPositionSchema>;
export const inspectionQuerySchema = z.strictObject({ coordinatorSessionId: identity });
export type HistoryInspectionSnapshot = {
  readonly upperSequence: number;
  readonly indexedThroughSequence: number;
  readonly ready: boolean;
};
export const historyCallQuerySchema = z.strictObject({
  coordinatorSessionId: identity, upperSequence: integer.optional(),
  before: callPositionSchema.optional(), after: callPositionSchema.optional(),
  direction: z.enum(['older', 'newer']).optional(), entryId: identity.optional(), callId: identity.optional(), activityId: identity.optional(),
}).refine(q => q.before === undefined || q.after === undefined);
export type HistoryCallQuery = z.infer<typeof historyCallQuerySchema>;
export type HistoryToolObservation = {
  readonly coordinatorSessionId: string;
  readonly entryId: string;
  readonly stepId: string;
  readonly callId: string;
  readonly operationId: string;
  readonly kind: 'unknown';
  readonly reason: string;
};
export type HistoryCall = CallPosition & {
  readonly entryId: string;
  readonly stepId: string;
  readonly callId: string;
  readonly name: string;
  readonly operationId: string;
  readonly activityKind: 'query' | 'action' | 'unclassified';
  /** First trusted call identity; stable across keyset pages. */
  readonly activityId: string;
  readonly activityCount?: number;
  readonly activityStatus?: 'ok' | 'rejected' | 'unknown' | 'unconfirmed';
  readonly argsByteLength: number;
  readonly result: null | { readonly entryId: string; readonly sequence: number; readonly byteLength: number };
  readonly status: 'ok' | 'rejected' | 'unknown' | 'unconfirmed';
};
export type HistoryCallPage = { readonly calls: readonly HistoryCall[]; readonly hasMore: boolean };
export const historyArgumentsQuerySchema = z.strictObject({
  coordinatorSessionId: identity, entryId: identity, stepId: identity, callId: identity,
  contentRevision: z.literal(1), offset: integer, maxBytes: z.number().int().min(4).max(64 * 1024),
});
export type HistoryArgumentsQuery = z.infer<typeof historyArgumentsQuerySchema>;
export const userHistoryQuerySchema = z.strictObject({
  coordinatorSessionId: identity, upperSequence: integer.optional(), before: integer.optional(), after: integer.optional(),
  direction: z.enum(['older', 'newer']).optional(),
}).refine(q => q.before === undefined || q.after === undefined);
export type UserHistoryQuery = z.infer<typeof userHistoryQuerySchema>;
export const historySearchQuerySchema = z.strictObject({
  coordinatorSessionId: identity, target: z.enum(['transcript', 'users']),
  literal: z.string().refine(s => [...s].length <= 256), upperSequence: integer,
  cursor: z.string().max(4096).nullable().optional(),
});
export type HistorySearchQuery = z.infer<typeof historySearchQuerySchema>;
export type HistorySearchHit = {
  readonly ordinal?: number;
  readonly source: TranscriptSourceRef;
  readonly sequence: number;
  readonly offset: number;
  readonly end: number;
};
export type HistorySearchPage = {
  readonly hits: readonly HistorySearchHit[];
  readonly cursor: string | null;
  readonly complete: boolean;
  readonly scannedBytes: number;
  readonly scannedItems: number;
};
export type HistoryInspectionReadingPort = {
  readonly snapshot: (coordinatorSessionId: string) => Promise<HistoryInspectionSnapshot>;
  readonly calls: (query: HistoryCallQuery) => Promise<HistoryCallPage>;
  readonly users: (query: UserHistoryQuery) => Promise<HistoryMetadataPage>;
  readonly search?: (query: HistorySearchQuery, signal?: AbortSignal) => Promise<HistorySearchPage>;
};
export type HistoryInspectionStorePort = {
  readonly readHistoryInspection: (coordinatorSessionId: string) => HistoryInspectionSnapshot;
  readonly readHistoryCalls: (query: HistoryCallQuery) => HistoryCallPage;
  readonly readUserHistoryPage: (query: UserHistoryQuery) => HistoryMetadataPage;
  readonly readHistoryArguments: (query: HistoryArgumentsQuery) => TranscriptBodyRange | null;
  /** Explicit Bootstrap maintenance, never invoked by read methods. */
  readonly prepareHistoryInspection: () => { readonly ready: boolean; readonly scannedBytes: number; readonly scannedItems: number };
};
