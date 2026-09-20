## Context

本 change 直接接在 `m0-orca-control-baseline` 之后。M0 交付的是 Orca 控制契约：封闭的操作目录、三值 `OperationOutcome`、受限进程边界与 doctor，它刻意没有建立任何持久化。现在需要一层共享状态，否则并发 Coordinator Session、租约、fencing 与未知结果对账都无处落脚。

`CONTEXT.md` 已经把权威归属划好：Route Map 与 Decision Ticket 属 issue tracker，Worker Profile 与预算上限属版本化项目配置，代码与 worktree 属 Git 与 Orca，Run 与 Dispatch 属 Orca，Execution Graph 是规划产物加 Accepted Graph Patch 的追加历史。留给 Companion 自有的只有两类：无法从以上来源重建的共享协调事实，以及每个 Session 自己的 checkpoint。本 change 只做前者。

`docs/research/coordinator-state-recovery.md` 提供了另一条重要输入：可重建的东西不该持久化，持久化之后必须与真值对账，这是要避免的漂移。M0 之前该文档建议 JSON 文件足够；本 change 引入 SQLite 是因为这里出现了它列举的升级条件之一——同一份状态需要跨记录原子事务、并发读与按字段查询，而不再是「按键读、单记录写」。

### 架构合同导入

| 关系 | 合同 | 本 change 的责任 |
|---|---|---|
| Create | `IC-03` | 首次实现 `BranchCoordinationStore`、CAS revision、lease/fencing、Operation Intent 与 migration seam |
| Consume | `IC-01` | 复用稳定 ID、expected revision 与 fencing generation，不定义平行身份类型 |
| Consume | `IC-02`、`FLOW-01` | 以既有 OperationOutcome 收尾 intent；unknown 保留原 OperationId |
| Consume | `MOD-01`、`MOD-02`、`MOD-04` | 领域规则、应用 port 与 SQLite adapter 分层，不让 store 拥有对账策略 |

## Goals / Non-Goals

**Goals:**

- 建立 `coordination.sqlite` 与带 CAS revision 的 Branch Coordination Store，作为 Coordination Scope 内共享协调事实的唯一写入点。
- 用短租约加递增 fencing 表达 Runtime Lease 与 Execution Coordination Lease，使迟到进程无法覆盖当前状态。
- 用 Operation Intent 把「副作用意图」与后端 receipt 关联起来，给未知结果留下确定的对账入口。
- 提供 `orca-companion status [--json]` 只读快照，且不要求 TTY。

**Non-Goals:**

- 不实现 LangGraph checkpointer 与其数据库；本 change 的 store 是另一份文件。
- 不实现 Execution Graph、Worker 生命周期、预算消耗规则本体、模型 loop 与 TUI。
- 不把 Route Map、Decision Ticket、Worker Profile 或预算上限复制进本 store。
- 不实现重放、事件订阅或通用 inbox。

## Decisions

### D1 存储位置与文件边界

`coordination.sqlite` 放在 Git common dir 下的 Companion 私有目录，与 `checkpoints.sqlite` 分开。理由：`CONTEXT.md` 要求两个 store 各自实现各自契约，checkpointer 只保存单 Session 会话状态；合表会让「共享协调事实」与「可丢弃执行草稿」共享生命周期，一旦 checkpoint 被清理就会连带破坏 lease 与 intent。

替代做法是复用 checkpointer 的 SQLite 连接或把状态挂在 `.git` 之外的项目目录。放弃的原因分别是权威混淆与「linked worktree 下同路径不同内容」的问题：Git common dir 是唯一对所有 worktree 一致的位置。

### D2 schema 版本与迁移

store 在库内保存 schema 版本；打开时版本高于当前实现即拒绝启动并说明原因，低于当前实现时按顺序执行迁移。每个迁移在单事务内完成并可重入。理由：`AGENTS.md` 要求 boundary 与持久化记录做运行时校验，且后续八个 change 都会扩展 schema，没有版本位的库无法安全演进。

替代做法是「删库重建」。放弃的原因是 lease 与 Operation Intent 的丢失会让恢复从「对账」退化成「猜测」。

### D3 表结构与唯一约束

M1 持久化基线需要的最小表集：`scope`（模式、控制状态、Planning Cycle 引用、graph 与 authorization 引用、revision）、`session_registry`（Session 标识、Coordinator Model Configuration 绑定引用、状态）、`leases`（类型、持有者、到期时间、fencing generation）、`ticket_claims`（ticket 引用、Session、状态）、`pending_interactions`（interaction ID、拥有者、scope 引用、expected revision、状态）、`operation_intents`（OperationId、目标、expected revision、状态、结果分类、backend request 引用）、`budget_counters`（Scope 级共享计数）。

唯一约束承担三项不可违反的不变式：同一 Scope 同一时间只有一个 `execution_coordination` lease 行、同一 Session 同一时间只有一个活跃 runtime lease 行、同一 ticket 只有一个活跃 claim 行。把不变式放在数据库约束而不是应用分支里，是为了让并发写入在事务内自然失败。

### D4 revision 的语义与推进

`scope.revision` 是一个单调递增整数，随每次成功的共享状态写入在同一事务内推进。它 SHALL NOT 由调用方提供新值，调用方只提供读到的 expected 值。理由：`CONTEXT.md` 把 revision 定义为 CAS 的比较对象；让调用方写新值等于允许伪造顺序。

替代做法是内容哈希（RiskFlow 的做法）。放弃的原因是本 store 会承载 lease 心跳这类高频写入，内容哈希会让每次心跳都产生「业务 revision 变化」的假象。

### D5 租约、心跳与 fencing

Runtime Lease 为短租约，持有者按固定间隔心跳续约；续约与接管都在事务内校验 fencing generation。接管时生成更大的 generation，旧 generation 的写入一律拒绝（spec: 迟到进程写入被拒绝）。Execution Coordination Lease 用同一机制，但到期不自动降级——它只在持有者显式释放、Session 被取消或用户授权转移时改变。

租约过期不释放 claim 与 Execution Coordination Lease（spec: Runtime Lease 不释放更长期的所有权）。这一点是刻意的：进程消失不等于职责转移，`CONTEXT.md` 的 Runtime Lease 定义明确写了这一条。

### D6 Operation Intent 与 M0 OperationRef 的关系

intent 记录的 OperationId 由 controller 生成，`backend_request_ref` 保存 M0 adapter 关联出的 Orca request ID。intent 表 SHALL NOT 复制 Orca receipt 的内容，只保存状态分类与引用。理由与 `docs/research/coordinator-state-recovery.md` 第 5 节一致：回执属于「我方是否有过这个意图」，receipt 属于「副作用是否落地」，两者以同一请求 ID 关联而不互相复制。

M0 冻结的接缝在本 change 的消费方式：`ExecutionBackend.mutate` 返回的 `OperationOutcome` 直接决定 intent 的收尾分类——`accepted` 与 `rejected` 收尾，`unknown` 保留为未决并带上 `OperationRef`。本 change 不新增第四种结果分类，也不修改 M0 的 D3 映射表。

### D7 未决意图与 mutation lane 阻塞

同一目标上的未决 intent SHALL 形成一条 mutation lane；lane 未解决前，该目标上的新变更 SHALL 被拒绝（spec: 对账仍不确定时阻塞通路）。lane 的粒度是「目标对象 + 操作类别」，不是全局。理由：把不确定性限制在相关通路上，可以让无关规划继续进行，同时不放过真正未决的副作用。

### D8 事务边界与并发模型

全部写入使用短事务，默认使用 SQLite 的立即事务模式以获得写者串行；读查询不加长时间排他锁。不使用跨调用的文件锁或长期单写者锁。理由：`CONTEXT.md` 明确要求用唯一约束与预期 revision 取代项目级长期写者锁；`AGENTS.md` 第 8 节同样要求 SQLite 事务保持短小。

存储访问用 `node:sqlite` 的同步 `DatabaseSync` 接口。它是实验性 API，因此把访问集中在一个适配器内，未来替换实现不影响应用层。放弃引入 better-sqlite3 等原生依赖，避免原生构建与版本绑定。

### D9 status 的只读性与失败方式

`status --json` 只读 scope、leases、claims、interactions 四组事实，不触发任何租约续约或对账动作。存储不可读或 schema 版本不受支持时以非零状态失败，而不是输出空快照。理由：一个「看起来正常但什么都没读到」的快照会让使用者误判 Scope 状态，比直接失败更危险。

### D10 模块归属

协调事实类型放 `src/domain/`（不依赖 SQLite、Orca、Ink）；store port 与 DTO 放 `src/application/`；SQLite 实现放 `src/adapters/storage/`；`status` 入口放 `src/interfaces/cli/`；路径解析与 DI 放 `src/bootstrap/`。领域层不得出现 SQL 或文件路径概念。

## Risks / Trade-offs

- **`node:sqlite` 的实验性。** API 可能在 Node 次版本变化，或在不同平台行为不一致。缓解：访问集中在单适配器，且 `status` 与 lease 逻辑都有行为测试；本机只声明 Ubuntu 已验证。
- **租约时间依赖真实时钟。** 时钟漂移可能让短租约出现假过期。本设计保留可配置的租约时长与心跳间隔作为调节位，而不是把时间阈值写死。
- **CAS revision 与高频心跳的相互作用。** 心跳若推进 revision，会让同 Scope 的其它写入频繁失败。设计上心跳只更新 lease 行而不推进 `scope.revision`，把 revision 留给真正的协调事实变更。
- **mutation lane 粒度。** 粒度太细会放过冲突，太粗会阻塞无关工作。当前取「目标对象 + 操作类别」，后续 change 若出现明显误伤再调整。

## Migration Plan

无既有数据需要迁移：`src/adapters/storage/` 目前只有占位文件，`coordination.sqlite` 尚不存在。首次打开时按 D2 建立 schema 并写入初始版本。前驱接缝的漂移处理按 `implementation-plan.md` 第 1 节：如果 M0 交付的 `ExecutionBackend` 或 `OperationOutcome` 形状与本 change 的设计假设不一致，回到规划而不是在本 change 内另立一套。

## Open Questions

无。预算计数的具体消耗规则属于 `m1-plan-and-authorize-execution` 与 `m1-execute-and-validate-work-packages`，本 change 只提供计数存储与原子推进入口，不定义何时扣减。
