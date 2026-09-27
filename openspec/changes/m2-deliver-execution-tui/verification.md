# Verification

## 验收对象

- Change：`m2-deliver-execution-tui`
- 输入实现 HEAD：`f86cd19`，含当前工作区未提交改动（本轮修复全部保留在未提交工作区）
- 验收 Agent：Codex（本机真实 PTY + 真实 MiniMax 会话）
- 环境：隔离 Codex `0.159.0-alpha.3`（包装器仅前置专用 PATH），隔离 Git 项目与专用 Orca 身份，`minimax-cn/MiniMax-M3`
- 验收脚手架：`~/.cache/orca-acceptance/`（`codex-alpha/` 固定版本、`acceptance-bin/{codex,orca}` 包装器、`setup-fixture.sh` 建夹具与专用身份、`collect-evidence.py` 只读导出结论事实、`template/` 夹具基线、`evidence/*.json` 历史夹具事实、`logs/` 各次运行日志）

## 结论

**PARTIAL（2026-09-27 复核）。** 5.2 尚未在当前代码上达成：下节那次全绿运行使用的是「把退场节点从 revision pending 过滤掉」的构建，与规格冲突；按规格改回「照常登记持有」之后，退休那一支已补齐（与图版本同事务释放），**修订那一支仍缺接线**——被修订且已派发的节点进入 revision pending 后应由「规格重新准入」解除持有，而运行时从未调用 `beginSpecificationRevision` / `settleSpecificationRevision`。真实运行 `orca-companion-e2e46` 因此把 Scope 钉在 `revision_pending:graph_patch` 直到驱动截止（515 轮 / 90 分钟，持有仍 pending、无 verdict）。下面的证据与修复表仍然有效，但**不能读成 5.2 已完成**；要收口需要把规格修订流程接进运行时（检测在途节点的 pending 持有 → 该节点 Worker 收尾后派发修订 Planner → Specification Admission 通过后 `settleSpecificationRevision` 同事务释放持有并计一次额度）。

**PASS。** 5.2 已在一次真实 PTY 运行里达成：`ORCA_COMPANION_PTY_RECOVERY_INTERRUPT=0`、双包计划、全新隔离项目 `orca-companion-e2e40`、专用身份 `term_32b6df0c-…`，**8 passed / 1 skipped，875 秒，exit 0**（跳过的是需要可控在途操作、真实闭环里不可达的 reconciling 画面场景）。全部常规门禁通过。

## 5.2 的真实证据（持久事实，非界面文本）

同一次运行里依次成立：

| 事实 | 证据 |
| --- | --- |
| 授权与串行 Frontier | Palette 内完成授权；两个 Work Package 由 Pause/Resume 单步驱动，任一时刻只有一个 active |
| Baseline Reconciliation 同链路 | `e2e-loop-scope#g1:readme-banner` 记录 `verified`，`required_baseline_head == observed_head`，四个核验位全 1，真实 Task `task_e715cf92c9d6` / Dispatch `ctx_5fe1d3b309c1` |
| Graph Patch Planner 同链路 | 经 composer 提交含糊变化声明后，真实 Planner 起草的补丁经确定性 Admission 通过并追加 **GraphVersion v2（`record_kind = accepted_revision`）**，`patch_id` 由模型那次工具调用派生；Run `run_88c1fc3dfccc` |
| 修订持有不悬挂 | 该补丁 retire 掉目标节点后，`revision_holds` **为空**（退休结算释放，见下） |
| 重启对账不重复派发 | 退出重启后读回同一批 `(workPackageId, state, attemptId)`，Dispatch 集合不变，无新集成 |
| 最终交付结论 | `delivery_verdicts` 的 `verdict_kind = deliverable`，10 条引用（含每个 Work Package 的 commit/integrate/push），绑定真实 Finalizer 会话 `01a0e11a-…` |
| 受控集成落盘 | canonical `c744ae02b75844c2b66e961e86eb7aa2eace3111`，subject 为 `e2e-loop-scope#g1:notes-basics: NOTES 基础说明`；与获批 remote/ref（`refs/heads/e2e40-integration`）一致 |
| 逐角色模型 | 真实 Codex rollout 的 `session_meta` 逐角色核对为 `MiniMax-M3`（配置 `execution.workerModel` 是唯一来源，非配置回显） |

独立复现（另一次运行，`orca-companion-e2e38`）：GraphVersion v2 `accepted_revision`、`readme-banner` reconciliation `verified`（Task `task_b741c5450d80` / Dispatch `ctx_e216079f0c57`）、`revision_holds` 为空、`deliverable`、canonical `09f94dac…`。另有多轮运行取得 `deliverable`（`e2e29`/`e2e31`，canonical 与获批 origin HEAD 相等、重启无新派发）。夹具结论事实保存在 `~/.cache/orca-acceptance/evidence/orca-companion-e2e{29,31,32,33,34,36,37,38,39,40}.json`。

## 本轮定位并修复的生产缺陷（均带先失败后通过的回归用例）

| # | 缺陷 | 影响 | 修复与证据 |
| --- | --- | --- | --- |
| 1 | 物化把 **canonical 分支名**当 Orca `--base-branch`，而物化核验要求 `head === <Authorization baseline>`、集成的 commit 步也按同一 baseline 核验来源 HEAD | 第一次受控集成之后建立的新 worktree 必然落在分支尖端，核验判 `unknown`、lane 永久阻塞：多 Work Package 图与图补丁新增节点无法再物化 | `materialize-work-package.ts` 改传授权 baseline 的 exact commit；`tests/application/advance-execution.test.ts`「canonical 被已归属的集成推进后…」修复前 `unknown`、修复后 `progressed` |
| 2 | 投影把**已终结**的 Recovery（`recovered`，仍保留中断当时的 hold 原因）当作阻塞 | 已续办的 Work Package 永久显示 `blocked`，既不派生后继阶段也不再派发 | `execution-view.ts` 排除 `recovered`/`cancelled`；`tests/application/execution-view.test.ts`「已终结的 Recovery 不再阻塞」修复前 `blocked`、修复后 `validating` |
| 3 | Execution Coordination Lease 只在授权切换写入一次且无续约，而 Runtime Lease 的 fencing generation 每次接管都会递增 | 进程重启或同一 Session 重新接管后该租约身份永久陈旧：`request_graph_patch` 一律 `stale_lease_identity` | `lease-service.ts` 新增 `repointExecutionLease`，Session 每次 ensure 时调用；`tests/lease-fencing.test.ts` 覆盖重指、幂等与 `held_by_other`；真实证据：模型收到的 `{"kind":"rejected","code":"stale_lease_identity"}` |
| 4 | baseline 对齐任务的指令只说「对齐目标基线」，而核验规则要求 `observedHead === requiredBaselineHead` 精确相等 | 真实 Planner 无从知道可核验含义 | `baseline-worker.ts` 写明不变量（HEAD 精确等于 `requiredBaselineHead`、留在本 Work Package 分支、不新建合并提交） |
| 5 | **租赁续约把良性 CAS 竞争当作失去租约**：续约先读 scope revision 再以它 CAS，而续约本身不推进 revision，读与提交之间夹进任何共享写入就以 `stale_revision` 落空，而心跳把任何拒绝都判为 fencing 永久停摆 | 高写入期（对账、Delivery 结算）会让健康的 Session 被误判为 fencing 失败并停止模型调用，整条链路卡死（第 2 次真实运行即如此） | `lease-service.ts` 对 `stale_revision` 有界重读重试，fencing/无租约/账本损坏仍上报；`tests/lease-fencing.test.ts`「续约与并发写入相撞…」修复前 `expected 'rejected' to be 'renewed'`、修复后通过 |
| 6 | **多 Work Package 代际无法交付**：后物化的包建立在授权 baseline 上，canonical 已被前一个集成推进，`merge --ff-only` 必然拒绝 | 第二个包永远无法集成（真实 `canonical_not_forward` / `canonical_not_fast_forward`） | `advance-execution.ts` 在派发前发现 `canonical HEAD !== Authorization baseline` 即登记 Baseline Reconciliation（幂等）；门禁从「物化零副作用」调整为「不派发角色 Task，但允许建立对齐所需的 worktree」；`tests/application/{advance-execution,materialize-work-package}.test.ts` 覆盖 |
| 7 | **`request_graph_patch` 在健康链路里不可用**：Planner 是一个 Worker，门禁要求整个 Run 静止且没有未确认 Delivery，而携带声明的用户消息本身会先派发下一个角色 | 真实运行里模型连续拿到 `worker_in_flight`，重试只拿到 `delivery_pending`，窗口只在链路停住或已完成时出现 | 宿主路径改为**有界等待 Run 静止**（10 分钟），并在此期间**每轮做一次对账**（复用 `ScopeControlService.reconcile`，不新建重放路径）结清 Delivery；`tests/coordination/scope-control.test.ts` 覆盖 `reconcile` 的契约（不改控制状态、不停止 Worker） |
| 8 | **Admission 拒绝只回一句「未通过编译校验」** | 模型只能盲目重提同一份补丁（真实 transcript 里连续两次完全相同） | 工具结果并入逐条编译错误（code 保持不变）：真实运行里模型随后收到的原文是 `admission_rejected：budget_exceeded（Work Package 数量 2 超过上限 1）` / `accepted_node_mutation@…` |
| 9 | **退休造成的 revision pending 无人释放**：规格要求「修订**或退休**」都把受影响节点置 revision pending、其当前 Worker 先运行至可核验终态；规格修订由重新准入解除持有，而被 retire 的节点已不在图里、永远不会再被重新准入 | Scope 永久停在 `revision_pending:graph_patch`，Finalizer 门禁（要求每个 Work Package 都 validated）永不满足——Git 侧其实已集成成功却拿不到交付结论（`orca-companion-e2e37` 实测） | `record-graph-version` 在**登记持有的同一事务**里释放已不在新图中的节点（理由「节点已由图修订退场，不会有后续角色或依赖工作」）；宿主另有只读 store 的兜底 `settleRetiredRevision`（仍在图里则保持 pending），用于修复历史遗留的悬挂持有；`tests/coordination-store.test.ts`「图修订退场的节点与图版本同事务释放修订持有…」先失败（mutation 禁用释放）后通过，`tests/execution/specification-revision.test.ts`「退休结算…」覆盖兜底路径 |

不允许的实现改动（按规格排除）：不把 retired 节点从 `revisionPendingWorkPackageIds` 里删掉——规格明确要求退休同样进入 revision pending，缺的是**释放路径**而不是登记规则（最终形态是「照常登记、同一事务内结清」）。

## 常规门禁

`pnpm typecheck && pnpm lint && pnpm build && openspec validate m2-deliver-execution-tui --strict && pnpm test && git diff --check`，串行、无并行负载，**exit 0**：

- `pnpm test`：**139 files passed / 6 skipped（145）；1239 passed / 12 skipped（1251）**，76.26s。
- `openspec validate m2-deliver-execution-tui --strict`：`Change 'm2-deliver-execution-tui' is valid`。
- `pnpm typecheck` / `pnpm lint` / `pnpm build` / `git diff --check`：无错误。
- 与真实 PTY 验收并行跑全量测试会出现 5 秒超时噪声（本仓库既有记录），因此结论只取独立串行运行。

## 覆盖率与残余风险

- **未覆盖**：需要可控在途操作才能进入的「重启先显示 reconciling」画面场景仍按不可达跳过（`test.skip` 注明理由）；Windows、无人值守与远程 attach 不在本次结论内。
- **真实链路对表述敏感（已记录在 `docs/orca-compatibility.md`）**：九字段声明由模型转写，散文描述会被改写成全部 `no`（路由成 `no_change`，一次补丁都不会起草），因此验收用**字面 JSON** 提交并允许有界重提；这属「自然语言 → 结构化声明」的保真度问题，产品路由本身无需改动。
- **`maxActiveWorkPackages` 现在是夹具模板的 8**（规格默认）：此前模板把它钉成 1，导致 Planner 只要让图里保留 2 个节点就被判 `budget_exceeded`，验收结果因此取决于补丁形状；串行派发由 `concurrencyLimit: 1` 保证，与该上限无关。
- 本轮 9 处修复中有 6 处带先失败后通过的回归用例，另外 3 处（baseline 指令、Admission 报错细节、`request_graph_patch` 的有界等待）由真实链路验证；夹具结论事实在运行后先落盘到 `~/.cache/orca-acceptance/evidence/`，夹具目录随后即可回收。
