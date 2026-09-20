## 1. 变化路由、补丁与提交

- [ ] 1.1 实施 IP-1：新增 `src/domain/execution/change-routing.ts` 与 `graph-patch.ts`，以及 `src/application/execution/graph-patch-planner.ts`，实现七值分类路由、含糊请求派发 Graph Patch Planner（MiniMax-M3）与 exact baseGraphVersion 校验；运行 `pnpm typecheck` 与 `pnpm test -- tests/execution/change-routing.test.ts`
- [ ] 1.2 实施 IP-2：扩展 `graph-patch.ts` 并新增 `src/domain/execution/graph-compiler.ts`，实现 add/revise/retire/takesOver、未接受后代逐一处置与影响集合/引用/无环/Scope/budget/auth/version 校验；运行 `pnpm test -- tests/execution/graph-compiler.test.ts`
- [ ] 1.3 实施 IP-3：扩展前驱 `src/application/planning/graph-history.ts` 的 `ExecutionGraphHistory`，让 graph-patch service 只通过 `appendAcceptedRevision` 提交归一化 Graph Revision，并带 expected version、OperationId 与回读；store 不暴露平行写图路径；运行 `pnpm exec vitest run tests/execution/graph-patch.test.ts`

## 2. Specification Revision 与持有

- [ ] 2.1 实施 IP-4：新增 `src/domain/execution/specification-revision.ts` 与 `src/application/execution/revision-service.ts`，替换 contract 后重新 Admission 并从 Specification Planner 重跑完整角色链；运行 `pnpm typecheck` 与 `pnpm test -- tests/execution/specification-revision.test.ts`
- [ ] 2.2 实施 IP-5：扩展 `src/domain/execution/revision-pending.ts` 并修改 frontier 选择，使持有只冻结受影响节点与未接受后代、无关节点仍可准入且旧结果不得越界；运行 `pnpm test -- tests/execution/revision-pending.test.ts`
- [ ] 2.3 实施 IP-6：扩展修订额度并新增 `src/application/execution/baseline-reconciliation.ts`，读取 Manifest 已批准上限（默认 2）、保证额度不重置，并在基线落后时建立独立 Baseline Reconciliation 任务；不得修改 Manifest 字段；运行 `pnpm exec vitest run tests/execution/baseline-reconciliation.test.ts`

## 3. 重规划与代际切换

- [ ] 3.1 实施 IP-7：新增 `src/domain/execution/replanning.ts` 与 `src/application/execution/replanning-service.ts`，按固定顺序停派发、以 drain 或显式 cancel-and-reconcile 收尾、释放 Execution Coordination Lease 并建立新 Planning Cycle；运行 `pnpm test -- tests/execution/replanning.test.ts`
- [ ] 3.2 实施 IP-8：在 replanning service 与 store 权威引用记录中实现 Generation Cutover 的原子引用切换、全新 Graph/Run/WorkPackage/worktree 与切换前取消路径；扩展 `ControllerService` 的图快照和语义事件；运行 `pnpm exec vitest run tests/execution/replanning.test.ts tests/application/controller-service.test.ts`
- [ ] 3.3 实施 IP-9：新增 `src/application/execution/baseline-adoption.ts` 与 `src/domain/execution/work-package-lineage.ts`，实现三条采用规则、矛盾事实阻塞与 lineage 继承已消耗额度；运行 `pnpm test -- tests/execution/baseline-adoption.test.ts`

## 4. 整体核验

- [ ] 4.0 通过 `src/adapters/storage/schema.ts` 的可重入版本化 migration 增加 accepted revision、patch 元数据、revision_pending、修订额度用量、Baseline Reconciliation、Lineage 与代际引用记录，保留初始 GraphVersion 与全部前驱数据；运行 `pnpm exec vitest run tests/coordination-store.test.ts`
- [ ] 4.1 运行完整门禁 `pnpm typecheck && pnpm lint && pnpm test`，确认三个 capability 的全部 Scenario 有对应通过证据
- [ ] 4.2 复核九个限定审计标签对应的断言均存在且通过：`gate.append-only-graph-history`、`gate.patch-base-version-exact`、`gate.patch-descendants-enumerated`、`gate.planner-result-not-committed`、`gate.revision-not-retry`、`gate.hold-scope-limited`、`gate.cutover-atomic-refs`、`gate.no-completion-copy-on-replan`、`gate.lineage-inherits-consumed-budget`

## 5. 验收验证

- [ ] 5.1 实施 IP-10：新增 `tests/execution/acceptance/compiler-branches.test.ts`，以 fake backend 与内存 store 覆盖缺处置、引用缺失、成环、超预算、未授权与版本漂移六类编译失败；运行 `pnpm test -- tests/execution/acceptance/compiler-branches.test.ts`
- [ ] 5.2 实施 IP-10：新增 `tests/execution/acceptance/revision-budget.test.ts`，以 fake backend 覆盖默认上限 2、不重置与基线落后时的独立 Baseline Reconciliation 任务；运行 `pnpm test -- tests/execution/acceptance/revision-budget.test.ts`
- [ ] 5.3 实施 IP-10：新增 `tests/execution/acceptance/hold-topology-scope.test.ts`，显式断言 revision_pending 期间无拓扑关系的节点继续进入 Execution Frontier，其未接受后代不派发后续角色；运行 `pnpm test -- tests/execution/acceptance/hold-topology-scope.test.ts`
- [ ] 5.4 实施 IP-10：在显式选择的隔离项目与专用身份中用真实 MiniMax-M3 完成 Graph Patch Planner 场景，确认含糊请求产出结构化补丁、声明 exact `baseGraphVersion`、逐一处置未接受后代并经 Admission 归一化；运行 `ORCA_COMPANION_REAL_HARNESS=1 pnpm test -- tests/execution/acceptance/real-patch-planner.test.ts`
- [ ] 5.5 实施 IP-10：在同一隔离项目与专用身份中完成一次真实新 Run cutover，确认 active Planning Cycle、GraphId、Run、Authorization、预算引用与 Lease 整体切换且新代际使用全新标识与 worktree；运行 `ORCA_COMPANION_REAL_HARNESS=1 pnpm test -- tests/execution/acceptance/real-run-cutover.test.ts`
- [ ] 5.6 运行验收层全量 `pnpm test -- tests/execution/acceptance`，确认 Graph Patch Planner 与 Baseline Reconciliation 的中断复用前驱 Worker Session Recovery 协议且本 change 未新增恢复 fixture
