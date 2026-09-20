## Purpose

定义 Coordination Scope 内共享协调状态的持久化契约：保存无法从 issue tracker、Git、Orca 或项目配置重建的事实，并以预期 revision 的乐观并发控制允许多个 Coordinator Session 安全共享同一份状态。

## Requirements

### Requirement: 只持久化不可重建的协调事实

Branch Coordination Store SHALL 只保存无法从 issue tracker、Git、Orca 与项目配置重建的协调事实，包括当前模式与 Planning Cycle 引用、graph 与 authorization 引用、Session 注册、Ticket Claim、Pending Interaction、Operation Intent、lease 与 fencing、共享预算状态与 CAS revision。它 SHALL NOT 镜像 Route Map、Git、Orca 的运行时事实，也 SHALL NOT 保存第二份完整工作流状态机。

#### Scenario: 写入可重建事实被拒绝

- **WHEN** 调用方试图把 Git HEAD、worktree 路径或 Orca Task 状态写入 store
- **THEN** store SHALL 拒绝该写入，并要求调用方从原始权威源读取

#### Scenario: 拆分两个存储的职责

- **WHEN** 需要保存单个 Coordinator Session 的消息与图位置
- **THEN** 该事实 SHALL 属于 checkpointer 存储，SHALL NOT 写入共享协调状态

### Requirement: 预期 revision 的乐观并发控制

每次共享状态写入 SHALL 携带调用方读到的 expected revision；store SHALL 在同一事务内校验并原子推进 revision。revision 不匹配时写入 SHALL 被拒绝并返回当前 revision，SHALL NOT 覆盖并发写入者的结果。

#### Scenario: 过期 revision 被拒绝

- **WHEN** 两个 Session 基于同一 revision 先后写入
- **THEN** 后写入者 SHALL 收到 stale revision 拒绝，且先前写入 SHALL 保持不变

#### Scenario: 短事务与事实一致性

- **WHEN** 一次写入需要同时更新多个相关记录
- **THEN** store SHALL 在单个事务内完成并保持约定的一致性不变式，SHALL NOT 持有跨调用的长期写者锁

### Requirement: 模式与 Planning Cycle 引用

store SHALL 显式保存 Coordination Scope 的当前模式（`route_planning` 或 `execution_coordination`）与当前 Planning Cycle 引用，并 SHALL 把暂停、阻塞、取消与 Replanning Transition 表达为与模式正交的控制状态。

#### Scenario: 非法模式被拒绝

- **WHEN** 调用方请求写入未声明的模式
- **THEN** store SHALL 拒绝写入并保留原有模式

#### Scenario: 控制状态不改变模式

- **WHEN** Scope 被暂停或取消
- **THEN** 当前模式 SHALL 保持不变，控制状态 SHALL 单独记录

### Requirement: Coordinator Session 注册

store SHALL 保存 Coordinator Session 的注册记录，包含所属 Coordination Scope、Session 标识、Coordinator Model Configuration 绑定引用与生命周期状态；同一 Scope 内多个 Session 的注册 SHALL 可共存且互不覆盖。

#### Scenario: 多 Session 共存

- **WHEN** 同一 Scope 注册第二个 Coordinator Session
- **THEN** store SHALL 保留两条独立注册记录，且 SHALL NOT 覆盖第一条

#### Scenario: 跨 Scope 注册被拒绝

- **WHEN** 一个 Session 试图注册到不属于它的 Coordination Scope
- **THEN** store SHALL 拒绝该注册