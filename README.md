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

### 项目配置：`orca-companion.json`

前台规划 Runtime 从 canonical worktree 根目录读取用户维护、纳入版本控制的 `orca-companion.json`。
它只保存**凭据引用**，不保存任何密钥值：出现已知密钥字段名时整份配置被拒绝。

```json
{
  "schemaVersion": 1,
  "coordinatorModels": [
    {
      "configurationRef": "planning-default",
      "providerIntegration": "@langchain/openai#ChatOpenAI",
      "model": "gpt-4.1-mini",
      "modelOptions": { "temperature": 0 },
      "credentialRefs": ["openai-default"],
      "nativeWindowOwnerRef": null
    }
  ],
  "defaultCoordinatorModelRef": "planning-default",
  "tracker": { "kind": "github", "routeMapIssueNumber": 42 },
  "planning": { "maxMutations": 3 },
  "context": { "maxInputTokens": 120000 }
}
```

- `coordinatorModels` / `defaultCoordinatorModelRef`：可切换的 Coordinator 模型配置闭集与默认引用；
  默认引用必须存在于集合中，且 `configurationRef` 唯一。`providerIntegration` 形如 `<module>#<export>`，
  由用户已安装的 provider 集成提供，Companion 不维护 allowlist、不自动 fallback。
- `tracker`：Route Map 所在的 GitHub issue；正文与票据仍是 tracker 的事实。
- `planning.maxMutations`：本 Scope 允许的规划写入次数上限，`0` 表示只读规划。已用次数由
  Companion 的 Operation Intent 记录派生，重启与重规划都不清零。
- `context.maxInputTokens`：一次模型输入的上下文预算；超出时按 provider 原生 → Context Capsule →
  机械 Shake 的固定顺序压缩，无法收敛即显式 `context_exhausted`。

配置缺失、schema 无效、默认模型引用不存在或 tracker 不可达时，初始化与模型恢复都会明确拒绝，
不会选择任意已安装模型，也不会隐式创建 Scope。

### 前台 TUI 键位与分区

- `Ctrl+P` Command Palette、`Ctrl+B` 切换 Sidebar 密度、`Ctrl+G` Graph Inspector、`Esc` 逐层关闭、`Ctrl+C` 退出（不隐式 Pause/Cancel）。
- composer 聚焦时普通字符只进入输入框；`Enter` 提交，`Shift+Enter`（终端无法区分时为 `Alt+Enter`）换行。
- 主视图常驻顶栏 / transcript / composer / 状态行；Scope 状态、预算、执行图、Worker 与 blocker 只在 Sidebar；语义事件只在 Event Drawer。
- 中文与中英文混排按显示宽度换行与裁切；过窄终端下 `Ctrl+G` 只提示扩宽，不用 overlay 遮挡主视图。

### 当前未接线的能力（fail closed）

M2 的规划 TUI 只做投影与意图提交。以下能力仍缺权威来源或用例，因此界面会显示结构化 blocker，
而不是假装成功：

- Scope 级 Pause/Resume/Cancel（需要前台对账 runner 与 Worker 停止端口，属执行阶段 TUI）；
- 执行阶段的 Handoff 与图演进意图（需要执行期 ledger 与 Run/Task 事实）。

已可用：Home 的精确 Scope 恢复与初始化向导、向 Coordinator 发送消息、回答 Pending Interaction、
`/compact`、Model Picker 切换、Route Planning Handoff、只读快照 / transcript / Graph Inspector。

Home 只按 Git 当前身份恢复：完整 branch ref 与登记的 canonical worktree 精确匹配才进入该 Scope；
没有匹配才进入向导；缺少绑定的旧记录必须先在同一界面的迁移 Review 里确认一次性绑定；从链接
worktree（`git worktree add` 出来的工作区）或 detached HEAD 启动会被拒绝并指出身份不匹配。

## 结构

模块边界、工具契约与里程碑以 `AGENTS.md` 为准，此处不重复。`references/orca` 是只读上游源码（Git submodule），不参与构建、lint、测试与打包。

## 文档

- `AGENTS.md`：项目目标、模块边界、工具契约、里程碑
- `CONTEXT.md`：领域语言与权威事实归属
- `docs/architecture.md`：运行组件、代码 module、依赖方向与关键跨系统流程
- `docs/interface-contracts.md`：跨 module interface、DTO 字段、唯一 owner 与演进规则
- `docs/orca-compatibility.md`：上游 submodule 与 Orca CLI 的版本基线，以及已验证和未验证的能力
