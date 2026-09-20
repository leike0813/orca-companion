# Implementation Plan

## 1. 实施基线与权威来源

**Baseline mode: predecessor-contract**

- 直接前驱：`m1-plan-and-authorize-execution`
- 规划提交：`cd29e2bcd8b0278d34ae19db64cb8ebdaf149279`（本 change 起草时的仓库 HEAD）
- 权威来源：本 change 的 `specs/execution/work-package-admission/spec.md`、`specs/execution/specification-admission/spec.md`、`specs/workers/task-contracts/spec.md`、`specs/workers/harness-binding/spec.md`，`docs/architecture.md` 的 MOD-01、MOD-02、MOD-04 与 FLOW-01，以及 `docs/interface-contracts.md` 的 IC-01–IC-07。

### 合同 create/extend/consume

| 关系 | 合同与 canonical symbols | 漂移检查 |
|---|---|---|
| Create | IC-06：`SpecificationProvider`、`admitSpecification`、`SpecBinding` | 不增加 provider registry，不复制 OpenSpec artifact 图 |
| Create | IC-07：`TaskEnvelope`、Worker 报告、`SessionBinding`、`WorkerLiveness` | 必须精确绑定真实 transcript；信息不足保持 `unverifiable` |
| Extend | IC-02：worktree/Task/Worker operation variants；IC-03：Segment 与 Materialization Binding | 只追加封闭 variant 和最小记录，不复制外部事实 |
| Consume | IC-01、IC-04、IC-05、FLOW-01 | scope、operation、session 与 authorization 字段必须直接复用 owner 定义 |

若 canonical path、字段语义或 owner 发生漂移，停止实施并先更新架构合同；不得以别名类型或兼容层绕过。

### 1.1 前驱冻结接缝

| 接缝 | 前驱提供的契约 | 本 change 的使用方式 |
|---|---|---|
| tracker port | Route Map 与 Decision Ticket 定义为 tracker 权威事实，通过 port 读写 | 只读引用 Work Package 的来源 Decision Ticket；不新增 tracker 能力 |
| Route Map | 目标、已决决策、开放票、依赖、fog 与 scope 边界 | 只读引用其 revision，用于 Execution Authorization 绑定核验 |
| ExecutionGraphHistory | 前驱 `src/application/planning/graph-history.ts` 的 `loadCurrentGraph` 与 `GraphVersion` | 读取 Work Package 骨架、依赖与 Scope Envelope；本 change 不改图拓扑 |
| ExecutionAuthorizationManifest | 前驱一次性绑定的完整字段与全部有限预算上限 | 作为物化前置条件的唯一授权来源；后继不新增字段 |
| Specification Unit / Spec Binding | 本 change 自己建立的 Planner 输出与确定性接纳记录 | 作为 Implementation 的明确输入；不复用 `PlanningHandoffProposal` 或创造泛化交接记录 |

### 1.2 实施前漂移检查

开始编辑前必须依次确认，任一不成立即停止并回到规划：

1. `openspec list --json` 中不再出现 `m1-plan-and-authorize-execution`，`openspec/changes/archive/` 下存在其快照，且 `openspec/specs/` 下存在其对应 capability 主规格。
2. 实际实现中仍存在 tracker port、`loadCurrentGraph`、`ExecutionAuthorizationManifest` 及其完整预算字段；名称或语义漂移即停止。
3. 实际文件与符号匹配第 2 节列出的复用点；`src/domain/`、`src/application/`、`src/adapters/` 下缺少或改名即停止。
4. `cd29e2bcd8b0278d34ae19db64cb8ebdaf149279` 仍在当前分支历史中；实施 HEAD 与该提交之间的差异不涉及接缝文件。

## 2. 复用与接缝

| IP-ID | 现有或前驱文件与符号 | 复用方式 | 禁止复制的事实 |
|---|---|---|---|
| IP-A1 | `src/domain/` 领域类型与前驱的图/授权类型 | 复用 WorkPackageId、Scope Envelope、预算上限类型，只新增判定函数 | 不复制 Authorization Manifest 字段定义，不复制预算状态机 |
| IP-A2 | `OperationOutcome` 三值类型、Operation Intent 记录、`ExecutionBackend` 端口 | 复用既有 intent 持久化与对账路径 | 不在用例内另建 OperationId 生成或重试策略 |
| IP-A3 | M0 的窄校验器约定与既有失败信封 | 在本 change 定义 Worker 报告的边界校验入口 | 不引入第二套 schema 库或复制失败信封结构 |
| IP-A4 | 无前驱 port；本 change 定义 `src/application/ports/specification-provider.ts` | 只在 M1 实现 OpenSpec adapter | 不定义 provider 注册框架，不复制 OpenSpec CLI 的 artifact 图语义 |
| IP-A5 | `src/adapters/agents/` 的 harness 绑定入口 | 扩展为 Codex Session Binding 与 liveness 判定 | 不按 cwd/mtime 推断 session，不用终端输出冒充 transcript |
| IP-A6 | `src/adapters/orca-cli/` 的 `ExecutionBackend` 实现与能力探测 | 新增 `task-create` 与 `worker-start --task` 两个 mutation | 不复制 Orca 状态机，不写 Orca DB |

## 3. 代码变更映射

| IP-ID | Task | Requirement/Scenario | 文件与符号 | 精确变化 | 不得改变 |
|---|---|---|---|---|---|
| IP-A1 | T1 | `Work Package 的 worktree 只在进入调度时建立` / 两个 Scenario；`Dispatch Candidate 物化恰好一个角色级 Orca Task` / 第一个与第三个 Scenario | `src/domain/dispatch-candidate.ts` 新增 `evaluateDispatchCandidate`、`DispatchCandidateDecision` | 纯函数判定生命周期、图、Authorization、预算与控制状态，返回可物化或拒绝原因 | 不读取 Git/Orca/文件系统，不写存储 |
| IP-A2 | T2、T3 | `Dispatch Candidate 物化恰好一个角色级 Orca Task` / 全部三个 Scenario | `src/application/materialize-work-package.ts` 新增用例；扩展 `src/application/ports/execution-backend.ts` 的封闭联合 | 固定执行顺序：读取事实 → 判定 → 复用或建立 worktree → 物化 Task；先写 Operation Intent 再调用，unknown 以原 OperationId 对账 | 不新增聚合 `ports.ts`，不新增本地 worktree 路径表，不做换 ID 重试 |
| IP-A3 | T4 | `Task Envelope 固定 scope、authority、预算与期望证据` / 两个 Scenario；`Worker 以结构化报告与有界证据回报，且报告只算候选结果` / 全部五个 Scenario | `src/domain/task-contract.ts`、`src/domain/worker-report.ts`、`src/application/worker-report-dto.ts` | 定义 Task Envelope 与四种报告的领域类型与判别联合；边界处丢弃模型填写的 scope/身份字段；提供证据失效判定函数 | 不落 Accepted Worker Result 存储，不做报告到生命周期的推进 |
| IP-A4 | T5 | `Specification Planner 在 Work Package 的 worktree 内编写工具原生 Specification Unit` / 两个 Scenario；`确定性 Specification Admission 与 Spec Binding` / 两个 Scenario；`可选 Specification Validator 作为独立质量门` / 两个 Scenario | `src/application/specification-admission.ts`、`src/application/ports/specification-provider.ts`、`src/adapters/specification/openspec/provider.ts` | 定义 provider 端口；实现结构、版本、Scope Envelope、authority、预算检查；记录内容摘要绑定的 Spec Binding；失败保留现场 | 不把接纳结论当作语义完备，不自动清理 worktree |
| IP-A5 | T6 | `Dispatch 与真实 harness session 精确绑定` / 三个 Scenario；`Worker 存活与终态必须可核验` / 三个 Scenario；`会话中断只形成 Session Segment 前置事实` / 两个 Scenario | `src/adapters/agents/session-binding.ts`、`src/domain/worker-liveness.ts`；修改 BranchCoordinationStore port/schema/adapter | 为四角色构造含 transcript 引用的 Session Binding；实现三值 liveness；以 migration 持久化中断 Segment 前置事实 | 不猜测 session，不因信息缺失判退出，不恢复 session、不生成 Capsule、不记录 Recovery Budget |
| IP-A6 | T7 | `Dispatch Candidate 物化恰好一个角色级 Orca Task` / 第二个 Scenario | 修改 M0 `src/adapters/orca-cli/operation-catalog.ts`、`orca-backend.ts` 与 `src/application/ports/execution-backend.ts` | 新增 worktree 建立操作；复用已登记的 `task-create`、`worker-start --task`；透传拒绝码与 receipt | 不新建 `backend.ts`，不使用 `worker-start --spec`，不伪造 terminal 身份 |

## 4. 调用与副作用顺序

物化一次 Dispatch Candidate 的顺序固定为：

1. 读取当前事实（Work Package 图位置、Authorization 引用、预算、控制状态）；
2. IP-A1 判定；拒绝则记录原因并结束，不产生任何副作用；
3. 查询该 Work Package 的既有 worktree；存在且通过核验则复用，否则建立并核验；
4. 持久化 Operation Intent（含稳定 OperationId 与 expected revision）；
5. 调用 `task-create`；
6. 调用 `worker-start --task <taskId>`，跳过步骤 5 的产物无法表达依赖时的分支不由本 change 处理；
7. 核验 receipt 并回读 Work Package 绑定；
8. 完成 Operation Intent；任一步返回 unknown 时，以原 OperationId 对账，仍不确定则阻塞该 mutation lane。

失败处理：步骤 3 失败不留下半个 Task；步骤 5 或 6 返回 rejected 且能证明未产生副作用时清理为「未物化」；返回 unknown 时保留现场并阻塞。所有步骤不得重试换 ID。

## 5. Schema、状态与持久化落实

- 本 change 不新增数据库；通过前驱的版本化 migration 增加 `session_segments` 与最小 `materialization_bindings` 记录。Segment 只记录角色、Task、Dispatch、Attempt、Session Binding、transcript 引用、中断边界与终态事实，不记录 Recovery Budget 计数。
- Execution Graph 的图体只通过 `ExecutionGraphHistory` 读取；Materialization Binding 只保存 `WorkPackageId → OrcaTaskId` 与创建 OperationId，不保存 worktree 路径或复制 Orca Task 状态。
- 所有边界 DTO（Task Envelope 载荷、Worker 报告载荷、provider 读取结果）在进入领域层前做运行时 schema 校验；校验失败按拒绝处理并保留原始载荷用于诊断，敏感值不入日志。
- migration 可重入并保留前驱数据；无权限变更。

## 6. 验收证据矩阵

| Requirement/Scenario | IP-ID | 测试文件 | Fixture/前置条件 | 关键断言 | 可运行命令 |
|---|---|---|---|---|---|
| 选中候选时建立 worktree | IP-A1/A2 | `tests/domain/dispatch-candidate.test.ts` | fake backend，Frontier 中的候选 | 判定为可物化，且建立动作发生在物化之前 | `pnpm vitest run tests/domain/dispatch-candidate.test.ts` |
| 未进入 Frontier 的 Work Package 不产生 worktree | IP-A1 | `tests/domain/dispatch-candidate.test.ts` | 依赖未通过的 Work Package | 判定为拒绝，且无 worktree 查询之外的调用 | `pnpm vitest run tests/domain/dispatch-candidate.test.ts` |
| 前置条件不满足时拒绝物化 | IP-A1 | `tests/domain/dispatch-candidate.test.ts` | 授权失效、预算耗尽两种 fixture | 返回对应拒绝原因，零副作用 | `pnpm vitest run tests/domain/dispatch-candidate.test.ts` |
| 物化结果未知时先对账 | IP-A2 | `tests/application/materialize-work-package.test.ts` | backend 返回 unknown | 不发生第二次 Task 创建，且对账使用同一 OperationId | `pnpm vitest run tests/application/materialize-work-package.test.ts` |
| 图未授权时不物化任何 Task | IP-A1/A2 | `tests/application/materialize-work-package.test.ts` | 无有效 Authorization 的 generation | backend 未收到任何 mutation | `pnpm vitest run tests/application/materialize-work-package.test.ts` |
| Task Envelope 固定 scope 与 authority | IP-A3 | `tests/application/worker-report-dto.test.ts` | 合法与越界两种载荷 | 合法载荷通过校验；模型填写的 scope/身份字段被丢弃 | `pnpm vitest run tests/application/worker-report-dto.test.ts` |
| Worker 报告只是候选结果 | IP-A3 | `tests/application/worker-report-dto.test.ts` | 四类报告的样例载荷 | 报告被归一为候选结果，不产生生命周期推进 | `pnpm vitest run tests/application/worker-report-dto.test.ts` |
| Worker Question 只暂停依赖它的工作 | IP-A3 | `tests/application/worker-report-dto.test.ts` | 同时存在独立 Work Package | 报告只影响依赖该回答的工作 | `pnpm vitest run tests/application/worker-report-dto.test.ts` |
| 证据范围与失效 | IP-A3 | `tests/application/worker-report-dto.test.ts` | 两条记录，其一覆盖被改动路径 | 覆盖被改动路径的记录被判定失效 | `pnpm vitest run tests/application/worker-report-dto.test.ts` |
| Specification Planner 在 worktree 内产出原生规格 | IP-A4 | `tests/application/specification-admission.test.ts` | 临时 worktree 含 OpenSpec change | 接纳成功并给出声明；worktree 外规格被拒绝 | `pnpm vitest run tests/application/specification-admission.test.ts` |
| 确定性接纳与 Spec Binding | IP-A4 | `tests/application/specification-admission.test.ts` | 内容变化与仅改勾选两种 fixture | 两者都产生新绑定摘要；越界范围被拒绝 | `pnpm vitest run tests/application/specification-admission.test.ts` |
| 可选 Specification Validator | IP-A4 | `tests/application/specification-admission.test.ts` | 开关开启与关闭 | 开启时派出独立 Worker；关闭时零额外派发 | `pnpm vitest run tests/application/specification-admission.test.ts` |
| Session 精确绑定与不可用阻塞 | IP-A5 | `tests/adapters/agents/session-binding.test.ts` | 四个主要角色各一条有效事实，另有缺身份/缺 transcript 事实 | 四个角色均记录角色、session 与 transcript 引用；缺任一事实时不可用且阻塞 | `pnpm vitest run tests/adapters/agents/session-binding.test.ts` |
| 三值 liveness 与可核验终态 | IP-A5 | `tests/domain/worker-liveness.test.ts` | 主机未列举、明确退出、存活、终态身份不匹配四种事实 | 分别为 unverifiable、exited、live；终态不匹配不结算；unverifiable 不触发派发 | `pnpm vitest run tests/domain/worker-liveness.test.ts` |
| 会话中断只记录 Segment 前置事实 | IP-A5 | `tests/domain/worker-liveness.test.ts` | session 丢失与 transcript 不可引用 | 记录 Segment 边界和可核验事实后形成 blocker；未生成 Capsule、未创建替代 segment、未记录 Recovery Budget | `pnpm vitest run tests/domain/worker-liveness.test.ts` |
| Orca mutation 拒绝码透传 | IP-A6 | `tests/adapters/orca-cli/orca-backend.test.ts` | fake CLI 返回 `task_not_startable` | 拒绝码与 nextSteps 透传，且不使用 `--spec` | `pnpm exec vitest run tests/adapters/orca-cli/orca-backend.test.ts` |

全量检查：`pnpm typecheck && pnpm lint && pnpm test`。

## 7. 文件清单与升级条件

新增文件：

- `src/domain/dispatch-candidate.ts`
- `src/domain/task-contract.ts`
- `src/domain/worker-report.ts`
- `src/domain/worker-liveness.ts`
- `src/application/materialize-work-package.ts`
- `src/application/specification-admission.ts`
- `src/application/worker-report-dto.ts`
- `src/application/ports/specification-provider.ts`
- `src/adapters/specification/openspec/provider.ts`
- `src/adapters/agents/session-binding.ts`
- `tests/domain/dispatch-candidate.test.ts`
- `tests/domain/worker-liveness.test.ts`
- `tests/application/materialize-work-package.test.ts`
- `tests/application/specification-admission.test.ts`
- `tests/application/worker-report-dto.test.ts`
- `tests/adapters/agents/session-binding.test.ts`
- `tests/adapters/orca-cli/orca-backend.test.ts`

修改文件：

- `src/application/ports/execution-backend.ts`（扩展封闭联合）、`src/application/ports/branch-coordination-store.ts`
- `src/adapters/orca-cli/operation-catalog.ts`、`src/adapters/orca-cli/orca-backend.ts`（新增 worktree 建立并复用既有 Task mutations）
- `src/adapters/storage/schema.ts`、`src/adapters/storage/coordination-store.ts`（Session Segment 与 Materialization Binding migration）

受保护、不得修改：`openspec/schemas/**`、`openspec/config.yaml`、`AGENTS.md`、`CONTEXT.md`、`package.json` 的依赖段、`references/orca`。

升级条件（必须停下并询问）：

- 前驱接缝任一字段或 requirement 名称漂移；
- 需要新增依赖、本计划未声明的持久化记录、未登记的 Orca 调用形态或绕过能力探测；
- 需要以 `worker-start --spec` 单步路径物化；
- 需要精确定义的公开字段（Task Envelope 或报告的公开 schema）发生变化；
- 需要恢复 Worker Session、生成 Capsule、创建替代 Segment 或记录/消耗 Recovery Budget；
- 任一 Requirement/Scenario 无法在允许文件范围内满足。

## 8. 验收 Agent 授权与限定审计

验收范围限定为本 change 列出的新增与修改文件、上述测试文件，以及 `openspec/changes/m1-admit-work-package-specifications/` 下的规划产物。验收可执行 `pnpm typecheck`、`pnpm lint`、`pnpm test` 与矩阵中的单文件命令。

受保护的语义边界（验收不得单方面修改）：物化前置条件集合、Spec Binding 的摘要语义、Worker 身份与 scope 字段的来源、四个主要角色的精确 Session Binding、liveness 三值与终态核验、Change 5 只记录 Segment 前置事实而不实现任何 Recovery 行为。

需要限定审计的标签：`oracle-source-of-truth`（Worker 载荷字段是否被正确丢弃）、`transaction-boundary`（Operation Intent 与 mutation 的顺序）、`permission-escalation`（越界派发是否被拒绝）。
