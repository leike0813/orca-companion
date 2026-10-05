## ADDED Requirements

### Requirement: Merged-tree validation before serial integration
Work Package SHALL 可乱序完成，canonical 集成 SHALL 串行。canonical 前移后，该包 SHALL 合并已归属的新 HEAD，并由原 Validator Session 在原 Validation Attempt 内处理范围内冲突和复验。接受证据 SHALL 绑定该轮、原结果、目标 HEAD 与已复验树；通过后 Controller SHALL 创建普通 merge commit，并以 expected HEAD 核验推进 canonical。

#### Scenario: Independent package finishes later
- **WHEN** 另一包已推进 canonical，当前包验证完成
- **THEN** 当前包 SHALL 同步并复验合并树后集成，不因分支分叉永久阻塞

#### Scenario: Session or evidence mismatch
- **WHEN** 无法核验原会话、当前树与接受证据不一致，或 canonical 再次前移
- **THEN** SHALL 不集成未经复验的树；再次同步受独立预算限制

#### Scenario: Canonical inputs are distinct from Validator repairs
- **WHEN** canonical 合入其他已授权包的文件，Validator 复验合并树
- **THEN** 验证证据 SHALL 可覆盖这些输入；冲突路径与报告的 filesModified SHALL 单独按本包授权范围核验，越界修复 SHALL 阻塞

### Requirement: Bounded integration reconciliation
每包 SHALL 默认有 2 次可配置集成复验额度，独立于 Validator 修复预算。每轮 SHALL 持久关联原 Validation Attempt 与唯一续接 Task/Dispatch，重启和重放 SHALL 不重复消费或伪造原 Dispatch 的新完成结果。

#### Scenario: Budget exhausted
- **WHEN** 所需同步次数超过批准上限
- **THEN** 当前包 SHALL 阻塞并升级，不重置预算
