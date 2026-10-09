## ADDED Requirements

### Requirement: Trusted configuration and durable turn termination
模型调用前 SHALL 核验不可变可信配置绑定并持久记录轮次 `running`；正常完成进入 `idle`，内部、解析、上下文、工具或落盘错误进入 `halted` 并保存结构化原因。失败后 SHALL 停止后续请求、排队 Wake 与模型维护；持久化失败时本进程也 SHALL 停止。重启遇到未结束轮次或故障 SHALL 等待明确恢复。已提交响应与工具身份保持。

#### Scenario: 生产结构化响应
- **WHEN** 生产宿主取得包含 provider replay 内容的正式 SDK 响应
- **THEN** 响应按 Session 的可信 configurationRef 原子提交并正常完成，不因宿主遗漏绑定而重复生成

#### Scenario: 内部故障和重启
- **WHEN** 请求后的历史提交失败，随后发生轮询、重复事件或重启
- **THEN** 故障可查询，模型不自动再发请求，用户明确重试前保持停止

### Requirement: Classified bounded model retries
网络断连、429 和可重试 5xx SHALL 最多尝试三次；取消、内部错误、解析、配置、上下文、存储、fencing 与输出超限 SHALL NOT 自动重试。手动恢复 SHALL 重验历史、租约与未决副作用，沿用原可信身份。

#### Scenario: 重试上限
- **WHEN** 连续出现 429 或网络断连
- **THEN** 最多发出三个请求，仍失败则停止；定时对账不重新开始另一组三次请求

#### Scenario: 内部错误只失败一次
- **WHEN** SDK 或应用抛出解析、类型或持久化错误
- **THEN** 不追加自动请求，显示结构化失败供用户明确处理
