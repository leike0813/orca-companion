本 change 是本轮已授权实现的补录。任务创建时未勾选，逐项核对现有实现和已运行证据后更新；勾选表示该实现切片及本地回归已完成，不表示正式 verification 或真实 Orca/provider 验收已完成。

下列 Vitest 命令均追加 `--maxWorkers=2 --testTimeout=30000 --hookTimeout=30000`；完整命令与行为证据见 implementation-plan §6。

## 1. 持久准入、预算与所有权

- [x] 1.1 完成 schema 20 的 Attempt/修复准入计费、结算 outcome/verdict 与幂等约束（IP-01/04）；运行 `pnpm exec vitest run tests/coordination-store.test.ts`。
- [x] 1.2 使确定失败 Retry 沿原 Task/contract/授权/profile 新建 Attempt，unknown 不重派且预算耗尽拒绝（IP-01）；运行 `pnpm exec vitest run tests/application/materialize-work-package.test.ts tests/application/advance-execution.test.ts`。
- [x] 1.3 强制单 Session Claim，规划/执行 cutover 原子转移并在目标持票冲突时回滚，重复 Claim 迁移不丢数据（IP-01/08）；运行 `pnpm exec vitest run tests/coordination-store.test.ts tests/application/route-map-service.test.ts`。

## 2. 重规划与旧成果

- [x] 2.1 接通 begin/drain/stop-reconcile/complete、取消刷新授权与原 Run 选择、候选 Cutover，恢复不重复迁移（IP-02）；运行 `pnpm exec vitest run tests/execution/replanning.test.ts tests/bootstrap/execution-authorization.test.ts tests/application/select-bound-run.test.ts`。
- [x] 2.2 生产读取 Git/Orca/原绑定采用事实，预检失败不创建 Run，lineage 延续消费且不复制完成状态（IP-03）；运行 `pnpm exec vitest run tests/bootstrap/plan-continuations.test.ts tests/execution/baseline-adoption.test.ts`。

## 3. Validator 与结果接纳

- [x] 3.1 接通原真实 Session 的 typed 验证/修复/复验、持久步骤 cursor、许可 receipt 与 finish 门禁（IP-04）；运行 `pnpm exec vitest run tests/bootstrap/validation-runtime.test.ts tests/bootstrap/foreground-validator-runtime.test.ts tests/application/run-validation.test.ts`。
- [x] 3.2 修复许可记录干净 HEAD，实际 Git 路径覆盖 committed/uncommitted/untracked 变更，并拒绝隐藏越界和无终结许可的成功结果（IP-04/05）；运行 `pnpm exec vitest run tests/bootstrap/foreground-validator-runtime.test.ts tests/application/record-worker-result.test.ts tests/bootstrap/execution-delivery.test.ts`。

## 4. 唤醒、对账与维护

- [x] 4.1 接通串行前台 pump，当前 Worker 问题/升级、失败及 Finalizer 结算按责任方准入稳定 Wake，前代与进度不唤醒（IP-05）；运行 `pnpm exec vitest run tests/bootstrap/execution-delivery.test.ts tests/bootstrap/execution-finalizer.test.ts tests/application/actionable-work.test.ts`。
- [x] 4.2 统一受控 Worker reply 的 Intent/receipt/unknown 对账，执行 Target 只被下一条普通用户 Prompt 激活（IP-05/08）；运行 `pnpm exec vitest run tests/adapters/orca-cli/reply-and-inbox.test.ts tests/application/runtime-guard.test.ts tests/bootstrap/foreground-execution-runtime.test.ts`。
- [x] 4.3 接通 provider 可选保活/压缩，保活有限且 Pause/Exit/fence 可取消，Shake 重启不重复、原历史保留（IP-06）；运行 `pnpm exec vitest run tests/bootstrap/foreground-planning-runtime.test.ts tests/adapters/checkpoint-store.test.ts tests/workflow/compaction.test.ts tests/application/compact-session.test.ts`。

## 5. 阻塞与凭据装配

- [x] 5.1 持久 Session blocked 与结构化原因，执行 Lease holder 同时阻塞 Scope，Resume 核验原 checkpoint 后才解除（IP-07）；运行 `pnpm exec vitest run tests/application/runtime-guard.test.ts tests/bootstrap/foreground-planning-runtime.test.ts`。
- [x] 5.2 CredentialStore 生产构造收敛到 bootstrap 注入，工厂/launcher 不自行 fallback，原保密及 CAS 合同保持（IP-07）；运行 `pnpm exec vitest run tests/adapters/chat-model-factory.test.ts tests/adapters/agents/codex-launch.test.ts tests/doctor.test.ts tests/bootstrap/doctor-model-configuration.test.ts`。

## 6. 文档与本地验证

- [x] 6.1 补齐 proposal/design/implementation-plan/delta specs，记录已完成任务，更新并行与模型 binding 归属及当前 change（IP-08）；核对三份主规格已同步部分与九份 delta 对应关系。
- [x] 6.2 完成全量本地回归及最终修正定向复验，运行 `pnpm typecheck`、`pnpm lint`、`pnpm build` 与 `git diff --check`（IP-09）；全量命令为 `pnpm exec vitest run --maxWorkers=2 --testTimeout=30000 --hookTimeout=30000`，明确保留 14 项跳过与后续定向验证边界。
- [x] 6.3 核验本 change artifact 依赖闭包、文件/Scenario/IP 映射与命令路径，运行 `openspec validate complete-coordination-runtime-wiring --strict`（IP-08/09）。

正式 verification、固定最终实现 checkpoint、真实隔离集成验收、主规格剩余 delta 同步与 archive 不属于本次补录的已完成任务。
