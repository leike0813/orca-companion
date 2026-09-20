## Context

本 change 是 M2 的第一项，直接前驱为 `m1-evolve-execution-graph`，冻结接缝是前驱已归档的 Patch/Revision/Replanning/Cutover 语义与 Controller 的查询/命令契约。规划阶段所需的领域语义（Coordination Scope、Coordinator Session、Pending Interaction、Route Map 与 Execution Graph candidate）在 M1 已全部落地，本 change 只增加前台投影与意图提交。

与实现直接相关的既有约束：`src/domain/` 不依赖 Ink 或进程；`src/interfaces/cli/` 与 `src/interfaces/tui/` 只消费快照和事件、提交用户意图，不推进状态、不调用 Orca、不恢复模型、不实现重试；Coordinator Session 与 Branch Coordination Store 是两个独立 SQLite store，TUI 不得写其中任何一个。终端约束来自 [docs/research/ink-react-terminal-constraints.md](../../../docs/research/ink-react-terminal-constraints.md)：无 TTY 时 `useInput` 会抛 raw-mode 错误而退出码仍为 0，因此 TTY 门禁必须前移到挂载 Ink 之前。

### 架构合同导入

| 关系 | 合同 | 本 change 的责任 |
|---|---|---|
| Extend | IC-12 Presentation projection、CLI 输出与进程生命周期 | 在 M0 已创建的 CLI/lifecycle 合同内增加 planning `TuiViewModel`、纯投影与 React 组件 |
| Consume | IC-11 ControllerService | UI 只读 snapshot/event 并提交 command，不直接调用任何领域用例、store 或 adapter |
| Consume | IC-04、IC-05；MOD-05、MOD-06、MOD-07 | Coordinator Session 与 Planning/Authorization 事实只经 IC-11 投影进入界面 |

React render/effect/resize/remount 不拥有业务规则，也不得触发恢复、派发、重试或持久化。

## Goals / Non-Goals

**Goals:**

- 让用户在真实终端内完成 Scope 初始化、Route Planning 对话、Pending Interaction 回答、候选图检查，以及手动 compact、模型配置切换与 Route Planning Handoff。
- 保证界面只表达状态，不产生业务副作用；无 TTY 时明确失败而不是假成功。
- 保持 UI 与领域/应用的依赖方向，为 M2 第二项的执行 TUI 复用同一主视图与 Sidebar 骨架。

**Non-Goals:**

- 不实现执行阶段面板、Scope 级 Pause/Resume/Cancel 的运行控制、Finalizer 投影（属 `m2-deliver-execution-tui`）。
- 不实现 Context Compaction、Coordinator Model Configuration 切换或 Route Planning Handoff 的领域逻辑，只提供入口与状态投影。
- 不实现后台 Controller、远程 attach、headless 入口、无人值守运行、i18n 或自定义键位。
- 不实现 Graph Patch、Revision、Replanning 或 Cutover 的触发入口，只做只读投影。
- 不声明 Windows 支持。

## Decisions

### D1：TTY 门禁位于 bootstrap，先于 Ink 挂载

TUI 入口在 `src/bootstrap/` 先检查 `process.stdin.isTTY` 与 `process.stdout.isTTY`，任一为假即以非零状态退出并把诊断写入 stderr。理由：research 已实测「无 TTY + `useInput`」会抛 raw-mode 错误却保持退出码 0，若把判断交给组件，将无法区分真失败与假成功。备选是依赖 `useStdin().isRawModeSupported` 在组件内降级，但该 guard 的端到端行为尚未验证，且已挂载 Ink 后 stdout 可能已写入渲染帧，破坏「stdout 不含渲染帧」的契约。

权威来源：进程级 TTY 状态。失败关闭：无 TTY 即拒绝，不尝试降级为非交互输出。

### D2：Home 查找以 Git common dir 与完整 branch ref 为键

Scope 恢复复用 M1 已建立的 Scope identity 语义：以 Git common dir 与完整 branch ref 定位唯一未归档 Scope。理由：canonical worktree 与 linked worktree 共享 Git common dir，而 linked worktree 或 detached HEAD 不是合法 Startup 位置，用完整 ref 而非当前目录可避免把用户导向错误的 Scope。备选是仅按仓库路径匹配，但同一仓库的多个 worktree 会产生歧义。

权威来源：Git 与 M1 的 Branch Coordination State。失败关闭：匹配到零个或实质多个候选时进入向导或显式要求用户选择，不自动创建。

### D3：初始化向导零持久化前置，确认后单事务提交

向导把 repository 与 worktree、Orca 能力与身份、Coordinator Model Configuration、tracker 汇总为一份 Review，用户在 Review 界面确认后才调用应用层的一个用例，以单事务写入 Scope、初始 Planning Cycle 与首个 Coordinator Session。向导不收集 Worker Profiles、并发与尝试预算、依赖权限、Git 集成策略或 accepted risks，这些由 Execution Authorization Manifest 在授权时一次性决定。理由：与 M1 的「初始化只建立 Scope、Planning Cycle 与首个 Coordinator Session」约束一致，也避免核验失败留下半成品 Scope。备选是分步写入，但在能力探测失败时会留下无法启动的 Scope。

权威来源：Branch Coordination State 是 Scope 记录的唯一写者，TUI 只提交意图。失败关闭：任一步失败即整体回滚并停留在向导内。

### D4：TUI 只消费快照与语义事件，不持有业务状态

TUI 直接消费前驱 `ControllerService` 的已校验 `ControllerSnapshot` 与有界语义事件流，再派生纯展示 view model；内部状态只包含选中 Session、Scroll、Sidebar 密度与草稿。理由：AGENTS.md 第 4 节要求 CLI/TUI 只消费快照和事件；复用既有 façade 也避免再建一个 TUI 专用 controller port。备选是让组件自行轮询应用服务，但这会把持久化与重试引入渲染路径。

权威来源：Controller 的查询快照与语义事件。失败关闭：快照不可用时显示 blocker，不自行推断状态。

### D5：Sidebar 密度由用户偏好上限与终端宽度共同决定

Sidebar 有完整、紧凑、折叠三态。终端宽度只决定允许的最高密度；用户可用 `Ctrl+B` 在该上限内降级或恢复，resize 后按偏好上限自动恢复。任何状态变化不得强制展开。理由：research 记录的 resize 行为是整屏重绘，若由事件驱动展开会让每次 Worker 事件都改变布局。备选是纯宽度驱动，但用户无法在宽屏下保持折叠。

权威来源：用户偏好（进程内）与终端宽度。失败关闭：宽度不足时折叠，而不遮挡主视图。

### D6：Answer 模式是独立 composer 状态，绑定 interaction ID 与 expected revision

普通消息模式与 Answer 模式在 composer 层严格分开；Answer 模式携带 interaction ID 与 expected revision，过期时拒绝提交并提示重读。理由：普通聊天消息不能误满足待答问题，这是 M1 Pending Interaction 的既定语义；把绑定放在 composer 状态而非消息文本解析，可避免从自由文本推断意图。备选是命令前缀（如 `/answer`），但需要用户记忆标识符且无法携带 revision。

权威来源：Branch Coordination State 中的 Pending Interaction 记录。失败关闭：revision 不匹配即拒绝，不降级为普通消息。

### D7：全局键位固定，composer 聚焦时全局命令让位

`Ctrl+P`、`Ctrl+B`、`Ctrl+G` 与 `Esc` 由顶层输入映射处理；`Ctrl+C` 映射为 Exit。composer 聚焦时普通字符不触发全局命令。Enter 提交、Shift+Enter 换行，终端无法区分时回退到 Alt+Enter 并显示实际键位；IME 确认不得误提交。理由：Ctrl 组合键与终端控制序列不冲突，且不需要自定义键位表。备选是可配置键位，但会引入持久化配置与冲突仲裁。

权威来源：固定映射表（编译期常量）。失败关闭：未识别键位不产生动作。

### D8：渲染保真按显示宽度计算，不使用字符数

换行、裁切与边框对齐按终端显示宽度（East Asian Wide 计 2）计算，Graph 标题按可用显示宽度裁切。理由：验收明确要求中文与中英文混排在 resize 后不失配；research 亦记录宽字符渲染未在本机验证，必须由本 change 补测。备选是复用第三方宽度库，但 Node 24 未内置显示宽度计算，需要一处最小实现并只覆盖本项目实际使用的字符区间。

权威来源：字符串自身的码点区间。失败关闭：无法判定的码点按宽度 1 处理并在测试中标注该边界。

### D9：TUI 依赖与测试边界

运行时依赖为 `ink@7.1.1`、`react@19.3.0` 与 `@types/react@19.3.0`，开发依赖为 `ink-testing-library@4.0.0`。组件测试使用该库；无 TTY 拒绝与真实 PTY 行为必须用独立用例覆盖 CLI 层或真实 PTY，因为该库的 Stdin mock 把 `isTTY` 硬编码为 true。理由：research 已实测该组合在本机可用；升级 Ink 主版本时需回归。备选是引入第二套渲染测试框架，但项目已有 Vitest 且不允许第二套运行器。

权威来源：package.json 与 lockfile。失败关闭：不使用无法验证的测试库行为断言 TTY 语义。

### D10：压缩、模型配置与 Handoff 只做入口与状态展示

`/compact`、Model Picker 与 Route Planning Handoff SHALL 复用既有主视图与 Command Palette，不新增页面。TUI 只提交意图并展示 Controller 已持久化的结果：`compaction_degraded`、`context_exhausted`、handoff review 与 `awaiting_user_prompt` 都是投影状态，界面不得自行判定或推进。Model Picker 在 Coordinator Session 非 suspended 或存在在途模型操作时不可提交；`compaction_degraded` 只提供 handoff 建议，不自动创建或切换 Session；Source checkpoint 不可恢复或无法生成可移植 Coordinator Context Capsule 时 Handoff fail closed，界面显示 Scope blocker。理由：`/compact`、模型切换与 Handoff 的准入、边界与 fail-closed 语义在 M1 已由 Controller 拥有，界面重复实现会产生第二权威源。备选是为 compaction 与 handoff 各建专用页面，但 M2 明确不新增页面，且前驱的分区与 Command Palette 已足够表达。

权威来源：Controller 的 `CompactionOutcome`、模型切换结果与 `PlanningHandoffProposal`/Cutover CAS。失败关闭：准入条件不满足或步骤失败时不推进界面状态，显示 blocker。

## Risks / Trade-offs

- **无 TTY 守卫的端到端验证仍不完整。** research 记录该 guard 的实测被中断。本 change 必须在 CLI 层补一条无 TTY 用例，否则「不以退出码判定」的结论无处落地。
- **显示宽度实现是自建的。** 复杂 emoji 与组合字符可能仍失配；本 change 只覆盖验收要求的 CJK 与中英文混排，其余边界在测试中显式标注而不假装支持。
- **三态 Sidebar 的偏好上限只在进程内保存。** 重启后回到默认密度。这是有意的成本控制，若用户要求跨重启记忆需另开配置项。
- **UI 只能展示 Controller 已持久化的状态。** 快照滞后时界面会短暂落后于真实执行；这比在渲染路径补一次查询更安全。

## Migration Plan

1. 安装 `ink`、`react`、`@types/react` 与开发依赖 `ink-testing-library`，并更新 lockfile。
2. 在 `src/bootstrap/` 增加 TTY 门禁与 TUI 生命周期入口；`status` 与 `doctor` 保持现有行为不变。
3. 在应用层补齐 TUI 所需的只读快照与意图端口接线，不改变既有用例语义。
4. 在 `src/interfaces/tui/` 实现主视图、Sidebar、Session Picker、Event Drawer 与 Graph Inspector，并在 Command Palette 接入 `/compact`、Model Picker 与 Route Planning Handoff 入口。
5. 无回滚难点：本 change 只新增入口与视图，移除后 CLI 一次性命令仍可用。

## Open Questions

无。可能需要用户裁决的问题（是否跨重启记忆 Sidebar 密度、是否支持自定义键位）都已在 M2 范围内明确排除。
