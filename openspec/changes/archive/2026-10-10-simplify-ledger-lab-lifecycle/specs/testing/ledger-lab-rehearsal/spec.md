## Purpose

定义 ledger-lab 独立实操现场的创建、仓库内安装、Orca 登记与原生终端、正常启动配置、持久记录和显式回收。用户通过生产 TUI 配置模型、创建或选择地图并确认 Scope 初始化；仓库外的材料、证据和报告用于重开、调查失败及核验回收结果。

## ADDED Requirements

### Requirement: Isolated canonical rehearsal rounds

`pnpm lab:new` SHALL 创建新的 `main` 轮次，`--profile cancel` SHALL 创建独立取消轮次。每轮 SHALL 在 Companion 仓库外分配新目录、新私有 GitHub 仓库和 `main` 主 checkout，安装本轮 ocp，建立首次提交并推送至该轮 `origin/main`；准备 SHALL 经公开 Orca 命令登记仓库、设置 `origin/main`、精确核验主 checkout 并打开原生项目终端，持久保存实际绑定与 terminal handle。操作者材料、参考图、映射、观察、安装包、证据与报告 SHALL 保持在待测 checkout 外。准备 SHALL NOT 创建业务实现、Route Map、项目模型配置、Scope、Session、执行图、Orca Run 或 Task，SHALL NOT 运行模型探针、自动启动 ocp 或更新上游 submodule。

#### Scenario: 未配置模型也能创建

- **WHEN** Node/pnpm、Git 作者身份及 GitHub 认证满足要求，本机 Orca 可达，操作者未配置模型，运行 `pnpm lab:new`
- **THEN** 系统 SHALL 返回新轮次目录、仓库绝对路径、远程及 Orca 身份与终端句柄；仓库 SHALL 为干净的 `main` 主 checkout，原生终端 SHALL 可直接运行 `ocp` 或 `ocp --debug`，准备 SHALL 不请求模型或模型目录

#### Scenario: Orca 不可达

- **WHEN** 准备预检无法核验本机 Orca 可达
- **THEN** 系统 SHALL 在创建本轮本地/远程资源前拒绝，SHALL 不把缺少登记与终端的现场标记为 ready

#### Scenario: 创建另一个取消轮次

- **WHEN** 操作者运行 `pnpm lab:new --profile cancel`，runs 根目录已有主轮次
- **THEN** 系统 SHALL 分配新轮次和新资源，SHALL NOT 复用或覆盖原现场

#### Scenario: 输出路径位于开发仓库内

- **WHEN** runs 根目录解析后位于 Companion 仓库内
- **THEN** 准备 SHALL 拒绝该路径，并在远程创建前停止

### Requirement: Repository-local companion installation

每轮 SHALL 在仓库内安装当前开发版本打包出的 ocp，提供正常 bin 入口；原生项目终端 SHALL 只补本轮 `node_modules/.bin` PATH 与明确 `ORCA_CLI_COMMAND`，允许直接运行 `ocp` 或 `ocp --debug`，其他终端可用 `pnpm exec ocp`。安装来源 SHALL 记录包版本、源码 HEAD、dirty 标记及外置包路径。安装后的程序 SHALL 使用本轮包内运行时代码与资源，不读取开发仓库的 dist 或依赖全局安装。仓库 SHALL 只含环境安装所需的最小文件，不包含参考实现或验收答案。

#### Scenario: 开发仓库随后发生变化

- **WHEN** 本轮安装完成，开发仓库后续重建或不可访问
- **THEN** 本轮 `pnpm exec ocp --help` SHALL 仍可运行，安装版本 SHALL 保持原包内容

#### Scenario: 打包或安装失败

- **WHEN** 包构建、打包或仓库内安装失败
- **THEN** 准备 SHALL 返回非零状态，记录失败阶段并保留已有现场，SHALL NOT 宣称可启动

### Requirement: Configuration through the normal TUI

普通 TUI 每次启动 SHALL 自动核验 repository、Orca 与 identity，逐项反馈真实完成结果及当前核验 spinner；失败 SHALL 等待用户显式重试。无项目配置时 SHALL 按环境、Coordinator 模型、Route Map 创建或选择、最终确认四步引导，复用用户库模型编辑器。最终确认后才 SHALL 保存 schema 5、核验模型/tracker，并初始化 Scope/cycle/session；已有配置与精确 Scope 恢复 SHALL 沿既有身份规则。Worker Profiles SHALL 不作为规划或 debug 前提，执行权限、预算与完整角色配置 SHALL 仍由 Execution Authorization 门禁核验。准备成功只 SHALL 表示仓库、安装、登记与终端完成，不表示模型能力或业务验收通过。lab SHALL 不提供独立模型设置文件、配置向导或 `configure` 命令。

#### Scenario: 首次启动尚无项目配置

- **WHEN** 操作者在准备的原生项目终端启动 `ocp`，尚无项目配置
- **THEN** 系统 SHALL 自动逐项核验环境，再引导用户设置模型、创建或选择地图，最终确认后才保存项目配置并核验、初始化；准备记录 SHALL 不被当作 Scope 业务事实

#### Scenario: 核验失败后显式重试

- **WHEN** 普通启动的某项环境核验失败，或界面重绘/resize
- **THEN** 系统 SHALL 保留各项真实结果和失败原因，SHALL 不自动重跑核验或发起地图/配置/Scope 写入；用户显式重试才 SHALL 再执行环境核验

#### Scenario: 最终确认前退出

- **WHEN** 用户已保存连接/模型或已创建空地图，但在最终确认前退出
- **THEN** 系统 SHALL 不创建项目配置或 Scope，SHALL 保留已经保存的用户库与 tracker 事实，不执行跨文件回滚

#### Scenario: 模型能力核验失败

- **WHEN** 用户在 TUI 选择模型后，生产能力核验未通过
- **THEN** TUI SHALL 按既有配置合同反馈失败并阻止对应启动/应用；已创建的轮次 SHALL 保留，失败 SHALL 不被改写为 `lab:new` 的安装失败

### Requirement: Pre-scope Route Map initialization

Scope 前 Route Map 初始化 SHALL 只有 list/select/create 窄应用端口，不暴露给 Coordinator。Bootstrap SHALL 提供可信 repository 与完整 branch ref；list SHALL 最多返回 20 个候选，select SHALL 核验精确 issue 身份/URL 及领域固定章节，create SHALL 只填空章节与唯一 operation marker。创建前 SHALL 在 Git common dir 私有目录按完整 branch ref 持久保存 schema 1 的稳定 operationId、目标、revision 与 nullable issue，以短 exclusive 锁、CAS、原子替换及回读保护；该记录 SHALL 不创建 Scope 或新增生产 DB migration。创建成功 SHALL 保存并回读原 issue；unknown、回执不可核验或写后失败 SHALL 保留原记录，后续只 SHALL 精确读取原 issue 或有界匹配原 marker，不更换操作身份或重发创建。

#### Scenario: 创建空地图并选择既有地图

- **WHEN** 用户在引导中明确选择创建空地图，或输入既有 issue 编号
- **THEN** 创建 SHALL 先保存操作身份，再发送一次带唯一 marker 的空章节正文；选择 SHALL 只核验目标仓库中的该编号与固定章节，成功返回 number/url，不创建 Scope

#### Scenario: 创建响应丢失后重开

- **WHEN** 原创建结果不明，用户重开引导并再次选择创建
- **THEN** 系统 SHALL 复用原 branch record，在最多 20 项中按原 operation marker 对账；唯一匹配才 SHALL 绑定原 issue，零个或多个匹配 SHALL 返回 create_unresolved，SHALL 不再发送创建请求

#### Scenario: 并发记录或目标漂移

- **WHEN** 原记录存在并发更新，或当前 repository/完整 branch ref 与记录不符
- **THEN** 系统 SHALL 结构化拒绝冲突/漂移，不覆盖操作身份或发起替代创建

### Requirement: Debug configuration from an empty user library

`ocp --debug [directory]` SHALL 允许普通非 Git 目录，不要求 Orca、项目配置、Route Map、Scope 或 Worker Profiles。空用户库 SHALL 使用与普通启动相同的 ProviderLibraryEditor 和唯一 CredentialStore/ProviderLibrary/Catalog 保存连接与模型；DebugHarnessPort SHALL 只提供现有 library/catalog 服务入口，不建立第二套模型或凭据端口。用户 SHALL 明确新建或继续，open 才核验能力并打开固定配置快照的会话；home SHALL 只读。会话/checkpoint/UI 输入/诊断 SHALL 保持用户状态目录归属，不写 Git common dir。

#### Scenario: 空库调试首次配置

- **WHEN** 用户在无 Orca、无项目配置的普通目录运行 `ocp --debug`，用户模型库为空
- **THEN** 用户 SHALL 能经共享编辑器保存连接与模型，以 modelRef/effort 明确新建并核验能力后进入会话，SHALL 不创建协调事实或项目配置

#### Scenario: 继续使用既有快照

- **WHEN** 用户明确继续该目录已有调试会话，而用户库随后发生变化
- **THEN** 系统 SHALL 使用会话已绑定的不可变配置快照，经既有能力/写者核验打开，不从当前项目或最新用户模型推断替代绑定

### Requirement: Coordinator secrets stay in the credential store

Coordinator Key SHALL 只通过生产 TUI 的用户级 CredentialStore 保存，项目配置仅保存不透明引用。Worker 认证 SHALL 由 harness 的真实用户环境提供。准备与回收 SHALL 不读取或复制这些凭据；秘密 SHALL 不出现在轮次记录、命令参数、诊断及验收材料中。

#### Scenario: TUI 保存新 Key

- **WHEN** 用户在新轮次 TUI 中隐藏输入并保存合法 Coordinator Key
- **THEN** 项目配置 SHALL 只保存凭据引用，轮次文件与准备输出 SHALL 不包含 Key

### Requirement: Durable creation records

每轮 SHALL 在创建本地及远程资源前持久保存轮次 ID、预定绝对路径、远程目标和当前阶段，并在取得资源后记录可核验身份。远程身份 SHALL 包含 host、owner/name、URL 与不可变仓库 ID；本地身份 SHALL 能区分原目录与同路径替换目录；Orca 登记和终端创建后 SHALL 保存实际 executable/repoId/worktreeId/terminalHandle。记录 SHALL 可在准备失败、本地目录缺失及回收后读取，不依赖 live Git/Orca 资源存在。`pnpm lab list` SHALL 在指定 runs 根目录内有界列出轮次、路径与准备/回收状态，明确输出截断情况；SHALL 不自动选择最新轮次执行操作。

#### Scenario: 早期中断仍能找到目标

- **WHEN** 准备在 Git 初始化或远程创建期间失败
- **THEN** 保留记录 SHALL 给出原目标路径、远程目标、已知身份和失败阶段，列表 SHALL 能发现该轮次

#### Scenario: 仓库已经回收

- **WHEN** 本地仓库目录已被删除
- **THEN** `list` 与记录读取 SHALL 仍可展示本轮及回收状态，SHALL 不因无法解析仓库 realpath 而丢失记录

### Requirement: Failed preparation retains its original resources

准备失败或取消 SHALL 保存原阶段与失败码，保留已创建的目录和远程资源并报告现场位置。不确定结果 SHALL 不自动换身份重试、删除或猜测成功；预检拒绝 SHALL 不为记录拒绝而创建轮次。仅明确调用回收入口才 SHALL 进入删除流程。

#### Scenario: GitHub 创建结果不明

- **WHEN** 创建调用超时、取消或响应无法核验
- **THEN** 系统 SHALL 保留目标名称及不确定状态，仅尝试该次创建；未取得不可变远程 ID 时 SHALL 不允许自动按名称删除远程仓库

#### Scenario: 阶段边界取消

- **WHEN** 用户在阶段边界取消
- **THEN** 准备 SHALL 保存现场并停止后续副作用

### Requirement: Explicit repository reclamation

`pnpm lab cleanup --run ROUND_DIR` SHALL 只预览本轮本地/远程删除目标、身份、前置条件与保留项；加 `--yes` 才 SHALL 执行。删除 SHALL 以记录中已核验归属的目标为依据，预检发现符号链接逃逸、同路径替换目录或同名不同 ID 的远程仓库时 SHALL 拒绝；普通业务提交与 dirty files SHALL 不影响归属判定。远程删除前 SHALL 通过 GraphQL 核验记录的 nodeId、owner/name 和 URL，再通过公开 REST `DELETE /repos/{owner}/{repo}` 按记录名称寻址。该接口无法以 nodeId 为原子删除条件，回收期间应保持远程目标稳定。用户 SHALL 先停止相关 ocp/Worker 并解除 Orca 登记；可观测的活跃运行或仍登记工作区 SHALL 导致回收拒绝并说明原因，回收 SHALL 不结束进程或注销项目。记录、安装包、operator、captures、checks 及外置报告 SHALL 保留。

#### Scenario: 预览无需执行删除

- **WHEN** 用户仅指定 `cleanup --run ROUND_DIR`
- **THEN** 命令 SHALL 展示精确目标及保留项，SHALL 不删除资源或改写回收进度

#### Scenario: 显式回收本轮仓库

- **WHEN** 用户已完成运行退出和 Orca 注销，目标身份匹配，并调用 `cleanup --run ROUND_DIR --yes`
- **THEN** 本轮远程及本地仓库 SHALL 被回收，各目标结果 SHALL 写入原记录，仓库外材料与证据 SHALL 保留

#### Scenario: 同名或同路径资源被替换

- **WHEN** 回收前发现远程 ID 或本地目录身份与记录不符
- **THEN** 命令 SHALL 拒绝删除不匹配的目标，输出结构化原因，SHALL 不因名称或路径相同而放行

#### Scenario: 已有业务改动

- **WHEN** 原仓库中存在新提交或未提交业务文件，且目标归属仍匹配
- **THEN** 预览 SHALL 明确本地内容会删除；`--yes` SHALL 授权删除该轮仓库，SHALL 不要求回到初始 HEAD 或清空改动

#### Scenario: 仍有运行资源

- **WHEN** 检测到相关活跃运行或尚未解除的 Orca 工作区登记
- **THEN** 命令 SHALL 拒绝删除，给出可操作的退出/注销步骤，SHALL 不自动终止模型或 Worker

### Requirement: Partial and uncertain reclamation remains observable

回收 SHALL 分别持久记录本地和远程的未处理、处理中、已删除、拒绝、失败或结果不明状态；任何删除前 SHALL 保存该目标的处理状态。后续显式调用 SHALL 先对账原目标，跳过已确认不存在的目标；超时、权限不足、网络故障或身份缺失 SHALL 不被当作已删除。结果不明 SHALL 不在同次调用中自动重试；只有后续明确执行且原身份重新核验一致时才 SHALL 再次尝试。旧记录缺少删除身份证明时 SHALL 只允许查看和原有只读使用，提供手工处理说明，SHALL 不补造身份。

#### Scenario: 远程已删而本地失败

- **WHEN** 远程回收已确认、本地删除失败
- **THEN** 记录 SHALL 保留两项独立结果；下次显式回收 SHALL 只处理仍未完成且身份匹配的目标

#### Scenario: 删除响应丢失

- **WHEN** 远程删除调用结果不明
- **THEN** 本轮 SHALL 保留不确定状态并停止后续删除；再次调用 SHALL 先查询原远程，确证不存在后才记录已删除

#### Scenario: 旧轮次缺少删除证明

- **WHEN** 用户指定 schema 1 旧记录执行回收
- **THEN** 命令 SHALL 返回身份不足及原路径/远程名称，保留所有资源；查看记录与原有验收读取 SHALL 继续可用

### Requirement: Reopen verifies the existing canonical identity

`pnpm lab open --run ROUND_DIR` SHALL 读取记录并核验原 checkout 路径、完整 branch ref、Git 顶层/common dir、origin 与安装身份，已保存的 Orca 绑定 SHALL 精确核验。schema 2 SHALL 聚焦记录的原 terminal handle，仅明确无 PTY 且有退出原因时才创建替代终端并保存新句柄；不可核验 SHALL 停止。未登记的旧 schema 2 SHALL 可在显式 open 时经公开命令补登记并打开终端；已有绑定 SHALL 不回退默认 Orca 或猜最新终端。现存 schema 1 SHALL 保持原核验与重开入口。已回收、linked checkout、detached HEAD 与身份漂移 SHALL 明确拒绝；重开 SHALL 不重跑准备、自动启动模型或推进业务。

#### Scenario: 新轮次重开

- **WHEN** 新轮次仍存在且身份匹配
- **THEN** 命令 SHALL 返回原目录和本轮启动方式，并聚焦原终端；SHALL 不创建替代仓库或自动恢复模型

#### Scenario: 原终端已退出或无法核验

- **WHEN** 原 terminal handle 的查询明确已退出，或查询无法核验
- **THEN** 明确已退出时 SHALL 创建并记录本轮替代终端；无法核验时 SHALL 拒绝，SHALL 不推断退出或重复创建

#### Scenario: 旧 schema 2 尚未登记

- **WHEN** 用户明确 open 原身份与安装仍匹配但 orca 绑定为空的 schema 2 轮次
- **THEN** 系统 SHALL 经公开命令登记并核验主 checkout、打开原生终端并保存绑定，SHALL 不运行模型或创建 Scope

#### Scenario: 原轮次漂移或已回收

- **WHEN** 本地身份不匹配或仓库已回收
- **THEN** 重开 SHALL 非零退出并说明原因，SHALL 不隐式重建资源

### Requirement: Round defaults preserve external evidence boundaries

`collect`、`verify-result`、`verify-process` 与 `report` SHALL 保持 `--run ROUND_DIR` 和显式参数调用，显式参数优先。采集 SHALL 只读匹配该轮 canonical 路径和完整 branch ref 的唯一 Scope，不创建存储或猜测最近 Scope；Orca 选择 SHALL 精确核验实际 worktree 并保存绑定，已有绑定不得回退到默认身份。空模板只 SHALL 首次绑定实际 Scope，已有人工内容 SHALL 保留；默认输入 SHALL 只取本轮证据。基于保留文件的核验和报告 SHALL 能在仓库回收后运行；需要 live 仓库的采集和成品核验 SHALL 明确报告不可用，不重建现场或伪造通过。

#### Scenario: Scope 尚未初始化

- **WHEN** 用户对新轮次运行采集且没有唯一匹配 Scope
- **THEN** 命令 SHALL 指向 Home 初始化并拒绝采集，SHALL 不创建 Scope 或伪造证据

#### Scenario: 人工记录与空成品

- **WHEN** 空模板绑定后用户填写内容，再次采集；或新仓库尚无业务入口时执行成品核验
- **THEN** 人工内容 SHALL 保留；成品核验 SHALL 生成外置阻塞报告，SHALL 不把准备成功当作业务通过

#### Scenario: 回收后生成报告

- **WHEN** 仓库已回收且外置证据和过程/结果报告仍有效
- **THEN** 过程核验与报告合并 SHALL 可读取这些文件，SHALL 不要求被删除仓库或 Orca 登记存在

### Requirement: Rehearsal failures stay structured

输入或 I/O 失败 SHALL 保持退出码 2、stderr `LAB_INPUT_OR_IO_ERROR` envelope 与可选底层 `causeCode`；回收的失败、拒绝及不确定结果 SHALL 同时返回各目标状态，SHALL 不以成功退出伪装全部回收。秘密或原始敏感错误体 SHALL 不写入诊断。

#### Scenario: 外部调用失败

- **WHEN** 创建、安装或删除调用失败且有结构化码
- **THEN** 命令 SHALL 非零退出并保留 `causeCode` 与现场位置，不退化成无法定位的文本错误
