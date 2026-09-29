## 1. 开发观察入口

- [x] 1.1 IP-01：完成隔离假端口预览与五个场景，复用 PTY fixture；运行 `pnpm build && pnpm exec vitest run tests/tui/pty.test.ts`。
- [x] 1.2 IP-01：固定 DevTools、tuistory 脚本与终端采集说明；运行 `pnpm exec tuistory --help`，人工检查 120×40、80×24、50×40 预览画面。

## 2. 组件与视觉

- [x] 2.1 IP-03：建立唯一主题并更新状态、焦点展示；运行 `pnpm typecheck` 和相关 TUI 测试。
- [x] 2.2 IP-02：迁移 Model Picker、Session Picker 与危险确认，保持全局输入所有权；运行 `pnpm exec vitest run tests/tui/input-paths.test.tsx tests/tui/control.test.tsx tests/tui/session-picker.test.tsx tests/tui/session-lifecycle.test.tsx tests/tui/no-side-effect.test.tsx`。

## 3. 文档与验收

- [x] 3.1 IP-04：更新 README 和架构依赖说明，检查开发流程可按文档运行。
- [x] 3.2 IP-01/02/03/04：运行 `pnpm typecheck && pnpm lint && pnpm build && pnpm exec vitest run tests/tui && openspec validate tui-debug-workbench-and-ui-migration --strict && git diff --check`。
