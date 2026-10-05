## MODIFIED Requirements

### Requirement: 修复限定在授权范围与修复预算内，且证据与预算归属不被掩盖

Validator 直接修复的改动 SHALL 限制在该 Worker Task 的已授权 scope、设计、依赖与 authority 之内，并 SHALL 受该任务修复预算的约束。当修复需要越出这些边界时，Controller SHALL 要求以 Worker Escalation 上报，而不得把越界修复记为验证通过。

当修复或后续变更触及某个 Evidence Record 所覆盖的工作区部分时，Controller SHALL 将该记录判定为失效，并要求验证结论包含覆盖该范围的新证据。实现与验证的角色分离 SHALL 保持，Controller SHALL NOT 以验证预算替代或重置实现预算，反之亦然；验证修复预算耗尽时 SHALL 阻塞该 Work Package 并报告预算耗尽。

Controller SHALL 在许可修复前按稳定步骤身份记录修复准入并消费一次修复预算，重复接收或恢复同一步骤 MUST NOT 重复计费。修复结束后的范围核验 SHALL 覆盖实际已提交、未提交及未跟踪的项目变更，MUST NOT 仅信任 Worker 自报路径。

#### Scenario: 范围内修复后复验通过

- **WHEN** Validator 在授权范围与修复预算内修复缺陷并复验通过
- **THEN** Controller 接受该验证结果，并记录所消耗的修复预算

#### Scenario: 越界修复被拒绝

- **WHEN** 所需修复超出该任务的 scope、设计、依赖、authority 或修复预算
- **THEN** Controller 不接受越界修复作为验证通过，并要求 Worker Escalation

#### Scenario: 修复后旧证据失效

- **WHEN** Validator 的修复触及某条 Evidence Record 所覆盖的代码
- **THEN** Controller 使该记录失效，并要求重新执行覆盖该范围的检查

#### Scenario: 验证预算耗尽后阻塞

- **WHEN** 某 Work Package 的验证修复预算已耗尽且仍存在未解决的缺陷
- **THEN** Controller 阻塞该 Work Package 并报告预算耗尽原因

#### Scenario: 同一修复许可重放
- **WHEN** 修复步骤已经准入，进程中断后再次处理同一许可
- **THEN** 消费值保持一次，后续修复与复验仍属于原 Validation Attempt 和真实 Session

#### Scenario: 修复报告遗漏实际越界变更
- **WHEN** Validator 报告只修改授权路径，但工作区存在实际越界的已提交或未跟踪项目变更
- **THEN** 该验证结果不被接受，Work Package 显示可核验的范围 blocker
