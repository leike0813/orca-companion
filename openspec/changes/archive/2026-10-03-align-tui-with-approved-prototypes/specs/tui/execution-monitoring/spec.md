## MODIFIED Requirements

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
