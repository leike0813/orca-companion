# Implementation Plan

## 1. 实施基线与权威来源

Baseline: current-head，规划/实施 HEAD da8910197ccedb5daa4b7b41b4b379e841e31e0b。用户批准独立实现；add-next-worker-harness-adapters 现有端口与 prepared-terminal 接缝保持。以 proposal、delta specs、D1–D6 和已批准计划为准。

## 2. 复用与接缝

| IP-ID | 复用 | 唯一事实源 |
|---|---|---|
| IP-1 | domain runtime schema、WorkerHarness、registry | 等级规则 |
| IP-2 | SessionSegment、OperationIntent、materialization binding、Delivery pipeline | Orca exact Dispatch 与原授权 |
| IP-3 | Manifest parsing/fingerprint、configuration CAS、授权 review | 用户批准的模型与资格 |
| IP-4 | doctor、model settings、现有验收 collectors | 实际探测与来源工件 |
| IP-5 | 现有行为测试、架构合同 | 当前代码 |
| IP-6 | Worker 支持等级、readOnly 能力组 | 通用等级与任务级能力分离 |
| IP-7 | Manifest fingerprint、generic budget counter、materialization/Intent | 原授权与 Finalizer 准入 |
| IP-8 | GitIntegrationPort、原 Git 步骤、Delivery Verdict | 最终验证 HEAD/tree 与原操作 ID |
| IP-9 | 现有 Finalizer/domain/storage/TUI 行为测试 | 最终可交付代码 |

## 3. 代码变更映射

| IP-ID | Requirement/Scenario | 文件与符号 | 精确变化 |
|---|---|---|---|
| IP-1 | Evidence-derived progressive support、应用层端口 | 新 domain/worker-harness-support.ts；application/ports/worker-harness.ts；bootstrap/worker-harness.ts；agents/*harness.ts | 等级、可选能力及明确登记 |
| IP-2 | Dispatch 精确绑定、基础绑定重启、身份不一致 | domain/task-contract.ts；application/specification-admission.ts；application/ports/branch-coordination-store.ts；storage/schema.ts、coordination-store.ts；bootstrap/execution-runtime.ts、foreground-planning-runtime.ts、graph-patch-worker.ts、baseline-reconciliation-runtime.ts、integration-reconciliation-runtime.ts；agents/baseline-worker.ts、utility-worker.ts | 基础派发表及统一归属，启动/问答/结果/重启/恢复角色门；基线补救复用精确 Orca 身份，只读 Graph Patch 与集成续接要求 enhanced |
| IP-3 | Model-bound authorization、关闭恢复、旧授权 | domain/planning/execution-authorization.ts；application/planning/authorization-service.ts；configuration/model-settings.ts；bootstrap/foreground-planning-runtime.ts；TUI 模型设置与授权投影 | v5 资格绑定、v4 精确读取、CAS 关闭恢复 |
| IP-4 | 新候选证据、显式验收、环境变化 | bootstrap/doctor.ts、worker-model-settings.ts；application 配置目录/DTO；tests/support/worker-harness-acceptance.ts、acceptance/worker-harness-matrix.test.ts；新 agents/worker-harness-qualifications.ts | 资格摘要、角色探测、能力证据收集与等级验收 |
| IP-5 | 全部 | 相关现有 tests；AGENTS.md、CONTEXT.md、docs/architecture.md、interface-contracts.md、orca-compatibility.md、research/next-worker-harness-adapters.md | 行为验证及当前合同更新 |

## 4. 调用与副作用顺序

资格读取→角色准入→完整授权固定→原意图落盘→prepared terminal/Orca 接管→exact Worker 回读→执行绑定落盘→原结果核验/回写/回读→消费确认。unknown 原 ID 对账。基础绑定不等待原生报告；原生操作逐次核验。

## 5. Schema、状态与持久化落实

schema 21 追加基础绑定，原 Segment 不改。Manifest v5 显式等级及证据，v4 保持字段和指纹。关闭恢复以 null 授权和取消配置当前引用表达。schema 5 项目配置保留历史 profiles。

## 6. 验收证据矩阵

| IP-ID | 场景 | 测试与命令 |
|---|---|---|
| IP-1 | 等级缺失/失败、角色限制 | pnpm exec vitest run tests/domain/worker-harness-support.test.ts tests/application/worker-harness-registry.test.ts |
| IP-2 | 基础绑定结算/错配/重启、原生回归 | pnpm exec vitest run tests/coordination-store.test.ts tests/bootstrap/execution-delivery.test.ts tests/bootstrap/foreground-execution-runtime.test.ts tests/application/specification-admission.test.ts |
| IP-3 | v4/v5、恢复关闭、授权固定 | pnpm exec vitest run tests/domain/execution-authorization.test.ts tests/application/authorization-service.test.ts tests/bootstrap/execution-authorization.test.ts |
| IP-4 | 模型缺回显、部分历史、分级事实 | pnpm exec vitest run tests/acceptance/worker-harness-matrix.test.ts tests/doctor.test.ts tests/bootstrap/worker-model-settings.test.ts |
| IP-5 | 全部 | pnpm typecheck；pnpm lint；pnpm build；openspec validate grade-worker-harness-admission --strict |

真实角色矩阵与 mixed Controller 只在显式隔离现场运行，不更换已运行现场身份/模型。

## 7. 文件清单与升级条件

新增 domain support、qualification 摘要、行为测试和本 change 工件；修改表中生产/测试/文档文件；无删除。保护 references/orca、artifacts/ledger-lab、package.json、lockfile 和用户既有改动。真实环境阻塞保留证据，不通过降低安全规则制造 PASS。

## 8. 验收 Agent 授权与限定审计

辅助 agent 限定纯规则、adapter 能力接线及采集测试；最终跨模块、安全和兼容验收由主 agent 负责。不得提交、切分支、安装依赖、修改外部真实用户配置或清理历史工件。

## 9. Finalizer 扩展文件与验收

- IP-6：domain/worker-harness-support.ts、bootstrap/doctor.ts、tests/domain/worker-harness-support.test.ts、agents/worker-harness-qualifications.test.ts、doctor.test.ts、tests/support/worker-harness-acceptance.ts 与 acceptance/worker-harness-matrix.test.ts。
- IP-7：domain/planning/execution-authorization.ts、application/planning/authorization-service.ts、application/ports/branch-coordination-store.ts、adapters/storage/schema.ts、coordination-store.ts、bootstrap/execution-runtime.ts、foreground-planning-runtime.ts；新增 application/finalizer-execution.ts，管理项目级预算与独立 worktree 准入/恢复。相关 authorization/storage/bootstrap 测试。
- IP-8：domain/delivery-verdict.ts、application/finalize-project.ts、application/integrate-work-package.ts、adapters/git/integration.ts 与 baseline-observer.ts（复用）；application/execution/execution-view.ts、TUI finalizer-panel.tsx，相关 domain/application/adapters/TUI/support tests。
- IP-9：CONTEXT.md、AGENTS.md、docs/architecture.md、interface-contracts.md、orca-compatibility.md、research/next-worker-harness-adapters.md；本 change proposal/specs/design/tasks/verification 与新 Finalizer 行为测试。
- 不安装依赖，不修改上游。生产 Git 操作只作用于 Manifest 授权的任务工作区；不会在当前开发仓库执行提交/切分支。新字段按需显式授权，旧记录缺失最终版本时不推断回填。
- 验证：相关 domain/authorization/store/finalizer/integration/execution-view/TUI/acceptance 套件；pnpm typecheck、lint、build；openspec validate grade-worker-harness-admission --strict。真实验收通过显式隔离 fixture 运行，不覆盖原现场。
