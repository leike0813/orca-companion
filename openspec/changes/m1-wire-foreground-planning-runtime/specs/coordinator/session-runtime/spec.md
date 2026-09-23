## ADDED Requirements

### Requirement: Durable tool-call execution and result pairing

模型返回的每个受支持 tool call SHALL 在已提交的模型响应之后由受控工具处理，并以原 call 身份记录结果，供下一次模型调用与重启后的会话使用。每次调用 SHALL 重验 Scope、Session、模式、权限、revision 与预算；副作用结果未知时 SHALL 保留原操作身份等待对账，SHALL NOT 换身份重试。未知工具或无法配对的 call SHALL 明确阻塞或返回结构化拒绝，SHALL NOT 静默跳过。

#### Scenario: 工具回合被实际执行
- **WHEN** 模型在一次完整响应中请求受支持的规划工具
- **THEN** 工具 SHALL 被调用，配对结果 SHALL 出现在同一 Session 后续模型输入和 transcript 中

#### Scenario: 响应提交后崩溃
- **WHEN** 模型响应已持久化而工具结果尚未持久化时进程中断
- **THEN** 恢复 SHALL 沿用原 call 与操作身份核验结果，SHALL NOT 重复发起已接受的外部副作用

#### Scenario: 连续工具回合
- **WHEN** 同一 Session 连续完成至少 100 个不同的受控工具调用
- **THEN** 模型 loop SHALL 继续按业务预算处理，SHALL NOT 被固定的低 step 上限提前终止

