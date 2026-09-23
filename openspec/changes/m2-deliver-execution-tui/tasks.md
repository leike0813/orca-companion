## 1. 执行投影基础

- [x] 1.1 按 D1、D2、IP-01 从既有 ControllerSnapshot 扩展 `TuiViewModel` 与顶栏，加入 Graph Generation、Authorization、control state 与 active Work Package 计数（并发上限固定为 1，取值只可能是 0 或 1），并以稳定拓扑布局执行图节点；不得定义第二份快照 DTO；运行 `pnpm exec vitest run tests/tui/execution-workspace.test.tsx tests/tui/execution-graph.test.tsx` 确认授权不重置工作区、重启先对账、状态变化不重排、折叠态不计算详情、最多一个 active
- [x] 1.2 按 IP-02 实现 Work Package 生命周期与 liveness 分列投影，以及串行 Frontier 推进、串行 integration queue 与冲突分级；运行 `pnpm test -- tests/tui/execution-frontier.test.tsx` 确认等待中的包不进入 active、进入 waiting integration 后串行集成、unverifiable 独立显示、严重冲突与轻微 reconciliation 状态不同

## 2. 恢复与不确定状态

- [x] 2.1 按 IP-03 在 Sidebar 与 Event Drawer 投影 Recovery Segment、剩余 Recovery 预算、`complete`/`partial` coverage、superseded 与 AcceptedWorkerResultRef；不得复制 Accepted Worker Result 正文；运行 `pnpm exec vitest run tests/tui/recovery.test.tsx` 确认 partial 缺口可见、迟到结果只补历史、Recovery 失败显示 blocker
- [x] 2.2 按 IP-04 实现 unknown 与 unverifiable 的一等展示，并确认重绘不触发重试；运行 `pnpm test -- tests/tui/unknown-state.test.tsx` 确认 unknown 呈现为待对账且展示路径零写入

## 3. 控制与终态

- [x] 3.1 按 IP-05 实现 Scope 级 Pause、Resume 与 Cancel 意图提交与危险态确认，保持 `cancelling` 直到快照给出终态，且不提供单个 Work Package 的控制；运行 `pnpm test -- tests/tui/control.test.tsx` 确认 Pause 不要求确认、Resume 先对账、Cancel 不乐观显示终态、无单包控制入口
- [x] 3.2 按 IP-06 实现 Exit 与 `Ctrl+C` 只结束前台 Controller 并覆盖危险态确认；运行 `pnpm test -- tests/tui/exit.test.tsx` 确认 Exit 不等同 Cancel、退出后无新调度或集成
- [x] 3.3 按 IP-07 实现 Finalizer 条件与 Delivery Verdict 投影；运行 `pnpm test -- tests/tui/finalizer.test.tsx` 确认门禁不满足或工作区变化只显示 blocker、单包通过不显示 deliverable
- [x] 3.4 按 D10、IP-11 复用前驱交互，经 ControllerService 推进 `ExecutionHandoffState` 的 prepare、review 与 cutover；不得复用 `PlanningHandoffProposal`；运行 `pnpm exec vitest run tests/tui/execution-handoff.test.tsx` 确认 cutover 后选中 Target 且显示 `awaiting_user_prompt`、Worker 事件不唤醒模型、Capsule 失败保持 Source owner 并显示 blocker

## 4. 快照字段与有界刷新

- [x] 4.1 按 IP-08 扩展 `status --json` 的执行快照字段并实现隐藏分区与事件批次有界刷新；运行 `pnpm test -- tests/tui/status-json.test.ts tests/tui/execution-graph.test.tsx` 确认 stdout 可解析、既有字段语义不变、折叠态不计算详情

## 5. 端到端验收

5.2/5.3 保留在本 change；生产执行路径由并行解阻塞 change `m2-wire-execution-runtime` 接通并先行验证、归档后，再运行下述真实 PTY 验收。两者共享文件须串行编辑。

- [x] 5.1 按 IP-09 补齐自动测试与 `tests/tui/harness.ts` 共用夹具；运行 `pnpm test -- tests/tui/` 确认串行 Frontier 推进、单 active Work Package、控制竞态、旧 generation 事件与 Finalizer 门禁全部覆盖
- [ ] 5.2 按 IP-10 在显式选择的隔离项目与专用身份中运行真实 PTY 端到端，Coordinator、Planner、Implementation、Validator、Recovery Utility、Graph Patch Planner 与 Finalizer 均显式使用 `minimax-cn/MiniMax-M3`；运行 `pnpm test -- tests/tui/pty-execution.test.ts` 确认完成授权、串行 Frontier 推进、reconciliation、Finalizer、重启对账不重复派发与最终 deliverable
- [ ] 5.3 按 IP-10、IP-03 在同一次真实 PTY 验收中覆盖至少一次执行态 Worker Session Recovery，或一次明确的 Recovery blocker，二者均须显式使用 `minimax-cn/MiniMax-M3` 并在界面如实可见；运行 `pnpm test -- tests/tui/pty-execution.test.ts`
- [x] 5.4 按 IP-01～IP-11 与 design D9、D10 收口，更新用户文档与 compatibility 记录并运行全量门禁 `pnpm typecheck && pnpm lint && pnpm test && pnpm build && openspec validate m2-deliver-execution-tui --strict`，确认只声明当前 Ubuntu 本机前台 TUI
