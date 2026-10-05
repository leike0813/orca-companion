## MODIFIED Requirements

### Requirement: revision_pending 只冻结受影响节点与其未接受后代

当修订或退休需求在 Worker Task 已派发时被报告，系统 SHALL 只把受影响 Work Package 及其未接受后代置为 revision pending；无关节点 MUST NOT 被冻结，且并行额度 MUST NOT 被解释为对无关节点的拓扑准入限制。受影响 Work Package 的当前 Worker SHALL 运行至可核验终态，其后 MUST NOT 派发后续角色或依赖工作。旧结果 MUST NOT 越过该持有或已完成集成继续推进。

#### Scenario: 无关节点保持可准入

- **WHEN** 一个 Work Package 进入 revision pending
- **THEN** 与其无拓扑关系的节点仍可按既有准入规则进入 Execution Frontier

#### Scenario: 已派发 Worker 遇到修订

- **WHEN** Implementation Worker 运行期间报告需要修订该 Work Package
- **THEN** Worker 继续运行至可核验终态，其后续角色与未接受后代保持未派发

#### Scenario: 旧结果试图越过持有

- **WHEN** 受持有影响的旧结果试图推进生命周期或集成
- **THEN** 系统阻止该推进，直到持有被解决
