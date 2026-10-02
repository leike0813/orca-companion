# Codex TUI 交互模式核验与适配边界

对应 ticket：[*核对 Codex TUI 的成熟交互与适配边界*](https://github.com/leike0813/orca-companion/issues/38)（M2 后续体验规划）。

结论先行：Codex TUI 在**长会话阅读、工具折叠/展开、流式状态、输入历史、斜杠命令与状态行**六个方向上都有可观察且可复用的做法，但它们的共同前提是「TUI 只投影和提交意图，不推进业务状态」。与本项目最契合的是三条：**显式 transcript overlay（可搜索、可回到底部）**、**工具输出的紧凑摘要 + 有界展开**、**composer 上方的只读流式状态行**。明确**不适合照搬**的是：用户可自定义 keymap、可配置状态行/标题项、以及「工作中 Enter 直接注入当前 turn」的转向方式——前两者与项目当前的固定键位和状态展示边界冲突，后者会绕过 Pending Interaction 的 interaction ID 绑定语义。

## 核验环境与方法

| 项 | 值 |
| --- | --- |
| 核验日期 | 2026-09-29（Asia/Shanghai） |
| 一手文档 | [Codex CLI 文档](https://developers.openai.com/codex/cli)、[CLI 参考（含交互快捷键与斜杠命令流程）](https://developers.openai.com/codex/developer-commands)、[CLI 定制](https://developers.openai.com/codex/cli-customization)、[Slash commands 参考](https://developers.openai.com/codex/reference/slash-commands)。文档站支持在页面 URL 后加 `.md` 取原始 Markdown |
| 一手源码 | [openai/codex](https://github.com/openai/codex) 快照 `c248f6d48b97eb4a2aa56147a0b11b7d763278b9`（2026-09-29），路径集中在 `codex-rs/tui/src/`、`codex-rs/config/src/` |
| 方法 | 直接阅读第一方源码默认值表与模块注释，配合官方文档；**未在本机运行 Codex TUI**，无 PTY 实测 |

本仓库既有 [ink-react-terminal-constraints.md](./ink-react-terminal-constraints.md) 覆盖 Ink/React 的终端约束，本文只补齐交互模式，不重复终端底层结论。

## 1. 长会话阅读

Codex 把「读完整个 transcript」当作一个独立的阅读态，而不是把内容交给终端原生 scrollback 硬扛。

- 默认打开 transcript overlay 的绑定是 `Ctrl+T`，查找是 `F3`；pager 上下文提供 scroll_up/scroll_down/page_up/page_down/half_page_up/half_page_down 与专用关闭键。[S1][S9]
- transcript 有两种归属模式 `Owned` 与 `Terminal`，由 `resolve(owned_enabled, alternate_screen_enabled)` 决定：只有两者都启用才进入 `Owned`；该模式在启动时确定并跨 session 保持，注释明确「避免 native scrollback 收到只保留在 Owned 视图里的更新」[S3]。
- 终端能力不同会用不同 scrollback 策略（`ScrollbackStrategy::detect`），历史插入时在保护已提交历史区的前提下尽量保留原生 scrollback[4]。
- `/raw`（或 `/raw on|off`）切换 raw scrollback，让终端选择/复制更直接；默认 `Alt+R`，可用 `tui.raw_output_mode = true` 持久化。[D2]
- 未在底部时会浮出跟随控件，文案随状态变化（`New activity · ↓ Back to bottom · esc` / `↓ Back to bottom` …），并随宽度降级；搜索或选中文本时隐藏该控件[5]。

要点：长会话不是「滚得更快」，而是**一个可打开、可搜索、可回到最新的受控视图**。

## 2. 回合与工具渲染

- 每个 history cell 可提供三种渲染：`display_lines`（主对话）、`transcript_lines`（overlay）、`raw_lines`（复制友好）。轮询/写 stdin 之类的记账 cell 在主对话里刻意渲染为空，只出现在详细或 raw 历史里[6]。
- 工具调用在主对话里是紧凑摘要；展开时按有界预览（`DETAIL_PREVIEW_LINES`）截断，溢出用 `…` 标记，失败命令显示 `Failed (exit N)`，无输出的成功命令折叠为「Background output」[7]。
- 对话流是**分组**的：activity group 决定一条命令是否可折叠、是否值得展开，而不是逐条平铺[7]。
- 助手流式输出按 Markdown 渲染，含 code fence、表格 holdback、数学与 mermaid 分支[8]。

要点：折叠/展开是**per-cell 的渲染契约**，不是 UI 里临时判断；「记账类噪音不进主对话」是显式规则。

## 3. 流式反馈

- `StreamState` 做 newline-gated 的 Markdown 收集，并把已提交行放进 FIFO 队列；drain 从队首弹出，入队带时间戳，便于按「最旧队列行年龄」做自适应排空[8]。
- composer 上方有独立的 task status row：动画 header（默认 `Working`）+ 独立计时 + 可选 interrupt 提示 + 简短 inline 上下文（如统一 exec 后台进程摘要），细节最多 `STATUS_DETAILS_DEFAULT_MAX_LINES = 3` 行；注释强调这些元素共用一行以避免底部面板竖向抖动[10]。
- turn 控制：默认 `Enter` 提交、`Esc` 中断当前 turn[1]；工作中 `Enter` 可把新指令**注入当前 turn**，`Tab` 把后续输入**排队**到下一 turn。[D2]

要点：流式状态是**只读投影**（动画、计时、中断提示都是展示），与「组件不得触发模型恢复」这一约束天然相容。

## 4. 输入编辑与历史

默认 composer 绑定[1]：

| 动作 | 默认键 |
| --- | --- |
| submit | Enter |
| queue | Tab |
| toggle_shortcuts（`?` 帮助面板） | `?` / Shift+? |
| history_search_previous / next | Ctrl+R / Ctrl+S |
| insert_newline | Ctrl+J、Ctrl+M |
| interrupt_turn | Esc |
| open_external_editor | Ctrl+G |
| copy | Ctrl+O |
| clear_terminal | Ctrl+L |

- Up/Down 恢复草稿历史；Ctrl+R 搜索 prompt 历史，Enter 采用、Esc 取消；空 composer 连按两次 Esc 可编辑上一条用户消息并从该点 fork。[D2]
- 长提示按 Ctrl+G 交给 `VISUAL`（未设时 `EDITOR`）编辑，保存关闭后回填 composer。[D3]
- `/vim` 切换 composer 的 Vim 模式，并有 vim_normal/operator/search/text_object 一整套上下文。[S2][S10]
- `@` 搜文件加入 prompt；行首 `!` 跑本地 shell 命令。[D2]

## 5. 斜杠命令

- 在 composer 输入 `/` 打开 popup，继续输入即过滤；启用的 skills 会出现在列表里，自定义 prompt 显示为 `/prompts:<name>`。[D2]
- 命令是枚举，**枚举顺序即 popup 展示顺序**，源码注释要求高频命令在前。[S2]
- 可见性/可用性是显式门控：`supports_inline_args`、`available_during_task`、`available_when_thread_unavailable`、`available_in_side_conversation`，再叠加环境与 feature flag 过滤。[S2][S12]
- 已在运行时，输入斜杠命令按 `Tab` 会把它排到下一 turn，**在真正执行时才解析**，因此命令菜单与错误出现在当前 turn 结束之后。[D2]

## 6. 状态行

- `/statusline` 打开 picker 选择并**排序**字段，落盘到 `tui.status_line`；可选字段包括 model、model+reasoning、context stats、rate limits、git branch、token counters、session id、cwd/project root、版本。[D2]
- 状态栏交互专项核对使用本机 `codex-cli 0.159.2` 对应的 [MultiSelectPicker](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/tui/src/bottom_pane/multi_select_picker.rs) 和 [status_line_style](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/tui/src/bottom_pane/status_line_style.rs)：空格选择、左右排序、确认直接保存、取消退出；不同字段类别使用不同 accent，分隔符用 secondary style。Companion 的配置原型采用 Enter 直存并返回原界面、Esc 取消，以及列表/预览/状态栏一致的字段配色，复用现有终端色，不引入 Codex 的 Rust 主题解析或完整样式系统。
- 终端标题由独立的 `/title` 配置（app name、project、spinner、status、thread、branch、model、task progress），落盘 `tui.terminal_title`。[D2]
- token 展示有明确口径：context window 剩余百分比按 `BASELINE_TOKENS = 12000` 预留基线计算，展示 total / input(+cached) / output(reasoning)。[9]

## 对 Coordinator Session 与 Pending Interaction 的可迁移性

| Codex 做法 | 对本项目的判断 | 边界 / 改造 |
| --- | --- | --- |
| 显式 transcript overlay（打开/查找/翻页/回到底部） | **可迁移**，最值得先做 | 本项目 `Ctrl+T` 已被 `toggle-tool` 占用，需改用其它键或并入 Event Drawer；overlay 只读，不得推进状态 |
| 工具 cell 的三视图 + 有界展开 + per-cell 折叠契约 | **可迁移** | [transcript.tsx](../../src/interfaces/tui/components/transcript.tsx) 已有折叠记号与展开回调，缺的是「记账类噪音不进主对话」的显式 cell 规则 |
| 只读流式状态行（动画 + 计时 + 中断提示） | **可迁移** | 与现有 [status-line.tsx](../../src/interfaces/tui/components/status-line.tsx) 同层；必须保持纯投影，不因 spinner 触发模型调用 |
| composer 历史（Up/Down + Ctrl+R 搜索）与 `$EDITOR` 升级 | **可迁移** | Ctrl+G 在本项目是 Graph Inspector，需换键；普通字符仍不得产生全局动作 |
| 斜杠命令的可用性门控（during task / thread unavailable / inline args） | **可迁移** | 可直接映射到 Answer 模式与 `readOnly` 的禁用原因，避免提交后才失败 |
| 异步 pending question 的模型（选项、草稿、按 ID 去重、仅「完整可见的模型选项」可成为授权、过期倒计时）[11] | **语义可迁移** | 验证了「回答必须绑定 interaction ID」而非把自由文本当回答；但本项目 interaction 是 Branch Coordination Store 里的 durable 记录 + expected revision，不是内存队列 + 过期 |
| 用户自定义 keymap（`/keymap`，`tui.keymap.*`） | **不迁移** | 与「固定键位、M2 不实现自定义键位、不保存键位配置」冲突 |
| 可配置/排序的状态行字段 | **选择性迁移** | 用户选定 custom：模型、推理强度和可靠上下文常驻，普通附加字段可选、可排序；显示偏好由用户级 UI 拥有，事实仍来自 Controller 投影。见 [顶栏/statusline 决策](https://github.com/leike0813/orca-companion/issues/48) |
| 可配置的终端标题字段 | **不迁移** | 当前需求只覆盖 statusline；终端标题不增加独立配置 |
| 工作中 `Enter` 注入当前 turn、`Tab` 排队 | **不迁移** | 会绕过 Pending Interaction 的 ID + revision 绑定；本项目普通消息走 send-session-message，回答走专用用例 |
| `Owned` transcript / alternate-screen 归属与 scrollback 策略 | **不迁移** | 依赖 Rust 自定义终端，Ink 方案在 stdout 帧上工作，见既有 Ink 约束研究 |

## 不确定项

- 默认键位（`Ctrl+T` 打开 transcript、`F3` 查找、`Ctrl+O` 复制等）来自源码默认值表[1]，官方文档未逐条重述；且文档与源码版本可能不一致。
- 源码快照 `c248f6d` 未必对应用户当前安装的 Codex 二进制；未做运行时核对。
- 未在本机运行 TUI，所有行为结论均为「源码 + 文档」证据，**无 PTY 实测**；overlay 的具体滚动/布局算法只读了模块结构与键位，未逐行核对渲染细节。
- `learn.chatgpt.com/docs/...` 与 `developers.openai.com/codex/...` 返回同一份内容，规范主机名未确认。

## 直接来源

- [D1] Codex CLI 概览：<https://developers.openai.com/codex/cli>
- [D2] CLI 参考（含 Interactive shortcuts、各斜杠命令流程）：<https://developers.openai.com/codex/developer-commands>（原始 Markdown：<https://developers.openai.com/codex/developer-commands.md>）
- [D3] CLI 定制（主题、Ctrl+G 外部编辑器）：<https://developers.openai.com/codex/cli-customization>
- [D4] Slash commands 参考：<https://developers.openai.com/codex/reference/slash-commands>
- [S1] 默认键位表：<https://github.com/openai/codex/blob/c248f6d48b97eb4a2aa56147a0b11b7d763278b9/codex-rs/tui/src/keymap.rs>
- [S2] 斜杠命令枚举与可用性：<https://github.com/openai/codex/blob/c248f6d48b97eb4a2aa56147a0b11b7d763278b9/codex-rs/tui/src/slash_command.rs>
- [S3] transcript 归属模式：<https://github.com/openai/codex/blob/c248f6d48b97eb4a2aa56147a0b11b7d763278b9/codex-rs/tui/src/transcript_mode.rs>
- [4] scrollback 策略：<https://github.com/openai/codex/blob/c248f6d48b97eb4a2aa56147a0b11b7d763278b9/codex-rs/tui/src/tui/scrollback.rs>
- [5] 回到底部控件：<https://github.com/openai/codex/blob/c248f6d48b97eb4a2aa56147a0b11b7d763278b9/codex-rs/tui/src/transcript_view/follow_control.rs>
- [6] exec history cell 的三视图：<https://github.com/openai/codex/blob/c248f6d48b97eb4a2aa56147a0b11b7d763278b9/codex-rs/tui/src/history_cell/exec.rs>
- [7] 工具折叠/展开与有界预览：<https://github.com/openai/codex/blob/c248f6d48b97eb4a2aa56147a0b11b7d763278b9/codex-rs/tui/src/thread_transcript/tools.rs>
- [8] 流式队列与 Markdown 管线：<https://github.com/openai/codex/blob/c248f6d48b97eb4a2aa56147a0b11b7d763278b9/codex-rs/tui/src/streaming/mod.rs>
- [9] token/context 口径：<https://github.com/openai/codex/blob/c248f6d48b97eb4a2aa56147a0b11b7d763278b9/codex-rs/tui/src/token_usage.rs>
- [10] 流式状态行：<https://github.com/openai/codex/blob/c248f6d48b97eb4a2aa56147a0b11b7d763278b9/codex-rs/tui/src/status_indicator_widget.rs>
- [11] 异步 pending question 状态机：<https://github.com/openai/codex/blob/c248f6d48b97eb4a2aa56147a0b11b7d763278b9/codex-rs/tui/src/bottom_pane/async_questions/state.rs>
- [12] 命令可用性统一过滤：<https://github.com/openai/codex/blob/c248f6d48b97eb4a2aa56147a0b11b7d763278b9/codex-rs/tui/src/bottom_pane/slash_commands.rs>
- [S9] keymap 配置 schema 与上下文覆盖：<https://github.com/openai/codex/blob/c248f6d48b97eb4a2aa56147a0b11b7d763278b9/codex-rs/config/src/tui_keymap.rs>
- [S10] keymap 上下文清单：<https://github.com/openai/codex/blob/c248f6d48b97eb4a2aa56147a0b11b7d763278b9/codex-rs/tui/src/keymap/bindings.rs>
