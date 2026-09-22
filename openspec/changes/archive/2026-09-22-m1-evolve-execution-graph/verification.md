# Verification

## 验收对象

- Change：`m1-evolve-execution-graph`
- 基线 HEAD：`a343a42a30ab4f2d4ad8d8d645ff2fb2a1597912`
- 实现形态：未提交工作区改动
- 验收日期：2026-09-22

## 结论

**PASS。** OpenSpec 18/18 项任务完成；3 个 capability 的 9 个 Requirement、28 个 Scenario 均有实现与测试证据。完整门禁、严格 OpenSpec 校验、九项限定审计、真实 MiniMax-M3 Graph Patch Planner 和真实新 Run cutover 均通过。

| 维度 | 状态 | 结论 |
|---|---|---|
| 完整性 | PASS | IP-1 至 IP-10、18 项任务及验收资产齐全 |
| 正确性 | PASS | 确定性规则由单元/验收测试覆盖；两项必须真实验证的外部行为均有隔离运行证据 |
| 一致性 | PASS | 图历史、预算、授权、lease/fencing、Orca/Git 事实归属与冻结接缝一致 |

## 关键证据

| 能力 | 实现与验证证据 | 结果 |
|---|---|---|
| 变化路由与 Planner | `src/domain/execution/change-routing.ts`、`src/application/execution/graph-patch-planner.ts`、`tests/execution/change-routing.test.ts` | 七值路由仅在语义含糊时派 Planner；请求携带 exact base version、变化声明、当前图和受影响节点 |
| Graph Patch 与唯一提交点 | `src/domain/execution/graph-patch.ts`、`graph-compiler.ts`、`src/application/execution/graph-patch-service.ts`、`src/application/planning/graph-history.ts` | add/revise/retire/takesOver、后代闭集、引用/无环/Scope/预算/授权/版本校验通过；Planner 结果必须先经 Admission，再由追加历史提交 |
| Specification Revision 与持有 | `src/application/execution/revision-service.ts`、`src/domain/execution/revision-pending.ts`、`src/domain/dispatch-candidate.ts` | 修订与 Retry 分离；重新 Admission 后从 Specification Planner 重跑；持有只冻结受影响子图 |
| 修订额度与 Baseline Reconciliation | `src/application/execution/baseline-reconciliation.ts`、`src/adapters/agents/baseline-worker.ts`、`src/adapters/git/baseline-observer.ts`、`src/application/execution/graph-patch-service.ts` | 图版本与 required 记录同事务写入；应用用例立即驱动独立 Planner Task，重放不重复派发；Accepted Result 与实时 Git ancestry/HEAD/dirty/scope 均满足后才解除持有 |
| Replanning 与 Cutover | `src/application/execution/replanning-service.ts`、`src/application/execution/baseline-adoption.ts`、`src/domain/execution/work-package-lineage.ts` | drain/cancel-and-reconcile、原子权威引用切换、取消恢复、旧成果采用与 lineage 额度继承均通过 |
| Controller 投影 | `src/application/controller-service.ts`、`tests/application/controller-service.test.ts` | façade 只投影并委派语义命令，不直连 store/backend，不建立第二条写图路径 |

## 真实外部验收

### Graph Patch Planner

在一次性隔离 Git 仓库和专用 Orca 身份中，以 MiniMax-M3 经真实 Orca Task、Codex Worker、Session Binding、Delivery 与 Accepted Worker Result 完成：

- 输出结构化补丁并声明当前 exact `baseGraphVersion`；
- 用 `revise` 表达直接受影响节点，并逐一处置未接受后代；
- 经确定性 Admission 归一化；
- 由受 fencing 保护的唯一追加入口写入下一 GraphVersion。

命令：`ORCA_COMPANION_REAL_HARNESS=1 ... pnpm exec vitest run tests/execution/acceptance/real-patch-planner.test.ts --no-file-parallelism`

结果：1 项通过，78.66s。测试使用最小隔离 Codex 配置和只读本地控制 sandbox；测试 Runtime Lease TTL 覆盖真实模型调用时长，生产默认 TTL 与 fencing 规则未改变。`worker_done` 先经前驱 `settleDelivery` 核验并写成 Orca Accepted Worker Result，回读和本地去重引用成功后才确认 Delivery、进入 Admission。

### Generation Cutover

`tests/execution/acceptance/real-run-cutover.test.ts` 在隔离仓库与专用身份中通过；候选 Run 从 Orca runtime 回读，active Planning Cycle、GraphId、Run、Authorization、预算引用与 Lease 在同一切换中更新，新代际使用全新身份和 worktree。

## 门禁结果

- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm test`：93 个文件通过、3 个跳过；870 项通过、6 项跳过。跳过项是必须显式选择隔离环境的真实 harness。
- `pnpm build`：通过。
- `pnpm exec vitest run tests/execution/acceptance --no-file-parallelism`：4 个文件通过、2 个真实 harness 文件按默认配置跳过；23 项通过、2 项跳过。
- `openspec validate m1-evolve-execution-graph --strict`：通过。
- `openspec instructions apply --change m1-evolve-execution-graph --json`：18/18，`all_done`。

## 限定审计

以下九项标签均在 `tests/execution/acceptance/gates.test.ts` 中有独立断言，并包含于通过的全量测试：

- `gate.append-only-graph-history`
- `gate.patch-base-version-exact`
- `gate.patch-descendants-enumerated`
- `gate.planner-result-not-committed`
- `gate.revision-not-retry`
- `gate.hold-scope-limited`
- `gate.cutover-atomic-refs`
- `gate.no-completion-copy-on-replan`
- `gate.lineage-inherits-consumed-budget`

未发现阻塞归档的实现问题。真实 harness 默认跳过是安全门禁，不代表未验证；本次两项必需真实场景均已在显式隔离环境中完成。当前 change 提供 Baseline Reconciliation 的原子登记、应用用例推进入口和幂等 Worker driver；完整 Controller/bootstrap 运行时装配属于后续里程碑，尚未宣称为已交付的 TUI 端到端能力。平台支持仍以项目声明的 Ubuntu 本机验证范围为限。
