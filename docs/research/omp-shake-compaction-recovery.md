# OMP 的 shake：上下文压缩失败的机械补救机制

对应 ticket：[*定义 Coordinator 的缓存保活与上下文压缩协议*](https://github.com/leike0813/orca-companion/issues/31)（父地图 [#1](https://github.com/leike0813/orca-companion/issues/1)）。

## 0. 结论先行

**OMP 的 shake 不是"摘要压缩的重试"，而是一类完全不同的压缩动作：不调用模型、不生成摘要，直接把沉重的工具结果和大块 fenced/XML 内容换成带恢复链接的占位符。** 它和 compact 的关系是"同一份方法优先级列表里的可替换项"以及"摘要压缩走投无路时的最后一级救援"，不是"compact 失败后重试 compact"。

三个对 Companion 最有价值的机制：

1. **机械压缩（无 LLM 调用）** 保证压缩在 provider 无关、模型不可用、上下文已溢出时仍然可行；
2. **方法顺序 + 进度复测** 取代"重试计数"：压缩后若未回到恢复带（threshold 的 0.8 倍），就换下一个方法，从根上消灭无意义循环；
3. **可恢复性**：被删内容落盘为 artifact，占位符内嵌 `artifact://` 恢复链接，原消息仍留在 journal 中。

额外发现（与本票的保活讨论直接相关）：**OMP 自己就实现了一套有界的缓存保活**，参数与用户在 ticket #31 中提出的方案高度同构——见第 10 节。

## 1. OMP 身份与固定版本

本机 `omp` 解析为 `@oh-my-pi/pi-coding-agent`，不是 oh-my-posh。证据是 shake 源码同时出现在该包的 `pi-agent-core/compaction/shake.ts` 与 `pi-coding-agent/session/session-maintenance.ts` 中，且 CLI 的 `--resume`、`--plan`、prewalk 等选项与该包一致。

- 本机安装：`omp/18.2.4`，`/home/joshua/.bun/bin/omp` → `@oh-my-pi/pi-coding-agent/dist/cli.js`
- 官方仓库：`https://github.com/can1357/oh-my-pi`（package.json 的 repository 字段；homepage `https://omp.sh`，author Stencil Labs, Inc.）
- **固定 commit SHA：`1c0303b1f2ec515cbf4b44a9a49d68a029531aac`**（tag `v18.2.4`）

本文件所有源码引用均取自该 commit 的 `v18.2.4` 快照；本机安装包中的同路径文件与之逐字一致（抽查 `shake.ts`、`session-maintenance.ts` 关键片段）。下文简写为 `agent/` = `packages/agent/src`，`coding/` = `packages/coding-agent/src`。

## 2. shake 是什么：纯函数层 + 会话编排层

职责按既有的 `pruning.ts` 分层：

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 纯逻辑 | `agent/compaction/shake.ts`（475 行） | 区域探测与原地改写；**无 I/O** |
| 编排 | `coding/session/session-maintenance.ts` 的 `AgentSession.shake`（:759） | artifact 落盘、journal 重写、上下文重放、provider session 拆除 |

公开契约（`coding/session/shake-types.ts`）：

```ts
type ShakeMode = "elide" | "images" | "thinking";
interface ShakeResult {
  mode: ShakeMode;
  toolResultsDropped: number;   // 整体丢弃的工具结果数
  blocksDropped: number;        // 丢弃的 fenced/XML 块数
  imagesDropped?: number;       // images 模式
  thinkingBlocksDropped?: number; // thinking 模式
  tokensFreed: number;          // 估算释放的 token
  artifactId?: string;          // 落盘原文的 artifact
}
```

**shake 不调用任何模型。** CHANGELOG 明确记录早先基于本地模型的 `summarizeShakeRegions` 压缩器已被移除，shake 现在只提供机械的、artifact 支撑的 elision 原语。这正是"provider-agnostic"的来源：它不依赖任何 provider 的摘要端点或压缩协议。

## 3. 触发前提

### 3.1 手动 `/shake [elide|images|thinking]`

空参数默认 `elide`（`coding/slash-commands/builtin-lifecycle.ts` 的 `parseShakeMode`）。使用最激进的 preset，可作用于全部 eligible 历史。

### 3.2 自动方法：出现在 `compaction.methodOrder` 中

默认顺序 `["remote", "snapcompact", "handoff", "shake", "soft"]`（`coding/session/compaction-methods.ts`，`DEFAULT_COMPACTION_METHOD_ORDER`）。自动 shake 由 `#runAutoShake`（`coding/session/session-maintenance.ts:5061`）执行，覆盖四类 reason：`threshold`、`overflow`、`incomplete`、`idle`。

`#runAutoShake` 自身的前置门是配置层：`compaction.enabled` 为真，且 methodOrder 含 `shake`。它发出正常的 `auto_compaction_start` / `auto_compaction_end` 事件对，`action: "shake"`。

### 3.3 死路救援（dead-end rescue）

`#rescueCompactionDeadEnd`（`coding/session/session-maintenance.ts:3703`）是"summary 压缩已经没有可用切点"时的分级降级器：

- **Tier 0**：snapcompact 帧溢出时按阈值重建归档；
- **Tier 1**：`shake("elide")`，用 `RESCUE_SHAKE_CONFIG`——它把 `protectTokens` 压到 0，因此**能删掉最近的超大有界块**，这是普通 preset 做不到的；
- **Tier 2**：`dropImages()`，即把 `/shake images` 自动化；图片不像文本那样可 artifact 恢复，所以只在 elide 复测失败后才执行。

每一级改写历史后都重新锚定在飞上下文，再复测调用方传入的 `hasProgress()` 谓词；第一级恢复进度即返回。

### 3.4 Responses body-read 超时

`shakeForRequestBodyReadTimeout`（`:931`）：在"输出前 body 读取超时"时做一次 artifact-backed 的机械缩减，使用 `DEFAULT_SHAKE_CONFIG` + `toolResultsOnly` + `requireArtifact`。同样要求 methodOrder 含 `shake`。

## 4. 修改了什么上下文

只改两类区域（`agent/compaction/shake.ts` 的 `ShakeRegion`）：

| 区域 | 位置 | 处理 |
| --- | --- | --- |
| `toolResult` | 整条 tool-result 消息 | 原文替换为占位符；非文本块保留 |
| `block` | user/developer/assistant/custom 消息内的 fenced 块或顶层 XML 元素 | 区间 `[start,end)` 被占位符替换 |

对 tool-result 的原地改写（`applyShakeRegion`，`:436`）语义精确：把**第一个非空文本块**换成占位符，**删除其余文本块**，**保留每一个非文本块**（图片因此在 elide 中幸存），最后盖上 `prunedAt` 时间戳。块级改写则用 splice 覆盖字符区间。

占位符（`#shakeElidePlaceholder`）：

```
[shaken ~N tokens — recover: artifact://<id> (region k)]   // artifact 可用时
[shaken ~N tokens]                                          // 无 artifact 时
```

被删原文按 `### region N (label, ~tok tok)` 逐段拼成**一个** artifact 文档落盘；`applyShakeRegions` 会把块级区域按起始偏移从大到小应用，保证同一文本块内多个区间不会互相移动偏移。

## 5. 保留 / 删除规则

### 5.1 三套 preset（`agent/compaction/shake.ts:47-76`）

| preset | protectTokens | minSavings | fenceMinTokens | protectedTools |
| --- | --- | --- | --- | --- |
| `DEFAULT_SHAKE_CONFIG`（自动） | 16 000 | 4 000 | 400 | `skill`、skill-read、artifact-recovery |
| `AGGRESSIVE_SHAKE_CONFIG`（手动） | 4 000 | 0 | 400 | `skill`、skill-read |
| `RESCUE_SHAKE_CONFIG`（死路救援） | 0 | 0 | 400 | `skill`、skill-read、artifact-recovery |

### 5.2 永不删除

- **tool-call 块**：`toolCall` 从不被触碰，因此 tool-call/result 配对关系保持完整；
- **最近上下文**：`collectShakeRegions`（`:316`）预计算每个下标之后所有条目的 token 总量，凡 `accumulatedAfter[i] < protectTokens` 的条目整体跳过（保护活尾）。**例外**：被工具标记为 `useless` 且非 error 的结果可以穿透这层保护（它已经没有信息价值）；
- **受保护工具的结果**：`protectedTools` 支持字符串匹配或谓词。谓词版本能读到配对的 tool call，因此实现出 `read` 的 `skill://` 路径保护与 `artifact://` **恢复读**保护（`agent/compaction/tool-protection.ts`）。后者的理由写得很直白：删一个 artifact 恢复读只会再生成一个 artifact，可能无限循环；
- **压缩边界之前**：`keepBoundaryId` 取自最近一次 compaction 的 `firstKeptEntryId`，之前的条目已被摘要覆盖、根本不会发送，改动只会污染持久化历史；
- **已删过的结果**：`prunedAt !== undefined` 直接跳过，保证重复调用幂等；
- **过小的块**：小于 `fenceMinTokens`（400）的 fenced/XML 块不删；
- **计划文件读**：编排层通过 `#withPlanProtection` 追加活动 plan reference 的保护。

### 5.3 两个关键阈值

- **`PLACEHOLDER_TOKEN_ESTIMATE = 16`**：占位符自身的开销，只用于节省量计算；`Math.max(0, region.tokens - 16)` 累加；
- **`minSavings` 门**：总节省不足时 `collectShakeRegions` 返回空数组，整个 shake 退化为 no-op。即"删了不划算就不删"。

fenced/XML 探测（`scanTextForBlockRanges`，`:157`）刻意保守：未闭合的 fence/tag 不产生区间，fence 内部的 XML 探测被抑制，XML 只认小写标签，且与 prompt 渲染的 toggling 逻辑对齐。

## 6. 与 compact 重试的关系

这是本票最核心的问题，答案有四层。

### 6.1 shake 是方法列表中的可替换项，不是 compact 的重试

`resolveCompactionMethodOrder` 把配置顺序解析为方法列表；`resolveMethodSettings` 把方法映射为引擎策略（`shake` → `strategy: "shake"`，`remote`/`soft` → `"context-full"`，等）。自动流程逐个方法取第一个 usable 的；shake 失败或不足时**推进到下一个方法**（`runAutoCompaction` 递归调用自身，`methodIndex + 1`）。

### 6.2 推进的判据是"进度复测"，不是"失败次数"

`#runAutoShake` 在 shake 之后做一次 provider-anchored 复测（`:5120` 附近）：

```ts
const correctedTokens = Math.max(0, triggerContextTokens - result.tokensFreed);
const recoveryBand = Math.floor(thresholdTokens * COMPACTION_RECOVERY_BAND); // COMPACTION_RECOVERY_BAND = 0.8
stillOverThreshold = correctedTokens > recoveryBand;
const shouldFallBack =
  reason !== "idle" && ((reason === "overflow" && !reclaimed) || stillOverThreshold);
```

即：**只有落到 threshold 的 0.8 倍以下才算真的恢复了**。这是从 issue #2119 / #2275 反推出来的修正——本地估算器会低估 thinking-signature 的载荷，所以复测优先用调用方给的 provider 计费值；同时用 0.8 的迟滞带避免在边界上抖动。

### 6.3 回退时避免重复劳动

推进到下一个方法时传 `fallbackFromShake: true`，该标志最终变成死路救援的 `skipElide`，避免"shake → 下一个方法 → 死路救援 → 又 shake 一次"。

### 6.4 局部方法不参与推测压缩

`resolveSpeculationMethod` 对 snapcompact/shake 返回 `undefined`：它们瞬时完成，没有可推测的空间。

`idle` 是唯一豁免回退的 reason，因为 idle 定时器自己会在下次触发前重查用量，不可能自旋。

## 7. 失败上限与终止语义

**shake 本身没有"重试次数上限"**——它在每次维护 pass 中只运行一次，靠"方法推进"而非"重试计数"防止死循环。真正带显式上限的是相邻机制：

| 机制 | 上限 | 触顶行为 |
| --- | --- | --- |
| `response.incomplete`（length stop）恢复 | `INCOMPLETE_RECOVERY_MAX_RETRIES = 3` | 丢弃死turn并持久化分支标记，报错，**阻止自动继续** |
| 中途（mid-turn）死路 | 每个超大有界工具回合**警告一次** | 记入 `#midTurnCompactionDeadEnds`（WeakSet）与 `#midTurnDeadEndPendingPrePrompt`；一旦后来出现切点即重新武装 |
| 自动继续（auto-continue） | 由 `#compactionCreatedHeadroom()` 决定 | 未产生足够空间时 `COMPACTION_CHECK_BLOCK_AUTOMATIC_CONTINUATION` |

终止状态用 `COMPACTION_CHECK_*` 四值表达：`NONE` / `DEFERRED_HANDOFF` / `CONTINUATION` / `BLOCK_AUTOMATIC_CONTINUATION`。失败还要区分"可重试"与"必须停下"：可重试的溢出走 `scheduleAgentContinue`，不可恢复的则阻止后续所有自动继续。

一个值得注意的细节：即使 shake 抛异常，`overflow` 仍返回 `"fallback"`（溢出必须尝试恢复），其他 reason 返回 `NONE`。

## 8. 持久化与恢复语义

### 8.1 就地改写 + 原子重写 journal

shake 先对 branch 条目做原地改写（`applyShakeRegions`），随后：

1. `sessionManager.rewriteEntries()` → `#rewriteAtomically()` 原子重写会话文件；
2. `buildDisplaySessionContext()` → `agent.replaceMessages()` 重放重建后的上下文；
3. `resetAdvisorRuntimes("shake")` 重置顾问运行时；
4. `closeCodexProviderSessionsForHistoryRewrite()` 拆除会缓存消息身份的 provider session。

**为什么必须重写文件**：注释写得很清楚——会话文件必须与内存中的（已裁剪）上下文一致，否则基于文件的 fork（`/fork`、`/tan`）与 resume 会重建出不同的前缀，直接冷 miss provider 的 prompt cache。

### 8.2 回滚快照

改写前对每个受影响的 entry（以及 usage anchor entry）做 `structuredClone` 快照（`entrySnapshots`）；`rewriteEntries` 抛错时用 `Object.assign` 还原、重建上下文并重新抛出。这是"要么完全生效、要么完全不动"的语义。

### 8.3 provider-anchored 用量修正

shake 记录被移除的锚定 token 量（`recordAnchoredHistoryRewrite`），并扫描 `isTranscriptUsageAnchor` 定位计费锚点。这样重写后的本地估算不会与 provider 已计费的输入量脱节，下一次复测才可信。

### 8.4 可恢复性

- artifact 通过 staging 原子写入，失败时**降级为无恢复链接的占位符**（除非 `requireArtifact`，则报错）；
- 非持久化会话退化为内存 artifact；
- 条目里只存占位符文本，原文在 artifact 里；resume 后 agent 仍可主动读回；
- 取消语义：`signal.aborted` 或 `isCurrent() === false` → `CompactionCancelledError`，中途不改历史；
- 因为 `prunedAt` 让重复调用幂等，恢复时不会二次误删。

## 9. 可迁移到 provider-agnostic LangGraph harness 的部分

### 9.1 可直接迁移

1. **无 LLM 的机械压缩**：把"重 content 换成可恢复占位符"作为独立于任何 provider 的压缩原语。它在模型不可用、上下文已溢出、摘要端点缺失时仍然可行，是天然的最后防线。
2. **artifact 支撑的可恢复占位符**：`[shaken ~N tokens — recover: artifact://<id>]` 这套"删内容但留下找回指针"的模式，与 LangGraph checkpoint 天然互补——checkpoint 保留原始历史，Capsule/占位符只承载下一窗口所需的派生视图。
3. **三套 preset 的差异只体现在参数**：保护窗口、最小节省、受保护工具。这是配置，不是分支逻辑。
4. **保护窗口 + 最小节省门 + 占位符成本下限**：三条都是纯数值规则，不含 provider 语义。
5. **`keepBoundaryId` 纪律**：不去改动已被压缩边界覆盖的条目。任何有"压缩边界"概念的 harness 都需要这条。
6. **有序方法列表 + 进度复测**：取代重试计数。这是本文件里最值得照搬的控制流——**用"是否真的产生了空间"决定下一步，而不是"失败了几次"**。
7. **显式死路终态**：无法恢复时进入明确状态（阻止自动继续 + 警告一次 + 出现新切点后重新武装），而不是静默循环。
8. **原子重写 + 快照回滚 + 重放**：先快照，失败还原并重放，成功才切换活动上下文。
9. **provider-anchored 用量修正**：当 provider 已计费输入与本地位图不一致时，以 provider 值为复测基准。
10. **tool-call/result 配对不可破坏**：只替换结果文本，从不触碰 tool-call 块。

### 9.2 需要 adapter 或不可直接迁移

| 机制 | 原因 |
| --- | --- |
| `AnthropicCacheRefreshState` 缓存保活 | 见第 10 节，Anthropic 专属的零输出重放 |
| `closeCodexProviderSessionsForHistoryRewrite` | Codex provider session 拆除 |
| 原生压缩 replay（`preserveData` / `providerReplayThroughEntryId`） | 绑定 provider 原生压缩协议 |
| `snapcompact` | 依赖目标模型具备视觉能力与特定图像计费公式 |

## 10. 附带发现：OMP 自己的缓存保活（与 ticket #31 直接相关）

OMP 已实现一套**有界的 idle 缓存保活**，参数与本票提出的方案几乎同构，可作为先例证据。

位置：`packages/ai/src/stream.ts:1208-1290`（`AnthropicCacheRefreshState`），在 `coding/src/sdk.ts:3713` 以 `anthropicCacheRefresh: true` 开启。

```ts
const ANTHROPIC_CACHE_TTL_MS = 5 * 60_000;
const ANTHROPIC_CACHE_REFRESH_LEAD_MS = 15_000;
const ANTHROPIC_CACHE_REFRESH_LIMIT = 3;
```

行为要点：

- **提前量**：`refreshAtMs = cacheTouchedAtMs + TTL - LEAD`，即在 TTL 到期前 15 秒触发（固定提前量，而非比例）；
- **真正的模型调用**：保活用捕获的 payload 重放，非 thinking 时 `max_tokens: 0`、`stream: false`；thinking 活跃时会在第一个生成块出现时中止；
- **命中判据**：只有 `cacheRead > 0 && cacheWrite === 0`（纯读、未重写缓存）才算保活成功；否则丢弃 plan；
- **次数上限**：`#refreshesRemaining` 初值 3，每次成功后递减，归零即丢弃 plan——**最多 3 次**，与用户在本票中接受的 `maxMaintenanceCycles = 3` 一致；
- **真实工作重置计时**：`arm()` 首先调用 `cancel()`，而每次普通请求都会重新 `arm`；因此任何实质模型调用都会重排保活计划——正是"任何实质模型步骤重置 cycle"的语义；
- **仅 5 分钟档启用**：`resolveCacheRetention(options.cacheRetention) === "short"` 才启用；`long`（1h）**显式禁用**保活（1h TTL 下重写昂贵，不值得保活）；
- **能力门**：`supportsAnthropicCacheRefresh` 要求 `api === "anthropic-messages"`、`provider === "anthropic"`、`transport !== "pi-native"`。

设置层（`coding/config/settings-schema.ts` 的 `providers.cacheRetention`，默认 `auto`）把差异收敛为四档：`auto`（Anthropic OAuth 会话 1h；API key 5m + 保活）、`short`（强制 5m + 保活）、`long`（1h，禁用保活）、`none`（关闭缓存与缓存亲和路由）。

这与本票的结论关系密切：**保活必须是"OPT 档位 + 有上限 + 实质工作即重置"，而不是无限期心跳。** OMP 用固定 3 次上限而非时间窗，且把"值不值得保活"直接编码进 retention 档位。

同一份代码里的 **prompt-cache 守卫**也值得记录（`coding/session/session-maintenance.ts:284-292`）：`PRUNE_CACHE_WARM_SUFFIX_TOKENS = 8_000` 表示"某条结果之后的消息总量超过 8k 时，它已在温缓存前缀里，不要改它"；`PRUNE_IDLE_FLUSH_MS = 90 * 60_000` 表示"只有闲置超过 1h（必须大于 Anthropic long 档的保留期）才允许整段刷新"；并且当 `model.thinking.prefixBinding === true` 时该阈值降为 0。**这是"不要为了省 token 而主动毁掉正想保住的缓存"的工程化表达。**

## 11. 来源

固定版本：`v18.2.4` = `1c0303b1f2ec515cbf4b44a9a49d68a029531aac`（`https://github.com/can1357/oh-my-pi`）。

源码：

- `packages/agent/src/compaction/shake.ts` —— preset（:47/:60/:68）、`PLACEHOLDER_TOKEN_ESTIMATE`（:78）、`scanTextForBlockRanges`（:157）、`collectShakeRegions`（:316）、`applyShakeRegion`（:436）、`applyShakeRegions`（:468）
- `packages/agent/src/compaction/pruning.ts` —— `DEFAULT_PRUNE_CONFIG`（:54）、`MIN_PRUNE_TOKENS`（:123）、`idleFlushMs`（:94）、`cacheWarmSuffixTokens`（:51/:369）
- `packages/agent/src/compaction/tool-protection.ts` —— `isSkillReadToolResult`、`isArtifactRecoveryToolResult`
- `packages/coding-agent/src/session/session-maintenance.ts` —— `COMPACTION_RECOVERY_BAND`（:305）、`INCOMPLETE_RECOVERY_MAX_RETRIES`（:145）、`shake()`（:759）、`shakeForRequestBodyReadTimeout`（:931）、`#compactionCreatedHeadroom`（:3607）、`#rescueCompactionDeadEnd`（:3703）、`#runAutoShake`（:5061）、`PRUNE_CACHE_WARM_SUFFIX_TOKENS`/`PRUNE_IDLE_FLUSH_MS`（:284/:292）、`#midTurnCompactionDeadEnds`（:494）
- `packages/coding-agent/src/session/compaction-methods.ts` —— `DEFAULT_COMPACTION_METHOD_ORDER`、`resolveMethodSettings`
- `packages/coding-agent/src/session/shake-types.ts` —— `ShakeMode` / `ShakeResult` / `formatShakeSummary`
- `packages/coding-agent/src/slash-commands/builtin-lifecycle.ts` —— `parseShakeMode`
- `packages/coding-agent/src/session/session-manager.ts` —— `rewriteEntries`（:2875）、`discardEntryDurably`（:3093）、`allocateArtifactPath`/`saveArtifact`（:2502/:2506）
- `packages/coding-agent/src/session/artifacts.ts` —— staging 原子写入
- `packages/ai/src/stream.ts` —— `ANTHROPIC_CACHE_TTL_MS` / `_LEAD_MS` / `_LIMIT`（:1208-1210）、`AnthropicCacheRefreshState`（:1217）、`supportsAnthropicCacheRefresh`（:1291）
- `packages/coding-agent/src/config/settings-schema.ts` —— `compaction.*`（:2712 起）、`providers.cacheRetention`（:5982）

官方文档：

- `docs/compaction.md` —— "Shake method"（:190-194）、触发条件（:196 前后）、pre-compaction pruning（:219 起）、默认设置（:489 起）
- `docs/settings.md` —— `providers.cacheRetention` 行（:777）

测试：

- `packages/agent/test/shake.test.ts` —— 纯层：工具结果、fenced/XML 块、多区域排序、preset、useless 结果
- `packages/coding-agent/test/shake.test.ts` —— 编排层：artifact 恢复链接、图片保留、受保护工具、auto-shake 策略、#2119/#2275 回退回归
- `packages/coding-agent/test/agent-session-mid-turn-compaction-dead-end.test.ts` —— 每个超大有界回合只警告一次、新切点后重新武装
- `packages/coding-agent/test/issue-3656-shake-during-stream.test.ts` —— 流中 shake 保留在飞回合
- `packages/ai/test/anthropic-cache-refresh.test.ts` —— 三次刷新上限、新请求重置间隔、long 档不保活

## 12. 未验证项

- 本仓 `references/orca` 与本次研究无关，未被读取；本机安装包与 GitHub `v18.2.4` 的逐字一致性只做了抽样核对，未做全量哈希。
- OMP 对 OpenAI / Gemini 等 provider 是否有等价保活：`supportsAnthropicCacheRefresh` 明确限定 Anthropic，未发现其他 provider 的保活实现。
- `compaction.experimentalContextManagement`（notes-backed 上下文窗口）与 shake 的交互未展开：该路径绕过部分 prune/shake 逻辑（`#usesExperimentalContextManagement` 处有多处短路）。
- shake 的 `tokensFreed` 是估算量，未验证其与实际 provider 计费的偏差幅度。

*本次研究会话未暴露 subagent 委派工具，因此按直接指令在主流程内完成源码级阅读，未另开后台 agent。*
