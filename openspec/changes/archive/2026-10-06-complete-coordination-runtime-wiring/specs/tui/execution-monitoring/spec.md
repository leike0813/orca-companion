## MODIFIED Requirements

### Requirement: 执行图与 Frontier 投影

Sidebar SHALL 以有界 adaptive 图和分区节点卡展示当前图的稳定拓扑与选中邻域、Execution Frontier、阶段、Worker/liveness、串行队列和 attention；角色、attempt、Validation/Integration、worktree、baseline 与 Evidence SHALL 在 Inspector 的执行依据、工作范围、完整身份栏目及项目工作详情可读，预算 SHALL 在项目预算详情可读。并行额度 SHALL 来自已批准 Manifest 的 `maxActiveWorkPackages`，默认 3，接受任意正安全整数；系统 SHALL 投影全部真实活动包、占用数与批准额度，其余候选 SHALL 显示为排队或 waiting。降低额度后仍在运行的包 SHALL 保持可见，空槽回收至新额度后再接纳新包。Graph 节点 SHALL 使用编译后的稳定拓扑位置，状态变化 MUST NOT 重排；过滤 SHALL 只隐藏节点而不改变相对顺序。紧凑态 SHALL 保留图关系、当前图版本的定位编号、关键状态与告警；编号 MUST NOT 冒充 WorkPackageId，完整身份 SHALL 从详情读取。折叠态 SHALL 保留全局风险与待答提示，完整当前图 SHALL 由显式 Inspector 有界浏览。

#### Scenario: 状态变化不重排节点
- **WHEN** 某个 Work Package 从 implementing 变为 validating
- **THEN** 该节点在 Sidebar 中的位置不变，仅状态标识更新

#### Scenario: 折叠态不计算详情
- **WHEN** Sidebar 处于折叠态
- **THEN** 界面保留全局风险与待答提示，不计算或渲染不可见的 Work Package 详情

#### Scenario: 过滤只隐藏节点
- **WHEN** 用户按状态过滤执行图节点
- **THEN** 不匹配的节点被隐藏，剩余节点的相对顺序与位置保持不变

#### Scenario: 按批准额度呈现活动包
- **WHEN** 存在多个可派发的候选 Work Package
- **THEN** 界面显示获准进入 Frontier 的全部活动包及批准额度，其余显示为排队或 waiting

### Requirement: Work Package 生命周期与串行 integration queue 投影

系统 SHALL 将 Work Package 投影为 waiting、ready/admitting、specifying、implementing、validating、repairing、waiting integration、reconciling、revision pending、blocked/unknown、accepted/retired/cancelled 中的一种，并 SHALL 单独显示 Worker liveness 为 `live`、`exited` 或 `unverifiable`。Execution Frontier SHALL 按批准额度并行推进隔离 worktree 中的包，同包角色 SHALL 串行；integration queue 与 canonical 集成 SHALL 串行。canonical 前进、轻微 reconciliation 与严重冲突升级 SHALL 作为不同状态呈现。

#### Scenario: 空槽接纳独立包
- **WHEN** 一个 Work Package 正在 implementing，另一个包依赖已满足且批准额度有空槽
- **THEN** 前一个保持 active，后一个可在独立 worktree 中进入 active

#### Scenario: 完成后排队进入集成
- **WHEN** active Work Package 通过验证并进入 waiting integration
- **THEN** 该包显示为 waiting integration，canonical 集成按串行顺序执行，其他包可继续角色工作

#### Scenario: liveness 与生命周期分别显示
- **WHEN** active Work Package 的 Worker 暂时不可达但未确认退出
- **THEN** 该包显示当前生命周期状态，其 liveness 单独显示为 `unverifiable`

#### Scenario: 严重冲突升级为可区分状态
- **WHEN** Work Package 与 canonical 的合并出现超出授权范围的冲突
- **THEN** 界面以区别于轻微 reconciliation 的状态呈现该升级
