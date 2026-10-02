## MODIFIED Requirements

### Requirement: 前台 Exit 与 Ctrl+C

Exit 与 `Ctrl+C` SHALL 只结束 TUI 与前台 Controller，MUST NOT 隐式暂停或取消 Scope。存在活跃 Worker、Pending Interaction 或未决操作时，Exit 与 `Ctrl+C` SHALL 要求确认。存在未保存输入时，Exit 与 `Ctrl+C` SHALL 先尝试立即保存；保存失败时 SHALL 默认留在界面并提示，用户可重试、清理记录，或在再次明确确认后丢弃未保存输入并退出。退出后系统 MUST NOT 继续调度、验证或集成，且后续恢复时 SHALL 先对账。

#### Scenario: Exit 不等同 Cancel
- **WHEN** 用户在存在活跃 Worker 时确认 Exit
- **THEN** 前台进程退出，Scope 未进入暂停或取消状态，活跃 Worker 可能继续运行

#### Scenario: 危险状态下要求确认
- **WHEN** 用户在存在未决操作时按下 `Ctrl+C`
- **THEN** 系统要求确认后才退出

#### Scenario: 退出前保存未保存输入
- **WHEN** 用户在存在未保存草稿时退出
- **THEN** 系统先立即保存该草稿，成功后才退出

#### Scenario: 保存失败默认不退出
- **WHEN** 退出时的立即保存失败
- **THEN** 系统默认留在界面并提示失败，只有用户重试、清理或再次明确确认丢弃后才退出

#### Scenario: 退出后不继续推进
- **WHEN** 前台进程已退出
- **THEN** 不再发生新的调度、验证或集成动作，重新启动时先对账
