## Purpose

定义 Work Package 契约内容的替换、调度持有与修订额度语义，使语义修订与基础设施重试可区分，并明确基线落后时的独立补救。

## ADDED Requirements

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
