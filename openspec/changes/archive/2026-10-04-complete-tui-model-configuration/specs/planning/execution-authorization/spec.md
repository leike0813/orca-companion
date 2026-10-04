## ADDED Requirements

### Requirement: Model-bound authorization and explicit model reapproval
Manifest v2 SHALL 完整绑定各生产角色的不可变 profile、harness、provider connection、model、effort、非秘密 options 与 credentialRef。执行期更新 SHALL 仅改变模型配置并经完整 Manifest 指纹和 Scope revision 重新批准；SHALL 保持 Graph Generation、Run、权限、上限、政策、已消耗预算，不创建 Graph Revision。Replanning、cancelling 或未决派发 mutation SHALL 拒绝重新授权。

#### Scenario: 重新批准生效于新任务
- **WHEN** 用户保存配置后审阅并批准完整新 Manifest
- **THEN** 追加唯一授权记录且原子推进当前指针，新物化 Task 使用新 profile，既有 Task 不重启，预算不重置

#### Scenario: 陈旧审阅或重复批准
- **WHEN** 配置、graph head 或 Scope revision 在审阅后变化，或重复提交原批准
- **THEN** 陈旧输入拒绝且无部分更新；同一已受理操作回读原记录，不重复授权或派发

### Requirement: Materialized tasks retain exact model authorization
Task 在派发意图前 SHALL 持久化原 authorization id/version/profile；Retry、替代 Session 和同一 Validator 修复 SHALL 使用原配置。新 Recovery Utility Task SHALL 固定创建时配置。历史结果 SHALL 只在对应物化绑定、当前 scope/run/generation/contract/attempt 均核验后结算，缺失绑定 SHALL 阻塞。

#### Scenario: 老任务结果和重试
- **WHEN** 模型重新授权后原 Task 返回、重试或恢复
- **THEN** 沿原授权配置结算或启动，仍拒绝跨 generation、陈旧 contract 或 attempt；不把任意历史授权视为当前权限

#### Scenario: unknown 和重启
- **WHEN** 派发响应丢失或物化后进程重启
- **THEN** 回读原绑定并使用原 OperationId 对账，不生成新身份或读取当前可变默认值
