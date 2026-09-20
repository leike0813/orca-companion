# Orca Task DAG 的执行图能力与动态修改限制

对应 ticket：[*核验 Orca Task DAG 的执行图能力与动态修改限制*](https://github.com/leike0813/orca-companion/issues/22)（父地图 [#1](https://github.com/leike0813/orca-companion/issues/1)）。

结论先行：**Orca 的公开 Task DAG 可以用来承载执行图的运行时投影，但它不是一张可编辑的图。** Task 的结构（`spec`、`deps`、`parent`）在创建时一次写死，之后只能改 `status` 与 `result`，没有任何删除接口。这意味着「先把完整执行图物化，运行中再根据 Worker 回报改结构」在 Orca 侧不可实现；图的结构语义必须由 Companion 拥有，Orca 只承载已物化节点。旧内置 Coordinator 是纯确定性循环，且已在 CLI 与 RPC 两层退役，本机实测拒绝执行。因此 Companion 必须自己驱动派发与图演进，Orca 只提供 Task、依赖就绪、gate、Dispatch 和恢复的事实。

## 1. 验证基线与方法

| 项 | 值 |
| --- | --- |
| 安装的 Orca CLI | 1.4.198（`/home/joshua/.local/bin/orca`） |
| 运行中的 runtime | `1.4.198`，state `ready`，`orca status --json` 实测 |
| 固定 submodule | `de15227a1d321840ea35c6bb2d0cc01e3409e5f1`（2026-09-17） |
| 契约版本 | `ORCHESTRATION_CONTRACT_VERSION = 1`（`references/orca/src/shared/protocol-version.ts:63`） |

方法：对安装版本只运行只读命令与不产生副作用的命令（`--help`、`--json` 探测、`skills get`、`status`）；没有创建任何 Run、Task、Dispatch 或终端。源码结论全部来自固定的 submodule 快照，并标注文件与行号。凡安装版本实测与快照不一致处单列一节。

## 2. 公开 Run/Task 能力

除第 7 节列出的参数偏移外，安装版本的公开命令面与快照一致（`references/orca/src/cli/specs/orchestration.ts`、`.../orchestration-worker-specs.ts`）：

| 能力 | 命令 | 语义要点 |
| --- | --- | --- |
| Run | `orchestration run-create/run-use/run-list/run-show` | Run 只是命名空间与收件箱；`--help` 明言 "A Run is a namespace and home inbox. It never schedules or places workers." |
| Task 创建 | `orchestration task-create --spec <text> [--task-title] [--display-name] [--deps <json_array>] [--parent <task_id>] [--run]` | 依赖与父节点只能在创建时声明 |
| Task 查询 | `orchestration task-list [--status] [--ready] [--brief] [--run]` | `--ready` 是就绪视图 |
| Task 更新 | `orchestration task-update --id <task_id> --status <status> [--result <json>]` | 仅状态与结果 |
| Decision gate | `orchestration gate-create/gate-resolve/gate-list` | gate 必须绑定一个 Task |
| 派发 | `orchestration dispatch`、`worker-start/worker-show/worker-read/worker-stop/worker-abandon/worker-release/worker-retain/worker-list` | Dispatch 是一次 Task 尝试的权威载体 |
| 幂等恢复 | 每个 mutation 支持 `--retry-request <id>`，配合 `orchestration request-show --request <id>` | `completed/pending/absent` 三态 |

`task-update` 的合法状态为 `pending | ready | dispatched | completed | failed | blocked`（`references/orca/src/main/runtime/rpc/methods/orchestration/schemas.ts:124-142`）。

## 3. Task 结构不可变，且是追加式的

这是对动态执行图影响最大的一条，证据链完整：

1. **只有一处写入 Task 结构。** 全仓 `INSERT INTO tasks` 仅出现在 `createTask`（`references/orca/src/main/runtime/orchestration/db/tasks/task-store.ts:51-84`）。
2. **没有对 `tasks` 的独立结构更新。** 搜索 `UPDATE tasks`/`tasks SET` 在非测试源码中无命中；唯一改 `tasks` 的路径是生命周期写入器。
3. **生命周期投影列是白名单，且不含结构字段。** `PROJECTION_COLUMNS` 只允许 `result`、`completed_at`、`last_failure` 等运行字段，写入未知列直接抛错（`references/orca/src/main/runtime/orchestration/db/lifecycle-transition.ts:102-118`、`:169-174`）。`spec`、`deps`、`parent_id`、`task_title`、`display_name` 都不在列。
4. **更新契约本身只有三个字段。** `TaskUpdateParams` 为 `{ id, status, result?, run?, callerTerminalHandle? }`（`references/orca/src/main/runtime/rpc/methods/orchestration/schemas.ts:124-142`）。
5. **没有删除能力。** 在 CLI specs 与 RPC 契约中检索 `task-delete`/`task-remove`/`taskDelete` 无命中；mutation 白名单也不含删除类方法（`references/orca/src/shared/orchestration-rpc-contract.ts:22-41`）。

结果是 Task 呈**追加式**：结构在创建瞬间冻结，此后只能推进状态与填写结果，既不能改依赖，也不能删节点。运行中要「插入 Patch 节点」或「用新版本取代旧节点」，只能新建 Task，不能改已有 Task。

一个相关但不同的自由度：Task 的**状态边**在数据库层几乎完全放开，六个状态之间任意迁移都合法（`references/orca/src/main/runtime/orchestration/db/lifecycle-transition.ts:70-79`），真正的约束来自调用方对活跃 Dispatch 的检查（`references/orca/src/main/runtime/orchestration/db/tasks/task-status-transition.ts:38-76`）。也就是说可以合法地把 `completed` 拉回 `ready` 重开，但重开不会改变它的依赖集合。

## 4. 依赖、就绪与派发门禁

依赖语义由三处共同构成，且都只看**已物化**的 Task：

- 创建时计算初始状态：所有 `deps` 都已 `completed` 才建为 `ready`，否则建为 `pending`（`references/orca/src/main/runtime/orchestration/db/tasks/task-store.ts:59-67`）。依赖必须已存在于同一 Run，否则创建即报错（`:38-43`）。
- 完成时晋升：任务转 `completed` 后，`promoteReadyTasks` 把依赖全满足的 `pending` 子任务转 `ready`，且在同一事务内完成（`:211-235`，调用点 `task-status-transition.ts:108-110`）。
- 派发时拒绝：`worker-start`/`dispatch` 对非 `ready` 的 Task 返回 `task_not_startable`，并在 `data.unmetDependencies` 中列出未完成依赖源（`references/orca/src/main/runtime/orchestration/task-dispatch-refusal.ts:48-61`、`references/orca/src/shared/orchestration-dispatch-refusal-contract.ts:33-56`）。

派发失败的边界也已固定：同一 Task 连续失败满 3 次时 Dispatch 进入 `circuit_broken`，Task 判 `failed`（`references/orca/src/main/runtime/orchestration/db/dispatch-context/dispatch-circuit-breaker.ts:2`、`dispatch-completion.ts:153-190`）。

值得注意的卡死形态：若某个依赖失败，下游 Task 会永久停留 `pending`。旧协调器对这种情况只记录一条日志，不做恢复（`references/orca/src/main/runtime/orchestration/coordinator-dag-convergence.ts:20-29`）。

## 5. Decision gate 的语义

gate 是 Task 级的阻塞检查点，不是通用图边：

- 创建 gate 会先结算该 Task 的活跃 Dispatch，再把 Task 置 `blocked`（`references/orca/src/main/runtime/orchestration/db/decision-gates/decision-gate-store.ts:9-95`）。
- 解决 gate 会把 Task 直接置回 `ready`（`:97-127`）。
- 旧协调器明确**不会**自动解决 gate，注释写明这是刻意保留人工批准语义（`references/orca/src/main/runtime/orchestration/coordinator-decision-gates.ts:52-61`）。

由于 gate 必须绑定已存在的 Task，它无法用来给尚未物化的逻辑节点提前声明前置条件。

## 6. 旧内置 Coordinator：确定性，且已退役

**退役是双层的，本机实测确认无副作用。**

- CLI 层：`coordinator-start`/`coordinator-stop` 的 handler 在发起任何 RPC 之前就抛错（`references/orca/src/cli/handlers/orchestration/dispatch-handlers.ts:69-82`）；命令规格的 summary 直接标为 "Retired"（`references/orca/src/cli/specs/orchestration.ts:224-243`）。
- RPC 层：`orchestration.run` 与 `orchestration.runStop` 被列入退役方法集合（`references/orca/src/shared/orchestration-rpc-contract.ts:45`），由迁移门禁在进入实现前拦截（`references/orca/src/main/runtime/rpc/orchestration-contract-fence.ts`）。

本机 1.4.198 实测：

```text
orca orchestration coordinator-start --spec probe --json
  → ok=false, code=orchestration_migration_required,
    data.reason=command_retired, data.effectsApplied=false   (exit 1)
orca orchestration coordinator-stop --json
  → 同上                                                    (exit 1)
```

**其实现是纯确定性的，没有任何模型调用。** `Coordinator` 类里没有 LLM、prompt 或 provider 依赖：

1. `decompose()` 不具备分解能力，若没有预建 Task 就直接抛错，注释写明 AI 分解属于未来阶段：`// Why: decomposition isn't implemented yet — tasks must be pre-created before run(); AI-driven decomposition is a future phase.`（`references/orca/src/main/runtime/orchestration/coordinator.ts:146-157`）
2. 主循环每 tick 依次做：读取消息、处理升级、按 pending gate 重新阻塞、警告过期 Dispatch、派发就绪任务、判断收敛（`:159-166`）。
3. 派发按 `db.listTasks({ ready: true })` 加 `maxConcurrent` 槽位，必要时每 tick 最多创建一个终端（`:229-302`）。
4. 收敛判断只看 Task 状态集合（`coordinator-dag-convergence.ts:6-31`）。
5. `processEscalations()` 是空钩子，注释写的是留给未来策略（自动改派、外部通知）的位置（`:225-227`）。

该类仍由遗留 RPC handler `orchestration.run` 构造（`references/orca/src/main/runtime/rpc/methods/orchestration/gates/gates.ts:25-61`），但 RPC migration fence 会在请求到达该 handler 前拒绝 `orchestration.run/runStop`。因此生产源码尚未删除旧实现，却已没有可执行的公开入口。可以理解为「保留了确定性状态机与执行原语，把协调决策交给外部 agent」。

## 7. 版本偏移：安装 1.4.198 与固定快照不一致

两处差异会影响 Companion 的 adapter 设计，且都以实测为准：

| 能力 | 固定快照 `de15227` | 本机安装 1.4.198 |
| --- | --- | --- |
| `worker-start --spec` / `--task-title` / `--deps` / `--parent` | 支持，用于一步创建 Task 并派发（`references/orca/src/cli/specs/orchestration-worker-specs.ts:5-30`） | **不支持**。实测 `Unknown flag --spec/--task-title/--deps`，`validFlags` 中只有 `task` |
| `worker-list --include-remote` | 指南中作为远程 worker 枚举手段 | **不支持**，实测 `Unknown flag --include-remote` |

推论：安装版本必须走 `task-create` 建任务 + `worker-start --task <task_id>` 派发的两步路径，不能依赖 `worker-start --spec`。这也说明 ≥1.4.198 的安装版本仍处在统一契约之前，adapter 必须以能力探测而非快照假设来决定调用形态。

另有一条环境事实：当前 shell 不在 Orca 终端内，`task-create` 等变更类命令会先因 `no_active_sender_terminal` 失败，要求 `--from <terminal-handle>` 或 `ORCA_TERMINAL_HANDLE`。意味着 Companion 必须显式绑定调用者身份，不能依赖隐式环境。

## 8. 对动态 Execution Graph 的硬约束

把上述事实翻译成设计要求：

1. **拓扑必须由 Companion 拥有。** Orca 无法在创建后改 `deps`/`parent`，所以「运行中在 A→B 之间插入 Patch 节点」无法通过修改 B 实现；只能新建节点并让 Companion 自己维护逻辑拓扑。
2. **延迟物化不是优化，而是结构必需。** 若把完整图一次性物化，后续新增的依赖关系将无处可写——已创建的 `pending` Task 无法追加新依赖。只把当前 Frontier 物化，才能保留「新增前置」「插入 Patch」「以新版本取代旧节点」的自由度。
3. **Patch 与 Revision 只能是新 Task。** 追加式模型配上游节点版本语义：`Patch Task` 与 `Revised Task` 都是新节点，旧节点保留为历史，靠 Companion 侧的 `supersedes` 记录表达取代关系。这与 Q4 结论一致。
4. **运行事实仍应交给 Orca。** 就绪计算、依赖晋升、派发拒绝、circuit breaker、Dispatch 生命周期、gate 结算都已由 Orca 正确实现，Companion 只保存 `PlanNodeId → OrcaTaskId`、GraphVersion、创建该 Task 的 `OperationId` 等最小绑定，不复制 Task 状态。
5. **不要依赖内部调度器。** `Coordinator` 已退役且无生产调用点，其分解能力从未实现；Companion 必须自己实现调度循环，只调用公开原语。
6. **必须自己处理失败依赖的下游卡死。** Orca 只把这类 Task 留在 `pending` 并记录一条日志，不会补偿或提示到策略层。
7. **必须显式绑定身份。** 变更类命令需要 `--from <handle>` 或运行在 Orca 终端内；项目 scope 与身份来自 controller，不能信任模型自填。
8. **版本能力需能力探测。** `--spec`/`--include-remote` 在快照存在而安装版本缺失，说明不能按快照硬编码参数；`--retry-request` 与 `request-show` 是已核验可用的幂等恢复通道。

## 9. 未核验与边界

- 上述调用形态只在单机本地 host 验证，远程 host / WSL / Windows 未核验。
- 未做真实 Run/Task 创建，因此「依赖晋升」「派发拒绝」「circuit breaker」的运行时行为来自源码，缺少端到端观测；这些属于 M0 隔离项目内的验证目标。
- 安装 1.4.198 是否在其它隐藏 flag 上继续偏离快照未穷举，仅核验了与执行图直接相关的字段。
- handoff：动态执行图的**物化时机与颗粒度**（Q6）依赖本报告的分层所有权结论，建议作为下一张决策票处理。
