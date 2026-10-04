/**
 * IC-03：`coordination.sqlite` 的 schema 版本与可重入 migration
 * （Owner: `m1-persist-coordination-state`）。
 *
 * 每个 migration 在单事务内完成且可重入（`IF NOT EXISTS`），后继 change 只追加新的
 * `version` 段落，不改写已发布的段落。打开时版本高于当前实现即拒绝启动并说明原因，
 * 低于当前实现时按顺序升级；没有版本位的库无法安全演进。
 */

import type { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 17;

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
  'graph_generations',
  'revision_holds',
  'baseline_reconciliations',
  'work_package_lineages',
  'baseline_adoptions',
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
 * `materialization_bindings` 在 M4 只保存 `WorkPackageId → OrcaTaskId` 与创建它的 OperationId；
 * schema 11 把这一个指针换成按角色/Attempt 的派发身份历史（见 `MIGRATION_11`）。
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

/**
 * M8：图演进、重规划与代际引用。
 *
 * `graph_versions` 增加补丁元数据：`patch_id` 是提交幂等键（同一 GraphId 内唯一），`patch_json` 记录
 * 这次补丁做了什么（新增/重定义/退休、后代处置与接管关系）。图体本身仍只有这一个追加历史，因此
 * 「当前图」依然不可能被就地改写。
 *
 * 其余四张表各自只保存无法从 Git、Orca 或既有图历史重建的共享事实：
 * - `graph_generations` 保存代际身份与状态（candidate/active/suspended/frozen）以及它绑定的一生
 *   Planning Cycle 与 Orca Run；代际之间的切换点是 Cutover，不是逐项迁移；
 * - `revision_holds` 保存 revision pending 的调度持有，每个 Work Package 至多一行；
 * - `baseline_reconciliations` 保存独立 Planner-profile 基线核验任务的结论；
 * - `work_package_lineages` 保存新责任对旧责任的显式延续与继承额度；
 * - `baseline_adoptions` 保存旧成果按三条规则之一的采用记录（含矛盾事实的阻塞结论）。
 */
const MIGRATION_8: readonly string[] = [
  `ALTER TABLE graph_versions ADD COLUMN patch_id TEXT`,
  `ALTER TABLE graph_versions ADD COLUMN patch_json TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS graph_versions_patch_unique
     ON graph_versions (coordination_scope_id, graph_id, patch_id)
     WHERE patch_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS graph_generations (
     coordination_scope_id TEXT NOT NULL,
     graph_id TEXT NOT NULL,
     graph_generation INTEGER NOT NULL,
     planning_cycle_id TEXT NOT NULL,
     orca_run_id TEXT NOT NULL,
     predecessor_graph_id TEXT,
     baseline_head TEXT NOT NULL,
     status TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (coordination_scope_id, graph_id)
   ) STRICT`,
  `CREATE INDEX IF NOT EXISTS graph_generations_status
     ON graph_generations (coordination_scope_id, status)`,
  `CREATE TABLE IF NOT EXISTS revision_holds (
     coordination_scope_id TEXT NOT NULL,
     work_package_id TEXT NOT NULL,
     source TEXT NOT NULL,
     source_ref TEXT NOT NULL,
     state TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     released_at INTEGER,
     release_reason TEXT,
     PRIMARY KEY (coordination_scope_id, work_package_id)
   ) STRICT`,
  `CREATE TABLE IF NOT EXISTS baseline_reconciliations (
     coordination_scope_id TEXT NOT NULL,
     reconciliation_id TEXT NOT NULL,
     work_package_id TEXT NOT NULL,
     role TEXT NOT NULL,
     required_baseline_head TEXT NOT NULL,
     observed_head TEXT,
     ancestry_verified INTEGER NOT NULL,
     target_head_verified INTEGER NOT NULL,
     dirty_paths_reconciled INTEGER NOT NULL,
     scope_reconciled INTEGER NOT NULL,
     state TEXT NOT NULL,
     blocker_ref TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (coordination_scope_id, reconciliation_id)
   ) STRICT`,
  // 同一个 Work Package 同时至多一个未收尾的核验需求。
  `CREATE UNIQUE INDEX IF NOT EXISTS baseline_reconciliations_single_open
     ON baseline_reconciliations (coordination_scope_id, work_package_id)
     WHERE state = 'required'`,
  `CREATE TABLE IF NOT EXISTS work_package_lineages (
     coordination_scope_id TEXT NOT NULL,
     work_package_id TEXT NOT NULL,
     prior_work_package_id TEXT NOT NULL,
     prior_graph_id TEXT NOT NULL,
     inherited_json TEXT NOT NULL,
     recorded_at INTEGER NOT NULL,
     PRIMARY KEY (coordination_scope_id, work_package_id)
   ) STRICT`,
  `CREATE TABLE IF NOT EXISTS baseline_adoptions (
     coordination_scope_id TEXT NOT NULL,
     adoption_id TEXT NOT NULL,
     work_package_id TEXT NOT NULL,
     adoption_kind TEXT NOT NULL,
     adopted_result_ref TEXT NOT NULL,
     baseline_head TEXT NOT NULL,
     integration_ref TEXT,
     evidence_refs TEXT NOT NULL,
     state TEXT NOT NULL,
     blocking_reason TEXT,
     recorded_at INTEGER NOT NULL,
     PRIMARY KEY (coordination_scope_id, adoption_id)
   ) STRICT`,
];

const MIGRATION_9: readonly string[] = [
  `ALTER TABLE baseline_reconciliations ADD COLUMN orca_task_id TEXT`,
  `ALTER TABLE baseline_reconciliations ADD COLUMN dispatch_id TEXT`,
];

/**
 * M10：Scope 注册绑定与交互回答正文。
 *
 * 两列都只保存无法从 Git 重建的事实：完整 branch ref 与 canonical worktree 是**用户登记**的身份，
 * Git 仍然提供实时 HEAD 与 worktree 路径，注册绑定不是它的镜像。旧行保持 `NULL`——迁移不猜测旧值，
 * 补齐只允许经一次受控 CAS 命令。
 *
 * `pending_interactions.answer_text` 让受控回答正文与解决状态落在同一 CAS 事务里：正文属于本次回答
 * 这个已提交事实，拆到别处就会产生「已解决但没有正文」的中间态。普通 Session 消息不经这一列。
 */
const MIGRATION_10: readonly string[] = [
  `ALTER TABLE scope ADD COLUMN full_branch_ref TEXT`,
  `ALTER TABLE scope ADD COLUMN canonical_worktree_path TEXT`,
  // 同一个 common dir 内一个 branch ref 至多属于一个 Scope：否则恢复时会接错协调状态。
  `CREATE UNIQUE INDEX IF NOT EXISTS scope_branch_ref_unique
    ON scope (full_branch_ref)
    WHERE full_branch_ref IS NOT NULL`,
  `ALTER TABLE pending_interactions ADD COLUMN answer_text TEXT`,
];

/**
 * M11：物化绑定由「Work Package 当前指针」改为按角色/Attempt 的派发身份历史。
 *
 * M4 的主键是 `(scope, work_package)`，因此一个 Work Package 只能有一行：换角色、重试或 Graph Patch
 * 都会覆盖上一次派发的身份，结算时再也无法重建「这条 Delivery 属于哪次角色派发」。新主键是
 * `(scope, work_package, creation_operation_id)`——创建 Task 的那次 OperationId 天然唯一——并加
 * `(scope, work_package, role, attempt_id)` 唯一约束阻止同一角色同一 Attempt 被派发两次。
 *
 * 旧行不迁移身份，只保留：M4 的行没有任何可以证明角色或 Attempt 的事实，猜测角色会把历史 Delivery
 * 接到错误的派发上。旧行的身份列一律为 `NULL`，读取方按 `identity = 'legacy'` 显式阻塞。SQLite 不
 * 支持放宽主键的 ALTER，因此这里在单事务内重建表并按列名搬移数据；迁移在既有事务包装内执行。
 */
const MIGRATION_11: readonly string[] = [
  `ALTER TABLE materialization_bindings RENAME TO materialization_bindings_v10`,
  `CREATE TABLE materialization_bindings (
     coordination_scope_id TEXT NOT NULL,
     work_package_id TEXT NOT NULL,
     creation_operation_id TEXT NOT NULL,
     role TEXT,
     worker_task_id TEXT,
     dispatch_id TEXT,
     attempt_id TEXT,
     worktree_id TEXT,
     spec_binding_json TEXT,
     specification_unit_path TEXT,
     orca_task_id TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (coordination_scope_id, work_package_id, creation_operation_id)
   ) STRICT`,
  `INSERT INTO materialization_bindings (
     coordination_scope_id, work_package_id, creation_operation_id, role, worker_task_id, dispatch_id,
     attempt_id, worktree_id, spec_binding_json, specification_unit_path, orca_task_id, created_at
   )
   SELECT coordination_scope_id, work_package_id, creation_operation_id, NULL, NULL, NULL,
          NULL, NULL, NULL, NULL, orca_task_id, created_at
   FROM materialization_bindings_v10`,
  `DROP TABLE materialization_bindings_v10`,
  // 同一角色同一 Attempt 至多一行：重复派发在约束处失败，而不是覆盖既有身份。
  `CREATE UNIQUE INDEX IF NOT EXISTS materialization_bindings_role_attempt
     ON materialization_bindings (coordination_scope_id, work_package_id, role, attempt_id)
     WHERE role IS NOT NULL AND attempt_id IS NOT NULL`,
];

/**
 * M12：物化绑定记录这次派发使用的 Worker launch 身份。
 *
 * 「已派发但未绑定」的角色要在后续触发里补记 Session Segment（派发窗口内没读到 Codex SessionStart
 * 报告时，否则这条派发的 Delivery 永远无法归因）。补记必须用**同一个** launch 身份去定位报告文件，
 * 而 launchId 由 Scope/图/角色/contract revision/Attempt 派生：重建它需要复刻派生编码，等于把内部
 * 编码变成契约。这里直接把派发时已知的 launchId 记成事实，补记只读事实，不猜。
 *
 * 旧行没有这项事实，一律为 `NULL`：读取方在需要补记时按「不可补记」阻塞，不回头重建。
 */
const MIGRATION_12: readonly string[] = [
  `ALTER TABLE materialization_bindings ADD COLUMN launch_id TEXT`,
];

/**
 * M13：修订持有的内容版本边界。
 *
 * 在途 Graph Patch 修订要回答两个此前没有持久事实的问题：被替换掉的契约内容版本是哪一个，以及重新
 * 准入后接纳的是哪一个。少了前者的记录，「替换是否真的改变了内容」无法判定，只能拿时间戳猜；少了
 * 后者的记录，修订完成前与完成后的角色结果无法区分——旧 Validator 的通过会被读成新修订已完成。
 *
 * 两列都可为空：旧行（含已 released 的历史持有）没有版本边界，沿原投影规则；重新登记新补丁持有时
 * 两列清空，直到准备阶段写下旧版本、准入结算写下接纳版本。
 */
const MIGRATION_13: readonly string[] = [
  `ALTER TABLE revision_holds ADD COLUMN prior_contract_revision INTEGER`,
  `ALTER TABLE revision_holds ADD COLUMN admitted_contract_revision INTEGER`,
];

/**
 * M16：物化绑定固定这次派发使用的模型授权。
 *
 * Worker 重新授权只影响新 Task；已经派发的 Task、它的 Retry 与同一 Validator 修复都必须沿用创建时
 * 的授权与 profile，否则「结算时读到的模型配置」与「实际运行过的配置」会分叉。三列因此在派发意图
 * 之前就写进绑定行，而不是在结算时去读当前授权。
 *
 * 旧行一律为 `NULL`，不推断回填：当时确实没有这项事实，猜一个授权等于伪造运行依据。读取方在缺少
 * 绑定时显式阻塞，调用方重新按当前授权派发。
 *
 * `utility_role` 是 Recovery Utility 派发的身份：它不属于领域四主角色，因此单列而不是塞进 `role`，
 * 否则 `WorkerRole` 的闭集会被一条辅助用途撑开。两列恰好一列为空——角色派发与 utility 派发互斥。
 */
const MIGRATION_16: readonly string[] = [
  `ALTER TABLE materialization_bindings ADD COLUMN authorization_id TEXT`,
  `ALTER TABLE materialization_bindings ADD COLUMN authorization_version INTEGER`,
  `ALTER TABLE materialization_bindings ADD COLUMN worker_profile_ref TEXT`,
  `ALTER TABLE materialization_bindings ADD COLUMN utility_role TEXT`,
  // 与角色派发同一条唯一性：同一 Work Package 的同一次 Utility Attempt 不得被派发两次。
  `CREATE UNIQUE INDEX IF NOT EXISTS materialization_bindings_utility_attempt
     ON materialization_bindings (coordination_scope_id, work_package_id, utility_role, attempt_id)
     WHERE utility_role IS NOT NULL AND attempt_id IS NOT NULL`,
];

/**
 * M17：初始图保留原编译计划。
 *
 * `graph_versions` 一直只保存编译**结果**（`graph_json`）和修订**增量**（`patch_json`）。计划正文
 * 此前只活在 Coordinator 会话与 tracker 上，于是「这张图当初依据哪份计划编译」在会话压缩、
 * tracker 改写或 Replanning Cutover 之后都不可回读——只剩一个孤立的 `plan_revision` 数字。历史图
 * 详情要按原样展示编译依据，就必须在 v1 追加的同一事务里留下那份归一化计划。
 *
 * 一列 nullable 而不是 NOT NULL：
 * - schema 17 之前的行当时确实没有这项事实，猜一份等于伪造依据。读取方按「依据缺失」显式呈现，
 *   不从当前 tracker 正文或编译结果反推。
 * - `accepted_revision` 永远不写这一列。修订不重写原计划；同图的后续版本要读原计划时沿 `graph_id`
 *   回到 v1 读，缺失即缺失。
 */
const MIGRATION_17: readonly string[] = [
  `ALTER TABLE graph_versions ADD COLUMN initial_plan_json TEXT`,
  `CREATE INDEX graph_versions_directory
     ON graph_versions (coordination_scope_id, graph_generation DESC, graph_id DESC, graph_version DESC)`,
];

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, statements: MIGRATION_1 },
  { version: 2, statements: MIGRATION_2 },
  { version: 3, statements: MIGRATION_3 },
  { version: 4, statements: MIGRATION_4 },
  { version: 5, statements: MIGRATION_5 },
  { version: 6, statements: MIGRATION_6 },
  { version: 7, statements: MIGRATION_7 },
  { version: 8, statements: MIGRATION_8 },
  { version: 9, statements: MIGRATION_9 },
  { version: 10, statements: MIGRATION_10 },
  { version: 11, statements: MIGRATION_11 },
  { version: 12, statements: MIGRATION_12 },
  { version: 13, statements: MIGRATION_13 },
  { version: 14, statements: [
    `ALTER TABLE pending_interactions ADD COLUMN question TEXT`,
    `CREATE INDEX pending_interaction_page ON pending_interactions(coordination_scope_id, owner_coordinator_session_id, state, created_at, interaction_id)`,
  ] },
  { version: 15, statements: [
    `CREATE INDEX pending_interaction_scope_page ON pending_interactions(coordination_scope_id, state, created_at, interaction_id)`,
  ] },
  { version: 16, statements: MIGRATION_16 },
  { version: 17, statements: MIGRATION_17 },
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
