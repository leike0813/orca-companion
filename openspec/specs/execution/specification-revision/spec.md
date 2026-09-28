## Purpose

定义 Work Package 契约内容的替换、调度持有与修订额度语义，使语义修订与基础设施重试可区分，并明确基线落后时的独立补救。

## Requirements

### Requirement: Specification Revision 保持身份并重新 Admission 后重跑完整角色链

Specification Revision SHALL 只替换尚未接受的同一 Work Package 的 contract 内容，并 SHALL 保留其 WorkPackageId、依赖与 Scope Envelope；需要改变依赖或 Scope Envelope 时必须走 Graph Revision。修订后的契约 SHALL 重新经过 Specification Admission，并在准入通过后从 Specification Planner 起重跑完整角色链。Specification Revision SHALL 改变 contract content，Retry Attempt SHALL 保持 WorkerTask、contract 与 revision 不变，只创建新的 Dispatch 与 Attempt；两者 MUST NOT 互相冒充。

#### Scenario: 修订契约内容

- **WHEN** 需要调整某个 Work Package 的 requirements、design 或验收条件
- **THEN** 系统在原 WorkPackageId 与 worktree 上替换 contract 内容，并在重新 Admission 后从 Specification Planner 起重跑完整角色链

#### Scenario: 基础设施故障后的重试

- **WHEN** 一次 Dispatch 因基础设施原因确定失败，需要重新执行同一工作
- **THEN** 系统创建新的 Dispatch 与 Attempt，WorkerTask、contract 与 revision 保持不变

#### Scenario: 修订请求越界

- **WHEN** 修订请求需要改变依赖或 Scope Envelope
- **THEN** 系统拒绝把它作为 Specification Revision，并要求改为 Graph Revision

### Requirement: revision_pending 只冻结受影响节点与其未接受后代

当修订或退休需求在 Worker Task 已派发时被报告，系统 SHALL 只把受影响 Work Package 及其未接受后代置为 revision pending；无关节点 MUST NOT 被冻结，且并发上限为 1 MUST NOT 被解释为对无关节点的拓扑准入限制。受影响 Work Package 的当前 Worker SHALL 运行至可核验终态，其后 MUST NOT 派发后续角色或依赖工作。旧结果 MUST NOT 越过该持有或已完成集成继续推进。

#### Scenario: 无关节点保持可准入

- **WHEN** 一个 Work Package 进入 revision pending
- **THEN** 与其无拓扑关系的节点仍可按既有准入规则进入 Execution Frontier

#### Scenario: 已派发 Worker 遇到修订

- **WHEN** Implementation Worker 运行期间报告需要修订该 Work Package
- **THEN** Worker 继续运行至可核验终态，其后续角色与未接受后代保持未派发

#### Scenario: 旧结果试图越过持有

- **WHEN** 受持有影响的旧结果试图推进生命周期或集成
- **THEN** 系统阻止该推进，直到持有被解决

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

### Requirement: 修订额度有限且基线落后必须由独立任务补救

每个 Work Package 的 Graph Revision 与 Specification Revision 次数 SHALL 各自受已批准 Execution Authorization Manifest 中的有限上限约束（默认各 2），且重启、恢复、Patch 与重规划 MUST NOT 重置已消耗额度；执行阶段 MUST NOT 新增、推断或放宽这些字段。当 Graph Revision 使某 Work Package 的 worktree base 落后于其修订所需基线时，系统 SHALL 建立一个独立的 Baseline Reconciliation 任务，核验祖先关系、目标 HEAD、dirty paths 与 scope 后再开始修订后的规格工作。

#### Scenario: 达到修订上限

- **WHEN** 某 Work Package 的 Graph Revision 或 Specification Revision 达到默认上限 2
- **THEN** 系统阻塞进一步修订，并要求用户或重规划处理

#### Scenario: 修订后基线落后

- **WHEN** 某个 Work Package 的 worktree base 不再等于其 Graph Revision 所需基线
- **THEN** 系统建立独立 Baseline Reconciliation 任务，核验 ancestry、目标 HEAD、dirty paths 与 scope 后再继续

#### Scenario: 重启后额度不变

- **WHEN** Companion 在一个已消耗修订额度的 Work Package 上重启
- **THEN** 系统从已消耗值继续计数，不恢复额度