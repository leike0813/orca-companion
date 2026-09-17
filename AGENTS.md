# Orca Companion — Agent Instructions

本文件是 Orca Companion 仓库的开发约定与启动说明。项目采用 **TypeScript + LangGraph JS + Ink/React TUI**，先作为独立应用通过 Orca CLI 工作，并保留将流程核心迁入 Orca 原生功能的能力。

## 1. 项目目标与优先级

为范围明确的小型软件项目提供可恢复、可追踪、有预算上限的开发流程，减少维护者的逐轮调度。Orca 负责工作区与 agent 执行；Companion 负责项目计划、调度规则、验收与恢复。

优先级依次是：真实可用的端到端流程、错误动作受控、维护成本低、未来可迁移、界面完善。项目由个人维护，默认选择小模块和现成组件，不以构建通用 agent 平台为目标。

必须支持的核心流程：较强的 planner 制定任务与验收标准，implementation agent 实现，较强的 validator 检查；发现可在当前任务范围内修复的问题时，由 validator 在自己的现有会话中直接修复，再验证，次数受限。不要默认把问题反复交回原 implementation agent。

首版聚焦单项目、单机 controller、串行任务和可交付代码。复用已有 coding harness 的模型接入、认证、代码操作与会话能力；不重新实现 provider 网关、上下文压缩、终端模拟器、worktree 管理器或通用工作流编辑器。

## 2. 技术栈与运行基线

- 使用 TypeScript strict、ESM、Node.js 24 和 pnpm；在 `engines`、版本文件与 `packageManager` 中声明实际验证的版本，提交 lockfile。
- 使用 `@langchain/langgraph` 实现显式流程图、检查点和恢复。LangGraph 是执行机制，业务规则保留在普通 TypeScript 模块中。
- TUI 使用 Ink + React。初始化时核查 npm 已发布的稳定版本、`engines` 和 `peerDependencies`，选择兼容组合；不要将仓库主分支的 upcoming API 当成已发布功能。参考 [Ink 官方说明](https://github.com/vadimdemedes/ink)。
- 工具输入、CLI 输出和持久化数据在边界处做 schema 校验，可使用 Zod。领域类型不得依赖框架的运行时对象。
- 测试以 Vitest 为主，TUI 的关键输入与展示可用 [ink-testing-library](https://github.com/vadimdemedes/ink-testing-library)。避免为小项目引入多套测试运行器。
- 首版使用一个 npm package 和清晰的目录边界。只有实际发布或依赖隔离需要时才拆 monorepo/package。
- Windows 11 与 Ubuntu 是目标环境。分别验证进程调用、路径、终端输入与持久化依赖；没有验证的平台不得标记为已支持。

## 3. 上游源码：`references/orca`

上游为 [stablyai/orca](https://github.com/stablyai/orca)。必须使用 Git submodule，路径固定为 `references/orca`，不能用复制目录、subtree 或运行时下载替代。

新仓库尚未添加时，在根目录执行：

```sh
git submodule add https://github.com/stablyai/orca.git references/orca
```

已有 submodule 时使用 `git submodule update --init references/orca`。提交 `.gitmodules` 与固定 commit 的 gitlink；若该目录已有内容或配置不符，先检查差异，不覆盖现有工作。不要自动执行 `git submodule update --remote`，也不要在安装或启动脚本中偷偷更新上游。

`references/orca` 默认只读，用于理解接口、核查实现和准备未来贡献。禁止：

- 从 `src/` 静态或动态导入该目录的私有代码，或把其源码路径设为 TypeScript alias。
- 把 submodule 纳入 Companion 的 workspace、常规构建、lint、测试扫描或发布包。
- 为完成 Companion 的普通功能顺手修改上游、安装上游整套依赖，或让发布后的 Companion 依赖此目录存在。
- 直接读写用户的 Orca 数据库，绕过 CLI 使用未公开的 RPC，或复制 Orca 的内部持久化实现。

在 `docs/orca-compatibility.md` 记录 submodule SHA、实际 Orca CLI/runtime 版本、命令能力和验证环境。**源码快照与正在执行的 Orca 可能不同版本**；运行时能力必须通过当前安装版本验证。升级 submodule 是有明确目的的变更，应附相关 adapter 回归结果。

## 4. 模块边界与未来迁移

采用下列逻辑布局，可随实际规模合并小文件，不提前创建空壳模块：

| 路径 | 职责与依赖边界 |
| --- | --- |
| `src/domain/` | 任务、阶段、策略、预算、验收证据与状态转换；不导入 Orca、LangGraph、Ink、React、进程或数据库实现。 |
| `src/application/` | 项目命令、查询、工具 handlers、用例和 ports；组合领域规则，校验动作，管理操作意图。 |
| `src/workflow/` | LangGraph 图、节点、检查点接入和恢复；调用应用服务，不把图节点变成另一套业务规则。 |
| `src/adapters/orca-cli/` | 唯一的 Orca CLI 进程调用与响应转换入口，处理版本、scope、身份、收据和事件。 |
| `src/adapters/agents/` | 接入实际使用的 coding harness、结构化交接与会话续用；可组合执行后端，不另造模型平台。 |
| `src/adapters/storage/` | Companion 状态、操作记录和 LangGraph saver 的具体存储适配。 |
| `src/interfaces/cli/` | 无界面命令与机器可读输出。 |
| `src/interfaces/tui/` | Ink 组件、输入映射、只读状态展示。 |
| `src/bootstrap/` | 配置、依赖注入、进程生命周期与实现组装；具体 adapter 只能在此类入口组装。 |
| `tests/`、`docs/`、`references/orca/` | 验证、设计与兼容性记录、只读上游源码。 |

依赖指向内层契约。领域策略不得依赖具体 adapter；CLI 与 TUI 不能自行推进状态、执行 Orca 命令或实现业务重试。提供不加载 Ink/React、不要求 TTY、不自动启动进程的核心入口；禁止 barrel export 意外加载 UI 或数据库。

`ControllerService` 通过应用层定义的最小 `WorkflowEngine` port 驱动图，LangGraph 实现由外层注入；应用层不能反向导入具体 workflow 模块。图节点调用的业务 handlers 不得再次启动或恢复整张图。同一项目的命令与后端事件串行处理，避免入口之间互相重入。

可迁移性的验收标准是：更换后端与 UI 后，领域规则、应用用例、工具 schema 和行为测试可以复用。未来原生集成可用 Orca 认可的内部服务实现同一 port；当时再核对身份、收据、存储与生命周期语义，不提前添加无法验证的 native adapter。

Ink 组件不承诺直接搬进 Orca GUI。LangGraph、SQLite 驱动和 Node 专属依赖必须隔离；嵌入前重新核查 Orca 的 Electron、Node 与 headless runtime 构建边界，不能因独立版在 Node 24 可运行就假定全部上游 runtime 兼容。不要为了尚未发生的移植，让独立版同时兼容所有历史运行时。

## 5. 工具与后端契约

区分 **agent 可见工具**、**应用服务**、**执行后端**。agent 提议动作，应用服务校验并执行；底层 CLI 参数不直接成为 agent 的可选项。

初始需要的契约如下。名称可调整，职责与语义必须保留；不要实现与当前用例无关的通用插件协议。

| 契约 | 最小职责 |
| --- | --- |
| `ExecutionBackend` | 能力查询、绑定执行 scope、派发、查询执行状态、读取/发送消息、确认事件、请求停止及对账。 |
| `DecisionAgent` | 请求计划或受约束决策、提交结构化结果、说明真实会话续用能力；复用已有 harness。 |
| `WorkflowStore` | 保存 Companion 自身的状态与操作意图，支持恢复所需的版本检查；不镜像整个 Orca 数据库。 |
| `WorkflowEngine` | 接受启动/恢复等流程意图，隔离 LangGraph 的调用与恢复参数；不重复实现领域策略。 |
| `ControllerService` | 向 CLI/TUI 暴露启动、查询、暂停、恢复、取消与事件订阅；同一命令只有一份业务实现。 |

所有跨边界参数与结果使用可序列化 DTO。后端 Run、Task、Dispatch、terminal 和 provider session 标识在 adapter/binding 中保存为不透明引用；Companion 自己的项目、任务、尝试标识不能依赖某种 Orca 枚举或 ID 格式。

agent 工具使用显式 schema、说明和结构化错误。例如：

| 工具意图 | 行为边界 |
| --- | --- |
| `get_project_state`、`get_task_context` | 返回当前允许动作、任务依赖、预算、证据引用与工作区信息。 |
| `submit_plan` | 提交待验证的任务数据与验收标准，不提交可执行代码或任意图定义。 |
| `request_task_action` | 动作为有穷枚举，由当前阶段、角色、依赖、任务版本与预算共同决定是否允许。 |
| `report_validation` | 提交验收证据与发现；最终是否通过由策略和实际检查结果共同决定。 |
| `request_user_decision` | 记录明确缺失的输入及可恢复的阻塞状态，不通过无上限聊天循环等待。 |

按最小闭环逐项实现，不要求一次提供所有工具。首个 harness 若无法直接注册这些工具，可使用经 schema 校验的结构化产物或消息进入同一 handler；不要通过猜测终端自然语言来推进状态。工具传输层可日后增加 MCP，业务 handler 不依赖 MCP。

每个会产生副作用的调用必须具有：可信调用上下文、明确目标、稳定操作 ID、预期状态版本、超时、可核验结果，以及不确定结果的查询路径。项目 scope、身份和预算来自 controller，不能信任模型自行填写的值。

副作用结果至少区分以下语义，不能统一压成 `success: boolean`：

```ts
type OperationOutcome<T> =
  | { kind: 'accepted'; operation: OperationRef; value: T }
  | { kind: 'rejected'; code: ErrorCode; message: string }
  | { kind: 'unknown'; operation: OperationRef; reason: string };
```

这是语义示例，`OperationRef` 与错误集合在实现时定义。`accepted` 只表示操作已被确认接受，不表示 worker 已完成或任务已通过；持续执行状态由查询与事件给出。`unknown` 必须先对账，不能直接换 ID 重试。错误需区分输入不合法、阶段不允许、scope 错误、旧尝试、能力缺失和后端不可达。

禁止向调度 agent 暴露任意 `orca_command(string)`、任意 RPC、直接 SQL 或无约束的状态修改工具。外部 Companion 只能强制约束经过自身接口的动作；若现有 harness 仍可直接调用 Orca，则其权限限制不能仅靠 prompt 宣称成立。记录该边界，检测外部状态漂移，无法安全对账时进入阻塞状态。

## 6. Orca CLI 适配规则

从实际安装版本的帮助、`orca skills get orchestration --full` 和 [Orca CLI 文档](https://www.onorca.dev/docs/cli/reference) 核对命令。不要从本文件、旧教程或其他版本的源码猜参数。不要依赖已退役的旧 coordinator/run 自动调度命令。

- CLI 路径、host/environment 和工作区显式配置；可执行名允许平台差异。自动化优先使用受支持的 `--json` 与明确 selector，不能依赖当前 UI 焦点或默认本地 host。
- 统一封装跨平台进程调用，以参数数组传递输入，禁止把模型文本拼接成 shell 命令；Windows launcher 如需特殊处理，只放在经过测试的进程适配器中。
- 区分 JSON stdout、诊断 stderr 和退出状态，限制输出大小并对未知 schema 明确报错。敏感参数不写日志，不将认证信息存入仓库。
- Run 是跟踪与通信范围，不等于已有调度器。Companion 保存自己的业务阶段；Orca Task 的执行完成不自动表示项目验收通过。
- 启动时核验真实可用的 coordinator 身份、runtime、Run、worktree 和 consumer 绑定。不能假定一个普通后台进程天然拥有无终端的调度权限。
- 禁止伪造 terminal 身份、写数据库补绑定或借私有接口绕过缺失能力。接口不足时记录最小缺口；是否修改上游应作为单独任务。
- terminal handle 可能随 runtime 重启失效，必须重新解析并核对映射。保留 provider session 引用；复用 terminal 不等于恢复同一个模型会话。
- 事件必须匹配当前项目、任务和 dispatch/attempt；旧 worker 的迟到完成消息不能覆盖新尝试。
- 执行存活状态至少区分 `live`、`exited` 与 `unverifiable`。网络断开、host 未覆盖或终端查询不完整时不能判定已退出，更不能据此重复派发。

首个适配目标是一个实际可用的 Orca+harness 组合。先验证它，再增加其他 harness；能力报告应明确支持、缺失和未验证，禁止静默降级成不同语义。

## 7. 工作流、角色与验收

首个流程为固定图，任务与依赖是数据：

1. **接收需求**：记录范围、交付物、验收标准、允许的仓库/工作区、运行预算和既有授权。
2. **制定计划**：planner 提交结构化任务；确定性代码检查依赖无环、任务数、范围与可执行验收条件。
3. **实现任务**：仅派发依赖满足的任务；首版并发上限为 1，同一工作区只有一个写者。
4. **验证任务**：validator 获取目标工作区、变更、需求、验收命令和实际执行证据。
5. **修复并复验**：范围内缺陷由当前 validator 会话直接修复；修复次数耗尽、范围扩张或必要能力不足时进入明确阻塞状态。
6. **项目验收与交付**：执行项目级检查，生成交付说明、验证结果、未解决项与产物位置。

将“实现结束”“验证通过”“项目可交付”分开。业务状态至少能表达待执行、执行中、验证中、修复中、阻塞、通过和取消；运行暂停作为独立的控制状态。LangGraph 的节点、边和路由调用领域规则，不允许模型任意跳转或直接标记通过。

调度 agent 负责计划和受约束判断；工具权限、状态转换、重试次数、并发和预算由代码强制执行。工具 schema 校验通过不意味着业务动作合法，每次副作用前仍需核验当前状态。

默认每个任务最多自动修复 2 次，可配置但必须有限。另设项目任务数、运行时长、执行尝试数和并发上限。业务修复与网络重试分别计数，重启或恢复不得重置预算。只有实际获得用量数据时才报告费用；缺少计费信息时使用次数/时长限额，不能伪称已精确限制金额。

会话续用需要实际的 harness 支持与验证。LangGraph 的 `thread_id` 不是模型 session ID。若 validator 会话失效，显式记录中断，并按预设策略恢复或阻塞；不得启动新会话后声称保持了原上下文。

交接内容应包括需求与限制、验收标准、仓库/worktree 引用、变更基线、关键文件、测试结果、已知问题和尝试记录。摘要帮助定位，不能代替 agent 访问真实代码、diff 与工具的能力。

验收证据应包含命令、运行位置、结果、时间及对应代码版本；对未提交修改记录可识别的工作区状态。validator 修复代码后，旧证据必须失效并重新验证。不能只凭 worker 的“已完成”、模型评分或通过 lint 判定功能完成。

用户已授权的范围内自动推进，不为普通步骤反复加审批。需求不清、越界变更、预算耗尽、身份无法核验或动作结果无法判定时，保存状态并提出具体问题。提交、合并、发布或部署按已有授权策略执行；项目完成不自动扩大对外操作权限。

## 8. 持久化、重启与副作用

检查点只解决图执行状态的持久化。节点重入、恢复和进程崩溃仍可能重放外部调用；不能宣称 LangGraph 自动提供跨系统的 exactly-once。实现前阅读 [LangGraph durable execution](https://docs.langchain.com/oss/javascript/langgraph/durable-execution) 与 [persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)。

- M1 必须选定阶段与预算的唯一权威状态源，并记录它与 LangGraph checkpoint 的映射及崩溃恢复顺序；禁止 UI、工具 handler、图节点和自建数据库各自推进同一状态。
- 首版持久化优先采用本地 SQLite 与适用的已维护 LangGraph saver。具体驱动留在 storage adapter，核查 Windows/Linux 安装与 Node 兼容性；不为未来移植提前自制复杂 checkpointer。MemorySaver 仅用于测试或明确的一次性演示。
- 在发出副作用前持久化操作意图及稳定请求标识。adapter 优先复用 Orca 现有的请求收据与重放机制；Companion 只保存意图与映射，不再复制一套 Orca 收据权威源。
- 外部已接受、但本地尚未保存结果时崩溃，恢复后必须用原身份、scope 与请求标识查询。收据缺失不证明动作没发生；不确定时检查实际执行，仍不确定则阻塞。
- 先持久化收到的事件及去重键，再确认消费；处理中的阶段变更与后续副作用也必须可重放去重。避免“先 ack 后落盘”丢消息，也避免“先派发后保存操作 ID”重复启动。
- 相同项目只允许一个 controller 写者。首版用可靠的跨进程互斥并拒绝第二实例；进程内 mutex 不够。不提前实现多机 leader 选举。
- 恢复使用原工作流 ID，并对账已有 worker、未决操作、消息与预算；不能把 `resume` 实现为新建一套 Run 和 worker。
- 持久化记录带 schema 版本。变更需要简单、可验证的迁移或明确的不兼容处理，禁止静默丢弃未完成项目。

LangGraph 的自动重试只用于已经证明安全的操作。`recursion_limit` 不能替代业务预算；图暂停也不会自动停止外部 worker。

## 9. TUI、CLI 与运行生命周期

发布入口建议为 `orca-companion`，不要占用 `orca` 命令名。优先完成 `doctor`、`run`、`status` 和 `resume` 的最小 CLI，再提供 `tui`、`pause`、`cancel` 等对应能力。只有实际实现的命令才写入用户文档。

TUI 展示项目/任务阶段、当前角色、运行预算、验证结果、最近日志和待处理问题。组件只消费快照/事件并提交用户意图；禁止在 render、effect 或重挂载过程中触发 worker 启动、重试或状态持久化。

CLI 与 TUI 使用同一 ControllerService。`--json` 输出保持可解析，日志走 stderr；无 TTY 时不启用 raw mode。关键信息不能只靠颜色区分，检查中文、窗口缩放、粘贴、Ctrl+C 和退出后终端恢复。

明确区分以下行为：

- **暂停**：停止新的调度，现有 worker 是否继续必须清楚展示。
- **取消**：保存取消意图，向后端请求停止并核实结果；不可达时保留未确认状态。
- **关闭 TUI/前台退出**：保存恢复信息并说明仍在执行的 worker；不能隐式等同于取消。

首版允许 controller 与 TUI 同进程，以模块边界保持可替换性。未实现独立后台 controller 前，不承诺退出前台后还能继续调度；持续运行可先用明确说明的 headless 前台模式与进程托管。

远程无人值守必须在真实部署方式下验证控制链路。SSH 中 worker 仍活着，不代表其 Orca CLI 控制连接仍可用；不能仅凭 PTY 存活宣称客户端断开后流程仍会推进。

## 10. 启动步骤与里程碑

接到启动项目的任务后，先读本文件与现有代码，检查工作区变更，在已授权范围内实现并验证。不要停留在生成更多计划；也不要覆盖用户已有文件来强行套目录。

### M0：证明独立控制接口可行

1. 初始化最小 TypeScript 工程与 submodule，记录基线；先检查现有结构再添加依赖。
2. 实现 CLI 进程 adapter 和 `doctor`，核验 CLI/runtime、scope、协调者身份、JSON、事件/收据与会话能力。
3. 在隔离的测试项目中完成：真实身份绑定 Run → 派发一个小任务 → 读取状态/结果 → 持久化并确认事件 → 重启 Companion → 找回同一 Run/执行，且不重复派发。
4. 把实际命令、版本与限制写入 `docs/orca-compatibility.md`。如果身份或控制接口不支持该模式，给出可复现的最小阻塞和所需接口，不伪造成功，不继续堆完整 TUI，也不擅自转为深度 fork。

### M1：跑通一个有界开发闭环

实现应用契约、固定 LangGraph 流程、持久化与串行调度；接入一个真实 harness。跑通计划、实现、验证、validator 同会话修复、复验和交付，并证明重启后预算与执行关系不丢失。

先用 fake backend 验证状态转换和故障路径，再以真实 Orca 做必要集成验证。不要以 fake backend 成功替代实际兼容性证明。

### M2：添加可用的 TUI 与运行控制

基于已经可独立运行的 ControllerService 增加 Ink 界面、暂停/恢复/取消和清晰的日志/证据展示；补齐目标平台验证与实际使用说明。

### M3：根据使用结果扩展

只有串行流程稳定后，再评估多任务并行、多 harness、后台 attach 或上游集成。并行前必须解决写入隔离和集成验收。每个里程碑核查相关上游变化；上游覆盖某项能力时优先复用，保留项目策略、验收案例与 adapter 测试，不为证明独立项目有价值而重复维护基础设施。

## 11. 验证与完成标准

建立实际可运行的 typecheck、lint、test、build 脚本，验证本仓库即可；无需把整个 Orca 上游构建作为每次检查的前提。重点测试会改变行为的边界：

- 非法阶段、旧计划/尝试、错误 scope、重复事件、预算耗尽、暂停和取消竞态。
- 派发已成功但响应丢失、本地保存前崩溃、事件确认前后重启、host 暂时不可达、CLI schema 变化。
- 同一 Run 恢复不重复执行，validator 修复不无故换会话，取消后迟到事件不能重新激活任务。
- CLI adapter 的契约与错误映射，以及在不含 `references/orca` 的隔离安装目录中，发布包仍可安装、核心仍可加载。
- 无 TTY 核心运行、TUI 重绘不触发副作用，以及关键键盘命令到应用服务的映射。

以行为断言为主，不用大量镜像实现的测试或整屏快照制造覆盖率。真实集成测试必须显式选择隔离项目，不能使用用户主项目作为默认测试环境。

提交工作时说明实现了什么、如何验证、哪些平台/恢复路径尚未验证，以及剩余阻塞。对齐当前里程碑；未验证的“无人值守”“跨平台”“可原生迁移”不能写成既成事实。文档与代码保持一致，设计决策只记录有实际取舍的内容。

## 12. 开发纪律与范围控制

- 优先读取实际用到的上游入口与测试，搜索默认限制在 Companion 代码或明确的参考路径，避免扫描整个 submodule。
- 类型与模块优先服务当前闭环；不使用 `any` 或宽泛异常吞掉协议差异，不用到处存在的 `if (backend === 'orca')` 破坏抽象。
- 保留用户变更，使用小而可审查的改动。不在普通开发任务中自动创建 fork、提交上游 PR、发布包或升级 submodule。
- 若确需上游改动，先整理最小接口需求、复现、契约测试和独立变更方案；与 Companion 业务规则分离，避免形成长期私有补丁链。
- 维护重点是任务策略、工具契约、恢复和验收。上游未来实现调度时，应能替换重叠部分；不把持续维护整个 Orca 当作本项目成功的前提。
