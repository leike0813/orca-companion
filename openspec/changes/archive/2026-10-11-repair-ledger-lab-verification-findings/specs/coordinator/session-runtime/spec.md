## ADDED Requirements

### Requirement: Empty registered history and bounded visible projection
已注册而尚无首个 checkpoint 的 Session SHALL 提供空历史与活动查询，不创建 checkpoint；未知身份或损坏 SHALL 明确拒绝。assistant 内容块 SHALL 只展示可见 text，保留原始内容、工具、推理及续接身份。显示与搜索 SHALL 使用同一有界派生来源及独立 UTF-8 坐标，不在查询或重绘中解析完整响应。
#### Scenario: 首次进入及协议内容
- **WHEN** 用户进入新注册 Session，随后接收含 text、thought 和 tool_use 的响应
- **THEN** 首次历史为空且无错误，之后只展示文本及既有折叠工具活动，续接数据完整保留
#### Scenario: 长旧响应恢复
- **WHEN** 重开含长 JSON 内容块的旧历史
- **THEN** 有界准备显示投影，查询范围仍有上限，搜索命中与阅读锚点使用相同文本位置
### Requirement: Observable genuine agent turn state
普通与调试宿主 SHALL 呈现选中 Session 的 idle/running/halted 轮次状态，进入和结束轮次 SHALL 通知；Scope active 或租约 MUST NOT 被用作正在运行的替代事实。
#### Scenario: 挂起请求与停止
- **WHEN** 模型请求在途或用户停止该 Session
- **THEN** 分别显示 running 与 halted；其他 Session 不继承该状态

