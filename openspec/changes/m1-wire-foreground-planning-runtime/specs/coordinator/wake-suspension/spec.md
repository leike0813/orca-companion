## ADDED Requirements

### Requirement: User message admission

用户提交的普通 Session 消息 SHALL 先以稳定提交身份写入目标 Session 的持久历史，再作为该 Session 的 Actionable Work 准入；它 SHALL NOT 被解释为 Pending Interaction 回答。暂停时消息 MAY 被保存，但模型 SHALL 等 Resume 对账后才处理。相同提交身份的重放 SHALL 只产生一条消息和一次模型恢复。

#### Scenario: 提交后崩溃
- **WHEN** 用户消息已落盘而模型尚未开始或未完成响应时进程中断
- **THEN** 同一 Session 恢复后 SHALL 处理该消息一次，并保留其原文与提交身份

#### Scenario: 普通消息不回答交互
- **WHEN** 存在未决 Pending Interaction，用户提交普通 Session 消息
- **THEN** interaction SHALL 保持未决；只有绑定 interaction ID 与 expected revision 的回答意图 MAY 满足它

