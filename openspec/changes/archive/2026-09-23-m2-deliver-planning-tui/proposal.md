## Why

M1 完成后 Companion 已经具备可恢复的 Coordinator Session、受控工具、Route Planning 与 Execution Authorization 语义，但全部交互只存在于无界面路径，用户无法在真实终端里发起规划、审阅候选执行图或回答 Pending Interaction。M2 的第一项工作就是把初始化与规划阶段做成前台 TUI，让规划闭环第一次真正可用。

## What Changes

- 新增前台入口：`orca-companion [repository-path]` 启动 TUI；保留 `status [--json]` 与 `doctor`；不提供 `run`、`resume`、`tui` 子命令。无 TTY 时在挂载 Ink 之前以非零状态明确拒绝。
- Home 按 Git common dir、完整 branch ref 与登记的 canonical worktree 精确查找 Coordination Scope，命中即恢复，未命中才进入初始化向导；旧未绑定记录要求显式迁移，不在启动时隐式创建。
- 初始化向导依次核验 repository 与 canonical worktree、Orca 能力与调用者身份、Coordinator Model Configuration 与 issue tracker；最终 Review 之前零持久化，确认后以单事务创建 Scope、初始 Planning Cycle 与首个 Coordinator Session，不创建 Orca Run、Task 或 worktree。向导不收集任何预算与权限，Worker Profiles、并发与尝试预算、依赖权限、Git 集成策略和 accepted risks 全部留给 Execution Authorization Manifest。
- 主视图固定为顶栏、Coordinator transcript、composer 与状态行；工具调用默认折叠；普通消息模式与绑定 interaction ID 与 expected revision 的 Answer 模式严格分开。
- Sidebar 提供完整、紧凑、折叠三态；宽度只规定允许的最高密度，任何状态变化都不得强制展开，终端过窄时必须折叠。
- Session Picker 恢复上次选择，无历史记录时优先有 Pending Interaction 的 Session，再选最近活动；新事件只增加未读或待处理标记，不自动切换 transcript、不抢占 composer、不改变 Scope 级 Graph。
- Graph Inspector 在 Sidebar 内只读展示候选图、依赖、Scope Envelope 与 admission/authorization readiness，支持沿依赖导航，不执行领域动作。
- 全局键位为 `Ctrl+P` Command Palette、`Ctrl+B` 切换 Sidebar、`Ctrl+G` Graph Inspector、`Esc` 逐层关闭、`Ctrl+C` 退出；composer 聚焦时普通字符不触发全局命令。
- 在既有主视图与 Command Palette 增加 `/compact`、Model Picker 与 Route Planning Handoff，不新增应用页面；显示 `compaction_degraded`、`context_exhausted`、handoff review 与 `awaiting_user_prompt`。Model Picker 只在 Coordinator Session suspended 且无模型操作在途时可提交，不自动 fallback；`compaction_degraded` 可建议 handoff 但不自动创建或切换 Session；Source checkpoint 不可恢复或无法生成 Coordinator Context Capsule 时 Handoff fail closed，Scope 保持 blocked。
- render、effect、resize 与组件重挂载不得触发模型恢复、Worker 派发、重试或持久化等业务副作用；中文与中英文混排在 resize 后不失配。

## Capabilities

### New Capabilities

- `tui/scope-initialization`: 前台 TUI 启动门禁、Home Scope 恢复与初始化向导的原子创建契约。
- `tui/planning-workspace`: 常驻 transcript/composer 主视图、三态 Sidebar、信息分层与终端渲染保真。
- `tui/session-interactions`: Session Picker 焦点约束与 Pending Interaction 回答绑定、`/compact` 与 Model Picker 入口、Route Planning Handoff 与降级状态可见性。
- `tui/graph-inspection`: 只读 Graph Inspector 导航与零业务副作用的渲染约束。

### Modified Capabilities

无。本 change 只新增独立 capability，不修改已归档主规格。

## Impact

- 直接前驱：`m1-wire-foreground-planning-runtime`（其前驱 `m1-evolve-execution-graph` 已归档）。本 change 消费已接线的前台规划 Runtime，只实现 TUI 投影与意图提交。
- 承接的 M1 会话语义：#31 的 Context Compaction 与 `compaction_degraded`/`context_exhausted`、#32 的 Route Planning Handoff、#33 的 Coordinator Model Configuration 切换。TUI 只提供入口与状态展示，不实现压缩、切换或交接的领域逻辑。
- 新增代码面：`src/interfaces/tui/`（组件、输入映射、视图模型）、`src/bootstrap/`（TTY 门禁与进程生命周期）、`src/interfaces/cli/`（保留 `status`/`doctor` 与 TUI 共用快照入口）、`src/application/`（TUI 消费的查询与意图端口接线）。
- 依赖：新增 `ink@7.1.1`、`react@19.3.0`、`@types/react@19.3.0`，开发依赖新增 `ink-testing-library@4.0.0`。不引入第二套测试运行器。
- 测试：Vitest 组件测试；真实 PTY 验收在 Ubuntu 本机进行。
- 不在本 change 内：执行阶段面板、Scope 级 Pause/Resume/Cancel 的运行控制、Finalizer 投影、后台 Controller、远程 attach、headless 入口、i18n、自定义键位、Windows 支持声明。
