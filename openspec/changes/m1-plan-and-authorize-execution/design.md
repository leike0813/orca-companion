## Context

本 change 直接前驱是 `m1-run-coordinator-sessions`，它已实现 Coordinator Session 运行时、checkpoint 归属、Runtime Lease 与 fencing 的使用方式、Wake Batch 与 Context Capsule。本 change 只补规划侧语义、确定性编译、两类责任转移与一次性授权，不重新定义 Session 运行时。

仓库现状：`src/domain/`、`src/application/` 除前两个 change 新增内容外仍无规划模块；`CONTEXT.md` 已固定 Route Map、Decision Ticket、Ticket Claim、Frontier、Implementation Plan、Execution Graph、Graph Generation、Execution Authorization Manifest、Execution Authorization、Execution Coordination Lease 与 Replanning Transition 的语义；`docs/research/orca-task-dag-execution-graph.md` 说明 Orca Task 结构不可改且只能追加；`AGENTS.md` 第 5、7 节固定了 Route Planning 的语义操作与进入执行的门禁。

术语状态：前驱 apply 阶段把 `CONTEXT.md` 与 `AGENTS.md` 的 Coordinator Profile 同步为 Coordinator Model Configuration。本 change 沿用该 Canonical 术语，不自造第二套命名。

### 架构合同导入

| 关系 | 合同 | 本 change 的责任 |
|---|---|---|
| Create | `IC-05` | 首次实现 Route Planning、Manifest、`ExecutionGraphHistory` 初始版本与 `PlanningHandoffProposal` |
| Extend | `IC-03` | 只增加 planning、graph/auth refs 与 handoff 阶段记录 |
| Consume | `IC-01`、`IC-02`、`IC-04`、`FLOW-02` | 复用身份、三值副作用、Session/Wake/Context maintenance，不另建会话 runtime |
| Consume | `MOD-01`–`MOD-04` | 规划规则归 Domain/Application，tracker adapter 不拥有规划语义 |

## Goals / Non-Goals

**Goals:**

- 让规划事实只存在于 tracker 与 Companion 的最小引用记录里。
- 让候选图由计划确定性地编译出来，可重复、可复核。
- 让一次明确的用户批准成为整个 Graph Generation 执行前提，并把执行侧恢复预算固定在同一份批准里。
- 让规划责任与执行 Lease 的转移成为原子的、可恢复的事实。

**Non-Goals:**

- 不实现 Worker 派发、Task 物化、生命周期与 Delivery 处理。
- 不实现 Specification Admission、Validator、Finalizer 与 Git 集成。
- 不实现 Replanning Transition 之后的新规划循环与 Generation Cutover。
- 不实现 TUI、Command Palette 与 Pending Interaction 呈现。

## Decisions

### D1 Route Map 权威归 tracker，本地只存引用

Route Map 与 Decision Ticket 的事实存在 issue tracker，Companion 只在 Branch Coordination Store 保存地图与票据的外部引用。用户提供的任何 roadmap、OpenSpec 或任务列表都按 Planning Reference 处理。

理由：`AGENTS.md` 第 8 节的状态权威表；`CONTEXT.md` 对 Planning Reference 的界定禁止直接采用。

备选：本地缓存完整地图（否决，会产生第二权威并在 tracker 与本地之间漂移）。

### D2 Route Map 写入限定固定章节与直属票据

地图更新只作用于配置的地图票据与直属 Decision Ticket，写入固定章节：destination、resolved decisions、open Decision Tickets、dependencies、fog、scope boundaries。写入通过 tracker adapter 完成，不直接编辑任意仓库文件。

理由：`AGENTS.md` 第 5 节明确 Route Map 写入范围；固定章节让后续读取与对账不必解析自由文本。

### D3 Ticket Claim 由 assignee 与本地记录共同表达

Claim 的可见部分是 tracker assignee，权威部分是 Session 级本地记录；Claim 由两者共同表达，且不随 Runtime Incarnation 退出而释放。Frontier 是「开放、未阻塞、未被认领」的投影。

理由：`CONTEXT.md` 对 Ticket Claim 与 Frontier 的定义；只用 assignee 无法表达 Session 身份，只用本地记录则用户不可见。

### D4 Implementation Plan 是图编译的唯一输入

候选图由 Coordinator 在规划阶段产出的结构化 Implementation Plan 编译，编译是纯函数式的结构转换：输入计划、配置与地图 revision，输出 Work Package 集合与依赖拓扑。编译器不判断规划语义。

理由：`AGENTS.md` 第 7 节明确编译器只检查 schema、引用、无环、Scope Envelope、预算与可信配置。把语义判断放进编译器会让图编译成为不可复核的模型行为。

备选：由模型直接产出图拓扑（否决，无法给出可重复的编译结果）。

### D5 候选图绑定新 Graph Generation 与地图 revision

每次 Planning Cycle 产出新的 GraphId 与新的空 Orca Run，WorkPackageId 不跨世代复用，并将编译所依据的地图 revision 固化在候选图记录中。编译成功后通过 `ExecutionGraphHistory.recordInitialGraph` 追加初始 GraphVersion，并通过同一 interface 读回；地图 revision 变化即使候选图过期。

理由：`CONTEXT.md` 对 Graph Generation 的定义；Orca 的 Run 是命名空间，空 Run 可在授权后承载首次物化。

### D6 编译器强制预算与 Scope Envelope

编译为每个 Work Package 写入 Scope Envelope 与预算上限，取值只来自配置与授权输入。超限计划编译失败，不做截断或放宽。默认上限沿用 `AGENTS.md` 第 7 节的有限值（最多 8 个 active Work Package、每包 2 次实现尝试、2 次 Validator 修复、2 次 Graph Revision、2 次 Specification Revision、每个 Worker Attempt 1 次 Recovery、并发 1），可配置但必须有限。这些字段在本 change 的 Manifest 一次性定型；后继只读取和扣减。

理由：把上限固定在编译产物里，使后续派发只需比较而无需重新推断。

### D7 Manifest 是单一不可分结构

Manifest 用运行时 schema 校验的结构表示，字段固定为 destination 与规划工件引用、Graph Generation 与 GraphId、Coordination Scope、baseline HEAD、Orca Run、Worker Profiles、角色权限、active Work Package、实现尝试、Validator 修复、Graph Revision、Specification Revision 与每个 Worker Attempt Recovery 的有限上限、workspace 与 Git/Dependency Policy、accepted risks。任何字段缺失即拒绝进入待批准状态；后继不得通过新增 Manifest 字段补预算。

理由：`AGENTS.md` 第 7 节 Execution Authorization；完整性检查放在提交批准之前，避免出现部分授权。

### D8 maxRecoveriesPerWorkerAttempt 默认 1 且显式绑定

Manifest 显式携带 `maxRecoveriesPerWorkerAttempt`，默认值 `1`，表示单个 Worker Attempt 允许的恢复次数上限。该值在组装 Manifest 时写入，不设空值、不在执行阶段推断。初始化向导不询问该值，它属于 Execution Authorization 阶段而非 Scope 创建阶段。改变该值需要新版本 Manifest 与新的用户批准。

理由：该上限属于执行权限与预算，按 `AGENTS.md` 第 7 节应随授权固定；把它放在 Scope 初始化会把执行策略提前固化到创建流程。

备选：由 Worker Profile 决定（否决，会让同一 Manifest 下的恢复预算随 profile 漂移，无法在授权时一次性核对）。

### D9 批准是原子用户决定，记录为版本化授权

批准以一次用户决定完成，结果作为 Execution Authorization 记录持久化在 Branch Coordination Store，并带 Manifest 版本与内容指纹。授权不可事后部分修改；内容变化必须产生新版本与新批准。

理由：`CONTEXT.md` 把授权定义为对某一份确切 Manifest 的批准记录；版本化让重放与对账有稳定身份。

### D10 授权覆盖范围与越界边界

有效授权覆盖该世代内的普通派发、策略内依赖变更与受控 Git 集成；发布、部署与 Manifest 未覆盖的外部操作始终需要单独授权。Companion 的 handler 在每次副作用前重验 scope、ownership、revision、权限与预算。

理由：`AGENTS.md` 第 7 节明确「授权后的普通派发不再逐次审批」与越界仍需授权；重验放在 handler 而非模型侧，模型不能自行宣告获授权。

### D11 门禁是模式切换的唯一入口

从 `route_planning` 进入 `execution_coordination` 必须同时满足：开放票与 fog 清空、无未决交互或未完成 mutation、计划绑定当前地图 revision、编译被接受、Manifest 已批准。门禁由 Controller 判定，不由模型宣告。

理由：`AGENTS.md` 第 5、7 节；把门禁做成 Controller 论断避免「模型认为自己可以开始」的路径。

### D12 规划责任交采用 prepare→review→cutover 三阶段

Route Planning 责任在 Session 间转移时走三阶段：prepare 产出并持久化交接提案，review 由接收 Session 独立复核提案引用的地图 revision、开放票据、计划工件与候选图状态，cutover 才把责任转移并落盘。任一阶段未完成时责任仍归原 Session，且不得同时存在两个规划责任方。

理由：规划责任决定谁能改 Route Map。让接收方先独立复核，可以避免把未经核对的规划状态直接接管。`CONTEXT.md` 已规定同一 Scope 可并行多个独立 Session 处理不同票据，因此责任转移必须显式且唯一。

备选：直接把 Session 所有权整体移交（否决，无法表达复核，也无法在崩溃后判断责任归属）。

### D13 交接只转移规划责任

交接的作用域限定为 Route Planning 责任与相关 claim 表达。它不释放、不停止、不重新归属 Execution Coordination 下已在途的 Worker、Dispatch、Task 与授权，也不改变 Execution Coordination Lease 的持有者。

理由：`CONTEXT.md` 把 Ticket Claim、Runtime Incarnation 与 Execution Coordination Lease 定义为彼此独立的所有权；`AGENTS.md` 第 7 节要求已派发 Worker 运行到可核验终态。把两类责任混在一起会让一次规划交接意外中断执行中的工作。

### D14 交接的取消、过期与崩溃恢复

cutover 之前取消交接时，责任保持或回到原 Session，提案标记为已取消，不留下半转移状态。提案引用的地图 revision、计划 revision 或候选图在 cutover 前发生变化时，提案判定为过期并要求重新 prepare。崩溃后按持久化阶段确定性恢复：prepare 未完成回到原责任方，review 完成而 cutover 未完成等待明确的 cutover 决定，已 cutover 则保持接收 Session。

理由：交接阶段必须可重放，否则崩溃会留下无法判定归属的中间态。

### D15 awaiting_user_prompt 激活门

存在未决交接且激活门未满足时，接收 Session 不得执行规划动作、不得修改 Route Map，并以等待用户输入的状态呈现。激活门满足后才允许推进规划。

理由：`AGENTS.md` 第 9 节要求待答交互不能被普通聊天满足；未决交接期间让接收方自行开工会让用户失去确认点。

### D16 Lease 交接与模式变更同批生效

切换时模式、当前 Graph Generation 与 Orca Run、Execution Authorization、预算引用、Execution Coordination Lease 同批写入，任一项失败则整体不生效。`transitionToExecution` 组合前驱 `lease-service.ts` 已有的取得、释放与 fencing interface，不重新导出 `acquireExecutionLease`。Lease 由唯一 Session 持有，Runtime Incarnation 退出后可通过既有 interface 重新取得，不自动转移。

理由：`CONTEXT.md` 的 Execution Coordination Lease 定义；同批生效避免出现「已授权但无 Lease」或「有 Lease 但未授权」的中间态。

### D17 规划工具按模式与事实动态暴露

规划语义操作作为 Coordinator Agent 工具暴露，只在其模式与当前事实允许时可见，且 handler 每次调用重验 scope、ownership、revision、权限与预算。工具集覆盖读取地图与 Frontier、创建票据、设置依赖、领取、解决、按固定章节更新地图，以及发起或复核交接。

理由：`AGENTS.md` 第 5 节；动态暴露减少模型误用不存在的能力。

### D18 tracker 访问通过 adapter，使用仓库已有 CLI

`src/adapters/tracker/` 封装 issue tracker 访问，通过已安装的 `gh` CLI 完成读写，输出做运行时 schema 校验，错误按 `OperationOutcome` 的三值语义归类。

理由：`AGENTS.md` 第 1 节的维护成本与最小依赖取向；不新增依赖即可满足 planning 的读写需求。

备选：引入 tracker SDK（否决，当前不需要额外能力且增加维护面）。

### D19 模块归属与依赖方向

`src/domain/planning/` 定义 Route Map、Decision Ticket、Ticket Claim、Implementation Plan、Execution Graph、Manifest 与交接提案的领域类型与规则；模式与控制状态只来自 `src/domain/coordination/mode.ts`。`src/application/planning/` 提供编译、`ExecutionGraphHistory`、Scope 初始化、授权、门禁与交接用例；`src/adapters/tracker/` 提供 tracker 读写；`src/workflow/coordinator/` 只注册对应工具节点。依赖只指向内层契约，领域层不依赖 tracker、Orca 或 LangGraph。

理由：`AGENTS.md` 第 4 节布局与依赖方向。

### D20 真实 provider 冒烟验收的边界

本 change 的验收包含一项显式 MiniMax-M3 冒烟：用真实模型生成一次 Context Capsule，并完成一次真实 Route Planning Handoff。真实调用只在显式选择的隔离项目与专用身份中运行，未显式选择时不执行，也不纳入普通 `pnpm test`。

跨库故障窗口（checkpoint 写入与 source admission 之间崩溃、tracker 写入响应丢失、交接中途重启）仍主要由 fake backend 覆盖：这些窗口需要可重复的注入与确定性时序，真实 provider 无法稳定提供。真实冒烟只证明在真实模型条件下 Capsule 生成与交接链路可用，不替代故障窗口的 fake 覆盖。

理由：`AGENTS.md` 第 11 节要求真实集成测试显式选择隔离项目，并要求用 fake backend 先验证故障路径。

备选：用真实调用覆盖故障窗口（否决，时序不可控且会引入不稳定验收）。

## Risks / Trade-offs

- 固定章节的 Route Map 可读性依赖约定。取舍是让解析边界稳定，代价是排版自由度受限。
- 编译失败会让规划无法收敛到可执行状态。这是刻意的：宁可回到规划，也不产出语义不明或超预算的图。
- 原子批准粒度较大。取舍是一次批准覆盖整代执行，代价是用户需要完整阅读 Manifest 才能批准。
- 三阶段交接增加一次往返。取舍是责任转移可复核、可在崩溃后判定归属，代价是交接不是单步操作。
- tracker adapter 通过 CLI 读写会受外网与凭据影响。失败按 unknown 处理并要求对账，不自动重试已产生副作用的调用。

## Migration Plan

通过前驱的版本化 migration 为 `coordination.sqlite` 增加初始 graph history、authorization 与 planning handoff 记录；迁移可重入并保留既有 Scope、Session、lease、intent 与 wake admission。`route_planning` 为默认模式；本 change 首次引入规划模块、责任交接与模式切换路径，不改变前驱已建立的 Session 运行时。前驱已把 `CONTEXT.md` 与 `AGENTS.md` 的术语同步为 Coordinator Model Configuration，本 change 不自造术语。直接前驱已归档、其主规格已同步、且冻结接缝在实现 HEAD 上匹配时才允许开始实施；不满足任一条即回到规划。

## Open Questions

无。Tracker 中地图票据与 Worker Profile 的具体配置取值属于项目配置，由实现阶段在 `openspec/config.yaml` 之外的项目配置里确定，不改变本 change 的契约、方案或任务划分。
