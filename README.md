# Orca Companion

为范围明确的小型软件项目提供可恢复、可追踪、有预算上限的开发流程。Orca 负责工作区与 agent 执行，Companion 负责项目计划、调度规则、验收与恢复。

当前进度：M0（Orca 控制基线）与 M1（有界协调闭环）已归档，M2 正在交付前台 TUI。

## 环境

- Node.js ≥ 24（本仓库验证于 24.12.0，见 `.nvmrc`）
- pnpm ≥ 11（`packageManager` 固定 11.10.0）
- 本机可执行的 Orca CLI（验证版本见 `docs/orca-compatibility.md`）
- 当前仅验证 **Ubuntu 本机**；Windows 是目标平台但未经验证，不得当作已支持。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm install` | 安装依赖 |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint`、`pnpm lint:fix` | ESLint，含类型感知规则 |
| `pnpm test`、`pnpm test:watch` | Vitest（含 TUI 组件与 PTY 用例） |
| `pnpm build` | 输出 `dist/`；`pnpm start` 运行构建产物 |

## 运行

| 命令 | 说明 |
| --- | --- |
| `orca-companion [repository-path]` | 启动前台 TUI。**需要交互式终端**：stdin 或 stdout 无 TTY 时在挂载 Ink 之前以退出码 2 拒绝，诊断写 stderr |
| `orca-companion status [--json]` | 只读输出当前 Coordination Scope 状态；无 TTY 可运行 |
| `orca-companion doctor` | 核验 Orca 环境与能力；无 TTY 可运行 |

不存在 `run`、`resume`、`tui` 子命令；传入它们会以非零状态被拒绝并指出受支持入口。

### 前台 TUI 键位与分区

- `Ctrl+P` Command Palette、`Ctrl+B` 切换 Sidebar 密度、`Ctrl+G` Graph Inspector、`Esc` 逐层关闭、`Ctrl+C` 退出（不隐式 Pause/Cancel）。
- composer 聚焦时普通字符只进入输入框；`Enter` 提交，`Shift+Enter`（终端无法区分时为 `Alt+Enter`）换行。
- 主视图常驻顶栏 / transcript / composer / 状态行；Scope 状态、预算、执行图、Worker 与 blocker 只在 Sidebar；语义事件只在 Event Drawer。
- 中文与中英文混排按显示宽度换行与裁切；过窄终端下 `Ctrl+G` 只提示扩宽，不用 overlay 遮挡主视图。

### 当前未接线的能力（fail closed）

M2 的规划 TUI 只做投影与意图提交。以下能力在 M1 还没有权威来源或用例，因此界面会显示结构化 blocker，而不是假装成功：

- 向 Coordinator 发送消息（M1 没有「用户消息进入模型循环」的用例，也没有前台 Runtime Incarnation 装配）；
- 回答 Pending Interaction（需要合法 `CoordinationWriter`）；
- `/compact`（没有面向 Session 的压缩请求用例）；
- Model Picker 切换（没有项目级 Coordinator Model Configuration 来源）；
- Route Planning Handoff 与 Scope 初始化（分别需要 Capsule 生成与合法 writer）。

只读部分（Home 解析、快照、transcript、向导核验、Graph Inspector）已可用。

## 结构

模块边界、工具契约与里程碑以 `AGENTS.md` 为准，此处不重复。`references/orca` 是只读上游源码（Git submodule），不参与构建、lint、测试与打包。

## 文档

- `AGENTS.md`：项目目标、模块边界、工具契约、里程碑
- `CONTEXT.md`：领域语言与权威事实归属
- `docs/architecture.md`：运行组件、代码 module、依赖方向与关键跨系统流程
- `docs/interface-contracts.md`：跨 module interface、DTO 字段、唯一 owner 与演进规则
- `docs/orca-compatibility.md`：上游 submodule 与 Orca CLI 的版本基线，以及已验证和未验证的能力
