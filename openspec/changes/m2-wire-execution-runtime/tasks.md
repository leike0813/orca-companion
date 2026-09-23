## 1. 授权与恢复入口

- [ ] 1.1 按 IP-01 接通完整 Manifest 审阅、显式批准和当前图切换；运行 `pnpm exec vitest run tests/bootstrap/execution-authorization.test.ts`。
- [ ] 1.2 按 IP-02 将前台 Session 与 `startCompanionStartup` 收敛为一次租约取得、执行期对账和 Resume 门；运行 `pnpm exec vitest run tests/bootstrap/foreground-execution-runtime.test.ts tests/bootstrap/startup-reconciliation.test.ts`。

## 2. 串行 Worker 生命周期

- [ ] 2.1 按 IP-03 接通单步 Frontier/角色物化与执行态受控工具，稳定签发每个副作用的 OperationId；运行 `pnpm exec vitest run tests/application/advance-execution.test.ts`。
- [ ] 2.2 按 IP-04 接通当前 Run 的 Delivery、Specification Admission、Validator 同 Session 修复与 Worker Session Recovery；运行 `pnpm exec vitest run tests/bootstrap/execution-delivery.test.ts tests/application/run-validation.test.ts`。

## 3. 集成与项目终态

- [ ] 3.1 按 IP-05 修正 IC-08 Git 分目标读回合同并接通受控 Git adapter；运行 `pnpm exec vitest run tests/application/integrate-work-package.test.ts tests/adapters/git-integration.test.ts`。
- [ ] 3.2 按 IP-06 接通新只读 Finalizer Session、运行前后工作区观察和独立 verdict；运行 `pnpm exec vitest run tests/bootstrap/execution-finalizer.test.ts tests/application/finalize-project.test.ts`。

## 4. 控制、真实验证与文档

- [ ] 4.1 按 IP-07 接通 exact Worker stop verdict、原 ID 对账和提交后语义事件，更新合同与能力说明；运行 `pnpm exec vitest run tests/adapters/worker-stop.test.ts tests/coordination/scope-control.test.ts`。
- [ ] 4.2 按 IP-08 在显式隔离项目及专用 Orca 身份中运行真实 MiniMax-M3 执行闭环（含一次 Recovery 或明确 blocker），并执行全量门禁；命令见 implementation-plan 第 6 节。本任务通过后仅为原 M2 的 5.2/5.3 解除阻塞，不在本 change 勾选它们。
