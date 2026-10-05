# Verification

## 验收对象

- Change：`complete-coordination-runtime-wiring`
- 输入实现 HEAD：`adab77f`（`feat(coordinator): wire replanning, validation, wake and budget paths into production`；直接前驱为 `88d908ae2d5e7d798e207875242df72394cee274`）
- 最终验收 HEAD：`2af806f`（相对 `adab77f` 只含 verification.md，无产品代码改动）
- 验收 Agent：MiniMax-M3.1-Flash-Preview（主代理，按 `openspec instructions verification` 执行；未由独立验收子代理复核）

## 结论

**PASS**，边界为实现提交 `adab77f` 这棵确定的树。9 份 delta spec 的每个 Requirement/Scenario、IP-01—09 的文件与命令映射、限定审计的七个范围全部通过，验收阶段发现的唯一证据缺口已就地补测修复。真实 Orca/provider 端到端验收不在本 change 的应完成义务内，相关边界记在「后续注意事项」。

## 核验与修复证据

### 行为合同

| Requirement / Scenario / IP-ID | 证据或命令 | 结果 |
|---|---|---|
| `coordinator/foreground-execution-runtime` 前台进程有界并行推进角色工作（全部 Scenario）/ IP-08、IP-09 | `tests/application/advance-execution.test.ts:388`（额度 1/2/3/5 并行且未观察派发仍占位）、`:418`（CAS 竞争、重启、降低额度不超额或丢失）、`:680`（canonical 推进后新包以当前 HEAD 为基线）；`tests/bootstrap/foreground-execution-runtime.test.ts` | 通过 |
| `coordinator/foreground-execution-runtime` Implementation Attempt 的准入消费有限且幂等（全部 Scenario）/ IP-01 | `tests/coordination-store.test.ts:3521`（同 Task Retry 与重放不误扣）、`:3540`（重新授权后保留已消耗实现预算，预算上限变化两种情形）；`tests/application/materialize-work-package.test.ts:1008`（只有确定失败可重派）、`:1051`、`:1145`（绑定与候选授权不一致即阻塞）；`tests/application/record-worker-result.test.ts:117`、`:133`、`:220`（缺证据不构成尝试结局） | 通过 |
| `execution/specification-revision` revision_pending 只冻结受影响节点与其未接受后代（全部 Scenario）/ IP-08、IP-09 | `tests/application/advance-execution.test.ts:1096`、`:1114`、`:1153`、`:1194`（存活不可核验不算结清）、`:1271`（修订额度耗尽不重跑 Planner）；`tests/execution/graph-patch.test.ts` | 通过 |
| `tui/execution-monitoring` 执行图与 Frontier 投影、Work Package 生命周期与串行 integration queue 投影（全部 Scenario）/ IP-08、IP-09 | 主规格 `openspec/specs/tui/execution-monitoring/spec.md:23`、`:43` 已同步为批准额度语义；`tests/application/execution-view.test.ts`、`tests/application/graph-basis.test.ts`、`tests/tui` | 通过 |
| `execution/validation` 修复限定在授权范围与修复预算内，且证据与预算归属不被掩盖（全部 Scenario，含新增「同一修复许可重放」「修复报告遗漏实际越界变更」）/ IP-04 | `tests/application/run-validation.test.ts:154`（修复与复验复用同一真实会话）、`:283`（越界要求 Escalation）、`:301`（实际改动路径超出获批意图）、`:319`（证据失效并要求新证据）、`:373`（预算耗尽阻塞并给预算键）、`:396`（修复前持久准入给稳定 stepId）；`tests/bootstrap/validation-runtime.test.ts:88`（ask/reply 原序恢复，含预先回读）、`:173`、`:191`；`tests/bootstrap/foreground-validator-runtime.test.ts` 四例，其中 `test.each(['untracked','committed'])` 覆盖实际未跟踪与已提交越界改动 | 通过 |
| `planning/route-map` Ticket Claim binds a ticket to one Session（含新增「已持票 Session 再认领另一张票」）/ IP-01 | `tests/coordination-store.test.ts:3598`（至多一个活跃 Claim，释放后可再认领）、`:3707`（v19→v20 遇重复活跃 Claim 整体回滚）；`tests/application/route-map-service.test.ts:711`（第二次认领被拒且不发出 tracker 写） | 通过 |
| `coordinator/route-planning-handoff` Route Planning session handoff（含新增「接收方已有活跃 Claim」；后者由 store 约束保证整体回滚）/ IP-01、IP-05 | `tests/application/planning-handoff.test.ts`「交接不触碰在途 Worker 的所有权事实与 Execution Coordination Lease」——验收阶段为该用例补入 Claim 归属断言，确认 Claim 随规划责任转到 SESSION_B 且 Execution Lease 仍留在 SESSION_A | 通过（含本轮修复） |
| `coordinator/execution-handoff` Execution Handoff 以独立状态和 CAS 转移执行责任（含新增「接收方持票冲突使交接整体拒绝」「Worker 事件不越过用户 Prompt 门」）/ IP-01、IP-05 | `tests/coordination-store.test.ts:1464`（一次调用内转移 Lease、open interaction 与活跃 Claim）、`:1495`、`:1515`、`:1597`；验收阶段新增用例「cutover 在 Target 已持有另一活跃 Claim 时整笔拒绝」，断言 rejected/`constraint` 且 Lease generation、interaction 归属、两张 Claim 归属与 handoff phase 全部不变；`tests/bootstrap/foreground-execution-runtime.test.ts:1280`（cutover 后 Target 处于 `awaiting_user_prompt`，历史消息与定时对账都不启动模型） | 通过（含本轮修复） |
| `coordinator/wake-suspension` Resumption requires admitted Actionable Work（含新增三个 Worker/结算 Scenario）/ IP-05 | `tests/application/actionable-work.test.ts:75`（进度、keepalive、长轮询超时、无变化对账不产生可行动工作）、`:114`（owner-scoped）、`:123`/`:132`（已准入 source 不重复、更高 revision 仍成新工作）；`tests/bootstrap/execution-delivery.test.ts:587`（Worker 提问经 callback 证明耐久消费后才确认批次）、`:613`（拒绝消费则批次阻塞不确认）、`:741`（旧代际只补历史）；`tests/bootstrap/execution-finalizer.test.ts:962`（交付结论只在结算完成后准入 Wake）；`tests/bootstrap/foreground-validator-runtime.test.ts` 断言步骤问题不产生 Wake | 通过 |
| `coordinator/session-runtime` Committed model step and durable resumption identity（含新增「checkpoint blocker 重启后仍存在」）/ IP-07 | `tests/application/runtime-guard.test.ts:338`（不可恢复时 fail closed 且不转移 claim/lease）、`:387`、`:434`（执行 Lease holder 损坏时 Session 与 Scope 持久 blocked）、`:471`（非持有者只阻塞本 Session） | 通过 |
| `execution/replanning` 三个 Requirements 全部 Scenario（D-01/D-02 修复目标，主规格不改写）/ IP-02、IP-03 | `tests/execution/replanning.test.ts:116`—`:614`（显式触发、drain/stop-reconcile 两种收尾、取消后重新核验并重取 Lease、Cutover 原子切换、拒绝复用 Run 与 WorkPackageId、引用不完整整体阻断、前代事件只补历史、重复开始可重入、取消重放幂等、候选审阅落在当前 Cycle、批准后用 Cutover 接手新代际 Lease）；`tests/application/select-bound-run.test.ts`（accepted / unknown_proven / unknown_unproven / definite_failure 四种处置）；`tests/bootstrap/plan-continuations.test.ts:263`—`:647`（Orca 回读核验、矛盾阻塞、lineage 继承 effectiveConsumption、预检失败零副作用、真实 Git 判定证据失效） | 通过 |
| `coordinator/context-maintenance` Native-first compaction with opaque native window and explicit degradation（全部 Scenario，D-07 修复目标）/ IP-06 | `tests/workflow/compaction.test.ts:90`（原生优先）、`:115`（回退 Capsule）、`:137`（机械 Shake 只执行一次）、`:167`、`:214`（同一稳定边界至多一次 Shake）；`tests/application/compact-session.test.ts:176`—`:288`；`tests/adapters/checkpoint-store.test.ts` | 通过 |
| `coordinator/wake-suspension` Suspension and best-effort maintenance lane（全部 Scenario，D-07 修复目标）/ IP-06 | `tests/bootstrap/foreground-planning-runtime.test.ts:309`（每次挂起最多 8 次保活、真实 prompt 后重置、不生成模型或 checkpoint 条目）、`:350`（close / pause / fence 均停止后续保活且迟到返回不续排） | 通过 |
| `configuration/model-settings` User credential store with isolated secrets（全部 Scenario，D-08 修复目标）/ IP-07 | `tests/adapters/chat-model-factory.test.ts:62`（installed integration 暴露可选 native compaction / keepalive，缺失或非法一律 null）、`:107`、`:121`；`tests/adapters/agents/codex-launch.test.ts:250`（secret 只进子进程环境）、`:358`（managed 凭据必须由宿主注入，未注入时准备前拒绝且不留产物）；`tests/doctor.test.ts`、`tests/bootstrap/doctor-model-configuration.test.ts` | 通过 |

### 工程检查（最终树）

| 检查 / IP-ID | 命令 | 结果 |
|---|---|---|
| 全量回归 / IP-09 | `pnpm exec vitest run --maxWorkers=2 --testTimeout=30000 --hookTimeout=30000` | 177 文件通过、7 跳过；2035 通过、14 跳过；960.94s |
| 类型 / IP-09 | `pnpm typecheck` | 通过（退出码 0） |
| 静态检查 / IP-09 | `pnpm lint` | 通过（退出码 0） |
| 构建 / IP-09 | `pnpm build` | 通过（退出码 0） |
| 差异卫生 / IP-09 | `git diff --check` | 通过，无空白错误 |
| change 严格校验 / IP-08、IP-09 | `openspec validate complete-coordination-runtime-wiring --strict` | `Change 'complete-coordination-runtime-wiring' is valid` |

全量回归的计数需要按最终树重跑：上一份全量记录（2023 通过）启动于 23:09:50，而 `reply-worker-question.ts`、`plan-continuations.ts`、`foreground-planning-runtime.ts` 及其测试在 23:10—23:32 仍有改动，那份计数不覆盖最终实现，已弃用。

### 验收阶段完成的修复

两处，都是缺失的行为回归证据，未改动生产代码：

1. `tests/coordination-store.test.ts` 新增用例「cutover 在 Target 已持有另一活跃 Claim 时整笔拒绝，Lease、interaction 与 claim 均不变」，并为既有用例 `:1464` 补入 Claim 归属断言。此前 handoff cutover 的 Claim 转移在 store 中已实现（`src/adapters/storage/coordination-store.ts:5719`、`:6144`），但没有测试覆盖转移与冲突回滚，`coordinator/execution-handoff` 与 `coordinator/route-planning-handoff` 的两个新增 Scenario 属于无证据状态。首次运行暴露测试装配错误（第二个 Session 的注册必须由持 Runtime Lease 的 writer 执行），修正后通过。
2. `tests/application/planning-handoff.test.ts` 为「交接不触碰在途 Worker 的所有权事实与 Execution Coordination Lease」补入 Claim 归属断言，确认规划 cutover 把活跃 Claim 转给 Target、同时 Execution Lease 仍留在 Source。

修复后 `pnpm exec vitest run tests/coordination-store.test.ts tests/application/planning-handoff.test.ts --maxWorkers=2 --testTimeout=30000 --hookTimeout=30000` → 2 文件 86 测试全通过；typecheck、lint 在补测后重跑仍通过。

## 限定审计

implementation-plan §8 声明的七个审计范围全部触发，范围为只读代码核验加对应行为测试，未修改规划工件。

| 审计范围 | 结论 | 证据 |
|---|---|---|
| 预算准入、重放与授权锚定 | 通过 | `coordination-store.ts:5798`—`:5820` 在 `record-materialization-binding` 同一事务内按 `workPackageBudgetKey(workPackageId,'implementationAttempts')` 消费并对旧授权锚定计数取有效消费上限；`:1329` 的 `admit-validation-step` 同理消费 `validatorRepairs`；`foreground-planning-runtime.ts:4761` 是该准入的生产签发方。对应 `coordination-store.test.ts:3521`/`:3540`/`:3560` 与 `foreground-validator-runtime.test.ts` 的「恰好扣一次」断言 |
| Claim 与交接事务 | 通过 | `schema.ts:661` 保留 per-ticket 唯一索引并新增 `(coordination_scope_id, coordinator_session_id) WHERE state='active'` 部分唯一索引；`coordination-store.ts:5719`（执行交接）与 `:6144`（规划 cutover）在同一事务内转移 Claim，冲突时整笔回滚，由本轮新增用例与 `route-map-service.test.ts:711` 覆盖 |
| 精确 Session 与实际 Git 修复范围 | 通过 | `validation-runtime.ts` 只接受 question 类型、schema 版本与本次 Work Package/Task/Dispatch/Attempt 全部一致的步骤消息，其余返回 `ignored`；`foreground-planning-runtime.ts:4651` 要求许可修复前 worktree 的 `dirtyPaths` 为空，`:4654` 把该 HEAD 作为 `expectedHead` 写入 Reply Intent，重试时从 `:4646` 的原 Intent 回读同一基线；`baseline-observer.ts:98`—`:109` 用 `git diff --name-only <baselineHead>` 合并 `status --porcelain=v1 -z --untracked-files=all` 的 dirty paths，覆盖已提交、未提交与未跟踪三类实际变更。`validation-runtime.test.ts:173`、`run-validation.test.ts:301`、`foreground-validator-runtime.test.ts` 的 `['untracked','committed']` 参数化用例分别覆盖自述遗漏与已提交越界 |
| Run 选择、Cutover 与取消的未知结果 | 通过 | `select-bound-run.ts` 的四态处置（accepted / unknown_proven / unknown_unproven / definite_failure）各有测试；`replanning.test.ts:405`/`:426`/`:438` 拒绝复用 Run、复用 WorkPackageId 与引用不完整；`:246`/`:554` 覆盖取消后的重新核验与重放幂等 |
| Wake owner、ACK 与跨库恢复 | 通过 | `foreground-planning-runtime.ts` 的 `observeWorkerMessage` 先核验实际发送方（`worker-show` 的 `exactWorker`/dispatchId/taskId/terminal handle 四项一致）再准入，历史消息只消费不唤醒，步骤消息走确定性通道；`execution-delivery.test.ts:587`/`:613`/`:718` 覆盖消费证明前不确认与本地写失败不 ack；`actionable-work.test.ts:123` 覆盖已准入 source 不重复注入 |
| 有限维护与 Shake | 通过 | `maintenance-lane.ts` 的判定顺序为已停止 → fencing → 控制状态 → Actionable Work → cycle 上限，间隔非正安全整数即 `keepalive_unavailable`；`foreground-planning-runtime.test.ts:309`/`:350` 覆盖 8 次上限、真实 prompt 重计数与 close/pause/fence 停止；`compaction.test.ts:214` 覆盖同一稳定边界至多一次 Shake |
| 持久 blocker 与凭据唯一来源 | 通过 | `runtime-guard.ts:239` 在原 checkpoint 不可恢复时写 `lifecycleState:'blocked'` 与结构化 `blockedReason`，并对执行 Lease holder 追加 Scope 阻塞，`runtime-guard.test.ts:434`/`:471` 覆盖两种归属；`new JsonCredentialStore` 全仓只有两处，均在 bootstrap（`foreground-planning-runtime.ts:1245` 的宿主单实例、`doctor.ts:474` 的一次性命令实例），chat model factory、Worker launcher 与模型设置用例均只接受注入端口，无 fallback 构造 |

## 后续注意事项

以下不影响本结论的边界，可在 archive 前或之后处理：

- 本轮接通的是生产调用链（重规划、Validator 同会话修复、Worker reply、前台 pump），证据来自 fake backend 与临时 Git worktree。真实 CLI 能力缺口要靠一次隔离项目的完整闭环才能确认，届时不能复用前驱的 fixture 06 证据。
- `src/interfaces/cli/status-command.ts:199` 的 `maintenance: null` 仍然存在。这是 `status --json` 一次性只读路径按其声明的 `scope:'store-only'` 不启动前台宿主的结果，`maintenance` 字段类型允许 null，运行时维护事实只由 TUI 宿主快照提供；不要把它读成维护 lane 未接通。
- 6 份 delta spec 尚未同步进主规格（本轮已提前同步的是三处并行条款）。按 orchestrated-delivery 流程留到 `openspec sync specs`；`openspec/config.yaml` 的当前 change 上下文已指向本 change，归档时需一并回填。
- `coordination.sqlite` schema 19 → 20 的迁移对既有重复活跃 Claim 会拒绝启动并整体回滚。本机测试库未触发该分支，真实项目升级前应先确认没有同一 Session 持有多张活跃票。
