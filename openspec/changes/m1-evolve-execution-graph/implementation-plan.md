# Implementation Plan

## 1. 实施基线与权威来源

- **Baseline mode**: `predecessor-contract`
- **直接前驱**: `m1-recover-execution`
- **规划提交**: `cd29e2b`（当前仓库 HEAD；本 change 只写 `openspec/changes/m1-evolve-execution-graph/`）
- **权威来源**: 本 change 的 `proposal.md`、三份 capability spec 与 `design.md`（D1–D14）；`docs/architecture.md` 的 FLOW-02 与 FLOW-04；`docs/interface-contracts.md` 的 IC-03–IC-05、IC-09–IC-11；根目录 `AGENTS.md` 第 4、5、6、7、8、11 节；`CONTEXT.md` 的 Execution Graph、Graph Generation、Generation Cutover、Graph Patch、Graph Revision、Specification Revision、Tracking Revision、Revision Pending、Retired Work Package、Patch Work Package、Revised Worker Task、Retry Attempt、Baseline Reconciliation、Baseline Adoption、Migration Material、Work Package Lineage、Replanning Transition、Replanning Cancellation、Replanning Baseline 等条目；`docs/research/orca-task-dag-execution-graph.md`、`coordinator-state-recovery.md`。

### 合同 create/extend/consume

| 关系 | 合同与 canonical symbols | 漂移检查 |
|---|---|---|
| Create | IC-10：change classifier、Graph Patch/Revision、Specification Revision、Generation Cutover | 图历史只追加，不改写旧版本或复制 Orca Task DAG |
| Extend | IC-05：`ExecutionGraphHistory.appendAcceptedRevision` | 只扩展既有 port，不新建 graph repository |
| Extend | IC-03：graph revision/lineage/replanning records；IC-11：graph commands/projections | 只保存不可重建事实并追加封闭 façade variants |
| Consume | IC-04、IC-09、FLOW-02、FLOW-04 | 不复制 Wake、Recovery、Scope control 或 Execution Handoff 状态机 |

若 GraphHistory owner、Recovery/Handoff owner 或 Wake owner 漂移，停止实施并先更新架构合同。
- **冻结接缝（前驱提供，本 change 不得修改其判定）**:
  1. **Worker Session Recovery 协议**：RecoveryId、预写 Operation Intent、按 Worker Attempt 的 Recovery Budget、替代 Session 身份边界、Recovery Capsule 与角色门。本 change 只引用该协议来承载 Graph Patch Planner 与 Baseline Reconciliation 的 Session 中断，不复制其状态机。
  2. **mutation lanes**：未决 Operation Intent 对账与 lane 阻塞语义。
  3. **scope controls**：Pause、Resume、Cancel、Exit 的正交控制状态语义。
  4. **Execution Handoff**：`ExecutionHandoffState` 的 prepare/review/CAS cutover 与责任集合；普通 suspend/Wake Batch 仍由更早的 coordinator capability 拥有。
  5. **ExecutionGraphHistory**：前驱链已提供 `recordInitialGraph`、`loadCurrentGraph` 与 append-only 初始 GraphVersion，本 change 只扩展 accepted revision 追加。
  6. **Execution Authorization Manifest**：Graph Revision 与 Specification Revision 上限字段及默认值已完整批准，本 change 只读取与扣减。
  7. **ControllerService**：查询、命令与语义事件的界面 façade；本 change 只增加图演进投影。
- **实施前核对门（任一不成立即回到规划）**:
  - 直接前驱 `m1-recover-execution` 已 archive，其主规格存在；
  - 前驱交付的 Worker Session Recovery 协议符号（RecoveryId、Recovery Capsule、角色门、按 Worker Attempt 的 Recovery Budget）、`MutationLane`、`ScopeControlState`、`WakeBatch` 与第 2 节声明一致；
  - `src/application/planning/graph-history.ts` 的 `ExecutionGraphHistory` 仍能读取初始 GraphVersion，且尚无 accepted revision 追加方法；
  - `ExecutionAuthorizationManifest` 已包含 Graph Revision 与 Specification Revision 的有限上限，`src/application/controller-service.ts` 已提供基础 façade。

## 2. 复用与接缝

| IP-ID | 现有或前驱文件与符号 | 复用方式 | 禁止复制的事实 |
|---|---|---|---|
| IP-1 | 前驱 `src/application/planning/graph-history.ts` 的 `ExecutionGraphHistory` 与 WorkPackageId 生成 | 为同一 port 增加 accepted revision 追加并读取当前 GraphVersion | 不新建图 repository；不复制 Orca Task 状态；不改写旧 GraphVersion |
| IP-2 | 前驱 Worker Session Recovery 协议与 Accepted Worker Result 校验 | Graph Patch Planner 与 Baseline Reconciliation 作为 Planner 任务复用该协议 | 不复制 Recovery 状态机；不让 Planner 直接写 store |
| IP-3 | 前驱 `ExecutionGraphHistory`、Controller Admission、Operation Intent 与回读语义 | 提交 Graph Revision 时复用同一历史 port、expected version 与 OperationId | 不让 service 或 store 暴露平行写图路径 |
| IP-4 | 前驱 Attempt/Retry 接缝与 Dispatch 物化 | 判别三类修订与 Retry | 不用 Retry 承载语义变化 |
| IP-5 | 前驱 `MutationLane`、预算记录与 Manifest 修订上限 | 增加 revision_pending 并扣减已批准额度 | 不新建预算字段或并行预算体系 |
| IP-6 | 前驱 `ScopeControlState` 与启动对账用例 | 复用为 Replanning Transition 的控制状态 | 不引入第三种模式 |
| IP-7 | 前驱 Execution Coordination Lease 与授权引用 | 在 Cutover 中原子切换引用集合 | 不逐项迁移，不保留两套权威 |
| IP-8 | 前驱 `src/application/controller-service.ts` | 增加当前 GraphVersion、revision_pending、Replanning 与 Cutover 的快照/语义事件投影 | 不让界面直连 store 或写图 |

## 3. 代码变更映射

| IP-ID | Task | Requirement/Scenario | 文件与符号 | 精确变化 | 不得改变 |
|---|---|---|---|---|---|
| IP-1 | 1.1 | 图变化必须先分类路由且以 exact baseGraphVersion 起草补丁 / 全部三个 Scenario | 新增 `src/domain/execution/change-routing.ts`；新增 `src/domain/execution/graph-patch.ts`；新增 `src/application/execution/graph-patch-planner.ts` | 实现七值分类路由；含糊请求派发 Graph Patch Planner；补丁声明并校验 `baseGraphVersion` | 不用模型做确定性分类；不基于未声明版本起草 |
| IP-2 | 1.2 | 补丁必须逐一处置未接受后代并通过编译校验 / 全部三个 Scenario | 修改 `src/domain/execution/graph-patch.ts`；新增 `src/domain/execution/graph-compiler.ts` | 表达 add/revise/retire/takesOver 与后代逐一处置；实现七项编译校验 | 不默认 unchanged；不评判规划语义 |
| IP-3 | 1.3 | 补丁以 Planner 结果为准一来源证据并只经 Admission 提交 / 全部三个 Scenario | 修改 `src/application/planning/graph-history.ts` 与 `src/application/execution/graph-patch-service.ts`；实现 store adapter | 为 `ExecutionGraphHistory` 增加 `appendAcceptedRevision`，以 expected version + OperationId 追加并回读 | 不直接提交 Planner 结果；不从 service/store 建第二条写图路径 |
| IP-4 | 2.1 | Specification Revision 保持身份并重新 Admission 后重跑完整角色链 / 全部三个 Scenario | 新增 `src/domain/execution/specification-revision.ts`；新增 `src/application/execution/revision-service.ts` | 替换 contract 后重新 Admission 并从 Specification Planner 重跑角色链；越界转 Graph Revision | 不改依赖与 Scope Envelope；不从 Implementation 重跑 |
| IP-5 | 2.2 | revision_pending 只冻结受影响节点与其未接受后代 / 全部三个 Scenario | 修改 `src/domain/execution/revision-pending.ts`；修改 frontier 选择 | 只冻结受影响节点与未接受后代；并发上限不作为准入限制；阻止旧结果越界 | 不冻结无关节点；不杀死已派发 Worker |
| IP-6 | 2.3 | 修订额度有限且基线落后必须由独立任务补救 / 全部三个 Scenario | 修改 `src/domain/execution/revision-budget.ts`；新增 `src/application/execution/baseline-reconciliation.ts` | 从 Manifest 读取已批准上限（默认 2）并单调扣减；落后时建立独立 Baseline Reconciliation 任务并核验 ancestry/HEAD/dirty/scope | 不新增 Manifest 字段；不让实现角色自行 rebase；不由恢复重置额度 |
| IP-7 | 3.1 | Replanning Transition 必须结清在途工作并释放 Lease / 全部三个 Scenario | 新增 `src/domain/execution/replanning.ts`；新增 `src/application/execution/replanning-service.ts` | 固定过渡顺序；支持 drain 与显式 cancel-and-reconcile；结果只记在挂起代际 | 不始终等待 drain；不伪造已停止 |
| IP-8 | 3.2 | Generation Cutover 必须原子替换代际并让新代际全新开始 / 全部三个 Scenario | 修改 `src/application/execution/replanning-service.ts`、store 权威引用记录与 `src/application/controller-service.ts` | 单条引用集合切换；全新 Graph/Run/WorkPackage/worktree；取消路径恢复挂起代际；投影图演进快照与语义事件 | 不允许部分激活；不复用前代标识或 worktree；不让 façade 写图 |
| IP-9 | 3.3 | 旧成果必须按采用规则进入并由 lineage 继承已消耗额度 / 全部四个 Scenario | 新增 `src/application/execution/baseline-adoption.ts`；新增 `src/domain/execution/work-package-lineage.ts`；修改 store 参考记录 | 实现三条采用规则与矛盾阻塞；以 lineage 继承已消耗额度 | 不复制完成状态；不复用 worktree；不重置额度 |
| IP-10 | 4.1、4.2 | 全部三个 capability 的验收层 | 新增 `tests/execution/acceptance/*` | 以 fake 覆盖 Compiler 失败分支、修订额度与拓扑准入；以真实 MiniMax-M3 完成 Graph Patch Planner 场景与真实新 Run cutover | 不以 fake 替代 Planner 与 cutover；不在非隔离项目运行真实调用；不新增 Recovery fixture |

## 4. 调用与副作用顺序

图变化路由（IP-1）：接收请求 → 确定性分类到七值之一 → `retry_attempt`/`no_change`/`replanning_transition` 直接交给对应既有路径 → `graph_patch` 或语义含糊时派发 Graph Patch Planner → Planner 结果经既有 Accepted Worker Result 校验成为证据。

补丁应用（IP-2、IP-3）：通过 `ExecutionGraphHistory.loadCurrentGraph` 读取当前版本与补丁草案 → 校验 `baseGraphVersion` → 校验后代逐一处置 → Graph Compiler 校验影响集合、引用、无环、Scope、预算、授权、版本 → 经 Controller Admission 归一化 → `appendAcceptedRevision` 以 expected version 与 OperationId 追加并回读 → ControllerService 投影当前图。任一步失败不写入。

Specification Revision（IP-4、IP-5、IP-6）：判别类型 → 越界则转 Graph Revision → 校验身份与 Scope Envelope → 替换 contract → 重新 Admission → 从 Specification Planner 重跑角色链 → 若 worktree base 落后则先走独立 Baseline Reconciliation 任务。受影响节点在重跑期间保持 revision_pending。

Replanning（IP-7、IP-8、IP-9）：写重规划意图 → 停止新派发与补丁 → drain 或 cancel-and-reconcile 收尾在途 Worker、Delivery、Pending Interaction 与 Operation Intent → 释放 Lease → 挂起代际 → 建立新 Planning Cycle → 新图通过授权后执行 Cutover。取消路径在 Cutover 前恢复挂起代际。

## 5. Schema、状态与持久化落实

- **SSOT**：`ExecutionGraphHistory` 是 GraphVersion 的唯一应用契约，其 store adapter 在 `coordination.sqlite` 保存初始版本与 accepted revision 历史；同库通过本 change migration 保存补丁元数据、Specification Revision、revision_pending、修订额度用量、Baseline Reconciliation、Work Package Lineage、代际引用与 Baseline Adoption。Orca Run、Task、Dispatch、Worker 与 receipt 保持归 Orca。
- **状态转换**：revision_pending 由 `clear` 转为 `pending`；只在当前 Worker 结清且修订被接受或节点被 retire 后转回。代际引用集合只能在 Cutover 或 Replanning Cancellation 时整体切换。
- **约束与并发**：所有写入复用前驱 CAS revision 与短事务；同一 Scope 只有一个 Execution Coordination Lease holder 可写图；修订额度读-改-写在同一事务内完成。
- **幂等**：补丁以补丁标识幂等；同一 `baseGraphVersion` 的重复提交被拒绝；Cutover 以目标 GraphId 幂等。
- **迁移**：通过可重入、版本化 migration 扩展既有图历史并增加 patch/revision/replanning 记录，保留初始 GraphVersion 与全部前驱数据；修订上限字段与默认值不变。

## 6. 验收证据矩阵

| Requirement/Scenario | IP-ID | 测试文件 | Fixture/前置条件 | 关键断言 | 可运行命令 |
|---|---|---|---|---|---|
| 分类路由与 baseGraphVersion | IP-1 | `tests/execution/change-routing.test.ts` | 七类请求与含糊请求 | 七值路由正确；含糊才派 Planner；版本不符即拒绝 | `pnpm test -- tests/execution/change-routing.test.ts` |
| 后代处置与编译校验 | IP-2 | `tests/execution/graph-compiler.test.ts` | 缺处置、引用缺失、成环、超预算、未授权、版本漂移 | 各项校验失败则整体拒绝；takesOver 被记录 | `pnpm test -- tests/execution/graph-compiler.test.ts` |
| 来源证据与唯一提交点 | IP-3 | `tests/execution/graph-patch.test.ts` | Planner 结果与直接提交路径 | 只经 Admission 提交；expected version + OperationId + 回读；历史只追加 | `pnpm test -- tests/execution/graph-patch.test.ts` |
| ControllerService 图投影 | IP-8 | `tests/application/controller-service.test.ts` | patch、revision_pending 与 cutover 事件 | 快照与事件更新；façade 无写图入口 | `pnpm exec vitest run tests/application/controller-service.test.ts` |
| Specification Revision 重跑链 | IP-4 | `tests/execution/specification-revision.test.ts` | 常规与越界修订请求 | 保留身份；重新 Admission 后从 Planner 重跑；越界转 Graph Revision | `pnpm test -- tests/execution/specification-revision.test.ts` |
| revision_pending 作用范围 | IP-5 | `tests/execution/revision-pending.test.ts` | 含无关节点与已派发 Worker | 无关节点仍可准入；终态后不派发后续；旧结果不越界 | `pnpm test -- tests/execution/revision-pending.test.ts` |
| 修订额度与基线补救 | IP-6 | `tests/execution/baseline-reconciliation.test.ts` | 达上限、落后基线、重启 | 默认 2 且不重置；建立独立任务并核验 ancestry/HEAD/dirty/scope | `pnpm test -- tests/execution/baseline-reconciliation.test.ts` |
| Replanning Transition 收尾 | IP-7 | `tests/execution/replanning.test.ts` | drain 与 cancel-and-reconcile | 停派发、结清、释放 Lease、建立 Planning Cycle；未确认不伪造 | `pnpm test -- tests/execution/replanning.test.ts` |
| Cutover 原子切换 | IP-8 | `tests/execution/replanning.test.ts` | 授权后切换与切换前取消 | 引用整体切换；全新代际标识；取消恢复挂起代际 | `pnpm test -- tests/execution/replanning.test.ts` |
| 采用规则与 lineage 额度 | IP-9 | `tests/execution/baseline-adoption.test.ts` | 三类旧成果、lineage、矛盾事实 | 不复制完成状态；材料只读；lineage 不重置额度；矛盾阻塞 | `pnpm test -- tests/execution/baseline-adoption.test.ts` |

全量门禁：`pnpm typecheck && pnpm lint && pnpm test`

### 6.1 验收层：fake backend 与真实隔离调用

| 覆盖目标 | 验证载体 | 前置条件 | 关键断言 | 可运行命令 |
|---|---|---|---|---|
| Graph Compiler 失败分支（fake） | `tests/execution/acceptance/compiler-branches.test.ts` | fake backend + 内存 store；缺处置、引用缺失、成环、超预算、未授权、版本漂移 | 每类校验失败即整体拒绝，且不产生 GraphVersion | `pnpm test -- tests/execution/acceptance/compiler-branches.test.ts` |
| 修订额度与 Baseline Reconciliation（fake） | `tests/execution/acceptance/revision-budget.test.ts` | fake backend + 上限 2 与落后基线 | 达上限阻塞且不重置；落后时建立独立 Baseline Reconciliation 任务 | `pnpm test -- tests/execution/acceptance/revision-budget.test.ts` |
| 真实 Graph Patch Planner（MiniMax-M3） | `tests/execution/acceptance/real-patch-planner.test.ts`（显式标记 `@real-harness`，默认不参与常规 `pnpm test`） | 显式选择的隔离项目、专用 Orca 身份与绑定 Run；Graph Patch Planner 使用 MiniMax-M3 | 含糊的图变化请求由真实 Planner 产出结构化补丁，声明 exact `baseGraphVersion`、逐一处置未接受后代，并被 Controller Admission 归一化为 Graph Revision | 隔离项目内运行 `ORCA_COMPANION_REAL_HARNESS=1 pnpm test -- tests/execution/acceptance/real-patch-planner.test.ts` |
| 无关拓扑节点继续可准入 | `tests/execution/acceptance/hold-topology-scope.test.ts` | 图含受影响节点、其未接受后代与无拓扑关系的兄弟节点 | 持有期间无关节点仍进入 Execution Frontier；受影响节点与后代不派发后续角色 | `pnpm test -- tests/execution/acceptance/hold-topology-scope.test.ts` |
| 真实新 Run cutover | `tests/execution/acceptance/real-run-cutover.test.ts`（显式标记 `@real-harness`，默认不参与常规 `pnpm test`） | 显式选择的隔离项目、专用身份与候选代际 | Cutover 后 active Planning Cycle、GraphId、Run、Authorization、预算引用与 Lease 整体切换到新 Run，新代际使用全新 Graph、Run、WorkPackageId 与 worktree | 隔离项目内运行 `ORCA_COMPANION_REAL_HARNESS=1 pnpm test -- tests/execution/acceptance/real-run-cutover.test.ts` |

验收层命令：`pnpm test -- tests/execution/acceptance`

真实调用边界：只在隔离项目与专用身份中运行，不触碰用户主项目、不重启全局 Orca runtime、不改上游。Graph Patch Planner 与 Baseline Reconciliation 的 Session 中断一律交给前驱的 Worker Session Recovery 协议，本 change 不新增恢复 fixture。

## 7. 文件清单与升级条件

**新增**：`src/domain/execution/change-routing.ts`、`graph-patch.ts`、`graph-compiler.ts`、`specification-revision.ts`、`revision-pending.ts`、`revision-budget.ts`、`replanning.ts`、`work-package-lineage.ts`；`src/application/execution/graph-patch-planner.ts`、`graph-patch-service.ts`、`revision-service.ts`、`baseline-reconciliation.ts`、`replanning-service.ts`、`baseline-adoption.ts`；以及第 6、6.1 节列出的测试文件。

**修改**：`src/application/planning/graph-history.ts`、`src/application/controller-service.ts`、frontier 选择与 Retry 校验路径、`src/application/ports/branch-coordination-store.ts`、`src/adapters/storage/schema.ts`、`src/adapters/storage/coordination-store.ts`；通过 migration 增加图修订与代际记录，不修改 Manifest 字段。

**受保护（本 change 不得改动）**：`openspec/schemas/`、`openspec/config.yaml`、`AGENTS.md`、`CONTEXT.md`、`package.json` 与依赖清单、`references/orca`、`docs/`，以及前驱的 Worker Session Recovery 协议实现。

**升级条件**：出现以下任一情况即停止实施并向用户请示——需要新增公共字段、依赖、数据库或计划外 migration；需要改变前驱冻结的七处接缝或重写 Recovery 协议；直接前驱未 archive 或符号漂移；需要修改 Manifest 字段或放宽已批准修订上限；需要复用旧 worktree、复制旧完成状态或绕过 `ExecutionGraphHistory`；真实隔离调用无法在专用身份下绑定 Run 或创建候选 Run；某个 Scenario 无法在不伪造身份或直接读写 Orca 数据库的前提下满足。

## 8. 验收 Agent 授权与限定审计

- **授权范围**：本 change 的三个 capability spec 全部 Requirement/Scenario、IP-1 至 IP-10、上节"新增"与"修改"清单内的文件、以及第 6、6.1 节列出的测试文件与命令。
- **受保护边界**：七处冻结接缝、Execution Graph 的追加历史权威、Orca 与 Git 的事实归属、`openspec/` 规划资产。
- **限定审计标签**：`gate.append-only-graph-history`（图历史只追加）、`gate.patch-base-version-exact`（补丁基线必须精确匹配）、`gate.patch-descendants-enumerated`（未接受后代逐一处置）、`gate.planner-result-not-committed`（Planner 结果不得直接提交）、`gate.revision-not-retry`（三类修订与重试分离）、`gate.hold-scope-limited`（revision_pending 只冻结受影响子图）、`gate.cutover-atomic-refs`（代际引用整体切换）、`gate.no-completion-copy-on-replan`（重规划不复制完成状态）、`gate.lineage-inherits-consumed-budget`（lineage 继承已消耗额度）。
