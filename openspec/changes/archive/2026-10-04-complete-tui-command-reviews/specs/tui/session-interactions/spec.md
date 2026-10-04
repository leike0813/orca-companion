## ADDED Requirements

### Requirement: 精确选择与语义审阅
Session、现有模型及交接接收方选择 SHALL 支持独立字面搜索，并按对象身份保持选择。模型查询与切换 SHALL 绑定调用时的 Session。交接 SHALL 使用本次 prepare 的精确 ID，确认/取消 SHALL 绑定用户审阅的 revision；授权 SHALL 保留原 fingerprint/revision。审阅 SHALL 消费可信语义栏目并有界滚动，默认返回；过期内容 SHALL 要求重新读取与明确确认，MUST NOT 自动批准更新内容。

#### Scenario: 多条交接记录
- **WHEN** Scope 存在另一待审阅交接且用户 prepare 新交接
- **THEN** 只审阅本次返回 ID 的提案，Source/Target 与责任真实，不能取首个候选替代

#### Scenario: 审阅期间内容变更
- **WHEN** 授权 fingerprint、交接 revision 或目标归属发生变化后用户确认
- **THEN** 原确认被拒绝，保留审阅入口并明确要求重读，不偷换批准对象

#### Scenario: 非责任 Session 的模型目录
- **WHEN** 用户为明确选中的 Coordinator Session 打开现有模型目录并切换
- **THEN** 当前配置、准入和结果均属于该 Session，不按 Scope 默认责任 Session 解释
