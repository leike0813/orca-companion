# Verification

## 验收对象

- Change：`tui-debug-workbench-and-ui-migration`
- 输入实现 HEAD：`b4dfd3c2fc8356ff6569c31a50ccfa454aa245f8`
- 最终验收 HEAD：`b4dfd3c2fc8356ff6569c31a50ccfa454aa245f8`
- 验收 Agent：Codex（实现者；按用户要求沿用实施期证据，不重新运行验证）

## 结论

**PASS**。本结论覆盖提交 `b4dfd3c` 的 TUI 预览、输入与主题变更，以及实施期已执行的组件测试、真实 PTY 和终端画面检查。6/6 实施任务、3/3 Requirement、6/6 Scenario 和 IP-01～IP-04 均有实现与证据。React DevTools 的 GUI 属性编辑由 Ink 的 `DEV=true` 接线和已安装工具支持；本轮未在 GUI 中实操，不将其写成实测结果。

## 核验与修复证据

| Requirement / Scenario / IP-ID | 证据或命令 | 结果 |
|---|---|---|
| 隔离且可复现的 TUI 预览／预览执行态；IP-01 | `scripts/tui-preview.mjs` 的五种固定场景与假端口；`tests/tui/pty.test.ts` 执行态用例；实施期 tuistory 检查长中文、阻塞与空态画面 | 执行图、Worker 阶段与状态可见；入口只导入构建后的 TUI |
| 隔离且可复现的 TUI 预览／预览中误触写操作；IP-01 | 预览写端口统一返回 `preview_read_only`；真实 PTY 中提交消息后检查拒绝提示 | 未装配真实 Orca、模型、tracker 或协调存储 |
| 终端画面和组件可检查／缩窄终端后采集画面；IP-01 | 实施期用 tuistory 采集 120×40、80×24、50×40 的文字帧与 PNG；`tests/tui/pty.test.ts` 检查 resize、显示宽度和旧帧 | 全宽、紧凑和折叠布局均呈现；PTY 几何检查通过 |
| 终端画面和组件可检查／检查组件属性；IP-01、IP-03 | `package.json` 的 `ui:devtools`、`react-devtools-core`，`docs/dev/tui-workbench.md` 的 `DEV=true` 流程；Ink 7 的开发工具连接机制；预览仅有假端口 | 组件检查入口已接线；属性临时调整不会写入业务端口。GUI 操作未实测 |
| 状态与焦点的可辨识视觉层级／彩色终端中切换选择；IP-02、IP-03 | `src/interfaces/tui/theme.ts`、两个 Picker 与 `selection-list.tsx`；Session、模型和输入路径测试 | 焦点、选中、当前配置及待答标记可辨；再次确认和拒绝后重试保留 |
| 状态与焦点的可辨识视觉层级／无彩色终端中的危险状态；IP-02、IP-03 | `ControlBar` 的确认文字、`y/N` 与 `submitOnEnter={false}`；`tests/tui/control.test.tsx` 的 Enter、y/n/Esc 断言；Sidebar 的 `!` blocker 标记 | 状态不只依赖颜色；Enter 不提交危险操作，确认只提交一次 |
| 文档与全部门禁；IP-04 | `README.md`、`docs/architecture.md`、`docs/dev/tui-workbench.md`；实施期 `pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm exec vitest run tests/tui`、`openspec validate tui-debug-workbench-and-ui-migration --strict`、`git diff --check` | 命令通过；TUI 测试 121 通过、2 按既有条件跳过；OpenSpec 严格校验通过 |

验收阶段修复：无。上述证据来自实施期，本文件写入后未重新执行测试。

## 限定审计

范围：预览端口隔离、Picker 与确认输入所有权、渲染和 resize 的业务副作用。实施期代码检查与 `no-side-effect`、`control`、`session-lifecycle`、真实 PTY 用例未发现越过 TUI 边界的写路径或重复确认；无待处理的限定审计。

## 后续注意事项

- React DevTools GUI 中临时修改 props 未实操；首次视觉迭代时可按工作台文档确认交互体验。
- tuistory 连续 resize 的 PNG 可能保留旧尺寸缓冲帧；干净的对比图按目标尺寸新开会话，真实当前帧以 PTY 用例为准。
- Windows 和其他终端环境未纳入本次 Ubuntu 本机验收。
