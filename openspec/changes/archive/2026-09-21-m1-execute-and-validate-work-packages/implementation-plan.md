# Implementation Plan

## 1. 实施基线与权威来源

**Baseline mode: predecessor-contract**

- 直接前驱：`m1-admit-work-package-specifications`
- 规划提交：`cd29e2bcd8b0278d34ae19db64cb8ebdaf149279`（本 change 起草时的仓库 HEAD）
- 权威来源：本 change 的 `specs/execution/work-package-delivery/spec.md`、`specs/execution/validation/spec.md`、`specs/execution/git-integration/spec.md`、`specs/execution/project-finalization/spec.md`，`docs/architecture.md` 的 FLOW-01 与 FLOW-03，以及 `docs/interface-contracts.md` 的 IC-01、IC-02、IC-03、IC-05–IC-08。

### 合同 create/extend/consume

| 关系 | 合同与 canonical symbols | 漂移检查 |
|---|---|---|
| Create | IC-08：`processDelivery`、`verifyWorkerResult`、`runValidation`、`integrateWorkPackage`；FLOW-03 | 正常 Delivery pipeline 只在此处实现一次；M0 只提供 transport |
| Extend | IC-03：Delivery 去重/引用与 Verdict 最小记录 | 本地不得保存 Accepted Worker Result 正文 |
| Consume | IC-01、IC-02、IC-05、IC-06、IC-07、FLOW-01 | 直接复用 operation、backend、authorization、spec 与 Worker 类型 |

若正常 Delivery 顺序、Accepted Worker Result 权威归属或 Validator session 语义漂移，停止实施并先更新架构合同。

### 1.1 前驱冻结接缝

| 接缝 | 前驱提供的契约 | 本 change 的使用方式 |
|---|---|---|
| Task Envelope | 固定 Work Package、角色、worktree、输入、Scope Envelope、authority、预算与期望证据 | 作为验证与集成的授权输入；不重新定义字段 |
| Worker Result / Question / Escalation / Evidence | 结构与候选语义，模型填写字段在边界被丢弃 | 作为本 change 结果核验与交付结论的输入载荷 |
| Session Binding | Specification Planner、Implementation、Validator、Finalizer 的角色、harness session 身份、可引用 transcript 与不可用阻塞 | 用于 Validator 同 session 验证链与 Finalizer 只读会话核验 |
| liveness / terminal facts | live / exited / unverifiable、匹配 Task/Dispatch/Attempt/角色/Session Binding 的终态，以及中断 Segment 前置事实 | 用于判断结算、blocker 与正常 Retry Attempt 是否安全；不提供 Recovery |
| Spec Binding | 内容摘要与版本绑定的接纳记录 | 作为结果核验中的 revision 事实来源 |

### 1.2 实施前漂移检查

开始编辑前必须依次确认，任一不成立即停止并回到规划：

1. `openspec list --json` 中不再出现 `m1-admit-work-package-specifications`，其 archive 快照存在，且 `openspec list --specs --json` 中存在 `execution/work-package-admission`、`execution/specification-admission`、`workers/task-contracts`、`workers/harness-binding` 的主规格。
2. 实际文件中存在第 1.1 节五个接缝对应的符号；符号改名或字段语义漂移即停止。
3. 前驱的 `src/domain/worker-report.ts` 仍提供四种报告的判别联合，且 `src/application/ports/specification-provider.ts` 仍提供 content 摘要能力。
4. `cd29e2bcd8b0278d34ae19db64cb8ebdaf149279` 仍在当前分支历史中。

## 2. 复用与接缝

| IP-ID | 现有或前驱文件与符号 | 复用方式 | 禁止复制的事实 |
|---|---|---|---|
| IP-B1 | 前驱 `worker-report.ts`、`specification-admission.ts` | 复用报告类型与 Spec Binding 作为核验输入 | 不复制报告 schema 校验入口 |
| IP-B2 | M0 Delivery 读取/确认原语、`ExecutionBackend` 的 `task-update`、Branch Coordination Store migration | Orca 记录 Accepted Worker Result；本地只保存 Delivery 去重键与结果引用 | 不在本地保存 Accepted Worker Result 正文，不复制预算状态机 |
| IP-B3 | 前驱 `worker-liveness.ts`、`session-binding.ts` | 复用四角色精确绑定、可引用 transcript、终态核验与 Segment 前置事实 | 不按输出推测会话，不从 Segment 恢复，不生成 Capsule、不记录 Recovery Budget |
| IP-B4 | 前驱 `evaluateDispatchCandidate` | 在本 change 的派发前追加 drift 检查后调用 | 不复制前置条件集合 |
| IP-B5 | `src/adapters/orca-cli/orca-backend.ts` 与 `src/application/ports/execution-backend.ts` | 复用 `startWorker`、`task-update`、Delivery transport、receipt 与拒绝码透传 | 不新建平行 backend 模块 |

## 3. 代码变更映射

| IP-ID | Task | Requirement/Scenario | 文件与符号 | 精确变化 | 不得改变 |
|---|---|---|---|---|---|
| IP-B1 | T1 | `Worker 报告在身份与代际核验后才成为 Accepted Worker Result` / 两个 Scenario；`实现完成、验证通过与项目可交付是三个独立事实` / 两个 Scenario；`Retry Attempt 保持 WorkerTask、contract 与 revision 不变` / 全部四个 Scenario | `src/domain/worker-result-verification.ts`、`src/domain/work-package-status.ts`；`src/application/record-worker-result.ts` | 纯函数核验代际与角色；三个独立状态类型；session 丢失时只在正常条件下新建 Dispatch/Attempt 并保留 contract，否则形成 blocker | 不由实现状态推出验证状态，不归零预算，不把新 session 当作原 Attempt 的恢复 |
| IP-B2 | T2 | `Worker 报告在身份与代际核验后才成为 Accepted Worker Result` / 两个 Scenario | `src/application/delivery/process-delivery.ts`、`src/application/record-worker-result.ts`；修改 BranchCoordinationStore port/schema/adapter | 固定 read-without-ack → validate → dedupe → Orca accept/readback → persist dedupe/ref/readback → ack；旧代际只记历史引用 | 不在本地保存结果正文，不先 ack，不重复实现 M0 transport |
| IP-B3 | T3 | `Validator 以独立角色验证并复用同一真实会话` / 三个 Scenario；`修复限定在授权范围与修复预算内，且证据与预算归属不被掩盖` / 前两个 Scenario | `src/application/run-validation.ts`、`src/domain/repair-scope.ts` | 循环「验证—范围内修复—复验」；每一步核验同一 Session Binding；session 丢失时停止当前 Attempt 并形成 blocker 或交给 IP-B1 的正常 Retry Attempt | 不让实现者自验，不切换 session 继续原 Attempt，不生成 Capsule、不消费 Recovery Budget |
| IP-B4 | T4 | `修复限定在授权范围与修复预算内，且证据与预算归属不被掩盖` / 后两个 Scenario | `src/application/run-validation.ts`（证据与预算段） | 修复触及覆盖路径即失效既有证据并要求新证据；验证预算耗尽即阻塞 | 不以验证预算替代实现预算 |
| IP-B5 | T5 | `集成以 Validator 接受的结果为前提` / 两个 Scenario；`集成操作限制在授权范围内` / 两个 Scenario | `src/application/integrate-work-package.ts`、`src/domain/git-integration-policy.ts` | 固定顺序的 Integration Operation 与 policy 核验 | 不使用 shell，不做 force-push 或历史改写 |
| IP-B6 | T6 | `未归属的 canonical 分支变化暂停派发` / 单个 Scenario | `src/application/dispatch-guard.ts` | 派发前比对该 HEAD 与最近集成记录，无法归属即暂停 | 不复制前驱前置条件 |
| IP-B7 | T7 | `Finalizer 使用新的只读项目级会话` / 两个 Scenario；`Delivery Verdict 由独立结论构成并被确定性接受` / 全部三个 Scenario | `src/application/finalize-project.ts`、`src/domain/delivery-verdict.ts` | 只读项目级派发与结论接受；不一致时阻塞 | 不改写图、结果、Git 历史或 Intent |

## 4. 调用与副作用顺序

结果结算：读取 Delivery 但不确认 → 核验代际与角色（IP-B1）→ 查去重键 → accepted 时通过 Orca `task-update`/receipt 路径记录并回读 Accepted Worker Result → 本地写去重键与引用并回读 → 确认 Delivery → 推进验证角色（IP-B2）。任一步失败均不确认。

验证：核验 Session Binding → 派发 Validator → 收集结论 → 需要修复时核验范围与预算（IP-B3）→ 修复触及证据范围则失效（IP-B4）→ 以同一 Session Binding 复验 → session 丢失或预算耗尽则阻塞；只有满足正常 Retry Attempt 条件时才新开 Dispatch/Attempt。

集成：核验已接受结果与 Lease → 核验 policy → 持久化 Intent 与 expected HEAD → commit → 集成 canonical → 推送获批 ref → 回读 → 完成 Intent（IP-B5）。

收尾：全部通过且无未决工作 → 派发只读 Finalizer → 归一 Delivery Verdict → 核验并记录结论（IP-B7）。

失败处理：任何 mutation 返回 unknown 时以原 OperationId 对账；不确定则阻塞对应 lane。旧代际报告只写入历史，不推进。Worker session 丢失不触发 Recovery、Capsule 或 Recovery Budget；它只产生 blocker，或按 IP-B1 的正常 Retry Attempt 开始独立新 Attempt。

## 5. Schema、状态与持久化落实

- Accepted Worker Result 正文与 Task/Dispatch/Attempt/Delivery/receipt 归 Orca；Branch Coordination Store 通过版本化 migration 增加 Delivery 去重键、`AcceptedWorkerResultRef` 与分支级 Delivery Verdict 的最小记录，Integration Operation 仍复用 Operation Intent。
- 证据失效与修复预算计数写入既有预算状态记录，键沿用前驱定义的 WorkPackageId 与 WorkerTask 身份。
- 边界载荷（结果、结论、Integration 请求）在进入领域层前做运行时 schema 校验；校验失败按拒绝处理。
- migration 可重入并保留前驱数据；无权限变更；Git 侧只产生常规 commit 与已获批 ref 的更新。

## 6. 验收证据矩阵

| Requirement/Scenario | IP-ID | 测试文件 | Fixture/前置条件 | 关键断言 | 可运行命令 |
|---|---|---|---|---|---|
| 当前代际报告通过核验后记录 | IP-B1/B2 | `tests/domain/worker-result-verification.test.ts` | 代际一致的报告 | 判定为 accepted 并写入记录 | `pnpm vitest run tests/domain/worker-result-verification.test.ts` |
| 旧代际报告不推进当前流程 | IP-B1 | `tests/domain/worker-result-verification.test.ts` | 前一代际 Run 的报告 | 判定为 stale，零生命周期推进 | `pnpm vitest run tests/domain/worker-result-verification.test.ts` |
| 权威结果与本地引用落盘后确认 | IP-B2 | `tests/application/process-delivery.test.ts` | 当前代际 Delivery，Orca 与本地写入成功 | 顺序为 read → validate → dedupe → Orca accept/readback → local ref/readback → ack；本地无结果正文 | `pnpm exec vitest run tests/application/process-delivery.test.ts` |
| 接受结果或本地引用未确定时不确认 | IP-B2 | `tests/application/process-delivery.test.ts` | 各持久化步骤失败或 unknown | Delivery 未 ack、生命周期未推进、沿用原 OperationId | `pnpm exec vitest run tests/application/process-delivery.test.ts` |
| 重放已结算 Delivery 不重复记录结果 | IP-B2 | `tests/application/process-delivery.test.ts` | 去重键与结果引用已存在 | 回读核验后 ack，Orca 与本地均无第二份正文 | `pnpm exec vitest run tests/application/process-delivery.test.ts` |
| 实现完成不表示验证通过 | IP-B1 | `tests/domain/work-package-status.test.ts` | 实现完成、未验证 | 验证状态保持未验证，且不存在推导函数 | `pnpm vitest run tests/domain/work-package-status.test.ts` |
| 全部任务通过不自动表示可交付 | IP-B1 | `tests/domain/work-package-status.test.ts` | 全部验证通过 | 交付状态仍为未收尾 | `pnpm vitest run tests/domain/work-package-status.test.ts` |
| 结论性失败后新开尝试 | IP-B1 | `tests/application/record-worker-result.test.ts` | 结论性失败的 Attempt | 新 Dispatch/Attempt 与既有 contract 一致 | `pnpm vitest run tests/application/record-worker-result.test.ts` |
| 重开不重置预算 | IP-B1 | `tests/application/record-worker-result.test.ts` | 已消耗预算 | 预算计数不变 | `pnpm vitest run tests/application/record-worker-result.test.ts` |
| session 丢失时只走正常重试或阻塞 | IP-B1 | `tests/application/record-worker-result.test.ts` | session 丢失，分别满足与不满足重试条件 | 分别新建独立 Dispatch/Attempt 或形成 blocker；均未生成 Capsule、未记录 Recovery Budget、未续接原 Attempt | `pnpm vitest run tests/application/record-worker-result.test.ts` |
| 需要改变 contract 时不予重试 | IP-B1 | `tests/application/record-worker-result.test.ts` | 需要 contract 变化 | 返回需要契约修订的结论 | `pnpm vitest run tests/application/record-worker-result.test.ts` |
| 独立角色执行验证 | IP-B3 | `tests/application/run-validation.test.ts` | 实现完成的 Work Package | 派发独立 Validator 角色 | `pnpm vitest run tests/application/run-validation.test.ts` |
| 修复与复验复用同一会话 | IP-B3 | `tests/application/run-validation.test.ts` | 一次修复后复验 | 验证、修复、复验全程匹配同一 Session Binding | `pnpm vitest run tests/application/run-validation.test.ts` |
| Validator session 丢失时不伪装恢复 | IP-B3 | `tests/application/run-validation.test.ts` | 验证链中 session 丢失 | 当前 Attempt 停止并形成 blocker，或交给正常 Retry Attempt；未生成 Capsule、未消费 Recovery Budget | `pnpm vitest run tests/application/run-validation.test.ts` |
| 范围内修复后复验通过 / 越界修复被拒绝 | IP-B3 | `tests/domain/repair-scope.test.ts` | 范围内与越界两类改动 | 分别接受与要求 Escalation | `pnpm vitest run tests/domain/repair-scope.test.ts` |
| 修复后旧证据失效 | IP-B4 | `tests/application/run-validation.test.ts` | 覆盖被改动路径的证据 | 该证据判定失效并要求重取 | `pnpm vitest run tests/application/run-validation.test.ts` |
| 验证预算耗尽后阻塞 | IP-B4 | `tests/application/run-validation.test.ts` | 修复预算耗尽 | 阻塞并报告预算耗尽 | `pnpm vitest run tests/application/run-validation.test.ts` |
| 已接受结果才可集成 / 未验证结果不集成 | IP-B5 | `tests/application/integrate-work-package.test.ts` | 已验证与仅实现完成两种状态 | 分别允许与零 Git 副作用 | `pnpm vitest run tests/application/integrate-work-package.test.ts` |
| 越界 Git 操作被拒绝 | IP-B5 | `tests/domain/git-integration-policy.test.ts` | 未获批 remote/ref、force-push | 拒绝并报告越界部分 | `pnpm vitest run tests/domain/git-integration-policy.test.ts` |
| 授权内的普通集成执行 | IP-B5 | `tests/application/integrate-work-package.test.ts` | 授权内集成请求 | 执行并核验 expected HEAD | `pnpm vitest run tests/application/integrate-work-package.test.ts` |
| 检测到未归属变化后暂停派发 | IP-B6 | `tests/application/dispatch-guard.test.ts` | HEAD 前进且无对应 Intent | 返回暂停结论且无 mutation | `pnpm vitest run tests/application/dispatch-guard.test.ts` |
| 全部通过后派发只读 Finalizer / 存在未决工作时不予收尾 | IP-B7 | `tests/application/finalize-project.test.ts` | 全部通过与存在未决交互 | 分别派发只读会话与保持未收尾 | `pnpm vitest run tests/application/finalize-project.test.ts` |
| 接受可交付结论 / 阻塞结论保持不可交付 | IP-B7 | `tests/domain/delivery-verdict.test.ts` | 两类 Delivery Verdict | 分别记录可交付与记录阻塞项 | `pnpm vitest run tests/domain/delivery-verdict.test.ts` |
| 发现不一致时阻塞 | IP-B7 | `tests/domain/delivery-verdict.test.ts` | 证据与既有结果冲突 | 报告不一致并阻塞 | `pnpm vitest run tests/domain/delivery-verdict.test.ts` |

全量检查：`pnpm typecheck && pnpm lint && pnpm test`。

## 7. 文件清单与升级条件

新增文件：

- `src/domain/worker-result-verification.ts`
- `src/domain/work-package-status.ts`
- `src/domain/repair-scope.ts`
- `src/domain/git-integration-policy.ts`
- `src/domain/delivery-verdict.ts`
- `src/application/record-worker-result.ts`
- `src/application/delivery/process-delivery.ts`
- `src/application/run-validation.ts`
- `src/application/integrate-work-package.ts`
- `src/application/dispatch-guard.ts`
- `src/application/finalize-project.ts`
- `tests/domain/worker-result-verification.test.ts`
- `tests/domain/work-package-status.test.ts`
- `tests/domain/repair-scope.test.ts`
- `tests/domain/git-integration-policy.test.ts`
- `tests/domain/delivery-verdict.test.ts`
- `tests/application/record-worker-result.test.ts`
- `tests/application/process-delivery.test.ts`
- `tests/application/run-validation.test.ts`
- `tests/application/integrate-work-package.test.ts`
- `tests/application/dispatch-guard.test.ts`
- `tests/application/finalize-project.test.ts`

修改文件：

- `src/application/ports/execution-backend.ts`、`src/application/ports/branch-coordination-store.ts`（结果读取、去重引用、集成与收尾）
- `src/adapters/orca-cli/orca-backend.ts`（补充 Dispatch/Attempt 事实、`task-update` 与 receipt 回读，不新增平行 backend）
- `src/adapters/storage/schema.ts`、`src/adapters/storage/coordination-store.ts`（Delivery 去重引用与 Verdict migration）

受保护、不得修改：`openspec/schemas/**`、`openspec/config.yaml`、`AGENTS.md`、`CONTEXT.md`、`package.json` 的依赖段、`references/orca`。

升级条件（必须停下并询问）：

- 前驱接缝任一字段或 requirement 名称漂移；
- 需要新增依赖、本计划未声明的持久化记录或未登记的 Orca 调用形态；
- 需要 force-push、历史改写、发布、部署或越界 remote/ref；
- 需要以 shell 代替 `ExecutionBackend`；
- 需要跨 session 继续原 Validation Attempt、生成 Capsule 或记录/消耗 Recovery Budget；
- 任一 Requirement/Scenario 无法在允许文件范围内满足。

## 8. 验收 Agent 授权与限定审计

验收范围限定为本 change 列出的新增与修改文件、上述测试文件，以及 `openspec/changes/m1-execute-and-validate-work-packages/` 下的规划产物。验收可执行 `pnpm typecheck`、`pnpm lint`、`pnpm test` 与矩阵中的单文件命令。

受保护的语义边界（验收不得单方面修改）：Accepted Worker Result 的核验维度集合、三个事实的独立性、Validator 同 session 验证链、session 丢失只走 blocker/正常 Retry Attempt、修复范围与预算单调性、Git 集成授权边界、交付结论的只读性。

需要限定审计的标签：`oracle-source-of-truth`（旧代际报告是否确实不推进）、`transaction-boundary`（Intent 与 mutation 顺序）、`permission-escalation`（越界修复与越界 Git 操作是否被拒绝）。
