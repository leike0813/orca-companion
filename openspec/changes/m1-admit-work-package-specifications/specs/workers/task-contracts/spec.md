## Purpose

定义 Companion 拥有的 Task Contract 与 Task Envelope 如何固定 Worker 的身份、范围、授权、预算与期望证据，以及 Worker 如何以结构化报告回报候选结果。

## ADDED Requirements

### Requirement: Task Envelope 固定 scope、authority、预算与期望证据

每次派发 SHALL 以一个 Task Envelope 固定该 Worker 的 Work Package、角色、worktree、输入、Scope Envelope、授权、预算上限与期望证据。Task Envelope SHALL NOT 由模型或 Worker 填写 scope、身份、Run、consumer generation 或 operation identity；这些值 SHALL 由 Controller 从可信 Execution Scope 派生。

#### Scenario: 派发携带完整 Task Envelope

- **WHEN** Controller 派发一个 Worker Task
- **THEN** 该次派发携带 Task Envelope，其 Work Package、角色、worktree、authority、预算与期望证据字段均已被 Controller 填定

#### Scenario: Worker 不得提供身份与 scope

- **WHEN** 派发载荷或 Worker 回报中出现由模型填写的 scope、身份、Run、consumer generation 或 operation identity
- **THEN** Controller 忽略这些字段，并以自己派生的可信值继续处理

### Requirement: Worker 以结构化报告与有界证据回报，且报告只算候选结果

Worker SHALL 以结构化 Worker Result 回报任务结果，以 Worker Question 请求缺失输入，以 Worker Escalation 请求超出其 scope、设计、依赖、authority 或预算的协调，并以 Evidence Record 回报其命令或判断。Controller SHALL 将任何 Worker 报告视为候选结果；只有通过身份、角色、版本、worktree、权限、预算与证据校验后，report 才可记为 Accepted Worker Result。

Evidence Record SHALL 限定在受影响的工作区范围内并指向可复核的命令与结果，且 SHALL NOT 携带完整 transcript 或全仓断言。当后续变更触及某个 Evidence Record 的受影响范围时，Controller SHALL 将该记录判定为失效，且不得以失效证据推进生命周期。

#### Scenario: 报告在通过校验前只是候选结果

- **WHEN** Controller 收到一个结构化 Worker Result
- **THEN** 在完成 task、dispatch、attempt、schema、authority 与证据校验之前，该报告不推进任何生命周期

#### Scenario: Worker Question 只暂停依赖它的工作

- **WHEN** Worker 提交一个 Worker Question
- **THEN** Controller 仅把依赖该回答的工作标记为等待，其余工作继续推进

#### Scenario: 超出授权的请求升级为 Worker Escalation

- **WHEN** Worker 的下一步会超出其 Task Envelope 的 scope、依赖授权或预算
- **THEN** Worker 以 Worker Escalation 请求协调，而不在越界范围内继续执行

#### Scenario: 变更触及证据范围后证据失效

- **WHEN** Work Package 的后续变更修改了某个 Evidence Record 所覆盖的工作区部分
- **THEN** Controller 将对应记录判定为失效，并要求新的证据覆盖该范围

#### Scenario: 证据记录保持有界

- **WHEN** Worker 提交 Evidence Record
- **THEN** 该记录限定在受影响的工作区范围内，且不携带完整 transcript 或全仓断言
