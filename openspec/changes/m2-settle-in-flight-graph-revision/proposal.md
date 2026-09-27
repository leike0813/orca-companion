## Why

已派发 Work Package 被 Graph Patch 修订后会留下 `graph_patch` 持有；前台运行时没有重新规划、准入和结算这条持有的路径，真实隔离运行因此长期停在 `revision_pending`，无法取得 Delivery Verdict。此缺口阻塞 `m2-deliver-execution-tui` 的 5.2 验收。

## What Changes

- 在旧 Worker 的派发与结果均可核验结算后，为仍在当前图中的修订节点启动新的 Specification Planner；持有继续阻止旧结果、后续角色、依赖工作与 Git 集成。
- 新规格通过确定性 Admission 后，以当前补丁身份原子释放持有并计一次 Specification Revision；从新契约继续 Implementation、Validator 与最终交付。拒绝、额度耗尽、事实不可读及重启均保持可见阻塞，不重复派发或扣费。
- 用有界行为测试和两种补丁形态的隔离真实 PTY 验收该闭环。保留已修好的退休持有释放语义。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `execution/specification-revision`：补足在途 Graph Patch 修订持有的可观察结算、旧结果隔离与恢复行为。

## Impact

直接前驱为已归档的 `m2-repair-read-only-worker-sandbox`；本 change 是 M2 执行 TUI 验收的解阻塞并行项，可在 `m2-deliver-execution-tui` 未归档时实施，但同一文件不得由两个 agent 同时编辑。影响修订判定、Execution Frontier、角色物化、前台运行时、Branch Coordination Store 与相关测试；不改变 Orca 私有接口、不升级 submodule、不扩展 TUI 页面。研究记录 §4b 的既有集成状态投影不一致另行处理，避免混入这条结算闭环。
