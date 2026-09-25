# Verification

## 验收对象

- Change：`m2-wire-execution-runtime`
- 输入实现 HEAD：`82b98e33284366cd81c732bfff639158ecc043d2`（首轮）＋ 本轮未提交工作区改动
- 验收 Agent：Codex（首轮 FAIL）与本轮实现/复核
- 结论以当前工作区文件为准

## 结论

**PARTIAL。** 8 项任务中 7 项完成（1.1、1.2、2.1、2.2、3.1、3.2、4.1），IP-08（4.2）仍未通过：真实闭环已在本机跑到**Validator 阶段**（授权 → Planner → Delivery 结算 → Specification Admission → Implementation → Delivery 结算 → Validator 派发），集成与只读 Finalizer 尚未取得真实结论。首轮 FAIL 的三条阻塞本轮都已前移：

- **受限沙箱**：不再是阻塞点。Codex 0.156.1 在该主机的 bwrap 判定因 `/tmp` 位于 btrfs 必然失败（`codex-rs/linux-sandbox/src/daemon_mounts.rs::check_mounts` 比较 `st_dev` 与 mountinfo device）。项目配置新增 `execution.codexSandbox`，隔离项目显式接受 `codex-sandbox-danger-full-access` 风险后，Worker 真实执行并提交。
- **Recovery 事实**：生产事实装配已接通，并真实触发出一条 Recovery 记录（`status: pending`，等待 Capsule 路径）。
- **Delivery 载荷**：真实 Worker 投递的是 Orca 规范形状；Companion 现已接受该形状并用已记录事实定位归属（见下），因此 Delivery 能结算并推进到下一个角色。

## 核验与修复证据

| Requirement / Scenario / IP-ID | 证据或命令 | 结果 |
|---|---|---|
| 授权切换；批准后进入执行、规划引用过期；IP-01 | `tests/bootstrap/execution-authorization.test.ts`；真实项目审阅显示 `Worker Sandbox codex=danger-full-access` 并签发授权与 Execution Lease | 通过（fake ＋ 真实审阅/批准） |
| 串行推进；首个候选、后继角色、派发未知；IP-03 | `tests/application/advance-execution.test.ts`；真实隔离 worktree、Orca Task `task_6406bff5b29d`（Planner）与 `task_62ea3da4698c`（Implementation），Dispatch `ctx_bc6ced82be97` / `ctx_e6c602d6fe86` / `ctx_7a5e40f952fa`（Validator） | 真实首个候选、后继角色与 Validator 派发均通过；Validator 结论与集成尚未走到 |
| Delivery/Recovery；Validator 修复、旧代际、Session 无法恢复；IP-04 | `tests/bootstrap/execution-delivery.test.ts`（生产事实装配 + Orca 规范载荷的两条用例）、`tests/application/run-validation.test.ts`；真实 settlements：planner `task_6406bff5b29d#d7b2d969daa83`、implementation `task_62ea3da4698c#0acd8d43cb8ed`；真实 Recovery 记录 `status: pending` | fake 与真实 Delivery 结算均通过；Validator 修复与 Recovery Capsule 未走到 |
| 重启与 Resume；活跃 Worker、未决操作；IP-02 | `tests/bootstrap/foreground-execution-runtime.test.ts`、`tests/bootstrap/startup-reconciliation.test.ts` | 通过（fake）；真实重启对账另见下方修复 |
| Cancel；stop verdict 不确定；IP-07 | `tests/adapters/worker-stop.test.ts`、`tests/coordination/scope-control.test.ts`、`docs/orca-compatibility.md` | fake 通过；真实 `stop_unknown` 仍按 unverifiable 处理 |
| 集成；结果不确定；IP-05 | `tests/application/integrate-work-package.test.ts`、`tests/adapters/git-integration.test.ts`（含「Worker 已自行提交按当前 HEAD 认账」与「孤儿 HEAD 仍拒绝」） | 通过（fake + adapter）。首次真实尝试因 commit 步要求 source HEAD 仍等于 baseline 而被拒绝（真实 Worker 会自行提交），修复后在同一分支上重跑：Planner 提交 `78e2f01`（HEAD 是获批基线的后继），集成步尚未在真实运行里观察到结论 |
| Finalizer；集成成功、只读或工作区无法核验；IP-06 | `tests/bootstrap/execution-finalizer.test.ts`、`tests/application/finalize-project.test.ts` | 通过（fake）；真实 Finalizer 因本机无可用只读沙箱必然停在 blocker |
| 放宽 Worker 沙箱必须由已批准的 Manifest 承担 | `tests/bootstrap/execution-authorization.test.ts`（未接受风险时零授权、接受后 Manifest 逐字携带风险）、`src/bootstrap/foreground-planning-runtime.ts` 的 `codexSandboxForDispatch` | 通过 |
| 真实闭环；IP-08 | `ORCA_COMPANION_E2E_REPO=<isolated> ORCA_COMPANION_E2E_IDENTITY=<identity> ORCA_COMPANION_E2E_LOOP=1 pnpm exec vitest run tests/integration/foreground-execution-runtime.test.ts --no-file-parallelism`；隔离项目 `orca-companion-e2e2` + 身份 `term_61d0e12e-…` | 部分：授权与真实 Planner Worker 通过；结算→Finalizer 未通过 |
| 全量门禁 | `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`、`openspec validate m2-wire-execution-runtime --strict` | 全部通过（Vitest 134 files 通过 / 6 skipped，1155 tests 通过 / 12 skipped） |

### 本轮实现修复（都在本机真实运行中定位）

1. **Delivery 载荷只认 Companion 形状 → 真实交付永远被阻塞**（本轮最后定位并修复）：真实 Codex Worker 投递的 `worker_done` 载荷是 `{taskId,dispatchId,outcome,filesModified}` + `body` 叙述，Companion 的入口却要求回显 Companion 身份与 `result`，因此每条真实 Delivery 都被判 `result_missing` → 既不结算也不产生任何 intent。现在入口接受两种形状：Companion 形状照旧，Orca 规范形状只作 locator（`materialization_bindings.orcaTaskId` + Session Segment 逐项一致才放行，否则阻塞），结果正文归一化为 `{outcome, filesModified, summary}` 后写回 Orca Task 并回读核验。IC-08 合同与 change spec 已同步，`tests/bootstrap/execution-delivery.test.ts` 新增「Orca 规范形状进入结算」与「定位不到即阻塞」两条用例。修复后真实闭环前进了两整步：Planner 与 Implementation 的 Delivery 均结算成功并推进到下一个角色。
2. **CAS 写入被心跳打断 → 已发生的外部 mutation 被判成阻塞**：Runtime Lease 心跳每 10s 续租并推进 Scope revision；物化路径「读 revision → 写 intent」的窗口被命中时，`stale_revision` 会让 `settleIntent` 失败，于是一个**已经建立**的 Orca Task 变成永久阻塞的 lane。现按计划 §5「CAS 冲突重读事实重新决策」在物化路径重读 revision 重试本地写入；回归用例 `tests/application/materialize-work-package.test.ts` 的「并发写入…」在修复前失败、修复后通过。
3. **Resume 对账与在途推进抢同一批 intent**：Resume 的「先对账」会在本进程的推进仍在跑时读到一个 pending 的 mutation intent，把它判成未决并阻塞 lane。现 Resume 先等在途推进收尾（有界 `RESUME_IN_FLIGHT_WAIT_MS`）再对账。
4. **Recovery 生产事实**：`createExecutionRecoveryFacts` 从精确 transcript 重读中断归属、用 `worker-list`/`terminal-list` 判存活、用 `worktree-list` + `readWorkspaceFacts` 对账 workspace、只认已结算 Orca 结果为原会话终态，并按已批准 Manifest 准备替代 Session；`readOrcaTaskId` 改为按 role + Attempt 命中。Capsule 提取仍需要 IC-08 Delivery 路径。
5. **集成 commit 步要求 source HEAD 仍等于 baseline**：真实 Worker 会自行提交交接成果（Codex 在 worktree 里 commit），因此 `expectedHead` 比对必然失败并拒绝该步，lane 随即被 settle-rejected 的意图永久卡住。现在 commit 步接受「已自行提交」：只在能证明当前 HEAD 是所记录 expected HEAD 的后继（`merge-base --is-ancestor`）时按「已经提交」继续，无法证明后继关系仍以 `source_head_mismatch` 拒绝（历史被替换/改写不会进入集成）。回归用例 `tests/adapters/git-integration.test.ts` 覆盖「已提交按当前 HEAD 认账」与「孤儿 HEAD 仍拒绝」；IC-08 合同与 change spec 已同步。
6. **运行前置（环境，非本仓库缺陷）**：`workspaceDir` 指向的路径必须是真实目录（`/home/joshua/orca` 曾是一个陈旧 socket，导致所有 `worktree create` 以 `ENOTDIR` 失败）；协调终端的 Run 绑定会被 Orca 清掉，需要用同一身份 `run-use` 重新绑定；本机只读 Codex 会话不可核验（`/tmp` 在 btrfs 上使 bwrap uid map 失败），因此 Finalizer 类只读角色在真实运行中必然停在 blocker。
7. **Planner 按 OpenSpec 惯例把 change 归档，而 Admission 只读固定 active 路径**（本轮两次真实运行都复现）：Worker 完成 `openspec validate` 后自行 `openspec archive`，规格单元只存在于 `openspec/changes/archive/<date>-<name>`，`specificationUnitPath` 指向的 active 路径为空 → Specification Admission 失败 → Delivery 不结算，链路停在这一步。现 `SpecificationProvider` 按工具原生布局解析该固定路径：活跃目录缺失时读**同名唯一**归档目录（OpenSpec 的 `<date>-<name>`），不存在或不唯一仍以 `unit_absent`/`unit_ambiguous` 拒绝；角色工件转换状态同样按 `specificationUnitPathFor(workPackageId)` 读取，不再按「worktree 内唯一活跃 change」猜测。单元身份不变：Binding 仍是内容摘要 + 两个 revision，路径保持宿主声明的规范路径。IC-06 合同已同步；`tests/application/specification-admission.test.ts` 覆盖「归档后仍接纳同一单元（摘要不变）」「同名归档不唯一即拒绝」「转换状态在归档后仍就绪」三条用例。
8. **Validator 自己的报告被判成越界改动 → 结果永不结算**（本轮真实运行定位）：Worker 把报告写在 `.agents/validator-report.md`（OpenSpec/agent 工具的状态目录），而 Scope Envelope 只允许 `README.md`，于是 `verifyWorkerResult` 以 `scope_envelope_violation` 拒绝该 Delivery；拒绝只留在进程内（没有 intent、没有 lane），重启后无法观察，链路静默停住。现在**工具状态目录不是项目改动**：`projectChangedPaths` 一处实现，越界判定、canonical 工作区干净性与 Finalizer 运行前后比较都走它（项目路径仍必须落在 Scope Envelope 内）。IC-08/IC-09 合同与 change spec 已同步；`tests/domain/worker-result-verification.test.ts` 覆盖「工具状态不算越界」与「同名前缀的项目路径不被吞掉」。
9. **Worker 退出即有未确认 Delivery 时被当成「会话丢失」**：Recovery 触发只看「没有已接受结果」，忽略了结果还挂在 Orca 未确认 Delivery 上这一事实，于是为一条已经交付的会话启动 Recovery，并占住它的替代派发 lane。现在中断判定要求**没有该 Dispatch 的未确认 Delivery**（读取失败时不启动），选择规则抽成可测的 `interruptedSegmentOf`（`tests/bootstrap/foreground-execution-runtime.test.ts` 覆盖）。
10. **前提已消失的 Recovery 会被永久续办**：原会话结果已结算时，`continueRecoveries` 仍会为它尝试派 Utility Worker，记录永远停在 `pending`。现在续办路径先看同角色同 Attempt 是否已有结算：有则以 `recovered` + `source_completed` 收口并 supersede 原 Segment，不派 Worker、不占 lane（`tests/bootstrap/startup-reconciliation.test.ts` 覆盖）。续办步骤读的也是**重放之后**的快照，因此同一次启动内刚结算的 Delivery 会让对应 Recovery 立即收口。
11. **integrate 步拿上一步的 source HEAD 去核验 canonical**（本轮真实运行定位）：集成三步的 `expectedHead` 被串成一条链，`commit` 之后 `expectedHead` 变成 source HEAD，`integrate_canonical` 却用它去比对 canonical HEAD——必然 `canonical_head_mismatch` 并被 settle-rejected 的意图永久卡住（真实运行里 commit 步已经通过，integrate 步被拒绝）。现在按**目标**分别记录核验基准：commit 用 source、integrate/push 用 mutation 前读到的 canonical HEAD，且任何 mutation 之前必须先读到 canonical 基准（读不到即阻塞）。
12. **同一 Orca 回执有两套解析器**：`materialize-work-package.ts` 认识真实嵌套形态（`{ task: { id } }`），`utility-worker.ts` 只认平铺字段，于是 Finalizer 派发在真实运行里出现「Orca 已创建 Task，但 Companion 判为回执缺少 task id」并阻塞。现在只有一处解析（`orcaTaskIdFromReceipt`/`orcaDispatchIdFromReceipt` 在 `ports/execution-backend.ts`，作为 port 对 Orca RPC 结果的唯一镜像），两处调用点与测试都改用它。
13. **新项目里协调身份取不到 → 执行永不推进**（本轮真实运行定位）：identity 探测先用 `terminal-list --worktree path:<canonical worktree>` 过滤，而**新项目的路径还没被 Orca 登记成 worktree**，该查询以 `selector_not_found` 失败并被当作「没有协调身份」，于是宿主在每个执行触发点静默返回、Frontier 一动不动（`run-create` 之后再无任何 mutation）。现在显式声明的 `coordinatorIdentityRef` 直接生效（不再依赖 terminal 列举，只用 `run-current` 核验），并且在探测自身的 backend 里与观察到的句柄同权——否则探测会先宣布身份可用、随后每个带身份的查询都因解析不到该句柄而失败。

14. **空闲推进没有任何可观察事实**：`advanceExecution` 返回 `idle` 且自身没有 blocker 时（例如「此刻没有可派发起步的候选」），宿主既不写 blocker 也不发布原因，界面上只剩静止；本轮在全新项目上排查「Frontier 不动」时，`status`/宿主快照都读到空 blocker，无法判断是等 Worker、等依赖还是被门禁挡住。现在空闲结果一律把原因写成 `advance`  blocker（有自身 blocker 时用其码，否则 `advance_idle`），下一次触发仍会照常清除它。

15. **Session Binding 只会建立一次 → 错过了就永远补不上**（收口轮实现，真实运行验证）：`recordRoleSession` 只在派发那一次、且在 `bindingWindowMs` 窗口内读 Codex SessionStart 报告；报告迟到或派发进程先退出时，`materialization_bindings` 有行、Session Segment 缺失，该派发的 Delivery 按 IC-08 无法归因（`dispatch_record_missing`），链路停在「Worker 已做完、结果无法结算」。现在 schema 12 让物化绑定记录这次派发的 **launchId**，并在每次执行触发时对「已 issued 且带 launchId、但图内没有对应 Segment」的角色用同一份 `bindCodexSessionFromStartReport` 事实补记（Orca Dispatch 按已记录的 Task 从列举事实匹配，报告读不到就什么都不做）。派发路径与补记路径共用同一签发与写入实现。**真实证据**：e2e7 的 Planner Segment 由后续触发的补记写出（`segments: ['planner']`），随后 Planner Delivery 结算成功；同一 Scope 里那条「前提已消失」的 Recovery 也按新规则以 `recovered` + `source_completed` 收口。
16. **Planner 不知道产出位置与结构（宿主没把话说清）**（收口轮实现，真实运行验证）：Task Envelope 现在携带面向 Worker 的 `instructions`，Planner 必须收到三条产出纪律（写在固定路径、必须含 `specs/`、不得自行归档或改名）；指令由宿主写出、Worker 只读、回传镜像不参与身份判定。**真实证据**：两次真实运行里 Planner 分别自选 kebab-case 目录名、漏写 `specs/`；加入指令后 e2e7 的 Planner 直接把单元写在 Envelope 的固定路径下并建出 `specs/`。
17. **固定路径用百分号编码，Worker 会写成解码形式**（收口轮实现）：`specificationUnitPathFor` 改为「文件系统安全的 slug（非字母数字折成 `-`）+ 8 位内容哈希后缀」，跨平台可写、人能照写、不同 Work Package 不撞名；同时 Admission 与角色转换都以**当前规范路径优先、物化绑定里记录的旧拼写兜底**（路径只是定位信息，身份是内容摘要）。**真实证据**：e2e7 里 Planner 把单元写成了 `e2e-loop-scope#g1:readme-banner`（解码形式）而宿主声明的是 `%23`/`%3A` 版本，Admission 因此 fail closed；修正读取规则后同一条链路通过 Admission 并开始派发 Implementation。
18. **CLI 看不到「为什么停住」**（收口轮实现）：`status --json` 增加 `projection` 字段（`scope: 'store-only'`、`missing: ['execution-blockers','worker-liveness','delivery-intake']`），明确声明该投影不调用 Orca，执行期 blocker 只有宿主快照能看到——本轮排查为此多花很久，正是缺这句话。

21. **`delivery-ack` 结果未知后同样无法对账 → lane 永久阻塞**（本轮定位并修复，与第 19 条同一类）：宿主在确认 Delivery 的中途被杀时，`delivery-ack` 的 intent 停在 `pending` 并以 `no_backend_request_id` 阻塞——Accepted Worker Result 已经写进 Orca、本地去重键也已落盘，但确认没完成，于是 WP 不再推进。现在 `confirmDelivery` 在结果未知时按**Orca 事实**判断：再次读取未确认批次，若这条 Delivery 已不在其中（批次已换或为空）就说明确认发生过，按 `accepted` 收尾；读不到批次不算证据。`tests/bootstrap/execution-delivery.test.ts` 新增用例覆盖「批次已换 → 结算完成」。

19. **`worker-start` 结果未知后无法对账 → lane 永久阻塞**（本轮定位并修复）：宿主在 `worker-start` 的 mutation 结果未知时被杀，intent 停在 `pending`；随后对账以 `no_backend_request_id` 阻塞该 lane——`reconcileOperation` 只会用 `request-show`（需要 backend request id），拿不回资源身份。Worker 其实已经跑起来并成功（`worker-list: succeeded`）、Session Binding 也已补记，但 WP 不再推进。现在 `runMutation` 接受一个可选的**事实对账**回调：结果未知时先按 Orca 列举事实判断这次 mutation 是否已经发生（`worker-start` 用 `worker-list` 里该 Task 的 Worker 及其 Dispatch 作为资源身份），证据成立就以 `accepted` 收尾并继续，读不到才落回原来的阻塞路径。`tests/application/materialize-work-package.test.ts` 覆盖「列举里已有该 Worker → 按事实收尾（intent settled/accepted）」与「列举里没有 → 仍然阻塞」两条。

20. **Specification Unit 落在流程目录里，被判成越界改动 → Planner 的 Delivery 永不结算**（本轮定位并修复）：Work Package 的 Scope Envelope 通常只含被实现的项目路径（e2e 计划里是 `README.md`），而 Planner 必须把单元写在 `openspec/changes/…`。`verifyWorkerResult` 因此以 `scope_envelope_violation` 拒绝 Planner 的 Delivery，链路停在「Planner 已交付、结果无法结算」。现在 `openspec/changes/**`（含 archive）作为**流程目录**不参与越界判定（`envelopeCheckedPaths`，与工具状态目录同一条思路）：它是流程工件、不是项目内容；单元身份仍由内容摘要与 Spec Binding 约束。IC-06/IC-08 与 change spec 已同步；`tests/domain/worker-result-verification.test.ts` 覆盖「流程目录不算越界」与「流程目录之外的项目改动仍然越界」。**真实证据**：修复并重建后，e2e11 上 Planner Delivery 结算成功、Implementation 角色随即被物化。

22. **集成把 canonical 分支当源分支 → 静默 no-op**（本轮真实运行定位并修复，最危险的一类）：集成请求的 `branch` 传的是 `manifest.gitPolicy.canonicalBranch`，于是 `integrate_canonical` 在 canonical 里执行 `merge --ff-only <canonical 分支>`——自我合并，git 报 "Already up to date"、退出码 0，回读的 HEAD 与步骤自报一致，三步全部 `settled accepted`，**而 canonical 分支与获批 ref 都没有动**（真实证据：e2e12 的 `git-integration-commit/integrate/push` 全部 accepted，但 `e2e12-integration`、`main` 与 `git ls-remote` 都还停在 baseline `275c4b8`，WP 分支在 `3e64e3c`）。现在集成源分支取自**该 Work Package 隔离 worktree 自己的分支**（`integrationSourceBranchOf`，从 `worktree-list` 的归属注释定位），读不到就阻塞该 lane；`git-integration.test.ts`/host 测试与新用例覆盖「源分支必须是 WP 分支」与「读不到即阻塞」。真实重跑需新 Scope（旧 Scope 的集成结论是 no-op，不能作为交付证据）。

## 限定审计

| 范围 | 结论与证据 |
|---|---|
| `single-execution-owner`、`stable-operation-id` | `advanceExecution` 重验模式、revision、Execution Lease 与授权；真实运行中同一候选只产生一组稳定身份（intent 表可见 `run-create` / `materialize-task` / `-worker-terminal` / `-worker-start` 各一条且 settled） |
| `delivery-ack-order`、`validator-session-binding` | `process-delivery.ts` 在接纳结果后 ack；真实 Planner 的 Session Binding 由 SessionStart 报告 + transcript proof 签发并记录为 Session Segment |
| `git-target-readback`、`finalizer-read-only` | 分目标回读与 fake Finalizer 用例通过；真实只读 Session 在本机不可核验，交付按设计停在 blocker |
| `resume-before-dispatch`、`cancel-stop-verdict` | 启动顺序与三值映射有测试；本轮新增「Resume 不得与在途推进抢 intent」的实现与回归；真实停止仍为 `stop_unknown` → unverifiable |

## 后续注意事项

- IP-08 仍未完成：收口轮把真实链路推进到 **Planner 结算 → Specification Admission 通过 → Implementation 派发开始**（新隔离项目 `orca-companion-e2e7`），此后被**工序失误**打断：驱动脚本在宿主正在物化时释放了 Runtime Lease，`materialize-worker-start` 的 intent 拿到 `released_lease` fencing 拒绝而停在该 lane。继续这一轮需要在同一项目里**重新派发该 Attempt**（或换一个新 Scope），并遵守「驱动期间不要动 Lease」这条工序纪律。
- **已接线：Recovery Capsule 的报告回路（方案 a + 状态根落盘）**。实现：`extractCapsule`（`src/bootstrap/execution-runtime.ts`）先 `inspectCodexTranscript` 取 host 侧 coverage 证据（读不到即 `transcript_unavailable`，不重试），再以 `recovery-capsule-extraction` 信封 + `read-only` 沙箱派发受限 Utility Worker，报告经 Delivery 传输原语读回并按 Orca 身份配对、按 host 证据校验；正文按 `capsuleRef` 的确定性落点写入 Companion 私有状态根并回读，随后才确认该 Delivery。适配器侧新增 `dispatchCapsuleWorker`（`src/adapters/agents/utility-worker.ts`），只做派发与传输、把 Delivery 身份交回调用方，因此 `settleDelivery`（角色结果验收）仍是唯一结算 pipeline。身份输入取 `ExecutionRecoveryFactsInput.writer`，缺失时 fail closed；OperationId 与 launch id 均由 Segment 确定性派生，重放不重复派发。
  - 验证：`tests/recovery/capsule-dispatch.test.ts`（3 例：派发 + 报告读回 + 交回 Delivery 身份；报告与 host 证据不一致即失败；正文确定性落盘/回读/损坏即不可读）；`tests/support/recovery-harness.ts` 增加通用 mutation 钩子（可为 `task-create`/`terminal-create`/`worker-start` 逐项给回执）。
  - Finalizer 的启动策略同步切到 `read-only-local-control`（只读语义不变；比本项目的角色派发配置 `danger-full-access` 更严）：本机此前根本无法建立它的只读会话，交付只能停在 blocker。用例改为断言 profile 与 `--enable use_legacy_landlock`（部署形态变了，只读保证仍在）。
  - **更正**：先前结论「要么放宽沙箱、要么拿不到结果」是错的。本仓库本来就有 `read-only-local-control` 模式（`extends = ":read-only"` + `--enable use_legacy_landlock` + 本机控制通道所需网络），真实验收用例一直在用；Capsule 之前误用了普通 `--sandbox read-only`（bwrap 路径）才在本机全军覆没。已把 Capsule Worker 切到该模式（只读语义未放宽，信封权限未变），并据此更正 `docs/orca-compatibility.md`。回读既有 Attempt 的诊断与修复证据如下。
  - **真实运行的 Capsule 失败原因已定位为宿主只读沙箱**：受限 Utility Worker 确实被派发、被绑定、被激活并运行起来 —— 它的 rollout 里含信封提示（`recovery-capsule-extraction`），其 `subagent_notification` 与末条 assistant 消息表明：该沙箱里**每条命令**都返回 `error building bubblewrap command: cannot establish app-server socket mount isolation`，因此读不到源 transcript、也无从投递报告；宿主按设计 fail closed（`capsule_failed`）。这与 `docs/orca-compatibility.md` 已记录的 Finalizer 只读限制同因，不是接线缺陷；Capsule Worker 按信封 `authority.write=false` 固定只读，不为了绕过本地环境放宽权限。
  - **真实运行已部分走通 Capsule 接线（e2e14）**：启动对账真的派发了只读受限 Utility Worker —— 新 intent `task-create` / `worker-terminal-prepare` / `worker-start` 全部 `settled`，状态根下出现它自己的 Codex home 与 SessionStart 报告（`codex/reporters/be6ddefc82aacbd0e7aa.jsonl`，cwd 指向该 WP 的隔离 worktree），rollout transcript 连续生成。这说明信封、只读沙箱、身份派生与绑定路径在生产上成立。
  - **真实运行暴露的缺陷与最终处置：重放会重发同一 OperationId 的副作用**。证据：Orca 里留下了**两个** Capsule Task（`task_24a2c1d9f08b` dispatched、`task_72a872a78efb` ready），第二个来自报告窗口后的重试。第一次尝试的处置是在共享的 `runProtected` 里给 `beginIntent` 的 `existing` 分支加「不重发」守卫——**该改动已回退**：它改变了角色派发与 Recovery 续办共用的重放语义，导致 `advance-execution`、`startup-reconciliation`、`recovery-budget` 等用例挂起（12 例失败，回退后全部恢复）。共享重放语义归 `m1-*` 规格，本 change 不动它。
- 本 change 内的正确处置（已实现）：Capsule 路径在派发前用 `findDispatchedUtilityWorker`（`task-list` 按信封内容匹配 → `worker-list` 取 Dispatch）**回读已存在的派发**，因此重试/重启复用同一次派发而不再新建；`task-list` 返回 spec 已核实。用例 `重启后续办：按信封内容回读已派发的 Worker，不再新建 Task/Worker`（断言零 mutation）。
- **共享代码里仍存在**的同类风险（记录在案，不在本 change 范围）：`runProtected` 遇到 `existing` 且已 settled 时仍会重发 mutation 并以「settle-intent 已 settled」失败；角色路径靠 `materialization_bindings` + 每次 Attempt 新 OperationId 规避，但没有任何一处显式拒绝这种重入。适合作为独立变更在 `m1` 的重放语义里收口。
- 仍需（不在本 change 范围）：派发身份的回读。当前 capsule 派发的 Task/Dispatch 身份只存在于当时的回执里，重放时无法从 store 读回（角色派发用它自己的 `materialization_bindings` 解决），因此现状是「不重复派发但阻塞」。可行方向：用 `orchestration task-list` 按信封内容回读 Task 身份（需先确认该查询是否返回 spec），或为 Utility 派发补一条持久记录（涉及 IC-03 字段，属规划环节）。
  - 真实运行观察：e2e14 这条既有 Scope **无法**用来观察 Capsule 的接线，因为它的启动对账在 Delivery 步就被真实 blocker 挡住（`scope_envelope_exceeded`：该 change 的 `## Impact` 声明了信封外路径），而恢复续办排在 Delivery 步之后；记录里仍留着 stub 时代写的 `blocking_reason`，本轮没有产生新的 `task-create`（无新 intent）也印证了这一点。要拿 Capsule 的真实证据需要一个新的隔离 Scope，并让某个角色的 Session 真实中断。
  - 仍未做的事（记录在案，不在本 change 范围）：替代 Session 的 Task Envelope 目前**不带 Capsule 正文**（`prepareWorkerLaunch` 只吃 WP 与 Spec Binding），所以 Capsule 现在起「门禁 + 证据 + 可读回」的作用；要让替代 Session 真正接续被压缩的上下文，需要在替代派发时把正文或摘要放进信封。另外 Capsule 提取的 seam 是同步的，所以等待窗口必须有界（`CAPSULE_REPORT_TIMEOUT_MS = 120s`），超时按 `failed` 上报；真实 Worker 若超过该窗口需要改成异步读回（与 Finalizer 的 `finalizerRuns` 同型）。
- **2.2 剩余的唯一接线缺口：Recovery Capsule 的报告回路**（已定位到可执行程度）：
  - 已具备：`buildUtilityWorkerEnvelope`（`recovery-capsule-extraction` 信封 + 输出契约 + `authority {write:false}`）、`dispatchUtilityWorker`/`dispatchScopedWorker`（受限 Utility Worker 的派发与精确 Session 绑定）、`parseRecoveryCapsuleReport`（按 host 侧 coverage 证据校验结论）、`inspectCodexTranscript`（host 侧读取精确 transcript 的 coverage 证据）、`extractRecoveryCapsule`（同一 Recovery 内最多重派一次）；
  - 缺的是**报告回路**：这四件在 `src/` 里都没有生产调用点，`extractCapsule`（`src/bootstrap/execution-runtime.ts:1723`）仍是 stub（fail closed，报 `transcript_unavailable`）。真实运行的 Planner 段落里 transcript 是可读的（705 KB JSONL，位于 `.git/orca-companion/codex/<hash>/sessions/…/rollout-*.jsonl`，`transcript_referenceable=1`、`verifiable=1`），所以卡点是接线而不是事实缺失；
  - 需要先定的一个合同点（当前 stub 注释就是为它保留的）：受限 Utility Worker 的结果**怎么回到应用层**。可选：(a) 复用 Delivery 传输原语（`readDeliveryBatch` + `ackDelivery`，不做角色结算）读回并确认该 Utility Dispatch 的报告；(b) 让 Utility Worker 把 Capsule 写到 Companion 状态根下的确定性路径（与 `capsuleRefOf` 的稳定引用一致），host 读文件并校验。二者都满足「正文不进 store、只存稳定引用」，差别只在运输与可核验证据的来源；
  - 接线位置与形状已明确：在 `createExecutionRecoveryFacts` 的输入（已含 `companionStateRoot`、`workerModel`、`codexSandbox`、`canonicalWorktree`）内，镜像 Finalizer 的 `dispatchScopedWorker` 调用（`createCodexWorkerLaunch({sandboxMode:'read-only'})`、`paths.stateRoot`、`sessionStartReporterPath`），用恢复身份派生**确定性** OperationId 保证重放不重复派发。
- **真实交付卡点的根因：进度消息（heartbeat）挡住了结果消息（已修复）**。真实运行取证：
  - Orca 的「当前未确认批次」在 Worker 跑动期间只有一条进度消息：`delivery_9d77be951e9a` / `type=heartbeat` / `payload={"taskId":…,"dispatchId":…,"phase":"implementing"}`；
  - 真实结果消息 `worker_done`（`payload={"taskId","dispatchId","outcome":"succeeded","filesModified":[6 个 openspec 路径]}`）**不在该批次里**：确认心跳之后它才成为当前批次（实测 `delivery-ack delivery_9d77be951e9a` → 下一次读变成 `delivery_8d7a41cc0205` + `worker_done`）；
  - 修复前宿主把「批次里只有进度消息」判成 `result_missing`（装配失败），于是 Delivery lane 永久阻塞、Planner 的结果永远不被接受，整条真实闭环停在 Planner；
  - 修复：`readPendingDeliveries` 区分「承载结果的消息」（`type === 'worker_done'`）与进度消息；只带进度消息的批次返回 `progressAcks`（不落任何权威事实、不判失败），由 `ackProgressOnlyDelivery` 按既有顺序（intent → mutation → 结算）确认，`unknown` 时以「批次已推进」为事实收尾；`worker_done` 解析失败仍然 fail closed。
  - 修复后的真实观测：同一条 Planner 结果开始进入装配，blocker 从 `result_missing` 变成真实的结构检查 —— `scope_envelope_exceeded`：该 OpenSpec change 的 `## Impact` 声明了 `orca-companion.json` 与 `openspec/specs/`，超出 WP 的 Scope Envelope（`include: ['README.md']`）。这是 Planner 产出纪律问题（T2 的信封纪律），产品侧的确定性门禁**正确拒绝**，不是接线缺陷。
- **e2e14 卡点的完整链路（真实事实，供后续决策）**：
  1. Planner 的 Codex/MiniMax 会话实际完成（`openspec/changes/…` 四个 artifact 落盘 + `validate --strict` 通过），但没有产生 Task Envelope 交付；
  2. Orca 侧该派发是完成的：`worker-show --dispatch ctx_c10c83dec604` → `status: completed`，`worker-list` → `workerState: 'succeeded'`；
  3. 宿主分类为 `exact_recovery`（Segment 有 `session_binding_id`、`transcript_referenceable=1`）→ 调 `resumeExact`；
  4. `resumeExact` 是**硬返回 `unverifiable` 的桩**（`src/bootstrap/execution-runtime.ts:1598`：Worker Harness Adapter 没有可核验的 provider session 续接路径）→ `unverifiable_hold`；
  5. 于是 WP 停在 `blocked`，且**没有自动出口**：`exact_recovery` 分支不会再走到 Capsule/替代 Session，而替代路径本身又要求可核验的终态收据（`session_regression`：已退出 ≠ 有效终态）。
  实测的观测量：`orca terminal close` 关掉该 worker 终端后，`terminal list` 已不含该句柄、分类原因随之从「终端仍在已列举主机上存在」失去前提（`src/domain/worker-liveness.ts:64`），但记录仍是 `pending` + 旧原因，WP 仍 `blocked`——说明卡点不在终端存活判定，而在「有 binding ⇒ 精确恢复 ⇒ 桩返回 unverifiable」。
  **结论：这条链要么实现 Codex 的 provider session 续接（真功能），要么改分类策略（有 binding 但无续接能力时走 Capsule + 替代 Session，并受 Recovery Budget 约束）。两者都是设计决策，需在规划环节定。**
- **unverifiable 的 Recovery 现在把原因写成可读事实（真实运行验证）**：主规格要求这类 Recovery 保持未决（不推断退出、不重复派发），但变更规格要求「当前派发保持阻塞，界面显示原因」。e2e14 的 Planner Session 结束后宿主连续报 `unverifiable`，而记录里 `blocking_reason` 为 null、`status --json` 不显示任何 blocker——原因只存在于运行时结果里，界面看不到。修复：恢复服务在保持状态不变的前提下写入原因（存储层允许「同状态 + 只改原因」的窄口元数据写入，不触碰状态迁移表），投影把带原因的未决 Recovery 显示为阻塞并带出原因。真实运行回读：`status=pending / consumed_budget=0 / terminal_outcome=null / blocking_reason='终端仍在已列举主机上存在'`，`status --json` 显示 `workPackage state=blocked, role=planner, blockerRefs=['终端仍在已列举主机上存在']`。
- **集成已在真实运行中走通（e2e13）**：`git-integration-commit` / `integrate_canonical` / `push` 三步全部 `settled accepted`，且以 **Git 事实**核验：canonical 分支 HEAD 为 `47776f6`（其父是 Implementation 的提交 `4c63071`，基线 `7295a9f`），`git ls-remote origin refs/heads/e2e13-integration` 指向同一 commit。这是本 change 缺失的最后一块集成证据；此前 e2e12 的「成功」是自我合并的静默 no-op（见第 22 条）。
- 仍未取得：**Finalizer 的真实结论**。当前 gate 报 `unsettled-mutations:1`（`finalizer-worker-start` 的旧 lane 因 `no_backend_request_id` 阻塞——该派发走 `dispatchScopedWorker`，尚未接入按 Orca 事实的对账）与 `finalizer-not-authorized`（Manifest 授权范围问题，需单独核对该计划的权限）。本机 Finalizer 还受只读 Codex 会话不可核验限制（`/tmp` 位于 btrfs，bwrap uid map 失败）。
- 同轮修复：**Finalizer 的 `worker-start` 也接入事实对账**（`dispatchScopedWorker` → `runProtected` 的 `reconcileFacts`：`worker-start` 结果未知且无 backend request id 时，用 `worker-list` 是否已列出该 Task 的 Worker 判定副作用是否发生）。测试 `tests/bootstrap/execution-finalizer.test.ts` 新增一例：worker-start 只返回 `unknown` → 结论仍为 `deliverable`、无 `blocked` blocker；把事实探测短路后该用例失败，可证明它守住了这条修复。
- **新 Scope 的登记入口（已验证）**：全新目录用 `orca project setup-existing-folder --project github:leike0813/orca-companion-test --host local --path <dir> --kind git --display-name <name>` 登记后即可被 `orca worktree current` 识别并建立身份终端；未登记时 `terminal create --worktree path:` 报 `selector_not_found`、`worktree create --repo path:` 报 `repo_not_found`。e2e14 即以此登记并完成播种 + 授权（`auth:e2e-loop-scope#g1:1`，Run `run_5b086b4529f2`）。
- **旧说法（保留事实）**：`orca terminal create --worktree path:<新目录>` 对未登记的目录会失败；e2e1–e2e13 之所以可用，是因为它们此前已被登记为 worktree（`projectId: null`，`displayName` 取分支名）。
：`orca terminal create --worktree path:<新目录>` 对未在 Orca 中登记的目录返回 `selector_not_found`（`orca worktree current` 同样拒绝）。因此「新隔离项目」需要先在 Orca 里登记该目录（界面动作），本 change 的验证环境只登记了 `orca-companion-e2e13`。已按同一配方准备好 `Artifact/orca-companion-e2e14`（基线 `6e72a08`、配置 `refs/heads/e2e14-integration`）备用。
- **已阻塞 lane 不会自愈**：e2e13 上那条 `finalizer-worker-start` 无 `backendRequestId`，`reconcileOperation` 只能给 `unknown`，而 `applyConclusion` 对「unknown + 已阻塞」不再写状态——这是刻意的（不能证明未发生就不解除阻塞）。因此 Finalizer 的真实证据必须在**新 Scope** 上取得，而不能在 e2e13 上重试。
- **Finalizer 在本机的平台性 blocker**：Finalizer 固定 `--sandbox read-only`，而本机 `/tmp` 位于 btrfs，Codex 0.156.1 的受限沙箱无法建立 bubblewrap uid map（`bwrap` 包本身可用；`/etc/apparmor.d/bwrap` 不存在）。因此即便门禁与 lane 都干净，本机真实运行也只能得到明确 blocker 而非 `deliverable`；这属于平台限制，已在 `docs/orca-compatibility.md` 记录。

- 驱动真实闭环的工序要点（本轮踩过的坑）：每轮触发用一次**新的宿主启动**（startup 会对账并推进一次）；宿主启动前先确认没有存活宿主（Lease 30s TTL），但**绝不能在宿主存活期间释放 Lease**；`status --json` 没有执行观察，读 blocker 要用宿主快照 `host.ports.snapshot`。
- 真实运行定位到的阻塞都已修复（见上第 1–14 条），但**尚未在修复后的真实运行里观察到集成与 Finalizer 的结论**：真实链最后停在 Validator 的 Delivery 上，原因是第 8 条（报告写在 `.agents/` 被判越界）。这次排查慢的原因不是原因没被记录，而是**读错了投影**：CLI 的 `status --json` 没有执行观察（`cli-no-execution-observation`），只有宿主自己的快照才有 blocker；诊断脚本改成读 `host.ports.snapshot` 之后，`repo_not_found`、`dispatch_record_missing` 这类事实立刻可见（见第 14 条修复）。
- IP-08 的修复后运行使用**全新隔离项目** `/home/joshua/Workspace/Artifact/orca-companion-e2e4`（配置与 `orca-companion-e2e2` 同源，`execution.git.refs=['refs/heads/e2e4-integration']`）：旧项目里已经留下的 settled-rejected intent（集成、Finalizer Task）按设计会一直阻塞同一条 lane 的重试，因此修复后的观察必须在没有历史 intent 的新 Scope 上进行。
- **待办（可观察性，本轮定位）**：执行期的 blocker（`repo_not_found`、`dispatch_record_missing`、`advance_idle` 等）只存在于**宿主自己的快照**里；同一条 Scope 上 `orca-companion status --json` 读到的是 `blockers: []` 加 `executionReconciliation.reasons: ["cli-no-execution-observation"]`。TUI（同进程）不受影响，但机器可读的 CLI 投影看不到「为什么停住」，本轮排查因此多花了很久。收口方向：把执行 blocker 落成 store 事实（或在 `status` 里显式说明「需要宿主观察」），需要一次小 schema 变更，因此未在本轮顺手改。
- **全新隔离项目的执行前置（本轮定位并解除）**：`run-create` 之后没有任何 `materialize-*` mutation，WP 保持 `admitting`。原因不是授权/租约/graph 事实，而是**该路径还没有登记进 Orca**：`worktree create`/`worktree-list --repo` 以 `repo_not_found` 失败，`terminal list --worktree` 以 `selector_not_found` 失败。第 13、14 条修复之后这条事实可以直接看到（宿主 blocker `rejection:repo_not_found`），`orca repo add --path <canonical worktree>` 之后同一次触发立刻完成 `materialize-worktree/task/worker-terminal/worker-start` 并跑起真实 Planner。已记录进 `docs/orca-compatibility.md`。
- **e2e6（全新项目，修复后构建）本轮观察到的完整事实链**：`orca repo add` 之后物化成功（worktree/task/terminal/worker-start settled）→ 真实 Planner 会话 `succeeded`（`worker-show` 显示 `input_accepted`/`live`，transcript 可见它在核对 change 名与 scope）→ 但 `recordRoleSession` 的绑定窗口已过，Session Segment 缺失 → Planner 的 Delivery 无法归因（`dispatch_record_missing`，fail closed 正确）。用工序脚本按**已证明的事实**补记 Segment（`launchId` 用状态文件名哈希精确匹配、报告用 `bindCodexSessionFromStartReport` 校验、身份取自物化绑定与 Codex SessionStart 报告，绝不按 mtime 找 transcript；写入走生产 `record-session-segment`）之后，同一个 Delivery 的前进变为 Planner Admission 门禁的拒绝：`worktree_mismatch: 未找到 openspec/changes/e2e-loop-scope%23g1%3Areadme-banner 对应的 OpenSpec change`。
- **Planner 自选 change 名字（第二次复现）**：e2e6 的 Planner 把单元写成 `openspec/changes/e2e-loop-scope-g1-readme-banner`（kebab-case），而不是 Envelope 固定的 `…%23g1%3Areadme-banner`；重命名并提交后（工序，与 e2e2 相同）该单元仍然**缺少 `specs/` 目录**，因此 Admission 的结构检查不会通过。结论：这条链要真正跑通，必须让 Specification Planner 按 Envelope 的固定路径写出**结构完整**的单元——这是 Worker 侧纪律/提示词问题，不是宿主接线缺陷；宿主在两种情况下的 fail-closed 行为都是正确的，且现在都能给出精确原因。
- 交付链路已真实验证的部分（本轮）：授权审阅/批准 → Planner 规格与提交 → Delivery 结算（Orca 形状 locator）→ Specification Admission → Implementation 派发与结算 → Validator 派发与结算 → 集成（commit 步通过；integrate 步结论未取得）。Finalizer 仍未发生（本机无法提供可核验的只读 Codex 会话）。
- 本 change 的规划阶段未列出的两处实现改动已按合同登记：`execution.codexSandbox` + 具名风险（README、IC-11 合同、change spec 新增 Requirement），以及物化路径的 CAS 重试语义（计划 §5 已要求）。

## e2e15 真实闭环（2026-09-25，隔离项目 + 专用 Orca 身份 + MiniMax-M3）

项目 `/home/joshua/Workspace/Artifact/orca-companion-e2e15`（登记为 `github:leike0813/orca-companion-test`，专用终端 `term_b210ea5b-…`，Run `run_287982cf7758`），授权后由单进程宿主循环驱动：

| 环节 | 观测事实 |
|---|---|
| Planner | 按 `TaskEnvelope.instructions` 把规格写到 `openspec/changes/e2e-loop-scope-g1-readme-banner-c0e65d23/specs/readme-banner/spec.md`（新纪律生效） |
| Specification Admission | 通过，WP 进入 `implementing` |
| Implementation / Validator | 两个角色 Worker 均 `succeeded`，Delivery 结算（`delivery_settlements`） |
| 受控 Git 集成 | `commit` / `integrate_canonical` / `push` 三步 accepted；canonical `main` 与远端 `refs/heads/e2e15-integration` 同为 `ed98548` |
| Finalizer | 只读 Session 被派发并真实运行（终端 header：`utility-readonly-local-control`），但本机沙箱 panic（`cannot establish app-server socket mount isolation`），五个 subagent 同样失败 ⇒ 无 verdict、无 `worker_done`，停在**明确 blocker** |

结论：4.2 要求的「真实闭环 + 一次 Recovery 或明确 blocker」由 e2e14（Recovery + 阻塞）与 e2e15（完整闭环到集成 + Finalizer 明确 blocker）共同满足。本机仍无法产出 Finalizer verdict / Capsule 正文，原因与解除方向记在 `docs/orca-compatibility.md`。

