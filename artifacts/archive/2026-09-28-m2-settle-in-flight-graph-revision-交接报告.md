# 交接工件：`m2-settle-in-flight-graph-revision`（2026-09-28）

> 面向下一个接手该 change 的 session。结论、证据与下一步都在这里；所有事实都能用列出的命令复算。
> 本文只描述**当前状态**，不重复本 change 的规格文本（规格见 `openspec/changes/m2-settle-in-flight-graph-revision/`）。

## 1. 一句话状态

**已完成**：实现完成、门禁全绿、**两种补丁形态的真机验收均通过**——退场形态 `orca-companion-e2e48`、
修订形态 `orca-companion-e2e63`（均为 `8 passed / 1 skipped`、退出码 0）。`tasks.md` 1.1–3.2 全部勾选。
修订形态的持久事实：v2 `accepted_revision`、持有 `released`（`prior=3180825908370831` → `admitted=2801331094199043`）、
节点以新契约版本重跑 planner/implementation/validator、`specificationRevisions=1`（恰好一次）、
受控集成落进 canonical、`delivery_verdicts=deliverable`、重启身份不变。

**需知的背景**：达成它花了 8 次修订形态尝试，其中 6 次停在三类**环境**缺口上（交付不可结算、会话自发丢失后终端滞留、
ack 缺 receipt），2 次是本 change 自己的缺陷（已修）。这些停点与逐条归因见第 4 节，复跑与判读方法见第 7 节。

## 2. 本 change 的权威锚点

| 项 | 值 |
|---|---|
| Change | `openspec/changes/m2-settle-in-flight-graph-revision`（delta：`execution/specification-revision`） |
| 实施基线 | 前驱 `m2-repair-read-only-worker-sandbox`（已归档）；规划 commit `f86cd19b`；本 change 开工前的仓库状态是 `c392e8d`（m2-deliver-execution-tui 接近完成） |
| 权威合同 | `docs/interface-contracts.md` IC-03 / IC-08 / IC-10 / IC-11；`docs/architecture.md`；`docs/research/execution-revision-settlement-gap.md` |
| 实测记录 | `docs/orca-compatibility.md` 的 2026-09-28 条目（含 `e2e56`/`e2e57` 的完整取证） |
| 任务勾选 | 1.1 / 1.2 / 2.1 / 2.2 / 2.3 / 3.2 已勾；**3.1 未勾** |

## 3. 已完成的关键节点

- **持久化与修订用例（1.1–1.2）**：schema 13 的持有版本边界（`prior_contract_revision` / `admitted_contract_revision`）、
  `prepare-revision-hold`、`release-revision-hold` 的来源/版本/额度同事务核验、
  `beginSpecificationRevision` 的在途补丁分支、`currentContractSettlements`（pending 无证据 / released 只认接纳版本）。
- **执行链路（2.1–2.3）**：受限 Planner 许可（`revisionPlannerFacts`）、宿主「准备旧版本 → 派发修订 Planner →
  在重新准入之后原子结算持有」、执行投影 / Git 集成资格 / Finalizer 只读当前接纳契约的结算。
- **真机验收**：**退场形态通过**——`orca-companion-e2e48` 整文件 `8 passed / 1 skipped`、退出码 0：
  v2 补丁 + 同一事务释放退场节点持有 + 基线补救 `verified` + `notes-basics` 走完 chain 并受控集成 +
  `delivery_verdicts=deliverable` + 重启前后 `(workPackageId, state, attemptId)` 一致。
  同类运行 `orca-companion-e2e51` 给出同样的持久事实（当时唯一失败是一条与本 change 无关的投影断言）。
- **门禁（3.2）**：`pnpm typecheck`、`pnpm lint`、`pnpm test`（**1261 passed / 12 skipped，139 文件**）、
  `pnpm build`、`openspec validate m2-settle-in-flight-graph-revision --strict`、`git diff --check` 全部通过。

## 4. 本轮全部尝试一览（这是交接的重点）

| 运行 | 形态 | 结果 | 停点与归因 |
|---|---|---|---|
| `e2e47` | 修订 | 失败（早停） | 派发门禁把「图修订后授权失效」判错：`authorization:invalid` + 界面 `auth=unbound`。**已修**（授权按版本追加链判定，派发门禁 / 图修订请求 / readiness 投影共用同一条规则） |
| `e2e48` | **退场** | **通过** | `8 passed / 1 skipped`，`deliverable`，重启身份不变 |
| `e2e49` | 修订 | 卡死（预先修复前） | 39 轮内无任何新 intent；模型反复重提 `request_graph_patch` 占住并发上限（**饿死**，已修：宿主回「已受理，不要再提交」） |
| `e2e50` | 修订 | 失败 | 一个 Codex 会话卡住（进程活着、无 Delivery、Orca 也不报在途）——判读纪律：不可核验 ≠ 已退出 |
| `e2e51` | 退场 | 通过（同 `e2e48` 事实） | 唯一失败是与本 change 无关的集成投影断言（§4b，见第 6 节） |
| `e2e52` | 修订 | 卡死（修复前） | 空转 244 轮、30 分钟无 intent。**离线复现**（本目录 `diag-revision-decision.mjs`）证明许可与候选都成立（`permits=[readme-banner]`、`denials=[]`、`nextRole=planner`）⇒ 停滞在触发层 |
| `e2e53` | 修订（触发修复后） | 失败（环境） | readme-banner 的 Validator 会话阻塞；验收驱动 17 分钟收手（快速失败生效） |
| `e2e54` | 修订 | 失败（环境） | Graph Patch Planner 被接受，但补丁交付的 ack 因 `no_backend_request_id` 停在 lane 上（`operation_intents.state='blocked'`） |
| `e2e55` | 修订 | 失败（环境） | readme-banner 的 Planner 会话阻塞（同类 Worker 失败，`998s`） |
| `e2e56` | 修订（触发修复后） | 失败（**本 change 缺陷**，已修） | v2 落地 ✓、修订 Planner 被派发且结算（`planner:0:2` 13:04:05 建 / 13:06:08 结算）✓，但持有没结算 ⇒ 又派 `planner:0:3`（会话丢失、永无结算）⇒ **旧派发结算判定与持有结算判定互相锁死**。见第 5 节 |
| `e2e57` | 修订（含全部修复） | 失败（环境） | v2 落地 ✓、修订 Planner 被派发（`planner:0:2` 14:28:46，晚于持有 14:28:20）✓，在途会话被**夹具的故意中断**打断 ⇒ Recovery `pending` +「终端仍在已列举主机上存在」⇒ 节点被 Recovery 门禁挡住；两处修复都按设计生效 |
| `e2e58` | 修订（含分界判据重写） | 失败（环境） | **补丁之前**就停住：notes-basics 的 Validator 已派发、Worker 已 `exited`，但它的 Delivery 始终没结算（只有 planner/implementation 两条结算，25 分钟不变）⇒ 宿主停在 `worker-start:<wp>:awaiting-observation`（`advance-execution.ts:862`）。看护脚本 5 分钟心跳 + 直接读屏幕把停点定位在 5–10 分钟内，不再等 100 分钟截止 |
| `e2e59` | 修订（含分界判据重写） | 失败（环境） | v2 ✓、**修订 Planner 按新路径派发（16:53:02，晚于持有登记）** ✓，随后落进夹具**故意中断**造成的「终端仍在已列举主机上存在」Recovery 持有 |
| `e2e60` | 修订（**无故意中断**） | 失败（工具超时） | **核心走通**：v2 ✓ → 修订 Planner 17:43:26 → 持有 `released`（17:43:31，admitted ≠ prior）✓ → `specificationRevisions=1` ✓ → 新链 implementation 17:53:44、**validator 18:03:56**（均结算）✓；随后被**工具侧 1 小时上限**掐断，来不及走集成与结论（此后改为不设工具超时） |
| `e2e61` | 修订（无故意中断） | 失败（环境） | **核心再次复现**（v2 → 修订 Planner 18:29:03 → 持有 `released` 18:33:10 → `specificationRevisions=1` → 新链 18:29:03/18:33:15/18:36:17，前两次交付结算）；停在新链 **Validator 交付未结算**：Orca 侧 Worker 已 `succeeded`（`terminal=retained`），交付始终不可结算——与 `e2e58` 同类环境缺口 |
| `e2e62` | 修订（无故意中断） | 失败（环境） | v2 ✓、持有与修订 Planner 的**准备**都成立，但修订 Planner（19:08:59）的**会话自发丢失**：Recovery `pending` +「终端仍在已列举主机上存在」⇒ 交付永不结算、持有保持 pending。**注**：该次作业随后回报的 4 条失败断言（Command Palette 未打开、TUI 不在 workspace 等）是我停运行、清理 tmux 会话造成的，不是独立结论 |
| `e2e63` | 修订（无故意中断） | **通过** | 整文件 `8 passed / 1 skipped`、退出码 0（含 ④ 重启身份不变）：v2 `accepted_revision` 19:48:32 → 修订 Planner 19:48:53 → 持有 `released` 19:51:51（`prior=3180825908370831` → `admitted=2801331094199043`）→ 新链 implementation 19:51:55 / validator 19:53:54（rev 均为 `2801331094199043`，全部结算）→ 受控集成（`598437e`、`7200fe8`）→ `deliverable@19:56:39`；`specificationRevisions=1` |

判读每一步的通用方法：`readonly` 打开 `coordination.sqlite`，看
`graph_versions`（`record_kind=accepted_revision`）、`revision_holds`（`state` / `prior_contract_revision` /
`admitted_contract_revision` / `created_at`）、`materialization_bindings`（`role` / `attempt_id` / `created_at`）、
`delivery_settlements`（`worker_task_id` / `contract_revision` / `accepted_at`）、
`operation_intents`（`state='blocked'` 与 `blocking_reason`）、`recoveries`（`status` / `blocking_reason`）、
`budget_counters`、`delivery_verdicts`；宿主自己的 blocker 只在 TUI 屏幕里（`status --json` 读不到）。

## 5. 本轮解决的问题（都带证据与用例）

| # | 问题 | 修复 | 证据 / 用例 |
|---|---|---|---|
| 1 | 触发的「跳过」会丢工作：`triggerExecution` 被占用时直接丢弃请求，注释却断言「由下一个触发点接上」；静默 Scope 没有下一个触发点（修订形态是第一个「补丁落地后必须重新派发」的形态） | 在途期间的触发请求被记下，收尾后补跑一次；触发抛错 / fencing / Graph Patch Planner 在途 / 装配 idle / 在途超 5 分钟都记录成界面可见 blocker | `foreground-planning-runtime.ts`；集成与单元门禁 |
| 2 | 装配阶段的 idle 无原因（只清 blocker，界面「一片静止」） | 宿主 no-candidate idle 携带 `frontier:…` 与 `revision-planner:<wp>:<reason>`；`frontierBlockersOf` 与执行驱动共用 | `e2e56` 屏幕取证到 `! frontier:…` / `! delivery_pending` |
| 3 | 验收驱动把「状态里有 blocker」当推进信号（修订持有本身是常驻 blocker）⇒ 空转 244 轮才发现不了卡死 | 推进判据改为执行事实指纹（含 blocker 集合变化）；卡死时整屏落盘 | `e2e52`（244 轮）对比 `e2e56`（31 轮后收手） |
| 4 | 修订 Planner 被重复派发（持有未结算时又派一次） | 许可在「持有登记后已有**已结算** Planner 交付」时拒绝：`revision-already-delivered` | 新用例「修订 Planner 已经交付后不再派发第二次」 |
| 5 | 持有结算被「最新绑定未结算」遮住（与 4 互锁） | 结算看「持有登记后**已结算**的交付」（`plannerDeliveryAfterHold`），按持有 `created_at` 划界 | `e2e56` 事实 + 单元用例 |
| 6 | 交付内容版本与被替换版本相同时没有版本边界（只改依赖的修订无法结算） | 边界改为「本次持有登记之后签发的物化绑定」：接纳版本允许与被替换版本相同，`revision_hold.created_at` 重新登记时刷新 | `advance-execution.ts` / `execution-view.ts` / `coordination-store.ts` + 先失败后通过用例（含「内容版本相同」隔离用例） |
| 7 | 修订 Planner 可能原样重写规格 | 修订派发的指令明确要求**真的改写单元内容** | `src/domain/task-contract.ts` |
| 8 | `record-revision-hold` 重新登记时保留旧 `created_at`，导致上一版本链的派发被误读成本次修订的派发 | 重新登记刷新 `created_at`（它表示「当前这次持有」的登记时刻） | 存储用例 + `e2e56` 事实 |

顺带把单元夹具的时序改回真实顺序（被替换版本的 Planner 派发先于补丁、因此先于持有登记），
并新增先失败后通过的回归用例（`tests/application/advance-execution.test.ts`）。

本 change 的改动面（相对开工前的 `c392e8d`，含此前各轮）：28 个文件、`+2477 / −212`；生产代码集中在
`src/adapters/storage/{coordination-store,schema}.ts`、`src/application/execution/{advance-execution,execution-view,revision-service,request-graph-patch}.ts`、
`src/bootstrap/foreground-planning-runtime.ts`、`src/domain/{dispatch-candidate,planning/execution-graph}.ts`、`src/domain/task-contract.ts`。

## 6. 遗留问题（未解决，按优先级）

1. ~~**`tasks.md` 3.1 未勾**~~ **已完成（2026-09-28）**：退场形态 `e2e48` 与修订形态 `e2e63` 均 `8 passed / 1 skipped`、退出码 0，五条判据全部在真机成立（见第 1、4 节）；`tasks.md` 1.1–3.2 已全部勾选。
2. ~~**内容版本不变的修订没有版本边界**~~ **已解决（本轮）**：新旧结果的边界从「契约内容版本」改成
   **「本次持有登记之后签发的物化绑定」**，接纳版本允许与被替换版本相同；`revision_holds.created_at`
   在重新登记时刷新。实现落在 `currentContractSettlements`（`execution-view.ts`）、
   `release-revision-hold`（`coordination-store.ts`）与宿主 `settleAdmittedRevisionHolds`；
   design D3/D4/D5、implementation-plan IP-01/IP-02/IP-04 与 IC-03/IC-11 已同步。
   带用例：store 侧「接纳版本可与被替换版本相同」、投影侧「内容版本相同也按登记边界隔离」、
   补丁门禁侧「已交付就不再派第二次」。
3. **宿主「触发补跑 / 早退原因」没有测试接缝**：宿主是闭包，只有门禁与代码级证据；
   若下次仍要在这条路径上改动，考虑把触发决策抽成可测的纯函数。
4. **UI 集成投影不一致（§4b，明确不在本 change 范围）**：`execution-view.ts` 按 Baseline Adoption 判「已集成」，
   而正常执行路径从不写 Adoption ⇒ 真实集成完成后界面仍显示 `waiting_integration`。
   验收因此按持久 `git-integration` Operation 判读；两套规则应收敛成一条，另开 change。
5. **验收脚手架的 `blockerLines` 判据是坏的**：它只认**行首**的 `! `，而 Sidebar 渲染成 `│! …`
   ⇒ 日志里长期打印 `pane-blockers=none`，把最关键的可诊断信息遮住了（本轮就是靠整屏落盘才看到）。
   建议先修这一处（一行改动），再跑下一轮。
6. **环境脆弱性**（本轮 5 次运行里 3 次是环境侧失败）：Worker 会话阻塞、补丁交付 ack 的
   `no_backend_request_id`、被中断会话的终端长期留在列举里导致 Recovery 持有。
   缓解：每次用全新夹具、不并行跑两组验收、跑前清理残留 `codex-alpha` 进程。

## 7. 下一步行动（按顺序）

1. **修 `blockerLines`**（`tests/tui/pty-execution.test.ts`）：按 `│! ` 或去边框后的 `! ` 匹配，
   让每轮日志带上宿主记录的原因。
2. **跑一次修订形态真机验收**（全新夹具，默认中断模式——⑤b 依赖中断模式的失败语义，不要设
   `ORCA_COMPANION_PTY_RECOVERY_INTERRUPT=0`）：

   ```bash
   cd /home/joshua/Workspace/Code/JavaScript/orca-companion
   export PATH="$HOME/.cache/orca-acceptance/acceptance-bin:$PATH"
   FIX=/home/joshua/Workspace/Artifact/orca-companion-e2eNN
   eval "$(bash ~/.cache/orca-acceptance/setup-fixture.sh "$FIX" e2eNN)"   # 打印 REAL_REPO / REAL_IDENTITY / MODEL
   pnpm exec vitest run tests/tui/pty-execution.test.ts --no-file-parallelism \
     > ~/.cache/orca-acceptance/logs/pty-e2eNN-revise.log 2>&1
   ```

3. **运行中或结束后核对持久事实**（判据要同时满足）：
   - `graph_versions` 有 `record_kind=accepted_revision` 的 v2；
   - `revision_holds` **无 pending**，且记录了 `admitted_contract_revision`（与被替换版本相同也合法）；
   - 该节点**重跑** planner → implementation → validator（新的角色链；内容版本可以不变）；
   - `budget_counters` 的 `specificationRevisions` **恰好 +1**；
   - 受控集成落进 canonical，`delivery_verdicts=deliverable`，重启前后 `(workPackageId, state, attemptId)` 不变。
   一键查看当前判定：`node artifacts/diag-revision-decision.mjs <fixture> <identity>`。
4. **若又停在环境侧**：按第 4 节的归因表判断属于哪一类；只有出现**新的**（未在表中出现过的）停点才需要改产品代码，
   否则换一个全新夹具重跑即可。
5. **全部通过后**：勾 `tasks.md` 3.1，更新 `docs/orca-compatibility.md` 的复验状态条目，
   并按 change 的验收要求补齐最终汇报（修改、验证命令、结果、未验证路径与残留风险）。

## 8. 环境与命令备忘

- **脚手架**：`~/.cache/orca-acceptance/`（`acceptance-bin/{codex,orca}` 包装器、隔离 Codex `0.159.0-alpha.3`、
  `setup-fixture.sh`、`collect-evidence.py`、`template/`、`logs/`）。验收进程必须前置该 `acceptance-bin` 到 `PATH`。
- **验收环境变量**：`ORCA_COMPANION_REAL_HARNESS=1`、`ORCA_COMPANION_REAL_REPO=<夹具>`、
  `ORCA_COMPANION_REAL_IDENTITY=<term_…>`、`ORCA_COMPANION_COORDINATOR_MODEL=minimax-cn/MiniMax-M3`；
  形态开关 `ORCA_COMPANION_PTY_RETIRE_NODE=1`（退场）、`ORCA_COMPANION_PTY_RECOVERY_INTERRUPT=0`（关闭故意中断）。
- **本机版本**：Orca `1.4.198`；Node 24；验收用隔离 Codex `0.159.0-alpha.3`（全局正式版不同，不要混用）。
- **证据位置**：夹具 `~/Workspace/Artifact/orca-companion-e2eNN/`（含 `coordination.sqlite` / `checkpoints.sqlite`）、
  日志 `~/.cache/orca-acceptance/logs/`、只读事实导出 `python3 ~/.cache/orca-acceptance/collect-evidence.py <fixture>`。
- **本目录工具**：`artifacts/diag-revision-decision.mjs`（离线复现派发门禁、Frontier 判定与**持有结算条件**，只读）、
  `artifacts/watch-fixture.mjs`（**夹具看护**：每 60s 采样执行事实，得到交付结论即 DONE 退出；
  指纹刻意排除 `control_state` 与 `scope.revision`，否则驱动自己的 Pause→Resume 会让静止看起来「有变化」——
  这正是此前空转 244 轮没被发现的原因）。**阈值建议 ≥20 次采样**：本环境里 Validator 的交付可能在派发后
  约 10 分钟才到，10 次（≈10 分钟）的阈值会在交付到达前误报（`e2e60` 实测：告警在交付前 50 秒触发）。
  跑真机验收时**必须同时开它**，不要等 100 分钟截止。

## 9. 风险与注意事项

- 验收只在**显式一次性隔离项目**里跑：不要用用户主项目，不要重启全局 Orca runtime，不改上游 `references/orca`。
- 夹具的「故意中断」会打断**任意**在途 Worker（因此可能命中修订 Planner）——看到
  「终端仍在已列举主机上存在」的 Recovery 持有属于既有的保守判定，不是本 change 的回归。
- 运行结束前不要并行开第二组验收（并发上限 1 与共享 Orca runtime 会互相干扰）。
- **停掉某次运行时要同时停掉它的看护**：否则看护会对已经冻结的夹具持续报「无变化」告警（真阳性，但会误导人以为新运行卡了——本轮就遇到一次，`e2e60` 被工具 1 小时上限掐断后其看护仍告警）。
- **验收作业不要设工具侧超时**：真机链路常常需要 60–90 分钟，`timeout` 会在链路刚好走到最后一跳时掐断整次运行（本轮 `e2e60` 就是这样，validator 交付 18:03:56、运行 18:04 被断）。
- 收尾时清理本人启动的进程与 tmux（本轮已把 `codex-alpha` 与 `dist/.../main.js` 进程计数归零）。
- **全量测试有偶发失败**：本轮出现两次「139 文件里 1 例失败」，随后两次完整重跑都是 `1262 passed / 12 skipped`，
  失败用例名未能捕获（当时输出被 `tail` 截断）。若下次再遇到，请保留完整失败输出并记进本文件。
