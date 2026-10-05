# planning/execution-authorization Specification

## Purpose
定义 Execution Authorization Manifest 的完整性、执行预算绑定、原子批准与版本化授权记录，使一个 Graph Generation 只有在一次明确批准之后才可能被派发。

## Requirements

### Requirement: Manifest completeness and atomic approval

Execution Authorization Manifest SHALL 一次性绑定 Destination、Route Map 与 Implementation Plan revision、Graph Generation 与 GraphId、Coordination Scope、baseline HEAD、空 Orca Run、Worker Profiles、角色权限、active Work Package、实现尝试、Validator 修复、Graph Revision、Specification Revision 与每个 Worker Attempt Recovery 的有限上限、workspace 与 Git/Dependency Policy 以及 accepted risks，任何字段缺失时 SHALL NOT 提交批准；授权 SHALL 来自用户对完整 Manifest 的一次原子决定，Companion SHALL NOT 分次批准、按任务批准、由后继 change 补字段或以 Coordinator 自己的判断代替用户批准。

#### Scenario: 缺字段不提交批准
- **WHEN** Manifest 缺少 baseline HEAD、预算上限、`maxRecoveriesPerWorkerAttempt` 或 Git/Dependency Policy 中任一项
- **THEN** 批准请求 SHALL 被拒绝，Manifest SHALL NOT 进入待批准状态

#### Scenario: Manifest 与候选图严格对应
- **WHEN** Manifest 引用的 Graph Generation、地图 revision 或计划 revision 与实际候选图不一致
- **THEN** 批准 SHALL 失败并报告不一致项

#### Scenario: 单次决定覆盖整份 Manifest
- **WHEN** 用户批准一份 Manifest
- **THEN** 授权 SHALL 覆盖该 Manifest 的全部字段并记录其版本，SHALL NOT 只对其中一部分生效

#### Scenario: 未获批准时不产生可执行授权
- **WHEN** 用户尚未批准或拒绝批准
- **THEN** SHALL 不存在有效的 Execution Authorization，候选图 SHALL 保持惰性

#### Scenario: 恢复上限显式绑定且取默认值
- **WHEN** 组装一份 Manifest 而用户未指定恢复上限
- **THEN** `maxRecoveriesPerWorkerAttempt` SHALL 被显式写入 Manifest 并取默认值 `1`，SHALL NOT 留空或由执行阶段隐式推断

#### Scenario: 初始化向导不询问恢复上限
- **WHEN** 用户通过初始化向导创建 Coordination Scope
- **THEN** 向导 SHALL NOT 询问 `maxRecoveriesPerWorkerAttempt`，该值 SHALL 留待 Execution Authorization Manifest 阶段确定

### Requirement: Authorization authorizes bounded operations

有效授权 SHALL 覆盖其 Graph Generation 内的普通 Worker 派发、策略内依赖变更与受控 Git 集成，且 SHALL NOT 覆盖发布、部署或越界外部操作；执行阶段 SHALL 按 Manifest 绑定的 `maxRecoveriesPerWorkerAttempt` 约束单次 Worker Attempt 的恢复次数，且 SHALL NOT 在执行中放宽该值。

#### Scenario: 策略内操作不再逐次审批
- **WHEN** 某次派发、依赖变更或 Git 集成落在已批准 Manifest 的策略内
- **THEN** 该操作 SHALL 不需要新的用户批准，但 SHALL 仍受 Manifest 的 expected revision 与预算约束

#### Scenario: 越界操作需要单独授权
- **WHEN** 操作属于发布、部署或 Manifest 未覆盖的外部副作用
- **THEN** SHALL 需要单独的用户授权，执行 SHALL 被拒绝直到授权存在

#### Scenario: 恢复次数受 Manifest 约束
- **WHEN** 某个 Worker Attempt 需要恢复，且已用恢复次数达到 Manifest 绑定的上限
- **THEN** 该 Attempt SHALL 停止并升级，SHALL NOT 自动放宽上限或越过授权耗尽恢复次数

#### Scenario: 改变恢复上限需要重新授权
- **WHEN** 需要把 `maxRecoveriesPerWorkerAttempt` 调整为不同于已批准 Manifest 的值
- **THEN** SHALL 产生新版本的 Manifest 与新的用户批准，执行 SHALL NOT 直接沿用旧授权

### Requirement: Model-bound authorization and explicit model reapproval
Manifest v3 SHALL 完整绑定各生产角色的不可变模型配置、并行包额度、图容量与集成复验预算。执行期限定更新 SHALL 仅改变模型配置或并行额度，并经完整指纹和 Scope revision 重新批准；SHALL 保持 Graph Generation、Run、其他权限、政策和预算消费，不创建 Graph Revision。取消、重规划和未决 mutation SHALL 拒绝重新授权。

#### Scenario: 重新批准生效于新任务
- **WHEN** 用户保存配置后审阅并批准完整新 Manifest
- **THEN** SHALL 追加唯一授权并推进当前指针；既有 Task 不重启且预算不重置

#### Scenario: 陈旧审阅或重复批准
- **WHEN** graph head 或 Scope revision 在审阅后变化，或重复提交原批准
- **THEN** 陈旧输入 SHALL 无部分更新地拒绝，同载荷重放 SHALL 回读原记录

### Requirement: Materialized tasks retain exact model authorization
Task 在派发意图前 SHALL 持久化原 authorization id/version/profile；Retry、替代 Session 和同一 Validator 修复 SHALL 使用原配置。新 Recovery Utility Task SHALL 固定创建时配置。历史结果 SHALL 只在对应物化绑定、当前 scope/run/generation/contract/attempt 均核验后结算，缺失绑定 SHALL 阻塞。

#### Scenario: 老任务结果和重试
- **WHEN** 模型重新授权后原 Task 返回、重试或恢复
- **THEN** 沿原授权配置结算或启动，仍拒绝跨 generation、陈旧 contract 或 attempt；不把任意历史授权视为当前权限

#### Scenario: unknown 和重启
- **WHEN** 派发响应丢失或物化后进程重启
- **THEN** 回读原绑定并使用原 OperationId 对账，不生成新身份或读取当前可变默认值
