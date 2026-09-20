# Orca Companion — Agent Instructions

本文件是 Orca Companion 的当前开发约束。项目采用 **TypeScript + LangGraph JS + Ink/React TUI**，作为独立的 Coordinator Harness 通过 Orca 调度现有 coding-agent harness。

涉及 Coordinator Session、Execution Graph、Worker、持久化归属或状态转换时，先读根目录 `CONTEXT.md`；其中术语是领域语言的唯一事实源。设计或修改 module、跨 module interface、DTO、adapter、持久化记录、CLI/TUI projection 时，必须再读 `docs/architecture.md` 与 `docs/interface-contracts.md`，按其中稳定合同 ID 核验唯一 owner、canonical path 和调用约束。核对 Orca 命令与已验证能力时，再读 `docs/orca-compatibility.md` 和相关 `docs/research/` 资产。

## 1. 产品边界与优先级

Companion 为范围明确的软件项目提供可恢复、可追踪、有预算上限的协调流程。它只运行 Coordinator Agent；Planner、Implementation、Validator、Finalizer 和 Utility Worker 由 Orca 派发到现有 Worker Harness。

优先级依次是：真实可用的端到端闭环、错误动作受控、维护成本低、未来可迁移、界面完善。项目由个人维护，选择最小模块和现成组件，不建设通用 agent 平台。

首版边界：

- 一个本机 Companion 进程可管理当前 Coordination Scope；Route Planning 可有多个独立 Coordinator Session，Execution Coordination 只有一个 lease holder。
- Execution Coordination 并发上限为 1；每个 Work Package 使用隔离 worktree。
- Coordinator Harness 自己承载 LangGraph agent loop、Coordinator 会话、受控工具和 TUI，不依附 Codex、Claude Code 或 OMP。
- Worker Harness 提供 coding Worker 的模型、认证、代码操作和真实会话；Companion 不重新实现 coding harness、provider gateway、终端模拟器或 worktree manager。
- M0–M2 不提供 headless 执行、后台 controller、远程 attach、无人值守运行或上层机器驱动协议。

## 2. 技术栈与运行基线

- 使用 TypeScript strict、ESM、Node.js 24 和 pnpm；在 `engines`、版本文件与 `packageManager` 中声明实际验证版本并提交 lockfile。
- Coordinator agent loop 使用 `@langchain/langgraph` StateGraph；模型节点面向 LangChain `BaseChatModel`。业务规则保留在普通 TypeScript 模块中。
- Provider integration 由用户安装并通过 `initChatModel` 或 bootstrap 注入；Companion 不设 provider allowlist、不捆绑全部 provider、不保存密钥，也不自动 fallback。`doctor` 必须核验文本、流式、tool calling、取消和可用 usage 能力，缺失必需能力时拒绝启动。
- Coordinator Session 使用 LangGraph SqliteSaver，`durability: sync`；Branch Coordination State 使用独立 SQLite store。
- TUI 使用 `ink@7.1.1`、`react@19.3.0` 和 `@types/react@19.3.0`；TUI 测试可使用 `ink-testing-library@4.0.0`，但其 Ink 7/React 19 兼容性仅有本机验证。
- 边界 DTO、CLI JSON、项目配置和持久化记录必须做运行时 schema 校验；领域类型不得依赖框架运行时对象。
- 测试使用 Vitest，不为覆盖率引入第二套运行器。
- 保持单 npm package；只有实际发布或依赖隔离需要时才拆 package。
- 当前支持声明以 Ubuntu 本机验证为限。Windows 仍是目标平台，但未经验证不得标记为支持。

## 3. 上游源码：`references/orca`

上游 [stablyai/orca](https://github.com/stablyai/orca) 必须以 Git submodule 固定在 `references/orca`。已有 submodule 使用：

```sh
git submodule update --init references/orca
```

提交 `.gitmodules` 与固定 commit 的 gitlink；不得自动执行 `git submodule update --remote`，也不得在安装或启动脚本中更新上游。

`references/orca` 默认只读，仅用于核查接口和实现：

- Companion 代码不得导入上游私有源码或为其建立 TypeScript alias。
- submodule 不进入 workspace、常规 build/lint/test 扫描或发布包。
- 普通 Companion 工作不得修改上游、安装其整套依赖或让发布包依赖该目录存在。
- 不得直接读写 Orca 数据库、调用未公开 RPC 或复制其持久化实现。

源码快照与当前安装的 Orca 可能不同。运行时能力必须通过当前 CLI/runtime 验证，并在 `docs/orca-compatibility.md` 记录 submodule SHA、实际版本、能力和环境。升级 submodule 是独立变更，必须附 adapter 回归结果。

## 4. 模块与依赖边界

本节给出常驻摘要；详细 module、seam、运行组件、依赖图与跨系统流程以 `docs/architecture.md` 为准，字段级公共合同以 `docs/interface-contracts.md` 为准。沿用以下逻辑布局；合并小文件优于创建空壳：

| 路径 | 职责 |
| --- | --- |
| `src/domain/` | Coordination Scope、模式、授权、Execution Graph、预算、Worker 生命周期与状态规则；不依赖 LangGraph、Orca、Ink、进程或数据库。 |
| `src/application/` | Controller 用例、Coordinator 工具 handlers、查询/命令 DTO、ports、准入、对账与意图管理。 |
| `src/workflow/` | Coordinator Agent 的 LangGraph loop、模型/tool 节点、checkpoint 与恢复；调用应用服务，不另建业务状态机。 |
| `src/adapters/orca-cli/` | `ExecutionBackend` 的 Orca CLI transport，含能力探测、进程/JSON、receipt、Delivery 与错误透传。 |
| `src/adapters/agents/` | Coordinator chat-model 组装、Worker Harness/session binding 与结构化交接 adapter。 |
| `src/adapters/storage/` | Branch Coordination Store 与 LangGraph saver；两者分别实现各自契约。 |
| `src/interfaces/cli/` | `status --json`、`doctor` 等一次性无 TTY 命令。 |
| `src/interfaces/tui/` | Ink transcript、composer、sidebar、Graph Inspector 和输入映射。 |
| `src/bootstrap/` | 配置、依赖注入、能力核验与进程生命周期。 |

依赖只指向内层契约。CLI/TUI 只消费快照和事件、提交用户意图；不得自行推进状态、调用 Orca、恢复模型或实现重试。提供不加载 Ink/React、不要求 TTY、不自动启动进程的核心入口，避免 barrel export 意外加载 UI 或数据库。

LangGraph 只拥有 Coordinator Session 的模型循环和对话恢复。Controller 与领域规则拥有准入、状态转换、预算和副作用策略；图节点不得重新启动整张图或复制这些规则。

未来原生集成只替换 adapters 与 UI。领域规则、应用用例、工具 schema 和行为测试应保持可复用；未发生迁移前不预建 native adapter 或兼容历史 runtime。

## 5. Coordinator 工具与应用契约

Agent-visible tools 只提供给 Coordinator Agent。Worker 只接收 Task Envelope，并返回结构化 Worker Result、Worker Question、Worker Escalation 和证据；Worker 不调用 Companion 协调工具。

核心应用契约：

| 契约 | 最小职责 |
| --- | --- |
| `ExecutionBackend` | 通过封闭的 `query` / `mutate` 判别联合查询和控制 Orca。 |
| `BranchCoordinationStore` | 保存共享模式、cycle/graph/authorization 引用、Session 注册、claims、interactions、intents、leases、预算和 CAS revision。 |
| LangGraph checkpointer | 保存单个 Session 的消息、tool steps、图位置、Wake Batch 与 Context Capsule。 |
| `SpecificationProvider` | 检查工具原生 Specification Unit 与角色转换；M1 只实现 OpenSpec。 |
| `ControllerService` | 向 TUI/CLI 提供初始化、查询、暂停、恢复、取消、回答和事件订阅。 |

Route Planning 的语义操作覆盖读取地图/frontier、创建票、设置依赖、领取、解决和按固定章节更新地图。运行协调操作覆盖状态查询、派发、回复 Worker、结算、集成、异步 `ask_user` 与非阻塞 `suspend`。按模式和当前事实动态暴露工具，handler 每次调用仍重验 scope、ownership、revision、权限和预算。

Coordinator 不拥有任意 shell、任意 Orca command/RPC、直接 SQL、通用文件 edit 或无约束状态修改。首版只提供有界 `read`、`search`、`diff` 与专用语义操作。Route Map 写入只作用于配置的地图及直属 Decision Ticket；代码、OpenSpec、项目文档和配置由带 Task Envelope 的 Worker 或用户维护。

所有副作用调用必须具有可信 `ExecutionScope`、稳定 `OperationId`、明确目标、expected revision、超时、可核验结果和 unknown 对账路径。模型和 Worker 不得填写 scope、身份、Run、consumer generation 或 operation identity。

Mutation 结果保留三值语义：

```ts
type OperationOutcome<T> =
  | { kind: 'accepted'; operation: OperationRef; value: T }
  | { kind: 'rejected'; code: string; message: string }
  | { kind: 'unknown'; operation: OperationRef; reason: string };
```

`accepted` 表示 Orca 已记录确定结果，包括确定失败；不表示 Worker 完成、任务通过或项目可交付。只有能够证明未产生副作用时才是 `rejected`。`unknown` 必须以同一 OperationId 对账，禁止换 ID 重试。

## 6. Orca 与 Worker Harness 适配

从当前安装版本的 `--help`、`orca skills get orchestration --full` 和 [Orca CLI 文档](https://www.onorca.dev/docs/cli/reference) 核对命令；不得从旧教程或 submodule 快照猜参数，也不得调用已退役的 coordinator/run 自动调度入口。

- CLI 路径、host/environment、协调身份、Run 和 worktree 显式配置；自动化使用参数数组、`--json` 和明确 selector，不依赖 UI 焦点或 shell 拼接。
- 分离 stdout JSON、stderr 诊断和退出状态；限制输出大小，敏感值不入日志或仓库。
- Adapter 本地 contract mirror 对齐 Orca typed RPC 的字段和值语义，只做 transport/schema 转换，不复制 Orca 状态机。未知控制流枚举或安全必填字段缺失时 fail closed。
- Orca 的 Run、Task、Dispatch、Worker、terminal、receipt 与 Accepted Worker Result 是运行事实。Run 不是调度器，Task 完成也不表示业务验收通过。
- Delivery 必须匹配 Run、consumer generation、Task、Dispatch 与 Attempt；旧代际或旧尝试消息只能补历史和确认，不能推进当前流程。
- Worker liveness 至少保留 `live`、`exited` 与 `unverifiable`；不可达或信息不完整不能推断退出或触发重复派发。
- 禁止伪造 terminal 身份、写 Orca DB 补绑定或使用私有接口绕过能力缺口。

首个 Worker Harness 是 Codex。Planner、Implementation、Validator 和 Finalizer 使用角色隔离 Session；Validator 在同一任务的“验证—范围内修复—复验”内复用同一真实 Session。Finalizer 使用新的只读项目级 Session。精确 Session Binding 由 Worker Harness Adapter 验证，不能按 cwd/mtime 猜最新 transcript，也不能用 terminal 输出冒充 provider transcript。

Worker Session 中断时必须显式记录 Session Segment。需要恢复 Validator 上下文时，由受限 Utility Worker 从精确 transcript 生成 Recovery Capsule；替代 Session 仍属于原 Validation Attempt，并受独立且有限的 Recovery Budget 约束。transcript 不可用或预算耗尽时阻塞，不能伪称保持原会话。

## 7. Route Planning 与 Execution Coordination

Coordination Scope 显式持久化两种模式：`route_planning` 和 `execution_coordination`。暂停、阻塞、取消以及 Replanning Transition 是正交控制状态，不是第三种模式。

### Route Planning

Coordinator Agent 与用户形成并维护 Route Map、Decision Tickets 和 Implementation Plan。用户提供的任何 roadmap、OpenSpec、任务列表或既有计划都只是 Planning Reference；不得直接执行、导入为权威成果或跳过正式规划。

同一 Scope 可有多个独立 Coordinator Session 并行处理不同 Decision Ticket；每个 Session 同时最多持有一个 Ticket Claim。claim 由 tracker assignee 与 Branch Coordination Store 的 Session 级记录共同表达，Runtime 退出不释放 claim。

只有开放票和 fog 均清空、无未决交互或 mutation、Implementation Plan 绑定当前地图 revision、Graph Compiler 接受候选图，且用户批准完整 Execution Authorization Manifest 后，才能进入 Execution Coordination。

### Execution Authorization

Manifest 一次性绑定当前 Destination/地图/计划/Graph Generation、Coordination Scope、baseline HEAD、空 Orca Run、Worker Profiles、权限、预算、workspace、Git/Dependency Policy 和 accepted risks。授权后的普通派发、策略内依赖变更与受控 Git 集成不再逐次审批；发布、部署和越界外部操作仍需单独授权。

### Execution Graph 与 Worker 生命周期

Execution Graph 是 Companion 拥有的版本化逻辑 Work Package DAG，不是 LangGraph，也不是 Orca Task DAG。初始图由正式 Implementation Plan 确定性编译；Compiler 检查 schema、引用、无环、Scope Envelope、预算和可信配置，不评判规划语义。

Work Package 进入 Execution Frontier 后才建立 worktree，并即时物化当前 Dispatch Candidate 的一个角色级 Orca Task。不得预建整图、wave、占位 Task 或容器 Task。Orca Task DAG 只表达已经物化 Worker Tasks 的真实执行因果。

一个 Work Package 的执行生命周期为：

1. Planner Worker 在该 worktree 中编写工具原生 Specification Unit；
2. Specification Admission 做确定性结构检查，可选独立 Specification Validator；
3. Implementation Worker 实现并提交可核验交接；
4. Validator 独立验证，可在授权范围和修复预算内直接修复并复验；
5. 所有 Work Package 通过后，Finalizer 只读检查整个项目并给出 Delivery Verdict。

Implementation 完成、Validator 通过和项目可交付是三个不同事实。Worker 通知与报告只是候选结果；Controller 校验 Task/Dispatch/Attempt、角色、版本、worktree、权限、预算和证据后，才记录 Accepted Worker Result 并推进生命周期。

Validator 接受结果后，Execution Coordination Lease holder 才可按 Execution Authorization 中的 Git Integration Policy 创建普通 commit、集成 canonical branch 并推送唯一获批 remote/ref。force-push、历史改写、发布和部署不在默认权限内。

Graph Patch 采用原子的 `add + revise + retire`：

- `add` 创建新的 Patch Work Package、WorkPackageId 和 worktree；
- `revise` 为尚未接受的同一 Work Package 追加 Graph Revision，保留 WorkPackageId 与 worktree；
- `retire` 只移出尚未接受的节点，并保留历史。

历史 GraphVersion 不改写。Specification Revision 只改变同一 Work Package 的 contract content；Retry Attempt 保持 WorkerTask/contract/revision 不变，只创建新 Dispatch/Attempt。已派发 Worker 遇到 revision request 时进入 `revision pending`，运行至可核验终态后再修订，不因修订意图直接杀死。

默认最多 8 个 active Work Package、每包 2 次实现尝试、2 次 Validator 修复、2 次 Graph Revision 和每包 2 次 Specification Revision，并发 1；配置可调整但必须有限。重启、恢复、Patch 或重规划不得重置已消耗预算。只有实际取得 usage 时才报告费用。

### Replanning

目标或全局约束变化、既有成果需重审、图无法在修订预算内表达变化，或用户明确要求时，进入 Replanning Transition。停止新派发，结清在途 Worker、Delivery、Pending Interaction 和 Operation Intent，再释放 Execution Coordination Lease 并建立新的 Planning Cycle。

新规划产生新的 Graph Generation、GraphId、Orca Run、WorkPackageId 和 worktree。Generation Cutover 前旧图可在对账后恢复；Cutover 后前代图永久冻结。旧成果只可按 Baseline Adoption、Migration Material 或 Planning Reference 规则进入新规划，不能复制旧完成状态。

## 8. 状态权威、持久化与恢复

不要保存第二份完整工作流状态机。权威归属固定为：

- Route Map 与 Decision Ticket：issue tracker；
- Worker Profiles 与 Coordinator Model Configuration、预算上限和长期策略：版本化项目配置；
- 代码、branch、HEAD、worktree 和 dirty paths：Git 与 Orca；
- Run、Task、Dispatch、Worker、Delivery、receipt、Task Envelope 与 Accepted Worker Result：Orca；
- Execution Graph：初始 Implementation Plan 与连续 Accepted Graph Patch Results 的追加历史；
- Branch Coordination State：Companion 不能从以上来源重建的共享协调事实；
- Coordinator Session State：该 Session 的 LangGraph checkpoint。

在 Git common dir 的 Companion 私有目录使用两个独立 SQLite store：

- `coordination.sqlite` 保存模式、Planning Cycle、当前 graph/authorization 引用、Session 注册、Ticket Claim、Pending Interaction、Operation Intent、Runtime/Execution lease、fencing、共享预算状态和 CAS revision；
- `checkpoints.sqlite` 由 LangGraph SqliteSaver 保存每个 Session 的已提交消息/tool step、图位置、Wake Batch、Context Capsule 和 Coordinator Model Configuration binding。

不同 Coordinator Session 不共享 checkpoint。同一 Session 同时只有一个 Runtime Incarnation；短 Runtime Lease 和递增 fencing generation 拒绝迟到进程写入。Execution Coordination 只有一个 Session 持有 Execution Coordination Lease。SQLite 事务保持短小，不使用项目级长期单写者锁。

副作用前先持久化 Operation Intent，再执行外部 mutation，最后写后核验并完成 intent。外部响应丢失、receipt 缺失或 transport 故障不证明动作未发生；恢复时以原 OperationId、scope、receipt 和实时资源对账，仍不确定则阻塞对应 mutation lane。

Delivery 处理顺序固定为：读取但不 ack → 校验身份与版本 → 去重 → 写入对应权威事实或本地记录并回读 → ack。不得先确认再落业务结果，也不建立复制所有来源的通用 inbox。

Coordinator 无可执行工作时调用 `suspend`，结束模型 loop 但不停止前台 Controller、Worker 和确定性对账。Controller 从 durable Actionable Work 推导是否恢复模型；普通进度、keepalive、长轮询超时和无变化对账不唤醒模型。

恢复模型前，Controller 获取 Runtime Lease，收集有界 Actionable Work，以稳定 WakeBatchId 同步写入 checkpoint，再记录 source admission。Branch Coordination Store 与 checkpoint store 不伪装跨库原子事务；崩溃后按稳定 source revision 和 batch ID 补齐，已提交 batch 不得重复注入。

LangGraph checkpoint、SQLite 和 Orca receipt 都不提供跨系统 exactly-once。自动重试只用于已证明安全的模型调用或操作；`recursionLimit` 只是高位技术保险，不能替代业务预算。恢复必须沿用原 Scope、Session、Graph Generation、Run、Worker 关系和预算。

## 9. TUI、CLI 与生命周期

发布命令为 `orca-companion`：

- `orca-companion [repository-path]` 启动前台 TUI；Home 选择现有 Scope，或通过最小向导核验 repository、branch、canonical worktree、Coordinator Model Configuration、tracker 和 Orca 能力后创建 Scope。
- `orca-companion status [--json]` 执行一次性只读查询。
- `orca-companion doctor` 检查环境与能力。

不提供 `run`、`resume`、`tui` 或 headless 子命令。启动 TUI 前同时检查 stdin/stdout TTY；无 TTY 时以非零状态明确拒绝。`status --json` 与 `doctor` 必须无 TTY 可运行，机器输出只写 stdout，诊断写 stderr。

初始化只建立 Scope、Planning Cycle 与首个 Coordinator Session；Worker Profiles、预算、依赖权限、Git 集成和 accepted risks 留给 Execution Authorization Manifest。

TUI 以选中 Coordinator Session 的 transcript 与 composer 为主视图。右侧响应式 sidebar 展示 Scope 状态、预算、紧凑 Execution Graph、Worker、blocker 和待处理交互；窄屏折叠或改为 overlay。全屏 Graph Inspector 只用于检查、选择与导航。

Transcript 只显示用户/Agent 消息和折叠 tool 记录；运行事实进入 sidebar，语义事件进入 Event Drawer，诊断噪声只进日志。Pending Interaction 以内联卡片显示，回答 composer 必须绑定 interaction ID 与 expected revision；普通聊天不能满足待答问题。

最小全局键位为 `Ctrl+P` 打开 Command Palette、`Ctrl+B` 切换 sidebar、`Ctrl+G` 打开 Graph Inspector、`Esc` 逐层关闭 overlay，方向键与 Enter 用于导航。Session Picker 和新事件不得自动切换 transcript、抢占 composer 或改变 Scope 级 Graph；M2 不实现自定义键位。

Pause、Resume 和 Cancel 都作用于整个 Coordination Scope：

- Pause 停止新的模型恢复和 Worker 派发，但不停止已运行 Worker、事件落盘和对账；
- Resume 先对账，再恢复调度；
- Cancel 先保存意图，再停止模型并请求 Worker 停止，结果未确认时保持 `cancelling` 或 `unverifiable`；
- Exit 与 `Ctrl+C` 只退出 TUI/Controller，不隐式暂停或取消；活跃 Worker 可能继续运行，之后恢复时必须对账。

组件 render/effect/resize/重挂载不得触发模型恢复、Worker 派发、重试或持久化。状态不能只靠颜色表达；动态效果只用于 spinner、短暂状态高亮和一次 attention。当前 Ubuntu 验收覆盖中文输入/粘贴/混排、宽字符裁切、resize、Command Palette、确认流程和终端恢复，不建设 i18n 系统。

## 10. 里程碑

### M0：固定并实现已验证的 Orca 控制基线

公开接口可行性硬门已经通过；stable pane、单 Worker 闭环和无重复恢复已有真实探针证据，provider transcript 仍由 Worker Harness Adapter 做精确绑定。产品实现须完成 Orca CLI Adapter 与 `doctor`，固化能力探测、身份/Run/consumer 绑定、Task/Worker/Delivery/receipt 和 unknown 对账契约。集成验证只在隔离的一次性项目和专用身份中运行；不得默认使用用户主项目、重启全局 Orca runtime 或修改上游。

### M1：跑通有界协调闭环

实现 Branch Coordination Store、Coordinator Session checkpointer、LangGraph 原生 loop、受控工具、Route Planning、Execution Authorization、Execution Graph、即时 Task 物化、Codex Worker Harness 和串行执行。跑通规划、规格、实现、Validator 同会话修复、Finalizer、恢复、Patch/Revision 与 Replanning；先用 fake backend 验证故障路径，再用真实 Orca 验证必要契约。

### M2：提供前台 TUI

实现 Home/初始化、transcript/composer、Session Picker、响应式 Graph sidebar、Graph Inspector、Event Drawer、Pending Interaction 和 Scope 级暂停/恢复/取消。补齐真实 PTY、无 TTY 拒绝、中文/resize、退出恢复和当前 Ubuntu 使用说明。

### M3：按使用结果扩展

串行流程稳定后再评估并行 Worker、多 Worker Harness、后台 controller、remote attach、Windows 支持或上游原生集成。届时先解决写入隔离、控制链路和集成验收，不以预建基础设施证明项目价值。

## 11. 验证与完成标准

建立可运行的 typecheck、lint、test、build 脚本，只验证 Companion；常规检查不构建整个 Orca submodule。测试稳定、可观察的行为边界：

- 非法模式/阶段、stale revision、错误 scope、无效 claim/lease、fencing、预算耗尽和授权失效；
- mutation 已接受但响应丢失、intent 完成前崩溃、Delivery ack 前后重启、schema 漂移和 backend 暂时不可达；
- 原 Session/Run/Graph 恢复不重复派发，Wake Batch 不重复注入，取消后的迟到事件不重新激活当前代际；
- Graph 编译、即时物化、Patch/Revision/Retry 边界、Validator 修复与证据失效；
- 不少于 100 个互不相同的连续 Coordinator 工具调用不会被固定 step 上限误停；
- CLI Adapter 的 contract/error 透传，发布包在不含 `references/orca` 的目录仍可安装并加载核心；
- TUI 重绘无副作用、关键键位正确映射、真实 PTY/CJK/resize/终端恢复；TUI 无 TTY 时在挂载 Ink 前以非零状态拒绝，`status --json`/`doctor` 无 TTY 可运行。

行为测试优先，不镜像实现状态机，不精确断言大段文案、整屏 snapshot、内部调用顺序或易变格式。真实集成测试必须显式选择隔离项目。

交付时说明修改、验证命令、结果、未验证平台/恢复路径和剩余风险。未验证的无人值守、跨平台或原生迁移能力不得写成既成事实。

## 12. 开发纪律

- 先读当前代码与对应领域词汇；搜索上游时限制到实际入口和测试，避免扫描整个 submodule。
- 优先删除、复用和合并；类型与模块只服务当前闭环，不使用 `any`、宽泛异常或散落的 backend 特判掩盖协议差异。
- 保留用户改动，使用小而可审查的 patch。普通任务不创建 fork、不提交上游 PR、不发布包、不升级 submodule。
- 若需要上游能力，先整理最小接口、复现和 contract test，作为独立变更；Companion 业务规则不得进入私有上游补丁链。
- 维护重点是 Coordinator 策略、工具契约、恢复和验收。上游覆盖重叠能力时优先替换基础设施，同时保留本项目的策略与行为测试。
