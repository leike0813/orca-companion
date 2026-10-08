## Context

本 change 补录已经授权实现的工作，源 HEAD 为 `8bde2e75ba1c5a84d40bc4cf8207d2ff7a9d0d26`，实现仍在未提交工作区。现有 `artifacts/ledger-lab` 已拥有合同、剧本、只读 collector、过程/成品 verifier 和报告；本次只补环境准备与轮次入口。Coordination Scope 的 canonical 约束沿用 `CONTEXT.md`，模块与凭据边界沿用 MOD-07、IC-03/12/14。

直接前驱 `remove-worker-credential-management` 已归档并提供 schema 4、原生模型目录与 Coordinator-only CredentialStore。`testing/isolated-control-probe` 负责已有 M0 自动控制探针，不承担本次人工业务演练；演练向导也不同于 Home 初始化向导，不改变后者不收集执行授权设置的约束。

## Goals / Non-Goals

**Goals:**

- 一个入口准备新的可追踪实测现场，另一个入口按原身份重开。
- 复用当前配置、凭据、模型目录与 doctor，保持五个 Worker 角色独立选择。
- 隔离待测源码与操作者材料，让已有验收工具以轮次为单位读取默认路径。
- 为后续修复和真实验收提供正式 Requirement/Scenario 与证据映射。

**Non-Goals:**

- 业务代码生成、自动规划/授权/派发、自动故障注入、headless 或后台 controller。
- 通用测试平台、仓库池、自动失败恢复/删除、每轮安装依赖或冻结发布包。
- 改写 Worker 认证、协调状态机、TUI 原型、预算规则或上游 Orca。
- Windows 支持声明、继承历史 fixture 模型或自动 fallback。

## Decisions

### D-01 外置轮次使用 canonical 主 checkout

`setup.mjs` 拥有准备和重开过程；根目录取 XDG state 的 `orca-companion/ledger-lab`，允许外置绝对 `--root`。每轮按 profile、时间与唯一后缀分配新目录，保存 `repo/`、`bin/`、`operator/`、`captures/`、`checks/` 与 `run.json`。

采用新 Git 仓库的 `main` 主 checkout，并以公开 `repo add` 登记到 Orca，设置 `origin/main` 为工作区基线。公开 Orca CLI 不提供 repo-create，且 Companion Home 拒绝 linked Worker checkout；因此不把 linked worktree 作为演练入口，也不复用之前的 GitHub 测试仓库。实际执行包仍由 Companion 在授权后创建隔离 Worker worktree。

Git 与 Orca 是仓库/worktree 身份权威；轮次记录只保存目标与回读身份，不替代它们。重开核验路径、branch、Git common dir、顶层目录、origin 和 Orca 身份，漂移即拒绝，不修复身份。

### D-02 最小项目初始化，操作者材料保持外置

每轮创建认证账号下的新私有 GitHub 仓库和标准章节均为空的 Route Map。待测项目只初始化 README、gitignore、OpenSpec schema 配置与 `orca-companion.json`；业务源码由后续用户演练产生。Route Map 章节复用生产渲染器，执行默认额度由 `contract.json` 转换到生产配置字段，避免复制另一份业务合同。

新仓库只配置本地 GitHub credential helper 为 `gh auth git-credential`，不改用户全局 Git 配置或保存 token。操作指南、参考图、cases、空 mapping/observations 和 doctor 报告留在 `operator/`。不将参考答案、参考图或验收程序复制进待测源码。

### D-03 开发构建与两个等价命令入口

`package.json` 的 `lab:new` 先构建再准备；`ocp` 与 `orca-companion` 指向同一 CLI 主文件，不增加按命令名分流的 runtime。外置启动器固定 Node、当前 Companion 构建入口和 Orca executable，并设置本轮 PATH/GH_REPO；无需每轮链接或安装 npm package。

选择直接引用开发构建，避免维护每轮可执行包与依赖副本。`run.json` 保存来源 HEAD 和 dirty 标记作为诊断信息；它不证明构建被冻结。重新构建 Companion 后，既有轮次会使用新构建。

### D-04 用户设置沿用生产配置与凭据合同

`wizard.mjs` 只负责交互；`src/bootstrap/ledger-lab.ts` 装配 FileProjectConfigurationStore、ModelSettingsService 与唯一 CredentialStore。用户设置仍为完整 schema 4，位置取 XDG config 或 `--settings`。向导依次收集 Coordinator 与五个 `MODEL_PROFILE_ROLES`，明确保存后才提交。

模型配置规则由现有服务拥有。首次配置在内存候选中完成生产校验，移除临时 seed，设置默认 Coordinator 引用；整次向导以读取的 revision 做一次文件 CAS。重配追加历史，不迁移旧 schema、不自动应用到既有 Session/Manifest。文件保存失败可留下未引用凭据，按 IC-14 不激活、不删除或自动换引用。

新 Coordinator key 通过终端 raw 输入隐藏，完成和取消均恢复 raw 状态。凭据实例由 bootstrap 创建，在同次配置与 doctor 之间传递；Worker 不读取此 store。`worker-model-settings.ts` 抽取 foreground host 已有的原生目录查询/可信缓存，两个入口共用它；失败或取消清空可信结果，迟到查询不能替代较新结果。

### D-05 准备成功与业务授权分开

准备剥离宿主的 Orca/GH_REPO 环境身份，使用明确路径和 selector。专用终端创建后，复用生产 doctor 与配置的真实模型/Worker profile 核验能力，报告写到仓库外。能力缺失即失败；本工具不绕过 doctor，也不将已安装 harness 名称当作能力。

配置默认值不构成 Execution Authorization。准备不建立协调数据库、Scope、Coordinator Session、Run、Task 或图；不启动业务 loop。操作者在新终端手动运行 `ocp`，按现有 Home、Route Planning 与 Manifest 合同完成后续步骤。doctor 的能力探针与业务 Worker 派发明确区分。

### D-06 有阶段记录的顺序副作用，unknown 保留现场

`setup.mjs` 用现有有界 process runner 执行参数数组、超时与取消，分离 stdout/stderr；不把原始外部诊断或环境复制到记录。`run.json` 为 schema 1，状态为 `preparing`、`ready` 或 `failed`；保存 profile、目标路径/branch、来源版本、GitHub 仓库/Issue、Orca repo/worktree/terminal、baseline HEAD 与当前阶段。外部资源仍是各系统的事实。

记录通过临时文件和原子 rename 更新。预检通过后建立轮次；各阶段先保存阶段再调用外部动作，回执按所需身份回读核验。异常和取消保存原阶段与 failureCode，现场与已创建资源保留。采用顺序、无自动重试的执行方式，不引入另一套跨系统 Operation Intent/补偿事务；结果不明必须由操作者按原记录调查，不能声称跨系统 exactly-once。

### D-07 轮次默认路径复用现有验收语义

`lab.mjs` 增加 prepare/configure/open 并给原四命令补 `--run`。默认 Scope 通过生产只读 store 查询，精确匹配 canonical 路径与 branch；无匹配或多匹配拒绝。首次采集仅绑定空、未填写的 schema 1 mapping/observations；相同 Scope 的人工数据保留，身份冲突拒绝。

证据和报告分配新的外置路径，默认最新输入只取当前轮次目录。原显式参数仍优先；collector、verifier、report 的证据规则与退出码保持单一 owner，不建立第二套过程断言。初始业务入口不存在时，成品报告应为 BLOCKED。

## Risks / Trade-offs

- 准备创建真实私有仓库并调用模型；失败资源保留，需要操作者按记录处理费用与资源。
- GitHub/Orca 创建与本地记录不构成原子事务；目标身份和阶段帮助调查，但不自动恢复 unknown。
- 依赖当前开发构建，重建后不能把既有轮次描述为冻结版本的重复实验。
- 当前只按 Ubuntu 本机声明；真实 GitHub 创建、推送、终端采用及真实模型 doctor 尚缺本轮完整证据，不能用 mock 或此前并发 fixture 代替。

## Migration Plan

不修改协调数据库、Manifest schema、凭据格式或旧项目配置。新轮次记录使用 schema 1，设置使用现有 schema 4；不支持的旧设置明确拒绝。两个 CLI bin 共用入口，现有长命令继续可用。主规格同步与归档留到本 change 完成验收之后。

## Open Questions

没有影响实现的未决选择。真实验收需要操作者在向导选择可用模型并使用自己的 harness 认证；这属于已定义流程的运行前置，不预先代选模型。
