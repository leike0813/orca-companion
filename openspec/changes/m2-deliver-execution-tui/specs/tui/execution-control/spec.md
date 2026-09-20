## Purpose

定义 Scope 级 Pause、Resume、Cancel 与前台 Exit 的意图提交、可核验边界与确认语义。

## ADDED Requirements

### Requirement: Scope 级控制粒度与 Pause 与 Resume

控制 SHALL 只作用于整个 Coordination Scope，系统 MUST NOT 提供单个 Work Package 的直接 pause 或 cancel，局部改变 SHALL 由 Coordinator 通过 Graph Revision、Retire 或 Replanning 表达。Pause SHALL 先持久化暂停意图，再阻止新的模型恢复、Task 物化、Worker 派发与 Git 集成；已开始的 Worker、Git merge/commit/CAS、事件落盘与 ack SHALL 运行到可核验边界。Resume SHALL 先对账再恢复调度。Pause MUST NOT 要求用户确认。

#### Scenario: Pause 后不再产生新派发
- **WHEN** 用户在存在 active Work Package 的 Scope 中提交 Pause
- **THEN** 暂停意图被持久化，不再出现新的 Task 物化、派发或集成，已在运行的 Worker 继续到可核验边界

#### Scenario: Resume 先对账
- **WHEN** 用户对已暂停的 Scope 提交 Resume
- **THEN** 系统先对账活跃 Worker 与未决操作，成功后才恢复调度

#### Scenario: Pause 不要求确认
- **WHEN** 用户在存在活跃 Worker 或 Pending Interaction 时提交 Pause
- **THEN** 系统直接执行 Pause，不弹出确认

#### Scenario: 单个 Work Package 的控制入口不存在
- **WHEN** 用户在选择某个 Work Package 后查找控制入口
- **THEN** 界面只提供 Scope 级控制，不提供该 Work Package 的暂停或取消操作

### Requirement: Scope 级 Cancel

Cancel SHALL 先持久化取消意图，再停止模型并请求 Worker 停止。在结果确认为停止或不可核验之前，界面 SHALL 保持 `cancelling`；Cancel MUST NOT 把未知结果呈现为已停止。危险状态下提交 Cancel SHALL 要求用户确认。

#### Scenario: Cancel 保持 cancelling
- **WHEN** 用户对存在活跃 Worker 的 Scope 提交 Cancel，且 Worker 停止结果尚未确认
- **THEN** 界面保持 `cancelling`，不显示为已停止

#### Scenario: Cancel 前要求确认
- **WHEN** 用户在有活跃 Worker、Pending Interaction 或未决操作时提交 Cancel
- **THEN** 系统先要求确认，确认后才持久化取消意图

#### Scenario: 不可核验结果如实呈现
- **WHEN** Cancel 后无法确认某个 Worker 是否已停止
- **THEN** 界面将该 Worker 呈现为不可核验状态

### Requirement: 前台 Exit 与 Ctrl+C

Exit 与 `Ctrl+C` SHALL 只结束 TUI 与前台 Controller，MUST NOT 隐式暂停或取消 Scope。存在活跃 Worker、Pending Interaction 或未决操作时，Exit 与 `Ctrl+C` SHALL 要求确认。退出后系统 MUST NOT 继续调度、验证或集成，且后续恢复时 SHALL 先对账。

#### Scenario: Exit 不等同 Cancel
- **WHEN** 用户在存在活跃 Worker 时确认 Exit
- **THEN** 前台进程退出，Scope 未进入暂停或取消状态，活跃 Worker 可能继续运行

#### Scenario: 危险状态下要求确认
- **WHEN** 用户在存在未决操作时按下 `Ctrl+C`
- **THEN** 系统要求确认后才退出

#### Scenario: 退出后不继续推进
- **WHEN** 前台进程已退出
- **THEN** 不再发生新的调度、验证或集成动作，重新启动时先对账
