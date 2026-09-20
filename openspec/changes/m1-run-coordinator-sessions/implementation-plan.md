# Implementation Plan

## 1. 实施基线与权威来源

基线模式：**predecessor-contract**。

直接前驱：`m1-persist-coordination-state`。规划提交：`cd29e2bcd8b0278d34ae19db64cb8ebdaf149279`（本 change 起草时的仓库 HEAD）。

架构合同基线：`docs/architecture.md` 的 `MOD-02`–`MOD-04`、`FLOW-02` 与 `docs/interface-contracts.md` 的 `IC-01`–`IC-04`。本 change Create `IC-04`，Extend `IC-03`，Consume `IC-01`/`IC-02`。

实施前必须同时满足：

1. `m1-persist-coordination-state` 已归档（`openspec list --json` 中不再出现该 change，且 `openspec/changes/archive/` 下存在其快照）；
2. 其 delta 已合并进 `openspec/specs/`，`openspec list --specs --json` 能列出对应 capability；
3. 下列冻结接缝在实现 HEAD 上仍以同名符号存在，且语义未变。任一不满足即停止实施并回到 planning。
4. `IC-04` 的 canonical paths 尚未被前驱占用，`IC-03` 仍只通过同一 port 与版本化 migration 扩展。

| 冻结接缝 | 期望形态 | 本 change 的使用方式 |
|---|---|---|
| CAS revision | Branch Coordination State 的 expected revision 校验入口 | 读取与推进 Session 注册、Wake Batch admission 时携带 expected revision |
| Runtime Lease / fencing generation | 取得 lease、读取当前 generation 的可调用入口 | 写 checkpoint、维护 lane 与执行副作用前的唯一准入判据 |
| Operation Intent | 副作用前持久化 intent、完成后核销的入口 | Session 启动、配置切换与会话相关 mutation 沿用同一意图记录 |
| Session registry | 按 Coordination Scope 登记与查找 Coordinator Session | 解析 Session ID 到 thread 与 model configuration 绑定的唯一来源 |

权威输入：`CONTEXT.md`（领域术语唯一事实源）、`AGENTS.md` 第 2/4/5/8/11 节、`docs/research/agent-loop-termination-and-stall-detection.md`、`docs/research/codex-context-compaction-behavior.md`、`docs/research/omp-shake-compaction-recovery.md`、`docs/research/coordinator-state-recovery.md`。本计划的设计决策见 `design.md` 的 D1–D19。

术语迁移：`CONTEXT.md` 与 `AGENTS.md` 现用 Coordinator Profile。Canonical 术语是 Coordinator Model Configuration，指同一概念。apply 阶段把这两个文档中的该术语同步为新写法，并保持其余内容不变；起草阶段不编辑这两个文件。

### 合同 create/extend/consume

| 关系 | 合同与 canonical symbols | 漂移检查 |
|---|---|---|
| Create | `IC-04`：`session-state.ts`、`checkpoint-store.ts`、`actionable-work.ts`、`wake-admission.ts`、`suspension.ts` | 两个 SQLite store 分离；stable WakeBatchId 不重复注入；Context Capsule 不成为业务权威 |
| Extend | `IC-03`：`wake_admissions` 与 Session runtime records | 只增加最小记录，不复制 Wake Batch 内容或 checkpoint |
| Consume | `IC-01`、`IC-02`、`FLOW-02` | 同一 Session/Operation identity；恢复前先 lease/fencing 与 intent 对账 |

## 2. 复用与接缝

| IP-ID | 现有或前驱文件与符号 | 复用方式 | 禁止复制的事实 |
|---|---|---|---|
| IP-1 | `src/domain/`（占位）、前驱的 Session registry | 新增领域类型，只引用前驱 Session 身份 | 不复制 Session 注册表内容 |
| IP-2 | 前驱 Runtime Lease 与 fencing 入口 | 直接调用，不自建锁 | 不复制 lease 状态或 generation 计数 |
| IP-3 | 前驱的 Operation Intent 入口 | 直接调用 | 不复制 intent 记录 |
| IP-4 | `src/application/`（占位） | 新增 Actionable Work 投影与维护 lane 用例 | 不镜像 Orca Delivery 内容 |
| IP-5 | 无 | 新增 checkpoint store 适配器 | 不与 coordination store 共用文件或表 |
| IP-6 | 无 | 新增 StateGraph、节点与压缩路径 | 不复制准入、预算、状态转换规则 |
| IP-7 | `src/adapters/agents/`（占位） | 新增配置装配、能力核验与切换用例 | 不内置 provider allowlist 或凭据 |
| IP-8 | `src/interfaces/cli/`、`src/bootstrap/`（占位） | 新增 doctor 与装配入口 | 不在核心入口加载 Ink/React |
| IP-9 | `CONTEXT.md`、`AGENTS.md` 的 Coordinator Profile 措辞 | 术语替换 | 不改动这两个文档的其它内容 |
| IP-10 | 无 | 新增真实 provider 冒烟测试 | 不把真实调用纳入普通 `pnpm test` |

## 3. 代码变更映射

| IP-ID | Task | Requirement/Scenario | 文件与符号 | 精确变化 | 不得改变 |
|---|---|---|---|---|---|
| IP-1 | 1.1 | 会话状态不含凭据与业务权威 / 未完整提交的响应不进入历史 | `src/domain/coordinator/session-state.ts`（`CoordinatorSessionId`、`CoordinatorSessionState`、`CommittedModelStep`、`parseCoordinatorSessionState`） | 新增领域类型与运行时校验，禁止凭据与外部事实字段 | 不新增业务权威字段 |
| IP-1 | 1.1 | 同一 Scope 内两个 Session 互不可见 | `src/domain/coordinator/session-state.ts`（`threadIdFor`） | Session ID 到 checkpoint thread 的确定性映射 | 不共享线程 |
| IP-2 | 1.2 | 并发进程启动同一 Session 被拒绝 / 被 fence 的迟到进程写入被拒绝 | `src/application/coordinator/runtime-guard.ts`（`acquireIncarnation`、`assertFencingGeneration`） | 包装前驱 lease 与 fencing 入口 | 不自建锁、不缓存 generation |
| IP-2 | 1.2 | 恢复不创建新身份 / checkpoint 不可恢复时 fail closed | `src/application/coordinator/runtime-guard.ts`（`resumeIncarnation`、`CheckpointUnrecoverableError`） | 复用原身份与预算；不可恢复时阻塞 | 不创建替代 Session、不转移 claim 或 lease |
| IP-3 | 1.3 | Wake Batch 先落盘再恢复 / 重复恢复不重复注入 | `src/application/coordinator/wake-admission.ts`（`admitWakeBatch`、`admissionKeyFor`）；修改 `src/application/ports/branch-coordination-store.ts`、`src/adapters/storage/schema.ts`、`coordination-store.ts` | 以稳定 batch ID 先写 checkpoint，再以 source revision 写入 `wake_admissions`；新增可重入 schema migration | 不换 ID 重放已提交 batch，不把 Wake Batch 内容复制进 coordination store |
| IP-4 | 1.4 | 无 Actionable Work 时不唤醒 / 挂起后前台仍在工作 | `src/application/coordinator/actionable-work.ts`（`projectActionableWork`） | 新增 owner-scoped 投影 | 不建通用 inbox、不把进度当工作 |
| IP-4 | 1.4 | 挂起是可恢复条件而非进程终止 | `src/application/coordinator/suspension.ts`（`suspendSession`、`SuspensionState`） | 结束模型循环并记录可恢复状态 | 不停止 Controller、不记为完成 |
| IP-4 | 1.5 | keepalive 不推进业务状态 / 维护受有限 cycle 与 fencing 约束 | `src/application/coordinator/maintenance-lane.ts`（`planMaintenance`、`runMaintenanceCycle`、`MAINTENANCE_CYCLE_LIMIT`） | best-effort 维护，受 lease、fencing 与 cycle 上限约束 | 不创建 Wake Batch、Committed Model Step 或 transcript、不改图位置 |
| IP-4 | 1.5 | Actionable Work 抢占维护 / Pause 或 Cancel 停止维护 | `src/application/coordinator/maintenance-lane.ts`（`yieldForActionableWork`、`stopMaintenance`） | 抢占与控制状态停止 | 不让维护推迟或消费 Actionable Work |
| IP-5 | 2.1 | 同一 Scope 内两个 Session 互不可见 | `src/adapters/storage/checkpoint-store.ts`（`openCheckpointStore`、`saveCheckpoint`、`loadCheckpoint`） | 新建独立 SQLite checkpoint store，`durability: sync` | 不与 `coordination.sqlite` 共用文件 |
| IP-5 | 2.1 | 被取代区间的原始消息仍可恢复 | `src/adapters/storage/checkpoint-store.ts`（`readCommittedMessages`） | 暴露原始已提交消息读回 | 不让 Capsule 覆盖原始消息 |
| IP-5 | 2.2 | 两类产物分开保存 | `src/adapters/storage/checkpoint-store.ts`（`saveNativeWindowOwner`、`loadNativeWindowOwner`、`savePortableCapsule`、`loadPortableCapsule`） | 原生窗口 owner metadata 与 Capsule 分字段保存 | 不把两类产物混存或相互推导 |
| IP-6 | 3.1 | 未完整提交的响应不进入历史 | `src/workflow/coordinator/graph.ts`（`buildCoordinatorGraph`）、`src/workflow/coordinator/state.ts`（`CoordinatorGraphState`） | 组装 StateGraph 与状态通道 | 不在节点内复制领域规则 |
| IP-6 | 3.1 | 挂起后前台仍在工作 / 无 Actionable Work 时不唤醒 | `src/workflow/coordinator/nodes.ts`（`modelNode`、`suspendNode`） | 模型节点与挂起节点 | 不重启整图、不使用业务上限替代预算 |
| IP-6 | 3.1 | D15 | `src/workflow/coordinator/nodes.ts`（`modelNode` 的重试与超时选项） | 只在 model node 配置有限重试并关闭内层重试 | 不把 `recursionLimit` 当业务预算 |
| IP-6 | 3.2 | 原生压缩可用时优先使用 / 原生不可用时回退 Capsule | `src/workflow/coordinator/compaction.ts`（`compactWithNativeFirst`、`CompactionPath`） | 原生优先、Capsule 回退的路径选择 | 不颠倒优先级 |
| IP-6 | 3.2 | 一次机械 Shake 作为最后手段 / 无法收敛时显式降级或耗尽 | `src/workflow/coordinator/compaction.ts`（`mechanicalShake`、`CompactionOutcome` 的 `compaction_degraded`/`context_exhausted`） | 无模型调用的机械压缩与显式终态 | 未取得新进展时不得重复 Shake、不静默丢弃对话 |
| IP-6 | 3.2 | 原生压缩项原样往返 / 原生项不可用时阻塞而非降级 | `src/workflow/coordinator/context.ts`（`carryOpaqueNativeWindow`） | 原样保存与携带不透明项 | 不解析或改写其内容 |
| IP-6 | 3.2 | 重新注入上下文 | `src/workflow/coordinator/context.ts`（`reinjectInstructions`、`reinjectToolSchema`、`reinjectAuthoritativeFacts`） | 每次调用按当前配置重新注入 | 不复用被压缩区间的旧副本 |
| IP-6 | 3.2 | Capsule 无法生成时阻塞 / 出现无法安全归类的历史项 | `src/workflow/coordinator/context.ts`（`deriveContextCapsule`、`ContextMaintenanceError`） | 派生 Capsule 或显式阻塞 | 不创建替代 Session、不转移 claim 或 lease |
| IP-6 | 3.2 | Capsule 不成为业务权威 | `src/workflow/coordinator/context.ts`（`deriveContextCapsule` 的输出标注） | 标注为派生视图 | 不写入业务事实或证据 |
| IP-7 | 4.1 | 配置的集成不可用时拒绝启动 / 模型调用不经过 Companion 代理 | `src/adapters/agents/chat-model-factory.ts`（`resolveChatModel`） | 从 Coordinator Model Configuration 构造 chat model 实例 | 不设 allowlist、不保存凭据、不 fallback |
| IP-7 | 4.2 | 缺少 tool calling 时拒绝启动 / 核验通过后才建立 Session | `src/adapters/agents/capability-probe.ts`（`verifyModelCapabilities`） | 五项能力核验，失败即拒绝 | 不降级继续 |
| IP-7 | 4.3 | 模型循环进行中拒绝切换 / 切换后清空旧 cache 与维护计划 / 不做自动模型回退 | `src/application/coordinator/model-config-switch.ts`（`switchModelConfiguration`、`assertSwitchable`） | suspended 且无在途操作时切换，先持久化再清空 cache 与维护计划 | 不中断在途调用、不自动回退 |
| IP-7 | 4.3 | 不兼容的 native window 先迁移 | `src/application/coordinator/model-config-switch.ts`（`migrateNativeWindowToCapsule`） | 迁移成功才继续，失败保持 suspended 或 blocked | 不跨配置强行沿用 native window |
| IP-8 | 4.4 | 配置的集成不可用时拒绝启动 | 修改前驱 `src/bootstrap/doctor.ts` 的 `runDoctor` / `DoctorReport` 与 `src/interfaces/cli/doctor-command.ts` | 在单一 doctor 报告中追加模型能力检查；无 TTY、只读 | 不创建第二个 doctor 模块，不改变 M0 检查与退出码语义，不加载 Ink/React |
| IP-8 | 4.4 | 核验通过后才建立 Session | `src/bootstrap/coordinator-runtime.ts`（`startCoordinatorRuntime`） | 核验通过后创建 store 并建立 Session | 不创建业务权威、不在启动时改 Git |
| IP-9 | 5.1 | 术语迁移（proposal「What Changes」） | `CONTEXT.md`、`AGENTS.md` | 把 Coordinator Profile 术语同步为 Coordinator Model Configuration | 不改动这两个文档的其它内容与其它术语 |
| IP-10 | 6.1 | D19 | `tests/integration/minimax-m3-coordinator-smoke.test.ts`（`coordinatorSmoke`、`collectCacheObservation`） | MiniMax-M3 冒烟：suspend、缩短周期 keepalive、手动 compact、Model Configuration 持久化；缓存命中只记录 | 不把缓存命中写成断言、不在未显式选择时运行、不纳入默认测试 |

## 4. 调用与副作用顺序

启动顺序：读取 Coordinator Model Configuration → 解析 provider 集成并构造 chat model → 执行能力核验 → 打开 checkpoint store → 取 Runtime Lease 与 fencing generation → 注册或解析 Session → 完成前驱 Operation Intent → 进入模型循环。

恢复顺序：取 Runtime Lease（被 fence 即拒绝）→ 读回 Session checkpoint（不可恢复则阻塞，不创建替代 Session）→ 与 coordination store 对账未决 Operation Intent → 投影有界 Actionable Work → 以稳定 WakeBatchId 同步写入 checkpoint → 记录 source admission → 调用模型循环。

挂起与维护顺序：判定无 Actionable Work → 记录 SuspensionState → 结束本次 invoke 并返回控制权 → Controller 继续消费 Delivery 与确定性对账 → 在 lease 与 fencing 有效时按有限 cycle 执行 best-effort 维护；出现 Actionable Work 立即让位，Pause/Cancel 或 lease 失效立即停止。

压缩顺序：判定输入超出有界范围 → 尝试 provider-native 压缩 → 原生不可用则派生 Context Capsule → 仍不足时执行一次机械 Shake → 仍无法收敛则以 `compaction_degraded` 或 `context_exhausted` 结束；随后按当前配置重新注入 instructions、tool schema 与最新权威事实。

配置切换顺序：校验 Session 处于 suspended 且无在途模型操作 → 持久化 checkpoint → 必要时把不兼容的 native window 迁移为 Capsule → 清空旧 cache 与 maintenance 计划 → 装配并核验新配置 → 生效。

失败处理：能力核验失败、配置缺失、lease 被占用、fencing 落后、checkpoint 不可恢复、Capsule 无法生成一律以显式错误或阻塞结束本次调用，不写 checkpoint、不副作用、不降级、不创建替代身份。模型调用重试只覆盖已证明安全的调用，重试计数不跨恢复重置。

## 5. Schema、状态与持久化落实

- 权威归属：Session checkpoint 只保存对话与 loop 进度，以及 Native Compacted Window owner metadata 与可移植 Capsule 两类产物；Session 注册、lease、fencing、intent 与预算仍由 coordination store 持有；Orca、Git、tracker 事实不被复制。
- 表与约束：checkpoint store 使用 LangGraph SqliteSaver 的表结构，写入路径固定为 Git common dir 下的 `checkpoints.sqlite`；两类压缩产物分字段保存且互不损坏。`coordination.sqlite` 通过前驱 migration 机制新增 `wake_admissions`，唯一键为 Scope + Session + WakeBatchId，值只含 source revision 与 admission 状态。
- 事务：图状态每 super-step 同步提交；跨库一致性靠稳定 batch ID 与 source revision 补齐，不伪装跨库原子事务。配置切换先持久化 checkpoint 再清空派生 cache 与维护计划。
- 版本与审计：Session 状态带 schema 版本，校验失败即拒绝读取；恢复使用同一 Scope、Session、Planning Cycle 与预算。
- 保留：checkpoint 保留策略按 Session 显式配置，清理不改变当前图位置与已提交消息语义（D18）。
- 术语：apply 阶段把 `CONTEXT.md` 与 `AGENTS.md` 的 Coordinator Profile 同步为 Coordinator Model Configuration，语义不变。

## 6. 验收证据矩阵

| Requirement/Scenario | IP-ID | 测试文件 | Fixture/前置条件 | 关键断言 | 可运行命令 |
|---|---|---|---|---|---|
| 同一 Scope 内两个 Session 互不可见 | IP-1, IP-5 | `tests/adapters/checkpoint-store.test.ts` | 两个 Session ID，同一临时 store | 各自读回自身消息，互不影响 | `pnpm exec vitest run tests/adapters/checkpoint-store.test.ts` |
| 会话状态不含凭据与业务权威 | IP-1 | `tests/domain/coordinator-session-state.test.ts` | 含凭据字段的候选状态 | 校验被拒绝 | `pnpm exec vitest run tests/domain/coordinator-session-state.test.ts` |
| 并发进程启动同一 Session 被拒绝 | IP-2 | `tests/application/runtime-guard.test.ts` | 已被持有的 lease | 返回拒绝且无写入 | `pnpm exec vitest run tests/application/runtime-guard.test.ts` |
| 被 fence 的迟到进程写入被拒绝 | IP-2 | 同上 | 落后 generation 的调用 | 写入被拒绝，状态不变 | 同上 |
| 恢复不创建新身份 | IP-2 | 同上 | 已有 Session 与已消耗预算 | 复用原身份与预算 | 同上 |
| checkpoint 不可恢复时 fail closed | IP-2 | 同上 | 损坏的 checkpoint | 阻塞且不创建替代 Session、不转移 claim/lease | 同上 |
| 未完整提交的响应不进入历史 | IP-1, IP-6 | `tests/workflow/coordinator-graph.test.ts` | 中途中断的模型调用 | 历史停在最后一个 Committed Model Step | `pnpm exec vitest run tests/workflow/coordinator-graph.test.ts` |
| 挂起后前台仍在工作 | IP-4 | `tests/application/suspension.test.ts` | 无 Actionable Work 的 Session | 状态为可恢复挂起，非完成或取消 | `pnpm exec vitest run tests/application/suspension.test.ts` |
| 挂起是可恢复条件而非进程终止 | IP-4 | 同上 | 挂起后出现新 Actionable Work | 同一 Session 恢复 | 同上 |
| 无 Actionable Work 时不唤醒 | IP-4 | `tests/application/actionable-work.test.ts` | 仅进度、keepalive、无变化对账 | 投影为空，模型不恢复 | `pnpm exec vitest run tests/application/actionable-work.test.ts` |
| keepalive 不推进业务状态 | IP-4 | `tests/application/maintenance-lane.test.ts` | 挂起期间执行一次 keepalive | 无 Wake Batch、无 Committed Model Step、无 transcript、图位置不变 | `pnpm exec vitest run tests/application/maintenance-lane.test.ts` |
| 维护受有限 cycle 与 fencing 约束 | IP-4 | 同上 | lease 失效或达到 cycle 上限 | 维护停止，无无限心跳 | 同上 |
| Actionable Work 抢占维护 | IP-4 | 同上 | 维护进行中出现 Actionable Work | 维护让位，模型以该 batch 恢复 | 同上 |
| Pause 或 Cancel 停止维护 | IP-4 | 同上 | Scope 进入 Pause 或 Cancel | 维护停止且不再发起 keepalive | 同上 |
| Wake Batch 先落盘再恢复 | IP-3 | `tests/application/wake-admission.test.ts` | 一个待准入 batch | 先写 checkpoint 后记 admission | `pnpm exec vitest run tests/application/wake-admission.test.ts` |
| 重复恢复不重复注入 | IP-3 | 同上 | 已提交 batch 后重启 | 历史中该 batch 恰好一次 | 同上 |
| 被取代区间的原始消息仍可恢复 | IP-5, IP-6 | `tests/workflow/context-maintenance.test.ts` | 已派生 Capsule 的 Session | 原始消息可读回，输入只含 Capsule 与保留区间 | `pnpm exec vitest run tests/workflow/context-maintenance.test.ts` |
| 两类产物分开保存 | IP-5, IP-6 | 同上 | 同时存在原生窗口与 Capsule | 分字段保存，互不损坏 | 同上 |
| 重新注入上下文 | IP-6 | 同上 | 压缩后继续调用 | instructions、tool schema 与最新事实按当前配置重注 | 同上 |
| Capsule 不成为业务权威 | IP-6 | 同上 | Capsule 与外部事实不一致 | 权威仍取自外部系统 | 同上 |
| 原生压缩可用时优先使用 | IP-6 | `tests/workflow/compaction.test.ts` | 支持原生压缩的 provider | 走原生路径，不先 Capsule 或 Shake | `pnpm exec vitest run tests/workflow/compaction.test.ts` |
| 原生不可用时回退 Capsule | IP-6 | 同上 | 无原生压缩能力 | 回退 Capsule，不超窗请求 | 同上 |
| 一次机械 Shake 作为最后手段 | IP-6 | 同上 | 原生与 Capsule 都不足 | 执行一次无模型调用的 Shake，不重复 | 同上 |
| 无法收敛时显式降级或耗尽 | IP-6 | 同上 | 各路径均不足以收敛 | 以 compaction_degraded 或 context_exhausted 结束 | 同上 |
| 原生压缩项原样往返 | IP-6 | 同上 | 带不透明项的响应 | 后续请求逐字携带 | 同上 |
| 原生项不可用时阻塞而非降级 | IP-6 | 同上 | 无法再携带且无 Capsule 迁移路径 | 进入阻塞并记录原因 | 同上 |
| Capsule 无法生成时阻塞 | IP-6 | `tests/workflow/context-maintenance.test.ts` | 派生失败的历史 | 阻塞，不创建替代 Session 或转移 claim/lease | `pnpm exec vitest run tests/workflow/context-maintenance.test.ts` |
| 出现无法安全归类的历史项 | IP-6 | 同上 | 未知类型的项 | 阻塞且保持原状 | 同上 |
| 配置的集成不可用时拒绝启动 | IP-7, IP-8 | `tests/adapters/chat-model-factory.test.ts`、`tests/interfaces/doctor.test.ts` | 缺失或不存在的配置 | 非零结果与可操作诊断 | `pnpm exec vitest run tests/adapters/chat-model-factory.test.ts tests/interfaces/doctor.test.ts` |
| 模型调用不经过 Companion 代理 | IP-7 | `tests/adapters/chat-model-factory.test.ts` | 受控的 provider 集成 | 调用直达该实例，无凭据落盘 | 同上 |
| 缺少 tool calling 时拒绝启动 | IP-7 | `tests/adapters/capability-probe.test.ts` | 不支持工具调用的模型 | 拒绝启动并列出缺失能力 | `pnpm exec vitest run tests/adapters/capability-probe.test.ts` |
| 核验通过后才建立 Session | IP-7, IP-8 | `tests/bootstrap/coordinator-runtime.test.ts` | 全部能力通过 | 核验先于 Session 建立 | `pnpm exec vitest run tests/bootstrap/coordinator-runtime.test.ts` |
| 模型循环进行中拒绝切换 | IP-7 | `tests/application/model-config-switch.test.ts` | 存在在途模型调用 | 切换被拒绝，配置不变 | `pnpm exec vitest run tests/application/model-config-switch.test.ts` |
| 切换后清空旧 cache 与维护计划 | IP-7 | 同上 | suspended 且无在途操作 | 先持久化，再清空 cache 与维护计划 | 同上 |
| 不兼容的 native window 先迁移 | IP-7 | 同上 | 新配置不能用旧 native window | 迁移 Capsule 成功才继续，失败保持 suspended/blocked | 同上 |
| 不做自动模型回退 | IP-7 | 同上 | 切换后模型调用失败 | 不切回旧模型、不改投其他模型 | 同上 |
| D15 | IP-6 | `tests/workflow/coordinator-graph.test.ts` | 可重试的模型调用错误 | 重试次数有限且不跨恢复重置 | `pnpm exec vitest run tests/workflow/coordinator-graph.test.ts` |
| 术语迁移 | IP-9 | 无（文档核对） | `CONTEXT.md`、`AGENTS.md` | 文档中不再出现旧术语 | `! rg -n 'Coordinator Profile' CONTEXT.md AGENTS.md` |
| D19：MiniMax-M3 冒烟（suspend / keepalive / manual compact / Model Configuration 持久化） | IP-10 | `tests/integration/minimax-m3-coordinator-smoke.test.ts` | 显式选择的隔离项目与专用身份；MiniMax-M3 已配置；显式开启冒烟开关 | suspend 结束模型 loop 且前台继续；缩短周期 keepalive 在有限 cycle 内且不产生 Wake Batch/Committed Model Step/transcript；手动 compact 得到显式 outcome；Model Configuration 在重启后仍生效 | `COORDINATOR_SMOKE=1 COORDINATOR_SMOKE_REPO=<isolated-project> COORDINATOR_SMOKE_IDENTITY=<dedicated-identity> pnpm exec vitest run tests/integration/minimax-m3-coordinator-smoke.test.ts --no-file-parallelism` |
| D19：真实 prompt cache 命中只作观测 | IP-10 | 同上 | 同一次冒烟调用 | 命中与未命中 SHALL 只写入观测输出，不作为任何断言或门禁条件 | 同上（观测输出，不参与失败判定） |

全量检查：`pnpm typecheck`、`pnpm lint`、`pnpm test`、`openspec validate m1-run-coordinator-sessions --strict`；真实冒烟文件在未设置 `COORDINATOR_SMOKE` 时默认跳过、不产生真实调用，只在显式选择隔离项目与专用身份后单独运行。

## 7. 文件清单与升级条件

新增文件：

- `src/domain/coordinator/session-state.ts`
- `src/application/coordinator/runtime-guard.ts`
- `src/application/coordinator/actionable-work.ts`
- `src/application/coordinator/suspension.ts`
- `src/application/coordinator/maintenance-lane.ts`
- `src/application/coordinator/model-config-switch.ts`
- `src/application/coordinator/wake-admission.ts`
- `src/workflow/coordinator/graph.ts`
- `src/workflow/coordinator/nodes.ts`
- `src/workflow/coordinator/state.ts`
- `src/workflow/coordinator/context.ts`
- `src/workflow/coordinator/compaction.ts`
- `src/adapters/storage/checkpoint-store.ts`
- `src/adapters/agents/chat-model-factory.ts`
- `src/adapters/agents/capability-probe.ts`
- `src/bootstrap/coordinator-runtime.ts`
- `tests/domain/coordinator-session-state.test.ts`
- `tests/application/runtime-guard.test.ts`
- `tests/application/actionable-work.test.ts`
- `tests/application/suspension.test.ts`
- `tests/application/maintenance-lane.test.ts`
- `tests/application/model-config-switch.test.ts`
- `tests/application/wake-admission.test.ts`
- `tests/workflow/coordinator-graph.test.ts`
- `tests/workflow/context-maintenance.test.ts`
- `tests/workflow/compaction.test.ts`
- `tests/adapters/checkpoint-store.test.ts`
- `tests/adapters/chat-model-factory.test.ts`
- `tests/adapters/capability-probe.test.ts`
- `tests/bootstrap/coordinator-runtime.test.ts`
- `tests/integration/minimax-m3-coordinator-smoke.test.ts`

修改文件：`src/application/ports/branch-coordination-store.ts`、`src/adapters/storage/schema.ts`、`src/adapters/storage/coordination-store.ts`（IP-3 的 wake admission migration）；`src/bootstrap/doctor.ts`、`src/interfaces/cli/doctor-command.ts`、`tests/doctor.test.ts`（IP-8 扩展单一 doctor）；`package.json`（新增 LangGraph、SQLite checkpointer 与运行时校验依赖及其脚本入口）、`tsconfig.json`（仅在新增依赖需要额外类型可见性时）、`CONTEXT.md` 与 `AGENTS.md`（IP-9 的术语同步，仅替换 Coordinator Profile 措辞）。

受保护文件（本 change 不得修改）：`openspec/schemas/**`、`openspec/config.yaml`、前驱 change 的全部工件、`references/orca/**`、任何 `m1-plan-and-authorize-execution` 及后续 change 的目录；`CONTEXT.md` 与 `AGENTS.md` 除 IP-9 的术语同步外不得改动。

升级条件：

- 冻结接缝缺失、改名或语义改变 → 停止实施，回到 planning。
- 需要新增本计划未声明的公开 DTO 字段、依赖、持久化路径或事务边界 → 先回到 `design.md`；已声明的 `wake_admissions` migration 属实施范围。
- 需要改动 `CONTEXT.md` 或 `AGENTS.md` 的术语以外内容 → 停止并升级。
- 需要使用本计划文件清单之外的文件 → 先说明理由并更新本计划。
- 命名命令缺失或失败、某个 Scenario 无法满足 → 停止并升级，不自行替换验证方式。
- 需要创建 `verification.md` → 只有实现任务全部完成并固定实现 HEAD 后才允许。

## 8. 验收 Agent 授权与限定审计

验收可执行范围：本 plan 第 6 节全部测试文件、第 7 节新增与修改文件（含 `CONTEXT.md`、`AGENTS.md` 的术语同步）、以及 `pnpm typecheck`、`pnpm lint`、`pnpm test`、`openspec validate m1-run-coordinator-sessions --strict`。允许在范围内修复缺陷并重跑受影响检查。

受保护语义边界（发现问题时应升级而非自行改动）：Session 身份与 checkpoint 线程映射、Runtime Lease 与 fencing 的所有权、维护 lane 的 best-effort 与有界性、WakeBatchId 生成规则、压缩路径优先级与显式终态、Native Compacted Window 的不透明性与 owner metadata、Context Capsule 的派生边界、Coordinator Model Configuration 到 chat model 的绑定与切换时机、真实冒烟允许使用的项目与身份范围。

限定审计标签：`session-identity`、`maintenance-lane`、`wake-batch-id`、`fencing-generation`、`compaction-order`、`capsule-boundary`、`opaque-native-window`、`provider-injection`、`config-switch`、`real-provider-smoke`。命中任一标签的改动必须先给出证据再修改。
