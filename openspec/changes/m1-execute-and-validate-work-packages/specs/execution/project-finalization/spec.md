## Purpose

定义在所有 Work Package 通过验证之后，独立只读 Finalizer 如何检查整个项目、给出项目级交付结论，以及 Controller 如何接受或阻塞该结论。

## ADDED Requirements

### Requirement: Finalizer 使用新的只读项目级会话

当所有 Work Package 均通过验证且不存在未决交互或未结算 mutation 时，Controller SHALL 派发一个独立的 Finalizer，并使用一个新的、只读权限的项目级 harness 会话。Finalizer SHALL 检查整个项目而非单个 Work Package，且 SHALL NOT 修改代码、Specification Unit、配置或 Git 历史。

#### Scenario: 全部通过后派发只读 Finalizer

- **WHEN** 所有 Work Package 均通过验证且无未决交互
- **THEN** Controller 派发一个使用只读项目级会话的独立 Finalizer

#### Scenario: 存在未决工作时不予收尾

- **WHEN** 仍有 Work Package 未通过验证，或存在未决交互与未结算 mutation
- **THEN** Controller 不派发 Finalizer，并保持项目未收尾状态

### Requirement: Delivery Verdict 由独立结论构成并被确定性接受

Finalizer SHALL 以结构化的 Delivery Verdict 报告项目级结论与阻塞项。Controller SHALL 在核验该 Finalizer 的角色、会话、证据与其覆盖范围后接受该结论；Controller SHALL NOT 以 Worker 完成通知或单任务验证结论替代项目级交付结论。当结论为阻塞时，Controller SHALL 记录阻塞项并保持项目不可交付状态。

该结论 SHALL NOT 改写 Execution Graph、Accepted Worker Result、Git 历史或 Operation Intent 记录；当 Finalizer 的证据与这些既有权威事实不一致时，Controller SHALL 报告不一致并阻塞，而不是以收尾结论覆盖它们。

#### Scenario: 接受可交付结论

- **WHEN** Finalizer 返回可交付结论且 Controller 核验通过其角色、会话与证据
- **THEN** Controller 记录该 Delivery Verdict，并将项目标记为可交付

#### Scenario: 阻塞结论保持不可交付

- **WHEN** Finalizer 返回带阻塞项的结论
- **THEN** Controller 记录阻塞项，并保持项目不可交付状态直到阻塞项被解决

#### Scenario: 发现不一致时阻塞

- **WHEN** Finalizer 的证据与已记录的 Accepted Worker Result 或集成记录不一致
- **THEN** Controller 报告不一致并阻塞交付结论
