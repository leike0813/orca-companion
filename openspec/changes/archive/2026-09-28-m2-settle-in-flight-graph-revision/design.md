## Context

`record-graph-version` 已把已派发的修订节点登记为 `graph_patch` 持有；退场节点的持有已有事务内释放。`deriveExecutionFacts` 直接把 pending 持有投影为 `revision_pending`，`advanceExecution` 与 `materializeWorkPackage` 因而拒绝全部角色；`beginSpecificationRevision`、`settleSpecificationRevision` 只有测试调用。见 `docs/research/execution-revision-settlement-gap.md`。当前宿主还按所有历史角色结算推断阶段，所以仅释放持有会把旧结果误认为新修订已完成。`OpenSpecProvider` 的 `contractRevision` 由规格内容摘要得到，是稳定内容标识而非递增序号；研究记录中“+1”的候选做法与代码事实不符。

## Goals / Non-Goals

**Goals:** 让当前图内的已派发修订节点在旧派发结清后重新跑 Planner，经 Admission 后原子结算；旧契约结果不参与新角色链、集成或 Finalizer；重启只续办原身份。

**Non-Goals:** 不改变补丁分类、退休持有事务、不建立新 Worker Harness 或 TUI 页面；`docs/research` §4b 的既有 Git 集成投影差异留给独立 change。

## Decisions

### D1. 持有贯穿新 Planner 的准入

权威来源是当前 GraphVersion、`revision_holds`、物化绑定、Delivery 结算、Execution Authorization 与 Baseline Reconciliation。仍在图中的 `graph_patch` 持有不得因旧 Worker 结算而释放。只在所有旧派发均有可核验结算、Worker 列举完整且无 live/unverifiable Worker、必要基线补救为 `verified`、额度和授权有效时，允许**该节点的一次修订 Planner 派发**。后代、其它角色、旧结果与 Git 集成继续受持有阻止。纯许可判定放在 `src/application/execution/advance-execution.ts` 并供宿主候选装配复用；`src/domain/dispatch-candidate.ts` / `materializeWorkPackage` 只接受带匹配持有来源的受限 Planner 许可。读不到任一事实即拒绝并给结构化 blocker。排除“Worker 一结算便全局解冻”，因为旧结果可能趁 Admission 之前推进。

### D2. 按补丁身份续办修订 Planner

Planner 的稳定身份由 Scope、Graph Generation、WorkPackageId、`sourceRef`（补丁 ID）、角色及本节点已签发的 Planner Attempt 序号组成；编号从**已签发绑定**而非仅已接受结算确定。现有同身份绑定或未决 Operation Intent 走核验/对账，不签新 ID。新 Planner 复用原 worktree 和 `specificationUnitPath`；读取精确的最新 Planner Session Segment，拒绝按 cwd/时间猜会话。`beginSpecificationRevision` 增加“已接受 Graph Patch + 匹配持有”的输入分支：从当前 GraphVersion 的 WorkPackage、已有精确 Spec Binding 与 Specification Provider 可核验的当前 Unit 取得旧内容版本；来源冲突或不可读即阻塞。首次准备以匹配补丁来源的事务把旧版本记在持有上（没有既有 Unit 时记 0），同源重放读回相同值；新 Planner 不预猜目标版本。该分支复用额度/基线判定，不调用只适用于纯内容修订的 `planSpecificationRevision`，也不把 `graph_patch` 持有重写成 `specification_revision`。新 Planner 的准入拒绝保留原持有并显示失败项。替代“补丁应用时立即结算”会违反既有持有规格，不采用。

### D3. Revision Planner 交付后同事务结算并记录契约边界

`settleSpecificationRevision` 收敛入参为 `workPackageId`、`sourceRef`、已核验的 Admission `SpecBinding.contractRevision`、授权 ID 与可信 writer。只有与当前 pending 持有的 `sourceRef` 相同、该节点仍在当前图、Planner 精确身份可核验、且**该 Planner 交付是在这次持有登记之后签发并已结算**时才调用；拒绝不写库。扩展 `release-revision-hold`：同一事务校验来源与「交付晚于持有登记」、将持有改为 released、记录 `admitted_contract_revision` 并消耗一次 `specificationRevisions` 额度；重复结算同一来源幂等且不重复扣额，来源不符拒绝。成功后回读事实并发布一次 `state-changed`。额度上限仍由已批准 Manifest 和现有预算用例判定；store 对事务内计数做上限/授权引用校验，避免 admission 与结算间的竞争。

**不要求接纳版本与被替换版本不同**：Graph Patch 可以只改该 Work Package 的*契约*（例如依赖），修订 Planner 也可能原样交付同一份内容——两种情况下节点仍然必须重跑角色链，用内容版本当释放条件会让这类修订**永远无法结算**（实现比 delta 规格更严）。接纳版本仍作为事实记录，但不再充当隔离边界（见 D4）。

### D4. 旧角色证据按「本次持有登记」隔离

新旧结果的边界是**持有登记时刻**（`revision_holds.created_at`，重新登记时刷新）：pending 期间该节点的角色结果一律不构成推进证据；released 之后只认**在本次持有登记之后签发的物化绑定**所产生的角色结算，未修订节点维持原规则。这条边界随补丁变化，因此内容版本是否变化都不影响判定——这正是「只改契约、不改内容」的修订也能重跑角色链的原因。`admitted_contract_revision` 仍被记录（本次接纳的是哪一版内容），但不再充当隔离边界。该过滤规则作为一个应用层纯函数被执行投影、宿主 `establishedStatusOf`、Git 集成候选和 Finalizer 门禁复用；不复制完整生命周期状态机。判据只用 store 里两个已登记事件的先后（持有登记、绑定签发），不拿结果时间戳去猜版本，也不复制 Orca 事实。

### D5. 迁移与异常记录失败关闭

在 `src/adapters/storage/schema.ts` 追加 schema 13 migration，为 `revision_holds` 增加 nullable `prior_contract_revision` 与 `admitted_contract_revision`；已存在的 pending 持有保持 null，可在恢复时准备旧版本后走同一链路，已 released 的旧记录没有版本边界时沿既有投影规则。重新登记新补丁持有（`record-revision-hold`，以及 `record-graph-version` 内联的同源写入）清空两列并**刷新 `created_at`**：它记录的是「当前这次持有」的登记时刻，也是 D4 的隔离边界。解码器验证 nullable 非负安全整数；未知枚举、旧库只读版本不匹配与损坏记录继续拒绝。需修改 IC-03 的字段合同和 IC-11 的派生规则说明，不建立第二个 store 或复制 Orca 结果。

### D6. 验收以合同事实为准

行为测试覆盖旧派发未结算、完整结算后仅派 Planner、拒绝/额度、结算幂等、旧角色证据隔离与重启身份。隔离真实 PTY 各跑一次“保留并修订节点”和“退场节点”，核验 GraphVersion、Baseline Reconciliation、持有、角色链、Git 集成、Delivery Verdict 与重启 `(workPackageId, state, attemptId)`。真实测试只在显式一次性项目和专用身份运行；证据落盘后按现有夹具清理。

## Risks / Trade-offs

- 旧派发已产生绑定但 Delivery/Session 证据无法核验时，修订会保持阻塞；这比错误重复派发安全。
- schema 13 使旧版只读 `status` 拒绝新库，须同步升级运行进程；migration 保留所有旧记录。
- 执行 TUI change 仍 active；实施前需核对其未提交工作树和共享文件，串行编辑。

## Migration Plan

随正常可写 store 打开执行 schema 13 migration；既有 pending 持有按原 `sourceRef` 恢复，已 released 的旧记录不补造契约版本。无数据回填、无 Orca 数据库迁移。
