## ADDED Requirements

### Requirement: Finite output and context read budgets

项目配置 SHALL 提供有限正整数 output.maxResponseBytes 与 context.maxReadBytes，默认分别为 8 MiB 和 16 MiB。输出预算 SHALL 覆盖文本、内容块和工具参数，超限 SHALL 中断且不接受部分响应。上下文读取 SHALL 按配置限制正文、元数据及上下文材料，保留既有输入 token 与条数上限；读取超限 SHALL 明确阻塞，不截断权威原文、不以空历史继续。

#### Scenario: 默认与非法配置
- **WHEN** 预算未显式设置，或配置为零、负数/非有限/非整数
- **THEN** 未设置时使用上述默认值，非法值在启动前拒绝

#### Scenario: 输出与上下文超限
- **WHEN** 流式输出超过配置预算，或有效上下文超过读取/输入预算
- **THEN** 输出超限中断不提交，读取/输入超限明确阻塞；正式原文仍可通过局部范围阅读
