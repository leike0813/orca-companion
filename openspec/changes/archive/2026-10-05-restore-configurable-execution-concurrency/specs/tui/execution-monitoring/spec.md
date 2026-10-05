## MODIFIED Requirements

### Requirement: 授权后工作区连续性
进入 Execution Coordination 后 SHALL 保持 transcript、composer 和焦点；顶栏显示 Scope control state 与风险摘要，Graph 和授权引用按现有区域呈现。Sidebar SHALL 显示真实活动包列表、占用数及批准额度，允许多个活动包；角色阶段和 Worker liveness SHALL 分开表达。重启 SHALL 先对账，不在对账完成前推进执行。

#### Scenario: 授权不重置工作区
- **WHEN** 用户批准 Execution Authorization Manifest
- **THEN** transcript、composer 与焦点 SHALL 保持，图、授权和活动包摘要按事实更新

#### Scenario: 重启先对账
- **WHEN** 重启发现活跃 Worker 或未决操作
- **THEN** 界面 SHALL 显示 reconciling，不重复派发或集成

#### Scenario: Multiple active packages
- **WHEN** 多个包占用批准额度
- **THEN** 状态 JSON 和界面 SHALL 呈现完整活动 ID 列表及真实计数，不裁成单包

