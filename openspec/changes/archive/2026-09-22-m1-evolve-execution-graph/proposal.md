## Why

`m1-recover-execution` 之后，Companion 已经能中断恢复并承受用户控制，但 Execution Graph 仍然只能在初始编译后原样执行。真实执行会不断产生新信息：需要插入前置工作、需要收窄或扩大某个 Work Package 的范围、需要重开已经规划完成的路径。缺少显式的图演进语义，这些变化只能靠改写既有节点或直接杀死 Worker，而两者都会破坏历史与可审计性。

## What Changes

- 新增图变化分类路由（`retry_attempt`、`specification_revision`、`graph_patch`、`replanning_transition`、`no_change`、`user_decision_required`、`blocked`），语义不清晰时派发 Graph Patch Planner。
- 新增 Graph Patch：以 exact `baseGraphVersion` 起草，逐一处置未接受后代（unchanged/graph_revision/specification_revision/retire），支持 `takesOver`，经 Graph Compiler 校验后原子追加，历史 GraphVersion 不被改写。
- 固定来源证据与提交点：Graph Patch Planner 的 Accepted Result 是不可变来源证据，只有经 Controller Admission 归一化的 Graph Revision 才是唯一提交点。
- 新增 Specification Revision：保持 WorkPackageId、依赖与 Scope Envelope，重新 Admission 后从 Specification Planner 起重跑完整角色链；与 Retry Attempt 明确分离。
- 新增 revision_pending 的有界持有：只冻结受影响 Work Package 与未接受后代。
- 新增独立 Baseline Reconciliation 任务：Graph Revision 导致 worktree base 落后时核验 ancestry/HEAD/dirty/scope。
- 消费前驱 Execution Authorization Manifest 已固定的 Graph Revision 与 Specification Revision 上限（默认各 2），且不因恢复重置；本 change 不增加预算字段。
- 新增 Replanning Transition（drain 或显式 cancel-and-reconcile）与 Generation Cutover：新代际使用全新 Graph/Run/WorkPackage/worktree，旧代际永久冻结，成果经采用规则进入并由 lineage 继承已消耗额度。
- 不实现：M2 的 TUI 呈现、并行 Worker、自动重规划、跨代际的状态复制，以及前驱 Worker Session Recovery 协议的重定义。

## Capabilities

### New Capabilities

- `execution/graph-patching`: 图变化的分类路由、补丁的基线与后代处置、编译校验、来源证据与唯一提交点，以及 append-only 历史与退休语义。
- `execution/specification-revision`: Specification Revision 的重新准入与完整角色链重跑、revision_pending 的有界持有、修订额度与 Baseline Reconciliation。
- `execution/replanning`: Replanning Transition 的收尾方式、Generation Cutover 的原子代际替换、旧成果采用规则与 lineage 额度继承。

### Modified Capabilities

无。本 change 只新增独立 capability，不改变既有 capability 的 requirement。

## Impact

- 领域层新增 `src/domain/execution/change-routing.ts`、`graph-patch.ts`、`graph-compiler.ts`、`specification-revision.ts`、`revision-pending.ts`、`revision-budget.ts`、`replanning.ts`、`work-package-lineage.ts`。
- 应用层新增 `src/application/execution/graph-patch-planner.ts`、`graph-patch-service.ts`、`revision-service.ts`、`baseline-reconciliation.ts`、`replanning-service.ts`、`baseline-adoption.ts`。
- 扩展前驱 `ExecutionGraphHistory` 以追加 accepted Graph Revision；`BranchCoordinationStore` 通过版本化 migration 增加补丁元数据、修订额度用量、revision_pending、Baseline Reconciliation、Work Package Lineage 与代际引用。
- 扩展前驱 `ControllerService` 的快照与语义事件，投影当前 GraphVersion、revision_pending、Replanning Transition 与 Generation Cutover；界面层仍不得直连 store。
- 本 change 只引用前驱的 Worker Session Recovery 协议来承载 Graph Patch Planner 与 Baseline Reconciliation 的 Session 中断，不复制其状态机。
- 直接前驱为 `m1-recover-execution`；冻结接缝为 Worker Session Recovery 协议、mutation lanes、scope controls 与 execution handoff。
- 不新增依赖，不改 schema、项目配置。
