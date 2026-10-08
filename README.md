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
| `pnpm lab` | 运行 ledger-lab 验收工具；子命令支持 `--run` 选择外置 round |
| `pnpm lab:new` | 构建并进入 ledger-lab 新 round 向导；可用 `--profile cancel` 建立独立取消轮次 |
| `pnpm ui:preview planning` | 启动只读假数据 TUI 预览；其他场景见 [TUI 调试工作台](docs/dev/tui-workbench.md) |
| `pnpm ui:devtools` | 启动独立 React DevTools，配合 `DEV=true pnpm ui:preview execution` |

## 运行

| 命令 | 说明 |
| --- | --- |
| `orca-companion [repository-path]` | 启动前台 TUI。**需要交互式终端**：stdin 或 stdout 无 TTY 时在挂载 Ink 之前以退出码 2 拒绝，诊断写 stderr |
| `orca-companion status [--json]` | 只读输出当前 Coordination Scope 状态（`schemaVersion: 3`，含执行快照分区）；无 TTY 可运行 |
| `orca-companion doctor` | 核验 Orca 环境与能力；无 TTY 可运行 |

`ocp` 是 `orca-companion` 的短命令别名，参数与行为相同。

### ledger-lab 实测

首次运行 `pnpm lab:new` 会进入终端向导，并把可复用设置保存在 XDG 配置目录
`orca-companion/ledger-lab.json`；使用 `pnpm lab:new --profile cancel` 建立独立取消轮次。
已有构建产物或运行过新建向导后，可用 `pnpm lab configure` 修改设置；`pnpm lab open --run /abs/round`
核对原 round 身份并重开，不会推进流程。采集与验收子命令可用 `--run /abs/round`，也保留显式参数。
`--root` 指定绝对路径的外置 runs 根目录，`--settings` 指定外置 JSON 设置文件。目录结构、人工步骤和证据限制见
[ledger-lab 实测包](artifacts/ledger-lab/README.md)。
基础设施的规格、设计与验收进度见 [OpenSpec change](openspec/changes/add-ledger-lab-rehearsal-infrastructure/proposal.md)。

不存在 `run`、`resume`、`tui` 子命令；传入它们会以非零状态被拒绝并指出受支持入口。

### 项目配置：`orca-companion.json`

前台规划 Runtime 从 canonical worktree 根目录读取用户维护、纳入版本控制的 `orca-companion.json`。
它只保存**凭据引用**，不保存任何密钥值：出现已知密钥字段名时整份配置被拒绝。`schemaVersion` 必须是 4，
旧版本配置被明确拒绝，不会被自动改写。

```json
{
  "schemaVersion": 4,
  "revision": 1,
  "providerConnections": [
    {
      "connectionRef": "connection-openai",
      "label": "OpenAI",
      "providerIntegration": "@langchain/openai#ChatOpenAI",
      "modelOptions": { "temperature": 0 },
      "credential": { "kind": "harness_login" }
    }
  ],
  "models": [
    {
      "modelRef": "gpt-4.1-mini",
      "connectionRef": "connection-openai",
      "model": "gpt-4.1-mini",
      "effortCapability": null
    }
  ],
  "coordinatorModels": [
    {
      "configurationRef": "planning-default",
      "providerIntegration": "@langchain/openai#ChatOpenAI",
      "model": "gpt-4.1-mini",
      "modelOptions": { "temperature": 0 },
      "credentialRefs": [],
      "nativeWindowOwnerRef": null
    }
  ],
  "defaultCoordinatorModelRef": "planning-default",
  "tracker": { "kind": "github", "routeMapIssueNumber": 42 },
  "planning": { "maxMutations": 3 },
  "context": { "maxInputTokens": 120000, "maxReadBytes": 16777216 },
  "output": { "maxResponseBytes": 8388608 },
  "execution": {
    "harness": "codex",
    "workerProfiles": [{
      "profileRef": "planner-native",
      "role": "planner",
      "harness": "codex",
      "modelSelection": {
        "model": "gpt-6-luna",
        "effort": null,
        "effortCapability": null,
        "catalogSource": null
      }
    }],
    "workerProfileRefs": { "planner": "planner-native" },
    "codexSandbox": "workspace-write",
    "permissions": { "gitIntegration": true, "dependencyChanges": false },
    "limits": { "maxActiveWorkPackages": 3, "maxWorkPackages": 8, "integrationReconciliations": 2 },
    "git": { "remotes": ["origin"], "refs": ["refs/heads/main"] },
    "dependency": { "allowDependencyChanges": false, "registry": null },
    "acceptedRisks": []
  }
}
```

- `revision` / `providerConnections` / `models`：**Coordinator** 模型设置的不可变记录。每次编辑追加新的
  `connectionRef`、`modelRef` 并推进 `revision`，既有引用不被改写。`credential` 为 `harness_login`
  （provider integration 自身环境认证）或 `managed`（带 `credentialRef` 与 LangChain `optionPath`）；
  密钥值存在用户级凭据文件里，不进版本控制。Worker 角色不使用连接或凭据：其 Profile 只带 harness 与
  `modelSelection`。
- `coordinatorModels` / `defaultCoordinatorModelRef`：可切换的 Coordinator 模型配置闭集与默认引用；
  默认引用必须存在于集合中，且 `configurationRef` 唯一。`providerIntegration` 形如 `<module>#<export>`，
  由用户已安装的 provider 集成提供，Companion 不维护 allowlist、不自动 fallback。
- `tracker`：Route Map 所在的 GitHub issue；正文与票据仍是 tracker 的事实。
- `planning.maxMutations`：本 Scope 允许的规划写入次数上限，`0` 表示只读规划。已用次数由
  Companion 的 Operation Intent 记录派生，重启与重规划都不清零。
- `context.maxInputTokens`：一次模型输入的上下文预算；超出时按 provider 原生 → Context Capsule →
  机械 Shake 的固定顺序压缩，无法收敛即显式 `context_exhausted`。
- `context.maxReadBytes`：一次有效上下文读回的总字节预算，缺省 16 MiB；仍保留 4096 项上限。
  超限明确阻塞，权威原文可继续按范围阅读，不静默截断输入。
- `output.maxResponseBytes`：单次模型输出的字节预算，缺省 8 MiB，涵盖正文、内容块与工具参数。
  两项字节预算均须为有限正整数；输出超限会中止调用，不重试或提交部分响应。
- `execution`（可选）：执行授权的长期策略。`harness` 与 `workerProfiles` 决定各 Worker 角色用哪个 harness
  与哪份 `modelSelection`（native model、effort 与目录来源）；`workerProfiles` 缺省为空，此时只能做规划，
  执行授权要求四个生产角色齐全。
  `codexSandbox` 决定角色级 Session 的 Codex 沙箱模式（默认 `workspace-write`，只允许写隔离
  worktree）；`permissions`、`limits`、`git`、`dependency`、`acceptedRisks` 是 Execution Authorization
  Manifest 被审阅与批准的候选值。缺省的字段取有限默认值（`limits` 走 `budget-policy.ts` 的默认上限，
  权限默认放行四个角色），但**配置本身不是授权**：只有用户在 Execution Authorization Review 里批准的
  完整 Manifest 才产生授权，且 `git.remotes`/`git.refs` 为空时受控 Git 集成永远被拒绝。
  修改这些值会让下一份 Manifest 的内容与指纹变化，因此必须重新审阅与批准。

  把 `codexSandbox` 设为 `danger-full-access` 只有在 `acceptedRisks` 里同时存在
  `codex-sandbox-danger-full-access` 时才可能通过审阅：审阅会把它作为已接受风险显示，未接受时授权被
  拒绝。Finalizer 的只读模式不受该字段影响（它始终以 `read-only` 运行，只读无法证明时交付保持 blocker）。
  `workerProfileRefs` 是「角色当前选择引用」：执行期换模型时先保存选择，再走完整 Execution Authorization
  重新审阅与批准，批准前不会改变正在运行的 Session、已批准授权、Task 或已消耗预算。

编辑模型设置是显式的两步：**保存**只改配置，**应用**才改变运行中的 Session 或角色授权。Coordinator 连接
编辑保存时先校验候选（引用唯一、交叉引用一致、选项里不得含明文密钥），有新 key 时先把凭据写入并回读，
再把新的 `connectionRef`/`modelRef` 以 CAS 追加进项目配置；Worker 角色保存只追加 `profileRef` 与
`modelSelection`，并经该 harness 显式、有界的原生目录查询核验来源，不写凭据。项目保存失败保留你的输入，
不覆盖较新配置，也不宣称已生效。

### 授权与运行依据

Command Palette 的“执行设置”或 `/concurrency` 可保存并行包额度，默认 3，允许任意正安全整数。
`execution.limits.maxActiveWorkPackages` 是并行额度，`maxWorkPackages` 是未退场图容量（默认 8），
`integrationReconciliations` 是每包集成复验预算（默认 2）。保存只改项目默认值；执行中须重新审阅并批准
完整 Manifest 才生效。降低额度会等待在途包集成或终止后回收空槽，不停止已有 Worker。同包角色按顺序执行，
独立包可并行，canonical 集成始终串行；分支分歧由原 Validator 会话复验合并树。

Execution Authorization Manifest 当前为 v4：除目的地、图、权限、预算与策略外，它还完整绑定四个生产角色
各自 Worker Profile 的 `modelSelection`（harness、native model、effort 及其可信目录来源）以及 Recovery
Utility 的独立绑定。缺少任一角色绑定的授权无法证明 Worker 实际用什么模型运行，因此解析即拒绝；旧版本
Manifest（v1/v2/v3）读取即拒绝。
执行期改变模型配置或并行额度时按完整 Manifest 指纹与 Scope revision 重新批准，不创建 Graph Revision、不重置预算；
Replanning、cancelling 或存在未决派发时不能重新授权。

每次派发会把当时的授权 ID、授权版本与 Worker Profile 写进该 Task 的物化绑定。Retry 沿原 Task 的绑定继续用
原授权与原 profile，新角色 Task 才取当前授权；结算与恢复都按这条绑定判断权限与模型配置。缺失这三项的
历史记录按不可证明阻塞，不退回「当前授权」。

### 凭据文件

用户安装 provider 集成后填写的密钥存在独立的用户级凭据文件（XDG 目录，按 XDG 变量解析），文件内容是明文的
`credentialRef → secret` 映射，权限被拒绝时明确报错而不是放宽。项目配置、checkpoint、UI 输入存储、日志与
提交内容里只出现 `credentialRef`：聊天模型在最后的构造点按 `credential.credentialRef` 与 `optionPath` 解析，
凭据只用于 Coordinator 模型调用。保存凭据先落盘再写项目配置；后者失败
时输入被保留，可能留下未引用的孤立密钥，但不会激活错误配置。

引用不可变：每次保存生成新的 `credentialRef`，既有引用不被改写。Worker 启动不读取凭据文件，认证由各
harness 在自己的真实用户环境中提供。文件写入使用短 exclusive 文件锁、
revision CAS、0600 临时文件原子替换与回读；锁被占用、文件已被其他写者更新、目录或文件权限不安全、指向
符号链接、内容损坏或超出大小与条目上限时都以结构化错误拒绝，不自动破锁、不修改既有用户目录权限。

配置缺失、schema 无效、默认模型引用不存在或 tracker 不可达时，初始化与模型恢复都会明确拒绝，
不会选择任意已安装模型，也不会隐式创建 Scope。

### 前台 TUI 键位与分区

- `Ctrl+P` Command Palette、`Ctrl+B` 开合项目面板、`Ctrl+G` Graph Inspector、`Esc` 逐层关闭、`Ctrl+C` 退出（不隐式 Pause/Cancel）。
- composer 支持中间编辑、方向键、Home/End、Ctrl+A/E 行首尾与完整字符删除；`Enter` 提交非空正文，`Alt+Enter` 换行（可靠解析 Shift+Enter 的终端也可使用）。正文视口最多六行，随光标和 resize 调整。
- 粘贴插入光标处并立即保存。超过 1000 个 Unicode 字符的粘贴显示原子折叠块；`/paste` 或 Palette 查看完整内容，Esc 返回原位置，发送使用全文。
- `Shift+Left`、`/answer` 或 Palette 打开当前 Session 回答面板；Shift+左右切问题，Tab 切选项与自由回答，选项 Enter 直接提交。Esc 保存回答并恢复聊天草稿；项目待答列表支持精确跨 Session 进入与原入口返回。
- `F3` 搜索 transcript，`F4` 导航活动，`Ctrl+T` 切换详细程度，`Ctrl+R` 搜索普通输入历史。slash 上方候选先采用，下一次 Enter 才执行。
- 主视图常驻顶栏 / transcript / composer / 状态行，默认 Sidebar 展示图与运行摘要。项目面板承载预算、授权、身份、工作依据、待答与本次启动的最近事件；100 列及以上在原 Sidebar 区域打开，窄屏独占主区域。
- 中文与中英文混排按显示宽度换行与裁切；三档尺寸下 `Ctrl+G` 都能查看只读图邻域与节点详情。

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

- 顶栏：Graph Generation、Execution Authorization、Scope 控制状态、并行 Work Package 计数；
  重启后未完成对账时显示 `reconciling`。
- Sidebar（完整态）：稳定拓扑的执行图（`position` 由编译顺序决定，状态变化不重排；过滤只隐藏节点）、当前
  active Work Package 的真实列表与计数、各包的角色/attempt/liveness/worktree/baseline、Validation 与 Evidence、串行
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

执行运行时已接线：授权、并行 Frontier 推进、Delivery 结算、Validator（由角色 Worker 在自己的 harness
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
- 已归档执行 TUI 的隔离验收取得真实 Delivery Verdict、Git 集成及重启恢复证据，具体版本和限制见
  `docs/orca-compatibility.md`。当前模型配置变更的真实启动需单独核验，不由历史验收推定通过。

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
