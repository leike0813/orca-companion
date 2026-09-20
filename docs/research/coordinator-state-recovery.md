# 协调 harness 的状态与恢复机制选项

对应 ticket：[*核验协调 harness 的状态与恢复机制选项*](https://github.com/leike0813/orca-companion/issues/6)（父地图 [#1](https://github.com/leike0813/orca-companion/issues/1)）。

结论先行：**Companion 不需要 LangGraph checkpoint，也不需要 SQLite 来承载协调状态权威。** 以 RiskFlow 为基线，可重建事实来自 issue tracker、Git、OpenSpec 与 Orca；当前确定必须由 Companion 持久化的只有两类不可重建控制记录——**副作用前的幂等意图回执**，以及**尚未写入既有权威源的操作授权与用户回答**。Route Map 与 Decision Ticket 仍以 issue tracker 为权威，Worker Profile 等版本化策略以项目配置为权威，不能复制到本地账本。RiskFlow 的协调器本身既不用 LangGraph 也不建本地数据库，只在 Git common dir 下写互斥锁与幂等回执，并把业务状态放进 Orca Task 的 `result` 信封，由控制器单写者维护。恢复是「重建快照 → 对账未决操作 → 从 `resumeQueue` 队首继续」的确定性过程。若将来协调器出现真正不可从事实推导的循环状态，可为**该循环单独**引入 LangGraph checkpointer，但它只能充当可丢弃的执行草稿，不能升为业务权威。

## 1. 基线：RiskFlow 如何从 Git + Orca 实时事实重建状态

RiskFlow 的协调器是两个 Node 脚本，而非 agent 框架运行时：

- `scripts/orchestration/status.mjs`（1615 行）只读，产出状态；
- `scripts/orchestration/control.mjs`（1162 行）执行写操作，经 `scripts/orchestration/omp-extension.mjs` 暴露为受控工具。

两者都不导入 LangGraph，`package.json` 也没有 LangGraph 依赖。`@langchain/langgraph-checkpoint-postgres` 只出现在 `packages/adapters`（`packages/adapters/src/postgres/checkpointer.ts`），那是 RiskFlow **产品自身**领域工作流的 checkpointer，与协调器无关；本文件把它当作「同一仓库里另一种选择」的对照，而不是协调器的事实来源。

### 1.1 事实来源

`collectFacts()`（`status.mjs:1302`）在一次收集中读取：

| 事实 | 来源 | 位置 |
| --- | --- | --- |
| worktree 列表与完整 ID | `orca worktree list --repo path:<root> --json` | `status.mjs:1303-1314` |
| Run 全量（分页） | `orca orchestration run-list` | `status.mjs:1316-1324` |
| Task 及其 `result` 信封 | 逐 Run `orca orchestration task-list --run <id> --json` | `status.mjs:1325-1341` |
| Worker / Dispatch 资源 | `orca orchestration worker-list --json` | `status.mjs:1316-1324` |
| per-worktree Git 状态、HEAD、dirty 路径 | `git status` / `rev-parse` / `branch` | `collectGit()` |
| main 已归档 change | `git ls-tree -r HEAD -- openspec/changes/archive` | `committedArchiveChangeNames()` |
| per-worktree 活动 change | `openspec list --json` | `collectWorktree()` |
| 路线节点与依赖 | 版本化 Manifest `config/orchestration/execution-graph.json` | `loadGraph()` |

### 1.2 派生而非存储

`deriveNodeState()`（`status.mjs:706`）从上述事实计算每个节点的 `status`、`phase`、`blockers`、`violations`、`nextActions`；`status` 取值含 `ready/running/finalizing/finalized/merged/main_verified/stale/reclaimable/blocked/paused/failed/unknown/untracked`。`resumeQueue` 由 `queueCategory()`（`status.mjs:991`）按固定优先级排出。`revision` 是对业务状态的哈希：

```js
// status.mjs:1066-1076
const businessState = { routeId, main, frontier, resumeQueue, nodes, violations };
return createHash("sha256").update(JSON.stringify(businessState)).digest("hex");
```

`revision` 是**纯函数输出**，不是被存储的状态；它的用途是给写操作做乐观并发校验——`preflightAction` 比对 `expectedRevision`，不符即报 `stale_revision`（`control.mjs:66-80`）。

### 1.3 业务状态放在 Orca，不在本地

协调器把每个 Task 的 v2 执行信封写回 Orca：

```js
// control.mjs：riskflowSettle / updateMainSummary
await orcaJson(exec, invocation, [
  "orchestration", "task-update", "--run", runId, "--id", taskId,
  "--status", "completed", "--result", JSON.stringify(envelope),
]);
```

信封字段含 `workItemId`、`routeNodeId`、`changeName`、`taskKind`、`phase`、`runState`、`worktreeId`、`inputHead`、`outputHead`、`owner`、`attemptGroup`、`attempt`、`auditPolicy`、`issueRefs`、`evidenceRefs`、`main`；获批重新规划另带 `approvalRef` 与 `supersedesAttemptGroup`。读取侧 `parseTaskEnvelope()`（`status.mjs:113`）做严格校验，字段非法即把任务判为 `unlinked_task_result` violation，而不是猜测归属。Orca 侧 `TaskRow` 确有 `result: string | null` 列承载它（submodule `src/main/runtime/orchestration/types.ts:255-271`）。

### 1.4 唯一的本地写入

对 `writeFile|mkdir|rename|rm` 全量检索后，协调脚本的磁盘写入只有两处，且都在 Git common dir 下（`control.mjs:275-369`）：

1. **跨进程互斥锁** `riskflow-orchestration/control.lock/`，内含 `owner.json`（pid + 时间戳），120 秒可判过期（`control.mjs:304-330`）。
2. **幂等回执** `riskflow-orchestration/receipts/<hash(idempotencyKey)>.json`，内容为 `{status, inputHash, result?}`。

回执的写入顺序是设计核心（`control.mjs:630-648`）：

```js
const prior = await readReceipt(runtimeDir, idempotencyKey, { action, ...input });
if (prior !== null) return prior;                // 同键同输入 → 返回首次结果
// …校验 revision 与 preflight…
await writeReceipt(..., "inflight");             // 先落意图
const result = await perform(...);               // 后做副作用
await writeReceipt(..., "completed", result);    // 再落结果
```

若回执停在 `inflight`，`readReceipt()` 以 `uncertain_prior_execution` fail-closed 拒绝自动重放，并要求重新读状态对账（`control.mjs:331-349`，测试 `control.test.mjs:495-523`）。

### 1.5 预算与用户决定

- **预算没有独立计数器。** `noProgressLimit: 3` 是 Manifest 策略（`execution-graph.json` 的 `policy`）；实际计数在收口时从信封派生——同一工作项、同一 HEAD、相同 outcome/issueRefs/evidenceRefs 的已收口尝试达到上限即转 `paused`（`control.mjs` 的 `riskflowSettle`）。尝试账本就在 Orca 的 Task 信封里，所以**重启不会重置预算**。这是「派生优于存储」的直接收益。
- **用户决定通过批准引用表达。** 重开实现必须携带非空 `replanApprovalRef`，落到 planning 信封的 `approvalRef`，由 preflight 强制（`replan_not_allowed` / `replan_approval_required`；schema 见 `omp-extension.mjs:99`）。它同样落在 Orca，而非本地审批表。

## 2. 三类划分：重建、必须持久化、可丢弃

### 2.1 实时可重建事实（不得存储）

| 事实 | 权威源 |
| --- | --- |
| worktree 完整 ID、路径、分支、HEAD、dirty 路径 | Orca + Git |
| change 集合、工件阶段、main 归档 | OpenSpec CLI + `git ls-tree` |
| Run / Task / Dispatch / Worker / terminal 标识与状态 | Orca |
| v2 信封全部字段（phase、runState、attempt、attemptGroup、in/out HEAD、owner、evidenceRefs、issueRefs、main 摘要、approvalRef） | Orca Task `result` |
| 业务状态 `status` / `phase` / `nextActions` / `violations` / `resumeQueue` / `revision` | 上述事实的纯函数 |
| 预算用量（尝试次数、无进展次数） | 信封派生 |

### 2.2 必须持久化的不可重建协调事实

只有两类，且都很小：

1. **副作用前的幂等意图回执。** 键为稳定操作 ID，值为输入哈希 + 状态 + 结果。它不可由 Git/Orca 重建，原因有二：其一，意图写在副作用**之前**，此刻外部世界还没有任何痕迹；其二，Orca 自己的 mutation receipt 会被回收——上限 10,000 行、超 30 天清理，未决操作写满时直接报 `mutation_ledger_full`（submodule `src/main/runtime/orchestration/mutation-receipt-capacity.ts:4-5,53-75`）。因此 Orca 官方把 `request-show` 的 `absent` 明确标注为「**不是**什么都没发生的证据」（`src/cli/specs/orchestration.ts:184-190`）。
2. **未进入既有权威源的操作授权与用户回答。** Route Map 决策写入 issue tracker，Worker Profile 与预算上限写入版本化项目配置；这两类都不应复制到本地账本。只有一次运行中的提交/合并/发布授权、`ask_user` 的待答问题与回答等尚无外部权威载体的记录，才由 Companion 以稳定 ID 持久化，并允许 Task 信封引用该 ID。

事件消费是尚待 Orca 能力票确认的条件项：若公开接口提供可重放、带 durable consumer/ack 的事件流，消费位置由 Orca 权威保存；若确认会破坏性推进且无法重放，Companion 必须在 ack 前落下最小 inbox/dedup 记录。不能在契约核验前假设需要一套完整事件库。

（互斥锁属于本地**运行态**，不是长期持久数据，见 2.3。）

### 2.3 可丢弃缓存

- 派生快照与 `revision`；
- terminal handle：Orca 文档明确 handle 为 runtime-scoped，重启后须用 `terminal list` 重新解析（[CLI reference](https://www.onorca.dev/docs/cli/reference) "Terminal handles"）；
- worker transcript / 终端读出的输出、渲染后的 TUI 状态、任何性能缓存。

## 3. LangGraph checkpoint：是否必要

### 3.1 它解决什么

checkpointer 在**每个 super-step 边界**保存 thread 级图状态快照，官方列出的用途是 human-in-the-loop、memory、time travel、fault tolerance 与 pending writes；pending writes 让同一 super-step 内已成功节点的输出无需重跑（[Checkpointers](https://docs.langchain.com/oss/javascript/langgraph/checkpointers)）。

### 3.2 它不解决什么——恰是本问题的关键

- **不提供跨系统 exactly-once。** 官方在 Graph API 写明：「如果执行停止后恢复，受影响的**节点会从头重新运行**。暂停点之前的代码和副作用会再次运行。」处方是「把节点逻辑设计成可重复执行；使用幂等键、upsert 或读后写检查」（[Graph API → Re-execution and idempotency](https://docs.langchain.com/oss/javascript/langgraph/graph-api)）。也就是说，**引入 LangGraph 并不能省掉 2.2 的幂等回执，反而要求它必须存在。**
- **不能在节点中途恢复。** 只有 super-step 边界可恢复，节点内部进度不持久。
- **不解析外部业务真值。** 它保存的是「图状态快照」，而阶段真值在 Git/Orca；在 checkpoint 里再存一份 phase/attempt 就是第二权威源。

### 3.3 建议

M0/M1 **不采用** LangGraph checkpoint 承载协调状态。当前阶段机是事实的确定性函数，没有需要跨进程保存的图内状态：`resumeQueue` 每次都能重算，而且规范要求它必须可重算——`orchestration-execution-status/spec.md` 的「重启后继续接管」场景要求系统「仅凭 Git、OpenSpec、Orca 和 Manifest 重建相同的 `resumeQueue`」。可重建的东西不值得持久化；持久化之后还必须与真值对账，正是要避免的漂移。

**升级触发条件**（满足再引入）：协调器出现真正不可从事实推导的循环状态，例如多步模型调用中悬挂的工具调用、需要跨重启保留的消息与 interrupt cursor。届时只对**该循环**使用 checkpointer，`thread_id` 绑定 Companion 工作流 ID，并明确标注 checkpoint 为可丢弃的执行草稿；业务权威仍是 issue tracker、Git 与 Orca。

另需记录一处仓库内部张力：`AGENTS.md` 第 2 节把 LangGraph 定为执行机制，而地图 Notes 声明在系统边界校正前 `AGENTS.md` 不作为事实源。本文件按地图口径给出结论，不据此改动 `AGENTS.md`。

## 4. SQLite：是否必要

**暂不必要。** 按 2.2，本地持久化需求只有两类键值小记录，访问模式是「按稳定键读、单记录原子写」：

- 幂等回执：写临时文件后 `rename` 即原子（`control.mjs:355-369`），读取按键命中；
- 用户决定：以追加为主，按键或时间查询。

RiskFlow 用 Git common dir 下的 JSON 文件已满足这两项，未引入数据库。SQLite 在需要**多记录原子事务**、**并发读**或**按字段查询的操作历史**时才回本。届时优先用 Node 24 内置的 `node:sqlite` 以避开原生依赖（该 API 仍属实验性，采用前须在目标平台实测）。

```ts
// ponytail: JSON 文件足够；出现跨记录事务或按字段查询历史时再迁 node:sqlite
```

若第 3 节的升级条件成立而引入 LangGraph checkpointer，`@langchain/langgraph-checkpoint-sqlite` 的 `SqliteSaver`（官方定位为「实验与本地工作流」，需单独安装）会是同一文件的合理承载者；此时该文件仍是**执行草稿库**，不是业务权威。

## 5. 避免第二权威源：字段级归属

一句话规则：**能派生就绝不写入；一个字段只有一个写者。**

| 字段 | 唯一权威源 | 读写方式 |
| --- | --- | --- |
| worktree ID / 路径 / 分支 / HEAD / dirtyPaths | Orca + Git | 每次 `collectFacts` 重读 |
| change 集合、工件阶段、main 归档 | OpenSpec CLI + `git ls-tree` | 每次重读 |
| Run / Task / Dispatch / Worker / terminal 标识与状态 | Orca | 每次重读 |
| 阶段权威：信封 `phase` / `runState` / `attempt` / `attemptGroup` / `inputHead` / `outputHead` / `owner` / `evidenceRefs` / `issueRefs` / `main` / `approvalRef` | Orca Task `result` | 写：仅控制器，持锁 + `expectedRevision`；读：只读重建 |
| 派生业务状态 `status` / `phase` / `nextActions` / `violations` / `resumeQueue` / `revision` | 无（纯函数输出） | 不落盘 |
| 副作用幂等意图与结果 | Companion 本地（Git common dir） | 写：副作用前 `inflight`、后 `completed`；读：按操作 ID |
| 外部副作用是否真发生 | Orca mutation receipt + 实时事实 | `request-show` 与现场核对；`absent` 不等于未发生 |
| 互斥写者 | Companion 本地锁目录 | 每次写操作持有 |
| Route Map 决策、Decision Ticket resolution | issue tracker | Companion 只保存外部引用 |
| Worker Profile、预算上限等版本化策略 | 项目配置 | Task 信封引用配置版本 |
| 运行期操作授权、`ask_user` 问答 | Companion 本地持久记录（带 ID） | 仅在没有既有外部权威载体时保存；信封只引用 ID |
| 事件消费位置 | Orca durable consumer/ack；若无可重放契约则为 Companion inbox | Orca 能力核验后只选一个权威，不双写 offset |
| terminal handle | Orca 运行态 | 每会话重新解析；持久化即失效 |

两处刻意的重叠必须讲清语义，否则会退化成双权威：

- **幂等键 vs Orca mutation receipt。** Orca 的 receipt 是「副作用是否落地」的权威，Companion 的回执是「我方是否有过这个意图」的权威；两者用**同一个请求 ID** 关联（CLI 的 `--retry-request`）。Companion 不复制 Orca receipt 的内容，也不凭自己的回执宣称副作用已发生。
- **v2 信封 vs 派生状态。** 信封只记录**不可从事实推导的决策**（阶段、尝试、归属、证据引用、批准引用）；凡能从 Git/Orca 读出的（HEAD、状态、归档）都不得写入信封。

## 6. 最小恢复顺序

```text
1. 取跨进程写者锁（已有存活写者则拒绝启动）
2. 核验 Orca 运行时 ready；解析协调者身份、绑定 Run 与 terminal handle
3. 读实时事实：worktrees / runs / tasks(含信封) / workers / terminals
   + 每个 worktree 的 git 状态与 openspec 活动 change
4. 对账未决操作：任何 inflight 回执先 request-show + 现场核对；
   不得换键重试；无法判定则阻塞并上报
5. 重建快照 → revision / violations / resumeQueue
   violations 非空：先修复，不派发、不合并、不归档
6. 从 resumeQueue 队首以 expectedRevision 继续；沿用原工作流与 Run，
   不得为「恢复」新建 Run 或 worker
```

第 4 步与第 6 步最容易做错：前者错在「不确定就重试」，后者错在「用新建代替恢复」。`AGENTS.md` 第 8 节对这两点已有相同要求；本节的增量是把它们落到 RiskFlow 已验证的具体顺序上。

## 7. 引用

**RiskFlow 一手实现**（`/home/joshua/Workspace/Code/JavaScript/RiskFlow`，HEAD `8185ad8`）：

- `scripts/orchestration/status.mjs`：`collectFacts`(1302)、`deriveNodeState`(706)、`queueCategory`(991)、`snapshotRevision`(1066)、`parseTaskEnvelope`(113)、`collectGit`、`committedArchiveChangeNames`、`collectWorktree`。
- `scripts/orchestration/control.mjs`：`preflightAction`(66)、`withRuntimeLock`(304)、`readReceipt`(331)、`writeReceipt`(355)、`controlledMutation`(630)、`riskflowDispatch/Wait/Settle/Integrate/Reconcile`、`updateMainSummary`。
- `scripts/orchestration/control.test.mjs:495-523`（inflight fail-closed）；`config/orchestration/execution-graph.json`（`policy.noProgressLimit` 等）。
- `IMPLEMENTATION-ORCHESTRATION-HANDBOOK.md` 第 1、3、6、7 节；`IMPLEMENTATION-ORCHESTRATION-RUNBOOK.md` 第 2、6 节。
- OpenSpec 能力规格 `openspec/specs/operations/orchestration-execution-status/spec.md`（「状态冲突必须 fail-closed」「重启后继续接管」等场景）、`openspec/specs/operations/orchestration-controlled-actions/spec.md`（「状态转换必须防止重复执行」等场景）。

**Orca 一手来源**（运行时 1.4.198；submodule `references/orca` @ `de15227`）：

- `orca orchestration check --help`、`orca orchestration request-show --help`；`src/cli/specs/orchestration.ts:184-190`。
- `src/main/runtime/orchestration/types.ts:124-133`（`MutationReceiptRow`）、`:255-271`（`TaskRow.result`）。
- `src/main/runtime/orchestration/mutation-receipt-capacity.ts:4-5,53-75`。
- 文档 [CLI reference](https://www.onorca.dev/docs/cli/reference)（terminal handle 为 runtime-scoped）、[Orchestration](https://www.onorca.dev/docs/cli/orchestration)（Run 是 durable namespace；完成权威来自 active dispatch）。

**LangGraph 一手文档**：

- [Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)、[Checkpointers](https://docs.langchain.com/oss/javascript/langgraph/checkpointers)：super-step 快照、pending writes、durability `exit|async|sync`、`SqliteSaver` 定位、`MemorySaver` 重启即丢。
- [Graph API → Re-execution and idempotency](https://docs.langchain.com/oss/javascript/langgraph/graph-api)：节点重跑与幂等要求。
- [Fault tolerance → Graceful shutdown](https://docs.langchain.com/oss/javascript/langgraph/fault-tolerance)：`RunControl.requestDrain()`，需 `@langchain/langgraph>=1.4.0`。

## 8. 未验证项

- RiskFlow 的结论来自源码与规格阅读，**未在本机实际运行**其协调器，也未制造崩溃以复现恢复路径。
- Orca mutation receipt 的回收行为（10,000 行 / 30 天）来自源码常量，未在运行时观察回收与 `absent` 的实际返回。
- 未运行 `orca orchestration request-show` 验证 `completed/pending/absent` 三种状态的实测输出。
- Node 24 `node:sqlite` 在本项目目标平台的可用性未实测。
- LangGraph 的版本相关能力（`>=1.4.0` 的 graceful shutdown、per-node timeout）未在本机安装验证。
- 运行期操作授权与 `ask_user` 问答的具体载体，取决于尚未定稿的 CLI/TUI 控制面；Route Map 决策、Worker Profile 和预算上限已有各自权威源，不应落入本地副本。
- 事件是否需要本地 inbox/dedup，取决于公开 Orca 事件接口最终核验出的 replay 与 ack 语义。

记录时间：2026-09-17。
