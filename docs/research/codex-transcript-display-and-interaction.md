# Codex TUI 的 transcript 展示与交互（0.159.3 源码与终端核验）

本文服务于 [裁决 transcript 的回合呈现与导航](https://github.com/leike0813/orca-companion/issues/41)，覆盖消息与工具呈现、生成中状态、历史阅读、滚动、搜索、文本选择与复制、raw 模式、新消息、resize、问题交互及键位上下文。它记录 Codex 的行为及其证据，供后续体验决策使用。

Codex 0.159.3 在允许 alternate screen 的默认配置下，以同一个对话视口承载滚动、搜索、局部活动展开和整体详细模式；composer 保持在底部。工具按活动语义收拢，正文与生成状态交替占据注意力。`Ctrl+T` 在这个模式中切换详细程度；在 `--no-alt-screen` 等 Terminal 模式中才打开独立历史阅读层。这比单独列出「滚动、折叠、分页」更能解释它的整体体验。

## 核验环境与方法

| 项 | 值 |
| --- | --- |
| 核验日期 | 2026-10-01（Asia/Shanghai） |
| 版本 | Codex CLI `rust-v0.159.3` |
| 固定 commit | `01fc69f4026735edfdf6789820549727a4867b11`（`New Features`） |
| 一手源码 | `openai/codex`，路径 `codex-rs/tui/src/`、`codex-rs/config/src/`、`codex-rs/protocol/src/` |
| 官方文档 | [Codex CLI 参考](https://learn.chatgpt.com/docs/developer-commands)（主代理已核对；本文交互细节以源码为准，未逐条从文档重述） |
| 方法 | 从入口 `app/input.rs` 追到 `app_backtrack.rs` / `app/owned_transcript.rs` / `transcript_view/*`，再到状态与退出路径 |
| PTY 实测 | 有（主代理执行）。本机 `codex-cli 0.159.3` + 现有 tuistory + localhost WebSocket 假服务，**未调用模型、未接真实 app-server、未开真实会话**。cwd 为本项目，`--remote ws://127.0.0.1:33519`，100×30 / 50×30 PTY，Owned 与 `--no-alt-screen` Terminal 两种模式 |

本文所有 GitHub 链接都固定在上述 commit，行范围基于该快照。行号可能随上游变动失准，请以链接中的 commit 为准。

### PTY 实测的证据等级说明

实测用的是**假服务与 fixture 数据**，不是真实会话。这足以确认「布局、归属模式、按键分发、控件显隐」这类渲染与路由行为，**不足以**确认真实流式输出、真实工具执行耗时、真实历史分页深度。文中凡标 **PTY** 的观察都限定在这个范围内。

### 与既有文档的分工

仓库既有 [codex-tui-interaction-patterns.md](./codex-tui-interaction-patterns.md)（对应 issue #38）覆盖六个方向的模式核验与对本项目的可迁移性判断，其源码快照是 `c248f6d`（2026-09-29）。那份文档把 `Ctrl+T` 描述为「打开 transcript overlay」，本文用 `0.159.3` 源码证明**默认路径下这个说法不准确**，详见第 1 节。既有文档**不覆盖**本文的这些点：默认 Owned/Terminal 归属判定与各自默认值、阅读中的新消息如何被锚定、resize 后的 reflow 与 debounce、选区 snapshot 机制、`copy_on_select` 的终端矩阵、`Enter`/`Esc` 回到底部的条件。

### 证据等级

本文每条结论按此分级：

- **A（源码默认路径）**：读到了 `built_in_defaults()` 或 `#[serde(default…)]` 的实际默认值，且该路径无 feature flag 包裹。
- **B（源码条件路径）**：逻辑在源码中确定，但只在特定配置/终端下生效。
- **C（仅测试或注释）**：只出现在 `*_tests.rs` 或注释里，**不当作无条件默认**。

我特意检查了 `owned_transcript.rs`、`transcript_view.rs`、`transcript_mode.rs`、`app_backtrack.rs` 中是否存在 feature 分支：**没有**。Owned 路径不是实验分支，它由两个普通配置项的默认值决定。因此下面凡是 A 级结论，可以当作当前默认可观察行为。

## 1. 主视图与 Ctrl+T 阅读态的区别（与先前认知的偏差）

`Ctrl+T` 的默认绑定是 `open_transcript`（A）：

```rust
open_transcript: default_bindings![ctrl(KeyCode::Char('t'))],
```

见 [keymap.rs L1645-L1656](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/keymap.rs#L1645-L1656)。它和 `close_transcript` 是**两个不同 action，分属不同 context**：`open_transcript` 在 `Global`（[bindings.rs L271](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/keymap/bindings.rs#L271)），`close_transcript` 在 `Pager`（[keymap.rs L1886](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/keymap.rs#L1886)）。

分发入口是 `App::open_transcript_overlay`（[app_backtrack.rs L159-L181](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/app_backtrack.rs#L159-L181)），它**先判断归属模式再分叉**：

```rust
pub(crate) fn open_transcript_overlay(&mut self, tui: &mut tui::Tui) {
    if tui.is_owned_screen() {
        self.transcript_view.set_presentation(/*detailed*/ true, …);
        tui.frame_requester().schedule_frame();
        return;
    }
    let _ = tui.enter_alt_screen();
    self.overlay = Some(Overlay::new_transcript(…));
    …
}
```

关闭路径 `close_transcript_overlay` 对称地分叉（[app_backtrack.rs L184-L196](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/app_backtrack.rs#L184-L196)）：Owned 下只是 `set_presentation(false, …)` 加 `reset_backtrack_state()`，**不离开屏幕、不销毁视图**。

所以两种模式是：

| | Owned（默认） | Terminal（降级） |
| --- | --- | --- |
| Ctrl+T 行为 | 主视口 `detailed` 布尔翻转 | 进入/退出 alt-screen overlay |
| 视口数量 | 1 个 `TranscriptView`，常驻在 composer 上方 | overlay 内的独立 view，退出即销毁 |
| 位置状态 | `position` 跨 toggle 保留（见下） | 由 `Overlay` 生命周期决定 |
| 事件入口 | `app/owned_transcript.rs` | `pager_overlay/transcript.rs` |

### 位置状态跨 toggle 保留

`set_presentation` 在 detailed 翻转时用 `saved_position` 存取另一态的锚点（[transcript_view.rs L328-L347](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_view.rs#L328-L347)）：

```rust
// Search temporarily expands content without changing either presentation's position.
if self.detailed != detailed && !self.search.is_active() {
    let previous = self.position;
    self.position = self.saved_position.take().unwrap_or(previous);
    self.saved_position = Some(previous);
}
```

这段代码交换当前呈现与另一呈现上次保存的位置，不能解读成每次切换都保持同一锚点。例如详细态上次在底部、紧凑态随后上翻，切回详细态可以恢复它上次的底部位置。PTY 中确实观察到切换后回到底部，但本轮没有系统验证两种呈现分别保存位置的完整矩阵，因此不据此判断源码与运行行为矛盾。见第 10.1 节。

### 键位 context 随阅读态变化

Owned 主视图处于 detailed 时，`Pager` 的 `close_transcript` 被显式并入 active contexts（[app/input.rs L218-L226](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/app/input.rs#L218-L226)）：

```rust
let contexts = if self.transcript_view.is_detailed() {
    contexts.with_transcript_close()
} else {
    contexts
};
```

这就是同一个 `Ctrl+T` 能「开也能关」的实现方式：`Global.open_transcript` 常驻，`Pager.close_transcript` 只在 detailed 时才进入 context 集合。冲突校验按 context 分两轮（app scope 与 composer scope），`Pager` 动作不参与 app 轮的唯一性检查，因此同一按键可以在两个 context 复用。

Owned 路径下 detailed 态的关闭判定是显式的（[app/owned_transcript.rs L441-L450](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/app/owned_transcript.rs#L441-L450)）：仅当 `is_detailed()`、无 active interaction、非 backtrack preview 时，`Ctrl+T` 才被消费为关闭。

## 2. Owned / Terminal 归属与默认门控

归属只有两个开关，判定是**与**关系（B，但默认值明确）：

```rust
pub(crate) fn resolve(owned_enabled: bool, alternate_screen_enabled: bool) -> Self {
    if owned_enabled && alternate_screen_enabled { Self::Owned } else { Self::Terminal }
}
```

见 [transcript_mode.rs L14-L19](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_mode.rs#L14-L19)。模块头注释说明了意图：「The launch-time mode survives session changes so native scrollback never receives retained-only updates.」

两个默认值：

| 配置 | 默认 | 证据 |
| --- | --- | --- |
| `tui.fullscreen_transcript` | **`true`** | [config/types.rs L858-L861](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/config/src/types.rs#L858-L861)，`#[serde(default = "default_true")]`，注释明写 “Own the fullscreen transcript… Defaults to `true`” |
| `tui.alternate_screen` | `auto` | [config/types.rs L876-L882](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/config/src/types.rs#L876-L882)；`AltScreenMode` 的 `#[default]` 是 `Auto`（[config_types.rs L655-L667](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/protocol/src/config_types.rs#L655-L667)） |

`auto` 展开为「除 Terminal.app over SSH 外都用 alternate screen」（[lib.rs L2110-L2130](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/lib.rs#L2110-L2130)）：

```rust
match tui_alternate_screen {
    AltScreenMode::Always => true,
    AltScreenMode::Never => false,
    AltScreenMode::Auto => !terminal_app_over_ssh,
}
```

**结论（A）**：本机 Ubuntu + 普通本地终端（用户当前环境）默认落在 `Owned`。`Ctrl+T` 走的是「翻转主视图 detailed 标志」这条路。只有显式 `--no-alt-screen`、`tui.alternate_screen = never`，或 Terminal.app over SSH，才会走 Terminal overlay 路径。

解析在启动后也会重算一次，若配置在 onboarding/resume 后变化会即时切换屏幕策略（[lib.rs L1926-L1940](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/lib.rs#L1926-L1940)）。

## 3. 滚动、翻页与「回到最新」

`TranscriptView` 拥有唯一的读位置状态，只有两个值（[transcript_view.rs L70-L78](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_view.rs#L70-L78)）：

```rust
enum Position { #[default] Latest, Reading(Anchor) }
```

`Anchor` 指向 **(history cell 指针, 该 cell 内字符 offset, 合成行 bias)**，而不是屏幕行号。这是整个设计的关键：锚点寻址 entry 内部的内容，所以**在头部插入历史页不会让锚点重编号，宽度重排也不会把阅读位置变成无关的屏幕行**（[transcript_view.rs L2-L4](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_view.rs#L2-L4) 模块注释）。

### 滚动量按视口高度推导，不写死

Owned 主视图的键盘滚动在 `handle_scroll_key`（[transcript_view/input.rs L315-L343](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_view/input.rs#L315-L343)）：

- `PageUp` / `PageDown` → `±(area.height - 1)`，即一屏减一行；
- `Esc`（无修饰，且 `can_return_to_latest()`）→ 跳回最新；
- `JumpTarget::Beginning` / `Latest` → 顶/底。

而 `Ctrl+U` / `Ctrl+D` 这类 half-page **不在** Owned 主视图的默认表里——它们属于 `PagerKeymap`（[keymap.rs L1868-L1888](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/keymap.rs#L1868-L1888)），只在 overlay 的 `navigate_pager` 里消费（[transcript_view/input.rs L92-L124](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_view/input.rs#L92-L124)）。

**这是一个容易被忽略的差异**：先前若按 overlay 键表描述 Owned 行为，会把 `j`/`k`/`Ctrl+U`/`Ctrl+D`/`q` 误认为通用翻页键。Owned 路径下：

| 动作 | Owned 主视图 | Terminal overlay（`PagerKeymap`） |
| --- | --- | --- |
| 翻页 | `PageUp` / `PageDown` | `PageUp`、`Shift+Space`、`Ctrl+B` / `PageDown`、`Space`、`Ctrl+F` |
| 半页 | — | `Ctrl+U` / `Ctrl+D` |
| 逐行 | `↑`/`↓`（走 `handle_scroll_key` 之外需活动交互，见下） | `↑`/`k`、`↓`/`j` |
| 顶/底 | `Home`/`End` + `Alt+<`/`Alt+>` | `Home` / `End` |
| 关闭 | `Ctrl+T`（detailed 时） | `q`、`Ctrl+C`、`Ctrl+T` |

Owned 路径对 `PageUp`/`PageDown`/`Home`/`End` 还额外加了**让位检查**：若该键同时绑定了当前 context 的其它非 Pager 动作，就放弃返回 `false`，让那个动作优先（[app/owned_transcript.rs L451-L466](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/app/owned_transcript.rs#L451-L466)）。这是自定义 keymap 的产物，不是默认行为的一部分。

### 顶/底跳的终端兼容别名

`JumpTarget::from_key` 同时接受 `Ctrl+Home`/`Ctrl+End` 与 `Alt+<`/`Alt+>`，并且对 `Alt+Shift+<`、以及 Zellij 可能丢失 Shift 修饰符的情况各有一条分支（[transcript_view/input.rs L48-L82](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_view/input.rs#L48-L82)）。注释说明动机：老终端不发 `Ctrl+Home`/`Ctrl+End`。

`Ctrl+Home`（跳到最早）与 `Home`（pager 顶）也是两个不同按键语义，前者在两个模式下都可用。

### 旧历史分页：靠近起点自动续页

`near_start` 用视口高度做阈值：当前阅读位置距离已加载历史开头 ≤ 一屏时，认为需要更早的历史（[transcript_view.rs L475-L497](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_view.rs#L475-L497)）。`needs_history` 汇总搜索与滚动两条需求。真正发请求的是 `request_owned_history`，它还要求 `scrollback_has_older_history` 且 app server 确实有更早历史（[app/owned_transcript.rs L564-L590](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/app/owned_transcript.rs#L564-L590)）。

这是**受控分页，不是无限虚拟滚动**。分页状态机是 `TranscriptHistoryState::{Idle, LoadingOlder, LoadingBeginning, Partial, Failed}`。

附带的缓存事实（仅记录来源，不展开）：已加载 cell 由 app 持有并传入 view；view 侧只保留**有界** layout cache——`MAX_CACHED_ENTRIES = 64` 与 `MAX_CACHED_TEXT_BYTES = 8 MiB`（[transcript_view/layout.rs L11-L12](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_view/layout.rs#L11-L12)）。选区与 held-reading 的 snapshot **共享 cell 所有权**，只 pin 可见与选中部分的 layout，不整份拷贝。

## 4. 搜索（F3 / `/`）

`find_transcript` 默认绑 `F3`（A，[keymap.rs L1648](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/keymap.rs#L1648)）。`PagerKeymap.find` 则是 `F3` **和** `/` 两者（[keymap.rs L1887](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/keymap.rs#L1887)）。所以 Owned 主视图只有 `F3`，`/` 是打字的，overlay 里才是查找键。

入口分两处：Owned 在 `app/owned_transcript.rs` 里先判 `find_transcript` 再走 `begin_search`（[app/owned_transcript.rs L470-L476](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/app/owned_transcript.rs#L470-L476)）；overlay 在 `pager_overlay/transcript.rs` 里先给 Find 让路再考虑关闭/滚动（[pager_overlay/transcript.rs L410-L435](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/pager_overlay/transcript.rs#L410-L435)）。`app/input.rs` 里 `open_transcript || find_transcript` 会先调 `open_transcript_overlay` 再对 overlay 追加 `begin_search`（[app/input.rs L546-L560](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/app/input.rs#L546-L560)）。

### 搜索强制进入详细态

`begin_search` 无条件 `set_presentation(/*detailed*/ true, …)`（[transcript_view/search.rs L86-L103](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_view/search.rs#L86-L103)），并把原位置、原选区 snapshot、原 detailed 值存进 `Search` 自己的一套 `saved_*` 字段。搜索期间用户看到的是详细渲染，`Esc`/`Ctrl+C` 取消后恢复原状态——**搜索的展开是临时的，不污染 detailed 开关**。

这也是 `set_presentation` 里那句注释 “Search temporarily expands content without changing either presentation's position” 的用意：正常 toggle 走 `saved_position`，搜索则由 `Search` 独立保管，二者互不干扰。

### 搜索是逐帧有界扫描

`Search` 保留**一个** match 和**一个**正在扫的 entry；每帧只检查有界文本块（[search.rs L1-L22](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_view/search.rs#L1-L22) 与常量 `SCAN_BYTES = 16 * 1024`、`ENTRIES_PER_FRAME = 8`、`QUERY_BYTES = 4096`）。扫到最老的已加载 entry 时向 app 的 history pager 请求下一页，pager 拥有加载与失败状态，search 只记住「需要下一页」。

匹配是**字面量**（`Incremental literal search`），不是正则。翻匹配：`Enter`/`Ctrl+N` 往新，`Shift+Enter`/`Ctrl+P` 往旧（[search.rs L156-L195](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_view/search.rs#L156-L195)）。

关键行为：**Find 打开后吃掉所有按键**（该函数无条件 `return true`，注释 “Find owns every key until it closes, including unbound keys and editor chords”）。没有「未绑定键透传给主视图」这种模式。

查询被改写时会放弃 held reading 回到 Latest（[search.rs L184-L190](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_view/search.rs#L184-L190)），即改查询等于重开一次搜索。

## 5. 文本选择与复制

选择是**快照式**的：一旦开始选择，就 `capture_snapshot` 冻结当时的 cell 列表与可见 layout 副本（[transcript_view/selection.rs L35-L73](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_view/selection.rs#L35-L73)，快照构造见 [snapshot.rs L32-L65](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_view/snapshot.rs#L32-L65)）。注释说清动机：「Selection freezes entry order and displayed revisions while canonical history keeps advancing. The snapshot shares cell ownership; only visible and selected text layouts are pinned.」共享所有权而非拷贝，成本可控。

选择单位支持三档（[text_selection.rs L14-L18](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/text_selection.rs#L14-L18)）：1 击按字符、2 击按词（`split_word_bound_indices`）、3 击按逻辑行。行单位按 `\n` 划分，与视觉换行无关。

### 复制键的终端兼容矩阵

`is_copy_key` 接受 `Ctrl+C`、`Cmd+C`（Kitty 报 Super）、`Ctrl+Shift+C`（crossterm 可能只报大写 C + Control）（[text_selection.rs L68-L76](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/text_selection.rs#L68-L76)）。

但这些键**只在有选区时**才被 transcript 消费。`owns_interaction_key` 的条件是 `self.selection.is_some()` 才把 `Ctrl+C` 等纳入（[transcript_view/input.rs L126-L155](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_view/input.rs#L126-L155)）。无选区时 `Ctrl+C` 不属于 transcript。

### 复制动作的三个变体

`ViewAction` 区分了复制语义的细微差别（[transcript_view/input.rs L23-L29](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_view/input.rs#L23-L29) 与 [L268-L282](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_view/input.rs#L268-L282)）：

| 触发 | 动作 | 语义 |
| --- | --- | --- |
| `Ctrl+C` / `Cmd+C` / 右键 | `Copy` | 复制并**清除**选区 |
| 释放鼠标（`copy_on_select` 开启且选区非空） | `CopyOnSelect` | 复制但**保留**选区 |
| `Enter`（有选区） | `CopyAndFollow` | 复制、清除，并回到底部跟随 |

模块头注释记录了这条约定：「Automatic copies retain the selection; explicit copies clear it after confirmed delivery.」复制是否真的送达由 `CopyStatus::Pending` 判定，未确认时保留状态等待（[app/owned_transcript.rs L525-L546](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/app/owned_transcript.rs#L525-L546)）。

### `copy_on_select` 默认是终端相关矩阵，不是布尔

默认 `auto`，判定逻辑（[local_settings.rs L132-L172](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/local_settings.rs#L132-L172)）：

- 有 multiplexer（tmux/Zellij）→ 开启；
- Ghostty **≥ 1.2** → 关闭（其 Cmd-C 与 Ctrl-Shift-C 都会在无选区时转发按键）；
- Kitty → 非 macOS 开启；
- Windows Terminal → 关闭（含 WSL）；
- VS Code → 非 Windows 开启；
- Apple Terminal / iTerm2 / Warp / WezTerm / Alacritty / Konsole / GNOME / Vte / Dumb / **Unknown** → 开启。

注释里的判据是「哪些终端会转发自己的原生复制快捷键」。**未知终端默认开启**——这是一个显式的 fail-open 选择，不是疏漏。Owned 路径每帧从 `local_settings` 重新写入 `view.copy_on_select`（[app/owned_transcript.rs L44-L48](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/app/owned_transcript.rs#L44-L48)），不是启动时固定。

### 鼠标手势的优先级

`handle_mouse` 有一串明确的互斥顺序（[transcript_view/input.rs L174-L266](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_view/input.rs#L174-L266)）：

1. 回到底部控件的 hover/click（独立处理，不走选区）；
2. `Ctrl`/`Cmd` + 点击 composer tip 上的 hyperlink → 打开链接；
3. 视口外且未拖拽 → 忽略；
4. 滚轮 → 滚动 3 行，**并清掉选区 pointer**（滚轮优先于拖拽起点）；
5. 右键（视口内）→ 复制当前选区；
6. 左键按下 → 无修饰先试 disclosure 切换（`+ N lines`），再试 hyperlink，最后进入选择；
7. 拖拽中左键 → 扩展选区；
8. 左键释放 → **只有静止点击**才开链接（拖回原点仍是选择）；然后 `copy_on_select`。

`Shift+点击` 从原选区扩展（不清除原 anchor）。双击/三击命中行尾时不触发（避免和行末换行选择冲突）。

## 6. 阅读时的新消息：跟随、锚定与「New activity」

这是 Owned 模式最值得学的部分，也是纯 overlay 方案给不了的。

### 位置冻结 + 未读标记

`is_following()` 的定义是「无选区 **且** 位置为 Latest」（[transcript_view.rs L355-L357](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_view.rs#L355-L357)）。一旦用户滚动离开底部，`Position::Reading(anchor)` 生效，后续新内容**不会**把视口拽走。

新活动通过 `unseen_activity` 标记。两条更新路径：

- 尾部 cell 被替换或新增时由 `sync_history_tail` 检测 `last_tail` 变化（[transcript_view/mutations.rs L9-L27](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_view/mutations.rs#L9-L27)）；
- live 布局 revision 变化时由 `sync_live_layout` 置位，条件是 `!is_following() && revision_changed && live.is_some()`（[transcript_view.rs L275-L291](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_view.rs#L275-L291)）。

反过来，只要尾部行在视口内可见，`unseen_activity` 每帧被清零（[transcript_view.rs L262-L265](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_view.rs#L262-L265)）。**「有新消息」的判据是视觉可见性，不是逻辑到达。**

### 回到底部控件的分级降级

控件画在 composer 上方的既有间隙里，**尾部行可见时完全不画**（[transcript_view/follow_control.rs L52-L73](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_view/follow_control.rs#L52-L73)）：

```rust
if self.area.is_empty() || self.tail_visible || self.highlight.is_some()
    || self.selection.is_some() || self.is_search_active() { return None; }
```

文案按宽度降级，未读时与已读时两套（有 `New activity` / `New` 前缀），最长 `New activity · ↓ Back to bottom · esc`，最窄只剩 `↓`。有选区或搜索中不显示，避免与选区/查询行抢空间。

### 回到底部的按键：Esc 与 Enter 有条件

`can_return_to_latest()` 就是 `!is_following()`（[transcript_view/activity.rs L7-L9](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_view/activity.rs#L7-L9)）。两个入口：

- `Esc`（无修饰）：`handle_scroll_key` 里 `if self.can_return_to_latest()` 才跳底；
- `Enter`：**仅当 composer 为空、无 modal/popup、未 primed backtrack** 时跳底（`enter_returns_to_latest`，[app/owned_transcript.rs L550-L557](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/app/owned_transcript.rs#L550-L557)）。

footer 提示的文案会跟着变：`enter/esc latest` 或 `esc latest`（[app/owned_transcript.rs L75-L81](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/app/owned_transcript.rs#L75-L81)）。**这是「让用户知道自己能回去」的成本最低做法。**

但 `Esc` 在 Owned 路径上语义有竞争：它同时是 backtrack 的「第一步 prime」。实际顺序是——若满足 backtrack 条件走 `handle_owned_backtrack_event`，否则才 `jump_to_latest`（[app/owned_transcript.rs L425-L440](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/app/owned_transcript.rs#L425-L440)）。所以「Esc 第一次只 prime、不动视口」是 backtrack 优先的结果。

### 正在变化的 cell 会被快照钉住

若阅读锚点落在**不稳定**的 cell 上（流式文本、动画 tick），`hold_live_reading` 会 `capture_snapshot` 并把该 cell 的 layout 钉住（[transcript_view/snapshot.rs L70-L100](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_view/snapshot.rs#L70-L100)）。判据是 `!cell.has_stable_transcript_height() || cell.transcript_animation_tick().is_some()`。

效果：**用户在读到一段还在增长的内容时，那段内容不会继续长高把他顶走**；导航离开时 `release_live_reading` 重回当前真实历史。这比「只记一个行号」复杂得多，但它是长会话阅读不抖的前提。

`replace_range` / `replace_group` 在 history 被重写时，用 `remap` 把锚点搬到替换后的 cell（[transcript_view/mutations.rs L29-L66](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_view/mutations.rs#L29-L66)）。若已有 snapshot（选区或 held reading），直接早退不改锚点。

## 7. resize 行为

resize 分两条完全不同的路径，取决于归属模式。

### Terminal 模式：reflow + debounce

`TranscriptReflowState` 的模块注释说明了问题本质：「Terminal scrollback is not a retained widget tree: once Codex writes wrapped lines into the terminal, the terminal owns those rows.」宽度变化时把内存 cell 当事实源，清掉 Codex 自己写的历史，按新宽度重发（[transcript_reflow.rs L1-L20](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_reflow.rs#L1-L20)）。debounce 常量 `TRANSCRIPT_REFLOW_DEBOUNCE = 75ms`（[transcript_reflow.rs L22](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_reflow.rs#L22)）。

设计里有一处值得学的细节：`last_observed_width` 与 `last_reflow_width` **刻意分开**。注释解释：终端在拖拽 resize 时会先报一个中间尺寸再稳定，若假设「最新观测宽度已修复」就会漏掉最后一次重建（[transcript_reflow.rs L24-L36](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_reflow.rs#L24-L36)）。

还有一个硬约束：流式输出进行中发生的 reflow 请求，必须在流结束后**再补一次**基于源的 reflow（[transcript_reflow.rs L14-L18](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_reflow.rs#L14-L18)）。

不同终端的 scrollback 策略也不同（[tui/scrollback.rs L22-L32](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/tui/scrollback.rs#L22-L32)）：Zellij 走 `scroll_region_up`；Windows Terminal / `WT_SESSION` 走 FullScreen（整屏滚动，注释说部分 DEC scroll region 会丢行而不是进 scrollback）；标准终端在 `viewport_top > 1` 时用 `SetScrollRegion` + 在历史区底部打换行，注释明写这样能「preserve native scrollback while protecting the composer」，且提到 QTermWidget 和 xterm.js 的 `CSI S` 会丢弃行。

### Owned 模式：只重排，不 reflow

Owned 下 terminal scrollback 不是事实源，只有 `TranscriptView` 的 layout cache 需要按新宽度重算。`prepare_width` + `rewrap_snapshot` 负责后者（[transcript_view/snapshot.rs L114-L121](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_view/snapshot.rs#L114-L121)）。

layout cache 有两个硬上限（[transcript_view/layout.rs L11-L12](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_view/layout.rs#L11-L12)）：`MAX_CACHED_ENTRIES = 64`、`MAX_CACHED_TEXT_BYTES = 8 * 1024 * 1024`。缓存 key 含 `width`、`CellPresentation`、`animation_tick`、以及渲染态（theme / 前景 / 背景 / color level）。

raw 模式切换在 Owned 下走 `set_presentation`（复用现有位置），在 Terminal 下才触发 `reflow_transcript_now`（[app/input.rs L314-L345](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/app/input.rs#L314-L345)）。

## 8. raw 模式

`toggle_raw_output` 默认 `Alt+R`（A，[keymap.rs L1656](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/keymap.rs#L1656)）。持久化项 `tui.raw_output_mode` **默认 `false`**（B，[config/types.rs L852-L856](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/config/src/types.rs#L852-L856)）。

它切的是 `HistoryRenderMode::Rich` ↔ `Raw`（[chatwidget.rs L1627-L1640](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/chatwidget.rs#L1627-L1640)），即**每个 history cell 的第三种渲染视图**（`raw_lines`），不是「关掉装饰」的 UI 开关。Owned 路径下它与 detailed 独立——`set_presentation(is_detailed(), history_render_mode())` 保留当前 detailed 值（[app/input.rs L325-L330](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/app/input.rs#L325-L330)）。

切换会发出一次通知（`set_raw_output_mode_and_notify`），文案在 `raw_output_mode_notice`（[chatwidget.rs L1652-L1666](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/chatwidget.rs#L1652-L1666)）。

注释对 raw 模式的定位是「copy-friendly transcript selection」——**它的价值是让终端自身的选区复制拿到可读文本**，与 Owned 模式自带的选区机制是两条路。

## 9. 与先前「网页式 scroll / paging」建议的差异

这几处与「把 transcript 当网页、按页翻」的直接推断不同，按重要性排序：

1. **默认不是 overlay，而是同一视口的状态翻转。** 若 Companion 按「主视图 + 独立阅读 overlay」两套渲染设计，会重复实现位置、选择、搜索三套状态。Codex 的做法是 `Position::Latest | Reading(Anchor)` 一个枚举 + 一个 `saved_position` 解决 compact/detailed 互切。
2. **翻页量由视口高度推导**（`height - 1`），没有「每页 N 行」的常量。硬编码页大小在 resize 后必然失准。
3. **「回到最新」是三态的**：`unseen_activity`（有新活动）、`can_return_to_latest`（不在底部）、`tail_visible`（底部在视野内）三者组合决定控件显隐与文案，且 footer 会显式提示 `enter/esc latest`。只看「是否在底部」是不够的——停在底部附近但最后一屏没露出来，也是需要提示的状态。
4. **锚点寻址到 cell 内字符 offset，不是行号。** 预分页插入、宽度重排、cell 替换、组 join 都不会让阅读位置漂移。行号方案在任何一个上游变化下都会跳。
5. **读到正在增长的内容时钉住快照。** 没有这一步，用户停在流式输出中间会被持续增长的内容顶走。
6. **搜索临时提升到详细态，自带独立 saved_* 状态。** 搜索的展开不污染 detailed 开关，两套 saved 状态互不干扰。
7. **`Enter` 也能回到底部，但只在 composer 空时。** 这是有意的：composer 有草稿时 `Enter` 属于用户。
8. **无选区时 `Ctrl+C` 不属于 transcript。** 复制键只在有选区时才被 transcript 消费，避免和应用的退出/中断语义打架。
9. **`copy_on_select` 的默认值按终端能力调整。** 未知终端默认启用选择后复制。Companion 是否采用鼠标选区、如何处理终端原生复制，需要结合实际终端能力另行验证。

第 1 点与既有 [codex-tui-interaction-patterns.md](./codex-tui-interaction-patterns.md) 第 1 节「显式 transcript overlay」的表述直接冲突。那份文档基于 `c248f6d` 快照，其「Ctrl+T 打开 transcript overlay」在 0.159.3 的**默认配置下不成立**——准确说法是「`Ctrl+T` 切换主视口的详细/紧凑呈现；只有在 Terminal 降级模式（`--no-alt-screen` 等）下才表现为打开全屏 overlay」。PTY 已双向确认（Owned 无 overlay，Terminal 有 `/TRANSCRIPT/` 层）。

另需修正一处旧研究的简化：**`Esc` 不是 transcript overlay 的通用关闭键**。Terminal overlay 的 footer 写明 `esc browse prompts`（触发 backtrack 浏览），关闭键是 `q`。详见第 10.8 节。

## 10. PTY 实测证据（Owned 模式）

以下观察来自主代理在本机的真实 Codex TUI 渲染（本机 `codex-cli 0.159.3`，localhost WebSocket 假服务提供固定的 turn/item 消息，**未调用模型、未接真实 app-server、未开真实会话**）。资产在 `artifacts/codex-transcript-research/`。

这批证据的价值在于：它**独立于源码**确认了第 1、3、6 节关于「Owned 视口 + 状态翻转 + 阅读时新消息不挪视口」的结论。

### 10.1 Ctrl+T 是 details 切换，不是打开独立 overlay（PTY）

100×30，默认 Owned。紧凑态主视图顶部是 sticky 用户 prompt，工具区显示为 `Explored` 摘要 + `+ Show details`，composer 与 statusline 常驻底部。按 `Ctrl+T` 后：

- **主视图整体布局不变**——composer 仍在底部、顶部 prompt 仍在，**没有出现一个覆盖主界面的独立全屏 overlay**；
- 视觉上「看起来没变」是因为当时视窗正落在长正文尾部（`8..30` 行），而尾部在 compact 与 detailed 下渲染相同；
- 随后的 `PgUp` 才暴露出差异：工具区从 `+ Show details` 摘要变成**完整原始输出**（`$ rg transcript src` 及 13 行 `fixture output …`），并出现 `✓ 70ms` 耗时标记。

这正是源码预测的行为：`Ctrl+T` 只翻 `detailed` 布尔，差异只体现在**工具 cell 的渲染视图**上，正文尾部在两种呈现下逐字相同。**若只看按下 `Ctrl+T` 后的那一帧，会误判为「没反应」**——这是源码之外的、只有实测才会暴露的交互陷阱。

**实测还观察到切换后回到底部**。源码会交换两种呈现各自保存的位置，所以不能据此断言其意图是保持同一锚点、也不能将该观察直接当作 bug。Companion 是否分别恢复位置，还是总保持当前阅读锚点，仍是待讨论的取舍。

资产：`owned-compact-100x30.txt`、`owned-detailed-100x30.txt`、`owned-detailed-100x30.png`。

### 10.2 阅读时新消息不挪视口，草稿不丢（PTY）

在 detailed 态回看工具输出时，composer 保持「未发送草稿」文本。localhost 假服务随即推送 `turn/started` + `item/agentMessage/delta`：

- 工具输出视窗**完全不动**（仍显示 `fixture output 3..13`），新内容没有把视口拽到底部；
- **composer 草稿完整保留**；
- 提示条从 `↓ Back to bottom · esc` 变为 `New activity · ↓ Back to bottom · esc`。

这与 `unseen_activity` 的两态设计完全对应（第 6 节）：内容到达时置位，尾部行进入视口时清零。提示文案的分级降级也在实测中可见。

资产：`owned-new-activity-100x30.txt`、`owned-new-activity-100x30.png`。

### 10.3 F3 搜索：底部查询行、定位到工具输出、草稿保留（PTY）

50 列，detailed 态。`F3` 在 Owned 主视图**底部**打开 Find 查询行（不是独立搜索面板）。输入 `fixture output 10` 后：

- 视窗跳到工具详细输出并高亮该行（可见 `fixture output 10..16` 与 `✓ • 70ms`）；
- **composer 草稿「未发送草稿」完整保留**；
- 查询行 footer 显示 `Find: fixture output 10` + `enter next · ctrl+p previous · esc close`。

资产：`owned-search-50x30.txt`。

### 10.4 搜索关闭后回到阅读位置（PTY）

源码中 `Search` 自持一套 `saved_position`/`saved_snapshot`，取消时恢复阅读状态（第 4 节）。PTY 中 `Esc` 关闭 Find 后回到阅读视图，提示条恢复为 `↓ Back to bottom · esc`，草稿仍未变。此次没有保存搜索前后的完整锚点对照，不能把它升级为精确字符位置恢复的实测证明。

资产：`owned-search-50x30.txt`；搜索关闭后的精确锚点恢复仅有源码证据。

### 10.5 Esc 从阅读态返回最新（PTY）

阅读态按 `Esc` 回到最新（跳到底部），「未发送草稿」保持不变。再次进入阅读仍可回看。

### 10.6 footer 提示随 composer 状态与运行态变化（PTY）

同一场景下 footer 出现三种不同文案，都能对回源码：

| footer 文本 | 条件 | 源码依据 |
| --- | --- | --- |
| `enter/esc latest · ? shortcuts` | composer **空**、不在底部 | `enter_returns_to_latest()` 为真 → `latest_navigation = "enter/esc latest"`（[app/owned_transcript.rs L75-L81](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/app/owned_transcript.rs#L75-L81)） |
| `esc latest` | composer **有草稿** | `enter_returns_to_latest()` 为假 → 只提示 `esc` |
| `tab to queue message` | 有 task 在运行 | composer 自己的 footer 提示**接管**了这一行，transcript 导航提示让位 |

第三种是提示优先级的取舍：任务运行时 composer footer 让位给排队提示，但对话区仍显示包含 `Back to bottom · esc` 的独立跟随控件，因此回到最新的入口仍然可见。

### 10.7 窄屏（50×30）resize 与重排（PTY）

50 列时中文长句按正确宽度换行（缩进续行如「窄屏换行。」），**settle 后的快照换行正确**。但 resize **即时第一帧曾出现截边**，settle 后才恢复正确。**因此本文不宣称 Codex resize 逐帧无瑕**——最终内容正确，但存在一帧中间态。

静态内容收敛后的 50 列快照可见正确换行；本轮没有完整记录 resize 前后字符锚点，锚点保持机制仍以源码为证，不宣称已完成其运行验收。

资产：`owned-compact-50x30.txt`、`owned-search-clean-50x30.txt`、`owned-local-disclosure-50x30.txt`。`owned-live-tail-50x30.txt` 留下即时采集的截边帧，不能作为最终重排证明。

### 10.8 Terminal 模式（`--no-alt-screen`）：这才是真正的 overlay（PTY）

以 `--no-alt-screen` 启动（Terminal 归属）后，`Ctrl+T` **确实**打开一个带 `/TRANSCRIPT/` 斜纹标题的**全屏层**，**composer 不在该层内**，footer 变为：

```
Ctrl+Space select
 ↑/↓ to scroll · pgup/pgdn to page · home/end to jump
 q close · f3 find · esc browse prompts
```

这与源码的 `PagerKeymap` 完全对得上：`↑`/`↓` 滚动、`PgUp`/`PgDn` 翻页、`Home`/`End` 跳转、`q` 关闭、`F3` 查找。

**这里要纠正一个旧研究的简化**：既有 [codex-tui-interaction-patterns.md](./codex-tui-interaction-patterns.md) 及常见说法把 `Esc` 泛化为「关闭 transcript overlay 的键」。**在本例 footer 文案明确是 `esc browse prompts`——`Esc` 触发的是 backtrack 浏览 prompt，不是无条件 close。** 关闭键是 `q`（及 `Ctrl+T`/`Ctrl+C`，见 `PagerKeymap.close`/`close_transcript`）。`Esc` 的作用是进入「浏览历史 prompt 以回溯编辑」，与「关闭层」是两件事，不能混为一谈。

资产：`terminal-transcript-100x30.txt`。

### 10.9 这些证据**不**覆盖什么

- 假服务推送的是固定 fixture，不含真实流式 token 速率、真实工具执行、真实历史分页。因此「真实 turn 中途 resize」「真实长会话分页到第 N 页」仍未验证。
- resize 只在 fixture 静态内容上验证了最终重排正确，**未验证 resize 与真实流式同时发生**的情形（源码对此有专门约束，见第 7 节）。
- 未实测 `Ctrl+Home/End` 顶底跳、`copy_on_select`、raw 模式（`Alt+R`）的实际行为。
- Terminal 模式只验证了 overlay 的打开与 footer 键位，未深测其内滚动/选区细节。

## 11. 体验层与实现层必须分开

既有 [codex-tui-interaction-patterns.md](./codex-tui-interaction-patterns.md) 的可迁移性表格里有一行：

> `Owned` transcript / alternate-screen 归属与 scrollback 策略 | **不迁移** | 依赖 Rust 自定义终端，Ink 方案在 stdout 帧上工作

**这个「不迁移」的判断只成立于实现层，不应被读成体验层的理由。** 两者必须分开：

| | 层次 | 判断 |
| --- | --- | --- |
| **实现层** | `ScrollbackStrategy`、原生 scrollback 重排、DEC scroll region、终端特判 | Codex 的 crossterm/ratatui 实现不能直接复用。Companion 须在现有 Ink 约束下验证对应实现。 |
| **体验层** | 同一视口的详细/紧凑呈现、阅读时新消息提示、阅读锚点、条件回底、草稿保护 | 可作为体验参考；它们不要求复制 Codex 的终端实现，但具体代价和可行性仍需在 Companion 原型中验证。 |

后续取舍需要结合 [ink-react-terminal-constraints.md](./ink-react-terminal-constraints.md)。本轮确认了体验参考的具体行为，没有完成 Companion 的实现可行性验收。

## 12. 消息、回合与视觉层级

用户消息用 `›` 引导，带独立背景/留白和两列续行缩进；按终端显示宽度换行。助手正文用弱化的 `•` 引导首行，续行缩进，按 Markdown 呈现。主对话没有每条消息都重复的角色标题，也没有每回合一个大边框。流式段落的 continuation 标记用于避免重复添加段落间距。[用户与助手消息源码](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/history_cell/messages.rs#L178-L254)、[助手 continuation](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/history_cell/messages.rs#L426-L520)。

完成后的助手消息保留 Markdown 原文，resize 时从原文重新渲染，而非反复换行已经换行的文本。完整正文与视口只显示其中一段是不同层次；长消息不因为当前视口较小就丢掉前半段。[完成态与原文](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/history_cell/messages.rs#L490-L645)。

历史回看时会按条件显示当前用户 prompt 的紧凑上下文提示，正文仍是连续时间线。完成信息在最终回复之后以弱化的耗时/时间行呈现；没有可靠历史元数据时不补造时间，恢复历史不使用当前时钟冒充当时完成时间。[prompt header](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_view/prompt_header.rs)、[完成信息](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/history_cell/separators.rs#L1-L122)、[恢复规则](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/chatwidget/completion.rs#L1-L62)。

因此「回合」不必表达成新的目录、卡片或编号。用户输入、助手说明、活动组、最终正文和轻量完成信息已经提供阅读结构。此项是源码观察，不替代 Companion 的数据身份合同。

## 13. 工具按活动语义组织，并有两种展开尺度

| 活动 | 紧凑呈现 | 详细呈现与边界 |
| --- | --- | --- |
| 文件读取/目录列举/搜索 | `Exploring` / `Explored`，下接 Read/List/Search 摘要；连续成功读取可合并文件名称 | 保留各命令、输出、状态与相对顺序；只合并兼容的探索活动 |
| 普通命令 | Running/Ran；失败时显式 Failed 和退出码；Owned 紧凑态通常取最后三行输出 | 完整保留范围内的命令/输出、退出结果与耗时；不是探索组的一员 |
| MCP 工具 | Calling/Called，工具身份与参数/结果摘要，结果预览共用三行预算 | 展开调用参数与完整保留结果；普通 MCP 调用不是任意相邻工具组 |
| 特定 computer 活动 | 单独的语义活动组 | 仅对应该类工具，不是所有 MCP 的规则 |
| 等待后台命令、空 stdin 轮询 | 主要进入单一 Waiting 状态；成功且无输出的记账记录可在主视图隐藏 | 详细历史可保留相关操作；不靠每次轮询增加主对话行 |

来源：[探索组兼容条件](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/exec_cell/model.rs#L85-L142)、[Read/List/Search 判定](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/exec_cell/model.rs#L233-L245)、[探索摘要](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/exec_cell/render.rs#L300-L450)、[Owned 命令预览](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/exec_cell/compact.rs#L68-L140)、[MCP](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/history_cell/mcp.rs#L145-L241)、[等待记录](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/chatwidget/command_lifecycle.rs#L79-L140)。

这里有两种展开尺度：

- **整段详细模式**：Owned 下 `Ctrl+T` 切换整个视口的 compact/detailed 呈现；Terminal 下进入独立详细阅读层。
- **局部活动展开**：Owned compact 下有 `+ Show details` / `− Show less` 行，可鼠标选择该入口；默认 `F4` 进入活动导航，↑↓ 选活动，Enter 切换展开，左右控制收展，Esc 返回。普通文字退出活动导航并继续编辑 composer。搜索进行中和整段 detailed 时不进入这个局部导航。

来源：[F4 默认键](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/keymap.rs#L1645-L1654)、[活动展开与输入分发](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_view/disclosure.rs#L135-L242)。本机 50×30 PTY 已验证 `F4 → Enter` 把探索摘要原位展开为命令和保留输出，composer 仍可见；见 `owned-local-disclosure-50x30.txt` / `.png`。鼠标点击没有实测。

长输出的「完整」指系统实际保留的范围。工具结果本身可能已被 transport、执行器或存储截断；UI 中的展开不能恢复上游未保留内容。预览在换行前限制字符/字节和屏幕行数，避免先处理巨量文本再截取显示。[有界输出预览](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/tool_output.rs#L1-L115)、[详细命令输出](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/exec_cell/transcript.rs#L1-L94)。

失败读取仍可留在同一探索组，摘要会显示失败数，细项保留退出码。普通命令和 MCP 的失败有各自独立的状态呈现。Codex 对中断时尚未完成的本地活动会做 failed 收尾；Companion 的 unknown/unverifiable 不应据此改成失败，因为其副作用三值语义不同。[失败计数](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/exec_cell/render.rs#L240-L265)、[中断收尾](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/chatwidget/turn_runtime.rs#L313-L350)。

## 14. 生成过程有内容阶段和空档阶段

Codex 的生成显示由已完成历史 cell 和可变 active cell 组成。active cell 可以是正在增长的助手文本、执行中的工具活动或探索组；内容变化使用其身份与 revision 刷新，历史阅读视图也能显示 live tail。[ChatWidget 说明与入口](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/chatwidget.rs#L1-L29)。

流式正文分成稳定区和可变尾部。普通换行完成的文本进入有序渲染队列；尚未完成的段落使用有界 preview，表格等需要整体重排的内容留在可变尾部。完整 item 到达时用完成正文校正累积片段，并合并为可从 Markdown 原文重新渲染的消息。[流式分区](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/streaming/controller.rs#L1-L44)、[完成正文校正](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/chatwidget/streaming.rs#L82-L190)。这里的「渲染提交」不等于 Companion 的 durable Committed Model Step；不能按同一词直接复用持久化语义。

状态行在 composer 上方，由短标题、独立 elapsed timer、可选 interrupt 提示组成；细节默认最多三行。正文真正开始显示时隐藏状态行；commentary 结束、队列排空而任务仍运行时恢复状态行。多个进度提示不同时争夺底部空间。[状态行](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/status_indicator_widget.rs#L1-L103)、[恢复条件](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/chatwidget/streaming.rs#L151-L176)、[正文尾部显示时隐藏状态](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/chatwidget/streaming.rs#L624-L647)。PTY 已确认假 delta 能显示成正文、阅读历史时只更新新活动标记；完整 Working/流式阶段切换主要是源码证据，没有真实 Provider 验证。

reasoning summary 来自实际 reasoning 事件。最新可用摘要可作为状态标题；完成后的摘要 cell 默认只进 detailed transcript，不在普通对话时间线里逐条铺开。raw 视图也不显示这类 transcript-only reasoning。原型中常驻的「思路摘要」并非当前 Codex 的默认主对话规则。[摘要与状态标题](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/chatwidget/streaming.rs#L302-L365)、[摘要 cell 的三种呈现](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/history_cell/messages.rs#L324-L424)。

## 15. 问题交互与普通输入有明确的状态归属

Codex 同时存在同步 request-user-input 交互和异步问题编辑器，不能将两者归为一个固定高度卡片。

异步问题可以先只显示问题数量和进入回答的提示；进入后在底部区域展示问题、选项/自由输入、进度与上下文键位。每题有独立身份及草稿，导航或收起先保存草稿；默认 Esc 可以返回 composer。输入被本地 submit/queue 接受后才消费答案，失败则保护原 composer 草稿。[收起摘要](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/bottom_pane/questions.rs#L66-L92)、[问题身份与草稿](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/bottom_pane/async_questions/state.rs#L1-L95)、[独立回答路由](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/chatwidget/questions.rs#L42-L189)。

同步问题和审批等受保护交互可在助手流式完成前延后打开，避免插入一段正在生成的正文。结束后的问答在历史里可显示 answered 数量、问题与对应答案、interrupted/unanswered 状态。[中断队列](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/chatwidget/interrupts.rs#L1-L55)、[问答历史](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/history_cell/request_user_input.rs#L1-L116)。这一节是源码核验，没有做问答 PTY 测试。

Companion 的 Pending Interaction 是 durable、带 owner Session 和 expected revision 的事实；Codex 的问题队列、倒计时或自动选择不是其授权来源。可参考底部交互、草稿保护和历史可读性，提交仍须沿用 Companion 的专用回答命令。

## 16. 供后续讨论的具体分歧

本轮不代用户调整已经确认的决定。第一轮「阅读时不被新内容拉走」「长正文可完整阅读」与 Codex 主视图一致；以下细节有新的证据可讨论：

| 先前候选 | 调研发现 | 下一轮应讨论的实际分歧 |
| --- | --- | --- |
| 任意相邻工具合组 | Codex 按探索、命令、MCP 等语义分类；每类紧凑规则不同 | Companion 的受控工具怎样按语义收拢，哪些必须独立可见 |
| 逐条有界展开 | Codex 有局部活动展开和整段详细模式；详情可浏览实际保留的完整输出 | 需要哪两种阅读尺度，以及有限输出怎样继续浏览 |
| 思路摘要在时间线常驻 | 默认主视图以 reasoning 更新状态标题，完整摘要进详细态 | 普通时间线是否保留摘要，以及可信数据来源 |
| 生成中正文旁常驻提示 | 正文显示时隐藏重复状态提示，输出空档才恢复 | 正文、活动和状态怎样共用空间与注意力 |
| 平铺键位表 | 同一键随输入、阅读、Find、活动导航、prompt backtrack 改变职责 | 保留现有全局键位后怎样设计上下文优先级和帮助提示 |
| 固定待答卡作为唯一样式 | Codex 异步问题有收起提醒和底部编辑，另有同步问题/审批 | Companion 已定待答卡应如何展开、回答、返回和留下历史 |

生产 transcript 当前仍是尾窗，不是真分页；未实现滚动和实时 draft 投影。体验选择完成后，由后续实施票核定消息身份、历史游标、tool call/result、stream draft 与 Pending Interaction 正文来源。UI 不自行读取全部 checkpoint 或按文字猜运行状态。

终端资产及复现说明见 [调研样例](../../artifacts/codex-transcript-research/README.md)。

## 未验证与不确定

- 官方文档未逐条重述 Owned/Terminal 归属的判定逻辑；本文该部分**只有源码证据**，无文档交叉验证。若主代理手上有 `https://learn.chatgpt.com/docs/developer-commands` 关于 `Ctrl+T` 的原文描述，值得比对是否与源码默认值一致（本文未做此比对）。
- 快照固定在 `01fc69f`（rust-v0.159.3）。用户本机安装的 Codex 二进制版本若不同，配置默认值可能已变。
- PTY 实测用的是假服务与 fixture，未覆盖真实流式、真实工具、真实分页（详见第 10.9 节）。
- PTY 观察到切换 detailed 后回到底部；源码交换两种呈现分别保存的位置。本轮没有验证完整切换矩阵，不将其推断为源码与运行行为矛盾。
- `app_keymap_shortcuts_available()` 是一道额外门控（[app/input.rs L537-L545](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/app/input.rs#L537-L545)），本文未追它的完整条件；它会影响「某些环境下快捷键整体不可用」的情形。
- layout cache 的失效条件（theme / color level 变化触发重算）只读了 key 结构，未逐行核对 `layout()` 的完整失效逻辑。
- `TranscriptView::render` 的 prompt header 让位逻辑（`suppressed_prompt_header`）只做了结构层面阅读，未验证多轮对话下的实际表现。

## 直接来源

全部固定在 commit [`01fc69f4026735edfdf6789820549727a4867b11`](https://github.com/openai/codex/tree/01fc69f4026735edfdf6789820549727a4867b11)。

**归属与默认**

- [transcript_mode.rs](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_mode.rs#L1-L24) — 归属枚举与 `resolve`
- [config/types.rs L852-L882](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/config/src/types.rs#L852-L882) — `raw_output_mode` / `fullscreen_transcript` / `alternate_screen` / `copy_on_select` 默认值
- [config_types.rs L650-L670](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/protocol/src/config_types.rs#L650-L670) — `AltScreenMode` 的 `#[default] = Auto`
- [lib.rs L1908-L1945](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/lib.rs#L1908-L1945) — 归属解析与重算
- [lib.rs L2108-L2130](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/lib.rs#L2108-L2130) — `determine_alt_screen_mode`
- [tui.rs L805-L816](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/tui.rs#L805-L816) — `is_owned_screen`

**入口与分发**

- [app_backtrack.rs L157-L220](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/app_backtrack.rs#L157-L220) — `open_transcript_overlay` / `close_transcript_overlay` 的 Owned/Terminal 分叉
- [app_backtrack.rs L1-L25](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/app_backtrack.rs#L1-L25) — backtrack 状态机与 Owned/overlay 双路说明
- [app/input.rs L200-L235](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/app/input.rs#L200-L235) — active keymap contexts 与 `with_transcript_close`
- [app/input.rs L535-L562](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/app/input.rs#L535-L562) — `open_transcript` / `find_transcript` 入口
- [app/input.rs L310-L348](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/app/input.rs#L310-L348) — `apply_raw_output_mode` 的 Owned/Terminal 分叉
- [app/owned_transcript.rs](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/app/owned_transcript.rs) 全文 — Owned 主视图渲染与事件路由（L42-L60 同步、L288-L360 事件、L441-L466 让位、L470-L546 动作处理、L550-L590 回底与分页）
- [pager_overlay/transcript.rs L398-L437](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/pager_overlay/transcript.rs#L398-L437) — overlay 的按键优先级

**视图状态**

- [transcript_view.rs](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_view.rs) — `Position`/`Anchor`（L50-L78）、`render`（L159-L265）、live 同步（L270-L291）、`set_presentation`（L328-L347）、`is_following`（L355-L357）、`scroll`（L365-L420）、`near_start`/`needs_history`（L470-L497）
- [transcript_view/input.rs](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_view/input.rs) — `JumpTarget`（L31-L82）、`navigate_pager`（L92-L124）、`owns_interaction_key`（L126-L155）、`handle_key`（L158-L186）、`handle_mouse`（L188-L266）、`handle_scroll_key`（L315-L343）
- [transcript_view/search.rs](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_view/search.rs) — 常量与状态机（L1-L81）、`begin_search`（L86-L103）、`handle_search_key`（L156-L195）
- [transcript_view/selection.rs](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_view/selection.rs) — `Selection`/`PendingCopy`（L10-L33）、`begin_selection`（L35-L73）、`end_selection`（L77-L110）
- [transcript_view/snapshot.rs](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_view/snapshot.rs) — `ViewSnapshot`（L7-L11）、`capture_snapshot`（L32-L65）、`hold_live_reading`（L70-L100）、`rewrap_snapshot`（L114-L121）
- [transcript_view/mutations.rs](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_view/mutations.rs) — `sync_history_tail`（L9-L27）、`replace_range`（L29-L66）、`replace_group`（L68+）
- [transcript_view/follow_control.rs](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_view/follow_control.rs) — 回到底部控件（全文 111 行）
- [transcript_view/footer.rs](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_view/footer.rs) — 导航提示与选区提示（L16-L90）
- [transcript_view/activity.rs](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_view/activity.rs) — `can_return_to_latest`、`current_tail_is_visible`（全文 33 行）
- [transcript_view/layout.rs](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_view/layout.rs) — cache 上限（L11-L12）、`CellPresentation`（L89-L96）
- [text_selection.rs](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/text_selection.rs) 全文 76 行 — `SelectionUnit`、`click_count`、`is_copy_key`

**终端层**

- [tui/scrollback.rs](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/tui/scrollback.rs) 全文 108 行 — `ScrollbackStrategy` 与各终端策略
- [transcript_reflow.rs](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_reflow.rs) — debounce 与状态机（L1-L40）
- [local_settings.rs L128-L175](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/local_settings.rs#L128-L175) — `copy_on_select` 终端矩阵

**键位**

- [keymap.rs L1638-L1690](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/keymap.rs#L1638-L1690) — app 级默认绑定
- [keymap.rs L1866-L1889](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/keymap.rs#L1866-L1889) — `PagerKeymap` 默认绑定
- [keymap/bindings.rs](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/keymap/bindings.rs) — `KeymapContext`、`config_name`、`overlaps`（L14-L95）、`KeymapActionId::overlaps`（L97-L113）

**相关测试（C 级，仅作旁证）**

- [transcript_view/copy_on_select_tests.rs](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_view/copy_on_select_tests.rs)
- [transcript_view/right_click_copy_tests.rs](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/transcript_view/right_click_copy_tests.rs)
- [tui/owned_screen_tests.rs](https://github.com/openai/codex/blob/01fc69f4026735edfdf6789820549727a4867b11/codex-rs/tui/src/tui/owned_screen_tests.rs)

**PTY 资产**

- `artifacts/codex-transcript-research/owned-compact-100x30.txt` / `.png` — Owned 紧凑态
- `artifacts/codex-transcript-research/owned-detailed-100x30.txt` / `.png` — Owned 详细态（工具完整输出 + `✓ 70ms`）
- `artifacts/codex-transcript-research/owned-new-activity-100x30.txt` / `.png` — 阅读中新活动到达、视窗不动、草稿保留
- `artifacts/codex-transcript-research/owned-search-50x30.txt` — `F3` Find 定位到 `fixture output 10`
- `artifacts/codex-transcript-research/owned-compact-restored-100x30.txt` — 多步操作后的阅读画面，不作为精确搜索返回锚点的证明
- `artifacts/codex-transcript-research/owned-live-tail-100x30.txt` — 跟随位置；`owned-live-tail-50x30.txt` 是 resize 即时帧，有截边，不作为最终换行证明
- `artifacts/codex-transcript-research/terminal-transcript-100x30.txt` — Terminal 模式 `/TRANSCRIPT/` 全屏层与 footer 键位
