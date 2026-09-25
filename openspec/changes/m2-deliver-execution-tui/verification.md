# Verification

## 验收对象

- Change：`m2-deliver-execution-tui`
- 输入实现 HEAD：`d2ea092d936841e803d933792d75dc5f7eedbb64`，含当前工作区未提交改动
- 最终验收 HEAD：`d2ea092d936841e803d933792d75dc5f7eedbb64`；修复保留在未提交工作区
- 验收 Agent：Codex

## 结论

**BLOCKED**。代码层面的 Graph Patch Planner 派发与 baseline reconciliation 接线已补齐，常规门禁通过。真实 PTY 同链路仍未取得这两个角色的运行证据和最终 `deliverable`：本机只读 Codex 会话无法执行命令，现有单包 PTY 场景也没有触发图修订。5.2 保持未完成。

## 核验与修复证据

| Requirement / Scenario / IP-ID | 证据或命令 | 结果 |
| --- | --- | --- |
| 常规门禁 | `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`、`openspec validate m2-deliver-execution-tui --strict`、`git diff --check` | **PASS**。完整测试复跑：138 个文件通过、6 个跳过；1203 个用例通过、12 个跳过。首次与类型检查并行的运行有 10 个 5 秒超时；受影响的 6 个文件串行复跑 54/54 通过，随后独立重跑全量 1203/1203 通过。 |
| 折叠态不计算详情 | `projectGraphView` 折叠态只投影图标识与 readiness；`projectExecutionProjection` 从既有 Frontier 保留 active 计数，并按原拓扑排列 integration queue；`TuiApp` 在 Graph Inspector 打开时恢复完整节点投影。`tests/tui/execution-graph.test.tsx` 验证折叠态不读取 Work Package 详情及逆序 Frontier 的队列顺序。 | **PASS**。相关 4 个测试文件、20 个用例通过；最终代码的全量测试通过。 |
| 真实 PTY 交付断言 | 将 `readOnlyProfile` 断言从无效的 `verified` 改为契约值 `enforced`；`pnpm typecheck` 通过。 | **PASS（静态）**。真实 `deliverable` 分支因环境阻断尚未执行。 |
| Graph Patch Planner 生产接线 | `request_graph_patch` 工具 → `requestGraphPatch` → 真实 Task/Dispatch/Delivery → Admission → GraphVersion 追加；授权切换后同一 Session 重建工具注册表。`tests/execution/request-graph-patch.test.ts`、`tests/workflow/execution-tools.test.ts`、`tests/bootstrap/graph-patch-worker.test.ts`。 | **PASS（行为与静态）**。含糊变化派发、授权版本链、身份、编译、去重与未决派发不重复调用均通过；本机真实 Planner 仍受只读沙箱阻断。 |
| baseline reconciliation 生产接线 | 图追加后登记 required；独立 Planner Task 的 Task/Dispatch 绑定；Resume 沿原身份结算 Delivery、核验 Git，再解除门禁。`tests/bootstrap/baseline-reconciliation-runtime.test.ts` 覆盖已派发结果的结算与重放；通用 Delivery 重放把该独立 Task 留给专用 driver。 | **PASS（行为）**。Delivery 先结算、随后 verified，重放不重复派发。真实同链路运行仍未执行。 |
| 真实 PTY 启用状态 | `pnpm exec vitest run tests/tui/pty-execution.test.ts --no-file-parallelism` | **SKIPPED**。本轮未显式选择全新隔离项目与专用身份；命令没有运行真实 Worker。 |
| IP-10：只读角色与最终 deliverable | 本机只读 Codex Worker 执行命令时因缺少 bubblewrap 隔离条件而 panic；详见 `docs/orca-compatibility.md` 及独立变更 `m2-repair-read-only-worker-sandbox`。 | **BLOCKED**。同一环境原因影响 Recovery Utility、Graph Patch Planner 与 Finalizer；本轮按用户范围不修复沙箱。 |

## 限定审计

- 按用户指定顺序先建立阶段性记录，再修复、复跑并更新本文件。
- OpenSpec 状态为 12/13 项完成；5.2 保持未完成。生产入口已补齐，但行为测试不能替代真实 PTY 中的同链路证据。
- 此 change 的 IC-12 边界只消费 Controller 快照与命令；Graph Patch Planner 与基线补救均由执行协调层拥有，TUI 只显示已提交事实。
- 当前工作区包含此前其他 Agent 的未提交改动；本轮没有提交、切换分支或覆盖这些改动。

## 后续注意事项

- `tasks.md` 5.2 仍未完成；现有 PTY 用例只覆盖单包路径，尚未用真实同一会话观察 Graph Patch Planner、reconciliation 与最终 `deliverable`。
- 本机只读 Worker 修复由独立变更 `m2-repair-read-only-worker-sandbox` 规划；修复后需在新的显式隔离项目增补图修订场景并重跑真实 PTY 验收。
