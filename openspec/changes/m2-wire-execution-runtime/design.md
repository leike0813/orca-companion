## Context

`src/bootstrap/foreground-planning-runtime.ts` 能装配 Session、规划工具和执行只读投影；执行模式下的 `executionObservations` 只读 `worktree-list` 与 `worker-list`。`src/bootstrap/startup.ts` 已有意图对账、Delivery 重放、Recovery 续办与 Scope 控制顺序，但生产宿主未调用它。`materializeWorkPackage`、`settleDelivery`、`runValidation`、`integrateWorkPackage`、`finalizeProject` 仅被测试直接调用。`GitIntegrationPort` 没有生产实现，Finalizer 运行前后工作区与 Capsule coverage 也没有生产观察来源。

本 change 接通当前未提交的 M2 执行界面，不将其搬入新状态机。直接前驱是已归档的 `m2-deliver-planning-tui`；并行活跃的 `m2-deliver-execution-tui` 保留 5.2/5.3 真实 PTY 验收。执行 TUI 的现有接缝须在本 change apply 前固定，两个 agent 不得同时编辑共享文件。

## Goals / Non-Goals

**Goals:** 一条可恢复的前台执行闭环；真实授权、串行派发、结算、验证、集成、Finalizer；Resume/Cancel 的确定性对账；把权威事实接入现有快照与语义事件。

**Non-Goals:** 新的 Execution Graph 状态机、第二套 Delivery pipeline、TUI 侧副作用、Graph Patch/Specification Revision/Replanning 的生产接线、后台控制器、并行派发、单包 Pause/Cancel、发布/部署、跨平台支持声明。

## Decisions

### D1. 单个前台执行驱动拥有推进权

在 `src/application/execution/` 放一个有界的 `advanceExecution` 用例：输入来自 IC-03 快照、当前 IC-05 图/授权、Orca/Git 实时观察和可信 Runtime/Execution Lease 身份；一次调用最多推进一个需要外部副作用的阶段。`src/bootstrap/foreground-planning-runtime.ts` 在启动对账完成、授权切换、已结算 Delivery 或用户 Resume 后调用它；普通进度可触发有界轮询。每次进入前重验 Scope、generation、lease、revision、control state、预算及 lane。只有 Lease holder 可以消费生命周期事件或写执行状态；其他 Session 仍可读快照。调用不得来自 React render/effect/resize。复用既有 `guardDispatchCandidate` 与 `materializeWorkPackage`，不持久化第二份图状态。候选按当前图拓扑及单并发规则确定；不可确认时停在 blocker。

公开输入只接受可信宿主提供的 `store`、`backend`、`scopeId`、`writer`、当前图/授权引用、实时观察、`expectedRevision` 与当前阶段的稳定 OperationIds；结果为 `progressed`（含已提交引用）、`idle`、`blocked`（含 lane/code）或 `unknown`（含原 OperationId）。选择规则由已接受的角色结果、图依赖和现有预算/门禁推出，不把 TUI 投影的显示状态反向当作权威输入。

### D2. 规划到执行是用户批准后的受控命令

从 tracker 当前地图/票据和正式 Implementation Plan 读取输入；调用现有 Graph Compiler、`startGraphGeneration`、`recordInitialGraph`、`proposeManifest`、`recordApproval`、`handoffGateFacts` 与 `transitionToExecution`。在 IC-11 增加有界的 Manifest 审阅/批准命令，复用现有审阅交互；用户批准完整 Manifest，模型只可提出候选和发起审阅，不能填充可信 scope、Run 或 operation identity。切换事务仍归 IC-03。地图/计划/图 revision 漂移时批准失效，不派发。图的编译与授权不放进 TUI。

审阅端口返回完整 Manifest、fingerprint、candidate graph ref 与当前 Scope revision；批准意图只携带该 fingerprint 和 expected revision，宿主重读全部权威输入并按 exact fingerprint 调用批准/切换用例。若现有 Pending Interaction 不适合承载结构化批准，仍使用同一 ControllerService/TuiPorts 边界增加专用 intent，不把自由文本回答解释成批准。

### D3. 只装配现有 Worker 生命周期用例

执行驱动根据当前接受的角色结果选择 Planner → Specification Admission（必要时 Specification Validator）→ Implementation → Validator → Git integration。`materializeWorkPackage` 负责 worktree/Task/Dispatch 与受控 Worker 启动；Codex Profile 来自 Manifest，`createCodexWorkerLaunch` 生成固定启动策略。Delivery 只通过 `readDeliveryBatch` → `settleDelivery`；启动重放只通过 `replayDeliveries`。独立 Validator 的验证、范围内修复与复验复用同一精确 Session Binding，并由现有 `runValidation`/Recovery 用例约束预算与证据失效。`unknown` 保留原 intent/OperationId，旧 generation/attempt 只补历史。新的应用代码只做事实装配和阶段选择，不复制这些用例的准入或状态转换。

### D4. 启动、Resume、Cancel 共用对账事实

重用 `startCompanionStartup` 的步骤顺序，调整其装配 seam 以复用前台已取得的 Runtime Lease，避免启动两次 Session。仅 Execution Lease holder 处理执行 mutations、Delivery 和 Recovery；观察者 Session 不消费。Resume 的 `ScopeReconciliationRunner` 调用同一 `reconcileOperations`、Delivery 重放与 Worker liveness 核验；未决 lane 只阻塞关联目标，但不可确认的活跃 Worker 阻止重复派发。Cancel 的 `WorkerStopPort` 用当前 Run 的精确 Dispatch 列表，先由现有 Scope control 用例持久化 `cancelling`，再以受控 Orca `worker-stop` mutation 和稳定 intent 发出请求；stop verdict 仅在可核验时映射为 stopped，超时/传输错误为 unverifiable。Exit 不调用 stop。

### D5. Git 集成端口只执行已批准的三个步骤

先修正 `integrateWorkPackage`/`GitIntegrationPort` 的读回合同：commit 在精确 Worker worktree 中核验 source HEAD；integration 在 canonical worktree 中以 expected canonical HEAD 核验目标；push 核验获批 remote/ref 的目标 commit。现有“每步都回读 canonical HEAD”不能证明 source commit 或远端 push。随后在 `src/adapters/git/` 用现有 `runProcess`、参数数组与明确 cwd 实现该端口；输入只来自获批 branch、remote/ref、两个目标的 expected HEAD 和同一 OperationId。每步前后读相关 HEAD/index/dirty paths，并通过 Orca Work Package worktree 身份核验源；只允许普通 commit、canonical integration 和非强制 push。超时、冲突或回读不一致返回 unknown/blocked，由既有 intent 对账；不得自动重试、force-push、reset 或切换用户当前分支。IC-08 与对应测试先于 adapter 同步更新。

### D6. Finalizer 的只读条件与证据来自运行事实

`planFinalizerDispatch` 决定门禁；只在全部 Work Package 已集成、无待答交互/未决操作时冻结集成。Finalizer 使用新 Codex Session 和 canonical worktree，启动器必须能强制只读且把自身状态文件放在 Git common dir 的 Companion 私有目录，不污染 canonical worktree。运行前的 HEAD/index/dirty paths 作为 Task Envelope 的固定输入，完成后再次从 Git 读取并与 Finalizer 报告、Orca Task/Session Binding 一起交给 `finalizeProject`。`ControllerSnapshot.finalizer` 继续由现有纯投影产生，只从 Orca Task/结果引用和实时 Git 事实装配 `FinalizerObservationFacts`。只读无法证明或工作区变化均阻塞，不接受 deliverable。

### D7. 恢复证据与事件只引用权威来源

Recovery Capsule 的正文留在精确 Worker transcript/Orca 结果，IC-03 仅保存已有 `capsuleRef`；前台从该引用核验 `complete`/`partial` coverage 后投影，无法读取则保持 unknown。语义事件在被接受的角色结果、集成或 Finalizer verdict 落盘并回读后发布，重复 Delivery/keepalive 不发布。TUI、CLI 继续消费 IC-11/12 快照；生产事实缺失时继续显示 blocker/unknown。优先沿用现有 DTO，不加表和 migration；若某事实确实无法从权威源恢复，先更新合同再增加最小记录。

### D8. 真实验收只用隔离身份

本 change 在显式选择的一次性 Git 项目和专用 Orca 身份中验证真实执行闭环，Worker Profile 固定为 `minimax-cn/MiniMax-M3`；覆盖授权、串行 Frontier、Validator 同 Session 修复、集成、Finalizer、退出重启不重复派发，以及一次 Recovery 或明确 blocker。执行 TUI change 继续拥有 `tests/tui/pty-execution.test.ts` 的 5.2/5.3 验收；本 change 交付能让它运行的生产路径和隔离执行证据。普通 Vitest 使用 fake backend 检查故障窗口；默认检查不启动真实 Worker 或修改用户主项目。

### D9. 身份由已提交的候选事实稳定签发

执行驱动按 Scope、Graph Generation、WorkPackageId、角色、Task Contract Revision、Attempt 与步骤组成稳定 OperationId；现有未决 lane 的 OperationId 总是优先复用。一次物化所需多个 ID 分别绑定 worktree、Task、terminal preparation、worker start 与 activation，不能用一个 ID 覆盖多次副作用。Request、receipt 与身份引用保留在现有 Orca/IC-03 权威位置，不另建通用 inbox。任何组成事实不可读时阻塞，不以新随机 ID 继续；CAS 冲突时重读后重新判定，而不是盲重试。

## Risks / Trade-offs

- `GitIntegrationPort` 与 Finalizer 只读 Profile 目前无生产实现，是真实能力门；无法在当前 CLI/harness 强制时必须停在 blocker，不能靠界面模拟通过。
- `startCompanionStartup` 与现有前台 Session 装配重叠，接线时须保持同一个 Runtime Incarnation 和 fencing generation。重复取得租约会导致迟到写入风险。
- 两个 change 同时 active 时，共享 `foreground-planning-runtime.ts`、IC-11/12 与 PTY fixture；实施必须按文件串行，先固定 M2 的已完成 UI 接缝，再接执行运行时。本 change 的验证与 archive 先于 M2 的 5.2/5.3 验收。

## Migration Plan

无需预设 SQLite migration。`openspec/config.yaml` 对这两个具名 change 允许解阻塞顺序：`m2-wire-execution-runtime` 以已归档的 planning TUI 为直接前驱，在执行 TUI 仍 active 时实施；先验收并归档接线，再执行原 M2 的 5.2/5.3 与归档。实施前核对当前未提交 UI 变更和 IC-05/07/08/09/11 接缝；既有未决 intent、Recovery 与 Delivery 必须按原身份对账。
