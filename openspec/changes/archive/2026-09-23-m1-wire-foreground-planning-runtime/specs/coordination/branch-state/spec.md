## MODIFIED Requirements

### Requirement: 只持久化不可重建的协调事实

Branch Coordination Store SHALL 只保存无法从 issue tracker、Git 当前状态、Orca 与项目配置重建的协调事实，包括用户登记的 Scope 完整 branch ref 与 canonical worktree 绑定、当前模式与 Planning Cycle 引用、graph 与 authorization 引用、Session 注册、Ticket Claim、Pending Interaction、Operation Intent、lease 与 fencing、共享预算状态与 CAS revision。它 SHALL NOT 镜像 Route Map、Git HEAD、工作树当前内容、Orca 的运行时事实，也 SHALL NOT 保存第二份完整工作流状态机。Scope 注册绑定在创建后 SHALL 不可原地改写。

#### Scenario: 写入可重建事实被拒绝

- **WHEN** 调用方试图把 Git HEAD、工作树当前文件状态或 Orca Task 状态写入 store
- **THEN** store SHALL 拒绝该写入，并要求调用方从原始权威源读取

#### Scenario: 拆分两个存储的职责

- **WHEN** 需要保存单个 Coordinator Session 的消息与图位置
- **THEN** 该事实 SHALL 属于 checkpointer 存储，SHALL NOT 写入共享协调状态

#### Scenario: 用户登记的 Scope 绑定

- **WHEN** 用户确认在 canonical worktree 的完整 branch ref 上创建 Scope
- **THEN** store SHALL 原子保存该不可变绑定，并在恢复时以当前 Git 身份重新核验

#### Scenario: 旧记录缺少绑定

- **WHEN** 既有 Scope 记录没有可核验的 branch ref 与 canonical worktree 绑定
- **THEN** 恢复 SHALL 拒绝，直到用户显式完成一次受控绑定；SHALL NOT 从当前 cwd 猜测旧 Scope 身份

