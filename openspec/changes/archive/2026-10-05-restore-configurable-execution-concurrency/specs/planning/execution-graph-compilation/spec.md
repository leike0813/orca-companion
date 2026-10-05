## REMOVED Requirements

### Requirement: Compilation carries budget caps and scope envelopes
**Reason**: 图中固定并发额度与用户可配置执行额度冲突；以仅拥有图容量和每包预算的新合同替换。
**Migration**: 配置与 Manifest 拥有并行额度；图编译不再记录并发策略。

## ADDED Requirements

### Requirement: Compilation carries package budgets and graph capacity
编译 SHALL 为每包带上 Scope Envelope 与有限预算，只取配置与授权输入。当前未 retire 包数量 SHALL 受 maxWorkPackages 限制，默认 8。并行额度 SHALL 不存入图拓扑，也 SHALL 不因额度调整产生 Graph Revision。

#### Scenario: 超限计划不产出可授权候选图
- **WHEN** 计划的预算需求或节点总量超过配置上限
- **THEN** 编译 SHALL 失败并报告超限项，不截断或放宽

#### Scenario: Concurrency independent of topology
- **WHEN** 同一计划按并行额度 1 和 5 编译
- **THEN** SHALL 得到相同图拓扑，额度由 Manifest 绑定
