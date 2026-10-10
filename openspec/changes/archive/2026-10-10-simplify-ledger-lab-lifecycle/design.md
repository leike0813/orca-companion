## Context

规划 HEAD：`a29704bc7226c215f2bb14d1503211af82867c5f`。当前准备链由 `artifacts/ledger-lab/setup.mjs` 拥有；`lab.mjs` 分派命令，`run.json` 原子替换保存轮次。现有 record reader 把格式读取和 live 身份检查混在一起，早期失败及仓库删除后无法读取。当前没有根级 registry，新增一份索引会制造第二个事实源。

生产 Home 允许缺失项目配置，通过 `ModelSettingsPort.initializeProject` 写入 schema 5。首次启动复用用户库编辑器，并通过 Scope 前的窄端口创建空 Route Map 或选择既有 issue；最终确认后核验并初始化 Scope。参照 `CONTEXT.md`、`docs/architecture.md` MOD-02/04/05/06/07、`docs/interface-contracts.md` IC-03/04/12/13/14/16；lab 不取得生产 Scope 或模型配置的 ownership。

## Goals / Non-Goals

**Goals:** 仓库内独立安装当前 ocp；用户正常操作 TUI 配置；准确记录创建与回收；保留外置验收材料；失败可定位且不会自动重复外部动作。

**Non-Goals:** 协调工作区重新设计、全业务剧本自动化、仓库池/批量删除、自动停止 Worker、自动 Orca 注销、全机器进程审计、凭据迁移、发布 npm 包或 Windows 支持声明。

## Decisions

### D-01：准备建立仓库、安装环境与 Orca 项目终端

`prepareLab` 核验 Node24/pnpm11、Git 作者、GitHub 登录、外置路径及本机 Orca 可达性。准备不读取模型库或凭据、不创建 issue 或 schema 5 项目配置、不运行模型探针或 doctor。

流程为：预检 → 分配轮次并写初始记录 → 创建本地主 checkout 并记录目录身份 → 创建私有 GitHub 仓库并记录 ID → 打包当前 ocp → 安装 → `pnpm exec ocp --help` 检查入口 → 最小环境文件首次提交/推送 → 公开 Orca 登记、设置 `origin/main`、精确核验主 checkout → 打开并记录原生项目终端 → 标记 `ready`。每个外部动作仍先记录阶段；异常、取消与 unknown 保留现场，不自动重做。

待测仓库包含最小 README、忽略规则、安装用 `package.json`/lockfile、只放行 `better-sqlite3` 安装构建的 `pnpm-workspace.yaml` 与最小 OpenSpec 配置；没有业务 `src`、参考图和配置答案。pnpm 11 默认拒绝未放行的依赖构建，真实安装检查证明该 SQLite 依赖需要明确允许；这是 ocp 环境安装文件，不是业务依赖许可。轮次目录保留 `repo/`、`operator/`、`captures/`、`checks/`、`packages/`、`run.json`，新轮次不生成 `bin/` wrapper。Orca 原生登录 shell 只补本轮 `node_modules/.bin` PATH 和明确 `ORCA_CLI_COMMAND`，用户直接输入 `ocp` 或 `ocp --debug`；不换 shell、不全局安装、不自动运行模型。

Owner：lab setup。选择删除 lab 特殊配置链，避免继续维护第二套模型设置；不把 doctor 报错绕过后当成能力通过。

### D-02：从打包快照安装，禁止可变开发路径依赖

`lab:new` 保留现有先 build 的脚本。每轮执行 `pnpm pack --pack-destination <round>/packages`，把生成的 tarball 作为 `file:../packages/<tarball>` devDependency 安装到新仓库；安装使用正常 pnpm 参数数组和真实用户环境，支持超时/取消，不修改开发仓库依赖。记录包版本、tarball 路径、sourceHead/sourceDirty、实际安装阶段结果。

根 `package.json` 增加 `files: ["dist/src"]`；该目录应包括 tsc 复制的 `adapters/agents/provider-catalog.json` 与所有运行时 JS。npm 默认随包的 manifest/README/license 可保留；不打包 tests、lab 验收答案、references 或整个 dist。真实 tarball 的安装启动测试核验资源完整性，不靠静态字符串断言。

本轮执行只依赖已安装包；后续开发仓库重建不影响它。重装需要仍保留的外置 tarball。这是本地演练包，不承诺远程 clone 后立即能重装；不采用全局安装、workspace/link 或指向开发 dist 的 wrapper。

Owner：根 package 打包合同 + lab setup。无新增依赖；旧 `worker-model-settings.ts` 仍服务生产，不删除。

### D-03：单份 schema 2 run.json，读取与 live 核验分开

记录继续以 round 内 `run.json` 为唯一事实源，最大 64 KiB，原子临时文件替换，文件 0600；不增加根级索引。DTO 字段分为：

| 字段 | 合同 |
| --- | --- |
| schemaVersion/kind/id/profile | `2` / `ledger-lab-run` / 唯一轮次身份 / main 或 cancel |
| repositoryPath/branch/companionRoot/createdAt | canonical 绝对路径、固定 main ref、来源路径与时间；读取不要求来源开发目录存在 |
| state/stage/failureCode | preparing/ready/failed 与已持久化阶段；准备状态与回收状态分开 |
| localIdentity | nullable `{device, inode}`，使用字符串存储；exclusive mkdir 后立即从原目录 lstat 记录 |
| github | `{host, nameWithOwner, url, nodeId}`；目标先写，未取得的 url/nodeId 为 null；nodeId 使用 GitHub GraphQL 不可变 ID |
| installation | nullable `{packageVersion, packagePath, sourceHead, sourceDirty}`，不是能力核验结论 |
| baselineHead | nullable 首次环境提交 HEAD，仅供审计，不用于限制回收 |
| orca | nullable `{executable, repoId, worktreeId, terminalHandle?}`；准备经公开命令登记和核验后保存，创建终端后保存原句柄；早期失败或未登记旧记录可为空 |
| cleanup | `{local, remote}`；各项 `{state, code, observedAt}`，state 为 pending/deleting/deleted/rejected/failed/unknown |

字段有单一 schema 校验入口，允许失败阶段的 nullable 身份。`readRun` 只验证记录/round 路径关系，不 realpath 已删除 repo；open、collect 和 cleanup 各按用途做 live 检查。repo 必须是 canonical round 的直属 `repo`，lstat 拒绝 symlink，device/inode 用于识别同路径换目录；不使用初始 HEAD、业务内容 hash 或目录 clean 状态作身份证明。

`list [--root ABS_DIR]` 只列指定根目录的直接 round 记录，最多输出 100 项；读坏记录作为单项错误返回，不吞掉其他轮次。超过数量明确 `truncated`，不自动操作最新轮次。所有动作仍由 `--run` 指定。

### D-04：自动环境核验与正常 TUI 配置

`StartupOnboarding` 每次普通启动经 `ScopeSetupPort.verifyEnvironment(onCheck)` 自动核验 repository、Orca 与 identity，每项按真实完成结果显示 ✓/✗，当前核验显示 spinner。一次启动只执行一次自动核验，失败后用户显式重试，重绘不触发副作用。环境通过后精确恢复匹配 Scope；无配置则显示环境、Coordinator、Route Map、最终确认四步，有配置无 Scope 则复用配置进入确认，legacy 仍走显式 Review。

Coordinator 步骤复用 `ProviderLibraryEditor` 和既有 provider 状态转换、DialogFrame；支持复用连接或保存服务/协议、地址、隐藏 Key、模型及可信 effort。Key 只进入 IC-14 CredentialStore。地图步骤经 D-08 创建空地图或有界查询后按编号选择。最终确认才经 initializeProject 按 CAS 创建 schema 5，随后核验模型/tracker，通过后初始化 Scope/cycle/session。配置保存成功不等于 Scope 已创建；失败保留已保存用户库/地图与现场，不跨文件回滚。

Worker Profiles 不作为规划或 debug 前提；执行额度、权限及五个角色仍按现有模型设置和完整 Manifest v4 门禁设置。外置 `contract.json` 仅供操作者对照。

所有配置输入来自用户操作，准备不得写入替代配置。生产能力 probe 在启动/应用入口执行；用户也可显式运行 `ocp doctor` 保存报告。启动核验与 doctor 都可能产生模型费用，prepare 不产生模型调用。配置失败保留已安装仓库，不更改准备结论。

`open --run` 对 schema 2 核验原 canonical Git/安装/Orca 身份，按记录的 terminalHandle 精确查询并聚焦；只有明确无 PTY 且存在退出原因才创建替代终端并保存新句柄，无法核验则停止。旧 schema 2 未登记现场可在显式 open 时经公开命令补登记，已有绑定不退回当前默认 Orca 或猜最新终端。`collect --run` 只核验精确 worktree 并保存绑定，不创建 Scope/终端或推进业务。schema 1 保留既有重开行为。

沿用 `docs/dev/tui-implementation-handoff.md` 的 #52 dialog final、#47 composer、#40 transcript 来源，本 change 的启动步骤呈现为用户已批准范围，协调工作区不重新布局。真实安装包 PTY 验证启动引导与共享模型编辑，并从空用户库启动 debug 对话；真实 GitHub/Orca 登记、终端与 Scope 初始化另列 T4。调用 fake application port 的组件测试不能单独充当此链路证据。

### D-05：显式回收，身份检查只服务删除目标

接口：

```text
pnpm lab list [--root ABS_DIR]
pnpm lab cleanup --run ROUND_DIR
pnpm lab cleanup --run ROUND_DIR --yes
```

默认 cleanup 只读预览；`--yes` 是对这一轮完整本地/远程删除的明确意图。执行时对该 round 持有 exclusive `cleanup.lock`，拒绝并行回收；不自动破残留锁，错误给出现场位置。锁不参与生产 controller 或 Git 写锁。

执行前校验 record、localIdentity、原远程 nodeId 和可观测运行资源。相关 Scope 的运行租约通过现有只读 store 查询；匹配 debug 目录的 session writer lock 只读检查持有者。活跃或无法核验的已知持有者拒绝删除，既有锁不回收。通过公开 `worktree show` 对 exact 记录 ID 或明确路径检查登记；仍有登记则拒绝，显示 repo/worktree ID 和手工处理步骤。未使用 Orca 的空轮次不要求安装/启动 Orca；已有绑定但 Orca 不可达属于无法核验，不假定已注销。检测仅针对本轮可见资源，不承诺发现所有任意程序；用户仍须先关闭自己启动的进程。

手工注销说明采用 `docs/orca-compatibility.md` 已验证的公开路径：处理/释放相关 Worker → 关闭相关终端 → `orca project setup-delete --setup <repoId>`。setup-delete 不删磁盘；禁止用不存在的 repo remove、受保护 main 的 worktree rm 或全局 orchestration reset。回收脚本只检验此前置结果，不自动承担这些操作。

删除顺序：预检两项目标 → 远程 → 本地。远程先通过 GraphQL 查询记录的 nodeId 和 owner/name，核验两者指向同一仓库，且 ID、名称、URL 均与记录匹配；随后通过 `gh api --method DELETE --hostname <host> /repos/<owner>/<repo>` 删除，以 REST 成功响应确认结果。公开接口见 [GitHub 删除仓库文档](https://docs.github.com/en/rest/repos/repos#delete-a-repository)。预检发现不同 ID、权限失败或未取得原 ID 时不发送远程删除请求。远程缺失的判断必须来自成功鉴权的明确查询，不把鉴权失败、隐藏权限或网络错误当成已删除；不能区分不存在与不可见时记录 unknown，提供手工核验说明。

REST 删除按 owner/name 寻址，不能附带 expected nodeId 作为原子条件。身份核验与删除之间若发生仓库重命名或同名替换，仍存在删除其他仓库的风险；回收期间应保持远程目标稳定。回收锁只排除同一 round 的并行回收，不锁定 GitHub 上的外部操作。

本地删除只覆盖已核验原目录及其内容。dirty 文件、新 HEAD 和业务分支内容本来属于整轮回收范围，不设置回到 baseline 的门禁。任何路径/目录身份变化都拒绝；本地已缺失可以确认本项目标完成。整个 round 不删，GitHub issue 随远程仓库删除，用户级模型库/凭据/debug 历史不删。

### D-06：两项目标独立结果，unknown 先对账

每项删除前先写 `deleting`，成功核验后写 `deleted`；拒绝/确定失败/结果不明分别写 rejected/failed/unknown 与固定错误码。单次调用发生 remote unknown 即停止后续删除，不重发请求；进程在 deleting 状态中断时，下次按 unknown 对账。

后续明确执行先读取原目标事实：已确认缺失则完成；原 ID 仍存在且匹配则可在用户新一次 `--yes` 下重试；替换、权限错误和不可观测结果仍拒绝/unknown。已完成项跳过。没有资源 ID 的创建失败可以回收已证明的本地目录，远程保留 unknown 并要求手工处理；不把两项部分完成输出成全部成功。

入口保持既有 stderr envelope 和 exit 2，并在结构化结果中返回两项状态、run 位置与固定 causeCode（identity mismatch / active resource / identity missing / operation unknown / command failed）。预览不改记录；记录写入失败时停止新的副作用。

### D-07：保留证据与移交原 lab 合同

schema 1 reader 保持可查看、既有 open/验收命令可用；该版本缺少本地目录身份及远程 nodeId，自动回收拒绝，不通过当前名称查询补造历史归属。指南给出旧现场的手工核验/删除说明；本 change 不实际清理用户旧轮次。

仅基于外置文件的 verify-process/report 不要求 live repo，`resolveRunOptions` 按命令分离用途；collect/verify-result 在 repo 缺失时给出结构化不可用。业务合同、collector/verifier 的证据语义不变。

实施时从原 active lab 移交 `testing/ledger-lab-rehearsal` delta 到本 change，同步其 proposal/design/implementation-plan/tasks 的受影响描述，保留原 TUI scope-initialization delta 和未完成真实业务验收。本 change 先同步/归档这一 capability，原 lab 后续只引用当前合同。历史实施事实可以保留并标明被哪个设计取代，不能把未执行验收勾成完成。

更新 `openspec/config.yaml` 已归档 core 状态及本次 lab 解阻塞例外；不编辑 archived core。删除仅供 lab 使用的 `wizard.mjs`、`src/bootstrap/ledger-lab.ts`、对应 bootstrap 测试及旧向导用例，生产配置服务不迁移。

### D-08：Scope 前的 Route Map 创建身份与对账

应用 owner 为 `src/application/planning/route-map-initialization.ts`，公开窄端口只有 list/select/create，返回 ok 或结构化 failed。list 最多 20 项；select 核验目标仓库精确 issue、URL 与领域唯一标题表定义的六个固定章节；create 只填空章节和唯一 operation marker，不填业务内容、不创建 Scope 或 Session，也不进入 Coordinator 工具面。

Bootstrap 从当前仓库解析可信 repository 与完整 branch ref，tracker adapter 在 `src/adapters/tracker/gh-route-map-initialization.ts` 用公开 gh 参数数组显式指定仓库。record adapter 在 `src/adapters/storage/route-map-initialization.ts` 将 schema 1 的 revision/operationId/repository/fullBranchRef/title/nullable issue 保存于 Git common dir 私有 branch record；短 exclusive 锁、CAS、原子替换与回读拒绝并发覆盖。记录不是 coordination.sqlite，不迁移生产 DB。

唯一创建请求前先 begin 落盘稳定 operationId，正文附 `<!-- orca-companion-route-map-operation:<operationId> -->`，成功后保存并精确回读 issue。unknown、回执不可核验或写后失败保留原记录；再次 create 只读已记录 issue，或在最多 20 项中找原 marker 的唯一匹配。零个或多个匹配返回 create_unresolved，不证明未创建，不换 ID 重发；用户可显式 select 核验并绑定既有 issue。模型/用户不得填写操作身份或凭据。

### D-09：debug 空用户库复用同一模型编辑器

`DebugHarnessPort.providerLibrary` 仅暴露既有 `{library,catalog}` 应用服务；debug-runtime 用唯一 CredentialStore 装配，不建立第二份 TUI 模型端口。空库由 `ProviderLibraryEditor` 保存连接与模型，再以用户选择的 modelRef/effort 明确新建；继续绑定既有会话的固定快照。home 只读，open 才核验能力、取得写者并打开会话；失败不降级或自动重试。

debug 允许普通非 Git 目录，不要求 Orca、项目配置、Route Map、Scope 或 Worker Profiles，也不写 Git common dir。会话/checkpoint/UI 输入/诊断仍留用户状态目录；IC-04/13/16 的轮次、输入保护和 writer lock 规则保持原样。零新增依赖。

## Risks / Trade-offs

- 远程回收需要 GitHub 账号已有删除权限，普通准备只需创建权限；权限不足可创建而无法回收，必须如实保留状态。
- 外置 tarball 是本地重装依据，仓库推送的相对 file 依赖不能充当公开发布包；这是演练框架的范围。
- 本地身份使用 Ubuntu 文件系统的 device/inode；原目录被搬移到别的文件系统或恢复为新 inode 时需手工处理，不增加强制回收开关。
- 完整实操仍需用户配置、最终确认与执行授权；prepare 不付费探测，普通启动/应用和 doctor 可产生模型费用。回收不保证任意外部程序已退出，已知租约/锁/登记阻塞会说明具体资源。
- 网络响应丢失后的远程不可见可能无法证明已删除；这种现场保留 unknown 和证据，手工核验，不添加通用补偿机制。

## Migration Plan

先核验已归档直接前驱及冻结接缝，再串行移交 active lab 合同、删除旧设置链、实现记录/安装/登记/终端/回收及启动引导、地图窄端口和 debug 用户库编辑，更新文档。旧 `ledger-lab.json` 不再读取或改写，保留用户文件。新准备只写 schema 2；旧 schema 1 不自动升级。生产 schema 5、Manifest v4 与 Worker 门禁不变，无 DB migration 或新增依赖。

验收使用合成外部命令验证危险边界，并从真实打包产物测试安装与 TUI 配置。真实 GitHub/Orca main 轮次的限定框架生命周期 T4 已于 2026-10-10 完成，cancel 档案隔离由 setup acceptance 覆盖；真实 Scope Cancel 归原 lab 业务验收。真实平台操作及付费 provider 测试只在明确获准的隔离轮次执行。父任务完成工程检查后直接写 verification.md，无需独立验证 Agent；报告区分合成、本地 PTY 与真实平台证据，不把未运行项或未修复的 TUI 缺陷记为通过。

## Open Questions

无影响实现范围的未决问题。真实模型/远程环境与费用授权是执行验收时的输入，不能用默认批准替代。
