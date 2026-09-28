## 1. 持久化与修订用例

- [x] 1.1 按 IP-01 追加持有接纳版本、schema 13 migration、来源/版本/额度事务核验和 IC-03 合同；运行 `pnpm exec vitest run tests/coordination-store.test.ts && pnpm typecheck`。
- [x] 1.2 按 IP-02 让既有修订用例续办 `graph_patch` 持有，并在 Admission 后原子结算；运行 `pnpm exec vitest run tests/execution/specification-revision.test.ts`。

## 2. 执行链路

- [x] 2.1 按 IP-03 接入旧派发可核验结算后的 Planner 专用许可与稳定身份，保持其它角色及后代冻结；运行 `pnpm exec vitest run tests/application/advance-execution.test.ts tests/application/materialize-work-package.test.ts`。
- [x] 2.2 按 IP-03 在前台宿主完成精确 Session Binding、Specification Admission、结算与事件发布，覆盖拒绝和重启；运行 `pnpm exec vitest run tests/integration/foreground-execution-runtime.test.ts`。
- [x] 2.3 按 IP-04 让执行投影、Git 集成资格与 Finalizer 只读取当前接纳契约的结算；运行 `pnpm exec vitest run tests/application/execution-view.test.ts tests/integration/foreground-execution-runtime.test.ts`。

## 3. 验收

- [x] 3.1 按 IP-05 在显式隔离夹具分别验收 revise 与 retire 补丁，保存持久事实并更新兼容性记录；运行 `pnpm exec vitest run tests/tui/pty-execution.test.ts --no-file-parallelism`，确认两次的 `delivery_verdicts=deliverable` 与重启身份不变。
- [x] 3.2 按 IP-01～IP-05 完成限定审计与全量门禁；运行 `pnpm typecheck && pnpm lint && pnpm test && pnpm build && openspec validate m2-settle-in-flight-graph-revision --strict && git diff --check`。
