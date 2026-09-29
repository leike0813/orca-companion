## Purpose

定义 Finalizer 只读门禁与 Delivery Verdict 的终态投影，确保只有真实可交付的项目被呈现为 deliverable。

## ADDED Requirements

### Requirement: Finalizer 门禁与 Delivery Verdict 投影

Sidebar SHALL 明确 Finalizer 运行于 canonical worktree 与只读 Worker Profile，并显示集成已冻结。界面 SHALL 展示 Finalizer 运行前后的 HEAD、index 与 dirty paths 以及项目级 Evidence。只读无法强制、工作区发生变化或验证失败时，系统 SHALL 只呈现 blocker，MUST NOT 呈现 deliverable。系统 SHALL 只在独立的只读 Finalizer 结论被确定性 controller 接受后投影 deliverable，并 SHALL 区分 implement 完成、单包 validation 通过与项目可交付三种事实；被接受的 blocker 结论 SHALL 与 deliverable 呈现为不同终态。

#### Scenario: 只读无法强制时阻塞
- **WHEN** 当前 Worker Harness 无法保证 Finalizer 的只读 Profile
- **THEN** 界面呈现 blocker，不显示交付结论

#### Scenario: 工作区在运行期间变化
- **WHEN** Finalizer 运行前后比较发现 HEAD、index 或 dirty paths 发生变化
- **THEN** 界面呈现 blocker，不显示交付结论

#### Scenario: 成功完成后显示证据
- **WHEN** Finalizer 在只读条件下完成检查并返回项目级 Evidence
- **THEN** 界面显示前后 HEAD、index、dirty paths 与 Evidence 引用

#### Scenario: 单包验证通过不等于可交付
- **WHEN** 所有 Work Package 均通过验证但 Finalizer 尚未返回结论
- **THEN** 界面不显示 deliverable，仅显示各包已接受

#### Scenario: blocker 结论明确呈现
- **WHEN** 被接受的 Finalizer 结论为 blocked
- **THEN** 界面显示该终态与对应 blocker 原因，不显示 deliverable
