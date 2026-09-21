/**
 * IC-03：`coordination.sqlite` 的 schema 版本与可重入 migration
 * （Owner: `m1-persist-coordination-state`）。
 *
 * 每个 migration 在单事务内完成且可重入（`IF NOT EXISTS`），后继 change 只追加新的
 * `version` 段落，不改写已发布的段落。打开时版本高于当前实现即拒绝启动并说明原因，
 * 低于当前实现时按顺序升级；没有版本位的库无法安全演进。
 */

import type { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 7;

export const SCHEMA_VERSION_KEY = 'schema_version';

/**
 * M1 持久化基线的最小表集。
 *
 * 刻意不包含会话消息、图位置或任何外部事实的镜像：那些事实属于 checkpointer、Orca 或 tracker，
 * 复制进本库只会产生第二份真值。`wake_admissions` 只记录「哪些 source revision 已经随哪个
 * WakeBatchId 准入过」，不保存批内容——内容留在 checkpoint 里。
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
  'wake_admissions',
  'graph_versions',
  'execution_authorizations',
  'planning_handoffs',
  'planning_responsibility',
  'session_segments',
  'materialization_bindings',
  'delivery_settlements',
  'delivery_verdicts',
  'recoveries',
  'execution_handoffs',
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

/**
 * M2：Wake Batch 的 source admission。
 *
 * 唯一键是 Scope + Session + WakeBatchId，因此同一 batch 无论重放多少次都只有一条记录。
 * 值只含 source revision 引用与 admission 状态：Wake Batch 的内容与已提交历史留在 checkpoint，
 * 本库不保留副本。两个库之间没有跨库事务，所以这个表存在的意义是让恢复路径能按稳定 batch ID
 * 判断「这份 Actionable Work 是否已经注入过」。
 */
const MIGRATION_2: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS wake_admissions (
     coordination_scope_id TEXT NOT NULL,
     coordinator_session_id TEXT NOT NULL,
     wake_batch_id TEXT NOT NULL,
     admission_state TEXT NOT NULL,
     source_revisions TEXT NOT NULL,
     admitted_at INTEGER NOT NULL,
     PRIMARY KEY (coordination_scope_id, coordinator_session_id, wake_batch_id)
   ) STRICT`,
];

/**
 * M3：Execution Graph 追加历史、版本化 Execution Authorization 与 Route Planning 交接记录。
 *
 * 图体只存在于 `graph_versions` 的追加记录里：`graph_id` 与 `graph_generation` 是索引列，与 JSON
 * 负载中的同名字段在写入时校验一致，因此「当前图」永远是某一条确切 GraphVersion，而不是一个可被
 * 就地改写的引用。授权记录只保存 Manifest 正文、版本与指纹，不保存批准过程的对话。
 *
 * `planning_handoffs` 上的部分唯一索引让一个 Scope 同时最多存在一个未终结提案；`planning_responsibility`
 * 每 Scope 至多一行，因此不可能出现两个规划责任方。
 */
const MIGRATION_3: readonly string[] = [
  // 地图 revision 是 Companion 自己的规划计数：tracker 只保存地图正文，本地记录「当前读到哪一版」，
  // 候选图与未决交接提案据此判定过期。默认 0 表示尚未写入过地图。
  `ALTER TABLE scope ADD COLUMN map_revision INTEGER NOT NULL DEFAULT 0`,
  `CREATE TABLE IF NOT EXISTS graph_versions (
     coordination_scope_id TEXT NOT NULL,
     graph_id TEXT NOT NULL,
     graph_version INTEGER NOT NULL,
     graph_generation INTEGER NOT NULL,
     record_kind TEXT NOT NULL,
     parent_version INTEGER,
     map_revision INTEGER NOT NULL,
     plan_revision INTEGER NOT NULL,
     orca_run_id TEXT NOT NULL,
     graph_json TEXT NOT NULL,
     recorded_at INTEGER NOT NULL,
     PRIMARY KEY (coordination_scope_id, graph_id, graph_version)
   ) STRICT`,
  `CREATE INDEX IF NOT EXISTS graph_versions_head
     ON graph_versions (coordination_scope_id, graph_id, graph_version DESC)`,
  `CREATE TABLE IF NOT EXISTS execution_authorizations (
     coordination_scope_id TEXT NOT NULL,
     authorization_id TEXT NOT NULL,
     authorization_version INTEGER NOT NULL,
     manifest_version INTEGER NOT NULL,
     fingerprint TEXT NOT NULL,
     approval_ref TEXT NOT NULL,
     manifest_json TEXT NOT NULL,
     approved_at INTEGER NOT NULL,
     PRIMARY KEY (coordination_scope_id, authorization_id)
   ) STRICT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS execution_authorizations_version
     ON execution_authorizations (coordination_scope_id, authorization_version)`,
  `CREATE TABLE IF NOT EXISTS planning_handoffs (
     coordination_scope_id TEXT NOT NULL,
     proposal_id TEXT NOT NULL,
     source_coordinator_session_id TEXT NOT NULL,
     target_coordinator_session_id TEXT NOT NULL,
     phase TEXT NOT NULL,
     map_revision INTEGER NOT NULL,
     plan_revision INTEGER NOT NULL,
     graph_id TEXT,
     graph_version INTEGER,
     capsule_ref TEXT,
     proposal_revision INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (coordination_scope_id, proposal_id)
   ) STRICT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS planning_handoffs_single_open
     ON planning_handoffs (coordination_scope_id)
     WHERE phase IN ('prepared', 'reviewed')`,
  `CREATE TABLE IF NOT EXISTS planning_responsibility (
     coordination_scope_id TEXT PRIMARY KEY,
     coordinator_session_id TEXT NOT NULL,
     source_proposal_id TEXT,
     assigned_at INTEGER NOT NULL
   ) STRICT`,
];

/**
 * M4：会话中断的 Session Segment 前置事实与最小物化绑定。
 *
 * `session_segments` 只记录中断时能核验的事实：角色、Task、Dispatch、Attempt、Session Binding、
 * 最后可引用的 transcript 位置与终态收据引用。它刻意不含 Recovery Budget 计数、Capsule 或替代
 * Session——那些属于恢复 change，记录在这里只会制造第二份状态。
 *
 * `materialization_bindings` 只保存 `WorkPackageId → OrcaTaskId` 与创建它的 OperationId；worktree
 * 路径与 Orca Task 状态都属于外部权威，复制进来就会变成第二份真值。
 */
const MIGRATION_4: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS session_segments (
     coordination_scope_id TEXT NOT NULL,
     segment_id TEXT NOT NULL,
     work_package_id TEXT NOT NULL,
     role TEXT NOT NULL,
     worker_task_id TEXT NOT NULL,
     dispatch_id TEXT NOT NULL,
     attempt_id TEXT NOT NULL,
     session_binding_id TEXT NOT NULL,
     last_transcript_ref TEXT,
     terminal_receipt_ref TEXT,
     transcript_referenceable INTEGER NOT NULL,
     verifiable INTEGER NOT NULL,
     recorded_at INTEGER NOT NULL,
     PRIMARY KEY (coordination_scope_id, segment_id)
   ) STRICT`,
  `CREATE INDEX IF NOT EXISTS session_segments_dispatch
     ON session_segments (coordination_scope_id, dispatch_id)`,
  `CREATE TABLE IF NOT EXISTS materialization_bindings (
     coordination_scope_id TEXT NOT NULL,
     work_package_id TEXT NOT NULL,
     orca_task_id TEXT NOT NULL,
     creation_operation_id TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (coordination_scope_id, work_package_id)
   ) STRICT`,
];

/**
 * M5：Delivery 结算去重事实与分支级 Delivery Verdict。
 *
 * `delivery_settlements` 一行同时表达三件事：稳定去重键（主键）、被接受的
 * `AcceptedWorkerResultRef`（Orca 结果引用与角色、契约 revision、接受时间），以及该 Delivery 的
 * 归属。它刻意**不**保存结果正文——正文只归 Orca，本地留副本就会产生第二份真值。第二个唯一索引
 * 让同一个 Delivery 身份只能被结算一次，因此重放不会写出第二行，也不会产生第二份结果。
 *
 * `delivery_verdicts` 只追加分支级结论记录：结论类型（`deliverable` / `blocked`）、引用集合、
 * Finalizer 角色与会话引用。它不修改 Execution Graph、Accepted Worker Result、Git 历史或
 * Operation Intent，`verdict_sequence` 让「最新结论」有确定的读取顺序。
 */
const MIGRATION_5: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS delivery_settlements (
     coordination_scope_id TEXT NOT NULL,
     dedupe_key TEXT NOT NULL,
     delivery_id TEXT NOT NULL,
     run_id TEXT NOT NULL,
     consumer_generation INTEGER NOT NULL,
     worker_task_id TEXT NOT NULL,
     dispatch_id TEXT NOT NULL,
     attempt_id TEXT NOT NULL,
     role TEXT NOT NULL,
     contract_revision INTEGER NOT NULL,
     orca_result_ref TEXT NOT NULL,
     accepted_at INTEGER NOT NULL,
     PRIMARY KEY (coordination_scope_id, dedupe_key)
   ) STRICT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS delivery_settlements_delivery_identity
     ON delivery_settlements (
       coordination_scope_id, delivery_id, run_id, consumer_generation, worker_task_id, dispatch_id, attempt_id
     )`,
  `CREATE TABLE IF NOT EXISTS delivery_verdicts (
     coordination_scope_id TEXT NOT NULL,
     verdict_id TEXT NOT NULL,
     verdict_sequence INTEGER NOT NULL,
     verdict_kind TEXT NOT NULL,
     verdict_refs TEXT NOT NULL,
     finalizer_role TEXT NOT NULL,
     session_binding_ref TEXT NOT NULL,
     recorded_at INTEGER NOT NULL,
     PRIMARY KEY (coordination_scope_id, verdict_id)
   ) STRICT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS delivery_verdicts_sequence
     ON delivery_verdicts (coordination_scope_id, verdict_sequence)`,
];

/** M6：Integration Operation 的 Git HEAD 前置条件。 */
const MIGRATION_6: readonly string[] = [
  `ALTER TABLE operation_intents ADD COLUMN expected_head TEXT`,
];

/**
 * M7：Worker Session Recovery 与 Execution Handoff。
 *
 * `recoveries` 只保存无法从 Orca、Git 或 transcript 重建的恢复事实：这次 Recovery 针对哪条中断
 * Segment、替代派发与替代 Segment 是谁、消耗了多少 Recovery Budget。它不保存 Capsule 正文、
 * transcript 内容或 Session 消息，`capsule_ref` 只是引用。
 *
 * 两个索引各对应一条不变式：
 * - `(coordination_scope_id, source_segment_id)` 唯一：一条中断 Segment 只允许一个 Recovery，
 *   RecoveryId 的稳定性由此由来源事实保证，重复写入不会产生第二行；
 * - `(coordination_scope_id, business_attempt_id)`：按 Worker Attempt 求和已消耗额度，重启、恢复、
 *   Patch 与重规划都只是新增行，不重置既有计数。
 *
 * `execution_handoffs` 保存执行责任转移的阶段与提案级 CAS。`handoff_revision` 独立于 Scope
 * revision，避免交接提交强迫 Scope 全局串行；部分唯一索引让一个 Scope 同时至多存在一个未终结
 * 交接，因此不可能出现两个责任方。Run、Task、Dispatch、Attempt、Worker、worktree、图与授权身份
 * 都不在这里——本表不复制它们。
 */
const MIGRATION_7: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS recoveries (
     coordination_scope_id TEXT NOT NULL,
     recovery_id TEXT NOT NULL,
     role TEXT NOT NULL,
     work_package_id TEXT NOT NULL,
     worker_task_id TEXT NOT NULL,
     business_attempt_id TEXT NOT NULL,
     source_segment_id TEXT NOT NULL,
     source_dispatch_id TEXT NOT NULL,
     replacement_dispatch_id TEXT,
     replacement_segment_id TEXT,
     replacement_session_binding_id TEXT,
     superseded_segment_id TEXT,
     status TEXT NOT NULL,
     consumed_budget INTEGER NOT NULL,
     capsule_ref TEXT,
     prewrite_operation_id TEXT,
     terminal_outcome TEXT,
     blocking_reason TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (coordination_scope_id, recovery_id)
   ) STRICT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS recoveries_source_segment
     ON recoveries (coordination_scope_id, source_segment_id)`,
  `CREATE INDEX IF NOT EXISTS recoveries_worker_attempt
     ON recoveries (coordination_scope_id, business_attempt_id)`,
  `CREATE TABLE IF NOT EXISTS execution_handoffs (
     coordination_scope_id TEXT NOT NULL,
     handoff_id TEXT NOT NULL,
     source_session_id TEXT NOT NULL,
     target_session_id TEXT NOT NULL,
     graph_generation INTEGER NOT NULL,
     responsibility_set TEXT NOT NULL,
     phase TEXT NOT NULL,
     expected_revision INTEGER NOT NULL,
     coordinator_context_capsule_ref TEXT,
     handoff_revision INTEGER NOT NULL,
     blocking_reason TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (coordination_scope_id, handoff_id)
   ) STRICT`,
  // 一个 Scope 同时至多一个未终结交接：Source 在 cutover 前始终是唯一 owner。
  `CREATE UNIQUE INDEX IF NOT EXISTS execution_handoffs_single_open
     ON execution_handoffs (coordination_scope_id)
     WHERE phase IN ('prepared', 'reviewed', 'blocked')`,
];

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, statements: MIGRATION_1 },
  { version: 2, statements: MIGRATION_2 },
  { version: 3, statements: MIGRATION_3 },
  { version: 4, statements: MIGRATION_4 },
  { version: 5, statements: MIGRATION_5 },
  { version: 6, statements: MIGRATION_6 },
  { version: 7, statements: MIGRATION_7 },
];

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
