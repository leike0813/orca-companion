## ADDED Requirements

### Requirement: Real harness end-to-end verification
核心验收 SHALL 经真实 CLI、PTY、正式 SDK 和本地脚本 HTTP/SSE 服务覆盖问候、工具续接、断流、内部失败、取消和重启。验收 SHALL 核验请求次数、已提交历史及原身份，不以预览 fake ports 替代生产装配。真实 provider 验收 SHALL 在隔离会话内设置请求上限并记录实际证据。

#### Scenario: 生产链路中的终止故障
- **WHEN** 本地服务对真实 CLI 返回断流或工具响应，或测试装配注入提交错误
- **THEN** 正常响应及工具结果提交，错误停止，等待与重启不增加请求，退出后无遗留请求
