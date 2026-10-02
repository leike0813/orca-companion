# Codex CLI 0.160.0 长单条与流式渲染链路

本报告是 [裁决长 transcript 的分页、虚拟化与懒加载机制](https://github.com/leike0813/orca-companion/issues/53) 的渲染专项证据，相关取舍见用户确认的 [最终决议](https://github.com/leike0813/orca-companion/issues/53#issuecomment-5945507505)。范围限定在“单条超长消息 / 工具结果的读取到布局链路”、语义块粒度、Markdown 跨段、流式的稳定前缀与增长尾部、暂停阅读时的 live 快照，以及哪里存在真正的 byte-bounded 布局。后端权威存储、搜索通道和缓存总量不在本报告内。

## 基线与方法

固定 commit 为 `a956835d020762cb2b570053af06f643a11c0ecc`（tag `rust-v0.160.0`，`codex-rs/Cargo.toml` 声明 `version = "0.160.0"`）。源码来自官方 tag 归档，位于系统临时目录。未安装或升级 Codex，未构建上游，未启动真实用户会话或调用模型，也未运行测试。下文结论来自阅读生产代码路径与已存在的源码测试，不采信模块注释或文档对性能的表述；引用注释仅用于定位，结论以代码与控制流为准。核心结论归属仍是 Companion 的修正判断，不是 Codex 的验收。

一句话结论：Codex 的“稳定前缀 / 可变尾部”是**显示语义**（滚动历史不可改写，只有尾部允许重排），不是真正的增量 parser，也不推导 SDK 或进程内存有界。常态的增量渲染只在“存在多个顶层语义块”时成立；单条消息本身只有一个顶层块时，通常每个带换行的 delta 都会对整块重解析加重新换行，例外是该块为“带语言标记、且无潜在闭合行”的顶层代码围栏，此时走增量高亮快路径。

## 单条消息的实际链路

流式入口是 app-server 的 agent message delta。`ChatWidget::on_agent_message_delta` 转给 `handle_streaming_delta`：首次到达时创建 `StreamController`，随后每个 delta 调用 `controller.push`。[receive](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/chatwidget/streaming.rs#L201-L203)、[create/push](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/chatwidget/streaming.rs#L573-L612)。

`StreamCore::push_delta` 做四件事：把 delta 追加进 `MarkdownStreamCollector` 的原样缓冲；若 delta 含换行，按“最后一个换行”切出新增的已完成源；把**整段累计已提交源**连同新增片段交给 `StreamingRender::append`；再刷新未完成行的预览。[push_delta](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/streaming/controller.rs#L149-L177)、[collector](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/markdown_stream.rs#L77-L96)。

整条链路是同步的：`push` 在 app 事件处理线程上完成解析与换行，`streaming/`、`history_cell/`、`transcript_view`、`markdown_render` 找不到 `tokio::spawn`、`spawn_blocking` 或线程池调用。显示节奏由帧驱动的 commit tick 控制，队列每帧排出已稳定行，`COMMIT_ANIMATION_TICK` 等于 `TARGET_FRAME_INTERVAL`。[帧节奏](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/app.rs#L449)。因此“异步调度”不存在；大到一定程度的单条解析会直接占用绘制路径。

## 稳定前缀与增长尾部是显示语义

`StreamingRender` 维护 `stable_source_len`（常态下保留渲染结果的顶层块边界）和 `stable_rendered_len`；通常每次 `append` 重渲染从该边界到结尾的 pending 源，保留此前已完成块的已渲染行。引用定义等例外另见下文。[append](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/streaming/render.rs#L128-L236)。

边界的来源决定了一切。`render_streaming_markdown_lines_with_width_and_cwd` 用 `TopLevelBlockTracker` 只统计深度 0 的 `Event::Start` / `Rule` / `Html`，`last_top_level_block_start` 仅当 `block_count > 1` 才返回 `Some`。[边界收集](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/markdown_render/streaming.rs#L39-L89)、[tracker](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/markdown_render/streaming.rs#L92-L133)。推论有两层：

- 多块消息（例如“标题 + 段落 + 列表 + 表格”）里，只有最后一个顶层块是增长的尾部，前面的块常态下按上一次渲染结果保留；但某块转为稳定边界的那一次 `append` 会通过 `newly_stable_source` 把它再渲染一遍并入稳定区，所以不是“严格只渲染一次”。此后每个 delta 的重算规模约等于最后一块的大小。这正是显示语义要的效果：已写入滚动历史的前缀不能回改。
- 单块消息（一整段无空行长段落、整张表格、整个列表、单个无语言标记的代码围栏）没有“更早的块”，`last_top_level_block_start` 为 `None`、`stable_source_len` 恒为 0。每个带换行的 delta 都会对**整段累计源**重新解析并重新换行。在“固定小 chunk 持续增长”的最坏情形下，单条成本约 O(n)，一条消息累计约 O(n²)；这是推论而不是实测，也不适用于下面的代码围栏快路径或大 chunk 成批到达的情形。

源码测试直接钉住了第二点。`growing_single_top_level_blocks_render_and_scan_in_one_pass` 对“持续增长的单段落”和“持续增长的单表格”逐 chunk 断言 `last_top_level_block_start == None`、`render.lines` 等于对当前全部累计源做一次完整渲染的结果、且 `stable_source_len == 0`。[测试](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/streaming/render_tests.rs#L145-L179)。对应的多块测试 `incremental_render_keeps_final_block_mutable_and_matches_full_render` 才断言 `0 < stable_source_len < source.len()`。列表作为单个深度 0 块由此 tracker 语义推出，但那条测试只显式覆盖段落与表格，未显式覆盖列表。

这里的“稳定”也会被打破：引用式链接定义和 inline visualization 指令会触发 `recompute`，对整段源做完整重渲染。[recompute 触发](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/streaming/render.rs#L71-L120)。所以在稳定前缀内部也并非“永不重算”，只是常态下不重算。

## 每次重算的构成是成熟 parser 全量解析加换行

`StreamingRender::append` 的 pending 渲染走 `render_markdown_agent_with_list_spacing` → `normalize_markdown_for_rendering` → `render_streaming_markdown_agent_with_links_and_cwd` → `render_streaming_markdown_lines_with_width_and_cwd`。[入口](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/markdown.rs#L92-L160)。其中：

- `normalize_markdown_for_rendering` 在启用终端表格时先跑一遍 `unwrap_markdown_fences`，扫描并缓冲围栏体；即每次重算都先做一次源级预处理。[normalize](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/markdown.rs#L249-L256)。
- 随后用 `pulldown-cmark` 的 `Parser::new_ext` 做全量解析，再由 `Writer` 在同一趟里按宽度产出已换行的行。换行不是独立的后置步骤，而是渲染的一环。[render 入口](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/markdown_render/streaming.rs#L39-L72)。

因此，不走代码围栏快路径的单块消息，每个 delta 的成本是 O(块大小) 的 MARKDOWN 解析加换行，无字节上限、无分范围读取、无后台线程。parser 本身是成熟实现（`pulldown-cmark`），错不在 parser 能力，而在于“每次都从头解析整块”。

## 两个收敛特例：代码围栏与表格

代码围栏有唯一的真正增量快路径。`OpenCodeFence::detect` 只在“最后可变块是一个带语言标记的顶层围栏、且内容里没有可能出现闭合行”时成立；成立后 `append` 用有状态的 `StreamingCodeHighlighter` 只高亮新增行，不再重渲染整个围栏。任何可能闭合的行、无语言标记的围栏、缩进或转义等边缘情况都退回 canonical 全围栏渲染。[detect/append](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/streaming/code_fence.rs#L33-L122)。注意该快路径要求语言非空，因此无语言标记的巨围栏仍在 O(块) 重渲染路径上。

表格是反向特例：因为新增一行会改变所有列宽，源码把从表头起的整段表格**扣住**为可变尾部，直到 finalize 才进入滚动历史；`stable_prefix_len_cache` 只避免反复重渲染表格**之前**的前缀。因此一张巨表的每个 delta 仍对整表重渲染。[扣留语义](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/streaming/controller.rs#L12-L42)、[前缀缓存](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/streaming/controller.rs#L107-L117)。

## 有界与无界的边界

真正按字节或按行设上限的，都是**未完成或预览**类内容：

- 未完成单行的 prose 预览限制在 8192 字节滚动窗口，只扫描新增字节，超窗显示省略号。[ProsePreview](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/streaming/prose_preview.rs#L17-L124)。一个没有换行的超长单行在流式期间因此有界。
- 工具输出预览 3 行、每行 16 KiB；实时命令输出 1 MiB 总量、首尾各 50 行、单行首尾截断。[工具预览](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/tool_output.rs#L19-L20)、[实时输出](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/exec_cell/live_output.rs#L5-L11)。
- 代码高亮在总 512 KiB / 一万行 / 单行 4 KiB 之上永久退回纯文本，不再着色。[高亮上限](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/render/highlight.rs#L640-L646)。
- 重放缓冲把合并后的 agent delta 限制在 4 KiB、总缓冲 256 KiB；单条 delta 超过 256 KiB 直接丢弃。[重放缓冲](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/app/thread_event_buffer.rs#L8-L10)。

这些上限都不是“单条消息布局有界”。无界的部分：

- `MarkdownStreamCollector.buffer` 原样累积整条消息，只有换行门控，没有字节上限。
- `StreamingRender.lines` 按当前宽度持有整条消息的全部已渲染行。
- 定稿后的 `AgentMarkdownCell` 保存完整 `markdown_source`，在宽度或布局失效时对**整条源**重新渲染；`MarkdownRenderCache` 只缓存最近一个宽度。[AgentMarkdownCell](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/history_cell/messages.rs#L503-L621)。
- `TextLayout` 持有整条逻辑文本加显示行；无 byte cap、无分范围读取。[TextLayout](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/transcript_view/text.rs#L43-L89)。对一个由单条超长物理行组成的消息（例如一份超长 JSON 单行结果），换行在逻辑行粒度执行且没有字节门槛，整行都会被处理。
- `LayoutCache` 虽然给出 64 项 / 8 MiB 文本上限，但淘汰在只剩一条时停止，源码明确保留可见的单条超大 layout；且字节统计只累加 `layout.text().len()`，不含样式、显示行、Arc 与快照。[cache](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/transcript_view/layout.rs#L13-L14)、[evict](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/transcript_view/layout.rs#L260-L272)。因此它是显示缓存策略，不是单条布局内存上界。

工具结果侧，TUI 的 `CommandOutput` 保存完整的 finalize 后输出串，`line_counts()` 与 `lines()` 遍历整串，展开视图走 `transcript_lines()` 全量；预览路径才用 5/50/100 行的 `line_limit` 截断。[CommandOutput](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/exec_cell/model.rs#L20-L64)、[截断](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/exec_cell/render.rs#L118-L200)。shell/exec 输出在更上游默认按 1 MiB 截断（`codex-utils-pty::DEFAULT_OUTPUT_BYTES_CAP`），所以“工具结果”这一路可能天然被 1 MiB 兜住；但这个上限在哪些工具路径生效未在本报告内逐一核验，MCP 结果与其他内容类型的单条大小属于未验证边界。

## 暂停阅读时的版本固定

用户读到 live 或可变 cell 时，`ViewSnapshot` 固定当时的显示版本：复制的是已加载 cell 的引用数组与已渲染 layout，底层继续接收更新，离开后回到当前历史，resize 对被固定版本重新换行。它保留这些对象的所有权，但不复制每条正文，也不是“只保留当前视窗正文”。[snapshot](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/transcript_view/snapshot.rs#L34-L120)。这是显示粒度的版本固定，不能读成内容级的有界缓冲。

顺带一个与草案直接相关的既成事实：`HyperlinkLine.source: Option<LogicalLineSource>` 已经携带每显示行的 `range` 与 `prefix_bytes`，并共享 `Arc<str>` 文本，即“源偏移”在行粒度已经存在；身份则是进程内 cell 的 Arc 指针，不是可持久化 id。[LogicalLineSource](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/terminal_hyperlinks/source.rs#L19-L41)。这支持“message identity + source offset”的映射思路，但 identity 需要 Companion 自己提供可信版本。

## 已读到的源码测试边界

以下测试只阅读、未运行，它们断言的是渲染等价与扣留正确，不是延迟或内存有界：

- 流式与全量渲染等价、单块不变式：`streaming/render_tests.rs`（`incremental_render_keeps_final_block_mutable_and_matches_full_render`、`growing_single_top_level_blocks_render_and_scan_in_one_pass`、引用链接与 inline visualization 的全量重算用例）。
- 表格扣留、resize 重排、宽度变化：`streaming/controller.rs` 内多个用例（如 `controller_streamed_table_matches_full_render_widths`、`controller_set_width_preserves_in_flight_tail`、`controller_live_tail_rerenders_table_tail_after_resize`）。
- 换行门控与 UTF-8/宽字符等价：`markdown_stream.rs` 的 `no_commit_until_newline`、`utf8_boundary_safety_and_wide_chars`、`loose_vs_tight_list_items_streaming_matches_full`。
- 边界收集：`markdown_render/followups_tests.rs` 断言 `last_top_level_block_start` 指向第二个顶层块。
- 布局缓存复用与淘汰：`transcript_view/layout_tests.rs`。
- resize / 重放行上限：`resize_reflow_cap.rs` 与 `app/resize_reflow.rs`（按终端类型给出行数上限，默认回退常量；并在渲染侧而非写终端后施加）。

## 对 Companion 的最小修正建议

把本票已有的“局部视窗 + 有限缓冲 + message identity + source offset + 分范围读取 parse/wrap”方向拆成必须靠自己实现的部分，不依赖 Codex 现状：

1. 分范围读取与 parse 需要自己按语义块边界分段并缓存已解析块，不依赖“稳定前缀”这一显示概念；但**只重算增长中的当前块并不足以有界**，一个持续增长的巨块本身仍无界。有界性要么来自块内的 range/offset 分段，要么来自对超过门槛的块走 raw/未解析 fallback，二者取其一，不能停在“按块重算”。
2. 对超长单物理行设显式的字节门槛和降级路径（普通成熟 parser 处理常规内容，超过门槛走 raw/未解析 fallback），因为布局换行在 Codex 里对单行无上限。
3. 保留行级 source offset 的映射，但用 Companion 自己的可信 entry/content revision 表达身份，不复用进程内 Arc 指针。
4. 暂停阅读用显示版本固定即可，与 Codex 行为一致；不要把它误当作正文内存有界。
5. 临时文件与 inline visualization 类的 UI 通道只约束 UI 侧展示，不构成 SDK 侧单条有界；单条成本仍需在 Companion 的读取合同里单独给出上界。

未验证边界：本报告未核验 MCP 结果与其他非 shell 工具路径的单条大小上限、未在真实终端或超大单条上测量延迟与 RSS、未运行上述样例测试、未覆盖 Windows 行为。以上判断因此是源码路径级结论，而不是性能验收。
