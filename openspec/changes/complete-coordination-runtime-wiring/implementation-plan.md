# Implementation Plan

## 1. 实施基线与权威来源

基线模式：`predecessor-contract`。直接前驱：`restore-configurable-execution-concurrency`，已位于 `openspec/changes/archive/2026-10-05-restore-configurable-execution-concurrency/`；规划/修复基线 HEAD 为 `88d908ae2d5e7d798e207875242df72394cee274`。

本文件补录用户已授权实现，当前代码仍在工作区，HEAD 不是最终实现 checkpoint。补录前已核验前驱归档、主规格及当前 diff；后续修改开始前再次核验 `git rev-parse HEAD`、`git diff --check`、前驱目录和以下冻结接缝，发生实质漂移时先修订设计。

| 冻结接缝 | 前驱合同 | 本轮允许的扩展 |
|---|---|---|
| IC-03 store | CAS、唯一 Lease holder、schema 19、包级 reservation、Task 固定授权/profile | schema 20 的 Claim/blocked/结算/预算/Validator cursor 事实 |
| IC-05/07/08 | Manifest v3、每次物化一个角色 Task、包内角色串行、并行额度、原真实 Session | 有限 Retry、Validator 步骤许可及已接受结果核验 |
| IC-09/10 | 精确 Session Segment、原 Attempt 恢复、append-only graph 与代际采用 | 生产 Replanning/Cutover/取消入口与可信采用读回 |
| IC-04/11/12 | 增量 checkpoint、稳定 Wake、只读投影、渲染无副作用 | pump/owner-scoped Wake、Shake 产物与既有 blocker 投影 |
| IC-14 | 单用户凭据文件、opaque ref、文件锁/CAS | bootstrap 单实例注入，无新增凭据路径 |

权威输入为 proposal、全部 delta specs、design D-01—08，以及 `CONTEXT.md`、`AGENTS.md`、当前 architecture/interface-contracts。Replanning、压缩、CredentialStore 的既有主规格是本轮修复目标，不新建近似 capability。

## 2. 复用与接缝

| IP-ID | 现有或前驱文件与符号 | 复用方式 | 禁止复制的事实 |
|---|---|---|---|
| IP-01 | `BranchCoordinationStore.transact`、materialization/settlement/Claim 记录 | 原子计费、唯一 Claim、handoff rollback；D-04/05 | 第二套预算或所有权 |
| IP-02 | `beginReplanningTransition`、`completeReplanningTransition`、`cancelReplanningTransition`、`commitGenerationCutover` | 真实事实装配、完整授权与稳定 Run 选择；D-01 | bootstrap 业务状态机 |
| IP-03 | `recordPlanContinuations`、`consumedBudgetForWorkPackage`、图历史 | 可信采用预检与 lineage；D-02 | 旧完成状态或别包集成证明 |
| IP-04 | `runValidation`、`createValidatorStepRunner`、`record-worker-result`、Git observer | typed 同会话步骤与实际路径证明；D-03/04 | 自述范围、新 Session 冒充原验证 |
| IP-05 | `projectActionableWork`、`admitWakeBatch`、Intent/receipt、Delivery pipeline | pump、Worker/结算 Wake、统一受控答复；D-06 | 通用 inbox 或 exactly-once 宣称 |
| IP-06 | `runMaintenanceCycle`、native/Capsule/Shake、checkpoint artifact | 有限保活与持久 Shake；D-07 | keepalive 伪装模型步骤 |
| IP-07 | runtime guard、原 checkpointer、bootstrap CredentialStore | durable blocker、原历史复验和单实例注入；D-08 | 空历史替代或 adapter 凭据 fallback |
| IP-08 | 现有主规格、architecture、interface-contracts、TUI 只读 DTO | 并行/存储归属同步与本 change；D-05/08 | UI 自行派发或重新设计 |
| IP-09 | Vitest、真实 SQLite/Git fixtures、现有生产宿主测试 | 整体验证与限定审计 | 用跳过或前驱真实探针替代本轮验收 |

## 3. 代码变更映射

路径采用 repo-root 相对路径；花括号代表列出的独立文件，§7 逐项记录完整 allowlist。共享 store 与 foreground runtime 由主代理串行整合，无重叠写入委派。

| IP-ID | Task | Requirement/Scenario | 文件与符号 | 精确变化 | 不得改变 |
|---|---|---|---|---|---|
| IP-01 | 1.1—1.3 | `Implementation Attempt 的准入消费有限且幂等` 全部；Claim/两类 handoff 的冲突及转移 Scenario | `src/adapters/storage/{schema,coordination-store}.ts`、`src/application/ports/branch-coordination-store.ts`、`src/application/{materialize-work-package,execution/advance-execution,execution/execution-view,planning/route-map-service}.ts` | 新 Attempt/修复步骤原子计费，重放幂等；失败结论字段；Claim 唯一与交接整体回滚；有效预算包括原锚定和 lineage | 已批准额度、固定 Task/profile、旧消费量 |
| IP-02 | 2.1 | `execution/replanning` 三个 Requirements 全部 Scenario | `src/application/execution/{replanning-service,select-bound-run}.ts`、`src/application/planning/lease-handoff.ts`、宿主 graphEvolution/review/approve 装配、tool DTO | drain/stop-reconcile、完整重新批准、原 Run 选择、候选 Cutover | 前代历史、unknown 与 liveness 三值 |
| IP-03 | 2.2 | `旧成果必须按采用规则进入并由 lineage 继承已消耗额度` 全部 | `src/bootstrap/plan-continuations.ts`、`src/application/execution/baseline-adoption.ts`、`src/application/planning/graph-history.ts`、`src/domain/planning/{execution-graph,graph-compiler}.ts` | Orca 结果/Git/同包集成证明先预检，再创建 Run/登记；Envelope 带只读材料引用 | 新代际新身份与新 worktree |
| IP-04 | 3.1—3.2 | `execution/validation` 全部；当前 Validator 完成并修复复验、工具状态不是项目改动 | `src/bootstrap/{validation-runtime,execution-runtime,foreground-planning-runtime}.ts`、`src/application/{run-validation,record-worker-result}.ts`、`src/adapters/git/baseline-observer.ts`、`src/domain/worker-report.ts` | 原会话 typed 指令与 cursor、修复许可 HEAD、Git 实际路径/新证据、finish/failed 结算 | Controller 才接受结果、Scope Envelope |
| IP-05 | 4.1—4.2 | `Resumption requires admitted Actionable Work` 全部；handoff Prompt 门 | `src/application/coordination/reply-worker-question.ts`、`src/application/coordinator/{actionable-work,user-message}.ts`、`src/application/delivery/process-delivery.ts`、`src/adapters/orca-cli/{operation-catalog,reconcile-query}.ts`、宿主 pump/settlement Wake | 精确发送方核验、先准入/写后核验再 ack、持久 Verdict/failed Wake、原 Reply receipt 对账 | 不唤醒进度/旧 Attempt，不换 ID 重试 |
| IP-06 | 4.3 | `Suspension and best-effort maintenance lane`、`Native-first compaction with opaque native window and explicit degradation` 全部 | `src/application/coordinator/{maintenance-lane,compact-session}.ts`、`src/adapters/storage/checkpoint-store.ts`、`src/workflow/coordinator/compaction.ts`、`src/domain/coordinator/session-state.ts`、model factory、宿主维护装配 | finite 8 cycles、可信 interval、暂停/退出/fence abort、provider 可选压缩、持久 Shake IDs | 原文保留、历史不进维护写入 |
| IP-07 | 5.1—5.2 | `Committed model step and durable resumption identity` 全部；`User credential store with isolated secrets` 全部 | `src/application/coordinator/runtime-guard.ts`、`src/bootstrap/{foreground-planning-runtime,doctor,startup,coordinator-runtime}.ts`、`src/adapters/agents/{chat-model-factory,codex-launch}.ts` | Session/Lease holder Scope blocker、原 checkpoint 可恢复才 Resume；bootstrap 注入凭据 | 既有锁/CAS/权限、保密与模型绑定 |
| IP-08 | 6.1 | 三处并行 delta 全部；各 delta 已明确的行为边界 | `AGENTS.md`、`docs/{architecture,interface-contracts}.md`、三个已改主 spec、本 change、`openspec/config.yaml`；现有应用/接口 DTO | 消除单活动包漂移，记录 schema 20、配置 binding、审阅目标与当前 change | 默认 3 可配置、同包/集成串行、原型布局 |
| IP-09 | 6.2—6.3 | 所有本轮 delta Requirement/Scenario 与上列既有修复合同 | §6 命令、§7 测试 allowlist、限定审计 | 记录全量与最后修正的针对性证据，核验 change 严格校验 | 未运行真实集成不记通过 |

## 4. 调用与副作用顺序

派发：可信 Scope/owner/图/授权 → 选择候选 → CAS 物化绑定及预算消费 → 原 Intent → 外部操作 → 回读/结算。拒绝不产生派发；unknown 保留身份并冻结对应 lane。

Validator：精确 Session/步骤引用先持久化 → 验证判定 → 修复准入计费及干净 HEAD Intent → 受控 reply → 实际 Git 变化核验 → 同会话复验/finish → 接受结果与回读 → 整批 Delivery ack。异值重放或证据不可证明阻塞，不替换会话。

Replanning：begin 阻止新派发 → 持续收尾/对账或用户 stop 请求 → 真实 drain → 释放 Lease/新 Cycle → owner Wake → 新候选预检与完整授权 → 原子 Cutover。取消前重新核验原 Run 并重新批准；Cutover 后不能恢复前代。

Wake：读取但不 ack → 精确来源/发送方与 owner 核验 → bounded projection → 稳定 batch checkpoint → source admission/中断补齐 → 确认可消费后 ack → 控制状态和交接门允许才运行模型。

## 5. Schema、状态与持久化落实

schema 20 / checkpoint artifacts schema 3 的迁移边界按 D-03—08。迁移拒绝重复 Claim 并回滚；历史 null 不推断。唯一 store 拥有预算与所有权，checkpointer 拥有增量会话/Wake/压缩产物，Orca/Git 保持运行事实权威。

Repair cursor 原 UUID、原初消费量和消息集合不可变/只追加；终结问题身份一经保存不能替换。预算不同授权引用兼容仅在同图/代际/Run 且该预算上限不变时成立，消费计数原锚定不改写。Finalizer 没有 Specification Unit，物化与结果按明确角色允许空 binding，不能借普通角色的空字段绕过准入。

## 6. 验收证据矩阵

表内“全部”包含该 Requirement 下复制保留与新增的所有 Scenario。命令使用 `--maxWorkers=2 --testTimeout=30000 --hookTimeout=30000` 控制本机资源；测试选择是稳定行为边界，不精确锁定日志或提示文本。

| Requirement/Scenario | IP-ID | 测试文件 | Fixture/前置条件 | 关键断言 | 可运行命令 |
|---|---|---|---|---|---|
| 实现预算全部、Claim 全部、两类 handoff 转移/冲突 | IP-01/05 | coordination-store、materialize-work-package、advance-execution、route-map-service | SQLite v19/v20、原 Task/新 Attempt、并发 CAS | 有限消费、原身份重试、索引迁移 rollback、交接全或无 | `pnpm exec vitest run --maxWorkers=2 --testTimeout=30000 --hookTimeout=30000 tests/coordination-store.test.ts tests/application/materialize-work-package.test.ts tests/application/advance-execution.test.ts tests/application/route-map-service.test.ts` |
| Replanning 三个 Requirements 全部 | IP-02/03 | replanning、execution-authorization、select-bound-run、plan-continuations、baseline-adoption | fake backend、已授权前代、新候选、真实临时 Git | 真实 drain、完整批准、原子冻结/切换、无接受证据不创建 Run | `pnpm exec vitest run --maxWorkers=2 --testTimeout=30000 --hookTimeout=30000 tests/execution/replanning.test.ts tests/bootstrap/execution-authorization.test.ts tests/application/select-bound-run.test.ts tests/bootstrap/plan-continuations.test.ts tests/execution/baseline-adoption.test.ts` |
| Validation 全部、finish/failed 结算、工具路径范围 | IP-04 | run-validation、validation-runtime、foreground-validator-runtime、record-worker-result、execution-delivery | 精确原 UUID、restart、干净 HEAD、真实 Git worktree | 修复一次计费、同 Session、新证据、隐藏 committed/untracked 越界拒绝、finish 拒绝不接受成功 | `pnpm exec vitest run --maxWorkers=2 --testTimeout=30000 --hookTimeout=30000 tests/application/run-validation.test.ts tests/bootstrap/validation-runtime.test.ts tests/bootstrap/foreground-validator-runtime.test.ts tests/application/record-worker-result.test.ts tests/bootstrap/execution-delivery.test.ts` |
| Wake/Prompt 门全部、Finalizer 结算、普通 progress 不唤醒 | IP-05 | actionable-work、runtime-guard、execution-delivery、execution-finalizer、reply-and-inbox、select-bound-run | 丢响应/原 receipt、旧消息、当前 Lease holder、暂停/交接 | 稳定 batch 不重复、unknown 不重发、ACK 前消费证明、仅责任方唤醒 | `pnpm exec vitest run --maxWorkers=2 --testTimeout=30000 --hookTimeout=30000 tests/application/actionable-work.test.ts tests/application/runtime-guard.test.ts tests/bootstrap/execution-delivery.test.ts tests/bootstrap/execution-finalizer.test.ts tests/adapters/orca-cli/reply-and-inbox.test.ts tests/application/select-bound-run.test.ts` |
| 维护/原生压缩/Shake 全部、Committed model step 全部 | IP-06/07 | foreground-planning-runtime、checkpoint-store、compaction、compact-session | fake integration、恢复、Pause/Exit/fencing | 挂起最多 8 次、真实 Prompt 重计数、不增加模型/历史、取消 signal、重启不重复 Shake/丢消息 | `pnpm exec vitest run --maxWorkers=2 --testTimeout=30000 --hookTimeout=30000 tests/bootstrap/foreground-planning-runtime.test.ts tests/adapters/checkpoint-store.test.ts tests/workflow/compaction.test.ts tests/application/compact-session.test.ts` |
| CredentialStore 合同全部与唯一装配 | IP-07 | chat-model-factory、agents/codex-launch、现有 configuration/doctor tests | 注入 credential reader、opaque ref、缺实例 | 工厂/launcher 不 fallback 构造、不泄密 | `pnpm exec vitest run --maxWorkers=2 --testTimeout=30000 --hookTimeout=30000 tests/adapters/chat-model-factory.test.ts tests/adapters/agents/codex-launch.test.ts tests/configuration tests/doctor.test.ts tests/bootstrap/doctor-model-configuration.test.ts` |
| 前台并行/修订/TUI monitoring 的全部 delta Scenario | IP-08/09 | foreground-execution-runtime、execution-view、graph-patch、specification-revision、graph-basis、tui | 前驱并行 fixture、修订 hold、有界只读投影 | 活动额度不退回 1、无关包不冻结、预算真实消费、投影不派发 | `pnpm exec vitest run --maxWorkers=2 --testTimeout=30000 --hookTimeout=30000 tests/bootstrap/foreground-execution-runtime.test.ts tests/application/execution-view.test.ts tests/execution/graph-patch.test.ts tests/execution/specification-revision.test.ts tests/application/graph-basis.test.ts tests/tui` |
| 全部合同与 change 文档 | IP-09 | 全量 Companion tests、TypeScript/ESLint | 本机依赖已存在、不构建 submodule | 回归无失败、类型/lint/build/schema 校验通过 | `pnpm exec vitest run --maxWorkers=2 --testTimeout=30000 --hookTimeout=30000`；`pnpm typecheck`；`pnpm lint`；`pnpm build`；`git diff --check`；`openspec validate complete-coordination-runtime-wiring --strict` |

补录时已完成的运行记录：全量 177 files / 2023 tests 通过，7 files / 14 tests 跳过；后续修正已定向复验：Validator 宿主 5/5、采用/lineage 23/23、压缩 48/48、Retry 缺失败证明 2/2、Replanning guard 28/28、维护所在宿主 23/23，以及相关其他定向套件。最后 typecheck/lint/build/diff-check 通过。全量运行之后的修正不冒称已再跑一次全量。正式验收应绑定最终实现 checkpoint，不能只凭这些补录计数判 PASS。

## 7. 文件清单与升级条件

§3 为最小改动接缝；附录记录补录时全部实际生产/测试/文档文件和 IP 归属，不含生成目录。新增为统一受控 Reply、Run 选择、可信 continuation reader、Validator 步骤宿主及对应行为测试；无删除。共享端口/宿主可关联多个 IP，但同一文件不并行写入。

保护 `references/orca`、依赖及 lockfile、用户真实项目/凭据、Git 历史和其他线程。公开能力不支持、必须改变授权/权限或发现未声明 migration 时回到设计；不得通过伪造状态、回执、UUID 或放宽预算解决。真实验收只使用显式隔离项目和专用身份。

主规格中三个并行文档已随实现提前同步；delta 保存本轮变更，包括 requirement 旧名到新名的重命名。后续 sync/archive 应识别已存在的新名称并核对全文，不能重复重命名或产生第二份 requirement。其余 delta 尚未同步主规格，本次仅补建 change。

## 8. 验收 Agent 授权与限定审计

正式 verification 在固定实现 checkpoint 后单独执行，覆盖全部 delta、修复所依赖既有合同及 IP-01—09。限定审计包括：预算准入/重放/授权锚定、Claim 与交接事务、精确 Session 和实际 Git 修复范围、Run/Cutover/取消的未知结果、Wake owner/ACK 与跨库恢复、有限维护/Shake、持久 blocker 与凭据唯一来源。审计缺口不得记作已通过。

当前仅创建规划工件并登记可证明的已完成实现任务，不创建 `verification.md`，不归档，也不提交。真实 Orca/provider 端到端验证尚未执行，需在正式验收中明确决定其必要范围与证据，不能借用前驱 fixture 06 的结果。


## 附录：本轮实际文件 allowlist

测试由 IP-09 统一登记，分别验证 §3 对应切片；不得把该分组解释成测试可代替实现。

| IP-ID | 文件 |
|---|---|
| IP-01 | `src/application/execution/advance-execution.ts`、`src/application/execution/execution-view.ts`、`src/application/materialize-work-package.ts`、`src/application/planning/route-map-service.ts` |
| IP-01/02/04/05/07 | `src/adapters/storage/coordination-store.ts`、`src/adapters/storage/schema.ts`、`src/application/ports/branch-coordination-store.ts` |
| IP-02 | `src/application/execution/replanning-service.ts`、`src/application/execution/select-bound-run.ts`、`src/application/planning/lease-handoff.ts` |
| IP-02/03/04/05/06/07 | `src/bootstrap/execution-runtime.ts`、`src/bootstrap/foreground-planning-runtime.ts` |
| IP-03 | `src/application/execution/baseline-adoption.ts`、`src/application/planning/graph-history.ts`、`src/bootstrap/plan-continuations.ts`、`src/domain/planning/execution-graph.ts`、`src/domain/planning/graph-compiler.ts` |
| IP-04 | `src/adapters/git/baseline-observer.ts`、`src/application/record-worker-result.ts`、`src/application/run-validation.ts`、`src/bootstrap/validation-runtime.ts`、`src/domain/worker-report.ts` |
| IP-05 | `src/adapters/orca-cli/operation-catalog.ts`、`src/adapters/orca-cli/reconcile-query.ts`、`src/application/controller-service.ts`、`src/application/coordination/reply-worker-question.ts`、`src/application/coordinator/actionable-work.ts`、`src/application/coordinator/user-message.ts`、`src/application/delivery/process-delivery.ts`、`src/application/dto/operation-intent.ts`、`src/application/dto/operation-outcome.ts`、`src/application/ports/execution-backend.ts`、`src/workflow/coordinator/tool-definition.ts`、`src/workflow/coordinator/tool-node.ts` |
| IP-06 | `src/adapters/storage/checkpoint-store.ts`、`src/application/coordinator/compact-session.ts`、`src/application/coordinator/maintenance-lane.ts`、`src/domain/coordinator/session-state.ts`、`src/workflow/coordinator/compaction.ts` |
| IP-06/07 | `src/application/configuration/project-config.ts` |
| IP-07 | `src/adapters/agents/chat-model-factory.ts`、`src/adapters/agents/codex-launch.ts`、`src/application/coordinator/runtime-guard.ts`、`src/bootstrap/coordinator-runtime.ts`、`src/bootstrap/doctor.ts`、`src/bootstrap/startup.ts` |
| IP-08 | `AGENTS.md`、`docs/architecture.md`、`docs/interface-contracts.md`、`openspec/config.yaml`、`openspec/specs/coordinator/foreground-execution-runtime/spec.md`、`openspec/specs/execution/specification-revision/spec.md`、`openspec/specs/tui/execution-monitoring/spec.md`、`src/interfaces/tui/ports.ts` |
| IP-09 | `tests/adapters/agents/codex-launch.test.ts`、`tests/adapters/chat-model-factory.test.ts`、`tests/adapters/checkpoint-store.test.ts`、`tests/adapters/orca-cli/reply-and-inbox.test.ts`、`tests/application/actionable-work.test.ts`、`tests/application/advance-execution.test.ts`、`tests/application/execution-view.test.ts`、`tests/application/graph-basis.test.ts`、`tests/application/materialize-work-package.test.ts`、`tests/application/process-delivery.test.ts`、`tests/application/record-worker-result.test.ts`、`tests/application/route-map-service.test.ts`、`tests/application/run-validation.test.ts`、`tests/application/runtime-guard.test.ts`、`tests/application/select-bound-run.test.ts`、`tests/bootstrap/execution-authorization.test.ts`、`tests/bootstrap/execution-delivery.test.ts`、`tests/bootstrap/execution-finalizer.test.ts`、`tests/bootstrap/foreground-execution-runtime.test.ts`、`tests/bootstrap/foreground-planning-runtime.test.ts`、`tests/bootstrap/foreground-validator-runtime.test.ts`、`tests/bootstrap/plan-continuations.test.ts`、`tests/bootstrap/validation-runtime.test.ts`、`tests/coordination-store.test.ts`、`tests/execution/acceptance/real-patch-planner.test.ts`、`tests/execution/graph-patch.test.ts`、`tests/execution/replanning.test.ts`、`tests/operation-intent.test.ts`、`tests/recovery/acceptance/real-validator-partial.test.ts`、`tests/recovery/capsule-dispatch.test.ts`、`tests/support/recovery-harness.ts`、`tests/workflow/compaction.test.ts`、`tests/workflow/coordinator-tool-loop.test.ts` |

IP-08 另包含本 change 的 `.openspec.yaml`、proposal、design、implementation-plan、tasks 与 proposal 声明的九份 delta specs。正式 verification 不在本轮文件创建清单中。
