## Why

Coordinator Session 运行时已经可用，但 Companion 还不能完成一次正式规划，也不能把规划责任或执行授权安全地交接给下一个阶段：Route Map 与 Decision Ticket 的操作、Execution Graph 的确定性编译、Execution Authorization Manifest 与用户批准，以及规划 Session 之间的责任转移都还没有实现，因此任何 Worker 都不能被合法派发。

## What Changes

- 新增 Route Planning 语义操作：在 issue tracker 上维护 Route Map 与 Decision Ticket，使用固定章节写入，并以 assignee 与本地 Session 记录共同表达 Ticket Claim。
- 新增 Execution Graph 编译与初始历史：由正式 Implementation Plan 确定性编译候选图，只做结构与策略检查，绑定到当前地图 revision 与新的 Graph Generation，并通过单一 `ExecutionGraphHistory` 接缝追加和读取初始 GraphVersion。
- 新增 Execution Authorization：一次性组装完整 Manifest 并取得用户原子批准，记录版本化授权；Manifest 在本 change 一次性拥有恢复、实现、Validator 修复、Graph Revision 与 Specification Revision 等全部有限上限，后继只消费、不加字段。
- 新增 Route Planning Session 交接：prepare→review→cutover 三阶段转移规划责任，并覆盖取消、过期提案、崩溃恢复与 `awaiting_user_prompt` 激活门；交接只转移规划责任，不触碰 Execution Coordination 下已在途的 Worker。
- 新增进入 Execution Coordination 的门禁与交接：开放票与 fog 清空、无未决交互与 mutation、计划绑定当前地图 revision、编译通过、Manifest 获批后才切换模式，并把 Execution Coordination Lease 交给唯一的持有者。
- 不在本 change 内实现：Worker 派发与生命周期、Task 物化、Specification Admission、实践验证与 Finalizer、Replanning Transition 之后的重新规划执行、TUI 与 CLI 界面。

本 change 同时包含两类转移：Route Planning 内部 Session 之间的规划责任交接，以及 Route Planning 到 Execution Coordination 的授权与模式切换。二者在同一 capability 内用不同 requirement 表达，并共用同一组门禁与持久化约束。

## Capabilities

### New Capabilities

- `planning/route-map`: Route Map 与 Decision Ticket 的权威归属、固定章节更新与 Ticket Claim 语义。
- `planning/execution-graph-compilation`: 由正式 Implementation Plan 确定性编译候选 Execution Graph 的结构检查与世代绑定。
- `planning/execution-authorization`: 完整 Execution Authorization Manifest 的组装、执行预算绑定、原子批准与版本化授权记录。
- `coordinator/route-planning-handoff`: 规划 Session 之间的责任交接，以及进入 Execution Coordination 的门禁、模式切换与 Execution Coordination Lease 交接。

### Modified Capabilities

无。本 change 只新增 capability；`openspec/specs/` 中在此之前的 capability 均为新增，尚无需求需要修改。

## Impact

- 代码：`src/domain/planning/`、`src/application/planning/`、`src/adapters/tracker/`、`src/workflow/coordinator/`（挂载规划工具节点）。
- 依赖：tracker 访问使用仓库已有的 `gh` CLI，不新增运行时依赖；边界载荷延续 M0 的窄校验器约定。
- 事实源：Route Map 与 Decision Ticket 以 issue tracker 为权威；模式类型与租约规则复用 `m1-persist-coordination-state` 的唯一实现；Execution Graph 由初始 GraphVersion 与后续 accepted patch 形成的追加历史拥有，Branch Coordination Store 只保存当前 graph/authorization 引用。
- 不改变：Coordinator Session 与 checkpoint 语义、Wake Batch 与 Capsule 语义、Orca CLI adapter、TUI。
