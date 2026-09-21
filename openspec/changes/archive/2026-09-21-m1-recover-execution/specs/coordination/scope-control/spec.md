## Purpose

定义 Coordination Scope 级暂停、恢复、取消与退出语义，使控制动作在进程边界与活跃 Worker 之间保持确定且可对账。

## ADDED Requirements

### Requirement: Scope 控制动作必须正交且不隐式改变其他控制状态

Pause SHALL 停止新的模型恢复与 Worker 派发，同时 MUST NOT 停止已运行的 Worker、事件落盘或确定性对账。Resume SHALL 先对账再恢复调度，且 MUST NOT 重置已消耗的预算、claim、lease 或 graph revision。Cancel SHALL 先持久化取消意图，再停止模型循环并请求 Worker 停止；停止结果未被确认时 SHALL 保持 cancelling 或 unverifiable，MUST NOT 报告为已停止。Exit SHALL NOT 隐式暂停或取消 Coordination Scope。

#### Scenario: 暂停期间的活跃 Worker

- **WHEN** 用户在存在活跃 Worker 时暂停整个 Coordination Scope
- **THEN** 不再发起新的派发与模型恢复，已运行的 Worker 继续运行，事件落盘与对账继续

#### Scenario: 恢复调度

- **WHEN** 用户恢复被暂停的 Coordination Scope
- **THEN** 系统先对账未决 side effect 与 Worker 状态，再恢复派发与模型恢复，且不重置已消耗资源

#### Scenario: 停止结果未确认

- **WHEN** 用户取消，且 Worker 停止请求的结果无法确认
- **THEN** 系统保持 cancelling 或 unverifiable，并在后续对账中继续尝试确认

#### Scenario: 取消后的迟到事件

- **WHEN** 取消请求之后到达来自该 Worker 的迟到事件
- **THEN** 系统按旧代际处理该事件，不重新激活当前代际或恢复调度

#### Scenario: 退出后重新进入

- **WHEN** 用户退出并在活跃 Worker 仍可能运行时重新启动 Companion
- **THEN** 系统不假设 Worker 已停止，按启动对账重建其真实状态，且不重复派发同一 Worker Task

### Requirement: ControllerService 统一界面层的查询、命令与事件接缝

CLI 与 TUI SHALL 仅通过 `ControllerService` 获取运行时校验后的只读快照、订阅语义事件，以及提交 Session 消息、手动 compact、Coordinator Model Configuration 切换、Planning Handoff、Pause/Resume/Cancel、Execution Handoff 与 Pending Interaction 回答；façade SHALL 只委派到对应既有应用用例，MUST NOT 直接打开 store、调用 Orca adapter 或拥有状态转换。Pending Interaction 回答 SHALL 同时绑定 interaction ID 与 expected revision，revision 过期时 SHALL 拒绝且不把普通聊天当作回答。Scope 初始化 SHALL 复用既有 `initializeCoordinationScope`，不得在 façade 中重写创建规则。

#### Scenario: 过期的 Pending Interaction 回答被拒绝

- **WHEN** 界面通过 ControllerService 提交 interaction ID 正确但 expected revision 已过期的回答
- **THEN** 服务拒绝该回答，Pending Interaction 保持未解决，且不产生 Orca mutation

#### Scenario: 订阅者只收到语义事件

- **WHEN** store 或 backend 产生状态变化、keepalive 与诊断输出
- **THEN** ControllerService 只发布可投影的语义事件，keepalive 与诊断噪声不进入界面事件流
