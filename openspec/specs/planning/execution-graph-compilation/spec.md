# planning/execution-graph-compilation Specification

## Purpose
定义由正式 Implementation Plan 编译候选 Execution Graph 的确定性规则与世代绑定，使图拓扑成为可复核的结构事实而非模型自由发挥。

## Requirements

### Requirement: Deterministic compilation from the Implementation Plan

候选 Execution Graph SHALL 由正式 Implementation Plan 确定性编译，编译过程 SHALL NOT 评判规划语义，且 SHALL 只检查 schema 有效性、引用完整性、无环、Scope Envelope、预算上限与可信配置。

#### Scenario: 同一计划编译出相同拓扑
- **WHEN** 对同一份 Implementation Plan 与相同配置执行两次编译
- **THEN** 两次 SHALL 得到相同的 Work Package 集合与依赖拓扑

#### Scenario: 编译失败即拒绝候选图
- **WHEN** 计划中存在环路、悬空引用、非法 Scope Envelope 或超出预算上限
- **THEN** 编译 SHALL 以显式错误失败并列出原因，SHALL NOT 产出可执行的候选图

### Requirement: Candidate graph binds to one Graph Generation

候选 Execution Graph SHALL 属于一个新的 Graph Generation，拥有自己的 GraphId 与空 Orca Run，并 SHALL 绑定编译时所依据的地图 revision。

#### Scenario: 新规划产生新世代
- **WHEN** 一次 Planning Cycle 产出候选图
- **THEN** 该图 SHALL 使用新的 GraphId 与新的空 Orca Run，且 SHALL NOT 复用前一代的标识或 WorkPackageId

#### Scenario: 地图变更使候选图过期
- **WHEN** 候选图绑定后，其依据的地图 revision 发生变化
- **THEN** 该候选图 SHALL 被视为过期，新的授权 SHALL 以重新编译为前提

### Requirement: Compilation carries budget caps and scope envelopes

编译 SHALL 为候选图的每个 Work Package 带上 Scope Envelope 与预算上限，取值只来自配置与授权输入，且 SHALL NOT 允许图内节点自行放宽。

#### Scenario: 超限计划不产出可授权候选图
- **WHEN** 计划的预算需求超过配置上限
- **THEN** 编译 SHALL 失败并报告超限项，SHALL NOT 静默截断或放宽上限

#### Scenario: 并发上限随图一并固定
- **WHEN** 候选图编译完成
- **THEN** 其中的并发上限 SHALL 为有限值，并作为后续授权的固定输入
