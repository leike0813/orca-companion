## 1. 基线与前驱接缝核验

- [x] 1.1 核验直接前驱已归档且四个 capability 主规格存在：运行 `openspec list --json` 确认 active 列表不含该 change，检查 archive 快照，并运行 `openspec list --specs --json`（IP-B1）
- [x] 1.2 核验五个冻结接缝符号仍存在且语义未漂移；运行 `rg -n 'Worker Result|Session Binding|Spec Binding|task-contract|worker-liveness' src/domain src/application`（IP-B1）

## 2. 结果核验与状态模型

- [x] 2.1 实现 IP-B1 的代际与角色核验纯函数及三个独立状态类型；运行 `pnpm vitest run tests/domain/worker-result-verification.test.ts tests/domain/work-package-status.test.ts`
- [x] 2.2 实现 IP-B1/IP-B2：在 `src/application/delivery/process-delivery.ts` 固定读取不 ack、核验、去重、Orca 记录/回读、本地去重引用、ack 顺序；Accepted Worker Result 正文只归 Orca。session 丢失时仅新建独立 Dispatch/Attempt 或形成 blocker；运行 `pnpm exec vitest run tests/application/process-delivery.test.ts tests/application/record-worker-result.test.ts tests/coordination-store.test.ts`

## 3. 验证与修复

- [x] 3.1 实现 IP-B3 的 Validator 同一真实 Session 生命周期与修复范围判定；session 丢失时停止当前 Attempt，并断言仅形成 blocker 或交给正常 Retry Attempt；运行 `pnpm vitest run tests/application/run-validation.test.ts tests/domain/repair-scope.test.ts`
- [x] 3.2 实现 IP-B4 的证据失效与验证预算耗尽阻塞；运行 `pnpm vitest run tests/application/run-validation.test.ts`

## 4. 集成与收尾

- [x] 4.1 实现 IP-B5 的 Git 集成策略核验与固定顺序 Integration Operation；运行 `pnpm vitest run tests/domain/git-integration-policy.test.ts tests/application/integrate-work-package.test.ts`
- [x] 4.2 实现 IP-B6 的派发前 Unattributed Drift 检查；运行 `pnpm vitest run tests/application/dispatch-guard.test.ts`
- [x] 4.3 实现 IP-B7 的只读 Finalizer 派发与 Delivery Verdict 接受；运行 `pnpm vitest run tests/application/finalize-project.test.ts tests/domain/delivery-verdict.test.ts`

## 5. 全部检查与交接

- [x] 5.1 运行全量检查并确认无回归；运行 `pnpm typecheck && pnpm lint && pnpm test`
- [x] 5.2 固定实现 HEAD 并整理修改文件清单、覆盖的 Requirement/Scenario 与偏差，交给验收 Agent；运行 `git status --short` 与 `git rev-parse HEAD`
