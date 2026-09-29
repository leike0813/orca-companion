## ADDED Requirements

### Requirement: 已受理的单次图补丁声明只处理一次

当 Coordinator 为当前用户消息提交单次 `request_graph_patch` 且结果已确定受理时，该消息 SHALL 视为已处理，即使模型尚未输出最终散文响应。该处理事实 SHALL 可在同一 Session 重启后恢复；拒绝、未知或未持久化的结果 SHALL NOT 消费该消息。

#### Scenario: 受理后中断

- **WHEN** 图补丁请求已受理并持久化工具结果，而模型最终响应前进程中断
- **THEN** 恢复后不再把同一条用户消息提交为新工作，也不会重复请求同一补丁

#### Scenario: 请求被拒绝或结果未知

- **WHEN** 图补丁请求被拒绝或结果仍未知
- **THEN** 原用户消息保持待处理，Coordinator 可沿原操作身份处理未知结果或在受控边界内修正拒绝原因
