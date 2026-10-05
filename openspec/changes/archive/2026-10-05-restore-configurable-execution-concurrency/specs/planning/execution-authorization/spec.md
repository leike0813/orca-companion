## MODIFIED Requirements

### Requirement: Model-bound authorization and explicit model reapproval
Manifest v3 SHALL 完整绑定各生产角色的不可变模型配置、并行包额度、图容量与集成复验预算。执行期限定更新 SHALL 仅改变模型配置或并行额度，并经完整指纹和 Scope revision 重新批准；SHALL 保持 Graph Generation、Run、其他权限、政策和预算消费，不创建 Graph Revision。取消、重规划和未决 mutation SHALL 拒绝重新授权。

#### Scenario: 重新批准生效于新任务
- **WHEN** 用户保存配置后审阅并批准完整新 Manifest
- **THEN** SHALL 追加唯一授权并推进当前指针；既有 Task 不重启且预算不重置

#### Scenario: 陈旧审阅或重复批准
- **WHEN** graph head 或 Scope revision 在审阅后变化，或重复提交原批准
- **THEN** 陈旧输入 SHALL 无部分更新地拒绝，同载荷重放 SHALL 回读原记录

