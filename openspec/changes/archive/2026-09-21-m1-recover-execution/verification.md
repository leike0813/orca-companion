# Verification

## 验收对象

- Change：`m1-recover-execution`
- 输入实现 HEAD：`ed16e3d4391fcd0c8e56d231f2fe4988540e3fa7`
- 最终验收 HEAD：`ed16e3d4391fcd0c8e56d231f2fe4988540e3fa7`（用户未授权 commit；受验未提交工作树 checkpoint：`bac39fb66cdc00e65fb451689a1aa83c7c79b90d`）
- 验收 Agent：Codex（GPT-5）

## 结论

**PASS**。边界为本 change 的 10 条 Requirement、35 个 Scenario、19/19 个实施任务与 IP-1 至 IP-13；真实 harness 结论仅适用于已验证的 Ubuntu、Orca 1.4.198 与 Codex 0.154.0 组合。无 CRITICAL 或 WARNING，可进入 archive 审批。

| 维度 | 结果 |
|---|---|
| 完整性 | 19/19 tasks；10/10 Requirements；35/35 Scenarios |
| 正确性 | 10/10 Requirements 有实现与行为证据；真实 6.5 通过 |
| 一致性 | D1–D12 与 IP-1–IP-13 的模块归属、SSOT、三值语义和失败关闭边界一致 |

## 核验与修复证据

| Requirement / Scenario / IP-ID | 证据或命令 | 结果 |
|---|---|---|
| 启动对账、mutation lane、Delivery 重放（IP-1–IP-4、IP-12；8 Scenarios） | `src/application/reconciliation/reconcile-operations.ts`、`src/bootstrap/startup.ts`、`src/application/delivery/process-delivery.ts`；`tests/recovery/reconcile-operations.test.ts`、`mutation-lane.test.ts`、`delivery-replay.test.ts`、`tests/bootstrap/startup-reconciliation.test.ts` | 原 OperationId 对账，`absent` 保持未决，unknown 阻塞原 lane，启动复用唯一 Delivery pipeline |
| Worker Session Recovery 入口与三值存活（IP-5；3 Scenarios） | `src/domain/recovery/worker-session-recovery.ts`、`src/application/recovery/worker-session-recovery-service.ts:1071`；`tests/recovery/worker-session-recovery.test.ts` | 精确恢复优先；`unverifiable` 不推断退出；Coordinator 不进入 Worker Recovery |
| 稳定 RecoveryId、预写 intent、预算与 workspace（IP-6；4 Scenarios） | `src/domain/recovery/recovery-budget.ts`、`worker-session-recovery-service.ts`；`tests/recovery/recovery-budget.test.ts`、`tests/recovery/acceptance/budget-boundaries.test.ts` | 按 Worker Attempt 独立计数，替代 Segment 与消耗同事务，重启不重置，workspace 不可对账即阻塞 |
| 替代 Session 身份与 superseded 迟到结果（IP-7；3 Scenarios） | `worker-session-recovery-service.ts`、`src/adapters/storage/coordination-store.ts`；`tests/recovery/alternate-session.test.ts`、`tests/recovery/acceptance/late-results.test.ts` | 保留 Task/contract/revision/业务 Attempt，新建 Dispatch/Binding/Segment；迟到结果不推进当前流程 |
| Capsule、角色门、Codex transcript 与 prepared-terminal（IP-8、IP-13；7 Scenarios） | `src/application/recovery/recovery-capsule.ts`、`src/domain/recovery/role-gate.ts:80`、`src/application/worker-launch.ts`、`src/adapters/agents/codex-launch.ts:29`、`codex-transcript.ts`、`utility-worker.ts:345`；对应 unit/acceptance tests | complete/partial 边界、Adapter coverage、唯一 rollout、四角色门、一次 Utility 重派、Finalizer 无 Capsule 分支均通过 |
| 真实 MiniMax-M3 Validator Recovery（IP-8、IP-13） | `ORCA_COMPANION_REAL_HARNESS=1 ... pnpm exec vitest run tests/recovery/acceptance/real-validator-partial.test.ts --no-file-parallelism --reporter=verbose` | 3 passed / 1 skipped；Validator 以 `operator_close` 精确中断，exact Worker 与 SessionStart/rollout 绑定通过，Utility 投递 `complete` Capsule，所有临时资源回收，用户级 Codex 配置未变 |
| Scope 控制与 ControllerService（IP-9；7 Scenarios） | `src/domain/coordination/scope-control.ts`、`src/application/coordination/scope-control-service.ts`、`src/application/controller-service.ts:610`；`tests/coordination/scope-control.test.ts`、`tests/application/controller-service.test.ts` | Pause/Resume/Cancel/Exit 正交；stale Interaction 零副作用；界面只收语义事件；façade 不直连 backend/store |
| Execution Handoff（IP-10；3 Scenarios） | `src/application/handoff/execution-handoff.ts:199`、`:243`、`:370`；`tests/handoff/execution-handoff.test.ts`、`tests/handoff/acceptance/fake-handoff.test.ts` | prepare/review 不转移 owner，cutover 单 CAS 转移责任且保持运行身份，失败保留 Source owner |
| Store / migration / SSOT（IP-3、IP-6、IP-10） | `src/adapters/storage/schema.ts:12`、`:352`、`:379`、`src/adapters/storage/coordination-store.ts`；`tests/coordination-store.test.ts` | schema v7 可重入迁移；仅保存 lane/Recovery/control/handoff 共享事实，未复制 Orca/Git 正文 |
| 全量质量门 | `pnpm typecheck && pnpm lint && pnpm build`；`pnpm exec vitest run --reporter=dot` | exit 0；79 files passed / 1 skipped，733 passed / 4 skipped |
| 验收层与 OpenSpec | `pnpm exec vitest run tests/recovery/acceptance tests/handoff/acceptance --reporter=dot`；`pnpm exec openspec validate m1-recover-execution`；`pnpm exec openspec validate --all`；`git diff --check` | 8 files passed，48 passed / 2 skipped；change valid；29/29 valid；diff clean |

验收阶段修复：

- 把 Recovery 的物化 Task 核验移到 prepared terminal 创建之前，避免无 Task 时泄漏 external terminal；增加对应回归用例。
- 针对当前 Linux 禁止 bubblewrap namespace 的环境，在隔离 `CODEX_HOME` 内新增封闭 Utility permission profile，文件权限继承 `:read-only`，固定使用 Codex legacy Landlock；来源配置存在冲突 legacy sandbox 键时失败关闭。
- 将真实 Validator 的中断证据收紧为 exact external terminal 已关闭且读回不存在，避免 `worker-stop=unknown` 时把仍在增长的 rollout 误当中断记录。

## 限定审计

范围：Implementation Plan 第 8 节指定的六个安全门；结论：**PASS**。

| 审计标签 | 证据 |
|---|---|
| `gate.no-ack-before-persist` | `tests/recovery/acceptance/crash-windows.test.ts:589` |
| `gate.no-new-operation-id-on-unknown` | `tests/recovery/acceptance/repeat-startup.test.ts:144` |
| `gate.budget-not-reset-on-recovery` | `tests/recovery/acceptance/budget-boundaries.test.ts:129` |
| `gate.recovery-not-inferred-from-incomplete-evidence` | `tests/recovery/acceptance/roles.test.ts:238` |
| `gate.alternate-session-new-dispatch-only` | `tests/recovery/acceptance/late-results.test.ts:253` |
| `gate.partial-capsule-declares-gaps` | `tests/recovery/acceptance/capsule-verdicts.test.ts:269` |

六条标签均被验收层命令实际执行并通过，无待完成审计。

## 后续注意事项

- `use_legacy_landlock` 是 Codex 0.154.0 的 deprecated 特性；升级 Codex 时必须重跑 permission-profile POC 与 6.5 真实验收，不得默认继续受支持。
- Windows、Orca runtime 重启后的 terminal handle remint 与公开 provider transcript 绑定仍未验证，不影响本 change 在当前 Ubuntu 公共 CLI 边界下的 PASS。
