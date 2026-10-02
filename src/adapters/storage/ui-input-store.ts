/**
 * IC-13：UI 输入存储的 SQLite 实现（Owner: `protect-tui-input`）。
 *
 * 只做持久化机制：短事务 CAS、tombstone 版本标记、单活跃提交的库级约束、容量计量与边界 schema
 * 校验。它不决定何时保存、不选择冲突版本、也不判断一次提交是否被受理——那是保护模块与
 * `submission-status` 的职责，本文件连 checkpoint 都不读。
 *
 * 库是 Git common dir 下的 `orca-companion/ui.sqlite`：与 `coordination.sqlite`、
 * `checkpoints.sqlite` 同目录不同库，不共享表，也不伪装跨库事务。`node:sqlite` 是实验性 API，
 * 因此访问集中在本文件。
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

import { z } from 'zod';

import {
  DEFAULT_UI_INPUT_LIMITS,
  UI_ACTIVE_SUBMISSION_STATUSES,
  UI_SUBMISSION_STATUSES,
  type UiInputInvalidRecord,
  type UiInputLimits,
  type UiInputListResult,
  type UiInputReadResult,
  type UiInputRecord,
  type UiInputRemoveInput,
  type UiInputRemoveResult,
  type UiInputStoreFailure,
  type UiInputStoreHandle,
  type UiInputUsage,
  type UiInputValue,
  type UiInputWriteInput,
  type UiInputWriteResult,
} from '../../application/ports/ui-input-store.js';
import { describeError } from './schema.js';

export const UI_INPUT_SCHEMA_VERSION = 1;

const SCHEMA_VERSION_KEY = 'ui_input_schema_version';
const SEQUENCE_KEY = 'ui_input_seq';

/** SQLite 主结果码：约束族（PRIMARY KEY / UNIQUE / NOT NULL / CHECK / FOREIGN KEY）。 */
const SQLITE_CONSTRAINT = 19;

const activeStatusLiterals = UI_ACTIVE_SUBMISSION_STATUSES.map((status) => `'${status}'`).join(', ');

const UI_INPUT_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ui_input_meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   ) STRICT`,
  // value 为 NULL 即 tombstone：只保留递增 revision 以拒绝删除前的旧写入，不占容量、不进列表。
  `CREATE TABLE IF NOT EXISTS ui_input (
     key TEXT PRIMARY KEY,
     revision INTEGER NOT NULL,
     seq INTEGER NOT NULL,
     value TEXT,
     scope_id TEXT,
     session_id TEXT,
     kind TEXT,
     status TEXT,
     bytes INTEGER NOT NULL
   ) STRICT`,
  // 「同一 Scope/Session 最多一条活跃提交」由库保证，跨连接竞争不需要调用方自觉。
  `CREATE UNIQUE INDEX IF NOT EXISTS ui_input_submission_lane
     ON ui_input(scope_id, session_id)
     WHERE kind = 'submission' AND status IN (${activeStatusLiterals})`,
  `CREATE INDEX IF NOT EXISTS ui_input_scope_seq ON ui_input(scope_id, seq)`,
];

const nonEmptyString = z.string().min(1);

const pasteBlockSchema = z.strictObject({ id: nonEmptyString, text: z.string() });

const draftSchema = z.strictObject({
  text: z.string(),
  cursor: z.number().int().nonnegative(),
  pasteBlocks: z.array(pasteBlockSchema),
});

const messageTargetSchema = z.strictObject({
  kind: z.literal('message'),
  coordinationScopeId: nonEmptyString,
  coordinatorSessionId: nonEmptyString,
});

const answerTargetSchema = z.strictObject({
  kind: z.literal('answer'),
  coordinationScopeId: nonEmptyString,
  coordinatorSessionId: nonEmptyString,
  interactionId: nonEmptyString,
  expectedRevision: z.number().int().nonnegative(),
});

const inputTargetSchema = z.discriminatedUnion('kind', [messageTargetSchema, answerTargetSchema]);

const submissionValueSchema = z.strictObject({
  kind: z.literal('submission'),
  target: inputTargetSchema,
  draft: draftSchema,
  submissionId: nonEmptyString,
  status: z.enum(UI_SUBMISSION_STATUSES),
  reason: z.string().nullable(),
});

/** 落盘值与写入入参共用同一份边界 schema：读回来的和写进去的必须是同一种形状。 */
const inputValueSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('draft'), target: inputTargetSchema, draft: draftSchema }),
  z.strictObject({ kind: z.literal('conflict'), target: inputTargetSchema, draft: draftSchema }),
  submissionValueSchema,
]);

type UiInputRow = {
  readonly key: string;
  readonly revision: number;
  readonly seq: number;
  readonly value: string | null;
  readonly scope_id: string | null;
  readonly session_id: string | null;
  readonly kind: string | null;
  readonly status: string | null;
  readonly bytes: number;
};

type DecodedValue =
  | { readonly ok: true; readonly value: UiInputValue }
  | { readonly ok: false; readonly message: string };

/**
 * `node:sqlite` 只把行描述为 `Record<string, SQLOutputValue>`；具体行形状由本文件的 decode 与
 * schema 校验负责，因此这里只做一次受控转换，不把 unknown 泄漏给领域类型。
 */
function one<T>(statement: StatementSync, ...params: SQLInputValue[]): T | undefined {
  return statement.get(...params) as unknown as T | undefined;
}

function many<T>(statement: StatementSync, ...params: SQLInputValue[]): readonly T[] {
  return statement.all(...params) as unknown as readonly T[];
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length === 0 ? '<root>' : issue.path.join('.')}: ${issue.message}`)
    .join('; ');
}

function failure(code: string, message: string): UiInputStoreFailure {
  return { kind: 'failed', code, message };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as { readonly errcode?: unknown }).errcode;
  return typeof code === 'number' && (code & 0xff) === SQLITE_CONSTRAINT;
}

/**
 * 容量按正文与粘贴载荷的 UTF-8 字节求和，不含 JSON 开销。
 *
 * 粘贴全文同时展开进正文，因此同一段内容会被计两次——这是「保留完整载荷」的物理表示，
 * 不是重复记账。
 */
function payloadBytes(value: UiInputValue): number {
  let total = Buffer.byteLength(value.draft.text, 'utf8');
  for (const block of value.draft.pasteBlocks) {
    total += Buffer.byteLength(block.text, 'utf8');
  }
  return total;
}

function readMeta(db: DatabaseSync, key: string): string | null {
  const row = one<{ readonly value: string }>(db.prepare('SELECT value FROM ui_input_meta WHERE key = ?'), key);
  return row === undefined ? null : row.value;
}

function writeMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    `INSERT INTO ui_input_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

function nextSequence(db: DatabaseSync): number {
  const current = readMeta(db, SEQUENCE_KEY);
  const parsed = current === null ? 0 : Number.parseInt(current, 10);
  const next = (Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0) + 1;
  writeMeta(db, SEQUENCE_KEY, String(next));
  return next;
}

/** 整库容量计量：上限按仓库计算，因此它必须覆盖所有 Scope 而不只是当前列出的那个。 */
function readUsage(db: DatabaseSync): UiInputUsage {
  const row = one<{ readonly records: number; readonly bytes: number }>(
    db.prepare('SELECT COUNT(*) AS records, COALESCE(SUM(bytes), 0) AS bytes FROM ui_input WHERE value IS NOT NULL'),
  );
  return { records: row?.records ?? 0, bytes: row?.bytes ?? 0 };
}

function readRow(db: DatabaseSync, key: string): UiInputRow | undefined {
  return one<UiInputRow>(db.prepare('SELECT * FROM ui_input WHERE key = ?'), key);
}

function decodeValue(raw: string): DecodedValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, message: `不是合法 JSON：${describeError(error)}` };
  }
  const result = inputValueSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, message: describeIssues(result.error) };
  }
  return { ok: true, value: result.data };
}

function recordOf(value: UiInputValue, key: string, revision: number): UiInputRecord {
  return { ...value, key, revision };
}

/** tombstone 与不可读行都只报 null；不可读行由 `list` 的 invalidRecords 单独报告。 */
function currentRecordOf(row: UiInputRow | undefined): UiInputRecord | null {
  if (row === undefined || row.value === null) {
    return null;
  }
  const decoded = decodeValue(row.value);
  return decoded.ok ? recordOf(decoded.value, row.key, row.revision) : null;
}

export type UiInputStoreOpenFailureCode = 'invalid_limits' | 'unreadable' | 'schema_version_unsupported';

export type OpenUiInputStoreResult =
  | { readonly kind: 'opened'; readonly store: UiInputStoreHandle }
  | { readonly kind: 'failed'; readonly code: UiInputStoreOpenFailureCode; readonly message: string };

export type OpenUiInputStoreOptions = {
  readonly databasePath: string;
  readonly limits?: UiInputLimits;
};

/**
 * 打开（必要时创建）`ui.sqlite`。
 *
 * 它不做 migration：版本位按精确字符串比较，不是当前实现就拒绝启动，因为旧代码猜测新记录或
 * 新代码猜测旧记录都会写坏用户输入。
 */
export function openUiInputStore(options: OpenUiInputStoreOptions): OpenUiInputStoreResult {
  const limits = options.limits ?? DEFAULT_UI_INPUT_LIMITS;
  if (!isRevision(limits.maxRecords) || !isRevision(limits.maxBytes)) {
    return { kind: 'failed', code: 'invalid_limits', message: '容量上限必须是非负安全整数' };
  }
  const { databasePath } = options;

  let db: DatabaseSync;
  try {
    mkdirSync(dirname(databasePath), { recursive: true });
    db = new DatabaseSync(databasePath);
  } catch (error) {
    return { kind: 'failed', code: 'unreadable', message: describeError(error) };
  }
  try {
    db.exec('PRAGMA busy_timeout = 5000');
  } catch (error) {
    db.close();
    return { kind: 'failed', code: 'unreadable', message: describeError(error) };
  }

  const rollback = (): void => {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 事务已不可用；以原始原因为准。
    }
  };

  try {
    db.exec('BEGIN IMMEDIATE');
    const existingTables = many<{ readonly name: string }>(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('ui_input', 'ui_input_meta')"),
    );
    const version = existingTables.some((table) => table.name === 'ui_input_meta')
      ? readMeta(db, SCHEMA_VERSION_KEY)
      : null;
    if (existingTables.length > 0 && version !== String(UI_INPUT_SCHEMA_VERSION)) {
      rollback();
      db.close();
      return {
        kind: 'failed',
        code: 'schema_version_unsupported',
        message: `库内 schema 版本 ${version ?? '未知'} 不是当前实现的 ${String(UI_INPUT_SCHEMA_VERSION)}；UI 输入库不做 migration`,
      };
    }
    for (const statement of UI_INPUT_DDL) {
      db.exec(statement);
    }
    if (version === null) {
      writeMeta(db, SCHEMA_VERSION_KEY, String(UI_INPUT_SCHEMA_VERSION));
    }
    db.exec('COMMIT');
  } catch (error) {
    rollback();
    db.close();
    return { kind: 'failed', code: 'unreadable', message: describeError(error) };
  }

  let closed = false;
  const closedFailure = (): UiInputStoreFailure => failure('store_closed', 'UI 输入存储已关闭');

  const read = (key: string): UiInputReadResult => {
    if (closed) {
      return closedFailure();
    }
    if (!isNonEmptyString(key)) {
      return failure('invalid_request', 'key 必须是非空字符串');
    }
    try {
      const row = readRow(db, key);
      if (row === undefined) {
        return { kind: 'record', record: null, revision: 0 };
      }
      if (row.value === null) {
        return { kind: 'record', record: null, revision: row.revision };
      }
      const decoded = decodeValue(row.value);
      if (!decoded.ok) {
        return failure('record_invalid', `记录 ${key} 无法解析：${decoded.message}`);
      }
      return { kind: 'record', record: recordOf(decoded.value, row.key, row.revision), revision: row.revision };
    } catch (error) {
      return failure('unreadable', describeError(error));
    }
  };

  const list = (coordinationScopeId: string): UiInputListResult => {
    if (closed) {
      return closedFailure();
    }
    if (!isNonEmptyString(coordinationScopeId)) {
      return failure('invalid_request', 'coordinationScopeId 必须是非空字符串');
    }
    try {
      const rows = many<UiInputRow>(
        db.prepare('SELECT * FROM ui_input WHERE scope_id = ? AND value IS NOT NULL ORDER BY seq, key'),
        coordinationScopeId,
      );
      const records: UiInputRecord[] = [];
      const invalidRecords: UiInputInvalidRecord[] = [];
      for (const row of rows) {
        if (row.value === null) {
          continue;
        }
        const decoded = decodeValue(row.value);
        if (decoded.ok) {
          records.push(recordOf(decoded.value, row.key, row.revision));
        } else {
          invalidRecords.push({ key: row.key, revision: row.revision });
        }
      }
      return { kind: 'records', records, invalidRecords, usage: readUsage(db) };
    } catch (error) {
      return failure('unreadable', describeError(error));
    }
  };

  const write = (input: UiInputWriteInput): UiInputWriteResult => {
    if (closed) {
      return closedFailure();
    }
    if (typeof input !== 'object' || input === null) {
      return failure('invalid_request', '写入入参必须是对象');
    }
    if (!isNonEmptyString(input.key)) {
      return failure('invalid_request', 'key 必须是非空字符串');
    }
    if (!isRevision(input.expectedRevision)) {
      return failure('invalid_request', 'expectedRevision 必须是非负安全整数');
    }
    const parsed = inputValueSchema.safeParse(input.record);
    if (!parsed.success) {
      return failure('record_invalid', `记录不符合 schema：${describeIssues(parsed.error)}`);
    }
    const value = parsed.data;
    const bytes = payloadBytes(value);

    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (error) {
      return failure('unreadable', describeError(error));
    }
    try {
      const row = readRow(db, input.key);
      // 既有记录不可解析时只能由调用方显式 remove：写入一律 fail closed，绝不覆盖用户数据。
      if (row !== undefined && row.value !== null && !decodeValue(row.value).ok) {
        rollback();
        return failure('record_invalid', `记录 ${input.key} 当前无法解析，请先显式删除再写入`);
      }
      const currentRevision = row?.revision ?? 0;
      if (currentRevision !== input.expectedRevision) {
        rollback();
        return { kind: 'conflict', current: currentRecordOf(row), revision: currentRevision };
      }
      const usage = readUsage(db);
      const addedRecords = row !== undefined && row.value !== null ? 0 : 1;
      const addedBytes = bytes - (row?.bytes ?? 0);
      if (usage.records + addedRecords > limits.maxRecords || usage.bytes + addedBytes > limits.maxBytes) {
        rollback();
        return failure(
          'capacity_exceeded',
          `容量上限（${String(limits.maxRecords)} 条 / ${String(limits.maxBytes)} 字节）已满，请显式清理`,
        );
      }
      const nextRevision = currentRevision + 1;
      db.prepare(
        `INSERT INTO ui_input (key, revision, seq, value, scope_id, session_id, kind, status, bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET revision = excluded.revision, seq = excluded.seq,
           value = excluded.value, scope_id = excluded.scope_id, session_id = excluded.session_id,
           kind = excluded.kind, status = excluded.status, bytes = excluded.bytes`,
      ).run(
        input.key,
        nextRevision,
        nextSequence(db),
        JSON.stringify(value),
        value.target.coordinationScopeId,
        value.target.coordinatorSessionId,
        value.kind,
        value.kind === 'submission' ? value.status : null,
        bytes,
      );
      db.exec('COMMIT');
      return { kind: 'saved', record: recordOf(value, input.key, nextRevision) };
    } catch (error) {
      rollback();
      if (isConstraintError(error)) {
        return failure('submission_lane_busy', `同一 Session 已有一条待确认提交：${describeError(error)}`);
      }
      return failure('unreadable', describeError(error));
    }
  };

  const remove = (input: UiInputRemoveInput): UiInputRemoveResult => {
    if (closed) {
      return closedFailure();
    }
    if (typeof input !== 'object' || input === null) {
      return failure('invalid_request', '删除入参必须是对象');
    }
    if (!isNonEmptyString(input.key)) {
      return failure('invalid_request', 'key 必须是非空字符串');
    }
    if (!isRevision(input.expectedRevision)) {
      return failure('invalid_request', 'expectedRevision 必须是非负安全整数');
    }

    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (error) {
      return failure('unreadable', describeError(error));
    }
    try {
      const row = readRow(db, input.key);
      const currentRevision = row?.revision ?? 0;
      if (currentRevision !== input.expectedRevision) {
        rollback();
        return { kind: 'conflict', current: currentRecordOf(row), revision: currentRevision };
      }
      // 删除只把记录降级成 tombstone：版本继续递增，因此持有删除前 revision 的写入必定冲突。
      const nextRevision = currentRevision + 1;
      db.prepare(
        `INSERT INTO ui_input (key, revision, seq, value, scope_id, session_id, kind, status, bytes)
         VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL, 0)
         ON CONFLICT(key) DO UPDATE SET revision = excluded.revision, seq = excluded.seq,
           value = NULL, scope_id = NULL, session_id = NULL, kind = NULL, status = NULL, bytes = 0`,
      ).run(input.key, nextRevision, nextSequence(db));
      db.exec('COMMIT');
      return { kind: 'removed', revision: nextRevision };
    } catch (error) {
      rollback();
      if (isConstraintError(error)) {
        return failure('constraint', describeError(error));
      }
      return failure('unreadable', describeError(error));
    }
  };

  return {
    kind: 'opened',
    store: {
      read,
      list,
      write,
      remove,
      close: () => {
        if (closed) {
          return;
        }
        closed = true;
        try {
          db.close();
        } catch {
          // 驱动已关闭或不可用；关闭失败没有可报告的出口。
        }
      },
    },
  };
}
