# 当前生产 TUI 的原型对照

**硬约束：尊重已确认原型。后继 change 必须沿用相应定稿设计，并同时验证交互与生产画面。**

> **证据范围：这是重稿前聊天、输入、当前 Session 回答三个区域的阶段记录。当前 change 已扩展为六张原型票逐项纠偏，不能用本目录的 54 组画面声称新范围完成。** 新范围见 [design.md](../../openspec/changes/align-tui-with-approved-prototypes/design.md)，新增整套生产证据另存 `full-map/`；现有 PNG/文本与下面的历史结果保留。

来源更正（2026-10-02）：旧 `tool-expanded-50x40-no-color.png/.txt` 被临时采集脚本误覆盖，原文件未入 Git、无备份；该对文件不再作为旧阶段原始证据。用户已明确接受丢失，要求以商议过程中确认的原型为准。六票原型源码及定稿素材均保留完整。本轮证据与可复查操作见 [full-map](full-map/README.md)，下面的 54 组计数仅描述旧采集记录。

`align-tui-with-approved-prototypes` 的实施证据，采集于 2026-10-02。实施起点为 `d3066e2bf805db3efdc6db1cf9b4d1a8af81c205`；本目录对应其上的未提交呈现改动，尚未创建正式 verification 或归档。

## 来源和环境

- 聊天：[#41 最终决议](https://github.com/leike0813/orca-companion/issues/41#issuecomment-5934328595)、[continuous 样例](../tui-prototype/continuous-v2b-80x24.png)。早期样例的模拟 thought、耗时和成功勾号不进入生产。
- 输入：[#42 最终决议](https://github.com/leike0813/orca-companion/issues/42#issuecomment-5935340054)、[共享原型输入框](../../src/interfaces/tui/composer-prototype.tsx)、[定稿工作台中的输入框](../statusline-prototype/custom-direct/custom-restored-80x24.png)。保留圆角、焦点色、左右内边距和紧凑模式说明；生产使用完整编辑器与原生光标。
- 回答：#41 的底部回答语义、#42 的独立草稿与精确提交；[dialog final](../dialog-prototype/final/) 的选项反色层级。当前 Session 回答区域复用同一输入框。
- Ubuntu；Node.js 24.12.0、pnpm 11.10.0；Ink 7.1.1、React 19.3.0；tuistory 0.11.0 的真实 PTY。`TERM=xterm-256color`，Nerd 图标模式。彩色使用 `FORCE_COLOR=1`，删除 `NO_COLOR`；无色使用 `FORCE_COLOR=0`、`NO_COLOR=1`。
- PNG 使用既有 ghostty-opentui 渲染器的 JetBrains Mono Nerd Font 与 CJK fallback，默认 14px 字号、1.5 行高。沿用既有采集的显示宽度转换和反色默认前/背景处理。旧样例像素尺寸不同，按终端列、布局与信息层级比较，不要求像素相同。

入口为 `node scripts/tui-preview.mjs planning|long-cjk|answer|disabled`，直接挂载生产 `TuiApp → Workspace → Transcript/Composer/AnswerPanel`，未传任何 prototype flag。端口为隔离 fixture，输入存储为内存 SQLite，业务提交被拒绝；这些画面验证生产呈现，不证明真实 Provider/Orca 集成或真实 IME 行为。

## 样例与逐项结论

三档各自独立启动：120×40、80×24、50×40；每档彩色/无色各九个场景，共 **54 组 PNG/文本**。[samples.json](samples.json) 列出文件名、尺寸、模式、实际原生光标坐标与可见状态。同名 `.txt` 是配对 pane 文本，PNG 不另画模拟光标。主 agent 对照上述定稿样例，检查三档及两种颜色模式的代表画面和配对文本。

| 场景前缀 | 检查结果 | 80×24 彩色 / 无色 |
| --- | --- | --- |
| `chat-empty` | 用户青色边线与 `›`、助手弱 `●`、消息留白；无重复角色标题及每回合外框。工具紧凑折叠，真实文本保留 | [彩色](chat-empty-80x24-color.png) / [无色](chat-empty-80x24-no-color.png) |
| `tool-expanded` | 同一工具身份原位展开，黄色标题、缩进及灰色细节边线；无色仍有 `▾` 与边线，没有伪造成功标记 | [彩色](tool-expanded-80x24-color.png) / [无色](tool-expanded-80x24-no-color.png) |
| `chat-multiline` | 中文/ASCII 与三行输入保持完整；圆角框、紫色焦点、正文内边距和底部位置符合输入原型 | [彩色](chat-multiline-80x24-color.png) / [无色](chat-multiline-80x24-no-color.png) |
| `chat-paste` | 1440 code points 长粘贴折叠为块，与短多行输入共存；正文和框线不越界，完整载荷由现有输入保护维护 | [彩色](chat-paste-80x24-color.png) / [无色](chat-paste-80x24-no-color.png) |
| `long-cjk` | 中文路径和混排在用户色边内按显示宽度换行；三档保留正文和后续真实消息 | [彩色](long-cjk-80x24-color.png) / [无色](long-cjk-80x24-no-color.png) |
| `answer-options` | 问题、题序、选项、提示在输入区域底部；原 transcript 保留，选中项反色并带 `›`，无色靠标记辨识 | [彩色](answer-options-80x24-color.png) / [无色](answer-options-80x24-no-color.png) |
| `answer-free` | Tab 后复用圆角 composer，显示实际 interaction/revision；独立中文多行回答，不覆盖聊天草稿 | [彩色](answer-free-80x24-color.png) / [无色](answer-free-80x24-no-color.png) |
| `answer-esc` | Esc 返回普通消息，完整恢复 `原草稿中文abc` 和此前左移一格的光标，三档实际 x 均为 14；没有提交 | [彩色](answer-esc-80x24-color.png) / [无色](answer-esc-80x24-no-color.png) |
| `disabled` | `context_exhausted` 的真实不可提交原因可见；草稿仍保留，无色有 `!` 与明确原因 | [彩色](disabled-80x24-color.png) / [无色](disabled-80x24-no-color.png) |

其余尺寸按 `<场景前缀>-120x40-color|no-color`、`<场景前缀>-50x40-color|no-color` 查找配对文件。例如：[120 列回答](answer-free-120x40-color.png)、[50 列回答](answer-free-50x40-color.png)、[50 列无色粘贴](chat-paste-50x40-no-color.png)。主区宽度分别为 78、54、48 列，输入正文共用 `width - 4`，分别为 74、50、44 列。

## 行为检查与边界

`pnpm exec vitest run tests/tui --maxWorkers=8`：27 文件通过、2 文件条件跳过；172 项通过、2 项条件跳过。两项真实 Orca 集成未启用隔离项目开关，未计为通过。12 项普通真实 PTY 检查均通过，覆盖三档中文编辑/粘贴、resize、边框、回答/Esc 草稿与光标恢复、折叠块查看及退出恢复终端模式。新增拥挤回答回归覆盖长问题、四个可见选项、长答案和不可提交原因；时间线与当前编辑行仍可见。

`pnpm typecheck`、`pnpm lint`、`pnpm build`、`openspec validate align-tui-with-approved-prototypes --strict`、`git diff --check` 通过。原生 cursor 使用真实 box origin/metrics 与框内位置；工作区为普通 Ink 输出保留末尾换行行，避开满屏输出的光标偏移。

本阶段对照结论仅覆盖当前聊天、输入与当前 Session 回答。项目页签/外框、命令候选与审阅、顶栏/statusline 层级、当前 adaptive 图及有界详情尚未迁移，已纳入重稿后的当前 change，待另行实施验收。完整 custom 偏好、可信数据、完整历史、Markdown、搜索、跨 Session 回答协议及性能基线仍按 design D-10 保持未完成。Windows 未验证。原定稿源码、`final/`、`custom-direct/` 和前驱归档保持完整。

## 复查入口

先 `pnpm build`，再以 tuistory 独立启动目标尺寸，例如：

```sh
env -u NO_COLOR FORCE_COLOR=1 NODE_NO_WARNINGS=1 pnpm exec tuistory -s alignment-review --cols 80 --rows 24 -- node scripts/tui-preview.mjs answer
pnpm exec tuistory -s alignment-review snapshot --trim
pnpm exec tuistory -s alignment-review screenshot -o /tmp/alignment-review.png
pnpm exec tuistory -s alignment-review close
```

当前回答入口为 Shift+Left 或 `/answer`，Tab 切换自由输入，Esc 返回聊天，Ctrl+T 展开末条工具。PTY 注入的 Shift+Left 为 `ESC[1;2D`，粘贴为 bracketed paste；不要用原型过时的 Ctrl+A 回答。新样例另存，勿运行会覆盖原定稿目录的旧 capture 命令。
