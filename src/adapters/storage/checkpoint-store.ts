/** IC-04: authoritative incremental records; LangGraph owns its checkpoint tables. */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import type { CoordinatorSessionId } from '../../application/dto/identity.js';
import type { CoordinatorSessionRecordPort, CheckpointRecoveryRead, CheckpointWriteResult } from '../../application/coordinator/runtime-guard.js';
import type { WakeCheckpointCommit } from '../../application/coordinator/wake-admission.js';
import { HistoryBoundaryError, HISTORY_CHUNK_BYTES, HISTORY_PAGE_BYTES, HISTORY_PAGE_ITEMS, HISTORY_BODY_BYTES, CONTEXT_READ_BYTES, CONTEXT_READ_ITEMS, historyBodyQuerySchema, historyPageQuerySchema, type CheckpointReadPurpose, type HistoryReadPort, type HistoryMetadata } from '../../application/coordinator/history.js';
import { COORDINATOR_SESSION_STATE_SCHEMA_VERSION, parseCoordinatorSessionState, userEntryId, userStepId, type NativeCompactedWindowOwner, type PortableContextCapsule, type CommittedMessageEntry, type CommittedModelStep, type CoordinatorSessionState, type WakeBatch } from '../../domain/coordinator/session-state.js';
import { describeError } from './schema.js';
export const CHECKPOINT_SCHEMA_VERSION = 2;
export type CommittedMessageRange = {
    readonly replacedFromStepId: string;
    readonly replacedToStepId: string;
};
export type CheckpointStore = CoordinatorSessionRecordPort & HistoryReadPort & {
    readonly checkpointer: BaseCheckpointSaver;
    readCommittedMessages(id: CoordinatorSessionId, range?: CommittedMessageRange): readonly CommittedMessageEntry[];
    saveNativeWindowOwner(id: CoordinatorSessionId, owner: NativeCompactedWindowOwner): CheckpointWriteResult;
    loadNativeWindowOwner(id: CoordinatorSessionId): NativeCompactedWindowOwner | null;
    clearNativeWindowOwner(id: CoordinatorSessionId): CheckpointWriteResult;
    savePortableCapsule(id: CoordinatorSessionId, capsule: PortableContextCapsule): CheckpointWriteResult;
    loadPortableCapsule(id: CoordinatorSessionId): PortableContextCapsule | null;
    commitWakeBatch(batch: WakeBatch): WakeCheckpointCommit;
    close(): void;
};
export type CheckpointStoreOpenFailureCode = 'unreadable' | 'schema_version_unsupported' | 'migration_failed';
export type OpenCheckpointStoreResult = {
    readonly kind: 'opened';
    readonly store: CheckpointStore;
} | {
    readonly kind: 'failed';
    readonly code: CheckpointStoreOpenFailureCode;
    readonly message: string;
};
export type OpenCheckpointStoreOptions = {
    readonly databasePath: string;
    readonly clock?: () => number;
};
type Statement = {
    run(...params: readonly unknown[]): unknown;
    get(...params: readonly unknown[]): unknown;
    all(...params: readonly unknown[]): unknown;
};
type Database = {
    prepare(sql: string): Statement;
    exec(sql: string): void;
    close(): void;
};
type RecoveryRow = {
    seq: number;
    entry_id: string;
    byte_length: number;
    metadata_length: number;
};
type EntryRow = {
    seq: number;
    metadata: string;
    byte_length: number;
};
type Core = Omit<CoordinatorSessionState, 'committedMessages' | 'committedModelSteps' | 'wakeBatches' | 'contextMaterial'>;
const empty = (id: CoordinatorSessionId): CoordinatorSessionState => ({ schemaVersion: COORDINATOR_SESSION_STATE_SCHEMA_VERSION, coordinatorSessionId: id, graphPosition: 'suspend', lastCompactionOutcome: null, committedMessages: [], committedModelSteps: [], wakeBatches: [] });
function valid(state: CoordinatorSessionState): CoordinatorSessionState {
    const parsed = parseCoordinatorSessionState(state);
    if (!parsed.ok)
        throw new Error(parsed.field + ': ' + parsed.message);
    return parsed.value;
}
function headOf(state: CoordinatorSessionState): Core {
    return { schemaVersion: state.schemaVersion, coordinatorSessionId: state.coordinatorSessionId,
        graphPosition: state.graphPosition, lastCompactionOutcome: state.lastCompactionOutcome };
}
const failed = (error: unknown): CheckpointWriteResult => ({ kind: 'failed', message: describeError(error) });
export function openCheckpointStore(options: OpenCheckpointStoreOptions): OpenCheckpointStoreResult {
    const clock = options.clock ?? Date.now;
    let saver: SqliteSaver;
    try {
        mkdirSync(dirname(options.databasePath), { recursive: true });
        saver = SqliteSaver.fromConnString(options.databasePath);
    }
    catch (error) {
        return { kind: 'failed', code: 'unreadable', message: describeError(error) };
    }
    const db = saver.db as unknown as Database;
    const stmt = (sql: string): Statement => db.prepare(sql);
    function atomic<T>(work: () => T): T {
        db.exec('BEGIN IMMEDIATE');
        try {
            const value = work();
            db.exec('COMMIT');
            return value;
        }
        catch (error) {
            try {
                db.exec('ROLLBACK');
            }
            catch { /* retain original */ }
            throw error;
        }
    }
    try {
        const hasMeta = stmt("SELECT name FROM sqlite_master WHERE name='checkpoint_meta'").get();
        const version = hasMeta === undefined ? undefined : stmt("SELECT value FROM checkpoint_meta WHERE key='checkpoint_schema_version'").get() as {
            value: string;
        } | undefined;
        if ((version === undefined && stmt("SELECT name FROM sqlite_master WHERE name='coordinator_sessions'").get() !== undefined) || (version !== undefined && Number(version.value) !== CHECKPOINT_SCHEMA_VERSION)) {
            db.close();
            return { kind: 'failed', code: 'schema_version_unsupported', message: 'Unsupported checkpoint schema ' + (version?.value ?? 'missing') };
        }
        atomic(() => {
            db.exec([
                'CREATE TABLE IF NOT EXISTS checkpoint_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;',
                'CREATE TABLE IF NOT EXISTS coordinator_sessions (coordinator_session_id TEXT PRIMARY KEY,schema_version INTEGER NOT NULL,session_state TEXT NOT NULL,updated_at INTEGER NOT NULL) STRICT;',
                'CREATE TABLE IF NOT EXISTS conversation_entries (coordinator_session_id TEXT NOT NULL,seq INTEGER NOT NULL,entry_id TEXT NOT NULL,step_id TEXT NOT NULL,role TEXT NOT NULL,metadata TEXT NOT NULL,summary_metadata TEXT NOT NULL,byte_length INTEGER NOT NULL,work_input INTEGER NOT NULL,handled_by TEXT,PRIMARY KEY(coordinator_session_id,seq),UNIQUE(coordinator_session_id,entry_id)) STRICT;',
                'CREATE INDEX IF NOT EXISTS conversation_steps ON conversation_entries(coordinator_session_id,step_id,seq);',
                "CREATE INDEX IF NOT EXISTS conversation_visible ON conversation_entries(coordinator_session_id,seq) WHERE role!='system';",
                'CREATE INDEX IF NOT EXISTS conversation_pending ON conversation_entries(coordinator_session_id,seq) WHERE work_input=1 AND handled_by IS NULL;',
                'CREATE TABLE IF NOT EXISTS conversation_bodies (coordinator_session_id TEXT NOT NULL,entry_id TEXT NOT NULL,start INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(coordinator_session_id,entry_id,start)) STRICT;',
                'CREATE TABLE IF NOT EXISTS conversation_model_steps (coordinator_session_id TEXT NOT NULL,seq INTEGER NOT NULL,step_id TEXT NOT NULL,entry_id TEXT NOT NULL,metadata TEXT NOT NULL,PRIMARY KEY(coordinator_session_id,step_id),UNIQUE(coordinator_session_id,seq),UNIQUE(coordinator_session_id,entry_id)) STRICT;',
                'CREATE TABLE IF NOT EXISTS conversation_wakes (coordinator_session_id TEXT NOT NULL,wake_batch_id TEXT NOT NULL,metadata TEXT NOT NULL,PRIMARY KEY(coordinator_session_id,wake_batch_id)) STRICT;',
                'CREATE TABLE IF NOT EXISTS native_window_owners (coordinator_session_id TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,items TEXT NOT NULL,through_seq INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;',
                'CREATE TABLE IF NOT EXISTS portable_capsules (coordinator_session_id TEXT PRIMARY KEY,capsule_id TEXT NOT NULL,replaced_from_step_id TEXT NOT NULL,replaced_to_step_id TEXT NOT NULL,text TEXT NOT NULL,from_seq INTEGER NOT NULL,to_seq INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;',
            ].join('\n'));
            stmt("INSERT OR IGNORE INTO checkpoint_meta VALUES('checkpoint_schema_version',?)").run(String(CHECKPOINT_SCHEMA_VERSION));
        });
    }
    catch (error) {
        db.close();
        return { kind: 'failed', code: 'migration_failed', message: describeError(error) };
    }
    function core(id: string): Core | null {
        const row = stmt('SELECT session_state FROM coordinator_sessions WHERE coordinator_session_id=?').get(id) as {
            session_state: string;
        } | undefined;
        if (row === undefined)
            return null;
        const state = valid({ ...(JSON.parse(row.session_state) as Core), committedMessages: [], committedModelSteps: [], wakeBatches: [] });
        if (state.coordinatorSessionId !== id)
            throw new Error('Checkpoint identity mismatch');
        return headOf(state);
    }
    function writeCore(head: Core): void {
        stmt('INSERT INTO coordinator_sessions VALUES(?,?,?,?) ON CONFLICT(coordinator_session_id) DO UPDATE SET session_state=excluded.session_state,updated_at=excluded.updated_at')
            .run(head.coordinatorSessionId, head.schemaVersion, JSON.stringify(head), clock());
    }
    function requireCore(id: string): Core { const head = core(id); if (head === null)
        throw new Error('Session has no checkpoint: ' + id); return head; }
    function ensureCore(id: CoordinatorSessionId): void {
        if (core(id) !== null)
            return;
        writeCore(headOf(empty(id)));
    }
    function rowFor(id: string, entryId: string, summary = false): EntryRow | undefined {
        return stmt('SELECT seq,' + (summary ? 'summary_metadata AS metadata' : 'metadata') + ',byte_length FROM conversation_entries WHERE coordinator_session_id=? AND entry_id=?').get(id, entryId) as EntryRow | undefined;
    }
    function metadata(row: EntryRow): HistoryMetadata {
        const entry = valid({ ...empty('metadata' as CoordinatorSessionId), committedMessages: [{ ...(JSON.parse(row.metadata) as CommittedMessageEntry), content: '' }] }).committedMessages[0]!;
        const { content, toolCalls, ...rest } = entry;
        void content;
        void toolCalls;
        return { ...rest, sequence: row.seq, contentRevision: 1, byteLength: row.byte_length };
    }
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const readHistoryBody: HistoryReadPort['readHistoryBody'] = (input) => {
        const q = historyBodyQuerySchema.parse(input);
        requireCore(q.coordinatorSessionId);
        const row = rowFor(q.coordinatorSessionId, q.entryId, true);
        if (row === undefined)
            return null;
        if (q.offset > row.byte_length)
            throw new Error('Body offset outside content');
        const limit = q.maxBytes ?? HISTORY_BODY_BYTES;
        const blocks = stmt('SELECT start,data FROM conversation_bodies WHERE coordinator_session_id=? AND entry_id=? AND start>=? AND start<? ORDER BY start')
            .all(q.coordinatorSessionId, q.entryId, Math.floor(q.offset / HISTORY_CHUNK_BYTES) * HISTORY_CHUNK_BYTES, q.offset + limit + 4) as {
            start: number;
            data: Uint8Array;
        }[];
        let expected = Math.floor(q.offset / HISTORY_CHUNK_BYTES) * HISTORY_CHUNK_BYTES;
        for (const block of blocks) {
            if (block.start !== expected || block.data.byteLength !== Math.min(HISTORY_CHUNK_BYTES, row.byte_length - block.start))
                throw new Error('Corrupt body blocks');
            expected += block.data.byteLength;
        }
        if (expected < Math.min(row.byte_length, q.offset + limit))
            throw new Error('Missing body blocks');
        const buffer = Buffer.concat(blocks.map(block => Buffer.from(block.data)));
        const start = q.offset - (blocks[0]?.start ?? q.offset);
        if (start < buffer.length && (buffer[start]! & 0xc0) === 0x80)
            throw new HistoryBoundaryError('Body offset is not a UTF-8 boundary');
        let end = Math.min(buffer.length, start + limit);
        while (end < buffer.length && end > start && (buffer[end]! & 0xc0) === 0x80)
            end -= 1;
        const text = decoder.decode(buffer.subarray(start, end)), absoluteEnd = q.offset + Math.max(0, end - start);
        if (q.offset < row.byte_length && absoluteEnd === q.offset)
            throw new Error('Body range missing');
        return { entryId: q.entryId, contentRevision: 1, offset: q.offset, end: absoluteEnd, byteLength: row.byte_length, text };
    };
    function readEntry(id: string, entryId: string): CommittedMessageEntry | null {
        requireCore(id);
        const row = rowFor(id, entryId);
        if (row === undefined)
            return null;
        let content = '';
        for (let offset = 0; offset < row.byte_length;) {
            const range = readHistoryBody({ coordinatorSessionId: id, entryId, contentRevision: 1, offset });
            if (range === null)
                throw new Error('Missing entry body');
            content += range.text;
            offset = range.end;
        }
        return valid({ ...empty(id as CoordinatorSessionId), committedMessages: [{ ...(JSON.parse(row.metadata) as CommittedMessageEntry), content }] }).committedMessages[0]!;
    }
    function insertEntry(id: string, input: CommittedMessageEntry): boolean {
        const entry = valid({ ...empty(id as CoordinatorSessionId), committedMessages: [input] }).committedMessages[0]!, existing = readEntry(id, entry.entryId);
        if (existing !== null) {
            if (JSON.stringify(existing) !== JSON.stringify(entry))
                throw new Error('Entry identity content conflict: ' + entry.entryId);
            return false;
        }
        const seq = (stmt('SELECT seq FROM conversation_entries WHERE coordinator_session_id=? ORDER BY seq DESC LIMIT 1').get(id) as {
            seq: number;
        } | undefined)?.seq ?? 0;
        const { content, ...meta } = entry, summary = { ...meta }, bytes = Buffer.from(content, 'utf8'), work = entry.role === 'user' || entry.entryId.startsWith('entry:interaction-answer:');
        delete summary.toolCalls;
        if (Buffer.byteLength(JSON.stringify(summary)) > HISTORY_PAGE_BYTES)
            throw new Error('History metadata exceeds page budget');
        stmt('INSERT INTO conversation_entries VALUES(?,?,?,?,?,?,?,?,?,NULL)').run(id, seq + 1, entry.entryId, entry.stepId, entry.role, JSON.stringify(meta), JSON.stringify(summary), bytes.length, work ? 1 : 0);
        for (let start = 0; start < bytes.length; start += HISTORY_CHUNK_BYTES)
            stmt('INSERT INTO conversation_bodies VALUES(?,?,?,?)').run(id, entry.entryId, start, bytes.subarray(start, start + HISTORY_CHUNK_BYTES));
        const source = entry.completedWorkSource;
        if (source !== undefined) {
            const target = source.sourceKind === 'user-message' ? userEntryId(source.sourceId) : source.sourceKind === 'interaction-answer' ? 'entry:interaction-answer:' + source.sourceId : null;
            if (target !== null)
                stmt('UPDATE conversation_entries SET handled_by=? WHERE coordinator_session_id=? AND entry_id=? AND handled_by IS NULL').run(entry.entryId, id, target);
        }
        else if (entry.role === 'assistant' && (entry.toolCalls?.length ?? 0) === 0) {
            stmt('UPDATE conversation_entries SET handled_by=? WHERE coordinator_session_id=? AND seq=(SELECT seq FROM conversation_entries WHERE coordinator_session_id=? AND work_input=1 AND handled_by IS NULL ORDER BY seq LIMIT 1)').run(entry.entryId, id, id);
        }
        return true;
    }
    function insertStep(id: string, step: CommittedModelStep): void {
        const row = rowFor(id, step.entryId);
        if (row === undefined)
            throw new Error('Step has no entry');
        const { messages, toolCalls, ...rest } = step;
        void toolCalls;
        const canonical = readEntry(id, step.entryId)!;
        if (messages.length !== 1)
            throw new Error('A model step must reference exactly one canonical entry');
        const shapes = messages.map(message => { if (typeof message !== 'object' || message === null || Array.isArray(message))
            throw new Error('Step message must be a durable object'); const shape = { ...message as Record<string, unknown> }; if (shape.content !== canonical.content)
            throw new Error('Step body differs from canonical entry'); delete shape.content; delete shape.toolCalls; return shape; });
        if (JSON.stringify(step.toolCalls) !== JSON.stringify(canonical.toolCalls ?? []))
            throw new Error('Step tool calls differ from canonical entry');
        const old = stmt('SELECT metadata FROM conversation_model_steps WHERE coordinator_session_id=? AND step_id=?').get(id, step.stepId) as {
            metadata: string;
        } | undefined;
        if (old !== undefined) {
            const value = JSON.parse(old.metadata) as {
                entryId: string;
                shapes: unknown;
            };
            if (value.entryId !== step.entryId || JSON.stringify(value.shapes) !== JSON.stringify(shapes))
                throw new Error('Step identity conflict');
            return;
        }
        const serialized = JSON.stringify({ ...rest, shapes });
        if (Buffer.byteLength(serialized) > HISTORY_PAGE_BYTES)
            throw new Error('Model step metadata exceeds budget');
        stmt('INSERT INTO conversation_model_steps VALUES(?,?,?,?,?)').run(id, row.seq, step.stepId, step.entryId, serialized);
    }
    function stepsFor(id: string, entries: readonly CommittedMessageEntry[], budget = Infinity): CommittedModelStep[] {
        return entries.flatMap(entry => {
            const row = stmt('SELECT CAST(substr(CAST(metadata AS BLOB),1,65537) AS TEXT) AS metadata FROM conversation_model_steps WHERE coordinator_session_id=? AND entry_id=?').get(id, entry.entryId) as {
                metadata: string;
            } | undefined;
            if (row === undefined)
                return [];
            budget -= Buffer.byteLength(row.metadata);
            if (budget < 0 || Buffer.byteLength(row.metadata) > HISTORY_PAGE_BYTES)
                throw new Error('context_exhausted: model step metadata budget');
            const { shapes, ...rest } = JSON.parse(row.metadata) as Omit<CommittedModelStep, 'messages' | 'toolCalls'> & {
                shapes: Record<string, unknown>[];
            };
            return [{ ...rest, toolCalls: entry.toolCalls ?? [], messages: shapes.map(shape => ({ ...shape, content: entry.content, ...(entry.toolCalls !== undefined && 'entryId' in shape ? { toolCalls: entry.toolCalls } : {}) })) }];
        });
    }
    function loadNativeWindowOwner(id: CoordinatorSessionId): NativeCompactedWindowOwner | null {
        const row = stmt('SELECT owner_ref,substr(items,1,4194305) AS items FROM native_window_owners WHERE coordinator_session_id=?').get(id) as {
            owner_ref: string;
            items: string;
        } | undefined;
        if (row === undefined)
            return null;
        if (Buffer.byteLength(row.items) > CONTEXT_READ_BYTES)
            throw new Error('context_exhausted: native window read budget');
        const owner = { ownerRef: row.owner_ref, items: JSON.parse(row.items) as NativeCompactedWindowOwner['items'] };
        return valid({ ...empty(id), contextMaterial: { nativeWindowOwner: owner, capsule: null } }).contextMaterial?.nativeWindowOwner ?? null;
    }
    function loadPortableCapsule(id: CoordinatorSessionId): PortableContextCapsule | null {
        const row = stmt('SELECT capsule_id,replaced_from_step_id,replaced_to_step_id,substr(text,1,4194305) AS text FROM portable_capsules WHERE coordinator_session_id=?').get(id) as {
            capsule_id: string;
            replaced_from_step_id: string;
            replaced_to_step_id: string;
            text: string;
        } | undefined;
        if (row === undefined)
            return null;
        if (Buffer.byteLength(row.text) > CONTEXT_READ_BYTES)
            throw new Error('context_exhausted: capsule read budget');
        const capsule: PortableContextCapsule = { kind: 'derived_context_capsule', capsuleId: row.capsule_id, replacedFromStepId: row.replaced_from_step_id, replacedToStepId: row.replaced_to_step_id, text: row.text };
        return valid({ ...empty(id), contextMaterial: { nativeWindowOwner: null, capsule } }).contextMaterial?.capsule ?? null;
    }
    function loadCheckpoint(id: CoordinatorSessionId, purpose: CheckpointReadPurpose = 'full'): CheckpointRecoveryRead {
        try {
            const head = core(id);
            if (head === null)
                return { kind: 'absent' };
            const nativeWindowOwner = loadNativeWindowOwner(id), capsule = loadPortableCapsule(id);
            let rows: RecoveryRow[] = [];
            if (purpose === 'tools') {
                const last = stmt('SELECT step_id FROM conversation_model_steps WHERE coordinator_session_id=? ORDER BY seq DESC LIMIT 1').get(id) as {
                    step_id: string;
                } | undefined;
                if (last !== undefined)
                    rows = stmt('SELECT seq,entry_id,byte_length,length(CAST(metadata AS BLOB)) AS metadata_length FROM conversation_entries WHERE coordinator_session_id=? AND step_id=? ORDER BY seq LIMIT ?').all(id, last.step_id, CONTEXT_READ_ITEMS + 1) as RecoveryRow[];
            }
            else if (purpose === 'pending')
                rows = stmt('SELECT seq,entry_id,byte_length,length(CAST(metadata AS BLOB)) AS metadata_length FROM conversation_entries WHERE coordinator_session_id=? AND work_input=1 AND handled_by IS NULL ORDER BY seq LIMIT 32').all(id) as RecoveryRow[];
            else if (purpose !== 'metadata') {
                let from = -1, to = -1;
                if (purpose === 'context' && capsule !== null) {
                    const bounds = stmt('SELECT from_seq,to_seq FROM portable_capsules WHERE coordinator_session_id=?').get(id) as {from_seq:number;to_seq:number};
                    if (bounds.from_seq > bounds.to_seq) throw new Error('Invalid Capsule range');
                    from=bounds.from_seq;to=bounds.to_seq;
                }
                {
                    const limit = purpose === 'full' ? -1 : CONTEXT_READ_ITEMS + 1;
                    if (purpose === 'context' && nativeWindowOwner !== null) {
                        const bound = stmt('SELECT through_seq FROM native_window_owners WHERE coordinator_session_id=?').get(id) as {
                            through_seq: number;
                        };
                        rows = stmt('SELECT seq,entry_id,byte_length,length(CAST(metadata AS BLOB)) AS metadata_length FROM conversation_entries WHERE coordinator_session_id=? AND seq>? ORDER BY seq LIMIT ?').all(id, bound.through_seq, limit) as RecoveryRow[];
                    }
                    else if (from < 0)
                        rows = stmt('SELECT seq,entry_id,byte_length,length(CAST(metadata AS BLOB)) AS metadata_length FROM conversation_entries WHERE coordinator_session_id=? ORDER BY seq LIMIT ?').all(id, limit) as RecoveryRow[];
                    else {
                        const before = stmt('SELECT seq,entry_id,byte_length,length(CAST(metadata AS BLOB)) AS metadata_length FROM conversation_entries WHERE coordinator_session_id=? AND seq<? ORDER BY seq LIMIT ?').all(id, from, limit) as RecoveryRow[];
                        const after = stmt('SELECT seq,entry_id,byte_length,length(CAST(metadata AS BLOB)) AS metadata_length FROM conversation_entries WHERE coordinator_session_id=? AND seq>? ORDER BY seq LIMIT ?').all(id, to, CONTEXT_READ_ITEMS + 1 - before.length) as RecoveryRow[];
                        rows = [...before, ...after];
                    }
                }
            }
            if (purpose !== 'full' && (rows.length > CONTEXT_READ_ITEMS || rows.reduce((n, r) => n + r.byte_length + r.metadata_length, 0) > CONTEXT_READ_BYTES))
                throw new Error('context_exhausted: effective history read budget exceeded');
            const entries = rows.map(row => { const entry = readEntry(id, row.entry_id); if (entry === null)
                throw new Error('Committed entry missing'); return entry; });
            const wakes = purpose === 'full' ? (stmt('SELECT metadata FROM conversation_wakes WHERE coordinator_session_id=? ORDER BY rowid').all(id) as {
                metadata: string;
            }[]).map(row => JSON.parse(row.metadata) as WakeBatch) : [];
            return { kind: 'recovered', state: valid({ ...head, committedMessages: entries, committedModelSteps: stepsFor(id, entries, purpose === 'full' ? Infinity : CONTEXT_READ_BYTES - rows.reduce((sum, row) => sum + row.byte_length + row.metadata_length, 0)), wakeBatches: wakes, ...(nativeWindowOwner === null && capsule === null ? {} : { contextMaterial: { nativeWindowOwner, capsule } }) }) };
        }
        catch (error) {
            return { kind: 'unrecoverable', reason: describeError(error) };
        }
    }
    function updateCheckpoint(id: CoordinatorSessionId, patch: Partial<Pick<CoordinatorSessionState, 'graphPosition' | 'lastCompactionOutcome'>>): CheckpointWriteResult {
        try {
            atomic(() => { const state = valid({ ...requireCore(id), ...patch, committedMessages: [], committedModelSteps: [], wakeBatches: [] }); writeCore(headOf(state)); });
            return { kind: 'saved' };
        }
        catch (error) {
            return failed(error);
        }
    }
    function putWake(batch: WakeBatch): boolean {
        const id = batch.coordinatorSessionId;
        valid({ ...empty(id as CoordinatorSessionId), wakeBatches: [batch] });
        const old = stmt('SELECT metadata FROM conversation_wakes WHERE coordinator_session_id=? AND wake_batch_id=?').get(id, batch.wakeBatchId) as {
            metadata: string;
        } | undefined;
        if (old !== undefined) {
            if (old.metadata !== JSON.stringify(batch))
                throw new Error('Wake identity conflict');
            return false;
        }
        stmt('INSERT INTO conversation_wakes VALUES(?,?,?)').run(id, batch.wakeBatchId, JSON.stringify(batch));
        return true;
    }
    const resultState = (id: CoordinatorSessionId, entries: readonly CommittedMessageEntry[] = [], wakes: readonly WakeBatch[] = []): CoordinatorSessionState => valid({ ...requireCore(id), committedMessages: entries, committedModelSteps: [], wakeBatches: wakes });
    const store: CheckpointStore = {
        checkpointer: saver, loadCheckpoint, updateCheckpoint, readEntry, readHistoryBody,
        saveCheckpoint(input) { try {
            const state = valid(input);
            atomic(() => { const { committedMessages, committedModelSteps, wakeBatches } = state; writeCore(headOf(state)); for (const entry of committedMessages)
                insertEntry(state.coordinatorSessionId, entry); for (const step of committedModelSteps)
                insertStep(state.coordinatorSessionId, step); for (const wake of wakeBatches)
                putWake(wake); });
            return { kind: 'saved' };
        }
        catch (error) {
            return failed(error);
        } },
        appendMessage(id, entry) { try {
            atomic(() => { requireCore(id); insertEntry(id, entry); });
            return { kind: 'saved' };
        }
        catch (error) {
            return failed(error);
        } },
        appendModelStep(input) { try {
            valid({ ...empty(input.coordinatorSessionId), committedMessages: [input.entry], committedModelSteps: [input.step] });
            if (input.entry.role !== 'assistant' || input.entry.entryId !== input.step.entryId || input.entry.stepId !== input.step.stepId)
                throw new Error('Model step/entry identity mismatch');
            atomic(() => { const head = requireCore(input.coordinatorSessionId), fresh = insertEntry(input.coordinatorSessionId, input.entry); insertStep(input.coordinatorSessionId, input.step); if (fresh)
                writeCore({ ...head, graphPosition: input.graphPosition }); });
            return { kind: 'saved' };
        }
        catch (error) {
            return failed(error);
        } },
        appendToolResult(input) { try {
            if (input.entry.role !== 'tool')
                throw new Error('Tool role mismatch');
            atomic(() => {
                const head = requireCore(input.coordinatorSessionId);
                const paired = stmt("SELECT e.entry_id FROM conversation_model_steps s JOIN conversation_entries e ON e.coordinator_session_id=s.coordinator_session_id AND e.entry_id=s.entry_id WHERE s.coordinator_session_id=? AND s.step_id=? AND EXISTS (SELECT 1 FROM json_each(e.metadata,'$.toolCalls') c WHERE json_extract(c.value,'$.callId')=? AND json_extract(c.value,'$.name')=?)")
                    .get(input.coordinatorSessionId, input.entry.stepId, input.entry.toolCallId, input.entry.toolName);
                if (paired === undefined) throw new Error('Tool result has no matching committed call');
                if (insertEntry(input.coordinatorSessionId, input.entry)) writeCore({ ...head, graphPosition: input.graphPosition });
            });
            return { kind: 'saved' };
        }
        catch (error) {
            return failed(error);
        } },
        commitWakeBatch(batch) { try {
            return atomic(() => { const id = batch.coordinatorSessionId as CoordinatorSessionId; ensureCore(id); const fresh = putWake(batch); return { kind: fresh ? 'committed' : 'already-committed', state: resultState(id, [], [batch]) }; });
        }
        catch (error) {
            return { kind: 'unrecoverable', reason: describeError(error) };
        } },
        commitUserMessage(input) { try {
            return atomic(() => {
                const id = input.coordinatorSessionId;
                if (input.wakeBatch.coordinatorSessionId !== id) throw new Error('User Wake Session mismatch');
                ensureCore(id);
                const old = readEntry(id, userEntryId(input.submissionId));
                if (old !== null) {
                    const row = stmt('SELECT metadata FROM conversation_wakes WHERE coordinator_session_id=? AND wake_batch_id=?').get(id, input.wakeBatch.wakeBatchId) as { metadata: string } | undefined;
                    if (row === undefined) throw new Error('User Wake identity conflict');
                    const contentMatches = old.role === 'user' && old.stepId === userStepId(input.submissionId) && old.content === input.content;
                    if (contentMatches && row.metadata !== JSON.stringify(input.wakeBatch)) throw new Error('User Wake content conflict');
                    return { kind: 'already-committed', contentMatches, state: resultState(id, [old], [JSON.parse(row.metadata) as WakeBatch]) };
                }
                const entry: CommittedMessageEntry = { entryId: userEntryId(input.submissionId), stepId: userStepId(input.submissionId), role: 'user', content: input.content };
                insertEntry(id, entry); putWake(input.wakeBatch);
                return { kind: 'committed', state: resultState(id, [entry], [input.wakeBatch]) };
            });
        }
        catch (error) {
            return { kind: 'unrecoverable', reason: describeError(error) };
        } },
        readCommittedMessages(id, range?: CommittedMessageRange) { requireCore(id); if (range === undefined) {
            const read = loadCheckpoint(id, 'full');
            if (read.kind !== 'recovered')
                throw new Error(read.kind === 'unrecoverable' ? read.reason : 'Session absent');
            return read.state.committedMessages;
        } const from = stmt('SELECT seq FROM conversation_entries WHERE coordinator_session_id=? AND step_id=? ORDER BY seq LIMIT 1').get(id, range.replacedFromStepId) as {
            seq: number;
        } | undefined, to = stmt('SELECT seq FROM conversation_entries WHERE coordinator_session_id=? AND step_id=? ORDER BY seq DESC LIMIT 1').get(id, range.replacedToStepId) as {
            seq: number;
        } | undefined; if (from === undefined || to === undefined || from.seq > to.seq)
            return []; return (stmt('SELECT entry_id FROM conversation_entries WHERE coordinator_session_id=? AND seq>=? AND seq<=? ORDER BY seq').all(id, from.seq, to.seq) as {
            entry_id: string;
        }[]).map(row => readEntry(id, row.entry_id)!); },
        readHistoryPage(input) {
            const q = historyPageQuerySchema.parse(input);
            requireCore(q.coordinatorSessionId);
            const newer = q.direction === 'newer';
            const rows = stmt("SELECT seq,entry_id,length(CAST(summary_metadata AS BLOB)) AS metadata_length FROM conversation_entries WHERE coordinator_session_id=? AND role!='system' AND seq" + (newer ? '>' : '<') + '? ORDER BY seq ' + (newer ? 'ASC' : 'DESC') + ' LIMIT ?')
                .all(q.coordinatorSessionId, newer ? q.after ?? 0 : q.before ?? Number.MAX_SAFE_INTEGER, HISTORY_PAGE_ITEMS + 1) as {
                seq: number;
                entry_id: string;
                metadata_length: number;
            }[];
            const entries: HistoryMetadata[] = [];
            let bytes = 2;
            for (const row of rows.slice(0, HISTORY_PAGE_ITEMS)) {
                if (row.metadata_length > HISTORY_PAGE_BYTES)
                    throw new Error('History metadata exceeds page budget');
                if (bytes + row.metadata_length > HISTORY_PAGE_BYTES)
                    break;
                const stored = rowFor(q.coordinatorSessionId, row.entry_id, true);
                if (stored === undefined)
                    throw new Error('History entry absent');
                const item = metadata(stored), size = Buffer.byteLength(JSON.stringify(item)) + (entries.length > 0 ? 1 : 0);
                if (size > HISTORY_PAGE_BYTES)
                    throw new Error('History metadata exceeds page budget');
                if (bytes + size > HISTORY_PAGE_BYTES)
                    break;
                entries.push(item);
                bytes += size;
            }
            return { entries: newer ? entries : entries.reverse(), hasMore: entries.length < rows.length };
        },
        loadNativeWindowOwner, loadPortableCapsule,
        saveNativeWindowOwner(id, owner) { try {
            requireCore(id);
            valid({ ...empty(id), contextMaterial: { nativeWindowOwner: owner, capsule: null } });
            atomic(() => { const bound = stmt('SELECT seq FROM conversation_entries WHERE coordinator_session_id=? ORDER BY seq DESC LIMIT 1').get(id) as {
                seq: number;
            } | undefined; stmt('INSERT INTO native_window_owners VALUES(?,?,?,?,?) ON CONFLICT(coordinator_session_id) DO UPDATE SET owner_ref=excluded.owner_ref,items=excluded.items,through_seq=excluded.through_seq,updated_at=excluded.updated_at').run(id, owner.ownerRef, JSON.stringify(owner.items), bound?.seq ?? 0, clock()); });
            return { kind: 'saved' };
        }
        catch (error) {
            return failed(error);
        } },
        savePortableCapsule(id, capsule) { try {
            requireCore(id);
            valid({ ...empty(id), contextMaterial: { nativeWindowOwner: null, capsule } });
            atomic(() => {
                const old=loadPortableCapsule(id);
                if(old?.capsuleId===capsule.capsuleId){
                    if(JSON.stringify(old)!==JSON.stringify(capsule))throw new Error('Capsule identity conflict');
                    return;
                }
                const first=stmt('SELECT seq FROM conversation_entries WHERE coordinator_session_id=? AND step_id=? ORDER BY seq LIMIT 1').get(id,capsule.replacedFromStepId) as {seq:number}|undefined;
                const last=stmt('SELECT seq FROM conversation_entries WHERE coordinator_session_id=? AND step_id=? ORDER BY seq DESC LIMIT 1').get(id,capsule.replacedToStepId) as {seq:number}|undefined;
                if(first===undefined||last===undefined||first.seq>last.seq)throw new Error('Capsule range missing');
                stmt('INSERT INTO portable_capsules VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(coordinator_session_id) DO UPDATE SET capsule_id=excluded.capsule_id,replaced_from_step_id=excluded.replaced_from_step_id,replaced_to_step_id=excluded.replaced_to_step_id,text=excluded.text,from_seq=excluded.from_seq,to_seq=excluded.to_seq,updated_at=excluded.updated_at')
                    .run(id,capsule.capsuleId,capsule.replacedFromStepId,capsule.replacedToStepId,capsule.text,first.seq,last.seq,clock());
            });
            return { kind: 'saved' };
        }
        catch (error) {
            return failed(error);
        } },
        clearNativeWindowOwner(id) { try {
            stmt('DELETE FROM native_window_owners WHERE coordinator_session_id=?').run(id);
            return { kind: 'saved' };
        }
        catch (error) {
            return failed(error);
        } },
        close() { db.close(); },
    };
    return { kind: 'opened', store };
}
