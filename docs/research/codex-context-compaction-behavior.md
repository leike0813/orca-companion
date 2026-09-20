# Codex 的上下文 compaction 行为（源码级只读研究）

对应 ticket：[*定义 Coordinator 的缓存保活与上下文压缩协议*](https://github.com/leike0813/orca-companion/issues/31)（父地图 [规划 Orca Companion M0–M2 的实现路径](https://github.com/leike0813/orca-companion/issues/1)）。本文件只回答该票 Q13 及相邻问题，不做 Orca Companion 的产品决策。

研究对象：[openai/codex](https://github.com/openai/codex) Rust CLI。

```text
commit SHA: 78245b47af2a7aafcabe025828ceecca69db4df1
commit date: 2026-09-19T02:56:24Z
subject: Deny XPC service lookups in macOS Seatbelt profiles (#46583)
```

下文所有源码链接都固定在该 SHA 的 permalink 上，行号即该 commit 的行号。查询时间 2026-09-19。

## 结论先行

1. **Codex 的 compaction 不是“选一段旧消息做总结”，而是整窗口的 checkpoint 替换**。它以可复用的稳定前缀为输入，产出一个可继续推理的替换历史，并把被替换前的上下文当作已消费。没有任何“只挑最老的连续闭合区间”的概念。
2. **触发点有五个，全部由运行时状态决定，不由模型或 UI 选择区间**：manual `/compact`、pre-turn、mid-turn、post-turn、previous-model/downshift。
3. **local 与 remote 是同一 lifecycle 的两个 implementation**。provider 是 OpenAI/Azure Responses 时走 remote（服务端 `/responses` + `compaction_trigger` 项），否则走 local（用同一个模型发一次人工摘要请求）。
4. **失败与超窗是显式处理的分支**：流错误有限重试；`ContextWindowExceeded` 时 local 从最老项开始删并重置重试计数，remote 先重写最老的 function-call 输出以塞进窗口；仍失败才向上抛。
5. **保留不是“最近 N 条”**，而是按 item 类型白名单 + 预算：user/hook 消息、非进度非终局的 agent 消息、可选 client developer 消息，总预算 64k tokens。

## 1. 触发条件

### 1.1 manual（用户显式）

`/compact` 走 app-server 的 `Op::Compact`，落到 `CompactTask`。它按 provider 能力分派：token-budget 特性开启时走不总结的窗口重置，OpenAI remote 支持 V2 时走 remote，否则走 local 总结。[tasks/compact.rs#L28-L57](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/tasks/compact.rs#L28-L57)

manual 的语义标记是 `CompactionTrigger::Manual`、`CompactionReason::UserRequested`、`CompactionPhase::StandaloneTurn`，并且是唯一先 `emit_turn_started` 的路径；注释明确说明为什么它要在 summary 应用前避免重新注入上下文。[compact.rs#L146-L163](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/compact.rs#L146-L163) [tasks/user_shell.rs#L121-L126](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/tasks/user_shell.rs#L121-L126) TUI 侧把它描述为 “summarize conversation to prevent hitting the context limit”。[tui/src/slash_command.rs#L93](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/tui/src/slash_command.rs#L93)

### 1.2 自动：阈值判定

阈值计算集中在 `context_window_token_status`，它同时算四个不同的量：[session/context_window.rs#L52-L128](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/session/context_window.rs#L52-L128)

| 量 | 来源 | 默认 |
| --- | --- | --- |
| auto-compact scope | `model_auto_compact_token_limit_scope`：`Total`（默认）或 `BodyAfterPrefix` | `Total` |
| scope limit | 配置值与该模型上限的较小者 | 模型上下文窗口的 9/10 |
| 硬上限 | 模型可用窗口百分比 | `effective_context_window_percent = 95` |
| turn-end 阈值 | `model_post_turn_compact_threshold_percent` | 0 即关闭 |

模型默认上限来自 `ModelInfo::auto_compact_token_limit()`：`(resolved_context_window * 9) / 10`，配置值只能取更小。[openai_models.rs#L525-L538](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/protocol/src/openai_models.rs#L525-L538) 硬上限用 `effective_context_window_percent`（默认 95）折算。[openai_models.rs#L389-L391](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/protocol/src/openai_models.rs#L389-L391)

`token_limit_reached` = scope 超限 **或** 硬上限已达；`turn_end_compaction_threshold_reached` 额外看百分比，且只在 `post_turn_percent > 0` 时有意义。[context_window.rs#L104-L121](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/session/context_window.rs#L104-L121)

### 1.3 自动：四个 phase

| phase | 位置 | 触发 |
| --- | --- | --- |
| PreTurn | 每次采样前 | 换模型/comp-hash 变化，或该模型 token 上限已达 |
| MidTurn | 采样后、需要 follow-up 时 | `needs_follow_up && (request_new_context_window \|\| token_limit_reached)` |
| PostTurn | 最后一轮回复结束后 | `model_post_turn_compact_threshold_percent` 达到且无 pending input |
| Guardian 兜底 | 采样返回 `ContextWindowExceeded` | exhausted review budget 时补一次 mid-turn |

PreTurn 入口：[turn.rs#L1274-L1301](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/session/turn.rs#L1274-L1301)。MidTurn：`should_roll_over` 判定与执行在 [turn.rs#L602-L635](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/session/turn.rs#L602-L635)。PostTurn：只在 `config.model_post_turn_compact_threshold_percent > 0`、非 token-budget、无 pending input、未取消时执行，失败只 warn 并保留已完成的 turn。[turn.rs#L708-L735](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/session/turn.rs#L708-L735)

PreTurn 还有一条与缓存保活直接相关的路径：**换模型或 compaction 兼容哈希变化时，用上一个模型先压一次**。`comp_hash_changed` 只在两个 hash 都存在且不等时为真；缺失 hash 不触发。[turn.rs#L1305-L1311](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/session/turn.rs#L1305-L1311) [turn.rs#L1338-L1389](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/session/turn.rs#L1338-L1389)

## 2. 提交给 compact 的完整输入

local 和 remote 的输入组装不同，但都基于同一份“当前历史快照 + 当前 system 指令”。

### 2.1 local（人工摘要）

`run_compact_task_inner_impl`：克隆历史 → 把合成的 compaction prompt 作为一条 user input 追加 → `for_prompt()` 规范化为模型可见输入 → 用**同一个模型**发一次普通请求。[compact.rs#L250-L300](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/compact.rs#L250-L300)

输入里的 prompt 可由 `compact_prompt` 配置或文件覆盖，默认是模板：

> You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task. [prompts/templates/compact/prompt.md](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/prompts/templates/compact/prompt.md)

同时把已执行的 tool call 附着进 prompt（`attach_to_compaction_prompt`），`base_instructions` 用当前 session 指令，`Prompt` 其余字段默认。[compact.rs#L276-L287](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/compact.rs#L276-L287)

### 2.2 remote（服务端 compaction）

`run_remote_compact_v2_attempt` 的输入构造更复杂，关键点：[compact_remote_v2_attempt.rs#L30-L100](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/compact_remote_v2_attempt.rs#L30-L100)

- 先对历史做一次**保窗口裁剪** `trim_function_call_history_to_fit_context_window`：从最新往旧走，超窗时把 function-call 输出重写成一句 “Output exceeded the available model context and was truncated”，保证请求本身能发出去，同时按前缀保留缓存。[compact_remote_history.rs#L68-L138](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/compact_remote_history.rs#L68-L138)
- 用 `for_prompt_annotated` 取规范化的 item + metadata；**不带 output schema**，但**带当前 model-visible 的 tool specs** 与 `parallel_tool_calls = true`。[compact_remote_v2_attempt.rs#L57-L77](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/compact_remote_v2_attempt.rs#L57-L77)
- 在输入**末尾追加一个 `ResponseItem::CompactionTrigger {}`** 作为请求控制项；它只在请求里出现，不是持久 response item。[compact_remote_v2_attempt.rs#L78](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/compact_remote_v2_attempt.rs#L78) [protocol/src/models.rs#L1240-L1241](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/protocol/src/models.rs#L1240-L1241)
- 请求携带 `CompactionTurnMetadata`（trigger/reason/implementation/phase/strategy），走 **`/responses` 路径**，不是单独的 `/responses/compact` 端点。[responses_metadata.rs#L109-L135](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/responses_metadata.rs#L109-L135)

### 2.3 initial context 怎么处理

`InitialContextInjection` 决定是否把完整初始上下文（system/developer 段）注回替换历史：[compact.rs#L63-L95](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/compact.rs#L63-L95)

- PreTurn/Manual 用 `DoNotInject`：替换后清空 `reference_context_item`，让下一次正常 turn 自己重新注入初始上下文。
- MidTurn 用 `BeforeLastUserMessage`：因为模型被训练为把 summary 看作 last item，所以把初始上下文插到最后一个真实 user 消息之前（没有真实 user 消息就插到 summary 之前，保证 summary 仍在最后）。[compact.rs#L606-L672](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/compact.rs#L606-L672)

## 3. 保留/重建的 items

### 3.1 local：只留 user 消息 + 新 summary

`compacted_user_message` 只把 `TurnItem::UserMessage` 收集为保留项，且**丢弃上一轮 summary 自身**（`is_summary_message` 按 SUMMARY_PREFIX 前缀判断）。[compact.rs#L578-L604](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/compact.rs#L578-L604)

`build_compacted_history` 从最新往旧回填 user 消息，总预算 `COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000`；超预算的最后一条会被 `truncate_text` 截断；然后追加一条带 SUMMARY_PREFIX 的 summary。[compact.rs#L60](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/compact.rs#L60) [compact.rs#L674-L760](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/compact.rs#L674-L760)

summary 文本 = `SUMMARY_PREFIX + "\n" + 模型最后一条 assistant 文本`；空则写 `(no summary available)`。前缀文案是 “Another language model started to solve this problem and produced a summary…”。[summary_prefix.md](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/prompts/templates/compact/summary_prefix.md)

### 3.2 remote：按类型白名单保留 + 服务端 compaction item

`is_retained_for_remote_compaction_v2` 的规则：[compact_remote_v2.rs#L556-L597](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/compact_remote_v2.rs#L556-L597)

| item | 是否保留 |
| --- | --- |
| `role=user` 且能解析为 UserMessage/HookPrompt | 保留 |
| `role=developer` 且 client-authored | 仅 `RetainClientDeveloperMessages` 开启时 |
| AgentMessage 且是 descendant progress（`MESSAGE`）或 completion（`FINAL_ANSWER`） | 丢弃 |
| 其他 AgentMessage，且 ≤ 10_000 tokens | 保留 |
| 其余（tool call/output、reasoning 等） | 保留为原始 item，参与 64k 预算 |

保留集合整体受 `RETAINED_MESSAGE_TOKEN_BUDGET = 64_000` 约束，超预算时按同样的近似 token 计数裁剪。[compact_remote_v2.rs#L75-L76](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/compact_remote_v2.rs#L75-L76) [compact_remote_v2.rs#L505-L531](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/compact_remote_v2.rs#L505-L531)

服务端返回的 `ResponseItem::Compaction { encrypted_content }`（可别名 `compaction_summary`）是**不透明 provider item**，Codex 原样保存用于后续请求。[protocol/src/models.rs#L1226-L1235](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/protocol/src/models.rs#L1226-L1235)

## 4. 输出如何替换 model-visible history

`replace_compacted_history` 是唯一的替换出口：[session/mod.rs#L3936-L4010](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/session/mod.rs#L3936-L4010)

- 给缺 id 的 item 补 id；在最后一个 Compaction/ContextCompaction item 上写 `compaction_model_hash`；
- 组装 `CompactedItem`：message、`replacement_history`、window number/ids、compaction response id、当时 token usage；
- 在 settings 持久化锁下做 `state.replace_annotated_history(..., HistoryReplacement::Compaction)`，并 pin `ReasoningEffortPin::Compacted`；
- 把 baseline world state 作为 `RolloutItem::WorldState` 持久化，reference turn context 作为 `RolloutItem::TurnContext`，最后追加 settings event。

替换历史随后成为模型可见历史；旧的原始 items 不再进入后续请求。window 通过 `advance_auto_compact_window()` 递增并换新 window id。[state/auto_compact_window.rs#L78-L88](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/state/auto_compact_window.rs#L78-L88)

配套的 world-state 机制值得单独记住：`CompactionSummary` 以 `role=user`、`ContentItemKind("compaction.summary")` 注入，且 `type_markers` 为空串（不包 XML 标记）。[context/compaction_summary.rs#L1-L35](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/context/compaction_summary.rs#L1-L35)

token-budget 变体不做总结，直接 `start_new_context_window`：保留可选 client developer 消息 + 重建初始上下文，其余丢弃。[compact_token_budget.rs#L52-L90](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/compact_token_budget.rs#L52-L90) [session/mod.rs#L4401-L4445](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/session/mod.rs#L4401-L4445)

## 5. remote vs local fallback

provider 能力决定走哪条路：`ProviderCapabilities.remote_compaction`，OpenAI 或 Azure Responses provider 为 `V2`，否则 `Unsupported`。[provider.rs#L37-L40](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/model-provider/src/provider.rs#L37-L40) [provider.rs#L410-L421](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/model-provider/src/provider.rs#L410-L421)

分派在 `run_auto_compact` 一处完成，四个 phase 全部复用。[turn.rs#L1446-L1500](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/session/turn.rs#L1446-L1500)

还有一层**模型 fallback**：remote V2 第一次失败时，如果 `should_retry_with_current_model(error)` 为真（即不是 TurnAborted/Interrupted/SessionBudgetExceeded），就用当前模型再跑一次 remote attempt，并把 `codex.compaction.model_fallback` 计入遥测。[compact_remote_v2.rs#L250-L296](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/compact_remote_v2.rs#L250-L296) [compact_model_fallback.rs#L8-L17](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/compact_model_fallback.rs#L8-L17)

remote 只有真正成功（拿到唯一一个 Compaction item + `response.completed`）才替换历史；`compaction_count != 1` 直接算 fatal。[compact_remote_v2.rs#L441-L503](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/compact_remote_v2.rs#L441-L503)

## 6. 失败、重试、ContextWindowExceeded

local 的重试循环：[compact.rs#L288-L340](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/compact.rs#L288-L340)

| 情况 | 处理 |
| --- | --- |
| `Interrupted`/`TurnAborted` | 立即返回，不重试 |
| `SessionBudgetExceeded` | 立即返回 |
| `ContextWindowExceeded` 且输入仍 > 1 条 | **从最老一项开始删**（`remove_first_item`），重置 retries，重发 |
| `ContextWindowExceeded` 且只剩 1 条 | `set_total_tokens_full` 把用量记为满窗，然后返回错误 |
| 其他错误 | 按 `stream_max_retries()` 退避重试，用尽后返回 |

`remove_first_item` 会连带移除配对的 call/output，保持历史不变量。[context_manager/history.rs#L543-L555](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/context_manager/history.rs#L543-L555)

remote 的请求重试上限取 `min(provider.stream_max_retries(), MAX_REMOTE_COMPACTION_V2_STREAM_RETRIES=2)`。[compact_remote_v2.rs#L79](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/compact_remote_v2.rs#L79) [compact_remote_v2.rs#L387-L438](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/compact_remote_v2.rs#L387-L438)

phase 决定错误是否上传：PostTurn 失败只 warn 且保留已完成的 turn；PreTurn 失败延迟到 run_turn 保留下一次输入后再报。[compact.rs#L205-L248](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/compact.rs#L205-L248)

## 7. 为什么不该由 Controller 自选“最老闭合区间”

这一条是对 #31 Q13 的直接回答，全部有上面的源码支撑：

1. **分段不是可自由挑选的**。local 只保留 user 消息，remote 只保留类型白名单；tool call/output、reasoning、agent progress 都会被替换掉。若 Controller 只截取一段“最老闭合区间”，它要么切断了 call/output 配对（历史不变量被破坏），要么把仍然需要原样携带的 tool 证据丢给了一个只做摘要的模型。Codex 用 `remove_first_item` 的配对清理说明这类切断必须由历史层统一处理，不能由上层按区间猜。
2. **前缀必须逐字节稳定才有缓存收益**。remote 在超窗时选择重写最老的 function-call 输出而不是丢弃前缀，注释明确写 “Trim from the beginning to preserve cache (prefix-based)”。按区间截取会改变模型看到的前缀形状，保活想保的缓存反而先被自己毁掉。
3. **阈值是窗口级而非区间级**。`token_limit_reached`、`full_context_window_limit_reached`、`turn_end_compaction_threshold_reached` 都是对整窗口用量的判断；窗口本身有 number/window_id，替换是全窗口替换。区间级策略与这套窗口模型语义冲突。
4. **替换点由 lifecycle 决定，不由内容决定**。四个 phase 分别对应“采样前、follow-up 之间、turn 结束、模型切换”，并在 world state、reference context、settings 持久化锁下原子切换。Controller 缺少这些边界信息，无法保证替换时没有未闭合的 tool call 或 pending interaction。
5. **保留预算已经是显式常量**（20k user / 64k retained / 10k per agent message），并且 summary 由服务端或专用 prompt 产出。再叠一层“最小区间”选择只会引入第二套、且互相矛盾的裁剪策略。

对 Coordinator 的可迁移含义（事实，不含产品决策）：如果沿用 Codex 的形状，压缩单位是**整个 active context window**，产物是一个 checkpoint（替换历史 + summary/provider item + window id），而不是一段被挑出来的旧消息。

## 8. 常量与配置速查

| 名称 | 值 | 位置 |
| --- | --- | --- |
| `COMPACT_USER_MESSAGE_MAX_TOKENS` | 20_000 | [compact.rs#L60](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/compact.rs#L60) |
| `RETAINED_MESSAGE_TOKEN_BUDGET` | 64_000 | [compact_remote_v2.rs#L75](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/compact_remote_v2.rs#L75) |
| `MAX_RETAINED_AGENT_MESSAGE_TOKENS` | 10_000 | [compact_remote_v2.rs#L76](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/compact_remote_v2.rs#L76) |
| `MAX_REMOTE_COMPACTION_V2_STREAM_RETRIES` | 2 | [compact_remote_v2.rs#L79](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/compact_remote_v2.rs#L79) |
| auto-compact 默认上限 | context window 的 9/10 | [openai_models.rs#L525-L538](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/protocol/src/openai_models.rs#L525-L538) |
| `effective_context_window_percent` | 95 | [openai_models.rs#L389](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/protocol/src/openai_models.rs#L389) |
| `model_post_turn_compact_threshold_percent` | 0 = 关闭 | [config.schema.json#L7095-L7101](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/config.schema.json#L7095-L7101) |

配置项说明：[config.md](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/docs/config.md)、[config.schema.json](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/config.schema.json)。

## 9. 未验证与边界

- 只读了固定 SHA 的 Rust CLI 源码；没有运行 Codex，也没有观察真实服务端 `/responses` 返回的 `encrypted_content` 形状。
- 服务端 compaction 的实际摘要质量、`comp_hash` 的生成算法、以及后端对 `CompactionTrigger` 的完整语义只通过 client 侧代码与注释确认。
- TUI 的 `/compact` 交互细节（确认流程、错误呈现）只核对了 slash command 文案，未逐屏验证。
- 本文件不包含 Orca Companion 的产品决策；Q13 的取舍仍以 ticket #31 的讨论为准。

