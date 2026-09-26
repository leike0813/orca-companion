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

**当前状态（2026-09-26）**：解阻塞并行项 `m2-repair-read-only-worker-sandbox` 已用隔离 alpha 取得真实 Capsule、只读 Finalizer 与 `deliverable`，两组 PTY 各 8 passed / 1 skipped，重启无重复派发。其验收和归档不以本 change 先归档为前提。本节下文为 09-25 的历史证据；5.2 目前仍缺 Graph Patch Planner 与 baseline reconciliation 的真实同链路场景，因此保持未勾选。

5.2 的现有 PTY 链路与 5.3 的 Recovery 场景已在本机运行（2026-09-25）：生产执行路径由已归档的 `m2-wire-execution-runtime` 接通，真实 PTY 验收在显式选择的隔离项目与专用身份中进行，分离线项目两次覆盖（是否制造执行态中断）。5.2 仍缺同链路 Graph Patch Planner、reconciliation 与最终 deliverable 证据，详见 `verification.md`。验收期间定位并修复了一处生产接线缺陷：**未确认 Delivery 的读取范围不能冻结在进程启动时刻**——Scope 会在同一个前台进程里从 `route_planning` 授权切换到 `execution_coordination`，启动时那份「本 Scope 没有 Run」的结论随即过期，冻结它会让该进程此后永远读不到任何未确认 Delivery，Delivery 结算在同一个 TUI 会话里不可能发生（真实运行里表现为链路停在 Planner 交付之后）。修复：`src/bootstrap/startup.ts` 的 `readDeliveries` 改为每次重放时现读，`src/bootstrap/foreground-planning-runtime.ts` 新增 `currentDeliveryFacts`；回归用例 `tests/bootstrap/startup-reconciliation.test.ts` 的「Resume 每次重新读取 Delivery 事实」在修复前失败、修复后通过。

- [x] 5.1 按 IP-09 补齐自动测试与 `tests/tui/harness.ts` 共用夹具；运行 `pnpm test -- tests/tui/` 确认串行 Frontier 推进、单 active Work Package、控制竞态、旧 generation 事件与 Finalizer 门禁全部覆盖
- [ ] 5.2 按 IP-10 在显式选择的隔离项目与专用身份中运行真实 PTY 端到端，Coordinator、Planner、Implementation、Validator、Recovery Utility、Graph Patch Planner 与 Finalizer 均显式使用 `minimax-cn/MiniMax-M3`；运行 `pnpm test -- tests/tui/pty-execution.test.ts` 确认完成授权、串行 Frontier 推进、reconciliation、Finalizer、重启对账不重复派发与最终 deliverable
  **真实证据（2026-09-25，两种模式各一次；均 8 passed / 1 skipped）**
  - 不制造中断（`ORCA_COMPANION_PTY_RECOVERY_INTERRUPT=0`，隔离项目 `orca-companion-e2e26` + 身份 `term_05cd6193-…`）：Palette 内完成授权（审阅显示 `codex=danger-full-access finalizer=read-only`）→ 真实 Planner（`ctx_46aefb8e3375`）、Implementation（`ctx_f8a6eee1c798`）、Validator（`ctx_38bb5b0deada`）三条会话 → 三次 Delivery 在同一 TUI 会话内结算 → 受控集成把 canonical 从基线 `dedbbad` 推进到 `ca693fd`（Git 事实）→ 只读 Finalizer 派发（`ctx_12672b789d48`）→ 退出重启后读回同一批 `(workPackageId, state, attemptId)`，不产生新的派发或集成。
  - 制造一次执行态中断（隔离项目 `orca-companion-e2e27` + 身份 `term_06f3cd75-…`）：见 5.3。
  - 逐角色模型证据：每个真的跑起来的角色，其真实 Codex rollout 的 `session_meta` 都落在 `MiniMax-M3`（配置 `execution.workerModel` 是唯一来源）。
  - **未取得 `deliverable`**：本机只读沙箱不能执行命令（`codex` 在 `:read-only` profile 下 `exec_command` panic：`filesystem-restricted execution requires bubblewrap to isolate app-server sockets`），Capsule Utility Worker 与只读 Finalizer 都跑不动。因此（a）运行里一旦发生执行态中断，唯一的 Work Package 就停在 Recovery blocker；（b）即使走到 Finalizer 也拿不到交付结论。按用户决定**按环境阻断收口**：验收断言的是不变量「没有可核验的只读结论就不得显示 deliverable」，缺陷与候选修法另立 `m2-repair-read-only-worker-sandbox`，`docs/orca-compatibility.md` 记录精确 panic 与影响面。
  - **Graph Patch Planner 与 baseline reconciliation 的生产入口已补齐，真实同链路证据未取得**：`request_graph_patch` 将含糊变化声明交给真实 Planner Task，结果经 Delivery 结算、Admission 后追加图版本；落后基线登记独立 Planner Task，后续 Resume 沿原 Task/Dispatch 消费 Delivery 并核验 Git。应用、工具及基线 Delivery 的行为测试已覆盖这条接线；现有 PTY 单包场景尚未触发图修订，本机只读 Worker 沙箱也阻止了真实 Planner 角色运行。5.2 因此仍未完成。
- [x] 5.3 按 IP-10、IP-03 在同一次真实 PTY 验收中覆盖至少一次执行态 Worker Session Recovery，或一次明确的 Recovery blocker，二者均须显式使用 `minimax-cn/MiniMax-M3` 并在界面如实可见；运行 `pnpm test -- tests/tui/pty-execution.test.ts`
  **真实证据（2026-09-25，`orca-companion-e2e27`）**：Implementation 派发（`ctx_e95dcf27d0b6`）运行中由验收经生产 transport 发起 `terminal-close` 制造真实 Session 中断（Orca 记 `workerState: failed`）→ 宿主创建 Recovery 并派发受限 Capsule Utility Worker（`ctx_0bb82d8c6bba`）→ Capsule 在本机只读沙箱下无法执行命令，宿主按设计以 `blocked` 收尾（`consumed_budget = 0`，`blocking_reason = 等待 Capsule 报告超时`）。界面如实可见：状态行 `active 0 · recovery blocked 1`，Sidebar `recovery` 分区 `implementation blocked` / `budget remaining=1/1` / `! 等待 Capsule 报告超时…`，`blockers` 分区 `! capsule_failed`。
- [x] 5.4 按 IP-01～IP-11 与 design D9、D10 收口，更新用户文档与 compatibility 记录并运行全量门禁 `pnpm typecheck && pnpm lint && pnpm test && pnpm build && openspec validate m2-deliver-execution-tui --strict`，确认只声明当前 Ubuntu 本机前台 TUI
