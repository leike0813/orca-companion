# #47 Composer 原型对照

先比较 slash 菜单。运行 `pnpm ui:composer-prototype slash above` 看 B；运行 `pnpm ui:composer-prototype slash inside` 看 A。无参数启动默认 B。两种方案可在同一会话按 `Ctrl+T` 切换，`Tab` 用于接受当前高亮候选。

| 观察点 | A：输入框内候选 | B：输入框上方候选 |
| --- | --- | --- |
| 边界 | `/`、光标、候选共用一个 composer 边框；候选出现时边框原位增高 | composer 的标题与编辑行保持不变；独立候选框出现在它上方 |
| 空间 | 最多显示两到三项，其余项由 ↑↓ 滚动查看 | 列出全部匹配项，包括不可用项；输入框高度不变 |
| 键盘 | 输入 `/` 打开，继续输入过滤，↑↓ 选项，Tab/Enter 填入，Esc 关闭 | 当前可用项反色高亮；↑↓ 改变高亮，Tab/Enter 填入该项；不可用项显示原因且不能被采用 |

| 尺寸 | A：输入框内 | B：输入框上方 |
| --- | --- | --- |
| 120×40 | [slash-inside-120x40.png](slash-inside-120x40.png) | [slash-above-all-120x40.png](slash-above-all-120x40.png) |
| 80×24 | [slash-inside-80x24.png](slash-inside-80x24.png) | [slash-above-all-80x24.png](slash-above-all-80x24.png) |
| 50×40 | [slash-inside-50x40.png](slash-inside-50x40.png) | [slash-above-all-50x40.png](slash-above-all-50x40.png) |

参照的产品行为：[Claude Code](https://code.claude.com/docs/en/interactive-mode) 用 `/` 打开可过滤菜单，并让 Tab 接受补全；[Gemini CLI](https://geminicli.com/docs/reference/keyboard-shortcuts/) 将 Tab/Enter 作为候选接受键；[Codex TUI 源码](https://github.com/openai/codex/blob/main/codex-rs/tui/src/bottom_pane/chat_composer.rs) 也把 slash popup 与输入编辑放在 composer 路径中。这些资料支持“从输入位置发现命令、保持补全键语义”；**菜单应该共用边框还是独立浮层，是本票需要裁决的布局选择**。当前 A 的边框内菜单是对比方案，不声称上述产品都采用同一边框。

按 ↓ 后 [高亮移到 `/help`](slash-above-selected-help-80x24.png)，再按 Tab 会把 `/help` 填入输入框。输入 `/he` 可看[过滤效果](slash-inside-filtered-80x24.png)；输入 `/au` 可看[不可用原因](slash-above-unavailable-80x24.png)，此时没有可采用的高亮项。输入其他无匹配的 `/文字` 时保留普通草稿，Enter 只给模拟提交提示。`Ctrl+P` 是全局 Command Palette 对照；切入待答模式后 slash 候选让位，回答仍显示 interaction ID 与 expected revision。命令数据和执行反馈均为假数据；不接入真实命令分发或中文输入法。

长文本和图片场景仍可运行 `pnpm ui:composer-prototype images inline` 或把末尾改成 `review`：

| 观察点 | A：输入区内展开 | B：独立内容预览 |
| --- | --- | --- |
| 长文本 | 直接显示草稿末尾，最多六行；上方行数有计数 | 编辑区固定一行；预览区显示开头、结尾和省略行数 |
| 图片 | 以 `@image:` 模拟文本引用，紧贴正文 | 在预览区单独列出顺序、名称、尺寸与大小 |
| 取舍 | 正文和图片在同一视线内，长内容会占用更多主视图高度 | 编辑区高度稳定，查看正文时视线需在预览与编辑区之间移动 |

同一长文与两张模拟图片的截图：

| 尺寸 | A | B |
| --- | --- | --- |
| 120×40 | [inline-images-120x40.png](inline-images-120x40.png) | [review-images-120x40.png](review-images-120x40.png) |
| 80×24 | [inline-images-80x24.png](inline-images-80x24.png) | [review-images-80x24.png](review-images-80x24.png) |
| 50×40 | [inline-images-50x40.png](inline-images-50x40.png) | [review-images-50x40.png](review-images-50x40.png) |

补充场景：[绑定待答回答](review-answer-80x24.png)。`Ctrl+N` 在假 Session 间切换并保留各自草稿；`Ctrl+A` 切换回答模式，显示 interaction ID 与 revision。`Ctrl+O` 添加模拟图片，`Ctrl+D` 移除最后一张。Enter 只给出模拟反馈。

原型沿用现有文本输入处理，光标标记只表示追加位置，不模拟任意位置的多行编辑。图片只有元数据，没有图片读取、预览或提交；当前 `TuiIntent` 只接收字符串。后续 #42 要裁决编辑与会话草稿语义，#45 要裁决 slash command 与 Command Palette 的入口分工。

原型使用 Ink 自带的 `usePaste` 接收整块文本并规范化换行。在 80×24 的 tmux PTY 中，`paste-buffer -pr` 送入两行中英混排文本后，A 版正确显示内容与换行（[pane](paste-verified.txt)）；B 版在 50×40 下保留两行预览与末尾空行光标（[pane](paste-review-verified.txt)）。`tmux paste-buffer` 不带 `-p` 会关闭括号粘贴模拟并把 LF 换成 CR，不能用于验收这个输入路径。生产 composer 尚未接入本原型的粘贴处理；#42 应连同任意位置光标编辑一起裁决并验收。
