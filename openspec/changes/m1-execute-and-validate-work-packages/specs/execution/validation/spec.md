## Purpose

定义独立 Validator 如何验证一个 Worker Task、如何在已授权范围与修复预算内直接修复并复验，以及修复如何使既有证据失效而必须重新取得。

## ADDED Requirements

### Requirement: Validator 以独立角色验证并复用同一真实会话

每个 Worker Task 的验证 SHALL 由一个独立于实现者的 Validator 角色执行，且该 Validator 所接受的结论 SHALL 以结构化 Worker Result 表达。在同一任务的「验证—范围内修复—复验」序列内，Controller SHALL 复用同一真实 harness session，不得切换到替代 session 后继续原 Validation Attempt。

#### Scenario: 独立角色执行验证

- **WHEN** 某实现 Worker Task 报告完成
- **THEN** Controller 派发一个独立角色的 Validator，而不是让实现者自验

#### Scenario: 修复与复验复用同一会话

- **WHEN** Validator 在某任务内完成一次范围内修复并要求复验
- **THEN** 复验必须在同一真实 harness session 内继续

#### Scenario: Validator session 丢失时不伪装恢复

- **WHEN** Validator 在「验证—范围内修复—复验」期间丢失原 harness session
- **THEN** Controller 终止当前 Validation Attempt 的继续推进，并记录 blocker；仅当正常 Retry Attempt 条件成立时，才可用新的 Dispatch 与 Attempt 重开，且不得生成 Capsule、消耗 Recovery Budget 或把新 session 当作原 Attempt 的继续

### Requirement: 修复限定在授权范围与修复预算内，且证据与预算归属不被掩盖

Validator 直接修复的改动 SHALL 限制在该 Worker Task 的已授权 scope、设计、依赖与 authority 之内，并 SHALL 受该任务修复预算的约束。当修复需要越出这些边界时，Controller SHALL 要求以 Worker Escalation 上报，而不得把越界修复记为验证通过。

当修复或后续变更触及某个 Evidence Record 所覆盖的工作区部分时，Controller SHALL 将该记录判定为失效，并要求验证结论包含覆盖该范围的新证据。实现与验证的角色分离 SHALL 保持，Controller SHALL NOT 以验证预算替代或重置实现预算，反之亦然；验证修复预算耗尽时 SHALL 阻塞该 Work Package 并报告预算耗尽。

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
