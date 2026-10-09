## ADDED Requirements

### Requirement: Shared conversation and explicit loop controls
协调与调试 SHALL 共享 transcript、composer、流式预览、历史读取及输入保护；协调工作区保持已批准原型，调试工作区只展示会话和只读工具。`/stop`、`/retry`、Palette 与 Help SHALL 使用唯一命令定义。故障 SHALL 显示原因和停止状态，Ctrl+C 退出意图 SHALL 立即中止模型，再完成草稿保存和退出流程。

#### Scenario: 停止后明确恢复
- **WHEN** 用户执行 stop 或模型故障后执行 retry
- **THEN** stop 停止当前模型轮次而不取消 Scope，retry 核验后恢复原会话；输入与阅读位置保留

#### Scenario: 退出时取消流
- **WHEN** 模型流式生成中用户按 Ctrl+C
- **THEN** 模型立即收到取消，退出保存流程不延长后端请求，取消不触发重试
