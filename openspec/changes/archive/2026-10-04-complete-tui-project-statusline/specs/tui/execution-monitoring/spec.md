## ADDED Requirements

### Requirement: Shared current contract validator acceptance
状态栏、Sidebar 与 Graph Inspector SHALL 使用同一个当前 GraphId/generation/version 全图摘要。分母 SHALL 是当前未 retire Work Packages；分子 SHALL 仅包含精确当前合同的 Accepted Validator Result，每包至多一次。MUST NOT 将 Task done、Implementation 完成、integration 状态、可见窗口数量、旧合同或旧代际 Validator 结果计入验收；无当前图 SHALL 显示不可用。

#### Scenario: Current contract and retired nodes
- **WHEN** 一个图有旧合同通过记录、重复验证、已 retire 包及尚未通过当前合同的包
- **THEN** 三处显示同一完整当前图数量，各当前有效包仅按当前 Validator 结果计一次，retire 与旧合同记录不计入
