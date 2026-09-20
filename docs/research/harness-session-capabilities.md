# 首个 coding harness 的工具与会话能力比较

对应 ticket：[*比较首个 coding harness 的工具与会话能力*](https://github.com/leike0813/orca-companion/issues/3)（父地图 #1，决策 D1/D2）。

结论先行：**首个集成 harness 选 Codex**，第二个补 Claude。理由见第 4 节；两者是当前唯一同时满足「Orca 侧状态钩子已装」「Orca 能读到真实 transcript」「有受支持的 provider session 恢复」「有结构化决策出口」四项的候选。

## 1. 核验环境

| 项 | 值 | 来源 |
| --- | --- | --- |
| Orca CLI | 1.4.198，`/home/joshua/.local/bin/orca` | `orca --version`、`orca status --json` |
| Orca runtime | `state: ready`，`reachable: true` | `orca status --json` |
| 上游源码快照 | `de15227a1d321840ea35c6bb2d0cc01e3409e5f1` | `references/orca` submodule |
| 本机候选 | codex 0.154.0、claude 2.1.274、opencode 1.18.31、kilo 7.7.3、pi 0.85.1、omp 18.2.4 | 各自 `--version` |

本机不存在 `oh-my-pi`；`omp` 是 Oh My Pi。未做任何 Orca 变更：没有创建 Run/Task/Dispatch，没有派发 worker。

## 2. Orca 侧能力：哪些 harness 被真正支持

Orca 对 harness 的支持分四层，能力不同，不能合并判断。

### 2.1 可被派发（dispatch / `--inject`）

`--inject` 拒绝条件是「目标终端没有可识别 agent」，识别集合由 `TUI_AGENT_CONFIG` 的 `expectedProcess` 派生，不是硬编码白名单。

- 来源：`references/orca/src/shared/orchestration-dispatch-refusal-contract.ts`（`RECOGNIZED_AGENT_PROCESS_NAMES`、`injectRejectedRefusal`）；`references/orca/src/shared/tui-agent-config.ts`（`TUI_AGENT_CONFIG_SOURCE` 共 30 个 agent 条目，含 claude、codex、opencode、kilo、pi、omp、gemini、grok 等）。
- 本机候选全部在列，包括 opencode、kilo、pi、omp。

结论：派发层面六个候选都可用。

### 2.2 可恢复 provider session

`RESUMABLE_TUI_AGENTS` 是显式枚举，恢复 argv 逐 agent 分支：

- 来源：`references/orca/src/shared/agent-session-resume.ts`（`RESUMABLE_TUI_AGENTS`、`getAgentResumeArgv`）。
- 含 claude（`--resume <session_id>`）、codex（`resume <session_id>`）、opencode（`--session <id>`）、pi（`--session <transcriptPath>`，**需要 transcriptPath，仅有 id 时返回 null**）、omp（`--resume <file|id>`）、gemini、antigravity、mimo-code、droid、grok、devin、prime-agent、copilot、kimi。
- **kilo 不在该枚举内**：Orca 认它能被派发，但不为它构造恢复命令。

结论：codex、claude、opencode 有一等恢复；pi/omp 有条件恢复；kilo 无恢复。

### 2.3 有托管状态钩子（session 身份 + 提示/工具状态）

`AGENT_HOOK_TARGETS` 是另一份枚举，与上一节不同：

- 来源：`references/orca/src/shared/agent-hook-types.ts`；安装器见 `references/orca/src/main/agent-hooks/managed-agent-hook-registry.ts`。
- 集合：claude、openclaude、codex、gemini、antigravity、amp、cursor、droid、command-code、grok、copilot、hermes、devin、kimi。
- **不含 opencode、kilo、pi、omp。** 这些 agent 走插件/扩展 overlay 通道（`references/orca/src/relay/plugin-overlay.ts` 写 `orca-opencode-status.js` 与 OMP 扩展；监听端点见 `references/orca/src/shared/agent-hook-listener/source-routing.ts` 的 `/hook/opencode`、`/hook/pi`、`/hook/omp`），该 overlay 在仓库中以 WSL relay 路径为主，**宿主直连路径未在本机核验**。

本机实测 `orca agent hooks status --json`：claude `installed`、codex `installed`（配置指向 Orca 托管 home 的 `hooks.json`）、gemini `installed`；状态列表里**没有 opencode、kilo、pi、omp、kimi 之外的插件类条目**（kimi 为 `installed`）。

结论：Codex/Claude 的状态与身份证据由 Orca 现成提供；opencode/pi/omp 依赖 overlay 生效，属未验证项。

### 2.4 能读真实 transcript（validator 证据质量的关键）

`orca orchestration worker-read --source auto` 优先返回 hook 上报的 transcript，否则退回带 `fallbackReason` 的终端输出：

- 来源：`references/orca/src/shared/native-chat-agent-support.ts`（`resolveNativeChatTranscriptAgent` 只支持 claude/openclaude→claude、codex、grok、omp）；`references/orca/src/main/runtime/orchestration/worker-transcript-read.ts`（不支持时 `provider_unsupported`）。
- 技能指南同口径表述为「exact hook-reported Codex, Claude, OpenClaude, or Grok transcript」（`orca skills get orchestration --full`）。

结论：**codex、claude、omp、grok** 可读结构化 transcript；**opencode、kilo、pi** 只能读有界终端输出。

### 2.5 编辑与调度契约（与 harness 无关，但要记录）

来源：`orca skills get orchestration --full`、`orca orchestration worker-start --help`、`orca --help`。

- 受监督循环：`run-create` → `task-create`／`worker-start` → `check --wait` → `worker-read`／`worker-show`／`worker-list` → `worker-release|retain|stop|abandon`。
- 同会话复用：`worker-start --task <next> --terminal <handle>` 把同一 agent 终端转给新 Dispatch——这是「validator 在原会话修复后复验」在 Orca 侧可直接落地的机制，与 provider session 恢复是两件事。
- 每调用模型/推理档：`--model`／`--effort` 仅对支持 `supportsWorkerLaunchPreferences` 的目录生效，即 **claude、codex、cursor**（`references/orca/src/shared/agent-session-option-catalog.ts`、`agent-session-option-catalog-types.ts`；`worker-start --help` 同口径写作 "Claude, Codex, and Cursor"）；`--effort` 必须与 `--model` 同用。gemini/opencode/pi/omp/kilo 不接受。
- 问题/升级通道（与 harness 无关，但要作为对比轴记录）：worker 用 `orca orchestration ask --question <text> [--options <csv>] --timeout-ms <n>` 向协调者发起阻塞式提问，默认落到所属 Dispatch 的 Run；超时或断连不丢问题，用 `--resume <message_id>` 原样续等，不要重问。需要协调者介入且所有权有效时用 `escalation` 类型消息。协调者侧用 `check --wait --types worker_done,escalation,question --timeout-ms <n>` 取件，并对 `question` 用 `reply --id <msg_id> --body <answer>` 作答。`gate-create`／`gate-resolve` 是协调者管理 task DAG 的决策门，不是回答 worker `ask` 的通道（来源：`orca skills get orchestration --full` 第 5 节、`orca orchestration ask --help`、`orca orchestration send --help`）。因此该轴对六个候选不构成差异：只要 worker 拿到 dispatch preamble 且终端能调用 Orca CLI，六个候选都同样可用。
- 结构化 task 交接：`task-create` 定义 spec 与依赖，`worker-start --task <id>`（或 `dispatch --inject`）把 task spec 连同协调者 preamble 注入 agent 终端（`--inject` 走 `argv`／`stdin-after-start` 等 `promptInjectionMode`，要求目标终端有可识别 agent）；结果侧只有 `worker_done` 一种终态收据。来源：`orca skills get orchestration --full`、`references/orca/src/shared/tui-agent-config.ts`。
- 副作用语义：`dispatch`／`worker-start` 的拒绝码为 `task_not_found` / `task_not_startable` / `inject_rejected` / `runtime_error`，带 `nextSteps`；`worker_done` 需 `--outcome succeeded|failed`；不确定结果用 `request-show --request <id>` 对账，重试用 `--retry-request`。这三条与 AGENTS.md 第 5 节的 `OperationOutcome` 语义可以直接对应。

## 3. Harness 侧能力（本机版本实测 `--help`）

| 能力 | codex 0.154.0 | claude 2.1.274 | opencode 1.18.31 | kilo 7.7.3 | pi 0.85.1 | omp 18.2.4 |
| --- | --- | --- | --- | --- | --- | --- |
| 非交互执行 | `codex exec` | `-p/--print` | `opencode run` | `kilo run` | `-p/--print` | `-p/--print` |
| 机器可读事件 | `--json`（stdout JSONL） | `--output-format stream-json` | `--format json` | `--format json` | `--mode json\|rpc` | `--mode=json\|rpc\|rpc-ui` |
| 结构化最终结果 | `--output-schema <file>`、`-o/--output-last-message <file>` | `--json-schema <schema>` | 未见对应开关 | 未见对应开关 | 未见对应开关 | 未见对应开关 |
| MCP 工具注册 | `codex mcp add\|list\|get\|remove\|login` | `claude mcp add\|list\|get\|add-json`（local/user/project） | `opencode mcp add\|list\|auth` | `kilo mcp` | 帮助中无 `mcp` | 帮助中无 `mcp` |
| session 恢复 | `codex resume <id>`、`codex exec resume` | `-r/--resume`、`--session-id <uuid>` | `--session <id>`、`--continue` | `--session`、`--continue` | `--session <path\|id>`、`--session-id`、`--fork` | `-r/--resume`、`--continue` |
| headless server | `codex app-server`（experimental） | `--bg` 后台会话 | `opencode serve`、`attach` | `kilo serve`、`attach` | 未在帮助中见到 | `acp`（ACP over stdio） |
| 扩展/工具注入 | MCP、plugins、hooks | MCP、`--agents`、`--mcp-config` | `opencode plugin`、MCP、ACP | `kilo plugin`、MCP、ACP | `pi install`／`-e` 扩展、`--tools` | `--hook`／`--extension`、`--tools` |
| 隔离与审批 | `--sandbox read-only\|workspace-write\|danger-full-access` | `--allowedTools`、`--dangerously-skip-permissions` | `--auto` | `--auto` | `--no-tools`、`-t` | `--auto-approve`、`--approval-mode` |

kilo 是 opencode 的 fork，命令面几乎一致但 agent id 独立，且如上文所述不在 Orca 的可恢复集合内。

## 4. 结论与建议

**首个集成 harness：Codex。** 在 2.1–2.4 四层上全部就位：可派发、可 `codex resume` 恢复、托管钩子本机已 `installed`、transcript 可读；另有 `codex exec --json --output-schema` 作为不经 Orca 派发的结构化决策出口，以及每调用 `--model`／`--effort`。本机已有两个已登记的托管 Codex 账号（`orca account list --json`）。

**第二个：Claude。** 四层同样就位（托管钩子本机 `installed`、transcript 可读、`--resume`、`--model`／`--effort`、`--json-schema`），但本机 `account list` 显示 claude 无已登记账号，接入前需先 `orca account add --agent claude`。

**这三个不适合当首个**：opencode/kilo 缺托管状态钩子且 transcript 退化为终端读取；pi/omp 无 MCP（工具契约需走结构化产物或消息通道），且 pi 的 Orca 恢复依赖 transcriptPath；omp 虽可读 transcript，但 launch preference 与 MCP 都缺。

这条结论只解决 D1（选谁）。D2（原生工具注册 vs 结构化产物）不必被 D1 单独决定：Codex 的 MCP 与管理子命令都能注册工具，但 AGENTS.md 第 5 节已允许「结构化产物或消息进入同一 handler」，因此可先用 `codex exec --json --output-schema`／`worker_done` 载荷落地，再按需加 MCP。

## 5. 未验证项（不得当作既成事实）

- 未创建任何 Run/Task/Dispatch，2.1–2.5 与第 3 节全部为帮助文本与上游源码的事实，**不是运行时行为证明**。
- opencode／kilo／pi／omp 的宿主端插件 overlay 是否实际生效未验证；仓库中该路径以 WSL relay 为主。
- `worker-read` 对 opencode/kilo/pi 的 `fallbackReason` 实际取值、终端输出的可用性未实测。
- kilo 是否真无恢复能力仅来自 `RESUMABLE_TUI_AGENTS` 枚举；需运行时确认。
- Claude 账号登记、Claude/Codex 的 worker 启动账号绑定未验证。
- `--effort` 在各模型上的实际可接受值、`launch.requested` 与 `launch.effective` 的差异未验证。
- Windows/WSL 路径的行为不在本轮范围。

## 6. 引用

- 本机只读命令：`orca --version`、`orca status --json`、`orca agent hooks status --json`、`orca account list --json`、`orca agent-context --json`、`orca orchestration worker-start --help`、`orca orchestration send --help`、`orca orchestration worker-read --help`、`orca skills get orchestration --full`、各 harness `--version`／`--help`。
- 上游源码（submodule `de15227`）：`src/shared/tui-agent-config.ts`、`src/shared/tui-agent.ts`、`src/shared/agent-session-resume.ts`、`src/shared/agent-hook-types.ts`、`src/main/agent-hooks/managed-agent-hook-registry.ts`、`src/shared/managed-agent-hook-targets.ts`、`src/shared/native-chat-agent-support.ts`、`src/main/runtime/orchestration/worker-transcript-read.ts`、`src/shared/orchestration-dispatch-refusal-contract.ts`、`src/shared/agent-session-option-catalog.ts`、`src/shared/agent-session-option-catalog-types.ts`、`src/relay/plugin-overlay.ts`、`src/shared/agent-hook-listener/source-routing.ts`。

记录时间：2026-09-17。
