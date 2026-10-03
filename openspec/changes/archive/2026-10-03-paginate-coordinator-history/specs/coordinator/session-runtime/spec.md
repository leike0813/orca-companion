## ADDED Requirements

### Requirement: Incremental authoritative conversation records

Session SHALL 以稳定消息、响应、调用和 Wake 身份增量保存会话记录，正文 SHALL 只有一个权威来源。普通追加、图位置更新、提交核验及工具恢复 MUST NOT 读取或重新序列化整个历史。消息与 Wake、完整响应与调用、结果与处理来源 SHALL 原子提交。身份与内容相同的重放 SHALL 幂等，冲突 SHALL 拒绝并保持原记录。恢复 SHALL 精确读取最后一次响应及配对结果，保持原操作身份和 existing Wake admission 补齐语义。

#### Scenario: 长历史中追加与核验
- **WHEN** 一个 Session 已有大量已提交历史，再提交消息、模型响应或工具结果并核验原 submission
- **THEN** 实际读写 SHALL 只处理本次记录和所需身份，原历史保持不变，模型等待期间受理的消息仍保留

#### Scenario: 原子提交失败与重放
- **WHEN** 提交中途失败，或同身份相同/不同载荷再次提交
- **THEN** 失败 SHALL 不留下半条消息或半个 Wake；相同载荷不重复，不同载荷拒绝，跨库中断按原 Wake 身份补齐

#### Scenario: 精确工具恢复
- **WHEN** 响应已提交、部分工具已完成且进程重启
- **THEN** SHALL 以原 call/operation 身份只续办未配对调用，unknown 保持未知，已完成工具不重新调用
