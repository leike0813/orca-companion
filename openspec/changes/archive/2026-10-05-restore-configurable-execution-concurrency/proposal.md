## Why

执行驱动把一个 Execution Coordination Lease holder 错当成一个 Worker 额度，忽略已配置并发并造成运行和产品决议漂移。用户已批准恢复多包并行，默认 3 可配置，并要求 TUI 设置与执行期重新批准。

## What Changes

- **BREAKING**：统一 `maxActiveWorkPackages` 为并行包额度，默认 3；`maxWorkPackages` 为当前图容量，默认 8；删除图和配置中重复的 `concurrencyLimit`。不提供旧配置/旧 Scope 升级。
- 在外部派发前事务预留额度；多个独立包并行，包内角色串行，未知结果只阻塞所属 lane。
- 串行 Git 集成支持 canonical 前移后的原 Validator 会话复验，独立有限集成复验预算。
- TUI 提供并发设置、明确重新授权和多活动包投影；额度降低时自然收尾。

## Capabilities

### New Capabilities
- `configuration/execution-settings`: 项目默认额度保存与执行期显式批准。

### Modified Capabilities
- `coordination/concurrency-control`: 包级原子准入、恢复和额度释放。
- `planning/execution-graph-compilation`: 图容量与调度额度分离。
- `planning/execution-authorization`: 并发绑定和限定额度重新批准。
- `execution/git-integration`: 合并后精确 Validator 会话复验和有限预算。
- `tui/execution-monitoring`: 多活动包投影。

## Impact

直接前驱为已归档 `complete-tui-graph-basis`，冻结基线 `055c148bf037af825c6c099e38fda85317133731`。本次修正 M1/M2 本机闭环；不增加后台运行、远程控制、新依赖或通用调度框架。影响领域合同、Branch Store、应用调度、现有 adapters、bootstrap、CLI/TUI 和行为测试。依据为 #13 多 lane 决议及本次用户明确选择；当前 AGENTS 串行条款随实现更正。
