# Implementation Plan

## 1. 实施基线与权威来源

- Baseline mode：`predecessor-contract`。
- 直接前驱：`stabilize-agent-harness-core`，archive 为 `openspec/changes/archive/2026-10-09-stabilize-agent-harness-core`。
- 规划 commit：`a29704bc7226c215f2bb14d1503211af82867c5f`。
- 行为来源：本 change `specs/testing/ledger-lab-rehearsal/spec.md`；技术合同：design D-01–09。
- 受影响并行项：active `add-ledger-lab-rehearsal-infrastructure`。其 `testing/ledger-lab-rehearsal` 尚无主规格，本次移交该 delta；scope-initialization delta 及真实业务验收继续由原 change 拥有。

实施前运行 `git rev-parse HEAD`、`git status --short`、`openspec list --json`、`openspec list --specs --json`，确认前驱 archive 与主规格 `agent/debug-harness`、`coordinator/session-runtime`、`coordinator/wake-suspension` 存在。核对以下冻结接缝：

1. 前驱共用 CredentialStore/ProviderLibrary 与生产 TUI；debug-runtime 仅扩展共享 library/catalog 入口，debug-session-store 与 IC-16 writer lock 保持原合同。
2. `foreground-planning-runtime.ts` 的 `modelSettingsPort`/`initializeProject` 允许缺失项目配置，生产配置 schema 5、授权 Manifest v4 与用户凭据 ownership 不变。
3. `setup.mjs` 的 prepare/readRun/openLab/scopeForRun、`lab.mjs` 的 main/resolveRunOptions、现有 setup acceptance 仍为原 lab 接缝；其他 agent 不同时写这些文件。
4. `contract.json`、cases、collector/verifier/report 的业务证据语义与外置边界未改变；`docs/dev/tui-implementation-handoff.md` 的已批准模型设置来源仍适用。

若主规格/接口已漂移，先更新本计划，不能以名称相似视为核验通过。先完成 IP-01 的配置例外与合同移交，再实施后续片段。

## 2. 复用与接缝

| IP-ID | 现有或前驱文件与符号 | 复用方式 | 禁止复制的事实 |
| --- | --- | --- | --- |
| IP-01 | 原 lab proposal/spec/design/implementation-plan/tasks；openspec config | 移交同路径 delta，明确双方剩余验收 | 不造第二个 ledger capability，不修改 archive |
| IP-02 | setup saveRun/readRun/runsRootFor；common canonicalPath/readJson/writeNewJson | 提取至一份 run-record 模块并扩 schema 2，按用途核验 | 不增加索引，不把 live 资源存在当作记录格式 |
| IP-03 | prepareLab/createCommandRunner/cleanEnvironment；package bin/build | 删除特殊设置链，执行 pack/install，保留阶段取消/unknown | 不复制 production 模型配置，不用开发路径 wrapper |
| IP-04 | createCommandRunner、readonly coordination store、debug session store、公开 worktree show | 回收只查询精确资源并删除已记录目标 | 不复制 lifecycle，不访问 Orca DB，不结束进程 |
| IP-05 | openLab/scopeForRun/bindOperatorFiles、resolveRunOptions | 保留 schema 1；schema 2 分目的读取和绑定 | 不重建 Scope，不猜最新绑定，不改验收语义 |
| IP-06 | 既有 model-settings tests、scripted-model-server、tuistory | 安装包启动与生产配置路径验收；更新人工指南 | 不用 fake app port 代替 TUI 设置，不绕过真实验收 |
| IP-07 | setup/run-record、公开 repo/worktree/terminal 命令 | 登记、设置 origin/main、保存终端句柄；重开精确聚焦/已退出替换 | 不换默认绑定、不猜退出、不运行模型 |
| IP-08 | 领域 Route Map 章节、gh process runner、短锁/CAS 原子文件模式 | Scope 前 list/select/create 与 branch record，unknown 原 marker 对账 | 不造第二份章节表、不进入 Coordinator 工具、不重发创建 |
| IP-09 | ProviderLibrary/Catalog、model-settings 状态转换、DialogFrame、ScopeSetupPort、DebugHarnessPort | 共享编辑器、逐项核验、四步引导和 debug 空库 | 不另建凭据库、项目 parser 或 Worker 门禁 |

## 3. 代码变更映射

| IP-ID | Task | Requirement/Scenario | 文件与符号 | 精确变化 | 不得改变 |
| --- | --- | --- | --- | --- | --- |
| IP-01 | 合同移交 | 全部 Requirement | openspec/config.yaml；原 active lab 四份规划文档与同路径 spec | 更正 core 已归档说明、加入此次解阻塞例外；移交 lab delta，改验收步骤引用 | 原 lab 未完成真实验收不得勾选，scope delta 保留 |
| IP-02 | record/list | Durable creation records；旧轮次缺少删除证明 | 新 run-record.mjs；setup.mjs；lab.mjs；setup acceptance | 唯一 schema/save/read/list owner；schema 1/2 读取；nullable 资源；100项有界列表 | 原记录/秘密不迁移，list 不自动选轮次 |
| IP-03 | repo/install | Isolated canonical rehearsal rounds；Repository-local companion installation；Failed preparation retains its original resources | setup.mjs/prepareLab；package.json；setup acceptance；删除 wizard.mjs/bootstrap ledger-lab/其测试 | pack allowlist、创建→安装→提交推送，与 IP-07 登记/终端串接；删除 settings/configure/准备期 doctor | 不修改 Worker/凭据归属，不追加运行依赖 |
| IP-04 | reclaim | Explicit repository reclamation；Partial and uncertain reclamation remains observable；Rehearsal failures stay structured | 新 cleanup.mjs；lab.mjs；新 cleanup acceptance | preview/--yes、删除前核验 nodeId 后按 owner/name REST 删除、目录归属、运行前置、结果独立记录与先对账 | 不删整个 round，不批量、不强制、不自动重试 |
| IP-05 | reopen/evidence | Reopen verifies the existing canonical identity；Round defaults preserve external evidence boundaries | setup.mjs/openLab/scopeForRun；lab.mjs/resolveRunOptions；setup acceptance | 与 IP-07 共用原终端核验；collect 校验并记录 Orca；离线报告不用 live repo | legacy open 合同与人工内容保留，业务语义不变 |
| IP-06 | installed TUI/guide | Configuration through the normal TUI；Coordinator secrets stay in the credential store；安装快照场景 | installed acceptance；README/AGENTS；architecture/interface-contracts；lab README/guide/capabilities | 真 pack/install/PTY 的启动引导和 debug 空库；按用户意图初始化、doctor 与回收 | 沿原型，凭据留用户 store，不宣称未运行的真实场景通过 |
| IP-07 | Orca/terminal | Isolated canonical rehearsal rounds；Reopen verifies the existing canonical identity | setup.mjs/run-record.mjs；setup acceptance | prepare 公开登记、设置 origin/main、打开原生终端；持久 handle，open 聚焦/确定 exited 后替换；旧未登记 schema2 显式 open 补登记 | 终端只补 PATH/ORCA_CLI_COMMAND，不全局安装、不自动启动 ocp |
| IP-08 | Route Map | Pre-scope Route Map initialization | 新 application/planning/route-map-initialization.ts、storage/tracker adapters；foreground-planning-runtime；application tests | 有界 list/select/create、空章节、branch record 短锁/CAS/原子写、唯一 operation marker 与未知对账 | 无 Scope 身份/Coordinator 工具/DB migration，不换 ID 重试 |
| IP-09 | startup/debug | Configuration through the normal TUI；Debug configuration from an empty user library | 新 startup-onboarding.tsx/provider-library-editor.tsx；app/debug-app/ports/debug-harness；foreground/debug runtime；tests/tui/bootstrap/cli/support | 普通启动自动逐项核验及四步引导；debug 空库共享编辑；同步受影响 DTO/调用方/夹具 | Worker Profile/Manifest 门禁、固定协议/唯一凭据、协调工作区布局不变，无新依赖 |

## 4. 调用与副作用顺序

IP-02 的 record reader 先落定；IP-03/07 使用其 writer。初始路径与远程名称在动作前写入；本地 exclusive mkdir 的 device/inode、远程 nodeId 在取得后立即回读并保存。提交推送后经公开 repo add/set-base-ref/worktree show 登记并核验主 checkout，保存绑定，再创建终端并保存 handle。创建/安装/提交/推送/登记/终端任何失败保存阶段并停止，不建立替代轮次、不自动重发。来源 dirty 标记只描述源码状态。

IP-04 预览只读。执行持有独占回收锁，先核验已知运行资源和两个目标。远程通过 GraphQL 核验保存的 nodeId、名称和 URL，再通过 REST DELETE 删除记录的 owner/name；本地使用保存的目录身份。每项删除前写 deleting，确认后写 deleted；远程 unknown 停止本地动作。远程已明确 missing 或原先从未创建时允许处理本地；创建结果不明而缺 nodeId 时，可回收已证明本地并保留远程 unknown。本地删除前再次 lstat，避免沿用过期预览。锁与状态写入失败不执行下一动作；入口输出原 run 路径及各项结果，失败时非零退出。

IP-05 对 evidence-only 命令先读记录，再解析外置输入，不查询 Git/Scope/Orca。live 命令才核验仓库与明确绑定。collect 的绑定记录更新只发生在命令意图中，不来自 render 或模型调用。

IP-08 在地图创建前先持久化 repository/完整 branch ref/operationId，再把唯一 marker 送入空章节正文；成功记录后回读原 issue。unknown 保留记录，后续仅精确读取或有界 marker 对账，不重发。IP-09 的环境核验每次普通启动自动执行一次，失败显式重试；用户编辑模型和创建/选择地图后最终确认，initializeProject 保存 schema5，再 verify/proposal/initialize。debug home 只读，空库编辑只保存用户库，明确 open 后才核验能力和打开会话，不读 Orca 或项目配置。

## 5. Schema、状态与持久化落实

- run-record.mjs 唯一声明 D-03 schema 与 D-06 状态；setup/cleanup/CLI 不分别定义 DTO。现有 `.mjs` 使用运行时 schema 校验，沿已安装 zod 或现有校验方式，不引入新库。
- preparing/ready/failed 是准备结果；cleanup 的各目标状态独立，不拿业务完成度替代删除结果。deleting 在重开时视为待对账，不启动删除重放。
- run.json 仍64KiB上限、0600及原子替换；临时文件、锁与 retained package 位于外置 round。删除权限不扩展至 round 父目录或用户级配置。
- schema 1 接受既有 nullable 早期字段用于查看，但 live legacy open 按原完整身份合同核验；cleanup 拒绝身份不足，不自动升级。
- Scope 前地图记录独立位于 Git common dir 私有目录，按完整 branch ref percent-encoding 隔离，schema1/revision/operationId/目标/nullable issue 单一 owner，短锁/CAS/原子替换/回读；正文仍归 tracker。
- 无生产 schema/DB 表迁移，无跨 GitHub/文件系统事务。项目 schema5、Manifest v4 与 Worker Profile 门禁不变。远程 nodeId 是归属核验依据，owner/name 同时用于核验与 REST 删除寻址；REST 不提供 expected nodeId 原子条件，回收期间应保持远程目标稳定。无法确认结果就保留 unknown。

## 6. 验收证据矩阵

下面命令中 T1/T2 是普通本地验证；T3 为显式启用的安装验收，安装发生在仓库外的临时演练仓库，不能在 Companion 工作区安装/更新依赖。远程行为由注入外部 runner 的合成回执覆盖；真实平台证据另列 T4。

| Requirement/Scenario | IP-ID | 测试文件 | Fixture/前置条件 | 关键断言 | 可运行命令 |
| --- | --- | --- | --- | --- | --- |
| Isolated：未配置模型也能创建、另一个取消轮次、输出路径拒绝 | IP-02/03/07 | ledger-lab-setup.test.ts | 无模型、无 TTY；合成 GH/pack/install/Orca 回执 | 登记/设置主 ref/创建终端各一次，PATH/明确 executable；零模型调用；不同轮次；内置路径远程调用0次 | T1 |
| Installation：开发仓库变化、打包/安装失败 | IP-03/06 | setup + 新 installed test | 实际 tarball、外置临时 repo；合成 pack/install 故障 | 本地 bin 从 package 启动；源码路径不可访问仍可 help；失败保留阶段 | T1/T3 |
| Configuration：首次启动、能力失败；Secrets：TUI保存Key | IP-06/09 | startup-onboarding/model-settings/debug-app tests；installed test | 空 XDG/项目配置、逐项端口反馈、生产 PTY、scripted-model-server | 自动一次核验/逐项结果、失败显式重试、四步确认才写配置/初始化；失败不启动 loop；无秘密外泄 | T2/T3/T4 |
| Route Map：创建、选择、unknown/并发/目标漂移 | IP-08 | tests/application/route-map-initialization.test.ts | 真实临时 branch record、合成 tracker 回执 | 最多20候选；固定章节；创建前记录；marker 唯一匹配；unknown重开零重发、冲突/漂移拒绝 | T2/T4 |
| Debug：空用户库配置与独立目录 | IP-09 | debug-app/debug-cli/debug-harness-e2e；installed test | 空 XDG、普通目录、共享服务/脚本模型协议 | 同一编辑器保存用户库，明确打开；无需 Orca/项目配置/Worker，不写 Git common dir | T2/T3 |
| Durable：早期中断、回收后列表 | IP-02/04 | setup + 新 cleanup test | nullable身份、missing repo、超限列表、坏记录 | 不 realpath missing repo；准确原路径；有界截断/单项错误 | T1 |
| Failed preparation：unknown创建、边界取消 | IP-03 | 既有 setup test 扩展 | runner unknown/AbortSignal | 创建只1次、不回滚、保留 stage/目标/unknown | T1 |
| Explicit reclaim：预览、完整回收、身份替换、业务改动、运行资源 | IP-04 | 新 cleanup test | 合成 GraphQL 身份查询与 REST DELETE 回执、临时目录；live lease/debug锁/登记回执 | 预览0mutation；REST目标为记录的owner/name；预检发现替换则拒绝；dirty可回收；已知运行不删除 | T1 |
| Partial/unknown：远程成功本地失败、响应丢失、旧记录 | IP-04 | 新 cleanup test | 注入阶段故障/deleting中断/权限失败/schema1 | 两项状态独立；未知不重试；再执行先查询；旧记录0删除 | T1 |
| Reopen：原终端、已退出、未登记、漂移/回收 | IP-05/07 | 既有 setup test | 原repo/精确绑定，live/exited/unverifiable回执，未登记schema2 | 聚焦原handle；确定exited才替换；不可核验零创建；显式补登记；漂移拒绝 | T1 |
| Defaults：未初始化、人工记录/空成品、回收后报告 | IP-05 | 既有setup/process/result/collector tests | 唯一/缺失Scope、已填写模板、保留外置报告 | 无自动初始化；内容不覆盖；空成品BLOCKED；离线报告可运行 | T1 |
| Structured：外部调用失败 | IP-03/04 | setup + 新 cleanup test | 命令拒绝/unknown/invalid JSON | exit2、causeCode、run路径、各目标状态；不精确断言完整文案 | T1 |
| 合同移交与工程检查 | IP-01–09 | 规划材料/现有工具链 | 已归档前驱、同路径delta仅1份、共享文件串行 | 原lab剩余真实验收未勾选；IC-12/14/16与实现一致 | T5 |

T1：`pnpm exec vitest run tests/acceptance/ledger-lab-setup.test.ts tests/acceptance/ledger-lab-cleanup.test.ts tests/acceptance/ledger-lab-collector.test.ts tests/acceptance/ledger-lab-process.test.ts tests/acceptance/ledger-lab-result.test.ts`

T2：`pnpm exec vitest run tests/tui/startup-onboarding.test.tsx tests/tui/model-settings.test.tsx tests/tui/debug-app.test.tsx tests/application/route-map-initialization.test.ts tests/bootstrap/foreground-planning-runtime.test.ts tests/bootstrap/worker-model-settings.test.ts tests/cli/debug-cli.test.ts tests/integration/debug-harness-e2e.test.ts`

T3：`pnpm build`，然后 `ORCA_COMPANION_LAB_INSTALL_ACCEPTANCE=1 pnpm exec vitest run tests/acceptance/ledger-lab-installed.test.ts`。使用真实 pnpm pack/安装、tuistory 和 scripted-model-server 的协议服务；普通启动核验/引导与 debug 空库配置从实际输入进入共享编辑器，不预写项目配置或用户 Provider Library。包启动测试访问 provider-catalog JSON，debug 完成一轮对话/只读工具并 Ctrl+C，服务请求归零。测试隔离源码可访问性使用临时打包源或子进程约束，不能改名/覆盖用户开发目录。合成 Orca/gh 回执只证明装配和可观察行为；真实登记/终端/Scope 初始化由 T4 另验，T3 不冒充此证据。

T4：在明确获准的独立 main 轮次执行 `pnpm lab:new --root /abs/isolated-lab-root`，核验真实 GH 仓库、自动 Orca 登记与原生终端；由用户运行 ocp，完成环境核验、TUI 模型配置、地图创建/选择及 Scope 初始化，再采集。用户停止本轮运行、关闭终端、解除登记，cleanup 预览后明确 `--yes`；回读删除状态，核验本地/远程缺失、登记解除与外置证据保留。保留 GH ID、安装来源、TUI 操作与公开查询证据。2026-10-10 已完成该限定生命周期，见 verification.md。cancel 档案的隔离与 profile 记录由 T1 覆盖，不重复要求另一轮完整真实生命周期；debug 与模型能力沿 T2/T3 的既有检查记录，现场未运行的 debug/doctor 不记为真实 provider 验收通过。现场 TUI 缺陷继续记录并等待修复；真实 Scope Cancel 与完整业务剧本仍由原 lab tasks 5.2/5.3 承接。

T5：`pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm lab --help`、`openspec validate simplify-ledger-lab-lifecycle --strict`、`openspec validate add-ledger-lab-rehearsal-infrastructure --strict`、`git diff --check`。只有新增失败/未解决风险才扩大或重复测试，不为文案增加 snapshot。

## 7. 文件清单与升级条件

新增：

- `artifacts/ledger-lab/run-record.mjs`：schema/save/read/list，移出原 setup 的同职责代码。
- `artifacts/ledger-lab/cleanup.mjs`：预览/删除、目标核验与独立结果。
- `tests/acceptance/ledger-lab-cleanup.test.ts`：真实临时目录 + 合成远程回执验证删除边界。
- `tests/acceptance/ledger-lab-installed.test.ts`：显式启用真实安装与 PTY 配置链路。
- `src/application/planning/route-map-initialization.ts`：Scope 前地图窄端口、固定章节复用与 unknown 对账用例。
- `src/adapters/storage/route-map-initialization.ts`、`src/adapters/tracker/gh-route-map-initialization.ts`：branch record 短锁/CAS/原子写及公开 gh transport。
- `src/interfaces/tui/screens/startup-onboarding.tsx`、`src/interfaces/tui/components/provider-library-editor.tsx`：自动逐项核验、四步引导与共享编辑器。
- `tests/application/route-map-initialization.test.ts`、`tests/tui/startup-onboarding.test.tsx`：稳定创建/unknown/并发边界与确认流程。

修改：

- `artifacts/ledger-lab/setup.mjs`：prepare pack/install/登记/终端，按schema精确重开/采集绑定；`lab.mjs`：移除configure/settings，添加list/cleanup及用途分离。
- `package.json`：package files清单；不改根依赖及lockfile。
- `tests/acceptance/ledger-lab-setup.test.ts`：改prepare合同、保留unknown/重开/证据边界，删向导夹具与用例；仅必要时扩展 `tests/tui/model-settings.test.tsx` 的既有行为用例。
- `tests/support/scripted-model-server.ts`：补无请求体的模型目录 GET 响应，供真实 TUI 发现流程使用；不修改生产协议与能力判定。
- `src/bootstrap/foreground-planning-runtime.ts`、`src/interfaces/tui/app.tsx`/`ports.ts`：ScopeSetup 核验回调、地图接线与首次配置顺序。
- `src/application/ports/debug-harness.ts`、`src/bootstrap/debug-runtime.ts`、`src/interfaces/tui/debug-app.tsx`：同一 library/catalog 服务与空库编辑；相关 tests/tui/bootstrap/cli 同步调用方和夹具。
- 根 `README.md`、`AGENTS.md`、`docs/architecture.md`、`docs/interface-contracts.md`、`artifacts/ledger-lab/{README,guide,capabilities}.md`：当前登记/终端、自动核验/四步引导、地图持久创建、debug空库和显式回收；不写实现过程到产品界面。
- `openspec/config.yaml` 及原 active lab 的 proposal/design/implementation-plan/tasks：批次纠偏和合同移交；删除该change的 `specs/testing/ledger-lab-rehearsal/spec.md`，保留本change版本。

删除：`artifacts/ledger-lab/wizard.mjs`、`src/bootstrap/ledger-lab.ts`、`tests/bootstrap/ledger-lab.test.ts`。先核验所有引用只来自本次待删/改文件，再删；不删用户的 `ledger-lab.json`。

保护：生产 `worker-model-settings.ts`、唯一 CredentialStore/ProviderLibrary ownership、模型probe、Controller/agent loop、协调工作区布局/键位、业务contract/cases、上游submodule、用户旧轮次和未提交改动。启动引导与共享编辑限定 D-04/08/09 的批准范围；其他生产/TUI redesign另开change。

## 8. 验证归属与限定审计

验收范围是 IP-01–09/T1–T5 的工件一致性与可观察行为。普通审计不执行真实远程删除或付费模型，不读取秘密，不改生产状态。真实 T4 已在用户明确指定并授权的 main 轮次完成上述限定生命周期；授权不能从测试开关推断，结果不扩展为 Scope Cancel、完整业务或全部 TUI 体验通过。

父任务自查标签：`package-independent`（包无开发路径/答案依赖）、`no-model-in-prepare`（登记/终端不调用模型）、`deletion-identity`（ID/目录替换拒绝）、`partial-unknown`（中断先对账）、`retained-evidence`（回收后报告）、`tui-user-path`（配置来自真实输入）、`route-map-operation`（唯一 marker/原身份不重发）、`spec-handoff`（同路径唯一合同）。父任务完成必要工程检查后撰写 verification.md，无独立验证 Agent；标明合成/本地PTY/真实平台边界及实际实现基线。文档任务不修改 tasks 或 verification，未执行真实验收不勾选。本次不提交或归档。
