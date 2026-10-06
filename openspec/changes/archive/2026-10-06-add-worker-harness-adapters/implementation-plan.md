# Implementation Plan

## 1. 实施基线与权威来源

基线模式：`predecessor-contract`。直接前驱：`complete-coordination-runtime-wiring`，已归档于 `openspec/changes/archive/2026-10-06-complete-coordination-runtime-wiring/`；规划/实施基线 HEAD 为 `c1f9a0a`。实施前核验 `git rev-parse HEAD`、`git diff --check`、前驱归档目录与下列冻结接缝；出现实质漂移时先修订本计划。工作区已有用户改动（`.gitignore` 修改、本 change 目录）必须保留。

| 冻结接缝 | 前驱合同 | 本轮允许的扩展 |
|---|---|---|
| IC-07 Session Binding | 精确角色/harness/session/transcript，不可证明即阻塞 | Binding 增加 harness 判别与逐 harness 证明 |
| IC-07 prepared-terminal | 封闭策略 + Orca 接管读回 | 同一策略承载四个新 harness，无新启动通道 |
| IC-08 Delivery/Validation | 候选结果、同 Session 修复复验、集成续接 | 恢复/续接实现换成注册表项，语义不变 |
| IC-09 Recovery | Segment/替代 Dispatch/Capsule/预算 | transcript 证明扩展到逐 harness；仍存活只重观察原 terminal，替代路径与预算语义不变 |
| IC-14 配置与凭据 | schema 3、opaque ref、bootstrap 单实例 | nativeWorker additive + 逐角色 harness |
| IC-03 store | schema 20、manifest_json blob | 不迁移、不改表，只有 JSON 内容新增字段 |

权威输入：proposal、六个 delta spec、design D-01—D-13、`AGENTS.md`、`CONTEXT.md`、`docs/architecture.md`、`docs/interface-contracts.md` 与当前代码。四 CLI 版本与模型绑定见 design Context。

## 2. 复用与接缝

| IP-ID | 现有或前驱文件与符号 | 复用方式 | 禁止复制的事实 |
|---|---|---|---|
| IP-01 | `application/worker-launch.ts` 的 `PreparedTerminalStrategy`、`prepareWorkerLaunch` | 端口直接产出该策略 | 第二套 terminal 创建/激活流程 |
| IP-02 | `adapters/agents/codex-launch.ts`、`codex-transcript.ts`、`session-binding.ts` | 包装为 codex 注册项；通用校验抽到端口 | Codex 会话逻辑副本 |
| IP-03 | 五个 bootstrap runtime 的 harness gate 与字面量绑定 | 按 profile.harness 解析注册表 | 每 runtime 自带分支 |
| IP-04—07 | `codex-launch` 的隔离状态根与 hook reporter 模式 | claude/pi/omp 共用 `native-worker.ts` 的最小实现，opencode 独立 adapter | 逐 harness 复制启动/身份逻辑；用 cwd/mtime/最近会话代替身份证据 |
| IP-08 | `credential-store.ts`、`codex-model-launcher.ts` 的 secret 边界 | managed 只进子进程 env；harness_login 副本 | 用户全局配置写入 |
| IP-09 | `codex-read-only-probe.ts` 的四证据探针法 | 抽公共包装器与探针端口 | 用版本/配置存在代替能力 |
| IP-10 | `bootstrap/doctor.ts` 的 `readReadOnlyWorker` 投影 | 按 harness 选择探针，结论逐项输出 | doctor 内做能力判断 |
| IP-11 | `domain/model-configuration.ts`、`application/configuration/{project-config,model-settings}.ts` | schema 3 additive + 逐角色 harness | 改写旧记录或旧指纹 |
| IP-12 | `interfaces/tui/{state.ts,components/model-settings-editor.tsx}` | 在 #52 定稿上追加 harness 选择与适用字段 | 重设计布局或默认改语义 |
| IP-13 | `recovery/worker-session-recovery-service.ts`、`run-validation.ts`、`integration-reconciliation-runtime.ts` | 复用原流程，替换 resume/prove 实现 | 新 Recovery 状态或预算 |
| IP-14—15 | 现有 Vitest 参数化合同与 `tests/acceptance` 隔离脚手架 | 扩展合同 + 只补真实回归缺口 | 以 mock 冒充真实 harness 证据 |
| IP-16 | `docs/*`、`AGENTS.md` | 文末同步文档与当前 change 状态 | 修改已归档历史结论 |

## 3. 代码变更映射

| IP-ID | Task | Requirement/Scenario | 文件与符号 | 精确变化 | 不得改变 |
|---|---|---|---|---|---|
| IP-01 | 1.1 | 端口与注册表全部 Scenario | `src/application/ports/worker-harness.ts`（新） | 定义五能力端口、请求/结果、注册表类型与未注册拒绝 | 应用层不依赖 adapters |
| IP-02 | 1.2 | Worker harness launch 全部 | `src/adapters/agents/codex-harness.ts`（新）、`session-binding.ts` | codex 包装为注册项；Binding 增加 harness 字段与逐 harness 校验函数 | Codex 参数/状态根行为 |
| IP-03 | 1.3 | 四个主要角色精确绑定、harness 身份不匹配 | `src/bootstrap/{foreground-planning-runtime,execution-runtime,graph-patch-worker,baseline-reconciliation-runtime,integration-reconciliation-runtime}.ts` | 删除 `!== 'codex'` 与字面量 `'codex'`，改按 profile.harness 解析；baseline 解除 Codex 签名耦合 | 角色门、预算、Delivery 语义 |
| IP-04 | 2.1 | claude 行：启动/身份/恢复 | `src/adapters/agents/native-worker.ts`（新，claude/pi/omp 共用宿主 + claude 行） | 最小共用实现承载 claude 行：SessionStart hook、精确 path、`--session-id`/`--resume`、隔离状态与 settings 副本（只放行 scope 内 orchestration 命令，完成回报经 Orca 校验的 `send` dispatch capability） | 不写用户全局 settings |
| IP-05 | 2.2 | opencode 行 | `src/adapters/agents/opencode-harness.ts`（新） | 隔离 XDG + `mini --standalone --model` 私有子进程（显式 pin 与原生 provider policy 防回退）、原生 config `providers`/`settings`/`package`（api→package 映射、Anthropic 补 `/v1`）、`POST /api/session` 精确回读、`session.list --param` 穷尽、raw GET limit/cursor 消息读取 | 不读 SQLite、不连用户 server |
| IP-06 | 2.3 | pi 行 | `src/adapters/agents/native-worker.ts`（同一共用宿主的 pi 行） | pi 行描述符：`session_start` extension、id/path/activebranch、`--session-id`/`--session` | 不改 pi 全局配置 |
| IP-07 | 2.4 | omp 行 | `src/adapters/agents/native-worker.ts`（同一共用宿主的 omp 行） | omp 行描述符：extension 等 `existsSync` 真实文件、回读 id/fullpath、`--resume` exact、`HOME` 收入 `stateRoot/home` 隔离 daemon、`--config` 仅设置 overlay（`setupWizard`/`titleState` off）而 registry 走 agent dir `models.json`（迁 `models.yml`）、transcript 首行 `title` v1 属 metadata | 不用 picker/前缀/--continue |
| IP-08 | 3.1 | 认证来源隔离全部 Scenario | `src/adapters/agents/native-worker.ts`（共用宿主）、既有 launcher | 共用宿主的隔离状态根、env 组装与 auth source 判别，逐 harness 常量（pi `$ENV`、OMP 裸变量名） | secret 不出现在公开面 |
| IP-09 | 4.1 | 只读包装器全部 Scenario | `src/adapters/agents/read-only-execution-wrapper.ts`（新）、`codex-read-only-probe.ts` | bwrap 包装器与探针端口按 harness 复用；`/run` 只读保留 DNS symlink，仅条件 `/tmp` 与精确状态根/report 目录可写 | 四证据探针法不放松 |
| IP-10 | 4.2 | doctor 逐 harness、授权审阅 | `src/bootstrap/doctor.ts` | 核验配置引用的每个角色 profile（复用同 harness 探针结论），逐 profile 输出，未知/缺失 native fail closed | doctor 状态闭集不变 |
| IP-11 | 5.1 | model-settings 与逐角色 harness 全部 Scenario | `src/domain/model-configuration.ts`、`src/application/configuration/{project-config,model-settings}.ts` | nativeWorker strict union、harness 校验、`SaveModelSettingsInput.harness` 可选语义 | 旧字段、旧指纹、CAS |
| IP-12 | 5.2 | tui/planning-workspace 全部 Scenario | `src/interfaces/tui/{state.ts,components/model-settings-editor.tsx}` 及模型子页 | 逐角色 harness/provider 与适用字段 | #52 布局、effort、返回与显式保存 |
| IP-13 | 6.1 | recovery/worker-sessions 全部 Scenario | 恢复用例、validation 宿主、集成续接宿主 | 仍存活只重观察原 terminal/session（零新派发、零预算、零 Segment）；确认退出或不可证明才走替代 Segment；实际 restart launch 用注册项 `prepareResume` | Attempt/预算/身份规则 |
| IP-14 | 7.1 | 各 delta 的行为 Scenario | 见 §6 测试清单 | 参数化合同 + 回归缺口 | 不锁定文案/实现细节 |
| IP-15 | 7.2 | 端口/身份/只读/恢复端到端 | `tests/acceptance/worker-harness-matrix.test.ts`（新） | 隔离项目四 harness p-i-v-f + resume/recovery + 混合角色 | 只在显式隔离环境运行 |
| IP-16 | 8.x | 文档同步 | `docs/{architecture,interface-contracts,orca-compatibility}.md`、`docs/dev/tui-implementation-handoff.md`、`AGENTS.md` | 记录端口、schema 3 nativeWorker、IC-07/08/09/14 与逐 harness 能力 | 不改历史结论 |
| IP-17 | 8.3 | 全量门禁 | 无生产文件 | 运行全部检查与严格校验 | 不把跳过记为通过 |

## 4. 调用与副作用顺序

派发：解析 profile.harness → 注册表命中 → `prepareLaunch` 在隔离状态根写盘前完成凭据/字段/包装器校验 → Operation Intent → terminal-create → wait idle → Orca `worker-start --terminal` → exact Worker 读回 → 等 hook/extension 报告 → `proveSession` 命中唯一候选 → 写 Session Binding。恢复：原绑定 → 重读精确 transcript 重新证明仍存活的 exact Worker，只重观察、零新派发、零预算、零 Segment；确认退出或身份不可证明才创建替代 Dispatch/Binding/Segment 并沿原预算路径。真正需要重新 launch 的 Validator 续接与集成续接（IC-08）用注册项 `prepareResume`（精确 id/path）→ 重新证明 → 结算。只读：包装器构建 → 探针/生产同描述符 → 失败即 blocker，不消耗 Recovery 预算。所有 unknown 沿原 OperationId 对账；注册表缺项或字段不合法在写盘前拒绝。

## 5. Schema、状态与持久化落实

`coordination.sqlite` 保持 schema 20：Manifest 与绑定以 JSON blob 存储，新增字段不触发表迁移。项目配置保持 schema 3 且 additive：`nativeWorker` 缺省省略，旧 fingerprint 不变。Session Binding 增加 harness 判别但沿用同表与既有身份函数；Recovery/Segment/预算结构与计数规则不变。状态根、opencode 隔离 XDG 与 bwrap 包装器都是启动期产物。普通 native 角色的 private per-launch root 当前沿用既有 Codex 政策位于 Git common dir 的 Companion 私有目录（`sessionPaths`），真实验收 fixture 显式传入自己的 private state root；仍按 launchId 隔离并与 worktree 绑定，不新增配置，也不把 worktree 内状态根写成已实现，残余 root 需显式清理。omp 以 `<stateRoot>/home` 作为隔离 `HOME`；claude 的显式 settings 只放行 scope 内 orchestration 命令（完成回报经 Orca 校验的 `send` dispatch capability），不开放其它任意 shell。

## 6. 验收证据矩阵

| Requirement/Scenario | IP-ID | 测试文件 | Fixture/前置条件 | 关键断言 | 可运行命令 |
|---|---|---|---|---|---|
| 端口与注册表全部；四个主要角色精确绑定；harness 不匹配 | IP-01/02/03 | `tests/application/worker-harness-registry.test.ts`、`tests/adapters/agents/session-binding.test.ts`、`tests/bootstrap/foreground-planning-runtime.test.ts` | 五注册项、未注册 id、fake backend | 未注册拒绝、身份逐项校验、Codex 回归不变 | `pnpm exec vitest run --maxWorkers=2 --testTimeout=30000 --hookTimeout=30000 tests/application/worker-harness-registry.test.ts tests/adapters/agents/session-binding.test.ts tests/bootstrap/foreground-planning-runtime.test.ts` |
| claude/pi/omp 启动、身份、恢复；陈旧观察、缺失/截断历史、迟到首 transcript | IP-04/06/07/08 | `tests/adapters/agents/native-worker.test.ts`（claude/pi/omp 参数化） | fake 子进程 + 临时 state root + 脚本化报告 | 精确 id/path、拒绝 --continue/模糊、延迟报告不推进 | `pnpm exec vitest run --maxWorkers=2 --testTimeout=30000 --hookTimeout=30000 tests/adapters/agents/native-worker.test.ts` |
| opencode standalone、分页消息、身份 | IP-05 | `tests/adapters/agents/opencode-harness.test.ts` | fake HTTP 响应（`POST /api/session` 回读、`session.list --param` 的 `{data,cursor}` 形状、raw GET limit/cursor 消息）+ 隔离 XDG | 只走公开 metadata/分页、不读 DB、不连全局 server | `pnpm exec vitest run --maxWorkers=2 --testTimeout=30000 --hookTimeout=30000 tests/adapters/agents/opencode-harness.test.ts` |
| 认证隔离与 secret 边界 | IP-08 | `tests/adapters/agents/native-worker.test.ts`、`tests/adapters/agents/codex-launch.test.ts` | 注入 CredentialStore、harness_login 副本 | key 只在 env、全局配置零写入 | 与上两条命令合并运行 |
| 只读包装器与 doctor | IP-09/10 | `tests/adapters/agents/read-only-execution-wrapper.test.ts`、`tests/doctor.test.ts`、`tests/bootstrap/doctor-model-configuration.test.ts` | fake bwrap 结果、逐 harness profile | 四证据、coordination.sqlite 拒写、逐 harness 结论 | `pnpm exec vitest run --maxWorkers=2 --testTimeout=30000 --hookTimeout=30000 tests/adapters/agents/read-only-execution-wrapper.test.ts tests/doctor.test.ts tests/bootstrap/doctor-model-configuration.test.ts` |
| 配置 nativeWorker、逐角色 harness、TUI | IP-11/12 | `tests/bootstrap/project-config.test.ts`、`tests/configuration`、`tests/tui`（模型设置相关） | 旧记录、非法 union、未注册 harness | 兼容/拒绝/不自动生效、#52 布局保持 | `pnpm exec vitest run --maxWorkers=2 --testTimeout=30000 --hookTimeout=30000 tests/bootstrap/project-config.test.ts tests/configuration tests/tui` |
| Recovery/Validator 同会话与集成续接 | IP-13 | `tests/adapters/agents/validator-continuity.test.ts`、`tests/adapters/agents/utility-worker-recovery.test.ts`、`tests/bootstrap/validation-runtime.test.ts`、`tests/bootstrap/execution-delivery.test.ts` | 各 harness 原 UUID、restart、原绑定 | 同会话修复—复验、原授权固定、unknown 不重复 launch | `pnpm exec vitest run --maxWorkers=2 --testTimeout=30000 --hookTimeout=30000 tests/adapters/agents/validator-continuity.test.ts tests/adapters/agents/utility-worker-recovery.test.ts tests/bootstrap/validation-runtime.test.ts tests/bootstrap/execution-delivery.test.ts` |
| 真实隔离四 harness 端到端 + resume/recovery + 混合角色 | IP-15 | `tests/acceptance/worker-harness-matrix.test.ts` | 显式隔离 Orca 项目与专用身份；四个固定模型 | 每 harness p-i-v-f、resume/recovery、混合角色；只记录真实 usage | `ORCA_COMPANION_REAL_ACCEPTANCE=1 pnpm exec vitest run --maxWorkers=1 --testTimeout=1800000 tests/acceptance/worker-harness-matrix.test.ts` |
| 全量回归与 change 校验 | IP-17 | 全量 Companion tests、TypeScript/ESLint/build | 本机依赖已存在、不构建 submodule | 无回归失败，类型/lint/build/严格校验通过 | `pnpm typecheck`；`pnpm lint`；`pnpm test`；`pnpm build`；`git diff --check`；`openspec validate add-worker-harness-adapters --strict` |

## 7. 文件清单与升级条件

新增：`src/application/ports/worker-harness.ts`、`src/bootstrap/worker-harness.ts`、`src/adapters/agents/{codex,opencode}-harness.ts`、`src/adapters/agents/native-worker.ts`（claude/pi/omp 共用）、`src/adapters/agents/read-only-execution-wrapper.ts`、`tests/application/worker-harness-registry.test.ts`、`tests/adapters/agents/{native-worker,opencode-harness}.test.ts`、`tests/adapters/agents/read-only-execution-wrapper.test.ts`、`tests/acceptance/worker-harness-matrix.test.ts`。

修改：`src/domain/model-configuration.ts`、`src/application/configuration/{project-config,model-settings}.ts`、`src/adapters/agents/{session-binding,codex-read-only-probe}.ts`、`src/bootstrap/{foreground-planning-runtime,execution-runtime,graph-patch-worker,baseline-reconciliation-runtime,integration-reconciliation-runtime,doctor}.ts`、`src/interfaces/tui/{state.ts,components/model-settings-editor.tsx}`、`src/application/recovery/worker-session-recovery-service.ts`、相关既有测试，以及 `AGENTS.md`、`docs/{architecture,interface-contracts,orca-compatibility}.md`、`docs/dev/tui-implementation-handoff.md`。

保护：`references/orca` submodule、`.gitignore`、`package.json`/lockfile（不新增依赖）、已归档 change 目录、`openspec/config.yaml` 的既有条款。升级条件：需要新增 npm 依赖、修改 SQLite schema、改动 Manifest v3 语义、英文化 TUI 文案或把 harness 能力做成可配置开关时，先回到用户确认；opencode 目标模型在隔离配置下仍不可用时，只按 blocker 记录，不替换模型。

## 8. 验收 Agent 授权与限定审计

验收范围：本 change 的全部新增/修改文件、上述可运行命令与 `tests/acceptance/worker-harness-matrix.test.ts` 的隔离真实运行；授权在范围内修复缺陷并复跑受影响检查，更新最终 HEAD。受保护语义边界：Session Binding 身份判定、OperationOutcome 三值、Recovery 预算、Manifest 绑定、secret 边界、#52 TUI 布局；触碰这些边界需升级而不是就地改。限定审计标签：`harness-identity`、`readonly-wrapper`、`config-compat`、`auth-isolation`、`real-acceptance`。
