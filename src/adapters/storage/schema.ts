/**
 * IC-03：`coordination.sqlite` 的 schema 版本与可重入 migration
 * （Owner: `m1-persist-coordination-state`）。
 *
 * 每个 migration 在单事务内完成且可重入（`IF NOT EXISTS`），后继 change 只追加新的
 * `version` 段落，不改写已发布的段落。打开时版本高于当前实现即拒绝启动并说明原因，
 * 低于当前实现时按顺序升级；没有版本位的库无法安全演进。
 */

import type { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 1;

export const SCHEMA_VERSION_KEY = 'schema_version';

/**
 * M1 持久化基线的最小表集。
 *
 * 刻意不包含会话消息、图位置或任何外部事实的镜像：那些事实属于 checkpointer、Orca 或 tracker，
 * 复制进本库只会产生第二份真值。
 */
export const COORDINATION_TABLES: readonly string[] = [
  'meta',
  'scope',
  'session_registry',
  'leases',
  'ticket_claims',
  'pending_interactions',
  'operation_intents',
  'budget_counters',
];

export type Migration = {
  readonly version: number;
  readonly statements: readonly string[];
};

const MIGRATION_1: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   ) STRICT`,
  `CREATE TABLE IF NOT EXISTS scope (
     coordination_scope_id TEXT PRIMARY KEY,
     mode TEXT NOT NULL,
     control_state TEXT NOT NULL,
     planning_cycle_id TEXT,
     graph_id TEXT,
     graph_version INTEGER,
     authorization_id TEXT,
     authorization_version INTEGER,
     revision INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   ) STRICT`,
  `CREATE TABLE IF NOT EXISTS session_registry (
     coordination_scope_id TEXT NOT NULL,
     coordinator_session_id TEXT NOT NULL,
     coordinator_model_configuration_ref TEXT NOT NULL,
     lifecycle_state TEXT NOT NULL,
     registered_at INTEGER NOT NULL,
     PRIMARY KEY (coordination_scope_id, coordinator_session_id)
   ) STRICT`,
  // 同一个 Session 只能属于一个 Coordination Scope：跨 Scope 注册在这里失败。
  `CREATE UNIQUE INDEX IF NOT EXISTS session_registry_session_unique
     ON session_registry (coordinator_session_id)`,
  `CREATE TABLE IF NOT EXISTS leases (
     coordination_scope_id TEXT NOT NULL,
     lease_kind TEXT NOT NULL,
     coordinator_session_id TEXT NOT NULL,
     runtime_incarnation_id TEXT NOT NULL,
     fencing_generation INTEGER NOT NULL,
     acquired_at INTEGER NOT NULL,
     expires_at INTEGER,
     released_at INTEGER,
     PRIMARY KEY (coordination_scope_id, lease_kind, coordinator_session_id)
   ) STRICT`,
  // 不变式一：一个 Scope 同时只有一个未释放的 Execution Coordination Lease。
  `CREATE UNIQUE INDEX IF NOT EXISTS leases_single_execution_lease
     ON leases (coordination_scope_id)
     WHERE lease_kind = 'execution_coordination' AND released_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS ticket_claims (
     claim_id INTEGER PRIMARY KEY,
     coordination_scope_id TEXT NOT NULL,
     ticket_kind TEXT NOT NULL,
     ticket_id TEXT NOT NULL,
     coordinator_session_id TEXT NOT NULL,
     state TEXT NOT NULL,
     claimed_at INTEGER NOT NULL
   ) STRICT`,
  // 不变式二：同一 ticket 同时只有一个活跃 claim；释放/完成后可以再次申领。
  `CREATE UNIQUE INDEX IF NOT EXISTS ticket_claims_single_active
     ON ticket_claims (coordination_scope_id, ticket_kind, ticket_id)
     WHERE state = 'active'`,
  `CREATE TABLE IF NOT EXISTS pending_interactions (
     coordination_scope_id TEXT NOT NULL,
     interaction_id TEXT NOT NULL,
     owner_coordinator_session_id TEXT NOT NULL,
     subject_kind TEXT NOT NULL,
     subject_id TEXT NOT NULL,
     expected_revision INTEGER NOT NULL,
     state TEXT NOT NULL,
     answer_kind TEXT,
     answer_id TEXT,
     created_at INTEGER NOT NULL,
     resolved_at INTEGER,
     PRIMARY KEY (coordination_scope_id, interaction_id)
   ) STRICT`,
  `CREATE TABLE IF NOT EXISTS operation_intents (
     coordination_scope_id TEXT NOT NULL,
     operation_id TEXT NOT NULL,
     target_kind TEXT NOT NULL,
     target_id TEXT NOT NULL,
     operation_category TEXT NOT NULL,
     lane_key TEXT NOT NULL,
     initiated_by_session_id TEXT NOT NULL,
     initiated_by_incarnation_id TEXT NOT NULL,
     expected_revision INTEGER NOT NULL,
     state TEXT NOT NULL,
     outcome_class TEXT,
     backend_request_id TEXT,
     blocking_reason TEXT,
     created_at INTEGER NOT NULL,
     settled_at INTEGER,
     PRIMARY KEY (coordination_scope_id, operation_id)
   ) STRICT`,
  `CREATE INDEX IF NOT EXISTS operation_intents_lane
     ON operation_intents (coordination_scope_id, lane_key, state)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS operation_intents_single_unresolved_lane
     ON operation_intents (coordination_scope_id, lane_key)
     WHERE state IN ('pending', 'blocked')`,
  `CREATE TABLE IF NOT EXISTS budget_counters (
     coordination_scope_id TEXT NOT NULL,
     budget_key TEXT NOT NULL,
     approved_limit_ref TEXT NOT NULL,
     consumed INTEGER NOT NULL,
     PRIMARY KEY (coordination_scope_id, budget_key)
   ) STRICT`,
];

export const MIGRATIONS: readonly Migration[] = [{ version: 1, statements: MIGRATION_1 }];

export function readSchemaVersion(db: DatabaseSync): number | null {
  const exists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'`)
    .get() as { readonly name: string } | undefined;
  if (exists === undefined) {
    return null;
  }
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(SCHEMA_VERSION_KEY) as
    | { readonly value: string }
    | undefined;
  if (row === undefined) {
    return null;
  }
  const parsed = Number.parseInt(row.value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export type MigrationResult =
  | { readonly kind: 'migrated'; readonly version: number }
  | { readonly kind: 'unsupported'; readonly version: number }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * 把库升级到 `SCHEMA_VERSION`。低于实现版本时按顺序执行；高于实现版本时拒绝启动，
 * 因为旧代码无法理解新记录，猜测只会写坏状态。
 */
export function migrate(db: DatabaseSync): MigrationResult {
  let current: number;
  try {
    current = readSchemaVersion(db) ?? 0;
  } catch (error) {
    return { kind: 'failed', message: describeError(error) };
  }
  if (current > SCHEMA_VERSION) {
    return { kind: 'unsupported', version: current };
  }
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) {
      continue;
    }
    try {
      db.exec('BEGIN IMMEDIATE');
      for (const statement of migration.statements) {
        db.exec(statement);
      }
      db.prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(SCHEMA_VERSION_KEY, String(migration.version));
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // 事务已不可用；错误信息以原始失败为准。
      }
      return { kind: 'failed', message: describeError(error) };
    }
    current = migration.version;
  }
  return { kind: 'migrated', version: current };
}

/** 只用于诊断：不复制外部系统的错误码词表，只保留消息与可选的 SQLite 结果码。 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { readonly errcode?: unknown }).errcode;
    return typeof code === 'number' ? `${error.message} (sqlite ${code})` : error.message;
  }
  return String(error);
}
