# Implementation Plan

## 1. 实施基线与权威来源

- **Baseline mode: `predecessor-contract`**。直接前驱：已归档的 `m2-repair-read-only-worker-sandbox`；规划 commit：`f86cd19b14ff9c4acda659f3de9040d0723e1992`。本 change 是仍 active 的 `m2-deliver-execution-tui` 5.2 的解阻塞项；共享文件串行编辑。
- 权威合同：`CONTEXT.md`、`docs/architecture.md` 的执行推进边界、`docs/interface-contracts.md` IC-03/IC-08/IC-10/IC-11、主规格 `execution/specification-revision`、本 change delta 与 design D1–D6。GraphVersion、持有、预算和绑定属 Branch Coordination Store；角色结果属 Orca，经已结算 Delivery 引用；授权来自已批准 Manifest。
- 冻结接缝：前驱已归档且 `openspec/specs/orchestration/read-only-worker-execution/spec.md` 存在；`record-graph-version` 继续原子登记图补丁持有并释放退场节点；`revision-service.ts` 的 `beginSpecificationRevision`/`settleSpecificationRevision`、`advance-execution.ts` 的 `advanceExecution`、`execution-view.ts` 的 `deriveExecutionFacts`、宿主 `roleDispatchesFor`/`nextAdvanceRole`/`establishedStatusOf`/`runExecutionTrigger`、IC-03 的 `release-revision-hold` 仍在。
- **Apply 前检查**：`git status --short` 核对现有用户改动与共享文件；`openspec list --json`、`openspec show execution/specification-revision --type spec`、`rg -n 'beginSpecificationRevision|settleSpecificationRevision|nextAdvanceRole|release-revision-hold|record-graph-version' src`、`pnpm exec vitest run tests/execution/specification-revision.test.ts tests/application/advance-execution.test.ts tests/application/execution-view.test.ts tests/coordination-store.test.ts`。若前驱、主规格、冻结接缝或用户正在编辑的文件状态漂移，先回到规划；不得覆盖未提交改动。

## 2. 复用与接缝

| IP-ID | 现有或前驱文件与符号 | 复用方式 | 禁止复制的事实 |
|---|---|---|---|
| IP-01 | `schema.ts` migration、`coordination-store.ts` 的 revision hold 命令/解码、IC-03 | 原事务新增接纳版本与额度边界；旧行保留 | Orca Task/Worker 状态 |
| IP-02 | `revision-service.ts` 的 begin/settle、`revision-budget.ts`、`baseline-reconciliation.ts` | 用同一用例准备已有 graph_patch 持有、结算 Admission | 第二套预算或基线账本 |
| IP-03 | `advanceExecution`、`evaluateDispatchCandidate`、`materializeWorkPackage`、宿主 `nextAdvanceRole`/`roleDispatchesFor` | 单一 Planner 许可供候选与物化两次核验 | 第二套生命周期状态机、无界 shell |
| IP-04 | `deriveExecutionFacts`、宿主 `establishedStatusOf`、`planFinalizerDispatch` | 共用当前契约版本的角色结算筛选 | 旧 Validator 结果、第二份投影事实 |
| IP-05 | 现有 Vitest/真实 PTY 夹具与 `docs/orca-compatibility.md` | 以持久事实验收两种补丁形态 | 运行日志推断 accepted |

## 3. 代码变更映射

| IP-ID | Task | Requirement/Scenario | 文件与符号 | 精确变化 | 不得改变 |
|---|---|---|---|---|---|
| IP-01 | 持久契约与迁移 | 新规格准入并结算；重启后继续同一次修订；旧 Validator 已通过 | `src/application/ports/branch-coordination-store.ts`、`src/adapters/storage/schema.ts`、`src/adapters/storage/coordination-store.ts`、`tests/coordination-store.test.ts`、`docs/interface-contracts.md` | `RevisionHoldRecord` 加 `priorContractRevision`/`admittedContractRevision: number|null`；新增同源准备旧版本命令，`release-revision-hold` 加可选的接纳版本和授权上限，匹配来源且版本不同时同事务释放/记录版本/计额，幂等重放先核对来源与版本；schema 13 migration、严格解码，重新置入持有清空两列；IC-03 更新字段与原子语义 | 退场支的图版本事务、旧库数据、预算所有权 |
| IP-02 | 修订用例 | 旧派发结清后重跑 Planner；准入失败或修订额度耗尽；新规格准入并结算 | `src/application/execution/revision-service.ts`、`tests/execution/specification-revision.test.ts` | begin 增加已接受 Graph Patch + 同源持有分支，从当前图、精确 Spec Binding 与 Provider 当前 Unit 核验旧内容版本，冲突/不可读则阻塞；经 IP-01 原子准备后复用额度/基线判定并返回续办计划；不调用纯内容修订的 `planSpecificationRevision`，不改写持有来源；settle 接收 WorkPackageId/补丁来源/接纳版本与 Manifest 上限，准入失败零写入，来源不符或版本未变拒绝，成功调用 IP-01 原子命令 | 新的图补丁写入路径 |
| IP-03 | 有界角色推进与宿主接线 | 旧 Worker 仍在途；旧派发结清后重跑 Planner；新规格准入并结算；重启后继续同一次修订 | `src/domain/dispatch-candidate.ts`、`src/application/execution/advance-execution.ts`、`src/application/materialize-work-package.ts`、`src/bootstrap/foreground-planning-runtime.ts`、`tests/application/advance-execution.test.ts`、`tests/application/materialize-work-package.test.ts`、`tests/integration/foreground-execution-runtime.test.ts` | 单一只读修订 Planner 许可检查全部已签发旧绑定的结算、当前观察/基线/额度/授权/hold 来源；宿主与推进器共用下一角色判定；物化门只允许匹配补丁的 planner，复用 worktree 并以已签发绑定计稳定 Attempt；最新精确 Planner Segment/Unit 路径经过 Admission，再调 IP-02 settle；拒绝保留 blocker，成功回读后发布事件 | 对其它角色/后代的持有门禁、Orca 私有接口 |
| IP-04 | 当前契约证据 | 已被替换的角色结果不得完成新修订／旧 Validator 已通过、新角色链完成 | `src/application/execution/execution-view.ts`、`src/bootstrap/foreground-planning-runtime.ts`、`tests/application/execution-view.test.ts`、`tests/integration/foreground-execution-runtime.test.ts`、`docs/interface-contracts.md` | 提取按 IP-01 接纳版本匹配的结算选择，供只读 Frontier、宿主集成资格与 Finalizer 门禁共用；pending 持有仍显示 revision_pending，released 后仅新版本可推进；IC-11 补充规则 | `baselineAdoptions` 与本 change 无关的旧集成投影修复 |
| IP-05 | 完成验证与记录 | 全部新增 Scenario，尤其重启与交付 | `tests/tui/pty-execution.test.ts`、`docs/orca-compatibility.md` | 复用隔离夹具分别验证 revise 与 retire；记录真实 Task/Dispatch/GraphVersion/持有/预算/集成/verdict 的事实及命令；更新兼容性结论 | 用户主项目、全局 Orca runtime、已归档规格 |

## 4. 调用与副作用顺序

1. 前台执行触发先完成现有 Delivery/Session 对账与 Baseline Reconciliation；从当前 Scope/GraphVersion、授权、快照、Orca 观察和预算读全量事实。只读许可拒绝缺失、旧派发未结算、live/unverifiable Worker、stale hold、未核验基线或额度不足。
2. 对符合条件的当前图节点，`beginSpecificationRevision` 验证原 `graph_patch` `sourceRef`、精确旧 Spec Binding 与 Provider Unit，先在原持有上原子准备旧内容版本，再返回 Planner 计划；保留 pending 持有。候选与物化门只给这一次 Planner 许可。OperationId、Attempt、launch 与 Task Envelope 从稳定补丁身份和已签发绑定派生；未决 intent 必须沿原 ID 对账。
3. 新 Planner 的 Delivery 结算、精确 Session Segment、Unit 路径与 Admission 依旧走现有用例。Admission 拒绝只记 blocker；通过时核对新内容版本与旧版本不同、Scope/GraphVersion/补丁来源未变，再以原持有来源调用 `settleSpecificationRevision`。
4. store 在同一事务内核对来源/版本/额度与授权引用，释放持有、记录接纳版本、计一次额度；重放仅在来源和版本均一致时幂等成功。调用方回读持有与预算后发布 `state-changed`。任何未知或读回失败保持对应 lane 阻塞，不换 ID 重试。
5. 后续 Frontier、Git 集成和 Finalizer 只用当前接纳版本的角色结果；旧版本结算保留审计历史但不产生推进权。退场支沿用现有事务释放。

## 5. Schema、状态与持久化落实

- schema 13 仅在 `revision_holds` 新增 nullable `prior_contract_revision` 与 `admitted_contract_revision`；新 pending 行两列为 null，准备后旧版本可为 0，已结算的修订持有保存正安全整数；历史 released 允许 null。新旧内容版本相等或来源不符 fail closed；重新登记新补丁清空两列。store 仍以 `(scope, workPackageId)` 唯一记录当前持有。
- IC-03 命令入参增加当前 Manifest `approvedLimit`，事务拒绝 `consumed + 1 > approvedLimit`、授权 ID 不符、版本无效或来源不符；原子预算不随重启重置。必须保留 graph version 事务对 retire 的现有行为。
- `revision_pending` 仍是受影响节点的显示阶段。新 Planner 许可只是限定一次物化，不改变 hold 本身；后代只有在新规格被接受且旧结果隔离后才解除冻结。
- 新角色链的真值是 DeliverySettlement 的 `contractRevision` 与持有记录的 `admittedContractRevision`；未产生新版本结果时，状态不能从旧结果推断。Schema 变更后旧进程只读打开拒绝，正常可写打开迁移；无需外部数据迁移。
- 不改变模型工具 schema、Worker Task Envelope、Orca CLI 或 Git policy；执行权限、lease/fencing、Operation Intent 与预算都按既有边界复核。

## 6. 验收证据矩阵

| Requirement/Scenario | IP-ID | 测试文件 | Fixture/前置条件 | 关键断言 | 可运行命令 |
|---|---|---|---|---|---|
| 在途修订／旧 Worker 仍在途 | IP-03 | `tests/application/advance-execution.test.ts` | revise 已派发、旧绑定未结算或观察不可核验 | 不派新 Planner、后续角色/后代/集成 | `pnpm exec vitest run tests/application/advance-execution.test.ts` |
| 在途修订／旧派发结清后重跑 Planner | IP-02, IP-03 | `tests/application/advance-execution.test.ts`、`tests/application/materialize-work-package.test.ts` | 旧绑定全部结算、基线 verified、额度可用 | 原 WorkPackageId/worktree，恰一新 Planner，同补丁身份 | `pnpm exec vitest run tests/application/advance-execution.test.ts tests/application/materialize-work-package.test.ts` |
| 在途修订／新规格准入并结算 | IP-01, IP-02, IP-03 | `tests/execution/specification-revision.test.ts`、`tests/coordination-store.test.ts`、`tests/integration/foreground-execution-runtime.test.ts` | 精确 Planner Binding 与新规格 | 同事务 hold released、版本落盘、预算 +1、事件可见 | `pnpm exec vitest run tests/execution/specification-revision.test.ts tests/coordination-store.test.ts tests/integration/foreground-execution-runtime.test.ts` |
| 在途修订／准入失败或修订额度耗尽 | IP-01, IP-02, IP-03 | 同上 | Admission 拒绝、上限已满、来源不符 | 零释放/零计额，结构化 blocker | `pnpm exec vitest run tests/execution/specification-revision.test.ts tests/coordination-store.test.ts` |
| 在途修订／重启后继续同一次修订 | IP-01, IP-03, IP-05 | `tests/integration/foreground-execution-runtime.test.ts`、`tests/tui/pty-execution.test.ts` | Planner 派发后退出再开 | 同一 Task/Dispatch/Attempt、持有与预算不重复 | `pnpm exec vitest run tests/integration/foreground-execution-runtime.test.ts`；隔离真实 PTY 见 §8 |
| 旧证据／旧 Validator 已通过 | IP-01, IP-04 | `tests/application/execution-view.test.ts`、`tests/integration/foreground-execution-runtime.test.ts` | 旧 validator 在 patch 后结算 | 不 accepted、不集成、不打开 Finalizer | `pnpm exec vitest run tests/application/execution-view.test.ts tests/integration/foreground-execution-runtime.test.ts` |
| 旧证据／新角色链完成 | IP-04, IP-05 | 同上及 `tests/tui/pty-execution.test.ts` | 新 contract revision 的 implementation/validator 已结算 | 才可集成并取得 deliverable | `pnpm exec vitest run tests/application/execution-view.test.ts tests/integration/foreground-execution-runtime.test.ts`；隔离真实 PTY 见 §8 |

## 7. 文件清单与升级条件

修改：`src/application/ports/branch-coordination-store.ts`、`src/adapters/storage/{schema,coordination-store}.ts`、`src/application/execution/{revision-service,advance-execution,execution-view}.ts`、`src/domain/dispatch-candidate.ts`、`src/application/materialize-work-package.ts`、`src/bootstrap/foreground-planning-runtime.ts`、`tests/{coordination-store,application/advance-execution,application/materialize-work-package,application/execution-view,execution/specification-revision,integration/foreground-execution-runtime,tui/pty-execution}.test.ts`、`docs/{interface-contracts,orca-compatibility}.md`。无需新增生产文件、依赖或删除文件。各 IP-ID 的可编辑文件仅限 §3 对应行；共享文件在对应 slice 内逐次编辑。若出现额外公共字段、Graph Patch 语义变化、无法从现有绑定证明旧派发终态、无效的预算上限来源、或真实验收需要改用户主项目，停止并修订设计/计划。

## 8. 验收 Agent 授权与限定审计

按 IP-01→IP-05 依次运行各行命令，再运行 `pnpm typecheck && pnpm lint && pnpm test && pnpm build && openspec validate m2-settle-in-flight-graph-revision --strict && git diff --check`。真实 PTY 在两个全新显式隔离项目分别覆盖保留修订、退场补丁；按研究记录 §5 的环境变量和 `pnpm exec vitest run tests/tui/pty-execution.test.ts --no-file-parallelism` 执行，保留证据后回收夹具。必须核验 revise 形态的 `accepted_revision`、Baseline Reconciliation `verified`、新角色链、`revision_holds` 无 pending、预算恰一次、受控集成、`delivery_verdicts=deliverable`、重启身份不变；retire 形态继续满足原结果。限定审计：旧结果越权、幂等与预算事务、Session/Run/Generation 绑定、共享文件中用户未提交改动。不得在 apply 阶段创建 `verification.md`。
