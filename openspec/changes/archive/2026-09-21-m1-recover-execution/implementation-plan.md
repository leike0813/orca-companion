# Implementation Plan

## 1. 实施基线与权威来源

- **Baseline mode**: `predecessor-contract`
- **直接前驱**: `m1-execute-and-validate-work-packages`
- **规划提交**: `cd29e2b`
- **前驱实施基线**: `ed16e3d`（`m1-execute-and-validate-work-packages` 的已归档交付提交）
- **权威来源**: 本 change 的 `proposal.md`、四份 capability spec 与 `design.md`（D1–D12）；`docs/architecture.md` 的 FLOW-02–FLOW-04；`docs/interface-contracts.md` 的 IC-02–IC-04、IC-07–IC-09、IC-11；根目录 `AGENTS.md` 第 4、5、6、7、8、9、11 节；`CONTEXT.md` 的 Coordinator Session Recovery、Session Segment、Session Binding、Recovery Capsule、Recovery Budget、Worker Attempt、Attempt、Evidence Record、Delivery、Wake Batch、Operation Outcome、Execution Coordination Lease、Pending Interaction 等条目；`docs/research/coordinator-state-recovery.md`、`orca-public-control-contracts.md`、`m0-isolated-control-loop-probe.md`、`agent-loop-termination-and-stall-detection.md`。

### 合同 create/extend/consume

| 关系 | 合同与 canonical symbols | 漂移检查 |
|---|---|---|
| Create | IC-09：Worker Session Recovery、`salvageTranscript`、`RecoveryCapsule`、`ExecutionHandoffState`；FLOW-04 | salvage 仅提取 Worker transcript；不得用于 Coordinator Session 或命名整个恢复生命周期 |
| Create | IC-11：`ControllerService`、`ControllerSnapshot`、command/event unions | façade 只委派用例，不直连 store/backend 或拥有状态转换 |
| Extend | IC-02：OperationId 对账 query；IC-03：recovery/lane/control/handoff records | 只追加查询 variant 与最小共享事实，不复制 Orca/Git 正文 |
| Consume | IC-04、IC-07、IC-08、FLOW-02、FLOW-03 | 不包装 Wake，不复制 Delivery pipeline，不混同两类 Capsule 与两类 handoff |

若 salvage 边界、Capsule 类型、handoff 类型、Wake owner 或 Delivery owner 漂移，停止实施并先更新架构合同。
- **冻结接缝（前驱提供，本 change 不得修改其判定）**:
  1. **Attempt/Retry**：`Attempt` 身份、Retry Attempt 与 Dispatch 的对应关系；Retry 在同一 WorkerTask 上新建 Dispatch/Attempt。
  2. **Evidence invalidation**：Evidence Record 的作用域与失效判定。
  3. **Git integration**：Integration Operation 的 expected HEAD、OperationIntent 与 canonical branch 集成路径。
  4. **Delivery Verdict**：Finalizer 只读结论与 deterministic controller 的接受路径。
  5. **Delivery pipeline**：前驱 `processDelivery` 的读取、核验、Orca 接受/回读、本地引用持久化与最终 ack 顺序。
- **实施前核对门（任一不成立即回到规划）**:
  - `m1-execute-and-validate-work-packages` 已 archive，其主规格存在；
  - 前驱实际提供的 `OperationOutcome`、`BranchCoordinationStore`、`ExecutionBackend.query`、Worker 生命周期与 Session 注册符号与第 2 节声明一致；
  - 前驱存在 `src/application/delivery/process-delivery.ts`，且已实现正常 Delivery pipeline 与去重引用；本 change 只增加启动重放、unknown lane 阻塞和冻结代际处理；
  - 前驱尚未定义 Worker Session Recovery、RecoveryId 与 Recovery Capsule 符号（若已定义，则本 change 只补角色门与预算来源）；
  - 上述五处冻结接缝的符号与语义未漂移。

## 2. 复用与接缝

| IP-ID | 现有或前驱文件与符号 | 复用方式 | 禁止复制的事实 |
|---|---|---|---|
| IP-1 | 前驱 `src/application/dto/operation-outcome.ts` 的 `OperationOutcome`；`src/application/` 的用例与 port 约定 | 直接使用三值结果类型；新增 `reconcileOperations` 用例 | 不新建第二种 mutation 结果类型；不缓存 Orca receipt 内容 |
| IP-2 | 前驱 `src/adapters/orca-cli/` 的 `ExecutionBackend` 判别联合与错误透传 | 在同一 `query` 联合中增加只读对账查询，映射 `request-show` | 不复制 Orca mutation 状态机；不把 `absent` 判为已拒绝 |
| IP-3 | 前驱 `src/adapters/storage/` 的 `BranchCoordinationStore` 与 CAS revision | 增加 mutation lane 阻塞记录与其投影 | 不复制 Orca Task/Dispatch 状态 |
| IP-4 | 前驱 `src/application/delivery/process-delivery.ts` 与 Delivery 去重引用 | 启动时调用同一入口重放未确认 Delivery，并把 unknown 投影为 lane 阻塞 | 不复制正常 pipeline、去重类型或结果正文 |
| IP-5 | 前驱 Session 注册、Worker 生命周期与 Task/Dispatch/Attempt 记录 | 增加 Worker Session Recovery、Session Segment、RecoveryId 与查询 | 不按 cwd/mtime/terminal 输出推断 Session 归属；不复用原 Dispatch |
| IP-6 | 前驱 Worker Profile 解析与 `ExecutionAuthorizationManifest.maxRecoveriesPerWorkerAttempt` | 读取并扣减已批准上限；复用 Worker Profile | 不增加 Manifest 字段，不在 Manifest 之外缓存预算来源 |
| IP-7 | 前驱 Worker Task/contract/revision/业务 Attempt 与 Session Segment 记录 | 为替代 Session 创建新 Dispatch、Session Binding 与 Segment，保留业务身份 | 不复用原 Dispatch/Segment；不把替代 Session 伪装成原会话延续 |
| IP-8 | 前驱 Task Envelope、Session Binding 与 Utility Worker 派发 | Codex Adapter 以 SessionStart 报告和 rollout metadata 证明精确 transcript；Codex 使用 worktree 内隔离 `CODEX_HOME` 与 prepared-terminal 启动策略，经 Orca `worker-start --terminal` 正式接管；再以同一 Envelope 机制派发 Recovery Capsule 任务 | 不让 Coordinator 自行读取 transcript；不按 cwd/mtime 猜来源；不递归 Recovery；不写用户级 Codex 配置或 Orca 全局 Agent 默认值；不开放任意进程启动参数 |
| IP-9 | 前驱 Session 消息、compact、模型配置、`PlanningHandoffProposal`、Scope 控制、Pending Interaction CAS 与查询用例 | 用 `ControllerService` 组合既有用户意图、查询、回答与语义事件订阅 | 不复制应用规则；不让界面直连 store/backend |
| IP-10 | 前驱 `actionable-work.ts`、`suspension.ts`、`wake-admission.ts` 与 Execution Coordination Lease | 普通挂起/唤醒原样复用；仅新增独立 `ExecutionHandoffState` 与 cutover | 不包装或复制 Actionable Work、suspend、WakeBatchId/admission |

## 3. 代码变更映射

| IP-ID | Task | Requirement/Scenario | 文件与符号 | 精确变化 | 不得改变 |
|---|---|---|---|---|---|
| IP-1 | 1.1 | 启动对账必须以原 OperationId 得出三值结论 / 全部三个 Scenario | 新增 `src/domain/recovery/operation-intent.ts`；新增 `src/application/reconciliation/reconcile-operations.ts` | 定义未决 intent 的读取、三值归类与拒绝条件；无证明时返回未决 | 不新增结果类型；不改变前驱 OperationOutcome 语义 |
| IP-2 | 1.2 | 启动对账必须以原 OperationId 得出三值结论 / intent 无法证明未产生副作用 | 修改 `src/adapters/orca-cli/orca-backend.ts` 的 `query` 联合；新增 `src/adapters/orca-cli/reconcile-query.ts` | 增加按 OperationId 的只读对账查询；`absent` 映射为未决 | 不改 `mutate` 联合与其他 query 语义 |
| IP-3 | 1.3 | mutation lane 阻塞必须可观测且可解除 / 全部两个 Scenario | 修改 `src/adapters/storage/coordination-store.ts`；新增 `src/domain/coordination/mutation-lane.ts`；修改 snapshot 投影 | 增加 lane 阻塞记录、解除前置校验与投影输出 | 不把阻塞表达为全局锁；不阻止只读查询 |
| IP-4 | 1.4 | 启动重放必须复用既有 Delivery pipeline / 全部三个 Scenario | 修改 `src/bootstrap/startup.ts` 与 `src/application/reconciliation/reconcile-operations.ts` | 启动时把未确认 Delivery 交给前驱 `processDelivery`；unknown 阻塞 lane；旧代际只补历史 | 不修改正常 pipeline，不新增去重类型或记录 |
| IP-5 | 2.1 | Worker Session Recovery 先尝试精确恢复且不得凭不完整信息推断退出 / 全部三个 Scenario | 新增 `src/domain/recovery/worker-session-recovery.ts`；新增 `src/application/recovery/worker-session-recovery-service.ts` | 定义四角色共用的恢复生命周期、精确恢复优先与 unverifiable 保持未决 | 不改 Coordinator Session 恢复路径；不中断即建替代 Session |
| IP-6 | 2.2 | Recovery 必须以稳定 RecoveryId 与预写 Operation Intent 启动且按 Worker Attempt 计数 / 全部四个 Scenario | 修改 `src/application/recovery/worker-session-recovery-service.ts`；新增 `src/domain/recovery/recovery-budget.ts` | 稳定 RecoveryId、预写 intent、创建即消耗、按 Worker Attempt 独立计数、读取既有授权、默认复用 Worker Profile、workspace 不可对账失败 | 不重置已消耗额度；不新增或修改 Manifest 字段 |
| IP-7 | 2.3 | 替代 Session 保留业务身份但创建新 Dispatch 与 Segment / 全部三个 Scenario | 修改 `src/application/recovery/worker-session-recovery-service.ts`；修改 `src/adapters/storage/coordination-store.ts` | 保留 Worker Task/contract/revision/业务 Attempt；新建 Dispatch/Session Binding/Segment；实现 superseded 与迟到结果入历史 | 不复用原 Dispatch 或原 Segment |
| IP-8 | 2.4、6.5 | Recovery Capsule 必须由受限 Utility Worker 生成且按角色门判定 / 全部七个 Scenario | 新增 `src/application/recovery/recovery-capsule.ts`、`src/application/worker-launch.ts`、`src/domain/recovery/role-gate.ts`、`src/adapters/agents/codex-launch.ts` 与 `codex-transcript.ts`；修改 `src/application/materialize-work-package.ts`、`src/application/ports/execution-backend.ts`、`src/application/recovery/worker-session-recovery-service.ts`、`src/adapters/agents/session-binding.ts`、`utility-worker.ts`、`src/adapters/orca-cli/operation-catalog.ts` 与 `src/bootstrap/doctor.ts` | complete/partial 契约、Codex SessionStart 与 rollout 唯一证明、共享 Worker Launch Strategy、prepared-terminal 的正式 Dispatch 门与显式清理、Adapter coverage 证据、transcript_unavailable、单次安全重派、四角色门 | 不让 Coordinator 读 transcript；不让 Utility Worker 自报 partial；Finalizer 不依赖 Capsule；不以全局设置或非 Orca Worker 绕过能力门；不新增数据库字段或开放任意 launcher 参数 |
| IP-9 | 3.1 | Scope 控制动作必须正交且不隐式改变其他控制状态 / 全部五个 Scenario；ControllerService 统一界面层接缝 / 两个 Scenario | 新增 `src/domain/coordination/scope-control.ts`、`src/application/coordination/scope-control-service.ts` 与 `src/application/controller-service.ts`；修改 `src/bootstrap/` 退出路径 | 实现 Pause/Resume/Cancel/Exit、Resume 前置对账，并把既有 Session 消息、compact、模型切换、Planning Handoff、快照、语义事件与 Pending Interaction 回答组合进 façade | 不停止已运行 Worker；Exit 不写控制状态；façade 不复制规则，界面不直连 store/backend |
| IP-10 | 4.1 | Execution Handoff 以独立状态和 CAS 转移执行责任 / 全部三个 Scenario | 新增 `src/application/handoff/execution-handoff.ts`（`ExecutionHandoffState`、prepare/review/cutover）；扩展 `ControllerService` | handoff 只在 cutover 以 CAS 转移 Lease、相关 Interaction 与后续 Worker 事件责任，Target 进入 `awaiting_user_prompt` | 不复用 `PlanningHandoffProposal`；不改变运行、图、授权或预算身份；失败时 Source 仍是唯一 owner |
| IP-12 | 5.1 | 全部四个 capability 的启动衔接 | 修改 `src/bootstrap/startup.ts` | 固定顺序：对账 → lane 投影 → 续办未完成 Recovery → Resume/Exit 处理 → 允许派发 | 不在对账完成前派发或恢复模型 |
| IP-13 | 6.1、6.2 | 全部四个 capability 的验收层 | 新增 `tests/recovery/acceptance/*`、`tests/handoff/acceptance/*`；新增 fake backend 与 fake model 测试装置 | 覆盖全部角色、预算边界、partial/unavailable Capsule、迟到、重复启动、崩溃窗口与 fake handoff；真实场景先探测 prepared-terminal 的准备、接管与清理，再运行一次隔离 MiniMax-M3 Validator Recovery | 不以真实调用替代 fake 覆盖；不在非隔离项目运行真实 harness；能力缺失时不改全局设置绕过 |

## 4. 调用与副作用顺序

启动（IP-1、IP-2、IP-3、IP-12）：

1. 加载配置与 Scope，获取 Runtime Lease；
2. 读取 store 中的未决 Operation Intent；
3. 逐项以原 OperationId 执行只读对账查询（Orca `request-show`）；
4. 归类为已接受、已拒绝或未决；未决项写入 mutation lane 阻塞记录；
5. 投影 Workflow Snapshot，呈现阻塞；
6. 以同一 RecoveryId 续办未完成的 Worker Session Recovery；
7. 仅当无阻塞项影响所需 lane 且 Recovery 已续办时，才允许派发与模型恢复。

Delivery 恢复（IP-4）：启动发现未确认 Delivery → 调用前驱唯一 `processDelivery` → accepted/rejected 时按其结果继续 → unknown 时以原 OperationId 阻塞 lane；本 change 不重述或改写 pipeline 内部顺序。

Worker Session Recovery（IP-5、IP-6、IP-7、IP-8）：

1. 观察中断，按精确 Session Binding 校验归属；证据不足则记 `unverifiable` 并保持未决；
2. 尝试精确恢复原会话；成功则结束；
3. 需要替代时分配稳定 RecoveryId（由中断来源事实确定性派生，使重启续办命中同一条 Recovery）；
4. 对 Codex Worker 以 prepared-terminal 策略在 worktree 内准备隔离 `CODEX_HOME`、临时项目 trust 与已核验的 hook trust bypass，等待 idle 后由 Orca `worker-start --terminal` 正式接管；仅在读回非空 draft 时以固定 Enter 补交一次；任一资源状态不可核验即阻塞，不写用户级配置或全局 Agent 默认值；
5. Worker Harness Adapter 以 Dispatch/Session Binding 证明 transcript 来源并给出读取覆盖；没有精确来源即 `transcript_unavailable`，Codex 来源必须通过 SessionStart、`CODEX_HOME`、唯一 rollout metadata、workspace 与时间窗核验；
6. 派发受限 Utility Worker 生成与 Adapter coverage 一致的 Capsule（complete 或 partial）；Utility Worker 自报且无 Adapter 缺口证据的 partial 一律拒绝；
7. 通过角色门校验；
8. 预写 Operation Intent，并把 Recovery 推进到 `recovering`（`prewriteOperationId` 随同一次 `advance-recovery` 写回）；
9. 创建替代 Dispatch、Session Binding 与 Segment，并在同一事务内递增该 Worker Attempt 的 Recovery Budget；
10. 原 Session 若在替代 Dispatch 被接受前到达有效终态，以该终态结束 Recovery 并把原 Segment 标记 superseded。

> 顺序说明（实施期修订）：第 4 至 7 步位于第 8 步**之前**。原计划把预写 Intent 排在第 3 步，但 store 的
> Recovery 状态迁移不允许 `recovering → recovering`，若 Capsule 或角色门在预写之后失败，会留下一条
> 永远无法安全收尾的未决派发 Intent，使该 lane 永久阻塞。spec 的要求是「在执行**替代 Session** 等副作用
> 之前预写 Operation Intent」，Capsule 生成不属于替代 Session，因此本顺序满足合同且避免悬空意图；
> 「建 Recovery → 预写 Intent → 进 `recovering`」这三者的相对顺序保持不变。

Scope 控制（IP-9）：Pause 写控制状态并停止新派发与模型恢复；Resume 先跑启动对账用例再恢复调度；Cancel 先写意图再请求停止，未确认则保持 cancelling/unverifiable；Exit 只结束进程。

普通挂起与唤醒完全复用前驱 `coordinator/wake-suspension` capability 及其三个应用模块，本 change 不增加调用层。

Execution Handoff（IP-10）：prepare 固定 Source/Target、责任集合与 expected revision → review 校验 checkpoint、Coordinator Context Capsule 与目标 → 用户确认 → 单次 CAS cutover 转移 Lease、相关 Interaction 与后续 Worker 事件责任 → Target `awaiting_user_prompt`。任何失败保持 Source owner；这条路径不调用普通 Wake Batch 来暗示责任转移。

## 5. Schema、状态与持久化落实

- **SSOT**：Operation Intent 及其结论、mutation lane 阻塞、RecoveryId、按 Worker Attempt 的 Recovery Budget 用量、Scope 控制与 `ExecutionHandoffState` 写入 `coordination.sqlite`；复用前驱已有的 Session Segment、Delivery 去重引用与 wake admission。Wake Batch、Coordinator Context Capsule 与消息写入 `checkpoints.sqlite`。不新增数据库。
- **Recovery 状态转换**：`observed → verified|unverifiable → recovering|replaced → completed|superseded|failed`。只有 `recovering` 允许创建替代 Session；`superseded` 只接受历史结果。
- **mutation lane 状态转换**：由 `clear` 转为 `blocked` 只在存在未决 intent 时发生，转回 `clear` 需确定结论或用户补充事实并重验 scope/ownership/revision/预算。
- **约束与并发**：所有写入沿用前驱的 CAS revision 与短事务；去重键唯一；Recovery Budget 采用读-改-写并在创建替代 Segment 的同一事务内递增。
- **幂等**：启动对账可重复执行且结果稳定；同一 RecoveryId 重启后继续而不新开 Recovery；Wake Batch 与 Delivery 分别复用前驱的 WakeBatchId 与 Delivery 去重键。
- **迁移**：通过可重入、版本化 migration 增加 mutation lane、Recovery、Scope 控制与 `ExecutionHandoffState` 并保留前驱数据；不修改 Manifest schema，不重建 `session_segments`、Delivery 去重引用或 `wake_admissions`。

## 6. 验收证据矩阵

| Requirement/Scenario | IP-ID | 测试文件 | Fixture/前置条件 | 关键断言 | 可运行命令 |
|---|---|---|---|---|---|
| 启动对账 / 三个 Scenario | IP-1、IP-2、IP-3 | `tests/recovery/reconcile-operations.test.ts` | fake backend：已接受、absent、响应丢失 | 先对账后决定；absent 为未决；不换 OperationId | `pnpm test -- tests/recovery/reconcile-operations.test.ts` |
| mutation lane 阻塞 / 两个 Scenario | IP-3 | `tests/recovery/mutation-lane.test.ts` | 一条 lane 阻塞 | 阻塞可观测；解除后重验 scope/revision | `pnpm test -- tests/recovery/mutation-lane.test.ts` |
| Delivery 恢复重放 / 三个 Scenario | IP-4 | `tests/recovery/delivery-replay.test.ts` | 未确认、unknown 与旧代际 Delivery | 只调用既有 pipeline；unknown 阻塞 lane；旧代际不推进 | `pnpm exec vitest run tests/recovery/delivery-replay.test.ts` |
| Recovery 精确恢复与 unverifiable / 三个 Scenario | IP-5 | `tests/recovery/worker-session-recovery.test.ts` | 可绑定、不可判定与 Coordinator 中断 | 先精确恢复；unverifiable 不推断退出；Coordinator 不产生 RecoveryId | `pnpm test -- tests/recovery/worker-session-recovery.test.ts` |
| RecoveryId、预写 intent 与预算 / 四个 Scenario | IP-6 | `tests/recovery/recovery-budget.test.ts` | 未完成 Recovery 重启、达上限、workspace 丢失 | 同 RecoveryId 续办；创建即消耗；按 Worker Attempt 独立；不重置 | `pnpm test -- tests/recovery/recovery-budget.test.ts` |
| 替代 Session 身份与 superseded / 三个 Scenario | IP-7 | `tests/recovery/alternate-session.test.ts` | 替代派发与原会话终态 | 保留 Task/contract/revision/Attempt；新 Dispatch/Binding/Segment；迟到入历史 | `pnpm test -- tests/recovery/alternate-session.test.ts` |
| Capsule、transcript 证明与角色门 / 七个 Scenario | IP-8 | `tests/adapters/agents/codex-transcript.test.ts`、`tests/recovery/recovery-capsule.test.ts`、`tests/recovery/acceptance/real-validator-partial.test.ts` | 唯一 Codex rollout、prepared-terminal 正式接管、complete、partial、不可用、重派失败、Finalizer | metadata/workspace/time-window 精确匹配；准备或接管不可核验时失败关闭；partial 需 Adapter 证据；不可用失败；单次重派；Finalizer 不依赖 Capsule | `pnpm test -- tests/adapters/agents/codex-transcript.test.ts tests/recovery/recovery-capsule.test.ts`；真实能力门见 6.5 |
| Scope 控制 / 五个 Scenario | IP-9 | `tests/coordination/scope-control.test.ts` | 活跃 Worker、Pause/Resume、取消未确认、退出重入 | 已运行 Worker 不停止；Resume 先对账；未确认保持；Exit 不写状态 | `pnpm exec vitest run tests/coordination/scope-control.test.ts` |
| ControllerService 接缝 / 两个 Scenario | IP-9 | `tests/application/controller-service.test.ts` | fake 应用用例、stale interaction 与语义/诊断事件 | 各入口只委派一次到既有用例；stale 回答零副作用；仅发布语义事件；不直连 store/backend | `pnpm exec vitest run tests/application/controller-service.test.ts` |
| Execution Handoff / 三个 Scenario | IP-10 | `tests/handoff/execution-handoff.test.ts` | prepare/review、成功 cutover、Capsule/CAS 失败 | cutover 前 Source owner；成功时责任 CAS 转移且身份不变；失败时 Target 未激活 | `pnpm exec vitest run tests/handoff/execution-handoff.test.ts` |
| 启动衔接顺序 | IP-12 | `tests/bootstrap/startup-reconciliation.test.ts` | 存在未决 intent 与未完成 Recovery 的启动 | 对账与续办完成前不派发、不恢复模型 | `pnpm test -- tests/bootstrap/startup-reconciliation.test.ts` |

全量门禁：`pnpm typecheck && pnpm lint && pnpm test`

### 6.1 验收层：fake backend 与 fake model（IP-13）

| 覆盖目标 | 测试文件 | Fixture/前置条件 | 关键断言 | 可运行命令 |
|---|---|---|---|---|
| 全部角色的 Recovery | `tests/recovery/acceptance/roles.test.ts` | fake backend + 四角色中断 | Specification Planner、Implementation、Validator、Finalizer 各自走同一 Recovery 生命周期 | `pnpm test -- tests/recovery/acceptance/roles.test.ts` |
| 预算边界 | `tests/recovery/acceptance/budget-boundaries.test.ts` | fake backend + Manifest 上限 0/1/N | 创建替代 Segment 即消耗；达上限阻塞；不重置 | `pnpm test -- tests/recovery/acceptance/budget-boundaries.test.ts` |
| partial 与 unavailable Capsule | `tests/recovery/acceptance/capsule-verdicts.test.ts` | fake Utility Worker 返回 complete/partial/unavailable | partial 列全字段且按角色门判定；unavailable 失败 | `pnpm test -- tests/recovery/acceptance/capsule-verdicts.test.ts` |
| 迟到结果 | `tests/recovery/acceptance/late-results.test.ts` | 原 Segment 在被 superseded 后返回 | 迟到结果只入历史，不推进当前 Attempt | `pnpm test -- tests/recovery/acceptance/late-results.test.ts` |
| 重复启动 | `tests/recovery/acceptance/repeat-startup.test.ts` | 同一 Scope 连续两次启动 | 以同一 RecoveryId 续办；不重复派发、不重复注入 Wake Batch | `pnpm test -- tests/recovery/acceptance/repeat-startup.test.ts` |
| 崩溃窗口 | `tests/recovery/acceptance/crash-windows.test.ts` | 在 intent 预写前后、Segment 创建前后、ack 前后注入崩溃 | 每个窗口都可对账到确定结论或保持未决，绝不产生第二副作用 | `pnpm test -- tests/recovery/acceptance/crash-windows.test.ts` |
| Execution Handoff（fake model + fake backend） | `tests/handoff/acceptance/fake-handoff.test.ts` | fake chat model 与 fake backend | 普通唤醒不转移 owner；prepare/review 不提前转移；cutover 原子转移责任且身份不变；失败保持 Source；零真实模型调用 | `pnpm exec vitest run tests/handoff/acceptance/fake-handoff.test.ts` |

验收层命令：`pnpm test -- tests/recovery/acceptance tests/handoff/acceptance`

### 6.2 验收层：真实隔离 Recovery（IP-13）

| 覆盖目标 | 验证载体 | 前置条件 | 关键断言 | 可运行命令 |
|---|---|---|---|---|
| MiniMax-M3 Validator 真实中断 Recovery | `tests/recovery/acceptance/real-validator-partial.test.ts`（显式标记 `@real-harness`，默认不参与常规 `pnpm test`） | 显式选择的隔离项目、专用 Orca 身份与绑定 Run；Validator Worker Profile 使用 MiniMax-M3；prepared-terminal 在 worktree 内建立隔离 `CODEX_HOME`、临时项目 trust 与 hook trust bypass，并由 Orca 正式接管；SessionStart 在执行前上报 session ID、`CODEX_HOME`、transcript path 与 cwd | 能力探测通过后，Codex Adapter 以唯一 rollout metadata、workspace 与 Dispatch 时间窗签发精确 `transcriptRef`；Utility Worker 按实际 coverage 产出 Capsule；真实来源完整时为 complete；角色门通过。准备、接管或清理不可核验时失败关闭且验收保持未完成；partial 由 fake acceptance 覆盖 | 隔离项目内运行 `ORCA_COMPANION_REAL_HARNESS=1 pnpm test -- tests/recovery/acceptance/real-validator-partial.test.ts` |

真实调用边界：只在隔离项目与专用身份中运行，不触碰用户主项目、不重启全局 Orca runtime、不改上游、不留存敏感 transcript 到仓库。

## 7. 文件清单与升级条件

**新增**：`src/domain/recovery/operation-intent.ts`、`worker-session-recovery.ts`、`recovery-budget.ts`、`role-gate.ts`；`src/domain/coordination/mutation-lane.ts`、`scope-control.ts`；`src/application/reconciliation/reconcile-operations.ts`、`src/application/recovery/worker-session-recovery-service.ts`、`recovery-capsule.ts`、`src/application/worker-launch.ts`、`src/application/coordination/scope-control-service.ts`、`src/application/handoff/execution-handoff.ts`、`src/application/controller-service.ts`、`src/adapters/orca-cli/reconcile-query.ts`、`src/adapters/agents/codex-launch.ts`、`codex-transcript.ts`；以及第 6、6.1、6.2 节列出的测试文件与 `tests/support/` 下的 fake backend 与 fake chat model 装置。

**修改**：`src/application/ports/branch-coordination-store.ts`、`src/application/ports/execution-backend.ts`、`src/application/materialize-work-package.ts`、`src/application/recovery/worker-session-recovery-service.ts`、`src/adapters/storage/schema.ts`、`src/adapters/storage/coordination-store.ts`、`src/adapters/orca-cli/orca-backend.ts`、`src/adapters/orca-cli/operation-catalog.ts`、`src/adapters/agents/session-binding.ts`、`utility-worker.ts`、`src/bootstrap/doctor.ts`、`src/bootstrap/startup.ts` 与既有 snapshot 投影；按 Codex 启动 PoC 与 6.5 的真实结果更新 `docs/orca-compatibility.md`；migration 只增加本 change 的 Recovery、lane、控制与 `ExecutionHandoffState` 记录，prepared-terminal 不新增数据库字段。

**受保护（本 change 不得改动）**：`openspec/schemas/`、`openspec/config.yaml`、`AGENTS.md`、`CONTEXT.md`、`package.json` 与依赖清单、`references/orca`；除同步 Codex 启动 PoC、当前 capability blocker 与 6.5 最终结果的 `docs/orca-compatibility.md` 外，其他 `docs/` 文件保持不变。

**升级条件**：出现以下任一情况即停止实施并向用户请示——需要新增公共字段、依赖、数据库或计划外 migration；需要改变前驱冻结的五处接缝；前驱未 archive 或其符号漂移；`request-show` 的 `absent` 判定或 `worker-show` 的三值存活语义与设计不符；需要修改 Manifest 字段或超出其 Recovery Budget 上限；某个 Scenario 无法在不伪造身份或直接读写 Orca 数据库的前提下满足；真实隔离 Recovery 无法在专用身份下绑定 Run；或 prepared-terminal 需要开放任意 shell/env/argv、写用户级配置、修改 Orca 全局 Agent 默认值或绕开 Orca Worker 身份。

## 8. 验收 Agent 授权与限定审计

- **授权范围**：本 change 的四个 capability spec 全部 Requirement/Scenario、IP-1 至 IP-13、上节"新增"与"修改"清单内的文件、以及第 6、6.1、6.2 节列出的测试文件与命令。
- **受保护边界**：五处冻结接缝的语义、`OperationOutcome` 三值定义、Branch Coordination Store 与 checkpointer 的权威分工、`openspec/` 规划资产。
- **限定审计标签**：`gate.no-ack-before-persist`（Delivery 顺序）、`gate.no-new-operation-id-on-unknown`（对账不得换 ID 重试）、`gate.budget-not-reset-on-recovery`（Recovery Budget 不被重启重置）、`gate.recovery-not-inferred-from-incomplete-evidence`（unverifiable 不推断退出）、`gate.alternate-session-new-dispatch-only`（替代 Session 必须新 Dispatch 与 Segment）、`gate.partial-capsule-declares-gaps`（partial Capsule 必须列缺口与 unknowns）。
