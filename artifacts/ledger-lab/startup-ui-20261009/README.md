# 普通启动与首次配置画面

2026-10-09，使用真实 PTY 挂载生产 `StartupOnboarding` 和 `ProviderLibraryEditor`，采集 120×40、80×24、50×40 三档。每档分别采集彩色/Nerd 和 NO_COLOR/ASCII；每个 PNG 有同名文本，[samples.json](samples.json) 记录尺寸、光标与来源。

这组画面使用隔离应用端口：第一次环境核验失败，用户 Enter 明确重试后通过，再选择已保存模型、创建空地图并进入确认页。未调用真实 Orca、GitHub 或模型。它用于检查生产布局与返回/选择状态；实际安装入口、配置保存、SQLite Scope 初始化及模型协议链路由 `ledger-lab-installed.test.ts` 的独立 pack/install/PTY 用例覆盖。

| 阶段 | 120×40 彩色 | 80×24 彩色 | 50×40 无色 |
| --- | --- | --- | --- |
| 自动逐项核验 | [画面](checking-120x40-color-nerd.png) | [画面](checking-80x24-color-nerd.png) | [画面](checking-50x40-no-color-ascii.png) |
| 失败与显式重试 | [画面](failed-120x40-color-nerd.png) | [画面](failed-80x24-color-nerd.png) | [画面](failed-50x40-no-color-ascii.png) |
| 共享连接编辑器 | [画面](connections-120x40-color-nerd.png) | [画面](connections-80x24-color-nerd.png) | [画面](connections-50x40-no-color-ascii.png) |
| 模型选择 | [画面](models-120x40-color-nerd.png) | [画面](models-80x24-color-nerd.png) | [画面](models-50x40-no-color-ascii.png) |
| 地图创建/选择 | [画面](route-map-120x40-color-nerd.png) | [画面](route-map-80x24-color-nerd.png) | [画面](route-map-50x40-no-color-ascii.png) |
| 最终确认 | [画面](confirmation-120x40-color-nerd.png) | [画面](confirmation-80x24-color-nerd.png) | [画面](confirmation-50x40-no-color-ascii.png) |

呈现复用 [#52 定稿](../../dialog-prototype/final/README.md) 的圆角弹窗、身份摘要、分界、反色动作和固定页脚。代表画面已检查：长路径与步骤摘要按宽度裁切，50 列仍可看到动作与页脚；环境阶段显示已完成项、当前 spinner 与未开始项；ASCII 使用 `+`/`x`/`-` 和线形 spinner。完整六票人工视觉接受及真实平台验收未据此标记通过。
