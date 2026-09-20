## 1. 基线与启动门禁

- [ ] 1.1 按 D9 与 IP-01 增加 `ink@7.1.1`、`react@19.3.0`、`@types/react@19.3.0` 与开发依赖 `ink-testing-library@4.0.0`，声明 TUI 入口；运行 `pnpm install && pnpm typecheck` 确认 lockfile 与类型解析通过
- [ ] 1.2 按 D1、IP-02 在 `src/bootstrap/` 入口与 `src/interfaces/cli/argv.ts` 实现子命令解析与 stdin/stdout 双 TTY 检查，未通过时在挂载 Ink 前写 stderr 并非零退出；运行 `pnpm test -- tests/tui/pty.test.ts` 确认非 TTY 拒绝、`status --json` 保持可用、`resume` 被拒绝
- [ ] 1.3 按 D4、IP-03 在 `src/application/tui/view-model.ts` 定义纯展示 `TuiViewModel` 并从既有 `ControllerSnapshot` 派生，不重定义 Controller 快照或事件类型；让 `status --json` 复用 ControllerSnapshot 的公共投影；运行 `pnpm exec vitest run tests/tui/status-json.test.ts` 确认 stdout 可解析且字段语义未变

## 2. 初始化与主视图

- [ ] 2.1 按 D2、D3、IP-04 实现 Home 的 Scope 查找与初始化向导，Review 确认后单次调用既有 `initializeCoordinationScope`，失败整体回滚；运行 `pnpm exec vitest run tests/tui/home.test.tsx tests/tui/wizard.test.tsx` 确认恢复不重复创建、确认前零写入、核验失败无部分状态
- [ ] 2.2 按 D6、D7、IP-05 实现常驻主视图与固定键位映射，工具记录默认折叠，Answer 模式绑定 interaction ID 与 expected revision；运行 `pnpm test -- tests/tui/workspace.test.tsx` 确认窄屏主视图可用、普通字符不触发全局命令、`Esc` 只关最上层
- [ ] 2.3 按 D5、D8、IP-06 实现三态 Sidebar 与显示宽度渲染工具；运行 `pnpm test -- tests/tui/width.test.ts` 确认中文与中英文混排按显示宽度换行与裁切、折叠不被强制展开

## 3. Session、事件与图检查

- [ ] 3.1 按 IP-07 实现 Session Picker 与 Event Drawer 投影；运行 `pnpm test -- tests/tui/session-picker.test.tsx tests/tui/event-drawer.test.tsx` 确认默认选中待答 Session、事件不抢焦点、切换保留草稿、保活不进入时间线
- [ ] 3.2 按 IP-08 实现只读 Graph Inspector 与 Pending Interaction 内联卡片；运行 `pnpm test -- tests/tui/graph-inspector.test.tsx tests/tui/interaction-card.test.tsx` 确认导航与展开零写入、普通消息不满足待答问题、stale revision 被拒绝
- [ ] 3.3 按 D10、IP-11 在既有主视图与 Command Palette 接入 `/compact`、Model Picker 与 Route Planning Handoff，只投影 `CompactionOutcome`、维护状态/有限 cycle 上限、`PlanningHandoffProposal` 与 `awaiting_user_prompt`；运行 `pnpm exec vitest run tests/tui/session-lifecycle.test.tsx` 确认降级告警可见、耗尽后不再发起模型调用、运行中切换不被接受、cutover 后选中 Target、Capsule 失败显示 Scope blocker

## 4. 零副作用与终端验收

- [ ] 4.1 按 IP-09 补齐组件测试并验证重挂载、resize 与高频事件批次无业务副作用；运行 `pnpm test -- tests/tui/no-side-effect.test.tsx` 确认恢复、派发与写入计数为 0，折叠态不计算详情
- [ ] 4.2 按 IP-10 在 `script -qec` 提供的 PTY 中补齐 resize 与启动退出用例，并记录只支持当前 Ubuntu 本机；运行 `pnpm test -- tests/tui/pty.test.ts` 确认 resize 后边框对齐、退出后终端恢复
- [ ] 4.3 按 IP-11 在显式选择的隔离项目与专用身份中运行真实 PTY 规划 Handoff，Coordinator 显式使用 `minimax-cn/MiniMax-M3`；运行 `pnpm test -- tests/tui/pty-handoff.test.ts` 确认完成一次规划 Handoff 且 cutover 后 Target 处于 `awaiting_user_prompt`
- [ ] 4.4 按 IP-01～IP-11 与 design D9、D10 收口，运行全量门禁 `pnpm typecheck && pnpm lint && pnpm test && pnpm build && openspec validate m2-deliver-planning-tui --strict`，确认全部通过且未新增计划外文件
