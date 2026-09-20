/**
 * IC-04：Coordinator Session checkpoint store
 * （Owner: `m1-run-coordinator-sessions`）。
 *
 * 两个职责刻意放在同一个文件、同一个 `checkpoints.sqlite` 里，因为它们是同一件事的两面：
 *
 * 1. **LangGraph 图的运行状态**由 `SqliteSaver` 保存在它自己的 `checkpoints` / `writes` 表里，
 *    负责图位置、pending writes 与 tool step 的可恢复性。本文件不复制它的表结构，也不读写它的行。
 * 2. **Coordinator Session 的会话记录**由本文件的 `coordinator_sessions` 表保存，是
 *    `CoordinatorSessionState` 的唯一归属。图节点通过本模块读写它，而不是把它塞进图通道，
 *    这样已提交消息、Wake Batch 与压缩产物都只有一个真值。
 *
 * 两类上下文压缩产物分开保存：Native Compacted Window 的 owner metadata 与可移植 Context Capsule
 * 各有自己的表。删除或损坏任一方都不会影响另一方，这是 D10 的直接落地。
 *
 * 数据库驱动是 `better-sqlite3`（LangGraph SqliteSaver 的依赖），与前置的 `coordination.sqlite`
 * 使用不同驱动、不同文件，两者不共享表，也不伪装跨库事务。
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';

import type {
  CoordinatorSessionId,
} from '../../application/dto/identity.js';
import type { CheckpointRecoveryRead, CheckpointWriteResult } from '../../application/coordinator/runtime-guard.js';
import type { WakeCheckpointCommit } from '../../application/coordinator/wake-admission.js';
import type {
  NativeCompactedWindowOwner,
  PortableContextCapsule,
  CommittedModelStep,
  CoordinatorSessionState,
  WakeBatch,
} from '../../domain/coordinator/session-state.js';
import {
  COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
  parseCoordinatorSessionState,
} from '../../domain/coordinator/session-state.js';
import { describeError } from './schema.js';

export const CHECKPOINT_SCHEMA_VERSION = 1;

const CHECKPOINT_VERSION_KEY = 'checkpoint_schema_version';

const CHECKPOINT_MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS checkpoint_meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   ) STRICT`,
  // 会话记录只保存除 contextMaterial 以外的部分：压缩产物有各自的表。
  `CREATE TABLE IF NOT EXISTS coordinator_sessions (
     coordinator_session_id TEXT PRIMARY KEY,
     schema_version INTEGER NOT NULL,
     session_state TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   ) STRICT`,
  `CREATE TABLE IF NOT EXISTS native_window_owners (
     coordinator_session_id TEXT PRIMARY KEY,
     owner_ref TEXT NOT NULL,
     items TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   ) STRICT`,
  `CREATE TABLE IF NOT EXISTS portable_capsules (
     coordinator_session_id TEXT PRIMARY KEY,
     capsule_id TEXT NOT NULL,
     replaced_from_step_id TEXT NOT NULL,
     replaced_to_step_id TEXT NOT NULL,
     text TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   ) STRICT`,
];

/**
 * `better-sqlite3` 不是本项目的直接依赖（它随 SqliteSaver 一起安装），因此它自己的类型在本包里
 * 无法解析。这里只声明本文件实际用到的极小结构，并在打开时做一次受控转换；`node:sqlite` 的
 * coordination store 与本文件各自内聚，互不共享表。
 */
type SqliteStatement = {
  run(...params: readonly unknown[]): unknown;
  get(...params: readonly unknown[]): unknown;
  all(...params: readonly unknown[]): unknown;
};

type SqliteDatabase = {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
};

export type CheckpointStoreOpenFailureCode =
  | 'unreadable'
  | 'schema_version_unsupported'
  | 'migration_failed';

/** 被 Capsule 取代的区间，按已提交 step 的闭区间表示。 */
export type CommittedMessageRange = {
  readonly replacedFromStepId: string;
  readonly replacedToStepId: string;
};

export type CheckpointStore = {
  /**
   * 交给 LangGraph `compile` 的 checkpointer。调用方按 `COORDINATOR_DURABILITY` 设置耐久度。
   */
  readonly checkpointer: BaseCheckpointSaver;

  saveCheckpoint(state: CoordinatorSessionState): CheckpointWriteResult;
  loadCheckpoint(coordinatorSessionId: CoordinatorSessionId): CheckpointRecoveryRead;
  /**
   * 读回底层完整已提交消息。
   *
   * 给定区间时只返回被 Capsule 取代的那段原始消息——Capsule 是派生视图，永远不覆盖原始对话，
   * 所以被取代的区间始终可以读回。
   */
  readCommittedMessages(
    coordinatorSessionId: CoordinatorSessionId,
    range?: CommittedMessageRange,
  ): readonly unknown[];

  saveNativeWindowOwner(
    coordinatorSessionId: CoordinatorSessionId,
    owner: NativeCompactedWindowOwner,
  ): CheckpointWriteResult;
  loadNativeWindowOwner(coordinatorSessionId: CoordinatorSessionId): NativeCompactedWindowOwner | null;
  /** 迁移到 Capsule 之后清除原生项；只影响原生窗口一侧，Capsule 不受影响。 */
  clearNativeWindowOwner(coordinatorSessionId: CoordinatorSessionId): CheckpointWriteResult;
  savePortableCapsule(
    coordinatorSessionId: CoordinatorSessionId,
    capsule: PortableContextCapsule,
  ): CheckpointWriteResult;
  loadPortableCapsule(coordinatorSessionId: CoordinatorSessionId): PortableContextCapsule | null;

  /**
   * 同步把一个 Wake Batch 追加进会话历史（IC-04 的 checkpoint 侧 seam）。
   *
   * 同一 WakeBatchId 不会被写入两次：已存在时以 `already-committed` 报告，让调用方走补齐路径。
   */
  commitWakeBatch(batch: WakeBatch): WakeCheckpointCommit;

  close(): void;
};

export type { WakeCheckpointCommit };

export type OpenCheckpointStoreResult =
  | { readonly kind: 'opened'; readonly store: CheckpointStore }
  | {
      readonly kind: 'failed';
      readonly code: CheckpointStoreOpenFailureCode;
      readonly message: string;
    };

export type OpenCheckpointStoreOptions = {
  readonly databasePath: string;
  /** 可注入时钟：适配器不隐藏时间来源，领域层不读时钟。 */
  readonly clock?: () => number;
};

type SessionCore = Omit<CoordinatorSessionState, 'contextMaterial'>;

function coreOf(state: CoordinatorSessionState): SessionCore {
  return {
    schemaVersion: state.schemaVersion,
    coordinatorSessionId: state.coordinatorSessionId,
    committedMessages: state.committedMessages,
    graphPosition: state.graphPosition,
    committedModelSteps: state.committedModelSteps,
    wakeBatches: state.wakeBatches,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stepIndexById(steps: readonly CommittedModelStep[]): ReadonlyMap<string, number> {
  return new Map(steps.map((step, index) => [step.stepId, index]));
}

/**
 * 打开（或创建）`checkpoints.sqlite` 并升级到当前 schema。
 *
 * 库内 schema 版本高于本实现时拒绝启动：旧代码无法理解新记录，猜测只会写坏会话。
 */
export function openCheckpointStore(options: OpenCheckpointStoreOptions): OpenCheckpointStoreResult {
  const clock = options.clock ?? (() => Date.now());
  try {
    mkdirSync(dirname(options.databasePath), { recursive: true });
  } catch (error) {
    return { kind: 'failed', code: 'unreadable', message: describeError(error) };
  }

  let saver: SqliteSaver;
  try {
    saver = SqliteSaver.fromConnString(options.databasePath);
  } catch (error) {
    return { kind: 'failed', code: 'unreadable', message: describeError(error) };
  }
  const db = saver.db as unknown as SqliteDatabase;

  const readVersion = (): number | null => {
    const exists = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'checkpoint_meta'`)
      .get() as { readonly name: string } | undefined;
    if (exists === undefined) {
      return null;
    }
    const row = db.prepare(`SELECT value FROM checkpoint_meta WHERE key = ?`).get(CHECKPOINT_VERSION_KEY) as
      | { readonly value: string }
      | undefined;
    if (row === undefined) {
      return null;
    }
    const parsed = Number.parseInt(row.value, 10);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  };

  try {
    const current = readVersion() ?? 0;
    if (current > CHECKPOINT_SCHEMA_VERSION) {
      return {
        kind: 'failed',
        code: 'schema_version_unsupported',
        message: `库内 checkpoint schema 版本 ${String(current)} 高于当前实现的 ${String(CHECKPOINT_SCHEMA_VERSION)}`,
      };
    }
    db.exec('BEGIN IMMEDIATE');
    for (const statement of CHECKPOINT_MIGRATIONS) {
      db.exec(statement);
    }
    db.prepare(
      `INSERT INTO checkpoint_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(CHECKPOINT_VERSION_KEY, String(CHECKPOINT_SCHEMA_VERSION));
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 事务已不可用；以原始失败为准。
    }
    return { kind: 'failed', code: 'migration_failed', message: describeError(error) };
  }

  const readCoreRow = (coordinatorSessionId: string): { readonly session_state: string } | undefined =>
    db
      .prepare('SELECT session_state FROM coordinator_sessions WHERE coordinator_session_id = ?')
      .get(coordinatorSessionId) as { readonly session_state: string } | undefined;

  const writeCore = (core: SessionCore): void => {
    db.prepare(
      `INSERT INTO coordinator_sessions (coordinator_session_id, schema_version, session_state, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(coordinator_session_id) DO UPDATE SET
         schema_version = excluded.schema_version,
         session_state = excluded.session_state,
         updated_at = excluded.updated_at`,
    ).run(
      core.coordinatorSessionId,
      core.schemaVersion,
      JSON.stringify(core),
      clock(),
    );
  };

  function loadNativeWindowOwner(coordinatorSessionId: CoordinatorSessionId): NativeCompactedWindowOwner | null {
    const row = db
      .prepare('SELECT owner_ref, items FROM native_window_owners WHERE coordinator_session_id = ?')
      .get(coordinatorSessionId) as { readonly owner_ref: string; readonly items: string } | undefined;
    if (row === undefined) {
      return null;
    }
    try {
      const items: unknown = JSON.parse(row.items);
      if (!Array.isArray(items)) {
        throw new Error('native_window_owners.items 不是数组');
      }
      return {
        ownerRef: row.owner_ref,
        items: items as NativeCompactedWindowOwner['items'],
      };
    } catch (error) {
      throw new Error(`原生压缩项不可恢复：${describeError(error)}`, { cause: error });
    }
  }

  function loadPortableCapsule(coordinatorSessionId: CoordinatorSessionId): PortableContextCapsule | null {
    const row = db
      .prepare(
        `SELECT capsule_id, replaced_from_step_id, replaced_to_step_id, text
         FROM portable_capsules WHERE coordinator_session_id = ?`,
      )
      .get(coordinatorSessionId) as
      | {
          readonly capsule_id: string;
          readonly replaced_from_step_id: string;
          readonly replaced_to_step_id: string;
          readonly text: string;
        }
      | undefined;
    if (row === undefined) {
      return null;
    }
    return {
      kind: 'derived_context_capsule',
      capsuleId: row.capsule_id,
      replacedFromStepId: row.replaced_from_step_id,
      replacedToStepId: row.replaced_to_step_id,
      text: row.text,
    };
  }

  /** 合成会话状态：核心记录 + 两个独立产物表。任一产物缺失都只是它自己为空。 */
  function composeState(core: SessionCore): unknown {
    const nativeWindowOwner = loadNativeWindowOwner(core.coordinatorSessionId);
    const capsule = loadPortableCapsule(core.coordinatorSessionId);
    if (nativeWindowOwner === null && capsule === null) {
      return core;
    }
    return { ...core, contextMaterial: { nativeWindowOwner, capsule } };
  }

  function loadCheckpoint(coordinatorSessionId: CoordinatorSessionId): CheckpointRecoveryRead {
    let row: { readonly session_state: string } | undefined;
    try {
      row = readCoreRow(coordinatorSessionId);
    } catch (error) {
      return { kind: 'unrecoverable', reason: describeError(error) };
    }
    if (row === undefined) {
      return { kind: 'absent' };
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(row.session_state);
    } catch (error) {
      return { kind: 'unrecoverable', reason: `session_state 不是合法 JSON：${describeError(error)}` };
    }
    if (!isRecord(parsedJson)) {
      return { kind: 'unrecoverable', reason: 'session_state 不是对象' };
    }
    let composed: unknown;
    try {
      composed = composeState(parsedJson as unknown as SessionCore);
    } catch (error) {
      return { kind: 'unrecoverable', reason: describeError(error) };
    }
    const parsed = parseCoordinatorSessionState(composed);
    if (!parsed.ok) {
      return { kind: 'unrecoverable', reason: `${parsed.field}: ${parsed.message}` };
    }
    return { kind: 'recovered', state: parsed.value };
  }

  function saveCore(next: CoordinatorSessionState): CheckpointWriteResult {
    const parsed = parseCoordinatorSessionState(next);
    if (!parsed.ok) {
      return { kind: 'failed', message: `${parsed.field}: ${parsed.message}` };
    }
    try {
      writeCore(coreOf(parsed.value));
      return { kind: 'saved' };
    } catch (error) {
      return { kind: 'failed', message: describeError(error) };
    }
  }

  /** 产物写入前先合成一次完整状态做校验，确保任一方都不会写坏另一方。 */
  function saveArtifact(
    coordinatorSessionId: CoordinatorSessionId,
    patch: {
      readonly nativeWindowOwner?: NativeCompactedWindowOwner;
      readonly capsule?: PortableContextCapsule;
    },
    write: () => void,
  ): CheckpointWriteResult {
    const current = loadCheckpoint(coordinatorSessionId);
    if (current.kind !== 'recovered') {
      return {
        kind: 'failed',
        message:
          current.kind === 'absent'
            ? '该 Session 还没有会话记录，必须先写入 checkpoint'
            : `现有会话记录不可恢复：${current.reason}`,
      };
    }
    const owner =
      patch.nativeWindowOwner ?? current.state.contextMaterial?.nativeWindowOwner ?? null;
    const capsule = patch.capsule ?? current.state.contextMaterial?.capsule ?? null;
    const candidate: CoordinatorSessionState =
      owner === null && capsule === null
        ? current.state
        : { ...current.state, contextMaterial: { nativeWindowOwner: owner, capsule } };
    const parsed = parseCoordinatorSessionState(candidate);
    if (!parsed.ok) {
      return { kind: 'failed', message: `${parsed.field}: ${parsed.message}` };
    }
    try {
      write();
      return { kind: 'saved' };
    } catch (error) {
      return { kind: 'failed', message: describeError(error) };
    }
  }

  const store: CheckpointStore = {
    checkpointer: saver,
    loadCheckpoint,
    saveCheckpoint: saveCore,
    readCommittedMessages(coordinatorSessionId, range) {
      const read = loadCheckpoint(coordinatorSessionId);
      if (read.kind !== 'recovered') {
        return [];
      }
      if (range === undefined) {
        return read.state.committedMessages;
      }
      const index = stepIndexById(read.state.committedModelSteps);
      const from = index.get(range.replacedFromStepId);
      const to = index.get(range.replacedToStepId);
      if (from === undefined || to === undefined || from > to) {
        return [];
      }
      return read.state.committedModelSteps
        .slice(from, to + 1)
        .flatMap((step) => step.messages);
    },
    loadNativeWindowOwner,
    saveNativeWindowOwner(coordinatorSessionId, owner) {
      return saveArtifact(
        coordinatorSessionId,
        { nativeWindowOwner: owner },
        () => {
          db.prepare(
            `INSERT INTO native_window_owners (coordinator_session_id, owner_ref, items, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(coordinator_session_id) DO UPDATE SET
               owner_ref = excluded.owner_ref, items = excluded.items, updated_at = excluded.updated_at`,
          ).run(coordinatorSessionId, owner.ownerRef, JSON.stringify(owner.items), clock());
        },
      );
    },
    loadPortableCapsule,
    savePortableCapsule(coordinatorSessionId, capsule) {
      return saveArtifact(
        coordinatorSessionId,
        { capsule },
        () => {
          db.prepare(
            `INSERT INTO portable_capsules (
               coordinator_session_id, capsule_id, replaced_from_step_id, replaced_to_step_id, text, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(coordinator_session_id) DO UPDATE SET
               capsule_id = excluded.capsule_id,
               replaced_from_step_id = excluded.replaced_from_step_id,
               replaced_to_step_id = excluded.replaced_to_step_id,
               text = excluded.text,
               updated_at = excluded.updated_at`,
          ).run(
            coordinatorSessionId,
            capsule.capsuleId,
            capsule.replacedFromStepId,
            capsule.replacedToStepId,
            capsule.text,
            clock(),
          );
        },
      );
    },
    clearNativeWindowOwner(coordinatorSessionId) {
      try {
        // 只删原生窗口一侧：Capsule 是自己的表，不受影响。
        db.prepare('DELETE FROM native_window_owners WHERE coordinator_session_id = ?').run(
          coordinatorSessionId,
        );
        return { kind: 'saved' };
      } catch (error) {
        return { kind: 'failed', message: describeError(error) };
      }
    },
    commitWakeBatch(batch) {
      const sessionId = batch.coordinatorSessionId as CoordinatorSessionId;
      const current = loadCheckpoint(sessionId);
      let core: SessionCore;
      if (current.kind === 'unrecoverable') {
        return { kind: 'unrecoverable', reason: current.reason };
      }
      if (current.kind === 'absent') {
        core = {
          schemaVersion: COORDINATOR_SESSION_STATE_SCHEMA_VERSION,
          coordinatorSessionId: sessionId,
          committedMessages: [],
          graphPosition: 'suspend',
          committedModelSteps: [],
          wakeBatches: [],
        };
      } else {
        core = coreOf(current.state);
        if (core.wakeBatches.some((existing) => existing.wakeBatchId === batch.wakeBatchId)) {
          return { kind: 'already-committed', state: current.state };
        }
      }
      const next: CoordinatorSessionState = { ...core, wakeBatches: [...core.wakeBatches, batch] };
      const parsed = parseCoordinatorSessionState(next);
      if (!parsed.ok) {
        return { kind: 'unrecoverable', reason: `${parsed.field}: ${parsed.message}` };
      }
      const written = saveCore(parsed.value);
      if (written.kind === 'failed') {
        return { kind: 'unrecoverable', reason: written.message };
      }
      const reloaded = loadCheckpoint(sessionId);
      if (reloaded.kind !== 'recovered') {
        return { kind: 'unrecoverable', reason: 'Wake Batch 写入后无法读回会话状态' };
      }
      return { kind: 'committed', state: reloaded.state };
    },
    close() {
      db.close();
    },
  };
  return { kind: 'opened', store };
}
