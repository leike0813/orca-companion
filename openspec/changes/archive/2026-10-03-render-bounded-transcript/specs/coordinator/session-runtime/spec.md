## ADDED Requirements

### Requirement: Streaming model response isolation

生产模型调用 SHALL 消费真实流式响应，临时预览 SHALL 与 Committed Model Step 隔离；完整响应经可信身份、fencing 和原子提交接受后才执行工具。Scope Cancel SHALL 在保存取消意图后停止活跃模型调用；Exit SHALL 停止前台调用但不改变 Scope 控制状态，Pause SHALL 保留在途调用。输出超限、取消和 fencing SHALL NOT 重试或写入部分历史；普通模型故障保持既有有限重试。

#### Scenario: 分片工具调用
- **WHEN** tool call 参数跨多个 chunk 返回
- **THEN** SHALL 仅在完整响应接受后以可信 step/call/operation 身份执行，chunk 和预览不成为工具执行依据

#### Scenario: 中断与租约失效
- **WHEN** 生成期间输出超限、Scope Cancel、前台退出或 Runtime 被 fence
- **THEN** 活跃调用 SHALL 停止，部分响应不提交，取消/超限/失效不被普通模型重试重新启动

#### Scenario: 预览存储不可用
- **WHEN** 临时文件/预览容量不足或预览观察者失败
- **THEN** 预览 SHALL 明确不可用，模型完整响应仍可按原提交合同接受；预览故障不重复模型调用

### Requirement: Verified streamed usage

流式 usage SHALL 只在取得可确认的完整报告时保存。多个 usage 片段的归约语义无法从通用合同确认时 SHALL 保存 null 并显示不可用，MUST NOT 猜测累计/增量规则、估算或加入 provider 特判。

#### Scenario: 完整与不明确 usage
- **WHEN** 一个完整 usage 报告随响应返回，或多个非空 usage 片段需要不明确的合并
- **THEN** 前者保存实际报告，后者保留 null；缺失值不被填零或作为费用事实
