## MODIFIED Requirements

### Requirement: Finalizer 门禁与 Delivery Verdict 投影

Finalizer 投影 SHALL 显示原授权的权限模式、工作区、基线/最终版本、修复与集成核验及证据。获准修复引起的工作区变化不构成自动 blocker；只有越界、复验/版本/预算/集成不可证明时才阻塞。仅接受后的独立最终结论可显示 deliverable。

#### Scenario: 只读无法强制时阻塞
- **WHEN** 原 policy 为只读而该能力无法证明
- **THEN** 显示对应 blocker；可写 policy 不受该条件影响

#### Scenario: 工作区在运行期间变化
- **WHEN** 获准 Finalizer 修改代码
- **THEN** 展示实际变化与最终核验，不能仅因变化而阻塞

#### Scenario: 成功完成后显示证据
- **WHEN** 最终代码复验和受控集成均完成
- **THEN** 显示最终版本与证据

#### Scenario: 单包验证通过不等于可交付
- **WHEN** 工作包通过但 Finalizer 未完成
- **THEN** 不显示 deliverable

#### Scenario: blocker 结论明确呈现
- **WHEN** 接受的 Finalizer 结论为 blocked
- **THEN** 展示阻塞项且不显示 deliverable
