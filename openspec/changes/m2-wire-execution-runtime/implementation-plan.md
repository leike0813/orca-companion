# Implementation Plan

## 1. 实施基线与权威来源

- **基线模式**：`predecessor-contract`；规划 HEAD `bfb40e9cb29b9a9a9d8d892a8b00f26aa50c1a10`。直接前驱为已归档的 `m2-deliver-planning-tui`；其 `tui/planning-workspace`、`tui/session-interactions` 主规格及 IC-11/12 的 Session/intent 通道必须存在。并行活跃的 `m2-deliver-execution-tui` 保留 5.2/5.3，交付的执行投影是本 change 的消费接缝，但不能被误写为已归档前驱。
- **实施前漂移检查**：执行 `git status --short`、`openspec list --json`、`openspec validate m2-deliver-execution-tui --strict`；读取当前 M2 的 `tasks.md`、`src/application/execution/execution-view.ts`、`src/bootstrap/foreground-planning-runtime.ts` 与 IC-11/12。确认已完成的 11 项 UI 行为与 `ControllerSnapshot.execution`、`FinalizerObservationFacts`、`TuiPorts` 形状仍成立。共享文件只由一个 agent 依次修改；若另一 agent 正在改同一文件，等待其交付并重新核对，不覆盖未提交内容。
- **冻结接缝**：IC-03 `BranchCoordinationStore`/revision/lease/intent，IC-05 图历史/授权/切换，IC-07 Worker Session Binding，IC-08 `settleDelivery`/`runValidation`/`finalizeProject`，IC-09 Recovery/Scope control，IC-11/12 快照与 TUI intents。Git/Orca/Worker Harness 的事实归属按 `docs/architecture.md`；改变任何公共字段或运行语义时先修订 `docs/interface-contracts.md`，再改生产代码。
- **权威输入**：tracker 提供 Route Map/票据/正式计划；IC-03 提供共享协调、预算、lease、intent 与引用；Orca 提供 Run/Task/Dispatch/Worker/Delivery/Accepted Result；Git 提供 HEAD/index/dirty/worktree；Worker Harness 提供精确 Session/transcript；LangGraph checkpoint 提供 Coordinator Session。模型不签发 scope、Run 或 operation identity。
- **并行 change 顺序**：本 change 的 apply 与验证先于 M2 的 5.2/5.3；本 change archive 后，M2 再运行真实 PTY 并独立给出 verification。`openspec/config.yaml` 的具名例外只用于这两项，不放宽其他前驱门禁。

## 2. 复用与接缝

| IP-ID | 现有或前驱文件与符号 | 复用方式 | 禁止复制的事实 |
| --- | --- | --- | --- |
| IP-01 | `planning/{graph-generation,graph-history,authorization-service,handoff-gate,lease-handoff}.ts`、`ExecutionBackend.run-create` | 组装当前事实，以现有 Orca mutation 实现 `EmptyRunAllocator`，经用户完整 Manifest 批准后切换 | 不从界面或模型猜图 revision、Run 与批准 |
| IP-02 | `src/bootstrap/startup.ts`、`reconcileOperations`、`replayDeliveries`、`startCoordinatorRuntime` | 同一 Runtime Incarnation 恢复并接 Resume 对账 | 不重复取得租约、不建立第二条 Delivery 流水线 |
| IP-03 | `guardDispatchCandidate`、`materializeWorkPackage`、`specification-admission.ts`、`createCodexWorkerLaunch` | 单步执行驱动选择当前角色与候选 | 不复制 Execution Graph 状态或预建 Task |
| IP-04 | `readDeliveryBatch`、`settleDelivery`、`runValidation`、`recoverWorkerSession` | 当前 Run 的身份装配、结算、修复与恢复 | 不把 terminal 输出当 provider transcript，不提前 ack |
| IP-05 | `integrateWorkPackage`、`src/adapters/git/baseline-observer.ts`、`runProcess` | 修正分目标核验并实现受控 Git 端口 | 不从 TUI 发 Git 命令，不重写历史 |
| IP-06 | `planFinalizerDispatch`、`finalizeProject`、`createCodexWorkerLaunch`、`deriveExecutionFacts` | 新只读 Session、工作区前后观察与 verdict | 不用单包通过或 Worker 完成代替交付结论 |
| IP-07 | `createScopeControlService`、`worker-list`/`worker-stop`、`ControllerService` | 原 intent 对账、stop verdict 和提交后事件 | 不把 unverifiable 读成 stopped |
| IP-08 | 现有 fake 测试与 `tests/tui/pty-execution.test.ts` | 新 change 独立验证闭环；M2 保留 PTY 验收 | 不在普通测试使用用户项目或隐式启动真实 Worker |

## 3. 代码变更映射

| IP-ID | Task | Requirement/Scenario | 文件与符号 | 精确变化 | 不得改变 |
| --- | --- | --- | --- | --- | --- |
| IP-01 | 1.1 | 授权切换由当前规划事实驱动：批准后进入执行、规划引用过期 | 修改 `src/bootstrap/foreground-planning-runtime.ts`、`src/application/controller-service.ts`、`src/interfaces/tui/ports.ts`、`src/interfaces/tui/app.tsx`、`src/interfaces/tui/state.ts`、`src/interfaces/tui/components/interaction-card.tsx`；新增 `tests/bootstrap/execution-authorization.test.ts` | 复用 `ExecutionBackend.run-create` 装配 `EmptyRunAllocator`，经现有 IC-05 用例组装 candidate/Manifest、审阅完整 Manifest、显式批准并原子切换；新增有界 Controller/TUI intent，宿主补可信身份 | 不改 `recordApproval` 的原子批准语义；未批准不执行 |
| IP-02 | 1.2 | 重启与 Scope 控制先对账：活跃 Worker 后重启、Resume 对账仍不确定 | 修改 `src/bootstrap/{startup,foreground-planning-runtime}.ts`；新增 `src/bootstrap/execution-runtime.ts`、`tests/bootstrap/foreground-execution-runtime.test.ts`；调整 `tests/bootstrap/startup-reconciliation.test.ts` | 复用一次 Runtime Lease 的启动顺序，装配当前 Run 的 pending Delivery、Recovery、Worker 事实，Resume 接入同一对账；启动前 blocker 投影 | 不使观察者 Session 消费事件；不从 UI 生命周期启动动作 |
| IP-03 | 2.1 | 前台进程串行推进角色工作：首个候选、后继角色、派发未知 | 新增 `src/application/execution/advance-execution.ts`、`src/workflow/coordinator/execution-tools.ts`、`tests/application/advance-execution.test.ts`；修改 `src/bootstrap/{execution-runtime,foreground-planning-runtime}.ts` | 单步选择当前 Work Package/角色，签发稳定分步骤 ID，调用已有物化/规格接纳，按模式暴露只读及受控执行工具 | 不定义第二份生命周期状态机；不预建整图 |
| IP-04 | 2.2 | Delivery 与 Worker Session Recovery：Validator 修复、旧代际、Session 无法恢复 | 新增 `src/adapters/agents/validator-runner.ts`、`tests/bootstrap/execution-delivery.test.ts`；修改 `src/bootstrap/execution-runtime.ts`、`src/adapters/agents/codex-launch.ts` | 当前 Run 的 Delivery → 可信 Task/Attempt/Binding → 现有结算；Validator 的同 Session verify/repair/verify；按原 Segment 接 Recovery，Capsule coverage 从权威结果读取 | 不在本地存 Accepted Result 正文；不把旧事件注入当前 Wake |
| IP-05 | 3.1 | 集成后才产生项目级终态：集成结果不确定 | 新增 `src/adapters/git/integration.ts`、`tests/adapters/git-integration.test.ts`；修改 `src/application/integrate-work-package.ts`、`src/adapters/git/baseline-observer.ts`、`tests/application/integrate-work-package.test.ts`、`docs/interface-contracts.md` | IC-08 的 commit/source、integrate/canonical、push/remote 分目标读回；参数数组执行普通 Git 步骤与原 ID 对账 | 不引入 force/reset/通用 shell；不在失败时自动推下一个包 |
| IP-06 | 3.2 | 集成后才产生项目级终态：集成成功、只读或工作区无法核验 | 修改 `src/bootstrap/execution-runtime.ts`、`src/adapters/agents/codex-launch.ts`、`src/application/execution/execution-view.ts`、`tests/application/finalize-project.test.ts`；新增 `tests/bootstrap/execution-finalizer.test.ts` | 全部集成后冻结、只读新 Session、canonical 工作区前后证据；调用现有 `finalizeProject` 并投影真实 Observation | 不在 Gate 未满足时显示 deliverable；不把 Codex 状态写入 canonical 工作区 |
| IP-07 | 4.1 | 重启与 Scope 控制先对账：Cancel 停止结果不确定；执行事实可观察 | 新增 `src/adapters/orca-cli/worker-stop.ts`、`tests/adapters/worker-stop.test.ts`；修改 `src/bootstrap/{execution-runtime,foreground-planning-runtime}.ts`、`src/application/controller-service.ts`、`README.md`、`docs/{architecture,interface-contracts,orca-compatibility}.md` | exact Dispatch stop verdict、原 intent 对账；已提交角色/集成/终态事件；删除已接线的占位拒绝，更新事实说明 | 不扩张 TUI 控制粒度；不把诊断噪声发布成语义事件 |
| IP-08 | 4.2 | 本 change 全部 Scenario；M2 5.2/5.3 的可运行前提 | 新增 `tests/integration/foreground-execution-runtime.test.ts`；调整 `tests/tui/pty-execution.test.ts` 中仅与生产接线相适配的 fixture/启动条件；修改 `docs/orca-compatibility.md` | fake 故障窗口 + 显式隔离项目真实 MiniMax-M3 闭环；固定证据后由 M2 独立运行 PTY 验收 | 不把 default skipped 当作真实通过；不碰主项目/全局 Orca runtime |

## 4. 调用与副作用顺序

1. **规划切换**：读 tracker/map/plan 与 Scope → 编译并记录候选图和空 Run → 展示完整 Manifest → 用户显式批准 → 重读 map/plan/graph revision → `recordApproval` → `transitionToExecution` 同事务取得 Execution Lease。拒绝或漂移则不派发。
2. **前台启动**：核验 Scope/Session 与 Runtime Lease → `reconcileOperations`（原 ID）→ `readDeliveryBatch` 但不 ack → `replayDeliveries`/现有 settlement → 续办 Recovery → 查询 Worker liveness、Git baseline 与 lane → readiness。任何步骤不可读，阻塞相关 lane 或整个派发门；不得以空列表代表不可达。
3. **单步推进**：重读 Scope/graph/authorization/lease/control/budget/lane → 按拓扑及角色接受结果选一个候选 → 计算稳定 Task/Attempt/步骤 ID → `guardDispatchCandidate` → `materializeWorkPackage`。外部 mutation 前有 intent，确定结果回读后才推进；unknown 保留原 ID 和 lane。
4. **角色与 Delivery**：Worker 使用 Task Envelope 和精确 Session Binding；Delivery read → 当前 Run/generation/Task/Dispatch/Attempt/role/revision 核验 → 去重 → Orca Accepted Result + 回读 → IC-03 引用 + 回读 → ack。Planner 结果走 Specification Admission，Implementation 结果只进入验证门；Validator 可在同 Session 修复复验。迟到结果只补历史。
5. **集成与 Finalizer**：Validator accepted → 精确 source worktree commit → canonical integrate → 唯一获批 remote/ref 非强制 push；每步核验各自目标与 expected HEAD/commit，unknown 停止。全部包集成后冻结，采集 canonical 前状态 → 派出新只读 Finalizer → 采集后状态并比较 → `finalizeProject` 接受 verdict → 快照与提交后事件。
6. **控制**：Pause 阻止新的模型恢复和派发；Resume 先运行第 2 步的对账再开放；Cancel 先落盘 `cancelling` 再按 exact Dispatch 请求 stop，unknown 保持未决；Exit 只关闭前台资源。重启从权威事实重建，不使用内存游标代替记录。

## 5. Schema、状态与持久化落实

- **数据库**：计划不新增 IC-03 表或第二 SQLite store。现有 GraphHistory、Authorization、Operation Intent、DeliverySettlement、Recovery、Verdict 只存自身事实/引用。Finalizer 前状态在 Orca Task Envelope，Capsule 正文留在 Orca/精确 transcript；若实测不能可靠回读，先回设计修订公共合同，不私增缓存。
- **身份/幂等**：OperationId 由可信执行驱动按 Scope/generation/Work Package/role/contract revision/Attempt/步骤稳定构造；已有 lane 的原 ID 优先。不同副作用不共用 ID。写入用 expected revision 与 writer fencing；CAS 冲突重读事实重新决策。不能从 `Date.now()` 或 UI render 生成派发身份。
- **权限**：Manifest 限定 Worker Profile、Git policy、预算与 workspace；Execution Lease 限定唯一推进者。Finalizer 要求真实只读 Profile。Git 端口只允许 commit/integrate/push，必须明确源、目标、remote/ref；不通过 shell 拼接命令。
- **错误/观察**：`accepted` 只代表确定记录；`rejected` 需证明无副作用；`unknown` 以原 intent 对账，不能换 ID 重试。`live`/`exited`/`unverifiable` 保持三值。只有已提交并回读的语义变化发事件；重启靠快照恢复显示。`status --json` 与现有 IC-12 schemaVersion 2 兼容。
- **版本/迁移**：无预设 schema migration 或依赖变更。IC-08 分目标 Git 合同和 IC-11 有界授权 intent 是明确的合同扩展，先更新文档与相关行为测试。若本 change 需要新增持久字段，则先更新本设计、接口合同与 migration 计划。

## 6. 验收证据矩阵

| Requirement/Scenario | IP-ID | 测试文件 | Fixture/前置条件 | 关键断言 | 可运行命令 |
| --- | --- | --- | --- | --- | --- |
| 授权切换：批准后进入执行、规划引用过期 | IP-01 | `tests/bootstrap/execution-authorization.test.ts` | 当前与 stale map/graph，完整 Manifest | 只在精确批准后原子切换；旧批准零派发 | `pnpm exec vitest run tests/bootstrap/execution-authorization.test.ts` |
| 串行推进：首个候选、后继角色、派发未知 | IP-03 | `tests/application/advance-execution.test.ts` | 两个 ready 包、角色结果、unknown receipt | 一个 active、一次一个角色 Task、原 ID 阻塞不重发 | `pnpm exec vitest run tests/application/advance-execution.test.ts` |
| Delivery/Recovery：Validator 修复、旧代际、Session 无法恢复 | IP-04 | `tests/bootstrap/execution-delivery.test.ts`、`tests/application/run-validation.test.ts` | fake Orca 当前/旧 Delivery、精确/缺失 transcript | ack 顺序、同 Session 修复、旧结果历史化、缺 transcript 阻塞 | `pnpm exec vitest run tests/bootstrap/execution-delivery.test.ts tests/application/run-validation.test.ts` |
| 重启与 Resume：活跃 Worker、未决操作 | IP-02 | `tests/bootstrap/foreground-execution-runtime.test.ts`、`tests/bootstrap/startup-reconciliation.test.ts` | 持久 intent 与同 Dispatch，进程重建 | 对账先于派发，原身份不重复，unknown 阻止 Resume | `pnpm exec vitest run tests/bootstrap/foreground-execution-runtime.test.ts tests/bootstrap/startup-reconciliation.test.ts` |
| Cancel：stop verdict 不确定 | IP-07 | `tests/adapters/worker-stop.test.ts`、`tests/coordination/scope-control.test.ts` | accepted/unknown/transport failure | 先落 cancelling、未知不报 stopped、重启原 ID | `pnpm exec vitest run tests/adapters/worker-stop.test.ts tests/coordination/scope-control.test.ts` |
| 集成：结果不确定 | IP-05 | `tests/application/integrate-work-package.test.ts`、`tests/adapters/git-integration.test.ts` | source/canonical/remote 三目标，超时与冲突 | 每步核验正确目标、原 intent 阻塞、不继续 Finalizer | `pnpm exec vitest run tests/application/integrate-work-package.test.ts tests/adapters/git-integration.test.ts` |
| Finalizer：集成成功、只读/工作区无法核验 | IP-06 | `tests/bootstrap/execution-finalizer.test.ts`、`tests/application/finalize-project.test.ts` | 新只读 Session、前后 Git 状态 | accepted verdict 才 deliverable；变化/不可强制只读为 blocker | `pnpm exec vitest run tests/bootstrap/execution-finalizer.test.ts tests/application/finalize-project.test.ts` |
| 真实闭环与 M2 PTY 前提 | IP-08 | `tests/integration/foreground-execution-runtime.test.ts`；M2 的 `tests/tui/pty-execution.test.ts` | 显式一次性 Git 项目、专用 Orca 身份、MiniMax-M3 | 授权→串行角色→修复→集成→Finalizer→重启不重派；Recovery 或 blocker | `ORCA_COMPANION_E2E_REPO=<isolated-path> ORCA_COMPANION_E2E_IDENTITY=<dedicated-id> pnpm exec vitest run tests/integration/foreground-execution-runtime.test.ts` |
| 全量门禁 | IP-01–08 | 全部 | 不含真实 Worker 的默认检查 | 类型/lint/test/build/OpenSpec strict valid | `pnpm typecheck && pnpm lint && pnpm test && pnpm build && openspec validate m2-wire-execution-runtime --strict` |

## 7. 文件清单与升级条件

**新增**：`src/application/execution/advance-execution.ts`、`src/workflow/coordinator/execution-tools.ts`、`src/bootstrap/execution-runtime.ts`、`src/adapters/agents/validator-runner.ts`、`src/adapters/git/integration.ts`、`src/adapters/orca-cli/worker-stop.ts`，以及第 6 节列出的七个 fake/adapter 测试和一个显式真实集成测试。

**修改**：`src/bootstrap/{foreground-planning-runtime,startup}.ts`、`src/application/{controller-service,integrate-work-package}.ts`、`src/application/execution/execution-view.ts`、`src/adapters/agents/codex-launch.ts`、`src/adapters/git/baseline-observer.ts`、`src/interfaces/tui/ports.ts`、`src/interfaces/tui/app.tsx`、`src/interfaces/tui/state.ts`、`src/interfaces/tui/components/interaction-card.tsx`、相关既有测试、`README.md`、`docs/{architecture,interface-contracts,orca-compatibility}.md`。`tests/tui/pty-execution.test.ts` 仅可调整与接线相关的 fixture，任务归属与通过判定仍在 M2。`openspec/config.yaml` 的具名实施例外已在规划阶段更新。

**保护**：其它 change 的任务勾选状态与 verification、`openspec/specs/`、`CONTEXT.md`、`references/orca`、用户主项目与既有未提交改动。实施中需要额外字段/迁移、改变单并发、放宽只读/权限，或当前 Orca/Codex 能力无法支撑时，先把证据和受影响合同带回规划。

## 8. 验收 Agent 授权与限定审计

验收可检查第 3 节的实现、测试与文档，并仅在显式隔离项目及专用身份中运行真实 Worker。定向审计 `single-execution-owner`、`stable-operation-id`、`delivery-ack-order`、`validator-session-binding`、`git-target-readback`、`finalizer-read-only`、`resume-before-dispatch` 与 `cancel-stop-verdict`。`verification.md` 只在实现任务全部完成、固定实现 HEAD 后由验收环节创建；本规划阶段不创建。
