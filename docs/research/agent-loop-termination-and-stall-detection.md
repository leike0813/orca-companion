# Agent loop 的停机与无进展熔断机制

对应 ticket：[*调研 agent loop 的停机与无进展熔断机制*](https://github.com/leike0813/orca-companion/issues/18)（父地图 [规划 Orca Companion M0–M2 的实现路径](https://github.com/leike0813/orca-companion/issues/1)）。

结论先行：

1. **主流 agent SDK 都用固定上限做安全阀，但不把它当业务预算**。默认值都很小（AI SDK 20 steps、OpenAI Agents JS 10 turns、LangGraph 25 节点步），且全部可关闭或调高。没有一家把"上限"表述为任务完成条件。
2. **没有一家第一方 SDK 提供"重复相同工具调用"检测**。我逐一枚举了 AI SDK 的全部内置 stop condition；重复检测、无进展判定都必须由 Companion 自己写。
3. **唯一的"基于进展"的第一方熔断是 LangGraph 的 `idleTimeout`**，它明确定义了"进展信号"，时钟只在无进展时累积。这是本项目可以复用的现成语义。
4. **服务器侧 pause 只有 Anthropic 一家有**（`pause_turn`），语义是"原样送回继续"，不是错误。
5. 对本项目（长链工具调用属正常），正确的最小契约是：**用"无进展"而不是"步数"做业务熔断**，把固定上限降级为技术保险，把取消/暂停交给运行时原语，把"是否完成"留给状态机。

## 1. 方法与来源

只使用一手来源：官方文档仓库的原始 Markdown、官方 SDK 源码、官方 CLI/SDK 参考。查询时间 2026-09-18。

| 组件 | 版本 | 一手来源 |
| --- | --- | --- |
| `ai`（Vercel AI SDK） | 7.0.105 | [Loop Control](https://github.com/vercel/ai/blob/main/content/docs/03-agents/04-loop-control.mdx)、[`stop-condition.ts`](https://github.com/vercel/ai/blob/main/packages/ai/src/generate-text/stop-condition.ts)、[`tool-loop-agent.ts`](https://github.com/vercel/ai/blob/main/packages/ai/src/agent/tool-loop-agent.ts) |
| `@openai/agents` | 0.18.0 | [Running Agents](https://github.com/openai/openai-agents-js/blob/main/docs/src/content/docs/guides/running-agents.mdx)、[`errors.ts`](https://github.com/openai/openai-agents-js/blob/main/packages/agents-core/src/errors.ts)、[`runState.ts`](https://github.com/openai/openai-agents-js/blob/main/packages/agents-core/src/runState.ts) |
| Anthropic TypeScript SDK | — | [`BetaToolRunner.ts`](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/lib/tools/BetaToolRunner.ts)、[`helpers.md`](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/helpers.md)、[Stop reasons](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons) |
| Claude Code / Claude Agent SDK | 0.3.274 | [CLI reference](https://docs.claude.com/en/docs/claude-code/cli-reference)、[Sessions](https://docs.claude.com/en/docs/claude-code/sessions)、[Agent SDK TypeScript](https://code.claude.com/docs/en/agent-sdk/typescript) |
| `@langchain/langgraph` | 1.4.15 | [Fault tolerance](https://github.com/langchain-ai/docs/blob/main/src/oss/langgraph/fault-tolerance.mdx)、[Persistence](https://github.com/langchain-ai/docs/blob/main/src/oss/langgraph/persistence.mdx)、[`constants.ts`](https://github.com/langchain-ai/langgraphjs/blob/main/libs/langgraph-core/src/constants.ts)、[`config.ts`](https://github.com/langchain-ai/langgraphjs/blob/main/libs/langgraph-core/src/pregel/utils/config.ts) |

Codex 的公开一手材料（`docs/`、`developers.openai.com/codex/`、`learn.chatgpt.com/docs/codex-manual.md`）中**没有**找到任何"每 turn 上限"的配置项；在 `openai/codex` 源码里检索 `max_turns` 只命中 TUI 的历史回放模块，与 agent loop 无关。按任务要求"仅在公开一手材料能确认时纳入"，Codex 在本报告中不作为可比对象出现。

## 2. 先统一词汇：四种计数不是一回事

这四者经常被混为一谈，而它们的上限、重置条件、归属层级完全不同。

| 概念 | 定义 | 谁计数 | 谁拥有上限 |
| --- | --- | --- | --- |
| **模型 step / turn** | 一次完整的模型请求-响应（可能带 tool calls） | SDK 的 agent loop | AI SDK `stopWhen`、OpenAI `maxTurns`、Anthropic `max_iterations`、Claude Code `--max-turns` |
| **tool call** | 一次工具调用（一个 step 内可含多个） | SDK | 通常无独立上限 |
| **graph superstep** | LangGraph 的一个"tick"，该 tick 内调度的所有节点执行一次 | LangGraph Pregel 运行时 | `recursionLimit`（默认 25） |
| **业务预算** | 项目允许的任务数、尝试数、修复次数、时长、费用 | Companion | Companion 领域代码 |

依据：AI SDK 的 step 定义见 [Loop Control](https://github.com/vercel/ai/blob/main/content/docs/03-agents/04-loop-control.mdx)（"stops after 20 steps using `isStepCount(20)`"）；superstep 的定义见 [Persistence](https://github.com/langchain-ai/docs/blob/main/src/oss/langgraph/persistence.mdx)（"a single 'tick' of the graph where all nodes scheduled for that step execute"）。

**关键含义**：LangGraph 的 `recursionLimit` 统计的是**节点**，不是模型调用。Companion 若把 model node、tool node、校验 node 都放进图里，一个业务 turn 会消耗多个 `recursionLimit` 名额，所以它**无法**表达"模型判断了几次"。这正是地图里早先那个"20 个模型步骤"提案不成立的技术原因。

## 3. 逐家核验

### 3.1 Vercel AI SDK：`stopWhen` 是唯一停机机制

`ToolLoopAgent` 的默认停止条件是 `isStepCount(20)`，源码里写死：

```ts
stopWhen: this.settings.stopWhen ?? isStepCount(20),
```

来源：[`tool-loop-agent.ts`](https://github.com/vercel/ai/blob/main/packages/ai/src/agent/tool-loop-agent.ts)。

`stopWhen` 是数组时任一条件满足即停（[Loop Control](https://github.com/vercel/ai/blob/main/content/docs/03-agents/04-loop-control.mdx)）。我枚举了 [`stop-condition.ts`](https://github.com/vercel/ai/blob/main/packages/ai/src/generate-text/stop-condition.ts) 的**全部**导出，只有四个：`isStepCount`、`isLoopFinished`、`hasToolCall`、`isStopConditionMet`。**没有重复调用检测，没有无进展检测**。

值得注意的两点：

- `isLoopFinished()` 返回常量 `false`，官方文档明确警告"could potentially run indefinitely or incur significant costs"。
- 文档给出了**自定义费用熔断**的官方示例：在 stop condition 里累加 `steps[].usage` 的 token 并估算成本。这说明"费用/用量熔断"在这个 SDK 里是**调用方责任**，SDK 只提供 `usage` 数据点。

`prepareStep` 可以在每步前覆盖 model / tools / messages / 采样参数，是 compaction 与动态工具暴露的官方入口（同上文档）。

### 3.2 OpenAI Agents SDK JS：`maxTurns` 默认 10，可设 `null` 关闭

官方运行文档的运行参数表逐项给出默认值：

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `maxTurns` | `10` | "Safety limit – throws `MaxTurnsExceededError` when reached. Pass `null` to disable the limit." |
| `signal` | — | `AbortSignal` for cancellation |

来源：[Running Agents](https://github.com/openai/openai-agents-js/blob/main/docs/src/content/docs/guides/running-agents.mdx)。loop 的终止规则在该页被明确写为三步循环，"Throw `MaxTurnsExceededError` once `maxTurns` is reached, unless `maxTurns` is `null`"。

`MaxTurnsExceededError` 是一个空的 `AgentsError` 子类，不携带"卡在哪一步"的结构化信息（[`errors.ts`](https://github.com/openai/openai-agents-js/blob/main/packages/agents-core/src/errors.ts)）。

状态恢复是完全序列化的：`RunState.toString()` / `RunState.fromString()`（[`runState.ts`](https://github.com/openai/openai-agents-js/blob/main/packages/agents-core/src/runState.ts)）。暂停语义由 `interruptions` + `result.state.approve/reject` 承载，粘性决定（`alwaysApprove`）会随 `toString()` / `fromString()` 存活（[Human-in-the-loop](https://github.com/openai/openai-agents-js/blob/main/docs/src/content/docs/guides/human-in-the-loop.mdx)）。

**没有**重复调用或无进展检测。

### 3.3 Anthropic：服务器侧 pause 与唯一的"无默认上限"

`BetaToolRunner` 把 `stop_reason` 归成三桶（[`BetaToolRunner.ts`](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/lib/tools/BetaToolRunner.ts)）：

```ts
type NextStep = 'run_tools' | 'resume' | 'stop';
```

- `tool_use` → `run_tools`
- `pause_turn`、`compaction` → `resume`，注释写得很明白："turns are sent back unchanged so the server continues them"
- `end_turn` / `stop_sequence` / `max_tokens` / `model_context_window_exceeded` / `refusal` → `stop`

`pause_turn` 的官方定义是"A server-tool loop reached its iteration limit"，处理方式是"Send the assistant content back to continue"（[Stop reasons](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons)）。这是本次调研中**唯一**的服务器侧暂停原语，且它不是错误路径。

上限方面：

- `max_iterations` 的默认值是**无限制**："`max_iterations?: number` - Maximum number of tool execution iterations (default: no limit)"（[`helpers.md`](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/helpers.md)）。
- Claude Code CLI 的 `--max-turns` **默认无限制**："No limit by default"（[CLI reference](https://docs.claude.com/en/docs/claude-code/cli-reference)）。
- Claude Agent SDK 提供的是**费用**上限而非步数上限：`maxBudgetUsd`（"Stop the query when the client-side cost estimate reaches this USD value"）与配套的 cost tracking 页面（[Agent SDK TypeScript](https://code.claude.com/docs/en/agent-sdk/typescript)）。这印证了第 3.1 节的判断：计量数据是 SDK 提供、熔断策略是调用方的事。

Claude Code 的 `/goal` 是另一种形态的"无进展处理"：它不设固定上限，而是在每轮结束后用一个小模型对完成条件做**判定**，三选一（满足 / 不可能满足 / 继续），并且**恢复会话时重置 turn 计数、计时器与费用基线**（[Keep Claude working toward a goal](https://docs.claude.com/en/docs/claude-code/goal)）。这条对 Companion 直接相关：**计数不能跨恢复重置，否则会变成无限重试**。

`BetaToolRunner` 也没有重复调用检测。

### 3.4 LangGraph：唯一提供"进展信号"定义的实现

**固定上限**：`recursionLimit` 默认 25，源码常量即 `const DEFAULT_RECURSION_LIMIT = 25;`（[`config.ts`](https://github.com/langchain-ai/langgraphjs/blob/main/libs/langgraph-core/src/pregel/utils/config.ts)），触顶抛 `GraphRecursionError`（`lc_error_code: "GRAPH_RECURSION_LIMIT"`）。官方错误页承认"complex graphs may hit the default limit naturally"，并建议调高（[GRAPH_RECURSION_LIMIT](https://github.com/langchain-ai/docs/blob/main/src/oss/langgraph/errors/GRAPH_RECURSION_LIMIT.mdx)）。

**无进展熔断（本项目最关心的部分）**：`addNode` 的 `timeout` 支持 `runTimeout` 与 `idleTimeout` 两个独立上限（[`fault-tolerance`](https://github.com/langchain-ai/docs/blob/main/src/oss/langgraph/fault-tolerance.mdx)）：

- `runTimeout`：单次尝试的硬墙钟上限，**永不刷新**。
- `idleTimeout`：**进展重置型**上限——"It fires only when the node stops making observable progress for the specified duration"。
- 两者同时设置时先到者生效。

官方还明确定义了**什么算进展**（`refreshOn: "auto"` 默认）：

- 通过图写入路径产生的 state 写入
- 通过 `runtime.writer` 的自定义流输出
- 子任务调度
- 来自该节点或其任意后代的 LangChain callback 事件（LLM token、tool call、chain start/end 等）

`refreshOn: "heartbeat"` 则把刷新源收窄为**仅**显式 `runtime.heartbeat()` 调用，官方说这适用于"when you want a strict idle definition that isn't reset by chatty subordinates"。`runtime.heartbeat()` 在非 idle-timed 尝试里是 no-op，可以无脑调用。

这是唯一一个把"无进展"做成第一方语义的 SDK，且它的默认值恰好是我们的问题：`refreshOn: "auto"` 下，一个持续输出 token 或持续发 tool call 的 agent **永远不会**触发 idle 熔断，无论它是否在做有用的事。也就是说 `idleTimeout` 解决的是"卡住不动"，不是"原地打转"。

**重试**：JS 侧是**选择性加入**的——"Retries are opt-in. A node retries only when it has a `retryPolicy` configured"，空对象 `{}` 即启用；默认 `maxAttempts: 3`，自带退避因子与抖动。内置 `retryOn` 明确不重试取消类错误、`GraphValueError`、`ECONNABORTED`，以及 400/401/402/403/404/405/406/407/409 等 HTTP 客户端错误；**5xx 与 408 可重试**。同时明确："Graph control-flow errors, such as `GraphInterrupt` and `Command` routing, bubble up without retrying. An aborted run signal also stops the retry loop."（`fault-tolerance` 同上）

**取消与暂停**：

- `RunControl.requestDrain()` 是协作式的、**只发生在 superstep 之间**："Drain is cooperative and operates between supersteps, never preempting work that is already running"。语义表逐条给出：节点执行中→跑完；重试中→跑完或重试耗尽；恰好同 tick 完成→正常返回；还有后续 superstep→抛 `GraphDrained(reason)` 且**已保存 checkpoint**。恢复用**同一个 thread** 调 `invoke(null, config)`。（`fault-tolerance` 同上）
- 官方警告 `requestDrain()` **不会**取消在途的 async 工作："For a hard upper bound, pair drain with a graceful timeout and an `AbortSignal`."
- `interrupt()` 保存状态并无限期等待，恢复必须用**同一 thread ID**，且**节点从开头重新执行**——"any code before the `interrupt` runs again"（[Interrupts](https://github.com/langchain-ai/docs/blob/main/src/oss/langgraph/interrupts.mdx)）。这条决定了副作用必须幂等或先对账。

**崩溃恢复的粒度**：checkpoint 在 superstep 边界创建，另有 node/task 级 `checkpoint_writes`；"if another node in the same super-step fails, the successful nodes' writes are already durable and don't need to be re-run on resume"（[Persistence](https://github.com/langchain-ai/docs/blob/main/src/oss/langgraph/persistence.mdx)）。durability 三档：`exit` / `async` / `sync`，其中 `sync` 是"persists changes synchronously before the next step starts"。

但官方也明确两个限制，直接对应地图中早先的决策：

- 重放不是缓存："Replay re-executes nodes—it doesn't just read from cache. LLM calls, API requests, and `interrupts` fire again and may return different results."（[Use time-travel](https://github.com/langchain-ai/docs/blob/main/src/oss/langgraph/use-time-travel.mdx)）
- checkpoint 会长大："Over long conversations, checkpoints accumulate."，官方建议定期清理或设 retention。

**同样没有**重复调用检测。

## 4. 横向结论

### 4.1 固定上限是安全阀，不是业务预算

| SDK | 上限名 | 默认 | 可否关闭 | 计数对象 |
| --- | --- | --- | --- | --- |
| Vercel AI SDK | `stopWhen` | `isStepCount(20)` | 是（`isLoopFinished()`） | 模型 step |
| OpenAI Agents JS | `maxTurns` | `10` | 是（`null`） | turn |
| Anthropic `BetaToolRunner` | `max_iterations` | 无限制 | 本来就是 | 迭代（API 请求） |
| Claude Code CLI | `--max-turns` | 无限制 | 本来就是 | agentic turn |
| LangGraph | `recursionLimit` | `25` | 是（调高） | 节点/superstep |

【推断】把"默认值小"解读为"官方认为长链正常但需要兜底"。四个 SDK 的文档都把该参数称为 safety、limit、bound，没有一个把它当完成条件；这支持该解读，但文档没有直白表述。

### 4.2 重复相同工具调用：没有任何第一方实现

这是本报告最明确的一条负面结论：

- AI SDK：`stop-condition.ts` 的全部内置条件只有 4 个，无此项（源码枚举）。
- OpenAI Agents JS：`maxTurns` 之外无 loop-shape 检测（文档 + `run.ts` 选项）。
- Anthropic `BetaToolRunner`：`stop_reason` 三桶分派，无此项。
- LangGraph：`retryPolicy` / `timeout` / `errorHandler` / `RunControl`，无此项。

【推断】"连续 N 次相同工具 + 相同输入 + 相同结果"这类检测需要**领域知识**（什么算"相同输入"、什么算"有进展"），SDK 无法通用地判定（例如 `get_task_status` 重复调用是正常的轮询）。这解释了它为何缺席，也说明 Companion 必须自己写。

### 4.3 "无进展"的两种已存在语义

| 语义 | 代表 | 判定方式 | 是否够用 |
| --- | --- | --- | --- |
| **时钟无进展** | LangGraph `idleTimeout` | 一段时间内无任何进展信号 | 覆盖"卡死"，不覆盖"空转" |
| **状态无进展** | 需自建 | 权威 revision / 结果指纹未变 | 覆盖"空转"，需 Companion 定义 |

Claude Code 的 `/goal` 属于第三种：模型判定完成条件，成本高且非确定性（[goal 文档](https://docs.claude.com/en/docs/claude-code/goal)）。

### 4.4 与既有研究结论的一处冲突（未验证）

[独立协调 agent loop 的可复用基础](./coordinator-agent-loop-foundations.md) 记录了"`abort(Error)` 抛普通 `AI_APICallError`，`isAbortError` 返回 false，`onAbort` 未触发"，据此得出"取消不可区分"。

但 AI SDK 官方 error-handling 文档明确写了 `onAbort` 回调存在，且 `fullStream` 会产出 `{ type: 'abort' }` 分片："The `onAbort` callback is called when a stream is aborted via `AbortSignal`, but `onEnd` is not called."（[Error handling](https://github.com/vercel/ai/blob/main/content/docs/03-ai-sdk-core/50-error-handling.mdx)）

两者不可能同时成立。**这是一处未解决的冲突**，需要在 M1 用一次真实探针确认：分别测 `agent.generate()`（非流式）与 `agent.stream()`（流式）下，`abort()` 与 `abort(new Error())` 分别产生什么、`onAbort` 是否触发、`isAbortError` 返回什么。在确认前，**取消状态不应依赖 SDK 的错误类型**，应由 Companion 状态机先行记录取消意图。

## 5. 面向 Orca Companion 的最小停机与熔断契约

前提：协调 loop 由 LangGraph 持有外层（checkpointer + `thread_id` = Coordinator Session ID），AI SDK 只在 model node 内完成单次模型调用；**长链工具调用属正常**。

### 5.1 分层职责

| 层 | 机制 | 来源依据 |
| --- | --- | --- |
| 技术保险 | `recursionLimit` 设为很高值 | 默认 25 会误伤，但它不是业务规则 |
| 卡死检测 | model node 的 `idleTimeout`（`refreshOn: "heartbeat"` 或 `"auto"`） | LangGraph 唯一的进展语义 |
| 空转检测 | **自建**：重复调用指纹 | 无任何第一方实现可复用 |
| 网络重试 | model node 的 `retryPolicy`（`maxAttempts: 3`），并关闭 AI SDK 内层重试 | 避免次数相乘；LangGraph 已默认排除 4xx |
| 业务预算 | Companion 领域代码 | 任务数/尝试数/修复次数，与上述无关 |
| 取消 | `RunControl.requestDrain()` + `AbortSignal` | drain 不取消在途工作，官方要求配对使用 |
| 服务器 pause | 透传 `pause_turn`（原样送回） | Anthropic 独有 |

### 5.2 空转检测的最小设计

【推断/建议】以下为设计提案，非一手来源结论。

在 **tool node** 里（而不是 stop condition 里）维护一个指纹窗口。每个已提交 tool call 计算：

```text
fingerprint = hash(toolName, canonicalizedInput, expectedRevision)
```

熔断条件：**连续 K 次出现完全相同的 fingerprint，且返回结果或错误也相同**。建议 K = 3。

必须实现的两条"有进展"重置：

1. 拿到了**不同**的结果或错误 → 重置计数（即使 fingerprint 相同，进度已变化）。
2. 权威 revision 变化（tracker/Git/Orca 任一） → 重置计数，因为 `expectedRevision` 已经不同。

必须豁免的形态：

- 轮询类工具（`get_task_state`、`wait` 等）不进窗口，由各自的退避与超时控制。
- `pause_turn` 类服务器恢复不计入。

熔断动作：同步 checkpoint → 以 `loop_stalled` `interrupt()` 请求用户处理，**不静默终止、不自动换模型、不重置计数**。

### 5.3 必须区分的计数与重置规则

参考 Claude Code 恢复时重置 turn 计数的做法（[goal 文档](https://docs.claude.com/en/docs/claude-code/goal)），Companion 需要显式区分：

| 计数 | 归属 | 恢复后 |
| --- | --- | --- |
| 空转重复次数 | 单次 tool loop | 保留（否则恢复即可绕过熔断） |
| 网络重试次数 | 单次 model node 尝试 | 保留 |
| 业务预算（任务/尝试/修复） | workflow | 保留（地图已定） |
| `recursionLimit` 计数 | 单次 graph invoke | 由运行时重置，仅技术用途 |

### 5.4 可测试断言

以下每条只依赖上层可观察行为，不锁定实现：

1. 连续 3 次相同工具 + 相同输入 + 相同结果 → 产生 `loop_stalled` 中断，且 Session 可从该 checkpoint 恢复。
2. 同一工具连续调用但结果不同 → **不**熔断。
3. 权威 revision 改变后的相同调用 → **不**熔断。
4. 100 次互不相同的工具调用 → **不**熔断（长链正常）。
5. 熔断后恢复再跑，计数**不**归零。
6. 取消后进行中工具的对账完成前不重复派发。
7. `pause_turn` 原样送回，不计入任何熔断计数。

## 6. 未验证项与已知缺口

1. **取消的可区分性**（4.4 节）与既有研究结论冲突，需真实探针确认。
2. `idleTimeout` 的默认 `refreshOn: "auto"` 在 AI SDK 场景下的实际行为未验证：AI SDK 的 token 回调是否被 LangGraph 认定为"后代 callback 事件"、从而不断刷新 idle 时钟，需要实测。若会刷新，必须改用 `refreshOn: "heartbeat"`。
3. 本报告未验证 `recursionLimit` 的"很高值"具体取多少；需在 M1 按实际图深度测量后确定。
4. 空转检测的 K 值与指纹规范化方式（`canonicalizedInput` 如何排序对象键、如何处理时间戳字段）未验证，需要在真实长链任务上校准。
5. Anthropic 的 `compaction` stop reason 在本项目的 context 压缩路径上是否可复用，未验证（它要求服务端 compaction beta，且与 Companion 自己生成 Context Capsule 的决策有重叠）。
6. **Codex 无可确认的公开 turn 上限**，本报告未纳入；若后续需要，应从 `openai/codex` 的 `codex-rs/core` 源码而非文档确认。

## 7. 引用索引

一手来源清单（按首次使用顺序）：

- [Vercel AI SDK — Loop Control](https://github.com/vercel/ai/blob/main/content/docs/03-agents/04-loop-control.mdx)
- [Vercel AI SDK — `stop-condition.ts`](https://github.com/vercel/ai/blob/main/packages/ai/src/generate-text/stop-condition.ts)
- [Vercel AI SDK — `tool-loop-agent.ts`](https://github.com/vercel/ai/blob/main/packages/ai/src/agent/tool-loop-agent.ts)
- [Vercel AI SDK — Error handling（`onAbort`）](https://github.com/vercel/ai/blob/main/content/docs/03-ai-sdk-core/50-error-handling.mdx)
- [OpenAI Agents SDK JS — Running Agents](https://github.com/openai/openai-agents-js/blob/main/docs/src/content/docs/guides/running-agents.mdx)
- [OpenAI Agents SDK JS — Human-in-the-loop](https://github.com/openai/openai-agents-js/blob/main/docs/src/content/docs/guides/human-in-the-loop.mdx)
- [OpenAI Agents SDK JS — `errors.ts`](https://github.com/openai/openai-agents-js/blob/main/packages/agents-core/src/errors.ts)
- [OpenAI Agents SDK JS — `runState.ts`](https://github.com/openai/openai-agents-js/blob/main/packages/agents-core/src/runState.ts)
- [Anthropic — `BetaToolRunner.ts`](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/lib/tools/BetaToolRunner.ts)
- [Anthropic — `helpers.md`](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/helpers.md)
- [Anthropic — Stop reasons and fallback](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons)
- [Anthropic — Tool runner (SDK)](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-runner)
- [Claude Code — CLI reference](https://docs.claude.com/en/docs/claude-code/cli-reference)
- [Claude Code — Sessions](https://docs.claude.com/en/docs/claude-code/sessions)
- [Claude Code — Keep Claude working toward a goal](https://docs.claude.com/en/docs/claude-code/goal)
- [Claude Agent SDK — TypeScript options](https://code.claude.com/docs/en/agent-sdk/typescript)
- [Claude Agent SDK — Sessions](https://code.claude.com/docs/en/agent-sdk/sessions)
- [LangGraph — Fault tolerance](https://github.com/langchain-ai/docs/blob/main/src/oss/langgraph/fault-tolerance.mdx)
- [LangGraph — Persistence](https://github.com/langchain-ai/docs/blob/main/src/oss/langgraph/persistence.mdx)
- [LangGraph — Interrupts](https://github.com/langchain-ai/docs/blob/main/src/oss/langgraph/interrupts.mdx)
- [LangGraph — Use time-travel](https://github.com/langchain-ai/docs/blob/main/src/oss/langgraph/use-time-travel.mdx)
- [LangGraph — GRAPH_RECURSION_LIMIT](https://github.com/langchain-ai/docs/blob/main/src/oss/langgraph/errors/GRAPH_RECURSION_LIMIT.mdx)
- [LangGraph JS — `config.ts`](https://github.com/langchain-ai/langgraphjs/blob/main/libs/langgraph-core/src/pregel/utils/config.ts)

