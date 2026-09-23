## Purpose

定义当前 Ubuntu 前台进程如何把已批准的执行计划接入真实 Worker 生命周期，并在退出、重启与外部结果不确定时保持唯一责任、可恢复性和可观察性。

## ADDED Requirements

### Requirement: 授权切换由当前规划事实驱动

前台 Controller SHALL 从当前地图、票据、计划、图、Scope 与用户批准的完整 Manifest 装配切换事实；门禁通过后 SHALL 原子进入 Execution Coordination。任一引用失效或未获批准时 MUST NOT 进入执行模式或派发 Worker。

#### Scenario: 批准后进入执行
- **WHEN** 当前规划产物完整、Manifest 已按当前图版本批准且切换门禁通过
- **THEN** Scope 进入 Execution Coordination，持有唯一 Execution Coordination Lease，并出现当前 Graph Generation 的执行视图

#### Scenario: 规划引用过期
- **WHEN** 批准后地图或候选图版本发生变化
- **THEN** 切换被拒绝，旧批准不触发 Worker 派发

### Requirement: 前台进程串行推进角色工作

前台 Controller SHALL 仅由当前 Execution Coordination Lease 持有者推进 Execution Frontier；每次只物化当前候选的一个角色级任务，并按 Planner、Specification Admission、Implementation、Validator 的现有门禁推进。同一时刻 SHALL 至多有一个 active Work Package；Pause、Cancel、失去租约或未决 mutation SHALL 阻止新的派发。

#### Scenario: 首个候选进入执行
- **WHEN** 已授权图有多个满足依赖的候选且没有活跃 Work Package
- **THEN** 仅一个候选获得隔离 worktree 和当前角色级 Task，其余候选保持等待

#### Scenario: 角色结论推进下一个角色
- **WHEN** 当前角色的结果已被核验并接受，且其后继门禁通过
- **THEN** Controller 为同一 Work Package 派发下一个角色；Validator 通过及集成完成前不启动下一个 Work Package

#### Scenario: 派发结果不确定
- **WHEN** 物化或 Worker 启动的结果无法核验
- **THEN** 当前 mutation lane 保持阻塞，重启后只按原操作身份对账，不生成第二个 Task 或 Dispatch

### Requirement: Delivery 与 Worker Session Recovery 驱动可恢复进度

前台 Controller SHALL 消费当前 Run 的 Delivery 与 Worker 状态，按权威身份接纳结果；只有结果与本地引用均持久化并回读后才确认 Delivery。Worker Session 丢失时 SHALL 按原 Attempt 的 Recovery 规则处理，并把 Capsule coverage 或明确 blocker 作为可观察事实。

#### Scenario: 当前 Validator 完成并修复复验
- **WHEN** 独立 Validator 在授权范围和预算内修复后于同一真实 Session 复验通过
- **THEN** 当前 Work Package 显示已接受的验证结果与有效证据，旧证据失效，集成才可开始

#### Scenario: 旧代际消息晚到
- **WHEN** 已冻结 Graph Generation 或旧 Attempt 的 Delivery 到达
- **THEN** 该消息只补历史并被安全确认，不唤醒当前代际或推进当前 Work Package

#### Scenario: Session 无法恢复
- **WHEN** 精确 transcript 不可用或 Recovery Budget 已耗尽
- **THEN** 当前派发保持阻塞，界面显示原因；不得伪称原 Session 已续接

### Requirement: 重启与 Scope 控制先对账

前台进程 SHALL 在恢复执行派发前对账未决操作、未确认 Delivery、Worker liveness 与未完成 Recovery。Resume SHALL 在对账完成后才恢复调度。Cancel SHALL 在取消意图落盘后请求停止当前 Worker，并只根据可核验 stop verdict 推进控制状态；Exit SHALL 只退出前台进程。

#### Scenario: 活跃 Worker 后重启
- **WHEN** 进程退出时 Worker 仍可能运行，随后从同一 Scope 重启
- **THEN** 首次新派发前可见对账状态；同一 Task、Dispatch、Attempt 不被重复创建

#### Scenario: Resume 对账仍不确定
- **WHEN** 用户请求 Resume 且存在无法确认的 Worker 或操作
- **THEN** 恢复被阻止，相关 lane 与原因可见；未知不被报告为已退出

#### Scenario: Cancel 停止结果不确定
- **WHEN** 用户请求 Cancel 且 Worker stop verdict 无法核验
- **THEN** Scope 保持 cancelling 或 unverifiable，重启后继续按原操作身份核验

### Requirement: 集成后才产生项目级终态

当前 Lease 持有者 SHALL 仅集成 Validator 已接受的 Work Package，并从 Git 与 Orca 权威事实验证结果。全部 Work Package 集成完成后 SHALL 在已冻结集成的 canonical worktree 派发新的只读 Finalizer Session，并比较运行前后 HEAD、index 与 dirty paths；只有独立结论被接受后才呈现 deliverable。

#### Scenario: 集成成功后派发 Finalizer
- **WHEN** 所有 Work Package 验证与集成均完成，且无未决交互或 mutation
- **THEN** Finalizer 在只读约束下检查项目，界面显示运行前后工作区与项目级 Evidence

#### Scenario: 只读或工作区无法核验
- **WHEN** 只读权限无法强制或 Finalizer 运行期间工作区发生变化
- **THEN** 交付保持 blocker，界面不显示 deliverable

#### Scenario: 集成结果不确定
- **WHEN** Git 步骤超时或 canonical HEAD 与预期不符
- **THEN** 受影响集成 lane 保持阻塞，后续派发与 Finalizer 不继续
