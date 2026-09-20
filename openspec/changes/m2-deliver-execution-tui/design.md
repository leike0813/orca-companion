## Context

本 change 是 M2 的第二项，直接前驱为 `m2-deliver-planning-tui`。冻结接缝是前驱已交付的常驻 transcript/composer 主视图、三态 Sidebar、Session Picker、Event Drawer 骨架，以及「CLI/TUI 只消费快照与提交意图」的零副作用渲染约束。本 change 在其上增加执行阶段投影与控制意图，不新增页面，也不改动领域状态机。

与实现直接相关的既有约束：Execution Coordination 只有一个 Execution Coordination Lease holder，并发上限固定为 1，每个 Work Package 使用隔离 worktree；Task Materialization 是即时的，不得预建整图；Worker liveness 至少保留 `live`、`exited`、`unverifiable`；Pause/Resume/Cancel 均作用于整个 Coordination Scope；Delivery Verdict 只能来自独立只读 Finalizer 并由确定性 controller 接受。TUI 不写 Branch Coordination Store，也不写 checkpoint。

### 架构合同导入

| 关系 | 合同 | 本 change 的责任 |
|---|---|---|
| Extend | IC-12 Presentation projection、CLI 输出与进程生命周期 | 在同一 `TuiViewModel` 与组件骨架中增加执行态字段、控件和事件投影 |
| Consume | IC-11 ControllerService | 所有执行查询与控制意图只经 façade，不新增界面专用 controller |
| Consume | IC-08、IC-09、IC-10 | Delivery、Recovery、Handoff 与 Graph evolution 仅经 IC-11 snapshot/event 投影进入界面 |

本 change 不复制 Accepted Worker Result 正文、Capsule schema、Execution Graph 或任何持久化状态；React 组件不拥有业务规则。

## Goals / Non-Goals

**Goals:**

- 在同一主视图中可观察串行执行、预算、blocker、integration queue 与 Finalizer 结论。
- 让 Scope 级 Pause、Resume、Cancel 与 Exit 的意图提交语义可辨认且可核验。
- 让 Recovery、Execution Handoff、unknown 与 unverifiable 状态如实可见，避免把不确定呈现为确定。

**Non-Goals:**

- 不提供单个 Work Package 的 pause 或 cancel，也不实现并行 Worker 执行；局部改变只能由 Coordinator 走 Revision、Retire 或 Replanning。
- 不实现新的应用页面、后台 daemon、远程 attach、headless 入口或无人值守运行。
- 不实现 Recovery、对账、集成或派发的领域逻辑；本 change 只投影既有事实。
- 不声明 Windows 支持。

## Decisions

### D1：执行阶段复用同一主视图，不切换页面

授权后 TUI 只更新顶栏与 Sidebar 内容，transcript 与 composer 保持原内容与焦点。理由：AGENTS.md 第 9 节要求 transcript 与 composer 为主视图，切换页面会丢失对话上下文，也会让「重启先对账」难以在同一位置表达。备选是独立的执行仪表盘页面，但会增加一套导航与焦点模型。

权威来源：Controller 的 Scope 模式与 graph 引用快照。失败关闭：模式未知时按只读展示，不推断。

### D2：并发上限固定为 1，节点位置来自编译后的稳定拓扑

Execution Coordination 的执行并发上限固定为 1，不随初始化或配置改变：Execution Frontier 串行推进，任一时刻最多一个 Work Package 处于 active 状态，其余候选以 waiting 或排队形式出现在完整图中。Sidebar 与 Inspector 的节点位置由 Execution Graph 的稳定拓扑确定，状态变化只更新标识；过滤只隐藏不匹配节点。理由：AGENTS.md 明确首版并发上限为 1，且每个 Work Package 使用隔离 worktree；固定并发也让「active 计数」退化为二值语义，界面无需表达并发调度。执行中反复重排会让用户失去空间记忆，也不利于对比两次快照；备选是按状态分组排序，但会把「拓扑关系」与「状态聚合」混在同一视图。

权威来源：Execution Graph 的 GraphVersion 拓扑。失败关闭：拓扑不可用时只显示计数与 blocker。

### D3：Pause、Resume 与 Cancel 是意图，不是界面状态

TUI 提交 Pause、Resume 或 Cancel 意图后，界面只反映 Controller 已持久化的控制状态；`cancelling` 这类中间态由 Controller 记录，界面不得自行推进到终态。危险状态下的确认在 TUI 层完成，但确认结果仍需作为一次意图提交。理由：AGENTS.md 第 9 节明确 Exit 与 Ctrl+C 只退出前台，Pause 与 Cancel 的语义由 Controller 拥有；界面自行推断会与对账结果冲突。备选是乐观界面更新，但会把 unknown 结果伪装为成功。

权威来源：Branch Coordination State 的控制状态。失败关闭：未知或未确认结果按待对账展示。

### D4：可核验边界的展示以 Controller 的边界定义为准

Pause 后「已开始的 Worker、Git merge/commit/CAS、事件落盘与 ack 运行到可核验边界」以及 Resume 的「先对账」都由 Controller 决定，TUI 只展示对应状态与计数。理由：这些边界的权威在 Controller 与 Orca 事实，界面重复实现会产生第二权威源。备选是在 TUI 内轮询并等待，但会把长轮询与重试引入渲染路径。

权威来源：Controller 与 Orca 事实。失败关闭：对账未完成时显示 reconciling，不显示可推进。

### D5：Recovery、superseded 与 coverage 复用 Event Drawer 与 Sidebar

Recovery 的 Session Segment、剩余 Recovery 预算、`complete` 或 `partial` coverage、被 superseded 的原 Segment 与失败 blocker 分别进入 Event Drawer 与 active Work Package 详情，不新增视图。理由：前驱已建立语义事件通道与信息分层，新增专用视图会破坏分层并增加投影成本。备选是独立的 Recovery 面板，但 M2 整体要求不新增页面。

权威来源：Worker Session Recovery 记录、本地 `AcceptedWorkerResultRef` 与经 ExecutionBackend 回读的 Orca 权威结果。TUI 不接收或持久化 Accepted Worker Result 正文副本。失败关闭：材料不足以判定时显示 blocker，不推断恢复结果。

### D6：unknown 与 unverifiable 是一等展示状态

界面把 mutation 的 `unknown` 与 liveness 的 `unverifiable` 呈现为待对账或不可核验，既不显示为失败也不显示为停止。理由：AGENTS.md 第 6 节要求不可达或信息不完整不能推断退出或触发重复派发；界面若把它们显示为已停止，会诱导用户或后续逻辑错误重派。备选是把 unknown 归入 failed，但这会丢失去重语义。

权威来源：Operation Outcome 的三值语义与 Worker liveness。失败关闭：无法核验即如实展示，不自动重试。

### D7：Finalizer 门禁在界面显式表达

界面显示 Finalizer 运行于 canonical worktree 与只读 Profile、集成已冻结，以及运行前后 HEAD、index 与 dirty paths 的对比；只读无法强制、工作区变化或验证失败只映射为 blocker。理由：Delivery Verdict 是项目级判断，界面若在门禁不满足时显示 deliverable，会让用户把单包验证通过当成可交付。备选是只在最终结论处提示，但门禁失败原因必须可见才能行动。

权威来源：Finalizer 的 Project Delivery Verdict 与 Git 事实。失败关闭：门禁不满足即 blocker。

### D8：投影有界，隐藏内容不计算

Sidebar 在折叠态只显示顶栏计数；紧凑态保留图关系、短 key、关键状态与告警；隐藏的 Work Package 详情与高频事件详情不参与计算，事件以有界批量刷新。理由：AGENTS.md 的 UI 附加规则要求 UI 对象的读取与投影严格有界，高频更新的 DOM 区域必须专门检查性能。备选是渲染全部细节并依赖终端裁剪，但那会在每个事件上做全量投影。

权威来源：应用层快照与语义事件批次。失败关闭：快照读取超界时降级为计数展示。

### D9：依赖与验证边界

本 change 不新增运行时依赖，复用前驱引入的 `ink`、`react` 与 `ink-testing-library`。自动测试覆盖 Frontier 串行推进、单 active Work Package、串行 integration、Pause/Resume/Cancel/Exit 竞态、旧 generation 事件、Finalizer 门禁、三态 Sidebar、图位置稳定、有界投影与无 TTY；真实 PTY 端到端验收在 Ubuntu 本机进行。理由：M2 的完成标准要求这些行为可核验，且验收样例的 Coordinator、Planner、Implementation、Validator、Recovery Utility、Graph Patch Planner 与 Finalizer 都必须显式使用 `minimax-cn/MiniMax-M3`。备选是只做组件测试，但重绘零副作用与竞态必须在真实 PTY 下验证。

权威来源：package.json 与 isolate 集成项目选择。失败关闭：无法在隔离环境中运行的真实调用不得作为验收证据。

### D10：Execution Handoff 复用前驱交互

Execution Handoff SHALL 复用前驱已交付的 handoff 交互与 Command Palette 入口，并经 ControllerService 提交 M1 `ExecutionHandoffState` 的 prepare/review/cutover；它不得复用 `PlanningHandoffProposal` 或创建通用交接记录。界面不新增页面，也不改变 Run、Task、Dispatch、Attempt、Worker、worktree、Execution Graph、Authorization 与预算身份。Cutover 后 TUI 自动选中 Target、Source transcript 只读、Target 处于 `awaiting_user_prompt`；Source checkpoint 不可恢复或无法生成 Coordinator Context Capsule 时 fail closed 并以 blocker 呈现。理由：M1 已把 Cutover、责任转移与激活门定义为一次 CAS，界面重复实现会产生第二权威源；复用前驱组件让规划态与执行态保持一致交互，但领域记录仍明确分开。

权威来源：Controller 的 `ExecutionHandoffState` 与 CAS 结果。失败关闭：步骤失败即不激活 Target，保持 Source 为唯一 owner。

## Risks / Trade-offs

- **执行阶段信息密度高。** 三态 Sidebar 与有界投影是成本与可读性的折中；若用户需要更细的 Work Package 历史，应通过 Event Drawer 而非扩大 Sidebar。
- **控制意图与界面状态之间存在短暂不一致。** 界面只反映已持久化状态，用户提交后可能看到滞后；这比乐观更新更不易误导。
- **真实 PTY 端到端依赖本机环境。** 无法在 CI 复现的能力（串行 Frontier 推进、Validator repair、canonical 前进后的 reconciliation）必须在隔离项目中显式运行，否则该条验收不成立。
- **旧 generation 迟到事件的处理正确性依赖前驱的 fencing。** 本 change 只验证其可见性，不重新实现隔离逻辑。

## Migration Plan

1. 在 `src/interfaces/tui/` 扩展执行阶段视图模型与 Sidebar/Inspector 投影，复用前驱组件骨架。
2. 在应用层补齐执行查询与 Scope 控制意图端口接线，不改变既有 Controller 用例。
3. 扩展 `status --json` 的输出字段以包含执行快照视图，保持 stdout 可解析。
4. 更新用户文档与 compatibility 说明，只声明当前 Ubuntu 本机前台 TUI。
5. 无回滚难点：移除执行投影后规划 TUI 与 CLI 一次性命令仍可用。

## Open Questions

无。是否需要跨重启保留 Sidebar 密度与是否需要单个 Work Package 的控制入口都已在范围内明确排除。
