## Why

规划 TUI 交付后，用户可以在前台完成规划与授权，但授权之后的执行阶段仍无界面：Work Package 生命周期、预算、blocker、Scope 级控制与 Finalizer 结论都只能从命令行拼凑。M2 的第二项工作把 Execution Coordination 投影进同一个常驻主视图，使 M2 的真实端到端闭环可被观察、控制和验收。

## What Changes

- 授权后不切换应用页面、不重置 transcript 与 composer；顶栏显示 Graph Generation、Execution Authorization、Scope control state 与 active Work Package 计数。
- 进程重启后先进入 reconciling 投影，对账完成前不得推进执行；该门禁复用 Controller 的既有对账语义，TUI 只展示。
- 完整 Sidebar 展示完整图的稳定拓扑、Execution Frontier、当前 active Work Package 及其角色/attempt/liveness/worktree/baseline、Validation 与 Evidence、串行 integration queue、预算与 attention；Execution Coordination 并发上限固定为 1，因此同时最多一个 active Work Package。排队中的 Work Package 仍出现在完整图中，但不进入 active 状态。紧凑态保留图关系、短 key、关键状态与告警；折叠态只在顶栏留计数。
- Graph 节点使用编译后的稳定拓扑位置，状态变化不重排；过滤只隐藏节点，不改变相对顺序；Inspector 在 Sidebar 内沿依赖导航并查看 revision、attempt、evidence、integration 与 blocker。
- Work Package 投影区分 waiting、ready/admitting、specifying、implementing、validating、repairing、waiting integration、reconciling、revision pending、blocked/unknown、accepted/retired/cancelled；Worker liveness 单独显示 `live`、`exited`、`unverifiable`。
- Event Drawer 只展示 Task、Worker、Attempt、validation/repair/recovery、integration、Graph change、控制与 Finalizer 等语义事件；keepalive、轮询超时与重复 delivery 不进入用户时间线。
- Pause 与 Resume 作用于整个 Coordination Scope：Pause 先保存意图再阻止新的 model 恢复、Task 物化、派发与集成，已开始的 Worker、Git merge/commit/CAS、事件落盘与 ack 运行到可核验边界；Resume 先对账再恢复调度。
- Cancel 先持久化取消意图再停止模型并请求 Worker 停止，界面保持 `cancelling` 直到 `stopped` 或 `unverifiable`；Exit 与 `Ctrl+C` 只结束前台 Controller，有活跃 Worker、Pending Interaction 或未决操作时必须确认，Pause 不确认。
- Finalizer 投影明确其运行于 canonical worktree 与只读 Profile、集成已冻结，并展示运行前后的 HEAD、index 与 dirty paths 及项目级 Evidence；只读无法强制、工作区变化或验证失败只映射为 blocker，不得显示 deliverable。
- 复用规划 TUI 已交付的 handoff 交互与 Command Palette 完成 Execution Handoff，不新增应用页面；不改变 Run、Task、Dispatch、Attempt、Worker、worktree、Execution Graph、Authorization 与预算身份，Cutover 后 Target 处于 `awaiting_user_prompt`，Source checkpoint 不可恢复时 fail closed。已交付的 Worker Session Recovery 状态展示继续保留。
- 复用规划 TUI 已交付的 snapshot 与 intent 通道：CLI/TUI 只消费快照、提交用户意图，不推进状态、不调用 Orca、不恢复模型、不实现重试。

## Capabilities

### New Capabilities

- `tui/execution-monitoring`: 授权后工作区连续性、执行图与 Frontier 投影、单 active Work Package 生命周期与串行 integration queue 展示。
- `tui/execution-control`: Scope 级 Pause/Resume/Cancel 与 Exit 的意图提交和确认语义。
- `tui/recovery-observability`: Worker Session Recovery、superseded、partial coverage、Execution Handoff、unknown/unverifiable 与有界投影的可观察性。
- `tui/delivery-finalization`: Finalizer 只读门禁与 Delivery Verdict 的终态投影。

### Modified Capabilities

无。本 change 只新增独立 capability，不修改已归档主规格。

## Impact

- 直接前驱：`m2-deliver-planning-tui`（常驻主视图、三态 Sidebar、Session Picker、Event Drawer 骨架、snapshot/intent 通道与零副作用渲染已归档）。
- 承接的 M1 会话语义：#34 的 Worker Session Recovery 状态展示保留，并在执行态复用 #32 的 Handoff 交互完成 Execution Handoff。TUI 不实现 Recovery 或 Handoff 的领域逻辑。
- 新增代码面：`src/interfaces/tui/`（执行视图模型与 Frontier/queue/Finalizer 投影）、`src/application/`（执行查询与 Scope 控制意图端口接线）、`src/interfaces/cli/`（`status --json` 扩展执行快照字段）。
- 依赖：不新增；复用 `ink`、`react` 与 `ink-testing-library`。
- 测试：Vitest 组件测试；真实 PTY 端到端验收在 Ubuntu 本机进行。
- 不在本 change 内：单个 Work Package 直接 pause/cancel、并行 Worker 执行、新的应用页面、后台 daemon、远程 attach、headless 入口、对 Windows 或无人值守运行的支持声明。
