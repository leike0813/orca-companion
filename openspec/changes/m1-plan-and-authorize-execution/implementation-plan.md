# Implementation Plan

## 1. 实施基线与权威来源

基线模式：**predecessor-contract**。

直接前驱：`m1-run-coordinator-sessions`。规划提交：`cd29e2bcd8b0278d34ae19db64cb8ebdaf149279`（本 change 起草时的仓库 HEAD）。

架构合同基线：`docs/architecture.md` 的 `MOD-01`–`MOD-04`、`FLOW-02` 与 `docs/interface-contracts.md` 的 `IC-01`–`IC-05`。本 change Create `IC-05`，Extend `IC-03`，Consume `IC-01`/`IC-02`/`IC-04`。

实施前必须同时满足：

1. `m1-run-coordinator-sessions` 已归档（`openspec list --json` 中不再出现，且 `openspec/changes/archive/` 下存在其快照）；
2. 其 delta 已合并进 `openspec/specs/`，`openspec list --specs --json` 能列出 `coordinator/session-runtime` 等 capability；
3. 下列冻结接缝在实现 HEAD 上仍以同名符号存在且语义未变。任一不满足即停止实施并回到 planning。
4. `IC-05` 的 canonical paths 尚无平行 graph repository/Manifest/handoff 类型，且 `IC-03`/`IC-04` 的 owner 与调用顺序未漂移。

| 冻结接缝 | 期望形态 | 本 change 的使用方式 |
|---|---|---|
| Coordinator Session / checkpoint | 前驱的 Session 身份、thread 映射与 checkpoint store 入口 | 规划工具节点与交接提案在同一 Session 内运行，规划事实不写入 checkpoint |
| Wake Batch | 前驱的 Wake Batch 准入入口与稳定 batch ID | 规划推进与交接决定通过同一 Wake Batch 路径恢复模型 |
| Capsule / Native Window | 前驱的上下文有界化与不透明原生窗口处理 | 规划工具的输入输出沿用同一有界化路径 |
| Model Config | 前驱的 Coordinator Model Configuration 到 chat model 绑定与能力核验 | 规划阶段复用同一模型装配，不新增 provider 路径 |
| CoordinationMode / ControlState | `m1-persist-coordination-state` 的 `src/domain/coordination/mode.ts` | 直接复用模式与正交控制状态，不在 planning 下再定义同名类型 |
| Execution Coordination Lease | `src/application/coordination/lease-service.ts` 的取得、释放与 fencing 规则 | 模式 cutover 只编排既有 lease interface，不导出第二个 `acquireExecutionLease` |

权威输入：`CONTEXT.md`、`AGENTS.md` 第 5/7/8 节、`docs/research/orca-task-dag-execution-graph.md`、`docs/research/orca-public-control-contracts.md`。设计决策见 `design.md` 的 D1–D20。tracker 为 GitHub（`origin` = `https://github.com/leike0813/orca-companion`），访问经已安装的 `gh` 2.98.0。

术语：前驱 apply 已把 `CONTEXT.md` 与 `AGENTS.md` 的 Coordinator Profile 同步为 Coordinator Model Configuration。本 change 沿用该术语，不编辑这两个文档。

### 合同 create/extend/consume

| 关系 | 合同与 canonical symbols | 漂移检查 |
|---|---|---|
| Create | `IC-05`：`src/domain/planning/`、`graph-history.ts`、`planning-handoff.ts`、`initialize-scope.ts` | Manifest 字段一次定型；GraphHistory 是唯一图写 seam；planning handoff 只转移规划责任 |
| Extend | `IC-03`：graph/auth refs、planning handoff records | 通过同一 store/migration/CAS，不保存图体或 tracker 正文 |
| Consume | `IC-01`、`IC-02`、`IC-04`、`FLOW-02` | 不复制 Session runtime、Wake admission、Outcome 或 identity 类型 |

## 2. 复用与接缝

| IP-ID | 现有或前驱文件与符号 | 复用方式 | 禁止复制的事实 |
|---|---|---|---|
| IP-1 | 前驱 `src/application/coordinator/`（Runtime Guard、Actionable Work、Suspension、Maintenance Lane） | 规划用例复用准入、挂起与 Wake Batch 路径 | 不复制 Session 或 checkpoint 逻辑 |
| IP-1 | 前驱 `src/domain/coordinator/session-state.ts` | 复用 Session 身份类型 | 不在领域层引入 tracker 或 Orca 类型 |
| IP-2 | `src/domain/planning/`（新）与 `src/domain/coordination/mode.ts` | 定义规划领域类型与校验；模式与控制状态直接复用既有类型 | 不保存地图或票据副本，不定义第二套模式类型 |
| IP-3 | 前驱 `BranchCoordinationStore`、schema migration 与 lease interface | 通过 CAS revision 保存授权引用、Claim、交接阶段与 graph 当前引用；新增记录走显式 migration | 不新建本地库，不复制 lease 不变式 |
| IP-4 | `gh` CLI 2.98.0 | 通过 `gh issue view`/`gh issue edit` 等子命令读写 | 不直接调用 GitHub API 或保存凭据 |
| IP-5 | 前驱 `src/workflow/coordinator/graph.ts` | 按模式注册规划工具节点 | 不在工具节点内复制编译、门禁或交接规则 |
| IP-6 | `src/domain/planning/` 的 Implementation Plan 类型与本 change 的 `ExecutionGraphHistory` | 编译输入与候选图唯一追加/读取接缝 | 不把编译器变成语义评审器，不把图体塞入 scope 记录 |
| IP-7 | `CONTEXT.md`、`AGENTS.md` 的既有术语 | 只读核对术语一致性 | 不编辑这两个文档 |
| IP-9 | 无 | 新增真实 provider 冒烟测试 | 不把真实调用纳入普通 `pnpm test` |

## 3. 代码变更映射

| IP-ID | Task | Requirement/Scenario | 文件与符号 | 精确变化 | 不得改变 |
|---|---|---|---|---|---|
| IP-1 | 1.1 | 模式随 Scope 而非 Session 变化 / 控制状态不伪装成模式 | 复用 `src/domain/coordination/mode.ts` 的 `CoordinationMode`、`ControlState`；新增 `tests/application/planning-mode.test.ts` | 规划用例只消费既有类型并验证模式级行为 | 不新增 planning 专属模式或第二套控制状态 |
| IP-2 | 1.2 | 本地不保存地图副本 / 用户提供的计划只作参考 | `src/domain/planning/route-map.ts`（`RouteMapRef`、`RouteMapSection`、`DecisionTicket`、`PlanningReference`、`parseRouteMapSections`） | 新增引用与固定章节类型及解析 | 不在领域层保存票据正文 |
| IP-2 | 1.2 | 已认领票据不出现在 Frontier / 进程退出不释放认领 | `src/domain/planning/ticket-claim.ts`（`TicketClaim`、`projectFrontier`） | 认领语义与 Frontier 投影 | 不按进程存活释放 Claim |
| IP-3 | 1.3 | 写入固定章节 / 复述已解决决策不新增章节 | `src/application/planning/route-map-service.ts`（`readRouteMap`、`updateRouteMapSection`、`claimTicket`、`releaseTicket`、`resolveTicket`） | 固定章节写入与 Claim 生命周期 | 不写配置地图之外的路径 |
| IP-4 | 1.4 | 本地不保存地图副本 | `src/adapters/tracker/gh-tracker.ts`（`readIssue`、`updateIssueBody`、`assignIssue`） | 通过 `gh` 读写，输出 schema 校验 | 不新增 tracker SDK、不落凭据 |
| IP-5 | 2.1 | 同一计划编译出相同拓扑 / 编译失败即拒绝候选图 | `src/domain/planning/execution-graph.ts`（`ExecutionGraph`、`GraphVersion`、`WorkPackage`）；`graph-compiler.ts`（`compileExecutionGraph`、`CompilationError`）；`src/application/planning/graph-history.ts`（`recordInitialGraph`、`loadCurrentGraph`） | 纯函数编译与结构检查；以追加历史记录并读回初始 GraphVersion | 不做语义评判、不截断预算、不把当前引用当作图体 |
| IP-5 | 2.1 | 超限计划不产出可授权候选图 / 并发上限随图一并固定 | `src/domain/planning/budget-policy.ts`（`defaultBudgetPolicy`、`assertWithinCaps`） | 有限上限与超限失败 | 不放宽或静默截断 |
| IP-5 | 2.2 | 新规划产生新世代 | `src/application/planning/graph-generation.ts`（`startGraphGeneration`、`GraphGeneration`） | 新 GraphId、新空 Orca Run、世代记录 | 不复用前代标识或 WorkPackageId |
| IP-5 | 2.2 | 地图变更使候选图过期 | `src/application/planning/graph-generation.ts`（`isCandidateStale`） | 以地图 revision 判定过期 | 不静默重编译旧候选 |
| IP-6 | 3.1 | 缺字段不提交批准 / Manifest 与候选图严格对应 | `src/domain/planning/execution-authorization.ts`（`ExecutionAuthorizationManifest`、`parseManifest`、`manifestFingerprint`、默认预算常量） | Manifest 结构与完整性校验；显式绑定实现尝试、Validator 修复、Graph Revision、Specification Revision 与 `maxRecoveriesPerWorkerAttempt` 等全部有限上限 | 不允许后继新增预算字段、部分字段、模糊引用或空上限 |
| IP-6 | 3.1 | 单次决定覆盖整份 Manifest / 未获批准时不产生可执行授权 | `src/application/planning/authorization-service.ts`（`proposeManifest`、`recordApproval`、`activeAuthorization`） | 原子批准与版本化授权记录 | 不产生部分或隐式授权 |
| IP-6 | 3.1 | 恢复次数受 Manifest 约束 / 改变恢复上限需要重新授权 | `src/application/planning/authorization-service.ts`（`assertAuthorized`、`maxRecoveriesFor`） | 恢复上限的读取与越界拒绝 | 不在执行中放宽上限、不沿用旧授权 |
| IP-6 | 3.2 | 初始化向导不询问恢复上限（D8） | `src/domain/planning/execution-authorization.ts`（`parseManifest` 的默认值填充）；`src/application/planning/initialize-scope.ts`（`initializeCoordinationScope`） | 定义原子创建 Scope、Planning Cycle 与首个 Session 的应用用例；执行预算仅在 Manifest 阶段确定 | 不在 Scope 初始化时写 Run、Task、worktree、预算、权限或 accepted risks |
| IP-7 | 4.1 | 存在开放票据时不切换 / 编译未通过时不切换 / 缺少批准时不切换 | `src/application/planning/handoff-gate.ts`（`evaluateHandoffGate`、`HandoffBlockers`） | Controller 侧门禁判定 | 不由模型宣告门禁通过 |
| IP-7 | 4.1 | 只有一个 Session 持有 Lease / Lease 持有者退出后可恢复 / Lease 过期不释放其他所有权 | `src/application/planning/lease-handoff.ts`（`transitionToExecution`），组合 `src/application/coordination/lease-service.ts` | 同批切换模式、引用与既有 Execution Lease；复用唯一 lease 不变式 | 不导出第二个 `acquireExecutionLease`，不自动转移 Lease、不释放 Claim 与预算 |
| IP-3 | 4.2 | prepare 阶段只产出提案 / review 阶段独立复核 | `src/application/planning/planning-handoff.ts`（`preparePlanningHandoff`、`reviewPlanningHandoff`、`PlanningHandoffProposal`） | 三阶段交接的前两阶段与持久化 | 不提前转移责任、不跳过复核 |
| IP-3 | 4.2 | cutover 才转移责任 / 交接不触碰执行中的 Worker | `src/application/planning/planning-handoff.ts`（`cutoverPlanningHandoff`） | 责任转移落盘 | 不释放、停止或重新归属在途 Worker，不改 Execution Coordination Lease |
| IP-3 | 4.3 | 取消交接恢复原责任方 / 过期提案不进入 cutover | `src/application/planning/planning-handoff.ts`（`cancelPlanningHandoff`、`isProposalStale`） | 取消与过期判定 | 不留下半转移状态、不以过期提案转移 |
| IP-3 | 4.3 | 崩溃后按持久阶段恢复 | `src/application/planning/planning-handoff.ts`（`resumePlanningHandoff`） | 按持久阶段确定性恢复 | 不猜测责任归属 |
| IP-3 | 4.3 | awaiting_user_prompt 激活门 | `src/application/planning/planning-handoff.ts`（`activationGate`、`HandoffActivation`） | 未满足激活门时禁止规划动作 | 不绕过激活门修改 Route Map |
| IP-8 | 5.1 | 规划工具按模式与事实动态暴露（D17） | `src/workflow/coordinator/planning-tools.ts`（`planningToolset`）、`src/workflow/coordinator/graph.ts`（按模式注册） | 注册有界规划工具并动态暴露 | 不在节点内复制业务规则 |
| IP-7 | 5.2 | 术语一致性（proposal「What Changes」） | `CONTEXT.md`、`AGENTS.md`（只读核对） | 确认前驱术语同步生效 | 本 change 不编辑这两个文档 |
| IP-9 | 6.1 | D20 | `tests/integration/minimax-m3-planning-smoke.test.ts`（`generateCapsuleSmoke`、`runPlanningHandoffSmoke`） | MiniMax-M3 冒烟：真实生成一次 Context Capsule 并完成一次真实 Route Planning Handoff | 不把真实调用写成默认测试、不在未显式选择时运行、不替代故障窗口的 fake 覆盖 |

## 4. 调用与副作用顺序

规划读取：解析地图票据引用 → 经 tracker adapter 读取票据 → 校验固定章节 → 投影 Frontier 与已认领票据。

规划写入：重验 scope、ownership、revision、权限与预算 → 先持久化 Operation Intent → 经 tracker adapter 写入 → 读回核验 → 完成 intent。响应丢失或 transport 故障按 unknown 处理并沿用同一操作 ID 对账，不换 ID 重试。

编译：读取 Implementation Plan 与配置 → 校验 schema、引用、无环、Scope Envelope 与预算 → 产出候选图与 GraphId → 绑定地图 revision → 以 `recordInitialGraph` 追加并回读初始 GraphVersion → 记录当前 graph 引用。任一检查失败即返回 CompilationError，不写图历史。

授权：组装完整 Manifest（含 `maxRecoveriesPerWorkerAttempt`，未指定时取默认 1）→ 校验每个必填字段与引用一致性 → 计算内容指纹 → 提交一次用户批准 → 记录版本化 Execution Authorization。缺字段或引用不一致时在提交批准前拒绝。

规划责任交接：prepare 落盘提案并保持原责任方 → review 独立复核地图 revision、开放票据、计划工件与候选图 → cutover 落盘责任转移。取消、提案过期或崩溃时按持久阶段回到确定状态；激活门未满足时禁止接收方推进规划。

执行模式交接：评估门禁 → 全部满足才同批写入模式、Graph Generation、Orca Run 引用、授权引用、预算引用与 Execution Coordination Lease → 任一项失败则整体不生效并保持 `route_planning`。

失败处理：编译失败、门禁未满足、批准缺失、提案过期、tracker 不可达一律以显式拒绝或 unknown 结束，不用降级路径推进模式或转移责任。

## 5. Schema、状态与持久化落实

- 权威归属：Route Map 与 Decision Ticket 正文归 tracker；`ExecutionGraphHistory` 以初始 GraphVersion 与后续 accepted patch 的追加记录拥有图拓扑；模式、地图/计划 revision、当前 graph/authorization 引用、交接提案与阶段、Claim 的 Session 侧记录归 Branch Coordination Store；Orca Run 与 Task 事实归 Orca。
- 表与约束：不新增 SQLite 文件；通过前驱的版本化 migration 在 `coordination.sqlite` 增加 graph history、authorization 与 planning handoff 所需表，既有记录原样保留。所有共享写入使用 expected revision，交接记录带阶段字段以保证可重放。
- 事务：模式切换与 Lease 交接在同一 CAS revision 下同批写入；交接责任转移在 cutover 落盘时原子完成；tracker 写入通过 Operation Intent 与读回核验保证可对账。
- 版本与审计：Manifest 带版本与内容指纹，授权记录引用该版本并携带全部有限预算字段；地图 revision 变化使旧候选图与未决交接提案过期。
- 校验边界：tracker adapter 输出、Manifest 与编译输入都做运行时 schema 校验，未知枚举或缺失必填字段 fail closed。

## 6. 验收证据矩阵

| Requirement/Scenario | IP-ID | 测试文件 | Fixture/前置条件 | 关键断言 | 可运行命令 |
|---|---|---|---|---|---|
| 模式随 Scope 而非 Session 变化 | IP-1 | `tests/application/planning-mode.test.ts` | 记录模式后增删 Session | 复用的模式值不变 | `pnpm exec vitest run tests/application/planning-mode.test.ts` |
| 控制状态不伪装成模式 | IP-1 | 同上 | 暂停、阻塞、取消 | 复用的 `ControlState` 改变而模式仍为原值 | 同上 |
| 本地不保存地图副本 | IP-2, IP-4 | `tests/domain/route-map.test.ts`、`tests/adapters/gh-tracker.test.ts` | 受控 tracker 输出 | 本地只有引用，无票据正文 | `pnpm exec vitest run tests/domain/route-map.test.ts tests/adapters/gh-tracker.test.ts` |
| 用户提供的计划只作参考 | IP-2 | `tests/domain/route-map.test.ts` | 传入 OpenSpec 与任务列表 | 分类为 Planning Reference | 同上 |
| 写入固定章节 | IP-3 | `tests/application/route-map-service.test.ts` | 已有地图正文 | 更新落在固定章节 | `pnpm exec vitest run tests/application/route-map-service.test.ts` |
| 复述已解决决策不新增章节 | IP-3 | 同上 | 已解决票据 | 无新章节结构 | 同上 |
| 已认领票据不出现在 Frontier | IP-2, IP-3 | `tests/domain/ticket-claim.test.ts` | 一个已认领票据 | Frontier 排除该票据 | `pnpm exec vitest run tests/domain/ticket-claim.test.ts` |
| 进程退出不释放认领 | IP-2, IP-3 | 同上 | 认领后模拟 incarnation 退出 | Claim 保留 | 同上 |
| 同一计划编译出相同拓扑 | IP-5 | `tests/domain/graph-compiler.test.ts`、`tests/application/graph-history.test.ts` | 固定计划与配置 | 两次结果相同，初始 GraphVersion 可按同一 interface 读回 | `pnpm exec vitest run tests/domain/graph-compiler.test.ts tests/application/graph-history.test.ts` |
| 编译失败即拒绝候选图 | IP-5 | 同上 | 含环或悬空引用的计划 | 返回 CompilationError，无候选图 | 同上 |
| 超限计划不产出可授权候选图 | IP-5 | `tests/domain/budget-policy.test.ts` | 超上限预算计划 | 编译失败并列出超限项 | `pnpm exec vitest run tests/domain/budget-policy.test.ts` |
| 并发上限随图一并固定 | IP-5 | 同上 | 默认配置 | 上限为有限值 | 同上 |
| 新规划产生新世代 | IP-5 | `tests/application/graph-generation.test.ts` | 已有前一代 | 新 GraphId 与空 Run，无标识复用 | `pnpm exec vitest run tests/application/graph-generation.test.ts` |
| 地图变更使候选图过期 | IP-5 | 同上 | 绑定后地图 revision 变化 | 候选图判定为过期 | 同上 |
| 缺字段不提交批准 | IP-6 | `tests/domain/execution-authorization.test.ts` | 缺 baseline HEAD 或恢复上限的 Manifest | 拒绝进入待批准 | `pnpm exec vitest run tests/domain/execution-authorization.test.ts` |
| 恢复上限显式绑定且取默认值 | IP-6 | 同上 | 未指定恢复上限的 Manifest | 写入默认值 1，无空值 | 同上 |
| Manifest 与候选图严格对应 | IP-6 | 同上 | 引用不一致的 Manifest | 批准失败并报告不一致 | 同上 |
| 初始化向导不询问恢复上限 | IP-6 | `tests/application/authorization-service.test.ts`、`tests/bootstrap/coordinator-runtime.test.ts` | Scope 初始化路径 | 向导不出现该字段询问 | `pnpm exec vitest run tests/application/authorization-service.test.ts tests/bootstrap/coordinator-runtime.test.ts` |
| 单次决定覆盖整份 Manifest | IP-6 | `tests/application/authorization-service.test.ts` | 完整 Manifest 与一次批准 | 授权覆盖全部字段并带版本 | 同上 |
| 未获批准时不产生可执行授权 | IP-6 | 同上 | 未批准或拒绝 | 无有效授权，候选图惰性 | 同上 |
| 策略内操作不再逐次审批 | IP-6 | 同上 | 已批准 Manifest | 策略内操作通过且受 revision 约束 | 同上 |
| 越界操作需要单独授权 | IP-6 | 同上 | 发布或部署类操作 | 被拒绝直到单独授权 | 同上 |
| 恢复次数受 Manifest 约束 | IP-6 | 同上 | 已用恢复次数达上限 | 停止并升级，不放宽上限 | 同上 |
| 改变恢复上限需要重新授权 | IP-6 | 同上 | 需要调整上限 | 产生新版本 Manifest 与新批准 | 同上 |
| 存在开放票据时不切换 | IP-7 | `tests/application/handoff-gate.test.ts` | 仍有开放票据或 fog | 保持 route_planning，无 worktree | `pnpm exec vitest run tests/application/handoff-gate.test.ts` |
| 编译未通过时不切换 | IP-7 | 同上 | 编译失败 | 拒绝并报告编译结论 | 同上 |
| 缺少批准时不切换 | IP-7 | 同上 | 未批准 | 拒绝且无派发 | 同上 |
| 只有一个 Session 持有 Lease | IP-7 | `tests/application/lease-handoff.test.ts` | 交接触发后第二个 Session 尝试推进 | 第二个 Session 只能观察 | `pnpm exec vitest run tests/application/lease-handoff.test.ts` |
| Lease 持有者退出后可恢复 | IP-7 | 同上 | 持有者 incarnation 退出 | 可按既有路径重取 Lease | 同上 |
| Lease 过期不释放其他所有权 | IP-7 | 同上 | Lease 失效 | Claim 与预算不变 | 同上 |
| prepare 阶段只产出提案 | IP-3 | `tests/application/planning-handoff.test.ts` | 发起 prepare | 提案落盘，责任方仍为原 Session | `pnpm exec vitest run tests/application/planning-handoff.test.ts` |
| review 阶段独立复核 | IP-3 | 同上 | 接收方进入 review | 复核地图 revision、票据、计划与候选图 | 同上 |
| cutover 才转移责任 | IP-3 | 同上 | review 通过后 cutover | 责任落盘转移，无双重责任方 | 同上 |
| 交接不触碰执行中的 Worker | IP-3 | 同上 | 交接时存在在途 Worker | Worker、Dispatch、Task 与 Lease 不变 | 同上 |
| 取消交接恢复原责任方 | IP-3 | `tests/application/planning-handoff.test.ts` | cutover 前取消 | 责任归原 Session，提案标记已取消 | `pnpm exec vitest run tests/application/planning-handoff.test.ts` |
| 过期提案不进入 cutover | IP-3 | 同上 | 提案引用 revision 变化 | 判定过期并要求重新 prepare | 同上 |
| 崩溃后按持久阶段恢复 | IP-3 | 同上 | 交接中途重启 | 按阶段得到确定责任方 | 同上 |
| awaiting_user_prompt 激活门 | IP-3 | 同上 | 未决交接且未过激活门 | 接收方不执行规划动作、不改 Route Map | 同上 |
| D17 | IP-8 | `tests/workflow/planning-tools.test.ts` | 不同模式与事实 | 工具按模式动态暴露且重验 | `pnpm exec vitest run tests/workflow/planning-tools.test.ts` |
| 术语一致性 | IP-7 | 无（文档核对） | `CONTEXT.md`、`AGENTS.md` | 文档中已无旧术语 | `! rg -n 'Coordinator Profile' CONTEXT.md AGENTS.md` |
| D20：MiniMax-M3 冒烟（Capsule 生成 + 真实 Route Planning Handoff） | IP-9 | `tests/integration/minimax-m3-planning-smoke.test.ts` | 显式选择的隔离项目与专用身份；MiniMax-M3 已配置；显式开启冒烟开关 | 真实模型生成一次 Context Capsule；prepare→review→cutover 在真实条件下完成并落盘，交接不触碰在途 Worker | `PLANNING_SMOKE=1 PLANNING_SMOKE_REPO=<isolated-project> PLANNING_SMOKE_IDENTITY=<dedicated-identity> pnpm exec vitest run tests/integration/minimax-m3-planning-smoke.test.ts --no-file-parallelism` |
| D20：跨库故障窗口仍由 fake 覆盖 | IP-9（配套既有 IP-3） | `tests/application/planning-handoff.test.ts` | fake backend 注入崩溃与丢响应 | checkpoint/admission 之间崩溃、tracker 响应丢失、交接中途重启均按持久阶段恢复 | `pnpm exec vitest run tests/application/planning-handoff.test.ts` |

全量检查：`pnpm typecheck`、`pnpm lint`、`pnpm test`、`openspec validate m1-plan-and-authorize-execution --strict`；真实冒烟文件在未设置 `PLANNING_SMOKE` 时默认跳过、不产生真实调用，只在显式选择隔离项目与专用身份后单独运行。

## 7. 文件清单与升级条件

新增文件：

- `src/domain/planning/route-map.ts`
- `src/domain/planning/ticket-claim.ts`
- `src/domain/planning/execution-graph.ts`
- `src/domain/planning/graph-compiler.ts`
- `src/domain/planning/budget-policy.ts`
- `src/domain/planning/execution-authorization.ts`
- `src/application/planning/route-map-service.ts`
- `src/application/planning/graph-generation.ts`
- `src/application/planning/graph-history.ts`
- `src/application/planning/initialize-scope.ts`
- `src/application/planning/authorization-service.ts`
- `src/application/planning/handoff-gate.ts`
- `src/application/planning/lease-handoff.ts`
- `src/application/planning/planning-handoff.ts`
- `src/adapters/tracker/gh-tracker.ts`
- `src/workflow/coordinator/planning-tools.ts`
- `tests/application/planning-mode.test.ts`
- `tests/domain/route-map.test.ts`
- `tests/domain/ticket-claim.test.ts`
- `tests/domain/graph-compiler.test.ts`
- `tests/domain/budget-policy.test.ts`
- `tests/domain/execution-authorization.test.ts`
- `tests/application/route-map-service.test.ts`
- `tests/application/graph-generation.test.ts`
- `tests/application/graph-history.test.ts`
- `tests/application/initialize-scope.test.ts`
- `tests/application/authorization-service.test.ts`
- `tests/application/handoff-gate.test.ts`
- `tests/application/lease-handoff.test.ts`
- `tests/application/planning-handoff.test.ts`
- `tests/adapters/gh-tracker.test.ts`
- `tests/workflow/planning-tools.test.ts`
- `tests/integration/minimax-m3-planning-smoke.test.ts`

修改文件：`src/application/ports/branch-coordination-store.ts`、`src/adapters/storage/schema.ts`、`src/adapters/storage/coordination-store.ts`（版本化 migration 与 graph history/authorization/handoff 适配）；`src/workflow/coordinator/graph.ts`（按模式注册规划工具节点）。边界校验沿用窄校验器，不新增 tracker SDK、schema 库或其它依赖。

受保护文件（本 change 不得修改）：`AGENTS.md`、`CONTEXT.md`、`openspec/schemas/**`、`openspec/config.yaml`、前驱 change 的全部工件、`references/orca/**`、以及 `m1-admit-work-package-specifications` 之后的全部 change 目录。

升级条件：

- 冻结接缝缺失、改名或语义改变 → 停止实施，回到 planning。
- 需要新增或改变本计划列明的 Manifest 字段、授权语义、模式集合、交接阶段集合或持久化归属 → 先回到 `design.md`。
- 需要 tracker 能力超出 `gh` 现有子命令，或需要直接访问 GitHub API/凭据 → 停止并升级。
- 需要使用本计划文件清单之外的文件 → 先说明理由并更新本计划。
- 命名命令缺失或失败、某个 Scenario 无法满足 → 停止并升级，不自行替换验证方式。
- 需要创建 `verification.md` → 只有实现任务全部完成并固定实现 HEAD 后才允许。

## 8. 验收 Agent 授权与限定审计

验收可执行范围：本 plan 第 6 节全部测试文件、第 7 节新增与修改文件、以及 `pnpm typecheck`、`pnpm lint`、`pnpm test`、`openspec validate m1-plan-and-authorize-execution --strict`。允许在范围内修复缺陷并重跑受影响检查。

受保护语义边界（发现问题时应升级而非自行改动）：模式集合与正交控制状态、Ticket Claim 的存续规则、编译器的确定性输入输出、预算上限与 `maxRecoveriesPerWorkerAttempt` 的取值与默认 1、Manifest 字段集合与批准原子性、门禁条件集合、交接三阶段与激活门、Lease 交接的同批写入、真实冒烟允许使用的项目与身份范围。

限定审计标签：`scope-mode`、`ticket-claim`、`compile-determinism`、`manifest-integrity`、`recovery-budget`、`handoff-gate`、`planning-handoff-stage`、`activation-gate`、`lease-handoff`、`real-provider-smoke`。命中任一标签的改动必须先给出证据再修改。
