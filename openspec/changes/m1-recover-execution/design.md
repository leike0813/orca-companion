## Context

本 change 在 `m1-execute-and-validate-work-packages` 之后补上中断与控制的确定性语义。前驱已经冻结 Attempt/Retry、Evidence invalidation、Git integration、Delivery Verdict 与正常 Delivery pipeline 五处接缝：本 change 只能在这些接缝之上增加恢复与控制词汇，不得改变它们的判定。

既有权威归属（见根目录 `CONTEXT.md` 与 `AGENTS.md` 第 8 节）决定本设计的边界：Run/Task/Dispatch/Worker/Delivery/receipt/Accepted Worker Result 归 Orca；代码与 worktree 归 Git 与 Orca；Branch Coordination State 只保存无法从上述来源重建的共享协调事实。Orca 公开接口只提供有界轮询加批次确认（`orca-public-control-contracts.md`），`worker-show` 的存活判定为三值且缺失 host scope 不得读作已退出；`request-show` 的 `absent` 明确不代表未发生。

### 架构合同导入

| 关系 | 合同 | 本 change 的责任 |
|---|---|---|
| Create | IC-09 Recovery、Scope control 与 Execution Handoff；FLOW-04 | 创建 Worker Session Recovery、仅用于 transcript extraction 的 salvage、Scope 控制及 Execution Handoff |
| Create | IC-11 ControllerService | 创建 CLI/TUI 唯一 façade、快照、命令与语义事件合同 |
| Extend | IC-02 ExecutionBackend | 只增加按原 OperationId 的只读对账查询 |
| Extend | IC-03 BranchCoordinationStore | 只增加 mutation lane、Recovery、Scope control 与 `ExecutionHandoffState` 最小记录 |
| Consume | IC-04、IC-07、IC-08；FLOW-02、FLOW-03 | 普通 suspend/Wake 与正常 Delivery pipeline 原样复用；Worker binding/Segment 不重定义 |

Recovery Capsule 只来自 Worker Harness transcript 的 salvage；Coordinator Context Capsule 只服务 Coordinator 历史迁移。`ExecutionHandoffState` 与 `PlanningHandoffProposal` 分属执行、规划两种责任转移，禁止合并。

## Goals / Non-Goals

**Goals:**

- 让 Companion 在任何进程中断、runtime 重启或响应丢失之后，都能以原 OperationId 得出确定结论，或在无法结论时阻塞而不是猜测。
- 让 Worker Harness session 的断裂成为一等可记录事实，并以统一的 Worker Session Recovery 生命周期覆盖全部主要角色，替代 Session 保留业务身份与预算。
- 让 Scope 级控制动作与进程退出都不隐式改变协调状态，也不丢失既有执行责任。
- 让模型恢复只由有界、可去重的 Actionable Work 触发。

**Non-Goals:**

- 不实现 TUI 键位、控件与视觉反馈（M2）。
- 不实现后台 controller、并行 Worker、多 Worker Harness 或 remote attach。
- 不引入第二套状态权威，不新增本地数据库，不复制 Orca 或 Git 事实。
- 不改变前驱冻结的 Attempt/Retry、Evidence invalidation、Git integration、Delivery Verdict 与正常 Delivery pipeline 语义。

## Decisions

### D1：恢复与控制逻辑的模块归属

领域规则放 `src/domain/recovery/` 与 `src/domain/coordination/`，只依赖本层类型；用例放 `src/application/reconciliation/`、`src/application/recovery/`、`src/application/coordination/` 与 `src/application/handoff/`，经 port 调用 store 与 backend；`src/application/controller-service.ts` 只组合这些用例与前驱查询，不复制规则；bootstrap 负责在启动序列中按固定顺序调用它们。`src/workflow/` 不承载恢复规则，恢复后只是继续既有 LangGraph loop。

理由：恢复与控制的判定是可以脱离 LangGraph、Orca 与 Ink 测试的纯逻辑，符合 `AGENTS.md` 第 4 节的依赖方向。备选方案是把对账写进 workflow 节点，被否，因为节点可重跑且会把业务规则复制进图。

### D2：Operation Intent 对账契约

`ExecutionBackend.query` 增加按 OperationId 的只读对账查询，返回前驱已定义的 `OperationOutcome` 三值；adapter 以 Orca `request-show` 实现，`absent` 映射为未决而不是已拒绝。应用层 `reconcileOperations` 接收 store 中的未决 intent 列表与查询结果，产出每个 intent 的确定结论或未决。

理由：`OperationOutcome` 已经表达三值语义，复用它可以避免第二套结果词汇。备选方案是新增恢复专用结果类型，被否。

### D3：mutation lane 阻塞模型

每个外部 mutation 归类到一个 mutation lane（派发、集成、Delivery ack、预算写入等既有类别）。lane 的阻塞状态是 Branch Coordination State 中的显式记录，包含触发它的 OperationId 与阻塞原因；读取路径把它投影进 Workflow Snapshot。阻塞不阻止其他 lane 的读写，也不阻止只读查询。

理由：`AGENTS.md` 第 8 节已经要求"仍不确定则阻塞对应 mutation lane"，把同一规则落到可观测记录上即可，不需要通用依赖图。

### D4：复用正常 Delivery pipeline 的恢复期入口

前驱 `src/application/delivery/process-delivery.ts` 已唯一拥有 read-without-ack → validate → dedupe → Orca accept/readback → local ref/readback → ack。启动对账只调用该入口重放未确认 Delivery，并补充 unknown lane 阻塞和冻结代际的历史处理；本 change 不新增 pipeline、去重类型或 Delivery 持久化字段。

理由：把正常处理与崩溃恢复收敛到同一入口，才能保证重启不会出现第二套 ack 或结果归属规则。

### D5：Worker Session Recovery 生命周期与精确恢复优先

`Worker Session Recovery` 是 Worker Harness session 中断后的唯一恢复生命周期，覆盖 Specification Planner、Implementation、Validator 与 Finalizer；Coordinator Session 恢复不属于它。第一次尝试固定为按精确 Session Binding 恢复原会话；只有确认原会话不可恢复时才创建替代 Session。存活与身份证据不充分时进入 `unverifiable` 并保持未决，不得推断退出或触发重复派发。`salvage` 一词只用于该生命周期内部的 transcript extraction 动作（生成 Recovery Capsule），不作为生命周期、requirement 或角色名称。

理由：`CONTEXT.md` 与 `AGENTS.md` 第 6 节要求精确绑定与三值存活判定；把"先恢复、失败才替代"写成显式顺序可以避免把可恢复的中断误判为需要重建。备选方案是中断即建替代 Session，被否，因为会浪费预算并丢失会话内进展。

### D6：RecoveryId、预写 Operation Intent 与按 Worker Attempt 的 Recovery Budget

每次 Recovery 分配稳定 RecoveryId，并在创建替代 Session 之前预写 Operation Intent；替代 Segment 创建即消耗该 Worker Attempt 的一次 Recovery Budget，消耗值与 RecoveryId 一起持久化。Recovery Budget 按每个 Worker Attempt 独立计数，与实现、验证、修复等业务预算分开；额度从前驱已经批准的 `ExecutionAuthorizationManifest.maxRecoveriesPerWorkerAttempt` 读取，本 change 不增加或修改 Manifest 字段。默认复用该角色原 Worker Profile；仅当 Authorization 显式允许兼容替代时才切换。workspace 丢失或不可对账时 Recovery 失败。

理由：`AGENTS.md` 第 7 节要求预算有限且不被恢复重置，把恢复计数绑定 Worker Attempt 而不是某一种角色，可覆盖四类角色。备选方案是用 Validation Attempt 作为预算键，被否，因为 Planner、Implementation 与 Finalizer 并不属于 Validation Attempt。

### D7：替代 Session 的身份边界与 superseded Segment

替代 Session 保留原 Worker Task、Task Contract、revision 与业务 Attempt，创建新的 Dispatch、Session Binding 与 Session Segment。在替代 Dispatch 被接受之前，若原 Session 到达有效终态，则以该终态结束 Recovery；此后原 Segment 标记为 `superseded`，其迟到结果只入历史。

理由：`AGENTS.md` 第 7 节区分 Revised Worker Task 与 Retry Attempt，并要求迟到结果只补历史。备选方案是让替代 Session 沿用原 Dispatch，被否，因为会破坏 Task/Dispatch/Attempt 的对账关系。

### D8：Recovery Capsule 的内容契约与角色门

Capsule 由受限 Utility Worker 经 Task Envelope 从精确 transcript 提取，结论为 `complete` 或 `partial`。`partial` 必须列出精确可读范围、缺口、最后一个完整事件、未闭合动作、逐项来源与 unknowns；transcript 不可用即 `transcript_unavailable` 失败。Utility Worker 不递归触发 Recovery，但在同一 Recovery Operation 内可安全重派一次，再失败即 Recovery 失败。替代 Session 启动前通过角色门：Planner 要求已落盘的 Specification Unit 无隐藏决定；Implementation 要求 workspace/HEAD/dirty paths 可对账且无未知外部副作用；Validator 要求缺口后判断相关 Evidence 是否失效并重验；Finalizer 不需要 Capsule，从权威输入重跑只读检查。

理由：`AGENTS.md` 第 6 节要求由受限 Utility Worker 从精确 transcript 生成并阻塞不可用时；角色门把"能否安全接续"从通用检查改为按角色可判定。备选方案是只做一种通用 Capsule 校验，被否，因为四个角色的可对账事实不同。

### D9：Scope 控制状态与正交性

Pause、Resume、Cancel、Exit 在领域层表达为与模式正交的控制状态；Resume 与启动都先走同一对账用例。Cancel 先写取消意图再请求停止，未确认时保持 `cancelling` 或 `unverifiable`。Exit 只结束进程，不写控制状态。

理由：`AGENTS.md` 第 7 节明确暂停、阻塞、取消与重规划是正交控制状态。备选方案是给每种控制动作新增模式，被否，因为会破坏模式的既有定义。

### D10：普通唤醒与 Execution Handoff 分离

前驱 `src/application/coordinator/actionable-work.ts`、`suspension.ts` 与 `wake-admission.ts` 已完整拥有普通挂起/唤醒，本 change 不再包装它们。这里只新增 `src/application/handoff/execution-handoff.ts`，以持久化 `ExecutionHandoffState` 表达 `prepared → reviewed → cutover|cancelled|blocked`：prepare 只冻结来源 revision 与目标 Session，review 校验 Source checkpoint、可移植 Coordinator Context Capsule、目标身份和责任集合；只有 cutover 才以 CAS 原子转移 Execution Coordination Lease、相关 Pending Interaction 与当前 Graph Generation 的后续 Worker 生命周期事件责任。Run、Task、Dispatch、Attempt、Worker、worktree、Authorization 和预算身份保持不变；Target 进入 `awaiting_user_prompt`，Worker 事件继续落盘与对账但不替用户激活模型。任何失败都保持 Source 为唯一 owner。

理由：普通 suspend/resume 与责任 cutover 是两种操作。前者复用既有 Wake admission；后者需要一个可恢复的 CAS 状态，才能避免 Source 与 Target 同时拥有执行权。`ExecutionHandoffState` 不复用规划阶段的 `PlanningHandoffProposal`，也不创造含糊的通用交接记录。

### D11：ControllerService 是界面层的唯一应用 façade

`src/application/controller-service.ts` 组合既有查询、Session 消息、手动 compact、Coordinator Model Configuration 切换、`PlanningHandoffProposal` 三阶段用例、Scope 控制、Pending Interaction CAS 回答、Execution Handoff 与语义事件订阅，向 CLI/TUI 暴露运行时校验后的 DTO。它不打开 SQLite、不直接调用 Orca adapter、不拥有状态转换；Scope 初始化仍调用前驱 `initializeCoordinationScope`，避免把创建流程复制进 façade。

理由：M2 需要稳定的查询/命令接缝，而把这些能力散落给 CLI 与 TUI 会导致两套状态推进路径。façade 只组合现有用例，不增加新的领域抽象。

### D12：验收验证的伪造与真实分层

恢复与控制的行为验证以 fake backend 与 fake model 为主，必须覆盖全部角色、预算边界、partial 与不可用 Capsule、迟到结果、重复启动与崩溃窗口；Execution Handoff 一律使用 fake model 与 fake backend，不消耗真实模型调用。真实 harness 只用于一个显式场景：以 MiniMax-M3 的 Validator 跑一次 partial-transcript Recovery，验证 Capsule 缺口与角色门在真实 transcript 下的行为。真实调用 MUST 只在显式选择的隔离项目与专用身份中运行，MUST NOT 触碰用户主项目、重启全局 Orca runtime 或修改上游。

理由：恢复语义的分支数量大，fake 层可以穷举崩溃窗口与迟到路径，真实调用只回答"真实 transcript 能否产生可用 partial Capsule"这一个 fake 层无法证明的问题。备选方案是全部走真实 Orca，被否，因为不可枚举且违反 `AGENTS.md` 第 11 节的隔离要求。

## Risks / Trade-offs

- Orca `request-show` 的 `absent` 语义会让部分 intent 长期停留在未决，表现为 lane 阻塞而不是自动前进。这是有意的失败关闭；用户在补足事实后解除。
- 先精确恢复再替代会增加一次判定与等待。收益是避免把可恢复的中断升级为重建并浪费 Recovery Budget。
- `unverifiable` 会推迟派发，降低吞吐。这是对"不推断退出"的直接代价，按 `AGENTS.md` 第 6 节接受。
- Capsule 的 `partial` 分支需要逐项来源与 unknowns，模板会比其他工件更长；收益是替代 Session 能判断哪些结论可信。
- 每角色门增加四套判定；约束是四者共用同一 Capsule 契约，只在准入条件上分叉。

## Migration Plan

本 change 通过可重入、版本化 migration 增加 mutation lane、RecoveryId/状态、按 Worker Attempt 的 Recovery Budget 用量、Scope 控制与 `ExecutionHandoffState`，并复用前驱已有的 `session_segments`、Delivery 去重引用和 `wake_admissions`。migration 保留所有前驱数据；Execution Authorization Manifest 字段集合保持不变。
