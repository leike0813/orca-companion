# execution/work-package-delivery Specification

## Purpose

定义 Worker 报告如何在身份、代际与版本核验后被记录为 Accepted Worker Result，以及实现尝试与 Retry Attempt 如何在不改变 WorkerTask、contract 与 revision 的前提下重开。

## Requirements

### Requirement: Worker 报告在身份与代际核验后才成为 Accepted Worker Result

Controller SHALL 在记录 Accepted Worker Result 之前，核验报告对应的 Run、consumer generation、Task、Dispatch 与 Attempt 是否仍属当前代际，并核验角色、版本、worktree 与 Scope Envelope。来自旧代际或旧尝试的报告 SHALL 只用于补充历史与确认，不得推进当前生命周期。核验不通过时，Controller SHALL 拒绝记录并说明失败项。

#### Scenario: 当前代际的报告通过核验后记录

- **WHEN** 报告匹配当前 Run、consumer generation、Task、Dispatch 与 Attempt，且角色、版本与 worktree 一致
- **THEN** Controller 记录该报告为 Accepted Worker Result，并据此推进该 Work Package 的生命周期

#### Scenario: 旧代际报告不推进当前流程

- **WHEN** 报告来自上一代际的 Run 或已被取代的 Attempt
- **THEN** Controller 只记录其历史与确认信息，不推进当前生命周期

### Requirement: Delivery 在权威结果与本地引用均持久化后才确认

Controller SHALL 读取 Delivery 而不立即确认，随后依次执行身份与代际核验、稳定键去重、通过 ExecutionBackend 在 Orca 记录并回读 Accepted Worker Result、在 Branch Coordination Store 持久化去重键与 `AcceptedWorkerResultRef` 并回读，最后才确认 Delivery。Accepted Worker Result 正文 SHALL 只归 Orca；Branch Coordination Store SHALL NOT 保存其副本。上述任一步失败或结果仍为 unknown 时，Controller SHALL 保持 Delivery 未确认，并使用原 OperationId 对账。

#### Scenario: 权威结果与本地引用落盘后确认

- **WHEN** 当前代际 Delivery 通过核验，Orca 已记录并可回读 Accepted Worker Result，且本地去重键与结果引用已持久化并回读
- **THEN** Controller 确认该 Delivery，并且本地不存在 Accepted Worker Result 正文副本

#### Scenario: 接受结果或本地引用未确定时不确认

- **WHEN** Orca 接受结果、receipt 回读或本地去重引用持久化中的任一步失败或保持 unknown
- **THEN** Controller 不确认该 Delivery，以原 OperationId 对账，且不推进 Work Package 生命周期

#### Scenario: 重放已结算 Delivery 不重复记录结果

- **WHEN** Controller 再次读取到已有相同稳定去重键与 `AcceptedWorkerResultRef` 的 Delivery
- **THEN** Controller 回读并核验既有 Orca 结果后确认 Delivery，不创建第二份 Accepted Worker Result 或本地正文副本

### Requirement: 实现完成、验证通过与项目可交付是三个独立事实

Controller SHALL 分别表达 Implementation 完成、Validator 通过某个 Worker Task、以及项目可交付这三种状态，且 SHALL NOT 由其中任一推出另一项。Worker 通知、进度消息与自我报告 SHALL 只作为候选结果，不构成任一状态的成立。

#### Scenario: 实现完成不表示验证通过

- **WHEN** 某 Work Package 的 Implementation Worker 报告完成
- **THEN** 该 Work Package 的验证状态仍为未验证，直到 Validator 给出并接受独立结果

#### Scenario: 全部任务通过不自动表示项目可交付

- **WHEN** 所有 Work Package 均通过验证
- **THEN** Controller 仍要求一个独立的项目级交付结论，才可宣告项目可交付

### Requirement: Retry Attempt 保持 WorkerTask、contract 与 revision 不变

当一次尝试被判定为结论性失败或中断且满足正常重试条件时，Controller SHALL 以新的 Dispatch 与 Attempt 重开，且 SHALL 保持 WorkerTask、Task Contract 与 Specification Revision 不变。新 Attempt SHALL 作为独立尝试开始，不得伪装为原 session 或原 Attempt 的恢复；重开 SHALL NOT 重置已消耗的实现尝试、修复、Graph Revision 或 Specification Revision 预算。

#### Scenario: 结论性失败后新开尝试

- **WHEN** 某 Worker Task 的一次尝试被判定为结论性失败
- **THEN** Controller 为该同一 Worker Task 创建新的 Dispatch 与 Attempt，且其 contract 与 revision 与之前完全一致

#### Scenario: 重开不重置预算

- **WHEN** 一次尝试因中断而被重开
- **THEN** 该 Work Package 已消耗的实现尝试与修复预算计数保持不变

#### Scenario: session 丢失时只走正常重试或阻塞

- **WHEN** Worker Harness session 丢失，且当前 change 尚无 Worker Session Recovery 能力
- **THEN** Controller 仅在正常 Retry Attempt 条件成立时创建新 Dispatch 与 Attempt，否则记录 blocker；不得生成 Capsule 或把新 session 当作原 Attempt 的继续

#### Scenario: 需要改变 contract 时不予重试

- **WHEN** 继续执行需要改变 WorkerTask 的 contract 或其 Specification Revision
- **THEN** Controller 不按 Retry Attempt 处理，而是走契约修订路径