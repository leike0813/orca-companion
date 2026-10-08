# Implementation Plan

## 1. 实施基线与权威来源

基线模式：`predecessor-contract`。直接前驱 `remove-worker-credential-management` 已归档于 `openspec/changes/archive/2026-10-07-remove-worker-credential-management/`，归档 commit 为 `d7898ab`；本次补录基线 HEAD 为 `8bde2e75ba1c5a84d40bc4cf8207d2ff7a9d0d26`。源实现已在本次会话获准并完成，仍在未提交工作区；不能将该 HEAD 当作包含本 change 的固定实现 checkpoint。

已核验前驱 archive 与 `configuration/model-settings`、`workers/harness-adapters`、`cli/environment-diagnostics` 主规格。冻结接缝为 schema 4、IC-14 的 Coordinator-only CredentialStore 与原生模型来源、IC-03/12 的 Scope 绑定和只读查询、原 Execution Authorization Manifest/预算、公开 Orca CLI transport、既有 ledger-lab 合同和判定语义。权威来源为本 change 的 specs、D-01–07、根 CONTEXT/AGENTS、`docs/{architecture,interface-contracts,orca-compatibility}.md` 与 `artifacts/ledger-lab/contract.json`。

继续修改代码前，应核对 `git rev-parse HEAD`、`git diff --name-only`、前驱目录和实际调用接缝。若 HEAD 变化，应先解释新增 commit 与工作区差异；若需要改变冻结合同，返回设计，不通过局部特殊分支吸收。`openspec/config.yaml` 内旧「当前 change」叙述属于前驱背景，本 change 的显式前驱、用户模型选择和文件清单以本文件为准。

## 2. 复用与接缝

| IP-ID | 现有或前驱文件与符号 | 复用方式 | 禁止复制的事实 |
|---|---|---|---|
| IP-01 | ModelSettingsService、FileProjectConfigurationStore、JsonCredentialStore、WorkerHarness.queryModels | Bootstrap 装配生产服务与统一原生目录缓存 | 凭据格式、模型来源规则、Worker 认证 |
| IP-02 | runProcess、生产 Route Map 渲染器、parseProjectConfig、runDoctor | 参数数组、有界 transport、schema 校验、实际能力报告 | Orca runtime 状态或另一份业务合同 |
| IP-03 | openRepositoryCoordinationStore、collector、verifiers、report | 只读 Scope 查找与现有结果语义 | 协调状态机、人工图映射、跨系统一致性 |
| IP-04 | CLI main/argv 与 package bin | 两个命令共用一个入口 | 按名称分叉的运行规则 |
| IP-05 | 现有 Vitest、类型检查、lint、build 和 operator guide | 最小工程回归与限定验收 | 历史 fixture 的 PASS、mock 冒充实机能力 |

## 3. 代码变更映射

| IP-ID | Task | Requirement/Scenario | 文件与符号 | 精确变化 | 不得改变 |
|---|---|---|---|---|---|
| IP-01 | 1.1–1.2 | Explicit reusable model setup；Coordinator secrets stay in the credential store，全部 Scenario | `src/bootstrap/{ledger-lab,worker-model-settings,foreground-planning-runtime}.ts`；`artifacts/ledger-lab/wizard.mjs`；两份 bootstrap 新测试 | D-04 的首次/重配、默认引用、五角色、可信目录、CAS 与隐藏 key | 生产 schema、凭据 owner、在途授权绑定、TUI 布局 |
| IP-02 | 2.1–2.2 | Isolated canonical rehearsal rounds；Readiness preserves manual coordination；Failed preparation retains its original resources，全部 Scenario | `artifacts/ledger-lab/setup.mjs` 的 prepareLab/createCommandRunner/writeLaunchers；`tests/acceptance/ledger-lab-setup.test.ts` | D-01–03/05–06 的预检、空项目、GitHub/Orca 顺序副作用、doctor、现场记录与取消 | 主项目、旧轮次、业务源码、Scope/Run/Task、依赖安装 |
| IP-03 | 3.1–3.2 | Reopen verifies the existing canonical identity；Round defaults preserve external evidence boundaries，全部 Scenario | `artifacts/ledger-lab/{setup,lab}.mjs` 的 openLab/readRun/scopeForRun/bindOperatorFiles/resolveRunOptions；setup acceptance 测试 | D-01/07 的精确身份、只读 Scope、模板与本轮默认路径 | collector、过程/成品断言与报告格式 |
| IP-04 | 4.1–4.2 | 前台入口与 TTY 门禁，全部 Scenario；前述演练入口的使用说明 | `package.json`、`src/interfaces/cli/{main,argv}.ts`、`tests/doctor.test.ts`、根 README/AGENTS、ledger-lab README/guide/capabilities | D-03 的 bin/shebang/help 和当前指南 | 子命令集合、TTY 门禁、UI 原型、既有长命令 |
| IP-05 | 5.1–5.3 | 上述两个 delta 的全部 Requirement/Scenario 的验收义务 | 本文件记录、`tasks.md`、`evidence/checks.json`；完成固定 checkpoint 后的 `verification.md` | 工程验证、真实准备验收和独立限定审计分开记录 | 未验证项不得转为 PASS；本次不提交或提前归档 |

## 4. 调用与副作用顺序

1. `lab:new` 构建；prepare 校验 profile、外置路径与设置。缺设置时完成交互向导，明确保存后以 CAS 提交；非 TTY 直接拒绝。
2. 检查 Node/pnpm、Git 作者、GitHub 账号及 Orca runtime；通过后创建新轮次并保存记录。预检无副作用。
3. 复制外置 operator 材料与空模板，记录来源版本，初始化 Git 与作者核验。
4. 保存阶段 → 新建私有 GitHub 仓库 → 回读身份/可见性 → 创建空 Route Map → 回读正文与 Issue 身份。
5. 保存阶段 → 生成 schema 4 配置及最小项目 → Git 首次提交 → 配置该新仓库的 origin/credential helper → 保存阶段 → push。
6. 保存阶段 → Orca repo add → 固定 base ref → worktree show 核验 canonical → 写外置启动器 → 保存阶段 → 专用 terminal create。
7. 保存阶段 → doctor → 保存外置报告 → 核验报告及 Git 干净状态 → 保存 ready → 切到专用终端。用户自行运行 ocp；没有业务 loop。
8. 每一步取消或失败均落盘 failed 与原阶段，不换目标重试、清理或补偿；unknown 按原记录调查。重开只核验原身份后建终端。
9. `--run` 采集先只读确定唯一 Scope，再绑定空模板；所有证据/报告路径外置且独占新建。同 Scope 人工文件只读保留。

## 5. Schema、状态与持久化落实

- ProjectConfig 仍为 schema 4：五角色完整才可用于演练；保存追加记录并一次推进 revision，旧设置明确拒绝。新项目重新绑定本轮 Route Map、origin/main 与合同额度，不继承上一轮授权风险。
- CredentialStore 沿用 IC-14 的 XDG 位置、owner 权限、短锁、CAS、原子替换和回读；同次配置/doctor 共用实例。设置只存引用，Worker 不访问此 store。
- `run.json` schema 1：轮次身份、profile、repositoryPath、branch、Companion 来源、GitHub/Orca 资源引用、baseline、阶段与 preparing/ready/failed。临时文件原子替换不提供跨 GitHub/Orca 事务。
- mapping/observations 沿用 schema 1，准备时 Scope 为空；绑定只允许空列表与空 Scope，之后身份冲突拒绝，人工内容保留。
- 轮次目录为 owner-only，记录、设置引用与 operator JSON 按已有文件工具权限保存；不记录环境、secret 或 provider 原始异常。不新增协调 SQLite 表、Manifest 字段、provider 默认值或数据迁移。

## 6. 验收证据矩阵

测试命令组 T1 为三份新增测试；T2 为既有回归；T3 为工程检查：

```sh
# T1
pnpm exec vitest run tests/bootstrap/ledger-lab.test.ts tests/bootstrap/worker-model-settings.test.ts tests/acceptance/ledger-lab-setup.test.ts
# T2
pnpm exec vitest run tests/acceptance/ledger-lab-collector.test.ts tests/acceptance/ledger-lab-process.test.ts tests/acceptance/ledger-lab-result.test.ts tests/configuration/model-settings.test.ts tests/bootstrap/foreground-planning-runtime.test.ts tests/doctor.test.ts tests/tui/model-settings.test.tsx
# T3
pnpm typecheck
pnpm lint
pnpm build
git diff --check
```

| Requirement/Scenario | IP-ID | 测试文件 | Fixture/前置条件 | 关键断言 | 可运行命令 |
|---|---|---|---|---|---|
| Isolated canonical rehearsal rounds / 全部 | IP-02/05 | setup acceptance | main/cancel，外置临时目录，GitHub/Orca 回执替身 | 私有新仓库、独立轮次、clean canonical、无业务 src、路径拒绝 | T1；实机 `pnpm lab:new` 与 `pnpm lab:new --profile cancel` |
| Explicit reusable model setup / 全部 | IP-01/05 | ledger-lab bootstrap、worker-model-settings、setup acceptance | 假凭据、原生目录替身、并发保存、非 TTY | 五角色/effort 来源、历史追加、默认引用、取消不保存、CAS 拒绝 | T1 |
| Coordinator secrets stay in the credential store / 两个 Scenario | IP-01/05 | ledger-lab bootstrap、model-settings；会话 PTY 检查 | 合成 key，受限临时 store，隐藏输入与 Ctrl+C | 引用而非 secret、非法 options 零配置写、隐藏/取消恢复 raw | T1/T2；交互 `pnpm lab configure`，使用合成输入核对隐藏行为 |
| Readiness preserves manual coordination / 两个 Scenario | IP-02/05 | setup acceptance、doctor | 成功/失败 doctor 报告；真实配置待提供 | 报告拒绝门、ready 条件；未产生 Scope/Task/业务源码 | T1/T2；实机 `pnpm lab:new`，检查 run.json/operator/doctor.json 并手动进入 Home |
| Failed preparation retains its original resources / 两个 Scenario | IP-02/05 | setup acceptance | unknown create 与阶段 AbortSignal | create 不重复、failed 阶段保留、后续 mutation 未执行 | T1 |
| Reopen verifies the existing canonical identity / 两个 Scenario | IP-03/05 | setup acceptance | 正确身份与 branch 漂移，真实 Git 本地 smoke | 同 repo/branch/common-dir/origin；漂移零终端创建 | T1；实机 `pnpm lab open --run /abs/round` |
| Round defaults preserve external evidence boundaries / 全部 | IP-03/05 | setup acceptance、collector/process/result | 空项目、缺 Scope、绑定/已填写模板 | 自动路径、BLOCKED 成品报告、只读拒绝、模板保留 | T1/T2；实机初始化后 `pnpm lab collect --run /abs/round` |
| 前台入口与 TTY 门禁 / 全部 | IP-04/05 | doctor、既有 CLI 测试；package bin 与启动器检查 | 同一 main、非 TTY 与 initialized Scope | 两个 bin 同入口，help 短命令，非 TTY 拒绝、status/doctor 一次性 | T2/T3；`node dist/src/interfaces/cli/main.js --help`；轮次 `bin/ocp --help` |

真实验收只验证框架的 prepare、doctor、进入 Home、重开和采集衔接；完整 ledger-lab 多阶段业务剧本仍由用户后续实操，不作为本 change 的自动验收任务。框架的真实验收需要用户选择模型/认证，当前尚未运行。不得以 mock 的 ready 或旧隔离探针的模型结论满足此项。

## 7. 文件清单与升级条件

新增：`artifacts/ledger-lab/{setup,wizard}.mjs`、`src/bootstrap/{ledger-lab,worker-model-settings}.ts`、`tests/bootstrap/{ledger-lab,worker-model-settings}.test.ts`、`tests/acceptance/ledger-lab-setup.test.ts`。

修改：`artifacts/ledger-lab/{lab.mjs,README.md,guide.md,capabilities.md}`、`src/bootstrap/foreground-planning-runtime.ts`、`src/interfaces/cli/{main,argv}.ts`、`tests/doctor.test.ts`、`package.json`、根 `README.md` 与 `AGENTS.md`。本 change 文件、`.openspec.yaml` 与证据可随记录补齐；此列表也是修复 allowlist。无删除文件、无依赖变更。

保护：`references/orca`、lockfile、现有 contract/cases/参考图、collector/verifiers/report、领域/应用/storage schemas、Home/TUI 原型、主规格与其他 change 工件。需要新增依赖、改动权限/公共 DTO、迁移 schema、改变 canonical/unknown/密钥边界或扩大上述文件范围时，先更新设计并明确范围，不借实测框架绕过执行授权。

## 8. 验收 Agent 授权与限定审计

验收范围限定本 change 的文件与 Scenario。独立审计检查：外置路径/身份与 shell quoting；settings CAS/secret 生命周期；GitHub/Orca 副作用顺序、超时/取消/unknown 保留；doctor 与业务授权的隔离；原生目录来源提取的回归；`--run` 的证据归属及模板保留。读实际代码和命令，不静态断言文案。范围内修复使用同一 allowlist，受影响测试重跑；不可接受变更返回设计。

固定最终实现 checkpoint 和完成所有任务后才创建 verification.md；输入 HEAD、最终 HEAD、每项证据及审计结果必须可核验。当前本次只补录，不提交、sync 主规格或 archive。

## 9. 补录时的实施记录

2026-10-08，本 change 的代码与工程文档已完成。本轮补录再次运行 T1 与 T2 的合并命令，10 个测试文件、203 项全部通过；工程阶段的 T3 全部通过。机器可读摘要见 `evidence/checks.json`，测试中空业务项目的 BLOCKED 报告是预期断言，非测试失败。

同会话曾检查真实 Git 初始化/首次提交/credential helper/干净 baseline、启动器、重开 Git 身份，以及 PTY 隐藏输入、后续输入和 Ctrl+C 恢复。这些使用 GitHub/Orca mutation 与模型 doctor 替身，不构成真实外部验收；临时 smoke 现场不是长期证据来源。

未完成：真实 GitHub 创建/推送、Orca 终端采用、真实 Coordinator/Worker doctor 与初始化后的采集衔接；固定最终实现 checkpoint 的独立审计及最终 verification。用户已说明没有可用配置，首次选择留给向导。tasks 中只回填已有实现与工程检查，真实验收和最终审计保持未完成。
