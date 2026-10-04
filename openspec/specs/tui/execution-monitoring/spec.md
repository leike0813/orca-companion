# tui/execution-monitoring Specification

## Purpose
定义执行授权后工作区的连续性、执行图与 Frontier 投影，以及单 active Work Package 生命周期与串行 integration queue 的可观察行为。

## Requirements

### Requirement: 授权后工作区连续性

进入 Execution Coordination 后系统 MUST NOT 切换应用页面或重置 transcript 与 composer。顶栏 SHALL 显示 Scope control state 与风险/待答摘要；Graph Generation/version SHALL 默认进入 statusline，Execution Authorization 完整引用 SHALL 在项目详情可读，active Work Package 与执行摘要 SHALL 在 Sidebar 显示。Execution Coordination 的并发上限固定为 1，因此 active Work Package 计数 SHALL 只在 0 与 1 之间取值。进程重启后系统 SHALL 先进入 reconciling 投影，且在对账完成前 MUST NOT 推进执行。

#### Scenario: 授权不重置工作区
- **WHEN** 用户授权 Execution Authorization Manifest 后 Scope 切换到 Execution Coordination
- **THEN** transcript 与 composer 保持原内容与焦点，图代际/版本、授权引用和 active Work Package 计数在各自约定区域更新

#### Scenario: 重启先对账
- **WHEN** 前台进程退出后重新启动并发现存在活跃 Worker 或未决操作
- **THEN** 界面先显示 reconciling，对账未完成前不出现新的派发或集成动作

### Requirement: 执行图与 Frontier 投影

Sidebar SHALL 以有界 adaptive 图和分区节点卡展示当前图的稳定拓扑与选中邻域、Execution Frontier、阶段、Worker/liveness、串行队列和 attention；角色、attempt、Validation/Integration、worktree、baseline 与 Evidence SHALL 在 Inspector 的执行依据、工作范围、完整身份栏目及项目工作详情可读，预算 SHALL 在项目预算详情可读。并发上限固定为 1，系统 SHALL 在任一时刻最多投影一个 active Work Package，其余候选 Work Package SHALL 作为排队或 waiting 状态出现在当前图中。Graph 节点 SHALL 使用编译后的稳定拓扑位置，状态变化 MUST NOT 重排；过滤 SHALL 只隐藏节点而不改变相对顺序。紧凑态 SHALL 保留图关系、当前图版本的定位编号、关键状态与告警；编号 MUST NOT 冒充 WorkPackageId，完整身份 SHALL 从详情读取。折叠态 SHALL 保留全局风险与待答提示，完整当前图 SHALL 由显式 Inspector 有界浏览。

#### Scenario: 状态变化不重排节点
- **WHEN** 某个 Work Package 从 implementing 变为 validating
- **THEN** 该节点在 Sidebar 中的位置不变，仅状态标识更新

#### Scenario: 折叠态不计算详情
- **WHEN** Sidebar 处于折叠态
- **THEN** 界面保留全局风险与待答提示，不计算或渲染不可见的 Work Package 详情

#### Scenario: 过滤只隐藏节点
- **WHEN** 用户按状态过滤执行图节点
- **THEN** 不匹配的节点被隐藏，剩余节点的相对顺序与位置保持不变

#### Scenario: 并发上限为 1
- **WHEN** 存在多个可派发的候选 Work Package
- **THEN** 界面最多把一个 Work Package 显示为 active，其余显示为排队或 waiting

### Requirement: Work Package 生命周期与串行 integration queue 投影

系统 SHALL 将 Work Package 投影为 waiting、ready/admitting、specifying、implementing、validating、repairing、waiting integration、reconciling、revision pending、blocked/unknown、accepted/retired/cancelled 中的一种，并 SHALL 单独显示 Worker liveness 为 `live`、`exited` 或 `unverifiable`。Execution Frontier SHALL 串行推进：一个 Work Package 完成其全部角色后，下一个才进入 active；integration queue SHALL 明确表达串行。canonical 前进、轻微 reconciliation 与严重冲突升级 SHALL 作为不同状态呈现。

#### Scenario: 单 active Work Package 串行推进
- **WHEN** 一个 Work Package 正在 implementing，同时另一个 Work Package 的依赖已满足
- **THEN** 前一个保持 active，后一个显示为 waiting 或排队，不出现第二个 active Work Package

#### Scenario: 完成后排队进入集成
- **WHEN** active Work Package 通过验证并进入 waiting integration
- **THEN** 该包显示为 waiting integration，并按串行顺序进入集成而不与其他包重叠

#### Scenario: liveness 与生命周期分别显示
- **WHEN** active Work Package 的 Worker 暂时不可达但未确认退出
- **THEN** 该包显示当前生命周期状态，其 liveness 单独显示为 `unverifiable`

#### Scenario: 严重冲突升级为可区分状态
- **WHEN** Work Package 与 canonical 的合并出现超出授权范围的冲突
- **THEN** 界面以区别于轻微 reconciliation 的状态呈现该升级

### Requirement: 集成投影与执行完成事实一致

执行图、串行队列与机器快照 SHALL 从当前 Work Package 的完整集成事实投影状态。仅有 Validator 接受结果或部分 Git 步骤成功时 SHALL 显示等待集成；完整集成完成时 SHALL 显示 accepted，且其依赖节点可据此进入 Frontier。

#### Scenario: 已验证但只完成部分集成

- **WHEN** Work Package 的 Validator 已通过，Git commit 或 canonical merge 已成功，但 push 尚未被接受
- **THEN** Sidebar 与 `status --json` 仍显示等待集成，该包的依赖节点不因此获得可派发资格

#### Scenario: 完整集成后的投影

- **WHEN** Work Package 的完整集成已被接受
- **THEN** Sidebar 与 `status --json` 显示 accepted，该包退出 integration queue，依赖节点可据此推进

### Requirement: Shared current contract validator acceptance
状态栏、Sidebar 与 Graph Inspector SHALL 使用同一个当前 GraphId/generation/version 全图摘要。分母 SHALL 是当前未 retire Work Packages；分子 SHALL 仅包含精确当前合同的 Accepted Validator Result，每包至多一次。MUST NOT 将 Task done、Implementation 完成、integration 状态、可见窗口数量、旧合同或旧代际 Validator 结果计入验收；无当前图 SHALL 显示不可用。

#### Scenario: Current contract and retired nodes
- **WHEN** 一个图有旧合同通过记录、重复验证、已 retire 包及尚未通过当前合同的包
- **THEN** 三处显示同一完整当前图数量，各当前有效包仅按当前 Validator 结果计一次，retire 与旧合同记录不计入
