# planning/execution-authorization Specification

## Purpose
定义 Execution Authorization Manifest 的完整性、执行预算绑定、原子批准与版本化授权记录，使一个 Graph Generation 只有在一次明确批准之后才可能被派发。

## Requirements

### Requirement: Manifest completeness and atomic approval

Execution Authorization Manifest SHALL 一次性绑定 Destination、Route Map 与 Implementation Plan revision、Graph Generation 与 GraphId、Coordination Scope、baseline HEAD、空 Orca Run、Worker Profiles、角色权限、active Work Package、实现尝试、Validator 修复、Graph Revision、Specification Revision 与每个 Worker Attempt Recovery 的有限上限、workspace 与 Git/Dependency Policy 以及 accepted risks，任何字段缺失时 SHALL NOT 提交批准；授权 SHALL 来自用户对完整 Manifest 的一次原子决定，Companion SHALL NOT 分次批准、按任务批准、由后继 change 补字段或以 Coordinator 自己的判断代替用户批准。

#### Scenario: 缺字段不提交批准
- **WHEN** Manifest 缺少 baseline HEAD、预算上限、`maxRecoveriesPerWorkerAttempt` 或 Git/Dependency Policy 中任一项
- **THEN** 批准请求 SHALL 被拒绝，Manifest SHALL NOT 进入待批准状态

#### Scenario: Manifest 与候选图严格对应
- **WHEN** Manifest 引用的 Graph Generation、地图 revision 或计划 revision 与实际候选图不一致
- **THEN** 批准 SHALL 失败并报告不一致项

#### Scenario: 单次决定覆盖整份 Manifest
- **WHEN** 用户批准一份 Manifest
- **THEN** 授权 SHALL 覆盖该 Manifest 的全部字段并记录其版本，SHALL NOT 只对其中一部分生效

#### Scenario: 未获批准时不产生可执行授权
- **WHEN** 用户尚未批准或拒绝批准
- **THEN** SHALL 不存在有效的 Execution Authorization，候选图 SHALL 保持惰性

#### Scenario: 恢复上限显式绑定且取默认值
- **WHEN** 组装一份 Manifest 而用户未指定恢复上限
- **THEN** `maxRecoveriesPerWorkerAttempt` SHALL 被显式写入 Manifest 并取默认值 `1`，SHALL NOT 留空或由执行阶段隐式推断

#### Scenario: 初始化向导不询问恢复上限
- **WHEN** 用户通过初始化向导创建 Coordination Scope
- **THEN** 向导 SHALL NOT 询问 `maxRecoveriesPerWorkerAttempt`，该值 SHALL 留待 Execution Authorization Manifest 阶段确定

### Requirement: Authorization authorizes bounded operations

有效授权 SHALL 覆盖其 Graph Generation 内的普通 Worker 派发、策略内依赖变更与受控 Git 集成，且 SHALL NOT 覆盖发布、部署或越界外部操作；执行阶段 SHALL 按 Manifest 绑定的 `maxRecoveriesPerWorkerAttempt` 约束单次 Worker Attempt 的恢复次数，且 SHALL NOT 在执行中放宽该值。

#### Scenario: 策略内操作不再逐次审批
- **WHEN** 某次派发、依赖变更或 Git 集成落在已批准 Manifest 的策略内
- **THEN** 该操作 SHALL 不需要新的用户批准，但 SHALL 仍受 Manifest 的 expected revision 与预算约束

#### Scenario: 越界操作需要单独授权
- **WHEN** 操作属于发布、部署或 Manifest 未覆盖的外部副作用
- **THEN** SHALL 需要单独的用户授权，执行 SHALL 被拒绝直到授权存在

#### Scenario: 恢复次数受 Manifest 约束
- **WHEN** 某个 Worker Attempt 需要恢复，且已用恢复次数达到 Manifest 绑定的上限
- **THEN** 该 Attempt SHALL 停止并升级，SHALL NOT 自动放宽上限或越过授权耗尽恢复次数

#### Scenario: 改变恢复上限需要重新授权
- **WHEN** 需要把 `maxRecoveriesPerWorkerAttempt` 调整为不同于已批准 Manifest 的值
- **THEN** SHALL 产生新版本的 Manifest 与新的用户批准，执行 SHALL NOT 直接沿用旧授权
