## Purpose

定义 ledger-lab 实操演练所需的环境准备与轮次管理能力，让操作者从已安装依赖的 Companion 开发仓库创建独立测试现场，并在该现场手动规划、授权和执行；准备记录、证据与验收材料保持外置，以便复跑和调查失败。

## ADDED Requirements

### Requirement: Isolated canonical rehearsal rounds

`pnpm lab:new` SHALL 构建当前 Companion 开发版本并准备新的 `main` 轮次；指定 `--profile cancel` SHALL 准备独立的取消轮次。每轮 SHALL 在 Companion 仓库外分配新目录、新私有 GitHub 仓库与空 Route Map，初始化 `main` 的 canonical 主 checkout、最小 OpenSpec 与项目配置，建立首次提交并推送到该轮 `origin/main`，再通过公开 Orca CLI 登记仓库与主工作区。操作者材料、参考图、映射、观察、证据、报告和启动器 SHALL 位于待测 checkout 外；准备 SHALL NOT 安装或更新每轮依赖，也 SHALL NOT 更新上游 submodule。

#### Scenario: 新建主轮次

- **WHEN** 配置有效、Git 作者身份可用、GitHub 已认证且本机 Orca 可达，操作者运行 `pnpm lab:new`
- **THEN** 系统 SHALL 返回新轮次目录与该轮资源身份；仓库 SHALL 为干净的 `main` 主 checkout，并登记到 Orca

#### Scenario: 创建另一个取消轮次

- **WHEN** 操作者运行 `pnpm lab:new --profile cancel`，即使 runs 根目录已有主轮次
- **THEN** 系统 SHALL 分配新轮次与新资源，SHALL NOT 复用或覆盖前一轮次

#### Scenario: 输出路径指向 Companion 仓库

- **WHEN** runs 根目录或设置路径解析后位于 Companion 仓库内
- **THEN** 系统 SHALL 拒绝该路径，SHALL NOT 在其中创建演练现场

### Requirement: Explicit reusable model setup

演练准备 SHALL 从 XDG 用户配置目录的 `orca-companion/ledger-lab.json` 或显式 `--settings` 读取可复用设置。首次缺少设置时 SHALL 在交互式终端收集 Coordinator provider integration、模型与非秘密 SDK options，以及 planner、implementation、validator、finalizer、recovery_utility 五个角色各自的 harness 与模型；`pnpm lab configure` SHALL 提供重新配置入口。Worker 模型目录与 effort SHALL 沿用 `configuration/model-settings` 的可信来源规则，目录失败时只允许未验证 exact ID 和空 effort。保存 SHALL 保留已有不可变配置历史并核验初次读取的 revision；取消 SHALL NOT 保存候选设置。

#### Scenario: 角色分别选择

- **WHEN** 操作者完成首次向导并明确选择保存
- **THEN** 可复用设置 SHALL 包含选中的 Coordinator 与完整五个 Worker Profile，后续轮次 SHALL 使用这些选择

#### Scenario: 首次配置没有 TTY

- **WHEN** 设置不存在且 stdin 或 stdout 不是 TTY
- **THEN** 准备 SHALL 非零退出并指明交互配置入口，SHALL NOT 创建 GitHub 仓库或启动模型

#### Scenario: 取消配置

- **WHEN** 操作者取消输入或最终保存确认
- **THEN** 候选设置 SHALL NOT 写入配置文件，既有设置 SHALL 保持原样

#### Scenario: 设置已被另一编辑更新

- **WHEN** 向导读取设置后，另一编辑已保存新的 revision
- **THEN** 保存 SHALL 拒绝冲突，SHALL NOT 覆盖较新的设置或宣称候选已生效

### Requirement: Coordinator secrets stay in the credential store

Coordinator 认证 SHALL 支持 provider 环境认证、选择已有 `credentialRef` 或隐藏输入新 key。新 key SHALL 只经现有用户级 CredentialStore 保存；项目与演练设置只保存不透明引用。设置保存和同次准备的 doctor SHALL 共用同一凭据实例。Worker 认证 SHALL 由 harness 的真实用户环境提供。秘密 SHALL NOT 出现在待测仓库、轮次记录、命令参数、诊断或验收证据；本工具 SHALL NOT 为 Worker 复制凭据或生成原生认证配置。

#### Scenario: 保存新 Coordinator key

- **WHEN** 操作者隐藏输入新 key 并保存合法设置
- **THEN** 设置 SHALL 只保存已回读核验的引用，终端 SHALL 不回显 key；取消或完成隐藏输入后 SHALL 恢复终端输入状态

#### Scenario: SDK options 包含秘密字段

- **WHEN** 设置输入包含被项目配置合同禁止的秘密字段
- **THEN** 保存 SHALL 拒绝该配置，SHALL NOT 将该字段复制到演练文件或诊断

### Requirement: Readiness preserves manual coordination

准备 SHALL 在该轮专用 Orca 终端身份下运行 doctor，只有环境检查、Coordinator 模型与配置引用的 Worker 能力核验均通过才 SHALL 报告准备成功。成功后 SHALL 打开该轮终端并提供 `ocp` 启动器。准备 SHALL NOT 创建 Companion Scope、Coordinator Session、执行图、Orca Run 或 Task，SHALL NOT 派发业务 Worker 或生成 ledger-lab 业务实现与验收答案。操作者 SHALL 在 Home 中初始化 Scope，再按剧本提交需求、审阅规划和批准执行。

#### Scenario: 环境准备成功

- **WHEN** 新轮次的 doctor 全部通过
- **THEN** 系统 SHALL 保存报告并提供可启动的终端；用户进入 `ocp` 时仍 SHALL 按既有 Home 合同初始化 Scope

#### Scenario: doctor 能力缺失

- **WHEN** Coordinator 模型或配置引用的 Worker 必需能力核验未通过
- **THEN** 准备 SHALL 非零退出并保留报告，SHALL NOT 将现场标记为成功可演练或自动换模型继续

### Requirement: Failed preparation retains its original resources

进入轮次准备后，系统 SHALL 持久保存当前阶段、状态、来源开发版本与已知外部资源身份；失败或取消 SHALL 保留原目录及已创建资源，并报告现场位置。外部动作的结果不明时 SHALL NOT 自动换身份重试、清理、回滚或猜测成功。预检拒绝时 SHALL NOT 为了记录拒绝而创建轮次。

#### Scenario: GitHub 创建结果不明

- **WHEN** 创建 GitHub 仓库的调用超时、被取消或结果无法确认
- **THEN** 系统 SHALL 保留目标仓库名和失败阶段，只尝试该次动作，SHALL NOT 再创建替代仓库或自动删除现场

#### Scenario: 阶段边界取消

- **WHEN** 操作者在一个阶段边界取消准备
- **THEN** 系统 SHALL 保存失败现场并停止后续阶段的副作用

### Requirement: Reopen verifies the existing canonical identity

`pnpm lab open --run ROUND_DIR` SHALL 核验记录格式、来源 Companion 路径、原 checkout 路径、完整 branch ref、Git common dir、Git 顶层目录、origin 与精确 Orca 仓库/worktree 身份。只有身份一致时 SHALL 在原工作区创建并打开新的终端。重开 SHALL NOT 重跑准备、创建替代仓库、推进业务或隐式恢复模型；linked checkout、detached HEAD、资源替换与身份漂移 SHALL 被拒绝。

#### Scenario: 重开原轮次

- **WHEN** 操作者指定有效轮次且 Git 与 Orca 身份仍匹配
- **THEN** 系统 SHALL 在原 canonical checkout 打开终端并保留原轮次的业务事实

#### Scenario: 原轮次身份漂移

- **WHEN** branch、origin、canonical 路径或 Orca worktree 身份不再匹配记录
- **THEN** 重开 SHALL 非零退出，SHALL NOT 在漂移工作区创建终端

### Requirement: Round defaults preserve external evidence boundaries

`collect`、`verify-result`、`verify-process` 与 `report` SHALL 支持 `--run ROUND_DIR`，据该轮身份提供仓库、profile 和外置路径默认值；显式参数 SHALL 优先，原有显式调用 SHALL 保持可用。未显式指定 Scope 的采集 SHALL 只匹配该轮 canonical 路径与完整 branch ref 的唯一现存 Scope，SHALL NOT 创建协调存储或按时间猜测 Scope。采集 SHALL 使用该轮固定的 Orca 路径。空映射与观察模板只 SHALL 在未填写、未绑定时首次绑定实际 Scope；已有人工记录 SHALL 保留，不同 Scope 的模板 SHALL 被拒绝。默认核验输入只 SHALL 取本轮最新采集和报告；已有通过、失败、阻塞、未覆盖与证据不足的判定语义 SHALL 保持不变。

#### Scenario: Scope 尚未初始化

- **WHEN** 操作者运行 `collect --run ROUND_DIR` 而该轮没有唯一匹配的 Scope
- **THEN** 命令 SHALL 明确拒绝并指向 Home 初始化，SHALL NOT 创建 Scope 或伪造证据

#### Scenario: 绑定模板并保留人工观察

- **WHEN** 空模板首次绑定该轮 Scope，操作者填写观察后再次采集或核验
- **THEN** 文件 SHALL 保持同一 Scope，已有观察与映射 SHALL 不被覆盖

#### Scenario: 业务入口尚未实现

- **WHEN** 操作者对新空项目运行 `verify-result --run ROUND_DIR`
- **THEN** 命令 SHALL 使用本轮默认路径生成外置阻塞报告，SHALL NOT 因环境准备成功而把成品验收记为通过
