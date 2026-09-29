## Purpose

定义执行授权后工作区的连续性、执行图与 Frontier 投影，以及单 active Work Package 生命周期与串行 integration queue 的可观察行为。

## ADDED Requirements

### Requirement: 授权后工作区连续性

进入 Execution Coordination 后系统 MUST NOT 切换应用页面或重置 transcript 与 composer。顶栏 SHALL 显示当前 Graph Generation、Execution Authorization、Scope control state 与 active Work Package 计数。Execution Coordination 的并发上限固定为 1，因此 active Work Package 计数 SHALL 只在 0 与 1 之间取值。进程重启后系统 SHALL 先进入 reconciling 投影，且在对账完成前 MUST NOT 推进执行。

#### Scenario: 授权不重置工作区
- **WHEN** 用户授权 Execution Authorization Manifest 后 Scope 切换到 Execution Coordination
- **THEN** transcript 与 composer 保持原内容与焦点，顶栏显示新的 Graph Generation、Authorization 与 active Work Package 计数

#### Scenario: 重启先对账
- **WHEN** 前台进程退出后重新启动并发现存在活跃 Worker 或未决操作
- **THEN** 界面先显示 reconciling，对账未完成前不出现新的派发或集成动作

### Requirement: 执行图与 Frontier 投影

Sidebar SHALL 展示完整执行图的稳定拓扑、Execution Frontier、当前 active Work Package 的角色、attempt、liveness、worktree 与 baseline，以及 Validation 与 Evidence、串行 integration queue、预算与 attention；并发上限固定为 1，系统 SHALL 在任一时刻最多投影一个 active Work Package，其余候选 Work Package SHALL 作为排队或 waiting 状态出现在完整图中。Graph 节点 SHALL 使用编译后的稳定拓扑位置，状态变化 MUST NOT 重排；过滤 SHALL 只隐藏节点而不改变相对顺序。紧凑态 SHALL 保留图关系、短 key、关键状态与告警，折叠态 SHALL 只在顶栏保留计数。

#### Scenario: 状态变化不重排节点
- **WHEN** 某个 Work Package 从 implementing 变为 validating
- **THEN** 该节点在 Sidebar 中的位置不变，仅状态标识更新

#### Scenario: 折叠态不计算详情
- **WHEN** Sidebar 处于折叠态
- **THEN** 界面只显示顶栏计数，不计算或渲染不可见的 Work Package 详情

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
