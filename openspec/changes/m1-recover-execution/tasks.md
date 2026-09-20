## 1. 启动对账与 mutation lane

- [ ] 1.1 实施 IP-1：新增 `src/domain/recovery/operation-intent.ts` 与 `src/application/reconciliation/reconcile-operations.ts`，以原 OperationId 得出已接受/已拒绝/未决三值结论；运行 `pnpm typecheck` 与 `pnpm test -- tests/recovery/reconcile-operations.test.ts`
- [ ] 1.2 实施 IP-2：在 `src/adapters/orca-cli/orca-backend.ts` 的 `query` 联合中增加按 OperationId 的只读对账查询并新增 `reconcile-query.ts`，把 `absent` 映射为未决；运行 `pnpm lint` 与 `pnpm exec vitest run tests/recovery/reconcile-operations.test.ts`
- [ ] 1.3 实施 IP-3：扩展 BranchCoordinationStore port，并通过 `src/adapters/storage/schema.ts` 的可重入版本化 migration 增加 mutation lane、Recovery、Scope 控制与 `ExecutionHandoffState`；在 coordination store 与 snapshot 投影中实现阻塞、解除前置校验与可观测输出；运行 `pnpm exec vitest run tests/recovery/mutation-lane.test.ts tests/coordination-store.test.ts`
- [ ] 1.4 实施 IP-4：在启动对账中调用前驱唯一的 `src/application/delivery/process-delivery.ts` 重放未确认 Delivery，将 unknown 阻塞到原 mutation lane，且不新增 pipeline 或去重类型；运行 `pnpm exec vitest run tests/recovery/delivery-replay.test.ts tests/application/process-delivery.test.ts`

## 2. Worker Session Recovery

- [ ] 2.1 实施 IP-5：新增 `src/domain/recovery/worker-session-recovery.ts` 与 `src/application/recovery/worker-session-recovery-service.ts`，实现四角色共用的恢复生命周期、精确恢复优先与 unverifiable 保持未决；运行 `pnpm typecheck` 与 `pnpm test -- tests/recovery/worker-session-recovery.test.ts`
- [ ] 2.2 实施 IP-6：扩展 recovery service 并新增 `src/domain/recovery/recovery-budget.ts`，实现稳定 RecoveryId、预写 Operation Intent、创建替代 Segment 即消耗、按 Worker Attempt 独立计数，并读取既有 `maxRecoveriesPerWorkerAttempt`；不得修改 Manifest 字段；运行 `pnpm exec vitest run tests/recovery/recovery-budget.test.ts`
- [ ] 2.3 实施 IP-7：在 recovery service 与 store 中实现替代 Session 保留原 Worker Task/contract/revision/业务 Attempt、创建新 Dispatch/Session Binding/Segment，以及 superseded 与原 Segment 迟到结果入历史；运行 `pnpm test -- tests/recovery/alternate-session.test.ts`
- [ ] 2.4 实施 IP-8：新增 `src/application/recovery/recovery-capsule.ts` 与 `src/domain/recovery/role-gate.ts`，实现 complete/partial Capsule 契约、transcript_unavailable 失败、同一 Recovery Operation 内单次安全重派与四角色门；运行 `pnpm test -- tests/recovery/recovery-capsule.test.ts`

## 3. Coordination Scope 控制

- [ ] 3.1 实施 IP-9：新增 `src/domain/coordination/scope-control.ts`、`src/application/coordination/scope-control-service.ts` 与 `src/application/controller-service.ts`，把既有 Session 消息、手动 compact、模型配置切换、Planning Handoff、只读快照、语义事件、Pause/Resume/Cancel/Exit 与 Pending Interaction CAS 回答组合进唯一 façade；Scope 初始化复用 `initializeCoordinationScope`；以 fake 用例验证各入口只委派一次且不直连 store/backend；运行 `pnpm exec vitest run tests/coordination/scope-control.test.ts tests/application/controller-service.test.ts`

## 4. Coordinator 交接

- [ ] 4.1 实施 IP-10：新增 `src/application/handoff/execution-handoff.ts` 的 `ExecutionHandoffState` 与 prepare/review/cutover，扩展 ControllerService，并用一次 CAS 转移 Lease、相关 Pending Interaction 与后续 Worker 事件责任；保持运行、图、授权与预算身份，失败时保持 Source owner，Target 成功后进入 `awaiting_user_prompt`；普通挂起/唤醒继续直接复用前驱模块；运行 `pnpm exec vitest run tests/handoff/execution-handoff.test.ts tests/application/controller-service.test.ts`

## 5. 启动衔接与整体核验

- [ ] 5.1 实施 IP-12：在 `src/bootstrap/startup.ts` 固定对账 → lane 投影 → 续办未完成 Recovery → Resume/Exit 处理 → 允许派发的顺序；运行 `pnpm test -- tests/bootstrap/startup-reconciliation.test.ts`
- [ ] 5.2 运行完整门禁 `pnpm typecheck && pnpm lint && pnpm test`，确认四个 capability 的全部 Scenario 有对应通过证据
- [ ] 5.3 复核六个限定审计标签对应的断言均存在且通过：`gate.no-ack-before-persist`、`gate.no-new-operation-id-on-unknown`、`gate.budget-not-reset-on-recovery`、`gate.recovery-not-inferred-from-incomplete-evidence`、`gate.alternate-session-new-dispatch-only`、`gate.partial-capsule-declares-gaps`

## 6. 验收验证

- [ ] 6.1 实施 IP-13：新增 `tests/recovery/acceptance/roles.test.ts` 与 `budget-boundaries.test.ts`，以 fake backend 覆盖 Specification Planner、Implementation、Validator、Finalizer 四类角色的 Recovery 与预算边界；运行 `pnpm test -- tests/recovery/acceptance/roles.test.ts tests/recovery/acceptance/budget-boundaries.test.ts`
- [ ] 6.2 实施 IP-13：新增 `tests/recovery/acceptance/capsule-verdicts.test.ts` 与 `late-results.test.ts`，以 fake Utility Worker 覆盖 complete/partial/unavailable Capsule 与 superseded Segment 的迟到结果；运行 `pnpm test -- tests/recovery/acceptance/capsule-verdicts.test.ts tests/recovery/acceptance/late-results.test.ts`
- [ ] 6.3 实施 IP-13：新增 `tests/recovery/acceptance/repeat-startup.test.ts` 与 `crash-windows.test.ts`，覆盖重复启动与 intent 预写前后、Segment 创建前后、ack 前后的崩溃窗口；运行 `pnpm test -- tests/recovery/acceptance/repeat-startup.test.ts tests/recovery/acceptance/crash-windows.test.ts`
- [ ] 6.4 实施 IP-13：新增 `tests/handoff/acceptance/fake-handoff.test.ts`，以 fake chat model 与 fake backend 覆盖挂起、唤醒与交接责任保持，确认零真实模型调用；运行 `pnpm test -- tests/handoff/acceptance/fake-handoff.test.ts`
- [ ] 6.5 实施 IP-13：在显式选择的隔离项目与专用 Orca 身份中运行一次真实 MiniMax-M3 Validator partial-transcript Recovery，确认 partial Capsule 字段完整且角色门据缺口判定；运行 `ORCA_COMPANION_REAL_HARNESS=1 pnpm test -- tests/recovery/acceptance/real-validator-partial.test.ts`
- [ ] 6.6 运行验收层全量：`pnpm test -- tests/recovery/acceptance tests/handoff/acceptance`，并确认 6.5 已在隔离项目执行且未触碰用户主项目
