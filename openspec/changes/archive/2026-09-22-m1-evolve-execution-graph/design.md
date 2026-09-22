## Context

本 change 在 `m1-recover-execution` 之后增加执行图的演进语义。前驱冻结了 Worker Session Recovery、mutation lanes、Scope 控制状态与 `ExecutionHandoffState`；更早的 Coordinator Session change 已冻结普通 suspend/Wake Batch。本 change 只引用这些能力，不复制其状态机或挂起/唤醒路径。

三条既有事实约束了可行空间。其一，Orca 的 Task 结构在创建时冻结，没有删除接口，因此图的结构语义必须由 Companion 拥有，新增与替代只能表现为新 Task（`orca-task-dag-execution-graph.md`）。其二，Execution Graph 的权威是初始 Implementation Plan 加连续 accepted Graph Patch Results 的追加历史，不是 Orca Task DAG，也不是 LangGraph（`AGENTS.md` 第 7、8 节）。其三，Graph Patch Planner 的结论是 Planner Worker 的 Accepted Worker Result，属于证据；Companion 侧的归一化 Graph Revision 才是提交点。

### 架构合同导入

| 关系 | 合同 | 本 change 的责任 |
|---|---|---|
| Create | IC-10 Graph evolution 与 replanning | 创建唯一变化分类、Graph Patch/Revision、Specification Revision 与 Generation Cutover 规则 |
| Extend | IC-05 `ExecutionGraphHistory` | 只增加 `appendAcceptedRevision`，沿用同一 append-only history port |
| Extend | IC-03 BranchCoordinationStore | 只增加 graph revision、lineage、revision-pending 与 replanning 最小记录 |
| Extend | IC-11 ControllerService | 只增加图演进查询、命令、投影与语义事件 variant |
| Consume | IC-04、IC-09；FLOW-02、FLOW-04 | 复用 Wake admission、Worker Session Recovery 与 Execution Handoff，不复制状态机 |

## Goals / Non-Goals

**Goals:**

- 让执行期间新发现的必要变化经明确分类与来源证据进入图，同时保持历史版本、运行事实与已完成工作的可审计性。
- 让语义修订、图级修订与基础设施重试成为三种不会互相冒充的操作，并明确各自的重新准入与限额。
- 让重规划成为受控过渡：结清在途工作、原子切换代际、旧成果按明确规则进入新规划且不重置已消耗额度。

**Non-Goals:**

- 不实现 M2 的图可视呈现、键位与交互。
- 不实现自动重规划判定、并行 Worker、多 Worker Harness 或原生集成。
- 不复制旧完成状态，不迁移 worktree，不复制 Orca Run 状态。
- 不重新定义前驱的 Worker Session Recovery 协议；本 change 只在其上引用与衔接。

## Decisions

### D1：图演进逻辑的模块归属

领域规则放 `src/domain/execution/graph-patch.ts`、`specification-revision.ts` 与 `replanning.ts`；用例放 `src/application/execution/` 下的 patch、revision、replanning 与 baseline reconciliation 服务；`src/workflow/` 只负责在 Coordinator 模型循环中暴露相应工具并调用应用服务。领域层不依赖 LangGraph、Orca、Ink 或数据库。

理由：图合法性、原子性、分类与代际规则是可以在无外部依赖下测试的纯逻辑，符合 `AGENTS.md` 第 4 节。备选方案是把图规则写进图节点，被否，因为节点可重跑且会复制业务规则。

### D2：变化的分类路由与 Graph Patch Planner

每个图变化请求先由一个确定性分类器路由到 `retry_attempt`、`specification_revision`、`graph_patch`、`replanning_transition`、`no_change`、`user_decision_required` 或 `blocked` 之一。分类器只使用可判定的规则；语义不清晰时路由为 `graph_patch`，并派发 Graph Patch Planner Worker（MiniMax-M3）产出结构化补丁草案。Graph Patch Planner 是 Planner 角色，其产物走前驱的 Worker Session Recovery 协议与既有 Accepted Worker Result 校验。

理由：确定性分类可以覆盖 `retry_attempt`、`no_change` 与 `replanning_transition` 这些规则明确的请求，只有真正含糊的图变化才需要模型判断，这与 `AGENTS.md` 的"确定性负责准入、模型负责语义"一致。备选方案是全部交给模型分类，被否，因为会为非图变化制造不必要的 Worker 派发。

### D3：补丁的表示、基线与后代处置

Graph Patch 表示为单一追加记录，包含 exact `baseGraphVersion`、`add`、`revise`、`retire`、`takesOver` 与对 base 版本中每个未接受后代的逐一处置（`unchanged`、`graph_revision`、`specification_revision`、`retire`）。`baseGraphVersion` 必须等于应用时的当前版本；未列出的未接受后代导致补丁被拒绝。补丁以 `add + revise + retire` 的单次写入生效，任一操作不合法则整体不写入。

理由：Orca 无法在创建后改依赖，图的结构自由度只能靠 Companion 侧的补丁表达（`orca-task-dag-execution-graph.md` 第 8 节）；逐一处置后代避免"隐含继承旧处置"这一常见缺陷。备选方案是让未列出的后代默认 unchanged，被否，因为它会让依赖变化静默遗留。

### D4：补丁的编译校验

应用前 Graph Compiler 校验影响集合、引用完整性、同代内无环、Scope Envelope、预算、授权与版本一致性。任一失败则补丁被拒绝且不产生新 GraphVersion。校验是确定性的，不评判规划语义。

理由：`AGENTS.md` 第 7 节规定 Compiler 的检查范围。备选方案是把语义合理性也纳入 Compiler，被否，因为那属于 Coordinator Agent 的判断。

### D5：来源证据与唯一提交点

Graph Patch Planner 的 Accepted Worker Result 是不可变来源证据，MUST NOT 被直接提交为图。唯一应用提交点是前驱 `ExecutionGraphHistory` 的 accepted revision 追加入口；Controller Admission 先归一化 Graph Revision，再以 expected version 与稳定 OperationId 追加并回读。Branch Coordination Store 只是该 port 的持久化实现，不向其他调用方暴露第二条写图路径。

理由：`AGENTS.md` 第 5 节要求模型不得填写身份与 operation identity，第 8 节要求副作用前后可对账。备选方案是让 Planner 直接写 store，被否，因为它会把模型输出变成事实。

### D6：Graph Revision、Specification Revision 与 Retry 的边界

改变依赖、Scope Envelope 或 objective 属 Graph Revision，产生新 GraphVersion 并保留 WorkPackageId 与 worktree；只改变 contract 语义内容属 Specification Revision，不产生新 GraphVersion。Retry Attempt 沿用前驱接缝，保持 WorkerTask、contract、revision 与 Orca Task 不变，只新建 Dispatch/Attempt。三种判别由应用层显式决定。

理由：`CONTEXT.md` 对三者已有精确定义。备选方案是合并为一种"修订"，被否，因为会丢失"图是否变化"与"是否重跑准入"这两个可审计区分。

### D7：Specification Revision 的重新准入与完整角色链

Specification Revision 保留 WorkPackageId、依赖与 Scope Envelope，替换 contract 内容后必须重新经过 Specification Admission；准入通过后从 Specification Planner 起重跑完整角色链。重跑使用同一 WorkPackageId 与既有 worktree，但角色链从规划开始，不复用旧实现凭证。

理由：`AGENTS.md` 第 7 节规定 Specification Revision 只改变 contract content，而契约变化必须重新证明规格与实现的对应关系。备选方案是从 Implementation 起重跑，被否，因为会跳过规格准入。

### D8：revision_pending 的作用范围

revision_pending 是调度持有标记，只冻结受影响 Work Package 与其未接受后代；无拓扑关系的节点继续按既有准入规则进入 Execution Frontier。并发上限为 1 是执行并发上限，不改变拓扑准入判定。受影响节点的当前 Worker 运行至可核验终态，其后不再派发后续角色与依赖工作；旧结果不得越过持有或既有集成继续推进。

理由：`AGENTS.md` 第 7 节要求 revision pending 后仍运行至终态，并明确并发上限不改变准入语义。备选方案是冻结整个图，被否，因为会无谓阻塞与修订无关的工作。

### D9：修订额度与 Baseline Reconciliation

每个 Work Package 的 Graph Revision 与 Specification Revision 次数各自受 Execution Authorization Manifest 已批准的有限上限约束（默认各 2），且重启、恢复、Patch 与重规划都不重置已消耗额度；本 change 只读取和扣减，不增加 Manifest 字段。当 Graph Revision 使 worktree base 落后于其所需基线时，系统建立独立的 Baseline Reconciliation 任务（Planner-profile Worker Task），核验祖先关系、目标 HEAD、dirty paths 与 scope 后再开始修订后的规格工作。

理由：`AGENTS.md` 第 7 节规定默认最多 2 次 Graph Revision 与 2 次 Specification Revision 且不因恢复重置，并把 Baseline Reconciliation 定义为独立 Planner-profile 任务。备选方案是让修订后的 Worker 自行 rebase，被否，因为会把基线修复混进实现角色的职责。

### D10：Replanning Transition 的收尾方式与 Generation Cutover

Transition 复用前驱的 Scope 控制状态作为正交控制状态。顺序固定为：写重规划意图 → 停止新派发与图补丁 → 以 drain 或用户显式 cancel-and-reconcile 收尾在途 Worker、Delivery、Pending Interaction 与 Operation Intent → 释放 Execution Coordination Lease → 挂起当前代际 → 建立新 Planning Cycle。Cutover 在一次写入中同时切换 active Planning Cycle、GraphId、Orca Run、Execution Authorization、预算引用与 Execution Coordination Lease，或全部不变；新代际使用全新的 Graph、Run、WorkPackageId 与 worktree。Cutover 前允许 Replanning Cancellation。

理由：`CONTEXT.md` 明确要求这些引用"一起改变或全部不变"，且 WorkPackageId 不跨代际。备选方案是复用前代 Run 或 worktree，被否，因为会让两代共享运行事实。

### D11：成果采用与额度继承

Baseline Adoption 由 Coordinator Agent 做语义判断、Controller 校验被引用的接受记录、集成状态、版本与证据；Migration Material 以只读方式提供旧结果、规格与未集成 worktree；Planning Reference 只作为规划输入。当新 Work Package 明确延续一个未完成旧责任时，以 Work Package Lineage 记录，并继承旧责任已消耗的实现、修复、Graph Revision 与 Specification Revision 额度。三条规则都不复制完成状态，也不复用 worktree。

理由：`CONTEXT.md` 定义了 Baseline Adoption、Migration Material 与 Work Package Lineage 的边界。备选方案是允许导入旧完成节点，被否，因为它会让新图继承未经重新验证的状态。

### D12：代际、图历史与 Controller 投影归属

前驱 `ExecutionGraphHistory` 继续作为 GraphVersion 读取与追加的唯一应用契约，Branch Coordination Store 保存其初始版本与 accepted revision 追加历史，以及补丁记录、后代处置、takesOver、revision_pending、修订额度用量、Baseline Reconciliation、Work Package Lineage、子代际与权威引用。前驱 `ControllerService` 增加这些事实的只读快照与语义事件投影，不获得第二条写图路径。Orca Run、Task、Dispatch、Worker 与 receipt 仍由 Orca 拥有；worktree 由 Orca 与 Git 拥有。

理由：`AGENTS.md` 第 8 节规定了这些归属。沿用一个图历史 port 和一个界面 façade，可避免 service、store 与 TUI 各自发明当前图；GraphVersion 也不能写进单个 Session 的 checkpoint。

### D13：验收验证必须使用真实 Graph Patch Planner 与真实 Run cutover

本 change 的验收验证必须显式使用 MiniMax-M3 完成 Graph Patch Planner 场景，不能用 fake 分类器或手写补丁草案替代该角色的语义判断；同时必须完成一次真实的新 Run cutover，验证 Generation Cutover 在真实 Orca Run 上的原子引用切换。此外必须包含一个显式的拓扑准入断言：某个 Work Package 进入 revision_pending 时，与其无拓扑关系的节点继续进入 Execution Frontier。Graph Patch Planner 在 Session 中断时复用前驱的 Worker Session Recovery 协议，本 change 不新增恢复机制，也不用自己的 fixture 替代该协议。

理由：分类路由与提交点可以 fake 覆盖，但"含糊请求被真实 Planner 正确结构化"和"新代际确实落在新的 Orca Run 上"这两件事只有真实调用能证明。真实调用 MUST 只在显式选择的隔离项目与专用身份中运行，MUST NOT 触碰用户主项目、重启全局 Orca runtime 或修改上游。备选方案是全部 fake，被否，因为无法证明 Planner 输出可被 Admission 归一化，也无法证明代际切换落在真实 Run 上。

### D14：验收验证的 Mock 边界

Graph Compiler 校验、后代处置枚举、修订额度与 Baseline Reconciliation 判定使用 fake backend 与内存 store 覆盖；Graph Patch Planner、Run cutover 与拓扑准入使用真实调用或真实 Orca 事实。两种层次不得互相替代。

理由：编译器与额度是确定性规则，fake 层可穷举失败分支；Planner 与 Run 属于外部行为，fake 层无法代替。备选方案是单一层次，被否，前者会掩盖真实语义失败，后者会不可枚举。

## Risks / Trade-offs

- 分类器会为语义含糊的请求派发 Graph Patch Planner，增加一次 Worker 派发与等待；收益是避免 Controller 猜测分类。
- 逐一处置未接受后代会放大补丁草案体积；收益是依赖变化不再静默遗留后代。
- Cutover 的原子引用集合把多处状态耦合在一个写入中；代价是该写入必须短小并复用既有 CAS。
- 默认修订上限为 2 会在复杂任务中较早触顶，届时按升级条件回到规划处理。
- Work Package Lineage 的额度继承依赖声明而非语义相似推断，因此延续关系必须显式写出，否则会被当作全新责任。

## Migration Plan

前驱归档后，本 change 通过可重入、版本化 migration 扩展既有图历史，增加 accepted revision、补丁元数据、revision_pending、修订额度用量、Baseline Reconciliation、Lineage 与代际引用记录；migration 保留初始 GraphVersion 与全部前驱数据。旧代际的冻结只影响新行为，不回溯改写既有历史。修订上限继续读取前驱 Manifest。
