## ADDED Requirements

### Requirement: Effective context without historical rescans

模型输入准备及压缩维护 SHALL 只读取当前有效区间和压缩产物，MUST NOT 扫描已被 Capsule 取代的历史正文。原文 SHALL 继续通过唯一范围读取合同完整可读。有效上下文读取 SHALL 有独立有限预算，超限或事实不可恢复时 SHALL 显式关闭，MUST NOT 静默截断或请求超窗输入。原生窗口与 Capsule 保持独立归属。

#### Scenario: 压缩后继续对话
- **WHEN** 较早历史已被 Capsule 取代，Session 再次准备模型输入或更新维护结论
- **THEN** 实际读取 SHALL 仅覆盖 Capsule 和有效区间，更新结论不改写历史；被替代正文仍可按范围阅读

#### Scenario: 上下文读取无法安全完成
- **WHEN** 当前有效区间超过有限读取预算或存在损坏事实
- **THEN** SHALL 保留全部原文并报告阻塞，不发送截断或伪造的模型输入，不创建替代 Session
