# 状态栏直接保存与字段配色

用户要求按 Codex 的选择器简化保存，并用颜色区分字段。最新共享工作台使用 Enter 直接保存、Esc 取消、空格勾选、左右排序或切换格式；恢复默认是列表末项。原型偏好位置、字段与数据边界见[主说明](../README.md)。

运行 `pnpm ui:status-prototype blocked custom`，从 `Ctrl+P → 选项 → 状态栏` 进入。保存成功后关闭设置及命令弹窗，直接回到原对话或项目面板；失败留在设置页并保留配置草稿。取消逐层返回；跨 Session、原草稿/滚动与项目面板栏目保留。

模型/执行工作包使用青色，推理/规划票/预算紫色，上下文/进度绿色，图版本亮蓝色，分隔符灰色；设置行、预览与主界面一致。颜色辅助分类，不承载唯一信息；NO_COLOR 下文字和状态相同。

| 场景 | 120×40 | 80×24 | 50×40 |
| --- | --- | --- | --- |
| 设置与预览 | [PNG](direct-options-colors-120x40.png) | [PNG](direct-options-colors-80x24.png) | [PNG](direct-options-colors-50x40.png) |
| 主界面字段配色 | [PNG](field-colors-120x40.png) | [PNG](field-colors-80x24.png) | [PNG](field-colors-50x40.png) |
| 无色设置 | [PNG](direct-options-monochrome-120x40.png) | [PNG](direct-options-monochrome-80x24.png) | [PNG](direct-options-monochrome-50x40.png) |
| 无色主界面 | [PNG](field-monochrome-120x40.png) | [PNG](field-monochrome-80x24.png) | [PNG](field-monochrome-50x40.png) |
| 保存失败 | [PNG](custom-save-failed-120x40.png) | [PNG](custom-save-failed-80x24.png) | [PNG](custom-save-failed-50x40.png) |

[samples.json](samples.json) 列出真实 PTY PNG 与配对文本；[source.tar.gz](source.tar.gz) 是此次独立源码，[provenance.json](provenance.json) 记录验证。资产仅在本机，未提交或上传；原 `custom/` 的 96 组样例与源码、`resumed/` 和弹窗 `final/` 保留。

验证使用现有脚本：`pnpm build`、`pnpm lint`、`git diff --check`、`node artifacts/statusline-prototype/verify.mjs --capture --custom-only`。覆盖 Enter 在字段行直接保存、Space 勾选、左右排序、取消、恢复默认、重启、保存失败、新消息/resize、跨 Session、面板返回；检查核心字段具有不同前景色，彩色/无色保留相同文字。没有接入真实 Provider、tracker 或控制后端。

参考为 OpenAI Docs 的[状态栏说明](https://learn.chatgpt.com/docs/developer-commands?surface=cli#configure-footer-items-with-statusline)，及与本机版本一致的 Codex `rust-v0.159.2` 一手源码：[MultiSelectPicker](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/tui/src/bottom_pane/multi_select_picker.rs)、[字段样式](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/tui/src/bottom_pane/status_line_style.rs)。本轮只借鉴确认、排序和类别着色，没有移植 Codex 的 Rust 终端或主题系统。
