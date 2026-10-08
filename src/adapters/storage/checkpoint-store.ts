/** IC-04: authoritative incremental records; LangGraph owns its checkpoint tables. */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import type { CoordinatorSessionId } from '../../application/dto/identity.js';
import type { CoordinatorSessionRecordPort, CheckpointRecoveryRead, CheckpointWriteResult } from '../../application/coordinator/runtime-guard.js';
import type { WakeCheckpointCommit } from '../../application/coordinator/wake-admission.js';
import { HistoryBoundaryError, HISTORY_CHUNK_BYTES, HISTORY_PAGE_BYTES, HISTORY_PAGE_ITEMS, HISTORY_BODY_BYTES, CONTEXT_READ_BYTES, CONTEXT_READ_ITEMS, historyBodyQuerySchema, historyPageQuerySchema, type CheckpointReadPurpose, type HistoryReadPort, type HistoryMetadata, type HistoryMetadataPage, type TranscriptBodyRange } from '../../application/coordinator/history.js';
import { historyArgumentsQuerySchema, historyCallQuerySchema, userHistoryQuerySchema, type HistoryArgumentsQuery, type HistoryCall, type HistoryCallPage, type HistoryCallQuery, type HistoryInspectionSnapshot, type HistoryInspectionStorePort, type HistoryToolObservation } from '../../application/coordinator/history-inspection.js';
import { COORDINATOR_SESSION_STATE_SCHEMA_VERSION, parseCoordinatorSessionState, userEntryId, userStepId, workEntryId, type MechanicalShakeArtifact, type NativeCompactedWindowOwner, type PortableContextCapsule, type CommittedMessageEntry, type CommittedModelStep, type CoordinatorSessionState, type WakeBatch } from '../../domain/coordinator/session-state.js';
import { activityStatusOf, createMetadataScanState, scanMetadataBytes, scanMetadataText, tallyOf, TOOL_CALL_SCAN_CHUNK_BYTES, type ActivityTally, type CallStatus, type MetadataScanState, type ToolCallSpan } from './history-inspection-index.js';
import { describeError } from './schema.js';
export const CHECKPOINT_SCHEMA_VERSION = 3;

/** 可无损升级到当前版本的前驱库 schema；旧库按 `CREATE TABLE IF NOT EXISTS` 补齐后写回新版本号。 */
const UPGRADABLE_CHECKPOINT_SCHEMA_VERSIONS: ReadonlySet<number> = new Set([2, CHECKPOINT_SCHEMA_VERSION]);

/** 一次 Wake Batch metadata 读取的有界上限；超过即拒绝，不为了读一条 batch 拉进无界正文。 */
const WAKE_BATCH_METADATA_BYTES = 64 * 1024;

/** system 引用条目承载的 summary 上限；正文由来源按引用只读取得，不把它复制进历史。 */
const WORK_ENTRY_SUMMARY_CHARS = 240;

/** 内部来源：它们的引用条目由 user-message / interaction 各自的提交路径拥有，不在 putWake 里重复建条目。 */
const INTERNAL_WAKE_SOURCE_KINDS: ReadonlySet<string> = new Set(['user-message', 'interaction-answer']);
export type CommittedMessageRange = {
    readonly replacedFromStepId: string;
    readonly replacedToStepId: string;
};
export type CheckpointStore = CoordinatorSessionRecordPort & HistoryReadPort & HistoryInspectionStorePort & {
    readonly checkpointer: BaseCheckpointSaver;
    /** 可信 unknown 观测；只存真实观测，不补配对结果。 */
    readonly recordToolObservation: (input: HistoryToolObservation) => CheckpointWriteResult;
    readCommittedMessages(id: CoordinatorSessionId, range?: CommittedMessageRange): readonly CommittedMessageEntry[];
    saveNativeWindowOwner(id: CoordinatorSessionId, owner: NativeCompactedWindowOwner): CheckpointWriteResult;
    loadNativeWindowOwner(id: CoordinatorSessionId): NativeCompactedWindowOwner | null;
    clearNativeWindowOwner(id: CoordinatorSessionId): CheckpointWriteResult;
    savePortableCapsule(id: CoordinatorSessionId, capsule: PortableContextCapsule): CheckpointWriteResult;
    loadPortableCapsule(id: CoordinatorSessionId): PortableContextCapsule | null;
    saveMechanicalShake(id: CoordinatorSessionId, artifact: MechanicalShakeArtifact): CheckpointWriteResult;
    loadMechanicalShake(id: CoordinatorSessionId): MechanicalShakeArtifact | null;
    clearMechanicalShake(id: CoordinatorSessionId): CheckpointWriteResult;
    commitWakeBatch(batch: WakeBatch): WakeCheckpointCommit;
    /** 精确有界读取一条 Wake Batch 的 metadata：用户消息重放沿原 batch 保持 activationSource 与外部证据。 */
    readWakeBatch(id: CoordinatorSessionId, wakeBatchId: string): WakeBatch | null;
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
    /**
     * 单次有效上下文读取的字节上限，覆盖正文、元数据、step 与 context 材料。
     *
     * 缺省取 `CONTEXT_READ_BYTES`；超过上限按 `context_exhausted` 阻塞，权威原文仍可分页读回，
     * 因此预算只限制一次恢复读多少，不限制记录本身能存多大。
     */
    readonly contextReadBytes?: number;
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
    const contextReadBytes = options.contextReadBytes ?? CONTEXT_READ_BYTES;
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
        const existingSchemaVersion = version === undefined ? null : Number(version.value);
        if ((version === undefined && stmt("SELECT name FROM sqlite_master WHERE name='coordinator_sessions'").get() !== undefined) || (existingSchemaVersion !== null && !UPGRADABLE_CHECKPOINT_SCHEMA_VERSIONS.has(existingSchemaVersion))) {
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
                'CREATE TABLE IF NOT EXISTS conversation_replay_owners (coordinator_session_id TEXT NOT NULL,entry_id TEXT NOT NULL,configuration_ref TEXT NOT NULL,byte_length INTEGER NOT NULL,PRIMARY KEY(coordinator_session_id,entry_id)) STRICT;',
                'CREATE TABLE IF NOT EXISTS conversation_replay_bodies (coordinator_session_id TEXT NOT NULL,entry_id TEXT NOT NULL,start INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(coordinator_session_id,entry_id,start)) STRICT;',
                'CREATE TABLE IF NOT EXISTS conversation_model_steps (coordinator_session_id TEXT NOT NULL,seq INTEGER NOT NULL,step_id TEXT NOT NULL,entry_id TEXT NOT NULL,metadata TEXT NOT NULL,PRIMARY KEY(coordinator_session_id,step_id),UNIQUE(coordinator_session_id,seq),UNIQUE(coordinator_session_id,entry_id)) STRICT;',
                'CREATE TABLE IF NOT EXISTS conversation_wakes (coordinator_session_id TEXT NOT NULL,wake_batch_id TEXT NOT NULL,metadata TEXT NOT NULL,PRIMARY KEY(coordinator_session_id,wake_batch_id)) STRICT;',
                'CREATE TABLE IF NOT EXISTS native_window_owners (coordinator_session_id TEXT PRIMARY KEY,owner_ref TEXT NOT NULL,items TEXT NOT NULL,through_seq INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;',
                'CREATE TABLE IF NOT EXISTS portable_capsules (coordinator_session_id TEXT PRIMARY KEY,capsule_id TEXT NOT NULL,replaced_from_step_id TEXT NOT NULL,replaced_to_step_id TEXT NOT NULL,text TEXT NOT NULL,from_seq INTEGER NOT NULL,to_seq INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;',
                // 机械 Shake 的尝试标记：只存稳定边界身份与被替代的 step，派生产物由确定性规则重建。
                'CREATE TABLE IF NOT EXISTS mechanical_shake_artifacts (coordinator_session_id TEXT PRIMARY KEY,source_revision TEXT NOT NULL,shaken_step_ids TEXT NOT NULL,through_seq INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;',
                // 派生调用索引（design D-03）：只保存可信身份与原 metadata 中的字节范围，参数与结果仍只有一份权威原文。
                'CREATE TABLE IF NOT EXISTS history_call_index (coordinator_session_id TEXT NOT NULL,entry_id TEXT NOT NULL,step_id TEXT NOT NULL,seq INTEGER NOT NULL,ordinal INTEGER NOT NULL,call_id TEXT NOT NULL,name TEXT NOT NULL,operation_id TEXT NOT NULL,activity_kind TEXT NOT NULL,activity_id TEXT NOT NULL,args_start INTEGER NOT NULL,args_end INTEGER NOT NULL,PRIMARY KEY(coordinator_session_id,entry_id,call_id)) STRICT;',
                'CREATE INDEX IF NOT EXISTS history_call_index_page ON history_call_index(coordinator_session_id,seq,ordinal);',
                'CREATE INDEX IF NOT EXISTS history_call_index_activity ON history_call_index(coordinator_session_id,activity_id,seq,ordinal);',
                'CREATE INDEX IF NOT EXISTS history_call_index_call ON history_call_index(coordinator_session_id,call_id);',
                // 活动摘要按序号留痕：固定上界读到的是那一刻的计数与结局，而不是当前值。
                'CREATE TABLE IF NOT EXISTS history_activity_tally (coordinator_session_id TEXT NOT NULL,activity_id TEXT NOT NULL,seq INTEGER NOT NULL,member_count INTEGER NOT NULL,ok_count INTEGER NOT NULL,rejected_count INTEGER NOT NULL,unknown_count INTEGER NOT NULL,unconfirmed_count INTEGER NOT NULL,PRIMARY KEY(coordinator_session_id,activity_id,seq)) STRICT;',
                'CREATE TABLE IF NOT EXISTS history_activity_replay (coordinator_session_id TEXT NOT NULL,activity_id TEXT NOT NULL,from_seq INTEGER NOT NULL,cursor_seq INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(coordinator_session_id,activity_id)) STRICT;',
                // 每次计数变化一行增量：回填旧序号时按 (activity_id, seq) 键集重放，不需要扫整个活动。
                'CREATE TABLE IF NOT EXISTS history_activity_event (coordinator_session_id TEXT NOT NULL,activity_id TEXT NOT NULL,seq INTEGER NOT NULL,d_member INTEGER NOT NULL,d_ok INTEGER NOT NULL,d_rejected INTEGER NOT NULL,d_unknown INTEGER NOT NULL,d_unconfirmed INTEGER NOT NULL,PRIMARY KEY(coordinator_session_id,activity_id,seq)) STRICT;',
                'CREATE TABLE IF NOT EXISTS history_call_results (coordinator_session_id TEXT NOT NULL,call_entry_id TEXT NOT NULL,call_id TEXT NOT NULL,entry_id TEXT NOT NULL,seq INTEGER NOT NULL,byte_length INTEGER NOT NULL,status TEXT NOT NULL,PRIMARY KEY(coordinator_session_id,call_entry_id,call_id)) STRICT;',
                'CREATE INDEX IF NOT EXISTS history_call_results_entry ON history_call_results(coordinator_session_id,entry_id);',
                // 延后配对只登记“生产者 step 尚未落盘”的结果；因此这张表通常为空，待办探测是常数成本。
                'CREATE TABLE IF NOT EXISTS history_call_deferred (coordinator_session_id TEXT NOT NULL,entry_id TEXT NOT NULL,step_id TEXT NOT NULL,seq INTEGER NOT NULL,byte_length INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(coordinator_session_id,entry_id)) STRICT;',
                'CREATE INDEX IF NOT EXISTS history_call_deferred_order ON history_call_deferred(coordinator_session_id,seq);',
                'CREATE TABLE IF NOT EXISTS history_call_observations (coordinator_session_id TEXT NOT NULL,call_entry_id TEXT NOT NULL,call_id TEXT NOT NULL,step_id TEXT NOT NULL,operation_id TEXT NOT NULL,reason TEXT NOT NULL,recorded_at INTEGER NOT NULL,observed_seq INTEGER NOT NULL,PRIMARY KEY(coordinator_session_id,call_entry_id,call_id)) STRICT;',
                'CREATE TABLE IF NOT EXISTS history_inspection_progress (coordinator_session_id TEXT PRIMARY KEY,indexed_through_seq INTEGER NOT NULL,open_activity_id TEXT,updated_at INTEGER NOT NULL) STRICT;',
                'CREATE TABLE IF NOT EXISTS history_inspection_scans (coordinator_session_id TEXT NOT NULL,entry_id TEXT NOT NULL,state TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(coordinator_session_id,entry_id)) STRICT;',
            ].join('\n'));
            // 旧库（v2）按上面的 `CREATE TABLE IF NOT EXISTS` 无损补齐后写回当前版本号；既有行不动。
            stmt("INSERT INTO checkpoint_meta VALUES('checkpoint_schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(CHECKPOINT_SCHEMA_VERSION));
        });
        // 打开时补齐会话水位行：只读会话注册表，不碰任何历史正文或 metadata。
        atomic(() => {
            for (const row of stmt('SELECT coordinator_session_id FROM coordinator_sessions').all() as { coordinator_session_id: string }[])
                stmt('INSERT OR IGNORE INTO history_inspection_progress VALUES(?,?,NULL,?)').run(row.coordinator_session_id, 0, clock());
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
        // 每个会话都带一行索引水位：待办探测因此只扫会话注册表，不必扫已索引的历史前缀。
        stmt('INSERT OR IGNORE INTO history_inspection_progress VALUES(?,?,NULL,?)').run(head.coordinatorSessionId, 0, clock());
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
        const meta = JSON.parse(row.metadata) as CommittedMessageEntry;
        const owner = stmt('SELECT configuration_ref,byte_length FROM conversation_replay_owners WHERE coordinator_session_id=? AND entry_id=?').get(id, entryId) as { configuration_ref: string; byte_length: number } | undefined;
        let providerReplay: CommittedMessageEntry['providerReplay'];
        if (owner !== undefined) {
            const chunks = stmt('SELECT data FROM conversation_replay_bodies WHERE coordinator_session_id=? AND entry_id=? ORDER BY start').all(id, entryId) as { data: Uint8Array }[];
            const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.data)));
            if (bytes.length !== owner.byte_length) throw new Error('Provider replay body length mismatch');
            providerReplay = { configurationRef: owner.configuration_ref, additionalKwargs: JSON.parse(bytes.toString('utf8')) as Record<string, unknown> };
        }
        return valid({ ...empty(id as CoordinatorSessionId), committedMessages: [{ ...meta, ...(providerReplay === undefined ? {} : { providerReplay }), content }] }).committedMessages[0]!;
    }
    // ---------------------------------------------------------------- 派生调用索引
type CallIndexRow = {
        seq: number; ordinal: number; entry_id: string; step_id: string; call_id: string; name: string;
        operation_id: string; activity_kind: string; activity_id: string; args_start: number; args_end: number;
        result_entry_id: string | null; result_seq: number | null; result_status: string | null; result_bytes: number | null;
        observed: number | null; member_count: number | null; ok_count: number | null; rejected_count: number | null;
        unknown_count: number | null; unconfirmed_count: number | null;
    };
const emptyTally: ActivityTally = { memberCount: 0, okCount: 0, rejectedCount: 0, unknownCount: 0, unconfirmedCount: 0 };
    /** 一条工具结果接回调用之后的状态：已接上、延后待补、或永久未配对。 */
    type ResultLink = 'linked' | 'deferred' | 'unpaired';
    /** 固定上界之前的最后一个快照：老上界读到的是当时的计数，而不是后来追加的结果。 */
    function readTally(id: string, activityId: string, upper = Number.MAX_SAFE_INTEGER): ActivityTally {
        const row = stmt('SELECT member_count,ok_count,rejected_count,unknown_count,unconfirmed_count FROM history_activity_tally WHERE coordinator_session_id=? AND activity_id=? AND seq<=? ORDER BY seq DESC LIMIT 1').get(id, activityId, upper) as {
            member_count: number; ok_count: number; rejected_count: number; unknown_count: number; unconfirmed_count: number;
        } | undefined;
        return row === undefined ? emptyTally : { memberCount: row.member_count, okCount: row.ok_count, rejectedCount: row.rejected_count, unknownCount: row.unknown_count, unconfirmedCount: row.unconfirmed_count };
    }
    function writeTally(id: string, activityId: string, seq: number, tally: ActivityTally): void {
        stmt('INSERT OR REPLACE INTO history_activity_tally VALUES(?,?,?,?,?,?,?,?)').run(id, activityId, seq, tally.memberCount, tally.okCount, tally.rejectedCount, tally.unknownCount, tally.unconfirmedCount);
    }
    /** 一次计数变化在该序号上留一行增量：同一序号多次变化先并入同一行。 */
    function recordActivityEvent(id: string, activityId: string, seq: number, status: CallStatus, delta: number): void {
        const event = stmt('SELECT d_member,d_ok,d_rejected,d_unknown,d_unconfirmed FROM history_activity_event WHERE coordinator_session_id=? AND activity_id=? AND seq=?').get(id, activityId, seq) as {
            d_member: number; d_ok: number; d_rejected: number; d_unknown: number; d_unconfirmed: number;
        } | undefined;
        stmt('INSERT OR REPLACE INTO history_activity_event VALUES(?,?,?,?,?,?,?,?)').run(id, activityId, seq,
            (event?.d_member ?? 0) + delta, (event?.d_ok ?? 0) + (status === 'ok' ? delta : 0),
            (event?.d_rejected ?? 0) + (status === 'rejected' ? delta : 0), (event?.d_unknown ?? 0) + (status === 'unknown' ? delta : 0),
            (event?.d_unconfirmed ?? 0) + (status === 'unconfirmed' ? delta : 0));
    }
    /** 正常顺序下的变化：写当前版本，同时留一行增量，两者都是 O(1) 且与组大小无关。 */
    function bumpTally(id: string, activityId: string, seq: number, status: CallStatus, delta: number): void {
        const tally = tallyOf(readTally(id, activityId, seq), status, delta);
        writeTally(id, activityId, seq, { ...tally, memberCount: tally.memberCount + delta });
        recordActivityEvent(id, activityId, seq, status, delta);
    }
    function latestTallySeq(id: string, activityId: string): number {
        return (stmt('SELECT seq FROM history_activity_tally WHERE coordinator_session_id=? AND activity_id=? ORDER BY seq DESC LIMIT 1').get(id, activityId) as { seq: number } | undefined)?.seq ?? 0;
    }
    /**
     * 这个活动的一次结局变化，以及一次补齐要重放的次数。
     *
     * 只有当变化落在已经写下更新的序号之前时，链上更晚的版本才会变陈旧：这种回填必须登记为一次重放，
     * 由补齐按固定预算逐段重算，而不是在一次写入里扫完整个活动。
     */
    function requestTallyReplay(id: string, activityId: string, fromSeq: number): void {
        const open = stmt('SELECT from_seq FROM history_activity_replay WHERE coordinator_session_id=? AND activity_id=?').get(id, activityId) as { from_seq: number } | undefined;
        if (open !== undefined) {
            // 已经在重放的更早位置不动它；只把起点前移，并让游标退回新起点之前。
            if (open.from_seq > fromSeq)
                stmt('UPDATE history_activity_replay SET from_seq=?,cursor_seq=?,updated_at=? WHERE coordinator_session_id=? AND activity_id=?').run(fromSeq, fromSeq - 1, clock(), id, activityId);
            return;
        }
        // 游标停在变化之前的那一个序号：重放从最早受影响的那个变化本身开始。
        stmt('INSERT INTO history_activity_replay VALUES(?,?,?,?,?)').run(id, activityId, fromSeq, fromSeq - 1, clock());
    }
    /**
     * 逐个序号重放计数变化，每次只处理一个序号。
     *
     * 累计值从游标处最后一个自洽版本开始，每读到一个序号就写下该序号应有的那一版；读到没有更多
     * 变化时收尾。增量行按 `(activity_id, seq)` 键集取，每批最多 `maxSteps` 行，因此重放的成本与
     * 活动大小无关，补齐的每次调用最多花掉调用方给的条目预算。
     */
    function replayTallyStep(id: string, activityId: string, maxSteps: number): number {
        const replay = stmt('SELECT from_seq,cursor_seq FROM history_activity_replay WHERE coordinator_session_id=? AND activity_id=?').get(id, activityId) as { from_seq: number; cursor_seq: number } | undefined;
        if (replay === undefined)
            return 0;
        const events = stmt('SELECT seq,d_member,d_ok,d_rejected,d_unknown,d_unconfirmed FROM history_activity_event WHERE coordinator_session_id=? AND activity_id=? AND seq>? ORDER BY seq LIMIT ?')
            .all(id, activityId, replay.cursor_seq, maxSteps) as { seq: number; d_member: number; d_ok: number; d_rejected: number; d_unknown: number; d_unconfirmed: number }[];
        let base = readTally(id, activityId, replay.cursor_seq), cursor = replay.cursor_seq;
        for (const event of events) {
            const tally: ActivityTally = { memberCount: base.memberCount + event.d_member, okCount: base.okCount + event.d_ok, rejectedCount: base.rejectedCount + event.d_rejected, unknownCount: base.unknownCount + event.d_unknown, unconfirmedCount: base.unconfirmedCount + event.d_unconfirmed };
            writeTally(id, activityId, event.seq, tally);
            base = tally;
            // 游标停在本批处理过的最后一个序号，下一批从它之后继续：连续序号不会被跳过。
            cursor = event.seq;
        }
        const remaining = stmt('SELECT 1 AS more FROM history_activity_event WHERE coordinator_session_id=? AND activity_id=? AND seq>? LIMIT 1').get(id, activityId, cursor);
        if (remaining === undefined)
            stmt('DELETE FROM history_activity_replay WHERE coordinator_session_id=? AND activity_id=?').run(id, activityId);
        else
            stmt('UPDATE history_activity_replay SET cursor_seq=?,updated_at=? WHERE coordinator_session_id=? AND activity_id=?').run(cursor, clock(), id, activityId);
        return events.length;
    }
    /**
     * 一次结局变化要么增量落痕，要么在已经写下更新序号时重建计数链。
     *
     * 增量只在变化按时间顺序发生时成立；回填旧序号意味着后续版本已陈旧，重建是唯一能同时给出
     * 正确旧上界与正确当前值的办法。两种方式读到的都是同一份事实。
     */
    function applyOutcomeChange(id: string, activityId: string, seq: number, from: CallStatus, to: CallStatus): void {
        if (from === to)
            return;
        if (latestTallySeq(id, activityId) > seq) {
            // 回填旧序号：更晚的版本已经陈旧。这次变化本身仍然要留痕，否则重放无从纠正。
            recordActivityEvent(id, activityId, seq, from, -1);
            recordActivityEvent(id, activityId, seq, to, 1);
            requestTallyReplay(id, activityId, seq);
            return;
        }
        bumpTally(id, activityId, seq, from, -1);
        bumpTally(id, activityId, seq, to, 1);
    }
    /** 配对结果优先，其次是真实 unknown 观测，两者都没有才是未确认。 */
    function memberStatus(id: string, entryId: string, callId: string): CallStatus {
        const result = stmt('SELECT status FROM history_call_results WHERE coordinator_session_id=? AND call_entry_id=? AND call_id=?').get(id, entryId, callId) as { status: string } | undefined;
        if (result !== undefined)
            return result.status as CallStatus;
        return stmt('SELECT 1 AS seen FROM history_call_observations WHERE coordinator_session_id=? AND call_entry_id=? AND call_id=?').get(id, entryId, callId) === undefined ? 'unconfirmed' : 'unknown';
    }
    function openActivity(id: string): string | null {
        const row = stmt('SELECT open_activity_id FROM history_inspection_progress WHERE coordinator_session_id=?').get(id) as { open_activity_id: string | null } | undefined;
        return row?.open_activity_id ?? null;
    }
    function setOpenActivity(id: string, activityId: string | null): void {
        stmt('UPDATE history_inspection_progress SET open_activity_id=?,updated_at=? WHERE coordinator_session_id=?').run(activityId, clock(), id);
    }
    function indexedThrough(id: string): number {
        return (stmt('SELECT indexed_through_seq FROM history_inspection_progress WHERE coordinator_session_id=?').get(id) as { indexed_through_seq: number } | undefined)?.indexed_through_seq ?? 0;
    }
    /** 当前已提交的最大序号：没有新条目时退回水位，避免观测落到 0 上。 */
    function headSequence(id: string): number {
        return (stmt('SELECT seq FROM conversation_entries WHERE coordinator_session_id=? ORDER BY seq DESC LIMIT 1').get(id) as { seq: number } | undefined)?.seq ?? indexedThrough(id);
    }
    function ensureProgress(id: string): void {
        stmt('INSERT OR IGNORE INTO history_inspection_progress VALUES(?,?,NULL,?)').run(id, 0, clock());
    }
    /** 只有连续推进才移动水位：索引中的后段条目不会越过仍待补齐的前段。 */
    function advanceWatermark(id: string, seq: number): void {
        ensureProgress(id);
        stmt('UPDATE history_inspection_progress SET indexed_through_seq=?,updated_at=? WHERE coordinator_session_id=? AND indexed_through_seq+1=?')
            .run(seq, clock(), id, seq);
    }
    /**
     * 相邻 query 归入同一活动：活动身份取组内第一个可信调用。
     *
     * 用户消息、带正文的 assistant 回复和任何非 query 调用都结束当前组；工具结果不结束，因为
     * 它属于已经发起的那次查询。
     */
    function activityFor(id: string, entryId: string, span: ToolCallSpan): string {
        const open = openActivity(id);
        if (span.activityKind === 'query' && open !== null)
            return open;
        return 'call:' + entryId + ':' + span.callId;
    }
    function indexSpan(id: string, seq: number, entryId: string, stepId: string, span: ToolCallSpan): void {
        const existing = stmt('SELECT activity_id FROM history_call_index WHERE coordinator_session_id=? AND entry_id=? AND call_id=?').get(id, entryId, span.callId) as { activity_id: string } | undefined;
        const activityId = activityFor(id, entryId, span);
        // 同一身份的重复定位不产生第二条调用，也不重复计数。
        if (existing?.activity_id === activityId)
            return;
        if (existing === undefined)
            stmt('INSERT INTO history_call_index VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id, entryId, stepId, seq, span.ordinal, span.callId, span.name, span.operationId, span.activityKind, activityId, span.argsStart, span.argsEnd);
        else
            stmt('UPDATE history_call_index SET step_id=?,seq=?,ordinal=?,name=?,operation_id=?,activity_kind=?,activity_id=?,args_start=?,args_end=? WHERE coordinator_session_id=? AND entry_id=? AND call_id=?')
                .run(stepId, seq, span.ordinal, span.name, span.operationId, span.activityKind, activityId, span.argsStart, span.argsEnd, id, entryId, span.callId);
        const status = memberStatus(id, entryId, span.callId);
        if (existing !== undefined)
            bumpTally(id, existing.activity_id, seq, status, -1);
        bumpTally(id, activityId, seq, status, 1);
        setOpenActivity(id, span.activityKind === 'query' ? activityId : null);
    }
    /**
     * 结果条目的首段就是结构化 outcome，因此只读固定字节。
     *
     * 匹配锚定在根对象的第一个键上：嵌套的 `kind`（例如 `value.kind`）永远不会被当成这次调用的结局，
     * 形状不认识时如实保持未确认，而不是从正文里猜。
     */
    function statusOfOutcome(content: string | null): CallStatus {
        if (content === null)
            return 'unconfirmed';
        const match = /^\s*\{\s*"kind"\s*:\s*"(ok|rejected|unknown)"/.exec(content.slice(0, 512));
        return match === null ? 'unconfirmed' : match[1] as CallStatus;
    }
    function writeResultLink(id: string, activityId: string, callEntryId: string, callId: string, resultEntryId: string, seq: number, byteLength: number, status: CallStatus): void {
        const before = memberStatus(id, callEntryId, callId);
        stmt('INSERT INTO history_call_results VALUES(?,?,?,?,?,?,?)').run(id, callEntryId, callId, resultEntryId, seq, byteLength, status);
        applyOutcomeChange(id, activityId, seq, before, status);
    }
    /**
     * 把一条工具结果接回它的调用，并说明它接下来是什么状态。
     *
     * 只有可证明的关联才成立：生产者 step 必须存在、该 step 里必须真有这个 call、工具名必须一致，
     * 而且这个 call 还没有被别的结果占用。step 尚未落盘的结果是**延后**（可能补齐），其余不可归���的
     * 结果是**永久未配对**（保留为未确认，但不进入待办，因此不会拖住补齐）。
     */
    function linkResult(id: string, callEntryId: string | null, callId: string, toolName: string | undefined, resultEntryId: string, seq: number, byteLength: number, status: CallStatus): ResultLink {
        if (callEntryId === null)
            return 'deferred';
        if (stmt('SELECT 1 AS seen FROM history_call_results WHERE coordinator_session_id=? AND entry_id=?').get(id, resultEntryId) !== undefined)
            return 'linked';
        const call = stmt('SELECT name,activity_id FROM history_call_index WHERE coordinator_session_id=? AND entry_id=? AND call_id=?').get(id, callEntryId, callId) as { name: string; activity_id: string } | undefined;
        if (call === undefined || (toolName !== undefined && call.name !== toolName))
            return 'unpaired';
        if (stmt('SELECT 1 AS seen FROM history_call_results WHERE coordinator_session_id=? AND call_entry_id=? AND call_id=?').get(id, callEntryId, callId) !== undefined)
            return 'unpaired';
        writeResultLink(id, call.activity_id, callEntryId, callId, resultEntryId, seq, byteLength, status);
        return 'linked';
    }
    /**
     * 产生这次调用的 assistant 条目。
     *
     * 权威关系只有一条：工具结果的 `stepId` 就是那次模型响应的 step id，`conversation_model_steps`
     * 指向唯一持有该 step 调用的条目。没有这条记录就没有可证明的归属，读取路径不做任何猜测。
     */
    function callEntryForStep(id: string, stepId: string): string | null {
        return (stmt('SELECT entry_id FROM conversation_model_steps WHERE coordinator_session_id=? AND step_id=?').get(id, stepId) as { entry_id: string } | undefined)?.entry_id ?? null;
    }
    function linkResultEntry(id: string, entry: CommittedMessageEntry, seq: number, content: string | null): ResultLink {
        const callId = entry.toolCallId;
        if (callId === undefined)
            return 'unpaired';
        return linkResult(id, callEntryForStep(id, entry.stepId), callId, entry.toolName, entry.entryId, seq, Buffer.byteLength(entry.content, 'utf8'), statusOfOutcome(content));
    }
    /**
     * 把一次新提交建立进派生索引：写入路径本来就持有完整对象，定位因此与原文同事务落盘。
     * 用户消息与带正文的 assistant 回复在这里结束当前查询组。
     */
    function indexCommittedEntry(id: string, seq: number, entry: CommittedMessageEntry, metadataJson: string, content: string | null): void {
        ensureProgress(id);
        if (entry.role === 'user' || (entry.role === 'assistant' && content !== null && content.length > 0))
            setOpenActivity(id, null);
        if (entry.role === 'assistant')
            for (const span of scanMetadataText(metadataJson))
                indexSpan(id, seq, entry.entryId, entry.stepId, span);
        if (entry.role === 'tool' && linkResultEntry(id, entry, seq, content) === 'deferred')
            deferToolResult(id, entry.entryId, entry.stepId, seq, Buffer.byteLength(entry.content, 'utf8'));
        advanceWatermark(id, seq);
    }
    function deferToolResult(id: string, entryId: string, stepId: string, seq: number, byteLength: number): void {
        stmt('INSERT OR IGNORE INTO history_call_deferred VALUES(?,?,?,?,?,?)').run(id, entryId, stepId, seq, byteLength, clock());
    }
    function resolveDeferredToolResult(id: string, entryId: string): void {
        stmt('DELETE FROM history_call_deferred WHERE coordinator_session_id=? AND entry_id=?').run(id, entryId);
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
        const { content, providerReplay, ...meta } = entry, summary = { ...meta }, bytes = Buffer.from(content, 'utf8'), replayBytes = providerReplay === undefined ? null : Buffer.from(JSON.stringify(providerReplay.additionalKwargs), 'utf8'), work = entry.role === 'user' || entry.entryId.startsWith('entry:interaction-answer:') || (entry.role === 'system' && entry.workSource !== undefined);
        if (replayBytes !== null && replayBytes.length > 64 * 1024) throw new Error('Provider replay exceeds byte budget');
        delete summary.toolCalls;
        if (Buffer.byteLength(JSON.stringify(summary)) > HISTORY_PAGE_BYTES)
            throw new Error('History metadata exceeds page budget');
        const metadataJson = JSON.stringify(meta);
        stmt('INSERT INTO conversation_entries VALUES(?,?,?,?,?,?,?,?,?,NULL)').run(id, seq + 1, entry.entryId, entry.stepId, entry.role, metadataJson, JSON.stringify(summary), bytes.length, work ? 1 : 0);
        if (providerReplay !== undefined && replayBytes !== null) {
            stmt('INSERT INTO conversation_replay_owners VALUES(?,?,?,?)').run(id, entry.entryId, providerReplay.configurationRef, replayBytes.length);
            for (let start = 0; start < replayBytes.length; start += HISTORY_CHUNK_BYTES)
                stmt('INSERT INTO conversation_replay_bodies VALUES(?,?,?,?)').run(id, entry.entryId, start, replayBytes.subarray(start, start + HISTORY_CHUNK_BYTES));
        }
        for (let start = 0; start < bytes.length; start += HISTORY_CHUNK_BYTES)
            stmt('INSERT INTO conversation_bodies VALUES(?,?,?,?)').run(id, entry.entryId, start, bytes.subarray(start, start + HISTORY_CHUNK_BYTES));
        // 派生定位与权威原文同事务落盘：写入路径已经持有完整对象，不需要回读整段 metadata。
        indexCommittedEntry(id, seq + 1, entry, metadataJson, content);
        const source = entry.completedWorkSource;
        if (source !== undefined) {
            // 外部工作按稳定 work entry 身份消费；user / interaction 各自沿用既有身份，不另建引用条目。
            const target = source.sourceKind === 'user-message' ? userEntryId(source.sourceId) : source.sourceKind === 'interaction-answer' ? 'entry:interaction-answer:' + source.sourceId : workEntryId(source);
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
            throw new Error('Step body differs from canonical entry'); delete shape.content; delete shape.toolCalls; delete shape.providerReplay; return shape; });
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
            const row = stmt('SELECT CAST(substr(CAST(metadata AS BLOB),1,?) AS TEXT) AS metadata FROM conversation_model_steps WHERE coordinator_session_id=? AND entry_id=?').get(HISTORY_PAGE_BYTES + 1, id, entry.entryId) as {
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
            const replay = entry.providerReplay;
            return [{ ...rest, toolCalls: entry.toolCalls ?? [], messages: shapes.map(shape => ({ ...shape, content: entry.content, ...(entry.contentFormat === undefined ? {} : { contentFormat: entry.contentFormat }), ...(entry.toolCalls !== undefined && 'entryId' in shape ? { toolCalls: entry.toolCalls } : {}), ...(replay === undefined ? {} : { providerReplay: replay }) })) }];
        });
    }
    /**
     * 一次 context 材料的读取结果：值与它实际占用的字节数。
     *
     * 字节数随值一起返回，正文与 step 才能共用同一个读取预算，而不是各自再算一遍。
     */
    type ContextMaterialRead<T> = { readonly bytes: number; readonly value: T };
    function readNativeWindowOwner(id: CoordinatorSessionId): ContextMaterialRead<NativeCompactedWindowOwner> | null {
        // 截断在 BLOB 上按字节进行，中文与 emoji 不会被按字符数绕过；同一行给出总字节数，
        // 超限时在 JSON 解析前拒绝，内存里不会先出现无界文本。
        const row = stmt('SELECT owner_ref,CAST(substr(CAST(items AS BLOB),1,?) AS TEXT) AS items,length(CAST(items AS BLOB)) AS bytes FROM native_window_owners WHERE coordinator_session_id=?').get(contextReadBytes + 1, id) as {
            owner_ref: string;
            items: string;
            bytes: number;
        } | undefined;
        if (row === undefined)
            return null;
        if (row.bytes > contextReadBytes)
            throw new Error('context_exhausted: native window read budget');
        const owner = { ownerRef: row.owner_ref, items: JSON.parse(row.items) as NativeCompactedWindowOwner['items'] };
        return { bytes: row.bytes, value: valid({ ...empty(id), contextMaterial: { nativeWindowOwner: owner, capsule: null } }).contextMaterial!.nativeWindowOwner! };
    }
    function readPortableCapsule(id: CoordinatorSessionId): ContextMaterialRead<PortableContextCapsule> | null {
        const row = stmt('SELECT capsule_id,replaced_from_step_id,replaced_to_step_id,CAST(substr(CAST(text AS BLOB),1,?) AS TEXT) AS text,length(CAST(text AS BLOB)) AS bytes FROM portable_capsules WHERE coordinator_session_id=?').get(contextReadBytes + 1, id) as {
            capsule_id: string;
            replaced_from_step_id: string;
            replaced_to_step_id: string;
            text: string;
            bytes: number;
        } | undefined;
        if (row === undefined)
            return null;
        if (row.bytes > contextReadBytes)
            throw new Error('context_exhausted: capsule read budget');
        const capsule: PortableContextCapsule = { kind: 'derived_context_capsule', capsuleId: row.capsule_id, replacedFromStepId: row.replaced_from_step_id, replacedToStepId: row.replaced_to_step_id, text: row.text };
        return { bytes: row.bytes, value: valid({ ...empty(id), contextMaterial: { nativeWindowOwner: null, capsule } }).contextMaterial!.capsule! };
    }
    function loadNativeWindowOwner(id: CoordinatorSessionId): NativeCompactedWindowOwner | null {
        return readNativeWindowOwner(id)?.value ?? null;
    }
    function loadPortableCapsule(id: CoordinatorSessionId): PortableContextCapsule | null {
        return readPortableCapsule(id)?.value ?? null;
    }
    function readMechanicalShake(id: CoordinatorSessionId): ContextMaterialRead<MechanicalShakeArtifact> | null {
        const row = stmt('SELECT source_revision,CAST(substr(CAST(shaken_step_ids AS BLOB),1,?) AS TEXT) AS steps,length(CAST(shaken_step_ids AS BLOB)) AS bytes FROM mechanical_shake_artifacts WHERE coordinator_session_id=?').get(contextReadBytes + 1, id) as {
            source_revision: string;
            steps: string;
            bytes: number;
        } | undefined;
        if (row === undefined)
            return null;
        if (row.bytes > contextReadBytes)
            throw new Error('context_exhausted: mechanical shake read budget');
        const artifact: MechanicalShakeArtifact = { sourceRevision: row.source_revision, shakenStepIds: JSON.parse(row.steps) as MechanicalShakeArtifact['shakenStepIds'] };
        return { bytes: row.bytes, value: valid({ ...empty(id), contextMaterial: { nativeWindowOwner: null, capsule: null, mechanicalShake: artifact } }).contextMaterial!.mechanicalShake! };
    }
    function loadMechanicalShake(id: CoordinatorSessionId): MechanicalShakeArtifact | null {
        return readMechanicalShake(id)?.value ?? null;
    }
    function loadCheckpoint(id: CoordinatorSessionId, purpose: CheckpointReadPurpose = 'full'): CheckpointRecoveryRead {
        try {
            const head = core(id);
            if (head === null)
                return { kind: 'absent' };
            const ownerRead = readNativeWindowOwner(id), capsuleRead = readPortableCapsule(id), shakeRead = readMechanicalShake(id);
            const nativeWindowOwner = ownerRead?.value ?? null, capsule = capsuleRead?.value ?? null, mechanicalShake = shakeRead?.value ?? null;
            // 一次恢复读到的 context 材料与正文、step 共享同一个预算；`full` 读整段历史，
            // context 材料仍按预算有界，否则一次恢复的内存占用就没有上限。
            const materialBytes = (ownerRead?.bytes ?? 0) + (capsuleRead?.bytes ?? 0) + (shakeRead?.bytes ?? 0);
            if (purpose !== 'full' && materialBytes > contextReadBytes)
                throw new Error('context_exhausted: context material read budget');
            const budget = purpose === 'full' ? Infinity : contextReadBytes - materialBytes;
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
            const replayBytes = purpose === 'metadata' || purpose === 'pending' || rows.length === 0 ? 0 : (stmt('SELECT COALESCE(SUM(byte_length),0) AS bytes FROM conversation_replay_owners WHERE coordinator_session_id=? AND entry_id IN (SELECT entry_id FROM conversation_entries WHERE coordinator_session_id=? AND seq IN (' + rows.map(() => '?').join(',') + '))').get(id, id, ...rows.map((row) => row.seq)) as { bytes: number } | undefined)?.bytes ?? 0;
            if (purpose !== 'full' && (rows.length > CONTEXT_READ_ITEMS || rows.reduce((n, r) => n + r.byte_length + r.metadata_length, 0) + replayBytes > budget))
                throw new Error('context_exhausted: effective history read budget exceeded');
            const entries = rows.map(row => { const entry = readEntry(id, row.entry_id); if (entry === null)
                throw new Error('Committed entry missing'); return entry; });
            const wakes = purpose === 'full' ? (stmt('SELECT metadata FROM conversation_wakes WHERE coordinator_session_id=? ORDER BY rowid').all(id) as {
                metadata: string;
            }[]).map(row => JSON.parse(row.metadata) as WakeBatch) : [];
            return { kind: 'recovered', state: valid({ ...head, committedMessages: entries, committedModelSteps: stepsFor(id, entries, budget - rows.reduce((sum, row) => sum + row.byte_length + row.metadata_length, 0) - replayBytes), wakeBatches: wakes, ...(nativeWindowOwner === null && capsule === null && mechanicalShake === null ? {} : { contextMaterial: { nativeWindowOwner, capsule, ...(mechanicalShake === null ? {} : { mechanicalShake }) } }) }) };
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
        insertExternalWorkEntries(batch);
        return true;
    }
    /**
     * 外部 Actionable Work 的 system 引用条目：与 Wake Batch 同事务落盘，因此「工作已唤醒」与
     * 「哪一批唤醒」不可能分成两条独立事实。内容只保存有界 summary，正文仍由来源按引用只读取得；
     * user-message / interaction-answer 由各自的提交路径拥有，不在这里重复建条目。
     */
    function insertExternalWorkEntries(batch: WakeBatch): void {
        // 只有 `actionableWork` 里存在精确 `workId` 匹配的 source 才是模型工作：仅带 sourceRevision 的
        // activation marker（如 `execution-handoff-activation`）或将来新增的 typed validator step 都
        // 没有可判定工作，一律跳过而不是造一条推测性的外部条目。
        const summaries = new Map(batch.actionableWork.map(work => [work.workId, work]));
        const matchedKinds = new Map<string, Set<string>>();
        for (const source of batch.sourceRevisions) {
            if (INTERNAL_WAKE_SOURCE_KINDS.has(source.sourceKind) || !summaries.has(source.sourceId))
                continue;
            const kinds = matchedKinds.get(source.sourceId) ?? new Set<string>();
            kinds.add(source.sourceKind);
            matchedKinds.set(source.sourceId, kinds);
        }
        for (const [sourceId, kinds] of matchedKinds) {
            // 同一 workId 命中多个 sourceKind：无法判定归属，fail closed 而不是猜一条。
            if (kinds.size > 1)
                throw new Error('Ambiguous actionable work source kind: ' + sourceId);
        }
        const written = new Set<string>();
        for (const source of batch.sourceRevisions) {
            const work = summaries.get(source.sourceId);
            if (INTERNAL_WAKE_SOURCE_KINDS.has(source.sourceKind) || work === undefined)
                continue;
            const entryId = workEntryId(source);
            if (written.has(entryId))
                continue;
            written.add(entryId);
            insertEntry(batch.coordinatorSessionId, {
                entryId,
                stepId: entryId,
                role: 'system',
                content: work.summary.slice(0, WORK_ENTRY_SUMMARY_CHARS),
                workSource: source,
            });
        }
    }
    function readWakeBatch(id: CoordinatorSessionId, wakeBatchId: string): WakeBatch | null {
        // 首次会话还没有任何记录时不抛错：读一条不存在的 batch 就是 `null`，不产生任何写入。
        // 只有已存在却损坏的 core 才 fail closed（`core(id)` 会抛结构化错误）。
        if (core(id) === null)
            return null;
        const row = stmt('SELECT metadata,length(CAST(metadata AS BLOB)) AS bytes FROM conversation_wakes WHERE coordinator_session_id=? AND wake_batch_id=?').get(id, wakeBatchId) as {
            metadata: string;
            bytes: number;
        } | undefined;
        if (row === undefined)
            return null;
        if (row.bytes > WAKE_BATCH_METADATA_BYTES)
            throw new Error('Wake Batch metadata exceeds 64KiB budget');
        return valid({ ...empty(id), wakeBatches: [JSON.parse(row.metadata) as WakeBatch] }).wakeBatches[0]!;
    }
    const resultState = (id: CoordinatorSessionId, entries: readonly CommittedMessageEntry[] = [], wakes: readonly WakeBatch[] = []): CoordinatorSessionState => valid({ ...requireCore(id), committedMessages: entries, committedModelSteps: [], wakeBatches: wakes });
    // ---------------------------------------------------------------- 历史检查读取面
    /** 一次 metadata 的固定字节窗口；调用与补齐都只经这里读原文，内存里不会出现整段参数。 */
    function readMetadataBytes(id: string, entryId: string, offset: number, length: number): Uint8Array {
        const row = stmt('SELECT substr(CAST(metadata AS BLOB),?,?) AS chunk FROM conversation_entries WHERE coordinator_session_id=? AND entry_id=?').get(offset + 1, length, id, entryId) as { chunk: Uint8Array } | undefined;
        return row?.chunk ?? new Uint8Array(0);
    }
    function scanEntrySpans(id: string, entryId: string): readonly ToolCallSpan[] {
        const row = stmt('SELECT length(CAST(metadata AS BLOB)) AS metadata_length FROM conversation_entries WHERE coordinator_session_id=? AND entry_id=?').get(id, entryId) as { metadata_length: number } | undefined;
        if (row === undefined)
            return [];
        const state = createMetadataScanState();
        const spans: ToolCallSpan[] = [];
        for (let start = 0; start < row.metadata_length; start += TOOL_CALL_SCAN_CHUNK_BYTES)
            spans.push(...scanMetadataBytes(state, readMetadataBytes(id, entryId, start, Math.min(TOOL_CALL_SCAN_CHUNK_BYTES, row.metadata_length - start)), start));
        return spans;
    }
    /** 结果条目的正文首段就是结构化 outcome；只读固定字节即可得到可信结局。 */
    function outcomeOfBody(id: string, entryId: string): string | null {
        const row = stmt('SELECT CAST(substr(CAST(data AS BLOB),1,512) AS TEXT) AS chunk FROM conversation_bodies WHERE coordinator_session_id=? AND entry_id=? AND start=0').get(id, entryId) as { chunk: string } | undefined;
        return row?.chunk ?? null;
    }
    /**
     * 配对校验只查索引；索引尚未覆盖的旧历史按原 step 的权威 metadata 逐块定位一次。
     * 两种路径都不解析整段 JSON，5 MiB 参数也不会被读进内存。
     */
    function verifyCommittedCall(id: string, stepId: string, callId: string, name: string | undefined): boolean {
        const step = stmt('SELECT entry_id FROM conversation_model_steps WHERE coordinator_session_id=? AND step_id=?').get(id, stepId) as { entry_id: string } | undefined;
        if (step === undefined)
            return false;
        const indexed = stmt('SELECT name FROM history_call_index WHERE coordinator_session_id=? AND entry_id=? AND call_id=?').get(id, step.entry_id, callId) as { name: string } | undefined;
        if (indexed !== undefined)
            return name === undefined || indexed.name === name;
        return scanEntrySpans(id, step.entry_id).some(span => span.callId === callId && (name === undefined || span.name === name));
    }
    /** 活动摘要与配对结果都按固定上界取：老上界不会看到上界之后才发生的事实。 */
    const tally = (column: string): string => `(SELECT t.${column} FROM history_activity_tally t WHERE t.coordinator_session_id=c.coordinator_session_id AND t.activity_id=c.activity_id AND t.seq<=? ORDER BY t.seq DESC LIMIT 1)`;
    const CALL_COLUMNS = ['c.seq AS seq', 'c.ordinal AS ordinal', 'c.entry_id AS entry_id', 'c.step_id AS step_id', 'c.call_id AS call_id', 'c.name AS name', 'c.operation_id AS operation_id', 'c.activity_kind AS activity_kind', 'c.activity_id AS activity_id', 'c.args_start AS args_start', 'c.args_end AS args_end', tally('member_count') + ' AS member_count', tally('ok_count') + ' AS ok_count', tally('rejected_count') + ' AS rejected_count', tally('unknown_count') + ' AS unknown_count', tally('unconfirmed_count') + ' AS unconfirmed_count', 'r.entry_id AS result_entry_id', 'r.seq AS result_seq', 'r.byte_length AS result_bytes', 'r.status AS result_status', 'o.call_id AS observed'].join(',');
    const CALL_JOINS = 'FROM history_call_index c LEFT JOIN history_call_results r ON r.coordinator_session_id=c.coordinator_session_id AND r.call_entry_id=c.entry_id AND r.call_id=c.call_id AND r.seq<=? LEFT JOIN history_call_observations o ON o.coordinator_session_id=c.coordinator_session_id AND o.call_entry_id=c.entry_id AND o.call_id=c.call_id AND o.observed_seq<=?';
    const callParams = (upper: number): unknown[] => new Array<unknown>(7).fill(upper);
    function toCall(row: CallIndexRow): HistoryCall {
        // 配对结果优先于观测；两者都没有就是未确认，不从缺失或自由文案猜结局。
        const status: CallStatus = row.result_status !== null ? row.result_status as CallStatus : row.observed !== null ? 'unknown' : 'unconfirmed';
        const tally: ActivityTally = { memberCount: row.member_count ?? 1, okCount: row.ok_count ?? 0, rejectedCount: row.rejected_count ?? 0, unknownCount: row.unknown_count ?? 0, unconfirmedCount: row.unconfirmed_count ?? 1 };
        return { sequence: row.seq, ordinal: row.ordinal, entryId: row.entry_id, stepId: row.step_id, callId: row.call_id, name: row.name, operationId: row.operation_id,
            activityKind: row.activity_kind as HistoryCall['activityKind'], activityId: row.activity_id, argsByteLength: Math.max(0, row.args_end - row.args_start),
            activityCount: Math.max(1, tally.memberCount), activityStatus: activityStatusOf(tally),
            result: row.result_entry_id !== null && row.result_seq !== null ? { entryId: row.result_entry_id, sequence: row.result_seq, byteLength: row.result_bytes ?? 0 } : null, status };
    }
    function keysetFilter(q: HistoryCallQuery, newer: boolean): { readonly sql: string; readonly params: readonly number[] } {
        const anchor = newer ? q.after : q.before;
        return anchor === undefined ? { sql: '', params: [] } : { sql: newer ? ' AND (c.seq>? OR (c.seq=? AND c.ordinal>?))' : ' AND (c.seq<? OR (c.seq=? AND c.ordinal<?))', params: [anchor.sequence, anchor.sequence, anchor.ordinal] };
    }
    function readHistoryCalls(input: HistoryCallQuery): HistoryCallPage {
        const q = historyCallQuerySchema.parse(input);
        const upper = q.upperSequence ?? Number.MAX_SAFE_INTEGER;
        const newer = q.direction === 'newer';
        // 精确来源定位：命中可以指向同一次响应里的任意一个调用，不必先翻到它所在的那一页。
        const callFilter = q.callId === undefined ? '' : ' AND c.call_id=?';
        const callArgs = q.callId === undefined ? [] : [q.callId];
        if (q.activityId !== undefined) {
            // 活动过滤是一次定位而不是一页：向旧方向给组尾、向新方向给组首。
            // 读取方据此跳过整个折叠组，既不用重扫成员，也不用为组大小留出页预算。
            const keyset = keysetFilter(q, newer);
            const row = stmt('SELECT ' + CALL_COLUMNS + ' ' + CALL_JOINS + ' WHERE c.coordinator_session_id=? AND c.activity_id=? AND c.seq<=?' + callFilter + keyset.sql + ' ORDER BY c.seq ' + (newer ? 'ASC' : 'DESC') + ',c.ordinal ' + (newer ? 'ASC' : 'DESC') + ' LIMIT 1')
                .get(...callParams(upper), q.coordinatorSessionId, q.activityId, upper, ...callArgs, ...keyset.params) as CallIndexRow | undefined;
            const call = row === undefined ? undefined : toCall(row);
            if (call !== undefined && Buffer.byteLength(JSON.stringify(call)) + 2 > HISTORY_PAGE_BYTES)
                throw new Error('History call metadata exceeds page budget');
            return { calls: call === undefined ? [] : [call], hasMore: false };
        }
        const keyset = keysetFilter(q, newer);
        const rows = stmt('SELECT ' + CALL_COLUMNS + ' ' + CALL_JOINS + ' WHERE c.coordinator_session_id=? AND c.seq<=?' + (q.entryId === undefined ? '' : ' AND c.entry_id=?') + callFilter + keyset.sql + ' ORDER BY c.seq ' + (newer ? 'ASC' : 'DESC') + ',c.ordinal ' + (newer ? 'ASC' : 'DESC') + ' LIMIT ?')
            .all(...callParams(upper), q.coordinatorSessionId, upper, ...(q.entryId === undefined ? [] : [q.entryId]), ...callArgs, ...keyset.params, HISTORY_PAGE_ITEMS + 1) as CallIndexRow[];
        const calls: HistoryCall[] = [];
        let bytes = 2;
        for (const row of rows.slice(0, HISTORY_PAGE_ITEMS)) {
            const call = toCall(row), size = Buffer.byteLength(JSON.stringify(call)) + (calls.length > 0 ? 1 : 0);
            if (size + 2 > HISTORY_PAGE_BYTES)
                throw new Error('History call metadata exceeds page budget');
            if (bytes + size > HISTORY_PAGE_BYTES)
                break;
            calls.push(call);
            bytes += size;
        }
        return { calls: newer ? calls : calls.reverse(), hasMore: calls.length < rows.length };
    }
    /** 逐字节裁到完整字符边界，读者因此可以在任意偏移续读，而不必先取回整段参数。 */
    function readHistoryArguments(input: HistoryArgumentsQuery): TranscriptBodyRange | null {
        const q = historyArgumentsQuerySchema.parse(input);
        const row = stmt('SELECT args_start,args_end FROM history_call_index WHERE coordinator_session_id=? AND entry_id=? AND step_id=? AND call_id=?').get(q.coordinatorSessionId, q.entryId, q.stepId, q.callId) as {
            args_start: number;
            args_end: number;
        } | undefined;
        if (row === undefined)
            return null;
        const byteLength = Math.max(0, row.args_end - row.args_start);
        const source = { kind: 'arguments', entryId: q.entryId, stepId: q.stepId, callId: q.callId, contentRevision: 1 } as const;
        if (q.offset > byteLength)
            throw new HistoryBoundaryError('Arguments offset is outside the source');
        if (q.offset === byteLength)
            return { source, offset: q.offset, end: q.offset, byteLength, text: '' };
        const available = byteLength - q.offset, wanted = Math.min(q.maxBytes, available);
        // 只多读几个字节用于判断末尾是否切在多字节字符中间；来源末尾不多读，也不会把后面的 JSON 读进来。
        const buffer = Buffer.from(readMetadataBytes(q.coordinatorSessionId, q.entryId, row.args_start + q.offset, wanted + Math.min(4, available - wanted)));
        if (buffer.length === 0 || (buffer[0]! & 0xc0) === 0x80)
            throw new HistoryBoundaryError('Arguments offset is not a UTF-8 boundary');
        // 回退的依据是范围之后的那个字节：它是续字节才说明本段切在了字符中间。
        // 绝不裁掉已经是完整字符的尾巴，因此整段中文或 emoji 结尾时不会丢字。
        let end = Math.min(wanted, buffer.length);
        while (end > 0 && (buffer[end]! & 0xc0) === 0x80)
            end -= 1;
        if (end === 0)
            throw new HistoryBoundaryError('Arguments range missing a complete character');
        return { source, offset: q.offset, end: q.offset + end, byteLength, text: decoder.decode(buffer.subarray(0, end)) };
    }
    /**
     * 有界元数据页：固定上界加 `(seq, ordinal)` 键集，角色过滤直接落在 SQL 上。
     *
     * 普通历史与普通输入历史共用这一条路径，区别只在角色条件；先读全体再筛会让普通输入召回
     * 为一次翻页付出与整页历史相同的代价。
     */
    function metadataPage(query: { readonly coordinatorSessionId: string; readonly before?: number | undefined; readonly after?: number | undefined; readonly direction?: 'older' | 'newer' | undefined; readonly upperSequence?: number | undefined; readonly role?: 'user' | undefined }): HistoryMetadataPage {
        requireCore(query.coordinatorSessionId);
        const newer = query.direction === 'newer';
        const rows = stmt('SELECT seq,entry_id,length(CAST(summary_metadata AS BLOB)) AS metadata_length FROM conversation_entries WHERE coordinator_session_id=? AND ' + (query.role === 'user' ? "role='user'" : "role!='system'") + ' AND seq<=? AND seq' + (newer ? '>' : '<') + '? ORDER BY seq ' + (newer ? 'ASC' : 'DESC') + ' LIMIT ?')
            .all(query.coordinatorSessionId, query.upperSequence ?? Number.MAX_SAFE_INTEGER, newer ? query.after ?? 0 : query.before ?? Number.MAX_SAFE_INTEGER, HISTORY_PAGE_ITEMS + 1) as {
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
            const stored = rowFor(query.coordinatorSessionId, row.entry_id, true);
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
    }
    function readHistoryInspection(coordinatorSessionId: string): HistoryInspectionSnapshot {
        const upper = (stmt('SELECT seq FROM conversation_entries WHERE coordinator_session_id=? ORDER BY seq DESC LIMIT 1').get(coordinatorSessionId) as { seq: number } | undefined)?.seq ?? 0;
        const indexed = indexedThrough(coordinatorSessionId);
        // 水位只说明条目定位完成；延后的结果配对未接上时，读取方仍应看到“处理中”。
        const deferred = stmt('SELECT 1 AS pending FROM history_call_deferred WHERE coordinator_session_id=? LIMIT 1').get(coordinatorSessionId);
        const replay = stmt('SELECT 1 AS pending FROM history_activity_replay WHERE coordinator_session_id=? LIMIT 1').get(coordinatorSessionId);
        return { upperSequence: upper, indexedThroughSequence: indexed, ready: indexed >= upper && deferred === undefined && replay === undefined };
    }
    // ---------------------------------------------------------------- 显式索引补齐
    type PendingEntry = { readonly coordinator_session_id: string; readonly seq: number; readonly entry_id: string; readonly step_id: string; readonly role: string; readonly byte_length: number; readonly metadata_length: number };
    function pendingEntry(): PendingEntry | undefined {
        const session = pendingSession();
        if (session === undefined)
            return undefined;
        // 会话内从水位往后是主键区间扫描：已索引的前缀一次也不会被读到。
        return stmt('SELECT coordinator_session_id,seq,entry_id,step_id,role,byte_length,length(CAST(metadata AS BLOB)) AS metadata_length FROM conversation_entries WHERE coordinator_session_id=? AND seq>? ORDER BY seq LIMIT 1')
            .get(session, indexedThrough(session)) as PendingEntry | undefined;
    }
    /** 唯一还欠索引的会话；每个会话只做一次主键末行探测，不随历史长度增长。 */
    function pendingSession(): string | undefined {
        return (stmt('SELECT s.coordinator_session_id AS id FROM coordinator_sessions s JOIN history_inspection_progress p ON p.coordinator_session_id=s.coordinator_session_id WHERE (SELECT MAX(seq) FROM conversation_entries WHERE coordinator_session_id=s.coordinator_session_id) > p.indexed_through_seq ORDER BY s.updated_at DESC,s.coordinator_session_id LIMIT 1').get() as { id: string } | undefined)?.id;
    }
    function breaksGroup(role: string, bodyBytes: number): boolean {
        return role === 'user' || (role === 'assistant' && bodyBytes > 0);
    }
    function completeEntry(entry: PendingEntry, summary?: EntryRow): void {
        const id = entry.coordinator_session_id;
        if (entry.role === 'tool')
            noteResultLink(id, entry.entry_id, entry.step_id, entry.seq, entry.byte_length, linkToolResultEntry(id, entry.entry_id, entry.step_id, entry.seq, entry.byte_length, summary));
        stmt('DELETE FROM history_inspection_scans WHERE coordinator_session_id=? AND entry_id=?').run(id, entry.entry_id);
        advanceWatermark(id, entry.seq);
    }
    function noteResultLink(id: string, entryId: string, stepId: string, seq: number, byteLength: number, link: ResultLink): void {
        if (link === 'deferred')
            deferToolResult(id, entryId, stepId, seq, byteLength);
        else
            resolveDeferredToolResult(id, entryId);
    }
    /**
     * 把一条已落盘的工具结果接回它的调用，返回是否真的建立了配对。
     *
     * 批量保存先写条目再写 model step，因此结果落盘时归属尚不可证明：那时它保持未配对（deferred），
     * 由显式补齐在 step 记录出现后接上。读取路径不做修复，也不猜 call 属于谁。
     */
    function linkToolResultEntry(id: string, entryId: string, stepId: string, seq: number, byteLength: number, summary?: EntryRow): ResultLink {
        const row = summary ?? rowFor(id, entryId, true);
        const summaryEntry = row === undefined ? undefined : metadata(row);
        return linkResult(id, callEntryForStep(id, stepId), summaryEntry?.toolCallId ?? '', summaryEntry?.toolName, entryId, seq, byteLength, statusOfOutcome(outcomeOfBody(id, entryId)));
    }
    /** 延后待办：只登记过、且生产者 step 尚未落盘的结果。表通常为空，因此探测是常数成本。 */
    function deferredToolResult(): { readonly coordinator_session_id: string; readonly entry_id: string; readonly step_id: string; readonly seq: number; readonly byte_length: number } | undefined {
        return stmt('SELECT coordinator_session_id,entry_id,step_id,seq,byte_length FROM history_call_deferred ORDER BY coordinator_session_id,seq LIMIT 1').get() as { readonly coordinator_session_id: string; readonly entry_id: string; readonly step_id: string; readonly seq: number; readonly byte_length: number } | undefined;
    }
    function pendingTallyReplay(): { readonly coordinator_session_id: string; readonly activity_id: string } | undefined {
        return stmt('SELECT coordinator_session_id,activity_id FROM history_activity_replay ORDER BY coordinator_session_id,activity_id LIMIT 1').get() as { readonly coordinator_session_id: string; readonly activity_id: string } | undefined;
    }
    /** 推进一条待补齐条目一个块；返回本次实际读回量，预算耗尽时停下等待下一次调用。 */
    function advanceInspectionEntry(entry: PendingEntry, budget: number, maxItems: number): { readonly scannedBytes: number; readonly scannedItems: number; readonly exhausted: boolean } {
        const id = entry.coordinator_session_id;
        const saved = stmt('SELECT state FROM history_inspection_scans WHERE coordinator_session_id=? AND entry_id=?').get(id, entry.entry_id) as { state: string } | undefined;
        const state: MetadataScanState = saved === undefined ? createMetadataScanState() : JSON.parse(saved.state) as MetadataScanState;
        const remaining = entry.metadata_length - state.pos;
        // A tool completion also reads its summary and outcome prefix. Reserve those
        // bytes before finishing so the advertised batch includes every source read.
        const completionBytes = entry.role === 'tool' ? entry.metadata_length + Math.min(512, entry.byte_length) : 0;
        if (completionBytes > HISTORY_PAGE_BYTES)
            throw new Error('History result metadata exceeds inspection budget');
        if (remaining <= 0) {
            if (completionBytes > budget)
                return { scannedBytes: 0, scannedItems: 0, exhausted: true };
            ensureProgress(id);
            if (saved === undefined && breaksGroup(entry.role, entry.byte_length)) setOpenActivity(id, null);
            completeEntry(entry);
            return { scannedBytes: completionBytes, scannedItems: 1, exhausted: false };
        }
        const length = Math.min(TOOL_CALL_SCAN_CHUNK_BYTES, Math.max(0, budget - completionBytes), remaining);
        if (length <= 0)
            return { scannedBytes: 0, scannedItems: 0, exhausted: true };
        const spans = scanMetadataBytes(state, readMetadataBytes(id, entry.entry_id, state.pos, length), state.pos, maxItems);
        ensureProgress(id);
        if (saved === undefined && breaksGroup(entry.role, entry.byte_length)) setOpenActivity(id, null);
        for (const span of spans) indexSpan(id, entry.seq, entry.entry_id, entry.step_id, span);
        if (state.pos >= entry.metadata_length) completeEntry(entry);
        else stmt('INSERT INTO history_inspection_scans VALUES(?,?,?,?) ON CONFLICT(coordinator_session_id,entry_id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at').run(id, entry.entry_id, JSON.stringify(state), clock());
        return { scannedBytes: length + (state.pos >= entry.metadata_length ? completionBytes : 0), scannedItems: Math.max(1, spans.length), exhausted: false };
    }
    function prepareHistoryInspection(): { readonly ready: boolean; readonly scannedBytes: number; readonly scannedItems: number } {
        // 一次调用是一个有界工作单元，也就是一个短事务：按块提交，崩溃后从未完成的那一条重扫，
        // 已写入的定位是幂等的，不会重复计数。
        return atomic(() => {
            let scannedBytes = 0, scannedItems = 0;
            while (scannedBytes < HISTORY_PAGE_BYTES && scannedItems < HISTORY_PAGE_ITEMS) {
                const entry = pendingEntry();
                if (entry !== undefined) {
                    const step = advanceInspectionEntry(entry, HISTORY_PAGE_BYTES - scannedBytes, HISTORY_PAGE_ITEMS - scannedItems);
                    scannedBytes += step.scannedBytes;
                    scannedItems += step.scannedItems;
                    if (step.exhausted)
                        break;
                    continue;
                }
                // 条目水位已经到位，剩下的工作是把先前因 model step 尚未落盘而延后的结果接上。
                const deferred = deferredToolResult();
                if (deferred !== undefined) {
                    const row = stmt('SELECT length(CAST(summary_metadata AS BLOB)) AS bytes FROM conversation_entries WHERE coordinator_session_id=? AND entry_id=?')
                        .get(deferred.coordinator_session_id, deferred.entry_id) as { bytes: number } | undefined;
                    const bytes = (row?.bytes ?? 0) + Math.min(512, deferred.byte_length);
                    if (bytes > HISTORY_PAGE_BYTES)
                        throw new Error('History result metadata exceeds inspection budget');
                    if (scannedBytes + bytes > HISTORY_PAGE_BYTES)
                        break;
                    linkToolResultEntry(deferred.coordinator_session_id, deferred.entry_id, deferred.step_id, deferred.seq, deferred.byte_length);
                    scannedBytes += bytes;
                    // 补齐是收敛动作：接得上就配对，接不上就确认它永久未配对，两种结局都结清这条待办。
                    // 待办只会变少，因此补齐既不会原地打转，也不会永远显示“处理中”。
                    resolveDeferredToolResult(deferred.coordinator_session_id, deferred.entry_id);
                    scannedItems += 1;
                    continue;
                }
                // 回填留下的陈旧计数链按条目预算逐段重放；重放未完成前读取方看到的是“处理中”。
                const replay = pendingTallyReplay();
                if (replay === undefined)
                    break;
                const replayed = replayTallyStep(replay.coordinator_session_id, replay.activity_id, HISTORY_PAGE_ITEMS - scannedItems);
                if (replayed === 0)
                    break;
                scannedItems += replayed;
            }
            // 就绪判断只探会话注册表和两张小待办表，不扫历史。
            return { ready: pendingSession() === undefined && deferredToolResult() === undefined && pendingTallyReplay() === undefined, scannedBytes, scannedItems };
        });
    }
    function recordToolObservation(input: HistoryToolObservation): CheckpointWriteResult {
        try {
            if (input.kind !== 'unknown')
                throw new Error('Only a real unknown outcome is observable');
            // 观测必须落在原调用身份上：身份对不上就没有可观测的事实。
            const call = stmt('SELECT activity_id,entry_id,call_id,seq,ordinal FROM history_call_index WHERE coordinator_session_id=? AND entry_id=? AND step_id=? AND call_id=? AND operation_id=?')
                .get(input.coordinatorSessionId, input.entryId, input.stepId, input.callId, input.operationId) as { activity_id: string; entry_id: string; call_id: string; seq: number; ordinal: number } | undefined;
            if (call === undefined)
                throw new Error('Tool observation does not match a committed call');
            atomic(() => {
                const old = stmt('SELECT reason FROM history_call_observations WHERE coordinator_session_id=? AND call_entry_id=? AND call_id=?').get(input.coordinatorSessionId, input.entryId, input.callId) as { reason: string } | undefined;
                // 诊断文案可能随对账变化；同一调用的 unknown 事实只记录一次，保留首次观测。
                if (old !== undefined)
                    return;
                const before = memberStatus(input.coordinatorSessionId, input.entryId, input.callId);
                const observedSequence = headSequence(input.coordinatorSessionId);
                stmt('INSERT INTO history_call_observations VALUES(?,?,?,?,?,?,?,?)').run(input.coordinatorSessionId, input.entryId, input.callId, input.stepId, input.operationId, input.reason, clock(), observedSequence);
                // 配对结果优先：已有结果的调用，观测只补历史，活动计数保持原样。
                // 观测是“此刻”才知道的事实，不属于调用当时：它记在当前已提交序号上，因此不会回填旧链，
                // 读更老上界的读者也不会看到当时还不存在的事实。
                if (before === 'unconfirmed')
                    applyOutcomeChange(input.coordinatorSessionId, call.activity_id, observedSequence, 'unconfirmed', 'unknown');
            });
            return { kind: 'saved' };
        }
        catch (error) {
            return failed(error);
        }
    }
    const store: CheckpointStore = {
        checkpointer: saver, loadCheckpoint, updateCheckpoint, readEntry, readHistoryBody,
        saveCheckpoint(input) { try {
            const state = valid(input);
            const stepsByEntry = new Map(state.committedModelSteps.map(step => [step.entryId, step])), placed = new Set<string>();
            atomic(() => { const { committedMessages, committedModelSteps, wakeBatches } = state; writeCore(headOf(state)); for (const entry of committedMessages)
                {
                    insertEntry(state.coordinatorSessionId, entry);
                    // 模型 step 紧随它的 canonical 条目落盘，它之后的工具结果在写入时就能证明归属。
                    // 条目序号、派生定位与计数因此一次按时间顺序产生，不会先写下“未来”的计数再回头改。
                    const own = stepsByEntry.get(entry.entryId);
                    if (own !== undefined) { insertStep(state.coordinatorSessionId, own); placed.add(own.stepId); }
                }
                for (const step of committedModelSteps)
                    if (!placed.has(step.stepId)) insertStep(state.coordinatorSessionId, step);
                for (const wake of wakeBatches)
                putWake(wake);
            });
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
            const { entry } = input, callId = entry.toolCallId;
            if (callId === undefined)
                throw new Error('Tool result has no call identity');
            atomic(() => {
                const head = requireCore(input.coordinatorSessionId);
                if (!verifyCommittedCall(input.coordinatorSessionId, entry.stepId, callId, entry.toolName))
                    throw new Error('Tool result has no matching committed call');
                if (insertEntry(input.coordinatorSessionId, entry)) writeCore({ ...head, graphPosition: input.graphPosition });
            });
            return { kind: 'saved' };
        }
        catch (error) {
            return failed(error);
        } },
        readWakeBatch,
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
        readHistoryPage(input) { return metadataPage(historyPageQuerySchema.parse(input)); },
        readUserHistoryPage(input) { return metadataPage({ ...userHistoryQuerySchema.parse(input), role: 'user' }); },
        readHistoryInspection, readHistoryCalls, readHistoryArguments, prepareHistoryInspection, recordToolObservation,
        loadNativeWindowOwner, loadPortableCapsule, loadMechanicalShake,
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
        saveMechanicalShake(id, artifact) { try {
            requireCore(id);
            valid({ ...empty(id), contextMaterial: { nativeWindowOwner: null, capsule: null, mechanicalShake: artifact } });
            atomic(() => { const bound = stmt('SELECT seq FROM conversation_entries WHERE coordinator_session_id=? ORDER BY seq DESC LIMIT 1').get(id) as {
                seq: number;
            } | undefined; stmt('INSERT INTO mechanical_shake_artifacts VALUES(?,?,?,?,?) ON CONFLICT(coordinator_session_id) DO UPDATE SET source_revision=excluded.source_revision,shaken_step_ids=excluded.shaken_step_ids,through_seq=excluded.through_seq,updated_at=excluded.updated_at').run(id, artifact.sourceRevision, JSON.stringify(artifact.shakenStepIds), bound?.seq ?? 0, clock()); });
            return { kind: 'saved' };
        }
        catch (error) {
            return failed(error);
        } },
        clearMechanicalShake(id) { try {
            stmt('DELETE FROM mechanical_shake_artifacts WHERE coordinator_session_id=?').run(id);
            return { kind: 'saved' };
        }
        catch (error) {
            return failed(error);
        } },
        close() { db.close(); },
    };
    return { kind: 'opened', store };
}
