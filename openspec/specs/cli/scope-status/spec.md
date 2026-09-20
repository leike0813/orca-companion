## Purpose

定义 `orca-companion status` 的只读快照契约，使使用者与后续 change 能在无 TTY 环境下读取 Coordination Scope 的当前模式、控制状态、Session 注册、claim 与待处理交互，而不触发任何状态推进。

## Requirements

### Requirement: status 提供只读快照

`orca-companion status` SHALL 可带 `--json` 运行，SHALL 在无 TTY 环境下正常工作，SHALL 把机器可读输出写入标准输出、诊断写入标准错误；它 SHALL 是只读操作，SHALL NOT 推进工作流状态、派发 Worker、恢复模型或修改持久化记录。

#### Scenario: 只读查询不改变状态

- **WHEN** status 在 Scope 存在未决意图时被调用
- **THEN** 输出 SHALL 反映当前状态，且持久化记录 SHALL 保持不变

#### Scenario: 无 TTY 运行

- **WHEN** status 在没有 TTY 的管道中运行
- **THEN** 它 SHALL 以机器可读形式输出结果并把诊断写入标准错误

### Requirement: status 输出 Scope 协调事实

`--json` 输出 SHALL 包含当前模式与控制状态、已注册 Coordinator Session、Ticket Claim 归属、Execution Coordination Lease 持有者，以及待处理交互数量；storage 不可读或 schema 版本不符时 SHALL 以非零状态失败并给出可诊断原因。

#### Scenario: 输出必需字段

- **WHEN** Scope 已初始化且存储可读
- **THEN** 输出 SHALL 包含模式、控制状态、Session 注册、claim、lease 与待处理交互字段

#### Scenario: 存储不可读或版本不符

- **WHEN** 数据库无法打开或其 schema 版本不受支持
- **THEN** status SHALL 以非零状态失败，SHALL NOT 输出看似正常的空快照