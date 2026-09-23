# tui/graph-inspection Specification

## Purpose
定义只读 Execution Graph Inspector 的展示与导航行为，以及渲染路径不得触发业务副作用的约束。

## Requirements

### Requirement: 只读 Graph Inspector

Graph Inspector SHALL 在 Sidebar 内展示当前候选 Execution Graph 的节点、依赖、Scope Envelope 与 admission/authorization readiness，并 SHALL 支持沿依赖导航与节点选择。Inspector MUST NOT 执行任何领域动作，包括创建或修改图节点、改变授权状态或触发派发。

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
