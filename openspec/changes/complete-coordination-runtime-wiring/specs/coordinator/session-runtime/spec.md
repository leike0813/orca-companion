## MODIFIED Requirements

### Requirement: Committed model step and durable resumption identity

模型循环 SHALL 只在一次 Coordinator Agent 响应及其 tool calls 被原子接受为 Committed Model Step 之后才继续下一步；恢复 SHALL 沿用原 Coordination Scope、Coordinator Session、Planning Cycle 与已消耗预算。模型响应与工具结果 SHALL 从该 Session 最新的已提交状态追加，并校验稳定条目身份；写入期间已受理的其他条目（例如新的用户消息）MUST NOT 被旧快照覆盖或丢失。

#### Scenario: 未完整提交的响应不进入历史
- **WHEN** 一次模型响应在中途中断
- **THEN** 该响应 SHALL NOT 成为已提交历史的一部分，重启后模型循环 SHALL 从最后一次 Committed Model Step 之后继续

#### Scenario: 恢复不创建新身份
- **WHEN** 同一 Coordination Scope 的 Session 在进程重启后恢复
- **THEN** SHALL 复用原 Coordinator Session 身份、Planning Cycle 与已消耗预算，且 SHALL NOT 隐式创建新的 Session、Planning Cycle 或运行身份

#### Scenario: checkpoint 不可恢复时 fail closed
- **WHEN** 现有 Session 的 checkpoint 损坏或无法读回，且没有其他方式恢复同一会话
- **THEN** Session SHALL 持久保存 blocked 生命周期及结构化原因并可在重启后查询；若该 Session 持有 Execution Coordination Lease，Scope SHALL 同时进入持久 blocked 控制状态；SHALL NOT 创建替代 Coordinator Session、SHALL NOT 以空历史继续、SHALL NOT 转移 Ticket Claim 或 Execution Coordination Lease

#### Scenario: 模型等待期间受理的消息不被覆盖
- **WHEN** 一次模型响应或工具结果写入期间，同一 Session 受理了一条新的用户消息
- **THEN** 该消息在写入完成后仍存在于会话历史中，后续模型输入包含它

#### Scenario: checkpoint blocker 重启后仍存在
- **WHEN** checkpoint 损坏已经使执行 Lease holder 阻塞，前台退出并重启
- **THEN** Session 与 Scope 的 blocker 保持可查询，模型与新派发不恢复；只有原 checkpoint 经核验可恢复并完成 Resume 对账后才解除阻塞
