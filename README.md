# Orca Companion

为范围明确的小型软件项目提供可恢复、可追踪、有预算上限的开发流程。Orca 负责工作区与 agent 执行，Companion 负责项目计划、调度规则、验收与恢复。

当前进度：M0、M1 与 M2 的规划任务和前台 TUI 验收已归档；M2 收尾修复见 `openspec/changes/archive/2026-09-29-m2-closeout-integration-and-wake/`。

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
| `pnpm ui:preview planning` | 启动只读假数据 TUI 预览；其他场景见 [TUI 调试工作台](docs/dev/tui-workbench.md) |
| `pnpm ui:devtools` | 启动独立 React DevTools，配合 `DEV=true pnpm ui:preview execution` |

## 运行

| 命令 | 说明 |
| --- | --- |
| `orca-companion [repository-path]` | 启动前台 TUI。**需要交互式终端**：stdin 或 stdout 无 TTY 时在挂载 Ink 之前以退出码 2 拒绝，诊断写 stderr |
| `orca-companion status [--json]` | 只读输出当前 Coordination Scope 状态（`schemaVersion: 2`，含执行快照分区）；无 TTY 可运行 |
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
  "context": { "maxInputTokens": 120000 },
  "execution": {
    "harness": "codex",
    "workerModel": "minimax-cn/MiniMax-M3",
    "codexSandbox": "workspace-write",
    "permissions": { "gitIntegration": true, "dependencyChanges": false },
    "limits": { "maxActiveWorkPackages": 8, "concurrencyLimit": 1 },
    "git": { "remotes": ["origin"], "refs": ["refs/heads/main"] },
    "dependency": { "allowDependencyChanges": false, "registry": null },
    "acceptedRisks": []
  }
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
- `execution`（可选）：执行授权的长期策略。`harness` 与 `workerModel` 决定 Worker 角色用哪个 harness
  与模型；`codexSandbox` 决定角色级 Session 的 Codex 沙箱模式（默认 `workspace-write`，只允许写隔离
  worktree）；`permissions`、`limits`、`git`、`dependency`、`acceptedRisks` 是 Execution Authorization
  Manifest 被审阅与批准的候选值。缺省的字段取有限默认值（`limits` 走 `budget-policy.ts` 的默认上限，
  权限默认放行四个角色），但**配置本身不是授权**：只有用户在 Execution Authorization Review 里批准的
  完整 Manifest 才产生授权，且 `git.remotes`/`git.refs` 为空时受控 Git 集成永远被拒绝。
  修改这些值会让下一份 Manifest 的内容与指纹变化，因此必须重新审阅与批准。

  把 `codexSandbox` 设为 `danger-full-access` 只有在 `acceptedRisks` 里同时存在
  `codex-sandbox-danger-full-access` 时才可能通过审阅：审阅会把它作为已接受风险显示，未接受时授权被
  拒绝。Finalizer 的只读模式不受该字段影响（它始终以 `read-only` 运行，只读无法证明时交付保持 blocker）。

配置缺失、schema 无效、默认模型引用不存在或 tracker 不可达时，初始化与模型恢复都会明确拒绝，
不会选择任意已安装模型，也不会隐式创建 Scope。

### 前台 TUI 键位与分区

- `Ctrl+P` Command Palette、`Ctrl+B` 切换 Sidebar 密度、`Ctrl+G` Graph Inspector、`Esc` 逐层关闭、`Ctrl+C` 退出（不隐式 Pause/Cancel）。
- composer 聚焦时普通字符只进入输入框；`Enter` 提交，`Shift+Enter`（终端无法区分时为 `Alt+Enter`）换行。
- 主视图常驻顶栏 / transcript / composer / 状态行；Scope 状态、预算、执行图、Worker 与 blocker 只在 Sidebar；语义事件只在 Event Drawer。
- 中文与中英文混排按显示宽度换行与裁切；过窄终端下 `Ctrl+G` 只提示扩宽，不用 overlay 遮挡主视图。

### 执行阶段视图

规划交接进入 Execution Coordination 之前，先由 Execution Authorization 完成一次显式批准。

- Command Palette 的 **Execution Authorization** 打开完整 Manifest 审阅：界面显示宿主从 Scope、候选图
  记录、世代记录（baseline HEAD 与空 Orca Run）、Git 身份与项目配置 `execution` 段组装出的全部字段、
  当前指纹与门禁判决。`Enter` 批准并原子进入 Execution Coordination，`Esc` 关闭。
- 批准只回传你在审阅里看到的那份内容的指纹与 Scope revision；宿主会重读全部权威输入再写入批准。规划
  引用（地图、计划、候选图）在审阅之后发生变化时批准被拒绝且零写入，旧批准也不会触发任何派发。
- 候选图由 Coordinator 提出的正式 Implementation Plan 编译（分配新的 Graph Generation 与空 Orca Run）；
  世代、Run、OperationId 与预算上限都由宿主补齐，模型只能提供计划正文。门禁未通过（开放票据、fog、未决
  交互或未结算 mutation）时批准不会进入执行模式。

授权进入 Execution Coordination 后不切换页面：顶栏与 Sidebar 换成执行投影，transcript 与 composer
保持原内容与焦点。

- 顶栏：Graph Generation、Execution Authorization、Scope 控制状态、active Work Package 计数（并发上限
  固定为 1，因此只可能是 0 或 1），重启后未完成对账时显示 `reconciling`。
- Sidebar（完整态）：稳定拓扑的执行图（`position` 由编译顺序决定，状态变化不重排；过滤只隐藏节点）、当前
  active Work Package 的角色/attempt/liveness/worktree/baseline、Validation 与 Evidence、串行
  integration queue、Recovery 详情（替代 Segment、coverage、剩余预算、superseded、结果引用）、Finalizer
  门禁与 Delivery Verdict、预算与 blocker。紧凑态只保留图关系、短 key、关键状态与告警；折叠态只在顶栏留计数。
- 生命周期（`specifying`/`implementing`/`validating`/`waiting_integration`/…) 与 Worker liveness
  （`live`/`exited`/`unverifiable`）是两个字段。`unknown` 与 `unverifiable` 如实显示为待核验，**不会**
  显示为失败或已停止；刷新与 resize 不触发重试、对账或派发。
- Scope 级控制（Command Palette 的 Pause/Resume/Cancel 与 Exit）：只有整个 Coordination Scope 的控制，
  没有单个 Work Package 的暂停或取消。Pause 直接执行；Cancel 与 Exit 在存在活跃/不可核验 Worker、待答
  交互或未决操作时先要求确认（`y` 确认 / `n` 或 `Esc` 取消）。界面不会乐观显示终态：`cancelling` 只来自
  Controller 已持久化的控制状态。Exit 与 `Ctrl+C` 只结束前台进程，不隐式暂停或取消 Scope。
- Execution Handoff 复用同一个交接交互（Command Palette 的 Execution Handoff）：走 `ExecutionHandoffState`
  的 prepare → review → cutover，Cutover 后自动选中 Target 且其状态为 `awaiting_user_prompt`；Source
  checkpoint 不可恢复或 Capsule 不可移植时 fail closed，Source 保持唯一 owner。Run、Task、Dispatch、
  Attempt、Worker、worktree、Authorization 与预算身份不变。

### 当前未接线的能力（fail closed）

执行运行时已接线：授权、串行 Frontier 推进、Delivery 结算、Validator（由角色 Worker 在自己的 harness
session 内完成）、受控 Git 集成与只读 Finalizer 都在生产路径上，Scope 级 Pause/Resume/Cancel 也会真实
落盘（Resume 先对账再恢复调度）。以下事实仍缺权威来源，界面会显示结构化 blocker 或如实显示为未知，
而不是假装成功：

- schema 11 已保存角色级 Task Envelope 身份、worktree 与 Spec Binding；旧 schema 的物化记录缺少这些
  事实时仍以 `spec_binding_unreadable` 阻塞对应的 Delivery lane；
- Worker Session Recovery 的 binding、workspace 对账与原会话终态大部分不可读（`worker-show` 不报告
  provider session），未终结 Recovery 以 `unverifiable_hold` 阻塞其派发 lane，不伪造续接；
- Planner 的规格路径由宿主在 Task Envelope 中固定；SessionStart 精确绑定后才尝试 Specification Admission，
  规格缺失或结构无效时按接纳失败码阻塞；
- Validator 的 in-host 步骤通道：验证链由角色 Worker 在其 harness session 内完成，宿主没有可证明的
  step 通道，因此不接线；
- 集成要求 Manifest 恰好一个获批 remote 与一个 ref，多个目标时不替用户挑一个；
- 完整闭环尚未在真实 Orca + Worker 上通过：隔离项目已实测到 Planner 派发，但当前主机的 Codex
  受限沙箱无法执行 shell；真实 PTY 与前台集成冒烟已运行。详情见 `docs/orca-compatibility.md`。

已可用：Home 的精确 Scope 恢复与初始化向导、向 Coordinator 发送消息、回答 Pending Interaction、
`/compact`、Model Picker 切换、Route Planning Handoff、Execution Handoff 的意图链路、Execution
Authorization 审阅与批准、Scope 级 Pause/Resume/Cancel 与 Exit、只读快照 / transcript / Graph Inspector /
执行图与 Finalizer 投影，以及带结构化 blocker 的执行推进入口。

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
