# tui/graph-inspection Specification

## Purpose
定义只读 Execution Graph Inspector 的展示与导航行为，以及渲染路径不得触发业务副作用的约束。

## Requirements

### Requirement: 只读 Graph Inspector

Graph Inspector SHALL 在独立全屏检查视图中展示当前 Execution Graph 的节点、依赖、Scope Envelope 与 admission/authorization readiness；Sidebar 使用同一 adaptive 拓扑与节点卡片规则，并 SHALL 支持沿依赖导航与节点选择。Inspector MUST NOT 执行任何领域动作，包括创建或修改图节点、改变授权状态或触发派发。

#### Scenario: 检查候选图不改变状态
- **WHEN** 用户在 Inspector 中展开候选图节点并查看其依赖与 Scope Envelope
- **THEN** 图版本、授权状态与 Coordinator Session 状态均不变

#### Scenario: 沿依赖导航
- **WHEN** 用户在 Inspector 中沿依赖方向移动到上游节点
- **THEN** 选择移动到上游节点并显示其信息，不修改图定义

### Requirement: 渲染与重挂载零业务副作用

组件 render、effect、resize 与重挂载 MUST NOT 触发模型恢复、Worker 派发、重试或持久化写入。屏幕刷新 SHALL 只消费已加载的快照与已排队的语义事件，高频事件 SHALL 以有界批量方式刷新且隐藏的 Sidebar 不计算不可见详情。

#### Scenario: 重挂载不触发恢复
- **WHEN** 组件因 resize 或 overlay 切换被重挂载
- **THEN** 不产生模型恢复、Worker 派发或持久化写入

#### Scenario: 高频事件有界刷新
- **WHEN** Controller 在短时间内投递多条语义事件
- **THEN** 界面以有界批量方式刷新，且折叠状态下的 Sidebar 不计算不可见详情

### Requirement: 定稿 adaptive 图与准确导航

Sidebar 与全屏 Inspector SHALL 沿用 #43/#52 final 的 adaptive 图与分区节点卡，节点以 WorkPackageId 和稳定 position 标识，状态/resize MUST NOT 重排或无故重选。三档尺寸 SHALL 有界浏览选中邻域及状态/Worker、依赖、依据、工作范围和完整身份栏目；多前驱/后继 SHALL 由用户明确选择，MUST NOT 自动跳到第一条关系。阶段、liveness、Validation 与 integration SHALL 分开，缺少事实明示不可用；动画 SHALL 仅用于可信 live 运行节点，未知节点和依赖边 MUST NOT 被表现为推进中。默认 Nerd 与显式 ASCII 回退 SHALL 同步侧栏及全屏；验收进度没有可信共享摘要时 MUST NOT 从 Task 完成、accepted 或局部节点数推断。

#### Scenario: 多分支准确导航
- **WHEN** 所选节点有多个前驱或后继，用户进入关系选择并确认一个对象
- **THEN** 只移动到明确选择的 WorkPackageId，关系和返回位置准确，图与业务状态不变

#### Scenario: 窄屏和 resize 保留选择
- **WHEN** 用户在全屏检查选择节点/栏目并在三档尺寸间 resize
- **THEN** 所选身份、栏目和返回上下文保留，邻域与详情在终端预算内可读

#### Scenario: 不可核验状态和图标回退
- **WHEN** 节点 liveness 为 unverifiable 或验收摘要不可用，用户切换 ASCII
- **THEN** 侧栏与检查同时使用回退符号，未知仍是未知，不出现虚构运行动画或完成进度

### Requirement: All-generation read-only graph history
Inspector and project details SHALL expose paged graph versions across every generation of the current Scope, including frozen generations. Each selected version SHALL show its exact graph identity, generation, topology and basis. Historical views MUST NOT borrow current runtime state or acceptance counts.

#### Scenario: Frozen generation and return
- **WHEN** the user opens an older generation and follows its node relations, then returns
- **THEN** the historical topology is exact and read-only, and the original current selection, tab, scroll, draft and reading anchor are preserved

#### Scenario: Retired selection
- **WHEN** a selected package is retired by an accepted patch
- **THEN** its retirement is explicit and history remains reachable without selecting another package automatically

### Requirement: Bounded historical navigation
Version directories SHALL return at most 20 items per page. Reading SHALL use exact source identities and versions; late results MUST NOT replace another Session or page. Rendering, resizing and navigation MUST NOT modify coordination state.

#### Scenario: Append while reading
- **WHEN** another version is appended while an immutable historical body is being paged
- **THEN** continuation remains attached to the original version and does not become stale merely because the Scope changed
