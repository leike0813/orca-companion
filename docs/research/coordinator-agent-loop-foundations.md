# 独立协调 agent loop 的可复用基础

对应 ticket：[*核验独立协调 agent loop 的可复用基础*](https://github.com/leike0813/orca-companion/issues/15)（父地图 [#1](https://github.com/leike0813/orca-companion/issues/1)）。

结论先行：**协调 agent 自己的模型 loop 用 Vercel AI SDK（`ai`）+ 单一 provider 包实现**，它同时覆盖模型调用、tool loop、流式输出、步骤预算、逐步工具暴露、工具审批与取消信号，是本次核验中唯一在 Node 24 上跑通全部五项的一手方案。**会话保存/恢复不外包**：AI SDK 不提供对话存储，而 LangGraph 的 checkpointer 虽然在本机验证可用，但地图 #6/#9 已决定协调状态的权威源是 tracker/Git/OpenSpec/Orca，因此只把 LangGraph 记为已验证的备选，不作为 M1 的默认权威状态源。

## 1. 核验环境与方法

| 项 | 值 | 来源 |
| --- | --- | --- |
| Node.js | v24.12.0（ABI `modules`=137，V8 13.6） | 本机 `node -v`、`process.versions` |
| 包管理器 | pnpm 11.10.0、npm 11.6.2 | 本机 `pnpm -v`、`npm -v` |
| 仓库基线 | `package.json` engines `node>=24`、`pnpm>=11`；`.nvmrc`=24.12.0；当前无运行时依赖 | 仓库 `package.json`、`.nvmrc` |
| 模型凭据 | `DEEPSEEK_API_KEY`、`OPENROUTER_API_KEY` 已设置；`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`AI_GATEWAY_API_KEY` 未设置 | 本机环境变量存在性检查（只看有无，不读取值） |
| 本机 harness CLI | codex、claude、opencode、kilo、pi、omp、gemini 均存在；`~/.codex/auth.json` 存在 | 本机 `command -v`、文件存在性检查 |

方法限定：版本与维护状态取自 npm registry 与 GitHub 官方 API 的实时元数据；能力语义取自各项目官方文档；兼容性用一次**真实安装 + 冷启动 + 真 provider 调用**的探针验证，而不是只读 `engines` 声明。探针全部在 `mktemp -d` 的临时目录中进行，未改动本仓库、未创建 Orca Run/Task/Dispatch、未派发 worker。

## 2. 稳定版本与 Node.js 24 兼容性

全部为 2026-09-18 查询 npm registry 的当前 `dist-tags.latest`：

| 包 | 最新稳定版 | 发布日 | `engines.node` | 来源 |
| --- | --- | --- | --- | --- |
| `ai` | 7.0.105 | 2026-09-16 | `>=22` | [npm](https://www.npmjs.com/package/ai)、[vercel/ai](https://github.com/vercel/ai) |
| `@ai-sdk/openai` | 4.0.69 | 2026-09-16 | `>=22` | [npm](https://www.npmjs.com/package/@ai-sdk/openai) |
| `@ai-sdk/anthropic` | 4.0.56 | — | `>=22` | [npm](https://www.npmjs.com/package/@ai-sdk/anthropic) |
| `@ai-sdk/deepseek` | 3.0.47 | 2026-09-16 | `>=22` | [npm](https://www.npmjs.com/package/@ai-sdk/deepseek) |
| `@ai-sdk/openai-compatible` | 3.0.51 | 2026-09-16 | `>=22` | [npm](https://www.npmjs.com/package/@ai-sdk/openai-compatible) |
| `@ai-sdk/gateway` | 4.0.85 | — | `>=22` | [npm](https://www.npmjs.com/package/@ai-sdk/gateway) |
| `@langchain/langgraph` | 1.4.15 | 2026-09-12 | `>=18` | [npm](https://www.npmjs.com/package/@langchain/langgraph) |
| `@langchain/core` | 1.2.11 | 2026-09-12 | `>=20` | [npm](https://www.npmjs.com/package/@langchain/core) |
| `@langchain/langgraph-checkpoint` | 1.1.5 | — | `>=18` | [npm](https://www.npmjs.com/package/@langchain/langgraph-checkpoint) |
| `@langchain/langgraph-checkpoint-sqlite` | 1.0.4 | 2026-08-19 | `>=18` | [npm](https://www.npmjs.com/package/@langchain/langgraph-checkpoint-sqlite) |
| `better-sqlite3` | 13.0.3（saver 实际装 12.11.1） | 2026-08-05 | `>=22`（12.11.1 为显式 `20.x–26.x`） | [npm](https://www.npmjs.com/package/better-sqlite3) |
| `@openai/agents` | 0.18.0 | 2026-09-10 | 未声明 | [npm](https://www.npmjs.com/package/@openai/agents) |
| `@openai/agents-core` | 0.18.0 | — | 未声明 | [npm](https://www.npmjs.com/package/@openai/agents-core) |
| `@anthropic-ai/claude-agent-sdk` | 0.3.274（`next`=0.3.275） | 2026-09-16 | `>=18` | [npm](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) |
| `openai` | 7.17.0 | 2026-09-16 | `>=22` | [npm](https://www.npmjs.com/package/openai) |
| `@modelcontextprotocol/sdk` | 1.30.0 | 2026-07-27 | `>=18` | [npm](https://www.npmjs.com/package/@modelcontextprotocol/sdk) |
| `@openai/codex-sdk` | 0.154.0 | 2026-09-09 | `>=18` | [npm](https://www.npmjs.com/package/@openai/codex-sdk) |
| `zod` | 4.6.5 | — | 未声明 | [npm](https://www.npmjs.com/package/zod) |

维护状态的客观证据（GitHub 官方 API，2026-09-18）：`vercel/ai` pushed 2026-09-17、未归档、26.8k stars；`openai/openai-agents-js` pushed 2026-09-16、MIT；`langchain-ai/langgraphjs` pushed 2026-09-17、MIT；上游 CI 覆盖 Node 24（vercel/ai 矩阵 `[22,24,26]`，见 [ci.yml](https://github.com/vercel/ai/blob/main/.github/workflows/ci.yml)；openai-agents-js 矩阵 `['22','24.3.x']`，见 [test.yml](https://github.com/openai/openai-agents-js/blob/main/.github/workflows/test.yml)）。两侧均在 CI 中真实跑 Node 24，而不是仅放宽 `engines`。

### 2.1 本机实测（Node 24.12.0）

一次安装 `ai@7.0.105 @ai-sdk/openai@4.0.69 @openai/agents@0.18.0 @langchain/langgraph@1.4.15 @langchain/core@1.2.11 @langchain/openai@1.5.13 zod@4.6.5`：**added 55 packages in 11s，无 engine 警告**（npm 11 在 `engines` 不满足时会警告，未出现即声明与实际一致）。

| 探针 | 结果 |
| --- | --- |
| `ai`：构造 `ToolLoopAgent`（含 `tool()`/`inputSchema`） | 通过，导出为 `function` |
| `ai`：真 provider tool loop（DeepSeek `deepseek-v4-flash`） | 通过；模型调用 `add` 工具后返回 `"42"`，`steps=2`、`toolCalls=[add]` |
| `ai`：真 provider 流式输出 | 通过，`textStream` 逐块产出 |
| `@langchain/langgraph`：`StateGraph` + `MemorySaver` + `getState` | 通过，checkpoint 可读回 |
| `@langchain/langgraph-checkpoint-sqlite`：`SqliteSaver.fromConnString` 落盘 | 通过；**跨进程**验证：进程 1 写、进程 2 读回 `"persisted-turn"` |
| `better-sqlite3` 原生模块 | 通过，ABI 137 下 `new Database(':memory:')` 正常（安装期有 `prebuild-install` 弃用警告） |
| `node:sqlite`（Node 内置） | 可用：`DatabaseSync/StatementSync/backup`，带 ExperimentalWarning |
| `@openai/agents`：`Runner.run` + `ScriptedModel` | 通过，`finalOutput="hello"`；`RunState.toString()` 得 1909 字符可序列化状态 |

结论：**Node 24 兼容性不是纸面声明**。`ai`、LangGraph 全家（含原生 SQLite saver）与 `@openai/agents` 均在本机 Node 24.12.0 冷启动并执行成功。

## 3. 五项能力的逐项核验

### 3.1 模型调用与 provider 范围

`ai` 通过 `LanguageModelV3` 接口统一 provider；官方第一方 provider 覆盖 OpenAI、Anthropic、Google/Vertex、xAI、Mistral、Cohere、DeepSeek、Moonshot、Groq、Alibaba、Cerebras 等（[官方 provider 列表](https://ai-sdk.dev/providers/ai-sdk-providers)），并提供 `@ai-sdk/openai-compatible` 对接任意 OpenAI 兼容端点（[npm](https://www.npmjs.com/package/@ai-sdk/openai-compatible)）。OpenRouter 等第三方 provider 存在但属社区维护。

一个必须提前知道的默认值：**裸字符串模型 id 会走 Vercel AI Gateway**。源码中 `globalThis.AI_SDK_DEFAULT_PROVIDER ?? gateway`（`ai@7.0.105` 发行产物 `dist/index.js`）意味着 `model: "openai/gpt-5"` 需要 `AI_GATEWAY_API_KEY`。本机未设置该变量，因此协调器必须显式传入 provider 实例（如 `deepseek("...")`），不能依赖字符串 id。这一点直接影响部署，不是风格问题。

### 3.2 tool loop 与步骤预算

`ToolLoopAgent` 封装了上下文维护与停止条件；默认 `stopWhen: isStepCount(20)`（发行产物 `dist/index.js` 第 11584 行；文档见 [Loop Control](https://ai-sdk.dev/docs/agents/loop-control)）。可选条件包括 `isStepCount(n)`、`hasToolCall(...)`、`isLoopFinished()` 以及接收全部 `steps` 的自定义函数，可组合成数组取"任一满足即停"。

这两点正好对上地图 #1 的既有约束：步骤/尝试预算由代码强制，且自定义 `StopCondition` 能按累计 token 或成本止损（官方示例即按累计用量估算成本后停止）。

`prepareStep` 每步可返回 `activeTools`/`toolChoice` 覆盖，实现**按阶段动态暴露工具**；官方示例是搜索阶段只暴露 `search`、分析阶段只暴露 `analyze`。这直接对应地图决策 [#5](https://github.com/leike0813/orca-companion/issues/5)"协调工具按 Route Map、Worker 运行和共享审阅分层并动态暴露"。

`toolApproval` 支持 per-tool 状态（`not-applicable`/`approved`/`denied`/`user-approval`）与基于工具输入、`runtimeContext` 的判定函数（[Tool Approvals](https://ai-sdk.dev/docs/agents/tool-approvals)），可作为"副作用前核验"的载体——但它是 AI SDK 侧的执行前审批，不能替代 Companion 自己的状态版本与操作 ID 校验。

`runtimeContext`/`toolsContext` 提供不进入 prompt 的服务端状态与 per-tool 上下文（[Runtime and Tool Context](https://ai-sdk.dev/docs/ai-sdk-core/runtime-and-tool-context)），适合承载 controller 下发的 scope/身份/预算。

### 3.3 流式输出

`ToolLoopAgent.stream()` 与 `streamText()` 提供 `textStream`、`fullStream`、`steps`、`usage`、`finishReason` 等增量与控制面（[streamText 参考](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text)）。用法与 TUI 消费方式无关，可直接喂给 Ink 组件；`@ai-sdk/tui` 存在但面向独立终端 demo，不适用本项目的状态机边界。

### 3.4 会话保存/恢复

**AI SDK 不提供对话存储**：消息数组由调用方持有与持久化，`prepareStep`/生命周期钩子是接入点而非存储。官方"记忆"章节列出的都是外部或社区方案（Letta、Mem0、Supermemory、MongoDB 等）与自建 custom tool（[Memory](https://ai-sdk.dev/docs/agents/memory)）。官方多轮持久化示例落在 UI 层（[Chatbot Message Persistence](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence)），与无 TTY 的 control plane 无关。

`@openai/agents` 反而提供了一等会话抽象：`Session` 接口（`getSessionId`/`getItems`/`addItems`/`popItem`/`clearSession`，并带事务与 compaction 的可选能力），内置 `MemorySession`（仅开发用途）与 `OpenAIConversationsSession`，且可从 `RunState` 序列化后恢复（[Sessions](https://openai.github.io/openai-agents-js/guides/sessions/)）。但它的持久实现绑定 OpenAI Conversations API，本机无相应凭据。

LangGraph 一侧：`BaseCheckpointSaver` 负责 thread 级图状态，`MemorySaver` 仅内存、重启即失；持久方案为 PostgresSaver 或 `SqliteSaver`（[Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)、[Checkpointers](https://docs.langchain.com/oss/javascript/langgraph/checkpointers)）。本机已验证 `SqliteSaver` 跨进程恢复可用。

### 3.5 取消

这是本次核验中**最需要拨正预期**的一项。对真 provider（DeepSeek）实测 `abortSignal`：

| 场景 | 实际行为 |
| --- | --- |
| `abort()`（无 reason），且调用方只 drain `textStream` | **不抛错**，流正常结束 |
| `abort(new Error(...))` | 抛 `AI_APICallError`（`statusCode: 200`、`isRetryable: false`、`cause` 为自定义 reason） |
| `@ai-sdk/provider-utils` 的 `isAbortError` 判定 | 对上述错误返回 `false`；对 `DOMException("AbortError")` 返回 `true` |
| `onAbort` 回调 | 两次探针均**未触发** |
| 取消后的终态读取（`result.text`/`finishReason`/`steps`） | 与 drain 路径不同：`text` 可能返回已收到的部分文本，`finishReason`/`steps` 可能 reject |

含义：库层的取消是"停止请求"，**不产生可区分的取消语义**。协调器不能把 `aborted` 直接当成业务结果，必须按 `AGENTS.md` 的 `OperationOutcome` 自行判定 `accepted/rejected/unknown`，并把取消记为控制状态。`@openai/agents` 的流式取消同样不提供干净标记：实测中止后流抛错、`stream.cancelled` 仍为 `false`、`stream.completed` reject（官方文档要求"取消后仍须 await `stream.completed`"）。

## 4. 与地图 #1 系统边界的关系

地图 #1 明确：Companion 只运行总协调 agent，worker 由 Orca 派发到现有 harness；不实现 provider 网关、worker coding harness、通用上下文压缩。据此逐项判断：

| 地图约束 | 本次核验的结论 |
| --- | --- |
| 不自制 provider 网关与认证 | `ai` 提供 provider 抽象，但不是网关：认证仍依赖各 provider 凭据（本机为 DeepSeek/OpenRouter），字符串 id 反而绑定 Vercel 网关。采用 provider 实例即可，无需自建网关。 |
| worker 由 Orca 派发 | `@ai-sdk/harness*` 与 `@anthropic-ai/claude-agent-sdk`、`@openai/codex-sdk` 能自己跑 Codex/Claude Code/Pi harness，但这与 Orca 的职责重叠，属地图 #1 的 Out of scope；且 harness 包官方标注 **experimental**（[Codex Harness](https://ai-sdk.dev/providers/ai-sdk-harnesses/codex)）。 |
| 不实现通用上下文压缩 | 库内**没有**可复用的语义压缩：`ai` 只给机械剪枝 `pruneMessages`，LangGraph 的压缩属应用逻辑。这印证"不实现"是对的，也说明不存在"顺手复用"的捷径。 |
| 不实现通用 inbox/SQLite/业务 checkpoint | `SqliteSaver` 已验证可用，但地图 #9 已定权威源为 tracker/Git/Orca，故只作备选；若将来确需本地 SQLite，Node 24 内置 `node:sqlite` 可免原生构建（当前为实验特性）。 |
| 状态转换与预算由代码强制 | `stopWhen`/`prepareStep`/`toolApproval` 是合适的**执行机制**，语义仍须留在 Companion 自己的应用层，与 `AGENTS.md` 的"LangGraph 是执行机制、业务规则留在普通模块"同构。 |

## 5. 推荐

**协调器 loop 采用 `ai`（7.0.105）+ 显式 provider 包**，理由是它在本次核验中同时满足：Node 24 实测通过、CI 覆盖 Node 24、一周内仍在发版、五项能力齐备、且与控制面需求（步骤预算、动态工具暴露、工具审批、不进入 prompt 的 runtime context）逐条对应。

具体取舍：

1. provider 用实例而非字符串 id，避免隐含的 Vercel 网关依赖；本机现有 DeepSeek/OpenRouter 凭据即可跑通。
2. 对话状态自己持有：把 `steps`/消息序列按 Companion 的 schema 持久化，不引入 LangGraph checkpointer 作为权威源。
3. 把 `stopWhen` 作为**预算执行器**之一，但业务计数（任务数、尝试数、修复次数、并发）仍由 Companion 代码维护，避免 `recursion_limit` 式替代。
4. 取消一律走 Companion 自己的状态机：库层取消不可区分，必须自行落"取消意图 + 未确认/已确认"。
5. LangGraph 与 `SqliteSaver` 记为**已验证备选**：若 M1 之后确需图级持久化，本机已有可用路径，无需重新选型。

## 6. 不可复用边界

以下不是"暂未实现"，而是这些库按设计不提供，必须由 Companion 或 Orca 承担：

1. **provider 网关与凭据代理**：`ai` 只做模型抽象；无多租户凭据托管、配额或密钥轮换。裸字符串 id 反向依赖 Vercel AI Gateway（需 `AI_GATEWAY_API_KEY`）。
2. **worker coding harness**：不在本方案内。若需，那是 Orca 的派发职责；`@ai-sdk/harness*` 与厂商 agent SDK 均标 experimental，且自行在 sandbox 内跑 Codex/Claude Code。
3. **通用上下文压缩**：仅机械 `pruneMessages` 与 `prepareStep` 钩子；语义摘要需自建，而地图已将其排除。
4. **可区分的取消语义**：取消表现为普通 API 错误或不报错，`isAbortError` 对 abort-reason 错误返回 false，`onAbort` 未触发。不能作为业务终态。
5. **状态权威与 exactly-once**：checkpoint 只是图状态持久化。官方明示 `async` 耐久模式在崩溃时可能未写入，`MemorySaver` 不跨重启（[Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)）。节点重入仍可能重放外部副作用。
6. **MCP 只是传输层**：`@modelcontextprotocol/sdk` 提供协议与 transport，业务 handler 与权限判定不属其内，与 `AGENTS.md` 的"handler 不依赖 MCP"一致。
7. **默认遥测外发**：`@openai/agents` 在 server runtime 默认启用 tracing（[文档](https://openai.github.io/openai-agents-js/guides/agents/)），本地 control plane 若采用须显式关闭。

## 7. 未验证项与风险

- `@ai-sdk/harness*`（1.0.115/1.0.117/1.0.119）仅核验了版本、`engines>=22` 与官方 experimental 标注，**未做安装或运行验证**，因其落在 Out of scope。
- `@openai/agents` 未声明 `engines`，npm 不会拦截不兼容 Node；其真实下限来自官方文档的 Node 22+ 与 CI 矩阵。
- 取消行为仅在 `ai` + DeepSeek 与 `@openai/agents` 两处实测；不同 provider 的错误包装可能不同，M1 实现时应对目标 provider 重跑该项。
- 真 provider 探针只覆盖单 provider（DeepSeek）；OpenRouter 路径未实测。
- 未验证 Windows 11；本轮只覆盖当前本机环境，与地图 #1 的 Out of scope 一致。

## 来源

- npm registry 元数据（版本、发布日、`engines`、peer）：上述各包的 `registry.npmjs.org/<pkg>` 实时查询。
- GitHub 官方 API：仓库 `pushed_at`/`archived`/`stargazers` 与最新 release。
- Vercel AI SDK 官方文档：<https://ai-sdk.dev/docs/agents/overview>、<https://ai-sdk.dev/docs/agents/loop-control>、<https://ai-sdk.dev/docs/agents/tool-approvals>、<https://ai-sdk.dev/docs/agents/memory>、<https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text>、<https://ai-sdk.dev/providers/ai-sdk-providers>。
- OpenAI Agents SDK (TS) 官方文档：<https://openai.github.io/openai-agents-js/guides/sessions/>、<https://openai.github.io/openai-agents-js/guides/agents/>。
- LangGraph JS 官方文档：<https://docs.langchain.com/oss/javascript/langgraph/persistence>、<https://docs.langchain.com/oss/javascript/langgraph/checkpointers>。
- 本机探针：`docs/research/` 同批核验使用的临时目录安装与运行记录（Node 24.12.0）。

