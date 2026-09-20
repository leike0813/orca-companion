## Purpose

定义 Companion 通过公开 Orca CLI 查询与变更编排状态的唯一契约，包括封闭的判别联合、三值操作结果、稳定操作身份、未知结果对账与分离的投递读取/确认原语，使上层用例不必了解 CLI 细节或重试语义。

## ADDED Requirements

### Requirement: 封闭的操作边界与可信执行上下文

Companion SHALL 只通过一个封闭的 `query` / `mutate` 判别联合访问 Orca，每个操作 SHALL 属于已声明目录；调用方 SHALL NOT 拼接任意子命令或直接访问 Orca 数据库与私有 RPC。每个变更操作 SHALL 由 controller 提供 ExecutionScope，模型或调用方 SHALL NOT 自行填写 scope、身份、Run、consumer generation 或 operation identity。

#### Scenario: 未声明的操作被拒绝

- **WHEN** 调用方请求一个不存在于操作目录中的 Orca 子命令
- **THEN** backend SHALL 以 `rejected` 结果失败，且 SHALL NOT 产生任何 Orca 进程调用

#### Scenario: 缺失 scope 时不发起变更

- **WHEN** 变更操作没有附带可信 ExecutionScope
- **THEN** backend SHALL 以 `rejected` 结果失败，且 SHALL NOT 执行外部 mutation

### Requirement: 三值操作结果与未知结果对账

backend SHALL 把每个结果分类为 `accepted`、`rejected` 或 `unknown`，SHALL NOT 以布尔成功标志替代该分类，且 `accepted` SHALL NOT 被解释为 Worker 完成或项目可交付。`unknown` SHALL 以产生它的同一 OperationId 对账，SHALL NOT 换 ID 重试，SHALL NOT 把后端 `absent` 状态或缺失 host scope 读作「未发生」。

#### Scenario: 确定失败仍是 accepted

- **WHEN** Orca 明确记录了一次变更的确定失败结果
- **THEN** backend SHALL 返回 `accepted` 并携带该确定结果

#### Scenario: 不确定结果分类为 unknown

- **WHEN** Orca 返回 `start_unknown`、`stop_unknown`、`outcome_unknown` 或恢复类不确定状态
- **THEN** backend SHALL 返回 `unknown` 并携带可用于对账的 OperationRef

#### Scenario: 对账仍不确定时阻塞该通路

- **WHEN** 按原 OperationId 对账后仍无法判定副作用是否发生
- **THEN** backend SHALL 报告阻塞并保留该 mutation lane，SHALL NOT 自动重放

### Requirement: 投递读取与确认是分离的传输原语

ExecutionBackend SHALL 分别提供读取但不确认 Delivery 的查询原语与按稳定 Delivery identity 确认的 mutation 原语，读取 SHALL NOT 隐式确认。M0 SHALL 保留 Delivery identity、Task、Dispatch、Attempt 与 consumer generation 等后续校验所需字段，但 SHALL NOT 在 adapter 内实现业务落盘、生命周期推进或持久化去重。

#### Scenario: 读取不会隐式确认

- **WHEN** 调用方读取一个 Worker Delivery batch
- **THEN** backend SHALL 返回带稳定 identity 的 Delivery 且 SHALL NOT 同时发起确认

#### Scenario: 确认是独立 mutation

- **WHEN** controller 已完成业务落盘与回读并提交 Delivery identity
- **THEN** backend SHALL 只确认该 identity，且确认结果 SHALL 遵循 OperationOutcome 三值语义
