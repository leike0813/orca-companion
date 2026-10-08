# Coordinator Provider TUI 审阅画面

以下终端文本由当前 `ModelSettingsEditor` 与既有 `DialogFrame` 实际渲染生成，供审阅连接候选、隐藏 Key 表单与模型选择界面在三种终端尺寸下的布局。用户于2026-10-08接受当前功能，TUI美化与完整视觉对照留待后续；这些画面不视为逐项原型验收通过。

- [120×40](model-candidates-120x40.txt)
- [80×24](model-candidates-80x24.txt)
- [50×40](model-candidates-50x40.txt)

连接列表：[120×40](connections-120x40.txt)、[80×24](connections-80x24.txt)、[50×40](connections-50x40.txt)。

隐藏 Key 表单：[120×40](connection-key-120x40.txt)、[80×24](connection-key-80x24.txt)、[50×40](connection-key-50x40.txt)。

画面使用固定的非秘密 Provider/模型样例，不连接网络或生产服务。公共目录刷新由 Ctrl+R 显式触发；当前连接的模型发现是列表中的独立操作。

重生成：`pnpm build && node scripts/render-provider-tui.mjs`。文本保留终端布局；后续视觉打磨时再在终端中核对配色与 Nerd/ASCII。
