# Verification

## 验收对象

- Change：`m2-deliver-execution-tui`
- 实现 HEAD：`bd7a1c9`，含本轮未提交的工作区改动（本轮的生产修复与验收脚手架改动都还在未提交工作区里）
- 验收 Agent：Codex（本机真实 PTY + 真实 MiniMax 会话）
- 环境：隔离 Codex `0.159.0-alpha.3`（包装器只把专用 PATH 前置）；隔离 Git 项目与专用 Orca 身份；模型 `minimax-cn/MiniMax-M3.1-Flash-Preview`（2026-09-29 起，此前的真实验收用 `minimax-cn/MiniMax-M3`）
- 验收脚手架：`~/.cache/orca-acceptance/`（`codex-alpha/` 固定版本、`acceptance-bin/{codex,orca}` 包装器、`setup-fixture.sh` 建夹具与专用身份、`collect-evidence.py` 只读导出结论事实、`template/` 夹具基线、`evidence/`、`logs/`）

## 结论

**PASS（2026-09-29）**。5.1–5.4 全部完成；两次真实 PTY 运行各用全新隔离项目与专用身份，都是整文件通过：

| 运行 | 模式与覆盖 | 结果 |
| --- | --- | --- |
| `orca-companion-e2e68`（身份 `term_0ec155d7-…`） | 不中断：授权 → 串行 Frontier → 受控集成 → 基线补救 → 图修订 → 只读 Finalizer → 退出重启（5.2） | **8 passed / 1 skipped，1063.93s，exit 0** |
| `orca-companion-e2e73`（身份 `term_550fb3e8-…`） | 制造一次执行态中断：真实终端关闭 → Recovery → 同一 Attempt 内续办 → 图修订 → deliverable（5.3） | **8 passed / 1 skipped，1191.84s，exit 0** |

同一条链路另有两次独立复现：`orca-companion-e2e66`（同代码、`minimax-cn/MiniMax-M3`，只有逐角色模型证据的读取方式失败，已修）与 `orca-companion-e2e71`（中断模式，Recovery `recovered` + 补丁 v2 + `deliverable`，只有集成提交的作者断言失败，已按实测修正）。跳过的一例是「重启先显示 reconciling」画面场景：真实闭环里每个阶段都会收尾，重启时不存在可控的在途操作（`test.skip` 注明理由）。

## 5.2 的真实证据（`e2e68`，持久事实）

| 事实 | 证据 |
| --- | --- |
| 授权与串行 Frontier | Palette 内完成授权；两个 Work Package 由 Pause/Resume 单步驱动，任一时刻只有一个 active（`concurrencyLimit: 1`） |
| Baseline Reconciliation 同链路 | `e2e-loop-scope#g1:readme-banner` 记录 `verified`，`required = observed = bf65e381505a168608e1e200cf8b0fc1412cf959`，真实 Task `task_277e73315c74` / Dispatch `ctx_a1a3b282039a` |
| Graph Patch Planner 同链路 | 经 composer 提交含糊变化声明后，真实 Planner 起草的补丁经确定性 Admission 通过并追加 **GraphVersion v2（`record_kind = accepted_revision`，`patch_id` 非空）** |
| 修订持有不悬挂 | `revision_holds` 的 `readme-banner` 为 `released`，`prior = admitted = 4184746455182204`（只改契约、内容版本不变，仍按持有登记时刻隔离旧结果） |
| 预算 | `graphRevisions = 1`、`specificationRevisions = 1`（各自恰好一次） |
| 最终交付结论 | `delivery_verdicts` 的 `verdict_kind = deliverable` |
| 受控集成落盘 | canonical `53aec539e204ec22d7715385de76c45ee1eb324f`；与获批 remote/ref（`refs/heads/e2e68-integration`）相等 |
| 重启对账不重复派发 | 退出重启后读回同一批 `(workPackageId, state, attemptId)`，Dispatch 集合不变，无新集成 |
| 逐角色模型 | planner / implementation / validator / Graph Patch Planner / 基线补救 Planner / 只读 Finalizer 的 rollout 都记录 `minimax-cn/MiniMax-M3.1-Flash-Preview`（唯一来源是项目配置 `execution.workerModel`，不是配置回显） |

## 5.3 的真实证据（`e2e73`）

| 事实 | 证据 |
| --- | --- |
| 真实执行态中断 | 验收经生产 transport 关闭 Implementation Worker 的终端；Orca 侧该 Dispatch 转为已退出 |
| Recovery 被真实续办 | `recoveries` 只有一条：`role = implementation`、`status = recovered`、`terminal_outcome = replaced`，绑定真实 Capsule 与替代 Session Segment；替代 Session 在原 Attempt 内继续 |
| 界面如实可见 | Sidebar 的 `recovery` 分区渲染该角色与状态、替代 segment 身份；状态行给出 `active` 计数与 recovery 计数 |
| 同一次运行继续收口 | 图修订 v2（`accepted_revision`）、持有 `released`（`prior = admitted = 4206450962947008`）、`specificationRevisions = 1`、`delivery_verdicts = deliverable`；canonical `661cf42d2fc083719e272c56533388255edfd426` 与获批 remote/ref（`refs/heads/e2e73-integration`）相等 |

## 本轮定位并修复的问题

| # | 问题 | 影响 | 修复与证据 |
| --- | --- | --- | --- |
| 1 | **在同一在途节点上被接受的第二次修订会重新登记持有，但不刷新登记时刻**：`record-revision-hold` 刷新 `created_at`，而图版本事务里那份同源 upsert 不刷新 | 新的修订被读成「这次修订的 Planner 已经交付」：派发门禁以 `revision-already-delivered` 拒绝续办，持有结算又因内容版本未准备而跳过，Scope 永久停在 `revision_pending`（`orca-companion-e2e64`：持有 `created_at` 停在 v2 时刻 `1790608234057`，而 `source_ref` 已是 v3、v3 的 `recorded_at` 是 `1790608471275`） | 两处写入合并为一个登记函数（`src/adapters/storage/coordination-store.ts` 的 `placeRevisionHold`），重新登记一律刷新 `created_at`；`tests/coordination-store.test.ts`「图版本重新登记持有会刷新登记时刻…」修复前 `expected 5000 to be 9000`、修复后通过。契约同步：`docs/interface-contracts.md` IC-03 |
| 2 | **验收声明的措辞让模型无法收尾**：「除这一次工具调用外不要做其它事」使这条用户消息永远留在待处理工作里（工作项由「没有 tool call 的 assistant 响应」消费），模型每次被唤醒都重提同一份声明 | 同一份声明被反复送达 Graph Patch Planner：`e2e64` 追加了两个 GraphVersion、`e2e65` 同样两次，把该 Work Package 的实现尝试额度（2 次）耗尽，链路停在 `budget_exhausted`、拿不到交付结论 | 声明改为「被拒绝或结果未知就再试（有界），被受理才收尾」；`tests/tui/pty-execution.test.ts` 的 `graphChangeInstruction` 记录了两次运行的定因 |
| 3 | **逐角色模型证据读的是会话首行指令正文里的「powered by <模型>」** | 同一版本 Codex 有的会话不再生成那句话（`e2e66` 的 11 份 rollout 全都没有），断言因此读到「没有真实会话记录」这一假结论，真实链路被判失败 | 改为从 rollout 的 `"model":"…"` 字段取**实际用于请求的模型 id**，并与项目配置的 `execution.workerModel` 逐角色比对（允许带/不带 provider 前缀） |
| 4 | **集成证据断言写成了「canonical 的提交主题里必须含 Work Package id」** | 宿主只在 worktree 有未提交内容时才创建自己的集成 commit；Worker 已自行提交时 `merge --ff-only` 直接采用 Worker 的提交（`e2e71`：三步集成全部 settled/accepted，canonical 主题是 Worker 自己写的），断言把正确行为判成失败 | 改为核对**成果落进 canonical**：`git ls-tree -r --name-only HEAD` 必须含该 Work Package 计划内的文件（计划用 Scope Envelope 声明） |
| 5 | 全量测试偶发失败：`tests/doctor.test.ts` 的「构建产物在无 TTY 的管道中可运行」在满负载下超过 vitest 默认 5 秒超时 | 常规门禁 `pnpm test` 偶发 1 例失败，结论不稳定 | 该例显式声明 60 秒超时（它真的启动构建产物做能力探测，含 Orca 往返），`spawnSync` 也带同样上限 |

验收脚手架同轮修掉的两处判据问题（不影响产品）：

- **中断模式下不再要求「补丁必须落地」**：声明只有在 canonical 前移、目标节点仍未被接受时才提得出来，而请求本身要求 Run 静止与没有未确认 Delivery；制造中断会缩短这条链路，`e2e69`（Recovery 续办成功、`deliverable`）与 `e2e70`（Recovery 保守持有、无结论）都只提交了声明而被拒绝（`worker_in_flight` / `delivery_pending`）。图修订与 Baseline Reconciliation 的同链路证据因此取不中断模式（5.2），中断模式只验收 Recovery 与界面事实（5.3）。
- **「没有结论」必须由可诊断的 blocker 解释，而不只是只读能力缺口**：只读沙箱修好之后，中断模式下的 Recovery 保守持有、Worker 会话不再产生结果同样是真实的环境阻塞；判据改为屏幕上必须出现 blocker 行并点名原因（宿主 blocker 只在屏幕里，`status --json` 读不到）。

## 常规门禁

`pnpm typecheck && pnpm lint && pnpm build && openspec validate m2-deliver-execution-tui --strict && pnpm test && git diff --check`，串行、无并行负载，**exit 0**：

- `pnpm test`：**139 files passed / 6 skipped（145）；1263 passed / 12 skipped（1275）**，82.17s。
- `openspec validate m2-deliver-execution-tui --strict`：`Change 'm2-deliver-execution-tui' is valid`。
- `pnpm typecheck` / `pnpm lint` / `pnpm build` / `git diff --check`：无错误。
- 与真实 PTY 验收并行跑全量测试会出现 5 秒超时噪声（本仓库既有记录），因此结论只取独立串行运行。

## 覆盖率与残余风险

- **未覆盖**：需要可控在途操作才能进入的「重启先显示 reconciling」画面场景（`test.skip` 注明理由）；Windows、无人值守与远程 attach 不在本次结论内。
- **一条用户消息如果无法用散文收尾，会被反复重提**（本轮实测，见问题 2）：模型对该消息只回 tool call 时，工作项不消费，宿主会在同一次模型循环里再次唤醒它。产品侧由预算封顶（不会无限追加图版本），但会白耗该 Work Package 的实现尝试额度。判据与修法记录在 `tests/tui/pty-execution.test.ts` 的 `graphChangeInstruction`；真正要收敛需要改「工作项何时算被回答」的规则，属 `coordinator/wake-suspension` 的独立变更。
- **UI 集成投影与持久事实不一致（§4b，明确不在本 change 范围）**：`execution-view.ts` 按 Baseline Adoption 判「已集成」，而正常执行路径从不写 Adoption，于是集成完成后 Sidebar 仍显示 `waiting_integration`。验收按持久 `git-integration` Operation 判读。
- **环境脆弱性**：本轮 10 次真实运行里有 5 次停在环境侧（Validator/Planner 会话整轮不再产生结果、被中断会话的终端长期留在列举里、补丁请求撞上 `worker_in_flight`/`delivery_pending`）。缓解办法是每次用全新夹具、跑前清理残留 `codex-alpha` 进程、不并行跑第二组验收，并同时开 `artifacts/watch-fixture.mjs` 看护。
- **验收脚手架缺陷**：`setup-fixture.sh` 与 PTY 用例此前把模型钉在 `minimax-cn/MiniMax-M3`，本轮统一改为 `minimax-cn/MiniMax-M3.1-Flash-Preview`（含 `tests/integration/foreground-execution-runtime.test.ts`、`tests/execution/acceptance/real-patch-planner.test.ts`、`tests/recovery/acceptance/real-validator-partial.test.ts`、`tests/m0-isolated-probe.integration.test.ts` 等真实会话用例的模型声明）；provider 侧的模型名不带 `minimax-cn/` 前缀，前缀是 Codex 的 `provider/model` 写法。
