# 图修订落在在途节点上时，`revision_pending` 永不释放

> **状态（2026-09-28）**：本记录描述的缺口已由 change `m2-settle-in-flight-graph-revision` 收口，规格增量在
> `openspec/changes/m2-settle-in-flight-graph-revision/specs/execution/specification-revision/spec.md`。
> 本文其余部分保留为当时的缺陷报告与候选设计，不再代表当前实现：解冻判定（受限 Planner 许可）在
> `src/application/execution/advance-execution.ts`，续办与结算在 `revision-service.ts` + 宿主
> `foreground-planning-runtime.ts`，旧结果隔离在 `execution-view.ts`，持有边界（登记时刻与内容版本）在 schema 13。
> 实施期间另有两处同源缺陷被真实运行暴露并修复（授权门禁的 GraphVersion 判定、补丁请求饿住 Frontier），
> 实测与结论见 `docs/orca-compatibility.md`。

对应问题：`m2-deliver-execution-tui` 的 5.2 无法在当前代码上收口（该 change 的 `verification.md` 结论为 PARTIAL）。本文件是缺陷报告与实现交接，供后续独立的 change 使用；它不含产品决策，只给事实、根因、候选设计与验收计划。

结论先行：

1. **死锁是确定性的，不是环境问题**：只要被接受的 Graph Patch 选择**修订**（而不是退场）一个**已派发**的 Work Package，该节点就会永久停在 `revision_pending`，Scope 冻结到驱动截止，Finalizer 门禁永不满足。
2. **登记规则是正确的，缺的是释放路径**：规格明确要求「修订**或退休**需求在 Worker 已派发时被报告」都把受影响节点置 revision pending，其当前 Worker 先运行至可核验终态；规格修订本应由「规格重新准入」解除持有，但**运行时从未调用** `beginSpecificationRevision` / `settleSpecificationRevision`（这两个用例目前只被测试引用）。
3. **退休支已经修好，修订支没有**：`record-graph-version` 现在会在同一事务里释放「已不在新图中」的节点持有；宿主另有只读 store 的兜底 `settleRetiredRevision`。本报告针对的是**节点仍在图内**的那一支。
4. **推荐做法是把既有用例接进运行时**（解冻 → 重新从 planner 起跑 → 准入 → 准入通过后同事务释放持有并计一次额度），而不是放宽规格。备选做法（补丁被接受即视为修订生效）需要显式改写规格 Requirement，代价是允许旧结果与新 contract 交错。
5. 真实运行的证据、脚手架位置、已修缺陷清单与验收命令都在下面，续接成本很低。

## 1. 现象与真实运行证据

| 运行 | 补丁形态 | 结果 |
| --- | --- | --- |
| `orca-companion-e2e46`（2026-09-27） | v2 **保留两个节点**（`retired: []`，修订 `readme-banner`） | 驱动跑到 515 轮 / 90 分钟后被手动终止（日志尾 `exit=143`）：`revision_holds = readme-banner pending`、`delivery_settlements = planner×4 / implementation×2 / validator×1`、无 verdict；投影停在 `revision_pending:graph_patch` |
| `orca-companion-e2e43` / `e2e45`（同日） | 同上（修订） | 同样跑到 100 分钟驱动截止，持有仍 pending、无 verdict |
| `orca-companion-e2e37`（修复前） | v2 **退场** `readme-banner`（`retired: [...]`） | 同一死锁的退场版本：Git 侧其实已集成成功（canonical 有集成提交、远端有 `e2e37-integration`），但没有交付结论 |
| `orca-companion-e2e40`（曾判 PASS，后被撤销） | — | 8 passed / 1 skipped，但当时那份构建把退场节点从 `revisionPendingWorkPackageIds` **过滤掉**了，与规格冲突 |

持久事实保存在 `~/.cache/orca-acceptance/evidence/orca-companion-e2e{37,38,40,41,42,43,44,45,46}.json`，原始日志在同目录 `logs/`。

## 2. 规格约束（不可绕过的原文）

`openspec/specs/execution/specification-revision/spec.md:28`：

> 当修订或退休需求在 Worker Task 已派发时被报告，系统 SHALL 只把受影响 Work Package 及其未接受后代置为 revision pending；无关节点 MUST NOT 被冻结……受影响 Work Package 的当前 Worker SHALL 运行至可核验终态，其后 MUST NOT 派发后续角色或依赖工作。旧结果 MUST NOT 越过该持有或已完成集成继续推进。

因此不能采用「干脆不登记持有」的做法（本轮曾这样做，被规格判定为错误实现并回滚）。

## 3. 根因链（含精确位置）

1. **编译器登记持有**：`src/domain/execution/graph-compiler.ts:497-505` — `revisionPendingWorkPackageIds = revised(已派发) ∪ retire(已派发)`。
2. **补丁应用写库**：`src/application/execution/graph-patch-service.ts`（`revisionPendingWorkPackageIds` 传入 `appendAcceptedRevision`，其中基线规划已跳过退场节点）→ `src/adapters/storage/coordination-store.ts` 的 `record-graph-version` 事务把持有写进 `revision_holds`。
   - 该事务现在还会**释放已不在新图中的节点持有**（退休支修复）；仍在图里的节点持有保持 `pending`。
3. **冻结投影**：`src/domain/execution/revision-pending.ts:42`（`frozenWorkPackageIds`）与 `:65`（`projectRevisionPending`）——持有存在即冻结该节点及其未接受后代，并把它从「可准入集合」里减掉。
4. **界面状态**：`src/application/execution/execution-view.ts:494-497` — `workflow.revisionHold !== null` 即投影为 `revision_pending`。
5. **推进被显式排除**：`src/application/execution/advance-execution.ts:255`（`nextRoleOf`）只为 `admitting` / `implementing` / `validating` 派发角色；`revision_pending` 被文档化为 blocker。
6. **释放路径存在但未接线**：`src/application/execution/revision-service.ts` 导出 `beginSpecificationRevision`、`settleSpecificationRevision`（准入通过才释放持有并同事务计一次 `specificationRevisions` 额度）、以及本轮新增的 `settleRetiredRevision`；对全仓库 grep 的结果是**只有测试引用前两者**，运行时没有任何调用点。
7. **宿主侧目前只处理退场支**：`src/bootstrap/foreground-planning-runtime.ts:4957`（`settleRetiredRevisionHolds`，由 `:6093` 在 `runExecutionTrigger`（`:6003`）里调用；触发点覆盖用户命令 / 事件 / 图应用）。

推论：节点一旦被「修订 + 已派发」组合命中，既不会被冻结之外的路径派发（5），也没有任何人调用释放（6），于是永远停在 `revision_pending`。

## 4. 候选设计

### A（推荐）解冻 → 重新规划 → 准入 → 结算

把「持有」的语义兑现为「等当前 Worker 收尾，然后按新 contract 重跑规划链」，四步：

1. **冻结只在仍有未结算派发时生效**
   - 在 `revision-pending.ts` 增加一个纯函数（例如 `holdsBlockingAdmission({ holds, bindings, settledDispatchIds })`），输入取自 store 事实（物化绑定 × 已结算结果），持有节点的所有 Dispatch 都结算后不再冻结。
   - `advance-execution.ts:315`（`revisionPendingOf`）与 `execution-view.ts:494` 都改用这条规则，避免同一语义两处实现。
   - 效果：Worker 收尾后节点离开 `revision_pending`，重新进入可推进集合。
2. **修订节点重新从 planner 起跑**
   - `nextRoleOf`（`advance-execution.ts:255`）在「持有已不再冻结、但修订尚未结算」时返回 `planner`；这与 `planSpecificationRevision` 的 `roleChainFrom: 'planner'` / `reAdmissionRequired: true` / `reuseWorktree: true` 一致。
   - 需要核验 `materializeWorkPackage` 的门禁是否允许「复用原 worktree + 新的 planner attempt + contractRevision+1」（现有 attempt key 形如 `planner:0:1`，其中计数语义需要确认；`specificationRevisionRequiredWorkPackageIds` 也在同一处使用）。
3. **准入通过后结算**
   - 宿主在 `admitPlannerUnit` 成功分支（`foreground-planning-runtime.ts:3818`，同一函数里另一处调用在 `:3062`，拒绝分支在 `:3834`）之后，若该 Work Package 有 pending 的 `graph_patch` 持有，则调用 `settleSpecificationRevision`：同事务释放持有 + 计一次 `specificationRevisions`。
   - 建议把 `settleSpecificationRevision` 的入参从 `plan` 收敛为 `workPackageId`（它内部只用到 `plan.workPackageId` 与 `revisionId`），避免调用方为了满足签名去伪造 plan；`revisionId` 用持有行的 `sourceRef`（即补丁 id）。
4. **订阅/事件**：结算成功后 `publish` 一次 `state-changed`，让界面与驱动立刻看到状态变化（现有 `settleRetiredRevisionHolds` 已有同样做法可参照）。

风险与待确认：
- 第二次 planner attempt 的 attempt 计数、预算键与 `revision_pending` 期间的派发门禁（`dispatchCandidate` / `guardDispatchCandidate`）是否已支持「修订重跑」；
- 准入路径要求 planner 的精确 Session Binding 与已记录的 specification unit 路径（`materializeBindings[...].specificationUnitPath`），修订 attempt 是否复用同一绑定需要确认；
- 后代冻结：修订节点的未接受后代在解冻后是否也要跟着重跑（规格只要求「未接受后代不得越过持有推进」，解冻后的处理需要明确）。

### B（备选）修订即生效，不等待在途 Worker

补丁被接受时直接释放持有（等价于「修订已生效」）。

- 代价：违反 §2 原文（允许旧结果与新 contract 交错），需要在规格里显式改写该 Requirement 并重新评估「旧结果不得越过持有推进」的保证。
- 适用：若 A 的实现成本被判定不可接受，则必须把这条语义变化写成规格变更，而不是在实现里悄悄放宽。

## 4b. 同源的次要不一致（顺手交给同一个 change 评估）

`src/application/execution/execution-view.ts:561` 把「已接受」判在 `workflow.adoption?.integrationRef` 上（即只有存在 Baseline Adoption 记录才算已接受），而宿主自己的 `integrationCompletedFor`（`foreground-planning-runtime.ts:4909`）判的是「该 Work Package 有已收尾且被接受的 `git-integration` intent」。同一事实两套规则：真实运行 `orca-companion-e2e38` 里 `notes-basics` 的集成已经落进 canonical（提交 `9eaf139e…`/`09f94dac…`、远端 ref 已推），界面仍显示 `waiting_integration`、`integration: {state: 'waiting', ref: null}`。这条不影响 Finalizer 门禁（门禁只看 validation 状态 + 集成 intent），但会让界面与「已交付」的持久事实不一致；若新 change 要动投影，建议一并收敛到集成证据这一条规则上。

## 5. 测试与验收计划

行为测试（每条都应「修复前失败、修复后通过」）：

1. 冻结只在该节点仍有未结算派发时生效；结算后解冻（`tests/execution/revision-pending.test.ts`）。
2. 解冻后该节点的下一个角色是 `planner`，而不是 implementation/validator（`tests/application/advance-execution.test.ts`）。
3. 准入通过后：持有释放、`specificationRevisions` 计数 +1、同事务（`tests/execution/specification-revision.test.ts`）。
4. 准入被拒时保持 `pending`，并在界面/阻塞中如实呈现（同上）。
5. 修订额度耗尽时的结构化 blocker（`revision-budget.ts` 既有语义）。
6. 投影与推进使用同一条冻结规则（`tests/application/execution-view.test.ts`）。

真实 PTY 验收（两次，各用全新夹具）：

```sh
# 前置：隔离 alpha Codex 与包装器只在本次进程 PATH 生效
export PATH="$HOME/.cache/orca-acceptance/acceptance-bin:$PATH"
export GH_REPO=leike0813/orca-companion-test
bash ~/.cache/orca-acceptance/setup-fixture.sh <fresh-isolated-project> <name>   # 打印三个必需环境变量

pnpm build
ORCA_COMPANION_REAL_HARNESS=1 ORCA_COMPANION_REAL_REPO=<fixture> \
ORCA_COMPANION_REAL_IDENTITY=<term_...> ORCA_COMPANION_COORDINATOR_MODEL=minimax-cn/MiniMax-M3 \
ORCA_COMPANION_PTY_RECOVERY_INTERRUPT=0 \
pnpm exec vitest run tests/tui/pty-execution.test.ts --no-file-parallelism
```

- 同一次运行内必须同时取得：补丁 GraphVersion（`record_kind = accepted_revision`）、受影响节点的 Baseline Reconciliation `verified`、`delivery_verdicts = deliverable`、退出重启后 `(workPackageId, state, attemptId)` 不变、且 `revision_holds` **不残留 pending**。
- 因为 Planner 草案可能选择「修订」或「退场」，两种形态各跑一次；`collect-evidence.py` 可在运行后把结论事实导出比对。
- 运行结束后按现有做法回收夹具与 Orca 登记（`orca terminal close --worktree … --all`、`project setup-delete`、删除目录），并先把事实落盘。

## 6. 已在本次会话修好、不必重做的部分

产品侧（均带先失败后通过用例或真实链路证据）：worktree base ref、已终结 Recovery 的阻塞投影、执行租约随 Incarnation 重指、租赁续约把良性 CAS 竞争误判为 fencing、多 Work Package 代际的基线补救登记与门禁位置、`request_graph_patch` 的有界等待与逐轮 Delivery 结算、Admission 拒绝回带逐条编译错误、**退休支的持有释放**（同事务 + 宿主兜底）。

需要知道的两个既有事实：`request_graph_patch` 在 Scope `paused` 时按设计返回 `control_state`；九字段声明由模型转写，验收必须用字面 JSON 提交否则会被路由成 `no_change`。

测试脚手架（不在仓库内，机器重启曾丢失过一次，现已放到持久位置）：`~/.cache/orca-acceptance/`，含隔离 Codex `0.159.0-alpha.3`（`codex-alpha/`）、`acceptance-bin/{codex,orca}` 包装器、`setup-fixture.sh`（建夹具 + `orca repo add` + 专用身份终端）、`collect-evidence.py`（只读导出结论事实）、`template/`（夹具基线树，`limits.maxActiveWorkPackages = 8`、`concurrencyLimit = 1`）、`evidence/`、`logs/`。驱动侧已修：`noChangeRounds` 不再把「有 Worker 在途」计成无进展、`IN_FLIGHT_WINDOW_MS` 提到 30 分钟、集成提交断言只针对仍在图内的节点、reconcile 画面采集时机提前。

## 7. 相关文档锚点

- `docs/orca-compatibility.md`：两支释放路径的差别与实测事实（退休支已修并真机通过；修订支已按本 change 接线，其真实运行的停滞与修复见该文件 2026-09-28 的「在途修订节点…」条目）、`control_state` 语义、声明转写保真度、`maxActiveWorkPackages` 与串行派发无关。
- `docs/interface-contracts.md`：`ScopeControlService.reconcile`（只对账、重放未确认 Delivery）。
- `openspec/changes/m2-deliver-execution-tui/verification.md`：结论 PARTIAL、9 处已修缺陷的清单与证据、本次运行证据表。
- 本变更的 5.2 只有在上面第 5 节的真实运行全绿后才能勾选。
