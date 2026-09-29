# TUI 调试工作台

先运行 `pnpm install` 和 `pnpm build`。预览只加载构建后的 `TuiApp` 与固定假端口，不连接模型、Orca、tracker 或协调存储；提交和 Scope 控制会显示 `preview_read_only` 拒绝。

在交互式终端运行 `pnpm ui:preview planning`。可选场景为 `planning`、`execution`、`blocked`、`empty`、`long-cjk`。预览要求 stdin/stdout 都是 TTY；`Esc` 关闭覆盖层，`Ctrl+C` 退出。改动源码后重新构建并启动预览。

## 检查组件

两个终端分别运行：

```sh
pnpm ui:devtools
DEV=true pnpm ui:preview execution
```

React DevTools 可检查组件树并临时调整 props；试出的值需再写回源码。`DEV=true` 只用于开发，不会让预览接入真实业务端口。

## 采集真实终端画面

```sh
pnpm build
pnpm exec tuistory -s companion-ui --cols 120 --rows 40 -- node scripts/tui-preview.mjs long-cjk
pnpm exec tuistory -s companion-ui snapshot --trim
pnpm exec tuistory -s companion-ui screenshot
pnpm exec tuistory -s companion-ui resize 80 24
pnpm exec tuistory -s companion-ui snapshot --trim
pnpm exec tuistory -s companion-ui screenshot
pnpm exec tuistory -s companion-ui resize 50 40
pnpm exec tuistory -s companion-ui snapshot --trim
pnpm exec tuistory -s companion-ui screenshot
pnpm exec tuistory -s companion-ui close
```

画面中检查中文和长路径的裁切、Sidebar 折叠、焦点、选中项及警告文字。PNG 用于人工比较；字体和颜色取决于采集环境。`tests/tui/pty.test.ts` 使用同一个预览入口验收真实 resize 与终端恢复。
tuistory 连续 resize 后的截图可能带入旧尺寸的缓冲帧；需要干净的对比图时，关闭会话并按目标尺寸重新启动。旧帧是否残留在真实终端画面，以 PTY 用例的当前 pane 检查为准。
