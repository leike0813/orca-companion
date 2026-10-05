# Verification

## 验收对象

- Change：restore-configurable-execution-concurrency
- 输入实现 HEAD：055c148bf037af825c6c099e38fda85317133731（验收对象是**该 commit 之上尚未提交的冻结工作区**；该 commit 本身不含本 change 的实现，本报告不声称实现已包含在该 commit 中）
- 最终验收 HEAD：055c148bf037af825c6c099e38fda85317133731（同上；工作区于 2026-10-05T10:31:11Z 冻结，验收期间未提交、未切换分支）
- 验收 Agent：Aquinas（原生 Subagent，继承父模型）；只读验收并创建本报告，主 Agent 核对报告与补充证据。验收期间未做生产修复；本次唯一新增文件为本 verification.md

## 结论

PASS。

边界：结论只覆盖 055c148 之上这份冻结未提交工作区在 `restore-configurable-execution-concurrency` 范围内的义务：6 份 delta spec 的全部 Requirement/Scenario、IP-01..IP-05 与 tasks 1.1–3.3（全部已 checked）、全量 Vitest、typecheck/lint/build、OpenSpec strict validate、Git diff check、真实隔离闭环 06（Finalizer deliverable，record 1791195727255）与五域限定审计。
不在结论范围内：Windows（未验证）、上游 Orca 其它版本与其它环境、references/orca submodule、真实运行中模型服务的临时 529/超时（环境阻断，非实现缺陷）、以及与该 change 无关的既有历史工件。验收期间无生产代码变化；唯一新增文件为本报告。

## 核验与修复证据

| Requirement / Scenario / IP-ID | 证据或命令 | 结果 |
|---|---|---|
| tasks 1.1–3.3（IP-01..IP-05） | `openspec/changes/restore-configurable-execution-concurrency/tasks.md` 全部 `- [x]` | PASS |
| IP-01 config/execution-settings：Configurable concurrency / Invalid or stale edit | `src/application/configuration/project-config.ts`（schema3 limits `.safe()`）、`src/domain/planning/budget-policy.ts`（默认 3/8/2，闭集正安全整数）；`tests/configuration/project-configuration-store.test.ts`（1/2/3/5 与非合法值）、`tests/configuration/execution-settings.test.ts` | PASS |
| IP-01/04 Configurable concurrency：More than three lanes；Explicit execution concurrency reapproval：Decreased concurrency drains / Reapproval rejected | 设置保存不改当前 Manifest；完整重新批准才应用。`tests/configuration/execution-settings.test.ts`、`tests/application/authorization-service.test.ts`、`tests/application/advance-execution.test.ts`（已占位包保留，降低额度只挡新包） | PASS |
| IP-01 graph-compilation：超限不产出候选图 / Concurrency independent of topology | `src/domain/planning/{budget-policy,graph-compiler}.ts`（容量 `maxWorkPackages`、图无并发字段）；`tests/domain/budget-policy.test.ts`、`tests/domain/graph-compiler.test.ts`、`tests/execution/graph-compiler.test.ts`（额度 1 与 5 同拓扑） | PASS |
| IP-01 Removed Compilation carries budget caps and scope envelopes；新增 Compilation carries package budgets and graph capacity | 图不再保存并行策略，Scope Envelope 与每包预算保留；对应编译与预算测试通过，见上一行 | PASS |
| IP-01 execution-authorization：限定额度重批准 / 陈旧审阅与重复批准 | `src/application/planning/authorization-service.ts`（`modelReauthorizationManifest` 只改额度/模型、指纹+CAS）、`src/bootstrap/execution-runtime.ts`（`review`/`recordModelReauthorization` 绑定当前 Graph head）；`tests/application/authorization-service.test.ts` | PASS |
| IP-02 concurrency-control：Atomic lane admission / Concurrent callers / Restart before observation / Lane-local blockers | `src/adapters/storage/coordination-store.ts:6695`（`reserve-work-package-lane`，CAS+fencing+额度）、`src/application/execution/advance-execution.ts:330,337`（容量与 `awaiting-observation`）；`tests/coordination-store.test.ts`、`tests/application/advance-execution.test.ts`、`tests/bootstrap/foreground-execution-runtime.test.ts` | PASS |
| IP-02 Atomic Work Package lane admission：Prepared terminal title changes；Lane-local blockers：One blocked lane | `tests/application/materialize-work-package.test.ts`（标题改写后仍复用持久句柄、已接受激活不重发）、`tests/application/advance-execution.test.ts` 与 foreground runtime 测试（独立包继续推进） | PASS |
| IP-03 git-integration：Merged-tree validation / Session 与证据不匹配 / 有限复验额度 | `src/application/integration-reconciliation.ts`（`readTree` 精确树、validated 需非空 `mergedTreeRef`）、`src/bootstrap/integration-reconciliation-runtime.ts`（providerSessionId 绑定、owner typed 释放）；`tests/bootstrap/integration-reconciliation-runtime.test.ts`、`tests/application/integrate-work-package.test.ts`、`tests/adapters/git-integration.test.ts`（16 PASS） | PASS |
| IP-03 Merged-tree validation before serial integration：Independent package finishes later / Session or evidence mismatch / Canonical inputs are distinct from Validator repairs；Bounded integration reconciliation：Budget exhausted | 原会话、精确树、写入范围与轮次预算由上述 runtime/application 测试覆盖；`envelopeCheckedPaths` 共用范围规则，`coveredPaths` 不冒充 `filesModified` | PASS |
| IP-03 Delivery 整批 ack / 同批多结果 crash 重放 | `src/application/delivery/process-delivery.ts`（`batchAckReadiness` 整批守卫）、`src/application/reconciliation/replay-deliveries.ts`（两阶段）；`tests/application/process-delivery.test.ts`（mixed batch）、`tests/recovery/delivery-replay.test.ts`（同批两普通 role / 两 stale） | PASS |
| IP-04 execution-monitoring：授权不重置工作区 / 重启先对账 / Multiple active packages | `src/application/tui/view-model.ts:404`（完整 `activeWorkPackageIds` 不截断）、`src/interfaces/cli/status-command.ts:38,267`（status JSON schema3）；`tests/tui/status-json.test.ts`、`tests/tui/execution-settings.test.tsx`、`tests/tui/workspace.test.tsx` | PASS |
| IP-05 3.1 并发 1/2/3/5、准入竞态/崩溃、局部 unknown、Git 分叉/冲突/会话、额度降低 | `tests/application/advance-execution.test.ts`、`tests/coordination-store.test.ts`、`tests/recovery/*`、`tests/application/integrate-work-package.test.ts` | PASS |
| IP-05 3.2 真实隔离 Orca/Codex 多 Worker 闭环 | `/tmp/orca-cc-06-restart-readonly.log`（1 test PASS，13.16s，`EXIT:0`）；`artifacts/execution-concurrency/report-orca-cc-concurrency-06-resume.json`（approved 5，peakOverlap 2，`sameOriginalIdsApplied true` 且 Task/Dispatch 不变，verdict `deliverable` recordedAt 1791195727255）；`continuation-proof-06.json`（round 1 `validated`、`validationAttemptMatchesOriginal true`、sameUUID）；只读重启核验 | PASS |
| IP-05 3.2 TUI 三档画面与 PTY | `artifacts/execution-settings/README.md` 与 frames：120x40、80x24、50x40 对照已批准 DialogFrame；默认值保存与批准分离、返回与 resize 检查；现有 PTY 13 项通过 | PASS |
| IP-05 3.3 常规检查 | `pnpm test --maxWorkers=4` → 172 files PASS/7 skip，1950 tests PASS/14 skip（`/tmp/orca-concurrency-final-bounded-test.log`）；typecheck/lint/build exit0；`openspec validate restore-configurable-execution-concurrency --strict` → valid（`/tmp/orca-concurrency-final-spec-check.log`）；Git diff check PASS；acceptance 文件未 opt-in 时 skip 且 exit0 | PASS |

验收阶段完成的修复：无（验收期间未修改任何生产代码）。真实取证修正（fixture-only 测试取证、同 Scope 只读重启重跑）均发生在冻结 checkpoint 之前，属被验收对象内的一部分。

主 Agent 另以原 Planner 精确 SessionStart 所指的 transcript 做有界只读核验：notes 的真实 provider turn 为
09:21:33.416–09:23:45.216 UTC（Task `task_0f4ddc1b9511`，UUID `01a10b5e-4805-71d0-88bd-7df5188f7c5e`），
readme 为 09:21:51.624–09:24:21.263 UTC（Task `task_f128daad35cf`，UUID `01a10b5e-8ec9-7f33-9231-49d76b49d02e`）。
两者实际运行交集为 09:21:51.624–09:23:45.216 UTC，与公共区间证据一致，不把终端 ready 推断为 live。

## 限定审计

范围与结论（均为只读核对当前实现；无生产改动）：

1. **CAS lane 与未可见派发**：结论无缺陷。`reserve-work-package-lane` 在短事务内校验 lease/fencing、图代际与 `authorizationId/Version`，`occupied >= limits.maxActiveWorkPackages` 即结构化拒绝，同 operationId 幂等（`src/adapters/storage/coordination-store.ts:6695`）；释放要求确定结算意图（同文件 `:6741`）。未可见派发占位来自 `advance-execution.ts:337` 的 `worker-start:…:awaiting-observation`；容量与 lane 阻塞均为 lane-local（同文件 `:330`）。
2. **authorization / task 模型绑定**：结论无缺陷。Manifest 与配置 schema3、limits 闭集正安全整数（`src/domain/planning/budget-policy.ts:47`）；物化绑定钉住 `authorizationId/authorizationVersion/workerProfileRef`（`coordination-store.ts:5761`）；限定重授权保留 Graph/Run/权限/预算（`src/bootstrap/execution-runtime.ts:606,748`）；已接受结果按逻辑身份匹配（`src/domain/worker-result-verification.ts:34`）。
3. **merged-tree 与原 Session 证据**：结论无缺陷。复验精确树读回与声明一致且 validated 需非空树（`src/application/integration-reconciliation.ts:847`）；续接要求 `providerSessionId === original`（`src/bootstrap/integration-reconciliation-runtime.ts:382`）；owner 释放以 flat typed `terminal-show connected===false` + `workerStateLiveness===exited` + exactWorker/terminal/dispatch 三段核验（同文件 `:657-733`）。
4. **unknown lane 归属**：结论无缺陷。Git 步 unknown → `blockLane` 原 operationId 且不降级为 rejected（`src/application/integrate-work-package.ts:644`）；Delivery 整批确认守卫与两阶段重放（`src/application/delivery/process-delivery.ts:459`、`src/application/reconciliation/replay-deliveries.ts:199`）。
5. **TUI 副作用**：结论无缺陷。resize/reading 订阅仅重算 frame，不写状态（`src/interfaces/tui/app.tsx:1202`）；设置/状态栏/图标保存都在显式用户 handler 内走 CAS 端口；`status --json` schemaVersion 3 且活动包列表完整（`src/interfaces/cli/status-command.ts:38,267`）。

## 后续注意事项

- 真实证据来自单个隔离 fixture（`~/.cache/orca-acceptance/fixtures/orca-cc-concurrency-06`）与专用身份；不外推到其它环境或上游 Orca 其它版本。
- 验收测试对 Companion 私有 `work_package_lanes` 表做只读取证（test-only，通过 `readOnly` 连接，未新增生产 API，未访问 Orca 数据库）。
- 观察记录（不影响结论）：Resume 为单次发送；`docs/orca-compatibility.md` 中带日期的历史段落保留当时语义，已由顶部说明与当前约束声明区分。push 对账的错误 expected HEAD 边界已在现有 Git adapter 测试中断言为 unknown。
