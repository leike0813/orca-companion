## Purpose

定义执行期间图演进的分类、来源证据与提交语义，使新发现的执行信息以原子补丁进入图，同时保持历史版本与运行事实可审计。

## Requirements

### Requirement: 图变化必须先分类路由且以 exact baseGraphVersion 起草补丁

系统 SHALL 先把每个图变化请求路由到 `retry_attempt`、`specification_revision`、`graph_patch`、`replanning_transition`、`no_change`、`user_decision_required` 或 `blocked` 之一。语义不清晰时，系统 SHALL 派发一个 Graph Patch Planner Worker（使用 MiniMax-M3）产出结构化补丁草案，而不是由 Controller 猜测分类。每个补丁草案 SHALL 声明其 exact `baseGraphVersion`，并且 MUST NOT 基于未声明的版本起草或应用。

#### Scenario: 明确的重试请求

- **WHEN** 请求表明同一 Worker Task 的既定工作因基础设施原因需要重新执行
- **THEN** 系统路由为 `retry_attempt`，不生成图补丁

#### Scenario: 语义不清晰的请求

- **WHEN** 请求无法被确定性规则归入任何一类
- **THEN** 系统派发 Graph Patch Planner 产出结构化补丁草案，或路由为 `blocked` 等待用户输入

#### Scenario: 版本不匹配的补丁

- **WHEN** 补丁草案声明的 `baseGraphVersion` 与当前图版本不一致
- **THEN** 系统拒绝应用该补丁，并要求以当前版本重新起草

### Requirement: 补丁必须逐一处置未接受后代并通过编译校验

Graph Patch SHALL 以单个原子操作集合表达 `add`、`revise` 与 `retire`，并 SHALL 为 base 版本中的每个未接受后代节点给出一个明确处置：`unchanged`、`graph_revision`、`specification_revision` 或 `retire`。补丁 MAY 声明 `takesOver` 以表示新节点接管某个被处置节点的责任。应用前，Graph Compiler SHALL 校验影响集合、引用完整性、无环、Scope Envelope、预算、授权与版本一致性；任一校验失败则整个补丁被拒绝，任何部分都不得生效。

#### Scenario: 后代逐一处置

- **WHEN** 一个补丁改变了某个节点的依赖
- **THEN** 该节点的每个未接受后代都在补丁中带有明确处置，未列出的后代导致补丁被拒绝

#### Scenario: 编译校验失败

- **WHEN** 补丁的影响集合、引用、无环性、Scope、预算、授权或版本任一校验失败
- **THEN** 整个补丁被拒绝且不写入任何 GraphVersion

#### Scenario: 新节点接管责任

- **WHEN** 补丁声明一个新节点 `takesOver` 某个被处置节点
- **THEN** 系统记录该接管关系，并保留被处置节点的历史

### Requirement: 补丁以 Planner 结果为准一来源证据并只经 Admission 提交

Graph Patch Planner 的 Accepted Worker Result SHALL 作为不可变的来源证据，MUST NOT 被直接提交为图。经 Controller Admission 归一化的 Graph Revision SHALL 只通过 `ExecutionGraphHistory` 的 accepted revision 追加入口提交；Branch Coordination Store SHALL 仅作为该契约的持久化实现，不得提供平行写图路径。提交 SHALL 携带 expected version 与稳定 OperationId，并在写入后回读确认。历史 GraphVersion SHALL 只追加而不可改写，被 retire 的未接受节点 SHALL 保留历史与 worktree，且 MUST NOT 被视为已完成。

#### Scenario: 提交补丁

- **WHEN** Controller Admission 接受 Graph Patch Planner 的结构化结果
- **THEN** Controller 以 expected version 与既有 OperationId 调用 `ExecutionGraphHistory` 追加 Graph Revision，并从同一契约回读确认

#### Scenario: 直接使用 Planner 输出

- **WHEN** 某路径试图把 Graph Patch Planner 的结果直接作为当前图
- **THEN** 系统拒绝该路径，因为只有经 Admission 的归一化 Graph Revision 才能提交

#### Scenario: 重建与退休

- **WHEN** 系统需要当前拓扑，或一个未接受节点被 retire
- **THEN** 当前图从初始 Implementation Plan 与已接受补丁序列重建；被 retire 节点保留历史与 worktree，且不计入完成