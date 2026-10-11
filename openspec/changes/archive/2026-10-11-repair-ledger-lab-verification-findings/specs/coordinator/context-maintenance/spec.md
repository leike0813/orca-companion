## ADDED Requirements

### Requirement: Model window caps effective input budget
已配置模型窗口 SHALL 将实际模型输入/压缩预算限制为项目输入预算与该窗口的较小值，项目配置原预算不改写。未知窗口 SHALL 不产生虚假百分比。
#### Scenario: 较小模型窗口
- **WHEN** 用户应用窗口小于项目预算的模型
- **THEN** 维护与请求使用较小上限，超限按既有安全压缩与关闭规则处理
### Requirement: Protocol-correct last request usage
真实调用 usage SHALL 按固定协议语义归一为请求输入/输出/总量，缺失保持未知，不累加历史轮次、不重复计算 cache。累计流式报告 SHALL 不被当作增量相加。
#### Scenario: 不同流式用量语义
- **WHEN** OpenAI 最终报告、Gemini 归一增量或 Anthropic 累计输出报告结束
- **THEN** 接受完整请求真实用量，Anthropic 输出取最后累计值，异常缺失不填零

