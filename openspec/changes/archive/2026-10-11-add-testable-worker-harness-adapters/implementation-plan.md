# Implementation Plan

## 1. 实施基线与权威来源

模式 predecessor-contract。直接前驱 `2026-10-07-remove-worker-credential-management` 已归档，规划 HEAD `1a3eaf7577a3fe62af3e8a35ba5451080ac34e47`。实施前核验 archive、workers/harness-adapters 主规格、当前 WorkerHarness 与 registry、production launcher/runtime/bwrap、原 Task authorization/profile pin 和现有恢复端口。冻结 IC-02 副作用/unknown、IC-07身份/Envelope、IC-08结算、IC-09恢复预算和 IC-14原生选择；D-02仅扩展IC-07端口。schema5/Manifest4/SQLite不变。当前HEAD与规划相同，工作区最初干净。用户已授权本change在lab active期间实施，共享文件串行编辑，不改lab工件。openspec/config旧current-change文字是漂移，将在IP-05修正。

## 2. 复用与接缝

| IP-ID | 现有接缝 | 复用 | 禁止复制 |
|---|---|---|---|
| IP-01 | 原生CLI help/source、公开OrcaCLI | 有界事实表，D-01 | 凭据、私有DB、猜测的flags |
| IP-02 | WorkerHarness、readHarnessTranscriptIdentity、nativeRecoveryInstructions | D-02端口分派 | 第二份格式判断 |
| IP-03 | prepared terminal、worker-runtime、model-launcher、process-runner、Session Binding、bwrap | D-03/04各候选adapter | 生命周期、Orca识别/持久化 |
| IP-04 | worker-harness matrix及support、Recovery/Controller真实fixtures | D-05原生配置与精确句柄 | 旧PASS、模型自报 |
| IP-05 | 当前docs、现有TUI/doctor/config测试 | 真实支持名单与证据 | 新状态权威 |

## 3. 代码变更映射

| IP-ID | Task | Requirement/Scenario | 文件与符号 | 变化 | 不得改变 |
|---|---|---|---|---|---|
| IP-01 | 1.1 | 新候选全部场景 | docs/research/next-worker-harness-candidates.md；change/evidence | bounded候选表、来源、排除结论、版本 | 用户默认配置/秘密 |
| IP-02 | 2.1 | 端口全部场景 | application/ports/worker-harness；bootstrap/worker-harness及execution-runtime；agents/codex-harness、opencode-harness、native-worker；现有registry/recovery tests | 新增身份复核/读取配方并搬移原文本，更新调用及测试替身 | 原恢复语义 |
| IP-03 | 3.1–3.3 | 完整证据后纳入、缺能力排除、已注册进入生命周期 | adapters/agents/*-harness.ts及*-transcript.ts；domain/model-configuration；bootstrap/worker-harness、doctor；agents/worker-runtime、worker-model-catalog、model-launcher、read-only-execution-wrapper；对应tests | 最小独立adapter，原生hooks/session/export，实际roots、目录、探针 | 身份、取消、有界、授权、预算 |
| IP-04 | 4.1–4.3 | 新候选全部场景、恢复配方场景 | tests/support/worker-harness-acceptance、tests/acceptance/worker-harness-matrix；必要同目录新真实用例；artifacts/next-worker-harness-adapters | native exact selection、实际CLI、四角色/Validator续接/resume/Recovery/混合Controller闭环 | 默认无副作用、失败现场 |
| IP-05 | 5.1–5.2 | 全部场景 | 当前docs/AGENTS/OpenSpec上下文、受影响config/bootstrap/TUI fixtures/tests、change tasks/evidence | 当前合同、支持名单、最小行为/画面核验与全量检查 | #52布局、历史资产 |

## 4. 调用与副作用顺序

官方接口/安装资格→用户级CLI及必要原生模型追加→候选私有测试实现→生产描述符/bwrap→原生SessionStart或公开精确Session→独立identity proof→Orca真实接管→角色结果/Delivery结算→sameSession恢复→Recovery→正式注册。所有Orca动作经ExecutionBackend或核验的公开CLI，稳定OperationId/receipt；unknown保留原ID和现场，无自动换ID重发。失败候选不注册且删除本change产生的未使用实验实现。原生配置修改只按明确字段追加，使用内置编辑工具，不覆盖用户已有修改。

## 5. Schema、状态与持久化落实

用户批准的 IP-03 扩展：共享 `read-only-execution-wrapper.ts` 与 `codex-model-launcher.ts` 实现保持 Orca foreground 身份的 bwrap/seccomp 启动；对应 `read-only-execution-wrapper.test.ts` 验证实际终端 ioctl 拒绝、ABI fail closed 与读写边界。过滤器为内部安全实现，不增加 DTO、依赖、配置或持久化字段。以匿名化继承 FD 传递原始 BPF，拒绝不支持的 CPU ABI 与过滤器安装失败；实际 Orca 接管仍作为独立真实验收义务。更新 IC-07 与安全路径文档。

无迁移，无新状态机、表、版本。Session/Task/Dispatch/授权与预算沿既有owner。新方法沿用原结果联合，report只记录非秘密paths与identity；目录无能力时unavailable及手填null effort/source。readonly roots由实际launch环境解析，不能拿主进程猜测替代。模型设置保存与授权应用仍是不同意图。

## 6. 验收证据矩阵

| Requirement/Scenario | IP-ID | 测试/前置 | 断言 | 可运行命令 |
|---|---|---|---|---|
| 新候选全部场景 | IP-01/03 | 官方source、本机help、隔离真实项目 | 每项有结果和可追溯来源 | CLI --version/--help；证据表人工核对 |
| 端口全部场景 | IP-02 | 现有registry/bootstrap/recovery替身 | adapter分派、原identity/失败语义 | pnpm exec vitest run tests/application/worker-harness-registry.test.ts tests/recovery tests/bootstrap/execution-delivery.test.ts |
| 绑定/恢复/隔离/目录 | IP-03 | 最小hook/API/native fixtures | 歧义/陈旧/cwd/缺口拒绝、取消、根重叠 | pnpm exec vitest run tests/adapters/agents tests/bootstrap/doctor.test.ts tests/configuration |
| 完整证据后纳入、恢复配方 | IP-04 | 已安装CLI、用户原生认证、bwrap、Orca | 四角色真实模型、sameSession、Validator续接、Recovery、混合Controller | ORCA_COMPANION_REAL_ACCEPTANCE=1 ORCA_COMPANION_REAL_ACCEPTANCE_KEEP=1 ORCA_COMPANION_REAL_ACCEPTANCE_HARNESSES=<已通过候选> pnpm exec vitest run tests/acceptance/worker-harness-matrix.test.ts；受限新增真实用例同开关 |
| 未运行如实保留 | IP-04 | 无真实开关 | 无认证读取/Orca访问/launch | pnpm exec vitest run tests/acceptance/worker-harness-matrix.test.ts |
| 所有场景整合 | IP-05 | 本机已安装项目依赖 | type/lint/build/test/spec/diff | pnpm typecheck；pnpm lint；pnpm build；pnpm test；openspec validate add-testable-worker-harness-adapters --strict；git diff --check |

## 7. 文件清单与升级条件

新增：本change规划/证据、候选事实文档、仅通过能力验收的新adapter/解析器与最小行为tests、artifacts/next-worker-harness-adapters证据；具体新文件在候选有公开格式证明后登记到IP-03，禁止未证实格式的实现。修改范围为上表；AGENTS.md、README.md、docs/architecture.md、docs/interface-contracts.md、docs/orca-compatibility.md、docs/dev/tui-implementation-handoff.md、openspec/config.yaml，以及因必填端口产生的相关tests替身。无计划项目文件删除；仅移除本次产生的失败候选实验代码。保护references/orca、package.json/lockfile、lab工件、历史archive/evidence与用户已有改动。新公共合同、依赖/迁移、权限放宽、无法证明原Session或需改变生命周期时回到规划并明确升级；已有D-01排除规则不再逐项审批。

## 8. 验收 Agent 授权与限定审计

真实首次授权另暴露 Execution Lease 与当前 Runtime generation 不一致；`foreground-planning-runtime.ts` 批准后调用既有 `repointExecutionLeaseFor`，`tests/bootstrap/execution-authorization.test.ts` 核验批准后的两个租约身份一致。验收夹具的明确 README 文案与正式 Pending Interaction 回答只属于测试输入，不扩大产品范围。

Controller 修复的必要调用链包括 `src/bootstrap/startup.ts`、`src/application/reconciliation/replay-deliveries.ts` 与 `src/application/recovery/worker-session-recovery-service.ts`：沿既有消费 DTO 传递精确已消费问题/结果引用，替代派发指定原 Dispatch 的 `retryOfDispatchId`，prepared terminal 激活后观察原生 Session。复用既有 canonical receipt parser，保留未证明旧派发的阻塞、不重发；测试范围相应含 `tests/recovery/delivery-replay.test.ts`、`tests/recovery/alternate-session.test.ts` 与现有 startup 测试。无持久化迁移与预算/生命周期变化。

`readWorkerMessageFor` 在精确 inbox 页缺失时使用既有同 Run `delivery-read` 的 `all` 模式，最多核验 100 条且继续检查当前 Task/Dispatch、发送者与正文边界。真实 lIir5s 现场已证明问题确认后的读取/回复；该现场仍因 Planner 未产规格而失败，不作闭环 PASS。Capsule 的无消费引用直接 ack 删除，复用已覆盖的原批次消费流程。新验收的工作包标题携带确切 README 要求，显式重开原 Scope 时沿正式 `retry-session` 恢复轮次。

Controller 正文接线还包含 `src/bootstrap/validation-runtime.ts` 的 `validatorVerificationInstructions` 与其既有测试：工作包 title 进入已有 TaskEnvelope.instructions，finish 后要求最后 verify 的完整 JSON 进入 worker_done；不放宽原证据规则。真实中断夹具按公开 exact Worker 回执关闭 external prepared terminal，unknown 不重试。旧缺证据结算保持不可证明，不修改旧数据。

真实恢复与重启还要求 `foreground-planning-runtime.ts` 沿已落盘的精确 Recovery 绑定选择替代 Session 报告路径；已完整结算的 Finalizer 复用原 Verdict/Session/授权/结算事实，未结算旧派发仍拒绝。`startup.ts` 回传已确认 Delivery 的精确 lane，宿主仅清除该 lane 的过时启动诊断。`src/application/execution/advance-execution.ts` 的共享 Frontier 投影排除已结束节点。既有 `tests/bootstrap/foreground-validator-runtime.test.ts`、`tests/bootstrap/execution-finalizer.test.ts`、`tests/application/advance-execution.test.ts` 扩展可观察回归；无新持久化字段或状态机。

用户于本轮明确批准扩展 Controller 修复与上游核对：允许修改 `src/bootstrap/foreground-planning-runtime.ts` 的真实 Worker sender 校验、退出问题引用消费与共享恢复接线，`src/adapters/agents/utility-worker.ts` 的精确 Capsule 报告读取，以及对应 foreground-validator、capsule-dispatch、execution-delivery、Controller acceptance 既有测试。复用 Validation Attempt 游标和公开查询，保持 schema、授权、预算、unknown 与整批确认合同。`references/orca` 仅允许拉取官方 main 的 fast-forward 更新及 gitlink 变更；不编辑其源码或安装依赖。更新兼容文档并运行 adapter 回归。上述授权优先于第 7 节旧 allowlist 限制，其余保护范围保持。

限定审计native-auth、exact-session、original-task-binding、readonly-overlap、catalog-provenance、bounded-transcript、unknown-reconciliation。允许以上allowlist内局部缺陷修复；产品/跨模块合同由主线程决定。任务完成后固定实现检查点（HEAD与工作区diff身份），独立验证全部scenario及证据，才创建verification；不为固定检查点提交代码。未运行真实必要项不写PASS，不自动archive。
