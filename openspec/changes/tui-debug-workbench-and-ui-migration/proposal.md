## Why

M2 已完成验收，但 TUI 样式迭代仍依赖阅读 TSX 和运行完整前台宿主，缺少可复现的终端画面与组件检查入口。现有选择器、确认提示和状态展示也缺少统一视觉规范。

## What Changes

- 提供只接假数据的完整 TUI 预览入口，支持固定场景、终端尺寸调整、文字帧与 PNG 截图；开发时可连接 React DevTools。
- 引入 `@inkjs/ui` 迁移 Model Picker、Session Picker 与危险操作确认，统一高对比语义色、焦点和状态展示；保留多行 composer、Command Palette 和 Graph Inspector 的既有交互。
- 调整输入归属，保证选择和确认只触发一次，不破坏全局键、Esc、回答绑定、Scope 级控制与零渲染副作用。

## Capabilities

### New Capabilities

- `tui/development-workbench`: 隔离假数据预览、终端画面采集与组件检查流程。

### Modified Capabilities

- `tui/planning-workspace`: 状态、焦点和告警在彩色及无彩色终端均保持可辨识。

## Impact

直接前驱为已归档的 `m2-closeout-integration-and-wake`；本 change 属于 M2 后的 TUI 优化，不扩展 M3 的执行并发、后台控制或跨平台支持。影响 `src/interfaces/tui/`、开发脚本、现有 TUI/PTY 测试、开发文档及 npm 依赖；不改变 Controller、CLI、持久化合同，也不接入可视化设计器或浏览器预览。
