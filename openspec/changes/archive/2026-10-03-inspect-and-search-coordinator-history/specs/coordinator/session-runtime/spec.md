## ADDED Requirements

### Requirement: Bounded trusted call inspection

Session SHALL 提供按可信 step/call/operation 身份关联的有界调用清单和参数/结果范围读取，正文仍只有一个权威来源。只读详情与搜索 SHALL 不启动模型、执行工具或产生业务动作，MUST NOT 先完整读取/解析巨大参数再裁切。历史关联索引 SHALL 可从原记录重建并受有限批次约束。unknown SHALL 来自绑定原调用身份的真实结构化观测；观测不成为已完成结果，不改变原操作对账或恢复身份。

#### Scenario: 巨大参数与原文来源
- **WHEN** 一个已提交调用包含超过一次范围预算的参数或结果
- **THEN** 详情和搜索按完整字符边界读取原来源的有限范围，不复制全文为UI历史或发送日志

#### Scenario: unknown与未确认
- **WHEN** 真实工具调用返回unknown，或结果尚未取得/写入
- **THEN** 前者记录可信未知观测，后者保持未确认，不从缺失或自由文案猜unknown；已有配对结果仍优先，恢复不重复已完成工具

#### Scenario: 索引补齐与重放
- **WHEN** 打开已有保留历史或重放同一提交
- **THEN** 关联按有限批次补齐，原参数/结果不改写，相同身份不重复产生调用或活动
