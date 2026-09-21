## Why

M1 串行闭环在 `m1-execute-and-validate-work-packages` 之后已经能派发、结算并集成 Worker，但进程中断、Orca runtime 重启、Worker Harness session 断裂以及用户施加的控制动作都还没有确定的恢复语义。缺少这一层，Companion 只能在理想路径上运行：重启后可能重复派发、把丢失的外部响应当作未发生，或者把替代 Session 伪称为原会话。

## What Changes

- 新增启动对账：Runtime Incarnation 在恢复模型与派发之前，必须以原 OperationId 与 receipt 对账全部未决 Operation Intent；无法证明未产生副作用时阻塞对应 mutation lane。
- 扩展前驱唯一的 Delivery pipeline：启动时重放未确认 Delivery，并对 unknown 与旧代际/旧 Attempt 做恢复期处理；不复制前驱已经固定的正常处理顺序与去重记录。
- 新增统一的 **Worker Session Recovery** 生命周期，覆盖 Specification Planner、Implementation、Validator 与 Finalizer：先尝试精确恢复，稳定 RecoveryId 加预写 Operation Intent，替代 Session 保留原 Worker Task/contract/revision/业务 Attempt 而创建新 Dispatch 与 Session Segment，Recovery Budget 按每个 Worker Attempt 独立并从 Execution Authorization Manifest 取默认与上限。
- 新增按角色门的 Recovery Capsule：complete 或 partial，partial 必须列出可读范围、缺口、最后完整事件、未闭合动作、逐项来源与 unknowns。`salvage` 一词只描述该生命周期内部的 transcript extraction 动作。
- Codex Worker 以工作树内的隔离 `CODEX_HOME` 承载临时配置、项目 trust、session 与 hook 状态，并只在 Companion 已核验 hook 来源后使用进程级 hook trust bypass。Worker Harness Adapter 以封闭的 Worker Launch Strategy 选择 Orca 直接启动，或先建立受控 terminal 再由 `worker-start --terminal` 正式接管；不得写用户级 Codex 配置、修改 Orca 全局 Agent 默认值，或把尚未被 Orca 接管的 terminal 当作 Worker。
- 新增 Coordination Scope 级 Pause、Resume、Cancel 与不隐式暂停或取消的 Exit 行为。
- 新增供 CLI/TUI 复用的 `ControllerService` 应用 façade，统一只读快照、语义事件订阅、Session 消息、手动 compact、模型配置切换、`PlanningHandoffProposal`、Scope 控制与绑定 revision 的 Pending Interaction 回答；Scope 初始化继续复用前驱的 `initializeCoordinationScope`，Execution Handoff 方法随本 change 的对应服务接入。
- 新增 Execution Handoff：`ExecutionHandoffState` 记录 prepare/review/cutover；cutover 前 Source 保持唯一 owner，cutover 以 CAS 原子转移 Execution Coordination Lease、相关 Pending Interaction 与当前 Graph Generation 的后续 Worker 生命周期事件责任，同时保持 Run、Task、Dispatch、Attempt、worktree、Authorization 与预算身份不变。挂起与普通唤醒不构成交接。
- 不实现：TUI 控件与键位（M2）、后台 controller、并行 Worker、多 Worker Harness、新的 Recovery 模型。

## Capabilities

### New Capabilities

- `recovery/controller-reconciliation`: 启动、崩溃恢复与外部响应丢失时的未决副作用对账、mutation lane 阻塞，以及既有 Delivery pipeline 的恢复期重放。
- `recovery/worker-sessions`: Worker Session Recovery 生命周期，包括精确恢复优先、RecoveryId 与 Operation Intent、按 Worker Attempt 的 Recovery Budget、替代 Session 身份、Recovery Capsule 与角色门。
- `coordination/scope-control`: Coordination Scope 级的暂停、恢复、取消与退出语义。
- `coordinator/execution-handoff`: `ExecutionHandoffState` 驱动的执行责任 prepare/review/cutover；普通挂起与 Wake Batch 继续由既有 `coordinator/wake-suspension` 拥有。

### Modified Capabilities

无。本 change 只新增独立 capability，不改变既有 capability 的 requirement。

## Impact

- 领域层与应用层新增 `src/domain/recovery/`、`src/domain/coordination/`、`src/application/reconciliation/`、`src/application/recovery/`、`src/application/coordination/`、`src/application/handoff/` 与 `src/application/controller-service.ts`。
- `BranchCoordinationStore` 通过版本化 migration 增加 mutation lane、Recovery、Scope 控制与 `ExecutionHandoffState` 的最小记录；复用前驱已有的 Session Segment、Delivery 去重引用和 Wake admission，不引入第二份状态权威。
- `ExecutionBackend.query` 需要暴露按 OperationId 的只读对账能力，复用 Orca `request-show` 的三值语义。
- 真实 Codex Recovery 验收要求 Companion 实现受控的 prepared-terminal 启动、Orca 正式接管与显式清理；任一步无法核验时 fail closed，并保持该验收未完成。
- 直接前驱为 `m1-execute-and-validate-work-packages`；冻结接缝为 Attempt/Retry、Evidence invalidation、Git integration、Delivery Verdict 与正常 Delivery pipeline。
- 不新增依赖，不改 schema、项目配置。
