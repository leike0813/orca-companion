## ADDED Requirements

### Requirement: 在途 Graph Patch 修订持有须经新规格准入结算

当已派发且仍在当前图中的 Work Package 被已接受 Graph Patch 修订时，系统 SHALL 保留该节点及未接受后代的修订持有，直到旧派发到达可核验终态、必要的 Baseline Reconciliation 已核验、新 Specification Planner 产出的规格通过 Admission。旧派发未结算、Worker 存活不可核验、基线未核验或预算不可用时，系统 MUST NOT 派发新 Planner。满足前提后，系统 SHALL 在同一 WorkPackageId 与 worktree 上仅允许新 Planner 启动，旧结果仍 MUST NOT 推进后续角色、依赖工作或 Git 集成。Admission 通过后，系统 SHALL 原子释放对应补丁的持有并消耗一次已授权的 Specification Revision 额度；随后 SHALL 按新契约从 Implementation、Validator 继续。Admission 未通过、修订额度耗尽或持有来源不符时，系统 MUST NOT 释放持有或扣减额度，并 SHALL 给出可观察的阻塞原因。

#### Scenario: 旧 Worker 仍在途

- **WHEN** 已派发节点被 Graph Patch 修订，而旧 Worker 仍在运行或其结算不可核验
- **THEN** 节点和未接受后代保持 revision pending；旧 Worker 可收尾，但新 Planner、后续角色、依赖工作与集成都不启动

#### Scenario: 旧派发结清后重跑 Planner

- **WHEN** 受影响节点的旧派发全部可核验结算、必要的基线补救已核验、修订额度可用且执行授权有效
- **THEN** 系统在原 WorkPackageId 与 worktree 上派发新的 Specification Planner；持有继续阻止旧结果推进

#### Scenario: 新规格准入并结算

- **WHEN** 新 Planner 的精确派发与 Session Binding 可核验，且新规格通过确定性 Admission
- **THEN** 系统仅结算对应补丁持有、消耗一次 Specification Revision 额度，并以新规格继续 Implementation 与 Validator

#### Scenario: 准入失败或修订额度耗尽

- **WHEN** 新规格未通过 Admission，或已批准的 Specification Revision 额度已耗尽
- **THEN** 持有与后代冻结保持，额度不增加消耗，阻塞原因可查询

#### Scenario: 重启后继续同一次修订

- **WHEN** 持有、新 Planner 派发或准入结算期间进程重启，随后同一 Scope 恢复
- **THEN** 系统使用原补丁与派发身份对账，既不重复派发 Planner，也不重复释放持有或扣减额度

### Requirement: 已被替换的角色结果不得完成新修订

Graph Patch 修订完成后，系统 SHALL 只用新接纳的契约版本及其角色结果判断该 Work Package 的后续阶段、依赖准入、Git 集成和 Finalizer 门禁。旧契约的 Planner、Implementation 或 Validator 结果 MUST NOT 冒充新修订的完成证据；任何缺失或无法核验的新版本事实 SHALL 保持阻塞或未知。

#### Scenario: 旧 Validator 已通过

- **WHEN** 修订前的 Validator 已被接受，但新规格尚未完成新一轮 Implementation 与 Validator
- **THEN** 节点不显示为已接受、不进入集成，也不满足 Finalizer 门禁

#### Scenario: 新角色链完成

- **WHEN** 新接纳契约对应的 Implementation 与 Validator 均已被接受，且没有未决持有
- **THEN** 节点才可进入受控 Git 集成与后续 Finalizer 门禁
