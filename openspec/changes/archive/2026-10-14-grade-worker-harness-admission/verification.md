# Verification

> 验收覆盖分级准入以及任务级只读、可写 Finalizer 扩展。下方真实 harness 证据为独立 basic 验收；可写 Finalizer 的新流程以真实隔离 Git/SQLite 与模拟 Orca/provider 行为测试核验。

## 验收对象

- Change：grade-worker-harness-admission。
- 输入实现 HEAD：da8910197ccedb5daa4b7b41b4b379e841e31e0b。
- 最终验收 HEAD：同上。用户未授权提交；验收对象为该 HEAD 上完成实现与检查的未提交工作区，包含本 change 的新增文件，保留原有改动。
- 验收 Agent：Codex 主代理；分级准入独立审计 Gauss（01a13a13-d106-7bd3-9245-59e2dc5f9607），Finalizer 扩展限定审计 Herschel（01a13a55-ab91-79c0-acc3-22ecac4ac618）。

## 结论

PASS。覆盖分级准入、授权、身份、结果结算、恢复限制与探测/配置接口，以及任务级只读、可写 Finalizer 与最终版本绑定。显式真实 harness 验收为 basic；修复 Finalizer 流程采用真实隔离 Git/SQLite 与模拟 Orca/provider。结论不授予未验证的候选能力，也不声称本轮重跑了全部 harness 的完整矩阵。

basic 使用真实 Orca Task/Dispatch/terminal，支持单次 Planner/Implementation；enhanced 增加精确原生 Session、续接与 Validator/Finalizer；complete 增加完整历史、Recovery 与 mixed Controller。只读为任务级可选能力，不参与通用等级推导。原生模型回显、usage 与目录仅作诊断。原有 v4 指纹与原生绑定语义保持；v5 固定等级/证据并可关闭 Recovery，显式 finalizerPolicy 批准范围内修复；Branch Store 为 schema 22，项目配置仍为 schema 5。

当前发布摘要的等级：complete 为 command-code/qwen-code/antigravity；enhanced 为 codex；basic 为 claude/opencode/pi/omp/kilo；kimi/hermes/cline/muse/cursor 尚不足 basic。Kilo 的默认 TUI Implementation 成功与最新 Planner 成功均有真实记录；后续缺少报告不撤销既有成功事实，当前失败的操作仍阻塞。

## 核验与修复证据

下表覆盖全部 Requirement、Scenario 与 IP-ID；文件均相对仓库根目录。

| Requirement / Scenario / IP-ID | 实现与行为证据 | 结果 |
|---|---|---|
| Evidence-derived progressive support；可用单次能力独立准入、环境变化复核、显式真实验收；IP-1/IP-4 | domain/worker-harness-support.ts；agents/worker-harness-qualifications.ts；bootstrap/doctor.ts；tests/domain/worker-harness-support.test.ts、adapters/agents/worker-harness-qualifications.test.ts、doctor.test.ts | 连续等级、未证/失败、角色最低等级；轻量复核不发模型任务，真实矩阵需显式开关 |
| 应用层 WorkerHarness 端口与显式注册表；已注册进入生命周期、未注册拒绝、唯一显式注册、启动不含凭据与原生隔离、adapter 精确历史、已登记但未验证；IP-1/IP-4 | application/ports/worker-harness.ts；bootstrap/worker-harness.ts；各 concrete harness；tests/application/worker-harness-registry.test.ts 及 tests/adapters/agents | 14 项登记独立于准入，可选能力组及结构化拒绝；原生环境/认证仍归 harness |
| 新候选以真实能力证据纳入；完整证据、缺必要能力、未运行、模型不回显 ID；IP-4 | bundled qualifications；acceptance collector；tests/adapters/agents/worker-harness-qualifications.test.ts；本轮 basic 真实记录及原 complete 工件 | 仅已核验事实授予等级；缺原生回显不拒绝 basic；候选缺口按操作保留 |
| 隔离启动与精确 provider session 身份；四家绑定、OpenCode 公开接口、陈旧观察、非秘密 runtime roots、基础级无 SessionStart；IP-1/IP-2 | optional nativeSession helpers、各 adapter；tests/application/worker-harness-registry.test.ts、adapters/agents；acceptance/matrix 的无 Recovery enhanced fake 与无报告 basic | 原生来源仍精确；basic 不合成 Session/transcript；enhanced 不要求 Recovery 组 |
| Dispatch 与真实 harness session 精确绑定；精确绑定、四角色执行绑定、原生无法证明、harness 不匹配、基础重启；IP-2 | schema21 worker_execution_bindings；coordination-store 公共 Segment 投影；foreground/execution-runtime；tests/coordination-store.test.ts、bootstrap/execution-delivery.test.ts、foreground-execution-runtime.test.ts | 原授权限定 Planner/Implementation 的 Orca 绑定；重启、幂等、冲突拒绝与唯一结算通过 |
| Worker 存活与终态必须可核验；unverifiable、退出不重派、终态错配、Dispatch/Attempt 身份不一致；IP-2 | 原 liveness、Operation Intent/Delivery pipeline；basic 精确 Worker 回读；tests/bootstrap/execution-delivery.test.ts、adapters/agents/utility-worker-recovery.test.ts | 缺信息不推断退出；第二次 terminal 回读漂移拒绝；unknown 不换 ID |
| Model-bound authorization and explicit model reapproval；新任务批准、陈旧/重复批准、v1–v3拒绝、恢复关闭、v4读取；IP-3 | domain/planning/execution-authorization.ts；application/planning/authorization-service.ts；configuration/model-settings.ts；tests/domain/execution-authorization.test.ts、application/authorization-service.test.ts、configuration/model-settings.test.ts、tui/model-settings.test.tsx | v4 固定指纹不变；新绑定要求 v5；完全不变的 v4 绑定可仅调整额度；关闭恢复保留 profile 历史 |
| 原 Task 的授权与结算；IP-2/IP-3 | tests/bootstrap/execution-delivery.test.ts 的重新授权用例扩展到最终 replay/settled | claimed/trusted 同取原 Task 授权；当前配置不追溯改变在途 Task |
| 专用角色与辅助派发；IP-2 | graph-patch-worker/integration-reconciliation-runtime；baseline-worker/utility-worker；相关 bootstrap、execution/baseline-worker 与 utility-worker-recovery 测试 | 只读 Graph Patch 与复验需 enhanced；非 Codex basic Planner 基线补救不要求原生 Session |
| 历史恢复限制与预算；IP-2/IP-3 | foreground 恢复前检查；execution-runtime 源/Utility 当前等级检查；tests/recovery/capsule-dispatch.test.ts | 原授权及当前能力不足、或恢复关闭时拒绝；grade 降低在探针/派发前返回，零 mutation |
| 架构/领域/合同；IP-5 | AGENTS.md、CONTEXT.md、docs/architecture.md、interface-contracts.md、orca-compatibility.md、research/next-worker-harness-adapters.md | 当前 owner、能力等级、v5/schema21 与真实证据一致 |

### 命令结果

- `pnpm typecheck && pnpm lint && pnpm build`：最终工作区全部通过，退出 0。
- `openspec validate grade-worker-harness-admission --strict` 与 `git diff --check`：通过。
- 全量回归命令：`pnpm exec vitest run --maxWorkers=2 --reporter=json --outputFile=/tmp/ocp-grade-final-verified-tests.json`。2688 passed / 2 failed / 18 skipped；其中 Kilo 摘要用例在修改期间混用了旧 source 与新期望，固定文件后通过；PTY 退出时序单次失败，独立复验通过。未将该轮写成零失败。
- 两项最终定向复验：`pnpm exec vitest run --maxWorkers=1 tests/tui/pty.test.ts tests/adapters/agents/worker-harness-qualifications.test.ts`：47 passed。
- 最终等级/目录/诊断/TUI：`pnpm exec vitest run --maxWorkers=2 tests/adapters/agents/worker-harness-qualifications.test.ts tests/application/worker-harness-registry.test.ts tests/doctor.test.ts tests/tui/model-settings.test.tsx`：124 passed。
- 领域与模型设置：`pnpm exec vitest run --maxWorkers=2 tests/domain tests/adapters/agents/worker-harness-qualifications.test.ts tests/bootstrap/worker-model-settings.test.ts`：230 passed。
- 新 optional 能力与基础辅助派发：四套 matrix/qualification/baseline/utility 测试，100 passed / 2 skipped；最后 utility/baseline 再验 8 passed。
- 恢复等级/基础辅助派发：三个 recovery/capsule-dispatch、execution/baseline-worker、utility-worker-recovery 套件，25 passed。
- 重新授权与真实结算：application/authorization-service 与 bootstrap/execution-delivery，51 passed。

### 显式真实验收

使用未修改的本机 `orca-ide` 1.4.224 与 harness 原生认证，在独立 `/var/tmp` 仓库执行：

```sh
ORCA_CLI_COMMAND=orca-ide ORCA_COMPANION_REAL_ACCEPTANCE=1 \
ORCA_COMPANION_REAL_ACCEPTANCE_LEVEL=basic \
ORCA_COMPANION_REAL_ACCEPTANCE_HARNESSES=command-code \
pnpm exec vitest run --maxWorkers=1 --testTimeout=1800000 tests/acceptance/worker-harness-matrix.test.ts
```

55 passed / 2 skipped。Planner 与 Implementation 均真实 succeeded 且 artifactOk=true；Task/Dispatch/terminal 身份非空，Session/transcript/coverage/modelEvidence 均为 null。现场 `/var/tmp/orca-harness-acceptance-uUxIxc` 保留，Run `run_7adf4c5a4e47`；[结构化工件](../../../artifacts/next-worker-harness-adapters/ip04-2026-10-14T10-55-18-402Z-43432fa6-df72-4e03-b63f-5cb3f5fe6d1d.json)。

相同开关显式选择 Kimi 的独立 basic 验收在 prepared 阶段被 `agent-trust-workspace` 阻塞，2 failed / 53 passed / 2 skipped。Task 已创建，Dispatch 未启动；保留 `/var/tmp/orca-harness-acceptance-ehbi1C` 与 Run `run_bb51bb16dbd5`，没有重复派发或伪造成功；[阻塞工件](../../../artifacts/next-worker-harness-adapters/ip04-2026-10-14T10-54-18-998Z-5e735251-9a5b-40fa-8d19-00ab562e274e.json)。该结果支持其当前 unavailable 的判定。

### 验收阶段修复

1. 基础 Planner 的规格修订路径沿同一 Orca Dispatch producer，不使用空 Session 身份。
2. 旧 Task 结果归属使用原授权，回归扩展到最终结算。
3. 新模型绑定强制 v5；v4 只在全部模型/Recovery 绑定未变时保留。
4. Recovery 检查当前源/Utility 等级；增强级验收取消对 Recovery 组的必需依赖；只认 succeeded 为成功。
5. 精确 binding 的二次 terminal 读回必须与原核验一致；辅助 fixture 的品牌类型、语法与 lint 问题修复。
6. Antigravity Recovery 来源引用修正为真实通过的独立 Recovery 工件；Kilo 保留有来源的历史 Implementation 成功，不按后续缺报告降为 unavailable。
7. 规格中“缺基础证据则不注册”的残留措辞修正为“不授予 basic、不派发”，与已批准的登记/准入分离决定一致。

## 限定审计

独立 Gauss 审计授权版本、原 Task 归属、schema21 基础绑定、统一投影、结果结算与能力门。首次 8 文件 / 227 测试通过，同时发现旧 Task claimed 授权错配及未分级绑定继续生成 v4 的问题；修复后独立复查 4 套件 / 84 测试全部通过，未发现新阻塞项。当前等级下降分支另由 Capsule 行为测试验证零 mutation。

主代理复核旧 v4 指纹、Kilo 默认 TUI 的 task/dispatch/succeeded/artifactOk、Antigravity 独立 Recovery 来源及本轮 Command Code/Kimi 工件。未修改 Orca 私有状态、上游、依赖或 Git 历史，也未清理现场。

## 任务级只读与可写 Finalizer 扩展验收

| IP-ID / 场景 | 行为证据 | 结果 |
|---|---|---|
| IP-6：缺只读保留增强/完整等级；按角色 doctor | domain/worker-harness-support、agents/worker-harness-qualifications、doctor、acceptance/worker-harness-matrix | 只读失败仅影响需要它的任务；可写 Finalizer 采集独立产物 |
| IP-7：显式权限与指纹、旧授权不升级 | domain/execution-authorization、application/finalize-project、bootstrap/execution-authorization | v5 repair policy 有界、权限与 Session 形态匹配；v4/缺 policy 保持只读 |
| IP-7：准入/预算、重放/重新授权/重启 | coordination-store、application/finalizer-execution、bootstrap/execution-finalizer | schema22 原子准入，代际预算不重置；原 worktree unknown 按原意图核验，不重复创建 |
| IP-8：范围/最终 HEAD/tree/失败命令/集成 | domain/delivery-verdict、application/integrate-work-package、bootstrap/execution-finalizer | 越界、旧 HEAD、失败复验拒绝集成；成功将精确版本集成并推送至隔离 bare origin |
| IP-8：最终版本持久投影、交付后漂移 | coordination-store、application/execution-view、tui/finalizer | nullable HEAD/tree 保留历史；授权修复不视为只读漂移，版本变更标记结论失效 |
| IP-9：领域/合同与 change 一致 | CONTEXT、AGENTS、architecture、interface-contracts、proposal/design/specs/tasks | 原约束同步；无新依赖、无上游修改、无提交或归档 |

可写流程测试采用真实临时 Git 仓库、独立 worktree、真实普通提交、Node 复验与 ignored coverage 产物、真实 SQLite，以及受控 ff 集成和 bare origin 推送；Orca 与模型由固定后端模拟。明确测量首派发缺只读仍通过、修复越界/旧 HEAD/失败命令拒绝、重启复用原 Task/Worker 且预算一次。测试夹具补齐真实 Delivery 的 worker_done 类型，避免把结果误当进度确认。

共享 scoped dispatch 现在能从原 Run 的唯一精确 Task Envelope 读回丢失响应的 Task；原 Intent 不重发，callbacks 先持久绑定再收尾。独立 Herschel（gpt-6-luna）只读审计授权、schema22、Finalizer 恢复与 Git 集成，未发现范围内可复现缺陷；前一审计因服务 429 失败已明确重试。

最终全量 `pnpm exec vitest run --maxWorkers=2`：216 文件通过、9 文件跳过；2735 用例通过、18 跳过，exit 0。日志 `/tmp/grade-harness-final-suite-20261014.log`。定向 9 套件 215 用例、派发回归 5 套件 45 用例、存储/unknown 2 套件 82 用例均通过。最终 `pnpm typecheck`、`pnpm lint`、`pnpm build`、`git diff --check` 与 `openspec validate grade-worker-harness-admission --strict` 均通过。

## 当前限制

- 本轮没有重跑每家的完整真实矩阵；高等级资格保留各自已留存的真实证据。当前操作仍核验公开接口、身份与安全能力。
- basic 任务中断不能历史恢复；enhanced 也不开放完整历史恢复。v5 默认使用 Codex Recovery Utility 的项目需关闭恢复或显式选择具备 complete 证据的 Utility，再批准新 Manifest。
- Kimi workspace 信任及 Kilo 当前输入就绪风险仍限制具体运行；登记与历史成功不保证每次启动成功。
- 全量并行检查出现一次 PTY 退出时序波动，独立复验通过；未通过修改 UI 或放宽断言掩盖。
- 改动与 OpenSpec change 保留未提交、未归档，原工作区改动完整保留。
