## MODIFIED Requirements

### Requirement: Model-bound authorization and explicit model reapproval

Manifest v4 SHALL 完整绑定各生产角色的不可变 `modelSelection`（harness、model、effort 与目录来源）、并行包额度、图容量与集成复验预算；旧版本 Manifest（v1/v2/v3）SHALL 被明确拒绝，MUST NOT 被当作包含模型授权，也不自动迁移。执行期限定更新 SHALL 仅改变模型选择或并行额度，并经完整指纹和 Scope revision 重新批准；SHALL 保持 Graph Generation、Run、其他权限、政策和预算消费，不创建 Graph Revision。取消、重规划和未决 mutation SHALL 拒绝重新授权。

#### Scenario: 重新批准生效于新任务

- **WHEN** 用户保存配置后审阅并批准完整新 Manifest
- **THEN** SHALL 追加唯一授权并推进当前指针；既有 Task 不重启且预算不重置

#### Scenario: 陈旧审阅或重复批准

- **WHEN** graph head 或 Scope revision 在审阅后变化，或重复提交原批准
- **THEN** 陈旧输入 SHALL 无部分更新地拒绝，同载荷重放 SHALL 回读原记录

#### Scenario: 旧 Manifest 明确拒绝

- **WHEN** 读取 Manifest v1、v2 或 v3
- **THEN** SHALL 以结构化原因拒绝，不补默认模型选择、不按当前配置推断

### Requirement: Materialized tasks retain exact model authorization

Task 在派发意图前 SHALL 持久化原 authorization id/version/profile；Retry、替代 Session 和同一 Validator 修复 SHALL 使用原配置的 harness、model 与 effort。新 Recovery Utility Task SHALL 固定创建时的 `modelSelection`。历史结果 SHALL 只在对应物化绑定、当前 scope/run/generation/contract/attempt 均核验后结算，缺失绑定 SHALL 阻塞。

#### Scenario: 老任务结果和重试

- **WHEN** 模型重新授权后原 Task 返回、重试或恢复
- **THEN** 沿原授权配置结算或启动，仍拒绝跨 generation、陈旧 contract 或 attempt；不把任意历史授权视为当前权限

#### Scenario: unknown 和重启

- **WHEN** 派发响应丢失或物化后进程重启
- **THEN** 回读原绑定并使用原 OperationId 对账，不生成新身份或读取当前可变默认值
