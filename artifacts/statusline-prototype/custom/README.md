# Custom statusline 交接资产

用户选定 custom 并确认配置方案。本目录保存同一共享工作台的配置交互与对照场景；生产合同和实现尚未完成。

运行 `pnpm ui:status-prototype blocked custom`，从 `Ctrl+P → 选项 → 状态栏` 进入。操作、数据口径与偏好位置见 [主说明](../README.md)。

配置页常驻三核心项；附加字段支持选择和排序，窄屏按序让位。保存成功后应用，取消保留原设置，恢复默认需保存才生效。原型用户偏好与 Session/业务状态分开；验证使用临时文件，不触碰用户设置。

| 样例 | 120×40 | 80×24 | 50×40 |
| --- | --- | --- | --- |
| 配置页 | [PNG](custom-options-120x40.png) | [PNG](custom-options-80x24.png) | [PNG](custom-options-50x40.png) |
| 格式预览 | [PNG](custom-preview-120x40.png) | [PNG](custom-preview-80x24.png) | [PNG](custom-preview-50x40.png) |
| 附加字段排序 | [PNG](custom-ordered-120x40.png) | [PNG](custom-ordered-80x24.png) | [PNG](custom-ordered-50x40.png) |
| 保存后主界面 | [PNG](custom-saved-120x40.png) | [PNG](custom-saved-80x24.png) | [PNG](custom-saved-50x40.png) |
| 重启恢复 | [PNG](custom-restored-120x40.png) | [PNG](custom-restored-80x24.png) | [PNG](custom-restored-50x40.png) |
| 保存失败 | [PNG](custom-save-failed-120x40.png) | [PNG](custom-save-failed-80x24.png) | [PNG](custom-save-failed-50x40.png) |

[samples.json](samples.json) 列出所有 PNG 和同名文本。真实 PTY 由 tuistory 驱动，图片使用 ghostty-opentui 与其字体，字体细节可能与本机终端不同。[source.tar.gz](source.tar.gz) 保存完整工作台源码、锁文件与合同资料；[provenance.json](provenance.json) 记录验证和边界。这些是本机未提交资产，GitHub 无下载副本。

验证入口：`pnpm build`、`pnpm lint`、`node artifacts/statusline-prototype/verify.mjs --capture`、`node artifacts/project-panel-prototype/verify.mjs --variant tabs`。捕获仅写本目录；前轮 `resumed/` 和弹窗 `final/` 不覆盖。

未验证真实 Provider usage、上下文容量、票据 Claim 和 Accepted Validator 进度汇总；未接真实后端、未改变调度/授权。正式用户偏好的配置位置与读写合同需进入实施规划；此处 JSON 仅为独立原型。
