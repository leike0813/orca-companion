## ADDED Requirements

### Requirement: Explicit Session compaction request

用户 SHALL 能为选中的 Coordinator Session 请求一次手动上下文压缩；请求 SHALL 使用与自动维护相同的有界输入和压缩规则，并将最近一次结论保存为该 Session 可恢复的状态。`context_exhausted` SHALL 阻止新的模型请求，直到上下文恢复或用户明确交接；`compaction_degraded` SHALL 作为告警显示，SHALL NOT 自动创建新 Session。

#### Scenario: 手动压缩成功
- **WHEN** 挂起的 Session 收到有效压缩请求且上下文可安全收敛
- **THEN** 请求 SHALL 返回路径与结果，重启后仍能读到最近结论，底层历史 SHALL 保留

#### Scenario: 压缩不能收敛
- **WHEN** 所有允许的压缩路径都不能把输入带回预算内
- **THEN** Session SHALL 呈现 `context_exhausted` 与原因，SHALL NOT 发起新的超窗模型请求

